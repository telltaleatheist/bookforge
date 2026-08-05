# ocr_sent_v1_4b — retrieved, merged and scored on the Mac, Aug 5 2026

**NOT COMMITTED, NOT PUBLISHED.** Owen reviews first. Nothing was uploaded to
HuggingFace and nothing on owens-pc was deleted.

The question: the Aug 5 guard experiment measured that the LINE model, fed
sentences, *loses* — 12–25% false-edit rate, `deg/100k` up, `rep/100k` down
against the same characters read as lines, and no-guard CER *above* doing
nothing. `ocr_sent_v1_4b` is the same job trained at the sentence unit. Did
training at the unit fix serving at the unit?

**Yes, decisively, and it now beats the line model at the line unit too.**

---

## Which checkpoint, and why

`trainer_state.json` in `checkpoint-5925/` (the highest-numbered, therefore the
authoritative one — an early checkpoint names only itself):

```
best_model_checkpoint  checkpoint-1975      eval_loss 0.024632   (epoch 1)
                       checkpoint-3950      eval_loss 0.025220   (epoch 2)
                       checkpoint-5925      eval_loss 0.030917   (epoch 3)
```

Three runs out of three peaking at epoch 1 is now four out of four.

**The run-root `adapter_model.safetensors` is BYTE-IDENTICAL to
checkpoint-1975's** — `load_best_model_at_end` restored the best weights before
the final save, so there was nothing to choose between. Verified on both sides
of the network:

```
91d51616c952a3953caff92688662c6e1ecf2f178869cb61cc218f5e8a134f4c   (remote) ocr_sent_v1_4b_lora/adapter_model.safetensors
91d51616c952a3953caff92688662c6e1ecf2f178869cb61cc218f5e8a134f4c   (remote) ocr_sent_v1_4b_lora/checkpoint-1975/adapter_model.safetensors
91d51616c952a3953caff92688662c6e1ecf2f178869cb61cc218f5e8a134f4c   (Mac)    ocr_sent_v1_4b_lora/adapter_model.safetensors
91d51616c952a3953caff92688662c6e1ecf2f178869cb61cc218f5e8a134f4c   (Mac)    ocr_sent_v1_4b_lora/checkpoint-1975/adapter_model.safetensors
6b11516c9addd44d5b3d8560b88ae7407fc6eb831b2436e66137466ef10e8eaf   (remote) checkpoint-3950/adapter_model.safetensors
cead6bc07fdf767aa010f3d188c1d1b80f53187667b73685094a9c2e967ce23c   (remote) checkpoint-5925/adapter_model.safetensors
```

`blocks-merge-mac.sh` was run unmodified and picked **checkpoint-1975** by its
own rule; that is what everything below was built from.

## The artifacts

Merged with `tools/aligner/blocks-merge-mac.sh` (unmodified; `HOME` and
`BLOCKS_QUANT=""` set on the command line, an `ollama` no-op shim on `PATH` so
step 5/5 does not import an 8 GB f16 into Ollama — this model is served by
llama-server, not Ollama).

| file | bytes | sha256 |
|---|---|---|
| `/Volumes/Callisto/ocr-sent-export/ocr_sent_v1_4b_lora/` | — | the pulled adapter tree (root + checkpoint-1975 + checkpoint-5925/trainer_state.json) |
| `/Volumes/Callisto/ocr-sent-export/blocks-export/ocr-sent-v1-4b-merged/` | 8.0 GB | merged 16-bit HF weights |
| `/Volumes/Callisto/ocr-sent-export/blocks-export/ocr-sent-v1-4b-f16.gguf` | 8,051,285,408 | `cec0aaad7d2009bf35b580e61c4f3c55fc799f7ff817deafe11cbca6632f9b0b` |
| **`/Volumes/Callisto/ocr-sent-export/foundry-ocr-sent-v1-4b-Q8_0.gguf`** | **4,280,405,408** | `4b1c9ea8bac07dc3d2189ad607826c590446a91ab7a2dcb4f907ba8eec991d02` |
| **`/Volumes/Callisto/ocr-sent-export/foundry-ocr-sent-v1-4b.gguf`** | **132,155,616** | `d29eac9adafbc41eb28a62d077ffe5e7a15ea52730ed4d6c92847632c3369952` |

