import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import * as slugUtil from './slug.util';
import { MAX_SLUG_ATTEMPTS } from './videos.constants';
import { ChannelNotFoundException } from './videos.exceptions';
import { VideosService } from './videos.service';

const PART_SIZE = 64 * 1024 * 1024;

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(err, {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
  return err;
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((data: Partial<Video>) => ({ ...data })),
    save: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };
  const dto: CreateVideoDto = {
    title: 'Holiday',
    file_name: 'holiday.mp4',
    file_size: PART_SIZE * 2 + 1,
    mime_type: 'video/mp4',
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.create.mockImplementation((data: Partial<Video>) => ({
      ...data,
    }));
    videoRepository.save.mockImplementation((video: Video) =>
      Promise.resolve({ ...video, created_at: new Date() }),
    );
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storageService.createMultipartUpload.mockResolvedValue('upload-1');

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: storageConfig.KEY,
          useValue: { uploadPartSizeBytes: PART_SIZE },
        },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createUpload', () => {
    it('should throw ChannelNotFoundException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createUpload('user-1', dto)).rejects.toThrow(
        ChannelNotFoundException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should persist a draft keyed by its id and return the upload plan', async () => {
      const result = await service.createUpload('user-1', dto);

      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe('channel-1');
      expect(saved.source_key).toBe(`videos/${saved.id}/source`);
      expect(saved.upload_id).toBe('upload-1');
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        saved.source_key,
        'video/mp4',
      );
      expect(result.upload).toEqual({
        part_size_bytes: PART_SIZE,
        part_count: 3,
        max_part_urls_per_request: 100,
      });
      expect(result.video.status).toBe(VideoStatus.DRAFT);
    });

    it('should retry with a new slug when the slug collides', async () => {
      const slugSpy = jest
        .spyOn(slugUtil, 'generateVideoSlug')
        .mockReturnValueOnce('collision01')
        .mockReturnValueOnce('freeSlug002');
      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation('slug'))
        .mockImplementationOnce((video: Video) => Promise.resolve(video));

      const result = await service.createUpload('user-1', dto);

      expect(result.video.slug).toBe('freeSlug002');
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      slugSpy.mockRestore();
    });

    it('should give up after the maximum slug attempts and abort the upload', async () => {
      videoRepository.save.mockRejectedValue(uniqueViolation('slug'));

      await expect(service.createUpload('user-1', dto)).rejects.toThrow(
        QueryFailedError,
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(MAX_SLUG_ATTEMPTS);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
    });

    it('should abort the multipart upload and rethrow on a non-slug insert failure', async () => {
      const failure = uniqueViolation('id');
      videoRepository.save.mockRejectedValue(failure);

      await expect(service.createUpload('user-1', dto)).rejects.toBe(failure);
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should surface the insert error even when the abort also fails', async () => {
      const failure = new Error('db down');
      videoRepository.save.mockRejectedValue(failure);
      storageService.abortMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.createUpload('user-1', dto)).rejects.toBe(failure);
    });
  });
});
