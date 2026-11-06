/**
 * The job reached the worker before the API committed `draft → processing`
 * (enqueue happens inside that transaction). Retried by BullMQ.
 */
export class VideoNotReadyForProcessingError extends Error {
  constructor(public readonly videoId: string) {
    super(`Video ${videoId} is still a draft; processing will be retried`);
    this.name = 'VideoNotReadyForProcessingError';
  }
}
