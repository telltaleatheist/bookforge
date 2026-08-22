/**
 * shared/materialize — THE REPLAY, WRITTEN DOWN AS A BOOK.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
 * §6.) The renderer draws `replayOps(rows, chain)` as a signal; an export needs
 * the same answer as a FILE, because the thing that turns a book into an EPUB is
 * a separate program and the only language it and this app both speak is the book
 * file (docs/BOOK-FILE.md). So this takes the book the reading produced and the
 * ops that were applied to it, and writes the same format back out: same version,
 * same ids, parent ids kept verbatim (§4), struck rows absent, text as the person
 * left it.
 *
 * IT IS PURE, and that is the whole reason it is in shared/ rather than in
 * electron/. It touches no disk, no clock and no Electron; what is in electron/ is
 * the ten lines that read the files and write the answer atomically. A test — and
 * a script — can hand it rows and ops and read the book that comes out.
 *
 * ── THE DERIVED FILE IS THE FINISHED DOCUMENT ───────────────────────────────
 *
 * Which is a stronger statement than "the same book with edits in it", and three
 * of the decisions below follow from it and from nothing else:
 *
 * A STRUCK ROW IS NOT IN IT. Struck is a state of the working document — drawn
 * cancelled, brought back by pressing Delete again — and an edition leaves it out
 * (docs/RENDERER.md §5). The compile therefore never has to know what a strike is.
 *
 * THE SHELF IS NOT IN IT EITHER. A shelved row is out of the flow by the reflow's
 * judgement and stays out unless somebody restores it, which is an op that puts it
 * back in the flow before this ever sees it (`restore-furniture`). Carrying the
 * shelf into a derived file would carry a decision the reader of that file has no
 * ops to act on.
 *
 * AND A STRUCK NOTE TAKES ITS REFERENCE NUMBER WITH IT. *"if i delete footnotes,
 * it removes their corresponding reference numbers."* (§0, ruling 9.) The number
 * belongs to the note, so it goes when the note goes — as a DERIVED FACT computed
 * here, never as a second op recorded beside the first (§2), which is why
 * restoring the note brings the number back for free: the strike is gone from the
 * chain, so this cut never happens. The characters come out of the body text and
 * everything that pointed past them — the other notes' refs, the unlinked markers,
 * the parts that say which banked answer contributed which characters — is moved
 * by exactly as much as was removed.
 *
 * ── AND WHAT IT REFUSES TO PRETEND ABOUT ────────────────────────────────────
 *
 * `parts` on a row somebody restructured is stale by construction (`ReplayedRow`,
 * shared/ops.ts): the ranges claim to tile the row's text and stop doing so the
 * moment a merge concatenates two of them or a split cuts one in half. A book file
 * whose parts do not tile is not a book file — both parsers prove that claim
 * rather than trusting it — so it cannot simply be carried, and there is no
 * arithmetic that recovers the true division of words a person retyped. See
 * `partsFor` for what is written instead, and why it is the only honest thing
 * left to say.
 */
import type {
  BookChapter,
  BookFile,
  BookLoose,
  BookLooseMarker,
  BookPart,
  BookRef,
  BookRow,
} from './book';
import { replayOps, type BookOp, type MissingOp, type ReplayedRow } from './ops';

/** The derived book, and what the chain could not do to it. */
export interface Materialized {
  book: BookFile;
  /**
   * Ops the replay could not perform — carried out, never swallowed.
   *
   * REPORTED AND NOT FATAL, which is `Replayed.missing`'s own ruling: a chain can
   * name a block a later reading no longer has, and refusing to export somebody's
   * book over one stale strike would be the worst of the three available answers.
   * The caller says the number out loud where somebody can see it.
   */
  missing: MissingOp[];
}

/** A run of characters coming out of a body row — a struck note's number. */
interface Cut {
  at: number;
  len: number;
}

