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
| EPUB | `<Original>.epub` | **OCR correction** (NEW foundry epub mode), **Remove footnotes**, **Simplify**, **Translate** — each edits the EPUB in place, result visible, provenance starred |
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

## Picker modes and rail

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
- **Detect was queued unasked.** The OCR dialog submits `get-text` AND
  `blocks` as one run, so casting always enqueued a detect. They separate.
- **The queue lied about a stage.** The `Detect blocks` job reported complete
  while it was still running — job completion is being reported off something
  other than the stage actually ending. Needs diagnosis, not a guess.
- **"Open when finished" paid out nothing** for a queued run, because the
  picker was closed by then — the promise has to be the app's. See above.

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
- **B2: what the first real session found.** The five bugs listed under "Bugs
  folded in", plus the two flow rulings above: open a book onto its working
  copy (cast on open for text PDFs, offered inline for scans), cast and detect
  unbundled, OCR progress inline in its modal, "run in background" moving the
  user to the Queue, and "open when finished" honoured app-wide.
- **C: versions + retirement.** Grouped versions page with derived stars and
  staleness, the working copy given an openable row, pass-shaped rows removed,
  per-row Process button, Processing/TTS/Reassembly tabs replaced by ladder +
  global jobs monitor, chain wizard deleted.
- **D: foundry epub correction.** `ocr-correct --epub`, the EPUB-station
  button, the validation run against per-line correction.

Each phase lands independently.
