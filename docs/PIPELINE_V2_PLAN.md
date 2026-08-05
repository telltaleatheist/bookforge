# Pipeline V2 — per-document stations (PLAN, 2026-08-04)

Owen's redesign after the first day on the document pipeline. Supersedes the
chain-wizard model. `docs/DOCUMENT_PIPELINE.md` remains the authority for the
document mechanics (binding, incremental updates, reset); this plan is the
authority for the FLOW and UI until built, then folds into that doc.

## The one idea

Processing is not a place. Every document row has a **Process** button; every
operation is a button on the station where its input lives; every step produces
or amends a visible artifact. Nothing is composed in advance — no chains, no
wizard. The pipeline is a ladder the user walks one press at a time.

```
Archive PDF ──cast + detect──▶ Working PDF ──curate──▶ (reflow) ──▶ EPUB ──▶ TTS ──▶ Assembly
 (immutable)                    (cast + annotations      the gate      all text     e2a (epub
                                 ONLY — never text        into the     transforms   is the hard
                                 edits)                   EPUB world   live here    requirement)
```

- **The working PDF is structural only**: the cast text layer plus block
  annotations (categories, deletions, merges, chapter titles). Its text is
  never edited. Curation only informs what reflow keeps.
- **All textual transformation happens on the EPUB**, on screen, where the
  user can read the result: OCR correction, footnote removal, simplify,
  translate.
- **Reflow as soon as possible.** The moment the user has said what to keep,
  the next step is the book. The golden path — cast → detect → curate →
  reflow — contains no optional steps.

## Stations and their actions

**RULED 2026-08-04 (first real session): you never START on a read-only book.**
Opening a PDF book mints the working copy and opens THAT, preserving the
original. The archive stays exactly what it was — untouched, and still a tab
you can look at — but it is not where the user is put, because a book that
answers no gesture reads as a broken picker. Consequences:

- A **text** PDF casts in seconds (`measureDocumentClass` → `scan --pdf`), so
  it is cast on open, silently.
- A **scanned** PDF cannot have a working copy without the render + OCR pass
  (~1.4 GB of page renders, minutes). So opening one offers that run
  immediately, with progress **inline in the modal** — see OCR below. Until it
  finishes there is no working copy, and the archive tab says so.
- **Detect is NOT bundled with the cast.** They are separate steps and separate
  queue jobs; casting must never enqueue a detect the user did not ask for.

| Station | Artifact on screen | Actions offered there |
|---|---|---|
| Archive | `archive/<Original>.pdf`, read-only, and not where a session starts | **OCR / Cast** (mints the working copy), **Detect** (separate, never implied) |
| Working | `<Original>.working.pdf` | **Detect** (re-run, one confirm), curation (select / delete / label / merge / chapter), **Build the book** (reflow) |
| EPUB | `<Original>.epub` | **OCR correction** (NEW foundry epub mode), **Remove footnotes**, **Simplify**, **Translate** — each edits the EPUB in place, result visible, provenance starred. They live on the LEFT RAIL, not on the station bar (see Picker modes and rail) |
| TTS | — | voice / engine / settings, enqueue TTS |
| Assembly | — | assembly options, produce the audiobook |

Preferred (not locked) order at the EPUB station: correction → footnotes →
simplify → translate. Presented in that order; any is runnable whenever an
EPUB exists. (Footnotes measures better on corrected text — 97.0/0.5 vs
90.5/2.1 — hence the ordering; it is a default, not a gate.)

## Gates (what locks what)

| Step | Requires | Skippable? |
|---|---|---|
| Cast | a PDF | No — mints the working sidecar |
| Detect | cast | No — reflow reads the annotations |
| Curation | detect | Yes |
| Reflow | detect | No — the gate into the EPUB world |
| Correction / Footnotes / Simplify / Translate | an EPUB | Yes, all |
| TTS | an EPUB | No — e2a accepts nothing else |

Enforced twice, same rule both times: the stage refuses at run time naming the
missing prerequisite (already true), and the button is disabled with the same
sentence (derived from the binding record + EPUB provenance — never stored as
separate state).

## The Next button

