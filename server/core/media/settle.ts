/**
 * Publishing approved uploads, and what becomes of each that is not written (docs/SPEC.md §8):
 *
 * - one that no longer holds against the library goes back to pending, with a note that says why,
 *   for its uploader to put right;
 * - one that cannot be written now (a `PublishError`, the store out of reach) stays accepted and
 *   waits: the sweep tries it again after 1, 5 and 30 minutes, and then it waits for **Try again**;
 * - while another publication holds the library, it waits for the sweep's next round, and that try
 *   does not count.
 *
 * Approving publishes the upload at once (`api.ts`); the sweep (`sweep.ts`) and **Try again**
 * (`POST /api/publish`) publish those that wait.
 */
import type { Bucket } from '../bucket.ts';
import type { Context } from '../context.ts';
import type { Issue } from '../http.ts';
import { recordOf, type Actor, type Recorded } from '../uploads/access.ts';
import { libraryFor } from '../uploads/library.ts';
import { listUploads, readUpload, saveUpload, type Upload } from '../uploads/store.ts';
import { NotNow } from './lease.ts';
import { MOST_UPLOADS, publish, type Publication } from './publish.ts';

/** The waits before each try again, in minutes; after the last, a try is made by hand. */
export const WAITS = [1, 5, 30];

/** The library itself, when it publishes on its own (the sweep). */
export const LIBRARY: Actor = { id: 'library', name: 'Slidr Library', via: 'job' };

/** What came of publishing: what the publication did, or why none could run. */
export interface Outcome {
  publication?: Publication;
  failed?: { code: string; message: string };
}

/** The longest note an upload keeps. */
const NOTE_MOST = 1000;

/** Changes an upload while it is accepted, made again on what it is now if it changed meanwhile. */
async function whileAccepted(state: Bucket, id: string, edit: (upload: Upload) => void) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await readUpload(state, id);
    if (!found || found.upload.status !== 'accepted') return;
    edit(found.upload);
    if (await saveUpload(state, found.upload, found.etag)) return;
  }
}

/** It waits again, saying why: a try that failed counts, a library held by another does not. */
const waits = (message: string, counted: boolean, now: number) => (upload: Upload) => {
  const attempts = (upload.publication?.attempts ?? 0) + (counted ? 1 : 0);
  const wait = counted ? WAITS[attempts - 1] : 0;
  upload.publication = {
    message,
    at: new Date(now).toISOString(),
    attempts,
    ...(wait === undefined ? {} : { next: new Date(now + wait * 60_000).toISOString() }),
  };
};

/** Why an upload no longer holds, as its note says it. */
const noteOf = (message: string, issues: Issue[] = []) =>
  [message, ...issues.map((issue) => `${issue.path}: ${issue.message}`)]
    .join(' ')
    .slice(0, NOTE_MOST);

/** Back to pending, for its uploader to put right. */
const sendBack = (note: string, by: Recorded, now: number) => (upload: Upload) => {
  const at = new Date(now).toISOString();
  upload.status = 'pending';
  upload.updated = at;
  upload.note = note;
  delete upload.publication;
  upload.history.push({ status: 'pending', at, by, note });
};

/**
 * Publishes the uploads named, as `actor`, and settles each that is not written. A publication
 * that cannot run, or fails, leaves them waiting, and says why: it does not throw.
 */
export async function publishNow(
  ctx: Context,
  actor: Actor,
  ids: string[],
  now = Date.now(),
): Promise<Outcome> {
  const { media, state } = ctx;
  if (!media || !state) {
    return { failed: { code: 'no-bucket', message: 'This server keeps no media.' } };
  }
  try {
    const publication = await publish(media, state, libraryFor(ctx), actor, ids, ctx.purge);
    for (const skipped of publication.skipped) {
      if (skipped.reason === 'invalid') {
        const note = noteOf(skipped.message, skipped.issues);
        await whileAccepted(state, skipped.id, sendBack(note, recordOf(actor), now));
      } else if (skipped.reason === 'unwritable') {
        await whileAccepted(state, skipped.id, waits(skipped.message, true, now));
      }
    }
    return { publication };
  } catch (error) {
    const known = error instanceof NotNow;
    const failed = known
      ? { code: error.code, message: error.message }
      : { code: 'not-written', message: error instanceof Error ? error.message : String(error) };
    if (!known) console.error(`A publication failed: ${failed.message}`);
    // Only a try that failed counts: one that found the library busy is tried in a minute.
    for (const id of ids) await whileAccepted(state, id, waits(failed.message, !known, now));
    return { failed };
  }
}

/** The accepted uploads due to be written now, oldest first: the most one publication takes. */
export async function due(state: Bucket, now = Date.now()): Promise<string[]> {
  const { uploads } = await listUploads(state, { status: 'accepted' }, Number.MAX_SAFE_INTEGER);
  const found: string[] = [];
  for (const { id } of uploads.reverse()) {
    const upload = (await readUpload(state, id))?.upload;
    if (upload?.status !== 'accepted') continue;
    const waiting = upload.publication;
    if (waiting && (!waiting.next || Date.parse(waiting.next) > now)) continue;
    found.push(id);
    if (found.length === MOST_UPLOADS) break;
  }
  return found;
}
