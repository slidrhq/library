/**
 * Who may do what with the uploads. Every route of the API asks here first, naming what it is
 * about to do, and goes on as the actor it answers, or gives its answer instead (401, 403).
 *
 * The permissions are being built apart: signing in with Google, and the accounts the library
 * names as its editors. Until they come, everyone may do everything, as `anyone`. They come in
 * here, and nowhere else: `authorize` then answers a signed-in person, or a program by its key,
 * as the permission asks.
 */

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
  /** An account's address; `anyone` while there are no permissions. */
  id: string;
  name?: string;
}

const ANYONE: Actor = { id: 'anyone' };

export function authorize(
  _request: Request,
  _env: unknown,
  _permission: Permission,
): Promise<Actor | Response> {
  return Promise.resolve(ANYONE);
}
