/**
 * WHAT EACH TTS ENGINE CAN DO — the capability table, declared once for every
 * process that has to act on it.
 *
 * ── Why this is in `shared/` ────────────────────────────────────────────────
 *
 * It was written in the renderer, at
 * `src/app/features/language-learning/models/tts-engine-registry.ts`, and its own
 * header claimed the reason it held no Angular imports was so "the Electron main
 * process (bridge/e2a-paths) can import the same definitions and stay in lockstep
 * with the UI". That was never true of where it sat: `src/` is the Angular
 * program, main compiles against `tsconfig.electron.json`, and no main-process
 * file has ever been able to import it. Pure data in the wrong program is still
 * in the wrong program.
 *
 * A MAIN-PROCESS CALLER FINALLY ARRIVED and made the gap matter. The Narrate
 * operation Foundry draws in ITS window is built out of a field description that
 * BookForge composes in main (`electron/foundry-narrate-form.ts`), and which
 * questions that dialog carries is exactly this table's business: XTTS has real
 * temperature/top-p/repetition controls and Orpheus and Voxtral do not, so asking
 * an Orpheus run for a temperature would be a control the engine ignores, drawn
 * next to three that it honours. Copying the flags into main would be a second
 * answer to "what can this engine do" — the drift `shared/tts/narration-voices.ts`
 * moved for, one directory over, for the same operation.
 *
 * So the DATA and the accessors live here and the renderer's registry is now a
 * re-export plus the one function that genuinely belongs to the renderer
 * (`selectableEngines`, which gates on a component service this program has no
 * business knowing about). Its callers' imports did not change.
 *
 * ── What the table is for ───────────────────────────────────────────────────
 *
 * The wizard, pipeline-defaults, the narration modal, the Foundry narrate form
 * and the conversion bridge read from this instead of scattering
 * `if (ttsEngine === 'xtts')` checks. The point: when the user picks an engine,
 * BookForge auto-applies that engine's constraints (device, workers, which
 * controls exist) rather than offering choices the engine can't honor — e.g.
 * Orpheus/Voxtral run vLLM on the GPU and serialize to one worker, so the "CPU"
 * device and the "parallel workers" picker simply don't appear for them.
 */

/**
 * THE ENGINES THIS BUILD HAS, as an id.
 *
 * Declared here rather than in the renderer's `language-learning.types.ts`, which
 * is where it used to live, because it is the key of the table below and a union
 * whose definition sits in a program main cannot compile is a union main cannot
 * name. That file now re-exports this one, so its own importers are unchanged and
 * there is still exactly one list of engine ids in the repository.
 */
export type TTSEngine = 'xtts' | 'orpheus' | 'voxtral' | 'f5';

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
//
// The same roster, in the {value,label} spelling a picker wants, is
// `ORPHEUS_BUILTIN_VOICES` in ./narration-voices.ts — that one is the CATALOG
// (what a run may be rendered in, merged with the custom models found on disk),
// this one is a CAPABILITY of the engine as the wizard describes it. They are
// deliberately not the same object: the catalog grows at runtime and this does
// not.
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

/**
 * Is this string one of the engines this build has?
 *
 * For the callers that read an engine id out of something nobody type-checked —
 * a saved settings blob, a queued job's config — and have to decide whether to
 * look it up or to refuse. The alternative is a cast, and a cast into
 * `TTS_ENGINES` hands back `undefined` typed as a capability record, which fails
 * three property reads later with no idea what it was asked about.
 */
export function isTtsEngine(id: string): id is TTSEngine {
  return Object.prototype.hasOwnProperty.call(TTS_ENGINES, id);
}

/** Capabilities for an engine (throws on unknown id — no silent fallback). */
export function engineCaps(id: TTSEngine): TtsEngineCaps {
  const caps = TTS_ENGINES[id];
  if (!caps) throw new Error(`Unknown TTS engine: ${id}`);
  return caps;
}
