/**
 * TTS engine capability registry — the single source of truth for what each
 * engine can do and how its UI/runtime must be configured.
 *
 * The wizard, pipeline-defaults, and the conversion bridge read from this instead
 * of scattering `if (ttsEngine === 'xtts')` checks. The point: when the user picks
 * an engine, BookForge auto-applies that engine's constraints (device, workers,
 * which controls exist) rather than offering choices the engine can't honor —
 * e.g. Orpheus/Voxtral run vLLM on the GPU and serialize to one worker, so the
 * "CPU" device and the "parallel workers" picker simply don't appear for them.
 *
 * Pure data, no Angular deps, so the Electron main process (bridge/e2a-paths) can
 * import the same definitions and stay in lockstep with the UI.
 */

import type { TTSEngine } from './language-learning.types';

export type TtsDevice = 'auto' | 'cpu' | 'gpu' | 'mps';

/** How the user selects a voice for an engine. */
export interface TtsVoiceModel {
  /**
   * - 'catalog'  → pick from downloadable reference-clip voices (XTTS, F5).
   * - 'preset'   → pick from the engine's built-in named voices (Orpheus, Voxtral).
   */
  kind: 'catalog' | 'preset';
  /** Built-in named voices, for `kind: 'preset'` engines. */
  presets?: { id: string; label: string }[];
  /** Show the "＋ Download more voices…" link (catalog engines). */
  canDownloadMore?: boolean;
  /** Supports zero-shot cloning from a reference clip (Voxtral, F5, XTTS-custom). */
  canClone?: boolean;
}

/** Which advanced controls to show — and, by the same token, which CLI args the
 *  bridge forwards for this engine. A missing/false key = neither shown nor sent. */
export interface TtsSamplingControls {
  temperature?: boolean;
  topP?: boolean;
  topK?: boolean;
  repetitionPenalty?: boolean;
  cfgAlpha?: boolean; // Voxtral flow-matching guidance
  speed?: boolean;
}

export interface TtsEngineCaps {
  id: TTSEngine;
  displayName: string;
  /** Sub-label shown under the name in the engine picker. */
  statusText: string;

  /**
   * Component id that must report installed (ComponentService.isInstalled) before
   * this engine is selectable. null = always available (bundled with the app).
   */
  requiresComponent: string | null;

  /**
   * 'native' → runs in the managed/relocatable env in-process.
   * 'wsl'    → on Windows, routed through WSL (vLLM CUDA-graph path). The bridge
   *            spawns it via wsl.exe; on macOS/Linux it runs natively.
   */
  runtime: 'native' | 'wsl';

  /** Device policy. The wizard uses this to decide which device buttons to show
   *  and what to auto-select when the engine is picked. */
  device: {
    /** false → no CPU option; the engine must run on the GPU (vLLM engines). */
    cpuCapable: boolean;
    /** true → CPU is not a valid fallback at all (hard GPU requirement). */
    gpuRequired: boolean;
  };

  /**
   * Max parallel TTS workers. 1 = no parallelism → the wizard hides the worker
   * picker and forces a single worker. (vLLM engines batch internally, so they're
   * always 1 "worker" from the pipeline's point of view.) A value >1 means "up to
   * N, subject to the user's WorkerConfig + the non-GPU rule already in the UI".
   */
  maxWorkers: number;

  voices: TtsVoiceModel;
  sampling: TtsSamplingControls;
}

// Orpheus finetune voices (e2a VALID_VOICES), ordered best → worst prosody
// (user-ranked). leah leads → presets[0] is the default. Accent noted in label.
const ORPHEUS_VOICES = [
  { id: 'leah', label: 'Leah (Female, American)' },
  { id: 'tara', label: 'Tara (Female, American)' },
  { id: 'zoe', label: 'Zoe (Female, American)' },
  { id: 'mia', label: 'Mia (Female, American)' },
  { id: 'jess', label: 'Jess (Female, American)' },
  { id: 'zac', label: 'Zac (Male, American)' },
  { id: 'dan', label: 'Dan (Male, Cockney)' },
  { id: 'leo', label: 'Leo (Male, American)' },
];
// Folder-discovered custom Orpheus models (runtime/orpheus-models/<voice>/) are
// appended to these built-ins at runtime — see ll-wizard's loadOrpheusModels().

