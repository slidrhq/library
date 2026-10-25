import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import worker, { type Env } from '../host/cloudflare/index.ts';
import { writeConfig, type SignInSettings } from './config.ts';
import { forgetDiscovery, microsoftIssuer } from './oidc.ts';
import { MemoryBucket } from './uploads/testing.ts';
import { Vault, masterKeyText, newMasterKey } from './vault.ts';

const SITE = 'https://library.example';
const TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** The discovery of one tenant, as Microsoft answers it: by the tenant's id. */
const MICROSOFT = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
};
const KEYCLOAK = {
  issuer: 'https://id.example.org/realms/staff',
  authorization_endpoint: 'https://id.example.org/realms/staff/protocol/openid-connect/auth',
  token_endpoint: 'https://id.example.org/realms/staff/protocol/openid-connect/token',
};

const now = () => Math.floor(Date.now() / 1000);
const base64url = (text: string) => Buffer.from(text).toString('base64url');
const idToken = (claims: object) =>
  [base64url('{"alg":"RS256"}'), base64url(JSON.stringify(claims)), 'signature'].join('.');

/** A library whose settings name a provider, and whose vault keeps its secret. */
async function libraryWith(signIn: SignInSettings): Promise<Partial<Env>> {
  const bucket = new MemoryBucket();
  const master = await newMasterKey();
  await writeConfig(bucket, { version: 1, installed: new Date().toISOString(), signIn });
  await new Vault(bucket, [master]).set('oidc', 'the-provider-secret');
  await new Vault(bucket, [master]).set('session', 'a-session-key-of-at-least-32-characters!');
  return {
    UPLOADS: bucket,
    LIBRARY_MASTER_KEY: masterKeyText(master),
    // The Worker's Google client: the library's own settings win over it.
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ASSETS: { fetch: () => Promise.resolve(new Response('the page')) },
  };
}

/** The provider stood in for: its discovery document, and its token endpoint's answer. */
function provider(discovery: object | undefined, claims: (nonce: string) => object) {
  let nonce = '';
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(
        discovery ? Response.json(discovery) : new Response('down', { status: 500 }),
      );
    }
    const body = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(body.get('client_secret'), 'the-provider-secret');
    return Promise.resolve(Response.json({ id_token: idToken(claims(nonce)) }));
  });
  return {
    calls,
    setNonce: (value: string) => (nonce = value),
  };
}

const call = (env: Partial<Env>, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(SITE + path, { redirect: 'manual', ...init }), env as Env);

/** Signs in all the way; the callback's answer. */
async function signIn(env: Partial<Env>, stand: ReturnType<typeof provider>) {
  const login = await call(env, '/auth/login');
  const to = new URL(login.headers.get('Location')!);
  stand.setNonce(to.searchParams.get('nonce') ?? '');
  const pending = login.headers
    .getSetCookie()
    .find((one) => one.startsWith('__Host-library-signin='))!
    .split(';')[0]!;
  const state = to.searchParams.get('state');
  return {
    to,
    back: await call(env, `/auth/callback?state=${state}&code=c`, { headers: { Cookie: pending } }),
  };
}

async function whoIs(env: Partial<Env>, back: Response) {
  const session = back.headers
    .getSetCookie()
    .find((one) => one.startsWith('__Host-library-session='));
  if (!session) return undefined;
  const me = await call(env, '/api/me', { headers: { Cookie: session.split(';')[0]! } });
  return ((await me.json()) as { user: { email: string; provider: string } }).user;
}

const failed = (back: Response) => back.headers.get('Location') === `${SITE}/?signin=failed`;

beforeEach(() => mock.method(console, 'warn', () => undefined));
afterEach(() => {
  mock.restoreAll();
  forgetDiscovery();
});

const microsoft = (
  allowedDomains: string[] = ['contoso.com'],
  tenant = TENANT,
): SignInSettings => ({
  provider: 'microsoft',
  issuer: microsoftIssuer(tenant),
  clientId: 'ms-client',
  allowedDomains,
});

const microsoftClaims =
  (more: object = {}) =>
  (nonce: string) => ({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    aud: 'ms-client',
    exp: now() + 3600,
    nonce,
    sub: 'ms-sub',
    preferred_username: 'Ann@Contoso.com',
    name: 'Ann',
    ...more,
  });