/**
 * Where an offset in the old text lands in the new one, after the cuts.
 *
 * MONOTONE AND EXACT: everything before the offset that was removed is subtracted
 * from it, so a position inside a cut collapses onto the seam and a position after
 * one moves by the whole of what came out. Nothing that reaches this is inside a
 * cut — two reference numbers cannot claim the same characters, which the book
 * file's own parser proves — so every offset it is asked about is a real position
 * in the text that survives.
 */
function mapped(at: number, cuts: readonly Cut[]): number {
  let moved = at;
  for (const cut of cuts) {
    if (cut.at >= at) break;
    moved -= Math.min(at, cut.at + cut.len) - cut.at;
  }
  return moved;
}

/** The text with those runs taken out. */
function cutText(text: string, cuts: readonly Cut[]): string {
  const kept: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    kept.push(text.slice(from, cut.at));
    from = cut.at + cut.len;
  }
  kept.push(text.slice(from));
  return kept.join('');
}

/**
 * The parts a derived row carries.
 *
 * ── A ROW NOBODY EDITED KEEPS THE ENGINE'S OWN ANSWER, VERBATIM ─────────────
 *
 * Which is most of the book, and it matters more than it looks: those ranges were
 * worked out at reflow with the pages in front of the writer, and re-deriving them
 * here would replace the engine's answer with this one for no reason at all.
 *
 * ── A ROW SOMEBODY EDITED SAYS THE ONE THING THAT IS STILL TRUE ─────────────
 *
 * `chars` is a claim about ANOTHER field of the same row — these characters of
 * this text came from that banked answer — and a merge, a split or a retype makes
 * that claim false in a way no arithmetic can repair: the true division of a
 * sentence somebody rewrote is not a fact anybody holds. The format has three
 * spellings available and two of them are lies. Keeping the old ranges is a lie
 * with a number in front of it, and both parsers refuse it outright. Dividing the
 * new text between the old parts in proportion is the same lie with arithmetic in
 * front of it, which the book file's own header names as the thing never to do.
 *
 * So a restructured row carries ONE part, naming where the row STARTED — the same
 * answer the format already gives its `page` and its `box`, and the same one the
 * engine gives a merged block, whose id is minted from its first part and never
 * from the one it swallowed. The other coordinates are not lost by this: the row a
 * merge consumed is not a row of this document any more, and its own name is the
 * only thing anything downstream could have re-keyed through it.
 */
function partsFor(row: BookRow, edited: boolean): BookPart[] {
  const first = row.parts[0];
  if (first === undefined) {
    // Unreachable through the parser, which refuses a row with no parts, and
    // asserted rather than assumed because this is the one function that would
    // otherwise write a book file that cannot be read back.
    throw new Error(`block "${row.id}" carries no parts, so there is nothing to say it came from`);
  }
  if (!edited) return row.parts;
  return [{ src: first.src, page: first.page, chars: [0, row.text.length] }];
}

/** The parts, moved by the cuts — see `mapped`. Ranges still tile, and may empty. */
function cutParts(parts: readonly BookPart[], cuts: readonly Cut[]): BookPart[] {
  return parts.map((part) => ({
    ...part,
    chars: [mapped(part.chars[0], cuts), mapped(part.chars[1], cuts)] as [number, number],
  }));
}

/**
 * The divisions, each re-hung on the first row of it that survived.
 *
 * A chapter rule anchored to a struck block used to leave WITH the block, and
 * the rule's title — the name somebody typed, the entry the spine and the nav
 * are built from — went silently with it. That contradicts the surface the
 * person was looking at: the edition register reads a division BEFORE the drop
 * and lands it above the next surviving block (`edition.ts`, "What is absent,
 * and what a division does about it"), so striking a printed chapter title
 * showed a book still divided and named, and the export then compiled one
 * chapter called nothing. The book file now says what the sheet shows: the
 * division moves forward to the first held row after its anchor, in flow
 * order, keyed to it.
 *
 * A division nothing survives under — every row from its anchor to the next
 * division struck — is not re-hung past its own span: it would land on the
 * NEXT chapter's opening and the book would say two chapters start there. It
 * is dropped, which is the edition's own rule ("a division with nothing
 * surviving under it is not a chapter the finished book has").
 */
