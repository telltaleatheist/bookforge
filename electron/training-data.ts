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
  const temp = `${target}.tmp`;
  await fsPromises.writeFile(temp, JSON.stringify(session, null, 2), 'utf-8');
  await fsPromises.rename(temp, target);
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
  const temp = `${target}.tmp`;
  await fsPromises.writeFile(temp, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  await fsPromises.rename(temp, target);
  return target;
}
