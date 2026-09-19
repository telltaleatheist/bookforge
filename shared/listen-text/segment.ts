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
 * THE ABBREVIATION LIST IS AN EXCEPTION LIST, AND NEVER AN EDIT.
 *
 * `Intl.Segmenter` has no abbreviation exceptions, so it ends a sentence at
 * `U.S. Army` and at `Mr. Smith`. Until 2026-09-18 this file answered that by
 * REWRITING THE INPUT — every entry of a 50-row table substring-replaced out of
 * the text before segmenting (`'U.S.' -> 'US'`, `'no.' -> 'no'`) — which is
 * wrong twice over. It edits the book: this split is what the reader
 * highlights, what the transcript says and what the voice is handed, so the
 * page said "US" where the author wrote "U.S.". And a substring replace has no
 * idea where a word starts, so `no.` and `est.` fired INSIDE *piano.*, *best.*,
 * *honest.*, *forest.* and every superlative, deleting the full stop between
 * two sentences and gluing them into one row. `U.S.S.R.` came out as `USS.R.`
 * because the table rewrote its own prefix first.
 *
 * So the text is left alone and the SEGMENTS are corrected: a segment ending in
 * a listed abbreviation is joined to the one after it. The match is
 * word-bounded, which is the whole difference — *piano.* does not end in the
 * abbreviation `no.`, it ends in the word *piano*.
 *
 * ── Which abbreviations earn an exception, and why ─────────────────────────
 *
 * ICU only breaks before a CAPITALISED word, which is measurable and is what
 * decides the list: `No. 5`, `vol. 3`, `approx. 40`, `Acme Inc. bought` and
 * `e.g. this` are already one segment and need no rule at all. An entry here
 * has to earn itself on the capitalised case, and the old table's did not:
 *
 *  - NEVER_SENTENCE_FINAL is the abbreviations that INTRODUCE the word after
 *    them — a title before a name (`Mr. Smith`, `Dr. Jones`), a place word
 *    before a place (`St. Paul`, `Mt. Everest`), a reference word before a
 *    numeral that may be Roman and therefore capital (`Vol. II`, `pp. IV`), and
 *    `vs.` between two named parties. None of them can be the last word of a
 *    sentence, so a break after one is always false.
 *  - DOTTED_INITIALISMS is the abbreviations whose periods are INTERNAL to the
 *    token. A sentence CAN end in one — "He lived in the U.S. She did not." —
 *    and nothing in the text says which it is. We join, because the two
 *    mistakes are not equal: joining costs one segment that holds two
 *    sentences, which the listener cannot hear at all, while splitting
 *    `The U.S.` off on its own hands the voice a fragment and speaks it with a
 *    pause on each side. The old table joined these too, and destroyed their
 *    periods doing it.
 *
 * Dropped from the old table with the case each was costing: `no.`/`No.`
 * (indistinguishable from the WORD "no", which ends sentences constantly, and
 * the abbreviation is followed by a numeral ICU never breaks before);
 * `etc.`, `Inc.`, `Ltd.`, `Corp.`, `Co.`, `Bros.`, `LLC.`, `Jr.`, `Sr.`,
 * `Ave.`, `Blvd.`, `Rd.` (each is the LAST word of its phrase, so a capital
 * after one begins a real sentence); `approx.`, `est.`/`Est.`,
 * `dept.`/`Dept.` (only ever followed by a numeral or a lowercase word, which
 * ICU already keeps together).
 *
 * This is not a solution to abbreviations in English. It is the old table's
 * cases without the collateral damage.
 */
const NEVER_SENTENCE_FINAL = [
  'Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Prof.', 'Rev.', 'Gen.', 'Col.', 'Lt.', 'Sgt.', 'Capt.',
  'Gov.', 'Sen.', 'Rep.', 'St.', 'Mt.', 'Ft.', 'Vol.', 'vol.', 'pp.', 'pg.', 'vs.',
];
const DOTTED_INITIALISMS = [
  'U.S.', 'U.K.', 'U.N.', 'E.U.', 'U.S.A.', 'U.S.S.R.',
  'a.m.', 'p.m.', 'A.M.', 'P.M.', 'e.g.', 'i.e.',
];

/**
 * A segment whose last word is one of those abbreviations. The leading
 * `(?:^|[^A-Za-z0-9])` is the word boundary that the old substring replace did
 * not have — `\b` cannot be used because these all end in `.`, which is not a
 * word character, so `\b` would land before the period rather than before the
 * abbreviation. Trailing whitespace is part of the raw segment ICU returns.
 */
const ENDS_WITH_ABBREVIATION = new RegExp(
  '(?:^|[^A-Za-z0-9])(?:'
  + [...NEVER_SENTENCE_FINAL, ...DOTTED_INITIALISMS].map((a) => a.replace(/\./g, '\\.')).join('|')
  + ')\\s*$');

/**
 * Join each segment that ends in an abbreviation to its successor, repeatedly:
 * `["Dr. ", "Jones and Mrs. ", "Gale left."]` is one sentence, and folding left
 * to right closes all of it because the joined segment then ends wherever its
 * successor did. Raw segments are joined, so the spacing the author wrote
 * survives into the sentence rather than being normalised at the seam.
 */
function mergeFalseAbbreviationBreaks(segments: string[]): string[] {
  const merged: string[] = [];
  for (const segment of segments) {
    const previous = merged.length > 0 ? merged[merged.length - 1] : null;
    if (previous !== null && ENDS_WITH_ABBREVIATION.test(previous)) {
      merged[merged.length - 1] = previous + segment;
    } else {
      merged.push(segment);
    }
  }
  return merged;
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
  // The text is segmented AS WRITTEN — see ENDS_WITH_ABBREVIATION for why this
  // no longer rewrites it first.
  // First, split by paragraphs (double newlines)
  const paragraphs = text.split(/\n\n+/);
  const allSegments: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (granularity === 'paragraph') {
      // Paragraph mode: keep entire paragraphs as single units
      allSegments.push(trimmed);
    } else {
      // Sentence mode (default): use Intl.Segmenter for proper sentence boundaries,
      // then close the boundaries it puts inside an abbreviation.
      const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const segments = mergeFalseAbbreviationBreaks([...segmenter.segment(trimmed)].map(s => s.segment));

      // EVERY SEGMENT OF THE PARAGRAPH COMES BACK, AND ONLY EMPTY ONES DO NOT.
      //
      // Until 2026-09-18 a second filter followed — `s.length > 3 ||
      // /^[A-Z]/.test(s)` — which deleted any segment of three characters or
      // fewer that did not begin with an ASCII capital. Of `42.`, `iv.`, `ok.`
      // and `No!` only the last survived. This list is not a display
      // convenience: `book-render-service.saveRenderPlan` pushes a BLOCK to
      // `plan.blocks` and then asks this function for that block's sentences,
      // so a block reading `42.` or `iv.` was displayed by the reader, counted,
      // and could even open a chapter — while contributing nothing to
      // `plan.sentences`. Nothing pointed at it, so it was never highlighted,
      // never spoken and never in the VTT, and the difference was recorded
      // nowhere. (The capital test was ASCII-only as well, so the rule bit
      // hardest in the locales least able to spare a sentence.)
      //
      // Spoken, displayed and aligned are one list of strings — see the module
      // comment. A fragment that is not worth its own inference is a PACKING
      // question, which `capSegment`'s MIN_SEGMENT_CHARS floor answers by
      // absorbing it into its neighbour, not by dropping the text.
      const sentences = segments
        .map(s => s.trim())
        .filter(s => s.length > 0);

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
