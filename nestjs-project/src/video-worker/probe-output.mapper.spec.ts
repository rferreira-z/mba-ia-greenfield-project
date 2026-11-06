import { InvalidMediaError } from './media.errors';
import { mapProbeOutput, thumbnailTimestamp } from './probe-output.mapper';

describe('mapProbeOutput', () => {
  const videoStream = {
    codec_type: 'video',
    codec_name: 'h264',
    width: 1920,
    height: 1080,
    avg_frame_rate: '30000/1001',
    duration: '12.000000',
  };

  it('should map duration, dimensions, codecs, format, bit rate and frame rate', () => {
    const result = mapProbeOutput({
      streams: [videoStream, { codec_type: 'audio', codec_name: 'aac' }],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '12.345000',
        bit_rate: '4000000',
      },
    });

    expect(result).toEqual({
      durationSeconds: 12.345,
      metadata: {
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        bit_rate: 4000000,
        frame_rate: 29.97,
      },
    });
  });

  it('should report a missing audio stream as null', () => {
    const result = mapProbeOutput({ streams: [videoStream], format: {} });

    expect(result.metadata.audio_codec).toBeNull();
  });

  it('should fall back to the stream duration when the container has none', () => {
    const result = mapProbeOutput({ streams: [videoStream], format: {} });

    expect(result.durationSeconds).toBe(12);
  });

  it('should return null duration and bit rate when ffprobe reports N/A', () => {
    const result = mapProbeOutput({
      streams: [{ ...videoStream, duration: 'N/A' }],
      format: { duration: 'N/A', bit_rate: 'N/A' },
    });

    expect(result.durationSeconds).toBeNull();
    expect(result.metadata.bit_rate).toBeNull();
  });

  it('should use r_frame_rate when avg_frame_rate is 0/0', () => {
    const result = mapProbeOutput({
      streams: [
        { ...videoStream, avg_frame_rate: '0/0', r_frame_rate: '25/1' },
      ],
    });

    expect(result.metadata.frame_rate).toBe(25);
  });

  it('should reject input without a video stream as invalid media', () => {
    expect(() =>
      mapProbeOutput({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }),
    ).toThrow(InvalidMediaError);
  });
});

describe('thumbnailTimestamp', () => {
  it('should pick 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBe(12);
  });

  it('should fall back to 0 when the duration is unknown or zero', () => {
    expect(thumbnailTimestamp(null)).toBe(0);
    expect(thumbnailTimestamp(0)).toBe(0);
  });
});
