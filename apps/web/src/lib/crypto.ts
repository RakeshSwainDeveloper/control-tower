/**
 * The two Web Crypto calls this app depends on, and what to do when the
 * browser will not provide them.
 *
 * `crypto.randomUUID` and `crypto.subtle` are **secure-context only**. They
 * exist on HTTPS and on `localhost`, and they are `undefined` on plain HTTP at
 * any other hostname — a LAN address, a container name, a site office server
 * on `http://192.168.1.50`.
 *
 * That is not a theoretical case for this product. It was found by the e2e
 * browser reaching the app at `http://web:5173`, where the whole application
 * silently rendered the login screen: `crypto.randomUUID()` threw inside the
 * first request, the error was not an ApiError so nothing handled it, and the
 * session simply never loaded. No console error, no failed request, no clue.
 *
 * A supervisor on a site wifi would have seen exactly that.
 */

/** True when the browser will give us Web Crypto. */
export const secureContext = (): boolean =>
  typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

/**
 * A v4 UUID, from the platform where possible.
 *
 * The fallback uses `crypto.getRandomValues`, which is NOT secure-context
 * gated and is present on every browser this product supports. It is the same
 * entropy source `randomUUID` uses; only the convenience wrapper is gated.
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(b);
  } else {
    // No crypto at all. Still produce a distinct id rather than throwing — a
    // client_uuid only has to be unique, and refusing to record work because
    // the browser is old would be a much worse failure than weaker entropy.
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x40;   // version 4
  b[8] = (b[8]! & 0x3f) | 0x80;   // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * SHA-256 of a blob, used to let the server dedupe identical photographs.
 *
 * There is no reasonable pure-JS fallback for this on a phone: hashing a 4 MB
 * photograph in the main thread would freeze the screen. So when Web Crypto is
 * absent we say so, plainly, rather than failing somewhere further downstream
 * with an error nobody can act on.
 */
export async function sha256(blob: Blob): Promise<string> {
  if (!secureContext()) {
    throw new Error(
      'Photographs need a secure connection. Open this site over HTTPS (or on ' +
      'localhost) — the browser will not let a page on plain HTTP hash a file.',
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
