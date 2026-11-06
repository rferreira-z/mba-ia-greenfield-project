import { randomUUID } from 'node:crypto';
import { BullModule } from '@nestjs/bullmq';
import type { ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { createTestDataSource } from './create-test-data-source';

export const VIDEO_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

/**
 * Real Postgres + MinIO + Redis wiring for video integration tests. The BullMQ
 * prefix is random so jobs enqueued here are never consumed by the Compose
 * video-worker (phase-03-videos/TD-11).
 */
export async function createVideoTestingModule(
  imports: NonNullable<ModuleMetadata['imports']>,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [appConfig, storageConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(VIDEO_TEST_ENTITIES).options),
      BullModule.forRoot({
        connection: {
          host: process.env.REDIS_HOST ?? 'redis',
          port: Number(process.env.REDIS_PORT ?? 6379),
        },
        prefix: `test-${randomUUID()}`,
      }),
      ...imports,
    ],
  }).compile();
}
