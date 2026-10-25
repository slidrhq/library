/**
 * The lease of the media (docs/SPEC.md §4.7): one publication at a time, held in the state store
 * as `media/lock.json`. It is taken, kept and let go only over the version read just before
 * (put-if-match), so two never hold it together.
 *
 * - It stays in the store once made, written as free when let go, so taking it never rests on the
 *   file being absent: a store has no write that only makes a file not there yet. It is made when
 *   the library goes live (`openLease`); a library that went live before it was, makes it the first
 *   time it publishes.
 * - A publication keeps it while it writes, once a minute, and checks it still holds it before it
 *   writes the manifest. One left behind, unkept for ten minutes, is taken over.
 */
import type { Bucket } from '../bucket.ts';
import type { Recorded } from '../uploads/access.ts';
import { LOCK } from './live.ts';

/** How long a lease holds unkept: a publication that stopped keeping it was left behind. */
export const LEASE_MS = 10 * 60 * 1000;
/** How often a publication that is writing keeps its lease. */
const KEEP_MS = 60 * 1000;

const FREE = JSON.stringify({ free: true });
const JSON_TYPE = { httpMetadata: { contentType: 'application/json' } };

/** Why a publication cannot run now. */
export class NotNow extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Makes the lease, free, where there is none yet: when nothing can publish but the one making it. */
export async function openLease(state: Bucket) {
  if (!(await state.get(LOCK))) await state.put(LOCK, FREE, JSON_TYPE);
}

export class Lease {
  private readonly state: Bucket;
  private readonly by: Recorded;
  private etag: string;
  private at: number;

  private constructor(state: Bucket, by: Recorded, etag: string, at: number) {
    this.state = state;
    this.by = by;
    this.etag = etag;
    this.at = at;
  }

  /** Takes the lease for `by`, or says who holds it. */
  static async take(state: Bucket, by: Recorded): Promise<Lease> {
    await openLease(state);
    const held = await state.get(LOCK);
    if (held) {
      const value = JSON.parse(await held.text()) as { by?: string; at?: string; free?: boolean };
      if (!value.free && value.at && Date.now() - Date.parse(value.at) < LEASE_MS) {
        throw new NotNow(
          'publishing',
          `A publication by ${value.by} runs since ${value.at}. Try again once it is done.`,
        );
      }
      const at = Date.now();
      const taken = await state.put(LOCK, Lease.text(by, at), {
        ...JSON_TYPE,
        onlyIf: { etagMatches: held.etag },
      });
      if (taken) return new Lease(state, by, taken.etag, at);
    }
    throw new NotNow('publishing', 'Another publication took the library just now. Try again.');
  }

  private static text = (by: Recorded, at: number) =>
    JSON.stringify({ by: by.id, at: new Date(at).toISOString() });

  /** Keeps the lease while a publication writes: written again once a minute has passed. */
  async keep(): Promise<void> {
    if (Date.now() - this.at < KEEP_MS) return;
    const at = Date.now();
    const kept = await this.state.put(LOCK, Lease.text(this.by, at), {
      ...JSON_TYPE,
      onlyIf: { etagMatches: this.etag },
    });
    if (!kept) throw Lease.lost();
    this.etag = kept.etag;
    this.at = at;
  }

  /** Throws when the lease is no longer this one's. */
  async check(): Promise<void> {
    const held = await this.state.get(LOCK);
    if (!held) throw Lease.lost();
    await held.body.cancel();
    if (held.etag !== this.etag) throw Lease.lost();
  }

  /** Lets the lease go, unless another took it meanwhile. */
  async release(): Promise<void> {
    await this.state.put(LOCK, FREE, { ...JSON_TYPE, onlyIf: { etagMatches: this.etag } });
  }

  private static lost = () =>
    new NotNow('lease-lost', 'Another publication took the library meanwhile. Try again.');
}
