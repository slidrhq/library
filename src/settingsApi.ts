/**
 * The library's settings, as its admins see and set them (server/core/settings.ts; docs/SPEC.md
 * §5.3): the address it is reached at and its media, which are its host's and only shown; how
 * people sign in; and the limits of uploading. A key is written and never read back: of each, the
 * page learns only whether it is set.
 */
import { call } from './uploadsApi';

/** Of a key, what may be shown: whether it is set, when, and by whom. */
export interface KeyState {
  set: boolean;
  at?: string;
  by?: string;
}

export type Provider = 'google' | 'microsoft' | 'oidc';

export interface Limits {
  pending: number;
  bytes: number;
  tokens: number;
  writesPerMinute: number;
}

export interface Settings {
  /** Whether this server keeps a provider of the library's own; else it is its host's. */
  editable: { signIn: boolean };
  library: { url: string };
  media: {
    /** A local library's folder; the Worker's bucket; or none yet. */
    kind: 'folder' | 'r2' | 'none';
    /** The folder, as the install named it on the machine. */
    path?: string;
    /** The disk it is on: its size, and what is free of it, in bytes. */
    room?: { size: number; free: number };
    /** Where installed apps read the library. */
    address: string;
  };
  signIn: {
    provider: Provider;
    clientId: string;
    issuer?: string;
    name?: string;
    allowedDomains: string[];
    secret?: KeyState;
    /** The host's own client, which the library does not change. */
    host?: boolean;
  } | null;
  limits: Limits;
  defaults: Limits;
}

/** What reaching the media found (`testStore`). */
export interface StoreTest {
  reached: boolean;
  library?: { published: string; files: number };
  wrote: boolean;
  message?: string;
}

/** What `GET /api/library` says of the media. */
export interface LibraryStatus {
  live: boolean;
  site: string;
  published?: string;
  files?: number;
  bytes?: number;
}

/** A batch of a seed (`POST /api/library/import`). */
export interface Imported {
  files: number;
  present: number;
  copied: number;
  failed: { path: string; message: string }[];
  remaining: number;
  done: boolean;
}

export interface SignInChange {
  provider: Provider;
  clientId: string;
  secret?: string;
  tenant?: string;
  issuer?: string;
  name?: string;
  allowedDomains: string[];
}

const send = <T>(path: string, method: string, body: unknown) =>
  call<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const settingsApi = {
  read: () => call<Settings>('settings'),
  test: () => call<StoreTest>('settings/media/test', { method: 'POST' }),
  signIn: (change: SignInChange) => send<undefined>('settings/sign-in', 'PUT', change),
  noSignIn: () => call<undefined>('settings/sign-in', { method: 'DELETE' }),
  limits: (limits: Partial<Limits>) => send<undefined>('settings/limits', 'PUT', limits),
  status: () => call<LibraryStatus>('library'),
  seed: (from: string) => send<Imported>('library/import', 'POST', { from }),
};

/** The tenant of a Microsoft issuer: `https://login.microsoftonline.com/<tenant>/v2.0`. */
export function tenantOf(issuer: string | undefined) {
  return /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/.exec(issuer ?? '')?.[1];
}
