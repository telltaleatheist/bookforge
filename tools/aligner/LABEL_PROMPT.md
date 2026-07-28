# Subagent prompt — hand-labeling block categories from page images

Reusable prompt for parallel labeling agents (Opus or better recommended;
validated on Fable). Fill the {PLACEHOLDERS}, launch one agent per 32-page
chunk. Prerequisites: `ocr-book.mjs` has produced `blocks.json` + `pages/`,
`split-chunks.mjs` has produced the per-range chunk files, and `LABELING.md`
sits in the working directory (add a book-specific note at the top if the
book has quirks — e.g. "endnotes at back", "two heading levels", "photo
insert around p230").

After all agents return, merge with coverage verification (every id exactly
once, categories ⊆ the label set) and assemble via `assemble-session.mjs`.
Do not skip the merge check: an agent that silently dropped a page is
indistinguishable from a clean run without it.

---

You are hand-labeling text-block categories for ML training data on a
scanned book. Work from {WORK_DIR}.

1. Read labeling-guide.md (LABELING.md) in that directory FIRST and follow
   its conventions exactly. Do not improvise new conventions; if no category
   cleanly fits, pick the closest per the guide's judgment-call rules and
   flag the page in your report.

2. Read {CHUNK_FILE} — blocks for PDF pages {START}-{END}. Each block has:
   id, page, bbox in PDF points (x/y/w/h), pageW/pageH, median font size,
   line count, OCR confidence, and its text.

3. For EACH page in your range, Read the page image pages/page-N.png and
   assign every block on that page a category. The IMAGE is primary
   evidence — geometry and typography tell you what OCR text alone cannot:
   - body vs quote: check inset (both sides), type size, and shape on the
     image, never first-line indent alone;
   - a block at the TOP of a page that continues text from the previous
     page: Read the previous page's image and give it that text's category
     (a quote continuation is quote, a mid-sentence body continuation is
     body);
   - garbled low-confidence blocks are still labeled by what the image
     shows they are (a chapter-number ornament OCR'd as ">7" is chapter;
     photo-edge noise is image);
   - {BOOK_SPECIFIC_HINTS, e.g. "this range spans the Notes section:
     numbered endnote entries = footnote, the 'Notes' display heading =
     chapter, per-chapter dividers inside it = heading"}.

4. Write your answers to {OUTPUT_FILE} in that same directory: a single
   JSON object mapping EVERY block id in the chunk to its category, e.g.
   {"ocr_p12_hand_3": "body", ...}. Every id in the chunk file must appear
   exactly once — verify this programmatically before finishing.

5. Reply with only: block count labeled, category distribution, and any
   pages you found ambiguous (page number + one-line why).
