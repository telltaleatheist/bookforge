# ocr — the OCR corrector

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
| scorer | `tools/foundry-ocr/score.js` | `eval-line.py` |
| status | corpus done, never trained | corpus + harness done, never trained |

The line model is the one `docs/OCR_LAB.md`'s pipeline has a slot for —
`bands → per-line tesseract → [ocr] → block grouping → blocks`. At that point
in the pipeline blocks do not exist yet. The block model was designed against
the older whole-page path.

Nothing here has been trained. **A training run needs the owner's explicit green
light every time**: the 3090 Ti is shared and the box has a faulty fan.

---

## What was built

```
tools/foundry-ocr/
  build-dataset.py            NEW  pairs -> train/eval JSONL + stats
  line-training-profiles.json NEW  ocr_line_v1_06b (+ _safe, + 4b control)
  train-line.sh               NEW  stage + launch; does NOTHING without --go
  eval-line.py                NEW  score a checkpoint; reports `degraded` first
  README.md                   NEW  this file
```

### 1. `build-dataset.py`

Reads every `<lab>/<book>/scores/epub-align-pairs.json` under
`/Volumes/Callisto/training/ocr-lab/` and emits chat JSONL in the exact shape the
rig's `text_sft` trainer consumed for `dagger_v1`, plus `pairs-repaired.jsonl`
(the repaired pairs, so a different target format can be built later without
re-deriving anything) and `build-stats.json`.

**The holdout split is enforced, not documented.** `deathstalker-coda`
(fiction) and `michelle-remembers` (nonfiction) are a declared list at the top of
the file; after the split the builder asserts no holdout row reached train and
**exits non-zero** if one did.

They are chosen for what they *measure*. michelle-remembers is tier-1 publisher
truth over a bad IA scan — high error density makes it informative — and it is
the only large book the band pipeline was never tuned against. **deathstalker 1
is deliberately NOT held out**: it was the calibration book the pipeline's
thresholds were developed on, so holding it out would score the pipeline's own
tuning rather than the model's generalisation. `himmler-a-life` is in **train**,
where its volume, real-scan degradation and footnote apparatus are worth more.
It also refuses to write a tier-3 (teacher-only) book into eval unless
`--allow-tier3-eval` is passed, per `OCR_LAB.md`'s "eval only against tier-1
truth or hand-checked pages".

`what-to-expect-when-youre-expecting` and `what-to-expect-the-second-year` are
quarantined: excluded entirely unless `--include-quarantined`.

**`--unit sentence` builds the same corpus one unit up**, into `sft-sent/`
(default; `sft-line/` is the `--unit line` default and the two can never
collide). ONE file and ONE flag, so the two corpora provably share a repair
ladder. The order of operations is the whole design: the identity downsample
shreds line contiguity, so it has to run AFTER the packing, and the holdout
split and the German page window are carved at LINE level so that no unit can
straddle either. The unit gates are the LINE gates' PERCENTILES rather than
their values, read as a cascade against the population each gate actually sees;
they shape train only, because `sft-sent/eval.jsonl` must cover exactly the
characters `sft-line/eval.jsonl` covers — asserted against the file on disk,
identical line sets and identical non-whitespace character counts per book. The
full argument is the module docstring and
`docs/OCR_SENTENCE_CORPUS_SURVEY.md` §5.

Built 2026-08-05: 311,207 raw pairs → 268,599 kept lines → 57,608 units (4.66
lines each, p50 321 characters). Train 31,600 at 50.0% identity over 12 books,
eval 4,979 at 63.8% over the two holdouts, eval-german 770, plus `units.jsonl`
(every packed unit before the downsample — the base an identity-share sweep
re-derives from) and a balanced `eval-parity-1k.jsonl`. **Identity is a harsher
object at unit scale**: the same lines are 90.2% identity per line and 66.1% per
unit, because a unit is already-correct only if EVERY line in it was.

⚠️ **`max_seq_length 512` does not fit it.** Measured with the real Qwen3
tokenizer: line corpus max 246 tokens (the number 512 was set against), sentence
corpus max 573 on train and 579 on eval-german, 23 rows over 512. The tail is
German — umlauts and compounds tokenize at ~2.2 characters a token where English
prose runs ~3.5, so an average-case estimate says it fits and the tokenizer says
it does not. Use 768; `text_sft` refuses to truncate. **768 still holds at v1.1**
— the longest sequence this builder can now produce is 683 tokens (prompt variant
B on the longest German unit), 0 rows over 768 across both v1.1 corpora.

#### v1.1 — three flags, all default OFF, all TRAIN-only

`--unit sentence` with no other flag reproduces `sft-sent/` row for row; that
was checked against the previous builder and only the `truthTier` line moved.
Each flag below is a separate answer to something `results-sent-v1/` measured,
and each is opt-in because a corpus that changes when you rebuild it is not a
corpus.

