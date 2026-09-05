# CLI_PARITY_AUDIT — does `bookforge-tts` run the app's code, for every action?

Owen, 2026-09-05:

> *"we have the bookforge-cli specifically for testing code paths from the
> command line. its supposed to use the exact same code path as the app, so we
> can test bugs from a high level. are bookforge-cli's assembly, tts, etc.
> commands configured to use the app logic? it should have a command for just
> about every action. generate-sentences, assemble, tts, etc."*

The standing rule this audits against: **a CLI command runs the SAME compiled
function the app's queue or IPC handler runs** — `dist/electron/*.js` loaded
under `cli/electron-stub.js` — never a re-implementation. A CLI that ran its own
version of a job could not catch the app's bugs, which is the only reason the CLI
exists.

**Scope.** Every user-invokable action in the main process: 382 `ipcMain.handle`
registrations across `electron/main.ts` and its five delegated registrars, plus
the 14 queue step modules in `electron/queue-steps/` and the job types in
`shared/queue/engine-types.ts`. Pure getters, settings reads, window chrome and
file pickers are out of scope — they do no work.

**Verdicts.**

| | meaning |
|---|---|
| **PARITY** | a CLI command reaches the SAME exported function the app calls |
| **DIVERGENT** | a CLI command exists but calls something else, or reaches only part of the door — the difference is named |
| **MISSING** | no CLI command reaches it |

**Method note.** "Headless?" below means: callable from a plain node process
under `cli/electron-stub.js` (which provides `app.getPath`, `getAppPath`,
`isPackaged`, `powerSaveBlocker` and `BrowserWindow.getAllWindows() === []`).
Nearly every long-running bridge takes `mainWindow: BrowserWindow | null` and
publishes progress on the in-process `bridge-events` bus BEFORE it looks at a
window — `queue-steps/runtime.ts:queueMainWindow()` returns null in a headless
app run, so `null` is the argument the queue itself passes, not a stand-in. The
exceptions are listed by name.

---

## 1. Render (TTS)

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 1.1 | Narrate a book (queue row `tts-conversion`) | `electron/queue-steps/tts-conversion.ts:run` → `parallel-tts-bridge.ts:7653 startParallelConversion` | `--tts`, `--audiobook` | **No** — the CLI calls `parallel-tts-bridge.ts:8044 renderRangeHeadless` | **DIVERGENT (deliberate, documented)** |
| 1.2 | Continue an interrupted narration | `parallel-tts-bridge.ts:9614 resumeParallelConversion` (+ the four-mode resume ladder in `tts-conversion.ts`) | `--audiobook` (its own resume: `scanProjectSessions` → `resumeFromSentencesDir`) | **No** | **DIVERGENT** |
| 1.3 | Stop a narration, keeping what rendered | `parallel-tts-bridge.ts:8348 stopAndCacheParallelConversion` | Ctrl+C in `--tts`/`--audiobook` → `stopParallelConversion` + `cacheSessionToProject` | partly — the same teardown, a different cache call | **DIVERGENT (minor)** |
| 1.4 | The narration door (caption cut + numbers) | `parallel-tts-bridge.ts:7353 prepareNarrationInput` | `--prep`, and inside `--tts`/`--audiobook` | **Yes** | **PARITY** |
| 1.5 | Listen / stream a page (extension) | `tts-api-server.ts` → `stream-scheduler` → `orpheus-worker-pool` | `--tts --mode streaming` | **Yes** — drives the real server over its own protocol | **PARITY** |
| 1.6 | Render a Higgs book | same as 1.1, routed by `isHiggsJob` | `--tts --engine higgs` | same divergence as 1.1 | **DIVERGENT** |

**On 1.1/1.2 — this divergence is by design and is written into the bridge.**
`renderRangeHeadless` is documented at `parallel-tts-bridge.ts:7319-7342` and
`:8044` as the CLI's entry: its resume seeds FLACs **by sentence index** from a
prior directory, deliberately, so a campaign tool keeps reading exactly what it
is handed. `startParallelConversion` seeds by **content** (via
`regenerateSentenceIndices`) and additionally owns output naming, manifest
registration, the four-mode resume ladder, the RVC/denoise flags on the complete
event, and article handling. Both call the same prep, the same
`prepareNarrationInput`, the same worker spawn, the same WSL normalization and
the same guards — the split is at the resume/bookkeeping layer only.

