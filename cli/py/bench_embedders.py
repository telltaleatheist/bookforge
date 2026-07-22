#!/usr/bin/env python
"""bench_embedders.py — measured bake-off of speaker-embedding backends for
ClipForge's `speakers` stage.

This is a MEASUREMENT harness, not production code. It embeds a fixed set of
ground-truth clips with each candidate backend, caches the embeddings, then runs
the SAME clustering + margin-gate logic as speaker_buckets.py over each backend's
vectors so the ONLY variable is the embedder. It reports, per candidate:

  1. Null test          — 94 single-narrator clips must stay 1 cluster.
  2. Separation/confusion — do Rudnicki / Card / voice-3 land in DISTINCT
                            clusters?  Any Card/voice-3 clip confidently placed
                            in the Rudnicki cluster is a FALSE ASSIGNMENT (fatal).
  3. Expressive retention — how many `uncertain/` clips get confidently assigned
                            to the Rudnicki cluster at ZERO false assignments, and
                            the F0-median shift that recovery produces.
  4. Margin structure    — cosine-similarity headroom between Card/voice-3 clips
                            and the Rudnicki centroid.
  5. Runtime per 1000 clips (CPU).

Subcommands
  build-gt  --fine <speakers.json> --orig <speakers.json> --null-dir <dir>
            --fine-root <dir> --out <gt.json>
      Build the ground-truth manifest (labels + absolute clip paths + F0 median).

  embed     --backend {resemblyzer,ecapa} --gt <gt.json> --out <emb.npz>
      Embed every clip in the manifest with one backend. L2-normalized rows.
      Records wall-clock embed time (for the runtime metric).

  eval      --gt <gt.json> --emb <emb.npz> [--emb <emb2.npz> ...] --out <results.json>
      Pure numpy/scipy. Runs the clustering grid + all metrics for each embedding
      file and writes a combined results json + prints tables.

NO FALLBACKS: a missing package / file / label exits non-zero with the error.
"""
import argparse
import json
import os
import sys
import time
import numpy as np


