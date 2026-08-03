# Processing Pipeline v2 — the pass builder

Status: COMPLETE — all five phases landed (Aug 3 2026). This document is the
contract the implementation works from; §Phases records what each one did.

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
| Footnote removal    | foundry footnotes — `--run` on a PDF, `--epub` on a book | PDF run / EPUB | yes |
| Simplify            | simplification model — de-jargon \| de-stiffen \| language-learning | EPUB | yes |
| Translate           | user-chosen provider (Ollama, Claude, …) + source/target languages | EPUB | no  |

- PDF variant selected → Tesseract available, then OCR correction, then the
  rest. The foundry chain for a PDF implicitly ends in `foundry export`, which
  PRODUCES the book EPUB (title page as its own section, cover embedded — see
  the foundry-side work in phase 1).
- EPUB variant selected → simplify / translate / footnote removal only.
- Passes are unlimited and reorderable: translate → OCR-correct → simplify →
  translate back is legal. Order of execution = order in the sidebar.

### Footnote removal is one pass with two readings of a book

`foundry footnotes` takes either input, and **which one it reads is decided by
what the RUN reads**, never by the pass itself:

| The run reads | foundry command | What it is | Where the book comes from |
|---|---|---|---|
| a PDF | `footnotes --run <dir>` | a stage of the scan chain, after `ocr` | the `foundry export` that ends the chain |
| the book EPUB | `footnotes --epub <book> -o <out> --report <file>` | an EPUB pass like simplify and translate | renamed onto `outputs.epub` |

The model path is identical in both: same weights, same prompt, same
subsequence-guarded applier. What differs is the walk and, in EPUB mode, the
PROJECTION — the deletions are mapped back onto the XHTML text nodes they came
from, so formatting survives and a `<sup>` or `<a>` a deletion empties is removed
with it. A document nothing edited is copied through with the bytes it arrived
with.

So `footnotes` counts as a foundry pass **only on a PDF run**. On an EPUB run it
obeys the EPUB passes' ordering rules (it may not precede a foundry pass) and has
their prerequisites (none). The plan records which mode a job is in
`PassJobConfig.footnotesMode` — `'foundry-run' | 'epub'` — and the executor
refuses a footnotes job that does not say, rather than inferring it from which
other fields happen to be set.

**EPUB mode skips three populations by default**, and none is recognised by
filename or class attribute: navigation units (the whole unit is one hyperlink),
note BODIES (the unit opens with an intra-book back-link), and index entries
(index-shaped units in a document dense enough to BE an index). The middle two
are what `--ask-everything` turns off; it is the pass's one option, a checkbox in
the palette, default OFF, and the planner REFUSES it on a PDF run rather than
accepting an option it cannot honour. The navigation skip is structural and stays
either way.

Its artifacts: `stages/NN-footnotes/diff.json` as usual, plus
`stages/NN-footnotes/report.json` — foundry's own review report, kept verbatim:
per-document counts, every applied deletion with ~80 characters of context, and
every refusal with its reason. The diff's texts come from the two books; its
CHANGES come from the report, so the change count is the marker count.

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
EPUB — no layout — so nothing may be queued behind it. Which passes are "foundry
passes" is decided per run, because footnote removal is one on a PDF and not on
an EPUB (see §Footnote removal is one pass with two readings of a book).

**A foundry export starts the book's provenance over.** A rebuilt book has had
nothing else done to it, so `registerEpubExport` replaces the record and the
chain then appends the foundry passes that produced it, in order.

## The wizard (Studio → Process)

**Gating fix (done)**: the Process tab opens whether or not the editor was ever
opened. The "Open the editor to configure chapters…" wall is gone — it blocked
users who already had, and it blocked legitimate EPUB-source flows that never
need the editor. `needsExport()` survives, deciding which editor entry point to
open; it gates nothing about processing.

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

### As built (phase 4)

| Piece | Where |
|-------|-------|
| The wizard | `src/app/features/language-learning/components/ll-wizard/ll-wizard.component.ts` (`LLWizardComponent`) |
| Steps | `passes → tts → assembly → review`; `LLWizardStep` in `models/language-learning.types.ts` |
| Submission | `QueueService.submitProcessingRun(request, followOn)` → `processing:submit-chain` → `enqueueChain`, which hangs the follow-on jobs off the same master |
| Process-tab gating | `src/app/features/studio/studio.component.ts` |

