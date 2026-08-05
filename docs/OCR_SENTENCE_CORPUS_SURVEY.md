# OCR-correction corpus: line → sentence. Investigation report

Written 2026-08-05 on the Mac, answering `docs/HANDOFF_OCR_REPAIR_CORPUS.md`.
Read-only survey of the corpus (`/Volumes/Callisto/training/rubric/`), the
mining toolchain (`tools/foundry-ocr/`, `tools/ocr-lab/`), and the open
verification items, at repo HEAD `0bbc921`. Companion to
`docs/PDF_SOFT_HYPHEN_SURVEY.md`, which settled landmine 2.

---

## 0. The single most important structural correction

**There are TWO independent mining pipelines under `tools/foundry-ocr/`, and the
hand-off's "fact 1" describes the wrong one.**

| | **block corpus** (`galley/sft/`) | **line corpus** (`galley/sft-line/`) ← *the one that trained the shipped model* |
|---|---|---|
| truth source | the **PDF's own text layer**, read with `fitz` | a **publisher EPUB** |
| aligner | `tools/foundry-ocr/align-pairs.py` (geometry / box overlap) | `tools/ocr-lab/align-epub.py` (anchors + LIS) |
| miner | `tools/foundry-ocr/mine-book.mjs` | `tools/ocr-lab/run-book.py` + `bands.py` |
| builder | `tools/foundry-ocr/build-corpus.mjs` | `tools/foundry-ocr/build-dataset.py` |
| target | an **edit list** (`before → after`) | the **corrected line** (free text) |
| status | built, **never trained** | built + trained → `foundry-ocr-v1-4b` |

`build-dataset.py:15-17` states its input verbatim:

> `Input  : <lab>/<book>/scores/epub-align-pairs.json, one file per book, written by tools/ocr-lab/align-epub.py.`

and `build-dataset.py:21-24`:

> `THIS IS THE LINE MODEL, NOT THE BLOCK MODEL. tools/foundry-ocr/build-corpus.mjs builds a different corpus for a different unit`

Consequence for the plan: hand-off fact 2's "the same book yields
`totalitarianism` on the truth side and `totali tarianism` on the pipeline side
— free training pairs" is a property of the **`align-pairs.py` /
PDF-text-layer** path, i.e. the *block* corpus, which was never trained. The
corpus actually being rebuilt never sees a PDF text layer at all. Combined with
landmine 2 now being settled, that argument is doubly moot.

---

## 1. The existing line corpus

### 1a. Files and row counts (measured, not quoted)

`/Volumes/Callisto/training/rubric/galley/sft-line/`

| file | rows | identity | edit | books |
|---|---|---|---|---|
| `train.jsonl` (40 MB) | **47,270** | 23,635 (**50.0%**) | 23,635 | 12 |
| `eval.jsonl` (18.6 MB) | **21,696** | 19,228 (**88.6%**) | 2,468 | 2 (deathstalker-coda 12,682 / michelle-remembers 9,014) |
| `eval-german.jsonl` (3.1 MB) | **3,586** | 2,373 (66.2%) | 1,213 | 1 (himmler-a-life, pp. 924–1011) |
| `eval-parity-1k.jsonl` (862 KB) | **1,000** | 500 (50.0%) | 500 | 2 |
| `pairs-repaired.jsonl` (20 MB) | **72,552** | — | — | 14 |
| `build-stats.json` | — | — | — | — |

`pairs-repaired.jsonl` is exactly `train + eval + eval-german` (47,270 + 21,696
+ 3,586 = 72,552) in pair form rather than chat form. It is **not** the full
pre-downsample set — see §5b.

> ⚠️ **`tools/foundry-ocr/README.md:105-108` is stale.** It says train 46,726 /
> eval 21,268 / eval-german 3,559 and "310,915 raw pairs". The shipped
> `build-stats.json` and the files on disk say **47,270 / 21,696 / 3,586** and
> `rawPairs: 310,796`. Trust the JSON and the files.