def die(msg):
    print(f"ERROR {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def log(msg):
    print(msg, flush=True)


# ===========================================================================
# ground truth
# ===========================================================================
# Ground-truth labels (all ear-verified by Owen, documented in CLIPFORGE_PLAN.md):
#   rudnicki_gold : the 98 highest-confidence clips of the ORIGINAL ender_game
#                   cluster_01 accumulated to 1800 s — hand-verified Rudnicki.
#   rudnicki      : ender_game_fine cluster_01 (1204) — verified narrator Rudnicki.
#   card          : ender_game_fine cluster_03 (142) — verified DIFFERENT narrator
#                   (Orson Scott Card).
#   voice3        : ender_game_fine cluster_04 (65)  — verified third voice.
#   uncertain     : ender_game_fine uncertain (528)  — UNLABELED pool believed to
#                   hold expressive-Rudnicki + ads + Card fragments.
#   other         : everything else (cluster_02, 05..11, music, mixed) — not used
#                   as a ground-truth positive, but embedded so clustering sees a
#                   realistic pool.
CONFIRMED_INTRUDER = "seg_00002_000037.41s.wav"  # by-ear intruder inside cluster_04


def build_gt(args):
    fine = json.load(open(args.fine, encoding="utf-8"))
    orig = json.load(open(args.orig, encoding="utf-8"))

    # map every fine clip filename -> its fine bucket
    def basename(f):
        return os.path.basename(f.replace("\\", "/"))

    fine_bucket = {basename(c["file"]): c["bucket"] for c in fine["clips"]}
    fine_off = {basename(c["file"]): c.get("source_offset") for c in fine["clips"]}
    fine_dur = {basename(c["file"]): c.get("duration") for c in fine["clips"]}

    # verified-98: sort original cluster_01 by confidence desc, accumulate to 1800 s
    c1 = [c for c in orig["clips"] if c["bucket"] == "cluster_01"]
    if any(c["confidence"] is None for c in c1):
        die("original cluster_01 has null confidences — cannot rank verified set")
    c1s = sorted(c1, key=lambda c: -c["confidence"])
    gold = set()
    acc = 0.0
    for c in c1s:
        if acc >= 1800.0:
            break
        gold.add(basename(c["file"]))
        acc += c["duration"]
    log(f"verified-gold Rudnicki: {len(gold)} clips, {acc:.1f}s")

    # locate every fine clip on disk by walking the fine root
    fine_root = os.path.abspath(args.fine_root)
    path_of = {}
    for dirpath, _dirs, files in os.walk(fine_root):
        for f in files:
            if f.endswith(".wav"):
                path_of[f] = os.path.join(dirpath, f)

    def label_for(name):
        b = fine_bucket.get(name)
        if b == "cluster_01":
            return "rudnicki"
        if b == "cluster_03":
            return "card"
        if b == "cluster_04":
            return "voice3"
        if b == "uncertain":
            return "uncertain"
        return "other"

    clips = []
    for name, bucket in fine_bucket.items():
        if name not in path_of:
            die(f"clip in fine speakers.json not found on disk: {name}")
        lab = label_for(name)
        rec = {
            "name": name,
            "path": path_of[name],
            "label": lab,
            "fine_bucket": bucket,
            "gold": name in gold,
            "dataset": "ender",
            "source_offset": fine_off.get(name),
            "duration": fine_dur.get(name),
        }
        if name == CONFIRMED_INTRUDER:
            rec["confirmed_intruder"] = True
        clips.append(rec)

    # null-test clips (single narrator) — must stay one cluster
    null_root = os.path.abspath(args.null_dir)
    n_null = 0
    for dirpath, _dirs, files in os.walk(null_root):
        for f in files:
            if f.endswith(".wav"):
                clips.append({
                    "name": f, "path": os.path.join(dirpath, f),
                    "label": "null", "fine_bucket": None, "gold": False,
                    "dataset": "mm_null",
                })
                n_null += 1
    log(f"null clips: {n_null}")

    # F0 median per clip (embedder-independent; cached here once).
    if not args.no_f0:
        import librosa
        log("computing F0 median per clip (librosa.pyin, voiced frames)...")
        t0 = time.time()
        for i, c in enumerate(clips):
            # only clips we actually aggregate F0 over — rudnicki + uncertain (+ null)
            if c["label"] not in ("rudnicki", "uncertain", "null") and not c["gold"]:
                c["f0_median"] = None
                continue
            try:
                y, sr = librosa.load(c["path"], sr=16000, mono=True)
                f0, vflag, _ = librosa.pyin(
                    y, fmin=65.0, fmax=350.0, sr=sr,
                    frame_length=1024, hop_length=256)
                vv = f0[np.isfinite(f0)]
                c["f0_median"] = float(np.median(vv)) if vv.size else None
            except Exception as e:  # noqa: BLE001
                die(f"F0 failed for {c['name']}: {e}")
            if i % 200 == 0:
                log(f"  F0 {i}/{len(clips)}  ({time.time()-t0:.0f}s)")
        log(f"F0 done in {time.time()-t0:.0f}s")
    else:
        for c in clips:
            c["f0_median"] = None

    counts = {}
    for c in clips:
        counts[c["label"]] = counts.get(c["label"], 0) + 1
    gt = {
        "clips": clips,
        "counts": counts,
        "n_gold": sum(1 for c in clips if c["gold"]),
        "confirmed_intruder": CONFIRMED_INTRUDER,
    }
    json.dump(gt, open(args.out, "w", encoding="utf-8"), indent=1)
    log(f"wrote {args.out}: {len(clips)} clips  counts={counts}  gold={gt['n_gold']}")


# ===========================================================================
# embedding backends
# ===========================================================================
def embed_resemblyzer(paths):
    import librosa
    from resemblyzer import VoiceEncoder, preprocess_wav
    enc = VoiceEncoder(device="cpu", verbose=False)
    out = np.zeros((len(paths), 256), dtype=np.float32)
    ok = np.ones(len(paths), dtype=bool)
    for i, p in enumerate(paths):
        y, _ = librosa.load(p, sr=16000, mono=True)
        wav = preprocess_wav(y, source_sr=16000)
        if wav is None or len(wav) < int(0.4 * 16000):
            ok[i] = False
            continue
        emb = enc.embed_utterance(wav)  # already L2-normalized
        out[i] = emb
        if i % 100 == 0:
            log(f"  resemblyzer {i}/{len(paths)}")
    return out, ok


def embed_ecapa(paths):
    import torch
    import soundfile as sf
    import librosa
    from speechbrain.inference.speaker import EncoderClassifier
    clf = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=os.path.join(os.path.expanduser("~"), ".cache", "sb-ecapa"),
        run_opts={"device": "cpu"})
    out = np.zeros((len(paths), 192), dtype=np.float32)
    ok = np.ones(len(paths), dtype=bool)
    for i, p in enumerate(paths):
        y, sr = sf.read(p, dtype="float32", always_2d=True)  # [T, C]
        y = y.mean(axis=1)  # mono
        if sr != 16000:
            y = librosa.resample(y, orig_sr=sr, target_sr=16000)
        if len(y) < int(0.4 * 16000):
            ok[i] = False
            continue
        sig = torch.from_numpy(y).unsqueeze(0)  # [1, T]
        with torch.no_grad():
            emb = clf.encode_batch(sig).squeeze().cpu().numpy().astype(np.float32)
        n = np.linalg.norm(emb)
        out[i] = emb / n if n > 0 else emb  # L2-normalize to match resemblyzer
        if i % 100 == 0:
            log(f"  ecapa {i}/{len(paths)}")
    return out, ok


