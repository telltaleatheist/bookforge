# The Document Pipeline

**Status: SPEC — approved direction, pending Owen's review of this document.**
Decided 2026-08-03/04 after the foundry-integration fragility audit. This
supersedes the run-directory-as-state model (`bookforge-run.json`, run
attachment, the orphan export gate) and the category-override layer.

## The principle

**Every stage is document-in → document-out.** A stage ends by writing a real
file in the project folder that any external tool can open, and the next stage
reads that file. If a stage ran, the document changed, and you can open it and
see. The app sequences file transformations; it does not keep pipeline state.

What this forbids, by name:

- Results parked in a run directory, an edit list, an override map, or an app
  database, waiting for a later step to "apply" them.
- Any notion of a result being "attached" to a window. The document on disk is
  the result.
- Caching a previous run's output as an answer to a new request.
- Fallback values standing in for missing stage output. A missing input is an
  error naming the stage that should have written it.

## Documents, names, and bindings

A project directory holds three documents, all named after the original:

| File | Role |
|---|---|
| `archive/<Original>.pdf` | The immutable primary. **Never written. Ever.** Its sha256 is the identity every other document is bound to. |
| `<Original>.working.pdf` | The mutable working document — a copy of the primary, sitting in the project root. Stages write INTO it (text layer, annotations). **Shown in the versions page's document family, and nowhere else** (RULED 2026-08-04 — see below). |
| `<Original>.epub` | The final product, written by Reflow **with this name from birth**. `book.epub` never exists on disk. Later stages (footnotes-on-epub) edit it in place via staged write + atomic rename. |

`working.pdf` and the EPUB are **sidecars of the archive primary** under the
existing `bookforge-sidecar-binding-v1` protocol (`electron/sidecar-binding.ts`):
a binding record carries the primary's sha256 and each sidecar's own hash, and a
reader trusts a sidecar only after the recorded primary hash matches the actual
archive bytes. Two consequences:

- **Archive immutability becomes a checked invariant.** Every stage that
  consults the binding re-proves the archive was never touched.
- **Deviation from the m4b protocol:** the binding record cannot sit beside the
  primary (that would write into `archive/`). It lives in the **project root**,
  deterministically named after the primary basename (same 255-byte-component
  hashed-tail rule the protocol already has).

Sidecar hashes in the binding are refreshed at **stage completions**, not on
every picker edit (hashing a 300 MB PDF per annotation click is not a thing).
Between stage boundaries the delivery tier (size+mtime) identifies the working
copy.

### Sidecars are system files, and the working copy still gets a door

**RULED 2026-08-04, reversing this section's original rule.** The old rule was
that `working.pdf` gets no item line anywhere. It failed its first real session:
a book was cast and detected from the queue, and afterwards the versions page
listed only the archive — the work existed on disk, at 3.7 MB, with both stage
boundaries recorded, and had no door. A user cannot be asked to trust a pipeline
whose products it does not admit to.

The rule now:

- **The working copy has exactly ONE line item, in the versions page's document
  family** — the archive original as parent, the working copy and the book EPUB
  indented under it. It is still absent from every other listing (the library
  grid, file pickers, the variants list).
- **Clicking it opens the PROJECT**, not the file. `editor:get-versions` gives
  that row an `openPath` pointing at the project's PDF primary, and the picker
  lands on the furthest station the book has reached — which is the working
  copy. Opening `working.pdf` standalone would give it no project, no binding
  and no annotations: a window that looks like the book and answers no gesture.
- **The binding record itself stays invisible.** It is a record, not a document.
- The row is DERIVED, per run, from the binding record plus the file's
  existence (`listWorkingDocuments`, `electron/document-project.ts`). No binding
  or no file means no row; nothing is ever inferred from a filename.

The other user-facing affordance the working documents power is unchanged:
**"Reset to [stage]"** (see below).

**A pass is not a version.** Footnote removal, simplify and translate mint no
line item — they are STARS on the book they edited, collapsed by kind,
latest-wins (`shared/document/version-family.ts`). `appliedPasses` stays
append-only in the manifest: it is the book's own history, and the fix was how
it is displayed, not deleting it.

### Reset to stage

Because curation and stage writes land as PDF **incremental updates**
(append-only), every stage completion is a byte offset in `working.pdf`. The
pipeline records that offset (and the document hash) in the binding at each
stage boundary. "Reset to Blocks" (or any stage) = truncate `working.pdf` to
the recorded boundary — an exact, verifiable restoration of the document as it
stood when that stage finished, costing zero GPU and no re-run. Resetting past
Get Text simply re-copies the archive primary.

