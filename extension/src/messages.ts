/**
 * Internal extension messaging + shared state types.
 *
 * Four contexts share one `chrome.runtime` bus — content script, service worker
 * (background), offscreen document, popup — so every message carries a `target`
 * and each listener ignores foreign ones. Direct hops aren't possible between
 * content and offscreen (or content and popup), so background relays.
 *
 * Ownership: the offscreen document owns the WebSocket, the player, AND the play
 * queue. It broadcasts a QueueSnapshot on every change (mirrored to
 * chrome.storage.session for the popup) and background tailors a per-tab UiState
 * down to the content script.
 */

import { EngineState, ServerConfig } from './protocol';
import { DEFAULT_RECORDINGS_DIR, RECORDER } from '../../shared/audio/tab-recording';

export type MessageTarget = 'background' | 'offscreen' | 'content' | 'popup';

// ─── Playback ─────────────────────────────────────────────────────────────────

/** Where playback of the current item is. */
export interface PlaybackStatus {
  state:
    | 'connecting'
    | 'starting-engine'
    | 'buffering'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'error'
    | 'idle';
  position: number;
  buffered: number;
  totalKnown: boolean;
  sentenceIndex: number;
  sentenceCount: number;
  /** the server's segmentation of the current item, so the page can highlight the
   *  sentence at `sentenceIndex` as it's read (empty until the 'speaking' event) */
  sentences: string[];
  rate: number;
  /** the user has paused — true even before playback starts (so a pause during
   *  buffering shows Play, while generation keeps filling the buffer) */
  paused: boolean;
  error?: string;
  note?: string;
}

/**
 * Progress across the whole RUN — everything the user asked to hear, from the
 * block they clicked to the end of the page — not just the paragraph currently
 * speaking. Drives the transport's one progress bar.
 *
 * Blocks that have been rendered contribute their measured duration; the rest are
 * estimated from character count (with the ratio learned from what's been rendered
 * so far), so the total tightens as the read proceeds rather than jumping around.
 */
export interface RunProgress {
  /** seconds played so far across the run (finished blocks + the live playhead) */
  position: number;
  /** the run's length: measured where rendered, estimated where not */
  total: number;
  /** seconds rendered CONTIGUOUSLY from the run's start — i.e. how far the bar is
   *  filled with real audio, and the region a seek is allowed to land in */
  rendered: number;
  /** true while any part of `total` is still an estimate (shown as "~") */
  estimated: boolean;
}

export const EMPTY_RUN: RunProgress = { position: 0, total: 0, rendered: 0, estimated: false };

// ─── Tab recording ────────────────────────────────────────────────────────────

/**
 * What the Recorder section of the popup draws. State lives in the offscreen
 * document (it owns the capture and the socket) and rides the QueueSnapshot, so
 * the popup renders a recording exactly the way it renders playback — one
 * broadcast, no second channel.
 */
export interface RecordingStatus {
  state: 'idle' | 'starting' | 'recording' | 'stopping' | 'done' | 'error';
  /** the tab being captured, for the "recording X" line */
  title: string;
  /** BOOK seconds the SERVER has written (its byte count, not our clock). At
   *  speed > 1 this is longer than the wall clock — see `speed`. */
  seconds: number;
  bytes: number;
  /** RMS of the latest chunk, 0..1 — the meter */
  level: number;
  /** destination on the BookForge machine; known from record.started onward */
  path: string | null;
  /** the rate the page's player is being driven at (1 = normal) */
  speed: number;
  /** the capture rate the tab actually delivered; 0 until capture starts */
  captureSampleRate: number;
  /** no audible frame has arrived yet — the tab is not playing (or not audible
   *  to us). Presentation only: the recording is running, and the same silence
   *  rule applies to it as to any other part of the capture. */
  waiting: boolean;
  /** seconds of silence left before the recording stops itself and saves. Full
   *  (SILENCE_STOP_SECONDS) whenever audio is flowing. */
  silenceRemaining: number;
  /** named failure, never a bare "something went wrong" */
  error?: string;
  /** the recording ended, but not the way it was asked to (socket dropped, the
   *  tab went away, the trailing-silence auto-stop). The file is still good. */
  warning?: string;
}

