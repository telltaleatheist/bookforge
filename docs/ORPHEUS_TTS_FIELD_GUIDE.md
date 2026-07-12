# Orpheus / e2a TTS System — Field Guide

How the TTS system works end-to-end, and where to look when it misbehaves.
Written 2026-07-12 after a full-system bug hunt; file:line references are
accurate as of that date. Companion doc: `docs/TTS_API.md` (WebSocket protocol),
`docs/ORPHEUS_SETUP.md` (install).

---

## 1. Which code is actually running? (the three copies)

There are up to **three copies** of the e2a fork on a machine. The first
debugging question is always *which one executed*:

| Copy | Path | When it runs |
|---|---|---|
| Dev checkout | `~/Projects/ebook2audiobook-latest` | `npm run electron:dev` (resolved by `tool-paths.ts` candidate search, `electron/tool-paths.ts:292`) |
| Staged snapshot | `BookForgeApp/resources/e2a/` | Copied into packaged builds. Refreshed **only** by `node packaging/stage-resources.js` — it does NOT track the checkout automatically |
| Runtime copy | `~/Library/Application Support/BookForge/runtime/e2a/` | Packaged app at runtime (unpacked from resources on first run) |

Resolution order: tool-paths config file → `EBOOK2AUDIOBOOK_PATH` env →
candidate search. `orpheus_stream.py` resolves independently
(`electron/scripts/orpheus_stream.py:68-88`): env var → cwd (the spawner cd's
into the e2a root) → `~/ebook2audiobook*` fallbacks.

**Drift check** (run when a fix "doesn't take"):

```bash
diff -rq ~/Projects/ebook2audiobook-latest/lib \
  "~/Library/Application Support/BookForge/runtime/e2a/lib" | grep -v pyc
```

A second drift axis: `electron/scripts/orpheus_stream.py` lives in
**BookForgeApp**, but calls methods on the fork's `Orpheus` class. A change to
either side can strand the other — this exact failure shipped in commit
`667e51f` (stream script calling `_guard_truncation`, which was never added to
the fork). When touching the streaming path, grep both repos for every
`orph.<method>` the script calls and verify signatures match.

---

## 2. The three execution paths

### 2a. Parallel audiobook path (the main one)

```
queue.service.ts ─▶ main.ts IPC ─▶ parallel-tts-bridge.ts
    └ spawns:  worker.py --sentences_dir … --fine_tuned … [--orpheus_model_dir …]
                  └ bookforge_ext/parallel/worker_core.py   (chunk loop)
                       └ lib/classes/tts_engines/orpheus.py (convert_batch)
```

- **Prep** happens once per job: `session.py prep_ebook_info()` →
  `lib/core.py get_chapters()` → `filter_chapter()` per spine doc → sentence
  store under `--sentences_dir` (single authoritative store; index-keyed files).
- **Workers claim chunk ranges** computed centrally by the Electron scheduler —
  there is *no locking* in Python; disjointness is the scheduler's contract.
  Orpheus = 1 worker always; XTTS = 2-4.
- **Engine batching** lives only in this path (`worker_core.py:361` →
  `convert_sentences_batch`). MLX batch width comes from the memory tier
  (§5). Sentences are packed 2-3 per generation chunk; chunk gap fixed 0.75 s.
- **Output**: per-sentence FLACs → chapter FLACs → session cached to
  `{project}/stages/03-tts/sessions/{lang}/ebook-{uuid}/` by
  `cacheSessionToProject()`.
- **Env assembly** (tiers, cache limits, WSL routing) happens in
  `parallel-tts-bridge.ts`; voice/model args in `pushVoiceArgs()`
  (`parallel-tts-bridge.ts:135`).

### 2b. Streaming path (Listen / reader / Chrome extension)

