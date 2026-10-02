/**
 * THIS APP'S TURN HOLDING A CRUCIBLE — a queue SESSION around a run of requests.
 *
 * ── What changed (Crucible 1.0.76, Oct 1 2026) ──────────────────────────────
 *
 * Leases are GONE from the server and from the SDK (`POST /v1/models/{id}/lease`,
 * the heartbeat, the ttl, `409 leased`). Owen: *"we might be able to get rid of
 * leases if we have the queue"*, then *"we dont need to worry about legacy
 * anything"*. Their replacement is the QUEUE SESSION (crucible docs/QUEUE.md,
 * docs/internals/queue-sessions.md, sdk/ts/MIGRATION.md):
 *
 *  - `client.session({act, model?, idleS?, maxWaitS?, onQueue?, signal?})` asks
 *    for the machine and WAITS IN THE SERVER'S LINE for it — first come, first
 *    served, no priority. It resolves once the session is open with `model`
 *    resident (the server loads it for the session; a lease never could).
 *  - While it is open NOTHING FROM ANY OTHER CLIENT RUNS. One session is open
 *    per server; others wait in line.
 *  - Every request from the client that holds it is an implicit ITEM of it —
 *    matched on the client NAME (`X-Crucible-Client`), header or not. That is
 *    why `CRUCIBLE_CLIENT_NAME` is per install (`bookforge@<host>`): two
 *    BookForges sharing one name would ride each other's sessions.
 *  - Liveness is `idleS` alone (default 300): anything in flight counts, and
 *    `touch()` covers a gap on this side. No heartbeat, no ttl, no maximum hold.
 *  - A second `session()` from the same client while its first is open WAITS
 *    behind it (crucible-pc-1, Oct 1 2026). So one session per install per
 *    server: two rows of this app bound for one machine take turns.
 *
 * The module keeps its old name and its seam (`withCrucibleLease`,
 * `crucibleLeaseSeam`) because every door and the scheduler already speak it;
 * what it HOLDS is a session now, and every sentence it says says so.
 *
 * ── Who opens one ───────────────────────────────────────────────────────────
 *
 * The rule is unchanged: *does this door's work reach the server as a SEQUENCE
 * of requests that must not have someone else's work between them?*
 *
 *   SESSION — the four text acts (`text-venue.ts`), the `crucible` AI provider's
 *             cleanup run (`ai-bridge.ts`), the page read (`pages.ts`): hundreds
 *             or thousands of chats against one resident model. And `denoise.ts`:
 *             ~44 `denoise` jobs against one resident separator.
 *   NOT YET   — the narration chain (render → align → denoise → rvc) is not one
 *             session; each GPU job waits in the server's line on its own and
 *             the book's GPU hold is BookForge-side (`gpuHoldOf`). Making a book
 *             one session is the next step of this migration, not this one.
 *   NEVER     — `stream.ts`: a TTS stream runs inside a session the SERVER opens
 *             for it (idle 900 s) when this client holds none.
 *
 * **A SESSION IS OPENED AROUND A RUN, NEVER AROUND ONE REQUEST**, and a queue ROW
 * of acts is one run: the scheduler runs every step inside a ROW SCOPE and the
 * session is handed to it instead of being closed (ONE SESSION PER ROW below).
 *
 * ── Presence ────────────────────────────────────────────────────────────────
 *
 * The server closes an open session after `idleS` with nothing in flight, no item
 * and no touch. A run's own requests are activity, but a run has gaps the server
 * cannot see (a diff written to the NAS, a chapter assembled, the scheduler
 * between two acts of one row). So a held session is TOUCHED every
 * {@link CRUCIBLE_SESSION_TOUCH_MS} for as long as this process holds it — the
 * lease heartbeat's job, minus its failure modes: a touch is a timestamp in
 * server memory, and a session the server has ended answers
 * {@link CrucibleSessionClosed}, which ends the touching and drops the handle.
 * A process that is killed stops touching, and `idleS` hands the machine on
 * within five minutes. What gives a session back on purpose is a door — see
 * {@link withRowLease}.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  CrucibleBusy,
  CrucibleRefused,
  CrucibleSessionClosed,
  CrucibleSessionHeld,
  CrucibleUnreachable,
  type CrucibleSession,
  type QueuePosition,
} from '@crucible/client';
import {
  CRUCIBLE_BATCH_QUEUE,
  crucibleQueuedLine,
  crucibleRemovalDisposition,
  crucibleRemovedLine,
} from '../../shared/crucible/server-queue';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';

// ─────────────────────────────────────────────────────────────────────────────
// The numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long the server keeps an open session with nothing happening: the server's
 * own default, stated so a reader does not have to look it up. LIVENESS, NOT
 * DURATION — a day-long run never idles out, because its work is activity and
 * this process touches it ({@link CRUCIBLE_SESSION_TOUCH_MS}).
 */
