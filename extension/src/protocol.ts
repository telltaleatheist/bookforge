/**
 * Wire protocol for BookForge's tab-record server (docs/TAB_RECORDER.md).
 *
 * This file used to be "what is left of the TTS API server". As of Phase 16
 * step 8 there is no TTS API server: the speak half is deleted from BookForge
 * (`electron/tab-record-server.ts` is the whole of what remains) and this is
 * the recorder's protocol, entire.
 *
 * WebSocket, JSON text frames only. Client messages carry an `action`; server
 * messages carry a `type`.
 *
 * ── Speech left this file in Phase 16 ───────────────────────────────────────
 *
 * The extension used to say `speak` here and get `chunk` / `done` /
 * `complete` back, with `engine.start`, `engine.stop`, `engine.restart` and
 * `config.get/set` for the engine's lifecycle. All of that is a Crucible's now
 * (`src/crucible.ts`, `src/offscreen.ts`; the map is
 * docs/EXTENSION-TO-CRUCIBLE-PLAN.md §1) and is deleted from this file rather
 * than left as vocabulary nothing speaks:
 *
 *   speak / chunk / done / failed / complete / cancelled / playhead / cancel
 *   engine.start / engine.stop / engine.restart
 *   config.get / config.set  (and `ServerConfig`, `EngineInfo`)
 *   SpeakSettings, EngineState, PROTOCOL_VERSION
 *
 * ── What is still here, and why ─────────────────────────────────────────────
 *
 * TAB RECORDING. The recorder captures a tab's audio and BookForge's ffmpeg
 * writes the FLAC, so the recorder needs a machine with a filesystem and this
 * socket is how it reaches one. That is why the Options page still carries a
 * BookForge host/port/token row beside the Crucible server picker: they are two
 * different servers doing two different jobs.
 *
 * AND IT IS NOT ON BORROWED TIME. Owen ruled on 2026-09-14 that the plan's
 * step 6 is SPLIT: the SPEAK relay went and the recorder's endpoint on that
 * same server STAYED. Both halves of that ruling are carried out — the relay
 * is deleted from BookForge, this endpoint is not — so the verbs below are the
 * permanent shape of this file, not a remnant waiting for a deletion.
 */

export const DEFAULT_PORT = 8766;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * The one sample rate the player is built around: 24 kHz mono PCM16.
 *
 * Every Crucible voice states its own rate (`VoiceInfo.sampleRate`, and the
 * session repeats it), and every voice in today's catalog says 24000 — which
 * the SDK's own comment calls "exactly the kind of coincidence that becomes a
 * hard-coded number if it is not written down". So it is written down here, and
 * `offscreen.ts` CHECKS the open session against it and refuses by name rather
 * than playing a 44.1 kHz voice at 0.54x and calling it a bug in the model.
 */
export const SAMPLE_RATE = 24000;
/** Bytes per second of PCM16 mono @ 24 kHz: 24000 samples × 2 bytes. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

// ─── Client → server ────────────────────────────────────────────────────────

export type ClientAction =
  | { action: 'hello'; token: string }
  // ── Tab recording (docs/TAB_RECORDER.md). The PCM itself goes as BINARY
  // frames, which are legal only between record.started and record.stop/cancel.
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

/**
 * The reply to `hello`. It used to carry the engine's whole state (state,
 * voices, currentVoice, config, engine, engines) and this interface
 * deliberately declared none of it, because the extension read none of it.
 * The server no longer SENDS any of it either: `version` is the reply.
 */
export interface HelloEvent {
  type: 'hello';
  version: number;
}

export interface ErrorEvent {
  type: 'error';
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
  | ErrorEvent
  | RecordStartedEvent
  | RecordProgressEvent
  | RecordDoneEvent
  | RecordCancelledEvent;

/** WebSocket close code the server uses for any auth failure. */
export const CLOSE_AUTH = 4401;
