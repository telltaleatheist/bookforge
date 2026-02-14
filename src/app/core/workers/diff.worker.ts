/**
 * Web Worker for diff computation - runs off the main thread to prevent UI blocking
 */

interface DiffWord {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
}

interface DiffOptions {
  ignoreWhitespace?: boolean;
}

interface WorkerMessage {
  id: number;
  originalText: string;
  cleanedText: string;
  options: DiffOptions;
}

interface WorkerResponse {
  id: number;
  diffWords: DiffWord[];
  error?: string;
}

// ============================================================================
// Diff Algorithm (copied from diff-algorithm.ts to avoid import issues in worker)
// ============================================================================

function normalizeForComparison(text: string): string {
  return text
    .replace(/\u00AD/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\uFFFE|\uFFFF/g, '');
}

function tokenize(text: string, ignoreWhitespace = false): string[] {
  if (ignoreWhitespace) {
    return text.split(/\s+/).filter(token => token.length > 0);
  }
  return text.split(/(\s+)/).filter(token => token.length > 0);
}

function tokensMatch(a: string, b: string): boolean {
  return normalizeForComparison(a) === normalizeForComparison(b);
}

function computeLCSTable(original: string[], cleaned: string[]): number[][] {
  const m = original.length;
  const n = cleaned.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensMatch(original[i - 1], cleaned[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

function backtrackDiff(
  original: string[],
  cleaned: string[],
  dp: number[][]
): DiffWord[] {
  let i = original.length;
  let j = cleaned.length;
  const operations: DiffWord[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensMatch(original[i - 1], cleaned[j - 1])) {
      operations.push({ text: cleaned[j - 1], type: 'unchanged' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      operations.push({ text: cleaned[j - 1], type: 'added' });
      j--;
    } else {
      operations.push({ text: original[i - 1], type: 'removed' });
      i--;
    }
  }

  return operations.reverse();
}

function mergeDiffOperations(diff: DiffWord[]): DiffWord[] {
  if (diff.length === 0) return [];

  const merged: DiffWord[] = [];
  let current = { ...diff[0] };

  for (let i = 1; i < diff.length; i++) {
    const next = diff[i];
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

function computeWordDiffIgnoringWhitespace(originalText: string, cleanedText: string): DiffWord[] {
  const originalWords = tokenize(originalText, true);
  const cleanedWords = tokenize(cleanedText, true);

  if (originalWords.length === 0 && cleanedWords.length === 0) {
    return [{ text: cleanedText, type: 'unchanged' }];
  }
  if (originalWords.length === 0) {
    return [{ text: cleanedText, type: 'added' }];
  }
  if (cleanedWords.length === 0) {
    return [{ text: originalText, type: 'removed' }];
  }

  const dp = computeLCSTable(originalWords, cleanedWords);
  const wordDiff = backtrackDiff(originalWords, cleanedWords, dp);

  const result: DiffWord[] = [];
  const cleanedTokens = tokenize(cleanedText, false);
  let wordDiffIdx = 0;

  for (const token of cleanedTokens) {
    const isWhitespace = /^\s+$/.test(token);

    if (isWhitespace) {
      result.push({ text: token, type: 'unchanged' });
    } else {
      // Insert synthetic spaces between consecutive removed words so they
      // don't get merged into "sawit" instead of "saw it" by mergeDiffOperations
      let isFirstRemoved = true;
      while (wordDiffIdx < wordDiff.length && wordDiff[wordDiffIdx].type === 'removed') {
        if (!isFirstRemoved) {
          result.push({ text: ' ', type: 'removed' });
        }
        result.push(wordDiff[wordDiffIdx]);
        wordDiffIdx++;
        isFirstRemoved = false;
      }

      if (wordDiffIdx < wordDiff.length) {
        result.push({ text: token, type: wordDiff[wordDiffIdx].type });
        wordDiffIdx++;
      }
    }
  }

  // Add any remaining removed words at the end (with spaces between them)
  let isFirstTrailing = true;
  while (wordDiffIdx < wordDiff.length) {
    if (wordDiff[wordDiffIdx].type === 'removed') {
      if (!isFirstTrailing) {
        result.push({ text: ' ', type: 'removed' });
      }
      result.push(wordDiff[wordDiffIdx]);
      isFirstTrailing = false;
    }
    wordDiffIdx++;
  }

  return mergeDiffOperations(result);
}

const MAX_WORD_DIFF_TOKENS = 3000;
const MAX_LINE_DIFF_TOKENS = 10000;

function computeLineDiff(originalText: string, cleanedText: string): DiffWord[] {
  const originalLines = originalText.split('\n');
  const cleanedLines = cleanedText.split('\n');
  const result: DiffWord[] = [];

  let start = 0;
  let origEnd = originalLines.length;
  let cleanEnd = cleanedLines.length;

  while (start < origEnd && start < cleanEnd &&
         normalizeForComparison(originalLines[start]) === normalizeForComparison(cleanedLines[start])) {
    if (start > 0) result.push({ text: '\n', type: 'unchanged' });
    result.push({ text: cleanedLines[start], type: 'unchanged' });
    start++;
  }

  while (origEnd > start && cleanEnd > start &&
         normalizeForComparison(originalLines[origEnd - 1]) === normalizeForComparison(cleanedLines[cleanEnd - 1])) {
    origEnd--;
    cleanEnd--;
  }

  const changedOriginal = originalLines.slice(start, origEnd);
  const changedCleaned = cleanedLines.slice(start, cleanEnd);

  if (changedOriginal.length > 0 || changedCleaned.length > 0) {
    if (result.length > 0) result.push({ text: '\n', type: 'unchanged' });

    const origTokens = changedOriginal.join('\n').split(/(\s+)/).filter(t => t.length > 0);
    const cleanTokens = changedCleaned.join('\n').split(/(\s+)/).filter(t => t.length > 0);

    if (origTokens.length * cleanTokens.length < 1000000) {
      const dp = computeLCSTable(origTokens, cleanTokens);
      const diff = backtrackDiff(origTokens, cleanTokens, dp);
      result.push(...mergeDiffOperations(diff));
    } else {
      if (changedOriginal.length > 0) {
        result.push({ text: changedOriginal.join('\n'), type: 'removed' });
      }
      if (changedCleaned.length > 0) {
        if (changedOriginal.length > 0) result.push({ text: '\n', type: 'unchanged' });
        result.push({ text: changedCleaned.join('\n'), type: 'added' });
      }
    }
  }

  for (let i = origEnd; i < originalLines.length; i++) {
    result.push({ text: '\n', type: 'unchanged' });
    result.push({ text: cleanedLines[cleanEnd + (i - origEnd)], type: 'unchanged' });
  }

  return result;
}

function computeWordDiff(originalText: string, cleanedText: string, options: DiffOptions = {}): DiffWord[] {
  const { ignoreWhitespace = false } = options;

  if (ignoreWhitespace) {
    return computeWordDiffIgnoringWhitespace(originalText, cleanedText);
  }

  const originalTokens = tokenize(originalText);
  const cleanedTokens = tokenize(cleanedText);

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

  // Small texts: full word-level diff
  if (maxTokens <= MAX_WORD_DIFF_TOKENS) {
    const dp = computeLCSTable(originalTokens, cleanedTokens);
    const diff = backtrackDiff(originalTokens, cleanedTokens, dp);
    return mergeDiffOperations(diff);
  }

  // Medium texts: line-based diff
  if (maxTokens <= MAX_LINE_DIFF_TOKENS) {
    return computeLineDiff(originalText, cleanedText);
  }

  // Very large texts: just show as unchanged
  return [{ text: cleanedText, type: 'unchanged' }];
}

// ============================================================================
// Worker message handler
// ============================================================================

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { id, originalText, cleanedText, options } = event.data;

  try {
    const diffWords = computeWordDiff(originalText, cleanedText, options);
    const response: WorkerResponse = { id, diffWords };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      diffWords: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
    self.postMessage(response);
  }
};