### 1b. Exact row schema — verbatim first row of `eval.jsonl`

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You correct OCR errors in a single line of text from a scanned book.\n\nReply with the corrected line and nothing else.\n\nRules:\n- Reply with the whole line, not just the part you changed.\n- Correct only what the scanner misread. Do not reword, translate, modernise\n  spelling, or change punctuation that is merely old-fashioned.\n- Keep a hyphen at the end of the line exactly as it is. The word finishes on\n  the next line, which you cannot see.\n- If the line has no OCR errors, reply with it unchanged."
    },
    { "role": "user",      "content": "ready have more than enough, and the Wild Rose of the Arena, who J still" },
    { "role": "assistant", "content": "ready have more than enough, and the Wild Rose of the Arena, who I still" }
  ],
  "book": "deathstalker-coda",
  "page": 189,
  "line": 6385,
  "cer": 0.01389,
  "identity": false,
  "truthTier": 2
}
```

Every row in all four JSONL files carries exactly the key set
`('book','cer','identity','line','messages','page','truthTier')` — verified
across all 73,552 rows, zero variants. **Exactly one distinct system prompt**
across every file.

The emitter is `build-dataset.py:950-959`. `SYSTEM` is defined at
`build-dataset.py:207-218` and is byte-identical to `sentences.py:99-111`'s
`OCR_SYSTEM_PROMPT` and to foundry `src/ocr/prompt.ts`'s `OCR_SYSTEM_PROMPT`
(proven by `sentences.py --self-test`, `sentences.py:432-444`).

### 1c. Book identity and holdout

- **`book` is a per-row field** — a slug (`deathstalker-coda`,
  `himmler-a-life`, `michelle-remembers`, `rise-and-fall`, …). `truthTier` is
  per-book (1 = publisher EPUB truth, 2 = tier-2, `null` = unknown).
- **Holdout is by whole book, declared in code, and asserted.**
  `build-dataset.py:135-146`:

```python
HOLDOUT_BOOKS = [
    'deathstalker-coda',
    'michelle-remembers',
]
```

  with the reasoning inline (lines 130-134): *"A page-level split leaks: the
  same running heads, the same scanner, the same typeface on both sides, and
  the model scores well by recognising a book."* The split is enforced at
  `build-dataset.py:793-794` and leak-checked at line 849, exiting non-zero if
  any book leaks.
- Also declared: `QUARANTINED_BOOKS` (lines 152-155, the two What-to-Expect
  books, 38,937 rows excluded), `CAPPED_BOOKS = {'rise-and-fall': 0.10}` (line
  176), `GERMAN_SLICE_BOOK = 'himmler-a-life'` / `GERMAN_SLICE_SHARE = 0.10`
  (lines 193-194).
- **Book-level holdout carries over to sentences for free** —
  `sentences.py:222-225` groups by `r['book']` and never packs across books.

### 1d. Identity ratio — the precedent

| corpus | identity share | set by |
|---|---|---|
| `train.jsonl` | **exactly 50.0%** | `--identity-share 0.5`, `build-dataset.py:628`, downsample at 806-808 |
| `eval.jsonl` | **88.6%** (natural, undownsampled) | holdout books kept whole |
| block corpus (`build-corpus.mjs`) | ≥50% | `--identity-share 0.5`, line 74 |
| footnotes (`dagger`) corpus | its `none` discipline | — |

The reasoning, `build-corpus.mjs:44-47` (verbatim):

> `Restraint is the whole game. A model that fixes nothing scores a perfect
> false-edit rate and is useless; a model that edits confidently everywhere
> rewrites the author. So the corpus is deliberately held at ≥50% identity rows
> (--identity-share), matching the footnotes model's `none` discipline.`

**Precedent for the new corpus: 50%, matching both existing corpora.** (But see
§5d — a *unit-level* 50% is not the same object.)

### 1e. Character-length distribution of `user` (the OCR input)

| file | min | p10 | p50 | p90 | p99 | max | mean |
|---|---|---|---|---|---|---|---|
| `train.jsonl` | 3 | 37 | **59** | 75 | 84 | 98 | 58.1 |
| `eval.jsonl` | 1 | 31 | **68** | 74 | 78 | 96 | 61.5 |
| `eval-german.jsonl` | 4 | 20 | **72** | 82 | 88 | 92 | 60.0 |

This is a Tesseract `--psm 7` band: ~60 characters. The sentence target is ~400
— **a 6–7× jump in unit length**, and the guard measurement says that jump is
precisely where `whole-unit` rejection degenerates.

For contrast, the measured sentence units from the guard experiment
(`results-guard-experiment/dumps/`):

| dump | units | src len min / p50 / p90 / max |
|---|---|---|
| `corpus-slice.sent.dump.jsonl` | 284 | 7 / **299** / 367 / 400 |
| `kershaw-epub.dump.jsonl` | 145 | 26 / **312** / 390 / 400 |

### 1f. README / notes files in the corpus tree

**There are none inside `/Volumes/Callisto/training/rubric/`.** The only
`.md`/`.txt` files under it are HuggingFace adapter artefacts, `dagger/foundry-footnotes-LAUNCH.txt`, and
`merge-experiment/conflict-punch-list.txt`. Nothing about the OCR corpus.

**The README the hand-off means lives in the repo**:
`tools/foundry-ocr/README.md` (659 lines, freshly rewritten at `0bbc921`). The
typography-normalizer prediction is at **README.md:208-210**, verbatim:

> `§12d already measured where that ends — clean renders are 0.45% CER of which
> two thirds is ligature and quote normalisation, so training on them builds a
> Unicode normaliser instead of an OCR repairer.`

Restated at **build-dataset.py:170-172** in the `CAPPED_BOOKS` comment. The Aug
5 measurement (README.md:609-613) confirms it landed: *"The residual damage
under the guard is TYPOGRAPHY… This is the corpus's own prediction landing."*

Two other README passages are directly load-bearing for the new corpus:
- **README.md:161-178** — the `|` decision. Trailing `|` is pre-stripped as a
  *pipeline step*, not a model behaviour: *"The same strip must run at serving
  time, before ocr sees the line."* This obligation survives into any sentence
  pipeline.
- **README.md:180-197** — edge extensions are clamped, and the count is kept as
  a regression detector on the band cropper.

