/**
 * WHAT EACH TTS ENGINE CAN DO — the capability table, declared once for every
 * process that has to act on it.
 *
 * ── Why this is in `shared/` ────────────────────────────────────────────────
 *
 * It was written in the renderer, at
 * `src/app/features/language-learning/models/tts-engine-registry.ts`, and its own
 * header claimed the reason it held no Angular imports was so "the Electron main
 * process (bridge/narrator-paths) can import the same definitions and stay in lockstep
 * with the UI". That was never true of where it sat: `src/` is the Angular
 * program, main compiles against `tsconfig.electron.json`, and no main-process
 * file has ever been able to import it. Pure data in the wrong program is still
 * in the wrong program.
 *
 * A MAIN-PROCESS CALLER ARRIVED and made the gap matter. The Narrate operation
 * Foundry drew in ITS window was built out of a field description BookForge
 * composed in main (`electron/foundry-narrate-form.ts`), and which questions that
 * dialog carried was exactly this table's business: XTTS has real
 * temperature/top-p/repetition controls and Orpheus and Voxtral do not, so asking
 * an Orpheus run for a temperature would be a control the engine ignores, drawn
 * next to three that it honours. Copying the flags into main would be a second
 * answer to "what can this engine do" — the drift `shared/tts/narration-voices.ts`
 * moved for, one directory over, for the same operation.
 *
 * THAT CALLER IS GONE AGAIN (2026-08-26): Owen ruled the narration dialog back
 * into BookForge's own window ("Foundry is just for text changes, not for audio
 * changes"), and the form module went with it. The move stands on its own merits
 * — the header above is why `src/` was the wrong program regardless of who
 * imports it — and this table is still the one answer both programs read, since
 * the dialog gates its sampling controls on exactly these flags.
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
 * THE ENGINES A NARRATION RUN CAN BE RENDERED IN TODAY.
 *
 * Two, on purpose (Owen, 2026-09-04): "Orpheus is a choice, XTTS used to be a
 * choice but can now be removed, Higgs will have to be added as an option."
 *
 * This is the union a caller should name when it means "an engine that can
 * render", and it is deliberately NARROWER than `TTSEngine` below. The two
 * cannot be collapsed, because a retired engine has to stay NAMEABLE: a job
 * record written last year says `xtts`, that record must still load and still
 * display, and the only way to both load it and refuse to run it is to have a
 * type for "an id this build recognises" that is not the same type as "an id
 * this build will render".
 */
export type TtsEngineId = 'orpheus' | 'higgs';

/**
 * Engine ids that exist ONLY in records and saved settings written before the
 * engine was retired. Never offered, never rendered, always displayed.
 *
 * - `xtts` — retired as a CHOICE on 2026-09-04 (every voice that matters is an
 *   Orpheus fine-tune, and XTTS was being kept alive as an option nobody
 *   picked), then REMOVED FROM THE ROOT on 2026-09-05: the streaming pool, the
 *   Python worker, the voice catalog, the "add your own voice" feature and the
 *   DeepSpeed pack are all gone (docs/XTTS_REMOVAL.md). Nothing in this build
 *   can render it. The one place the string survives in a live code path is
 *   engine-agnostic scaffolding — assembly passes the literal `--tts_engine
 *   xtts` to e2a because the assembler combines audio and never consults the
 *   name (`parallel-tts-bridge.ts` `asmEngineArg`, `reassembly-bridge.ts`, and
 *   narrator's `compat/FLAGS.md`).
 * - `f5`, `voxtral` — never retired by a decision; they fell out of the
 *   narration picker as a CONSEQUENCE of narrowing it to the two engines above,
 *   and their components (`f5-env` / `voxtral-env`) and `getEnvPathForEngine`
 *   rows were deleted with the rest on 2026-09-05. Un-retiring one is no longer
 *   a line in `SELECTABLE_ORDER`: it needs its component and its env routing
 *   back first.
 *
 * ALL THREE STILL LOAD AND STILL DISPLAY. That is the whole point of this union
 * being separate from `TtsEngineId` — a job record or a saved setting written
 * last year names one of these, and refusing to PARSE it would be a worse
 * failure than refusing to RUN it.
 */
export type RetiredTtsEngine = 'xtts' | 'f5' | 'voxtral';

/**
 * EVERY ENGINE ID THIS BUILD CAN NAME — runnable plus retired.
 *
 * The key of the table below, and the type a RECORD field should have. Declared
 * here rather than in the renderer's `language-learning.types.ts`, which is
 * where it used to live, because a union whose definition sits in a program main
 * cannot compile is a union main cannot name. That file re-exports this one, so
 * its own importers are unchanged and there is still exactly one list of engine
 * ids in the repository.
 */
export type TTSEngine = TtsEngineId | RetiredTtsEngine;

