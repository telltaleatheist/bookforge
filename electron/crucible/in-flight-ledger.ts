/**
 * WHAT THIS APP HAS RUNNING ON SOMEBODY ELSE'S CARD, WRITTEN DOWN BEFORE IT RUNS.
 *
 * ── The hole this fills ─────────────────────────────────────────────────────
 *
 * A Crucible job is not a process, so nothing this machine does to itself
 * reaches it. `cancelRemoteRenderOnQuit` (parallel-tts-bridge.ts) says so in its
 * own docstring and names the gap it could not close: *"Nothing persists
 * `session.crucibleJobId` either, so a relaunch cannot DELETE it — the app's own
 * handle, while the app still exists, is the only door there is."*
 *
 * On 2026-09-19 Owen hard-killed `electron:dev` with ctrl-C. `before-quit` never
 * ran (the log has no cleanup lines at all), so the handle died with the process
 * — and an hour later the Mac's Crucible still showed BookForge's `tts` job for
 * "mistborn" running at 70%, holding the card and 12 GB of resident voice for an
 * app that no longer existed. Nothing on this side knew that job's id any more,
 * so nothing could ever have cancelled it.
 *
 * This is the fact a hard kill must not lose: **one line per submitted job,
 * written to disk BEFORE the job can do anything, removed when it settles.**
 * `<userData>/crucible-in-flight.json`. The next launch reads it and finishes
 * what the quit never got to (`in-flight-sweep.ts`).
 *
 * ── Why it is written synchronously ─────────────────────────────────────────
 *
 * An async write racing a ctrl-C is exactly the loss this exists to prevent. The
 * file holds a handful of small objects, the write is temp-and-rename like every
 * other userData record here (servers.ts, derivation-cache.ts), and a submit
 * that blocks for a millisecond on a record of itself is the cheapest insurance
 * in this app.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *
 * It is not a queue, not a resume record and not a second source of truth about
 * what a job DID. It carries the four facts a cancel needs (which server, which
 * job, what type, which subject was on the card) plus the scratch this run owns,
 * and nothing else. A job's progress, its artifacts and its outcome are the
 * queue's business and stay there.
 *
 * ── Crucible unloads its own model ──────────────────────────────────────────
 *
 * Owen's ruling, 2026-09-14: *"Models should always be unloaded when we're done
 * with them. Every time."* Crucible's `Settlement` takes the model off the card
 * the moment nothing holds it — no job on the lane, no lease, no claim, no chat
 * in flight. So the point of cancelling from here is not to unload anything: it
 * is to stop HOLDING the card, after which the server unloads it itself. The
 * explicit `unload-*` in the sweep is only for the case where the card is still
 * held by a resident nobody claims.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** The record file, under `<userData>`. */
export const CRUCIBLE_IN_FLIGHT_FILE = 'crucible-in-flight.json';

/**
 * One Crucible job this app has submitted and not yet seen settle.
 *
 * `server` is a registry NAME, never a URL — the sweep resolves it through
 * `crucibleClientFor` exactly as the door that submitted it did, so a server
 * whose address changed is still reached, and one that was removed is a named
 * refusal rather than a call to a stale host.
 */
export interface CrucibleInFlightEntry {
  /** The registry entry's name (`electron/crucible/servers.ts`). */
  readonly server: string;
  /** Crucible's own job id — what `DELETE /v1/jobs/{id}` takes. */
  readonly jobId: string;
  /** The Crucible job type: `tts`, `align`, `rvc`, `denoise`, `asr`, … */
  readonly jobType: string;
  /**
   * The model or voice id this job named, or null for a job type that serves
   * none. It is what an `unload-*` would have to name, so it is recorded rather
   * than re-derived from a resident the sweep reads later.
   */
  readonly model: string | null;
  /**
   * THIS app's id for the work — a queue step id (`step_…`), a render id, or
   * whatever the calling door calls itself. Never Crucible's. It is what puts a
   * sweep's log line next to a row a person can see.
   */
  readonly localId: string;
  /**
   * Absolute scratch paths this run owns: the session directory it renders
   * into, the landing directory its input EPUB was written to. Recorded so a
   * sweep can say what a dead job left behind — NOT a licence to delete: every
   * removal still goes through the scratch sweep's rescue-first rule
   * (`electron/scratch-sweep.ts`), because an interrupted render's sentences are
   * the resume checkpoint.
   */
  readonly owns: readonly string[];
  /** ISO 8601, when this side submitted it. */
  readonly submittedAt: string;
  /**
   * THE HIGHEST EVENT ID THIS SIDE HAS ACTED ON — the resume point, 2026-09-20.
   *
   * `attachTo.lastEventId` is the server's own monotonic counter and the whole
   * mechanism behind a resume that does not re-render an hour of audio: the
   * server replays events above it and no further. It was DOCUMENTED and
   * persisted nowhere (bug hunt C4), so after the one event it exists for — a
   * hard kill — nothing on this side knew where the job had got to and the only
   * answer was to submit it again. An align or an asr has ONE artifact, so that
   * is the whole hour.
   *
   * Zero means "no frame has been acted on", which is also the honest value for
   * a row written by an older build: a resume from 0 replays the whole history,
   * which is correct and merely slower, never wrong.
   */
  readonly lastEventId: number;
}

