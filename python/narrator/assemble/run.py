"""assemble(): manifest in, one m4b and one VTT in `output_dir`.

Ported from ebook2audiobook@9daab0ba bookforge_ext/parallel/session.py:
assemble_audiobook and lib/core.py:combine_audio_chapters, reduced to the path
the reassembly bridge actually exercises (see "Unexercised e2a paths" in the
build report): `--assemble_only --no_split`, MP4-family output, mono.

WHAT LANDS IN output_dir. Exactly what e2a leaves there, and nothing else at the
top level, because electron/reassembly-bridge.ts promotes EVERY regular file in
its staging directory into the user's output folder (L2316-2360):

    <final_name>.m4b        e2a's final_name, rebuilt the same way
    <final_name>.vtt        the same STEM - not decoration

The shared stem is load-bearing: the bridge pairs the sidecar to the audiobook by
stem (`stemOf(s.wanted) === m4bStem`, L2392) and renames them together. A VTT with
a different stem is promoted under its own name and never binds to the book.
Working files go in a SUBDIRECTORY, which the bridge's `isFile()` filter skips.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import dataclass

from ..manifest import Manifest, validate
from . import encode as encode_mod
from .chapters import ChapterPlan, plan_chapters, total_duration
from .ffmpeg_tools import FfmpegError, probe_duration, resolve_binary
from .vtt import write_vtt

#: The work subdirectory inside output_dir. A directory, so the reassembly
#: bridge's promotion loop skips it; removed on success, kept on failure because
#: then it is the evidence.
#:
#: DELIBERATELY SHORT. output_dir is often already deep - a staging directory
#: under a project on the Z: library - and Windows still caps a path COMPONENT
#: chain at 260 characters for the APIs ffmpeg uses.
#: ".narrator-work/parallel_encode/00007.m4a" is 40 characters of pure overhead
#: per chapter file; ".nw<pid>/7.m4a" is about 14. The ffprobe guard would catch
#: the resulting failure rather than shipping a silent zero, but a refused
#: assembly is still a failure.
#:
#: AND DELIBERATELY PER-PROCESS. This used to be the fixed name ".narrator-work",
#: which made the first thing assemble() does - rmtree(work_dir) - destructive to
#: ANOTHER assembly writing into the same output_dir: process B deleted process
#: A's concat list and half-written chapter .m4a files out from under a running
#: ffmpeg, and A died with "Error opening input file ...concat_list_encoded.txt".
#: Two variants of one book staged into a single directory, or one suite run by
#: several agents at once, is enough to hit it. The pid makes the directory
#: unique to the assembly that owns it, so the start-of-run rmtree can only ever
#: remove OUR OWN leftovers.
WORK_DIRNAME = ".nw"


def work_dir_for(output_dir: str) -> str:
    """This process's working directory inside `output_dir`."""
    return os.path.join(output_dir, f"{WORK_DIRNAME}{os.getpid():x}")


@dataclass
class AssembleResult:
    m4b_path: str
    vtt_path: str
    duration_s: float
    chapter_count: int


def get_sanitized(value: str, replacement: str = "_") -> str:
    """Ported verbatim from ebook2audiobook@9daab0ba lib/core.py:3014.

    This is what turns "Working Towards The Fuhrer. Ian Kershaw. (1993).m4b" into
    "Working_Towards_The_Fuhrer._Ian_Kershaw._1993_.m4b". The bridge renames the
    file afterwards, but the m4b and the VTT must agree on it in the meantime.
    """
    value = value.replace("&", "And")
    forbidden_chars = r'[<>:"/\\|?*\x00-\x1F ()]'
    sanitized = re.sub(r"\s+", replacement, value)
    sanitized = re.sub(forbidden_chars, replacement, sanitized)
    return sanitized.strip("_")


