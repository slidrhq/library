import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import worker from '../host/cloudflare/index.ts';
import { writeConfig } from './config.ts';
import { forgetWrites } from './limits.ts';
import { writePerson } from './people.ts';
import { EDITOR, SITE, caller, designSlide, publishLibrary } from './uploads/testing.ts';

afterEach(() => {
  mock.restoreAll();
  forgetWrites();
});

const read = async <T>(response: Response) => (await response.json()) as T;

interface Made {
  token: string;
  id: string;
  name: string;
  scope: string;
  hint: string;
  expires?: string;
}

/** A library, its owner, and someone without a role, signed in on the page. */
async function library(limits?: object) {
  publishLibrary(['images/designs/m-techmeetup.webp']);
  const owner = await caller();
  if (limits) {
    await writeConfig(owner.bucket, {
      version: 1,
      installed: new Date().toISOString(),
      limits,
    });
  }
  const someone = await caller({ email: 'someone@example.com' }, owner.bucket);
  /** Calls the Worker with a token alone: no cookie, no Origin. */
  const withToken = (token: string, path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(SITE + path, {
        ...init,
        headers: { ...(init.headers as object), Authorization: `Bearer ${token}` },
      }),
      owner.env,
    );
  const french = {
    type: 'designs',
    action: 'translate',
    id: 'm-techmeetup',
    languages: { fr: { slide: designSlide('fr') } },
  };
  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { owner, someone, withToken, french, json };
}

const make = async (who: Awaited<ReturnType<typeof caller>>, body: object) =>
  read<Made>(await who.send('/api/me/tokens', 'POST', body));

describe('a token', () => {
  test('is made in the profile, shown once, and is all an upload needs', async () => {
    const { owner, someone, withToken, french, json } = await library();
    const made = await make(someone, { name: 'My script' });
    assert.match(made.token, /^slk_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.scope, 'upload');
    assert.equal(made.hint, made.token.slice(4, 10));
    // Ninety days, by default.
    const days = (Date.parse(made.expires!) - Date.now()) / 86_400_000;
    assert.ok(days > 89.9 && days <= 90);
    const uploaded = await withToken(made.token, '/api/uploads', json(french));
    assert.equal(uploaded.status, 201);
    const upload = await read<{ by: { id: string; token?: string } }>(uploaded);
    assert.deepEqual(upload.by, {
      id: 'someone@example.com',
      name: 'someone',
      token: 'My script',
    });
    // The library keeps its hash, never the token.
    for (const [key, held] of owner.bucket.objects) {
      assert.ok(!new TextDecoder().decode(held.data).includes(made.token), key);
    }
    const listed = await read<{ tokens: Made[] }>(await someone.call('/api/me/tokens'));
    assert.deepEqual(
      listed.tokens.map((one) => [one.name, one.hint, 'token' in one]),
      [['My script', made.hint, false]],
    );
  });

  test('uploads, and does nothing a person does on the page', async () => {
    const { owner, someone, withToken, json } = await library();
    const made = await make(someone, { name: 'uploader' });
    const refused = async (answer: Response) => {
      assert.equal(answer.status, 403);
      assert.equal((await read<{ error: string }>(answer)).error, 'token-scope');
    };
    await refused(await withToken(made.token, '/api/publish', json({})));
    await refused(await withToken(made.token, '/api/me/tokens', json({ name: 'another' })));
    await refused(await withToken(made.token, '/api/members'));
    // A reviewer's token that uploads does not review either.
    const reviewer = await caller({ email: 'other-editor@example.com' }, owner.bucket);
    const theirs = await make(reviewer, { name: 'reviewer’s' });
    const pending = await read<{ id: string }>(
      await owner.send('/api/uploads', 'POST', {
        type: 'designs',
        action: 'translate',
        id: 'm-techmeetup',
        languages: { de: { slide: designSlide('de') } },
      }),
    );
    await refused(
      await withToken(
        theirs.token,
        `/api/uploads/${pending.id}/status`,
        json({ status: 'rejected' }),
      ),
    );
  });

  test('publishes, when an admin made it, while they are one', async () => {
    const { owner, someone, withToken, json } = await library();
    const refused = await someone.send('/api/me/tokens', 'POST', { name: 'p', scope: 'publish' });
    assert.equal((await read<{ error: string }>(refused)).error, 'not-an-admin');
    const made = await make(owner, { name: 'media:publish', scope: 'publish', days: null });
    assert.equal(made.expires, undefined);
    // Past the check, the library has no bucket for its media here.
    assert.equal((await withToken(made.token, '/api/publish', json({}))).status, 503);
    assert.equal((await withToken(made.token, '/api/library/import', json({}))).status, 503);
    // Its owner hands the library over and stays an admin; an admin no more, the token publishes nothing.
    await writePerson(owner.bucket, {
      email: EDITOR,
      added: new Date().toISOString(),
      by: 'test',
    });
    const after = await withToken(made.token, '/api/publish', json({}));
    assert.equal((await read<{ error: string }>(after)).error, 'token-scope');
    // It still uploads, as its owner.
    assert.equal((await withToken(made.token, '/api/uploads')).status, 200);
  });

  test('is judged alone, whatever cookie comes with it', async () => {
    const { owner, someone, french } = await library();
    const made = await make(someone, { name: 'mine' });
    await someone.send('/api/uploads', 'POST', french);
    // The owner's session, and someone's token: the token wins, and sees someone's uploads only.
    const answer = await owner.call('/api/uploads', {
      headers: { Authorization: `Bearer ${made.token}` },
    });
    const listed = await read<{ uploads: { by: string }[] }>(answer);
    assert.deepEqual([...new Set(listed.uploads.map((one) => one.by))], ['someone@example.com']);
  });

  test('opens nothing revoked, expired, or of someone blocked, and says no more', async () => {
    const { owner, someone, withToken } = await library();
    const answers: Response[] = [];
    const revoked = await make(someone, { name: 'revoked' });
    assert.equal(
      (await someone.call(`/api/me/tokens/${revoked.id}`, { method: 'DELETE' })).status,
      204,
    );
    answers.push(await withToken(revoked.token, '/api/uploads'));
    const expired = await make(someone, { name: 'expired', days: 30 });
    const later = Date.now() + 31 * 86_400_000;
    mock.method(Date, 'now', () => later);
    answers.push(await withToken(expired.token, '/api/uploads'));
    mock.restoreAll();
    const blocked = await make(someone, { name: 'blocked' });
    await owner.send('/api/people/someone%40example.com', 'PUT', { blocked: true });
    answers.push(await withToken(blocked.token, '/api/uploads'));
    answers.push(await withToken(`slk_${'A'.repeat(43)}`, '/api/uploads'));
    const said = await Promise.all(
      answers.map(async (one) => [one.status, (await read<{ message: string }>(one)).message]),
    );
    assert.equal(new Set(said.map((one) => JSON.stringify(one))).size, 1);
    assert.equal(said[0]![0], 401);
  });

  test('is a person’s own, but an admin sees and revokes anyone’s; blocking revokes them all', async () => {
    const { owner, someone } = await library();
    const one = await make(someone, { name: 'one' });
    await make(someone, { name: 'two' });
    const theirs = await read<{ tokens: Made[] }>(
      await owner.call('/api/people/someone%40example.com/tokens'),
    );
    assert.deepEqual(theirs.tokens.map((token) => token.name).sort(), ['one', 'two']);
    assert.equal((await someone.call('/api/people/someone%40example.com/tokens')).status, 403);
    const gone = await owner.call(`/api/people/someone%40example.com/tokens/${one.id}`, {
      method: 'DELETE',
    });
    assert.equal(gone.status, 204);
    assert.equal((await owner.call(`/api/me/tokens/${one.id}`, { method: 'DELETE' })).status, 404);
    await owner.send('/api/people/someone%40example.com', 'PUT', { blocked: true });
    const left = await read<{ tokens: Made[] }>(
      await owner.call('/api/people/someone%40example.com/tokens'),
    );
    assert.deepEqual(left.tokens, []);
  });

  test('is named, scoped and timed as the library takes', async () => {
    const { someone } = await library();
    for (const body of [
      {},
      { name: '' },
      { name: 'x'.repeat(61) },
      { name: 'n', scope: 'all' },
      { name: 'n', days: 7 },
    ]) {
      assert.equal(
        (await someone.send('/api/me/tokens', 'POST', body)).status,
        400,
        JSON.stringify(body),
      );
    }
  });
});

