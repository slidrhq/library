import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import worker, { type Env } from '../host/cloudflare/index.ts';
import { MemoryBucket } from './uploads/testing.ts';
import { masterKeyText, newMasterKey } from './vault.ts';

const SITE = 'https://library.example';
const CLIENT = 'client-1.apps.googleusercontent.com';

const env = {
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
  LIBRARY_EDITORS: 'Editor@Example.com, other@example.com',
  ASSETS: { fetch: () => Promise.resolve(new Response('the page')) },
};

const base64url = (text: string) => Buffer.from(text).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** An ID token as Google's token endpoint answers it; only its claims are read. */
function idToken(claims: Record<string, unknown>) {
  return [
    base64url(JSON.stringify({ alg: 'RS256' })),
    base64url(JSON.stringify(claims)),
    'signature',
  ].join('.');
}

/** The library's own store, a new one for each test. */
let store: MemoryBucket;

const call = (path: string, init: RequestInit = {}, environment: Partial<Env> = env, site = SITE) =>
  worker.fetch(new Request(site + path, { redirect: 'manual', ...init }), {
    ...env,
    UPLOADS: store,
    ...environment,
  });

/** The `name=value` of each cookie an answer sets, by name. */
function cookiesOf(response: Response) {
  const found: Record<string, { value: string; attributes: string }> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = header.split('; ');
    const at = pair.indexOf('=');
    found[pair.slice(0, at)] = { value: pair.slice(at + 1), attributes: attributes.join('; ') };
  }
  return found;
}

/** Signs in as far as Google: the address Google is sent to, and the cookie of the sign-in. */
async function startSignIn(back = '/#lib=designs') {
  const response = await call(`/auth/login?return=${encodeURIComponent(back)}`);
  assert.equal(response.status, 302);
  const google = new URL(response.headers.get('Location')!);
  const pending = cookiesOf(response)['__Host-library-signin'];
  assert.ok(pending);
  return { google, cookie: `__Host-library-signin=${pending.value}` };
}

function answerWith(claims: Record<string, unknown>, status = 200) {
  return mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ id_token: idToken(claims) }, { status })),
  );
}

const claimsFor = (google: URL, more: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  exp: now() + 3600,
  nonce: google.searchParams.get('nonce'),
  sub: '1234567890',
  email: 'editor@example.com',
  email_verified: true,
  name: 'An Editor',
  picture: 'https://lh3.googleusercontent.com/a/photo',
  ...more,
});

/** Signs in all the way, Google answering with these claims; the callback's answer. */
async function signIn(more: Record<string, unknown> = {}) {
  const { google, cookie } = await startSignIn();
  answerWith(claimsFor(google, more));
  const state = google.searchParams.get('state')!;
  return call(`/auth/callback?state=${state}&code=the-code`, { headers: { Cookie: cookie } });
}

function sessionOf(response: Response) {
  const session = cookiesOf(response)['__Host-library-session'];
  assert.ok(session?.value, 'a session cookie');
  return `__Host-library-session=${session.value}`;
}

interface Me {
  signIn: boolean;
  provider: { kind: string; name: string } | null;
  local: boolean;
  user: {
    email: string;
    name: string;
    role: string | null;
    editor: boolean;
    can: Record<string, boolean>;
  } | null;
}

const meOf = async (cookie?: string) =>
  (await (await call('/api/me', { headers: cookie ? { Cookie: cookie } : {} })).json()) as Me;

// A sign-in that fails says why in the Worker's log.
beforeEach(() => {
  store = new MemoryBucket();
  mock.method(console, 'warn', () => undefined);
});
afterEach(() => mock.restoreAll());

describe('the Worker', () => {
  test('serves the page for any path but its own', async () => {
    assert.equal(await (await call('/')).text(), 'the page');
    assert.equal((await call('/api/nothing')).status, 404);
    assert.equal((await call('/api/me', { method: 'POST' })).status, 405);
  });

  test('sends plain HTTP to HTTPS, but on this machine', async () => {
    const away = await call('/api/me', {}, env, 'http://library.example');
    assert.equal(away.status, 308);
    assert.equal(away.headers.get('Location'), 'https://library.example/api/me');
    assert.equal((await call('/api/me', {}, env, 'http://127.0.0.1:5176')).status, 200);
  });
});

