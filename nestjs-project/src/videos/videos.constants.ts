/** 10 GiB, inclusive (phase-03-videos/TD-02 Note — resolves "até 10GB"). */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

/** Containers browsers stream progressively (phase-03-videos/TD-13). */
export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

/** Upper bound of part numbers presigned per request. */
export const MAX_PART_URLS_PER_REQUEST = 100;

/** Attempts to find a free slug before giving up (collisions ~never happen). */
export const MAX_SLUG_ATTEMPTS = 5;

export const VIDEO_SLUG_LENGTH = 11;

/** Storage layout (phase-03-videos/TD-03), keyed by the internal UUID. */
export const videoStorageKeys = {
  source: (videoId: string): string => `videos/${videoId}/source`,
  thumbnail: (videoId: string): string => `videos/${videoId}/thumbnail.jpg`,
} as const;
