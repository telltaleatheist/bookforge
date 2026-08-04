/**
 * Streaming Engine selector — chooses which TTS engine backs the Listen feature
 * (the in-app Play tab, the TTS API server, and the browser extension).
 *
 * Both engine pools (XTTS, Orpheus) expose the same {@link StreamingEngine} surface,
 * so the stream-scheduler and TTS API server drive whichever one is active without
 * caring which it is. The choice persists in `tts-engine.json` (userData) and takes
 * effect on the next engine start: switching engines stops the previously-active
 * pool so the next `speak` warms the newly-chosen one.
 *
 * The XTTS pool's own worker-count/device settings live in `tts-stream.json` and are
 * untouched by the engine switch — switch to Orpheus and back, and the XTTS topology
 * is exactly as it was.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { xttsWorkerPool } from './xtts-worker-pool';
import { orpheusWorkerPool } from './orpheus-worker-pool';
import {
  PlaySettings,
  AudioChunk,
  StreamChunk,
  StreamResult,
  StreamWorkerConfig,
  EngineState,
} from './xtts-worker-pool';
import {
  getDefaultE2aPath,
  getPythonInvocation,
  shouldUseWsl2ForOrpheus,
} from './e2a-paths';
import { IDLE_CHOICES, getIdleMinutes, setIdleMinutes } from './stream-idle';

export type StreamEngineName = 'xtts' | 'orpheus';

/** The methods the scheduler + API server invoke on an engine pool. Both pools
 *  implement this; getVoiceCatalog (XTTS-only, in-app dropdown) is intentionally
 *  NOT part of it and is accessed on xttsWorkerPool directly where needed. */
export interface StreamingEngine {
  setMainWindow(window: Electron.BrowserWindow | null): void;
  startSession(): Promise<{ success: boolean; voices?: string[]; error?: string }>;
  loadVoice(voice: string): Promise<{ success: boolean; error?: string }>;
  generateSentence(
    text: string,
    sentenceIndex: number,
    settings: PlaySettings,
    priority?: boolean,
    isCancelled?: () => boolean
  ): Promise<{ success: boolean; audio?: AudioChunk; error?: string }>;
  generateSentenceStream(
    text: string,
    settings: PlaySettings,
    onChunk: (chunk: StreamChunk) => void,
    isCancelled?: () => boolean
  ): Promise<StreamResult>;
  cancelStreaming(): void;
  stop(): void;
  endSession(): Promise<void>;
  isSessionActive(): boolean;
  getAvailableVoices(): string[];
  getCurrentVoice(): string | null;
  /** Optional. True when `voice` can be rendered per REQUEST, so a client asking
   *  for it does not conflict with whatever else is loaded (Orpheus built-ins and
   *  LoRA-adapter voices on the vLLM backend). Absent, or false, means loading a
   *  voice is exclusive and a mismatch between requested and loaded is a real error. */
  canServeVoicePerRequest?(voice: string): boolean;
  /** Optional. True when loading `voice` would tear down and REBUILD the engine
   *  (different weights), as opposed to registering a voice on the warm one. Absent
   *  means the engine has no cheap-switch concept and every load is a rebuild's
   *  worth of work — callers that only guard against thrash treat that as false. */
  wouldRebuildEngine?(voice: string): boolean;
  getLastVoice(): string | null;
  getDefaultVoice(): string;
  getWorkerCount(): number;
  /** Max sentences the scheduler may keep in flight per session. Defaults to
   *  getWorkerCount(); a batching engine (Orpheus) reports its batch size so the
   *  scheduler dispatches a batch's worth at once for the pool to coalesce. */
  getMaxConcurrentSentences?(): number;
  getEngineState(): EngineState;
  isServiceMode(): boolean;
  setServiceMode(on: boolean): void;
  onEngineState(listener: (state: EngineState, isServiceMode: boolean) => void): () => void;
  getStreamWorkerConfig(): StreamWorkerConfig;
  setStreamWorkerConfig(updates: {
    enabled?: boolean;
    count?: number;
    devicePref?: StreamWorkerConfig['devicePref'];
  }): StreamWorkerConfig;
}

