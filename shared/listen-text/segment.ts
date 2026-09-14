/**
 * segment.ts — sentence segmentation for the Listen path, and for the book's
 * sentence plan.
 *
 * ── Why it is here and not in electron/text-ai.ts ───────────────────────────
 *
 * It was there until Phase 16 (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0). The
 * browser extension used to send a paragraph to BookForge's WebSocket on 8766
 * and let the main process split it; now the extension talks to a Crucible
 * directly, so the extension has to split the paragraph itself — and the split
 * has to be THE SAME SPLIT, byte for byte, because a resumed block splices new
 * audio onto a cached prefix by sentence index. Two segmenters would put one
 * chunk's audio under another chunk's text.
 *
 * So the code moved to `shared/`, which is the layer both programs compile: the
 * main process and the CLI through `tsconfig.electron.json`, the Angular
 * renderer through `tsconfig.app.json`, and the extension through its own
 * esbuild bundle. `tools/test-listen-text-one-source.js` pins the two bundles'
 * function bodies byte-equal so a copy cannot reappear.
 *
 * `text-ai.ts` keeps the AI-provider half. Nothing about WHAT this file returns
 * changed in the move, deliberately — the keeper compares bodies, and a book
 * rendered before the move must split the same way after it. The one thing that
 * did change is stated rather than slipped in: the two `console.log('[TEXT-AI]
 * …')` lines are GONE. They fired once per paragraph, and this code now runs in
 * a browser tab's console on every block of every page the extension reads.
 *
 * PURE. No Electron, no fs, no model, no config: `Intl.Segmenter` and strings.
 */

/**
 * Normalize abbreviations that could be confused with sentence endings.
 * This is a safety net that runs AFTER AI cleanup, catching any abbreviations
 * the AI might have missed. Critical for accurate sentence boundary detection.
 */
function normalizeAbbreviations(text: string): string {
  // Abbreviations that commonly cause sentence boundary detection errors
  // Map from abbreviation to normalized form (without periods)
  const abbreviations: Record<string, string> = {
    // Countries/Organizations (most problematic for sentence splitting)
    'U.S.': 'US',
    'U.K.': 'UK',
    'U.N.': 'UN',
    'E.U.': 'EU',
    'U.S.A.': 'USA',
    'U.S.S.R.': 'USSR',
    // Titles
    'Dr.': 'Dr',
    'Mr.': 'Mr',
    'Mrs.': 'Mrs',
    'Ms.': 'Ms',
    'Prof.': 'Prof',
    'Jr.': 'Jr',
    'Sr.': 'Sr',
    'Rev.': 'Rev',
    'Gen.': 'Gen',
    'Col.': 'Col',
    'Lt.': 'Lt',
    'Sgt.': 'Sgt',
    'Capt.': 'Capt',
    'Gov.': 'Gov',
    'Sen.': 'Sen',
    'Rep.': 'Rep',
    // Business
    'Inc.': 'Inc',
    'Ltd.': 'Ltd',
    'Corp.': 'Corp',
    'Co.': 'Co',
    'Bros.': 'Bros',
    'LLC.': 'LLC',
    // Common abbreviations
    'vs.': 'vs',
    'etc.': 'etc',
    'e.g.': 'eg',
    'i.e.': 'ie',
    'a.m.': 'am',
    'p.m.': 'pm',
    'A.M.': 'AM',
    'P.M.': 'PM',
    'no.': 'no',
    'No.': 'No',
    'vol.': 'vol',
    'Vol.': 'Vol',
    'pp.': 'pp',
    'pg.': 'pg',
    'St.': 'St',
    'Ave.': 'Ave',
    'Blvd.': 'Blvd',
    'Rd.': 'Rd',
    'Mt.': 'Mt',
    'Ft.': 'Ft',
    'approx.': 'approx',
    'dept.': 'dept',
    'Dept.': 'Dept',
    'est.': 'est',
    'Est.': 'Est',
  };

  let result = text;
  for (const [abbr, replacement] of Object.entries(abbreviations)) {
    // Use word boundary awareness to avoid replacing parts of words
    // But be careful: "U.S." at end of sentence followed by space+capital should still be replaced
    result = result.split(abbr).join(replacement);
  }

  return result;
}

/**
 * Split granularity levels:
 * - 'sentence': Default - splits at sentence boundaries (. ! ?)
 * - 'paragraph': Keeps entire paragraphs together (longer segments)
 */
export type SplitGranularity = 'sentence' | 'paragraph';

/**
 * Split text into segments based on granularity level
 * @param text - The text to split
 * @param locale - Language code for Intl.Segmenter (default: 'en')
 * @param granularity - 'sentence' (default, recommended) or 'paragraph' (longer segments)
 */