The last two are the two ways to ship it and they measure the same:

- the **Q8_0 fused** file, what was asked for, served alone;
- the **f16 LoRA adapter** (`convert_lora_to_gguf.py` on checkpoint-1975), served
  as `foundry-4b-f16.gguf --lora-scaled …:0.0` with the scale vector set per
  request — which is how `src/serve/llama-server.ts` and the Aug 5 baseline serve,
  and therefore the only configuration that makes this a paired comparison.

Base is `unsloth/Qwen3-4B` — read out of the adapter's own `adapter_config.json`,
never guessed. The base GGUF's `general.name` is
`64033659d5caf1b8ed7f929b29de705e93a4d468`, which is exactly that repo's snapshot
hash: the file on disk provably *is* the base these weights were trained against.

Quantized and served on **b7482**, the build the app bundles and the same
release the Aug 5 CUDA baseline ran on. Conversion used the llama.cpp checkout at
`~/rubric-export/llama.cpp` (b10194) — newer than the server, which is the one
place a "loads here, not there" could have crept in, and did not: the load check
is every number in this directory.

## Is it the trained model?

`adapter-activation-proof.txt`, verbatim, in full. Headline: on the 103 damaged
corpus-slice sentence units, **exact match to truth 46/103 with the adapter and
31/103 without**, the two conditions differ on 53/103 units, and the merged
Q8_0 file repairs the same three named errors the bare base does not.

## THE COMPARISON

Same 284 sentence units, same 77,565 gold characters, same system prompt, same
sampling, all four models. `results-guard-experiment/dumps/corpus-slice.sent.dump.jsonl`
supplied the unit set; only the answers were re-generated.

### Corpus slice — SENTENCE units (284 units, 181 already correct = 63.7%)

| model | policy | CER before → after | degraded | deg/100k | rep/100k | falseEdit |
|---|---|---|---|---|---|---|
| — | do nothing | 0.327 → 0.327% | 0 | 0.0 | 0.0 | 0.00% |
| **line model**, Aug 5 CUDA baseline | no-guard | 0.327 → 0.346% ✗ | 52 | 131.5 | 113.5 | 17.68% |
| | whole-unit | 0.327 → 0.288% | 30 | 45.1 | 85.1 | 12.15% |
| | per-run | 0.327 → 0.277% | 37 | 54.1 | 104.4 | 13.81% |
| **line model**, re-run here on Metal | no-guard | 0.327 → 0.344% ✗ | 51 | 130.2 | 113.5 | 17.13% |
| | whole-unit | 0.327 → 0.286% | 29 | 43.8 | 85.1 | 11.60% |
| | per-run | 0.327 → 0.276% | 36 | 52.9 | 104.4 | 13.26% |
| **SENTENCE model** (f16 base + adapter) | no-guard | 0.327 → 0.222% | 10 | 23.2 | 128.9 | 1.66% |
| | whole-unit | 0.327 → **0.220%** | **5** | **6.4** | 113.5 | **1.10%** |
| | per-run | 0.327 → **0.218%** | 6 | 7.7 | **117.3** | 1.10% |
| **SENTENCE model** (merged Q8_0 fused) | no-guard | 0.327 → 0.226% | 11 | 24.5 | 126.3 | 1.66% |
| | whole-unit | 0.327 → 0.223% | 5 | 6.4 | 110.9 | 1.10% |
| | per-run | 0.327 → 0.213% | 6 | 7.7 | 122.5 | 1.10% |
| *SENTENCE model, repeat run (noise band)* | *no-guard* | *0.327 → 0.227%* | *11* | *24.5* | *125.1* | *1.66%* |
| | *whole-unit* | *0.327 → 0.224%* | *5* | *6.4* | *109.6* | *1.10%* |
| | *per-run* | *0.327 → 0.214%* | *6* | *7.7* | *121.2* | *1.10%* |

### Corpus slice — LINE units, the same characters (1,232 units, 89.2% already correct)

