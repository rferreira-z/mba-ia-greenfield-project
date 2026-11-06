import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { MultipartUploadNotFoundError } from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

function httpStatus(err: unknown): number | undefined {
  const metadata = (err as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata;
  return metadata?.httpStatusCode;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /** Lifetime, in seconds, of every presigned URL this service issues. */
  get presignedUrlExpiresSeconds(): number {
    return this.config.presignedUrlExpiresSeconds;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for object "${key}"`);
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignedUrlExpiresSeconds },
    );
  }

  async listUploadedParts(
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;

    try {
      for (;;) {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        if (!page.IsTruncated) break;
        marker = page.NextPartNumberMarker;
      }
    } catch (err) {
      throw this.mapMultipartError(err, key);
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (err) {
      throw this.mapMultipartError(err, key);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      throw this.mapMultipartError(err, key);
    }
  }

  /** Size in bytes of the stored object, or `null` when it does not exist. */
  async headObject(key: string): Promise<number | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return head.ContentLength ?? 0;
    } catch (err) {
      if (errorName(err) === 'NotFound' || httpStatus(err) === 404) {
        return null;
      }
      throw err;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Client-facing GET URL (public endpoint). */
  async presignGetObject(
    key: string,
    options: { contentDisposition?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: this.config.presignedUrlExpiresSeconds },
    );
  }

  /** GET URL reachable inside the Compose network (consumed by the worker). */
  async presignInternalGetObject(key: string): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: this.config.presignedUrlExpiresSeconds },
    );
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  private mapMultipartError(err: unknown, key: string): unknown {
    return errorName(err) === 'NoSuchUpload'
      ? new MultipartUploadNotFoundError(key)
      : err;
  }
}
