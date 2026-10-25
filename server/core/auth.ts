/**
 * Signing in (docs/SPEC.md §6.2): through the library's OpenID Connect provider (`oidc.ts`: the
 * authorization code flow, with PKCE, a `state` and a `nonce`), and, on a machine, its owner by a
 * one-time link of the CLI (`pnpm library login`), which needs no provider at all.
 *
 * The session is a cookie signed with the library's session key: the vault's `session`, or the
 * host's own (`SESSION_SECRET` on Cloudflare, before the Worker had a vault). It says who the
 * person is, and nothing of what they may do: that is read from the library's people
 * (`people.ts`) on every request, so a role given or taken away counts at once.
 */
import type { Context } from './context.ts';
import { ProviderUnreachable, accountOf, endpointsOf, providerOf, type Provider } from './oidc.ts';
import { capabilitiesOf, readPerson, seen, settlePeople } from './people.ts';

/** A person signed in. */
export interface User {
  /** The provider's id of the account, which never changes; `local:<email>` for the owner's link. */
  sub: string;
  email: string;
  name: string;
  picture?: string;
  /** How they signed in: the provider's kind, or `local`. */
  provider: string;
}

/** The session's cookie, and the cookie of a sign-in on its way to the provider and back. */
const SESSION = 'library-session';
const PENDING = 'library-signin';
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const PENDING_SECONDS = 10 * 60;
/** How long the owner's link of the CLI holds. */
export const LINK_SECONDS = 10 * 60;
/** The least a session key is. */
const KEY_LEAST = 32;

const CALLBACK = '/auth/callback';

interface Session extends User {
  exp: number;
}

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  /** The provider the person was sent to: a sign-in comes back to the same one. */
  issuer: string;
  /** The page to come back to: a path of this site, with its hash. */
  back: string;
  exp: number;
}

const now = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of a base64url text; throws on a text that is not one. */
function fromBase64url(text: string) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * A value and its signature, as `<payload>.<signature>`. The signature covers what the value is
 * for, so a cookie of one kind is never read as the other.
 */
