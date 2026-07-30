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
`orpheus.py _save_audio`) are concatenated in numeric order into a **bare WAV** — good
for a quick voice test, but it has no chapters, cover, or metadata. For the **full
audiobook** the app actually ships (`.m4b` with chapters/cover/metadata), use
`--audiobook` (below), which chains TTS **and** reassembly.

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

## Full audiobook (M4B) — `--audiobook`

The app-faithful end-to-end path. It chains the **exact two high-level calls the app's
queue makes** for a standard audiobook — no pipeline logic is reimplemented:

1. `renderRangeHeadless()` (`parallel-tts-bridge`) — the tts-conversion core.
2. `startReassembly()` (`reassembly-bridge`) — the reassembly job: e2a `--assemble_only`
   → `<project>/output/<Title>. <Author>.m4b` (+ `.vtt`) with chapters, cover, and
   metadata, and registers the audiobook in the project manifest.

So this is the real headless test of the shipped audiobook pipeline. The input EPUB is
resolved from the project like the app's "Latest" (translated → cleaned → exported →
original); override with `--input`. Output lands in its canonical project location —
there is no `--out`.

```
# Build the full audiobook for a project with a given voice:
python cli/bookforge-tts.py --audiobook \
    --project "/path/to/library/projects/<slug>" --voice deathstalker

# Force a memory tier / keep the scratch session / see the spawn without touching the GPU:
python cli/bookforge-tts.py --audiobook --project "<dir>" --voice deathstalker \
    --tier light --keep-session
python cli/bookforge-tts.py --audiobook --project "<dir>" --voice deathstalker --dry-run
```

**Resume (default).** `--audiobook` resumes automatically: after TTS it caches the
session to `stages/03-tts/sessions/<lang>/` (and on Ctrl+C it caches the partial
progress first), so a re-run seeds the already-rendered sentences and generates only
what's missing — the same skip-existing-FLACs mechanism the app uses. Pass `--fresh`
to ignore the cache and re-render from scratch.

Requires `dist/electron/{parallel-tts-bridge,reassembly-bridge,manifest-service}.js`
(build with `npx tsc -p tsconfig.electron.json`). The library root is derived from the
project path, so the manifest cover/metadata resolve exactly as they do in the app.

## Flags

**Job**
- `--voice <id>` — a voice in BookForge `models.json`, or a model folder name (required).
- `--input <file>` / `--text <str>` — what to render (one required for `--tts`; `--input`
  optionally overrides the resolved EPUB for `--audiobook`).
- `--out <file.wav>` — output WAV (required for `--tts`; unused for `--audiobook`).
- `--project <dir>` — **`--audiobook` only**: the BookForge project; output lands in
  `<project>/output/<Title>. <Author>.m4b` (required for `--audiobook`).
- `--language <code>` — default `en`.
- `--mode {tts,streaming}` — render path for `--tts`; default `tts`.

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
- `--final-denoise` / `--no-final-denoise` — `--audiobook` only: force the final-audio
  denoise pass on/off (BookForge's block-based roformer pass over the rendered
  sentences, run before assembly; strips the faint hiss bed hiss-trained voices
  reproduce). Default: **on** for `--engine orpheus`, off for every other engine.
  Off = zero behavioral change. Needs the RVC engine env (it carries audio-separator).
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
# Cleanup a SCANNED book with a cloud provider (key from ANTHROPIC_API_KEY):
python cli/bookforge-tts.py --ai-cleanup --input book.epub --provider claude \
    --model claude-sonnet-4-5 --stages both --output-dir ./out

# Cleanup a born-digital epub — TTS prep only, no per-chunk model pass (seconds):
python cli/bookforge-tts.py --ai-cleanup --input book.epub --provider ollama \
    --model cogito:14b --stages tts --output-dir ./out

# Repair scanner damage and STOP — repaired.epub for reading/translation/training:
python cli/bookforge-tts.py --ai-cleanup --input book.epub --provider ollama \
    --model cogito:14b --stages ocr --output-dir ./out

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
- `--stages {ocr,tts,both}` — **required for `--ai-cleanup`.** Cleanup is two
  independent passes and you pick which run:
  - `ocr` — the per-chunk model pass that fixes scanner damage (merged words, misread
    letters, line-break hyphenation). Stops there: the product is **`repaired.epub`**,
    faithful text with every footnote marker and curly quote still in place. Slow.
  - `tts` — the deterministic pass only: footnote-marker removal, quote normalization,
    number expansion. Product is **`cleaned.epub`**, in seconds, with no model pass over
    the text. The right choice for a born-digital EPUB that was never scanned.
  - `both` — repair, then prep. Writes both artifacts.

  There is no default: the pipeline refuses to guess. Ignored by `--simplify` /
  `--cleanup-prompt` / `--detailed-cleanup`, which take the single-pass rewrite path.
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

