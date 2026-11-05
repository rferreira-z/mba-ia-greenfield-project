import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  MAX_PART_URLS_PER_REQUEST,
  MAX_SLUG_ATTEMPTS,
  videoStorageKeys,
} from './videos.constants';
import { ChannelNotFoundException } from './videos.exceptions';

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
