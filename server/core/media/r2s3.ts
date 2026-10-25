/**
 * The published library in a Cloudflare R2 bucket reached from a machine (docs/SPEC.md §4.5, P8):
 * through R2's S3 API, each request signed with SigV4 (`aws4fetch`, which needs nothing of Node).
 * On Cloudflare the Worker has the bucket itself (`MEDIA`); a library on a machine has this. Apps
 * read the bucket at its own domain, through Cloudflare's cache, which a publication empties of
 * what it wrote (`cache.ts`).
 *
 * - A file is written whole by `PutObject`, with what it is served as, and its SHA-256 in
 *   `x-amz-meta-sha256`.
 * - The manifest is written over a version only while it is that version: the bucket is asked
 *   (`If-Match`), and its version is read just before as well, should the bucket not honour it.
 * - A list names each file's SHA-256 as its own metadata says it: read once for each version of a
 *   file (its ETag), and remembered.
 * - Only paths of the library are read or written.
 */
import { AwsClient } from 'aws4fetch';
import type { Bucket, BucketObject } from '../bucket.ts';
import { MANIFEST, PROBE, encodedPath, isLibraryPath } from './live.ts';

export interface R2Settings {
  /** The Cloudflare account the bucket is in. */
  accountId: string;
  bucket: string;
}

/** An R2 API token's S3 credentials, limited to reading and writing that one bucket. */
export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const isKey = (key: string) => key === MANIFEST || key === PROBE || isLibraryPath(key);

const bytesOf = (value: string | ArrayBuffer | Uint8Array) =>
  typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);

/** An ETag without its quotes. */
const unquoted = (etag: string | null) => (etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');

const unescapeXml = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/** The bucket answered something else than it was asked for. */
export class R2Error extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Why the bucket refused, in its own words when it gave some. */
async function refusal(response: Response, what: string) {
  const text = await response.text().catch(() => '');
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  return new R2Error(
    response.status,
    `${what}: ${response.status}${code ? ` ${code}` : ''}${message ? `, ${unescapeXml(message)}` : ''}`,
  );
}

export class R2S3Media implements Bucket {
  private readonly client: AwsClient;
  private readonly base: string;
  /** Each file's SHA-256, by the version of it the bucket names (its ETag). */
  private readonly hashes = new Map<string, { etag: string; sha256: string }>();

  constructor(settings: R2Settings, credentials: R2Credentials, endpoint?: string) {
    this.client = new AwsClient({
      ...credentials,
      service: 's3',
      region: 'auto',
      retries: 3,
    });
    const host = (endpoint ?? `https://${settings.accountId}.r2.cloudflarestorage.com`).replace(
      /\/$/,
      '',
    );
    this.base = `${host}/${encodeURIComponent(settings.bucket)}`;
  }

  private url = (key: string) => `${this.base}/${encodedPath(key)}`;

  async get(key: string): Promise<BucketObject | null> {
    if (!isKey(key)) return null;
    const response = await this.client.fetch(this.url(key));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw await refusal(response, `Reading ${key}`);
    const data = new Uint8Array(await response.arrayBuffer());
    const etag = unquoted(response.headers.get('ETag'));
    const sha256 = response.headers.get('x-amz-meta-sha256') ?? undefined;
    if (sha256) this.hashes.set(key, { etag, sha256 });
    const contentType = response.headers.get('Content-Type');
    const cacheControl = response.headers.get('Cache-Control');
    return {
      etag,
      size: data.length,
      body: new Blob([data]).stream(),
      httpMetadata: {
        ...(contentType ? { contentType } : {}),
        ...(cacheControl ? { cacheControl } : {}),
      },
      ...(sha256 ? { customMetadata: { sha256 } } : {}),
      text: () => Promise.resolve(new TextDecoder().decode(data)),
      arrayBuffer: () => Promise.resolve(data.slice().buffer),
    };
  }

  /** The version of a file the bucket has now, and its hash; none when it has none. */
  private async headOf(key: string) {
    const response = await this.client.fetch(this.url(key), { method: 'HEAD' });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new R2Error(response.status, `Reading ${key}: ${response.status}`);
    return {
      etag: unquoted(response.headers.get('ETag')),
      sha256: response.headers.get('x-amz-meta-sha256') ?? undefined,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: Parameters<Bucket['put']>[2] = {},
  ): Promise<{ etag: string } | null> {
    if (!isKey(key)) throw new Error(`Not a path of the library: ${JSON.stringify(key)}`);
    const wanted = options.onlyIf?.etagMatches;
    if (wanted !== undefined && (await this.headOf(key))?.etag !== wanted) return null;
    const data = bytesOf(value);
    const headers = new Headers();
    const { contentType, cacheControl } = options.httpMetadata ?? {};
    if (contentType) headers.set('Content-Type', contentType);
    if (cacheControl) headers.set('Cache-Control', cacheControl);
    for (const [name, meta] of Object.entries(options.customMetadata ?? {})) {
      headers.set(`x-amz-meta-${name}`, meta);
    }
    if (wanted !== undefined) headers.set('If-Match', `"${wanted}"`);
    const response = await this.client.fetch(this.url(key), {
      method: 'PUT',
      headers,
      body: data as Uint8Array<ArrayBuffer>,
    });
    if (response.status === 412) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw await refusal(response, `Writing ${key}`);
    await response.body?.cancel();
    const etag = unquoted(response.headers.get('ETag'));
    const sha256 = options.customMetadata?.sha256;
    if (sha256) this.hashes.set(key, { etag, sha256 });
    return { etag };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!isKey(key)) continue;
      const response = await this.client.fetch(this.url(key), { method: 'DELETE' });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) {
        throw new R2Error(response.status, `Taking away ${key}: ${response.status}`);
      }
      this.hashes.delete(key);
    }
  }

  async list(options: Parameters<Bucket['list']>[0] = {}) {
    const limit = Math.min(options.limit ?? 1000, 1000);
    const query = new URLSearchParams({ 'list-type': '2', 'max-keys': String(limit) });
    if (options.prefix) query.set('prefix', options.prefix);
    if (options.startAfter) query.set('start-after', options.startAfter);
    const response = await this.client.fetch(`${this.base}?${query}`);
    if (!response.ok) throw await refusal(response, 'Listing the bucket');
    const xml = await response.text();
    const listed = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, one]) => ({
      key: unescapeXml(/<Key>([^<]*)<\/Key>/.exec(one!)?.[1] ?? ''),
      etag: unquoted(unescapeXml(/<ETag>([^<]*)<\/ETag>/.exec(one!)?.[1] ?? '')),
    }));
    const include = options.include ?? [];
    const objects = [];
    for (const { key, etag } of listed.filter((one) => isKey(one.key) && one.key !== PROBE)) {
      let sha256: string | undefined;
      if (include.includes('customMetadata')) {
        const held = this.hashes.get(key);
        // Read once for each version of a file: its metadata says its hash.
        if (held?.etag === etag) sha256 = held.sha256;
        else {
          const head = await this.headOf(key);
          sha256 = head?.sha256;
          if (head?.sha256) this.hashes.set(key, { etag: head.etag, sha256: head.sha256 });
        }
      }
      objects.push({ key, ...(sha256 ? { customMetadata: { sha256 } } : {}) });
    }
    return { objects, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml) };
  }
}
