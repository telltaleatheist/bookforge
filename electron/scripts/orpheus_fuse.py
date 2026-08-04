"""Fuse a PEFT LoRA adapter into a copy of its base model, offline, on the CPU.

WHY THIS EXISTS (macOS / MLX): MLX cannot serve a LoRA at all, so on darwin BookForge
downloads base + adapter and fuses them here at install time into an ordinary merged
model folder. The canonical statement of that constraint — what MLX lacks, what e2a
does about it, and why the fused copy wins resolution — lives ONCE, on the darwin branch
of `resolveOrpheusInstall` in electron/orpheus-models.ts. Read it there.

WHAT IT IS NOT: this is not `peft`. It imports nothing but `safetensors` and `torch`, and
never instantiates a transformers model class. That is a deliberate choice, not a
workaround for a missing package: depending on peft here would couple a one-shot weight
merge to peft's own version drift in the shared runtime env. It is pure tensor arithmetic:

    W' = W + (lora_alpha / r) * B @ A

for every projection the adapter targets, with everything else copied verbatim. Compute is
fp32; every fused tensor is stored back in the BASE tensor's own dtype (bf16 here), so the
output is byte-shaped exactly like the base: same shard files, same index, same aux files.

MEMORY. Weights are read LAZILY, one tensor at a time (`safe_open` + `get_tensor` per key
— never `load_file` over a whole shard); the LoRA pair for a weight is released the moment
it is consumed; and the output shard is serialized tensor-by-tensor (see _serialize_shard)
rather than through `save_file`, which would hold the shard as torch tensors AND as bytes
simultaneously. What is unavoidably resident is ONE SHARD, in one representation, plus the
not-yet-consumed LoRA pairs and an fp32 scratch copy of the tensor being fused. Measured on
Orpheus-3B (shards 4.99 + 1.61 GB, 0.39 GB adapter held as fp32), Linux, 2026-08-04: peak
RSS 10.2 GB of which only 5.1 GB is ANONYMOUS — the other 5.1 GB is resident page cache for
the mmap'd source shard, clean pages the kernel drops the moment anything else wants them.
Through save_file the same merge peaks at 11.4 GB RSS / 8.8 GB anonymous. So the number
that decides whether an 8 GB Mac swaps went 8.8 -> 5.1 GB.

NO FALLBACKS. Every ambiguity is fatal and says why: an adapter config this arithmetic
does not implement (rslora, dora, bias, PiSSA/OLoRA init, loftq, megatron, modules_to_save,
per-layer rank/alpha patterns), a lora key that names no base tensor, a shape or dtype
mismatch, an unpaired lora_A/lora_B, or a non-empty output dir without --force. A wrong
fuse produces a fluent, confident model in the wrong voice with nothing anywhere reporting
a problem — the one failure class this script must never manufacture.

Usage:
    python orpheus_fuse.py --base <dir> --adapter <dir> --out <dir> --workspace <dir>
                           [--force] [--verify]

--workspace is where the model is BUILT; it must be on the same filesystem as --out,
because promotion is a rename (see promote()). BookForge passes
`<models>/.fusework/<id>`, a scratch dir the model scan skips by name. It is deleted at
the start of a run and again on any failure, so a failed fuse leaves nothing behind for
the "is it installed" predicates to adopt.

Prints ASCII-only `[FUSE] ...` progress lines (one per layer group / per shard) to stdout
for the installer UI, then ONE final JSON line: {"ok": true, "out": "..."} or
{"ok": false, "error": "..."} — the same contract orpheus_download.py uses.
"""
import argparse
import json
import os
import shutil
import sys


# -- adapter config: what this arithmetic is allowed to see --------------------

