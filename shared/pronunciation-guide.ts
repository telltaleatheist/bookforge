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
}

export interface GuideReview {
  projectDir: string;
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
}

/** One form as the person left it. Its spots name their meaning by index into `senses`. */
export interface GuideReviewFormEdit {
  key: string;
  kind: GuideReviewForm['kind'];
  decision: GuideReviewForm['decision'];
  senses: GuideReviewSense[];
  spots: { at: string; nth: number; printed: string; sense: number | null }[];
}

export interface GuideReviewSave {
  projectDir: string;
  version: string;
  forms: GuideReviewFormEdit[];
}

/** The meaning a spot is put in when a person leaves just that spot to the narrator. */
export const LEFT_TO_NARRATOR_MEANING = 'As printed — left to the narrator';
