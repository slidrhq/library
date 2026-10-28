/**
 * An archive of the library, made in this browser from the files it reads (`exportParts.ts` says
 * which): a tar, gzipped unless asked otherwise, of `manifest.json` (the files it holds, with their
 * sizes and SHA-256, as the library names them) and each file at its path. Each file is checked
 * against the manifest as it is read. Another library brings it in (server/core/media/archive.ts:
 * **Settings** → **Import**, or `slidr-library import`); unpacked, it is a copy of the library any
 * web server serves (docs/media-library.md of the app, "A copy").
 *
 * Where the browser writes a file as it is made (Chrome, Edge), the archive goes straight to the
 * file picked; elsewhere it is held until it is whole, and then downloaded.
 *
 * And the other way: what an archive holds, read here before it is sent, and the sending of it.
 */
import { TarError, readTar, tarEnd, tarHeader, tarPadding } from '../server/core/media/tar';
import { mediaUrl, type Manifest, type ManifestFile } from './media';
import { ApiError, type Issue } from './uploadsApi';

export { TarError };

const MANIFEST = 'manifest.json';
/** How many files are read ahead of the one written. */
const AHEAD = 8;
const TRIES = 3;

/** How far an export has come. */
export interface Progress {
  files: number;
  bytes: number;
  ofFiles: number;
  ofBytes: number;
}

/** A file of the library that could not be read as the manifest names it. */
export class ExportFailed extends Error {
  readonly path: string;
  /** Whether the library has another file there now: it was published meanwhile. */
  readonly changed: boolean;

