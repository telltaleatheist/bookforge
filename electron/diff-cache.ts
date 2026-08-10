/**
 * Diff Cache - Pre-compute and store diffs during AI cleanup
 *
 * This module computes word-level diffs during AI cleanup (when we already have
 * both original and cleaned text) and stores them in a .diff.json file alongside
 * the cleaned/simplified EPUB. When the user opens Review Changes, loading is instant.
 *
 * INCREMENTAL WRITES: The cache is written after each chapter completes, so
 * partial progress is available even if the job is still running or was interrupted.
 */

import { promises as fsPromises } from 'fs';
import path from 'path';
import { diffWords } from 'diff';
import { hydratePassDiff } from '../shared/document/pass-diff.js';

/**
 * Write the diff cache JSON atomically: stage on the same volume, then rename
 * into place. The cache sits next to the cleaned EPUB in the (often Syncthing-
 * synced) project dir and is rewritten after EVERY chapter — a direct writeFile
 * lets Syncthing observe a half-written file and spawn sync-conflict copies. An
 * atomic rename means the file only ever appears complete.
 */
async function writeDiffCacheAtomic(diffPath: string, cache: DiffCacheFile): Promise<void> {
  // Unique staging name so concurrent writers can't collide on one shared .tmp,
  // and unlink-on-failure so a failed write never leaves a stray temp behind.
  const stagePath = `${diffPath}.${process.pid}.tmp`;
  try {
    await fsPromises.writeFile(stagePath, JSON.stringify(cache, null, 2), 'utf-8');
    await fsPromises.rename(stagePath, diffPath);
  } catch (err) {
    await fsPromises.unlink(stagePath).catch(() => {});
    throw err;
  }
}

/**
 * Derive the sibling `.diff.json` path for a cleaned EPUB. Using path.extname
 * (rather than String.replace('.epub', …)) guarantees we never return a path
 * equal to the input: a `.EPUB`, extension-less, or `x.epub/`-folder input would
 * make replace() a no-op, and the atomic write would then clobber the cleaned
 * EPUB itself with diff JSON. Fail loudly if there's no extension to strip.
 */