async function seal(use: string, value: object, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(value)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${use}.${payload}`));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The value of a sealed text when its signature holds and it has not expired. */
async function unseal<T extends { exp: number }>(
  use: string,
  text: string | undefined,
  secret: string,
): Promise<T | undefined> {
  const [payload, signature, extra] = text?.split('.') ?? [];
  if (!payload || !signature || extra !== undefined) return undefined;
  try {
    const key = await hmacKey(secret);
    const data = encoder.encode(`${use}.${payload}`);
    if (!(await crypto.subtle.verify('HMAC', key, fromBase64url(signature), data)))
      return undefined;
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as T;
    return typeof value.exp === 'number' && value.exp > now() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A cookie's name: over HTTPS with the `__Host-` prefix, which holds it to this host and to a
 * secure connection. The server on this machine is plain HTTP.
 */
const cookieName = (url: URL, name: string) =>
  url.protocol === 'https:' ? `__Host-${name}` : name;

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** A `Set-Cookie` value; an age of 0 removes the cookie. */
function cookie(url: URL, name: string, value: string, maxAge: number): string {
  const parts = [`${cookieName(url, name)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(`Max-Age=${maxAge}`);
  if (url.protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

function redirect(to: URL | string, cookies: string[]): Response {
  const headers = new Headers({ Location: String(to), 'Cache-Control': 'no-store' });
  for (const one of cookies) headers.append('Set-Cookie', one);
  return new Response(null, { status: 302, headers });
}

export function json(value: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  for (const one of cookies) headers.append('Set-Cookie', one);
  return new Response(JSON.stringify(value), { status, headers });
}

/** A path of this site to come back to, with its query and hash; anything else is the home page. */
function localPath(value: string | null, origin: string): string {
  if (!value?.startsWith('/')) return '/';
  try {
    const target = new URL(value, origin);
    // A path that begins `//` names another site once it is written back as an address.
    if (
      target.origin !== origin ||
      target.pathname.startsWith('//') ||
      target.pathname.startsWith('/auth/')
    ) {
      return '/';
    }
    return target.pathname + target.search + target.hash;
  } catch {
    return '/';
  }
}

/** Whether a request that may change something comes from this site's own pages (its `Origin`). */
export function fromThisSite(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  return request.headers.get('Origin') === new URL(request.url).origin;
}

/** The key sessions are signed with; none, and no one signs in, before the library has one. */
export async function sessionKeyOf(ctx: Context): Promise<string | undefined> {
  const key = (await ctx.vault?.get('session')) ?? ctx.auth.sessionSecret;
  return key && key.length >= KEY_LEAST ? key : undefined;
}

/** The person a request comes from, when its session is good. */
export async function signedIn(request: Request, ctx: Context): Promise<User | undefined> {
  const key = await sessionKeyOf(ctx);
  if (!key) return undefined;
  const name = cookieName(new URL(request.url), SESSION);
  const session = await unseal<Session>('session', readCookie(request, name), key);
  if (!session) return undefined;
  const { sub, email, name: shown, picture, provider = 'google' } = session;
  return { sub, email, name: shown, ...(picture ? { picture } : {}), provider };
}

/** Whether a request came from this very machine. */
export const fromThisMachine = (address: string | undefined) =>
  address !== undefined && (address === '::1' || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(address));

/**
 * `GET /api/me`: how one signs in here (the provider, the owner's link of a library on a
 * machine), who is signed in, and what they may do.
 */
export async function me(request: Request, ctx: Context): Promise<Response> {
  const key = await sessionKeyOf(ctx);
  const provider = key ? await providerOf(ctx) : undefined;
  const local = Boolean(key && ctx.local);
  const user = await signedIn(request, ctx);
  let person;
  if (user && ctx.state) {
    await settlePeople(ctx);
    person = await readPerson(ctx.state, user.email);
  }
  const can = capabilitiesOf(person);
  return json({
    signIn: provider !== undefined || local,
    provider: provider ? { kind: provider.kind, name: provider.name } : null,
    local,
    user: user
      ? {
          ...user,
          role: person?.blocked ? null : (person?.role ?? null),
          blocked: Boolean(person?.blocked),
          // What the page asked of an account before it had roles: whether it reviews.
          editor: can.review,
          can,
        }
      : null,
  });
}

const notSetUp = () =>
  new Response('Signing in is not set up on this server.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** The provider, its endpoints and the session key, or the answer to give without them. */
async function signingIn(ctx: Context): Promise<{ provider: Provider; key: string } | Response> {
  const key = await sessionKeyOf(ctx);
  const provider = key ? await providerOf(ctx) : undefined;
  if (!key || !provider) return notSetUp();
  return { provider, key };
}

/** `GET /auth/login?return=<path>`: off to the provider, which sends the person back to the callback. */
export async function login(request: Request, ctx: Context): Promise<Response> {
  const found = await signingIn(ctx);
  if (found instanceof Response) return found;
  const { provider, key } = found;
  const url = new URL(request.url);
  const back = localPath(url.searchParams.get('return'), url.origin);
  let endpoints;
  try {
    endpoints = await endpointsOf(provider);
  } catch (error) {
    if (!(error instanceof ProviderUnreachable)) throw error;
    console.warn(`Signing in failed: ${error.message}`);
    const failed = new URL(back, url.origin);
    failed.searchParams.set('signin', 'failed');
    return redirect(failed, []);
  }
  const pending: Pending = {
    state: random(),
    verifier: random(),
    nonce: random(),
    issuer: provider.issuer,
    back,
    exp: now() + PENDING_SECONDS,
  };
  const challenge = await crypto.subtle.digest('SHA-256', encoder.encode(pending.verifier));
  const to = new URL(endpoints.authorization);
  to.search = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: url.origin + CALLBACK,
    response_type: 'code',
    scope: 'openid email profile',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: base64url(new Uint8Array(challenge)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const sealed = await seal('signin', pending, key);
  return redirect(to, [cookie(url, PENDING, sealed, PENDING_SECONDS)]);
}

/** Signs a person in: a session for them, and the library records that it saw them. */
async function startSession(ctx: Context, url: URL, user: User, key: string) {
  if (ctx.state) {
    await settlePeople(ctx);
    await seen(ctx.state, user, new Date().toISOString());
  }
  const session: Session = { ...user, exp: now() + SESSION_SECONDS };
  return cookie(url, SESSION, await seal('session', session, key), SESSION_SECONDS);
}

/**
 * `GET /auth/callback`: the provider's answer. The code is exchanged for the account, and the
 * person is sent back to the page they signed in from, signed in, or with `?signin=failed` when it
 * did not work. Turning the provider's page down comes back as it went.
 */
export async function callback(request: Request, ctx: Context): Promise<Response> {
  const found = await signingIn(ctx);
  if (found instanceof Response) return found;
  const { provider, key } = found;
  const url = new URL(request.url);
  const pending = await unseal<Pending>(
    'signin',
    readCookie(request, cookieName(url, PENDING)),
    key,
  );
  const cleared = cookie(url, PENDING, '', 0);
  const back = new URL(pending?.back ?? '/', url.origin);
  const fail = (reason: string) => {
    console.warn(`Signing in failed: ${reason}`);
    back.searchParams.set('signin', 'failed');
    return redirect(back, [cleared]);
  };
  if (!pending) return fail('no sign-in in progress, or it expired');
  if (url.searchParams.get('state') !== pending.state) return fail('the state does not match');
  if (pending.issuer !== provider.issuer) return fail('the provider changed meanwhile');
  const error = url.searchParams.get('error');
  if (error === 'access_denied') return redirect(back, [cleared]);
  if (error) return fail(`the provider answered ${error}`);
  const code = url.searchParams.get('code');
  if (!code) return fail('no code');

  let endpoints;
  let idToken: string | undefined;
  try {
    endpoints = await endpointsOf(provider);
    const response = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: url.origin + CALLBACK,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) return fail(`the token endpoint answered ${response.status}`);
    idToken = ((await response.json()) as { id_token?: string }).id_token;
  } catch (cause) {
    return fail(`the token endpoint could not be read: ${String(cause)}`);
  }
  const account = accountOf(idToken, provider, endpoints, pending.nonce);
  if (!account) return fail('the ID token does not hold, or names an address not taken here');
  const session = await startSession(ctx, url, { ...account, provider: provider.kind }, key);
  return redirect(back, [cleared, session]);
}

const linkKey = async (code: string) => `links/${await sha256Hex(code)}.json`;

/**
 * A one-time link that signs the owner in on this machine (`pnpm library login`): the code, of
 * which the store keeps only the hash, for `LINK_SECONDS`.
 */
export async function issueLocalLink(ctx: Context, email: string): Promise<string> {
  if (!ctx.state) throw new Error('The library keeps no links without its store.');
  const code = random();
  await ctx.state.put(await linkKey(code), JSON.stringify({ email, exp: now() + LINK_SECONDS }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return code;
}

/**
 * `GET /auth/local?code=`: the owner's one-time link, from this very machine only, on a host that
 * offers it. It is used once: a second use, or one after it expired, signs no one in.
 */
export async function local(request: Request, ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  const key = await sessionKeyOf(ctx);
  if (!ctx.local || !ctx.state || !key) return json({ error: 'not-found' }, 404);
  const failed = () => {
    const home = new URL('/', url.origin);
    home.searchParams.set('signin', 'failed');
    return redirect(home, []);
  };
  if (!fromThisMachine(ctx.clientAddress)) {
    console.warn(`The owner's link was opened from ${ctx.clientAddress}, not this machine.`);
    return failed();
  }
  const code = url.searchParams.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return failed();
  const at = await linkKey(code);
  const object = await ctx.state.get(at);
  if (!object) return failed();
  const link = JSON.parse(await object.text()) as { email?: string; exp?: number; used?: boolean };
  // Taken by whoever writes over it first; a link opened twice at once signs in once.
  const taken = await ctx.state.put(at, JSON.stringify({ ...link, used: true }), {
    onlyIf: { etagMatches: object.etag },
  });
  await ctx.state.delete(at);
  if (!taken || link.used || !link.email || !link.exp || link.exp < now()) return failed();
  await settlePeople(ctx);
  const owner = await readPerson(ctx.state, link.email);
  if (owner?.role !== 'owner' || owner.blocked) return failed();
  const user: User = {
    sub: `local:${owner.email}`,
    email: owner.email,
    name: owner.name ?? owner.email,
    provider: 'local',
  };
  return redirect(new URL('/', url.origin), [await startSession(ctx, url, user, key)]);
}

/** `POST /auth/logout`, from the library's own page. */
export function logout(request: Request): Response {
  if (!fromThisSite(request)) return json({ error: 'another-site' }, 403);
  return json({ signedOut: true }, 200, [cookie(new URL(request.url), SESSION, '', 0)]);
}
