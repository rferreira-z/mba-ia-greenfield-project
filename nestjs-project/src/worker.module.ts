import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { buildTypeOrmOptions } from './database/typeorm-options.factory';
import { UsersModule } from './users/users.module';
import { buildBullOptions } from './video-processing/bull-options.factory';
import { VideoWorkerModule } from './video-worker/video-worker.module';

/**
 * Root module of the video worker process (phase-03-videos/TD-05): no HTTP
 * server, only config, database, storage and the BullMQ consumer.
 * UsersModule is imported for entity metadata — `Video.channel` → `Channel`
 * → `User` must be known to TypeORM's autoLoadEntities.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: buildTypeOrmOptions,
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: buildBullOptions,
    }),
    UsersModule,
    VideoWorkerModule,
  ],
})
export class WorkerModule {}
