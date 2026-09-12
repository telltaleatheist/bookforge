# Forced alignment in BookForge

Two doors align text to audio, they use the same aligner as of **2026-09-08**, and
this is where the wiring lives. The aligner itself, its scores and its refusals
are `python/narrator/align/README.md`; this file is the app side — which door runs
where, why the post-render phase sits where it sits, what the gate is, and what
BookForge refuses to do.

## The ruling

Owen, 2026-09-08 (via the Mac, verbatim):

> good. go ahead and wire it up to alignment so itll be used to align the chunks
> in app

> for generate-sentences logic and for normal post-render alignment

and earlier, when the bake-off numbers came in:

> lets build that in instead then … run it as a gpu job after tts finishes … as
> long as its faster than assembly, we can do the proper job.

It is faster than assembly: **151 s** of qwen3 for Shift's 16.56 h, against an
8-minute assembly. The WhisperX row this replaces took **two hours** on CPU and
was the reason Owen deleted the Align checkbox earlier the same day (cd1678d7).

## The numbers that bought it

**PC** — RTX 3090 Ti in WSL, cuda bf16. Shift (Higgs `mistborn` render, 16.56 h),
scored against the exact chunk starts of **1,083 chunks** in the assembled m4b,
each chunk's own ~0.27 s of head silence subtracted:

| | qwen3 | whisperx (wav2vec2) |
|---|---|---|
| speed | **395x realtime** | 18x realtime, same GPU |
| starts within 0.1 s | **890 / 1083** | 39 / 61 |
| behaviour at a miss | places it anyway | parks ~0.9 s **early** in the gap |

The 116 qwen3 misses over 1 s decompose as **59** headings and tiny chunks whose
printed text differs from the spoken words (`"2110."`, `"* Silo one *."`), **22**
prose chunks directly after such a heading, **3** beside a truncated chunk, and
~32 unexplained.

**Mac** — M-series, mps bf16, the same session's first hour, 61 chunk starts:

| | qwen3 | whisperx (CPU) |
|---|---|---|
| speed | **87x realtime** | 20x realtime |
| starts within 0.1 s | **51 / 61** | 43 / 61 |
| gross misses > 2 s | **5** | 0 (max 1.5 s) |

The five: three CONSECUTIVE tiny chunks at 1857.5 / 1859.1 / 1861.1 s all
predicted at **1855.43** (collapsed onto one position), one at 1195.6 (+3.5 s),
one at 2393.6 (−7.8 s).

So: qwen3 is **more precise where it places, and 4–20x faster**, and it has a
gross-miss mode on tiny/heading windows that whisperx does not — because it has
no confidence and never refuses. That is what the gate is for.

## Door 1 — post-render alignment (the tail of the TTS step)

`electron/parallel-tts-bridge.ts` → `runPostRenderAlignment` →
`electron/coverage-align-job.ts` → `narrator align --backend qwen3`.

It runs **as the final phase of `tts-conversion`**, not as a queue row. Nothing
composes an Align row into a narration run any more (Owen removed that checkbox on
2026-09-08); this is a phase inside the step that already owns the GPU lane, so it
waits for no card and claims no slot.

### Where it sits, and why exactly there

```
workers finish ─► [ALIGN] ─► cacheSessionToProject ─► normalizeWslSessionToWindows ─► RVC ─► assembly
                    ▲            (copy out of WSL)        (copy out of WSL)
                    │
        the session is still on ext4, beside the qwen env
```

Three facts pin it:

* **The card is free.** The serving process the render owned is gone with the
  workers, so a second model can load.
* **The session is still in the guest.** On this PC the render runs inside WSL
  with the session on ext4, the `qwen-align` env is IN the guest, and **the guest
  cannot see the Z: network drive the session is copied to afterwards** (WSL has
  no `/mnt` for a network drive). Aligning after the copy would mean aligning
  something the aligner cannot open.
* **Its outputs are session files.** `coverage.json` and
  `<stem>.sentences.vtt` are written into the process dir, so writing them BEFORE
  the two copies is what carries them onto the Windows path the native assembly
  reads. Written after, they would sit on ext4 where nothing downstream looks.

On the Mac the render is native and this runs natively in the same place in the
sequence. Nothing about the ordering is Windows-specific except the reason.

The cost of being first is that the durable resume checkpoint is a couple of
minutes later than it was. That is the right trade at 151 s a book and would not
be at two hours — which is the measurement that moved the backend.

### On Windows the whole spawn crosses into the guest

