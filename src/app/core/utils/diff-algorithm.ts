/**
 * Word-level diff algorithm using Longest Common Subsequence (LCS)
 * Optimized for comparing AI-cleaned text against originals
 */

import { DiffWord } from '../models/diff.types';

/**
 * Tokenize text into words, preserving whitespace information
 */
function tokenize(text: string): string[] {
  // Split on whitespace but keep words intact
  // Also handles punctuation attached to words
  return text.split(/(\s+)/).filter(token => token.length > 0);
}

/**
 * Compute the LCS table for two sequences
 */
function computeLCSTable(original: string[], cleaned: string[]): number[][] {
  const m = original.length;
  const n = cleaned.length;

  // Create 2D array for dynamic programming
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1] === cleaned[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
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
  const result: DiffWord[] = [];
  let i = original.length;
  let j = cleaned.length;

  // Collect operations in reverse order
  const operations: DiffWord[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === cleaned[j - 1]) {
      // Match - unchanged
      operations.push({ text: original[i - 1], type: 'unchanged' });
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
 * Compute word-level diff between original and cleaned text
 * Returns array of DiffWord objects with type annotations
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
