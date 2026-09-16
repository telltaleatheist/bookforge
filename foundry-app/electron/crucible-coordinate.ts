/**
 * THE ONE OWNER OF "make sure this server has what Foundry needs".
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a. Owen, 2026-09-14: *"if its present,
 * bookforge should coordinate with the installed crucible to make sure it has
 * what it needs to run all of its features"* — and, on the whole install story,
 * *"this whole process needs to be idiot proof."* The ruling names BookForge
 * because BookForge asked first; it is about the APP. Foundry needs a text
 * engine and three models on whatever machine it is pointed at, and the two
 * apps' modules are a UNION on a shared server rather than a competition. So
 * there is no button here either. Every time Foundry finds a Crucible it
 * coordinates with it, and the row draws what happened.
 *
 * ── ASK, THEN ACT ──────────────────────────────────────────────────────────
 *
 * The amendment Foundry's own review produced (crucible `cecfdd0`) and the
 * reason it is not merely tidier:
 *
 *   1. READ `GET /v1/info`, `GET /v1/catalog` and `GET /v1/capability`. All
 *      three are cheap, read-only, and touch neither the lane nor the card.
 *   2. Compare the vendored module (`shared/foundry.module.json`) against them.
 *   3. Nothing missing → STOP. No task is posted at all.
 *   4. Something missing → post the module and follow its events.
 *
 * The third read is crucible `docs/PHASE15-HOST.md` §5.3a's (crucible
 * `e342fee`): the module's `needs` carry CAPABILITY CLASSES, unresolved, and the
 * engine's own capability record is the one place a class becomes an id. A class
 * that engine has disabled is NOT missing and NOT a refusal — it is UNMET, the
 * task still finishes `done`, and the row says "not on this engine".
 *
 * A module is idempotent (installed entries come back `skipped`), so posting
 * one on every connect would have been *correct* and still wrong: a Crucible
 * runs ONE task at a time, so a task whose whole content is `skipped` events is
 * a task the other app on this machine collides with (`task_busy`), and one
 * Foundry itself would be refused `server_busy` by its OWN lease while its own
 * translation is running. The cheapest correct thing and the cheapest thing are
 * the same thing here, which is why the read comes first.
 *
 * ── NOTHING TO PRESS, ON ANY SERVER ────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"lets make it as simple as possible."* Coordination is
 * automatic on every server this app is connected to, however long ago it was
 * registered (crucible `1a10cc8`). The one way to say "not that one" is the
 * ENABLE switch that already means it, which is why {@link coordinateServer}
 * refuses a disabled server by name rather than inventing a second opinion about
 * which servers count.
 *
 * THERE IS NO `local` CONSTANT IN THIS APP and none is introduced here. Owen's
 * ruling: *"it shouldnt be named 'local' anywhere. it might not be local. a
 * local crucible server shouldnt be treated any differently than a remote
 * crucible server."* So this module asks every enabled server the same question
 * in the same way, and {@link coordinateEveryServer} takes them IN THE
 * REGISTRY'S ORDER — the operator's own drag rank — rather than putting an
 * address at the front of the queue.
 *
 * ── THE FOUR THINGS THAT CAN COME BACK, AND WHY EACH IS ITS OWN ACT ────────
 *
 * - **`task_busy`** — a task is already running on that server. It is FOLLOWED,
 *   never re-posted: there is no queue for tasks (PHASE13 §3.3), so a second
 *   post is simply refused again, and joining the stream of the one in flight
 *   is the only way to end up drawing the truth.
 * - **`server_busy`** — a lease, a job, the claim or a chat holds the card. A
 *   WAIT, with the holder shown verbatim, and a retry when the card settles.
 *   The shape is the queue's admission hold: a named sentence about a named
 *   machine, never a silent stall, and never a tight poll — the settle check is
 *   one `GET /v1/activity` on a slow cadence, reading the server's OWN
 *   composition of "nobody holds the card"
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
 * Three moments call this (app start for every enabled server, a server added,
 * a server re-enabled or newly named by a registry save) and two of them can
 * happen inside a second of each other — `crucible:add` runs the start sweep's
 * server again the moment somebody presses the wizard's button. {@link inFlight}
 * is what makes the second one join the first instead of racing it into the
 * `task_busy` this whole design exists to avoid.
 *
 * ── AND NOT ONE LOG LINE CARRIES A TOKEN ───────────────────────────────────
 *
 * Nothing in this file reads `entry.token` except `engineClientFor`, which is
 * where the registry already says the token meets the SDK. Every sentence
 * composed here names a server, a code or the server's own message, and a
 * server's own message is the SDK's — see `crucible-registry.ts`'s header for
 * the rule this keeps.
 */
