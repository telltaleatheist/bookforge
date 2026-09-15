/**
 * Streaming Engine selector — chooses which TTS engine backs the Listen feature
 * (the in-app Play and Streaming tabs, and the Bookshelf reader bridge).
 *
 * ONE ENGINE, and one place it can run. Higgs is the engine; a Crucible server
 * is where it runs. The local narrator worker pool that used to back this
 * interface is DELETED (docs/LEGACY-REMOVAL.md), so `getActiveEngine()` is a
 * Crucible streaming session and nothing else — and this module's remaining job
 * is the SELECTION: the thing the Streaming tab's payload, the browser
 * extension's `config` message and the persisted `tts-engine.json` are written
 * against, and what makes a voice change OBSERVABLE (see `observable()` below).
 *
 * ORPHEUS IS RETIRED HERE, NOT DROPPED — the same treatment narration gave it
 * (`shared/tts/engine-caps.ts`, commits c167d5ea / b593e56f). A `tts-engine.json`
 * that names it still PARSES and still has something to display; it simply can
 * no longer be chosen, and a saved selection is migrated loudly to Higgs. The
 * alternative — refusing an id this build once wrote — is a Listen feature that
 * throws forever on every machine that ever listened on Orpheus, including from
 * the Settings page that would repair it.
 *
 * ONE THING A HIGGS VOICE CHANGE COSTS: it is a SERVER RESTART. A fine-tuned
 * voice IS the merged checkpoint the engine was started on, and vLLM-Omni has no
 * adapter flags, so `set_voice` refuses in place by name.
 *
 * The choice persists in `tts-engine.json` (userData) and takes effect on the
 * next engine start.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  PlaySettings,
  AudioChunk,
  StreamChunk,
  StreamResult,
  StreamWorkerConfig,
  EngineState,
  LoadVoiceOptions,
} from './streaming-contract';
import { listRenderableHiggsModels } from './higgs-models';
import { IDLE_CHOICES, getIdleMinutes, setIdleMinutes } from './stream-idle';
import { CrucibleStreamingEngine, venueRoutedStreamingEngine } from './crucible/stream';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './crucible/servers';
import { processVenueHost } from './crucible/generation-venue';

/**
 * The engines the Listen pickers may SELECT. One.
 *
 * See {@link RETIRED_STREAM_ENGINES} for the ids this build can still name and
 * will not run — `orpheus`, `xtts`. The two lists are separate on purpose: a
 * retired id has to stay nameable, because `tts-engine.json` outlives the code
 * that wrote it.
 */
export type StreamEngineName = 'higgs';

/** Every selectable id, derived once so no second hand-written list exists. */
const STREAM_ENGINE_NAMES: readonly StreamEngineName[] = ['higgs'];

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
  /**
   * Optional. THE LENGTH THIS ENGINE STATES for `voice`, when the engine is
   * somewhere else and publishes its own facts — a Crucible's `GET /v1/voices`
   * (`electron/crucible/voice-band.ts`). The surfaces pack their rows before the
   * scheduler ever sees them, and this is how they pack to the numbers the
   * machine that will speak them enforces rather than to this machine's catalog.
   *
   * ABSENT — the local narrator pool — is not a gap: that engine IS this
   * machine's narrator, and `electron/data/higgs-models.json` is how it was
   * configured, so the catalog's band is the engine's own. A backend that HAS an
   * answer and cannot give it yet resolves `null`, and the caller refuses rather
   * than packing to somebody else's numbers.
   */
  statedChunkCaps?(voice: string): Promise<{
    maxChars: number | null;
    safeMinChars: number | null;
    safeMaxChars: number | null;
  } | null>;
}

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
  // DERIVED FROM the one list, never a second literal. It was `v === 'orpheus'`,
  // written when there was one engine — and it stayed that way when Higgs was
  // added to the union, to `getAvailableEngines()`, to the Settings picker and to
  // the extension's engine menu. Every surface offered Higgs and this one
  // function refused it by name, so selecting it failed with "Unknown streaming
  // engine: higgs. This build streams: orpheus, higgs." — a message that
  // contradicts itself. A hand-written second copy has no way to be right for
  // long.
  return typeof v === 'string' && (STREAM_ENGINE_NAMES as readonly string[]).includes(v);
}

// Fired whenever the stream selection changes (engine or default voice), from
// ANY source — the in-app Settings picker or an extension client's config.set.
// Consumers fan it out to their transport: the reader bridge rebroadcasts a
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
 * Engine ids this file used to write into `tts-engine.json` and no longer runs —
 * NAMEABLE, never selectable. A machine that ever listened on XTTS has
 * `"engine": "xtts"` on disk, and one that listened last week has
 * `"engine": "orpheus"`; that file outlives the code that wrote it.
 *
 * The display name is kept so a surface asked about a saved selection has
 * something true to show, which is what "retired, not dropped" means
 * (`shared/tts/engine-caps.ts` does the same for narration).
 */
