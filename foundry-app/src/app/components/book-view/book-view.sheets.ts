/**
 * book-view.sheets — what the sheets draw, derived: the replayed view, the highlights over it, and the rows of each column.
 */
import { computed } from '@angular/core';
import { REWRITE_LABELS } from '@owen/foundry-core/shared/ledger';
import { replayOps } from '@owen/foundry-core/shared/ops';
import { foldQuotes, wordDiff, type ChangeRange, type WordDiff } from '@owen/foundry-core/shared/word-diff';
import { AnalysisViewService } from '../../core/analysis-view.service';
import { StageService } from '../../core/stage.service';
import type { LitRange } from '@owen/foundry-core/shared/analysis';
import { editionFlow, editionPieces } from '@owen/foundry-core/shared/edition';
import { chapterOrder, seamJoins, sharedAnchor } from '@owen/foundry-core/shared/flow';
import { Marker, Line, NO_CHANGE_MAP, NO_ALIGNED_DIFF } from './book-view.model';
import { linesOf, sizeOf, cut } from './book-view.lines';
import type { BookViewComponent } from './book-view.component';

/**
 * Every reference number in the book, gathered by the block it was PRINTED in.
 *
 * The file records them the other way round — a note carries the places its
 * number appears — because the note is what owns the link, and deleting one is
 * what removes its numbers (docs/RENDERER.md §2). Drawing wants the inverse,
 * taken once, rather than a search of every note in the book per block.
 */
/**
 * THE BOOK AS IT NOW READS — the file, with the chain and the stack replayed.
 *
 * ONE REPLAY, NO INCREMENTAL MUTATION. Every gesture on this surface pushes an
 * op and this recomputes; nothing anywhere else edits a row to match. The two
 * lists are concatenated in the only order they can be — what is already
 * recorded, then what is waiting — because the stack is a delta against the
 * state the chain produces, and the fold is order-dependent by design (last op
 * wins, `replayOps`).
 *
 * IT CANNOT THROW IN PRACTICE and is not wrapped as though it could. The only
 * refusal `replayOps` makes is an op kind this build cannot perform, and both
 * sources are already proven: main refuses the whole load rather than hand over
 * a chain it could not read (electron/book.ts), and the stack is minted by the
 * four gestures below.
 */
/*
 * THE HEADER'S CHAPTERS RIDE IN AS THE SEED, and drawing the header's list
 * instead would make every chapter op invisible. The engine's detected starts
 * are an INPUT to the replay now: a chain with no chapter op in it hands the
 * seed straight back, the first chapter op takes the list over for the rest of
 * the chain, and `reset` hands it back (`Replayed.chapters`). So the sheet draws
 * `view().chapters` — the ops' answer where there is one and the reading's
 * everywhere else — and there is no second place where a division is also
 * decided.
 */
export function view(this: BookViewComponent) {
  return computed(() => {
  const book = this.book();
  if (book === null) return null;
  return replayOps(book.rows, [...book.ops, ...this.pending()], book.loose, book.chapters);
});
}

/**
 * True when the ops own the divisions rather than the reading — `interpret`'s
 * ownership rule, restated over the same two lists the replay reads.
 *
 * IT IS THE PANEL'S QUESTION AND NOT THE SHEET'S. The paper draws whichever
 * list is in force without caring whose it is; the Chapters panel has to say
 * whose the rows are and whether "Use Foundry's" has anything to hand back, and
 * a reset pushed over a seed already in force would be a row in somebody's
 * history recording a change that changed nothing.
 */
export function chaptersOwned(this: BookViewComponent) {
  return computed(() => {
  const book = this.book();
  if (book === null) return false;
  let owned = false;
  for (const op of [...book.ops, ...this.pending()]) {
    if (op.op === 'chapter') owned = !('reset' in op);
  }
  return owned;
});
}

export function printed(this: BookViewComponent) {
  return computed<ReadonlyMap<string, Marker[]>>(() => {
  const replayed = this.view();
  const out = new Map<string, Marker[]>();
  if (replayed === null) return out;
  const cancelled = this.struckNotes();
  const add = (block: string, marker: Marker): void => {
    const already = out.get(block);
    if (already === undefined) out.set(block, [marker]);
    else already.push(marker);
  };
  for (const row of replayed.rows) {
    for (const ref of row.refs ?? []) {
      add(ref.block, { at: ref.at, len: ref.len, note: row.id, struck: cancelled.has(row.id) });
    }
  }
  for (const loose of replayed.loose.markers) {
    add(loose.block, { at: loose.at, len: loose.len, note: null, struck: false });
  }
  for (const markers of out.values()) markers.sort((one, other) => one.at - other.at);
  return out;
});
}

