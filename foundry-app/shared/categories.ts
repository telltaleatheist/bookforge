/**
 * The categories a block can carry, and the colour each one is drawn in.
 *
 * ── Why this is ONE table in shared/ ─────────────────────────────────────────
 *
 * The colour has to appear in TWO places or it is a code nobody can decode: as
 * the rule down a block's edge on the proof sheet, and as a swatch beside the
 * category's name in the legend. Two hand-kept lists of eleven colours would be
 * one edit away from a legend that says a paragraph is green while the paper
 * draws it amber, and the whole point of colouring them is that the two agree.
 *
 * `app/shared` is the one directory BOTH TypeScript programs compile — the
 * renderer through tsconfig.json's `@shared/*`, the main process through
 * tsconfig.electron.json's `shared/**` include — which is why the wire shapes
 * live here and why this does too.
 *
 * ── ONE VOCABULARY REACHES A READER NOW ─────────────────────────────────────
 *
 * The table below is the EPUB's — `data-bf-cat`, lower-cased — and nothing
 * imports it any more: it survives as the SOURCE the scan's list is derived
 * from, which is what keeps one set of colours honest across two spellings. The
 * exports that served the deleted editing world (`BLOCK_CATEGORIES` itself,
 * `CATEGORY_IDS`, `categoryLabel`, `categoryRgb`, `CHAPTER_MARK_COLOUR`) went
 * with it (docs/RENDERER.md §7).
 *
 * ── The eleven ───────────────────────────────────────────────────────────────
 *
 * Ten are the dots model's own categories, lower-cased, as `src/vlm/dots-book.ts`
 * writes them; the eleventh — `chapter` — is foundry's, marking a heading the
 * book divides at (dots has no such category, and `proposeChapters` is what
 * decides). This list must stay in step with that emitter: a category arriving
 * from a book that is not here is drawn in the fallback grey and named as
 * unknown rather than silently taking somebody else's colour.
 *
 * ── The colours ──────────────────────────────────────────────────────────────
 *
 * Owen named three — green body text, blue chapter header, red title — and the
 * rest are chosen around them. Eleven hues cannot all be told apart at a glance,
 * so they are grouped by WHAT THE BLOCK IS and the families carry the meaning:
 * the prose is green, the headings are the red→blue→violet run (title, chapter,
 * section-header, in the order a book nests them), the apparatus a reader skips
 * past is warm (footnote, caption), set-off prose is pink/lime, and the objects
 * that are not sentences at all are cool (table, picture, formula). Two pairs
 * sit close — fuchsia/pink and cyan/teal — and the swatch in the inspector is
 * what settles those, which is why the inspector is not optional.
 *
 * They are applied as an OUTLINE AND A TINT, never as text colour: this is a
 * book, and recolouring its words makes it unreadable.
 */

export interface BlockCategory {
  /** The `data-bf-cat` value, verbatim. */
  id: string;
  /** What the inspector's row says. */
  label: string;
  /** The outline and tint, as `#rrggbb`. */
  colour: string;
  /** One line under the label, so a row explains itself. */
  note: string;
}

const BLOCK_CATEGORIES: readonly BlockCategory[] = [
  {
    id: 'text',
    label: 'Body text',
    colour: '#4ade80',
    note: 'The prose of the book.',
  },
  {
    id: 'title',
    label: 'Title',
    colour: '#f87171',
    note: "The book's own name, and the parts a title page carries.",
  },
  {
    id: 'chapter',
    label: 'Chapter opening',
    colour: '#60a5fa',
    note: 'A heading the book divides at — the EPUB split points.',
  },
  {
    id: 'section-header',
    label: 'Section header',
    colour: '#a78bfa',
    note: 'A heading inside a chapter.',
  },
  {
    id: 'quote',
    label: 'Quotation',
    colour: '#f472b6',
    note: 'Prose set off from the paragraph around it.',
  },
  {
    id: 'list-item',
    label: 'List item',
    colour: '#a3e635',
    note: 'A list, and the items in it.',
  },
  {
    id: 'footnote',
    label: 'Footnote',
    colour: '#fbbf24',
    note: 'A note the page printed under a rule.',
  },
  {
    id: 'caption',
    label: 'Caption',
    colour: '#e879f9',
    note: 'The words under a plate or a table.',
  },
  {
    id: 'table',
    label: 'Table',
    colour: '#22d3ee',
    note: "A grid, with the model's own rows inside it.",
  },
  {
    id: 'picture',
    label: 'Picture',
    colour: '#2dd4bf',
    note: 'A plate cropped out of the scan.',
  },
  {
    id: 'formula',
    label: 'Formula',
    colour: '#94a3b8',
    note: 'Mathematics, left exactly as it was read.',
  },
];