export const IDLE_RECORDING: RecordingStatus = {
  state: 'idle',
  title: '',
  seconds: 0,
  bytes: 0,
  level: 0,
  path: null,
  speed: 1,
  captureSampleRate: 0,
  waiting: false,
  silenceRemaining: RECORDER.SILENCE_STOP_SECONDS
};

// ─── Queue ────────────────────────────────────────────────────────────────────

export type ItemSource = 'block' | 'selection';

export interface QueueItem {
  /** unique key; for page blocks it's `${tabId}:${blockId}` */
  id: string;
  /** short preview shown in the popup */
  label: string;
  /** full text to speak */
  text: string;
  source: ItemSource;
  /** present for page-block items, so their button can be highlighted */
  tabId?: number;
  blockId?: string;
  /** char offset into `text` where playback should begin (clicked mid-block);
   *  resolved to a sentence boundary at play time so buffered/cached audio is
   *  reused via a seek instead of re-synthesizing a partial. */
  startChar?: number;
}

/** Authoritative state, broadcast by the offscreen document. */
export interface QueueSnapshot {
  connected: boolean;
  engineState: EngineState;
  current: QueueItem | null;
  upcoming: QueueItem[];
  playback: PlaybackStatus;
  /** progress across the whole run (finished + current + upcoming) */
  run: RunProgress;
  /** why the socket isn't connected (no token / bad token / unreachable) */
  connectionError?: string;
  /** voices the engine can use (catalog-sourced — present even while stopped) */
  voices: string[];
  /** the voice every speak is sent with — the one the picker shows. Never a guess:
   *  the engine is loaded with exactly this or the request fails. */
  currentVoice: string | null;
  /** a voice switch is in flight (the engine is loading that model) */
  switchingVoice: string | null;
  /** engine topology (CPU worker count, device); null before the first connect */
  config: ServerConfig | null;
  /** ids of every queue item whose audio is fully rendered and replayable */
  renderedItemIds: string[];
  /** the tab recording, when there is (or was) one. Optional so every existing
   *  consumer keeps compiling and simply doesn't draw a recorder. */
  recording?: RecordingStatus;
}

/** Per-tab projection of the snapshot, sent down to a content script. */
export interface UiState {
  connected: boolean;
  engineState: EngineState;
  /** the current item's blockId, if it belongs to this tab (else null) */
  currentBlockId: string | null;
  /** upcoming items' blockIds that belong to this tab */
  upcomingBlockIds: string[];
  /** blockIds in this tab whose audio is rendered — the page marks them */
  renderedBlockIds: string[];
  playback: PlaybackStatus;
  run: RunProgress;
  /** voices the engine can use — for the in-page toolbar voice picker */
  voices: string[];
  /** the voice that will speak (see QueueSnapshot.currentVoice) */
  currentVoice: string | null;
  switchingVoice: string | null;
}

// ─── content → background ─────────────────────────────────────────────────────

export interface BlockCmd {
  target: 'background';
  cmd: 'play' | 'enqueue';
  blockId: string;
  text: string;
  label: string;
  source: ItemSource;
}

/** "Play from here to the end of the page": an ordered run of blocks. The start
 *  block always carries its FULL text (so it stays cacheable / matches an existing
 *  cache entry); a mid-paragraph click is conveyed via `startChar`, resolved to a
 *  sentence boundary at play time and reached by seeking the buffer, not re-TTS. */
export interface PlayFromCmd {
  target: 'background';
  cmd: 'play-from';
  source: ItemSource;
  items: { blockId: string; text: string; label: string; startChar?: number }[];
}

/** Drop a block from the running queue (the user excluded it, e.g. an ad). */
export interface ExcludeBlockCmd {
  target: 'background';
  cmd: 'exclude-block';
  blockId: string;
}

/**
 * `stop` ends the read: generation is cancelled and the queue cleared, but every
 * rendered second is KEPT so replaying costs nothing. `close` is the teardown —
 * the user shut the on-page controls, or the tab went away — and is the only thing
 * that frees the audio.
 */
