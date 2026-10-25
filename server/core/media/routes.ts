/**
 * The API of the published library (README, "Publishing the uploads"):
 *
 *   GET  /api/library            where the library is, when it was published, and what waits
 *   POST /api/library/import     brings the site's library into its bucket, a batch at a time
 *   POST /api/publish            writes the accepted uploads into the library
 *   PUT  /api/library/staged/…   a file of an author's publication, by its hash (`files.ts`)
 *   POST /api/library/files      an author's publication: the files changed since the copy was pulled
 *
 * Reading it is anyone's who signs in (`read-own`); publishing what was accepted and waits is a
 * reviewer's (`publish-waiting`); bringing the library in, and an author's files, an admin's
 * (`publish-files`). A program's key does all of these (`../uploads/access.ts`).
 */
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import type { Context } from '../context.ts';
import { isRecord, json, jsonBody, problem } from '../http.ts';
import { authorize } from '../uploads/access.ts';
import { isUploadId, listUploads } from '../uploads/store.ts';
import { forgetLibrary, libraryFor } from '../uploads/library.ts';
import { BATCH, ImportRefused, importLibrary } from './import.ts';
import { MOST_BYTES, Refused, publishFiles, stage } from './files.ts';
import { readManifest } from './live.ts';
import { MOST_UPLOADS, NotNow, publish } from './publish.ts';

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
    // Where installed apps read it: its public address, or this server's own on a machine.
    site:
      ctx.publicUrl ??
      (ctx.local && ctx.media
        ? new URL('/media/', request.url).href
        : (ctx.site ?? MEDIA_LIBRARY_URL)),
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
    if (imported.done) forgetLibrary();
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
      ids.length === 0 ||
      ids.length > MOST_UPLOADS ||
      !ids.every((id) => typeof id === 'string' && isUploadId(id)))
  ) {
    return problem(
      400,
      'bad-request',
      `uploads names the uploads to publish, 1 to ${MOST_UPLOADS} ids; left out, every accepted one.`,
    );
  }
  try {
    return json(
      await publish(
        ctx.media,
        ctx.state,
        libraryFor(ctx),
        actor,
        ids as string[] | undefined,
        ctx.purge,
      ),
    );
  } catch (error) {
    if (error instanceof NotNow) return problem(409, error.code, error.message);
    throw error;
  }
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
