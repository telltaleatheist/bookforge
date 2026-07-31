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
 * only place a corpus book has state, and `saveCorpusLabels` is the only writer.
 *
 *   labels.json   THE file: a block snapshot plus `labels` (blockId -> class)
 *   blocks.json   raw OCR output, for a book that has never been labelled
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
  pdfSource: 'recorded' | 'sibling';
  /** Which file the blocks came from. */
  from: 'labels.json' | 'blocks.json';
  /** False when this book has no labels.json at all — a valid starting state. */
  labelled: boolean;
  session: TrainingSession;
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
async function resolvePdf(dir: string, session: TrainingSession):
  Promise<{ pdfPath: string; pdfSource: 'recorded' | 'sibling' }> {
  const recorded = session.sourceFile ? normalizeFsPath(session.sourceFile) : null;
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
    `The document these blocks came from is not on this machine: ${recorded ?? '(none recorded)'}. ` +
    `Put a copy of it in ${dir} and open the book again.`
  );
}

/** Open a corpus book: its blocks, its labels, and the PDF they belong to. */
export async function loadCorpusBook(target: string): Promise<CorpusBook> {
  const dir = await resolveCorpusDir(target);
  const labelsFile = path.join(dir, 'labels.json');
  const blocksFile = path.join(dir, 'blocks.json');

  let session: TrainingSession;
  let from: 'labels.json' | 'blocks.json';
  let labelled: boolean;

  if (await exists(labelsFile)) {
    session = asSession(labelsFile, await readJson(labelsFile));
    from = 'labels.json';
    labelled = true;
  } else if (await exists(blocksFile)) {
    session = sessionFromBlocksFile(blocksFile, await readJson(blocksFile));
    from = 'blocks.json';
    labelled = false;
  } else {
    throw new Error(`${dir} has neither labels.json nor blocks.json — it is not a corpus book.`);
  }

  const { pdfPath, pdfSource } = await resolvePdf(dir, session);
  return { dir, slug: path.basename(dir), pdfPath, pdfSource, from, labelled, session };
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
