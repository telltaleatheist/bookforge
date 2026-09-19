/**
 * session-policy.ts — WHICH ROW IS GENERATED NEXT, and for whom.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * The read-ahead window, the background prefetch, the preempt rule and the
 * playhead, lifted out of `electron/stream-scheduler.ts` in Phase 16
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §5 step 2) with NO behaviour change. That
 * file is now the Electron adapter around this class; the browser extension's
 * offscreen document and the Angular renderer drive the same code.
 *
 * Everything that made the original main-process-only is a port:
 *
 *   - the GENERATOR (`ListenGeneratorPort`) — the local narrator pool, a
 *     Crucible streaming session, or a fake in a keeper;
 *   - the SINK — where a session's events go (a BrowserWindow broadcast, one
 *     WebSocket client, the offscreen player);
 *   - the LOG — a line per session start/stop.
 *
 * Nothing here knows about audio formats, sockets, Electron or the DOM. `Data`
 * is whatever the generator hands back as a chunk's payload (base64 PCM16 in
 * the main process, an `Int16Array` in a browser) and travels through untouched.
 *
 * ── The reasoning behind the numbers is in the generator, not here ──────────
 *
 * The batch-width and first-batch-ramp essays that used to sit at the top of
 * `stream-scheduler.ts` are about ONE engine's measured throughput, so they
 * stayed with the thing that answers `concurrency()` and `rampWidth()`. What is
 * left here is the policy those numbers feed:
 *
 *   - MULTIPLE sessions may generate at once: one "playing" session (priority)
 *     plus any number of background read-ahead sessions the extension
 *     prefetches for upcoming blocks. Their rows interleave across the
 *     generator's whole capacity, so a page made of tiny one-sentence blocks
 *     still saturates it instead of dribbling through one block at a time.
 *   - `start({preempt:true})` (the default) cancels every existing session
 *     first — that is how a new play action takes over the single audio output.
 *     `start({preempt:false})` adds a session alongside the others — that is how
 *     a client fans out read-ahead.
 *   - `priority:false` marks a session as background (low generator priority); a
 *     background session is promoted the moment a playhead is reported for it
 *     (the client adopted it as the current block).
 *   - The FIRST wave of the session being listened to goes out at the ramp
 *     width rather than the full cap, so the client's start gate opens sooner.
 *     Background read-ahead never ramps — full batches are the entire point
 *     there.
 *
 * Event shapes (three surfaces and a browser extension parse them):
 *   {kind:'chunk',    requestId, sentenceIndex, seq, data, duration, sampleRate}
 *   {kind:'done',     requestId, sentenceIndex, duration, gapSec}
 *   {kind:'failed',   requestId, sentenceIndex, error}
 *   {kind:'complete', requestId}
 *   {kind:'cancelled',requestId}
 *
 * `gapSec` is the silence the CLIENT inserts after that row (Owen, 2026-09-18).
 * The audio is bare speech and this is the whole of the pause before the next
 * row — narrator's own `classify_gap` answer for the row's text, which is the
 * number an audiobook of the same sentence is assembled with. It rides `done`
 * and never `chunk`: the gap follows the row's last sample, a `done` happens
 * exactly once per row, and a copy on every chunk would be one number with many
 * owners again.
 *
 * A row normally emits ONE chunk (seq 0) and then its `done`. A fast-start
 * session emits several while it generates, then a `done` with NO further
 * chunk. The shape is the same either way, so a client that assembles by
 * (sentenceIndex, seq) needs to know nothing about which it is getting.
 */

/** One sub-row chunk of audio, as the generator hands it over. */
export interface ListenChunk<Data> {
  seq: number;
  data: Data;
  duration: number;
  sampleRate: number;
}

/** What generating one row produced. */
export interface ListenRowResult<Data> {
  success: boolean;
  /** The whole row's audio, when it was NOT streamed chunk by chunk. */
  audio?: { data: Data; duration: number; sampleRate: number };
  /** The row's audio already reached the client through `onChunk`. */
  streamed?: boolean;
  /** Seconds delivered, for a streamed row. */
  duration?: number;
  /**
   * SECONDS OF SILENCE THE CLIENT MUST INSERT AFTER THIS ROW. Required on a
   * successful row: the generator's audio is bare speech and this is the whole
   * of the pause before the next one — narrator's classification of the row's
   * own text, the same number an audiobook of it would be assembled with. A
   * generator that returns a success without it is refused by name in
   * `dispatch` rather than paced by a constant this layer invented.
   */
  gapSec?: number;
  error?: string;
}

/**
 * The generator this policy dispatches to. One implementation per backend; the
 * measured reasons behind `concurrency()` and `rampWidth()` belong to it.
 */
