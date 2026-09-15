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
 * ── One of the two facts here is remembered on disk ───────────────────────
 *
 * Whether an engine has an UPSTREAM configured is written to
 * `<userData>/crucible-upstreams.json` and read back at start, because
 * otherwise `unknown` was not a rare state but the state of every launch — see
 * {@link upstreamsFile}. The per-class ROUTE is not: coordination reads it from
 * `GET /v1/capability` on every connect, so it is answered within a tick of
 * this app talking to that machine at all, and there is nothing a remembered
 * copy would be right about that the read is not.
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
import * as fs from 'fs';
import * as path from 'path';
import type { CrucibleRouteKind, CrucibleTextActName } from '../../shared/crucible/settings-wire';
import type { EngineUpstreams } from '../../shared/queue/slot-sets';

/** What this record can say about one class on one engine. */
export type CrucibleRouteAnswer = CrucibleRouteKind | 'unknown';

/** One engine's routes, by class. Only classes the engine reported are present. */
type ServerRoutes = Readonly<Record<string, CrucibleRouteKind>>;

const byServer = new Map<string, ServerRoutes>();

/**
 * …AND WHETHER EACH ENGINE HAS ANYWHERE TO SEND WORK AT ALL.
 *
 * A second fact in the same record, and deliberately not a second module: it is
 * read at the same two moments (coordination, and a settings write's own
 * answer), it is answered inside the same synchronous pump, and
 * {@link forgetCrucibleRoutes} must forget both together — a server removed
 * while one of the two records still named it would be answered about from the
 * half that had not been pruned.
 *
 * It is what the queue's cloud lane is drawn on
 * (`shared/queue/slot-sets.ts`'s `SlotSetFacts.upstreams`, which carries the
 * whole argument for why this fact and not `route`). Absent means `unknown`,
 * the record's own third value, and NOT "no upstream": nobody has read that
 * engine's settings yet.
 */
const upstreamsByServer = new Map<string, boolean>();

/**
 * …AND THIS ONE IS REMEMBERED ACROSS RESTARTS, because otherwise its `unknown`
 * is not a rare state but the STEADY STATE OF EVERY LAUNCH.
 *
 * Measured 2026-09-15: Owen's bench drew `mac — routed elsewhere · CPU ×2` on a
 * Mac whose `GET /v1/settings` says `upstreams {anthropic: false, openai: false,
 * ollama: false}` and whose four routes are all `local`. The rule was right and
 * the record was empty: the map above lived only in memory, `local` had been
 * coordinated this session and the Mac had not, so the Mac was `unknown` and
 * `unknown` draws the lane. Every fresh launch looked like that until something
 * happened to connect to each machine — phantom lanes as the default.
 *
 * Whether an engine has an upstream is a fact about that MACHINE, not about this
 * process, and it changes when somebody pastes a key into a field. So it is
 * written beside the routing record and read back at start
 * (`<userData>/crucible-upstreams.json`), and only a server this app has
 * genuinely never read is `unknown`.
 *
 * `unknown → draw the lane` STAYS the rule, and with this it is a momentary
 * state rather than the default. Worth saying why it is conservatism and not
 * necessity: a RUNNING upstream-routed row could not be stranded by hiding the
 * lane anyway, because such a row's venue IS `<server>:cloud` and `slotSets`
 * keeps an occupied set on the bench (`facts.occupied`); and a QUEUED one is
 * computable from the snapshot by exactly the method the legacy row uses
 * (`longformAlignCharged`). The lane is drawn for an unread engine because absence
 * of knowledge is not absence of an upstream, not because anything would break.
 *
 * NOT IN `crucible-routing.json`: that file is the operator's PREFERENCES —
 * order, enable switches, the legacy switch — and is refused rather than
 * repaired when it is corrupt, because those are choices a person made. This is
 * a fact this app LEARNED from a machine, re-learnable by asking again, so it
 * gets its own file and a corrupt one costs a launch of `unknown` rather than an
 * app that will not route anything (crucible `docs/ARCHITECTURE.md` R1: one
 * owner per fact, and these are two facts).
 */
let upstreamsFile: string | null = null;

/**
 * Its name under `<userData>`. Spelled here, composed by main — this module has
 * no Electron in it on purpose (the scheduler reads it inside a synchronous
 * pump, see `queue-engine.ts`'s import note), so it is handed the path.
 */
export const CRUCIBLE_UPSTREAMS_FILE = 'crucible-upstreams.json';

/** The file's shape. One key, so a later fact can join it without a migration. */
interface UpstreamsRecord {
  upstreams: Record<string, boolean>;
}

