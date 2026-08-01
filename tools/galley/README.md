# galley — the OCR corrector

Two models share this directory because they share a name and a job. They do
**not** share a corpus, a unit, an output contract or a training run, and
crossing them is the mistake this file exists to prevent.

| | **block model** (built Jul 31) | **line model** (this harness, Aug 1) |
|---|---|---|
| unit | one OCR *block* | one band = one Tesseract `--psm 7` line |
| input | block text | line text |
| output | an **edit list** (`before → after`), or `none` | the **corrected line** |
| safety | `edits.mjs` applier rejects any anchor it cannot quote | **none yet** — see "The open contract question" |
| source | born-digital PDF text layers + a degradation ladder | the band pipeline's own output vs EPUB truth |
| corpus | `training/galley/sft/` | `training/galley/sft-line/` |
| builder | `build-corpus.mjs` | `build-dataset.py` |
| profiles | `training-profiles.json` | `line-training-profiles.json` |
| scorer | `tools/galley-score.js` | `eval-line.py` |
| status | corpus done, never trained | corpus + harness done, never trained |

The line model is the one `docs/OCR_LAB.md`'s pipeline has a slot for —
`bands → per-line tesseract → [galley] → block grouping → rubric`. At that point
in the pipeline blocks do not exist yet. The block model was designed against
the older whole-page path.

Nothing here has been trained. **A training run needs the owner's explicit green
light every time**: the 3090 Ti is shared and the box has a faulty fan.

---

## What was built

```
tools/galley/
  build-dataset.py            NEW  pairs -> train/eval JSONL + stats
  line-training-profiles.json NEW  galley_line_v1_06b (+ _safe, + 4b control)
  train-line.sh               NEW  stage + launch; does NOTHING without --go
  eval-line.py                NEW  score a checkpoint; reports `degraded` first
  README.md                   NEW  this file
```

### 1. `build-dataset.py`

Reads every `<lab>/<book>/scores/epub-align-pairs.json` under
`~/Documents/BookForge/ocr-lab/` and emits chat JSONL in the exact shape the
rig's `text_sft` trainer consumed for `dagger_v1`, plus `pairs-repaired.jsonl`
(the repaired pairs, so a different target format can be built later without
re-deriving anything) and `build-stats.json`.

**The holdout split is enforced, not documented.** `deathstalker-coda` and
`himmler-a-life` are a declared list at the top of the file; after the split the
builder asserts no holdout row reached train and **exits non-zero** if one did.
It also refuses to write a tier-3 (teacher-only) book into eval unless
`--allow-tier3-eval` is passed, per `OCR_LAB.md`'s "eval only against tier-1
truth or hand-checked pages".

`what-to-expect-when-youre-expecting` and `what-to-expect-the-second-year` are
quarantined: excluded entirely unless `--include-quarantined`.

### 2. `line-training-profiles.json`

`galley_line_v1_06b` — Qwen3-0.6B, 16-bit LoRA, derived from `dagger_v1`.
Plus `galley_line_v1_06b_safe` (batch 1 × accum 16 fallback) and
`galley_line_v1_4b` (size control).

### 3. `train-line.sh`

