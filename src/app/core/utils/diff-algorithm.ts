/**
 * Word-level diff algorithm using Longest Common Subsequence (LCS)
 * Optimized for comparing AI-cleaned text against originals
 */

import { DiffWord } from '../models/diff.types';

/**
 * Normalize text by removing only truly INVISIBLE characters.
 * Visible punctuation changes (quotes, dashes) should still show in diff.
 */
function normalizeForComparison(text: string): string {
  return text
    // Remove soft hyphens (invisible hyphenation hints)
    .replace(/\u00AD/g, '')
    // Remove zero-width characters (invisible)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Remove other invisible/control characters (except normal whitespace)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    // Remove byte order marks
    .replace(/\uFFFE|\uFFFF/g, '');
    // NOTE: We intentionally do NOT normalize quotes or dashes here
    // because those are visible changes the user should see
}

/**
 * Tokenize text into words, preserving whitespace information
 */
function tokenize(text: string): string[] {
  // Split on whitespace but keep words intact
  // Also handles punctuation attached to words
  return text.split(/(\s+)/).filter(token => token.length > 0);
}

/**
 * Compare two tokens, using normalized comparison to ignore invisible char differences
 */
function tokensMatch(a: string, b: string): boolean {
  return normalizeForComparison(a) === normalizeForComparison(b);
}

/**
 * Compute the LCS table for two sequences (sync version for small inputs)
 */