# Keys whose presence (truthy / non-default) means the adapter is NOT a plain
# W + (alpha/r)*B@A merge. Each maps to the reason it changes the math, because a
# refusal that doesn't explain itself gets worked around instead of fixed.
_UNSUPPORTED = {
    "use_dora": "DoRA decomposes the update into magnitude + direction; merging it needs the "
                "per-column norms, not just B@A",
    "use_rslora": "rank-stabilized LoRA scales by alpha/sqrt(r), not alpha/r",
    "use_qalora": "QALoRA quantizes the update; the merged weights would not be this arithmetic",
    "lora_bias": "the adapter carries bias vectors, which this merge does not apply",
    "fan_in_fan_out": "the base weights are stored transposed, so B@A would be applied the wrong way round",
}
# Keys that must be absent/empty because they make the merge PER-LAYER rather than uniform,
# or because they mean the stored A/B are not the whole update.
_MUST_BE_EMPTY = {
    "rank_pattern": "per-layer rank overrides mean the scaling is not a single alpha/r",
    "alpha_pattern": "per-layer alpha overrides mean the scaling is not a single alpha/r",
    "modules_to_save": "modules_to_save are full replacement weights shipped alongside the LoRA, "
                       "not a low-rank delta",
    "layer_replication": "layer replication changes the base architecture before the LoRA applies",
    "target_parameters": "parameter-level (rather than module-level) targeting is not this merge",
    "trainable_token_indices": "trainable token embeddings are full weights, not a low-rank delta",
    "exclude_modules": "module exclusions are only meaningful against a live model graph",
    # PiSSA/OLoRA/LoftQ/EVA/CorDA rewrite the BASE at adapter-creation time: the residual
    # W_res the adapter was trained against is not the W in this base dir, so W + B@A is
    # the wrong sum by exactly the part of W the initializer moved into A/B. The result
    # loads, generates fluently, and is a different voice.
    "loftq_config": "LoftQ re-initialises A/B against a QUANTIZED base, so this base's W is not "
                    "the residual those weights were trained against",
    "megatron_config": "a Megatron-parallel adapter stores per-shard slices of the update, not "
                       "the whole B@A for a single dense weight",
    "eva_config": "EVA data-drives the initialisation from the base's activations; the merge is "
                  "only valid against the base that was profiled",
    "corda_config": "CorDA decomposes the base weight and folds part of it into the adapter, so "
                    "the stored base is no longer the full W",
}
# `init_lora_weights` is the one config key whose SAFE values are the non-obvious ones:
# `true` (the default: A ~ Kaiming, B = 0) and `gaussian` both leave the base weight
# untouched at init, so W in this dir is the W that was trained against. PiSSA and OLoRA
# instead SUBTRACT their initial B@A from the base and ship the residual; merging them
# against the pristine base double-counts that principal component.
_SAFE_INIT_LORA_WEIGHTS = (True, "gaussian")


class FuseError(Exception):
    """A refusal. The message is written for the person who has to fix it."""


def load_adapter_config(adapter_dir):
    """Read + validate adapter_config.json, returning (scaling, target_modules)."""
    cfg_path = os.path.join(adapter_dir, "adapter_config.json")
    if not os.path.isfile(cfg_path):
        raise FuseError("adapter dir %s has no adapter_config.json - not a PEFT LoRA folder" % adapter_dir)
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

    # Absent means PEFT's default, which is `true` and is safe.
    init = cfg.get("init_lora_weights", True)
    if init not in _SAFE_INIT_LORA_WEIGHTS:
        raise FuseError(
            "adapter %s declares init_lora_weights=%r. PiSSA and OLoRA (and their quantized "
            "variants) initialise A/B from a decomposition of the base weight and SUBTRACT it, "
            "shipping the residual as the base; merging them onto an unmodified base adds that "
            "component back twice. Only init_lora_weights true/gaussian leave the base untouched. "
            "If this adapter really is PiSSA, convert it with peft's "
            "`save_pretrained(..., path_initial_model_for_weight_conversion=...)` first."
            % (adapter_dir, init)
        )

    for key, why in _UNSUPPORTED.items():
        if cfg.get(key):
            raise FuseError("adapter %s declares %s=%r - %s" % (adapter_dir, key, cfg.get(key), why))
    for key, why in _MUST_BE_EMPTY.items():
        val = cfg.get(key)
        if val:  # non-null, non-empty dict/list
            raise FuseError("adapter %s declares %s=%r - %s" % (adapter_dir, key, val, why))

    targets = cfg.get("target_modules")
    if not isinstance(targets, (list, tuple)) or not targets:
        raise FuseError("adapter %s declares target_modules=%r; expected a non-empty list" % (adapter_dir, targets))

    return float(alpha) / float(r), sorted(str(t) for t in targets)


# -- dtypes ---------------------------------------------------------------------

def _dtype_allowlist():
    """The float dtypes this merge is defined for, as a set of torch dtypes.

    Anything else - int8/uint8/fp8 quantized weights above all - is refused BY NAME. A
    quantized tensor of matching shape would take the add silently (torch would round the
    fp32 sum straight back into the integer grid), destroying the weights while every
    shape and header check still passed. Merging into a quantized base is a real
    operation, but it is dequantize-merge-requantize with the base's own scales, not
    this.
    """
    import torch
    return {torch.bfloat16, torch.float16, torch.float32}