function rehungChapters(
  chapters: readonly BookChapter[],
  flow: readonly ReplayedRow[],
  held: ReadonlySet<string>,
): BookChapter[] {
  const at = new Map(flow.map((row, index) => [row.id, index] as const));
  const opens = new Set(chapters.map((chapter) => chapter.id));
  const rehung: BookChapter[] = [];
  for (const chapter of chapters) {
    if (held.has(chapter.id)) {
      rehung.push(chapter);
      continue;
    }
    const start = at.get(chapter.id);
    if (start === undefined) continue;
    for (let index = start + 1; index < flow.length; index += 1) {
      const row = flow[index]!;
      // The next division's block ends this one's span: nothing of this
      // chapter survived, and re-hanging past the boundary would stack two
      // divisions on one block.
      if (opens.has(row.id)) break;
      if (!held.has(row.id)) continue;
      rehung.push({ ...chapter, id: row.id });
      break;
    }
  }
  return rehung;
}

/**
 * The book, with a chain replayed into it and written as the finished document.
 *
 * The order below is the whole of the correctness: the replay first, because
 * every other question is about the book AS IT NOW STANDS; then which rows survive
 * it; then the reference numbers of the notes that did not, because those come out
 * of text the rows that DID survive are made of; and only then the header, whose
 * every list has to name rows this file actually holds.
 */
