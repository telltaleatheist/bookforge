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

`tsc` compiles the code but copies no ASSETS. The component system loads
`dist/electron/data/*.json` at import time, so any command that touches a component —
`--generate-epub` (the foundry CLI), `--rvc`, `--generate-sentences` — fails on a
tsc-only build with *"Failed to load built-in RVC voice assets"*. Run
`npm run build:electron` once (it copies `electron/data`, `electron/prompts` and the
python scripts), or copy `electron/data` into `dist/electron/` by hand.

## Two render paths

| `--mode`      | Path | What it exercises |
|---------------|------|-------------------|
| `tts` (default) | audiobook / batch — `parallel-tts-bridge → renderRangeHeadless → e2a prep packs ~300-char chunks → worker.py` | **the path shipped in the app** |
| `streaming`   | Listen / browser extension — the app's own `tts-api-server`, driven over its documented WebSocket protocol: `handleSpeak → splitForTts → stream-scheduler → orpheus-worker-pool → orpheus_stream.py` | **the path shipped in the app** |

**The narration prep runs first, automatically.** Both render paths call
`prepareNarrationInput` (see `--prep` below) before `renderRangeHeadless` and hand it
the result, so a `--tts` audition reads its numbers as words exactly as the shipped
audiobook does. One line says what happened:

```
[prep] 3 number(s) read as words — 2 by rules, 1 by qwen3.5:9b (copy reused: no) → …/narration-cuts/….norm.tts.txt
[prep] no digits a narrator reads — input passes through untouched
```

The `.edits.json` beside that copy is the record of every proposed edit and its
disposition — run `--prep` on the same input to print its path and the tally, or just
read the file next to the copy the line names. A second run on the same input reuses
the copy (`copy reused: yes`) and makes no model call. `--mode streaming` is the Listen
path and does not prep — it speaks the blocks as given, like a web page.

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

# Streaming path instead (BLOCKS: paragraphs separated by blank lines — block 1 is
# the one "play" was pressed on, the rest are read ahead, exactly as on a web page):
python cli/bookforge-tts.py --tts --mode streaming --voice deathstalker --input article.txt

# Only read two blocks ahead, to see the batch shapes that makes:
python cli/bookforge-tts.py --tts --mode streaming --voice deathstalker --input article.txt --read-ahead 2

