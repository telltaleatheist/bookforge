/**
 * WHAT CHANGED BETWEEN TWO VERSIONS OF ONE BLOCK'S WORDS — a word diff, pure.
 *
 * ── The ask, and where this sits ──────────────────────────────────────────
 *
 * Owen, 2026-09-08: *"I want to be able to compare what changed side-by-side in
 * ai cleanup. It should highlight the changes on each side, like in analysis, so
 * I can see what it was before and what it is now."* The compare column already
 * puts one step of the book beside another (docs/COMPARE-CHANGES.md); this is
 * the arithmetic that says, for ONE block whose text differs between the two
 * sides, which characters of the older text are gone and which characters of the
 * newer text are new. The book view draws the answer as runs (`cut`), exactly as
 * it draws an analysis's findings.
 *
 * IT LIVES IN `shared/` AND DEPENDS ON NOTHING, on `shared/inline.ts`'s rule: a
 * pure function over two strings that the renderer runs on demand today and the
 * main process could run at a landing tomorrow, if a stored diff is ever wanted.
 * No `diff` package — the vendored copy of this app in BookForge must not need a
 * new dependency for a function this small.
 *
 * ── Words, not characters, and why the tokens are three kinds ─────────────
 *
 * A character diff of "the cat sat" against "the dog sat" lights "c", "a" and
 * "t" against "d", "o" and "g" — true and useless, because nobody reads at that
 * grain. The unit here is the WORD: a run of letters and digits (`\p{L}\p{N}`,
 * so "Straße" and "1984" are words and so is anything in any script), with an
 * apostrophe or a hyphen kept INSIDE a word when a word character stands on both
 * sides of it — "don't" and "well-known" are one token each, but a trailing
 * hyphen at a line's end is not glued to the next word.
 *
 * Between the words are two other kinds of run and they are kept SEPARATE:
 * whitespace, and everything else (punctuation and symbols). They are separate
 * because they are compared by equality exactly as words are — a doubled space
 * and a dropped comma are changes a cleanup pass makes on purpose, and a diff
 * that could not show them would be hiding the very thing somebody opened the
 * column to check — and because folding them into one token would make a changed
 * comma light the space beside it as well.
 *
 * ── The alignment is an LCS over tokens, and the guard is what keeps it honest ─
 *
 * The longest common subsequence of the two token lists is the set of tokens
 * that STAYED; everything on the older side not in it was removed and everything
 * on the newer side not in it was added. It is the classic quadratic table
 * (`Uint16Array`, since no side has more tokens than the guard admits), walked
 * from the front so the ranges come out in the block's own order. A common
 * prefix and suffix are stripped first, which is not an optimisation for its own
 * sake: a one-word substitution in a two-hundred-word paragraph — the ordinary
 * case for a cleanup — leaves a table of a handful of cells.
 *
 * THE GUARD IS THE PART THAT MATTERS. An LCS of a paragraph against its
 * TRANSLATION finds every "the", every comma and every space that both languages
 * happen to share, and lights the rest around them as a confetti of tiny
 * removals and additions — technically the smallest edit and visually a lie,
 * because what happened was a rewrite. So when the words the two sides share
 * are fewer than `REWRITE_FLOOR` of the shorter side's words, the honest answer
 * is given instead: the whole of the older text removed, the whole of the newer
 * text added. Words, not tokens, decide that ratio, because punctuation and
 * spaces match across any two sentences in the same script and would vote
 * "mostly the same" on a translation. The same whole-string answer is given when
 * either side is longer than `TOKEN_CEILING` tokens: a block that long is a table
 * or a pasted document, and a nine-million-cell table for it is not a cost the
 * repaint should pay.
 */

/** One stretch of ONE side's text that changed, as `[start, end)` character offsets. */
export interface ChangeRange {
  start: number;
  end: number;
  /** Which side this range is about — `removed` offsets index BEFORE, `added` index AFTER. */
  kind: 'added' | 'removed';
}

/** What changed, both ways: offsets into `before` and offsets into `after`. */
export interface WordDiff {
  /** The characters of the OLDER text that are gone. Sorted, non-overlapping, merged. */
  removed: readonly ChangeRange[];
  /** The characters of the NEWER text that are new. Sorted, non-overlapping, merged. */
  added: readonly ChangeRange[];
}

/** Two equal strings, and the answer for nearly every block of a compared pair. */
export const NO_DIFF: WordDiff = { removed: [], added: [] };