export function materialize(book: BookFile, ops: readonly BookOp[]): Materialized {
  const replayed = replayOps(book.rows, ops, book.header.loose, book.header.chapters);
  const kept: ReplayedRow[] = replayed.rows.filter(
    (row) => row.struck !== true && row.shelf === undefined,
  );
  const held = new Set(kept.map((row) => row.id));
  /** The file's own words for each id — what "somebody edited this" is measured against. */
  const before = new Map(book.rows.map((row) => [row.id, row.text] as const));

  /*
   * THE NUMBERS OF THE NOTES THAT ARE NOT IN THIS BOOK, gathered off the rows the
   * replay struck. A struck note's `refs` are still exactly where they were —
   * striking a note does not edit the paragraph its number is printed in — so this
   * is the last moment those coordinates are true, and it is where the cut has to
   * be made.
   */
  const cuts = new Map<string, Cut[]>();
  for (const row of replayed.rows) {
    if (row.struck !== true) continue;
    for (const ref of row.refs ?? []) {
      if (!held.has(ref.block)) continue;
      const already = cuts.get(ref.block);
      if (already === undefined) cuts.set(ref.block, [{ at: ref.at, len: ref.len }]);
      else already.push({ at: ref.at, len: ref.len });
    }
  }
  /*
   * AND EVERY LOOSE MARKER GOES WITH THEM — Owen's ruling, 2026-08-22,
   * verbatim: *"i want to make sure the final footnote number doesnt make it
   * to the epub if it isnt linked to a footnote thats present… i want to
   * verify im not going to send the epub to tts and hear a bunch of numbers
   * read out every other sentence."*
   *
   * Measured on his own Streicher export before this was written: 274 bare
   * <sup> numbers in the finished EPUB, zero linked noterefs, and the book
   * file's loose.markers held exactly those 274 — a book whose notes are
   * ENDNOTES AT THE BACK, so the page-complete note model matched nothing
   * and every printed number sailed through as literal text a narrator
   * would read aloud.
   *
   * A loose marker is a run the recogniser identified as a note number and
   * matched to no note. In the WORKING document it is a flag in the margin,
   * kept so a person can hand-link it ({op:'link'} — a replayed link has
   * already moved a marker out of loose before this runs, so a linked one is
   * a ref and is kept). In the EDITION it is a number pointing at nothing,
   * and this file's own standard applies: the derived file is the finished
   * document. Cut through the same machinery as a struck note's number, so
   * every offset behind it — real refs, other markers' records, parts —
   * moves by exactly what came out. THE FACSIMILE IS UNTOUCHED, as ever:
   * page-faithful is what a facsimile is for, and it forks before this.
   */
  for (const marker of replayed.loose.markers) {
    if (!held.has(marker.block)) continue;
    const already = cuts.get(marker.block);
    if (already === undefined) cuts.set(marker.block, [{ at: marker.at, len: marker.len }]);
    else already.push({ at: marker.at, len: marker.len });
  }
  for (const runs of cuts.values()) runs.sort((one, other) => one.at - other.at);

  const rows: BookRow[] = [];
  for (const row of kept) {
    const runs = cuts.get(row.id) ?? [];
    const edited = before.get(row.id) !== row.text;
    const parts = partsFor(row, edited);
    /*
     * `struck` IS NOT A FIELD OF THIS FORMAT and never becomes one. It is the
     * replay's own answer about a row of the working document, and every row that
     * reaches here is one nobody struck — so the field is dropped rather than
     * written as false, which would put a state into a file whose whole claim is
     * that the decisions live somewhere else.
     */
    const { struck: _struck, ...carried } = row;
    if (runs.length === 0) {
      rows.push(parts === row.parts ? carried : { ...carried, parts });
      continue;
    }
    rows.push({ ...carried, text: cutText(row.text, runs), parts: cutParts(parts, runs) });
  }

  /*
   * EVERY REFERENCE THIS BOOK STILL CARRIES, moved to where its characters now
   * are — and dropped where the block it named is not in the book at all, which is
   * what striking a whole paragraph does to the numbers printed in it. A note left
   * pointing at nothing is not an error: it is one of the two LINKING flags, and
   * it goes in the header where a reader can be told about it.
   */
  const orphaned: string[] = [];
  const derived: BookRow[] = rows.map((row) => {
    if (row.refs === undefined) return row;
    const refs: BookRef[] = [];
    for (const ref of row.refs) {
      if (!held.has(ref.block)) continue;
      const runs = cuts.get(ref.block);
      refs.push(runs === undefined ? ref : { ...ref, at: mapped(ref.at, runs) });
    }
    if (refs.length === 0) orphaned.push(row.id);
    return { ...row, refs };
  });

  /*
   * NO LOOSE MARKER SURVIVES INTO THE DERIVED FILE, by construction: every
   * one on a held block was cut out of the text above (Owen's ruling — an
   * unlinked number must not reach the edition), so a record pointing at its
   * own seam would be a coordinate about characters that are not there. The
   * loose NOTES stay: a note nothing points at is still words a reader can
   * read, and orphaning is the flag the header exists to carry.
   */
  const markers: BookLooseMarker[] = [];
  const loose: BookLoose = {
    markers,
    notes: [...new Set([...replayed.loose.notes.filter((id) => held.has(id)), ...orphaned])],
  };

  return {
    book: {
      header: {
        // THE ENGINE THAT WROTE THE PARENT, carried and not restamped. This file
        // is a materialisation of that reflow rather than a new reading of the
        // pages, and provenance is a fact about where the words came from.
        engine: book.header.engine,
        language: book.header.language,
        // The receipt this book is a pure function of, verbatim — including its
        // sha, which still identifies the bank underneath every id in the file.
        source: book.header.source,
        /*
         * AND WHAT BECAME OF THE PICTURES, VERBATIM TOO. A derived book's Picture
         * rows name the parent's crops, in the parent's own images directory,
         * because replaying an op moved no pixels. So the parent's marker is a
         * true statement about this file, and DROPPING it would say something
         * false in the other direction: absent means "an engine older than the
         * marker wrote this" (`BookFigures`, shared/book.ts), which would send the
         * ensure step off to read the rows of a book it could not have healed
         * anyway. Absent in the parent stays absent here.
         */
        ...(book.header.figures !== undefined ? { figures: book.header.figures } : {}),
        chapters: rehungChapters(replayed.chapters, replayed.rows, held),
        typography: book.header.typography,
        /*
         * A DERIVED FILE'S SEAMS ARE SPENT DECISIONS. A seam is an offer to join
         * two paragraphs the reflow declined to join, made to a person with the
         * ops to act on it; by the time a book is being compiled the offer has
         * either been taken (there is a merge in the chain and the two rows are
         * one) or declined by silence. Carrying the list into a document nobody
         * can edit would be an invitation with no door behind it.
         */
        seams: [],
        loose,
      },
      rows: derived,
    },
    missing: replayed.missing,
  };
}