def _check_dtype(t, what, key):
    if t.dtype not in _dtype_allowlist():
        raise FuseError(
            "%s for %r is %s; this merge is only defined for bfloat16, float16 and float32. "
            "A quantized checkpoint has to be dequantized with its own scales before a LoRA "
            "can be merged into it." % (what, key, str(t.dtype).replace("torch.", ""))
        )


# -- key mapping: PEFT module path -> base state-dict key -----------------------

_PEFT_PREFIX = "base_model.model."


def base_key_for(lora_key):
    """Map a PEFT adapter tensor name to the base weight it modifies, or None.

    `base_model.model.model.layers.7.self_attn.q_proj.lora_A.weight`
        -> ('model.layers.7.self_attn.q_proj.weight', 'A')

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
    """Read adapter_model.safetensors -> {base_key: {'A': tensor, 'B': tensor}}.

    Read one key at a time (never the whole file at once) and returned as fp32 CPU
    tensors, because the merge is computed in fp32 and only rounded on the way out.
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
                    "adapter %s has two lora_%s tensors for the same base weight %r - "
                    "this file holds more than one adapter and there is no way to tell which to merge"
                    % (weights_path, side, base_key)
                )
            t = fh.get_tensor(key)
            _check_dtype(t, "the adapter's lora_%s" % side, base_key)
            slot[side] = t.to(dtype=torch.float32)

    if not pairs:
        raise FuseError("adapter %s contains no LoRA weights" % weights_path)
    for base_key, slot in pairs.items():
        missing = [s for s in ("A", "B") if s not in slot]
        if missing:
            raise FuseError(
                "adapter %s has no lora_%s for %r (only lora_%s) - half a LoRA cannot be merged"
                % (weights_path, missing[0], base_key, "".join(sorted(slot)))
            )
        a, b = slot["A"], slot["B"]
        if a.ndim != 2 or b.ndim != 2:
            raise FuseError("LoRA tensors for %r are not 2-D (A=%s, B=%s)" % (base_key, tuple(a.shape), tuple(b.shape)))
        if a.shape[0] != b.shape[1]:
            raise FuseError(
                "LoRA rank mismatch for %r: lora_A is %s and lora_B is %s - their inner dims must agree"
                % (base_key, tuple(a.shape), tuple(b.shape))
            )
    return pairs


# -- base model layout ----------------------------------------------------------

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
            "base %s has no model.safetensors.index.json and %d loose .safetensors files - "
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


# -- the merge ------------------------------------------------------------------

def fuse_tensor(base_w, a, b, scaling, key):
    """W' = W + scaling * B @ A, computed in fp32 and returned in W's own dtype."""
    import torch

    if base_w.ndim != 2:
        raise FuseError("base weight %r is %d-D; a LoRA target must be a 2-D projection" % (key, base_w.ndim))
    _check_dtype(base_w, "the base weight", key)
    out_features, in_features = base_w.shape
    if b.shape[0] != out_features or a.shape[1] != in_features:
        raise FuseError(
            "shape mismatch fusing %r: base is %s but lora_B@lora_A is %s - the adapter was "
            "trained against a different base model" % (key, tuple(base_w.shape), (b.shape[0], a.shape[1]))
        )
    delta = torch.matmul(b, a).mul_(scaling)
    fused = base_w.to(dtype=torch.float32).add_(delta)
    return fused.to(dtype=base_w.dtype)


# The suffix the OLD copy of a voice is parked under while the new one is renamed into
# place. It must stay in step with PREVIOUS_SUFFIX in electron/orpheus-models.ts, which is
# what makes the model scan ignore a leftover one.
PREVIOUS_SUFFIX = ".previous"


def prepare_workspace(workspace):
    """Empty scratch dir for this run, with any stale one from a killed run removed.

    A previous run that was killed (or crashed hard enough to skip the cleanup in fuse())
    leaves its half-written shards here. Reusing them would be catastrophic in the quiet
    way this whole script exists to prevent — a shard from the WRONG adapter surviving
    into the new model — so the first thing a run does is delete the workspace outright.
    """
    if os.path.isdir(workspace):
        print("[FUSE] removing a stale workspace from an interrupted run: %s" % workspace, flush=True)
        shutil.rmtree(workspace)
    elif os.path.exists(workspace):
        raise FuseError("workspace path %s exists and is not a directory" % workspace)
    os.makedirs(workspace)


