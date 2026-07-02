"""Download a faster-whisper (CTranslate2) model from HuggingFace into a local dir.

Invoked by electron/whisper-models.ts natively in the bundled e2a env. Writes the
repo snapshot into <dest> and prints a single JSON line with the result. A CTranslate2
Whisper model is valid when it has model.bin + config.json. The TS side computes a
progress bar by polling <dest> size against the model's known byte count, so this
script only needs to fetch and validate.

Usage:  python whisper_download.py <repo_id> <dest_dir>
"""
import os
import sys
import json


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: whisper_download.py <repo_id> <dest_dir>"}))
        return 2
    repo_id = sys.argv[1]
    dest = sys.argv[2]
    token = os.environ.get("HF_TOKEN") or None
    try:
        from huggingface_hub import snapshot_download
        os.makedirs(dest, exist_ok=True)
        # local_dir → a plain (non-symlinked) copy. A faster-whisper repo is small:
        # model.bin + config.json + tokenizer.json + vocabulary.*. Skip docs/media.
        snapshot_download(
            repo_id=repo_id,
            local_dir=dest,
            token=token,
            ignore_patterns=["*.md", ".gitattributes", "*.png", "*.jpg", "*.onnx"],
        )
        has_model = os.path.exists(os.path.join(dest, "model.bin"))
        has_config = os.path.exists(os.path.join(dest, "config.json"))
        if not (has_model and has_config):
            print(json.dumps({"ok": False, "error": "downloaded repo is missing model.bin or config.json"}))
            return 1
        print(json.dumps({"ok": True, "dest": dest}))
        return 0
    except Exception as e:  # surface the real reason (auth, network, missing repo)
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
