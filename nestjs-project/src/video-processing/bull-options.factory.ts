import type { QueueOptions } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/** Shared BullMQ connection for the API (producer) and the worker (consumer). */
export function buildBullOptions(
  queue: ConfigType<typeof queueConfig>,
): QueueOptions {
  return {
    connection: { host: queue.redisHost, port: queue.redisPort },
    prefix: queue.prefix,
  };
}
