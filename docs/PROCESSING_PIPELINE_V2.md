# Processing Pipeline v2 — the pass builder

Status: PLAN (Aug 2 2026). Phases 1–2 are in flight; nothing below phase 2 is
built yet. This document is the contract the implementation waves work from.

## The idea

There is ONE book: the project's EPUB, named after the book itself
(`source/<Book Title>.epub`), recorded in the manifest as `outputs.epub`.
Processing is a list of PASSES the user composes and orders freely; every pass
reads the book EPUB and writes it back in place (atomically). The book carries
provenance — which passes have run against it — and each pass (except
translate) saves a diff so Review Changes can show exactly what it did.

"AI cleanup" as a standalone concept is gone: the trained models (galley for
OCR correction, dagger for footnotes, rubric for block labelling) replaced it.
Simplification (de-jargon / de-stiffen / language-learning) and translation
remain as passes.

Revert = re-export the EPUB from the editor's saved state (cheap by
construction: foundry re-export reads the run directory, no re-scan, no
re-inference).

## Vocabulary → implementation map

| Pass (user-facing)  | Runs                                            | Input   | Diff |
|---------------------|--------------------------------------------------|---------|------|
| Tesseract           | foundry scan (segmentation + raw Tesseract OCR)  | PDF     | no (nothing to diff against) |
| OCR correction      | foundry ocr, then foundry blocks AUTOMATICALLY   | PDF run | yes  |
| Footnote removal    | foundry footnotes                                | PDF run / EPUB text | yes |
| Simplify            | simplification model — de-jargon \| de-stiffen \| language-learning | EPUB | yes |
| Translate           | user-chosen provider (Ollama, Claude, …) + source/target languages | EPUB | no  |

- PDF variant selected → Tesseract available, then OCR correction, then the
  rest. The foundry chain for a PDF implicitly ends in `foundry export`, which
  PRODUCES the book EPUB (title page as its own section, cover embedded — see
  the foundry-side work in phase 1).
- EPUB variant selected → simplify / translate / footnote removal only.
- Passes are unlimited and reorderable: translate → OCR-correct → simplify →
  translate back is legal. Order of execution = order in the sidebar.

## Provenance

`manifest.outputs.epub` grows an `appliedPasses` array:

```json
{
  "path": "source/Working Towards the Führer.epub",
  "modifiedAt": "…",
  "appliedPasses": [
    { "kind": "ocr-correction", "at": "…", "params": { "model": "galley-v11" }, "diff": "stages/01-ocr-correction/diff.json" },
    { "kind": "footnotes",      "at": "…", "diff": "stages/02-footnotes/diff.json" },
    { "kind": "translate",      "at": "…", "params": { "from": "de", "to": "en", "provider": "ollama", "model": "…" } }
  ]
}
```

- Studio surfaces these as badges/stars on the book's page: OCR-cleaned?
  translated? footnotes removed? — visible at a glance.
- Diff paths are RELATIVE, stage dirs numbered in execution order per run.
- Review Changes lists every pass that has a diff; click one to load it.
- Stage-copy files (`cleaned.epub`, `simplified.epub`, per-stage EPUBs of the
  standard pipeline) are RETIRED for the mono pipeline. The LL pipeline's
  per-language EPUBs (`de.epub`, `ko.epub`) are genuinely different books and
  keep their own files.

## The wizard (Studio → Process)

**Gating fix first**: the Process tab must open whether or not the editor was
ever opened. The current "Open the editor to configure chapters…" wall is
wrong — it blocks users who already did it, and it blocks legitimate
EPUB-source flows that never need the editor.

### Page 1 — Build the pass list
- Variant picker: the versions/variants listed on the metadata page, shown as
  selectable cards (NOT a dropdown). The chosen variant is the book the passes
  apply to.
- Pass palette (filtered by variant type, per the table above). Selecting
  Simplify expands its three modes. Translate exposes provider + source/target
  languages (same options as today's translate step).
- Selected passes stack in a SIDEBAR, re-orderable (drag or up/down), each
  removable. Add as many as you want, duplicates allowed.
- Translate as an independent wizard page is REMOVED — it lives here now.

### Page 2 — TTS
- Same options as today, but the user must choose an EPUB.
- No EPUB on disk yet? The picker offers "the EPUB this processing run will
  produce" when page 1 has passes configured. Page 1 empty AND no EPUB → TTS
  is grayed out.

### Page 3 — Assembly
- Unchanged, with the same honesty: no cached sentences AND no TTS configured
  → grayed out (nothing to assemble).

## OCR moves out of the pdf-picker

- The OCR / Detect buttons in the pdf-picker stop being the way OCR runs.
  Tesseract / OCR-correction / blocks become QUEUE ITEMS submitted from the
  wizard like every other job. (The editor keeps its viewing/label/detect
  tooling for inspection and corpus work; it stops being the pipeline's
  front door.)
- The "footnote" checkbox in the OCR/Tesseract modal is REMOVED — footnote
  removal is a pass in the pipeline, not an OCR option.
- Queue job types added: `foundry-scan`, `foundry-ocr-correct` (ocr+blocks),
  `foundry-footnotes`, `simplify`, `translate-pass` — chained in the user's
  sidebar order using the existing job-chain mechanism (see ll-jobs.ts).
  Runs stay owned by MAIN (an ng-serve reload must not kill them).

## Phases

1. **(in flight)** Foundry: title page as its own spine section; `--cover`.
2. **(in flight)** BookForge: `source/<Book Title>.epub` naming, manifest
   `outputs.epub` as the single path authority, migration, cover pass-through.
3. **Backend / data model**: appliedPasses provenance, in-place pass writes
   (atomic), per-pass diff storage + Review Changes plumbing, the new queue
   job types, job chaining in user order, foundry stages as queue jobs.
4. **Wizard UI**: page-1 pass builder (variant cards + sidebar), translate
   page removal, TTS/Assembly gating, Process-tab gating fix.
5. **Cleanup wave**: remove the OCR-modal footnote checkbox, retire the
   pdf-picker OCR/Detect buttons as pipeline entry points, provenance
   badges on the Studio book page, retire dead stage-copy code paths.

Each phase lands only after the previous one's contract (manifest shapes, job
types) is committed — phase 3 builds on 2's `outputs.epub` record; 4 builds on
3's job types; 5 sweeps what 3+4 made redundant.
