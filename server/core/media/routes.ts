/**
 * The API of the published library (README, "Publishing the uploads"):
 *
 *   GET  /api/library            where the library is, when it was published, and what waits
 *   POST /api/library/import     brings the site's library into its bucket, a batch at a time
 *   POST /api/publish            writes the accepted uploads into the library; with none named,
 *                                only what is made of the catalogs of the designs (`designFiles.ts`)
 *   PUT  /api/library/staged/…   a file of an author's publication, by its hash (`files.ts`)
 *   POST /api/library/files      an author's publication: the files changed since the copy was pulled
 *   POST /api/library/archive    an archive of the library brought in: a .tar or .tgz (`archive.ts`)
 *
 * Reading it is anyone's who signs in (`read-own`); publishing what was accepted and waits is a
 * reviewer's (`publish-waiting`); bringing the library in, an archive, and an author's files, an
 * admin's (`publish-files`). A program's key does all of these (`../uploads/access.ts`).
 */
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import { keysUnder, type Bucket } from '../bucket.ts';
import type { Context } from '../context.ts';
import { isRecord, json, jsonBody, problem } from '../http.ts';
import { authorize } from '../uploads/access.ts';
import { isUploadId, listUploads } from '../uploads/store.ts';
import { forgetLibrary } from '../uploads/library.ts';
import { ArchiveRefused, MOST_ARCHIVE, importArchive } from './archive.ts';
import { BATCH, ImportRefused, importLibrary } from './import.ts';
import { MOST_BYTES, Refused, publishFiles, stage } from './files.ts';
import { PUBLICATIONS, readManifest } from './live.ts';
import { openLease } from './lease.ts';
import { MOST_UPLOADS, NotNow, chosen } from './publish.ts';
import { publishNow } from './settle.ts';

type Route = (request: Request, ctx: Context) => Promise<Response>;

const noBucket = (name: string) =>
  problem(503, 'not-set-up', `This server has no bucket for ${name}.`);

/** Whether the library is served from its bucket. */
export async function isLive(ctx: Context): Promise<boolean> {
  if (!ctx.media) return false;
  const object = await ctx.media.get('manifest.json');
  if (!object) return false;
  await object.body.cancel();
  return true;
}

/** A JSON body that may be left out. */
async function optionalBody(request: Request): Promise<Record<string, unknown> | Response> {
  const length = request.headers.get('Content-Length');
  if (!request.headers.get('Content-Type') && (length === null || length === '0')) return {};
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  if (!isRecord(body)) return problem(400, 'bad-json', 'The body is a JSON object.');
  return body;
}

/**
 * Where installed apps read the library: its public address, or this server's own `/media/` on a
 * machine (at `base`, the library's address, when it has one), or the site it is published to.
 */
export const siteOf = (request: Request, ctx: Context, base = request.url) =>
  ctx.publicUrl ??
  (ctx.local && ctx.media ? new URL('/media/', base).href : (ctx.site ?? MEDIA_LIBRARY_URL));

// ---- GET /api/library

export const libraryStatus: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'read-own');
  if (actor instanceof Response) return actor;
  const live = ctx.media ? await readManifest(ctx.media) : undefined;
  const accepted = ctx.state
    ? (await listUploads(ctx.state, { status: 'accepted' }, 1000)).uploads.length
    : 0;
  const files = live ? Object.values(live.manifest.files) : [];
  return json({
    live: live !== undefined,
    site: siteOf(request, ctx),
    ...(live
      ? {
          published: live.manifest.published,
          files: files.length,
          bytes: files.reduce((sum, file) => sum + file.size, 0),
        }
      : {}),
    accepted,
  });
};

// ---- POST /api/library/import

export const importRoute: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'publish-files');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return noBucket('the library (MEDIA)');
  const body = await optionalBody(request);
  if (body instanceof Response) return body;
  const from = body.from ?? ctx.site ?? MEDIA_LIBRARY_URL;
  const limit = body.limit ?? BATCH;
  if (typeof from !== 'string' || !/^https?:\/\//.test(from)) {
    return problem(400, 'bad-request', 'from is the address of the site the library is read from.');
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    return problem(400, 'bad-request', 'limit is how many files to copy, a whole number.');
  }
  try {
    const imported = await importLibrary(ctx.media, from, limit);
    if (imported.done) {
      forgetLibrary();
      // Live from now on: the lease publications take is made while none can run.
      if (ctx.state) await openLease(ctx.state);
    }
    return json(imported);
  } catch (error) {
    if (error instanceof ImportRefused) {
      return problem(error.code === 'live' ? 409 : 502, error.code, error.message);
    }
    throw error;
  }
};

// ---- POST /api/publish

