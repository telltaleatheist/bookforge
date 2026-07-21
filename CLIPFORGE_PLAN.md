# ClipForge — Training-Audio Prep Studio (working name)

**Status: SPEC (2026-07-20).** Agreed with Owen: second Angular app in the
BookForge workspace (bookshelf precedent), full pipeline in v1. The Enhance
tab's job migrates here — BookForge keeps its in-pipeline `finalDenoise`
backend, but the interactive cleaning workbench becomes its own app.

## Purpose

One place to turn raw source audio (audiobook masters, stream recordings)
into training-ready datasets for Orpheus, RVC, or anything else — with the
EAR in the loop before anything is committed, and every decision recorded.
It encodes the locked recipes from `orpheus-finetune/VOICE_TRAINING_PIPELINE.md`
and `RVC_TRAINING_PIPELINE.md` as enforceable presets.

## Trust model (Owen, 2026-07-20 — this shapes every feature)

ClipForge is an ACCELERANT, not an authority. Owen does not trust a system
that does it all independently; the checking and slicing decisions stay with
him + Claude. Concretely:

- **Everything is copy-out-able.** Clip maps, recipes, QC reports, and
  manifests are plain text/JSON with one-click "copy for Claude" — designed to
  be pasted into a Claude session where the real verification/slicing happens.
- **The app never modifies sources** and never advances a stage without an
  explicit commit; auto-anything only produces a PROPOSAL artifact.
- Its job is speed: extract a probe, chain some processing, LISTEN in seconds,
  export the evidence. Not to be a pipeline that runs unattended.

## Architecture

- **Second Angular app** at `projects/clipforge/` (exactly like
  `projects/bookshelf/`): own window + entry point, shared electron main.
- Shares BookForge's **component system, conda envs, tool-paths, GPU lock**.
  No duplicated runtime; ClipForge IPC namespaced `clipforge:*`.
- All processing runs through the existing spawn bridges (audio-separator,
  resemble-enhance, urvc, ffmpeg). New: auto-editor (check availability in the
  bundled env; add as a component if missing).
- Python QC/corpus scripts are vendored under `electron/scripts/clipforge/`
  (ports of `orpheus-finetune/pipeline/*` — pure numpy/soundfile, portable)
  and run via the existing env resolution. NO FALLBACKS anywhere (project rule).

## Data model — Collections

A collection = one voice/source pool ("deathstalker", "stream 2026-07-12").
On-disk root is user-configurable (big files live on E:), one dir per
collection:

```
<root>/<collection>/
  manifest.json      # sources (path+hash+native rate), recipes run, exports
  sources/           # original uploads (never modified)
  probes/            # 1-min probe extracts + per-stage processed renders
  recipes/           # saved chains + settings (JSON, versioned)
  clipmaps/          # auto-editor outputs (JSON + human-readable text)
  qc/                # scanner reports
  output/            # committed full renders / cut clips / built corpora
```

**Provenance is non-negotiable:** every commit writes the exact chain,
settings, tool versions, and source hashes next to the output. (The RVC
v1-blur archaeology happened because prep was unrecorded. Never again.)

## Core loop (the whole point)

1. Upload big file(s) → collection. Native sample rate probed and DISPLAYED;
   resampling never happens silently.
2. App extracts a 1-minute probe (position selectable; multiple probes ok).
3. **Chain editor**: ordered steps — roformer denoise, dehum, resemble-enhance,
   RVC convert, HP/EQ (LP guarded), gate, loudness — each with full settings.
4. **Live audition**: probe rendered through the chain with per-stage caching —
   A/B against original, solo any stage, loop a region, waveform + spectrogram
   (Spek-style; we eyeball rolloff/birdies constantly).
5. Happy → **commit**: full-source render in the background (GPU-lock aware).
6. **Clip map**: auto-editor defines cut points; map saved as JSON + pasteable
   text (for handing to Claude); clips previewable in-app; user commits cuts.

## CLI (first-class, not an afterthought)

Everything the GUI can do to audio, a CLI can do headlessly (precedent:
`cli/bookforge-tts.py`). Pass a collection + source + chain settings (inline
flags or a recipe JSON) and it renders probes/samples with those settings —
so Claude can grid-sweep settings arms and hand Owen a folder of labeled
samples to ear-test, exactly like the manual campaign workflow but in one
command. The chain-execution engine is ONE shared module; the GUI and CLI are
both thin frontends over it. CLI output paths land inside the collection
(probes/ with recipe-tagged names) so provenance still holds.

## Speaker bucketing (`speakers` CLI verb)