def embed_wespeaker(paths):
    """pyannote/wespeaker-voxceleb-resnet34-LM — the (UNGATED) embedding backbone
    of the pyannote diarization pipeline. ResNet34 x-vector, 256-dim."""
    import os as _os
    import torch
    from pyannote.audio import Model, Inference
    tok_path = _os.path.expanduser("~/.cache/huggingface/token")
    tok = open(tok_path).read().strip() if _os.path.exists(tok_path) else None
    try:
        m = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM", use_auth_token=tok)
    except TypeError:
        m = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM", token=tok)
    import soundfile as sf
    inf = Inference(m, window="whole", device=torch.device("cpu"))
    out = None
    ok = np.ones(len(paths), dtype=bool)
    for i, p in enumerate(paths):
        try:
            # load in-memory (torchcodec DLL is broken in this env; bypass it)
            y, sr = sf.read(p, dtype="float32", always_2d=True)  # [T, C]
            wav = torch.from_numpy(y.T)  # [C, T]
            if wav.shape[0] > 1:
                wav = wav.mean(dim=0, keepdim=True)
            emb = np.asarray(inf({"waveform": wav, "sample_rate": sr})).reshape(-1).astype(np.float32)
        except Exception:  # noqa: BLE001 — too-short clip etc.
            ok[i] = False
            if out is None:
                continue
            out[i] = 0.0
            continue
        if out is None:
            out = np.zeros((len(paths), emb.shape[0]), dtype=np.float32)
        n = np.linalg.norm(emb)
        out[i] = emb / n if n > 0 else emb  # L2-normalize
        if i % 100 == 0:
            log(f"  wespeaker {i}/{len(paths)}")
    if out is None:
        die("wespeaker produced no embeddings")
    return out, ok


BACKENDS = {"resemblyzer": embed_resemblyzer, "ecapa": embed_ecapa,
            "wespeaker": embed_wespeaker}


def f0_cmd(args):
    """Compute F0 median per clip (librosa.pyin, voiced frames) and write it back
    into gt.json. Decoupled from build-gt so it can run in parallel with embedding."""
    import librosa
    gt = json.load(open(args.gt, encoding="utf-8"))
    clips = gt["clips"]
    todo = [c for c in clips
            if c["label"] in ("rudnicki", "uncertain") or c["gold"]]
    log(f"F0 over {len(todo)} clips (rudnicki + uncertain + gold) ...")
    t0 = time.time()
    done = 0
    for c in clips:
        if c not in todo:
            c["f0_median"] = None
            continue
        y, sr = librosa.load(c["path"], sr=16000, mono=True)
        f0, _v, _p = librosa.pyin(y, fmin=65.0, fmax=350.0, sr=sr,
                                  frame_length=2048, hop_length=512)
        vv = f0[np.isfinite(f0)]
        c["f0_median"] = float(np.median(vv)) if vv.size else None
        done += 1
        if done % 200 == 0:
            log(f"  F0 {done}/{len(todo)}  ({time.time()-t0:.0f}s)")
    json.dump(gt, open(args.gt, "w", encoding="utf-8"), indent=1)
    log(f"F0 done in {time.time()-t0:.0f}s, wrote back to {args.gt}")


