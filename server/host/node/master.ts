/**
 * Where a library on a machine keeps its master key (docs/SPEC.md §4.4), the key its vault seals
 * every other key under. Never in the data folder's store; `host.json` names which of these it is:
 *
 * - `keychain`, the default: the OS keychain (Windows Credential Manager, the macOS Keychain, the
 *   Secret Service), as the service `Slidr Library` and the data folder's path;
 * - `env`: `LIBRARY_MASTER_KEY`, for a server with no keychain, set by whoever runs it;
 * - a file the installer named (`--master-key-file`), readable by its owner only.
 *
 * While a rotation runs, the next key is kept apart beside the current one (`(next)`), so a
 * rotation stopped half way loses no key (`Vault` opens a key under either).
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AsyncEntry } from '@napi-rs/keyring';
import { masterKey, masterKeyFromText, masterKeyText, type MasterKey } from '../../core/vault.ts';

export type MasterSource = 'keychain' | 'env' | { file: string };

export interface MasterKeys {
  /** In words, for what the CLI says. */
  readonly where: string;
  /** The current key, then the next one while a rotation runs; none before one is written. */
  read(): Promise<MasterKey[]>;
  /** Keeps a key as the current one. */
  write(key: MasterKey): Promise<void>;
  /** Keeps the next key apart while a rotation runs; none forgets it. */
  writeNext(key: MasterKey | undefined): Promise<void>;
}

export const SERVICE = 'Slidr Library';
export const MASTER_ENV = 'LIBRARY_MASTER_KEY';

/** Thrown where a master key cannot be kept: no keychain, a key set by hand. */
export class MasterKeyError extends Error {}

/** The keychain's module, loaded only when the keychain is used: it is native code. */
async function keyring(): Promise<{ AsyncEntry: typeof AsyncEntry }> {
  try {
    return await import('@napi-rs/keyring');
  } catch (cause) {
    throw new MasterKeyError(
      `This machine's keychain cannot be reached (${String(cause)}). Keep the master key in ` +
        `${MASTER_ENV}, or in a file (--master-key-file).`,
    );
  }
}

/** The OS keychain, under the data folder's path. */
export function keychainKeys(data: string): MasterKeys {
  const account = resolve(data);
  const entry = async (next: boolean) =>
    new (await keyring()).AsyncEntry(SERVICE, next ? `${account} (next)` : account);
  const readOne = async (next: boolean) => {
    const bytes = await (await entry(next)).getSecret();
    return bytes ? masterKey(new Uint8Array(bytes)) : undefined;
  };
  return {
    where: `the keychain (${SERVICE}: ${account})`,
    async read() {
      return [await readOne(false), await readOne(true)].filter((key) => key !== undefined);
    },
    async write(key) {
      await (await entry(false)).setSecret(key.bytes);
    },
    async writeNext(key) {
      const next = await entry(true);
      if (key) await next.setSecret(key.bytes);
      else await next.deleteCredential();
    },
  };
}

/** `LIBRARY_MASTER_KEY`, which whoever runs the server sets, and so changes. */
export function envKeys(env: NodeJS.ProcessEnv = process.env): MasterKeys {
  const refuse = () =>
    Promise.reject(
      new MasterKeyError(
        `The master key is ${MASTER_ENV}, which you set: set it to a new key yourself.`,
      ),
    );
  return {
    where: MASTER_ENV,
    async read() {
      const text = env[MASTER_ENV];
      return text ? [await masterKeyFromText(text)] : [];
    },
    write: refuse,
    writeNext: refuse,
  };
}

/** A file, readable by its owner only, and the next key beside it while a rotation runs. */
export function fileKeys(file: string): MasterKeys {
  const path = resolve(file);
  const readOne = async (at: string) => {
    try {
      return await masterKeyFromText(await readFile(at, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const writeOne = async (at: string, key: MasterKey) => {
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, `${masterKeyText(key)}\n`, { mode: 0o600 });
    await chmod(at, 0o600);
  };
  return {
    where: path,
    async read() {
      return [await readOne(path), await readOne(`${path}.next`)].filter(
        (key) => key !== undefined,
      );
    },
    write: (key) => writeOne(path, key),
    async writeNext(key) {
      if (key) await writeOne(`${path}.next`, key);
      else await rm(`${path}.next`, { force: true });
    },
  };
}

/** The master keys of a source, for the data folder at `data`. */
export function masterKeysOf(source: MasterSource, data: string): MasterKeys {
  if (source === 'keychain') return keychainKeys(data);
  if (source === 'env') return envKeys();
  return fileKeys(source.file);
}

/** Keys kept in memory: for the tests. */
export function memoryKeys(): MasterKeys & { held: MasterKey[] } {
  let current: MasterKey | undefined;
  let next: MasterKey | undefined;
  return {
    where: 'memory',
    get held() {
      return [current, next].filter((key) => key !== undefined);
    },
    read: () => Promise.resolve([current, next].filter((key) => key !== undefined)),
    write(key) {
      current = key;
      return Promise.resolve();
    },
    writeNext(key) {
      next = key;
      return Promise.resolve();
    },
  };
}
