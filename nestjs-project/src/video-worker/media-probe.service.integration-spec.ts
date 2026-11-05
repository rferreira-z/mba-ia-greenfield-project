import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { generateSampleVideo } from '../test/video-fixtures';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService } from './media-probe.service';

describe('MediaProbeService (integration — real FFmpeg)', () => {
  const service = new MediaProbeService();
  let workDir: string;
  let samplePath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'media-probe-'));
    samplePath = await generateSampleVideo(join(workDir, 'sample.mp4'), {
      seconds: 2,
      width: 320,
      height: 240,
    });
  }, 30_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('should extract duration and metadata from a generated MP4', async () => {
    const result = await service.probe(samplePath);

    expect(result.durationSeconds).toBeCloseTo(2, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      frame_rate: 30,
    });
    expect(result.metadata.format_name).toContain('mp4');
  });

  it('should report no audio codec for a silent video', async () => {
    const silent = await generateSampleVideo(join(workDir, 'silent.mp4'), {
      withAudio: false,
    });

    const result = await service.probe(silent);

    expect(result.metadata.audio_codec).toBeNull();
  });

  it('should extract a JPEG thumbnail frame', async () => {
    const jpeg = await service.extractThumbnail(samplePath, 0.2);

    expect(jpeg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(jpeg.length).toBeGreaterThan(1000);
  });

  it('should reject a non-media file as InvalidMediaError', async () => {
    const garbage = join(workDir, 'garbage.mp4');
    writeFileSync(garbage, randomBytes(64 * 1024));

    await expect(service.probe(garbage)).rejects.toThrow(InvalidMediaError);
  });

  describe('over a presigned storage URL', () => {
    let module: TestingModule;
    let storage: StorageService;
    const key = `test/media-probe/${randomUUID()}.mp4`;

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      }).compile();
      storage = module.get(StorageService);
      await storage.putObject(key, readFileSync(samplePath), 'video/mp4');
    });

    afterAll(async () => {
      await module.get<S3Client>(S3_INTERNAL_CLIENT).send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET ?? 'streamtube-videos',
          Key: key,
        }),
      );
      await module.close();
    });

    it('should probe and grab a frame through HTTP range reads', async () => {
      const url = await storage.presignInternalGetObject(key);

      const result = await service.probe(url);
      const jpeg = await service.extractThumbnail(url, 0.2);

      expect(result.metadata.width).toBe(320);
      expect(jpeg[0]).toBe(0xff);
    });
  });
});