**Not closed here**, and it should not be closed by pointing the CLI at
`startParallelConversion`: that function reports completion by
`publishBridgeEvent('parallel-tts:complete')` and carries the queue's
metadata/output-naming contract, so driving it headlessly means reproducing a
queue row. The honest closure is either (a) the CLI drives the queue engine
itself, or (b) the two resume paths are unified in the bridge. Both are
refactors, and Owen's brief for this pass was explicitly not to refactor.

## 2. Assembly

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 2.1 | Assemble a session into the M4B (queue row `reassembly`) | `queue-steps/reassembly.ts:147` → `reassembly-bridge.ts:972 startReassembly` | `--audiobook` (after render), **`--assemble` (new)** | **Yes** | **PARITY** |
| 2.2 | Assemble from a CACHED session ("Assemble" on the Versions row) | same `startReassembly` over `getBfpCachedSession`'s session | **`--assemble` (new)** | **Yes** | **PARITY** *(was MISSING from the Python front end — the adapter had `--assemble-only`, nothing surfaced it)* |
| 2.3 | De-ring at the final encode | `ReassemblyConfig.applyDeRing` | **`--de-ring` (new)** | **Yes** | **PARITY** *(was MISSING)* |
| 2.4 | Assembly-time sentence gap | `ReassemblyConfig.sentenceGap` | **`--assembly-gap` (new)** | **Yes** | **PARITY** *(was MISSING; `--sentence-gap` is the RENDER-time gap, a different pass)* |
| 2.5 | Stop an assembly | `reassembly-bridge.ts:2633 stopReassembly` | NONE | — | **MISSING** — the adapter's SIGINT tears down the render, not the assembly. Mechanical, but it needs the adapter to hold the running step id; noted rather than half-done. |
| 2.6 | Save session metadata / cover | `reassembly-bridge.ts:869 saveSessionMetadata` | NONE | — | **MISSING** (headless-capable) |
| 2.7 | Higgs assembly with the coverage gate satisfied | `compat/app.py --assemble_only --coverage_report <path>` | NONE | — | **MISSING** — see §3. |

## 3. Align (post-render forced alignment) — the named gap

| # | Action | App entry | CLI | Verdict |
|---|---|---|---|---|
| 3.1 | Align a rendered session, write `sentences.vtt` + `coverage.json` | **none in TypeScript** | NONE | **MISSING** |

`narrator align` exists and is finished on the Python side (`python/narrator/align/`,
`narrator/cli.py:535`, `compat/app.py:85` already accepts `--coverage_report`).
**BookForge does not spawn it.** Measured on this branch:

* `electron/narrator-spawn.ts:128` — `NarratorPhase = 'serve' | 'prep' | 'worker' | 'assembly' | 'resume' | 'list'`. There is no `'align'`.
* `grep -rn coverage_report electron/ shared/` → **zero hits**. The flag is built nowhere in TypeScript.
* `python/narrator/align/README.md` says so itself: *"OWED, and routed separately by the orchestrator: the app-side step that RUNS the alignment between render and assembly… That is a cut-over item in the bridges."*

So the app-side spawn builder does not exist yet, on `main` or on this branch. A
CLI `--align` today would be the **first** implementation of that spawn, and a
**second** one the moment the Align branch lands — exactly the drift this
document exists to prevent. It is therefore left as a named gap, and
`tools/test-cli-parity.js` asserts that it stays one: the moment
`NarratorPhase` gains `'align'`, that test stops enforcing the absence and the
CLI door should be added against the app's own builder.

**Consequence for 2.7:** for Higgs v3 the assembly coverage gate is `enforced`
(`assemble/engine_profiles.py`), so a Higgs book assembled without a
`--coverage_report` hits `CoverageRefusal`. The CLI's `--assemble` is Orpheus-only
for the same reason the app is, and says so by name rather than failing inside
Python.

## 4. The two enhancement passes (between render and assembly)

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 4.1 | Final denoise (queue row `final-denoise`) | `queue-steps/final-denoise.ts:126` → `denoise-job.ts:356 runFinalDenoise` | **`--denoise` (new)**, and inside `--audiobook`/`--assemble` | **Yes** | **PARITY** *(was MISSING as a standalone command)* |
| 4.2 | Stop a denoise | `denoise-job.ts:422 stopFinalDenoise` | `--denoise` SIGINT | **Yes** | **PARITY** |
| 4.3 | RVC over a session's sentences (queue row `rvc-enhancement`) | `queue-steps/rvc-enhancement.ts:136` → `rvc-job.ts:167 runRvcEnhancement` | **`--rvc-enhance` (new)** | **Yes** | **PARITY** *(was MISSING)* |
| 4.4 | Stop an RVC enhancement | `rvc-job.ts:420 stopRvcEnhancement` | `--rvc-enhance` SIGINT | **Yes** | **PARITY** |
| 4.5 | RVC over ONE finished audio file | `rvc-bridge.convertFileRvcChunked` | `--rvc` | **Yes** | **PARITY** |

