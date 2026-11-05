# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/13 completed

### SI-03.1 — Infrastructure: object storage, queue broker and FFmpeg in the dev image
- **Status:** completed
- **Tests:** no tests (Infra) — existing suite 144/144 unit+integration, 52/52 e2e still passing
- **Observations:**
  - **Infra:** `minio/minio` is no longer pullable from Docker Hub/Quay; used the Chainguard digest from TD-04. Its bundled `mc` serves both the healthcheck (`mc ready local`) and the `minio-init` bucket bootstrap (`MC_CONFIG_DIR=/tmp/.mc` because the image runs as a non-root user).
  - Debian bookworm ships FFmpeg 5.1.9 (`ffprobe`/`ffmpeg` verified inside `nestjs-api`).
  - Host ports for the new services are overridable (`REDIS_HOST_PORT`, `MINIO_API_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`) — this machine maps Redis to 6380 via the git-ignored `.env`.

### SI-03.2 — Dependencies and configuration namespaces (storage, queue)
- **Status:** completed
- **Tests:** 13/13 passing (env.validation.integration-spec.ts, incl. 6 new phase-03 cases)
- **Observations:**
  - `npm install` resolved `bullmq@6.3.19` (inside the pinned `~6.3.17` range; published 2026-10-20, older than the two-week rule) and `ioredis@5.11.1`, deduped with the copies already pulled transitively by `@nestjs-modules/mailer` and `typeorm`.

### SI-03.3 — StorageModule: S3 clients and StorageService
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Video entity and CreateVideos migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Video processing queue: BullMQ connection and job producer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Create video upload (draft pre-registration)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Presigned part URLs, upload completion and status read
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Media probe service (ffprobe/ffmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video processing service and BullMQ processor
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Video worker container
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Streaming, download and thumbnail endpoints
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — End-to-end pipeline: upload → queue → worker → streaming
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — OpenAPI contract and AI documentation
- **Status:** pending
- **Tests:** —
- **Observations:** none
