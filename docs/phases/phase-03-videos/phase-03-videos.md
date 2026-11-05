---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-05T20:41:29-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-05T20:41:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T20:41:29-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver direct-to-storage upload of videos up to 10 GiB (pre-registered as drafts when the upload starts), automatic background processing by a separate FFmpeg worker fed by a BullMQ/Redis queue (duration, metadata and thumbnail), a unique short URL per video, and progressive streaming plus download served straight from S3-compatible object storage (MinIO locally) — with storage, queue and worker running in Docker Compose and exercised by real-infrastructure tests.

_Test specs:_ no SI carries a `**Test Specs:**` field — HTTP behaviour is covered by E2E files listed inline in each SI's Tests table (backend-only phase, no UI wiring); `/plan-test-specs` is skipped for this phase.

---

## Step Implementations

### SI-03.1 — Infrastructure: object storage, queue broker and FFmpeg in the dev image

**Description:** Add the S3-compatible storage (MinIO), its one-shot bucket bootstrap and the Redis broker to `nestjs-project/compose.yaml`, install FFmpeg in the shared dev image, and document the new environment keys. Everything later in the phase depends on these services being reachable by Compose service name.

**Technical actions:**

- Update `nestjs-project/Dockerfile.dev` — add `ffmpeg` to the existing `apt install` line so `ffmpeg`/`ffprobe` exist in every container built from it (per `phase-03-videos/TD-05` Note, resolves DG-1; per `phase-03-videos/TD-06`)
- Add service `redis` to `compose.yaml` — image `redis:8.2.10-alpine`, command `redis-server --appendonly yes --maxmemory-policy noeviction` (BullMQ requirement, see `library-refs.md`), healthcheck `redis-cli ping`, named volume `redis-data`, host port `${REDIS_HOST_PORT:-6379}:6379` (per `phase-03-videos/TD-01`)
- Add service `minio` — image `cgr.dev/chainguard/minio@sha256:cee9a8e35885e93f14b3cb32960e5017aff74e2adfb52ba87c65003b0163886b`, command `server /data --console-address :9001`, `MINIO_ROOT_USER=${S3_ACCESS_KEY_ID:-streamtube}`, `MINIO_ROOT_PASSWORD=${S3_SECRET_ACCESS_KEY:-streamtube-secret}`, healthcheck `mc ready local` (with `MC_HOST_local` pointing at `localhost:9000`), named volume `minio-data`, host ports `${MINIO_API_HOST_PORT:-9000}:9000` and `${MINIO_CONSOLE_HOST_PORT:-9001}:9001` (per `phase-03-videos/TD-04`)
- Add one-shot service `minio-init` — same image, `entrypoint: ["mc"]`, `command: ["mb", "--ignore-existing", "local/${S3_BUCKET:-streamtube-videos}"]`, `depends_on: minio: service_healthy`, `restart: "no"`; make `nestjs-api` depend on `redis` (healthy) and `minio-init` (`service_completed_successfully`) (per `phase-03-videos/TD-03`)
- Append the storage/queue keys of `### Configuration Keys` to `nestjs-project/.env.example` with Compose-name defaults (per `phase-03-videos/TD-12`)

**Tests:** _(empty — Infra)_

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d --build` brings `db`, `mailpit`, `redis`, `minio` to running/healthy and `minio-init` exits with code 0
- `docker compose exec redis redis-cli config get maxmemory-policy` returns `noeviction`
- `docker compose exec minio mc ls local/` (with `MC_HOST_local` set) lists the bucket `streamtube-videos`
- `docker compose exec nestjs-api ffprobe -version` and `ffmpeg -version` exit 0
- The existing suite (`npm test -- --runInBand`, `npm run test:e2e`) still passes

---

### SI-03.2 — Dependencies and configuration namespaces (storage, queue)

**Description:** Install the decided libraries at their pinned versions and expose storage/queue/upload configuration through validated `registerAs` namespaces, following the inherited config conventions (phase-01/TD-01..TD-03).

**Technical actions:**

- Install in `nestjs-project`: `@nestjs/bullmq@~11.0.5`, `bullmq@~6.3.17`, `ioredis@~5.11.1`, `@aws-sdk/client-s3@~3.1153.0`, `@aws-sdk/s3-request-presigner@~3.1153.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`; versions per `library-refs.md`)
- Create `src/config/storage.config.ts` — `registerAs('storage', …)` mapping the `S3_*`, `PRESIGNED_URL_EXPIRES_SECONDS` and `UPLOAD_PART_SIZE_MB` keys of `### Configuration Keys` (part size exposed in bytes) (per `phase-03-videos/TD-12`)
- Create `src/config/queue.config.ts` — `registerAs('queue', …)` mapping `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX` (per `phase-03-videos/TD-12`)
- Extend `src/config/env.validation.ts` with every key of `### Configuration Keys` (types, defaults, `UPLOAD_PART_SIZE_MB` min 5 / max 5120, `PRESIGNED_URL_EXPIRES_SECONDS` 60–604800) and load both namespaces in `AppModule`'s `ConfigModule.forRoot`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Joi schema — new keys, defaults and bounds | Integration | `src/config/env.validation.integration-spec.ts` (extended) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm ls @nestjs/bullmq bullmq ioredis @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` resolves the pinned versions
- With an empty environment the schema yields the documented defaults (e.g., `S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`, `UPLOAD_PART_SIZE_MB=64`)
- `UPLOAD_PART_SIZE_MB=4` or `PRESIGNED_URL_EXPIRES_SECONDS=700000` fails validation
- `npx tsc --noEmit` exits 0

