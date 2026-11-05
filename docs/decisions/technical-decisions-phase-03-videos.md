---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-05
scope_description: "Backend foundation for video upload and processing: queue technology, direct-to-storage upload of files up to 10GB, object storage layout and local S3 server, worker runtime and FFmpeg-based metadata/thumbnail extraction, unique video URLs, streaming/download delivery and access, video status lifecycle, and the test strategy for the new infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that receives the upload handshake, owns the `videos` table, publishes processing jobs, hosts the video worker (FFmpeg) and exposes streaming/download endpoints; its `compose.yaml` gains object storage, queue broker and worker services.
- `next-frontend/` — Frontend deferred: the video upload/player UI is explicitly out of scope for this phase (challenge statement: "a interface de vídeo não faz parte do escopo desta fase"). Cross-layer TDs below (TD-02, TD-07, TD-08, TD-09) fix the HTTP contract the frontend will consume later; no frontend code is produced here.

_Decisions recorded on 2026-11-05 by the maintainer during `/plan-resolve`; every Recommendation was accepted._

_Stack constraints inherited (not reopened):_ NestJS 11 + TypeORM 0.3 + PostgreSQL 17 (phase 01), `@nestjs/config` + Joi env validation (phase-01/TD-01..04), global JWT guard with `@Public()` opt-out (phase-02-auth/TD-02), domain-exception error envelope `{ statusCode, error, message }` (phase-02-auth/TD-07), class-validator DTOs (phase-02-auth/TD-06). Object storage is **S3-compatible** by project definition (`docs/diagrams/software-arch.mermaid`: "S3 or MinIO") — the *what* is given; only *how* it is used is decided here.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as `TBD`. The API must hand video-processing work to a separate worker without blocking requests, with retries for transient failures (storage hiccups, worker restarts). The choice adds (or not) a new infrastructure service to `compose.yaml` and determines the NestJS integration package. Installed backend: `@nestjs/common@^11`, `typeorm@^0.3.28`, `pg@^8.20`.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue; official NestJS package `@nestjs/bullmq@12` (peer: `bullmq ^3–^6`, Nest `^10–^12`). Producer injects `Queue` via `@InjectQueue`; consumer is a `WorkerHost` class decorated with `@Processor`.
- **Pros:** First-class NestJS recipe (docs.nestjs.com/techniques/queues). Built-in attempts + exponential backoff, `UnrecoverableError`, job ids for deduplication, job state inspection (`getJob`, `getJobs`) usable in tests. One small container (`redis`). Worker can live in a separate process using the same package.
- **Cons:** Adds Redis to the stack (must run with `maxmemory-policy noeviction`). At-least-once delivery — processor must be idempotent.

### Option B: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- AMQP broker with exchanges/queues; retries implemented via dead-letter exchanges + TTL queues.
- **Pros:** Mature broker, rich routing, language-agnostic (a non-Node worker could consume).
- **Cons:** Retry/backoff must be assembled by hand (DLX + delay queues). Heavier container and management surface. No official `@nestjs/*` package for plain queue semantics; the NestJS microservices transport is request/event oriented, not job oriented (no job state to poll).

### Option C: PostgreSQL-backed queue (`pg-boss`, or BullMQ 6's PostgreSQL backend)
- Jobs stored in Postgres tables (`SKIP LOCKED`). `pg-boss@12` is mature; BullMQ 6 added an optional `pg` backend (docs: `guide/postgresql.md`).
- **Pros:** No new infrastructure — reuses the existing `db` service. Transactional enqueue in the same DB transaction as the status change.
- **Cons:** Queue load competes with OLTP traffic on the primary database. BullMQ's Postgres backend is very recent (6.x) and `@nestjs/bullmq` does not document it; `pg-boss` has no official NestJS integration. The phase capability names a *distinct* background-processing service, which a table inside the app DB blurs.

**Recommendation:** **Option A (BullMQ + Redis)** — It is the queue NestJS documents natively, its retry/backoff/unrecoverable-error semantics map 1:1 onto the video status lifecycle (TD-10) without hand-built DLX plumbing, and Redis is a single lightweight container. Postgres-backed queues avoid a service but load the primary DB and (for BullMQ-pg) are too new to bet the phase on.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Libraries:** `@nestjs/bullmq@^12.0.0`, `bullmq@~6.3.17`, `ioredis@~5.11.1`

