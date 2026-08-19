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
 * ── AND SINCE WAVE 18, THE EMPHASIS TOO ────────────────────────────────────
 *
 * `inlineEmphasis` at the foot of this file is the same arrangement for the
 * other half of the model's inline dialect: the `**bold**` and `*italic*` the
 * emitter turns into `<strong>` and `<em>` (`dotsInline`, src/vlm/dots.ts) and
 * the renderer must draw as the same two effects, or the page a person edits and
 * the book they export are two different books. The engine is the reference
 * implementation and has been since long before the renderer existed; this side
 * restates the two expressions and cites it, exactly as the entries above do.
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

// ── emphasis ────────────────────────────────────────────────────────────────

/**
 * `dotsInline`'s own two emphasis patterns, in `dotsInline`'s own order
 * (src/vlm/dots.ts) — the third statement of them in this repo, after the
 * emitter's and `src/translate/textmask.ts`'s, and named here for the same
 * reason that one names them: the app never imports a line of the engine, so the
 * alphabet is written again with the engine's file cited as the contract.
 *
 * STRONG FIRST, and the order is the meaning. It is what decides that
 * `**a *b* c**` is one bold span with an italic inside it rather than two
 * adjacent italics around a stray pair of asterisks. `textmask.ts` makes the
 * same argument at the same two expressions; if the engine's pair ever changes,
 * all three change together.
 *
 * WHAT THE MODEL ACTUALLY EMITS, measured before any of this was written rather
 * than assumed. Across every bank in the user's library: `**bold**` and
 * `*italic*` in quantity, `***` never, `_underscores_` never, `~~` never,
 * backticks never, `[text](href)` never. So the subset is exactly these two and
 * there is no general Markdown parser here — the model's dialect is two effects
 * wide and this is those two.
 *
 * FUNCTIONS RATHER THAN CONSTANTS, which is `superscriptRun` above's rule
 * applied to two more expressions: they carry `g`, so they carry `lastIndex`,
 * and this file's standing answer to that is a fresh matcher per scan rather
 * than a shared cursor and an argument about which callers happen to reset it.
 */
function strongPairs(): RegExp {
  return /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
}

function italicPairs(): RegExp {
  return /(?<![*\w])\*(?=\S)([\s\S]*?\S)\*(?!\w)/g;
}

/** This character is one of the four asterisks of a matched pair — not content. */
export const INLINE_DROPPED = 1;
/** This character is inside a `**bold**` pair. */
export const INLINE_STRONG = 2;
/** This character is inside an `*italic*` pair. */
export const INLINE_ITALIC = 4;