export type TransportOp = 'toggle-pause' | 'seek' | 'seek-run' | 'rate' | 'stop' | 'close' | 'volume';

export interface TransportCmd {
  target: 'background' | 'offscreen';
  cmd: 'transport';
  op: TransportOp;
  delta?: number;
  /** absolute position (seconds into the run) for op:'seek-run' */
  position?: number;
  rate?: number;
  /** gain for op:'volume' — 1 = normal, >1 amplifies above system volume */
  volume?: number;
}

// ─── popup → background ───────────────────────────────────────────────────────

export interface EngineCmd {
  target: 'background';
  cmd: 'engine';
  op: 'start' | 'stop';
}

export interface QueueOpCmd {
  target: 'background';
  cmd: 'queue';
  op: 'remove' | 'clear' | 'skip';
  id?: string;
}

export interface SyncCmd {
  target: 'background';
  cmd: 'sync';
}

/**
 * Switch the voice. This is unconditional and verified: in-flight generation is
 * cancelled, the engine is told to load that voice, and nothing is spoken until
 * it confirms — then whatever was playing restarts in the new voice from the
 * sentence the listener was on. (On Orpheus a voice IS a model, so "switch" means
 * the worker reloads; there is no version of this that quietly keeps the old one.)
 */
export interface SetVoiceCmd {
  target: 'background';
  cmd: 'set-voice';
  voice: string;
}

/**
 * Start / stop / discard a tab recording.
 *
 * The POPUP owns the gesture: `chrome.tabCapture.getMediaStreamId` needs a user
 * gesture and the tabCapture permission, so the popup's click is what mints the
 * stream id. It relays that id here; the offscreen document turns it into a
 * MediaStream and a socket. Background is a pure relay, as with every other
 * command — it just retargets the message.
 */
export interface RecordCmd {
  target: 'background' | 'offscreen';
  cmd: 'record';
  op: 'start' | 'stop' | 'discard';
  /** op:'start' — from chrome.tabCapture.getMediaStreamId({targetTabId}) */
  streamId?: string;
  /** op:'start' — the captured tab, for the recording's name and sidecar */
  title?: string;
  url?: string;
  /** op:'start' — the tab whose media elements background drives at `speed`.
   *  Background needs it to restore 1x when the recording ends by ANY route,
   *  including the ones the popup is not open for. */
  tabId?: number;
  /** op:'start' — playback speed to capture at (1 = normal) */
  speed?: number;
}

/** Offscreen can't reach chrome.storage; it asks background to persist for it. */
export interface PutSettingsCmd {
  target: 'background';
  cmd: 'put-settings';
  patch: Partial<Settings>;
}

/** How long the engine may sit idle before shutting itself down (0 = never).
 *  Server-side setting, so it's shared with the app rather than stored here. */
export interface SetIdleCmd {
  target: 'background';
  cmd: 'set-idle';
  minutes: number;
}

/** Restart the engine to apply a new worker count and/or warm a voice. */
export interface RestartEngineCmd {
  target: 'background';
  cmd: 'restart-engine';
  cpuWorkers?: number;
  voice?: string;
}

// ─── background → offscreen ───────────────────────────────────────────────────

export interface PlayItemCmd {
  target: 'offscreen';
  cmd: 'play' | 'enqueue';
  item: QueueItem;
}

/** Replace the queue with this ordered run and start playing the first item. */
export interface PlaySequenceCmd {
  target: 'offscreen';
  cmd: 'play-sequence';
  items: QueueItem[];
}

export interface EngineOffscreenCmd { target: 'offscreen'; cmd: 'engine'; op: 'start' | 'stop'; }
export interface QueueOffscreenCmd { target: 'offscreen'; cmd: 'queue'; op: 'remove' | 'clear' | 'skip'; id?: string; }
export interface SyncOffscreenCmd { target: 'offscreen'; cmd: 'sync'; }
export interface SetVoiceOffscreenCmd { target: 'offscreen'; cmd: 'set-voice'; voice: string; }
export interface SetIdleOffscreenCmd { target: 'offscreen'; cmd: 'set-idle'; minutes: number; }
export interface RestartEngineOffscreenCmd { target: 'offscreen'; cmd: 'restart-engine'; cpuWorkers?: number; voice?: string; }

