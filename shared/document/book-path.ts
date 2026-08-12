/**
 * What names a book — the ONE naming rule, for both processes.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * A book used to be a file ending in `.epub`, so "is this a book?" was asked
 * everywhere by reading the extension. Then the working copy became an exploded
 * DIRECTORY, `source/<stem>.working/`, and every one of those checks silently
 * changed its answer to "no" for the very books the app is built to edit.
 *
 * The failures were not subtle, they were just quiet, because each site's `else`
 * was the PDF path and a PDF path does something plausible with anything:
 *
 *   - the picker showed mupdf's raster of the book instead of the book's own DOM
 *   - mupdf was started rasterizing pages nobody would ever display
 *   - a `.working` directory was offered to `ebook-convert` as a foreign format
 *   - a processing run refused the project's own book as "not the EPUB version"
 *   - the export rebuilt markup it was supposed to preserve
 *
 * So the rule lives in one place, and both processes import it. A new name shape
 * is then one edit, not a hunt.
 *
 * ── Why NAMES and not the filesystem ────────────────────────────────────────
 *
 * The renderer has no `fs`, and this question is asked constantly while
 * deciding what to draw. It is also asked about paths that do not exist yet —
 * the destination of a mint, the file a pass is about to write — where stat'ing
 * answers the wrong question or nothing at all.
 *
 * `isBookPath` is therefore a statement about the NAME, and the naming
 * convention is what makes it true: BookForge mints these names itself
 * (`manifest-service`), so a `.working` is a book by construction. Main also has
 * the container question — is this book a directory or a zip? — and that one
 * genuinely needs the filesystem. They are different questions and this file
 * only answers the first; see `bookContainerKind` in the analyzer for the other.
 *
 * ── The `.working.pdf` trap ─────────────────────────────────────────────────
 *
 * `document-binding.ts` mints `<Original>.working.pdf` for a PDF project. That
 * name CONTAINS `.working` and is emphatically not a book. This is why the test
 * is on the final suffix — `endsWith('.working')` — and never `includes`.
 */

/**
 * The suffix of an exploded working copy: `source/<stem>.working/`.
 *
 * Defined here rather than in `manifest-service` because the renderer needs it
 * too and cannot import from `electron/`. `WORKING_COPY_SUFFIX` there is this
 * constant, re-exported, so there is exactly one spelling of it in the app.
 */
export const WORKING_COPY_SUFFIX = '.working';

/** The suffix of a book still stored as a single zip. */
export const EPUB_SUFFIX = '.epub';

/**
 * Does this path name a book — something the EPUB path should handle?
 *
 * True for a book stored as a zip (`.epub`, including the `.working.epub` and
 * `.tts.epub` and `.generated.epub` members of the family, which all end in it)
 * and for an exploded working copy (`.working`).
 *
 * False for `<Original>.working.pdf`, which is a PDF; see the header.
 */
export function isBookPath(documentPath: string): boolean {
  const lower = documentPath.toLowerCase();
  return lower.endsWith(EPUB_SUFFIX) || lower.endsWith(WORKING_COPY_SUFFIX);
}

/**
 * Is this book an exploded directory rather than a zip, BY NAME?
 *
 * Narrower than `isBookPath` and used where the two containers genuinely differ
 * — reading entries, handing a path to something that opens zips. Where the
 * answer must be true of the bytes on disk rather than of the name, stat it.
 */
export function isExplodedBookPath(documentPath: string): boolean {
  return documentPath.toLowerCase().endsWith(WORKING_COPY_SUFFIX);
}