function deriveDiffPath(cleanedEpubPath: string): string {
  const ext = path.extname(cleanedEpubPath);
  if (!ext) {
    throw new Error(`Cannot derive diff-cache path: "${cleanedEpubPath}" has no file extension`);
  }
  return `${cleanedEpubPath.slice(0, -ext.length)}.diff.json`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact representation of a diff change.
 * Much smaller than DiffWord[] - stores only the changes, not unchanged text.
 */
export interface DiffChange {
  /** Position in cleaned text (character index) */
  pos: number;
  /** Length in cleaned text (0 for deletions) */
  len: number;
  /** Added text (undefined if deletion-only) */
  add?: string;
  /** Removed text (undefined if addition-only) */
  rem?: string;
  /**
   * Set when this change removed a FOOTNOTE REFERENCE MARKER, and where the proof
   * came from: 'archive' = the original EPUB's own <sup> markup, 'inferred' = the
   * sequence-based pipeline.
   *
   * It exists because a marker is often deleted at the exact spot a curly quote is
   * straightened (`cursive.”12 Why` -> `cursive." Why`), and a raw original-vs-final
   * diff has no way to report that as two things — it emits one `”12` -> `"` edit
   * that reads as a quote change, and the marker removal becomes invisible. Review
   * Changes is the single source of truth for what the pipeline did, so the removal
   * has to be visible even when it shares a span with another edit.
   */
  fn?: 'archive' | 'inferred';
}

export interface DiffCacheChapter {
  id: string;
  title: string;
  originalCharCount: number;
  cleanedCharCount: number;
  changeCount: number;
  changes: DiffChange[];
  /**
   * The text the changes are positioned in — present only in a PASS diff.
   *
   * The cleanup cache omits it because its "after" text is a file that still
   * exists (`cleaned.epub`) and can be read back at view time. A pass rewrites
   * the book IN PLACE, so by the time anyone opens the diff of the third pass,
   * the text the second pass ended at is gone. A pass diff therefore carries its
   * own after-text and hydrates without touching the book.
   */
  text?: string;
  /**
   * The before-text, present for the same reason and only in a PASS diff: the
   * file it came out of has been overwritten too. With both texts stored, a pass
   * diff is renderable on its own — the reader recomputes the word diff with the
   * same worker every other comparison uses, rather than a second implementation
   * of hydration living in the renderer.
   */
  originalText?: string;
}

export interface DiffCacheFile {
  version: 1;
  createdAt: string;
  updatedAt: string;
  ignoreWhitespace: boolean;
  completed: boolean;  // True when job finished successfully
  originalPath?: string;  // Path of the source EPUB this was compared against
  chapters: DiffCacheChapter[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module State (per-job)
// ─────────────────────────────────────────────────────────────────────────────

let currentOutputPath: string | null = null;
let currentOriginalPath: string | null = null;
let cacheStartTime: string | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize diff cache at the start of a cleanup job.
 * Creates an empty cache file immediately.
 *
 * @param cleanedEpubPath Path to the cleaned/simplified EPUB file (used to derive .diff.json path)
 * @param originalEpubPath Optional path to the source EPUB being compared against
 */
export async function startDiffCache(cleanedEpubPath: string, originalEpubPath?: string): Promise<void> {
  currentOutputPath = cleanedEpubPath;
  cacheStartTime = new Date().toISOString();

  const diffPath = deriveDiffPath(cleanedEpubPath);

  // Store the original's path RELATIVE to the diff file's own location, with
  // forward slashes. The library is shared across machines/OSes via Syncthing,
  // so an absolute path (e.g. "/Volumes/Callisto/…" on Mac vs "E:\…" on
  // Windows) is not portable. The diff file and the original always live at a
  // fixed offset within the same project, so a relative path resolves correctly
  // on whichever machine opens it.
  currentOriginalPath = originalEpubPath
    ? path.relative(path.dirname(cleanedEpubPath), originalEpubPath).replace(/\\/g, '/')
    : null;

  // Create initial empty cache file
  const cache: DiffCacheFile = {
    version: 1,
    createdAt: cacheStartTime,
    updatedAt: cacheStartTime,
    ignoreWhitespace: true,
    completed: false,
    originalPath: currentOriginalPath || undefined,
    chapters: []
  };

  try {
    await writeDiffCacheAtomic(diffPath, cache);
    console.log(`[DIFF-CACHE] Started cache session: ${path.basename(diffPath)}`);
  } catch (err) {
    console.error('[DIFF-CACHE] Failed to create initial cache file:', err);
    // Continue anyway - cache is optional
  }
}

/**
 * Resume an existing diff cache session WITHOUT wiping it.
 *
 * Unlike startDiffCache (which truncates the file to an empty chapter list),
 * this re-attaches the module session state to an existing .diff.json so that
 * subsequent addChapterDiff calls APPEND to the chapters already on disk. Use
 * this when a cleanup job resumes from a checkpoint: the first-half chapters
 * were already diffed on the prior run and must be preserved, not discarded.
 *
 * The existing cache's `completed` flag is reset to false (the job is running
 * again), but its chapters are left intact. If no valid cache exists on disk
 * (e.g. it was deleted), this falls back to starting a fresh cache so the
 * session is still usable.
 *
 * @param cleanedEpubPath Path to the cleaned/simplified EPUB file (used to derive .diff.json path)
 * @param originalEpubPath Optional path to the source EPUB being compared against
 */
export async function resumeDiffCache(cleanedEpubPath: string, originalEpubPath?: string): Promise<void> {
  const diffPath = deriveDiffPath(cleanedEpubPath);

  let cache: DiffCacheFile | null = null;
  try {
    const data = await fsPromises.readFile(diffPath, 'utf-8');
    const parsed = JSON.parse(data) as DiffCacheFile;
    if (parsed.version === 1 && Array.isArray(parsed.chapters)) {
      cache = parsed;
    }
  } catch {
    // No existing cache (or invalid) — fall through to fresh start
  }

  if (!cache) {
    console.warn('[DIFF-CACHE] resumeDiffCache: no existing cache to resume, starting fresh');
    await startDiffCache(cleanedEpubPath, originalEpubPath);
    return;
  }

  currentOutputPath = cleanedEpubPath;
  // Preserve the cache's original createdAt so addChapterDiff (which uses
  // cacheStartTime as a fallback createdAt) doesn't rewind the timestamp.
  cacheStartTime = cache.createdAt || new Date().toISOString();
  currentOriginalPath = originalEpubPath
    ? path.relative(path.dirname(cleanedEpubPath), originalEpubPath).replace(/\\/g, '/')
    : null;

  // Job is running again — no longer complete. Keep chapters intact.
  cache.completed = false;
  cache.updatedAt = new Date().toISOString();
  if (currentOriginalPath) cache.originalPath = currentOriginalPath;

  try {
    await writeDiffCacheAtomic(diffPath, cache);
    console.log(`[DIFF-CACHE] Resumed cache session with ${cache.chapters.length} existing chapters: ${path.basename(diffPath)}`);
  } catch (err) {
    console.error('[DIFF-CACHE] Failed to write resumed cache file:', err);
    // Continue anyway — cache is optional, and in-memory session is set
  }
}

/**
 * Add a chapter's diff data after it's been cleaned and saved.
 * Computes the diff immediately and writes to the cache file.
 *
 * @param id Chapter ID
 * @param title Chapter title
 * @param originalText Original chapter text (plain text, not XHTML)
 * @param cleanedText Cleaned chapter text
 */
export async function addChapterDiff(
  id: string,
  title: string,
  originalText: string,
  cleanedText: string,
  /** Chapter text with footnote markers removed but quotes/numbers untouched. */
  footnoteOnlyText?: string,
  /** Where those removals came from, recorded on each affected change. */
  footnoteSource: 'archive' | 'inferred' = 'inferred'
): Promise<void> {
  if (!currentOutputPath) {
    console.warn('[DIFF-CACHE] addChapterDiff called but no session active');
    return;
  }

  const diffPath = deriveDiffPath(currentOutputPath);

  try {
    // Read existing cache from disk
    let cache: DiffCacheFile;
    try {
      const data = await fsPromises.readFile(diffPath, 'utf-8');
      cache = JSON.parse(data) as DiffCacheFile;
    } catch {
      cache = {
        version: 1,
        createdAt: cacheStartTime || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ignoreWhitespace: true,
        completed: false,
        chapters: []
      };
    }

    // Compute diff for this chapter
    const { changes, changeCount } = computeCompactDiff(originalText, cleanedText);

    // Attribute the footnote removals. Both diffs end at cleanedText, so their `pos`
    // values live in the SAME coordinate space and can be compared directly. A change
    // that the footnote-free intermediate does not account for — either absent there,
    // or present with less removed text — is one the marker removal contributed to.
    if (footnoteOnlyText !== undefined && footnoteOnlyText !== originalText) {
      const rest = computeCompactDiff(footnoteOnlyText, cleanedText);
      const restByPos = new Map<number, string>();
      for (const r of rest.changes) restByPos.set(r.pos, r.rem ?? '');
      for (const c of changes) {
        const restRem = restByPos.get(c.pos);
        if (restRem === undefined || restRem !== (c.rem ?? '')) c.fn = footnoteSource;
      }
    }

    const chapterData: DiffCacheChapter = {
      id,
      title,
      originalCharCount: originalText.length,
      cleanedCharCount: cleanedText.length,
      changeCount,
      changes
    };

    // Check if chapter already exists (in case of retry/duplicate call)
    const existingIndex = cache.chapters.findIndex(ch => ch.id === id);
    if (existingIndex >= 0) {
      cache.chapters[existingIndex] = chapterData;
    } else {
      cache.chapters.push(chapterData);
    }

    cache.updatedAt = new Date().toISOString();

    // Write back — chapter diff data is not retained in memory
    await writeDiffCacheAtomic(diffPath, cache);
    console.log(`[DIFF-CACHE] Added chapter "${title}" (${cache.chapters.length} total, ${changeCount} changes)`);
  } catch (err) {
    console.error(`[DIFF-CACHE] Failed to add chapter "${title}":`, err);
    // Don't throw - cache is optional
  }
}

/**
 * Mark the diff cache as complete.
 * Call this when the cleanup job completes successfully.
 */
export async function finalizeDiffCache(): Promise<void> {
  if (!currentOutputPath) {
    console.warn('[DIFF-CACHE] finalizeDiffCache called but no session active');
    return;
  }

  const diffPath = deriveDiffPath(currentOutputPath);

  try {
    const data = await fsPromises.readFile(diffPath, 'utf-8');
    const cache = JSON.parse(data) as DiffCacheFile;

    cache.completed = true;
    cache.updatedAt = new Date().toISOString();

    await writeDiffCacheAtomic(diffPath, cache);
    console.log(`[DIFF-CACHE] Finalized cache with ${cache.chapters.length} chapters`);
  } catch (err) {
    console.error('[DIFF-CACHE] Failed to finalize cache:', err);
  }

  // Clear state
  currentOutputPath = null;
  currentOriginalPath = null;
  cacheStartTime = null;
}

/**
 * Clear the diff cache file for a cleaned EPUB.
 * Call this at the start of cleanup to remove stale cache.
 */
export async function clearDiffCache(cleanedEpubPath: string): Promise<void> {
  const diffPath = deriveDiffPath(cleanedEpubPath);
  try {
    await fsPromises.unlink(diffPath);
    console.log(`[DIFF-CACHE] Cleared existing cache: ${path.basename(diffPath)}`);
  } catch {
    // File doesn't exist, that's fine
  }

  // Also clear state in case we're restarting
  if (currentOutputPath === cleanedEpubPath) {
    currentOutputPath = null;
    currentOriginalPath = null;
    cacheStartTime = null;
  }
}

/**
 * Load a pre-computed diff cache file.
 *
 * @param cleanedEpubPath Path to the cleaned/simplified EPUB file
 * @returns The cache data, or null if not found/invalid
 */
export async function loadDiffCacheFile(cleanedEpubPath: string): Promise<DiffCacheFile | null> {
  const diffPath = deriveDiffPath(cleanedEpubPath);

  try {
    const data = await fsPromises.readFile(diffPath, 'utf-8');
    const cache = JSON.parse(data) as DiffCacheFile;

    // Validate version
    if (cache.version !== 1) {
      console.warn('[DIFF-CACHE] Unsupported cache version:', cache.version);
      return null;
    }

    const status = cache.completed ? 'complete' : 'in-progress';
    console.log(`[DIFF-CACHE] Loaded cache with ${cache.chapters.length} chapters (${status})`);
    return cache;
  } catch {
    // File doesn't exist or is invalid
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass diffs
//
// One file per pass, at `stages/NN-<kind>/diff.json`, in the same format the
// Review Changes UI already reads — with the after-text embedded, because the
// file it describes has since been overwritten by the next pass.
// ─────────────────────────────────────────────────────────────────────────────

/** One diffable unit of a pass: a chapter, or a page for the foundry passes. */
export interface PassDiffUnit {
  id: string;
  title: string;
  before: string;
  after: string;
  /**
   * Changes computed by the caller, when it knows them exactly. The footnote
   * pass does: foundry hands it the marker deletions themselves, which is a
   * better answer than re-deriving them from a word diff that cannot tell a
   * removed marker from a straightened quote next to it.
   */
  changes?: DiffChange[];
}

/**
 * Write a complete pass diff. Atomic, like every other write into the library.
 *
 * Written once at the end of the pass rather than per chapter: a pass either
 * applied itself to the book or it did not, and a half-diff of a book that was
 * never replaced describes nothing.
 */
export async function writePassDiff(
  diffPath: string,
  units: PassDiffUnit[],
  originalPath?: string
): Promise<void> {
  const now = new Date().toISOString();
  const chapters: DiffCacheChapter[] = units.map((u) => {
    const computed = u.changes ?? computeCompactDiff(u.before, u.after).changes;
    return {
      id: u.id,
      title: u.title,
      originalCharCount: u.before.length,
      cleanedCharCount: u.after.length,
      changeCount: computed.length,
      changes: computed,
      text: u.after,
      originalText: u.before,
    };
  });

  await fsPromises.mkdir(path.dirname(diffPath), { recursive: true });
  await writeDiffCacheAtomic(diffPath, {
    version: 1,
    createdAt: now,
    updatedAt: now,
    ignoreWhitespace: true,
    completed: true,
    originalPath,
    chapters,
  });
  const changed = chapters.reduce((n, c) => n + c.changeCount, 0);
  console.log(`[DIFF-CACHE] Wrote pass diff ${diffPath}: ${chapters.length} units, ${changed} changes`);
}

/**
 * Read a diff file by its own path.
 *
 * `loadDiffCacheFile` derives the path from the EPUB it sits beside; a pass diff
 * has no such sibling, so it is addressed directly. A malformed file is an error
 * here rather than a null: the manifest said this diff exists, so its absence is
 * a broken record, not a cache miss.
 */
export async function loadDiffFileAt(diffPath: string): Promise<DiffCacheFile> {
  const data = await fsPromises.readFile(diffPath, 'utf-8');
  const cache = JSON.parse(data) as DiffCacheFile;
  if (cache.version !== 1 || !Array.isArray(cache.chapters)) {
    throw new Error(`${diffPath} is not a version-1 diff file; nothing can read it.`);
  }
  return cache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff Computation
//
// Uses the `diff` library (Myers' algorithm) for word-level diffing.
// O(nD) time/space where D = number of edits — effectively linear for
// AI cleanup where most text is unchanged. No large DP tables.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a compact diff using Myers' word-level diff.
 *
 * The `diff` library's `diffWords` returns contiguous text spans tagged as
 * added/removed/unchanged. We convert these to our DiffChange[] format
 * which stores only the changes with character positions into the cleaned text.
 */
export function computeCompactDiff(
  originalText: string,
  cleanedText: string
): { changes: DiffChange[]; changeCount: number } {
  if (!originalText && !cleanedText) {
    return { changes: [], changeCount: 0 };
  }

  if (!originalText) {
    return {
      changes: [{ pos: 0, len: cleanedText.length, add: cleanedText }],
      changeCount: 1
    };
  }

  if (!cleanedText) {
    return {
      changes: [{ pos: 0, len: 0, rem: originalText }],
      changeCount: 1
    };
  }

  const parts = diffWords(originalText, cleanedText);

  const changes: DiffChange[] = [];
  let changeCount = 0;
  let cleanedPos = 0;

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (!part.added && !part.removed) {
      // Unchanged — advance position in cleaned text
      cleanedPos += part.value.length;
      i++;
    } else {
      // Collect consecutive added/removed parts into one change
      let removed = '';
      let added = '';
      const changeStart = cleanedPos;

      while (i < parts.length && (parts[i].added || parts[i].removed)) {
        if (parts[i].removed) {
          removed += parts[i].value;
        } else {
          added += parts[i].value;
          cleanedPos += parts[i].value.length;
        }
        i++;
      }

      changes.push({
        pos: changeStart,
        len: added.length,
        add: added || undefined,
        rem: removed || undefined
      });
      changeCount++;
    }
  }

  return { changes, changeCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration (expand compact changes back to DiffWord[])
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffWord {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
  /**
   * Set on a removed/added run that a FOOTNOTE REFERENCE MARKER removal produced,
   * and where the proof came from. Carried through hydration so Review Changes can
   * label it even when the marker shared a span with a quote edit.
   */
  fn?: 'archive' | 'inferred';
}

/**
 * Hydrate compact changes back into a full DiffWord[] array for rendering.
 * This reconstructs the word-level diff from the compact representation.
 *
 * The body lives in shared/document/pass-diff.ts, because the RENDERER hydrates
 * a pass receipt with it too (Review changes reads the receipt's own edit list
 * rather than re-diffing its text — see that file's header for why). Two copies
 * could render the same edit list two different ways; this name is kept because
 * the cleanup-cache callers have always used it.
 *
 * @param changes Compact change array from cache
 * @param cleanedText The full cleaned text for this chapter
 * @returns Full DiffWord[] array for rendering
 */
export function hydrateDiff(changes: DiffChange[], cleanedText: string): DiffWord[] {
  return hydratePassDiff(changes, cleanedText);
}

/**
 * Count changes from DiffWord array.
 */
export function countChangesFromWords(diffWords: DiffWord[]): number {
  return diffWords.filter(w => w.type !== 'unchanged').length;
}
