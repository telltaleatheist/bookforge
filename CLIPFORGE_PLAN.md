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

## Adobe-Podcast round-trip (`merge` + `split` CLI verbs)

**Status: BUILT + test-validated (2026-07-21, CPU).** A two-verb pair that lets a
pile of training clips make a round-trip through Adobe Podcast Enhance and come
back cut on the ORIGINAL clip boundaries. Adobe Enhance is a strong cleaner, but
it only accepts one upload at a time and it REGENERATES speech (a generative
model, not a filter): it always returns 48 kHz and MAY subtly shift local timing.
So we assemble many clips into one file, enhance that, and split it back apart —
without ever letting Adobe's regeneration smear across clip seams, and without
guessing where a shifted boundary went.

```
clips ──merge──▶ one.wav + one.wav.mergemap.json
                     │
              (upload to Adobe Podcast Enhance → enhanced.wav @ 48 kHz)
                     ▼
enhanced.wav ──split (+ mergemap)──▶ per-clip wavs + splitmap.json (drift report)
```

Both verbs sit beside `speakers` in `cli/clipforge-process.js` and delegate the
audio work to `cli/py/clip_mergemap.py` (the shared worker), run in the same
dedicated `clipforge-speakers` conda env (it already has numpy + soundfile; the
JS side FAILS LOUDLY with an install hint if the python is missing — no silent
fallback). The JS side validates args, spawns the worker, relays its
STAGE/RESULT lines, and writes a `.provenance.json` next to the output exactly
like `speakers` does.

### `merge` — assemble clips into one file (at full source quality)

```
# selection mode A — an explicit ordered list of clips
node cli/clipforge-process.js merge --list <paths.txt> --out <out.wav> [--gap 0]

# selection mode B — reproduce a speakers-bucket assembly, cut from the ORIGINAL
node cli/clipforge-process.js merge --speakers <speakers.json> --bucket cluster_01 \
    --source <original.m4b/flac> --minutes <N> --out <out.wav> [--gap 0] \
    [--ffmpeg <ffmpeg.exe>]
```

Exactly one selection mode is required (passing both, or neither, FAILS loudly).

- **`--list`**: newline-delimited ABSOLUTE paths of wav/flac clips, merged in
  file order. All inputs must share sample rate AND channel count — a mismatch
  FAILS loudly listing the offenders; there is NO silent resampling.
- **`--speakers`/`--bucket`/`--source`/`--minutes`**: takes the TOP-confidence
  clips of that bucket from a ClipForge `speakers` run (confidence = the
  assignment margin recorded in `speakers.json`; a single-cluster run records
  `null`, which means "unambiguous" and is treated as maximally confident — not
  a fallback) until `--minutes` accumulate, sorts the selected clips by
  `source_offset`, and cuts each segment FROM THE ORIGINAL SOURCE at full
  quality (`-ss <source_offset> -t <duration>`, native rate/channels). The
  16 kHz embedding-grade bucket wavs are never merged this way — only via
  `--list` if the caller explicitly points at them.

Output is `pcm_s16le` at the source's sample rate/channels. Reads/writes int16
exactly (no float round-trip), so a merge→split round-trip on an UNMODIFIED file
is sample-identical. Alongside `<out>.wav` it writes `<out>.wav.mergemap.json`:
schema version, the exact invocation, source mode, gap value, distinct-source
sha256s (each file hashed ONCE, not per segment), and per-segment records
{index, source path + sha256, source_offset+duration when cut from a source,
start/end seconds in the merged timeline with gaps accounted for, original clip
filename, total duration}.

#### The `--gap` rationale (why insert silence you then remove)

`--gap <seconds>` (default 0) inserts that much digital silence between segments.
Adobe's regeneration is CONTEXT-BASED: a hard join between two discontinuous
utterances can smear regeneration artifacts ACROSS the boundary (the model reads
the end of clip A as the run-up to clip B). A short gap gives each clip a clean
seam. `split` removes the gap again — excising exactly the inserted amount,
split at the trough — so it never reaches training data. The gap is also what
makes the split boundary DETERMINISTIC (see below): with a gap, the trough is a
flat digital-silence plateau centred on the intended cut; without one, split
must rely on whatever natural silence happens to sit near the boundary.

### `split` — cut the enhanced file back on the original boundaries

```
node cli/clipforge-process.js split --input <enhanced.wav> --map <x.mergemap.json> \
    --out <dir> [--snap-window 0.5] [--tolerance 1.0]
```

1. **Duration check FIRST.** If `|enhanced duration − mergemap total| > --tolerance`
   (default 1.0 s), FAIL loudly — Adobe truncated or padded the file and the
   boundaries can no longer be trusted. Never guess.
