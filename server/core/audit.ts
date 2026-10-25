/**
 * What was done to the library's people, settings and keys, and by whom (docs/SPEC.md §12): each
 * an entry of its own in the state store, `audit/<when>-<random>.json`, never changed after. An
 * entry names a key that was set, never the key itself.
 */
import type { Bucket } from './bucket.ts';

export interface AuditEntry {
  at: string;
  /** An address, `install`, or the host's own (`cli`); `key:<name>` in entries of before. */
  by: string;
  /** What was done: `member.role`, `member.removed`, `person.blocked`, `owner.handed`… */
  action: string;
  /** Whom or what it was done to. */
  target?: string;
  detail?: Record<string, unknown>;
}

/** The moment of the last entry, and how many were written in it: entries of one moment keep their order. */
let last = { at: '', count: 0 };

export async function audit(store: Bucket | undefined, entry: Omit<AuditEntry, 'at'>) {
  if (!store) return;
  const at = new Date().toISOString();
  last = at === last.at ? { at, count: last.count + 1 } : { at, count: 0 };
  const random = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const key = `audit/${at}-${String(last.count).padStart(4, '0')}-${random}.json`;
  await store.put(key, JSON.stringify({ at, ...entry }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** The latest entries, newest first. */
export async function readAudit(store: Bucket, limit = 100): Promise<AuditEntry[]> {
  const keys: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await store.list({ prefix: 'audit/', startAfter });
    keys.push(...page.objects.map((one) => one.key));
    if (!page.truncated || page.objects.length === 0) break;
    startAfter = page.objects.at(-1)!.key;
  }
  const entries: AuditEntry[] = [];
  for (const key of keys.reverse().slice(0, limit)) {
    const object = await store.get(key);
    if (object) entries.push(JSON.parse(await object.text()) as AuditEntry);
  }
  return entries;
}
