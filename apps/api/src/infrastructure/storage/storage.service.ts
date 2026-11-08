import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

/** How long a download link works. Short, so a forwarded link soon stops working. */
export const DOWNLOAD_LINK_SECONDS = 300;

/**
 * Private S3-compatible storage. Objects are never public: the API stores and reads them, and hands
 * browsers short-lived signed download links. Keys are random, so they reveal nothing about the owner.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  /** Signs links with the address browsers can reach, which may differ from the API's own route. */
  private readonly publicClient: S3Client;
  readonly bucket: string;

  constructor(private readonly config: AppConfig) {
    const { endpoint, publicEndpoint, region, accessKey, secretKey, bucket } = config.storage;
    const common = {
      region,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      // SeaweedFS and most self-hosted stores address buckets by path, not by sub-domain.
      forcePathStyle: true,
    };
    this.client = new S3Client({ ...common, endpoint });
    this.publicClient = new S3Client({ ...common, endpoint: publicEndpoint });
    this.bucket = bucket;
  }

  /**
   * Checks the bucket at start-up so a storage problem shows immediately, not on the first upload.
   * Outside production a missing bucket is created; in production it must already exist.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const missing = error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
      if (!missing || this.config.isProduction) {
        throw new Error(
          `File storage bucket "${this.bucket}" is not reachable: ${(error as Error).message}`,
          {
            cause: error,
          },
        );
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created storage bucket "${this.bucket}".`);
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`Stored file ${key} has no content.`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async downloadUrl(key: string): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: DOWNLOAD_LINK_SECONDS,
      },
    );
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000) };
  }

  onModuleDestroy(): void {
    this.client.destroy();
    this.publicClient.destroy();
  }
}
