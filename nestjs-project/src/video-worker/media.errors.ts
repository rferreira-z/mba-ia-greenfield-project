/** The input is not a usable video (no video stream / unreadable container). */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

/** FFmpeg/ffprobe failed for a reason that may be transient (network, I/O). */
export class MediaToolError extends Error {
  constructor(
    public readonly tool: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(
      `${tool} failed (exit ${exitCode ?? 'signal'}): ${stderrTail || 'no output'}`,
    );
    this.name = 'MediaToolError';
  }
}
