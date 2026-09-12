# bookforge-tts — headless CLI for BookForge's real pipeline

Run BookForge's jobs **through its actual compiled pipeline** from the command line,
without launching the app. Nothing is reimplemented: the CLI drives the real
`dist/electron` modules, so it inherits every guard unchanged — the WSL wedge-proofing
(TERM → verify → `wsl -t` kill ladder, never-SIGKILL a guest GPU proc, wedge latch),
the vLLM `gpu_memory_utilization` memory tiers + safe GPU sizing, and custom-model
resolution.

BookForge must be **built** (`dist/electron` present) but **need not be running**.

## `--<command> --help` is the reference

**Ask the command.** Since 2026-09-12 the CLI documents itself: every flag is
registered in a group whose title says who reads it, and one command's own page —
its usage line, which app door it drives, only the flags it reads, the flags it
**refuses by name** with the reason, and copy-pasteable examples — is one flag away:

```bash
python cli/bookforge-tts.py --help              # every flag, grouped by who reads it
python cli/bookforge-tts.py --tts --help        # just --tts: ~35 flags, 14 refusals, 5 examples
python cli/bookforge-tts.py --assemble --help   # and why --voice is refused here
```

Owen, 2026-09-12: *"ideally the bookforge cli would make it pretty straightforward
how to use it by its flags and such."* Before that, `--help` was one flat usage line
mixing 17 command selectors with ~130 options: every flag's own text was good and
nothing said which command could read it.

**The ownership is data, not prose.** `COMMAND_FLAGS` in `cli/bookforge-tts.py` holds,
per command, the flags its `cmd_*` function (and `_audiobook_spawn`, `_higgs_override`,
`_mlx_tuning_env`, `_session_target_argv`, `_run_ai`) actually puts on the adapter's
argv or into the spawn env, the ones it refuses and why, and its examples. The
per-command page is generated from it plus the **same** `add_argument` calls the real
parser is built from (`_FlagRegistry`) — a hand-written second parser would drift and
then name a flag argparse does not have. `tools/test-cli-flags.js` checks every entry
against the parser, that each flag sits in exactly one group, and that each page exits
0, fits under 120 lines, carries examples and does not leak another command's flags.

**Three flags are accepted and decide nothing**, named here rather than quietly
removed (found while deriving the map, 2026-09-12):

| flag | what happens |
|---|---|
| `--voice-token` | refused in `--mode streaming`, and in `--mode tts` it reaches **no adapter** — `cmd_tts` never puts it on the argv, though its help says "tts mode only". Use `--model-dir`, or a settings-file voice alias (which carries the token). |
| `--family` on `--narration-text` | its help says `--pass/--narration-text`, but only `cmd_pass` reads it; a project with two chains cannot be steered from this door. |
| the `ORPHEUS_*` env seams on `--assemble` | `--tier`, `--sentence-gap`, `--max-chars`, `--temperature`, `--top-p`, `--min-p`, `--rep-penalty`, `--models-dir`, `--orpheus-install`, `--conda-env` and `--engine` all still reach the spawn env of a run that **renders nothing**. `--assemble`'s render-choice refusals (`--checkpoint-dir`, `--safe-band`, `--top-k`, `--batch-width`, `--mem-budget-gb`) stop at those five. |