# See exactly what would run, touch no GPU:
python cli/bookforge-tts.py --tts --voice rohan --text "Hi." --out s.wav --dry-run
```

## Full audiobook (M4B) — `--audiobook`

The app-faithful end-to-end path. It chains the **exact high-level calls the app's
queue makes** for a standard audiobook — no pipeline logic is reimplemented:

0. `prepareNarrationInput()` (`parallel-tts-bridge`) — the **narration door**: the
   caption/footnote cut, then the number pass that reads the printed digits as words.
   The same export `startParallelConversion` calls. Its output is what generation
   reads; the project's own EPUB is never rewritten. See `--prep` below.
1. `renderRangeHeadless()` (`parallel-tts-bridge`) — the tts-conversion core.
2. `startReassembly()` (`reassembly-bridge`) — the reassembly job: e2a `--assemble_only`
   → `<project>/output/<Title>. <Author>.m4b` (+ `.vtt`) with chapters, cover, and
   metadata, and registers the audiobook in the project manifest.

(Plus `runFinalDenoise()` between 1 and 2 when the denoise is on — its own step in the
app since 2026-08-29, so its own call here.)

So this is the real headless test of the shipped audiobook pipeline. The input EPUB is
resolved from the project's RECORD (manifest-service `bookForAct`, the door every app act uses — an unrecorded file under source/ is refused, never adopted;
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

Resume seeds by sentence **index**, so a cache rendered before the narration door
existed (or before the normalizer's rule version / model changed) describes different
words at the same indexes. Pass `--fresh` the first time you render a project whose
cache predates the prep, or the already-rendered sentences will be kept as they were.

Requires `dist/electron/{parallel-tts-bridge,reassembly-bridge,manifest-service}.js`
(build with `npx tsc -p tsconfig.electron.json`). The library root is derived from the
project path, so the manifest cover/metadata resolve exactly as they do in the app.

## Narration prep — `--prep`

The **narration door**, on its own: the step every queued audiobook already walks
through, run by itself so you can prep now and render later. Owen, 2026-09-02:
*"make sure the bookforge cli has a cleanup step independent of the tts step, so the
user can run one and then the other."*

It drives `prepareNarrationInput` (`parallel-tts-bridge`) — the SAME export the app's
queue calls — which is two passes over the input:

1. **The cut** (`.epub` only): photo captions, the endnote apparatus and `<sup>`
   reference numbers out, through `writeNarrationEpub`. A book with none of those
   stamps passes through untouched, same bytes.
2. **The numbers**: every passage with a digit in it goes to the model named by
   Settings → `ttsNumberNormalizerModel` (default `qwen3.5:9b-q8_0`), which answers with an
   edit list; every edit is checked against the validator's 13 dispositions and a
   rejected edit means the printed digits stand. **e2a has no number transform of its
   own any more**, so what leaves this door is exactly what the voice reads.

Both formats the render paths take are accepted: an `.epub` gets the cut and then the
numbers; a `.txt` (what `--tts --text` / `--tts --input passage.txt` render) has no
captions or notes to cut, so its paragraphs go straight to the number pass. Any other
format is refused by name — a prep silently skipped is a book narrated as digits with
nothing in the log to say so.

> **This is not `--ai-cleanup`.** That is the OCR/model book-repair pass over an epub's
> prose (`aiBridge.cleanupEpub` → `repaired.epub` / `cleaned.epub`). `--prep` repairs
> nothing; it only decides what the **narrator** is handed.

```bash
# Prep a project's book — the RECORDED book, through the app's own manifest door (same as --audiobook):
python cli/bookforge-tts.py --prep --project "/path/to/library/projects/<slug>"

# Prep one file, book or passage:
python cli/bookforge-tts.py --prep --input book.epub
python cli/bookforge-tts.py --prep --input passage.txt

