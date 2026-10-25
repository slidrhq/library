/**
 * The library's settings, for its admins (docs/SPEC.md §5.3, §10):
 *
 *   GET    /api/settings                   every setting, and of each key only that it is set
 *   PUT    /api/settings/library           { "url" }: the address the library is reached at
 *   PUT    /api/settings/media             its media: { "kind": "folder", "path", "publicUrl"? },
 *                                          or a server's, { "kind": "sftp" | "ftp", "host", "port"?,
 *                                          "user", "root", …, "key"? }; the key is written only
 *   POST   /api/settings/media/test        reaches the media: reads the manifest, writes a probe
 *   PUT    /api/settings/sign-in           { "provider", "clientId", "issuer"?, "tenant"?, "name"?,
 *                                            "allowedDomains"?, "secret"? }: the provider
 *   DELETE /api/settings/sign-in           no provider: on a machine, the owner's link alone
 *   PUT    /api/settings/limits            { "pending"?, "bytes"?, "tokens"?, "writesPerMinute"? }
 *
 * What the host keeps for itself is not the library's to change (`ctx.editable`): on Cloudflare,
 * the media is the Worker's bucket, and its address is the Worker's own. A key is written, never
 * read back (`vault.ts`); each change goes into the audit. Seeding an empty media is the import of
 * the library's API, a batch at a time (`POST /api/library/import`).
 *
 * A server reached over SSH is known by its host key. A store that shows a key not confirmed is
 * answered `409 host-key-unconfirmed` (or `host-key-changed`) with its fingerprint; the admin
 * confirms it by sending the settings again with that `hostKey`.
 */
import { audit } from './audit.ts';
import { LibraryConfig, MediaSettings, readConfig, writeConfig } from './config.ts';
import type { Context, MediaStore } from './context.ts';
import { isRecord, json, jsonBody, problem } from './http.ts';
import { LIMITS, limitsOf } from './limits.ts';
import { MANIFEST, PROBE } from './media/live.ts';
import { siteOf } from './media/routes.ts';
import { GOOGLE_ISSUER, ProviderUnreachable, microsoftIssuer, saveSignIn } from './oidc.ts';
import { authorize } from './uploads/access.ts';

type Route = (request: Request, ctx: Context) => Promise<Response>;

const notSetUp = () =>
  problem(503, 'not-set-up', 'This server keeps no settings: it has no store for them.');

/** What may be shown of a key: when it was set, and by whom. */
async function aboutKey(ctx: Context, name: string) {
  const about = await ctx.vault?.about(name);
  return about
    ? { set: true, at: about.set, ...(about.by ? { by: about.by } : {}) }
    : { set: false };
}

const read: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const config = await readConfig(ctx.state);
  const url = config?.url ?? new URL('/', request.url).href;
  return json({
    editable: {
      url: Boolean(ctx.editable?.url),
      media: Boolean(ctx.editable?.media),
      signIn: Boolean(ctx.vault),
    },
    library: { url },
    media: {
      ...(config?.media ?? { kind: ctx.media ? 'r2' : 'none' }),
      key: await aboutKey(ctx, 'media'),
      address: siteOf(request, ctx, url),
    },
    signIn: config?.signIn
      ? { ...config.signIn, secret: await aboutKey(ctx, 'oidc') }
      : ctx.auth.googleClientId
        ? // The Worker's own Google client, until the library names a provider.
          { provider: 'google', clientId: ctx.auth.googleClientId, allowedDomains: [], host: true }
        : null,
    limits: await limitsOf(ctx),
    defaults: LIMITS,
  });
};

/** The library's settings, changed by `change`, written, and recorded. */
async function change(
  ctx: Context,
  by: string,
  action: string,
  edit: (config: LibraryConfig) => LibraryConfig,
  detail?: Record<string, unknown>,
) {
  if (!ctx.state) return notSetUp();
  const config = await readConfig(ctx.state);
  if (!config) return problem(409, 'not-installed', 'The library is not installed.');
  const changed = LibraryConfig.safeParse(edit(config));
  if (!changed.success) {
    return problem(
      400,
      'bad-request',
      'These settings do not hold.',
      changed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  await writeConfig(ctx.state, changed.data);
  await audit(ctx.state, { by, action, ...(detail ? { detail } : {}) });
  return new Response(null, { status: 204 });
}

const library: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.editable?.url) {
    return problem(409, 'host', 'This server is reached at the address its host gives it.');
  }
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const url = isRecord(body) && typeof body.url === 'string' ? body.url.trim() : '';
  return change(
    ctx,
    actor.id,
    'settings.library',
    (config) => {
      const { url: _was, ...rest } = config;
      return url ? { ...rest, url } : rest;
    },
    { url: url || null },
  );
};