/**
 * The heading label a title is a copy OF — the engine's own fold, mirrored.
 *
 * A chapter opening is routinely two boxes, the number on one line and the name
 * on the next, and the seed's title is those lines joined with a separator the
 * printer never set (`headingLabel`, src/vlm/dots-book.ts, which owns the whole
 * argument for the colon). Mirrored here rather than approximated because this is
 * the string a title has to be compared against to prove it IS one, and a
 * comparison against a different normalisation would prove nothing about
 * anything — on `shared/book.ts`'s grow-together rule.
 */
const ALREADY_PUNCTUATED = /[.,:;!?…—–-]$/;

function headingLabel(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return text.trim();
  return lines.reduce((joined, line) =>
    `${joined}${ALREADY_PUNCTUATED.test(joined) ? ' ' : ': '}${line}`);
}

/** A derived book in another language, and everything it could not carry. */
export interface Translated {
  book: BookFile;
  /**
   * Flowing rows this translation answers nothing for, by id.
   *
   * REPORTED, AND THEIR SOURCE TEXT KEPT, which is the established rule for a
   * position with no record and not a decision taken here: *"A POSITION WITH NO
   * RECORD KEEPS ITS SOURCE TEXT. A partial translation is rendered honestly —
   * the blocks that came back are in the target language and the blocks that did
   * not are in the book exactly as it was read"* (`buildChapterBody`'s `worded`,
   * src/vlm/dots-book.ts). What is new is only that the ids are SAID: the cast
   * route dropped through a `??` in silence, and this side already names every op
   * a replay could not perform (`Materialized.missing`), so a book that comes out
   * with forty paragraphs still in German says which forty.
   */
  untranslated: string[];
  /**
   * Chapter titles left in the source language, by the id of the division — a
   * title that could not be PROVEN to be a copy of a heading this translation
   * answers for. See `titledFrom`.
   */
  untitled: string[];
}

/**
 * Which row a chapter's title was taken from, when it can be proved.
 *
 * `relabelNav`'s rule (src/translate/run.ts), which is the house's standing
 * answer to this exact question one format over: *"a label is replaced only where
 * it can be PROVEN to be a copy… the label reads exactly as that heading's own
 * text did before translation. Then the translated heading is already the right
 * answer and no second question is asked. Anything else is LEFT IN THE SOURCE
 * LANGUAGE and counted, because a guess here is a guess that ships in the one
 * part of the book everybody reads first."*
 *
 * The seed's own rule is what makes the proof available: a chapter title is
 * `sectionName`'s answer over the division's span — the first Title or
 * Section-header in it, folded by `headingLabel` — or, where the span has no
 * heading at all, a label from the page classifier, which is not a row and can
 * therefore never be proved to be a copy of one. So this looks in the same place
 * and compares the same string.
 */
