import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryBucket } from './uploads/testing.ts';
import {
  Vault,
  VaultError,
  masterKey,
  masterKeyFromText,
  masterKeyText,
  newMasterKey,
  type Sealed,
} from './vault.ts';

const SECRET = 'ssh-ed25519 a private key of the media store';

/** A sealed key as the store holds it, to change by hand. */
async function sealedOf(store: MemoryBucket, name: string): Promise<Sealed> {
  return JSON.parse(await (await store.get(`vault/${name}.json`))!.text()) as Sealed;
}

async function writeSealed(store: MemoryBucket, name: string, sealed: Sealed) {
  await store.put(`vault/${name}.json`, JSON.stringify(sealed));
}

/** A base64url text with one bit of its first byte changed. */
function flipped(text: string) {
  const bytes = Buffer.from(text, 'base64url');
  bytes[0]! ^= 1;
  return bytes.toString('base64url');
}

describe('the vault', () => {
  test('seals a key, and opens it again', async () => {
    const store = new MemoryBucket();
    const vault = new Vault(store, [await newMasterKey()]);
    assert.equal(await vault.get('media'), undefined);
    await vault.set('media', SECRET, 'owner@example.org');
    assert.equal(await vault.get('media'), SECRET);
    const about = await vault.about('media');
    assert.equal(about?.by, 'owner@example.org');
    assert.ok(about?.set);
    assert.deepEqual(await vault.names(), ['media']);
  });

  test('keeps nothing of a key in clear', async () => {
    const store = new MemoryBucket();
    const vault = new Vault(store, [await newMasterKey()]);
    await vault.set('media', SECRET);
    const kept = new TextDecoder().decode(store.objects.get('vault/media.json')!.data);
    assert.ok(!kept.includes('ssh-ed25519'));
    assert.ok(!kept.includes(Buffer.from(SECRET).toString('base64url').slice(0, 12)));
    // A fresh nonce each time: the same key sealed twice is two different seals.
    const first = (await sealedOf(store, 'media')).data;
    await vault.set('media', SECRET);
    assert.notEqual((await sealedOf(store, 'media')).data, first);
  });

  test('refuses a seal that was changed', async () => {
    const store = new MemoryBucket();
    const vault = new Vault(store, [await newMasterKey()]);
    await vault.set('media', SECRET);
    const sealed = await sealedOf(store, 'media');
    for (const changed of [
      { ...sealed, iv: flipped(sealed.iv) },
      { ...sealed, data: flipped(sealed.data) },
      { ...sealed, data: sealed.data.slice(0, -2) },
    ]) {
      await writeSealed(store, 'media', changed);
      await assert.rejects(vault.get('media'), VaultError);
    }
  });

  test('refuses a key moved to another name', async () => {
    const store = new MemoryBucket();
    const vault = new Vault(store, [await newMasterKey()]);
    await vault.set('media', SECRET);
    await writeSealed(store, 'session', await sealedOf(store, 'media'));
    await assert.rejects(vault.get('session'), /cannot be opened/);
  });

  test('opens nothing under another master key', async () => {
    const store = new MemoryBucket();
    await new Vault(store, [await newMasterKey()]).set('media', SECRET);
    const other = new Vault(store, [await newMasterKey()]);
    await assert.rejects(other.get('media'), /which this server does not have/);
    // A master key of the same name, but other bytes, opens nothing either.
    const sealed = await sealedOf(store, 'media');
    const impostor = await newMasterKey();
    await assert.rejects(
      new Vault(store, [{ id: sealed.kid, bytes: impostor.bytes }]).get('media'),
      /cannot be opened/,
    );
  });

  test('seals every key again under a new master key', async () => {
    const store = new MemoryBucket();
    const old = await newMasterKey();
    const vault = new Vault(store, [old]);
    await vault.set('media', SECRET, 'owner@example.org');
    await vault.set('session', 'the session key');
    const next = await newMasterKey();
    assert.deepEqual((await vault.rotate(next)).sort(), ['media', 'session']);
    const after = new Vault(store, [next]);
    assert.equal(await after.get('media'), SECRET);
    assert.equal(await after.get('session'), 'the session key');
    assert.equal((await after.about('media'))?.by, 'owner@example.org');
    await assert.rejects(new Vault(store, [old]).get('media'), VaultError);
  });

  test('opens every key while a rotation is half done', async () => {
    const store = new MemoryBucket();
    const old = await newMasterKey();
    const next = await newMasterKey();
    await new Vault(store, [old]).set('media', SECRET);
    await new Vault(store, [next]).set('session', 'the session key');
    const both = new Vault(store, [old, next]);
    assert.equal(await both.get('media'), SECRET);
    assert.equal(await both.get('session'), 'the session key');
  });

  test('names its master keys by their bytes, and takes only 32 of them', async () => {
    const key = await newMasterKey();
    const again = await masterKeyFromText(masterKeyText(key));
    assert.equal(again.id, key.id);
    assert.match(key.id, /^[0-9a-f]{8}$/);
    await assert.rejects(masterKey(new Uint8Array(16)), /32 bytes/);
    assert.throws(() => new Vault(new MemoryBucket(), []), /master key/);
  });

  test('keeps keys only under names of its own', async () => {
    const vault = new Vault(new MemoryBucket(), [await newMasterKey()]);
    await assert.rejects(vault.set('../uploads/x', 'v'), /Not a name of the vault/);
  });
});