`qwen-asr` needs a CUDA torch env, so its interpreter is a `/home/...` path a
Windows process cannot execute. `narrator-spawn.ts` grew one field for this —
`wslCondaEnv`, a guest conda env NAME — and `buildNarratorSpawn` runs narrator's
half inside the guest too, translating every path in the argv. The `align` phase
still names no ENGINE: naming one would resolve the Mac's `narrator-mlx` env,
which has no aligner in it.

### It never fails the render. Three outcomes, all announced

| outcome | what the row says | what ships |
|---|---|---|
| no qwen env | "Chunk alignment skipped: …" plus the setting to fill in | the audiobook, with the **estimated** transcript |
| align failed (bad device, dead worker, unreadable path) | "Chunk alignment failed …: \<reason\>" | the audiobook, with the estimated transcript |
| it ran | "\<n\> aligned, \<n\> failed coverage, \<n\> could not be placed — retake: …" | the audiobook, with the **measured** transcript |

The skip is the ONE allowed skip in this path and it is stated, never silent. The
estimate is `assemble/run.py`'s: `if coverage is None: write_estimated_sentence_vtt`
— expected text over each chunk's real audio, every cue carrying a
`NOTE estimated chunk <i>` block. It never overwrites a measured file.

**There is no whisperx fallback anywhere.** The two backends do not score words on
the same scale (`Alignment.score_source`: `model` vs `derived`), so quietly using
the other one would ship a different measurement under the same label.

The CLI render door (`cli/bookforge-tts.py --tts` →
`cli/orpheus-audiobook-render.js` → `renderRangeHeadless`) gets this phase for
free: it drives the same `checkAllWorkersComplete`.

## Door 2 — Generate sentences (whole m4b against the EPUB)

`electron/whisperx-align-bridge.ts` → `electron/scripts/align_audiobook.py
--backend qwen3`.

**TWO INTERPRETERS, both named, neither guessed.** Measured on both machines,
2026-09-08: the `qwen-align` env has `qwen_asr` / `torch` / `soundfile` / `numpy`
and does **not** have `faster_whisper` or `whisperx`. So:

* the SCRIPT runs under the **qwen-align** env — that is where the per-chunk
  forced alignment happens;
* the ROUGH TRANSCRIPT stage (faster-whisper) is delegated to the **whisperx-env**
  component with the script's new `--rough-python`, which spawns it as a child,
  forwards its STAGE/PROGRESS lines so the bridge's bars still move, and reads the
  transcript back through `--transcribe-only`'s JSON.

The delegated child runs on **cpu**, stated: the whisperx-env component is
CPU-only by design and `WhisperModel(device="cuda")` would hand a ctranslate2 with
no CUDA libraries a device it cannot use.

`--backend` defaults to `whisperx` in the script, so anyone running it by hand
gets exactly the behaviour it has always had. The app states `qwen3`.

### KNOWN GAP: this door refuses on Windows-with-a-WSL-qwen-env

The per-chunk door can cross into the guest because what it reads was written
there. This one reads an **m4b and an EPUB out of the library**, which on this PC
is the titan share on **Z:**, and WSL has no `/mnt` for a network drive. So the
bridge refuses BY NAME rather than handing the guest a path it cannot open
halfway through a 40-minute transcribe. What unblocks it is a **native** CUDA
qwen env on Windows named as `qwenAlignEnv` — which is also what
`install_qwen_align.sh` is owed for. On the Mac (the `qwen-align-env` component,
native) the door works.

## The gate

qwen3 places a window whose text does not match the speech rather than refusing
it, and it publishes no confidence to catch that with. Each door therefore checks
what it was handed — and the two doors check against DIFFERENT references,
because they have different ones available.

**Per-chunk door** (`run.gate_refusal`): a chunk whose measured cues fail is
recorded in the report's `errors` under stage **`gate`** and estimated through the
same path as one the aligner could not place — so the failure is named and the
transcript says the cue is a guess. Both checks stand on the measurement's own
evidence:

| check | fires when |
|---|---|
| `gate/order` | the sentence's own words were placed backwards (`quality['monotonic']` is False) |
| `gate/collapse` | two cues of one chunk share a start |

That gate is **smaller than it sounds, and the reason is worth knowing**:
`sentence_cues` already builds every cue inside the chunk's own manifest span, so
a chunk cannot be dragged onto another chunk's audio and a single-sentence chunk —
which is what a heading is — cannot be moved at all. The 59 heading misses cost
that door nothing; the gate is about the interior of a multi-sentence chunk.
`gate/collapse` is unreachable under today's seam arithmetic and is kept as an
invariant so a future change cannot reintroduce it silently.

