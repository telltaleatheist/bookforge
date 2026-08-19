/**
 * book-view/table — the model's grid, read into a shape this app can DRAW.
 *
 * ── What this is for, and what it is not ────────────────────────────────────
 *
 * A `Table` block's text is not prose. It is the vision model's own HTML — the
 * whole grid as one string — and both of the engine's EPUB writers already
 * treat it as such: `compile.ts` and `dots-book.ts` hand it to `checkTableHtml`
 * (src/vlm/dots.ts), which parses it, throws if it is not well-formed, and
 * otherwise writes it through UNESCAPED and untouched. So the finished book has
 * had a real table in it all along.
 *
 * The BENCH did not. Its `@default` case caught Text, Table, Formula and
 * List-item alike and set them all as a paragraph, so the one place a person
 * can look at a book before exporting it showed a table as a wall of angle
 * brackets. The user's words: *"the table of contents in the pokemon book also
 * came through as actual html rather than displaying it."*
 *
 * **THIS DRAWS A GRID. IT IS NOT THE GRID EDITOR** — that was deferred out loud
 * in this component and stays deferred. Nothing here is clickable, nothing here
 * writes an op, and a struck or curated Table block goes on being struck and
 * curated exactly as it was, because the strike is a fact about the BLOCK and
 * this only decides what is drawn inside it.
 *
 * ── MODEL-AUTHORED MARKUP IS NOT TRUSTED INPUT ──────────────────────────────
 *
 * It arrived from a language model over a socket. That we asked for it is not a
 * provenance — a prompt-injected page, a corrupted answer or a bad decode can
 * put anything at all in that string, and the string is stored in a project
 * file that outlives the run. Angular escapes every interpolation by default,
 * and drawing a table means deliberately stepping around that, so the guard IS
 * the unit rather than a detail of it.
 *
 * The guard is stronger than an allowlist over `innerHTML`, and deliberately so:
 * **not one character of the model's string ever becomes markup.** This reads
 * the fragment into a plain data structure of rows, cells and two integers, and
 * the component draws that structure with its own template. There is no
 * `innerHTML`, no `bypassSecurityTrust*`, no `DomSanitizer` — nothing that could
 * be relaxed later by somebody who did not read this paragraph. A `<script>`, an
 * `onerror`, an `<iframe>`, a `javascript:` href: none of them have a path to
 * the document, because the only things that cross this boundary are strings
 * that will be interpolated and numbers that will be clamped.
 *
 * The parse itself runs in a `DOMParser` document, which has no browsing
 * context: scripts in it never execute and resources in it are never fetched.
 * It is used to READ, and its nodes are never adopted into the live page.
 *
 * ── WHAT THE ALLOWLIST DOES WITH WHAT IT REJECTS, WHICH IS THE POINT ────────
 *
 * `table`, `thead`, `tbody`, `tr`, `td`, `th` and nothing else. The three
 * outcomes, all of them stated because a sanitiser whose failure mode is
 * "nothing appears" is worse than no sanitiser:
 *
 * 1. **An unlisted element INSIDE a cell keeps its words and loses its tag.**
 *    A `<b>`, a `<br>`, an `<a>` — the cell's text is its `textContent`, so
 *    every word the model put in that cell is on the page and none of the
 *    markup is. Refusing a whole table because one cell was emphasised would
 *    be the guard destroying the thing it is protecting. THE ONE EXCEPTION IS
 *    `script`, `style` and `template`, whose contents are dropped with them:
 *    their text is CODE and not words, and a cell reading `alert(1)` would be
 *    this app printing an attacker's payload as though the book contained it.
 *    (It could never RUN it — the string is interpolated and Angular escapes —
 *    but a table of somebody's Pokémon should not have a script in it either.)
 * 2. **An unlisted element WHERE A ROW OR A CELL BELONGS is not drawn.** It is
 *    not a row and it is not a cell; HTML's own parser discards most of what
 *    could get there, and what is left is markup that means nothing in a table.
 * 3. **A fragment with no rows in it at all is REFUSED, VISIBLY.** `readTable`
 *    answers null, and the caller falls back to exactly what this block did
 *    before this file existed: the model's string, set as prose, on the page,
 *    where a person can read it and see for themselves that it is not a table.
 *    It never blanks the block, because a block that quietly draws nothing is a
 *    paragraph of somebody's book gone missing with nothing said about it.
 *
 * KNOWN AND STATED, three of them, because each is a place where something the
 * fragment held does not reach the page:
 *
 * - **A `<caption>`'s words are not drawn.** It is a title for the grid rather
 *   than a part of it, drawing it would mean an element outside the ruling's
 *   list, and the block already wears its category in the margin.
 * - **A `<tfoot>`'s rows ARE drawn**, as ordinary rows in the order the
 *   fragment put them. `tfoot` is not on the list and no `tfoot` is drawn — the
 *   rows inside one are `tr`s, which are — and dropping a table's totals
 *   silently is the failure this whole section is written against.
 * - **Two tables in one fragment draw the first.** A Table block is one grid by
 *   contract; merging two into one would invent a table neither of them is, and
 *   drawing both would need a shape this block does not have.
 *
 * No table in the user's library exercises any of the three; if one turns up,
 * these are the lines to revisit.
 */

