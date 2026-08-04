"""Fuse a PEFT LoRA adapter into a copy of its base model, offline, on the CPU.

WHY THIS EXISTS (macOS / MLX). Orpheus voices ship as ~0.39 GB LoRA adapters over one
shared 6.6 GB base. vLLM serves those adapters per request; MLX CANNOT — `mlx_audio`'s
`load_model` takes no adapter argument and mlx-lm's `load_adapters` expects mlx-lm's own
adapter schema, not PEFT's (e2a's orpheus.py refuses adapter mode on any non-vLLM backend
for exactly that reason). So on darwin BookForge downloads base + adapter and FUSES them
here at install time into an ordinary merged model folder that the existing MLX load path
opens unchanged. The user still pays 0.4 GB per extra voice instead of 6.6 GB; instant
per-request voice switching is stage B2, not this.

WHAT IT IS NOT: this is not `peft`. It imports nothing but `safetensors` and `torch`, and
never instantiates a transformers model class — the runtime e2a environment on the Mac has
neither peft nor the RAM headroom to build a 3B model twice. It is pure tensor arithmetic:

    W' = W + (lora_alpha / r) · B @ A

for every projection the adapter targets, with everything else copied verbatim. Compute is
fp32; every fused tensor is stored back in the BASE tensor's own dtype (bf16 here), so the
output is byte-shaped exactly like the base: same shard files, same index, same aux files.

NO FALLBACKS. Every ambiguity is fatal and says why: an adapter config this arithmetic
does not implement (rslora, dora, bias, modules_to_save, per-layer rank/alpha patterns),
a lora key that names no base tensor, a shape or dtype mismatch, an unpaired lora_A/lora_B,
or a non-empty output dir without --force. A wrong fuse produces a fluent, confident model
in the wrong voice with nothing anywhere reporting a problem — the one failure class this
script must never manufacture.

Usage:
    python orpheus_fuse.py --base <dir> --adapter <dir> --out <dir> [--force] [--verify]

Prints human-readable `[FUSE] …` progress lines (one per layer group / per shard) to
stdout for the installer UI, then ONE final JSON line: {"ok": true, "out": "..."} or
{"ok": false, "error": "..."} — the same contract orpheus_download.py uses.
"""
import argparse
import json
import os
import shutil
import sys


# ── adapter config: what this arithmetic is allowed to see ────────────────────

# Keys whose presence (truthy / non-default) means the adapter is NOT a plain
# W + (alpha/r)·B@A merge. Each maps to the reason it changes the math, because a
# refusal that doesn't explain itself gets worked around instead of fixed.
_UNSUPPORTED = {
    "use_dora": "DoRA decomposes the update into magnitude + direction; merging it needs the "
                "per-column norms, not just B@A",
    "use_rslora": "rank-stabilized LoRA scales by alpha/sqrt(r), not alpha/r",
    "use_qalora": "QALoRA quantizes the update; the merged weights would not be this arithmetic",
    "lora_bias": "the adapter carries bias vectors, which this merge does not apply",
    "fan_in_fan_out": "the base weights are stored transposed, so B@A would be applied the wrong way round",
}
# Keys that must be absent/empty because they make the merge PER-LAYER rather than uniform.
_MUST_BE_EMPTY = {
    "rank_pattern": "per-layer rank overrides mean the scaling is not a single alpha/r",
    "alpha_pattern": "per-layer alpha overrides mean the scaling is not a single alpha/r",
    "modules_to_save": "modules_to_save are full replacement weights shipped alongside the LoRA, "
                       "not a low-rank delta",
    "layer_replication": "layer replication changes the base architecture before the LoRA applies",
    "target_parameters": "parameter-level (rather than module-level) targeting is not this merge",
    "trainable_token_indices": "trainable token embeddings are full weights, not a low-rank delta",
    "exclude_modules": "module exclusions are only meaningful against a live model graph",
}


class FuseError(Exception):
    """A refusal. The message is written for the person who has to fix it."""


