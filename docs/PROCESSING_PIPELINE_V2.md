# Processing Pipeline v2 — the pass builder

Status: phases 1–3 landed (Aug 2 2026); 4–5 are the remaining waves. This
document is the contract the implementation works from; §Phases says where the
line currently is.

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
- A `stages/NN-<kind>/` directory is a pass's WORKING space plus its
  `diff.json`. No book lives there: the pass renames its result onto
  `outputs.epub` when it succeeds.
- A pass diff carries BOTH of its texts. The book has moved on by the time
  anyone opens it, so a diff that could only be rendered against the file it
  described would be unreadable.

### As built (phase 3)

| Piece | Where |
|-------|-------|
| Provenance model | `AppliedPass` in `electron/manifest-types.ts` + `src/app/core/models/manifest.types.ts`; `appendAppliedPass` / `allocatePassStage` / `listPassDiffs` in `manifest-service.ts` |
| Pass execution | `electron/processing-passes.ts` — one `runProcessingPass(jobId, config)` for all five kinds |
| Planning + ordering rules | `electron/processing-chain.ts` — `planProcessingChain` |
| Wire types (one declaration, three programs) | `shared/processing/pass-types.ts` |
| Submission | `processing:submit-chain` (plan in main → `queue:enqueue-chain` → `QueueService.enqueueChain`) |
| Pass diffs | `writePassDiff` / `loadDiffFileAt` in `diff-cache.ts`; `DiffService.listPassDiffs` / `loadPassDiff` |
| Job types in queue.json | `foundry-scan`, `foundry-ocr-correct`, `foundry-footnotes`, `simplify`, `translate-pass` |

Ordering rules the planner enforces, both of which are silent data loss if left
to run: an EPUB pass may not come before a foundry pass (the export rebuilds the
book from the scan and discards it), and a foundry pass's prerequisite stage must
be earlier in the chain or already done on disk. A Tesseract-only run produces no
EPUB — no layout — so nothing may be queued behind it.

**A foundry export starts the book's provenance over.** A rebuilt book has had
nothing else done to it, so `registerEpubExport` replaces the record and the
chain then appends the foundry passes that produced it, in order.

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

1. **(done)** Foundry: title page as its own spine section; `--cover`.
2. **(done)** BookForge: `source/<Book Title>.epub` naming, manifest
   `outputs.epub` as the single path authority, cover pass-through. NOTE: the
   legacy-`exported.epub` migration this phase added was REMOVED again — the
   library is being re-run through the pass pipeline, which writes the record,
   and nothing in the app renames or deletes a user's book. No record = no book
   EPUB; a stray `source/exported.epub` is invisible, never an error.
3. **(done)** Backend / data model: `appliedPasses` provenance, in-place pass
   writes (atomic), per-pass diff storage + Review Changes plumbing, the five
   queue job types, chaining in user order, foundry stages as queue jobs.
   Nothing of the wizard UI — phase 4 calls `processing:submit-chain` and the
   backend is complete without it.
4. **Wizard UI**: page-1 pass builder (variant cards + sidebar), translate
   page removal, TTS/Assembly gating, Process-tab gating fix.
5. **Cleanup wave**: remove the OCR-modal footnote checkbox, retire the
   pdf-picker OCR/Detect buttons as pipeline entry points, provenance
   badges on the Studio book page, retire dead stage-copy code paths.

Each phase lands only after the previous one's contract (manifest shapes, job
types) is committed — phase 3 builds on 2's `outputs.epub` record; 4 builds on
3's job types; 5 sweeps what 3+4 made redundant.
