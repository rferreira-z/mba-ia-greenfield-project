---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-05T20:25:21-03:00"
  bullmq:
    version: "~6.3.17"
    context7_id: "/taskforcesh/bullmq/v6.3.11"
    fetched_at: "2026-11-05T20:25:21-03:00"
  ioredis:
    version: "~5.11.1"
    context7_id: "/taskforcesh/bullmq/v6.3.11"
    fetched_at: "2026-11-05T20:25:21-03:00"
  "@aws-sdk/client-s3":
    version: "~3.1153.0"
    context7_id: "/websites/aws_amazon_awsjavascriptsdk_v3"
    fetched_at: "2026-11-05T20:25:21-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "~3.1153.0"
    context7_id: "/websites/aws_amazon_sdk-for-javascript_v3_developer-guide"
    fetched_at: "2026-11-05T20:25:21-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T20:25:43-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase, pulled via Context7 and cross-checked against the **published type declarations of the pinned versions** (`npm pack` of `@aws-sdk/client-s3@3.1153.0` and `bullmq@6.3.17`). Re-fetch when the underlying TD changes.

Version pinning rationale: every pinned version was published at least two weeks before 2026-11-05 (`bullmq@6.3.17` 2026-10-18, `@aws-sdk/*@3.1153.0` 2026-10-19, `@nestjs/bullmq@12.0.0` 2026-08-27, `ioredis@5.11.1` 2026-06-04). `ioredis@5.11.1` is the exact version `bullmq@6.3.17` uses in its own `devDependencies`; in BullMQ 6 `ioredis` became an **optional peer dependency**, so it must be installed explicitly.

## @nestjs/bullmq — `phase-03-videos/TD-01`

**Source:** `/nestjs/bull` (Context7, trust 9.7). Peer range verified: `bullmq ^3 || ^4 || ^5 || ^6`, `@nestjs/common|core ^10 || ^11 || ^12`.

### Shared connection (async, from config)

```ts
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort },
    prefix: cfg.prefix,
  }),
});
```

`forRootAsync` returns a **global** dynamic module; feature modules then call `BullModule.registerQueue({ name, defaultJobOptions })`. `RegisterQueueOptions` extends BullMQ `QueueOptions` (minus `connection`): `defaultJobOptions`, `prefix`, `forceDisconnectOnShutdown` (default `false`).

### Producer

```ts
constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}
await this.queue.add(JOB_NAME, payload, { jobId });
```

Tests reach the queue via `moduleRef.get<Queue>(getQueueToken(name))`.

### Consumer

```ts
@Processor('audio', { concurrency: 5 })
export class AudioConsumer extends WorkerHost {
  async process(job: Job<{ file: string }>): Promise<any> { ... }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { ... }
}
```

- The class **must** extend `WorkerHost`; otherwise `InvalidProcessorClassError` is thrown at `onModuleInit`.
- `@OnWorkerEvent` only works inside a `@Processor` class.
- Workers are created only in modules that register a `@Processor` provider — registering a queue in the API (producer only) does **not** start a worker in the API process.
- Shutdown: `BullExplorer.onApplicationShutdown` closes every worker (`worker.close()`); the standalone worker must call `app.enableShutdownHooks()` so SIGTERM reaches it.

## bullmq — `phase-03-videos/TD-01`, `phase-03-videos/TD-10`

**Source:** `/taskforcesh/bullmq/v6.3.11` (Context7, closest indexed version to the pinned `6.3.17`).

### Retries, backoff, unrecoverable errors

```ts
import { UnrecoverableError } from 'bullmq';

await queue.add('test-retry', { foo: 'bar' }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 }, // 1s, 2s, 4s
});

// inside the processor:
throw new UnrecoverableError('Unrecoverable'); // moves job to failed, no retries
```

- Any other thrown error is retried until `attempts` is exhausted.
- `job.attemptsMade` (type declaration in `bullmq@6.3.17/dist/esm/classes/job.d.ts`): *"Number of attempts after the job has failed. @defaultValue 0"*. Inside `process()` during the k-th attempt it equals `k - 1`, so **the current attempt is the final one when `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`**.
- `jobId` deduplicates: adding a job whose id already exists is a no-op returning the existing job.

### Connections

- Workers use blocking commands; with a raw ioredis instance the docs require `new IORedis({ maxRetriesPerRequest: null })`. Passing a plain `{ host, port }` object lets BullMQ create connections with the right options itself (the pattern used with `@nestjs/bullmq` `connection:`).
- Redis must run with `maxmemory-policy noeviction` (BullMQ requirement — evicted keys corrupt queues).

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner — `phase-03-videos/TD-02`, `TD-03`, `TD-08`

**Source:** `/websites/aws_amazon_awsjavascriptsdk_v3` and `/websites/aws_amazon_sdk-for-javascript_v3_developer-guide` (Context7).

### Multipart upload lifecycle

```ts
const { UploadId } = await client.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ContentType }),
);
// presign one part (client PUTs the bytes):
const url = await getSignedUrl(
  publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);
// list what the client uploaded (paginate with PartNumberMarker / IsTruncated):
const { Parts, IsTruncated, NextPartNumberMarker } = await client.send(
  new ListPartsCommand({ Bucket, Key, UploadId }),
);
await client.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: Parts.map(({ ETag, PartNumber }) => ({ ETag, PartNumber })) },
}));
```

S3 limits that shape TD-02: single `PutObject` ≤ 5 GiB; parts 5 MiB–5 GiB (last part may be smaller); ≤ 10,000 parts; SigV4 presigned URL `expiresIn` ≤ 7 days.

### Presigned GET (streaming/download/thumbnail)

```ts
getSignedUrl(publicClient, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: 'attachment; filename="video.mp4"', // download variant only
}), { expiresIn: 3600 });
```

The storage server answers `Range` requests on the presigned URL with `206 Partial Content`.

### Client configuration for S3-compatible servers (verified on the pinned version)

```ts
new S3Client({
  endpoint,                 // http://minio:9000 (internal) or S3_PUBLIC_ENDPOINT (signing)
  region,
  forcePathStyle: true,     // MinIO: http://host/bucket/key instead of bucket.host
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

`requestChecksumCalculation` / `responseChecksumValidation` exist in `@aws-sdk/client-s3@3.1153.0` (`dist-types/runtimeConfig.d.ts`). Recent SDK v3 versions default to computing CRC checksums on every request ("WHEN_SUPPORTED"); for **presigned** `UploadPart` that would require the browser to send a checksum it cannot know in advance, so the clients are pinned to `WHEN_REQUIRED`.

SigV4 signs the `Host` header: a URL signed for `localhost:9000` must be requested with that host. Services therefore keep two clients — internal (`S3_ENDPOINT`) for server-side calls and public (`S3_PUBLIC_ENDPOINT`) used **only** for presigning client-facing URLs (TD-03).

## FFmpeg / ffprobe (system binary) — `phase-03-videos/TD-06`

Not an npm library — installed with `apt install ffmpeg` (Debian package of the `node:25.6.0-slim` base image). Invocations used by the worker:

```sh
ffprobe -v error -print_format json -show_format -show_streams "<presigned-url>"
ffmpeg -v error -ss <seconds> -i "<presigned-url>" -frames:v 1 -vf "scale='min(1280,iw)':-2" -f image2 -c:v mjpeg pipe:1
```

Placing `-ss` **before** `-i` makes FFmpeg seek on the input (range request) instead of decoding from the start.
