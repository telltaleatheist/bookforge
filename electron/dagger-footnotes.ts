/**
 * dagger-footnotes — footnote reference markers, found by the `dagger` model and
 * removed by a deterministic applier.
 *
 * Scanned books carry the publisher's superscript reference markers welded into
 * the prose by OCR, and they are almost never digits by the time they reach us:
 * the corpus this model trained on removes `*`, `”`, `’`, `°`, `?`, `!`, `>`,
 * `®`, `§` and stray letters far more often than it removes a number. That is
 * why the shape-based inference this replaces could only ever see part of the
 * problem — it was built to recognise a numeric chain.
 *
 * THE CONTRACT, and the reason a 0.6B model is enough:
 *
 *   dagger never rewrites prose. It emits a DELETION LIST — one
 *   `<anchor+marker> → <anchor>` line per marker, or the single word `none` —
 *   and the applier below does the editing. Every line is checked twice before
 *   anything is spliced (see `applyDaggerDeletions`), so the worst a wrong
 *   answer can do is fail to remove a marker. It cannot alter the book.
 *
 * The prompt has to arrive VERBATIM, in the Qwen3 template with thinking
 * disabled — the empty `<think>\n\n</think>` block a stock template omits. That
 * template lives in rubric-encoder.ts and is imported, not re-typed: a
 * near-miss here would read as a bad model rather than a bad wire hop, which is
 * the single hardest failure in this area to diagnose.
 *
 * Reference implementation + the scoring harness that measured this applier:
 * `tools/dagger-score.js`. Held-out numbers at the time of writing: 94.7% of
 * blocks end byte-identical to gold, 1.1% of clean blocks edited anyway.
 */
import { daggerServer } from './dagger-server';
// The chat template both fine-tunes were trained under. See tsconfig.electron.json
// for why a renderer file is in the main-process program.
import { toRawPrompt, RUBRIC_STOP } from '../src/app/features/pdf-picker/services/rubric-encoder';

/**
 * The training system prompt, byte for byte. Changing a word here changes the
 * task the model believes it was given; if the prompt ever has to change, the
 * model has to be retrained and its id's version bumped.
 */
export const DAGGER_SYSTEM_PROMPT =
  'Find inline footnote reference markers. Output one line per marker: the marker with '
  + "its left anchor, then ' → ', then the anchor without it. Output 'none' if there are none.";

/** One edit dagger proposed. Neither field is trusted until the applier checks it. */
export interface DaggerDeletion {
  /** The anchor WITH the marker still on it, as dagger copied it from the text. */
  before: string;
  /** The same anchor with the marker's characters gone — and nothing else changed. */
  after: string;
}

/**
 * A chapter's plan, keyed by the EXACT prose-segment text it was derived from.
 *
 * Keyed rather than positional because the consumer (`ttsPrepChapter`) is a pure
 * function whose transform closure runs several times over the same segments for
 * chunk layout. A map keyed by the segment text is order-independent and
 * idempotent, which is what that design needs.
 */
export type DaggerChapterPlan = Map<string, DaggerDeletion[]>;

/** The model's `→`, plus the ASCII form in case a decode mangles the arrow. */
const ARROW = /\s*(?:→|->)\s*/;

/**
 * Parse one answer into deletions. Unparseable lines are DROPPED, never guessed
 * at: a half-read line would become a splice into somebody's book.
 */
export function parseDaggerAnswer(text: string): DaggerDeletion[] {
  const raw = (text ?? '').trim();
  if (!raw || /^none$/i.test(raw)) return [];
  const out: DaggerDeletion[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^none$/i.test(trimmed)) continue;
    const parts = trimmed.split(ARROW);
    if (parts.length !== 2 || !parts[0]) continue;
    out.push({ before: parts[0], after: parts[1] });
  }
  return out;
}

/**
 * Is `after` reachable from `before` by DELETING characters only? Two pointers,
 * so it is a subsequence test.
 *
 * This is the guard dagger found the hole in on its first held-out run: it
 * emitted `aspires.<marker> → aspirations.` — an anchor that really does occur
 * in the source, paired with a replacement that is not the anchor minus a marker
 * but a DIFFERENT WORD. An applier that only checks "does `before` occur"
 * accepts that and rewrites the prose. Requiring `after` to be a subsequence of
 * `before` restores the property the whole 0.6B design rests on: the model can
 * fail to remove a marker, but it cannot alter the text.
 */
