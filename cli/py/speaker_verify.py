#!/usr/bin/env python
"""speaker_verify.py — is every clip in this corpus actually the narrator?

WHY: a foreign voice in a training corpus is invisible to every text-based check —
the words are fine. The HarperAudio promo found in deathstalker_rv2h (a DIFFERENT
announcer) is the case this exists to catch, along with Audible intros/outros and
co-narrator inserts.

EMBEDDER: pyannote/wespeaker-voxceleb-resnet34-LM (ResNet34 x-vector, 256-dim,
ungated). Chosen by the ClipForge bake-off on MARGIN, which is the only property
that matters for a verifier:
    backend      narrator median   different-speaker median   margin
    resemblyzer  0.9815            0.7876                     ~0.19
    ecapa        0.9468            0.2138                     ~0.73
    wespeaker    0.9566            0.1747                     ~0.78
Resemblyzer's 0.79 for a genuinely different speaker sits a hair under its own 0.98
target — the documented 0.40 flag / 0.28 floor thresholds are WESPEAKER-SCALE and
would flag NOTHING on resemblyzer. Do not mix the two.

REFERENCE SET: the centroid is built from clips known to be the narrator, not from
the whole corpus. Owen's insight (2026-07-24): the VTT's quote marks already tell us
which clips can contain character voices, so `--reference metadata_narration.csv`
gives a character-voice-free reference for free. Averaging over everything would drag
the centroid toward the very voices we want to measure distance from.

Because quote marks label the corpus, this also CALIBRATES itself: comparing the
narration and dialogue similarity distributions measures how much a given narrator
actually characterizes — a testable claim, not a recollection.

Usage:
  speaker_verify.py --corpus <dir> [--reference metadata_narration.csv]
                    [--compare metadata_dialogue.csv] [--flag-below 0.40]
                    [--out report.json] [--limit N]

NO FALLBACKS: a missing corpus/metadata/model exits non-zero. Clips too short to
embed are reported as `unembeddable`, never silently treated as passing.
"""
import argparse
import csv
import json
import os
import sys

import numpy as np


def log(m):
    print(m, file=sys.stderr, flush=True)


def read_meta(path):
    with open(path, encoding="utf-8") as fh:
        rows = list(csv.reader(fh, delimiter="|"))[1:]
    return [(r[0], r[1]) for r in rows if len(r) >= 2]


def load_embedder():
    import torch
    from pyannote.audio import Model, Inference
    tok_path = os.path.expanduser("~/.cache/huggingface/token")
    tok = open(tok_path).read().strip() if os.path.exists(tok_path) else None
    name = "pyannote/wespeaker-voxceleb-resnet34-LM"

    # torch >= 2.6 defaults torch.load to weights_only=True, which refuses
    # pyannote's checkpoint: it pickles TorchVersion, then Specifications, then
    # Problem/Resolution enums... allowlisting them one at a time is a moving
    # target across pyannote versions. Instead relax weights_only for THIS load
    # only, and restore it immediately — the scope is one known HF model, not a
    # global policy change, and any other torch.load in the process is unaffected.
    original_load = torch.load

    def trusting_load(*a, **kw):
        kw["weights_only"] = False
        return original_load(*a, **kw)

    torch.load = trusting_load
    try:
        try:
            model = Model.from_pretrained(name, use_auth_token=tok)
        except TypeError:
            model = Model.from_pretrained(name, token=tok)
    finally:
        torch.load = original_load
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log(f"[verify] embedder={name} device={device}")
    return Inference(model, window="whole", device=device), torch


def embed(paths, inference, torch):
    """L2-normalized 256-dim embeddings. Returns (matrix, ok_mask)."""
    import soundfile as sf
    out, ok = None, np.ones(len(paths), dtype=bool)
    for i, p in enumerate(paths):
        try:
            # in-memory read: torchcodec's DLL is broken in this env, so never let
            # pyannote open the file itself (same workaround as bench_embedders).
            y, sr = sf.read(p, dtype="float32", always_2d=True)
            wav = torch.from_numpy(y.T)
            if wav.shape[0] > 1:
                wav = wav.mean(dim=0, keepdim=True)
            emb = np.asarray(inference({"waveform": wav, "sample_rate": sr})).reshape(-1)
        except Exception as error:                      # too short to embed, etc.
            ok[i] = False
            log(f"[verify] unembeddable {os.path.basename(p)}: {error}")
            continue
        if out is None:
            out = np.zeros((len(paths), emb.shape[0]), dtype=np.float32)
        norm = np.linalg.norm(emb)
        out[i] = emb / norm if norm > 0 else emb
        if i % 200 == 0:
            log(f"[verify] embedded {i}/{len(paths)}")
    if out is None:
        raise SystemExit("[verify] nothing could be embedded")
    return out, ok


