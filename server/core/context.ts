/**
 * What the core of the library is given by the host it runs on (`../host/`): where it keeps its
 * own records, where the published library is, and the host's settings. Nothing in the core reads
 * the host's environment: the Worker on Cloudflare builds this from its bindings and secrets
 * (`../host/cloudflare/index.ts`).
 */
import type { Bucket } from './bucket.ts';
import type { MediaSettings } from './config.ts';
import type { Purger } from './media/cache.ts';
import type { Vault } from './vault.ts';

/** What the library keeps for itself: the uploads and their files (`uploads/store.ts`). */
export type StateStore = Bucket;

/** The published library: its files under their paths, and its manifest (`media/live.ts`). */
export type MediaStore = Bucket;

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
  /**
   * The programs that may upload, each with its key: `<name>=<key>`, separated by commas, as
   * `studio=…, ci=…`. A key is at least 32 characters; a program sends it as
   * `Authorization: Bearer <key>`.
   */
  keys?: string;
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
  /** Whether the owner signs in by a link of the CLI: a library on a machine (`auth.ts`). */
  local?: boolean;
  /** What of the library's settings the host lets an admin change (`settings.ts`). */
  editable?: { url?: boolean; media?: boolean };
  /** Opens the media store of some settings, to try them before they are kept (`settings.ts`). */
  openMedia?: (settings: MediaSettings) => MediaStore;
}
