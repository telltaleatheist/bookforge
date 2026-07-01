/**
 * Encode/decode an audiobook download path as a URL-safe route id.
 *
 * The raw path can't go straight into the route: filenames look like
 * "Title. Author. (Year).m4b" and Angular's router parses "(...)" as
 * auxiliary-outlet syntax, corrupting the param. base64url has no parens,
 * slashes, or other reserved characters, so it round-trips cleanly.
 */
export function encodePathId(path: string): string {
  // unescape(encodeURIComponent()) yields a Latin1 byte string so btoa handles
  // non-ASCII titles. Then make it URL-safe.
  const b64 = btoa(unescape(encodeURIComponent(path)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePathId(id: string): string {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return '';
  }
}