**Status: BUILT + test-validated (2026-07-21, CPU).** Separates a pile of clips
into per-voice-actor buckets so a multi-narrator source (or a mixed clip library)
can be split before training. It is an ACCELERANT: it deliberately OVER-splits
(never merges two different real actors) and the human merges the fine clusters
afterward by auditioning exemplars.

### Design contract — CERTAINTY OVER QUANTITY (Owen, 2026-07-21)

Every decision boundary is tuned CONSERVATIVE. A clip lands in an actor
`cluster_NN/` (or in `music/`) ONLY when the signal is clear; ANY doubt sends it
to `uncertain/` instead. The worst outcome is a FALSE ASSIGNMENT into an actor
bucket — a training corpus silently contaminated by another voice. An inflated
`uncertain/` bucket is CHEAP: the human triages it by ear in minutes. So:

- `music/` captures only the clear music-bed clips; ambiguous ones stay in
  `uncertain/`. Do NOT chase recall — 0 false positives on clean voice is the
  hard requirement, missed borderline music is acceptable.
- Cluster assignment uses a margin gate (`--uncertain-margin`): if a clip is not
  decisively closer to its own actor centroid than to the next, it goes to
  `uncertain/`, never force-assigned.
- Over-splitting (one actor across several fine clusters) is likewise preferred
  over ever merging two actors. The human merges; the algorithm never guesses.

### What it does

Given either a DIRECTORY of clip wavs or ONE long audiobook file (m4b/flac/mp3):

- **Single-file mode**: decodes to 16 kHz mono via the bundled ffmpeg, then slices
  into 3–20 s segments AT SILENCES (librosa `effects.split`, deterministic),
  recording each segment's source offset.
- **Directory mode**: uses the wavs as-is (resampled to 16 k mono in-memory for
  embedding); sources are COPIED into buckets, never moved/modified.
- Embeds every clip with resemblyzer's `VoiceEncoder` (whole-clip embedding +
  sliding ~1.6 s window embeddings at ~50 % overlap).
- **Music detection** (background-music bed) → `music/`. Runs BEFORE clustering on
  the RAW clip audio (HPSS harmonic-energy fraction); music clips are excluded from
  clustering so they can't pollute an actor centroid.
- **Mixed detection** (dialogue = >1 actor in one clip) → `mixed/`.
- **Agglomerative clustering** of single-voice, music-free clips →
  `cluster_01/ … cluster_NN/` (cosine distance, average linkage, distance cut =
  `--cluster-threshold`).
- **Uncertain** (ambiguous assignment) → `uncertain/`.
- Writes `<out>/speakers.json` (package versions, all thresholds, per-clip records,
  per-cluster stats + 3 exemplars) and `<out>/speakers.provenance.json` (the
  invocation itself), and prints a summary table to stdout.

**Bucket precedence: music > mixed > cluster/uncertain.** Music and mixed are both
decided before clustering; a music-flagged clip goes to `music/` even if it is also
multi-voice, because a music bed is the dominant disqualifier (it contaminates any
actor centroid regardless of how many actors speak over it).

### Env setup (dedicated conda env — do NOT touch e2a-env or bookforge-urvc)

```
C:\Users\tellt\Miniforge3\Scripts\conda.exe create -n clipforge-speakers python=3.11 -y
C:\Users\tellt\Miniforge3\envs\clipforge-speakers\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
C:\Users\tellt\Miniforge3\envs\clipforge-speakers\python.exe -m pip install resemblyzer soundfile librosa scipy webrtcvad-wheels setuptools<81
```

Notes: torch is the CPU wheel (CPU-only pipeline). `webrtcvad-wheels` (not
`webrtcvad`, which fails to build on Windows) provides the `webrtcvad` import
resemblyzer needs; it imports `pkg_resources`, so `setuptools<81` must be present
(newer setuptools removed it). The CLI hardcodes
`C:\Users\tellt\Miniforge3\envs\clipforge-speakers\python.exe` as the DEFAULT but
FAILS LOUDLY with this install hint if it is missing (no silent fallback) —
override with `--python <python.exe>`.

### CLI usage

```
node cli/clipforge-process.js speakers --input <file-or-dir> --out <dir> \
    [--cluster-threshold 0.28] [--mixed-threshold 0.55] [--mixed-min-frac 0.20] \
    [--music-threshold 0.60] [--uncertain-margin 0.05] [--min-clip 3] [--max-clip 20] \
    [--top-db 30] [--window-rate 1.25] [--device cpu] [--python <python.exe>] [--ffmpeg <ffmpeg.exe>]
```

The `speakers` verb sits beside the default (verb-less) chain runner in the same
`cli/clipforge-process.js`; the JS side validates args, locates the env python +
ffmpeg, and shells out to `cli/py/speaker_buckets.py` (the real worker).

### Threshold meanings (defaults MEASURED on the null test, not guessed)

