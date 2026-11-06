import { randomBytes } from 'node:crypto';
import { VIDEO_SLUG_LENGTH } from './videos.constants';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Random, URL-safe public identifier (phase-03-videos/TD-07): 11 base62
 * characters (~65 bits). Rejection sampling keeps the distribution uniform —
 * bytes ≥ 248 (= 62 × 4) are discarded instead of biasing `byte % 62`.
 */
export function generateVideoSlug(): string {
  let slug = '';
  while (slug.length < VIDEO_SLUG_LENGTH) {
    for (const byte of randomBytes(VIDEO_SLUG_LENGTH * 2)) {
      if (byte < 248) slug += BASE62[byte % 62];
      if (slug.length === VIDEO_SLUG_LENGTH) break;
    }
  }
  return slug;
}
