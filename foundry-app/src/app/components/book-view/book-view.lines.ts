/**
 * book-view.lines — a block's text cut into the lines and pieces the sheet draws.
 */
import { effect } from '@angular/core';
import { pdfCategoryColour, pdfCategoryLabel } from '@owen/foundry-core/shared/categories';
import type { BookLoad, BookRow } from '@owen/foundry-core/shared/book';
import { INLINE_DROPPED, INLINE_ITALIC, INLINE_STRONG, inlineEmphasis } from '@owen/foundry-core/shared/inline';
import { type ReplayedRow } from '@owen/foundry-core/shared/ops';
import { wordDiff, type ChangeRange } from '@owen/foundry-core/shared/word-diff';
import { ChangesService } from '../../core/changes.service';
import type { LitRange } from '@owen/foundry-core/shared/analysis';
import { chapterOrder } from '@owen/foundry-core/shared/flow';
import { readTable } from '@owen/foundry-core/shared/table';
import { Marker, Piece, Line, BASE_RATIO, NO_LIT, NO_CHANGES, tintOf, deepTintOf } from './book-view.model';

/**
 * How many characters into the editor's own text the caret is, or null when
 * there is no caret to measure — nothing focused here, or a RANGE rather than an
 * insertion point.
 *
 * COUNTED THE WAY `textContent` COUNTS. A `Range`'s own string is the data of the
 * text nodes it spans and nothing else, which is exactly what `textContent`
 * returns — so an offset measured here is an offset into the string `commit` reads
 * back, and the two cannot disagree about where character forty is. Walking the
 * child nodes by hand would be a second implementation of that arithmetic.
 *
 * A NON-COLLAPSED SELECTION IS NULL AND NOT ITS START. Enter with words
 * highlighted is a replace in every editor anybody has used, and a replace is not
 * a thing one op can say; answering "the caret is at the start of what you
 * highlighted" would perform a cut nobody asked for and leave the highlighted
 * words at the top of the second half.
 */
export function caretOffsetIn(editor: HTMLElement): number | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/**
 * ONE PASS OVER A LIST OF ROWS — the book as a sheet draws it, whichever sheet.
 *
 * EVERYTHING THAT DEPENDS ON THE ROW BEFORE IS DECIDED HERE, in one pass, and not
 * in the template: whether a paragraph is indented (the first of the book and the
 * first after a heading are not — print convention, RENDERER-DESIGN.md §2), where
 * a page ghost belongs (only where the source page CHANGES), and which note opens
 * a page's group of them and so carries the hairline. A template asking those
 * questions per block would ask them again on every repaint.
 *
 * ── `chrome` IS THE WHOLE OF WHAT THE TWO COLUMNS DISAGREE ABOUT ────────────
 *
 * *"Chrome only on the live column."* The context sheet in the aligned view is
 * the paper, the serif and the measured sizes with no instrument on it at all —
 * no rules, no chips, no ordinals, no ghosts, no flags — because there is nothing
 * on that sheet a person can decide. It is ONE parameter rather than six empty
 * collections passed in, because six empty collections are six things that have to
 * stay empty and one boolean is a statement.
 *
 * The marker cutting is NOT under it: numbers are characters of the words, not
 * marks in a gutter, and both columns cut at the offsets the engine resolved
 * (`cut`, below — the one implementation, on both sheets).
 */
