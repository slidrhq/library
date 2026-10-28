import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { forgetLibrary } from './uploads/library.ts';
import { writePerson } from './people.ts';
import { MemoryBucket, caller } from './uploads/testing.ts';
import {
  MANIFEST,
  PUBLICATIONS,
  encodeManifest,
  sha256Hex,
  toBytes,
  toText,
  type Manifest,
} from './media/live.ts';
import { SYSTEM_SETTINGS } from './system.ts';

afterEach(() => {
  mock.restoreAll();
  forgetLibrary();
});

const read = async <T>(response: Response) => (await response.json()) as T;

/** A library live in its bucket, with one file, and its owner signed in. */
async function live() {
  const session = await caller();
  const media = new MemoryBucket();
  const bytes = toBytes('{"version":1,"families":[]}');
  const sha256 = await sha256Hex(bytes);
  await media.put('fonts/catalog.json', bytes, { customMetadata: { sha256 } });
  const manifest: Manifest = {
    version: 1,
    published: '2026-10-19T22:14:16.216Z',
    files: { 'fonts/catalog.json': { size: bytes.length, sha256 } },
  };
  const text = encodeManifest(manifest);
  await media.put(MANIFEST, text, { customMetadata: { sha256: await sha256Hex(toBytes(text)) } });
  Object.assign(session.env, { MEDIA: media });
  const manifestOf = () => JSON.parse(toText(media.objects.get(MANIFEST)!.data)) as Manifest;
  const fileOf = () => {
    const held = media.objects.get(SYSTEM_SETTINGS);
    return held ? (JSON.parse(toText(held.data)) as Record<string, unknown>) : undefined;
  };
  return { ...session, media, manifestOf, fileOf };
}

const SETTINGS = {
  agents: {
    offered: ['claude-code', 'acme'],
    default: 'acme',
    webAccess: 'off',
    custom: [
      {
        id: 'acme',
        name: 'Acme Agent',
        glyph: 'A',
        tone: 'teal',
        command: '%LOCALAPPDATA%\\Programs\\Acme\\acme.exe',
        args: ['--quiet'],
        env: { ACME_REGION: 'eu' },
        install: { winget: 'Acme.Agent' },
      },
    ],
  },
  languages: { offered: ['he', 'en', 'ar'], default: 'he' },
  images: { offered: ['codex-cli'] },
  stock: { offered: ['pexels', 'unsplash'], default: 'pexels' },
};

