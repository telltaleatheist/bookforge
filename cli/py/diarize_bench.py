#!/usr/bin/env python
"""diarize_bench.py — pyannote speaker-diarization-3.1 timeline benchmark for
ClipForge's proposed `diarize` (book -> speaker timeline) mode.

Runs pyannote/speaker-diarization-3.1 on a decoded slice of an audiobook and
writes a speaker timeline (the proposed speakers.map.json shape). A separate
`score` step maps ClipForge ground-truth clip spans onto that timeline and
reports the fatal false-assignment metric + uncertain-time recovery.

Subcommands
  run   --wav <16k.wav> --offset <sec> --out <timeline.json> [--token <hf>]
        Diarize a slice. `offset` is the slice's start time in the BOOK, so all
        emitted start/end are in BOOK time. Records wall-clock + realtime factor.

  score --timeline <timeline.json> [--timeline ...] --gt <gt.json>
        --window-start <sec> --window-end <sec> --out <score.json>
        Map ground-truth labeled clip spans (source_offset..+duration) inside the
        diarized window onto diarization speakers; report the confusion.

NO FALLBACKS: missing token/model/file exits non-zero.
"""
import argparse
import json
import os
import sys
import time


def die(msg):
    print(f"ERROR {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def log(msg):
    print(msg, flush=True)


def run_cmd(args):
    import torch
    import torchaudio
    from pyannote.audio import Pipeline

    token = args.token
    if not token:
        tok_path = os.path.expanduser("~/.cache/huggingface/token")
        if os.path.exists(tok_path):
            token = open(tok_path).read().strip()
    if not token:
        die("no HF token (pass --token or put it at ~/.cache/huggingface/token)")

    log(f"loading pyannote/speaker-diarization-3.1 ...")
    t0 = time.time()
    try:
        pipe = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", use_auth_token=token)
    except TypeError:
        pipe = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", token=token)
    pipe.to(torch.device("cpu"))
    log(f"pipeline loaded in {time.time()-t0:.1f}s")

    wav, sr = torchaudio.load(args.wav)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    dur = wav.shape[1] / sr
    log(f"diarizing {args.wav}  ({dur:.1f}s @ {sr}Hz, book offset {args.offset}s) ...")
    t1 = time.time()
    diar = pipe({"waveform": wav, "sample_rate": sr})
    elapsed = time.time() - t1
    rtf = elapsed / dur
    log(f"diarization done in {elapsed:.1f}s  (RTF {rtf:.3f}x, {1/rtf:.2f}x realtime)")

    segments = []
    speakers = set()
    for turn, _, spk in diar.itertracks(yield_label=True):
        segments.append({
            "start": round(args.offset + turn.start, 3),
            "end": round(args.offset + turn.end, 3),
            "speaker": spk,
        })
        speakers.add(spk)
    segments.sort(key=lambda s: s["start"])
    spk_time = {}
    for s in segments:
        spk_time[s["speaker"]] = spk_time.get(s["speaker"], 0.0) + (s["end"] - s["start"])

    out = {
        "wav": os.path.abspath(args.wav),
        "book_offset": args.offset,
        "slice_seconds": round(dur, 1),
        "diarize_seconds": round(elapsed, 1),
        "realtime_factor": round(rtf, 4),
        "n_speakers": len(speakers),
        "speaker_seconds": {k: round(v, 1) for k, v in sorted(spk_time.items())},
        "segments": segments,
    }
    json.dump(out, open(args.out, "w", encoding="utf-8"), indent=1)
    log(f"wrote {args.out}: {len(segments)} segments, {len(speakers)} speakers, "
        f"speaker_seconds={out['speaker_seconds']}")


def _speaker_at(segments, t0, t1):
    """Return {speaker: overlap_seconds} for the [t0,t1] span across segments."""
    ov = {}
    for s in segments:
        lo = max(t0, s["start"])
        hi = min(t1, s["end"])
        if hi > lo:
            ov[s["speaker"]] = ov.get(s["speaker"], 0.0) + (hi - lo)
    return ov


def score_cmd(args):
    gt = json.load(open(args.gt, encoding="utf-8"))
    segments = []
    for tf in args.timeline:
        t = json.load(open(tf, encoding="utf-8"))
        segments.extend(t["segments"])
    segments.sort(key=lambda s: s["start"])

    ws, we = args.window_start, args.window_end
    # clips whose span falls inside the window
    groups = {"rudnicki": [], "card": [], "voice3": [], "uncertain": []}
    gold = []
    for c in gt["clips"]:
        off = None
        # gt clips store path/name; source_offset lives in the fine speakers.json,
        # so we carry it via the gt build (added below). Fall back to name parse.
        off = c.get("source_offset")
        if off is None:
            # parse from seg_NNNNN_OFFSETs.wav
            import re
            m = re.search(r"_(\d+\.\d+)s\.wav$", c["name"])
            if not m:
                continue
            off = float(m.group(1))
        dur = c.get("duration")
        if dur is None:
            continue
        t0, t1 = off, off + dur
        if t0 < ws or t1 > we:
            continue
        lab = c["label"]
        rec = {"name": c["name"], "t0": round(t0, 2), "t1": round(t1, 2)}
        if lab in groups:
            groups[lab].append(rec)
        if c.get("gold"):
            gold.append(rec)

    # assign each clip span to the diarization speaker with the most overlap
    def assign(rec):
        ov = _speaker_at(segments, rec["t0"], rec["t1"])
        if not ov:
            return None, 0.0, 0.0
        spk = max(ov, key=ov.get)
        span = rec["t1"] - rec["t0"]
        frac = ov[spk] / span if span > 0 else 0.0
        return spk, frac, span

    # the Rudnicki diarization speaker = the one holding the most GOLD clip time
    gold_spk_time = {}
    for rec in gold:
        spk, frac, span = assign(rec)
        if spk is not None:
            gold_spk_time[spk] = gold_spk_time.get(spk, 0.0) + frac * span
    if not gold_spk_time:
        die("no gold clip landed in the diarized window — wrong window?")
    rud_spk = max(gold_spk_time, key=gold_spk_time.get)

    def summarize(recs, label):
        n = len(recs)
        to_rud = 0
        rud_time = 0.0
        total_time = 0.0
        dom = {}
        details = []
        for rec in recs:
            spk, frac, span = assign(rec)
            total_time += span
            details.append({**rec, "speaker": spk, "frac": round(frac, 3)})
            if spk is not None:
                dom[spk] = dom.get(spk, 0) + 1
                if spk == rud_spk:
                    to_rud += 1
                    rud_time += span
        return {
            "label": label, "n": n,
            "assigned_to_rudnicki_speaker": to_rud,
            "time_to_rudnicki_speaker_s": round(rud_time, 1),
            "total_time_s": round(total_time, 1),
            "dominant_speakers": dict(sorted(dom.items(), key=lambda x: -x[1])),
            "details": details if args.details else None,
        }

    res = {
        "window": [ws, we],
        "rudnicki_diar_speaker": rud_spk,
        "gold": summarize(gold, "gold"),
        "rudnicki": summarize(groups["rudnicki"], "rudnicki"),
        "card": summarize(groups["card"], "card"),
        "voice3": summarize(groups["voice3"], "voice3"),
        "uncertain": summarize(groups["uncertain"], "uncertain"),
    }
    # FATAL metric
    res["card_false_assignments"] = res["card"]["assigned_to_rudnicki_speaker"]
    res["voice3_false_assignments"] = res["voice3"]["assigned_to_rudnicki_speaker"]
    res["false_total"] = res["card_false_assignments"] + res["voice3_false_assignments"]

    json.dump(res, open(args.out, "w", encoding="utf-8"), indent=1)
    log(f"\nDIARIZATION SCORING  window [{ws},{we}]  Rudnicki speaker = {rud_spk}")
    for k in ("gold", "rudnicki", "card", "voice3", "uncertain"):
        s = res[k]
        log(f"  {k:10} n={s['n']:4d}  ->Rud {s['assigned_to_rudnicki_speaker']:4d} "
            f"({s['time_to_rudnicki_speaker_s']:7.1f}s / {s['total_time_s']:7.1f}s)  "
            f"speakers={s['dominant_speakers']}")
    log(f"  FATAL: card_false={res['card_false_assignments']}  "
        f"voice3_false={res['voice3_false_assignments']}  total={res['false_total']}")
    log(f"wrote {args.out}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run")
    r.add_argument("--wav", required=True)
    r.add_argument("--offset", type=float, required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--token", default=None)
    r.set_defaults(func=run_cmd)

    s = sub.add_parser("score")
    s.add_argument("--timeline", required=True, action="append")
    s.add_argument("--gt", required=True)
    s.add_argument("--window-start", type=float, required=True)
    s.add_argument("--window-end", type=float, required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--details", action="store_true")
    s.set_defaults(func=score_cmd)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
