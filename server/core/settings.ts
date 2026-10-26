/**
 * The library's settings, for its admins (docs/SPEC.md §5.3, §10):
 *
 *   GET    /api/settings                   every setting, and of each key only that it is set
 *   POST   /api/settings/media/test        reaches the media: reads the manifest, writes a probe
 *   PUT    /api/settings/sign-in           { "provider", "clientId", "issuer"?, "tenant"?, "name"?,
 *                                            "allowedDomains"?, "secret"? }: the provider
 *   DELETE /api/settings/sign-in           no provider: on a machine, the owner's link alone
 *   PUT    /api/settings/limits            { "pending"?, "bytes"?, "tokens"?, "writesPerMinute"? }
 *
 * Where the media is, and the address the library is reached at, are its host's, and are shown
 * here, never changed (docs/SPEC.md D13): on Cloudflare, the Worker's bucket and its own address;
 * in a local library, the folder and the address its install script named. A key is written,
 * never read back (`vault.ts`); each change goes into the audit. Seeding an empty media is the
 * import of the library's API, a batch at a time (`POST /api/library/import`).
 */
import { audit } from './audit.ts';
import { LibraryConfig, readConfig, writeConfig } from './config.ts';
import type { Context, MediaStore } from './context.ts';
import { isRecord, json, jsonBody, problem } from './http.ts';
import { LIMITS, limitsOf } from './limits.ts';
import { MANIFEST, PROBE } from './media/live.ts';
import { siteOf } from './media/routes.ts';
import {
  GOOGLE_ISSUER,
  ProviderUnreachable,
  isOneTenant,
  microsoftIssuer,
  saveSignIn,
  secureAddress,
} from './oidc.ts';
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
  const folder = ctx.mediaFolder;
  const room = await folder?.room().catch(() => undefined);
  return json({
    editable: { signIn: Boolean(ctx.vault) },
    library: { url },
    media: {
      kind: folder ? 'folder' : ctx.media ? 'r2' : 'none',
      ...(folder ? { path: folder.path } : {}),
      ...(room ? { room } : {}),
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

export interface StoreTest {
  /** The manifest could be read: the library is there, or the media is empty. */
  reached: boolean;
  library?: { published: string; files: number };
  /** A file could be written there, and taken away. */
  wrote: boolean;
  message?: string;
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
    return {
      reached,
      ...(found ? { library: found } : {}),
      wrote: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const test: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.media) return problem(409, 'no-media', 'The library has no media store yet.');
  return json(await testStore(ctx.media));
};

/**
 * How people sign in is the owner's alone: whoever names the provider says who each person is, the
 * owner too.
 */
const signIn: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'owner');
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
  if (provider === 'microsoft' && !isOneTenant(text(given.tenant))) {
    return problem(
      400,
      'bad-request',
      'Microsoft is named by the organization’s tenant: its id, or its domain. Through organizations or common, any tenant’s accounts would sign in.',
    );
  }
  const issuer =
    provider === 'microsoft'
      ? microsoftIssuer(text(given.tenant))
      : provider === 'oidc'
        ? text(given.issuer)
        : GOOGLE_ISSUER;
  if (!secureAddress(issuer)) {
    return problem(400, 'bad-request', 'A provider is reached over HTTPS.');
  }
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
  // A secret left out keeps the one the vault has, for the very client it was given for: never
  // sent to another issuer.
  const was = (await readConfig(ctx.state))?.signIn;
  const same =
    was?.provider === parsed.data.provider &&
    was.clientId === parsed.data.clientId &&
    (was.issuer ?? GOOGLE_ISSUER) === (parsed.data.issuer ?? GOOGLE_ISSUER);
  const secret = text(given.secret) || (same ? await ctx.vault.get('oidc') : undefined);
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