export function linesOf(
  rows: readonly ReplayedRow[],
  marks: {
    printed: ReadonlyMap<string, Marker[]>;
    size: (category: string) => number;
    chapters: ReadonlyMap<string, string>;
    seams: ReadonlyMap<string, string>;
    orphans: ReadonlySet<string>;
    chrome: boolean;
    /*
     * WHICH CHARACTERS THE ANALYSIS LIT, by block — empty for every book with no
     * report open over it, which is nearly always.
     *
     * It rides in `marks` beside the note markers rather than being looked up
     * inside `cut`, because this function is the ONE place a row's per-block facts
     * are gathered and `cut` is a pure walk over a string and two lists. The
     * source column passes an empty map and gets the walk it has always had.
     */
    lit: ReadonlyMap<string, readonly LitRange[]>;
    /**
     * WHICH CHARACTERS CHANGED AGAINST THE OTHER COLUMN of an open comparison,
     * by block — this sheet's half of the diff (`ChangesService`), and empty for
     * every sheet that is not a party to one. It rides beside `lit` for `lit`'s
     * reason, and is walked by `cut` on the same cursor.
     */
    changes: ReadonlyMap<string, readonly ChangeRange[]>;
  },
): Line[] {
  const out: Line[] = [];
  let previous: BookRow | null = null;
  let onPage = -1;
  /*
   * The sienna ordinal counts a page's notes HERE, not off `row.note`. That
   * field is which note of its banked BLOCK a row is, and it only ever agreed
   * with "which note of its page" while the model answered a page's whole
   * footnote area as one block. A book whose notes each arrived as their own
   * block wore "1" beside every note on the page — Owen's evangelische-kirche,
   * five notes, five 1s — so the page's count is taken where the page is in
   * hand, keyed by page because the bench's order groups a chapter's notes
   * together and a key outlives any assumption about adjacency.
   */
  const notesOnPage = new Map<number, number>();
  for (const row of rows) {
    /*
     * THE SHELF IS IN THE FILE AND NOT ON THE PAPER — §5 of the contract: a
     * shelved row is a block the model answered and the book does not contain
     * (page furniture, a suppressed running head), kept at its reading-order
     * position so that restoring one is an op with an obvious answer for where.
     * The Furniture Review panel is its surface (R4); the flow is not.
     */
    if (row.shelf !== undefined) continue;
    const page = row.pages[0] ?? row.page;
    const ghost = page === onPage ? null : page;
    onPage = page;
    const chapter = marks.chapters.get(row.id) ?? null;
    const heading = previous !== null
      && (previous.category === 'Title' || previous.category === 'Section-header');
    const markers = marks.printed.get(row.id) ?? [];
    const litHere = marks.lit.get(row.id) ?? NO_LIT;
    // A struck row is never in the map — `ChangesService.changes` skips it at
    // the source, exactly as `litRanges` does — so there is nothing to undo here.
    const changesHere = marks.changes.get(row.id) ?? NO_CHANGES;
    let ordinal: number | null = null;
    if (marks.chrome && row.category === 'Footnote') {
      ordinal = (notesOnPage.get(page) ?? 0) + 1;
      notesOnPage.set(page, ordinal);
    }
    out.push({
      row,
      pieces: cut(row.text, markers, litHere, changesHere),
      /*
       * THE FIRST FINDING IN THIS BLOCK, for the scroll's following. The ranges
       * arrive in the book's own order (`litRanges`), so the first of them is the
       * earliest passage of this paragraph and therefore the card a reader who has
       * this paragraph at the top of the page is looking at.
       */
      hitKey: litHere[0]?.key ?? null,
      /*
       * READ ONCE, HERE, AND NEVER FROM THE TEMPLATE. Parsing a fragment is a
       * `DOMParser` document per call, and a template expression is re-evaluated
       * on every change detection — so a table asked for its grid from the
       * template would build one document per row per keystroke. This pass runs
       * when the replayed rows change, which is when the answer can change.
       */
      table: row.category === 'Table' ? readTable(row.text) : null,
      colour: pdfCategoryColour(row.category),
      label: pdfCategoryLabel(row.category),
      size: marks.size(row.category),
      ordinal,
      jump: marks.chrome ? row.refs?.[0]?.block ?? null : null,
      ghost: marks.chrome ? ghost : null,
      chapter,
      // The bench draws divisions as rules and never as headings, and it spends
      // no air on them — the rule is the break.
      heading: null,
      opens: false,
      seamInto: marks.seams.get(row.id) ?? null,
      indent: row.category === 'Text' && previous !== null && !heading && chapter === null,
      /*
       * The hairline stands above the first note of a CHAPTER's collected
       * apparatus now, not a page's: `chapterOrder` has already gathered each
       * chapter's notes into one contiguous run, so "the previous row is not a
       * note" is the whole of the test, and the page clause that used to cut a
       * rule between page-groups would draw rules inside one apparatus.
       */
      opensNotes: row.category === 'Footnote'
        && (previous === null || previous.category !== 'Footnote'),
      // Both directions of the one structural flag this app still keeps
      // (docs/RENDERER.md §0, ruling 7). A note nothing points at first: it is
      // the whole row's problem, where a stray number is one word's.
      flag: !marks.chrome
        ? null
        : marks.orphans.has(row.id)
          ? 'nothing in the book carries this note'
          : markers.some((marker) => marker.note === null)
            ? 'no note carries this number'
            : null,
    });
    previous = row;
  }
  return out;
}

/** The measured size for this category, or the engine's own base sheet's. */
export function sizeOf(book: BookLoad, category: string): number {
  const measured = book.typography?.categories[category];
  if (measured !== undefined) return measured.ratio;
  return BASE_RATIO[category] ?? 1;
}

