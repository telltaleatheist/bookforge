# Processing Pipeline v2 — the pass builder

Status: COMPLETE — all six phases landed (Aug 3 2026). This document is the
contract the implementation works from; §Phases records what each one did.

## The idea

There is ONE book: the project's EPUB, named after the book itself
(`source/<Book Title>.epub`), recorded in the manifest as `outputs.epub`.
Processing is a list of PASSES the user composes and orders freely; every pass
reads the book EPUB and writes it back in place (atomically). The book carries
provenance — which passes have run against it — and each pass (except
translate) saves a diff so Review Changes can show exactly what it did.

"AI cleanup" as a standalone concept is gone: foundry's trained stages replaced
it — `foundry ocr` for OCR correction, `foundry footnotes` for footnote markers,
`foundry blocks` for block labelling. (Those three grew out of the models called
*galley*, *dagger* and *rubric*; they were retrained and published under
foundry's own names as `ocr`, `footnotes` and `blocks`, and the old names were
scrubbed from the codebase in Aug 2026. Detect and the Training tab are separate
features and are unaffected — Detect now serves foundry's own
`foundry-blocks-v1-4b`, one copy on disk shared with foundry.)
Simplification (de-jargon / de-stiffen / language-learning) and translation
remain as passes.

Revert = re-export the EPUB from the editor's saved state (cheap by
construction: foundry re-export reads the run directory, no re-scan, no
re-inference).

## Vocabulary → implementation map

| Pass (user-facing)  | Runs                                            | Input   | Diff |
|---------------------|--------------------------------------------------|---------|------|
| OCR correction      | foundry scan, then foundry ocr, then foundry blocks — ONE job, three bars | PDF | yes |
| Footnote removal    | foundry footnotes — `--run` on a PDF, `--epub` on a book | PDF run / EPUB | yes |
| Simplify            | simplification model — de-jargon \| de-stiffen \| language-learning | EPUB | yes |
| Translate           | user-chosen provider (Ollama, Claude, …) + source/target languages | EPUB | no  |

- PDF variant selected → **OCR correction** (ONE palette item, see below), then
  the rest. The foundry chain for a PDF implicitly ends in `foundry export`,
  which PRODUCES the book EPUB (title page as its own section, cover embedded —
  see the foundry-side work in phase 1).
- EPUB variant selected → simplify / translate / footnote removal only.
- Passes are unlimited and reorderable: translate → OCR-correct → simplify →
  translate back is legal. Order of execution = order in the sidebar.

### OCR correction is ONE pass over three foundry stages

The wizard offers a single item, **OCR correction**; it puts ONE row in the
sidebar and queues ONE job. Reading the pages, repairing what was read and
labelling the blocks were never a choice: repair has nothing to read without the
scan, and a scan with no layout is page text, not a book. So the pass owns all
three foundry stages — `scan`, `ocr`, `blocks` — and the queue row shows a
PROGRESS BAR PER STAGE instead of the queue showing a step per stage:

```
OCR Correction                                       41%
  Render pages     ████████████████████████████████ 100%
  Tesseract        ████████████████████████████████ 100%
  OCR correction   ██████████░░░░░░░░░░░░░░░░░░░░░░  32%
  Detection        ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   --
```

`render` earns its own bar because it is a stage of the RUN (`foundry-run` counts
it in `stageCount`), it takes minutes on a full book, and it has its own unit —
folding it into Tesseract's bar would need an invented split of that bar between
two kinds of work. The bars are **bridge-supplied**: `runFoundryPass` drives a
`StageTracker` (electron/job-stages.ts) off `onFoundryRunProgress`, sends the
snapshot on `queue:progress` as `stages`, and `stagesFor` returns `job.stages` for
`foundry-ocr-correct` unchanged. Nothing invents a percentage band. Stage weights
are EQUAL and deliberately so: the stages cost wildly different amounts, this app
has no measurement of the ratio, and a guessed weight is a number the ETA would
treat as measured. Equal weight also reproduces exactly the overall percentage
this pass reported before the bars existed.