describe('open uploading', () => {
  test('keeps a person to so many uploads waiting, and so many bytes', async () => {
    const { someone, owner, french } = await library({ pending: 2, bytes: 40 });
    assert.equal((await someone.send('/api/uploads', 'POST', french)).status, 201);
    const second = await someone.send('/api/uploads', 'POST', {
      ...french,
      languages: { de: { slide: designSlide('de') } },
    });
    assert.equal(second.status, 201);
    const third = await someone.send('/api/uploads', 'POST', {
      ...french,
      languages: { ja: { slide: designSlide('ja') } },
    });
    assert.equal(third.status, 409);
    assert.equal((await read<{ error: string }>(third)).error, 'limit');
    // A member is not held to it.
    const theirs = await owner.send('/api/uploads', 'POST', {
      ...french,
      languages: { ko: { slide: designSlide('ko') } },
    });
    assert.equal(theirs.status, 201);
  });

  test('keeps a person to so many writes a minute', async () => {
    const { someone } = await library({ writesPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await someone.send('/api/uploads', 'POST', {})).status);
    }
    assert.deepEqual(statuses, [422, 422, 422, 429]);
    const late = await someone.send('/api/uploads', 'POST', {});
    assert.match(late.headers.get('Retry-After') ?? '', /^\d+$/);
    // Reading is no write.
    assert.equal((await someone.call('/api/uploads')).status, 200);
  });

  test('keeps a person to so many tokens', async () => {
    const { someone } = await library({ tokens: 2 });
    await make(someone, { name: 'a' });
    await make(someone, { name: 'b' });
    const third = await someone.send('/api/me/tokens', 'POST', { name: 'c' });
    assert.equal(third.status, 409);
  });
});
