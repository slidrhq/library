/**
 * The files one publication writes into the media (docs/SPEC.md §9.4), in the order that keeps the
 * library whole:
 *
 * 1. the manifest it starts from, kept under `media/history/<published>/` in the state store;
 * 2. each file it replaces or takes away, kept there too, before it is written over;
 * 3. the new and changed files, each whole (a store without atomic writes renames each into place);
 * 4. the manifest last, only over the one it started from, while it still holds the lease.
 *
 * Until the manifest is written, the library is the old one. A publication that fails before then
 * puts the media back as it was (`undo`): each file it replaced, from the history, and each it
 * added, taken away; and the history of what did not happen is not kept.
 */
import { removeUnder, type Bucket } from '../bucket.ts';
import type { Lease } from './lease.ts';
import { NotNow } from './lease.ts';
import {
  HISTORY,
  MANIFEST,
  encodeManifest,
  putFile,
  putManifest,
  sha256Hex,
  type Manifest,
} from './live.ts';

export class Writing {
  readonly published: string;
  readonly added: string[] = [];
  readonly changed: string[] = [];
  readonly removed: string[] = [];
  private readonly media: Bucket;
  private readonly state: Bucket;
  private readonly lease: Lease;
  private readonly manifest: Manifest;
  private readonly etag: string;
  private readonly files: Manifest['files'];
  /** The files replaced or taken away whose bytes the history holds. */
  private readonly kept = new Set<string>();
  private begun = false;

  constructor(
    media: Bucket,
    state: Bucket,
    lease: Lease,
    live: { manifest: Manifest; etag: string },
    published = new Date().toISOString(),
  ) {
    this.media = media;
    this.state = state;
    this.lease = lease;
    this.manifest = live.manifest;
    this.etag = live.etag;
    this.files = { ...live.manifest.files };
    this.published = published;
  }

  private get history() {
    return `${HISTORY}/${this.published}`;
  }

  private async begin() {
    if (this.begun) return;
    this.begun = true;
    await this.state.put(`${this.history}/${MANIFEST}`, encodeManifest(this.manifest), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  /** Keeps a file of the library in the history before it is written over or taken away. */
  private async keep(path: string) {
    const old = await this.media.get(path);
    if (!old) return;
    await this.state.put(`${this.history}/${path}`, await old.arrayBuffer());
    this.kept.add(path);
  }

  /** Writes a file; one with the bytes the library has already is left as it is. */
  async put(path: string, bytes: Uint8Array, sha256?: string): Promise<boolean> {
    const hash = sha256 ?? (await sha256Hex(bytes));
    const before = this.files[path];
    if (before?.sha256 === hash) return false;
    await this.begin();
    await this.lease.keep();
    if (before) {
      if (!this.changed.includes(path)) {
        await this.keep(path);
        this.changed.push(path);
      }
    } else if (!this.added.includes(path)) this.added.push(path);
    await putFile(this.media, path, bytes, hash);
    this.files[path] = { size: bytes.length, sha256: hash };
    return true;
  }

  /** Takes a file of the library away. */
  async remove(path: string): Promise<void> {
    if (!this.files[path]) return;
    await this.begin();
    await this.lease.keep();
    await this.keep(path);
    await this.media.delete(path);
    delete this.files[path];
    this.removed.push(path);
  }

  /** Whether anything was written. */
  get written() {
    return this.added.length + this.changed.length + this.removed.length > 0;
  }

  /** Writes the manifest, over the one the publication started from: the library is then this. */
  async finish(): Promise<void> {
    await this.lease.check();
    const written = await putManifest(
      this.media,
      encodeManifest({ version: 1, published: this.published, files: this.files }),
      this.etag,
    );
    if (!written) {
      throw new NotNow('changed-meanwhile', 'The library was published meanwhile. Try again.');
    }
    this.added.sort();
    this.changed.sort();
    this.removed.sort();
  }

  /** Puts the media back as it was before the publication, and forgets its history. */
  async undo(): Promise<void> {
    for (const path of this.added) await this.media.delete(path);
    for (const path of [...this.changed, ...this.removed]) {
      const before = this.manifest.files[path];
      const old = this.kept.has(path) ? await this.state.get(`${this.history}/${path}`) : null;
      if (before && old) {
        await putFile(this.media, path, new Uint8Array(await old.arrayBuffer()), before.sha256);
      } else {
        // It was not there to keep: as it was, it is not there.
        await this.media.delete(path);
      }
    }
    if (this.begun) await removeUnder(this.state, `${this.history}/`);
  }
}