**On Windows, a typed path reaches the adapter AS TYPED** (2026-09-12, the PC
review of the two commits above). Every operator path (`--project`, `--library`,
`--input`, `--out`, `--epub`, …) used to go through `Path.resolve()`, which on
Windows rewrites a mapped network drive to its UNC target: the titan library
`Z:\bookforge` reached the adapters as `\\TITAN\iO\bookforge` — a spelling the
app never uses and one the bridge's WSL mapping (`/mnt/<letter>` only) cannot
hand to the guest. That was the "CLI resolves a Z: project to UNC" defect of
2026-09-11. The wrapper's `_user_path` now makes a typed path absolute without
resolving it on Windows (and still resolves symlinks on the Mac, where
`/var → /private/var` is what the adapters compare against);
`tools/test-cli-flags.js` proves it with a `subst` drive. The same review found
the wrapper's Windows rules already right for the PC: `--checkpoint-dir` must be
a guest-native `/home/…` path (the served arm loads it inside WSL), and
`--batch-width`/`--mem-budget-gb` are refused by name (a served render's width
is the server's).

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
| `streaming`   | Listen / browser extension — the app's own `tts-api-server`, driven over its documented WebSocket protocol: `handleSpeak → splitForTts → stream-scheduler → orpheus-worker-pool → `narrator.serve``. Either engine, whichever is SELECTED | **the path shipped in the app** |

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
python cli/bookforge-tts.py --tts --voice rohan --input book.epub --out sample.wav

# Anything, down to test chunks: one chunk per line, narrated as printed:
python cli/bookforge-tts.py --tts --engine higgs --voice mistborn \
    --input chunks.jsonl --as-chunks --max-chunks 20 --out chunks.wav

# Force a memory tier and a custom gap:
python cli/bookforge-tts.py --tts --voice rohan --input book.epub --out sample.wav \
    --tier fast --sentence-gap 0.75 --keep-sentences

# Streaming path instead (BLOCKS: paragraphs separated by blank lines — block 1 is
# the one "play" was pressed on, the rest are read ahead, exactly as on a web page):
python cli/bookforge-tts.py --tts --mode streaming --voice deathstalker --input article.txt

# Only read two blocks ahead, to see the batch shapes that makes:
python cli/bookforge-tts.py --tts --mode streaming --voice deathstalker --input article.txt --read-ahead 2

# See exactly what would run, touch no GPU — it also PACKS the input book and
# prints the settings object, so a text/jsonl render is reproducible before it runs:
python cli/bookforge-tts.py --tts --voice rohan --input book.epub --out s.wav --dry-run
```

**Where a `--tts` run keeps its sessions.** narrator has no default sessions root
— every spawn carries a `--session_dir` derived from the one that was stated — so
this door states it exactly as the app does at startup (`main.ts`
`applyNarratorScratchRoot`): the **Settings → Narrator scratch folder** override if
there is one, else **`<library>/tmp`**, which also holds the content-addressed
`narration-cuts/` a later run reuses. The library is the one this machine chose in
BookForge, read from the file main persists for exactly this question
(`<userData>/library-root.json`); **`--library <root>` overrides it for one run**,
and a machine that has never chosen a library is **refused by name** rather than
quietly writing into `~/Documents/BookForge`, where the app would never look for
it. (`--audiobook` takes no `--library`: the project's own path is
`<library>/projects/<slug>`, so it derives the root and refuses the flag. Until
2026-09-12 the batch adapter stated nothing at all, which is why every `--tts` run
on the Mac died before prep with *"No narrator scratch root has been stated."*)

**Both engines render and both stream.** `--engine higgs --mode streaming` was
refused here until 2026-09-12, on a claim ("v3 has no windowed decode") that
per-row Higgs streaming made obsolete on 2026-09-05. The refusal is gone; see
**Choosing the model** below for what `--engine` means on the streaming door.

## Choosing the model: any checkpoint, any sampling, any input

Owen, 2026-09-12:

> *"the point of the bookforge cli is to make it so the cli goes through the same
> high level path as the app so we can test things and watch for bugs. right now,
> though, the tts render part of the cli isnt working. at least not on the mac. we
> should be able to pick any model specifically, including a checkpoint we want to
> test, and it should allow that. i just tried to use the cli on a merged
> checkpoint as a test here on the mac and it wouldnt let me. it should also let
> me run renders on anything, up to and including test chunks. it should allow me
> to fully control what goes in and comes out. ... make it so i can run it on the
> mac and itll use the mac's line of logic, or the pc and itll use the pc's line of
> logic (for sglang or mlx, etc)."*

**The arm is not a flag.** `renderRangeHeadless` already routes by platform — Mac
MLX, Windows/WSL SGLang — so this CLI's whole job is to hand every *choice* to the
same `ParallelTtsSettings` the app's queue builds, and to refuse nothing the app
would allow. Nothing here decides which machine reads the tokens; `--tier` and the
memory knobs tune whichever arm the platform picked.

### A checkpoint under test

A Higgs checkpoint is named with **`--checkpoint-dir`**, and **`--voice` stays
required**: the checkpoint borrows that voice's *certificate* — its `maxChars`,
its measured pace and its safe band — which is precisely what makes a new
checkpoint comparable to the voice it came from. The bridge resolves the base
voice from the catalog and renders the override against it (the session's id
becomes `<voice>+<basename of dir>`).

```bash
# Mac (MLX reads the checkpoint on this machine, so the path must exist here):
python cli/bookforge-tts.py --tts --engine higgs --voice mistborn \
    --checkpoint-dir "/Users/telltale/Library/Application Support/BookForge/runtime/higgs-models/mb_v7_616" \
    --input chunks.jsonl --as-chunks --out mb616.wav

# PC (the reading happens in the WSL guest, so the path is GUEST-native):
python cli/bookforge-tts.py --tts --engine higgs --voice mistborn \
    --checkpoint-dir /home/telltale/higgs_v3_merged/mb_v7_616 \
    --input chunks.jsonl --as-chunks --out mb616.wav

# The same checkpoint, as a whole book:
python cli/bookforge-tts.py --audiobook --project "<dir>" --engine higgs \
    --voice mistborn --checkpoint-dir /home/telltale/higgs_v3_merged/mb_v7_616
```

On the Mac (and Linux) the directory is resolved against your cwd and **must
exist**; on Windows it must start with `/` and is **not stat'd**, because the host
cannot see the guest's filesystem — a check that pretended otherwise would be a
fallback dressed as a guard.

Everything the checkpoint changes travels as **one JSON argument**,
`--higgs-override`, composed by the wrapper and parsed by the single shared parser
both render adapters use (`cli/higgs-override.js`). That is deliberate: two
hand-rolled flag blocks would drift, and then a `--tts` audition and an
`--audiobook` build of the same checkpoint would be two different renders with
nothing saying so. It carries a **`note`** — who ran this and why — defaulting to
the command as typed plus the machine's hostname; `--note` overrides it.

### Sampling, caps and the band

| flag | `--engine orpheus` | `--engine higgs` |
|---|---|---|
| `--temperature` | env `ORPHEUS_TEMPERATURE` | `higgsOverride.sampling.temperature` |
| `--top-p` | env `ORPHEUS_TOP_P` | `higgsOverride.sampling.topP` |
| `--top-k` | **refused** — Orpheus's worker has no `top_k` seam | `higgsOverride.sampling.topK` |
| `--min-p` | env `ORPHEUS_MIN_P` | **refused** — narrator's v3 engines have no `min_p` |
| `--rep-penalty` | env `ORPHEUS_REP_PENALTY` | **refused** — no repetition-penalty knob |
| `--max-chars` | env `ORPHEUS_MAX_CHARS` | `higgsOverride.maxChars` |
| `--safe-band MIN-MAX` | **refused** — Orpheus packs to `--max-chars` | `higgsOverride.safeMinChars` / `safeMaxChars` |
| `--model-dir` | the Orpheus model directory | **refused** — name `--checkpoint-dir` |
| `--checkpoint-dir` | **refused** — name `--model-dir` | the checkpoint under test |

**Higgs sampling never travels as env**, and Orpheus sampling never travels in the
override. An `ORPHEUS_TEMPERATURE` set for a Higgs render would be read by nobody,
and a value that looks honoured and is not is the exact failure this pass exists
to end — so the wrapper only sets the `ORPHEUS_*` seams on `--engine orpheus`.

### Which arm the knobs reach

| flag | Mac (MLX) | PC (WSL/SGLang) |
|---|---|---|
| `--tier` | env `ORPHEUS_MEMORY_TIER` — both engines | same |
| `--batch-width` | env `NARRATOR_HIGGS3_MLX_BATCH` (Higgs only) | **refused by name** |
| `--mem-budget-gb` | env `NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB` (Higgs only) | **refused by name** |
| `--checkpoint-dir` | a path on this machine | a guest-native `/home/...` path |

`higgsMlxBatchEnv` honours `process.env` over the catalog's ceiling for both MLX
keys, which is the seam those two flags use. On the PC a Higgs render is **served**
and its width is the server's *admission* width (`HIGGS_MAX_NUM_SEQS`, set from the
catalog when the server starts) — not something one run chooses. Both are refused
on `--engine orpheus` too, which sizes its batch from `--tier`.

### Anything in, down to test chunks

`--tts` was EPUB-only by Owen's 2026-09-05 ruling; he **overrode that on
2026-09-12** (*"it should also let me run renders on anything, up to and including
test chunks"*). Four inputs now:

| input | becomes |
|---|---|
| `--input book.epub` | read as it is, chunked by the app's own packer |
| `--input passage.txt` / `.md` | paragraphs separated by blank lines |
| `--input chunks.jsonl` | one row per chunk: a JSON string, or an object with a `text` string |
| `--text "…"` | the literal, paragraphs separated by blank lines |

The last three are **packed into a real one-chapter EPUB by the app's own writer**
(`dist/electron/epub-writer.js buildEpubBuffer`, one `<p>` per paragraph/row) —
the render path still reads exactly one format, and the books this makes are the
books the app makes. It lands content-addressed at
`<os.tmpdir()>/bookforge-cli-inputs/<sha16>.epub` and the path is printed, so a
run is reproducible and a re-run reuses both the book and the narration prep's own
content-addressed copy. `--title` names it (default: the input's basename, or
`CLI passage` for `--text`); the author is always `bookforge-tts`, and the chapter
carries no title on purpose — a chapter `<h2>` would be its own chunk under
`--as-chunks`, so the run would open by narrating the filename.

```bash
# One chunk per line, capped at the first 20, narrated as printed:
python cli/bookforge-tts.py --tts --engine higgs --voice mistborn \
    --input rejects.jsonl --as-chunks --max-chunks 20 --out rejects.wav

# One literal passage:
python cli/bookforge-tts.py --tts --engine higgs --voice mistborn \
    --text "She turned the key. Nothing happened." --as-chunks --out two.wav
```

- **`--as-chunks`** makes each paragraph/row exactly ONE generation chunk
  (`settings.sentencePerParagraph` → narrator's `--sentence_per_paragraph`).
  Without it the prep repacks the lines to the voice's char cap and a set of 40
  chunks renders as 9. It is **refused with an `.epub`** by name: a book is chunked
  by the app's packer, which is what an EPUB render measures.
- **`--max-chunks N`** caps generation at N chunks (`settings.testMode` +
  `settings.testSentences`, the pair the app's own settings carry — the cap is
  applied by the bridge, not by slicing the input here). **`--tts` only**: refused
  with `--audiobook` by name, because a book built from the first N chunks would be
  filed in the project's own `output/` as *the* audiobook, with chapters and
  metadata claiming to be the whole thing.
- **`--as-chunks` narrates the text as printed.** It sets the same
  `textCleanup: 'skipped'` that `--skip-text-cleanup` does (which `--tts` now
  accepts too), so the persisted `foundry clean-text` pass is not run and
  `prepareNarrationInput` returns after the caption/endnote cut with **no number
  pass** — a chunk that came back rewritten is not the chunk that was under test.
  The cut itself is a no-op on a packed book (it only removes elements stamped
  `caption`/`footnote`, and a packed book carries no `data-bf-cat` stamps), so
  `1933` reaches the worker as `1933`. Drop `--as-chunks` (or pass neither
  cleanup flag) to measure the shipped path, where the digits *are* read as words.

### Streaming: `--engine` is an assertion, not a switch

A `speak` names a catalog **voice**; the engine is fixed for the resident pool by
`NARRATOR_ENGINE` when it spawns, so the selection is a persisted app setting
(`tts-engine.json` in userData), read through
`streaming-engine.getSelectedEngineName()`.

**This CLI will not rewrite it.** `setSelectedEngineName` is the only setter and it
persists (and ends the live session on the way), so a CLI run that flipped it would
silently change the user's Listen engine — whether the server is ours or the
running app's. So `--engine` on `--mode streaming` says which engine you believe
is selected, and a **mismatch is refused by name**, pointing at Settings → Listen.
Speaking in the other engine would be the worst available outcome: audio that is
fine, in the wrong voice, with nothing saying so.

### Refused by name, on the render doors

`--assemble` refuses every one of these (`--checkpoint-dir`, `--safe-band`,
`--top-k`, `--batch-width`, `--mem-budget-gb`, plus the input flags) because it
renders nothing; `--audiobook` refuses `--max-chunks`, `--as-chunks` and `--title`
because it narrates the project's recorded book; `--mode streaming` refuses
`--checkpoint-dir`, `--safe-band`, `--as-chunks`, `--max-chunks`, `--top-k`,
`--title` and (on Higgs) the sampling flags, because a speak carries no override.
Every one of those is a message naming the flag and the door that does want it.

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

## Assembly on its own — `--assemble`

The app's **Assemble** over a cached session, headless: no TTS, just the two calls
`--audiobook` makes after generation — `denoise-job.runFinalDenoise` then
`reassembly-bridge.startReassembly` — over the project's cached sentence set in
`stages/03-tts/sessions/`. It is the door for reproducing an assembly or denoise
defect without paying for a nine-hour render first, and because the denoised set is
**durable** (a sibling of the raw cache with a manifest saying what it was derived
from), a second run over the same session reuses it and costs minutes.

It is the SAME adapter as `--audiobook`, run with `--assemble-only`. There is no
second assembly implementation, deliberately.

```
# Assemble what is already rendered (the denoise answer is required):
python cli/bookforge-tts.py --assemble --project "<dir>" --final-denoise

# With the voice's de-ring filter and a 0.7s inter-sentence gap, no denoise:
python cli/bookforge-tts.py --assemble --project "<dir>" \
    --de-ring --assembly-gap 0.7 --no-final-denoise

python cli/bookforge-tts.py --assemble --project "<dir>" --dry-run
```

`--voice`, `--input`, `--fresh`, `--skip-text-cleanup` and every render knob
(`--checkpoint-dir`, `--safe-band`, `--top-k`, `--batch-width`, `--mem-budget-gb`,
`--as-chunks`, `--max-chunks`, `--title`) are **refused by name** here: nothing is
generated and nothing is narrated, so a value that changes nothing about the run is
an error rather than a silent no-op.

### Assembling an enhancement pass's output, as a SECOND audiobook

`--rvc-enhance` and `--denoise` write **durable** sets inside the session
(`chapters/sentences-rvc-<voice>/`, `chapters/sentences-denoised/`). Until
2026-09-10 the CLI could produce one and had no way to assemble it, so a headless
enhancement ended at a directory of FLACs. Two flags close that:

| flag | what it does |
|---|---|
| `--sentences-dir <dir>` | assemble THIS set instead of the session's own cache. Nothing is derived — the set is assembled as it is, so `--final-denoise` is refused alongside it and `--no-final-denoise` is not needed |
| `--as-new-version` | file the result **beside** the project's audiobook instead of replacing it: a manifest variant (`rvc:<voice>`), under a filename carrying the voice. The same filing the app does for a run that converted sentences it did not itself render |
| `--version-voice <id>` | the voice that second version is NAMED after. Read off a `sentences-rvc-<voice>` directory name; required for any other set |

```
# Convert the session's sentences, then file the result as a second version:
python cli/bookforge-tts.py --rvc-enhance --project "<dir>" --rvc-voice-id rvc-voice-sigma
python cli/bookforge-tts.py --assemble  --project "<dir>" --as-new-version \
    --sentences-dir "<session>/chapters/sentences-rvc-rvc-voice-sigma"
```

Both books end up in `output/`, the original untouched and `outputs.audiobook`
still pointing at it; the new one is registered as a manifest variant and shows in
Studio as a second version of the book.

**A derived set comes at its own sample rate.** An RVC v2 conversion runs at
48 kHz where the render was 24 kHz. `narrator`'s `build_manifest` takes the rate
from the set it is assembling (chunk 0, which is also the concat list's first
entry) and holds every chunk to it — a set that disagrees with itself is still
refused by name.

**Higgs.** `higgs-v3` books are `audited` — force-aligned after the render — and
assembly reads the `--coverage_report` that `narrator align` writes. It does not
REQUIRE one: assembly logs whatever the audit found (failed chunks, dropped text,
the retake command) and assembles the book either way, and with no report at all
it says so and estimates the sentence cues. `reassembly-bridge` passes the flag
whenever the report FILE exists, reading the path from the same
`coverageReportPath()` the align step writes to — so the recipe is `--align`
first, then `--assemble`, and no extra flag. `--engine` is **not read** on this door at all: the assembly resolves
the engine from the session's own `session-state.json` and refuses one whose two
records disagree.

**`--final-denoise` or `--no-final-denoise` is REQUIRED here.** Whether the denoise
ran is a fact about the chain that produced these sentences — its own queue row in
the app — and this door reads no engine flag to infer it from. Guessing would either
re-derive an hour of roformer nobody asked for or silently assemble the raw set.

## Coverage alignment — `--align`

**This door is now the ONLY one that queues an align row (2026-09-08.)** It was
the CLI's copy of a row the app composed into every narration run; Owen removed
that row — *"remove the align the narration checkbox. lets just have it
permanently do it that way. if the user wants an exact alignment they can hit
generate sentences on the bookforge library"* — after a two-hour CPU align held a
finished 16-hour book's assembly at 99 %. An app-rendered book now ships the
sentence cues assembly estimates for itself; measuring one is this command, or
the library's **Generate sentences** button on the finished m4b.

It force-aligns every rendered chunk
and writes `<processDir>/coverage.json`: text with no aligned audio is a
truncation, audio with no text is an insertion. It audits the WHOLE book and
always writes both outputs — a chunk it cannot place is recorded by name and its
sentences are cued proportionally over the chunk's real audio, marked as
estimates in the VTT. It exits 0 whenever the run happened.
`assemble/coverage_gate.py` **reports** what the file says and refuses nothing on
it (Owen, 2026-09-05); a missing report does not block assembly either.

It drives `coverage-align-job.runCoverageAlign`, the one function
`electron/queue-steps/align.ts` calls. **Nothing about the spawn lives in the
CLI**: `narrator align` is invoked by that job through `buildNarratorSpawn` and
the whisperx-env interpreter it resolves, and the report lands where
`coverageReportPath()` says — the same place both assembly spawns look for it. So
an alignment run from here satisfies an assembly run from anywhere.

```
python cli/bookforge-tts.py --align --project "<dir>" --align-language en
python cli/bookforge-tts.py --align --process-dir "<session>/<hash>" --align-language de
```

**`--align-language`, not `--language`, and it is required.** The aligner loads a
per-language wav2vec2 checkpoint; one pointed at the wrong language scores every
word badly, which the guard reads as *"the audio did not say the text"* and uses
to refuse a book that was read correctly. `--language` carries a render default
(`en`), so align gets its own flag rather than laundering that default into a
measurement. The app's own step refuses an absent language for the same reason.

CPU only, by design: `align/aligner.py` refuses CUDA by name while
`%APPDATA%\BookForge\external-gpu-job.lock` exists, and it does not want it —
RTF 0.082, a book in minutes. The whisperx add-on must be installed
(Settings → Add-ons); an absent one is refused here **before** the job starts.
(The narration dialog used to make the same plan-time check; it has nothing to
check since the align row left it on 2026-09-08.)

## The two enhancement passes — `--denoise`, `--rvc-enhance`

Each is its own queue row in the app, run between generation and assembly, and each
takes exactly one thing: a session's `processDir`. Name it with `--process-dir`, or
give `--project` and the project's **cached** session is resolved through
`reassembly-bridge.getBfpCachedSession` — the same fallback the app's own steps use.
A project with no cached render is refused by name, never approximated by scanning
the scratch root.

| Command | App function | What it writes |
|---|---|---|
| `--denoise` | `denoise-job.runFinalDenoise` (`queue-steps/final-denoise.ts`) | `chapters/sentences-denoised/` — gap-normalized, then the block roformer |
| `--rvc-enhance` | `rvc-job.runRvcEnhancement` (`queue-steps/rvc-enhancement.ts`) | `chapters/sentences-rvc-<voice>/` — the session's sentences through an RVC voice |

```
python cli/bookforge-tts.py --denoise --project "<dir>" [--sentence-gap 0.6]
python cli/bookforge-tts.py --rvc-enhance --project "<dir>" \
    --rvc-voice-id builtin:deathstalker-sigma --enhance-index-rate 0.3 \
    --enhance-protect-rate 0.1
```

`--sentences-dir` is one pass reading the OTHER's output (the "convert first, then
denoise" order and its mirror). The jobs **refuse** it alongside a gap value rather
than ignoring one of them: the gap can only be applied to raw audio, so a call
stating both is a composition bug.

**`--rvc-enhance` is not `--rvc`.** `--rvc` is
`rvc-bridge.convertFileRvcChunked` over ONE finished audio file — the memory-safe
whole-book reconstruction. `--rvc-enhance` is the pass over a session's
per-sentence cache, whose output assembly then reads via `--sentences_dir`. Two
different jobs; both are named rather than one standing in for the other. Their
tuning flags are spelled differently for the same reason (`--rvc-voice-id`,
`--enhance-index-rate`, `--enhance-protect-rate`, `--enhance-f0-method`), so an
unset value stays unset and urvc's own default applies, exactly as in the app.

## Correct Sentences — `--retake`

The app's Correct Sentences panel, headless: the same five exported functions its
five IPC handlers call. `--retake-action` picks one.

| action | app function | what it does |
|---|---|---|
| `list` (default) | `getCorrectSentencesSession` | the cache, cue by cue, with engine/voice and sample_fmt |
| `retake` | `generateCandidates` | renders N fresh takes per `--indices` into scratch |
| `commit` | `commitSentence` | swaps one take into the cache (original backed up once) |
| `revert` | `revertSentence` | restores from `.orig-backup/` |
| `cleanup` | `cleanupCandidates` | drops the candidate scratch |

```
python cli/bookforge-tts.py --retake --project "<dir>"                       # list
python cli/bookforge-tts.py --retake --project "<dir>" --index 120 --count 40
python cli/bookforge-tts.py --retake --project "<dir>" --retake-action retake \
    --indices 12,40 --takes 3
python cli/bookforge-tts.py --retake --project "<dir>" --retake-action commit \
    --index 12 --take "<scratch>/take2/12.flac"
python cli/bookforge-tts.py --retake --project "<dir>" --retake-action revert --index 12
```

`--sentence-text` re-renders (or commits) a sentence with DIFFERENT words; it
round-trips through the bridge's `storedTextForCorrection`, so the chunk keeps its
`[heading]` / `[item]` markers. Omitting it means the words did not change — a
different act from changing them to the same string. Every take is
sample_fmt-matched to the book's existing FLACs, so it drops into the cache without
breaking the concat. Ctrl+C aborts through the CLI's own `AbortController`, which is
what the app's IPC layer does too.

## Processing passes — `--pass`

Simplify, translate and footnote-refs as **project acts**: planned by
`processing-chain.planProcessingChain` and run by
`processing-passes.runProcessingPass`, the same pair `queue-steps/pass.ts` calls.
So the run stages, records its ledger row, writes provenance and promotes a working
copy — exactly as pressing the button does.

```
python cli/bookforge-tts.py --pass --project "<dir>" --kind footnote-refs

python cli/bookforge-tts.py --pass --project "<dir>" --kind simplify \
    --simplify-mode learner --provider ollama --model gemma3:12b

python cli/bookforge-tts.py --pass --project "<dir>" --kind translate \
    --source-lang en --target-lang de --provider claude --model claude-sonnet-4-5
```

`--family <id|stem>` names which book chain, and is required only when the project
holds more than one (a project with two archive EPUBs has two chains and nothing
guesses between them). The API key travels in the process env, never argv.

**Not `--ai-simplify`.** That drives `ai-bridge.cleanupEpub` over a LOOSE epub and
writes `simplified.epub` beside it — file in, file out, no project record.
`--pass --kind simplify` is the project act. **Not Foundry's "Clean text"** either:
that is a Foundry act on a Foundry project, ordered inside the hosted window — and
since 2026-09-08 it has its own headless door, `--clean` (below), which IS that press
rather than a second copy of it.

The fourth pass kind, `narration-text`, has its own command (`--narration-text`)
because it also has a bare-EPUB door. Both go through the same
`cli/processing-pass-step.js`.

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
  With `--checkpoint-dir` it is the BASE voice whose certificate the checkpoint borrows.
- `--input <file>` / `--text <str>` — what to render (one required for `--tts`; `--input`
  optionally overrides the resolved EPUB for `--audiobook`). `--tts` reads `.epub`,
  `.txt`/`.md` or `.jsonl` — see **Choosing the model** above.
- `--out <file.wav>` — output WAV (required for `--tts`; unused for `--audiobook`).
- `--project <dir>` — **`--audiobook` only**: the BookForge project; output lands in
  `<project>/output/<Title>. <Author>.m4b` (required for `--audiobook`).
- `--language <code>` — default `en`.
- `--mode {tts,streaming}` — render path for `--tts`; default `tts`. Both engines work
  on both paths; on `streaming`, `--engine` asserts the persisted selection rather than
  changing it.
- `--read-ahead <n>` — streaming only: how many following blocks to read ahead. Default is every remaining block, which is what the extension does on a page.

**Customization**
- `--tier {auto,extreme,fast,moderate,light}` — force the GPU memory tier
  (env `ORPHEUS_MEMORY_TIER`; default auto, safe-sized to free VRAM). Works in both modes.
- `--sentence-gap <sec>` — deterministic inter-clip gap on the **tts** path
  (env `ORPHEUS_SENTENCE_GAP`; default 0.6). Forwarded into the WSL worker, so it is
  the gap **baked into each FLAC at render time**. `--denoise`/`--rvc-enhance` pass it
  to the job as `FinalDenoiseConfig.sentenceGap` / `RvcEnhancementConfig.sentenceGap`,
  which is the same measurement re-laid on the raw cached sentences.
  **Not `--assembly-gap`**, which is the gap the pass in front of `--assemble`/
  `--audiobook`'s reassembly re-lays. Two passes at two different times; one flag for
  both would mean a value whose meaning depended on which command read it.
- `--model-dir <path>` — explicit ORPHEUS model directory, bypassing `models.json`
  resolution. Use the spawn target's namespace (a `/home/...` WSL path, or a `\\wsl$` /
  `C:\` path the bridge will translate). *Not needed for a registered voice like
  `rohan`.* Refused on `--engine higgs`, which names a checkpoint under test with
  `--checkpoint-dir`.
- `--checkpoint-dir <dir>` — **`--engine higgs`**: a checkpoint directory to render THIS
  run with, against `--voice`'s certificate. Mac/Linux: resolved here and must exist.
  Windows: a guest-native `/home/...` path, not stat'd. See **Choosing the model**.
- `--note <text>` — why this render was run, stamped onto the Higgs override. Default:
  the command as typed plus this machine's hostname.
- `--safe-band MIN-MAX` — **`--engine higgs`**: the chunk band in characters.
- `--top-k <n>` — **`--engine higgs`**: `higgsOverride.sampling.topK`.
- `--batch-width <n>` / `--mem-budget-gb <n>` — **`--engine higgs` on the Mac**: the MLX
  arm's group width and memory budget (`NARRATOR_HIGGS3_MLX_BATCH` /
  `NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB`). Refused on Windows, where the width is the
  catalog's server admission width (`HIGGS_MAX_NUM_SEQS`).
- `--as-chunks` — **`--tts` with a text/jsonl input**: one generation chunk per
  paragraph/row, narrated as printed.
- `--max-chunks <n>` — **`--tts` only**: cap generation at N chunks.
- `--title <str>` — **`--tts` with a text/jsonl input**: the packed book's title.
- `--library <root>` — **`--tts` only**: the library whose `tmp/` holds the sessions and
  the narration cuts. Default: the root recorded in `<userData>/library-root.json`; no
  recorded root and no flag is a refusal, never `~/Documents/BookForge`. Refused on
  `--audiobook`, which derives it from `--project`.
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
- `--dry-run` — print the resolved spawn, the Higgs override object and the env
  overrides, then exit; no GPU, no model. In `--mode tts` it also hands the dry run to
  the batch adapter, which PACKS the input book (CPU, a few kB) and prints the resolved
  `ParallelTtsSettings` before stopping short of the narration door and the bridge — so
  a text/jsonl render can be read back before it is paid for.
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

## Clean lines — a training corpus through the narration text cleanup (`--clean-lines`)

One transcript per line in, the same lines cleaned out **by position** — the three stages
the app's **Clean text** step runs on a book (punctuation spec, the number rules, the model on
every block), over a file of thousands of short items, in ONE process: the model loads once,
the context window is pinned once from the longest line, every line is asked at temperature 0,
and the model unloads at the end (Owen, 2026-09-07: *"model is loaded on start and unloaded on
completion"*). It is `foundry clean-text --book` behind a text file — BookForge writes a book
file with one paragraph block per line, spawns the same binary the hosted press spawns, with
the same model and endpoint out of `app-settings.json`, and zips the records back.

```bash
# lines.txt: one item per line. Output defaults to lines.cleaned.txt beside it.
python cli/bookforge-tts.py --clean-lines --input lines.txt --language en
python cli/bookforge-tts.py --clean-lines --input lines.txt --output cleaned.txt --language en
# Leave the model loaded afterwards (an Ollama shared with other work):
python cli/bookforge-tts.py --clean-lines --input lines.txt --language en --keep-model

# The node adapter directly:
node --require ./cli/electron-stub.js cli/clean-lines.js --input lines.txt --language en
```

What comes out:

- `<output>` — exactly as many lines as the input; blank lines stay blank, so line N out is line
  N in and a caller can zip it against an audio list by position.
- `<stem>.clean-lines/lines.records.jsonl` — the engine's records, one row per line keyed by
  the line's text and the model. **A killed run keeps them**: the next run finds the file and
  the engine asks only about the lines it has no answer for.
- `<stem>.clean-lines/lines.records.jsonl.receipt.json` — the receipt: model, spec versions,
  how many blocks were asked, how many answers failed to parse, and every edit's disposition
  (`APPLIED`, `APPLIED_RULE`, `NOT_A_READING`, ...). The summary line prints the counts.

Refusals, by name: a line the engine wrote no answer for is **never copied through** as if it
had been cleaned (the run fails naming the line numbers; run again); an answer holding a line
break cannot be written by position; a foundry older than 1.1.0 has no `--book` door;
`--model` is ignored with a note, because the pass takes its model from the app's settings so a
corpus and a book are cleaned by one setting. The number rules are deterministic: `1994`
becomes `nineteen ninety-four` whether or not the narrator said it that way — that is the
corpus doctrine, and the reason this door exists.

## Clean text step — `--clean`

**The hosted Foundry window's Clean text press, with no window.** Not a headless
re-implementation of it: the adapter calls the same compiled functions in the same
order the button walks through — `planCleanup` (`workspace:plan-clean`, which
materialises the position's own book and mints the records, stamp and step id), the
`CleanRequest` `clean-dialog.add()` composes field for field, and `runJob`, the seam
`queue-steps/foundry-job.ts` hands a Foundry row to. So it **lands a ledger step**,
writes the same records and stamp beside the project's readings, and a run can be
timed against the app it is a run of.

```bash
# Clean the book at the project's current position:
python cli/bookforge-tts.py --clean --project "/path/to/library/projects/<slug>"

# A specific model, eight blocks in flight, and see the spawn without touching a model:
python cli/bookforge-tts.py --clean --project "<dir>" \
    --model qwen3.5:9b-mlx-bf16 --concurrency 8 --dry-run

# The Foundry project directly, when the mapping is not the question:
python cli/bookforge-tts.py --clean --foundry-project "<library>/foundry/projects/<key>"

# The node adapter directly:
node --require ./cli/electron-stub.js cli/clean-step.js --project "<dir>" --dry-run
```

- `--project` is a **BookForge** project dir; its Foundry project is resolved the way
  the app resolves it — the manifest records a KEY (`foundryProject.dir`) and
  `<library>/foundry/projects` is where keys live. A book with no record has no Foundry
  project, and is refused by name rather than guessed at from its folder name.
- **Where it stands is where the project stands.** The step is `positionOf` the
  project's ledger, exactly as `LedgerService.standingIn` answers it in the window, and
  `canCleanFrom` is asked about it — a position the dialog would not offer the button
  from refuses here too.
- `--model` / `--ollama` override the settings the dialog seeds itself from
  (`cleanTextModel`, `ollamaUrl` in the app's own `app-settings.json`) — **not**
  `defaultLlmModel`, which names a 27b that cleans at a fifth of the 9b's rate.
- `--concurrency <n>` is the engine's own `--concurrency`: blocks in flight at once,
  absent meaning the engine's default of 4. It changes the **speed, never the text** —
  every block is asked the same question at temperature 0.
- **The model is released when the run ends.** `foundry clean-text` unloads the weights
  (`keep_alive: 0`) unless it is told the machine is shared, so a run that finishes
  hands the GPU back. `--keep-model` is the opt-in for several runs back to back, and is
  the only thing that puts `--keep-model` on the line.
- `--dry-run` prints the resolved project, the position and the step it will mint, the
  request as JSON and **the exact argv `runJob` would spawn** — composed by Foundry's
  own `argsFor`, never by a copy of it here — and spawns nothing. It still makes the
  plan, because an argv is a fact about a plan.
- The run prints `clean-text: N/M` as the engine counts blocks, then the elapsed
  seconds, the blocks/min, the stamp, and the ledger step it landed (id and label).
  Ctrl+C aborts through an `AbortController` — the same gesture the ✕ makes on a running
  row — and the records written so far are kept, so a re-run asks only about the blocks
  with no answer.
- **The engine is the locally-built one**, not the installed component. A CLI run is a
  dev run by construction, so the door primes `FOUNDRY_CLI_PATH` at
  `<foundry checkout>/dist/foundry-<platform>-<arch>` exactly as the app does under
  `isDev`, before `resolveFoundryPath()` is asked — an already-set `FOUNDRY_CLI_PATH`
  wins untouched. It matters: `--concurrency` arrived in foundry **1.2.0**, and the
  installed component can be months older. The dry run prints the binary *and* what
  `foundry --version` said, because a path cannot say which release is sitting at it.
- `--foundry-dist <dir>` names which built Foundry to drive. The default is
  `foundry-app/dist`, the vendored build the running app executes; a build that does not
  export `argsFor` is refused by name rather than fallen back from, because composing
  the command line here instead would be the parallel implementation this door exists
  not to be.

Not `--clean-lines`, which is this same engine command behind a *file of lines* and has
no project, no plan and no ledger. Not `--narration-text`, which cleans a loose EPUB
through BookForge's own chain. This one is the press.

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
  Numbering is tested *before* the punctuation gate, so `1.`, `12.` and `IV.` are
  caught too, and roman numerals use the real grammar plus a value cap — a character
  class like `[ivxlcdm]+` matches ordinary English words (did, dim, mild, civil, mix).

  > **The Title Case arm is a heuristic with known false positives.** A short
  > capitalized line that is really prose — `Mr. Smith`, `New York`, `Thank You`,
  > `Oh God` — will be tagged `heading`. It exists for publishers who set headings as
  > `<p class="cn">` / `<p class="ct">` with no semantic markup, and it cannot be made
  > exact from text alone. **`<h1>`–`<h6>` is the exact path**: those are tagged by
  > markup, with nothing inferred. Before wiring a cutter to *drop* `NOTE heading`
  > cues, decide whether that class of error is affordable on your books — or drop
  > only the cues that came from real heading tags and treat the heuristic ones as
  > advisory.
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
node tools/test-cli-parity.js                                                      # the WIRE, per command
node tools/test-cli-flags.js                                                       # the model-picking doors + every refusal
node --require ./cli/electron-stub.js tools/tests/test-epub-align-segmentation.js  # 79
python tools/tests/test_align_audiobook_timing.py                                  # 23
bash   tools/tests/test-cli-flag-parity.sh                                          # 29
```

Segmentation covers heading classification in both directions (numbering incl. `1.`
and `IV.`, and `<h1>`, are tagged; "Yes", `<li>Bread</li>`, "He said-", "The rules are:"
and roman-letter words like "mild"/"civil" are not), plus the `--no-paragraph-split`
regression. Timing covers snap bounds and the cue-overlap fix, scoring the SHIPPED
`build_events` against a pre-fix copy over 20k randomized start-sets. Flag parity checks
that `bookforge-tts.py` and `generate-sentences.js` accept and reject the same things —
with a guard assertion that the cases are reachable at all, since an earlier version
passed a nonexistent `--audio` and every case failed for that reason instead.

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

## Crucible — the inference server (`--crucible-*`)

[Crucible](../../crucible/docs/DESIGN.md) (`C:\Users\tellt\Projects\crucible`) is one
inference server for all of Owen's apps: it runs models and returns bytes, and it never
knows what an audiobook, a cleanup pass or a PDF conversion is. A client always speaks
HTTP to it — the PC's WSL2 server, the Mac across the room and a rented droplet are all
reached by exactly one code path, so BookForge's GPU features stop being Windows/WSL
path-rewriting and become job types someone else's machine can serve.

**Phase 1 is the handshake, and the CLI is its only consumer.** Nothing in the app calls
this yet: no UI, no IPC, no settings row. `electron/crucible/servers.ts` is the registry
(`<userData>/crucible-servers.json`), `cli/crucible.js` is the adapter over the compiled
copy of it, and `@crucible/client` — pinned in `package.json` to the release tarball, so
the URL *is* the version — is everything on the wire. The only job type is `echo`, which
hands the bytes back: no model is loaded and no GPU is touched.

```
bookforge-tts --crucible-add --name N --url U (--token T | --token-file FILE)
bookforge-tts --crucible-remove --name N
bookforge-tts --crucible-list
bookforge-tts --crucible-ping   --server N     # unauthenticated: is there a Crucible there?
bookforge-tts --crucible-info   --server N     # backend, GPU, capabilities
bookforge-tts --crucible-health --server N     # status, queue depth, resident models
bookforge-tts --crucible-echo   --server N --file FILE [--out FILE]
```

**The token is never printed.** `--crucible-list` shows `****` plus its last four
characters, and the type the registry returns for a listing cannot carry a plaintext
token at all. `--token-file` exists so the token need not be typed: a token on a command
line is a token in the shell history — and even with `--token`, the spawn line this CLI
echoes shows `****`.

**Worked example — the Mac Studio's GPU from this PC.** Start a server on the Mac
(`crucible init --enable-echo`, `crucible serve --host 0.0.0.0 --port 7100`), put the
token from `crucible token --show` in a file, and:

```
$ bookforge-tts --crucible-add --name mac \
      --url http://owens-mac-studio.hs.owenmorgan.com:7100 --token-file mac-token.txt
added mac  http://owens-mac-studio.hs.owenmorgan.com:7100  token ****Ebi8

$ bookforge-tts --crucible-info --server mac
server        crucible@mac-studio  v0.1.0  api v1
host          darwin/arm64
backend       mlx-darwin
gpu           apple Apple M1 Ultra  64.0 GiB
capability    echo  —  no models

$ bookforge-tts --crucible-echo --server mac --file sample.bin --out back.bin
[crucible] mac http://owens-mac-studio.hs.owenmorgan.com:7100: echo sample.bin (1.00 MiB)
[crucible] job dba54941b2914114a35c79e165190a7e
[crucible] #1 queued {"position":1}
[crucible] #2 progress {"fraction":0,"message":"started"}
[crucible] #3 progress {"fraction":0,"message":"copying sample.bin"}
[crucible] #4 artifact {"name":"sample.bin"}
[crucible] #5 progress {"fraction":1,"message":"echoed 1 input(s)"}
[crucible] #6 done {"artifacts":["sample.bin"]}
artifact    ...\back.bin  (1.00 MiB)
provenance  ...\back.bin.provenance.json  —  crucible@mac-studio v0.1.0, backend mlx-darwin, job_type echo
identical   1048576 bytes round-tripped through mac
```

(Measured 2026-09-12, from the PC: the client is native Windows, the server is on the
Mac Studio over the headscale tailnet, and the 1 MiB round trip came back with the same
sha256. The `#N` numbers are the server's own monotonic SSE event ids, so a dropped
connection can be resumed without losing or repeating one.)

`--crucible-echo` exits 0 **only** if the returned bytes are identical, and it writes the
provenance sidecar beside the artifact verbatim — snake_case keys, exactly as the server
wrote them (DESIGN.md section 7). Every SDK failure has its own one-line message and exit
code 1: unreachable, not-a-crucible, wrong token, wrong API version, a refusal the server
named, a 5xx, or a payload API v1 does not describe. Nothing is retried and nothing is
defaulted.

## Gotchas

- **Git Bash mangles `/home/...` args.** MSYS rewrites a Unix-style path passed to a
  Windows `python.exe` into `C:/Program Files/Git/home/...`. Pass WSL paths (e.g.
  `--model-dir /home/...`) from **PowerShell or cmd**, or prefix the Git Bash command
  with `MSYS_NO_PATHCONV=1`.
- **Don't run while the GPU is busy** (a training run, another render). The pipeline's
  VRAM preflight will wait or abort with a message, but co-residency can still crash a
  training job. Free the GPU first.

## Extending

`COMMANDS` in `bookforge-tts.py` is a registry — one entry per job (`tts`,
`audiobook`, `assemble`, `denoise`, `rvc-enhance`, `retake`, `pass`, `prep`,
`align`, `narration-text`, `clean-lines`, `clean`, `ai-cleanup`, `ai-simplify`,
`generate-sentences`, `generate-epub`, `rvc`).

**Which app actions have a command, which do not, and why:**
`docs/CLI_PARITY_AUDIT.md`. It is the table `tools/test-cli-parity.js` defends —
every adapter must require the COMPILED bridge and call the exact symbol the app's
queue step calls, and that symbol must really be exported by the compiled module.

Three adapters keep grammars of their own and are run directly, because wrapping
them in this flat flag namespace would mean inventing a second spelling for every
option they already have (they are named in the `--help` epilog):

```
node cli/library.js --list | --import-epub | --add-version | --set-primary | ...
node cli/clipforge-process.js [speakers|narration|verify|merge|split|sentences] ...
node cli/serve-bookshelf.js
```
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