/**
 * The ledger as read from text.
 *
 * A missing or unreadable file is an EMPTY ledger and never a throw: this
 * record's whole job is to make a hard kill survivable, and a corrupt one that
 * stopped the app from starting would be worse than the hole it fills. A row
 * missing any of its required fields is dropped by name — half a row cannot
 * cancel anything.
 */
export function parseInFlightLedger(
  text: string,
  onWarn: (line: string) => void = () => undefined,
): CrucibleInFlightEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    onWarn(`the crucible in-flight ledger does not parse (${(err as Error).message}); reading it as empty`);
    return [];
  }
  const rows = (raw as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(rows)) {
    onWarn('the crucible in-flight ledger has no "jobs" array; reading it as empty');
    return [];
  }
  const kept: CrucibleInFlightEntry[] = [];
  for (const row of rows) {
    const entry = row as Partial<CrucibleInFlightEntry> | null;
    if (typeof entry?.server !== 'string' || entry.server === ''
      || typeof entry.jobId !== 'string' || entry.jobId === ''
      || typeof entry.jobType !== 'string' || entry.jobType === '') {
      onWarn(`dropping a crucible in-flight row with no server/jobId/jobType: ${JSON.stringify(row)}`);
      continue;
    }
    kept.push({
      server: entry.server,
      jobId: entry.jobId,
      jobType: entry.jobType,
      model: typeof entry.model === 'string' ? entry.model : null,
      localId: typeof entry.localId === 'string' ? entry.localId : '',
      owns: Array.isArray(entry.owns) ? entry.owns.filter((p): p is string => typeof p === 'string') : [],
      submittedAt: typeof entry.submittedAt === 'string' ? entry.submittedAt : '',
      // A row from a build before 2026-09-20 has none. Zero is not a guess: it
      // is "replay the whole history", which is the correct resume for a job
      // this side cannot say it has seen any frame of.
      lastEventId: typeof entry.lastEventId === 'number' && Number.isFinite(entry.lastEventId)
        ? entry.lastEventId
        : 0,
    });
  }
  return kept;
}

/** The ledger as written. Pretty-printed: a person reads this file after a crash. */
export function serializeInFlightLedger(entries: readonly CrucibleInFlightEntry[]): string {
  return `${JSON.stringify({ jobs: entries }, null, 2)}\n`;
}

/**
 * `entries` with `entry` in it, replacing any row for the same server+jobId.
 *
 * PURE, and the pair (server, jobId) is the key: a job id is only unique on the
 * server that minted it, and two servers minting `job-1` is the ordinary case
 * (both fakes in the keeper do it).
 */
export function ledgerWith(
  entries: readonly CrucibleInFlightEntry[],
  entry: CrucibleInFlightEntry,
): CrucibleInFlightEntry[] {
  return [...entries.filter((row) => !sameJob(row, entry.server, entry.jobId)), entry];
}

/**
 * `entries` with the row for `server`+`jobId` moved on to `lastEventId`. PURE.
 *
 * Returns the SAME array reference when there is nothing to do — no row, or a
 * row already at or past that id — so the caller can skip the write without
 * comparing the contents. A frame counter only ever goes forward: a replay
 * after an attach re-delivers ids this side has already acted on, and taking
 * the smaller number would move the resume point BACKWARDS and re-render what
 * was already landed.
 */
