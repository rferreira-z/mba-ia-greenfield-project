import type { DefaultJobOptions } from 'bullmq';

/** Queue consumed by the video worker (phase-03-videos, Events/Messages). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Job name for "process an uploaded video" — payload `VideoProcessingJobData`. */
export const PROCESS_VIDEO_JOB = 'process-video';

export interface VideoProcessingJobData {
  videoId: string;
}

/**
 * Retry policy (phase-03-videos/TD-10): 3 attempts with exponential backoff
 * (5s, 10s). Invalid media short-circuits retries via UnrecoverableError.
 */
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const satisfies DefaultJobOptions;
