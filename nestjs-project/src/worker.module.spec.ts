import { Test } from '@nestjs/testing';
import { VideoProcessingService } from './video-worker/video-processing.service';
import { VideoProcessor } from './video-worker/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;

  beforeAll(() => {
    // Never share the real queue's keys from inside Jest.
    process.env.QUEUE_PREFIX = 'test-worker-module';
  });

  afterAll(() => {
    process.env.QUEUE_PREFIX = originalPrefix;
  });

  it('should compile the worker root module with the processor wired', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await module.close();
  }, 15000);
});
