/**
 * The members of the library, named by email (docs/SPEC.md §6, §10):
 *
 *   GET    /api/members            everyone the library knows: members, the blocked, who signed in
 *   PUT    /api/members/{email}    { "role": "reviewer" | "admin" }: names a member, or changes a role
 *   DELETE /api/members/{email}    takes a member's role away; they may still upload
 *   PUT    /api/people/{email}     { "blocked": true | false }: blocks a person (and revokes every
 *                                  token of theirs), or lets them back
 *   POST   /api/owner              { "email" }: hands the library to another member
 *
 * An admin does all of these but the last, which is the owner's. No one changes the owner's role,
 * nor removes or blocks the owner. Each change goes into the audit (`audit.ts`).
 */
import { audit } from './audit.ts';
import type { Bucket } from './bucket.ts';
import type { Context } from './context.ts';
import { isRecord, json, jsonBody, problem } from './http.ts';
import {
  MEMBER_ROLES,
  emailOf,
  isEmail,
  listPeople,
  readPerson,
  writePerson,
  type MemberRole,
  type Person,
} from './people.ts';
import { revokeAll, revokeScope } from './tokens.ts';
import { authorize, type Actor } from './uploads/access.ts';

type Route = (request: Request, ctx: Context, params: string[]) => Promise<Response>;

const notSetUp = () =>
  problem(503, 'not-set-up', 'This server keeps no people: it has no store for them.');

/** The address of a route, or the answer to give for one that is none. */
export function addressOf(param: string | undefined): string | Response {
  let text: string;
  try {
    text = decodeURIComponent(param ?? '');
  } catch {
    text = '';
  }
  return isEmail(text) ? emailOf(text) : problem(400, 'bad-email', `${text} is not an address.`);
}

/** A person as the members' list shows them. */
const shown = (person: Person) => ({
  email: person.email,
  ...(person.name ? { name: person.name } : {}),
  role: person.role ?? null,
  blocked: Boolean(person.blocked),
  added: person.added,
  by: person.by,
  ...(person.lastSeen ? { lastSeen: person.lastSeen } : {}),
});

const RANKED: Record<string, number> = { owner: 0, admin: 1, reviewer: 2 };

const list: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'members');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const people = (await listPeople(ctx.state)).sort(
    (a, b) =>
      (RANKED[a.role ?? ''] ?? 3) - (RANKED[b.role ?? ''] ?? 3) || (a.email < b.email ? -1 : 1),
  );
  return json({ people: people.map(shown) });
};

/** The person a change is about, and who makes it, or the answer to give instead. */
async function subject(request: Request, ctx: Context, param: string | undefined) {
  const actor = await authorize(request, ctx, 'members');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const email = addressOf(param);
  if (email instanceof Response) return email;
  const person = await readPerson(ctx.state, email);
  if (person?.role === 'owner') {
    return problem(409, 'owner', 'The owner’s place is changed by the owner alone: hand it over.');
  }
  return { actor, store: ctx.state, email, person };
}

const now = () => new Date().toISOString();

const fresh = (email: string, actor: Actor): Person => ({ email, added: now(), by: actor.id });

const name: Route = async (request, ctx, [param]) => {
  const found = await subject(request, ctx, param);
  if (found instanceof Response) return found;
  const { actor, store, email, person } = found;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const role = isRecord(body) ? body.role : undefined;
  if (!(MEMBER_ROLES as readonly unknown[]).includes(role)) {
    return problem(400, 'bad-role', `The role is one of ${MEMBER_ROLES.join(', ')}.`);
  }
  if (person?.blocked) {
    return problem(409, 'blocked', `${email} is blocked: let them back first.`);
  }
  const named: Person = { ...(person ?? fresh(email, actor)), role: role as MemberRole };
  await writePerson(store, named);
  // Publish tokens are an admin's: one who is not any more has theirs taken away.
  const revoked = role === 'admin' ? 0 : await revokeScope(store, email, 'publish');
  await audit(store, {
    by: actor.id,
    action: 'member.role',
    target: email,
    detail: { from: person?.role ?? null, to: role, ...(revoked ? { revoked } : {}) },
  });
  return json(shown(named));
};

