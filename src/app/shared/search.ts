/**
 * Lenient search folding, with German umlaut/eszett equivalence.
 *
 * A German title like "Kühl-Freudenstein" should be findable however the reader
 * types the accented letters, so we fold each string TWO ways and match against
 * either:
 *   - 'drop'    : ü→u  ö→o  ä→a  ß→ss   (just dropping the umlaut dots — the
 *                 English-keyboard habit; "kuhl" finds "Kühl")
 *   - 'digraph' : ü→ue ö→oe ä→ae ß→ss   (the German ASCII transliteration;
 *                 "kuehl" finds "Kühl", "gruss" finds "Gruß")
 * Both variants also lowercase, strip other diacritics (café → cafe), drop
 * apostrophes so "god's" == "gods", and turn any remaining punctuation into a
 * single space.
 */
type GermanMap = Record<string, string>;
const GERMAN_DROP: GermanMap = { 'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss' };
const GERMAN_DIGRAPH: GermanMap = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };

/** Fold with a specific German mapping. Umlauts are mapped BEFORE NFKD so the
 *  dots aren't stripped away before we can expand them to a digraph. */
function fold(s: string | null | undefined, map: GermanMap): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => map[c] ?? c) // German letters first (pre-NFKD)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')             // strip any remaining diacritic marks
    .replace(/['‘’ʼ`]/g, '') // drop apostrophes: "god's" → "gods"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')            // any other punctuation → space
    .trim();
}

/** Default single-variant fold (dots-dropped). Kept for callers that just want a
 *  canonical, comparable form of one string. */
export function normalizeForSearch(s: string | null | undefined): string {
  return fold(s, GERMAN_DROP);
}

/** True if every whitespace-separated term of the raw `query` appears in
 *  `haystack` (order-independent). Tried under both German folds, so "kuhl",
 *  "kühl", and "kuehl" all match "Kühl". An empty/blank query matches everything. */
export function looseMatch(haystack: string, query: string): boolean {
  if (!query || !query.trim()) return true;
  return [GERMAN_DROP, GERMAN_DIGRAPH].some((map) => {
    const hay = fold(haystack, map);
    const terms = fold(query, map).split(' ').filter(Boolean);
    return terms.length > 0 && terms.every((term) => hay.includes(term));
  });
}
