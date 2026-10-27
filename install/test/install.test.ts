/**
 * The install script and the command of the machine (docs/PLAN.md P12), as root runs them on
 * Linux, over the image built beforehand. It changes the machine (/etc/slidr-library,
 * /usr/local/bin/slidr-library, a container named slidr-library): GitHub's Ubuntu runners only
 * (.github/workflows/image.yml).
 *
 *   SLIDR_IMAGE=slidr-library:test node --import ./server/node.mjs --test install/test/install.test.ts
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { MANIFEST, encodeManifest, type Manifest } from '../../server/core/media/live.ts';
import { CATALOGS, FONTS } from '../../server/core/uploads/testing.ts';

const IMAGE = process.env.SLIDR_IMAGE ?? 'slidr-library:test';
const SCRIPT = fileURLToPath(new URL('../install.sh', import.meta.url));
const PORT = 17643;
const TLS_PORT = 17644;
const OWNER = 'owner@example.org';
const run = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let root: string;
let site: Server;
let secureSite: Server | undefined;
let seedFrom: string;
/** This machine's own address, which the container reaches. */
let address: string;
/** The files of a published library of a few files, by their paths. */
const files: Record<string, Uint8Array> = {};

/** A published library, as a server of the fixtures answers it. */
function library(request: IncomingMessage, answer: ServerResponse) {
  const bytes = files[decodeURIComponent(new URL(request.url!, 'http://x').pathname.slice(1))];
  answer.writeHead(bytes ? 200 : 404).end(bytes);
}