# See the spawn and touch nothing (no model loaded):
python cli/bookforge-tts.py --prep --input book.epub --dry-run
```

It prints the prepared copy, the record beside it, and the disposition tally:

```
[prep] 220 number(s) read as words — 214 by rules, 6 by qwen3.5:9b (copy reused: no) → …/narration-cuts/3f2a….n2.qwen3.5-9b.norm.tts.epub
[prep] copy:   …/narration-cuts/3f2a….n2.qwen3.5-9b.norm.tts.epub
[prep] record: …/narration-cuts/3f2a….n2.qwen3.5-9b.norm.tts.edits.json
[prep] dispositions: APPLIED_RULE=214 APPLIED=6 CITATION_CODE=4 NOT_FOUND=1
```

The copy is **content-addressed** by (input sha, rule version, model), so a later
`--tts` or `--audiobook` on the same input finds it and reuses it with **no second
model call** — its own `[prep]` line then reads `copy reused: yes`. Change the book,
the `NORMALIZER_VERSION`, or the model tag and it is a new copy.

The `.edits.json` is the review trail: every passage the model was shown, every edit it
proposed, and what became of it (`APPLIED_RULE` naming the rule that read it, `APPLIED`,
`CITATION_CODE`, `WORDS_DROPPED`, `PUNCTUATION_SPOKEN`, `SPANS_MARKUP`, `TOC_MISMATCH`, …).

- `--project <dir>` **or** `--input <file.epub|file.txt>` — one of them, never both.
  `--project` resolves the book exactly as `--audiobook` does (the manifest's recorded book via `bookForAct`;
  exported > original), which is what makes the later render reuse this copy.
- `--dry-run` — print the spawn and exit; no model is loaded.
- An unreachable Ollama or a model that is not pulled is a **non-zero exit** naming the
  model tag. There is no fallback to raw digits, ever.
- The prep is off-GPU-ish but not free: it loads a 6-17 GB model and releases it before
  returning (e2a takes the card next). Don't run it against a busy GPU.

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
- `--read-ahead <n>` — streaming only: how many following blocks to read ahead. Default is every remaining block, which is what the extension does on a page.

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
  - `audioNotInEpub` — audio ranges ≥`--report-min-hole` (default: `--min-hole`, 30 s)
    with no epub match (ads, intros, disc breaks),
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
- `--report-min-hole <sec>` — **epub-align only**: how long an unmatched-audio range must
  be to be **listed** in `audioNotInEpub`. **Defaults to `--min-hole`, so it changes
  nothing unless you ask.** Report-only: it cannot alter a single cue — `--min-hole` still
  governs whisper-fallback filling, and each entry carries `filledWithAsrCues` saying
  which of the two thresholds it cleared.
  **Know what you are lowering.** Cues are contiguous, so there is no literal gap between
  them: `find_holes` compares each cue's span against `est_end()` — how long a *slow
  reading* of its text would take — and reports the surplus. At 30 s that surplus is a
  real ad/credits detector. At 3 s it fires on ordinary brisk narration (measured on
  shipped VTTs: blacksun 1 → 65 ranges, ds 1 → 137) and the totals stop meaning anything,
  which is why `summary.unmatchedAudioRanges`/`unmatchedAudioSeconds` always report the
  `--min-hole` list; the lowered list is counted separately as `summary.reportedRanges`.
- `lowSpeechCues` (report) — cues at least 3 s long whose span is ≤30 % speech, **measured**
  by intersecting the cue with the silence map rather than guessed from reading speed.
  This is the short-dead-air signal that lowering `--report-min-hole` was reaching for:
  stings, applause beds, music, stretches the narrator never read. Each entry carries its
  `speechFraction`, timestamp and text; `summary.lowSpeechCues` is the total.

### Boundary accuracy (epub-align, 2026-09-03)

Two changes to where a cue *starts and stops*, which is all a training-corpus cutter
actually consumes. Both are on by default and both have an off switch.

- **Paragraph-aware ebook segmentation.** `extractTextFromXhtml` preserves block structure
  (every `</p>`, `</h1-6>`, `</li>` becomes a blank line); the sentence splitter used to
  throw all of it away before splitting on punctuation. Publishers set headings as
  unpunctuated blocks — `<p class="pn">Part I</p>`, `<p class="cn">1</p>` — so the
  punctuation split could not see them and glued each onto the prose that followed:
  *"Part I Ohio Born and Molded 1 William McKinley, Ohioan It is generally believed by
  strangers that…"* as one 24-second cue. Now blocks split first and sentences split
  within them, so a heading gets its own cue tagged `NOTE heading` in the VTT (same
  mechanism as `NOTE asr-fallback`; a WebVTT NOTE is a comment every conformant parser
  skips). A cutter drops those cues instead of guessing from the text.
  `--no-paragraph-split` restores punctuation-only segmentation.

  **What counts as a heading.** The label has teeth — a cutter that drops `NOTE heading`
  cues drops whatever this gets wrong — so it is narrow on purpose:
  - an `<h1>`–`<h6>` is a heading **by markup**, full stop. (`extractTextFromXhtml` gains
    an opt-in `markHeadings` for this. It has to, because the extractor appends a period
    to headings for the TTS read, which made a "no terminal punctuation" rule score every
    semantically marked-up EPUB at *zero* headings.)
  - otherwise the block must be its own paragraph, ≤90 chars, ≤12 words, carry no terminal
    punctuation (`. ! ? … : ;` and `,`), **and** be one of: bare numbering (`1`, `IV`), a
    heading lead word (`Part I`, `Chapter 3`, `Notes`, `Appendix B`), or two-plus words in
    Title Case or ALL CAPS.

  "Short and unpunctuated" alone was far too loose: it swallowed `<li>Bread</li>`, a
  one-word "Yes", and dialogue fragments ending in a dash. On McKinley the narrow rule
  labels 316 blocks where the loose one labelled 784. A numbering-only block also now
  **gets a cue at all** — the sentence splitter's fragment filter (`length > 1 &&
  /[A-Za-z]/`) used to bin `1` and `I` entirely, so the flagship `<p class="cn">1</p>`
  case produced no cue and its spoken chapter number fell into the previous cue's tail.
- **Silence snapping.** `--snap-silence <sec>` (default 0.6, `--no-snap-silence` to
  disable) pulls each cue *seam* onto the middle of the nearest detected silence within
  that window. Forced alignment puts the seam at a CTC frame, which lands a couple hundred
  ms early (clipping a word's tail) or late (leaking the next word's onset); the
  narrator's pause is where the cut belongs, and its middle leaves maximum margin on both
  sides. The window bounds the move, so a snap can correct a frame-level boundary but can
  never manufacture drift — and seams that already sit in a silence, cues separated by a
  gap, and books whose silence map comes back empty are all left alone. The map is scanned
  off the already-decoded 16 kHz wav on a background thread during the align stage, so it
  costs no wall clock. `boundarySnap` in the report records the window, the interval count,
  and how many seams moved how far.

Measure it with `tools/vtt-boundary-metric.py`, which needs no labels — it scores what
fraction of cue boundaries land in a silence, using an ffmpeg `silencedetect` map of the
same audio:

```bash
ffmpeg -i book.flac -af silencedetect=noise=-45dB:d=0.25 -f null - 2> silences.log
python tools/vtt-boundary-metric.py --vtt after.vtt --compare before.vtt \
    --silences silences.log --epub book.epub --asr-gaps book.roughcache.json
