"""python -m narrator <subcommand>

    prep       parse an EPUB into a prepared session (session layout v1)
    manifest   build a schema-v1 manifest from an e2a session directory
    render     render a sentence range of a session into <i>.flac
    retake     re-render named sentences, N takes each, in one model load
    sessions   list resumable sessions, or report one session's progress
    assemble   assemble that session into one m4b + one VTT
    serve      run the resident Orpheus streaming worker

The render/retake/sessions subcommands are THIN: they parse dashes-and-words
into the same `render.worker.WorkerRequest` / `render.session_store` calls
`compat/app.py` builds from ebook2audiobook's underscore flags, so the two doors
cannot diverge. `compat/FLAGS.md` maps one to the other.
"""

from __future__ import annotations

import argparse
import os
import sys

from . import __version__
# e2a's prep defaults have exactly one home in narrator - `text/lang.py`, copied
# from `lib/conf.py` and `lib/conf_models.py`. Imported here so `--help` prints
# the same value the code uses. Pure stdlib, so `--help` pays nothing for it.
from .text.lang import default_language_code, default_output_format
from .text.normalize import ORPHEUS


def _add_session_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--session-dir",
        required=True,
        metavar="DIR",
        help="the session's HASH directory "
             "(<project>/stages/03-tts/sessions/<lang>/ebook-<uuid>/<hash>/)",
    )
    p.add_argument(
        "--sentences-dir",
        metavar="DIR",
        help="override the sentence-audio source only (chapters/sentences-denoised, "
             "chapters/sentences-rvc-<voice>, or a gap-normalized set). The chapter "
             "mapping, the metadata and the cue text still come from the session state.",
    )
    p.add_argument(
        "--chapters",
        metavar="SPEC",
        help="which chapters to cover: absent = the whole book, 'auto' = the chapters "
             "whose audio is complete, or a selection like '1-3'. A selection must be a "
             "contiguous run from chapter 1.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="narrator",
        description="BookForge's audiobook render pipeline.",
    )
    parser.add_argument("--version", action="version", version=f"narrator {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_manifest = sub.add_parser(
        "manifest", help="build a render manifest from an e2a session directory"
    )
    _add_session_args(p_manifest)
    p_manifest.add_argument(
        "--out", required=True, metavar="FILE", help="where to write manifest.json"
    )

    p_assemble = sub.add_parser(
        "assemble", help="assemble a session into one m4b and one VTT"
    )
    _add_session_args(p_assemble)
    p_assemble.add_argument("--output-dir", required=True, metavar="DIR")
    p_assemble.add_argument(
        "--encoded-chapters-dir",
        metavar="DIR",
        help="<chapterNum>.m4a files BookForge encoded during the render",
    )
    p_assemble.add_argument(
        "--workers", type=int, metavar="N",
        help="parallel chapter encoders (default: min(cpu_count, 16))",
    )
    p_assemble.add_argument("--ffmpeg", metavar="PATH")
    p_assemble.add_argument("--ffprobe", metavar="PATH")
    p_assemble.add_argument(
        "--post-render-filter", metavar="CHAIN",
        help="per-voice ffmpeg filter chain applied at the final encode",
    )
    p_assemble.add_argument(
        "--manifest-out", metavar="FILE",
        help="also write the manifest that was assembled from",
    )

    # ---- render / retake / sessions ---------------------------------------
    #
    # `--session-dir` here is the SAME argument the assembler takes (the hash
    # dir, or the ebook-<uuid> dir above it - session_store resolves either), so
    # a session named once can be rendered and assembled with the same string.

    def _add_voice_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--session-dir", required=True, metavar="DIR")
        p.add_argument(
            "--session", metavar="ID",
            help="the session id, echoed into the result JSON (default: the "
                 "session_id in session-state.json)",
        )
        p.add_argument(
            "--sentences-dir", metavar="DIR",
            help="where <i>.flac is written and skip-checked. Default: the "
                 "state's chapters_dir_sentences, else <session>/chapters/sentences",
        )
        p.add_argument("--fine-tuned", metavar="VOICE", help="the Orpheus voice token")
        p.add_argument("--orpheus-model-dir", metavar="DIR", help="a merged fine-tune")
        p.add_argument("--orpheus-adapter-dir", metavar="DIR", help="a LoRA voice adapter")
        p.add_argument("--orpheus-base-dir", metavar="DIR", help="the adapter's base model")
        p.add_argument("--device", metavar="NAME", help="reported in the log only")

    p_render = sub.add_parser(
        "render", help="render a sentence range into <i>.flac"
    )
    _add_voice_args(p_render)
    p_render.add_argument("--sentence-start", type=int, metavar="N")
    p_render.add_argument("--sentence-end", type=int, metavar="N")
    p_render.add_argument("--chapter-start", type=int, metavar="N")
    p_render.add_argument("--chapter-end", type=int, metavar="N")

    p_retake = sub.add_parser(
        "retake",
        help="re-render named sentences, N takes each, into take<k>/ subdirs",
    )
    _add_voice_args(p_retake)
    p_retake.add_argument(
        "--indices", required=True, metavar="LIST",
        help="comma-separated global 0-based sentence indices",
    )
    p_retake.add_argument("--num-takes", type=int, default=1, metavar="N")
    p_retake.add_argument(
        "--take-temperatures", metavar="LIST",
        help="comma-separated per-take temperatures; the count sets --num-takes",
    )
    p_retake.add_argument(
        "--overrides", metavar="FILE",
        help="JSON file mapping sentence index -> replacement text",
    )

    p_prep = sub.add_parser(
        "prep",
        help="parse an EPUB into a prepared session (session-state.json + "
             "chapter-provenance.json)",
        description="Migration step 4: the port of ebook2audiobook's "
                    "--prep_only. Writes the session layout v1 that render and "
                    "assemble read.",
    )
    p_prep.add_argument("--ebook", required=True, metavar="FILE",
                        help="the EPUB. Anything else is refused by name.")
    p_prep.add_argument(
        "--session-dir", metavar="DIR",
        help="the ebook-<uuid> directory to prepare into. Default: "
             "$E2A_TMP_DIR/ebook-<session id>, which is where "
             "parallel-tts-bridge.ts looks for it.",
    )
    p_prep.add_argument("--session", metavar="ID",
                        help="the session id (default: a fresh uuid4)")
    p_prep.add_argument("--language", default=default_language_code,
                        metavar="CODE",
                        help="ISO-639-1 or -3. Orpheus is English-only. "
                             f"(default: {default_language_code})")
    p_prep.add_argument("--fine-tuned", metavar="VOICE",
                        help="the Orpheus voice token, recorded into the state")
    p_prep.add_argument("--voice", metavar="NAME",
                        help="recorded into the state; the XTTS reference-clip "
                             "path, unread by Orpheus")
    p_prep.add_argument("--orpheus-model-dir", metavar="DIR")
    p_prep.add_argument("--orpheus-adapter-dir", metavar="DIR")
    p_prep.add_argument("--orpheus-base-dir", metavar="DIR")
    p_prep.add_argument("--device", metavar="NAME",
                        help="recorded into the state; prep itself is CPU work")
    p_prep.add_argument("--output-format", default=default_output_format,
                        metavar="EXT",
                        help="the container final_name is built with "
                             f"(default: {default_output_format})")
    p_prep.add_argument("--output-dir", metavar="DIR",
                        help="recorded into the state as audiobooks_dir")
    p_prep.add_argument(
        "--sentence-per-paragraph", action="store_true",
        help="one chunk per paragraph: the packer is skipped entirely",
    )
    p_prep.add_argument(
        "--skip-headings", action="store_true",
        help="do not voice the text of h1-h6 headings (they are still parsed "
             "for chapter detection). A TOC-matched title recovered from body "
             "text is NOT suppressed, and never was.",
    )

    p_sessions = sub.add_parser(
        "sessions", help="list resumable sessions, or report one session's progress"
    )
    p_sessions.add_argument(
        "--root", metavar="DIR",
        help="the sessions root to walk (default: $E2A_TMP_DIR)",
    )
    p_sessions.add_argument(
        "--session-dir", metavar="DIR",
        help="report on ONE session instead of listing; prints e2a's "
             "--resume_session payload",
    )

    # The streaming worker takes NO arguments: its whole interface is the
    # JSON-lines protocol on stdin/stdout plus the ORPHEUS_* env the pool exports
    # at spawn (see narrator/serve/__main__.py). There is nothing to re-declare
    # here, and declaring anything would be a second copy of a contract the
    # bridges already speak. `python -m narrator.serve` remains the direct entry
    # point; this is the same thing under the one CLI.
    sub.add_parser(
        "serve",
        help="run the resident Orpheus streaming worker (stdin/stdout JSON lines)",
        description="Reads its configuration from ORPHEUS_* environment "
                    "variables and its work from stdin. Takes no arguments.",
    )
    return parser


