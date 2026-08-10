/**
 * pass-diff — reading a pass RECEIPT, which is a finished record, not a comparison.
 *
 * Owen, 2026-08-10, live: "the review changes button just takes me to a
 * perpetually loading screen instead of actually showing me what changed in the
 * text."
 *
 * ── Why it hung ─────────────────────────────────────────────────────────────
 *
 * A pass receipt (`stages/NN-<kind>/diff.json`, frozen to
 * `source/ledger/NN-<kind>-<id>/receipt.json`) is SELF-CONTAINED: each unit
 * carries its before-text, its after-text, AND the compact change list the pass
 * actually produced. The viewer nevertheless threw the two texts at the renderer's
 * LCS diff worker and re-derived a comparison that was already sitting in the file.
 *
 * That worker's word-level LCS is O(before x after) in both time and memory, and
 * a receipt's unit is the WHOLE BOOK — passes operate on the book, not on
 * chapters. Measured against Owen's own library
 * (Working_Towards_The_Fuhrer/source/ledger/01-footnote-refs-61e20ac5/receipt.json,
 * one unit, 56,685 vs 56,394 chars = 8,815 x 8,712 tokens): 76.8 million table
 * cells, 24.7 seconds and 628 MB of heap in bare Node with nothing else running.
 * That is a forty-page essay. A four-hundred-page book is ~15x the text, so ~200x
 * the cells — hours, or an out-of-memory worker that never answers at all. The
 * spinner is the honest report of that: the viewer really was still computing.
 *
 * ── What replaces it ────────────────────────────────────────────────────────
 *
 * Nothing is computed. The receipt's own `changes` are expanded over the
 * receipt's own after-text — linear in the number of edits — so Review changes
 * shows exactly what the pass RECORDED at the moment it ran, which is what a
 * receipt is for. Re-deriving it could only ever disagree with the record.
 *
 * ── Three answers, never a fourth ───────────────────────────────────────────
 *
 * `readPassDiff` is total: every receipt on disk maps to exactly one of
 *
 *   - `changed`     — real edits, render them;
 *   - `empty`       — a valid receipt that recorded no edits (the pre-fix
 *                     footnote vintage, whose diff was computed through a text
 *                     extractor that stripped the very markers the pass removed,
 *                     leaves a book diffed against itself). This is a DISPLAY,
 *                     not an error, and never a hang;
 *   - `unreadable`  — the file is not a receipt, or contradicts itself. Said out
 *                     loud with the reason, never smoothed into "no changes".
 *
 * The last two are deliberately distinct: "this pass changed nothing" and "this
 * receipt cannot be trusted" are different facts about the book and the user is
 * owed whichever one is true.
 *
 * Pure, so `tools/test-pass-diff.js` can hold both vintages against it without a
 * project, and so the renderer and the main process cannot answer differently.
 */

/** One compact edit, exactly as a receipt records it. Offsets index the AFTER text. */
export interface PassDiffChange {
  /** Character offset into the after-text where the edit begins. */
  pos: number;
  /** Length of the added run in the after-text (0 for a pure deletion). */
  len: number;
  /** Text this edit added, if any. */
  add?: string;
  /** Text this edit removed, if any. */
  rem?: string;
  /**
   * Set when a FOOTNOTE REFERENCE MARKER removal produced this edit, and where the
   * proof came from. Carried through hydration so Review changes can label it even
   * when the marker shared a span with a quote edit.
   */
  fn?: 'archive' | 'inferred';
}

/** A run of text in the rendered diff. */
export interface PassDiffWord {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
  fn?: 'archive' | 'inferred';
}

/** One unit of a receipt, validated. A pass's unit is usually the whole book. */
export interface PassDiffUnit {
  id: string;
  title: string;
  /** Before-text, verbatim from the receipt. */
  originalText: string;
  /** After-text, verbatim from the receipt. Every change offset indexes THIS. */
  cleanedText: string;
  changes: PassDiffChange[];
  /**
   * Derived from `changes.length`, not read from the file: the edit list is the
   * record, and a stored count that disagreed with it would be the thing to
   * distrust.
   */
  changeCount: number;
}