```

**`--asr-gaps` is not optional if you intend to quote a number.** With snapping on, the
silence score is partly circular by construction: the aligner moved each seam onto the
middle of a silencedetect interval, so scoring against a silencedetect map largely
measures whether the snapper did what it says. `--asr-gaps` scores the same boundaries
against faster-whisper's VAD segment gaps — a different algorithm on a different signal
path that the snapper never sees. On McKinley the two read 18.6 % → 95.4 % (circular) and
6.3 % → 38.2 % (independent); the second is the one that shows the boundaries genuinely
moved into pauses.

### Tests

```bash
node --require ./cli/electron-stub.js tools/tests/test-epub-align-segmentation.js  # 41
python tools/tests/test_align_audiobook_timing.py                                  # 19
bash   tools/tests/test-cli-flag-parity.sh                                          # 24
```

Segmentation covers heading classification in both directions (numbering and `<h1>` are
tagged; "Yes", `<li>Bread</li>`, "He said-", "The rules are:" are not). Timing covers
snap bounds and the cue-overlap fix against 20k randomized start-sets. Flag parity checks
that `bookforge-tts.py` and `generate-sentences.js` accept and reject the same things.

## PDF → EPUB conversion (`--generate-epub`)

Read a project's PDF into its book — the app's **Convert to EPUB**, headless. Drives
`vlm-convert.runVlmConversion`, which is the SAME function `ipcMain.handle('vlm:convert')`
calls, so one call gets all of it: the route resolution (a configured OpenAI-compatible
server, MLX on Apple silicon, or this machine's GPU through the WSL vLLM reader from
Settings → Add-ons), the banked-readings decision with its **foundry ≥ 0.9.0 gate**,
`foundry vlm-convert` itself, the staged EPUB moved onto
`source/<archive basename>.generated.epub`, `registerGeneratedEpub`, the freshly minted
working copy recorded as `outputs.epub`, and the `vlm-convert` provenance entry. Nothing
about a converted project says it was done from here.

The book this writes is **not yet stamped**: its elements get their stable `data-bf-uid`
identities — and its chapter openings get their stored names — the first time the project
is opened in the app, exactly as a book made through the app's own Convert to EPUB does.
Both passes are idempotent and unattended, so nothing here needs to ask for them.

```bash
# Convert one PDF-only project, reading every page afresh:
python cli/bookforge-tts.py --generate-epub \
    --project "E:/Shared/BookForge/projects/Some_Book" --readings fresh

# What WOULD happen — source PDF, target EPUB, which GPU, the readings decision,
# the installed foundry — and then nothing:
python cli/bookforge-tts.py --generate-epub --project "E:/…/Some_Book" --readings fresh --dry-run