export interface ListenGeneratorPort<Data, Settings> {
  /** Is there something to generate with at all? A `start` is refused if not. */
  isReady(): boolean;
  /**
   * How many rows may be in flight against this generator, and whether it
   * BATCHES them. A batching generator's cap is its batch width, so a whole
   * batch's worth is dispatched at once — a partly-filled batch costs the same
   * wall clock as a full one, so anything less is throughput thrown away. A
   * generator that does not batch reports its worker count and `batching:false`,
   * which also turns the first-wave ramp off.
   */
  concurrency(): { cap: number; batching: boolean };
  /**
   * The width of the FIRST wave of the session being listened to. The narrowest
   * width measured to beat speech rate: the client's start gate opens sooner on
   * it, and the audio it lands still covers the following full-width batch.
   */
  rampWidth(): number;
  /** Generate one row. `isStale` is polled by the generator to abandon work. */
  generate(
    text: string,
    sentenceIndex: number,
    settings: Settings,
    priority: boolean,
    isStale: () => boolean,
    onChunk?: (chunk: ListenChunk<Data>) => void,
  ): Promise<ListenRowResult<Data>>;
  /**
   * Ask the generator to abandon an in-flight batch whose every row is stale.
   * Optional: a generator with no batch to abandon does not implement it.
   */
  abandonStaleBatch?(): void;
}

/** Where a session's events go. */
export type ListenSink = (event: Record<string, unknown>) => void;

/** Options for {@link ListenSessions.start}. */
export interface ListenStartOptions {
  /** Cancel every other session first (a new play action takes over the audio
   *  output). Default true — read-ahead passes false to coexist. */
  preempt?: boolean;
  /** Playing session (true, default) vs background read-ahead (false). */
  priority?: boolean;
  /** Generate-ahead window (seconds of audio ahead of the playhead). Defaults
   *  deep (whole short article); long single-session callers pass ~45. */
  lookaheadSeconds?: number;
  /**
   * FAST START. Default false, which is every path that existed before
   * 2026-09-04.
   *
   * Owen's ruling of that date: the batch design is right for a read that has
   * to play through without a hole, and it costs ~30s before the first word. He
   * wanted the choice — a switch in the browser extension, ON ("buffer before
   * playing") by default and behaving exactly as it always has, OFF ("fast
   * start") accepting stalls in exchange for hearing something in about a
   * second.
   *
   * OFF sets this. It does NOT change batching or scheduling: same width, same
   * ramp, same order, same generator. What changes is WHEN audio leaves the
   * generator — each row is emitted in sub-row chunks as it generates instead
   * of one payload when the batch retires — and, on the client, when playback
   * starts.
   *
   * Only the PLAYING session ever streams. Background read-ahead has nobody
   * waiting on its first second, and streaming it would spend chunk traffic on
   * audio that will be played from cache minutes later, if at all.
   */
  fastStart?: boolean;
}

/**
 * Default: generate until this much audio is buffered ahead of the playhead,
 * then idle until the playhead advances. Sized to fully buffer a short article
 * up front (~2000s ≈ 5000 spoken words) so a whole page can play through
 * without underruns; the generator runs flat-out until the window is full, then
 * idles. Right for the extension's per-block requests (each finishes well
 * inside the window). Callers streaming ONE long session — the in-app Play tab
 * streams a whole book — pass a small lookaheadSeconds instead: 45s refills
 * faster than playback drains it (~2.1x realtime aggregate), and a deep window
 * on a book would burn minutes of flat-out compute on audio the listener may
 * never reach (and discard it all on a voice/speed change). Memory is the
 * client's concern.
 */
export const DEFAULT_LOOKAHEAD_SECONDS = 2000;

interface Session<Settings> {
  requestId: string | number;
  sentences: string[];
  settings: Settings;
  startIndex: number;
  nextToDispatch: number;
  playhead: number;
  /** sentenceIndex -> generated audio duration (seconds) */
  durations: Map<number, number>;
  inFlight: Set<number>;
  stopped: boolean;
  completeSent: boolean;
  sink: ListenSink;
  /** Playing session (true) vs background read-ahead (false). Drives generator
   *  priority. Flips to true when a playhead is reported (the client started
   *  playing this block). */
  priority: boolean;
  /** Generate-ahead window for this session (seconds ahead of the playhead). */
  lookaheadSeconds: number;
  /** FAST START — see ListenStartOptions.fastStart. */
  fastStart: boolean;
}

/**
 * Every generating session for one generator, and the rules about which row
 * goes next.
 *
 * One instance per generator. The main process holds a module-level one (the
 * pre-Phase-16 `sessions` map); the extension's offscreen document holds its
 * own.
 */
export class ListenSessions<Data, Settings> {
  private readonly sessions = new Map<string | number, Session<Settings>>();

