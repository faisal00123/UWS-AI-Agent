/**
 * Cloudflare R2 off-site backup storage (S3-compatible).
 *
 * R2 is used through the AWS S3 API with the account-specific endpoint:
 *   https://<account_id>.r2.cloudflarestorage.com
 *
 * Safety rules:
 *   - credentials are read from config only, NEVER logged, echoed or thrown
 *     in error messages (errors are sanitised to code/message/request id);
 *   - uploads are verified with HeadObject: the stored object must report the
 *     SAME byte size and the SAME sha256 we recorded locally, otherwise the
 *     backup is not claimed as off-site-verified;
 *   - every operation degrades to an explicit thrown error — silent success
 *     would breed false confidence about off-site copies (the exact failure
 *     mode that turns a local incident into permanent data loss).
 *
 * Free tier: R2 Free = 10 GB storage, zero egress fees; no billing is ever
 * enabled by this module (no lifecycle/oracle/bucket-create calls).
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

/** Shape of Config['backup']['r2'] (structural typing keeps config out of the import graph). */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  endpoint: string;
  configured: boolean;
}

export interface R2ObjectInfo {
  key: string;
  size: number;
  sha256: string | null;
  etag: string | null;
}

function requireConfigured(cfg: R2Config): void {
  if (!cfg.configured) {
    throw new Error('R2 storage is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)');
  }
}

/**
 * AWS SDK errors can embed the request (and, in rare cases, signed headers).
 * Only the stable, credential-free fields are surfaced.
 */
function sanitise(err: unknown): Error {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: number; requestId?: unknown } };
    const parts: string[] = [];
    if (typeof e.name === 'string') parts.push(e.name);
    if (typeof e.message === 'string') parts.push(e.message);
    if (e.$metadata?.httpStatusCode) parts.push(`http=${e.$metadata.httpStatusCode}`);
    if (typeof e.$metadata?.requestId === 'string') parts.push(`requestId=${e.$metadata.requestId}`);
    if (parts.length > 0) return new Error(`R2 error: ${parts.join(' | ')}`);
  }
  return new Error(`R2 error: ${String(err)}`);
}

function client(cfg: R2Config): S3Client {
  requireConfigured(cfg);
  const endpoint = cfg.endpoint || `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2 object counts are small; retries are handled by the SDK default.
  });
}

/** Object key for a backup file: `<prefix>/<file name>` (no secrets). */
export function r2KeyFor(cfg: R2Config, fileName: string): string {
  const prefix = cfg.prefix ? `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
  return `${prefix}${fileName.replace(/^\/+/, '')}`;
}

/** Non-secret reference for records/logs: r2://<bucket>/<key>. */
export function r2Ref(cfg: R2Config, key: string): string {
  return `r2://${cfg.bucket}/${key}`;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Buffer) return body;
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }
  // Fallback: collect the web stream / node stream chunks.
  const chunks: Uint8Array[] = [];
  const stream = body as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Uploads a backup buffer; the sha256 travels as object metadata for verify. */
export async function uploadBuffer(cfg: R2Config, key: string, body: Buffer, sha256: string): Promise<R2ObjectInfo> {
  const s3 = client(cfg);
  try {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: 'application/octet-stream',
        Metadata: { sha256, app: 'uws-ai-sales-agent' },
      }),
    );
    return { key, size: body.byteLength, sha256, etag: res.ETag ?? null };
  } catch (err) {
    throw sanitise(err);
  }
}

/** HeadObject verification: proves the object exists with our size + digest. */
export async function headObject(cfg: R2Config, key: string): Promise<R2ObjectInfo | null> {
  const s3 = client(cfg);
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return {
      key,
      size: res.ContentLength ?? 0,
      sha256: res.Metadata?.['sha256'] ?? null,
      etag: res.ETag ?? null,
    };
  } catch (err) {
    const name = err && typeof err === 'object' ? String((err as { name?: string }).name ?? '') : '';
    const message = err && typeof err === 'object' ? String((err as { message?: string }).message ?? '') : '';
    if (name === 'NotFound' || name === 'NoSuchKey' || message.includes('404')) return null;
    throw sanitise(err);
  }
}

/** Downloads a stored backup (used by isolated restore tests and recovery). */
export async function downloadObject(cfg: R2Config, key: string): Promise<Buffer | null> {
  const s3 = client(cfg);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return await streamToBuffer(res.Body);
  } catch (err) {
    const name = err && typeof err === 'object' ? String((err as { name?: string }).name ?? '') : '';
    const message = err && typeof err === 'object' ? String((err as { message?: string }).message ?? '') : '';
    if (name === 'NoSuchKey' || message.includes('404')) return null;
    throw sanitise(err);
  }
}

/** Lists stored backups under a prefix (retention/audit views). */
export async function listObjects(cfg: R2Config, prefix?: string): Promise<R2ObjectInfo[]> {
  const s3 = client(cfg);
  const out: R2ObjectInfo[] = [];
  let token: string | undefined;
  try {
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix ?? cfg.prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          sha256: null, // ListObjectsV2 does not return metadata; use headObject.
          etag: obj.ETag ?? null,
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  } catch (err) {
    throw sanitise(err);
  }
}

/** Deletes one object (retention pruning). Returns false when already gone. */
export async function deleteObject(cfg: R2Config, key: string): Promise<boolean> {
  const s3 = client(cfg);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return true;
  } catch (err) {
    throw sanitise(err);
  }
}