def discard_workspace(workspace):
    """Best-effort delete after a failure. Returns '' or a note to append to the error."""
    try:
        if os.path.isdir(workspace):
            shutil.rmtree(workspace)
        return ""
    except Exception as e:
        return (" (the fuse workspace %s could NOT be removed: %s - delete it by hand; it is "
                "several GB of a half-written model)" % (workspace, e))


def promote(workspace, out_dir):
    """Swap the finished workspace into place without a window where neither copy exists.

    rmtree(out) THEN rename(new) is the obvious order and the wrong one: a kill (or a
    failed rmtree) between the two steps destroys the working voice and leaves nothing,
    and re-installing the same repo is the COMMON path, not a rare one. So:

        rename(out -> out.previous)   the old copy is still whole, just renamed
        rename(workspace -> out)      the new copy becomes the voice
        rmtree(out.previous)          only now is anything deleted

    Every step is a rename until the last one, so an interruption anywhere leaves either
    the old model or the new model under `out`, never a hole. `.previous` is in the model
    scan's skip set, so a leftover one is inert rather than adopted as a voice.

    Returns a warning string (empty when clean).
    """
    previous = out_dir + PREVIOUS_SUFFIX
    if os.path.isdir(previous):
        shutil.rmtree(previous)  # leftover from an interrupted earlier promote
    stashed = False
    if os.path.exists(out_dir):
        try:
            os.rename(out_dir, previous)
        except OSError as e:
            raise FuseError("could not park the existing model at %s out of the way: %s" % (out_dir, e))
        stashed = True
    try:
        os.rename(workspace, out_dir)
    except OSError as e:
        if stashed:
            try:
                os.rename(previous, out_dir)
            except OSError as e2:
                raise FuseError(
                    "could not move the fused model into %s (%s) AND could not restore the previous "
                    "model from %s (%s) - the previous copy is intact at that path and has to be "
                    "renamed back by hand" % (out_dir, e, previous, e2)
                )
        raise FuseError(
            "could not move the fused model from %s into %s: %s. The workspace and the output must "
            "be on the same filesystem - promotion is a rename so the previous copy is never deleted "
            "before the new one is in place." % (workspace, out_dir, e)
        )
    if stashed:
        try:
            shutil.rmtree(previous)
        except Exception as e:
            # The new model is already in place, so this is not a failure of the fuse -
            # just several GB of a superseded copy left on disk. Say so loudly anyway.
            return ("the fused model is installed, but the previous copy could not be deleted from %s "
                    "(%s) - remove it by hand to reclaim the space" % (previous, e))
    return ""


def fuse(base_dir, adapter_dir, out_dir, workspace, force, verify):
    """Build the fused model in `workspace`, verify it, then promote it onto `out_dir`.

    Returns {'fused': n} plus 'warning' when something non-fatal was left behind. On ANY
    failure the workspace is removed before the error propagates, so a failed fuse cannot
    strand ~6.6 GB of half-written model — nor leave anything shaped enough like a model
    for BookForge's "is it installed" predicates to adopt.
    """
    for label, d in (("base", base_dir), ("adapter", adapter_dir)):
        if not os.path.isdir(d):
            raise FuseError("%s dir %s does not exist" % (label, d))
    real_out = os.path.realpath(out_dir)
    if real_out in (os.path.realpath(base_dir), os.path.realpath(adapter_dir)):
        raise FuseError("--out %s is the base or the adapter dir; refusing to overwrite an input" % out_dir)
    real_ws = os.path.realpath(workspace)
    if real_ws in (real_out, os.path.realpath(base_dir), os.path.realpath(adapter_dir)):
        raise FuseError("--workspace %s is the output, the base or the adapter dir; it must be its own scratch dir" % workspace)

    # A non-empty output is refused unless the caller says it means to replace it. The
    # installer passes --force (a re-install of a retrained voice MUST replace the old
    # fused copy); a human running this by hand gets the guard.
    if os.path.isdir(out_dir) and not force:
        existing = [f for f in os.listdir(out_dir) if f.endswith(".safetensors") or f == "config.json"]
        if existing:
            raise FuseError(
                "out dir %s already holds a model (%s...). Pass --force to replace it."
                % (out_dir, existing[0])
            )

    scaling, targets = load_adapter_config(adapter_dir)
    print("[FUSE] adapter %s: scaling=%.6g over %s" % (adapter_dir, scaling, ",".join(targets)), flush=True)
    pairs = collect_lora_pairs(adapter_dir)
    print("[FUSE] %d LoRA-targeted weights to fuse" % len(pairs), flush=True)

    shards, weight_map = read_base_layout(base_dir)
    print("[FUSE] base %s: %d shard(s)" % (base_dir, len(shards)), flush=True)

    prepare_workspace(workspace)
    try:
        result = _build(base_dir, workspace, shards, weight_map, pairs, scaling, verify)
        # Inside the try as well: a promote that fails leaves the finished model sitting in
        # the workspace, which is still several GB of nothing-anyone-can-use. (It cannot
        # fail AFTER the model reaches out_dir — the only step past that point is deleting
        # the superseded copy, which returns a warning rather than raising.)
        warning = promote(workspace, out_dir)
    except BaseException as exc:  # including a kill: leave nothing behind either way
        note = discard_workspace(workspace)
        if note and isinstance(exc, Exception):
            raise FuseError(_describe(exc) + note)
        raise
    if warning:
        print("[FUSE] warning: %s" % warning, flush=True)
        result["warning"] = warning
    print("[FUSE] fused model written to %s" % out_dir, flush=True)
    return result


