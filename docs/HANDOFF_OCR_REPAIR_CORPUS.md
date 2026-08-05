# Hand-off: the OCR repair corpus, to be built on the Mac

Written 2026-08-05 on owens-pc, for whoever picks this up on the Mac. The
corpus lives there; the GPU lives here. This document is the state of play, the
facts already established (so nobody re-derives them), and the work to do.

The design this serves is in `docs/PIPELINE_V2_PLAN.md` — read "The repair
architecture" and "Phase D" first. This document is the runbook, not the reasoning.

---

## The one-paragraph version

A book reaches the EPUB in the fewest steps that can answer "what stays"
(get-text → blocks → curate → reflow), and **every repair happens on the book
after that**: OCR correction first, then footnote removal. The corrector is
line-trained on PDF text, so the unit it should be served — and therefore
trained on — is the open question this corpus answers. **Measured 2026-08-05:
sentences do WORSE than lines with the current model** (see below), so either
serve line-shaped units recovered from the v0.5.0 `data-bf-blocks` stamps, or
train on sentences so serving them stops costing accuracy. The split-word
("`totali tarianism`") cases are NOT part of this job — they are an extraction
bug with a chosen fix; see landmine 2.

---

## State of play

**Shipped and pinned:** foundry v0.5.0 (BookForge's `FOUNDRY_CLI_VERSION` points
at it). Every element foundry's EPUB emitter writes carries
`data-bf-category` / `data-bf-group` / `data-bf-blocks`, and BookForge reads them
instead of guessing categories from font size.

**Merged to foundry `main`, NOT released** (so the app does not have it yet):
- `ocr-correct --epub` — book in, corrected book out, plus a report. Sentence
  units capped at ~400 chars, splitting only at sentence then word boundaries.
  Uses `repairLines` and the prompt unchanged.
- The soft-hyphen join rule — correct, tested, and **inert on the PDF path**
  (see landmine 1).

**In flight when this was written** (check for results before repeating any of it):
- A guard measurement: whole-unit vs per-run rejection, and sentence vs line
  units, on Kershaw with induced errors via `tools/foundry-ocr/degrade.py`.
- A survey of how widespread the dropped-hyphen damage is across the library.

**Not built:** the sentence-granularity corpus. That is this hand-off.

---

## Where things are

