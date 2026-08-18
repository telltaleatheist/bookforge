/**
 * foundry-narrate-form — the questions Narrate asks in Foundry's window, and the
 * reading of the answers that come back.
 *
 * ── What changed, and why there is a module for it ──────────────────────────
 *
 * Narrate used to raise BookForge's main window and open the narration modal
 * there. Owen's ruling (BookForge → Foundry, 2026-08-18): *"Today
 * `bookforge.narrate` raises the BookForge main window and opens its modal
 * there. Owen wants the dialog in the Foundry window, like translate/simplify."*
 * A host cannot render into that window — that is the whole reason the socket
 * exists rather than a shared component — so what crosses instead is a
 * DESCRIPTION of the questions (`HostOperationOffer.form`), Foundry draws it in
 * its own dialog language, and the answers come back on the invoke as
 * `settings`.
 *
 * Both halves of that are pure decisions about values, so both live here rather
 * than in main.ts: which fields to describe given what is installed, and what a
 * bag of `unknown`s from another application's dialog is allowed to mean. The
 * wiring in main.ts is left holding the disk reads and the enqueue.
 *
 * ── OWEN'S RULING OF 2026-08-16, which rewrote this file ────────────────────
 *
 * The first version of this form asked three questions — voice, device, workers —
 * and its header argued that the omissions were the design, on the grounds that a
 * dialog in another application's window which asked a dozen questions would be a
 * second narration modal. Owen ruled against both halves of that:
 *
 *  1. WORKER COUNT IS DEPRECATED. A run always uses one worker. The question is
 *     gone from this form and `workers: 1` is what the queued run carries — not a
 *     default this side picked, but the only value there is.
 *  2. THE DIALOG CARRIES THE MODAL'S OWN CONTROL SET, assembly section included.
 *     The fear of two modals drifting apart is real, but the answer to it is that
 *     both doors compose the SAME run description (shared/queue/narration-run.ts)
 *     and seed from the SAME saved settings — not that one door asks less.
 *
 * So the fields below are the narration modal's controls, in the modal's own
 * order, minus the two a static form cannot honestly draw. Which two, and why, is
 * the next section.
 *
 * ── WHAT A STATIC FORM CANNOT ASK ───────────────────────────────────────────
 *
 * Foundry's dialog has no conditional visibility and no dynamic re-filtering, and
 * says so in as many words: *"WHAT IS DELIBERATELY NOT HERE is conditional logic —
 * no 'show this field only when that one is set', no cross-field validation, no
 * dependent option lists."* Two of the modal's controls are exactly that shape:
 *
 *  - ENGINE. The voice list depends on it — Orpheus has a roster of its own and
 *    everything else renders from the XTTS-family reference clips — so an engine
 *    picker in a dialog that cannot re-filter the voice select beside it would let
 *    somebody choose Orpheus and then hand it an XTTS reference clip, which fails
 *    inside the job an hour later. The engine therefore comes from Settings →
 *    Pipeline Defaults, and the voice list is that engine's.
 *  - THE RVC ON/OFF CHECKBOX. The modal shows a model picker only once the box is
 *    ticked; here the two collapse into one select whose first option is None,
 *    which asks the same question in one control that needs no visibility rule.
 *
 * Everything else the modal shows is here. The three enhancement RATES (index,
 * protect, pitch) are not asked in the modal either — it prints them as a hint and
 * points at Settings — so they are read from the saved settings, as there.
 *
 * ── NOTHING HERE INVENTS A VALUE ────────────────────────────────────────────
 *
 * Foundry validates nothing on the way through and says so: the values are
 * whatever the declared controls produced, and *"the host is the only side that
 * knows what any of them mean"*. So this side proves every one of them and
 * refuses in a whole sentence when it cannot — the rejection travels back over
 * `host-ops:invoke` and is shown AT THE BUTTON, which makes a readable sentence
 * the only acceptable failure. In particular a number the user emptied arrives
 * OMITTED rather than as NaN (Foundry's rule), and an omitted number is refused by
 * name rather than quietly read as the saved one.
 */