import {
  CrucibleAuthError,
  CrucibleCapabilityUndecided,
  CrucibleCardHeld,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleUnreachable,
  CrucibleVersionError,
  type CatalogRow,
  type CrucibleModule,
} from '@crucible/client';

import {
  CrucibleOrchestratorError,
  crucibleServerNamed,
  crucibleServers,
  engineClientFor,
} from './crucible-registry';
import { readCapability } from './crucible-dispatch';
import type { CapabilityRecord } from '../shared/engine-settings';
import type {
  CrucibleCoordinationMap,
  CrucibleCoordinationState,
  CrucibleMissingEntry,
  CrucibleModuleProgress,
  CrucibleUnmetClass,
} from '../shared/coordinate-wire';

/*
 * THE VENDORED FILE ITSELF, imported so tsc copies it into dist and there is
 * exactly one of it. Read as the SDK's own `CrucibleModule` — the server's
 * snake_case spelling, not a camelCased mirror — because posting the module
 * means posting exactly those bytes. It is GENERATED in the crucible repo from
 * its manifests and vendored here byte for byte (PHASE13 §5.4); nothing in this
 * app edits it, and the ids in it are the manifests', not a second list.
 */
import { modelPreparationReady } from './setup';
import foundryModule from '../shared/foundry.module.json';

/** What Foundry asks a Crucible for. The generated file, unedited. */
type ScopedModule = Omit<CrucibleModule, 'job_types' | 'subjects'> & {
  job_types: readonly (CrucibleModule['job_types'][number] & { backends?: readonly string[] })[];
  subjects: readonly (CrucibleModule['subjects'][number] & { backends?: readonly string[] })[];
};
export const FOUNDRY_MODULE: ScopedModule = foundryModule as ScopedModule;

/** Generated backend annotations are app metadata, not fields in the task API. */
export function foundryModuleForBackend(backend: string, source: ScopedModule = FOUNDRY_MODULE): CrucibleModule {
  const supported = (entry: { backends?: readonly string[] }) => entry.backends === undefined || entry.backends.includes(backend);
  return {
    name: source.name, version: source.version, needs: source.needs,
    job_types: source.job_types.filter(supported).map(entry => ({
      type: entry.type, ...(entry.narrator_engine === undefined ? {} : { narrator_engine: entry.narrator_engine }),
    })),
    subjects: source.subjects.filter(supported).map(entry => ({ kind: entry.kind, id: entry.id })),
  };
}

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

/**
 * Watch every state change, for the main process that forwards them to windows.
 *
 * THE LISTENER IS IPC'S, NOT THIS MODULE'S. `electron/ipc.ts` is where the push
 * is made and where `afterRegistryChanged()` is called when a preparation
 * lands, because both of those are facts about the APP — which windows exist,
 * what a finished install does to the tiles — and this module's whole subject is
 * one conversation with one server. A `broadcast` from in here would make this
 * file the second owner of both.
 */
