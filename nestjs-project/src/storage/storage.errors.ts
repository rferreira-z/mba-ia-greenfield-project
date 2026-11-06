/** The multipart upload id no longer exists (completed, aborted or unknown). */
export class MultipartUploadNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Multipart upload not found for object "${key}"`);
    this.name = 'MultipartUploadNotFoundError';
  }
}
