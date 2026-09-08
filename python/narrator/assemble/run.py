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
Working files are not in `output_dir` AT ALL any more - see `WORK_DIR_PREFIX`.

THE SENTENCE TRANSCRIPT IS NOT AN output_dir FILE, for exactly that reason: a
third file at the top level would be promoted into the user's audiobook folder
beside the m4b as a stray. When no coverage report exists - the Align row never
ran - assembly writes `<stem>.sentences.vtt` BESIDE THE SESSION, in the process
dir, which is where `narrator align` writes the measured one. Same name, same
place, one of them measured and one of them estimated and saying so.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass

from ..manifest import Manifest, validate
from . import coverage_gate
from . import encode as encode_mod
from .chapters import ChapterPlan, chunk_total, plan_chapters, total_duration
from .ffmpeg_tools import FfmpegError, probe_duration, resolve_binary
from .sentence_vtt import (SENTENCE_VTT_SUFFIX, SentenceVttError,
                           estimated_cues_for_manifest, write_sentence_vtt)
from .vtt import write_vtt

#: Prefix of the assembly's working directory, which lives in the MACHINE'S OWN
#: TEMP SPACE and not beside the audiobook.
#:
#: WHAT GOES IN IT is scratch, all of it: the faded chunk copies and generated
#: silences an unpadded engine needs, the per-chapter .m4a files, the concat
#: lists, the ffmpeg metadata file. Only the finished m4b and its VTT belong in
#: `output_dir`, and both are written there directly by ffmpeg - nothing is ever
#: renamed out of the work dir, so there is no same-filesystem requirement to
#: honour (verified: `encode.py` passes `out_path` straight to ffmpeg, and the
#: concat lists carry absolute paths under `-safe 0`).
#:
#: WHY IT MOVED (2026-09-07). `output_dir` is the bridge's staging directory
#: under the project, and the library is on a network share. Every one of those
#: ~1,700 small writes was a round trip over SMB at ~80 ms a create, for files
#: that are deleted minutes later. The temp dir is local on every platform.
#:
#: THE TWO REASONS IT WAS UNDER output_dir ARE BOTH BETTER SERVED HERE.
#:  - SHORT PATHS. output_dir is often already deep - a staging directory under a
#:    project on the Z: library - and Windows still caps the path chain at 260
#:    characters for the APIs ffmpeg uses. `%TEMP%\narrator-asm-ab12cd34\7.m4a`
#:    is far shorter than the same file under a staging directory, not longer.
#:  - NO TWO ASSEMBLIES SHARING A DIRECTORY. The name used to be the fixed
#:    ".narrator-work", so the first thing assemble() did - rmtree(work_dir) -
#:    destroyed ANOTHER assembly's concat list and half-written .m4a files out
#:    from under its running ffmpeg ("Error opening input file
#:    ...concat_list_encoded.txt"). A pid suffix fixed that; `mkdtemp` fixes it
#:    outright, because the directory is created fresh and exclusively by the OS
#:    and there is no start-of-run rmtree to get wrong at all.
#:
#: `tempfile` honours TMPDIR/TMP/TEMP, so an operator whose temp volume is too
#: small for a book's worth of scratch can point it elsewhere.
#:
#: LIFETIME IS UNCHANGED: removed on success, KEPT ON FAILURE because then it is
#: the evidence. assemble() logs the path when it creates the directory, which is
#: how that evidence is found now that it is not sitting beside the audiobook.
WORK_DIR_PREFIX = "narrator-asm-"


def make_work_dir() -> str:
    """A fresh, exclusively-owned working directory for THIS assembly."""
    return tempfile.mkdtemp(prefix=WORK_DIR_PREFIX)


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


