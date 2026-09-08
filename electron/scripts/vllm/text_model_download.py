"""Stage a TEXT-PASS model from HuggingFace into the guest's ext4, with progress.

Invoked by electron/text-server.ts, inside WSL, through the same env that holds
vllm (`higgs3` on this PC — it carries huggingface_hub). Writes the snapshot into
<dest> and prints ONE JSON line per progress tick plus ONE JSON result line.

WHY IT EXISTS RATHER THAN higgs_download.py. That one is the Higgs CHECKPOINT
door: it validates `generation_config.json` (a Higgs voice without it babbles),
strips the model card, and reports only at the end. A text model has none of
those requirements and a very different wait — 21 GB for the 27B — so the thing
that matters here is a number on the queue row while it happens. Owen,
2026-09-08, on the not-staged case: *"id rather it just switch to the correct
profile rather than failing."* A profile that can stage itself is what makes that
true, and a stage nobody can watch is indistinguishable from a hang.

THE REVISION IS PINNED BY THE CALLER and passed here, never resolved to "main":
the served name is what Foundry writes into its bank key, its records key and its
narration stamp, and two books cleaned against two revisions of one repo must not
be byte-indistinguishable in their records.

RESUMABLE, because `snapshot_download` is: an interrupted stage leaves the
partial blobs in <dest>/.cache and the next call continues from them. So a failed
download is retried by running this again, and nothing is deleted on the way out
— the opposite of higgs_download.py's rule, deliberately, because there is no
"looks staged but is wrong" state to protect against here: text-server.ts asks
for config.json AND the weight index AND a *.safetensors before it calls a
directory staged, and a half-finished snapshot has no index.

Usage:  python text_model_download.py <repo_id> <revision> <dest_dir>
"""
import json
import os
import sys
import threading
import time


def tree_bytes(root: str) -> int:
    """Every byte under <root>, finished or in flight.

    The partial blobs live in `<dest>/.cache/huggingface/download/*.incomplete`
    while they stream, so walking the whole tree is what makes the count move
    during the download rather than jumping per completed file.
    """
    total = 0
    for base, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass  # a blob renamed out from under the walk; the next tick counts it
    return total


def repo_bytes(repo_id: str, revision: str, token) -> int:
    """What the finished snapshot should weigh, from the repo's own file metadata.

    0 when the API cannot say — the progress line then reports bytes with no
    total rather than inventing one.
    """
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo_id, revision=revision, files_metadata=True, token=token)
        return sum(int(f.size or 0) for f in (info.siblings or []))
    except Exception:
        return 0


def main() -> int:
    if len(sys.argv) != 4:
        print(json.dumps({'ok': False,
                          'error': 'usage: text_model_download.py <repo_id> <revision> <dest_dir>'}),
              flush=True)
        return 2
    repo_id, revision, dest = sys.argv[1], sys.argv[2], sys.argv[3]
    token = os.environ.get('HF_TOKEN') or None

    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': f'huggingface_hub is not importable here: {exc}'}),
              flush=True)
        return 1

    os.makedirs(dest, exist_ok=True)
    total = repo_bytes(repo_id, revision, token)
    print(json.dumps({'progress': {'bytes': tree_bytes(dest), 'total': total}}), flush=True)

    outcome = {}
    def run():
        try:
            # local_dir: a plain copy rather than symlinks into a shared cache —
            # vLLM opens the files in place, and a cache the user later clears
            # would empty a directory the server is pointed at.
            snapshot_download(repo_id=repo_id, revision=revision, local_dir=dest, token=token)
            outcome['ok'] = True
        except Exception as exc:  # the real reason: network, disk, a dead revision
            outcome['ok'] = False
            outcome['error'] = f'{type(exc).__name__}: {exc}'

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    while worker.is_alive():
        time.sleep(2.0)
        print(json.dumps({'progress': {'bytes': tree_bytes(dest), 'total': total}}), flush=True)
    worker.join()

    if not outcome.get('ok'):
        print(json.dumps({'ok': False, 'error': outcome.get('error', 'the download said nothing'),
                          'dest': dest}), flush=True)
        return 1
    print(json.dumps({'ok': True, 'dest': dest, 'bytes': tree_bytes(dest),
                      'revision': revision}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
