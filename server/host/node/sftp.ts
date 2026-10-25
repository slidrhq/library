/**
 * The published library in a folder of a server reached over SSH (docs/SPEC.md §4.5), with
 * `ssh2`: a `Remote` for `RemoteMedia`.
 *
 * - The server is known by its host key: its fingerprint (`SHA256:…`, as `ssh-keygen -l` shows
 *   it) is pinned in the settings once an admin confirmed it. Until then, and whenever the server
 *   shows another key, the connection stops before anything is sent of the key or the password,
 *   and says which key it was shown (`HostKeyError`).
 * - A private key (OpenSSH or PEM; Ed25519, ECDSA or RSA) with its passphrase, or a password.
 * - A file is written to a hidden name in its folder, then renamed over the file:
 *   `posix-rename@openssh.com`, which replaces at once, where the server has it; elsewhere the old
 *   file is taken away first, and for that moment the path has no file.
 * - One connection, made when needed, and let go after a minute without use.
 */
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import ssh2, { type Client, type SFTPWrapper, type Stats } from 'ssh2';
import type { Remote, RemoteFile } from './remote.ts';

export interface SftpSettings {
  host: string;
  port: number;
  user: string;
  root: string;
  hostKey?: string;
}

/** The store's key, as the vault keeps it (`media`). */
export interface SftpKey {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

/** The server showed a key the library does not know: never confirmed, or not the one confirmed. */
export class HostKeyError extends Error {
  readonly code: 'host-key-unconfirmed' | 'host-key-changed';
  readonly fingerprint: string;

  constructor(code: HostKeyError['code'], fingerprint: string) {
    super(
      code === 'host-key-changed'
        ? `The server's host key is not the one confirmed: it shows ${fingerprint}. Nothing is written until an admin confirms it.`
        : `The server's host key is ${fingerprint}: confirm it is the server's, and it is pinned.`,
    );
    this.code = code;
    this.fingerprint = fingerprint;
  }
}

/** A host key's fingerprint, as OpenSSH shows it. */
export const fingerprintOf = (key: Buffer) =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** What an SFTP server answers for a path that is not there. */
const NO_SUCH_FILE = 2;
const missing = (error: unknown) => (error as { code?: unknown }).code === NO_SUCH_FILE;

const IDLE_MS = 60_000;

const call = <T>(work: (done: (error: Error | undefined | null, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) =>
    work((error, value) => (error ? reject(error) : resolve(value as T))),
  );

export class SftpRemote implements Remote {
  private readonly settings: SftpSettings;
  private readonly key: SftpKey;
  private session?: Promise<{ client: Client; sftp: SFTPWrapper }>;
  private idle?: NodeJS.Timeout;
  /** Folders known to be there, so each is made once. */
  private readonly made = new Set<string>();

  constructor(settings: SftpSettings, key: SftpKey) {
    this.settings = settings;
    this.key = key;
  }

  private connect() {
    this.session ??= new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      let refused: HostKeyError | undefined;
      const fail = (error: Error) => {
        this.session = undefined;
        reject(refused ?? error);
      };
      client.on('ready', () =>
        client.sftp((error, sftp) => (error ? fail(error) : resolve({ client, sftp }))),
      );
      client.on('error', fail);
      client.on('close', () => {
        this.session = undefined;
        this.made.clear();
      });
      const { privateKey, passphrase, password } = this.key;
      client.connect({
        host: this.settings.host,
        port: this.settings.port,
        username: this.settings.user,
        readyTimeout: 20_000,
        ...(privateKey ? { privateKey, ...(passphrase ? { passphrase } : {}) } : { password }),
        // Before anything of the key or the password is sent.
        hostVerifier: (shown: Buffer) => {
          const fingerprint = fingerprintOf(shown);
          if (fingerprint === this.settings.hostKey) return true;
          refused = new HostKeyError(
            this.settings.hostKey ? 'host-key-changed' : 'host-key-unconfirmed',
            fingerprint,
          );
          return false;
        },
      });
    });
    return this.session.then((session) => {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => void this.close(), IDLE_MS);
      this.idle.unref();
      return session.sftp;
    });
  }

  /** The path of a file of the library on the server. */
  private full(path: string) {
    const full = posix.join(this.settings.root, path);
    const root = posix.join(this.settings.root, '.');
    if (!full.startsWith(root.endsWith('/') ? root : `${root}/`)) {
      throw new Error(`Outside the store's folder: ${path}`);
    }
    return full;
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    const sftp = await this.connect();
    try {
      return new Uint8Array(await call<Buffer>((done) => sftp.readFile(this.full(path), done)));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  /** Makes a folder and those above it, under the store's folder. */
  private async folder(sftp: SFTPWrapper, dir: string) {
    if (this.made.has(dir) || dir === '/' || dir === '.') return;
    try {
      const stats = await call<Stats>((done) => sftp.stat(dir, done));
      if (!stats.isDirectory()) throw new Error(`${dir} is a file, not a folder.`);
    } catch (error) {
      if (!missing(error)) throw error;
      await this.folder(sftp, posix.dirname(dir));
      await call<undefined>((done) => sftp.mkdir(dir, done));
    }
    this.made.add(dir);
  }

  async write(path: string, bytes: Uint8Array): Promise<RemoteFile> {
    const sftp = await this.connect();
    const full = this.full(path);
    await this.folder(sftp, posix.dirname(full));
    const temp = posix.join(posix.dirname(full), `.slidr-${randomUUID()}`);
    try {
      await call<undefined>((done) => sftp.writeFile(temp, Buffer.from(bytes), done));
      try {
        await call<undefined>((done) => sftp.ext_openssh_rename(temp, full, done));
      } catch {
        // A server without it renames only onto no file: the old one is taken away first.
        await call<undefined>((done) => sftp.unlink(full, done)).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
        await call<undefined>((done) => sftp.rename(temp, full, done));
      }
    } catch (error) {
      await call<undefined>((done) => sftp.unlink(temp, done)).catch(() => undefined);
      throw error;
    }
    const stats = await call<Stats>((done) => sftp.stat(full, done));
    return { path, size: stats.size, mtime: stats.mtime * 1000 };
  }

  async remove(path: string): Promise<void> {
    const sftp = await this.connect();
    try {
      await call<undefined>((done) => sftp.unlink(this.full(path), done));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async list(): Promise<RemoteFile[]> {
    const sftp = await this.connect();
    const files: RemoteFile[] = [];
    const walk = async (parts: string[]) => {
      let entries;
      try {
        entries = await call<{ filename: string; attrs: Stats }[]>((done) =>
          sftp.readdir(posix.join(this.settings.root, ...parts), done),
        );
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      for (const { filename, attrs } of entries) {
        if (filename.startsWith('.')) continue;
        if (attrs.isDirectory()) await walk([...parts, filename]);
        else if (attrs.isFile()) {
          files.push({
            path: [...parts, filename].join('/'),
            size: attrs.size,
            mtime: attrs.mtime * 1000,
          });
        }
      }
    };
    await walk([]);
    return files;
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    try {
      (await session).client.end();
    } catch {
      // It never connected: nothing to let go.
    }
  }
}
