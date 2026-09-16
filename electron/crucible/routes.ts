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
 * ── One of the three facts here is remembered on disk ─────────────────────
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
import { engineOf } from '@crucible/client';
import type { EngineRef, ServerInfo } from '@crucible/client';
import type { CrucibleRouteKind, CrucibleTextActName } from '../../shared/crucible/settings-wire';
import type { EngineRole, EngineUpstreams } from '../../shared/queue/slot-sets';

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
 * …AND WHETHER THE ADDRESS UNDER THAT NAME IS AN ENGINE OR AN ORCHESTRATOR.
 *
 * The third fact in the same record, here for the reasons the second one is:
 * read at the moment this app connects, answered inside the same synchronous
 * pump, and forgotten by {@link forgetCrucibleRoutes} together with the others.
 *
 * crucible `docs/PHASE17-ORCHESTRATOR.md` §1: an orchestrator has backend kind
 * `orchestrator`, serves ZERO job types, manages exactly one engine and reads
 * capability through to it. So it has no card, and the bench must not draw it
 * one (`shared/queue/slot-sets.ts`'s {@link EngineRole}, which carries the whole
 * argument). A name this app has never asked is absent, which answers
 * `unknown` — and `unknown` DRAWS the row, because every pre-Phase-17 Crucible
 * is an engine and a bench that emptied itself until the first read landed
 * would be worse than one that corrects itself a tick later.
 *
 * The engine ref is kept beside the role rather than discarded: it is the one
 * thing worth SAYING about a registered orchestrator ("that address manages the
 * engine at <url>"), and re-deriving it would mean a second reader of the same
 * document.
 */
const rolesByServer = new Map<string, { role: EngineRole; engine: EngineRef | null }>();

/**
 * WHO WANTS TO KNOW WHEN ANY OF THIS CHANGES.
 *
 * ── The defect this closes (measured 2026-09-15) ──────────────────────────
 *
 * Owen's bench drew EIGHT slots where four belong: `local` and `mac` each with
 * a phantom `— routed elsewhere` cloud lane. The record was right and the
 * BENCH WAS OLD. `crucible-upstreams.json` did not exist yet when that launch
 * read it (created 15:04:16, read at 15:04:13), so both engines were `unknown`
 * — which draws the lane — until coordination answered three seconds later. The
 * renderer had already asked for its one snapshot inside that window, and with
 * an empty queue there is no pump, no step landing and no structural change, so
 * nothing ever published again. The main process was answering three slot sets
 * to `/api/queue/snapshot` while the window still drew eight.
 *
 * The rule was never wrong and neither was the read. What was missing is that
 * a record which answers `unknown` and then LEARNS has to say so: the whole
 * design of this module is "filled at exactly the two moments it can change",
 * and a fact nobody is told about is a fact the bench cannot act on.
 *
 * So the record announces its own changes, and the queue engine republishes.
 * Fired only when an ANSWER actually changes — re-recording the same routes on
 * every connect is not news, and a bench that republished on every coordination
 * would be a timer wearing a listener's clothes.
 */
type RecordListener = () => void;
let recordListeners: RecordListener[] = [];

/**
 * Be told when this record's answer about any server changes. Returns the
 * unsubscribe, which is how a keeper (and `configure`, called twice in one
 * process) avoids leaving a listener behind.
 */
export function onCrucibleRecordChanged(listener: RecordListener): () => void {
  recordListeners.push(listener);
  return () => { recordListeners = recordListeners.filter((l) => l !== listener); };
}

/**
 * Announce, from OUTSIDE this module, that something the bench reads has moved.
 *
 * The listener above is described as being about "this record's answer", and
 * for a while that was the only answer the bench had that could change behind
 * its back. It is not: the queue's own `routing.json` carries the RANK and the
 * ENABLED switch, and `slotSets` reads both.
 *
 * Owen, 2026-09-15, having unchecked a server on the bench: *"right now, it
 * stays lit up if its unchecked, but it goes gray if i choose the other server
 * on a job."* Both halves of that are one bug. The greying was right and it was
 * LATE — nothing republished the bench when the switch was written, so the row
 * kept its old look until some unrelated change (picking a server for a book)
 * caused a publish, and the uncheck appeared then. The header above says the
 * rule this broke: "a fact nobody is told about is a fact the bench cannot act
 * on."
 */
export function announceCrucibleRecordChanged(): void {
  recordChanged();
}

/** Announce a change. A listener that throws is REPORTED, never swallowed silently. */
function recordChanged(): void {
  for (const listener of recordListeners) {
    try {
      listener();
    } catch (err) {
      console.log(
        '[CRUCIBLE] a listener on the routing record threw: '
          + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

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
  const had = upstreamsByServer.size > 0;
  upstreamsByServer.clear();
  if (!fs.existsSync(file)) {
    if (had) recordChanged();
    return;
  }

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
  recordChanged();
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
  const before = byServer.get(server);
  byServer.set(server, { ...routes });
  if (before === undefined || !sameRoutes(before, routes)) recordChanged();
}

/** Do two route tables say the same thing about the same classes? */
function sameRoutes(a: ServerRoutes, b: Readonly<Record<string, CrucibleRouteKind>>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
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
    const had = byServer.size > 0 || upstreamsByServer.size > 0 || rolesByServer.size > 0;
    byServer.clear();
    upstreamsByServer.clear();
    rolesByServer.clear();
    // The remembered half goes with it, or a removed server would come back at
    // the next launch as a fact about a machine that is not there.
    saveUpstreams();
    if (had) recordChanged();
    return;
  }
  const had = byServer.delete(server);
  const hadUpstream = upstreamsByServer.delete(server);
  const hadRole = rolesByServer.delete(server);
  saveUpstreams();
  if (had || hadUpstream || hadRole) recordChanged();
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
  const before = upstreamsByServer.get(server);
  upstreamsByServer.set(server, configured);
  // Remembered across restarts: see {@link upstreamsFile}. Written on every note
  // rather than on a shutdown hook — there is no moment an app is guaranteed to
  // get, and this is one small file per settings read.
  saveUpstreams();
  // `unknown` becoming an answer is the change that matters most: it is what
  // takes a phantom cloud lane off a bench nothing else would redraw.
  if (before !== configured) recordChanged();
}

/**
 * Record whether the address registered under this name is an ENGINE or an
 * ORCHESTRATOR, out of the `/v1/info` the caller has already read.
 *
 * The SDK's {@link engineOf} is the whole of the rule (PHASE17 §6) and this is
 * its one use in this app: `null` means "this IS the engine, talk to the address
 * you have", an {@link EngineRef} means "this is an orchestrator, its engine is
 * over there". The hop is deliberately NOT followed here — this module reads no
 * documents at all — and the ref is kept so a caller can say where the engine
 * is instead of just refusing the row.
 *
 * `orchestrator_has_no_engine` is a fact and not a fault: a Windows machine
 * whose WSL engine is not installed yet answers it. It is recorded as an
 * orchestrator with no engine, which draws no row for the same reason as one
 * with an engine — this address has no card either way.
 */
export function noteCrucibleRole(server: string, info: ServerInfo): void {
  let entry: { role: EngineRole; engine: EngineRef | null };
  if (info.role === 'orchestrator') {
    let engine: EngineRef | null;
    try {
      engine = engineOf(info);
    } catch {
      // The one throw `engineOf` makes: an orchestrator that manages nothing.
      engine = null;
    }
    entry = { role: 'orchestrator', engine };
  } else {
    entry = { role: 'engine', engine: null };
  }
  const before = rolesByServer.get(server);
  rolesByServer.set(server, entry);
  if (before === undefined || before.role !== entry.role || before.engine?.url !== entry.engine?.url) {
    recordChanged();
  }
}

/**
 * Is the address under this name an engine, an orchestrator, or has nobody
 * asked — {@link EngineRole}, whose own note carries why `unknown` draws a row.
 */
export function crucibleRoleOf(server: string): EngineRole {
  const entry = rolesByServer.get(server);
  if (entry === undefined) return 'unknown';
  return entry.role;
}

/**
 * The engine a registered ORCHESTRATOR manages, for the sentence that tells an
 * operator what to register instead. `null` for an engine, for an orchestrator
 * that manages nothing, and for a name nobody has asked.
 */
export function crucibleEngineBehind(server: string): EngineRef | null {
  const entry = rolesByServer.get(server);
  if (entry === undefined) return null;
  return entry.engine;
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
