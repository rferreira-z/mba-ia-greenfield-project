import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SampleVideoOptions {
  seconds?: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

/**
 * Generates a small H.264/AAC MP4 with FFmpeg's synthetic sources, so tests
 * use real media without committing binary fixtures (phase-03-videos/TD-11).
 */
export async function generateSampleVideo(
  outputPath: string,
  {
    seconds = 2,
    width = 320,
    height = 240,
    withAudio = true,
  }: SampleVideoOptions = {},
): Promise<string> {
  const args = [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${seconds}:size=${width}x${height}:rate=30`,
  ];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push('-movflags', '+faststart', outputPath);

  await execFileAsync('ffmpeg', args);
  return outputPath;
}