// Compile-time proof both pools satisfy the contract.
const ENGINES: Record<StreamEngineName, StreamingEngine> = {
  xtts: xttsWorkerPool,
  orpheus: orpheusWorkerPool,
};

// ─────────────────────────────────────────────────────────────────────────────
// Persisted selection
// ─────────────────────────────────────────────────────────────────────────────

let selected: StreamEngineName | null = null;

// Persisted in tts-engine.json: the engine choice plus a per-engine default
// voice (so a voice picked in Settings sticks across restarts — the pools'
// lastVoice is in-memory only).
interface PersistedStreamConfig {
  engine?: StreamEngineName;
  voices?: Partial<Record<StreamEngineName, string>>;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'tts-engine.json');
}

function readPersisted(): PersistedStreamConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};  // First run / unreadable
  }
}

function writePersisted(cfg: PersistedStreamConfig): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[StreamingEngine] Failed to persist tts-engine.json:', err);
  }
}

function isEngineName(v: unknown): v is StreamEngineName {
  return v === 'xtts' || v === 'orpheus';
}

// Fired whenever the stream selection changes (engine or default voice), from
// ANY source — the in-app Settings picker or an extension client's config.set.
// Consumers fan it out to their transport: the TTS API server rebroadcasts a
// `config` message to WS clients (extension), and main forwards it to the
// renderer so the Angular voice picker refreshes. This is what keeps the two
// pickers live-synced.
type StreamConfigListener = () => void;
const configListeners = new Set<StreamConfigListener>();

export function onStreamConfigChanged(listener: StreamConfigListener): () => void {
  configListeners.add(listener);
  return () => { configListeners.delete(listener); };
}

function emitStreamConfigChanged(): void {
  for (const l of configListeners) {
    try { l(); } catch (err) { console.error('[StreamingEngine] config listener error:', err); }
  }
}

export function getSelectedEngineName(): StreamEngineName {
  if (selected !== null) return selected;
  const cfg = readPersisted();
  selected = isEngineName(cfg.engine) ? cfg.engine : 'xtts';
  return selected;
}

/**
 * Every caller reaches a pool through this facade, which exists for one reason:
 * a voice load has to be OBSERVABLE. `loadVoice` is called from six places (the
 * Listen tab, a book render, the bookshelf server, the reader bridge, the TTS API
 * server's ensureEngine, and setDefaultStreamVoice), and all but the last changed
 * the loaded model without telling anyone — so the app's picker and the browser
 * extension's picker could each be showing a narrator that isn't in memory. The
 * wrapper fires the config event whenever a load actually changes the live voice,
 * and both transports rebroadcast it (main → renderer, TTS API server → clients).
 *
 * Spread-copied rather than subclassed: the pools are plain function-object
 * literals whose functions close over module state and never use `this`.
 */
function observable(pool: StreamingEngine): StreamingEngine {
  return {
    ...pool,
    async loadVoice(voice: string) {
      const before = pool.getCurrentVoice();
      const result = await pool.loadVoice(voice);
      if (pool.getCurrentVoice() !== before) emitStreamConfigChanged();
      return result;
    },
  };
}

const OBSERVABLE: Record<StreamEngineName, StreamingEngine> = {
  xtts: observable(ENGINES.xtts),
  orpheus: observable(ENGINES.orpheus),
};

export function getActiveEngine(): StreamingEngine {
  return OBSERVABLE[getSelectedEngineName()];
}

/**
 * The default voice to warm on start: the per-engine voice persisted from the
 * Settings picker, else the active pool's own default. Used by every start path
 * so a user's chosen voice survives app/engine restarts (the pools only keep
 * lastVoice in memory).
 */
