/**
 * Internal extension messaging + shared state types.
 *
 * Four contexts share one `chrome.runtime` bus — content script, service worker
 * (background), offscreen document, popup — so every message carries a `target`
 * and each listener ignores foreign ones. Direct hops aren't possible between
 * content and offscreen (or content and popup), so background relays.
 *
 * Ownership: the offscreen document owns the Crucible streaming session, the
 * recorder's WebSocket, the player, AND the play queue. It broadcasts a
 * QueueSnapshot on every change and background tailors a per-tab UiState down
 * to the content script.
 */

import { DEFAULT_RECORDINGS_DIR, RECORDER } from '../../shared/audio/tab-recording';

export type MessageTarget = 'background' | 'offscreen' | 'content' | 'popup';

/**
 * What the voice engine on the selected Crucible is doing, as the extension
 * can see it.
 *
 * `stopped` = nothing is resident there, `starting` = a load-voice job is in
 * flight, `running` = the voice is on the card. It is NOT a process this
 * extension owns — "engine up" is `/v1/info`'s resident voice (plan §0).
 */
export type EngineState = 'stopped' | 'starting' | 'running';

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

// ─── The Crucible the extension is reading from ───────────────────────────────

/**
 * One voice the selected server has a manifest for, as the pickers draw it.
 *
 * `engine` is on the row because that is the multi-engine door (plan §4a): a
 * picker shows an engine COLUMN only when the list carries more than one, and
 * never an engine selector — a voice implies its engine, so there is nothing to
 * choose apart from a voice and nothing to remove when the next engine lands.
 */
export interface VoiceRow {
  id: string;
  display: string;
  /** The `narratorEngine` the server puts on the row, e.g. `higgs-v3`. */
  engine: string;
  /** Could it be made resident right now? */
  loadable: boolean;
  /** Why not, in the server's words; null when it is loadable. */
  reason: string | null;
  /** Is it the voice on the card at this moment? */
  resident: boolean;
  /**
   * Does loading it need a reference clip (`VoiceInfo.needsReference`)?
   *
   * True for a `zeroshot` voice — the base weights plus somebody's recording —
   * and false for every other kind. The pickers read it to decide whether to
   * show the clip list under the row; loading without one is refused
   * `reference_required`, and loading a CHECKPOINT with one is refused
   * `reference_not_allowed`. It is the row's fact, never inferred from the id:
   * a server is entitled to call a zero-shot voice anything it likes.
   */
  needsReference: boolean;
}

/** The selected server and what is on its card. Replaces the old ServerConfig. */
export interface EngineStatus {
  /** The name the server is registered under here, or null when none is picked. */
  server: string | null;
  /** The server's own address, for the popup's one-line "reading from" note. */
  url: string | null;
  /** `cuda-linux` / `mlx-darwin`, once probed. Never a client's choice. */
  backend: string | null;
  /** The voice (or model) resident on that server right now, or null. */
  resident: string | null;
  /** `tts`, `llm`, … — what KIND of thing holds the card. */
  residentKind: string | null;
  /** A load or unload job is in flight from this extension. */
  busy: 'loading' | 'unloading' | null;
  /** The job's latest `warming` line, or a refusal, for the popup. */
  note: string | null;
  /** Who else holds the engine there, from `/v1/activity`, after a refusal. */
  holder: string | null;
  /** Minutes of no reading before this extension posts an unload (0 = never). */
  idleMinutes: number;
  /**
   * WHICH CLIP a resident zero-shot voice was cloned from, from
   * `/v1/activity`'s `resident.reference` — the name whoever loaded it sent,
   * or its sha256 when they sent none.
   *
   * `zeroshot` is one voice id and any number of recordings, so without this
   * two clients each assume the resident one is theirs. Null when the resident
   * thing is a checkpoint voice or a model (nothing was cloned), and null as
   * well when the read could not be made — `residentClipNote` says which.
   */
  residentClip: string | null;
  /** Why `residentClip` is null when it is not simply "nothing was cloned". */
  residentClipNote: string | null;
}

