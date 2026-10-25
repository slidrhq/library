/**
 * A person's tokens (docs/SPEC.md §7): what a program sends in place of a session, made by the
 * person in their profile, and all it needs (`Authorization: Bearer slk_…`). A token acts as its
 * owner, within its scope: `upload` (anyone's), or `publish` (an admin's), which also publishes
 * what waits, an author's files, and the library brought in.
 *
 *   tokens/<sha256 of the token>.json      the token: its owner, name, scope, dates
 *   people/<email>/tokens/<id>             the tokens of a person, by id → the hash
 *
 * Only the hash is kept: the token itself is shown once, when it is made. A token that is
 * unknown, revoked, expired, or whose owner is blocked, opens nothing, and the answer does not
 * say which of these it was.
 */
import type { Bucket } from './bucket.ts';
import { emailOf } from './people.ts';

export const SCOPES = ['upload', 'publish'] as const;
export type Scope = (typeof SCOPES)[number];

/** Every token starts so: a secret scanner finds a leaked one. */
export const TOKEN_PREFIX = 'slk_';
/** How long a token may hold, in days; none holds until it is revoked. */
export const TOKEN_DAYS = [30, 90, 365] as const;
export const DEFAULT_DAYS = 90;
/** How often the last use of a token is written, at most. */
const USE_EVERY_MS = 60 * 60 * 1000;

export interface Token {
  id: string;
  owner: string;
  name: string;
  scope: Scope;
  /** Its first characters after the prefix, to tell it apart in a list. */
  hint: string;
  created: string;
  expires?: string;
  lastUsed?: string;
}

const encoder = new TextEncoder();

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TOKEN = /^slk_[A-Za-z0-9_-]{43}$/;

/** Whether a text is shaped as a token of the library. */
export const isToken = (text: string) => TOKEN.test(text);

const recordKey = (hash: string) => `tokens/${hash}.json`;
const indexKey = (owner: string, id = '') => `people/${emailOf(owner)}/tokens/${id}`;

/** Makes a token; answers it, once, with what the library keeps of it. */
export async function makeToken(
  store: Bucket,
  owner: string,
  wanted: { name: string; scope: Scope; days: number | null },
): Promise<{ token: string; record: Token }> {
  const token = `${TOKEN_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const hash = await sha256Hex(token);
  const created = new Date();
  const record: Token = {
    id: base64url(crypto.getRandomValues(new Uint8Array(9))),
    owner: emailOf(owner),
    name: wanted.name,
    scope: wanted.scope,
    hint: token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6),
    created: created.toISOString(),
    ...(wanted.days
      ? { expires: new Date(created.getTime() + wanted.days * 86_400_000).toISOString() }
      : {}),
  };
  await store.put(recordKey(hash), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
  });
  await store.put(indexKey(record.owner, record.id), hash);
  return { token, record };
}

/** The hashes of a person's tokens, by id. */
async function hashesOf(store: Bucket, owner: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const prefix = indexKey(owner);
  let startAfter: string | undefined;
  for (;;) {
    const page = await store.list({ prefix, startAfter });
    for (const { key } of page.objects) {
      const object = await store.get(key);
      if (object) found.set(key.slice(prefix.length), await object.text());
    }
    if (!page.truncated || page.objects.length === 0) return found;
    startAfter = page.objects.at(-1)!.key;
  }
}

async function recordOf(store: Bucket, hash: string): Promise<Token | undefined> {
  const object = await store.get(recordKey(hash));
  return object ? (JSON.parse(await object.text()) as Token) : undefined;
}

/** A person's tokens, newest first. */
export async function listTokens(store: Bucket, owner: string): Promise<Token[]> {
  const tokens: Token[] = [];
  for (const hash of (await hashesOf(store, owner)).values()) {
    const record = await recordOf(store, hash);
    if (record) tokens.push(record);
  }
  return tokens.sort((a, b) => (a.created < b.created ? 1 : -1));
}

/** Revokes one of a person's tokens; whether it was theirs to revoke. */
export async function revokeToken(store: Bucket, owner: string, id: string): Promise<boolean> {
  const hash = (await hashesOf(store, owner)).get(id);
  if (!hash) return false;
  await store.delete([recordKey(hash), indexKey(owner, id)]);
  return true;
}

/** Revokes a person's tokens of a scope: an admin's publish tokens, once they are not one. */
export async function revokeScope(store: Bucket, owner: string, scope: Scope): Promise<number> {
  let revoked = 0;
  for (const [id, hash] of await hashesOf(store, owner)) {
    if ((await recordOf(store, hash))?.scope !== scope) continue;
    await store.delete([recordKey(hash), indexKey(owner, id)]);
    revoked += 1;
  }
  return revoked;
}

/** Revokes every token of a person: a person blocked. Answers how many there were. */
export async function revokeAll(store: Bucket, owner: string): Promise<number> {
  const hashes = await hashesOf(store, owner);
  for (const [id, hash] of hashes) await store.delete([recordKey(hash), indexKey(owner, id)]);
  return hashes.size;
}

/**
 * The token a request sends, when it is one the library made and has not expired; its last use
 * is written, at most once an hour.
 */
export async function tokenOf(store: Bucket, text: string): Promise<Token | undefined> {
  if (!isToken(text)) return undefined;
  const hash = await sha256Hex(text);
  const record = await recordOf(store, hash);
  if (!record) return undefined;
  const now = Date.now();
  if (record.expires && Date.parse(record.expires) <= now) return undefined;
  if (!record.lastUsed || now - Date.parse(record.lastUsed) > USE_EVERY_MS) {
    const used = { ...record, lastUsed: new Date(now).toISOString() };
    await store.put(recordKey(hash), JSON.stringify(used), {
      httpMetadata: { contentType: 'application/json' },
    });
    return used;
  }
  return record;
}