def write_estimated_sentence_vtt(manifest: Manifest, stem: str, log) -> str | None:
    """The sentence transcript for a book NOBODY ALIGNED, beside the session.

    Owen's ruling, 2026-09-05: "we need to base assembly on the expected text and
    the actual real length of the audio". With no coverage report there is no
    alignment to place words with, so every cue is proportional - each sentence
    gets its character share of its own chunk's real audio - and every cue says
    so in the file (`sentence_vtt.build_sentence_vtt` writes a `NOTE estimated
    chunk <i>` block). The spans come from `vtt.chunk_spans`, the same running
    sum of sample counts the chunk-level VTT is built from, so a sentence cue can
    never fall outside its own chunk's cue.

    IT NEVER OVERWRITES A MEASURED ONE. A `<stem>.sentences.vtt` already beside
    the session was written by `narrator align` from real word timings, and a
    guess must not replace a measurement.

    IT NEVER STOPS THE ASSEMBLY. A chunk with no audio to spread text over is a
    broken manifest and is named in the log, but the audiobook is the deliverable
    and a derived transcript is not worth refusing one for.
    """
    path = os.path.join(manifest.source.processDir, stem + SENTENCE_VTT_SUFFIX)
    if os.path.isfile(path):
        log(f"[coverage] a sentence transcript is already beside the session "
            f"({path}); leaving the measured one alone")
        return None
    try:
        cues = estimated_cues_for_manifest(manifest, where="assemble")
        if not cues:
            log("[coverage] this book has no spoken chunk to cue, so no sentence "
                "transcript was written")
            return None
        write_sentence_vtt(cues, path)
    except SentenceVttError as refused:
        log(f"[coverage] the estimated sentence transcript could not be written "
            f"({refused}). The audiobook is unaffected.")
        return None
    log(f"[coverage] {len(cues)} ESTIMATED sentence cue(s) -> {path} "
        f"(expected text over each chunk's real audio; nothing aligned this book)")
    return path


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
    coverage_report: str | None = None,
) -> AssembleResult:
    """Assemble the book the manifest describes into `output_dir`.

    `progress` is called with one ASCII log line at a time; the default prints
    them. The lines are the ones electron/reassembly-bridge.ts already parses -
    see `assemble/README.md` for which regex each one satisfies - so a cut-over
    needs no bridge change.

    `coverage_report` is the report `narrator align` wrote. It is an AUDIT and it
    BLOCKS NOTHING (Owen, 2026-09-05): every failed chunk is logged with the text
    the audio did not say and the retake command, and the book is assembled. Its
    absence is logged too, and then the sentence transcript is written from the
    manifest's own text over the real audio durations instead of from measured
    cues. Only a report about ANOTHER book is refused - see
    `assemble/coverage_gate.py`.
    """
    log = progress if progress is not None else (lambda line: print(line, flush=True))

    validate(manifest)
    # BEFORE a single ffmpeg is spawned, so the operator reads what the audit
    # found at the top of the job log rather than after an hour of encoding.
    coverage = coverage_gate.check(manifest, coverage_report, log)
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
    # Local scratch, never the share - see WORK_DIR_PREFIX. Named in the log
    # because on a failure this directory is deliberately left behind as the
    # evidence, and it is no longer sitting next to the audiobook to be noticed.
    work_dir = make_work_dir()
    log(f"[assembly] Working directory: {work_dir}")

    # ------------------------------------------------------------------
    # Resolve every chapter to real files with real sample counts, running
    # all the guards, BEFORE a single ffmpeg is spawned.
    # ------------------------------------------------------------------
    log(f"[ASSEMBLE] Assembling all {len(manifest.chapters)} chapters...")
    # work_dir is where an unpadded engine's faded chunks and generated
    # silence go; a padded engine never touches it.
    #
    # TIMED HERE, not inside plan_chapters, because this is the wall clock the
    # operator is staring at. On a library over SMB this step read and rewrote
    # ~1,700 files for a 25-chapter book and took four to five minutes, and the
    # only thing anybody could see was a card that had not moved. The
    # `Preparing sentences N/M` lines below it come from plan_chapters; this one
    # is the total, and electron/reassembly-bridge.ts closes its `prepare` stage
    # on it.
    prepare_started = time.monotonic()
    plans = plan_chapters(manifest, work_dir, log, workers=workers)
    log(
        f"[ASSEMBLE] Prepared {chunk_total(manifest)} sentences in "
        f"{time.monotonic() - prepare_started:.1f}s"
    )
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
    if coverage is None:
        write_estimated_sentence_vtt(manifest, stem, log)

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
