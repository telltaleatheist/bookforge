/**
 * WHERE EACH CLASS RUNS ON EACH ENGINE — the one thing the scheduler needs and
 * cannot ask for synchronously.
 *
 * ── The question ──────────────────────────────────────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3: a row whose class routes `upstream` on
 * its engine takes that engine's `[cloud]` lane rather than its GPU slot. The
 * queue decides that inside a synchronous pump (`crucibleAdmission`), and the
 * fact lives in a document on another machine. So it is READ at the moments it
 * can change, held here, and answered from memory.
 *
 * ── Why this is a RECORD and not a cache ──────────────────────────────────
 *
 * A cache answers with something stale when nobody refreshed it. This answers
 * `unknown` — a third value, which the scheduler treats as "wait, and ask" —
 * and it is filled at exactly the two moments the route can become or stop
 * being true:
 *
 *   1. **Coordination**, which already runs on every connect to every enabled
 *      server (PHASE14 §4a) and now reads `GET /v1/capability` while it is
 *      there. That is the read; nothing polls.
 *   2. **A settings write**, from the ANSWER `PUT /v1/settings` already
 *      returns — the whole document after the write (§3.2). No second round
 *      trip: the write-through path is handed the new routes and records them.
 *
 * There is deliberately no timer and no TTL. A route changed on the engine's
 * own page, or by Foundry, reaches this app at its next coordination, which is
 * its next connect — and a book already placed keeps the lane it was placed
 * in, which is the only sane moment-to-change for a running row.
 *
 * ── Why `unknown` is not "assume local" ───────────────────────────────────
 *
 * Assuming `local` would put an upstream-routed class on a GPU slot it will
 * never use: the row would hold a card nothing runs on while a real render
 * waited behind it, and nothing would say why. Assuming `upstream` would do
 * the mirror. So the third value exists and the scheduler WAITS on it with a
 * sentence, for the one tick it takes coordination to answer. A wait a person
 * can read is not a fallback; a guess is.
 */
import type { CrucibleRouteKind, CrucibleTextActName } from '../../shared/crucible/settings-wire';

/** What this record can say about one class on one engine. */
export type CrucibleRouteAnswer = CrucibleRouteKind | 'unknown';

/** One engine's routes, by class. Only classes the engine reported are present. */
type ServerRoutes = Readonly<Record<string, CrucibleRouteKind>>;

const byServer = new Map<string, ServerRoutes>();

/**
 * Record what one engine says about where its classes run.
 *
 * Two callers, both handing over a document THEY already read rather than
 * making a read of their own: coordination's capability record, and a settings
 * write's own answer. Both describe the same fact, so both write it here and
 * neither owns a second copy.
 */
export function noteCrucibleRoutes(server: string, routes: Readonly<Record<string, CrucibleRouteKind>>): void {
  byServer.set(server, { ...routes });
}

/**
 * Where this class runs on this engine, or `unknown` because nobody has asked
 * that engine yet.
 *
 * A class the engine did not mention is `unknown` too, and NOT `local`: a
 * record that lists three of four classes is a record this app cannot read,
 * and the fourth is exactly the one somebody would be surprised about.
 */
export function crucibleRouteOf(server: string, capability: string): CrucibleRouteAnswer {
  const routes = byServer.get(server);
  if (routes === undefined) return 'unknown';
  const route = routes[capability];
  return route === undefined ? 'unknown' : route;
}

/**
 * Forget one engine's routes, or all of them.
 *
 * Called when a server is removed or disabled — a record naming a server that
 * is gone would be answered from for a row that can no longer be placed there.
 * Nothing else prunes: a route is not evicted for being old, because age is
 * not what makes it wrong.
 */
export function forgetCrucibleRoutes(server?: string): void {
  if (server === undefined) byServer.clear();
  else byServer.delete(server);
}

/** Every engine this app has read routes from, for a log line and for keepers. */
export function crucibleRoutesKnownFor(): string[] {
  return [...byServer.keys()].sort();
}

/**
 * The four llm classes, out of a settings document's `routes` block.
 *
 * A thin shape change and nothing more: `{clean: {route, model}}` is the
 * document's shape and `{clean: 'local'}` is this record's, and the conversion
 * lives beside the record so neither caller writes it twice.
 */
export function routesFromSettings(
  routes: Readonly<Record<CrucibleTextActName, { route: CrucibleRouteKind }>>,
): Record<string, CrucibleRouteKind> {
  const out: Record<string, CrucibleRouteKind> = {};
  for (const [capability, row] of Object.entries(routes)) out[capability] = row.route;
  return out;
}

/** The same, out of a capability record — every class it reported, not just the four. */
export function routesFromCapability(
  classes: readonly { capability: string; route: CrucibleRouteKind }[],
): Record<string, CrucibleRouteKind> {
  const out: Record<string, CrucibleRouteKind> = {};
  for (const row of classes) out[row.capability] = row.route;
  return out;
}