/**
 * The emphasis of every character of one block's text, or null when there is
 * none to have.
 *
 * ── WHY THIS ANSWERS PER CHARACTER RATHER THAN HANDING BACK MARKUP ──────────
 *
 * Because THE BANK AND THE BOOK FILE DO NOT CHANGE, and everything else follows
 * from that. Foundry's edit ops index into a block's text BY CHARACTER OFFSET —
 * a split names a cut at an offset, a delete names `from` and `len`, and a
 * `BookRef` carries an offset into the block it points into (shared/ops.ts).
 * Strip the four asterisks of a pair at reflow and every offset after them in
 * that block moves by four, so replaying an already-curated project would land
 * its strikes and its splits in the wrong places, silently, on a file nobody
 * touched. **So nothing upstream of a screen is allowed to interpret `**`.**
 * Interpretation happens where text is DISPLAYED and nowhere else, and if a
 * later hand is tempted to tidy the markers out of the bank, this paragraph is
 * why they must not.
 *
 * Answering per character is what makes that possible. The renderer already
 * cuts a block at the reference-number offsets the engine resolved, and those
 * offsets are into the SOURCE STRING; a function that handed back a tree of
 * spans, or a string of markup, would be answering in a coordinate system the
 * caller cannot line up with the one its markers are in. One code per source
 * character lines up by construction.
 *
 * ── UNBALANCED MARKERS DEGRADE TO LITERAL TEXT, and this is not a nicety ────
 *
 * It is the direct cost of the decision above. Because the markers stay in the
 * text, a person can cut a block in half between them: a split at an offset
 * inside a `**…**` pair leaves an opening `**` at the end of one block and a
 * closing `**` at the start of the next, and a strike over a range does the
 * same. A greedy parser handed `**Kari Lake` would find no partner, and a
 * forgiving one would bold the rest of the paragraph — or, worse, run on into
 * the next pair and bold the words between two unrelated phrases. Both
 * expressions above require their partner: no partner, no match, and the
 * asterisks stay on the page as the characters they are. That is the same
 * answer the engine gives, and it is the honest one — an asterisk that means
 * nothing should LOOK like an asterisk that means nothing, because the person
 * looking at it is the one who can put it right.
 *
 * It also covers what the model does with lists, for free: `* Intercede for
 * your city` is a bullet and not an italic, and the leading marker survives
 * only because `(?=\S)` refuses an asterisk followed by a space. There are
 * nine such rows in the user's library and not one of them should be italic.
 *
 * ── The two passes, and why the second reads a doctored string ──────────────
 *
 * The emitter runs its italic expression over a string in which every matched
 * `**` has already become a `<strong>` tag, so the lookaround either side of a
 * candidate `*` sees a `>` where the bold markers used to be. To match that
 * exactly WITHOUT moving any offset, the second pass here reads a copy of the
 * text in which those same asterisks have been overwritten with `>` — one
 * character for one character, the same character the emitter's tags end in, so
 * the same candidates match and every index still means what it meant.
 *
 * WHAT DOES NOT MIRROR THE EMITTER, said out loud: the emitter nests elements,
 * so a pathological `***word***` makes it emit crossed tags. Codes per character
 * cannot cross, so the same input draws here as bold-and-italic over the whole
 * run. No bank in the library contains a `***`, the divergence needs one, and
 * the alternative — reproducing malformed markup in a renderer that has no
 * markup to malform — would be mirroring a defect rather than a rule.
 */
export function inlineEmphasis(text: string): Uint8Array | null {
  // The overwhelmingly common block has no asterisk in it at all, and it should
  // cost one scan and no allocation to say so.
  if (!text.includes('*')) return null;

  const codes = new Uint8Array(text.length);
  let found = false;

  /*
   * `split('')` AND NOT `[...text]`, and it is not a style choice. The spread
   * splits by CODE POINT, so one emoji becomes one element while `match.index`
   * and `text.length` count UTF-16 CODE UNITS — and a single astral character
   * anywhere before a marker would put every index after it one out, silently
   * emphasising the wrong words. Code units all the way through, so the
   * residual lines up with the source character for character.
   */
  const residual = text.split('');
  for (const match of text.matchAll(strongPairs())) {
    const at = match.index;
    const end = at + match[0].length;
    // A match is `**` + at least one non-space + `**`, so the two pairs never
    // overlap and the interior is never empty.
    for (const marker of [at, at + 1, end - 2, end - 1]) {
      codes[marker] = INLINE_DROPPED;
      residual[marker] = '>';
    }
    for (let i = at + 2; i < end - 2; i += 1) codes[i]! |= INLINE_STRONG;
    found = true;
  }

  for (const match of residual.join('').matchAll(italicPairs())) {
    const at = match.index;
    const end = at + match[0].length;
    codes[at] = INLINE_DROPPED;
    codes[end - 1] = INLINE_DROPPED;
    // The interior may contain a `>` standing in for a bold marker; that
    // character is already dropped and stays dropped — the flag set on it here
    // is never read, because dropped is asked first.
    for (let i = at + 1; i < end - 1; i += 1) codes[i]! |= INLINE_ITALIC;
    found = true;
  }

  return found ? codes : null;
}
