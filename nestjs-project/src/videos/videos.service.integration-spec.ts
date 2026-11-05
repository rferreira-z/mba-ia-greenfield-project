import { DataSource, Repository } from 'typeorm';
import { TestingModule } from '@nestjs/testing';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { createVideoTestingModule } from '../test/video-test-module';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration — Postgres + MinIO + Redis)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    module = await createVideoTestingModule([VideosModule]);
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
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
});
