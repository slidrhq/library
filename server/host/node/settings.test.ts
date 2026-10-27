import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { readAudit } from '../../core/audit.ts';
import { issueLocalLink } from '../../core/auth.ts';
import type { Context } from '../../core/context.ts';
import { handle } from '../../core/index.ts';
import { caller } from '../../core/uploads/testing.ts';
import { contextOf, install, openLibrary } from './install.ts';
import { memoryKeys } from './master.ts';

const folders: string[] = [];
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));

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
    master: { file: join(root, 'keys', 'master.key') },
    keys,
    media: join(root, 'media'),
  });
  const library = await openLibrary(join(root, 'data'), keys);
  const context = contextOf(library);
  const at = (ctx: Context): Context => ({ ...ctx, clientAddress: '127.0.0.1' });
  const code = await issueLocalLink(context, 'owner@example.org');
  const signedIn = await handle(new Request(`${SITE}/auth/local?code=${code}`), at(context));
  const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
  const call = async (path: string, init: RequestInit = {}) =>
    handle(
      new Request(SITE + path, {
        ...init,
        headers: { Cookie: cookie, Origin: SITE, ...(init.headers as object) },
      }),
      at(context),
    );
  const send = (path: string, method: string, body: unknown) =>
    call(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { root, library, call, send };
}

describe('the settings, on a machine', () => {
  test('are shown to an admin, every key only as set or not', async () => {
    const { root, call } = await machine();
    const settings = await read<{
      editable: { signIn: boolean };
      media: { kind: string; path: string; room: { size: number; free: number }; address: string };
      signIn: unknown;
      limits: { pending: number };
    }>(await call('/api/settings'));
    assert.deepEqual(settings.editable, { signIn: true });
    assert.equal(settings.media.kind, 'folder');
    assert.equal(settings.media.path, join(root, 'media'));
    assert.ok(settings.media.room.size >= settings.media.room.free);
    assert.equal(settings.signIn, null);
    assert.equal(settings.limits.pending, 20);
    // Installed apps read the library from this server, at /media/.
    assert.equal(settings.media.address, `${SITE}/media/`);
  });

  test('test the media folder, which is the install’s and is not changed here', async () => {
    const { root, send, call } = await machine();
    const test = async () =>
      read<{ reached: boolean; wrote: boolean; library?: { files: number } }>(
        await call('/api/settings/media/test', { method: 'POST' }),
      );
    const empty = await test();
    assert.deepEqual([empty.reached, empty.wrote, empty.library], [true, true, undefined]);
    await writeFile(
      join(root, 'media', 'manifest.json'),
      '{"version":1,"published":"x","files":{}}',
    );
    assert.deepEqual((await test()).library, { published: 'x', files: 0 });
    // The folder, and the address, are named by the host: no route changes them.
    const elsewhere = { kind: 'folder', path: join(root, 'elsewhere') };
    assert.equal((await send('/api/settings/media', 'PUT', elsewhere)).status, 404);
    assert.equal(
      (await send('/api/settings/library', 'PUT', { url: 'https://x.example/' })).status,
      404,
    );
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
    // A secret left out keeps the one kept, for the same client; another client brings its own.
    const again = await send('/api/settings/sign-in', 'PUT', {
      provider: 'google',
      clientId: 'client-1.apps.googleusercontent.com',
      allowedDomains: ['example.org', 'example.com'],
    });
    assert.equal(again.status, 204);
    assert.equal(await library.vault.get('oidc'), 'the-client-secret');
    const other = await send('/api/settings/sign-in', 'PUT', {
      provider: 'oidc',
      issuer: 'https://sso.attacker.example/',
      clientId: 'client-1.apps.googleusercontent.com',
      name: 'Staff',
    });
    assert.equal(other.status, 400);
    // Microsoft by one tenant only, and a provider over HTTPS only.
    for (const body of [
      { provider: 'microsoft', tenant: 'organizations', clientId: 'c', secret: 's' },
      { provider: 'microsoft', clientId: 'c', secret: 's' },
      {
        provider: 'oidc',
        issuer: 'http://sso.example.org/',
        clientId: 'c',
        name: 'S',
        secret: 's',
      },
    ]) {
      assert.equal((await send('/api/settings/sign-in', 'PUT', body)).status, 400);
    }
    const me = await read<{ provider: { kind: string } }>(await call('/api/me'));
    assert.equal(me.provider.kind, 'google');
    assert.equal((await call('/api/settings/sign-in', { method: 'DELETE' })).status, 204);
    assert.equal(await library.vault.get('oidc'), undefined);
    assert.equal((await read<{ signIn: unknown }>(await call('/api/settings'))).signIn, null);
  });

  test('set the limits, and record each change', async () => {
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
    const actions = (await readAudit(library.state)).map((entry) => entry.action);
    assert.deepEqual(actions, ['settings.limits']);
  });
});

describe('the settings, on Cloudflare', () => {
  test('let the owner alone name how people sign in', async () => {
    const owner = await caller();
    const someone = await caller({ email: 'someone@example.com' }, owner.bucket);
    assert.equal(
      (await owner.send('/api/members/someone%40example.com', 'PUT', { role: 'admin' })).status,
      200,
    );
    const google = { provider: 'google', clientId: 'c', secret: 's' };
    const admin = await someone.send('/api/settings/sign-in', 'PUT', google);
    assert.equal(admin.status, 403);
    assert.equal((await read<{ error: string }>(admin)).error, 'not-the-owner');
    // The owner is let through, to be told the Worker keeps no keys without its master key.
    assert.equal((await owner.send('/api/settings/sign-in', 'PUT', google)).status, 409);
  });

  test('are an admin’s, and leave the media and the address to the host', async () => {
    const owner = await caller();
    const someone = await caller({ email: 'someone@example.com' }, owner.bucket);
    assert.equal(
      (await read<{ error: string }>(await someone.call('/api/settings'))).error,
      'not-an-admin',
    );
    const settings = await read<{
      editable: { signIn: boolean };
      media: { kind: string; path?: string };
      signIn: { provider: string; host: boolean };
    }>(await owner.call('/api/settings'));
    assert.deepEqual(settings.editable, { signIn: false });
    // This Worker of the tests has no bucket; it would be the binding `MEDIA`, never a folder.
    assert.equal(settings.media.kind, 'none');
    assert.equal(settings.media.path, undefined);
    // The Worker's own Google client, until the library names a provider.
    assert.deepEqual([settings.signIn.provider, settings.signIn.host], ['google', true]);
    for (const [path, body] of [
      ['/api/settings/media', { kind: 'folder', path: '/x' }],
      ['/api/settings/library', { url: 'https://x.example/' }],
    ] as const) {
      assert.equal((await owner.send(path, 'PUT', body)).status, 404, path);
    }
    const google = { provider: 'google', clientId: 'c', secret: 's' };
    const answer = await owner.send('/api/settings/sign-in', 'PUT', google);
    assert.equal(answer.status, 409);
    assert.equal((await read<{ error: string }>(answer)).error, 'host');
  });
});