def embed_cmd(args):
    gt = json.load(open(args.gt, encoding="utf-8"))
    clips = gt["clips"]
    paths = [c["path"] for c in clips]
    if args.backend not in BACKENDS:
        die(f"unknown backend: {args.backend}")
    log(f"embedding {len(paths)} clips with {args.backend} ...")
    t0 = time.time()
    X, ok = BACKENDS[args.backend](paths)
    elapsed = time.time() - t0
    names = np.array([c["name"] for c in clips])
    np.savez_compressed(args.out, X=X, ok=ok, names=names,
                        backend=args.backend, elapsed=elapsed,
                        n=len(paths))
    log(f"wrote {args.out}: {X.shape}  {elapsed:.1f}s  "
        f"({1000*elapsed/max(len(paths),1):.1f}s/1000 clips)  "
        f"embedded={int(ok.sum())}/{len(paths)}")


# ===========================================================================
# clustering + margin gate  (mirrors speaker_buckets.py exactly)
# ===========================================================================
def cluster_and_gate(X, threshold, margin_gate):
    """Return (labels, margins) for rows of X (L2-normalized whole-clip embeds).

    labels[i] = cluster id (1..K) or 'uncertain'.  Mirrors speaker_buckets.py:
    agglomerative average-linkage cosine, fcluster distance cut, centroid = the
    L2-normalized mean, margin = own-centroid-sim - nearest-other-centroid-sim,
    < gate => uncertain.
    """
    from scipy.cluster.hierarchy import linkage, fcluster
    from scipy.spatial.distance import pdist
    n = X.shape[0]
    if n == 1:
        return np.array([1]), np.array([None], dtype=object)
    d = pdist(X, metric="cosine")
    Z = linkage(d, method="average")
    raw = fcluster(Z, t=threshold, criterion="distance")
    K = int(raw.max())
    cent = {}
    for cid in range(1, K + 1):
        members = X[raw == cid]
        c = members.mean(axis=0)
        nn = np.linalg.norm(c)
        cent[cid] = c / nn if nn > 0 else c
    labels = np.empty(n, dtype=object)
    margins = np.empty(n, dtype=object)
    for i in range(n):
        cid = int(raw[i])
        own = float(X[i] @ cent[cid])
        others = [float(X[i] @ cent[oc]) for oc in cent if oc != cid]
        if others:
            m = own - max(others)
            margins[i] = m
            labels[i] = "uncertain" if m < margin_gate else cid
        else:
            margins[i] = None
            labels[i] = cid
    return labels, margins


