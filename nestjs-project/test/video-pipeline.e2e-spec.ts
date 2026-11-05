import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresigned } from '../src/test/presigned-http';
import { generateSampleVideo } from '../src/test/video-fixtures';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  clearThrottler,
  createE2eApp,
  registerConfirmAndLogin,
} from './utils/e2e-app';

const PROCESSING_TIMEOUT_MS = 60_000;
const TEN_GIB = 10 * 1024 ** 3;

/**
 * Full Phase 03 pipeline against the running Compose stack: the bytes go
 * straight to MinIO through presigned part URLs, the job travels through
 * Redis/BullMQ and is processed by the `video-worker` container (FFmpeg),
 * and the API then streams/downloads the result. Requires
 * `docker compose up -d` (video-worker included).
 */
describe('Video pipeline: upload → queue → worker → streaming (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let token: string;
  let workDir: string;
  let sampleVideo: Buffer;
  let userCounter = 0;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    workDir = mkdtempSync(join(tmpdir(), 'pipeline-'));
    sampleVideo = readFileSync(
      await generateSampleVideo(join(workDir, 'sample.mp4'), {
        seconds: 2,
        width: 320,
        height: 240,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await abortPendingUploads();
    rmSync(workDir, { recursive: true, force: true });
    await app.close();
  });

  beforeEach(async () => {
    await abortPendingUploads();
    await cleanAllTables(dataSource);
    clearThrottler(app);
    token = await registerConfirmAndLogin(
      app,
      `pipeline_${++userCounter}@example.com`,
    );
  });

  async function abortPendingUploads(): Promise<void> {
    const drafts = await dataSource
      .getRepository(Video)
      .findBy({ status: VideoStatus.DRAFT });
    for (const draft of drafts) {
      if (draft.upload_id) {
        await storage
          .abortMultipartUpload(draft.source_key, draft.upload_id)
          .catch(() => undefined);
      }
    }
  }

  const api = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  /** Uploads `file` exactly like a browser would and completes the upload. */
  async function uploadVideo(file: Buffer, fileName: string): Promise<string> {
    const created = await auth(api().post('/videos'))
      .send({
        title: 'Pipeline video',
        file_name: fileName,
        file_size: file.length,
        mime_type: 'video/mp4',
      })
      .expect(201);
    const { slug } = created.body.video as { slug: string };
    const { part_size_bytes: partSize, part_count: partCount } = created.body
      .upload as { part_size_bytes: number; part_count: number };

    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const urls = await auth(api().post(`/videos/${slug}/upload/part-urls`))
      .send({ part_numbers: partNumbers })
      .expect(200);
    for (const { part_number, url } of urls.body.parts as {
      part_number: number;
      url: string;
    }[]) {
      const chunk = file.subarray(
        (part_number - 1) * partSize,
        part_number * partSize,
      );
      const put = await requestPresigned(url, { method: 'PUT', body: chunk });
      expect(put.status).toBe(200);
    }

    await auth(api().post(`/videos/${slug}/upload/complete`)).expect(202);
    return slug;
  }

  /** Polls the owner status endpoint until the worker settles the video. */
  async function waitForTerminalStatus(slug: string) {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    for (;;) {
      const res = await auth(api().get(`/videos/${slug}`)).expect(200);
      if (res.body.status === 'ready' || res.body.status === 'failed') {
        return res.body as {
          status: string;
          duration_seconds: number | null;
          metadata: Record<string, unknown> | null;
          failure_reason: string | null;
          thumbnail_url: string | null;
        };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Video ${slug} still "${res.body.status}" after ${PROCESSING_TIMEOUT_MS}ms — is the video-worker container running?`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  it(
    'should process an uploaded video and serve it by streaming and download',
    async () => {
      const slug = await uploadVideo(sampleVideo, 'sample.mp4');

      const video = await waitForTerminalStatus(slug);

      expect(video.status).toBe('ready');
      expect(video.duration_seconds).toBeCloseTo(2, 0);
      expect(video.metadata).toMatchObject({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      });
      expect(video.thumbnail_url).toMatch(
        new RegExp(`/videos/${slug}/thumbnail$`),
      );

      const thumbnail = await api()
        .get(`/videos/${slug}/thumbnail`)
        .expect(302);
      const image = await requestPresigned(thumbnail.headers.location);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
      expect(image.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(
        true,
      );

      const stream = await api().get(`/videos/${slug}/stream`).expect(302);
      const ranged = await requestPresigned(stream.headers.location, {
        headers: { range: 'bytes=0-1023' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers['content-range']).toBe(
        `bytes 0-1023/${sampleVideo.length}`,
      );
      expect(ranged.body.equals(sampleVideo.subarray(0, 1024))).toBe(true);

      const download = await api().get(`/videos/${slug}/download`).expect(302);
      const file = await requestPresigned(download.headers.location);
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toContain(
        'attachment; filename="sample.mp4"',
      );
      expect(file.body.equals(sampleVideo)).toBe(true);
    },
    PROCESSING_TIMEOUT_MS + 30_000,
  );

  it(
    'should mark an upload that is not a video as failed with a reason',
    async () => {
      const slug = await uploadVideo(randomBytes(64 * 1024), 'not-a-video.mp4');

      const video = await waitForTerminalStatus(slug);

      expect(video.status).toBe('failed');
      expect(video.failure_reason).toEqual(expect.any(String));
      expect(video.failure_reason!.length).toBeGreaterThan(0);
      await api().get(`/videos/${slug}/stream`).expect(409);
    },
    PROCESSING_TIMEOUT_MS + 30_000,
  );

  it('should accept a 10 GiB declaration without receiving any bytes', async () => {
    const created = await auth(api().post('/videos'))
      .send({
        title: 'Ten gibibytes',
        file_name: 'huge.mp4',
        file_size: TEN_GIB,
        mime_type: 'video/mp4',
      })
      .expect(201);
    const { slug } = created.body.video as { slug: string };

    const urls = await auth(api().post(`/videos/${slug}/upload/part-urls`))
      .send({ part_numbers: [1, 160] })
      .expect(200);

    expect(created.body.upload).toMatchObject({
      part_size_bytes: 64 * 1024 * 1024,
      part_count: 160,
    });
    expect(
      (urls.body.parts as { part_number: number }[]).map((p) => p.part_number),
    ).toEqual([1, 160]);
    await auth(api().post(`/videos/${slug}/upload/part-urls`))
      .send({ part_numbers: [161] })
      .expect(422);
  });
});
