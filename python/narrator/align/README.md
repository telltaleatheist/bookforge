# `narrator/align` - post-render forced alignment

Points 3 and 4 of `docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points"
(Owen, approved 2026-09-05), built 2026-09-05.

```
narrator align --session-dir <hash dir> [--out sentences.vtt] [--report coverage.json]
               [--backend whisperx|torchaudio] [--language en] [--device cpu]
               [--python <whisperx env python>] [--indices 3,4,5] [--ffmpeg PATH]
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

## The aligner: WhisperX ships, and it is the only one in the package

ONE ALIGNER SHIPS (Owen's ruling, 2026-09-05). There is no `--backend` flag,
no second implementation in `align/`, and nothing to switch to. What follows
is the MEASUREMENT that chose it, kept because a rejected candidate with its
numbers is worth more than a sentence saying one was rejected - but the loser
lives in this table and nowhere else in the tree, and
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
library."* So no narration run composes this row any more; the only doors left are
the CLI (`narrator align`, `bookforge-tts --align`) and a queue file restored from
before that date. Where it does run, the row REPORTS: it succeeds whenever the
run happened and puts the counts and the retake list on its card
(`tools/test-coverage-audit-reports.js`), and the assembly behind it repeats that
list once on the finished book.

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
| `aligner.py` | `align_chunk`, `Alignment`/`AlignedWord`/`TextSpan`/`AudioSpan`, the two backends, audio decode, the silence map, the CUDA refusal |
| `sentences.py` | the MEASURED cues: sentence -> word ranges, seam snapping. The cue type, the estimated cue and the `<stem>.sentences.vtt` writer live in `assemble/sentence_vtt.py` (assembly writes that file too and may not import this package) and are re-exported here |
| `coverage.py` | `evaluate_chunk`, the report document |
| `run.py` | `narrator align`'s body: manifest -> jobs -> cues + report |
| `env.py` | finding the whisperx interpreter, and driving it |
| `worker.py` | `python -m narrator.align.worker`, the JSON-lines door |
| `../assemble/coverage_gate.py` | the ENFORCEMENT: assembly reads the report and refuses |

Tests: `python/narrator/tests/test_align.py` - a pure tier that needs no model,
and a measured tier that aligns ten real kershaw chunks plus three hand-built
failures through the installed env, skipping with the exact reason when it is
absent and FAILING when it is present but broken.
