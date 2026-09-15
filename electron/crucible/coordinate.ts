/**
 * THE ONE OWNER OF "make sure this server has what BookForge needs".
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a. Owen, 2026-09-14: *"if its present,
 * bookforge should coordinate with the installed crucible to make sure it has
 * what it needs to run all of its features"* — and, on the whole install story,
 * *"this whole process needs to be idiot proof."* So there is no button. Every
 * time BookForge CONNECTS to a Crucible it coordinates with it, and the row
 * draws what happened.
 *
 * ── ASK, THEN ACT ──────────────────────────────────────────────────────────
 *
 * The amendment Foundry's review produced (crucible `cecfdd0`) and the reason
 * it is not merely tidier:
 *
 *   1. READ `GET /v1/info`, `GET /v1/catalog` and `GET /v1/capability`. All
 *      three are cheap, read-only, and touch neither the lane nor the card.
 *   2. Compare the vendored module against them.
 *   3. Nothing missing → STOP. No task is posted at all.
 *   4. Something missing → post the module and follow its events.
 *
 * The third read is crucible `docs/PHASE15-HOST.md` §5.3a's: the module's
 * `needs` carry CAPABILITY CLASSES, unresolved, and the engine's own capability
 * record is the one place a class becomes an id. A class that engine has
 * disabled is NOT missing and NOT a refusal — it is UNMET, the task still
 * finishes `done`, and the row says "not on this engine".
 *
 * A module is idempotent (installed entries come back `skipped`), so posting
 * one on every connect would have been *correct* and still wrong: a Crucible
 * runs ONE task at a time, so a task whose whole content is `skipped` events is
 * a task the other app on this machine collides with (`task_busy`), and one
 * BookForge itself would be refused `server_busy` by its OWN lease while its
 * own book is rendering. The cheapest correct thing and the cheapest thing are
 * the same thing here, which is why the read comes first.
 *
 * ── NOTHING TO PRESS, ON ANY SERVER ────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"lets make it as simple as possible."* Coordination is
 * automatic on every server this app is connected to, however long ago it was
 * registered (crucible `1a10cc8`) and wherever it answers. The one way to say
 * "not that one" is the ENABLE switch that already means it, which is
 * why {@link coordinateServer} refuses a disabled server by name rather than
 * inventing a second opinion about which servers count.
 *
 * ── THE FOUR THINGS THAT CAN COME BACK, AND WHY EACH IS ITS OWN ACT ────────
 *
 * - **`task_busy`** — a task is already running on that server. It is FOLLOWED,
 *   never re-posted: there is no queue for tasks (PHASE13 §3.3), so a second
 *   post is simply refused again, and joining the stream of the one in flight
 *   is the only way to end up drawing the truth.
 * - **`server_busy`** — a lease, a job, the claim or a chat holds the card. A
 *   WAIT, with the holder shown verbatim, and a retry when the card settles.
 *   The shape is the queue's admission hold (`shared/queue/wait-for.ts`): a
 *   named sentence about a named machine, never a silent stall, and never a
 *   tight poll — the settle check is one `GET /v1/activity` on a slow cadence,
 *   reading the server's OWN composition of "nobody holds the card"
 *   (`slots.accelerated.acceptsWork`) rather than recomposing the four facts
 *   here (R1).
 * - **A refusal about the REQUEST** — `invalid_module`, `unknown_subject`. It
 *   fails ONCE, by name, and is remembered for the rest of the session: the
 *   vendored file cannot change while the app runs, so re-posting it would be
 *   the same wrong answer on a timer (R3 wants the loud wrong answer once, not
 *   forever).
 * - **Anything else** — unreachable, not a Crucible, a wrong token. Nothing was
 *   posted and the state says so.
 *
 * ── AND NEVER TWICE AT ONCE FOR ONE SERVER ─────────────────────────────────
 *
 * Four different moments call this (app start, for every enabled server; a
 * server added; a server re-enabled; the wizard's step landing on connected)
 * and two of them can happen inside a second of each other. {@link inFlight} is what makes the
 * second one join the first instead of racing it into the `task_busy` this
 * whole design exists to avoid.
 */