**`--typography restore-identity` — the marks the corpus never had.** The
sentence model's residual failure is typographic: 13 of the 15 edits it made on
the real Kershaw EPUB are `—` → `-` or `‘…’` → `'…'`
(`results-sent-v1/kershaw-sent-report.json`). The cause is not subtle. **There
is not one curly quote, em dash, en dash or ellipsis anywhere in this corpus, on
either side, in any of 311,207 pairs.** Tesseract read them perfectly well —
104,467 of those lines carry at least one in the raw band JSON, 33.6% — and
`tools/ocr-lab/align-epub.py`'s `norm_text` folds them to ASCII before a pair is
written, on the OCR line at `build_ocr` and on the EPUB paragraph at read time.
Its `PUNCT_MAP` comment says the fold is "for MATCHING only" and that is no
longer true of the code beneath it. So the model was trained on a quarter of a
million examples that all say "punctuation is ASCII", and it does what it was
taught. The flag re-reads the raw band JSON (the `line` field is its index; the
mapping round-trips 311,207/311,207 with zero mismatches) and gives ALREADY-
CORRECT train lines their marks back as their own target. Identity lines only —
an edit row's target is the EPUB's text and its marks were folded at read time,
unrecoverable from anything on disk. **The real fix is upstream**: emit the marks
and fold only for matching. Until then this is supervision for preservation
rather than a hole where it should be.

**`--gold-join wrap-hyphen` — the word that wrapped.** `repair_hyphen` puts the
OCR's own fragment back on both sides of a wrap, which is right for a line model
and leaves sentence gold reading `ad-mit`: 23,381 of 23,387 wrap pairs whose
continuation survived. At the unit both halves are present, so the question is
answerable. The evidence is layered and never a guess: first the publisher's own
word where the aligner still had it whole (only ~2% of cases — since the Aug 2026
continuation rule `span_text` splits the truth word itself and *appends* a
hyphen, so `pervert-` and `twenty-` are byte-identical in the file), then the
book's own attested vocabulary read from `<lab>/gold/<book>/source.epub` — the
same standard `src/export/linejoin.ts` applies. Hyphenated form attested → real
compound, hyphen stays. Joined form attested → join. Neither → ambiguous, hyphen
stays. **It contradicts `SYSTEM`'s "keep a hyphen at the end of the line exactly
as it is"**, which is why `SYSTEM_B` rewrites that rule, and why this is a
decision rather than a default.

**`--prompt-variant b` — a DRAFT.** `SYSTEM_B` is written for a sentence unit.
foundry `src/ocr/prompt.ts` is not touched, `sentences.py` still crosschecks
against variant A, and nothing serves it. The flag exists so an A/B pair of
corpora is buildable from one builder.

Built 2026-08-05 into `sft-sent-v1_1/` and `sft-sent-v1_1-promptb/`: train
43,886 at **44.8%** identity (4,526 short of the 50% target — the joins turned
9,115 identity units into edit units), eval 4,979 and eval-german 770 **asserted
unit-for-unit identical to `sft-sent/`**, 62.8% of train units carrying a
typographic mark on the source side, 16,815 gold joins. Neither has been
trained.

### 2. `line-training-profiles.json`

`ocr_line_v1_06b` — Qwen3-0.6B, 16-bit LoRA, derived from `dagger_v1`.
Plus `ocr_line_v1_06b_safe` (batch 1 × accum 16 fallback) and
`ocr_line_v1_4b` (size control).

### 3. `train-line.sh`

