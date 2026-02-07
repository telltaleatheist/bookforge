/**
 * Diff Cache - Pre-compute and store diffs during AI cleanup
 *
 * This module computes word-level diffs during AI cleanup (when we already have
 * both original and cleaned text) and stores them in a .diff.json file alongside
 * the _cleaned.epub. When the user opens Review Changes, loading is instant.
 *
 * INCREMENTAL WRITES: The cache is written after each chapter completes, so
 * partial progress is available even if the job is still running or was interrupted.
 */

import { promises as fsPromises } from 'fs';
import path from 'path';

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
  chapters: DiffCacheChapter[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module State (per-job)
// ─────────────────────────────────────────────────────────────────────────────

let currentOutputPath: string | null = null;
let cacheStartTime: string | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize diff cache at the start of a cleanup job.
 * Creates an empty cache file immediately.
 *
 * @param cleanedEpubPath Path to the _cleaned.epub file (used to derive .diff.json path)
 */
export async function startDiffCache(cleanedEpubPath: string): Promise<void> {
  currentOutputPath = cleanedEpubPath;
  cacheStartTime = new Date().toISOString();

  const diffPath = cleanedEpubPath.replace('.epub', '.diff.json');

  // Create initial empty cache file
  const cache: DiffCacheFile = {
    version: 1,
    createdAt: cacheStartTime,
    updatedAt: cacheStartTime,
    ignoreWhitespace: true,
    completed: false,
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
    // Read existing cache
    let cache: DiffCacheFile;
    try {
      const data = await fsPromises.readFile(diffPath, 'utf-8');
      cache = JSON.parse(data) as DiffCacheFile;
    } catch {
      // File doesn't exist or is corrupt - create new
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

    // Check if chapter already exists (in case of retry/duplicate call)
    const existingIndex = cache.chapters.findIndex(ch => ch.id === id);
    const chapterData: DiffCacheChapter = {
      id,
      title,
      originalCharCount: originalText.length,
      cleanedCharCount: cleanedText.length,
      changeCount,
      changes
    };

    if (existingIndex >= 0) {
      // Update existing
      cache.chapters[existingIndex] = chapterData;
    } else {
      // Add new
      cache.chapters.push(chapterData);
    }

    cache.updatedAt = new Date().toISOString();

    // Write back
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
    cacheStartTime = null;
  }
}

/**
 * Load a pre-computed diff cache file.
 *
 * @param cleanedEpubPath Path to the _cleaned.epub file
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
// Diff Computation (compact format)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize text into words (ignoring whitespace for comparison).
 */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(token => token.length > 0);
}

/**
 * Normalize text for comparison (remove invisible characters).
 */
function normalize(text: string): string {
  return text
    .replace(/\u00AD/g, '') // Soft hyphens
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width chars
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

/**
 * Compute LCS table for dynamic programming diff.
 */
function computeLCSTable(original: string[], cleaned: string[]): number[][] {
  const m = original.length;
  const n = cleaned.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (normalize(original[i - 1]) === normalize(cleaned[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

interface DiffOperation {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
}

/**
 * Backtrack through LCS to produce diff operations.
 */
function backtrackDiff(original: string[], cleaned: string[], dp: number[][]): DiffOperation[] {
  let i = original.length;
  let j = cleaned.length;
  const ops: DiffOperation[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && normalize(original[i - 1]) === normalize(cleaned[j - 1])) {
      ops.push({ type: 'unchanged', text: cleaned[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', text: cleaned[j - 1] });
      j--;
    } else {
      ops.push({ type: 'removed', text: original[i - 1] });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Compute a compact diff representation.
 * Instead of storing the full DiffWord[] array (which duplicates unchanged text),
 * we store only the changes with their positions.
 */
function computeCompactDiff(
  originalText: string,
  cleanedText: string
): { changes: DiffChange[]; changeCount: number } {
  const originalWords = tokenize(originalText);
  const cleanedWords = tokenize(cleanedText);

  // Handle empty cases
  if (originalWords.length === 0 && cleanedWords.length === 0) {
    return { changes: [], changeCount: 0 };
  }

  if (originalWords.length === 0) {
    // Everything is added
    return {
      changes: [{ pos: 0, len: cleanedText.length, add: cleanedText }],
      changeCount: 1
    };
  }

  if (cleanedWords.length === 0) {
    // Everything is removed
    return {
      changes: [{ pos: 0, len: 0, rem: originalText }],
      changeCount: 1
    };
  }

  // Compute word-level diff
  const dp = computeLCSTable(originalWords, cleanedWords);
  const ops = backtrackDiff(originalWords, cleanedWords, dp);

  // Convert operations to compact changes
  const changes: DiffChange[] = [];
  let changeCount = 0;

  // Track position in cleaned text
  let cleanedPos = 0;

  // Group consecutive changes
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];

    if (op.type === 'unchanged') {
      // Skip to next word position in cleaned text
      const wordEnd = cleanedText.indexOf(op.text, cleanedPos);
      if (wordEnd >= 0) {
        cleanedPos = wordEnd + op.text.length;
      }
      i++;
    } else {
      // Collect all consecutive changes (removed + added)
      let removed = '';
      let added = '';
      const changeStartPos = cleanedPos;

      while (i < ops.length && ops[i].type !== 'unchanged') {
        if (ops[i].type === 'removed') {
          removed += (removed ? ' ' : '') + ops[i].text;
        } else if (ops[i].type === 'added') {
          added += (added ? ' ' : '') + ops[i].text;
        }
        i++;
      }

      // Find the added text position in cleaned text
      let addedLen = 0;
      if (added) {
        const addedStart = cleanedText.indexOf(added.split(' ')[0], cleanedPos);
        if (addedStart >= 0) {
          // Find the end of all added words
          let endPos = addedStart;
          const addedWords = added.split(' ');
          for (const word of addedWords) {
            const wordPos = cleanedText.indexOf(word, endPos);
            if (wordPos >= 0) {
              endPos = wordPos + word.length;
            }
          }
          addedLen = endPos - cleanedPos;
          cleanedPos = endPos;
        }
      }

      changes.push({
        pos: changeStartPos,
        len: addedLen,
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
