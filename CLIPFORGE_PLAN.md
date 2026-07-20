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
