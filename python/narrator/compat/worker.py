"""`ebook2audiobook/worker.py ...`, answered by narrator.

    python -m narrator.compat.worker --session <id> --session_dir <dir> \
        --sentences_dir <dir> --device cuda --tts_engine orpheus \
        --fine_tuned deathstalker --sentence_start 0 --sentence_end 999

Ported from ebook2audiobook@9daab0ba `worker.py:main` (346-521).

This is the entry point `electron/parallel-tts-bridge.ts` actually spawns for
every render (`workerPath` at :3880) and every retake
(`regenerateSentenceIndices` at :3596), so it exists under its own name: the
cut-over is then one string in the bridge, not a re-shaped command line.

It is `compat.app` with `--worker_mode` implied, and nothing else. e2a's
`worker.py` has no `--headless` and no mode flags: naming a session and a range
IS the mode. Same parser, same refusals, same routing, same exit codes - see
`compat/FLAGS.md`.
"""
from __future__ import annotations

import sys

from ..engine.log import set_log_stream
from . import app as compat_app
from .flags import FlagRefused


def main(argv: list[str] | None = None, engine_factory=None) -> int:
    # THIS HOST'S STDOUT IS A PARSED CHANNEL, so the engine's log lines belong
    # on it. `electron/parallel-tts-bridge.ts` spawns exactly this module and
    # its worker `stdout` handler runs FIVE parsers its `stderr` handler does
    # not - MODEL_LOAD_START_RE, MODEL_LOAD_DONE_RE, REPAIR_START_RE,
    # parseMlxHeartbeat() and parseOrpheusGuardEvent() - every one of which
    # matches a string printed by `engine/orpheus/`. The engine defaults to
    # stderr (safe for a host with a structured stdout, e.g. narrator.serve);
    # this is the host that has to say otherwise, and saying it here keeps the
    # bridge's model-load bar, batch bar, repair bar and guard-event index
    # working byte for byte. See narrator/engine/log.py.
    set_log_stream(sys.stdout)
    argv = list(sys.argv[1:] if argv is None else argv)
    # `--worker_mode` is app.py's flag, not worker.py's. Implying it here is what
    # makes this door "the worker", and it is invisible to the caller: passing it
    # explicitly is also accepted, because argparse's store_true is idempotent.
    if '--worker_mode' not in argv:
        argv = argv + ['--worker_mode']
    return compat_app.main(argv, engine_factory=engine_factory)


def run() -> int:
    from ..render.worker import install_signal_handlers, start_parent_watch

    install_signal_handlers()
    start_parent_watch()
    try:
        return main()
    except FlagRefused as refused:
        return int(refused.code or 1)


if __name__ == '__main__':
    sys.exit(run())
