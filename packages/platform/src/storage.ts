import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

/**
 * Object storage. Keys are tenant-prefixed: `<tenantId|global>/<yyyy>/<mm>/<uuid>/<filename>`.
 * Only the documents service hands out download URLs; other services read bytes via `get`.
 */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** A time-limited URL the browser can GET. Null when the caller must proxy the bytes. */
  downloadUrl(key: string, filename: string, ttlSeconds?: number): Promise<string | null>;
}

class LocalStorage implements Storage {
  private root = resolve(config().STORAGE_LOCAL_DIR);
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async stream(key: string) {
    return createReadStream(this.path(key));
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async downloadUrl() {
    return null;
  }
}

class S3Storage implements Storage {
  private client = new S3Client({ region: config().AWS_REGION });
  private bucket = config().S3_BUCKET;
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'aws:kms',
      }),
    );
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async stream(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }
  async exists(key: string) {
    try {
      await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-0' }));
      return true;
    } catch {
      return false;
    }
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  downloadUrl(key: string, filename: string, ttlSeconds = 300) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `inline; filename="${filename.replace(/"/g, '')}"`,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}

let instance: Storage | undefined;
export const storage = (): Storage => {
  instance ??= config().STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
  return instance;
};

export const storageKey = (tenantId: string | null, filename: string) => {
  const d = new Date();
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 180);
  return `${tenantId ?? 'global'}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}/${safe}`;
};