# ===========================================================================
# evaluation
# ===========================================================================
def eval_cmd(args):
    gt = json.load(open(args.gt, encoding="utf-8"))
    clips = gt["clips"]
    name_idx = {c["name"]: i for i, c in enumerate(clips)}
    labels = np.array([c["label"] for c in clips])
    gold = np.array([c["gold"] for c in clips])
    f0 = np.array([c.get("f0_median") if c.get("f0_median") else np.nan for c in clips])
    is_ender = np.array([c["dataset"] == "ender" for c in clips])
    is_null = np.array([c["dataset"] == "mm_null" for c in clips])
    # ender pool that speaker_buckets would actually cluster: exclude music/mixed
    is_musicmixed = np.array([c["fine_bucket"] in ("music", "mixed") for c in clips])
    cluster_pool = is_ender & ~is_musicmixed

    results = {"gt_counts": gt["counts"], "backends": {}}

    thresholds = [float(x) for x in args.thresholds.split(",")]
    margins = [float(x) for x in args.margins.split(",")]

    for embfile in args.emb:
        data = np.load(embfile, allow_pickle=True)
        X = data["X"].astype(np.float64)
        ok = data["ok"]
        emb_names = data["names"]
        backend = str(data["backend"])
        elapsed = float(data["elapsed"])
        n_embedded = int(data["n"])
        # align embeddings to gt order (should already match, but be safe)
        if not np.array_equal(emb_names, np.array([c["name"] for c in clips])):
            die(f"{embfile} clip order mismatch with gt")
        log(f"\n{'='*70}\nBACKEND: {backend}   dim={X.shape[1]}   "
            f"runtime={1000*elapsed/max(n_embedded,1):.1f}s/1000 clips")

        b = {"backend": backend, "dim": int(X.shape[1]),
             "runtime_s_per_1000": round(1000 * elapsed / max(n_embedded, 1), 1),
             "null": [], "separation": [], "f0": {}}

        # ---- 1. NULL TEST ---------------------------------------------------
        # cluster ONLY the null clips; must collapse to one cluster.
        nidx = np.where(is_null & ok)[0]
        Xn = X[nidx]
        Xn = Xn / np.linalg.norm(Xn, axis=1, keepdims=True)
        for th in thresholds:
            lab, _ = cluster_and_gate(Xn, th, -1e9)  # no margin gate for null count
            uniq, cnt = np.unique(lab, return_counts=True)
            b["null"].append({"threshold": th, "n": len(nidx),
                              "n_clusters": int(len(uniq)),
                              "largest": int(cnt.max()),
                              "pass": int(len(uniq) == 1)})
        log("  NULL TEST (94 single-narrator clips -> must be 1 cluster):")
        for r in b["null"]:
            log(f"    thr={r['threshold']:.3f}  clusters={r['n_clusters']}  "
                f"largest={r['largest']}/{r['n']}  {'PASS' if r['pass'] else 'FAIL'}")

        # ---- 2/3/4. SEPARATION over the ender pool --------------------------
        pidx = np.where(cluster_pool & ok)[0]
        Xp = X[pidx]
        Xp = Xp / np.linalg.norm(Xp, axis=1, keepdims=True)
        plabels = labels[pidx]
        pgold = gold[pidx]
        pf0 = f0[pidx]

        log("  SEPARATION (ender pool, per threshold x margin):")
        log(f"    {'thr':>5} {'mgn':>5} {'Rclu':>5} {'gold':>5} {'card!':>6} "
            f"{'v3!':>5} {'FALSE':>6} {'uncRec':>7} {'Cd_dist':>8} {'V3_dist':>8}")
        for th in thresholds:
            cl, mg = cluster_and_gate(Xp, th, -1e9)  # first cluster w/o gate to get structure
            # identify Rudnicki cluster = the cluster holding the most gold clips
            gold_here = pgold
            gclusters = cl[gold_here]
            if len(gclusters) == 0:
                die("no gold clip in cluster pool")
            vals, cnts = np.unique([str(x) for x in gclusters], return_counts=True)
            rud_cid_str = vals[cnts.argmax()]
            # recompute assignment with the margin gate applied, per margin value
            for mgn in margins:
                clg, mgg = cluster_and_gate(Xp, th, mgn)
                in_rud = np.array([str(x) == rud_cid_str for x in clg])
                gold_in = int((in_rud & pgold).sum())
                card_false = int((in_rud & (plabels == "card")).sum())
                v3_false = int((in_rud & (plabels == "voice3")).sum())
                false_total = card_false + v3_false
                unc_rec = int((in_rud & (plabels == "uncertain")).sum())
                # distinctness: are card / voice3 predominantly in their OWN cluster
                # (a different cluster than Rudnicki)?
                def dominant_cluster(mask):
                    cc = clg[mask]
                    cc = np.array([str(x) for x in cc if x != "uncertain"])
                    if cc.size == 0:
                        return None, 0.0
                    v, c = np.unique(cc, return_counts=True)
                    return v[c.argmax()], c.max() / mask.sum()
                cd_clu, cd_frac = dominant_cluster(plabels == "card")
                v3_clu, v3_frac = dominant_cluster(plabels == "voice3")
                card_distinct = int(cd_clu is not None and cd_clu != rud_cid_str)
                v3_distinct = int(v3_clu is not None and v3_clu != rud_cid_str)
                row = {
                    "threshold": th, "margin": mgn,
                    "rud_cluster": rud_cid_str,
                    "gold_in_rud": gold_in, "gold_total": int(pgold.sum()),
                    "card_false": card_false, "voice3_false": v3_false,
                    "false_total": false_total,
                    "uncertain_recovered": unc_rec,
                    "card_distinct": card_distinct, "card_dom_frac": round(cd_frac, 3),
                    "voice3_distinct": v3_distinct, "voice3_dom_frac": round(v3_frac, 3),
                }
                b["separation"].append(row)
                log(f"    {th:5.3f} {mgn:5.3f} {rud_cid_str:>5} "
                    f"{gold_in:5d} {card_false:6d} {v3_false:5d} {false_total:6d} "
                    f"{unc_rec:7d} {str(card_distinct):>8} {str(v3_distinct):>8}")

        # ---- 4. MARGIN STRUCTURE (headroom) --------------------------------
        # Cosine similarity of each labeled group to the Rudnicki centroid, using
        # the clustering at the FIRST threshold (structure is stable). Reports the
        # separation headroom the embedder gives between intruders and Rudnicki.
        th0 = thresholds[0]
        cl0, _ = cluster_and_gate(Xp, th0, -1e9)
        gclusters = cl0[pgold]
        vals, cnts = np.unique([str(x) for x in gclusters], return_counts=True)
        rud_cid = vals[cnts.argmax()]
        rud_mask = np.array([str(x) == rud_cid for x in cl0]) & pgold
        rud_cen = Xp[rud_mask].mean(axis=0)
        rud_cen = rud_cen / np.linalg.norm(rud_cen)
        sim_to_rud = Xp @ rud_cen

        def sim_stats(mask):
            v = sim_to_rud[mask]
            if v.size == 0:
                return None
            return {"n": int(v.size), "median": round(float(np.median(v)), 4),
                    "p90": round(float(np.percentile(v, 90)), 4),
                    "max": round(float(v.max()), 4), "min": round(float(v.min()), 4)}

        b["margin_structure"] = {
            "threshold": th0,
            "rudnicki_gold_sim_to_rud": sim_stats(rud_mask),
            "card_sim_to_rud": sim_stats(plabels == "card"),
            "voice3_sim_to_rud": sim_stats(plabels == "voice3"),
            "uncertain_sim_to_rud": sim_stats(plabels == "uncertain"),
        }
        # confirmed intruder clip headroom
        ci = gt["confirmed_intruder"]
        if ci in name_idx:
            gi = name_idx[ci]
            wj = np.where(pidx == gi)[0]
            if wj.size:
                b["margin_structure"]["confirmed_intruder_sim_to_rud"] = round(
                    float(sim_to_rud[wj[0]]), 4)
        log("  MARGIN STRUCTURE (cosine sim to Rudnicki centroid):")
        for k in ("rudnicki_gold_sim_to_rud", "card_sim_to_rud",
                  "voice3_sim_to_rud", "uncertain_sim_to_rud"):
            s = b["margin_structure"][k]
            if s:
                log(f"    {k:32} n={s['n']:4d} median={s['median']:.4f} "
                    f"p90={s['p90']:.4f} max={s['max']:.4f} min={s['min']:.4f}")
        if "confirmed_intruder_sim_to_rud" in b["margin_structure"]:
            log(f"    confirmed_intruder({ci}) sim_to_rud="
                f"{b['margin_structure']['confirmed_intruder_sim_to_rud']:.4f}")
        headroom = None
        if b["margin_structure"]["card_sim_to_rud"] and b["margin_structure"]["rudnicki_gold_sim_to_rud"]:
            headroom = round(
                b["margin_structure"]["rudnicki_gold_sim_to_rud"]["median"]
                - b["margin_structure"]["card_sim_to_rud"]["p90"], 4)
            log(f"    HEADROOM (Rud median - Card p90) = {headroom}")
        b["margin_structure"]["headroom_rudmedian_minus_cardp90"] = headroom

        # ---- 3. F0 RETENTION -----------------------------------------------
        # At the best zero-false operating point (max uncertain recovered with
        # false_total == 0), report F0 median of cluster_01(rudnicki) alone vs
        # rudnicki + recovered-uncertain.
        best = None
        for row in b["separation"]:
            if row["false_total"] == 0:
                if best is None or row["uncertain_recovered"] > best["uncertain_recovered"]:
                    best = row
        b["best_zero_false"] = best
        if best is not None:
            th, mgn = best["threshold"], best["margin"]
            clg, _ = cluster_and_gate(Xp, th, mgn)
            in_rud = np.array([str(x) == best["rud_cluster"] for x in clg])
            rud_lab = plabels == "rudnicki"
            rec_unc = in_rud & (plabels == "uncertain")
            f0_rud = pf0[rud_lab & np.isfinite(pf0)]
            f0_comb = pf0[(rud_lab | rec_unc) & np.isfinite(pf0)]
            b["f0"] = {
                "operating_point": {"threshold": th, "margin": mgn},
                "rudnicki_only_median": round(float(np.median(f0_rud)), 2) if f0_rud.size else None,
                "rudnicki_only_n": int(f0_rud.size),
                "rud_plus_recovered_median": round(float(np.median(f0_comb)), 2) if f0_comb.size else None,
                "rud_plus_recovered_n": int(f0_comb.size),
                "recovered_uncertain": int(rec_unc.sum()),
                "wider_reference_hz": 84.9,
            }
            log(f"  F0 RETENTION @ zero-false op (thr={th}, mgn={mgn}):")
            log(f"    rudnicki-only median F0 = {b['f0']['rudnicki_only_median']} Hz "
                f"(n={b['f0']['rudnicki_only_n']})")
            log(f"    rud+recovered median F0 = {b['f0']['rud_plus_recovered_median']} Hz "
                f"(n={b['f0']['rud_plus_recovered_n']}, recovered {b['f0']['recovered_uncertain']} uncertain)")
            log(f"    wider-population reference = 84.9 Hz")
        else:
            log("  F0 RETENTION: no zero-false operating point found in grid")

        results["backends"][backend] = b

    json.dump(results, open(args.out, "w", encoding="utf-8"), indent=1)
    log(f"\nwrote {args.out}")


