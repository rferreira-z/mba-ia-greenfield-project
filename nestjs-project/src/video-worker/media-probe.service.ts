import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { InvalidMediaError, MediaToolError } from './media.errors';
import {
  type FfprobeOutput,
  mapProbeOutput,
  type ProbeResult,
} from './probe-output.mapper';

const PROBE_TIMEOUT_MS = 2 * 60_000;
const THUMBNAIL_TIMEOUT_MS = 5 * 60_000;
const STDERR_TAIL_CHARS = 500;

/** FFmpeg messages meaning "this input is not a decodable video". */
const INVALID_MEDIA_MARKERS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /could not find codec parameters/i,
  /Output file is empty|Output file does not contain any stream/i,
];

interface ToolResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * FFmpeg prefixes errors with the input it was given. For presigned URLs that
 * is a live credential (X-Amz-Signature), so it must never reach logs or
 * `failure_reason` (exposed to the video owner).
 */
function redactInput(text: string, input: string): string {
  return text.split(input).join('<source>');
}

function runTool(
  tool: 'ffprobe' | 'ffmpeg',
  args: string[],
  timeoutMs: number,
  input: string,
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4 * STDERR_TAIL_CHARS);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = redactInput(stderr, input).trim().slice(-STDERR_TAIL_CHARS);
      if (timedOut) {
        reject(
          new MediaToolError(tool, null, `timed out after ${timeoutMs}ms`),
        );
      } else if (code !== 0) {
        reject(
          INVALID_MEDIA_MARKERS.some((re) => re.test(stderr))
            ? new InvalidMediaError(`${tool}: ${tail}`)
            : new MediaToolError(tool, code, tail),
        );
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr: tail });
      }
    });
  });
}

/**
 * Thin wrapper over the FFmpeg CLI (phase-03-videos/TD-06). `input` may be a
 * local path or an HTTP(S) URL — for presigned URLs FFmpeg reads only the
 * container header and the seeked region via range requests.
 */
@Injectable()
export class MediaProbeService {
  async probe(input: string): Promise<ProbeResult> {
    const { stdout } = await runTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      PROBE_TIMEOUT_MS,
      input,
    );

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout.toString()) as FfprobeOutput;
    } catch {
      throw new InvalidMediaError('ffprobe produced unreadable output');
    }
    return mapProbeOutput(output);
  }

  /** One JPEG frame at `atSeconds`, at most 1280px wide. */
  async extractThumbnail(input: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await runTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1280,iw)':-2",
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      THUMBNAIL_TIMEOUT_MS,
      input,
    );
    if (stdout.length === 0) {
      throw new InvalidMediaError('ffmpeg could not extract a video frame');
    }
    return stdout;
  }
}
