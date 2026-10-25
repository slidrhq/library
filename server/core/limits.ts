/**
 * What one person may keep waiting, and how fast they may write (docs/SPEC.md §6.4). Anyone who
 * signs in may upload, so each is held to limits, which an admin may change (`limits` of the
 * library's settings). The members, who review, and the programs of the host's keys, are not.
 */
import { readConfig } from './config.ts';
import type { Context } from './context.ts';
import { listUploads } from './uploads/store.ts';

export interface Limits {
  /** Uploads waiting (pending) at once. */
  pending: number;
  /** Bytes in the files of the uploads waiting. */
  bytes: number;
  /** Tokens a person keeps. */
  tokens: number;
  /** Writes to the uploads in a minute. */
  writesPerMinute: number;
}

export const LIMITS: Limits = {
  pending: 20,
  bytes: 200 * 1024 * 1024,
  tokens: 10,
  writesPerMinute: 60,
};

/** The limits of the library: its settings', where they name any, else the defaults. */
export async function limitsOf(ctx: Context): Promise<Limits> {
  const set = ctx.state ? (await readConfig(ctx.state))?.limits : undefined;
  return { ...LIMITS, ...set };
}

const MINUTE = 60_000;
const writes = new Map<string, number[]>();

/**
 * Counts a write of a person's; when they wrote as many as they may in the last minute, how many
 * seconds until they may again. The count is the server's, in its memory: on Cloudflare, each
 * place the Worker runs counts apart.
 */
export function tooFast(who: string, perMinute: number, now = Date.now()): number | undefined {
  const recent = (writes.get(who) ?? []).filter((at) => now - at < MINUTE);
  if (recent.length >= perMinute) {
    writes.set(who, recent);
    return Math.max(1, Math.ceil((recent[0]! + MINUTE - now) / 1000));
  }
  recent.push(now);
  writes.set(who, recent);
  return undefined;
}

/** Forgets every write counted: the tests start afresh. */
export function forgetWrites() {
  writes.clear();
}

/** How many uploads a person has waiting, and the bytes of their files. */
export async function waitingOf(
  ctx: Context,
  by: string,
): Promise<{ count: number; bytes: number }> {
  if (!ctx.state) return { count: 0, bytes: 0 };
  const { uploads } = await listUploads(ctx.state, { status: 'pending', by }, 1000);
  return {
    count: uploads.length,
    bytes: uploads.reduce((sum, upload) => sum + (upload.bytes ?? 0), 0),
  };
}
