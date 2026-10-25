/**
 * Servers the tests of the stores on other servers reach (`sftp.ts`, `ftp.ts`), each over a folder
 * of this machine: an SSH server that speaks SFTP (`ssh2`'s own), and an FTP server (`ftp-srv`),
 * with FTPS when `openssl` makes it a certificate.
 */
import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FtpSrv from 'ftp-srv';
import ssh2, { type ParsedKey } from 'ssh2';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const attrsOf = (stats: Stats) => ({
  mode: stats.mode,
  uid: 0,
  gid: 0,
  size: stats.size,
  atime: Math.floor(stats.atimeMs / 1000),
  mtime: Math.floor(stats.mtimeMs / 1000),
});

const codeOf = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? STATUS_CODE.NO_SUCH_FILE
    : STATUS_CODE.FAILURE;

/**
 * An SSH server on a free port of this machine, whose SFTP is a folder: `user` signs in with
 * `password` or with the private key `clientKey`, and the server shows `hostKey`.
 */
export async function sftpServer(folder: string) {
  const host = utils.generateKeyPairSync('ed25519');
  const client = utils.generateKeyPairSync('ed25519');
  const allowed = utils.parseKey(client.public) as ParsedKey;
  const user = 'library';
  const password = 'the-sftp-password';
  /** A path of the server, in the folder; none for one that climbs out of it. */
  const local = (path: string) =>
    path.split('/').includes('..') ? undefined : join(folder, ...path.split('/').filter(Boolean));

  /** How many times a client was let try to sign in. */
  const tries = { count: 0 };
  const server = new Server({ hostKeys: [host.private] }, (connection) => {
    // A client that leaves, as one refusing the host key does, is no failure of the server.
    connection.on('error', () => undefined);
    connection.on('authentication', (auth) => {
      if (auth.method !== 'none') tries.count += 1;
      if (auth.username !== user) return auth.reject();
      if (auth.method === 'password' && auth.password === password) return auth.accept();
      if (auth.method === 'publickey') {
        const same =
          auth.key.algo === allowed.type &&
          auth.key.data.length === allowed.getPublicSSH().length &&
          timingSafeEqual(auth.key.data, allowed.getPublicSSH());
        if (!same) return auth.reject();
        if (!auth.signature) return auth.accept();
        return allowed.verify(auth.blob!, auth.signature, auth.hashAlgo)
          ? auth.accept()
          : auth.reject();
      }
      auth.reject(['password', 'publickey']);
    });
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        acceptSession().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { fd?: number; entries?: string[]; dir?: string }>();
          let next = 0;
          const handle = (held: { fd?: number; entries?: string[]; dir?: string }) => {
            const id = (next += 1);
            handles.set(id, held);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(id);
            return buffer;
          };
          const held = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0));
          const at = (reqid: number, path: string, work: (file: string) => void) => {
            const file = local(path);
            if (!file) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            try {
              work(file);
            } catch (error) {
              sftp.status(reqid, codeOf(error));
            }
          };
          sftp.on('OPEN', (reqid, path, flags) =>
            at(reqid, path, (file) => {
              const mode = flags & OPEN_MODE.WRITE ? 'w' : 'r';
              sftp.handle(reqid, handle({ fd: openSync(file, mode) }));
            }),
          );
          sftp.on('READ', (reqid, buffer, offset, length) => {
            const { fd } = held(buffer) ?? {};
            if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const data = Buffer.alloc(length);
            const read = readSync(fd, data, 0, length, offset);
            if (read === 0) sftp.status(reqid, STATUS_CODE.EOF);
            else sftp.data(reqid, data.subarray(0, read));
          });
          sftp.on('WRITE', (reqid, buffer, offset, data) => {
            const { fd } = held(buffer) ?? {};
            if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            writeSync(fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('FSTAT', (reqid, buffer) => {
            const { fd } = held(buffer) ?? {};
            if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            sftp.attrs(reqid, attrsOf(fstatSync(fd)));
          });
          sftp.on('CLOSE', (reqid, buffer) => {
            const found = held(buffer);
            if (found?.fd !== undefined) closeSync(found.fd);
            handles.delete(buffer.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          const stat = (reqid: number, path: string) =>
            at(reqid, path, (file) => sftp.attrs(reqid, attrsOf(statSync(file))));
          sftp.on('STAT', stat);
          sftp.on('LSTAT', stat);
          sftp.on('OPENDIR', (reqid, path) =>
            at(reqid, path, (dir) =>
              sftp.handle(reqid, handle({ dir, entries: readdirSync(dir) })),
            ),
          );
          sftp.on('READDIR', (reqid, buffer) => {
            const found = held(buffer);
            if (!found?.entries || !found.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (found.entries.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            const names = found.entries.splice(0).map((filename) => ({
              filename,
              longname: filename,
              attrs: attrsOf(statSync(join(found.dir!, filename))),
            }));
            sftp.name(reqid, names);
          });
          sftp.on('REMOVE', (reqid, path) =>
            at(reqid, path, (file) => {
              unlinkSync(file);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('MKDIR', (reqid, path) =>
            at(reqid, path, (dir) => {
              mkdirSync(dir);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          // As SFTP's own rename: never onto a file that is there.
          sftp.on('RENAME', (reqid, from, to) =>
            at(reqid, from, (source) => {
              const target = local(to);
              if (!target) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
              try {
                statSync(target);
                return sftp.status(reqid, STATUS_CODE.FAILURE, 'It is there already.');
              } catch {
                renameSync(source, target);
                sftp.status(reqid, STATUS_CODE.OK);
              }
            }),
          );
          sftp.on('REALPATH', (reqid, path) =>
            sftp.name(reqid, [
              { filename: path || '/', longname: path || '/', attrs: {} as never },
            ]),
          );
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    user,
    password,
    clientKey: client.private,
    hostKey: host.public,
    tries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A port of this machine that no one listens on, a moment ago. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A certificate for 127.0.0.1, made by `openssl`; none where there is no `openssl`. */
export async function certificate() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(folder, 'key.pem'),
        '-out',
        join(folder, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(folder, 'key.pem')),
      cert: readFileSync(join(folder, 'cert.pem')),
    };
  } catch {
    return undefined;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** What `ftp-srv` would write to the console: nothing. */
const quiet = {
  child() {
    return quiet;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

/**
 * An FTP server on a free port of this machine, over a folder: plain, or FTPS with `tls`, asked
 * for on the connection (`explicit`) or from its start (`implicit`).
 */
export async function ftpServer(
  folder: string,
  tls?: { key: Buffer; cert: Buffer; mode: 'explicit' | 'implicit' },
) {
  const port = await freePort();
  const pasv = await freePort();
  const user = 'library';
  const password = 'the-ftp-password';
  const server = new FtpSrv({
    url: `${tls?.mode === 'implicit' ? 'ftps' : 'ftp'}://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    pasv_min: pasv,
    pasv_max: pasv + 20,
    anonymous: false,
    tls: tls ? { key: tls.key, cert: tls.cert } : false,
    log: quiet,
  });
  server.on('login', ({ username, password: given }, resolve, reject) => {
    if (username === user && given === password) resolve({ root: folder });
    else reject(new Error('Not this user.'));
  });
  await server.listen();
  return { port, user, password, close: () => server.close() as Promise<void> };
}
