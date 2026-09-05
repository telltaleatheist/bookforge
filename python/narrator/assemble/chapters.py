"""Per-chapter audio: which chunks, in what order, how long, and the guards.

Ported from ebook2audiobook@9daab0ba lib/core.py:combine_audio_sentences (the
concat list and the FLAC homogeneity guard), lib/core.py:assemble_audio_chunks
(the concat duration guard) and bookforge_ext/parallel/session.py:
measure_assembly_duration (the whole-book duration, measured before any chapter
exists).

THE GAP RULE DEPENDS ON THE ENGINE (`assemble/engine_profiles.py`).

PADDED ENGINES (Orpheus; and any manifest with no `engine` block, which is every
manifest written before the block existed). Assembly inserts NOTHING between
chunks and NOTHING at a chapter boundary. Every gap a listener hears is already
PCM inside the chunk's own FLAC, so `samples` is the complete answer and a
chapter's duration is the exact sum of its chunks' sample counts. The evidence
and the line references are in `assemble/README.md`; the short version is that a
chunk's trailing silence is written either by the engine
(`orpheus.py:4594-4602`) or by BookForge's gap-normalization pass
(`electron/scripts/normalize_gaps.py:150-157`), always before assembly sees the
file. `Chunk.gapBefore`/`gapAfter` must be 0.0, and `manifest.validate` refuses
otherwise. This path touches nothing: the session's own FLACs go straight into
the concat list, exactly as they always have.

UNPADDED ENGINES (Higgs). The chunks are bare speech. Assembly must do two
things before joining, both in `assemble/edges.py`:
  - fade each chunk's edges (10 ms in, 25 ms out for Higgs), because a
    content-trimmed edge sits near -30 dB and clicks on a butt join;
  - realize `gapBefore`/`gapAfter` as actual silence in the concat list.

Both happen into the assembly's own working directory; the session's chunk files
are read-only inputs and are never modified.

WHY THE OLD REFUSAL IS GONE. This module used to refuse a non-zero gap outright,
because splicing a generated silence FLAC into a list of rendered ones would
break the max-blocksize homogeneity ffmpeg's concat demuxer requires. That is
still true - and it is no longer a problem, because on the unpadded path EVERY
chunk is rewritten through `edges.py` as well, so the entire list is written by
one encoder with one setting and is homogeneous by construction. The guard below
still runs on whatever actually goes into the list.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from ..manifest import Chapter, Manifest, chunk_path
from ..render.flac_header import (
    StreamInfo,
    assert_concat_homogeneous,
    fatal_inhomogeneity,
    fixable_inhomogeneity,
    read_expected,
    read_streaminfo,
)
from . import edges
from .engine_profiles import DEFAULT_PROFILE, EngineProfile, profile_for


@dataclass
class ChapterPlan:
    """One chapter, resolved to real files with real sample counts."""

    index: int
    title: str
    doc: str | None
    paths: list[str]
    infos: list[StreamInfo]
    first_chunk: int
    last_chunk: int

    @property
    def samples(self) -> int:
        """Every sample that goes into this chapter, gaps included.

        `infos` describes the files actually in the concat list, which on the
        unpadded path already includes the generated silence, so this stays the
        one true length and every consumer of it - chapter markers, the export
        guard, the pre-encoded duration check - accounts for gaps for free.
        """
        return sum(i.samples for i in self.infos)

    def duration(self, sample_rate: int) -> float:
        return self.samples / sample_rate


def _resolve_profile(manifest: Manifest) -> EngineProfile:
    """This manifest's assembly profile.

    A manifest with no `engine` block is an Orpheus manifest (see
    `engine_profiles.DEFAULT_PROFILE`). One WITH a block is believed: its `pads`
    and `edgeFadeMs` are what the engine declared at render time, and the table
    is only consulted to check that we know the engine at all.
    """
    if manifest.engine is None:
        return DEFAULT_PROFILE
    profile_for(manifest.engine.id)  # raises on an engine we have no contract for
    return EngineProfile(
        id=manifest.engine.id,
        pads=manifest.engine.pads,
        fade_in_ms=manifest.engine.edgeFadeMs.fade_in,
        fade_out_ms=manifest.engine.edgeFadeMs.fade_out,
    )


def _normalize_mixed(paths: list[str], infos: list[StreamInfo], chapter_index: int,
                     sample_rate: int, work_dir: str | None,
                     mix: str, log) -> tuple[list[str], list[StreamInfo]]:
    """Re-encode a chapter's chunks through ONE writer, losslessly.

    A book rendered partly on one machine and resumed on another has a mixed
    FLAC set through no fault of its audio - WSL writes PCM_16/2304, the Mac's
    MLX run PCM_24/2304, Windows soundfile PCM_16/4096. Refusing that book was
    the wrong answer: every sample in it is correct, FLAC re-encoding is
    lossless, and the mismatch is purely in the container's framing and declared
    depth.

    The target depth is the WIDEST in the set, so the rewrite cannot cost the
    Mac's 24-bit renders 8 bits (see `edges.target_subtype`). Output goes to the
    work dir; the session is never touched.
    """
    if not work_dir:
        raise ValueError(
            f"chapter {chapter_index} mixes FLAC encodings ({mix}) and must be "
            f"rewritten through one encoder to be concatenated - but plan_chapters() "
            f"was given no working directory to write into"
        )
    subtype = edges.target_subtype(max(i.bits_per_sample for i in infos))
    log(
        f"[assembly] Chapter {chapter_index}: mixed FLAC encodings across the "
        f"rendered set ({mix}); re-encoding {len(paths)} chunk(s) losslessly to "
        f"{subtype} so ffmpeg's concat demuxer cannot drop frames"
    )

    out_dir = edges.edge_dir(work_dir, chapter_index)
    new_paths: list[str] = []
    new_infos: list[StreamInfo] = []
    for src, info in zip(paths, infos):
        dst = os.path.join(out_dir, os.path.basename(src))
        written = edges.write_normalized_chunk(src, dst, sample_rate, subtype)
        if written != info.samples:
            raise AssertionError(
                f"re-encoding {src} changed it from {info.samples} to {written} samples"
            )
        rewritten = read_streaminfo(dst)
        if rewritten.samples != info.samples:
            raise AssertionError(
                f"re-encoded {dst} holds {rewritten.samples} samples, the source held "
                f"{info.samples}"
            )
        new_paths.append(dst)
        new_infos.append(rewritten)
    return new_paths, new_infos


def _plan_padded(manifest: Manifest, chapter: Chapter, work_dir: str | None,
                 log) -> tuple[list[str], list[StreamInfo]]:
    """The original path: the session's own FLACs, untouched.

    The ONE exception is a set that mixes bit depth or blocksize because the
    book was rendered across machines - see `_normalize_mixed`. A homogeneous
    set (every book rendered on one machine, which is all of them today) never
    reaches it and nothing is written at all.
    """
    paths: list[str] = []
    infos: list[StreamInfo] = []
    for chunk in chapter.chunks:
        if chunk.gapBefore or chunk.gapAfter:
            # manifest.validate() refuses this too; repeated here because
            # plan_chapters() is callable on a hand-built manifest, and on this
            # path a gap is not merely wrong - it is silently DISCARDED, since
            # nothing on the padded path ever looks at it again.
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index} asks for "
                f"{chunk.gapBefore}s before and {chunk.gapAfter}s after, but this "
                f"manifest's engine pads its own chunks: the silence is already PCM "
                f"inside the FLAC and this gap would be added on top of it."
            )
        path = _check_chunk(manifest, chapter, chunk)
        infos.append(read_expected(path, manifest.sampleRate, channels=1))
        paths.append(path)
        if chunk.samples is not None and infos[-1].samples != chunk.samples:
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index}: the manifest records "
                f"{chunk.samples} samples but the file holds {infos[-1].samples} - the "
                f"audio changed after the manifest was built ({path})"
            )

    # A sample-rate or channel mismatch says the audio is not what the session
    # claims; no rewrite can reconcile that, so it still refuses.
    fatal = fatal_inhomogeneity(infos)
    if fatal:
        raise ValueError(
            f"chapter {chapter.index}: FLAC {fatal}. This is not a container "
            f"mismatch - the audio itself disagrees with the session."
        )
    mix = fixable_inhomogeneity(infos)
    if mix:
        return _normalize_mixed(
            paths, infos, chapter.index, manifest.sampleRate, work_dir, mix, log
        )
    return paths, infos


def _plan_unpadded(manifest: Manifest, chapter: Chapter, profile: EngineProfile,
                   work_dir: str) -> tuple[list[str], list[StreamInfo]]:
    """Fade every chunk and realize every gap, into `work_dir`.

    The session's files are read and never written. What comes back is the
    concat list for this chapter: silence and faded chunks interleaved, all
    written by one encoder so the list is homogeneous.
    """
    out_dir = edges.edge_dir(work_dir, chapter.index)
    rate = manifest.sampleRate
    paths: list[str] = []
    infos: list[StreamInfo] = []

    def add_gap(seconds: float, tag: str) -> None:
        frames = edges.gap_frames(seconds, rate)
        if frames <= 0:
            return
        path = os.path.join(out_dir, f"{tag}.flac")
        edges.write_silence(path, frames, rate, channels=1)
        info = read_streaminfo(path)
        if info.samples != frames:
            raise AssertionError(
                f"silence file {path} holds {info.samples} samples, expected {frames}"
            )
        paths.append(path)
        infos.append(info)

    for chunk in chapter.chunks:
        src = _check_chunk(manifest, chapter, chunk)
        source = read_expected(src, rate, channels=1)
        if chunk.samples is not None and source.samples != chunk.samples:
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index}: the manifest records "
                f"{chunk.samples} samples but the file holds {source.samples} - the "
                f"audio changed after the manifest was built ({src})"
            )

        add_gap(chunk.gapBefore, f"{chunk.index}b")

        dst = os.path.join(out_dir, f"{chunk.index}.flac")
        written = edges.write_faded_chunk(
            src, dst, rate, profile.fade_in_ms, profile.fade_out_ms
        )
        if written != source.samples:
            raise AssertionError(
                f"edge fade changed chunk {chunk.index} from {source.samples} to "
                f"{written} samples"
            )
        faded = read_streaminfo(dst)
        if faded.samples != source.samples:
            raise AssertionError(
                f"faded chunk {chunk.index} holds {faded.samples} samples, the source "
                f"held {source.samples}"
            )
        paths.append(dst)
        infos.append(faded)

        add_gap(chunk.gapAfter, f"{chunk.index}a")

    return paths, infos


def _check_chunk(manifest: Manifest, chapter: Chapter, chunk) -> str:
    """The chunk's file, once it is known to be there and non-empty."""
    path = chunk_path(manifest, chunk)
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"chapter {chapter.index} is missing chunk {chunk.index}: {path}"
        )
    if os.path.getsize(path) == 0:
        raise ValueError(
            f"chapter {chapter.index} chunk {chunk.index} is 0 bytes: {path}"
        )
    return path