import { engineCaps, isTtsEngine } from '../shared/tts/engine-caps';

/**
 * ONE QUESTION, in Foundry's spelling.
 *
 * Declared here rather than imported for the reason main.ts declares the rest of
 * the mount contract: `foundry-app/` is built output of a separate program with
 * its own tsconfig, and a static import would drag the sealed subtree into
 * BookForge's type program. This is `HostOpField` from
 * foundry-app/shared/host-ops.ts; a change on their side shows up as a compile
 * error naming the field.
 */
export interface FoundryHostOpField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'select' | 'number' | 'toggle' | 'text';
  readonly options?: readonly { value: string; label: string }[];
  readonly default?: string | number | boolean;
  readonly min?: number;
  readonly max?: number;
  readonly help?: string;
}

/** A voice as both processes list it. Mirrors `shared/tts/narration-voices.ts`. */
export interface NarrateVoiceOption {
  readonly value: string;
  readonly label: string;
}

/**
 * THE DEVICES A NARRATION MAY BE ASKED FOR, in this dialog.
 *
 * Three where the modal offers four: Metal is not listed, because 'auto' already
 * resolves to MPS on Apple Silicon and a fourth button that means "the same as
 * Auto, unless you are on the wrong machine, where it means fail" is a choice
 * nobody can make correctly from another application's window. An explicit GPU
 * or CPU is honoured exactly, as everywhere else.
 */
export const NARRATE_DEVICE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'gpu', label: 'GPU' },
  { value: 'cpu', label: 'CPU' },
];

/**
 * THE BOUNDS ON EACH NUMBER, and where they come from.
 *
 * Each pair is the range of the narration modal's own slider for that control, to
 * the step — because the two doors describe one run, and a value this dialog will
 * take but that one will not is a difference the user would discover by hearing
 * it. They are declared once so the field description and the refusal that names
 * the range cannot disagree about what the range is.
 */
export const NARRATE_NUMBER_BOUNDS = {
  speed: { min: 0.5, max: 2 },
  temperature: { min: 0.1, max: 1.0 },
  topP: { min: 0.1, max: 1.0 },
  repetitionPenalty: { min: 1, max: 10 },
} as const;

/** The numbers this dialog may ask for — the keys of the bounds above. */
export type NarrateNumberKey = keyof typeof NARRATE_NUMBER_BOUNDS;

/** What each number's control is called, in the modal's own words. */
const NUMBER_LABELS: Record<NarrateNumberKey, string> = {
  speed: 'Speed',
  temperature: 'Temperature',
  topP: 'Top P',
  repetitionPenalty: 'Repetition penalty',
};

/**
 * What each number is called inside a sentence.
 *
 * A separate map from the labels above, because "3 is not a Top P BookForge can
 * narrate at" reads as a mistake. These are the same phrases the saved-settings
 * refusals use, so a person who sees both hears one voice.
 */
const NUMBER_PHRASES: Record<NarrateNumberKey, string> = {
  speed: 'reading speed',
  temperature: 'sampling temperature',
  topP: 'sampling top-p',
  repetitionPenalty: 'repetition penalty',
};

/**
 * WHAT THE REST OF THE RUN IS READ FROM — the saved narration settings, as the
 * modal's own pre-fill reads them.
 *
 * Every control this dialog draws STARTS on the value saved here, exactly as the
 * modal's controls do (`SettingsService.getPipelineDefaults`), so the two doors
 * open on the same answers. What the dialog does not ask — the engine, the
 * language, the three enhancement rates — is taken from here unchanged. This is
 * the SUBSET a run needs; the AI-role and video fields of that record are nothing
 * to do with narration.
 */