**Every bar starts empty, because every stage is about to run.** A submitted pass
ALWAYS re-runs its own stages — see *A submitted pass never returns a cached
stage* below — so there is no such thing as a stage this job will skip, and
seeding a bar to 100% from `run.json` would report this morning's work as this
run's before this run had done anything. (It was seeded that way while a finished
stage was genuinely skipped; that seeding is gone.) The scan is part of the pass
rather than conditionally included for the same reason: what is on disk is not
this run.

### A submitted pass never returns a cached stage

A pass is in the queue because a person asked for that work. Handing them back
the artifacts of an earlier run — instantly, and looking exactly like success —
answers a different question than the one they asked, and it is how a re-run "to
see the new model" silently tests the old one.

So:

- **OCR correction wipes the run directory** before it starts. The pages are
  rasterized again at 200 dpi and `scan`, `ocr` and `blocks` all run. Not the
  whole directory out of caution: the scan is the text base every other artifact
  stands on (line ids, blocks, the footnote deletion list), so re-reading the
  pages invalidates all of them, and foundry's export refuses a footnotes
  artifact derived from a text base that no longer exists.
- **Footnote removal in `foundry-run` mode clears its own stage** — `footnotes/`
  and its `run.json` done marker — and leaves `scan`/`ocr`/`blocks` alone.
- **Prerequisites the run does not name are read off disk, and that is INPUT,
  not cache.** A footnotes-only PDF run stands on the existing `ocr` artifact
  exactly as an EPUB pass stands on `manifest.outputs.epub`. The planner's
  refusal is unchanged: footnotes needs `ocr` done on disk or an OCR-correction
  pass above it in the chain.
- **Within one chain, later passes read what earlier ones just produced.** The
  wipe belongs to the PASS, not to the chain, so `[OCR correction, Footnote
  removal]` wipes once — at OCR correction — and footnotes then runs against the
  fresh scan.

The contract lives in `startFoundryRun` (`electron/foundry-run.ts`): *every stage
named in `stages` runs*, its artifacts and done marker cleared first
(`clearStages`); whole-directory wipe is the `redo` flag, which `runFoundryPass`
sets for `ocr-correction` and nothing else. The page RENDERS are the one thing
reused when they are complete, and they are not a cached stage: mupdf rasterizing
a PDF at a pinned dpi is the same bytes every time, with no model in it — and the
only pass that re-reads the pages wipes them anyway.

There is no user option here and no `redoScan`: the checkbox that used to ask
(*Re-scan from the page images*, default OFF) is gone from the wizard row, from
`ChainPassRequest`/`PassJobConfig`, from the planner and from the pdf-picker's OCR
dialog. A job persisted in `queue.json` carrying `redoScan: true` needs no
migration — it asked for what now happens unconditionally, and the extra property
is ignored. What DOES survive: a re-scan mints a new `run.json` `runId`, so
deletions recorded in the editor against the old scan are refused at export by
name, telling the user to open the book in the PDF editor, where they re-attach to
the boxes on screen and are re-recorded against the new scan.

**The two KINDS are untouched.** `tesseract` and `ocr-correction` are still
recorded separately in `outputs.epub.appliedPasses` — what was done to the book
did not change, only how many rows the queue draws — and the planner pushes both
onto `exportPasses` when it plans the unit. `tesseract` survives as a provenance
kind and nothing else: it is not a `PassJobType`, not a palette item, not a
sidebar row, and a chain request naming it is REFUSED by the planner rather than
quietly folded in, so a caller written against the old two-pass shape is told.

**`foundry-scan` is retired from queue.json.** The queue is persisted, so a queue
written by an older build outlives the code that understood it; a row of that type
is FAILED on load (`RETIRED_JOB_TYPES` in queue.types.ts) with the sentence that
says what replaced it, and `runProcessingPass` throws the same way on a
`kind: 'tesseract'` config. Neither is left pending in a queue that steps over it.