// ─── offscreen → background ───────────────────────────────────────────────────

export interface SnapshotMsg {
  target: 'background';
  cmd: 'snapshot';
  snapshot: QueueSnapshot;
}

// ─── background → content ─────────────────────────────────────────────────────

export interface UiMsg {
  target: 'content';
  cmd: 'ui';
  ui: UiState;
}

// ─── background → popup ───────────────────────────────────────────────────────

export interface PopupSnapshotMsg {
  target: 'popup';
  cmd: 'snapshot';
  snapshot: QueueSnapshot;
}

export interface ToggleUiMsg {
  target: 'content';
  cmd: 'toggle-ui';
  /** explicit show/hide; omit to flip */
  show?: boolean;
}

export type RuntimeMessage =
  | BlockCmd
  | PlayFromCmd
  | ExcludeBlockCmd
  | TransportCmd
  | RecordCmd
  | PutSettingsCmd
  | SetIdleCmd
  | EngineCmd
  | QueueOpCmd
  | SyncCmd
  | SetVoiceCmd
  | RestartEngineCmd
  | PlayItemCmd
  | PlaySequenceCmd
  | EngineOffscreenCmd
  | QueueOffscreenCmd
  | SyncOffscreenCmd
  | SetVoiceOffscreenCmd
  | SetIdleOffscreenCmd
  | RestartEngineOffscreenCmd
  | SnapshotMsg
  | UiMsg
  | ToggleUiMsg
  | PopupSnapshotMsg;

// ─── persisted settings (chrome.storage.local) ────────────────────────────────

export interface Settings {
  host: string;
  port: number;
  token: string;
  /** the chosen voice — the single source of truth every picker writes and every
   *  speak sends. '' only until the first connect tells us what the engine has;
   *  we adopt that immediately, so it is never '' in steady state. */
  voice: string;
  rate: number;
  /** output gain: 1 = normal, >1 amplifies above system volume (Web Audio) */
  volume: number;
  /** the tab recorder's chosen capture speed, remembered between popups */
  recordSpeed: number;
  /** where the SERVER saves recordings. May start with `~` — the extension has
   *  no filesystem, so the server expands it (and refuses a relative path). */
  recordingsDir: string;
  /**
   * "Buffer before playing" — ON by default, and ON is the behaviour this extension
   * has always had: a block waits until enough of it is rendered that the generator
   * cannot be caught, then plays through without a hole. That costs ~30s before the
   * first word on Orpheus, because a sentence only exists once its whole batch
   * retires.
   *
   * OFF is FAST START (Owen's ruling of 2026-09-04): the speak carries
   * `fastStart:true`, the server streams each sentence in sub-sentence chunks as it
   * generates, and the player starts on about a second of audio. Stalls become
   * possible — that is the trade, and the switch is how you take the other side of
   * it. He wanted to try both on Windows (vLLM) and the Mac (MLX) without moving
   * anything around, so it is a setting, not a build.
   */
  bufferBeforePlaying: boolean;
}

// Injected by build.mjs (esbuild `define`) from the app's tts-api.json. Declared
// here so tsc is happy; the bundler replaces the identifiers with literals.
declare const __BFR_TOKEN__: string;
declare const __BFR_HOST__: string;
declare const __BFR_PORT__: number;

export const DEFAULT_SETTINGS: Settings = {
  host: typeof __BFR_HOST__ === 'string' ? __BFR_HOST__ : '127.0.0.1',
  port: typeof __BFR_PORT__ === 'number' ? __BFR_PORT__ : 8766,
  token: typeof __BFR_TOKEN__ === 'string' ? __BFR_TOKEN__ : '',
  voice: '',
  rate: 1,
  volume: 1,
  recordSpeed: 1,
  recordingsDir: DEFAULT_RECORDINGS_DIR,
  // ON: the gate that has always been here. Fast start is opt-OUT of seamlessness,
  // never the default.
  bufferBeforePlaying: true
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

/** Key under chrome.storage.session where the offscreen doc mirrors the snapshot. */
export const SNAPSHOT_KEY = 'snapshot';
