/**
 * crucible-rows.ts — ROWS on a Crucible streaming session, for every client
 * that opens one.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * Crucible's streaming door (crucible `docs/PHASE3-TTS.md` §7) is one session
 * carrying many rows at once: you `say(id, text, take)` and the audio for every
 * live row arrives interleaved on one event stream — an `audio` for row 3 while
 * row 2 is still emitting, a `done` for row 1 after both. Turning that back
 * into "one promise per row" is the same code whoever is listening, and since
 * Phase 16 (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §5 step 2) there are three of
 * them: the main process's `electron/crucible/stream.ts`, the browser
 * extension's offscreen document, and the Angular renderer.
 *
 * It was `electron/crucible/stream.ts`'s private `Row` / `onEvent` / `settle`
 * until then, and it moved rather than being copied because every one of the
 * four frames has a rule that is easy to get subtly wrong and impossible to
 * notice: a `restart` that must void audio already handed over, a `done` whose
 * `capped` is `null` and not `false`, a frame for a row this session never
 * said, and a `cancel` whose cost depends on where the row was.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It does not open the session and it does not reconnect. `@crucible/client`'s
 * `stream()` attaches the event stream and reads the server's `ready` frame
 * BEFORE it resolves, and reattaches with `Last-Event-ID` inside the server's
 * 15-second grace window on its own. Re-implementing either here would be a
 * second answer to a question the SDK already answers.
 *
 * It does not judge. A `done` frame carries the server's measurements —
 * `seconds`, `chars`, `charsPerSec`, `capped`, `cancelled` — and no verdict;
 * the streaming door is UNGUARDED by ruling, and Listen never re-rolls
 * (docs/CRUCIBLE_ROLLOUT_PLAN.md ruling 3). Every `done` is handed to
 * `onRowDone` for the caller to RECORD, and a `capped: true` row is delivered
 * to the listener exactly as it came.
 *
 * It does not chunk, normalise or pack — `shared/listen-text/` does, before a
 * row gets here. A row longer than the (voice, backend) cap is refused by the
 * server as `chunk_too_long` and is never re-split. WHAT THE PACKER PACKS TO is
 * the SERVER's since 2026-09-15: the caller reads the venue's `GET /v1/voices`
 * row and hands `listenBandFromCaps` those numbers rather than the local
 * catalog's (`electron/crucible/voice-band.ts`; in the app it is the active
 * engine's `statedChunkCaps`, in the extension the caps its own `voices` call
 * already returned).
 *
 * PURE of Node and of the DOM: `Int16Array`, promises, and the SDK's session
 * interface. What a client does with the PCM (base64 for the main process's
 * wire, a WAV blob in a browser) is the client's.
 */

import type { StreamEvent, StreamRowDone, TtsStreamSession } from '@crucible/client';

/**
 * The take every Listen row asks for. Zero, always — the engine's own sampling,
 * which is what asking for nothing gets, and the SDK's `say` has no default on
 * the wire (PHASE3-TTS.md §7, difference 5). A take above 0 on a voice that
 * declares a ladder is refused `sampling_not_wired` until narrator grows a
 * sampling channel, so nothing here offers to send one.
 */
export const CRUCIBLE_STREAM_TAKE = 0;

/**
 * How many rows a client may hold in flight against one Crucible session.
 *
 * The SERVER batches, and its width is engine tuning it does not publish
 * (`crucible/ttsstream.py`'s `STREAM_BATCH_WIDTH`: `higgs-v3` 1, `orpheus` 8),
 * so this is the CLIENT's read-ahead depth — rows said and not yet done — and
 * not a batch width. A per-row cancel of a pending row costs the server
 * nothing (`dropped`), so overshooting here is cheap and undershooting is a
 * gap in the listener's ear.
 *
 * Eight, because that is the local narrator pool's `STREAM_RAMP_WIDTH`
 * (electron/orpheus-worker-pool.ts) — the narrowest width MEASURED to beat
 * speech rate — and the scheduler's first wave should be the same size
 * whichever backend answers. The two are not one import because that module is
 * the narrator pool and would drag Electron into a browser bundle; they are
 * one number, and `tools/test-listen-text-one-source.js` compares them.
 */
export const CRUCIBLE_STREAM_IN_FLIGHT = 8;

/**
 * The first wave's width for the session being listened to — see
 * `ListenStartOptions` and the essay in `electron/stream-scheduler.ts`.
 *
 * The same as the depth above on a Crucible: the server decides its own batch
 * width, so there is no narrower first wave to ask for, and the ramp exists in
 * the policy for the local pool's sake.
 */
export const CRUCIBLE_STREAM_RAMP_WIDTH = CRUCIBLE_STREAM_IN_FLIGHT;

/** One sub-row chunk, as it leaves this layer. */
export interface CrucibleRowChunk {
  readonly seq: number;
  readonly pcm: Int16Array;
  readonly seconds: number;
  readonly sampleRate: number;
}

/** What saying one row produced. */
export interface CrucibleRowResult {
  success: boolean;
  /** The whole row's PCM, in seq order, when it was NOT streamed out. */
  pcm?: Int16Array;
  /** Seconds the SERVER measured for this row. */
  seconds?: number;
  /** The row's audio already reached the caller through `onChunk`. */
  streamed?: boolean;
  error?: string;
}