import {
  CrucibleAuthError,
  CrucibleCardHeld,
  CrucibleNotACrucible,
  CrucibleRefused,
  CrucibleUnreachable,
  CrucibleVersionError,
  type CatalogRow,
} from '@crucible/client';

import { crucibleClientFor, CRUCIBLE_CLIENT_NAME, getServer } from './servers';
import { resolveEngine } from './engine-resolve';
import { crucibleCapabilityWithRoutes, crucibleEngineSettings } from './engine-settings';
import { BOOKFORGE_MODULE, followModuleTask, postBookForgeModule } from './module-setup';
import { noteCrucibleRole } from './routes';
import { rankedServers } from './routing';
import type {
  CrucibleCapabilityView,
  CrucibleModuleProgress,
} from '../../shared/crucible/settings-wire';
import type {
  CrucibleCoordinationMap,
  CrucibleCoordinationState,
  CrucibleMissingEntry,
  CrucibleUnmetClass,
} from '../../shared/crucible/coordinate-wire';

/**
 * How long between two asks about a held card, and how many asks.
 *
 * Twenty seconds is slow enough that a whole afternoon of waiting costs the
 * other machine a few hundred bytes, and quick enough that a two-minute chat
 * is not waited out for five. Ninety of them is half an hour, after which the
 * wait STOPS with the holder still named: the next connect starts it again, and
 * an app that polled somebody else's server for ever would be holding an
 * opinion about their afternoon.
 */
export const SETTLE_POLL_MS = 20_000;
export const SETTLE_POLL_ATTEMPTS = 90;

/** What a coordination run needs from the outside. Injected so a keeper can drive it. */
export interface CoordinateDeps {
  /** Is this server one the queue may use? A disabled one is not coordinated with. */
  readonly isEnabled: (server: string) => boolean;
  /** Sleep, so a keeper does not wait twenty real seconds for a settle. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Now, as ISO 8601. */
  readonly now: () => string;
}