def _describe(exc):
    return str(exc) if isinstance(exc, FuseError) else "%s: %s" % (type(exc).__name__, exc)


def _tensor_bytes(t):
    """A tensor's raw little-endian buffer as `bytes`, via a uint8 view (no reinterpret
    beyond the byte level, so bf16 — which numpy has no dtype for — works)."""
    import torch

    if sys.byteorder != "little":
        # safetensors files are little-endian. Byte-swapping is a real thing to implement,
        # not something to get silently wrong on a host nobody has tested this on.
        raise FuseError("this host is big-endian; the fused shards would need byte-swapping and this script does not do that")
    if not t.is_contiguous():
        t = t.contiguous()
    return t.view(torch.uint8).numpy().tobytes()


def _serialize_shard(tensors, dst, metadata):
    """Write one shard, CONSUMING `tensors`, without holding the shard twice.

    `safetensors.torch.save_file` flattens first: its `_flatten` copies EVERY tensor into
    a Python `bytes` via `_tobytes` and only then hands the whole dict to the Rust writer,
    so for the duration of the write a shard exists in RAM as both torch tensors and bytes.
    On Orpheus's 4.99 GB shard that duplicate is ~5 GB — measured as the single largest
    term in this script's peak RSS.

    Same serializer (`safetensors.serialize_file` is exactly what save_file calls, so the
    output is byte-identical), fed one tensor at a time, dropping each torch tensor the
    moment its bytes exist. Peak becomes one shard rather than two.
    """
    from safetensors import serialize_file

    flat = {}
    for key in list(tensors):
        t = tensors.pop(key)
        flat[key] = {
            "dtype": str(t.dtype).split(".")[-1],
            "shape": tuple(t.shape),
            "data": _tensor_bytes(t),
        }
        del t
    serialize_file(flat, dst, metadata=metadata)


