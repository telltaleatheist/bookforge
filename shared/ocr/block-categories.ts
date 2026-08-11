/**
 * The block-category contract: THIRTEEN classes, one name and one colour each.
 *
 * This file is the single source of truth for what a category is called and what
 * colour it paints. It exists because there used to be three tables — the
 * picker's `ALL_STANDARD_CATEGORIES`, the OCR post-processor's `CATEGORIES`, and
 * `CATEGORY_TYPE_COLORS` in electron/pdf-analyzer.ts — and they disagreed:
 *
 *   - The OCR table had only EIGHT classes and a scrambled palette: `heading`
 *     was purple (subheading's colour) and `caption` was orange (heading's).
 *     Those entries land in `editorState.categories`, which the palette reads,
 *     so once a book had been OCR'd the swatches contradicted the contract.
 *   - None of the other tables had `chapter`, `subheading`, `table` or `list`,
 *     so a block carrying one — hand-labelled or predicted by blocks — found
 *     no entry at all and fell through the viewer's `|| '#FF9500'` to orange.
 *     That is the bug this replaces: an orange rect that says "Chapter Opening"
 *     when you click it, because blue was never available to paint it with.
 *
 * Colours are only ever LOOKED UP by id, never stored and re-read: category
 * records persisted inside old projects carry the scrambled palette, so
 * `normalizeCategories` overwrites colour and name on load rather than trusting
 * them.
 *
 * It lives under `shared/` (moved out of the renderer Jul 2026) because it is now
 * also the authority for the CLI: `cli/ocr-pdf.js --project` writes
 * the editor state's `ocrCategories` for hand-labelling on another machine, and those
 * records have to be the same thirteen with the same names and colours the app
 * shows. `electron/pdf-analyzer.ts` derives CATEGORY_TYPE_COLORS from this list
 * rather than mirroring it, for the same reason.
 *
 * Keep the id list in step with `BLOCKS_CATEGORIES_V3` in
 * `src/app/features/pdf-picker/services/blocks-encoder.ts`, CATEGORIES in
 * tools/aligner/build-sft-dataset.mjs and LABEL_SET in tools/aligner/align-core.mjs.
 */
import type { Category } from './text-block';

export interface BlockCategoryDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  /** Where the class lives on the page — drives the region filters. */
  readonly region: string;
  /** Nominal type size, used only as a display hint on fresh categories. */
  readonly fontSize: number;
}

/**
 * The thirteen, in palette order (most common first).
 *
 * `front_matter` and `back_matter` were retired in Jul 2026 — they said where a
 * page sat rather than what was on it — along with `footnote_ref` (2 examples in
 * 42,759). Do not add them back: `saveTrainingSession` records this list as the
 * `labelSet` a book was labelled under, so offering a retired class would put
 * positional labels back into the corpus.
 */
export const BLOCK_CATEGORIES: readonly BlockCategoryDef[] = [
  { id: 'body', name: 'Body Text', description: 'Main body text content',
    color: '#4CAF50', region: 'body', fontSize: 12 },
  { id: 'title', name: 'Titles', description: 'The book or part title',
    color: '#F44336', region: 'body', fontSize: 24 },
  { id: 'chapter', name: 'Chapter Openings', description: 'Chapter titles and numbers — the EPUB split points',
    color: '#3F51B5', region: 'body', fontSize: 20 },
  { id: 'heading', name: 'Section Headings', description: 'Section headings within a chapter',
    color: '#FF9800', region: 'body', fontSize: 18 },
  { id: 'subheading', name: 'Subheadings', description: 'Headings subordinate to a section heading',
    color: '#9C27B0', region: 'body', fontSize: 15 },
  { id: 'quote', name: 'Block Quotes', description: 'Quotations and epigraphs',
    color: '#FFEB3B', region: 'body', fontSize: 14 },
  { id: 'caption', name: 'Captions', description: 'Image captions and figure descriptions',
    color: '#00BCD4', region: 'body', fontSize: 10 },
  { id: 'footnote', name: 'Footnotes', description: 'Footnotes, endnotes and citations',
    color: '#2196F3', region: 'body', fontSize: 10 },
  { id: 'header', name: 'Page Headers', description: 'Page headers and running heads',
    color: '#795548', region: 'header', fontSize: 10 },
  { id: 'footer', name: 'Page Footers', description: 'Page footers and page numbers',
    color: '#607D8B', region: 'footer', fontSize: 10 },
  { id: 'image', name: 'Images', description: 'Figures, plates and other raster content',
    color: '#9E9E9E', region: 'body', fontSize: 0 },
  // Structured non-prose content, where the unit is an ENTRY rather than a
  // sentence: a table of contents, an index, a bibliography, a glossary, a
  // chronology, and ordinary bulleted or numbered lists are all `list`. A table
  // shredded into fragment blocks by OCR is still all `table`.
  // Usually worth deleting before export, and the user does that themselves —
  // no class decides its own fate here any more. A table read as prose is
  // unlistenable: Pohl's deportation tables come out as "Koreans 21-8-37 to
  // 171,7812 Kazakhstan 19544", and OCR shreds a table into row fragments whose
  // reading order is already gone, so there is no sentence left to recover.
  { id: 'table', name: 'Tables', description: 'Tabular data, including OCR fragments of one',
    color: '#E64A19', region: 'body', fontSize: 10 },
  { id: 'list', name: 'Lists', description: 'Entry-per-line content: contents, index, bibliography, bullets',
    color: '#AFB42B', region: 'body', fontSize: 12 },
  // Present on the page, and not content. Text Tesseract read off a photograph
  // (a slogan on a T-shirt), cover and back-cover matter, copyright pages.
  //
  // A LABEL, deliberately not a deletion. Deleting the block would train on a
  // page layout that never occurs — Tesseract still emits it at inference — and
  // would strip a caption of the image that identifies it. Labelling it keeps
  // the page intact and gives the labeller a right answer where there was none;
  // these were going under `image` for want of anywhere else, and an arbitrary
  // label is unlearnable. Measured on v5: `image` F1 0.229 and `caption` 0.350
  // while BOTH cleared the corpus-size bar that `title` fails at 0.905.
  { id: 'discard', name: 'Discard', description: 'On the page but not content: OCR read off an image, covers, copyright',
    color: '#455A64', region: 'body', fontSize: 0 },
];