Pure navigation, never work. It walks Archive → Working → EPUB → TTS →
Assembly, lights up when the next station's artifact exists, and when locked
shows the sentence naming what is missing ("Next needs the book built — press
Build the book"). From the EPUB station, Next flows into TTS options, then
Assembly.

## Tabs in the picker

Yes. A tab per open artifact (archive / working / EPUB), PDFElement-style.
Running cast/detect from the archive tab opens the working tab; reflow opens
the EPUB tab. Long operations from the picker offer "run in background" (job
moves to the global monitor) and "open when finished".

## Long operations: inline, or handed over in front of the user

RULED 2026-08-04. A long run has exactly two shapes, and the difference is
where the user's attention goes:

- **Inline (default).** The OCR/cast run reports progress IN its modal, and
  the picker opens the artifact when it lands. Nothing to go and find.
- **Run in background.** The job moves to the queue and the app MOVES THE USER
  WITH IT: out of the picker, to the main window, onto the Queue, so the
  hand-off is witnessed rather than inferred. A job that silently vanishes
  from one place and silently appears in another is how work gets lost.

**"Open when finished" is an APP promise, not a picker one.** It must open the
finished artifact even when the user has left the picker — the run outlives
the window that started it, and the whole point of backgrounding is that they
went somewhere else. A checkbox that only pays out if you stayed and watched
is a checkbox that does nothing.

## Versions page

Grouped rows: the archive original is the parent; the working copy and EPUB
are indented children, visually one family. Star columns — Cast, Detect,
Corrected, Footnotes, Simplified, Translated — derived from the binding
record and EPUB provenance. The archive row can never earn a star, by
construction. No more stray line items.

**RULED 2026-08-04, reversing docs/DOCUMENT_PIPELINE.md: the working copy GETS
A ROW, and it is openable.** The old rule (sidecars get no line items, only
"Reset to [stage]") failed its first real session: a book was cast and
detected from the queue, and afterwards the versions page listed only the
archive — the work existed on disk and had no door. A user cannot be asked to
trust a pipeline whose products it does not admit to. The row is the working
copy's own; clicking it opens that artifact in the picker.

**A pass is not a version.** Footnote removal, simplify and translate produce
no new line item — they are STARS on the book they edited. Any existing
pass-shaped rows (the leftover footnote row seen 2026-08-04) come out.

**Staleness, said not locked**: curation edits after a reflow mark the EPUB
row "built before your last N edits" with a Rebuild button (binding boundary
timestamps vs the EPUB's writtenAt — already recorded). Rebuilding regenerates
a clean EPUB, which **discards** the EPUB passes done to the old one — their
stars clear, honestly.

### The third real session, 2026-08-04 — the rows had no buttons

"the archive and working pdf are missing their buttons on the version page.
export, open, delete." Not removed on purpose: the archive original is a
manifest VARIANT and carried Open/Export/Delete for as long as it was listed
under Book versions, and moving it into the family took them with it.

- **Export is on every document row**, through one entry point that branches on
  what the file IS — an EPUB through the packer that applies the project's
  metadata and cover, a PDF through save-a-copy. archive/ is READ; the copy
  goes where the user pointed the dialog. (The working copy's old "no Export"
  rule was a judgement about what the user should want.)
- **Delete is three acts.** Working copy → `document:discard` (PDF + binding +
  scratch, as one). Archive original → `variant:delete` (the precedent: record
  first, file only once the write is confirmed), with the working copy removed
  FIRST because it is bound to those bytes by hash, and the original left
  untouched if that half fails. Book EPUB → `document:delete-book`, which takes
  its provenance and its diffs with it.
- **RULED: Open lives on the working row alone.** Open on the archive row would
  open the PROJECT, and opening a project lands on the working copy — the row
  below it. The archive row renders Open **disabled**, carrying the sentence
  that says so, rather than shipping two buttons doing one thing.

**RULED: the lit star IS the way in to the diff.** "im not sure a button on the
version is the best way to do that now… but viewing the diff should definitely
be possible. and it should be linked to the file it was applied to." A star is
already the record that a pass ran, so pressing it opens what that pass changed.
It is a real button — the page's pill shape, an underlined "see changes",
hover/focus states, an accessible name that says the action — plus a line in
words under the row, shown only when a star there is actually pressable. A star
with no diff behind it stays an inert span. The provenance badges keep "Review
changes" only for kinds with no star column (the retired `tesseract` and
`detection`) and take them all back when the book's row is absent, so a diff is
never stranded and never behind two controls.

**RULED: a diff's lifetime is its artifact's lifetime.** Deleting the book takes
its `appliedPasses` and their `stages/NN-<kind>/` directories; so does
**rebuilding** it, which is the same event (the passes did not happen to the new
bytes). Written once as a pure function — `shared/document/pass-lifecycle.ts`,
tested in `tools/test-pass-lifecycle.js` — and carried out in
`registerEpubExport` / `forgetEpubExport`, proved on files in
`tools/test-epub-provenance-lifecycle.js`. Nothing else takes a diff: there is
no orphan sweep, so a stage directory no record names stays exactly where it is.

## Picker modes and rail

**RULED 2026-08-04, fourth real session: the rail's CONTENTS are a fact about
the ARTIFACT on screen.** Owen, standing at the EPUB station: "lets move
translate/simplify/footnotes to a left side nav just like the select/edit modes
were when in a pdf". The rail used to be shown `!curationLocked()` — "where
curation is possible" — which hid it at exactly the station the book's passes
live on. Two questions had been collapsed into one:

- **What the rail CONTAINS** is keyed by `ViewedArtifact`
  (`shared/document/rail-tasks.ts`, tested in `tools/test-rail-tasks.js`): the
  source gets Select / Crop / OCR text / Merge blocks, the book gets **Remove
  footnotes → Simplify → Translate**, and neither ever gets the other's. Phase
  D's `ocr-correct --epub` is one line in that table plus every site the
  compiler then names — `TaskId` is derived from it.
- **What is PRESSABLE** is `disabledTasks`, per entry, with the sentence that
  says why. Curation locked over the archive of a cast book disables those rows
  and carries the banner's own words onto them; the passes answer to their own
  two refusals (no project, no book) and to neither of the curation rules.

Digit shortcuts are per rail, so the book's first pass is 1 rather than 4, and a
digit can never reach a row that is not on screen. Each pass entry's status is
derived from `appliedPasses` through `latestPassByKind` — the same latest-wins
implementation the versions page's stars read, so a pass that has run says so in
both places or in neither. The station bar at the EPUB station keeps its tabs and
Next and offers no actions: a button there as well would be a second door to one
pass.

**RULED: footnote removal runs INLINE, in a modal with a bar.** "footnote
removal is pretty fast. instead of adding to the queue lets have it do it
quickly in a modal with a progress bar, just like the OCR modal on pdfs." It is
the OCR dialog's shape — inline by default, "run in background" handing the job
to the queue and taking the user to it — over the new `document:footnotes-epub`
stage. Simplify and Translate stay queued: they are hours, and their options
dialog already exists.

The extraction is the load-bearing part. `runEpubFootnotesOnBook`
(electron/processing-passes.ts) is the ONE description of what a footnotes run
IS — foundry, the diff, foundry's report kept beside it, the atomic swap onto
the book, and `appendAppliedPass` with the model, the marker count and the
diff's project-relative path — and both the queue job and the direct call run
it. A direct path that had been written separately could have skipped the
provenance, and a book with no record and no reviewable diff is
indistinguishable from a book nobody ran anything over. Proved on a copy of the
Kershaw project, 2026-08-04: both lanes produced a byte-identical EPUB, an
identical `stages/02-footnotes/{diff.json,report.json}` and an identical
`appliedPasses` entry.

The claim/announce/settle around ANY stage was extracted the same way
(`withProjectStage`, electron/document-stage-run.ts) — it had been written twice
(document-ipc's `withStage`, processing-passes' `withDocumentStage`). A queued
footnotes run consequently gains the `document:stage-*` broadcasts and the
`project:files-changed` it never sent, which is why the versions page did not
re-measure after one.

Two pointer modes (RULED 2026-08-04: Edit mode is deleted outright — see
Chapter titles below):

| Mode | Lives on | Notes |
|---|---|---|
| Select | PDF + EPUB tabs | The one curation mode; the label palette is inside it (right-nav tabs). Rail's separate Label entry deleted. |
| Crop | PDF tabs | Bulk spatial deletion — unchanged mechanics, deletion flags underneath. |

- **Edit mode is gone everywhere.** Hand text editing is unnecessary — the
  EPUB passes (correction, footnotes, simplify, translate) do the text work.
  The ONE exception is chapter titles, which are edited in the right-nav
  **Chapter tab**, not on the canvas: double-click a chapter entry to edit
  its text; merge adjacent chapter blocks from the same tab (usually already
  merged by then).
- **Merge** is a context-menu entry on a multi-selection in Select mode,
  enabled only when the selected blocks are ADJACENT — consecutive in reading
  order on one page — grayed out otherwise (stricter than today, deliberately).
- **Retired panels**: Headers & footers (its whole job is select-category →
  delete), Paragraphs (paragraph structure is reflow's job now; the panel fed
  the deleted client-side exporter).
- **Split spreads**: RESOLVED 2026-08-04 — Owen's corpus has no spread scans.
  Split leaves the rail entirely. If a spread book ever shows up, splitting
  returns as an option at the OCR/Cast step, consumed by cast.
- **Analysis and Search stay** as-is.

## What is retired

- The Processing, TTS, and Reassembly tabs. Replaced by the per-row Process
  button → this document's ladder, plus a small **global jobs monitor**
  (launch is per-document; watching/cancelling is global — jobs from many
  documents run concurrently and must stay visible).
- The chain wizard and its planner-side chain composition (the positional
  footnotes logic just built becomes moot — the ladder makes position
  explicit).
- Edit mode in the picker; Label as a separate mode (collapses into Select —
  one mode, palette on selection).

## Bugs folded in

- **Deletions never reach the document** (single delete, delete-all-like-this,
  category delete — measured on the Kershaw working file 2026-08-04: every
  relabel landed, zero deletions ever did). Relabel/retitle/merge write to
  `DocumentBlocksService` directly; all deletion paths ride an
  editorState→effect bridge that demonstrably never produces a write. Fix:
  deletions become direct service calls like relabel; the bridge is deleted.
  Root cause gets a regression test on the way out. **FIXED, Phase A.**

Found in the first real session, 2026-08-04 (Kershaw, cast + detected from
the queue — binding record shows both stages landed, working copy intact at
3,746,134 bytes):

- **The finished work had no door.** Versions listed only the archive; the
  working copy the user had just processed was unreachable from the UI. See
  the Versions ruling above.
- **A pass was still a row.** A footnote run from an earlier session was still
  listed as its own version line item.
- **Detect was queued unasked.** The OCR dialog submitted `get-text` AND
  `blocks` as one run, so casting always enqueued a detect. **FIXED, Phase B2:**
  the dialog submits the cast alone, and `planProcessingChain`'s blanket "a cast
  must be followed by a detect" refusal is replaced by the honest rule — a cast
  INVALIDATES what came before it, so a pass's prerequisite must have been
  written at or after the last cast (on disk or in the chain). `[get-text]`
  alone plans; `[get-text, reflow]` still refuses, naming Detect.
- **The queue lied about a stage.** `Detect blocks` reported 100% from the first
  page. **DIAGNOSED AND FIXED, Phase B2** — it was `parseProgress` taking the
  LAST `n/total` on a foundry line. foundry's blocks stage prints
  `page 7/300: 31/31 blocks labelled` per page (foundry `src/commands.ts:1307`);
  the first pair is the run and the second is that page's own tally, which is
  always n/n. StageTracker is monotonic, so one page pinned the bar at 100% for
  the rest of the stage. The row's STATUS was honest throughout, and nothing
  completes a row off `document:stage-finished` — both candidates were checked
  and refuted before anything was changed.
- **"Open when finished" paid out nothing** for a queued run, because the
  picker was closed by then — the promise has to be the app's. **FIXED, Phase
  B2:** the request lives in main (`electron/document-open-when-finished.ts`)
  keyed by project AND station, is consumed once, and is paid in two halves —
  main opens the book's editor window when the stage that mints that station
  ends, and the window that arrives takes the request and checks the station
  actually exists before showing it (`document:stage-finished` fires from a
  `finally`, so a failed or cancelled stage reaches the same code).

## The second real session, 2026-08-04 (after B2)

The station bar and the ladder work. What broke is the boundary between the
two artifacts: **the picker is still treating the built book as if it were the
working PDF.** Owen, standing at the EPUB station:

- "when i open the epub itself, it shows deleted blocks from the pdf. it
  shouldnt be overlaying changes/blocks from the pdf on top of the epub. this
  is a separate entity now"
- "when im in the epub, it has different block categories than the original.
  when it builds the epub, it marked the chapter header from the pdf as a
  title instead"
- "it appears as though it merges adjacent blocks" on the EPUB
- "footnotes, simplify, translate are grayed out"
- "the next button is 'next: working'. we left the working (pdf) copy to
  reflow the epub, we dont need to go back to the working copy once its
  reflowed"

**The overlay: hypothesis CONFIRMED, FIXED.** `documentBlocksMirror` was gated
only on `blockLayerRead()`, and the block layer is deliberately kept open at the
EPUB station (Phase B; `workingDocumentRef` tracks the project's PDF rather than
the file on screen, because building it from the displayed file tore the layer
down on every visit to the book — acd6eaa2). One correction to the hypothesis:
the route that actually fires it is **opening the book from the versions page's
EPUB row**, which mints a NEW window with `?source=<book>`. `curatedPdfPath` is
set only from a DISPLAYED pdf, so it is null there and `workingDocumentRef` is
`{ projectDir }` with no sourcePath; `resolveDocumentProject` then picks the
project's single PDF variant and hands back the WORKING document's blocks, which
the mirror paints over the EPUB's own `analyzePdfQuick` analysis.
`documentChaptersEffect` and the right-nav's Chapter tab did the same to the
book's chapters. The layer stays OPEN; the MIRRORING and every write that rides
it now stop at "is the project's PDF the file on screen" — measured from the
path, and therefore synchronous.

**Not a bug, and not touched:** the merged-looking blocks and the different
categories on the EPUB are the EPUB's OWN reading of itself.
`autoSegmentEpubParagraphs` consolidates mupdf's per-line blocks back into
paragraphs at ingestion (mupdf reflows an EPUB and drops its `<p>` structure),
and the categories are the EPUB analyzer's. That is what the EPUB station should
paint, and now does.

**REVISED, third session: the categories were the analyzer's, and they should
never have been.** Owen: "the chapter header is still being marked as a title
instead of a chapter header in the epub… we should be able to get the categories
to match identically, down to the paragraph blocks, since we're the ones
reflowing the pdf to the epub." Right — the book is not a stranger. foundry's
EPUB emitter now stamps `data-bf-category`, `data-bf-group` and `data-bf-blocks`
on the outermost element of every group it writes, and `readEpubBlockProvenance`
(electron/epub-processor.ts) reads them back by mapping the laid-out blocks onto
the source elements with `alignBlocksToEpub` — the same aligner the preserving
exporter uses, reused rather than re-written. Where an element states a category,
that value IS the block's category, used verbatim; a value outside the one
palette throws naming it. `bf_group`/`bf_blocks` ride on the block as the link
back to the working PDF, and several blocks sharing a group is the truth (mupdf
re-lays the book out; one authored paragraph becomes one block a line).

An EPUB with NO stamps is a different **input class**, not a missing value: a
book from elsewhere was never written by our reflow, so the font/geometry
classifier stays exactly as it is and the analysis says which of the two it read
(`AnalyzeResult.categoryProvenance`). A stamped book whose blocks fail to align
reports the count and raises an analysis warning — it may not degrade to guessing
in silence. Measured on the Kershaw working copy reflowed with that foundry
build: the heading comes back `chapter` where the byte-identical unstamped copy
gives `title`. Cost, on a 1,331-page EPUB: 12–42 ms for the class test, 363 ms
for the full alignment, inside the cached analysis — paid once per file.

**The greyed-out passes and "Next: Working" are ONE root cause. FIXED.**
`projectPath()` is null while the book is on screen: `showEpubStation` →
`closePdf()` → `projectService.reset()`, and `loadPdf` resets it again and then
skips `autoCreateProject` because a station swap is in progress. Nothing put it
back. No project means `stationActions` gives Footnotes/Simplify/Translate
`reason: noProject`, AND `bookEpubPath()` reads null — so the book's own station
measured as ABSENT and `stationNextStep` fell back to `nextStation('archive')`,
walking the whole ladder from the bottom. A station swap now keeps the project:
it changes which of a book's artifacts is in the viewer, not which book the
window is on.

**The ladder does not go backwards. FIXED.** Reflow is the gate into the EPUB
world; once the book exists, Next from the book is narration. It is never "back
to the working copy" — that is a step already taken. `nextStationFromViewed`
walks forward from where the viewer IS, and the property is tested for every
book shape and every rung.

**The station is DERIVED from the artifact.** It was a signal every load path
set and none of them agreed on: a window opened straight onto the book set no
station at all and read as "Working", which also left curation UNLOCKED over an
EPUB. Now `viewedStation = stationForArtifact(requestedStation, viewedArtifact)`,
with `viewedArtifact` measured from three paths (`shared/document/stations.ts`).

**Auto-merge before reflow is retired. DONE.** `autoMergeForPipeline()` predates
foundry's reflow, which does its own paragraph joining. Owen: "that logic was
designed to solve a problem that doesnt exist anymore." Its helpers
(`detectMergeableGroups`, `applyMergeGroups`, `detectParagraphs`,
`paragraphBreaks`) all STAY — checked, not assumed: the merge panel's own button
and `autoSegmentEpubParagraphs` still use every one of them.

**A new artifact appears the moment it exists. FIXED.** "i reflowed the file but
i dont see it listed in versions… there — it appeared. it should appear
immediately." Measured: the versions page re-read only on
`project:files-changed`, bumped by its Studio parent, and the QUEUE path never
sends that event — `withDocumentStage` (electron/processing-passes.ts)
broadcasts stage-started/progress/finished and nothing else, so a backgrounded
reflow was invisible to it. It now subscribes to `document:stage-finished`,
which BOTH producers broadcast to every window from a `finally`, and re-runs the
same `load()`.

**Still owed here:** none of this has been run in the app. Every claim above is
established from the code and from the pure tests; the smoke pass on a real book
is outstanding.

## Phase D — correcting the book (REWRITTEN 2026-08-04, after measurement)

`ocr-correct --epub`: book in, book out, on screen, reviewable. Correction
lives on the EPUB because that is where every text transformation lives, and
because correction buried inside reflow is invisible, un-re-runnable and
un-reviewable.

**Offered on every book, never refused.** Earlier drafts had it refuse a
text-class book on the grounds that the words are the publisher's. Owen's
counter-example kills that: "maybe it was imported as an epub but it was
converted from a pdf before it was imported." Our provenance knowledge is
incomplete, the error class is identical, and there are legitimate reasons we
cannot see. Say the caveat in the modal; do not lock the button.

**Order: correction FIRST among the EPUB passes.** Footnote removal measures
97.0/0.5 on corrected text against 90.5/2.1 on raw, so correcting afterwards
takes the worse number for nothing. Simplify and translate REWRITE the prose —
correcting after them means the rewrite consumed uncorrected text and you are
then editing the model's output rather than the book.

**Unit: sentences, not lines.** More context disambiguates more errors. The
generation budget is already derived from input length (`text.length + 64`), so
it scales by itself. Cap at ~400 chars, split only at a sentence boundary, and
if one sentence exceeds the cap split at a word boundary — a fixed cut lands
mid-sentence and recreates the fragment problem this is meant to escape.

**The prompt is NOT reworded.** `src/ocr/prompt.ts` says a near-miss prompt is
worse than an error, `contract-crosscheck.mjs` exists to catch drift, and the
eval data carries it verbatim. It says "a single line of text"; a sentence is
still a line of text. Rewording it leaves the trained distribution in the one
dimension this repo guards hardest — that is a retrain, not an edit.

**The guard must stop discarding whole units** (Owen, and he is right). Today
one bad word rejects everything, which on a 400-char sentence throws away every
good correction alongside it. The rule itself (word-level alignment, balanced
N→N substitution runs, each pair within Levenshtein 2) is scale-free and
survives; what changes is that only the offending RUN is rejected. Being
measured now against the held-out eval — the shipped whole-unit policy is the
control, `degraded` is the headline, and the "model deleted the word I" case
must still be refused. Retraining, or a bigger base, is on the table if the
numbers ask for it.

**A join is a recognition fix, and the current rule cannot express one.**
`totali tarianism` → `totalitarianism` is 2 words → 1: UNBALANCED, so the
shipped guard would reject the very repair most wanted. The extension: when an
aligned run's letters are IDENTICAL once whitespace is removed, it is a pure
join or split — no character invented, no word lost — and is always safe.
Anything that changes letters keeps the existing per-word rule, which is what
protects the measured failure (the model once deleted the word "I").

## Soft hyphens: a reflow bug, not a correction job (MEASURED 2026-08-04)

Owen: "spaces where words didnt join properly… theyre all over the place in
this book." Measured on his Kershaw book, in the archive PDF's own text layer:

```
line 51: …traditional views on ‘totali<U+00AD>
line 52: tarianism’ and to views of Stalin…
```

Those lines end in **U+00AD SOFT HYPHEN**, not `-`. `WRAP_HYPHEN_END` in
`src/paragraphs/hyphen.ts` is `/[A-Za-zÀ-ÿ]-[ \t]*$/` — ASCII hyphen-minus
only — and U+00AD appears nowhere in foundry, so the line reads as ending
without a hyphen and the join inserts a space. No model is involved and no
model should be: this is deterministic.

**A soft hyphen is less ambiguous than an ASCII one, not more.** The whole
corpus-attestation apparatus exists because `well-` at a line end might be a
real compound. U+00AD cannot be: it is by definition a typesetter's
hyphenation point, invisible unless the line breaks there. So it joins
unconditionally — no attestation, no hyphen kept — and a soft hyphen anywhere
else is invisible formatting that must never reach a TTS engine.

**THE HYPHEN NEVER ARRIVES — measured 2026-08-05, and the fix above is inert
until this is solved.** The join rule now handles U+00AD unconditionally and
still changes nothing on Kershaw, because the character is discarded before it
reaches the joiner. 34 of that PDF's 42 fonts carry a ToUnicode entry mapping a
glyph to U+00AD and page 2 draws two of them — but pdf.js's `getTextContent`
runs `if (category.isInvisibleFormatMark) { continue; }` against
`/^(\s)|(\p{Mn})|(\p{Cf})$/u`, so **every Unicode Cf character is dropped, glyph
and advance both**, with no option to keep it. The line ends `…views on ‘totali`
and the next opens `tarianism’` with no mark of any kind between them.

Recovering it means reconciling `getOperatorList()` (which keeps the glyphs)
against `getTextContent()` (which synthesizes whitespace from geometry) — a diff
between two streams, under the input distribution of every model in the repo.
It is a subsystem, not a patch, and it wants measuring across books first.
Recorded in `src/pdf/extract.ts`'s header so nobody re-derives it.

**Training the rejoin into the next model (Owen, 2026-08-05) — yes, but not on
this.** A model can learn `totali tarianism` → `totalitarianism`: neither
fragment is a word and the join is, which is a strong and safe signal. And
Phase D makes it reachable, because correction is offered on every book rather
than only on scanned ones. But mine that training data from books where the
hyphen is GENUINELY absent in the source, never from books where we dropped it
ourselves — teaching the model to clean up after our own extraction bug aims it
at a distribution that disappears the day the bug is fixed. Fix extraction
first; train on whatever residue remains.

Owen's framing, which is the general lesson: this whole class of damage "is an
artifact of joining two lines from a pdf instead of just doing it from an epub
from the start." A book that arrives as an EPUB has the publisher's own
paragraphs and never meets a line join. Every wrap-hyphen rule, every
attestation lookup and this bug all exist only on the PDF path — which is the
main path, so they must be right, but nothing on the EPUB path should ever grow
a line-joining step to be consistent with them.

## Footnote removal — what it missed, and what it was trained on

Owen, on the same book: "it missed a few. it did a good job overall but we
should probably modify the corpus to provide more examples like the ones it
missed." Two jobs, in order: collect the ACTUAL misses off his book as a named
list (the run writes `stages/NN-footnotes/report.json`, which records every
marker asked about and every refusal by reason — the misses are in there, not
guesswork), then decide whether they are a corpus gap or a guard rejection,
because those need opposite fixes.

**Check the training provenance before adding anything.** Owen believes the
footnotes model was trained on EPUBs and wants it verified rather than assumed
— and it matters, because `footnotes --epub` is the documented default while
`footnotes --pdf` is scanned-class only. If it was trained on PDF-derived text
the same input-shape question that Phase D is measuring for the corrector
applies here too.

## Foundry work

- NEW: `ocr-correct --epub` (epub-in → epub-out correction pass).
  **Validation owed**: the corrector is line-trained; post-reflow it sees
  joined paragraphs. First real book through the flow, compare against
  reflow's per-line correction before trusting it.
- DROPPED: the planned PDF text-layer correction mode. The working PDF's text
  is never edited.
- Reflow: correction stripped out of it? NO — reflow keeps its per-line
  correction capability as an implementation detail until the epub-mode pass
  is validated; the UI only ever offers correction at the EPUB station.

## Build phases

- **A (small, first): picker fixes.** Deletion rewired to direct document
  writes (+ page deletion), Label rail entry deleted (palette lives in
  Select), Headers & footers and Paragraphs panels retired, merge gated on
  adjacency, the delete-bug regression test. (Edit mode's fate was still
  open in Phase A; ruled in Phase B — deleted outright.)
- **B: stations + tabs.** Picker tabs, station actions where they belong,
  Next-button navigation with gate sentences, OCR modal reduced to Cast
  (correction moved out), "run in background" / "open when finished".
  Also (rulings 2026-08-04): Edit mode deleted outright and Split removed
  from the rail; chapter-title editing moves into the Chapter tab
  (double-click to edit, merge adjacent chapter blocks there).
  **A and B are MERGED (main ed3f1685).**
- **B2: what the first real session found.** Open a book onto its working copy
  (cast on open for text PDFs, offered inline for scans), cast and detect
  unbundled, OCR progress inline in its modal, "run in background" moving the
  user to the Queue, and "open when finished" honoured app-wide. **BUILT** —
  see the four bugs above and the notes below. The versions-page half (an
  openable working-copy row, pass-shaped rows removed, star columns) is Phase C
  and was deliberately not touched here.

  Two facts B2 had to build around, worth writing down:

  - **The picker is always its own BrowserWindow** (`openEditorWindow` in
    main.ts, route `/editor`). `EditorTabComponent` still exists but nothing
    renders `app-editor-tab` — it is dead code. So "move the user to the Queue"
    is a main-process action: raise the MAIN window and route it (`app:show-queue`).
    That is also the only place the queue lives — `processing:submit-chain` sends
    the plan to `mainWindow` and nowhere else — which is why the OCR dialog's
    `queued()` can never be true in the window it actually runs in.
  - **The cast is measured, not assumed.** `document:state` reports the class
    recorded in the working document's marker, which does not exist before the
    cast. `document:measure-class` (new) measures the archive original, and its
    two answers are seconds versus minutes — so a refusal leaves the class
    UNKNOWN and the book stands still rather than being guessed either way.
- **C: versions + retirement.** Grouped versions page with derived stars and
  staleness, the working copy given an openable row, pass-shaped rows removed,
  per-row Process button, Processing/TTS/Reassembly tabs replaced by ladder +
  global jobs monitor, chain wizard deleted.
- **D: foundry epub correction.** `ocr-correct --epub`, the EPUB-station
  button, the validation run against per-line correction.

Each phase lands independently.
