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
 * The server's tunable engine topology. `cpuWorkers` is the only knob (CUDA always
 * runs one worker — autoregressive decode serializes on the GPU). Worker-count
 * changes are persisted server-side and take effect on the next engine start, so
 * the client pairs them with an `engine.restart` to apply them now.
 */
export interface ServerConfig {
  cpuWorkers: number;
  defaultCpuWorkers: number;
  minWorkers: number;
  maxWorkers: number;
  /** null until the engine first probes torch (non-mac); mac is always 'cpu' */
  device: 'cpu' | 'cuda' | null;
  /** workers the active device will actually run: cpuWorkers on CPU, 1 on CUDA
   *  (the GPU serializes autoregressive decode). The knob is moot on CUDA. */
  deviceWorkers: number;
  /** workers currently alive — 0 when the engine is stopped */
  activeWorkers: number;
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
  | { action: 'config.set'; cpuWorkers?: number; voice?: string }
  // preempt (default true) cancels other sessions so this block takes over the
  // audio output; background (default false) generates a read-ahead block at low
  // pool priority alongside the playing one. Prefetch sends {preempt:false,
  // background:true} so upcoming blocks generate concurrently and keep every CPU
  // worker busy even when each block is a one-sentence paragraph.
  | { action: 'speak'; requestId: string; text: string; settings?: SpeakSettings; preempt?: boolean; background?: boolean }
  | { action: 'playhead'; requestId: string; sentenceIndex: number }
  | { action: 'cancel'; requestId: string };

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
  message: string;
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
  | ErrorEvent;

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
