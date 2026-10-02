/**
 * WHAT THIS APP CALLS ITSELF TO A CRUCIBLE — one name per INSTALL.
 *
 * It lands in `X-Crucible-Client` and the `User-Agent` the SDK sends, and it is
 * what `GET /v1/activity` and the server's queue report as a job's or a
 * session's `client`.
 *
 * ── Why the host is in it (Crucible 1.0.76, Oct 1 2026) ────────────────────
 *
 * A queue SESSION is matched to its client by this NAME: every request from the
 * client that holds the open session is an implicit item of it, header or not
 * (crucible docs/internals/queue-sessions.md). The Mac's BookForge and the PC's
 * used to both say `bookforge`, so one's session would have let the other's
 * requests ride ahead of the line — defeating "nothing from another app runs".
 * crucible-pc-1: give each install a distinct, STABLE name; nothing on the
 * server keys on the exact string. The short host name is stable across
 * restarts, and the CLI on the same machine shares it on purpose — it drives
 * the same app path, so it rides the app's session rather than waiting behind
 * it.
 *
 * Every engine this app spawns against a Crucible sends the same name in its
 * header map (`text-acts.ts`, `pages.ts`), so the engine's chats are items of
 * the session the door opened instead of strangers waiting behind it.
 */
import * as os from 'os';

/** `bookforge@owens-mac-studio` — the app's name and the short host name. */
export function crucibleClientNameFor(app: string, host: string = os.hostname()): string {
  const short = host.split('.')[0]?.trim().toLowerCase() ?? '';
  return short.length === 0 ? app : `${app}@${short}`;
}

export const CRUCIBLE_CLIENT_NAME = crucibleClientNameFor('bookforge');

/**
 * The name the HOSTED Foundry (`foundry-app/`, run in this process) opens its
 * sessions under — Foundry's own `crucibleClientNameFor('foundry')`, the same
 * rule on the same host. The startup sweep closes a session it left behind under
 * this name, because only the opener may close one (`session_not_yours`).
 */
export const HOSTED_FOUNDRY_CLIENT_NAME = crucibleClientNameFor('foundry');

/** The header the server reads a request's client from. */
export const CRUCIBLE_CLIENT_HEADER = 'X-Crucible-Client';
