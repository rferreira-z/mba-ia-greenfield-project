import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { videoStorageKeys } from '../videos/videos.constants';
import { MediaProbeService } from './media-probe.service';
import { thumbnailTimestamp } from './probe-output.mapper';
import { VideoNotReadyForProcessingError } from './video-processing.errors';

const MAX_FAILURE_REASON_LENGTH = 1000;

export type ProcessingOutcome = 'processed' | 'skipped';

/**
 * Worker-side processing of an uploaded video (phase-03-videos/TD-06, TD-10):
 * probe duration/metadata and store a thumbnail, then mark it `ready`.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
  ) {}

  /**
   * Idempotent (at-least-once delivery): only `processing` rows are worked on;
   * `ready`/`failed`/deleted videos are skipped, `draft` is retried.
   */
  async process(videoId: string): Promise<ProcessingOutcome> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(`Video ${videoId} no longer exists; skipping job`);
      return 'skipped';
    }
    if (video.status === VideoStatus.DRAFT) {
      throw new VideoNotReadyForProcessingError(videoId);
    }
    if (video.status !== VideoStatus.PROCESSING) {
      return 'skipped';
    }

    const sourceUrl = await this.storageService.presignInternalGetObject(
      video.source_key,
    );
    const { durationSeconds, metadata } =
      await this.mediaProbeService.probe(sourceUrl);
    const thumbnail = await this.mediaProbeService.extractThumbnail(
      sourceUrl,
      thumbnailTimestamp(durationSeconds),
    );
    const thumbnailKey = videoStorageKeys.thumbnail(video.id);
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: thumbnailKey,
        processed_at: new Date(),
        failure_reason: null,
      },
    );
    return 'processed';
  }

  /** Records a terminal failure (only from `processing`). */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        failure_reason: reason.slice(0, MAX_FAILURE_REASON_LENGTH),
      },
    );
  }
}