describe('the system settings', () => {
  test('are published into the media, as a file the apps read', async () => {
    const library = await live();
    assert.deepEqual(await read(await library.call('/api/settings/system')), {
      path: SYSTEM_SETTINGS,
      settings: null,
    });

    const answer = await library.send('/api/settings/system', 'PUT', SETTINGS);
    assert.equal(answer.status, 200, await answer.clone().text());
    const { settings, published } = await read<{
      settings: Record<string, unknown>;
      published: string;
    }>(answer);
    assert.ok(published);

    // The manifest names the file, with its hash, and was published with it.
    const manifest = library.manifestOf();
    assert.equal(manifest.published, published);
    const file = library.media.objects.get(SYSTEM_SETTINGS)!;
    assert.deepEqual(manifest.files[SYSTEM_SETTINGS], {
      size: file.data.length,
      sha256: await sha256Hex(file.data),
    });
    assert.equal(file.http.contentType, 'application/json');

    // What was given, with the version and the moment; nothing that defaults to nothing.
    const written = library.fileOf()!;
    assert.equal(written.version, 1);
    assert.equal(typeof written.updated, 'string');
    assert.deepEqual(written.agents, SETTINGS.agents);
    assert.deepEqual(written.images, { offered: ['codex-cli'] });
    assert.deepEqual(settings.languages, SETTINGS.languages);

    // Read back as the media holds it, and recorded as a publication of its file.
    const again = await read<{ settings: Record<string, unknown> }>(
      await library.call('/api/settings/system'),
    );
    assert.deepEqual(again.settings, settings);
    const record = library.bucket.objects.get(`${PUBLICATIONS}/${published}.json`);
    assert.ok(record);
    const recorded = JSON.parse(toText(record.data)) as { kind: string; added: string[] };
    assert.equal(recorded.kind, 'files');
    assert.deepEqual(recorded.added, [SYSTEM_SETTINGS]);
  });

  test('replace what was published, and are taken away', async () => {
    const library = await live();
    assert.equal((await library.send('/api/settings/system', 'PUT', SETTINGS)).status, 200);
    const changed = await library.send('/api/settings/system', 'PUT', {
      languages: { offered: ['en'] },
    });
    assert.equal(changed.status, 200, await changed.clone().text());
    const written = library.fileOf()!;
    assert.deepEqual(written.languages, { offered: ['en'] });
    assert.equal(written.agents, undefined);

    assert.equal((await library.call('/api/settings/system', { method: 'DELETE' })).status, 204);
    assert.equal(library.fileOf(), undefined);
    assert.equal(library.manifestOf().files[SYSTEM_SETTINGS], undefined);
    assert.ok(library.manifestOf().files['fonts/catalog.json']);
    // Taking away what is not there publishes nothing.
    const before = library.manifestOf().published;
    assert.equal((await library.call('/api/settings/system', { method: 'DELETE' })).status, 204);
    assert.equal(library.manifestOf().published, before);
  });

  test('that do not hold are refused, each where it fails', async () => {
    const library = await live();
    const refused = async (settings: unknown, path: string) => {
      const answer = await library.send('/api/settings/system', 'PUT', settings);
      assert.equal(answer.status, 400, JSON.stringify(settings));
      const { issues } = await read<{ issues: { path: string }[] }>(answer);
      assert.ok(
        issues.some((issue) => issue.path === path),
        `${path} in ${JSON.stringify(issues)}`,
      );
    };
    const agent = SETTINGS.agents.custom[0]!;
    await refused({ languages: { offered: ['he'], default: 'en' } }, 'languages.default');
    await refused({ languages: { offered: ['xx'] } }, 'languages.offered.0');
    await refused({ agents: { offered: ['nobody'] } }, 'agents.offered.0');
    await refused({ agents: { default: 'nobody' } }, 'agents.default');
    await refused({ agents: { custom: [{ ...agent, id: 'claude-code' }] } }, 'agents.custom.0.id');
    await refused({ agents: { custom: [agent, agent] } }, 'agents.custom.1.id');
    await refused(
      { agents: { custom: [{ ...agent, command: 'acme.cmd' }] } },
      'agents.custom.0.command',
    );
    await refused(
      { agents: { custom: [{ ...agent, command: 'tools\\acme.exe' }] } },
      'agents.custom.0.command',
    );
    await refused(
      { agents: { custom: [{ ...agent, env: { SLIDR_MCP_TOKEN: 'x' } }] } },
      'agents.custom.0.env',
    );
    await refused({ agents: { custom: [{ ...agent, glyph: 'ABC' }] } }, 'agents.custom.0.glyph');
    await refused({ agents: { webAccess: 'sometimes' } }, 'agents.webAccess');
    await refused({ images: { offered: [] } }, 'images.offered');
    assert.equal(library.fileOf(), undefined);
  });

  test('are an admin’s to change', async () => {
    const library = await live();
    const at = new Date().toISOString();
    await writePerson(library.bucket, {
      email: 'reviewer@example.com',
      role: 'reviewer',
      added: at,
      by: 't',
    });
    await writePerson(library.bucket, {
      email: 'admin@example.com',
      role: 'admin',
      added: at,
      by: 't',
    });
    const as = async (email: string) => {
      const one = await caller({ email }, library.bucket);
      Object.assign(one.env, { MEDIA: library.media });
      return one;
    };
    for (const email of ['someone@example.com', 'reviewer@example.com']) {
      const one = await as(email);
      for (const answer of [
        await one.call('/api/settings/system'),
        await one.send('/api/settings/system', 'PUT', SETTINGS),
      ]) {
        assert.equal(answer.status, 403, email);
        assert.equal((await read<{ error: string }>(answer)).error, 'not-an-admin');
      }
    }
    const admin = await as('admin@example.com');
    assert.equal((await admin.send('/api/settings/system', 'PUT', SETTINGS)).status, 200);
  });

  test('wait for the library to be in its bucket', async () => {
    const session = await caller();
    Object.assign(session.env, { MEDIA: new MemoryBucket() });
    const answer = await session.send('/api/settings/system', 'PUT', SETTINGS);
    assert.equal(answer.status, 409);
    assert.equal((await read<{ error: string }>(answer)).error, 'not-live');
  });
});