| | Mac | owens-pc |
|---|---|---|
| Training corpus | `/Volumes/Callisto/training/rubric/` | — |
| OCR line corpus | `rubric/galley/sft-line/` (`eval.jsonl`, 21,696 rows) | — |
| Footnotes corpus | `rubric/dagger/` (`sft/train-v3-4b.jsonl`, 4,398 rows) | — |
| BookForge checkout | `/Volumes/Callisto/Projects/BookForgeApp` | `C:\Users\tellt\Projects\bookforge` |
| foundry checkout | (check) | `C:\Users\tellt\Projects\foundry` |
| Models (base + adapters) | — | `%LOCALAPPDATA%\foundry\models\` |
| GPU | no | RTX 3090 Ti |

**Mine and build on the Mac. Train on owens-pc.** The standing corpus-prep
doctrine says not to train on the Mac, and the GPU is here.

**Sync the checkouts with git, never `cp`/`scp`/`rsync`.** Windows has
`core.autocrlf=true`, so copying working files into a macOS checkout injects
CRLF *and* leaves that checkout's HEAD stale — every copied file then shows as
locally modified forever. After pulling on the Mac, run `npx tsc` before using
the CLI; a stale `dist/` there has bitten before.

---

## MEASURED 2026-08-05 — read this before planning anything

The guard/sentence experiment finished. Raw generations are kept in
`tools/foundry-ocr/results-guard-experiment/dumps/` so any claim below can be
re-scored rather than re-argued. Branches: foundry
`experiment/ocr-guard-and-sentences`, bookforge `experiment/ocr-sentence-eval`.
The adapter was proved active first (71/120 exact with it, 22/120 without).

**Sentences catch FEWER errors than lines, not more.** On identical text, lines
repaired more per 100k characters in every paired cell, at a false-edit rate of
0.6–7% against 12–25% for sentences. Extra context does help when a line is
unreadable (heavy damage, no guard: 7.070% → 4.789%) but the model expresses it
as REWRITING and the guard discards it. This is the opposite of what the
architecture assumed. It does not invalidate the architecture — it means one of
two things must be true:

- **Path A, available today, no retrain:** correct the EPUB in LINE-shaped units
  rather than sentences. v0.5.0 stamps every element with `data-bf-blocks`, the
  source block ids, so the line structure is *recoverable on the book*. Serve
  the model the shape it was trained on, on the artifact the user can read.
- **Path B, Owen's plan, needs this corpus:** train on sentences, then serve
  sentences. The measurement says the CURRENT model is worse on sentences, which
  is exactly what training on them would fix. This is the reason to build the
  corpus, not a reason to abandon the plan.

**The guard: keep whole-unit for lines; per-run only when units grow.** On lines
the two are indistinguishable — the differences rest on 2 of 390 and 6 of 1,232
units. On long units it is decisive: at 400 chars and 7% CER whole-unit becomes
an off switch (6 corrections in 102 units) where per-run keeps 96. No guard
never ships: on real Kershaw sentences it more than doubles CER over doing
nothing.

**An argument FOR whole-unit that nobody anticipated.** One line held both
`Anton Hoch` → `Anton Höch` (legal at d≤2, and WRONG) and `Biirgerbraukeller` →
`Bürgerbräukeller` (illegal at d=3, and RIGHT). Whole-unit refuses both; per-run
keeps the wrong one and reverts the right one. **An illegal run is evidence
about the whole answer.** Per-run is not strictly better.

**The join exemption is confirmed necessary, not optional.** On Owen's book the
model gets the `totali tarianism` family RIGHT, and every one is 2 words → 1, so
**both** policies refuse them structurally. The balance rule cannot say yes to a
merge. 22 further legal runs were stranded by whole-unit.

**What a retrain should target — typography, not size.** The dominant residual
damage that PASSES the guard is typography normalisation (curly quotes to
straight, em dash to hyphen); the corpus README predicted exactly this — "train
on that and you get a Unicode normaliser". The d≤2 threshold also splits one
German repair class arbitrarily: `Miinchner`→`Münchner` accepted at d=2,
`Biirgerbraukeller`→`Bürgerbräukeller` refused at d=3. **The numbers argue for a
retrain, not a bigger model.**

**On Owen's book the model did well:** `mid-i92os`→`mid-1920s` and
`mid-i93os`→`mid-1930s` both fixed under every policy; `Führer` 33/33, `Hitler`
89/89, `Lammers` 5/5, `Reich` 16/16 intact; `Son-derweg).` correctly healed.

**CORRECTION — Kershaw is NOT publisher truth, contrary to what this document
said above.** Its archive PDF is a **JBIG2 scan with an OCR text layer**.
foundry classified it `text` because it HAS a text layer, and
`measureDocumentClass` cannot tell a typesetter's layer from an OCR'd one — so
**correction was skipped on a book that needed it**, and `mid-i92os` is an OCR
error baked into the "text". That is a real gap, it is why Owen's ruling that
correction must be offered on every book is right, and it means scoring against
Kershaw's own text layer scores against an earlier OCR pass rather than truth.
The corpus-slice rows carry real tier-1/2 truth and agreed with Kershaw on every
direction, which is the only reason the Kershaw numbers can be read at all.

## Facts already established — do not re-derive these

**1. Truth is PDF text layers, not EPUBs.** `tools/foundry-ocr/mine-book.mjs`:
pairs are the app's own headless OCR of a rendered page against the born-digital
PDF's own text layer, matched by GEOMETRY (`align-pairs.py`), never by text
similarity. Free and unlabelled — and its header names the hazard itself: a
confidently-wrong text layer trains the model to *introduce* the error, which is
why `build-corpus.mjs` gates on per-book stats and mining a book is not the same
as accepting it. Only the footnotes corpus has EPUB truth: 1,200 of 4,398 rows
from publisher EPUBs across 78 books. **There are no matching EPUBs for
everything.**

**2. The corpus truth and the pipeline output come from DIFFERENT extractors,
and that asymmetry is useful.** `align-pairs.py` reads truth with `fitz`
(PyMuPDF), which PRESERVES U+00AD. foundry's runtime reads with pdf.js, which
DROPS it (landmine 1). So the same book yields `totalitarianism` on the truth
side and `totali tarianism` on the pipeline side — which is exactly the training
pair needed to teach the rejoin, generated for free, on-distribution by
construction. **VERIFY THIS BEFORE RELYING ON IT**: confirm `get_text('words')`
preserves U+00AD the way `mutool draw -F txt` does; they may normalize
differently.

**3. The prompt is trained-against and must not be reworded.**
`foundry/src/ocr/prompt.ts` says a near-miss prompt is worse than an error, and
`tools/foundry-ocr/contract-crosscheck.mjs` exists to catch drift. The eval rows
carry the system prompt verbatim. It says "a single line of text from a scanned
book"; a sentence is still a line of text. If sentence training needs different
wording, that is a deliberate retrain decision, not an edit.

**4. The guard is per-word and scale-free** (`foundry/src/ocr/guard.ts`): align
as word sequences, accept only balanced N→N substitution runs with each pair
within Levenshtein 2; any insert, delete or unbalanced run rejects the WHOLE
unit. Measured as additive: EN CER 0.357% → 0.317%, degraded 37 → 15; DE
degraded 52 → 29. It exists because the model once deleted the word "I".
**A join is unbalanced (2 words → 1), so the shipped guard rejects the very
repair we most want** — confirmed live on Kershaw. Two changes are planned: a
join/split exemption (identical characters once whitespace is removed = no
character invented, always safe) and per-run rather than whole-unit rejection.

**5. `degraded` is the headline, not CER.** A book is 80–95% already-correct
lines, so a corrector can cut pooled CER handsomely while mangling several
hundred proper nouns. `Reichsführer` → `Reichsfuhrer` costs almost nothing in
aggregate characters and everything in a finished audiobook. Every result is a
PAIR — what it repaired, and what it cost — and the do-nothing baseline is
printed alongside or the comparison is meaningless. `eval-line.py`'s docstring
says this better; read it.

**6. The footnote model is not the corrector and does not want the same unit.**
Its misses on Kershaw were 2 of 62, both copy-fidelity failures on the anchor,
both correctly refused by the applier. Cause was unit length: 3 mega-paragraphs
made 26 of 29 units hit the 1600-char ceiling, where 90% of the run sat in a
bucket that is 1% of its training. Footnotes needs context AROUND a marker;
the corrector needs a sentence. Do not assume one unit size serves both.

---

## Landmines

**1. The hyphen never reaches the joiner.** pdf.js's `getTextContent` runs
`if (category.isInvisibleFormatMark) { continue; }` against
`/^(\s)|(\p{Mn})|(\p{Cf})$/u`, dropping every Unicode Cf character, glyph and
advance, with no option to keep it. Kershaw's archive PDF has 34 of 42 fonts
mapping a glyph to U+00AD and page 2 draws two of them; nothing with that
character reaches foundry. Written up in `foundry/src/pdf/extract.ts`'s header.
Consequence: `totali tarianism`, `modernis ing`, `compar ing`, `commit tees`.
BookForge's `electron/epub-processor.ts` already strips U+00AD on the EPUB path,
so this bites PDF-sourced books only.

**2. DO NOT mine hyphen examples from our own dropped hyphens — SETTLED
2026-08-05 by `docs/PDF_SOFT_HYPHEN_SURVEY.md`.** The survey read all 160
archive PDFs (50,581 pages, 1,790,536 lines) with foundry's own pinned
pdfjs-dist, patched so the drop is switchable, and read every book twice in one
process. **The extraction fix is going in**, so pairs mined from this damage
would target a distribution that is about to disappear. Books where the
typesetter left no hyphen at all remain the durable case, and the model is the
only recourse there — mine THOSE.

The numbers, because they also size the prize: 43 of 160 books actually draw a
soft hyphen; **54,305 assembled lines change, 53,103 of them line-final — that
is 53,103 words currently split by a space.** Median damage in an affected book
is 82 per 1,000 lines and the worst is 251. In affected books **89.1% of every
wrap hyphen is a soft hyphen** — those books have no other kind, which is why
the ASCII-only rule never saw a thing. Only U+00AD matters: 55,126 of 55,130
drawn Cf glyphs, with U+200B/200C/200D/2060/FEFF drawn ZERO times in 50,581
pages. The fix is as narrow as it could possibly be.

**The repair, costed and chosen: patch pdf.js.** `bun patch` on pdfjs-dist
(a plain dependency, not vendored; `release-build.sh` compiles from
node_modules) deleting the one `isInvisibleFormatMark` line — 100% of the
damage, about half a day, one patch file. Operator-list reconciliation was
measured at 99.8% for 12x the extraction cost and a standing bet on pdf.js
internals; geometry helps 7 of 36 books at 22% median precision; attestation
over the bare join reaches only **34%**, not the 90% the brief guessed.

**The pairing is already in place.** The survey warns that fixing the reader
ALONE makes output worse — `linejoin.ts` would take the `!halves` branch and
emit `totali<AD> tarianism`, the same wrong space plus an invisible character.
It concluded foundry has no soft-hyphen rule; **it grepped a stale branch.**
foundry `main` HAS the rule (`SOFT_HYPHEN`, `SOFT_HYPHEN_END`,
`SOFT_HYPHEN_SPLIT` in `src/paragraphs/hyphen.ts`, merged with Phase D). So the
foundry half is done and only the reader patch remains.

**One more thing the survey measured:** 1.2% of true soft-hyphen joins (629)
have `head-tail` attested as a real compound elsewhere in the book. So
BookForge's unconditional `electron/epub-processor.ts`
`replace(/­\s*/g, '')` is slightly wrong — a restored mark should go
through `proveHyphenVerdict` rather than weld unconditionally.

**And the attestation rule as originally briefed is INERT**: "joined attested
and neither fragment attested" fired ONCE in 161 books with 0 true positives,
because `totali` stands alone at a line edge and attests itself. Built from
INTERIOR tokens only it reaches 34.4% recall at 98.9% precision (74 fires in
685,233 joins on hyphen-free books; all 74 inspected, one genuine error).
Dropping either fragment guard admits `to`+`ofter`->`too` and `a`+`loud`->`aloud`.

**3. Sentence splitting is not `split('.')`** — and see the measurement above
before assuming sentences are the unit at all. Abbreviations (`Dr.`, `Hrsg.`,
`Bd.`, `S. 123`, `ibid.`), initials (`J. P. Taylor`), decimals and ellipses must
not end a unit. A history book's endnotes are full of them and a naive split
manufactures the fragments this design exists to escape. Owen's rule: **when in
doubt, send more through.**

**4. Serving the adapter.** Base + LoRA via `--lora-scaled <adapter>:0.0` with
per-request activation is foundry's multi-LoRA pattern. Scale 0.0 at load means
the adapter contributes NOTHING unless per-request activation is genuinely
wired. **Prove the adapter is active before trusting any number** — generate one
known-error line with it on and off and show the outputs differ. A whole
measurement run was nearly spent on the bare base model this way.

**5. GPU courtesy on owens-pc.** Create `%APPDATA%\BookForge\external-gpu-job.lock`
while holding the card and remove it after; BookForge's own sweeps check it.

---

## The work

1. **Decide the truth source**, using fact 2 and landmine 2. Either the PDF text
   layer read with PyMuPDF (abundant, free, and carries the hyphens), or
   publisher EPUBs (clean, but you need the same book as a scan to pair).
2. **Build sentence-granularity pairs from real pipeline output.** Run books
   through the actual path — get-text → blocks → reflow → EPUB — and split the
   result with the SAME splitter that will run at serving time, so the training
   unit and the serving unit are the same object. `tools/foundry-ocr/` already
   holds the miners, the degrader, the truth gate and the corpus builder;
   extend rather than start over.
3. **Include the split-word cases** Owen asked for, subject to landmine 2.
4. **Keep the eval honest**: hold out books, not rows, and report the pair —
   repaired versus degraded — against the do-nothing baseline.
5. **Train on owens-pc**, not the Mac.

Before starting, check the two in-flight measurements above: they may answer
whether a retrain is needed at all, and whether the extraction fix removes the
need to teach the rejoin.