  constructor(
    private readonly generator: ListenGeneratorPort<Data, Settings>,
    private readonly defaultSink: ListenSink,
    /** One line per session start/stop, so a client can trace a read. */
    private readonly log: (line: string) => void = () => { /* silent */ },
  ) {}

  /**
   * Start a generation session. requestId is caller-supplied so the client can
   * filter events for the session it asked for. With `preempt` (default) this
   * cancels all other sessions first; with `preempt:false` it runs alongside
   * them.
   */
  start(
    sentences: string[],
    startIndex: number,
    settings: Settings,
    requestId: string | number,
    sink: ListenSink = this.defaultSink,
    opts: ListenStartOptions = {},
  ): { success: boolean; error?: string } {
    if (!this.generator.isReady()) {
      return { success: false, error: 'TTS session not active' };
    }

    const preempt = opts.preempt !== false;
    const priority = opts.priority !== false;

    if (preempt) this.stopAll();
    else this.endSession(this.sessions.get(requestId));  // replace a same-id session, if any

    const s: Session<Settings> = {
      requestId,
      sentences,
      settings,
      startIndex,
      nextToDispatch: startIndex,
      playhead: startIndex,
      durations: new Map(),
      inFlight: new Set(),
      stopped: false,
      completeSent: false,
      sink,
      priority,
      lookaheadSeconds: opts.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS,
      fastStart: opts.fastStart === true,
    };
    this.sessions.set(requestId, s);

    this.log(`Start req=${requestId} ${priority ? 'play' : 'prefetch'} from sentence `
      + `${startIndex}/${sentences.length}${preempt ? ' (preempt)' : ''}`
      + `${s.fastStart && priority ? ' [fast start]' : ''}`);
    this.pump(s);
    return { success: true };
  }

  /** Client reports playback position. Advances this session's lookahead window
   *  and — since only the block being listened to reports a playhead — promotes
   *  a background read-ahead session to playing priority. */
  reportPlayhead(requestId: string | number, sentenceIndex: number): void {
    const s = this.sessions.get(requestId);
    if (!s || s.stopped) return;
    s.priority = true;
    if (sentenceIndex > s.playhead) {
      s.playhead = sentenceIndex;
      this.pump(s);
    }
  }

  /** Stop one session (by requestId) or, with no argument, every session.
   *  In-flight generation is cancelled; results are dropped via isStale(). */
  stop(requestId?: string | number): void {
    if (requestId === undefined) { this.stopAll(); return; }
    this.endSession(this.sessions.get(requestId));
  }

  /** True if a session with this requestId is still generating. Lets external
   *  callers verify ownership before playhead/cancel. */
  isActive(requestId: string | number): boolean {
    const s = this.sessions.get(requestId);
    return !!s && !s.stopped;
  }

  /** Every generating session's requestId. Lets a caller preempt SELECTIVELY —
   *  cancelling other clients' sessions while sparing the requesting client's
   *  own read-ahead, which is already-rendered audio that a blanket stopAll
   *  would throw away. */
  activeIds(): (string | number)[] {
    return [...this.sessions.keys()];
  }

  // ───────────────────────────────────────────────────────────── internals

  /** Cancel every session (used by a preempting start / global stop). */
  private stopAll(): void {
    for (const s of [...this.sessions.values()]) this.endSession(s);
  }

  /** Cancel one session: drop it from the map, tell the generator to abandon
   *  what it can, and tell the client it was cancelled (unless it completed). */
  private endSession(s: Session<Settings> | undefined): void {
    if (!s || s.stopped) return;
    this.log(`Stop req=${s.requestId}`);
    s.stopped = true;
    this.sessions.delete(s.requestId);
    // This session's rows may be the last live ones in the generator's in-flight
    // batch — and on a serial batching engine that batch is 30-43s of work whose
    // results are now discarded on arrival, with the next voice load and the next
    // block's batch queued behind it. Ask the generator to abandon it. It refuses
    // unless EVERY outstanding row is stale, so a batch still carrying another
    // session's rows is untouched — which is why this must come AFTER `s.stopped`
    // and the map removal above (the staleness predicates read exactly that state).
    this.generator.abandonStaleBatch?.();
    if (!s.completeSent) s.sink({ kind: 'cancelled', requestId: s.requestId });
  }

  /** Seconds of generated-but-not-yet-played audio ahead of the playhead. */
  private bufferedSecondsAhead(s: Session<Settings>): number {
    let total = 0;
    for (const [index, duration] of s.durations) {
      if (index >= s.playhead) total += duration;
    }
    return total;
  }

