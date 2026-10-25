/**
 * The people of the library (docs/SPEC.md §6): its owner, who installed it; the members an admin
 * names by email, reviewers and admins; and everyone who has signed in, who may upload. Each is
 * `people/<email>.json` in the state store, by the address in small letters. Roles are read from
 * here on every request, never from a session, so a role given or taken away counts at once.
 */
import type { Bucket } from './bucket.ts';
import type { Context } from './context.ts';

/** What a member may do beyond uploading: review; and besides that administer. The owner is one. */
export const ROLES = ['owner', 'admin', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** The roles an admin gives; the owner's is handed over by the owner alone. */
export const MEMBER_ROLES = ['reviewer', 'admin'] as const satisfies readonly Role[];
export type MemberRole = (typeof MEMBER_ROLES)[number];

const RANK: Record<Role, number> = { reviewer: 1, admin: 2, owner: 3 };

/** How far a role reaches: none 0, a reviewer 1, an admin 2, the owner 3. */
export const rankOf = (role: Role | undefined) => (role ? RANK[role] : 0);

export interface Person {
  email: string;
  /** As their provider names them, when they have signed in. */
  name?: string;
  role?: Role;
  /** May not upload, nor use a token; sees the library as anyone does. */
  blocked?: boolean;
  /** When they were first named or seen, and by whom: an address, `install`, `sign-in`. */
  added: string;
  by: string;
  lastSeen?: string;
}

/** What a person may do, as the page shows it (`GET /api/me`). */
export interface Capabilities {
  upload: boolean;
  review: boolean;
  /** Publish what was approved and waits. */
  publish: boolean;
  members: boolean;
  settings: boolean;
  owner: boolean;
}

export function capabilitiesOf(person: Pick<Person, 'role' | 'blocked'> | undefined): Capabilities {
  const rank = person?.blocked ? 0 : rankOf(person?.role);
  return {
    upload: !person?.blocked,
    review: rank >= RANK.reviewer,
    publish: rank >= RANK.reviewer,
    members: rank >= RANK.admin,
    settings: rank >= RANK.admin,
    owner: rank >= RANK.owner,
  };
}

/** An address as the library keeps it. */
export const emailOf = (text: string) => text.trim().toLowerCase();

/** Whether a text is an address: something, `@`, a domain with a dot in it. */
export const isEmail = (text: string) => /^[^\s@/]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text.trim());

const PREFIX = 'people/';
const keyOf = (email: string) => `${PREFIX}${emailOf(email)}.json`;
const RECORD = /^people\/([^/]+)\.json$/;

export async function readPerson(store: Bucket, email: string): Promise<Person | undefined> {
  const object = await store.get(keyOf(email));
  return object ? (JSON.parse(await object.text()) as Person) : undefined;
}

export async function writePerson(store: Bucket, person: Person): Promise<void> {
  const record: Person = { ...person, email: emailOf(person.email) };
  if (!record.role) delete record.role;
  if (!record.blocked) delete record.blocked;
  await store.put(keyOf(record.email), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** Everyone the library knows: members, the blocked, and whoever has signed in. */
export async function listPeople(store: Bucket): Promise<Person[]> {
  const people: Person[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await store.list({ prefix: PREFIX, startAfter });
    for (const { key } of page.objects) {
      if (!RECORD.test(key)) continue;
      const object = await store.get(key);
      if (object) people.push(JSON.parse(await object.text()) as Person);
    }
    if (!page.truncated || page.objects.length === 0) return people;
    startAfter = page.objects.at(-1)!.key;
  }
}

/** Records that someone signed in: when, and the name their provider gives. */
export async function seen(store: Bucket, who: { email: string; name?: string }, at: string) {
  const known = await readPerson(store, who.email);
  await writePerson(store, {
    ...(known ?? { email: who.email, added: at, by: 'sign-in' }),
    ...(who.name && who.name !== who.email ? { name: who.name } : {}),
    lastSeen: at,
  });
}

const IMPORTED = 'config/people.json';
const settled = new WeakMap<Bucket, Promise<void>>();

/**
 * On Cloudflare, the people of a library that named its editors in the Worker's secrets before
 * it kept its own (docs/SPEC.md §13): once, when the store names no one, `LIBRARY_OWNER` (or
 * else the first address of `LIBRARY_EDITORS`) becomes the owner, and the other editors
 * reviewers. After that the store alone says who is who.
 */
export function settlePeople(ctx: Context): Promise<void> {
  const store = ctx.state;
  if (!store) return Promise.resolve();
  let done = settled.get(store);
  if (!done) {
    done = importPeople(store, ctx).catch((error: unknown) => {
      settled.delete(store);
      throw error;
    });
    settled.set(store, done);
  }
  return done;
}

async function importPeople(store: Bucket, ctx: Context) {
  if (await store.get(IMPORTED)) return;
  const editors = (ctx.auth.editors ?? '')
    .split(/[\s,;]+/)
    .filter(isEmail)
    .map(emailOf);
  const owner = ctx.auth.owner && isEmail(ctx.auth.owner) ? emailOf(ctx.auth.owner) : editors[0];
  if (!owner) return;
  const at = new Date().toISOString();
  const known = await listPeople(store);
  if (!known.some((person) => person.role === 'owner')) {
    const before = known.find((person) => person.email === owner);
    await writePerson(store, {
      ...(before ?? { added: at, by: 'import' }),
      email: owner,
      role: 'owner',
      blocked: false,
    });
  }
  const reviewers = editors.filter((email) => email !== owner);
  for (const email of reviewers) {
    const before = await readPerson(store, email);
    if (!before?.role && !before?.blocked) {
      await writePerson(store, {
        ...(before ?? { email, added: at, by: 'import' }),
        role: 'reviewer',
      });
    }
  }
  await store.put(IMPORTED, JSON.stringify({ imported: at, owner, reviewers }), {
    httpMetadata: { contentType: 'application/json' },
  });
}
