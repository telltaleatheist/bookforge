/**
 * Content Stream Editor for PDF text removal
 *
 * Uses the simple approach that actually works: find TJ/Tj operators
 * containing the target text and remove them entirely.
 */

export interface TextToRemove {
  text: string;
  page: number;
}

/**
 * Remove text from a PDF content stream by matching text content
 *
 * Block text may span multiple TJ/Tj operators in the PDF, so we break it into
 * smaller searchable units. Uses distinctive words (8+ chars or capitalized)
 * to avoid removing unrelated content that shares common words.
 *
 * @param content - The decompressed PDF content stream as a string
 * @param textsToRemove - Array of text strings to find and remove
 * @returns Modified content stream with matching text removed
 */
export function removeTextFromContentStream(
  content: string,
  textsToRemove: string[]
): string {
  if (textsToRemove.length === 0) {
    return content;
  }

  let modified = content;
  let totalRemoved = 0;

  // Build a set of search terms from the block texts
  const searchTerms = new Set<string>();

  for (const text of textsToRemove) {
    if (!text || text.trim().length === 0) continue;

    // Split by newlines first to get individual lines
    const lines = text.split(/[\r\n]+/);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) continue;

      // Add the full line as a search term
      searchTerms.add(trimmedLine);

      // Extract only VERY distinctive words to avoid removing unrelated text.
      // Use 10+ character words which are truly unique in typical documents.
      const words = trimmedLine.split(/\s+/);
      for (const word of words) {
        const cleanWord = word.replace(/[^\w]/g, '');
        if (cleanWord.length >= 10) {
          searchTerms.add(cleanWord);
        }
      }
    }
  }

  // Sort by length descending so we try longer matches first
  const sortedTerms = Array.from(searchTerms).sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    // Escape special regex characters
    const escaped = escapeRegex(term);

    // Find TJ arrays containing this text: [...term...]TJ
    const tjPattern = new RegExp(`\\[[^\\]]*${escaped}[^\\]]*\\]\\s*TJ`, 'gi');

    let match;
    while ((match = tjPattern.exec(modified)) !== null) {
      console.log(`[ContentStream] Removed TJ containing "${term.substring(0, 40)}": ${match[0].substring(0, 60)}...`);
      modified = modified.substring(0, match.index) + modified.substring(match.index + match[0].length);
      totalRemoved++;
      tjPattern.lastIndex = match.index;
    }

    // Also check simple Tj operators: (term)Tj
    const simpleTjPattern = new RegExp(`\\([^)]*${escaped}[^)]*\\)\\s*Tj`, 'gi');
    modified = modified.replace(simpleTjPattern, (m) => {
      console.log(`[ContentStream] Removed Tj containing "${term.substring(0, 40)}": ${m.substring(0, 60)}...`);
      totalRemoved++;
      return '';
    });
  }

  console.log(`[ContentStream] Total operators removed: ${totalRemoved}`);
  return modified;
}

/**
 * Extract readable text from a TJ array string
 * TJ arrays look like: [(Hello)-123(World)]TJ
 * This extracts: "HelloWorld"
 */
function extractTextFromTJ(tjString: string): string {
  const matches = tjString.match(/\(([^)]*)\)/g);
  if (!matches) return '';

  return matches
    .map(m => m.slice(1, -1))  // Remove parentheses
    .join('')
    .replace(/\\(.)/g, '$1');  // Unescape characters
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Legacy interface for compatibility
interface DeletionRect {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

/**
 * Remove text from content stream - unified interface
 * If deletion rects have text, use text-based matching (preferred)
 */
export function removeTextByRectsOrContent(
  content: string,
  deletionRects: DeletionRect[],
  pageHeight: number
): string {
  // Collect texts to remove
  const textsToRemove: string[] = [];

  for (const rect of deletionRects) {
    if (rect.text && rect.text.trim().length > 0) {
      // Clean up the text - remove line breaks, extra spaces
      const cleanText = rect.text.replace(/\s+/g, ' ').trim();
      if (cleanText.length > 0) {
        textsToRemove.push(cleanText);
      }
    }
  }

  if (textsToRemove.length > 0) {
    // Use text-based matching
    return removeTextFromContentStream(content, textsToRemove);
  }

  // No text content available - return original (don't try position matching)
  console.warn('[ContentStreamEditor] No text content in deletion rects, cannot remove');
  return content;
}