/** Per-row knobs. A row with no `onChunk` is buffered until its `done`. */
export interface CrucibleSayOptions {
  /** An id unique within this session. Supplied by the caller so its own logs
   *  and the server's name the same row. */
  id: string;
  /** Fast start: hand every chunk over as it arrives instead of at `done`. */
  onChunk?: (chunk: CrucibleRowChunk) => void;
  /** Polled before each chunk and before dispatch — the caller lost interest. */
  isCancelled?: () => boolean;
}

/** What this layer needs from its host, and nothing more. */
export interface CrucibleRowSessionDeps {
  /**
   * A row RETIRED, with the server's own measurements. Called before the row's
   * promise settles, exactly once per row that reaches `done`. RECORD it; the
   * door is unguarded and this layer never acts on it.
   */
  onRowDone?: (id: string, ordinal: number, done: StreamRowDone) => void;
  /** A line worth a human's attention. Defaults to silence. */
  warn?: (line: string) => void;
}

interface Row {
  /** This row's ordinal within the session — what a ledger keys on. */
  readonly ordinal: number;
  readonly onChunk: ((chunk: CrucibleRowChunk) => void) | undefined;
  readonly isCancelled: (() => boolean) | undefined;
  /** Audio held back until `done`, when the caller did not ask for fast start. */
  buffered: { seq: number; pcm: Int16Array; seconds: number }[];
  /** A `cancel` for this row has gone to the server. */
  cancelSent: boolean;
  /**
   * Fast-start audio for this row already reached the listener and the server
   * then RESTARTED the row (PHASE3-TTS.md §7, difference 1). The chunks cannot
   * be taken back, so the row was failed by name and every later frame for it
   * is ignored.
   */
  abandoned: boolean;
  settled: boolean;
  resolve: (result: CrucibleRowResult) => void;
}

/**
 * The rows of ONE open Crucible streaming session.
 *
 * Construct it around a session the SDK has already handed over (so its event
 * stream is attached and its first `say` is never early), call {@link run} once
 * to drain the frames, and {@link say} per row from anywhere.
 */
export class CrucibleRowSession {
  private readonly rows = new Map<string, Row>();
  private ordinal = 0;
  private ended = false;

  constructor(
    private readonly session: TtsStreamSession,
    private readonly deps: CrucibleRowSessionDeps = {},
  ) {}

  /** The session's own sample rate — per voice, never assumed to be 24000. */
  get sampleRate(): number { return this.session.sampleRate; }
  /** `<voice>@<revision>` — the merge that is speaking, not just its name. */
  get fingerprint(): string { return this.session.fingerprint; }
  get sessionId(): string { return this.session.sessionId; }
  get backend(): string { return this.session.backend; }
  /** Rows said and not yet retired. */
  get liveRows(): number { return this.rows.size; }

