/**
 * A local library (docs/SPEC.md §5.1): its data folder, installed once, and opened each time the
 * server starts.
 *
 *   <data>/host.json      where its master key is (`master.ts`), and its media folder; nothing
 *                         secret
 *   <data>/state/         its state store (`state.ts`): settings, people, sealed keys, uploads
 *
 * The media folder is the host's, named once at install (docs/SPEC.md D13): `/library/media` in
 * the image, a folder of the machine's own disks mounted there. The data folder is its owner's
 * only (mode 0700).
 */
import { chmod, mkdir, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { audit } from '../../core/audit.ts';
import { readConfig, writeConfig, type LibraryConfig } from '../../core/config.ts';
import type { Context, Room } from '../../core/context.ts';
import { openLease } from '../../core/media/lease.ts';
import { sweep } from '../../core/media/sweep.ts';
import { emailOf, isEmail, writePerson } from '../../core/people.ts';
import { Vault, masterKeyText, newMasterKey, randomKey } from '../../core/vault.ts';
import { masterKeysOf, type MasterKeys, type MasterSource } from './master.ts';
import {
  ImportRefused,
  MOST_BATCH,
  importLibrary,
  type Imported,
} from '../../core/media/import.ts';
import { FolderMedia } from './media.ts';
import { FolderBucket } from './state.ts';

export interface HostFile {
  version: 1;
  master: MasterSource;
  /** The media folder, by its absolute path; none, and the library has no media yet. */
  media?: string;
}

const HOST = 'host.json';

/** A library that is not where it was looked for, or cannot be opened. */
export class LibraryError extends Error {}

/**
 * The data folder of a local library: `SLIDR_LIBRARY_DATA` (`/library/data` in the image), or a
 * folder of the user's, for a run from the source.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SLIDR_LIBRARY_DATA) return resolve(env.SLIDR_LIBRARY_DATA);
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'slidr-library');
}

/**
 * Makes a folder its owner's only. What could not be done is answered in words, and the install
 * goes on: the folder holds no key in clear.
 */
export async function restrictFolder(dir: string): Promise<string | undefined> {
  try {
    await chmod(dir, 0o700);
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
  /** The media folder, where the published library is kept. */
  media?: string;
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

/** A folder by its one true name, through links, and in Windows in its own case of letters. */
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
  const media = options.media ? resolve(options.media) : undefined;
  if (media) apartFromData(data, media);
  if (typeof options.master === 'object') {
    keyApart(options.master.file, [data, ...(media ? [media] : [])]);
  }
  const warnings: string[] = [];
  const restricted = await restrictFolder(data);
  if (restricted) warnings.push(restricted);
  if (media) await mkdir(media, { recursive: true });

  const keys = options.keys ?? masterKeysOf(options.master);
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
  });
  await writePerson(state, { email: owner, role: 'owner', added: now, by: 'install' });
  await openLease(state);
  const host: HostFile = { version: 1, master: options.master, ...(media ? { media } : {}) };
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

/**
 * Opens the library installed in a data folder. A key of a media store that a version of before
 * kept (`media`, 2026-10-25) is taken away: a local library's media has none.
 */
export async function openLibrary(dataDir: string, keys?: MasterKeys): Promise<Library> {
  let data = resolve(dataDir);
  let host: HostFile;
  try {
    data = await realFolder(data);
    host = JSON.parse(await readFile(join(data, HOST), 'utf8')) as HostFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LibraryError(`No library is installed at ${data}. Install one: slidr-library init`);
    }
    throw error;
  }
  const masterKeys = keys ?? masterKeysOf(host.master);
  const held = await masterKeys.read();
  if (held.length === 0) {
    throw new LibraryError(`The library's master key is not in ${masterKeys.where}.`);
  }
  const state = new FolderBucket(join(data, 'state'));
  const config = await readConfig(state);
  if (!config) throw new LibraryError(`The library at ${data} has no settings: install it again.`);
  const vault = new Vault(state, held);
  if (await vault.about('media')) {
    await vault.remove('media');
    await audit(state, { by: 'cli', action: 'vault.removed', target: 'media' });
  }
  return { data, host, keys: masterKeys, state, vault, config };
}