def final_name(manifest: Manifest, output_format: str = "m4b") -> str:
    """The output filename e2a would choose.

    Ported from bookforge_ext/parallel/session.py:1119-1132. NOTE that
    `session-state.json`'s own `final_name` (`staged-<uuid>.m4b`) is NOT used:
    assembly recomputes the name from the metadata every time, and the bridge
    passes no --output_filename. Verified against the Kershaw session, whose
    state says `staged-ccd14111-....m4b` while the file e2a produced was named
    from the title, author and year.
    """
    title = manifest.book.title or "Untitled"
    author = manifest.book.author or ""
    year = manifest.book.year or ""
    if author and year:
        base = f"{title}. {author}. ({year})"
    elif author:
        base = f"{title}. {author}"
    else:
        base = title
    return get_sanitized(f"{base}.{output_format}")


def _chapter_durations_ms(
    plans: list[ChapterPlan],
    pre_encoded: dict[int, str],
    sample_rate: int,
    ffprobe: str,
) -> list[int]:
    """Chapter marker lengths in milliseconds.

    A chapter built from its chunks is measured from the FLAC headers - exact, and
    the same number the VTT uses, so the markers and the transcript cannot
    disagree. A pre-encoded chapter is measured from its .m4a, which is what e2a
    does and is strictly more honest anyway: that .m4a is the very stream copied
    into the audiobook, so the marker tiles against what the listener hears.
    """
    out = []
    for plan in plans:
        if plan.index in pre_encoded:
            seconds = probe_duration(pre_encoded[plan.index], ffprobe)
        else:
            seconds = plan.duration(sample_rate)
        out.append(int(round(seconds * 1000)))
    return out


def _remove_work_dir(work_dir: str, log) -> None:
    """Delete the working directory, allowing for Windows' habit of holding a
    just-closed file open for a moment.

    An anti-virus or search indexer can keep a handle on a freshly written .m4a
    for a beat after the encoder exits, and a single rmtree then leaves the whole
    tree behind. Three tries with a short backoff clears that. A cleanup failure
    is NOT an assembly failure - the audiobook is already written and verified -
    so this reports what it could not remove and returns rather than raising.
    """
    for attempt in range(3):
        try:
            shutil.rmtree(work_dir)
            return
        except OSError:
            if attempt < 2:
                time.sleep(0.25)
    shutil.rmtree(work_dir, ignore_errors=True)
    if os.path.isdir(work_dir):
        log(
            f"[assembly] Note: could not remove the working directory {work_dir} "
            f"(a file in it is still held open). The audiobook is complete and "
            f"verified; the directory can be deleted by hand."
        )


