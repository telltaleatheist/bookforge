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
 *   1. READ `GET /v1/info` and `GET /v1/catalog`. Both are cheap, read-only,
 *      and touch neither the lane nor the card.
 *   2. Compare the vendored module against them.
 *   3. Nothing missing → STOP. No task is posted at all.
 *   4. Something missing → post the module and follow its events.
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
 * automatic on every server this app is connected to — `local` and every
 * remote, however long ago it was registered (crucible `1a10cc8`). The one way
 * to say "not that one" is the ENABLE switch that already means it, which is
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
 * Four different moments call this (app start for `local`, a server added, a
 * server re-enabled, the wizard's step landing on connected) and two of them
 * can happen inside a second of each other. {@link inFlight} is what makes the
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

import { crucibleClientFor, CRUCIBLE_CLIENT_NAME, describeLocal } from './servers';
import { crucibleCapabilityWithRoutes } from './settings-wire';
import { BOOKFORGE_MODULE, followModuleTask, postBookForgeModule } from './module-setup';
import { LOCAL_SERVER_NAME } from './local';
import { rankedServers } from './routing';
import type { CrucibleModuleProgress } from '../../shared/crucible/settings-wire';
import type {
  CrucibleCoordinationMap,
  CrucibleCoordinationState,
  CrucibleMissingEntry,
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
 * What the module asks for that this server has not got.
 *
 * PURE, over the two reads, so the keeper can drive every branch of it and the
 * live path and the test path cannot come to disagree.
 *
 * **Job types are compared on the TYPE alone**, not on the narrator engine, and
 * that is the server's own rule rather than a shortcut: a `module`'s install
 * entry is skipped when the job type is installed (PHASE13 §3.3), and
 * `/v1/info`'s `capabilities[].jobType` is the list PHASE13 §3.2 names as the
 * one a client compares against. A second opinion here — "installed, but with
 * the wrong engine" — would be this app deciding something the server decides.
 */
export function missingForBookForge(
  installedJobTypes: readonly string[],
  catalog: readonly CatalogRow[],
): CrucibleMissingEntry[] {
  const missing: CrucibleMissingEntry[] = [];

  for (const entry of BOOKFORGE_MODULE.job_types) {
    if (installedJobTypes.includes(entry.type)) continue;
    missing.push({
      what: 'job-type',
      jobType: entry.type,
      narratorEngine: entry.narrator_engine === undefined ? null : entry.narrator_engine,
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

  return missing;
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
  try {
    const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
    /*
     * THREE READS, AND THE THIRD IS THE SCHEDULER'S.
     *
     * `GET /v1/capability` is read here because this is already the moment
     * BookForge connects to a server and asks what it has, and because the one
     * thing the QUEUE needs from a server — where each class runs, `local` or
     * `upstream` (crucible PHASE15 §3.3) — has to be answerable inside a
     * synchronous pump. Reading it here is what means nothing POLLS for it:
     * coordination runs on every connect to every enabled server (PHASE14
     * §4a), and `settings-wire.ts` records the routes again out of every
     * settings write's own answer. The record itself is `crucible/routes.ts`.
     *
     * It does not change coordination's verdict. A capability read that fails
     * is the same `unreachable` as the other two: a server that cannot answer
     * one of these three is not answering.
     */
    const [info, rows] = await Promise.all([
      client.info(),
      client.catalog(),
      crucibleCapabilityWithRoutes(server),
    ]);
    installedJobTypes = info.capabilities.map((capability) => capability.jobType);
    catalog = rows;
  } catch (err) {
    return report({ server, phase: 'unreachable', message: describeRead(err, server) });
  }

  const missing = missingForBookForge(installedJobTypes, catalog);
  if (missing.length === 0) {
    return report({ server, phase: 'stocked', checkedAt: deps.now() });
  }

  if (remembered !== undefined) {
    // FAILS ONCE, BY NAME. The read still happened — the row is telling the
    // truth about what is missing — but the post that would be refused the
    // same way is not made again.
    return report({ server, phase: 'refused', code: remembered.code, message: remembered.message });
  }

  return prepare(server, missing, deps);
}

/** Post the module (or join the task already running) and follow it to the end. */
async function prepare(
  server: string,
  missing: readonly CrucibleMissingEntry[],
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
        const waiting = report({ server, phase: 'waiting', missing, holder, attempts, stopped });
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
    };
    report({ server, phase: 'preparing', missing, progress: progress0, followed });

    const last = await followModuleTask(server, taskId, (progress) => {
      report({ server, phase: 'preparing', missing, progress, followed });
    });
    return report({ server, phase: 'preparing', missing, progress: last, followed });
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
 * Coordinate with the server on this machine, if there is one.
 *
 * Called at app start. A machine with no local Crucible is the ordinary case
 * for a laptop that renders on the Mac, so "no local server" is silence rather
 * than a state: `local` never coordinated is `local` with nothing to say.
 */
export async function coordinateLocalOnStart(
  deps: CoordinateDeps = defaultDeps(),
): Promise<CrucibleCoordinationState | null> {
  if (!describeLocal().present) return null;
  return coordinateServer(LOCAL_SERVER_NAME, deps);
}