def mapexport_cmd(args):
    """Emit the proposed ClipForge `diarize` output — speakers.map.json — from an
    embedding's clustering over the deterministic time-ordered segments. Each
    segment already carries a book time span (source_offset..+duration), so
    clustering them IS a speaker timeline. This shows the diarize-mode SHAPE and
    output using ungated tooling (no pyannote gate needed)."""
    gt = json.load(open(args.gt, encoding="utf-8"))
    clips = gt["clips"]
    data = np.load(args.emb, allow_pickle=True)
    X = data["X"].astype(np.float64)
    ok = data["ok"]
    names = list(data["names"])
    idx = {n: i for i, n in enumerate(names)}
    # ender segments with a time span, in book order
    segs = [c for c in clips if c["dataset"] == "ender"
            and c.get("source_offset") is not None
            and c["fine_bucket"] not in ("music", "mixed")
            and ok[idx[c["name"]]]]
    segs.sort(key=lambda c: c["source_offset"])
    Xp = np.vstack([X[idx[c["name"]]] for c in segs])
    Xp = Xp / np.linalg.norm(Xp, axis=1, keepdims=True)
    lab, mg = cluster_and_gate(Xp, args.threshold, args.margin)
    # relabel by size desc
    from collections import Counter
    cnt = Counter(str(x) for x in lab if x != "uncertain")
    order = [c for c, _ in cnt.most_common()]
    remap = {c: f"SPEAKER_{i:02d}" for i, c in enumerate(order)}
    out = []
    for c, l, m in zip(segs, lab, mg):
        spk = "uncertain" if l == "uncertain" else remap[str(l)]
        out.append({
            "start": c["source_offset"],
            "end": round(c["source_offset"] + c["duration"], 3),
            "speaker": spk,
            "confidence": None if m is None else round(float(m), 4),
        })
    doc = {"schema": "clipforge.speakers.map/v0",
           "source_embedder": str(data["backend"]),
           "cluster_threshold": args.threshold, "uncertain_margin": args.margin,
           "n_segments": len(out),
           "speakers": sorted(set(s["speaker"] for s in out)),
           "segments": out}
    json.dump(doc, open(args.out, "w", encoding="utf-8"), indent=1)
    log(f"wrote {args.out}: {len(out)} segments, speakers={doc['speakers']}")


