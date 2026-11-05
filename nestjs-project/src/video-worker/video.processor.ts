import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../video-processing/video-processing.constants';
import { InvalidMediaError } from './media.errors';
import { VideoProcessingService } from './video-processing.service';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * BullMQ consumer (runs only in the video-worker container). Invalid media
 * fails fast through UnrecoverableError; other errors are retried by BullMQ
 * and mark the video `failed` only on the final attempt (TD-10).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    try {
      const outcome = await this.videoProcessingService.process(videoId);
      this.logger.log(`Video ${videoId} ${outcome}`);
    } catch (err) {
      if (err instanceof InvalidMediaError) {
        this.logger.warn(`Video ${videoId} rejected: ${err.message}`);
        await this.videoProcessingService.markFailed(videoId, err.message);
        throw new UnrecoverableError(err.message);
      }
      // attemptsMade counts previous failed attempts (library-refs.md).
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await this.videoProcessingService.markFailed(
          videoId,
          describeError(err),
        );
      }
      this.logger.warn(
        `Video ${videoId} attempt ${job.attemptsMade + 1} failed: ${describeError(err)}`,
      );
      throw err;
    }
  }
}
