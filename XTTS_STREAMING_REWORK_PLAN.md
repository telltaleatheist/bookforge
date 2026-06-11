# XTTS Streaming Rework Plan

Status: **IMPLEMENTED June 11 2026** (Phases 0-3 + cleanup; Phase 4 disk cache
deferred). What shipped:

- `electron/scripts/xtts_stream.py` — thread pinning via `XTTS_THREADS`, raw
  PCM16 protocol (no WAV framing), `inference_stream()` chunked generation
  with between-chunk `cancel`, gc every 50 generations instead of per sentence.
- `electron/xtts-worker-pool.ts` — 4 workers x 4 threads (pinned via env),
  chunk/done response routing, `generateSentenceStream()` (priority worker
  acquisition), FIFO worker-wait queue replacing the polling race.
- `electron/stream-scheduler.ts` (NEW) — main-process orchestration: streams
  the playhead sentence, batches lookahead, 45s seconds-based window driven by
  renderer playhead reports, requestId staleness, broadcasts `stream:event`
  to all windows (listen-window friendly).
- `audio-player.service.ts` — rewritten: PCM16 ingestion, sample-accurate
  back-to-back `source.start(when)` scheduling (no onended chaining), starts
  when first sentence completes (or sooner if generation outpaces realtime,
  e.g. CUDA), 8s headroom rebuild after underrun.
- `play-view.component.ts` — generation loops replaced by scheduler IPC.
- Deleted dead `xtts-streaming-bridge.ts` and the legacy per-sentence
  `play:generate-sentence` IPC path.
- Protocol verified end-to-end against the live worker (batch, stream,
  cancel, post-cancel health): first streamed chunk at **1.6s**.
- **Post-ship fix (June 11):** first real-world run played ~10 sentences in
  5 minutes then stalled. Cause: `acquireWorker()` had an `await` between
  finding a free worker and reserving it, so the scheduler's synchronous
  4-dispatch loop piled all 4 requests onto worker 0 (responses cross-routed,
  workers 1-3 idle). Fixed with `runOnFreeWorker()` — reservation is now
  synchronous, waiters are handed workers synchronously, and a busy-worker
  dispatch guard logs `BUG:` if it ever regresses. Verified with a node
  integration harness (`/tmp/test_scheduler_e2e.js`, mocked electron module,
  real scheduler + pool + 4 python workers): 15/15 sentences, first chunk
  1.9s, 54.6s audio in 29.4s wall = **1.86x realtime aggregate**.

## Phase 0 results (measured on the M1 Ultra, June 11 2026)

- **`inference_stream()` was broken by a version mismatch, now FIXED**: env had
  coqui-tts 0.27.2 + transformers 4.57.6; streaming support for transformers
  ≥ 4.57 landed in coqui-tts 0.27.3. Upgraded env to **0.27.5** (matches e2a's
  own requirements.txt pin; only coqui-tts + new dep ko-speech-tools changed,
  torch/transformers untouched; pre-existing pip-check conflicts unrelated).
  Streaming now works: **first chunk at 2.9s**, ~0.93s audio per chunk.
- Streaming costs ~37% more compute than batch inference (RTF 3.75 vs 2.74 at
  16 threads) → use it for the playhead/first sentence only, not for lookahead.
- **Thread scaling is flat-to-negative**: RTF 2.74 @ 16 threads, 2.65 @ 8,
  2.47 @ 4. XTTS GPT decode is sequential; 4 threads per worker is optimal.
- **Multi-worker contention is negligible when pinned**: 4 simultaneous
  workers × 4 threads each → RTF ~1.9 PER WORKER (better than solo, likely
  scheduler/bandwidth effects). Aggregate ≈ **2.1× realtime** — comfortably
  gapless. (2 × 8 threads gave only 0.70× aggregate; more workers with fewer
  threads wins decisively.)
- Hardware: M1 Ultra, 16 P-cores + 4 E-cores.
- **Recommended pool config: 4 workers × 4 threads (`torch.set_num_threads(4)`
  + `OMP_NUM_THREADS=4`), streaming on the playhead sentence, batch inference
  for lookahead.**
- Bench scripts: `/tmp/xtts_stream_test.py`, `/tmp/xtts_bench.py` (recreate from
  git history of this plan if needed).