export const CRUCIBLE_SESSION_IDLE_S = 300;

/**
 * How often a held session is touched: a fifth of the idle window, so four
 * touches in a row can be lost to weather before the machine is handed on.
 */
export const CRUCIBLE_SESSION_TOUCH_MS = 60_000;

/**
 * How long a session may wait in the server's line to open: the batch day, for
 * the reason {@link CRUCIBLE_BATCH_QUEUE} gives — a book behind another
 * client's eight-hour render keeps its place. `expired` past it is weather.
 */
export const CRUCIBLE_SESSION_MAX_WAIT_S = CRUCIBLE_BATCH_QUEUE.maxWaitS;

// ─────────────────────────────────────────────────────────────────────────────
// The handle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT KIND OF RESIDENT THING the run is for — a fact for THIS side's log lines.
 * `model` opens the session with that model loaded (`model` on the wire); every
 * other kind opens it bare and lets the run's own first job make it resident.
 */
export type CrucibleLeaseKind = 'model' | 'separator';

/** An open session, for the log line and for the run that holds it. */
export interface CrucibleLease {
  /** The server's id for the SESSION (`ses-…`). */
  readonly id: string;
  /** The server it is on, by NAME — `local`, or a registry name. */
  readonly server: string;
  /** What kind of resident thing the run is for. */
  readonly kind: CrucibleLeaseKind;
  /** The id of that thing — the model the session opened with, or the separator. */
  readonly leased: string;
  /** The capability class it was opened for. */
  readonly act: string;
  /** True once the session has ended, by us or by the server. */
  readonly ended: boolean;
  /** Close the session and give the machine back. Idempotent; never throws. */
  release(): Promise<void>;
}

export interface CrucibleLeaseOptions {
  /** Names an entry in `<userData>/crucible-servers.json`, or the reserved `local`. Never a URL. */
  readonly server: string;
  /** Which resident kind the run is for — see {@link CrucibleLeaseKind}. */
  readonly kind: CrucibleLeaseKind;
  /** The model id (kind `model`, loaded for the session) or the separator id. */
  readonly id: string;
  /**
   * The capability class, named TRUTHFULLY: `clean`, `translate`, `simplify`,
   * `analysis`, `pages`, `denoise`. It goes on the server's queue and bench, so
   * a simplify that called itself a translate would be the lie Owen ruled out on
   * 2026-09-13. The vocabulary is the server's (`400 unknown_act`).
   */
  readonly act: string;
  /** Called with the session's place while it waits in the server's line. */
  readonly onQueue?: (line: string, position: QueuePosition) => void;
  /** Aborts the wait: a session still in the line leaves it. */
  readonly signal?: AbortSignal;
  /** OVERRIDES {@link CRUCIBLE_SESSION_TOUCH_MS}. Only a keeper passes this. */
  readonly touchMs?: number;
  /** Free text for the run's log. */
  readonly onLog?: (line: string) => void;
}

/** Every session this process currently holds. */
const openLeases = new Set<CrucibleLease>();

/** Armed on the first session, never on import — see {@link armQuitRelease}. */
let quitReleaseArmed = false;

/**
 * Close every open session when the app quits. A killed process cannot run
 * this; `idleS` is what hands the machine on then.
 */
function armQuitRelease(): void {
  if (quitReleaseArmed) return;
  quitReleaseArmed = true;
  if (process.versions.electron === undefined) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  app.on('before-quit', () => {
    void releaseAllCrucibleLeases();
  });
}

/** Close every session this process holds, and leave every line it waits in. */
export async function releaseAllCrucibleLeases(): Promise<void> {
  // The row map first, so a scope that outlives this call cannot hand a
  // closed session to a later act as if it were still open.
  rowLeases.clear();
  for (const waiting of rowWaits.values()) waiting.abort();
  rowWaits.clear();
  await Promise.all([...openLeases].map((lease) => lease.release()));
}

