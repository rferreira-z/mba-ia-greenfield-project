import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue keys (phase 03)', () => {
  it('should apply Compose-service defaults when the keys are not set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
      S3_FORCE_PATH_STYLE: 'true',
      PRESIGNED_URL_EXPIRES_SECONDS: 3600,
      UPLOAD_PART_SIZE_MB: 64,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should coerce numeric strings for the numeric keys', () => {
    const { value, error } = validate({
      UPLOAD_PART_SIZE_MB: '16',
      PRESIGNED_URL_EXPIRES_SECONDS: '900',
      REDIS_PORT: '6380',
    });

    expect(error).toBeUndefined();
    expect(value.UPLOAD_PART_SIZE_MB).toBe(16);
    expect(value.PRESIGNED_URL_EXPIRES_SECONDS).toBe(900);
    expect(value.REDIS_PORT).toBe(6380);
  });

  it('should reject a part size below the S3 minimum of 5 MB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_MB: '4' });

    expect(error?.message).toContain('UPLOAD_PART_SIZE_MB');
  });

  it('should reject a presigned URL lifetime above the SigV4 maximum (7 days)', () => {
    const { error } = validate({ PRESIGNED_URL_EXPIRES_SECONDS: '700000' });

    expect(error?.message).toContain('PRESIGNED_URL_EXPIRES_SECONDS');
  });

  it('should reject a non-URI storage endpoint', () => {
    const { error } = validate({ S3_PUBLIC_ENDPOINT: 'not a url' });

    expect(error?.message).toContain('S3_PUBLIC_ENDPOINT');
  });

  it('should reject S3_FORCE_PATH_STYLE values other than true/false', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'yes' });

    expect(error?.message).toContain('S3_FORCE_PATH_STYLE');
  });
});