```
WS client ─▶ tts-api-server.ts (:8766) / reader-stream-bridge.ts
    ─▶ stream-scheduler.ts / streaming-engine.ts
    ─▶ orpheus-worker-pool.ts  ── JSON-lines stdin/stdout ──▶
         electron/scripts/orpheus_stream.py   (persistent worker)
              └ imports fork's Orpheus class directly;
                batch render via _generate_mlx_batch_audio (in-memory, no files)
```

- One persistent Python worker, one voice at a time (**worker-global** —
  per-request voice settings are dropped at `orpheus-worker-pool.ts:704`).
- Audio wire format: raw PCM **int16 @ 24 kHz**, base64 in JSON lines.
- Protocol has **no request IDs** — correctness depends on strictly one
  pending request per worker. A timeout that abandons a request while Python
  is still rendering desyncs everything after it (open bug, §8).
- Pool state to know: `worker`, `currentVoice`, `pendingRequest`,
  `pendingBatch`, 10-min idle teardown, `serviceMode` (pin engine resident).
- The stdout reader ignores any line not starting with `{`
  (`orpheus-worker-pool.ts:424`) — that's why library prints don't corrupt
  the protocol.

### 2c. Sequential legacy path (avoid for Orpheus)

`tts-bridge.ts startConversion()` → `app.py --headless`. **No Orpheus plumbing
at all**: no `--orpheus_model_dir`, no memory-tier env, no WSL routing, no
batching (single-sentence ≈ 6 sent/min vs 27-29 batched). As of 2026-07-12
the LL wizard still routes non-XTTS bilingual TTS rows here
(`ll-wizard.component.ts:5259`, `useParallel: ttsEngine === 'xtts'`) — that's
an open bug. Anything Orpheus should go through 2a.

---

## 3. Text → audio: the data pipeline

### Sentence preparation (`lib/core.py`)

1. `get_chapters()` iterates the EPUB spine; `filter_chapter()` per doc parses
   XHTML → tuples → normalized text → sentence list.
2. **Sharp edge**: `filter_chapter` returns `None` (not `[]`) for "no word
   chars", "no tuples", or any exception — and `get_chapters` does **`break`**
   on `None` (`core.py:798`), silently dropping every later doc. Skip
   conditions return `[]` and are safe. (Open bug, §8.)
3. Sentence passes merge/pack text; SML tags (`[pause]`, `[break]`,
   `[pause:N]`) are escaped to `__SML_n__` placeholders early — anything
   splitting on SML tokens must run *before* `escape_sml()` (the
   `sentence_per_paragraph` lesson).
4. `sentence_per_paragraph` mode: each `<p>` = one sentence (bilingual EPUBs).

### The Orpheus engine (`lib/classes/tts_engines/orpheus.py`)

**Backends**: MLX (Mac, primary), vLLM (CUDA/WSL), transformers (slow
fallback). Selected via `ORPHEUS_BACKEND` or auto.

**Token pipeline** (both LLM backends):

```
prompt = voice-token + text (+ SOA 128259 / SOS 128257 for fine-tuned voices)
  → LLM generates audio tokens (7 tokens = 1 SNAC frame)
  → parse_output(): crop at LAST SOS across prompt+generated, strip EOA 128258,
                    trim to multiple of 7
  → decode_audio_from_codes() → SNAC vocoder → float32 mono 24 kHz
```

**Key constants** (top of file): `MLX_MAX_TOKENS` = 3700 (env-overridable;
~450-char packed chunk needs 2500-3400 tokens), `SAMPLE_RATE` 24000,
gap tiers via `_classify_gap()` — sentence 0.55-0.75 s / paragraph / section
1.0-1.6 s.

**Cap-hit ladders** (what happens when generation hits max_tokens):

- vLLM: `_generate_audio_vllm_safe` — render whole, split at sentence
  boundaries *only if unfinished*. The good pattern.
- MLX: `_generate_mlx_safe` (`:638`) — **splits eagerly** for any text
  ≥ 80 chars (open bug: shatters prosody; should mirror vLLM).
