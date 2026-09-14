/**
 * One span of a target's text, replaced by the words it is read as.
 *
 * ── Why the type lives here and not in epub-processor.ts ───────────────────
 *
 * It was declared in `electron/epub-processor.ts` (which still re-exports it,
 * so nothing that reads it there had to change) and `tts-number-rules.ts`
 * imported it from there — `import type`, so nothing of the EPUB processor's
 * 7,000 lines ever reached the emitted JavaScript.
 *
 * That was fine until Phase 16. `shared/listen-text/normalize.ts` now runs in
 * the browser extension's bundle and in the Angular renderer, and it reaches
 * `tts-number-rules.ts`; a type-only import still has to RESOLVE AND TYPECHECK,
 * so both of those programs would have had to compile the whole EPUB processor
 * — fs, Electron, JSZip — to learn the shape of three fields.
 *
 * It is a plain description of a text edit and belongs with the other
 * platform-neutral text types either way.
 */
export interface NarrationTextRewrite {
  /** The printed text, copied verbatim from the target. */
  find: string;
  /** What the narrator says instead. */
  replace: string;
  /** Where `find` starts in the target's text. */
  at: number;
}
