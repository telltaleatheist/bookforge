/**
 * Shared page-range parsing for the PDF-picker.
 *
 * Parses a human page-range expression (1-indexed, e.g. "1,3,5-9") into a
 * sorted, de-duplicated array of 0-indexed page numbers, clamped to the
 * document's page count. This is the single source of truth for page-range
 * parsing — the crop panel and the regex-category page filter both use it, so
 * their behavior can never drift.
 *
 * Semantics (unified on the crop panel's, which were the stricter of the two):
 *   - Input is 1-indexed; output is 0-indexed.
 *   - Pages outside [1, maxPages] are clamped away (dropped), never kept.
 *   - A reversed range ("9-5") yields nothing — start must not exceed end.
 *   - Duplicates are removed; the result is ascending.
 *   - Non-numeric or empty fragments are skipped.
 *
 * No silent fallbacks: an empty or all-garbage string yields an empty array,
 * which is a real, meaningful result (no pages selected), not a masked default.
 */
export function parsePageRange(text: string, maxPages: number): number[] {
  const pages = new Set<number>();
  const parts = text.split(',').map(s => s.trim()).filter(s => s);

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(maxPages, end); i++) {
          pages.add(i - 1); // Convert to 0-indexed
        }
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= maxPages) {
        pages.add(num - 1); // Convert to 0-indexed
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}