/** Runs a command to its end: what it printed, both streams, and how it ended. */
function sh(
  command: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => done({ code, out }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** An install script, as root, asking nothing; with tools stood in for, first on the PATH. */
const installBy = (script: string, args: string[], stubs?: string) =>
  sh('sudo', [
    'env',
    `PATH=${stubs ? `${stubs}:` : ''}${process.env.PATH}`,
    'bash',
    script,
    '--yes',
    ...args,
  ]);

/** The install script, of the image built beforehand. */
const install = (args: string[], stubs?: string) =>
  installBy(SCRIPT, ['--image', IMAGE, ...args], stubs);

const command = (...args: string[]) => sh('sudo', ['slidr-library', ...args]);

/** A tool stood in for: a script that answers as `body` says. */
async function stub(name: string, body: string) {
  const folder = await mkdtemp(join(root, 'stub-'));
  await writeFile(join(folder, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(folder, name), 0o755);
  return folder;
}

async function healthy() {
  for (let tries = 0; tries < 90; tries += 1) {
    const { out } = await sh('docker', [
      'inspect',
      '-f',
      '{{.State.Health.Status}}',
      'slidr-library',
    ]);
    if (out.trim() === 'healthy') return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.fail('slidr-library is not healthy');
}

/** The folders of an install, made fresh. */
async function place(name: string) {
  const at = join(root, name);
  await mkdir(at, { recursive: true });
  return { media: join(at, 'media'), data: join(at, 'data') };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'slidr-install-'));
  // A published library of a few files, on this machine's own address: the container reaches it.
  for (const [path, value] of Object.entries({ 'fonts/catalog.json': FONTS, ...CATALOGS })) {
    files[path] = new TextEncoder().encode(JSON.stringify(value));
  }
  const manifest: Manifest = { version: 1, published: '2026-10-24T08:00:00.000Z', files: {} };
  for (const [path, bytes] of Object.entries(files)) {
    manifest.files[path] = { size: bytes.length, sha256: sha256(bytes) };
  }
  files[MANIFEST] = new TextEncoder().encode(encodeManifest(manifest));
  site = createServer(library);
  await new Promise<void>((done) => site.listen(0, '0.0.0.0', done));
  address = (await run('hostname', ['-I'])).stdout.trim().split(/\s+/)[0]!;
  const port = (site.address() as { port: number }).port;
  seedFrom = `http://${address}:${port}/`;
});

after(async () => {
  site?.close();
  secureSite?.close();
  await sh('docker', ['rmi', 'slidr-library:offline']);
  await sh('sudo', ['docker', 'rm', '-f', 'slidr-library']);
  await sh('sudo', ['rm', '-rf', '/etc/slidr-library', '/usr/local/bin/slidr-library', root]);
});

describe('the install script', () => {
  test('refuses what it cannot install, and says why', async () => {
    const { media, data } = await place('refused');
    const given = ['--media', media, '--owner', OWNER, '--data', data, '--no-seed'];
    const cases: [string, string[], string | undefined, RegExp][] = [
      ['not Linux', given, await stub('uname', 'echo Darwin'), /on Linux only/],
      [
        'an architecture not made for',
        given,
        await stub('uname', '[ "$1" = -m ] && echo armv7l || echo Linux'),
        /x86-64 and ARM64, not armv7l/,
      ],
      ['no Docker', given, await stub('docker', 'exit 1'), /Docker does not answer/],
      [
        'a rootless Docker',
        given,
        await stub(
          'docker',
          'case "$1" in version) echo 27.3.1;; info) echo "[name=seccomp name=rootless]";; esac',
        ),
        /rootless/,
      ],
      [
        'a network file system',
        given,
        await stub('findmnt', 'echo nfs4'),
        /network file system \(nfs4\)/,
      ],
      ['no media folder named', ['--owner', OWNER, '--no-seed'], undefined, /--media <dir>/],
      ['no owner named', ['--media', media, '--no-seed'], undefined, /--owner <email>/],
      [
        'a media folder in the data folder',
        ['--media', join(data, 'media'), '--owner', OWNER, '--data', data, '--no-seed'],
        undefined,
        /apart from the library's data/,
      ],
    ];
    for (const [what, args, stubs, said] of cases) {
      const answer = await install(args, stubs);
      assert.notEqual(answer.code, 0, what);
      assert.match(answer.out, said, `${what}:\n${answer.out}`);
    }
    // A folder that holds other things.
    await mkdir(media, { recursive: true });
    await writeFile(join(media, 'notes.txt'), 'mine');
    const held = await install(given);
    assert.match(held.out, /holds other things than a library \(notes\.txt/);
    // A web root, whose manifest.json is a page's, not a library's.
    const site = await place('site');
    await mkdir(site.media, { recursive: true });
    await writeFile(join(site.media, 'manifest.json'), '{"name":"A site","start_url":"/"}');
    const web = await install(['--media', site.media, ...given.slice(2)]);
    assert.match(web.out, /is not a library's manifest/);
    // A data folder that holds other things.
    const other = await place('other-data');
    await mkdir(other.data, { recursive: true });
    await writeFile(join(other.data, 'notes.txt'), 'mine');
    const busyData = await install([
      ...['--media', other.media, '--owner', OWNER, '--data', other.data, '--no-seed'],
    ]);
    assert.match(busyData.out, /holds other things than a library's data/);
    // Plain HTTP is this machine's alone; and an address is an address.
    const plain = await place('plain');
    const fresh = ['--media', plain.media, '--owner', OWNER, '--data', plain.data, '--no-seed'];
    const wide = await install([...fresh, '--bind', '0.0.0.0']);
    assert.match(wide.out, /Over plain HTTP the library is this machine's alone/);
    const odd = await install([...fresh, '--bind', '0.0.0.0; rm -rf /']);
    assert.match(odd.out, /--bind is an IPv4 address/);
    // A port that something listens on.
    const taken = createTcpServer();
    await new Promise<void>((done) => taken.listen(PORT, '127.0.0.1', done));
    try {
      const { media: other } = await place('taken');
      const busy = await install([...given.slice(2), '--media', other, '--port', String(PORT)]);
      assert.match(busy.out, new RegExp(`Port ${PORT} is taken`));
    } finally {
      taken.close();
    }
    // Nothing was written.
    assert.equal((await sh('test', ['-e', '/etc/slidr-library/compose.yaml'])).code, 1);
  });

  test('installs with no one at the keyboard, the media seeded', async () => {
    const { media, data } = await place('first');
    const done = await install([
      ...['--media', media, '--owner', OWNER, '--data', data],
      ...['--port', String(PORT), `--seed=${seedFrom}`],
    ]);
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, new RegExp(`running at http://127\\.0\\.0\\.1:${PORT}`));
    assert.match(done.out, /auth\/local\?code=[A-Za-z0-9_-]{43}/);
    const manifest = (await (
      await fetch(`http://127.0.0.1:${PORT}/media/manifest.json`)
    ).json()) as Manifest;
    assert.equal(manifest.published, '2026-10-24T08:00:00.000Z');
    const compose = (await sh('sudo', ['cat', '/etc/slidr-library/compose.yaml'])).out;
    assert.match(compose, new RegExp(`"127\\.0\\.0\\.1:${PORT}:8080"`));
    assert.match(compose, /read_only: true/);
    // Its folders are an account's of its own, which the container runs as.
    const account = (await run('id', ['-u', 'slidr-library'])).stdout.trim();
    assert.notEqual(account, '10001');
    assert.equal((await run('stat', ['-c', '%u %a', data])).stdout.trim(), `${account} 700`);
    assert.equal((await run('stat', ['-c', '%u', media])).stdout.trim(), account);
    assert.match(compose, new RegExp(`user: "${account}:\\d+"`));
    const inside = await sh('sudo', ['docker', 'exec', 'slidr-library', 'id', '-u']);
    assert.equal(inside.out.trim(), account);
  });

  test('leaves a command that runs the library', async () => {
    const status = await command('status');
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /test: {7}written to; the library published 2026-10-24/);
    assert.match((await command('login')).out, /auth\/local\?code=/);
    assert.equal((await command('logs', '--tail', '5')).code, 0);
    assert.equal((await command('stop')).code, 0);
    assert.notEqual(
      (await fetch(`http://127.0.0.1:${PORT}/api/me`).catch(() => undefined))?.status,
      200,
    );
    assert.equal((await command('start')).code, 0);
    await healthy();
    const updated = await command('update', '--image', IMAGE);
    assert.equal(updated.code, 0, updated.out);
    await healthy();
    const rotated = await command('vault', 'rotate');
    assert.equal(rotated.code, 0, rotated.out);
    await healthy();
    assert.equal((await command('status')).code, 0);
  });

  test('is taken away without its data, and installed again over it', async () => {
    const gone = await command('uninstall');
    assert.equal(gone.code, 0, gone.out);
    assert.equal((await sh('test', ['-e', '/usr/local/bin/slidr-library'])).code, 1);
    assert.equal((await sh('sudo', ['test', '-f', '/etc/slidr-library/keys/master.key'])).code, 0);
    const { media, data } = {
      media: join(root, 'first', 'media'),
      data: join(root, 'first', 'data'),
    };
    const again = await install([
      ...['--media', media, '--owner', 'someone@example.org', '--data', data],
      ...['--port', String(PORT), '--no-seed'],
    ]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /The data folder holds a library: it is kept/);
    // The owner is the library's own, whoever the script was told.
    assert.match(again.out, new RegExp(`sign ${OWNER.replace('.', '\\.')} in`));
  });

  test('asks at the keyboard, and installs as it is answered', async () => {
    const purge = await command('uninstall', '--purge');
    assert.notEqual(purge.code, 0, 'without the paths typed, nothing is deleted');
    const data = join(root, 'first', 'data');
    const media = join(root, 'first', 'media');
    const purged = await sh(
      'sudo',
      ['slidr-library', 'uninstall', '--purge'],
      `${data}\n${media}\n`,
    );
    assert.equal(purged.code, 0, purged.out);
    const { media: asked, data: askedData } = await place('asked');
    const script = join(root, 'answers.exp');
    await writeFile(
      script,
      [
        'set timeout 300',
        `spawn sudo bash ${SCRIPT} --image ${IMAGE}`,
        'expect "media?"',
        `send "${asked}\\r"`,
        'expect "email address"',
        `send "${OWNER}\\r"`,
        'expect "How is it reached"',
        'send "\\r"',
        'expect "port of this machine"',
        `send "${PORT}\\r"`,
        'expect "data folder"',
        `send "${askedData}\\r"`,
        'expect "Fill the media"',
        'send "n\\r"',
        'expect "Install it?"',
        'send "y\\r"',
        'expect "is running at"',
        'expect eof',
        'catch wait result',
        'exit [lindex $result 3]',
      ].join('\n'),
    );
    const answered = await sh('expect', [script]);
    assert.equal(answered.code, 0, answered.out);
    assert.match((await command('status')).out, /it holds no library yet/);
  });

  test('installs over HTTPS, reached by its name, its session the host’s alone', async () => {
    const data = join(root, 'asked', 'data');
    const media = join(root, 'asked', 'media');
    await sh('sudo', ['slidr-library', 'uninstall', '--purge'], `${data}\n${media}\n`);
    const tls = join(root, 'tls');
    await mkdir(tls);
    await run('openssl', [
      ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'],
      ...['-days', '2', '-subj', '/CN=library.test', '-addext', 'subjectAltName=DNS:library.test'],
      ...['-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem')],
    ]);
    const url = `https://library.test:${TLS_PORT}`;
    const https = (key: string, more: string[]) => [
      ...['--reach', 'https', '--url', url, '--port', String(TLS_PORT), '--no-seed'],
      ...['--tls-cert', join(tls, 'cert.pem'), '--tls-key', key, '--owner', OWNER],
      ...more,
    ];
    // A key that is not the certificate's is refused, and nothing is written.
    const other = join(tls, 'other.pem');
    await run('openssl', [
      ...['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', other],
    ]);
    const wrong = await place('mismatch');
    const refused = await install(https(other, ['--media', wrong.media, '--data', wrong.data]));
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is not the key of/);

    const { media: secureMedia, data: secureData } = await place('secure');
    const done = await install(
      https(join(tls, 'key.pem'), ['--media', secureMedia, '--data', secureData]),
    );
    assert.equal(done.code, 0, done.out);
    const curl = (path: string) =>
      sh('curl', [
        ...['-sS', '-D', '-', '-o', '/dev/null', '--cacert', join(tls, 'cert.pem')],
        ...['--resolve', `library.test:${TLS_PORT}:127.0.0.1`, `${url}${path}`],
      ]);
    assert.match((await curl('/api/me')).out, /^HTTP\/\S+ 200/m);
    const link = new URL(/(https\S+auth\/local\?code=\S+)/.exec(done.out)![1]!);
    assert.match(
      (await curl(link.pathname + link.search)).out,
      /set-cookie: __Host-library-session=.*Secure/i,
    );
  });

  test('installs on a closed network: the image from its file, the organization’s authorities trusted', async () => {
    const secure = join(root, 'secure');
    await sh(
      'sudo',
      ['slidr-library', 'uninstall', '--purge'],
      `${join(secure, 'data')}\n${join(secure, 'media')}\n`,
    );

    // The organization's own authority, and a server it vouches for: a published library, and
    // a sign-in provider's discovery document.
    const org = join(root, 'org');
    await mkdir(org);
    const ca = join(org, 'ca.pem');
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
    await run('openssl', [
      ...['req', '-x509', ...ec, '-days', '2', '-subj', '/CN=Example Org CA'],
      ...[
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign',
      ],
      ...['-keyout', join(org, 'ca-key.pem'), '-out', ca],
    ]);
    await run('openssl', [
      ...['req', ...ec, '-subj', `/CN=${address}`],
      ...['-keyout', join(org, 'key.pem'), '-out', join(org, 'server.csr')],
    ]);
    await writeFile(join(org, 'server.ext'), `subjectAltName=IP:${address}\n`);
    await run('openssl', [
      ...['x509', '-req', '-in', join(org, 'server.csr'), '-days', '2'],
      ...['-CA', ca, '-CAkey', join(org, 'ca-key.pem'), '-CAcreateserial'],
      ...['-extfile', join(org, 'server.ext'), '-out', join(org, 'cert.pem')],
    ]);
    let origin = '';
    secureSite = createHttpsServer(
      { key: await readFile(join(org, 'key.pem')), cert: await readFile(join(org, 'cert.pem')) },
      (request, answer) => {
        if (request.url !== '/.well-known/openid-configuration') return library(request, answer);
        answer.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
          }),
        );
      },
    );
    await new Promise<void>((done) => secureSite!.listen(0, '0.0.0.0', done));
    origin = `https://${address}:${(secureSite.address() as { port: number }).port}`;

    // The image's file: the release's, or one made of the image built beforehand.
    let file = process.env.SLIDR_IMAGE_FILE;
    if (!file) {
      file = join(root, 'image.tar.gz');
      await run('docker', ['tag', IMAGE, 'slidr-library:offline']);
      await run('sh', ['-c', `docker save slidr-library:offline | gzip > '${file}'`]);
      await run('docker', ['rmi', 'slidr-library:offline']);
    }
    const loads = JSON.parse((await run('tar', ['-xzOf', file, 'manifest.json'])).stdout) as {
      RepoTags: string[];
    }[];
    const tag = loads[0]!.RepoTags[0]!;
    const fileSha = (await run('sha256sum', [file])).stdout.split(' ')[0]!;
    // The script as a release writes it, its image by a digest no registry has: Docker has to
    // find the image here.
    const released = async (sha: string) => {
      const script = (await readFile(SCRIPT, 'utf8'))
        .replace(/^VERSION=""$/m, 'VERSION="0.0.0-test"')
        .replace(/^IMAGE=""$/m, `IMAGE="${tag}@sha256:${'0'.repeat(64)}"`)
        .replace(/^IMAGE_FILE_AMD64=""$/m, `IMAGE_FILE_AMD64="${sha}"`)
        .replace(/^IMAGE_FILE_ARM64=""$/m, `IMAGE_FILE_ARM64="${sha}"`);
      const path = join(root, `install-${sha.slice(0, 12)}.sh`);
      await writeFile(path, script);
      return path;
    };
    const { media, data } = await place('closed');
    const given = [
      ...['--media', media, '--owner', OWNER, '--data', data, '--port', String(PORT)],
      `--seed=${origin}/`,
    ];

    // Refused, and nothing written: a file that is not the release's, and a key among the
    // authorities.
    const other = await installBy(await released('f'.repeat(64)), [
      ...['--image-file', file, '--ca', ca],
      ...given,
    ]);
    assert.notEqual(other.code, 0);
    assert.match(other.out, /is not the image of Slidr Library 0\.0\.0-test/);
    const keyed = join(org, 'keyed.pem');
    await writeFile(
      keyed,
      `${await readFile(ca, 'utf8')}${await readFile(join(org, 'ca-key.pem'), 'utf8')}`,
    );
    const key = await install(['--ca', keyed, ...given]);
    assert.notEqual(key.code, 0);
    assert.match(key.out, /holds a private key/);
    assert.equal((await sh('test', ['-e', '/etc/slidr-library/compose.yaml'])).code, 1);

    const done = await installBy(await released(fileSha), [
      ...['--image-file', file, '--ca', ca],
      ...given,
    ]);
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /the release's \(checked\)/);
    assert.match(done.out, /trusts: {4}the authorities of/);
    const compose = async () => (await sh('sudo', ['cat', '/etc/slidr-library/compose.yaml'])).out;
    assert.ok((await compose()).includes(`image: "${tag}"`), await compose());
    assert.match(await compose(), /NODE_EXTRA_CA_CERTS: "\/library\/ca\/ca\.pem"/);
    // Seeded over HTTPS from a server that only the organization's authority vouches for.
    const manifest = (await (
      await fetch(`http://127.0.0.1:${PORT}/media/manifest.json`)
    ).json()) as Manifest;
    assert.equal(manifest.published, '2026-10-24T08:00:00.000Z');

    // The organization's provider, named: its discovery document is read over HTTPS.
    const signIn = () =>
      sh(
        'sudo',
        [
          ...['docker', 'exec', '-i', 'slidr-library', 'slidr-library', 'sign-in', 'oidc'],
          ...['--issuer', origin, '--client-id', 'library', '--name', 'Example'],
        ],
        'the-client-secret\n',
      );
    const named = await signIn();
    assert.equal(named.code, 0, named.out);
    assert.match(named.out, /People sign in through oidc now/);

    // The public authorities alone: the provider is not reached. The machine's own script runs
    // it, with no image to pull: the one it was installed with, from its file.
    const publicOnly = await command('ca', '--none');
    assert.equal(publicOnly.code, 0, publicOnly.out);
    assert.match(publicOnly.out, /trusts the public authorities alone/);
    assert.doesNotMatch(await compose(), /NODE_EXTRA_CA_CERTS/);
    assert.ok((await compose()).includes(`image: "${tag}"`), await compose());
    const unreached = await signIn();
    assert.notEqual(unreached.code, 0, unreached.out);
    assert.match(unreached.out, /could not be read/);

    // Trusted again.
    const trusted = await command('ca', ca);
    assert.equal(trusted.code, 0, trusted.out);
    assert.match(trusted.out, /trusts the authorities of \/etc\/slidr-library\/ca\/ca\.pem/);
    assert.equal((await signIn()).code, 0);
  });
});
