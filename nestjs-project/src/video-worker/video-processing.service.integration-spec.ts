import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { generateSampleVideo } from '../test/video-fixtures';
import { createVideoTestingModule } from '../test/video-test-module';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { videoStorageKeys } from '../videos/videos.constants';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService } from './media-probe.service';
import { VideoNotReadyForProcessingError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

/** Processing collaborators without the BullMQ processor (no worker in Jest). */
@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
  providers: [MediaProbeService, VideoProcessingService],
})
class ProcessingTestModule {}

describe('VideoProcessingService (integration — Postgres + MinIO + FFmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideoProcessingService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let workDir: string;
  let sample: Buffer;
  let counter = 0;

  beforeAll(async () => {
    module = await createVideoTestingModule([ProcessingTestModule]);
    dataSource = module.get(DataSource);
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    workDir = mkdtempSync(join(tmpdir(), 'processing-'));
    sample = readFileSync(
      await generateSampleVideo(join(workDir, 'sample.mp4'), { seconds: 2 }),
    );
  }, 30_000);

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createVideo(
    status: VideoStatus,
    source?: Buffer,
  ): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `processing_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `proc${n}`,
      nickname: `proc_${n}`,
      user_id: user.id,
    });
    const id = randomUUID();
    const video = await videoRepository.save({
      id,
      slug: `proc${String(n).padStart(7, '0')}`,
      channel_id: channel.id,
      title: 'Clip',
      status,
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: source?.length ?? 1,
      part_size_bytes: 64 * 1024 * 1024,
      source_key: `test/processing/${id}/source`,
      upload_id: null,
    });
    if (source) await storage.putObject(video.source_key, source, 'video/mp4');
    return video;
  }

  it('should mark a valid upload ready with duration, metadata and a stored thumbnail', async () => {
    const video = await createVideo(VideoStatus.PROCESSING, sample);

    const outcome = await service.process(video.id);

    expect(outcome).toBe('processed');
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeCloseTo(2, 0);
    expect(row.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(row.thumbnail_key).toBe(videoStorageKeys.thumbnail(video.id));
    expect(row.processed_at).toBeInstanceOf(Date);
    expect(await storage.headObject(row.thumbnail_key!)).toBeGreaterThan(0);
  });

  it('should raise InvalidMediaError for a garbage upload and leave it processing', async () => {
    const video = await createVideo(
      VideoStatus.PROCESSING,
      randomBytes(32 * 1024),
    );

    await expect(service.process(video.id)).rejects.toThrow(InvalidMediaError);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });

  it('should ask for a retry when the job arrives before the draft was committed', async () => {
    const video = await createVideo(VideoStatus.DRAFT);

    await expect(service.process(video.id)).rejects.toThrow(
      VideoNotReadyForProcessingError,
    );
  });

  it('should skip videos that are already ready or no longer exist', async () => {
    const video = await createVideo(VideoStatus.READY);

    expect(await service.process(video.id)).toBe('skipped');
    expect(await service.process(randomUUID())).toBe('skipped');
  });

  it('should record a failure reason only for videos in processing', async () => {
    const processing = await createVideo(VideoStatus.PROCESSING);
    const ready = await createVideo(VideoStatus.READY);

    await service.markFailed(processing.id, 'x'.repeat(2000));
    await service.markFailed(ready.id, 'late failure');

    const failed = await videoRepository.findOneByOrFail({ id: processing.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.failure_reason).toHaveLength(1000);
    const untouched = await videoRepository.findOneByOrFail({ id: ready.id });
    expect(untouched.status).toBe(VideoStatus.READY);
  });
});
