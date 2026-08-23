/**
 * shared/records — A TRANSLATION'S ANSWERS, AND WHICH BLOCK EACH ONE IS ABOUT.
 *
 * ── What this mirrors, and why the app holds a mirror at all ────────────────
 *
 * The format is the engine's (`src/translate/records.ts`): one JSON object per
 * line, appended and fsynced as each answer lands, `{key, parts, generation,
 * text, author}`. This is the app's reader of it, on `shared/book.ts`'s
 * grow-together rule — the app never imports the engine, and the two files change
 * in the same commit or the format has two dialects and the second one is
 * discovered by a book coming out in the wrong language.
 *
 * The app needs one thing the engine's own reader does not give it: WHICH ROW OF
 * THE BOOK each row of the file is about. Main materialises the derived book file
 * when a translation lands (docs/RENDERER.md §4) — parent book file + chain ops +
 * records — and to put a record's words into a row it has to turn the record's
 * position into a block id.
 *
 * ── TWO SPELLINGS OF A POSITION, AND THE BRIDGE BETWEEN THEM ────────────────
 *
 * A record written from a BOOK FILE (`translate --book`) is keyed by the row's
 * own id: `b12-3`, `b12-3#1`, `b2-3/1`. There is nothing to resolve — the key IS
 * the name — which is the whole reason that route exists.
 *
 * A record written from a CAST EPUB is keyed by `page:order[:part]`,
 * space-joined where the reflow made one paragraph out of two pages' blocks, plus
 * `#note` for one note of a Footnote block. That is `data-bf-src`'s value exactly
 * (`stampSrc`, src/vlm/dots-book.ts). A book row carries the same coordinates in
 * its `parts[].src` column, and *"the book file's `src` column is the mechanical
 * mapping (that is why it exists)"* (docs/RENDERER.md §4) — so the bridge is that
 * column joined the same way, and nothing here searches, guesses or matches text.
 *
 * ONE SPELLING DIFFERENCE IS REPAIRED AND IT IS THE ONLY ONE. The emitter writes
 * `12:3:0` for the FIRST piece of an answer the markdown pass cut up (`sourceKey`
 * appends the part for every piece of a split element); the book file writes
 * `12:3` for it (`coordinate` appends the part only when it is not zero). Both
 * name the same banked block, a row whose src is literally `12:3:0` cannot exist,
 * and the difference is mechanical in one direction only — so a legacy key ending
 * `:0` that nothing claims is looked up again without it. Every other key that
 * lands nowhere is REPORTED BY NAME and dropped; a record whose block this book
 * does not hold is a translation of a paragraph that is not here, and putting it
 * somewhere would be worse than saying so.
 *
 * ── LAST ROW WINS, MEASURED IN FILE ORDER AND OVER BLOCK IDS ────────────────
 *
 * The file appends for its whole life: a later run over an edited block, or a
 * person correcting the words by hand, adds a row rather than rewriting one, and
 * the reader takes the newest per position (`records.ts`). This takes the newest
 * per BLOCK — which is the same rule stated over the identity the book actually
 * has, and is the only rule that reads a file holding both spellings correctly.
 * A file can hold both: a project translated before this wave and re-run after it
 * has its old rows and its new ones in one file, and the newest of them is what
 * the book says, however each was spelled.
 *
 * ── AND A THIRD SPELLING, WHICH IS NOT A BLOCK AT ALL ───────────────────────
 *
 * Owen's ruling, 2026-08-22, verbatim: *"when i translate, does it translate the
 * chapters in the spine as well? the chapter names on the green dotted lines? if
 * not, id like it to. everything should be translated."*
 *
 * A row keyed `chapter:<division id>` is a translated CHAPTER TITLE — the name a
 * person typed on the proof sheet, or a part divider's composed label, neither of
 * which any row of the book says and so neither of which can be derived from a
 * translated heading (`titledFrom`, shared/materialize.ts). The engine's own
 * reader owns the spelling and the whole argument for it (`chapterPosition`,
 * src/translate/records.ts); this is the mirror, on the same grow-together rule
 * as the rest of this file.
 *
 * IT IS BACKWARD-SAFE IN BOTH DIRECTIONS AND THAT IS WHY IT IS A PREFIX ON A
 * FIELD THAT ALREADY EXISTS. A records file written before this wave has no such
 * row, so nothing changes for it and a book made from it is exactly the book it
 * was; and a reader written before this wave — including one still running
 * against a file a newer engine has appended to — sees a well-formed line at a
 * position its book has no block at, which is a case it already handles by name.
 */
import type { BookFile, BookRow } from './book';

/** Something is wrong with the records file itself. Always names the line. */
export class RecordsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordsFileError';
  }
}

/**
 * One line of the file — the two fields the app reads, and the one it honours.
 *
 * `key` and `generation` are deliberately absent: the first is the engine's cost
 * cache and the second is a token the app writes and never interprets. Reading
 * either here would be this side forming an opinion about a question it does not
 * ask.
 */
