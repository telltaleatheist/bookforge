import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import {
  AIConfig,
  AIProvider,
  DEFAULT_AI_CONFIG,
  CLAUDE_MODELS,
  OPENAI_MODELS
} from '../models/ai-config.types';
import {
  DEFAULT_VLM_ENDPOINT_CONFIG,
  type VlmEndpointConfig,
} from '@shared/vlm/conversion';
import type { TTSEngine } from '@shared/tts/engine-caps';

/**
 * Default selections the processing pipeline (LL wizard) seeds itself from, so a
 * user who always wants e.g. Claude for cleanup + a particular voice
 * doesn't re-pick every time. Edited in Settings → Pipeline Defaults; the wizard
 * applies them on open (a restored in-progress session still overrides them).
 */
export interface PipelineDefaults {
  cleanupProvider: AIProvider; cleanupModel: string;
  simplifyProvider: AIProvider; simplifyModel: string;
  translateProvider: AIProvider; translateModel: string;
  /**
   * The engine a new narration run starts on.
   *
   * Typed as the WIDE union (`TTSEngine`, retired ids included) rather than
   * `TtsEngineId`, because this value is read back out of a settings blob that
   * may have been written when XTTS was still a choice. It has to load. What it
   * cannot do is run: the picker only offers `narrationEngineOrder()`, and the
   * bridge calls `assertRunnableTtsEngine` before it queues anything.
   */
  ttsEngine: TTSEngine;
  /**
   * Processing device. 'auto' (the default) runs on the best device present —
   * CUDA when the GPU pack is installed, Metal (MPS) on Apple Silicon, else CPU.
   * An explicit choice is honored exactly (pick CPU and it runs on CPU).
   */
  ttsDevice: 'auto' | 'cpu' | 'mps' | 'gpu';
  ttsVoice: string;
  ttsSpeed: number;
  /** Assembly output: false = audiobook (M4B), true = video. */
  generateVideo: boolean;
  /** RVC voice enhancement: re-render finished narration through an RVC model. */
  rvcEnhancementEnabled: boolean;
  /** Selected enhancement voice id (rvc-model component id), '' = none chosen. */
  rvcEnhancementVoiceId: string;
  /** RVC index influence (0–1); higher leans on the model's timbre index. */
  rvcEnhancementIndexRate: number;
  /**
   * RVC consonant/breath protection (0–0.5) — and the scale RUNS BACKWARDS.
   *
   * urvc's converter gates its whole protection block on `if protect < 0.5:`
   * (`ultimate_rvc/rvc/infer/pipeline.py`), so a LOWER number protects MORE and
   * 0.5 turns protection off entirely. Its own CLI help says the opposite, and so
   * did this comment until 2026-08-26.
   *
   * It also does NOTHING at index rate 0: the unprotected features it blends back
   * are only cloned when feature retrieval runs, and retrieval needs an index.
   */
  rvcEnhancementProtectRate: number;
  /** RVC pitch shift in semitones (negative = lower). 0 = none. Use ~-12 to -15
   *  to drop a high-prosody female source into a male model's range. */
  rvcEnhancementNSemitones: number;
  /**
   * RVC pitch-extraction method — 'rmvpe', 'crepe' or 'crepe-tiny'.
   *
   * ABSENT MEANS "urvc's own default" and is a real answer rather than a missing
   * one: the engine has a method it uses when nobody names one, so declining to
   * name one is a choice. Which method suits a voice pair is decided by ear —
   * the 2026-08-26 deathstalker→Sigma audition chose crepe for a narration
   * source, so there is no rule to encode here.
   *
   * fcpe is deliberately not offered: it needs a model this app does not ship.
   */
  rvcEnhancementF0Method?: string;
  /**
   * RVC f0 analysis hop, in samples (1–512). ONLY the crepe family reads it —
   * rmvpe ignores it entirely. Absent means urvc's own default, as above.
   */
  rvcEnhancementHopLength?: number;
}