def _run_render(args) -> int:
    """`narrator render` / `narrator retake`.

    Both build ONE `WorkerRequest` and hand it to the same loop; `retake` differs
    only in that it names indices instead of a range, and in the take fan-out.
    The result is printed as `json.dumps(..., indent=2)` - the same payload
    `compat/app.py` prints, so a script can read either door.
    """
    import json

    from .render import retake as retake_mod
    from .render import session_store
    from .render.worker import (
        WorkerRequest,
        install_signal_handlers,
        run_worker,
        start_parent_watch,
    )

    install_signal_handlers()
    start_parent_watch()

    process_dir = session_store.resolve_process_dir(args.session_dir)
    state = session_store.load_state_from_process_dir(process_dir)
    session_id = args.session or state["session_id"]

    is_retake = args.command == "retake"
    try:
        indices = retake_mod.parse_sentence_indices(args.indices) if is_retake else None
        temps = (retake_mod.parse_take_temperatures(args.take_temperatures)
                 if is_retake else None)
        overrides = (retake_mod.parse_sentence_overrides(args.overrides)
                     if is_retake else None)
    except retake_mod.RetakeArgumentError as bad:
        # e2a prints `Error: <message>` and exits 1 for each of these
        # (worker.py:437-465); a traceback is not something it ever produced.
        print(f"Error: {bad}", flush=True)
        return 1
    num_takes = retake_mod.effective_num_takes(
        args.num_takes if is_retake else 1, temps)

    request = WorkerRequest(
        session_id=session_id,
        session_dir=args.session_dir,
        sentence_start=None if is_retake else args.sentence_start,
        sentence_end=None if is_retake else args.sentence_end,
        chapter_start=None if is_retake else args.chapter_start,
        chapter_end=None if is_retake else args.chapter_end,
        sentence_indices=indices,
        sentence_overrides=overrides,
        num_takes=num_takes,
        take_temperatures=temps,
        sentences_dir=args.sentences_dir,
        tts_engine=state.get("tts_engine"),
        fine_tuned=args.fine_tuned,
        device=args.device,
        orpheus_model_dir=args.orpheus_model_dir,
        orpheus_adapter_dir=args.orpheus_adapter_dir,
        orpheus_base_dir=args.orpheus_base_dir,
    )

    if is_retake:
        result = retake_mod.run_retake(request)
    else:
        if request.sentence_start is None and request.chapter_start is None:
            raise SystemExit(
                "narrator render needs --sentence-start/--sentence-end or "
                "--chapter-start/--chapter-end")
        result = run_worker(request)

    print(json.dumps(result, indent=2), flush=True)
    return 0 if result.get("success") else 1