/** Why an engine is no longer offered, and since when. */
export interface TtsEngineRetirement {
  /** ISO date the engine stopped being offered. */
  since: string;
  /** One sentence a person reads in a refusal message. */
  reason: string;
}

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

  /**
   * `null` for an engine that renders; a note for one that does not.
   *
   * This flag is what makes "load the record, display it, refuse to run it"
   * expressible in one place. `displayName` still reads as the plain engine name
   * so that a table of engines is a table of engines; the "(retired)" suffix a
   * person sees comes from `engineDisplayName()`, which composes the two — so a
   * caller cannot accidentally print a retired engine as if it were live.
   */
  retired: TtsEngineRetirement | null;
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
// appended to these built-ins at runtime, through the `orpheusModels` IPC —
// NarrationVoicesService is what the narration modal reads them from. (This note
// used to name ll-wizard's loadOrpheusModels; that page was erased 2026-08-27.)

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
    retired: null,
  },

  higgs: {
    id: 'higgs',
    displayName: 'Higgs',
    statusText: 'Higgs Audio v3 · zero-shot clone or fine-tune',
    /**
     * NULL, and this is load-bearing rather than a shrug.
     *
     * An earlier draft said `'higgs-env'`, which named a component that does not
     * exist: `electron/components/` has no such module, so
     * `ComponentService.isInstalled('higgs-env')` was false on EVERY machine and
     * `selectableEngines()` filtered Higgs out of the picker entirely. The
     * feature was invisible from the UI and nothing errored — the row simply was
     * not there.
     *
     * It cannot be fixed by registering one either, not honestly: on Windows the
     * Higgs environment is a WSL conda env built by the `higgs:install-env` IPC,
     * and a ComponentService entry describes a WINDOWS install with a download,
     * a size and a path. There is nothing for it to point at.
     *
     * So the gate is the doctor, which is a better gate anyway: it checks the
     * distro, the env, `vllm-omni`, BOTH site-packages patches and the launcher,
     * and it is re-run at spawn time — where `isInstalled` would have answered
     * once from a manifest. Higgs is therefore always OFFERED and refused by name
     * when it cannot run (`higgsPreflight`, and `stageRefusal` before the job is
     * queued). Offering-and-refusing is the same honest pair the catalog uses for
     * a voice whose artifact has not landed.
     */
    requiresComponent: null,
    runtime: 'wsl',
    device: { cpuCapable: false, gpuRequired: true },
    // One resident vllm-omni server per GPU; the server batches internally, and
    // it preallocates ~24 GB at 0.60 utilisation, so a second is not a thing.
    maxWorkers: 1,
    // The roster is `electron/data/higgs-models.json`, reached over the
    // `higgsModels` IPC — there is no built-in named-voice list to state here,
    // the way Orpheus genuinely has one. `presets: []` is that fact, not a
    // placeholder: a Higgs voice is either the served model's own default or a
    // catalog artifact, and both come from the catalog.
    voices: { kind: 'preset', presets: [], canClone: true },
    // Sampling is FIXED at the server's own shipped defaults (temperature 1.0,
    // top_p 0.95, top_k 50). Deviations were measured across 0.3/0.7/1.0 and the
    // spread sat INSIDE single-seed noise, so a slider here would be a control
    // that moves nothing measurable — the same reason Orpheus and Voxtral expose
    // none. There is also a trap a slider would walk into: these are not fields
    // of the request body and pydantic drops them silently unless they are sent
    // inside `extra_params`.
    sampling: {},
    retired: null,
  },

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
    retired: {
      since: '2026-09-04',
      reason:
        'XTTS is retired as a narration engine — every voice BookForge ships is an Orpheus ' +
        'or Higgs model. Re-render this job on Orpheus or Higgs.',
    },
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
    retired: {
      since: '2026-09-04',
      reason:
        'Voxtral is no longer offered for narration — the picker was narrowed to Orpheus and ' +
        'Higgs. Its environment wiring is intact; re-listing it is one line in SELECTABLE_ORDER.',
    },
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
    retired: {
      since: '2026-09-04',
      reason:
        'F5-TTS is no longer offered for narration — the picker was narrowed to Orpheus and ' +
        'Higgs. Its environment wiring is intact; re-listing it is one line in SELECTABLE_ORDER.',
    },
  },
};

/**
 * The engines the narration picker offers, in display order.
 *
 * THIS ARRAY IS THE REMOVAL. Everything that used to show XTTS — the narration
 * modal's engine strip, the pipeline-defaults panel, the wizard — reads its list
 * from `selectableEngines()`, which reads this. So one edit here removed XTTS
 * from every one of them, and adding `'higgs'` added it to every one of them,
 * with no per-page list to keep in step. That was already the design; it is only
 * being recorded because the alternative (a hardcoded `@for` in each template)
 * is exactly how a "removed" engine survives in one forgotten page.
 */
const SELECTABLE_ORDER: readonly TtsEngineId[] = ['orpheus', 'higgs'];

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

