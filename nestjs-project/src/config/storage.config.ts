import { registerAs } from '@nestjs/config';

const MEBIBYTE = 1024 * 1024;

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'streamtube',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'streamtube-secret',
  bucket: process.env.S3_BUCKET ?? 'streamtube-videos',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  presignedUrlExpiresSeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRES_SECONDS ?? '3600',
    10,
  ),
  uploadPartSizeBytes:
    parseInt(process.env.UPLOAD_PART_SIZE_MB ?? '64', 10) * MEBIBYTE,
}));
