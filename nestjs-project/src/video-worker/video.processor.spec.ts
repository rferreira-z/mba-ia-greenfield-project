import { Test } from '@nestjs/testing';
import { Job, UnrecoverableError } from 'bullmq';
import type { VideoProcessingJobData } from '../video-processing/video-processing.constants';
import { InvalidMediaError, MediaToolError } from './media.errors';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

function job(attemptsMade: number, attempts = 3): Job<VideoProcessingJobData> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<VideoProcessingJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const service = { process: jest.fn(), markFailed: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: service },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  it('should delegate the job to the processing service', async () => {
    service.process.mockResolvedValue('processed');

    await processor.process(job(0));

    expect(service.process).toHaveBeenCalledWith('video-1');
    expect(service.markFailed).not.toHaveBeenCalled();
  });

  it('should mark invalid media as failed and stop retries with UnrecoverableError', async () => {
    service.process.mockRejectedValue(new InvalidMediaError('no video stream'));

    await expect(processor.process(job(0))).rejects.toThrow(UnrecoverableError);
    expect(service.markFailed).toHaveBeenCalledWith(
      'video-1',
      'no video stream',
    );
  });

  it('should rethrow a transient error without marking failed before the last attempt', async () => {
    const transient = new MediaToolError('ffprobe', 1, 'Connection refused');
    service.process.mockRejectedValue(transient);

    await expect(processor.process(job(0))).rejects.toBe(transient);
    expect(service.markFailed).not.toHaveBeenCalled();
  });

  it('should mark the video failed when the final attempt fails', async () => {
    service.process.mockRejectedValue(new Error('storage unavailable'));

    await expect(processor.process(job(2))).rejects.toThrow(
      'storage unavailable',
    );
    expect(service.markFailed).toHaveBeenCalledWith(
      'video-1',
      'storage unavailable',
    );
  });

  it('should treat a job without retries as its own final attempt', async () => {
    service.process.mockRejectedValue(new Error('boom'));

    await expect(processor.process(job(0, 1))).rejects.toThrow('boom');
    expect(service.markFailed).toHaveBeenCalledTimes(1);
  });
});