Aug 5 baseline, unchanged. `degraded` counts UNITS and does not cross unit sizes;
`deg/100k` and `rep/100k` do.

| model | policy | CER before → after | degraded | deg/100k | rep/100k | falseEdit |
|---|---|---|---|---|---|---|
| — | do nothing | 0.331 → 0.331% | 0 | 0.0 | 0.0 | 0.00% |
| line model on lines | no-guard | 0.331 → 0.276% | 30 | 82.1 | 136.9 | 1.73% |
| | whole-unit | 0.331 → 0.239% | 10 | 16.9 | 109.5 | 0.64% |
| | per-run | 0.331 → 0.232% | 11 | 18.2 | 117.3 | 0.64% |

### German — `sft-sent/eval-german.jsonl`, **first 200 rows by file order**

himmler-a-life pages 924–1010, 58,100 gold characters, 41 already correct
(20.5%). Held out of train for both models. 200 by file order to bound runtime —
stated because it is a slice, not a sample.

| model | policy | CER before → after | degraded | deg/100k | rep/100k | falseEdit |
|---|---|---|---|---|---|---|
| — | do nothing | 1.096 → 1.096% | 0 | 0.0 | 0.0 | 0.00% |
| **line model** | no-guard | 1.096 → **0.336%** | 12 | 27.5 | **788.3** | 19.51% |
| | whole-unit | 1.096 → 0.583% | 9 | 18.9 | 531.8 | 14.63% |
| | per-run | 1.096 → 0.398% | 11 | 22.4 | 721.2 | 14.63% |
| **SENTENCE model** (f16 base + adapter) | no-guard | 1.096 → 0.349% | **2** | **10.3** | 757.3 | **0.00%** |
| | whole-unit | 1.096 → 0.515% | **0** | **0.0** | 581.8 | **0.00%** |
| | per-run | 1.096 → **0.387%** | **0** | **0.0** | **709.1** | **0.00%** |
| **SENTENCE model** (merged Q8_0 fused) | no-guard | 1.096 → 0.353% | 2 | 10.3 | 753.9 | 0.00% |
| | whole-unit | 1.096 → 0.515% | 0 | 0.0 | 581.8 | 0.00% |
| | per-run | 1.096 → 0.391% | 0 | 0.0 | 705.7 | 0.00% |

## What it says

**Sentence training fixed sentence serving.** Every number moves the right way
and none of them is close. Under the shipped `whole-unit` policy the sentence
model cuts `deg/100k` from 43.8 to **6.4** (7×), raises `rep/100k` from 85.1 to
**113.5** (+33%), and drops the false-edit rate from 11.60% to **1.10%** (10×).
CER after falls 0.286% → 0.220%. The Aug 5 finding — "sentence mode does NOT
catch more real errors, it catches fewer" — was a statement about the LINE
model's prompt-unit mismatch, not about sentences.

**And it beats the line model at the line model's own game.** On the same 76–78k
characters, `whole-unit`: sentences now score `deg/100k` 6.4 against lines' 16.9
and `rep/100k` 113.5 against 109.5. The one axis where lines still win is the
false-edit rate (0.64% vs 1.10%) — and that is measured over a 63.7%-correct
population against an 89.2%-correct one, so it is the harder denominator. This
is 4.3× fewer model calls per book for less damage and slightly more repair.

**On German it is a safety transformation, not a recall one.** Raw recall is a
wash (`rep/100k` 757 vs 788 unguarded, CER 0.349% vs 0.336%). What changed is
that the line model false-edits **19.51%** of already-correct German units and
degrades 12 of 200; the sentence model false-edits **zero** and degrades **zero**
under either guard. The failure mode `results-guard-experiment` called
"lexical substitution within German" is gone from this slice. Under the guard the
sentence model therefore wins outright: per-run 0.387% vs 0.398%, whole-unit
0.515% vs 0.583%.

