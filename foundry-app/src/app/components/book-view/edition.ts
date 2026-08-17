/**
 * THE EDITION — the same replay, projected through the export's own rules, and
 * the one real decision in that projection made where a script can reach it.
 *
 * ── What the edition IS ─────────────────────────────────────────────────────
 *
 * *"Edition — the export preview. The same replay with ALL chrome removed and
 * the export stylesheet applied: struck blocks absent, refs demoted, measured
 * typography. It should feel like the finished book because it is exactly the
 * finished book."* (docs/RENDERER-DESIGN.md §0.) It is a TOGGLE AND NOT A BUILD:
 * *"nothing is written, no engine spawns"* (docs/RENDERER.md §5), so everything
 * below is a pure function over the list the sheet is already drawing.
 *
 * ── WHY THE PLACEMENT IS THE PART THAT NEEDED A FILE ────────────────────────
 *
 * Almost every export rule is a matter of what to leave out, and leaving a mark
 * out is a CSS selector under one host class. Exactly one rule MOVES BLOCKS, and
 * it is the emitter's own: a footnote is skipped where the prose reaches it and
 * the whole apparatus is written at the end of the chapter —
 * `case 'Footnote': break; // Already in `notes`, held back to the end of the
 * chapter` (src/vlm/dots-book.ts), and then, once the body is closed,
 * `<section class="footnotes"><hr/>` and one `<aside>` per note. That is a
 * reordering of the book, it is the only one the edition performs, and a
 * reordering that lives inside a template is a reordering nobody can check. So
 * it lives here, beside `flow.ts`, for `flow.ts`'s own stated reason: a guard
 * that cannot be exercised on its own is a guard nobody checks.
 *
 * ── The rules transcribed here, and where they come from ────────────────────
 *
 * `src/vlm/dots-book.ts` is the engine's emitter and this file imports nothing
 * from it — the app and the engine are two programs, and the app's mirror is
 * `shared/`. What is transcribed is behaviour, named at each site, on the
 * precedent `BASE_RATIO` set in the pane itself:
 *
 * - **Struck rows are absent.** `applyOverlay` takes struck blocks out before
 *   the emitter sees one, and a struck NOTE is filtered at emission
 *   (`opts.final === true ? notes.filter((note) => !note.struck) : notes`).
 * - **A struck note's reference number goes with it.** The emitter answers
 *   `null` for that marker and the inline pass writes nothing addressable in
 *   its place — *"a struck note's reference keeps its number and loses its
 *   link"* is the FINAL rule for the digit, and the number of a note that is
 *   not in the book at all is not a number the book prints. The workbench draws
 *   it cancelled beside its note; the edition does not draw it.
 * - **Refs are demoted to a plain `<sup>`.** In the cast every matched marker
 *   is `<a class="noteref" epub:type="noteref" href="#fnN"><sup>n</sup></a>`;
 *   an unmatched one falls through to the inline pass's own `<sup>n</sup>`, and
 *   that plain superscript is what the edition draws for every marker it has.
 * - **A chapter with nothing left in it prints nothing**, which is the
 *   emitter's rule for the apparatus said one level up: *"a `<section
 *   class="footnotes">` holding nothing but its `<hr/>` is a rule with white
 *   space under it, and a reader sees it."*
 */

/** What the projection needs to know about one block, and nothing else. */
export interface EditionRow {
  /**
   * The block's kind, from the one table (`shared/categories.ts`).
   *
   * Two of the eleven matter here: `Footnote`, which is the apparatus and moves,
   * and `Text`, which is the only category the export indents (`p { text-indent:
   * 1.4em; }` against `p.caption, p.formula, blockquote p, .footnotes .footnote
   * { text-indent: 0; }`).
   */
  category: string;
  /** The division this block opens, or null — `Replayed.chapters`, by id. */
  chapter: string | null;
  /** Struck: in the document, drawn cancelled on the bench, absent from the edition. */
  struck: boolean;
}

/** Where one block lands in the edition, and what the edition draws around it. */
export interface EditionPlace<T> {
  /** The caller's own row, handed straight back — nothing here is looked up by id. */
  row: T;
  /**
   * The division's title, drawn as a heading above this block — or null, which
   * is every block that does not open one AND every division whose own block is
   * already a heading.
   *
   * ── WHY A DIVISION SOMETIMES DRAWS NOTHING ────────────────────────────────
   *
   * A chapter opening in the cast is not an element the emitter adds, it is the
   * block that was already there: a `Title` becomes `<h1 data-bf-cat="chapter">`
   * and a `Section-header` becomes `<h2 …>` — the same tag the category would
   * have had, wearing the chapter attribute. So where a division sits above a
   * heading, THE BOOK'S OWN WORDS ARE THE HEADING, and drawing the division's
   * title as well would print the chapter's name twice on the page it opens.
   *
   * Where a division sits above something that is not a heading — which is what
   * the Chapters panel mints every time somebody divides the book at a paragraph
   * — there is no heading in the flow to be it, and the title is drawn. That is
   * the visual result docs/RENDERER-DESIGN.md §5 asks for (*"demoted refs
   * re-render"*, chrome gone, the finished book) rather than the dashed rule and
   * the spruce chip, which are the bench's marks and stay on the bench.
   *
   * A division whose block is STRUCK draws its title too: the words that would
   * have been the heading are not in the edition, so the division has nothing
   * else to say its name with.
   */
  heading: string | null;
  /**
   * True where a division opens — the break the cast makes by starting a new
   * document.
   *
   * The emitter does not write a page-break rule anywhere, and it does not need
   * one: each chapter is its own XHTML file in the spine, so the break is the
   * file boundary. A single scrolling sheet has no file boundaries, so the
   * edition spends air on it instead — the one honest translation of "the next
   * chapter starts on its own page" into a page that never ends.
   */
  opens: boolean;
  /**
   * True for the first note of a chapter's collected apparatus — the `<hr/>`
   * that opens `<section class="footnotes">`.
   */
  opensNotes: boolean;
  /** Indented like a printed paragraph — the export's `p { text-indent: 1.4em; }`. */
  indent: boolean;
}