- Batch: `_convert_mlx_batch` detects cap rows (`len >= MLX_MAX_TOKENS`,
  verified correct against mlx_lm 0.30.5 semantics) and re-renders via the
  safe path.

**Validation asymmetry to remember**: the vLLM decode validates SNAC slot
positions (`_redistribute_codes` → `TokenStreamMisaligned` → one re-render);
the **MLX path has no slot validation** — malformed streams decode to garbage
or become 0.1 s silence marked success (open bug, §8).

**Model/voice cache**: process-global (`loaded_tts`), keyed so custom-model
dir switches reload. Voice resolution: `self.models` manifest map → lowercase
→ `VALID_VOICES` allowlist → **unknown voices silently fall back to
`leah`** (`orpheus.py:219-224`) with only a printed warning. Every "whole book
in the wrong voice" report traces to some path reaching this line — grep logs
for `Unknown Orpheus voice`.

**Memory model (MLX, measured Jul 2026)**: ~6.9 GB weights + 0.153 GB per
batch slot; freed-buffer cache bounded by `mx.set_cache_limit`
(`ORPHEUS_MLX_CACHE_LIMIT_GB`, default 8) set once at engine load. Steady ~15
GB, peak ~22 GB at B=96. Batch knee is 96; 128 is slower.

### Session / worker layer (`bookforge_ext/parallel/`)

- `session_state.json` written once at prep. Sentence files are
  **index-keyed and overwritten** → resume can't duplicate audio by
  construction.
- Resume gates: Python `scan_completed_sentences` requires size > **1024
  bytes**; the Electron completeness gate
  (`parallel-tts-bridge.ts:~1677`) is **existence-only**. These disagree —
  legit silence-only FLACs are 122-230 bytes (torchaudio), so Python calls
  them missing forever while Electron passes truncated garbage. Both gates
  have open bugs (§8).
- Cooperative shutdown: SIGTERM → handler raises SystemExit → in-flight
  chunk outputs deleted (`worker_core.py:457-472`) so resume re-renders them.
  SIGKILL skips all of that (partial-file bug, §8).
- Audio saves go **directly to the final filename** — no temp+rename
  anywhere in the engines. Any non-cooperative death can leave a truncated
  FLAC that passes both gates.

---

## 4. Custom voices / model management

- Models live in `~/Library/Application Support/BookForge/runtime/orpheus-models/`
  (shared-assets aware), one folder per voice; **folder = model, manifest
  token = prompt voice**. `models.json` is the manifest
  (`electron/orpheus-models.ts`): `{id, dir, voice (prompt token), label, source}`.
- Discovery contract: a folder is a model if it has `config.json` + ≥1
  top-level `.safetensors` (`orpheus-models.ts:155`). Real models are
  **multi-shard** (owen: 5 GB + 1.6 GB) — mere presence ≠ complete.
  `model.safetensors.index.json` lists required shards; nothing checks it
  today (open bug: partial downloads discovered as installed voices).
- Download: `orpheus-hf-catalog.ts` → `orpheus_download.py`
  (`snapshot_download` straight into the live dir — no staging).
  Catalog source: HF tag `bookforge-orpheus-voice`, token from README
  `orpheus_token`.
- Arg flow: `resolveOrpheusModel(id)` → `--orpheus_model_dir <dir>
  --fine_tuned <token>` (`pushVoiceArgs`, `parallel-tts-bridge.ts:135`).
  If resolution returns null, the batch path currently degrades to bare
  `--fine_tuned <id>` → leah (open bug). The streaming path refuses instead
  (`orpheus-worker-pool.ts:498-507`) — that's the model to copy.

---

## 5. Config plumbing: who sets what