/**
 * Is this an engine that can actually RENDER a narration today?
 *
 * The companion to `isTtsEngine`, and the two answer genuinely different
 * questions. `isTtsEngine('xtts')` is TRUE — that id is real, its record loads,
 * its display name exists. `isRunnableTtsEngine('xtts')` is FALSE. Code that
 * reads an engine out of a saved blob asks the first; code that is about to
 * queue work asks the second.
 */
export function isRunnableTtsEngine(id: string): id is TtsEngineId {
  return isTtsEngine(id) && TTS_ENGINES[id].retired === null;
}

/**
 * Narrow an engine id to a runnable one, or throw naming it and saying why.
 *
 * THE REFUSAL IS BY NAME, NEVER A COERCION. The tempting alternative — quietly
 * substituting Orpheus for a record that says `xtts` — is the failure this whole
 * split exists to prevent: it renders a book in a voice nobody chose and reports
 * success. A person reading "XTTS is retired … re-render on Orpheus or Higgs"
 * can act; a person listening to the wrong narrator cannot.
 */
export function assertRunnableTtsEngine(id: string): TtsEngineId {
  if (!isTtsEngine(id)) {
    throw new Error(
      `Unknown TTS engine "${id}". This build renders: ${SELECTABLE_ORDER.join(', ')}.`,
    );
  }
  const caps = TTS_ENGINES[id];
  if (caps.retired) {
    throw new Error(
      `${caps.displayName} was retired on ${caps.retired.since} and cannot render: ${caps.retired.reason}`,
    );
  }
  return id as TtsEngineId;
}

/**
 * WHAT A SAVED SETTING'S ENGINE SHOULD RESOLVE TO, and what to say about it.
 *
 * `assertRunnableTtsEngine` above is for code about to queue work: it refuses,
 * full stop, because substituting an engine at RENDER time hands back a book in
 * a voice nobody chose. This is the other half of that story — the one a stored
 * PREFERENCE needs — and it exists because refusing at read time is not free
 * either. A machine whose Pipeline Defaults say `xtts` has an engine button
 * group with nothing selected and a run that throws at every attempt, from a
 * page that offers no way to repair it. Both failure modes are real; they need
 * different answers, and the difference is what is at stake:
 *
 *   - A RETIRED id → migrated to the default runnable engine, LOUDLY, and the
 *     caller is expected to write the repair back so the stale value stops being
 *     re-read. Nothing is rendered wrong by this: it is a default for the NEXT
 *     run, shown in a picker the user can see and change before anything starts.
 *     The paired VOICE belonged to the retired engine, so a caller that stores
 *     one must reset it too — an Orpheus engine beside a Scarlett clip is the
 *     unrenderable pair this is supposed to end.
 *   - AN UNKNOWN id → thrown, by name. A string no build ever wrote is a bug or
 *     a hand-edited file, and quietly treating it as Orpheus would hide it.
 *
 * `electron/streaming-engine.ts`'s `getSelectedEngineName` is the same shape over
 * `tts-engine.json`; it cannot share this function because its union is the
 * STREAMING engines, not the narration ones.
 */
export interface SavedTtsEngineResolution {
  /** The engine to use. */
  engine: TtsEngineId;
  /** Set only when a retired id was migrated — the id that was stored. */
  migratedFrom?: RetiredTtsEngine;
  /** A sentence for the log, when `migratedFrom` is set. */
  note?: string;
}

/** The engine a saved setting resolves to when it names nothing runnable. */
export const DEFAULT_TTS_ENGINE: TtsEngineId = 'orpheus';

export function resolveSavedTtsEngine(id: string): SavedTtsEngineResolution {
  if (!isTtsEngine(id)) {
    throw new Error(
      `Saved settings name a TTS engine this build has never had: "${id}". ` +
        `This build renders: ${SELECTABLE_ORDER.join(', ')}.`,
    );
  }
  if (isRunnableTtsEngine(id)) return { engine: id };
  const caps = TTS_ENGINES[id];
  return {
    engine: DEFAULT_TTS_ENGINE,
    migratedFrom: id as RetiredTtsEngine,
    note:
      `Saved narration engine "${id}" was retired on ${caps.retired!.since} and cannot render. ` +
      `Migrating the saved default to ${TTS_ENGINES[DEFAULT_TTS_ENGINE].displayName}, and ` +
      `resetting the voice that was paired with it.`,
  };
}

/**
 * What a PERSON should see for an engine id, retirement included.
 *
 * Every place that used to print a bare engine name — a job's details row, a
 * step label, a settings header — goes through here, so a retired engine can
 * never be displayed as though it were still on offer. An id this build has
 * never heard of comes back quoted rather than throwing: a display function is
 * called while rendering a list and must not take a page down over one bad row.
 */
export function engineDisplayName(id: string): string {
  if (!isTtsEngine(id)) return `Unknown engine "${id}"`;
  const caps = TTS_ENGINES[id];
  return caps.retired ? `${caps.displayName} (retired)` : caps.displayName;
}

/** The runnable engines, in display order — the list a picker offers from. */
export function narrationEngineOrder(): readonly TtsEngineId[] {
  return SELECTABLE_ORDER;
}
