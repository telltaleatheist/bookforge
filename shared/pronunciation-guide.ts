/**
 * THE PRONUNCIATION GUIDE'S REVIEW, as it crosses into BookForge's review window.
 *
 * Owen, 2026-10-03: *"if they want to run glossary alone, they can go back to
 * foundry when its done and review the words"* — a list of the book's printed
 * forms and how the narrator will say them, where a reading can be changed and a
 * form or a single spot "left to the narrator": *"the printed text reaches the
 * narrator untouched"*.
 *
 * The guide itself is `electron/narration-glossary.ts`'s file; this is the view a
 * person edits and the shape their edits come back in. Read and written by
 * `electron/pronunciation-review.ts`.
 */

/** One way the book uses a form, and how it is said. '' is as printed. */
export interface GuideReviewSense {
  meaning: string;
  reading: string;
  /** Whether a period right after the form is this meaning's own ("esp." for especially). */
  periodIsPart: boolean;
  /**
   * What the guide's model said the meaning IS (initials said letter by letter, an acronym said as a
   * word, an abbreviation, a numeral, a word). Absent on a meaning a person wrote.
   */
  kind?: 'initials' | 'acronym' | 'abbreviation' | 'numeral' | 'word';
  /** Why the guide could not give this meaning's reading to the book; its spots stay as printed. */
  problem?: string;
}

/** One printed spot of a form. */
export interface GuideReviewSpot {
  at: string;
  nth: number;
  printed: string;
  /** The meaning it is in, or null: the guide did not decide it, and the cleaner reads it in its sentence. */
  sense: number | null;
  /** How sure the guide was, or null when a person placed it. */
  p: number | null;
  byPerson: boolean;
  /** Its sentence, or null when the book no longer prints it where the guide saw it. */
  sentence: string | null;
}

export interface GuideReviewForm {
  key: string;
  kind: 'roman' | 'caps' | 'abbreviation';
  count: number;
  /** `as-printed` with no meanings: the whole form is left to the narrator. */
  decision: 'as-printed' | 'reading';
  senses: GuideReviewSense[];
  spots: GuideReviewSpot[];
  by: 'model' | 'person';
  why: string;
  /** Whether Apply writes this word's readings into the text (false: a person took it out). */
  applied: boolean;
}

export interface GuideReview {
  projectDir: string;
  /** The step the guide belongs to — a guide is one step's, never the whole book's. */
  at: string;
  /** The book's title, for the window. */
  title: string;
  /**
   * WHICH GUIDE THIS IS — a digest of the file as it was read. A save names it,
   * and is refused when the guide changed underneath (a guide step ran meanwhile)
   * rather than writing one person's edits over decisions they never saw.
   */
  version: string;
  /** When the guide was last started from zero, if it says. */
  built: string | null;
  forms: GuideReviewForm[];
  /** THE APPLY (Owen, 2026-11-01): how many places it would write into the text as the guide stands. */
  applyPlaces: number;
  /** The step an Apply of this guide landed as, or null when it has not been applied. */
  appliedStep: { id: string; label: string } | null;
  /** The guide as it stands would write something other than what the applied step was made with. */
  applyPending: boolean;
  /** Whether the step the guide belongs to has landed — Apply writes from a landed step. */
  landed: boolean;
}

/** One form as the person left it. Its spots name their meaning by index into `senses`. */
export interface GuideReviewFormEdit {
  key: string;
  kind: GuideReviewForm['kind'];
  decision: GuideReviewForm['decision'];
  senses: GuideReviewSense[];
  spots: { at: string; nth: number; printed: string; sense: number | null }[];
  /** Whether Apply writes it into the text; absent leaves it as it was. */
  applied?: boolean;
}

export interface GuideReviewSave {
  projectDir: string;
  at: string;
  version: string;
  forms: GuideReviewFormEdit[];
}

/**
 * WHAT THE CLEANUP MODAL WAS TOLD TO DO ABOUT THE GUIDE (Owen, 2026-11-01: *"make
 * sure the user knows the pronunciation guide has to be processed before cleaning.
 * maybe we even put 'generate pronunciation guide' in the cleanup modal"*). The ids
 * travel on the cleanup's request as `hostChoice` — Foundry carries them and reads
 * none of them. A request with no `hostChoice` (the CLI, an older Foundry) is
 * cleaned as before: the guide is built inside the cleanup when the step has none.
 */
export const GUIDE_CHOICE = {
  /** Read the step's guide as it stands. */
  use: 'guide-use',
  /** Queue the guide as its own row ahead of the cleanup. */
  build: 'guide-build',
  /** The same, starting over: every decision dropped, a person's included. */
  rebuild: 'guide-rebuild',
  /** No guide: the cleanup decides every form in its own sentence. */
  none: 'guide-none',
} as const;
export type GuideChoice = typeof GUIDE_CHOICE[keyof typeof GUIDE_CHOICE];

/**
 * THE NAME A GUIDE'S APPLY LANDS AS — Foundry's readings-only pass takes it as the
 * step's label AND its identity (`LedgerParams.readings`), so a second Apply from the
 * same step replaces the first rather than stacking a sibling.
 */
export const APPLIED_LABEL = 'Pronunciation applied';

/** The meaning a spot is put in when a person leaves just that spot to the narrator. */
export const LEFT_TO_NARRATOR_MEANING = 'As printed — left to the narrator';
