/**
 * Who may do what with the uploads. Every route of the uploads asks here first, naming what it
 * is about to do, and goes on as the actor it answers, or gives its answer instead (401, 403).
 *
 * The uploads are the editors' (README, "Signing in"): a person signed in with a Google account
 * that `LIBRARY_EDITORS` names, on the library's own page (`requireEditor` of `../auth.ts`), or
 * a program by a key of its own (`LIBRARY_KEYS`), which sends no cookie and so needs no check of
 * the site it comes from. An editor may do everything an upload takes; what the API describes
 * (`/api/content`, `/api/openapi.json`, `/api/schemas/`) is open to anyone.
 */
import { requireEditor, type AuthEnv } from '../auth.ts';
import { problem } from '../http.ts';

/** What a request is about to do. */
export type Permission =
  /** List the uploads and read one. */
  | 'read'
  /** Upload, change an upload while it waits (its languages), and withdraw it. */
  | 'upload'
  /** Accept an upload, reject it, or send it back to wait. */
  | 'review'
  /** Say that an accepted upload is in the published library. */
  | 'publish';

/** Who did something, as an upload records it. */
export interface Actor {
  /** An editor's address, or `key:<name>` for a program. */
  id: string;
  name?: string;
}

export interface AccessEnv extends AuthEnv {
  /**
   * The programs that may upload, each with its key: `<name>=<key>`, separated by commas, as
   * `studio=…, ci=…`. A key is at least 32 characters; a program sends it as
   * `Authorization: Bearer <key>`.
   */
  LIBRARY_KEYS?: string;
}

const KEY_LEAST = 32;

/** What the sign-in's answers mean, in words. */
const REFUSED: Record<string, string> = {
  'signed-out': 'Sign in with a Google account the library names as an editor, or send a key.',
  'not-an-editor': 'This account is not one of the library’s editors.',
  'another-site': 'The uploads are changed from the library’s own page, or by a key.',
};

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

/** The program a key is of, by `LIBRARY_KEYS`. */
async function programOf(key: string, env: AccessEnv): Promise<string | undefined> {
  let found: string | undefined;
  for (const entry of (env.LIBRARY_KEYS ?? '').split(',')) {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at).trim();
    const known = entry.slice(at + 1).trim();
    if (at <= 0 || known.length < KEY_LEAST) continue;
    // Every key is compared, so the time taken says nothing of which one matched.
    if ((await same(key, known)) && !found) found = name;
  }
  return found;
}

export async function authorize(
  request: Request,
  env: AccessEnv,
  _permission: Permission,
): Promise<Actor | Response> {
  const header = request.headers.get('Authorization');
  if (header !== null) {
    const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const program = key ? await programOf(key, env) : undefined;
    if (!program) return problem(401, 'bad-key', 'The key is not one of the library’s.');
    return { id: `key:${program}`, name: program };
  }
  const user = await requireEditor(request, env);
  if (!(user instanceof Response)) return { id: user.email, name: user.name };
  const { error = 'refused' } = (await user.json()) as { error?: string };
  return problem(user.status, error, REFUSED[error] ?? 'Not allowed.');
}
