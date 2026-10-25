import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, test } from 'node:test';
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
  test('makes its data folder: its settings, its owner, its keys', async () => {
    const root = await newFolder();
    const data = join(root, 'data');
    const keys = memoryKeys();
    const installed = await install({
      data,
      owner: ' Owner@Example.org ',
      master: 'keychain',
      keys,
      media: { kind: 'folder', path: join(root, 'media') },
    });
    assert.equal(installed.owner, 'owner@example.org');
    assert.deepEqual(installed.warnings, []);
    assert.equal(keys.held.length, 1);
    assert.ok((await stat(join(root, 'media'))).isDirectory());
    if (process.platform === 'win32') {
      // One entry, the installer's, and none inherited from the folders above.
      const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
      const { stdout } = await promisify(execFile)(icacls, [data]);
      const entries = stdout.split(/\r?\n/).filter((line) => /:\(/.test(line));
      assert.equal(entries.length, 1, stdout);
      assert.doesNotMatch(stdout, /\(I\)/);
    } else {
      assert.equal((await stat(data)).mode & 0o777, 0o700);
    }

    const library = await openLibrary(data, keys);
    assert.deepEqual(library.host, { version: 1, master: 'keychain' });
    const config = await readConfig(library.state);
    assert.equal(config?.media?.kind, 'folder');
    assert.equal(config?.media?.path, join(root, 'media'));
    assert.equal((await readPerson(library.state, 'OWNER@example.org'))?.role, 'owner');
    const session = await library.vault.get('session');
    assert.ok(session && session.length >= 43);
    const ctx = await contextOf(library);
    assert.equal(ctx.local, true);
    assert.equal(await sessionKeyOf(ctx), session);
  });

  test('keeps no key in clear in its folder', async () => {
    const data = await newFolder();
    const keys = memoryKeys();
    await install({ data, owner: 'owner@example.org', master: 'keychain', keys });
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
    await install({ data, owner: 'owner@example.org', master: 'keychain', keys: memoryKeys() });
    await assert.rejects(
      install({ data, owner: 'owner@example.org', master: 'keychain', keys: memoryKeys() }),
      /installed at .* already/,
    );
    await assert.rejects(
      install({ data: await newFolder(), owner: 'owner', master: 'keychain', keys: memoryKeys() }),
      LibraryError,
    );
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

  test('keeps its master key in a file, when it is told to', async () => {
    const root = await newFolder();
    const file = join(root, 'secret', 'master.key');
    const keys = fileKeys(file);
    await install({ data: join(root, 'data'), owner: 'owner@example.org', master: { file }, keys });
    const text = (await readFile(file, 'utf8')).trim();
    assert.match(text, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    const library = await openLibrary(join(root, 'data'));
    assert.ok(await library.vault.get('session'));
  });
});

describe('a library installed', () => {
  test('is not opened where there is none, nor without its master key', async () => {
    const data = await newFolder();
    await assert.rejects(openLibrary(data, memoryKeys()), /No library is installed at/);
    await install({ data, owner: 'owner@example.org', master: 'keychain', keys: memoryKeys() });
    await assert.rejects(openLibrary(data, memoryKeys()), /master key is not in memory/);
  });

  test('seals its keys again under a new master key', async () => {
    const data = await newFolder();
    const keys = memoryKeys();
    await install({ data, owner: 'owner@example.org', master: 'keychain', keys });
    const before = await openLibrary(data, keys);
    const session = await before.vault.get('session');
    const old = keys.held[0]!.id;
    assert.deepEqual(await rotate(before), ['session']);
    assert.equal(keys.held.length, 1);
    assert.notEqual(keys.held[0]!.id, old);
    assert.equal(await (await openLibrary(data, keys)).vault.get('session'), session);
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
        master: 'keychain',
        keys,
      });
      assert.equal(installed.data, await realpath(data));
      assert.equal((await openLibrary(data.toLowerCase(), keys)).data, installed.data);
    },
  );

  test('lives in a folder of its user by default', () => {
    assert.equal(
      defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32'),
      join('C:\\Users\\a\\AppData\\Local', 'Slidr Library'),
    );
    assert.match(
      defaultDataDir({}, 'darwin'),
      /Library[\\/]Application Support[\\/]Slidr Library$/,
    );
    assert.equal(defaultDataDir({ XDG_DATA_HOME: '/srv' }, 'linux'), join('/srv', 'slidr-library'));
    assert.match(defaultDataDir({ SLIDR_LIBRARY_DATA: 'here' }, 'linux'), /here$/);
  });
});