export function isDeletionOnly(before: string, after: string): boolean {
  let i = 0;
  for (const ch of after) {
    i = before.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

/** The characters `before` loses on its way to `after` — i.e. the marker itself. */
function deletedChars(before: string, after: string): string {
  const parts: string[] = [];
  let i = 0;
  for (const ch of after) {
    const j = before.indexOf(ch, i);
    if (j < 0) break;   // unreachable — isDeletionOnly has already passed
    parts.push(before.slice(i, j));
    i = j + 1;
  }
  parts.push(before.slice(i));
  return parts.join('');
}

export interface DaggerApplyResult {
  text: string;
  /** The marker text actually removed, one entry per applied edit, in order. */
  removed: string[];
  /** Edits the guards refused. Harmless to the text — that is the point. */
  rejected: number;
}

/**
 * Apply a deletion list to one piece of text. THIS IS THE SAFETY BOUNDARY.
 *
 * Three checks, all of them load-bearing:
 *   1. `after` must be non-empty. The anchor minus its marker is never nothing,
 *      so an empty replacement is a malformed line, not an instruction to delete
 *      a whole phrase. (No gold example in the corpus has one.)
 *   2. `after` must be `before` with characters DELETED ONLY — see isDeletionOnly.
 *   3. `before` must occur VERBATIM in the text. A model that paraphrased its
 *      own anchor gets no edit rather than an edit somewhere approximate.
 *
 * Edits land on the FIRST remaining occurrence, applied in document order, which
 * is what makes a repeated anchor work: once the first `wrote.*` has become
 * `wrote.`, the next identical deletion naturally finds the second one.
 */
export function applyDaggerDeletions(
  src: string,
  deletions: readonly DaggerDeletion[],
): DaggerApplyResult {
  let text = src;
  const removed: string[] = [];
  let rejected = 0;
  for (const { before, after } of deletions) {
    if (!after || !isDeletionOnly(before, after)) { rejected++; continue; }
    const at = text.indexOf(before);
    if (at < 0) { rejected++; continue; }
    text = text.slice(0, at) + after + text.slice(at + before.length);
    removed.push(deletedChars(before, after));
  }
  return { text, removed, rejected };
}

/**
 * The longest user turn in the training corpus is 1661 characters; the median is
 * 349. A book paragraph IS the unit dagger saw — the corpus was built from OCR
 * blocks — so the split below is paragraph-first and only wraps the rare
 * paragraph that runs past the ceiling.
 */
const MAX_UNIT_CHARS = 1600;

/**
 * Cut one prose segment into the units dagger is asked about.
 *
 * Over-long paragraphs are wrapped at WHITESPACE, never mid-token, because a
 * marker is usually glued straight onto its anchor (`Germany.*`) and a split
 * inside that pair would hand the model an orphan. The corpus does contain a
 * minority of ` *` markers where a space intervenes, so a wrap landing on
 * exactly that space loses the marker — a silent miss, which is the safe
 * direction, and only reachable on paragraphs past 1600 characters.
 */
export function splitForDagger(segmentText: string): string[] {
  const units: string[] = [];
  for (const para of segmentText.split(/\n\s*\n/)) {
    let rest = para.trim();
    if (!rest) continue;
    while (rest.length > MAX_UNIT_CHARS) {
      let cut = rest.lastIndexOf(' ', MAX_UNIT_CHARS);
      const nl = rest.lastIndexOf('\n', MAX_UNIT_CHARS);
      if (nl > cut) cut = nl;
      // A 1600-character run with no whitespace is not prose; cut it anyway so
      // the loop always makes progress.
      if (cut <= 0) cut = MAX_UNIT_CHARS;
      const head = rest.slice(0, cut).trim();
      if (head) units.push(head);
      rest = rest.slice(cut).trim();
    }
    if (rest) units.push(rest);
  }
  return units;
}

export interface DaggerPlanOptions {
  /** Reported after each batch so a book-length pass is not a frozen bar. */
  onProgress?: (done: number, total: number) => void;
  /** Checked between batches; an aborted job throws rather than finishing. */
  signal?: AbortSignal;
}

/**
 * How many units go to the server per round-trip. `daggerServer.generate` runs
 * them sequentially (`-np 1`), so this is purely the progress/cancellation
 * granularity, not a concurrency knob.
 */
const BATCH = 16;

/**
 * Ask dagger where the markers are in a chapter's prose segments.
 *
 * NO FALLBACK: a missing model, a dead server or an HTTP error throws. The
 * alternative would be a book that quietly keeps its markers and narrates
 * "the treaty three was signed", which is indistinguishable from success until
 * somebody listens to it.
 */
export async function planChapterFootnotes(
  segments: readonly string[],
  modelId: string,
  opts: DaggerPlanOptions = {},
): Promise<DaggerChapterPlan> {
  const plan: DaggerChapterPlan = new Map();

  // The segment layout first, then the unique units. A chapter repeats short
  // paragraphs more often than you would think and every duplicate is a
  // round-trip; the answer for identical text is identical anyway (temperature 0).
  const layout: Array<{ segment: string; units: string[] }> = [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    // Two identical prose segments share one entry — filling the same key twice
    // would double every deletion in it.
    if (plan.has(segment)) continue;
    plan.set(segment, []);
    const units = splitForDagger(segment);
    layout.push({ segment, units });
    for (const unit of units) {
      if (seen.has(unit)) continue;
      seen.add(unit);
      unique.push(unit);
    }
  }
  if (unique.length === 0) return new Map();

  const answers = new Map<string, DaggerDeletion[]>();
  for (let i = 0; i < unique.length; i += BATCH) {
    if (opts.signal?.aborted) throw new Error('Job cancelled');
    const slice = unique.slice(i, i + BATCH);
    const result = await daggerServer.generate(
      modelId,
      slice.map((unit) => toRawPrompt({ system: DAGGER_SYSTEM_PROMPT, user: unit })),
      RUBRIC_STOP,
    );
    if (!result.success || !result.answers) {
      throw new Error(`The footnote-marker model failed: ${result.error || 'no answer'}`);
    }
    slice.forEach((unit, k) => {
      answers.set(unit, parseDaggerAnswer(result.answers![k] ?? ''));
    });
    opts.onProgress?.(Math.min(i + BATCH, unique.length), unique.length);
  }

  // Re-walk in DOCUMENT ORDER. The applier edits the first remaining occurrence
  // of each anchor, so a list out of order would aim the second `wrote.*` at the
  // first one's position.
  for (const { segment, units } of layout) {
    const list = plan.get(segment)!;
    for (const unit of units) list.push(...(answers.get(unit) ?? []));
    if (list.length === 0) plan.delete(segment);
  }
  return plan;
}
