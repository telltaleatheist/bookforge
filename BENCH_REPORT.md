# ClipForge speaker-separation bake-off — measured report

**Branch:** `feat/clipforge-speaker-bench` · **Date:** 2026-07-21 · **CPU only**
(GPU reserved for a training chain; WSL / `C:\tmp\en_*` / `E:\ender_build\*` untouched.)

Harness: `cli/py/bench_embedders.py` (embedder bake-off) and `cli/py/diarize_bench.py`
(pyannote timeline). Both are measurement-only; **the production
`cli/py/speaker_buckets.py` path was not touched** (swap is a follow-up).

---

## TL;DR / recommendation

_(filled after the tables below — see "Recommendation".)_

---

## Ground truth (what "correct" means here)

All labels are ear-verified by Owen and documented in `CLIPFORGE_PLAN.md`. The Ender's
Game m4b (`…/archive/Ender's Game. Card, Orson Scott. (2002).m4b`, 43072 s ≈ 12 h) was
sliced deterministically into **2248** segments (identical slicing across the 0.28 and
0.20 production runs — same `source_offset`, so a segment's filename is a stable identity).

| label | source | n | meaning |
|-------|--------|---|---------|
| `rudnicki_gold` | orig `cluster_01`, top-confidence to 1800 s | **98** | hand-verified narrator (Stefan Rudnicki) |
| `rudnicki` | fine `cluster_01` | **1204** | verified narrator (broad) |
| `card` | fine `cluster_03` | **142** | verified DIFFERENT narrator (Orson Scott Card afterword) |
| `voice3` | fine `cluster_04` | **65** | verified third voice (incl. 1 confirmed by-ear intruder `seg_00002_000037.41s.wav`) |
| `uncertain` | fine `uncertain` | **528** | UNLABELED pool: expressive-Rudnicki + ads + Card fragments |
| `other` | cluster_02, 05–11 | 178+13 | second-narrator + fine splits (not scored; kept in the pool) |
| `null` (`mm_null`) | 94 single-narrator clips | **94** | must stay ONE cluster (hard requirement) |

**Time layout matters for diarization:** `card` is entirely in the last ~53 min
(39901–43035 s — the Card afterword); `voice3` is spread across the whole book; the
whole 12 h is one physical file.

The **fatal metric** (weighted above everything, per the certainty-over-quantity
contract): any `card`/`voice3` clip *confidently* placed in the Rudnicki cluster is a
**FALSE ASSIGNMENT**. Expressive retention (recovering `uncertain` into Rudnicki) counts
only at **zero** false assignments.

---

## PRIMARY track — pyannote / whisperX diarization: BLOCKED by HF gating

The coordinator elevated pyannote `speaker-diarization-3.1` to primary. **It could not be
run on this machine, for a credential reason I cannot fix autonomously**, and this is the
single most important operational finding of the exercise:

- `pyannote/speaker-diarization-3.1`, `…-community-1`, and `pyannote/segmentation-3.0`
  are **gated** HF repos. The pipeline needs the segmentation model; all three 403 on
  download.
- The HF token at `~/.cache/huggingface/token` (and the identical one in
  `Downloads\bookforge-hf-token.txt`) is **owenmorgan / fine-grained**, scoped to only
  `canopylabs/orpheus-3b-0.1-ft` and `owenmorgan/*`. It has `canReadGatedRepos:true`
  **globally** but its content-read scope is limited to those two repos, so it cannot
  read pyannote repo content even though Owen could accept the licence.
- `pyannote/wespeaker-voxceleb-resnet34-LM` (the pipeline's **embedding backbone**) is
  **ungated** and downloads fine — which is why WeSpeaker still appears as candidate C.

**To unblock pyannote, Owen must do two manual things I can't:** (1) accept the licence on
`hf.co/pyannote/speaker-diarization-3.1` **and** `…/segmentation-3.0` while logged in as
owenmorgan; (2) supply a token with **"Read access to all public gated repos"** (a classic
read token, or a fine-grained token with that box checked). Once both are done,
`diarize_bench.py run --wav <slice> --offset <sec>` executes the real pipeline — the code
is written and validated up to the gate (it loads the pipeline, decodes in-memory to
dodge the broken `torchcodec` DLL in the whisperx env, and emits the timeline + realtime
factor).

### whisperX packaging verdict (one paragraph)

whisperX 3.8.6's `DiarizationPipeline` is a thin wrapper: it calls
`pyannote Pipeline.from_pretrained(model or "pyannote/speaker-diarization-community-1")`
and then assigns the resulting speaker turns onto ASR **words** via an interval tree.
For ClipForge it adds **nothing** over bare pyannote — its only value-add is gluing
speaker labels to whisper transcripts, and we deliberately don't use whisper text (epub
is truth, per the `sentences` verb). It carries the **same gating blocker** (same
pyannote models) plus a heavier dependency tree (pandas, ctranslate2, faster-whisper).
**Verdict: do not adopt whisperX; if the diarization route is taken, depend on
`pyannote.audio` directly.**

### What a ClipForge `diarize` mode would look like (feasibility)

Design is sound and small; the only blocker is the credential above.

- **Pipeline:** decode source → 16 kHz mono (bundled ffmpeg) → `pyannote` pipeline on CPU
  → collapse `itertracks` into a **speaker timeline** = the proposed `speakers.map.json`:
  `{schema, source, realtime_factor, speakers[], segments:[{start,end,speaker,confidence}]}`.
  `diarize_bench.py run` already emits exactly this shape (in book time via `--offset`).
- **Deps:** `pyannote.audio` (+ its gated models). No whisperX. HF token with gated read.
- **Runtime:** _(RTF filled after a real run once unblocked; a 10-min CPU slice was the
  probe target.)_
- **Does it obsolete the embedder clip path?** For the **from-a-book** case, a good
  diarization timeline is strictly better than slice-then-embed-then-cluster: it models
  overlap and speaker turns natively and yields time spans directly. For the
  **clips-from-a-directory** case (a pile of already-cut wavs with no shared timeline),
  diarization does **not** apply — per-clip embeddings + clustering remain necessary.
  So ClipForge wants **both**: `diarize` for a book, the embedder path for a clip dir.

Because pyannote itself is blocked, the timeline feasibility below is demonstrated with an
**ungated stand-in**: clustering the (ungated) WeSpeaker embeddings over the deterministic
time-ordered segments, exported as `speakers.map.json` via `bench_embedders.py mapexport`.
This is NOT pyannote neural diarization (no overlap/VAD model) — it is the embedder path
rendered as a timeline, and its separation numbers are the WeSpeaker rows below.

---

## Embedder bake-off (clip-directory mode)

Same clustering logic as production (`speaker_buckets.py`): agglomerative average-linkage
cosine, `fcluster` distance cut, centroid = L2-normalized mean, margin gate
(own-centroid-sim − nearest-other-centroid-sim < gate ⇒ `uncertain`). The **only** variable
is the embedder. All 2342 clips embedded once per backend and cached.

Candidates:
- **A. resemblyzer** (256-d d-vector) — current production embedder.
- **B. ECAPA-TDNN** (192-d, `speechbrain/spkrec-ecapa-voxceleb`).
- **C. WeSpeaker** (256-d, `pyannote/wespeaker-voxceleb-resnet34-LM`, ResNet34 x-vector) —
  modern third point AND pyannote's own embedding backbone.

### 1. Null test (94 single-narrator clips → must be 1 cluster)

_(table filled after eval)_

### 2. Separation / confusion (the fatal metric)

_(table filled after eval — per candidate, gridded threshold × margin: gold-in-Rudnicki,
card-false, voice3-false, FALSE total, uncertain recovered, card/voice3 distinct?)_

### 3. Expressive retention + F0

_(table filled after eval — uncertain recovered at zero false assignments; F0 median of
cluster_01 alone vs cluster_01+recovered vs the 84.9 Hz wider reference.)_

### 4. Margin structure (headroom to the Rudnicki centroid)

_(table filled after eval — cosine sim of card/voice3/gold to the Rudnicki centroid; the
0.068-vs-0.05 near-miss should widen.)_

### 5. Runtime per 1000 clips (CPU)

_(table filled after eval.)_

---

## Recommendation

_(filled after the tables.)_

---

## Reproduce

```
# ground truth (labels + time spans; F0 added by the f0 pass)
python cli/py/bench_embedders.py build-gt --fine <fine speakers.json> \
    --orig <orig speakers.json> --fine-root <fine dir> --null-dir <mm_null> \
    --out gt.json --no-f0
python cli/py/bench_embedders.py f0 --gt gt.json          # clipforge-speakers env

# embed (each in its env)
python cli/py/bench_embedders.py embed --backend resemblyzer --gt gt.json --out emb_resemblyzer.npz   # clipforge-speakers
python cli/py/bench_embedders.py embed --backend ecapa       --gt gt.json --out emb_ecapa.npz         # clipforge-bench (speechbrain)
python cli/py/bench_embedders.py embed --backend wespeaker   --gt gt.json --out emb_wespeaker.npz      # whisperx (pyannote)

# evaluate all three
python cli/py/bench_embedders.py eval --gt gt.json \
    --emb emb_resemblyzer.npz --emb emb_ecapa.npz --emb emb_wespeaker.npz --out results.json

# diarize-mode timeline (once pyannote is unblocked)
python cli/py/diarize_bench.py run --wav <16k slice.wav> --offset <book sec> --out timeline.json
python cli/py/diarize_bench.py score --timeline timeline.json --gt gt.json \
    --window-start <s> --window-end <s> --out diar_score.json
```

### Environments (install pain worth recording)

- **`clipforge-bench`** (new): `python=3.11` + `torch/torchaudio` (CPU index) + `numpy<2`
  + `speechbrain` + `soundfile librosa scipy`. **Pain:** installing everything under
  `--index-url .../whl/cpu` fails (that index has no speechbrain); split into a torch-only
  CPU install then the rest from PyPI. `torchaudio.load` is unusable (needs `torchcodec`,
  absent) — load audio via `soundfile` instead.
- **`whisperx`** (existing): has `pyannote-audio 4.0.7` + `whisperx 3.8.6`. **Pain:** its
  `torchcodec` DLL fails to load (FFmpeg-version mismatch), so any file-path audio load in
  pyannote 4.x breaks — pass an in-memory `{"waveform","sample_rate"}` dict instead
  (needed a `pip install soundfile` there).
- **`clipforge-speakers`** (existing, untouched deps): resemblyzer baseline + the F0 pass.
