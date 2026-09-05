"""`python -m narrator.align.worker` - align chunks in an interpreter that can.

The whole interface is a JSON-lines protocol on stdin/stdout, exactly like
`serve/worker.py`'s, so a narrator running on an interpreter without torch can
drive one that has it without either side importing the other's dependencies.

    stdin   one JSON job per line:
            {"audioPath": "...", "text": "...", "language": "en",
             "backend": "whisperx", "device": "cpu", "index": 12}
    stdout  one JSON result per line, IN THE SAME ORDER:
            {"ok": true, "index": 12, "alignment": {...}}
            {"ok": false, "index": 12, "error": "..."}

A job that fails is reported and the run CONTINUES to the next job, so one bad
chunk does not cost the model load for the rest of the book - but nothing is
retried and no other backend is tried (Owen's ruling, 2026-09-05): the failure
travels back with its chunk index and the caller decides. A failure the WORKER
cannot survive (a backend that will not import at all) exits non-zero on the
first job and says so on stderr.

`text` must already be the spoken text. The worker does not strip markers: the
caller owns that reading, and a worker that quietly re-derived it could disagree
with the sentence splitter running on the other side.
"""

from __future__ import annotations

import json
import sys

from .aligner import AlignerError, align_chunk, load_backend


def main(argv=None) -> int:
    del argv
    failures = 0
    loaded = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        index = job.get('index')
        try:
            # Load the model BEFORE the first alignment is timed, so a chunk's
            # `elapsedSeconds` is alignment and not a 5-20 s one-off.
            key = (job.get('backend', 'whisperx'), job.get('language', 'en'),
                   job.get('device', 'cpu'))
            if loaded != key:
                seconds = load_backend(*key)
                print(f'[align-worker] loaded {key[0]} ({key[1]}, {key[2]}) in '
                      f'{seconds:.1f}s', file=sys.stderr, flush=True)
                loaded = key
            alignment = align_chunk(
                job['audioPath'], job['text'],
                language=job.get('language', 'en'),
                backend=job.get('backend', 'whisperx'),
                device=job.get('device', 'cpu'),
                ffmpeg=job.get('ffmpeg'),
            )
            result = {'ok': True, 'index': index,
                      'alignment': alignment.as_dict()}
        except AlignerError as refused:
            failures += 1
            result = {'ok': False, 'index': index, 'error': str(refused)}
        except Exception as failed:  # pragma: no cover - protocol backstop
            failures += 1
            result = {'ok': False, 'index': index,
                      'error': f'{type(failed).__name__}: {failed}'}
        sys.stdout.write(json.dumps(result) + '\n')
        sys.stdout.flush()
    if failures:
        print(f'[align-worker] {failures} job(s) failed', file=sys.stderr,
              flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