  private pump(s: Session<Settings>): void {
    if (s.stopped || this.sessions.get(s.requestId) !== s) return;

    const { cap: fullCap, batching } = this.generator.concurrency();
    // …except the FIRST wave of the session actually being listened to, which
    // goes out at the ramp width so the client's start gate opens sooner. Only
    // ever the first wave: after this, nextToDispatch has moved off startIndex
    // and the cap is full again. Background read-ahead never ramps.
    const cap = batching && s.priority && s.nextToDispatch === s.startIndex
      ? Math.min(this.generator.rampWidth(), fullCap)
      : fullCap;

    while (
      s.inFlight.size < cap
      && s.nextToDispatch < s.sentences.length
      && this.bufferedSecondsAhead(s) < s.lookaheadSeconds
    ) {
      this.dispatch(s, s.nextToDispatch++);
    }

    // Everything generated and delivered?
    if (
      !s.completeSent
      && s.nextToDispatch >= s.sentences.length
      && s.inFlight.size === 0
    ) {
      s.completeSent = true;
      this.sessions.delete(s.requestId);
      s.sink({ kind: 'complete', requestId: s.requestId });
    }
  }

  private dispatch(s: Session<Settings>, sentenceIndex: number): void {
    const requestId = s.requestId;
    const text = s.sentences[sentenceIndex];
    const isStale = () => this.sessions.get(requestId) !== s || s.stopped;
    s.inFlight.add(sentenceIndex);

    // FAST START: sink this row's audio in sub-row chunks as it generates,
    // instead of one chunk when it lands. The sink shape is IDENTICAL to the one
    // the batch path emits below — same 'chunk' event, same fields — so the
    // client needs no new event type: it simply receives several per row,
    // earlier, and assembles them by (sentenceIndex, seq) exactly as it always
    // has.
    //
    // Only the playing session, and only when the client asked. A background
    // read-ahead session never streams: nobody is waiting on its first second.
    const onChunk = s.fastStart && s.priority
      ? (chunk: ListenChunk<Data>) => {
          if (isStale()) return;
          s.sink({
            kind: 'chunk',
            requestId,
            sentenceIndex,
            seq: chunk.seq,
            data: chunk.data,
            duration: chunk.duration,
            sampleRate: chunk.sampleRate,
          });
        }
      : undefined;

    void this.generator
      .generate(text, sentenceIndex, s.settings, s.priority, isStale, onChunk)
      .then((result) => {
        if (isStale()) return;
        s.inFlight.delete(sentenceIndex);
        // THE GAP RIDES THE `done`, and a success without one never reaches the
        // client. The generator's audio is bare speech, so this number is the
        // entire pause between two rows; defaulting it here would put a pacing
        // decision in the scheduler, which is the one place that knows nothing
        // about the voice. Checked before either success arm because both carry
        // it (a streamed row and a buffered row differ only in when the audio
        // went out, never in how it paces).
        const gapSec = result.gapSec;
        if (result.success && typeof gapSec !== 'number') {
          this.log(`Sentence ${sentenceIndex} came back with no gap to pace it by `
            + `(gapSec ${String(gapSec)}); refusing rather than inventing one`);
          s.sink({
            kind: 'failed',
            requestId,
            sentenceIndex,
            error: 'the generator did not say how long the pause after this row is',
          });
          this.pump(s);
          return;
        }
        if (result.success && result.streamed) {
          // Fast start: the audio already went out chunk by chunk above, so the
          // ONLY thing left to say is that the row is finished. Emitting a seq-0
          // chunk here would deliver it a second time.
          const duration = result.duration || 0;
          // THE BUFFER IS WHAT WILL BE PLAYED, gap included: the client inserts
          // that silence into this row's audio, so a read-ahead window measured
          // without it under-counts every row and generates further ahead than
          // it was told to. Until the gap left the audio it was inside
          // `duration` (narrator baked it in), so this keeps the arithmetic the
          // lookahead has always done.
          s.durations.set(sentenceIndex, duration + (gapSec as number));
          s.sink({ kind: 'done', requestId, sentenceIndex, duration, gapSec });
        } else if (result.success && result.audio) {
          s.durations.set(sentenceIndex, result.audio.duration + (gapSec as number));
          s.sink({
            kind: 'chunk',
            requestId,
            sentenceIndex,
            seq: 0,
            data: result.audio.data,
            duration: result.audio.duration,
            sampleRate: result.audio.sampleRate,
          });
          s.sink({
            kind: 'done',
            requestId,
            sentenceIndex,
            duration: result.audio.duration,
            gapSec,
          });
        } else {
          this.log(`Sentence ${sentenceIndex} failed: ${result.error ?? '(no reason given)'}`);
          s.sink({ kind: 'failed', requestId, sentenceIndex, error: result.error });
        }
        this.pump(s);
      });
  }
}