---

### SI-03.3 — StorageModule: S3 clients and StorageService

**Description:** Provide the storage layer used by both the API and the worker: an internal S3 client (Compose endpoint) for server-side calls and a public client used only to presign client-facing URLs, wrapped by a `StorageService` exposing exactly the multipart/presign/object operations the phase needs.

**Technical actions:**

- Create `src/storage/storage.constants.ts` (DI tokens `S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`) and `src/storage/storage.module.ts` — factories building `S3Client` with `endpoint`, `region`, `forcePathStyle`, credentials and `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` from `storageConfig` (per `phase-03-videos/TD-03`; client config per `library-refs.md`); export `StorageService`
- Create `src/storage/storage.service.ts` — multipart operations: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)`, `listUploadedParts(key, uploadId)` (paginated `ListParts`, returns `{ partNumber, etag, size }[]`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`)
- Add object operations to `StorageService`: `headObject(key)` (returns size or `null` when absent), `putObject(key, body, contentType)`, `presignGetObject(key, { attachmentFilename? })` (public client; `ResponseContentDisposition` for downloads), `presignInternalGetObject(key)` (internal client, consumed by the worker) — all presigned URLs use `PRESIGNED_URL_EXPIRES_SECONDS` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)
- Map S3 "upload no longer exists" (`NoSuchUpload`) to a typed `MultipartUploadNotFoundError` so callers can branch without SDK coupling
- Create test helper `src/test/presigned-http.ts` — performs requests to a presigned URL by connecting to the internal endpoint (`S3_ENDPOINT`) while sending the URL's original `Host` header (SigV4 signs `Host`; see `library-refs.md`), supporting `PUT` bodies and `Range` headers (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| StorageService against real MinIO (multipart create → presigned PUT parts → list → complete; abort; head; put; presigned GET with `Range` → 206; attachment disposition) | Integration | `src/storage/storage.service.integration-spec.ts` |
| StorageModule DI wiring | Unit | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- A 2-part upload (5 MiB + remainder) through presigned part URLs completes and `headObject` returns the exact total size
- `listUploadedParts` returns every uploaded part with its size and ETag
- A presigned GET requested with `Range: bytes=0-99` answers `206` with 100 bytes and a `Content-Range` header
- A download URL answers with `Content-Disposition: attachment; filename="…"`
- Presigned client-facing URLs start with `S3_PUBLIC_ENDPOINT`; internal ones with `S3_ENDPOINT`
- `completeMultipartUpload`/`listUploadedParts` on an aborted upload throw `MultipartUploadNotFoundError`

---

### SI-03.4 — Video entity and CreateVideos migration

