/**
 * A REMOTE RENDER'S AUDIO LANDS WHERE A LOCAL RENDER'S WOULD.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * A Crucible `tts` job produces one `<index>.flac` per rendered chunk and keeps
 * them on the server. There is **no shared mount between a Crucible host and its
 * client, ever** (DESIGN.md) — even a server on localhost hands its bytes over
 * HTTP — so somebody has to fetch them. Until this file only `cli/crucible.js`
 * on the unmerged `feat/crucible-cli-v3` branch could, which meant the app could
 * queue nothing remote: a finished render existed on somebody else's disk and
 * BookForge had no door to it.
 *
 * ── The destination is the app's, not the CLI's ─────────────────────────────
 *
 * Owen's standing rule is that the CLI mirrors the app's code path, never the
 * other way round, so this is worth stating plainly: **the CLI's `--render --out
 * <dir>` is an operator-named directory, and that is a door the app does not
 * have.** A local render does not choose where its audio goes. narrator's worker
 * is handed `--sentences_dir <processDir>/chapters/sentences` and writes
 * `<index>.flac` into it, and every consumer downstream — the resume scan, the
 * coverage audit, the RVC pass, the denoise pass, assembly's own
 * `--sentences_dir` — reads exactly that directory
 * (`ParallelPrepInfo.chaptersDirSentences`). So this door takes that directory
 * and nothing else. An operator who wants the CLI to put a remote render
 * somewhere the app can find should be pointed AT the session's sentences dir,
 * not given a second convention.
 *
 * It also does not create the directory. A local render's prep makes it; a path
 * that does not exist here is a caller that has not run prep, or a typo, and
 * `mkdir -p` on a typo produces an empty directory that looks like a render
 * which produced nothing.
 *
 * ── The download itself is the SDK's ────────────────────────────────────────
 *
 * `writeArtifactsTo` is not something the CLI invented — it is a method on
 * `CrucibleClient`, and it is the right one because of two properties this side
 * must not re-implement:
 *
 *  - it writes the provenance sidecar FIRST and then renames the FLAC into
 *    place, so `<index>.flac` only ever exists complete and only ever beside the
 *    record of which voice, which revision and which server made it. BookForge's
 *    resume test is "the file exists and exceeds 1024 bytes", which a
 *    half-written FLAC passes;
 *  - it fetches each artifact as its event lands, overlapped with the next chunk
 *    still generating, under a concurrency ceiling — because attaching to a
 *    nearly-finished 1,400-chunk render replays 1,400 artifact frames at once.
 *
 * ── And it feeds the guard ledger ───────────────────────────────────────────
 *
 * Every `chunk` event carries the engine's verdict about that chunk, and this is
 * the one place a remote render's verdicts can be caught. They go to
 * `electron/chunk-guard-ledger.ts` — THE sink, the same one the local path's
 * stdout guard events feed — so there is one shape of "what happened to this
 * chunk" whichever machine rendered it.
 *
 * **THE GAP THAT WAS HERE IS CLOSED, 2026-09-13.** Crucible's server forwards
 * narrator's verdict as `guard` on the `chunk` frame (crucible `b232e3a`,
 * `docs/PHASE6-REMOTE-RENDER.md` section 3) and its SDK reads it — but that
 * commit was in no release tarball, so `@crucible/client` v0.4.0 built
 * `ChunkData` from a fixed field list with no `guard` and the field was
 * discarded INSIDE the SDK before this file could see it. Every remote chunk was
 * recorded unknown for the named reason `sdk-drops-the-field`: not silent, and
 * not `clean`.
 *
 * v0.5.0 carries it, package.json pins v0.5.0, and the installed `readChunk()`
 * was re-read to confirm rather than assumed. So a remote render now reports
 * REAL verdicts, and `sdk-drops-the-field` becomes what it was always meant to
 * be — the answer for a checkout pinned to an older client, which
 * `tools/test-chunk-guard-ledger.js` measures on every run rather than trusting
 * this paragraph.
 */

import * as fsSync from 'fs';
import type { CrucibleClient, JobEvent, RenderResult, WrittenArtifact } from '@crucible/client';
import { readRenderResult } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import {
  recordCrucibleChunkGuard,
  takeChunkGuards,
  forgetChunkGuards,
  type ChunkGuardSummary,
} from '../chunk-guard-ledger';

/**
 * The name that lands in the `User-Agent` the SDK sends, so a shared server's
 * log says which app queued the job. One app, one name, declared once in
 * servers.ts. `bookforge-cli` is the CLI's.
 */
const CLIENT_NAME = CRUCIBLE_CLIENT_NAME;

