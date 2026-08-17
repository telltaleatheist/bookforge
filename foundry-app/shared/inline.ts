/**
 * shared/inline — the inline facts about a block's SOURCE STRING.
 *
 * ── This is a MIRROR of src/vlm/dots.ts and src/vlm/dots-book.ts, and the
 *    three must grow together ────────────────────────────────────────────────
 *
 * The engine owns the alphabet. `SUPERSCRIPT_RUN` is `dotsInline`'s own regular
 * expression (src/vlm/dots.ts) — the run of superscript DIGITS that a reference
 * number is printed as, and nothing wider, because `ⁿ` and `⁺` belong to
 * formulae and this dialect has a Formula category for those. `printedNoteNumber`
 * is `dots-book.ts`'s, and it is already a function on that side for the reason
 * that brings it here as well: two readings of "which number is this" that could
 * drift apart would be two answers to the question the whole marker match is.
 *
 * IT IS RESTATED FOR `shared/book.ts`'s REASON, entry for entry. The app never
 * imports a line of the engine — it spawns it (electron/engine.ts) — and spawning
 * a process to re-scan a string this process is already holding would be absurd.
 * So the alphabet is written twice with the engine's files named as the contract.
 *
 * ── Why the app needs it at all, which it did not until R3 ──────────────────
 *
 * Because a TEXT EDIT invalidates every `refs` offset into the block it changed.
 * The engine resolved those offsets once, at reflow, with the page in front of it
 * (`BookRef`, shared/book.ts) — and the moment somebody retypes a sentence, an
 * offset into it addresses whatever characters have taken that position. Shifting
 * them would be a guess about which side of an edit a marker fell on, so the
 * replay re-derives them instead (`replayOps`, shared/ops.ts): it re-scans the
 * edited block for superscript runs and rebinds them by printed number. That scan
 * has to find exactly what the engine would have found, or a book that is edited
 * and a book that is re-read would disagree about where its numbers are.
 *
 * If the engine's alphabet grows, BOTH sides grow.
 */

/**
 * Superscript DIGITS, and only digits — `SUPERSCRIPT_RUN`, src/vlm/dots.ts.
 *
 * NOT SHARED BETWEEN CALLS. It carries the `g` flag, so it carries `lastIndex`,
 * and a module-level regular expression handed to two `matchAll` loops is one
 * cursor two readers move. Every caller gets its own (`superscriptRuns` below is
 * the only one in this app, and it makes one per scan).
 */
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** A fresh matcher for the run. See `SUPERSCRIPT_DIGITS` for why it is a function. */
function superscriptRun(): RegExp {
  return /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g;
}

/** The value of a run of superscript digits — `printedNumber`, src/vlm/dots-book.ts. */
function printedNumber(run: string): number {
  return Number([...run].map((c) => String(SUPERSCRIPT_DIGITS.indexOf(c))).join(''));
}

/**
 * An ASCII note number at the head of the text — `ASCII_NOTE_LEAD`,
 * src/vlm/dots-book.ts. One to three digits then a space; three because no real
 * apparatus runs to a thousand and a four-digit lead is a year.
 */
const ASCII_NOTE_LEAD = /^(\d{1,3})[ \t]/;

/**
 * The number the BOOK printed on a note, read off the note's own first
 * characters — or null where it printed none.
 *
 * `printedNoteNumber` via `noteLeadOf`, src/vlm/dots-book.ts, verbatim — BOTH
 * spellings of the number, because the model sometimes answers a footnote area's
 * numbers as plain digits and the engine reads those as the same ink
 * (`noteLeadOf` owns the argument, with the measurements). A mirror that only
 * knew the superscript spelling would silently unbind an ASCII-numbered note's
 * markers the first time somebody retyped the paragraph they sit in.
 *
 * THE RUN HAS TO LEAD: a superscript in the middle of a note is a reference
 * inside the note's own prose, which is the same distinction `splitNotes` cuts a
 * footnote block on.
 */
export function printedNoteNumber(text: string): number | null {
  const lead = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+/.exec(text);
  if (lead !== null) return printedNumber(lead[0]);
  const ascii = ASCII_NOTE_LEAD.exec(text);
  return ascii === null ? null : Number.parseInt(ascii[1]!, 10);
}

/** One reference number found in a block's text: where it is, and what it says. */
export interface PrintedRun {
  /** Where in the block's text the run starts, in characters. */
  at: number;
  /** How many characters of it the run is. */
  len: number;
  /** The number the page printed. */
  printed: number;
}

/**
 * Every reference number in one block's text, in reading order.
 *
 * `markersIn`, src/vlm/book-file.ts, minus the page — this side has no `parts` to
 * ask, because a block whose text somebody has just retyped has no honest
 * character-exact division into banked answers any more, and inventing one is the
 * guess this whole re-derivation exists to avoid.
 *
 * A FOOTNOTE ROW IS NEVER SCANNED BY THE CALLER, and that rule is the engine's
 * too: a superscript inside a note is the note's own number or a reference in its
 * own prose, and the emitter links nothing inside one either.
 */
export function superscriptRuns(text: string): PrintedRun[] {
  const runs: PrintedRun[] = [];
  for (const match of text.matchAll(superscriptRun())) {
    // The assertion is the alphabet, spent: the run is superscript digits and
    // nothing else, so it has a printed value.
    runs.push({ at: match.index, len: match[0].length, printed: printedNoteNumber(match[0])! });
  }
  return runs;
}