## Input classes

| Class | Definition | Stages |
|---|---|---|
| **Scanned PDF** | No usable embedded text (`pdf-analyzer` measures this — commit c6a608a8) | Get Text (Tesseract) → Blocks → curate → Reflow (with OCR correction) → Footnotes (epub) |
| **Text PDF** | Embedded text works | Blocks (from embedded text) → curate → Reflow (no model) → Footnotes (epub) |
| **EPUB** | Already a book | Footnotes `--epub` (exists today), and whatever future epub-stage passes |

OCR correction is **not a stage the user schedules on scanned books — it is
part of Reflow** (see below). Footnotes may run on the PDF instead of the EPUB
when the user chooses, but the default for scanned books is the EPUB stage:
the adapter measures 97.0% applied / 0.5% false-fire on clean text vs
90.5% / 2.1% on raw OCR text. Text PDFs are clean either way.

## Stage contracts

### 1. Get Text (scanned PDFs only)

Tesseract (foundry's pinned, verified build) reads the pages and the recognized
lines are written into `working.pdf` as a real **embedded text layer** —
invisible text runs positioned at each line's bbox, the OCRmyPDF technique.
Foundry's scan already produces every line with geometry; this stage makes the
PDF carry it. Tangible test: open `working.pdf` in any reader and select/search
the text.

For text PDFs this stage is skipped — the embedded text already is ground
truth. Foundry's scan grows an **embedded-text mode** that extracts
lines-with-geometry from the existing text layer instead of running Tesseract,
so everything downstream sees one input shape.

### 2. Blocks (detect)

Reads the text layer (lines + geometry) out of `working.pdf`, forms blocks
(foundry's formation rules), labels them with the foundry blocks model, and
writes the result into `working.pdf` as **real PDF annotations** — one square
annotation per block: category, color from the one palette
(`shared/ocr/block-categories.ts`), block id, and merge membership. Open the
PDF in Acrobat and the boxes are there, colored and named.

Adjacent `chapter` blocks and adjacent `title` blocks (close together, nothing
between) are merged before writing.

Detect **replaces** whatever annotations exist. One confirm in the picker
before it runs (it overwrites hand curation); zero confirmation when submitted
through the queue — submitting was the decision. Results are never staged,
previewed, or held: if it ran, the annotations in the PDF are the new truth.

There is **one detect**. The legacy classifier path
(`electron/blocks-run.ts`, the picker's old Detect panel backend) is deleted.

### 3. Curation (the picker)

The picker reads and writes the **same annotations**. Deleting, merging,
splitting, relabeling, and chapter-title text are all edits to `working.pdf`.
Saves use PDF **incremental update** (append-only, the Acrobat mechanism) so a
300 MB scan never gets rewritten for a label click.

> **Library decision (spike resolved 2026-08-04):** `@cantoo/pdf-lib`
> (MIT, pure JS — the maintained fork of the dead Hopding/pdf-lib), **pinned
> ≥ 2.8.1**, is the write-side library in BOTH repos: invisible text layer via
> low-level `pushOperators` + `TextRenderingMode.Invisible` (no high-level
> option exists), square annotations with custom keys via the `PDFDict`
> escape hatch, and incremental saves via its `forIncrementalUpdate` +
> `saveIncremental` path. Pure JS means it runs identically in bun-compiled
> foundry and Electron — no wasm, no native modules.
>
> **mupdf.js is rejected** on two independent grounds: AGPL (and distribution
> of the BookForge installer triggers AGPL obligations — "private repo" is no
> exemption), and mupdf-wasm is confirmed broken under `bun build --compile`
> (oven-sh/bun#18145, ArtifexSoftware/mupdf.js#147).
>
> **pdf.js** (already BookForge's renderer) does page rendering and
> text-with-geometry extraction ONLY. Its `getAnnotations()` parses against a
> fixed key whitelist and **silently drops custom dict keys** — reading our
> annotations through it would silently lose category metadata, so the picker
> parses annotations with pdf-lib and hand-draws the overlay.
>
> **P1 still validates before trusting:** the incremental path had data-loss/
> xref bugs fixed as recently as 2026-07; stress-test sequential appends on a
> 300 MB fixture, verify truncate-to-boundary yields valid PDFs, and
> de-linearize during the Get Text full rewrite (linearized PDFs break
> incremental update). Fallback candidate if validation fails:
> `@libpdf/core` (Documenso).

Category semantics: a block has **one category field**, in the annotation.
Displayed color, selection, chapter derivation, and reflow all read that one
field. The override map is deleted.

### 4. Reflow

Reads `working.pdf` (text layer + annotations) and writes `<Original>.epub`,
properly named, immediately. In one pass:

1. Drop deleted blocks/pages and excluded categories.
2. **Scanned class only:** OCR-correct the *kept* lines with the foundry ocr
   adapter — per-line, the model's trained surface, before any joining. Culled
   blocks cost zero GPU. (Foundry's ocr stage gains a keep-list, the same
   deletions/exclusions plumbing export already takes.)
3. Reflow lines into paragraphs (foundry's calibration + formation),
   dehyphenating at joins under the corpus-attestation rules — never blind
   `word-\nword` collapsing.
4. Chapters come from the chapter blocks; their annotation text is the
   definitive title.

Every element the emitter writes carries `data-bf-category`, `data-bf-group` and
`data-bf-blocks` — the category it was rendered from, the paragraph group, and
the working PDF's own block ids — on the OUTERMOST element of the group (the
`<ul>`, not each `<li>`). That is what makes the EPUB's block categories
IDENTICAL to the working PDF's instead of guessed back from type size: the picker
reads the stamps rather than re-classifying (`readEpubBlockProvenance`, which
maps blocks to elements with the export aligner). A book with no stamps is a
different input class and keeps the font/geometry classifier; the analysis result
says which one it read.

### 5. Footnotes

A text transformation on whichever document it is given:

- `--epub` (exists today): edits the EPUB in place (staged write, atomic
  rename), report artifact beside it.
- `--pdf` (new): rewrites the text layer of `working.pdf`.

Default for scanned books: EPUB stage, after Reflow (accuracy numbers above).

## Error handling

- A failed stage writes **nothing partial** to the document (foundry's staged
  temp + rename discipline) and surfaces its message — stage name and the
  program's own words — in the queue row and the picker.
- There is no persistent error state to attach, clear, or trip over later. The
  scratch directory a stage used is deleted on failure and on success. The
  user re-runs the stage; that is the whole recovery model.
- Export/Generate never consults run state. It reads documents. If the
  documents a stage needs are missing, the error names the stage that writes
  them.

## Picker UI (lands on the new foundation, not the old)

One mode: **select mode**. Right-side nav:

- **Detect** — a single button at the top. One confirm → runs foundry blocks →
  replaces the annotations (merged chapter/title blocks included).
- **Select tab** — click a category swatch → selects every block of that
  category, and only that category (the one field; no divergence possible).
  Double-click a block → selects all blocks of its category. Chapter blocks
  select like anything else.
- **Label tab** — click a block, then click its category (current label-mode
  gesture).
- **Chapter tab** — lists all chapter blocks; titles editable inline here.
  Relabeling any block to `chapter` makes it appear here. Replaces the old
  chapters mode/sidebar.
- **Pencil** — clicking a chapter block shows a pencil; the pencil opens title
  editing. Chapter blocks are otherwise ordinary blocks (select, merge, move,
  relabel).
- **Merge** — select multiple blocks → merge into one. This is the "the system
  thinks it's two blocks but it isn't" correction, and it feeds chapter
  assembly too.

## What gets deleted

- `bookforge-run.json` and run persistence as state; run attachment
  (`foundryReattachEffect`, `foundryRunLoaded`, `attachFoundryRun` wiring);
  the orphan export gate in `tryFoundryExport`.
- The category override map and every read of it.
- The legacy detect backend (`electron/blocks-run.ts`, its store, its panel
  wiring) and the second detect path.
- The legacy reflow exporter as a separate gated path — Reflow is the one
  exporter.
- The chapter-marker occlusion machinery tied to the old chapter system.

## Build phases (each on a branch, delegate-and-review, merge to main)

- **P0 — keep the app usable now (small diffs on current code):**
  double-click selection reads the same effective category the display paints;
  errored runs are auto-cleared with their reason surfaced; the export gate
  stops blocking on run objects that exported nothing.
- **P1 — foundry document modes:** text-layer writer (scan → PDF), embedded-
  text scan mode, `blocks` annotation write, Reflow (PDF → named EPUB, with
  keep-list OCR), `footnotes --pdf`. Incremental-update spike decision.
- **P2 — BookForge pipeline:** queue stages become document transforms;
  sidecar bindings + naming; the deletion list above actually deleted.
- **P3 — picker:** annotation-backed editing and the select/label/chapter tab
  redesign, pencil, merge.

Review gate at the end of each phase before the next begins.