function defaultDeps(): CoordinateDeps {
  return {
    isEnabled: (server: string) => {
      const row = rankedServers().find((entry) => entry.name === server);
      /*
       * A server the rank record has never heard of is COORDINATED WITH, not
       * skipped. The record grows a row the first time something ranks it, so
       * "absent" is "nobody has said anything about this one", and the switch
       * that means "not that one" is an explicit `enabled: false`.
       */
      return row === undefined ? true : row.enabled;
    },
    sleep: (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The session's memory: one state per server, one run at a time, one refusal
// ─────────────────────────────────────────────────────────────────────────────

const states = new Map<string, CrucibleCoordinationState>();
const inFlight = new Map<string, Promise<CrucibleCoordinationState>>();
/** Servers whose module was refused about the REQUEST. Never posted again. */
const requestRefusals = new Map<string, { code: string; message: string }>();

type Listener = (state: CrucibleCoordinationState) => void;
const listeners = new Set<Listener>();

/** Every state coordination currently holds. A server absent from it is idle. */
export function coordinationStates(): CrucibleCoordinationMap {
  return Object.fromEntries(states);
}

/** Watch every state change, for a main process that forwards them to windows. */
export function onCoordination(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(state: CrucibleCoordinationState): void {
  states.set(state.server, state);
  for (const listener of listeners) listener(state);
}

/** Forget everything. Keepers only — a session never un-learns a refusal. */
export function resetCoordinationForTests(): void {
  states.clear();
  inFlight.clear();
  requestRefusals.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison — the whole of "does this server have what BookForge needs"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the module asks for that this server has not got, and what it will
 * never have.
 *
 * PURE, over the three reads, so the keeper can drive every branch of it and
 * the live path and the test path cannot come to disagree.
 *
 * ── THE MODULE NAMES CLASSES NOW, AND THE CLASSES ARE RESOLVED HERE ────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a, which Foundry's measurement against
 * the Mac produced (§4.6): `foundry.module.json` carried `dots-ocr` and
 * `qwen3.8-27b-4bit` as RESOLVED ids because `gen-modules.py` turned a class
 * into one id at generation time — the cuda-linux answer — so the Mac refused
 * the whole module `unknown_subject` for a subject it has no block for, and
 * named a 27B variant its own capability had not selected. The generator was a
 * second owner of a decision that is the SERVER's. So the module now carries
 * `needs: [{class}]` unresolved, and this function asks the engine's own
 * capability record what each class means ON THAT MACHINE before it looks in
 * that machine's catalog.
 *
 * Per class, and each arm is a different kind of news:
 *
 *   * **No row for it at all** — that engine's capability record has never
 *     heard of the class. UNMET, with the absence itself as the reason: it is
 *     the only one of these sentences this app composes, because there is no
 *     row to quote.
 *   * **`enabled: false`** — UNMET, carrying the row's own `reason` verbatim.
 *     *"A class this backend has DISABLED is not a refusal"* (§5.3a): the
 *     module is still posted for everything else, the task still finishes
 *     `done`, and the row says "not on this engine".
 *   * **Enabled, routed UPSTREAM** — nothing to pull and nothing missing. The
 *     work runs on the operator's account (§3.3) and there are no weights on
 *     that machine to be short of. `route` says so, and `selected` carrying a
 *     slash is the same fact said twice (§1: *"a local model id never contains
 *     `/`"*); both are read, because a pre-phase-15 document has no `route`
 *     and a routed one always has the slash.
 *   * **Enabled, local, nothing selected** — the engine decided it can serve
 *     the class and then found nothing that fits. UNMET: there is no id to
 *     look up, and a catalog search for `''` would report the empty string as
 *     a missing download.
 *   * **Enabled, local, with a selection** — `selected` IS the subject id, and
 *     the class is missing exactly when that machine's catalog says it is not
 *     installed.
 *
 * **Job types are compared on the TYPE alone**, not on the narrator engine, and
 * that is the server's own rule rather than a shortcut: a `module`'s install
 * entry is skipped when the job type is installed (PHASE13 §3.3), and
 * `/v1/info`'s `capabilities[].jobType` is the list PHASE13 §3.2 names as the
 * one a client compares against. A second opinion here — "installed, but with
 * the wrong engine" — would be this app deciding something the server decides.
 *
 * **Explicit `subjects` keep the comparison they always had.** §5.3a keeps them
 * for *"genuine app choices"* — the Higgs voice, the whisper size, the rvc
 * base — and the asymmetry is the point: a class is "give me whatever serves
 * this", which a machine may answer "nothing here does"; an id is "give me
 * this one", which it may not, so an explicit id a backend cannot hold is
 * still `unknown_subject` and still refuses the whole module.
 */
export function missingForBookForge(
  installedJobTypes: readonly string[],
  catalog: readonly CatalogRow[],
  capability: CrucibleCapabilityView,
): { missing: CrucibleMissingEntry[]; unmet: CrucibleUnmetClass[] } {
  const missing: CrucibleMissingEntry[] = [];
  const unmet: CrucibleUnmetClass[] = [];

  for (const entry of BOOKFORGE_MODULE.job_types) {
    if (installedJobTypes.includes(entry.type)) continue;
    missing.push({
      what: 'job-type',
      jobType: entry.type,
      narratorEngine: entry.narrator_engine === undefined ? null : entry.narrator_engine,
    });
  }

  for (const need of BOOKFORGE_MODULE.needs) {
    const row = capability.classes.find((item) => item.capability === need.class);
    if (row === undefined) {
      /*
       * NO ROW IS NOT "LOCAL AND FINE". A class the record does not mention is
       * a class nothing on that machine has decided about, and assuming it
       * works is exactly the fallback that would send a book's cleanup pass at
       * a server that cannot run it. The sentence is composed here because
       * there is no row whose words could be quoted — it is the one reason on
       * this type that is not the engine's own, and it carries NO FULL STOP,
       * because the words join several of these into one line.
       */
      unmet.push({
        class: need.class,
        reason: 'this engine\'s capability record does not mention it, so nothing there has '
          + 'decided whether it can serve it',
      });
      continue;
    }
    if (!row.enabled) {
      unmet.push({ class: need.class, reason: row.reason });
      continue;
    }
    if (row.route === 'upstream' || row.selected.includes('/')) continue;
    if (row.selected.length === 0) {
      unmet.push({ class: need.class, reason: row.reason });
      continue;
    }
    const subject = catalog.find(
      (item) => item.id === row.selected && (item.kind === 'model' || item.kind === 'engine'),
    );
    if (subject !== undefined && subject.installed) continue;
    missing.push({
      what: 'class',
      class: need.class,
      id: row.selected,
      kind: subject === undefined ? null : subject.kind,
      name: subject === undefined ? null : subject.name,
      jobType: subject === undefined ? null : subject.jobType,
      expectedBytes: subject === undefined ? null : subject.expectedBytes,
      inCatalog: subject !== undefined,
    });
  }

  for (const subject of BOOKFORGE_MODULE.subjects) {
    const row = catalog.find((item) => item.kind === subject.kind && item.id === subject.id);
    if (row !== undefined && row.installed) continue;
    missing.push({
      what: 'subject',
      kind: subject.kind,
      id: subject.id,
      name: row === undefined ? null : row.name,
      jobType: row === undefined ? null : row.jobType,
      expectedBytes: row === undefined ? null : row.expectedBytes,
      inCatalog: row !== undefined,
    });
  }

  return { missing, unmet };
}

// ─────────────────────────────────────────────────────────────────────────────
// The act
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make sure one server has what BookForge needs, and say where that got to.
 *
 * Idempotent, concurrent-safe, and cheap when there is nothing to do. It never
 * throws: every way this can end is a STATE, because every caller of it is a
 * moment that was doing something else (starting the app, adding a server) and
 * a Crucible that is off must not fail any of them.
 */
export function coordinateServer(
  server: string,
  deps: CoordinateDeps = defaultDeps(),
): Promise<CrucibleCoordinationState> {
  const running = inFlight.get(server);
  if (running !== undefined) return running;

  const run = runCoordination(server, deps).finally(() => { inFlight.delete(server); });
  inFlight.set(server, run);
  return run;
}

async function runCoordination(
  server: string,
  deps: CoordinateDeps,
): Promise<CrucibleCoordinationState> {
  if (!deps.isEnabled(server)) {
    /*
     * A DISABLED SERVER IS NOT COORDINATED WITH, and it is not an error either.
     * Owen's ruling makes the enable switch the one way to say "not that one"
     * (crucible `1a10cc8`), so this says exactly that and asks the machine
     * nothing. It is filed under `unreachable` because that phase's meaning is
     * "BookForge did not reach it, and here is why" — the message is the fact.
     */
    return report({
      server,
      phase: 'unreachable',
      message: `"${server}" is switched off in Settings, so BookForge asks it for nothing.`,
    });
  }

  const remembered = requestRefusals.get(server);
  report({ server, phase: 'checking' });

  let installedJobTypes: readonly string[];
  let catalog: readonly CatalogRow[];
  let capability: CrucibleCapabilityView;
  try {
    const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
    /*
     * THREE READS, AND THE THIRD ANSWERS TWO QUESTIONS.
     *
     * `GET /v1/capability` is read here because this is already the moment
     * BookForge connects to a server and asks what it has, and because two
     * separate things need what it says.
     *
     *  1. THE SCHEDULER's: where each class runs, `local` or `upstream`
     *     (crucible PHASE15 §3.3), has to be answerable inside a synchronous
     *     pump. Reading it here is what means nothing POLLS for it —
     *     coordination runs on every connect to every enabled server (PHASE14
     *     §4a), and `engine-settings.ts` records the routes again out of every
     *     settings write's own answer. The record itself is
     *     `crucible/routes.ts`.
     *  2. §5.3a's: the module's `needs` name CLASSES and the capability record
     *     is the one place a class becomes an id, so without this read there
     *     is no question to put to the catalog at all — "is the cleanup model
     *     installed" has a different answer on every machine, and the id is
     *     that machine's to name.
     *
     * A capability read that fails is the same `unreachable` as the other two:
     * a server that cannot answer one of these three is not answering.
     */
    const [info, rows, record] = await Promise.all([
      client.info(),
      client.catalog(),
      crucibleCapabilityWithRoutes(server),
    ]);
    /*
     * THE FIRST OF THE THREE READS ALSO SAYS WHICH HALF OF THE RELATION THIS
     * ADDRESS IS — PHASE17 §1's `role`. Recorded here rather than by a read of
     * its own for the reason the routes are: this is already the moment
     * BookForge connects and asks what is there, and the bench needs the answer
     * inside a synchronous pump. An orchestrator has no card, so it draws no
     * slot set (`shared/queue/slot-sets.ts`'s `EngineRole`).
     */
    noteCrucibleRole(server, info);
    installedJobTypes = info.capabilities.map((item) => item.jobType);
    catalog = rows;
    capability = record;
  } catch (err) {
    return report({ server, phase: 'unreachable', message: describeRead(err, server) });
  }

  await readUpstreamPresence(server);

  const { missing, unmet } = missingForBookForge(installedJobTypes, catalog, capability);
  if (missing.length === 0) {
    /*
     * STOCKED STILL MEANS "NOTHING IS MISSING", and an engine with unmet
     * classes and nothing to download is exactly that. No task could make it
     * serve a class it does not serve, so posting one would be asking a
     * machine to download its way out of being a different machine; the
     * classes travel on the state instead and the row names them (§5.3a: *"the
     * app shows 'not on this engine'"*).
     */
    return report({ server, phase: 'stocked', checkedAt: deps.now(), unmet });
  }

  if (remembered !== undefined) {
    // FAILS ONCE, BY NAME. The read still happened — the row is telling the
    // truth about what is missing — but the post that would be refused the
    // same way is not made again.
    return report({ server, phase: 'refused', code: remembered.code, message: remembered.message });
  }

  return prepare(server, missing, unmet, deps);
}

/**
 * A FOURTH READ, FOR THE BENCH: has this engine got anywhere to send work.
 *
 * ── Why here ───────────────────────────────────────────────────────────────
 *
 * The queue draws an engine's `[cloud]` lane only when that engine has an
 * upstream configured (`shared/queue/slot-sets.ts`, `SlotSetFacts.upstreams`),
 * and the scheduler answers that inside a synchronous pump. So it is read at
 * the moments it can change and held in `crucible/routes.ts` — exactly the
 * arrangement the per-class route already has, and this is the other of its two
 * moments (the first being a settings write's own answer). Nothing polls.
 *
 * Coordination is that moment because it already runs on every connect to every
 * enabled server (PHASE14 §4a) and has just made three reads of this machine.
 * `GET /v1/settings` is the fourth, and it is the same kind of thing: cheap,
 * read-only, touching neither the lane nor the card.
 *
 * ── Why it is NOT in the `Promise.all` above ───────────────────────────────
 *
 * Those three reads decide whether coordination happened at all — a server that
 * cannot answer one of them is not answering, and the run reports `unreachable`.
 * This one decides a row on a bench. A server that predates PHASE15 has no
 * settings door and answers 404 (`settings_door_absent`), and failing the whole
 * coordination of an older but perfectly usable Crucible over a bench row would
 * be this read deciding something that is not its business.
 *
 * ── Why the failure is swallowed, and why that is not a fallback ───────────
 *
 * Nothing is recorded when the read fails, and the record's answer for a server
 * it has not heard about is `unknown` — a stated third value, which draws the
 * lane exactly as it was drawn before this fact existed. That is the one
 * behaviour the ruling asks for by name: absence of knowledge is not absence of
 * an upstream. A `catch` that wrote `false` here would be the fallback.
 */
async function readUpstreamPresence(server: string): Promise<void> {
  try {
    // For the record it fills on the way past (`projectSettings` →
    // `noteCrucibleUpstreams`), not for the document, which nothing here reads.
    await crucibleEngineSettings(server);
  } catch (err) {
    glogUpstream(server, err);
  }
}

/**
 * THE OTHER BENCH FACT: is this address an engine or an orchestrator.
 *
 * `GET /v1/info` through the ONE resolver, which follows the orchestrator hop
 * once and records what is on the other side. Coordination records the role of
 * the ADDRESS out of the info it already reads (see `runCoordination`); this
 * answers the same question one level deeper, so a registered orchestrator does
 * not keep a GPU row nothing can serve.
 *
 * A failure is swallowed AND SAID: the record answers `unknown` for a server it
 * has not heard from, and `unknown` draws the row, because every pre-Phase-17
 * Crucible is an engine. Recording `engine` on a timeout would be the fallback.
 */
async function readRolePresence(server: string): Promise<void> {
  try {
    // Through the ONE resolver, so the answer this records is the one placement
    // would get — including the second read that makes "one hop, never a chain"
    // enforced rather than assumed. It records the role on the way past.
    await resolveEngine(getServer(server), CRUCIBLE_CLIENT_NAME);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      `[CRUCIBLE] "${server}" did not say whether it is an engine or an orchestrator, so it keeps `
        + `its row on the bench: ${detail}`,
    );
  }
}

/** One line, so a bench row that stayed on an engine with no upstream has a why. */
function glogUpstream(server: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.log(
    `[CRUCIBLE] "${server}" did not say whether it has an upstream configured, so its cloud `
      + `lane stays on the bench: ${detail}`,
  );
}

/** Post the module (or join the task already running) and follow it to the end. */
async function prepare(
  server: string,
  missing: readonly CrucibleMissingEntry[],
  unmet: readonly CrucibleUnmetClass[],
  deps: CoordinateDeps,
): Promise<CrucibleCoordinationState> {
  let attempts = 0;

  // The wait loop. Every turn of it is one POST attempt; a `server_busy` turns
  // into one slow settle check, never a tight poll.
  for (;;) {
    let taskId: string;
    let followed = false;
    try {
      taskId = await postBookForgeModule(server);
    } catch (err) {
      if (err instanceof CrucibleCardHeld) {
        attempts += 1;
        const holder = { fact: err.fact, who: err.who };
        const stopped = attempts >= SETTLE_POLL_ATTEMPTS;
        const waiting = report({
          server, phase: 'waiting', missing, unmet, holder, attempts, stopped,
        });
        if (stopped) return waiting;
        await waitForSettle(server, deps);
        continue;
      }
      if (err instanceof CrucibleRefused && err.code === 'task_busy') {
        // FOLLOWED, NOT RE-POSTED. A Crucible has no queue for tasks, so the
        // one in flight is the only one there will be until it lands.
        const other = await runningTaskId(server);
        if (other === null) {
          /*
           * `task_busy` and then no running task in the listing: it landed in
           * the moment between the two calls. Ask again from the top — the
           * catalog read is what decides whether there is still anything to do,
           * and it may well have been that very task that did it.
           */
          return runCoordination(server, deps);
        }
        taskId = other;
        followed = true;
      } else if (err instanceof CrucibleRefused) {
        // A refusal about the REQUEST: `invalid_module`, `unknown_subject`, or
        // any other name this build has not met. Once, and remembered.
        requestRefusals.set(server, { code: err.code, message: err.message });
        return report({ server, phase: 'refused', code: err.code, message: err.message });
      } else {
        return report({ server, phase: 'unreachable', message: describeRead(err, server) });
      }
    }

    const progress0: CrucibleModuleProgress = {
      server, taskId, state: 'running',
      step: null, line: null, bytes: null, skipped: null, jobTypes: null, error: null,
      unmet: null,
    };
    report({ server, phase: 'preparing', missing, unmet, progress: progress0, followed });

    const last = await followModuleTask(server, taskId, (progress) => {
      report({ server, phase: 'preparing', missing, unmet, progress, followed });
    });
    return report({ server, phase: 'preparing', missing, unmet, progress: last, followed });
  }
}

/**
 * Wait until the card is free, by asking the server rather than by guessing.
 *
 * `slots.accelerated.acceptsWork` is the server's OWN composition of "the lane
 * is free AND nobody holds the card", derived once so that three clients do not
 * each invent it and disagree (R1). Reading `true` is not permission — the
 * post is still the only authority — it is simply the cheapest honest signal
 * that asking again is worth a round trip.
 */
async function waitForSettle(server: string, deps: CoordinateDeps): Promise<void> {
  await deps.sleep(SETTLE_POLL_MS);
  try {
    const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
    for (;;) {
      const activity = await client.activity();
      if (activity.slots.accelerated.acceptsWork) return;
      await deps.sleep(SETTLE_POLL_MS);
    }
  } catch {
    /*
     * The settle check could not be made. Returning is right: the POST that
     * follows is the thing with an authoritative answer, and it will produce
     * either the same named wait or the real refusal. Swallowing the read's own
     * error here is not hiding a failure — it is declining to invent a second
     * outcome for a question the next line asks properly.
     */
  }
}

/** The id of whatever task is running on this server, or null. */
async function runningTaskId(server: string): Promise<string | null> {
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  const tasks = await client.tasks();
  const running = tasks.find((task) => task.state === 'running');
  return running === undefined ? null : running.taskId;
}

/**
 * Why a read did not happen, in the SDK's own words with the server named.
 *
 * Each of these is a different fix — nothing there, something else there, the
 * wrong token, the wrong API — and flattening them would be the thing the
 * two-step probe exists to prevent.
 */
function describeRead(err: unknown, server: string): string {
  if (err instanceof CrucibleUnreachable) return `"${server}" did not answer: ${err.message}`;
  if (err instanceof CrucibleNotACrucible) return `"${server}" answered, but it is not a Crucible: ${err.message}`;
  if (err instanceof CrucibleAuthError) return `"${server}" refused this machine's token: ${err.message}`;
  if (err instanceof CrucibleVersionError) return `"${server}" speaks a different API version: ${err.message}`;
  if (err instanceof CrucibleRefused) return `"${server}" refused ${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function report(state: CrucibleCoordinationState): CrucibleCoordinationState {
  publish(state);
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// The moments that call it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * COORDINATE WITH EVERY ENABLED SERVER AT START — THE SAME WAY WITH EACH.
 *
 * ── What this replaced, and why the shape changed ──────────────────────────
 *
 * There were two functions here until Owen's ruling of 2026-09-15. One
 * coordinated with the reserved `local` row — a full coordination, the three
 * reads and a module task if anything was missing. The other asked every OTHER
 * enabled server two cheap questions and deliberately skipped `local`, because
 * the first function had already answered them for it.
 *
 * *"a local crucible server shouldnt be treated any differently than a remote
 * crucible server."* So there is one function, every enabled server goes through
 * it, and the thing they all get is the FULL coordination — the strictly larger
 * of the two, which is what makes "the same way" true rather than a wording.
 *
 * ── Why coordinating all of them at start is not the big act it looks like ─
 *
 * Coordination is cheap WHEN THERE IS NOTHING TO DO, and that is the whole
 * design (see this module's header): three reads, a comparison, and a task
 * posted only when the comparison says something is missing. An engine that is
 * already stocked costs three GETs and posts nothing. The old two-question pass
 * already cost two of them per server, so the difference for a stocked machine
 * is one read.
 *
 * And it closes, for every server, the two bench defects the two-question pass
 * was written for: the cloud lane drawn for an engine nobody had asked about
 * (`shared/queue/slot-sets.ts`, `SlotSetFacts.upstreams`), and the GPU row drawn
 * for an address that turns out to be an ORCHESTRATOR (`EngineRole`; crucible
 * PHASE17 §1).
 *
 * ── The role read is still its own call, and that is not an inconsistency ──
 *
 * {@link readRolePresence} goes through `engine-resolve.ts`, which follows the
 * orchestrator hop ONCE and records what it found. Coordination's own
 * `noteCrucibleRole` records the role of the ADDRESS from the info it already
 * read. They answer the same question at two depths, both are wanted, and
 * running both is what the pre-ruling code did for a remote. It is kept for
 * every server rather than dropped for the sake of one call.
 *
 * Every failure is swallowed AND SAID: coordination never throws (see
 * {@link coordinateServer}), and the role read logs its own line. A server that
 * did not answer keeps its lane, because absence of knowledge is not absence of
 * an upstream.
 *
 * Returns the names it asked, for the caller's log line. The server list is
 * injected for the reason {@link CoordinateDeps} is: a keeper drives it with a
 * scripted set rather than with this machine's registry.
 */
export async function coordinateServersOnStart(
  deps: CoordinateDeps = defaultDeps(),
  enabledServers: () => readonly string[] = () => rankedServers().map((row) => row.name),
): Promise<string[]> {
  let enabled: readonly string[];
  try {
    enabled = enabledServers();
  } catch {
    /*
     * `rankedServers` refuses BY NAME when nothing is enabled, and that refusal
     * is about placing work — it is the queue's to report when a row cannot be
     * placed, not this one's at startup. With no enabled server there is nothing
     * to coordinate with and no bench row to be wrong about.
     */
    return [];
  }
  await Promise.all(enabled.flatMap((name) => [
    coordinateServer(name, deps),
    readRolePresence(name),
  ]));
  return [...enabled];
}