export function ledgerNotingEvent(
  entries: readonly CrucibleInFlightEntry[],
  server: string,
  jobId: string,
  lastEventId: number,
): readonly CrucibleInFlightEntry[] {
  const row = entries.find((entry) => sameJob(entry, server, jobId));
  if (row === undefined || row.lastEventId >= lastEventId) return entries;
  return entries.map((entry) => (entry === row ? { ...entry, lastEventId } : entry));
}

/** `entries` without the row for `server`+`jobId`. PURE. */
export function ledgerWithout(
  entries: readonly CrucibleInFlightEntry[],
  server: string,
  jobId: string,
): CrucibleInFlightEntry[] {
  return entries.filter((row) => !sameJob(row, server, jobId));
}

function sameJob(row: CrucibleInFlightEntry, server: string, jobId: string): boolean {
  return row.server === server && row.jobId === jobId;
}

/**
 * `<userData>/crucible-in-flight.json`.
 *
 * Resolved through Electron's `app` at CALL time, not at import time, for
 * `registryPath`'s reason exactly: the headless CLI stub installs its `electron`
 * before the first call and after every import.
 */
export function inFlightLedgerPath(): string {
  return path.join(app.getPath('userData'), CRUCIBLE_IN_FLIGHT_FILE);
}

/** Every job this app believes it still has running somewhere. */
export function readInFlightLedger(): CrucibleInFlightEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(inFlightLedgerPath(), 'utf-8');
  } catch {
    return []; // No file is no jobs. The ordinary state.
  }
  return parseInFlightLedger(text, (line) => console.warn(`[CRUCIBLE] ${line}`));
}

/**
 * Write the ledger beside itself and rename onto it.
 *
 * Synchronous and atomic for the header's reason: the moment this returns, a
 * ctrl-C cannot lose the record, and no reader can ever see half a file.
 */
function writeInFlightLedger(entries: readonly CrucibleInFlightEntry[]): void {
  const file = inFlightLedgerPath();
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, serializeInFlightLedger(entries), 'utf-8');
    fs.renameSync(temp, file);
  } catch (err) {
    // Never fatal to the job being submitted: a render that cannot write its
    // own receipt is still a render the user asked for. Loud, because what it
    // costs is the next hard kill's cleanup.
    console.error(`[CRUCIBLE] could not write ${file}: ${(err as Error).message}. A hard kill `
      + 'will leave this job running on its server with nothing here to cancel it.');
  }
}

/**
 * Record a job as in flight. Called immediately after the server admits it, and
 * before the caller does anything else with it.
 */
export function recordInFlight(
  /**
   * `lastEventId` is optional HERE and required on the row: a fresh submit has
   * acted on no frame, and only an ATTACH arrives already knowing where it got
   * to. Defaulting it at the door means no caller writes `lastEventId: 0` to
   * say the obvious thing, and none can forget to carry a resume point it does
   * have.
   */
  entry: Omit<CrucibleInFlightEntry, 'lastEventId'> & { readonly lastEventId?: number },
): void {
  writeInFlightLedger(ledgerWith(
    readInFlightLedger(),
    { ...entry, lastEventId: entry.lastEventId ?? 0 },
  ));
}

/**
 * Move a live job's resume point forward as its frames arrive.
 *
 * WRITE-THROUGH, AND THAT IS AFFORDABLE. The file holds a handful of small
 * objects and the write is temp-and-rename, the same one `recordInFlight` does
 * on every submit; a 1,400-chunk render's few thousand frames cost well under a
 * second spread over hours of GPU time, against a main process that is
 * otherwise idle waiting on a socket. A batched write would be cheaper and
 * would lose exactly the frames a hard kill happens between, which is the one
 * moment this record exists for.
 *
 * A no-op when there is no row (the job settled a moment ago) or the id has not
 * moved, so a replayed frame costs no disk at all.
 */
export function noteInFlightEvent(server: string, jobId: string, lastEventId: number): void {
  const before = readInFlightLedger();
  const after = ledgerNotingEvent(before, server, jobId, lastEventId);
  if (after === before) return;
  writeInFlightLedger(after);
}

/**
 * Forget a job: it is done, failed, or cancelled.
 *
 * Idempotent — a door that settles the same job twice (a cancel followed by the
 * stream's own terminal frame) writes the same file twice and says nothing,
 * because "already gone" is the correct end state either way.
 */
export function settleInFlight(server: string, jobId: string): void {
  const before = readInFlightLedger();
  const after = ledgerWithout(before, server, jobId);
  if (after.length === before.length) return;
  writeInFlightLedger(after);
}
