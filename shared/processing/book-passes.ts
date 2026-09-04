/**
 * book-passes — the things you can have done to a book, as one list.
 *
 * ── Where they are offered, and why there is only one place ─────────────────
 *
 * Owen, 2026-08-09: "the translate/simplify/footnotes options are available from
 * a modal that appears if the user hits process on the archive files." The verbs
 * used to be scattered — a Simplify in the picker's left rail, a Translate in the
 * wizard, a footnote button somewhere else — and each one had to re-answer which
 * file it applied to. They apply to the BOOK, so they are offered from the book's
 * own line on the versions page and from nowhere else.
 *
 * ── Data, not a switch ──────────────────────────────────────────────────────
 *
 * The modal renders this list. A pass added to the pipeline appears in it by
 * being added HERE, and the UI needs no change at all — which is the only way a
 * list like this survives a second author adding a pass to the other end of it.
 *
 * ── Everything here is QUEUED ───────────────────────────────────────────────
 *
 * Owen, same session: "whatever the user chooses to do (particularly
 * translate/simplify/tts/assemble) will be added to the queue… follow the vlm
 * epub generation pattern." Every one of these is an hour or more of model time
 * over a whole book, and a run that is not a queue row is a run with no way to
 * watch it, cancel it, or find out why it stopped. So the modal's only act is to
 * submit through `processing:submit-chain`; nothing here runs inline.
 */

/** One pass, as the modal shows it. */
export interface BookPassOption {
  /**
   * The pass kind, spelled as `ProcessingPassKind`
   * (shared/processing/pass-types.ts) spells it.
   *
   * A plain string rather than that type on purpose: this list is the offer, and
   * the planner is the authority on what can actually be run. A kind this build
   * cannot plan is refused BY NAME by `processing:submit-chain`, and that
   * refusal is shown to the user verbatim — which is the honest failure for a
   * list and a planner that have drifted apart, and is exactly what a union type
   * here would turn into a compile error in one build and a silent omission in
   * the other.
   */
  readonly kind: string;
  /** What the modal calls it. */
  readonly label: string;
  /** One sentence: what it does to the book. */
  readonly note: string;
  /**
   * Whether choosing it opens the options dialog before queueing.
   *
   * False means the pass takes no choices from the user and goes straight to the
   * queue. True means it cannot be started from a button alone — a simplify with
   * no mode, or a translate with no languages, is a run nobody specified.
   */
  readonly needsOptions: boolean;
}

/**
 * The passes offered on the book's line, in the order they are shown.
 *
 * Ordered cheapest-and-most-mechanical first: removing footnote references is a
 * structural edit over markup, and the two AI rewrites below it are hours of
 * model time over every paragraph.
 */
export const BOOK_PASS_OPTIONS: readonly BookPassOption[] = [
  {
    // Added in 745bdec2, wired through the same `runProcessingPass`/queue
    // machinery as the two below. Instant and deterministic — no model, no GPU —
    // which is why it is first: the cheap mechanical edit you want done before a
    // model ever reads the text.
    kind: 'footnote-refs',
    label: 'Remove footnote references',
    note: 'Takes the superscript reference markers out of the text, leaving the notes themselves '
      + 'alone.',
    needsOptions: false,
  },
  {
    // The step that stands between a finished book and a render. Owen,
    // 2026-09-04: "a step that can be performed at any point, including on an
    // epub, but it's a computationally expensive step that needs to take place
    // somewhere along the line, and everything after it is finalized/fixed."
    // Offered here like any other pass; what makes it different is that
    // `prepareNarrationInput` REFUSES a book that has not had it, and that a
    // later simplify or translate makes its stamp stale.
    kind: 'narration-text',
    label: 'Narration text cleanup',
    note: 'Canonicalizes the punctuation and reads every number as the words a narrator says. '
      + 'Required before narration; minutes of model time over the passages that print digits.',
    needsOptions: false,
  },
  {
    kind: 'simplify',
    label: 'Simplify',
    note: 'Rewrites the book in plainer language. Hours of model time over every paragraph.',
    needsOptions: true,
  },
  {
    kind: 'translate',
    label: 'Translate',
    note: 'Rewrites the book in another language. Hours of model time over every paragraph.',
    needsOptions: true,
  },
];