def load_adapter_config(adapter_dir):
    """Read + validate adapter_config.json, returning (scaling, target_modules)."""
    cfg_path = os.path.join(adapter_dir, "adapter_config.json")
    if not os.path.isfile(cfg_path):
        raise FuseError("adapter dir %s has no adapter_config.json — not a PEFT LoRA folder" % adapter_dir)
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception as e:
        raise FuseError("adapter_config.json in %s is not readable JSON: %s" % (adapter_dir, e))

    peft_type = cfg.get("peft_type")
    if peft_type != "LORA":
        raise FuseError("adapter %s declares peft_type=%r; only plain LORA can be fused here" % (adapter_dir, peft_type))

    r = cfg.get("r")
    if not isinstance(r, int) or r <= 0:
        raise FuseError("adapter %s declares r=%r; expected a positive integer rank" % (adapter_dir, r))
    alpha = cfg.get("lora_alpha")
    if not isinstance(alpha, (int, float)) or alpha <= 0:
        raise FuseError("adapter %s declares lora_alpha=%r; expected a positive number" % (adapter_dir, alpha))

    bias = cfg.get("bias", "none")
    if bias != "none":
        raise FuseError("adapter %s declares bias=%r; only bias='none' is a pure weight merge" % (adapter_dir, bias))

    for key, why in _UNSUPPORTED.items():
        if cfg.get(key):
            raise FuseError("adapter %s declares %s=%r — %s" % (adapter_dir, key, cfg.get(key), why))
    for key, why in _MUST_BE_EMPTY.items():
        val = cfg.get(key)
        if val:  # non-null, non-empty dict/list
            raise FuseError("adapter %s declares %s=%r — %s" % (adapter_dir, key, val, why))

    targets = cfg.get("target_modules")
    if not isinstance(targets, (list, tuple)) or not targets:
        raise FuseError("adapter %s declares target_modules=%r; expected a non-empty list" % (adapter_dir, targets))

    return float(alpha) / float(r), sorted(str(t) for t in targets)


# ── key mapping: PEFT module path → base state-dict key ───────────────────────

_PEFT_PREFIX = "base_model.model."


def base_key_for(lora_key):
    """Map a PEFT adapter tensor name to the base weight it modifies, or None.

    `base_model.model.model.layers.7.self_attn.q_proj.lora_A.weight`
        → ('model.layers.7.self_attn.q_proj.weight', 'A')

    PEFT writes an adapter-name segment (`.lora_A.default.weight`) when a model holds
    several named adapters; a single-adapter save omits it. Both forms are accepted and
    map to the same base key — everything else is rejected by the caller.
    """
    if not lora_key.startswith(_PEFT_PREFIX):
        return None
    body = lora_key[len(_PEFT_PREFIX):]
    for side in ("A", "B"):
        marker = ".lora_%s." % side
        i = body.find(marker)
        if i < 0:
            continue
        tail = body[i + len(marker):]
        # tail is 'weight' or '<adapter-name>.weight'
        if tail != "weight" and not tail.endswith(".weight"):
            return None
        return body[:i] + ".weight", side
    return None


def collect_lora_pairs(adapter_dir):
    """Read adapter_model.safetensors → {base_key: {'A': tensor, 'B': tensor}}.

    Tensors come back as fp32 CPU tensors (whatever they were stored as), because the
    merge is computed in fp32 and only rounded on the way out.
    """
    import torch
    from safetensors import safe_open

    weights_path = os.path.join(adapter_dir, "adapter_model.safetensors")
    if not os.path.isfile(weights_path):
        raise FuseError("adapter dir %s has no adapter_model.safetensors" % adapter_dir)

    pairs = {}
    with safe_open(weights_path, framework="pt", device="cpu") as fh:
        for key in fh.keys():
            mapped = base_key_for(key)
            if mapped is None:
                raise FuseError(
                    "adapter tensor %r in %s is not a recognisable PEFT LoRA weight "
                    "(expected base_model.model.<path>.lora_{A,B}[.<name>].weight)" % (key, weights_path)
                )
            base_key, side = mapped
            slot = pairs.setdefault(base_key, {})
            if side in slot:
                raise FuseError(
                    "adapter %s has two lora_%s tensors for the same base weight %r — "
                    "this file holds more than one adapter and there is no way to tell which to merge"
                    % (weights_path, side, base_key)
                )
            slot[side] = fh.get_tensor(key).to(dtype=torch.float32)

    if not pairs:
        raise FuseError("adapter %s contains no LoRA weights" % weights_path)
    for base_key, slot in pairs.items():
        missing = [s for s in ("A", "B") if s not in slot]
        if missing:
            raise FuseError(
                "adapter %s has no lora_%s for %r (only lora_%s) — half a LoRA cannot be merged"
                % (weights_path, missing[0], base_key, "".join(sorted(slot)))
            )
        a, b = slot["A"], slot["B"]
        if a.ndim != 2 or b.ndim != 2:
            raise FuseError("LoRA tensors for %r are not 2-D (A=%s, B=%s)" % (base_key, tuple(a.shape), tuple(b.shape)))
        if a.shape[0] != b.shape[1]:
            raise FuseError(
                "LoRA rank mismatch for %r: lora_A is %s and lora_B is %s — their inner dims must agree"
                % (base_key, tuple(a.shape), tuple(b.shape))
            )
    return pairs