def _build(base_dir, workspace, shards, weight_map, pairs, scaling, verify):
    """The merge itself, writing shard-for-shard into an empty `workspace`."""
    from safetensors import safe_open

    # verify_output re-derives three of the fused weights from the base + adapter, so
    # those three LoRA pairs have to outlive the merge. Every OTHER pair is dropped the
    # moment its base tensor is fused (`remaining.pop`), which is why `remaining` is the
    # dict itself rather than a copy of it: with ~0.8 GB of fp32 adapter in play, holding
    # a second reference to all of it for the whole run is 0.8 GB of peak for nothing.
    fused_keys = sorted(pairs)
    picks = sorted({fused_keys[0], fused_keys[len(fused_keys) // 2], fused_keys[-1]})
    verify_pairs = {k: pairs[k] for k in picks}
    remaining = pairs

    fused_count = 0
    for si, shard in enumerate(shards, 1):
        src = os.path.join(base_dir, shard)
        tensors = {}
        with safe_open(src, framework="pt", device="cpu") as fh:
            metadata = fh.metadata() or {"format": "pt"}
            keys = list(fh.keys())
            last_layer = None
            for key in keys:
                # One tensor at a time: the shard is never materialised twice, and a key
                # that needs no fusing is read straight through to the output dict.
                t = fh.get_tensor(key)
                slot = remaining.pop(key, None)
                if slot is not None:
                    layer = layer_of(key)
                    if layer != last_layer:
                        print("[FUSE] shard %d/%d layer %s" % (si, len(shards), layer), flush=True)
                        last_layer = layer
                    t = fuse_tensor(t, slot["A"], slot["B"], scaling, key)
                    fused_count += 1
                    del slot  # frees the pair unless verify_pairs still holds it
                tensors[key] = t
        dst = os.path.join(workspace, shard)
        written = len(tensors)
        _serialize_shard(tensors, dst, metadata)  # consumes `tensors`
        print("[FUSE] wrote %s (%d tensors, %d fused so far)" % (shard, written, fused_count), flush=True)
        del tensors

    if remaining:
        # Every LoRA weight must have found its base tensor. One that didn't means the
        # adapter was trained against a different architecture (or a different naming
        # convention) and the "merged" model would be the base in disguise for those
        # projections — audible only as a subtly wrong voice.
        sample = sorted(remaining)[:3]
        raise FuseError(
            "%d LoRA weights name base tensors that do not exist in %s (e.g. %s) - "
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
        shutil.copyfile(src, os.path.join(workspace, name))
        copied += 1
    print("[FUSE] copied %d config/tokenizer files from the base" % copied, flush=True)

    if verify:
        verify_output(workspace, base_dir, fused_keys, verify_pairs, scaling, weight_map, shards)
    return {"fused": fused_count}


# -- verification ---------------------------------------------------------------

# One bf16 mantissa step is 2^-8 relative; allow two of them so a fp32 summation-order
# difference between the fuse pass and the verify pass (different thread counts, say)
# that lands on a rounding boundary is tolerated, while a genuinely wrong merge — which
# is off by the whole LoRA delta, orders of magnitude more — still fails.
_ULP_RELATIVE = 2.0 ** -7


def verify_output(out_dir, base_dir, fused_keys, verify_pairs, scaling, weight_map, shards):
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

    for key in fused_keys:
        if key not in shapes:
            raise FuseError("verify: fused tensor %r is not in the output" % key)

    # Spot-check: recompute W' from the BASE + adapter and compare to what was written.
    base_shards, _ = read_base_layout(base_dir)
    for key in sorted(verify_pairs):
        base_w = _read_tensor(base_dir, base_shards, key)
        stored = _read_tensor(out_dir, shards, key)
        if tuple(stored.shape) != tuple(base_w.shape):
            raise FuseError("verify: %r is %s in the output but %s in the base" % (key, tuple(stored.shape), tuple(base_w.shape)))
        expected = fuse_tensor(base_w, verify_pairs[key]["A"], verify_pairs[key]["B"], scaling, key)
        diff = (stored.to(torch.float32) - expected.to(torch.float32)).abs().max().item()
        bound = expected.to(torch.float32).abs().max().item() * _ULP_RELATIVE
        if diff > bound:
            raise FuseError(
                "verify: %r differs from a freshly computed W' by %.3e (bf16 tolerance %.3e)" % (key, diff, bound)
            )
        print("[FUSE] verify %s: max abs diff=%.3e (tolerance %.3e)" % (key, diff, bound), flush=True)
    print("[FUSE] verify OK: %d tensors, %d spot-checked" % (len(shapes), len(verify_pairs)), flush=True)


def _read_tensor(model_dir, shards, key):
    from safetensors import safe_open
    for shard in shards:
        path = os.path.join(model_dir, shard)
        with safe_open(path, framework="pt", device="cpu") as fh:
            if key in fh.keys():
                return fh.get_tensor(key)
    raise FuseError("tensor %r not found in %s" % (key, model_dir))


# -- cli ------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Fuse a PEFT LoRA adapter into a copy of its base model.")
    parser.add_argument("--base", required=True, help="the shared base model dir")
    parser.add_argument("--adapter", required=True, help="the PEFT LoRA adapter dir")
    parser.add_argument("--out", required=True, help="the merged model dir to write")
    parser.add_argument("--workspace", required=True,
                        help="scratch dir to build in; must be on the same filesystem as --out "
                             "(it is renamed into place) and is deleted on failure")
    parser.add_argument("--force", action="store_true", help="replace an existing model at --out")
    parser.add_argument("--verify", action="store_true", help="re-read the output and spot-check the merge")
    args = parser.parse_args()

    try:
        result = fuse(args.base, args.adapter, args.out, args.workspace, args.force, args.verify)
    except FuseError as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        return 1
    except Exception as e:  # surface the real reason (missing torch/safetensors, disk full, …)
        print(json.dumps({"ok": False, "error": _describe(e)}), flush=True)
        return 1
    print(json.dumps(dict({"ok": True, "out": args.out}, **result)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