2. **Snap each join to its silence trough.** For each seam (between segment i and
   i+1) the expected cut point is the gap centre (or the shared boundary when
   `--gap 0`). Search `±--snap-window` (default 0.5 s each side) for the
   minimum-RMS trough (short-frame RMS — 20 ms frames, 5 ms hop — auto-editor
   style) and cut THERE. The trough resolves to the CENTRE of the low-RMS
   plateau, so a flat digital-silence gap cuts at its middle (needed for
   symmetric gap excision), not at its leading edge.
3. **Drift log.** Every join records expected-vs-snapped position; the signed
   drift is the EMPIRICAL answer to "does Adobe shift timing?" Surfaced on stdout
   (max/mean |drift|, signed range) and per-join in `splitmap.json`.
4. **Gap excision.** With `--gap g`, each side is pulled back `g/2` FROM THE
   TROUGH — removing exactly the inserted `g` of silence while leaving each
   clip's OWN natural edge silence untouched (that silence is training data). The
   pull tracks drift because the trough moved with the content.
5. **Certainty-first failure.** If a join's trough is not meaningfully quieter
   than its surroundings (< 12 dB below the window's 90th-percentile speech
   level) there is NO silence there — the file is misaligned — and split FAILS
   loudly naming the join index, both clip names, and the expected time. It never
   mis-cuts silently. Output preserves the enhanced input's sample rate (no
   resampling — the downstream training cut handles that); each wav is named
   after its original clip filename from the map; `splitmap.json` records the
   drift stats + per-segment output records.

### Certainty over quantity (same contract as `speakers`)

`split` would rather stop and name the problem than emit a plausible-looking
mis-cut. A duration mismatch, a join with no silence, a collapsed segment, a
duplicate clip name, or a missing mergemap field each ABORT with a specific
message. The drift log exists so a marginal-but-passing run is still visible to
the human, not hidden.

### Tests (2026-07-21, CPU — 10 real clips from ender_game/cluster_01)

- **Null round-trip, `--gap 0.5`**: merge 10 wavs, split the UNMODIFIED merged
  file. **All 10 recovered segments sample-identical** (PCM-hash match), drift
  **0.0000 s** at every join. PASS — the pure-zero gap gives a plateau centred
  exactly on each intended boundary, so the symmetric `g/2` cut is exact.
- **Null round-trip, `--gap 0`**: split is a LOSSLESS whole-file partition
  (concat of outputs == merged file, bit-exact) and every cut lands in genuine
  silence (troughs 30–45 dB below speech). Per-segment recovery is NOT
  sample-identical here, and that is EXPECTED: these clips are voiced-boundary
  cut (librosa silence-split → segment edges are voice on/offsets, some start
  mid-speech), so the concatenation boundary is not itself the local silence
  minimum; split snaps each boundary to the nearest trough (max drift 0.265 s
  into an adjacent internal pause). Content is bit-identical modulo that
  integer silence-shift (best-shift normalized xcorr **1.00000**). This is the
  concrete argument FOR `--gap`: with a gap the boundary is deterministic; the
  spec's assumption that arbitrary clips are silence-edged does not hold for
  voiced-boundary cuts, so gap>0 is the robust mode for the Adobe workflow.
