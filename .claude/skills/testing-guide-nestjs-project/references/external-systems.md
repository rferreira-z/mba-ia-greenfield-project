> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage via the Compose `minio` service (bucket created by the one-shot `minio-init`). Decided in `phase-03-videos/TD-11` — a filesystem adapter cannot exercise presigned multipart uploads or HTTP range/206 semantics, which are the contracts that matter.

**Wiring:**
- Import `StorageModule` with a global `ConfigModule` loading `storageConfig` (env from `.env`: `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT`, credentials, bucket).
- For services that also need Postgres + Redis, use `createVideoTestingModule([...])` from `src/test/video-test-module.ts`.

**Presigned URLs inside the container:** client-facing URLs are signed for `S3_PUBLIC_ENDPOINT` (e.g. `localhost:9000`), which is not reachable from `nestjs-api`. SigV4 signs the `Host` header, so never rewrite the URL — use `requestPresigned(url, { method, body, headers })` from `src/test/presigned-http.ts`, which connects to `S3_ENDPOINT` while sending the original `Host`.

```typescript
const url = await storage.presignUploadPart(key, uploadId, 1);
const res = await requestPresigned(url, { method: 'PUT', body: chunk });
expect(res.status).toBe(200);

const get = await requestPresigned(await storage.presignGetObject(key), {
  headers: { range: 'bytes=0-99' },
});
expect(get.status).toBe(206);
```

**Test isolation:**
- Use unique keys (`test/<suite>/<uuid>`) and delete them in `afterAll` (internal client via the `S3_INTERNAL_CLIENT` token), or abort multipart uploads left by drafts.
- Real media fixtures are generated at test time with `generateSampleVideo()` (`src/test/video-fixtures.ts`, FFmpeg `lavfi` sources) — never commit binary fixtures.

---

## Message Queue — Real BullMQ/Redis (Docker)

**Strategy:** Real Redis via the Compose `redis` service with BullMQ (`phase-03-videos/TD-01`).

**Producer tests (integration):** register `BullModule.forRoot` with a **random `prefix`** so the running `video-worker` container never consumes the jobs; assert through the queue token and obliterate it afterwards.

```typescript
BullModule.forRoot({
  connection: { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379) },
  prefix: `test-${randomUUID()}`,
}),
// ...
const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
expect((await queue.getJob(videoId))?.data).toEqual({ videoId });
await queue.obliterate({ force: true }); // afterAll
```

**Consumer tests:**
- Unit — call `VideoProcessor.process(job)` directly with a stub job (`attemptsMade`, `opts.attempts`) to cover retry/unrecoverable mapping.
- Integration — test `VideoProcessingService` against Postgres + MinIO + FFmpeg **without** registering the processor (no BullMQ worker inside Jest).
- E2E — `test/video-pipeline.e2e-spec.ts` relies on the Compose `video-worker` container consuming the default-prefix queue; it must be running (`docker compose up -d`).

**Gotcha:** compiling a module that contains a `@Processor` does not start the worker (workers start on `init`), but set an isolated `QUEUE_PREFIX` anyway (see `src/worker.module.spec.ts`).

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
