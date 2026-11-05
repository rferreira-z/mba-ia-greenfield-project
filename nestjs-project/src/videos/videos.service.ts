import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { MultipartUploadNotFoundError } from '../storage/storage.errors';
import { StorageService, type UploadedPart } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { UploadPartUrlsResponseDto } from './dto/upload-part-urls-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  MAX_PART_URLS_PER_REQUEST,
  MAX_SLUG_ATTEMPTS,
  videoStorageKeys,
} from './videos.constants';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadIncompleteException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoUploadNotInProgressException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';

function isSlugConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: unknown; detail?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('(slug)')
  );
}

type NewVideo = Omit<
  Video,
  | 'slug'
  | 'status'
  | 'thumbnail_key'
  | 'duration_seconds'
  | 'metadata'
  | 'failure_reason'
  | 'processed_at'
  | 'created_at'
  | 'updated_at'
  | 'channel'
>;

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
    private readonly dataSource: DataSource,
    private readonly videoProcessingProducer: VideoProcessingProducer,
  ) {}

  /**
   * Pre-registers the video as a draft and starts the direct-to-storage
   * multipart upload (phase-03-videos/TD-02). No video bytes reach the API.
   */
  async createUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const sourceKey = videoStorageKeys.source(id);
    const partSize = this.storageCfg.uploadPartSizeBytes;
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.mime_type,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title,
        original_filename: dto.file_name,
        mime_type: dto.mime_type,
        size_bytes: dto.file_size,
        part_size_bytes: partSize,
        source_key: sourceKey,
        upload_id: uploadId,
      });
    } catch (err) {
      await this.abortQuietly(sourceKey, uploadId);
      throw err;
    }

    return {
      video: this.toResponse(video),
      upload: {
        part_size_bytes: partSize,
        part_count: Math.ceil(dto.file_size / partSize),
        max_part_urls_per_request: MAX_PART_URLS_PER_REQUEST,
      },
    };
  }

  /** Owner-only status read (any status). */
  async getOwnedVideo(slug: string, userId: string): Promise<VideoResponseDto> {
    return this.toResponse(await this.findOwnedBySlug(slug, userId));
  }

  /** Presigned PUT URLs for the requested parts of a draft's upload. */
  async presignUploadParts(
    slug: string,
    userId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrlsResponseDto> {
    const video = await this.findOwnedBySlug(slug, userId);
    const uploadId = this.requireDraftUpload(video);
    const partCount = this.partCountOf(video);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidPartNumberException();
    }

    const expiresAt = new Date(
      Date.now() + this.storageService.presignedUrlExpiresSeconds * 1000,
    );
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          uploadId,
          partNumber,
        ),
      })),
    );
    return { parts, expires_at: expiresAt.toISOString() };
  }

  /**
   * Finishes the multipart upload after checking the uploaded parts, then —
   * in one transaction — moves the video to `processing` and enqueues the
   * processing job (phase-03-videos/TD-02, TD-10). If enqueueing fails the
   * status change rolls back; a retry recovers through the stored object.
   */
  async completeUpload(
    slug: string,
    userId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedBySlug(slug, userId);
    const uploadId = this.requireDraftUpload(video);

    await this.finalizeStoredUpload(video, uploadId);

    await this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(Video)
        .set({ status: VideoStatus.PROCESSING, upload_id: null })
        .where('id = :id AND status = :status', {
          id: video.id,
          status: VideoStatus.DRAFT,
        })
        .execute();
      if (result.affected !== 1) {
        throw new VideoUploadNotInProgressException();
      }
      await this.videoProcessingProducer.enqueue(video.id);
    });

    return this.toResponse(
      await this.videoRepository.findOneByOrFail({ id: video.id }),
    );
  }

  private async findOwnedBySlug(slug: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }
    return video;
  }

  private requireDraftUpload(video: Video): string {
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoUploadNotInProgressException();
    }
    return video.upload_id;
  }

  private partCountOf(video: Video): number {
    return Math.ceil(video.size_bytes / video.part_size_bytes);
  }

  private async finalizeStoredUpload(
    video: Video,
    uploadId: string,
  ): Promise<void> {
    let parts: UploadedPart[];
    try {
      parts = await this.storageService.listUploadedParts(
        video.source_key,
        uploadId,
      );
    } catch (err) {
      if (err instanceof MultipartUploadNotFoundError) {
        return this.assertStoredObjectComplete(video);
      }
      throw err;
    }

    if (!this.partsMatchDeclaredFile(video, parts)) {
      throw new UploadIncompleteException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        uploadId,
        parts,
      );
    } catch (err) {
      if (err instanceof MultipartUploadNotFoundError) {
        return this.assertStoredObjectComplete(video);
      }
      throw err;
    }
  }

  /**
   * Recovery: the multipart upload is gone because a previous completion
   * succeeded in storage but its DB step failed. Accept it only when the
   * stored object has exactly the declared size.
   */
  private async assertStoredObjectComplete(video: Video): Promise<void> {
    const size = await this.storageService.headObject(video.source_key);
    if (size !== video.size_bytes) {
      throw new UploadIncompleteException();
    }
  }

  private partsMatchDeclaredFile(video: Video, parts: UploadedPart[]): boolean {
    const partCount = this.partCountOf(video);
    const contiguous =
      parts.length === partCount &&
      parts.every((part, index) => part.partNumber === index + 1);
    const totalSize = parts.reduce((sum, part) => sum + part.size, 0);
    return contiguous && totalSize === video.size_bytes;
  }

  private async insertWithUniqueSlug(data: NewVideo): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            slug: generateVideoSlug(),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (err) {
        if (!isSlugConflict(err) || attempt >= MAX_SLUG_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  /**
   * Compensation for a failed draft insert. The original insert error is what
   * the caller must see, so an abort failure is logged instead of replacing it.
   */
  private async abortQuietly(key: string, uploadId: string): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(key, uploadId);
    } catch (abortErr) {
      this.logger.error(
        `Failed to abort multipart upload for ${key}`,
        abortErr instanceof Error ? abortErr.stack : String(abortErr),
      );
    }
  }

  private toResponse(video: Video): VideoResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      mime_type: video.mime_type,
      size_bytes: video.size_bytes,
      duration_seconds: video.duration_seconds ?? null,
      metadata: video.metadata ?? null,
      failure_reason: video.failure_reason ?? null,
      processed_at: video.processed_at ?? null,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }
}