function computeLCSTable(original: string[], cleaned: string[]): number[][] {
  const m = original.length;
  const n = cleaned.length;

  // Create 2D array for dynamic programming
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // Use normalized comparison to ignore invisible character differences
      if (tokensMatch(original[i - 1], cleaned[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/**
 * Compute the LCS table async, yielding to UI thread periodically
 */
async function computeLCSTableAsync(original: string[], cleaned: string[]): Promise<number[][]> {
  const m = original.length;
  const n = cleaned.length;

  // Create 2D array for dynamic programming
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Process in chunks to avoid freezing UI
  const CHUNK_SIZE = 5000; // Yield every ~5000 row operations
  let operationCount = 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensMatch(original[i - 1], cleaned[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    operationCount += n;
    if (operationCount >= CHUNK_SIZE) {
      // Yield to UI thread
      await new Promise(resolve => setTimeout(resolve, 0));
      operationCount = 0;
    }
  }

  return dp;
}

/**
 * Backtrack through LCS table to produce diff
 */
function backtrackDiff(
  original: string[],
  cleaned: string[],
  dp: number[][]
): DiffWord[] {
  let i = original.length;
  let j = cleaned.length;

  // Collect operations in reverse order
  const operations: DiffWord[] = [];

  while (i > 0 || j > 0) {
    // Use normalized comparison for matching
    if (i > 0 && j > 0 && tokensMatch(original[i - 1], cleaned[j - 1])) {
      // Match - unchanged (use cleaned text which has normalized chars)
      operations.push({ text: cleaned[j - 1], type: 'unchanged' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Addition in cleaned text
      operations.push({ text: cleaned[j - 1], type: 'added' });
      j--;
    } else {
      // Removal from original text
      operations.push({ text: original[i - 1], type: 'removed' });
      i--;
    }
  }

  // Reverse to get correct order
  return operations.reverse();
}

/**
 * Merge adjacent diff operations of the same type for cleaner output
 */
function mergeDiffOperations(diff: DiffWord[]): DiffWord[] {
  if (diff.length === 0) return [];

  const merged: DiffWord[] = [];
  let current = { ...diff[0] };

  for (let i = 1; i < diff.length; i++) {
    const next = diff[i];

    // Merge if same type (except unchanged - keep those separate for readability)
    if (next.type === current.type && next.type !== 'unchanged') {
      current.text += next.text;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

/**
 * Compute word-level diff between original and cleaned text (sync version)
 * Returns array of DiffWord objects with type annotations
 * WARNING: Can freeze UI for large texts - use computeWordDiffAsync instead
 */
export function computeWordDiff(originalText: string, cleanedText: string): DiffWord[] {
  const originalTokens = tokenize(originalText);
  const cleanedTokens = tokenize(cleanedText);

  // Handle empty cases
  if (originalTokens.length === 0 && cleanedTokens.length === 0) {
    return [];
  }
  if (originalTokens.length === 0) {
    return cleanedTokens.map(text => ({ text, type: 'added' as const }));
  }
  if (cleanedTokens.length === 0) {
    return originalTokens.map(text => ({ text, type: 'removed' as const }));
  }

  // Compute LCS and generate diff
  const dp = computeLCSTable(originalTokens, cleanedTokens);
  const diff = backtrackDiff(originalTokens, cleanedTokens, dp);

  return mergeDiffOperations(diff);
}

// Maximum tokens before falling back to line-based diff
const MAX_WORD_DIFF_TOKENS = 3000;
// Maximum tokens for line-based diff before giving up on highlighting
const MAX_LINE_DIFF_TOKENS = 10000;

/**
 * Simple line-based diff with word-level diffing within changed lines
 * Much more memory efficient for large texts
 */
function computeLineDiff(originalText: string, cleanedText: string): DiffWord[] {
  const originalLines = originalText.split('\n');
  const cleanedLines = cleanedText.split('\n');
  const result: DiffWord[] = [];

  // Simple line matching - find common prefix and suffix
  let start = 0;
  let origEnd = originalLines.length;
  let cleanEnd = cleanedLines.length;

  // Match common prefix
  while (start < origEnd && start < cleanEnd &&
         normalizeForComparison(originalLines[start]) === normalizeForComparison(cleanedLines[start])) {
    if (start > 0) result.push({ text: '\n', type: 'unchanged' });
    result.push({ text: cleanedLines[start], type: 'unchanged' });
    start++;
  }

  // Match common suffix
  while (origEnd > start && cleanEnd > start &&
         normalizeForComparison(originalLines[origEnd - 1]) === normalizeForComparison(cleanedLines[cleanEnd - 1])) {
    origEnd--;
    cleanEnd--;
  }

  // Middle section has changes
  const changedOriginal = originalLines.slice(start, origEnd);
  const changedCleaned = cleanedLines.slice(start, cleanEnd);

  if (changedOriginal.length > 0 || changedCleaned.length > 0) {
    if (result.length > 0) result.push({ text: '\n', type: 'unchanged' });

    // For small changed sections, do word-level diff
    const origTokens = changedOriginal.join('\n').split(/(\s+)/).filter(t => t.length > 0);
    const cleanTokens = changedCleaned.join('\n').split(/(\s+)/).filter(t => t.length > 0);

    if (origTokens.length * cleanTokens.length < 1000000) {
      // Small enough for word-level diff
      const dp = computeLCSTable(origTokens, cleanTokens);
      const diff = backtrackDiff(origTokens, cleanTokens, dp);
      result.push(...mergeDiffOperations(diff));
    } else {
      // Too large - just mark entire sections as removed/added
      if (changedOriginal.length > 0) {
        result.push({ text: changedOriginal.join('\n'), type: 'removed' });
      }
      if (changedCleaned.length > 0) {
        if (changedOriginal.length > 0) result.push({ text: '\n', type: 'unchanged' });
        result.push({ text: changedCleaned.join('\n'), type: 'added' });
      }
    }
  }

  // Add suffix lines
  for (let i = origEnd; i < originalLines.length; i++) {
    result.push({ text: '\n', type: 'unchanged' });
    result.push({ text: cleanedLines[cleanEnd + (i - origEnd)], type: 'unchanged' });
  }

  return result;
}

/**
 * Compute word-level diff asynchronously, yielding to UI thread periodically
 * Use this for large texts to avoid freezing the browser
 *
 * Uses tiered approach based on text size:
 * - Small (< 3K tokens): Full word-level LCS diff
 * - Medium (< 10K tokens): Line-based diff with word-level for changed sections
 * - Large (> 10K tokens): No highlighting, just show texts
 */
export async function computeWordDiffAsync(originalText: string, cleanedText: string): Promise<DiffWord[]> {
  const originalTokens = tokenize(originalText);
  const cleanedTokens = tokenize(cleanedText);

  // Handle empty cases
  if (originalTokens.length === 0 && cleanedTokens.length === 0) {
    return [];
  }
  if (originalTokens.length === 0) {
    return cleanedTokens.map(text => ({ text, type: 'added' as const }));
  }
  if (cleanedTokens.length === 0) {
    return originalTokens.map(text => ({ text, type: 'removed' as const }));
  }

  const maxTokens = Math.max(originalTokens.length, cleanedTokens.length);
  const totalOps = originalTokens.length * cleanedTokens.length;

  // Small texts: full word-level diff (< 9M ops, ~70MB memory)
  if (maxTokens <= MAX_WORD_DIFF_TOKENS) {
    console.log(`[DiffAlgorithm] Word-level diff: ${originalTokens.length}x${cleanedTokens.length}`);

    if (totalOps < 100000) {
      const dp = computeLCSTable(originalTokens, cleanedTokens);
      const diff = backtrackDiff(originalTokens, cleanedTokens, dp);
      return mergeDiffOperations(diff);
    }

    // Async with yielding
    await new Promise(resolve => setTimeout(resolve, 0));
    const dp = await computeLCSTableAsync(originalTokens, cleanedTokens);
    const diff = backtrackDiff(originalTokens, cleanedTokens, dp);
    return mergeDiffOperations(diff);
  }

  // Medium texts: line-based diff
  if (maxTokens <= MAX_LINE_DIFF_TOKENS) {
    console.log(`[DiffAlgorithm] Line-based diff: ${maxTokens} tokens (too large for word-level)`);
    await new Promise(resolve => setTimeout(resolve, 0));
    return computeLineDiff(originalText, cleanedText);
  }

  // Very large texts: just show as unchanged (no highlighting)
  console.warn(`[DiffAlgorithm] Text too large for diff (${maxTokens} tokens), showing without highlights`);
  return [{ text: cleanedText, type: 'unchanged' }];
}

/**
 * Count the number of changes (additions + removals) in a diff
 */
export function countChanges(diff: DiffWord[]): number {
  return diff.filter(word => word.type !== 'unchanged').length;
}

/**
 * Generate a simple summary of changes
 */
export function summarizeChanges(diff: DiffWord[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const word of diff) {
    if (word.type === 'added') added++;
    else if (word.type === 'removed') removed++;
  }

  return { added, removed };
}
