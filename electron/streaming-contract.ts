/**
 * THE STREAMING CONTRACT — the shapes every Listen surface speaks, and nothing else.
 *
 * Four surfaces stream audio (the in-app Play tab, the browser extension and LAN
 * clients, the Bookshelf Reader) through ONE scheduler onto ONE interface,
 * `StreamingEngine` in `electron/streaming-engine.ts`. These are the types that
 * interface is written in.
 *
 * ── Why this file exists now, and did not before ───────────────────────────
 *
 * They lived in `orpheus-worker-pool.ts`, whose header said exactly when to move
 * them: *"it moved here rather than into a new `stream-types.ts` because there is
 * now exactly one streaming pool ... If a second pool ever lands, that is the
 * moment to split."* A second backend did land — the Crucible streaming session —
 * and then the local pool was DELETED (docs/LEGACY-REMOVAL.md), which would have
 * taken the contract with it. So the split happens now, for the reason that
 * header named, and the surviving owner is a module with no engine in it at all.
 *
 * NOTHING HERE KNOWS WHICH ENGINE ANSWERS. That is the property worth keeping:
 * a wire shape that mentions a backend is a wire shape that changes when the
 * backend does, and these are spoken by an extension this repo does not ship.
 */

/** What a client asks a sentence to be rendered as. `voice` is the only field
 *  Orpheus honours — the sampling fields are carried for wire compatibility with
 *  clients written against the XTTS-era protocol and are ignored (Orpheus's
 *  sampling is fixed per fine-tune, see the catalog caps). */
export interface PlaySettings {
  voice: string;
  speed: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

/** One fully-rendered sentence, base64 WAV. */
export interface AudioChunk {
  data: string;
  duration: number;
  sampleRate: number;
}

/** One sub-sentence slice of a sentence still being generated, base64 PCM16. */
export interface StreamChunk {
  seq: number;
  data: string;
  duration: number;
  sampleRate: number;
}

export interface StreamResult {
  success: boolean;
  duration?: number;
  cancelled?: boolean;
  error?: string;
}

/**
 * Options for a voice load.
 *
 * `warm` says whether the load may spend time on DISCARDED renders before it
 * reports ready. A prewarm (the reader UI was shown; nobody is waiting on audio)
 * passes true and pays it; a load triggered by a pending speak passes false,
 * because the user is staring at a spinner and the first REAL batch can absorb
 * the same lazy-compile cost itself (~10s once) instead of ~40s of throwaway
 * renders in front of it.
 */
export interface LoadVoiceOptions {
  /** Run the engine's discarded warm-up renders on a first load. Default true. */
  warm?: boolean;
}

/** Device a streaming pool may be pinned to. Orpheus reports its own and takes
 *  no preference (see setStreamWorkerConfig); the type stays because the TTS
 *  Server settings payload and its clients are written against it. */
export type DevicePref = 'auto' | 'cpu' | 'gpu' | 'mps';

/** The topology the Streaming tab reads. */
export interface StreamWorkerConfig {
  /** Multi-worker capability toggle (off ⇒ always 1 worker) */
  enabled: boolean;
  /** The chosen count (kept even when disabled, so a slider remembers it) */
  count: number;
  defaultCount: number;
  minWorkers: number;
  maxWorkers: number;
  /** User's device preference for the streaming engine */
  devicePref: DevicePref;
  /** null until the first engine start probes the runtime */
  device: 'cpu' | 'cuda' | 'mps' | null;
  /** Workers the active device will actually run */
  deviceWorkers: number;
  /** Workers currently alive — 0 when the engine is stopped */
  activeWorkers: number;
}

export type EngineState = 'stopped' | 'starting' | 'warming' | 'running';

/**
 * THE FIRST DISPATCH WAVE'S WIDTH — 8, flat, and deliberately not a ceiling.
 *
 * Moved here with the rest of the contract when the local pool was deleted
 * (docs/LEGACY-REMOVAL.md). It is the SCHEDULER's number, not a pool's: it says
 * how wide the first wave of a session being listened to right now goes out, and
 * `stream-scheduler.ts` is the only thing that reads it.
 *
 * ── Why a number and not a ramp ────────────────────────────────────────────
 *
 * Measured 2026-08-31 (M1 Ultra, deathstalker, MLX): 12.7 chars/s at 1 row,
 * 30-33 at 8, 41.8 at 32. Width clearly buys throughput — but a batch is ATOMIC
 * to the listener. Nothing in it can be played until it retires, and its WALL
 * CLOCK grows with width as fast as its output does:
 *
 *     width  8 -> ~48 s wall, ~75 s of audio   (1.57x speech)
 *     width 16 -> ~83 s wall, ~150 s of audio  (1.80x speech)
 *     width 32 -> ~150 s wall
 *
 * The buffer must cover the wall clock of the batch being generated. At width 8
 * it grows ~27 s per ~48 s batch, so it can never be caught. A doubling ladder
 * (8 -> 16 -> 32) breaks that: a ~150 s batch against a ~75 s buffer starves it
 * and **playback stops dead mid-article** — which is exactly what happened on its
 * first real article, about halfway through. More total throughput, delivered
 * too late to hear.
 *
 * So the useful width is the SMALLEST that clearly beats speech rate. 8 rows
 * land ~60 s of audio in ~28 s where 16 rows land ~120 s in ~40 s, so the
 * narrower first burst opens the client's gate ~15 s sooner, and that ~60 s
 * still covers the FOLLOWING full-width batch's ~40 s with ~20 s to spare. Six
 * would open marginally sooner and leave that second-batch cover too thin;
 * sixteen buys cushion nobody is awake to enjoy.
 */
export const STREAM_RAMP_WIDTH = 8;
