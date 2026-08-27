import type { BookOp, ReplayedRow } from '@shared/ops';

/**
 * THE SWEEP'S ARITHMETIC — a pattern over a book's blocks, and the edits a set of
 * verdicts comes to.
 *
 * ── Why it is a module and not methods on the dialog ────────────────────────
 *
 * Everything here is a pure function of a string and a regular expression. The
 * dialog holds the sitting — which pattern is active, which matches somebody has
 * spared — and nothing else; the scan, the seam and the plan are decisions about
 * text that have one right answer whoever asks for it. Keeping them out of the
 * component is what makes the seam rule readable as a rule (docs/SWEEP.md §2.5)
 * rather than as three branches inside a click handler, and it is what lets the
 * landing be argued about in one place instead of twice — once for the source
 * pass and once for the translated one, which land the same plan through two
 * different doors.
 *
 * IT LIVES UNDER `core/` AND NOT UNDER `shared/`, which is a real choice. Nothing
 * in the main process sweeps anything: what crosses the boundary is a `text` op
 * or a correction, both of which already have their shapes over there. A copy of
 * this in `shared/` would be compiled by the electron program for no consumer,
 * and would put the renderer's own idea of a sentence into the wire's vocabulary.
 */

/** `( parentheses )` — innermost pairs only, which is the cost §2.2 names. */
export const PARENTHESES = '\\([^()]*\\)';
/** `[ brackets ]`, on the same rule and for the same reason. */
export const BRACKETS = '\\[[^\\[\\]]*\\]';

/** Which pattern the sitting is standing on. Exactly one, always (§2.2). */
export type SweepPreset = 'parentheses' | 'brackets' | 'custom';

/** The quoted sentence a census row draws, cut at the span so it can be lit. */
export interface SweepQuote {
  before: string;
  hit: string;
  after: string;
}

/** One match, which is one row of the census and one verdict. */
export interface SweepMatch {
  /**
   * THE NAME A VERDICT IS FILED UNDER, minted here rather than derived at the
   * row. Spans inside one block never overlap, so the block and the offset name
   * this match and no other; it is a field because the census is a list with no
   * cap on it and a template composing this string per row per repaint would be
   * doing the one piece of work a scan can hand it for free.
   */
  key: string;
  /** The block, by the name every op and every reveal is keyed to. */
  id: string;
  /**
   * The page this block started on — an ESTIMATE and never an address
   * (`BookRow.page`), which is why the chip wears the ≈ the sheet's own ghosts
   * wear. Zero on a book exploded out of an EPUB, where nothing page-shaped
   * exists to estimate, and the chip is simply not drawn.
   */
  page: number;
  /** Half-open, into the block's replayed text. */
  start: number;
  end: number;
  /** The characters themselves — what a cut would remove, before the seam. */
  hit: string;
  /**
   * The block was already struck: ghosted in the census, no verdict, counts for
   * nothing (§2.1). It is listed rather than dropped because a person searching
   * for `(see …)` wants to know the ones they have already cancelled are gone.
   */
  struck: boolean;
  /** The sentence around it, for the row's ordinary state. */
  quote: SweepQuote;
}

/** A scan that ran, or the sentence saying why it did not. */
export type SweepCensus =
  | { ok: true; matches: readonly SweepMatch[] }
  | { ok: false; reason: string };

/** One block's whole edit: the mended text, or null for a block cut to nothing. */
export interface SweepEdit {
  id: string;
  /**
   * NULL IS A STRIKE AND NEVER AN EMPTY `text` OP (§1). A block whose every
   * character was inside a chosen span still exists — it stays in the document,
   * cancelled and restorable — and writing it as an empty string would put a
   * blank paragraph in the edition instead of taking one out of it.
   */
  text: string | null;
}

const NO_MATCHES: readonly SweepMatch[] = [];

/**
 * The pattern, compiled — or the sentence that goes under the field.
 *
 * NEVER A THROW, which is §2.2's own rule. Somebody typing a pattern is midway
 * through typing it for most of the keystrokes, so `(` is not an error state; it
 * is a half-written pattern, and the surface's job is to say so quietly under the
 * field rather than to fall over between two keystrokes.
 *
 * THE ENGINE'S OWN COMPLAINT IS CARRIED THROUGH, trimmed of the prefix it repeats
 * the pattern in. "Unterminated group" is the whole of what a person needs and
 * this app has no better way of saying it; inventing a house sentence for every
 * shape of regex defect would be a worse dictionary than the one the platform
 * already ships.
 */
export function compile(pattern: string, matchCase: boolean): { ok: true; re: RegExp }
  | { ok: false; reason: string } {
  try {
    return { ok: true, re: new RegExp(pattern, matchCase ? 'g' : 'gi') };
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    const colon = said.lastIndexOf(': ');
    const detail = colon === -1 ? said : said.slice(colon + 2);
    return { ok: false, reason: `That pattern will not compile: ${detail.toLowerCase()}.` };
  }
}