def _run_sessions(args) -> int:
    """`narrator sessions`. Lists, or reports on one session."""
    import json

    from .render import session_store

    if args.session_dir:
        result = session_store.resume_session(args.session_dir, root=args.root)
        print(json.dumps(result, indent=2), flush=True)
        return 0 if result.get("success") else 1

    sessions = session_store.list_resumable_sessions(args.root)
    print(json.dumps(sessions, indent=2), flush=True)
    return 0


def _run_prep(args) -> int:
    """`narrator prep`. The same call `compat/app.py --prep_only` makes.

    Prints e2a's result JSON (`json.dumps(result, indent=2, default=str)`) and
    THEN a one-line human summary, in that order: the JSON first so a script can
    pipe it, the summary last so a person reading a terminal sees the chunk count
    after the 40,000 characters of JSON rather than scrolled off above them.
    """
    import json
    import uuid

    from .render import session_store
    from .text.prep import PrepOptions, prep_session

    session_id = args.session or str(uuid.uuid4())
    if args.session_dir:
        session_dir = os.path.abspath(args.session_dir)
    else:
        session_dir = os.path.join(session_store.sessions_root(),
                                   f"ebook-{session_id}")

    # `PrepOptions` carries e2a's defaults, which live in ONE place
    # (`text/lang.py`, pinned to conf.py/conf_models.py). A flag that was not
    # given is not passed on, so no default is re-spelled here.
    optional = {}
    if args.fine_tuned:
        optional["fine_tuned"] = args.fine_tuned

    outcome = prep_session(
        args.ebook,
        session_dir,
        PrepOptions(
            session=session_id,
            language=args.language,
            tts_engine=ORPHEUS,
            voice=args.voice,
            device=args.device,
            output_format=args.output_format,
            audiobooks_dir=(os.path.abspath(args.output_dir)
                            if args.output_dir else None),
            orpheus_model_dir=args.orpheus_model_dir,
            orpheus_adapter_dir=args.orpheus_adapter_dir,
            orpheus_base_dir=args.orpheus_base_dir,
            sentence_per_paragraph=args.sentence_per_paragraph,
            skip_headings=args.skip_headings,
            **optional,
        ),
    )
    print(json.dumps(outcome.result, indent=2, default=str), flush=True)
    print(
        f"[prep] {outcome.result['total_chapters']} chapter(s), "
        f"{outcome.result['total_sentences']} chunk(s), "
        f"{outcome.result['total_raw_sentences']} sentence(s) -> "
        f"{outcome.state_path}",
        flush=True,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "prep":
        return _run_prep(args)

    if args.command == "serve":
        # Imported here, not at module scope: the worker pulls in torch/vLLM (or
        # mlx), and `narrator assemble` must stay runnable on a machine with
        # neither.
        from .serve.worker import main as serve_main

        return serve_main()

    if args.command in ("render", "retake"):
        return _run_render(args)

    if args.command == "sessions":
        return _run_sessions(args)

    # Imported here so `--help` and `--version` do not pay for them.
    from .render.session_v1 import build_manifest

    manifest = build_manifest(args.session_dir, args.sentences_dir, args.chapters)

    if args.command == "manifest":
        from .manifest import save

        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        save(manifest, out)
        print(
            f"[manifest] {len(manifest.chapters)} chapter(s), "
            f"{sum(len(c.chunks) for c in manifest.chapters)} chunk(s) -> {out}",
            flush=True,
        )
        return 0

    from .assemble import assemble

    if args.manifest_out:
        from .manifest import save

        out = os.path.abspath(args.manifest_out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        save(manifest, out)

    result = assemble(
        manifest,
        args.output_dir,
        ffmpeg=args.ffmpeg,
        ffprobe=args.ffprobe,
        encoded_chapters_dir=args.encoded_chapters_dir,
        workers=args.workers,
        post_render_filter=args.post_render_filter,
    )
    print(
        f"[assemble] {result.chapter_count} chapter(s), {result.duration_s:.2f}s -> "
        f"{result.m4b_path}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
