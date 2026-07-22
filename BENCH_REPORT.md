# ClipForge speaker-separation bake-off — measured report

**Branch:** `feat/clipforge-speaker-bench` · **Date:** 2026-07-21 · **CPU only**
(GPU reserved for a training chain; WSL / `C:\tmp\en_*` / `E:\training\ender\build\*` untouched.)

Harness: `cli/py/bench_embedders.py` (embedder bake-off) and `cli/py/diarize_bench.py`
(pyannote timeline). Measurement-only; **the production `cli/py/speaker_buckets.py` path
was not touched** — the swap is a follow-up.

---

## TL;DR / recommendation

**Swap the embedder from resemblyzer to WeSpeaker** (`pyannote/wespeaker-voxceleb-resnet34-LM`),
keeping the existing clustering/margin logic unchanged. Measured on the ear-verified Ender's
Game ground truth:

- **The fatal metric (false assignment) is only solvable by swapping.** resemblyzer *merges*
  the second narrator (Orson Scott Card) **into** the Rudnicki cluster: at the 0.28 production
  threshold, **142/142 Card clips land in Rudnicki** (Card's cosine sim to the Rudnicki
  centroid is **0.79** — inside the linkage cut). There is **no** resemblyzer operating point
  that passes the null test AND cleanly separates Card+voice-3 at a normal margin.
- **WeSpeaker and ECAPA both drive Card's sim-to-Rudnicki to ~0.21** (near-orthogonal;
  the confirmed intruder clip drops to **0.006**), giving **0 false assignments across a wide
  threshold band (0.28–0.40)** while landing Card and voice-3 in their **own distinct
  clusters** and recovering **~370 expressive `uncertain` clips** — simultaneously.
- **WeSpeaker beats ECAPA** on the one axis that sets the default: null-test robustness.
  WeSpeaker holds a single narrator together from **thr ≥ 0.28**; ECAPA **shatters** one
  narrator into 4–11 clusters below **0.36**, so ECAPA's safe band is narrow (0.36–0.40).
  WeSpeaker also has the largest headroom (0.745) and is pyannote's own embedding backbone
  (aligns with a future `diarize` mode). **Proposed defaults for WeSpeaker: `--cluster-threshold 0.32`,
  `--uncertain-margin 0.05`.**