export const NO_ENGINE: EngineStatus = {
  server: null,
  url: null,
  backend: null,
  resident: null,
  residentKind: null,
  busy: null,
  note: null,
  holder: null,
  idleMinutes: 0,
  residentClip: null,
  residentClipNote: null,
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
  /** why the extension is not talking to a Crucible (none selected, unreachable,
   *  token rejected) — always the server's own words, never a retry hint */
  connectionError?: string;
  /** voice ids the selected server advertises — for the in-page toolbar picker */
  voices: string[];
  /** the same list with the engine, the residency and the reason on each row */
  voiceRows: VoiceRow[];
  /** the voice a read will be spoken in — which is the RESIDENT one, because a
   *  streaming session never loads (PHASE3-TTS.md §6). The popup's Load button
   *  is what makes a different voice resident. */
  currentVoice: string | null;
  /** a load-voice job for this voice is in flight */
  switchingVoice: string | null;
  /** the selected Crucible and what is on its card */
  engine: EngineStatus;
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

/**
 * Make the picked voice resident on the selected Crucible, or take it off.
 *
 * `load` is `POST /v1/jobs {type:"load-voice", …}` and `unload` is
 * `{type:"unload-voice"}` — they were `engine.start` / `engine.stop` on
 * BookForge's socket until Phase 16, and they are not the same act: nothing
 * here starts or stops a process. `engine.restart` had no replacement and is
 * gone (one engine; worker counts are server tuning).
 */
export interface EngineCmd {
  target: 'background';
  cmd: 'engine';
  op: 'load' | 'unload';
  /** op:'load' — which voice. Omitted means "whatever the picker shows". */
  voice?: string;
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
 * Switch the CLIP a zero-shot voice is cloned from — the other half of an
 * identity whose first half is the voice id.
 *
 * It travels the same road as {@link SetVoiceCmd} and is acted on the same
 * way, because it is the same act: a clone is the base weights plus ONE
 * recording, so a different recording is a different speaker under an
 * unchanged id, and reading on through the switch would be reading the rest of
 * the page in somebody else's voice. `''` means "no clip picked", which is a
 * state a zero-shot load is refused in (`reference_required`), not a default.
 */
export interface SetClipCmd {
  target: 'background';
  cmd: 'set-clip';
  /** An id in the IndexedDB clip store (`clips.ts`), or `''` for none. */
  clipId: string;
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

/**
 * How long after the last row this extension waits before it posts an unload
 * (0 = never).
 *
 * A CLIENT TIMER since Phase 16, not a server setting. It used to be
 * `config.set {idleMinutes}` on BookForge's socket, which persisted it in the
 * app and applied it to the app's own pool. A Crucible's residency is the
 * operator's and its idle rule is the server's; what an extension can honestly
 * say is "I am done with it", and that is an unload job on a timer this
 * extension owns. Stored in chrome.storage.local like every other setting.
 */
export interface SetIdleCmd {
  target: 'background';
  cmd: 'set-idle';
  minutes: number;
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

export interface EngineOffscreenCmd { target: 'offscreen'; cmd: 'engine'; op: 'load' | 'unload'; voice?: string; }
export interface QueueOffscreenCmd { target: 'offscreen'; cmd: 'queue'; op: 'remove' | 'clear' | 'skip'; id?: string; }
export interface SyncOffscreenCmd { target: 'offscreen'; cmd: 'sync'; }
export interface SetVoiceOffscreenCmd { target: 'offscreen'; cmd: 'set-voice'; voice: string; }
export interface SetClipOffscreenCmd { target: 'offscreen'; cmd: 'set-clip'; clipId: string; }
export interface SetIdleOffscreenCmd { target: 'offscreen'; cmd: 'set-idle'; minutes: number; }
/** The Options page changed the registry or the selection: drop the session and
 *  re-read. Sent by background, which is the context that can watch storage. */
export interface ServerChangedOffscreenCmd { target: 'offscreen'; cmd: 'server-changed'; }

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
  | SetClipCmd
  | PlayItemCmd
  | PlaySequenceCmd
  | EngineOffscreenCmd
  | QueueOffscreenCmd
  | SyncOffscreenCmd
  | SetVoiceOffscreenCmd
  | SetClipOffscreenCmd
  | SetIdleOffscreenCmd
  | ServerChangedOffscreenCmd
  | SnapshotMsg
  | UiMsg
  | ToggleUiMsg
  | PopupSnapshotMsg;

// ─── persisted settings (chrome.storage.local) ────────────────────────────────

export interface Settings {
  /**
   * BookForge's tab-recording socket — NOT the speech server.
   *
   * Speech goes to a Crucible chosen in Options (`src/servers.ts`,
   * `chrome.storage.local`'s own keys). These three are what the RECORDER
   * needs: it hands raw PCM to a machine with a filesystem, and BookForge's
   * ffmpeg writes the FLAC. They are permanent — the plan's step 6 is split,
   * and the recorder's endpoint outlives the speak relay (protocol.ts).
   */
  host: string;
  port: number;
  token: string;
  /** The voice the popup's Load button will make resident, and the one the
   *  pickers show. '' until the first read of the selected server's voices. */
  voice: string;
  /**
   * WHICH STORED CLIP a zero-shot load will be cloned from — an id in the
   * IndexedDB clip store (`clips.ts`), or `''` for "none picked".
   *
   * Beside the voice because it QUALIFIES the voice: `zeroshot` names the base
   * weights and this names the recording, and neither is the whole answer on
   * its own. `''` is not a default that gets filled in — a zero-shot load with
   * no clip is refused `reference_required`, by the popup before it asks and
   * by the server if it ever got there, because the base weights with no
   * reference are the MODEL'S own speaker under a voice id the user chose for
   * somebody else's.
   */
  zeroshotClipId: string;
  /**
   * Minutes of no reading before this extension posts an unload-voice job to
   * the selected server (0 = never). A CLIENT timer — see SetIdleCmd.
   */
  idleMinutes: number;
  rate: number;
  /** output gain: 1 = normal, >1 amplifies above system volume (Web Audio) */
  volume: number;
  /** the tab recorder's chosen capture speed, remembered between popups */
  recordSpeed: number;
  /** where the SERVER saves recordings. May start with `~` — the extension has
   *  no filesystem, so the server expands it (and refuses a relative path). */
  recordingsDir: string;
  /**
   * "Buffer before playing" — OFF by default since 2026-09-11 (it was ON, the
   * behaviour this extension had always had). ON: a block waits until enough of it
   * is rendered that the generator cannot be caught, then plays through without a
   * hole. That costs ~30s before the first word, because a sentence only exists
   * once its whole batch retires. Owen, 2026-09-11, on Higgs's measured fast-start
   * numbers (first word ~2-4 s in, one ~2 s hiccup after the opener at the old
   * 4-row width, none at width 1): "lets switch it and ill test it out. if it wont
   * work, we'll switch it back." Switching back is this one default — and a value
   * a person has toggled in the popup lives in chrome.storage and wins over it.
   *
   * OFF is FAST START (Owen's ruling of 2026-09-04): the player starts on about
   * a second of audio. Stalls become possible — that is the trade, and the
   * switch is how you take the other side of it. He wanted to try both on
   * Windows (vLLM) and the Mac (MLX) without moving anything around, so it is a
   * setting, not a build.
   *
   * SINCE PHASE 16 IT IS PURELY A CLIENT GATE, and the plan says why (§0):
   * Crucible's streaming door ALWAYS emits sub-sentence frames — fast start is
   * the door's native shape — so there is no `fastStart:true` to send any more.
   * What the switch picks is whether this extension holds those frames back
   * until a row is whole (and a cushion has built) or plays them as they land.
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
  // No clip, and nothing picks one: which recording a clone is made from is a
  // person's choice about whose voice a book is read in.
  zeroshotClipId: '',
  // 15 minutes: long enough that closing one article and opening another does
  // not pay for a load twice, short enough that a card is not held overnight by
  // a browser nobody is listening to. Owen's rule (2026-09-14) is that a model
  // is unloaded when we are done with it, every time; this is how an extension
  // that cannot know when you are done says so.
  idleMinutes: 15,
  rate: 1,
  volume: 1,
  recordSpeed: 1,
  recordingsDir: DEFAULT_RECORDINGS_DIR,
  // OFF since 2026-09-11 (see the field's note): fast start is the default, the
  // gate is opt-IN. Was `true` — fast start opt-OUT — from 2026-09-04.
  bufferBeforePlaying: false
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

/** Key under chrome.storage.session where the offscreen doc mirrors the snapshot. */
export const SNAPSHOT_KEY = 'snapshot';