/** What a receipt turned out to be. Exactly one of three. */
export type PassDiffReadout =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'changed'; units: PassDiffUnit[] };

/**
 * Expand a receipt's compact changes over its after-text.
 *
 * Linear in the number of edits. This is the ONE implementation — the main
 * process's `hydrateDiff` in electron/diff-cache.ts is this function under its
 * old name, so the pre-computed cleanup cache and a pass receipt can never
 * render the same edit list two different ways.
 */
export function hydratePassDiff(changes: PassDiffChange[], cleanedText: string): PassDiffWord[] {
  if (changes.length === 0) {
    // No changes — the after-text stands as one unchanged run.
    return cleanedText ? [{ text: cleanedText, type: 'unchanged' }] : [];
  }

  const result: PassDiffWord[] = [];
  let lastPos = 0;

  const sortedChanges = [...changes].sort((a, b) => a.pos - b.pos);

  for (const change of sortedChanges) {
    if (change.pos > lastPos) {
      const unchangedText = cleanedText.slice(lastPos, change.pos);
      if (unchangedText) {
        result.push({ text: unchangedText, type: 'unchanged' });
      }
    }

    if (change.rem) {
      result.push({ text: change.rem, type: 'removed', fn: change.fn });
    }

    if (change.add) {
      result.push({ text: change.add, type: 'added', fn: change.fn });
    }

    lastPos = change.pos + change.len;
  }

  if (lastPos < cleanedText.length) {
    result.push({ text: cleanedText.slice(lastPos), type: 'unchanged' });
  }

  return result;
}

/**
 * The last two path segments of a receipt, which is what identifies it to a
 * human: `01-footnote-refs-61e20ac5/receipt.json`. Full paths in an inline error
 * push the reason off the end of the line.
 */
