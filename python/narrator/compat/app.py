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
    # NARRATOR'S OWN, not e2a's: the coverage report `narrator align --report`
    # wrote. An engine guarded by post-render forced alignment (Higgs v3)
    # REFUSES to assemble without one, and this door had no way to supply it -
    # so a v3 book through --assemble_only would have read as "assembly is
    # broken" rather than "run align first" (review finding 4). Absent is
    # correct for Orpheus, whose policy is not enforced and for which the gate
    # is a no-op. See compat/FLAGS.md.
    p.add_argument('--coverage_report', type=str, default=None)

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
    p.add_argument('--higgs_voice', type=str, default=None)
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


def route_prep(args) -> int:
    """`--prep_only`. e2a handlers.py:47-76.

    e2a's branch does four things before calling prep, and all four are here:

      1. refuse without `--ebook`, printing `Error: --prep_only requires --ebook`
         and returning `{'success': False, 'error': ...}`;
      2. `args['ebook'] = os.path.abspath(args['ebook'])` - the ABSPATH is what
         the process-dir md5 is taken over, so it is load-bearing, not tidiness;
      3. `audiobooks_dir = abspath(--output_dir) or audiobooks_cli_dir`;
      4. normalize `--device` through e2a's devices table.

    WHERE THE SESSION GOES. e2a put it at `<tmp_dir>/ebook-<session_id>` with
    `tmp_dir = $NARRATOR_SESSIONS_ROOT`, and `parallel-tts-bridge.ts:3178-3183` COMPUTES THE
    SAME PATH ITSELF and then reads `session-state.json` out of it - it never
    parses this command's stdout (`:3394-3435`; it even skips logging any line
    starting with `{`, `:3305`). So the placement is the contract, not the
    output. narrator honours `--session_dir` when a caller passes one and
    otherwise derives the identical path from `session_store.sessions_root()`.

    AT CUT-OVER THE PREP SPAWN MUST PASS `--session_dir`, and there is no second
    option: for a WSL prep the bridge derives the session dir from the WSL e2a
    ROOT (`${wslE2aPath}/tmp/ebook-<id>`, `:3180`) while `NARRATOR_SESSIONS_ROOT` holds a
    WINDOWS path, so forwarding that variable into the guest would point prep at
    a path that does not exist there. See `compat/FLAGS.md`, "The prep route".

    OUTPUT SHAPE, and the ONE thing that is not e2a's. `handlers.py:70` prints
    `json.dumps(result, indent=2, default=str)` on success and
    `json.dumps(error_result)` - COMPACT, no indent - on failure, and both are
    reproduced. But narrator's OWN named refusals - `UnsupportedInput` (a
    non-EPUB `--ebook`) and `UnsupportedEngine` (anything but Orpheus) - do NOT
    take that shape: they print `Error: <message>` and exit 1, like every other
    narrator refusal, because their message IS the answer and burying it under
    `prep_ebook_info failed` would tell an operator nothing. e2a had neither
    refusal to express. Everything else - a broken EPUB, a missing sessions
    root, a chapter that would not extract - keeps e2a's failure dict.
    """
    import os
    import uuid

    from ..render import session_store
    from ..text.epub import UnsupportedInput
    from ..text.normalize import UnsupportedEngine
    from ..text.prep import PrepOptions, prep_session

    if not args.ebook:
        # e2a prints THIS LINE AND NOTHING ELSE here: `handlers.py:50-51` prints
        # the error and returns the dict, and `app.py:277` only reads its
        # `success` key to pick the exit code. No JSON is emitted on this path.
        print('Error: --prep_only requires --ebook', flush=True)
        return 1

    # The engine is decided ONCE, at the door, and by name - the same call the
    # worker route makes, so both refuse an unknown engine identically and a
    # flag/env disagreement is caught before a book is read.
    engine_id = flagdef.resolve_engine(args.tts_engine)
    if engine_id != 'higgs-v3' and args.higgs_voice:
        raise FlagRefused(
            f'--higgs_voice names a Higgs voice but --tts_engine is '
            f'{args.tts_engine or "(unset)"}. An Orpheus voice arrives in '
            f'--fine_tuned; the two are not interchangeable.')

    ebook = os.path.abspath(args.ebook)
    session_id = args.session or str(uuid.uuid4())

    # e2a's four defaults live in ONE place - `text/lang.py`, pinned to
    # `conf.py`/`conf_models.py` - and `PrepOptions` already carries them, so a
    # flag that was not passed is simply not passed on. Re-spelling 'eng' /
    # 'orpheus' / 'internal' / 'm4b' here would be a second copy to drift.
    optional = {}
    if args.language:
        optional['language'] = args.language
    if args.tts_engine:
        optional['tts_engine'] = args.tts_engine
    # Higgs preps by paragraph, because the ported e2a packer is Orpheus-only.
    # Set HERE rather than defaulted in PrepOptions so an Orpheus prep keeps the
    # parity policy and a Higgs prep cannot silently get it.
    if engine_id == 'higgs-v3':
        optional['chunking'] = 'paragraph'
        # THE VOICE'S OWN CAP, from the document BookForge wrote for this job.
        # Without it prep reached for Orpheus's env budget and packed at 350
        # (measured 2026-09-05: 1067 chunks of ~220 chars against a 900/1200
        # certificate). Refuses by name with no --higgs_voice or with a
        # fine-tune that declares no maxChars.
        from ..engine.higgs.v3_engine import higgs_v3_prep_budget
        try:
            optional['budget'] = higgs_v3_prep_budget(args.higgs_voice)
        except ValueError as refused:
            # narrator's own named refusal - the same shape as UnsupportedInput
            # below: the message IS the answer.
            print(f'Error: {refused}', flush=True)
            return 1
        # THE MERGE FLOOR: the trainer's targetChars when the voice declares
        # one, else the cap (Owen, 2026-09-05: "combine paragraphs to reach
        # closer to the cap of 1200 ... shoot for 3 paragraphs per chunk", then
        # "a per-model target chunk size configuration that's set by the model
        # trainer after it trains it"). Consecutive short prose paragraphs
        # travel together until the next would overflow the cap; walls stay
        # walls; a paragraph already at the floor stands alone.
        from ..engine.higgs.v3_engine import higgs_v3_prep_floor
        optional['chunking_floor_chars'] = higgs_v3_prep_floor(
            args.higgs_voice, optional['budget'].max_chars(args.higgs_voice))
    if args.fine_tuned:
        optional['fine_tuned'] = args.fine_tuned
    if args.output_format:
        optional['output_format'] = args.output_format

    options = PrepOptions(
        session=session_id,
        voice=args.voice,
        device=args.device,
        audiobooks_dir=os.path.abspath(args.output_dir) if args.output_dir else None,
        custom_model=args.custom_model,
        custom_model_dir=args.custom_model_dir,
        higgs_voice=args.higgs_voice,
        orpheus_model_dir=args.orpheus_model_dir,
        orpheus_adapter_dir=args.orpheus_adapter_dir,
        orpheus_base_dir=args.orpheus_base_dir,
        sentence_per_paragraph=args.sentence_per_paragraph,
        skip_headings=args.skip_headings,
        **optional,
    )

    try:
        # INSIDE the try. `sessions_root()` raises when `NARRATOR_SESSIONS_ROOT` is unset
        # and no `--session_dir` was passed - which is precisely the cut-over
        # case above - and raising it outside sent a bare traceback to a caller
        # that e2a would have answered with a result dict.
        if args.session_dir:
            session_dir = os.path.abspath(args.session_dir)
        else:
            session_dir = os.path.join(session_store.sessions_root(),
                                       f'ebook-{session_id}')
        outcome = prep_session(ebook, session_dir, options)
    except (UnsupportedInput, UnsupportedEngine) as refused:
        # narrator's own named refusals - see OUTPUT SHAPE above.
        print(f'Error: {refused}', flush=True)
        return 1
    except Exception as e:
        # e2a wrapped the whole of prep_ebook_info in
        # `except Exception -> print + traceback -> return None`, and handlers
        # turned that None into this exact dict. Reproduced, so a bridge sees a
        # result rather than a bare traceback - and the traceback still reaches
        # stderr for the log.
        print(f'prep_ebook_info() Exception: {e}', flush=True)
        import traceback
        traceback.print_exc()
        print(json.dumps({'success': False, 'error': 'prep_ebook_info failed'}),
              flush=True)
        return 1

    print(json.dumps(outcome.result, indent=2, default=str), flush=True)
    return 0