/** What a category this table has never heard of is drawn in. Grey, and named as unknown. */
const UNKNOWN_CATEGORY_COLOUR = '#8c8c8c';

/**
 * The same eleven, plus the page furniture, under the names a SCAN's blocks
 * carry — for the block editor over a PDF.
 *
 * ── Why there are two vocabularies and only one set of colours ───────────────
 *
 * A cast book's blocks carried `data-bf-cat="footnote"`; the readings bank's
 * blocks carry `"Footnote"`, because that is what the model answered and the bank
 * is never edited. They are the same idea spelled for two different files, and
 * the one thing that must not differ is the COLOUR.
 *
 * So the rows are DERIVED from the table above by lower-casing the engine's
 * spelling, and nothing here restates a hex value that is already up there. Only
 * the two categories the EPUB vocabulary has no word for carry their own.
 *
 * ── The two that are new, and the one that is missing ───────────────────────
 *
 * `Page-header` and `Page-footer` are the running head and the folio. They are
 * not in the EPUB's list because the cast book does not contain them — the engine
 * sets them aside as furniture — but they are emphatically in the SCAN, they are
 * what the model most often mistags as a Title (168 pages of running head, three
 * of them called a Title, each one a spurious chapter split), and correcting one
 * is the single most valuable thing a person can do on the sheet. A pass that
 * could not name them would be missing its main job.
 *
 * `chapter` goes the other way: it is foundry's own category in the EPUB table
 * and the model has no such answer. "The book divides here" is not a category at
 * all — it is a chapter op against a block id (docs/RENDERER.md §3), drawn as a
 * rule above the block rather than as a colour.
 */
const PAGE_FURNITURE: readonly BlockCategory[] = [
  {
    id: 'Page-header',
    label: 'Running head',
    colour: '#9a8c98',
    note: 'The line printed at the top of every page. Not part of the book.',
  },
  {
    id: 'Page-footer',
    label: 'Folio',
    colour: '#6b7280',
    note: 'The page number and whatever sits beside it. Not part of the book.',
  },
];

/**
 * Every category a block in the readings bank can carry, in the engine's order
 * (`DOTS_CATEGORIES`, src/vlm/dots.ts).
 *
 * Built rather than written: an entry the EPUB table also knows takes that row's
 * colour and note under the engine's spelling of its id, so the two lists cannot
 * drift apart in the one way that would matter.
 */
export const PDF_BLOCK_CATEGORIES: readonly BlockCategory[] = [
  'Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header',
  'Picture', 'Quote', 'Section-header', 'Table', 'Text', 'Title',
].map((id) => {
  const furniture = PAGE_FURNITURE.find((one) => one.id === id);
  if (furniture !== undefined) return furniture;
  const shared = BLOCK_CATEGORIES.find((one) => one.id === id.toLowerCase());
  return shared === undefined
    ? { id, label: id, colour: UNKNOWN_CATEGORY_COLOUR, note: '' }
    : { ...shared, id };
});

/** A scan block's colour, or the fallback grey for a category no build knows. */
export function pdfCategoryColour(id: string): string {
  return PDF_BLOCK_CATEGORIES.find((one) => one.id === id)?.colour ?? UNKNOWN_CATEGORY_COLOUR;
}

export function pdfCategoryLabel(id: string): string {
  return PDF_BLOCK_CATEGORIES.find((one) => one.id === id)?.label ?? id;
}