- **Drift robustness (+120 ms prepended via ffmpeg)**: split SNAPS CORRECTLY,
  reporting drift **+0.1200 s at EVERY join** (exactly the injected shift).
  Interior segments 2–10 remain bit-identical (the trough tracked the shift);
  segment 1 carries the 120 ms leading pad because no join precedes it to snap
  against — correct, and the drift log makes the global shift obvious. (Shifts
  larger than `snap-window + gap/2` move the trough out of the window; the seam
  then fails the misalignment gate rather than mis-cutting — verified by filling
  one join's window with continuous noise → "no silence trough — 0.7 dB below
  speech, need ≥ 12".)
- **Bucket mode**: `--bucket cluster_02 --source <ender m4b> --minutes 0.5
  --gap 0.4` cut 2 segments from the m4b at NATIVE quality (44.1 kHz stereo),
  sorted by `source_offset`, single source hashed once; round-trips through
  split (44.1 kHz stereo preserved, drift ~1 frame).
- **Failure paths, each FAILS loudly, exit 1**: heterogeneous sample rates in
  `--list` (names the 22 kHz offender); enhanced duration outside tolerance
  (`+1.500 s > 1.0 s`); missing mergemap field (segment-level and top-level);
  misaligned join with no silence.

## Accurate per-clip transcripts (`sentences` CLI verb)

**Status: BUILT + test-validated (2026-07-21, CPU).** Attaches the BOOK's exact
words to each training clip, so an Orpheus/XTTS corpus trains on author-correct
text (proper nouns and all) instead of ASR guesses.

### Doctrine (Owen, verbatim)

> "we should always be using sentence generation to get exact text for orpheus
> training."

ASR alone gets proper nouns wrong — on the Marked Man test set faster-whisper
consistently mis-hears the surname **Kalakos** as "kolakos" and **Thalassa** as
"talasa". The epub has the truth. So this verb's output text is the EPUB's words
wherever alignment is CONFIDENT, and (per the same **certainty-over-quantity**
contract as `speakers`/`split`) a clip that cannot be placed with confidence is
flagged `uncertain` and gets **NO text row** — never a best-guess transcript.
Ads / intros / outros legitimately have no epub match; those are the expected
`uncertain` case (the e2a sentence-generation logic marks such regions
`asr-fallback`; same philosophy).

```
node cli/clipforge-process.js sentences --clips <dir-or-list.txt> --epub <book.epub> \
    --out <dir> --speaker <name> \
    [--book-vtt <vtt> --spans <json>]   # => MAP mode; absent => ANCHOR mode
```

Output (audio is NEVER copied or modified — text only):
`<out>/metadata.csv` (`audio_file|text|speaker_name`, only OK clips get a row;
`audio_file` is the clip's absolute path since the audio stays put),
`<out>/sentences.report.json` (per-clip mode/status/reason/diagnostics + summary
counts), and `<out>/sentences.provenance.json` (the invocation) written by the JS
side. The JS verb sits beside `speakers`/`merge`/`split` and delegates to
`cli/py/clip_sentences.py`.

### Two modes

**MAP mode** (`--book-vtt <vtt> --spans <json>`) — the clip's position in the
BOOK timeline is already known (a full-book sentence-VTT alignment exists). This
generalizes the main session's prototype `C:\tmp\ender_corpus_from_vtt.py`.

- `--spans` accepts EITHER a ClipForge `speakers.json` (uses each clip's
  `source_offset`/`duration`) OR a plain `{name: {offset, duration}}` object;
  the shape is auto-detected and it **dies loudly on neither** (no silent guess).
- Text for a clip = the book-VTT cues whose MIDPOINT falls inside the clip's span
  (± `--edge-tol`, default **0.35 s**). A cue that straddles the clip boundary by
  more than `edge-tol` ⇒ the clip is `uncertain` (partial-sentence audio must
  never pair with full-sentence text).
- The book-VTT is parsed `asr-fallback`-aware: a `NOTE asr-fallback` line tags
  the NEXT cue (same format as orpheus-finetune `cut_audiobook.parse_vtt`). Those
  cues are whisper hole-fill, NOT book truth — a clip overlapping one goes
  `uncertain`, never producing that text.
- No whisper dependency ⇒ runs under the `clipforge-speakers` env (the default);
  `--python` overrides.

**ANCHOR mode** (no `--book-vtt`) — the clip's book position is UNKNOWN. CPU
faster-whisper transcribes the clip; **that ASR is only a LOCATOR, never the
output text.** The ASR word sequence is fuzzy-anchored against the epub's full
plain text, and the OUTPUT is the epub's exact words for the matched span,
expanded to sentence boundaries. Defaults to the e2a runtime env python (where
faster-whisper lives); `--python` overrides. Algorithm (all stdlib — no rapidfuzz
in the whisper env):

1. **n-gram offset voting.** Each shared 5-gram between ASR and epub implies an
   alignment offset (`epub_pos − asr_pos`); offsets are bucketed (50-token
   buckets) and voted. **No shared 5-gram ⇒ `uncertain` "not book content"** —
   this is what makes an out-of-book clip (ad/intro/a different book) fail
   cleanly, before any similarity is even computed.
2. **Tie gate.** A second vote cluster ≥ 200 tokens away with ≥ 60 % of the
   winner's votes ⇒ `uncertain` "ambiguous location" (a phrase the book repeats).
3. **Local alignment** (`difflib.SequenceMatcher`, chosen because it is stdlib,
   needs no extra dependency in the whisper env, and its longest-matching-block +
   ratio is exactly the sequence-alignment primitive required) in a window around
   the anchor → the matched epub token span.
4. **Sentence expansion** of that span to whole-sentence boundaries → output text
   (the epub's exact substring, punctuation and all).

### Thresholds (defaults MEASURED on 40 real Marked Man clips, not guessed)

- `--edge-tol 0.35` (map) — cue-midpoint containment / straddle tolerance;
  inherited from the validated `ender_corpus_from_vtt.py` prototype.
- `--similarity-threshold 0.60` (anchor) — a cheap PRE-gate on the anchor window
  (matched-ASR-words / ASR-words, before expansion). On the 40-clip set every
  genuine clip scored ≥ 0.80 (median 0.98); 0.60 leaves margin while rejecting a
  clip whose ASR barely matches near the anchor.
- `--fidelity-threshold 0.85` (anchor) — **the PRIMARY certainty gate**: the
  symmetric `difflib` ratio between the FINAL expanded epub text and the ASR.
  Unlike a one-sided coverage metric, this penalizes BOTH failure directions —
  **overshoot** (expansion pulls in a neighbouring sentence the audio never
  spoke) AND **under-coverage** (expansion drops a sentence the reader spoke).
  Measured separation was clean: the 5 misaligned clips scored **≤ 0.803**
  (0.651 / 0.691 / 0.691 / 0.739 / 0.803 — each verified by hand: e.g. clip 19's
  epub text appended a whole extra sentence "There was something outdated about
  it" absent from the audio; clip 87's expansion opened with an entirely
  different sentence; clip 48 dropped the audio's opening line), while EVERY
  clean clip scored **≥ 0.863**, proper-noun corrections included (a name fix
  costs only a word or two of ratio). 0.85 sits in the 0.803–0.863 gap, placed
  at the top of it so borderline clips fall to `uncertain` — certainty over
  quantity. An earlier one-sided `coverage = matched/expanded` gate was REJECTED
  because it is blind to under-coverage and to a wrong-sentence start: it passed
  all 5 defective clips.

### Uncertain contract

A clip yields text ONLY when confidently placed. In anchor mode it goes
`uncertain` for: too little speech to anchor (< 4 words), no shared epub n-gram
(out-of-book — the ad/intro/outro case), an ambiguous/tied location, a low
anchor-window similarity, or a final fidelity below threshold. In map mode:
no span for the clip, no cues in the span, a boundary-straddling cue, or overlap
with an `asr-fallback` region. Every reason is recorded per clip in the report;
uncertain clips are triaged by ear by the human. The report also records
`similarity`, `fidelity`, `coverage`, matched span, and the locator ASR for
every clip so a marginal-but-passing run stays visible.

### Tests + benchmark (2026-07-21, CPU only — GPU was busy training)

Ground truth: `E:\mm_build\deathstalker_rv2h\wavs` (Marked Man clips, ASR texts
in `metadata_train/eval.csv`) + the Marked Man epub.

- **Anchor mode, 40 MM clips** (mean 14.8 s/clip, `medium` int8 CPU): **35 OK /
  5 uncertain (87.5 %)**. All 5 uncertain were verified genuinely misaligned
  (fidelity ≤ 0.803), not false negatives. Similarity median 0.98 (min 0.80).
- **Proper-noun corrections (the headline)**: across the 35 kept clips, **9
  proper-noun fixes** vs the stored ASR — `kalakos` (a recurring surname whisper
  mishears as "kolakos" EVERY time), `kalakos's`, and `thalassa` (from "talasa")
  — plus 17 other word corrections (`cart`←"card", `iambs`←"iams",
  `cherub`←"chirp", `intoning`←"and toning", `tiptoes`←"tip toes",
  `broaches`←"brooches", `911`←"nine hundred eleven"). This is exactly the
  ASR-alone-gets-it-wrong failure the doctrine exists to fix.
- **Benchmark (CPU, `medium` int8)**: whisper load **2.8 s** (one-time,
  amortized); **warm mean 7.3 s per ~15 s clip** (~0.5× realtime); cold first
  clip incl. load **8.8 s**; 290 s total for 40 clips. So attaching accurate text
  to a single 20-second clip costs **≈ 10 s CPU** — the answer to Owen's "at
  reasonable speed?" is yes. (A CUDA `medium` run would be several× faster; the
  GPU was reserved for a training job during this test.)
- **Uncertain path** — 3 Ender's Game clips (a DIFFERENT book) anchored against
  the Marked Man epub: **0 anchored, all 3 `uncertain` "no epub anchor"**. Whisper
  transcribed them fine (real Ender's Game text) but none shared a 5-gram with the
  wrong book, so nothing was fabricated.
- **Map mode** — synthetic VTT+spans fixture (5 clips): correctly produced **1
  OK** (clean containment, exact concatenated book text) and **4 uncertain**, one
  per rule: asr-fallback overlap, no cues in span, boundary-straddle, and
  no-span-for-clip. Verified with BOTH `--spans` shapes (plain object and a
  ClipForge `speakers.json`), giving identical results; a malformed spans json
  fails loudly (exit 1).

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
