/**
 * What the library uses of a store of objects: a bucket of R2 on Cloudflare, or a folder on a
 * machine (`../host/node/state.ts`). Both its stores are one (`context.ts`): what the library
 * keeps for itself, and the published library.
 */

export interface Bucket {
  get(key: string): Promise<BucketObject | null>;
  /** Writes an object; with `onlyIf.etagMatches`, only over that version of it, else null. */
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
  /** The keys in order, after `startAfter`: up to `limit` of them, and whether more follow. */
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

/** What an object is answered with, where the bucket answers the web itself (`media/live.ts`). */
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

/** Every key under `prefix`, in order. */
export async function keysUnder(bucket: Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, startAfter, limit: 1000 });
    keys.push(...page.objects.map((one) => one.key));
    if (!page.truncated || page.objects.length === 0) return keys;
    startAfter = page.objects.at(-1)!.key;
  }
}

/** Takes away every object under `prefix`. */
export async function removeUnder(bucket: Bucket, prefix: string): Promise<void> {
  const keys = await keysUnder(bucket, prefix);
  for (let at = 0; at < keys.length; at += 1000) await bucket.delete(keys.slice(at, at + 1000));
}