export function passDiffLabel(diffPath: string): string {
  const parts = diffPath.replace(/\\/g, '/').split('/').filter(p => p.length > 0);
  return parts.slice(-2).join('/') || diffPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a receipt as it came off disk into one of the three answers.
 *
 * Every rejection names the file and what is wrong with it, because the caller's
 * only other option is to show a blank screen and let the user guess.
 */
export function readPassDiff(raw: unknown, diffPath: string): PassDiffReadout {
  const label = passDiffLabel(diffPath);

  if (!isRecord(raw)) {
    return { kind: 'unreadable', reason: `${label} is not a diff receipt — it holds ${
      raw === null ? 'null' : Array.isArray(raw) ? 'a list' : typeof raw
    } where an object was recorded.` };
  }

  if (raw['version'] !== 1) {
    return { kind: 'unreadable', reason: `${label} records version ${
      JSON.stringify(raw['version'])
    }; only version 1 receipts can be read.` };
  }

  const rawChapters = raw['chapters'];
  if (!Array.isArray(rawChapters)) {
    return { kind: 'unreadable', reason: `${label} has no list of text units, so there is nothing in it to show.` };
  }

  if (rawChapters.length === 0) {
    return {
      kind: 'empty',
      reason: 'This pass recorded no changes to the text — its receipt covers no text units at all.',
    };
  }

  const units: PassDiffUnit[] = [];

  for (let i = 0; i < rawChapters.length; i++) {
    const rawUnit: unknown = rawChapters[i];
    const where = `unit ${i + 1} of ${rawChapters.length} in ${label}`;

    if (!isRecord(rawUnit)) {
      return { kind: 'unreadable', reason: `${where} is not a text unit.` };
    }

    const id = rawUnit['id'];
    if (typeof id !== 'string' || id.length === 0) {
      return { kind: 'unreadable', reason: `${where} has no id, so its text cannot be addressed.` };
    }

    const title = rawUnit['title'];
    if (typeof title !== 'string') {
      return { kind: 'unreadable', reason: `${where} ("${id}") has no title.` };
    }

    // Both texts, or nothing. A pass rewrites the book in place, so by the time a
    // receipt is opened the text it describes is gone from disk; a receipt that
    // did not keep both sides is unreadable rather than half-shown.
    const cleanedText = rawUnit['text'];
    const originalText = rawUnit['originalText'];
    if (typeof originalText !== 'string' || typeof cleanedText !== 'string') {
      return {
        kind: 'unreadable',
        reason: `${where} ("${id}") kept ${
          typeof originalText === 'string' ? 'no after-text'
            : typeof cleanedText === 'string' ? 'no before-text'
            : 'neither its before- nor its after-text'
        }. The book it described has been rewritten since, so there is nothing left to compare it with.`,
      };
    }

    const rawChanges = rawUnit['changes'];
    if (!Array.isArray(rawChanges)) {
      return { kind: 'unreadable', reason: `${where} ("${id}") has no list of edits.` };
    }

    const changes: PassDiffChange[] = [];
    for (let c = 0; c < rawChanges.length; c++) {
      const rawChange: unknown = rawChanges[c];
      if (!isRecord(rawChange)) {
        return { kind: 'unreadable', reason: `edit ${c + 1} of ${where} ("${id}") is not an edit.` };
      }
      const pos = rawChange['pos'];
      const len = rawChange['len'];
      if (typeof pos !== 'number' || !Number.isFinite(pos) || pos < 0 ||
          typeof len !== 'number' || !Number.isFinite(len) || len < 0) {
        return {
          kind: 'unreadable',
          reason: `edit ${c + 1} of ${where} ("${id}") records position ${
            JSON.stringify(pos)} / length ${JSON.stringify(len)}, which is not a place in the text.`,
        };
      }
      const add = rawChange['add'];
      const rem = rawChange['rem'];
      if (add !== undefined && typeof add !== 'string') {
        return { kind: 'unreadable', reason: `edit ${c + 1} of ${where} ("${id}") records added text that is not text.` };
      }
      if (rem !== undefined && typeof rem !== 'string') {
        return { kind: 'unreadable', reason: `edit ${c + 1} of ${where} ("${id}") records removed text that is not text.` };
      }
      // The offsets index THIS receipt's own after-text, which is in the same
      // file — so unlike the cleanup cache (whose EPUB drifts underneath it)
      // there is no legitimate way for them to disagree. When they do, the file
      // is corrupt, and re-deriving a diff to paper over it would show the user
      // something the pass never did.
      if (typeof add === 'string' && cleanedText.slice(pos, pos + len) !== add) {
        return {
          kind: 'unreadable',
          reason: `${where} ("${id}") contradicts itself: edit ${c + 1} says the text at ${pos} is ${
            JSON.stringify(add.slice(0, 40))}, but the receipt's own text there is ${
            JSON.stringify(cleanedText.slice(pos, pos + Math.max(len, 40)).slice(0, 40))}.`,
        };
      }
      const fn = rawChange['fn'];
      if (fn !== undefined && fn !== 'archive' && fn !== 'inferred') {
        return { kind: 'unreadable', reason: `edit ${c + 1} of ${where} ("${id}") records an unknown footnote proof ${JSON.stringify(fn)}.` };
      }
      changes.push({
        pos,
        len,
        ...(add === undefined ? {} : { add }),
        ...(rem === undefined ? {} : { rem }),
        ...(fn === undefined ? {} : { fn }),
      });
    }

    units.push({ id, title, originalText, cleanedText, changes, changeCount: changes.length });
  }

  const total = units.reduce((n, u) => n + u.changeCount, 0);
  if (total === 0) {
    return {
      kind: 'empty',
      reason: `This pass recorded no changes to the text. Its receipt covers ${
        units.length === 1 ? '1 text unit' : `${units.length} text units`
      } and lists no edits in any of them.`,
    };
  }

  return { kind: 'changed', units };
}
