# bookforge-tts — headless CLI for BookForge's real TTS pipeline

Run TTS jobs **through BookForge's actual compiled pipeline** from the command line,
without launching the app. Nothing is reimplemented: the CLI drives the real
`dist/electron` modules, so it inherits every guard unchanged — the WSL wedge-proofing
(TERM → verify → `wsl -t` kill ladder, never-SIGKILL a guest GPU proc, wedge latch),
the vLLM `gpu_memory_utilization` memory tiers + safe GPU sizing, and custom-model
resolution.

BookForge must be **built** (`dist/electron` present) but **need not be running**.

## Build first

The batch path uses a function compiled into `parallel-tts-bridge.js`. After any pull or
electron/*.ts change:

```
npx tsc -p tsconfig.electron.json
```

## Two render paths

| `--mode`      | Path | What it exercises |
|---------------|------|-------------------|
| `tts` (default) | audiobook / batch — `parallel-tts-bridge → renderRangeHeadless → e2a prep packs ~300-char chunks → worker.py` | **the path shipped in the app** |
| `streaming`   | Listen — `orpheus-worker-pool → orpheus_stream.py`, one sentence per vLLM sequence, no packing | the phone/Listen path |

In `tts` mode the per-sentence FLACs (with their inter-clip gaps already baked in by
`orpheus.py _save_audio`) are concatenated in numeric order — byte-faithful to what e2a
assembly produces, because e2a assembly is itself a pure ffmpeg concat.

## Usage

```
# Default (audiobook/batch) — the path you actually use:
python cli/bookforge-tts.py --tts --voice rohan --input passage.txt --out sample.wav

# Force a memory tier and a custom gap:
python cli/bookforge-tts.py --tts --voice rohan --input passage.txt --out sample.wav \
    --tier fast --sentence-gap 0.75 --keep-sentences

# Streaming path instead:
python cli/bookforge-tts.py --tts --mode streaming --voice rohan --text "Hello." --out s.wav

# See exactly what would run, touch no GPU:
python cli/bookforge-tts.py --tts --voice rohan --text "Hi." --out s.wav --dry-run
```

## Flags

**Job**
- `--voice <id>` — a voice in BookForge `models.json`, or a model folder name (required).
- `--input <file>` / `--text <str>` — what to render (one required).
- `--out <file.wav>` — output WAV (required).
- `--language <code>` — default `en`.
- `--mode {tts,streaming}` — render path; default `tts`.

**Customization**
- `--tier {auto,extreme,fast,moderate,light}` — force the GPU memory tier
  (env `ORPHEUS_MEMORY_TIER`; default auto, safe-sized to free VRAM). Works in both modes.
- `--sentence-gap <sec>` — deterministic inter-clip gap on the **tts** path
  (env `ORPHEUS_SENTENCE_GAP`; default 0.6). Forwarded into the WSL worker.
- `--model-dir <path>` — explicit model directory, bypassing `models.json` resolution.
  Use the spawn target's namespace (a `/home/...` WSL path, or a `\\wsl$` / `C:\` path
  the bridge will translate). *Not needed for a registered voice like `rohan`.*
- `--max-chars <n>` — Orpheus packing cap in chars (env `ORPHEUS_MAX_CHARS`, read at prep by
  `core.py`; default **350**, ear-validated on the EOS-safe ≤20s/2048 voices — better prosody,
  0 guard trips). 450 silently truncates on every model; `ORPHEUS_MAX_SENTENCES` re-imposes a
  per-chunk sentence cap for a voice that trips the guards (off by default).
- `--temperature <t>` / `--top-p <p>` / `--rep-penalty <r>` / `--min-p <m>` — Orpheus
  sampling overrides (envs `ORPHEUS_TEMPERATURE`/`ORPHEUS_TOP_P`/`ORPHEUS_REP_PENALTY`/
  `ORPHEUS_MIN_P`; defaults 0.6/0.8/1.1/0-off, forwarded into the WSL worker). Higher
  temperature = livelier prosody but more runaway risk — the token-cap and chars/sec
  guards catch and log trips. min_p cuts the rare-junk tail (vLLM + MLX batch paths).
- `--models-dir <path>` — where custom models are discovered (env `BOOKFORGE_ORPHEUS_MODELS_DIR`).
- `--orpheus-install <path>` — the **native-path** e2a install (env `EBOOK2AUDIOBOOK_PATH`; a
  set-but-missing path errors). NOTE: for Orpheus-via-WSL the executing code is the WSL copy
  configured in `tool-paths.json` (`wslE2aPath`) — this flag does NOT repoint the WSL worker.
- `--conda-env <name>` — the WSL Orpheus conda env (env `WSL_ORPHEUS_CONDA_ENV`; default `orpheus_tts`).

**Output / control**
- `--keep-sentences` — tts path: also copy the per-sentence FLACs to `<out>.sentences/`.
- `--keep-session` — tts path: keep the scratch session dirs (default: both the WSL and
  Windows copies are deleted after a successful concat, so runs don't balloon the vhdx).
- `--dry-run` — print the resolved spawn + env overrides and exit; no GPU.
- **Ctrl+C is safe**: the adapters trap SIGINT/SIGTERM and tear down through the real
  pipeline (wedge-safe WSL worker kill-ladder for TTS; job abort + llama-server stop for AI).
- **One render at a time**: the GPU arbiter is per-process — don't run two CLI TTS renders
  (or a CLI render alongside an app render) concurrently. The clear-guest gate catches
  sequential overlap, but two simultaneous starts can double-book VRAM.

## AI cleanup / simplify (`--ai-cleanup`, `--ai-simplify`)

Drive BookForge's real AI pipeline (`aiBridge.cleanupEpub`) on an epub — same 8000-char
chunking, per-provider prompts, `num_ctx`/`think:false`/`keep_alive`/temperature,
[SKIP]/truncation/copyright/repetition safeguards, and the `cleaned.diff.json` +
`cleanup-progress.json` checkpoint outputs. **Simplify is the same call** with
`simplifyForChildren` + a mode. Input is an **epub**; output is `cleaned.epub` /
`simplified.epub` in `--output-dir` (default: alongside the input).

```
# Cleanup an epub with a cloud provider (key from ANTHROPIC_API_KEY):
python cli/bookforge-tts.py --ai-cleanup --input book.epub --provider claude \
    --model claude-sonnet-4-5 --output-dir ./out

# Simplify for learners (also cleans, by default); Ollama, local model:
python cli/bookforge-tts.py --ai-simplify --input book.epub --provider ollama \
    --model cogito:14b --simplify-mode learner

# Simplify ONLY (skip the cleanup pass), first 3 chunks as a test:
python cli/bookforge-tts.py --ai-simplify --input book.epub --provider claude \
    --model claude-sonnet-4-5 --simplify-mode dejargon --no-cleanup --test-mode --test-chunks 3
```

- `--provider {claude,openai,ollama,local}` — required. Cloud (claude/openai) runs
  **off-GPU** so it's safe alongside a TTS render; ollama/local use the GPU.
- `--model <name>` — the AI model (required for cloud; ollama defaults `cogito:14b`; local
  resolves its own active model).
- `--api-key <key>` — cloud key; else `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env. Passed to
  the pipeline via the process env, never argv.
- `--output-dir <dir>` — where `cleaned.epub`/`simplified.epub` lands.
- `--simplify-mode {dejargon,destiffen,learner}` — required for `--ai-simplify`
  (academic de-jargon / de-stiffen translated prose / B1–B2 learner rewrite).
- `--no-cleanup` — `--ai-simplify` only: simplify without the OCR-cleanup pass.
- `--custom-instructions <str>` — extra instructions appended to the prompt.
- `--detailed-cleanup` — enable the app's detailed-cleanup pass (`useDetailedCleanup`).
- `--cleanup-prompt <file>` — file whose contents REPLACE the default cleanup prompt.
- `--ollama-url <url>` — remote/alternate Ollama (env `OLLAMA_BASE_URL`; default localhost:11434).
- `--parallel-workers <n>` / `--no-parallel` — cloud can parallelize chunks; ollama/local
  are always sequential.
- `--test-mode` / `--test-chunks <n>` — process only the first N chunks (default 5).
  `--test-chunks` without `--test-mode` errors (never silently ignored).

## Sentence generation (`--generate-sentences`)

Audio → sentence-level **VTT** through the app's real machinery. Two modes:

| Mode | How | Text quality |
|---|---|---|
| **whisper** (default) | faster-whisper transcription (`transcribe_audiobook.py`, bundled e2a env, GPU-arbitrated `--device auto`) | words inferred from audio — ASR spelling errors possible |
| **epub-align** (`--epub` given) | ebook text is GROUND TRUTH; WhisperX forced alignment supplies only timing (`align_audiobook.py`, CPU-only whisperx-env) | the book's own words with real audio timings — what training datasets and read-along want |

```
# Transcribe an audiobook:
python cli/bookforge-tts.py --generate-sentences --audio book.m4b --out book.vtt \
    --whisper-model small [--device cpu] [--language en]

# Link epub source to audio (book-as-truth):
python cli/bookforge-tts.py --generate-sentences --audio book.m4b --epub book.epub --out book.vtt

# Also seal the VTT into the m4b as a verified mov_text subtitle track (the app's embed-only model):
python cli/bookforge-tts.py --generate-sentences --audio book.m4b --epub book.epub --out book.vtt --embed

# Also write a coverage report (epub-align only) — where do book and audio DIVERGE:
python cli/bookforge-tts.py --generate-sentences --audio part2.mp3 --epub book.epub --out part2.vtt \
    --report                       # -> part2.coverage.json (or --report path.json)
```

- `--whisper-model {tiny,base,small,medium,large-v3,distil-large-v3}` — whisper mode only
  (default `small`); the model auto-downloads to the app's whisper-models cache on first use.
- `--device {auto,cpu,cuda}` — whisper mode only (epub-align is CPU-only by design; it can
  run alongside a GPU TTS render).
- `--embed` — requires `.m4b`; uses the app's embed (+read-back verify) with all its ffmpeg
  gotchas handled (ms timescale, brand restore, atomic rename).
- The whisper engine overlay and models install/download automatically on first use, same
  as the app; the WhisperX env must be installed once via Settings → Add-ons (or
  `WHISPERX_ENV_PATH`).
- Partial alignment failures are reported as WARNINGs (failed slices ≈ audio with no
  anchor; failed chunks fall back to coarse timing) — never silently.
- `--report [path]` — **epub-align only**: also write a coverage JSON mapping where the
  epub and the audio diverge. Default path `<out minus .vtt>.coverage.json`. Two lists,
  each entry carrying text + timestamp **anchors** (not full book text) so you can search
  the epub / seek the audio to the exact boundary:
  - `epubNotInAudio` — maximal runs of consecutive sentences the narrator never read
    (`reason`: `head` / `interior` / `tail`), with the run's first/last sentence and the
    nearest narrated neighbor on each side (text + audio timestamp). This is how you find
    where "part 2 of 5" actually begins and ends in the book.
  - `audioNotInEpub` — audio ranges ≥30 s with no epub match (ads, intros, disc breaks),
    with timestamps, the surrounding epub sentences, and the **whisper transcript of
    what's actually spoken there** — i.e. the ad copy itself, for a book split across
    files with GraphicAudio-style inserts.
  A console digest of both lists prints after the run; the JSON has everything.
  Note: `interior` runs of 1-2 sentences are usually headings, not content.
  - `driftSelfCheck` — the aligner's post-alignment audit: every cue it could
    unambiguously re-find in the rough transcript is compared against that audio-truth
    time (`checkedCues`, median/p95/max |offset|), and cues off by more than 3 s are
    snapped to the audio (`correctedCues` + the `corrected` list with before/after
    timestamps). Drift through music bridges / recap montages is corrected where
    provable and VISIBLE here where not — a high max with 0 corrections means
    repeated text blocked the fix (check those regions by ear).
- `--min-hole <sec>` — **epub-align only**: minimum unmatched-audio duration treated as a
  hole (default 30). Drives BOTH the report's `audioNotInEpub` entries and whisper-fallback
  cue filling — the same concept, audio the ebook doesn't cover. `--min-hole 0` catches
  EVERY positive gap and fills each with whisper cues (maximal ad-hunting; expect noise —
  sub-second slack between cues registers too, though slivers <0.5 s have no transcript
  segments to fill with).

## Gotchas

- **Git Bash mangles `/home/...` args.** MSYS rewrites a Unix-style path passed to a
  Windows `python.exe` into `C:/Program Files/Git/home/...`. Pass WSL paths (e.g.
  `--model-dir /home/...`) from **PowerShell or cmd**, or prefix the Git Bash command
  with `MSYS_NO_PATHCONV=1`.
- **Don't run while the GPU is busy** (a training run, another render). The pipeline's
  VRAM preflight will wait or abort with a message, but co-residency can still crash a
  training job. Free the GPU first.

## Extending

`COMMANDS` in `bookforge-tts.py` is a registry — one entry per job (`tts`, `ai-cleanup`).
Add a `cmd_*` handler and a registry line; a `--<name>` selector flag is generated
automatically. Engine adapters live beside it (`orpheus-batch-render.js`,
`orpheus-render.js`) and load under `electron-stub.js`, which shims the tiny Electron
surface the pipeline touches — if a module reaches an unstubbed API it throws loudly
naming it, which is the signal to add exactly that (no blanket catch-all, no fallbacks).
