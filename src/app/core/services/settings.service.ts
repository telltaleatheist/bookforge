import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import {
  AIConfig,
  AIProvider,
  DEFAULT_AI_CONFIG,
  resolveSavedAIProvider,
  resolveSavedCrucibleServer
} from '../models/ai-config.types';
import {
  DEFAULT_VLM_ENDPOINT_CONFIG,
  type VlmEndpointConfig,
} from '@shared/vlm/conversion';
import { resolveSavedTtsEngine, type TTSEngine } from '@shared/tts/engine-caps';

/**
 * Default selections the processing pipeline (LL wizard) seeds itself from, so a
 * user who always wants e.g. a particular engine for cleanup + a particular
 * voice doesn't re-pick every time. Edited in Settings → Pipeline Defaults; the
 * wizard applies them on open (a restored in-progress session still overrides them).
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
   * may have been written when XTTS — or, since 2026-09-14, Orpheus — was still
   * a choice. It has to load. What it cannot do is run: the picker only offers
   * `narrationEngineOrder()`, and the bridge calls `assertRunnableTtsEngine`
   * before it queues anything.
   *
   * `orpheus` is now the id this matters MOST for, and by a wide margin: XTTS
   * stopped being the default in 2026-09-04, so the machines carrying a stale
   * value carry `orpheus`, which was `DEFAULT_TTS_ENGINE` and the picker's FIRST
   * entry right up until it was retired. Nearly every existing settings blob
   * names it.
   */
  ttsEngine: TTSEngine;
  /*
   * `ttsDevice` WAS HERE AND IS GONE (Owen, 2026-09-19: *"we don't need device
   * as an option — that's decided by crucible configuration. we can just cut
   * it. it will always be auto"*).
   *
   * It was never a fact about the run this app performs any more: a render
   * happens on a Crucible server, `crucible/render.ts` never read the field,
   * and the bridge resolved it from THIS box's hardware — so picking GPU on a
   * machine without the local CUDA pack REFUSED a render a CUDA server would
   * have run, and Auto answered about the wrong computer. Its only downstream
   * reader was narrator's `prep --device`, whose own help says "recorded into
   * the state; prep itself is CPU work".
   *
   * A SETTINGS BLOB THAT STILL CARRIES THE KEY LOADS UNCHANGED:
   * `getPipelineDefaults` spreads what is stored over the defaults, so a value
   * nothing declares simply rides along unread. Nothing fails on it.
   */
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
  // Was 'ollama' for all three. Ollama left BookForge on 2026-09-14 — it is an
  // upstream a GPU engine (Crucible) forwards to now, not a provider this app
  // talks to — and the default moved to the only provider that works with
  // nothing configured. A Crucible needs a server NAME, and no shipped default
  // can know what this machine called that machine.
  // ONE PROVIDER (2026-09-17). The MODEL is still empty and still not guessable:
  // it is a Crucible model id on a server this machine has not been told about
  // yet, so the run doors refuse by name until somebody chooses in Settings → AI.
  cleanupProvider: 'crucible', cleanupModel: '',
  simplifyProvider: 'crucible', simplifyModel: '',
  translateProvider: 'crucible', translateModel: '',
  // Was 'xtts' with voice 'ScarlettJohansson', then 'orpheus' with voice 'leah'.
  // A DEFAULT that names a retired engine is the one place the refusal would fire
  // on a user who never chose anything — `getPipelineDefaults` only repairs a
  // STORED value, so a shipped default that went stale would reach a fresh machine
  // unrepaired — which is why this line moves the same day the engine is retired,
  // both times. Orpheus was retired 2026-09-14 ("higgs is the frontier"), so the
  // default is Higgs.
  //
  // THE VOICE MOVED WITH IT, for the third time and the same reason: `leah` is an
  // Orpheus fine-tune name and Higgs has never heard of it, so leaving it here
  // would ship exactly the unrenderable engine/voice pair the migration in
  // `getPipelineDefaults` exists to clean up. `default` is the Higgs v3 built-in
  // voice — chosen because it is the ONLY entry in `higgs-models.json` that needs
  // no downloaded checkpoint, so it is the one voice a machine that has installed
  // nothing can actually render.
  ttsEngine: 'higgs',
  ttsVoice: 'default',
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
  /**
   * READ BY NOTHING since 2026-09-09. A preset configures the VOICE CONVERSION
   * and nothing else (Owen: "the preset is designed to change RVC settings,
   * nothing else"), so `applyPreset` no longer sets the engine, voice, device
   * or speed and `savePreset` no longer records them.
   *
   * They stay on the type, optional, because presets saved before that date
   * carry them and dropping the fields would make a stored preset fail to
   * parse. They are HISTORY, not configuration: a reader that starts obeying
   * them again re-opens the bug they were removed for — every shipped preset
   * said `orpheus`, so applying one moved a Higgs run onto Orpheus with nothing
   * on screen to show it, because both engines ship a voice named
   * `deathstalker`.
   *
   * `ttsDevice?` STOOD BESIDE THEM UNTIL 2026-09-19 and is gone with the
   * control it named (see {@link PipelineDefaults}). The same "a stored preset
   * must still parse" argument does not keep it: these are plain interfaces
   * with no runtime validation, so a saved preset carrying the key is read
   * exactly as before — the key is simply not declared and nothing reads it.
   * There is no longer a type it could be declared AS.
   */
  ttsEngine?: PipelineDefaults['ttsEngine'];
  ttsVoice?: string;
  ttsSpeed?: number;
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
    /*
     * NO ttsEngine/ttsVoice/ttsSpeed/ttsDevice — removed 2026-09-09 with the
     * reading that a preset sets them. The NAME still says Leah, because that
     * is the source these rates were auditioned against and -15 semitones only
     * makes sense stated against it; the preset no longer SELECTS Leah.
     */
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
    /*
     * NO ttsEngine/ttsVoice — removed 2026-09-09, and THIS is the preset whose
     * `orpheus` did the damage. Owen ran it on the Higgs deathstalker; the
     * preset set the engine back to Orpheus and the voice name matched under
     * both engines, so nothing looked wrong and a whole book started rendering
     * on the slower engine. The name still reads Deathstalker because these
     * rates were auditioned against that narrator, and -2 semitones is only
     * meaningful stated against a source that is already a deep male voice.
     */
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
 * - Built-in settings sections (the eleven of the 2026-09-14 rework)
 * - Plugin settings sections (dynamically registered)
 * - Persistence to the RENDERER's localStorage, under the key
 *   `bookforge-settings` (see `saveSettings` / `loadSettings` below).
 *
 * THE OLD DOCBLOCK CLAIMED `~/Documents/BookForge/settings.json`, AND THAT WAS
 * NEVER TRUE OF ANY BUILD (audit docs/SETUP-AND-SETTINGS-AROUND-CRUCIBLE.md
 * section 1a). It matters far beyond tidiness: because this blob lives in the
 * renderer, MOST settings on these pages have NO main-process reader at all —
 * their value reaches main only as an argument the renderer passes on an IPC
 * call. The settings that a main-process reader can actually see are exactly
 * those persisted THROUGH main: `tool-paths.json`, `tts-engine.json`,
 * `tts-api.json`, `crucible-servers.json`, `crucible-routing.json`,
 * `app-settings.json` and the component registry. Anyone adding a setting that
 * the CLI, the queue or a spawn must read has to put it in one of those, not
 * here.
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

  /** Retired AI providers already named in the console, so each is said once. */
  private readonly reportedProviderRepairs = new Set<string>();

  constructor() {
    this.initializeBuiltinSections();
    this.loadSettings();
  }

  /**
   * Register built-in settings sections
   */
  private initializeBuiltinSections(): void {
    const builtinSections: SettingsSection[] = [
      /*
       * ELEVEN SECTIONS, IN THIS ORDER (audit
       * docs/SETUP-AND-SETTINGS-AROUND-CRUCIBLE.md section 7).
       *
       * Fifteen became eleven on 2026-09-14. The four that went — Orpheus,
       * Higgs, RVC Enhancement, Speech to Text — existed for one reason: an
       * engine needed an env, a models directory, a doctor and a voice catalog
       * on one screen. Crucible owns all four, once per machine, so the pages
       * had no content left. Orpheus is additionally DEPRECATED (Owen,
       * 2026-09-14) and Higgs is the one narration engine.
       *
       * And Crucible Servers is promoted from thirteenth to SECOND, because
       * after the cutover it is the screen that decides whether anything
       * renders at all.
       */
      /*
       * "GENERAL" IS WHAT LIBRARY BECAME (2026-09-17) once Storage, Bookshelf
       * Server and Tab Recorder moved into it. Owen: "they dont each need their
       * own tab."
       *
       * The four are one subject — THIS MACHINE: where its files live, what it
       * caches, and what it serves on the network. Four sidebar entries for
       * that was a tree shaped by which component was written first rather than
       * by what a person came looking for.
       */
      {
        id: 'library',
        name: 'General',
        description: 'This machine: where its files live, what it caches, and what it serves',
        icon: '📚',
        /*
         * THE AUDIOBOOK SECTION'S TWO FIELDS, MOVED HERE (2026-09-17) rather
         * than deleted with it. Owen asked for the page to go; the page was
         * the problem, not these. `externalAudiobooksDir` is read by Export
         * M4B (`studio.component.ts`) and `narratorScratchPath` by the main
         * process, so dropping them would have been a silent removal of two
         * working settings, which is not what "doesnt seem important" asked
         * for. Both are paths under or beside the library.
         */
        fields: [
          {
            key: 'externalAudiobooksDir',
            type: 'path',
            label: 'Default Export Folder',
            description: 'Default folder for the Export M4B dialog (for Syncthing/media server). Leave empty to use system default.',
            default: '/Volumes/Callisto/books/audiobooks',
            placeholder: '/Volumes/Callisto/books/audiobooks',
          },
          /*
           * `condaPath` IS GONE FROM HERE (2026-09-14, audit section 3.5).
           *
           * It was a SECOND control for the same key Settings → Advanced
           * already owns (`tool-paths.json` → `condaPath`), which is one fact
           * with two doors — and the remaining one is itself DELETE-AFTER-PASS,
           * because both readers (`narrator-paths.ts`, `narrator-spawn.ts`) are
           * the legacy local narrator spawn. Deleting the duplicate now costs
           * nothing: Advanced is where a tool PATH has always lived.
           */
          {
            key: 'narratorScratchPath',
            type: 'path',
            label: 'Narrator scratch folder',
            description: 'Where in-progress narration sessions are written before being published into the project. The Reassembly browser reads the same folder. Leave empty to keep it on this machine, beside the render cache — the library is shared and synced, and a render writes thousands of files before it has anything finished to hand over.',
            default: '',
            placeholder: 'Default: ~/Documents/BookForge/scratch (this machine)',
          },
        ],
      },
      {
        id: 'crucible',
        name: 'Crucible Servers',
        description: 'Inference servers the queue may use: this machine’s, and any you add',
        icon: '🛰️',
        fields: [], // Custom UI (app-crucible-servers-panel)
      },
      {
        id: 'ai',
        name: 'AI',
        description: 'Which Crucible model does the reading and writing',
        icon: '🤖',
        fields: [], // AI section has custom UI (app-ai-setup-wizard)
      },
      /*
       * WAS "TTS Server" (id `tts-api`), AND THE TTS IS GONE FROM IT (Phase 16
       * step 8, Owen 2026-09-15: *"there shouldnt be tts server logic in
       * bookforge anymore at all, including the settings"*). The section used to
       * carry the streaming voice, the voice-engine chooser and the 8766 relay's
       * address, because one WebSocket served an external client its speech. The
       * browser extension is a Crucible client now — it picks its own server and
       * its own voice from that server's `GET /v1/voices` — so the voice and the
       * engine left with the relay.
       *
       * What is left is the TAB RECORDER's address, and it is not TTS: a browser
       * can capture a tab but has no filesystem and no ffmpeg, so recording hands
       * raw PCM to a machine that has both. Owen split the plan's step 6 on
       * 2026-09-14 so that endpoint outlives the speak relay, and its host/port/
       * token are still the app's to decide — the extension types them into its
       * own Options, and a browser on ANOTHER machine needs LAN binding and the
       * token to reach this one. Deleting the section outright would have left a
       * security-relevant toggle reachable only by hand-editing JSON.
       */
      /*
       * THE DOCTOR (2026-09-17) IS WHAT "General Add-ons" AND "Advanced" BECAME.
       *
       * Both described mechanisms rather than needs. "Add-ons" listed things the
       * system does not run without; "Advanced" offered a path box to somebody
       * whose problem is that they do not have the thing. Neither could fetch a
       * missing copy, which is the only action that repairs the machine.
       *
       * One page now answers one question — is anything missing, and fix it —
       * and it is the page a person is sent to when something is wrong.
       */
      {
        id: 'doctor',
        name: 'Doctor',
        description: 'What BookForge needs on this computer, and a button that installs it',
        icon: '🩺',
        fields: [], // Custom UI (app-doctor-panel)
      },
      /*
       * THE GENERAL SECTION IS GONE (2026-09-17), because nothing was left in it.
       *
       * It held three things over its life and each left for its own reason:
       * `maxRecentFiles` had no reader anywhere (2026-09-14);
       * `diffIgnoreWhitespace` is toggled in the diff view, beside the thing it
       * changes; and Guided setup was an ACTION sitting on a page of settings,
       * so it became a button under the section list.
       *
       * A section named "General" with nothing in it is the shape a settings
       * tree grows when nobody removes the page after removing its contents.
       */
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
      await this.applyNarratorPaths();
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
  private async applyNarratorPaths(): Promise<void> {
    try {
      const condaPath = this.get<string>('condaPath') || '';
      const narratorScratchPath = this.get<string>('narratorScratchPath') || '';
      await this.electron.configureNarratorPaths({ condaPath, narratorScratchPath });
    } catch (err) {
      console.error('[SettingsService] Failed to apply narrator paths:', err);
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

    // Apply narrator path changes if relevant
    if ('condaPath' in pending || 'narratorScratchPath' in pending) {
      this.applyNarratorPaths();
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

    // Apply narrator path changes immediately
    if (key === 'condaPath' || key === 'narratorScratchPath') {
      this.applyNarratorPaths();
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

    /*
     * The bookshelf server's PORT, and only the port.
     *
     * `enabled` IS GONE (2026-09-14, audit section 3.6). It was set as a side
     * effect of Start and Stop and read by NOTHING but the settings UI itself:
     * nothing auto-starts the server from it, despite a comment here that said
     * it did. A flag that records an intention nobody acts on is worse than no
     * flag — either it starts the server at launch or it should not exist, and
     * making it start one is a behaviour change nobody asked for. Start and
     * Stop remain exactly as live as they were; they just no longer write a
     * value down afterwards.
     */
    defaults['bookshelfConfig'] = { port: 8765 };

    this.values.set(defaults);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AI Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * The app's AI configuration, REBUILT FIELD BY FIELD rather than spread.
   *
   * A blob written before 2026-09-14 carries `aiConfig.claude.apiKey` and
   * `aiConfig.openai.apiKey` — this app's own cloud key store, which is gone
   * (the keys live in the engine now and this app holds none). Spreading the
   * stored object would carry those keys straight back out, and the next
   * `setAIConfig` would write them down again. Naming the three surviving
   * fields instead means nothing rebuilds them, and the first time anything
   * touches the AI config they leave the blob for good. That is this build's
   * shape doing its job, not a migration: no key is read, printed or sent
   * anywhere on the way past.
   *
   * A STORED PROVIDER THAT NAMES A RETIRED ONE IS REPAIRED HERE, loudly and by
   * name — the same treatment `getPipelineDefaults` gives a retired narration
   * engine, and for the same reason: it is a standing selection shown in a
   * picker, not a queued run. Left alone it would render as nothing selected.
   */
  getAIConfig(): AIConfig {
    const stored = this.values()['aiConfig'] as Partial<AIConfig> | undefined;
    if (!stored) {
      return { ...DEFAULT_AI_CONFIG };
    }
    const config: AIConfig = { ...DEFAULT_AI_CONFIG };
    if (stored.provider !== undefined) {
      const resolved = resolveSavedAIProvider(stored.provider);
      // Reported, not rewritten. This runs inside computed signals, and a
      // write from a computed is an Angular error — so unlike the narration
      // engine's repair the stale string stays on disk until something saves
      // the AI config for its own reasons. Said once per value, because the
      // same read happens on every change detection pass.
      if (resolved.migratedFrom && !this.reportedProviderRepairs.has(resolved.migratedFrom)) {
        this.reportedProviderRepairs.add(resolved.migratedFrom);
        console.error(`[SETTINGS] ${resolved.note}`);
      }
      config.provider = resolved.provider;
    }
    if (stored.local !== undefined) config.local = stored.local;
    if (stored.crucible !== undefined) {
      /*
       * THE SERVER NAME IS REPAIRED TOO, and for the same reason the provider
       * above is: a value that was legal when it was written and is not any
       * more. `local` was the reserved name for this machine's engine; the
       * registry retired it, and a config still naming it made every settings
       * read refuse with "no crucible server named local is registered", which
       * names a server the person has never heard of.
       *
       * Reported, not rewritten — this runs inside computed signals and a write
       * from a computed is an Angular error. Said once per value.
       */
      const resolved = resolveSavedCrucibleServer(stored.crucible.server);
      if (resolved.note !== undefined && !this.reportedProviderRepairs.has('server:local')) {
        this.reportedProviderRepairs.add('server:local');
        console.error(`[SETTINGS] ${resolved.note}`);
      }
      config.crucible = resolved.server === undefined
        ? undefined
        : { ...stored.crucible, server: resolved.server };
    }
    return config;
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
   * The renderer owns the setting and hands it to main per run, because main
   * has no copy of this bundle. Empty `url` means MLX here, and that is the default on Apple
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
   * The bookshelf server's port. A record written last year may still carry an
   * `enabled` key; it is ignored rather than refused — an old record must still
   * PARSE, and the field it names no longer exists on either side.
   */
  getBookshelfConfig(): { port: number } {
    const config = this.values()['bookshelfConfig'] as { port?: number } | undefined;
    return { port: config?.port ?? 8765 };
  }

  setBookshelfConfig(config: { port: number }): void {
    this.values.update(v => ({ ...v, bookshelfConfig: config }));
    this.saveSettings();
  }

  updateBookshelfConfig(updates: Partial<{ port: number }>): void {
    const current = this.getBookshelfConfig();
    this.setBookshelfConfig({ ...current, ...updates });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pipeline Defaults
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * The pipeline's default selections, merged with built-in defaults.
   *
   * A STORED RETIRED ENGINE IS REPAIRED HERE, and this is the same shape
   * `streaming-engine.ts`'s `getSelectedEngineName` uses for `tts-engine.json`.
   * Nothing recorded means the built-in defaults, which is not a fallback. A
   * stored `xtts` / `f5` / `voxtral` / `orpheus` — every machine that used one
   * has it — is migrated to Higgs with a console.error naming it, and the
   * settings are rewritten so the stale value stops being re-read. Anything else
   * throws by name.
   *
   * SINCE 2026-09-14 THIS IS THE PATH ALMOST EVERY MACHINE TAKES. Orpheus was
   * retired as a choice that day and it was both the shipped default and the
   * picker's first entry, so essentially every settings blob in existence names
   * a retired engine and gets repaired on the next read. That is exactly the
   * scenario the paragraph below was written for, finally arriving at scale:
   * without the repair, EVERY user would open the narration modal to an engine
   * button group with nothing selected.
   *
   * Without the repair the value simply spread over the defaults: the engine
   * button group (which renders `selectableEngines()`) showed NOTHING selected,
   * and every run threw at `assertRunnableTtsEngine` from a page that offered no
   * way to fix it. Migrating a stored DEFAULT is safe in the way migrating a
   * queued run would not be — it is the seed for the next run, shown in a picker
   * before anything is rendered.
   *
   * THE VOICE GOES WITH THE ENGINE. A voice saved beside `orpheus` is an Orpheus
   * fine-tune name (`leah`, `mistborn`, a folder under `runtime/orpheus-models/`);
   * carrying it onto Higgs would produce exactly the unrenderable pair this
   * repair exists to prevent, so it resets to the default voice too.
   *
   * A STORED RETIRED AI PROVIDER IS REPAIRED THE SAME WAY (2026-09-14). A
   * machine that chose Ollama, Claude or OpenAI for a role has that string on
   * disk, and those three left BookForge entirely — so the role's picker would
   * show nothing selected and no way to see why. THE MODEL GOES WITH THE
   * PROVIDER, exactly as the voice goes with the engine: `cogito:14b` saved
   * beside `ollama` is an Ollama tag, and carrying it onto the bundled local
   * model would be the unrunnable pair over again.
   */
  getPipelineDefaults(): PipelineDefaults {
    const stored = this.values()['pipelineDefaults'] as Partial<PipelineDefaults> | undefined;
    let repaired: PipelineDefaults = { ...DEFAULT_PIPELINE_DEFAULTS, ...(stored || {}) };
    let anyRepair = false;

    for (const role of ['cleanup', 'simplify', 'translate'] as const) {
      if (stored?.[`${role}Provider`] === undefined) continue;
      const answer = resolveSavedAIProvider(repaired[`${role}Provider`]);
      if (!answer.migratedFrom) continue;
      console.error(`[SETTINGS] ${role}: ${answer.note}`);
      repaired = {
        ...repaired,
        [`${role}Provider`]: answer.provider,
        [`${role}Model`]: DEFAULT_PIPELINE_DEFAULTS[`${role}Model`],
      } as PipelineDefaults;
      anyRepair = true;
    }

    if (stored?.ttsEngine !== undefined) {
      const resolved = resolveSavedTtsEngine(repaired.ttsEngine);
      if (resolved.migratedFrom) {
        console.error(`[SETTINGS] ${resolved.note}`);
        repaired = {
          ...repaired,
          ttsEngine: resolved.engine,
          ttsVoice: DEFAULT_PIPELINE_DEFAULTS.ttsVoice,
        };
        anyRepair = true;
      }
    }

    if (!anyRepair) return repaired;
    this.setPipelineDefaults(repaired);
    return repaired;
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