const RETIRED_STREAM_ENGINES = new Map<string, { label: string; since: string; reason: string }>([
  ['xtts', {
    label: 'XTTS',
    since: '2026-09-05',
    reason: 'XTTS was retired as a streaming engine — every voice BookForge ships is a Higgs model.',
  }],
  ['orpheus', {
    label: 'Orpheus',
    since: '2026-09-15',
    reason: 'Orpheus was retired with the local narrator spawn (docs/LEGACY-REMOVAL.md). Higgs is '
      + 'the one engine BookForge streams, and it streams on a Crucible server.',
  }],
]);

/** How a saved id reads on a surface — "Orpheus (retired)", or the id itself. */
export function streamEngineLabel(id: string): string {
  const retired = RETIRED_STREAM_ENGINES.get(id);
  if (retired !== undefined) return `${retired.label} (retired)`;
  return id === 'higgs' ? 'Higgs' : id;
}

/**
 * The active streaming engine.
 *
 * THERE IS NO DEFAULTING HERE, and the three cases are deliberately different:
 *
 *  - NOTHING RECORDED (a fresh install, or a file written before the engine was
 *    ever a choice) → Higgs, the one engine this build streams.
 *  - A RETIRED NAME (`xtts`, `orpheus`) → migrated, loudly, and the file is
 *    rewritten so the stale preference stops being re-read. It is safe in a way a
 *    narration engine substitution would NOT be: Listen renders what it is asked
 *    for sentence by sentence in a voice the user can hear immediately, and there
 *    is no other pool left to route to — the alternative is a Listen feature that
 *    throws forever on every machine that used the retired engine, including from
 *    the Settings page that would repair it.
 *  - AN UNKNOWN NAME → refused BY NAME. A string nobody in this build has ever
 *    written is a bug or a hand-edited file, and quietly treating it as Higgs
 *    would hide it.
 */
export function getSelectedEngineName(): StreamEngineName {
  if (selected !== null) return selected;
  const cfg = readPersisted();
  if (cfg.engine === undefined) {
    selected = 'higgs';
    return selected;
  }
  if (isEngineName(cfg.engine)) {
    selected = cfg.engine;
    return selected;
  }
  const retired = RETIRED_STREAM_ENGINES.get(cfg.engine);
  if (retired === undefined) {
    throw new Error(
      `tts-engine.json names a streaming engine this build has never had: "${cfg.engine}". ` +
      `This build streams: ${STREAM_ENGINE_NAMES.join(', ')}.`,
    );
  }
  console.error(
    `[StreamingEngine] tts-engine.json selects "${cfg.engine}", which was retired on ` +
    `${retired.since}. ${retired.reason} Migrating the saved selection to Higgs.`,
  );
  selected = 'higgs';
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
 * and both transports rebroadcast it (main → renderer, reader bridge → phone).
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

// ─────────────────────────────────────────────────────────────────────────────
// The venue: WHICH Crucible server holds this Listen session (2026-09-14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Crucible Listen backend — one instance for the process, because a
 * Crucible holds ONE streaming session and this is the object that holds it.
 * Exported for the quit path (main.ts closes it) and for nothing else: every
 * other caller goes through {@link getActiveEngine}, which is what decides which
 * SERVER it is bound to.
 */
export const crucibleListenEngine = new CrucibleStreamingEngine({
  selectedEngine: getSelectedEngineName,
  clientFor: (server) => crucibleClientFor(server, CRUCIBLE_CLIENT_NAME),
});

/**
 * What every caller reaches: the Crucible backend, bound to a SERVER at cold
 * start by `decideWhereGenerationRuns` (crucible/generation-venue.ts — the SAME
 * decision the audiobook render makes). See crucible/stream.ts for the rules.
 * The three streaming surfaces and the scheduler call this and never learn which
 * machine answered.
 */
const VENUE_ROUTED: StreamingEngine = venueRoutedStreamingEngine({
  crucible: observable(crucibleListenEngine),
  crucibleEngine: crucibleListenEngine,
  venue: processVenueHost(),
});

export function getActiveEngine(): StreamingEngine {
  return VENUE_ROUTED;
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
      `Unknown streaming engine: ${name}. ${
        RETIRED_STREAM_ENGINES.has(name)
          ? `"${name}" was retired on ${RETIRED_STREAM_ENGINES.get(name)!.since}: `
            + `${RETIRED_STREAM_ENGINES.get(name)!.reason} `
          : ''
      }This build streams: ${STREAM_ENGINE_NAMES.join(', ')}.`,
    );
  }
  if (name === getSelectedEngineName()) return;

  // AN UNAVAILABLE ENGINE IS REFUSED, with the reason the picker would have shown.
  //
  // Selecting one used to succeed: the name is spelled correctly, so nothing
  // objected, and the failure arrived later as every `speak` erroring against an
  // environment that is not there — with the Settings page reporting the engine
  // happily selected. That is the same shape as an availability probe that lies,
  // and the fix is the same: refuse where the user can still act on it.
  //
  // A MISSING entry is a refusal too, not a pass. `ENGINES` and
  // `getAvailableEngines()` are two hand-maintained lists in the same file, and
  // `if (info && ...)` read "not in the availability list ⇒ allow it" — so the one
  // mistake this check exists to catch, an engine added to one list and forgotten in
  // the other, was the exact case it waved through.
  const info = getAvailableEngines().find((e) => e.id === name);
  if (!info) {
    throw new Error(
      `Streaming engine '${name}' is selectable but not in getAvailableEngines(), so `
      + 'nothing can say whether this machine can run it. Refusing to select an engine '
      + 'with no availability answer — add it to getAvailableEngines().',
    );
  }
  if (!info.available) {
    throw new Error(`${info.name} cannot stream on this machine. ${info.reason ?? ''}`.trim());
  }

  // THE SESSION MUST GO. A Crucible streaming session is opened on ONE engine
  // and one resident voice; leaving it up would have the app reporting one
  // engine while the session went on answering from another, which is the worst
  // available outcome: audio that is fine, in the wrong voice, with nothing
  // anywhere saying so.
  //
  // Ended BEFORE the selection is written, so a failure to stop leaves the
  // selection alone rather than pointing at an engine that is not running.
  await getActiveEngine().endSession();

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

