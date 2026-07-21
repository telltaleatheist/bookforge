#!/usr/bin/env python
"""clip_mergemap.py — Adobe-Podcast round-trip: merge clips -> one file, then
split the enhanced file back into the original clip boundaries.

The real worker behind ClipForge's `merge` and `split` CLI verbs.

WORKFLOW (why this exists):
  1. `merge` assembles many training clips into ONE wav (at full source
     quality) and writes a `<out>.mergemap.json` describing every segment's
     position in the merged timeline.
  2. The human uploads that wav to Adobe Podcast Enhance. Adobe REGENERATES the
     speech (it is a generative model, not a filter): it always returns 48 kHz
     and MAY subtly shift local timing.
  3. `split` reads the enhanced file + the mergemap and cuts it back into the
     original per-clip boundaries, snapping each cut to the real silence trough
     (because Adobe's timing drifted) and REPORTING that drift.

--gap RATIONALE:
  Adobe's regeneration is context-based; a hard join between two discontinuous
  utterances can smear regeneration artifacts ACROSS the boundary. Inserting a
  short digital-silence gap gives the model a clean seam per clip. `split`
  removes the gap again (excising exactly the inserted amount, split at the
  trough) so it never reaches training data.

DRIFT LOG:
  `split` records expected-vs-snapped position at every join. That per-join
  drift is the EMPIRICAL answer to "does Adobe shift timing?" — surfaced on
  stdout (max/mean) and per-join in the splitmap.

CERTAINTY OVER QUANTITY (project law): no fallbacks. If the enhanced duration
is outside tolerance, or a join has NO real silence trough (misalignment), the
tool FAILS LOUDLY naming the offender rather than mis-cutting silently.

Progress protocol (stdout, one per line, for the JS bridge to parse):
  STAGE <name>
  PROGRESS <0-100>
  RESULT {"ok":true, ...}
  ERROR <message>

Usage:
  clip_mergemap.py merge --mode list  --list <txt> --out <out.wav> [--gap 0]
  clip_mergemap.py merge --mode bucket --speakers <json> --bucket <name>
      --source <file> --minutes <N> --out <out.wav> --ffmpeg <ffmpeg.exe> [--gap 0]
  clip_mergemap.py split --input <enhanced.wav> --map <x.mergemap.json>
      --out <dir> [--snap-window 0.5] [--tolerance 1.0]
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

MERGEMAP_SCHEMA = "clipforge.mergemap/1"
SPLITMAP_SCHEMA = "clipforge.splitmap/1"

# split-detection constants (measured defaults — see the tuning notes in
# CLIPFORGE_PLAN.md; these are NOT guessed).
FRAME_MS = 20.0            # RMS frame length (auto-editor-style short-frame loudness)
HOP_MS = 5.0              # RMS hop — 5 ms cut resolution
# A join's trough must be at least this many dB below the window's speech level
# to count as real silence. Below it, there is no silence there = misalignment.
TROUGH_DROP_DB = 12.0


def log_stage(name):
    print(f"STAGE {name}", flush=True)


def log_progress(pct):
    print(f"PROGRESS {int(pct)}", flush=True)


def die(msg):
    print(f"ERROR {msg}", flush=True)
    sys.exit(1)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------
def read_pcm16(sf, np, path):
    """Read a wav/flac as int16 PCM. Returns (data[n] or [n,ch], sr, channels).

    int16 is read exactly (no float round-trip) so a merge->split round-trip on
    an UNMODIFIED file is sample-identical.
    """
    data, sr = sf.read(path, dtype="int16", always_2d=False)
    channels = 1 if data.ndim == 1 else data.shape[1]
    return data, int(sr), channels


def ffmpeg_probe_stream(ffprobe, src):
    """Return (sample_rate, channels) of the first audio stream. Fails loudly."""
    cmd = [ffprobe, "-v", "error", "-select_streams", "a:0",
           "-show_entries", "stream=sample_rate,channels",
           "-of", "json", src]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffprobe failed on source ({r.returncode}): {r.stderr.strip()}")
    try:
        info = json.loads(r.stdout)
        st = info["streams"][0]
        return int(st["sample_rate"]), int(st["channels"])
    except Exception as e:  # noqa: BLE001
        die(f"ffprobe gave no usable audio stream for {src}: {e}")


def ffmpeg_cut_segment(ffmpeg, src, offset, duration, sr, channels, dst):
    """Cut [offset, offset+duration] from src at FULL quality (native sr/ch),
    as pcm_s16le. -ss before -i is a fast seek; re-decoded to pcm so the cut is
    exact. Fails loudly."""
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", f"{offset:.6f}", "-i", src, "-t", f"{duration:.6f}",
           "-ar", str(sr), "-ac", str(channels), "-c:a", "pcm_s16le", dst]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffmpeg cut failed ({r.returncode}) at {offset:.3f}s: {r.stderr.strip()}")
    if not os.path.exists(dst) or os.path.getsize(dst) == 0:
        die(f"ffmpeg produced no output for segment at {offset:.3f}s")


def select_bucket_clips(speakers_json, bucket, minutes):
    """Top-confidence clips of `bucket` until `minutes` accumulate, then sorted
    by source_offset. Reproduces the speakers-bucket assembly workflow.

    `confidence` is the assignment margin (higher = more confident). A single-
    cluster speakers run records confidence=null (nothing to be ambiguous
    against) — those clips are treated as MAXIMALLY confident, which is exactly
    what a single-cluster run means, not a fallback masking a missing value.
    """
    with open(speakers_json, "r", encoding="utf-8") as f:
        sp = json.load(f)
    clips = [c for c in sp.get("clips", []) if c.get("bucket") == bucket]
    if not clips:
        buckets = sorted({c.get("bucket") for c in sp.get("clips", [])})
        die(f"bucket '{bucket}' has no clips in {speakers_json} (buckets present: {buckets})")
    for c in clips:
        if c.get("source_offset") is None or c.get("duration") is None:
            die(f"clip {c.get('file')} lacks source_offset/duration — bucket mode needs "
                f"single-file speakers output (segments cut from a source), not directory mode")

    def conf_key(c):
        v = c.get("confidence")
        return float("inf") if v is None else v
    ranked = sorted(clips, key=conf_key, reverse=True)
    budget = minutes * 60.0
    chosen, acc = [], 0.0
    for c in ranked:
        if acc >= budget:
            break
        chosen.append(c)
        acc += c["duration"]
    if not chosen:
        die(f"selected 0 clips for bucket '{bucket}' — --minutes {minutes} too small?")
    chosen.sort(key=lambda c: c["source_offset"])
    return chosen, acc


def do_merge(args, sf, np):
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    gap = float(args.gap)
    if gap < 0:
        die(f"--gap must be >= 0 (got {gap})")

    invocation = {
        "tool": "clipforge-process merge",
        "op": "merge",
        "ranAt": now_iso(),
        "mode": args.mode,
        "gap_seconds": gap,
        "out": out,
    }

    # Build a uniform list of (pcm_int16, sr, channels, source_path, clip_name,
    # source_offset, source_duration). Two selection modes converge here.
    log_stage("select")
    seg_tmp = None
    entries = []  # dicts as above
    if args.mode == "list":
        if not args.list:
            die("merge --mode list requires --list <txt>")
        list_path = os.path.abspath(args.list)
        if not os.path.exists(list_path):
            die(f"--list file not found: {list_path}")
        with open(list_path, "r", encoding="utf-8") as f:
            paths = [ln.strip() for ln in f if ln.strip()]
        if not paths:
            die(f"--list file is empty: {list_path}")
        for p in paths:
            ap = os.path.abspath(p)
            if not os.path.exists(ap):
                die(f"--list entry not found: {p}")
            entries.append({"source": ap, "clip_name": os.path.basename(ap),
                            "offset": None, "src_dur": None})
        invocation["list"] = list_path
        invocation["clip_count"] = len(entries)
    elif args.mode == "bucket":
        for req in ("speakers", "bucket", "source", "minutes", "ffmpeg"):
            if getattr(args, req) in (None, ""):
                die(f"merge --mode bucket requires --{req}")
        speakers_json = os.path.abspath(args.speakers)
        source = os.path.abspath(args.source)
        if not os.path.exists(speakers_json):
            die(f"--speakers json not found: {speakers_json}")
        if not os.path.exists(source):
            die(f"--source not found: {source}")
        ffprobe = os.path.join(os.path.dirname(args.ffmpeg),
                               "ffprobe.exe" if os.name == "nt" else "ffprobe")
        if not os.path.exists(ffprobe):
            die(f"ffprobe not found next to ffmpeg: {ffprobe}")
        src_sr, src_ch = ffmpeg_probe_stream(ffprobe, source)
        chosen, acc = select_bucket_clips(speakers_json, args.bucket, float(args.minutes))
        seg_tmp = tempfile.mkdtemp(prefix="clipforge-merge-", dir=os.path.dirname(out))
        for i, c in enumerate(chosen):
            dst = os.path.join(seg_tmp, f"_cut_{i:05d}.wav")
            ffmpeg_cut_segment(args.ffmpeg, source, c["source_offset"], c["duration"],
                               src_sr, src_ch, dst)
            entries.append({"source": source, "clip_name": os.path.basename(c["file"]),
                            "offset": c["source_offset"], "src_dur": c["duration"],
                            "_cut_wav": dst})
            if i % 20 == 0:
                log_progress(40 * i / max(len(chosen), 1))
        invocation["speakers"] = speakers_json
        invocation["bucket"] = args.bucket
        invocation["source"] = source
        invocation["minutes"] = float(args.minutes)
        invocation["selected_seconds"] = round(acc, 3)
        invocation["source_sample_rate"] = src_sr
        invocation["source_channels"] = src_ch
    else:
        die(f"unknown --mode: {args.mode}")

    # ---- read every segment's PCM and verify uniform rate/channels -----------
    log_stage("read")
    hash_cache = {}   # distinct source file -> sha256 (hash each file ONCE)
    pcms = []
    sr0 = None
    ch0 = None
    rate_offenders = []
    ch_offenders = []
    for i, e in enumerate(entries):
        read_from = e.get("_cut_wav", e["source"])
        pcm, sr, ch = read_pcm16(sf, np, read_from)
        if sr0 is None:
            sr0, ch0 = sr, ch
        if sr != sr0:
            rate_offenders.append((e["source"], sr))
        if ch != ch0:
            ch_offenders.append((e["source"], ch))
        pcms.append(pcm)
        # hash the ORIGINAL source (not the temp cut), each distinct file once
        if e["source"] not in hash_cache:
            hash_cache[e["source"]] = sha256_file(e["source"])
        if i % 20 == 0:
            log_progress(40 + 30 * i / max(len(entries), 1))
    if rate_offenders:
        lines = "\n".join(f"    {p}: {s} Hz (expected {sr0} Hz)" for p, s in rate_offenders)
        die("heterogeneous sample rates in --list — no silent resampling. Offenders:\n" + lines)
    if ch_offenders:
        lines = "\n".join(f"    {p}: {c} ch (expected {ch0} ch)" for p, c in ch_offenders)
        die("heterogeneous channel counts in --list. Offenders:\n" + lines)

    # ---- concatenate with gaps ----------------------------------------------
    log_stage("concat")
    gap_samples = int(round(gap * sr0))
    if ch0 == 1:
        gap_block = np.zeros(gap_samples, dtype="int16")
    else:
        gap_block = np.zeros((gap_samples, ch0), dtype="int16")
    pieces = []
    segments = []
    cursor = 0  # samples in merged timeline
    for i, (e, pcm) in enumerate(zip(entries, pcms)):
        start = cursor
        pieces.append(pcm)
        cursor += pcm.shape[0]
        end = cursor
        seg = {
            "index": i,
            "source": e["source"],
            "sha256": hash_cache[e["source"]],
            "clip_name": e["clip_name"],
            "start": round(start / sr0, 6),
            "end": round(end / sr0, 6),
            "duration": round((end - start) / sr0, 6),
            "start_sample": start,
            "end_sample": end,
        }
        if e["offset"] is not None:
            seg["source_offset"] = e["offset"]
            seg["source_duration"] = e["src_dur"]
        segments.append(seg)
        # gap AFTER every segment except the last (interior seams only)
        if gap_samples > 0 and i < len(entries) - 1:
            pieces.append(gap_block)
            cursor += gap_samples

    merged = np.concatenate(pieces, axis=0)
    total_samples = merged.shape[0]

    log_stage("write")
    sf.write(out, merged, sr0, subtype="PCM_16")

    mergemap = {
        "schema": MERGEMAP_SCHEMA,
        "created_by": invocation,
        "mode": args.mode,
        "gap_seconds": gap,
        "sample_rate": sr0,
        "channels": ch0,
        "output": out,
        "total_duration": round(total_samples / sr0, 6),
        "total_samples": int(total_samples),
        "sources": [{"path": p, "sha256": h} for p, h in hash_cache.items()],
        "segments": segments,
    }
    map_path = out + ".mergemap.json"
    with open(map_path, "w", encoding="utf-8") as f:
        json.dump(mergemap, f, indent=2)

    # scrub temp cut wavs
    if seg_tmp:
        for e in entries:
            cw = e.get("_cut_wav")
            if cw and os.path.exists(cw):
                os.remove(cw)
        try:
            os.rmdir(seg_tmp)
        except OSError:
            pass

    log_progress(100)
    print("", flush=True)
    print(f"Merge — mode={args.mode}  segments={len(segments)}  gap={gap}s", flush=True)
    print(f"  {sr0} Hz / {ch0} ch / {total_samples / sr0:.3f} s total", flush=True)
    print(f"  output:   {out}", flush=True)
    print(f"  mergemap: {map_path}", flush=True)
    print("", flush=True)
    print("RESULT " + json.dumps({
        "ok": True,
        "output": out,
        "mergemapPath": map_path,
        "segments": len(segments),
        "gap": gap,
        "sampleRate": sr0,
        "channels": ch0,
        "totalDuration": round(total_samples / sr0, 6),
    }), flush=True)


# ---------------------------------------------------------------------------
# split
# ---------------------------------------------------------------------------
def frame_rms(np, mono, win_start, win_end, frame_len, hop):
    """RMS per frame over mono[win_start:win_end]. Returns (rms[], center_sample[]).

    center_sample is the absolute sample index of each frame's center — the
    coordinate a cut is placed at.
    """
    seg = mono[win_start:win_end].astype("float64")
    n = seg.shape[0]
    if n < frame_len:
        # window at a file edge shorter than one frame — single RMS over it
        rms = np.array([np.sqrt(np.mean(seg ** 2)) if n else 0.0])
        return rms, np.array([win_start + n // 2])
    starts = np.arange(0, n - frame_len + 1, hop)
    rms = np.empty(starts.shape[0], dtype="float64")
    for k, s in enumerate(starts):
        block = seg[s:s + frame_len]
        rms[k] = np.sqrt(np.mean(block ** 2))
    centers = win_start + starts + frame_len // 2
    return rms, centers


def find_trough(np, mono, expected_sample, snap_samples, frame_len, hop):
    """Search +/- snap_samples around expected_sample for the silence trough.

    Returns (trough_sample, trough_rms, speech_rms, drop_db). The trough is the
    CENTER of the low-RMS plateau containing the minimum frame — so a flat
    digital-silence gap resolves to its centre (needed for symmetric gap
    excision), not to its leading edge.
    """
    win_start = max(0, expected_sample - snap_samples)
    win_end = min(mono.shape[0], expected_sample + snap_samples)
    rms, centers = frame_rms(np, mono, win_start, win_end, frame_len, hop)
    imin = int(np.argmin(rms))
    trough_rms = float(rms[imin])
    # plateau = contiguous frames within a tight band of the minimum. +1.0 makes
    # a pure-zero gap (min=0) resolve to the whole zero-run; the *1.5 handles a
    # non-zero natural-silence valley bottom.
    band = trough_rms * 1.5 + 1.0
    lo = imin
    while lo - 1 >= 0 and rms[lo - 1] <= band:
        lo -= 1
    hi = imin
    while hi + 1 < rms.shape[0] and rms[hi + 1] <= band:
        hi += 1
    plateau_center = (lo + hi) // 2
    trough_sample = int(centers[plateau_center])
    # speech level in the window = 90th-percentile frame RMS (represents the
    # loud content the trough must sit well below).
    speech_rms = float(np.percentile(rms, 90))
    drop_db = 20.0 * np.log10((speech_rms + 1.0) / (trough_rms + 1.0))
    return trough_sample, trough_rms, speech_rms, float(drop_db)


def do_split(args, sf, np):
    enhanced = os.path.abspath(args.input)
    map_path = os.path.abspath(args.map)
    out_dir = os.path.abspath(args.out)
    if not os.path.exists(enhanced):
        die(f"--input not found: {enhanced}")
    if not os.path.exists(map_path):
        die(f"--map not found: {map_path}")
    os.makedirs(out_dir, exist_ok=True)
    snap_window = float(args.snap_window)
    tolerance = float(args.tolerance)
    if snap_window <= 0:
        die(f"--snap-window must be > 0 (got {snap_window})")

    log_stage("load-map")
    with open(map_path, "r", encoding="utf-8") as f:
        mm = json.load(f)
    for req in ("schema", "gap_seconds", "total_duration", "segments"):
        if req not in mm:
            die(f"mergemap missing required field '{req}': {map_path}")
    if mm["schema"] != MERGEMAP_SCHEMA:
        die(f"mergemap schema '{mm['schema']}' != expected '{MERGEMAP_SCHEMA}'")
    segments = mm["segments"]
    if not segments:
        die("mergemap has no segments")
    for s in segments:
        for req in ("index", "clip_name", "start", "end"):
            if req not in s:
                die(f"mergemap segment {s.get('index', '?')} missing field '{req}'")
    gap = float(mm["gap_seconds"])
    map_total = float(mm["total_duration"])

    log_stage("read")
    pcm, sr = sf.read(enhanced, dtype="int16", always_2d=False)
    channels = 1 if pcm.ndim == 1 else pcm.shape[1]
    n_samples = pcm.shape[0]
    actual_dur = n_samples / sr
    # mono view for RMS (average channels if stereo — loudness only, output PCM
    # is untouched)
    mono = pcm if pcm.ndim == 1 else pcm.mean(axis=1)

    # ---- duration check FIRST ------------------------------------------------
    log_stage("duration-check")
    delta = actual_dur - map_total
    if abs(delta) > tolerance:
        die(f"enhanced duration {actual_dur:.3f}s differs from mergemap total "
            f"{map_total:.3f}s by {delta:+.3f}s (> tolerance {tolerance}s) — Adobe "
            f"truncated or padded the file; refusing to guess boundaries.")

    frame_len = int(round(FRAME_MS / 1000.0 * sr))
    hop = max(1, int(round(HOP_MS / 1000.0 * sr)))
    snap_samples = int(round(snap_window * sr))
    half_gap = gap / 2.0

    # ---- snap each interior join to its silence trough -----------------------
    log_stage("snap")
    # A "join" is the seam between segment i and i+1. The expected cut point in
    # merged coords: with a gap, the centre of the inserted gap; without, the
    # shared boundary. Segment start/end already account for gaps.
    n_joins = len(segments) - 1
    joins = []  # {join_index, expected, snapped, drift, trough_db_below}
    for j in range(n_joins):
        end_i = float(segments[j]["end"])
        start_next = float(segments[j + 1]["start"])
        expected = (end_i + start_next) / 2.0   # == gap centre (or the boundary if gap==0)
        expected_sample = int(round(expected * sr))
        trough_sample, trough_rms, speech_rms, drop_db = find_trough(
            np, mono, expected_sample, snap_samples, frame_len, hop)
        if drop_db < TROUGH_DROP_DB:
            die(f"join {j} (between '{segments[j]['clip_name']}' and "
                f"'{segments[j + 1]['clip_name']}', expected {expected:.3f}s): no silence "
                f"trough — quietest point is only {drop_db:.1f} dB below speech "
                f"(need >= {TROUGH_DROP_DB} dB). File is misaligned; refusing to mis-cut.")
        snapped = trough_sample / sr
        joins.append({
            "join_index": j,
            "expected": round(expected, 6),
            "snapped": round(snapped, 6),
            "drift": round(snapped - expected, 6),
            "trough_db_below_speech": round(drop_db, 2),
            "trough_sample": trough_sample,
        })
        log_progress(10 + 70 * j / max(n_joins, 1))

    # ---- derive per-segment cut boundaries -----------------------------------
    # gap==0: segment i = [prev_trough, this_trough]; the trough IS the boundary.
    # gap>0 : the trough sits at the gap centre. Excise exactly the inserted gap
    #   by pulling each side back by half_gap FROM THE TROUGH — this removes the
    #   g of inserted silence (split g/2 per side) while leaving each clip's own
    #   natural edge silence untouched, and it tracks drift because the trough
    #   moved with the content.
    half_gap_samples = int(round(half_gap * sr))
    cut_lefts = [0]                     # start sample of each segment
    cut_rights = [None] * len(segments)  # end sample of each segment
    for j, jn in enumerate(joins):
        t = jn["trough_sample"]
        cut_rights[j] = t - half_gap_samples       # end of segment j
        cut_lefts.append(t + half_gap_samples)     # start of segment j+1
    cut_rights[-1] = n_samples

    log_stage("write")
    out_records = []
    used_names = set()
    for i, s in enumerate(segments):
        a = max(0, cut_lefts[i])
        b = min(n_samples, cut_rights[i])
        if b <= a:
            die(f"segment {i} ('{s['clip_name']}') collapsed to <=0 samples "
                f"([{a}, {b}]) — gap/snap geometry is inconsistent with the file.")
        name = s["clip_name"]
        if name in used_names:
            die(f"duplicate clip_name in mergemap: {name} — output would collide")
        used_names.add(name)
        piece = pcm[a:b]
        dst = os.path.join(out_dir, name)
        sf.write(dst, piece, sr, subtype="PCM_16")
        out_records.append({
            "index": i,
            "clip_name": name,
            "output": dst,
            "start_sample": int(a),
            "end_sample": int(b),
            "duration": round((b - a) / sr, 6),
        })

    drifts = [j["drift"] for j in joins]
    abs_drifts = [abs(d) for d in drifts]
    drift_stats = {
        "joins": len(joins),
        "max_abs": round(max(abs_drifts), 6) if abs_drifts else 0.0,
        "mean_abs": round(sum(abs_drifts) / len(abs_drifts), 6) if abs_drifts else 0.0,
        "max_signed": round(max(drifts), 6) if drifts else 0.0,
        "min_signed": round(min(drifts), 6) if drifts else 0.0,
    }

    splitmap = {
        "schema": SPLITMAP_SCHEMA,
        "created_by": {
            "tool": "clipforge-process split",
            "op": "split",
            "ranAt": now_iso(),
            "input": enhanced,
            "map": map_path,
            "snap_window": snap_window,
            "tolerance": tolerance,
        },
        "input": enhanced,
        "map": map_path,
        "sample_rate": sr,
        "channels": channels,
        "input_duration": round(actual_dur, 6),
        "map_total_duration": round(map_total, 6),
        "duration_delta": round(delta, 6),
        "gap_seconds": gap,
        "drift": drift_stats,
        "joins": joins,
        "segments": out_records,
    }
    split_path = os.path.join(out_dir, "splitmap.json")
    with open(split_path, "w", encoding="utf-8") as f:
        json.dump(splitmap, f, indent=2)

    log_progress(100)
    print("", flush=True)
    print(f"Split — {len(out_records)} segments  gap={gap}s  {sr} Hz / {channels} ch", flush=True)
    print(f"  input:  {actual_dur:.3f}s  (map total {map_total:.3f}s, delta {delta:+.3f}s)", flush=True)
    print(f"  drift:  max |{drift_stats['max_abs']:.4f}| s   mean |{drift_stats['mean_abs']:.4f}| s   "
          f"signed [{drift_stats['min_signed']:+.4f}, {drift_stats['max_signed']:+.4f}] s", flush=True)
    print(f"  splitmap: {split_path}", flush=True)
    print("", flush=True)
    print("RESULT " + json.dumps({
        "ok": True,
        "outDir": out_dir,
        "splitmapPath": split_path,
        "segments": len(out_records),
        "sampleRate": sr,
        "channels": channels,
        "gap": gap,
        "driftMaxAbs": drift_stats["max_abs"],
        "driftMeanAbs": drift_stats["mean_abs"],
    }), flush=True)


# ---------------------------------------------------------------------------
def parse_args():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="op", required=True)

    m = sub.add_parser("merge")
    m.add_argument("--mode", required=True, choices=["list", "bucket"])
    m.add_argument("--out", required=True)
    m.add_argument("--gap", type=float, default=0.0)
    m.add_argument("--list")
    m.add_argument("--speakers")
    m.add_argument("--bucket")
    m.add_argument("--source")
    m.add_argument("--minutes")
    m.add_argument("--ffmpeg")

    s = sub.add_parser("split")
    s.add_argument("--input", required=True)
    s.add_argument("--map", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--snap-window", type=float, default=0.5)
    s.add_argument("--tolerance", type=float, default=1.0)
    return ap.parse_args()


def main():
    args = parse_args()
    try:
        import numpy as np
        import soundfile as sf
    except Exception as e:  # noqa: BLE001
        die(f"missing package in this python env: {e}")
    if args.op == "merge":
        do_merge(args, sf, np)
    elif args.op == "split":
        do_split(args, sf, np)
    else:
        die(f"unknown op: {args.op}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — protocol demands a loud ERROR line
        die(str(e))
