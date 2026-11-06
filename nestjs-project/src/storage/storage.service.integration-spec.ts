import { randomBytes, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { requestPresigned } from '../test/presigned-http';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { MultipartUploadNotFoundError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let s3: S3Client;
  const createdKeys: string[] = [];
  const bucket = process.env.S3_BUCKET ?? 'streamtube-videos';
  const publicEndpoint =
    process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000';
  const internalEndpoint = process.env.S3_ENDPOINT ?? 'http://minio:9000';

  const newKey = (): string => {
    const key = `test/storage/${randomUUID()}`;
    createdKeys.push(key);
    return key;
  };

  async function uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<void> {
    const url = await storage.presignUploadPart(key, uploadId, partNumber);
    const res = await requestPresigned(url, { method: 'PUT', body });
    expect(res.status).toBe(200);
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    s3 = module.get(S3_INTERNAL_CLIENT);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    await module.close();
  });

  describe('multipart upload through presigned part URLs', () => {
    it('should complete a 2-part upload and store the exact total size', async () => {
      const key = newKey();
      const first = randomBytes(MIN_PART_SIZE);
      const second = randomBytes(1234);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await uploadPart(key, uploadId, 1, first);
      await uploadPart(key, uploadId, 2, second);
      const parts = await storage.listUploadedParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, parts);

      expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
        [1, first.length],
        [2, second.length],
      ]);
      expect(parts.every((p) => p.etag.length > 0)).toBe(true);
      expect(await storage.headObject(key)).toBe(first.length + second.length);
    });

    it('should sign part URLs for the public endpoint', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const url = await storage.presignUploadPart(key, uploadId, 1);

      expect(url.startsWith(`${publicEndpoint}/${bucket}/${key}`)).toBe(true);
      expect(url).toContain('partNumber=1');
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should report an aborted upload as MultipartUploadNotFoundError', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listUploadedParts(key, uploadId)).rejects.toThrow(
        MultipartUploadNotFoundError,
      );
      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"x"' },
        ]),
      ).rejects.toThrow(MultipartUploadNotFoundError);
    });
  });

  describe('objects', () => {
    it('should return null from headObject when the object does not exist', async () => {
      expect(await storage.headObject(newKey())).toBeNull();
    });

    it('should serve a range request on a presigned GET with 206', async () => {
      const key = newKey();
      const content = randomBytes(4096);
      await storage.putObject(key, content, 'video/mp4');

      const url = await storage.presignGetObject(key);
      const res = await requestPresigned(url, {
        headers: { range: 'bytes=0-99' },
      });

      expect(url.startsWith(publicEndpoint)).toBe(true);
      expect(res.status).toBe(206);
      expect(res.body.equals(content.subarray(0, 100))).toBe(true);
      expect(res.headers['content-range']).toBe('bytes 0-99/4096');
      expect(res.headers['content-type']).toBe('video/mp4');
    });

    it('should apply the requested Content-Disposition to a download URL', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.from('data'), 'video/mp4');
      const disposition = 'attachment; filename="clip.mp4"';

      const url = await storage.presignGetObject(key, {
        contentDisposition: disposition,
      });
      const res = await requestPresigned(url);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(disposition);
    });

    it('should presign internal GET URLs against the Compose endpoint', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.from('internal'), 'text/plain');

      const url = await storage.presignInternalGetObject(key);
      const res = await fetch(url);

      expect(url.startsWith(internalEndpoint)).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('internal');
    });
  });
});