- `--cluster-threshold 0.28` — cosine-distance cut for agglomerative clustering.
  LOWER = more (finer) clusters. Measured: same-actor whole-clip pairwise cosine
  distance is tight (median 0.072, p95 0.151, max 0.301) while different actors sit
  far higher (~0.4+), so 0.28 keeps one actor together yet can never merge two.
  Err toward over-splitting — a bit low is safe, too high risks under-splitting.
- `--mixed-threshold 0.55` — a clip's windows are split into 2 groups (k-means) and
  the cosine between the two group centroids is taken. One actor keeps the two
  centroids similar (measured floor ~0.60 on a single narrator); two actors drive
  them apart (~0.2–0.4). Below 0.55 (AND `--mixed-min-frac` satisfied) ⇒ `mixed/`.
  **DEVIATION from the original spec (min-pairwise window cosine), with measured
  cause:** on the single-narrator null test the min-pairwise statistic spans
  0.27–0.69, overlapping any plausible two-actor value — it CANNOT separate single
  from mixed (setting the spec's ~0.78 flagged 100 % of a one-narrator source as
  mixed). The 2-means centroid separation is a clean separator. The min-pairwise
  value is still recorded per clip as `self_consistency` for inspection.
- `--mixed-min-frac 0.20` — the smaller of the two window-groups must be ≥20 % of
  windows for a clip to count as mixed. Leaves a lopsided straddle (mostly actor A
  + a few words of B) to cluster with its dominant actor instead of `mixed/`.
- `--music-threshold 0.60` — a clip's HPSS harmonic-energy fraction (fraction of
  spectral energy that is sustained/tonal rather than percussive) computed on the
  RAW clip. A background-music bed adds sustained tonal energy that persists through
  the narration's pauses, pushing this up. Above 0.60 ⇒ `music/`. **Measured:** on a
  single-narrator null test (no music) this tops out at 0.55 (top values 0.547,
  0.550), while ad/music clips reach 0.69; the 94-clip ceiling with a 0.05 margin is
  0.60, giving 0 false positives on clean voice (the hard requirement) while flagging
  only the clearest music beds. Per the certainty-over-quantity contract, borderline
  0.55–0.60 clips deliberately stay in `uncertain/`, not `music/`. Recorded per clip
  as `music_score`. (HPSS beat two alternatives measured on the same sets —
  pause-region spectral flatness and chroma stability both overlapped between the
  clean and music sets and could not hit 0 false positives; a chroma second-gate
  added nothing over HPSS alone, so the detector stays single-signal and cheap:
  one STFT + one HPSS per clip.)
- `--uncertain-margin 0.05` — a clip whose (own-centroid − nearest-other-centroid)
  cosine similarity is below this is ambiguous ⇒ `uncertain/` instead of a cluster.
  This is the certainty-over-quantity gate for actor assignment: raise it to send
  MORE borderline clips to `uncertain/`; never lower it to force thin assignments.
- `--min-clip 3 --max-clip 20 --top-db 30` — silence-slicing bounds (single-file
  mode). `--window-rate 1.25` ⇒ ~1.6 s windows at ~50 % overlap.

### Interpretation workflow (human in the loop)

1. Read the stdout table / `speakers.json` `clusters[]` — each has size,
   total_seconds, and 3 central `exemplars`.
2. Audition the exemplars per cluster. Name the actor, or MERGE clusters that are
   the same actor (over-splitting is EXPECTED — character voices/accents by one
   actor legitimately land in separate fine clusters; merging is a human call, and
   the algorithm's hard rule is only that it never lumps two DIFFERENT actors into
   one cluster).
3. Check `music/` (clips with a background-music bed — ads, intros/outros, scored
   sections; usually re-cut or drop for training), `mixed/` (dialogue /
   narrator-handoff straddles — usually re-cut or drop), and `uncertain/` (the
   catch-all for anything the boundaries were not confident about — assign by ear).

### Tests (2026-07-21, CPU — re-run after adding music detection)

- **Null test** (30 min of a single narrator, `E:\mm_build\markedman_raw_leveled.flac`
  @ `-ss 3600 -t 1800`): 94 segments → **cluster_01 = 94 (100 %)**, **music 0**,
  mixed 0, uncertain 0. PASS (≥90 % one cluster, ≤5 % mixed, **0 music false
  positives** — the hard requirement). This run calibrated the thresholds.