export interface NarrateSavedSettings {
  readonly ttsEngine: string;
  readonly ttsVoice: string;
  readonly ttsSpeed: number;
  readonly ttsTemperature: number;
  readonly ttsTopP: number;
  readonly ttsRepetitionPenalty: number;
  readonly rvcEnhancementEnabled: boolean;
  readonly rvcEnhancementVoiceId: string;
  readonly rvcEnhancementIndexRate: number;
  readonly rvcEnhancementProtectRate: number;
  readonly rvcEnhancementNSemitones: number;
}

/** The sentence every missing saved setting refuses with. One wording, one place. */
function noSavedSetting(what: string): Error {
  return new Error(
    `BookForge has no saved narration setting for ${what}, and it will not choose one for you — a `
    + 'run rendered at a guessed setting sounds finished and is wrong. Open BookForge, go to '
    + 'Settings → Pipeline Defaults, set the narration defaults once, and press Narrate again.',
  );
}

function savedText(raw: Record<string, unknown>, key: string, what: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') throw noSavedSetting(what);
  return value.trim();
}

function savedNumber(raw: Record<string, unknown>, key: string, what: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw noSavedSetting(what);
  return value;
}

/**
 * The saved settings, proved — or a refusal naming the one that is missing.
 *
 * ── Why it is read from an `unknown` at all ─────────────────────────────────
 *
 * Because the store is the RENDERER's. `SettingsService` keeps the whole
 * settings record in this window's `localStorage` under `bookforge-settings`,
 * and there is no main-process mirror of it — main.ts's own `invokeFoundryEnhance`
 * already says so in as many words ("the pipeline defaults live in the RENDERER's
 * settings store"). So main reads the one store rather than keeping a second, and
 * what it gets back is JSON nobody has checked.
 *
 * EVERY FIELD IS PROVED AND NONE IS DEFAULTED. `getPipelineDefaults()` merges the
 * stored record over a shipped default on the renderer's side; this does NOT,
 * deliberately — a machine whose settings blob is missing `ttsVoice` is a machine
 * where nobody has chosen a voice, and rendering nine hours of book in whichever
 * voice the shipped default names is the failure this whole codebase's
 * no-fallbacks rule exists to prevent. The refusal says which door sets it.
 *
 * THE ENHANCEMENT VOICE IS THE ONE FIELD ALLOWED TO BE ABSENT: enhancement is an
 * opt-in pass, `rvcEnhancementEnabled: false` is a complete answer, and the model
 * name only means anything once the pass is on.
 *
 * ITS THREE RATES ARE NOT. They used to be read only when the saved pass was on,
 * which was true while the saved flag decided whether the run enhanced at all —
 * but the dialog can now turn the pass ON for a machine whose Settings has it off,
 * and reading absent rates as zero would re-render the whole audiobook at an index
 * rate of 0 that nobody typed. They are always present in a record anybody has
 * ever saved (`setPipelineDefaults` writes the whole merged record), so a blob
 * without them is a blob with no narration settings at all, which every field
 * above already refuses.
 */
export function readNarrateSavedSettings(raw: unknown): NarrateSavedSettings {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      'BookForge has no saved narration settings at all, so it does not know how this book should '
      + 'be read. Open BookForge, go to Settings → Pipeline Defaults, set the narration defaults '
      + 'once, and press Narrate again.',
    );
  }
  const record = raw as Record<string, unknown>;
  const rvcOn = record['rvcEnhancementEnabled'] === true;
  return {
    ttsEngine: savedText(record, 'ttsEngine', 'the TTS engine'),
    ttsVoice: savedText(record, 'ttsVoice', 'the voice'),
    ttsSpeed: savedNumber(record, 'ttsSpeed', 'the reading speed'),
    ttsTemperature: savedNumber(record, 'ttsTemperature', 'the sampling temperature'),
    ttsTopP: savedNumber(record, 'ttsTopP', 'the sampling top-p'),
    ttsRepetitionPenalty: savedNumber(record, 'ttsRepetitionPenalty', 'the repetition penalty'),
    rvcEnhancementEnabled: rvcOn,
    // Read only when the pass is on. An enhancement turned on with no model is
    // still refused — by the run description, which is where that rule lives.
    rvcEnhancementVoiceId: rvcOn
      ? savedText(record, 'rvcEnhancementVoiceId', 'the voice-conversion model')
      : '',
    // Required whether or not the saved pass is on — see the header. The dialog
    // can turn it on, and these are the only place its rates come from.
    rvcEnhancementIndexRate:
      savedNumber(record, 'rvcEnhancementIndexRate', 'the voice-conversion index rate'),
    rvcEnhancementProtectRate:
      savedNumber(record, 'rvcEnhancementProtectRate', 'the voice-conversion protect rate'),
    rvcEnhancementNSemitones:
      savedNumber(record, 'rvcEnhancementNSemitones', 'the voice-conversion pitch shift'),
  };
}