**Description:** Persist videos as a table owned by a channel, exactly as in `### Data Model`, generated through the TypeORM CLI, and keep the migration and cleanup test helpers in sync.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the fields, enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`), `bigint` transformer to `number` for `size_bytes`, unique `slug`, `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` on `channel_id` (per `### Data Model`; status lifecycle per `phase-03-videos/TD-10`)
- Add the inverse `@OneToMany(() => Video, (video) => video.channel) videos` to `src/channels/entities/channel.entity.ts` (both sides of the relation, per `.claude/rules/nestjs-entities.md`)
- Generate `src/database/migrations/<timestamp>-CreateVideos.ts` with `npm run migration:generate` against a database migrated to the previous head; review the SQL (enum type `videos_status_enum`, unique index on `slug`, index on `channel_id`, FK `ON DELETE CASCADE`)
- Update `src/database/migrations.integration-spec.ts` (third migration, `videos` table, `videos_status_enum` in the managed enum list) and `src/test/create-test-data-source.ts` `cleanAllTables` (delete `videos` before `channels`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Video entity constraints (default `draft`, unique slug, cascade on channel delete, `size_bytes` round-trips as number > 2³¹) | Integration | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration apply/revert including CreateVideos | Integration | `src/database/migrations.integration-spec.ts` (extended) |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `npm run migration:run` creates `videos` and `videos_status_enum`; `npm run migration:revert` drops both
- Inserting two videos with the same slug fails with a unique violation
- Deleting a channel deletes its videos
- A 10 GiB `size_bytes` (10737418240) is read back as the number `10737418240`
- Migration test is re-runnable (passes twice in a row)

---

### SI-03.5 — Video processing queue: BullMQ connection and job producer

**Description:** Connect the API to Redis through `@nestjs/bullmq`, register the `video-processing` queue with the retry policy of `### Events/Messages`, and add the producer that enqueues `process-video` jobs with the video id as job id.

**Technical actions:**

- Register `BullModule.forRootAsync` in `AppModule` (global infrastructure, alongside TypeORM) using `queueConfig` (`connection: { host, port }`, `prefix`) (per `phase-03-videos/TD-01`; API per `library-refs.md`)
- Create `src/video-processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `VideoProcessingJobData` type, default job options (attempts 3, exponential backoff 5000 ms, `removeOnComplete: { count: 1000 }`, `removeOnFail: { count: 5000 }`) (per `### Events/Messages`, `phase-03-videos/TD-10`)
- Create `src/video-processing/video-processing.producer.ts` — `enqueue(videoId)` adding `PROCESS_VIDEO_JOB` with `jobId = videoId`; and `src/video-processing/video-processing-queue.module.ts` registering the queue and exporting the producer

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Producer against real Redis with an isolated prefix (job data, job id, attempts/backoff; second enqueue of the same id is deduplicated) | Integration | `src/video-processing/video-processing.producer.integration-spec.ts` |
| Queue module DI wiring | Unit | `src/video-processing/video-processing-queue.module.spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- After `enqueue(id)`, `queue.getJob(id)` returns a job named `process-video` with data `{ videoId: id }`, `opts.attempts = 3`, exponential backoff 5000 ms
- Enqueuing the same id twice leaves a single job
- Producer tests never reach the Compose `video-worker` (isolated prefix)
- App boots (existing E2E `GET /`) with the BullMQ connection configured

---

### SI-03.6 — Create video upload (draft pre-registration)

**Description:** `POST /videos` pre-registers the video as a `draft` owned by the caller's channel, starts the S3 multipart upload and returns the upload plan (part size/count). The API never receives video bytes.

**Technical actions:**

- Add `findByUserId(userId)` to `ChannelsService` and create `src/videos/videos.exceptions.ts` with the domain exceptions of `### Error Catalog` (extending `DomainException`)
- Create `src/videos/slug.util.ts` — `generateVideoSlug()` returning 11 base62 chars from `crypto.randomBytes` (per `phase-03-videos/TD-07`)
- Create `VideosService.createUpload(userId, dto)` in `src/videos/videos.service.ts` — resolve channel (404 `CHANNEL_NOT_FOUND`), generate `id` (`randomUUID`) and slug, `createMultipartUpload(videos/{id}/source, mime_type)`, insert the `draft` row (retry up to 5 times with a new slug on unique violation of the slug constraint; on any other insert failure abort the multipart upload and rethrow), compute `part_count = ceil(file_size / part_size_bytes)` (per `phase-03-videos/TD-02`, `TD-03`, `TD-07`, `TD-10`)
- Create DTOs `src/videos/dto/create-video.dto.ts` (validation per `### API Contracts` → `POST /videos`; MIME allowlist per `phase-03-videos/TD-13`; max size 10737418240 per `phase-03-videos/TD-02` Note) and response DTOs `video-response.dto.ts`, `create-video-response.dto.ts` with `@ApiProperty` (per `.claude/rules/nestjs-dtos.md`)
- Create `src/videos/videos.controller.ts` (`@ApiTags('videos')`, `@Controller('videos')`, class-level `@SkipThrottle()` per inherited `phase-02-auth/TD-08` auth-only rate limiting) with `POST /videos` (201, `@ApiBearerAuth('access-token')`) and `src/videos/videos.module.ts` (imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `VideoProcessingQueueModule`); register `VideosModule` in `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` (length, alphabet, uniqueness over many draws) | Unit | `src/videos/slug.util.spec.ts` |
| `createUpload` branches (no channel; slug collision retry; non-slug insert failure aborts multipart and rethrows; part count math) | Unit | `src/videos/videos.service.spec.ts` |
| `createUpload` against real DB + MinIO (draft row persisted with keys; multipart upload exists) | Integration | `src/videos/videos.service.integration-spec.ts` |
| VideosModule DI wiring | Unit | `src/videos/videos.module.spec.ts` |
| `POST /videos` (201 shape, 401 without token, 400 validation incl. > 10 GiB and disallowed MIME) | E2E | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` with a valid body returns 201 with `video.status = "draft"`, an 11-char `video.slug`, `upload.part_size_bytes = 67108864` and the computed `upload.part_count`
- A row exists in `videos` with `status = draft`, `source_key = videos/{id}/source` and a non-null `upload_id`
- `file_size = 10737418240` is accepted (`part_count = 160`); `10737418241` returns 400 `VALIDATION_ERROR`
- `mime_type = "video/x-msvideo"` returns 400 `VALIDATION_ERROR`
- Without `Authorization` the endpoint returns 401
- Two consecutive creations return different slugs

---

### SI-03.7 — Presigned part URLs, upload completion and status read

**Description:** Let the owner obtain presigned part URLs, complete the upload (server reads the parts with `ListParts`, validates them, completes the multipart upload and, in one DB transaction, moves the video to `processing` and enqueues the job), and poll the video's status.

**Technical actions:**

- Add `VideosService.findOwnedBySlug(slug, userId)` (404 `VIDEO_NOT_FOUND`, 403 `VIDEO_ACCESS_DENIED`) and `presignUploadParts(slug, userId, partNumbers)` (409 `VIDEO_UPLOAD_NOT_IN_PROGRESS` unless `draft`; 422 `INVALID_PART_NUMBER` outside `1..part_count`) (per `### Authorization Matrix`, `phase-03-videos/TD-02`)
- Add `VideosService.completeUpload(slug, userId)` — require `draft`; `listUploadedParts`; require parts exactly `1..part_count` and total size = `size_bytes` (else 422 `UPLOAD_INCOMPLETE`); `completeMultipartUpload`; recovery: on `MultipartUploadNotFoundError` accept when `headObject(source_key)` equals `size_bytes` (previous completion whose DB step failed), otherwise 422 `UPLOAD_INCOMPLETE` (per `phase-03-videos/TD-02`)
- In `completeUpload`, inside `dataSource.transaction`: conditional update `status = processing, upload_id = NULL WHERE id = :id AND status = 'draft'` (0 rows → 409 `VIDEO_UPLOAD_NOT_IN_PROGRESS`), then `VideoProcessingProducer.enqueue(id)` before commit — enqueue failure rolls the status back (per `### Events/Messages`, `phase-03-videos/TD-10`)
- Create DTO `src/videos/dto/create-upload-part-urls.dto.ts` (`part_numbers`: 1–100 unique integers ≥ 1) and response DTO `upload-part-urls-response.dto.ts`
- Add controller routes `POST /videos/:slug/upload/part-urls` (200), `POST /videos/:slug/upload/complete` (202), `GET /videos/:slug` (200) — all owner-only with `@ApiBearerAuth('access-token')` (per `### API Contracts`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Ownership/status/part-number/completion branches incl. recovery path and transaction rollback when enqueue throws | Unit | `src/videos/videos.service.spec.ts` (extended) |
| Presign → real presigned PUT to MinIO → complete → row `processing` + job present (isolated prefix); size mismatch → 422 and row stays `draft` | Integration | `src/videos/videos.service.integration-spec.ts` (extended) |
| HTTP handshake (part URLs 200, complete 202, status read 200; 403 other user; 404 unknown slug; 409 completing twice; 422 invalid part number; 400 validation) | E2E | `test/videos.e2e-spec.ts` (extended) |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `POST /videos/{slug}/upload/part-urls` returns one URL per requested part, each starting with `S3_PUBLIC_ENDPOINT`, plus `expires_at`
- After PUTting all parts, `POST /videos/{slug}/upload/complete` returns 202 with `status = "processing"`; the row has `upload_id = NULL`
- A `process-video` job with `jobId = video id` exists after completion
- Completing with a missing part or wrong total size returns 422 `UPLOAD_INCOMPLETE` and the video stays `draft`
- A second completion returns 409 `VIDEO_UPLOAD_NOT_IN_PROGRESS`
- Another user's token gets 403 `VIDEO_ACCESS_DENIED`; an unknown slug gets 404 `VIDEO_NOT_FOUND`
- `GET /videos/{slug}` returns the owner's video in any status

---

### SI-03.8 — Media probe service (ffprobe/ffmpeg)

**Description:** Wrap the FFmpeg CLI for the worker: probe a media URL into duration + normalized metadata and grab a JPEG thumbnail frame, translating invalid media into a typed error.

**Technical actions:**

- Create `src/video-worker/media-probe.service.ts` — `probe(input)` spawning `ffprobe -v error -print_format json -show_format -show_streams <input>` and `extractThumbnail(input, atSeconds)` spawning `ffmpeg -v error -ss <t> -i <input> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` (per `phase-03-videos/TD-06`; flags per `library-refs.md`)
- Create `src/video-worker/probe-output.mapper.ts` — pure `mapProbeOutput(json)` → `{ durationSeconds, metadata: { width, height, video_codec, audio_codec, format_name, bit_rate, frame_rate } }`; throws `InvalidMediaError` when there is no video stream (per `### Data Model` → `metadata`)
- Create `src/video-worker/media.errors.ts` (`InvalidMediaError`, `MediaToolError` carrying exit code + stderr tail) and `thumbnailTimestamp(duration)` = 10% of duration, 0 when unknown (per `phase-03-videos/TD-06`)
- Create test helper `src/test/video-fixtures.ts` — `generateSampleVideo(path, { seconds, width, height })` using `ffmpeg -f lavfi` test sources (no binary fixtures in git) (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `mapProbeOutput` / `thumbnailTimestamp` (fractional frame rates, missing audio, missing duration, no video stream) | Unit | `src/video-worker/probe-output.mapper.spec.ts` |
| `MediaProbeService` with the real binaries on generated fixtures (probe values; JPEG thumbnail bytes; invalid file → `InvalidMediaError`) | Integration | `src/video-worker/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Probing a generated 2 s 320×240 H.264/AAC MP4 yields `durationSeconds ≈ 2`, `width 320`, `height 240`, `video_codec "h264"`, `audio_codec "aac"`
- `extractThumbnail` returns a buffer starting with the JPEG SOI marker `FF D8`
- A non-media file causes `InvalidMediaError`
- Frame rate `"30000/1001"` maps to ≈ 29.97

---

### SI-03.9 — Video processing service and BullMQ processor

**Description:** Implement the worker logic: load the video, probe it over an internal presigned URL, store the thumbnail, mark it `ready`; map invalid media to an unrecoverable failure and mark `failed` on the final attempt.

**Technical actions:**

- Create `src/video-worker/video-processing.service.ts` — `process(videoId)`: load video; `ready`/`failed` → return (idempotent); `draft` → throw retriable `VideoNotReadyForProcessingError` (job raced the API commit); else `presignInternalGetObject(source_key)` → `probe` → `extractThumbnail` → `putObject(videos/{id}/thumbnail.jpg, image/jpeg)` → update `status = ready`, `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`, `failure_reason = NULL` (per `phase-03-videos/TD-06`, `TD-10`)
- Add `VideoProcessingService.markFailed(videoId, reason)` — sets `status = failed`, `failure_reason` (truncated to 1000 chars), only from `processing` (per `phase-03-videos/TD-10`)
- Create `src/video-worker/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`; `process(job)` calls the service; on error: `InvalidMediaError` → `markFailed` + throw `UnrecoverableError`; other errors → `markFailed` only when `job.attemptsMade + 1 >= job.opts.attempts`, then rethrow (per `### Events/Messages`; `attemptsMade` semantics per `library-refs.md`)
- Create `src/video-worker/video-worker.module.ts` (TypeORM feature `Video`, `StorageModule`, `BullModule.registerQueue`, processor + services) and root `src/worker.module.ts` (`ConfigModule` with the same namespaces/validation, `TypeOrmModule.forRootAsync`, `BullModule.forRootAsync`, `VideoWorkerModule`) (per `phase-03-videos/TD-05`)
- Create `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (graceful worker close on SIGTERM, per `library-refs.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` error mapping (invalid media → markFailed + UnrecoverableError; transient error on non-final attempt → rethrow without markFailed; final attempt → markFailed) | Unit | `src/video-worker/video.processor.spec.ts` |
| `VideoProcessingService` against real DB + MinIO + FFmpeg (ready path with thumbnail object and metadata; invalid upload → `InvalidMediaError`; `draft` → retriable error; `ready` → no-op) | Integration | `src/video-worker/video-processing.service.integration-spec.ts` |
| Worker root module DI wiring | Unit | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5, SI-03.8

**Acceptance criteria:**

- Processing a `processing` video whose source is a valid MP4 leaves it `ready` with `duration_seconds`, `metadata.width/height`, `thumbnail_key = videos/{id}/thumbnail.jpg`, and the thumbnail object exists in MinIO
- Processing a garbage source raises `InvalidMediaError`; through the processor the video becomes `failed` with a non-empty `failure_reason` and the job is not retried
- A transient error on attempt 1 of 3 does not change the status
- `worker.module` compiles; `src/worker.ts` builds with `nest build`

---

### SI-03.10 — Video worker container

**Description:** Run the worker as its own Compose service from the same image and codebase, with its own watch build output so it never collides with the API's `dist/`.

**Technical actions:**

- Create `nestjs-project/tsconfig.worker.json` — extends `tsconfig.build.json` with `outDir: ./dist-worker`; add `dist-worker` to `nestjs-project/.gitignore` (per `phase-03-videos/TD-05`)
- Add npm scripts `start:worker:dev` (`nest start --watch --entryFile worker --path tsconfig.worker.json`) and `start:worker:prod` (`node dist/worker`)
- Add service `video-worker` to `compose.yaml` — same build as `nestjs-api`, same bind mount, `command: ["npm", "run", "start:worker:dev"]`, `depends_on` `db` (healthy), `redis` (healthy), `minio-init` (completed), `restart: unless-stopped`

**Tests:** _(empty — Infra; worker behaviour is exercised end-to-end in SI-03.12)_

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `docker compose up -d` shows `video-worker` running; its logs show the Nest application context started and no errors
- `docker compose restart video-worker` closes and restarts cleanly (graceful shutdown)
- `npm run build` still produces `dist/main.js` and `dist/worker.js`

---

### SI-03.11 — Streaming, download and thumbnail endpoints

**Description:** Public consumption routes keyed by the unique slug redirect to short-lived presigned GET URLs, so storage serves the bytes (range requests → 206) and the API stays out of the data path.

**Technical actions:**

- Add `VideosService.getStreamUrl(slug)`, `getDownloadUrl(slug)`, `getThumbnailUrl(slug)` — 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_NOT_READY` unless `ready`; presign via public client; download uses `attachment` with an RFC 6266 filename (ASCII fallback + `filename*` UTF-8) built from `original_filename` (per `phase-03-videos/TD-08`, `TD-09`)
- Add controller routes `GET /videos/:slug/stream`, `GET /videos/:slug/download`, `GET /videos/:slug/thumbnail` — `@Public()`, `@Redirect()` with 302 and the presigned URL, OpenAPI `302` + error responses, no `@ApiBearerAuth` (per `### Authorization Matrix`)
- Include `stream_url`, `download_url` (absolute, from `APP_URL`) and `thumbnail_url` (`null` until a thumbnail exists) in `VideoResponseDto` (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| URL branches (not found, not ready, filename encoding) | Unit | `src/videos/videos.service.spec.ts` (extended) |
| `GET stream/download/thumbnail` (anonymous 302 for a ready video; 409 for draft; 404 unknown) | E2E | `test/videos.e2e-spec.ts` (extended) |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- For a `ready` video, anonymous `GET /videos/{slug}/stream` returns 302 with a `Location` under `S3_PUBLIC_ENDPOINT`; requesting it with `Range: bytes=0-1023` returns 206 and 1024 bytes
- `GET /videos/{slug}/download` redirects to a URL whose response carries `Content-Disposition: attachment`
- A `draft` or `processing` video returns 409 `VIDEO_NOT_READY`; an unknown slug 404 `VIDEO_NOT_FOUND`
- Video responses expose `stream_url`/`download_url` built from the slug

---

### SI-03.12 — End-to-end pipeline: upload → queue → worker → streaming

**Description:** Prove the whole phase against the running Compose stack: a real file goes straight to MinIO through presigned parts, the Compose `video-worker` consumes the job, and the API then streams/downloads it.

**Technical actions:**

- Create `test/video-pipeline.e2e-spec.ts` — register/confirm/login a user; generate a 2 s MP4 with `generateSampleVideo`; `POST /videos`; PUT the bytes via `presigned-http`; complete; poll `GET /videos/{slug}` until `ready` (timeout 60 s); assert duration/metadata/thumbnail; stream with `Range` → 206; download → `attachment` (per `phase-03-videos/TD-11`)
- Add the failure scenario — upload random bytes declared as `video/mp4`; after completion poll until `failed` and assert `failure_reason` (per `phase-03-videos/TD-10`)
- Add the 10 GiB contract scenario — `POST /videos` with `file_size = 10737418240` returns `part_count = 160` and part URLs for parts 1 and 160, proving the API accepts the maximum without receiving bytes (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Full pipeline (ready path, failed path, 10 GiB contract) with the Compose worker | E2E | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.10, SI-03.11

**Acceptance criteria:**

- The valid upload reaches `ready` within 60 s with `duration_seconds ≈ 2` and a thumbnail served by `GET /videos/{slug}/thumbnail` as `image/jpeg`
- The garbage upload reaches `failed` with a non-empty `failure_reason`
- Streaming answers 206 to a range request; download carries `Content-Disposition: attachment`
- The 10 GiB declaration yields 160 parts and valid part URLs

---

### SI-03.13 — OpenAPI contract and AI documentation

**Description:** Refresh the exported OpenAPI contract and update the AI foundation docs so they describe the code as it exists after the phase.

**Technical actions:**

- Regenerate `nestjs-project/openapi.json` (`npm run openapi:export`) and add request examples for the video endpoints to `nestjs-project/api.http`
- Update `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — object storage section → real MinIO via presigned HTTP helper; queue section → BullMQ/Redis with isolated prefix for producer tests and the Compose worker for E2E (per `phase-03-videos/TD-11` Revision)
- Update `nestjs-project/CLAUDE.md` — services (`redis`, `minio`, `minio-init`, `video-worker`), readiness probes, worker commands, videos module/endpoints, test prerequisites
- Update root `CLAUDE.md` — architecture (Message Queue = BullMQ + Redis; MinIO image), videos section (flow, status lifecycle, storage layout, endpoints)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| OpenAPI export still valid and now lists the `videos` tag | Integration | `src/openapi-export.integration-spec.ts` (extended) |

**Dependencies:** SI-03.12

**Acceptance criteria:**

- `openapi.json` contains every route of `### API Contracts`
- Every file, command, env key and endpoint cited in the updated `CLAUDE.md` files exists in the repository
- Full Definition of Done passes: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint`

---

## Technical Specifications

### Configuration Keys

Canonical key set (per `phase-03-videos/TD-12`); defaults use Compose service names.

| Key | Type | Default | Consumer |
|-----|------|---------|----------|
| `S3_ENDPOINT` | uri | `http://minio:9000` | internal S3 client (API + worker) |
| `S3_PUBLIC_ENDPOINT` | uri | `http://localhost:9000` | public S3 client — presigns client-facing URLs only |
| `S3_REGION` | string | `us-east-1` | both S3 clients |
| `S3_ACCESS_KEY_ID` | string | `streamtube` | both S3 clients; MinIO root user (Compose) |
| `S3_SECRET_ACCESS_KEY` | string | `streamtube-secret` | both S3 clients; MinIO root password (Compose) |
| `S3_BUCKET` | string | `streamtube-videos` | storage service; `minio-init` |
| `S3_FORCE_PATH_STYLE` | `'true'\|'false'` | `true` | both S3 clients |
| `PRESIGNED_URL_EXPIRES_SECONDS` | number 60–604800 | `3600` | presigned part/GET URLs |
| `UPLOAD_PART_SIZE_MB` | number 5–5120 | `64` | part size returned by `POST /videos` |
| `REDIS_HOST` | string | `redis` | BullMQ connection |
| `REDIS_PORT` | port | `6379` | BullMQ connection |
| `QUEUE_PREFIX` | string | `streamtube` | BullMQ key prefix |

Compose-only host-port overrides (not read by the app): `REDIS_HOST_PORT`, `MINIO_API_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`.

### Data Model

#### Video

Table `videos` (per `phase-03-videos/TD-03`, `TD-07`, `TD-10`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK; generated by the service (`randomUUID`) before the storage key is built |
| slug | varchar(11) | unique, not null — public identifier (`[0-9A-Za-z]{11}`) |
| channel_id | uuid | not null, FK → `channels.id` `ON DELETE CASCADE`, indexed |
| title | varchar(100) | not null |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` |
| original_filename | varchar(255) | not null |
| mime_type | varchar(100) | not null — one of the TD-13 allowlist |
| size_bytes | bigint | not null — declared size, ≤ 10737418240; mapped to `number` |
| part_size_bytes | integer | not null — part size used for this upload |
| source_key | varchar(255) | not null — `videos/{id}/source` |
| upload_id | varchar(1024) | nullable — S3 multipart upload id while `draft`; `NULL` after completion; never exposed by the API |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg` once processed |
| duration_seconds | double precision | nullable |
| metadata | jsonb | nullable — `{ width, height, video_codec, audio_codec, format_name, bit_rate, frame_rate }` |
| failure_reason | text | nullable — set when `failed` |
| processed_at | timestamp | nullable — set when `ready` |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), auto-updated |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel` many-to-one).
**Indexes:** unique on `slug`; index on `channel_id`.

**Status lifecycle** (per `phase-03-videos/TD-10`; `status` models only upload/processing — publication is a Fase 04 concern):

```
draft ──(POST …/upload/complete)──▶ processing ──(worker ok)──▶ ready
                                         └──(invalid media | final attempt)──▶ failed
```

**Storage layout** (per `phase-03-videos/TD-03`): single private bucket `S3_BUCKET`; `videos/{id}/source` (Content-Type = declared `mime_type`), `videos/{id}/thumbnail.jpg` (`image/jpeg`).

### API Contracts

All bodies are JSON; field names are snake_case (inherited style, e.g. `access_token`). `Video` below denotes this shape:

```
Video {
  id: string (uuid)
  slug: string (11 chars)
  title: string
  status: "draft" | "processing" | "ready" | "failed"
  original_filename: string
  mime_type: string
  size_bytes: number
  duration_seconds: number | null
  metadata: { width, height, video_codec, audio_codec, format_name, bit_rate, frame_rate } | null
  failure_reason: string | null
  stream_url: string        — `${APP_URL}/videos/{slug}/stream`
  download_url: string      — `${APP_URL}/videos/{slug}/download`
  thumbnail_url: string | null — `${APP_URL}/videos/{slug}/thumbnail` when a thumbnail exists
  processed_at: string (ISO) | null
  created_at: string (ISO)
  updated_at: string (ISO)
}
```

#### POST /videos (SI-03.6)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- title: string, required — trimmed, 1–100 characters
- file_name: string, required — 1–255 characters (stored as `original_filename`)
- file_size: integer, required — 1 … 10737418240 (10 GiB)
- mime_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`

**Response 201:**
- video: Video (`status = "draft"`)
- upload: { part_size_bytes: number, part_count: number, max_part_urls_per_request: 100 }

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (incl. size above 10 GiB, MIME not allowed)
- 401: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel

---

#### POST /videos/:slug/upload/part-urls (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:**
- part_numbers: integer[], required — 1–100 unique integers ≥ 1

**Response 200:**
- parts: { part_number: number, url: string }[] — presigned `PUT` URLs (public endpoint)
- expires_at: string (ISO)

**Error responses:**
- 400 VALIDATION_ERROR
- 401
- 403 VIDEO_ACCESS_DENIED: caller does not own the video
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: video is not `draft`
- 422 INVALID_PART_NUMBER: a part number exceeds `part_count`

---

#### POST /videos/:slug/upload/complete (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:** none

**Response 202:** Video (`status = "processing"`)

**Error responses:**
- 401
- 403 VIDEO_ACCESS_DENIED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: video is not `draft` (e.g., already completed)
- 422 UPLOAD_INCOMPLETE: uploaded parts are not exactly `1..part_count` or their total size ≠ `size_bytes`

---

#### GET /videos/:slug (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** Video (any status)

**Error responses:**
- 401
- 403 VIDEO_ACCESS_DENIED
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:slug/stream (SI-03.11)

Public (no token).

**Response 302:** `Location` = presigned GET URL (public endpoint, `PRESIGNED_URL_EXPIRES_SECONDS`); storage honours `Range` → `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: status ≠ `ready`

---

#### GET /videos/:slug/download (SI-03.11)

Public (no token).

**Response 302:** `Location` = presigned GET URL signed with `response-content-disposition=attachment; filename="<ascii>"; filename*=UTF-8''<encoded original_filename>`.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### GET /videos/:slug/thumbnail (SI-03.11)

Public (no token).

**Response 302:** `Location` = presigned GET URL of `videos/{id}/thumbnail.jpg`.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Direct-to-storage requests (client → MinIO/S3, not API routes)

- `PUT {presigned part url}` with the raw part bytes → `200` + `ETag` (parts of `part_size_bytes`, last part may be smaller). The client never sends ETags back — the API reads them with `ListParts` (per `phase-03-videos/TD-02`).
- `GET {presigned get url}` with optional `Range: bytes=a-b` → `200`/`206`.

### Authorization Matrix

Global JWT guard with `@Public()` opt-out (inherited `phase-02-auth/TD-02`); access policy per `phase-03-videos/TD-09`. "Owner" = authenticated user whose channel owns the video.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates in own channel) | ✓ |
| POST /videos/:slug/upload/part-urls | ✗ (401) | ✗ (403) | ✓ |
| POST /videos/:slug/upload/complete | ✗ (401) | ✗ (403) | ✓ |
| GET /videos/:slug | ✗ (401) | ✗ (403) | ✓ |
| GET /videos/:slug/stream | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |
| GET /videos/:slug/download | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |
| GET /videos/:slug/thumbnail | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |

Rate limiting: `VideosController` is annotated `@SkipThrottle()` — rate limiting stays scoped to auth endpoints as decided in inherited `phase-02-auth/TD-08`.

### Error Catalog

Error envelope inherited from `phase-02-auth/TD-07`: `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | `POST /videos` by a user without a channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:slug…` route with an unknown slug |
| VIDEO_ACCESS_DENIED | 403 | You do not own this video | Owner-only route called by another user |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | Video upload is not in progress | Part URLs / completion when status ≠ `draft` |
| INVALID_PART_NUMBER | 422 | Part number is outside the upload's part range | `part_numbers` contains a value > `part_count` |
| UPLOAD_INCOMPLETE | 422 | Uploaded parts do not match the declared file | Completion with missing/extra parts or total size ≠ `size_bytes` |
| VIDEO_NOT_READY | 409 | Video is not ready yet | Stream/download/thumbnail when status ≠ `ready` |

Worker-side errors (never HTTP; persisted in `failure_reason`): `InvalidMediaError` (no video stream / ffprobe rejects input — unrecoverable), `MediaToolError` (non-zero FFmpeg exit — retried), `VideoNotReadyForProcessingError` (job observed a `draft` row — retried).

### Events/Messages

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (deduplication), `attempts: 3`, `backoff: { type: "exponential", delay: 5000 }` (5 s, 10 s), `removeOnComplete: { count: 1000 }`, `removeOnFail: { count: 5000 }`; key prefix `QUEUE_PREFIX`.
**Producer:** `VideoProcessingProducer` called by `VideosService.completeUpload` inside the DB transaction that moves the video `draft → processing` (per `phase-03-videos/TD-01`, `TD-10`)
**Consumer:** `VideoProcessor` (`WorkerHost`) in the `video-worker` container → `VideoProcessingService` (per `phase-03-videos/TD-05`, `TD-06`)
**Trigger:** successful `POST /videos/:slug/upload/complete`
**Outcome:** `ready` (duration, metadata, thumbnail) or `failed` (`failure_reason`) — invalid media fails immediately via `UnrecoverableError`; other errors mark `failed` only on the final attempt
**Delivery semantics:** at-least-once; the consumer is idempotent (acts only on `processing` rows; `ready`/`failed` → no-op; `draft` → retry) (per `phase-03-videos/TD-10`)

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   ├── SI-03.3
│   ├── SI-03.4
│   └── SI-03.5
└── SI-03.8

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6
    └── SI-03.7
        └── SI-03.11

SI-03.3 + SI-03.4 + SI-03.5 + SI-03.8
└── SI-03.9
    └── SI-03.10

SI-03.10 + SI-03.11
└── SI-03.12
    └── SI-03.13
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13

## Deliverables

- [ ] Redis, MinIO (+ bucket bootstrap) and the video worker running in `nestjs-project/compose.yaml`; FFmpeg in the dev image
- [ ] Storage/queue configuration validated by Joi and documented in `.env.example`
- [ ] `videos` table (migration `CreateVideos`) linked to `channels`, with status enum `draft | processing | ready | failed`
- [ ] Upload up to 10 GiB direct to storage (presigned multipart) — the API never receives video bytes
- [ ] Video pre-registered as `draft` when the upload starts
- [ ] Automatic processing after completion through the BullMQ queue: duration + metadata via ffprobe
- [ ] Automatic thumbnail from a frame at 10% of the duration
- [ ] Unique 11-character slug per video (DB-enforced)
- [ ] Streaming via presigned URL with HTTP range support (206) and download with `Content-Disposition: attachment`
- [ ] Failure path recorded in the database (`failed` + `failure_reason`)
- [ ] `openapi.json`, testing guide and both `CLAUDE.md` files updated to the delivered code
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds (`docker compose exec nestjs-api npm run build`)
