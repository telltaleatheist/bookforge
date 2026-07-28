# Block-category labeling conventions

Written for the first hand-labeled book (For the Soul of the People, Barnett,
Oxford UP 1998 — scholarly oral history, endnotes at back, many inset
interview excerpts) but these are the PROJECT conventions: every labeled or
aligned book must follow them, or the training data contradicts itself.

## Category set

body, title, chapter, heading, subheading, quote, caption, footnote,
footnote_ref, header, footer, image, front_matter, back_matter, table, list

## Rules (project conventions — do not improvise)

- **header**: running head at the top of the page (book title / chapter title),
  INCLUDING the page number when Tesseract merged them into one block.
  A page number alone in the top region is also `header`.
- **footer**: page number or any furniture at the bottom of the page.
- **chapter**: chapter openers — "1", "ONE", "Chapter 3", AND the chapter's
  display title line(s) on the opener page (e.g. a chapter number block and a
  chapter title block are BOTH `chapter`). Also the display headings of
  named sections: Introduction, Acknowledgments, Preface, Notes, Bibliography,
  Index, Epilogue, Conclusion — the heading itself is `chapter`.
- **title**: part/book-level dividers only ("Part I: ...", "Book Two"), and the
  book's own title on the title page is `front_matter` (see below), NOT title.
- **heading / subheading**: section headings inside a chapter. First level =
  heading, nested/lesser = subheading. If only one level exists, use heading.
- **body**: ordinary prose paragraphs of the main text, including the prose of
  the Introduction/Preface/Acknowledgments (their headings are `chapter`).
- **quote**: block quotations — inset/indented excerpts, interview quotes,
  epigraphs at chapter openings, quoted letters/documents. Usually indented
  both sides and/or smaller type, often multi-line. The attribution line under
  an epigraph (e.g. "— name, place") is also `quote`.
- **footnote**: bottom-of-page notes AND the note entries in the back "Notes"
  section (numbered endnote paragraphs). This matches what the EPUB aligner
  produces for endnotes, so hand labels and aligned labels stay consistent.
- **footnote_ref**: a block that is ONLY a footnote reference marker split
  off from BODY text (rare — a stray superscript number at body level).
  NOT for note numbers in the footnote/endnote band: a number Tesseract
  split off a note entry is part of the entry -> `footnote`. (Nine of ten
  agents converged on this; the wording above previously misled the tenth.)
- **caption**: text under/beside a photo, map, or figure.
- **image**: only if a block is garbage OCR of a picture (noise characters
  from a photo). Real pictures usually produce no block at all.
  Also: digitizer-stamped "Blank Page" placeholders (text a scan tool prints
  on empty pages). They are real text but not book content; they get ONE
  class everywhere in the book, and `image` ("skip, not content") is it.
  NOT front_matter — a lone short line on an empty page is geometrically a
  part divider, and feeding the same shape into front_matter would blur the
  title/divider boundary.
- **table**: tabular data — rows and columns of values. OCR usually shreds a
  table into many fragment blocks (column strips, stray numbers, row runs):
  EVERY fragment of the table is `table`. The table's number+title line
  ("Table 3. Deportations by year") is `caption`; notes/sources lines under
  the table are `table` (they belong to it), unless they are page footnotes.
- **list**: enumerated or bulleted CONTENT lists (numbered methods, chapter-
  front topic lists, itemized appendices). One item per block or many items
  per block — both `list`. NOT a table of contents (that is `front_matter`)
  and NOT a bibliography/index (back_matter).
- **front_matter**: everything on front pages that is not prose: half title,
  title page (all of it), copyright block, dedication, table of contents
  entries, list of illustrations. The TOC heading "Contents" is `chapter`,
  its entries are `front_matter`.
- **back_matter**: bibliography entries, index entries, series ads, colophon.
  (Notes ENTRIES are `footnote`, not back_matter — see above. The "Notes"
  heading is `chapter`.)
  Bibliography/notes internal nesting: the section's display heading ->
  `chapter`; first-level dividers (UNPUBLISHED / PUBLISHED, "Chapter Three",
  "Archival Sources") -> `heading`; second-level dividers (archive or city
  names heading a sub-list) -> `subheading`; the entries themselves ->
  `back_matter` (or `footnote` in a Notes section).
  A "Conclusion"/"Introduction" that is a SECTION INSIDE a chapter,
  typographically identical to the chapter's other section heads, is
  `heading` — the named-section -> `chapter` rule applies only to
  standalone sections with their own opener page.

## Judgment calls

- OCR garbage from page edges/speckle: label by where it sits — top furniture
  band => header, bottom => footer; mid-page noise on a photo => image.
- A continuation paragraph at the top of a page (no indent, mid-sentence) is
  still `body`; a continuation of an inset quote is still `quote`. Check the
  PREVIOUS page's image when unsure whether text continues a quote.
- Indented paragraphs are normal body (this book indents paragraph starts);
  a quote is distinguished by BOTH-side inset, smaller size, or block shape,
  not by first-line indent alone.
- When truly unsure between body and quote, look at the page image, not just
  geometry: quotes in this book read as quoted speech/documents.

## Output format

For your page range, write a JSON file mapping block id -> category for EVERY
block in the range (no block left unlabeled):

{ "ocr_p12_hand_3": "body", ... }
