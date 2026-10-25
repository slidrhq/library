/**
 * The published media library (docs/media-library.md): the files the app reads while it runs, as
 * every installed app sees them. These pages read it through `@slidr/media-library`, as the app's
 * own readers do (`./app`): from the published site, which answers any origin; or, on a library
 * installed on a machine, from its own server's `/media/`, which that server names to the page
 * (`__slidrMediaPath`, server/host/node/server.ts; `vite.config.ts`).
 *
 * Every file is read once per visit of the page; reloading the page reads what is published now
 * (the site asks the browser to check every file again).
 */
import { mediaBase, mediaUrl } from '@slidr/media-library';

/** Where this page reads the library: the published site, or its own server's `/media/`. */
export const MEDIA_LIBRARY_URL = mediaBase();

export { mediaUrl };

export interface ManifestFile {
  size: number;
  sha256: string;
}

export interface Manifest {
  version: number;
  published?: string;
  files: Record<string, ManifestFile>;
}

const reads = new Map<string, Promise<unknown>>();

/** A file the library does not have; its manifest, while a library on a machine is not seeded. */
export class NotInLibrary extends Error {}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(mediaUrl(path));
  if (!response.ok) {
    throw response.status === 404
      ? new NotInLibrary(`${path} is not in the library.`)
      : new Error(`${path}: ${response.status}`);
  }
  return response.text();
}

function once<T>(key: string, read: () => Promise<T>): Promise<T> {
  let pending = reads.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = read();
    pending.catch(() => reads.delete(key));
    reads.set(key, pending);
  }
  return pending;
}

/** A JSON file of the library, read once. */
export const mediaJson = <T>(path: string): Promise<T> =>
  once(`json:${path}`, async () => JSON.parse(await fetchText(path)) as T);

/** A text file of the library, read once. */
export const mediaText = (path: string): Promise<string> =>
  once(`text:${path}`, () => fetchText(path));

export const manifest = () => mediaJson<Manifest>('manifest.json');

/** Bytes, as people read them. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