## RVC voice conversion (`--rvc`)

Clean/convert a WHOLE audio file through an RVC voice model, **memory-safely**. Drives the
real `rvc-bridge.convertFileRvcChunked`: it silence-chunks the file, converts each chunk in
a **recycled worker process** (each exits between batches so unified memory is reclaimed — a
full audiobook never balloons into swap the way one long `convert-dir` does), then stitches
the chunks back. Primary use is **same-voice reconstruction** (`--index-rate 0`): background
hum / scratchiness removed, re-rendered at 48 kHz.

```bash
# Reconstruct an audiobook through your own voice model (background removed, 48 kHz):
python cli/bookforge-tts.py --rvc \
    --input "Marked Man.m4a" --out "Marked Man RVC.flac" \
    --model deathstalker_rvc_v1 --index-rate 0 --protect-rate 0.2

# See the resolved spawn without touching the GPU:
python cli/bookforge-tts.py --rvc --input book.m4a --out book.flac --model my_rvc --dry-run
```

- `--input <audio>` / `--out <file>` — source and result (out extension picks the codec:
  `.flac` → flac, `.wav` → pcm). Reuses the shared `--input`/`--out` flags.
- `--rvc-model <folder>` — **required**; the voice-model folder name under
  `<userData>/runtime/rvc-models/rvc/voice_models/` (e.g. `deathstalker_rvc_v1`).
- `--index-rate <0-1>` — default **0.0** (same-voice cleanup; the app uses 0.5).
- `--protect-rate <0-0.5>` — default **0.2** (favors cleanup; raise toward 0.33 if sibilants
  get harsh).
- `--f0-method {rmvpe,crepe,crepe-tiny,fcpe}` — default **rmvpe** (best for narration; crepe
  is music-oriented).
- `--chunk-seconds <sec>` — silence-chunk length (default **600**). A single `convert-dir`
  over a multi-hour file OOMs; chunking + recycling keeps it flat.
- `--batch-size <n>` — chunks per worker before it's recycled to free memory (default **4**).
- The same process-recycling now bounds the **Enhance tab and assembly** RVC paths too — the
  unbounded `convert-dir` there could balloon on a full book (the MPS `empty_cache` patch is
  necessary but not sufficient for large inputs).

## OCR (`--ocr`)

PDF → Tesseract text blocks, driving the app's own OCR path. Two destinations,
independent — give either or both, but at least one:

| flag | writes | shape |
|---|---|---|
| `--out <dir>` | `<dir>/blocks.json` | Tesseract's own paragraphs, flat — what the training corpus is keyed to |
| `--project <dir>` | `manifest.editor.ocrBlocks` + `.ocrCategories` | the picker's merged-and-categorized blocks — what **Label mode** edits |

```bash
python3 cli/bookforge-tts.py --ocr \
    --input book.pdf --out ./ocr-out          # whole document, 8 workers
python3 cli/bookforge-tts.py --ocr \
    --input book.pdf --out ./ocr-out --pages 100-119 --jobs 4

# Store the result IN the book's project, so the app opens it already OCR'd:
python3 cli/bookforge-tts.py --ocr \
    --input "<library>/projects/<slug>/archive/Book. Author. (1993).pdf" \
    --project "<library>/projects/<slug>"
```

Runs `electron/headless-ocr.ts` → `electron/ocr-service.ts` — the same code the
picker's OCR runs — through `cli/ocr-pdf.js` under `electron-stub.js`. Needs
`npm run build:electron`, plus `tesseract` and `mutool` on PATH.

`blocks.json`: each block carries `lineBoxes` (per-line boxes) and, because the
app path runs the legacy-engine font pass, per-line **typography** — font name,
point size, bold and italic fractions — which `ocr-book.mjs` cannot produce at all.

### `--project`: OCR here, hand-label there

The workflow this exists for. The library (`E:\Shared\BookForge`) is
Syncthing-shared between machines, and a project's `manifest.json` is part of it —
so OCR a scan on the machine with the GPU and tesseract, and the blocks are on the
Mac by the time you sit down to categorize them in **Label mode**. Without this,
command-line OCR left the project untouched and the app re-OCR'd the book from
scratch on open, which is both slow and a different set of block IDs.