export const DEFAULT_PIPELINE_DEFAULTS: PipelineDefaults = {
  cleanupProvider: 'ollama', cleanupModel: '',
  simplifyProvider: 'ollama', simplifyModel: '',
  translateProvider: 'ollama', translateModel: '',
  // Was 'xtts' with voice 'ScarlettJohansson'. XTTS is retired (2026-09-04) and a
  // DEFAULT that names a retired engine is the one place the refusal would fire on
  // a user who never chose anything — so the default moved to the engine every
  // shipped voice is now a fine-tune of, and the voice moved with it: leaving an
  // XTTS reference-clip name against an Orpheus default would be a pair that
  // cannot render.
  ttsEngine: 'orpheus',
  ttsDevice: 'auto',
  ttsVoice: 'leah',
  ttsSpeed: 1.0,
  generateVideo: false,
  rvcEnhancementEnabled: false,
  rvcEnhancementVoiceId: '',
  rvcEnhancementIndexRate: 0.5,
  /*
   * 0.5 IS PROTECTION OFF, and it stays the default deliberately.
   *
   * Now that the scale is documented as inverted it would be easy to read this
   * as a bug and "fix" it downwards. It is not one. The shipped default is the
   * neutral conversion — what a voice model does with nothing added — and any
   * protection value is a judgement about a particular pair of voices that
   * somebody made by listening. Those judgements live in the presets, where they
   * carry the name of the pair they were made for (Deathstalker → Sigma protects
   * at 0.1). A global default that protected everything by an amount nobody
   * auditioned would apply one pair's answer to every other pair.
   */
  rvcEnhancementProtectRate: 0.5,
  rvcEnhancementNSemitones: 0,
  /*
   * `rvcEnhancementF0Method` and `rvcEnhancementHopLength` are deliberately not
   * listed. They are the two settings whose absence is a REAL answer — "let urvc
   * choose" — so writing a value here would be this app quietly picking a pitch
   * extractor for every conversion on every machine. A preset that has an
   * audition behind it names them; nothing else does.
   */
};

/**
 * A named, saved bundle of TTS + RVC pipeline settings the user can apply with a
 * single pick from the wizard's preset dropdown — e.g. "Leah → Sigma RVC".
 * Captures only the engine/voice/speed + enhancement slice of
 * {@link PipelineDefaults}; the AI-role and output choices are left to the
 * per-book flow. Picking a preset overwrites those fields in the wizard.
 *
 * It carried three more fields until 2026-09-05 — ttsTemperature, ttsTopP and
 * ttsRepetitionPenalty. They were XTTS's controls: the ONLY code that ever read
 * them was the prep spawn's `if (settings.ttsEngine === 'xtts')` flag block, and
 * both engines this build renders in declare `sampling: {}`. A preset saved
 * before this still has the keys on disk; nothing reads them.
 */
export interface PipelinePreset {
  /** Stable id (generated at save time; `builtin:*` for shipped presets). */
  id: string;
  /** User-facing name shown in the dropdown. */
  name: string;
  /** True for shipped, non-deletable presets (not persisted to user storage). */
  builtin?: boolean;
  ttsEngine: PipelineDefaults['ttsEngine'];
  ttsDevice: PipelineDefaults['ttsDevice'];
  ttsVoice: string;
  ttsSpeed: number;
  rvcEnhancementEnabled: boolean;
  rvcEnhancementVoiceId: string;
  rvcEnhancementIndexRate: number;
  rvcEnhancementProtectRate: number;
  rvcEnhancementNSemitones: number;
  /**
   * Absent = urvc's own default, exactly as on {@link PipelineDefaults}.
   *
   * A preset saved before these existed simply lacks them, which is the honest
   * record of a preset made when nobody could choose a pitch method — not a
   * value to be filled in on read.
   */
  rvcEnhancementF0Method?: string;
  rvcEnhancementHopLength?: number;
}

/** The {@link PipelinePreset} fields, minus id/name — the actual settings payload. */
export type PipelinePresetConfig = Omit<PipelinePreset, 'id' | 'name' | 'builtin'>;

