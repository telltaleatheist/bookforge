/**
 * Streaming Engine selector — chooses which TTS engine backs the Listen feature
 * (the in-app Play tab, the TTS API server, and the browser extension).
 *
 * ONE ENGINE, AND THE SELECTOR STAYS. Since XTTS was pulled out of the root
 * (2026-09-05) Orpheus is the only pool that implements {@link StreamingEngine},
 * so `StreamEngineName` is a one-member union. The indirection is kept rather
 * than inlined because it is what makes the selection OBSERVABLE (see
 * `observable()` below) and what the TTS Server settings payload, the browser
 * extension's `config` message and the persisted `tts-engine.json` are all
 * written against. Higgs is deliberately not here — see `getAvailableEngines`.
 *
 * The choice persists in `tts-engine.json` (userData) and takes effect on the
 * next engine start.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { orpheusWorkerPool } from './orpheus-worker-pool';
import {
  PlaySettings,
  AudioChunk,
  StreamChunk,
  StreamResult,
  StreamWorkerConfig,
  EngineState,
  LoadVoiceOptions,
} from './orpheus-worker-pool';
import {
  getDefaultE2aPath,
  getPythonInvocation,
  shouldUseWsl2ForOrpheus,
} from './e2a-paths';
import { IDLE_CHOICES, getIdleMinutes, setIdleMinutes } from './stream-idle';

export type StreamEngineName = 'orpheus';

/** The methods the scheduler + API server invoke on an engine pool. */
export interface StreamingEngine {
  setMainWindow(window: Electron.BrowserWindow | null): void;
  startSession(): Promise<{ success: boolean; voices?: string[]; error?: string }>;
  /** Load a voice. `opts.warm` (default true) allows a first load's discarded
   *  warm-up renders; a speak-triggered load passes false so the user isn't kept
   *  waiting on audio nobody hears. Optional because a pool whose checkpoint load
   *  IS its warm-up has nothing discardable to skip: it accepts the option and
   *  ignores it. */
  loadVoice(voice: string, opts?: LoadVoiceOptions): Promise<{ success: boolean; error?: string }>;
  /**
   * Render one sentence through the engine's batch path.
   *
   * `onChunk` is FAST START (Owen's ruling of 2026-09-04, see stream-scheduler's
   * `fastStart`). Supplying it asks the engine to deliver this sentence's audio in
   * sub-sentence chunks WHILE IT IS STILL GENERATING rather than as one payload at
   * the end. An engine that streams that way resolves `{success:true, streamed:true,
   * duration}` and NO `audio` — everything it had to say, it already said through
   * the callback. An engine that does not stream takes the parameter, ignores it,
   * and resolves with `audio` exactly as before — so a caller must handle both and
   * never assume which it got.
   *
   * Omitting `onChunk` is the pre-fast-start contract, unchanged in every respect.
   */
  generateSentence(
    text: string,
    sentenceIndex: number,
    settings: PlaySettings,
    priority?: boolean,
    isCancelled?: () => boolean,
    onChunk?: (chunk: StreamChunk) => void
  ): Promise<{ success: boolean; audio?: AudioChunk; streamed?: boolean; duration?: number; error?: string }>;
  generateSentenceStream(
    text: string,
    settings: PlaySettings,
    onChunk: (chunk: StreamChunk) => void,
    isCancelled?: () => boolean
  ): Promise<StreamResult>;
  /** Optional. Abort the engine's in-flight BATCH, but only if every row still
   *  outstanding in it has been marked stale by its own isCancelled predicate.
   *  Called when a session ends, so a preempting play/voice switch does not have to
   *  wait out ~40s of renders whose results will be thrown away. Absent on engines
   *  whose renders are short or whose batches cannot be interrupted, where a stale
   *  render costs one sentence, not a whole read-ahead window. */
  cancelPendingBatchIfStale?(): void;
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

// Compile-time proof the pool satisfies the contract.
const ENGINES: Record<StreamEngineName, StreamingEngine> = {
  orpheus: orpheusWorkerPool,
};

// ─────────────────────────────────────────────────────────────────────────────
// Persisted selection
// ─────────────────────────────────────────────────────────────────────────────

let selected: StreamEngineName | null = null;

// Persisted in tts-engine.json: the engine choice plus a per-engine default
// voice (so a voice picked in Settings sticks across restarts — the pools'
// lastVoice is in-memory only).
// `engine` is typed `string`, not `StreamEngineName`: this is the ON-DISK shape,
// and a file written by an older build can name an engine this one has retired.
// Deciding what to do about that is getSelectedEngineName's job, and it cannot do
// it if the type has already asserted the file is well-formed.
interface PersistedStreamConfig {
  engine?: string;
  voices?: Record<string, string>;
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
  return v === 'orpheus';
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

/**
 * Engine names this file used to write into `tts-engine.json` and no longer runs.
 * A machine that ever listened on XTTS has `"engine": "xtts"` on disk, and that
 * file outlives the code that wrote it.
 */
const RETIRED_ENGINE_NAMES = new Set(['xtts']);

/**
 * The active streaming engine.
 *
 * THERE IS NO DEFAULTING HERE, and the three cases are deliberately different:
 *
 *  - NOTHING RECORDED (a fresh install, or a file written before the engine was
 *    ever a choice) → Orpheus. Not a fallback: `StreamEngineName` has one member,
 *    so "no choice recorded" and "the only choice" are the same statement.
 *  - A RETIRED NAME (`xtts`) → migrated, loudly, and the file is rewritten so the
 *    stale preference stops being re-read. This is the same shape as
 *    `loadWorkerCfg`'s legacy `cpuWorkers` migration. It is safe in a way a
 *    narration engine substitution would NOT be: Listen renders what it is asked
 *    for sentence by sentence in a voice the user can hear immediately, and there
 *    is no other pool left to route to — the alternative is a Listen feature that
 *    throws forever on every machine that used XTTS, including from the Settings
 *    page that would repair it.
 *  - AN UNKNOWN NAME → refused BY NAME. A string nobody in this build has ever
 *    written is a bug or a hand-edited file, and quietly treating it as Orpheus
 *    would hide it.
 */
export function getSelectedEngineName(): StreamEngineName {
  if (selected !== null) return selected;
  const cfg = readPersisted();
  if (cfg.engine === undefined) {
    selected = 'orpheus';
    return selected;
  }
  if (isEngineName(cfg.engine)) {
    selected = cfg.engine;
    return selected;
  }
  if (!RETIRED_ENGINE_NAMES.has(cfg.engine)) {
    throw new Error(
      `tts-engine.json names a streaming engine this build has never had: "${cfg.engine}". ` +
      `This build streams: ${Object.keys(ENGINES).join(', ')}.`,
    );
  }
  console.error(
    `[StreamingEngine] tts-engine.json selects "${cfg.engine}", which was retired on 2026-09-05. ` +
    'Migrating the saved selection to Orpheus, the only streaming engine this build has.',
  );
  selected = 'orpheus';
  writePersisted({ ...cfg, engine: selected });
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
    async loadVoice(voice: string, opts?: LoadVoiceOptions) {
      const before = pool.getCurrentVoice();
      const result = await pool.loadVoice(voice, opts);
      if (pool.getCurrentVoice() !== before) emitStreamConfigChanged();
      return result;
    },
  };
}

const OBSERVABLE: Record<StreamEngineName, StreamingEngine> = {
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
 * Select the streaming engine and persist the choice.
 *
 * `name` is typed `string`, not `StreamEngineName`, because every caller is a
 * BOUNDARY — the settings IPC and the extension's `config.set` message — where the
 * value arrived as untyped JSON. Typing the parameter as the union would let the
 * compiler assert something only this function can check, and the check is the
 * whole point: an engine this build does not have is REFUSED BY NAME rather than
 * quietly becoming Orpheus.
 *
 * There is one engine, so there is no longer a previous pool to tear down; the
 * function survives because the choice is still persisted, still broadcast to the
 * pickers, and still the place a second engine would be admitted.
 */
export async function setSelectedEngineName(name: string): Promise<void> {
  if (!isEngineName(name)) {
    throw new Error(
      `Unknown streaming engine: ${name}. This build streams: ${Object.keys(ENGINES).join(', ')}.`,
    );
  }
  selected = name;
  const cfg = readPersisted();
  cfg.engine = name;
  writePersisted(cfg);
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

/**
 * The streaming engines the Listen pickers offer.
 *
 * ONE ROW. XTTS was listed-and-disabled for a day (2026-09-04) so a machine still
 * running it would not have the engine torn out from under it; its pool and its
 * Python worker were then removed from the root entirely (2026-09-05), so there
 * is nothing left to list — a disabled row for code that no longer exists is a
 * promise the build cannot keep.
 *
 * Higgs is deliberately ABSENT rather than listed-and-unavailable. It is not a
 * streaming engine at all: the v3 backend is a served vllm-omni endpoint and its
 * codec is a delay-pattern one with no sound windowed decode, so there is no
 * partial support to report — narrator's `HiggsCodec.streaming_decoder()`
 * returns None on purpose. Listing it would promise a Listen feature that does
 * not exist.
 */
export function getAvailableEngines(): EngineInfo[] {
  return [orpheusAvailability()];
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
 * on Orpheus, which is single-worker on a fixed device). Returns the refreshed
 * payload.
 */
export async function setStreamConfig(updates: {
  /** Untyped at the boundary on purpose — see setSelectedEngineName. */
  engine?: string;
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
// Engine-state bridge — forward the pool's state changes as the ACTIVE engine's
// state, so a single subscription (the TTS API server) always reflects reality.
// ─────────────────────────────────────────────────────────────────────────────

export function onActiveEngineState(
  listener: (state: EngineState, isServiceMode: boolean) => void
): () => void {
  return orpheusWorkerPool.onEngineState(() => {
    const engine = getActiveEngine();
    listener(engine.getEngineState(), engine.isServiceMode());
  });
}