4.3 and 4.5 are **different jobs** and the CLI names both: 4.5 reconstructs a
finished book, 4.3 derives a durable sentence set that assembly reads via
`--sentences_dir`. Collapsing them into one `--rvc` would answer a request for
one with the other.

## 5. Correct sentences / retake

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 5.1 | Open the panel (cache, cues, engine/voice, sample_fmt) | `main.ts:10163` → `correct-sentences-bridge.ts:196 getCorrectSentencesSession` | **`--retake --retake-action list` (new)** | **Yes** | **PARITY** |
| 5.2 | Render fresh takes for sentences | `correct-sentences-bridge.ts:508 generateCandidates` | **`--retake --retake-action retake` (new)** | **Yes** | **PARITY** |
| 5.3 | Approve a take | `correct-sentences-bridge.ts:661 commitSentence` | **`--retake --retake-action commit` (new)** | **Yes** | **PARITY** |
| 5.4 | Undo a correction | `correct-sentences-bridge.ts:734 revertSentence` | **`--retake --retake-action revert` (new)** | **Yes** | **PARITY** |
| 5.5 | Drop the candidate scratch | `correct-sentences-bridge.ts:775 cleanupCandidates` | **`--retake --retake-action cleanup` (new)** | **Yes** | **PARITY** |

All five were MISSING before this pass. The bridge has no cancel export — the
app's IPC layer keeps its own `AbortController` and passes `signal` in; the CLI
adapter does the same on SIGINT.

## 6. Generate sentences (audiobook → VTT)

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 6.1 | Generate sentences for a project VARIANT (queue row `generate-sentences`) | `queue-steps/generate-sentences.ts:74` → `generate-sentences-bridge.ts:106 startGenerateSentences` | NONE | — | **MISSING — cannot be reached headlessly** |
| 6.2 | Transcribe an audio file to a VTT (whisper) | `transcribe-bridge.transcribeAudiobook` | `--generate-sentences` | **Yes** (the inner function) | **DIVERGENT** |
| 6.3 | Align an EPUB to audio (epub-align) | `whisperx-align-bridge.ts:435 runEpubAlign` | `--generate-sentences --epub` (calls `runEpubAlignOnFiles`) | **Nearly** — the sibling that takes files instead of ids | **DIVERGENT** |
| 6.4 | Seal the VTT into the m4b | `metadata-tools.embedAndVerifyVtt` | `--generate-sentences --embed` | **Yes** | **PARITY** |
| 6.5 | Cancel | `generate-sentences-bridge.ts:345 cancelGenerateSentences` | NONE | — | **MISSING** |

**Why 6.1 is not closed.** `startGenerateSentences(jobId, mainWindow, config)`
types `mainWindow` **non-nullable** and its `sendProgress`/`sendComplete` call
`win.isDestroyed()` **unguarded** (`generate-sentences-bridge.ts:78, :102`); it
also passes the window straight into `runEpubAlign`. The app refuses the job
itself when there is no window — `queue-steps/generate-sentences.ts:54-59`,
*"Transcription reports through a window and BookForge has none open, so it
cannot run"* — and `main.ts:7573` refuses the IPC call for the same reason.

Handing it a fake window object would be a second implementation of a
BrowserWindow, and would make the CLI's run structurally different from the app's
(the app **cannot** run this headless; a CLI that could would not be mirroring
it). **What a refactor would need:** make the parameter `BrowserWindow | null`,
guard the two `isDestroyed()` calls the way every other bridge does (publish the
bridge event, then return if there is no window), and thread `null` through
`runEpubAlign` — after which the queue step's refusal becomes unnecessary too.
That is a change to app behaviour, so it is recorded here rather than made.

**6.2/6.3 are a deliberate difference of INPUT, not of engine.** The CLI takes
loose files (`--audio`, `--epub`) and writes a VTT where told; the bridge takes a
project + variant id, resolves the whisper model, writes the variant's `vttPath`
into the manifest and embeds the transcript. The transcription and the forced
alignment underneath are the same compiled functions. The **project/variant
binding** is the part that is unreachable, and it is unreachable for the reason
in 6.1.

