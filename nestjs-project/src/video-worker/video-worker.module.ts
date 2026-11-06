import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing/video-processing.constants';
import { Video } from '../videos/entities/video.entity';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
    }),
  ],
  providers: [MediaProbeService, VideoProcessingService, VideoProcessor],
})
export class VideoWorkerModule {}
