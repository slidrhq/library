import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, mock, test } from 'node:test';
import { readAudit } from '../../core/audit.ts';
import { issueLocalLink } from '../../core/auth.ts';
import { readConfig } from '../../core/config.ts';
import type { Context } from '../../core/context.ts';
import { handle } from '../../core/index.ts';
import { R2_ACCOUNT, R2_CREDENTIALS, caller, s3StandIn } from '../../core/uploads/testing.ts';
import { contextSource, install, openLibrary } from './install.ts';
import { memoryKeys } from './master.ts';

const folders: string[] = [];
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));
afterEach(() => mock.restoreAll());

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-settings-'));
  folders.push(folder);
  return folder;
}

const SITE = 'http://127.0.0.1:5176';
const read = async <T>(response: Response) => (await response.json()) as T;

/** A library on a machine, its owner signed in by the CLI's link, and a way to call it. */
async function machine() {
  const root = await newFolder();
  const keys = memoryKeys();
  await install({
    data: join(root, 'data'),
    owner: 'owner@example.org',
    master: 'keychain',
    keys,
    media: { kind: 'folder', path: join(root, 'media') },
  });
  const library = await openLibrary(join(root, 'data'), keys);
  const source = contextSource(library);
  const at = (ctx: Context): Context => ({ ...ctx, clientAddress: '127.0.0.1' });
  const code = await issueLocalLink(await source(), 'owner@example.org');
  const signedIn = await handle(new Request(`${SITE}/auth/local?code=${code}`), at(await source()));
  const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
  const call = async (path: string, init: RequestInit = {}) =>
    handle(
      new Request(SITE + path, {
        ...init,
        headers: { Cookie: cookie, Origin: SITE, ...(init.headers as object) },
      }),
      at(await source()),
    );
  const send = (path: string, method: string, body: unknown) =>
    call(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { root, library, source, call, send };
}

describe('the settings, on a machine', () => {
  test('are shown to an admin, every key only as set or not', async () => {
    const { root, call } = await machine();
    const settings = await read<{
      editable: { url: boolean; media: boolean; signIn: boolean };
      media: { kind: string; path: string; key: { set: boolean }; address: string };
      signIn: unknown;
      limits: { pending: number };
    }>(await call('/api/settings'));
    assert.deepEqual(settings.editable, { url: true, media: true, signIn: true });
    assert.equal(settings.media.kind, 'folder');
    assert.equal(settings.media.path, join(root, 'media'));
    assert.deepEqual(settings.media.key, { set: false });
    assert.equal(settings.signIn, null);
    assert.equal(settings.limits.pending, 20);
    // Installed apps read the library from this server, at /media/.
    assert.equal(settings.media.address, `${SITE}/media/`);
  });

  test('try a media folder before it is kept, and serve it at once', async () => {
    const { root, send, call, library } = await machine();
    const elsewhere = join(root, 'elsewhere');
    const moved = await send('/api/settings/media', 'PUT', { kind: 'folder', path: elsewhere });
    assert.equal(moved.status, 200, await moved.clone().text());
    assert.equal((await read<{ test: { wrote: boolean } }>(moved)).test.wrote, true);
    assert.deepEqual((await readConfig(library.state))?.media, { kind: 'folder', path: elsewhere });
    // The server reads the new folder without being started again.
    await writeFile(join(elsewhere, 'manifest.json'), '{"version":1,"published":"x","files":{}}');
    assert.equal((await call('/media/manifest.json')).status, 200);
    // A folder that cannot be written is not kept.
    const file = join(root, 'a-file');
    await writeFile(file, 'not a folder');
    const refused = await send('/api/settings/media', 'PUT', { kind: 'folder', path: file });
    assert.equal(refused.status, 422);
    assert.equal((await read<{ error: string }>(refused)).error, 'store-unreachable');
    assert.deepEqual((await readConfig(library.state))?.media, { kind: 'folder', path: elsewhere });
    const tested = await read<{ reached: boolean; wrote: boolean; library?: object }>(
      await call('/api/settings/media/test', { method: 'POST' }),
    );
    assert.deepEqual([tested.reached, tested.wrote, Boolean(tested.library)], [true, true, true]);
  });

  test('name the provider, keep its secret write-only, and take it away', async () => {
    const { send, call, library } = await machine();
    const set = await send('/api/settings/sign-in', 'PUT', {
      provider: 'google',
      clientId: 'client-1.apps.googleusercontent.com',
      allowedDomains: ['Example.org'],
      secret: 'the-client-secret',
    });
    assert.equal(set.status, 204, await set.clone().text());
    const shown = await read<{
      signIn: { clientId: string; allowedDomains: string[]; secret: { set: boolean } };
    }>(await call('/api/settings'));
    assert.equal(shown.signIn.clientId, 'client-1.apps.googleusercontent.com');
    assert.deepEqual(shown.signIn.allowedDomains, ['example.org']);
    assert.equal(shown.signIn.secret.set, true);
    assert.doesNotMatch(JSON.stringify(shown), /the-client-secret/);
    // A secret left out keeps the one kept.
    const again = await send('/api/settings/sign-in', 'PUT', {
      provider: 'google',
      clientId: 'client-2.apps.googleusercontent.com',
    });
    assert.equal(again.status, 204);
    assert.equal(await library.vault.get('oidc'), 'the-client-secret');
    const me = await read<{ provider: { kind: string } }>(await call('/api/me'));
    assert.equal(me.provider.kind, 'google');
    assert.equal((await call('/api/settings/sign-in', { method: 'DELETE' })).status, 204);
    assert.equal(await library.vault.get('oidc'), undefined);
    assert.equal((await read<{ signIn: unknown }>(await call('/api/settings'))).signIn, null);
  });

  test('set the limits and the address, and record each change', async () => {
    const { send, call, library } = await machine();
    assert.equal(
      (await send('/api/settings/limits', 'PUT', { pending: 5, tokens: 0 })).status,
      400,
    );
    assert.equal((await send('/api/settings/limits', 'PUT', { pending: 5 })).status, 204);
    assert.equal(
      (await read<{ limits: { pending: number; tokens: number } }>(await call('/api/settings')))
        .limits.pending,
      5,
    );
    assert.equal(
      (await send('/api/settings/library', 'PUT', { url: 'https://library.example.org/' })).status,
      204,
    );
    assert.equal((await readConfig(library.state))?.url, 'https://library.example.org/');
    const actions = (await readAudit(library.state)).map((entry) => entry.action).reverse();
    assert.deepEqual(actions, ['settings.limits', 'settings.library']);
  });
});

describe('an R2 bucket, from a machine', () => {
  test('is tried, with the token that empties its cache, before it is kept', async () => {
    const { send, library, source, call } = await machine();
    const purges: string[] = [];
    s3StandIn(async (request) => {
      // Cloudflare's purge of the zone's cache, by its token.
      purges.push(request.headers.get('Authorization') ?? '');
      // Read: the stand-in keeps a copy of each request, and a copy's half is never cancelled.
      await request.text();
      return request.headers.get('Authorization') === 'Bearer the-purge-token'
        ? Response.json({ success: true })
        : Response.json(
            { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
            { status: 403 },
          );
    });
    mock.method(console, 'error', () => {});
    const r2 = {
      kind: 'r2',
      accountId: R2_ACCOUNT,
      bucket: 'slidr-media',
      publicUrl: 'https://media.example.org/',
      zoneId: 'f'.repeat(32),
    };
    const refused = await send('/api/settings/media', 'PUT', {
      ...r2,
      key: { ...R2_CREDENTIALS, purgeToken: 'not-it' },
    });
    assert.equal(refused.status, 422);
    assert.equal((await read<{ error: string }>(refused)).error, 'purge-refused');
    assert.notEqual((await readConfig(library.state))?.media?.kind, 'r2');
    const kept = await send('/api/settings/media', 'PUT', {
      ...r2,
      key: { ...R2_CREDENTIALS, purgeToken: 'the-purge-token' },
    });
    assert.equal(kept.status, 200, await kept.clone().text());
    assert.deepEqual((await readConfig(library.state))?.media, r2);
    assert.deepEqual(JSON.parse((await library.vault.get('media'))!), {
      ...R2_CREDENTIALS,
      purgeToken: 'the-purge-token',
    });
    assert.deepEqual(purges, ['Bearer not-it', 'Bearer the-purge-token']);
    // Installed apps read the bucket at its domain, and a publication empties its cache.
    const ctx = await source();
    assert.equal(ctx.publicUrl, 'https://media.example.org/');
    assert.ok(ctx.purge);
    const settings = await read<{ media: { address: string; key: { set: boolean } } }>(
      await call('/api/settings'),
    );
    assert.deepEqual(
      [settings.media.address, settings.media.key.set],
      ['https://media.example.org/', true],
    );
    assert.doesNotMatch(JSON.stringify(settings), /a-secret-of-the-test|the-purge-token/);
  });
});

describe('the settings, on Cloudflare', () => {
  test('are an admin’s, and leave the media and the address to the host', async () => {
    const owner = await caller();
    const someone = await caller({ email: 'someone@example.com' }, owner.bucket);
    assert.equal(
      (await read<{ error: string }>(await someone.call('/api/settings'))).error,
      'not-an-admin',
    );
    const settings = await read<{
      editable: { url: boolean; media: boolean; signIn: boolean };
      signIn: { provider: string; host: boolean };
    }>(await owner.call('/api/settings'));
    assert.deepEqual(settings.editable, { url: false, media: false, signIn: false });
    // The Worker's own Google client, until the library names a provider.
    assert.deepEqual([settings.signIn.provider, settings.signIn.host], ['google', true]);
    for (const [path, body] of [
      ['/api/settings/media', { kind: 'folder', path: '/x' }],
      ['/api/settings/library', { url: 'https://x.example/' }],
      ['/api/settings/sign-in', { provider: 'google', clientId: 'c', secret: 's' }],
    ] as const) {
      const answer = await owner.send(path, 'PUT', body);
      assert.equal(answer.status, 409, path);
      assert.equal((await read<{ error: string }>(answer)).error, 'host', path);
    }
  });
});
