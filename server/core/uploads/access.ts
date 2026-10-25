/**
 * Who may do what (docs/SPEC.md §6.1). Every route that is not open to anyone asks here first,
 * naming what it is about to do, and goes on as the actor it answers, or gives its answer instead
 * (401, 403).
 *
 * - **A person**, signed in on the library's own page (`../auth.ts`): anyone may upload, and see and
 *   change their own uploads while they wait; a reviewer sees every upload, reviews them and
 *   publishes what waits; an admin also names the members, and publishes an author's files. A
 *   request that changes something must come from the library's own page (its `Origin`).
 * - **A program**, by a key of its own (`LIBRARY_KEYS`, until a person's tokens replace it): it
 *   sends no cookie, and so is not asked which site it comes from. It uploads and publishes, as
 *   the studio and the app's scripts do, and neither reviews nor administers (D8).
 *
 * What the API describes (`/api/content`, `/api/openapi.json`, `/api/schemas/`) is open to anyone.
 */
import { fromThisSite, signedIn } from '../auth.ts';
import type { Context } from '../context.ts';
import { problem } from '../http.ts';
import { rankOf, readPerson, settlePeople, type Role } from '../people.ts';

/** What a request is about to do. */
export type Permission =
  /** List one's own uploads, and read one. */
  | 'read-own'
  /** Upload, change one's own upload while it waits (its languages), and withdraw it. */
  | 'upload'
  /** List every upload, and read any. */
  | 'read-all'
  /** Accept an upload, reject it, or send it back to wait. */
  | 'review'
  /** Publish the uploads that were accepted and wait (`POST /api/publish`). */
  | 'publish-waiting'
  /** Publish an author's files, and bring the library into its store. */
  | 'publish-files'
  /** Name the members, block people. */
  | 'members'
  /** Change the library's settings and keys. */
  | 'settings'
  /** Hand the library over to another owner. */
  | 'owner';

/** The least role each permission takes. */
const LEAST: Record<Permission, Role | undefined> = {
  'read-own': undefined,
  upload: undefined,
  'read-all': 'reviewer',
  review: 'reviewer',
  'publish-waiting': 'reviewer',
  'publish-files': 'admin',
  members: 'admin',
  settings: 'admin',
  owner: 'owner',
};

/** What a program's key may do. */
const PROGRAM: ReadonlySet<Permission> = new Set([
  'read-own',
  'upload',
  'read-all',
  'publish-waiting',
  'publish-files',
]);

/** Who did something, as an upload records it. */
export interface Recorded {
  /** A person's address, or `key:<name>` for a program. */
  id: string;
  name?: string;
}

/** Who a request comes from. */
export interface Actor extends Recorded {
  /** A person's role, when they have one. */
  role?: Role;
  /** How the request came: a person's session, or a program's key. */
  via: 'session' | 'key';
}

/** An actor as an upload records them: who, and nothing of what they could do then. */
export const recordOf = (actor: Recorded): Recorded => ({
  id: actor.id,
  ...(actor.name ? { name: actor.name } : {}),
});

/** Whether an actor sees every upload, and may change any of those that wait. */
export const seesAll = (actor: Actor) => actor.via === 'key' || rankOf(actor.role) >= 1;

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
  'signed-out': 'Sign in on the library’s page, or send a key.',
  'another-site': 'This is changed from the library’s own page, or by a key.',
  blocked: 'This account may not upload to the library.',
  'not-a-reviewer': 'Only the library’s reviewers do this.',
  'not-an-admin': 'Only the library’s admins do this.',
  'not-the-owner': 'Only the library’s owner does this.',
  'token-scope': 'A key does not do this: a person does it on the library’s page.',
};

const refuse = (status: number, error: string) => problem(status, error, REFUSED[error]!);

const NOT_ENOUGH: Record<Role, string> = {
  reviewer: 'not-a-reviewer',
  admin: 'not-an-admin',
  owner: 'not-the-owner',
};

export async function authorize(
  request: Request,
  ctx: Context,
  permission: Permission,
): Promise<Actor | Response> {
  const header = request.headers.get('Authorization');
  if (header !== null) {
    const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const program = key ? await programOf(key, ctx) : undefined;
    if (!program) return problem(401, 'bad-key', 'The key is not one of the library’s.');
    if (!PROGRAM.has(permission)) return refuse(403, 'token-scope');
    return { id: `key:${program}`, name: program, via: 'key' };
  }
  if (!fromThisSite(request)) return refuse(403, 'another-site');
  const user = await signedIn(request, ctx);
  if (!user) return refuse(401, 'signed-out');
  await settlePeople(ctx);
  const person = ctx.state ? await readPerson(ctx.state, user.email) : undefined;
  if (person?.blocked && permission !== 'read-own') return refuse(403, 'blocked');
  const role = person?.blocked ? undefined : person?.role;
  const least = LEAST[permission];
  if (least && rankOf(role) < rankOf(least)) return refuse(403, NOT_ENOUGH[least]);
  return { id: user.email, name: user.name, ...(role ? { role } : {}), via: 'session' };
}