Deviations from the sketch above, and why:

- **The run type is a switch on page 1**, not a separate flow. Sentence-aligned
  (language learning) is a different product — two books, interleaved, per-language
  narration — and is not expressible as passes over one book, so it keeps the
  cleanup + per-language translation configuration it always had, under the
  switch, submitting the same bilingual job set. `cleanup` and `translate` survive
  as ITS two sub-stage keys (nothing sets `currentStep` to either) and are
  reconciled when page 1 is left.
- **Whole-book translation as a wizard mode is gone.** It is the Translate pass
  now, so `monoTargetLang` / `monoTranslationActive` and the mono TTS stage picker
  went with it. The narration language follows the last translate pass in the run.
- **Invalid orders are surfaced where the planner names them.** Every edit
  re-plans (350 ms debounce) through `processing:plan-chain`; the message is
  printed on the sidebar row whose label it opens with, or above the list when it
  names none, and Next is disabled while it stands. `PASS_LABELS` in the wizard
  mirrors `LABEL_OF` in `processing-chain.ts` — that matching is what puts a
  refusal on the right row.
- **Variant cards list PDFs and the project's book EPUB.** Another ebook edition
  is listed but closed, saying so: the text passes rewrite `outputs.epub` in
  place, and offering a different edition as their input would promise something
  the run does not do. Switching the run to an EPUB DROPS any foundry passes —
  the planner would otherwise take the EPUB as the document to scan.
- **Downstream jobs are built before the chain is submitted.** The plan is made in
  main and reaches the queue as an event, so the caller never sees it; the wizard
  stages TTS/enhancement/assembly through `submitProcessingRun` and `enqueueChain`
  attaches them to the run's master. Building first means a failing resume check
  leaves nothing queued rather than half a workflow.
- **`SimplifyPassParams` / `TranslatePassParams` gained `'local'`** as a provider.
  The bundled llama.cpp server is the app's default AI; a pass that could not name
  it could not express what most runs actually use.

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

### As built (phase 5)

| Piece | Where |
|-------|-------|
| The OCR dialog | `src/app/features/pdf-picker/components/ocr-settings-modal/` — submits `QueueService.submitProcessingRun`, then watches |
| Provenance badges | `provenanceBadges` in `studio-versions.component.ts`; `StudioItem.appliedPasses` filled by `studio.service.ts` |
| Run identity for a picker-submitted chain | `ProcessingChainRequest.bookKey` (shared/processing/pass-types.ts) |

- **The picker's OCR button submits a chain.** `foundry:run-start` is DELETED,
  with its preload binding and its `ElectronService` method: a foundry run is
  started by a queue pass job and nothing else. The dialog builds
  `[tesseract, ocr-correction]` for the open project and then only watches the
  progress events, exactly as before.
- **A project is required, and the page-scope radios are gone** (the corpus path
  keeps them). A run directory covers ONE page set and the last foundry pass
  exports the book from it, so "current page" would have rebuilt the book out of
  one page; and a chain writes provenance into a manifest, which a loose file has
  none of. Both are refusals with a message, never a silent project or a partial
  book.
- **`ProcessingChainRequest.bookKey`** lets the picker pin the chain to the run
  identity it already watches (the document's file hash). Absent — the wizard's
  case — the planner keys the run by the source path.
- **Retired with phases 3–4**: the `ocr-cleanup` job type end to end (no
  submission site left anywhere in the tree), `monoTranslation` (read in five
  places, set in none), the queue's own diff modal (reachable only from an
  ocr-cleanup row), and the TTS stage-copy search that preferred a leftover
  `cleaned.epub` to the EPUB the user chose.

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
4. **(done)** **Wizard UI**: page-1 pass builder (variant cards + sidebar),
   translate page removal, TTS/Assembly gating, Process-tab gating fix. See
   §As built (phase 4) for what deviated.
5. **(done)** **Cleanup wave**: OCR-modal footnote checkbox removed, the picker's
   OCR button turned into a queue submission, provenance badges on the Studio
   book page, dead stage-copy code paths retired. See §As built (phase 5).

Each phase lands only after the previous one's contract (manifest shapes, job
types) is committed — phase 3 builds on 2's `outputs.epub` record; 4 builds on
3's job types; 5 sweeps what 3+4 made redundant.