def assemble(
    manifest: Manifest,
    output_dir: str,
    *,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    encoded_chapters_dir: str | None = None,
    workers: int | None = None,
    progress=None,
    output_format: str = "m4b",
    channels: int = 1,
    post_render_filter: str | None = None,
) -> AssembleResult:
    """Assemble the book the manifest describes into `output_dir`.

    `progress` is called with one ASCII log line at a time; the default prints
    them. The lines are the ones electron/reassembly-bridge.ts already parses -
    see `assemble/README.md` for which regex each one satisfies - so a cut-over
    needs no bridge change.
    """
    log = progress if progress is not None else (lambda line: print(line, flush=True))

    validate(manifest)
    ffmpeg_bin = resolve_binary("ffmpeg", ffmpeg)
    ffprobe_bin = resolve_binary("ffprobe", ffprobe)

    if output_format not in encode_mod.MP4_FAMILY:
        raise FfmpegError(
            f"narrator assembles the MP4 family only ({', '.join(encode_mod.MP4_FAMILY)}); "
            f"{output_format!r} was e2a's serial-only path and is not ported"
        )

    if workers is None:
        cpu_count = os.cpu_count()
        if cpu_count is None:
            # Sizing the pool is not a guess to make silently - a wrong worker
            # count either starves the machine or oversubscribes it.
            raise RuntimeError(
                "os.cpu_count() returned None; pass workers= to size the encoder pool"
            )
        workers = max(1, min(cpu_count, 16))
    if workers < 1:
        raise ValueError(f"workers must be >= 1, got {workers}")

    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    work_dir = work_dir_for(output_dir)
    if os.path.isdir(work_dir):
        # Only ever a leftover from a PREVIOUS run of this same process (a crash
        # or a kept-as-evidence failure). It cannot belong to a live assembly:
        # the name carries our pid.
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)

    # ------------------------------------------------------------------
    # Resolve every chapter to real files with real sample counts, running
    # all the guards, BEFORE a single ffmpeg is spawned.
    # ------------------------------------------------------------------
    log(f"[ASSEMBLE] Assembling all {len(manifest.chapters)} chapters...")
    # work_dir is where an unpadded engine's faded chunks and generated
    # silence go; a padded engine never touches it.
    plans = plan_chapters(manifest, work_dir, log)
    for plan in plans:
        log(
            f"[ASSEMBLE] Chapter {plan.index}: sentences "
            f"{plan.first_chunk}-{plan.last_chunk}"
        )
    source_duration = total_duration(plans, manifest.sampleRate)
    log("Assemble completed!")

    pre_encoded = encode_mod.load_encoded_chapters(
        encoded_chapters_dir,
        plans,
        manifest.sampleRate,
        ffprobe_bin,
        log,
    )

    final_denoise = os.environ.get("FINAL_DENOISE", "0") == "1"
    reason = encode_mod.parallel_export_unsupported_reason(
        output_format=output_format,
        source_duration=source_duration,
        post_render_filter=post_render_filter,
        final_denoise=final_denoise,
        output_split=False,
    )
    if reason and pre_encoded:
        # The pre-encoded chapters cannot be used where the parallel path is not
        # available, and there is no honest way to place them: stand the whole set
        # down and rebuild every chapter, saying why.
        log(
            f"[assembly] --encoded-chapters-dir stood down ({len(pre_encoded)} "
            f"pre-encoded chapter(s) available): {reason}. Every chapter will be "
            f"encoded from its sentences."
        )
        pre_encoded = {}

    # ------------------------------------------------------------------
    # The transcript, before any encoding - as e2a orders it.
    # ------------------------------------------------------------------
    name = final_name(manifest, output_format)
    stem = os.path.splitext(name)[0]
    m4b_path = os.path.join(output_dir, name)
    vtt_path = os.path.join(output_dir, stem + ".vtt")

    log("[ASSEMBLE] Creating VTT subtitle file...")
    write_vtt(manifest, vtt_path)

    # ------------------------------------------------------------------
    # Chapter atoms, then the audio.
    # ------------------------------------------------------------------
    metadata_file = encode_mod.generate_ffmpeg_metadata(
        manifest,
        _chapter_durations_ms(plans, pre_encoded, manifest.sampleRate, ffprobe_bin),
        os.path.join(work_dir, "metadata.txt"),
    )

    log("[ASSEMBLE] Combining chapters into final audiobook...")
    if reason is None:
        chapter_paths = encode_mod.encode_chapters_parallel(
            plans=plans,
            pre_encoded=pre_encoded,
            work_dir=work_dir,
            ffmpeg=ffmpeg_bin,
            ffprobe=ffprobe_bin,
            sample_rate=manifest.sampleRate,
            channels=channels,
            workers=workers,
            log=log,
        )
        encode_mod.concat_encoded(
            chapter_paths=chapter_paths,
            metadata_file=metadata_file,
            cover=manifest.book.cover,
            out_path=m4b_path,
            work_dir=work_dir,
            ffmpeg=ffmpeg_bin,
            log=log,
        )
    else:
        log(f"[assembly] Serial encode: {reason}")
        encode_mod.encode_serial(
            plans=plans,
            metadata_file=metadata_file,
            cover=manifest.book.cover,
            out_path=m4b_path,
            work_dir=work_dir,
            ffmpeg=ffmpeg_bin,
            channels=channels,
            source_duration=source_duration,
            post_render_filter=post_render_filter,
            final_denoise=final_denoise,
            log=log,
        )

    duration = encode_mod.verify_export(m4b_path, source_duration, ffprobe_bin)

    # Only drop the working files once the result has passed the duration guard -
    # if it failed, they are the evidence for why.
    _remove_work_dir(work_dir, log)

    result = AssembleResult(
        m4b_path=m4b_path,
        vtt_path=vtt_path,
        duration_s=duration,
        chapter_count=len(plans),
    )
    log(
        json.dumps(
            {
                "success": True,
                "session_id": manifest.source.sessionId,
                "output_files": [m4b_path],
                "output_dir": output_dir,
            },
            indent=2,
        )
    )
    return result