# ── base model layout ─────────────────────────────────────────────────────────

def read_base_layout(base_dir):
    """Return (shard_files, weight_map_or_None).

    A sharded checkpoint declares `model.safetensors.index.json`; a single-file one has
    just `model.safetensors`. Both are supported and the OUTPUT mirrors whichever the
    base uses, so the fused folder is indistinguishable in shape from any other merged
    Orpheus voice (which is what lets the reconcile scan adopt it with no manifest).
    """
    index_path = os.path.join(base_dir, "model.safetensors.index.json")
    if os.path.isfile(index_path):
        try:
            with open(index_path, "r", encoding="utf-8") as fh:
                index = json.load(fh)
        except Exception as e:
            raise FuseError("base index %s is not readable JSON: %s" % (index_path, e))
        weight_map = index.get("weight_map")
        if not isinstance(weight_map, dict) or not weight_map:
            raise FuseError("base index %s has no usable weight_map" % index_path)
        shards = sorted({str(v) for v in weight_map.values()})
        for shard in shards:
            if not os.path.isfile(os.path.join(base_dir, shard)):
                raise FuseError("base %s is incomplete: shard %s named by the index is missing" % (base_dir, shard))
        return shards, weight_map
    try:
        loose = sorted(f for f in os.listdir(base_dir) if f.endswith(".safetensors"))
    except OSError as e:
        raise FuseError("base dir %s is not readable: %s" % (base_dir, e))
    if len(loose) != 1:
        raise FuseError(
            "base %s has no model.safetensors.index.json and %d loose .safetensors files — "
            "cannot tell what the checkpoint is" % (base_dir, len(loose))
        )
    return loose, None


def layer_of(key):
    """The layer number a weight belongs to, for progress reporting ('-' when none)."""
    parts = key.split(".")
    for i, p in enumerate(parts):
        if p == "layers" and i + 1 < len(parts):
            return parts[i + 1]
    return "-"


# ── the merge ─────────────────────────────────────────────────────────────────

def fuse_tensor(base_w, a, b, scaling, key):
    """W' = W + scaling · B @ A, computed in fp32 and returned in W's own dtype."""
    import torch

    if base_w.ndim != 2:
        raise FuseError("base weight %r is %d-D; a LoRA target must be a 2-D projection" % (key, base_w.ndim))
    out_features, in_features = base_w.shape
    if b.shape[0] != out_features or a.shape[1] != in_features:
        raise FuseError(
            "shape mismatch fusing %r: base is %s but lora_B@lora_A is %s — the adapter was "
            "trained against a different base model" % (key, tuple(base_w.shape), (b.shape[0], a.shape[1]))
        )
    delta = torch.matmul(b, a).mul_(scaling)
    fused = base_w.to(dtype=torch.float32).add_(delta)
    return fused.to(dtype=base_w.dtype)