/**
 * Plain prose — the class a block is relabelled TO when the user says only what
 * it is not.
 *
 * The Chapter tab's "not a chapter" gesture is the case: the user is rejecting
 * `chapter`, not choosing a replacement, and a heading that is not a split point
 * is still text the book has to read aloud. Named here, beside the list, because
 * which class means "just words on the page" is a fact about the palette and not
 * about whichever tab is asking.
 */
export const BODY_CATEGORY = 'body';

/**
 * Unlabel sentinel — offered in the labelling UI like a category (chip + `u`
 * key) but it is NOT one and must never be stored: assigning it DELETES the
 * block's label, which saves as a missing key in labels.json — the corpus's
 * "unjudged, never trains". It exists for under-split blocks (a footnote
 * Tesseract fused onto a body paragraph) where any single label would be a
 * falsehood. Kept out of BLOCK_CATEGORIES deliberately: anything in that list
 * is recorded as a saved book's labelSet.
 */
export const UNLABEL_CATEGORY = '__unlabel__';

const BY_ID: ReadonlyMap<string, BlockCategoryDef> =
  new Map(BLOCK_CATEGORIES.map(c => [c.id, c]));

/** The legal category ids, for validation. */
export const BLOCK_CATEGORY_IDS: readonly string[] = BLOCK_CATEGORIES.map(c => c.id);

// There was a `FOUNDRY_CATEGORY_IDS` here — the subset of the palette that
// foundry's exporter had a rule for, everything but `table` — and an
// `isFoundryCategory` guard so a relabel foundry could not render was refused in
// the app, beside the block, instead of arriving as a CLI exit code after the
// user pressed Export. Both are gone: `foundry export --overrides` was removed
// with the rest of the run-directory pipeline (Aug 2026), so there is no seam
// left to refuse at, and nothing had called the guard for some time. The palette
// above is the whole contract now.

export function blockCategoryDef(id: string): BlockCategoryDef | undefined {
  return BY_ID.get(id);
}

/**
 * The colour for a category id. `fallback` is for ids outside the contract —
 * user-created custom categories, which carry their own colour and should pass
 * it here rather than inherit a class colour they are not.
 */
export function blockCategoryColor(id: string, fallback = '#9E9E9E'): string {
  return BY_ID.get(id)?.color ?? fallback;
}

/** A full `Category` record for a contract class, with zero counts. */
export function toCategory(def: BlockCategoryDef): Category {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    color: def.color,
    block_count: 0,
    char_count: 0,
    font_size: def.fontSize,
    region: def.region,
    sample_text: '',
  };
}

/**
 * Force the canonical name and colour onto every contract class in a category
 * record, leaving everything else alone.
 *
 * Counts, `region`, `font_size` and `sample_text` are whatever the
 * caller measured — those are facts about this book. Name and colour are not:
 * they come from the contract, so a project saved under the old scrambled
 * palette renders correctly with no migration step. Categories outside the
 * contract (custom ones the user made) pass through untouched.
 *
 * Deliberately does NOT add the classes that are absent. A record only has
 * entries for classes this book actually produced, and Select mode lists it
 * verbatim — injecting the other twelve would fill that list with empty rows.
 * Classes with no entry still paint correctly, because colour is looked up
 * through `blockCategoryColor` rather than read out of this record, and the
 * Label and Detect palettes list the contract directly.
 */
export function normalizeCategories(
  cats: Record<string, Category> | null | undefined,
): Record<string, Category> {
  const out: Record<string, Category> = {};
  for (const [id, cat] of Object.entries(cats ?? {})) {
    const def = BY_ID.get(id);
    out[id] = def ? { ...cat, name: def.name, color: def.color } : cat;
  }
  return out;
}
