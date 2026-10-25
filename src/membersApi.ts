/**
 * The library's people, as its admins name them (server/core/members.ts; docs/SPEC.md §6):
 * members by email and role, the blocked, and whoever has signed in.
 */
import { call, type Role } from './uploadsApi';

export interface Member {
  email: string;
  name?: string;
  role: Role | null;
  blocked: boolean;
  added: string;
  by: string;
  lastSeen?: string;
}

const at = (email: string) => encodeURIComponent(email);

const send = <T>(path: string, method: string, body: unknown) =>
  call<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const membersApi = {
  list: () => call<{ people: Member[] }>('members'),
  name: (email: string, role: 'reviewer' | 'admin') =>
    send<Member>(`members/${at(email)}`, 'PUT', { role }),
  remove: (email: string) => call<undefined>(`members/${at(email)}`, { method: 'DELETE' }),
  block: (email: string, blocked: boolean) =>
    send<Member>(`people/${at(email)}`, 'PUT', { blocked }),
  handOver: (email: string) => send<{ owner: string }>('owner', 'POST', { email }),
};
