/**
 * Signing in with a Google account (OpenID Connect: the authorization code flow, with PKCE), so
 * that the people the library names can upload content to it. Nothing of it is stored: the
 * session is a cookie signed with the host's session key (`SESSION_SECRET` on Cloudflare), and
 * who may upload is read from the host's list of editors (`LIBRARY_EDITORS`) on every request, so
 * an address taken off the list loses the right at once.
 */
import type { AuthSettings, Context } from './context.ts';

/** A person signed in. */
export interface User {
  /** Google's id of the account, which never changes. */
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** The session's cookie, and the cookie of a sign-in on its way to Google and back. */
const SESSION = 'library-session';
const PENDING = 'library-signin';
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const PENDING_SECONDS = 10 * 60;
/** How far the clocks of Google and of this server may differ. */
const SKEW_SECONDS = 60;

const CALLBACK = '/auth/callback';

interface Config {
  clientId: string;
  clientSecret: string;
  secret: string;
}

interface Session extends User {
  exp: number;
}

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  /** The page to come back to: a path of this site, with its hash. */
  back: string;
  exp: number;
}

/** Signing in is offered only when the host has its client and its key. */
function configOf(auth: AuthSettings): Config | undefined {
  const { googleClientId: clientId, googleClientSecret: clientSecret } = auth;
  const secret = auth.sessionSecret;
  if (!clientId || !clientSecret || !secret || secret.length < 32) return undefined;
  return { clientId, clientSecret, secret };
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
 * secure connection. The dev server on this machine is plain HTTP.
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
    if (target.origin !== origin || target.pathname.startsWith('/auth/')) return '/';
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

const editorsOf = (auth: AuthSettings) =>
  (auth.editors ?? '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean);

/** Whether an account may upload to the library. */
export const isEditor = (email: string, auth: AuthSettings) =>
  editorsOf(auth).includes(email.toLowerCase());

/** The person a request comes from, when its session is good. */
export async function signedIn(request: Request, ctx: Context): Promise<User | undefined> {
  const config = configOf(ctx.auth);
  if (!config) return undefined;
  const name = cookieName(new URL(request.url), SESSION);
  const session = await unseal<Session>('session', readCookie(request, name), config.secret);
  if (!session) return undefined;
  const { sub, email, name: shown, picture } = session;
  return { sub, email, name: shown, picture };
}

/**
 * The editor a request comes from, or the answer to give instead: 403 for a request from another
 * site, 401 without a session, 403 for an account the library does not name. A route that changes
 * the library, such as an upload, starts with it.
 */
export async function requireEditor(request: Request, ctx: Context): Promise<User | Response> {
  if (!fromThisSite(request)) return json({ error: 'another-site' }, 403);
  const user = await signedIn(request, ctx);
  if (!user) return json({ error: 'signed-out' }, 401);
  if (!isEditor(user.email, ctx.auth)) return json({ error: 'not-an-editor' }, 403);
  return user;
}

/** `GET /api/me`: whether signing in is offered, and who is signed in. */
export async function me(request: Request, ctx: Context): Promise<Response> {
  const user = await signedIn(request, ctx);
  return json({
    signIn: configOf(ctx.auth) !== undefined,
    user: user ? { ...user, editor: isEditor(user.email, ctx.auth) } : null,
  });
}

const notSetUp = () =>
  new Response('Signing in is not set up on this server.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** `GET /auth/login?return=<path>`: off to Google, which sends the person back to the callback. */
export async function login(request: Request, ctx: Context): Promise<Response> {
  const config = configOf(ctx.auth);
  if (!config) return notSetUp();
  const url = new URL(request.url);
  const pending: Pending = {
    state: random(),
    verifier: random(),
    nonce: random(),
    back: localPath(url.searchParams.get('return'), url.origin),
    exp: now() + PENDING_SECONDS,
  };
  const challenge = await crypto.subtle.digest('SHA-256', encoder.encode(pending.verifier));
  const google = new URL(GOOGLE_AUTHORIZE);
  google.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: url.origin + CALLBACK,
    response_type: 'code',
    scope: 'openid email profile',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: base64url(new Uint8Array(challenge)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const sealed = await seal('signin', pending, config.secret);
  return redirect(google, [cookie(url, PENDING, sealed, PENDING_SECONDS)]);
}

interface Claims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/**
 * The account of the ID token Google answered the code with. The token comes straight from
 * Google's token endpoint over TLS, so its signature needs no check (OpenID Connect Core
 * 3.1.3.7, 6); its issuer, audience, expiry, nonce and verified address do.
 */
export function accountOf(
  idToken: string | undefined,
  clientId: string,
  nonce: string,
): User | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Claims;
  } catch {
    return undefined;
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!GOOGLE_ISSUERS.includes(claims.iss ?? '') || !audience.includes(clientId)) return undefined;
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now()) return undefined;
  if (claims.nonce !== nonce) return undefined;
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.sub || !claims.email || !verified) return undefined;
  return {
    sub: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
    picture: claims.picture,
  };
}

/**
 * `GET /auth/callback`: Google's answer. The code is exchanged for the account, and the person is
 * sent back to the page they signed in from, signed in, or with `?signin=failed` when it did not
 * work. Turning Google's page down comes back as it went.
 */
export async function callback(request: Request, ctx: Context): Promise<Response> {
  const config = configOf(ctx.auth);
  if (!config) return notSetUp();
  const url = new URL(request.url);
  const pending = await unseal<Pending>(
    'signin',
    readCookie(request, cookieName(url, PENDING)),
    config.secret,
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
  const error = url.searchParams.get('error');
  if (error === 'access_denied') return redirect(back, [cleared]);
  if (error) return fail(`Google answered ${error}`);
  const code = url.searchParams.get('code');
  if (!code) return fail('no code');

  let idToken: string | undefined;
  try {
    const response = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: url.origin + CALLBACK,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) return fail(`the token endpoint answered ${response.status}`);
    idToken = ((await response.json()) as { id_token?: string }).id_token;
  } catch (cause) {
    return fail(`the token endpoint could not be read: ${String(cause)}`);
  }
  const user = accountOf(idToken, config.clientId, pending.nonce);
  if (!user) return fail('the ID token does not hold');

  const session: Session = { ...user, exp: now() + SESSION_SECONDS };
  const sealed = await seal('session', session, config.secret);
  return redirect(back, [cleared, cookie(url, SESSION, sealed, SESSION_SECONDS)]);
}

/** `POST /auth/logout`, from the library's own page. */
export function logout(request: Request): Response {
  if (!fromThisSite(request)) return json({ error: 'another-site' }, 403);
  return json({ signedOut: true }, 200, [cookie(new URL(request.url), SESSION, '', 0)]);
}
