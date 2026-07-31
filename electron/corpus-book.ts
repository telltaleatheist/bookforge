/**
 * Corpus books — opened for labelling WITHOUT importing them into the library.
 *
 * The training corpus master is `~/Documents/BookForge/training/<slug>/`, one
 * directory per book. Those books are measurement material: there is no reason
 * for twenty-five of them to appear in Studio next to real audiobook projects,
 * and a labelling pass has no reason to mint a project, an archive copy or a
 * manifest entry. So a corpus book is opened straight from its own directory and
 * its labels are saved straight back there.
 *
 * NOTHING in this file touches `{library}/projects/`. The corpus directory is the
 * only place a corpus book has state, and this file holds every writer of it.
 *
 *   book.json     the record: title and where the PDF lives. Written when a book
 *                 is added from the Training tab; absent on books that predate it
 *   blocks.json   OCR output, for a book that has not been labelled yet
 *   labels.json   THE file once labelling starts: a block snapshot plus `labels`
 *
 * The three are a lifecycle, not alternatives: add writes book.json, OCR writes
 * blocks.json, the first save writes labels.json and from then on labels.json is
 * what opens. `listTrainingBooks` reports which of the three a book has reached.
 *
 * The PDF is REFERENCED, not copied. A corpus of 300 scans is tens of gigabytes
 * and duplicating it to record a label would be a poor trade; `resolvePdf` looks
 * in book.json, then at the path the blocks recorded, then for a PDF sitting in
 * the folder, and says exactly which it used. A book whose PDF has moved is
 * reported as such rather than opened half-working.
 *
 * `labels` is the label set, NOT `blocks[].category_id`. The latter is the OCR
 * heuristic's opening guess and still carries pre-v3 classes on older books, so
 * reading labels from it would feed the editor stale answers dressed as truth.
 *
 * Blocks come from the snapshot rather than from a fresh extraction because the
 * labels are keyed to those exact ids — OCR block ids carry a random per-run
 * suffix (`ocr_p3_k2x9f1_17`), so re-OCRing the same PDF orphans every label.
 */

import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { normalizeFsPath } from './path-utils';
import { TRAINING_SESSION_VERSION, trainingRootDir, type TrainingBlock, type TrainingSession } from './training-data';
import { BLOCK_CATEGORY_IDS } from '../shared/ocr/block-categories';

export interface CorpusBook {
  /** Absolute path of the corpus directory — the book's whole identity. */
  dir: string;
  slug: string;
  /** The document the blocks were recognized from. Verified to exist. */
  pdfPath: string;
  /** How `pdfPath` was found, so the UI can say which file it opened and why. */
  pdfSource: 'book.json' | 'recorded' | 'sibling';
  /** Which file the blocks came from. */
  from: 'labels.json' | 'blocks.json' | 'book.json';
  /** False when this book has no labels.json at all — a valid starting state. */
  labelled: boolean;
  /**
   * The block snapshot, or null for a book that has only ever been ADDED.
   *
   * Null is a real state, not a failure: a book added from the Training tab has
   * a PDF and nothing else until OCR runs. The picker opens the document
   * normally in that case and `saveTrainingBlocks` records what OCR produces.
   * Every other state pins the editor to the snapshot the labels are keyed to.
   */
  session: TrainingSession | null;
}

/**
 * `book.json` — what a human said this book is.
 *
 * Deliberately tiny. Everything else about a training book is derivable from
 * blocks.json and labels.json, and a second copy of derivable state is a second
 * thing that can be wrong.
 */
export interface TrainingBookRecord {
  title: string;
  /** Absolute path to the PDF. Referenced, never copied — see the file header. */
  pdfPath: string;
  addedAt: string;
}

/** How far through add → OCR → label a book has got. */
export type TrainingBookState = 'added' | 'ocr' | 'labelled';

export interface TrainingBookSummary {
  dir: string;
  slug: string;
  title: string;
  state: TrainingBookState;
  /** Null when nothing on this machine can supply the document. */
  pdfPath: string | null;
  pages: number;
  blocks: number;
  /** Blocks carrying a hand label. */
  labelled: number;
  /** ISO timestamp of the most recent labelling save, when there has been one. */
  savedAt: string | null;
  /** Set when the book is on disk but cannot be opened, with the reason why. */
  problem: string | null;
}