export interface StoreTest {
  /** The manifest could be read: the library is there, or the media is empty. */
  reached: boolean;
  library?: { published: string; files: number };
  /** A file could be written there, and taken away. */
  wrote: boolean;
  message?: string;
  /** The server showed a host key that is not confirmed: which. */
  hostKey?: { code: 'host-key-unconfirmed' | 'host-key-changed'; fingerprint: string };
}

/** The host key a store was shown, when that is why it could not be reached (`sftp.ts`). */
function hostKeyOf(error: unknown): StoreTest['hostKey'] {
  const { code, fingerprint } = (error ?? {}) as { code?: unknown; fingerprint?: unknown };
  return (code === 'host-key-unconfirmed' || code === 'host-key-changed') &&
    typeof fingerprint === 'string'
    ? { code, fingerprint }
    : undefined;
}

/** Reaches a media store: reads its manifest, writes a probe and takes it away. */
export async function testStore(media: MediaStore): Promise<StoreTest> {
  let reached = false;
  let found: StoreTest['library'];
  try {
    const manifest = await media.get(MANIFEST);
    reached = true;
    if (manifest) {
      const value = JSON.parse(await manifest.text()) as { published?: string; files?: object };
      found = {
        published: String(value.published ?? ''),
        files: Object.keys(value.files ?? {}).length,
      };
    }
    await media.put(PROBE, JSON.stringify({ probe: new Date().toISOString() }));
    await media.delete(PROBE);
    return { reached, ...(found ? { library: found } : {}), wrote: true };
  } catch (error) {
    const hostKey = hostKeyOf(error);
    return {
      reached,
      ...(found ? { library: found } : {}),
      wrote: false,
      message: error instanceof Error ? error.message : String(error),
      ...(hostKey ? { hostKey } : {}),
    };
  }
}

/** A store's key as the page sends it: what each kind takes, as text for the vault. */
function keyText(kind: MediaSettings['kind'], given: unknown): string | undefined | Response {
  if (given === undefined || given === null) return undefined;
  const fields = kind === 'sftp' ? ['privateKey', 'passphrase', 'password'] : ['password'];
  if (
    kind === 'folder' ||
    !isRecord(given) ||
    Object.entries(given).some(
      ([name, value]) =>
        !fields.includes(name) || (value !== undefined && typeof value !== 'string'),
    )
  ) {
    return problem(400, 'bad-request', `The key of this store is ${fields.join(', ')}.`);
  }
  const key = Object.fromEntries(
    Object.entries(given).filter(([, value]) => typeof value === 'string' && value !== ''),
  );
  if (Object.keys(key).length === 0) return undefined;
  if (kind === 'sftp' && !key.privateKey && !key.password) {
    return problem(400, 'bad-request', 'An SSH server takes a private key, or a password.');
  }
  return JSON.stringify(key);
}

const media: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.editable?.media || !ctx.openMedia) {
    return problem(409, 'host', 'This server’s media is its host’s, and is not changed here.');
  }
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const { key: givenKey, ...given } = isRecord(body) ? body : {};
  const settings = MediaSettings.safeParse(given);
  if (!settings.success) {
    return problem(
      400,
      'bad-request',
      'These are not the settings of a media store.',
      settings.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  const kind = settings.data.kind;
  const newKey = keyText(kind, givenKey);
  if (newKey instanceof Response) return newKey;
  // A key left out keeps the one the vault has, for a store of the same kind.
  const was = ctx.state ? (await readConfig(ctx.state))?.media : undefined;
  const key = newKey ?? (was?.kind === kind ? await ctx.vault?.get('media') : undefined);
  if (kind !== 'folder' && !key) {
    return problem(400, 'bad-request', 'A server is reached with its key: name it.');
  }
  // Reached before it is kept: a store that cannot be reached is not kept.
  const store = ctx.openMedia(settings.data, key);
  const tried = await testStore(store);
  await store.close?.().catch(() => undefined);
  if (tried.hostKey) {
    return json({ error: tried.hostKey.code, message: tried.message, ...tried.hostKey }, 409);
  }
  if (!tried.reached || !tried.wrote) {
    return json({ error: 'store-unreachable', message: tried.message, test: tried }, 422);
  }
  if (newKey && ctx.vault) await ctx.vault.set('media', newKey, actor.id);
  if (kind === 'folder' && ctx.vault && (await ctx.vault.about('media'))) {
    await ctx.vault.remove('media');
  }
  const saved = await change(
    ctx,
    actor.id,
    'settings.media',
    (config) => ({ ...config, media: settings.data }),
    { kind, ...(newKey ? { key: 'set' } : {}) },
  );
  return saved.status === 204 ? json({ test: tried }) : saved;
};

const test: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return problem(409, 'no-media', 'The library has no media store yet.');
  return json(await testStore(ctx.media));
};

