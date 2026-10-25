/**
 * A person's tokens, from their profile (server/core/profile.ts; docs/SPEC.md §7): what a program
 * sends to upload as them, shown once when it is made.
 */
import { call } from './uploadsApi';

export type Scope = 'upload' | 'publish';

export interface Token {
  id: string;
  name: string;
  scope: Scope;
  /** Its first characters, after `slk_`. */
  hint: string;
  created: string;
  expires?: string;
  lastUsed?: string;
}

/** How long a token holds: 30, 90 or 365 days, or until it is revoked. */
export type Days = 30 | 90 | 365 | null;

export const tokensApi = {
  list: () => call<{ tokens: Token[] }>('me/tokens'),
  make: (name: string, scope: Scope, days: Days) =>
    call<Token & { token: string }>('me/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope, days }),
    }),
  revoke: (id: string) => call<undefined>(`me/tokens/${id}`, { method: 'DELETE' }),
};