export function getDefaultStreamVoice(): string {
  const engine = getSelectedEngineName();
  const persisted = readPersisted().voices?.[engine];
  const available = getActiveEngine().getAvailableVoices();
  if (persisted && (available.length === 0 || available.includes(persisted))) {
    return persisted;
  }
  return getActiveEngine().getDefaultVoice();
}

/**
 * Persist the default voice for the active engine and, when a session is live,
 * apply it immediately. On Orpheus a custom finetune is its OWN model, so this
 * makes the worker reload that model — the caller must therefore be told whether
 * it actually took. A failure here used to be logged and swallowed, which let a
 * client believe it had switched while the engine kept generating in the old
 * voice; the result is returned so the caller can surface it instead.
 */
export async function setDefaultStreamVoice(voice: string): Promise<{ success: boolean; error?: string }> {
  const engine = getSelectedEngineName();
  const cfg = readPersisted();
  cfg.voices = { ...cfg.voices, [engine]: voice };
  writePersisted(cfg);
  let result: { success: boolean; error?: string } = { success: true };
  if (getActiveEngine().isSessionActive()) {
    try {
      result = await getActiveEngine().loadVoice(voice);
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.success) {
      console.error('[StreamingEngine] Failed to warm new default voice live:', result.error);
    }
  }
  emitStreamConfigChanged();
  return result;
}

/**
 * Switch the streaming engine. Persists the choice and stops the previously-active
 * pool so the next start warms the newly-chosen one. No-op (besides persistence)
 * when the name is unchanged.
 */