def fuse(base_dir, adapter_dir, out_dir, force, verify):
    from safetensors import safe_open
    from safetensors.torch import save_file

    for label, d in (("base", base_dir), ("adapter", adapter_dir)):
        if not os.path.isdir(d):
            raise FuseError("%s dir %s does not exist" % (label, d))
    if os.path.realpath(out_dir) in (os.path.realpath(base_dir), os.path.realpath(adapter_dir)):
        raise FuseError("--out %s is the base or the adapter dir; refusing to overwrite an input" % out_dir)

    # A non-empty output is refused unless the caller says it means to replace it. The
    # installer passes --force (a re-install of a retrained voice MUST replace the old
    # fused copy); a human running this by hand gets the guard.
    if os.path.isdir(out_dir) and not force:
        existing = [f for f in os.listdir(out_dir) if f.endswith(".safetensors") or f == "config.json"]
        if existing:
            raise FuseError(
                "out dir %s already holds a model (%s…). Pass --force to replace it."
                % (out_dir, existing[0])
            )

    scaling, targets = load_adapter_config(adapter_dir)
    print("[FUSE] adapter %s: scaling=%.6g over %s" % (adapter_dir, scaling, ",".join(targets)), flush=True)
    pairs = collect_lora_pairs(adapter_dir)
    print("[FUSE] %d LoRA-targeted weights to fuse" % len(pairs), flush=True)

    shards, weight_map = read_base_layout(base_dir)
    print("[FUSE] base %s: %d shard(s)" % (base_dir, len(shards)), flush=True)

    # Write to a sibling `.partial` and swap only after everything (including --verify)
    # passes. Fusing straight into out_dir would leave a half-written model behind on any
    # failure, and a half-written model is exactly what every "is it installed" predicate
    # in BookForge reads as installed.
    partial = out_dir.rstrip("/\\") + ".partial"
    if os.path.isdir(partial):
        shutil.rmtree(partial)
    os.makedirs(partial)

    remaining = dict(pairs)  # base_key → {'A','B'}; drained as shards are processed
    fused_count = 0
    for si, shard in enumerate(shards, 1):
        src = os.path.join(base_dir, shard)
        tensors = {}
        with safe_open(src, framework="pt", device="cpu") as fh:
            metadata = fh.metadata() or {"format": "pt"}
            keys = list(fh.keys())
            last_layer = None
            for key in keys:
                t = fh.get_tensor(key)
                slot = remaining.pop(key, None)
                if slot is not None:
                    layer = layer_of(key)
                    if layer != last_layer:
                        print("[FUSE] shard %d/%d layer %s" % (si, len(shards), layer), flush=True)
                        last_layer = layer
                    t = fuse_tensor(t, slot["A"], slot["B"], scaling, key)
                    fused_count += 1
                tensors[key] = t
        dst = os.path.join(partial, shard)
        save_file(tensors, dst, metadata=metadata)
        print("[FUSE] wrote %s (%d tensors, %d fused so far)" % (shard, len(tensors), fused_count), flush=True)
        del tensors

    if remaining:
        # Every LoRA weight must have found its base tensor. One that didn't means the
        # adapter was trained against a different architecture (or a different naming
        # convention) and the "merged" model would be the base in disguise for those
        # projections — audible only as a subtly wrong voice.
        sample = sorted(remaining)[:3]
        raise FuseError(
            "%d LoRA weights name base tensors that do not exist in %s (e.g. %s) — "
            "this adapter does not belong to this base model" % (len(remaining), base_dir, ", ".join(sample))
        )

    # Everything that is not a weights shard is the base's own: config.json,
    # generation_config.json, the shard index, tokenizer files, chat template. Copied
    # rather than regenerated so the fused folder is the base folder plus new weights.
    copied = 0
    for name in sorted(os.listdir(base_dir)):
        src = os.path.join(base_dir, name)
        if not os.path.isfile(src) or name.endswith(".safetensors"):
            continue
        shutil.copyfile(src, os.path.join(partial, name))
        copied += 1
    print("[FUSE] copied %d config/tokenizer files from the base" % copied, flush=True)

    if verify:
        verify_output(partial, base_dir, pairs, scaling, weight_map, shards)

    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.rename(partial, out_dir)
    print("[FUSE] fused model written to %s" % out_dir, flush=True)
    return fused_count


# ── verification ──────────────────────────────────────────────────────────────