describe('signing in through the provider the library names', () => {
  test('finds Microsoft by its discovery, and takes the addresses of its tenant', async () => {
    const env = await libraryWith(microsoft());
    const me = (await (await call(env, '/api/me')).json()) as { provider: object };
    assert.deepEqual(me.provider, { kind: 'microsoft', name: 'Microsoft' });
    const stand = provider(MICROSOFT, microsoftClaims());
    const { to, back } = await signIn(env, stand);
    assert.equal(to.origin + to.pathname, MICROSOFT.authorization_endpoint);
    assert.equal(to.searchParams.get('client_id'), 'ms-client');
    assert.equal(stand.calls[0], `${microsoftIssuer(TENANT)}/.well-known/openid-configuration`);
    const user = await whoIs(env, back);
    assert.equal(user?.email, 'ann@contoso.com');
    assert.equal(user?.provider, 'microsoft');
  });

  test('takes no address outside its domains, nor a token of another tenant', async () => {
    const env = await libraryWith(microsoft());
    const elsewhere = provider(MICROSOFT, microsoftClaims({ preferred_username: 'eve@other.org' }));
    assert.ok(failed((await signIn(env, elsewhere)).back));
    mock.restoreAll();
    mock.method(console, 'warn', () => undefined);
    const forged = provider(
      MICROSOFT,
      microsoftClaims({ iss: 'https://login.microsoftonline.com/another-tenant/v2.0' }),
    );
    assert.ok(failed((await signIn(env, forged)).back));
  });

  test('finds a tenant named by its domain, and holds it to that tenant', async () => {
    const env = await libraryWith(microsoft(['contoso.com'], 'contoso.com'));
    const { back } = await signIn(env, provider(MICROSOFT, microsoftClaims()));
    assert.equal((await whoIs(env, back))?.email, 'ann@contoso.com');
  });

  test('takes no Microsoft of every tenant at once: any tenant could name any address', async () => {
    for (const tenant of ['organizations', 'common']) {
      const env = await libraryWith(microsoft(['victim.org'], tenant));
      const shared = {
        ...MICROSOFT,
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
      };
      const stand = provider(shared, microsoftClaims({ preferred_username: 'owner@victim.org' }));
      const login = await call(env, '/auth/login');
      assert.equal(login.headers.get('Location'), `${SITE}/?signin=failed`, tenant);
      assert.ok(!stand.calls.some((url) => url.includes('/token')));
      mock.restoreAll();
      mock.method(console, 'warn', () => undefined);
      forgetDiscovery();
    }
  });

  test('takes a discovery only of the very issuer named, over HTTPS', async () => {
    const env = await libraryWith({
      provider: 'oidc',
      issuer: KEYCLOAK.issuer,
      clientId: 'library',
      name: 'Staff',
      allowedDomains: [],
    });
    provider({ ...KEYCLOAK, issuer: 'https://evil.example/realms/staff' }, () => ({}));
    assert.equal(
      (await call(env, '/auth/login')).headers.get('Location'),
      `${SITE}/?signin=failed`,
    );
    mock.restoreAll();
    mock.method(console, 'warn', () => undefined);
    forgetDiscovery();
    provider({ ...KEYCLOAK, token_endpoint: 'http://id.example.org/token' }, () => ({}));
    assert.equal(
      (await call(env, '/auth/login')).headers.get('Location'),
      `${SITE}/?signin=failed`,
    );
  });

  test('takes no Microsoft address when no domain vouches for it', async () => {
    const env = await libraryWith(microsoft([]));
    const stand = provider(MICROSOFT, microsoftClaims());
    assert.ok(failed((await signIn(env, stand)).back));
  });

  test('takes from another provider only an address it says is verified', async () => {
    const env = await libraryWith({
      provider: 'oidc',
      issuer: KEYCLOAK.issuer,
      clientId: 'library',
      name: 'Staff',
      allowedDomains: [],
    });
    const me = (await (await call(env, '/api/me')).json()) as { provider: object };
    assert.deepEqual(me.provider, { kind: 'oidc', name: 'Staff' });
    const claims = (verified: boolean) => (nonce: string) => ({
      iss: KEYCLOAK.issuer,
      aud: 'library',
      exp: now() + 3600,
      nonce,
      sub: 'kc-1',
      email: 'dan@example.org',
      email_verified: verified,
    });
    assert.ok(failed((await signIn(env, provider(KEYCLOAK, claims(false)))).back));
    mock.restoreAll();
    mock.method(console, 'warn', () => undefined);
    const { back } = await signIn(env, provider(KEYCLOAK, claims(true)));
    assert.equal((await whoIs(env, back))?.email, 'dan@example.org');
  });

  test('sends the person back when the provider cannot be reached', async () => {
    const env = await libraryWith(microsoft());
    provider(undefined, microsoftClaims());
    const login = await call(env, '/auth/login?return=%2Fuploads');
    assert.equal(login.headers.get('Location'), `${SITE}/uploads?signin=failed`);
    // A path that would name another site, once written back as an address, is not followed.
    for (const back of ['/.//evil.example/phish', '//evil.example', '/\\evil.example']) {
      const away = await call(env, `/auth/login?return=${encodeURIComponent(back)}`);
      assert.equal(away.headers.get('Location'), `${SITE}/?signin=failed`, back);
    }
  });

  test('holds Google to the library’s domains too', async () => {
    const env = await libraryWith({
      provider: 'google',
      clientId: 'g-client',
      allowedDomains: ['example.com'],
    });
    const google = (email: string) => (nonce: string) => ({
      iss: 'https://accounts.google.com',
      aud: 'g-client',
      exp: now() + 3600,
      nonce,
      sub: 'g-1',
      email,
      email_verified: true,
    });
    assert.ok(failed((await signIn(env, provider(undefined, google('someone@other.org')))).back));
    mock.restoreAll();
    mock.method(console, 'warn', () => undefined);
    const stand = provider(undefined, google('someone@example.com'));
    const { to, back } = await signIn(env, stand);
    assert.equal(to.origin, 'https://accounts.google.com');
    assert.equal((await whoIs(env, back))?.email, 'someone@example.com');
    // Google's endpoints are known: no discovery.
    assert.ok(!stand.calls.some((url) => url.includes('openid-configuration')));
  });
});