function titledFrom(
  chapter: BookChapter,
  rows: readonly BookRow[],
  starts: ReadonlyMap<string, number>,
  nextStart: number,
): BookRow | null {
  const from = starts.get(chapter.id);
  if (from === undefined) return null;
  for (const row of rows.slice(from, nextStart)) {
    if (row.category !== 'Title' && row.category !== 'Section-header') continue;
    return headingLabel(row.text) === chapter.title ? row : null;
  }
  return null;
}

/**
 * THE DERIVED BOOK IN THE TARGET LANGUAGE — §4, and the second half of what a
 * transform's landing produces.
 *
 * *"When a translate lands, main materializes parent book file + chain ops +
 * records → readings/<key>.<lang>.book.jsonl — same format, parent ids kept
 * verbatim, struck rows absent, text replaced from records."* (docs/RENDERER.md
 * §4.) `materialize` above is the first two terms; this is the third. They are
 * separate functions because they are separate transformations of one document
 * and each is a whole argument of its own — and because the first is what every
 * export already goes through, unchanged by this existing.
 *
 * IDS ARE NOT TOUCHED, WHICH IS THE POINT. A translated row is the same block as
 * the row it was translated from, wearing different words, so the aligned view is
 * two files with one set of names and a strike on either side is the same op
 * (§5). Boxes, pages, parts and categories are the parent's for the same reason:
 * they are facts about the PAGE the words were printed on, and translating the
 * words did not move the ink.
 *
 * ── WHAT A TRANSLATED FILE CANNOT SAY, AND THEREFORE DOES NOT ───────────────
 *
 * `refs` AND `loose` COME OUT EMPTY. A ref is a character range inside another
 * row's text — *"AN OFFSET AND A LENGTH, NOT A STRING TO SEARCH FOR"* — resolved
 * by the engine at reflow with the page in front of it. Those offsets address the
 * SOURCE string. Nothing in a translation stands at the same character position
 * as anything in its source, and there is no arithmetic that maps one onto the
 * other: a model rewrote the sentence, and where the fourteenth note's number now
 * falls in it is not a fact anybody holds. The three available spellings are
 * therefore a lie with a number in front of it (carry the offsets), a lie with a
 * search in front of it (find the digits again, which lands on whichever
 * occurrence came first — the failure `compile.ts` refuses by name), and silence.
 * Silence is the only true one, and it costs less than it looks: the parent file
 * still holds every ref, keyed by the ids this file keeps verbatim, so the
 * apparatus is one short hop away for anything that wants it — and the reference
 * NUMBERS are still in the prose, because they are Unicode superscript runs in
 * the text and the model is asked to place them (`textmask.ts`). `compile.ts`
 * draws a run no note claims as the plain `<sup>` the emitter gives an unmatched
 * marker: no link beats a wrong one. An aligned apparatus is a later wave's;
 * until it lands, this file says nothing rather than something false.
 *
 * `seams` IS ALREADY EMPTY on everything `materialize` writes, and the argument
 * there covers this one whole: a seam is an offer to join two paragraphs, made to
 * somebody holding the ops to act on it.
 */