/**
 * EVERY MATCH IN THE BOOK, in reading order, with no cap (§3).
 *
 * ── What is searched, and the one row that is not ───────────────────────────
 *
 * The rows are `view().rows` — the recorded chain and the pending stack already
 * replayed in, on whichever pass the workbench stands. A SHELVED ROW IS SKIPPED,
 * and that is this function's own refinement of §2.1 rather than a liberty: a
 * shelved block is in the file and not in the flow (`linesOf`, book-view), so it
 * is not on the paper, `reveal` cannot travel to it, and no edition ever emits
 * it. A census row for one would be a verdict about text nobody can see, landing
 * an op nothing draws. The Furniture panel is that population's surface.
 *
 * ── A ZERO-LENGTH MATCH IS NAMED, NEVER WALKED PAST ─────────────────────────
 *
 * `/x?/g` finds an empty string at every position in the book, and the usual
 * defence — bump `lastIndex` and carry on — would hand somebody a census with one
 * row per character and a landing verb reading "Cut 1,400,000". §2.2 rules that
 * this is refused by name, and the refusal is made HERE rather than by a test on
 * the compiled pattern, because a pattern can match emptiness in some contexts
 * and not in others (`\b` is the plain example) and only the walk knows.
 */
export function scan(rows: readonly ReplayedRow[], re: RegExp): SweepCensus {
  const out: SweepMatch[] = [];
  for (const row of rows) {
    if (row.shelf !== undefined) continue;
    re.lastIndex = 0;
    let found = re.exec(row.text);
    while (found !== null) {
      const hit = found[0];
      if (hit.length === 0) {
        return {
          ok: false,
          reason: 'That pattern matches nothing at all — it would select the whole book.',
        };
      }
      const start = found.index;
      const end = start + hit.length;
      out.push({
        key: `${row.id}#${start}`,
        id: row.id,
        page: row.page,
        start,
        end,
        hit,
        struck: row.struck === true,
        quote: quoteAround(row.text, start, end, SENTENCE_REACH),
      });
      found = re.exec(row.text);
    }
  }
  return { ok: true, matches: out.length === 0 ? NO_MATCHES : out };
}

/**
 * The block's fuller text around a match — the widening a hover asks for (§3).
 *
 * COMPUTED ON DEMAND AND NOT CARRIED ON EVERY MATCH. A book can answer a pattern
 * with thousands of rows, and a second quotation three times the length of the
 * first, held for every one of them and drawn for one, is a megabyte of strings
 * kept so that a pointer can rest somewhere.
 */
export function widen(rows: readonly ReplayedRow[], match: SweepMatch): SweepQuote | null {
  const row = rows.find((candidate) => candidate.id === match.id);
  if (row === undefined) return null;
  return quoteAround(row.text, match.start, match.end, BLOCK_REACH);
}

/**
 * THE VERDICTS, BECOME EDITS — one entry per block, in the book's own order.
 *
 * ── Why the grouping is the whole of it ─────────────────────────────────────
 *
 * Three spans chosen in one paragraph are ONE `text` op, not three (§2.5). Three
 * ops would each be a full replacement of the block's source string computed
 * against a state the previous one had already changed — the second would put the
 * first's cut back — and even minted correctly they would be three rows in the
 * pending count and three presses of undo for one decision a person made once.
 *
 * The chosen matches arrive in reading order and are cut RIGHT TO LEFT inside
 * each block, which is what keeps every offset in this list an offset into the
 * string it was measured against.
 */
export function plan(
  rows: readonly ReplayedRow[],
  chosen: readonly SweepMatch[],
): readonly SweepEdit[] {
  const byBlock = new Map<string, SweepMatch[]>();
  for (const match of chosen) {
    const held = byBlock.get(match.id);
    if (held === undefined) byBlock.set(match.id, [match]);
    else held.push(match);
  }
  const out: SweepEdit[] = [];
  for (const row of rows) {
    const spans = byBlock.get(row.id);
    if (spans === undefined) continue;
    const left = cutSpans(row.text, spans);
    out.push({ id: row.id, text: left.length === 0 ? null : left });
  }
  return out;
}

/** The plan, as ops — the shape a source pass lands in one variadic push. */
export function opsFor(edits: readonly SweepEdit[]): readonly BookOp[] {
  return edits.map((edit): BookOp => (
    edit.text === null ? { op: 'strike', id: edit.id } : { op: 'text', id: edit.id, text: edit.text }
  ));
}

