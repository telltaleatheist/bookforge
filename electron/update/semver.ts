/**
 * Tiny semver helper — just enough for the update system's compatibility gates (minLauncher,
 * requiresApp) and "is this version newer?" checks. Avoids pulling in the full `semver` package.
 *
 * Versions are "X.Y.Z" (a leading "v" and any -prerelease/+build suffix are ignored).
 * Ranges supported: "*"/"" (any), ">=X", ">X", "<=X", "<X", "^X.Y.Z", and exact ("X" or "=X").
 */

function parse(v: string): [number, number, number] {
  const cleaned = String(v).trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = cleaned.split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function gte(a: string, b: string): boolean {
  return compare(a, b) >= 0;
}

/** Does `version` satisfy `range`? Unparseable ranges fail closed (return false). */
export function satisfies(version: string, range: string | undefined | null): boolean {
  const r = (range ?? '').trim();
  if (r === '' || r === '*') return true;

  if (r.startsWith('>=')) return gte(version, r.slice(2).trim());
  if (r.startsWith('<=')) return compare(version, r.slice(2).trim()) <= 0;
  if (r.startsWith('>')) return gt(version, r.slice(1).trim());
  if (r.startsWith('<')) return compare(version, r.slice(1).trim()) < 0;

  if (r.startsWith('^')) {
    const base = r.slice(1).trim();
    if (compare(version, base) < 0) return false;
    return parse(version)[0] === parse(base)[0]; // same major
  }

  const exact = r.startsWith('=') ? r.slice(1).trim() : r;
  return compare(version, exact) === 0;
}
