"""`ebook2audiobook/app.py --headless ...`, answered by narrator.

    python -m narrator.compat.app --headless --worker_mode --session <id> \
        --session_dir <dir> --sentence_start 0 --sentence_end 999 ...

Ported from ebook2audiobook@9daab0ba:
  app.py                                 main()'s option list and its
                                         unrecognized-option loop (158-232)
  bookforge_ext/parallel/args.py         PARALLEL_OPTIONS + add_arguments
  bookforge_ext/parallel/handlers.py     dispatch() - the routing this file is
  worker.py                              main()'s parser (the union, see below)

WHY THIS DOOR IS THE UNION OF TWO e2a PARSERS. BookForge spawns e2a two ways
(`parallel-tts-bridge.ts:3862-3966`, gated on `useLightweightWorker`): the
lightweight `worker.py` for renders and retakes, and `app.py --headless
--worker_mode` when that flag is off. `worker.py` carries four flags `app.py`
has never had (`--sentence_indices`, `--sentence_overrides`, `--num_takes`,
`--take_temperatures`) and `app.py` carries three `worker.py` has never had
(`--prep_only`, `--worker_mode`, `--assemble_only`). Accepting the union here
means one narrator module answers both spawn shapes; `compat/worker.py` is the
same routing under `worker.py`'s own name so the bridge's `workerPath` becomes a
one-line change. See `compat/FLAGS.md`.

WHICH WORKER `--worker_mode` REACHES. e2a's `app.py --worker_mode` runs
`session.worker_only` -> `lib/core.convert_chapters2audio`, which is the
UNBATCHED path with a different resume rule and different progress lines.
narrator routes `--worker_mode` to `render.worker`, which is the port of
`worker_core.run_worker_tts` - the path BookForge actually renders books with,
the one that is batched and whose `Converting sentence N/M (P%)` line the
bridge's progress regex reads. The two produce the same file set at the same
indices; narrator keeps one. Recorded in FLAGS.md.

EXIT CODES are e2a's: 0 when the result says success, 1 otherwise, 1 for a
refused or unrecognized flag. There is no special code for a poisoned CUDA
context - grep e2a for one and there is nothing; the engine re-raises, the
worker returns success=False, the process exits 1 and BookForge respawns.
"""
from __future__ import annotations

import argparse
import json
import sys

from . import flags as flagdef
from .flags import FlagRefused
from ..render.retake import RetakeArgumentError


