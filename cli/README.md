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
  `core.py`; default **200**). Shorter chunks terminate more reliably: at ~300 this fine-tune
  ran away on ~half of packed chunks; 200 cut that to ~1/22 and 3.2× faster with identical audio.
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