def _check_engine_and_voice_agree(engine_id, args) -> None:
    """A Higgs voice belongs to a Higgs engine, and only to one.

    RESOLVED 2026-09-04: this used to REFUSE `--tts_engine higgs-v3` on the
    render route entirely, because `render/worker.py`'s `WorkerRequest` had no
    `higgs_voice` field and its config was built for Orpheus unconditionally.
    Both are fixed - the request carries the field and `build_engine_for(id)`
    asks `engine/registry.py` for the class - so the render route now accepts
    higgs-v3 and the only check left is the one below.

    `--fine_tuned` is an Orpheus TOKEN and `--higgs_voice` is a CATALOG ID, so
    handing one where the other is expected resolves to the wrong voice for a
    whole book. Refused by name rather than ignored.
    """
    if engine_id != 'higgs-v3' and args.higgs_voice:
        raise FlagRefused(
            f'--higgs_voice names a Higgs voice but --tts_engine is '
            f'{args.tts_engine or "(unset)"}. An Orpheus voice arrives in '
            f'--fine_tuned; the two are not interchangeable.')


def route_worker(args, argv: list[str], engine_factory=None) -> int:
    """`--worker_mode`, and `worker.py`'s bare invocation. e2a handlers.py:79-118.

    Also the retake route: a `--sentence_indices` run is the same call with an
    explicit index set, which is exactly how e2a's `worker.py` did it.
    """
    from ..render import retake
    from ..render.worker import WorkerRequest, run_worker

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
        # A CATALOG ID, not a prompt token - see WorkerRequest.higgs_voice. The
        # engine/voice mismatch was already refused by name at the door.
        higgs_voice=args.higgs_voice,
    )

    # None means "the loop picks, from the session's engine id" - see
    # render/worker.build_engine_for. A test passes its own one-arg fake.
    factory = engine_factory
    if sentence_indices is not None:
        result = retake.run_retake(request, engine_factory=factory)
    else:
        result = run_worker(request, engine_factory=factory)
    return _print_worker_result(result)