### 1g. One-line inventory of `/Volumes/Callisto/training/rubric/`

| dir | what |
|---|---|
| `galley/` (174 MB) | **the OCR corpus** — `sft-line/` (line, trained), `sft/` (block, never trained), `pairs/` (177 books), `degraded/`, `paragraph-probe/`, three tarball snapshots |
| `dagger/` (94 MB) | footnotes corpus — `sft/train-v3-4b.jsonl` (4,398 rows), evals, `build_corpus.py` |
| `foundry-footnotes-v{1,2,3}-*/` (3.3 GB) | trained footnote LoRA adapters |
| `blocks-v5-06b-{mlx,rig}/` (264 MB) | trained blocks adapters + eval JSONs |
| `sft/`, `sft-split/`, `sft-mlx/`, `aligned/`, `corpus/`, `matter-relabel/`, `continues-probe/`, `merge-experiment/`, `epub-derived/`, `ocr-repair/` | blocks-model corpus generations and probes |
| `_retired/` (251 MB) | superseded artefacts |
| ~14 `<Book_Title>/` dirs | per-book blocks labelling working dirs |
| `eval-*.json`, `projection-report-v4.json` | scoring outputs |

Separately, `/Volumes/Callisto/training/ocr-lab/` holds the **line corpus's raw
inputs** — 16 book dirs each with `scores/epub-align-pairs.json`, plus `gold/`,
`born-digital-report.md`, `sweep-report.md`.

---

## 2. The mining toolchain

Location confirmed: `tools/foundry-ocr/` (28 entries). Sibling:
`tools/ocr-lab/` (`align-epub.py`, `align-pdftext.py`, `bands.py`,
`extract_reference.py`, `run-book.py`, `score.py`).

### 2a. Tool-by-tool

**`mine-book.mjs`** — *block path only.* Consumes `--book <id> --pdf <file>
--from <page0> --pages <n>`. Two steps (`mine-book.mjs:8-15`): `dump-ocr.js`
(the app's own headless OCR at 200 dpi, keeping **per-LINE** text that
`blocks.json` drops), then `align-pairs.py`. Refuses re-mining without
`--force` (line 62). Surfaces `cmapSuspects` and `alignmentRate < 0.85` as
warnings (lines 93-101) but does not gate — *"mining a book is never the same
thing as accepting it"* (line 22).

**`align-pairs.py`** — *block path; the only place `fitz` reads truth.* Truth
read at **`align-pairs.py:93-106`**: `fitz` / `page.get_text('words')`, no
flags, default parameters. Correspondence is box overlap only (`MIN_OVERLAP =
0.30`, line 109); edit distance is used afterwards to *score*, never to
*assign* (lines 3-8).

**`build-corpus.mjs`** — *block path.* Per-book gating, the part worth reusing:
- `--stats <dir>` is a **hard requirement**: `build-corpus.mjs:130-136` exits
  with *"Building without the gate produces a corpus that looks fine and
  teaches the model to write 'Frank =appa'."*
- Any book in the pairs with no `<book>.stats.json` is a hard stop (lines
  158-166), not a silent skip. A separate `mined-truth-quality.json` (from
  `gate-mined-truth.mjs`) is also mandatory (lines 184-189); only `unusable`
  excludes; `suspect` is weak evidence (line 180).
- Per-pair gates + identity discipline: `--max-cer 0.08` above
  `--min-len-for-cer 40`, `--identity-share 0.5` (line 275).
- Every row is round-trip verified through `edits.mjs` before writing.

**`build-dataset.py`** — *line path; this is the builder to extend.* Inputs
`<lab>/<book>/scores/epub-align-pairs.json`; outputs `train.jsonl`,
`eval.jsonl`, `eval-german.jsonl`, `pairs-repaired.jsonl`, `build-stats.json`.
Its repair ladder (each rung counted on every run so a fixed aligner reads
zero): `edgeTokensRestored 3,645 · hyphenRepaired 24,094 · edgePunctRestored
19,577 · truthSpaceLoss 3,208 · edgePunctRunsRestored 854 · typographyInverted
1,914 · edgeExtensionsClamped 958 · smallCapsInverted 317 · truthGlyphLies 46`.
Drops: `quarantinedBook 38,937 · simFloor 1,956 · hyphenNoEvidence 932 ·
tooShort 325 · truthGlyphDamage 325 · ligatureDefect 253 · maxCer 93`.