def build_parser() -> argparse.ArgumentParser:
    """Every flag in `flags.FLAGS`, with e2a's types and defaults.

    Types matter: `--sentence_start` is an int in both e2a parsers, `--num_takes`
    an int, `--bilingual_pause` a float. Refused flags are still DECLARED so that
    passing one produces narrator's named refusal rather than argparse's
    "unrecognized arguments".
    """
    p = argparse.ArgumentParser(
        prog='narrator.compat.app',
        description="ebook2audiobook's headless door, answered by narrator. "
                    "Every flag's verdict is in narrator/compat/FLAGS.md.",
        add_help=True,
    )

    # modes
    p.add_argument('--headless', action='store_true')
    p.add_argument('--prep_only', action='store_true')
    p.add_argument('--worker_mode', action='store_true')
    p.add_argument('--assemble_only', action='store_true')
    p.add_argument('--list_sessions', action='store_true')
    p.add_argument('--resume_session', type=str, default=None)

    # session
    p.add_argument('--session', type=str, default=None)
    p.add_argument('--session_dir', type=str, default=None)
    p.add_argument('--sentences_dir', type=str, default=None)
    p.add_argument('--encoded_chapters_dir', type=str, default=None)
    p.add_argument('--output_dir', type=str, default=None)

    # range
    p.add_argument('--sentence_start', type=int, default=None)
    p.add_argument('--sentence_end', type=int, default=None)
    p.add_argument('--chapter_start', type=int, default=None)
    p.add_argument('--chapter_end', type=int, default=None)
    p.add_argument('--chapters', type=str, default=None)

    # retakes (worker.py's four)
    p.add_argument('--sentence_indices', type=str, default=None)
    p.add_argument('--sentence_overrides', type=str, default=None)
    p.add_argument('--num_takes', type=int, default=1)
    p.add_argument('--take_temperatures', type=str, default=None)

    # voice
    p.add_argument('--tts_engine', type=str, default=None)
    p.add_argument('--fine_tuned', type=str, default=None)
    p.add_argument('--orpheus_model_dir', type=str, default=None)
    p.add_argument('--orpheus_adapter_dir', type=str, default=None)
    p.add_argument('--orpheus_base_dir', type=str, default=None)

    # assembly detail
    p.add_argument('--post_render_filter', type=str, default=None)
    p.add_argument('--output_format', type=str, default=None)
    p.add_argument('--no_split', action='store_true')

    # accepted and ignored
    p.add_argument('--skip_deps', action='store_true')
    p.add_argument('--device', type=str, default=None)
    p.add_argument('--language', type=str, default=None)
    p.add_argument('--voice', type=str, default=None)
    p.add_argument('--speed', type=float, default=None)
    p.add_argument('--temperature', type=float, default=None)
    p.add_argument('--length_penalty', type=float, default=None)
    p.add_argument('--num_beams', type=int, default=None)
    p.add_argument('--repetition_penalty', type=float, default=None)
    p.add_argument('--top_k', type=int, default=None)
    p.add_argument('--top_p', type=float, default=None)
    p.add_argument('--enable_text_splitting', action='store_true')
    p.add_argument('--text_temp', type=float, default=None)
    p.add_argument('--waveform_temp', type=float, default=None)
    p.add_argument('--output_channel', type=str, default=None)
    p.add_argument('--script_mode', type=str, default=None)
    p.add_argument('--workflow', action='store_true')
    p.add_argument('--share', action='store_true')
    p.add_argument('--custom_model', type=str, default=None)
    p.add_argument('--custom_model_dir', type=str, default=None)
    p.add_argument('--ebook', type=str, default=None)

    # refused, but declared so the refusal names them
    p.add_argument('--ebooks_dir', type=str, default=None)
    p.add_argument('--skip_assembly', action='store_true')
    p.add_argument('--sentence_per_paragraph', action='store_true')
    p.add_argument('--skip_headings', action='store_true')
    p.add_argument('--bilingual', action='store_true')
    p.add_argument('--bilingual_pause', type=float, default=None)
    p.add_argument('--bilingual_gap', type=float, default=None)
    return p


def refuse_present_refusals(argv: list[str]) -> None:
    """Refuse every REFUSE flag that actually appears on the command line.

    Presence is decided from argv, not from the parsed values, so a flag whose
    e2a default happens to be truthy (`--bilingual_pause 0.3`) is only refused
    when the caller passed it.
    """
    seen = {a.split('=', 1)[0] for a in argv if a.startswith('--')}
    for flag in sorted(seen):
        verdict, _ = flagdef.FLAGS.get(flag, (None, None))
        if verdict == flagdef.REFUSE:
            flagdef.refuse_flag(flag)


def _print_app_result(result: dict) -> int:
    """The `app.py` door's result shape: `json.dumps(result, indent=2)`
    (`handlers.py:33/44/117/138`), exit `0 if result.get('success', True) else 1`
    (`app.py:278`). Used for `--list_sessions` and `--resume_session`, which are
    the routes a bridge spawns through `app.py`."""
    print(json.dumps(result, indent=2), flush=True)
    return 0 if result.get('success', True) else 1


def _print_worker_result(result: dict) -> int:
    """The WORKER's result shape: ONE compact line, `json.dumps(result)`
    (`worker.py:518`), exit `0 if result.get('success') else 1` (`worker.py:521`).

    THE SHAPE IS THE CONTRACT, not a formatting choice.
    `parallel-tts-bridge.ts:3747` scans the worker's stdout line by line for
    `t.startsWith('{') && t.includes('"success"')` and `JSON.parse`s that line.
    A pretty-printed object has no such line, so the bridge would find no result
    and fall to its degraded branch (`:3756-3768`) - marking EVERY index failed
    and reporting the stderr tail as the error, on a run that succeeded.

    Note the exit rule differs from the app door's: `worker.py` uses
    `result.get('success')`, with no default, so a result dict that somehow lacks
    the key exits 1. `handlers.py`'s `.get('success', True)` defaults the other
    way. Both are preserved as written.
    """
    print(json.dumps(result), flush=True)
    return 0 if result.get('success') else 1


# =============================================================================
# The routes
# =============================================================================