/** A folder as the system names it, through the part of it that is there. */
function realFolderSync(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(path);
      rest.push(basename(at));
      at = up;
    }
  }
}

/** Whether a folder is another, or inside it. */
const within = (folder: string, outer: string) => {
  const path = relative(outer, folder);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

/**
 * Throws for a media folder that is the library's data folder, in it, or holds it: its files are
 * published, and a publication writes it, so it is never where the library keeps itself.
 */
export function apartFromData(data: string, folder: string) {
  const media = realFolderSync(folder);
  const own = realFolderSync(data);
  if (within(media, own) || within(own, media)) {
    throw new LibraryError(
      `The media folder is apart from the library's own data (${own}): neither in it, nor holding it.`,
    );
  }
}

/**
 * Throws for a master key file inside the data folder or the media folder: a copy of either, or
 * the media that every app reads, would then hold the key that opens every other.
 */
function keyApart(file: string, folders: string[]) {
  const key = realFolderSync(file);
  for (const folder of folders) {
    if (within(key, realFolderSync(folder))) {
      throw new LibraryError(
        `The master key is kept apart from the library's data and its media: ${key} is in ${folder}.`,
      );
    }
  }
}

/** The disk a folder is on: its size, and what is free of it. */
async function roomOf(folder: string): Promise<Room> {
  const disk = await statfs(folder);
  return { size: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize };
}

/**
 * What the server is given, of a local library. Its admins are shown the media folder by the
 * name the install gave it on the machine (`LIBRARY_MEDIA_SHOWN`), since the container sees it
 * only as `/library/media`.
 */
export function contextOf(library: Library, env: NodeJS.ProcessEnv = process.env): Context {
  const folder = library.host.media;
  if (folder) apartFromData(library.data, folder);
  // The session key is the vault's, read as each request needs it (`sessionKeyOf`); the owner
  // signs in by a link of the CLI.
  return {
    state: library.state,
    vault: library.vault,
    ...(folder
      ? {
          media: new FolderMedia(folder),
          mediaFolder: { path: env.LIBRARY_MEDIA_SHOWN || folder, room: () => roomOf(folder) },
        }
      : {}),
    auth: {},
    local: true,
  };
}

/**
 * Seals every key of the library under a new master key (`slidr-library vault rotate`). The new
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

/**
 * Copies a published library into the library's media folder, while it holds none
 * (`slidr-library seed`; docs/SPEC.md §4.5): every file, checked against the site's manifest, a
 * batch at a time, and the manifest last. A file already there with its bytes is not copied
 * again, so a seed that stopped goes on where it was.
 */
export async function seed(
  ctx: Context,
  from: string,
  progress: (step: Imported) => void = () => undefined,
): Promise<Imported> {
  if (!ctx.media) {
    throw new LibraryError('The library has no media folder to seed: install it with one.');
  }
  let idle = 0;
  for (;;) {
    let step: Imported;
    try {
      step = await importLibrary(ctx.media, from, MOST_BATCH);
    } catch (error) {
      if (error instanceof ImportRefused) throw new LibraryError(error.message);
      throw error;
    }
    progress(step);
    if (step.done) {
      if (ctx.state) await openLease(ctx.state);
      return step;
    }
    idle = step.copied === 0 ? idle + 1 : 0;
    if (idle >= 3) {
      throw new LibraryError(
        `Nothing was copied three times running: ${step.failed.map((one) => `${one.path}: ${one.message}`).join('; ')}`,
      );
    }
  }
}

/**
 * Runs the library's jobs (`sweep.ts`) every `every` milliseconds, one round at a time, until
 * stopped: in a local library, the process's own timer does what a Cron Trigger does on
 * Cloudflare.
 */
export function sweeping(source: () => Promise<Context>, every = 60_000) {
  let running: Promise<void> | undefined;
  const round = () => {
    running ??= (async () => {
      try {
        const { outcome } = await sweep(await source());
        if (outcome?.failed) console.warn(`The sweep wrote nothing: ${outcome.failed.message}`);
      } catch (error) {
        console.error(
          `The sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const timer = setInterval(() => void round(), every);
  timer.unref();
  return { round, stop: () => clearInterval(timer) };
}