/**
 * IS HIGGS STREAMABLE FROM THIS MACHINE?
 *
 * TWO questions now, where there used to be three. The platform and the
 * environment were about the LOCAL spawn — "does this box have a vLLM-Omni it
 * can start" — and there is no local spawn any more: the engine runs on a
 * Crucible server, whose own `/v1/capability` and `409` answer for it, in its
 * own words, at the moment a session is opened. Re-asking here would be this
 * app's second opinion about somebody else's card (crucible
 * `docs/ARCHITECTURE.md` R1) and would refuse a perfectly good Mac render
 * because THIS machine has no WSL.
 *
 * What is still ours to answer is THE VOICE. Higgs has no built-in voices the
 * way Orpheus had prompt tokens — every voice is a catalog entry whose artifact
 * is installed or is not, and a voice whose artifact is missing would serve the
 * model's own default speaker: measured at 12% of the narrator's ECAPA ceiling,
 * a DIFFERENT person rather than a bad clone. So "no voice installed" is "not
 * available", and it is a fact about this machine's catalog.
 *
 * WHAT IS *NOT* A REASON TO REFUSE: the absence of sub-sentence streaming.
 * Higgs's codec has no sound windowed decode (its delay pattern leaves a
 * window's last frames incomplete by construction), so it cannot emit audio
 * mid-sentence — but whole rows arrive at retirement, which is a latency
 * difference, not a missing feature. An earlier version of this file refused the
 * engine outright over it.
 */
function higgsAvailability(): EngineInfo {
  const unavailable = (reason: string): EngineInfo =>
    ({ id: 'higgs', name: 'Higgs', available: false, reason });

  let voices: string[];
  try {
    voices = listRenderableHiggsModels(app.getPath('userData')).map((m) => m.id);
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : 'Higgs voice catalog unreadable');
  }
  if (voices.length === 0) {
    return unavailable(
      'No Higgs voice is installed. Install one in Settings \u2192 Higgs \u2014 a voice whose '
      + 'artifact is missing would render in the model\'s own speaker, not the one chosen.',
    );
  }
  return { id: 'higgs', name: 'Higgs', available: true };
}

/**
 * The streaming engines the Listen pickers offer.
 *
 * ONE ROW, with `available` and a `reason` carrying the truth — the pickers
 * disable an unavailable engine and show its reason on hover. A RETIRED engine
 * is not listed here: a row for an engine nothing can run is a promise the build
 * cannot keep, and it is nameable through {@link streamEngineLabel} instead,
 * which is what a surface asked about a SAVED selection needs.
 */
export function getAvailableEngines(): EngineInfo[] {
  return [higgsAvailability()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Config facade (for the Streaming tab / IPC)
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamConfigPayload extends StreamWorkerConfig {
  engine: StreamEngineName;
  engines: EngineInfo[];
  // Voice selection for the active engine (the Streaming tab's picker).
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
 * Apply a settings update from the Streaming tab. `engine` switches the active
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
// state, so a single subscription always reflects reality.
// ─────────────────────────────────────────────────────────────────────────────

export function onActiveEngineState(
  listener: (state: EngineState, isServiceMode: boolean) => void
): () => void {
  // The facade subscribes to BOTH backends and reports the active one's state.
  return getActiveEngine().onEngineState(listener);
}
