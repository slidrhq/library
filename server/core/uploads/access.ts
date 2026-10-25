/**
 * Who may do what (docs/SPEC.md §6.1, §7). Every route that is not open to anyone asks here first,
 * naming what it is about to do, and goes on as the actor it answers, or gives its answer instead
 * (401, 403, 429).
 *
 * - **A person**, signed in on the library's own page (`../auth.ts`): anyone may upload, and see and
 *   change their own uploads while they wait; a reviewer sees every upload, reviews them and
 *   publishes what waits; an admin also names the members, and publishes an author's files. A
 *   request that changes something must come from the library's own page (its `Origin`).
 * - **A person's token** (`slk_…`, `../tokens.ts`), all a program needs, in
 *   `Authorization: Bearer`: it sends no cookie, and so is not asked which site it comes from. It
 *   acts as its owner, within its scope: `upload`, or, an admin's, `publish`. Reviewing and
 *   administering are a session's (D8).
 * - **A program by a key of the host's** (`LIBRARY_KEYS`), as before people had tokens: it uploads
 *   and publishes. It goes once the programs use tokens (docs/PLAN.md, P9).
 *
 * Anyone without a role is held to the limits of open uploading (`../limits.ts`). What the API
 * describes (`/api/content`, `/api/openapi.json`, `/api/schemas/`) is open to anyone.
 */
import { fromThisSite, signedIn } from '../auth.ts';
import type { Context } from '../context.ts';
import { problem } from '../http.ts';
import { limitsOf, tooFast } from '../limits.ts';
import { rankOf, readPerson, settlePeople, type Role } from '../people.ts';
import { isToken, tokenOf, type Scope } from '../tokens.ts';

/** What a request is about to do. */
export type Permission =
  /** List one's own uploads, and read one. */
  | 'read-own'
  /** Upload, change one's own upload while it waits (its languages), and withdraw it. */
  | 'upload'
  /** Make, list and revoke one's own tokens. */
  | 'tokens'
  /** List every upload, and read any. */
  | 'read-all'
  /** Accept an upload, reject it, or send it back to wait. */
  | 'review'
  /** Publish the uploads that were accepted and wait (`POST /api/publish`). */
  | 'publish-waiting'
  /** Publish an author's files, and bring the library into its store. */
  | 'publish-files'
  /** Name the members, block people, revoke their tokens. */
  | 'members'
  /** Change the library's settings and keys. */
  | 'settings'
  /** Hand the library over to another owner. */
  | 'owner';

/** The least role each permission takes. */
const LEAST: Record<Permission, Role | undefined> = {
  'read-own': undefined,
  upload: undefined,
  tokens: undefined,
  'read-all': 'reviewer',
  review: 'reviewer',
  'publish-waiting': 'reviewer',
  'publish-files': 'admin',
  members: 'admin',
  settings: 'admin',
  owner: 'owner',
};

const PUBLISHING: readonly Permission[] = [
  'read-own',
  'upload',
  'read-all',
  'publish-waiting',
  'publish-files',
];

/** What a token of each scope may do, and a program by a key of the host's. */
const MAY: Record<Scope | 'program', ReadonlySet<Permission>> = {
  upload: new Set(['read-own', 'upload']),
  publish: new Set(PUBLISHING),
  program: new Set(PUBLISHING),
};

/** Who did something, as an upload records it. */
export interface Recorded {
  /** A person's address, or `key:<name>` for a program. */
  id: string;
  name?: string;
  /** The name of the token it was done by, when it was. */
  token?: string;
}

/** Who a request comes from. */
export interface Actor extends Recorded {
  /** A person's role, when they have one. */
  role?: Role;
  /** How the request came: a person's session or token, or a program's key. */
  via: 'session' | 'token' | 'key';
  /** A token's scope. */
  scope?: Scope;
}

/** An actor as an upload records them: who, and nothing of what they could do then. */
export const recordOf = (actor: Recorded): Recorded => ({
  id: actor.id,
  ...(actor.name ? { name: actor.name } : {}),
  ...(actor.token ? { token: actor.token } : {}),
});

/** Whether an actor sees every upload, and may change any of those that wait. */
export const seesAll = (actor: Actor) =>
  actor.via === 'key' ||
  (actor.via === 'token' ? actor.scope === 'publish' : rankOf(actor.role) >= rankOf('reviewer'));

/** Whether an actor is held to the limits of open uploading: anyone without a role. */
export const limited = (actor: Actor) => actor.via !== 'key' && rankOf(actor.role) === 0;

const KEY_LEAST = 32;

const encoder = new TextEncoder();