export function translated(
  book: BookFile,
  /** Block id → its translation. `shared/records.ts` resolves the file to this. */
  words: ReadonlyMap<string, string>,
  /** The language the words are IN — the transform's target, stated by the app. */
  language: string,
): Translated {
  const untranslated: string[] = [];
  const rows = book.rows.map((row) => {
    const said = words.get(row.id);
    /*
     * A SHELVED ROW IS NOT ASKED FOR AND IS NOT COUNTED AS MISSING. It is out of
     * the flow, so nothing translated it and nothing should have — and in a book
     * `materialize` produced there are none at all, which makes this a guard
     * about the format rather than a branch anything reaches today.
     */
    if (said === undefined) {
      /*
       * A ROW WITH NO WORDS IN IT IS NOT A MISSING TRANSLATION. A Picture row's
       * text is the empty string — the picture is the row — and the transform
       * writes no record for a block it found nothing to ask about ("IN RECORDS
       * MODE A WORDLESS BLOCK GETS NO ROW AT ALL", src/translate/run.ts). Counting
       * those would put every figure in the book on a list a person is meant to
       * read as "these came back in the source language".
       */
      if (row.shelf === undefined && row.text.trim().length > 0) untranslated.push(row.id);
      return row.refs === undefined ? row : { ...row, refs: [] };
    }
    /*
     * AND ITS PARTS COLLAPSE TO ONE, through `partsFor` — the same rule, and the
     * same function, that a row somebody retyped goes through above.
     *
     * `chars` is a claim about ANOTHER field of the same row: these characters of
     * this text came from that banked answer. A translation makes that claim false
     * in the sharpest way the format admits — the ranges no longer even TILE the
     * text, which both parsers prove rather than trust, so a file that carried
     * them would not be a book file at all. And nothing recovers the true division
     * of a translated sentence between two banked answers: where the German that
     * came from page 12 ends inside an English paragraph is not a fact anybody
     * holds. So the row says the one thing that is still true, which is where it
     * STARTED.
     */
    const next = row.refs === undefined
      ? { ...row, text: said }
      : { ...row, text: said, refs: [] };
    return { ...next, parts: partsFor(next, true) };
  });

  /*
   * THE PROOF IS AGAINST THE BOOK AS IT CAME IN, and that is the whole of what
   * makes it a proof. A title is a copy of a heading's SOURCE text — that is what
   * the seed wrote — so comparing it against the row above, whose words have just
   * been replaced, would ask whether an English title is a copy of a German
   * heading and answer no every time. The rows are the same rows in the same
   * order, so the id found here is the id looked up in `words`.
   */
  const starts = new Map<string, number>();
  for (const [index, row] of book.rows.entries()) starts.set(row.id, index);
  const untitled: string[] = [];
  const chapters = book.header.chapters.map((chapter, which) => {
    const next = book.header.chapters[which + 1];
    const at = next === undefined ? book.rows.length : starts.get(next.id) ?? book.rows.length;
    const heading = titledFrom(chapter, book.rows, starts, at);
    const said = heading === null ? undefined : words.get(heading.id);
    if (said === undefined) { untitled.push(chapter.id); return chapter; }
    return { ...chapter, title: headingLabel(said) };
  });

  return {
    book: {
      header: {
        // The engine that wrote the parent, carried and not restamped — this is a
        // materialisation of that reflow, and provenance is a fact about where the
        // words came from. `materialize` above makes the same choice, in full.
        engine: book.header.engine,
        /*
         * AND THE ONE FIELD THAT IS NOT THE PARENT'S. The header's `language` is
         * *"the read's declared language. Declared, never detected."* — and it is
         * declared here by the app, which is the only party that knows it: the
         * person asked for this language, the ledger recorded it on the step, and
         * nothing reads a language out of a file of sentences (`planTranslation`).
         * It is what `vlm-compile` writes as `dc:language` and onto every
         * chapter's `xml:lang`, which is the whole reason a translated book must
         * carry it — a document declaring the wrong language hyphenates by the
         * wrong rules and reads aloud in the wrong voice.
         */
        language,
        // The receipt is still the parent's, sha and all. The bank underneath did
        // not move because somebody translated the words that came out of it, and
        // a loader standing at this position checks that sha against that bank,
        // which is exactly the check that should still pass here.
        source: book.header.source,
        // And the figures are the parent's crops under the parent's names, for
        // the same reason and with the same consequence — see `materialize`.
        ...(book.header.figures !== undefined ? { figures: book.header.figures } : {}),
        chapters,
        // Measured off the boxes, and the boxes are the parent's: this says what
        // size the type was set in on the page, which translating did not change.
        typography: book.header.typography,
        seams: [],
        loose: { markers: [], notes: [] },
      },
      rows,
    },
    untranslated,
    untitled,
  };
}
