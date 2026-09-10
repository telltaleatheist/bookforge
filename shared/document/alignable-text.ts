/**
 * WHICH VERSION OF A BOOK CAN BE ALIGNED TO ITS NARRATION — one predicate, both
 * sides of the IPC.
 *
 * Forced alignment (`generate-sentences`, method `epub-align`) reads the book's
 * OWN WORDS and places them against the audio. That is the whole reason it beats
 * transcription: no ASR spelling errors, no invented words. It is worth exactly
 * as much as the text it is given.
 *
 * **A PDF's embedded text layer is not that text.** Owen, 2026-09-10: *"generate
 * sentences should only ever pick the epub. the embedded text from pdfs cant be
 * trusted."* A scanned PDF has no text layer at all; a born-digital one has a
 * layer whose reading order is the order the glyphs were drawn in, with running
 * heads, page numbers, footnote bodies and column breaks interleaved into the
 * prose. Aligning to that does not fail loudly — it produces a transcript that
 * is subtly, permanently wrong about what was said. It is also why this pipeline
 * reads PDFs with a vision model rather than pulling their text out
 * (docs/DOCUMENT_PIPELINE.md); the alignment door must not quietly reverse that
 * decision.
 *
 * The project's EPUB is the trustworthy text: for a converted book it IS the
 * vision model's reading, and for a publisher book it is the publisher's.
 *
 * `kind === 'ebook'` IS NOT THIS TEST, and that is the bug this replaces. An
 * archive PDF is an ebook version of the book — it is one of the files the book
 * exists as, and the versions page is right to list it. It is simply not
 * something whose words can be aligned.
 */

/** Formats whose text is the book's actual words, in reading order. */
const ALIGNABLE_FORMATS = new Set(['epub']);

/** The shape both sides have: a manifest variant, or anything carrying the two
 *  fields that decide this. Deliberately structural — `electron/` and
 *  `src/app/` declare `ProjectVariant` separately. */
export interface AlignableCandidate {
  readonly kind?: string;
  readonly format?: string;
}

/**
 * Can this version's text be force-aligned to a narration?
 *
 * Both fields must answer: an audiobook is not a text at all, and an ebook
 * version in a format nobody can trust the reading order of is not one either.
 */
export function isAlignableText(variant: AlignableCandidate): boolean {
  if (variant.kind !== 'ebook') return false;
  return ALIGNABLE_FORMATS.has((variant.format || '').trim().toLowerCase());
}

/**
 * Why this version cannot be aligned, for a refusal that names the reason — or
 * null when it can.
 *
 * Written as a sentence rather than a code because both callers put it in front
 * of a person: the queue job fails the row with it, and it is the sentence that
 * has to explain why the file they can see on the versions page is not in the
 * dropdown.
 */
export function alignableTextRefusal(
  variant: AlignableCandidate,
  variantId: string,
): string | null {
  if (isAlignableText(variant)) return null;
  if (variant.kind !== 'ebook') {
    return `Version ${variantId} is not an ebook (kind=${variant.kind}), so it has no text to align.`;
  }
  const format = (variant.format || 'unknown').trim().toLowerCase();
  if (format === 'pdf') {
    return `Version ${variantId} is a PDF. A PDF's embedded text layer is not the book's words in `
      + 'reading order — running heads, page numbers and footnote bodies are mixed into the prose, '
      + 'and a scanned PDF has no text at all — so aligning to it produces a transcript that is '
      + 'quietly wrong rather than one that fails. Convert it to EPUB first and align that.';
  }
  return `Version ${variantId} is a ${format} file, and alignment reads EPUB text. `
    + 'Convert it to EPUB first and align that.';
}