def route_list_sessions(args) -> int:
    """`--list_sessions`. e2a handlers.py:31-34.

    e2a printed `json.dumps(sessions, indent=2)`; so does this. NOTE that
    `parallel-tts-bridge.ts:8906-8909` calls it "human-readable output (not
    JSON)", discards the stdout entirely and resolves `[]` - so nothing today
    consumes the format either way. Preserved as e2a writes it.
    """
    from ..render import session_store

    sessions = session_store.list_resumable_sessions()
    print(json.dumps(sessions, indent=2), flush=True)
    return 0


def route_resume_session(args) -> int:
    """`--resume_session <path|uuid>`. e2a handlers.py:37-45."""
    from ..render import session_store

    try:
        result = session_store.resume_session(
            args.resume_session, voice=args.voice, tts_engine=args.tts_engine)
    except Exception as e:
        import traceback
        traceback.print_exc()
        result = {'success': False, 'error': str(e)}
    return _print_app_result(result)


def route_worker(args, argv: list[str], engine_factory=None) -> int:
    """`--worker_mode`, and `worker.py`'s bare invocation. e2a handlers.py:79-118.

    Also the retake route: a `--sentence_indices` run is the same call with an
    explicit index set, which is exactly how e2a's `worker.py` did it.
    """
    from ..render import retake
    from ..render.worker import WorkerRequest, run_worker, build_engine

    if not args.session:
        print('Error: --worker_mode requires --session', flush=True)
        return _print_worker_result({'success': False,
                                     'error': '--worker_mode requires --session'})

    sentence_indices = retake.parse_sentence_indices(args.sentence_indices)
    take_temperatures = retake.parse_take_temperatures(args.take_temperatures)
    sentence_overrides = retake.parse_sentence_overrides(args.sentence_overrides)
    num_takes = retake.effective_num_takes(args.num_takes, take_temperatures)

    # e2a's mode validation, from BOTH parsers: a discrete index set counts as
    # sentence mode (worker.py:468), and the two modes are exclusive (worker.py:475).
    sentence_mode = ((args.sentence_start is not None and args.sentence_end is not None)
                     or sentence_indices is not None)
    chapter_mode = args.chapter_start is not None and args.chapter_end is not None
    if not sentence_mode and not chapter_mode:
        message = ('--worker_mode requires --sentence_start/--sentence_end, '
                   '--sentence_indices, or --chapter_start/--chapter_end')
        print(f'Error: {message}', flush=True)
        return _print_worker_result({'success': False, 'error': message})
    if sentence_mode and chapter_mode:
        message = 'Cannot specify both sentence and chapter modes'
        print(f'Error: {message}', flush=True)
        return _print_worker_result({'success': False, 'error': message})

    request = WorkerRequest(
        session_id=args.session,
        session_dir=args.session_dir,
        sentence_start=args.sentence_start,
        sentence_end=args.sentence_end,
        chapter_start=args.chapter_start,
        chapter_end=args.chapter_end,
        sentence_indices=sentence_indices,
        sentence_overrides=sentence_overrides,
        num_takes=num_takes,
        take_temperatures=take_temperatures,
        sentences_dir=args.sentences_dir,
        tts_engine=args.tts_engine,
        fine_tuned=args.fine_tuned,
        voice=args.voice,
        device=args.device,
        output_dir=args.output_dir,
        output_format=args.output_format,
        orpheus_model_dir=args.orpheus_model_dir,
        orpheus_adapter_dir=args.orpheus_adapter_dir,
        orpheus_base_dir=args.orpheus_base_dir,
    )

    factory = engine_factory if engine_factory is not None else build_engine
    if sentence_indices is not None:
        result = retake.run_retake(request, engine_factory=factory)
    else:
        result = run_worker(request, engine_factory=factory)
    return _print_worker_result(result)