export async function setSelectedEngineName(name: StreamEngineName): Promise<void> {
  if (!isEngineName(name)) throw new Error(`Unknown streaming engine: ${name}`);
  const prev = getSelectedEngineName();
  selected = name;
  const cfg = readPersisted();
  cfg.engine = name;
  writePersisted(cfg);
  if (prev !== name) {
    // Free the old engine's process/VRAM; the new one starts on the next speak.
    console.log(`[StreamingEngine] Switching ${prev} → ${name}; stopping previous engine`);
    try {
      await ENGINES[prev].endSession();
    } catch (err) {
      console.error('[StreamingEngine] Error stopping previous engine:', err);
    }
  }
  // Engine switch changes the available voice set + default voice — sync pickers.
  emitStreamConfigChanged();
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability (best-effort; the real failure path is a clear startSession error)
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineInfo {
  id: StreamEngineName;
  name: string;
  available: boolean;
  reason?: string;
}

function orpheusAvailability(): EngineInfo {
  // Windows + "WSL2 for Orpheus": Orpheus runs in WSL — assume usable (same trust
  // as the batch pipeline; a misconfigured WSL surfaces at start).
  if (process.platform === 'win32' && shouldUseWsl2ForOrpheus()) {
    return { id: 'orpheus', name: 'Orpheus', available: true };
  }
  // Otherwise it needs a resolvable native Orpheus env (Mac e2a/MLX, or a managed/
  // external env on Windows/Linux). getPythonInvocation throws if it can't be found.
  try {
    getPythonInvocation(getDefaultE2aPath(), 'orpheus');
    return { id: 'orpheus', name: 'Orpheus', available: true };
  } catch (err) {
    return {
      id: 'orpheus',
      name: 'Orpheus',
      available: false,
      reason: err instanceof Error ? err.message : 'Orpheus environment not found',
    };
  }
}

export function getAvailableEngines(): EngineInfo[] {
  return [
    { id: 'xtts', name: 'XTTS', available: true },
    orpheusAvailability(),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Config facade (for the TTS Server settings UI / IPC)
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamConfigPayload extends StreamWorkerConfig {
  engine: StreamEngineName;
  engines: EngineInfo[];
  // Voice selection for the active engine (TTS Server settings picker).
  voices: string[];            // voices the active engine can use
  voice: string;               // the persisted default (what start will warm)
  currentVoice: string | null; // the live-loaded voice, when a session is running
  /** Minutes of inactivity before the engine shuts itself down (0 = never). */
  idleMinutes: number;
  /** The windows clients should offer, so every picker shows the same ladder. */
  idleChoices: number[];
  /** Set by setStreamConfig when a requested voice did NOT load. `currentVoice`
   *  then still names the model actually in memory — the picker shows the truth
   *  and this says why it isn't what was asked for. */
  voiceError?: string;
}

/** Active engine's worker config plus the engine selection + availability + voice. */
export function getStreamConfigPayload(): StreamConfigPayload {
  const engine = getActiveEngine();
  return {
    ...engine.getStreamWorkerConfig(),
    engine: getSelectedEngineName(),
    engines: getAvailableEngines(),
    voices: engine.getAvailableVoices(),
    voice: getDefaultStreamVoice(),
    currentVoice: engine.getCurrentVoice(),
    idleMinutes: getIdleMinutes(),
    idleChoices: IDLE_CHOICES,
  };
}

/**
 * Apply a settings update from the TTS Server UI. `engine` switches the active
 * engine; worker-count/device updates are delegated to the active engine (a no-op
 * on Orpheus, persisted for XTTS). Returns the refreshed payload.
 */
export async function setStreamConfig(updates: {
  engine?: StreamEngineName;
  enabled?: boolean;
  count?: number;
  devicePref?: StreamWorkerConfig['devicePref'];
  voice?: string;
  idleMinutes?: number;
}): Promise<StreamConfigPayload> {
  if (updates.engine && updates.engine !== getSelectedEngineName()) {
    await setSelectedEngineName(updates.engine);
  }
  // Applies to the running engine on its next idle sweep — no restart needed.
  if (typeof updates.idleMinutes === 'number') {
    setIdleMinutes(updates.idleMinutes);
    emitStreamConfigChanged();
  }
  const workerUpdates: { enabled?: boolean; count?: number; devicePref?: StreamWorkerConfig['devicePref'] } = {};
  if (typeof updates.enabled === 'boolean') workerUpdates.enabled = updates.enabled;
  if (typeof updates.count === 'number') workerUpdates.count = updates.count;
  if (updates.devicePref) workerUpdates.devicePref = updates.devicePref;
  if (Object.keys(workerUpdates).length > 0) {
    getActiveEngine().setStreamWorkerConfig(workerUpdates);
  }
  // Voice is applied AFTER any engine switch above, so it targets the now-active
  // engine and persists/warms against it.
  //
  // A live load that FAILS is reported, not swallowed. On Orpheus the voice is a
  // whole model: swallowing the failure leaves the engine reading in the OLD
  // narrator while the user believes they changed it — the in-app half of "I set it
  // to deathstalker and it played thirdreich". The payload still goes back (it
  // carries the voice genuinely loaded), with the error alongside it.
  let voiceError: string | undefined;
  if (updates.voice) {
    const applied = await setDefaultStreamVoice(updates.voice);
    if (!applied.success) {
      voiceError = applied.error || `failed to load voice '${updates.voice}'`;
    }
  }
  return { ...getStreamConfigPayload(), voiceError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine-state bridge — forward BOTH pools' state changes as the ACTIVE engine's
// state, so a single subscription (the TTS API server) always reflects reality
// regardless of which pool fired (e.g. the old pool stopping during a switch).
// ─────────────────────────────────────────────────────────────────────────────

export function onActiveEngineState(
  listener: (state: EngineState, isServiceMode: boolean) => void
): () => void {
  const forward = () => {
    const engine = getActiveEngine();
    listener(engine.getEngineState(), engine.isServiceMode());
  };
  const offXtts = xttsWorkerPool.onEngineState(forward);
  const offOrpheus = orpheusWorkerPool.onEngineState(forward);
  return () => {
    offXtts();
    offOrpheus();
  };
}
