/**
 * THE CONNECT CODE FOR A SERVER THIS APP IS ALREADY TALKING TO.
 *
 * ── The hole this fills ────────────────────────────────────────────────────
 *
 * Three surfaces have been telling people to copy a connect code from
 * somewhere else, and the somewhere else is a locked door:
 *
 *   * the extension's options page — "Copy a connect code from that server's
 *     operator page (Copy connect code), or from BookForge's Settings →
 *     Crucible";
 *   * `crucible-servers-panel` — "On that machine, open its console and copy
 *     its connect code";
 *   * `crucible-doors` — "Open the engine console on that machine and copy its
 *     connect code".
 *
 * The operator console DOES have that button, and it is behind the token: the
 * page asks for the token before it will show you the token. So the documented
 * route to a connect code is `crucible token --url` in a terminal ON that
 * machine — which is fine until the machine is a Mac across the room where
 * `crucible` is not on `$PATH`, which is exactly where Owen ran aground on
 * 2026-09-15: *"i tried accessing it on the mac but i dont know the bearer
 * token. maybe they're available in bookforge/foundry settings if theyre
 * connected."*
 *
 * They are. A registered server is a name, an address and a token this app
 * already holds and already sends on every request. Emitting the line it
 * already has costs nothing and breaks the circle.
 *
 * ── Why this is in MAIN and returns nothing ────────────────────────────────
 *
 * `shared/crucible/settings-wire.ts`, first paragraph: *"Nothing here carries a
 * token."* The renderer gets `tokenMasked` — `****<last 4>` — and that is a
 * deliberate boundary, not an oversight. A Copy button that received the line
 * would put a live credential in the renderer for every server, permanently,
 * to serve a click that happens twice a year.
 *
 * So the line is built here and written STRAIGHT TO THE CLIPBOARD. The renderer
 * asks, main copies, the renderer is told whether it worked. The token crosses
 * no boundary it does not already cross.
 */

import { clipboard } from 'electron';

import { getServer } from './servers';

/**
 * `crucible://<name>@<host>:<port>/#<token>` — crucible `pairing.py`'s format,
 * mirrored field for field.
 *
 * BOTH COMPONENTS ARE PERCENT-ENCODED WITH NOTHING SAFE, which is `quote(...,
 * safe='')` on the other side. The name is the half that matters today:
 * `crucible@example-pc-wsl` carries an `@`, and unencoded it would make the
 * authority start at the wrong one — the line would parse, name the host
 * `example-pc-wsl`, and be wrong in a way that looks right. The token is encoded
 * for the reason `operatorUrl` states: `secrets.token_urlsafe` emits only
 * unreserved characters today, so it changes nothing today, which is precisely
 * when a rule should be written down.
 *
 * THE TRAILING `/` BEFORE THE FRAGMENT IS PART OF THE FORMAT. Without it a
 * lenient parser reads the fragment as part of the authority and a strict one
 * refuses the line.
 */
export function connectCodeFor(name: string, url: string, token: string): string {
  const authority = new URL(url).host;
  if (authority === '') {
    throw new Error(
      `crucible "${name}" is registered at ${url}, which has no host to build a connect code `
      + 'from. A connect code names the address an app should reach, and there is none here.',
    );
  }
  return `crucible://${encodeURIComponent(name)}@${authority}/#${encodeURIComponent(token)}`;
}

/**
 * Put one registered server's connect code on the clipboard.
 *
 * Returns the line WITHOUT its token — `crucible://name@host/#****` — so the
 * caller can show what it copied without the renderer ever holding the secret.
 * An unknown name comes back in the REGISTRY's words — the only way to reach
 * this with one is a panel and a registry that have come apart, and its
 * refusal already lists what it does know.
 */
export function copyConnectCode(name: string): { copied: string } {
  // `getServer` REFUSES an unknown name in the registry's own words, which
  // already list what it does know. Catching it to say something shorter here
  // would be a second, worse copy of that sentence.
  const entry = getServer(name);
  const line = connectCodeFor(entry.name, entry.url, entry.token);
  clipboard.writeText(line);
  return { copied: line.replace(/#.*$/, '#****') };
}