def route_assemble(args) -> int:
    """`--assemble_only`. e2a handlers.py:121-139.

    `assemble()` prints its own `{"success": true, ...}` block with `indent=2`,
    exactly as e2a's handlers did, so nothing is printed twice here.
    """
    from ..assemble import assemble
    from ..render.session_v1 import build_manifest

    if not args.session:
        print('Error: --assemble_only requires --session', flush=True)
        return _print_app_result({'success': False,
                                 'error': '--assemble_only requires --session'})
    if not args.session_dir:
        print('Error: --assemble_only requires --session_dir', flush=True)
        return _print_app_result({
            'success': False,
            'error': '--assemble_only requires --session_dir. e2a derived it '
                     'from its own tmp_dir; narrator will not guess a session '
                     'location.'})
    if not args.output_dir:
        print('Error: --assemble_only requires --output_dir', flush=True)
        return _print_app_result({'success': False,
                                 'error': '--assemble_only requires --output_dir'})

    # e2a's `assemble_audiobook` wraps its whole body in
    # `except Exception -> {'success': False, 'error': str(e)}` after printing the
    # traceback (session.py:1310-1314), and `handlers.py:138` prints that dict.
    # So a failed assembly reaches the bridge as a RESULT, never as a bare
    # traceback; reproduced here because `reassembly-bridge.ts` reads the same
    # stdout.
    try:
        manifest = build_manifest(args.session_dir, args.sentences_dir, args.chapters)
        kwargs = {}
        if args.output_format:
            kwargs['output_format'] = args.output_format
        assemble(
            manifest,
            args.output_dir,
            encoded_chapters_dir=args.encoded_chapters_dir,
            post_render_filter=args.post_render_filter,
            **kwargs,
        )
    except Exception as e:
        print(f'assemble_audiobook() Exception: {e}', flush=True)
        import traceback
        traceback.print_exc()
        return _print_app_result({'success': False, 'error': str(e)})
    return 0


# =============================================================================
# Entry
# =============================================================================

def dispatch(args, argv: list[str], engine_factory=None) -> int:
    """handlers.dispatch's order, unchanged: list -> resume -> prep -> worker ->
    assemble.

    `--tts_engine` IS ONLY CHECKED ON THE WORKER ROUTE. On assembly it is
    engine-agnostic scaffolding: e2a needs a session to name SOME engine to set
    itself up and then never consults it, and BookForge exploits that - BOTH live
    assembly spawns pass the literal `'xtts'` on an Orpheus book
    (`reassembly-bridge.ts:1517`; `parallel-tts-bridge.ts:5164`, where
    `asmEngineArg = assembleOrpheusNative ? 'xtts' : settings.ttsEngine` says so
    outright, because native assembly runs in the generic bundled env). CLAUDE.md
    documents the same trick. Checking the engine before routing therefore
    refused every real assembly. `--list_sessions` and `--resume_session` read
    the filesystem and never load a model, so they are not gated either.

    The refusal that matters is not lost: `render/worker.py` refuses a SESSION
    whose `tts_engine` is not `orpheus`, which is the value that decides what is
    actually rendered.
    """
    if args.list_sessions:
        return route_list_sessions(args)
    if args.resume_session:
        return route_resume_session(args)
    if args.prep_only:
        flagdef.refuse_flag('--prep_only')
    if args.worker_mode or args.sentence_indices is not None:
        flagdef.check_engine(args.tts_engine)
        return route_worker(args, argv, engine_factory=engine_factory)
    if args.assemble_only:
        return route_assemble(args)

    accepted = ', '.join(flagdef.accepted_flags())
    raise FlagRefused(
        'no mode selected. narrator.compat.app needs one of --worker_mode, '
        '--assemble_only, --list_sessions or --resume_session. Accepted flags: '
        f'{accepted}')


def main(argv: list[str] | None = None, engine_factory=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # e2a rejected unknown options BEFORE argparse (app.py:226-230) so a typo
    # names itself instead of being swallowed; so does narrator.
    flagdef.reject_unknown(argv)
    refuse_present_refusals(argv)

    args = build_parser().parse_args(argv)
    try:
        return dispatch(args, argv, engine_factory=engine_factory)
    except RetakeArgumentError as bad:
        # e2a's `worker.py:437/441/450/453/465` prints `Error: <message>` and
        # `sys.exit(1)` for each of these; the message texts are carried on the
        # exception verbatim, so this reproduces all five lines. Without the
        # catch a mistyped `--sentence_indices` reached the caller as a Python
        # traceback, which e2a never produced.
        print(f'Error: {bad}', flush=True)
        return 1


def run() -> int:
    """The process entry: arms the cooperative stop and the orphan watchdog
    BEFORE the heavy imports, exactly as e2a's `worker.py:main` did, so a TERM
    during a model load still releases the GPU."""
    from ..render.worker import install_signal_handlers, start_parent_watch

    install_signal_handlers()
    start_parent_watch()
    try:
        return main()
    except FlagRefused as refused:
        return int(refused.code or 1)


if __name__ == '__main__':
    sys.exit(run())