/**
 * THE SEAM, SEWN LOCALLY — §2.5, and every clause of it is a line below.
 *
 * ── The rule, and the discipline around it ──────────────────────────────────
 *
 * Removing "(see Sandoval p. 170)" from "…the argument (see Sandoval p. 170) is
 * old." leaves two spaces where one belongs; removing it from "…the argument
 * (see Sandoval p. 170), which…" leaves a space in front of a comma. Both are
 * mended, and NOTHING ELSE IS. The sweep is a faster hand, not a tidier: a run of
 * whitespace the person never touched, a double space three words away, an
 * unbalanced quotation mark the cut exposed — all of it survives exactly as it
 * was, because a gesture that quietly reflowed a paragraph would be a gesture
 * whose diff nobody can read.
 *
 * ── The floor, which is the correctness rather than a nicety ────────────────
 *
 * A mend can delete the character to the LEFT of the seam, and with two adjacent
 * spans that character is inside the span still waiting to be cut — after which
 * every offset in it is one too far right and the next cut takes a character it
 * was never given. So each mend is told how far left it may reach: the end of the
 * next span this loop will visit, which no earlier decision may cross.
 */
export function cutSpans(
  text: string,
  spans: readonly { start: number; end: number }[],
): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  ordered.forEach((span, i) => {
    const next = ordered[i + 1];
    const floor = next === undefined ? 0 : next.end;
    out = mend(out.slice(0, span.start) + out.slice(span.end), span.start, floor);
  });
  return out.trim();
}

/**
 * The two clauses of the seam rule, at one cut point.
 *
 * A cut at the very start or the very end of a block has no seam to sew — it has
 * an EDGE, and the trim at the end of `cutSpans` is what answers for those.
 */
function mend(text: string, at: number, floor: number): string {
  if (at <= 0 || at >= text.length) return text;
  const left = text.charAt(at - 1);
  const right = text.charAt(at);
  if (isSpace(left) && isSpace(right)) {
    /*
     * ONE SURVIVES, AND WHICH ONE IS NOT ARBITRARY. A newline in this position
     * is structure — the blocks of this app hold multi-line text and a line
     * break inside one is a break somebody can see — so the plain space goes and
     * the newline stays. Where both are the same kind it makes no difference and
     * the right-hand one goes, which keeps the mend from ever reaching left into
     * a span still waiting to be cut.
     */
    const drop = right === '\n' && left !== '\n' && at - 1 >= floor ? at - 1 : at;
    return text.slice(0, drop) + text.slice(drop + 1);
  }
  if (isSpace(left) && CLOSERS.includes(right) && at - 1 >= floor) {
    return text.slice(0, at - 1) + text.slice(at);
  }
  return text;
}

/** The marks that must not be left with a space in front of them. §2.5's own list. */
const CLOSERS = '.,;:!?)';

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * How far a census row's ordinary quotation reaches on either side of the span.
 *
 * EXPORTED SINCE THE ANALYSIS PANEL WANTED THE SAME QUOTATION. It draws a row per
 * finding with a three-span quotation and widens it on hover, which is this
 * module's own gesture aimed at a different list — so it takes these two numbers
 * and `quoteAround` itself rather than growing a second sentence rule. Two
 * implementations of "how much of the paragraph is context" would be two lists in
 * one app that quote the same book differently.
 */
export const SENTENCE_REACH = 140;
/** And how far the hover's widening does, which is the block or as much as fits. */
export const BLOCK_REACH = 600;

/**
 * The words around a span, cut into three so the middle can be lit.
 *
 * ── Sentence first, then the leash ──────────────────────────────────────────
 *
 * The reach is a SENTENCE where one can be found: back to the last full stop that
 * had whitespace after it, forward to the next one, and a line break in either
 * direction is a harder boundary than any punctuation mark. Where no sentence
 * ends within the leash — a block that is one long unpunctuated run, which OCR
 * produces more often than prose does — the leash wins and the quotation says so
 * with an ellipsis rather than growing to the size of the paragraph.
 *
 * WHAT THIS DRAWS IS THE REPLAYED SOURCE STRING, inline markers and all, which is
 * the same string the double-click editor puts in front of somebody. §2.4's
 * "the preview never lies" is about the SPAN — what the row shows cut is exactly
 * what the op removes — and a quotation that silently hid a footnote marker
 * standing next to the span would be lying about the neighbourhood instead.
 */
export function quoteAround(text: string, start: number, end: number, reach: number): SweepQuote {
  const floor = Math.max(0, start - reach);
  let from = floor;
  for (let i = start - 1; i >= floor; i -= 1) {
    const ch = text.charAt(i);
    if (ch === '\n') { from = i + 1; break; }
    if (STOPS.includes(ch) && isSpace(text.charAt(i + 1))) { from = i + 1; break; }
  }
  const ceiling = Math.min(text.length, end + reach);
  let to = ceiling;
  for (let i = end; i < ceiling; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\n') { to = i; break; }
    if (STOPS.includes(ch) && (i + 1 >= text.length || isSpace(text.charAt(i + 1)))) {
      to = i + 1;
      break;
    }
  }
  const before = text.slice(from, start).replace(/^\s+/, '');
  const after = text.slice(end, to).replace(/\s+$/, '');
  return {
    before: (from > 0 ? '… ' : '') + before,
    hit: text.slice(start, end),
    after: after + (to < text.length ? ' …' : ''),
  };
}

/** What ends a sentence, for the purpose of quoting one. */
const STOPS = '.!?';