Context: streaming UI is moving to a dedicated player window in parallel work —
this plan deliberately moves all scheduling logic OUT of the renderer component
so the window move doesn't conflict with it.

## Current architecture (what actually happens today)

```
play-view.component.ts          (renderer)
  - hardcodes NUM_WORKERS=3, BUFFER_AHEAD=10, BUFFER_BEFORE_PLAY=4
  - runs 3 async loops, each awaiting playGenerateSentence() over IPC
  - reorders results, enqueues into AudioPlayerService
        │ IPC play:generate-sentence
xtts-worker-pool.ts             (main process)
  - spawns 3 python processes, round-robins sentences across them
xtts_stream.py                  (one per worker, conda env)
  - loads fine-tuned XTTS model on CPU
  - calls tts.inference()  ← FULL-SENTENCE BLOCKING, NOT STREAMING
  - gc.collect() + empty_cache() TWICE per sentence
  - returns whole WAV as one base64 JSON line
AudioPlayerService              (renderer)
  - decodes WAV → AudioBuffer queue
  - plays via onended-callback chaining
```

`xtts-streaming-bridge.ts` is **dead code** — main.ts only wires `xtts-worker-pool.ts`.

## Findings (why there's a ~10s gap between sentences)

1. **Nothing streams.** `xtts_stream.py` ignores the `stream: true` flag and calls
   `tts.inference()` — the full sentence must finish generating (~10–11s on CPU)
   before a single byte of audio exists. The comment claims `inference_stream()`
   "has compatibility issues with transformers" — that was true for old coqui,
   but the env now has `coqui-tts==0.27.5` (idiap fork) + `transformers==4.57.6`,
   and the idiap fork fixed streaming for modern transformers. **Likely stale; must re-test.**

2. **Throughput is below realtime, so gaps are mathematically inevitable.**
   ~11s of compute produces ~5–7s of audio (RTF ≈ 1.5–2). One worker can never
   keep up. Three workers *should* give roughly realtime aggregate…

3. **…but the 3 workers almost certainly fight each other for CPU cores.**
   Each PyTorch process defaults to `num_threads = all physical cores`. Three
   processes × all cores = massive oversubscription; each sentence takes ~3×
   longer, so aggregate throughput collapses back to ≈ 1 sentence per ~10s.
   That is exactly the observed symptom. Neither `xtts_stream.py` nor the pool
   sets `torch.set_num_threads()` / `OMP_NUM_THREADS`. **This is the #1 suspect.**

4. **Per-sentence GC thrash.** `_cleanup_memory()` (gc.collect + empty_cache) runs
   twice per sentence. With a 2GB+ heap, gc.collect() alone can cost 100–500ms/call.

5. **Underrun recovery is 1-deep.** AudioPlayer resumes the moment ONE sentence
   arrives, immediately underruns again → "play 5s, gap 10s, play 5s…" loop.
   Buffering is count-based (4 sentences) instead of seconds-based, and there's
   no headroom rebuild after an underrun.

6. **Small joints between sentences.** Playback chains via `onended` callback
   (tens of ms gap + main-thread jitter) instead of sample-accurate
   `source.start(when)` scheduling. Not the 10s problem, but audible.

7. **No cancellation.** A generate request can't be interrupted; on seek/voice
   change the old request blocks a worker for up to a full sentence.

8. **No cache.** Re-listening to the same sentence regenerates it from scratch.

9. Duplication: `NUM_WORKERS` hardcoded in both renderer and pool; voice list
   duplicated in dead bridge; two bridges implementing the same protocol.

## Target architecture

```
Renderer (player window)                Main process
┌──────────────────────────┐   IPC    ┌─────────────────────────────┐
│ Player UI                │ ──text──▶│ StreamScheduler (NEW)       │
│ StreamAudioService (NEW) │ ◀─chunks─│  - owns sentence queue      │
│  - Web Audio scheduled   │  events  │  - duration-based buffering │
│    start(when), gapless  │          │  - cancellation by genId    │
│  - seconds-based buffer  │          │  - disk cache               │
└──────────────────────────┘          │ xtts-worker-pool            │
                                      │  - N thread-pinned workers  │
                                      │  - worker 0: chunk streaming│
                                      └─────────────────────────────┘
```

