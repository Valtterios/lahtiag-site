import { describe, it, expect, beforeAll } from 'vitest';
import { verifyInteractionSignature } from '../src/lib/discord';

// Real Ed25519, no mocks: a keypair generated in the same runtime signs the
// way Discord does, and verification must accept exactly that and nothing
// else.

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

let publicKeyHex: string;
let privateKey: CryptoKey;

async function sign(timestamp: string, body: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  return toHex(signature);
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyHex = toHex(await crypto.subtle.exportKey('raw', pair.publicKey));
});

describe('verifyInteractionSignature', () => {
  const body = '{"type":1}';
  const timestamp = '1760000000';

  it('accepts a valid signature', async () => {
    expect(await verifyInteractionSignature(publicKeyHex, await sign(timestamp, body), timestamp, body)).toBe(
      true,
    );
  });

  it('rejects a signature over a different body', async () => {
    const signature = await sign(timestamp, body);
    expect(await verifyInteractionSignature(publicKeyHex, signature, timestamp, '{"type":2}')).toBe(false);
  });

  it('rejects a replayed signature with a different timestamp', async () => {
    const signature = await sign(timestamp, body);
    expect(await verifyInteractionSignature(publicKeyHex, signature, '1760009999', body)).toBe(false);
  });

  it('rejects signatures from a different key', async () => {
    const other = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const signature = toHex(
      await crypto.subtle.sign('Ed25519', other.privateKey, new TextEncoder().encode(timestamp + body)),
    );
    expect(await verifyInteractionSignature(publicKeyHex, signature, timestamp, body)).toBe(false);
  });

  it.each([
    ['not-hex', 'zz'],
    ['odd-length', 'abc'],
    ['empty', ''],
  ])('rejects malformed hex (%s) without throwing', async (_label, bad) => {
    expect(await verifyInteractionSignature(publicKeyHex, bad, timestamp, body)).toBe(false);
    expect(await verifyInteractionSignature(bad, await sign(timestamp, body), timestamp, body)).toBe(false);
  });
});