**Primary (pyannote diarization) track is BLOCKED by HF gating** — see its section; the code
is written and validated up to the gate, and WeSpeaker (pyannote's backbone) stands in as the
measured evidence for that approach.

---

## Ground truth (what "correct" means here)

All labels are ear-verified by Owen and documented in `CLIPFORGE_PLAN.md`. The Ender's Game
m4b (43072 s ≈ 12 h) was sliced deterministically into **2248** segments (identical slicing
across the 0.28 and 0.20 production runs, so a segment's filename is a stable identity).

| label | source | n | meaning |
|-------|--------|---|---------|
| `rudnicki_gold` | orig `cluster_01`, top-confidence to 1800 s | **98** | hand-verified narrator (Stefan Rudnicki) |
| `rudnicki` | fine `cluster_01` | **1204** | verified narrator (broad) |
| `card` | fine `cluster_03` | **142** | verified DIFFERENT narrator (Card afterword, last ~53 min) |
| `voice3` | fine `cluster_04` | **65** | verified third voice (incl. confirmed intruder `seg_00002_000037.41s.wav`) |
| `uncertain` | fine `uncertain` | **528** | UNLABELED pool: expressive-Rudnicki + ads + Card fragments |
| `other` | cluster_02, 05–11 | 191 | second-narrator + fine splits (kept in pool, not scored) |
| `null` (`mm_null`) | 94 single-narrator clips | **94** | must stay ONE cluster (hard requirement) |

The **fatal metric** (weighted above everything): any `card`/`voice3` clip *confidently*
placed in the Rudnicki cluster is a **FALSE ASSIGNMENT**. Expressive retention (recovering
`uncertain` into Rudnicki) counts only at **zero** false assignments. The clustering pool is
the 2130 Ender clips minus `music`/`mixed`, exactly as `speaker_buckets.py` would cluster.

---

## Embedder bake-off (clip-directory mode)

Identical clustering to production (`speaker_buckets.py`): agglomerative average-linkage
cosine, `fcluster` distance cut, centroid = L2-normalized mean, margin gate
(own-sim − nearest-other-sim < gate ⇒ `uncertain`). **Only the embedder varies.** All 2342
clips embedded once per backend.

Candidates: **A. resemblyzer** (256-d, production) · **B. ECAPA-TDNN** (192-d,
`speechbrain/spkrec-ecapa-voxceleb`) · **C. WeSpeaker** (256-d,
`pyannote/wespeaker-voxceleb-resnet34-LM`, ResNet34 x-vector — modern third point AND
pyannote's embedding backbone).

### 1. Null test — 94 single-narrator clips must be ONE cluster

`n_clusters` (largest bucket / 94); **PASS** = exactly 1 cluster.

| threshold | resemblyzer | ECAPA | WeSpeaker |
|-----------|-------------|-------|-----------|
| 0.20 | 2 (93) FAIL | 11 (55) FAIL | 6 (52) FAIL |
| 0.24 | 2 (93) FAIL | 7 (56) FAIL | 4 (69) FAIL |
| 0.28 | **1 PASS** | 5 (63) FAIL | **1 PASS** |
| 0.32 | **1 PASS** | 4 (74) FAIL | **1 PASS** |
| 0.36 | **1 PASS** | **1 PASS** | **1 PASS** |
| 0.40 | **1 PASS** | **1 PASS** | **1 PASS** |

Min null-pass threshold: **resemblyzer 0.28, WeSpeaker 0.28, ECAPA 0.36.** ECAPA is the
outlier — it fragments a single narrator badly at the thresholds you'd want for separation.

### 2. Separation / confusion — the fatal metric

Per backend at **margin 0.05**, across thresholds: `FALSE` = Card+voice-3 clips confidently
put in the Rudnicki cluster (lower is better; **0 is required**); `Cd?`/`V3?` = did Card /
voice-3 form their **own** distinct cluster; `rec` = `uncertain` clips recovered into Rudnicki.

**resemblyzer (baseline)** — no clean, null-valid operating point:

| thr | FALSE (card+v3) | Cd? | V3? | rec | null |
|-----|-----------------|-----|-----|-----|------|
| 0.20 | **0** | Y | Y | 302 | FAIL |
| 0.24 | 30 (0+30) | Y | N | 406 | FAIL |
| 0.28 | **189** (142+47) | **N** | **N** | 459 | PASS |
| 0.32 | 184 (142+42) | N | N | 464 | PASS |
| 0.36 | 189 (142+47) | N | N | 467 | PASS |

resemblyzer only reaches 0 false at a null-valid threshold by cranking the **margin to 0.15**
(e.g. 0.36/0.15 → 0 false, 305 recovered) — fragile, and it pushes Card/voice-3 to `uncertain`
rather than resolving them (Cd?/V3? = N). At the actual production default (**0.28/0.05**) it
puts **all 142 Card + 47 voice-3 clips into Rudnicki** — the documented contamination, worse
than the "one leaked male" because the whole Card afterword merges.

**ECAPA** — 0 false everywhere; safe band gated by the null test (≥0.36):

| thr | FALSE | Cd? | V3? | rec | null |
|-----|-------|-----|-----|-----|------|
| 0.28 | **0** | Y | Y | 365 | FAIL |
| 0.32 | **0** | Y | Y | 365 | FAIL |
| 0.36 | **0** | Y | Y | 364 | **PASS** |
| 0.40 | **0** | Y | Y | 364 | **PASS** |

**WeSpeaker** — 0 false everywhere; safe band from 0.28:

| thr | FALSE | Cd? | V3? | rec | null |
|-----|-------|-----|-----|-----|------|
| 0.28 | **0** | Y | Y | 367 | **PASS** |
| 0.32 | **0** | Y | Y | 372 | **PASS** |
| 0.36 | **0** | Y | Y | 375 | **PASS** |
| 0.40 | **0** | Y | Y | 377 | **PASS** |

WeSpeaker & ECAPA keep all **98/98 gold** Rudnicki clips in the Rudnicki cluster at every op
above. The recommended WeSpeaker op **0.32/0.05**: 0 false, 372 recovered, Card+voice-3
distinct, null PASS, gold 98/98.

### 3. Margin structure — headroom to the Rudnicki centroid

Cosine similarity to the Rudnicki centroid. The 0.068-vs-0.05 near-miss that leaked the
second male becomes a **chasm**:

| metric | resemblyzer | ECAPA | WeSpeaker |
|--------|-------------|-------|-----------|
| Rudnicki-gold sim (median) | 0.9815 | 0.9468 | 0.9566 |
| **Card sim (median)** | **0.7876** | **0.2138** | **0.1747** |
| Card sim (p90) | 0.8052 | 0.2495 | 0.2114 |
| voice-3 sim (median) | 0.7764 | 0.2006 | 0.1466 |
| confirmed intruder sim | **0.7740** | 0.0380 | **0.0061** |
| **headroom (Rud median − Card p90)** | **0.176** | 0.697 | **0.745** |

resemblyzer places Card only 0.18 below the narrator in centroid-sim, and average-linkage
merges the two clusters once the cut ≥ 0.28. WeSpeaker/ECAPA place Card ~0.75 away — it can
never merge in the usable range.

### 4. Expressive retention + F0

At each backend's zero-false operating point, ~360–377 `uncertain` clips are recovered into
Rudnicki, nudging the F0 median from the cluster_01-only value toward the wider-population
reference:

| | resemblyzer\* | ECAPA | WeSpeaker |
|---|---|---|---|
| Rudnicki-only F0 median (n=1204) | 82.37 Hz | 82.37 Hz | 82.37 Hz |
| Rud + recovered F0 median | 83.33 Hz | 83.33 Hz | 83.33 Hz |
| clips recovered (at 0 false) | 358 (null-INVALID op) | 367 | **377** |
| wider-population reference | 84.9 Hz | 84.9 Hz | 84.9 Hz |

\*resemblyzer's zero-false recovery only occurs at thr 0.20 (which **fails** the null test);
at a null-valid op it recovers less and only via an extreme margin. So the *only* embedders
that recover the expressive register **without contamination** are ECAPA and WeSpeaker. The F0
shift is modest (+~1 Hz) because the expressive high-F0 clips are a minority of the recovered
set — the decisive win is that the recovery happens at **zero false assignments**, which
resemblyzer cannot deliver.

### 5. Runtime per 1000 clips (CPU)

Two numbers per backend: the **concurrent** figure (all 3 embeds + the training chain ran at
once during the main harness run — inflated by ~2–4× from contention) and a **clean isolated**
figure (300 clips, sequential, only the training chain competing; includes one-time model load).

| backend | concurrent s/1000 | **clean s/1000** |
|---------|-------------------|------------------|
| resemblyzer | 402 | **65** |
| ECAPA | 810 | **620** |
| WeSpeaker | 538 | **437** |

WeSpeaker is **~6.7× slower than resemblyzer** on CPU (0.44 s/clip) but faster than ECAPA — a
2248-clip book embeds in ~16 min CPU, acceptable for an offline prep stage. If that cost ever
matters, WeSpeaker also has a CUDA path (out of scope here; GPU was reserved for training).

---

## Recommendation

**Swap resemblyzer → WeSpeaker** in `speaker_buckets.py` (a follow-up task; not done here).
Justification, in priority order:

1. **Fatal metric:** only WeSpeaker/ECAPA reach **0 false assignments**; resemblyzer cannot at
   any null-valid, normal-margin operating point (it merges the whole Card afterword at 0.28).
2. **Null robustness picks WeSpeaker over ECAPA:** WeSpeaker holds a single narrator together
   from thr ≥ 0.28 (wide safe band 0.28–0.40); ECAPA needs ≥ 0.36 or it shatters one narrator,
   leaving a narrow band. A wide band makes the default robust to voice variety.
3. **Headroom & intruder rejection:** WeSpeaker has the largest headroom (0.745) and the
   cleanest confirmed-intruder score (0.006).
4. **Recovery:** WeSpeaker recovers the most `uncertain` at zero false (372–377).
5. **Alignment:** WeSpeaker is pyannote's embedding backbone, so adopting it now also lays the
   groundwork for a `diarize` (book → timeline) mode.

**Proposed WeSpeaker defaults:** `--cluster-threshold 0.32` (middle of the 0.28–0.40 valid
band) and `--uncertain-margin 0.05`. With ~0.75 of headroom the margin gate mostly trades
recovery, not contamination — 0.05 keeps 372 clips recovered at 0 false; raise it only to be
more conservative. **Note the existing 0.28 default was tuned for resemblyzer** and must be
re-set when the embedder changes.

**One honest caveat:** WeSpeaker over-splits the narrator into ~22 fine clusters at 0.32
(vs resemblyzer's coarser split) — expected and acceptable under the over-split contract (the
human merges exemplars), but more fragments to merge. A real pyannote diarization would
consolidate to a speaker count; the embedder-clustering path over-splits by design.

---

## PRIMARY track — pyannote / whisperX diarization: BLOCKED by HF gating

The coordinator elevated pyannote `speaker-diarization-3.1` to primary. **It could not be run
on this machine for a credential reason I cannot fix autonomously**, and this is the key
operational finding:

- `pyannote/speaker-diarization-3.1`, `…-community-1`, and `pyannote/segmentation-3.0` are
  **gated** HF repos; the pipeline needs the segmentation model, and all three **403** on
  download ("accept user conditions"). Only the embedding model
  `pyannote/wespeaker-voxceleb-resnet34-LM` is **ungated** (hence candidate C runs).
- The HF token at `~/.cache/huggingface/token` (and the identical one in
  `Downloads\bookforge-hf-token.txt`) is **owenmorgan / fine-grained**, scoped to only
  `canopylabs/orpheus-3b-0.1-ft` + `owenmorgan/*`. It has `canReadGatedRepos:true` globally,
  so accepting the licence *might* be sufficient — but I did not accept a third-party licence
  on Owen's behalf (that binds him legally; "use the token if needed" doesn't extend to it).

**To unblock (one-time, Owen only):** (1) accept the licence on
`hf.co/pyannote/speaker-diarization-3.1` **and** `…/segmentation-3.0` while logged in as
owenmorgan; (2) if the fine-grained token still 403s, issue a token with **"Read access to all
public gated repos"**. Then `diarize_bench.py run --wav <16k slice> --offset <book sec>`
executes the real pipeline — the code loads the pipeline, decodes **in-memory** to dodge the
broken `torchcodec` DLL in the whisperx env, and emits the timeline + realtime factor;
`diarize_bench.py score` maps the ground-truth clip spans onto it and reports the same fatal
metric (Card is entirely in the last ~53 min — 39901–43035 s — so the Card test window is
`--window-start 39600 --window-end 43072`).

### whisperX packaging verdict

whisperX 3.8.6's `DiarizationPipeline` is a thin wrapper: it calls
`pyannote Pipeline.from_pretrained(model or "pyannote/speaker-diarization-community-1")` and
assigns the resulting speaker turns onto ASR **words** via an interval tree. For ClipForge it
adds **nothing** over bare pyannote — its only value is gluing speakers to whisper transcripts,
and we use epub text as truth (the `sentences` verb), not whisper. It carries the **same gating
blocker** plus a heavier dep tree (pandas, ctranslate2, faster-whisper). **Verdict: do not
adopt whisperX; if the diarization route is taken, depend on `pyannote.audio` directly.**

### `diarize` mode feasibility (design)

- **Pipeline:** decode source → 16 kHz mono (bundled ffmpeg) → `pyannote` on CPU → collapse
  `itertracks` into a **speaker timeline** = `speakers.map.json`
  (`{schema, source, realtime_factor, speakers[], segments:[{start,end,speaker,confidence}]}`).
  `diarize_bench.py run` already emits exactly this shape (book time via `--offset`).
- **Both modes are needed:** for a **book**, a real diarization timeline is strictly better than
  slice→embed→cluster (models overlap/turns, yields spans directly); for a **directory of
  already-cut clips** with no shared timeline, diarization doesn't apply and the embedder path
  (now WeSpeaker) remains necessary.
- **Ungated stand-in shipped:** `bench_embedders.py mapexport` writes the same
  `speakers.map.json` from the (ungated) WeSpeaker clustering over the deterministic
  time-ordered segments (`C:\tmp\clipbench\speakers.map.wespeaker.json`, 2130 segments; the
  Card region 39900 s+ is consistently one distinct `SPEAKER_02`). This is the embedder path
  rendered as a timeline — **not** pyannote neural diarization — and its numbers are the
  WeSpeaker rows above. Runtime feasibility of *real* pyannote on a 10-min CPU slice is the
  first thing to measure once unblocked.

---

## Reproduce

```
# ground truth (labels + time spans; F0 added by a second pass)
python cli/py/bench_embedders.py build-gt --fine <fine speakers.json> \
    --orig <orig speakers.json> --fine-root <fine dir> --null-dir <mm_null> --out gt.json --no-f0
python cli/py/bench_embedders.py f0 --gt gt.json                      # clipforge-speakers env

# embed (each in its env), then evaluate all three
python cli/py/bench_embedders.py embed --backend resemblyzer --gt gt.json --out emb_resemblyzer.npz   # clipforge-speakers
python cli/py/bench_embedders.py embed --backend ecapa       --gt gt.json --out emb_ecapa.npz         # clipforge-bench
python cli/py/bench_embedders.py embed --backend wespeaker   --gt gt.json --out emb_wespeaker.npz     # whisperx
python cli/py/bench_embedders.py eval --gt gt.json \
    --emb emb_resemblyzer.npz --emb emb_ecapa.npz --emb emb_wespeaker.npz --out results.json

# timeline artifact (ungated) and, once pyannote is unblocked, the real diarization
python cli/py/bench_embedders.py mapexport --gt gt.json --emb emb_wespeaker.npz --threshold 0.32 --margin 0.05 --out speakers.map.json
python cli/py/diarize_bench.py run   --wav <16k slice.wav> --offset <book sec> --out timeline.json
python cli/py/diarize_bench.py score --timeline timeline.json --gt gt.json --window-start 39600 --window-end 43072 --out diar_score.json
```

### Environments (install pain worth recording)

- **`clipforge-bench`** (new): `python=3.11` + torch/torchaudio (CPU index) + `numpy<2` +
  `speechbrain` + `soundfile librosa scipy`. **Pain:** installing everything under
  `--index-url .../whl/cpu` fails (that index has no speechbrain) — split into a torch-only CPU
  install then the rest from PyPI. `torchaudio.load` is unusable (needs `torchcodec`, absent) —
  load audio via `soundfile`.
- **`whisperx`** (existing): has `pyannote-audio 4.0.7` + `whisperx 3.8.6`. **Pain:** its
  `torchcodec` DLL fails to load (FFmpeg-version mismatch), so pyannote 4.x file-path audio load
  breaks — pass an in-memory `{"waveform","sample_rate"}` dict instead (needed
  `pip install soundfile` there).
- **`clipforge-speakers`** (existing, deps untouched): resemblyzer baseline + the F0 pass.