/**
 * Shipped presets that always appear at the top of the dropdown on every machine.
 * Code-defined (never written to user storage), non-deletable, and editing this
 * list updates them everywhere. Keepers proven on the test book live here.
 */
export const BUILTIN_PIPELINE_PRESETS: PipelinePreset[] = [
  {
    id: 'builtin:leah-sigma',
    name: 'Leah → Sigma (deep male narrator)',
    builtin: true,
    ttsEngine: 'orpheus',
    ttsDevice: 'auto',
    ttsVoice: 'leah',
    ttsSpeed: 1.0,
    rvcEnhancementEnabled: true,
    rvcEnhancementVoiceId: 'rvc-voice-sigma',
    rvcEnhancementIndexRate: 0.7,
    rvcEnhancementProtectRate: 0.25,
    rvcEnhancementNSemitones: -15,
  },
  {
    /*
     * THE 2026-08-27 AUDITION, written down. Chosen by ear against the
     * alternatives and not to be re-tuned from theory:
     *   --f0-method rmvpe --n-semitones -2 --index-rate 0.3 --protect-rate 0.1
     *
     * REPLACES the 2026-08-26 recipe (crepe / hop 512 / idx 0.5 / prot 0.25),
     * which won a single-sentence A/B and then FAILED on a whole book — Owen's
     * verdict was "flat and robotic, that was the problem i had with the
     * pipeline". The cause was the hop: `hop_length` is samples at the 16 kHz
     * analysis rate, so 512 sampled f0 only every 32 ms and interpolated
     * between, smoothing the intonation flat before the vocoder saw it. Thirty
     * seconds of one sentence could not expose that; a chapter could. If a
     * future audition is run, judge it on a long passage.
     *
     * Each number is load-bearing, and two of them only work together: protect
     * 0.1 is strong protection (the scale is inverted — see PipelineDefaults)
     * and it does NOTHING unless the index rate is above zero, which is why 0.3
     * is here rather than 0. Index came DOWN from 0.5 because retrieval pulls
     * the timbre toward the training-set average, which is part of what read as
     * robotic.
     *
     * rmvpe is named explicitly even though it is also urvc's own default: this
     * one has an audition behind it (it beat crepe at every hop tried), and a
     * preset that chose a method should say so. No hop length: rmvpe does not
     * read one, and carrying an inert 512 would look like a tuning decision.
     *
     * -2 semitones, where the Leah preset above uses -15, because the source is
     * already a deep male voice — that preset drops a high-prosody female source
     * into a male model's range and this one is barely moving.
     *
     * rms-mix-rate stays at the engine's 1.0. 0.25 was auditioned and produced
     * ghost sounds; 0.75 was auditioned here and did not restore dynamics —
     * `change_rms` measures the envelope on a half-second hop, too coarse to
     * matter at phrase level. RVC flattens loudness dynamics whatever this is
     * set to (source 5.8 dB sd → ~5.1 dB across every variant tried).
     */
    id: 'builtin:deathstalker-sigma',
    name: 'Deathstalker → Sigma (deep male narrator)',
    builtin: true,
    ttsEngine: 'orpheus',
    ttsDevice: 'auto',
    ttsVoice: 'deathstalker',
    ttsSpeed: 1.0,
    /*
     * The three sampling fields this preset used to carry (temperature 0.6,
     * top-p 0.9, repetition penalty 1.1) are gone with the field itself — they
     * were XTTS's controls, INERT for Orpheus, which fixes its sampling inside
     * the engine class. deathstalker's real repetition penalty lives where the
     * engine reads it: `backends.vllm.repPenalty` in
     * electron/data/orpheus-models.json.
     */
    rvcEnhancementEnabled: true,
    rvcEnhancementVoiceId: 'rvc-voice-sigma',
    rvcEnhancementIndexRate: 0.3,
    rvcEnhancementProtectRate: 0.1,
    rvcEnhancementNSemitones: -2,
    rvcEnhancementF0Method: 'rmvpe',
  },
];