describe('signing in with Google', () => {
  test('is not offered without its client or with a short key', async () => {
    assert.deepEqual(await meOf(), {
      signIn: true,
      provider: { kind: 'google', name: 'Google' },
      local: false,
      user: null,
    });
    for (const missing of [
      { GOOGLE_CLIENT_ID: '' },
      { GOOGLE_CLIENT_SECRET: '' },
      { SESSION_SECRET: 'short' },
    ]) {
      const response = await call('/api/me', {}, { ...env, ...missing });
      assert.deepEqual(await response.json(), {
        signIn: false,
        provider: null,
        local: false,
        user: null,
      });
      assert.equal((await call('/auth/login', {}, { ...env, ...missing })).status, 503);
    }
  });

  test('sends the person to Google with PKCE, a state and a nonce', async () => {
    const { google } = await startSignIn();
    assert.equal(google.origin + google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const params = Object.fromEntries(google.searchParams);
    assert.equal(params.client_id, CLIENT);
    assert.equal(params.redirect_uri, `${SITE}/auth/callback`);
    assert.equal(params.response_type, 'code');
    assert.equal(params.scope, 'openid email profile');
    assert.equal(params.code_challenge_method, 'S256');
    assert.match(params.code_challenge!, /^[\w-]{43}$/);
    assert.match(params.state!, /^[\w-]{43}$/);
    assert.match(params.nonce!, /^[\w-]{43}$/);
    const again = await startSignIn();
    assert.notEqual(again.google.searchParams.get('state'), params.state);
  });

  test('keeps the sign-in cookie to this host, over HTTPS, for ten minutes', async () => {
    const response = await call('/auth/login');
    const { attributes } = cookiesOf(response)['__Host-library-signin']!;
    assert.equal(attributes, 'Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    const local = await call('/auth/login', {}, env, 'http://127.0.0.1:5176');
    assert.ok(cookiesOf(local)['library-signin']);
  });

  test('signs in, and comes back to the page it started from', async () => {
    const { google, cookie } = await startSignIn('/?x=1#lib=icons&i=star');
    const exchange = answerWith(claimsFor(google));
    const response = await call(
      `/auth/callback?state=${google.searchParams.get('state')}&code=the-code`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), `${SITE}/?x=1#lib=icons&i=star`);

    // The code was exchanged with the client's secret and the verifier of the challenge.
    const [url, init] = exchange.mock.calls[0]!.arguments as [string, RequestInit];
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body as URLSearchParams);
    assert.equal(body.get('code'), 'the-code');
    assert.equal(body.get('client_secret'), 'client-secret');
    assert.equal(body.get('redirect_uri'), `${SITE}/auth/callback`);
    const digest = await crypto.subtle.digest('SHA-256', Buffer.from(body.get('code_verifier')!));
    assert.equal(
      Buffer.from(digest).toString('base64url'),
      google.searchParams.get('code_challenge'),
    );

    const cookies = cookiesOf(response);
    assert.equal(cookies['__Host-library-signin']?.value, '');
    assert.match(cookies['__Host-library-signin'].attributes, /Max-Age=0/);
    assert.match(cookies['__Host-library-session']!.attributes, /HttpOnly; SameSite=Lax/);
    // The first editor the Worker named is the library's owner (`settlePeople`).
    const everything = {
      upload: true,
      review: true,
      publish: true,
      members: true,
      settings: true,
      owner: true,
    };
    assert.deepEqual((await meOf(sessionOf(response))).user, {
      sub: '1234567890',
      email: 'editor@example.com',
      name: 'An Editor',
      picture: 'https://lh3.googleusercontent.com/a/photo',
      provider: 'google',
      role: 'owner',
      blocked: false,
      editor: true,
      can: everything,
    });
  });

  test('comes back only to a path of this site', async () => {
    for (const back of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/auth/x']) {
      const { google, cookie } = await startSignIn(back);
      answerWith(claimsFor(google));
      const state = google.searchParams.get('state')!;
      const response = await call(`/auth/callback?state=${state}&code=c`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.headers.get('Location'), `${SITE}/`, back);
    }
  });

  test('knows the people by their address, in any case', async () => {
    const editor = sessionOf(await signIn({ email: 'EDITOR@example.com' }));
    assert.equal((await meOf(editor)).user?.role, 'owner');
    const other = sessionOf(await signIn({ email: 'Other@Example.com' }));
    assert.equal((await meOf(other)).user?.role, 'reviewer');
    // Anyone who signs in may upload; only the members review.
    const someone = (await meOf(sessionOf(await signIn({ email: 'someone@example.com' })))).user;
    assert.equal(someone?.role, null);
    assert.equal(someone?.editor, false);
    assert.equal(someone?.can.upload, true);
    assert.equal(someone?.can.review, false);
  });

  test('fails back to the page when the answer does not hold', async () => {
    const failures: Record<string, Record<string, unknown>> = {
      'another client': { aud: 'another.apps.googleusercontent.com' },
      'another issuer': { iss: 'https://evil.example' },
      'another nonce': { nonce: 'replayed' },
      'an expired token': { exp: now() - 3600 },
      'an address not verified': { email_verified: false },
      'no address': { email: undefined },
    };
    for (const [what, claims] of Object.entries(failures)) {
      const response = await signIn(claims);
      assert.equal(response.headers.get('Location'), `${SITE}/?signin=failed#lib=designs`, what);
      assert.equal(cookiesOf(response)['__Host-library-session'], undefined, what);
    }
  });

  test('refuses a callback without its own sign-in', async () => {
    const { google, cookie } = await startSignIn();
    answerWith(claimsFor(google));
    const state = google.searchParams.get('state');
    const forged = await call(`/auth/callback?state=forged&code=c`, {
      headers: { Cookie: cookie },
    });
    assert.match(forged.headers.get('Location')!, /signin=failed/);
    const none = await call(`/auth/callback?state=${state}&code=c`);
    assert.equal(none.headers.get('Location'), `${SITE}/?signin=failed`);
    const tampered = cookie.replace('=eyJ', '=fyJ');
    const bad = await call(`/auth/callback?state=${state}&code=c`, {
      headers: { Cookie: tampered },
    });
    assert.match(bad.headers.get('Location')!, /signin=failed/);
  });

  test('comes back as it went when the person turns Google down', async () => {
    const { google, cookie } = await startSignIn();
    const state = google.searchParams.get('state');
    const response = await call(`/auth/callback?state=${state}&error=access_denied`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.headers.get('Location'), `${SITE}/#lib=designs`);
  });

  test('fails when Google turns the code down', async () => {
    const { google, cookie } = await startSignIn();
    answerWith({}, 400);
    const state = google.searchParams.get('state');
    const response = await call(`/auth/callback?state=${state}&code=c`, {
      headers: { Cookie: cookie },
    });
    assert.match(response.headers.get('Location')!, /signin=failed/);
  });
});

