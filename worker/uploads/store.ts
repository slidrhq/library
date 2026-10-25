/**
 * Where uploads are kept until they are published: a bucket of R2 (`UPLOADS`, `wrangler.jsonc`).
 *
 *   uploads/<id>.json      the upload: what it holds, its status and its history
 *   files/<id>/<name>      each of its files
 *   media/…                the published library's own records, which its bucket does not
 *                          publish (`../media/live.ts`)
 *
 * An upload's summary (type, status, languages…) is also kept in the metadata of its record, so
 * the uploads are listed without reading each one. Ids sort newest first.
 */
import type { ContentLanguage } from '@slidr/model';
import type { Actor } from './access.ts';
import type { Draft, StoredFile } from './handler.ts';

/** What the Worker uses of a bucket of R2. */
export interface Bucket {
  get(key: string): Promise<BucketObject | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: HttpMetadata;
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string };
    },
  ): Promise<{ etag: string } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    startAfter?: string;
    limit?: number;
    include?: ('customMetadata' | 'httpMetadata')[];
  }): Promise<{
    objects: {
      key: string;
      httpMetadata?: HttpMetadata;
      customMetadata?: Record<string, string>;
    }[];
    truncated: boolean;
  }>;
}

/** What an object is answered with, where the bucket answers the web itself (`../media/live.ts`). */
export interface HttpMetadata {
  contentType?: string;
  cacheControl?: string;
}

export interface BucketObject {
  etag: string;
  size: number;
  body: ReadableStream;
  httpMetadata?: HttpMetadata;
  customMetadata?: Record<string, string>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Where an upload is. It waits (`pending`) while it is written, in more languages too; an
 * editor accepts it or rejects it; an accepted upload is `published` once the library has it.
 */
export const STATUSES = ['pending', 'accepted', 'rejected', 'published'] as const;
export type Status = (typeof STATUSES)[number];

export interface Upload extends Draft {
  id: string;
  status: Status;
  /** What the last change of status said: why it was rejected. */
  note?: string;
  created: string;
  updated: string;
  by: Actor;
  history: { status: Status; at: string; by: Actor; note?: string }[];
}

/** What a listing says of each upload. */
export interface Summary {
  id: string;
  type: string;
  action: string;
  target: string;
  status: Status;
  languages: ContentLanguage[];
  created: string;
  updated: string;
  by: string;
}

/** The last moment a date can name, so that ids made later sort first. */
const LAST_MS = 8_640_000_000_000_000;
const ID = /^u-[0-9a-z]{11}-[0-9a-z]{8}$/;

export function newUploadId(now = Date.now()): string {
  const order = (LAST_MS - now).toString(36).padStart(11, '0');
  const random = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => (byte % 36).toString(36))
    .join('');
  return `u-${order}-${random}`;
}

export const isUploadId = (id: string) => ID.test(id);

const recordKey = (id: string) => `uploads/${id}.json`;
const fileKey = (id: string, name: string) => `files/${id}/${name}`;

function summaryOf(upload: Upload): Record<string, string> {
  return {
    type: upload.type,
    action: upload.action,
    target: upload.target,
    status: upload.status,
    languages: Object.keys(upload.languages).join(','),
    created: upload.created,
    updated: upload.updated,
    by: upload.by.id,
  };
}

export async function readUpload(
  bucket: Bucket,
  id: string,
): Promise<{ upload: Upload; etag: string } | undefined> {
  if (!isUploadId(id)) return undefined;
  const object = await bucket.get(recordKey(id));
  if (!object) return undefined;
  return { upload: JSON.parse(await object.text()) as Upload, etag: object.etag };
}

/** Keeps a new upload: its files first, so a record never names a file that is not there. */
export async function createUpload(
  bucket: Bucket,
  upload: Upload,
  bytes: ReadonlyMap<string, Uint8Array>,
) {
  for (const [name, file] of bytes) {
    const stored = upload.files[name] as StoredFile;
    await bucket.put(fileKey(upload.id, name), file, {
      httpMetadata: { contentType: stored.type },
    });
  }
  await bucket.put(recordKey(upload.id), JSON.stringify(upload), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: summaryOf(upload),
  });
}

/**
 * Writes an upload over the one read as `etag`. False when it was changed meanwhile: the change
 * is made again on what it is now.
 */
export async function saveUpload(bucket: Bucket, upload: Upload, etag: string): Promise<boolean> {
  const written = await bucket.put(recordKey(upload.id), JSON.stringify(upload), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: summaryOf(upload),
    onlyIf: { etagMatches: etag },
  });
  return written !== null;
}

export async function removeUpload(bucket: Bucket, upload: Upload) {
  await bucket.delete(recordKey(upload.id));
  const files = Object.keys(upload.files).map((name) => fileKey(upload.id, name));
  if (files.length > 0) await bucket.delete(files);
}

export const readFile = (bucket: Bucket, id: string, name: string) => bucket.get(fileKey(id, name));

export interface Filter {
  type?: string;
  action?: string;
  status?: string;
  target?: string;
  language?: string;
}

/**
 * The uploads that match, newest first: up to `limit` of them, after the upload `after` (the
 * last of the page before).
 */
export async function listUploads(
  bucket: Bucket,
  filter: Filter,
  limit: number,
  after?: string,
): Promise<{ uploads: Summary[]; next?: string }> {
  const found: Summary[] = [];
  let startAfter = after && isUploadId(after) ? recordKey(after) : undefined;
  for (;;) {
    const page = await bucket.list({
      prefix: 'uploads/',
      startAfter,
      limit: 1000,
      include: ['customMetadata'],
    });
    for (const object of page.objects) {
      const meta = object.customMetadata ?? {};
      const languages = (meta.languages ?? '').split(',').filter(Boolean) as ContentLanguage[];
      const matches =
        (!filter.type || meta.type === filter.type) &&
        (!filter.action || meta.action === filter.action) &&
        (!filter.status || meta.status === filter.status) &&
        (!filter.target || meta.target === filter.target) &&
        (!filter.language || languages.includes(filter.language as ContentLanguage));
      if (!matches) continue;
      found.push({
        id: object.key.slice('uploads/'.length, -'.json'.length),
        type: meta.type ?? '',
        action: meta.action ?? '',
        target: meta.target ?? '',
        status: (meta.status ?? 'pending') as Status,
        languages,
        created: meta.created ?? '',
        updated: meta.updated ?? '',
        by: meta.by ?? '',
      });
      if (found.length === limit) {
        const more = object !== page.objects.at(-1) || page.truncated;
        return more ? { uploads: found, next: found.at(-1)!.id } : { uploads: found };
      }
    }
    if (!page.truncated || page.objects.length === 0) return { uploads: found };
    startAfter = page.objects.at(-1)!.key;
  }
}