export interface TranslationRow {
  /** `page:order[:part]` joined, or a block id. See this file's header. */
  parts: string;
  /** The translation, in the flowing block's own dialect. */
  text: string;
  /** `"user"` where a person wrote it; absent for a model's row. */
  author?: 'user';
}

/**
 * The rows of a records file, in the order they were written.
 *
 * `TranslationRecords.open`'s rule, verbatim in intent: a malformed LAST line is
 * an interrupted append and is dropped, and a malformed line anywhere else is a
 * file this program did not write and is refused naming the line. The first is
 * the normal consequence of a kill; the second is a wrong path about to supply
 * somebody else's translation to a book they are not from.
 */
export function parseRecordsFile(text: string): TranslationRow[] {
  const lines = text.split('\n');
  const rows: TranslationRow[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const last = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (last) break;
      throw new RecordsFileError(
        `line ${index + 1} is not JSON (${err instanceof Error ? err.message : String(err)}). `
        + 'This file is not a records file.',
      );
    }
    const row = parsed as Partial<TranslationRow>;
    if (typeof row.parts !== 'string' || typeof row.text !== 'string') {
      throw new RecordsFileError(
        `line ${index + 1} carries no parts and text. This file is not a records file.`,
      );
    }
    rows.push({
      parts: row.parts,
      text: row.text,
      ...(row.author === 'user' ? { author: 'user' as const } : {}),
    });
  }
  return rows;
}

/** The words a translation has for this book, and the rows it answers for nothing. */
export interface TranslationWords {
  /** Block id → the newest translation of it. */
  text: Map<string, string>;
  /**
   * Division id → the newest translation of its TITLE — see this file's header.
   *
   * Empty for every records file written before the titles pass existed, which
   * is what makes an old translation materialise exactly as it always did.
   */
  titles: Map<string, string>;
  /**
   * Positions nothing in this book answers to, each once, in the order they were
   * first met. A record about a block this book does not hold — struck since,
   * merged away, or from another reading altogether — or a title record for a
   * division somebody has since taken away, and the caller says so out loud
   * rather than this dropping it in silence.
   */
  stale: string[];
}

/**
 * The namespace a chapter title's position wears — the engine's `chapterPosition`
 * mirrored, and see this file's header for why it cannot collide with either
 * spelling of a block's position.
 */
const CHAPTER_POSITION = 'chapter:';

/** A row's position in the CAST's spelling — `data-bf-src` plus `#note`. */
function legacyKeyOf(row: BookRow): string {
  const src = row.parts.map((part) => part.src).join(' ');
  return row.note === undefined ? src : `${src}#${row.note}`;
}

/**
 * Every record resolved onto the block it is about, newest first-class.
 *
 * The two indexes are built once and the walk is one pass in file order, so the
 * answer is "the last thing anybody said about this block" — see the header on
 * why that is measured over ids rather than over the strings the file happens to
 * be keyed by.
 */
export function translationWords(
  book: BookFile,
  rows: readonly TranslationRow[],
): TranslationWords {
  const ids = new Set(book.rows.map((row) => row.id));
  const byLegacy = new Map<string, string>();
  for (const row of book.rows) byLegacy.set(legacyKeyOf(row), row.id);
  const divisions = new Set(book.header.chapters.map((chapter) => chapter.id));

  const text = new Map<string, string>();
  const titles = new Map<string, string>();
  const stale: string[] = [];
  const said = new Set<string>();
  for (const row of rows) {
    /*
     * A TITLE ROW IS RESOLVED AGAINST THE DIVISIONS AND NEVER AGAINST THE ROWS,
     * and the two lists genuinely differ: a division names the block it sits
     * above, so its id is also a row id, and a record about the PARAGRAPH at
     * that block is a different record about a different string. Routing on the
     * prefix rather than on the id is what keeps them apart.
     *
     * A title for a division this book no longer has is stale in exactly the
     * sense every other unclaimed position is — somebody took the chapter line
     * away after the translation was made — and it is named with the rest.
     */
    const division = row.parts.startsWith(CHAPTER_POSITION)
      ? row.parts.slice(CHAPTER_POSITION.length)
      : null;
    if (division !== null) {
      if (divisions.has(division)) titles.set(division, row.text);
      else if (!said.has(row.parts)) { said.add(row.parts); stale.push(row.parts); }
      continue;
    }
    const id = ids.has(row.parts)
      ? row.parts
      : byLegacy.get(row.parts)
        // The one repaired spelling, and only where nothing claimed the key as
        // written. See the header: `12:3:0` and `12:3` are the emitter's and the
        // book file's names for the first piece of one split answer.
        ?? (row.parts.endsWith(':0') ? byLegacy.get(row.parts.slice(0, -2)) : undefined);
    if (id === undefined) {
      if (!said.has(row.parts)) { said.add(row.parts); stale.push(row.parts); }
      continue;
    }
    text.set(id, row.text);
  }
  return { text, titles, stale };
}