/**
 * The book as the sheet draws it — one Line per row, in reading order.
 *
 * EVERYTHING THAT DEPENDS ON THE ROW BEFORE IS DECIDED HERE, in one pass, and
 * not in the template: whether a paragraph is indented (the first of the book
 * and the first after a heading are not — print convention, §2), where a page
 * ghost belongs (only where the source page CHANGES), and which note opens a
 * page's group of them and so carries the hairline. A template asking those
 * questions per block would ask them again on every repaint.
 */
/**
 * WHICH CHARACTERS THE OPEN ANALYSIS LIGHTS, by block — empty when none is.
 *
 * NAMED `hitLight` AND NOT `lit`, because `lit` on this class is already the
 * note-marker coupling — which note number the pointer is resting on — and two
 * different lights on one component is exactly the collision a shorter name
 * would have hidden behind a compile error somebody fixed by renaming the
 * wrong one.
 *
 * A COMPUTED READ AND NOT A COPY, which is what keeps the paper and the panel
 * one thing: `AnalysisViewService.lit` is derived from one load of the report,
 * one placement over these very rows, and the tier the panel's buttons set, so
 * pressing Strict repaints the page and the list in one change-detection pass.
 *
 * IT IS NULL-SAFE BY CONSTRUCTION rather than by a guard here. The service
 * validates the open analysis against `StageService`, whose second column is a
 * union with the three clearing rules already in it — the document closed, the
 * project changed, the step deleted — so there is no state in this component
 * that could go stale and nothing here to clear.
 */
export function hitLight(this: BookViewComponent) {
  return computed<ReadonlyMap<string, readonly LitRange[]>>(() => {
  const lit = this.analysis.lit();
  const place = this.askLight();
  if (place === null) return lit;
  return new Map(lit).set(place.id, [place.range]);
});
}

/**
 * THE PLACE AN ASK RUN POINTED AT, when the person clicked it in the panel
 * (Owen, 2026-11-02) — drawn with the analysis light's own runs, on the live
 * pane of its book only, over the words it quoted or the whole block. It
 * takes that block's analysis light for as long as it is lit: one block, one
 * light, and the place is the thing just asked for.
 */
export function askLight(this: BookViewComponent) {
  return computed<{ id: string; range: LitRange } | null>(() => {
  const pointed = this.asks.pointed();
  if (pointed === null || this.atStep() !== null || pointed.projectDir !== this.tab().path) return null;
  const row = this.view()?.rows.find((one) => one.id === pointed.highlight.id);
  if (row === undefined || row.struck === true) return null;
  const quote = pointed.highlight.quote;
  const at = quote === null ? -1 : row.text.indexOf(quote);
  const start = at === -1 ? 0 : at;
  const end = at === -1 ? row.text.length : at + quote!.length;
  return { id: row.id, range: { start, end, key: pointed.key, category: 'ask' } };
});
}

/**
 * WHICH SIDE OF THE OPEN COMPARISON THIS PANE IS — or neither, which is
 * every pane nearly always.
 *
 * THE COMPARED PARTY is the pane locked to the compared step: `atStep` names
 * the row and the stage names the comparison, and they must agree, because a
 * compare column being rebuilt between two steps has, for a frame, a pane
 * about the row just left. THE LIVE PARTY is the ordinary pane (no `atStep`)
 * drawing the document in front of the person — the viewer only ever draws the
 * active one, but asking the stage rather than assuming it is what keeps this
 * true of the component and not of the way its host happens to be written.
 *
 * NULL WHEN THERE IS NO COMPARISON, so the live pane publishes nothing and
 * reads nothing on every ordinary day: the light is an apparatus a person
 * summons by opening the column, never a recolouring of the book.
 */
export function party(this: BookViewComponent) {
  return computed<'live' | 'compared' | null>(() => {
  const where = this.stage.compare();
  if (where === null) return null;
  const at = this.atStep();
  if (at !== null) return at === where.stepId ? 'compared' : null;
  return this.tab().id === this.stage.activeDocument()?.id ? 'live' : null;
});
}

