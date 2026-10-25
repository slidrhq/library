import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { readAudit } from './audit.ts';
import { readPerson, writePerson } from './people.ts';
import { EDITOR, MemoryBucket, caller, designSlide, publishLibrary } from './uploads/testing.ts';

afterEach(() => mock.restoreAll());

/** The people of a library, by what they are to it. */
const PEOPLE = {
  someone: 'someone@example.com',
  reviewer: 'reviewer@example.com',
  admin: 'admin@example.com',
  // The first editor the Worker names becomes the owner (`settlePeople`).
  owner: EDITOR,
  blocked: 'blocked@example.com',
} as const;
type Who = keyof typeof PEOPLE;

const read = async <T>(response: Response) => (await response.json()) as T;

/** A library with each of its people, and a way to call it as any of them. */
async function library() {
  publishLibrary(['images/designs/m-techmeetup.webp']);
  const owner = await caller();
  const at = new Date().toISOString();
  await writePerson(owner.bucket, { email: PEOPLE.reviewer, role: 'reviewer', added: at, by: 't' });
  await writePerson(owner.bucket, { email: PEOPLE.admin, role: 'admin', added: at, by: 't' });
  await writePerson(owner.bucket, { email: PEOPLE.blocked, blocked: true, added: at, by: 't' });
  const as = (who: Who) => (who === 'owner' ? owner : caller({ email: PEOPLE[who] }, owner.bucket));
  /** An upload of the owner's, waiting. */
  const upload = async () => {
    const response = await owner.send('/api/uploads', 'POST', {
      type: 'designs',
      action: 'translate',
      id: 'm-techmeetup',
      languages: { fr: { slide: designSlide('fr') } },
    });
    return ((await response.json()) as { id: string }).id;
  };
  return { owner, as, upload };
}

describe('what each of the library’s people may do', () => {
  /** Each route, and what it answers each person: past the check of who may, or why not. */
  const TABLE: [
    string,
    (call: Awaited<ReturnType<typeof caller>>, id: string) => Promise<Response>,
    Record<Who, number | string>,
  ][] = [
    [
      'list the uploads',
      (one) => one.call('/api/uploads'),
      { someone: 200, reviewer: 200, admin: 200, owner: 200, blocked: 200 },
    ],
    [
      'upload',
      (one) => one.send('/api/uploads', 'POST', {}),
      { someone: 422, reviewer: 422, admin: 422, owner: 422, blocked: 'blocked' },
    ],
    [
      'review another’s upload',
      (one, id) => one.send(`/api/uploads/${id}/status`, 'POST', { status: 'rejected' }),
      { someone: 'not-a-reviewer', reviewer: 200, admin: 200, owner: 200, blocked: 'blocked' },
    ],
    [
      'publish what waits',
      (one) => one.send('/api/publish', 'POST', {}),
      // Past the check, the library has no bucket for its media here.
      { someone: 'not-a-reviewer', reviewer: 503, admin: 503, owner: 503, blocked: 'blocked' },
    ],
    [
      'bring the library in',
      (one) => one.send('/api/library/import', 'POST', {}),
      {
        someone: 'not-an-admin',
        reviewer: 'not-an-admin',
        admin: 503,
        owner: 503,
        blocked: 'blocked',
      },
    ],
    [
      'list the members',
      (one) => one.call('/api/members'),
      {
        someone: 'not-an-admin',
        reviewer: 'not-an-admin',
        admin: 200,
        owner: 200,
        blocked: 'blocked',
      },
    ],
    [
      'hand the library over',
      (one) => one.send('/api/owner', 'POST', { email: 'nobody@example.com' }),
      // Past the check, the address is no member's.
      {
        someone: 'not-the-owner',
        reviewer: 'not-the-owner',
        admin: 'not-the-owner',
        owner: 409,
        blocked: 'blocked',
      },
    ],
  ];

  for (const [what, call, expected] of TABLE) {
    test(what, async () => {
      const { as, upload } = await library();
      for (const who of Object.keys(PEOPLE) as Who[]) {
        const answer = await call(await as(who), await upload());
        const wanted = expected[who];
        if (typeof wanted === 'number') assert.equal(answer.status, wanted, who);
        else {
          assert.equal(answer.status, 403, who);
          assert.equal((await read<{ error: string }>(answer)).error, wanted, who);
        }
      }
    });
  }
});