/**
 * The book in the EDITION's order: every chapter's prose, then that chapter's
 * notes, then the next chapter.
 *
 * ── The order, exactly ──────────────────────────────────────────────────────
 *
 * Rows are walked in reading order and cut into SPANS at every division. The run
 * before the first division is a span of its own (a book's front matter is not
 * in chapter one). Within a span the body blocks keep their order and the notes
 * keep theirs, and the notes are emitted after the last body block of the span —
 * which is `buildChapterBody`'s own shape: skip the note where the prose reaches
 * it, write the apparatus once the body is closed.
 *
 * A BOOK WITH NO DIVISIONS IS ONE SPAN, so its notes collect at the end of it.
 * That is not a special case in the code and it is not a fallback: it is what
 * "the end of the chapter" means in a book that is one chapter, and the cast
 * says the same thing — a book the engine found no chapter starts in is one
 * document with one `<section class="footnotes">` at the bottom.
 *
 * ── What is absent, and what a division does about it ───────────────────────
 *
 * Struck rows are dropped as they are met. A division is read BEFORE that drop,
 * so a division above a struck block still divides the book and lands above the
 * next block that survives — the strike was a decision about a paragraph, not
 * about where the book divides. A span with nothing surviving in it drops its
 * heading with it, because a chapter title with the next chapter title under it
 * is a page a reader would call damaged.
 *
 * THE SHELF IS ALREADY OUT. A shelved row is not in the flow at all
 * (docs/BOOK-FILE.md §5) and the sheet never drew one, so the list handed in
 * here has none — this function does not filter for them and must not be handed
 * a list that does.
 */
export function editionFlow<T>(
  rows: readonly T[],
  of: (row: T) => EditionRow,
): EditionPlace<T>[] {
  const out: EditionPlace<T>[] = [];
  let body: T[] = [];
  let notes: T[] = [];
  /** The division the span being gathered opens, or null before the first one. */
  let division: { title: string; onHeading: boolean } | null = null;

  const close = (): void => {
    const span = [...body, ...notes];
    /** Where the apparatus starts — and, since the span is body then notes, how long the prose is. */
    const apparatus = body.length;
    body = [];
    notes = [];
    // A division with nothing surviving under it is not a chapter the finished
    // book prints — see the docblock.
    if (span.length === 0) return;
    for (const [index, row] of span.entries()) {
      out.push({
        row,
        heading: index === 0 && division !== null && !division.onHeading ? division.title : null,
        opens: index === 0 && division !== null,
        // The `<hr/>` goes above the first note and only where there is one.
        opensNotes: index === apparatus && span.length > apparatus,
        indent: of(row).category === 'Text',
      });
    }
  };

  for (const row of rows) {
    const read = of(row);
    if (read.chapter !== null) {
      close();
      division = {
        title: read.chapter,
        // A struck block's words are not on the page, so they cannot be the
        // heading — see `EditionPlace.heading`.
        onHeading: !read.struck
          && (read.category === 'Title' || read.category === 'Section-header'),
      };
    }
    if (read.struck) continue;
    if (read.category === 'Footnote') notes.push(row);
    else body.push(row);
  }
  close();
  return out;
}

/**
 * One block's runs, with the numbers of struck notes taken out of the prose.
 *
 * THE NUMBER BELONGS TO THE NOTE, which is the ruling the whole apparatus is
 * built on (*"if i delete footnotes, it removes their corresponding reference
 * numbers"* — docs/RENDERER.md §0, ruling 9). The bench draws the number
 * cancelled beside its cancelled note, because struck is a state of the document
 * and the person has to see what they took out; the edition is the document
 * WITHOUT what they took out, so the number is not there to see.
 *
 * A NUMBER NO NOTE CARRIES STAYS. It is a digit the page printed, the cast keeps
 * it and merely refuses to link it (*"no link beats a wrong one"*), and the
 * edition draws it as the plain superscript the cast writes for it. The amber
 * that says so on the bench is a decision to make, and a decision to make is
 * chrome.
 *
 * Generic over the run so this is one forward walk with nothing to look up: the
 * pane hands its own `Piece` objects in and gets its own objects back.
 */
export function editionPieces<T extends { marker: { struck: boolean } | null }>(
  pieces: readonly T[],
): T[] {
  return pieces.filter((piece) => piece.marker === null || !piece.marker.struck);
}