export interface DownloadRenderArtifactsOptions {
  /** The submitting client pins this job to its engine for its entire lifetime. */
  readonly client?: CrucibleClient;
  /** Names an entry in `<userData>/crucible-servers.json`. */
  readonly server: string;
  /** The Crucible job whose artifacts to fetch. */
  readonly jobId: string;
  /**
   * BookForge's OWN identity for this render — `session.jobId` for a render the
   * parallel bridge owns. It keys the guard ledger, so a book that was rendered
   * half locally and half remotely lands in ONE ledger and one summary rather
   * than two that nothing compares.
   */
  readonly renderId: string;
  /**
   * Where a LOCAL render's audio would have landed:
   * `ParallelPrepInfo.chaptersDirSentences`. Must already exist.
   */
  readonly sentencesDir: string;
  /**
   * Resume: the last event id this caller already acted on — the server's own
   * monotonic counter, `JobEvent.id`. The server replays events above it and no
   * further, so artifacts announced before it are ones the caller already had.
   * Omit to replay the whole history, which also reconciles against `done`'s
   * authoritative artifact list.
   */
  readonly lastEventId?: number;
  /**
   * THE CALLER WILL RE-OPEN THIS STREAM, so the guard ledger for this render
   * survives a throw (bug hunt S13, 2026-09-20).
   *
   * The catch below drops this render's verdicts because a FAILED ATTACH must
   * not leave a partial map that a later, successful attach adds to — two
   * attempts summarised as one run. A reconnect is not a later attempt: it is
   * the same render continuing over a socket that died
   * (`crucible/stream-reconnect.ts`), the server replays only the frames above
   * `lastEventId`, and the chunks verdicted before the break are never
   * announced again. Dropping them there would report a 2,267-chunk book's
   * guard summary from whatever happened after its last blip.
   *
   * A caller that sets this OWNS the drop: `render.ts` calls
   * `forgetChunkGuards` when the ladder has finished with the render, whichever
   * way it ended.
   */
  readonly resumable?: boolean;
  /**
   * INERT UNTIL THE SDK CARRIES IT, and kept because the caller that passes one
   * is already cancelling properly without it.
   *
   * It is forwarded to `writeArtifactsTo`, whose options are
   * `WriteArtifactsOptions extends EventsOptions` — `lastEventId` and
   * `concurrency`, no `signal` — and v1.0.1's body never reads the key. TypeScript
   * does not catch it because the forwarded object is a variable rather than a
   * literal, so there is no excess-property check to fail. So aborting this signal
   * does NOT end the stream today.
   *
   * It is not deleted because `crucible/reroll.ts` passes one, and what makes a
   * reroll cancellable is its own `abort` listener calling `client.cancel(jobId)`
   * — a CANCEL, not a hang-up, so the job stops rather than running on holding
   * the lane. The stream then ends on the server's `cancelled` frame. Keeping the
   * field means the day the SDK's options carry a signal, that caller is already
   * wired for it; what must not survive is this doc's old claim that it "aborts
   * the stream", which is the kind of line a cancellation bug gets debugged
   * against for an hour. It never cancelled the job on the server either.
   */
  readonly signal?: AbortSignal;
  /** Each finished file, as it lands. */
  readonly onWritten?: (written: WrittenArtifact) => void;
  /** Every job event, unchanged, for a progress bar. */
  readonly onEvent?: (event: JobEvent) => void;
}

export interface RenderArtifactsOutcome {
  /** How many `<index>.flac` files this call wrote into `sentencesDir`. */
  readonly written: number;
  /**
   * The job's terminal news. **A successful job can still have failed chunks**
   * — one bad sentence never sinks the other 1,399 (PHASE3-TTS.md section 6) —
   * so `result.failed` is the authoritative list of indices with no audio, and a
   * chunk with no `<index>.flac` is a file that is not there, which BookForge's
   * resume already knows how to ask for again. It is REPORTED here and never
   * thrown (Owen's 2026-09-05 ruling: the audit reports, it does not block).
   */
  readonly result: RenderResult;
  /** What the engine's guard decided about this render's chunks. */
  readonly guard: ChunkGuardSummary;
}

/** A remote render that ended any way other than `done`. Named, never swallowed. */
export class CrucibleRenderNotDone extends Error {
  readonly terminalEvent: string;
  readonly terminalData: unknown;
  constructor(jobId: string, terminalEvent: string, terminalData: unknown) {
    super(`Crucible render job ${jobId} ended ${terminalEvent}, not done: `
      + `${JSON.stringify(terminalData)}`);
    this.name = 'CrucibleRenderNotDone';
    this.terminalEvent = terminalEvent;
    this.terminalData = terminalData;
  }
}

/**
 * Fetch a finished (or still-running) `tts` job's audio into the session's
 * sentences directory, recording the engine's guard verdict for every chunk.
 *
 * Returns when the directory is complete: the SDK's iterator ends only after the
 * terminal event AND after every outstanding write has landed.
 */
