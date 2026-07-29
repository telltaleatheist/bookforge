# Block-category labeling conventions

Written for the first hand-labeled book (For the Soul of the People, Barnett,
Oxford UP 1998 — scholarly oral history, endnotes at back, many inset
interview excerpts) but these are the PROJECT conventions: every labeled or
aligned book must follow them, or the training data contradicts itself.

## Category set

body, title, chapter, heading, subheading, quote, caption, footnote,
header, footer, image, table, list

Thirteen, as of Jul 2026. `front_matter` and `back_matter` were retired and
every block carrying them was relabelled by hand: they described where a page
sat in the book rather than what was on it, and between them they covered 18%
of the corpus, swallowing the headings, titles and lists that happened to fall
in those page ranges. `footnote_ref` went too — 2 examples in 42,759.

**Never use those three.** Judge a block the way every other class is judged:
by how it looks and what it does, never by how far through the book it is.

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
- **title**: display type standing alone — part/book-level dividers ("Part I:
  ...", "Book Two"), and the title page itself: the book's title, its subtitle,
  the author's name and the publisher imprint that sit on that page are all
  `title`. Half-titles and series pages too.
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
  A note number Tesseract split off a note entry is part of the entry ->
  `footnote`. A stray superscript reference marker split off BODY text goes
  with the body it came from -> `body`.
- **caption**: text under/beside a photo, map, or figure.
- **image**: only if a block is garbage OCR of a picture (noise characters
  from a photo). Real pictures usually produce no block at all.
  Also: digitizer-stamped "Blank Page" placeholders (text a scan tool prints
  on empty pages). They are real text but not book content; they get ONE
  class everywhere in the book, and `image` ("skip, not content") is it.
  NOT `title` — a lone short line on an empty page is geometrically a part
  divider, and feeding the same shape into `title` would blur the boundary
  between a real divider and a scan artefact.
- **table**: tabular data — rows and columns of values. OCR usually shreds a
  table into many fragment blocks (column strips, stray numbers, row runs):
  EVERY fragment of the table is `table`. The table's number+title line
  ("Table 3. Deportations by year") is `caption`; notes/sources lines under
  the table are `table` (they belong to it), unless they are page footnotes.
  Also `table`: **reference apparatus actually set in two columns** — an
  abbreviations page whose narrow column of keys sits against a wide column of
  expansions ("ACC: | Allied Control Council…"). That is tabular by the same
  test every other class uses, which is what it looks like.
  But judge the GEOMETRY, never the section's name:
  - a glossary set FULL MEASURE with an em-dash separator
    ("Abwehr—German military intelligence.") is one column -> `list`;
  - a **table of contents is always `list`**, whatever its shape. Whether the
    page numbers land in their own blocks is decided by how OCR segmented that
    particular book, not by the book: one has a real number column, another
    arrives as a single merged block of run-together chapter names, a third has
    the numbers inline in the text. Same page, three shapes — so calling the
    merged case `table` would teach that a wide block of prose is a table.
- **list**: anything whose unit is an ENTRY rather than a sentence. Enumerated
  or bulleted content lists (numbered methods, chapter-front topic lists,
  bullet-pointed characteristics), AND table-of-contents entries, index
  entries, bibliography and works-cited entries, lists of illustrations,
  chronologies, full-measure glossaries, and reference ROSTER/directory
  appendices (headword + fact lines + Source citation per entry — entries and
  split-off headwords alike; OCR merging must not change a block's class).
  One item per block or many items per block — both `list`.
  The exception is two-column abbreviation apparatus, which is `table` — see
  `table` below for where that line falls and why a TOC never crosses it.
- **the copyright / CIP / imprint page** is `body`. Dense small prose carrying
  publication data — not pretty, but prose, and `body` is its least-wrong home.
- **dedications and epigraphs** are `quote`, wherever they sit.
- **section nesting inside notes, bibliographies and indexes**: the section's
  display heading ("NOTES", "INDEX", "BIBLIOGRAPHY", "APPENDIX A") -> `chapter`;
  first-level dividers (UNPUBLISHED / PUBLISHED, "Chapter Three", "Archival
  Sources", an index's "A"/"B" letter dividers) -> `heading`; second-level
  dividers (archive or city names heading a sub-list) -> `subheading`; the
  entries themselves -> `list` (or `footnote` in a Notes section).
  A "Conclusion"/"Introduction" that is a SECTION INSIDE a chapter,
  typographically identical to the chapter's other section heads, is
  `heading` — the named-section -> `chapter` rule applies only to
  standalone sections with their own opener page.
- **endnotes are `footnote`.** An endnote is a footnote that was moved to the
  back; numbered and keyed to the text (`12. Ibid., p. 45`). Alphabetical,
  author-first, unnumbered entries are a bibliography -> `list`.

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
