/**
 * A library on a machine (docs/SPEC.md §5.1): its data folder, installed once, and opened each
 * time the server starts.
 *
 *   <data>/host.json      where its master key is (`master.ts`); nothing secret
 *   <data>/state/         its state store (`state.ts`): settings, people, sealed keys, uploads
 *
 * The folder is its owner's only: on Windows its ACL grants the installing user alone, elsewhere
 * its mode is 0700.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  readConfig,
  writeConfig,
  type LibraryConfig,
  type MediaSettings,
} from '../../core/config.ts';
import type { Context } from '../../core/context.ts';
import { emailOf, isEmail, writePerson } from '../../core/people.ts';
import { Vault, masterKeyText, newMasterKey, randomKey } from '../../core/vault.ts';
import { masterKeysOf, type MasterKeys, type MasterSource } from './master.ts';
import { FolderBucket } from './state.ts';

export interface HostFile {
  version: 1;
  master: MasterSource;
}

const HOST = 'host.json';

/** A library that is not where it was looked for, or cannot be opened. */
export class LibraryError extends Error {}

/** The data folder of a library on this machine, unless `SLIDR_LIBRARY_DATA` names another. */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.SLIDR_LIBRARY_DATA) return resolve(env.SLIDR_LIBRARY_DATA);
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Slidr Library');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Slidr Library');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'slidr-library');
}

const run = promisify(execFile);

/** A program of Windows, by its own path: not whatever else of that name the PATH finds first. */
const windowsTool = (name: string) =>
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `${name}.exe`);

/**
 * Makes a folder its owner's only. What could not be done is answered in words, and the install
 * goes on: the folder holds no key in clear.
 */