# ===========================================================================
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("build-gt")
    g.add_argument("--fine", required=True)
    g.add_argument("--orig", required=True)
    g.add_argument("--fine-root", required=True)
    g.add_argument("--null-dir", required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--no-f0", action="store_true")
    g.set_defaults(func=build_gt)

    f = sub.add_parser("f0")
    f.add_argument("--gt", required=True)
    f.set_defaults(func=f0_cmd)

    e = sub.add_parser("embed")
    e.add_argument("--backend", required=True)
    e.add_argument("--gt", required=True)
    e.add_argument("--out", required=True)
    e.set_defaults(func=embed_cmd)

    v = sub.add_parser("eval")
    v.add_argument("--gt", required=True)
    v.add_argument("--emb", required=True, action="append")
    v.add_argument("--out", required=True)
    v.add_argument("--thresholds", default="0.20,0.24,0.28,0.32,0.36,0.40")
    v.add_argument("--margins", default="0.02,0.05,0.10,0.15")
    v.set_defaults(func=eval_cmd)

    m = sub.add_parser("mapexport")
    m.add_argument("--gt", required=True)
    m.add_argument("--emb", required=True)
    m.add_argument("--out", required=True)
    m.add_argument("--threshold", type=float, required=True)
    m.add_argument("--margin", type=float, required=True)
    m.set_defaults(func=mapexport_cmd)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