def _plan_one(manifest: Manifest, chapter: Chapter, profile: EngineProfile,
              work_dir: str | None, log) -> ChapterPlan:
    if profile.needs_processing:
        if not work_dir:
            raise ValueError(
                f"engine {profile.id!r} does not pad its chunks, so assembly must fade "
                f"their edges and realize their gaps into a working directory - but "
                f"plan_chapters() was given none"
            )
        paths, infos = _plan_unpadded(manifest, chapter, profile, work_dir)
    else:
        paths, infos = _plan_padded(manifest, chapter, work_dir, log)

    # ffmpeg's concat demuxer drops every FLAC frame whose blocksize exceeds the
    # FIRST list entry's STREAMINFO max-blocksize AND STILL EXITS 0, so a mixed
    # set must never reach it. (Witnesses, 2026: sentences silently missing from
    # a finished audiobook.)
    assert_concat_homogeneous(infos)

    return ChapterPlan(
        index=chapter.index,
        title=chapter.title,
        doc=chapter.doc,
        paths=paths,
        infos=infos,
        first_chunk=chapter.chunks[0].index,
        last_chunk=chapter.chunks[-1].index,
    )


def plan_chapters(manifest: Manifest, work_dir: str | None = None,
                  log=None) -> list[ChapterPlan]:
    """Resolve every chapter to files + sample counts, running all the guards.

    This happens BEFORE a single ffmpeg is spawned: a book that is going to fail
    because chapter 41 lost a chunk should fail in the first second, not after
    forty chapters of encoding.

    `work_dir` is REQUIRED for an engine that does not pad its chunks - that is
    where the faded copies and the generated silence go. It is unused, and may be
    None, for a padded engine, whose files go into the concat list untouched.
    """
    if not manifest.chapters:
        raise ValueError("plan_chapters(): the manifest has no chapters")
    profile = _resolve_profile(manifest)
    if log is None:
        def log(line):
            print(line, flush=True)
    return [
        _plan_one(manifest, chapter, profile, work_dir, log)
        for chapter in manifest.chapters
    ]


