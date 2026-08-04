"""Download an Orpheus artifact from HuggingFace into the local models dir.

Invoked by electron/orpheus-hf-catalog.ts (natively on Mac/Linux, or inside WSL
on Windows so the files land on ext4, not the slow /mnt/c mount). Writes the repo
snapshot into <dest> and prints a single JSON line with the result. The token, if
any, comes from the HF_TOKEN env var so it never appears in the process args.

Three artifact KINDS exist, and each has its own post-download validation — the
original config.json + *.safetensors check is correct for a full model but FAILS on
a LoRA repo, which ships adapter_config.json + adapter_model.safetensors and no
config.json at all:

  merged   a full fine-tuned voice model   -> <models>/<id>/
  base     the one shared base model       -> <models>/_base/<name>/
  adapter  a per-voice LoRA                -> <models>/adapters/<id>/

`--kind` defaults to `merged`, so an older caller that passes only the two
positional args keeps its exact previous behaviour.

Usage:  python orpheus_download.py <repo_id> <dest_dir> [--kind merged|adapter|base]
"""
import os
import shutil
import sys
import json

KINDS = ("merged", "adapter", "base")

# Docs/images are never needed. Adapter repos are the exception on README.md: their
# card is the only place the prompt token lives, but BookForge reads that over HTTP
# from the catalog, not off disk, so it is skipped here too.
IGNORE_PATTERNS = ["*.md", ".gitattributes", "*.png", "*.jpg"]


def _has_suffix(dest, suffix):
    return any(f.endswith(suffix) for f in os.listdir(dest))


def validate(kind, dest):
    """Return an error string when <dest> is not a usable artifact of <kind>."""
    if kind == "adapter":
        # PEFT layout. Both halves are required: adapter_config.json alone is a
        # half-finished download that would fail deep inside vLLM's engine start.
        if not os.path.exists(os.path.join(dest, "adapter_config.json")):
            return "downloaded repo is missing adapter_config.json (not a LoRA adapter repo)"
        if not _has_suffix(dest, ".safetensors"):
            return "downloaded adapter has no *.safetensors weights file"
        return None
    # merged and base are the same on-disk shape: a full model.
    if not os.path.exists(os.path.join(dest, "config.json")):
        return "downloaded repo is missing config.json"
    if not _has_suffix(dest, ".safetensors"):
        return "downloaded repo is missing *.safetensors weights"
    return None


def parse_args(argv):
    positional = []
    kind = "merged"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--kind":
            if i + 1 >= len(argv):
                raise ValueError("--kind needs a value (merged|adapter|base)")
            kind = argv[i + 1]
            i += 2
            continue
        if a.startswith("--kind="):
            kind = a.split("=", 1)[1]
            i += 1
            continue
        positional.append(a)
        i += 1
    if len(positional) != 2:
        # Exactly two, never "at least two": a stray extra argument means the caller
        # built the command wrong, and silently ignoring it is how a download lands
        # somewhere nobody looks.
        raise ValueError("usage: orpheus_download.py <repo_id> <dest_dir> [--kind merged|adapter|base]")
    if kind not in KINDS:
        raise ValueError("--kind must be one of %s (got %r)" % ("|".join(KINDS), kind))
    return positional[0], positional[1], kind


def main() -> int:
    try:
        repo_id, dest, kind = parse_args(sys.argv[1:])
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    token = os.environ.get("HF_TOKEN") or None
    try:
        from huggingface_hub import snapshot_download
        os.makedirs(dest, exist_ok=True)
        # local_dir gives a plain (non-symlinked) copy. Skip docs/attributes — we
        # only need the model: config + weights + tokenizer + generation config.
        snapshot_download(
            repo_id=repo_id,
            local_dir=dest,
            token=token,
            ignore_patterns=IGNORE_PATTERNS,
        )
        err = validate(kind, dest)
        if err:
            # DELETE the failed download. What is on disk is a partial/wrong artifact,
            # and leaving it there is worse than having nothing: the local registry's
            # folder predicates can read a half-finished model as installed, so the UI
            # would report success and the failure would resurface much later as an
            # opaque engine-load error. Removing it makes "try again" actually retry.
            shutil.rmtree(dest, ignore_errors=True)
            print(json.dumps({
                "ok": False,
                "error": "%s — the incomplete download was deleted from %s; try again" % (err, dest),
            }))
            return 1
        print(json.dumps({"ok": True, "dest": dest, "kind": kind}))
        return 0
    except Exception as e:  # surface the real reason (auth, network, missing repo)
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