/** One installed RVC model, as the enhancement select lists it. */
export interface NarrateRvcModel {
  readonly id: string;
  readonly name: string;
}

/**
 * WHAT THIS MACHINE CAN RE-RENDER THROUGH — the enhancement pass's two conditions.
 *
 * The modal shows its RVC section behind `rvcInstalled` (the `rvc-env` component)
 * and fills the picker from the installed `rvc-model` components. Both are asked
 * of the component registry in main; this is the answer, handed in.
 */
export interface NarrateEnhancementCatalog {
  /** The `rvc-env` component reports installed. Without it the pass cannot run. */
  readonly envInstalled: boolean;
  /** The installed `rvc-model` components, in the order the registry lists them. */
  readonly models: readonly NarrateRvcModel[];
}

/**
 * WHICH OF THE OPTIONAL QUESTIONS THE DIALOG ACTUALLY CARRIED.
 *
 * The form is not the same shape on every machine — an Orpheus run has no
 * sampling controls to draw and a machine with no RVC models has no enhancement
 * to offer — and the answer bag that comes back carries only what was drawn. So
 * reading the answers requires knowing what was asked: without it, a missing
 * `temperature` is indistinguishable from a temperature box the user emptied, and
 * those two have opposite correct handling (one is the saved value, one is a
 * refusal).
 *
 * It travels WITH the field list rather than being recomputed at invoke time, so
 * the answers are proved against the form that was actually on screen.
 */
export interface NarrateAskedFields {
  readonly temperature: boolean;
  readonly topP: boolean;
  readonly repetitionPenalty: boolean;
  /**
   * The RVC model ids that were offered beside None, or null when the whole
   * enhancement select was absent. An empty array is not a state: the field is
   * only drawn when there is at least one model to name.
   */
  readonly enhancementModelIds: readonly string[] | null;
}

/** The form, and the record of what it asked. */
export interface NarrateOffer {
  readonly fields: readonly FoundryHostOpField[];
  readonly asked: NarrateAskedFields;
}

/**
 * THE FORM, as Foundry is asked to draw it.
 *
 * The narration modal's controls, in the modal's own order, minus the engine
 * picker and the RVC on/off box a static dialog cannot honestly draw — the header
 * says which and why. Every field's `default` is the saved setting for that
 * control, so the dialog opens showing the run somebody would get by pressing
 * Start without touching anything, and that run is the one Settings describes.
 *
 * THE SAMPLING TRIO IS THE ENGINE'S, NOT THE FORM'S. `engineCaps().sampling` says
 * whether temperature, top-p and repetition penalty mean anything to this engine;
 * Orpheus and Voxtral honour none of the three, because their sampling is fixed
 * inside the engine class, so drawing those boxes for an Orpheus run would be
 * three controls that change nothing about the audio. A field the engine does not
 * have is not asked, and the run carries the saved value for it. This is the same
 * gate the modal draws its Advanced section behind (`showsSampling()`).
 *
 * SPEED IS ASKED OF EVERY ENGINE and is deliberately outside that gate, because
 * the modal's speed slider is outside it too — it is drawn whenever narration is
 * on, whatever the engine is.
 *
 * VOICE IS SEEDED FROM THE SAVED ONE ONLY WHEN IT IS STILL INSTALLED. A `default`
 * naming a voice that is no longer on disk would be Foundry drawing a chosen
 * option this machine cannot render; with the field omitted, Foundry seeds the
 * select with its first option, which is a voice that exists and which the person
 * is looking at before they press Start.
 *
 * NO VOICES IS A REFUSAL AND NOT AN EMPTY SELECT, because a dialog whose one
 * required choice has nothing in it is a Start button that can only fail.
 *
 * A SAVED NUMBER OUTSIDE ITS RANGE IS PASSED THROUGH RATHER THAN CLAMPED. It
 * arrives as the field's `default`, the person sees it in a box labelled with its
 * bounds, and if they press Start on it the parse refuses and names the range.
 * Quietly moving it here would render the book at a speed nobody chose and never
 * mention it.
 */
