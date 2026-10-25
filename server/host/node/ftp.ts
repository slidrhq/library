/**
 * The published library in a folder of an FTP server (docs/SPEC.md §4.5), with `basic-ftp`: a
 * `Remote` for `RemoteMedia`.
 *
 * - Over TLS: asked for on the connection (explicit FTPS, the default), or from its start
 *   (implicit, port 990). The server's certificate is checked as any TLS client checks it. In clear
 *   only where an admin allowed it (`config.ts`): the password then travels as it is.
 * - A file is written to a hidden name in its folder, then renamed over the file (`RNFR`/`RNTO`);
 *   a server that renames only onto no file has the old one taken away first, and for that moment
 *   the path has no file.
 * - One connection, which does one thing at a time; made again after a failure, and let go after a
 *   minute without use.
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';
import { Client, FTPError } from 'basic-ftp';
import type { Remote, RemoteFile } from './remote.ts';

export interface FtpSettings {
  host: string;
  port?: number;
  user: string;
  root: string;
  tls: 'explicit' | 'implicit' | 'none';
}

/**
 * What an FTP server answers for a file it does not have: 550, or, from some, 551 that says so.
 */
const missing = (error: unknown) =>
  error instanceof FTPError &&
  (error.code === 550 ||
    (error.code === 551 && /ENOENT|no such file|not found/i.test(error.message)));

const IDLE_MS = 60_000;

export class FtpRemote implements Remote {
  private readonly settings: FtpSettings;
  private readonly password: string;
  private readonly tlsOptions: ConnectionOptions;
  private client?: Client;
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;

  /** `tlsOptions`: more of how the server's certificate is checked, for a test's own. */
  constructor(settings: FtpSettings, password: string, tlsOptions: ConnectionOptions = {}) {
    this.settings = settings;
    this.password = password;
    this.tlsOptions = tlsOptions;
  }

  /** Does `work` once what was asked before it is done, on a connection made as needed. */
  private run<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      clearTimeout(this.idle);
      try {
        if (!this.client || this.client.closed) this.client = await this.connect();
        return await work(this.client);
      } catch (error) {
        // A connection that failed is made again for the next.
        if (!missing(error)) this.disconnect();
        throw error;
      } finally {
        this.idle = setTimeout(() => this.disconnect(), IDLE_MS);
        this.idle.unref();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async connect() {
    const { host, port, user, tls } = this.settings;
    const client = new Client(30_000);
    try {
      await client.access({
        host,
        port: port ?? (tls === 'implicit' ? 990 : 21),
        user,
        password: this.password,
        secure: tls === 'explicit' ? true : tls === 'implicit' ? 'implicit' : false,
        // The certificate is checked against the host; a name is sent only for a name.
        secureOptions: { ...(isIP(host) ? {} : { servername: host }), ...this.tlsOptions },
      });
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  private disconnect() {
    this.client?.close();
    this.client = undefined;
  }

  private full(path: string) {
    const full = posix.join(this.settings.root, path);
    const root = posix.join(this.settings.root, '.');
    if (!full.startsWith(root.endsWith('/') ? root : `${root}/`)) {
      throw new Error(`Outside the store's folder: ${path}`);
    }
    return full;
  }

  read(path: string): Promise<Uint8Array | undefined> {
    return this.run(async (client) => {
      const chunks: Buffer[] = [];
      const into = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      });
      try {
        await client.downloadTo(into, this.full(path));
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
      return new Uint8Array(Buffer.concat(chunks));
    });
  }

  write(path: string, bytes: Uint8Array): Promise<RemoteFile> {
    return this.run(async (client) => {
      const full = this.full(path);
      await client.ensureDir(posix.dirname(full));
      const temp = posix.join(posix.dirname(full), `.slidr-${randomUUID()}`);
      try {
        await client.uploadFrom(Readable.from([Buffer.from(bytes)]), temp);
        try {
          await client.rename(temp, full);
        } catch (error) {
          if (!(error instanceof FTPError)) throw error;
          await client.remove(full, true);
          await client.rename(temp, full);
        }
      } catch (error) {
        await client.remove(temp, true).catch(() => undefined);
        throw error;
      }
      // As a list of its folder shows it, so that a list later finds it unchanged.
      const shown = (await client.list(posix.dirname(full))).find(
        (entry) => entry.name === posix.basename(full),
      );
      return { path, size: shown?.size ?? bytes.length, mtime: shown?.modifiedAt?.getTime() ?? 0 };
    });
  }

  remove(path: string): Promise<void> {
    return this.run(async (client) => {
      try {
        await client.remove(this.full(path));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    });
  }

  list(): Promise<RemoteFile[]> {
    return this.run(async (client) => {
      const files: RemoteFile[] = [];
      const walk = async (parts: string[]) => {
        let entries;
        try {
          entries = await client.list(posix.join(this.settings.root, ...parts));
        } catch (error) {
          if (missing(error)) return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory) await walk([...parts, entry.name]);
          else if (entry.isFile) {
            files.push({
              path: [...parts, entry.name].join('/'),
              size: entry.size,
              mtime: entry.modifiedAt?.getTime() ?? 0,
            });
          }
        }
      };
      await walk([]);
      return files;
    });
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    await this.queue;
    this.disconnect();
  }
}