/**
 * WHICH CHARACTERS OF WHICH BLOCKS CHANGED AGAINST THE OTHER COLUMN — this
 * side's half of the diff, empty for every pane that is not a party.
 *
 * `hitLight`'s twin, on its argument: one diff in the service, read as a
 * computed by both sheets, so the removal on one column and the addition on
 * the other are halves of the same alignment and cannot drift. Which half is
 * this pane's is the service's decision (`liveRanges`/`comparedRanges` —
 * the ledger says which side is older), never this component's.
 */
/**
 * ── THE ALIGNED PAIR'S OWN DIFF — what this pass did, lit on both sheets ────
 *
 * Owen, 2026-09-08, with the Aligned view open on a cleaned book: *"theres an
 * 'aligned' button at the top. i expected it to highlight the left and right
 * side of the aligned view so the user can see what changed on each side."*
 *
 * IT WAS BUILT AND THEN DELIBERATELY WITHHELD, which is the part worth
 * naming. Wave 57 lit the COMPARE column and left the aligned source sheet
 * dark on the reasoning that "the source sheet is a third book" — true of the
 * compare column, which draws some OTHER step, and false here: the aligned
 * pair is one pass's own two sides, the very rows it read on the left and the
 * very rows it wrote on the right, matched by block id in a single component.
 * There is no third book anywhere in it. So the light belongs here more
 * plainly than where it was first put.
 *
 * ONE DIFF, TWO HALVES, and the halves cannot drift because they come out of
 * one `wordDiff` per block: what the pass took out is drawn on the SOURCE
 * sheet, what it put in on the BENCH. Memoised on the pair of strings, so
 * scrolling, hovering a twin and every unrelated repaint cost a map lookup
 * rather than a diff of the book.
 *
 * ONLY WHILE THE PAIR IS DRAWN. `aligned()` is false in every other state and
 * this answers two empty maps, so a book nobody is comparing pays nothing.
 */
export function alignedMemo(this: BookViewComponent) {
  return new Map<string, { before: string; after: string; diff: WordDiff }>();
}

export function alignedDiff(this: BookViewComponent) {
  return computed<{
  removed: ReadonlyMap<string, readonly ChangeRange[]>;
  added: ReadonlyMap<string, readonly ChangeRange[]>;
}>(() => {
  if (!this.aligned()) return NO_ALIGNED_DIFF;
  const source = this.book()?.translation?.source ?? null;
  if (source === null || !source.ok) return NO_ALIGNED_DIFF;
  const after = this.view()?.rows ?? null;
  if (after === null) return NO_ALIGNED_DIFF;

  const before = new Map<string, string>();
  for (const row of source.rows) {
    if (row.shelf === undefined) before.set(row.id, row.text);
  }
  const removed = new Map<string, readonly ChangeRange[]>();
  const added = new Map<string, readonly ChangeRange[]>();
  const kept = new Map<string, { before: string; after: string; diff: WordDiff }>();
  for (const row of after) {
    /*
     * A STRUCK ROW IS NOT LIT, on `litRanges`' own rule: a strike is a
     * decision to remove and a highlight is an observation, and two marks
     * arguing about one paragraph is the outcome neither is worth.
     */
    if (row.shelf !== undefined || row.struck === true) continue;
    const was = before.get(row.id);
    // A block the pass INVENTED has no older side to have changed from, and a
    // string compare answers the ordinary case — most of a book — for free.
    if (was === undefined || was === row.text) continue;
    /*
     * FOLDED FIRST WHEN THE QUOTES ARE NOT THE QUESTION. The fold is one
     * character for one, so a range measured in the folded string lights the
     * same characters of the written one — see `foldQuotes`. The memo is
     * keyed on the strings THAT WERE DIFFED, so flipping the checkbox
     * recomputes rather than answering with the other question's ranges.
     */
    const lit = this.quoteFixes();
    const beforeText = lit ? was : foldQuotes(was);
    const afterText = lit ? row.text : foldQuotes(row.text);
    if (beforeText === afterText) continue;
    const held = this.alignedMemo.get(row.id);
    const diff = held !== undefined && held.before === beforeText && held.after === afterText
      ? held.diff
      : wordDiff(beforeText, afterText);
    kept.set(row.id, { before: beforeText, after: afterText, diff });
    if (diff.removed.length > 0) removed.set(row.id, diff.removed);
    if (diff.added.length > 0) added.set(row.id, diff.added);
  }
  this.alignedMemo = kept;
  return { removed, added };
});
}