- **Ender's Game** (full 12 h m4b, multi-narrator): 2248 segments →
  cluster_01 1853 (9.49 h), cluster_02 189 (0.98 h), cluster_03 6, cluster_04 2,
  cluster_05 1, **music 116 (36 min)**, mixed 2, uncertain 79. Exemplars per cluster
  in `E:\cliplibrary\speaker_tests\ender_game\speakers.json`.
  - **What music detection changed** (measured against an identical music-OFF run —
    slicing is deterministic so the two are directly comparable): the 116 music clips
    came 108 from what had been ACTOR CLUSTERS + 8 from the old `uncertain/`. The big
    catch was **cluster_02, which was 99/287 (34 %) music-contaminated** — resemblyzer
    had grouped music-bed clips by their shared music signature, not by voice; those
    99 are now in `music/` and cluster_02 (287→189) is a cleaner second-narrator set.
    The main narrator cluster_01 lost only 6/1854 (0.3 %) to music — near zero, as
    expected for clean narration.
  - Of the 91 clips Owen flagged as "ads/music", only **8 were true music beds**
    (→ music/); **78 stayed in `uncertain/`** because they are clean voice-over
    (start/end-of-book ads / a different reader with NO music) — correctly NOT forced
    into music/ per the certainty-over-quantity contract; the human assigns them by
    ear. (5 became confidently clustered once the music clips stopped skewing the
    centroids.)

## Presets with GUARDRAILS (not just defaults)

- **Orpheus training**: bans resemble-enhance / RVC / low-pass in the chain
  (measured poison for training even though they sound fine); native rate
  enforced; breath handling per run-book.
- **RVC training**: native rate enforced (the 44.1k→48k blur lesson), internal
  silence truncated to 0.15–0.25 s, no EQ/compression/limiting, at most ONE
  denoise pass, 45-min export cap with even spread.
- **Free mode**: everything available, warnings instead of bans.
Presets ARE the locked recipes — a preset's bans cannot be toggled off without
switching to Free mode.

## QC dashboards (numbers, not just ears)

Per-collection scan runner over the FULL source, with pass/warn bounds from
the run-books: ring/tonal scan to 12 kHz, spectral tilt, brightness census +
spread, breath-edge census, pause mass, reverb decay, true bandwidth, duration
stats. Every defect that burned us was statistical and inaudible in one
minute — the dashboard is how a source gets rejected BEFORE training wastes a
day.

## Engine-specific finish lines

- **Orpheus corpus build** (port of `build_2h_corpus.py` flow): brightness
  curation to target hours with spread narrowing, breath-safe edges, hiss bed
  (HP120/no-renorm/-65 dB/random offsets), punctuation-scaled tails, 19.9 s
  ceiling, corpus report. Requires (audio, transcript) pairs — v1 imports the
  dataset dir produced by the existing align/correct/cut pipeline; in-app
  alignment is a later phase.
- **RVC seed export**: the rewritten `build_rvc_seeds.py` behavior in-app
  (native rate + probe-abort, silence truncation, even-spread 45-min cap).

## GPU arbitration

Reuses BookForge's GPU lock. When a trainer owns the GPU: previews/commits
queue with a visible "GPU busy (training)" state. CPU processing only by
explicit user choice — never a silent fallback.

## Build phases (each reviewable on the branch)

1. **Scaffold**: app + window + collections + upload + probe + playback.
2. **Chain engine** (shared module) + engine bridges + **CLI** + chain editor
   UI + live A/B + commit + provenance.
3. **Clip map** (auto-editor) + clip preview + cut commit.
4. **QC dashboards** + spectrogram viewer.
5. **Presets + guardrails.**
6. **Orpheus corpus build + RVC seed export.**
7. **Enhance tab migration** out of BookForge (last, so BookForge stays whole
   during the campaign).

Branch: `feat/clipforge`. Delegated builds per phase, reviewed before the next
phase starts. Do not merge to main until Owen has driven it.

## Build & run (phase 1)

**ClipForge is WINDOWS-ONLY.** Windows is the only training machine, so there is
no macOS support and no `package:mac` analog — do not add darwin branches to any
ClipForge code.

- **Dev:** `npm run clipforge:electron:dev` — the analog of BookForge’s
  `electron:dev`. It builds the electron code, serves the clipforge Angular app on
  port **4270** (BookForge uses 4250), waits for it, then launches
  `electron . --clipforge`, which opens ONLY the ClipForge window for a clean
  single-app session.
- **Prod UI build:** `npm run build:clipforge` → `dist/electron/clipforge-ui`
  (folded into `build:electron`; unpacked from the asar like `bookshelf-ui`). The
  packaged window loads that build via `loadFile`.
- **Packaging:** there is deliberately **no `clipforge:package:win-x64` yet.** A
  standalone ClipForge installer is part of the later packaging phase; adding a
  stub now that only packages BookForge would be dishonest (NO-FALLBACK rule).
  When the packaging phase lands, wire it through `packaging/package-win.js`.
