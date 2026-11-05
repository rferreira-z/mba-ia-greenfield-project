import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  clearThrottler,
  createE2eApp,
  registerConfirmAndLogin,
} from './utils/e2e-app';

const TEN_GIB = 10 * 1024 ** 3;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let token: string;
  let userCounter = 0;

  const validBody = {
    title: 'My first video',
    file_name: 'first.mp4',
    file_size: 5_000_000,
    mime_type: 'video/mp4',
  };

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    await abortPendingUploads();
    await app.close();
  });

  beforeEach(async () => {
    await abortPendingUploads();
    await cleanAllTables(dataSource);
    clearThrottler(app);
    token = await registerConfirmAndLogin(
      app,
      `videos_e2e_${++userCounter}@example.com`,
    );
  });

  /** Drafts left by a test still hold a multipart upload in MinIO. */
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

  function createVideo(body: object = validBody, bearer = token) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);
  }

  describe('POST /videos', () => {
    it('should return 201 with a draft video and the upload plan', async () => {
      const res = await createVideo().expect(201);

      expect(res.body.video).toMatchObject({
        title: validBody.title,
        status: 'draft',
        original_filename: validBody.file_name,
        mime_type: 'video/mp4',
        size_bytes: validBody.file_size,
        duration_seconds: null,
        metadata: null,
      });
      expect(res.body.video.slug).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(res.body.video).not.toHaveProperty('upload_id');
      expect(res.body.upload).toEqual({
        part_size_bytes: 67108864,
        part_count: 1,
        max_part_urls_per_request: 100,
      });
    });

    it('should pre-register the video as a draft in the database', async () => {
      const res = await createVideo().expect(201);

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: res.body.video.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.upload_id).toEqual(expect.any(String));
    });

    it('should accept exactly 10 GiB and plan 160 parts', async () => {
      const res = await createVideo({
        ...validBody,
        file_size: TEN_GIB,
      }).expect(201);

      expect(res.body.upload.part_count).toBe(160);
    });

    it('should generate a different slug for every video', async () => {
      const first = await createVideo().expect(201);
      const second = await createVideo().expect(201);

      expect(first.body.video.slug).not.toBe(second.body.video.slug);
    });

    it('should reject a file larger than 10 GiB with 400', async () => {
      const res = await createVideo({
        ...validBody,
        file_size: TEN_GIB + 1,
      }).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject a MIME type outside the allowlist with 400', async () => {
      const res = await createVideo({
        ...validBody,
        mime_type: 'video/x-msvideo',
      }).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });
  });
});