/**
 * Sessions this process closed, by id, for a few minutes: the server's activity
 * read may still be showing one while its close is in the air, and the queue's
 * card read must not take our own just-closed session for a stranger's.
 */
const closedSessions = new Map<string, { server: string; until: number }>();
const CLOSED_SESSION_MEMORY_MS = 5 * 60_000;

/**
 * EVERY SESSION ID ON `server` THAT IS THIS PROCESS'S: open ones, and closed
 * ones the server may still be reporting. What the queue's card read uses to
 * tell our own session from somebody else's (`card-shadow.ts`).
 */
export function ownCrucibleSessionIds(server: string): Set<string> {
  const now = Date.now();
  const ids = new Set<string>();
  for (const lease of openLeases) {
    if (lease.server === server) ids.add(lease.id);
  }
  for (const [id, entry] of closedSessions) {
    if (entry.until <= now) { closedSessions.delete(id); continue; }
    if (entry.server === server) ids.add(id);
  }
  return ids;
}

/** How many sessions are open right now — for a keeper, and for a log line. */
export function openCrucibleLeaseCount(): number {
  return openLeases.size;
}

/**
 * CLOSE A SESSION THIS PROCESS NEVER OPENED — the startup sweep's door, for the
 * hosted Foundry's session, which the vendored dispatcher opens in this same
 * process and a ctrl-C (no `before-quit`) leaves open. `foundry-job.ts` writes
 * its id into the in-flight ledger as a `foundry-session` row.
 *
 * `client.closeSession(id)` (SDK 1.0.77, `DELETE /v1/queue/sessions/{id}`) ends
 * it with reason `client` — our own cleanup, not an operator's removal. The
 * server lets only the client that OPENED a session close it this way
 * (`session_not_yours`), so the request goes out under the OWNER's name —
 * `foundry@<host>` for the hosted Foundry's, which is this install's too. A
 * session the server no longer knows is the state a close wanted.
 */