describe('the session', () => {
  test('does not hold once changed, or under another key', async () => {
    const session = sessionOf(await signIn());
    const [payload, signature] = session.split('=')[1]!.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as object;
    const changed = base64url(JSON.stringify({ ...claims, email: 'other@example.com' }));
    assert.equal((await meOf(`__Host-library-session=${changed}.${signature}`)).user, null);
    const other = await call(
      '/api/me',
      { headers: { Cookie: session } },
      {
        ...env,
        SESSION_SECRET: 'another-session-secret-of-32-characters',
      },
    );
    assert.equal(((await other.json()) as { user: unknown }).user, null);
  });

  test('holds when the Worker is given its vault, and once SESSION_SECRET is gone', async () => {
    const session = sessionOf(await signIn());
    const vault = { LIBRARY_MASTER_KEY: masterKeyText(await newMasterKey()) };
    const who = async (environment: Partial<Env>) => {
      const answer = await call('/api/me', { headers: { Cookie: session } }, environment);
      return ((await answer.json()) as { user: { email: string } | null }).user?.email;
    };
    // The key it signed sessions with becomes the vault's, the first time it is asked for.
    assert.equal(await who({ ...env, ...vault }), 'editor@example.com');
    assert.ok(store.objects.has('vault/session.json'));
    assert.equal(await who({ ...env, ...vault, SESSION_SECRET: undefined }), 'editor@example.com');
  });

  test('is signed with a key the vault makes, when the Worker had none', async () => {
    const vault = { LIBRARY_MASTER_KEY: masterKeyText(await newMasterKey()) };
    const answer = await call('/api/me', {}, { ...env, ...vault, SESSION_SECRET: undefined });
    assert.equal(((await answer.json()) as { signIn: boolean }).signIn, true);
    assert.ok(store.objects.has('vault/session.json'));
  });

  test('is not the cookie of a sign-in', async () => {
    const { cookie } = await startSignIn();
    const value = cookie.split('=')[1];
    assert.equal((await meOf(`__Host-library-session=${value}`)).user, null);
  });

  test('ends when the person signs out from the page', async () => {
    const session = sessionOf(await signIn());
    const away = await call('/auth/logout', {
      method: 'POST',
      headers: { Cookie: session, Origin: 'https://evil.example' },
    });
    assert.equal(away.status, 403);
    const response = await call('/auth/logout', {
      method: 'POST',
      headers: { Cookie: session, Origin: SITE },
    });
    assert.equal(response.status, 200);
    assert.equal(cookiesOf(response)['__Host-library-session']?.value, '');
  });
});
