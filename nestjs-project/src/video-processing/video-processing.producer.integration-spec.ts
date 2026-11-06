import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration — Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<VideoProcessingJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          // Isolated prefix: the Compose video-worker never sees these jobs.
          prefix: `test-producer-${randomUUID()}`,
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should enqueue a process-video job keyed by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    const job = await queue.getJob(videoId);

    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
  });

  it('should apply the retry policy (3 attempts, exponential 5s backoff)', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    const job = await queue.getJob(videoId);

    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should deduplicate a second enqueue for the same video', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);

    expect(jobs.filter((j) => j.data.videoId === videoId)).toHaveLength(1);
  });
});
