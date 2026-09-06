"""Download a Higgs v3 MERGED CHECKPOINT from HuggingFace into its catalog directory.

Invoked by electron/higgs-hf-install.ts — inside WSL on Windows (the `higgs3`
env, so the ~8.5 GB lands on the guest's ext4 at the catalog's `wsl` path, which
is where the launch script is pointed), natively on the Mac (narrator's own
python, into the catalog's `darwin` path under the app's userData). Writes the
repo snapshot into <dest> and prints ONE JSON line with the result. The token
comes from HF_TOKEN in the environment so it never appears on argv.

WHAT A HIGGS CHECKPOINT MUST CARRY, all checked after the download, because the
serve side resolves them out of the directory and a missing one is a server that
comes up wrong rather than a download that failed:

    config.json, *.safetensors           the model
    tokenizer.json, tokenizer_config.json, chat_template.jinja
                                          the prompt builder's inputs
    generation_config.json               THE SAMPLING. vllm-omni reads it from
                                          the model dir; without it top_k is
                                          disabled and prompts over ~600 chars
                                          derail into babble (measured
                                          2026-09-05). narrator refuses a
                                          checkpoint voice without it BY NAME,
                                          so a download that lacks it is
                                          deleted here rather than left to be
                                          found five minutes into a launch.

Usage:  python higgs_download.py <repo_id> <dest_dir>
"""
import json
import os
import shutil
import sys

REQUIRED_FILES = (
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'chat_template.jinja',
    'generation_config.json',
)

# Boson's own model card and prompting guide ride in the base snapshot and in the
# repo; the licence and NOTICE are kept because distribution requires them and a
# person may read them from the directory.
IGNORE_PATTERNS = ['AGENTS.md', 'PROMPTING.md', '.gitattributes', '*.png', '*.jpg']


def validate(dest: str):
    """The error naming what is missing, or None."""
    missing = [f for f in REQUIRED_FILES if not os.path.isfile(os.path.join(dest, f))]
    if missing:
        return 'downloaded checkpoint is missing ' + ', '.join(missing)
    if not any(f.endswith('.safetensors') for f in os.listdir(dest)):
        return 'downloaded checkpoint has no *.safetensors weights'
    try:
        with open(os.path.join(dest, 'generation_config.json'), encoding='utf-8') as handle:
            sampling = json.load(handle)
    except (OSError, ValueError) as exc:
        return f'generation_config.json is unreadable: {exc}'
    for key in ('temperature', 'top_p', 'top_k'):
        if not isinstance(sampling.get(key), (int, float)):
            return f'generation_config.json states no usable {key}'
    return None


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({'ok': False, 'error': 'usage: higgs_download.py <repo_id> <dest_dir>'}))
        return 2
    repo_id, dest = sys.argv[1], sys.argv[2]
    token = os.environ.get('HF_TOKEN') or None
    try:
        from huggingface_hub import snapshot_download
        os.makedirs(dest, exist_ok=True)
        # local_dir: a plain copy, no symlinks into a cache — the launch script
        # and the MLX loader open the files in place.
        snapshot_download(repo_id=repo_id, local_dir=dest, token=token,
                          ignore_patterns=IGNORE_PATTERNS)
        err = validate(dest)
        if err:
            # A partial or wrong checkpoint on disk is worse than none: the
            # picker would read the directory as staged and the failure would
            # surface as an opaque server-start error. Delete it so "try again"
            # retries.
            shutil.rmtree(dest, ignore_errors=True)
            print(json.dumps({'ok': False,
                              'error': f'{err} - the incomplete download was deleted from {dest}; try again'}))
            return 1
        size = sum(os.path.getsize(os.path.join(dest, f)) for f in os.listdir(dest)
                   if os.path.isfile(os.path.join(dest, f)))
        print(json.dumps({'ok': True, 'dest': dest, 'bytes': size}))
        return 0
    except Exception as exc:  # the real reason: auth, network, a missing repo
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