/**
 * Bind the record to a file and read what is in it. One caller: main, at start.
 *
 * Throws on a file that exists and is not this record — a learned fact is not
 * silently replaced any more than a chosen one is, and the caller says so in the
 * log. The path is bound BEFORE the parse, so the next
 * {@link noteCrucibleUpstreams} rewrites the bad file rather than leaving it to
 * fail every launch; until then every engine answers `unknown`, which is the
 * behaviour this app had before the file existed.
 */
export function loadCrucibleUpstreams(file: string): void {
  upstreamsFile = file;
  upstreamsByServer.clear();
  if (!fs.existsSync(file)) return;

  const raw = fs.readFileSync(file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `crucible_upstreams_record_corrupt: ${file} is not valid JSON (${(err as Error).message}). `
        + 'It remembers which engines have an upstream configured; nothing here will replace it '
        + 'silently. Until it is repaired or the next read of a server rewrites it, every engine '
        + 'is "unknown" and keeps its cloud lane.',
    );
  }
  const record = parsed as Partial<UpstreamsRecord> | null;
  const table = record?.upstreams;
  if (table === null || table === undefined || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(
      `crucible_upstreams_record_corrupt: ${file}: "upstreams" must be an object of server name `
        + '→ true/false. Repair or delete the file by hand.',
    );
  }
  for (const [server, configured] of Object.entries(table)) {
    if (typeof configured !== 'boolean') {
      upstreamsByServer.clear();
      throw new Error(
        `crucible_upstreams_record_corrupt: ${file}: "${server}" is `
          + `${JSON.stringify(configured)}, and an engine either has an upstream configured or it `
          + 'does not. Repair or delete the file by hand.',
      );
    }
    upstreamsByServer.set(server, configured);
  }
}

/** Forget the file, so a keeper (or a test run) writes nothing. */
export function unbindCrucibleUpstreamsFile(): void {
  upstreamsFile = null;
}

/**
 * Write the whole table, temp-and-rename like every other record this app keeps.
 *
 * A failed write is REPORTED AND NOT THROWN, which is the one place here that
 * needs an argument. The fact is already true in memory, so the session behaves
 * correctly either way; the only cost of losing the write is that the next
 * launch says `unknown` about that engine and draws its lane, which is exactly
 * what this app did before the file existed. Throwing would instead fail the
 * settings READ this is called from the middle of — a bench convenience taking
 * down a real operation.
 */
function saveUpstreams(): void {
  const file = upstreamsFile;
  if (file === null) return;
  const record: UpstreamsRecord = { upstreams: Object.fromEntries(upstreamsByServer) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, file);
  } catch (err) {
    console.log(
      `[CRUCIBLE] could not remember which engines have an upstream (${file}): `
        + `${err instanceof Error ? err.message : String(err)}. This session is unaffected; the `
        + 'next launch will ask each server again.',
    );
  }
}

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
  if (server === undefined) {
    byServer.clear();
    upstreamsByServer.clear();
    // The remembered half goes with it, or a removed server would come back at
    // the next launch as a fact about a machine that is not there.
    saveUpstreams();
    return;
  }
  byServer.delete(server);
  upstreamsByServer.delete(server);
  saveUpstreams();
}

/**
 * Record whether one engine has ANY upstream configured.
 *
 * One caller: {@link projectSettings} in `engine-settings.ts`, which is the one
 * funnel every settings document this app reads passes through — the GET at
 * coordination and the whole-document answer to a PUT alike. Recorded there
 * rather than at each call site for the reason `noteCrucibleRoutes` has two
 * callers and no third: a reader that forgot would leave the bench drawing a
 * lane the operator has just taken away, or hiding one they have just made.
 */
export function noteCrucibleUpstreams(server: string, configured: boolean): void {
  upstreamsByServer.set(server, configured);
  // Remembered across restarts: see {@link upstreamsFile}. Written on every note
  // rather than on a shutdown hook — there is no moment an app is guaranteed to
  // get, and this is one small file per settings read.
  saveUpstreams();
}

/**
 * Can this engine send work elsewhere at all — `configured`, `none`, or
 * `unknown` because nobody has read its settings.
 *
 * `unknown` is a stated third value and not a shrug: an engine that has not
 * been asked, did not answer, or predates the settings door keeps the cloud
 * lane it has always had, because absence of knowledge is not absence of an
 * upstream.
 *
 * SINCE 2026-09-15 this answers from what the LAST run learned as well as this
 * one ({@link loadCrucibleUpstreams}), so `unknown` means "this app has never
 * had an answer from that engine" rather than "nobody has connected yet in this
 * process". That is the difference between a rare state and every launch.
 */
export function crucibleUpstreamsOf(server: string): EngineUpstreams {
  const configured = upstreamsByServer.get(server);
  if (configured === undefined) return 'unknown';
  return configured ? 'configured' : 'none';
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
