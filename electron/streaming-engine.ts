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
  getLastVoice(): string | null;
  getDefaultVoice(): string;
  getWorkerCount(): number;
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

function configPath(): string {
  return path.join(app.getPath('userData'), 'tts-engine.json');
}

function isEngineName(v: unknown): v is StreamEngineName {
  return v === 'xtts' || v === 'orpheus';
}

export function getSelectedEngineName(): StreamEngineName {
  if (selected !== null) return selected;
  let resolved: StreamEngineName = 'xtts';
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    if (isEngineName(cfg.engine)) resolved = cfg.engine;
  } catch {
    // First run / unreadable — default to XTTS.
  }
  selected = resolved;
  return resolved;
}

export function getActiveEngine(): StreamingEngine {
  return ENGINES[getSelectedEngineName()];
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
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ engine: name }, null, 2));
  } catch (err) {
    console.error('[StreamingEngine] Failed to persist engine choice:', err);
  }
  if (prev !== name) {
    // Free the old engine's process/VRAM; the new one starts on the next speak.
    console.log(`[StreamingEngine] Switching ${prev} → ${name}; stopping previous engine`);
    try {
      await ENGINES[prev].endSession();
    } catch (err) {
      console.error('[StreamingEngine] Error stopping previous engine:', err);
    }
  }
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
}

/** Active engine's worker config plus the engine selection + availability. */
export function getStreamConfigPayload(): StreamConfigPayload {
  return {
    ...getActiveEngine().getStreamWorkerConfig(),
    engine: getSelectedEngineName(),
    engines: getAvailableEngines(),
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
}): Promise<StreamConfigPayload> {
  if (updates.engine && updates.engine !== getSelectedEngineName()) {
    await setSelectedEngineName(updates.engine);
  }
  const workerUpdates: { enabled?: boolean; count?: number; devicePref?: StreamWorkerConfig['devicePref'] } = {};
  if (typeof updates.enabled === 'boolean') workerUpdates.enabled = updates.enabled;
  if (typeof updates.count === 'number') workerUpdates.count = updates.count;
  if (updates.devicePref) workerUpdates.devicePref = updates.devicePref;
  if (Object.keys(workerUpdates).length > 0) {
    getActiveEngine().setStreamWorkerConfig(workerUpdates);
  }
  return getStreamConfigPayload();
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
