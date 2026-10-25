import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, mock, test } from 'node:test';
import ssh2, { type ParsedKey } from 'ssh2';
import { MediaSettings } from '../../core/config.ts';
import { LOCK, MANIFEST, encodeManifest, sha256Hex, toBytes } from '../../core/media/live.ts';
import { encodeTags } from '../../core/media/merge.ts';
import { forgetLibrary } from '../../core/uploads/library.ts';
import {
  CATALOGS,
  FONTS,
  MemoryBucket,
  PICTURE,
  TEMPLATE,
  caller,
  failing,
} from '../../core/uploads/testing.ts';
import { FtpRemote } from './ftp.ts';
import { FolderMedia } from './media.ts';
import { RemoteMedia, type Remote } from './remote.ts';
import { certificate, ftpServer, sftpServer } from './servers.testing.ts';
import { HostKeyError, SftpRemote, fingerprintOf } from './sftp.ts';

const folders: string[] = [];
const closing: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const close of closing) await close();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});
afterEach(() => {
  mock.restoreAll();
  forgetLibrary();
});

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-remote-'));
  folders.push(folder);
  return folder;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Every file under a folder, by its path in it, with the SHA-256 of its bytes. */
async function hashesIn(folder: string) {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name)
      .slice(folder.length + 1)
      .replaceAll('\\', '/');
    hashes[path] = sha256(await readFile(join(folder, ...path.split('/'))));
  }
  return hashes;
}

/** The files the library's checks read, in a folder, with their manifest. */
const LIBRARY: Record<string, unknown> = {
  'fonts/catalog.json': FONTS,
  'templates/harbour/template.json': TEMPLATE,
  'templates/pictures.json': { harbourPier: PICTURE },
  'tags/emoji.json': encodeTags({ version: 1, tags: { other: { he: ['אחר'], en: ['other'] } } }),
  ...CATALOGS,
};

async function liveFolder(folder: string) {
  const media = new FolderMedia(folder);
  const manifest = { version: 1 as const, published: '2026-10-19T22:14:16.216Z', files: {} };
  for (const [path, value] of Object.entries(LIBRARY)) {
    const bytes = toBytes(typeof value === 'string' ? value : JSON.stringify(value));
    const hash = await sha256Hex(bytes);
    await media.put(path, bytes, { customMetadata: { sha256: hash } });
    (manifest.files as Record<string, unknown>)[path] = { size: bytes.length, sha256: hash };
  }
  await media.put(MANIFEST, encodeManifest(manifest));
}

const cake = {
  type: 'emoji',
  action: 'tag',
  id: 'emoji',
  languages: {
    he: { tags: { 'birthday-cake': ['עוגה', 'יום הולדת', 'מסיבה'] } },
    en: { tags: { 'birthday-cake': ['cake', 'birthday', 'party'] } },
  },
};