/** The compact on-disk shape `cli/ocr-pdf.js` writes to blocks.json. */
interface RawOcrBlock {
  id: string;
  page: number;
  x: number; y: number; w: number; h: number;
  text: string;
  category?: string;
  lineCount?: number;
  fsize?: number;
  conf?: number;
  fontName?: string;
  bold?: boolean;
  italic?: boolean;
}

interface RawBlocksFile {
  pdf?: string;
  engine?: string;
  pageDimensions?: Array<{ width: number; height: number }>;
  blocks?: RawOcrBlock[];
}

/**
 * Resolve whatever the user pointed at to the corpus directory that owns it.
 *
 * Accepts the directory itself or any file inside it (labels.json, blocks.json,
 * the PDF), because all three are things a person would reasonably drag in.
 *
 * The containment check is not decoration: everything downstream writes into
 * this directory, and a path outside the corpus root would make "corpus mode"
 * a general-purpose writer pointed at an arbitrary folder.
 */
async function resolveCorpusDir(target: string): Promise<string> {
  const normalized = normalizeFsPath(target);
  let dir: string;
  try {
    dir = (await fsPromises.stat(normalized)).isDirectory() ? normalized : path.dirname(normalized);
  } catch {
    throw new Error(`No such path: ${normalized}`);
  }

  const root = trainingRootDir();
  const resolved = path.resolve(dir);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(
      `${resolved} is not inside the training corpus (${root}). ` +
      'Corpus mode only opens books that already live there.'
    );
  }
  if (resolved === path.resolve(root)) {
    throw new Error(`${root} is the corpus root, not a book. Choose one of the book folders inside it.`);
  }
  return resolved;
}