/**
 * THE TYPOGRAPHER'S QUOTES, FOLDED TO THE TYPIST'S — one character for one
 * character, so every offset into the folded string is the same offset into the
 * original.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-08, scanning a cleaned book in the aligned pair: *"lets put a
 * checkbox in that shows/doesnt show the apostrophe/quote fixes. the
 * apostrophe/quote fixes arent really what im looking for when im scanning
 * through the list of cleaning changes."* Every straight quote a narration pass
 * turns into a curly one is a true change and a real edit, and there are
 * hundreds of them in a novel — enough that the two or three changes somebody is
 * actually reading for are lost among them. Diffing the FOLDED strings answers
 * "what changed, apart from the quote marks" without pretending the fold
 * happened: the text drawn is the text as written, and only the LIGHT moves.
 *
 * ── Why the mapping is one-to-one and stays that way ────────────────────────
 *
 * Ranges from a diff of the folded text are used to light the ORIGINAL text, so
 * a fold that changed any length would light the wrong characters. Every entry
 * below is a single code unit replaced by a single code unit. An ellipsis
 * (`…` → `...`) belongs to the same family of tidying and is deliberately NOT
 * here, because it is not length-preserving and would need a mapping table
 * rather than a substitution.
 *
 * GUILLEMETS ARE NOT FOLDED. `«` and `»` are what several languages quote WITH,
 * so a translation that turns `"` into `«` has made a real change to the words
 * on the page, and hiding it under "just quotes" would hide the one thing a
 * person comparing a translation is looking at.
 */
export function foldQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

/**
 * Above this many tokens on either side the diff answers whole-string ranges
 * rather than filling a table. Blocks are paragraphs; 1500 tokens is several
 * hundred words past the longest paragraph a reader would call one.
 */
const TOKEN_CEILING = 1500;

/**
 * Below this share of the shorter side's WORDS in common, the pair is a rewrite
 * and is drawn as one — see the header. 15% is deliberately low: a heavy edit
 * that keeps a third of its sentence's words is still an edit somebody wants to
 * see word by word.
 */
const REWRITE_FLOOR = 0.15;

/**
 * The diff of one block's text at an earlier step against the same block's text
 * at a later one.
 *
 * NEVER THROWS AND NEVER GUESSES: two equal strings answer `NO_DIFF`, an empty
 * side answers the other side whole, and everything else is the alignment above
 * or the guard's whole-string answer.
 */
export function wordDiff(before: string, after: string): WordDiff {
  if (before === after) return NO_DIFF;
  if (before.length === 0 || after.length === 0) return whole(before, after);

  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > TOKEN_CEILING || b.length > TOKEN_CEILING) return whole(before, after);

  /*
   * THE COMMON PREFIX AND SUFFIX, taken off before the table is built. They are
   * matched tokens by definition and count toward the rewrite ratio below; what
   * they are not is cells.
   */
  let head = 0;
  while (head < a.length && head < b.length && a[head]!.text === b[head]!.text) head += 1;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail]!.text === b[b.length - 1 - tail]!.text
  ) tail += 1;

  const n = a.length - head - tail;
  const m = b.length - head - tail;

  /*
   * TOKEN TEXTS BECOME SMALL INTEGERS so the table compares numbers rather than
   * strings — a block's vocabulary is small and the table asks n×m times.
   */
  const ids = new Map<string, number>();
  const idOf = (text: string): number => {
    const held = ids.get(text);
    if (held !== undefined) return held;
    const made = ids.size;
    ids.set(text, made);
    return made;
  };
  const ai = new Int32Array(n);
  const bi = new Int32Array(m);
  for (let i = 0; i < n; i += 1) ai[i] = idOf(a[head + i]!.text);
  for (let j = 0; j < m; j += 1) bi[j] = idOf(b[head + j]!.text);

  /*
   * THE TABLE, SUFFIX-FORMULATED: `L[i][j]` is the LCS length of `a[i..]` against
   * `b[j..]`, so the walk that reads the alignment back runs FORWARD from (0, 0)
   * and the ranges fall out in the block's own order without a reverse. One flat
   * `Uint16Array` of (n+1)×(m+1) cells; the ceiling above keeps every value under
   * 65535 and the whole table under a few megabytes in the worst case a reader
   * could construct.
   */
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * width;
    const below = row + width;
    for (let j = m - 1; j >= 0; j -= 1) {
      table[row + j] = ai[i] === bi[j]
        ? table[below + j + 1]! + 1
        : Math.max(table[below + j]!, table[row + j + 1]!);
    }
  }

  const middle = walk(a, b, head, n, m, ai, bi, table, width);

  /*
   * THE REWRITE GUARD, decided on WORDS. Matched words are the prefix's and the
   * suffix's word tokens plus the words the walk matched in the middle; the
   * denominator is the shorter side's word count. A pair with no words on its
   * shorter side (punctuation-only) has nothing to vote with and is aligned as
   * it stands.
   */
  const shorter = Math.min(countWords(a), countWords(b));
  if (shorter > 0) {
    let matchedWords = middle.matchedWords;
    for (let k = 0; k < head; k += 1) if (a[k]!.kind === 'word') matchedWords += 1;
    for (let k = 0; k < tail; k += 1) if (a[a.length - 1 - k]!.kind === 'word') matchedWords += 1;
    if (matchedWords < REWRITE_FLOOR * shorter) return whole(before, after);
  }
  return { removed: middle.removed, added: middle.added };
}

