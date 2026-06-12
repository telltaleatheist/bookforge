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

// ─── Client → server ────────────────────────────────────────────────────────

export type ClientAction =
  | { action: 'hello'; token: string }
  | { action: 'status' }
  | { action: 'engine.start'; voice?: string }
  | { action: 'engine.stop' }
  | { action: 'speak'; requestId: string; text: string; settings?: SpeakSettings }
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
}

export interface StatusEvent {
  type: 'status';
  state: EngineState;
  serviceMode: boolean;
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