The blocks written here are produced by `shared/ocr/ocr-post-processing.ts` — the
**same call the picker makes** (`processOcrPageResults`), which the renderer reaches
through `OcrPostProcessorService` and this CLI reaches through
`dist/shared/ocr/ocr-post-processing.js`. One implementation, two callers: lines
merged into paragraphs on Tesseract's layout analysis, categorized against the
thirteen-class contract in `shared/ocr/block-categories.ts`. That is not tidiness —
see the ID note below.

**OCR block IDs are frozen at write time.** They are minted as
`ocr_p{page}_{suffix}_{index}` with a per-page random suffix, and
`manifest.editor.categoryCorrections` keys every hand label to one. So:

- Re-running OCR mints *new* IDs and orphans every label made against the old ones.
  That is why a project that already holds OCR blocks is **refused** unless you pass
  `--overwrite-ocr`; the refusal reports how many blocks are stored and whether
  `categoryCorrections` exists, because that is the labelling you would be throwing away.
- `--overwrite-ocr` writes only `ocrBlocks` + `ocrCategories`. Any now-orphaned
  labels are **left in the manifest** — clear them in the app (they can never
  re-apply, but they would still be counted as labels).
- A second CLI implementation that segmented "almost the same" would be worse than
  no feature at all: the labels would describe blocks the app cannot reproduce.

**The PDF must be the project's own source document.** Verified by SHA-256 against
every file the project records as a source — the `archive/` originals, its ebook
variants, the legacy `source/{finalized,original,exported}.*` — and refused, listing
them all with their hashes, if it matches none. Filing one book's blocks under
another book is the exact failure this feature would otherwise make easy, and it
looks perfectly valid until someone has labelled a few thousand of them.

Both checks run **before** OCR starts (so a wrong path costs a second, not an hour)
and again inside `modifyManifest`'s per-project lock, which is the app's own
read-modify-write — so nothing else in `manifest.editor` (undo stack, block edits,
crop regions, chapters, labels) is touched.

### Why this drives the app, and what that caught

The CLI takes the highest app path available so that a CLI run exercises the real
code and surfaces bugs in it. This command used to wrap `tools/aligner/ocr-book.mjs`
instead, on the argument that the corpus tool *defines* what a block is. That was
backwards — a parallel implementation can never surface an app bug, and pointing
the CLI at the app immediately found three — and a fourth when `--project` forced
the picker's own block construction to be shared rather than copied:

| Bug | Effect |
|---|---|
| `headless-ocr` rendered at 300 dpi but declared `user_defined_dpi=200` | Tesseract measured the page 1.5× too small; segmentation drifted from every hand label |
| `parseHocrOutput` matched only `ocr_line` | Lines Tesseract classes as `ocr_header` / `ocr_caption` / `ocr_textfloat` were dropped, and their paragraphs vanished — **7% of blocks** on a 20-page sample, concentrated in running heads, captions and footnotes |
| The OpenCV preprocessing pass ran unconditionally | Ranged from useless to destructive. Kritz: moved a third of all bounding boxes for no gain (confidence +0.0006, characters +1). Hayner: confidence **0.94 → 0.77**, text visibly wrecked, segmentation fragmented 20% (152 → 182 blocks) |
| The picker converted OCR boxes to page points with a scale derived from the document's **page count** (1.5 / 2.0 / 2.5) | Left over from when OCR reused the display raster; OCR has rendered at `OCR_RENDER_SCALE` (2.78) since. Every OCR block's geometry was inflated by up to **1.85×** — measured on a 17-page scan, blocks ran 49 pt past the bottom of a 760 pt page — which moves `y / pageHeight` and with it every footnote, footer and caption verdict |

With the first three fixed, the app path reproduces the corpus tool's segmentation to
**155 of 156 blocks bbox-identical** over the same 20 pages. `ocr-book.mjs` is now
a cross-check, not the production path.

### Resolution and preprocessing

There is one render resolution, `OCR_DPI` in `shared/ocr/ocr-render.ts` (200), which
`electron/ocr-service.ts` re-exports and the picker imports — it used to be three
hand-kept copies. Tesseract's paragraph segmentation is resolution-dependent and
every hand label is keyed to the 200 dpi segmentation, so `--dpi` is accepted but
ignored, with a warning. Move `OCR_DPI` if you genuinely mean to re-key the corpus.

`--ocr-preprocess` re-enables the OpenCV denoise/binarize pass. It is off by
default for the reason in the table above — binarizing thins already-thin strokes
until Tesseract misreads them. Turn it on only for the case it was written for
(highlighter, heavy noise, bleed-through), never for pages whose blocks must match
existing labels, and **check `conf` in blocks.json both ways** before believing it
helped.

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