  /**
   * Read the session's frames for as long as it lives, and resolve with WHY it
   * ended. One reader per session: call it once, do not await it before saying
   * rows, and settle whatever it hands back.
   *
   * A frame for an id this session never said is reported loudly rather than
   * dropped — the two sides would disagree about which rows exist, and silence
   * would be a sentence of missing audio nobody can trace.
   */
  async run(): Promise<string> {
    let reason = 'the server closed the session';
    try {
      for await (const event of this.session) this.onEvent(event);
    } catch (err) {
      reason = `the session failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.finish(reason);
    return reason;
  }

  /**
   * Speak one row. Resolves when the server retires it, fails it, or the
   * session ends underneath it.
   *
   * ONE ATTEMPT. No poll, no wait: the SDK attaches the session's event stream
   * and reads the server's `ready` frame BEFORE handing the session over
   * (v0.6.0), so a row said here is a row the server is listening for. A
   * `stream_not_attached` refusal would mean that guarantee is false, and it
   * surfaces by name rather than being retried around.
   */
  async say(text: string, opts: CrucibleSayOptions): Promise<CrucibleRowResult> {
    if (this.ended) {
      return { success: false, error: `the Listen session is over; row ${opts.id} was not said` };
    }
    if (opts.isCancelled?.() === true) {
      return { success: false, error: 'cancelled before dispatch' };
    }
    if (this.rows.has(opts.id)) {
      // Two live rows under one id would make every frame ambiguous. The caller
      // owns the id space, so this is its bug and it is named rather than
      // papered over with a suffix.
      return { success: false, error: `row id "${opts.id}" is already live on this session` };
    }

    this.ordinal += 1;
    let resolve!: (result: CrucibleRowResult) => void;
    const promise = new Promise<CrucibleRowResult>((r) => { resolve = r; });
    const row: Row = {
      ordinal: this.ordinal,
      onChunk: opts.onChunk,
      isCancelled: opts.isCancelled,
      buffered: [],
      cancelSent: false,
      abandoned: false,
      settled: false,
      resolve,
    };
    this.rows.set(opts.id, row);

    try {
      await this.session.say(opts.id, text, CRUCIBLE_STREAM_TAKE);
    } catch (err) {
      this.rows.delete(opts.id);
      throw err;
    }
    return promise;
  }

  /**
   * Per-row cancel on the server for every live row the caller has marked
   * stale (its `isCancelled` now answers true).
   *
   * Crucible's `cancel` is PER ROW — `dropped` for a row that had not reached
   * the engine, `aborting_batch` for one being generated (free on a voice whose
   * batch width is 1, where the row IS the batch) — so each stale row is
   * cancelled on its own and the live ones are untouched.
   */
  cancelStale(): void {
    for (const [id, row] of this.rows) {
      if (row.cancelSent || row.settled || row.isCancelled?.() !== true) continue;
      row.cancelSent = true;
      void this.session.cancel(id).catch((err: unknown) => {
        this.deps.warn?.(`cancelling row ${id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * Stop one row by id. Returns what it cost, in the server's words:
   * `dropped` (it had not reached the engine), `aborting_batch` (the engine is
   * generating it and its whole batch is being thrown away), or
   * `already_finished` (it retired first — the ordinary race, not an error).
   */
  cancel(id: string): Promise<'dropped' | 'aborting_batch' | 'already_finished'> {
    const row = this.rows.get(id);
    if (row !== undefined) row.cancelSent = true;
    return this.session.cancel(id);
  }

  /** Stop every row. Returns how many were still live. Nothing is restarted. */
  cancelAll(): Promise<number> {
    return this.session.cancelAll();
  }

  /**
   * Close the session and free the voice, settling every live row by name
   * first. The iterator {@link run} is draining ends on the server's `closed`
   * frame; `reason` is what the rows are told.
   */
  async close(reason: string): Promise<void> {
    this.finish(reason);
    await this.session.close();
  }

  // ─────────────────────────────────────────────────────────────── internals

  private onEvent(event: StreamEvent): void {
    const row = this.rows.get(event.id);
    if (row === undefined) {
      this.deps.warn?.(`${event.kind} frame for row ${event.id}, which this session never said `
        + '— dropping it');
      return;
    }
    if (row.abandoned) {
      if (event.kind === 'done') this.rows.delete(event.id);
      return;
    }
    switch (event.kind) {
      case 'audio': {
        if (row.isCancelled?.() === true) return;
        if (row.onChunk !== undefined) {
          row.onChunk({
            seq: event.seq,
            pcm: event.pcm,
            seconds: event.seconds,
            sampleRate: this.session.sampleRate,
          });
        } else {
          row.buffered.push({ seq: event.seq, pcm: event.pcm, seconds: event.seconds });
        }
        return;
      }
      case 'restart': {
        if (row.onChunk !== undefined) {
          // The audio below `fromSeq` is void and it has already been played.
          // No client protocol has a frame that takes audio back, so the honest
          // answer is a failed row, by name, rather than the row's first
          // seconds twice. Unreachable on every voice that ships today
          // (higgs-v3, measured batch width 1); the engine after it would reach
          // this.
          row.abandoned = true;
          this.settle(row, {
            success: false,
            error: `crucible restarted row ${event.id} from seq ${event.fromSeq} (${event.reason}) `
              + 'after its first chunks were already handed to the listener; a fast-start row '
              + 'cannot be restarted',
          });
          return;
        }
        row.buffered = row.buffered.filter((chunk) => chunk.seq >= event.fromSeq);
        return;
      }
      case 'done': {
        this.rows.delete(event.id);
        // RECORDED, NEVER ACTED ON — see the header.
        this.deps.onRowDone?.(event.id, row.ordinal, event);
        if (event.cancelled) {
          this.settle(row, { success: false, error: `row ${event.id} was cancelled on the server` });
          return;
        }
        if (row.onChunk !== undefined) {
          this.settle(row, { success: true, streamed: true, seconds: event.seconds });
          return;
        }
        row.buffered.sort((a, b) => a.seq - b.seq);
        const samples = row.buffered.reduce((n, chunk) => n + chunk.pcm.length, 0);
        const pcm = new Int16Array(samples);
        let at = 0;
        for (const chunk of row.buffered) {
          pcm.set(chunk.pcm, at);
          at += chunk.pcm.length;
        }
        this.settle(row, { success: true, pcm, seconds: event.seconds });
        return;
      }
      case 'error': {
        this.rows.delete(event.id);
        this.settle(row, { success: false, error: `${event.code}: ${event.message}` });
        return;
      }
      default: {
        // The SDK narrows the union; a kind it does not know is thrown inside
        // it, never yielded. Stated so a widened union is a compile error here.
        const never: never = event;
        throw new Error(`crucible stream event of unknown kind: ${JSON.stringify(never)}`);
      }
    }
  }

  private settle(row: Row, result: CrucibleRowResult): void {
    if (row.settled) return;
    row.settled = true;
    row.resolve(result);
  }

  /** Every live row fails by name, once. Idempotent. */
  private finish(reason: string): void {
    this.ended = true;
    for (const [id, row] of this.rows) {
      this.settle(row, {
        success: false,
        error: `Listen session on crucible closed before row ${id} finished: ${reason}`,
      });
    }
    this.rows.clear();
  }
}
