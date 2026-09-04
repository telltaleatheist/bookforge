"""python -m narrator <subcommand>

    manifest   build a schema-v1 manifest from an e2a session directory
    assemble   assemble that session into one m4b + one VTT
    serve      run the resident Orpheus streaming worker
"""

from __future__ import annotations

import argparse
import os
import sys

from . import __version__


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


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "serve":
        # Imported here, not at module scope: the worker pulls in torch/vLLM (or
        # mlx), and `narrator assemble` must stay runnable on a machine with
        # neither.
        from .serve.worker import main as serve_main

        return serve_main()

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
