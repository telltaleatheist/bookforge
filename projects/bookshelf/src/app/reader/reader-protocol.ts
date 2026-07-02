/**
 * Wire protocol for the Bookshelf Reader stream (electron/reader-stream-bridge.ts).
 *
 * WebSocket, JSON text frames only. Client messages carry an `action`; server
 * messages carry a `type`. Audio is base64 PCM16 (signed 16-bit LE), 24 kHz mono.
 *
 * This is the browser twin of extension/src/protocol.ts, trimmed to what the Reader
 * bridge accepts: the client authenticates by the reader token in the WS URL query
 * (not a hello frame), and engine lifecycle stays owned by the app (no engine or
 * config actions here).
 */

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

/** The server's engine topology (mirrored from hello/status/config). */
export interface ServerConfig {
  enabled: boolean;
  count: number;
  defaultCount: number;
  minWorkers: number;
  maxWorkers: number;
  device: 'cpu' | 'cuda' | null;
  deviceWorkers: number;
  activeWorkers: number;
}

// ─── Client → server ────────────────────────────────────────────────────────

export type ClientAction =
  | { action: 'status' }
  | { action: 'speak'; requestId: string; text: string; settings?: SpeakSettings; preempt?: boolean; background?: boolean }
  | { action: 'playhead'; requestId: string; sentenceIndex: number }
  | { action: 'cancel'; requestId: string };

// ─── Server → client ──────────────────────────────────────────────────────────

export interface HelloEvent {
  type: 'hello';
  state: EngineState;
  voices: string[];
  currentVoice: string | null;
  config: ServerConfig;
  engine?: string;
  engines?: unknown;
}

export interface StatusEvent {
  type: 'status';
  state: EngineState;
  voices: string[];
  currentVoice: string | null;
  config: ServerConfig;
}

export interface StateEvent {
  type: 'state';
  state: EngineState;
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
 * Decode a base64 PCM16 chunk into raw little-endian bytes. The Int16→Float32 half
 * happens at playback time inside the WAV blob assembly.
 */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
