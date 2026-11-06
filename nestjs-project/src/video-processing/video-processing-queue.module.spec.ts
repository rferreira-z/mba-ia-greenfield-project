import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingQueueModule', () => {
  it('should compile and expose the producer and the queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: 'test-module-compile',
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeInstanceOf(
      Queue,
    );
    await module.close();
  });
});