**The `gate/shift` check this door HAD, and why it is gone (2026-09-12).** From
2026-09-08 to 2026-09-11 the per-chunk door also refused any cue whose start sat
more than `GATE_MAX_SHIFT_S` from its PROPORTIONAL start — the character-share
estimate from `assemble/sentence_vtt.proportional_cues` — and shipped that
estimate for the whole chunk. Mutineer's Moon (Higgs `deathstalker`, 966 chunks,
10.2 h, rendered on the Mac 2026-09-12 with the chapter-gap fix in) measured what
that does:

| | |
|---|---|
| chunks the shift check refused | **239 of 966** |
| cues shipped as the proportional guess | **2,164 of 6,215** (35 %) |
| cues > 1 s off, against faster-whisper word times over 16 windows | 23 of 109 |
| …of which were the guess, not the measurement | **21** |
| measured cues, typical offset | −0.2 to −0.4 s (whisper's own onset bias) |
| worst guess | 4.6 s; whole chunks 2–3 s late in runs |

The proportional guess is off by more than 2 s whenever a chunk holds a pause or
reads unevenly — which a Higgs chunk often does (see the hole guard in
`engine/higgs/truncation.py`) — and the check could only fire when the guess
disagreed with the measurement. So every fire replaced a measurement with the
very guess it had just been tested against, and the transcript the player
followed was a third guesses. Owen's report was "text alignment is completely
wrong" on a book whose measurements were within half a second. A check whose
reference is worse than what it judges cannot improve the file; it was removed
rather than widened, and `gate_refusal` now takes the cues and the chunk index
and nothing else, so the estimate's inputs cannot find their way back in.

**`GATE_MAX_SHIFT_S = 2.0`** stays in `python/narrator/align/run.py`, imported by
`align_audiobook.py` rather than restated, because the WHOLE-BOOK door still
gates on it — against a rough transcript's word time, which is a measurement,
not a character share. The number came from the Mac data above: the real misses
were +3.5 / −7.8 s and collapses of 2.1–5.7 s, while every well-placed prose
chunk sat within 1.5 s. It was chosen for that comparison and is now used only
there.

**Whole-book door**, where a sentence really can land seconds away:

* most of the shift gate was ALREADY THERE — the whisper-authority pass,
  `WV_TRUST_S = 1.0`, which reverts a directly-matched sentence onto the rough
  transcript's word time when wav2vec2 disagrees by more than a second. It is
  stricter than 2.0 s and it was measured on real books; it is not duplicated.
* what qwen3 needed added is the population that pass cannot see: an
  **interpolated** sentence (no direct transcript match, so no spoken time to
  check against) whose alignment lands further than `GATE_MAX_SHIFT_S` from its
  coarse anchor is reverted onto that anchor and tagged `matched=suspect`, using
  the existing NOTE vocabulary. `drift_audit` skips the same population — it needs
  three tokens and an unambiguous trigram — which is exactly the short/heading
  windows qwen3 gets wrong.
* and a **collapse** check per align chunk: a sentence placed at or before the one
  accepted before it, inside one chunk, is rejected back to coarse timing. That is
  the Mac's 1855.43 case and it needs no threshold.

Both additions are **qwen3-only**. `--backend whisperx` is byte-for-byte what it
was.

## Where the environment is named

| | darwin | win32 |
|---|---|---|
| what | a native conda PREFIX | a WSL conda env NAME |
| normally | the `qwen-align-env` component (Settings → Add-ons) | the `qwenAlignEnv` setting |
| override | `qwenAlignEnv` in `tool-paths.json` | — (there is nothing else) |
| absent | refuses by name, points at the add-on | refuses by name; `install_qwen_align.sh` is owed |

`electron/qwen-aligner.ts` is the ONE resolver, for both doors — a second copy of
the ladder is a second answer, and the copy is the one that goes stale. It reads
the component's own `detect` block rather than restating its candidate list.

`HF_HOME` → `<userData>/runtime/qwen-align-cache`, created by whichever door
spawns, so the ~1.2 GB `Qwen3-ForcedAligner-0.6B` checkpoint is fetched once for
the whole app. The component DECLARES that variable and sets nothing; the doors
are where it is set.

## Still owed

* **`install_qwen_align.sh`** — the PC's guest env is built by hand.
* **A native Windows qwen env**, which is what would let door 2 run on the PC.
* **Calibrating the coverage thresholds on derived scores.**
  `assemble/engine_profiles.min_word_score = 0.4` was measured on whisperx's CTC
  posterior. A coverage FAILURE under qwen3 does not yet mean what one under
  whisperx means. The Shift run (1,083 chunks with known-good starts) is the
  calibration data.
* **A first real in-app run of either door on qwen3.** Everything above is
  compiled, unit-tested against fakes and reasoned from measurements taken with
  the aligner driven by hand. Nothing here has rendered a book yet.
