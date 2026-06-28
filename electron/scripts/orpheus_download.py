"""Download an Orpheus voice model from HuggingFace into the local models dir.

Invoked by electron/orpheus-hf-catalog.ts (natively on Mac/Linux, or inside WSL
on Windows so the files land on ext4, not the slow /mnt/c mount). Writes the repo
snapshot into <dest> and prints a single JSON line with the result. The token, if
any, comes from the HF_TOKEN env var so it never appears in the process args.

Usage:  python orpheus_download.py <repo_id> <dest_dir>
"""
import os
import sys
import json


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: orpheus_download.py <repo_id> <dest_dir>"}))
        return 2
    repo_id = sys.argv[1]
    dest = sys.argv[2]
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
            ignore_patterns=["*.md", ".gitattributes", "*.png", "*.jpg"],
        )
        has_config = os.path.exists(os.path.join(dest, "config.json"))
        has_weights = any(f.endswith(".safetensors") for f in os.listdir(dest))
        if not (has_config and has_weights):
            print(json.dumps({"ok": False, "error": "downloaded repo is missing config.json or *.safetensors"}))
            return 1
        print(json.dumps({"ok": True, "dest": dest}))
        return 0
    except Exception as e:  # surface the real reason (auth, network, missing repo)
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