Default output is the **plan**. `--preflight` does read-only box checks and
measures token lengths with the real tokenizer. `--go` merges profiles (after
backing up the rig's copy), stages via ssh stdin with sha256 verification on
both sides, and launches. It never merges the LoRA — that happens on the Mac.

### 4. `eval-line.py`

Runs a served GGUF over `eval.jsonl` through llama-server `/completion` with the
Qwen3 template built by hand (empty `<think>\n\n</think>` — the rubric trap).
Reports per-book CER before/after, improved / unchanged / **degraded**, and the
false-edit rate on already-correct lines. `--guard` measures what a
distance-budget guard would buy.

---

## Dataset stats

Measured on **michelle-remembers** first, as instructed, then re-measured as
sibling agents minted more books. Both are reported because the second set
changed real decisions.

### michelle-remembers alone (9,053 pairs)

| | |
|---|---|
| byte-exact identity | **3,892 (43.0%)** |
| non-identity | 5,161 (57.0%) |
| CER mean | 4.4% |
| line length | p50 65, p99 75 chars |
| of the non-identity rows: trailing-punct-only | **2,470 (48%)** |
| lines ending in a wrap hyphen | 350 (3.9%) |
| `\|` interior (a misread capital `I`) | 142 |
| `\|` trailing (band-edge clip) | 43 |

CER histogram (raw): 43.0% exact · 16.1% (1,2%] · 17.9% (2,5%] · 12.0% (5,10%] ·
7.3% (10,20%] · 1.8% (20,30%] · 1.3% (30,50%] · 0.6% >50%. Nothing lands in
(0,1%] because a 65-character line cannot be 1% wrong — one character is 1.5%.

### The whole lab as it stood at build time (10 books, 202,877 pairs)

| book | tier | kept | identity | edit | ident % |
|---|---|---|---|---|---|
| rise-and-fall | ? | 48,060 | 45,031 | 3,029 | 93.7 |
| **himmler-a-life** (EVAL) | 1 | 35,564 | 28,574 | 6,990 | 80.3 |
| deathstalker | 2 | 20,793 | 19,431 | 1,362 | 93.4 |
| deathstalker-rebellion | 2 | 19,992 | 17,021 | 2,971 | 85.1 |
| understanding-jehovahs-witnesses | 1 | 11,364 | 11,013 | 351 | 96.9 |
| michelle-remembers | 1 | 8,916 | 7,985 | 931 | 89.6 |
| gods-people | 1 | 8,711 | 7,356 | 1,355 | 84.4 |
| was-hitler-an-atheist | 1 | 5,402 | 4,786 | 616 | 88.6 |
| what-to-expect ×2 | 1 | quarantined (38,865 rows) | | | |

Repairs applied: 25,566 rows edge-punctuation restored · 12,038 wrap-hyphen
joins undone · 6,045 whole edge words restored · 2,387 welded words separated ·
2,128 edge words clamped · 1,577 typography · 1,432 punctuation runs · 289 small
caps · 45 `1`→`I`. Dropped: 2,361 hyphen rows with no evidence · 1,953 below the
sim floor · 574 CMap damage · 221 too short · 101 over the CER cap.

Split: **train 21,230 / eval 35,564** (eval = himmler-a-life entire;
`deathstalker-coda` had not been minted at build time and the builder says so
loudly). Train is downsampled to 50% identity; **eval is left at its natural
80.3%**, because that rate *is* the baseline the model has to beat.

The eval set is large — pass `--limit` to `eval-line.py`, which subsamples while
preserving the identity/edit mix.

---

## The filters, and why each one

**Nothing byte-exact is ever dropped.** Identity rows are 43–97% of a book and
they are the cheapest supervision in the corpus: they are what teaches the model
to leave correct text alone, which is the failure mode that decides whether this
ships. Filters apply to edit rows only.

| filter | default | why this value |
|---|---|---|
| `--sim-floor` | 0.75 | 1.07% of michelle's rows sit below it and their median CER is **75%** — three quarters of the characters differ, which is a different sentence, not a fixable error. A real Tesseract line error is 1–3 characters on a 65-char line (1.5–5%). The floor sits at the 1st percentile of `sim`, so it cuts the misalignment tail and nothing else. Applied **after** the repairs, because a small-caps row scores `sim` 0.0 and is a perfect identity example once inverted. |
| `--max-cer` | 0.30 | Secondary gate mirroring `build-corpus.mjs`'s CER cap, and like it, only applied above `--min-len-for-cer` (40 chars): two bad characters in a 14-character line is 14% CER and is exactly the error worth learning. |
| `--min-len` | 8 | Edit rows only. A 3-character line with a 1-character difference is 33% CER and is almost always misalignment. Short *identity* rows survive. |
| hyphen | `repair` | See the builder's header. `drop` is available. |
| edge extensions | `clamp` | 32% of edit rows. See below. |
| quarantine | on | `--include-quarantined` opts back in. |

### The `|` decision: pre-strip trailing, keep interior

`|` appears in 184 of michelle's 9,053 lines. **142 are interior and every one
is Tesseract reading a capital `I` as a pipe** (`| know` → `I know`) — the
classic `l/1/I` confusion that §12d of `RUBRIC_TRAINING.md` records as *missing*
from the block corpus, and the single most valuable error class in this data.
**43 are trailing** and are the band cropper clipping the right edge (`PART |`,
`ascend|`, `He quickly S|`); stripping them makes 15 of the 43 byte-exact and
halves their mean CER.

Same character, opposite lessons, distinguished only by position. 43 examples
cannot teach a positional exception against 142 counter-examples, so the
positional case is removed deterministically.

> **This makes the strip a pipeline step, not a model behaviour. The same strip
> must run at serving time, before galley sees the line.** It is a property of
> the band cropper; if galley is served un-stripped lines it will meet a
> character it was never trained to handle in that position.

### Edge extensions are clamped — a band-cropper measurement

1,886 of 5,852 edit rows (**32%**) had a truth whose first or last word strictly
extends the OCR's: `neede` → `needed`, `unwit` → `unwittingly`, `murs` →
`Murmurs`. The band cropper clipped a character or two off the line end and the
EPUB truth still has them.

Some completions are near-certain (`candlesti`). It does not matter. A model
taught to complete a clipped edge word cannot tell a clipped line from a line
that simply ends there, so it fires on correct text too — and `degraded` is the
number that decides whether this model ships. The builder restores the OCR's own
edge token and **prints the count as a measurement of the clipping**. Fix the
cropper and those rows become ordinary supervision again.

---

## dagger's actual recipe, as found

From `training_profiles.json` on owens-pc (`/mnt/c/Users/tellt/Projects/orpheus-finetune/`,
not version controlled) and `~/Documents/BookForge/training/dagger/sft/`.

```
profile      dagger_v1  (+ dagger_v1_safe fallback)
kind         text_sft
base         Qwen/Qwen3-0.6B          load_in_4bit: false
             ("near-verbatim string copying, where quantization costs
               character fidelity, and 1.2GB bf16 needs no quantizing")
max_seq_len  512   MEASURED max 442 tokens over train+eval, p50 141
LoRA         r 32, alpha 32, dropout 0.0
             q,k,v,o,gate,up,down_proj      (plain bf16 LoRA, NOT QLoRA)
lr           1e-4   optimizer adamw_8bit   scheduler cosine
batch        4 x accum 4  = effective 16   (safe fallback: 1 x 16)
epochs       4      early_stopping_patience 2   save_total_limit 4
warmup       0.05   weight_decay 0.01   seed 3407
dataset      chat_jsonl, messages_field "messages",
             assistant_only_loss TRUE,
             template_kwargs { "enable_thinking": false }     <-- critical
merge        NOT on the box. rubric-merge-mac.sh on the Mac.
             (best checkpoint = the one named by the HIGHEST-numbered
              checkpoint's trainer_state.json; dagger_v1 peaked at epoch 3
              and glob order would have shipped epoch 1)
publish      convert -> quantize -> load-check on the SAME pinned llama.cpp
             build the app bundles -> HF upload -> paste the catalog entry
             by hand (rubric-publish.sh; dagger shipped f16, unquantized)
```

Row format is bare — no metadata, just the three messages:

```json
{"messages":[{"role":"system","content":"Find inline footnote reference markers…"},
             {"role":"user","content":"…Langhoff wrote.*"},
             {"role":"assistant","content":"wrote.* → wrote."}]}
```

`build-dataset.py` matches that shape and appends `book`/`page`/`line`/`cer`/
`identity`/`truthTier` alongside `messages`; `build-corpus.mjs` already does the
same and the trainer ignores anything outside `messages_field`.

**Yes, dagger set `enable_thinking: false`** — matched here.

## Proposed galley-v1 line config

`galley_line_v1_06b` is `dagger_v1` with three deliberate changes:

| | dagger_v1 | galley_line_v1_06b | why |
|---|---|---|---|
| `max_epochs` | 4 | **3** | dagger took 4 on 2,598 rows with one book carrying 98% of the positives. This is ~21k rows over 7 books, and §5 of `RUBRIC_TRAINING.md` records that three runs out of three peaked at epoch 1. With `early_stopping_patience 2` and best-checkpoint selection, 3 is a ceiling. |
| `save_total_limit` | 4 | 4 | unchanged |
| `max_seq_length` | 512 (measured 442) | **512, PROVISIONAL** | Lines are far shorter than blocks — user+assistant is p50 122, p99 179, max 198 *characters*. But `text_sft` refuses to truncate, so this **must be re-measured with the real tokenizer before the run**; `train-line.sh --preflight` does exactly that. |

Everything else is dagger's, unchanged, including `load_in_4bit: false` and
`enable_thinking: false`.

**The size question is open and I would not assume 0.6B wins.** The block
model's own profile argues 4B because the job is *lexical* rather than
*positional*, and the held-out book makes that argument concrete: himmler's real
errors are `Reichsftihrer` → `Reichsführer`, `Fugoslawien` → `Jugoslawien`,
`Raterepublik` → `Räterepublik`. A thin language prior does not merely miss
German proper nouns, it "corrects" them toward something more English-looking,
and the result is narrated. 0.6B is primary only because the pipeline runs this
model **per line**, tens of thousands of times per book, where a 4B's inference
cost is a real number. `galley_line_v1_4b` is in the file for the comparison.

---

## GPU box status (checked read-only, Jul 31 2026)

| | |
|---|---|
| `ssh owens-pc` | reachable |
| WSL | reachable (`wsl -e bash -lc` works) |
| GPU | NVIDIA GeForce RTX 3090 Ti, **3,884 / 24,564 MiB used, 52 °C, 39% util** |
| running on it | **no training job** — every process is desktop (Chrome, Discord, vMix, VS Code, electron). The 3.9 GB and the 39% are the Windows desktop. The card is free. |
| conda envs | `orpheus_train` ✅ (the training env), plus `orpheus_ft`, `orpheus_env`, `orpheus_tts`, `ebook2audiobook` |
| disk, WSL `/` | 1007 GB, 371 used, **585 GB free** |
| disk, `C:` | 1.9 TB, 86% used, 264 GB free |
| staging | `~/rubric-v5/` still holds the v5 corpus (21 MB); `~/training_data/` holds the rubric/dagger logs; `~/xtts_ft/` holds `dagger_v1_lora`, `dagger_v1_best` and every blockcat run |
| rig profiles | 13 profiles incl. `dagger_v1`, `dagger_v1_safe`, `ocr_repair`, `rubric_v4/v5`. **No galley profile is installed** — the block model's `training-profiles.json` was never merged in either. |

Nothing was changed and nothing was started.

---

## Commands the owner approves to

**(a) rebuild the dataset once all books' pairs exist**

```bash
# look first — writes nothing
python3 tools/galley/build-dataset.py --dry-run

# build
python3 tools/galley/build-dataset.py \
    --out ~/Documents/BookForge/training/galley/sft-line
```

It refuses to run if a holdout book's rows would land in train, or if a tier-3
book would land in eval. Add `--include-quarantined` only after reviewing the
What-to-Expect boxed-text damage.

**(b) launch training** — needs the owner's explicit green light

```bash
# 1. read-only checks + MEASURE token lengths (no GPU work)
bash tools/galley/train-line.sh --preflight

# 2. only after the green light, with a temperature monitor running.
#    Run it as a BACKGROUND task so the ssh handle stays alive.
RUN=galley_line_v1_06b bash tools/galley/train-line.sh --go

# 3. merge on the Mac (never on the box)
tools/aligner/rubric-merge-mac.sh          # or the galley equivalent

# 4. serve and score. Read `degraded` FIRST.
<llama-build>/llama-server -m galley-line-v1-0.6b-f16.gguf --port 8771 -c 1024
python3 tools/galley/eval-line.py --limit 3000 --json ~/galley-line-eval.json
python3 tools/galley/eval-line.py --limit 3000 --guard 0.25   # what a guard buys

# 5. clear the WSL staging. It is a staging ground, never a master.
```

---

## Open questions only the owner can answer

1. **Line model or block model?** Both corpora now exist and neither has
   trained. `OCR_LAB.md`'s pipeline wants a line corrector; `RUBRIC_TRAINING.md`
   §12 built a block corrector with a safety contract. Training both is
   affordable; shipping both is not.

2. **The open contract question — a line corrector can invent a word, and
   nothing stops it.** dagger could only emit deletions and *still* needed a
   subsequence guard after testing caught it rewriting `mercilessly."` into
   `merrical."`. `edits.mjs` gives the block model an applier that rejects any
   anchor it cannot quote verbatim. **The line model as specified has no
   equivalent.** §11f already says "settle galley's applier contract before
   training it". Options: (a) accept free text and gate on a distance budget —
   `eval-line.py --guard` measures what that buys; (b) keep the line unit and
   move to an edit-list target, reusing `edits.mjs` (`pairs-repaired.jsonl` is
   written precisely so this needs no re-mining); (c) ship the block model
   instead. **This should be decided before the run, not after.**

3. **`rise-and-fall` has no `truthTier`** in `gold/manifest.json` under the name
   the ocr-lab directory uses (`rise-and-fall` vs `rise and fall of the third
   reich`). It is currently in **train**, contributing 48,060 rows — the largest
   single book — and the tier-3 eval refusal cannot protect a book it cannot
   identify. Either rename the directory or add the key. Note it is also the one
   book documented as a *Calibre render, not a scan*, and it is where the welded
   -word artifact came from.

4. **Quarantine review.** The two What-to-Expect books are 38,865 pairs — about
   19% of everything available — sitting out pending the boxed-text damage
   report.

5. **Should the aligner be fixed before training?** Every repair rung in
   `build-dataset.py` is a workaround for `align-epub.py` losing content at the
   truth window's edges, and the largest one touches 25,566 rows. The harness
   works either way and prints the counts, but a fixed aligner would give
   cleaner supervision and delete a lot of this code.

6. **Right-margin clipping in the band cropper** (32% of edit rows had a clipped
   final word). Worth a look independently of galley — it is a recognition loss,
   and `OCR_LAB.md`'s stated priority is that missing text is the fatal class.