## 7. Text passes on a project

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 7.1 | Narration text cleanup (queue row `narration-text`) | `queue-steps/pass.ts:80` → `processing-passes.ts:1117 runProcessingPass` | `--narration-text --project` | **Yes** | **PARITY** |
| 7.2 | Narration text cleanup on a LOOSE epub | `narration-text-pass.ts:434 runNarrationTextPass` | `--narration-text --input` | **Yes** | **PARITY** |
| 7.3 | Simplify (queue row `simplify`) | same `runProcessingPass`, kind `simplify` | **`--pass --kind simplify` (new)** | **Yes** | **PARITY** *(was MISSING as a project act)* |
| 7.4 | Translate (queue row `translate-pass`) | same `runProcessingPass`, kind `translate` → `mono-translation-job.ts:563 runMonoTranslation` | **`--pass --kind translate` (new)** | **Yes** | **PARITY** *(was MISSING)* |
| 7.5 | Footnote refs (queue row `footnote-refs`) | same `runProcessingPass`, kind `footnote-refs` | **`--pass --kind footnote-refs` (new)** | **Yes** | **PARITY** *(was MISSING)* |
| 7.6 | Plan a chain without running it | `processing-chain.ts:156 planProcessingChain` | used by 7.1/7.3-7.5; not exposed alone | **Yes** (internally) | **PARITY** |
| 7.7 | Reset a book's processing | `processing-reset.resetBookProcessing` | NONE | — | **MISSING** (headless-capable) |
| 7.8 | AI cleanup / simplify of a LOOSE epub | `ai-bridge.cleanupEpub` | `--ai-cleanup`, `--ai-simplify` | **Yes** | **PARITY** |

7.3-7.5 and 7.1 share ONE implementation in the CLI —
`cli/processing-pass-step.js`, extracted from `cli/narration-text.js` in this
pass so the two-chain (`--family`) rule is not written twice.

**`--pass` vs `--ai-simplify` is a real distinction, not a duplicate.**
`--ai-simplify` drives `cleanupEpub` over a loose file and writes
`simplified.epub` beside it. `--pass --kind simplify` is the PROJECT act: it
stages, records a ledger row, writes provenance and promotes a working copy —
none of which a loose-file run can be made to do afterwards.

## 8. Foundry (clean text, read pages, Foundry-side translate/simplify)

