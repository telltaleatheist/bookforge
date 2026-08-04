/**
 * Training-data sessions — archived hand-labelling work.
 *
 * Labels are project state now (`category_corrections`), set in the editor's
 * Label mode and saved with the book. The sessions here are what came before
 * that: books hand-labelled when labelling had its own separate store. They are
 * treated as an archive — read to migrate a book's labels into its project,
 * never rewritten and never deleted. `saveSession` writes only for a book that
 * has no session at all, and there is no delete.
 *
 *   labels.json    block snapshot + labels (self-contained)
 *   dataset.jsonl  exported training records (derived; may be re-exported)
 *
 * labels.json snapshots the blocks alongside the labels rather than storing
 * blockId → category alone. OCR block IDs carry a random per-run batch suffix
 * (`ocr_p3_k2x9f1_17`), so re-running OCR would silently orphan every label
 * that pointed at the old IDs. Snapshotting also gives the dataset honest
 * provenance: the exact blocks a label was applied to are recoverable later.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { randomUUID } from 'crypto';
import type { CorpusPageType } from '../shared/ocr/page-types';

/** Bumped when the on-disk shape changes incompatibly. */
export const TRAINING_SESSION_VERSION = 1;

/**
 * Atomic write with a UNIQUE temp name per call.
 *
 * A fixed `${target}.tmp` loses a race the moment two saves overlap: both write
 * the same temp file, the first rename consumes it, the second throws ENOENT —
 * exactly what happened when a wedged renderer flushed several queued ⌘S saves
 * at once (Aug 1 2026, satanic-panic). The temp is removed on failure so a
 * crashed write never leaves droppings next to the corpus.
 */
export async function atomicWrite(target: string, data: string): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await fsPromises.writeFile(temp, data, 'utf-8');
    await fsPromises.rename(temp, target);
  } catch (err) {
    try { await fsPromises.unlink(temp); } catch { /* already gone */ }
    throw err;
  }
}

export interface TrainingBlock {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
  font_name: string;
  char_count: number;
  region: string;
  category_id: string;
  is_bold?: boolean;
  is_italic?: boolean;
  is_superscript?: boolean;
  is_image?: boolean;
  line_count?: number;
  /**
   * The recognized lines this block was built from, as [x, y, width, height] in
   * page points — the same field, and the same shape, as `TextBlock.line_boxes`.
   *
   * Declared here because blocks.json persists it and the corpus loader reads it
   * back. While it was missing from this type, `TrainingBlocksInput` carried it
   * as an intersection bolt-on so the WRITER could emit it, and the reader — typed
   * to this interface — had nowhere to put it and silently dropped it.
   */
  line_boxes?: Array<[number, number, number, number]>;
  is_ocr?: boolean;
  ocr_par_key?: string;
  ocr_confidence?: number;
  ocr_descender_ratio?: number;
}

export interface TrainingSession {
  version: number;
  /**
   * The label vocabulary this session was produced under. Categories get added
   * over time (`chapter`, `front_matter` and `back_matter` all arrived after
   * the first ones); without recording the set in force at labelling time you
   * cannot tell whether a book predates a category or genuinely contains none
   * of it — which silently corrupts training.
   */
  labelSet: string[];
  savedAt: string;
  /** Source document the blocks came from, relative to the project dir. */
  sourceFile?: string;
  /**
   * How the blocks were produced. 'embedded' means the PDF already carried a
   * text layer and mupdf extracted it; 'ocr' means an engine recognized them
   * here. Recorded because the two have materially different feature
   * distributions — an embedded layer has real font names and weights, and
   * every engine segments paragraphs differently.
   */
  blockSource?: 'embedded' | 'ocr';
  /** Which OCR engine, when blockSource is 'ocr'. */
  ocrEngine?: string | null;
  pageDimensions: Array<{ width: number; height: number }>;
  blocks: TrainingBlock[];
  /** blockId → categoryId, set by hand. Ground truth. */
  labels: Record<string, string>;
  /**
   * Page index (as a decimal string) → what the whole page was declared to be.
   *
   * BOOKKEEPING, not training data: marking a page is a shortcut that writes
   * ordinary entries into `labels`, and `labels` is the only thing the corpus
   * gatherer and the encoder read. This records which pages were marked so the
   * editor can say "page 4 is already the title page" and so a mark can be
   * taken back — clearing one leaves the labels it made alone, because by then
   * they are the human's judgements like any other.
   */
  pageTypes?: Record<string, CorpusPageType>;
}

/**
 * Training data lives OUTSIDE the synced library. Three reasons, all learned
 * the hard way:
 *
 * - Syncthing conflicts: the library already carries .sync-conflict files, and
 *   a half-synced labels.json from another machine silently replacing hours of
 *   labelling is exactly the kind of loss the session was designed to prevent.
 * - Labelling sessions reference machine-local absolute paths (sourceFile) and
 *   OCR output produced on THIS machine; syncing them to a box with different
 *   mount points would present them as valid when they are not.
 * - iCloud eviction: the old home (~/Documents/BookForge/training) sat inside
 *   iCloud-synced Documents, which silently dematerializes files and spawns
 *   "name 2.json" conflict copies. The corpus master now lives on Callisto
 *   (Aug 2026), which no sync service touches.
 *
 * On macOS the corpus master is /Volumes/Callisto/training/rubric. The guard
 * throws when the volume is not mounted: writing to an unmounted /Volumes path
 * would silently create a phantom directory on the boot volume, which is worse
 * than failing. Other platforms keep the machine-local Documents path.
 *
 * Keyed by the project folder's basename, which is unique within a library.
 */