export async function downloadRenderArtifacts(
  options: DownloadRenderArtifactsOptions,
): Promise<RenderArtifactsOutcome> {
  const { server, jobId, renderId, sentencesDir } = options;

  // Every refusal here is by name and none of them has a default. A silently
  // substituted directory is a book rendered into nowhere.
  if (typeof sentencesDir !== 'string' || sentencesDir.length === 0) {
    throw new Error('downloadRenderArtifacts: no sentencesDir. A remote render\'s audio '
      + 'goes where a local render\'s goes — prepInfo.chaptersDirSentences — and there '
      + 'is no default for it.');
  }
  if (!fsSync.existsSync(sentencesDir)) {
    throw new Error(`downloadRenderArtifacts: ${sentencesDir} does not exist. This is the `
      + 'directory a local render writes <index>.flac into and prep creates it; creating '
      + 'it here would turn a typo into an empty directory that reads as a render which '
      + 'produced nothing.');
  }
  if (typeof renderId !== 'string' || renderId.length === 0) {
    throw new Error('downloadRenderArtifacts: no renderId. It keys the guard ledger, and '
      + 'an empty one would pool every book\'s chunks into a single summary.');
  }

  const client = options.client === undefined ? await crucibleClientFor(server, CLIENT_NAME) : options.client;

  // `signal` rides along and the SDK drops it — see the field's own note. It is
  // forwarded rather than held back so that nothing here has to change when the
  // SDK's `WriteArtifactsOptions` grows one.
  const writeOptions: { lastEventId?: number; signal?: AbortSignal } = {};
  if (options.lastEventId !== undefined) writeOptions.lastEventId = options.lastEventId;
  if (options.signal !== undefined) writeOptions.signal = options.signal;

  let written = 0;
  let terminal: JobEvent | null = null;
  try {
    for await (const write of client.writeArtifactsTo(jobId, sentencesDir, writeOptions)) {
      if (write.kind === 'written') {
        written += 1;
        options.onWritten?.(write.written);
        continue;
      }
      const event = write.event;
      options.onEvent?.(event);
      if (event.event === 'chunk') {
        // THE REMOTE FEED INTO THE ONE SINK.
        //
        // The cast passes the event's data through AS A RECORD, which is what
        // lets the ledger see whether the `guard` key is there at all — and that
        // is the distinction that matters, because an ABSENT key ("nobody
        // between us and the server speaks this field") and a NULL one ("the
        // server looked and narrator did not say") are different news, and
        // neither of them is "clean".
        //
        // It is written this way ON PURPOSE and not because the pinned SDK lacks
        // the field. It did until v0.5.0 and no longer does; this still reads the
        // key rather than the typed member, so a checkout pinned to an older
        // client reports `sdk-drops-the-field` instead of silently reporting
        // nothing.
        //
        // This is deliberately not a `guard`-shaped interface declared on this
        // side. The verdict's vocabulary belongs to narrator's retake ladder and
        // is free to grow; a type here that knew the words would be a second
        // owner of them, which crucible/docs/ARCHITECTURE.md section 1 says is
        // the shape every other defect in this system turned out to be.
        const data = event.data as unknown as { readonly index: number } & Record<string, unknown>;
        recordCrucibleChunkGuard(renderId, data);
        continue;
      }
      if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
        terminal = event;
        /*
         * THE IN-FLIGHT LEDGER IS NOT TOUCHED HERE (PK15, 2026-09-20).
         *
         * It used to be settled on this line — right about WHEN (only a
         * terminal frame means the server has stopped holding the card) and
         * wrong about WHO. This function is one attempt at a stream: the
         * reconnect ladder runs it again, `reroll.ts` runs it for jobs that
         * have no ledger row at all, and the endings that leave a row standing
         * (a stall cancelled by name, a done frame whose artifacts would not
         * download) never reach this line. The row belongs to the door that
         * WROTE it — `render.ts` — and it reconciles every ending at one exit
         * through `reconcileStreamEnding`.
         */
      }
    }
  } catch (err) {
    // The ledger is per-render state and this render is over. Dropping it here
    // keeps a failed attach from leaving a partial map behind that a later,
    // successful attach would then add to — two attempts summarised as one run.
    // Unless the caller says it is coming straight back (see `resumable`).
    if (options.resumable !== true) forgetChunkGuards(renderId);
    throw err;
  }

  if (terminal === null) {
    // Unreachable by the SDK's contract — its iterator ends only on a terminal
    // event or by throwing. Stated rather than assumed, because the alternative
    // is reading an empty directory as a finished render.
    forgetChunkGuards(renderId);
    throw new Error(`the event stream for Crucible job ${jobId} ended with no terminal event`);
  }
  if (terminal.event !== 'done') {
    forgetChunkGuards(renderId);
    throw new CrucibleRenderNotDone(jobId, terminal.event, terminal.data);
  }

  return {
    written,
    result: readRenderResult(terminal.data),
    // POPS, like the local path's completion does. See chunk-guard-ledger.ts.
    guard: takeChunkGuards(renderId),
  };
}