| # | Action | App entry | CLI | Verdict |
|---|---|---|---|---|
| 8.1 | Convert a PDF to EPUB (queue row `vlm-convert`) | `main.ts:9668` → `vlm-convert.ts:653 runVlmConversion` | `--generate-epub` | **PARITY** |
| 8.2 | Plan a conversion (dry run) | `vlm-convert.ts:499 planVlmConversion` | `--generate-epub --dry-run` | **PARITY** |
| 8.3 | Clean text (Foundry's own pass) | `queue-steps/foundry-job.ts:149` → `foundry-host-queue.ts:279 foundryRunner()` | NONE | **MISSING — cannot be reached headlessly** |
| 8.4 | Foundry read / translate / simplify / export | same `foundryRunner()` | NONE | **MISSING — same reason** |
| 8.5 | Adopt / reload a Foundry project | `foundry-adopt.adoptFoundryProject` / `refreshAdoptedProject` | NONE | **MISSING** (headless-capable) |

**Why 8.3/8.4 cannot be closed.** `foundryRunner()` throws unless
`setFoundrySeam` has been called, and that happens in exactly one place —
`electron/main.ts:12023`, **after** `foundryMount.mountFoundry(...)` at
`main.ts:11955`. `mountFoundry` ends in `applyContentSecurityPolicy()`,
`registerFileProtocol()` and `registerIpc()`, which need `session.defaultSession`,
`protocol` and `ipcMain` — none of which a headless stub has, and none of which
should be faked. Worse, the `FoundryJobRequest` (its `readingsPath`,
`recordsPath` and minted step id) is composed by **Foundry's renderer**; there is
no main-side composer to call.

**What a refactor would need:** (a) a mount-free entry point to
`foundry-app/electron/job-queue.ts:3446 runJob` with an injectable `libraryDir`
instead of one sourced from the record `mountFoundry` sets; and (b) a
main-process composer for `FoundryJobRequest`, since only the renderer knows how
to build one today. Both are changes in the vendored Foundry subtree, which this
repository re-vendors rather than edits.

## 9. Library, projects, variants, m4b metadata

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 9.1 | Import an EPUB as a project | `main.ts:8340` → `import-epub-project.importEpubProject` | `node cli/library.js --import-epub` | **Yes** | **PARITY** |
| 9.2 | Import an audiobook | `main.ts:8374` → `library-actions.importAudiobookProject` | `node cli/library.js --import-audiobook` | **Yes** | **PARITY** |
| 9.3 | Add a version | `library-actions.addVariant` | `node cli/library.js --add-version` | **Yes** | **PARITY** |
| 9.4 | Set the primary version | `library-actions.setPrimaryVariant` | `node cli/library.js --set-primary` | **Yes** | **PARITY** |
| 9.5 | Version metadata | `library-actions.saveVariantMetadata` | `node cli/library.js --set-version-meta` | **Yes** | **PARITY** |
| 9.6 | Mark professional | `library-actions.setVariantProfessional` | `node cli/library.js --set-professional` | **Yes** | **PARITY** |
| 9.7 | Delete a project | `manifestService.deleteProject` | `node cli/library.js --delete-project` | **Yes** | **PARITY** |
| 9.8 | Promote a version to archive | `library-actions.promoteVariantToArchive` | NONE | — | **MISSING** (headless-capable; `library.js` is the place) |
| 9.9 | Delete ONE version | `main.ts:8582` (inline in main.ts) | NONE | — | **MISSING** — `cli/library.js`'s own header says why: the invariant (unlink only when no other variant or output pointer references the path) lives in `main.ts` and must be moved to `library-actions` deliberately, not copied |
| 9.10 | Apply m4b tags + cover | `main.ts:8384` → `metadata-tools.applyMetadata` | NONE | — | **MISSING** (headless-capable) |
| 9.11 | Link a VTT to an m4b (embed + verify) | `main.ts:9277` → `metadata-tools.embedAndVerifyVtt` | `--generate-sentences --embed` reaches the embed | partly | **DIVERGENT** — the CLI embeds, but does not do the manifest re-binding |
| 9.12 | Recover / apply m4b chapters | `chapter-recovery-bridge.detectChapters` / `applyChaptersToM4b` | NONE | — | **MISSING** (headless-capable) |
| 9.13 | Export an EPUB preserving markup | `main.ts:6141` (inline exporter + `registerEpubExport`) | NONE | — | **MISSING** (headless-capable) |
| 9.14 | Convert any ebook to EPUB | `ebook-convert-bridge.convertToEpub` / `convertToLibrary` | NONE | — | **MISSING** (headless-capable) |
| 9.15 | Export an EPUB from renderer-built bytes | `main.ts:8176 audiobook:export-from-project` | NONE | — | **MISSING — renderer-bound** (the handler is handed an `ArrayBuffer` the renderer produced) |

`cli/library.js` is the app's deliberate headless seam: seven of these handlers
are one-line wrappers over `library-actions.ts`, and `main.ts:8377` says so —
*"so the headless CLI exercises the identical path (cli/library.js)"*. The
remaining rows are the same shape of work and belong in that file.

## 10. Analysis, enhance, video, clipforge, serve

| # | Action | App entry | CLI | Same function? | Verdict |
|---|---|---|---|---|---|
| 10.1 | Analyze a book (queue row `book-analysis`) | `queue-steps/book-analysis.ts:84` → `book-analysis.ts:671 analyzeBook` | NONE | — | **MISSING** (headless-capable) |
| 10.2 | Analyze an audiobook | `book-analysis.ts:1341 analyzeAudiobook` | NONE | — | **MISSING** (headless-capable) |
| 10.3 | Enhance a recording (separate → denoise → enhance) | `main.ts:10040` → `enhance-bridge.ts:1159 runEnhanceProcessing` | NONE | — | **MISSING** (headless-capable) |
| 10.4 | Export an enhance mix | `enhance-bridge.ts:1675 exportEnhanceMix` | NONE | — | **MISSING** (headless-capable) |
| 10.5 | Render a video (queue row `video-assembly`) | `queue-steps/video-assembly.ts:59` → `video-assembly-bridge.ts:459 startVideoAssembly` | NONE | — | **MISSING — cannot be reached headlessly** |
| 10.6 | Run a ClipForge chain | `clipforge-bridge.ts:872` → `clipforge-chain.ts:645 runChain` | `node cli/clipforge-process.js` | **Yes** — literally the same module export | **PARITY** |
| 10.7 | ClipForge collection bookkeeping (probe row, staged files) | `clipforge-bridge.ts:618 runRecipe` (module-private) | NONE | — | **MISSING — IPC-only** (the wrapper is not exported; only `registerClipforgeIpc` is) |
| 10.8 | Start the Bookshelf server | `bookshelf-server.bookshelfServer.start` | `node cli/serve-bookshelf.js` | **Yes** | **PARITY** |
| 10.9 | Queue control (enqueue/start/pause/cancel/retry/reorder) | `electron/queue-ipc.ts:77-147` → `queue-engine.ts` | NONE | — | **MISSING** (headless-capable; would be the single door to every row above) |

**Why 10.5 cannot be closed.** `startVideoAssembly` constructs
`new BrowserWindow({ offscreen: true })` at `video-assembly-bridge.ts:512`, loads
an inline HTML data URL and captures frames off the offscreen renderer. A stub
whose `BrowserWindow` is `{ getAllWindows: () => [] }` has no constructor, and
the app refuses the job itself when no window exists
(`queue-steps/video-assembly.ts:48-53`). **A refactor would need** a different
frame renderer entirely (Puppeteer, `ffmpeg drawtext`, or `sharp`); the concat
and mux half is already a plain `spawn`.

## 11. PDF / document editing

Every `pdf:*` handler except `pdf:export-text-only-epub` operates on a
**worker-held open document** seeded by `pdf:analyze` and forwards
`event.sender` for progress: `pdf:render-*`, `pdf:export-*`,
`pdf:detect-chapters*`, `pdf:map-*`, `pdf:add-bookmarks`,
`pdf:assemble-from-images`, `pdf:update-spans-for-ocr`, `pdf:analyze-samples`.
Likewise `epub:parse`/`epub:save-modified`/`epub:set-cover`/`epub:set-metadata`
act on a module-singleton `EpubProcessor` opened by a previous call.

**Verdict: MISSING — session/renderer-bound.** A refactor would need the
worker-proxy session to be openable and addressable from outside the renderer
(an explicit document handle rather than an implicit singleton), which is a
change to how the picker holds its document.

---

## What this pass CLOSED

| Row | New command | Adapter | App function it calls |
|---|---|---|---|
| 2.2 | `--assemble` | `cli/orpheus-audiobook-render.js --assemble-only` (existing, now surfaced) | `denoise-job.runFinalDenoise` + `reassembly-bridge.startReassembly` |
| 2.3 | `--de-ring` | same | `ReassemblyConfig.applyDeRing` |
| 2.4 | `--assembly-gap` | same | `ReassemblyConfig.sentenceGap` |
| 1.x | `--skip-text-cleanup` | same | the render door's `textCleanup: 'skipped'` |
| 4.1 | `--denoise` | `cli/final-denoise.js` (new) | `denoise-job.runFinalDenoise` / `stopFinalDenoise` |
| 4.3 | `--rvc-enhance` | `cli/rvc-enhance.js` (new) | `rvc-job.runRvcEnhancement` / `stopRvcEnhancement` |
| 5.1-5.5 | `--retake` | `cli/correct-sentences.js` (new) | the five `correct-sentences-bridge` exports |
| 7.3-7.5 | `--pass --kind …` | `cli/pass.js` + `cli/processing-pass-step.js` (new) | `processing-chain.planProcessingChain` + `processing-passes.runProcessingPass` |

Also fixed: `python cli/bookforge-tts.py --help` died with a
`UnicodeEncodeError` on a default Windows console (cp1252 cannot encode the "≤"
in the packing-cap help), before printing a single command. The program now
declares its output UTF-8.

`tools/test-cli-parity.js` keeps every row above honest: each adapter must
require the COMPILED bridge, name the symbol the app's step names, and that
symbol must actually be exported by the compiled module — so a rename in
`electron/` fails there rather than in a shell.

## What is still owed, in the order it is worth doing

1. **Align (§3)** — blocked on the app-side step. When `NarratorPhase` gains
   `'align'`, add `--align` against that builder and wire `--coverage_report`
   into `--assemble` for Higgs.
2. **Queue control (10.9)** — one `--queue` command over `queue-engine` would
   reach every row in this table through the door the app actually uses, and
   would close 1.1/1.2's divergence as a side effect.
3. **`generate-sentences` for a variant (6.1)** — small, but it is an app change
   (nullable window), not a CLI one.
4. **The `library-actions` rows (9.8-9.14)** — mechanical, and `cli/library.js`
   is where they go.
5. **Analysis and enhance (10.1-10.4)** — mechanical; both bridges already take a
   null window.
