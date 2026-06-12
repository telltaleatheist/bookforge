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

import { EngineState } from './protocol';

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
  rate: number;
  error?: string;
  note?: string;
}

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
}

/** Authoritative state, broadcast by the offscreen document. */
export interface QueueSnapshot {
  connected: boolean;
  engineState: EngineState;
  current: QueueItem | null;
  upcoming: QueueItem[];
  playback: PlaybackStatus;
}

/** Per-tab projection of the snapshot, sent down to a content script. */
export interface UiState {
  connected: boolean;
  engineState: EngineState;
  /** the current item's blockId, if it belongs to this tab (else null) */
  currentBlockId: string | null;
  currentLabel: string | null;
  /** upcoming items' blockIds that belong to this tab */
  upcomingBlockIds: string[];
  playback: PlaybackStatus;
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

export type TransportOp = 'toggle-pause' | 'seek' | 'rate' | 'stop';

export interface TransportCmd {
  target: 'background' | 'offscreen';
  cmd: 'transport';
  op: TransportOp;
  delta?: number;
  rate?: number;
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

// ─── background → offscreen ───────────────────────────────────────────────────

export interface PlayItemCmd {
  target: 'offscreen';
  cmd: 'play' | 'enqueue';
  item: QueueItem;
}

export interface EngineOffscreenCmd { target: 'offscreen'; cmd: 'engine'; op: 'start' | 'stop'; }
export interface QueueOffscreenCmd { target: 'offscreen'; cmd: 'queue'; op: 'remove' | 'clear' | 'skip'; id?: string; }
export interface SyncOffscreenCmd { target: 'offscreen'; cmd: 'sync'; }

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

export interface ToggleUiMsg {
  target: 'content';
  cmd: 'toggle-ui';
  /** explicit show/hide; omit to flip */
  show?: boolean;
}

export type RuntimeMessage =
  | BlockCmd
  | TransportCmd
  | EngineCmd
  | QueueOpCmd
  | SyncCmd
  | PlayItemCmd
  | EngineOffscreenCmd
  | QueueOffscreenCmd
  | SyncOffscreenCmd
  | SnapshotMsg
  | UiMsg
  | ToggleUiMsg;

// ─── persisted settings (chrome.storage.local) ────────────────────────────────

export interface Settings {
  host: string;
  port: number;
  token: string;
  /** '' means "use the engine's current/last voice" (omit from speak) */
  voice: string;
  rate: number;
}

export const DEFAULT_SETTINGS: Settings = {
  host: '127.0.0.1',
  port: 8766,
  token: '',
  voice: '',
  rate: 1
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

/** Key under chrome.storage.session where the offscreen doc mirrors the snapshot. */
export const SNAPSHOT_KEY = 'snapshot';