export function narrateFormOffer(
  voices: readonly NarrateVoiceOption[],
  saved: NarrateSavedSettings,
  enhancement: NarrateEnhancementCatalog,
): NarrateOffer {
  if (!isTtsEngine(saved.ttsEngine)) {
    throw new Error(
      `BookForge's saved narration settings name "${saved.ttsEngine}" as the TTS engine, and this `
      + 'build has no such engine, so it does not know what it would be able to ask you. Open '
      + 'BookForge, go to Settings → Pipeline Defaults, choose an engine, and press Narrate again.',
    );
  }
  if (voices.length === 0) {
    throw new Error(
      `No ${saved.ttsEngine} voice is installed, so there is nothing to read this book in. `
      + 'Download a voice in BookForge under Settings → Voices, then press Narrate again.',
    );
  }
  const sampling = engineCaps(saved.ttsEngine).sampling;
  const asked: NarrateAskedFields = {
    temperature: sampling.temperature === true,
    topP: sampling.topP === true,
    repetitionPenalty: sampling.repetitionPenalty === true,
    enhancementModelIds: enhancement.envInstalled && enhancement.models.length > 0
      ? enhancement.models.map((one) => one.id)
      : null,
  };

  const savedVoiceIsInstalled = voices.some((one) => one.value === saved.ttsVoice);
  const number = (key: NarrateNumberKey, label: string, value: number): FoundryHostOpField => ({
    key,
    label,
    kind: 'number',
    default: value,
    min: NARRATE_NUMBER_BOUNDS[key].min,
    max: NARRATE_NUMBER_BOUNDS[key].max,
  });

  const fields: FoundryHostOpField[] = [
    // The two halves of the run, both on: a narration nobody assembles leaves
    // rendered sentences and no audiobook, and an assembly with no narration is
    // how a cached session is turned into an M4B. The modal's own two checkboxes.
    {
      key: 'narrate',
      label: 'Read the book aloud',
      kind: 'toggle',
      default: true,
      help: 'Render every sentence of the book with the voice below.',
    },
    {
      key: 'assemble',
      label: 'Assemble the audiobook',
      kind: 'toggle',
      default: true,
      help: 'Combine the rendered sentences into an M4B with its chapters and cover.',
    },
    {
      key: 'voice',
      label: 'Voice',
      kind: 'select',
      options: voices.map((one) => ({ value: one.value, label: one.label })),
      ...(savedVoiceIsInstalled ? { default: saved.ttsVoice } : {}),
      help: `Read by ${saved.ttsEngine}. Change the engine in BookForge under `
        + 'Settings → Pipeline Defaults.',
    },
    {
      key: 'device',
      label: 'Device',
      kind: 'select',
      options: NARRATE_DEVICE_OPTIONS,
      default: 'auto',
      help: 'Auto picks the GPU when one is usable, and the CPU when it is not.',
    },
  ];

  // Speed is asked of EVERY engine, and deliberately not gated on
  // `engineCaps().sampling.speed`. The narration modal's own slider is outside
  // its `showsSampling()` gate — it is drawn whenever narration is on, whatever
  // the engine — so gating it here would give an Orpheus run no speed control in
  // Foundry's window while BookForge's own dialog has one, which is precisely the
  // parity this form exists to hold.
  fields.push(number('speed', NUMBER_LABELS.speed, saved.ttsSpeed));

  if (asked.temperature) {
    fields.push(number('temperature', NUMBER_LABELS.temperature, saved.ttsTemperature));
  }
  if (asked.topP) fields.push(number('topP', NUMBER_LABELS.topP, saved.ttsTopP));
  if (asked.repetitionPenalty) {
    fields.push(number(
      'repetitionPenalty', NUMBER_LABELS.repetitionPenalty, saved.ttsRepetitionPenalty));
  }

  // The assembly section. Both passes default OFF exactly as the modal's
  // checkboxes start — neither is a saved setting, and running a de-ring filter
  // nobody asked for would be a decision made in this form's name.
  fields.push(
    {
      key: 'finalDenoise',
      label: 'Denoise the finished audio',
      kind: 'toggle',
      default: false,
    },
    {
      key: 'applyDeRing',
      label: 'Remove ringing',
      kind: 'toggle',
      default: false,
    },
  );

  if (asked.enhancementModelIds !== null) {
    /*
     * NONE IS AN OPTION RATHER THAN A SEPARATE CHECKBOX, because the modal's
     * checkbox-then-picker pair needs the conditional visibility Foundry's dialog
     * does not have. One select answers both questions and cannot be left in the
     * contradictory state (enhancement on, no model) the pair can reach.
     */
    const savedModelIsInstalled = saved.rvcEnhancementEnabled
      && enhancement.models.some((one) => one.id === saved.rvcEnhancementVoiceId);
    fields.push({
      key: 'enhancement',
      label: 'Re-render through an RVC voice',
      kind: 'select',
      options: [
        { value: 'none', label: 'None' },
        ...enhancement.models.map((one) => ({ value: one.id, label: one.name })),
      ],
      default: savedModelIsInstalled ? saved.rvcEnhancementVoiceId : 'none',
      help: 'Index, protect and pitch come from BookForge under Settings → Pipeline Defaults.',
    });
  }

  return { fields, asked };
}

