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
}

export interface DiffCacheChapter {
  id: string;
  title: string;
  originalCharCount: number;
  cleanedCharCount: number;
  changeCount: number;
  changes: DiffChange[];
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
  currentOriginalPath = originalEpubPath || null;
  cacheStartTime = new Date().toISOString();

  const diffPath = cleanedEpubPath.replace('.epub', '.diff.json');

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
    await fsPromises.writeFile(diffPath, JSON.stringify(cache, null, 2), 'utf-8');
    console.log(`[DIFF-CACHE] Started cache session: ${path.basename(diffPath)}`);
  } catch (err) {
    console.error('[DIFF-CACHE] Failed to create initial cache file:', err);
    // Continue anyway - cache is optional
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
  cleanedText: string
): Promise<void> {
  if (!currentOutputPath) {
    console.warn('[DIFF-CACHE] addChapterDiff called but no session active');
    return;
  }

  const diffPath = currentOutputPath.replace('.epub', '.diff.json');

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
    await fsPromises.writeFile(diffPath, JSON.stringify(cache, null, 2), 'utf-8');
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

  const diffPath = currentOutputPath.replace('.epub', '.diff.json');

  try {
    const data = await fsPromises.readFile(diffPath, 'utf-8');
    const cache = JSON.parse(data) as DiffCacheFile;

    cache.completed = true;
    cache.updatedAt = new Date().toISOString();

    await fsPromises.writeFile(diffPath, JSON.stringify(cache, null, 2), 'utf-8');
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
  const diffPath = cleanedEpubPath.replace('.epub', '.diff.json');
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
  const diffPath = cleanedEpubPath.replace('.epub', '.diff.json');

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
}

/**
 * Hydrate compact changes back into a full DiffWord[] array for rendering.
 * This reconstructs the word-level diff from the compact representation.
 *
 * @param changes Compact change array from cache
 * @param cleanedText The full cleaned text for this chapter
 * @returns Full DiffWord[] array for rendering
 */
export function hydrateDiff(changes: DiffChange[], cleanedText: string): DiffWord[] {
  if (changes.length === 0) {
    // No changes - return the cleaned text as unchanged
    return cleanedText ? [{ text: cleanedText, type: 'unchanged' }] : [];
  }

  const result: DiffWord[] = [];
  let lastPos = 0;

  // Sort changes by position
  const sortedChanges = [...changes].sort((a, b) => a.pos - b.pos);

  for (const change of sortedChanges) {
    // Add unchanged text before this change
    if (change.pos > lastPos) {
      const unchangedText = cleanedText.slice(lastPos, change.pos);
      if (unchangedText) {
        result.push({ text: unchangedText, type: 'unchanged' });
      }
    }

    // Add removed text (if any)
    if (change.rem) {
      result.push({ text: change.rem, type: 'removed' });
    }

    // Add added text (if any)
    if (change.add) {
      result.push({ text: change.add, type: 'added' });
    }

    lastPos = change.pos + change.len;
  }

  // Add remaining unchanged text
  if (lastPos < cleanedText.length) {
    result.push({ text: cleanedText.slice(lastPos), type: 'unchanged' });
  }

  return result;
}

/**
 * Count changes from DiffWord array.
 */
export function countChangesFromWords(diffWords: DiffWord[]): number {
  return diffWords.filter(w => w.type !== 'unchanged').length;
}