export function changeLight(this: BookViewComponent) {
  return computed<ReadonlyMap<string, readonly ChangeRange[]>>(() => {
  /*
   * THE PAIR'S OWN DIFF WINS WHERE THERE IS ONE. Aligned, this sheet is the
   * pass's OUTPUT and the sheet beside it is the pass's INPUT — the closest
   * relationship two columns in this app can have — so what it lights is what
   * this pass did. The compare column's diff is about some other step and
   * answers everywhere else. Both can be true at once (a compared pane may
   * also be aligned); the nearer question is the one drawn.
   */
  const pair = this.alignedDiff();
  if (pair.added.size > 0) return pair.added;
  const party = this.party();
  if (party === null) return NO_CHANGE_MAP;
  return party === 'live' ? this.changes.liveRanges() : this.changes.comparedRanges();
});
}

/**
 * WHICH FINDING IS SELECTED — the key whose runs pulse, or null.
 *
 * Owen, 2026-08-25: *"have it pulse as long as it's selected."* NAMED
 * `chosenHit` and not `selected`, because `chosen` on this class is already the
 * BLOCK selection — the set of paragraphs a marquee caught — and the two are
 * different selections that must never be confused: clicking a highlight
 * selects its paragraph AND its finding, and letting go of one does not let go
 * of the other.
 *
 * A COMPUTED OVER THE SERVICE'S SIGNAL rather than state here, on `hitLight`'s
 * own argument: the panel draws the same selection on its card, and a copy on
 * this component would be a second opinion about which finding is lit.
 */
export function chosenHit(this: BookViewComponent) {
  return computed<string | null>(() => this.analysis.selected() ?? this.askLight()?.range.key ?? null);
}

export function lines(this: BookViewComponent) {
  return computed<Line[]>(() => {
  const book = this.book();
  const replayed = this.view();
  if (book === null || replayed === null) return [];
  // THE REPLAY'S LIST AND NOT THE HEADER'S — see `view`. The header's is the
  // seed the replay was handed; what comes back is the seed where no chapter op
  // has spoken and the ops' own list where one has, already filtered to the
  // divisions that sit above a block this book still flows.
  const chapters = new Map(replayed.chapters.map((chapter) => [chapter.id, chapter.title] as const));
  // The REPLAYED record of what is unlinked, not the file's: a text edit is the
  // one gesture that can point a note at nothing or a number at no note, and
  // `replayOps` is what re-derives both for the blocks it touched.
  const orphans = new Set(replayed.loose.notes);
  /*
   * A seam is drawn above its `before` block and carries the id of the block it
   * would be joined onto, because the ghost IS the join now. Which of the
   * header's seams can still be drawn is a question about the book AS THE OPS
   * LEFT IT rather than about the reading — a chain that has already joined one
   * of these turns has taken one of its halves out of the book — so it is asked
   * of the replayed rows (`seamJoins`, ./flow).
   */
  const seams = seamJoins(replayed.rows, book.seams);
  /*
   * THE APPARATUS READS AT THE END OF ITS CHAPTER, on the bench as in the
   * edition and the export — the user's ruling, applied by `chapterOrder`
   * (./flow), which reorders and drops nothing. The rows are cut into spans
   * at the replay's own divisions, so the panel and the paper cannot disagree
   * about where a chapter starts.
   */
  const ordered = chapterOrder(replayed.rows, (row) => ({
    category: row.category,
    opens: chapters.has(row.id),
  }));
  return linesOf(ordered, {
    printed: this.printed(),
    size: (category) => sizeOf(book, category),
    chapters,
    seams,
    orphans,
    chrome: true,
    /*
     * THE ANALYSIS'S LIGHT, FROM THE SAME PLACE THE PANEL'S ROWS COME FROM.
     * `AnalysisViewService` holds one load, one placement and one tier, and both
     * surfaces read computeds off them (docs/ANALYSIS.md §8) — so a highlighted
     * paragraph always has a row beside it and a row always has its paragraph
     * lit. It answers an empty map whenever no analysis is open, which is what
     * makes the highlights an apparatus rather than a recolouring.
     *
     * ONLY THE LIVE COLUMN, and that falls out rather than being asked for: this
     * computed is the live sheet's, and a compare column cannot be up at the
     * same time as the panel because the stage holds one second column
     * (`SecondColumn`, core/stage.service.ts).
     */
    lit: this.hitLight(),
    /*
     * AND THE COMPARISON'S, on the same terms and through the same walk — this
     * pane's half of the diff, or nothing. Both parties' sheets go through
     * this computed (the compare column's pane is this very component with
     * `atStep` set), which is what puts the removals on one column and the
     * additions on the other out of one `linesOf`.
     */
    changes: this.changeLight(),
  });
});
}

