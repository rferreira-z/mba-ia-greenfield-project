import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { requestPresigned } from '../test/presigned-http';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { createVideoTestingModule } from '../test/video-test-module';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { UploadIncompleteException } from './videos.exceptions';
import { VideosService } from './videos.service';

describe('VideosService (integration — Postgres + MinIO + Redis)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let counter = 0;

  beforeAll(async () => {
    module = await createVideoTestingModule([VideosModule]);
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_it_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `creator${n}`,
      nickname: `creator_${n}`,
      user_id: user.id,
    });
    return { user, channel };
  }

  describe('createUpload', () => {
    it('should persist a draft in the caller channel and start a multipart upload', async () => {
      const { user, channel } = await createUserWithChannel();

      const result = await service.createUpload(user.id, {
        title: 'Holiday',
        file_name: 'holiday.mp4',
        file_size: 1_000_000,
        mime_type: 'video/mp4',
      });

      const row = await videoRepository.findOneByOrFail({
        id: result.video.id,
      });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.channel_id).toBe(channel.id);
      expect(row.slug).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(row.source_key).toBe(`videos/${row.id}/source`);
      expect(row.size_bytes).toBe(1_000_000);
      expect(row.upload_id).toEqual(expect.any(String));
      await expect(
        storage.listUploadedParts(row.source_key, row.upload_id!),
      ).resolves.toEqual([]);
      await storage.abortMultipartUpload(row.source_key, row.upload_id!);
    });

    it('should accept the 10 GiB maximum and plan 160 parts of 64 MiB', async () => {
      const { user } = await createUserWithChannel();

      const result = await service.createUpload(user.id, {
        title: 'Big one',
        file_name: 'big.mp4',
        file_size: 10 * 1024 ** 3,
        mime_type: 'video/mp4',
      });

      expect(result.upload.part_size_bytes).toBe(64 * 1024 * 1024);
      expect(result.upload.part_count).toBe(160);
      const row = await videoRepository.findOneByOrFail({
        id: result.video.id,
      });
      await storage.abortMultipartUpload(row.source_key, row.upload_id!);
    });

    it('should abort the multipart upload when the draft insert fails (compensation)', async () => {
      const { user } = await createUserWithChannel();
      const abortSpy = jest.spyOn(storage, 'abortMultipartUpload');
      jest
        .spyOn(videoRepository.manager, 'save')
        .mockRejectedValueOnce(new Error('insert failed'));

      await expect(
        service.createUpload(user.id, {
          title: 'Doomed',
          file_name: 'doomed.mp4',
          file_size: 10,
          mime_type: 'video/mp4',
        }),
      ).rejects.toThrow('insert failed');

      expect(abortSpy).toHaveBeenCalledTimes(1);
      const [key, uploadId] = abortSpy.mock.calls[0];
      await expect(storage.listUploadedParts(key, uploadId)).rejects.toThrow();
      expect(await videoRepository.count()).toBe(0);
      abortSpy.mockRestore();
    });
  });

  describe('presignUploadParts + completeUpload', () => {
    async function startUpload(body: Buffer) {
      const { user } = await createUserWithChannel();
      const created = await service.createUpload(user.id, {
        title: 'Clip',
        file_name: 'clip.mp4',
        file_size: body.length,
        mime_type: 'video/mp4',
      });
      return { user, slug: created.video.slug, id: created.video.id };
    }

    async function putAllParts(slug: string, userId: string, body: Buffer) {
      const { parts } = await service.presignUploadParts(slug, userId, [1]);
      const res = await requestPresigned(parts[0].url, {
        method: 'PUT',
        body,
      });
      expect(res.status).toBe(200);
    }

    it('should complete the upload, mark it processing and enqueue the job', async () => {
      const body = randomBytes(2048);
      const { user, slug, id } = await startUpload(body);
      await putAllParts(slug, user.id, body);

      const result = await service.completeUpload(slug, user.id);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      expect(await storage.headObject(row.source_key)).toBe(body.length);
      const job = await queue.getJob(id);
      expect(job?.data).toEqual({ videoId: id });
    });

    it('should reject a size mismatch with UploadIncomplete and keep the draft', async () => {
      const declared = randomBytes(2048);
      const { user, slug, id } = await startUpload(declared);
      await putAllParts(slug, user.id, declared.subarray(0, 1000));

      await expect(service.completeUpload(slug, user.id)).rejects.toThrow(
        UploadIncompleteException,
      );

      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(await queue.getJob(id)).toBeUndefined();
      await storage.abortMultipartUpload(row.source_key, row.upload_id!);
    });

    it('should roll back when enqueueing fails and recover on retry', async () => {
      const body = randomBytes(2048);
      const { user, slug, id } = await startUpload(body);
      await putAllParts(slug, user.id, body);
      const producer = module.get(VideoProcessingProducer);
      jest
        .spyOn(producer, 'enqueue')
        .mockRejectedValueOnce(new Error('redis down'));

      await expect(service.completeUpload(slug, user.id)).rejects.toThrow(
        'redis down',
      );
      const rolledBack = await videoRepository.findOneByOrFail({ id });
      expect(rolledBack.status).toBe(VideoStatus.DRAFT);
      expect(rolledBack.upload_id).not.toBeNull();

      const retried = await service.completeUpload(slug, user.id);

      expect(retried.status).toBe(VideoStatus.PROCESSING);
      expect(await queue.getJob(id)).toBeDefined();
    });
  });
});
