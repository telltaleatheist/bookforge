/**
 * THE LISTEN TEXT PATH, in one place, for every client that has to speak.
 *
 * Three programs read this directory and each of them turns a page or a
 * paragraph into rows a TTS engine is handed:
 *
 *   - the main process (`electron/reader-stream-bridge.ts`,
 *     `book-render-service.ts`), compiled by `tsconfig.electron.json`;
 *   - the Angular renderer (`src/app/core/listen/`), compiled by
 *     `tsconfig.app.json`;
 *   - the browser extension's offscreen document, bundled by
 *     `extension/build.mjs`.
 *
 * The order is fixed and all three walk it:
 *
 *   1. `speakableListenText` — the deterministic normalizer (glyph strip,
 *      punctuation canonicalization, scripture book names, number rules,
 *      number expansion, caps fold).
 *   2. `splitForTts` — sentences, capped at the voice's `maxChars`.
 *   3. `packListenChunks` — sentences packed into ramped rows, for an engine
 *      that renders one row at a time (Higgs, and every Crucible voice).
 *
 * Nothing here is a copy of anything: `tools/test-listen-text-one-source.js`
 * pins the extension's bundled function bodies byte-equal to the compiled
 * app's, so the day somebody pastes a second segmenter into the extension the
 * keepers say so.
 */
export {
  splitForTts,
  splitIntoSentences,
  MIN_SEGMENT_CHARS,
  TTS_MAX_CHARS,
  type SplitGranularity,
} from './segment.js';

export {
  BOOK_ORDINAL_WORDS,
  bibleReferenceRewrites,
  expandBibleReferences,
  type BibleBookExpansion,
} from './bible-books.js';

export {
  CAPS_ACRONYMS,
  LETTERED_ACRONYMS,
  foldCapsRun,
  speakableListenText,
  stripUnspokenGlyphs,
} from './normalize.js';

export {
  LISTEN_MIN_CHUNK_CHARS,
  LISTEN_OPENER_CHARS,
  describeListenChunks,
  listenBandFromCaps,
  packListenChunks,
  type ListenChunkBand,
} from './chunks.js';
