/**
 * The library's own jobs (docs/SPEC.md §4.7), run once a minute: by a timer of the process on a
 * machine, by a Cron Trigger on Cloudflare.
 *
 * - **The sweep** publishes the approved uploads that wait and are due (`settle.ts`), oldest first.
 * - **Clearing**, once a day, takes away rejected uploads untouched for 30 days, and keeps the
 *   history of the last 100 publications: what each replaced, and what each did.
 */
import { keysUnder, removeUnder, type Bucket } from '../bucket.ts';
import type { Context } from '../context.ts';
import { listUploads, readUpload, removeUpload } from '../uploads/store.ts';
import { HISTORY, PUBLICATIONS, readManifest } from './live.ts';
import { LIBRARY, due, publishNow, type Outcome } from './settle.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a rejected upload is kept. */
export const REJECTED_DAYS = 30;
/** How many publications' history is kept. */
export const PUBLICATIONS_KEPT = 100;
/** When the library was last cleared, in the state store. */
const CLEARED = 'media/cleared.json';

export interface Swept {
  outcome?: Outcome;
  cleared?: { rejected: number; publications: number };
}

/** Clears the library once a day; nothing when it was cleared less than a day ago. */
export async function clear(state: Bucket, now = Date.now()): Promise<Swept['cleared']> {
  const last = await state.get(CLEARED);
  if (last) {
    const { at } = JSON.parse(await last.text()) as { at?: string };
    if (at && now - Date.parse(at) < DAY_MS) return undefined;
  }
  await state.put(CLEARED, JSON.stringify({ at: new Date(now).toISOString() }), {
    httpMetadata: { contentType: 'application/json' },
  });

  let rejected = 0;
  const { uploads } = await listUploads(state, { status: 'rejected' }, Number.MAX_SAFE_INTEGER);
  for (const { id, updated } of uploads) {
    if (now - Date.parse(updated) < REJECTED_DAYS * DAY_MS) continue;
    const found = await readUpload(state, id);
    if (found?.upload.status !== 'rejected') continue;
    await removeUpload(state, found.upload);
    rejected += 1;
  }

  // Each publication by its moment, whether its history or its record is what is left of it.
  const moments = new Set<string>();
  for (const key of await keysUnder(state, `${HISTORY}/`)) {
    moments.add(key.slice(HISTORY.length + 1).split('/')[0]!);
  }
  for (const key of await keysUnder(state, `${PUBLICATIONS}/`)) {
    moments.add(key.slice(PUBLICATIONS.length + 1).replace(/\.json$/, ''));
  }
  const old = [...moments].sort().slice(0, Math.max(0, moments.size - PUBLICATIONS_KEPT));
  for (const moment of old) {
    await removeUnder(state, `${HISTORY}/${moment}/`);
    await state.delete(`${PUBLICATIONS}/${moment}.json`);
  }
  return { rejected, publications: old.length };
}

/** One round of the library's jobs. */
export async function sweep(ctx: Context, now = Date.now()): Promise<Swept> {
  const { media, state } = ctx;
  if (!media || !state) return {};
  const swept: Swept = {};
  if (await readManifest(media)) {
    const ids = await due(state, now);
    if (ids.length > 0) swept.outcome = await publishNow(ctx, LIBRARY, ids, now);
  }
  const cleared = await clear(state, now);
  if (cleared) swept.cleared = cleared;
  return swept;
}