export async function closeCrucibleSessionById(
  server: string,
  sessionId: string,
  ownerName: string,
): Promise<{ outcome: 'released' | 'gone' | 'unreachable' | 'refused'; detail: string }> {
  let client;
  try {
    client = await crucibleClientFor(server, ownerName);
  } catch (err) {
    return { outcome: 'refused', detail: err instanceof Error ? err.message : String(err) };
  }
  try {
    await client.closeSession(sessionId);
    return { outcome: 'released', detail: `crucible "${server}" closed session ${sessionId}` };
  } catch (err) {
    if (err instanceof CrucibleUnreachable) {
      return { outcome: 'unreachable', detail: `nothing answered at ${err.url}` };
    }
    if (err instanceof CrucibleRefused && err.status === 404) {
      return { outcome: 'gone', detail: `crucible "${server}" no longer knows session ${sessionId}` };
    }
    return { outcome: 'refused', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * OPEN A SESSION: wait in the server's line for it, then keep it present.
 *
 * Refusals PROPAGATE. A session that never opened throws
 * {@link CrucibleSessionClosed} with its `reason` (`expired`, `operator`,
 * `load_failed`, `server_restart`, …); an aborted wait throws the abort.
 * Prefer {@link withCrucibleLease}, which cannot leak one.
 */
export async function takeCrucibleLease(options: CrucibleLeaseOptions): Promise<CrucibleLease> {
  const { server, kind, id: leased, act } = options;
  const log = options.onLog ?? ((line: string) => console.log(`[CRUCIBLE-SESSION] ${line}`));
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);

  let saidWaiting = false;
  const session: CrucibleSession = await client.session({
    act,
    ...(kind === 'model' ? { model: leased } : {}),
    idleS: CRUCIBLE_SESSION_IDLE_S,
    maxWaitS: CRUCIBLE_SESSION_MAX_WAIT_S,
    onQueue: (position) => {
      const line = crucibleQueuedLine(server, position.position, position.of);
      if (!saidWaiting) {
        saidWaiting = true;
        log(`crucible "${server}" is held by another run; this ${act} ${line}`);
      }
      options.onQueue?.(line, position);
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  log(`crucible "${server}" opened session ${session.id} for ${act}`
    + `${kind === 'model' ? ` with ${leased} resident` : ''} — nothing from another client runs `
    + 'there until it closes');

  let ended = false;
  const forget = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    openLeases.delete(lease);
    closedSessions.set(session.id, { server, until: Date.now() + CLOSED_SESSION_MEMORY_MS });
    for (const [row, held] of rowLeases) {
      if (held === lease) rowLeases.delete(row);
    }
  };

  /*
   * THE SERVER MAY END IT FIRST — idle, an operator, `max_hold`, a restart. The
   * handle is dropped the moment `closed` says so, so the row map never hands a
   * dead session to the next act; that act opens a new one and waits its turn.
   */
  void session.closed.then((end) => {
    if (ended) return;
    log(`crucible "${server}" ended session ${session.id} (${end.reason}): ${end.message}`);
    forget();
  });

  let touching = false;
  const timer = setInterval(() => {
    if (ended || touching) return;
    touching = true;
    session.touch()
      .catch((err: unknown) => {
        if (err instanceof CrucibleSessionClosed) {
          log(`crucible "${server}" session ${session.id} has ended (${err.reason}); `
            + 'the next act of this run opens a new one');
          forget();
          return;
        }
        // Weather: four touches fit in one idle window, and the run's own
        // requests are presence too.
        log(`a touch of session ${session.id} on crucible "${server}" failed: `
          + `${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => { touching = false; });
  }, options.touchMs ?? CRUCIBLE_SESSION_TOUCH_MS);
  // A touch must never be the reason a CLI process stays alive after its work.
  timer.unref?.();

  const lease: CrucibleLease = {
    id: session.id,
    server,
    kind,
    leased,
    act,
    get ended(): boolean { return ended; },
    async release(): Promise<void> {
      if (ended) return;
      forget();
      try {
        const end = await session.close();
        log(`crucible "${server}" closed session ${session.id} (${end.reason})`);
      } catch (err) {
        /*
         * The ONE swallow in this module: the run is over, and a close that did
         * not land is handed on by `idleS` within five minutes. Failing a
         * finished book because the tidying failed would report a loss that did
         * not happen.
         */
        log(`session ${session.id} on crucible "${server}" could not be closed (the server `
          + `ends it within ${CRUCIBLE_SESSION_IDLE_S}s): `
          + `${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
  openLeases.add(lease);
  armQuitRelease();
  return lease;
}

/**
 * RUN `run` INSIDE ONE SESSION, and close it on every way out. Inside a queue
 * row's scope the session is handed to the row instead ({@link withRowLease}).
 */
export async function withCrucibleLease<T>(
  options: CrucibleLeaseOptions,
  run: (lease: CrucibleLease) => Promise<T>,
): Promise<T> {
  const row = currentRow();
  if (row !== null) return withRowLease(row, options, run);
  const lease = await takeCrucibleLease(options);
  try {
    return await run(lease);
  } finally {
    await lease.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The refusals that are a WAIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ANOTHER CLIENT HOLDS THE MACHINE, OR THE LINE LET US GO — as the one shape the
 * scheduler reads (`busyLineOf` duck-types on `busyLine`, `removedLineOf` on
 * `removedLine`; queue-steps/runtime.ts).
 *
 *  - {@link CrucibleSessionHeld} / {@link CrucibleBusy}: a wait, by the holder's
 *    own line.
 *  - {@link CrucibleSessionClosed} for a session that never opened: by its
 *    reason, through the one removal policy (`crucibleRemovalDisposition`) —
 *    `expired` / `server_restart` are weather (wait and ask again), `client` is
 *    our own abort, anything else (an operator) removes the run from BookForge
 *    too (Owen, Sep 30 2026).
 *
 * Everything else is returned as it arrived: those refusals name a
 * misconfiguration (`load_failed`, `unknown_act`, an unknown model) and carry
 * their own repair. A `load_failed` is NOT a removal — nobody removed anything;
 * the model would not load — so it travels as the error it is.
 */
export class CrucibleSessionWait extends Error {
  readonly busyLine?: string;
  readonly removedLine?: string;

  constructor(message: string, line: { busyLine: string } | { removedLine: string }) {
    super(message);
    this.name = 'CrucibleSessionWait';
    if ('busyLine' in line) this.busyLine = line.busyLine;
    else this.removedLine = line.removedLine;
  }
}

export function asSessionWait(err: unknown, server: string, act: string): unknown {
  if (err instanceof CrucibleSessionHeld) {
    return new CrucibleSessionWait(
      `crucible "${server}" is held by another client's session, so this ${act} waits: ${err.heldLine}`,
      { busyLine: err.heldLine },
    );
  }
  if (err instanceof CrucibleBusy) {
    return new CrucibleSessionWait(
      `crucible "${server}" would not open a session for ${act}: ${err.busyLine}`,
      { busyLine: err.busyLine },
    );
  }
  if (err instanceof CrucibleSessionClosed && err.reason !== 'load_failed') {
    const line = crucibleRemovedLine(server, err.reason, err.message);
    switch (crucibleRemovalDisposition(err.reason)) {
      case 'weather':
      case 'ours':
        return new CrucibleSessionWait(line, { busyLine: line });
      case 'operator':
        return new CrucibleSessionWait(line, { removedLine: line });
    }
  }
  return err;
}

// ────────────────────────────────────────────────────────────────────────────
// ONE SESSION PER ROW
// ────────────────────────────────────────────────────────────────────────────
//
// A queue row that cleans a book and THEN simplifies it is two acts, and between
// them nothing of ours is on the server — so another client's session would take
// the machine and the second act would wait its whole line again, model reload
// included. The scheduler runs every step inside a ROW SCOPE named by the run's
// id (`queue-engine.ts`, `launch`); inside one, `withCrucibleLease` hands the
// session to the scope rather than closing it, and the scope keeps it until the
// SCHEDULER closes it — the moment the row has no next step that would use it
// (`closeCrucibleRowLease`).
//
// The scope is AMBIENT (`AsyncLocalStorage`), so every door is row-aware without
// threading a run id through six signatures, and a door called outside the
// queue (the CLI, Settings → AI) closes its own session in its own `finally`.
//
// A session can change model mid-way, so a later act of the row that wants a
// DIFFERENT model on the SAME server keeps the session and loads it as an item;
// only a different SERVER closes it. The session's act stays the act that
// OPENED it; what is running right now is `X-Crucible-Act`, per request.

const rowScope = new AsyncLocalStorage<string>();

function currentRow(): string | null {
  return rowScope.getStore() ?? null;
}

/** Sessions held on behalf of a ROW rather than of one act. */
const rowLeases = new Map<string, CrucibleLease>();

/**
 * A ROW'S SESSION THAT IS STILL WAITING IN THE LINE, by row: what
 * {@link closeCrucibleRowLease} aborts when the scheduler gives the row's turn
 * up (Remove, Stop, Pause) before the session opened.
 */
const rowWaits = new Map<string, AbortController>();

/** A close that has left but not landed, per row — the next take waits for it. */
const rowReleases = new Map<string, Promise<void>>();

/** Run one step inside its run's session scope. */
export function withCrucibleRowScope<T>(row: string, fn: () => Promise<T>): Promise<T> {
  return rowScope.run(row, fn);
}

/**
 * Give back the session a row was holding, or take its waiting session out of
 * the line. Idempotent; never throws.
 *
 * Owen, Oct 1 2026: **Pause closes the session** and Resume opens a new one at
 * the back of the line — a forgotten pause must not lock every other app off the
 * machine. `pause` in the scheduler is one of the doors that calls this.
 */
export async function closeCrucibleRowLease(row: string): Promise<void> {
  const waiting = rowWaits.get(row);
  if (waiting !== undefined) {
    rowWaits.delete(row);
    waiting.abort();
  }
  const lease = rowLeases.get(row);
  if (lease === undefined) return;
  rowLeases.delete(row);
  const going = lease.release().finally(() => {
    if (rowReleases.get(row) === going) rowReleases.delete(row);
  });
  rowReleases.set(row, going);
  await going;
}

/** For a keeper, and for a log line: is this row holding one? */
export function crucibleRowLease(row: string): CrucibleLease | null {
  return rowLeases.get(row) ?? null;
}

/**
 * OPEN THIS ROW'S SESSION BEFORE ITS STEP STARTS — admission's door (Owen,
 * 2026-09-19: *"It reserves the lease, THEN it takes the slot and starts real
 * work."*). It WAITS IN THE SERVER'S LINE: the scheduler leaves the step
 * `queued` with a "reserving" sentence while this is in the air, and `onWait`
 * puts the line position on the row. A refusal is reshaped by
 * {@link asSessionWait} so the scheduler parks, removes or holds by its own
 * rules.
 *
 * Which model: the SERVER's answer for the act (`crucibleActModel`, the one
 * owner), so the session opens with it resident.
 */
export async function reserveCrucibleRowLease(
  row: string,
  where: { server: string; act: string },
  onWait?: (line: string) => void,
): Promise<void> {
  // LAZY: text-venue imports this module and this needs text-venue's resolver.
  const { crucibleActModel } = await import('./text-venue.js');
  try {
    const model = await crucibleActModel({
      server: where.server,
      act: where.act as Parameters<typeof crucibleActModel>[0]['act'],
    });
    await withRowLease(
      row,
      {
        server: where.server,
        kind: 'model',
        id: model,
        act: where.act,
        ...(onWait === undefined ? {} : { onQueue: (line: string) => onWait(line) }),
      },
      async () => undefined,
    );
  } catch (err) {
    throw asSessionWait(err, where.server, where.act);
  }
}

/**
 * THE THREE CALLS THE SCHEDULER MAKES, composed once. `queue-engine.ts` takes
 * this seam injected (no Electron, no registry, no HTTP there); `queue-ipc.ts`
 * mounts it, and the suites drive it.
 */
export function crucibleLeaseSeam(): {
  withRowScope<T>(row: string, fn: () => Promise<T>): Promise<T>;
  reserveRow(row: string, where: { server: string; act: string }, onWait?: (line: string) => void): Promise<void>;
  closeRow(row: string): Promise<void>;
  leaseHeld(row: string): { server: string; act: string } | null;
} {
  return {
    withRowScope: withCrucibleRowScope,
    reserveRow: reserveCrucibleRowLease,
    closeRow: closeCrucibleRowLease,
    /*
     * WHAT this run is holding — the MACHINE and the CLASS that opened it — so
     * the scheduler can ask whether the next act wants the same machine
     * (`nextActWouldUseHeldCard`, queue-engine.ts).
     */
    leaseHeld: (row: string): { server: string; act: string } | null => {
      const held = crucibleRowLease(row);
      return held === null || held.ended ? null : { server: held.server, act: held.act };
    },
  };
}

async function withRowLease<T>(
  row: string,
  options: CrucibleLeaseOptions,
  run: (lease: CrucibleLease) => Promise<T>,
): Promise<T> {
  // The previous act's close may still be in the air; a second session from
  // this client would wait in line behind our own first one.
  const going = rowReleases.get(row);
  if (going !== undefined) await going;
  const held = rowLeases.get(row);
  if (held !== undefined && !held.ended) {
    if (held.server === options.server) {
      options.onLog?.(
        `[crucible] reusing this run's session at ${options.server} (opened for ${held.act}); `
        + `this act is ${options.act}, so nothing else runs there between them.`,
      );
      return run(held);
    }
    options.onLog?.(
      `[crucible] this run's session is at ${held.server}; this act wants ${options.server}, so `
      + 'the first is closed.',
    );
    rowLeases.delete(row);
    await held.release();
  }

  const waiting = new AbortController();
  const outer = options.signal;
  if (outer !== undefined) {
    if (outer.aborted) waiting.abort(outer.reason);
    else outer.addEventListener('abort', () => waiting.abort(outer.reason), { once: true });
  }
  rowWaits.set(row, waiting);
  let lease: CrucibleLease;
  try {
    lease = await takeCrucibleLease({ ...options, signal: waiting.signal });
  } catch (err) {
    if (waiting.signal.aborted && !(outer?.aborted ?? false)) {
      // The SCHEDULER gave this row's turn up while it waited (Remove, Stop,
      // Pause): our own leaving, never a failure of the row.
      throw new CrucibleSessionWait(
        `this run left crucible "${options.server}"'s line`,
        { busyLine: `left crucible "${options.server}"'s line` },
      );
    }
    throw err;
  } finally {
    if (rowWaits.get(row) === waiting) rowWaits.delete(row);
  }
  rowLeases.set(row, lease);
  /*
   * NO `finally` HERE, AND THAT IS THE WHOLE POINT: the session outlives this
   * act. What closes it are deliberate acts — the scheduler (`settleStep` with
   * nothing following, `cascadeCancel`, `remove`, `removeStep`, `pause`, all
   * through {@link closeCrucibleRowLease}), a later act on another server, the
   * app quitting, or the server ending it (idle, operator, restart), which
   * `takeCrucibleLease` drops from this map the moment it hears.
   */
  return run(lease);
}