def describe(label, sims):
    if not len(sims):
        return f"  {label:28s} n=0"
    return (f"  {label:28s} n={len(sims):5d}  median={np.median(sims):.4f}  "
            f"p10={np.percentile(sims,10):.4f}  min={sims.min():.4f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--reference", default=None,
                    help="metadata CSV of KNOWN-narrator clips for the centroid "
                         "(default: every clip, which is weaker)")
    ap.add_argument("--compare", default=None,
                    help="metadata CSV to contrast against the reference (e.g. dialogue)")
    ap.add_argument("--flag-below", type=float, default=0.40)
    ap.add_argument("--out", default=None)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    corpus = args.corpus
    if not os.path.isdir(corpus):
        raise SystemExit(f"[verify] corpus not found: {corpus}")

    allrows = []
    for split in ("train", "eval"):
        p = os.path.join(corpus, f"metadata_{split}.csv")
        if os.path.exists(p):
            allrows += read_meta(p)
    if not allrows:
        raise SystemExit(f"[verify] no metadata_{{train,eval}}.csv under {corpus}")
    if args.limit:
        allrows = allrows[:args.limit]
    names = [w for w, _ in allrows]
    texts = {w: t for w, t in allrows}

    ref_names = None
    if args.reference:
        rp = args.reference if os.path.isabs(args.reference) else os.path.join(corpus, args.reference)
        if not os.path.exists(rp):
            raise SystemExit(f"[verify] reference metadata not found: {rp}")
        ref_names = {w for w, _ in read_meta(rp)}
        log(f"[verify] reference set: {len(ref_names)} clips from {os.path.basename(rp)}")
    cmp_names = None
    if args.compare:
        cp = args.compare if os.path.isabs(args.compare) else os.path.join(corpus, args.compare)
        if not os.path.exists(cp):
            raise SystemExit(f"[verify] compare metadata not found: {cp}")
        cmp_names = {w for w, _ in read_meta(cp)}

    inference, torch = load_embedder()
    paths = [os.path.join(corpus, w) for w in names]
    emb, ok = embed(paths, inference, torch)

    # Centroid from the reference set (or everything), embeddable clips only.
    if ref_names is not None:
        mask = np.array([(n in ref_names) and o for n, o in zip(names, ok)])
        if mask.sum() < 20:
            raise SystemExit(f"[verify] reference set has only {int(mask.sum())} embeddable clips — too few for a centroid")
    else:
        mask = ok
    centroid = emb[mask].mean(axis=0)
    centroid /= np.linalg.norm(centroid)
    sims = emb @ centroid
    sims[~ok] = np.nan

    good = np.array([s for s in sims if not np.isnan(s)])
    print(f"\n=== speaker verify: {len(names)} clips ({int((~ok).sum())} unembeddable) ===")
    print(f"  centroid from {int(mask.sum())} clips"
          + (f" ({os.path.basename(args.reference)})" if args.reference else " (whole corpus)"))
    print(describe("ALL clips", good))
    if ref_names is not None:
        print(describe("reference (narration)", np.array([s for n, s in zip(names, sims) if n in ref_names and not np.isnan(s)])))
    if cmp_names is not None:
        print(describe("compare (dialogue)", np.array([s for n, s in zip(names, sims) if n in cmp_names and not np.isnan(s)])))

    flagged = [(n, float(s)) for n, s in zip(names, sims) if not np.isnan(s) and s < args.flag_below]
    flagged.sort(key=lambda x: x[1])
    print(f"\n  FLAGGED below {args.flag_below}: {len(flagged)}")
    for n, s in flagged[:25]:
        print(f"    {s:.4f}  {n}   {texts.get(n,'')[:70]}")

    if args.out:
        json.dump({"corpus": corpus, "flag_below": args.flag_below,
                   "centroid_from": args.reference or "all",
                   "clips": [{"wav": n, "sim": (None if np.isnan(s) else float(s)),
                              "text": texts.get(n, "")} for n, s in zip(names, sims)],
                   "flagged": [{"wav": n, "sim": s} for n, s in flagged]},
                  open(args.out, "w", encoding="utf-8"), indent=2)
        print(f"\n  wrote {args.out}")


if __name__ == "__main__":
    main()