/**
 * The factory ("stock") TTS values that ship with the app. The user's saved
 * Pipeline Defaults drift as they adjust the controls; "Reset to stock" restores
 * these. Single source of truth for both the initial defaults above and the reset
 * action, so the two never diverge.
 *
 * Down to ONE field: temperature/top-p/repetition-penalty were XTTS's, and left
 * with it on 2026-09-05.
 */
export const STOCK_TTS_SAMPLING = {
  speed: DEFAULT_PIPELINE_DEFAULTS.ttsSpeed,
} as const;

/**
 * Setting field types matching plugin-types.ts
 */
export type SettingFieldType = 'string' | 'number' | 'boolean' | 'select' | 'path' | 'password';

/**
 * Schema for a setting field
 */
export interface SettingField {
  key: string;
  type: SettingFieldType;
  label: string;
  description?: string;
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
}

/**
 * A settings section (built-in or from plugin)
 */
export interface SettingsSection {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  fields: SettingField[];
  isPlugin?: boolean;
}

/**
 * SettingsService - Manages application settings
 *
 * Provides:
 * - Built-in settings sections (General, Appearance)
 * - Plugin settings sections (dynamically registered)
 * - Persistence to ~/Documents/BookForge/settings.json
 */
@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly electron = inject(ElectronService);

  // All registered settings sections
  readonly sections = signal<SettingsSection[]>([]);

  // Saved settings values (persisted to localStorage)
  readonly values = signal<Record<string, unknown>>({});

  // Pending changes (not yet saved)
  readonly pendingValues = signal<Record<string, unknown>>({});

  // Loading state
  readonly loading = signal(false);

  // Whether there are unsaved changes
  readonly hasUnsavedChanges = computed(() => {
    return Object.keys(this.pendingValues()).length > 0;
  });

  constructor() {
    this.initializeBuiltinSections();
    this.loadSettings();
  }

  /**
   * Register built-in settings sections
   */
  private initializeBuiltinSections(): void {
    const builtinSections: SettingsSection[] = [
      {
        id: 'library',
        name: 'Library',
        description: 'Configure your BookForge library location',
        icon: '📚',
        fields: [], // Library section has custom UI
      },
      {
        id: 'general',
        name: 'General',
        description: 'General application settings',
        icon: '⚙️',
        fields: [
          {
            key: 'maxRecentFiles',
            type: 'number',
            label: 'Recent files limit',
            description: 'Maximum number of recent files to remember',
            default: 10,
            min: 5,
            max: 50,
          },
          {
            key: 'diffIgnoreWhitespace',
            type: 'boolean',
            label: 'Ignore whitespace in diffs',
            description: 'When reviewing AI cleanup changes, ignore differences in whitespace, paragraph breaks, and newlines',
            default: true,
          },
        ],
      },
      {
        id: 'storage',
        name: 'Storage',
        description: 'Manage cached data and storage',
        icon: '💾',
        fields: [], // Storage section has custom UI, not standard fields
      },
      {
        id: 'ai',
        name: 'AI',
        description: 'Configure AI provider for OCR text cleanup',
        icon: '🤖',
        fields: [], // AI section has custom UI
      },
      {
        id: 'audiobook',
        name: 'Audiobook',
        description: 'Configure audiobook output settings',
        icon: '🎧',
        fields: [
          {
            key: 'externalAudiobooksDir',
            type: 'path',
            label: 'Default Export Folder',
            description: 'Default folder for the Export M4B dialog (for Syncthing/media server). Leave empty to use system default.',
            default: '/Volumes/Callisto/books/audiobooks',
            placeholder: '/Volumes/Callisto/books/audiobooks',
          },
          {
            key: 'e2aPath',
            type: 'path',
            label: 'ebook2audiobook Path',
            description: 'Path to ebook2audiobook installation folder',
            default: '',
            placeholder: 'Auto-detect',
          },
          {
            key: 'condaPath',
            type: 'path',
            label: 'Conda Executable',
            description: 'Path to conda executable. Leave empty for auto-detect.',
            default: '',
            placeholder: 'Auto-detect',
          },
          {
            key: 'e2aTmpPath',
            type: 'path',
            label: 'ebook2audiobook Tmp Path',
            description: 'Path to the ebook2audiobook tmp folder containing incomplete sessions. Used by the Reassembly feature.',
            default: '',
            placeholder: 'Default: ~/Projects/ebook2audiobook/tmp',
          },
          {
            key: 'ttsScratchPath',
            type: 'path',
            label: 'TTS Scratch Folder',
            description: 'Where in-progress TTS sessions are written before being cached into the project. Leave empty for the default: a "<library>-scratch" folder next to your library.',
            default: '',
            placeholder: 'Default: next to library folder',
          },
        ],
      },
      {
        id: 'bookshelf',
        name: 'Bookshelf Server',
        description: 'Share your audiobook bookshelf on the network',
        icon: '🌐',
        fields: [], // Bookshelf Server section has custom UI
      },
      {
        id: 'tts-api',
        name: 'TTS Server',
        description: 'Streaming engine workers and external client API (browser extension)',
        icon: '🔊',
        fields: [], // TTS Server section has custom UI
      },
      // ── Per-engine pages: everything an engine needs (env, models, voices,
      // accelerators, engine-specific config) lives on ITS page, so setup reads
      // as "pick your engine, set it up here". Cross-cutting tools stay in the
      // General Add-ons page below.
      {
        // Orpheus — engine install, downloadable custom voices (HuggingFace
        // catalogue), models directory, and the WSL2 runner (Windows).
        id: 'orpheus',
        name: 'Orpheus',
        description: 'Orpheus TTS: engine, custom voice models, and WSL2 setup',
        icon: '🎙️',
        fields: [], // Custom UI
      },
      {
        // Higgs — the WSL vllm-omni serving env, its two required site-packages
        // patches, and the voice catalog. Same shape as the Orpheus page.
        id: 'higgs',
        name: 'Higgs',
        description: 'Higgs Audio v3: the WSL serving environment and the voice catalog',
        icon: '🎚️',
        fields: [], // Custom UI (app-higgs-voices-panel + app-add-ons-panel)
      },
      {
        // ── AN ENGINE'S PAGE THAT OUTLIVED ITS ENGINE ────────────────────────
        // XTTS stopped being a narration CHOICE on 2026-09-04 and left the root
        // entirely on 2026-09-05 — the pool, the voice catalog, the "add your
        // own voice" feature and the DeepSpeed pack all went with it. What is
        // left under this key is the one thing here that was never XTTS's: the
        // Stanza LANGUAGE PACKS, which every engine's prep uses to split
        // sentences.
        // The section id stays 'xtts' because it is a ROUTE KEY: the translation
        // panel deep-links `?section=xtts` for "download more language packs",
        // and renaming it would break that link to fix a word.
        id: 'xtts',
        name: 'Language packs',
        description: 'Stanza sentence-segmentation models, used by every narration engine',
        icon: '🗣️',
        fields: [], // Custom UI (app-languages-panel)
      },
      {
        // Dedicated screen for the optional RVC voice-enhancement engine + its
        // voice models. Custom UI (app-rvc-enhancement-panel).
        id: 'enhancement',
        name: 'RVC Enhancement',
        description: 'Optional RVC engine + voice models that re-render finished narration to smooth synthetic artifacts',
        icon: '✨',
        fields: [],
      },
      {
        // The transcription runtime (Whisper under the hood — never named in the
        // UI) + downloadable models behind "Generate sentences" (recorded
        // audiobook → synced on-screen text).
        id: 'speech-to-text',
        name: 'Speech to Text',
        description: 'Transcribe recorded audiobooks into synced text (“Generate sentences”)',
        icon: '📝',
        fields: [], // Custom UI (app-add-ons-panel filtered to whisper + app-whisper-models-panel)
      },
      {
        // Cross-cutting optional tools that don't belong to one engine:
        // Calibre (ebook conversion), Tesseract (OCR), GPU AI text cleanup.
        id: 'add-ons',
        name: 'General Add-ons',
        description: 'Cross-cutting optional tools: Calibre, Tesseract, GPU-accelerated AI cleanup',
        icon: '🧩',
        fields: [], // Custom UI (app-add-ons-panel)
      },
      {
        // Default AI / TTS / output selections the processing pipeline seeds
        // itself from. Custom UI (app-pipeline-defaults-panel).
        id: 'pipeline-defaults',
        name: 'Pipeline Defaults',
        description: 'Default AI, TTS, and output choices for the processing pipeline',
        icon: '🎚️',
        fields: [],
      },
      {
        // Thin advanced section: genuine overrides only (tool paths). Conda is
        // hidden on packaged builds (bundled env). Orpheus/WSL config moved to
        // the Orpheus page in the per-engine reorg.
        id: 'tools',
        name: 'Advanced',
        description: 'Advanced overrides: tool paths (ffmpeg, conda, ebook2audiobook)',
        icon: '🔧',
        fields: [], // Tools section has custom UI
      },
    ];

    this.sections.set(builtinSections);
  }

  /**
   * Register a plugin settings section
   */
  registerPluginSection(section: SettingsSection): void {
    this.sections.update(sections => {
      // Remove existing section with same ID
      const filtered = sections.filter(s => s.id !== section.id);
      return [...filtered, { ...section, isPlugin: true }];
    });
  }

  /**
   * Unregister a plugin settings section
   */
  unregisterPluginSection(sectionId: string): void {
    this.sections.update(sections =>
      sections.filter(s => s.id !== sectionId)
    );
  }

  /**
   * Load settings from storage
   */
  async loadSettings(): Promise<void> {
    this.loading.set(true);

    try {
      // Load from localStorage for now (electron storage could be added later)
      const stored = localStorage.getItem('bookforge-settings');
      if (stored) {
        this.values.set(JSON.parse(stored));
      } else {
        // Initialize with defaults
        this.initializeDefaults();
      }

      // Configure e2a paths in main process
      await this.applyE2aPaths();
    } catch {
      this.initializeDefaults();
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Apply e2a path settings to the main process
   * Called after loading settings and when paths are changed
   */
  private async applyE2aPaths(): Promise<void> {
    try {
      const e2aPath = this.get<string>('e2aPath') || '';
      const condaPath = this.get<string>('condaPath') || '';
      const ttsScratchPath = this.get<string>('ttsScratchPath') || '';
      await this.electron.configureE2aPaths({ e2aPath, condaPath, ttsScratchPath });
    } catch (err) {
      console.error('[SettingsService] Failed to apply e2a paths:', err);
    }
  }

  /**
   * Save settings to storage
   */
  async saveSettings(): Promise<void> {
    try {
      localStorage.setItem('bookforge-settings', JSON.stringify(this.values()));
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  }

  /**
   * Get a setting value (checks pending values first, then saved values)
   */
  get<T>(key: string): T {
    // Check pending values first
    const pendingValue = this.pendingValues()[key];
    if (pendingValue !== undefined) {
      return pendingValue as T;
    }

    // Then check saved values
    const value = this.values()[key];
    if (value !== undefined) {
      return value as T;
    }

    // Find default from schema
    for (const section of this.sections()) {
      const field = section.fields.find(f => f.key === key);
      if (field) {
        return field.default as T;
      }
    }

    return undefined as T;
  }

  /**
   * Get only the saved value (ignoring pending changes)
   */
  getSaved<T>(key: string): T {
    return this.values()[key] as T;
  }

  /**
   * Set a setting value as pending (does NOT auto-save)
   */
  setPending(key: string, value: unknown): void {
    this.pendingValues.update(v => ({ ...v, [key]: value }));
  }

  /**
   * Save all pending changes
   */
  async savePendingChanges(): Promise<void> {
    const pending = this.pendingValues();
    if (Object.keys(pending).length === 0) return;

    // Merge pending into values
    this.values.update(v => ({ ...v, ...pending }));

    // Clear pending
    this.pendingValues.set({});

    // Persist to storage
    await this.saveSettings();

    // Apply e2a path changes if relevant
    if ('e2aPath' in pending || 'condaPath' in pending || 'ttsScratchPath' in pending) {
      this.applyE2aPaths();
    }

    console.log('[SETTINGS] Saved pending changes:', Object.keys(pending));
  }

  /**
   * Discard all pending changes
   */
  discardPendingChanges(): void {
    this.pendingValues.set({});
  }

  /**
   * Set a setting value and save immediately (legacy behavior)
   */
  set(key: string, value: unknown): void {
    this.values.update(v => ({ ...v, [key]: value }));
    // Also clear from pending if it was there
    this.pendingValues.update(v => {
      const updated = { ...v };
      delete updated[key];
      return updated;
    });
    this.saveSettings();

    // Apply e2a path changes immediately
    if (key === 'e2aPath' || key === 'condaPath' || key === 'ttsScratchPath') {
      this.applyE2aPaths();
    }
  }

  /**
   * Set multiple settings at once
   */
  setMultiple(settings: Record<string, unknown>): void {
    this.values.update(v => ({ ...v, ...settings }));
    this.saveSettings();
  }

  /**
   * Reset a section to defaults
   */
  resetSection(sectionId: string): void {
    const section = this.sections().find(s => s.id === sectionId);
    if (!section) return;

    const defaults: Record<string, unknown> = {};
    for (const field of section.fields) {
      defaults[field.key] = field.default;
    }

    // Clear any pending values for this section
    this.pendingValues.update(v => {
      const updated = { ...v };
      for (const key of Object.keys(defaults)) {
        delete updated[key];
      }
      return updated;
    });

    this.values.update(v => {
      const updated = { ...v };
      for (const key of Object.keys(defaults)) {
        updated[key] = defaults[key];
      }
      return updated;
    });

    this.saveSettings();
  }

  /**
   * Reset all settings to defaults
   */
  resetAll(): void {
    this.initializeDefaults();
    this.saveSettings();
  }

  /**
   * Initialize all settings to their defaults
   */
  private initializeDefaults(): void {
    const defaults: Record<string, unknown> = {};

    for (const section of this.sections()) {
      for (const field of section.fields) {
        defaults[field.key] = field.default;
      }
    }

    // Initialize AI config with defaults
    defaults['aiConfig'] = { ...DEFAULT_AI_CONFIG };

    // No endpoint: the pages are read on this machine, which is what an Apple
    // Silicon Mac can do and what nothing else can. Settings → AI is where a
    // server is named.
    defaults['vlmEndpointConfig'] = { ...DEFAULT_VLM_ENDPOINT_CONFIG };

    // Initialize bookshelf server config with defaults.
    // Enabled by default: the Bookshelf server starts on launch so the library
    // is immediately browsable on the network. Users can stop it from the nav rail.
    defaults['bookshelfConfig'] = {
      enabled: true,
      port: 8765
    };

    this.values.set(defaults);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AI Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get AI configuration
   */
  getAIConfig(): AIConfig {
    const config = this.values()['aiConfig'] as AIConfig | undefined;
    if (!config) {
      return { ...DEFAULT_AI_CONFIG };
    }
    // Merge with defaults to ensure all fields exist
    return {
      ...DEFAULT_AI_CONFIG,
      ...config,
      ollama: { ...DEFAULT_AI_CONFIG.ollama, ...config.ollama },
      claude: { ...DEFAULT_AI_CONFIG.claude, ...config.claude },
      openai: { ...DEFAULT_AI_CONFIG.openai, ...config.openai }
    };
  }

  /**
   * Set AI configuration
   */
  setAIConfig(config: AIConfig): void {
    this.values.update(v => ({ ...v, aiConfig: config }));
    this.saveSettings();
  }

  /**
   * Update a single AI config field
   */
  updateAIConfig(updates: Partial<AIConfig>): void {
    const current = this.getAIConfig();
    this.setAIConfig({ ...current, ...updates });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reading pages with a document vision model (Convert to EPUB)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Which machine reads the pages, merged with the default (which is: this one).
   *
   * Lives beside the Ollama URL and travels the same way — the renderer owns the
   * setting and hands it to main per run, because main has no copy of this
   * bundle. Empty `url` means MLX here, and that is the default on Apple
   * Silicon; every other machine has no local reader and the conversion refuses
   * by name until an endpoint is set (shared/vlm/conversion.ts).
   */
  getVlmEndpointConfig(): VlmEndpointConfig {
    const stored = this.values()['vlmEndpointConfig'] as Partial<VlmEndpointConfig> | undefined;
    return { ...DEFAULT_VLM_ENDPOINT_CONFIG, ...(stored || {}) };
  }

  setVlmEndpointConfig(config: VlmEndpointConfig): void {
    this.values.update(v => ({ ...v, vlmEndpointConfig: config }));
    this.saveSettings();
  }

  updateVlmEndpointConfig(updates: Partial<VlmEndpointConfig>): void {
    this.setVlmEndpointConfig({ ...this.getVlmEndpointConfig(), ...updates });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bookshelf Server Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Bookshelf server configuration
   */
  getBookshelfConfig(): { enabled: boolean; port: number } {
    const config = this.values()['bookshelfConfig'] as { enabled: boolean; port: number } | undefined;
    return config || { enabled: false, port: 8765 };
  }

  /**
   * Set bookshelf server configuration
   */
  setBookshelfConfig(config: { enabled: boolean; port: number }): void {
    this.values.update(v => ({ ...v, bookshelfConfig: config }));
    this.saveSettings();
  }

  /**
   * Update bookshelf server configuration
   */
  updateBookshelfConfig(updates: Partial<{ enabled: boolean; port: number }>): void {
    const current = this.getBookshelfConfig();
    this.setBookshelfConfig({ ...current, ...updates });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pipeline Defaults
  // ─────────────────────────────────────────────────────────────────────────────

  /** The pipeline's default selections, merged with built-in defaults. */
  getPipelineDefaults(): PipelineDefaults {
    const stored = this.values()['pipelineDefaults'] as Partial<PipelineDefaults> | undefined;
    return { ...DEFAULT_PIPELINE_DEFAULTS, ...(stored || {}) };
  }

  setPipelineDefaults(defaults: PipelineDefaults): void {
    this.values.update(v => ({ ...v, pipelineDefaults: defaults }));
    this.saveSettings();
  }

  updatePipelineDefaults(updates: Partial<PipelineDefaults>): void {
    this.setPipelineDefaults({ ...this.getPipelineDefaults(), ...updates });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pipeline Presets (named TTS + RVC bundles)
  // ─────────────────────────────────────────────────────────────────────────────

  /** User-saved presets only (from storage). */
  private storedPipelinePresets(): PipelinePreset[] {
    const stored = this.values()['pipelinePresets'] as PipelinePreset[] | undefined;
    return Array.isArray(stored) ? stored : [];
  }

  /** All presets for display: shipped built-ins first, then user-saved ones. */
  getPipelinePresets(): PipelinePreset[] {
    return [...BUILTIN_PIPELINE_PRESETS, ...this.storedPipelinePresets()];
  }

  /** Insert a new user preset or replace an existing one (matched by id). Built-in
   *  presets are never persisted. Returns the full display list after the change. */
  savePipelinePreset(preset: PipelinePreset): PipelinePreset[] {
    if (preset.builtin || preset.id.startsWith('builtin:')) return this.getPipelinePresets();
    const existing = this.storedPipelinePresets();
    const idx = existing.findIndex((p) => p.id === preset.id);
    const next = idx >= 0
      ? existing.map((p) => (p.id === preset.id ? preset : p))
      : [...existing, preset];
    this.values.update((v) => ({ ...v, pipelinePresets: next }));
    this.saveSettings();
    return this.getPipelinePresets();
  }

  /** Remove a user preset by id (built-ins can't be deleted). Returns the full
   *  display list after the change. */
  deletePipelinePreset(id: string): PipelinePreset[] {
    if (id.startsWith('builtin:')) return this.getPipelinePresets();
    const next = this.storedPipelinePresets().filter((p) => p.id !== id);
    this.values.update((v) => ({ ...v, pipelinePresets: next }));
    this.saveSettings();
    return this.getPipelinePresets();
  }
}