/**
 * THE LEFT-HAND COLUMN — the source this translation was made from, as lines.
 *
 * ── The same builder, with the instrument switched off ─────────────────────
 *
 * The rows come from main in one answer beside the translated ones
 * (`BookTranslation.source`), and they go through the identical pass the live
 * sheet's do — the same element per category, the same measured size, the same
 * `cut` at the same resolved offsets. That is not a convenience: two columns
 * whose typography was decided in two places would drift a line apart somewhere
 * in the middle of a four-hundred-page book, and the scroll lock would be tying
 * rows of different heights together and calling it aligned.
 *
 * WHAT IS SWITCHED OFF IS EVERYTHING A PERSON COULD ACT ON. No chapter rules or
 * chips, no ordinals, no page ghosts, no amber flags, no seam ghosts — *"chrome
 * only on the live column"*. `chrome: false` is what says so, once, rather than
 * six empty collections that would each have to be kept empty.
 *
 * THE MARKERS ARE STILL CUT, and only the source has any. A translated row
 * carries `refs: []` — nothing recovers where a note number falls inside a
 * sentence somebody else wrote (`translated`, shared/materialize.ts) — so the
 * numbers on the left are the apparatus as the page printed it, drawn demoted
 * (`plain`), with no jump and no coupling, because this sheet is not a reader.
 *
 * NOTHING IS STRUCK HERE, and nothing has to be made not to be: main
 * materialises these rows, and a materialised book has its struck rows already
 * absent (docs/RENDERER.md §4).
 */
export function sourceLines(this: BookViewComponent) {
  return computed<Line[]>(() => {
  const book = this.book();
  const source = book?.translation?.source ?? null;
  if (book === null || source === null || !source.ok) return [];
  /*
   * The markers, gathered by the block they were PRINTED in — `printed`'s own
   * inversion, over these rows. LOOSE ONES ARE NOT HERE and are not missing:
   * a stray number with no note under it is a FLAG, this column draws none, and
   * the header that records them is not carried across (rows only, see
   * `BookTranslation.source`). What that costs is one superscript on the left
   * left as ordinary characters in the words, which is what it is.
   */
  const printed = new Map<string, Marker[]>();
  for (const row of source.rows) {
    for (const ref of row.refs ?? []) {
      const already = printed.get(ref.block);
      const marker: Marker = { at: ref.at, len: ref.len, note: row.id, struck: false };
      if (already === undefined) printed.set(ref.block, [marker]);
      else already.push(marker);
    }
  }
  for (const markers of printed.values()) markers.sort((one, other) => one.at - other.at);
  /*
   * ORDERED WITH THE SAME DIVISIONS AS THE LIVE COLUMN, which is load-bearing
   * for the scroll lock: `sharedAnchor` assumes the two columns hold their
   * shared ids in the same order, and a left column still in page order beside
   * a right column in chapter order would anchor a reader onto the wrong
   * paragraph. The division ids are shared between the files by construction
   * (parent ids kept verbatim, docs/RENDERER.md §4).
   */
  const divisions = new Set((this.view()?.chapters ?? []).map((chapter) => chapter.id));
  const ordered = chapterOrder(source.rows, (row) => ({
    category: row.category,
    opens: divisions.has(row.id),
  }));
  return linesOf(ordered, {
    printed,
    // The parent's measurements, which are also this book's: a translation
    // carries its source's typography verbatim, because translating the words
    // did not change what size the type was set in on the page.
    size: (category) => sizeOf(book, category),
    chapters: new Map(),
    seams: new Map(),
    orphans: new Set(),
    chrome: false,
    /*
     * NOTHING IS LIT ON THE CONTEXT SHEET, on the same rule that switches every
     * other instrument off here: *"chrome only on the live column"*. A report is
     * measured against the position's own book and its offsets are that book's;
     * the left column is the SOURCE those words were translated from, a
     * different file with different sentences at different offsets, and lighting
     * it from this report would put the marker pen on words nobody measured.
     */
    lit: new Map(),
    /*
     * AND WHAT THIS PASS TOOK OUT, which is the half of the diff this sheet
     * owns. It was `NO_CHANGE_MAP` on the reasoning that the source sheet is a
     * third book — true of the compare column and false of this pair, which is
     * one pass's own two sides (`alignedDiff`, where Owen's ruling is quoted).
     */
    changes: this.alignedDiff().removed,
  });
});
}

