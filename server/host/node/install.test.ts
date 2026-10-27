import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { readAudit } from '../../core/audit.ts';
import { sessionKeyOf } from '../../core/auth.ts';
import { readConfig } from '../../core/config.ts';
import { readPerson } from '../../core/people.ts';
import { masterKeyText, newMasterKey } from '../../core/vault.ts';
import {
  LibraryError,
  contextOf,
  defaultDataDir,
  install,
  openLibrary,
  rotate,
} from './install.ts';
import { envKeys, fileKeys, memoryKeys } from './master.ts';

const folders: string[] = [];
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-install-'));
  folders.push(folder);
  return folder;
}

/** Where host.json says the master key is, when the tests keep it in memory. */
const KEPT = { file: join(tmpdir(), 'slidr-library-tests', 'master.key') };

/** Every file under a folder, with its bytes. */
async function filesUnder(folder: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path, await readFile(path));
  }
  return files;
}

describe('installing a library', () => {
  test('makes its data folder: its settings, its owner, its keys, and its media folder', async () => {
    const root = await newFolder();
    const data = join(root, 'data');
    const keys = memoryKeys();
    const installed = await install({
      data,
      owner: ' Owner@Example.org ',
      master: KEPT,
      keys,
      media: join(root, 'media'),
    });
    assert.equal(installed.owner, 'owner@example.org');
    assert.deepEqual(installed.warnings, []);
    assert.equal(keys.held.length, 1);
    assert.ok((await stat(join(root, 'media'))).isDirectory());
    if (process.platform !== 'win32') assert.equal((await stat(data)).mode & 0o777, 0o700);

    const library = await openLibrary(data, keys);
    // The media folder is the host's, not a setting of the library.
    assert.deepEqual(library.host, { version: 1, master: KEPT, media: join(root, 'media') });
    const config = await readConfig(library.state);
    assert.equal('media' in (config ?? {}), false);
    assert.equal((await readPerson(library.state, 'OWNER@example.org'))?.role, 'owner');
    const session = await library.vault.get('session');
    assert.ok(session && session.length >= 43);
    const ctx = contextOf(library);
    assert.equal(ctx.local, true);
    assert.equal(await sessionKeyOf(ctx), session);
    assert.equal(ctx.mediaFolder?.path, join(root, 'media'));
    const room = await ctx.mediaFolder?.room();
    assert.ok(room && room.size > 0 && room.free >= 0 && room.free <= room.size);
    // Its admins are shown the folder by the name the machine gives it, not the container.
    const shown = contextOf(library, { LIBRARY_MEDIA_SHOWN: '/srv/slidr-media' });
    assert.equal(shown.mediaFolder?.path, '/srv/slidr-media');
  });

  test('keeps no key in clear in its folder', async () => {
    const data = await newFolder();
    const keys = memoryKeys();
    await install({ data, owner: 'owner@example.org', master: KEPT, keys });
    const session = (await (await openLibrary(data, keys)).vault.get('session'))!;
    const master = masterKeyText(keys.held[0]!);
    for (const [path, bytes] of await filesUnder(data)) {
      const text = bytes.toString('utf8');
      assert.ok(!text.includes(session), `${path} holds the session key`);
      assert.ok(!text.includes(master), `${path} holds the master key`);
    }
  });

  test('is done once in a folder, for an owner by an address', async () => {
    const data = await newFolder();
    await install({ data, owner: 'owner@example.org', master: KEPT, keys: memoryKeys() });
    await assert.rejects(
      install({ data, owner: 'owner@example.org', master: KEPT, keys: memoryKeys() }),
      /installed at .* already/,
    );
    await assert.rejects(
      install({ data: await newFolder(), owner: 'owner', master: KEPT, keys: memoryKeys() }),
      LibraryError,
    );
  });

  test('keeps the media folder apart from its own data', async () => {
    const root = await newFolder();
    const data = join(root, 'data');
    for (const media of [data, join(data, 'media'), root]) {
      await assert.rejects(
        install({ data, owner: 'owner@example.org', master: KEPT, keys: memoryKeys(), media }),
        /apart from the library/,
        media,
      );
    }
  });

  test('takes its master key from LIBRARY_MASTER_KEY, which it never writes', async () => {
    const data = await newFolder();
    const none = envKeys({});
    await assert.rejects(
      install({ data, owner: 'owner@example.org', master: 'env', keys: none }),
      /LIBRARY_MASTER_KEY is not set. Set it to a new key, such as \S{43}/,
    );
    const key = await newMasterKey();
    const keys = envKeys({ LIBRARY_MASTER_KEY: masterKeyText(key) });
    await install({ data, owner: 'owner@example.org', master: 'env', keys });
    const library = await openLibrary(data, keys);
    assert.equal(library.vault.current.id, key.id);
    await assert.rejects(rotate(library), /set it to a new key yourself/);
  });

  test('keeps its master key in a file apart from its data and its media', async () => {
    const root = await newFolder();
    const file = join(root, 'keys', 'master.key');
    await install({
      data: join(root, 'data'),
      owner: 'owner@example.org',
      master: { file },
      media: join(root, 'media'),
    });
    const text = (await readFile(file, 'utf8')).trim();
    assert.match(text, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, 'keys'))).mode & 0o777, 0o700);
    }
    const library = await openLibrary(join(root, 'data'));
    assert.ok(await library.vault.get('session'));
    // Inside the data folder, or the media every app reads, a key would open every other.
    for (const [data, inside] of [
      ['data-2', join(root, 'data-2', 'master.key')],
      ['data-3', join(root, 'media-3', 'keys', 'master.key')],
    ] as const) {
      await assert.rejects(
        install({
          data: join(root, data),
          owner: 'owner@example.org',
          master: { file: inside },
          media: join(root, 'media-3'),
        }),
        /kept apart from the library's data and its media/,
      );
    }
  });
});

