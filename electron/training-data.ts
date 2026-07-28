/**
 * Training-data sessions.
 *
 * Labelling a book for model training is a different activity from editing it
 * for production, and the two must not share state. A book that already has a
 * cleaned.epub and an audiobook.m4b can be re-opened and relabelled from
 * scratch without any risk to those artifacts, because everything a labelling
 * session touches lives under {projectDir}/training/ and nothing else writes
 * there.
 *
 *   training/labels.json    block snapshot + labels (self-contained)
 *   training/dataset.jsonl  exported training records
 *
 * labels.json snapshots the blocks alongside the labels rather than storing
 * blockId → category alone. OCR block IDs carry a random per-run batch suffix
 * (`ocr_p3_k2x9f1_17`), so re-running OCR would silently orphan every label
 * that pointed at the old IDs. Snapshotting also gives the dataset honest
 * provenance: the exact blocks a label was applied to are recoverable later.
 */

import * as path from 'path';
import * as os from 'os';
import * as fsPromises from 'fs/promises';

/** Bumped when the on-disk shape changes incompatibly. */
export const TRAINING_SESSION_VERSION = 1;

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
}

/**
 * Training data lives OUTSIDE the synced library, under the same machine-local
 * home as the render cache (~/Documents/BookForge/). Two reasons, both learned
 * the hard way:
 *
 * - Syncthing conflicts: the library already carries .sync-conflict files, and
 *   a half-synced labels.json from another machine silently replacing hours of
 *   labelling is exactly the kind of loss the session was designed to prevent.
 * - Labelling sessions reference machine-local absolute paths (sourceFile) and
 *   OCR output produced on THIS machine; syncing them to a box with different
 *   mount points would present them as valid when they are not.
 *
 * Keyed by the project folder's basename, which is unique within a library.
 */
function trainingRootDir(): string {
  return path.join(os.homedir(), 'Documents', 'BookForge', 'training');
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
 * Write a labelling session. Atomic (temp + rename) so a crash mid-write can't
 * leave a half-written labels.json where a complete one used to be — the
 * session may represent hours of manual work.
 */
export async function saveSession(projectDir: string, session: TrainingSession): Promise<void> {
  await migrateLegacySession(projectDir);
  const dir = trainingDir(projectDir);
  await fsPromises.mkdir(dir, { recursive: true });

  const target = labelsPath(projectDir);
  const temp = `${target}.tmp`;
  await fsPromises.writeFile(temp, JSON.stringify(session, null, 2), 'utf-8');
  await fsPromises.rename(temp, target);
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

/**
 * Discard a labelling session so the book can be relabelled from scratch.
 *
 * Only ever removes files under training/. source/, stages/ and output/ are
 * structurally out of reach, so an existing exported.epub, cleaned.epub or
 * audiobook.m4b cannot be affected by a reset.
 */
export async function resetSession(projectDir: string): Promise<void> {
  // Remove from BOTH homes: a reset must leave no stale copy for migration to
  // resurrect later.
  const legacy = path.join(projectDir, 'training');
  for (const target of [
    labelsPath(projectDir), datasetPath(projectDir),
    path.join(legacy, 'labels.json'), path.join(legacy, 'dataset.jsonl'),
  ]) {
    try {
      await fsPromises.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** Write exported JSONL records, one per line. */
export async function writeDataset(projectDir: string, records: unknown[]): Promise<string> {
  await migrateLegacySession(projectDir);
  const dir = trainingDir(projectDir);
  await fsPromises.mkdir(dir, { recursive: true });

  const target = datasetPath(projectDir);
  const temp = `${target}.tmp`;
  await fsPromises.writeFile(temp, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  await fsPromises.rename(temp, target);
  return target;
}