Default output is the **plan**. `--preflight` does read-only box checks and
measures token lengths with the real tokenizer. `--go` merges profiles (after
backing up the rig's copy), stages via ssh stdin with sha256 verification on
both sides, and launches. It never merges the LoRA — that happens on the Mac.

### 4. `eval-line.py`

Runs a served GGUF over `eval.jsonl` through llama-server `/completion` with the
Qwen3 template built by hand (empty `<think>\n\n</think>` — the blocks trap).
Reports per-book CER before/after, improved / unchanged / **degraded**, and the
false-edit rate on already-correct lines, then the **German diagnostic slice as
a separate section** (`--german`). `--guard` measures what a distance-budget
guard would buy.

---

## Dataset stats — final build, Aug 1 2026

Built from the **re-minted** pairs: `bands.py` c79a06f (shadow-weld fix) and the
fixed `align-epub.py` (honest trailing punctuation, new hyphen-join convention,
"page N" anchors, UTF-8). 16 books, **310,915 raw pairs**.

The aligner fixes are visible in the artifact counts and they are large. Right-
edge extensions — the band-cropper clipping that was **32% of edit rows** in the
Jul 31 build — are now 957 across the whole corpus. The trailing-punctuation
artifact fell about tenfold per book (himmler 563, deathstalker-coda 132,
rise-and-fall 44, was-hitler 4, against thousands before).

| | rows |
|---|---|
| **train** | **46,726** (50.0% identity, 12 books) |
| **eval** (headline) | **21,268** — deathstalker-coda + michelle-remembers, 88.5% identity |
| **eval-german** (diagnostic) | **3,559** — himmler pages 924–1011, 65.9% identity |

| book | tier | kept | identity | edit | ident % |
|---|---|---|---|---|---|
| rise-and-fall | ? | 48,059 | 45,030 | 3,029 | 93.7 |
| himmler-a-life | 1 | 35,691 | 28,787 | 6,904 | 80.7 |
| deathstalker-war | 2 | 21,041 | 19,756 | 1,285 | 93.9 |
| deathstalker | 2 | 20,816 | 19,515 | 1,301 | 93.8 |
| deathstalker-honor | 2 | 20,622 | 19,086 | 1,536 | 92.6 |
| deathstalker-rebellion | 2 | 19,814 | 17,476 | 2,338 | 88.2 |
| deathstalker-legacy | 2 | 18,385 | 16,187 | 2,198 | 88.0 |
| deathstalker-destiny | 2 | 16,822 | 14,876 | 1,946 | 88.4 |
| deathstalker-return | 2 | 15,352 | 13,635 | 1,717 | 88.8 |
| **deathstalker-coda** (EVAL) | 2 | 12,330 | 10,833 | 1,497 | 87.9 |
| understanding-jehovahs-witnesses | 1 | 11,364 | 11,013 | 351 | 96.9 |
| **michelle-remembers** (EVAL) | 1 | 8,938 | 7,990 | 948 | 89.4 |
| gods-people | 1 | 8,711 | 7,356 | 1,355 | 84.4 |
| was-hitler-an-atheist | 1 | 5,401 | 4,786 | 615 | 88.6 |
| what-to-expect ×2 | 1 | quarantined (38,937 rows) | | | |

Truth repaired: 24,170 wrap-hyphen joins undone · 19,542 rows edge-punctuation
restored · 16,268 whole edge words restored · 3,155 welded words separated ·
1,902 typography · 957 edge words clamped · 844 punctuation runs · 316 small
caps · 46 `1`→`I`.

Dropped: 38,937 quarantined · 5,638 hyphen rows with no evidence · 1,985 below
the sim floor · 325 too short · 325 CMap damage · **253 ligature defect** · 106
over the CER cap.

CER histogram over the 23,363 train edit rows: 43.3% (0,2%] · 36.8% (2,5%] ·
12.6% (5,10%] · 5.4% (10,20%] · 1.6% (20,30%] · 0.3% >30%.

Sequence lengths: user+assistant is p50 118, p99 168, **max 198 characters**.

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
| ligature defect | on | Drops pairs whose **truth** has `!` with a letter on each side — `e!orts`, `!rst`. was-hitler-an-atheist's embedded layer mis-maps the `ff`/`fi`/`fl` ligatures onto the `!` slot. **253 rows** on the current mint (251 in that book, 1 each in two others). Word-internal `!` never occurs in real prose, which is what makes the signature safe. Left in, they teach ocr to *create* the damage on text the scanner read correctly. |
| book cap | `rise-and-fall=0.10` | See below. |
| German slice | on | See below. |
| quarantine | on | `--include-quarantined` opts back in. The two What-to-Expect books' post-fix numbers may have improved; the quarantine stands until reviewed. |

### The `|` decision: pre-strip trailing, keep interior

`|` appears in 184 of michelle's 9,053 lines. **142 are interior and every one
is Tesseract reading a capital `I` as a pipe** (`| know` → `I know`) — the
classic `l/1/I` confusion that §12d of `BLOCKS_TRAINING.md` records as *missing*
from the block corpus, and the single most valuable error class in this data.
**43 are trailing** and are the band cropper clipping the right edge (`PART |`,
`ascend|`, `He quickly S|`); stripping them makes 15 of the 43 byte-exact and
halves their mean CER.

Same character, opposite lessons, distinguished only by position. 43 examples
cannot teach a positional exception against 142 counter-examples, so the
positional case is removed deterministically.

> **This makes the strip a pipeline step, not a model behaviour. The same strip
> must run at serving time, before ocr sees the line.** It is a property of
> the band cropper; if ocr is served un-stripped lines it will meet a
> character it was never trained to handle in that position.

### Edge extensions are clamped — and the cropper fix shows up here

On the Jul 31 mint, 1,886 of 5,852 edit rows (**32%**) had a truth whose first or
last word strictly extends the OCR's: `neede` → `needed`, `unwit` → `unwittingly`, `murs` →
`Murmurs`. The band cropper clipped a character or two off the line end and the
EPUB truth still has them.

Some completions are near-certain (`candlesti`). It does not matter. A model
taught to complete a clipped edge word cannot tell a clipped line from a line
that simply ends there, so it fires on correct text too — and `degraded` is the
number that decides whether this model ships. The builder restores the OCR's own
edge token and **prints the count as a measurement of the clipping**. Fix the
cropper and those rows become ordinary supervision again.

**It was fixed** (`bands.py` c79a06f, the shadow-weld fix). On the Aug 1 re-mint
the same rung fires on **957 rows across all 16 books** — from a third of edit
rows down to a rounding error. The rung stays because it is cheap and because it
is now a regression detector: if that number climbs again, the cropper moved.

### rise-and-fall is capped at 10% of train

It is a **pristine Calibre render, not a scan** — `gold/manifest.json` calls it
degradation-ladder feedstock — and it is the largest book in the lab: 48,059
kept pairs, 24% of everything, 93.7% of them byte-exact.

Uncapped, the identity downsample would have drawn about a third of its identity
rows from this one book and handed it roughly a quarter of train: a quarter of
the signal describing what a *clean render* looks like, in a corpus whose entire
job is scan damage. §12d already measured where that ends — clean renders are
0.45% CER of which two thirds is ligature and quote normalisation, so training
on them builds a Unicode normaliser instead of an OCR repairer.

**The cap composes with the identity downsample rather than fighting it.** Order
of operations: the downsample decides *how many* identity rows train wants
(`--identity-share`), then the cap decides *where they may come from*. The
capped book keeps all 3,029 of its edit rows plus 1,644 identity rows — exactly
10.0% of the 46,726 — and the 43,386 identity rows it gives back are refilled
from the other books. `--identity-share` still holds exactly at 50.0%; only the
provenance mix moved.

### The German diagnostic slice

himmler pages **924–1011**, 3,559 rows, carved out of train and written to
`eval-german.jsonl`. It is **not** part of the headline.

Chosen by sliding a page window sized at ~10% of the book and taking the one
richest in non-ASCII truth characters — umlauts and eszett are what make a
German name hard, and exactly what a thin language prior strips. The window runs
at **0.31 non-ASCII characters per row against 0.112 book-wide, a 2.8×
enrichment**, and covers the densest pages in the book (the endnote apparatus,
where German titles cluster).

Contiguous rather than sampled, for the same reason holdouts are whole books:
neighbouring lines share a page, a typeface and a scanner artefact. Verified
zero page-level leak into train.

Without it the score is blind to the failure mode that decides the model-size
question, because the headline eval is English throughout.

---

## dagger's actual recipe, as found

From `training_profiles.json` on owens-pc (`/mnt/c/Users/tellt/Projects/orpheus-finetune/`,
not version controlled) and `/Volumes/Callisto/training/rubric/dagger/sft/`.

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
merge        NOT on the box. blocks-merge-mac.sh on the Mac.
             (best checkpoint = the one named by the HIGHEST-numbered
              checkpoint's trainer_state.json; dagger_v1 peaked at epoch 3
              and glob order would have shipped epoch 1)
publish      convert -> quantize -> load-check on the SAME pinned llama.cpp
             build the app bundles -> HF upload -> paste the catalog entry
             by hand (blocks-publish.sh; dagger shipped f16, unquantized)
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

## Proposed foundry-ocr-v1 line config

`ocr_line_v1_06b` is `dagger_v1` with three deliberate changes:

| | dagger_v1 | ocr_line_v1_06b | why |
|---|---|---|---|
| `max_epochs` | 4 | **3** | dagger took 4 on 2,598 rows with one book carrying 98% of the positives. This is ~21k rows over 7 books, and §5 of `BLOCKS_TRAINING.md` records that three runs out of three peaked at epoch 1. With `early_stopping_patience 2` and best-checkpoint selection, 3 is a ceiling. |
| `save_total_limit` | 4 | 4 | unchanged |
| `max_seq_length` | 512 (measured 442) | **512, PROVISIONAL** | Lines are far shorter than blocks — user+assistant is p50 122, p99 179, max 198 *characters*. But `text_sft` refuses to truncate, so this **must be re-measured with the real tokenizer before the run**; `train-line.sh --preflight` does exactly that. |

Everything else is dagger's, unchanged, including `load_in_4bit: false` and
`enable_thinking: false`.

**The size question is open and I would not assume 0.6B wins.** The block
model's own profile argues 4B because the job is *lexical* rather than
*positional*, and this corpus makes that concrete: `himmler-a-life` is now the
largest book in **train** at ~7,000 edit rows, and its real errors are
`Reichsftihrer` → `Reichsführer`, `Fugoslawien` → `Jugoslawien`, `Raterepublik`
→ `Räterepublik`. A thin language prior does not merely fail to fix German
proper nouns, it "corrects" them toward something more English-looking, and the
result is narrated.

> **The holdout change moved that evidence out of eval.** michelle-remembers is
> English throughout, so the headline `degraded` figure will no longer see the
> German failure mode at all. Score **both** sizes and look at the German-bearing
> rows directly, or the risk simply goes unobserved.

0.6B is primary only because the pipeline runs this model **per line**, tens of
thousands of times per book, where a 4B's inference cost is a real number.
`ocr_line_v1_4b` is in the file for the comparison.

---

## The run — launched Aug 1 2026, 00:32 EDT

```
profile     ocr_line_v1_06b        Qwen3-0.6B, bf16 LoRA r32
corpus      46,726 train / 21,268 eval / 3,559 eval-german
steps       8,763  (3 epochs, batch 4 x accum 4 = effective 16)
schedule    save_strategy=epoch, eval_strategy=epoch, logging_steps=10,
            load_best_model_at_end -> first checkpoint + eval at step 2,921
speed       ~1.24 s/it  ->  ~3h0m
loss mask   assistant_only_loss=True: 1,101,881 of 7,674,925 train tokens
            carry loss (14.4%) — the check that the mask is really on
seq length  max_seq_length 512 against a MEASURED max of 246 tokens
            (p50 163, p95 181, p99 201 over all 46,726 rows)
log         ~/ocr-line/train.log      temps: ~/ocr-line/temp.log
adapter     /home/telltale/xtts_ft/ocr_line_v1_06b_lora
```

### How it was launched, and why not over ssh

Windows OpenSSH puts each session in a **job object** and kills the whole
process tree when the session closes. `nohup` and `setsid` do not escape it, so
a training run started as a child of an ssh command dies when that command
returns.

The run is therefore a **Windows Scheduled Task**, which Task Scheduler spawns
outside the ssh job object:

```bash
# runner staged into WSL first, so nothing has to survive nested quoting
schtasks /create /tn "ocr_line_v1" /sc once /st 00:00 /f \
         /tr "wsl.exe -e /home/telltale/ocr-line/run.sh"
schtasks /run    /tn "ocr_line_v1"
```

Two quoting traps, both hit on the way:

- **The remote login shell is PowerShell**, which expanded `$HOME` inside the
  `/tr` string into `C:\Users\tellt` and broke the escaping. The action string
  ended up as `wsl.exe -e bash -lc " C:\Users\tellt/ocr-line/run.sh\`. Use
  literal WSL paths and no `$` in `/tr`; verify with `schtasks /query /v`.
- **Any command sent inside nested quotes** loses `sed`/`grep` expressions to the
  same shell. `train-line.sh`'s `wsl()` helper now pipes the script body through
  **stdin** (`printf '%s' "$cmd" | ssh HOST "wsl -e bash -lc 'bash -s'"`), the
  same reason the corpus is staged through stdin.

**Survival verified, not assumed.** Every ssh command in this session opens and
closes its own connection; the process was confirmed alive on a fresh connection
2m46s after launch and has stayed up across every subsequent one.

### Heat

A second scheduled task runs a monitor that logs GPU temperature every 60s and
throttles itself: `nvidia-smi -pl 270` at 86 °C, `-pl 220` at 90 °C — the owner's
thresholds, applied automatically rather than watched for.

Observed early in the run: **44 °C idle → 50 °C → 59 °C under load**, at 172 W of
a 450 W limit. Comfortably clear of the 82 °C normal band, let alone the 86 °C
line.

## GPU box status## Commands the owner approves to

**(a) rebuild the dataset once all books' pairs exist**

```bash
# look first — writes nothing
python3 tools/foundry-ocr/build-dataset.py --dry-run

# build
python3 tools/foundry-ocr/build-dataset.py \
    --out /Volumes/Callisto/training/rubric/galley/sft-line

# the sentence corpus — histograms and thresholds first, then build
python3 tools/foundry-ocr/build-dataset.py --unit sentence --dry-run
python3 tools/foundry-ocr/build-dataset.py --unit sentence
```

It refuses to run if a holdout book's rows would land in train, or if a tier-3
book would land in eval. Add `--include-quarantined` only after reviewing the
What-to-Expect boxed-text damage.

**(b) launch training** — needs the owner's explicit green light

```bash
# 1. read-only checks + MEASURE token lengths (no GPU work)
bash tools/foundry-ocr/train-line.sh --preflight

# 2. only after the green light, with a temperature monitor running.
#    Run it as a BACKGROUND task so the ssh handle stays alive.
RUN=ocr_line_v1_06b bash tools/foundry-ocr/train-line.sh --go

# 3. merge on the Mac (never on the box). blocks-merge-mac.sh is already
#    parameterised for this: it reads the base from the adapter's own
#    adapter_config.json, and BLOCKS_QUANT="" skips quantization — which is what
#    a 0.6B trained in bf16 wants, since 1.2 GB is not worth a lossy step.
#    Its best-checkpoint picker reads the HIGHEST-numbered checkpoint's
#    trainer_state.json, because an early checkpoint names only itself.
BLOCKS_QUANT="" tools/aligner/blocks-merge-mac.sh \
    ocr-line-v1-0.6b /home/telltale/xtts_ft/ocr_line_v1_06b_lora
#    Space check before running this: the Mac's data volume was at 100% with
#    11 GB free on Aug 1. The merge needs ~2.5 GB — adapter + merged weights +
#    f16 GGUF — and NOT a base download, because unsloth/Qwen3-0.6B (the id the
#    adapter names) is already in ~/.cache/huggingface from dagger, and
#    ~/blocks-export/venv already has torch/peft. It fits, but ~/blocks-export
#    is 57 GB of re-derivable blocks v4/v5 intermediates if room is ever needed.

# 4. serve and score. Read `degraded` FIRST.
<llama-build>/llama-server -m ocr-line-v1-0.6b-f16.gguf --port 8771 -c 1024
python3 tools/foundry-ocr/eval-line.py --limit 3000 --json ~/ocr-line-eval.json
python3 tools/foundry-ocr/eval-line.py --limit 3000 --guard 0.25   # what a guard buys
#    The German diagnostic slice is scored automatically as a separate section
#    (--german, default ~/…/sft-line/eval-german.jsonl). It is NOT the headline.

# 5. clear the WSL staging. It is a staging ground, never a master.
```

---

## Open questions only the owner can answer

1. **Line model or block model?** Both corpora now exist and neither has
   trained. `OCR_LAB.md`'s pipeline wants a line corrector; `BLOCKS_TRAINING.md`
   §12 built a block corrector with a safety contract. Training both is
   affordable; shipping both is not.

2. **The open contract question — a line corrector can invent a word, and
   nothing stops it.** dagger could only emit deletions and *still* needed a
   subsequence guard after testing caught it rewriting `mercilessly."` into
   `merrical."`. `edits.mjs` gives the block model an applier that rejects any
   anchor it cannot quote verbatim. **The line model as specified has no
   equivalent.** §11f already says "settle ocr's applier contract before
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

7. **Eval is now English-only** (michelle-remembers), while ~7,000 of train's
   edit rows are German-bearing (himmler). The score cannot see whether the model
   mangles German proper nouns. Worth either a second, un-headline eval slice or
   an explicit decision to accept the blind spot.

4. **Quarantine review.** The two What-to-Expect books are 38,865 pairs — about
   19% of everything available — sitting out pending the boxed-text damage
   report.

5. **Should the aligner be fixed before training?** Every repair rung in
   `build-dataset.py` is a workaround for `align-epub.py` losing content at the
   truth window's edges, and the largest one touches 25,566 rows. The harness
   works either way and prints the counts, but a fixed aligner would give
   cleaner supervision and delete a lot of this code.

6. **Right-margin clipping in the band cropper** (32% of edit rows had a clipped
   final word). Worth a look independently of ocr — it is a recognition loss,
   and `OCR_LAB.md`'s stated priority is that missing text is the fatal class.

---

## v1 line-model results — scored Aug 1 2026, all three checkpoints

Run: `ocr_line_v1_06b` (Qwen3-0.6B LoRA), 46,726 rows, 8,763 steps, ~4h48m,
zero throttles. Baselines from a do-nothing stub, harness-validated: headline
CER **0.431%** (deathstalker-coda 0.373%, michelle-remembers 0.514%), 88.5%
exact, German canary **1.142%**, all at 0 degraded / 0.00% false edits.

**Unguarded, no checkpoint ships — every one RAISES headline CER** (n=1500):

| ckpt | degraded | CER | exact |
|---|---|---|---|
| 2921 (ep1) | 70 (4.67%) | 0.491% ✗ | 91.1% |
| **5842 (ep2)** | **59 (3.93%)** | 0.476% ✗ | **92.1%** |
| 8763 (ep3) | 84 (5.60%) | 0.766% ✗ | 90.7% — overfit, one runaway row |

**A global per-line distance budget cannot serve both languages.** Per-line 0.02
gives English its best line-budget result (0.374%) but destroys German
(0.998% — worse than doing nothing), because legitimate German repair is several
umlauts on one line.

**The shipping contract is a PER-WORD guard, d≤2** (reject any single word whose
replacement is more than 2 edits away; ambiguous alignments reject). On
checkpoint-5842 it beats every per-line setting on BOTH axes:

| | baseline | ckpt-5842 + per-word d≤2 |
|---|---|---|
| English headline CER | 0.431% | **0.336%** (−22%), degraded 20/1500, false-edit 1.20% |
| German canary CER | 1.142% | **0.493%** (−57%), degraded 39/1500, false-edit 3.54% |
| deathstalker-coda | 0.373% | 0.258% |
| michelle-remembers | 0.514% | 0.447% (unguarded it got WORSE: 0.735%) |

Residual damage under the guard is 1–2 character punctuation and function-word
swaps; no invented prose. The German failure mode is NOT diacritic drift
(38 under / 30 over, symmetric) but **lexical substitution within German** —
`Dänemark`→`Deutschland`, `fünfzig`→`fünftel` — CER-invisible falsehoods the
per-word guard blocks by distance. This is the 4B-control prediction landing
verbatim, and the reason v1.1 trains at 4B.

**The open item**: the per-word guard exists only in offline analysis. If this
ships, the rule must live in the applier AND be the same implementation the
scorer uses — the drift-is-a-hard-stop discipline `edits.mjs` applies to the
block model.

---

## The guard's blast radius, and the unit — measured Aug 5 2026

Two questions, one set of generations. **(1)** The shipped guard discards a whole
unit when one word in it is bad; should it discard only the offending run?
**(2)** Can the line corrector run on SENTENCES without retraining?

Tools: `sentences.py` (line corpus or EPUB → sentence units), `align-degraded.py`
(a scan of a damaged raster → pairs against the source's text), `eval-guard.py`
(generate once, score under every policy), `review-edits.py` (the list a human
reads when there is no gold), `guard-crosscheck.mjs` (the scorer's guard IS
foundry's guard — proven, not assumed: 28,752 verdicts, 0 mismatches). Raw
generations and every score are in `results-guard-experiment/`, so a claim here
can be re-scored rather than re-argued.

Model: **base `foundry-4b-f16.gguf` + adapter `foundry-ocr-v1-4b.gguf`
(Checkpoint 5910) at scale 1.0**, llama-server b7482 CUDA, greedy
(temperature 0, top_k 1). **Adapter activation was proved before anything else
was measured** — 120 damaged held-out rows, exact match to truth **71/120 with
the adapter, 22/120 without**, and scale 0.0 byte-identical to sending no `lora`
field at all on 120/120 rows
(`results-guard-experiment/adapter-activation-proof.txt`). Without that proof
every number below would have been the bare base and nothing would have said so.

### The table

`degraded` counts UNITS and cannot compare two unit sizes — the same damage over
4.3x fewer, 4.3x longer units gives a smaller count for free. `deg/100k` and
`rep/100k` are CHARACTERS moved away from and toward the truth per 100,000 gold
characters, and those do compare. Within a condition, lines and sentences cover
**exactly the same text**.

| condition | unit | policy | CER before → after | degraded | deg/100k | rep/100k | falseEdit |
|---|---|---|---|---|---|---|---|
| **corpus slice** | line | do nothing | 0.331% | 0 | 0.0 | 0.0 | 0.00% |
| 1,232 lines | line | no-guard | 0.331 → 0.276% | 30 | 82.1 | 136.9 | 1.73% |
| 284 sentences | line | whole-unit | 0.331 → 0.239% | 10 | **16.9** | 109.5 | 0.64% |
| held-out books | line | per-run | 0.331 → **0.232%** | 11 | 18.2 | **117.3** | 0.64% |
| | sent | no-guard | 0.327 → 0.346% ✗ | 52 | 131.5 | 113.5 | 17.68% |
| | sent | whole-unit | 0.327 → 0.288% | 30 | **45.1** | 85.1 | 12.15% |
| | sent | per-run | 0.327 → **0.277%** | 37 | 54.1 | **104.4** | 13.81% |
| **Kershaw**, real | line | do nothing | 0.741% | 0 | 0.0 | 0.0 | 0.00% |
| Tesseract on a | line | no-guard | 0.741 → 0.720% | 36 | 249.4 | 270.1 | 7.81% |
| real page | line | whole-unit | 0.741 → **0.648%** | 27 | **138.5** | 232.1 | 6.69% |
| 390 lines | line | per-run | 0.741 → 0.658% | 29 | 148.9 | 232.1 | 7.06% |
| 103 sentences | sent | no-guard | 0.745 → **1.568%** ✗✗ | 24 | 1026.1 | 202.5 | 25.00% |
| | sent | whole-unit | 0.745 → 0.697% | 17 | **103.0** | 151.0 | 25.00% |
| | sent | per-run | 0.745 → **0.669%** | 19 | 109.8 | **185.3** | 25.00% |
| **Kershaw**, speckle | line | no-guard | 6.854 → 9.223% ✗ | 53 | 4045.3 | 1676.3 | 0.00% |
| (induced, 7% CER) | line | whole-unit | 6.854 → 6.245% | 13 | **65.8** | 675.4 | 0.00% |
| 479 lines | line | per-run | 6.854 → **5.968%** | 20 | 97.0 | **983.6** | 0.00% |
| 102 sentences | sent | no-guard | 7.070 → 4.789% | 8 | 1248.7 | 3529.9 | 0.00% |
| | sent | whole-unit | 7.070 → 7.036% | 0 | **0.0** | 34.3 | 0.00% |
| | sent | per-run | 7.070 → **6.206%** | 7 | 48.0 | **912.5** | 0.00% |

### What it says

**No guard never ships.** It is the worst policy in five of six scored cells, and
on real Kershaw sentences it more than DOUBLES CER above doing nothing
(0.745% → 1.568%). The measured case for a guard stands.

**per-run buys recall in every condition and costs damage in every condition.**
`rep/100k` is higher under per-run in all six cells (tied once); `deg/100k` is
higher too. Net CER favours per-run in five of six. The exception — Kershaw
lines at realistic damage, 0.648% vs 0.658% — rests on **2 differing units out
of 390** and **cannot be distinguished from noise**. Neither can the
corpus-slice line result (6 differing units out of 1,232).

**The blast radius scales with the unit, exactly as the guard header predicts.**
On lines the two policies are within noise. On 400-character sentences at 7%
CER, `whole-unit` degenerates into a near-total rejection device: **6
corrections across 102 units, `rep/100k` 34.3**, because a long unit almost
always contains one illegal run somewhere. `per-run` keeps 96 corrections and
912.5. That is the whole argument for the mode, and it is an argument about unit
LENGTH, not about lines.

**Sentence mode does NOT catch more real errors — it catches fewer.** On the same
characters, lines repair more per 100k than sentences in every paired cell
(109.5/117.3 vs 85.1/104.4; 232.1 vs 151.0/185.3), and sentence mode's
false-edit rate is 12–25% of already-correct units against 0.6–7% for lines.
Feeding a sentence to a prompt that says "a single line of text" costs recall
and buys damage. **The one place sentences win is heavy damage with no guard**
(7.070% → 4.789%, `rep/100k` 3,530): the extra context genuinely helps when the
line alone is unreadable — but the model expresses that help as REWRITING, and
the guard then throws most of it away.

**The residual damage under the guard is TYPOGRAPHY.** `‘rational’` → `'rational'`
and `—` → `-` are balanced, within-distance-2, one-word-for-one-word changes, so
they pass the rule cleanly and ship. On the clean Kershaw EPUB they are the
single largest class of proposed edit. This is the corpus's own prediction
landing: "train on that and you get a Unicode normaliser."

**The guard cannot express a word-merge, and that is structural.** Every
de-spacing repair the model got RIGHT on Kershaw — `‘totali tarianism’` →
`'totalitarianism'`, `compar ing` → `comparing`, `193 3,` → `1933,`,
`Memoran dum` → `Memorandum` — is 2 words → 1 and is refused by BOTH guard
policies. (Those are a soft-hyphen join defect being fixed deterministically
elsewhere, not the model's job, and they are not counted as a win — but they are
the cleanest demonstration that the balance rule has no way to say yes to a
merge.)

**On the real book, the named errors were fixed and the proper nouns survived.**
`mid-i92os` → `mid-1920s` and `mid-i93os` → `mid-1930s`, both legal, shipped
under every policy. `Führer` 33/33, `Hitler` 89/89, `Lammers` 5/5, `Nazi` 33/33,
`Reich` 16/16 intact under every policy; `Son-derweg).` correctly healed to
`Sonderweg).`. 145 units, 112 proposed edits, 78 legal / 34 illegal, and
**22 legal runs that `whole-unit` discards because a sibling run was illegal** —
that is what per-run would recover on this book.

**The counter-example per-run has to answer for** (`kershaw-clean.lines`, p1 l45):
an already-correct line, where the model rewrites two em dashes to hyphens
(legal) AND inserts a word (illegal). `whole-unit` refuses everything and the
line ships untouched; `per-run` keeps the dash rewrites and ships a 2-character
degradation. Same shape at p5 l286, worse: `Anton Hoch` → `Anton Höch` is legal
and WRONG, `Biirgerbraukeller` → `Bürgerbräukeller` is illegal at distance 3 and
RIGHT — per-run keeps the wrong one and reverts the right one. An illegal run
really is evidence about the whole answer, which is why the default did not move.

### Open, and owed

- The d≤2 threshold splits a single German repair class arbitrarily: `Miinchner`
  → `Münchner` is accepted at d=2, `Biirgerbraukeller` → `Bürgerbräukeller` is
  refused at d=3. Same error, opposite verdicts.
- Kershaw's PDF is a **JBIG2 scan with an OCR text layer**, so the "truth" its
  rows score against is an earlier OCR pass, not the publisher's file. Recall is
  still measurable — induced errors are new and the reference's own errors
  cancel — but a model CORRECTING a reference error scores as damage, and
  `align-degraded.py` prints that warning rather than hiding it. The
  corpus-slice rows carry real tier-1/2 truth and agree with Kershaw on every
  direction.
- Induced-error recall is an **optimistic bound**: `degrade.py`'s ladder may sit
  closer to the training distribution than a random real scan would.
- `photocopy-combo` was measured and DISCARDED as a condition: 18.3% CER, 0% of
  lines already correct. That is not a degraded scan, it is a destroyed one, and
  it is far outside anything the corpus was built from. `blur0.6` was discarded
  for the opposite reason (0.796% — indistinguishable from clean).
