# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec minio mc ready local` — expect the cluster to be reported ready; `minio-init` must show `Exited (0)` in `docker compose ps -a` (bucket created)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`

The `video-worker` service is part of the infrastructure (it consumes the processing queue), so it starts with `docker compose up -d`. It is **not** the NestJS API server.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (container idles; the server only runs when started explicitly)
- `video-worker` — BullMQ consumer running `npm run start:worker:dev` (FFmpeg processing; watch build in `dist-worker/`)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 8.2 for the BullMQ queue (`maxmemory-policy noeviction`), port `6379`
- `minio` — S3-compatible object storage (Chainguard MinIO build pinned by digest), API port `9000`, console `9001`
- `minio-init` — one-shot job that creates the `S3_BUCKET` bucket, then exits
- `mailpit` — SMTP capture, ports `1025` (SMTP) / `8025` (UI)

Host ports are overridable through `.env` (`API_HOST_PORT`, `DB_HOST_PORT`, `REDIS_HOST_PORT`, `MINIO_API_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`, `MAILPIT_SMTP_HOST_PORT`, `MAILPIT_UI_HOST_PORT`) when the defaults are taken on the host. Inside the network services always use the Compose names and container ports. If `MINIO_API_HOST_PORT` changes, set `S3_PUBLIC_ENDPOINT` to match.

The dev image (`Dockerfile.dev`) installs `ffmpeg`/`ffprobe`; both `nestjs-api` (tests) and `video-worker` rely on them.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/ (dist/main.js + dist/worker.js)
npm run start:prod                       # Run compiled build
npm run start:worker:prod                # Run the compiled video worker (dist/worker.js)
npm run migration:run                    # Apply pending migrations
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose restart video-worker      # pick up config changes; code changes hot-reload
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

`start:worker:dev` runs inside the `video-worker` service (its Compose `command`); do not start it in `nestjs-api` — two consumers would compete for jobs.

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Video tests need the whole stack: `redis`, `minio` (+ `minio-init`) and, for `test/video-pipeline.e2e-spec.ts`, a running `video-worker` — that suite uploads a real file and waits for the Compose worker to process it. Producer/integration tests use a random BullMQ prefix so the worker never consumes their jobs. Strategies and helpers (`src/test/presigned-http.ts`, `src/test/video-fixtures.ts`, `src/test/video-test-module.ts`, `test/utils/e2e-app.ts`) are described in the `testing-guide-nestjs-project` skill (`references/external-systems.md`).

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entry points share the codebase: `src/main.ts` (HTTP API, `AppModule`) and `src/worker.ts` (video worker, `WorkerModule` — application context without HTTP). Both build their TypeORM/BullMQ roots from `src/database/typeorm-options.factory.ts` and `src/video-processing/bull-options.factory.ts`.
- `tsconfig.worker.json` builds the worker to `dist-worker/` in dev so its watch build never clobbers the API's `dist/`.

## Videos (Phase 03)

Plan and decisions: `docs/phases/phase-03-videos/phase-03-videos.md`, `docs/decisions/technical-decisions-phase-03-videos.md`.

**Modules**

- `src/storage/` — `StorageModule`/`StorageService`: two `S3Client`s — internal (`S3_ENDPOINT`, server-side calls) and public (`S3_PUBLIC_ENDPOINT`, used **only** to presign client-facing URLs, because SigV4 signs the `Host`). Checksums are `WHEN_REQUIRED` so presigned part PUTs work.
- `src/video-processing/` — queue name/job contract (`video-processing.constants.ts`), `VideoProcessingQueueModule` + `VideoProcessingProducer` (job id = video id).
- `src/videos/` — `VideosModule`: `Video` entity (`videos` table, migration `1793921822792-CreateVideos.ts`), `VideosService`, `VideosController`, DTOs, domain exceptions (`videos.exceptions.ts`), slug generator.
- `src/video-worker/` — `VideoWorkerModule` (worker only): `VideoProcessor` (BullMQ `WorkerHost`), `VideoProcessingService`, `MediaProbeService` (ffprobe/ffmpeg CLI).

**Upload flow (no video bytes pass through the API):**

1. `POST /videos` → creates the row as `draft` (status `draft`), starts an S3 multipart upload at `videos/{id}/source`, returns `part_size_bytes`/`part_count`. Max size 10 GiB (`MAX_VIDEO_SIZE_BYTES`); MIME allowlist `video/mp4`, `video/webm`, `video/quicktime`.
2. `POST /videos/:slug/upload/part-urls` → presigned PUT URLs (≤ 100 per call); the client PUTs parts straight to MinIO/S3.
3. `POST /videos/:slug/upload/complete` → API reads the parts with `ListParts` (must be `1..part_count`, total = declared size), completes the upload, then in one DB transaction sets `processing` and enqueues `process-video` (rollback if enqueue fails; a retry recovers via `HeadObject`).
4. `video-worker` probes the source over an internal presigned URL, stores `videos/{id}/thumbnail.jpg` (frame at 10% of duration), sets `ready` with `duration_seconds`/`metadata`. Invalid media → `UnrecoverableError` → `failed` + `failure_reason`; other errors retry (3 attempts, exponential 5 s) and mark `failed` on the last attempt. FFmpeg errors are redacted (`<source>`) — never let a presigned URL reach logs or `failure_reason`.

**Status lifecycle:** `draft → processing → ready | failed` (`VideoStatus`). It models upload/processing only; publication is a Fase 04 concern.

**Endpoints** (`@SkipThrottle()` — rate limiting stays on auth):

| Method | Path | Access |
|--------|------|--------|
| POST | `/videos` | authenticated (own channel) |
| POST | `/videos/:slug/upload/part-urls` | owner |
| POST | `/videos/:slug/upload/complete` | owner |
| GET | `/videos/:slug` | owner (any status) |
| GET | `/videos/:slug/stream` | public, `ready` only — 302 to presigned GET (storage answers Range with 206) |
| GET | `/videos/:slug/download` | public, `ready` only — 302 to presigned GET with `Content-Disposition: attachment` |
| GET | `/videos/:slug/thumbnail` | public, `ready` only — 302 to presigned thumbnail |

The `slug` (11 random base62 chars, unique index) is the public identifier; the UUID stays internal (FKs, storage keys).

**Configuration** (`src/config/storage.config.ts`, `src/config/queue.config.ts`, validated in `env.validation.ts`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `PRESIGNED_URL_EXPIRES_SECONDS`, `UPLOAD_PART_SIZE_MB`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`. Compose passes `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` to MinIO as its root credentials.

**Library pins:** `@nestjs/bullmq` must stay on `~11.x` — `12.x` is an ES-module build for Nest 12 that Jest's CommonJS runtime cannot load (see `docs/phases/phase-03-videos/library-refs.md`).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