const remove: Route = async (request, ctx, [param]) => {
  const found = await subject(request, ctx, param);
  if (found instanceof Response) return found;
  const { actor, store, email, person } = found;
  if (person?.role) {
    const { role: _was, ...rest } = person;
    await writePerson(store, rest);
    const revoked = await revokeScope(store, email, 'publish');
    await audit(store, {
      by: actor.id,
      action: 'member.removed',
      target: email,
      detail: { role: person.role, ...(revoked ? { revoked } : {}) },
    });
  }
  return new Response(null, { status: 204 });
};

const block: Route = async (request, ctx, [param]) => {
  const found = await subject(request, ctx, param);
  if (found instanceof Response) return found;
  const { actor, store, email, person } = found;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const blocked = isRecord(body) ? body.blocked : undefined;
  if (typeof blocked !== 'boolean') {
    return problem(400, 'bad-request', 'blocked is true or false.');
  }
  if (actor.id === email && blocked) {
    return problem(409, 'self', 'You do not block yourself.');
  }
  const base = person ?? fresh(email, actor);
  // Blocking takes a member's role away; letting them back does not give it again.
  const { role: _was, ...rest } = base;
  const changed: Person = blocked ? { ...rest, blocked: true } : { ...base, blocked: false };
  await writePerson(store, changed);
  // A person blocked keeps no token: letting them back gives none again.
  const revoked = blocked ? await revokeAll(store, email) : 0;
  await audit(store, {
    by: actor.id,
    action: blocked ? 'person.blocked' : 'person.unblocked',
    target: email,
    ...(blocked ? { detail: { role: base.role ?? null, tokens: revoked } } : {}),
  });
  return json(shown(changed));
};

const handOver: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'owner');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const to = addressOf(isRecord(body) && typeof body.email === 'string' ? body.email : '');
  if (to instanceof Response) return to;
  if (!(await handOwnership(ctx.state, to, actor.id))) {
    return problem(
      409,
      'not-a-member',
      `${to} is not a member: name them a reviewer or an admin first.`,
    );
  }
  return json({ owner: to });
};

/**
 * Hands the library to a member, who becomes its owner, and the owner of before an admin: by the
 * owner (`POST /api/owner`), or from the machine of a local library, for an owner who lost their
 * way in (`slidr-library owner`). False, and nothing changed, for one who is not a member.
 */
export async function handOwnership(state: Bucket, to: string, by: string): Promise<boolean> {
  const next = await readPerson(state, to);
  if (!next?.role || next.role === 'owner' || next.blocked) return false;
  const owners = (await listPeople(state)).filter((person) => person.role === 'owner');
  await writePerson(state, { ...next, role: 'owner' });
  for (const owner of owners) await writePerson(state, { ...owner, role: 'admin' });
  await audit(state, { by, action: 'owner.handed', target: to });
  return true;
}

const EMAIL = '([^/]+)';
const ROUTES: [RegExp, Partial<Record<string, Route>>][] = [
  [/^\/api\/members$/, { GET: list }],
  [new RegExp(`^/api/members/${EMAIL}$`), { PUT: name, DELETE: remove }],
  [new RegExp(`^/api/people/${EMAIL}$`), { PUT: block }],
  [/^\/api\/owner$/, { POST: handOver }],
];

/** The answer to a request of the members; undefined for a path that is none of theirs. */
export function membersApi(request: Request, ctx: Context): Promise<Response> | undefined {
  const { pathname } = new URL(request.url);
  for (const [pattern, methods] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const route = methods[request.method];
    if (!route) {
      const response = problem(
        405,
        'method-not-allowed',
        `${pathname} takes ${Object.keys(methods).join(', ')}.`,
      );
      response.headers.set('Allow', Object.keys(methods).join(', '));
      return Promise.resolve(response);
    }
    return route(request, ctx, match.slice(1));
  }
  return undefined;
}
