#!/usr/bin/env python
"""speaker_buckets.py — separate audio clips into per-voice-actor buckets.

The real worker behind ClipForge's `speakers` CLI verb. Given either a
DIRECTORY of clip wavs or a SINGLE long audiobook file, it:

  1. (single-file mode) decodes to 16 kHz mono with ffmpeg, then slices into
     3-20 s segments AT SILENCES (librosa, deterministic), recording each
     segment's source offset. (directory mode) uses the wavs as-is.
  2. Embeds every clip with resemblyzer's VoiceEncoder — BOTH a whole-clip
     embedding AND sliding ~1.6 s partial-window embeddings (~50 % overlap).
  3. MIXED detection: a clip whose minimum pairwise window-to-window cosine
     similarity falls below --mixed-threshold contains more than one voice
     (dialogue) and goes to mixed/.
  4. CLUSTERS the single-voice clips with scipy agglomerative clustering over
     the whole-clip embeddings (cosine distance, average linkage, distance
     cut = --cluster-threshold). Deliberately errs toward OVER-splitting:
     never merge two different real actors; the human merges clusters after.
  5. UNCERTAIN: a clip whose assignment margin (own-centroid similarity minus
     nearest-other-centroid similarity) is below --uncertain-margin is
     ambiguous and goes to uncertain/ instead of a cluster.

Output under --out:
  cluster_01/ .. cluster_NN/   (wav copies, or the cut segment wavs)
  mixed/                        (multi-voice clips)
  uncertain/                    (low-margin clips)
  speakers.json                 (versions, thresholds, per-clip, per-cluster)

NO FALLBACKS: a missing package, an unreadable input, or a failed ffmpeg
decode exits non-zero with the error. Nothing is silently defaulted.

Progress protocol (stdout, one per line, for the JS bridge to parse):
  STAGE <name>
  PROGRESS <0-100>
  RESULT {"ok":true, ...}
  ERROR <message>

Usage:
  speaker_buckets.py --input <file-or-dir> --out <dir> --ffmpeg <ffmpeg.exe>
      [--cluster-threshold 0.28] [--mixed-threshold 0.78]
      [--uncertain-margin 0.05] [--min-clip 3] [--max-clip 20]
      [--top-db 30] [--window-rate 1.25] [--device cpu]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from importlib import metadata as importlib_metadata


def log_stage(name):
    print(f"STAGE {name}", flush=True)


def log_progress(pct):
    print(f"PROGRESS {int(pct)}", flush=True)


def die(msg):
    print(f"ERROR {msg}", flush=True)
    sys.exit(1)


def pkg_version(name):
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return "unknown"


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="a directory of wavs OR one audio file")
    ap.add_argument("--out", required=True, help="output bucket root (created)")
    ap.add_argument("--ffmpeg", required=True, help="path to ffmpeg.exe (single-file mode)")
    ap.add_argument("--cluster-threshold", type=float, default=0.28,
                    help="cosine-distance cut for agglomerative clustering (lower = more clusters)")
    ap.add_argument("--mixed-threshold", type=float, default=0.55,
                    help="2-means centroid cosine below which a clip is MIXED (multi-voice); "
                         "single-narrator floor measured at ~0.60, cross-actor ~0.2-0.4")
    ap.add_argument("--mixed-min-frac", type=float, default=0.20,
                    help="smaller window-group must be >= this fraction for a clip to count as MIXED")
    ap.add_argument("--music-threshold", type=float, default=0.60,
                    help="HPSS harmonic-energy fraction above which a clip has a BACKGROUND-MUSIC "
                         "bed; single-narrator ceiling measured ~0.55, so 0.60 keeps a safe margin")
    ap.add_argument("--uncertain-margin", type=float, default=0.05,
                    help="min (own-centroid - nearest-other-centroid) similarity to keep a clip in its cluster")
    ap.add_argument("--min-clip", type=float, default=3.0, help="min segment seconds (single-file slicing)")
    ap.add_argument("--max-clip", type=float, default=20.0, help="max segment seconds (single-file slicing)")
    ap.add_argument("--top-db", type=float, default=30.0, help="librosa silence threshold for slicing")
    ap.add_argument("--window-rate", type=float, default=1.25,
                    help="partial windows per second (1.25 ~= 1.6 s windows, 50%% overlap)")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"],
                    help="resemblyzer device (cpu only for this pipeline)")
    return ap.parse_args()


# ---------------------------------------------------------------------------
# single-file: ffmpeg decode + deterministic silence slicing
# ---------------------------------------------------------------------------
AUDIO_EXTS = {".wav", ".flac", ".mp3", ".m4b", ".m4a", ".ogg", ".opus", ".aac", ".wma"}


def ffmpeg_decode_16k_mono(ffmpeg, src, dst):
    """Decode any input to 16 kHz mono 16-bit PCM wav. Fails loudly."""
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffmpeg decode failed ({r.returncode}): {r.stderr.strip()}")
    if not os.path.exists(dst) or os.path.getsize(dst) == 0:
        die(f"ffmpeg produced no output: {dst}")


def build_segments(y, sr, min_clip, max_clip, top_db, librosa, np):
    """Cut y into 3-20 s segments at silences. Returns list of (start_samp, end_samp).

    Deterministic: librosa.effects.split gives voiced runs; over-long runs are
    hard-split at max; runs are then greedily packed into segments up to max,
    closing a segment (at a silence gap) once it is >= min.
    """
    intervals = librosa.effects.split(y, top_db=top_db, frame_length=2048, hop_length=512)
    if len(intervals) == 0:
        return []
    max_samp = int(max_clip * sr)
    min_samp = int(min_clip * sr)
    runs = []
    for s, e in intervals:
        if e - s > max_samp:
            p = s
            while p < e:
                runs.append((int(p), int(min(p + max_samp, e))))
                p += max_samp
        else:
            runs.append((int(s), int(e)))
    segs = []
    cs, ce = runs[0]
    for s, e in runs[1:]:
        if (e - cs) <= max_samp:
            ce = e
        else:
            if (ce - cs) >= min_samp:
                segs.append((cs, ce))
                cs, ce = s, e
            else:
                ce = e  # current too short; extend past target rather than emit a sub-min clip
    if (ce - cs) >= min_samp:
        segs.append((cs, ce))
    elif segs:
        ls, _ = segs[-1]
        segs[-1] = (ls, ce)  # fold a short tail into the previous segment
    else:
        segs.append((cs, ce))
    return segs


def harmonic_ratio(y, sr, librosa, np):
    """Background-music score: HPSS harmonic-energy fraction of the RAW clip.

    Music beds add sustained tonal (harmonic) energy that persists through the
    narration's pauses, pushing this fraction up. Measured on a single-narrator
    null test (no music) it tops out ~0.55; ad/music clips reach ~0.69. MUST run
    on the RAW audio — silence-trimmed embedding audio drops the music-in-pauses
    that makes the signal. Cheap: one STFT + one HPSS per clip.
    """
    if len(y) < sr // 2:
        return 0.0
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=512))
    H, P = librosa.decompose.hpss(S)
    he = float((H ** 2).sum())
    pe = float((P ** 2).sum())
    return he / (he + pe + 1e-12)


def write_wav_16k(path, y, sr, np):
    """Write a float [-1,1] mono array as 16-bit PCM wav (no extra deps)."""
    pcm = np.clip(y, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    args = parse_args()

    log_stage("import")
    try:
        import numpy as np
        import librosa
        from resemblyzer import VoiceEncoder, preprocess_wav
        from scipy.cluster.hierarchy import linkage, fcluster
        from scipy.cluster.vq import kmeans2
        from scipy.spatial.distance import pdist
    except Exception as e:  # noqa: BLE001 — surface the real import error loudly
        die(f"missing package in this python env: {e}")

    versions = {
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "librosa": pkg_version("librosa"),
        "resemblyzer": pkg_version("resemblyzer"),
        "scipy": pkg_version("scipy"),
        "torch": pkg_version("torch"),
        "soundfile": pkg_version("soundfile"),
    }

    inp = os.path.abspath(args.input)
    out = os.path.abspath(args.out)
    if not os.path.exists(inp):
        die(f"input not found: {inp}")
    os.makedirs(out, exist_ok=True)

    sr = 16000
    mode = "dir" if os.path.isdir(inp) else "file"

    # scratch for cut segments (single-file mode) — moved into buckets at the end
    seg_tmp = tempfile.mkdtemp(prefix="clipforge-seg-", dir=out)

    # ---- gather clips --------------------------------------------------------
    log_stage("segment")
    clips = []  # {id, name, path, is_source, offset, duration}
    if mode == "file":
        decoded = os.path.join(seg_tmp, "_decoded_16k.wav")
        ffmpeg_decode_16k_mono(args.ffmpeg, inp, decoded)
        y, _ = librosa.load(decoded, sr=sr, mono=True)
        os.remove(decoded)
        segs = build_segments(y, sr, args.min_clip, args.max_clip, args.top_db, librosa, np)
        if not segs:
            die("no voiced segments found (input silent, or --top-db too aggressive)")
        n = len(segs)
        for i, (s, e) in enumerate(segs):
            name = f"seg_{i:05d}_{s / sr:09.2f}s.wav"
            p = os.path.join(seg_tmp, name)
            write_wav_16k(p, y[s:e], sr, np)
            clips.append({"id": i, "name": name, "path": p, "is_source": False,
                          "offset": round(s / sr, 3), "duration": round((e - s) / sr, 3)})
            if i % 25 == 0:
                log_progress(10 * i / max(n, 1))
    else:
        files = sorted(f for f in os.listdir(inp)
                       if os.path.splitext(f)[1].lower() in AUDIO_EXTS
                       and os.path.isfile(os.path.join(inp, f)))
        if not files:
            die(f"no audio files in directory: {inp}")
        for i, f in enumerate(files):
            p = os.path.join(inp, f)
            dur = librosa.get_duration(path=p)
            clips.append({"id": i, "name": f, "path": p, "is_source": True,
                          "offset": None, "duration": round(dur, 3)})

    # ---- embeddings ----------------------------------------------------------
    log_stage("embed")
    encoder = VoiceEncoder(device=args.device, verbose=False)
    whole = []          # whole-clip embeddings (L2-normalized rows)
    self_consist = []   # min pairwise window cosine per clip (recorded; NOT the decision)
    mixed_score = []    # 2-means centroid cosine — the mixed DECISION statistic (see below)
    mixed_frac = []     # smaller of the two window-groups as a fraction of windows
    music_score = []    # HPSS harmonic-energy fraction of the RAW clip (music DECISION)
    n_windows = []
    valid = []          # clips that produced a usable embedding
    total = len(clips)
    for i, c in enumerate(clips):
        # Load the RAW clip ONCE: the music score needs the untrimmed audio (silence
        # trimming would strip the music-in-pauses), and the embedding is then computed
        # from the SAME array (preprocess_wav trims/normalizes it in memory).
        try:
            y_raw, _ = librosa.load(c["path"], sr=sr, mono=True)
        except Exception as e:  # noqa: BLE001
            die(f"load failed for {c['name']}: {e}")
        ms = harmonic_ratio(y_raw, sr, librosa, np)
        try:
            wav = preprocess_wav(y_raw, source_sr=sr)
        except Exception as e:  # noqa: BLE001
            die(f"preprocess failed for {c['name']}: {e}")
        if wav is None or len(wav) < int(0.4 * sr):
            # too short after silence-trim to embed reliably — skip, not fatal
            c["skipped"] = "too_short_after_trim"
            continue
        embed, partials, _ = encoder.embed_utterance(
            wav, return_partials=True, rate=args.window_rate, min_coverage=0.5)
        nw = int(partials.shape[0])
        # self_consistency: min pairwise window cosine. RECORDED for inspection but
        # NOT used to decide mixed — measured on a single-narrator null test it spans
        # 0.27..0.69, overlapping any plausible two-actor value, so it cannot separate.
        if nw >= 2:
            sims = partials @ partials.T
            iu = np.triu_indices(nw, k=1)
            sc = float(sims[iu].min())
        else:
            sc = 1.0
        # mixed DECISION statistic: split the clip's windows into 2 groups (k-means,
        # deterministic seed) and take the cosine between the two group centroids.
        # One actor -> the two centroids stay similar (measured >= 0.60 on the null
        # test); two actors -> centroids diverge (~0.2-0.4). `mfrac` (smaller group
        # share) gates out lopsided single-window outliers.
        if nw >= 4:
            cent, lab = kmeans2(partials, 2, minit="++", seed=0, missing="raise")
            a = partials[lab == 0]
            b = partials[lab == 1]
            if len(a) == 0 or len(b) == 0:
                cross, mfrac = 1.0, 0.0
            else:
                ca = a.mean(axis=0); ca = ca / (np.linalg.norm(ca) + 1e-9)
                cb = b.mean(axis=0); cb = cb / (np.linalg.norm(cb) + 1e-9)
                cross = float(ca @ cb)
                mfrac = min(len(a), len(b)) / nw
        else:
            cross, mfrac = 1.0, 0.0  # too few windows to assess a within-clip voice change
        c["_embed"] = embed
        c["self_consistency"] = round(sc, 4)
        c["mixed_score"] = round(cross, 4)
        c["mixed_frac"] = round(mfrac, 4)
        c["music_score"] = round(ms, 4)
        whole.append(embed)
        self_consist.append(sc)
        mixed_score.append(cross)
        mixed_frac.append(mfrac)
        music_score.append(ms)
        n_windows.append(nw)
        valid.append(c)
        if i % 20 == 0:
            log_progress(10 + 60 * i / max(total, 1))

    if not valid:
        die("no clip produced a usable embedding")
    whole = np.vstack(whole)

    # ---- music detection -----------------------------------------------------
    # A clip carries a BACKGROUND-MUSIC bed when its HPSS harmonic-energy fraction
    # exceeds --music-threshold. CONSERVATIVE by design (certainty > quantity): the
    # default sits above the single-narrator ceiling with margin, so it flags only
    # clear music beds; borderline clips fall through to uncertain/, not music/.
    log_stage("music")
    music_flags = [music_score[i] > args.music_threshold for i in range(len(valid))]

    # ---- mixed detection -----------------------------------------------------
    # A clip is MIXED (more than one actor) when its two window-groups are well
    # separated (centroid cosine < --mixed-threshold) AND both groups are
    # substantial (smaller group >= --mixed-min-frac of windows). The min-frac gate
    # means a lopsided straddle (mostly one actor + a few words of another) is left
    # to cluster with its dominant actor rather than pulled into mixed/.
    log_stage("mixed")
    mixed_flags = [mixed_score[i] < args.mixed_threshold and mixed_frac[i] >= args.mixed_min_frac
                   for i in range(len(valid))]

    # PRECEDENCE: music > mixed > cluster. A music bed is the dominant disqualifier
    # (it contaminates any actor centroid), so a music-flagged clip goes to music/
    # even if it is also multi-voice. Only clips that are NEITHER music NOR mixed are
    # clustered — anything excluded here can never pollute an actor centroid.
    single_idx = [i for i in range(len(valid)) if not music_flags[i] and not mixed_flags[i]]

    # ---- clustering (single-voice only) --------------------------------------
    log_stage("cluster")
    labels = {}  # index into `valid` -> raw cluster id (1..K), or None if mixed
    if len(single_idx) == 1:
        labels[single_idx[0]] = 1
        n_raw = 1
    elif len(single_idx) >= 2:
        X = whole[single_idx]
        d = pdist(X, metric="cosine")
        Z = linkage(d, method="average")
        raw = fcluster(Z, t=args.cluster_threshold, criterion="distance")
        for j, idx in enumerate(single_idx):
            labels[idx] = int(raw[j])
        n_raw = int(raw.max())
    else:
        n_raw = 0

    # centroids over raw clusters (L2-normalized mean of whole-clip embeddings)
    centroids = {}
    for cid in range(1, n_raw + 1):
        members = [whole[i] for i in single_idx if labels.get(i) == cid]
        if not members:
            continue
        cen = np.mean(members, axis=0)
        norm = np.linalg.norm(cen)
        centroids[cid] = cen / norm if norm > 0 else cen

    # ---- uncertain (low assignment margin) -----------------------------------
    log_stage("uncertain")
    bucket = {}   # index into valid -> "music" | "mixed" | "uncertain" | cid(int)
    margin = {}
    for i in range(len(valid)):
        if music_flags[i]:      # precedence: music wins over mixed
            bucket[i] = "music"
            margin[i] = None
            continue
        if mixed_flags[i]:
            bucket[i] = "mixed"
            margin[i] = None
            continue
        cid = labels[i]
        own = float(whole[i] @ centroids[cid])
        others = [float(whole[i] @ c) for oc, c in centroids.items() if oc != cid]
        if others:
            nearest = max(others)
            m = own - nearest
            margin[i] = round(m, 4)
            bucket[i] = "uncertain" if m < args.uncertain_margin else cid
        else:
            margin[i] = None       # only one cluster — nothing to be ambiguous against
            bucket[i] = cid

    # relabel surviving clusters by size (descending) -> cluster_01..NN
    surviving = {}
    for i in range(len(valid)):
        b = bucket[i]
        if isinstance(b, int):
            surviving.setdefault(b, []).append(i)
    order = sorted(surviving.keys(), key=lambda cid: -len(surviving[cid]))
    relabel = {cid: k + 1 for k, cid in enumerate(order)}
    n_clusters = len(order)

    # ---- write buckets -------------------------------------------------------
    log_stage("write")

    def bucket_dirname(i):
        b = bucket[i]
        if b == "music":
            return "music"
        if b == "mixed":
            return "mixed"
        if b == "uncertain":
            return "uncertain"
        return f"cluster_{relabel[b]:02d}"

    dirs = set()
    for i in range(len(valid)):
        dirs.add(bucket_dirname(i))
    for d in dirs:
        os.makedirs(os.path.join(out, d), exist_ok=True)

    per_clip = []
    for i, c in enumerate(valid):
        dname = bucket_dirname(i)
        dst = os.path.join(out, dname, c["name"])
        if c["is_source"]:
            shutil.copy2(c["path"], dst)   # NEVER modify/move a source clip
        else:
            shutil.move(c["path"], dst)    # cut segment: move out of scratch
        rec = {
            "file": os.path.join(dname, c["name"]).replace("\\", "/"),
            "bucket": dname,
            "confidence": margin[i],
            "self_consistency": c["self_consistency"],
            "mixed_score": c["mixed_score"],
            "mixed_frac": c["mixed_frac"],
            "music_score": c["music_score"],
            "n_windows": n_windows[i],
            "duration": c["duration"],
        }
        if c["offset"] is not None:
            rec["source_offset"] = c["offset"]
        per_clip.append(rec)

    # clips that were skipped (too short) — recorded, not bucketed
    skipped = [{"file": c["name"], "reason": c.get("skipped")} for c in clips if c.get("skipped")]

    # per-cluster stats + exemplars (3 most-central surviving clips)
    per_cluster = []
    for cid in order:
        members = surviving[cid]
        cen = centroids[cid]
        scored = sorted(members, key=lambda i: -float(whole[i] @ cen))
        exemplars = [os.path.join(bucket_dirname(i), valid[i]["name"]).replace("\\", "/")
                     for i in scored[:3]]
        per_cluster.append({
            "cluster": f"cluster_{relabel[cid]:02d}",
            "size": len(members),
            "total_seconds": round(sum(valid[i]["duration"] for i in members), 1),
            "exemplars": exemplars,
        })
    per_cluster.sort(key=lambda c: c["cluster"])

    n_music = sum(1 for i in range(len(valid)) if bucket[i] == "music")
    n_mixed = sum(1 for i in range(len(valid)) if bucket[i] == "mixed")
    n_uncertain = sum(1 for i in range(len(valid)) if bucket[i] == "uncertain")

    speakers = {
        "mode": mode,
        "input": inp,
        "versions": versions,
        "thresholds": {
            "cluster_threshold": args.cluster_threshold,
            "mixed_threshold": args.mixed_threshold,
            "mixed_min_frac": args.mixed_min_frac,
            "music_threshold": args.music_threshold,
            "uncertain_margin": args.uncertain_margin,
            "min_clip": args.min_clip,
            "max_clip": args.max_clip,
            "top_db": args.top_db,
            "window_rate": args.window_rate,
            "device": args.device,
        },
        "summary": {
            "total_clips": len(clips),
            "embedded_clips": len(valid),
            "skipped_clips": len(skipped),
            "clusters": n_clusters,
            "music": n_music,
            "mixed": n_mixed,
            "uncertain": n_uncertain,
        },
        "clusters": per_cluster,
        "clips": per_clip,
        "skipped": skipped,
    }
    speakers_path = os.path.join(out, "speakers.json")
    with open(speakers_path, "w", encoding="utf-8") as f:
        json.dump(speakers, f, indent=2)

    # scrub scratch (segments already moved into buckets)
    try:
        shutil.rmtree(seg_tmp)
    except OSError:
        pass

    # ---- human summary table -------------------------------------------------
    log_progress(100)
    print("", flush=True)
    print(f"Speaker bucketing — mode={mode}  clips={len(clips)} (embedded {len(valid)}, skipped {len(skipped)})", flush=True)
    print(f"  thresholds: cluster={args.cluster_threshold} mixed={args.mixed_threshold} "
          f"music={args.music_threshold} uncertain-margin={args.uncertain_margin}", flush=True)
    print("", flush=True)
    print(f"  {'bucket':<14} {'clips':>6} {'seconds':>10}   exemplars", flush=True)
    print(f"  {'-'*14} {'-'*6} {'-'*10}   {'-'*9}", flush=True)
    for pc in per_cluster:
        ex = pc["exemplars"][0] if pc["exemplars"] else ""
        print(f"  {pc['cluster']:<14} {pc['size']:>6} {pc['total_seconds']:>10.1f}   {ex}", flush=True)
    secs_for = lambda name: round(sum(valid[i]["duration"] for i in range(len(valid)) if bucket[i] == name), 1)
    print(f"  {'music':<14} {n_music:>6} {secs_for('music'):>10.1f}", flush=True)
    print(f"  {'mixed':<14} {n_mixed:>6} {secs_for('mixed'):>10.1f}", flush=True)
    print(f"  {'uncertain':<14} {n_uncertain:>6} {secs_for('uncertain'):>10.1f}", flush=True)
    print("", flush=True)

    print("RESULT " + json.dumps({
        "ok": True,
        "speakersJson": speakers_path,
        "clusters": n_clusters,
        "music": n_music,
        "mixed": n_mixed,
        "uncertain": n_uncertain,
        "embedded": len(valid),
        "total": len(clips),
    }), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — protocol demands a loud ERROR line
        die(str(e))
