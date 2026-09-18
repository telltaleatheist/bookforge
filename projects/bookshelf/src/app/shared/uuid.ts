/**
 * `crypto.randomUUID()` exists only in a SECURE CONTEXT (https, or localhost).
 * The browser reaches Bookshelf over plain http:// on the LAN/tailnet, so there
 * the method is simply absent and calling it throws a TypeError — which aborted
 * whatever was mid-flight. That is what killed the speed buttons: setSpeed()
 * flushes listening time first, the flush minted an event id, and the throw
 * unwound before the new rate was ever applied. It only "worked on the 6th
 * click" because flushListening returns early when there is nothing to credit.
 *
 * `crypto.getRandomValues` is NOT secure-context-gated, so the fallback is a
 * real RFC 4122 v4 UUID, not a weaker id. Math.random is the last resort for an
 * environment that has neither.
 */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}
