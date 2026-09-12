# `narrator/align` - post-render forced alignment

Points 3 and 4 of `docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points"
(Owen, approved 2026-09-05), built 2026-09-05.

```
narrator align --session-dir <hash dir> [--out sentences.vtt] [--report coverage.json]
               [--backend whisperx|qwen3] [--language en] [--device cpu]
               [--python <backend env python>] [--indices 3,4,5] [--ffmpeg PATH]
               [--workers N]
```

Two things come out of ONE forced alignment of each rendered chunk, and BOTH
ARE WRITTEN EVERY TIME:

* **`<stem>.sentences.vtt`** - a cue per sentence, placed inside its chunk's
  span. The model exposes no text-to-time mapping, so a MEASURED time can only
  come from an aligner; a chunk the aligner could not place is cued
  proportionally over its own real audio and says so in the file.
* **`coverage.json`** - the audit. Text with no aligned audio is dropped or
  truncated; audio with no text is an insertion. It replaces the duration-ratio
  guard for Higgs v3, which cannot see a measured 22 % text loss.

## THE AUDIT REPORTS. IT DOES NOT BLOCK. (Owen, 2026-09-05)

> there will always be truncations or errors of some sort. thats the nature of
> tts. nothing is going to come out perfect. we try our best to detect and reduce
> the number of errors but assembly will never function, ever, if we expect it to
> come out the other side flawless. we need to base assembly on the expected text
> and the actual real length of the audio. with orpheus, for truncations, we
> split at sentence boundaries and re-rendered. but the goal is to have zero
> truncations.

Three things follow, and they are the whole design of this package now.

**The pass always audits the whole book.** A chunk that will not align is
recorded in the report's `errors` with its index and the aligner's own message,
and the pass carries on. `narrator align` exits **0** whenever the run happened,
whatever the chunks said; non-zero is reserved for a run that could not happen at
all (no session, no interpreter, a dead worker). `--continue-on-error` is
accepted and ignored - it used to opt into this and there is nothing left to opt
into.

**Every chunk gets sentence cues.** For a chunk the aligner placed they are its
word timings. For one it could not place - or one whose measured cues were
refused because a sentence had no placed word - they are laid over the chunk's
REAL audio span in proportion to each sentence's character share, and each run of
them carries a `NOTE estimated chunk <i>` block in the VTT
(`assemble/sentence_vtt.py` owns that geometry, the marker and the writer;
assembly uses the same code when there is no report at all). Nothing is invented
silently: the report names the chunk and the file says the cue is a guess.

**Assembly never refuses on coverage.** `assemble/coverage_gate.py` reads the
report, logs every failing chunk with the text the audio did not say and the
`narrator retake --indices ...` line that fixes it, and assembles the book. A
missing report is logged too and blocks nothing. What is still refused, by name,
is a report about ANOTHER book - another engine, another session, an older
render - because reporting on the wrong book is worse than reporting on none.

## What this does NOT change

`assemble/vtt.py` still writes the chunk-level `<stem>.vtt` - one cue per
rendered chunk, cue text = the chunk text, times a running sum of FLAC sample
counts. That is the contract training, the reassembly bridge and the retake UI
read as the binding between sentence index, file, text and time, and it is
untouched. The sentence file sits BESIDE it. Both are generated from the same
`assemble/vtt.chunk_spans`, which was extracted for exactly that reason, so a
sentence cue cannot fall outside its own chunk's cue (verified over kershaw's
302 sentence cues against its 133 chunk cues: 0 escapes, 0 overlaps).

Orpheus behaviour is unchanged everywhere: same 44 s sentence split, same caps,
same guards. Its coverage policy is `audited=False` - which now means only that a
narration run of that engine carries no Align row, not that its report would be
treated differently. A report that exists is read out whatever wrote it.

## 2026-09-08: the qwen3 backend

A second aligner ships as of today: **Qwen3-ForcedAligner-0.6B**, via the
`qwen_asr` package, chosen by name with `--backend qwen3`. `DEFAULT_BACKEND`
does not move - see "Why the default did not move" below.

### The bake-off that bought it

Shift (Higgs `mistborn` render, 16.56 h, RTX 3090 Ti in WSL), scored against the
exact chunk starts of **1,083 chunks** in the assembled m4b. Both arms ran on
identical 5-minute windows with identical text.

| | qwen3 | whisperx (wav2vec2) |
|---|---|---|
| speed | **395x realtime** - 151 s for the whole book | 18x realtime (first hour, same GPU) |
| chunk starts within 0.1 s | **890 / 1083** | 39 / 61 |
| chunk starts within 0.5 s | 947 / 1083 | 44 / 61 |
| boundaries over 0.5 s | - | 17, parked ~0.9 s **early** into the inter-chunk gap |

(Both scored after subtracting each chunk's own ~0.27 s of head silence.)

The 116 qwen3 misses over 1 s decompose, and the decomposition is the important
part: **59** are headings and tiny chunks whose PRINTED text differs from the
spoken words (`"2110."`, `"* Silo one *."`), **22** are prose chunks directly
after such a heading, **3** sit beside a truncated chunk, and **~32 (3 %)** are
unexplained.

The paper (arXiv 2601.21337) measures the same shape independently: accumulated
average shift **42.9 ms** against WhisperX 133 ms and NeMo 130 ms, and over 300 s
concatenations WhisperX drifts to 2.7 s where Qwen holds 53 ms.

Owen's ruling:

> lets build that in instead then ... run it as a gpu job after tts finishes ...
> as long as its faster than assembly, we can do the proper job.

### What qwen3 CANNOT see

**It has no confidence and it never refuses.** The model returns word times and
nothing else, and a window whose text does not match the speech is **PLACED, not
refused** - which is exactly what the 59 heading misses on Shift are. The tell is
not an error; it is a **boundary error over 1 s at a chunk whose printed text
differs from what was said**. Anything downstream that needs "was this window
really this text" has to look at the quality numbers below, because the aligner
will not tell it.

It also cannot see past **five minutes**: the model card places timestamps
"within up to 5 minutes", so audio longer than `QWEN3_MAX_AUDIO_S` (300 s) is
refused by name rather than truncated. Narrator chunks are <= ~90 s and the
corpus cutter windows to 5 minutes itself.

### Derived scores, and the three factors

`AlignedWord.score` is what `_spans` and `coverage.py` use to say "this word is
not credibly in the audio". Qwen publishes none. The two dishonest answers were
`None` on every word (which reads as UNPLACED everywhere, making every chunk one
enormous dropped-text span) and a flat `1.0` (which reads as certainty the model
never expressed). So the score is DERIVED from three things this package can
actually measure, multiplied together:

| factor | what it measures | 0 when |
|---|---|---|
| **a - speech presence** | the fraction of the word's span that is NOT in the chunk's silence map (`detect_silences`, already computed per chunk) | the word sits entirely inside a pause |
| **b - rate plausibility** | the word's normalized chars over its duration, against a pace: 1.0 inside `[pace/3, pace*3]`, falling linearly to 0 at `pace/6` and `pace*6` | a 0.02 s "word" of 9 characters |
| **c - order** | 1.0 when the word starts at or after the previous timed word's end less 0.05 s | the word goes backwards |

`score = a * b * c`. An UNTIMED word keeps `score = None` - the stronger signal,
and the same one whisperx gives.

**The pace** is a keyword on `align_chunk` (`pace_chars_per_sec`). When it is
None the chunk's own printed chars over its own audio seconds is used, and the
`Alignment` records which in `pace_source` (`'given'` / `'chunk'`) so nobody has
to guess. Note that a word's numerator is NORMALIZED characters while the
chunk-derived pace counts printed ones - punctuation and spaces make the two
differ by ~15-20 %, which is inside the 3x band by a wide margin.

> **THESE NUMBERS ARE FIRST ESTIMATES, NOT MEASUREMENTS.** The 3x/6x band, the
> 50 ms order slack and the plain product are chosen to be defensible, not
> because anything was measured at them. **The calibration data is the Shift
> coverage run** - 1,083 chunks with known-good chunk starts - and until that has
> been scored against these scores, a derived 0.62 does not mean what a whisperx
> 0.62 means. `engine_profiles.py`'s `min_word_score = 0.4` was calibrated on
> whisperx's CTC posterior and is NOT yet calibrated on this.

**Every document says which it is holding.** `Alignment.score_source` is a
required field with no default; it rides the worker wire (`scoreSource`, and
`alignment_from_dict` REFUSES a document without it), and it appears in
`coverage.json` twice - at the top and on every chunk. The report **version does
not move** for it: `assemble/coverage_gate.py` requires `engine`, `summary` and
`chunks` and reads nothing else structurally, so an old report still loads and a
new one still satisfies an old reader.

### The quality NOTE: what a measured cue says about itself

Every MEASURED `SentenceCue` now carries a `quality` dict, written into
`<stem>.sentences.vtt` as a `NOTE` line immediately before its cue. **This is
the contract** (`assemble/sentence_vtt.QUALITY_NOTE_KEYS`): one line, `key=value`
pairs separated by single spaces, in exactly this order.

```
NOTE quality monotonic=1 cps=14.1 pace_ratio=1.00 boundary_silence=0.32 worst=0.91 source=derived