/** Everything the person chose, proved, and resolved against what was not asked. */
export interface NarrateAnswers {
  readonly narrate: boolean;
  readonly assemble: boolean;
  readonly voice: string;
  readonly device: 'auto' | 'gpu' | 'cpu';
  readonly speed: number;
  readonly temperature: number;
  readonly topP: number;
  readonly repetitionPenalty: number;
  readonly finalDenoise: boolean;
  readonly applyDeRing: boolean;
  /** The chosen RVC model, or null for None — and for a dialog that had no select. */
  readonly rvcVoiceId: string | null;
}

/** A toggle, proved. Foundry sends a real boolean or the field was not drawn. */
function readToggle(settings: Record<string, unknown>, key: string, label: string): boolean {
  const value = settings[key];
  if (typeof value !== 'boolean') {
    throw new Error(
      `The narration dialog came back without an answer for "${label}", so BookForge does not know `
      + 'whether that step was wanted. Press Start again; if it keeps happening, BookForge and '
      + 'Foundry disagree about this dialog and one of them needs updating.',
    );
  }
  return value;
}

/**
 * A number this dialog ASKED FOR, proved against the bounds it was drawn with.
 *
 * The absent case is the one a real person produces: Foundry's stated rule for
 * the control is that a number the user cleared is left OUT of `settings` rather
 * than sent as NaN. Reading that blank as the saved value would be this side
 * answering a question it had just asked.
 */
