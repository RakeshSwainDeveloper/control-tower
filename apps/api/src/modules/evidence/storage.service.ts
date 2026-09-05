import { Injectable, Inject } from '@nestjs/common';
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../../config/env.js';
import { ENV_TOKEN } from '../../common/tokens.js';

export interface PresignedSingle {
  mode: 'single';
  upload_url: string;
  storage_key: string;
  expires_at: string;
}

export interface PresignedMultipart {
  mode: 'multipart';
  storage_key: string;
  upload_id: string;
  part_size: number;
  part_urls: Array<{ part_number: number; url: string }>;
  expires_at: string;
}

/** Above this, upload in parts so an interrupted 15 MB video resumes from the
 *  part boundary rather than from zero. FR-179. */
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024;

@Injectable()
export class StorageService {
  /** Server-side operations: head, get, put, multipart admin. Internal host. */
  private readonly s3: S3Client;
  /**
   * Signing only.
   *
   * A presigned URL is consumed by a PHONE, not by this container. Signing with
   * the internal endpoint yields `http://minio:9000/...`, which resolves only
   * inside the Docker network — every real client gets a connection refused.
   * The signature is computed over the host the client will send, so the two
   * clients must differ.
   */
  private readonly s3Public: S3Client;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {
    const credentials = {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    };
    this.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials,
    });
    this.s3Public = new S3Client({
      endpoint: env.S3_PUBLIC_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials,
    });
  }

  /**
   * Storage keys are derived, never client-supplied.
   *
   * Tenant and month lead so a lifecycle rule can tier a whole month, and so a
   * key can never be crafted to point at another tenant's prefix.
   */
  buildKey(orgId: string, evidenceId: string, mime: string): string {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) ?? 'bin';
    return `org/${orgId}/${yyyymm}/${evidenceId}.${ext}`;
  }

  /**
   * Presign an upload. Bytes go DIRECT to object storage.
   *
   * 200 photos a day per project through the API tier is pointless load and a
   * needless failure mode. The API authorises; the store takes the bytes.
   */
  async presignUpload(
    key: string, mime: string, sizeBytes: number,
  ): Promise<PresignedSingle | PresignedMultipart> {
    const ttl = this.env.S3_SIGNED_URL_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    if (sizeBytes <= MULTIPART_THRESHOLD) {
      const url = await getSignedUrl(
        this.s3Public,
        new PutObjectCommand({
          Bucket: this.env.S3_BUCKET_EVIDENCE,
          Key: key,
          ContentType: mime,
          ContentLength: sizeBytes,
        }),
        { expiresIn: ttl },
      );
      return { mode: 'single', upload_url: url, storage_key: key, expires_at: expiresAt };
    }

    const created = await this.s3.send(new CreateMultipartUploadCommand({
      Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key, ContentType: mime,
    }));
    const partCount = Math.ceil(sizeBytes / PART_SIZE);
    const part_urls = await Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(async (n) => ({
        part_number: n,
        url: await getSignedUrl(
          this.s3Public,
          new UploadPartCommand({
            Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key,
            UploadId: created.UploadId!, PartNumber: n,
          }),
          { expiresIn: ttl },
        ),
      })),
    );
    return {
      mode: 'multipart', storage_key: key, upload_id: created.UploadId!,
      part_size: PART_SIZE, part_urls, expires_at: expiresAt,
    };
  }

  async completeMultipart(
    key: string, uploadId: string, parts: Array<{ part_number: number; etag: string }>,
  ): Promise<void> {
    await this.s3.send(new CompleteMultipartUploadCommand({
      Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key, UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .sort((a, b) => a.part_number - b.part_number)
          .map((p) => ({ PartNumber: p.part_number, ETag: p.etag })),
      },
    }));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({
      Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key, UploadId: uploadId,
    })).catch(() => undefined);
  }

  /** Confirms the bytes actually arrived, and how many. The client's claimed
   *  size is never trusted: it is checked against what the store received. */
  async head(key: string): Promise<{ size: number; mime: string } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({
        Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key,
      }));
      return { size: Number(r.ContentLength ?? 0), mime: r.ContentType ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  /** FR-180: short-lived signed URL. No public path exists, ever. */
  async presignDownload(key: string, filename?: string): Promise<string> {
    return getSignedUrl(
      this.s3Public,
      new GetObjectCommand({
        Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key,
        // Force download semantics: an uploaded HTML file must never render in
        // the viewer's origin.
        ResponseContentDisposition: filename
          ? `attachment; filename="${filename.replace(/["\\]/g, '')}"`
          : 'attachment',
      }),
      { expiresIn: this.env.S3_SIGNED_URL_TTL_SECONDS },
    );
  }

  async getBytes(key: string): Promise<Buffer | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({
        Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key,
      }));
      const chunks: Uint8Array[] = [];
      for await (const c of r.Body as AsyncIterable<Uint8Array>) chunks.push(c);
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  async putBytes(key: string, body: Buffer, mime: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key, Body: body, ContentType: mime,
    }));
  }

  /** Only ever used to clean up an upload that never completed. Evidence that
   *  has been linked is never deleted (FR-188). */
  async deleteAbandoned(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.env.S3_BUCKET_EVIDENCE, Key: key,
    })).catch(() => undefined);
  }
}