  constructor(path: string, why: string, changed: boolean) {
    super(`${path}: ${why}`);
    this.path = path;
    this.changed = changed;
  }
}

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  // Only a secure page has it: the library is reached over HTTPS, or on this machine.
  if (!crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The manifest of some files, as the library writes its own (`encodeManifest` of live.ts). */
function manifestText(published: string, files: Record<string, ManifestFile>) {
  const sorted = Object.fromEntries(
    Object.keys(files)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((path) => [path, files[path]]),
  );
  return `${JSON.stringify({ version: 1, published, files: sorted }, null, 2)}\n`;
}

/** The library's manifest as it is now, not as the page read it when it opened. */
export async function manifestNow(): Promise<Manifest> {
  const response = await fetch(mediaUrl(MANIFEST), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${MANIFEST}: ${response.status}`);
  return (await response.json()) as Manifest;
}

/** A file of the library, checked against what the manifest says of it; tried again on failing. */
async function fileOf(path: string, file: ManifestFile, signal: AbortSignal): Promise<Uint8Array> {
  let why = '';
  let changed = false;
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await fetch(mediaUrl(path), {
        signal,
        cache: attempt === 0 ? 'default' : 'reload',
      });
      if (!response.ok) {
        why = `${response.status} ${response.statusText}`;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = await sha256Hex(bytes);
      if (bytes.length === file.size && (hash === undefined || hash === file.sha256)) return bytes;
      why = 'not the file the manifest names';
      changed = true;
    } catch (error) {
      if (signal.aborted) throw error;
      why = error instanceof Error ? error.message : String(error);
    }
  }
  throw new ExportFailed(path, why, changed);
}

/**
 * The archive of `paths` of the library of `manifest`, made as it is read: the manifest first, then
 * each file in order, a few read ahead.
 */
export function archiveOf(
  manifest: Manifest,
  paths: readonly string[],
  options: { gzip: boolean; signal: AbortSignal; onProgress: (progress: Progress) => void },
): ReadableStream<Uint8Array> {
  const files: Record<string, ManifestFile> = Object.fromEntries(
    paths.map((path) => [path, manifest.files[path]!]),
  );
  const published = manifest.published ?? '';
  const own = encoder.encode(manifestText(published, files));
  // Each file is dated when the library was published.
  const mtime = Math.floor((Date.parse(published) || Date.now()) / 1000);
  const ofBytes = paths.reduce((sum, path) => sum + files[path]!.size, 0);
  const ahead: { path: string; read: Promise<Uint8Array> }[] = [];
  let next = 0;
  const done = { files: 0, bytes: 0 };
  const readAhead = () => {
    while (ahead.length < AHEAD && next < paths.length) {
      const path = paths[next]!;
      next += 1;
      const read = fileOf(path, files[path]!, options.signal);
      // Read ahead, it may fail before it is waited for: it is said when it is.
      read.catch(() => undefined);
      ahead.push({ path, read });
    }
  };
  let begun = false;
  const tar = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!begun) {
          begun = true;
          readAhead();
          controller.enqueue(tarHeader(MANIFEST, own.length, mtime));
          controller.enqueue(own);
          controller.enqueue(tarPadding(own.length));
          return;
        }
        const first = ahead.shift();
        if (!first) {
          controller.enqueue(tarEnd());
          controller.close();
          return;
        }
        const bytes = await first.read;
        readAhead();
        controller.enqueue(tarHeader(first.path, bytes.length, mtime));
        controller.enqueue(bytes);
        controller.enqueue(tarPadding(bytes.length));
        done.files += 1;
        done.bytes += bytes.length;
        options.onProgress({ ...done, ofFiles: paths.length, ofBytes });
      },
    },
    { highWaterMark: 0 },
  );
  return options.gzip
    ? tar.pipeThrough(
        new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      )
    : tar;
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/**
 * The file the archive is written to, as it is made, picked by the person: where the browser
 * offers that (Chrome, Edge); else none, and it is downloaded once whole. `null` when the person
 * picked none. Asked first, while the page still answers the click.
 */
export async function pickFile(
  name: string,
  gzip: boolean,
  description: string,
): Promise<FileSystemFileHandle | null | undefined> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return undefined;
  try {
    return await picker.call(window, {
      suggestedName: name,
      types: [
        {
          description,
          accept: gzip ? { 'application/gzip': ['.tgz'] } : { 'application/x-tar': ['.tar'] },
        },
      ],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    return undefined;
  }
}

/** Writes the archive to the file picked, as it is made; or downloads it, once whole, as `name`. */
export async function saveArchive(
  archive: ReadableStream<Uint8Array>,
  file: FileSystemFileHandle | undefined,
  name: string,
  signal: AbortSignal,
) {
  if (file) {
    const writable = await file.createWritable();
    await archive.pipeTo(writable, { signal });
    return;
  }
  const blob = await new Response(archive).blob();
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---- Bringing an archive in

/** The manifest an archive holds, read from the file here, before it is sent; none when it has none. */
export async function manifestOfArchive(file: Blob): Promise<Manifest | undefined> {
  for await (const entry of readTar(file.stream())) {
    const path = entry.path.replace(/^(?:\.\/)+/, '');
    if (path !== MANIFEST || entry.type !== 'file') continue;
    try {
      const manifest = JSON.parse(new TextDecoder().decode(entry.bytes)) as Manifest;
      return manifest.files && typeof manifest.files === 'object' ? manifest : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** What the library did with an archive (`POST /api/library/archive`). */
export interface ArchiveImported {
  published?: string;
  from: string;
  files: number;
  bytes: number;
  added: string[];
  changed: string[];
  removed: string[];
  same: number;
  skipped: string[];
}

/**
 * Sends an archive to the library, saying how much of it is sent: once all of it is, the library
 * writes it, and answers.
 */
export function sendArchive(
  file: File,
  onSent: (sent: number, total: number) => void,
): Promise<ArchiveImported> {
  return new Promise((done, fail) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/library/archive');
    request.setRequestHeader(
      'Content-Type',
      /\.tar$/i.test(file.name) ? 'application/x-tar' : 'application/gzip',
    );
    request.upload.onprogress = (event) => onSent(event.loaded, event.total || file.size);
    request.onload = () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {
        fail(new ApiError(request.status, 'no-api', `${request.status} ${request.statusText}`));
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        done(body as unknown as ArchiveImported);
        return;
      }
      fail(
        new ApiError(
          request.status,
          typeof body.error === 'string' ? body.error : 'failed',
          typeof body.message === 'string' ? body.message : String(request.status),
          Array.isArray(body.issues) ? (body.issues as Issue[]) : [],
          body,
        ),
      );
    };
    request.onerror = () => fail(new ApiError(0, 'offline', 'The archive could not be sent.'));
    request.send(file);
  });
}