# Read the pages on somebody else's server instead of this machine's route:
python cli/bookforge-tts.py --generate-epub --project "E:/…/Some_Book" \
    --vlm-endpoint http://192.168.68.83:8000/v1 --vlm-endpoint-model rednote-hilab/dots.ocr

# Add the reading BESIDE the book this project already has, leaving it untouched:
python cli/bookforge-tts.py --generate-epub --project "E:/…/Some_Book" --destination new-copy
```

- `--project <dir>` — **required**; the project whose PDF is read. It must sit at
  `{library}/projects/{projectId}`, which is what lets `manifest-service` resolve this
  project's records; anywhere else is refused by name rather than converted into the
  wrong project's files.
- `--readings {fresh,reuse}` — what to do with the page answers already banked for this
  PDF (`~/Documents/BookForge/foundry-runs/vlm-<sha>/readings.jsonl`, keyed by the PDF's
  digest). `fresh` archives them beside themselves and reads the whole book again;
  `reuse` answers out of the bank — resuming an interrupted run, or **rebuilding a
  finished one with no GPU at all**. Omitted means `reuse`, which is what a job carrying
  no choice means in the app. **A batch re-run wants `--readings fresh`.**
- `--destination {replace,new-copy}` — default `replace`: the reading becomes this
  project's book and a fresh working copy is minted from it (which ends the previous
  book's provenance). `new-copy` registers it as another archive-grade variant with a
  working chain of its own and touches no existing output.
- `--variant-id <id>` / `--source-pdf <file.pdf>` — which PDF, for a project holding more
  than one. A project with two PDFs and no choice is a **question**, not a guess.
- `--skip-deleted-pages` — read the archive PDF but leave out the pages the **working
  copy** marks deleted (the app's *Create EPUB* on the working-copy row). Refused by name
  when there is no working copy.
- `--vlm-endpoint <url>` / `--vlm-endpoint-model <name>` / `--vlm-concurrency <n>` — the
  Settings → AI → Reading pages values. That setting lives in the renderer's own settings
  bundle, which no headless process can read, so it is passed here the same way
  `--ollama-url` passes the AI provider's URL. **Omitted = this machine's own route**,
  which is exactly what an unset setting means in the app.
- `--dry-run` — run `planVlmConversion` (the same call the run itself makes first, and
  uses exclusively) and print the plan: project, source PDF and its digest, which machine
  reads the pages, the language, where the book lands, the readings bank and the sentence
  the job log would get about it, the skipped pages, and the installed foundry. Nothing is
  spawned and no GPU is taken.
- Progress is foundry's own lines, verbatim: the conversion is a document **stage**, so the
  adapter puts a printing pseudo-window in the shim's window list and the stage's
  broadcasts land there. Ctrl-C stops the stage the way the app's Stop button does — every
  page already read is banked and kept.

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

## Bookshelf server, standalone (`serve-bookshelf.js`)

Serve the library over HTTP **without BookForge running** — the NAS copy, for when
the app is down on both the PC and the Mac. It starts the SAME compiled
`dist/electron/bookshelf-server.js` the app starts, in **standalone mode**: a
library-only mirror.

```
node cli/serve-bookshelf.js --library /mnt/library/bookforge
node cli/serve-bookshelf.js --library Z:\bookforge --port 8765 --state-dir /var/lib/bookforge
```

**What it serves:** the shelf and the ebook list, covers and thumbnails, downloads,
range-streamed audio, chapters, transcripts, audiobook analysis, the in-app reader
(EPUB bytes **and** rasterized PDF pages — mupdf is pure WASM, so a headless Linux
box renders them exactly as the app does), reader profiles and sign-in, and durable
position / bookmarks / heard / analytics.

**What it refuses, with HTTP 501 and the capability named:** live TTS and the
whole-book renderer (`/api/render/*`, `/api/tts/*`, the reader WebSocket), document
ingest (`/api/reader/ingest`, `/api/edit/ingest-pdf`, `/api/edit/page`), project
creation (`/api/edit/finalize`), the queue (`/api/queue*`), and library mutations
(`DELETE /api/project`, `/api/ebooks/reclassify`). `/api/health` reports the reduced
`capabilities` list, and the bookshelf web app disables the affected controls —
disabled with the reason, never hidden.

**Reader state converges by construction.** Positions, bookmarks, heard coverage and
analytics live under `<library>/.bookshelf/` as per-device files merged on read, so
this server and the app's write different files and neither has to be primary.

**Flags**
- `--library <path>` — **required**, no default. The library root (holds `projects/`
  and, optionally, `bookshelf.json`). Manifests store library-relative paths, so a
  Linux root resolves manifests written on Windows.
- `--port <n>` — default **8765**, the same port `electron/main.ts` serves on.
- `--state-dir <path>` — per-machine state (duration cache, cover thumbnails, reader
  tokens, device id). Default `<userData>/bookshelf-server`, where `<userData>` is
  `%APPDATA%\BookForge` / `~/Library/Application Support/BookForge` /
  `$XDG_CONFIG_HOME` (else `~/.config`)`/BookForge`. Never on the library share.

**Needs** `dist/electron/*.js` (`npx tsc -p tsconfig.electron.json`), the web app at
`dist/electron/bookshelf-ui` (`npm run build:bookshelf`), `dist/electron/data`
(component catalogs, loaded at import time), and a working **ffmpeg + ffprobe** —
checked once at startup and named if they don't run (`FFMPEG_PATH` / `FFPROBE_PATH`
override the resolution). Ctrl+C / SIGTERM stops it cleanly.

Docker files for the NAS live in `deploy/bookshelf-server/`.

## Gotchas

- **Git Bash mangles `/home/...` args.** MSYS rewrites a Unix-style path passed to a
  Windows `python.exe` into `C:/Program Files/Git/home/...`. Pass WSL paths (e.g.
  `--model-dir /home/...`) from **PowerShell or cmd**, or prefix the Git Bash command
  with `MSYS_NO_PATHCONV=1`.
- **Don't run while the GPU is busy** (a training run, another render). The pipeline's
  VRAM preflight will wait or abort with a message, but co-residency can still crash a
  training job. Free the GPU first.

## Extending

`COMMANDS` in `bookforge-tts.py` is a registry — one entry per job (`tts`, `prep`,
`ai-cleanup`).
Add a `cmd_*` handler and a registry line; a `--<name>` selector flag is generated
automatically. Engine adapters live beside it (`orpheus-batch-render.js`,
`orpheus-render.js`) and load under `electron-stub.js`, which shims the tiny Electron
surface the pipeline touches — if a module reaches an unstubbed API it throws loudly
naming it, which is the signal to add exactly that (no blanket catch-all, no fallbacks).


## Streaming: what `--mode streaming` actually drives

`--mode streaming` is not a reimplementation of the Listen path — it **is** the Listen
path. `cli/orpheus-stream.js` starts the app's real `ttsApiServer` (headlessly, via
`cli/electron-stub.js`) and then speaks the protocol in `docs/TTS_API.md` to it, frame
for frame, the way the BookForge Reader extension does: one preempting `speak` for the
block you pressed play on, then a background `speak` per following block.

If BookForge is already running it attaches to that server instead of starting a second
one — driving the live app is more faithful, not less, and the port is busy either way.

It prints the timing table that matters for streaming work — when each block finished
generating, when it would actually play, and whether the reader would have been made to
wait:

```
block rows  complete   audio     plays      stall
   1    1       54s   10.9s      54s        -
   2    3     55.4s   26.9s    64.9s        -
   3    1     36.6s    6.7s    91.8s        -
...
first word at 54s
no stalls — continuous flow
```

A block completing *out of order* costs nothing — the client assembles by index. A
**stall** is the only real defect: the next block in reading order was not ready when
the previous one finished playing.

The older `cli/orpheus-render.js` still exists and still calls the worker pool's
per-sentence API directly. That skips `stream-scheduler` and the pool's batching
entirely, so it cannot reproduce anything that lives there — which was every streaming
defect found on 2026-08-31. Prefer `--mode streaming`.