def route_assemble(args) -> int:
    """`--assemble_only`. e2a handlers.py:121-139.

    `assemble()` prints its own `{"success": true, ...}` block with `indent=2`,
    exactly as e2a's handlers did, so nothing is printed twice here.

    `--coverage_report` is narrator's addition and reaches `assemble()`
    unchanged. For Orpheus it is a no-op whether given or not; for an engine
    guarded by forced alignment it is how the guard is satisfied, and its
    absence is a refusal that says so. A `CoverageRefusal` comes out of the
    `except Exception` below as a RESULT the bridge can read, exactly like every
    other assembly failure - never as a bare traceback.
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
            coverage_report=args.coverage_report,
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

    The refusal that matters is not lost: `render/worker.py` resolves the
    SESSION's engine through `engine/registry.py` and refuses an id the registry
    does not know, naming the ones it does - and that is the value that decides
    what is actually rendered.
    """
    if args.list_sessions:
        return route_list_sessions(args)
    if args.resume_session:
        return route_resume_session(args)
    if args.prep_only:
        return route_prep(args)
    if args.worker_mode or args.sentence_indices is not None:
        engine_id = flagdef.resolve_engine(args.tts_engine)
        _check_engine_and_voice_agree(engine_id, args)
        return route_worker(args, argv, engine_factory=engine_factory)
    if args.assemble_only:
        return route_assemble(args)

    accepted = ', '.join(flagdef.accepted_flags())
    raise FlagRefused(
        'no mode selected. narrator.compat.app needs one of --prep_only, '
        '--worker_mode, --assemble_only, --list_sessions or --resume_session. '
        'Accepted flags: '
        f'{accepted}')


def main(argv: list[str] | None = None, engine_factory=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # BEFORE anything else, including the flag parse: a stale `NARRATOR_SESSIONS_ROOT` is
    # refused by name on EVERY door, not only on the two that read the sessions
    # root. A door that carries `--session_dir` would never reach
    # `sessions_root()`, so it would have rendered happily while the machine's
    # environment still said e2a - which is exactly the "keeps working by
    # accident" the rename exists to prevent.
    #
    # Reported as `Error: <message>` + exit 1, the shape every other named
    # refusal in this file uses, rather than as a traceback.
    from ..render import session_store as _session_store
    from ..render.session_store import SessionStateError as _SessionStateError
    try:
        _session_store.refuse_legacy_sessions_root_env()
    except _SessionStateError as refused:
        print(f'Error: {refused}', flush=True)
        return 1

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