# One bf16 mantissa step is 2^-8 relative; allow two of them so a fp32 summation-order
# difference between the fuse pass and the verify pass (different thread counts, say)
# that lands on a rounding boundary is tolerated, while a genuinely wrong merge — which
# is off by the whole LoRA delta, orders of magnitude more — still fails.
_ULP_RELATIVE = 2.0 ** -7


def verify_output(out_dir, base_dir, pairs, scaling, weight_map, shards):
    """Re-open the written model: every declared tensor present with the right shape,
    plus a recomputed spot-check of three fused matrices."""
    import torch
    from safetensors import safe_open

    print("[FUSE] verifying %s" % out_dir, flush=True)
    shapes = {}
    for shard in shards:
        path = os.path.join(out_dir, shard)
        if not os.path.isfile(path):
            raise FuseError("verify: shard %s is missing from the fused output" % shard)
        with safe_open(path, framework="pt", device="cpu") as fh:
            for key in fh.keys():
                shapes[key] = tuple(fh.get_slice(key).get_shape())

    if weight_map is not None:
        for key in weight_map:
            if key not in shapes:
                raise FuseError("verify: tensor %r named by the base index is missing from the fused output" % key)
        # And the reverse: a tensor we wrote that the index does not declare would never
        # be loaded, which means we changed the checkpoint's shape.
        extra = sorted(set(shapes) - set(weight_map))
        if extra:
            raise FuseError("verify: fused output holds %d tensors the index does not declare (e.g. %s)"
                            % (len(extra), extra[0]))

    for key in pairs:
        if key not in shapes:
            raise FuseError("verify: fused tensor %r is not in the output" % key)

    # Spot-check: recompute W' from the BASE + adapter and compare to what was written.
    keys = sorted(pairs)
    picks = sorted({keys[0], keys[len(keys) // 2], keys[-1]})
    base_shards, _ = read_base_layout(base_dir)
    for key in picks:
        base_w = _read_tensor(base_dir, base_shards, key)
        stored = _read_tensor(out_dir, shards, key)
        if tuple(stored.shape) != tuple(base_w.shape):
            raise FuseError("verify: %r is %s in the output but %s in the base" % (key, tuple(stored.shape), tuple(base_w.shape)))
        expected = fuse_tensor(base_w, pairs[key]["A"], pairs[key]["B"], scaling, key)
        diff = (stored.to(torch.float32) - expected.to(torch.float32)).abs().max().item()
        bound = expected.to(torch.float32).abs().max().item() * _ULP_RELATIVE
        if diff > bound:
            raise FuseError(
                "verify: %r differs from a freshly computed W' by %.3e (bf16 tolerance %.3e)" % (key, diff, bound)
            )
        print("[FUSE] verify %s: max|Δ|=%.3e (tolerance %.3e)" % (key, diff, bound), flush=True)
    print("[FUSE] verify OK: %d tensors, %d spot-checked" % (len(shapes), len(picks)), flush=True)


def _read_tensor(model_dir, shards, key):
    from safetensors import safe_open
    for shard in shards:
        path = os.path.join(model_dir, shard)
        with safe_open(path, framework="pt", device="cpu") as fh:
            if key in fh.keys():
                return fh.get_tensor(key)
    raise FuseError("tensor %r not found in %s" % (key, model_dir))


# ── cli ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fuse a PEFT LoRA adapter into a copy of its base model.")
    parser.add_argument("--base", required=True, help="the shared base model dir")
    parser.add_argument("--adapter", required=True, help="the PEFT LoRA adapter dir")
    parser.add_argument("--out", required=True, help="the merged model dir to write")
    parser.add_argument("--force", action="store_true", help="replace an existing model at --out")
    parser.add_argument("--verify", action="store_true", help="re-read the output and spot-check the merge")
    args = parser.parse_args()

    try:
        count = fuse(args.base, args.adapter, args.out, args.force, args.verify)
    except FuseError as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        return 1
    except Exception as e:  # surface the real reason (missing torch/safetensors, disk full, …)
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}), flush=True)
        return 1
    print(json.dumps({"ok": True, "out": args.out, "fused": count}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