**Is it optional?** That depends on the PDF, and the app measures rather than
assumes. `pdf:measure-text-layer` (→ `pdf-analyzer.measureTextLayer`, off the
main thread through the worker proxy) samples up to 12 pages spread evenly across
the document, counts non-whitespace characters per page from mupdf's structured
text, and calls the PDF born-digital when at least HALF the sampled pages carry
≥ 200 characters. Evenly spread because the ends are what break a naive check —
front matter is often blank or plate pages, and a scanned book frequently carries
a born-digital title page. The whole count vector comes back with the verdict, so
a wrong answer can be argued with.

- text layer → the OCR unit is optional, and the wizard says so.
- no text layer → the unit is added automatically and its remove button is
  disabled, saying "This PDF is pictures of pages — it carries no text of its
  own, so nothing can be narrated unless this pass reads it." The guard is in
  `removePass` too, not only in the `[disabled]` binding.
- the check FAILED → the error is shown and nothing is decided. "We could not
  tell" and "it is optional" are different answers and only one is safe to act
  on; there is no fallback to optional.

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

**The weights are foundry's to resolve.** Both modes spawn the stage with
`--llama-server <ours>` and NOTHING else: no `--base-model`, so foundry resolves
base and adapter from its own published catalog and serves the adapter with
`--lora-scaled` — how it was trained and how it was measured. That is now true of
EVERY model stage, not just footnotes: the `--base-model` overrides BookForge
used to pass for `ocr` and `blocks` are gone, along with the file that held them
(`electron/foundry-interim-config.ts`) and the app-side pre-check for the GGUFs.
BookForge does not own that catalog, and foundry's own refusal names the model,
the path and `foundry models pull`. Provenance therefore records what ANSWERED —
`run.json`'s `models.*` in run mode, the report's `model` line in EPUB mode.

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
    { "kind": "ocr-correction", "at": "…", "params": { "ocrModel": "foundry-ocr-v1-4b", "blocksModel": "foundry-blocks-v1-4b" }, "diff": "stages/01-ocr-correction/diff.json" },
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
| Job types in queue.json | `foundry-ocr-correct`, `foundry-footnotes`, `simplify`, `translate-pass` |

Ordering rules the planner enforces, both of which are silent data loss if left
to run: an EPUB pass may not come before a foundry pass (the export rebuilds the
book from the scan and discards it), and a foundry pass's prerequisite stage must
be earlier in the chain or already done on disk. A foundry group that never labels
the blocks produces no EPUB — no layout — so nothing may be queued behind it.
Which passes are "foundry passes" is decided per run, because footnote removal is
one on a PDF and not on an EPUB (see §Footnote removal is one pass with two
readings of a book).

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
  `[ocr-correction]` for the open project and then only watches the progress
  events, exactly as before.
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
6. **(done)** **The OCR unit became one queue row.** `foundry-scan` is retired;
   `foundry-ocr-correct` owns `scan` + `ocr` + `blocks` and reports a real stage
   list (Render pages / Tesseract / OCR correction / Detection) over
   `queue:progress`. Provenance still records the two kinds. See §OCR correction
   is ONE pass over three foundry stages.
7. **(done)** **Stage caching is gone from submitted passes.** `redoScan` — the
   opt-in that made re-running a pass hand back the artifacts it already had —
   was removed from the wire types, the planner, the wizard row and the OCR
   dialog. A submitted pass re-runs its own stages unconditionally; a
   prerequisite it does not run is read off disk as input. See §A submitted pass
   never returns a cached stage.

Each phase lands only after the previous one's contract (manifest shapes, job
types) is committed — phase 3 builds on 2's `outputs.epub` record; 4 builds on
3's job types; 5 sweeps what 3+4 made redundant.