---

## TD-02: Large File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB body held open by the API ties up an event-loop socket for the whole transfer, competes with every other request for bandwidth/memory and makes the API the throughput bottleneck. S3 limits shape the options: a single `PutObject` is capped at **5 GiB**, so 10GB *requires* S3 multipart upload (parts of 5 MiB–5 GiB, max 10,000 parts). Backend and frontend share the handshake, hence `Cross-layer`.

**Options:**

### Option A: API-proxied streaming upload (`multipart/form-data` → S3)
- Client posts the file to the API; the API streams it (busboy/Multer + `@aws-sdk/lib-storage`) to S3 multipart.
- **Pros:** Single request for the client; API sees every byte (can hash/validate inline).
- **Cons:** Every byte transits the API — exactly the "segurar a API durante o envio" the phase forbids. No resumability: a dropped connection at 9GB restarts from zero. Request timeouts/proxies must allow multi-hour bodies.

### Option B: Direct-to-storage S3 multipart upload with presigned part URLs
- API starts the multipart upload and returns `uploadId`/part size; client asks the API for presigned `UploadPart` URLs (in batches) and `PUT`s each part straight to storage; client calls the API to complete; API finishes the multipart upload and enqueues processing.
- **Pros:** Zero video bytes through the API — it only signs URLs (milliseconds). Parts upload in parallel and individually retryable (resumable at part granularity). Standard S3 API — identical against MinIO locally and AWS S3 in production.
- **Cons:** Multi-step handshake on the client. Storage must be reachable by the client (public endpoint for signing — see TD-03). Size enforcement moves to completion time (sum of uploaded parts vs. declared size).

### Option C: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- Client uses `tus-js-client`; a tus server mounted in the API persists chunks to S3.
- **Pros:** Open resumable-upload protocol with mature clients; resumability built in.
- **Cons:** Bytes still flow through the API process (same bottleneck as A, only chunked). Extra protocol + server dependency; less direct mapping to plain S3 in production.

**Recommendation:** **Option B (presigned S3 multipart, direct to storage)** — It is the only option where the API never carries the 10GB, which is the phase's non-functional requirement, and it stays pure S3 API so MinIO→S3 is a config swap. Proposed parameters (cross-component, to be fixed in the plan): max declared size 10 GiB (10 × 1024³ bytes); server-chosen part size 64 MiB (10 GiB → 160 parts, well under 10,000); presigned part URLs requested in batches of ≤ 100 part numbers; on completion the API reads the uploaded parts with `ListParts` (client does not need to send ETags — avoids CORS `ExposeHeaders` coupling) and rejects completion when parts are missing or total size ≠ declared size.

**Decision:** B (Presigned S3 multipart upload, direct to storage)

**Libraries:** `@aws-sdk/client-s3@~3.1153.0`, `@aws-sdk/s3-request-presigner@~3.1153.0`

**Note:** Resolves validation AMB-2 — the maximum declared size is **10 GiB = 10,737,418,240 bytes** (inclusive), which satisfies "até 10GB" under both the decimal (10 × 10⁹) and binary readings; part size 64 MiB (configurable via TD-12, minimum 5 MiB), ≤ 100 part numbers per presign request, completion validated with `ListParts` (total size must equal the declared size).

---

## TD-03: Object Storage Layout and Access Model

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage technology is given (S3-compatible). Still open: bucket/key organisation and how clients and services reach objects. In Docker, services reach storage by Compose name (`http://minio:9000`), but a presigned URL handed to a browser must carry a host the browser can resolve — and SigV4 signs the `Host` header, so a URL cannot be re-hosted after signing.

**Options:**