00:03:11.480 --> 00:03:14.200
He said nothing at all.
```

| key | dict field | meaning |
|---|---|---|
| `monotonic` | `monotonic` | `1` when the cue's own words run forward AND it starts at/after the previous cue ended |
| `cps` | `chars_per_sec` | the cue's characters over its span, 1 decimal |
| `pace_ratio` | `pace_ratio` | that over the pace the alignment used; `none` for a model-scored alignment, which never measured one |
| `boundary_silence` | `boundary_silence_s` | the length of the silence-map gap the cue START sits in; `0.00` when it starts inside speech |
| `worst` | `worst_word_score` | the lowest score among the cue's words |
| `source` | `score_source` | `model` or `derived` - what `worst` means |

A `None` value is written as the literal `none`, never as a missing pair: a
reader splitting on spaces would otherwise read the next pair's value into this
field's slot. An **estimated** cue carries no quality line at all (it was never
measured) and keeps its existing `NOTE estimated chunk <i>` block; a cue that
claimed to be both is refused.

**The thresholds are the reader's, not ours.** Nothing in `align/` drops,
re-times or reclassifies a cue on a quality number. The training side that picks
alignment-clean sentences out of a book chooses where to cut.

### Languages

qwen3 takes an English language NAME, so narrator maps an ISO code to it. **This
is the whole supported list** and anything else is refused by name - the model
does not fall back to English for a language it was not trained on, it just
places the words badly:

| | | | |
|---|---|---|---|
| `en` English | `de` German | `fr` French | `es` Spanish |
| `it` Italian | `pt` Portuguese | `ru` Russian | `ja` Japanese |
| `ko` Korean | `zh` Chinese | `yue` Cantonese | |

### Installing it

```
pip install qwen-asr        # into a CUDA torch env; soundfile too
```

**darwin has a component**: `qwen-align-env`, "Qwen3 forced aligner (Apple
Silicon)", a managed conda-pack in Settings -> Add-ons
(`electron/components/qwen-align-env.ts`, landed ac36c1b6). It is separate from
`whisperx-env` on purpose - that one is CPU-BY-DESIGN and this one exists to use
the Apple GPU, and `qwen-asr` 0.0.6 pins transformers 4.57.6 and drags
gradio/flask, which have no business in a small CPU env.

**win32 has no component and cannot have one**: the env has to be a CUDA torch
env, and on this PC that means a WSL env. It is the hand-built guest env
**`qwen-align`** (`/home/telltale/anaconda3/envs/qwen-align`, verified
2026-09-08), NAMED in BookForge's `tool-paths.json` as `qwenAlignEnv` (Settings
-> Add-ons -> "Qwen3 aligner WSL env"). Absent, BookForge refuses by name and
does not guess. **`install_qwen_align.sh` is owed** - the env is built by hand
today.

Either way a qwen3 run is `--python <that env>/python`. BookForge points
`HF_HOME` at `<userData>/runtime/qwen-align-cache` so the ~1.2 GB checkpoint is
fetched once for the whole app. Device follows the same rule as whisperx: `cpu` /
`cuda` / `cuda:N` / `mps` through `check_device`, and a GPU request is refused by
name while `external-gpu-job.lock` exists. dtype is bfloat16 on cuda/mps,
float32 on cpu.

**What that env does NOT have** (measured on both machines, 2026-09-08):
`faster_whisper` and `whisperx`. That matters only to the whole-m4b door
(`electron/scripts/align_audiobook.py`), whose rough-transcript stage is
faster-whisper - it runs that stage in the whisperx env through its own
`--rough-python` and aligns in this one.

### The per-chunk gate (`run.gate_refusal`)

qwen3 never refuses, so `align_session` checks what it was handed before the
cues are accepted. A chunk that fails is recorded in the report's `errors` under
stage **`gate`** and ESTIMATED, exactly like one the aligner could not place at
all - same code path, same `NOTE estimated chunk <i>` in the VTT. Both checks
stand on the measurement's own evidence:

| check | fires when |
|---|---|
| `gate/order` | a cue's `quality['monotonic']` is False - the sentence's own words were placed backwards |
| `gate/collapse` | two cues of one chunk share a start |

**There was a third, `gate/shift`, and it is gone (2026-09-12).** It refused a
cue more than `GATE_MAX_SHIFT_S` (2.0 s) from the start the PROPORTIONAL estimate
would have given it, and shipped the estimate. Mutineer's Moon (Higgs, 966
chunks, Mac, 2026-09-12) measured it: 239 chunks refused, 2,164 of 6,215 cues
shipped as guesses, and against faster-whisper word times 21 of the 23 cues more
than a second off were those guesses (whole chunks 2-3 s late, one 4.6 s) while
the measured cues sat within half a second. The proportional guess is wrong by
more than 2 s whenever a chunk holds a pause, so the check could only fire when
the guess was wrong - and then it shipped the guess. It was removed rather than
widened; `gate_refusal(measured, *, chunk_index)` no longer takes the estimate's
inputs at all. `GATE_MAX_SHIFT_S` stays defined in `run.py` because
`electron/scripts/align_audiobook.py` imports it for the whole-book door, where
the reference is a rough transcript's word time. docs/ALIGNMENT.md has the
numbers.

**WHAT THIS DOOR CANNOT LOSE, AND WHY THE GATE IS SMALLER THAN IT SOUNDS.**
`sentences.sentence_cues` builds every cue inside the chunk's own manifest span:
the first starts at the chunk's start, the last ends at the chunk's end, and
interior seams are clamped `MIN_CUE_S` apart. So a chunk cannot be dragged onto
another chunk's audio here, and a SINGLE-SENTENCE chunk - which is what a heading
is - cannot be moved at all. The 59 heading misses the Shift bake-off found cost
this door nothing; the gate is about the INTERIOR of a multi-sentence chunk. The
door where a sentence really can land seconds away is the whole-book one, and
that is where `GATE_MAX_SHIFT_S` does its work.

### Why the default did not move

`DEFAULT_BACKEND` is still `whisperx`. An unchanged default is the contract for a
caller that names no backend, and switching it would change what "this chunk
failed coverage" means for every such caller without anybody measuring it.

**THE APP IS NOT SUCH A CALLER (2026-09-08).** Every BookForge door now says
`--backend qwen3` out loud - the post-render phase, the standalone Align row, the
CLI adapter and the whole-m4b "Generate sentences" script - so the default moving
or not is a question about `narrator align` run by hand. What is still owed is the
calibration itself: `engine_profiles.min_word_score = 0.4` was measured on
whisperx's CTC posterior and has NOT been scored against the derived numbers, so
a coverage FAILURE under qwen3 does not yet mean what one under whisperx means.
That is the audit half of the report; the transcript half is measured and gated.

### `align_text_window` - the corpus cutter's door

`align/window.py` exports ONE function, for a caller that has a window of audio
and the text it says and no session at all:

```python
align_text_window(audio, text, *, backend, language, device,
                  pace_chars_per_sec=None, sample_rate=None, ffmpeg=None) -> dict