Memory tiers: `electron/orpheus-memory.ts`. MLX tiers (measured):
extreme 96/8 GB, fast 72/8 GB, moderate 48/6 GB, light 24/3 GB
(batchSize/cacheLimitGB); auto-bands ≥60 GB RAM → extreme, ≥44 → fast,
≥28 → moderate. Windows tiers guard the 16-19 GB WDDM-spill band.

| Env var | Set by app? | Read at (fork) | Default | Notes |
|---|---|---|---|---|
| `ORPHEUS_BATCH_SIZE` | yes (tier) | worker batch width | tier | darwin honors override |
| `ORPHEUS_MLX_CACHE_LIMIT_GB` | yes (tier) | engine load | 8 | `mx.set_cache_limit` |
| `ORPHEUS_GPU_MEM_UTIL` | yes (Win tier) | `orpheus.py:498` | **0.70** | 0.70 of a 24 GB card = crash band; never spawn without it on Windows |
| `ORPHEUS_DISABLE_EAGER` / `FORCE_EAGER` | yes / no | vLLM init | — | |
| `ORPHEUS_MLX_MAX_TOKENS` | **no** | `orpheus.py:141` | 3700 | fork default governs everywhere |
| `ORPHEUS_MLX_BUCKET_RATIO` | no | batch bucketing | — | manual tuning |
| `ORPHEUS_TEMPERATURE/TOP_P/REP_PENALTY` | no | sampling | 0.6/… | manual tuning |
| `ORPHEUS_SENTENCE/PARAGRAPH/SECTION_GAP` | no | `_classify_gap` | 0.55-0.75/…/1.0-1.6 | manual tuning |
| `ORPHEUS_STREAM_BATCH` | yes | `orpheus_stream.py` | 4 | streaming batch width |
| `E2A_TMP_DIR` | yes | `lib/conf.py` | `<e2a>/tmp` | scratch on library volume |

WSL: only `parallel-tts-bridge.ts`'s `spawnWithWslSupport` routes through
wsl.exe; `forwardKeys` (`parallel-tts-bridge.ts:1082`) controls which env vars
cross the boundary — an env var that works on Mac can silently not exist
inside WSL if it's not in that list.

---

## 6. Where the logs are

| What | Where |
|---|---|
| Parallel TTS worker stdout/stderr | `~/Library/Logs/BookForge/worker-output.log` (truncated each start; Windows: `%APPDATA%/BookForge/logs/`) |
| Streaming worker | Electron main-process console, prefixed `[Orpheus Pool]` / `[Orpheus Pool stderr]`; non-JSON stdout logged as `Non-JSON output:` |
| e2a engine prints | same streams as above (engine prints per sentence, cap-hit counts, `Unknown Orpheus voice` warnings, bucket errors) |
| Session state | `<e2a scratch>/tmp/ebook-{uuid}/session_state.json`, then cached under `{project}/stages/03-tts/sessions/{lang}/` |
| Bench data | `~/Projects/ebook2audiobook-latest/bench_results*.log` + `bench_orpheus_mlx.py` |

---

## 7. Debugging playbook — signature → likely cause

