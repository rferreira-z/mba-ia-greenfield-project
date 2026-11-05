import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import appConfig from '../config/app.config';
import storageConfig from '../config/storage.config';
import { MultipartUploadNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import * as slugUtil from './slug.util';
import { MAX_SLUG_ATTEMPTS } from './videos.constants';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadIncompleteException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoUploadNotInProgressException,
} from './videos.exceptions';
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

/** A draft of 2 parts + 1 byte (3 parts) owned by user-1. */
function draft(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    slug: 'abcdefghijk',
    channel_id: 'channel-1',
    channel: { id: 'channel-1', user_id: 'user-1' },
    title: 'Holiday',
    status: VideoStatus.DRAFT,
    original_filename: 'holiday.mp4',
    mime_type: 'video/mp4',
    size_bytes: PART_SIZE * 2 + 1,
    part_size_bytes: PART_SIZE,
    source_key: 'videos/video-1/source',
    upload_id: 'upload-1',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    failure_reason: null,
    processed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

const fullParts = [
  { partNumber: 1, etag: '"a"', size: PART_SIZE },
  { partNumber: 2, etag: '"b"', size: PART_SIZE },
  { partNumber: 3, etag: '"c"', size: 1 },
];

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((data: Partial<Video>) => ({ ...data })),
    save: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findOneByOrFail: jest.fn(),
  };
  const updateQuery = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    execute: jest.fn(),
  };
  const manager = { createQueryBuilder: jest.fn(() => updateQuery) };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  const producer = { enqueue: jest.fn() };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listUploadedParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    presignGetObject: jest.fn(),
    presignedUrlExpiresSeconds: 3600,
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
    storageService.presignUploadPart.mockImplementation(
      (_key: string, _upload: string, n: number) =>
        Promise.resolve(`http://localhost:9000/part-${n}`),
    );
    storageService.presignedUrlExpiresSeconds = 3600;
    for (const fn of ['update', 'set', 'where'] as const) {
      updateQuery[fn].mockReturnValue(updateQuery);
    }
    updateQuery.execute.mockResolvedValue({ affected: 1 });
    manager.createQueryBuilder.mockReturnValue(updateQuery);
    dataSource.transaction.mockImplementation(
      (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
    );
    videoRepository.findOneByOrFail.mockImplementation(
      ({ id }: { id: string }) =>
        Promise.resolve({ ...draft(), id, status: VideoStatus.PROCESSING }),
    );

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
        { provide: DataSource, useValue: dataSource },
        { provide: VideoProcessingProducer, useValue: producer },
        {
          provide: appConfig.KEY,
          useValue: { url: 'http://api.test/' },
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

  describe('ownership', () => {
    it('should throw VideoNotFoundException for an unknown slug', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.getOwnedVideo('missing', 'user-1')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it("should throw VideoAccessDeniedException for another user's video", async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      await expect(
        service.getOwnedVideo('abcdefghijk', 'intruder'),
      ).rejects.toThrow(VideoAccessDeniedException);
    });
  });

  describe('presignUploadParts', () => {
    it('should presign one URL per requested part with an expiry', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      const result = await service.presignUploadParts(
        'abcdefghijk',
        'user-1',
        [1, 3],
      );

      expect(result.parts).toEqual([
        { part_number: 1, url: 'http://localhost:9000/part-1' },
        { part_number: 3, url: 'http://localhost:9000/part-3' },
      ]);
      expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject part numbers above the part count', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      await expect(
        service.presignUploadParts('abcdefghijk', 'user-1', [4]),
      ).rejects.toThrow(InvalidPartNumberException);
    });

    it('should reject videos that are no longer drafts', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.presignUploadParts('abcdefghijk', 'user-1', [1]),
      ).rejects.toThrow(VideoUploadNotInProgressException);
    });
  });

  describe('completeUpload', () => {
    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(draft());
      storageService.listUploadedParts.mockResolvedValue(fullParts);
    });

    it('should complete storage, move to processing and enqueue in one transaction', async () => {
      const result = await service.completeUpload('abcdefghijk', 'user-1');

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source',
        'upload-1',
        fullParts,
      );
      expect(updateQuery.set).toHaveBeenCalledWith({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('should reject a missing part as UploadIncomplete without completing', async () => {
      storageService.listUploadedParts.mockResolvedValue([
        fullParts[0],
        fullParts[2],
      ]);

      await expect(
        service.completeUpload('abcdefghijk', 'user-1'),
      ).rejects.toThrow(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should reject a total size different from the declared size', async () => {
      storageService.listUploadedParts.mockResolvedValue([
        fullParts[0],
        fullParts[1],
        { partNumber: 3, etag: '"c"', size: 2 },
      ]);

      await expect(
        service.completeUpload('abcdefghijk', 'user-1'),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('should recover when storage already completed the upload and sizes match', async () => {
      storageService.listUploadedParts.mockRejectedValue(
        new MultipartUploadNotFoundError('videos/video-1/source'),
      );
      storageService.headObject.mockResolvedValue(PART_SIZE * 2 + 1);

      await service.completeUpload('abcdefghijk', 'user-1');

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
    });

    it('should reject recovery when the stored object is missing', async () => {
      storageService.listUploadedParts.mockRejectedValue(
        new MultipartUploadNotFoundError('videos/video-1/source'),
      );
      storageService.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload('abcdefghijk', 'user-1'),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('should throw VideoUploadNotInProgress when a concurrent completion won the update', async () => {
      updateQuery.execute.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('abcdefghijk', 'user-1'),
      ).rejects.toThrow(VideoUploadNotInProgressException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should propagate an enqueue failure from inside the transaction (rollback)', async () => {
      producer.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('abcdefghijk', 'user-1'),
      ).rejects.toThrow('redis down');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('should reject completing a video that is not a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.READY, upload_id: null }),
      );

      await expect(
        service.completeUpload('abcdefghijk', 'user-1'),
      ).rejects.toThrow(VideoUploadNotInProgressException);
    });
  });

  describe('public delivery URLs', () => {
    const ready = () =>
      draft({
        status: VideoStatus.READY,
        upload_id: null,
        original_filename: 'Férias "2026".mp4',
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      });

    beforeEach(() => {
      storageService.presignGetObject.mockResolvedValue(
        'http://localhost:9000/signed',
      );
    });

    it('should presign the source object for streaming', async () => {
      videoRepository.findOneBy.mockResolvedValue(ready());

      const url = await service.getStreamUrl('abcdefghijk');

      expect(url).toBe('http://localhost:9000/signed');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
      );
    });

    it('should sign downloads with an RFC 6266 attachment disposition', async () => {
      videoRepository.findOneBy.mockResolvedValue(ready());

      await service.getDownloadUrl('abcdefghijk');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
        {
          contentDisposition:
            'attachment; filename="F_rias _2026_.mp4"; ' +
            "filename*=UTF-8''F%C3%A9rias%20%222026%22.mp4",
        },
      );
    });

    it('should presign the thumbnail object', async () => {
      videoRepository.findOneBy.mockResolvedValue(ready());

      await service.getThumbnailUrl('abcdefghijk');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
      );
    });

    it('should return 404 semantics for an unknown slug', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.getStreamUrl('missing')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should refuse delivery while the video is %s',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(draft({ status }));

        await expect(service.getDownloadUrl('abcdefghijk')).rejects.toThrow(
          VideoNotReadyException,
        );
      },
    );

    it('should expose the unique URLs built from APP_URL and the slug', async () => {
      videoRepository.findOne.mockResolvedValue(ready());

      const video = await service.getOwnedVideo('abcdefghijk', 'user-1');

      expect(video.stream_url).toBe(
        'http://api.test/videos/abcdefghijk/stream',
      );
      expect(video.download_url).toBe(
        'http://api.test/videos/abcdefghijk/download',
      );
      expect(video.thumbnail_url).toBe(
        'http://api.test/videos/abcdefghijk/thumbnail',
      );
    });

    it('should report no thumbnail URL before processing', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      const video = await service.getOwnedVideo('abcdefghijk', 'user-1');

      expect(video.thumbnail_url).toBeNull();
    });
  });
});