/**
 * One block's text, cut at the reference numbers printed in it AND at every
 * change of the model's emphasis.
 *
 * BY OFFSET AND NEVER BY SEARCHING FOR THE DIGITS — the engine resolved these
 * with the page in front of it, and a marker found by matching text lands on
 * whichever occurrence of "1" came first. The markers arrive sorted, inside the
 * text and non-overlapping, all three PROVEN by the parser (`parseBookFile`,
 * shared/book.ts) rather than assumed here, which is what lets this be one
 * forward walk with nothing to decide.
 *
 * ── §18b: THE EMPHASIS IS AN EFFECT HERE AND CHARACTERS EVERYWHERE ELSE ─────
 *
 * The vision model writes `**bold**` and `*italic*` into a block's text, and
 * until now every layer of this program treated them as prose: the emitter has
 * turned them into `<strong>` and `<em>` since it was written, but this sheet
 * drew four asterisks around the name of every person who blurbed the book. The
 * user's ruling was that the effect should reach both — *"the bank should
 * display it correctly, basically."*
 *
 * **THE BANK AND THE BOOK FILE DO NOT CHANGE, AND THIS IS WHERE SOMEBODY WILL
 * BE TEMPTED.** The obvious tidy-up is to strip the markers once, at reflow,
 * and be done with them. It would corrupt every project already curated.
 * Foundry's edit ops index into block text BY CHARACTER OFFSET — a split names
 * a cut at an offset, a delete names `from` and `len`, a `BookRef` carries an
 * offset into the block it points into (shared/ops.ts, whose own comment says a
 * text edit invalidates every ref offset into that block). Taking four
 * characters out of a block moves every offset after them by four, and a replay
 * would then land that project's strikes and splits four characters off, on a
 * file nobody edited, with nothing raised. So the markers stay in the text, and
 * INTERPRETATION HAPPENS ONLY WHERE TEXT IS DISPLAYED — here, and in the
 * emitter. There is no third place.
 *
 * Which is why this is one function and not a second pass afterwards: the
 * reference-number offsets and the emphasis codes are both offsets into the
 * SAME source string, so the two cuts are interleaved in one walk and can never
 * disagree about which characters they are talking about. A run of the words
 * ends wherever either of them says it does.
 *
 * WHAT THE EDITOR SEES IS UNTOUCHED. The block editor renders `line.row.text`
 * verbatim, on the standing ruling that what is being edited is the model's
 * SOURCE STRING — asterisks and superscript digits included — and the caret
 * arithmetic a split is made from (`caretOffsetIn`) counts that string and not
 * this one. An edit therefore still commits exactly the characters the bank
 * holds, and the effect comes back the moment the editor closes.
 *
 * ── AND THE ANALYSIS'S HIGHLIGHTS ARE THE THIRD THING IN THE SAME WALK ──────
 *
 * *"Highlights are runs, not overlays"* (docs/ANALYSIS.md §8), and this is where
 * that ruling is kept. A report's findings are `[start, end)` spans into a
 * block's text — the same kind of offset as a marker's, into the same string — so
 * they join the cursor below and a run closes when the LIGHT changes exactly as
 * it closes when a marker or an emphasis does.
 *
 * THE TWO ALTERNATIVES WERE BOTH REFUSED BEFORE THIS WAS WRITTEN. `innerHTML` is
 * banned on this surface outright (the class docblock: a book is somebody else's
 * words arriving through a model's answer, and the one thing this app will not do
 * is hand them to a parser that can execute). An absolutely-positioned overlay
 * eats gestures, which is the pointer-events ruling the struck-figure X is
 * written under a hundred lines down — and it would make a flagged paragraph the
 * one paragraph nobody can select, edit or strike, which is the exact opposite of
 * what a report is for.
 *
 * THE RANGES ARRIVE MERGED AND NON-OVERLAPPING (`litRanges`, core/analysis.ts),
 * so this walk has nothing to decide at a character two findings both claimed.
 * That decision belongs where the findings are, and it is made there.
 *
 * ── AND THE COMPARISON'S CHANGES ARE THE FOURTH, ON THE SAME CURSOR ────────
 *
 * Owen, 2026-09-08: *"highlight the changes on each side, like in analysis."*
 * "Like in analysis" is taken literally: a change is a `[start, end)` span into
 * this block's text (`wordDiff`, shared/word-diff.ts — the older column's
 * removals indexed into its own text, the newer column's additions into its),
 * so it joins the cursor below as a second sorted list walked exactly as `lit`
 * is, and a run closes where the change begins and ends because `hit` changes
 * there. One walk, one more comparison per character, and no second pass that
 * could disagree about where character forty is.
 *
 * THE ANALYSIS WINS WHERE BOTH COVER, which is a rule for a case that cannot
 * arise — the stage holds one second column, so a report and a comparison are
 * never open together — stated so the walk has an answer rather than an
 * accident if that ever changes. The change ranges arrive merged and sorted
 * too (`wordDiff` joins neighbours as it emits them), so the discipline is the
 * same: nothing to decide here at a character two ranges both claimed.
 */
