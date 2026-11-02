/**
 * ASK'S PRESETS — questions kept in the Presets modal, each with a checkbox;
 * Send runs the checked ones one after another, in list order (Owen,
 * 2026-11-02).
 *
 * The presets are the APP's, not a book's: the same jobs are asked of every
 * book, so they live in `app-settings.json` (`askPresets`, and which were
 * checked last in `askPresetsChecked`), where a person's own presets and
 * edits are kept too. Absent there means "never changed", which is the shipped
 * defaults below.
 *
 * ── WHY THE QUESTIONS NAME THE TOOLS ────────────────────────────────────────
 *
 * Each built-in is written as a full instruction that says which tools to use,
 * because a one-line "fix the chapters" leaves the model to rediscover what the
 * toolbox can do on every book, and it is the TOOLS that make the result
 * reviewable — a chapter heading fixed by `recategorize` lands as a retyping
 * the person can keep or undo, not as words the model describes.
 *
 * ── WHY THE DEFAULTS ARE ORDERED THIS WAY ───────────────────────────────────
 *
 * The list's order is the run order. Chapters first: it finds each chapter by
 * the table of contents, and Front & back matter is the step that removes the
 * table of contents. Each step is its own run on the book's thread, so each
 * later step starts from the earlier ones' note, and from the book with their
 * changes pending on it — a landing is on the pane's stack before the next
 * step reads the view (`AskChain`).
 */

/** One preset. `id` is stable across renames; the built-ins' ids are fixed. */
export interface AskPreset {
  readonly id: string;
  readonly label: string;
  /** One line, under the name in the modal. May be empty. */
  readonly description: string;
  readonly question: string;
}

/** Ceilings, so "a few buttons" stays that. */
export const ASK_PRESET_MAX = 30;
export const ASK_PRESET_LABEL_MAX = 40;
export const ASK_PRESET_DESCRIPTION_MAX = 140;
export const ASK_PRESET_QUESTION_MAX = 4000;

export const DEFAULT_ASK_PRESETS: readonly AskPreset[] = [
  {
    id: 'builtin:chapters',
    label: 'Correct chapters',
    description: 'Every chapter in the contents starts at a Title with its proper name; false chapter starts go.',
    question: 'Correct this book\'s chapters. First find the table of contents (outline, then read the front of the book). '
      + 'For each chapter it lists, find where that chapter begins in the body (search for its title or number). '
      + 'Each chapter\'s heading must be a Title with a chapter starting at it: use recategorize with category "Title" and '
      + 'starts_chapter:true to retype it; if the heading is glued to the paragraph after it, use split at the first words of '
      + 'the paragraph with first_category "Title", then make the heading start the chapter; if the chapter\'s title is only a '
      + 'number or is wrong, use rename_chapter to give it the title the contents list. Use recategorize with '
      + 'starts_chapter:false to take away chapter starts that are not real chapters. Do NOT mark the table of contents itself '
      + 'for removal; that is a separate step. In your summary, list any chapter from the contents you could not find in the body.',
  },
  {
    id: 'builtin:matter',
    label: 'Front & back matter',
    description: 'Mark the contents, copyright, index, bibliography, ads and the like; point at anything unsure.',
    question: 'Mark for removal everything in the front and back of this book that should not be read aloud in an audiobook: '
      + 'the table of contents, the copyright page, the index, the bibliography, acknowledgements, advertisements, "also by '
      + 'this author" lists, and similar apparatus. Use mark (dry_run first when you use a pattern or a span). Keep the '
      + 'title, a dedication, an epigraph, a foreword, a preface, an introduction and an afterword: those are read. For '
      + 'anything you are unsure of, use highlight with a short note instead of marking it, and say so in your summary.',
  },
  {
    id: 'builtin:pictures',
    label: 'Pictures, captions & web addresses',
    description: 'Strike pictures and captions, rejoin the prose they split, and take web addresses out.',
    question: 'Remove what a listener cannot see. Mark pictures and their captions for removal (search category_is '
      + '"Picture" and "Caption", dry_run first). Where a picture or caption split a sentence or a paragraph in two, join '
      + 'the block after it onto the block before it (join, dry_run first to check the seam reads as one sentence). Mark '
      + 'blocks that are only a web address for removal. Where a web address sits inside a sentence, use revise to take it '
      + 'out and keep the words around it grammatical (for example "(Associated Newspapers Limited, www.dailymail.co.uk)" '
      + 'becomes "(Associated Newspapers Limited)").',
  },
  {
    id: 'builtin:footnotes',
    label: 'Footnotes',
    description: 'Link notes to their numbers, point at stray numbers, and retype blocks misread as notes.',
    question: 'Put this book\'s footnotes right. read only:"unlinked" shows notes nothing points at and numbers no note '
      + 'carries. Where a note and a number truly belong together (the same number, the note close after the place the '
      + 'number is printed), use link_footnote to bind them. Use highlight for stray numbers that are not real references, '
      + 'with a note saying what they are. Use recategorize for blocks wrongly read as footnotes (a chapter number, a '
      + 'heading, a page number): give them the kind they really are.',
  },
];

/** Checked when nothing has been kept yet: every default. */
export const DEFAULT_CHECKED: readonly string[] = DEFAULT_ASK_PRESETS.map((one) => one.id);