### Option A: Single private bucket, per-video key prefix, presigned access only, dual endpoint
- One bucket (`S3_BUCKET`), keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`. No public ACL. Services use `S3_ENDPOINT` (Compose name); client-facing presigned URLs are signed against `S3_PUBLIC_ENDPOINT`.
- **Pros:** All artifacts of a video share a prefix (easy cleanup/listing later). Nothing is world-readable; every access is time-boxed. Works unchanged on AWS (both endpoints collapse to the regional S3 endpoint).
- **Cons:** Two S3 clients (internal/public) to configure. Thumbnails also need a presigned hop.

### Option B: Two buckets (`videos` private, `thumbnails` public-read)
- **Pros:** Thumbnails servable by plain URL / CDN without signing.
- **Cons:** Two buckets to provision and policy to manage; a public-read policy is a production security decision that belongs with visibility rules (Fase 04), not here.

### Option C: Single public-read bucket
- **Pros:** Simplest delivery — direct URLs.
- **Cons:** Any object (including drafts/failed uploads) is readable by anyone who guesses a key; incompatible with future visibility rules.

**Recommendation:** **Option A** — Private-by-default keeps every later access rule (Fase 04 visibility) enforceable in the API, and the dual-endpoint split is the minimal fix for the SigV4 host problem in Docker. Key layout keyed by the internal video UUID (not the public slug) so slug changes never move objects.

**Decision:** A (Single private bucket, per-video key prefix, presigned access, dual endpoint)

**Libraries:** —

---

## TD-04: Local S3-Compatible Server Distribution

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project points to MinIO locally. Verified on 2026-11-05: the `minio/minio` and `minio/mc` repositories no longer exist on Docker Hub ("pull access denied … repository does not exist"), `quay.io/minio/minio` and `bitnami/minio` are also unavailable — MinIO stopped publishing community images. `compose.yaml` needs a pullable, reproducible image that keeps the S3 API (TD-02/TD-03).

**Options:**

### Option A: Chainguard's MinIO build (`cgr.dev/chainguard/minio`), pinned by digest
- Chainguard rebuilds MinIO from upstream source (verified: `RELEASE.2026-10-23T20-06-51Z`, AGPLv3). Image ships `minio`, `mc` and `bash`, enabling an `mc ready` healthcheck and a one-shot bucket-creation service with the same image.
- **Pros:** Still MinIO (the server the project names), same S3 semantics as before. Reputable supplier, signed images. Free tier exposes `:latest`, so pinning by `@sha256` digest gives reproducibility.
- **Cons:** Only `:latest` is public — upgrades mean bumping the digest manually.

### Option B: Community fork image (`pgsty/minio`)
- **Pros:** Drop-in MinIO, versioned tags.
- **Cons:** Single-maintainer community fork; supply-chain trust lower than A.

### Option C: Different S3-compatible server (SeaweedFS, RustFS, Garage)
- **Pros:** Actively published images with version tags.
- **Cons:** Deviates from the documented architecture ("S3 or MinIO"); Garage needs layout bootstrapping; RustFS is young; multipart/presign edge cases differ per implementation.

**Recommendation:** **Option A** — Keeps the architecture's MinIO choice intact with a trustworthy, reproducible image; the digest pin documents exactly what was tested. Production still targets AWS S3 (no code change, only env).

**Decision:** A (`cgr.dev/chainguard/minio`, pinned by digest)

**Libraries:** —

**Note:** Pinned digest (verified 2026-11-05, `minio RELEASE.2026-10-23T20-06-51Z`): `cgr.dev/chainguard/minio@sha256:cee9a8e35885e93f14b3cb32960e5017aff74e2adfb52ba87c65003b0163886b`. The image's bundled `mc` provides the healthcheck (`mc ready`) and the one-shot bucket creation.

---

## TD-05: Video Worker Runtime

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram defines a separate "Video Worker (FFmpeg)" container. FFmpeg work is CPU- and I/O-heavy; running it inside the API process would degrade request latency.

**Options:**

### Option A: Separate container, same NestJS codebase, standalone application context
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); `WorkerModule` imports only config, TypeORM, storage, BullMQ and the processor. Compose runs it as `video-worker` from the same dev image (which installs `ffmpeg`).
- **Pros:** Matches the diagram. Reuses entities, config factories, storage service and job contract types — no duplicated schema. Scales independently (`docker compose up --scale video-worker=N`).
- **Cons:** Worker and API share a repo/build; a separate tsconfig `outDir` is needed so the worker's watch build does not fight the API's `dist/`.

### Option B: Processor inside the API process
- **Pros:** Zero extra container.
- **Cons:** FFmpeg child processes and network reads compete with HTTP handling; contradicts the architecture's separate worker.

### Option C: Separate service/codebase (e.g., Go or Python worker)
- **Pros:** Best-of-breed media tooling; isolated deploy.
- **Cons:** Duplicates the `videos` schema/status contract in another language; BullMQ's Python port lags; new toolchain outside the course stack.

**Recommendation:** **Option A** — Same-codebase standalone context gives the architectural isolation of a separate container without duplicating the data contract.

**Decision:** A (Separate container, same NestJS codebase, standalone application context)

**Libraries:** —

**Note:** Resolves validation DG-1 — FFmpeg (`ffmpeg` + `ffprobe`) is installed in the shared dev image (`nestjs-project/Dockerfile.dev`), used by both `nestjs-api` (tests) and `video-worker`; this infrastructure change is the first step of the plan, ordered before any processing work.

---

## TD-06: Media Metadata and Thumbnail Extraction

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Depends on TD-05. The worker must read a file of up to 10GB that lives in object storage, extract duration/metadata and grab one frame.

**Options:**

### Option A: `ffprobe`/`ffmpeg` CLI via `child_process.spawn`, reading the object over a presigned HTTP URL
- `ffprobe -print_format json -show_format -show_streams <url>`; `ffmpeg -ss <t> -i <url> -frames:v 1 … pipe:1`. FFmpeg's HTTP protocol issues range requests, so only the container header and the seeked region are read.
- **Pros:** No 10GB download, no temp disk. No wrapper dependency — direct CLI with JSON output. Same binary as `apt install ffmpeg`.
- **Cons:** Must parse ffprobe JSON and map exit codes/stderr to errors ourselves. Files whose index sits at the end (non-faststart MP4) cost one extra range read.

### Option B: `fluent-ffmpeg` wrapper
- **Pros:** Fluent API, `ffprobe()` helper.
- **Cons:** Deprecated on npm ("Package no longer supported", last publish 2025-05) — a dead dependency for new code.

### Option C: Download the object to local disk, then run FFmpeg on the file
- **Pros:** Simplest FFmpeg invocation; resilient to network blips mid-probe.
- **Cons:** Up to 10GB of disk and transfer per job for a few KB of metadata; worker needs large ephemeral volumes.

**Recommendation:** **Option A** — Range reads over a presigned URL make probing a 10GB file cost megabytes, and the CLI avoids a deprecated wrapper. Thumbnail policy (cross-component with storage layout): one JPEG frame at 10% of the duration (falls back to 0s for zero/unknown duration), scaled to at most 1280px wide, stored at `videos/{videoId}/thumbnail.jpg`. Persisted metadata: duration (seconds) plus width, height, video/audio codec, container format, bitrate and frame rate.

**Decision:** A (`ffprobe`/`ffmpeg` CLI via `child_process.spawn` over a presigned URL)

**Libraries:** — _(system binary `ffmpeg` from the Debian package in the dev image; no npm wrapper)_

---

## TD-07: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public, shareable identifier used in URLs (`/videos/{id}`); the frontend will build watch links from it. It must never collide and should not leak volume or be guessable.

**Options:**

### Option A: Expose the UUID primary key
- **Pros:** Already unique; zero extra column.
- **Cons:** 36-char URLs; couples public URLs to the internal PK forever.

### Option B: Random 11-character base62 slug (`crypto.randomBytes`), `UNIQUE` column, retry on collision
- ~65 bits of entropy (62¹¹ ≈ 5.2 × 10¹⁹); generated server-side when the draft is created; the unique index is the final arbiter and a collision triggers a regenerate-and-retry under a SAVEPOINT (`.claude/rules/typeorm-queries.md`).
- **Pros:** Short, URL-safe, unguessable, independent of the PK. No dependency (Node `crypto`).
- **Cons:** Extra column + index; retry path is practically never exercised (needs a test seam).

### Option C: Title-derived slug + random suffix
- **Pros:** Human-readable URLs (SEO).
- **Cons:** Titles are editable (Fase 04) → slug churn or stale slugs; leaks the title; still needs a suffix to guarantee uniqueness.

**Recommendation:** **Option B** — Short, unguessable and stable regardless of title edits; the DB unique constraint guarantees "sem conflito" even under concurrency. The slug is the video's public identifier in every `/videos/{slug}` route; the UUID stays internal (FKs, storage keys).

**Decision:** B (Random 11-char base62 slug + `UNIQUE` index, retry on collision)

**Libraries:** —

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file — i.e., HTTP range requests answered with `206 Partial Content` — and users must be able to download the file. Depends on TD-03 (private bucket, presigned access).

**Options:**

### Option A: API endpoint redirects (`302`) to a short-lived presigned GET URL
- `GET /videos/{slug}/stream` → `302 Location: <presigned GET>`; storage answers `Range` with `206`. `GET /videos/{slug}/download` → same, signed with `response-content-disposition=attachment; filename="…"`.
- **Pros:** Bytes flow storage → client (as the diagram's "Frontend → Object Storage: Streams"). Range/206, ETag and caching are implemented by S3/MinIO. Works directly as `<video src>`.
- **Cons:** URL is valid until expiry once handed out (mitigated by short TTL). Requires the public endpoint (TD-03).

### Option B: API proxies the object, translating `Range` → `206`
- **Pros:** Full control per request (auth on every chunk, metrics).
- **Cons:** Every streamed byte transits the API — the same bottleneck TD-02 avoids for uploads. Must re-implement range parsing, `Content-Range`, `416`.

### Option C: Adaptive streaming (HLS/DASH) generated by the worker
- **Pros:** Adaptive bitrate, broad device support.
- **Cons:** Requires transcoding — not a Phase 03 capability (processing here = duration/metadata + thumbnail). Multiplies storage and processing time.

**Recommendation:** **Option A** — Delegates range handling to storage, keeps the API out of the data path and satisfies "sem necessidade de download completo" with standard progressive playback. Presigned GET TTL: 1 hour (same `PRESIGNED_URL_EXPIRES_SECONDS` as upload parts). A `GET /videos/{slug}/thumbnail` redirect follows the same pattern for the generated thumbnail.

**Decision:** A (302 redirect to short-lived presigned GET; storage serves Range/206)

**Libraries:** —

---

## TD-09: Access Policy for Video Consumption Endpoints in Phase 03

**Scope:** Cross-layer

**Capability:** Transversal — covers: URL única por vídeo, sem conflito com outros vídeos; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The global JWT guard protects everything by default (`nestjs-controllers.md`). Visibility (public/unlisted) and draft→publication arrive in Fase 04; anonymous watching is a stated product principle ("Anonymous users can watch freely", root `CLAUDE.md`). Phase 03 must decide who may hit stream/download/thumbnail now.

**Options:**

### Option A: Public (`@Public()`) for `ready` videos — the unguessable slug acts as the capability; owner-only for upload/status management
- **Pros:** The "URL única" is immediately shareable and playable as `<video src>` (no header needed). Matches the anonymous-watching principle. Fase 04 narrows it by visibility without changing the route shape.
- **Cons:** Until Fase 04, any `ready` video is reachable by anyone holding its link (unlisted semantics).

### Option B: Owner-only (JWT + channel ownership) for every video route until Fase 04
- **Pros:** Most restrictive default.
- **Cons:** Browser media elements cannot attach `Authorization` headers — playback would need a BFF hop or a different contract that Fase 04/05 would then break. The unique URL is not shareable.

**Recommendation:** **Option A** — It delivers a usable unique URL and progressive playback now, keeps the contract stable for Fase 05 (anonymous watch page), and leaks nothing guessable (TD-07 entropy). Non-ready videos answer `409 VIDEO_NOT_READY` on consumption routes; owner-only operations (create, part URLs, complete, status read) stay behind the JWT guard with a channel-ownership check.

**Decision:** A (Public for `ready` videos; owner-only management)

**Libraries:** —

---

## TD-10: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Serviço de processamento em segundo plano (filas)

**Context:** Depends on TD-01/TD-02. The row is created as a draft when the upload starts; processing is asynchronous; a failure must be visible in the DB rather than leaving a video stuck.

**Options:**

### Option A: Four states `draft → processing → ready | failed`; BullMQ retries for transient errors, unrecoverable media errors fail fast
- `draft` on upload start; `processing` when the API completes the multipart upload and enqueues (status change + enqueue in one DB transaction; job id = video id for dedup); worker sets `ready` with metadata/thumbnail. Transient errors (storage/network) retry 3× with exponential backoff; invalid media (no video stream, ffprobe rejects the file) throws BullMQ `UnrecoverableError`. On the final failed attempt the worker sets `failed` + `failure_reason`.
- **Pros:** Minimal state machine that matches the phase wording (rascunho → processando → pronto/erro). Retry semantics come from the queue. Worker is idempotent: it only acts on `processing` rows.
- **Cons:** A `draft` whose client vanished stays `draft` (abandoned-upload cleanup is not a Phase 03 capability).

### Option B: Finer states (`uploading`, `uploaded`, `queued`, `processing`, `ready`, `failed`)
- **Pros:** More observable pipeline.
- **Cons:** States without behaviour difference in this phase; more transitions to guard and test.

### Option C: Four states + separate `video_processing_attempts` table
- **Pros:** Full audit trail of every attempt.
- **Cons:** Duplicates what BullMQ already records for job attempts; extra table without a consumer in this phase.

**Recommendation:** **Option A** — Smallest lifecycle that satisfies the capability, reflected in a Postgres enum, with failure reason persisted for the owner. Retries/backoff live in the queue (TD-01) rather than in custom tables.

**Decision:** A (`draft → processing → ready | failed` + queue retries, unrecoverable media errors fail fast)

**Libraries:** —

**Note:** Resolves validation AMB-1 — the `status` column models **only the upload/processing lifecycle** (`draft` = upload started, not yet completed). Publication state (rascunho → publicado, Fase 04) is a separate concern Fase 04 will add as its own column; Phase 03 never reuses `status` for publication.

---

## TD-11: Test Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** `testing-guide-nestjs-project/references/external-systems.md` currently prescribes a **local filesystem adapter** for object storage in tests and leaves the queue as TBD. TD-02/TD-03 rely on S3-specific behaviour (multipart, presigned URLs, range/206) that a filesystem adapter cannot exercise.

**Options:**

### Option A: Real infrastructure from Compose in integration and e2e tests
- Integration tests hit the real MinIO (`minio:9000`), Redis and `ffmpeg` binary installed in the dev image; e2e drives the full flow, with the Compose `video-worker` consuming the job. Fixtures are generated at test time with `ffmpeg -f lavfi` (no binary files in git). Queue-producer integration tests use an isolated BullMQ prefix so the running worker does not consume them.
- **Pros:** Proves the real contracts (SigV4 signing, multipart completion, 206 ranges, FFmpeg parsing). Consistent with the PostgreSQL/Mailpit "real system" strategy already used.
- **Cons:** Tests require the Compose stack (already true for DB/Mailpit); e2e depends on the worker container being up.

### Option B: Filesystem storage adapter + in-memory/mocked queue
- **Pros:** Fewer services needed to run tests.
- **Cons:** Cannot exercise presigned multipart or range semantics; a storage abstraction would exist only for tests; mocks hide configuration bugs (testing guide §1, "mock configured libs" anti-pattern).

**Recommendation:** **Option A** — The phase's risk lives in the S3/queue/FFmpeg contracts; only real services prove them. The testing guide's storage section must be updated accordingly once decided.

**Decision:** A (Real Compose infrastructure in integration and e2e tests)

**Libraries:** —

**Revisions:**
- 2026-11-05 — Reaffirmed after validation ICC-1: this TD supersedes the `testing-guide-nestjs-project` storage strategy ("local filesystem adapter") for this project; the phase plan must update `references/external-systems.md` (object storage → real MinIO; queue → BullMQ/Redis with an isolated prefix for producer tests). Rationale: the guide was written before the storage technology existed and its filesystem adapter cannot exercise presigned multipart or range/206 semantics.

---

## TD-12: Canonical Environment Configuration for Storage, Queue and Upload

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Added after `/plan-validate` MD-1. The new services are wired through `compose.yaml`, validated by the Joi schema (`src/config/env.validation.ts`, phase-01/TD-02), documented in `.env.example` and read by two processes (API and worker). The key set is a cross-component contract; inherited convention: one `registerAs` namespace per domain (phase-01/TD-03).

**Options:**

### Option A: Explicit prefixed keys per concern, Joi-validated with Compose-name defaults
- `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `PRESIGNED_URL_EXPIRES_SECONDS`, `UPLOAD_PART_SIZE_MB` → `storage` namespace; `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX` → `queue` namespace. MinIO's own `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` stay in `compose.yaml` only.
- **Pros:** Mirrors the existing `DB_*`/`MAIL_*` style; each value individually validated and defaulted; defaults use Compose service names (`minio`, `redis`) per the Docker networking rule.
- **Cons:** More keys to document.

