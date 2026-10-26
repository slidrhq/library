import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { build } from 'vite';

/**
 * The server as the image runs it: one file, built by `vite.node.config.ts`, which imports
 * nothing but Node's own modules (docs/PLAN.md P11).
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
let folder: string;
let bundle: string;
const running: ChildProcess[] = [];

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'slidr-library-bundle-'));
  await build({
    configFile: join(root, 'vite.node.config.ts'),
    root,
    logLevel: 'silent',
    build: { outDir: join(folder, 'node'), sourcemap: false },
  });
  bundle = join(folder, 'node', 'library.mjs');
  await mkdir(join(folder, 'client'));
  await writeFile(
    join(folder, 'client', 'index.html'),
    '<!doctype html><html><head><title>L</title></head></html>',
  );
});

after(async () => {
  for (const child of running) child.kill();
  await rm(folder, { recursive: true, force: true });
});

const env = () => ({ ...process.env, LIBRARY_CLIENT: join(folder, 'client') });

/** Runs a command of the bundle to its end: what it printed, and how it ended. */
function run(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: env() });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => done({ code, out }));
  });
}

describe('the server in one file', () => {
  test('imports nothing but Node’s own modules', async () => {
    const code = await readFile(bundle, 'utf8');
    const imported = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((one) => one[1]);
    assert.ok(imported.length > 0);
    assert.deepEqual(
      imported.filter((name) => !name!.startsWith('node:')),
      [],
    );
  });

  test('installs a library, serves it, and tells where it is', async () => {
    const data = join(folder, 'data');
    const media = join(folder, 'media');
    const key = join(folder, 'keys', 'master.key');
    const installed = await run(
      'init',
      '--data',
      data,
      '--owner',
      'owner@example.org',
      '--media',
      media,
      '--master-key-file',
      key,
    );
    assert.equal(installed.code, 0, installed.out);
    assert.match(installed.out, /Installed the library/);

    const server = spawn(process.execPath, [bundle, 'start', '--data', data, '--port', '0'], {
      env: env(),
    });
    running.push(server);
    const url = await new Promise<string>((done, fail) => {
      let out = '';
      server.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const found = /Slidr Library: (\S+)/.exec(out);
        if (found) done(found[1]!);
      });
      server.on('close', () => fail(new Error(`The server ended: ${out}`)));
    });
    const me = (await (await fetch(new URL('api/me', url))).json()) as { local: boolean };
    assert.equal(me.local, true);
    const page = await (await fetch(url)).text();
    assert.match(page, /globalThis.__slidrMediaPath = "\/media\/"/);
    assert.equal((await fetch(new URL('media/manifest.json', url))).status, 404);

    const status = await run('status', '--data', data);
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /running: {4}yes/);
    assert.match(status.out, /test: {7}written to; it holds no library yet/);
    const login = await run('login', '--data', data);
    assert.match(login.out, /auth\/local\?code=[A-Za-z0-9_-]{43}/);
    server.kill();
  });
});
