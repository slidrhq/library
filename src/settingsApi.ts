/**
 * The library's settings, as its admins set them (server/core/settings.ts; docs/SPEC.md §5.3): the
 * address it is reached at, its media, how people sign in, and the limits of uploading. A key is
 * written and never read back: of each, the page learns only whether it is set.
 */
import { ApiError, call } from './uploadsApi';

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
  /** What this server lets the library change; the rest is its host's. */
  editable: { url: boolean; media: boolean; signIn: boolean };
  library: { url: string };
  media: Partial<Omit<MediaSettings, 'kind'>> & {
    kind: MediaSettings['kind'] | 'r2' | 'none';
    key: KeyState;
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

/** A media store's settings, as the library keeps them (server/core/config.ts). */
export interface MediaSettings {
  kind: 'folder' | 'sftp' | 'ftp';
  /** A folder of this machine. */
  path?: string;
  /** A server's. */
  host?: string;
  port?: number;
  user?: string;
  root?: string;
  /** An SSH server's host key, confirmed: `SHA256:…`. */
  hostKey?: string;
  tls?: 'explicit' | 'implicit' | 'none';
  allowUnencrypted?: boolean;
  publicUrl?: string;
}

/** A store's key, sent with its settings, never read back. */
export interface MediaKey {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

/** A server's host key that is not the one confirmed: never confirmed, or changed. */
export interface HostKeyToConfirm {
  code: 'host-key-unconfirmed' | 'host-key-changed';
  fingerprint: string;
}

/** What reaching a media store found (`testStore`). */
export interface StoreTest {
  reached: boolean;
  library?: { published: string; files: number };
  wrote: boolean;
  message?: string;
  hostKey?: HostKeyToConfirm;
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
  library: (url: string) => send<undefined>('settings/library', 'PUT', { url }),
  /** Tries a media store and keeps it; or answers the host key that is to be confirmed first. */
  media: async (
    settings: MediaSettings,
    key?: MediaKey,
  ): Promise<{ test: StoreTest } | { confirm: HostKeyToConfirm }> => {
    try {
      return await send<{ test: StoreTest }>('settings/media', 'PUT', {
        ...settings,
        ...(key ? { key } : {}),
      });
    } catch (error) {
      const fingerprint = error instanceof ApiError ? error.body.fingerprint : undefined;
      if (
        error instanceof ApiError &&
        (error.code === 'host-key-unconfirmed' || error.code === 'host-key-changed') &&
        typeof fingerprint === 'string'
      ) {
        return { confirm: { code: error.code, fingerprint } };
      }
      throw error;
    }
  },
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