export function onCoordination(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(state: CrucibleCoordinationState): void {
  states.set(state.server, state);
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      /*
       * A LISTENER THAT THROWS MUST NOT UNWIND THE RUN. This publish happens
       * between a post and the stream that follows it; a throw from a dead
       * window's push would abandon a task that is already running on somebody
       * else's machine. `window.ts`'s `broadcast` makes the same argument from
       * the other side.
       */
      console.error(
        '[crucible] a coordination listener threw and the run carried on: '
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison — the whole of "does this server have what Foundry needs"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the module asks for that this server has not got, and what it will never
 * have.
 *
 * PURE, over the three reads, so that the thing that decides whether to post a
 * task and the thing that says what is being prepared are one function rather
 * than two that can come to disagree.
 *
 * ── THE MODULE NAMES CLASSES NOW, AND THE CLASSES ARE RESOLVED HERE ────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a (crucible `e342fee`; the ruling was
 * found by this app's own measurement against the Mac). `foundry.module.json`
 * used to carry `qwen3.8-27b-4bit` and `dots-ocr` as resolved ids, because
 * `gen-modules.py` turned a class into ONE id at generation time — the
 * cuda-linux answer — and then said `dots-ocr` to a Mac that has no block for it
 * and `qwen3.8-27b-4bit` to a Mac whose capability had selected `qwen3.8-27b`.
 * The generator was a second owner of a decision that is the SERVER's. So the
 * module now carries `needs: [{class}]` unresolved, and this function asks the
 * engine's own capability record what each class means ON THAT MACHINE before it
 * looks in that machine's catalog.
 *
 * Per class, and each arm is a different kind of news:
 *
 *   * **No row for it at all** — that engine's capability record has never heard
 *     of the class. UNMET, with the absence itself as the reason: it is the only
 *     one of these sentences this app composes, because there is no row to quote.
 *   * **`enabled: false`** — UNMET, carrying the row's own `reason` verbatim.
 *     *"A class this backend has DISABLED is not a refusal"* (§5.3a): the module
 *     is still posted for everything else, the task still finishes `done`, and
 *     the row says "not on this engine".
 *   * **Enabled, routed UPSTREAM** — nothing to pull and nothing missing. The
 *     work runs on the operator's account at Anthropic, OpenAI or an Ollama
 *     (§3.3), and there are no weights on that machine to be short of. `route`
 *     is the field that says so and `selected` carrying a slash is the same fact
 *     said twice (§1: *"a local model id never contains `/`"*); both are read,
 *     because a pre-phase-15 document has no `route` and a routed one always
 *     has the slash, and the cost of agreeing with ourselves is one `includes`.
 *   * **Enabled, local, nothing selected** — the engine decided it can serve the
 *     class and then found nothing that fits. UNMET: there is no id to look up,
 *     and a catalog search for `""` would report the empty string as a missing
 *     download.
 *   * **Enabled, local, with a selection** — `selected` IS the subject id, and
 *     the class is missing exactly when that machine's catalog says it is not
 *     installed. The catalog row's `name`, `kind` and `expectedBytes` travel
 *     with it, as they always have; `kind` is the catalog's word, `model` on
 *     every backend. Native Windows also needs the separate `llama-cpp` engine
 *     subject, even when the selected model weights are already installed.
 *
 * **Job types are compared on the TYPE alone**, not on the narrator engine, and
 * that is the server's own rule rather than a shortcut: a `module`'s install
 * entry is skipped when the job type is installed (PHASE13 §3.3), and
 * `/v1/info`'s `capabilities[].jobType` is the list PHASE13 §3.2 names as the
 * one a client compares against. A second opinion here — "installed, but with
 * the wrong engine" — would be this app deciding something the server decides.
 *
 * **Explicit `subjects` keep the comparison they always had.** §5.3a keeps them
 * for *"genuine app choices"* — a voice, a whisper size — and the asymmetry is
 * the point: a class is "give me whatever serves this", which a machine may
 * answer "nothing here does"; an id is "give me this one", which it may not, so
 * an explicit id a backend cannot hold is still `unknown_subject` and still
 * refuses the whole module. Foundry's module lists none today.
 */
export function missingForFoundry(
  installedJobTypes: readonly string[],
  catalog: readonly CatalogRow[],
  capability: CapabilityRecord,
): { missing: CrucibleMissingEntry[]; unmet: CrucibleUnmetClass[] } {
  const missing: CrucibleMissingEntry[] = [];
  const unmet: CrucibleUnmetClass[] = [];
  const localJobTypes = new Set<string>();
  const module = foundryModuleForBackend(capability.backendKind);

  for (const entry of module.job_types) {
    if (installedJobTypes.includes(entry.type)) continue;
    missing.push({
      what: 'job-type',
      jobType: entry.type,
      narratorEngine: entry.narrator_engine === undefined ? null : entry.narrator_engine,
    });
  }

  for (const need of module.needs) {
    const row = capability.classes.find((item) => item.capability === need.class);
    if (row === undefined) {
      unmet.push({
        class: need.class,
        /*
         * NO FULL STOP, because every other reason on this type is a capability
         * row's own `reason` and those are clauses rather than sentences — the
         * words join several of them into one line, and one of them ending early
         * would read as the line ending early.
         */
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
    if (subject !== undefined) localJobTypes.add(subject.jobType);
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

  // A model's weights and the executable that serves them are separate catalog
  // subjects. Restoring weights after reinstalling Crucible must still restore
  // the native engine, even when /info already advertises the llm job type.
  for (const engine of catalog) {
    if (engine.kind !== 'engine' || engine.installed || !localJobTypes.has(engine.jobType)) continue;
    missing.push({
      what: 'subject', kind: engine.kind, id: engine.id, name: engine.name,
      jobType: engine.jobType, expectedBytes: engine.expectedBytes, inCatalog: true,
    });
  }

  for (const subject of module.subjects) {
    const row = catalog.find((item) => item.kind === subject.kind && item.id === subject.id);
    if (row !== undefined && row.installed) continue;
    if (missing.some(item => item.what === 'subject' && item.kind === subject.kind && item.id === subject.id)) continue;
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
 * Make sure one server has what Foundry needs, and say where that got to.
 *
 * Idempotent, concurrent-safe, and cheap when there is nothing to do. It never
 * throws: every way this can end is a STATE, because every caller of it is a
 * moment that was doing something else (starting the app, adding a server) and
 * a Crucible that is off must not fail any of them.
 */
export function coordinateServer(server: string): Promise<CrucibleCoordinationState> {
  const running = inFlight.get(server);
  if (running !== undefined) return running;

  const run = runCoordination(server).finally(() => { inFlight.delete(server); });
  inFlight.set(server, run);
  return run;
}

/**
 * Coordinate with every ENABLED server, IN THE REGISTRY'S OWN ORDER.
 *
 * App start's moment.
 *
 * ── THE ORDER IS THE OPERATOR'S, AND THIS APP HAS NO OTHER ─────────────────
 *
 * It used to start the loopback entries first, on the reasoning that a Crucible
 * on this machine is the one that took the local GPU slot and so the one this
 * app is about to want. Owen's ruling retires that reasoning: *"a local crucible
 * server shouldnt be treated any differently than a remote crucible server. it
 * should all be entered the exact same way… it might not be local."* An address
 * is not a ranking, and `127.0.0.1` is exactly as likely to be a tunnel to
 * somebody else's card as it is to be the machine this window is drawn on.
 *
 * The registry IS a ranking, and the only one this app is entitled to: the rows
 * are in the order the person dragged them into, which is the same order
 * `computeSlots` hands to the picker and the same order the `any` walk takes
 * them in. So a sweep that asked in any other order would be this app inventing
 * a second opinion about which server matters most.
 *
 * STARTED IN ORDER, NOT AWAITED IN ORDER. A run can end in a half-hour WAIT on
 * a held card, and a sweep that awaited each server in turn would leave the
 * Mac unasked until the PC's chat finished. The synchronous prefix of
 * {@link coordinateServer} runs before its first `await`, so iterating really
 * does put the top row's `GET /v1/info` on the wire first; after that they
 * proceed together.
 *
 * A DISABLED SERVER IS NOT ASKED AT ALL and not reported either: filtering here
 * rather than letting each run refuse itself means a registry of six switched-off
 * servers produces no rows instead of six sentences saying nothing happened.
 */
export function coordinateEveryServer(): Promise<CrucibleCoordinationState[]> {
  const enabled = crucibleServers().filter((entry) => entry.enabled);
  return Promise.all(enabled.map((entry) => coordinateServer(entry.name)));
}

async function runCoordination(server: string): Promise<CrucibleCoordinationState> {
  if (!modelPreparationReady()) return report({ server, phase: 'awaiting-setup' });
  const entry = crucibleServerNamed(server);
  if (entry === null) {
    /*
     * A NAME THE REGISTRY HAS NEVER HEARD OF. Filed under `unreachable` for the
     * reason the disabled case below is: that phase means "Foundry did not
     * reach it, and here is why", and the message is the fact. It is the same
     * sentence `probeCrucible` answers with, because it is the same news.
     */
    return report({
      server,
      phase: 'unreachable',
      message: `There is no server called "${server}".`,
    });
  }
  if (!entry.enabled) {
    /*
     * A DISABLED SERVER IS NOT COORDINATED WITH, and it is not an error either.
     * Owen's ruling makes the enable switch the one way to say "not that one"
     * (crucible `1a10cc8`), so this says exactly that and asks the machine
     * nothing.
     */
    return report({
      server,
      phase: 'unreachable',
      message: `"${server}" is switched off in Settings, so Foundry asks it for nothing.`,
    });
  }

  const remembered = requestRefusals.get(server);
  report({ server, phase: 'checking' });

  let installedJobTypes: readonly string[];
  let catalog: readonly CatalogRow[];
  let capability: CapabilityRecord;
  try {
    /*
     * THROUGH THE ENGINE, NOT WHATEVER ADDRESS IS REGISTERED. crucible
     * docs/PHASE17-ORCHESTRATOR.md §6: a registered address may be an
     * orchestrator, and every one of the three reads below is an engine
     * question — an orchestrator's `job_types` is `[]` by definition (§3.2), it
     * has no catalog and no `/v1/capability`, and the module this file posts
     * installs weights onto a CARD. Coordinating with the orchestrator would
     * report every class as missing on a machine that serves all of them.
     */
    const client = await engineClientFor(entry);
    /*
     * THREE READS, AND THE THIRD IS §5.3a's.
     *
     * `GET /v1/capability` is read here because the module names CLASSES and the
     * engine's capability record is the one place a class becomes an id
     * (PHASE9; PHASE15-HOST.md §5.3a). Without it there is no question to ask
     * the catalog: "is the translate model installed" has a different answer on
     * every machine, and the id is that machine's to name.
     *
     * IT IS `readCapability`, THE DISPATCHER'S OWN READER, and not a fourth
     * `client.capability()` call written here. One reader of that route, one
     * mapping of its record, one place a route rule could ever have lived —
     * the dispatcher's header says why, and the placement path and this one
     * must not be able to disagree about what a server selected.
     *
     * A capability read that fails is the same `unreachable` as the other two:
     * a server that cannot answer one of these three is not answering.
     */
    const [info, rows, record] = await Promise.all([
      client.info(),
      client.catalog(),
      readCapability(entry),
    ]);
    installedJobTypes = info.capabilities.map((item) => item.jobType);
    catalog = rows;
    capability = record;
  } catch (err) {
    return report({ server, phase: 'unreachable', message: describeRead(err, server) });
  }

  const { missing, unmet } = missingForFoundry(installedJobTypes, catalog, capability);
  if (missing.length === 0) {
    /*
     * STOCKED STILL MEANS "NOTHING IS MISSING", and an engine with unmet classes
     * and nothing to download is exactly that. There is no task that could make
     * it serve `pages`, so posting one would be asking a machine to download its
     * way out of being a different machine; the classes it does not serve travel
     * on the state instead, and the row names them (§5.3a: *"the app shows 'not
     * on this engine'"*).
     */
    return report({ server, phase: 'stocked', checkedAt: new Date().toISOString(), unmet });
  }

  if (remembered !== undefined) {
    // FAILS ONCE, BY NAME. The read still happened — the row is telling the
    // truth about what is missing — but the post that would be refused the
    // same way is not made again.
    return report({ server, phase: 'refused', code: remembered.code, message: remembered.message });
  }

  return prepare(server, missing, unmet);
}

/** Post the module (or join the task already running) and follow it to the end. */
async function prepare(
  server: string,
  missing: readonly CrucibleMissingEntry[],
  unmet: readonly CrucibleUnmetClass[],
): Promise<CrucibleCoordinationState> {
  let attempts = 0;

  // The wait loop. Every turn of it is one POST attempt; a `server_busy` turns
  // into one slow settle check, never a tight poll.
  for (;;) {
    let taskId: string;
    let followed = false;
    try {
      taskId = await postFoundryModule(server);
    } catch (err) {
      if (err instanceof CrucibleCardHeld) {
        attempts += 1;
        const holder = { fact: err.fact, who: err.who };
        const stopped = attempts >= SETTLE_POLL_ATTEMPTS;
        const waiting = report({
          server, phase: 'waiting', missing, unmet, holder, attempts, stopped,
        });
        if (stopped) return waiting;
        await waitForSettle(server);
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
          return runCoordination(server);
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
      step: null, line: null, bytes: null, skipped: null, jobTypes: null, error: null, unmet: null,
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
async function waitForSettle(server: string): Promise<void> {
  await sleep(SETTLE_POLL_MS);
  try {
    const entry = crucibleServerNamed(server);
    if (entry === null) return;
    const client = await engineClientFor(entry);
    for (;;) {
      const activity = await client.activity();
      if (activity.slots.accelerated.acceptsWork) return;
      await sleep(SETTLE_POLL_MS);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The id of whatever task is running on this server, or null. */
async function runningTaskId(server: string): Promise<string | null> {
  const entry = crucibleServerNamed(server);
  if (entry === null) return null;
  const tasks = await (await engineClientFor(entry)).tasks();
  const running = tasks.find((task) => task.state === 'running');
  return running === undefined ? null : running.taskId;
}

/**
 * Why a read did not happen, in the SDK's own words with the server named.
 *
 * Each of these is a different fix — nothing there, something else there, the
 * wrong token, the wrong API — and flattening them would be the thing
 * `probeEntry`'s named catch exists to prevent, one module along.
 */
function describeRead(err: unknown, server: string): string {
  if (err instanceof CrucibleUnreachable) return `"${server}" did not answer: ${err.message}`;
  if (err instanceof CrucibleNotACrucible) return `"${server}" answered, but it is not a Crucible: ${err.message}`;
  if (err instanceof CrucibleAuthError) return `"${server}" refused this machine's token: ${err.message}`;
  if (err instanceof CrucibleVersionError) return `"${server}" speaks a different API version: ${err.message}`;
  if (err instanceof CrucibleRefused) return `"${server}" refused ${err.code}: ${err.message}`;
  /*
   * THE TWO THE CAPABILITY READ ADDED, each named rather than flattened into the
   * sentence below. `capability_undecided` is a thing somebody can go and fix
   * with one command, and a protocol error is a document defect on that machine
   * — neither is "it did not answer", and neither is a fault of Foundry's.
   */
  if (err instanceof CrucibleCapabilityUndecided) {
    return `"${server}" has not measured its card yet — run \`crucible capability --write\` there.`;
  }
  if (err instanceof CrucibleProtocolError) {
    return `"${server}" answered with a document this build cannot read: ${err.detail}`;
  }
  /*
   * PHASE17 §6's two, named rather than flattened for this function's own
   * reason: an orchestrator with no engine is not "it did not answer" — it
   * answered perfectly, about a machine with nothing on it — and the fix is a
   * button on that machine's console rather than anything to do with a token or
   * a network.
   */
  if (err instanceof CrucibleOrchestratorError) return `"${server}": ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function report(state: CrucibleCoordinationState): CrucibleCoordinationState {
  publish(state);
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two mechanical halves: posting the module, and following a module task
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post the module. Answers the task id; THROWS every refusal untranslated.
 *
 * The refusal is not described here on purpose: {@link prepare} discriminates
 * `server_busy` (a wait), `task_busy` (follow the other one) and a refusal
 * about the request (fail once by name), and each of those is a different act.
 * A function that flattened all three into an `Error` would force the caller to
 * read the sentence back out of it.
 */
async function postFoundryModule(server: string): Promise<string> {
  const entry = crucibleServerNamed(server);
  if (entry === null) throw new Error(`There is no server called "${server}".`);
  const client = await engineClientFor(entry);
  const capability = await client.capability();
  return client.submitTask({ type: 'module', module: foundryModuleForBackend(capability.backendKind) });
}

/**
 * Follow a module task to its end, one frame per event.
 *
 * Resolves when the task reaches a terminal state, with the state it reached —
 * it does NOT throw on `failed`. A failed module is a thing a screen draws (the
 * step that failed, the code, the message), not an exception it has to
 * reconstruct one from.
 *
 * The task id may be ours or somebody else's: a Crucible runs one task at a
 * time, so the module we would have posted and the task already running are
 * competing for the same slot, and joining the stream of the one in progress is
 * strictly better than queueing a second (PHASE13 §3.3 has no queue for tasks).
 *
 * ── AND ONE READ AFTER THE STREAM, FOR `unmet` ─────────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a puts the classes this engine does not
 * serve on the TASK DOCUMENT (`TaskStatus.unmet`) and on no frame of its stream,
 * so it cannot be taken off the terminal event — `done`'s data is an open record
 * and the SDK types it as one. `GET /v1/tasks/{id}` once, after the last frame,
 * is the whole cost, and it is the server's own answer rather than the
 * prediction this app made from the same capability record a moment earlier.
 *
 * IT DOES NOT FAIL THE FOLLOW. A task that ran to `done` and then could not be
 * re-read is a task that ran to `done`; turning that into a failure would report
 * a successful install as broken because a laptop lid closed a second later.
 * `unmet` stays null in that case, which is exactly what it means — nobody said.
 */
async function followModuleTask(
  server: string,
  taskId: string,
  onProgress: (progress: CrucibleModuleProgress) => void,
): Promise<CrucibleModuleProgress> {
  let last: CrucibleModuleProgress = {
    server,
    taskId,
    state: 'running',
    step: null,
    line: null,
    bytes: null,
    skipped: null,
    jobTypes: null,
    error: null,
    unmet: null,
  };
  onProgress(last);

  const entry = crucibleServerNamed(server);
  if (entry === null) return last;

  for await (const event of (await engineClientFor(entry)).taskEvents(taskId)) {
    switch (event.event) {
      case 'started':
        last = { ...last, state: 'running' };
        break;
      case 'step':
        last = {
          ...last,
          state: 'running',
          step: { name: event.data.name, index: event.data.index, total: event.data.total },
          // The `reload` step carries what became reachable, so a client is TOLD
          // rather than having to diff two /v1/info reads (§3.4).
          jobTypes: event.data.jobTypes === undefined ? last.jobTypes : [...event.data.jobTypes],
          line: null,
          bytes: null,
          skipped: null,
        };
        break;
      case 'progress':
        // An install's line is pip's own text and is NOT load-bearing (R4); a
        // pull's counts are. They are separate fields for that reason, rather
        // than one "message" a row would have to guess the meaning of.
        last = 'line' in event.data
          ? { ...last, line: event.data.line, bytes: null }
          : {
              ...last,
              line: null,
              bytes: {
                done: event.data.bytesDone,
                total: event.data.bytesTotal,
                file: event.data.file,
              },
            };
        break;
      case 'skipped':
        last = { ...last, skipped: event.data.reason };
        break;
      case 'done':
        last = { ...last, state: 'done', line: null, bytes: null, error: null };
        break;
      case 'failed':
        // R6: the steps that completed STAY — the envs and the weights are on
        // disk. The row says which step, and the next connect skips everything
        // that is already true.
        last = {
          ...last,
          state: 'failed',
          error: { code: event.data.code, message: event.data.message },
        };
        break;
      case 'cancelled':
        last = { ...last, state: 'cancelled' };
        break;
      default:
        // An event kind this build has never heard of. The SDK yields it rather
        // than throwing, for the reason it says: losing the whole stream over
        // one frame is worse than ignoring the frame.
        break;
    }
    onProgress(last);
  }

  try {
    const status = await (await engineClientFor(entry)).task(taskId);
    last = {
      ...last,
      unmet: status.unmet.map((need) => ({ class: need.class, reason: need.reason })),
    };
    onProgress(last);
  } catch (err) {
    /*
     * SWALLOWED, AND `unmet` STAYS NULL. See the note above: the stream already
     * said what happened to the work, and a re-read that did not land is a
     * question nobody answered rather than a task that went wrong. Nothing is
     * logged with the error's message in it, for this file's own rule about what
     * an authenticated route may echo.
     */
    void err;
  }
  return last;
}
