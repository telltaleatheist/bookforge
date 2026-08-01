# Relabelling `front_matter` / `back_matter`

You are relabelling blocks in a hand-built training corpus for a block-category
model. Accuracy matters more than speed: this corpus took weeks to label by
hand and a wrong label here teaches the model something false.

## The problem you are fixing

Two of the sixteen categories — `front_matter` and `back_matter` — are defined
by **where a page sits in the book**, not by what the block is. They were
assigned by a positional rule (`page < firstProsePage` → front, `page >
lastProsePage` → back). Together they are 18% of the corpus, and they swallowed
real classes: headings, titles and lists inside those page ranges were
overwritten with the positional label.

Both classes are being retired. Your job is to say what each of those blocks
**actually is**, judged the way every other class is judged — by appearance and
function, never by position in the book.

## Your input

One JSON file: `/Volumes/Callisto/training/rubric/matter-relabel/<chunk>.json`

```jsonc
{
  "chunk": "twisted-cross.part1",
  "book":  "twisted-cross",
  "totalPages": 354,
  "pages": [
    {
      "pid": "twisted-cross#12",   // ← the key you report against
      "page": 12,
      "blocks": [
        {
          "i": 1,                  // block index within the page (top to bottom)
          "label": "back_matter",  // current label
          "decide": true,          // ← YOU RELABEL THIS ONE
          "bbox": [9, 10, 65, 16], // [x0,y0,x1,y1] as PERCENT of the page, origin top-left
          "fsize": 9.9,            // font size in points (varies by scan DPI, compare within a book)
          "lines": 2,              // line count
          "chars": 140,
          "text": "TABLE OF CONTENTS PREFACE"   // first 300 chars
        }
      ]
    }
  ]
}
```

**Only blocks with `"decide": true` are yours.** The others are on the page for
context — they show you the running head, the folio, the body text around a
block — and their labels are already correct. Never relabel them.

Pages appear in the file only if they contain at least one block to decide.

## The label set — thirteen, and no others

`body` `title` `chapter` `heading` `subheading` `quote` `caption` `footnote`
`header` `footer` `image` `table` `list`

(`front_matter`, `back_matter` and `footnote_ref` no longer exist. Never emit them.)

## How to decide

**Work page by page.** First ask what the *page* is — a title page, a copyright
page, a table of contents, an index, an endnotes page, a bibliography, an
appendix. That single judgement usually settles every block on it. The heading
at the top of a section carries several pages after it, so read the pages in
order and carry that context forward.

### The mapping

| What it is | Label | How to recognise it |
|---|---|---|
| **Endnotes / notes** | `footnote` | Small type, numbered entries, often hanging indent. Endnotes are footnotes that were moved to the back — same thing, different place. This is the single biggest group. |
| **Index** | `list` | Short entries, page-number runs, often two columns, alphabetical. |
| **Bibliography / works cited / references** | `list` | Hanging-indent entries, author-first, often alphabetical. |
| **Table of contents / list of illustrations / list of abbreviations / chronology / glossary** | `list` | Entries with trailing page numbers or dot leaders. |
| **Title page, half-title, series page, part-divider title** | `title` | Large display type, centred, sparse page. Include the subtitle, author name and publisher imprint that sit on the same page. |
| **Copyright / CIP / imprint / ISBN page** | `body` | Dense small prose, publication data. Not pretty, but it is prose — `body` is its least-wrong home. |
| **Dedication, epigraph** | `quote` | Short, centred, often italic, isolated on a mostly empty page. |
| **Preface, foreword, introduction, acknowledgements, appendix, afterword, "about the author"** | `body` for the prose | This is ordinary prose that the positional rule misfiled. Its headings get `chapter`/`heading` per the rules below. |
| **Running head** | `header` | Top band of the page (`y0` under ~10%), repeats across pages, often the book or chapter title. |
| **Page number / folio** | `footer` | Bottom band (`y0` over ~88%) — or top band when the folio sits beside the running head. Short, mostly digits. |
| **A major-division opening title** | `chapter` | "NOTES", "INDEX", "BIBLIOGRAPHY", "APPENDIX A", "PREFACE" set like a chapter opening — large, lots of space below, first thing on the page. These *are* chapter openings for the division they head. |
| **A lesser heading inside such a section** | `heading` | e.g. "Chapter One" subheads inside a notes section; the "A"/"B" letter dividers in an index; "Primary Sources" inside a bibliography. |
| **A heading below that** | `subheading` | Tight against the text it introduces (little space below). |
| **A figure/plate caption** | `caption` | Short, near an image, often "Figure 3.1" / "Plate 4". |
| **An image region** | `image` | Usually already labelled; use if a decide-block is plainly a picture. |
| **A real table** | `table` | Ruled or column-aligned data. A table of *contents* is `list`, not `table`. |

### Judgement calls, resolved

- **Endnotes vs bibliography.** Endnotes are numbered and keyed to the text
  (`12. Ibid., p. 45`). A bibliography is alphabetical by author with no
  numbers. Numbered → `footnote`; alphabetical → `list`.
- **Index letter dividers** ("A", "B", "C" alone on a line) → `heading`.
- **A TOC entry and its trailing page number split into two blocks** → both `list`.
- **Blank/stray OCR noise** (a stray mark, a single character with no meaning) →
  label it as whatever its neighbours are, or list it in `unsure` if it is
  genuinely unclassifiable.
- **When a page has no clear identity**, use the geometry: top band → `header`,
  bottom band → `footer`, everything else by its shape.

**If a block genuinely does not fit any of the thirteen**, do not force it.
Put it in `unsure` with a short reason. A new category can be added if the
evidence supports one — that decision is not yours to make silently.

## Your output

Write **one file**: `/Volumes/Callisto/training/rubric/matter-relabel/<chunk>.decisions.json`

```json
{
  "chunk": "twisted-cross.part1",
  "pages": {
    "twisted-cross#12": {
      "kind": "table of contents",
      "default": "list",
      "except": { "1": "header", "14": "footer" }
    },
    "twisted-cross#13": {
      "kind": "endnotes",
      "default": "footnote",
      "except": { "1": "header", "2": "chapter" }
    }
  },
  "unsure": [
    { "pid": "twisted-cross#40", "i": 3, "text": "...", "why": "..." }
  ],
  "notes": "anything the next person should know"
}
```

Rules, all enforced by the apply step — it refuses the whole batch if any fail:

1. **Every page in your input must appear** in `pages`.
2. `default` is the label for that page's decide-blocks; `except` overrides it
   for individual blocks, keyed by the block's `i` **as a string**.
3. Every decide-block must end up with a label, from `default` or `except`.
   If a page has no sensible default, give `"default": null` and list every
   block in `except`.
4. **Never put a non-decide block's `i` in `except`.**
5. Only the thirteen labels above.

`kind` is your one-phrase description of the page ("endnotes", "index",
"copyright page"). It is not used to label anything — it is how a human audits
your work, so make it accurate.

## Before you finish

Re-read your file against the input and check: every page present, every
decide-block covered, no non-decide block touched, no retired label used.
Report how many pages and blocks you covered and anything you were unsure of.