export const publishRoute: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'publish-waiting');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return noBucket('the library (MEDIA)');
  if (!ctx.state) return noBucket('the uploads (UPLOADS)');
  const body = await optionalBody(request);
  if (body instanceof Response) return body;
  const ids = body.uploads;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      ids.length > MOST_UPLOADS ||
      !ids.every((id) => typeof id === 'string' && isUploadId(id)))
  ) {
    return problem(
      400,
      'bad-request',
      `uploads names the uploads to publish, up to ${MOST_UPLOADS} ids, or none; left out, every accepted one.`,
    );
  }
  if (!(await readManifest(ctx.media))) {
    return problem(
      409,
      'not-live',
      'The library is not in its bucket yet: bring it in first (POST /api/library/import).',
    );
  }
  // Those named (Try again), or every accepted one; each not written is settled (`settle.ts`).
  // None named writes only what is made of the catalogs of the designs, where it is of another
  // library (Slidr Studio asks it before it draws the pictures of the designs).
  const picked = await chosen(ctx.state, ids as string[] | undefined);
  const { publication, failed } = await publishNow(ctx, actor, picked.ids);
  if (publication) return json({ ...publication, remaining: picked.remaining });
  const { code, message } = failed!;
  return problem(code === 'not-written' ? 502 : 409, code, message);
};

// ---- GET /api/publications, GET /api/publications/{published}

/** A publication's moment, as it is kept under. */
export const MOMENT = String.raw`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)`;

const recordAt = async (state: Bucket, moment: string): Promise<unknown> => {
  const object = await state.get(`${PUBLICATIONS}/${moment}.json`);
  return object ? (JSON.parse(await object.text()) as unknown) : undefined;
};

/** What each publication did, newest first, a page at a time: those before `before`. */
export const publicationsRoute: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'read-all');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return noBucket('the uploads (UPLOADS)');
  const state = ctx.state;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
  const before = url.searchParams.get('before');
  const moments = (await keysUnder(state, `${PUBLICATIONS}/`))
    .map((key) => key.slice(PUBLICATIONS.length + 1).replace(/\.json$/, ''))
    .filter((moment) => !before || moment < before)
    .sort()
    .reverse();
  const page = moments.slice(0, limit);
  const publications = (await Promise.all(page.map((moment) => recordAt(state, moment)))).filter(
    Boolean,
  );
  return json({ publications, ...(moments.length > limit ? { next: page.at(-1) } : {}) });
};

export const publicationRoute = async (request: Request, ctx: Context, [moment]: string[]) => {
  const actor = await authorize(request, ctx, 'read-all');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return noBucket('the uploads (UPLOADS)');
  const record = await recordAt(ctx.state, moment ?? '');
  return record ? json(record) : problem(404, 'not-found', `No publication was made at ${moment}.`);
};

// ---- PUT /api/library/staged/{sha256}

export const stageRoute = async (request: Request, ctx: Context, [sha256]: string[]) => {
  const actor = await authorize(request, ctx, 'publish-files');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return noBucket('the library (MEDIA)');
  if (!ctx.state) return noBucket('the uploads (UPLOADS)');
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > MOST_BYTES) {
    return problem(413, 'too-large', `A file is at most ${MOST_BYTES / 1024 / 1024} MiB.`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  try {
    return json(await stage(ctx.state, sha256 ?? '', bytes));
  } catch (error) {
    if (error instanceof Refused) return problem(400, error.code, error.message);
    throw error;
  }
};

// ---- POST /api/library/files

export const filesRoute: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'publish-files');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return noBucket('the library (MEDIA)');
  if (!ctx.state) return noBucket('the uploads (UPLOADS)');
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  try {
    return json(
      await publishFiles(
        ctx.media,
        ctx.state,
        actor,
        isRecord(body) ? body.files : undefined,
        ctx.purge,
      ),
    );
  } catch (error) {
    if (error instanceof Refused) {
      const status = error.code === 'conflict' ? 409 : error.code === 'not-staged' ? 422 : 400;
      return problem(
        status,
        error.code,
        error.message,
        error.paths.map((path) => ({ path, message: error.message })),
      );
    }
    if (error instanceof NotNow) return problem(409, error.code, error.message);
    throw error;
  }
};

// ---- POST /api/library/archive

/** What each refusal of an archive is answered with. */
const REFUSED: Record<string, number> = { 'no-room': 507, 'not-set-up': 503 };

export const archiveRoute: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'publish-files');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return noBucket('the library (MEDIA)');
  if (!ctx.state) return noBucket('the uploads (UPLOADS)');
  if (Number(request.headers.get('Content-Length') ?? 0) > MOST_ARCHIVE) {
    return problem(413, 'too-large', `An archive is at most ${MOST_ARCHIVE / 1024 ** 3} GiB.`);
  }
  if (!request.body) {
    return problem(400, 'bad-request', 'Send the archive as the body: a .tar or .tgz file.');
  }
  try {
    return json(await importArchive(ctx, actor, request.body));
  } catch (error) {
    if (error instanceof ArchiveRefused) {
      return problem(
        REFUSED[error.code] ?? 422,
        error.code,
        error.message,
        error.paths.map((path) => ({ path, message: error.message })),
      );
    }
    if (error instanceof NotNow) return problem(409, error.code, error.message);
    throw error;
  }
};
