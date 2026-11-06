import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJobData>,
  ) {}

  /**
   * Enqueues processing for a video. The job id is the video id, so a repeated
   * enqueue for the same video is deduplicated by BullMQ.
   */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });
  }
}