```

`audio` is a path (decoded here through ffmpeg) or a 1-D float32 numpy array,
which MUST come with `sample_rate` and that rate must already be 16 kHz -
**nothing here resamples**, because a resampler hidden in an alignment library
would silently change the signal the timings are measured against. It returns
`{'alignment': <as_dict>, 'cues': [{'text','start','end','quality'}...],
'backend', 'score_source'}`, with cue times in the WINDOW's own seconds.

## The aligner: how WhisperX was chosen

WhisperX was the ONE aligner from 2026-09-05 to 2026-09-08 (Owen's ruling), and
it is still the default. What follows is the MEASUREMENT that chose it over
torchaudio's `forced_align`, kept because a rejected candidate with its numbers
is worth more than a sentence saying one was rejected - but the loser lives in
this table and nowhere else in the tree, and
`test_no_torchaudio_aligner_is_shipped` asserts that against the module with
its docstrings stripped.

Measured on this machine (Windows, CPU, BookForge's installed `whisperx-env`:
python 3.11.15, torch/torchaudio 2.8.0+cu128, whisperx 3.8.6), ten kershaw
chunks, 2026-09-05. Both candidates drive the SAME wav2vec2 checkpoint
(`wav2vec2_fairseq_base_ls960_asr_ls960.pth`, already in BookForge's managed
`TORCH_HOME`), so this is a comparison of two CTC aligners over one model.

| | WhisperX align | torchaudio `forced_align` |
|---|---|---|
| word start agreement (529 words) | median 0.000 s, p95 0.020 s, max 0.98 s | (same pair) |
| CPU per chunk (4.9-29.6 s chunks) | 0.30-2.59 s | 0.26-2.58 s |
| model load | 5.6 s warm / 19.5 s cold | 0.6 s |
| localizes text inside longer audio | **yes** | **no** |
| dropped-text detection | yes (tail score 0.11 median vs 0.86 control) | yes (0.000 vs 0.99) |
| API status | maintained | **deprecated in 2.8, REMOVED in 2.9** |

**The deciding measurement.** Given one chunk's text against that chunk plus the
next one concatenated (6 pairs), WhisperX ended the last word 0.42-0.94 s BEFORE
the true text end every time - the right answer, since a chunk's last word ends
before its trailing silence. torchaudio smeared the same word to 1.0-3.3 s short
of the AUDIO end every time, overshooting the true text end by 9.0-20.9 s:

| pair | audio | true text end | WhisperX | torchaudio |
|---|---|---|---|---|
| 5 | 52.74 s | 29.61 s | 28.85 s | 50.46 s |
| 10 | 45.48 s | 26.71 s | 26.07 s | 44.38 s |
| 30 | 38.14 s | 16.81 s | 16.39 s | 37.12 s |
| 40 | 42.15 s | 25.00 s | 24.09 s | 38.89 s |
| 50 | 27.14 s | 15.53 s | 14.59 s | 24.49 s |
| 70 | 29.35 s | 17.58 s | 16.69 s | 27.55 s |

Point 4's "audio with no text" is undetectable with the second behaviour - it
reports no insertion because it has claimed the insertion as text. That, plus
the deprecation, is why WhisperX ships.

**A failure is recorded, not retried.** There is no "try A then B" path and
nothing to try: `align_chunk` raises `AlignerError` naming the chunk, the run
records it under stage `align`, estimates that chunk's cues from its own audio,
and carries on to the next one. The test that guards this MAKES the one backend
fail and checks that the report names the chunk, instead of grepping the source
for a loop shape that a `try/except: run(other)` would have slipped past.

(It used to STOP there and write nothing, with `--continue-on-error` as the
opt-in sweep. On a real 50-chunk book with 5 unplaceable chunks that produced no
report, no transcript and no audiobook - see the ruling above.)

## How a coverage failure is actually detected

CTC forced alignment is MONOTONIC and TOTAL: every word gets a span whether or
not it was spoken, so "no timestamp" is not the signal. **The score is.**
Measured on kershaw chunk 20 (53 words, 19.1 s):

| case | words scoring < 0.4 | aligned ratio |
|---|---|---|
| correct text, correct audio | 2 % | 0.981 |
| one extra sentence appended (43 extra words) | 91 % of the appended run | 0.250 |
| audio truncated to 60 % | 94 % of the stranded tail | 0.415 |
| that chunk + the next under one chunk's text | 2 % | 0.981, and a 16.8 s inserted-audio span at 18.4 s (82 % speech) |

Over the whole kershaw book (132 aligned chunks, 43.6 min of audio):
aligned ratio median 1.000, p5 0.958, p1 0.933, min 0.868; **zero** dropped-text
spans and **zero** inserted-audio spans; one chunk (96, a bibliographic citation
full of spelled-out numbers) flagged on the ratio alone. So the false-positive
rate at these thresholds is 1 in 132 on real Orpheus output, and it costs
nothing there because the Orpheus policy is not enforced.

CPU cost for that book: **213.5 s of wall clock for 2,615 s of audio, RTF
0.082** - per chunk min 0.23 s, median 1.72 s, p95 2.25 s, max 2.55 s, plus one
5.6 s model load. Aligning a whole book is minutes, not hours.

## The thresholds, and where they live

`assemble/engine_profiles.py` -> `CoveragePolicy`, per engine, as DATA. They are
there and not here because ASSEMBLY is what refuses a book on them, and assembly
must not import `engine/` or `align/` - it runs on a CPU env with no torch.

| | value | why |
|---|---|---|
| `min_word_score` | 0.4 | 2 % of words in a correct chunk fall below; 91-100 % of dropped text does |
| `min_aligned_ratio` | 0.90 | p1 of correct chunks is 0.933; the flagged citation chunk was 0.868 |
| `min_uncredible_words` | 3 | a ratio is a bad instrument on a short chunk - 15 words with one weak word is already 0.933 |
| `dropped_run_words` | 6 | zero runs of 6 across 132 correct chunks; real dropped text runs to 17-33 |
| `max_dropped_spans` | 0 | point 4: text with no aligned audio is a truncation |
| `min_inserted_audio_s` | 1.0 | shorter is a breath or a codec edge |
| `max_inserted_speech_fraction` | 0.35 | a pause is silent, an inserted word is not - the silence map is what tells them apart |

`enforced` is True for `higgs-v3` and False for `orpheus`.

**OWED: a Higgs sweep.** Every number above was calibrated on ORPHEUS output -
that is where the false-positive side comes from - and the true-positive side
comes from failures built by hand out of the same audio. No Higgs v3 render has
been aligned, because none exists on this machine. Before the guard gates a real
Higgs book, align one v3 render and check that the thresholds separate its
chunks the way they separate these.

## Dropped text vs inserted audio do not overlap

A weak word still CLAIMS the audio the aligner put it on, so `inserted_audio` is
computed from every TIMED word, not only the credible ones. Counting a weak
word's seconds as "audio with no text" reported one defect twice and failed a
40-word chunk that had two weak words and no insertion at all (measured while
writing the tests). The two lists answer different questions.

## The app's door, and what is still owed there

`compat/app.py --assemble_only` - the door `reassembly-bridge.ts` and
`parallel-tts-bridge.ts` spawn - takes **`--coverage_report <path>`**, passed
straight to `assemble(coverage_report=...)` and listed in `compat/FLAGS.md` as
narrator's own flag. Both spawns pass it **whenever the report file EXISTS**,
whatever the engine: it is an audit to be read out, not a gate to be satisfied,
so the question is "did anybody measure this book" and the disk answers it.

**THE APP-SIDE STEP LANDED 2026-09-05, AND LEFT THE NARRATION RUN 2026-09-08.**
From 09-05 BookForge composed an **Align** queue row into every narration run whose
engine is audited (`coverageAuditedFor` in `shared/queue/coverage-policy.ts`, which
mirrors `audited` out of `assemble/engine_profiles.py` and is asserted against it
by `tools/test-coverage-policy-mirror.js`), and the assembly joined on it at its
tail to seal the measured transcript. Measured on Shift (mistborn, 1,313 chunks,
16.4 h): the render took 37 min, the m4b was built 8 min into assembly, and the
align took ~2 h on CPU while the assembly held the second CPU slot waiting — Owen
read that as a freeze twice and ruled: *"remove the align the narration checkbox.
lets just have it permanently do it that way [the proportional estimate]. if the
user wants an exact alignment they can hit generate sentences on the bookforge
library."*

**AND IT CAME BACK THE SAME DAY, AS A PHASE RATHER THAN A ROW** - because what
was wrong with it was the two hours, not the alignment. Owen, once the qwen3
bake-off was in: *"good. go ahead and wire it up to alignment so itll be used to
align the chunks in app"*, *"for generate-sentences logic and for normal
post-render alignment"*, and earlier *"lets build that in instead then … run it as
a gpu job after tts finishes … as long as its faster than assembly, we can do the
proper job."* It is: 151 s for Shift against an 8-minute assembly.

So the alignment is now **the final phase of the `tts-conversion` step**
(`electron/parallel-tts-bridge.ts` -> `runPostRenderAlignment`), not a queue row.
It runs after the workers are gone and BEFORE the session is copied out of WSL,
because on Windows the render writes to ext4, the `qwen-align` env is in the
guest, and the guest cannot see the network drive the session is copied to. It
never fails the render: no aligner env is an announced SKIP, a failed align is an
announced failure, and either way the book ships the proportional estimate. The
Align QUEUE ROW still exists for the CLI (`narrator align`,
`bookforge-tts --align`, `cli/coverage-align.js`) and for a queue file restored
from before 2026-09-08. Where it runs, the row REPORTS: it succeeds whenever the
run happened and puts the counts and the retake list on its card
(`tools/test-coverage-audit-reports.js`), and the assembly behind it repeats that
list once on the finished book.

**The app's doors pass `--backend qwen3`, always, and have no whisperx arm.**
`DEFAULT_BACKEND` in this package is still whisperx (below), which is narrator's
contract with a caller who names nothing; BookForge names one.

The row sits **behind the render and in front of every enhancement pass**: the
guard measures the RENDER, the thresholds below were calibrated on raw engine
output, and a truncated chunk found before an hour of RVC is worth more than the
same chunk found after it. It runs `python -m narrator.cli align --session-dir
<hash dir> --report <processDir>/coverage.json --language <lang> --device cpu
--python <whisperx env python>` in the tools env, natively on every platform
(`electron/coverage-align-job.ts`, `electron/queue-steps/align.ts`), and both
assembly spawns then pass `--coverage_report` when the file is there. It is never
skipped because a report already exists: a resume renders more chunks, and a
report written for a smaller manifest is refused by name — correctly, and an hour
too late.

`run.py` reports progress as `[align] aligned <done>/<total> chunk(s)` every ten
chunks and on the last. That wording is a **contract** with the queue row's
progress bar, pinned by `ProgressLineTest` in `tests/test_align.py`, and
`env.run_jobs` streams the worker's results (rather than waiting for the batch)
so the line can be emitted at all.

**ALSO OWED: a Higgs v3 render to align.** Every threshold above was calibrated
on ORPHEUS output for its false-positive rate and on failures built by hand for
its true-positive rate. No v3 render exists on this machine.

## Where it runs

The aligner needs torch and whisperx; narrator's own interpreters do not have
them and must not grow them (the Orpheus envs are pinned to torch 2.5.1 / vLLM
0.7.3). BookForge already ships the right one as a managed component -
`electron/components/whisperx-env.ts`, CPU-only by design, the same interpreter
`electron/scripts/align_audiobook.py` is spawned with.

* under that interpreter, `narrator align` aligns in process;
* from anywhere else, `--python <that interpreter>` spawns
  `python -m narrator.align.worker` there over a JSON-lines protocol, with
  `PYTHONPATH` pointed at this checkout so the same narrator code runs on both
  sides. Nothing is installed and nothing is copied.

An interpreter that cannot import the backend and was given no `--python`
REFUSES, naming the interpreter it found on disk. **CUDA is refused by name**
while `%APPDATA%\BookForge\external-gpu-job.lock` exists: a render or a training
run owns the card, and an aligner that costs 1.7 s a chunk on CPU is not
entitled to take it.

## What `align_audiobook.py` contributed

`electron/scripts/align_audiobook.py` aligns a whole m4b against an EPUB. This
is its per-chunk cousin and it borrows three ideas, not its shape:

* **the silence map** - windows below -45 dBFS, merged into runs. That script
  shells to ffmpeg `silencedetect` because it works on a six-hour file already
  on disk; a chunk is already in memory, so the same measurement is a strided
  RMS here. The minimum run is 0.15 s rather than 0.25 s: a seam INSIDE one
  20 s chunk routinely sits in a 0.15-0.20 s pause.
* **seam snapping** (`snap_boundaries`) - forced alignment puts a seam at the
  CTC frame where it thinks the last phone ended, a couple of hundred
  milliseconds early or late; the narrator's pause is a silence and its middle
  is the safest place to cut. Same three conservative rules: only overlapping
  silences are candidates, the target is the midpoint CLIPPED to the window, the
  nearest wins.
* **speech coverage** (`speech_coverage`) - measuring how much of a span is
  actually spoken rather than guessing from reading speed.

What it does NOT borrow: the rough Whisper transcribe pass, the coarse LIS
anchoring and the drift audit. Those exist because a whole-book alignment does
not know which text belongs to which minute. Here the manifest already says, to
the sample.

## Files

| file | what |
|---|---|
| `aligner.py` | `align_chunk`, `Alignment`/`AlignedWord`/`TextSpan`/`AudioSpan`, the two backends (whisperx, qwen3), the derived scores, audio decode, the silence map, the CUDA refusal |
| `window.py` | `align_text_window` - one window of audio + one piece of text, no session. The corpus cutter's door |
| `sentences.py` | the MEASURED cues: sentence -> word ranges, seam snapping, the per-cue `quality` dict. The cue type, the estimated cue, the quality NOTE format and the `<stem>.sentences.vtt` writer live in `assemble/sentence_vtt.py` (assembly writes that file too and may not import this package) and are re-exported here |
| `coverage.py` | `evaluate_chunk`, the report document |
| `run.py` | `narrator align`'s body: manifest -> jobs -> cues + report |
| `env.py` | finding the whisperx interpreter, and driving it |
| `worker.py` | `python -m narrator.align.worker`, the JSON-lines door |
| `../assemble/coverage_gate.py` | the ENFORCEMENT: assembly reads the report and refuses |

Tests: `python/narrator/tests/test_align.py` - a pure tier that needs no model,
and a measured tier that aligns ten real kershaw chunks plus three hand-built
failures through the installed env, skipping with the exact reason when it is
absent and FAILING when it is present but broken.