/** The presets Send runs: the checked ones, in the list's order, which is the run order. */
export function checkedSteps(presets: readonly AskPreset[], checked: ReadonlySet<string>): AskPreset[] {
  return presets.filter((one) => checked.has(one.id));
}

/** Which were checked last, as stored: ids, each once; null is never kept. */
export function clampCheckedPresets(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 80))]
    .slice(0, ASK_PRESET_MAX);
}

/**
 * The buttons as stored, made legal: null (never changed) is the defaults;
 * each entry needs a label and a question, trimmed to the ceilings; an id
 * seen twice keeps the first.
 */
export function clampAskPresets(value: unknown): AskPreset[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: AskPreset[] = [];
  for (const raw of value) {
    if (out.length >= ASK_PRESET_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry['id'] === 'string' ? entry['id'].trim().slice(0, 80) : '';
    const label = typeof entry['label'] === 'string' ? entry['label'].replace(/\s+/g, ' ').trim().slice(0, ASK_PRESET_LABEL_MAX) : '';
    // Kept before descriptions existed reads as none.
    const description = typeof entry['description'] === 'string'
      ? entry['description'].replace(/\s+/g, ' ').trim().slice(0, ASK_PRESET_DESCRIPTION_MAX) : '';
    const question = typeof entry['question'] === 'string' ? entry['question'].trim().slice(0, ASK_PRESET_QUESTION_MAX) : '';
    if (id.length === 0 || label.length === 0 || question.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, description, question });
  }
  return out;
}

/** What the settings hold for the modal: the list (null: defaults) and which were checked last (null: the defaults). */
export interface AskPresetsKept {
  readonly presets: AskPreset[] | null;
  readonly checked: string[] | null;
}

/** The buttons to draw: what is kept, or the defaults when nothing is. */
export function askPresetsOrDefaults(kept: readonly AskPreset[] | null): readonly AskPreset[] {
  return kept ?? DEFAULT_ASK_PRESETS;
}

// ─────────────────────────────────────────────────────────────────────────────
// The checked presets, as a sequence
// ─────────────────────────────────────────────────────────────────────────────

/** Which step of a chain of presets a run is, kept on its session so review can label its groups. */
export interface AskChainStep {
  /** The chain's id, shared by its steps. */
  readonly chain: string;
  /** The step's name — the button's label. */
  readonly step: string;
  /** 1-based. */
  readonly index: number;
  readonly of: number;
}

/** How one step ended, as the chain is told. */
export type AskStepEnd =
  | { readonly state: 'done' }
  | { readonly state: 'failed' | 'cancelled'; readonly message: string };

/**
 * THE PRESETS' SEQUENCE — pure, so the order, the stop on a failure and the stop
 * on a cancel are proved without a window.
 *
 * The owner (AskService) starts a step with `begin`, and tells the chain how it
 * ENDED once its marks have landed on the pane (`ended`) — not when main says
 * the model finished — which is what makes the next step read a book with the
 * earlier steps' changes pending on it. `ended` answers the next step to begin,
 * or null with the sentence the chain closes on.
 */
export class AskChain {
  private at = 0;
  private stopped: string | null = null;

  constructor(readonly id: string, readonly steps: readonly AskPreset[]) {
    if (steps.length === 0) throw new Error('Send runs at least one preset.');
  }

  /** The step to run now, with its place in the chain. */
  current(): { preset: AskPreset; step: AskChainStep } | null {
    if (this.stopped !== null || this.at >= this.steps.length) return null;
    const preset = this.steps[this.at]!;
    return { preset, step: { chain: this.id, step: preset.label, index: this.at + 1, of: this.steps.length } };
  }

  /** "Presets: step 2 of 3 — Front & back matter", or null once it is over. */
  said(): string | null {
    const now = this.current();
    return now === null ? null : `Presets: step ${now.step.index} of ${now.step.of} — ${now.step.step}`;
  }

  /** The person pressed Stop: no step after this one starts. */
  cancel(): void {
    if (this.stopped === null) this.stopped = 'cancelled';
  }

  /** A step ended. The next one to start, or the sentence the chain ends on. */
  ended(end: AskStepEnd): { next: { preset: AskPreset; step: AskChainStep } } | { over: string } {
    if (this.stopped === 'failed' || this.at >= this.steps.length) return { over: 'The presets had already stopped.' };
    // Read past a cancel: the step that was running when Stop was pressed is still the one ending.
    const now = { step: { index: this.at + 1, of: this.steps.length, step: this.steps[this.at]!.label } };
    const name = `step ${now.step.index} of ${now.step.of} (${now.step.step})`;
    if (end.state === 'failed') {
      this.stopped = 'failed';
      return { over: `The presets stopped at ${name}, which failed: ${end.message} The steps before it stay on the book.` };
    }
    if (end.state === 'cancelled' || this.stopped === 'cancelled') {
      this.stopped = 'cancelled';
      return { over: `The presets were stopped at ${name}; ${this.steps.length - now.step.index} later ${this.steps.length - now.step.index === 1 ? 'step was' : 'steps were'} not run. The steps that finished stay on the book.` };
    }
    this.at += 1;
    const next = this.current();
    return next === null ? { over: `All ${this.steps.length} presets ran.` } : { next };
  }
}