const signIn: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.state || !ctx.vault) {
    return problem(
      409,
      'host',
      'This server keeps no keys of its own: its provider is its host’s.',
    );
  }
  if (request.method === 'DELETE') {
    await saveSignIn(ctx, undefined, undefined, actor.id);
    return new Response(null, { status: 204 });
  }
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const given = isRecord(body) ? body : {};
  const provider = given.provider;
  if (provider !== 'google' && provider !== 'microsoft' && provider !== 'oidc') {
    return problem(400, 'bad-request', 'The provider is google, microsoft or oidc.');
  }
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const issuer =
    provider === 'microsoft'
      ? microsoftIssuer(text(given.tenant) || 'organizations')
      : provider === 'oidc'
        ? text(given.issuer)
        : GOOGLE_ISSUER;
  const domains = Array.isArray(given.allowedDomains)
    ? given.allowedDomains.map((one) => text(one).toLowerCase()).filter(Boolean)
    : [];
  const settings = {
    provider,
    clientId: text(given.clientId),
    allowedDomains: domains,
    ...(provider === 'google' ? {} : { issuer }),
    ...(text(given.name) ? { name: text(given.name) } : {}),
  };
  const parsed = LibraryConfig.shape.signIn.unwrap().safeParse(settings);
  if (!parsed.success) {
    return problem(400, 'bad-request', 'These are not the settings of a provider.');
  }
  // A secret left out keeps the one the vault has.
  const secret = text(given.secret) || (await ctx.vault.get('oidc'));
  if (!secret) return problem(400, 'bad-request', 'The provider’s client comes with its secret.');
  try {
    await saveSignIn(ctx, parsed.data, secret, actor.id);
  } catch (error) {
    if (error instanceof ProviderUnreachable) {
      return problem(422, 'provider-unreachable', error.message);
    }
    throw error;
  }
  return new Response(null, { status: 204 });
};

const limits: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const given = isRecord(body) ? body : {};
  const named = Object.fromEntries(
    (Object.keys(LIMITS) as (keyof typeof LIMITS)[])
      .filter((name) => given[name] !== undefined && given[name] !== null)
      .map((name) => [name, given[name]]),
  );
  return change(
    ctx,
    actor.id,
    'settings.limits',
    (config) => ({ ...config, limits: named }),
    named,
  );
};

const ROUTES: [RegExp, Partial<Record<string, Route>>][] = [
  [/^\/api\/settings$/, { GET: read }],
  [/^\/api\/settings\/library$/, { PUT: library }],
  [/^\/api\/settings\/media$/, { PUT: media }],
  [/^\/api\/settings\/media\/test$/, { POST: test }],
  [/^\/api\/settings\/sign-in$/, { PUT: signIn, DELETE: signIn }],
  [/^\/api\/settings\/limits$/, { PUT: limits }],
];

/** The answer to a request of the settings; undefined for a path that is none of theirs. */
export function settingsApi(request: Request, ctx: Context): Promise<Response> | undefined {
  const { pathname } = new URL(request.url);
  for (const [pattern, methods] of ROUTES) {
    if (!pattern.test(pathname)) continue;
    const route = methods[request.method];
    if (!route) {
      const response = problem(
        405,
        'method-not-allowed',
        `${pathname} takes ${Object.keys(methods).join(', ')}.`,
      );
      response.headers.set('Allow', Object.keys(methods).join(', '));
      return Promise.resolve(response);
    }
    return route(request, ctx);
  }
  return undefined;
}