export async function restrictFolder(dir: string): Promise<string | undefined> {
  try {
    if (process.platform !== 'win32') {
      await chmod(dir, 0o700);
      return undefined;
    }
    const { stdout } = await run(windowsTool('whoami'), ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
    });
    const sid = /"(S-[0-9-]+)"/.exec(stdout)?.[1];
    if (!sid) return `The current user's SID could not be read; ${dir} keeps the access it had.`;
    await run(windowsTool('icacls'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], {
      windowsHide: true,
    });
    return undefined;
  } catch (error) {
    return `${dir} keeps the access it had: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface InstallOptions {
  /** The data folder. */
  data: string;
  /** The installer, who becomes the library's owner. */
  owner: string;
  /** Where the published library is kept. */
  media?: MediaSettings;
  /** The address the library is reached at, when not only on this machine. */
  url?: string;
  /** Where the master key is kept. */
  master: MasterSource;
  /** The master keys themselves, when not where `master` says: the tests keep them in memory. */
  keys?: MasterKeys;
}

export interface Installed {
  data: string;
  owner: string;
  /** Where the master key is, in words. */
  master: string;
  /** What could not be done, in words, that did not stop the install. */
  warnings: string[];
}

/**
 * A folder by its one true name: Windows takes a path by its short name (`MOSHEW~1`), and in any
 * case of its letters, and the keychain keeps the master key under the folder's name.
 */
const realFolder = (path: string) => realpath(resolve(path));

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

/**
 * Installs a library into a data folder: its master key, its session key, its settings, and its
 * owner. `host.json` is written last, so a folder whose install stopped half way is installed
 * again from the start.
 */
export async function install(options: InstallOptions): Promise<Installed> {
  if (!isEmail(options.owner)) throw new LibraryError(`${options.owner} is not an email address.`);
  const owner = emailOf(options.owner);
  await mkdir(resolve(options.data), { recursive: true });
  const data = await realFolder(options.data);
  if (await exists(join(data, HOST))) {
    throw new LibraryError(`A library is installed at ${data} already.`);
  }
  const warnings: string[] = [];
  const restricted = await restrictFolder(data);
  if (restricted) warnings.push(restricted);

  let media = options.media;
  if (media?.kind === 'folder') {
    media = { ...media, path: resolve(media.path) };
    await mkdir(media.path, { recursive: true });
  }

  const keys = options.keys ?? masterKeysOf(options.master, data);
  let master;
  if (options.master === 'env') {
    master = (await keys.read())[0];
    if (!master) {
      const example = masterKeyText(await newMasterKey());
      throw new LibraryError(
        `LIBRARY_MASTER_KEY is not set. Set it to a new key, such as ${example}, and keep it.`,
      );
    }
  } else {
    master = await newMasterKey();
    await keys.write(master);
    await keys.writeNext(undefined);
  }

  const state = new FolderBucket(join(data, 'state'));
  const now = new Date().toISOString();
  await new Vault(state, [master]).set('session', randomKey(), 'install');
  await writeConfig(state, {
    version: 1,
    installed: now,
    ...(options.url ? { url: options.url } : {}),
    ...(media ? { media } : {}),
  });
  await writePerson(state, { email: owner, role: 'owner', added: now, by: 'install' });
  const host: HostFile = { version: 1, master: options.master };
  await writeFile(join(data, HOST), `${JSON.stringify(host, null, 2)}\n`);
  return { data, owner, master: keys.where, warnings };
}

export interface Library {
  data: string;
  host: HostFile;
  keys: MasterKeys;
  state: FolderBucket;
  vault: Vault;
  config: LibraryConfig;
}

/** Opens the library installed in a data folder. */
export async function openLibrary(dataDir: string, keys?: MasterKeys): Promise<Library> {
  let data = resolve(dataDir);
  let host: HostFile;
  try {
    data = await realFolder(data);
    host = JSON.parse(await readFile(join(data, HOST), 'utf8')) as HostFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LibraryError(`No library is installed at ${data}. Install one: pnpm library init`);
    }
    throw error;
  }
  const masterKeys = keys ?? masterKeysOf(host.master, data);
  const held = await masterKeys.read();
  if (held.length === 0) {
    throw new LibraryError(`The library's master key is not in ${masterKeys.where}.`);
  }
  const state = new FolderBucket(join(data, 'state'));
  const config = await readConfig(state);
  if (!config) throw new LibraryError(`The library at ${data} has no settings: install it again.`);
  return { data, host, keys: masterKeys, state, vault: new Vault(state, held), config };
}

/** What the server is given, of a library on this machine. */
export function contextOf(library: Library): Promise<Context> {
  // The session key is the vault's, read as each request needs it (`sessionKeyOf`); the owner
  // signs in on this machine by a link of the CLI.
  return Promise.resolve({ state: library.state, vault: library.vault, auth: {}, local: true });
}

/**
 * Seals every key of the library under a new master key (`pnpm library vault rotate`). The new
 * key is kept apart until every key is sealed under it, then becomes the current one.
 */
export async function rotate(library: Library): Promise<string[]> {
  const next = await newMasterKey();
  await library.keys.writeNext(next);
  const names = await library.vault.rotate(next);
  await library.keys.write(next);
  await library.keys.writeNext(undefined);
  return names;
}

const RUNNING = 'running.json';

interface Running {
  /** The address the library is reached at, and its own on this machine. */
  url: string;
  local?: string;
  pid: number;
}

/** Records where the server of a data folder listens, while it runs; none, that it stopped. */
export async function markRunning(data: string, running: Omit<Running, 'pid'> | undefined) {
  if (running) {
    await writeFile(join(data, RUNNING), JSON.stringify({ ...running, pid: process.pid }));
  } else await rm(join(data, RUNNING), { force: true });
}

/** Where the server of a data folder listens, when it runs. */
export async function running(data: string): Promise<Running | undefined> {
  try {
    const found = JSON.parse(await readFile(join(data, RUNNING), 'utf8')) as Running;
    // Throws when no such process runs: the server stopped without saying so.
    process.kill(found.pid, 0);
    return found;
  } catch {
    return undefined;
  }
}