function readAskedNumber(
  settings: Record<string, unknown>,
  key: NarrateNumberKey,
): number {
  const bounds = NARRATE_NUMBER_BOUNDS[key];
  const label = NUMBER_LABELS[key];
  const value = settings[key];
  if (value === undefined) {
    throw new Error(
      `The narration dialog came back with the ${label} box empty, and BookForge will not pick a `
      + `number for you. Type a number from ${bounds.min} to ${bounds.max} and press Start again.`,
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < bounds.min || value > bounds.max) {
    throw new Error(
      `${String(value)} is not a ${NUMBER_PHRASES[key]} BookForge can narrate at. Type a number `
      + `from ${bounds.min} to ${bounds.max} and press Start again.`,
    );
  }
  return value;
}

/**
 * What the person chose, read out of the bag Foundry handed back.
 *
 * ── Each refusal is a sentence at the button ────────────────────────────────
 *
 * Foundry validates nothing on the way through, so every answer is proved here
 * and every failure is a whole sentence — the rejection is shown AT THE BUTTON in
 * Foundry's window, where somebody is looking, which is the only place a
 * narration's settings can still be corrected before an hour of GPU is spent.
 *
 * ── The one place a saved value stands in for an answer ─────────────────────
 *
 * `asked` says which of the three sampling numbers the dialog actually carried,
 * and for the ones it did not, the saved setting is used. THIS IS NOT A FALLBACK.
 * One of those fields is absent only because `engineCaps().sampling` says the
 * engine has no such control — an Orpheus run's temperature is fixed inside the
 * engine class — so there was never an answer to be had, and the saved value is
 * the single source that run has for a number the config still has to carry.
 *
 * The distinction that matters: a field the form DID ask and that came back empty
 * is refused BY NAME, because that one is a question the user was shown and left
 * blank. Speed is always asked, of every engine, so it is always in that second
 * category and never read from the saved settings here.
 */
export function readNarrateAnswers(
  settings: Record<string, unknown>,
  asked: NarrateAskedFields,
  saved: NarrateSavedSettings,
): NarrateAnswers {
  const narrate = readToggle(settings, 'narrate', 'Read the book aloud');
  const assemble = readToggle(settings, 'assemble', 'Assemble the audiobook');
  if (!narrate && !assemble) {
    throw new Error(
      'There is nothing to queue: reading the book aloud is off and assembling the audiobook is '
      + 'off. Turn one of them on and press Start again.',
    );
  }

  const voice = settings['voice'];
  if (typeof voice !== 'string' || voice.trim() === '') {
    throw new Error(
      'The narration dialog came back without a voice, so BookForge would have to choose one for '
      + 'you. Pick a voice and press Start again.',
    );
  }
  const device = settings['device'];
  if (device !== 'auto' && device !== 'gpu' && device !== 'cpu') {
    throw new Error(
      `"${String(device)}" is not a device BookForge can narrate on. Choose Auto, GPU or CPU and `
      + 'press Start again.',
    );
  }

  const finalDenoise = readToggle(settings, 'finalDenoise', 'Denoise the finished audio');
  const applyDeRing = readToggle(settings, 'applyDeRing', 'Remove ringing');

  let rvcVoiceId: string | null = null;
  if (asked.enhancementModelIds !== null) {
    const chosen = settings['enhancement'];
    if (chosen === 'none') {
      rvcVoiceId = null;
    } else if (typeof chosen === 'string' && asked.enhancementModelIds.includes(chosen)) {
      rvcVoiceId = chosen;
    } else {
      throw new Error(
        `"${String(chosen)}" is not one of the voice-conversion models this machine has installed, `
        + 'so BookForge cannot re-render the audiobook through it. Choose None or an installed '
        + 'model and press Start again.',
      );
    }
  }

  return {
    narrate,
    assemble,
    voice: voice.trim(),
    device,
    // Always asked, so always proved — never taken from the saved settings.
    speed: readAskedNumber(settings, 'speed'),
    temperature: asked.temperature
      ? readAskedNumber(settings, 'temperature')
      : saved.ttsTemperature,
    topP: asked.topP ? readAskedNumber(settings, 'topP') : saved.ttsTopP,
    repetitionPenalty: asked.repetitionPenalty
      ? readAskedNumber(settings, 'repetitionPenalty')
      : saved.ttsRepetitionPenalty,
    finalDenoise,
    applyDeRing,
    rvcVoiceId,
  };
}