**`degrade.py`** — renders at 200 dpi grayscale via fitz, applies one of 11
damage variants, re-wraps each damaged raster into a PDF **at the original page
size** (so the typesetter's word boxes stay valid). Unit-agnostic — **needs no
change for sentences.** (README.md:656-658: `photocopy-combo` discarded at
18.3% CER; `blur0.6` indistinguishable from clean.)

**`eval-line.py`** — scores a served GGUF over `eval.jsonl`. Its docstring is
the measurement doctrine (lines 12-26):

> `READ degraded FIRST. EVERY TIME.` … `a book is 80–95% already-correct lines,
> so a corrector can cut pooled CER handsomely while mangling several hundred
> proper nouns` … `The headline is therefore a PAIR and neither half means
> anything alone: CER before -> CER after / degraded / false-edit rate`

**`contract-crosscheck.mjs`** — runs every **gold** edit through the
*production* applier (`electron/ai-cleanup-prepass.ts applyEditList`). Measured
Jul 31: production applier landed 18.6%, blocked 81.4%; root cause 11,502 of
15,854 gold anchors (72.5%) sit MID-WORD against a matcher requiring word
boundaries. **A block-corpus tool** — the edit-list contract, not the free-text
one.

### 2b. New (landed at `bdbbad4` / `0bbc921`)

- **`sentences.py`** — see §4.
- **`eval-guard.py`** — **generate-once/score-many**. `generate` writes every
  raw answer to a dump plus the server's own `/props`; `score` never talks to a
  server. Greedy (temperature 0, top_k 1) so the dump is reproducible.
  Rationale (lines 42-50): *"Re-running it to try a different guard costs GPU
  time AND lets sampling noise wear the costume of a policy difference."* Three
  policies: no-guard / whole-unit / per-run.
- **`align-degraded.py`** — pairs a scan of a *damaged raster* against the
  source PDF's own text. Aligns as **character streams** (not geometry), sound
  because the two sides are 97–99% identical. Emits `--out-lines` and
  `--out-sentences` (with `--cap 400`) from one run. Carries the JBIG2 warning
  explicitly (lines 27-40).
- **`review-edits.py`** — the human-readable list for a book with no gold. *"ON
  A CLEAN BOOK, EVERY EDIT IS A FALSE EDIT UNTIL PROVEN OTHERWISE."*
- **`guard-crosscheck.mjs`** — proves the scorer's Python guard and foundry's
  shipped `src/ocr/guard.ts` agree, byte for byte including rebuilt whitespace.
  **28,752 verdicts, 0 mismatches.** Run with `bun`, importing foundry's
  TypeScript directly so no build staleness can hide a difference.
- **`results-guard-experiment/`** — 8 dumps + 6 score/stats pairs +
  `adapter-activation-proof.txt` + `kershaw-epub.review.txt`.

### 2c. Where the LINE unit is baked in

| site | what must change for sentences |
|---|---|
| `build-dataset.py:950-959` (emitter) | `user`/`assistant` are one line's `ocr`/`truth`. Must become a packed unit's joined `src`/`gold`. |
| `build-dataset.py:676` | reading order already correct; packing must happen here, **before** filtering. |
| `build-dataset.py:746` | `identity = ocr == truth` — per-line. Unit identity must be `all(...)`, as `sentences.py:254` already does. |
| `build-dataset.py:806-808` (downsample) | Operates on line rows and **destroys line contiguity** — the blocker, see §5b. |
| filter thresholds `--min-len 8`, `--sim-floor 0.75`, `--max-cer 0.30`, `--min-len-for-cer 40` | All calibrated on ~60-char lines. At ~300 chars they measure a different object. |
| `SYSTEM` (`build-dataset.py:207-218`) | Says *"a single line of text"*. See §5 open decision 5. |
| `README.md:176` `\|`-strip | *"the same strip must run at serving time"* — an obligation on any new serving path. |
| `align-pairs.py`, `align-epub.py`, `bands.py` | **No change.** Lines are the atoms the pipeline actually has; sentences are assembled *from* them. |
| `degrade.py`, `degrade-batch.mjs` | **No change** — raster-level, unit-agnostic. |

---

## 3. U+00AD verification — CONFIRMED, three instruments

The pdf.js half is exhaustively measured in `docs/PDF_SOFT_HYPHEN_SURVEY.md`.
The open half was fitz. Run 2026-08-05 on the Mac.

**PDF**: `/Volumes/Callisto/books/misc/Working Towards The Fuhrer. Kershaw,
Ian. (1993).pdf` (17 pages). **PyMuPDF 1.26.6 / MuPDF 1.26.11**, system
`python3`.

```
get_text('text'   ) ->    31 U+00AD   on 15 pages
get_text('words'  ) ->    31 U+00AD   on 15 pages
get_text('rawdict') ->    31 U+00AD   on 15 pages
get_text('blocks' ) ->    31 U+00AD   on 15 pages
get_text('dict'   ) ->    31 U+00AD   on 15 pages
get_text('html'   ) ->     0 U+00AD   on 0 pages
get_text('xhtml'  ) ->     0 U+00AD   on 0 pages
get_text('xml'    ) ->     0 U+00AD   on 0 pages
```

Page index 1 (1-based page 2), exactly the two marks the docs predict:
`'‘modernis\xad'` bbox=(362.1, 341.9, 406.5, 352.1) and `'‘totali\xad'`
bbox=(379.5, 368.4, 406.8, 378.7). All Cf characters found by fitz across the
whole book: `{0xad: 31}` — nothing else.

**Three-way agreement on the same file:**

| instrument | count |
|---|---|
| **fitz `get_text('words')`** (this run) | **31** |
| **mutool 1.27** — `mutool draw -F txt`, `/opt/homebrew/bin/mutool` | **31** (and 31 immediately before a newline) |
| patched pdf.js `keep` mode (`PDF_SOFT_HYPHEN_SURVEY.md:191`) | **31** |
| stock pdf.js (what foundry sees today) | **0** |

### Verdicts

1. **`get_text('words')` PRESERVES U+00AD.** Hand-off fact 2 is **CONFIRMED**.
   The mark stays attached to the *left* fragment as part of that word token,
   with the continuation as a separate word on the next line — exactly the
   shape `align-pairs.py`'s healer expects.
2. **So do `'text'`, `'blocks'`, `'dict'` and `'rawdict'`.**
3. **`'html'`, `'xhtml'` and `'xml'` DROP it** (0 of 31). Anyone reaching for
   an HTML-ish mode for truth would silently reproduce the pdf.js bug.
4. **Second, independent confirmation from the code's own history.**
   `align-pairs.py:43-66` exists *only because* fitz preserves the mark, and
   its docstring carries the measurement (lines 58-59): *"Measured on the mined
   corpus before this existed: 747 of 12,594 pairs (5.9%) across 28 of 56 books
   carried it."*
5. **The mechanism, traced end to end.** `align-pairs.py:142` joins a line's
   truth words with `' '`; line 158 `line_separator` returns `'\n'` only for an
   *ASCII* wrap hyphen, so a soft hyphen falls through to `' '`; line 194 then
   runs `heal_soft_hyphens` = `re.sub('\xad[ \t]*', '', s)`, and
   `modernis\xad ing` → `modernising`. Correct.

### Caveats

- **UNVERIFIED at scale outside Kershaw.** The Bergen PDF (233 pp) gives 23 in
  every text mode, 0 in html/xhtml/xml — consistent — but the Mac has no copy
  of the archive PDFs the survey measured.
- **PyMuPDF here is 1.26.6/MuPDF 1.26.11.** A future version could change; keep
  `heal_soft_hyphens`' count printed as its own regression detector.

---

## 4. The sentence splitter — it exists, twice, and one is reusable today

### 4a. Branches: neither exists on this Mac

- bookforge `experiment/ocr-sentence-eval` — does not exist locally. **Its
  content is already merged** to `main` at `bdbbad4`+`0bbc921`. Nothing to
  recover.
- foundry `experiment/ocr-guard-and-sentences` — does not exist locally.

### 4b. ⚠️ The local foundry checkout is STALE by two releases

`/Volumes/Callisto/Projects/foundry` is at **`293886b`, v0.3.1** (Aug 3).
`git fetch --dry-run` reports `293886b..e4915d8  main -> origin/main` plus new
tags `v0.4.0` and `v0.5.0`. BookForge pins **`FOUNDRY_CLI_VERSION = '0.5.0'`**
(`electron/components/foundry-cli-components.ts:47`).

Verified against the stale tree: `src/ocr/` contains only `edits.ts`,
`guard.ts`, `prompt.ts` — no `ocr-correct --epub` and no serving-time splitter;
`src/paragraphs/hyphen.ts:34-35` is the pre-fix ASCII-only version, and
`grep -n "SOFT_HYPHEN"` returns nothing. **This checkout is very likely the
"stale branch" the soft-hyphen survey grepped.**

**Anyone continuing this work must `git -C /Volumes/Callisto/Projects/foundry
pull` (then `npx tsc`, per the hand-off's stale-`dist/` warning) before reading
foundry as authority on anything.** `guard-crosscheck.mjs` takes `--foundry
<path>` and against this tree would be crosschecking a two-release-old guard.

### 4c. `tools/foundry-ocr/sentences.py` — the reusable splitter

518 lines, plain Python 3, **stdlib only**. Fully importable — top-level pure
functions, `main()` behind `if __name__ == '__main__'`.

Two splitters:

**(i) The line-corpus path** (`build`, `pack`, `join`) — a unit is a set of
**whole lines**. `sentences.py:25-43`: *"A SENTENCE BOUNDARY FALLS MID-LINE,
and cutting there would need a character alignment between the OCR and the
truth — the exact fragile machinery this is supposed to be measuring an escape
from. So a unit is a run of CONSECUTIVE lines… The OCR unit and the truth unit
are built from the SAME line set, so they correspond exactly."*

**(ii) The running-prose path** (`split_sentences`, `pack_sentences`,
`epub_blocks`, `build_from_blocks`) — `sentences.py:259-264`: same cut rules,
the atom is a sentence, a unit never spans a paragraph.

Key rules, verbatim:

```python
WRAP_HYPHEN = re.compile(r'[-‐‑­]$')          # ASCII, U+2010, U+2011, and U+00AD
SENTENCE_END = re.compile(r'[.!?…][\'"’”»)\]]*$')
ABBREVIATIONS = { 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'rev', 'hon', 'sr',
    'jr', 'vs', 'etc', 'ca', 'cf', 'ed', 'eds', 'vol', 'no', 'pp', 'op',
    'cit', 'ibid', 'al', 'inc', 'ltd', 'co', 'jan', 'feb', 'mar', 'apr',
    'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec' }
```

- Abbreviations handled, plus a lone-initial rule (`J. P. Taylor` safe; `S.
  123` safe by the initial rule). **Not covered: German `Hrsg.`, `Bd.`** All
  failures are safe — a longer unit, "when in doubt, send more through."
- **Not covered: footnote reference digits after the terminator** (`war.12`,
  `war.¹²`) — the boundary is missed, the unit grows, and past the cap the
  word-boundary fallback manufactures fragments. Needs the digit-run rule
  (terminator not preceded by a digit → optional 1–3 digit run → whitespace)
  plus Unicode superscripts, mirrored into foundry's serving splitter.
- Packing: greedy to `--cap` (default 400), cutting at the last sentence end
  that fits; fallback line/word boundary; never a fixed offset; a unit may
  exceed the cap rather than cut mid-word.
- Two hyphen rules (`sentences.py:54-62`): a trailing hyphen is a JOIN, never a
  completion; a unit never ends on a wrap hyphen.
- Unit identity (`sentences.py:252-254`): a unit is already-correct only when
  EVERY line in it was.
- A gap in `line` numbering is a wall (`sentences.py:79-81`) — see §5b.
- Self-test: 18 assertions, including a byte-for-byte crosscheck of
  `OCR_SYSTEM_PROMPT` against `build-dataset.py`'s `SYSTEM`.

**Reusability verdict**: import `build()` / `pack()` / `join()` /
`split_sentences()` / `pack_sentences()` directly into the extended builder.
No rewrite needed.

### 4d. Is `sentences.py` the same object as foundry's serving splitter?

**UNVERIFIED** — the foundry checkout predates that code (§4b). This is exactly
the drift `guard-crosscheck.mjs` was written to prevent for the guard, and the
splitter deserves the same treatment. See open decision 6.

---

## 5. The corpus reorganization plan

### 5a. What the measurements already decide

- **No-guard never ships** — worst policy in 5 of 6 cells; doubles CER on real
  Kershaw sentences (README.md:580-582).
- **`whole-unit` on 400-char units is an off switch** — 6 corrections in 102
  units at 7% CER, rep/100k 34.3 vs per-run's 912.5 (README.md:591-597).
- **The guard cannot express a merge**, structurally (README.md:615-622). With
  landmine 2 settled, foundry's deterministic hyphen rule owns that class and
  the model should never be trained to attempt it.
- **The residual damage that PASSES the guard is typography**
  (README.md:609-613). The retrain's actual target.
- **The current model is worse on sentences**: false-edit 12–25% vs 0.6–7% for
  lines; fewer repairs per 100k in every paired cell. The case *for* the
  retrain, not against the architecture.

### 5b. ⚠️ THE BLOCKER, measured: `train.jsonl` cannot be re-unitised

`sentences.py` treats a gap in `line` numbering as a wall. Measured
consecutive-run lengths:

| file | rows | consecutive runs | **mean run length** |
|---|---|---|---|
| `train.jsonl` | 47,270 | 36,998 | **1.28 lines** |
| `pairs-repaired.jsonl` | 72,552 | 37,970 | **1.91 lines** |
| `eval.jsonl` | 21,696 | 825 | **26.30 lines** |
| raw `himmler-a-life/scores/epub-align-pairs.json` | 38,015 | 1,130 | **33.6 lines** |
| raw `gods-people/…` | 8,734 | 50 | **174.7 lines** |
| raw `deathstalker-war/…` | 21,483 | 553 | **38.8 lines** |

**Why**: the holdout books are kept whole (hence eval's 26.3), but train is
identity-**downsampled** at `build-dataset.py:806-808` — which shreds
contiguity. Packing `train.jsonl` would yield ~1.3-line "sentences" of ~75
characters. This is why the Aug 5 experiment built its 284 sentence units from
the EVAL file.

**Fix**: **the identity downsample must move to AFTER packing.** New order:

```
raw epub-align-pairs.json  (contiguous, 310,796 pairs, 16 books, all on disk)
  → per-line repair ladder            (build-dataset.py, unchanged)
  → PACK INTO SENTENCE UNITS          (sentences.py:pack/join, on the FULL kept set)
  → per-UNIT filters                  (re-derived thresholds — see 5e)
  → identity downsample AT UNIT LEVEL (--identity-share)
  → per-book caps, German slice, holdout split
  → emit
```

**No re-mining is required.** All 16 books' raw aligner output is on disk under
`/Volumes/Callisto/training/ocr-lab/<book>/scores/epub-align-pairs.json` and is
contiguous. **A builder change, not a mining campaign.**

### 5c. Proposed directory layout

Keep `sft-line/` byte-for-byte intact — the provenance of the shipped
`foundry-ocr-v1-4b` and the only thing that lets a sentence model be compared
against a line model on the same books.

```
/Volumes/Callisto/training/rubric/galley/
├── sft-line/               UNTOUCHED
├── sft/                    UNTOUCHED (block corpus, never trained)
├── sft-sent/               NEW — the sentence corpus
│   ├── train.jsonl               sentence units, book-held-out
│   ├── eval.jsonl                deathstalker-coda + michelle-remembers, NOT downsampled
│   ├── eval-german.jsonl         himmler pp. 924–1011, packed the same way
│   ├── eval-parity-1k.jsonl      1k paired slice, like-for-like vs sft-line
│   ├── units.jsonl               packed units BEFORE the downsample — the
│   │                             re-derivation base
│   └── build-stats.json          repair-ladder + drop counts + unit-length histogram
├── pairs/  degraded/  paragraph-probe/    unchanged
└── NOTES.md                NEW — pointer into the repo docs (the corpus tree
                            currently has no notes file at all)
```

`sft-sent/eval.jsonl` should be packed from the **same** `eval.jsonl` line rows
(not re-derived), so the sentence eval covers **exactly the same characters**
as the line eval — what made the Aug 5 paired cells comparable, preserved by
construction.

### 5d. Identity ratio

Precedent is 50% at row level (§1d). But a unit-level 50% is a **different and
harsher object**: a unit is identity only if every line in it is, and measured
on the eval slice 88.6% line-level identity became **63.7%** at sentence level
(181/284). A 50% *unit* corpus contains far more damaged characters per token
than a 50% *line* corpus did — a shift toward editing more, the opposite of
what the false-edit numbers ask for.

**Recommendation**: build at `--identity-share 0.5` for continuity, print the
derived line-level identity share in `build-stats.json` alongside it, and
**treat the share as a tunable to sweep** (0.5 / 0.65 / 0.8, three cheap 4B
runs, scored with `eval-guard.py` on the same held-out books). The measured
false-edit rate picks the number.

### 5e. Filter thresholds must be re-derived, not carried over

| filter | line value | why it does not transfer |
|---|---|---|
| `--min-len 8` | 8 chars | Inert at ~300 chars. |
| `--sim-floor 0.75` | 0.75 | Justified as the 1st percentile of `sim` on lines. On a 400-char unit, sim 0.75 is 100 differing characters — a far coarser gate. Re-derive the percentile. |
| `--max-cer 0.30` | 0.30 | Was a secondary gate above `--min-len-for-cer 40`; on sentences it becomes the primary gate for the first time. |
| ligature/small-caps/edge-punct/edge-extension rungs | per-line | **Apply BEFORE packing**, on lines, unchanged — properties of the aligner's line windows. |

Print the histogram, then set the threshold from it; keep every rung's count
printed so a fixed aligner reads zero.

### 5f. Book-level holdout — preserved for free, with one thing to add

- `sentences.py` never packs across books, so holdout is exact by construction.
- Keep `HOLDOUT_BOOKS` unchanged — changing them makes the sentence model
  incomparable to the line model.
- Keep the leak assertion, the tier-3-not-in-eval refusal, and `CAPPED_BOOKS =
  {'rise-and-fall': 0.10}` — the anti-Unicode-normaliser cap matters *more* now
  that typography is the measured residual damage.
- **Add**: assert no unit spans a book, and record `lineRange` on every unit
  (already emitted) so a leak is auditable rather than merely asserted.
- **The German slice must be carved BEFORE packing** (it selects himmler pages
  by non-ASCII density; carving after packing lets units straddle the boundary).

### 5g. Split-word (join) cases — SETTLED: do not mine them

Per landmine 2 as updated and `docs/PDF_SOFT_HYPHEN_SURVEY.md`:

1. **Pairs mined from our own dropped hyphens are OUT** — they target a
   distribution the pdf.js patch is about to delete. (And per §0, the trained
   corpus's path never saw a PDF text layer anyway.)
2. **The guard structurally cannot ship a merge** — even a perfectly-trained
   merge is discarded at serving time.
3. **The durable case** — books where the typesetter left no wrap character at
   all — is owned by the survey's deterministic R2 rule (74 fires in 685,233
   joins, 98.9% precision). What R2 cannot reach (~47% between its 34.4% recall
   and the 81.6% attestation ceiling) is a future, separate corpus question
   with its own measurement.
4. **If the distinction is ever needed**: read the book twice — fitz (preserves
   U+00AD) vs stock pdf.js (drops it). Disagreement = our damage; agreement on
   a bare join = the typesetter's. No heuristic required. Record per-book in
   the stats file.

**Net effect: the split-word work drops out entirely. The sentence corpus is a
straight re-unitisation of clean line pairs.**

### 5h. What each tool does in the new flow

| tool | role |
|---|---|
| `tools/ocr-lab/{run-book,bands,align-epub}.py` | unchanged — raw pairs already exist for all 16 books |
| `align-pairs.py`, `mine-book.mjs`, `build-corpus.mjs`, `contract-crosscheck.mjs`, `edits.mjs` | not in this flow — block-corpus path |
| `build-dataset.py` | **extend**: `--unit line\|sentence`, packing before the downsample, unit-level filters. Same file, one flag, so the two corpora provably share a repair ladder. |
| `sentences.py` | **import** `pack` / `join` / `join_all` / `ends_sentence`. Do not fork it. |
| `degrade.py`, `degrade-batch.mjs`, `degrade-render.py` | unchanged — raster-level |
| `align-degraded.py` | unchanged — already emits `--out-sentences` with `--cap` |
| `eval-guard.py` | **the scorer**: generate once, score under all three policies. Replaces `eval-line.py` as the headline harness. |
| `eval-line.py` | keep for the line-vs-sentence baseline on `sft-line/eval.jsonl` |
| `review-edits.py` | the human read on a real book with no gold |
| `guard-crosscheck.mjs` | **re-run against an up-to-date foundry** (§4b) |
| `train-line.sh`, `line-training-profiles.json` | **extend** — an `ocr_sent_v1_4b` profile. `max_seq_length 512` was measured against a 246-token max on LINES; ~300-char units will blow past it. `text_sft` refuses to truncate — hard failure. Re-measure with `--preflight` and the real tokenizer before any run. |
| NEW `NOTES.md` in the corpus dir | the corpus is unsynced and currently carries no note; a pointer file into the repo docs costs nothing |

### 5i. Sequence

1. Pull foundry (`git -C /Volumes/Callisto/Projects/foundry pull`, then `npx
   tsc`). Everything foundry-side is unreadable until this happens.
2. Re-run `guard-crosscheck.mjs` against the fresh checkout — confirm 28,752/0
   still holds.
3. Diff `sentences.py`'s splitter against foundry's `ocr-correct --epub`
   splitter. A difference is the first bug — a serving/training unit mismatch,
   the precise thing this rebuild exists to eliminate.
4. Extend `build-dataset.py` with `--unit sentence`. `--dry-run` first; read
   the unit-length and identity histograms.
5. Build `sft-sent/`. Verify: no unit spans a book; holdout leak assertion
   passes; `sft-sent/eval.jsonl` covers the same characters as
   `sft-line/eval.jsonl`.
6. `train-line.sh --preflight` — measure token lengths. Expect ~4× the line
   corpus.
7. Train on owens-pc (GPU lock per landmine 5). Prove the adapter is active
   first (landmine 4) — `adapter-activation-proof.txt` is the template.
8. Score with `eval-guard.py` under all three policies, against the line model
   on the same books, `degraded` read first.

---

## Open decisions — Owen's call

1. **Path A or Path B.** Path A (line-shaped units on the EPUB via
   `data-bf-blocks`) works today with no retrain, and lines beat sentences on
   the current weights in every paired cell — but it only covers books our own
   reflow stamped. Path B (this corpus) is the only unit that exists on every
   EPUB. B's premise — that sentence training fixes sentence performance — is a
   reasonable expectation, not yet a measured fact.
2. **Identity share at unit level** (§5d). Sweep 0.5/0.65/0.8; the measured
   false-edit rate picks it.
3. **Should the corpus actively teach typography restraint** — identity rows
   whose input contains curly quotes and em dashes so the target preserves
   them? The one change with a measured motive (README.md:609-613).
4. **The d≤2 guard threshold** — `Miinchner`→`Münchner` accepted at d=2,
   `Biirgerbraukeller`→`Bürgerbräukeller` refused at d=3; same class, opposite
   verdicts. A guard change and a retrain interact: **decide the guard before
   the corpus is built.**
5. **Prompt wording.** `SYSTEM` says "a single line of text" and the trailing-
   hyphen rule is nearly inapplicable on sentences. Changing it means
   `sentences.py`, `build-dataset.py`, foundry `src/ocr/prompt.ts` and both
   crosschecks move together, in one commit.
6. **One splitter or two.** Either crosscheck the splitter like the guard, or
   make foundry's the only implementation and have the corpus builder shell out
   to it. The second is the "CLI drives the app path" doctrine.
7. **German abbreviations** (`Hrsg.`, `Bd.`) absent from `ABBREVIATIONS`; the
   **footnote-digit boundary rule** (see §4c) likewise. Both change unit
   boundaries, so both must land before the corpus is built and be mirrored at
   serving time.
8. **Quarantine review** — 38,937 rows (~19% of everything) from the two
   What-to-Expect books, still out pending a boxed-text damage report.
9. **`rise-and-fall` has no `truthTier`** — the tier-3-eval refusal cannot
   protect a book it cannot identify; 4,727 train rows; the one book documented
   as a Calibre render. Rename the lab dir or add the key.
10. **Model size.** v1 shipped at 4B on the lexical-substitution argument.
    Longer units are the 0.6B case's best argument. Worth a size control — but
    only after decision 1.

---

## Verified / unverified ledger

**Verified by direct measurement**: all row counts, identity ratios, length
distributions and book breakdowns in §1; the contiguity blocker in §5b and the
raw-pairs contiguity that resolves it; U+00AD preservation across five fitz
extraction modes and its loss in three, cross-checked against mutool on the
same file; the stale foundry checkout, its version, its missing `SOFT_HYPHEN`,
and the absence of both experiment branches locally; the absence of any notes
file inside the corpus tree; the README row-count staleness.

**Verified by reading code/docs**: every tool's inputs/outputs and gating;
every quoted passage (paths and line numbers inline).

**UNVERIFIED, flagged**: whether `sentences.py` matches foundry `main`'s
serving splitter (checkout two releases stale); whether fitz's U+00AD behaviour
holds on the specific archive PDFs the survey measured (not present on this
Mac); whether foundry `main` actually contains `SOFT_HYPHEN*` and `ocr-correct
--epub` (asserted by the hand-off, unreadable from here); the interaction
between a moved guard threshold and a sentence-trained model (nobody has
measured it).