### Option B: Connection URLs (`S3_URL=http://key:secret@minio:9000/bucket`, `REDIS_URL=redis://redis:6379`)
- **Pros:** Two variables cover everything.
- **Cons:** Credentials embedded in URLs (escaping, leakage in logs); public endpoint and tuning knobs still need extra keys; diverges from the `DB_*` style.

### Option C: AWS SDK standard variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3`)
- **Pros:** Zero-config on AWS with the default credential chain.
- **Cons:** Implicit — the SDK reads them outside `@nestjs/config`, bypassing Joi validation and typed `ConfigType` injection; no slot for the public signing endpoint.

**Recommendation:** **Option A** — Consistent with the inherited per-domain `registerAs` + Joi convention and keeps every value explicit and validated in both processes.

**Decision:** A (Explicit prefixed keys per concern, Joi-validated)

**Libraries:** —

---

## TD-13: Accepted Upload Media Types

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Added after `/plan-validate` MD-2. The client declares the file's MIME type when starting the upload (TD-02). The declared type is untrusted, but it is also stored as the object's `Content-Type`, which browsers use when playing the progressive stream (TD-08). No transcoding exists in this phase, so what is uploaded is what is streamed.

**Options:**

### Option A: Allowlist at draft creation (`video/mp4`, `video/webm`, `video/quicktime`) + ffprobe as final authority
- DTO rejects other types with 400; the worker still fails the video (`failed`) when ffprobe finds no video stream.
- **Pros:** Fast feedback before 10GB are sent; restricts to containers browsers commonly play progressively (MP4/WebM; MOV from phones); correct `Content-Type` on the stored object.
- **Cons:** Rejects legitimately valid but less common containers (MKV, AVI) until transcoding exists.