Key decision: **the scheduler moves from play-view.component.ts into the main
process.** Any window (main app or the new player window) just sends "play
chapter X from sentence Y" and subscribes to ordered audio events. This makes
the player-window migration trivial and survives renderer reloads (the pool
already broadcasts to all windows).

## Phases

### Phase 0 — Measure (half a day, do first)
- Add timing logs to `xtts_stream.py` (gen wall time, audio duration → RTF)
  and to the pool (per-worker overlap, queue depth over time).
- Bench matrix on the Mac: workers ∈ {1, 2, 3} × threads-per-worker ∈
  {all, cores/N}. One chapter, fixed voice. Record aggregate sentences/min.
- Decide optimal worker count from data, not vibes. (Plausible outcome on an
  M-series: 2 workers × pinned threads beats 3 × unpinned by 2–3×.)

### Phase 1 — Throughput fixes (the actual lag killer)
- Pass `OMP_NUM_THREADS` / `MKL_NUM_THREADS` env per worker from the pool and
  call `torch.set_num_threads(n)` in `xtts_stream.py`, n = floor(perf_cores / NUM_WORKERS).
- Stop calling `_cleanup_memory()` per sentence — run it on idle (no request
  for 30s) or every ~50 sentences. CPU-only inference doesn't leak per call.
- Make NUM_WORKERS configurable in one place (pool), exposed to renderer via
  session-start response; delete the renderer's hardcoded copy.
- Exit criterion: aggregate generation ≥ 1.3× realtime on the Mac.

### Phase 2 — True streaming (time-to-first-audio)
- Re-test `inference_stream()` under coqui-tts 0.27.5 / transformers 4.57.6.
- Worker protocol gains chunked responses:
  `{type:'chunk', genId, seq, data, sampleRate}` … `{type:'done', genId, duration}`.
  Raw PCM16 base64 per chunk (skip WAV header; renderer builds AudioBuffer directly).
- The pool streams chunks straight through to the renderer as they arrive.
- Result: first audio in ~1–2s instead of ~10s; seeks feel instant.
- Fallback: if streaming is genuinely broken, keep `inference()` but split
  sentences at clause boundaries (~100 chars) to shrink the latency quantum.
- `enable_text_splitting=False` stays — we control splitting.

### Phase 3 — Scheduler + gapless playback
- New `StreamScheduler` in main process (absorbs the logic currently in
  `generateAndPlay()`): task queue, in-order release, refill, per-request
  `genId` so stale results from seeks/voice-switches are dropped, `cancel`
  command in the python protocol (checked between chunks).
- Buffering policy in **seconds, not sentence counts**, driven by measured RTF:
  - start playback when `bufferedSec ≥ 4` (or first streamed chunk if Phase 2 lands)
  - after an underrun, rebuild to `bufferedSec ≥ 10` before resuming
  - keep generating until `bufferedSec ≥ 45` ahead of the playhead, then pause workers
- New `StreamAudioService` in renderer: schedule each AudioBuffer with
  `source.start(when)` on the AudioContext clock, queue next buffer ≥ 200ms
  before the current one ends. Sentence-highlight events derive from the same
  clock. Replaces the onended chain in `AudioPlayerService`.

### Phase 4 — Sentence cache
- Cache finished sentence audio to `{library}/cache/stream/{voiceHash}/{textHash}.pcm`
  (key: text + voice + speed + temperature/top_p/penalty).
- Scheduler checks cache before dispatching to a worker → replay, jump-back,
  and re-opening a book become instant; second listen of a chapter is free.
- Simple LRU cap (e.g. 2GB).

### Phase 5 — Cleanup
- Delete `xtts-streaming-bridge.ts` (dead).
- Single voice-discovery source (python `ready` message, already the case in the pool).
- Keep idle-shutdown + broadcast work from the current uncommitted diff.

## Notes / constraints
- CPU stays the right device for XTTS on Mac (see CLAUDE.md gotchas — MPS is
  memory pressure for zero speedup). On the Windows/CUDA machine the same code
  picks CUDA and Phase 2 streaming will shine there (RTF << 1).
- Orpheus is not in scope here, but if XTTS CPU throughput can't beat realtime
  even after Phase 1, the honest fallback is "pause-to-buffer with progress UI",
  not more workers.
- Protocol stays JSON-lines over stdio; chunk sizes (~0.5–1s PCM ≈ 32–64KB
  base64) are fine for stdout.
