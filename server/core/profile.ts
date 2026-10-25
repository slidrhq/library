/**
 * A person's tokens (docs/SPEC.md §7, §10): made and revoked from their profile, by their own
 * session (a token makes no tokens); and anyone's, for an admin.
 *
 *   GET    /api/me/tokens                     one's tokens, newest first
 *   POST   /api/me/tokens                     { "name", "scope"?, "days"? }: a new one, answered once
 *   DELETE /api/me/tokens/{id}                revokes one
 *   GET    /api/people/{email}/tokens         a person's tokens (admins)
 *   DELETE /api/people/{email}/tokens/{id}    revokes one of them (admins)
 */
import { audit } from './audit.ts';
import type { Context } from './context.ts';
import { isRecord, json, jsonBody, problem } from './http.ts';
import { limitsOf } from './limits.ts';
import { addressOf } from './members.ts';
import { rankOf } from './people.ts';
import {
  DEFAULT_DAYS,
  SCOPES,
  TOKEN_DAYS,
  listTokens,
  makeToken,
  revokeToken,
  type Scope,
} from './tokens.ts';
import { authorize } from './uploads/access.ts';

type Route = (request: Request, ctx: Context, params: string[]) => Promise<Response>;

const notSetUp = () =>
  problem(503, 'not-set-up', 'This server keeps no tokens: it has no store for them.');

const NAME_MOST = 60;

const mine: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'tokens');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  return json({ tokens: await listTokens(ctx.state, actor.id) });
};

const make: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'tokens');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const wanted = isRecord(body) ? body : {};
  const name = typeof wanted.name === 'string' ? wanted.name.trim() : '';
  if (!name || name.length > NAME_MOST) {
    return problem(400, 'bad-request', `A token is named, in 1 to ${NAME_MOST} characters.`);
  }
  const scope = wanted.scope ?? 'upload';
  if (!(SCOPES as readonly unknown[]).includes(scope)) {
    return problem(400, 'bad-request', `A token's scope is one of ${SCOPES.join(', ')}.`);
  }
  if (scope === 'publish' && rankOf(actor.role) < rankOf('admin')) {
    return problem(403, 'not-an-admin', 'Only the library’s admins make tokens that publish.');
  }
  const days = wanted.days === undefined ? DEFAULT_DAYS : wanted.days;
  if (days !== null && !(TOKEN_DAYS as readonly unknown[]).includes(days)) {
    return problem(
      400,
      'bad-request',
      `A token holds for ${TOKEN_DAYS.join(', ')} days, or, given null, until it is revoked.`,
    );
  }
  const held = await listTokens(ctx.state, actor.id);
  const most = (await limitsOf(ctx)).tokens;
  if (held.length >= most) {
    return problem(409, 'limit', `You have ${held.length} tokens, the most one person keeps.`);
  }
  const { token, record } = await makeToken(ctx.state, actor.id, {
    name,
    scope: scope as Scope,
    days: days as number | null,
  });
  await audit(ctx.state, {
    by: actor.id,
    action: 'token.made',
    target: record.id,
    detail: { name, scope },
  });
  return json({ token, ...record }, 201);
};

/** Revokes a token of a person's, and records it; 404 for one they do not have. */
async function revoke(ctx: Context, by: string, owner: string, id: string | undefined) {
  if (!ctx.state) return notSetUp();
  if (!id || !(await revokeToken(ctx.state, owner, id))) {
    return problem(404, 'not-found', `There is no token ${id}.`);
  }
  await audit(ctx.state, { by, action: 'token.revoked', target: id, detail: { owner } });
  return new Response(null, { status: 204 });
}

const revokeMine: Route = async (request, ctx, [id]) => {
  const actor = await authorize(request, ctx, 'tokens');
  if (actor instanceof Response) return actor;
  return revoke(ctx, actor.id, actor.id, id);
};

const theirs: Route = async (request, ctx, [param]) => {
  const actor = await authorize(request, ctx, 'members');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const email = addressOf(param);
  if (email instanceof Response) return email;
  return json({ tokens: await listTokens(ctx.state, email) });
};

const revokeTheirs: Route = async (request, ctx, [param, id]) => {
  const actor = await authorize(request, ctx, 'members');
  if (actor instanceof Response) return actor;
  const email = addressOf(param);
  if (email instanceof Response) return email;
  return revoke(ctx, actor.id, email, id);
};

const ID = '([A-Za-z0-9_-]{12})';
const ROUTES: [RegExp, Partial<Record<string, Route>>][] = [
  [/^\/api\/me\/tokens$/, { GET: mine, POST: make }],
  [new RegExp(`^/api/me/tokens/${ID}$`), { DELETE: revokeMine }],
  [/^\/api\/people\/([^/]+)\/tokens$/, { GET: theirs }],
  [new RegExp(`^/api/people/([^/]+)/tokens/${ID}$`), { DELETE: revokeTheirs }],
];

/** The answer to a request of the tokens; undefined for a path that is none of theirs. */
export function profileApi(request: Request, ctx: Context): Promise<Response> | undefined {
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