| Symptom | First check |
|---|---|
| Streaming: every sentence fails / no audio | Main console for Python traceback in `[Orpheus Pool stderr]`. Verify every `orph.<method>` in `orpheus_stream.py` exists in the fork's `orpheus.py` **with matching signature** |
| Streaming: "Model not loaded" forever | Stale `currentVoice` after a worker crash (close handler doesn't reset it; `loadVoice` short-circuits). Workaround: switch voices or restart |
| Whole book/track in leah | `grep "Unknown Orpheus voice" worker-output.log`. Then find which path sent a bare `--fine_tuned`: sequential tts-bridge path? `resolveOrpheusModel` returned null (dir moved/unmounted/partial download)? |
| Sentences missing from finished audiobook (silent gaps) | `find <session>/sentences -size -1k` — 0.1 s silence files mark failed generations shipped as success. Also check prep truncation: chapter count in session vs EPUB spine count |
| Book ends early / back half missing | `filter_chapter` returned `None` mid-spine → `get_chapters` break. Look for `No valid text found!` / `filter_chapter() error` in the log, then check which spine doc |
| Audio clipped mid-sentence | Token cap. Count cap-hit lines in log; check the path used the 3700 cap (`convert()` single path historically stuck at 2048) |
| Wrong audio under wrong sentence (streaming) | Timeout desync — look for a generation-timeout line followed by misordered `batch_item`s; protocol has no request IDs |
| Voices flip-flopping mid-article | Two concurrent streaming sessions with different voices sharing the worker-global voice |
| Machine-freezing VRAM spill (Windows) | Spawn env missing `ORPHEUS_GPU_MEM_UTIL` → 0.70 default. Which bridge spawned it? |
| Huge memory / zombie after stop | `ps aux | grep orpheus_stream` — Mac kill path sends one SIGTERM with no SIGKILL escalation; a wedged MLX worker survives |
| Fix applied but behavior unchanged | Wrong copy of the fork executing — run the drift check in §1 |

**Useful one-liners**

```bash
# malformed/silence sentence files in a session
find "<session>/sentences" -name '*.flac' -size -1k -o -name '*.wav' -size -1k

# actual duration of a suspect sentence
ffprobe -v error -show_entries format=duration -of csv=p=0 <file>

# what env an e2a worker actually got
ps eww <pid> | tr ' ' '\n' | grep ORPHEUS_

# is the stream worker alive and how fat
ps aux | grep -E 'orpheus_stream|worker.py' | grep -v grep
```

---

## 8. Invariants to check when hunting (lessons from the 2026-07-12 hunt)

The recurring failure pattern in this system is **failure converted into
success**. When auditing any path, ask:

1. **Can a generation failure become silence-marked-success?** Every
   `np.zeros(...)` fallback and every `except: continue` inside a render loop
   is suspect. The file existing is not evidence the audio is real.
2. **Can a voice/model resolution failure become a default voice?** Any path
   that ends in bare `--fine_tuned <something unvalidated>` hits the leah
   fallback. Fail loudly instead (the streaming path shows how).
3. **Can a prep failure become a shorter book?** `None` vs `[]` returns in
   `core.py`; any `break` in a spine/chapter loop.
4. **Do both sides of a cross-repo call actually exist?** `orpheus_stream.py`
   ↔ `orpheus.py` methods; app env vars ↔ fork `os.environ` reads; WSL
   `forwardKeys` ↔ vars vLLM needs.
5. **Do all the gates agree?** Electron existence-gate vs Python 1024-byte
   gate vs what the engines legitimately write (122-byte silence FLACs).
6. **Is the write atomic?** Engines write final filenames directly; anything
   that can die uncooperatively (SIGKILL, jetsam, ENOSPC on ExFAT) leaves
   plausible-looking partial files.
7. **Does crash-state fully reset?** `currentVoice` survived worker death;
   check every module-global against the `close`/error handlers.
8. **Sibling paths drift.** MLX vs vLLM safe ladders, streaming vs audiobook
   guards, bilingual.py vs core.py ffmpeg escaping — a fix landed on one
   backend/path tends to be missing on the sibling. Diff the siblings
   whenever one of them gets a fix.

### Bug ledger from the 2026-07-12 hunt (status as of the evening pass)

Two sessions fixed items in parallel on Jul 12: this one, and a second session
whose fork commits (`15ce3d418..fd9e2397d` + in-flight edits to `core.py`,
`bilingual.py`, `worker_core.py`, `device_installer.py`) independently
implemented the truncation guard and a no-fallbacks sweep. Verify a row's
current state in code before acting on it.

| Sev | Bug | Where | Status |
|---|---|---|---|
| CRIT | `_guard_truncation` didn't exist → streaming 100% dead since 667e51f | `orpheus_stream.py` ↔ `orpheus.py` | **FIXED Jul 12** (fork `15ce3d418`/`b0fff2673` added guard + `force_split`; verified end-to-end over the real stream protocol) |
| CRIT | `get_chapters` breaks on `None` → silent back-of-book truncation | `core.py:798` | check second session's in-flight core.py work before re-fixing |
| HIGH | MLX shipped fabricated 0.1 s silence as success (solo + batch) | `orpheus.py` | **FIXED Jul 12** (fork `fd9e2397d` no-fallbacks + empty-not-fabricated in `_generate_mlx`/`_convert_mlx_batch`; guard re-renders empties once, then `_save_audio` fails the row) |
| HIGH | `convert()` MLX single path stuck at 2048-token cap | `orpheus.py` | **FIXED Jul 12** (bare `_generate_mlx` calls now default to `MLX_MAX_TOKENS`) |
| HIGH | LL wizard → sequential path for Orpheus (leah, no tiers, no WSL, no batching) | `ll-wizard.component.ts:5259`, `tts-bridge.ts:338` | open |
| HIGH | `pushVoiceArgs` null-resolve → bare `--fine_tuned` → leah | `parallel-tts-bridge.ts` | **FIXED Jul 12** (unresolvable non-stock voice now throws, mirroring the streaming path's refusal) |
| HIGH | Voice download unstaged; partial folders discovered as installed voices | `orpheus_download.py:27`, `orpheus-models.ts:155` | open |
| HIGH | Stale `currentVoice` after worker crash → permanent "Model not loaded" | `orpheus-worker-pool.ts` | **FIXED Jul 12** (close handler resets it) |
| HIGH | No request IDs in stream protocol → timeout desync misroutes audio | `orpheus-worker-pool.ts` | open |
| HIGH | No temp+rename on audio saves; partial FLACs pass gates | `orpheus.py`, `xtts.py` | open |
| MED | `_generate_mlx_safe` splits eagerly (primary path for streamed openers) | `orpheus.py:638` | open (eager split is CORRECT as the guard's retake path; the issue is only streaming-solo using it as primary) |
| MED | Worker-global voice + concurrent sessions = voice flapping | pool + both WS bridges | open |
| MED | SML-only sentences lose classified section/paragraph gap | `orpheus.py` | likely addressed by second session's gap redesign (`_classify_gap` → lead/trail invariant, `d5fb9979f`) — verify |
| MED | Settings batch-size knob dead on mainstream paths | `parallel-tts-bridge.ts:2675`, `orpheus-batch.ts` | open |
| MED | 1024-byte gate vs 122-230-byte legit silence FLACs (resume never converges) | `session.py:136`, `worker_core.py:390` | open |
| MED | Apostrophe-unescaped ffmpeg concat in core assembly (fixed only in bilingual.py) | `core.py:2206,2484,2506` | open |
| MED | `_generate_mlx` kept only last GenerationResult (newline text lost leading segments) | `orpheus.py` | **FIXED Jul 12** (segments accumulated) |
| MED | VTT misaligned for non-prefix chapter selections; dual-voice pair-count off-by-one | `session.py:801`, `bilingual.py:577` | open — check second session's bilingual.py work first |
| LOW | Stock-model `__del__` over-evicts global cache; stdin EPIPE unhandled; no SIGKILL escalation on Mac; SIGTERM print reentrancy; chapter-range silent no-op; streaming lowercases custom ids | various | open |

Streaming truncation guard details (post-fix): `_guard_truncation(index, clean,
audio, resplit)` in the fork, chars/sec threshold `ORPHEUS_MAX_CHARS_PER_SEC`
(default 19.0, measured; healthy prose ~15, p90 ~17), rate check applies above
150 chars; empty audio for non-empty text always gets one re-render regardless
of length. vLLM retakes must pass `force_split=True`; MLX retakes use
`_generate_mlx_safe` as-is.
