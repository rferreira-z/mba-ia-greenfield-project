import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM/SIGINT → onApplicationShutdown → BullMQ workers close gracefully.
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker started');
}
void bootstrap();