/**
 * What the context sheet says about itself — where source edits live.
 *
 * *"Source edits invalidate that block's records."* (docs/RENDERER.md §5.) That
 * is already true by construction and upstream of this pane: the translator's
 * cost cache is keyed on the masked SOURCE text, so changing a word above the
 * translation changes the question and a re-run answers it fresh. What this
 * sheet has to say is therefore not a refusal but a direction — the words are
 * editable, one step up, and this is where they were read from.
 *
 * AND IT NAMES THE ACT THAT WAS ORDERED. Every sentence here used to say
 * "translation" because a simplify IS a translate step and this pane could not
 * see the difference — so a person who had pressed Simplify hovered their own
 * source column and was told their book had been translated. `pass` is the noun,
 * off the step's own `rewrite` (`BookTranslation.rewrite`), and it is the same
 * field the rail's row is printed from.
 */
export function sourceTitle(this: BookViewComponent) {
  return computed<string>(() => {
  /*
   * A SIMPLIFY SAYS THE MODE AND NEVER SAYS A LANGUAGE, which is `labelFor`'s
   * own ruling about the same act (shared/ledger.ts): a rewrite happens IN the
   * book's own language, so the tag is not what tells one from another — the
   * three modes are, and the mode is what somebody who pressed Simplify is
   * looking at when they hover the column they wrote it from.
   */
  const rewrite = this.translation()?.rewrite;
  if (rewrite !== undefined) {
    return `The book this simplification — ${REWRITE_LABELS[rewrite]} — was made from. To change `
      + 'these words, stand on the step above the simplification and edit them there; simplifying '
      + 'again answers with the new ones.';
  }
  const language = this.book()?.translation?.language ?? '';
  return language.length === 0
    ? 'The book this translation was made from. To change these words, stand on the step above '
      + 'the translation and edit them there; translating again answers with the new ones.'
    : `The book this translation into ${language} was made from. To change these words, stand on `
      + 'the step above the translation and edit them there; translating again answers with the '
      + 'new ones.';
});
}

/**
 * THE SAME BOOK, PROJECTED THROUGH THE EXPORT'S RULES — the edition.
 *
 * ── One list, folded again, exactly like everything else here ───────────────
 *
 * This is `lines()` with a pure function over it and nothing more: no second
 * replay, no second load, no engine (docs/RENDERER.md §5 — *"a toggle, not a
 * build"*). Every field the bench uses to draw an instrument mark is put to
 * null on the way through, so the marks are not merely hidden by CSS — the
 * ordinals, page ghosts, amber flags, seam ghosts and division rules are not
 * in the DOM of an edition at all, which is the difference between a page with
 * its chrome turned down and a page that never had any.
 *
 * WHAT MOVES IS THE APPARATUS, and that decision is `editionFlow`'s
 * (./edition), where a script can exercise it. What is left out of the prose is
 * `editionPieces`'s: the reference numbers of notes that are not in this book.
 *
 * THE SIZES ARE NOT TOUCHED. `line.size` is already the measured ratio for its
 * category, and the measured ratios are the EXPORT'S — `dotsStylesheet` writes
 * the very same numbers into the cast's own sheet as `font-size: <ratio>em`
 * rules for `.footnotes`, `p.caption`, `blockquote p`, `h1` and `h2`
 * (src/vlm/dots-book.ts). There is nothing to convert; the bench was always
 * setting the book in the export's type.
 */
export function editionLines(this: BookViewComponent) {
  return computed<Line[]>(() => editionFlow(
  this.lines(),
  (line) => ({
    category: line.row.category,
    chapter: line.chapter,
    struck: line.row.struck === true,
  }),
).map((place) => ({
  ...place.row,
  pieces: editionPieces(place.row.pieces),
  heading: place.heading,
  opens: place.opens,
  opensNotes: place.opensNotes,
  indent: place.indent,
  // The bench's marks, absent rather than quiet — see the docblock.
  chapter: null,
  ordinal: null,
  ghost: null,
  flag: null,
  seamInto: null,
  jump: null,
})));
}