/** One cell — its words, whether it is a heading, and how far it reaches. */
export interface TableCell {
  /** The cell's `textContent`, and never its markup. */
  text: string;
  /** A `th` rather than a `td` — drawn as a heading, decided by the tag alone. */
  header: boolean;
  /**
   * `colspan`/`rowspan`, READ AS NUMBERS AND CLAMPED. These are the only two
   * attributes this file looks at, out of every attribute the fragment may
   * carry, which is what keeps `style`, `class`, `onclick` and the rest without
   * a path to the page. The clamp is not defensive dressing: HTML's own limit is
   * a thousand, and a model that answered `colspan="99999"` would lay out a
   * table wider than the machine before anybody could tell it not to.
   */
  colspan: number;
  rowspan: number;
}

/** One row of the grid. */
export interface TableRow {
  cells: TableCell[];
  /** Every cell of it is a `th` — so the row is drawn as the grid's head. */
  head: boolean;
}

/** How wide a single cell is allowed to claim it is. */
const MAX_SPAN = 64;

/** The six elements that may be drawn. Everything else is words or nothing. */
const CELLS = new Set(['TD', 'TH']);

/** Inside a cell these are not words — see the header, outcome 1's exception. */
const NOT_WORDS = 'script, style, template';

/**
 * The model's fragment, read into rows — or null when there is no table in it.
 *
 * Null is the REFUSAL, and the caller's answer to it is to print the words. See
 * the header: outcome 3.
 */
export function readTable(fragment: string): TableRow[] | null {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) return null;

  /*
   * A BARE RUN OF `<tr>`s IS WRAPPED BEFORE IT IS PARSED, because HTML's parser
   * foster-parents table content that is not inside a table and would hand back
   * an empty body — a refusal for a fragment that is only missing its outermost
   * tag. The test is for the tag and not for the string, so a `<td>` whose text
   * mentions a table cannot fool it.
   */
  const html = /<\s*table[\s>]/i.test(trimmed) ? trimmed : `<table>${trimmed}</table>`;

  let table: HTMLTableElement | null;
  try {
    table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  } catch {
    // `parseFromString` with `text/html` does not throw on malformed input — an
    // HTML parser has no failure mode, it has a recovery for everything. The
    // catch is here for the one thing that can: an environment without a
    // `DOMParser` at all, which is a refusal and not a crash on the paper.
    return null;
  }
  if (table === null) return null;

  const rows: TableRow[] = [];
  for (const tr of table.querySelectorAll('tr')) {
    /*
     * A NESTED TABLE'S ROWS ARE THIS TABLE'S CELL'S TEXT, not this table's rows.
     * `querySelectorAll` reaches into one; hoisting what it finds would print
     * the inner grid twice — once as rows of the outer table and once inside the
     * cell that contains it, since that cell's `textContent` holds every word of
     * it either way.
     */
    if (tr.closest('table') !== table) continue;
    const cells: TableCell[] = [];
    for (const child of tr.children) {
      if (!CELLS.has(child.tagName)) continue;
      cells.push({
        text: wordsOf(child),
        header: child.tagName === 'TH',
        colspan: span(child.getAttribute('colspan')),
        rowspan: span(child.getAttribute('rowspan')),
      });
    }
    if (cells.length === 0) continue;
    rows.push({ cells, head: cells.every((cell) => cell.header) });
  }

  return rows.length === 0 ? null : rows;
}

/**
 * Everything a cell SAYS, and nothing it does.
 *
 * The clone is what lets the code be dropped without touching the parsed
 * document — which matters not because anything else reads that document, but
 * because a function named for reading should not be the one that edits. It is
 * a detached node in a document with no browsing context either way: removing a
 * `<script>` from it cannot run it and never could.
 */
function wordsOf(cell: Element): string {
  const copy = cell.cloneNode(true) as Element;
  for (const code of copy.querySelectorAll(NOT_WORDS)) code.remove();
  return (copy.textContent ?? '').trim();
}

/**
 * An attribute string as a span, or 1.
 *
 * Anything that is not a whole number at least one — absent, empty, `"two"`,
 * `"-3"`, `"1e9"` — is one cell, which is what a cell is when it says nothing.
 */
function span(said: string | null): number {
  if (said === null) return 1;
  const value = Number.parseInt(said, 10);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, MAX_SPAN);
}
