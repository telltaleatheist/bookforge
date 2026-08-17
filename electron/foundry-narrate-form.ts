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
 * ── NOTHING HERE INVENTS A VALUE ────────────────────────────────────────────
 *
 * Foundry validates nothing on the way through and says so: the values are
 * whatever the declared controls produced, and *"the host is the only side that
 * knows what any of them mean"*. So this side proves every one of them and
 * refuses in a whole sentence when it cannot — the rejection travels back over
 * `host-ops:invoke` and is shown AT THE BUTTON, which makes a readable sentence
 * the only acceptable failure. In particular a number the user emptied arrives
 * OMITTED rather than as NaN (Foundry's rule), and an omitted worker count is
 * refused rather than quietly read as one.
 */

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

/** The most workers this dialog will offer. The modal's own ceiling for a book. */
export const NARRATE_MAX_WORKERS = 4;

/**
 * WHAT THE REST OF THE RUN IS READ FROM — the saved narration settings, as the
 * modal's own pre-fill reads them.
 *
 * The form asks three questions and a narration is a dozen decisions. Everything
 * it does not ask comes from Settings → Pipeline Defaults, which is the store the
 * modal seeds every one of its controls from (`SettingsService.getPipelineDefaults`),
 * so the two doors start from the same answers. This is the SUBSET a run needs;
 * the AI-role and video fields of that record are nothing to do with narration.
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
 * The RVC block is the one part that is allowed to be absent: enhancement is an
 * opt-in pass, `rvcEnhancementEnabled: false` is a complete answer, and the four
 * numbers beside it only mean anything once it is on.
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
    rvcEnhancementIndexRate: rvcOn
      ? savedNumber(record, 'rvcEnhancementIndexRate', 'the voice-conversion index rate')
      : 0,
    rvcEnhancementProtectRate: rvcOn
      ? savedNumber(record, 'rvcEnhancementProtectRate', 'the voice-conversion protect rate')
      : 0,
    rvcEnhancementNSemitones: rvcOn
      ? savedNumber(record, 'rvcEnhancementNSemitones', 'the voice-conversion pitch shift')
      : 0,
  };
}

/**
 * THE FORM, as Foundry is asked to draw it.
 *
 * Three questions and no more, and the omissions are the design. Engine, speed,
 * sampling and the enhancement pass all come from the saved settings above,
 * because a dialog in another application's window that asked a dozen questions
 * would be a second narration modal — and the moment there are two, one of them
 * is a field behind.
 *
 * VOICE IS SEEDED FROM THE SAVED ONE ONLY WHEN IT IS STILL INSTALLED. A `default`
 * naming a voice that is no longer on disk would be Foundry drawing a chosen
 * option this machine cannot render; with the field omitted, Foundry seeds the
 * select with its first option, which is a voice that exists and which the person
 * is looking at before they press Start.
 *
 * NO VOICES IS A REFUSAL AND NOT AN EMPTY SELECT, because a dialog whose one
 * required choice has nothing in it is a Start button that can only fail.
 */
export function narrateFormFields(
  voices: readonly NarrateVoiceOption[],
  saved: NarrateSavedSettings,
): readonly FoundryHostOpField[] {
  if (voices.length === 0) {
    throw new Error(
      `No ${saved.ttsEngine} voice is installed, so there is nothing to read this book in. `
      + 'Download a voice in BookForge under Settings → Voices, then press Narrate again.',
    );
  }
  const savedIsInstalled = voices.some((one) => one.value === saved.ttsVoice);
  return [
    {
      key: 'voice',
      label: 'Voice',
      kind: 'select',
      options: voices.map((one) => ({ value: one.value, label: one.label })),
      ...(savedIsInstalled ? { default: saved.ttsVoice } : {}),
      help: `Read by ${saved.ttsEngine}. Everything else comes from BookForge's pipeline defaults.`,
    },
    {
      key: 'device',
      label: 'Device',
      kind: 'select',
      options: NARRATE_DEVICE_OPTIONS,
      default: 'auto',
      help: 'Auto picks the GPU when one is usable, and the CPU when it is not.',
    },
    {
      key: 'workers',
      label: 'Workers',
      kind: 'number',
      default: 1,
      min: 1,
      max: NARRATE_MAX_WORKERS,
      help: 'More workers render faster on CPU. A GPU run uses one.',
    },
  ];
}

/** The three answers, proved. */
export interface NarrateAnswers {
  readonly voice: string;
  readonly device: 'auto' | 'gpu' | 'cpu';
  readonly workers: number;
}

/**
 * What the person chose, read out of the bag Foundry handed back.
 *
 * ── Each refusal is a sentence at the button ────────────────────────────────
 *
 * An emptied number field arrives OMITTED rather than as NaN — that is Foundry's
 * stated rule for the control — so an absent `workers` means somebody cleared the
 * box, and the honest answer is to say so rather than to read the blank as one.
 * Same for a voice: `settings` is the only place the answer exists, and a run
 * queued with the field missing would render in whatever the config's next reader
 * decided, an hour later, with nobody watching.
 */
export function readNarrateAnswers(settings: Record<string, unknown>): NarrateAnswers {
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
  const workers = settings['workers'];
  if (workers === undefined) {
    throw new Error(
      'The narration dialog came back with the Workers box empty, and BookForge will not pick a '
      + 'number for you. Type a whole number from 1 to '
      + `${NARRATE_MAX_WORKERS} and press Start again.`,
    );
  }
  if (typeof workers !== 'number' || !Number.isInteger(workers)
    || workers < 1 || workers > NARRATE_MAX_WORKERS) {
    throw new Error(
      `${String(workers)} is not a number of narration workers BookForge can run. Type a whole `
      + `number from 1 to ${NARRATE_MAX_WORKERS} and press Start again.`,
    );
  }
  return { voice: voice.trim(), device, workers };
}
