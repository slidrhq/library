/**
 * The people of the library (docs/SPEC.md §6): its owner, who installed it, and the members an
 * admin names by email. Each is `people/<email>.json` in the state store, by the address in small
 * letters.
 */
import type { Bucket } from './bucket.ts';

/** What a member may do beyond uploading: review, and besides that administer; the owner is one. */
export const ROLES = ['owner', 'admin', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export interface Person {
  email: string;
  role?: Role;
  /** When they were named, and by whom: an address, or `install`. */
  added: string;
  by: string;
}

/** An address as the library keeps it. */
export const emailOf = (text: string) => text.trim().toLowerCase();

/** Whether a text is an address: something, `@`, a domain with a dot in it. */
export const isEmail = (text: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text.trim());

const keyOf = (email: string) => `people/${emailOf(email)}.json`;

export async function readPerson(store: Bucket, email: string): Promise<Person | undefined> {
  const object = await store.get(keyOf(email));
  return object ? (JSON.parse(await object.text()) as Person) : undefined;
}

export async function writePerson(store: Bucket, person: Person): Promise<void> {
  await store.put(
    keyOf(person.email),
    JSON.stringify({ ...person, email: emailOf(person.email) }),
    {
      httpMetadata: { contentType: 'application/json' },
    },
  );
}
