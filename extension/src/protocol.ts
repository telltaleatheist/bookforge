/**
 * Wire protocol for the BookForge TTS API server (docs/TTS_API.md).
 *
 * WebSocket, JSON text frames only. Client messages carry an `action`; server
 * messages carry a `type`. Audio is base64 PCM16 (signed 16-bit LE), 24 kHz mono.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8766;
export const DEFAULT_HOST = '127.0.0.1';
export const SAMPLE_RATE = 24000;
/** Bytes per second of PCM16 mono @ 24 kHz: 24000 samples × 2 bytes. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

export type EngineState = 'stopped' | 'starting' | 'running';

/** A speak's optional sampling/voice knobs. All fields optional. */
export interface SpeakSettings {
  voice?: string;
  speed?: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

/**
 * The server's tunable engine topology. Multiple workers are an opt-in capability
 * (`enabled`) the user turns on inside BookForge — when off, the engine always
 * runs one worker. When on, `count` (1–4) is the knob; CUDA still runs one worker
 * regardless (autoregressive decode serializes on the GPU). Worker-count changes
 * are persisted server-side and take effect on the next engine start, so the
 * client pairs them with an `engine.restart` to apply them now.
 */
export interface ServerConfig {
  /** Multi-worker capability toggle, set inside BookForge (off ⇒ always 1 worker) */
  enabled: boolean;
  /** The chosen 1–4 count (remembered even while disabled) */
  count: number;
  defaultCount: number;
  minWorkers: number;
  maxWorkers: number;
  /** null until the engine first probes torch (non-mac); mac is always 'cpu' */
  device: 'cpu' | 'cuda' | null;
  /** workers the active device will actually run: count on CPU when enabled, else 1
   *  (the GPU serializes autoregressive decode). The knob is moot on CUDA. */
  deviceWorkers: number;
  /** workers currently alive — 0 when the engine is stopped */
  activeWorkers: number;
  /** minutes of inactivity before the engine shuts itself down (0 = never) */
  idleMinutes?: number;
  /** the windows the server offers, so every client shows the same ladder */
  idleChoices?: number[];
}

// ─── Client → server ────────────────────────────────────────────────────────

export type ClientAction =
  | { action: 'hello'; token: string }
  | { action: 'status' }
  | { action: 'engine.start'; voice?: string }
  | { action: 'engine.stop' }
  // Restart the pool to apply a new worker count and/or warm a voice. When
  // `cpuWorkers` is present the server persists it before bringing the pool back.
  | { action: 'engine.restart'; voice?: string; cpuWorkers?: number }
  // Read or persist engine config without restarting. A voice given while the
  // engine is running is warmed immediately; cpuWorkers only takes effect on the
  // next start (use engine.restart to apply now).
  | { action: 'config.get' }
  | { action: 'config.set'; cpuWorkers?: number; voice?: string; idleMinutes?: number }
  // preempt (default true) cancels OTHER CLIENTS' sessions so this block takes
  // over the audio output — our own read-ahead survives, so pressing play never
  // discards audio we already rendered. background (default false) generates a
  // read-ahead block at low pool priority alongside the playing one. Prefetch
  // sends {preempt:false, background:true} so upcoming blocks generate
  // concurrently and keep every worker busy even when each block is a
  // one-sentence paragraph.
  //
  // settings.voice is always sent and is binding: the server loads exactly that
  // voice or fails the request. startSentence resumes a partly-rendered block —
  // we still hold the earlier sentences' audio, so only the tail is generated.
  //
  // fastStart is the "Buffer before playing" switch turned OFF (Owen's ruling of
  // 2026-09-04). The server then emits each sentence of THIS session as several
  // 'chunk' events while it is still generating, so playback can begin on about a
  // second of audio instead of on a cushion deep enough to guarantee no hole. Same
  // event shape as always — just more of them, sooner — so nothing downstream of
  // the socket has to know. Sent only on the FOREGROUND speak: read-ahead has
  // nobody waiting on its first second, and the server ignores the flag on a
  // background session regardless.
  | {
      action: 'speak';
      requestId: string;
      text: string;
      settings?: SpeakSettings;
      preempt?: boolean;
      background?: boolean;
      startSentence?: number;
      fastStart?: boolean;
    }
  | { action: 'playhead'; requestId: string; sentenceIndex: number }
  | { action: 'cancel'; requestId: string }
  // ── Tab recording (docs/TAB_RECORDER.md). These ride the same socket as
  // speech and never touch the stream scheduler: recording while listening is
  // legal in both directions. The PCM itself goes as BINARY frames, which are
  // legal only between record.started and record.stop/cancel.
  | {
      action: 'record.start';
      recordId: string;
      title: string;
      /** the CAPTURE rate — what the tab delivers, before any relabelling */
      sampleRate: number;
      channels: number;
      /** the rate the page's player is being driven at (1 = normal). The server
       *  writes the file at sampleRate / speed; nothing is resampled. */
      speed?: number;
      /** where the SERVER should save it. May start with `~`; must be absolute
       *  after expansion. Absent = the server's default (`~/Downloads`). */
      outputDir?: string;
      /** the page being captured, for the sidecar */
      sourceUrl?: string;
    }
  | { action: 'record.stop'; recordId: string }
  | { action: 'record.cancel'; recordId: string }
  | { action: 'record.mark'; recordId: string; label: string; seconds: number };

// ─── Server → client ──────────────────────────────────────────────────────────

export interface HelloEvent {
  type: 'hello';
  version: number;
  state: EngineState;
  serviceMode: boolean;
  voices: string[];
  currentVoice: string | null;
  config: ServerConfig;
}

export interface StatusEvent {
  type: 'status';
  state: EngineState;
  serviceMode: boolean;
  voices: string[];
  currentVoice: string | null;
  config: ServerConfig;
}

/** Reply to config.get / config.set / engine.restart. */
export interface ConfigEvent {
  type: 'config';
  config: ServerConfig;
  voices: string[];
  currentVoice: string | null;
}

export interface StateEvent {
  type: 'state';
  state: EngineState;
  serviceMode: boolean;
}

export interface SpeakingEvent {
  type: 'speaking';
  requestId: string;
  sentences: string[];
  /** echo of the speak's startSentence — the index generation actually begins at,
   *  so a resuming client can check its cached prefix against this segmentation */
  startSentence?: number;
}

export interface ChunkEvent {
  type: 'chunk';
  requestId: string;
  sentenceIndex: number;
  seq: number;
  /** base64-encoded PCM16 */
  data: string;
  duration: number;
  sampleRate: number;
}

export interface DoneEvent {
  type: 'done';
  requestId: string;
  sentenceIndex: number;
  duration: number;
}

export interface FailedEvent {
  type: 'failed';
  requestId: string;
  sentenceIndex: number;
  error: string;
}

export interface CompleteEvent {
  type: 'complete';
  requestId: string;
}

export interface CancelledEvent {
  type: 'cancelled';
  requestId: string;
}

export interface ErrorEvent {
  type: 'error';
  requestId?: string;
  /** present when the failure belongs to a recording rather than a speak */
  recordId?: string;
  message: string;
}

// ─── Tab recording events ─────────────────────────────────────────────────────

/** The recording exists and the server is ready for PCM. `path` is the FINAL
 *  destination, not the .partial.flac — it is what the popup shows. */
export interface RecordStartedEvent {
  type: 'record.started';
  recordId: string;
  path: string;
}

/** ~1 Hz while recording. `seconds` is derived from the bytes the server has
 *  actually written, so it is the truth about the file, not about the clock. */
export interface RecordProgressEvent {
  type: 'record.progress';
  recordId: string;
  seconds: number;
  bytes: number;
}

export interface RecordDoneEvent {
  type: 'record.done';
  recordId: string;
  path: string;
  seconds: number;
  bytes: number;
}

export interface RecordCancelledEvent {
  type: 'record.cancelled';
  recordId: string;
}

export type ServerEvent =
  | HelloEvent
  | StatusEvent
  | StateEvent
  | ConfigEvent
  | SpeakingEvent
  | ChunkEvent
  | DoneEvent
  | FailedEvent
  | CompleteEvent
  | CancelledEvent
  | ErrorEvent
  | RecordStartedEvent
  | RecordProgressEvent
  | RecordDoneEvent
  | RecordCancelledEvent;

/** WebSocket close code the server uses for any auth failure. */
export const CLOSE_AUTH = 4401;

/**
 * Decode a base64 PCM16 chunk into raw little-endian bytes. The browser has no
 * Buffer, so this is the atob → Uint8Array half of the doc's decode recipe; the
 * Int16→Float32 half happens at playback time inside the WAV blob assembly.
 */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
