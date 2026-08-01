# Block-category labeling conventions

Written for the first hand-labeled book (For the Soul of the People, Barnett,
Oxford UP 1998 — scholarly oral history, endnotes at back, many inset
interview excerpts) but these are the PROJECT conventions: every labeled or
aligned book must follow them, or the training data contradicts itself.

## Category set

body, title, chapter, heading, subheading, quote, caption, footnote,
header, footer, image, list, discard

Twelve plus `discard`, as of Aug 2026 (v6). **`table` is merged into `list`** (v5 onward; owner
decision reaffirmed Aug 1 2026 — settled, do not re-propose). Lists and tables
are the pair the model most reliably confuses, so one class makes the labels
more trustworthy; the human decides narrate-vs-delete at review, and the only
boundary that matters for damage is against `body`. Historic `table` labels in
older sessions remain valid on disk — the dataset build maps them to `list`.

`front_matter` and `back_matter` were retired and
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
  Reserve `table` for actual tabular DATA. Reference apparatus stays `list`
  even when it is set in two columns — an abbreviations page, a table of
  contents with a page-number column, an index. Both were tried as `table` in
  Jul 2026 and measured worse: moving 91 two-column abbreviation blocks cost
  ~0.035 macro-F1 (about 3x the measured seed noise) and collapsed `image` from
  0.63 to 0.000 in two independent seeds. Reverted.
  A **table of contents is always `list`** for a second, independent reason:
  whether its page numbers land in their own blocks is decided by how OCR
  segmented that particular book, not by the book. One has a real number
  column, another arrives as a single merged block of run-together chapter
  names, a third has the numbers inline. Same page, three shapes — so a rule
  keyed on columns cannot be applied to it consistently.
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
- **discard** (v6): a block that is present in the SCAN but is not book
  content at all. Text Tesseract read off a photograph (a slogan on a
  T-shirt), cover/back-cover marketing matter, and **partial leaks from
  other pages** — show-through from the reverse side, or the edge of the
  facing page caught in the scan. Label it, never delete it: Tesseract will
  still emit these blocks at inference, so the model must learn to call them
  `discard`, and deleting them would train on a page layout that never
  occurs. Distinct from `image` (garbage OCR of a real picture ON this page)
  and from `header`/`footer` (real furniture that belongs to the page).
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
