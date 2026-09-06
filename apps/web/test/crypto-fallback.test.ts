/**
 * The app must work on plain HTTP at a hostname that is not localhost.
 *
 * `crypto.randomUUID` and `crypto.subtle` are secure-context only. On
 * `http://192.168.1.50:5173` — a site office server, a phone on the site wifi —
 * both are `undefined`.
 *
 * Before this was fixed the whole application silently rendered the login
 * screen: `crypto.randomUUID()` threw inside the first request, the error was
 * not an ApiError so nothing handled it, the session never loaded, and there
 * was no console error, no failed request and no clue. A supervisor would have
 * seen a login form that did nothing.
 *
 * Found by the e2e browser reaching the app at `http://web:5173`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { uuid, sha256, secureContext } from '../src/lib/crypto.js';

const real = globalThis.crypto;
afterEach(() => { Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true }); });

const withCrypto = (value: unknown) =>
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });

describe('secure-context fallbacks', () => {
  it('mints a valid v4 UUID when randomUUID is missing', () => {
    withCrypto({ getRandomValues: real.getRandomValues.bind(real) });
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('still mints one with no Web Crypto at all', () => {
    // Weaker entropy, but refusing to record work because the browser is old
    // is a far worse failure than a less random client_uuid.
    withCrypto({});
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('produces distinct ids — a client_uuid is an idempotency key', () => {
    withCrypto({});
    const ids = new Set(Array.from({ length: 500 }, () => uuid()));
    expect(ids.size).toBe(500);
  });

  it('uses the platform implementation when it is there', () => {
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(secureContext()).toBe(true);
  });

  it('hashing explains itself rather than failing obscurely', async () => {
    // There is no reasonable pure-JS fallback: hashing a 4 MB photograph on
    // the main thread would freeze a phone. So say what is wrong.
    withCrypto({ getRandomValues: real.getRandomValues.bind(real) });
    const blob = { arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Blob;
    await expect(sha256(blob)).rejects.toThrow(/secure connection|HTTPS/i);
  });

  it('hashes correctly when Web Crypto is available', async () => {
    // jsdom's Blob has no arrayBuffer(), so stand in with the minimum sha256
    // actually uses. The value is the standard SHA-256("abc") vector, so this
    // still checks the digest and the hex encoding, not just that it resolves.
    const blob = {
      arrayBuffer: async () => new TextEncoder().encode('abc').buffer,
    } as unknown as Blob;
    await expect(sha256(blob)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