**per-run still buys recall and costs damage, and the margin shrank.** English:
per-run 0.218% vs whole-unit 0.220%, on ONE differing unit out of 284 — noise.
German: per-run 0.387% vs 0.515% on `rep/100k` 709 vs 582, with `deg/100k` 0.0
under BOTH. That is the first cell where per-run is strictly free, and it is the
cell whole-unit was worst in. It does not settle the default on its own — 200
units of one book is one book — but it is the strongest evidence per-run has.

**Q8_0 costs nothing measurable.** Merged-and-quantized vs f16-base-plus-f16-
adapter: 281/284 identical answers on English, 198/200 on German, and every
metric inside the run-to-run noise band. Ship whichever is more convenient.

**Greedy is not byte-reproducible on this build** — `greedy-determinism.txt`.
Two runs of the identical config agree on 280/284 units. That is the noise floor
every claim above is measured against, and the smallest gap being claimed
(whole-unit CER 0.220% vs 0.286%) is 20× it. The Aug 5 CUDA baseline and its
re-run here on Metal agree on **283/284**, so the platform is not a confound for
anything in this directory.

## Open / owed

- **The prompt still says "a single line of text."** `sft-sent` kept the line
  corpus's system prompt verbatim, so the sentence model was trained to answer a
  prompt that misdescribes its input, and these numbers are what that scores. A
  prompt that says "sentence" is untested and could go either way; it would need
  a retrain to test honestly.
- Recall on German is *not* better than the line model's, only safer. If the
  goal is fixing `Reichsftihrer`, this run did not move it — it stopped the model
  inventing new errors around it.
- The German slice is 200 units of ONE book. The English slice is 284 units of
  two. Both are small; the effect sizes here are large enough to survive that,
  the per-run-vs-whole-unit margin is not.
- Nothing measured the **line** unit with these weights. If sentences ship, that
  is moot; if a mixed pipeline is wanted, it is unmeasured.
- `foundry`'s guard, `blocks-publish.sh`'s catalog entry, and any decision about
  which of the two files ships are all downstream of a review that has not
  happened.

## Files

```
results-sent-v1/
  README.md                                  this
  adapter-activation-proof.txt               is it the trained model? (verbatim)
  greedy-determinism.txt                     the noise floor, measured
  corpus-slice.sent.NEW.{score.txt,stats.json}          sentence model, f16 base + adapter
  corpus-slice.sent.NEW.rerun.{score.txt,stats.json}    the same again — noise band
  corpus-slice.sent.NEW-Q8fused.{…}          sentence model, merged Q8_0, no adapter
  corpus-slice.sent.OLDLINE-mac.{…}          LINE model re-run here — the paired control
  eval-german-200.NEW.{…}
  eval-german-200.NEW-Q8fused.{…}
  eval-german-200.OLDLINE-mac.{…}
  dumps/
    corpus-slice.units.jsonl                 the Aug 5 unit set, re-emitted with `system`
    eval-german-200.units.jsonl              first 200 of sft-sent/eval-german.jsonl
    *.dump.jsonl                             every raw answer, re-scorable without a GPU
  helpers/
    dump-to-units.py                         a dump carries `systemPrompt` once on its
                                             meta line, not per row — re-emit it as units
    prove.py                                 the activation proof
    determinism.py                           the noise floor
```

**`eval-guard.py` was NOT modified.** The three helpers are shape-fitting and
probing only; `eval-guard.py score --dump dumps/<any>.dump.jsonl` reproduces
every table above with no server and no helper.

Re-serve either file with the bundled build:

```bash
LB=.llama-build/llama-b7482-bin-macos-arm64/llama-b7482
DYLD_LIBRARY_PATH=$LB $LB/llama-server -c 16384 -np 8 -ngl 99 --no-webui --port 8771 \
  -m /Volumes/Callisto/ocr-sent-export/foundry-ocr-sent-v1-4b-Q8_0.gguf
# …or the way the app serves, which is what was scored:
DYLD_LIBRARY_PATH=$LB $LB/llama-server -c 16384 -np 8 -ngl 99 --no-webui --port 8771 \
  -m ~/Library/Application\ Support/foundry/models/foundry-4b-f16.gguf \
  --lora-scaled /Volumes/Callisto/ocr-sent-export/foundry-ocr-sent-v1-4b.gguf:0.0
```