// Voxtral English presets (the model also ships de/es/fr/it/nl/pt/hi/ar presets and
// supports reference-audio cloning — see canClone).
const VOXTRAL_EN_VOICES = [
  { id: 'neutral_male', label: 'Neutral Male' },
  { id: 'neutral_female', label: 'Neutral Female' },
  { id: 'casual_male', label: 'Casual Male' },
  { id: 'casual_female', label: 'Casual Female' },
  { id: 'cheerful_female', label: 'Cheerful Female' },
];

export const TTS_ENGINES: Record<TTSEngine, TtsEngineCaps> = {
  xtts: {
    id: 'xtts',
    displayName: 'XTTS',
    statusText: 'Multi-language',
    requiresComponent: null, // bundled
    runtime: 'native',
    device: { cpuCapable: true, gpuRequired: false },
    maxWorkers: 4,
    voices: { kind: 'catalog', canDownloadMore: true, canClone: true },
    sampling: { temperature: true, topP: true, topK: true, repetitionPenalty: true, speed: true },
  },

  orpheus: {
    id: 'orpheus',
    displayName: 'Orpheus',
    statusText: 'Better prosody',
    requiresComponent: 'orpheus',
    runtime: 'native', // native per-engine conda env (point-to-install)
    device: { cpuCapable: false, gpuRequired: true },
    maxWorkers: 1, // vLLM; serializes
    voices: { kind: 'preset', presets: ORPHEUS_VOICES },
    sampling: {}, // fixed internal sampling
  },

  voxtral: {
    id: 'voxtral',
    displayName: 'Voxtral',
    statusText: 'ElevenLabs-class · clone or preset',
    requiresComponent: 'voxtral-env',
    runtime: 'native', // native per-engine conda env (point-to-install), like Orpheus
    device: { cpuCapable: false, gpuRequired: true },
    maxWorkers: 1, // multi-stage vLLM; batches internally
    voices: { kind: 'preset', presets: VOXTRAL_EN_VOICES, canClone: true },
    // Fixed tuned defaults, no user sliders — like Orpheus. The engine class
    // sets the right per-backend params (MLX: temp 0.35/top_p 0.9/top_k 50;
    // vLLM: cfg_alpha), so exposing a control would only mislead.
    sampling: {},
  },

  f5: {
    id: 'f5',
    displayName: 'F5-TTS',
    statusText: 'Flow-matching · strong long-form',
    requiresComponent: 'f5-env',
    runtime: 'native', // native Windows (cu121 wheel) + native macOS (MLX)
    device: { cpuCapable: true, gpuRequired: false },
    maxWorkers: 2,
    voices: { kind: 'catalog', canDownloadMore: true, canClone: true },
    sampling: { speed: true },
  },
};

/** Capabilities for an engine (throws on unknown id — no silent fallback). */
export function engineCaps(id: TTSEngine): TtsEngineCaps {
  const caps = TTS_ENGINES[id];
  if (!caps) throw new Error(`Unknown TTS engine: ${id}`);
  return caps;
}

/**
 * Engines selectable right now, in display order. `isInstalled` gates engines that
 * require an optional component (Orpheus/Voxtral/F5 envs); bundled engines always
 * pass. Pass `componentService.isInstalled` bound to its service.
 */
export function selectableEngines(isInstalled: (componentId: string) => boolean): TtsEngineCaps[] {
  const order: TTSEngine[] = ['xtts', 'f5', 'orpheus', 'voxtral'];
  return order
    .map((id) => TTS_ENGINES[id])
    .filter((c) => c.requiresComponent === null || isInstalled(c.requiresComponent));
}
