/**
 * The library's keys, sealed (docs/SPEC.md §4.4): the media store's key, the OIDC client's
 * secret, the key the cookies are signed with. Each is kept in the state store as
 * `vault/<name>.json`, sealed with AES-256-GCM under a master key that the host keeps elsewhere
 * (the OS keychain on a machine, a secret of the Worker on Cloudflare) and never in the store. So a
 * copy of the store, a backup, or a bucket that leaks, opens no key.
 *
 * Only the server reads a key back: no route answers one, and nothing logs one. What may be shown
 * of a key is `about` it: when it was set, and by whom.
 */
import type { Bucket } from './bucket.ts';

/** A master key: 32 bytes, named by its fingerprint (`masterKey`). */
export interface MasterKey {
  /** The first bytes of its SHA-256, in hex: which master key sealed a key. */
  id: string;
  bytes: Uint8Array;
}

/** A key as the store keeps it. */
export interface Sealed {
  v: 1;
  /** The master key it is sealed under. */
  kid: string;
  /** The nonce of the seal, 12 bytes, base64url. */
  iv: string;
  /** The key, sealed, with the seal's tag at its end, base64url. */
  data: string;
  /** When it was set, and by whom. */
  set: string;
  by?: string;
}

/** A key that is there, but cannot be opened: sealed under another master key, or changed. */
export class VaultError extends Error {}

const MASTER_BYTES = 32;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

const keyOf = (name: string) => {
  if (!NAME.test(name)) throw new Error(`Not a name of the vault: ${name}`);
  return `vault/${name}.json`;
};

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A master key, from its bytes; throws for any but 32. */
export async function masterKey(bytes: Uint8Array): Promise<MasterKey> {
  if (bytes.length !== MASTER_BYTES) {
    throw new Error(`A master key is ${MASTER_BYTES} bytes; this one is ${bytes.length}.`);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return { id: toHex(new Uint8Array(digest).subarray(0, 4)), bytes };
}

/** A new master key, of random bytes. */
export const newMasterKey = () => masterKey(crypto.getRandomValues(new Uint8Array(MASTER_BYTES)));

/** A master key as text, as `LIBRARY_MASTER_KEY` and a key file hold it, and back. */
export const masterKeyText = (key: MasterKey) => base64url(key.bytes);
export const masterKeyFromText = (text: string) => masterKey(fromBase64url(text.trim()));

/** Random bytes, as text: a key the library makes for itself, such as the session's. */
export const randomKey = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

const encoder = new TextEncoder();

/** What a seal covers besides the key: its name, so a key moved to another name does not open. */
const sealedAs = (name: string) => encoder.encode(`slidr-library:vault:${name}`);

const aesKey = (master: MasterKey, use: KeyUsage) =>
  crypto.subtle.importKey('raw', master.bytes as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [use]);

export class Vault {
  private readonly store: Bucket;
  private readonly keys: readonly MasterKey[];

  /**
   * `keys`: the master keys a key may be sealed under. The first seals; every one opens the keys
   * it sealed, so a rotation stopped half way loses nothing.
   */
  constructor(store: Bucket, keys: readonly MasterKey[]) {
    if (keys.length === 0) throw new Error('A vault needs its master key.');
    this.store = store;
    this.keys = keys;
  }

  /** The master key new keys are sealed under. */
  get current(): MasterKey {
    return this.keys[0]!;
  }

  private async sealed(name: string): Promise<Sealed | undefined> {
    const object = await this.store.get(keyOf(name));
    return object ? (JSON.parse(await object.text()) as Sealed) : undefined;
  }

  /** Seals a key under the current master key, in place of the one of that name. */
  async set(name: string, value: string, by?: string): Promise<void> {
    await this.write(name, value, { set: new Date().toISOString(), by }, this.current);
  }

  private async write(
    name: string,
    value: string,
    about: { set: string; by?: string | undefined },
    master: MasterKey,
  ) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: sealedAs(name) },
      await aesKey(master, 'encrypt'),
      encoder.encode(value),
    );
    const sealed: Sealed = {
      v: 1,
      kid: master.id,
      iv: base64url(iv),
      data: base64url(new Uint8Array(data)),
      set: about.set,
      ...(about.by ? { by: about.by } : {}),
    };
    await this.store.put(keyOf(name), JSON.stringify(sealed), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  /** A key, opened; none when it was never set. Throws `VaultError` when it cannot be opened. */
  async get(name: string): Promise<string | undefined> {
    const sealed = await this.sealed(name);
    if (!sealed) return undefined;
    const master = this.keys.find((key) => key.id === sealed.kid);
    if (!master) {
      throw new VaultError(
        `The key ${name} is sealed under the master key ${sealed.kid}, which this server does not have.`,
      );
    }
    try {
      const value = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64url(sealed.iv), additionalData: sealedAs(name) },
        await aesKey(master, 'decrypt'),
        fromBase64url(sealed.data),
      );
      return new TextDecoder().decode(value);
    } catch {
      throw new VaultError(`The key ${name} cannot be opened: it was changed, or moved.`);
    }
  }

  /** What may be shown of a key: when it was set, and by whom; none when it was never set. */
  async about(name: string): Promise<{ set: string; by?: string } | undefined> {
    const sealed = await this.sealed(name);
    return sealed && { set: sealed.set, ...(sealed.by ? { by: sealed.by } : {}) };
  }

  async remove(name: string): Promise<void> {
    await this.store.delete(keyOf(name));
  }

  /** The names of the keys that are set. */
  async names(): Promise<string[]> {
    const names: string[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.store.list({ prefix: 'vault/', startAfter });
      for (const { key } of page.objects) names.push(key.slice('vault/'.length, -'.json'.length));
      if (!page.truncated || page.objects.length === 0) return names;
      startAfter = page.objects.at(-1)!.key;
    }
  }

  /**
   * Seals every key again under `next`, keeping when each was set and by whom. Every key is
   * opened first, so none is written unless all of them open.
   */
  async rotate(next: MasterKey): Promise<string[]> {
    const opened: [string, string, Sealed][] = [];
    for (const name of await this.names()) {
      const value = await this.get(name);
      const sealed = await this.sealed(name);
      if (value !== undefined && sealed) opened.push([name, value, sealed]);
    }
    for (const [name, value, sealed] of opened) {
      await this.write(name, value, { set: sealed.set, by: sealed.by }, next);
    }
    return opened.map(([name]) => name);
  }
}
