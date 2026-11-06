import type { VideoMetadata } from '../videos/entities/video.entity';
import { InvalidMediaError } from './media.errors';

/** Subset of `ffprobe -print_format json -show_format -show_streams`. */
export interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "30000/1001" → 29.97; "0/0" or missing → null. */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0)
    return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Normalizes ffprobe JSON into the persisted metadata shape
 * (phase-03-videos Data Model → `metadata`). A file without a video stream is
 * not a video and is rejected as invalid media.
 */
export function mapProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new InvalidMediaError('No video stream found in the uploaded file');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds:
      toNumber(output.format?.duration) ?? toNumber(video.duration),
    metadata: {
      width: video.width ?? null,
      height: video.height ?? null,
      video_codec: video.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
      format_name: output.format?.format_name ?? null,
      bit_rate: toNumber(output.format?.bit_rate),
      frame_rate:
        parseFrameRate(video.avg_frame_rate) ??
        parseFrameRate(video.r_frame_rate),
    },
  };
}

/** Thumbnail frame at 10% of the duration; 0s when unknown (TD-06). */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.round(durationSeconds * 0.1 * 1000) / 1000;
}