async function readJson(file: string): Promise<unknown> {
  const raw = await fsPromises.readFile(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Loudly, and by name. A corrupt labels.json quietly treated as "no labels
    // yet" would look exactly like a book that was never labelled, and the next
    // save would write over the file that still holds the work.
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Nothing was loaded.`);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fsPromises.access(file); return true; } catch { return false; }
}

/** Validate the parsed labels.json far enough that the editor can trust it. */
function asSession(file: string, parsed: unknown): TrainingSession {
  const session = parsed as Partial<TrainingSession>;
  if (!session || typeof session !== 'object') {
    throw new Error(`${file} does not contain a labelling session.`);
  }
  if (session.version !== TRAINING_SESSION_VERSION) {
    throw new Error(
      `${file} is version ${session.version}; this build reads version ${TRAINING_SESSION_VERSION}.`
    );
  }
  if (!Array.isArray(session.blocks) || session.blocks.length === 0) {
    throw new Error(`${file} has no blocks — there is nothing to label.`);
  }
  if (!Array.isArray(session.pageDimensions) || session.pageDimensions.length === 0) {
    throw new Error(`${file} has no pageDimensions, so its blocks cannot be placed on the pages.`);
  }
  if (session.labels === null || typeof session.labels !== 'object' || Array.isArray(session.labels)) {
    throw new Error(`${file} has no labels object.`);
  }
  return session as TrainingSession;
}

/**
 * Turn a never-labelled book's blocks.json into the same session shape.
 *
 * `category` is carried into `category_id` (it is what the heuristic guessed and
 * what the editor paints as a starting point) but NOT into `labels`, which stays
 * empty: nothing here has been decided by a human yet, and seeding the label map
 * with machine output is how a guess becomes ground truth by accident.
 */
function sessionFromBlocksFile(file: string, parsed: unknown): TrainingSession {
  const raw = parsed as RawBlocksFile;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    throw new Error(`${file} has no blocks — there is nothing to label.`);
  }
  if (!Array.isArray(raw.pageDimensions) || raw.pageDimensions.length === 0) {
    throw new Error(`${file} has no pageDimensions, so its blocks cannot be placed on the pages.`);
  }

  const blocks: TrainingBlock[] = raw.blocks.map(b => ({
    id: b.id,
    page: b.page,
    x: b.x, y: b.y, width: b.w, height: b.h,
    text: b.text ?? '',
    font_size: b.fsize ?? 0,
    font_name: b.fontName ?? 'OCR',
    char_count: (b.text ?? '').length,
    region: 'body',
    category_id: b.category ?? 'body',
    line_count: b.lineCount,
    is_ocr: true,
    ocr_confidence: b.conf,
    ...(b.bold !== undefined ? { is_bold: b.bold } : {}),
    ...(b.italic !== undefined ? { is_italic: b.italic } : {}),
  }));

  return {
    version: TRAINING_SESSION_VERSION,
    // The vocabulary in force right now — this book has not been labelled under
    // any other one.
    labelSet: [...BLOCK_CATEGORY_IDS],
    savedAt: new Date().toISOString(),
    sourceFile: raw.pdf,
    blockSource: 'ocr',
    ocrEngine: raw.engine ?? null,
    pageDimensions: raw.pageDimensions,
    blocks,
    labels: {},
  };
}

/**
 * Find the document these blocks were recognized from.
 *
 * The recorded `sourceFile` is an absolute path from the machine that OCR'd the
 * book, so it can point at a library project that has since been deleted — which
 * is the whole situation this feature exists for. A PDF sitting in the corpus
 * directory itself is the other legitimate home, and is reported as such rather
 * than substituted silently.
 */
async function resolvePdf(dir: string, session: TrainingSession | null):
  Promise<{ pdfPath: string; pdfSource: 'book.json' | 'recorded' | 'sibling' }> {
  // book.json first: it is the only one of the three a human set deliberately.
  const record = await readBookRecord(dir);
  if (record?.pdfPath) {
    const declared = normalizeFsPath(record.pdfPath);
    if (await exists(declared)) return { pdfPath: declared, pdfSource: 'book.json' };
  }

  const recorded = session?.sourceFile ? normalizeFsPath(session.sourceFile) : null;
  if (recorded && await exists(recorded)) {
    return { pdfPath: recorded, pdfSource: 'recorded' };
  }

  const siblings = (await fsPromises.readdir(dir))
    .filter(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('._'))
    .map(f => path.join(dir, f));

  if (siblings.length === 1) {
    return { pdfPath: siblings[0], pdfSource: 'sibling' };
  }
  if (siblings.length > 1) {
    throw new Error(
      `${dir} holds ${siblings.length} PDFs, so which one these blocks came from is ambiguous. ` +
      `The recorded source (${recorded ?? 'none'}) is not on this machine.`
    );
  }
  throw new Error(
    `The document these blocks came from is not on this machine: ` +
    `${record?.pdfPath ?? recorded ?? '(none recorded)'}. ` +
    `Put a copy of it in ${dir} and open the book again.`
  );
}

/** Open a corpus book: its blocks, its labels, and the PDF they belong to. */
export async function loadCorpusBook(target: string): Promise<CorpusBook> {
  const dir = await resolveCorpusDir(target);
  const labelsFile = path.join(dir, 'labels.json');
  const blocksFile = path.join(dir, 'blocks.json');

  let session: TrainingSession | null;
  let from: 'labels.json' | 'blocks.json' | 'book.json';
  let labelled: boolean;

  if (await exists(labelsFile)) {
    session = asSession(labelsFile, await readJson(labelsFile));
    from = 'labels.json';
    labelled = true;
  } else if (await exists(blocksFile)) {
    session = sessionFromBlocksFile(blocksFile, await readJson(blocksFile));
    from = 'blocks.json';
    labelled = false;
  } else if (await exists(path.join(dir, 'book.json'))) {
    // Added, never OCR'd. There is no snapshot to pin the editor to, so it opens
    // the PDF the ordinary way and OCR is the next thing to do.
    session = null;
    from = 'book.json';
    labelled = false;
  } else {
    throw new Error(
      `${dir} has none of book.json, blocks.json or labels.json — it is not a training book.`
    );
  }

  const { pdfPath, pdfSource } = await resolvePdf(dir, session);
  return { dir, slug: path.basename(dir), pdfPath, pdfSource, from, labelled, session };
}

/** Read book.json, or null when this book predates it. */
async function readBookRecord(dir: string): Promise<TrainingBookRecord | null> {
  const file = path.join(dir, 'book.json');
  if (!await exists(file)) return null;
  const parsed = await readJson(file) as Partial<TrainingBookRecord>;
  if (!parsed || typeof parsed.pdfPath !== 'string') {
    throw new Error(`${file} has no pdfPath — it does not describe a training book.`);
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title : path.basename(dir),
    pdfPath: parsed.pdfPath,
    addedAt: typeof parsed.addedAt === 'string' ? parsed.addedAt : '',
  };
}

/**
 * Every training book, for the Training tab.
 *
 * A DIRECTORY IS A BOOK ONLY IF it holds book.json, blocks.json or labels.json.
 * That test matters because the corpus root is also where the tooling keeps its
 * working directories — `sft/`, `dagger/`, `galley/`, `epub-derived/`, loose
 * `eval-*.json` — and listing those as books would invite someone to open one.
 *
 * Counts are read from the files rather than cached in book.json. A cache would
 * be a second place the truth lives, and the point of this tab is that what it
 * shows is what is on disk.
 *
 * One book failing does not fail the list: a corrupt or PDF-less book is
 * reported WITH its problem, because a book you cannot open is exactly the thing
 * you need to see in order to fix it.
 */
export async function listTrainingBooks(): Promise<TrainingBookSummary[]> {
  const root = trainingRootDir();
  let entries: string[];
  try {
    entries = await fsPromises.readdir(root);
  } catch {
    return [];   // no corpus on this machine yet — an empty tab, not an error
  }

  const books: TrainingBookSummary[] = [];
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    try {
      if (!(await fsPromises.stat(dir)).isDirectory()) continue;
    } catch { continue; }

    const has = {
      book: await exists(path.join(dir, 'book.json')),
      blocks: await exists(path.join(dir, 'blocks.json')),
      labels: await exists(path.join(dir, 'labels.json')),
    };
    if (!has.book && !has.blocks && !has.labels) continue;

    const summary: TrainingBookSummary = {
      dir, slug: name, title: name,
      state: has.labels ? 'labelled' : has.blocks ? 'ocr' : 'added',
      pdfPath: null, pages: 0, blocks: 0, labelled: 0, savedAt: null, problem: null,
    };

    try {
      const record = await readBookRecord(dir);
      if (record) summary.title = record.title;

      let session: TrainingSession | null = null;
      if (has.labels) {
        session = asSession(labelsPath(dir), await readJson(labelsPath(dir)));
      } else if (has.blocks) {
        session = sessionFromBlocksFile(blocksPath(dir), await readJson(blocksPath(dir)));
      }
      if (session) {
        summary.pages = session.pageDimensions.length;
        summary.blocks = session.blocks.length;
        summary.labelled = Object.keys(session.labels ?? {}).length;
        summary.savedAt = has.labels ? session.savedAt : null;
      }

      summary.pdfPath = (await resolvePdf(dir, session)).pdfPath;
    } catch (err) {
      summary.problem = (err as Error).message;
    }
    books.push(summary);
  }
  return books;
}

const labelsPath = (dir: string) => path.join(dir, 'labels.json');
const blocksPath = (dir: string) => path.join(dir, 'blocks.json');

/** Strip a filename down to something safe to use as a directory name. */
function slugify(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const slug = base
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug || 'book';
}

/**
 * Add a PDF to the corpus: mint its directory and record where the file lives.
 *
 * Does NOT copy the PDF and does NOT OCR it — both are big enough to be their
 * own explicit step. What this guarantees is a directory `loadCorpusBook` can
 * open and `saveTrainingBlocks` can write into.
 *
 * A name collision gets a suffix rather than joining the existing book. Two
 * different scans of one title is a normal thing to want; silently merging them
 * into one folder would put two segmentations under one set of labels.
 */
export async function createTrainingBook(
  pdfPath: string,
  opts: { title?: string } = {},
): Promise<TrainingBookSummary> {
  const source = normalizeFsPath(pdfPath);
  if (!await exists(source)) throw new Error(`No such file: ${source}`);
  if (!/\.pdf$/i.test(source)) {
    throw new Error(`${path.basename(source)} is not a PDF. Training books are scans.`);
  }

  const root = trainingRootDir();
  await fsPromises.mkdir(root, { recursive: true });

  const wanted = slugify(path.basename(source));
  let slug = wanted;
  for (let n = 2; await exists(path.join(root, slug)); n++) slug = `${wanted}_${n}`;

  const dir = path.join(root, slug);
  await fsPromises.mkdir(dir);

  const record: TrainingBookRecord = {
    title: opts.title?.trim() || path.basename(source).replace(/\.[^.]+$/, ''),
    pdfPath: path.resolve(source),
    addedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(dir, 'book.json'), record);

  return {
    dir, slug, title: record.title, state: 'added',
    pdfPath: record.pdfPath, pages: 0, blocks: 0, labelled: 0,
    savedAt: null, problem: null,
  };
}

/** What the picker hands over after an OCR pass. */
export interface TrainingBlocksInput {
  blocks: Array<TrainingBlock & { line_boxes?: Array<[number, number, number, number]> }>;
  pageDimensions: Array<{ width: number; height: number }>;
  sourceFile: string;
  ocrEngine?: string | null;
}

/**
 * Record what OCR produced, so the labels a human adds next have something
 * stable to be keyed to.
 *
 * REFUSES to overwrite a book that already carries labels. Re-OCR mints new
 * block ids (`ocr_p3_k2x9f1_17` — the suffix is per run), so it does not update
 * those labels, it orphans every one of them. `force` accepts that and moves
 * labels.json aside to `labels.orphaned-<timestamp>.json` rather than deleting
 * it: the caller decided the blocks were wrong, not that the work was worthless.
 *
 * Writes the same fields as `cli/ocr-pdf.js` so the two producers cannot
 * disagree about what a corpus file looks like.
 */
export async function saveTrainingBlocks(
  target: string,
  input: TrainingBlocksInput,
  opts: { force?: boolean } = {},
): Promise<{ path: string; blocks: number; orphanedLabels: string | null }> {
  const dir = await resolveCorpusDir(target);
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw new Error('OCR produced no blocks; nothing was written.');
  }
  if (!Array.isArray(input.pageDimensions) || input.pageDimensions.length === 0) {
    throw new Error('No page dimensions came with these blocks, so they cannot be placed.');
  }

  let orphanedLabels: string | null = null;
  if (await exists(labelsPath(dir))) {
    const existing = asSession(labelsPath(dir), await readJson(labelsPath(dir)));
    const count = Object.keys(existing.labels ?? {}).length;
    if (count > 0 && !opts.force) {
      throw new Error(
        `${path.basename(dir)} already carries ${count} hand labels, and re-running OCR mints new ` +
        'block ids that none of them point at. Nothing was written.'
      );
    }
    if (count > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      orphanedLabels = path.join(dir, `labels.orphaned-${stamp}.json`);
      await fsPromises.rename(labelsPath(dir), orphanedLabels);
    } else {
      await fsPromises.unlink(labelsPath(dir));
    }
  }

  const blocks = [...input.blocks]
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    .map(b => {
      const dims = input.pageDimensions[b.page] ?? { width: 0, height: 0 };
      return {
        id: b.id,
        page: b.page,
        x: b.x, y: b.y, w: b.width, h: b.height,
        text: b.text,
        // The heuristic's answer, kept as the starting paint a human corrects.
        category: b.category_id,
        lineCount: b.line_count,
        lineBoxes: (b.line_boxes ?? []).map(([x, y, w, h]) => ({ x, y, w, h })),
        fsize: b.font_size,
        conf: b.ocr_confidence,
        ...(b.font_name && b.font_name !== 'OCR' ? { fontName: b.font_name } : {}),
        ...(b.is_bold !== undefined ? { bold: b.is_bold } : {}),
        ...(b.is_italic !== undefined ? { italic: b.is_italic } : {}),
        pageW: dims.width, pageH: dims.height,
      };
    });

  await writeJsonAtomic(blocksPath(dir), {
    pdf: path.resolve(normalizeFsPath(input.sourceFile)),
    engine: input.ocrEngine ?? 'tesseract',
    producer: 'BookForge Training tab (picker OCR path)',
    // Files WITHOUT this field are the old shape: raw Tesseract paragraphs.
    segmentation: 'post-processed',
    pageDimensions: input.pageDimensions,
    blocks,
  }, 1);

  return { path: blocksPath(dir), blocks: blocks.length, orphanedLabels };
}

/** Temp + rename, so a crash mid-write cannot leave a half-file. */
async function writeJsonAtomic(file: string, value: unknown, indent = 2): Promise<void> {
  const temp = `${file}.tmp`;
  await fsPromises.writeFile(temp, JSON.stringify(value, null, indent), 'utf-8');
  await fsPromises.rename(temp, file);
}

export interface CorpusSaveResult {
  path: string;
  /** Labels in the file after the write. */
  labelCount: number;
  /** Blocks whose label changed class. */
  changed: number;
  /** Blocks labelled that were not labelled before. */
  added: number;
  /** Blocks that had a label and no longer do — surfaced, never silent. */
  removed: number;
}

/**
 * Write hand-edited labels back to the book's own labels.json.
 *
 * READ-MODIFY-WRITE, not replace: `sourceFile`, `blockSource`, `ocrEngine`,
 * `pageDimensions` and the block snapshot are the provenance of the corpus and
 * are carried through untouched. Only `labels`, `labelSet` and `savedAt` change.
 *
 * Two refusals, both about not corrupting the corpus with a wrong write:
 *
 *  - a label keyed to a block id the snapshot does not contain means the editor
 *    is holding a DIFFERENT segmentation of this book (a re-OCR mints new ids),
 *    and writing it would orphan the labels that are already there;
 *  - a class outside the current thirteen is rejected unless the file already
 *    used it for that same block. That keeps custom categories out of the corpus
 *    while preserving the retired classes older books were labelled under
 *    (`front_matter` still labels 273 blocks of one book) — which the editor
 *    cannot assign, so it can only ever be carrying them forward.
 *
 * Atomic (temp + rename): a crash mid-write cannot leave a half-file where hours
 * of labelling used to be.
 */
export async function saveCorpusLabels(
  target: string,
  update: { labels: Record<string, string>; labelSet: string[] },
): Promise<CorpusSaveResult> {
  const dir = await resolveCorpusDir(target);
  const labelsFile = path.join(dir, 'labels.json');
  const blocksFile = path.join(dir, 'blocks.json');

  // The base is the file being updated. For a book that has only ever been
  // OCR'd, the first save is what materializes labels.json — from blocks.json,
  // so the snapshot the labels key to is written alongside them.
  let base: TrainingSession;
  if (await exists(labelsFile)) {
    base = asSession(labelsFile, await readJson(labelsFile));
  } else if (await exists(blocksFile)) {
    base = sessionFromBlocksFile(blocksFile, await readJson(blocksFile));
  } else {
    throw new Error(`${dir} has neither labels.json nor blocks.json — there is nothing to save into.`);
  }

  const blockIds = new Set(base.blocks.map(b => b.id));
  const previous = base.labels ?? {};
  const legal = new Set(BLOCK_CATEGORY_IDS);

  const unknownBlocks: string[] = [];
  const unknownClasses: string[] = [];
  for (const [blockId, categoryId] of Object.entries(update.labels)) {
    if (!blockIds.has(blockId)) {
      unknownBlocks.push(blockId);
      continue;
    }
    if (!legal.has(categoryId) && previous[blockId] !== categoryId) {
      unknownClasses.push(`${blockId} -> ${categoryId}`);
    }
  }
  if (unknownBlocks.length > 0) {
    throw new Error(
      `${unknownBlocks.length} label(s) name blocks that are not in ${labelsFile} ` +
      `(e.g. ${unknownBlocks.slice(0, 3).join(', ')}). The document open in the editor is segmented ` +
      'differently from the one these labels belong to. Nothing was written.'
    );
  }
  if (unknownClasses.length > 0) {
    throw new Error(
      `${unknownClasses.length} label(s) use a class outside the current set ` +
      `(e.g. ${unknownClasses.slice(0, 3).join(', ')}). Nothing was written.`
    );
  }

  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const [blockId, categoryId] of Object.entries(update.labels)) {
    if (previous[blockId] === undefined) added++;
    else if (previous[blockId] !== categoryId) changed++;
  }
  for (const blockId of Object.keys(previous)) {
    if (update.labels[blockId] === undefined) removed++;
  }

  // Spread first so every field this function does not own survives, including
  // any a future version of the corpus format adds.
  const next: TrainingSession = {
    ...base,
    labelSet: update.labelSet,
    savedAt: new Date().toISOString(),
    labels: update.labels,
  };

  const temp = `${labelsFile}.tmp`;
  await fsPromises.writeFile(temp, JSON.stringify(next, null, 2), 'utf-8');
  await fsPromises.rename(temp, labelsFile);

  return {
    path: labelsFile,
    labelCount: Object.keys(update.labels).length,
    changed, added, removed,
  };
}
