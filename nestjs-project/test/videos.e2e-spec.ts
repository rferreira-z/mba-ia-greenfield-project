import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresigned } from '../src/test/presigned-http';
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

  describe('upload handshake', () => {
    const body = randomBytes(4096);
    const smallVideo = { ...validBody, file_size: body.length };

    async function createDraft(): Promise<string> {
      const res = await createVideo(smallVideo).expect(201);
      return res.body.video.slug as string;
    }

    function partUrls(slug: string, partNumbers: unknown, bearer = token) {
      return request(app.getHttpServer())
        .post(`/videos/${slug}/upload/part-urls`)
        .set('Authorization', `Bearer ${bearer}`)
        .send({ part_numbers: partNumbers });
    }

    function complete(slug: string, bearer = token) {
      return request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${bearer}`);
    }

    async function uploadWholeFile(slug: string): Promise<void> {
      const res = await partUrls(slug, [1]).expect(200);
      const put = await requestPresigned(res.body.parts[0].url, {
        method: 'PUT',
        body,
      });
      expect(put.status).toBe(200);
    }

    it('should return presigned part URLs for the public storage endpoint', async () => {
      const slug = await createDraft();

      const res = await partUrls(slug, [1]).expect(200);

      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0].part_number).toBe(1);
      expect(
        res.body.parts[0].url.startsWith(process.env.S3_PUBLIC_ENDPOINT),
      ).toBe(true);
      expect(Date.parse(res.body.expires_at)).toBeGreaterThan(Date.now());
    });

    it('should complete an uploaded video with 202 and status processing', async () => {
      const slug = await createDraft();
      await uploadWholeFile(slug);

      const res = await complete(slug).expect(202);

      expect(res.body.status).toBe('processing');
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ slug });
      // The Compose video-worker may already have picked the job up.
      expect(row.status).not.toBe(VideoStatus.DRAFT);
      expect(row.upload_id).toBeNull();
    });

    it('should let the owner read the video status', async () => {
      const slug = await createDraft();

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.slug).toBe(slug);
      expect(res.body.status).toBe('draft');
    });

    it('should return 409 when completing the same upload twice', async () => {
      const slug = await createDraft();
      await uploadWholeFile(slug);
      await complete(slug).expect(202);

      const res = await complete(slug).expect(409);

      expect(res.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');
    });

    it('should return 422 UPLOAD_INCOMPLETE when parts are missing', async () => {
      const slug = await createDraft();

      const res = await complete(slug).expect(422);

      expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
    });

    it('should return 422 for a part number above the part count', async () => {
      const slug = await createDraft();

      const res = await partUrls(slug, [2]).expect(422);

      expect(res.body.error).toBe('INVALID_PART_NUMBER');
    });

    it('should return 400 for an invalid part_numbers payload', async () => {
      const slug = await createDraft();

      const res = await partUrls(slug, [0, 'x']).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it("should return 403 when another user touches the owner's video", async () => {
      const slug = await createDraft();
      clearThrottler(app);
      const intruder = await registerConfirmAndLogin(
        app,
        `intruder_${userCounter}@example.com`,
      );

      const res = await partUrls(slug, [1], intruder).expect(403);
      await complete(slug, intruder).expect(403);
      await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${intruder}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_ACCESS_DENIED');
    });

    it('should return 404 for an unknown slug', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/doesNotExis')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 401 on owner routes without a token', async () => {
      const slug = await createDraft();

      await request(app.getHttpServer()).get(`/videos/${slug}`).expect(401);
      await request(app.getHttpServer())
        .post(`/videos/${slug}/upload/complete`)
        .expect(401);
    });
  });
});