async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** Whether two texts are the same, taking as long whatever they are. */
async function same(a: string, b: string) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let differ = 0;
  for (let i = 0; i < x.length; i += 1) differ |= x[i]! ^ y[i]!;
  return differ === 0;
}

/** The program a key is of, by the host's list of keys (`LIBRARY_KEYS`). */
async function programOf(key: string, ctx: Context): Promise<string | undefined> {
  let found: string | undefined;
  for (const entry of (ctx.auth.keys ?? '').split(',')) {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at).trim();
    const known = entry.slice(at + 1).trim();
    if (at <= 0 || known.length < KEY_LEAST) continue;
    // Every key is compared, so the time taken says nothing of which one matched.
    if ((await same(key, known)) && !found) found = name;
  }
  return found;
}

const REFUSED: Record<string, string> = {
  'bad-key': 'The key is not one of the library’s, or no longer holds.',
  'signed-out': 'Sign in on the library’s page, or send a token.',
  'another-site': 'This is changed from the library’s own page, or by a token.',
  blocked: 'This account may not upload to the library.',
  'not-a-reviewer': 'Only the library’s reviewers do this.',
  'not-an-admin': 'Only the library’s admins do this.',
  'not-the-owner': 'Only the library’s owner does this.',
  'token-scope': 'A token does not do this: a person does it on the library’s page.',
};

const refuse = (status: number, error: string) => problem(status, error, REFUSED[error]!);

const NOT_ENOUGH: Record<Role, string> = {
  reviewer: 'not-a-reviewer',
  admin: 'not-an-admin',
  owner: 'not-the-owner',
};

/** The programs that used a key of the host's, said once each. */
const warned = new Set<string>();

/** The actor of a request that sends `Authorization`: a person's token, or a program's key. */
async function byKey(header: string, ctx: Context, permission: Permission) {
  const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (key && isToken(key)) {
    const token = ctx.state ? await tokenOf(ctx.state, key) : undefined;
    if (!token || !ctx.state) return refuse(401, 'bad-key');
    await settlePeople(ctx);
    const person = await readPerson(ctx.state, token.owner);
    // A token of someone blocked is no different from one that is not there.
    if (person?.blocked) return refuse(401, 'bad-key');
    const role = person?.role;
    const may =
      MAY[token.scope].has(permission) &&
      // A token that publishes is an admin's, while they are one.
      (token.scope === 'upload' || MAY.upload.has(permission) || rankOf(role) >= rankOf('admin'));
    if (!may) return refuse(403, 'token-scope');
    const actor: Actor = {
      id: token.owner,
      ...(person?.name ? { name: person.name } : {}),
      token: token.name,
      ...(role ? { role } : {}),
      via: 'token',
      scope: token.scope,
    };
    return actor;
  }
  const program = key ? await programOf(key, ctx) : undefined;
  if (!program) return refuse(401, 'bad-key');
  if (!warned.has(program)) {
    warned.add(program);
    console.warn(`The program ${program} uses a key of LIBRARY_KEYS: give it a person's token.`);
  }
  if (!MAY.program.has(permission)) return refuse(403, 'token-scope');
  const actor: Actor = { id: `key:${program}`, name: program, via: 'key' };
  return actor;
}

/** The actor of a request from the library's page, by its session. */
async function bySession(request: Request, ctx: Context, permission: Permission) {
  if (!fromThisSite(request)) return refuse(403, 'another-site');
  const user = await signedIn(request, ctx);
  if (!user) return refuse(401, 'signed-out');
  await settlePeople(ctx);
  const person = ctx.state ? await readPerson(ctx.state, user.email) : undefined;
  if (person?.blocked && permission !== 'read-own') return refuse(403, 'blocked');
  const role = person?.blocked ? undefined : person?.role;
  const least = LEAST[permission];
  if (least && rankOf(role) < rankOf(least)) return refuse(403, NOT_ENOUGH[least]);
  const actor: Actor = {
    id: user.email,
    name: user.name,
    ...(role ? { role } : {}),
    via: 'session',
  };
  return actor;
}

export async function authorize(
  request: Request,
  ctx: Context,
  permission: Permission,
): Promise<Actor | Response> {
  const header = request.headers.get('Authorization');
  const actor =
    header === null
      ? await bySession(request, ctx, permission)
      : await byKey(header, ctx, permission);
  if (actor instanceof Response) return actor;
  if (permission === 'upload' && limited(actor)) {
    const wait = tooFast(actor.id, (await limitsOf(ctx)).writesPerMinute);
    if (wait !== undefined) {
      const answer = problem(
        429,
        'too-fast',
        `Too many changes in a minute: try again in ${wait} seconds.`,
      );
      answer.headers.set('Retry-After', String(wait));
      return answer;
    }
  }
  return actor;
}
