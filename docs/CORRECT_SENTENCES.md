# Correct Sentences

Regenerate individual TTS sentences that sound wrong, audition a few fresh takes in
context, approve one, and reassemble — without re-rendering the whole book.

## Why it works: stochastic sampling

TTS generation in the e2a fork is **not** deterministic. Orpheus sets no seed and samples
at `temperature 0.6 / top_p 0.8 / rep_penalty 1.1`; XTTS samples at `temperature 0.75` and
never re-seeds per sentence. So re-running the *same* sentence produces a **genuinely
different reading** every time — different prosody, pacing, emphasis. "Regenerate" needs no
special mode; a plain re-roll is the different take, and it often fixes the exact glitch
(a swallowed word, bad emphasis, a clip) that made a sentence sound off.

## The pipeline (3 phases, in the main Studio window)

```
Studio "Correct Sentences" button (only when a cache + e2a VTT exist)
   │
   ├─ Phase 1  Listen      play cached per-sentence FLACs in order, flag the bad ones
   ├─ Phase 2  Review      per flagged sentence: audition [Original + 3 new] in context,
   │                       pick or re-roll; approve → swaps into the cache; loop
   └─ Phase 3  Assemble    reuse the existing reassembly job → new M4B + corrected VTT
```

Analysis-free, reuse-heavy: candidates come from the real e2a worker, and re-stitching is
the existing `reassembly` job.

## Gate

The feature is offered (a "🔧 Correct Sentences" button on the Versions panel's "Rendered
sentences" row, next to Assemble/Delete) only for books that went through e2a, which produces:
- a per-sentence FLAC cache using the **new numeric `{i}.flac`** naming, and
- a `session-state.json` with **`chapter_sentences`** — the per-chapter sentence-text list the
  worker flattens to `all_sentences`, whose ordinal is the same as `{i}.flac`.

The sentence **text** shown in the UI comes from `chapter_sentences` (SML tokens like `[break]`
stripped for display; the worker still feeds the raw text to TTS on regeneration). NOT the e2a
VTT: that is created at assembly time, **embedded into the output M4B** as a subtitle track, and
**moved out** of `processDir` — so it is not a reliable sidecar (real assembled books have no
`.vtt` in `processDir`). Playback needs no VTT timings — Phase 1 sequences the FLACs directly.

No cache / no `chapter_sentences` / legacy `sentence_{i}.flac` naming → no availability. Both
cache layouts (`ebook-{uuid}/chapters/…` and `ebook-{uuid}/{hash}/chapters/…`) are handled.

## Backend

### e2a worker change (`worker.py`, `bookforge_ext/parallel/worker_core.py`)

Added two additive flags:
- `--sentence_indices "5,40,120"` — a discrete, possibly-scattered index list that overrides
  the contiguous `--sentence_start/--sentence_end` range. Both the batched (Orpheus MLX/vLLM)
  and serial (XTTS) generation paths iterate this list.
- `--num_takes N` — generate each target sentence `N` times in **one model load**, writing
  each take to a `take{k}/` subdir of `--sentences_dir` (so same-index files don't collide).
  Orpheus batches all `(index × take)` prompts together. Because sampling is unseeded, every
  take is a different reading — validated: three takes of the same sentence, one load, three
  distinct md5s.

Both are purely additive: with the flags absent (`num_takes` defaults to 1, no subdir), book
renders behave byte-for-byte as before. Combined with `--sentences_dir` pointing at a scratch
dir, this regenerates just the flagged sentences (all takes) into a throwaway location without
touching the live cache, in a single warm model load.

Because generation flows through the normal worker path, each candidate FLAC is written by
e2a's own `_save_audio` — the **same** peak-normalize-to-0.95 and deterministic
`_classify_gap` inter-clip gaps a normal render applies. The sentence *text* and its gap
classification are read from the session's own `session-state.json`, so nothing drifts from
the original render except the (intentionally fresh) sampling.

### The bridge (`electron/correct-sentences-bridge.ts`)

- `getCorrectSentencesSession(projectDir)` — locate the cache (`getBfpCachedSession`), parse
  the e2a VTT into index-keyed cues, read the full `ParallelTtsSettings` from
  `session_state.json`, detect the book's FLAC `sample_fmt`, and gate.
- `generateCandidates({projectDir, indices, takes})` — run
  `parallel-tts-bridge.regenerateSentenceIndices` once per take into scratch `take{k}/` dirs
  under `userData/correct-sentences/{sessionId}/`. **Every candidate is transcoded to the
  book's `sample_fmt`** (see below). Returns `[original, take0, take1, take2]` per index.
- `commitSentence({projectDir, index, sourceFlacPath})` — back the original up once to
  `sentences/.orig-backup/{i}.flac`, match the chosen candidate to the book's `sample_fmt`,
  and atomically swap it into the cache. Picking "Original" is a no-op.
- `revertSentence` / `cleanupCandidates`.

`regenerateSentenceIndices` (added to `parallel-tts-bridge.ts`) reuses the exact same worker
arg/env assembly as `startWorker` — voice/model resolution (`pushVoiceArgs`), device, and
the audio-affecting Orpheus env (voice caps, `ORPHEUS_SENTENCE_GAP`, any temperature/top-p
overrides). It does **not** go through the GPU arbiter (batch-size/cache are memory knobs,
not audio content), so don't run it concurrently with a full book render on the same GPU.

### The bit-depth drop-in fix (validated 2026-07-14)

Older books were rendered at **16-bit** FLAC; current e2a emits **24-bit**. Chapter assembly
concatenates the per-sentence FLACs with `ffmpeg -c:a flac`, which **cannot switch bit depth
mid-stream** — a mixed-depth concat fails with `switching bps mid-stream is not supported`
and **silently drops** the offending sentence (the output is short by exactly that clip).

So a regenerated sentence must match the book's *existing* per-sentence bit depth, not
whatever the current engine emits. `getCorrectSentencesSession` probes the book's
`sample_fmt` from an existing `{i}.flac`; every candidate is transcoded to it
(`ffmpeg -c:a flac -sample_fmt <fmt> -ar 24000 -ac 1`). This is lossless flac→flac — only the
quantization changes; the waveform, normalization, and gaps are preserved. Verified: a
16-bit-matched candidate concatenates cleanly at full duration.

## IPC

`correct-sentences:get-session | generate-candidates | cancel | commit | revert | cleanup`,
with progress on `correct-sentences:progress`. Exposed via `window.electron.correctSentences.*`
(preload) and `ElectronService.correctSentences*` (renderer). Candidate/original audio is
loaded for playback through the existing `readAudioFile` → data-URL path.

## Notes / follow-ups

- **Latency**: all takes for a generate/re-roll are produced in **one** model load via
  `--num_takes` (~15s load + a few s/sentence on M1 Ultra MLX). A re-roll of one sentence is
  one load for its 3 fresh takes.
- **Windows/vLLM**: regeneration skips GPU-arbiter VRAM sizing; fine for a small ad-hoc
  batch, but revisit if run alongside heavy concurrent GPU work.
- **XTTS custom voices** must resolve the same way the original render staged them
  (`ensureCustomVoiceStaged`) — the worker path does, since it reuses `pushVoiceArgs`.