export function trainingRootDir(): string {
  if (process.platform === 'darwin') {
    if (!fs.existsSync('/Volumes/Callisto')) {
      throw new Error(
        'Training corpus volume is not mounted: /Volumes/Callisto. ' +
        'Mount it — the corpus master lives at /Volumes/Callisto/training/rubric.');
    }
    return '/Volumes/Callisto/training/rubric';
  }
  return path.join(os.homedir(), 'Documents', 'BookForge', 'training');
}

/**
 * The OCR lab — `<training>/ocr-lab/`, a SIBLING of the corpus master.
 *
 * The lab is where a book's scan is rendered, banded, recognized and scored, and
 * `ocr-lab/gold/<book>/` is where its actual source files live (`scan.pdf` or
 * `source.pdf`, `source.epub`, and `pdfelement.pdf` for the books with no EPUB).
 * That is the only place on this machine holding the PDF+EPUB pairs, so the
 * Training tab reads it to list them — see `listPairedBooks`.
 *
 * Derived from `trainingRootDir()` rather than hardcoded so the two move
 * together: on macOS that is /Volumes/Callisto/training/ocr-lab, and on any
 * other platform the sibling of the machine-local training dir.
 */
export function ocrLabRootDir(): string {
  return path.join(path.dirname(trainingRootDir()), 'ocr-lab');
}

function trainingDir(projectDir: string): string {
  const slug = path.basename(projectDir.replace(/[\\/]+$/, ''));
  return path.join(trainingRootDir(), slug);
}

/**
 * Move a session out of the old in-project location ({projectDir}/training/)
 * if one is there and the new home doesn't already have that file. rename()
 * fails across devices (library on ExFAT, home on APFS), so fall back to
 * copy + unlink.
 */
async function migrateLegacySession(projectDir: string): Promise<void> {
  const legacyDir = path.join(projectDir, 'training');
  const newDir = trainingDir(projectDir);
  for (const name of ['labels.json', 'dataset.jsonl']) {
    const from = path.join(legacyDir, name);
    const to = path.join(newDir, name);
    try { await fsPromises.access(from); } catch { continue; }
    try { await fsPromises.access(to); continue; } catch { /* new home is free — migrate */ }
    await fsPromises.mkdir(newDir, { recursive: true });
    try {
      await fsPromises.rename(from, to);
    } catch {
      await fsPromises.copyFile(from, to);
      await fsPromises.unlink(from);
    }
    console.log(`[training-data] Migrated ${name} out of the synced library -> ${to}`);
  }
  try { await fsPromises.rmdir(legacyDir); } catch { /* not empty or absent — leave it */ }
}

export function labelsPath(projectDir: string): string {
  return path.join(trainingDir(projectDir), 'labels.json');
}

export function datasetPath(projectDir: string): string {
  return path.join(trainingDir(projectDir), 'dataset.jsonl');
}

/**
 * Write a labelling session, unless one is already there.
 *
 * Labels live in the book's project file now; a session here is the archived
 * hand-labelling work that predates that, and it is the only copy of itself.
 * So this writes a snapshot for a book that has never been labelled and
 * otherwise reports `written: false` — an existing labels.json is never
 * replaced, however accurate the new snapshot looks.
 *
 * The write is atomic (temp + rename) so a crash mid-write can't leave a
 * half-written file where a complete one used to be.
 */
export async function saveSession(
  projectDir: string,
  session: TrainingSession,
): Promise<{ written: boolean; path: string }> {
  await migrateLegacySession(projectDir);
  const target = labelsPath(projectDir);

  try {
    await fsPromises.access(target);
    return { written: false, path: target };
  } catch { /* nothing there yet — safe to write */ }

  await fsPromises.mkdir(trainingDir(projectDir), { recursive: true });
  await atomicWrite(target, JSON.stringify(session, null, 2));
  return { written: true, path: target };
}

/** Read a labelling session, or null when the book has never been labelled. */
export async function loadSession(projectDir: string): Promise<TrainingSession | null> {
  await migrateLegacySession(projectDir);
  try {
    const raw = await fsPromises.readFile(labelsPath(projectDir), 'utf-8');
    const session = JSON.parse(raw) as TrainingSession;
    if (session.version !== TRAINING_SESSION_VERSION) {
      throw new Error(
        `Unsupported training session version ${session.version} ` +
        `(this build reads version ${TRAINING_SESSION_VERSION})`
      );
    }
    return session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/*
 * There is deliberately no reset/delete here. Clearing a book's labels is done
 * in its project, where the labels now live; the archived session stays put.
 */

/** Write exported JSONL records, one per line. */
export async function writeDataset(projectDir: string, records: unknown[]): Promise<string> {
  await migrateLegacySession(projectDir);
  const dir = trainingDir(projectDir);
  await fsPromises.mkdir(dir, { recursive: true });

  const target = datasetPath(projectDir);
  await atomicWrite(target, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return target;
}