def total_duration(plans: list[ChapterPlan], sample_rate: int) -> float:
    """Playing time of the whole book, from the chunk headers alone.

    Ported from bookforge_ext/parallel/session.py:measure_assembly_duration. The
    decision this feeds (whether the parallel encode path is available) is
    upstream of any chapter file existing, so it cannot be answered by measuring
    chapter files.
    """
    return sum(p.samples for p in plans) / sample_rate


def concat_tolerance(file_count: int) -> float:
    """The concat duration guard's tolerance.

    Ported verbatim from ebook2audiobook@9daab0ba lib/core.py:4841
    (`0.5 + 0.01 * len(filepaths)`). ffmpeg's concat demuxer can drop inputs and
    still exit 0, so the exit code alone proves nothing - the output must carry
    the whole input's duration.
    """
    return 0.5 + 0.01 * file_count


#: The finished-export guard's tolerance, in seconds. Ported from
#: ebook2audiobook@9daab0ba lib/core.py:4351 (finalize_export). ffmpeg can stop
#: mid-encode and still FINALIZE a valid, playable, truncated file - moov
#: written, exit clean - e.g. when it loses its progress-pipe reader. Nuremberg,
#: 2026-08-11: a 20.12 h source exported as a valid 14.72 h m4b, silently.
EXPORT_TOLERANCE_S = 2.0


def check_duration(actual: float, expected: float, tolerance: float, what: str,
                   path: str) -> None:
    """Refuse an output that does not carry its input's whole duration."""
    delta = actual - expected
    if abs(delta) > tolerance:
        raise ValueError(
            f"{what} duration mismatch -> {path}: expected {expected:.2f}s, got "
            f"{actual:.2f}s (delta {delta:+.2f}s, tolerance +/-{tolerance:.2f}s). "
            f"ffmpeg exited 0 but the output does not carry all of its input."
        )