describe('a library installed', () => {
  test('is not opened where there is none, nor without its master key', async () => {
    const data = await newFolder();
    await assert.rejects(openLibrary(data, memoryKeys()), /No library is installed at/);
    await install({ data, owner: 'owner@example.org', master: KEPT, keys: memoryKeys() });
    await assert.rejects(openLibrary(data, memoryKeys()), /master key is not in memory/);
  });

  test('seals its keys again under a new master key', async () => {
    const data = await newFolder();
    const keys = memoryKeys();
    await install({ data, owner: 'owner@example.org', master: KEPT, keys });
    const before = await openLibrary(data, keys);
    const session = await before.vault.get('session');
    const old = keys.held[0]!.id;
    assert.deepEqual(await rotate(before), ['session']);
    assert.equal(keys.held.length, 1);
    assert.notEqual(keys.held[0]!.id, old);
    assert.equal(await (await openLibrary(data, keys)).vault.get('session'), session);
  });

  test('opens after a rotation of its key file that stopped half way', async () => {
    const root = await newFolder();
    const file = join(root, 'keys', 'master.key');
    const data = join(root, 'data');
    await install({ data, owner: 'owner@example.org', master: { file } });
    const library = await openLibrary(data);
    const session = await library.vault.get('session');
    // The next key beside the old one, every key sealed under it, and then the rotation stops.
    const next = await newMasterKey();
    await fileKeys(file).writeNext(next);
    await library.vault.rotate(next);
    const stopped = await openLibrary(data);
    assert.equal(await stopped.vault.get('session'), session);
    // A rotation run again finishes it, and leaves one key.
    await rotate(stopped);
    assert.equal((await fileKeys(file).read()).length, 1);
    assert.equal(await (await openLibrary(data)).vault.get('session'), session);
  });

  test('loses the key of a media store that a version of before kept', async () => {
    const data = await newFolder();
    const keys = memoryKeys();
    await install({ data, owner: 'owner@example.org', master: KEPT, keys });
    await (await openLibrary(data, keys)).vault.set('media', '{"password":"kept"}', 'owner');
    const library = await openLibrary(data, keys);
    assert.deepEqual(await library.vault.names(), ['session']);
    const [last] = await readAudit(library.state);
    assert.deepEqual([last?.action, last?.target], ['vault.removed', 'media']);
  });

  test(
    'names its folder by its real name, however it is spelled',
    { skip: process.platform !== 'win32' && 'Windows takes a path in any case' },
    async () => {
      const data = await newFolder();
      const keys = memoryKeys();
      const installed = await install({
        data: data.toUpperCase(),
        owner: 'owner@example.org',
        master: KEPT,
        keys,
      });
      assert.equal(installed.data, await realpath(data));
      assert.equal((await openLibrary(data.toLowerCase(), keys)).data, installed.data);
    },
  );

  test('lives in the folder the image names, or one of its user', () => {
    assert.equal(defaultDataDir({ XDG_DATA_HOME: '/srv' }), join('/srv', 'slidr-library'));
    assert.match(defaultDataDir({ SLIDR_LIBRARY_DATA: 'here' }), /here$/);
  });
});