export function splitIntoSentences(
  text: string,
  locale: string = 'en',
  granularity: SplitGranularity = 'sentence'
): string[] {
  // Safety net: normalize abbreviations that could be confused with sentence endings
  // This catches anything AI cleanup might have missed (e.g., "U.S." → "US")
  const normalizedText = normalizeAbbreviations(text);

  // First, split by paragraphs (double newlines)
  const paragraphs = normalizedText.split(/\n\n+/);
  const allSegments: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (granularity === 'paragraph') {
      // Paragraph mode: keep entire paragraphs as single units
      allSegments.push(trimmed);
    } else {
      // Sentence mode (default): use Intl.Segmenter for proper sentence boundaries
      const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const segments = [...segmenter.segment(trimmed)];

      // Extract and clean sentences
      const sentences = segments
        .map(s => s.segment.trim())
        .filter(s => s.length > 0)
        // Filter out very short fragments that aren't real sentences
        .filter(s => s.length > 3 || /^[A-Z]/.test(s));

      allSegments.push(...sentences);
    }
  }

  return allSegments;
}

/**
 * A DEAD ENGINE'S NUMBER, AND STILL THE DEFAULT — flagged rather than fixed.
 *
 * 240 is XTTS's per-inference char limit for English. It was the default for
 * every streaming caller until 2026-08-19, which meant Orpheus — whose limit is a
 * token budget an order of magnitude larger — had its sentences broken at commas
 * for a ceiling that was never its own. The streaming callers were fixed then and
 * now ALWAYS pass a cap from the voice's own manifest (Orpheus:
 * `orpheusStreamMaxChars`; Higgs and every Crucible voice: the band's `maxChars`,
 * see ./chunks.ts).
 *
 * One caller still takes the default: `book-render-service`, which builds its
 * sentence plan before any voice is chosen and so has no per-voice cap to pass.
 * For it this is a conservative floor, not a correct one — every Orpheus voice
 * could take longer sentences. Fixing it means moving the split to render time,
 * which is a change to that service, not to this constant.
 */
export const TTS_MAX_CHARS = 240;

/**
 * A piece shorter than this is not worth being its own TTS inference: the model
 * gets no context, and the reader hears an isolated fragment with a pause on each
 * side of it. Mirrors e2a's `SENTENCE_MIN_CHARS` floor (lib/core.py
 * `_sentence_min_chars`, same 25-char default), which the audiobook path has always
 * applied and this one never did — a 249-char sentence against a 240 cap produced
 * a 238-char piece and the orphan `"religion)."`, spoken alone.
 *
 * EXPORTED since Phase 16: `./chunks.ts` used to restate the number with a
 * comment saying "mirrors MIN_SEGMENT_CHARS in electron/text-ai.ts", and a
 * keeper read it out of that file's SOURCE to prove the two had not drifted.
 * Both modules are in this directory now, so the mirror is an import and the
 * drift cannot happen.
 */
export const MIN_SEGMENT_CHARS = 25;

/**
 * Sentence-split for the streaming TTS path, then break any sentence that exceeds
 * the engine's per-inference char limit at clause boundaries (then word boundaries
 * as a last resort), re-packing small pieces to keep the segment count low. This
 * is safe to sub-split because each segment is just one TTS inference.
 *
 * A caller that knows its voice MUST pass that voice's cap — see TTS_MAX_CHARS.
 */
export function splitForTts(text: string, locale: string = 'en', maxChars: number = TTS_MAX_CHARS): string[] {
  const out: string[] = [];
  for (const sentence of splitIntoSentences(text, locale)) {
    if (sentence.length <= maxChars) { out.push(sentence); continue; }
    out.push(...capSegment(sentence, maxChars));
  }
  return out;
}

function capSegment(sentence: string, maxChars: number): string[] {
  // Prefer clause boundaries (punctuation stays attached to the left piece); split
  // an over-long clause on whitespace; then re-pack adjacent pieces up to the cap.
  const pieces: string[] = [];
  for (const clause of sentence.split(/(?<=[,;:—–])\s+/)) {
    if (clause.length <= maxChars) { pieces.push(clause); continue; }
    let buf = '';
    for (const word of clause.split(/\s+/)) {
      if (buf && buf.length + 1 + word.length > maxChars) { pieces.push(buf); buf = word; }
      else buf = buf ? `${buf} ${word}` : word;
    }
    if (buf) pieces.push(buf);
  }
  const packed: string[] = [];
  for (const piece of pieces) {
    const last = packed[packed.length - 1];
    if (last && last.length + 1 + piece.length <= maxChars) packed[packed.length - 1] = `${last} ${piece}`;
    else packed.push(piece);
  }
  // Starvation floor, AFTER packing: the greedy packer fills to the cap and leaves
  // whatever is left over, so a sentence a few chars past the cap ends in a scrap.
  // Absorb it into its neighbour even though that exceeds maxChars — a cap is a
  // guard against truncation, and going a few percent over it costs far less than
  // speaking one word on its own. Nothing here can produce a piece longer than
  // maxChars + MIN_SEGMENT_CHARS.
  for (let i = packed.length - 1; i > 0; i--) {
    if (packed[i].length >= MIN_SEGMENT_CHARS) continue;
    packed[i - 1] = `${packed[i - 1]} ${packed[i]}`;
    packed.splice(i, 1);
  }
  return packed;
}