export function cut(
  text: string,
  markers: readonly Marker[],
  lit: readonly LitRange[],
  changes: readonly ChangeRange[],
): Piece[] {
  const codes = inlineEmphasis(text);
  if (markers.length === 0 && codes === null && lit.length === 0 && changes.length === 0) {
    return [{
      text, marker: null, strong: false, italic: false, hit: null, hitInk: null, hitDeep: null, hitKey: null,
    }];
  }

  const pieces: Piece[] = [];
  /*
   * ONE CURSOR OVER THE CHARACTERS, and a run is closed whenever anything about
   * it changes. It is ONE walk and not a marker walk with an emphasis walk
   * after it, because two walks over one string are two chances to disagree
   * about where character forty is — and it costs nothing to avoid, since a run
   * is never anything but a SLICE of the source: a dropped character always
   * closes the run, so no run ever has to span a gap.
   *
   * A `null` code array is the ordinary block with no emphasis in it, which is
   * most of the book: every character is plain, nothing is dropped, and the walk
   * reduces to exactly the marker cuts it has always made.
   */
  let start = 0;
  let runStrong = false;
  let runItalic = false;
  let runMarker: Marker | null = null;
  let runHit: Piece['hit'] = null;
  let runHitInk: string | null = null;
  let runHitDeep: string | null = null;
  let runHitKey: string | null = null;
  const close = (end: number): void => {
    if (end > start) {
      pieces.push({
        text: text.slice(start, end),
        marker: runMarker,
        strong: runStrong,
        italic: runItalic,
        hit: runHit,
        hitInk: runHitInk,
        hitDeep: runHitDeep,
        hitKey: runHitKey,
      });
    }
    start = end;
  };

  /** Which marker covers this character, or null — the markers arrive sorted. */
  let next = 0;
  /*
   * AND WHICH LIT RANGE DOES, on the identical cursor. `litRanges`
   * (core/analysis.ts) merged the findings into non-overlapping runs in the book's
   * own order before they got here, so this is the marker walk again over a second
   * sorted list — one cursor, one comparison, and nothing to decide at a character
   * two findings both claimed, because that decision was made where the findings
   * were.
   */
  let nextLit = 0;
  /** And which change range does — the third sorted list, the same cursor. */
  let nextChange = 0;
  for (let i = 0; i < text.length; i += 1) {
    while (next < markers.length && markers[next]!.at + markers[next]!.len <= i) next += 1;
    const over = markers[next];
    const marker = over !== undefined && over.at <= i ? over : null;
    while (nextLit < lit.length && lit[nextLit]!.end <= i) nextLit += 1;
    const range = lit[nextLit];
    const covering = range !== undefined && range.start <= i ? range : null;
    while (nextChange < changes.length && changes[nextChange]!.end <= i) nextChange += 1;
    const change = changes[nextChange];
    const changed = change !== undefined && change.start <= i ? change.kind : null;
    const hit: Piece['hit'] = covering === null ? changed : 'lit';
    /*
     * AND WHICH FINDING IT IS, off the same range. `litRanges` put the earliest
     * covering finding's key on the merged run and made the key a thing two
     * neighbours must agree about before they join, so this changes at exactly
     * the characters the run already closes at — one more comparison below and
     * no second walk.
     */
    const hitKey = covering?.key ?? null;
    /*
     * AND WHICH COLOUR — Owen's ruling that the paper's highlight is the card's
     * colour. It is derived once per category (`tintOf` memoises), and it changes
     * exactly where the key does, so the run closes at the same characters it
     * already closed at and nothing new has to be compared.
     */
    const hitInk = covering === null ? null : tintOf(covering.category);
    const hitDeep = covering === null ? null : deepTintOf(covering.category);
    const code = codes?.[i] ?? 0;
    /*
     * THE FOUR ASTERISKS OF A MATCHED PAIR ARE NOT ON THE PAGE. They are still
     * in the file, still counted by every offset, and simply not drawn — which
     * is the whole of what "interpret at display" means. An UNMATCHED asterisk
     * is never dropped (shared/inline's own argument), so a block that a strike
     * or a split cut mid-pair shows its markers as the characters they are
     * rather than swallowing the rest of the paragraph into a bold run.
     */
    if ((code & INLINE_DROPPED) !== 0) {
      close(i);
      start = i + 1;
      continue;
    }
    const strong = (code & INLINE_STRONG) !== 0;
    const italic = (code & INLINE_ITALIC) !== 0;
    if (marker !== runMarker
      || strong !== runStrong
      || italic !== runItalic
      || hit !== runHit
      || hitKey !== runHitKey) {
      close(i);
      runMarker = marker;
      runStrong = strong;
      runItalic = italic;
      runHit = hit;
      runHitInk = hitInk;
      runHitDeep = hitDeep;
      runHitKey = hitKey;
    }
  }
  close(text.length);
  return pieces;
}
