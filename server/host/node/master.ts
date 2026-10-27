/**
 * Where a local library keeps its master key (docs/SPEC.md §4.4), the key its vault seals every
 * other key under. Never in the data folder; `host.json` names which of these it is:
 *
 * - a file the installer named (`--master-key-file`), readable by its owner only, in a folder
 *   apart from the data folder: `/library/keys/master.key` in the image, a folder of the machine
 *   mounted there;
 * - `env`: `LIBRARY_MASTER_KEY`, set by whoever runs the server, for the tests and a run from the
 *   source.
 *
 * While a rotation runs, the next key is kept apart beside the current one (`.next`), so a
 * rotation stopped half way loses no key (`Vault` opens a key under either).
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { masterKeyFromText, masterKeyText, type MasterKey } from '../../core/vault.ts';

export type MasterSource = 'env' | { file: string };

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

export const MASTER_ENV = 'LIBRARY_MASTER_KEY';

/** Thrown where a master key cannot be kept: a key set by hand. */
export class MasterKeyError extends Error {}

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
  // Written whole under another name, then renamed into place: a key is never half there.
  const writeOne = async (at: string, key: MasterKey) => {
    await mkdir(dirname(at), { recursive: true, mode: 0o700 });
    const temporary = `${at}.${process.pid}.tmp`;
    await writeFile(temporary, `${masterKeyText(key)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, at);
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

/** The master keys of a source. */
export function masterKeysOf(source: MasterSource): MasterKeys {
  return source === 'env' ? envKeys() : fileKeys(source.file);
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