/** The library over a store on another server, as the server's routes use it. */
async function publishedOver(media: RemoteMedia) {
  const { store, control } = failing(media);
  const owner = await caller({}, new MemoryBucket(), { MEDIA: store });
  const approve = async (held = false) => {
    const made = (await (await owner.send('/api/uploads', 'POST', cake)).json()) as { id: string };
    if (held) {
      await owner.bucket.put(LOCK, JSON.stringify({ by: 'someone', at: new Date().toISOString() }));
    }
    const approved = await owner.send(`/api/uploads/${made.id}/status`, 'POST', {
      status: 'accepted',
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    if (held) await owner.bucket.put(LOCK, JSON.stringify({ free: true }));
    return (await approved.json()) as { id: string; status: string };
  };
  return { owner, control, approve };
}

/** The same tests, over each kind of server. */
function storeTests(name: string, open: () => Promise<{ remote: Remote; folder: string }>) {
  describe(`the library on ${name}`, () => {
    test('is written whole, under its paths, and read and listed back', async () => {
      const { remote, folder } = await open();
      const media = new RemoteMedia(remote, await newFolder());
      closing.push(() => media.close());
      assert.equal(await media.get(MANIFEST), null);
      const written = await media.put('tags/emoji.json', '{"tags":{}}');
      assert.equal(written?.etag, sha256(toBytes('{"tags":{}}')));
      assert.equal(await (await media.get('tags/emoji.json'))?.text(), '{"tags":{}}');
      await media.put('fonts/catalog.json', '{"families":[]}');
      const listed = await media.list({ include: ['customMetadata'] });
      assert.deepEqual(
        listed.objects.map((one) => [one.key, one.customMetadata?.sha256]),
        [
          ['fonts/catalog.json', sha256(toBytes('{"families":[]}'))],
          ['tags/emoji.json', sha256(toBytes('{"tags":{}}'))],
        ],
      );
      // Nothing hidden is left behind; a path that is not the library's is not taken.
      assert.deepEqual(Object.keys(await hashesIn(folder)).sort(), [
        'fonts/catalog.json',
        'tags/emoji.json',
      ]);
      await assert.rejects(media.put('../outside.json', '{}'), /Not a path of the library/);
      await media.delete('tags/emoji.json');
      assert.equal(await media.get('tags/emoji.json'), null);
    });

    test('writes over a manifest only while it is the one read: one changed outside is not', async () => {
      const { remote, folder } = await open();
      const media = new RemoteMedia(remote, await newFolder());
      closing.push(() => media.close());
      const first = await media.put(MANIFEST, '{"version":1,"files":{}}');
      assert.ok(
        await media.put(MANIFEST, '{"version":1,"files":{},"a":1}', {
          onlyIf: { etagMatches: first!.etag },
        }),
      );
      const read = await media.get(MANIFEST);
      // Changed on the server by someone else.
      await writeFile(join(folder, MANIFEST), '{"version":1,"files":{},"b":2}');
      assert.equal(await media.put(MANIFEST, '{}', { onlyIf: { etagMatches: read!.etag } }), null);
      assert.equal(
        await readFile(join(folder, MANIFEST), 'utf8'),
        '{"version":1,"files":{},"b":2}',
      );
    });

    test('keeps what it read: a file named by the manifest is read from the server once', async () => {
      const { remote, folder } = await open();
      await liveFolder(folder);
      const media = new RemoteMedia(remote, await newFolder());
      closing.push(() => media.close());
      const text = await (await media.get('fonts/catalog.json'))!.text();
      await rm(join(folder, 'fonts', 'catalog.json'));
      assert.equal(await (await media.get('fonts/catalog.json'))!.text(), text);
    });

    test('takes approved uploads, and is put back as it was when a write fails', async () => {
      mock.method(console, 'error', () => {});
      const { remote, folder } = await open();
      await liveFolder(folder);
      const media = new RemoteMedia(remote, await newFolder());
      closing.push(() => media.close());
      const { owner, control, approve } = await publishedOver(media);
      const approved = await approve();
      assert.equal(approved.status, 'published');
      const tags = JSON.parse(await readFile(join(folder, 'tags', 'emoji.json'), 'utf8')) as {
        tags: Record<string, unknown>;
      };
      assert.ok(tags.tags['birthday-cake']);
      const manifest = JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')) as {
        files: Record<string, { sha256: string }>;
      };
      const hashes = await hashesIn(folder);
      for (const [path, entry] of Object.entries(manifest.files)) {
        assert.equal(hashes[path], entry.sha256, path);
      }
      // The next fails at its first write into the store, and leaves it as it was.
      await approve(true);
      const before = await hashesIn(folder);
      control.writes = 0;
      control.fails = (write) => write === 1;
      assert.equal((await owner.send('/api/publish', 'POST', {})).status, 502);
      assert.deepEqual(await hashesIn(folder), before);
    });
  });
}

storeTests('a server over SFTP', async () => {
  const folder = await newFolder();
  const server = await sftpServer(folder);
  closing.push(server.close);
  const hostKey = fingerprintOf((ssh2.utils.parseKey(server.hostKey) as ParsedKey).getPublicSSH());
  const remote = new SftpRemote(
    { host: '127.0.0.1', port: server.port, user: server.user, root: '/', hostKey },
    { privateKey: server.clientKey },
  );
  return { remote, folder };
});

storeTests('a server over FTP', async () => {
  const folder = await newFolder();
  const server = await ftpServer(folder);
  closing.push(server.close);
  const remote = new FtpRemote(
    { host: '127.0.0.1', port: server.port, user: server.user, root: '/', tls: 'none' },
    server.password,
  );
  return { remote, folder };
});

describe('a server over SFTP', () => {
  test('is sent nothing of the key until its host key is the one confirmed', async () => {
    const folder = await newFolder();
    const server = await sftpServer(folder);
    closing.push(server.close);
    const shown = fingerprintOf((ssh2.utils.parseKey(server.hostKey) as ParsedKey).getPublicSSH());
    const settings = { host: '127.0.0.1', port: server.port, user: server.user, root: '/' };
    const unknown = new SftpRemote(settings, { password: server.password });
    await assert.rejects(
      unknown.list(),
      (error) =>
        error instanceof HostKeyError &&
        error.code === 'host-key-unconfirmed' &&
        error.fingerprint === shown,
    );
    const changed = new SftpRemote(
      { ...settings, hostKey: `SHA256:${'A'.repeat(43)}` },
      { password: server.password },
    );
    await assert.rejects(
      changed.write('tags/emoji.json', toBytes('{}')),
      (error) => error instanceof HostKeyError && error.code === 'host-key-changed',
    );
    assert.equal(server.tries.count, 0);
    assert.deepEqual(await readdir(folder), []);
    // Confirmed, a password does as well as a key.
    const known = new SftpRemote({ ...settings, hostKey: shown }, { password: server.password });
    closing.push(() => known.close());
    assert.deepEqual(await known.list(), []);
  });
});

describe('a server over FTP', () => {
  test('is reached in clear only when it is allowed', () => {
    const plain = { kind: 'ftp', host: 'ftp.example.org', user: 'u', root: '/media', tls: 'none' };
    assert.equal(MediaSettings.safeParse(plain).success, false);
    assert.equal(MediaSettings.safeParse({ ...plain, allowUnencrypted: true }).success, true);
    const settings = MediaSettings.parse({ ...plain, tls: undefined });
    assert.equal(settings.kind === 'ftp' && settings.tls, 'explicit');
  });

  for (const mode of ['explicit', 'implicit'] as const) {
    test(`over TLS (${mode}), checks the server's certificate`, async (t) => {
      const tls = await certificate();
      if (!tls) return t.skip('openssl makes the test certificate');
      const folder = await newFolder();
      const server = await ftpServer(folder, { ...tls, mode });
      closing.push(server.close);
      const settings = {
        host: '127.0.0.1',
        port: server.port,
        user: server.user,
        root: '/',
        tls: mode,
      };
      const trusted = new FtpRemote(settings, server.password, { ca: tls.cert });
      closing.push(() => trusted.close());
      await trusted.write('tags/emoji.json', toBytes('{"tags":{}}'));
      assert.equal(await readFile(join(folder, 'tags', 'emoji.json'), 'utf8'), '{"tags":{}}');
      // A certificate no one vouches for is not trusted.
      const untrusted = new FtpRemote(settings, server.password);
      closing.push(() => untrusted.close());
      await assert.rejects(untrusted.list(), /certificate/i);
    });
  }
});

describe('the settings of a server', () => {
  test('ask an admin to confirm its host key, and keep its key in the vault', async () => {
    const { install, contextSource, openLibrary } = await import('./install.ts');
    const { memoryKeys } = await import('./master.ts');
    const { issueLocalLink } = await import('../../core/auth.ts');
    const { handle } = await import('../../core/index.ts');
    const { readConfig } = await import('../../core/config.ts');
    const root = await newFolder();
    const keys = memoryKeys();
    await install({
      data: join(root, 'data'),
      owner: 'owner@example.org',
      master: 'keychain',
      keys,
    });
    const library = await openLibrary(join(root, 'data'), keys);
    const source = contextSource(library);
    const SITE = 'http://127.0.0.1:5176';
    const code = await issueLocalLink(await source(), 'owner@example.org');
    const signedIn = await handle(new Request(`${SITE}/auth/local?code=${code}`), {
      ...(await source()),
      clientAddress: '127.0.0.1',
    });
    const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
    const send = async (body: unknown) =>
      handle(
        new Request(`${SITE}/api/settings/media`, {
          method: 'PUT',
          headers: { Cookie: cookie, Origin: SITE, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { ...(await source()), clientAddress: '127.0.0.1' },
      );

    const folder = join(root, 'server');
    await rm(folder, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(folder);
    const server = await sftpServer(folder);
    closing.push(server.close);
    const sftp = {
      kind: 'sftp',
      host: '127.0.0.1',
      port: server.port,
      user: server.user,
      root: '/',
    };

    // A wrong password: not kept, and why.
    const wrong = await send({
      ...sftp,
      hostKey: fingerprintOf((ssh2.utils.parseKey(server.hostKey) as ParsedKey).getPublicSSH()),
      key: { password: 'not-it' },
    });
    assert.equal(wrong.status, 422);
    const why = (await wrong.json()) as { error: string; message: string };
    assert.equal(why.error, 'store-unreachable');
    assert.match(why.message, /authentication/i);

    // The first time, the server's host key is shown, and nothing kept.
    const first = await send({ ...sftp, key: { password: server.password } });
    assert.equal(first.status, 409);
    const shown = (await first.json()) as { error: string; fingerprint: string };
    assert.equal(shown.error, 'host-key-unconfirmed');
    assert.equal(await library.vault.get('media'), undefined);

    // Confirmed: tried, then kept, the key in the vault and never in the settings.
    const confirmed = await send({
      ...sftp,
      hostKey: shown.fingerprint,
      key: { password: server.password },
    });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const saved = (await readConfig(library.state))?.media;
    assert.deepEqual(saved, { ...sftp, hostKey: shown.fingerprint });
    assert.deepEqual(JSON.parse((await library.vault.get('media'))!), {
      password: server.password,
    });
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(server.password));
    // The server now writes the library there.
    const media = (await source()).media!;
    await media.put('tags/emoji.json', '{"tags":{}}');
    assert.equal(await readFile(join(folder, 'tags', 'emoji.json'), 'utf8'), '{"tags":{}}');
    await media.close?.();
  });
});
