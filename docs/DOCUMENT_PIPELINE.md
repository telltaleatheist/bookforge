# The Document Pipeline

**Status: CURRENT — rewritten 2026-08-07 for the vision-model era.** This
supersedes both the Tesseract document pipeline this file used to describe and
the station-ladder plan in `docs/PIPELINE_V2_PLAN.md`. Those described a
cast → detect → curate → reflow world; that world was removed from BookForge on
2026-08-07 (foundry keeps its copy of the machinery; BookForge no longer calls
it). PDF→EPUB conversion is `foundry vlm-convert` — the dots.ocr document
vision model — and nothing else.

## The principle

**The archive is never written. Ever. Whatever its format.** A project's
original — `archive/<Original>.pdf` or `source/original.epub` — is immutable,
and every mutable thing is a copy of it, bound to it by sha256 where the
sidecar-binding protocol applies. Every stage is document-in → document-out: a
real file in the project folder, openable by any external tool.

## The three flows

All three converge on the same tail:

```
1  PDF ─▶ create working copy ─▶ curate (delete pages/blocks) ─▶ Create EPUB (vlm, skips deleted pages) ─▶ book EPUB
2  PDF ──────────────────────────────────────────────────────▶ Convert to EPUB (vlm, whole document) ───▶ book EPUB
3  EPUB original ── first strike/pass lazily mints the book as a COPY (ensureBookEpub) ─────────────────▶ book EPUB

                     book EPUB ─▶ strikes (categories, elements, pages) ─▶ Export TTS copy ─▶ TTS
```

## Documents

| File | Role |
|---|---|
| `archive/<Original>.pdf` / `source/original.epub` | The immutable original. Its sha256 is the identity everything else is bound to. |
| `<Original>.working.pdf` | Mutable curation copy of a PDF original, in the project root. Minted by `document:create-working-copy` (electron/working-copy.ts): plain copy + `/Foundry` marker (producer `bookforge-working-copy/1`) + sidecar binding + **seeded block annotations** from the app's own analysis, so it is born curatable. Instant, no queue. Structural edits only — its text is never rewritten. |
| `source/<Book Title>.epub` | The project's book, recorded as `manifest.outputs.epub` (the ONE authority — nothing is found by filename). Written by `vlm:convert`, or minted as a copy of an EPUB original by `manifestService.ensureBookEpub` the first time a strike or pass needs a mutable book. |
| `source/<Book Title>.tts.epub` | The narration copy — `outputs.ttsEpub`. Derived, disposable, rebuilt from the book + the strike record at any time. |

## Conversion — `foundry vlm-convert`

Lives on **Studio's versions page**, not in the picker. The archive PDF row
offers **Convert to EPUB** (whole document) and **Create working copy**; the
working-copy row offers **Create EPUB**, which passes the pages you deleted as
`--skip-pages` (foundry ≥ v0.7.1) — skipped pages are never rasterized, never
read, never in the book, and the skip list is read from the working document's
own `/FoundryPageDeleted` marks, not from a manifest mirror, so an unsaved
deletion cannot leak a page into a 90-minute run.

The run opens in a modal with a live progress bar (`document:stage-*` events),
owned by `BookConversionService`: **Run in background** closes the modal while
the conversion continues in main (the versions row keeps a slim live bar +
"Show progress"); Escape backgrounds, never cancels; Cancel is real
(`document:cancel-stage` → the AbortSignal `runFoundry` honours). There is no
queue row — the queue owns execution it starts, and this run is main's.

Reading machines, resumability, provenance stamps (`data-bf-cat`,
`data-bf-page`), and the MLX-vs-endpoint rules are unchanged — see CLAUDE.md
§Convert to EPUB. The conversion records `appliedPasses[].params.skippedPages`.

## Strikes and the TTS copy

Striking never edits a book. The record is
`outputs.epub.narrationDeletions = { epubSha256, elements, updatedAt }`
(contract: `shared/vlm/narration-deletions.ts`), element identity is positional
(`<zip entry>#<index>`), and `bf_element` keys are minted for EVERY epub — a
publisher EPUB strikes exactly like a converted one. **Export TTS copy** (picker
rail, book artifact) writes `outputs.ttsEpub`, applying the strikes and — on by
default — **Remove footnote reference numbers**: digits-only `<sup>` elements
stripped by the same shared predicate (`shared/text/sup-markers.ts`) the TTS
extractor applies at read time. The result reports elements removed and markers
stripped. This replaced the AI footnotes pass on 2026-08-07.

## Passes

`ProcessingPassKind = 'simplify' | 'translate'` — that is the whole run-able
set (`shared/processing/pass-types.ts`). Both read the book EPUB (lazily minted
for EPUB-born projects), rename the result atomically onto the same path, and
append provenance. Historical kinds (`tesseract`, `detection`,
`ocr-correction`, `footnotes`, `get-text`, `blocks`, `reflow`, `vlm-convert`)
survive in `AppliedPassKind` because books recording them exist; queue rows of
the retired job types are failed by name on load, never run.

## The picker is one screen

No stations, no bottom tabs, no ladder. The FILE TYPE on screen decides the
tools (`viewedArtifactOf`):

| Open file | Tools |
|---|---|
| Archive PDF | Read-only + Analysis + Search. Curation locked with a sentence pointing at the versions page. |
| Working PDF | Full curation: Select / Crop modes, Merge, block & page deletion, category palette, chapter tab. |
| EPUB (book or original) | Category select/delete (strikes), chapter tab, rail passes: Simplify, Translate, **Export TTS copy**. **Next → narration** hands the project to Studio's Process tab (TTS step) via the narration hand-off. |

The rail (`shared/document/rail-tasks.ts`): source = Select, Crop | Merge;
book = Simplify, Translate | Export TTS copy.

## Error handling

Unchanged in spirit: a failed stage writes nothing partial (staged temp +
atomic rename), surfaces the program's own words, and deletes its scratch. A
missing input is an error naming what should have written it. No fallbacks.

## What was removed, 2026-08-07

The Tesseract arm (get-text/cast, blocks/Detect, reflow, OCR correction, the
blocks llama-server and its 8 GB model, the AI footnotes pass), the station
bar/ladder, the Training tab and its whole corpus stack, and the picker's
Setup/OCR rail group. Foundry keeps its own scan/blocks/ocr/footnotes commands
untouched — BookForge simply no longer calls them. The training corpus was
archived to
`Shared/BookForge/training-corpus-backups/training-archive-2026-08-07.zip` and
`/Volumes/Callisto/training/` deleted.