/**
 * The alignment read back out of the table: every unmatched older token is a
 * removal, every unmatched newer token an addition, adjacent ones merged.
 *
 * TIES PREFER THE REMOVAL. Where the table says taking `a[i]` out or putting
 * `b[j]` in leave the same length behind, the removal is emitted first, so a
 * substitution in the middle of a sentence reads as "this went, this came"
 * rather than the two interleaved.
 */
function walk(
  a: readonly Token[],
  b: readonly Token[],
  head: number,
  n: number,
  m: number,
  ai: Int32Array,
  bi: Int32Array,
  table: Uint16Array,
  width: number,
): { removed: ChangeRange[]; added: ChangeRange[]; matchedWords: number } {
  const removed: ChangeRange[] = [];
  const added: ChangeRange[] = [];
  let matchedWords = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ai[i] === bi[j]) {
      if (a[head + i]!.kind === 'word') matchedWords += 1;
      i += 1;
      j += 1;
      continue;
    }
    const dropA = j >= m || (i < n && table[(i + 1) * width + j]! >= table[i * width + j + 1]!);
    if (dropA) {
      extend(removed, a[head + i]!, 'removed');
      i += 1;
    } else {
      extend(added, b[head + j]!, 'added');
      j += 1;
    }
  }
  return { removed, added, matchedWords };
}

/**
 * Append a token's span to a list of ranges, joining it onto the last one when
 * the two touch. Tokens tile their string, so two consecutive unmatched tokens
 * always touch — which is what makes "merged" a property of this one line.
 */
function extend(into: ChangeRange[], token: Token, kind: ChangeRange['kind']): void {
  const last = into[into.length - 1];
  if (last !== undefined && last.end === token.start) {
    last.end = token.end;
    return;
  }
  into.push({ start: token.start, end: token.end, kind });
}

/** The guard's answer: all of the older text gone, all of the newer text new. */
function whole(before: string, after: string): WordDiff {
  return {
    removed: before.length === 0 ? [] : [{ start: 0, end: before.length, kind: 'removed' }],
    added: after.length === 0 ? [] : [{ start: 0, end: after.length, kind: 'added' }],
  };
}

function countWords(tokens: readonly Token[]): number {
  let n = 0;
  for (const token of tokens) if (token.kind === 'word') n += 1;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

interface Token {
  text: string;
  start: number;
  end: number;
  kind: 'word' | 'space' | 'other';
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE_CHAR = /\s/u;

/**
 * The three kinds of run, tiling the string — every character is in exactly one
 * token, so a token's `[start, end)` is a slice the book view can draw as a run.
 *
 * ASTRAL CHARACTERS ARE STEPPED OVER WHOLE (`codePointAt`): a surrogate pair is
 * one letter or one symbol, never half of each, and the offsets stay UTF-16
 * because that is what `cut()` and every op in the book index by.
 */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const start = i;
    const kind = kindAt(text, i);
    i += widthAt(text, i);
    if (kind === 'word') {
      while (i < n) {
        if (kindAt(text, i) === 'word') {
          i += widthAt(text, i);
          continue;
        }
        // An apostrophe or a hyphen with a word character on BOTH sides stays
        // inside the word: "don't", "well-known", "l'été".
        const ch = text.charCodeAt(i);
        const joiner = ch === 0x27 /* ' */ || ch === 0x2019 /* ’ */ || ch === 0x2d /* - */;
        if (joiner && i + 1 < n && kindAt(text, i + 1) === 'word') {
          i += 1;
          continue;
        }
        break;
      }
    } else {
      while (i < n && kindAt(text, i) === kind) i += widthAt(text, i);
    }
    out.push({ text: text.slice(start, i), start, end: i, kind });
  }
  return out;
}

function kindAt(text: string, at: number): Token['kind'] {
  const point = text.codePointAt(at);
  if (point === undefined) return 'other';
  const ch = String.fromCodePoint(point);
  if (WORD_CHAR.test(ch)) return 'word';
  return SPACE_CHAR.test(ch) ? 'space' : 'other';
}

function widthAt(text: string, at: number): number {
  const point = text.codePointAt(at);
  return point !== undefined && point > 0xffff ? 2 : 1;
}