### Option B: Any `video/*` declared type + ffprobe as final authority
- **Pros:** Permissive; fewer client rejections.
- **Cons:** Accepts formats the platform cannot stream in browsers (no transcoding) — uploads succeed but playback fails.

### Option C: No API-side check; worker decides
- **Pros:** Simplest API.
- **Cons:** Users learn about an unsupported file only after uploading up to 10GB; object `Content-Type` may be meaningless.

**Recommendation:** **Option A** — With no transcoding in Phase 03, the allowlist keeps uploads aligned with what the streaming capability can actually play, and ffprobe still guards against mislabeled files.

**Decision:** A (Allowlist `video/mp4`, `video/webm`, `video/quicktime` + ffprobe as final authority)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-02 | Cross-layer | Large File Upload Protocol (up to 10GB) | Presigned S3 multipart, direct to storage | B |
| TD-03 | Backend | Object Storage Layout and Access Model | Single private bucket, per-video prefix, dual endpoint | A |
| TD-04 | Repo-wide | Local S3-Compatible Server Distribution | Chainguard MinIO build pinned by digest | A |
| TD-05 | Backend | Video Worker Runtime | Separate container, same codebase, standalone context | A |
| TD-06 | Backend | Media Metadata and Thumbnail Extraction | ffprobe/ffmpeg CLI over presigned URL | A |
| TD-07 | Cross-layer | Unique Video URL Identifier | Random 11-char base62 slug + unique index | B |
| TD-08 | Cross-layer | Streaming and Download Delivery | 302 to presigned GET (storage serves 206) | A |
| TD-09 | Cross-layer | Access Policy for Video Consumption Endpoints | Public for ready videos; owner-only management | A |
| TD-10 | Backend | Video Status Lifecycle and Failure Handling | draft → processing → ready/failed + queue retries | A |
| TD-11 | Backend | Test Strategy for Storage, Queue and Worker | Real Compose infrastructure | A |
| TD-12 | Repo-wide | Canonical Environment Configuration for Storage, Queue and Upload | Explicit prefixed keys, Joi-validated | A |
| TD-13 | Cross-layer | Accepted Upload Media Types | Allowlist mp4/webm/quicktime + ffprobe | A |
