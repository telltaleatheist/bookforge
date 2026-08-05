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
after that**: OCR correction first, then footnote removal. The corrector must
therefore run on **sentences from a completed EPUB**, which is not what it was
trained on — it is line-trained on PDF text. The job is to rebuild its corpus at
sentence granularity from real pipeline output, and to include the split-word
("`totali tarianism`") cases that the pipeline currently produces.

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

**2. Do not mine hyphen examples from damage we are about to stop causing** —
unless we decide not to fix extraction. If extraction is fixed, pairs mined from
our own dropped hyphens target a distribution that no longer exists. Books where
the typesetter left no hyphen at all are the durable case; the model is the only
recourse there. Check the survey's recommendation before mining.

**3. Sentence splitting is not `split('.')`.** Abbreviations (`Dr.`, `Hrsg.`,
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