describe('the members', () => {
  test('are named by email, by an admin, and their role counts at once', async () => {
    const { as, upload } = await library();
    const admin = await as('admin');
    const someone = await as('someone');
    const id = await upload();
    const review = () => someone.send(`/api/uploads/${id}/status`, 'POST', { status: 'pending' });
    assert.equal((await review()).status, 403);
    const named = await admin.send('/api/members/Someone%40Example.com', 'PUT', {
      role: 'reviewer',
    });
    assert.equal(named.status, 200);
    assert.equal((await read<{ role: string }>(named)).role, 'reviewer');
    // Rejected first, so sending it back is a move the reviewer may make.
    await admin.send(`/api/uploads/${id}/status`, 'POST', { status: 'rejected' });
    assert.equal((await review()).status, 200);
    assert.equal(
      (await admin.call('/api/members/someone%40example.com', { method: 'DELETE' })).status,
      204,
    );
    assert.equal((await review()).status, 403);
    const listed = await read<{ people: { email: string; role: string | null }[] }>(
      await admin.call('/api/members'),
    );
    assert.deepEqual(
      listed.people.filter((one) => one.role).map((one) => [one.email, one.role]),
      [
        [EDITOR, 'owner'],
        [PEOPLE.admin, 'admin'],
        ['other-editor@example.com', 'reviewer'],
        [PEOPLE.reviewer, 'reviewer'],
      ],
    );
  });

  test('take only the roles an admin gives, and a real address', async () => {
    const { as } = await library();
    const admin = await as('admin');
    for (const role of ['owner', 'editor', undefined]) {
      const answer = await admin.send('/api/members/x%40example.com', 'PUT', { role });
      assert.equal(answer.status, 400, String(role));
    }
    const bad = await admin.send('/api/members/not-an-address', 'PUT', { role: 'reviewer' });
    assert.equal((await read<{ error: string }>(bad)).error, 'bad-email');
  });

  test('never change the owner’s place, which the owner hands over', async () => {
    const { owner, as, upload } = await library();
    const admin = await as('admin');
    const at = `/api/members/${encodeURIComponent(EDITOR)}`;
    for (const answer of [
      await admin.send(at, 'PUT', { role: 'reviewer' }),
      await admin.call(at, { method: 'DELETE' }),
      await admin.send(`/api/people/${encodeURIComponent(EDITOR)}`, 'PUT', { blocked: true }),
    ]) {
      assert.equal(answer.status, 409);
      assert.equal((await read<{ error: string }>(answer)).error, 'owner');
    }
    const notMember = await owner.send('/api/owner', 'POST', { email: PEOPLE.someone });
    assert.equal((await read<{ error: string }>(notMember)).error, 'not-a-member');
    const handed = await owner.send('/api/owner', 'POST', { email: PEOPLE.admin });
    assert.equal(handed.status, 200);
    assert.equal((await readPerson(owner.bucket, PEOPLE.admin))?.role, 'owner');
    assert.equal((await readPerson(owner.bucket, EDITOR))?.role, 'admin');
    // The old owner is an admin now, and hands nothing over.
    const again = await owner.send('/api/owner', 'POST', { email: PEOPLE.reviewer });
    assert.equal((await read<{ error: string }>(again)).error, 'not-the-owner');
    assert.equal((await owner.call('/api/members')).status, 200);
    void upload;
  });
});

describe('blocking', () => {
  test('stops a person uploading, and takes a role away for good', async () => {
    const { as } = await library();
    const admin = await as('admin');
    const reviewer = await as('reviewer');
    const blocked = await admin.send(`/api/people/${encodeURIComponent(PEOPLE.reviewer)}`, 'PUT', {
      blocked: true,
    });
    assert.deepEqual(
      (({ role, blocked: is }) => ({ role, is }))(
        await read<{ role: null; blocked: boolean }>(blocked),
      ),
      { role: null, is: true },
    );
    const refused = await reviewer.send('/api/uploads', 'POST', {});
    assert.equal((await read<{ error: string }>(refused)).error, 'blocked');
    // They still see the library, and their own uploads.
    assert.equal((await reviewer.call('/api/uploads')).status, 200);
    const me = await read<{ user: { role: null; blocked: boolean; can: { upload: boolean } } }>(
      await reviewer.call('/api/me'),
    );
    assert.deepEqual([me.user.role, me.user.blocked, me.user.can.upload], [null, true, false]);
    await admin.send(`/api/people/${encodeURIComponent(PEOPLE.reviewer)}`, 'PUT', {
      blocked: false,
    });
    assert.equal((await reviewer.send('/api/uploads', 'POST', {})).status, 422);
    assert.equal((await readPerson(admin.bucket, PEOPLE.reviewer))?.role, undefined);
    const self = await admin.send(`/api/people/${encodeURIComponent(PEOPLE.admin)}`, 'PUT', {
      blocked: true,
    });
    assert.equal((await read<{ error: string }>(self)).error, 'self');
  });
});

describe('the audit', () => {
  test('records who named, removed, blocked and handed over', async () => {
    const { owner, as } = await library();
    const admin = await as('admin');
    await admin.send('/api/members/new%40example.com', 'PUT', { role: 'admin' });
    await admin.call('/api/members/new%40example.com', { method: 'DELETE' });
    await admin.send('/api/people/spam%40example.com', 'PUT', { blocked: true });
    await owner.send('/api/owner', 'POST', { email: PEOPLE.admin });
    const entries = await readAudit(owner.bucket);
    assert.deepEqual(entries.map((one) => [one.action, one.by, one.target]).reverse(), [
      ['member.role', PEOPLE.admin, 'new@example.com'],
      ['member.removed', PEOPLE.admin, 'new@example.com'],
      ['person.blocked', PEOPLE.admin, 'spam@example.com'],
      ['owner.handed', EDITOR, PEOPLE.admin],
    ]);
  });
});

describe('the people of a library the Worker named', () => {
  test('come from its secrets once, its owner first', async () => {
    const bucket = new MemoryBucket();
    const first = await caller({}, bucket, { LIBRARY_OWNER: 'Boss@Example.com' });
    await first.call('/api/me');
    assert.equal((await readPerson(bucket, 'boss@example.com'))?.role, 'owner');
    assert.equal((await readPerson(bucket, EDITOR))?.role, 'reviewer');
    assert.equal((await readPerson(bucket, 'other-editor@example.com'))?.role, 'reviewer');
    // Later changes to the secrets do not count: the library names its own people now.
    const later = await caller({ email: 'late@example.com' }, bucket, {
      LIBRARY_EDITORS: 'late@example.com',
    });
    await later.call('/api/me');
    assert.equal((await readPerson(bucket, 'late@example.com'))?.role, undefined);
  });
});
