/**
 * What the core of the library is given by the host it runs on (`../host/`): where it keeps its
 * own records, where the published library is, and the host's settings. Nothing in the core reads
 * the host's environment: the Worker on Cloudflare builds this from its bindings and secrets
 * (`../host/cloudflare/index.ts`).
 */
import type { Bucket } from './bucket.ts';
import type { Purger } from './media/cache.ts';
import type { Vault } from './vault.ts';

/** What the library keeps for itself: the uploads and their files (`uploads/store.ts`). */
export type StateStore = Bucket;

/** The published library: its files under their paths, and its manifest (`media/live.ts`). */
export type MediaStore = Bucket;

/** The disk a folder is on: how much it holds, and how much of it is free, in bytes. */
export interface Room {
  size: number;
  free: number;
}

/** Signing in, and who may do what (`auth.ts`, `uploads/access.ts`). */
export interface AuthSettings {
  /** The OAuth client of the Google Cloud project: a client of the "Web application" type. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** The key the cookies are signed with: at least 32 characters. */
  sessionSecret?: string;
  /**
   * The Google accounts that edited the library before it named its own people, by address,
   * separated by commas or spaces: imported once, as reviewers (`settlePeople` of `people.ts`).
   */
  editors?: string;
  /** Who becomes the owner when the library names no one yet: else the first of `editors`. */
  owner?: string;
}

export interface Context {
  /** Without it, the library keeps no uploads. */
  state?: StateStore;
  /** The library's keys, sealed in its state store (`vault.ts`); none on a host that keeps none. */
  vault?: Vault;
  /** Without it, the library is read from its site and nothing is published. */
  media?: MediaStore;
  /**
   * The site the library is read from until it is in its store, and is brought in from: the
   * published library (`MEDIA_LIBRARY_URL` of `@slidr/media-library`) unless the host names another.
   */
  site?: string;
  /** Where installed apps read the published library, when the host names it. */
  publicUrl?: string;
  /** Empties the cache before the published library of what a publication wrote (`media/cache.ts`). */
  purge?: Purger;
  auth: AuthSettings;
  /** The address the request came from, where the host knows it. */
  clientAddress?: string;
  /** Whether the owner signs in by a link of the CLI: a local library (`auth.ts`). */
  local?: boolean;
  /**
   * The folder a local library's media is, as its admins are shown it (`settings.ts`): its path
   * on the machine, which the install named, and the room left on its disk. It is the host's, and
   * is not changed through the library (docs/SPEC.md D13).
   */
  mediaFolder?: { path: string; room(): Promise<Room | undefined> };
}
