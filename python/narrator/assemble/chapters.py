"""Per-chapter audio: which chunks, in what order, how long, and the guards.

Ported from ebook2audiobook@9daab0ba lib/core.py:combine_audio_sentences (the
concat list and the FLAC homogeneity guard), lib/core.py:assemble_audio_chunks
(the concat duration guard) and bookforge_ext/parallel/session.py:
measure_assembly_duration (the whole-book duration, measured before any chapter
exists).

THE GAP RULE, MEASURED. Assembly inserts NOTHING between chunks and NOTHING at a
chapter boundary. Every gap a listener hears is already PCM inside the chunk's own
FLAC, so `samples` is the complete answer and a chapter's duration is the exact
sum of its chunks' sample counts. The evidence and the line references are in
`assemble/README.md`; the short version is that a chunk's trailing silence is
written either by the engine (`orpheus.py:4594-4602`) or by BookForge's
gap-normalization pass (`electron/scripts/normalize_gaps.py:150-157`), always
before assembly sees the file.

That is why `Chunk.gapBefore`/`gapAfter` are 0.0 for every e2a session and why
this module refuses a non-zero one rather than guessing: realizing a gap at
concat time means splicing a generated silence FLAC into the list, and a
generated FLAC's max-blocksize will not match the rendered set's - which is
exactly the condition the homogeneity guard below exists to refuse, because
ffmpeg's concat demuxer would silently drop frames.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from ..manifest import Chapter, Manifest, chunk_path
from ..render.flac_header import StreamInfo, assert_concat_homogeneous, read_expected


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
        return sum(i.samples for i in self.infos)

    def duration(self, sample_rate: int) -> float:
        return self.samples / sample_rate


def _plan_one(manifest: Manifest, chapter: Chapter) -> ChapterPlan:
    paths: list[str] = []
    infos: list[StreamInfo] = []
    for chunk in chapter.chunks:
        if chunk.gapBefore or chunk.gapAfter:
            raise NotImplementedError(
                f"chapter {chapter.index} chunk {chunk.index} asks for "
                f"{chunk.gapBefore}s before and {chunk.gapAfter}s after, but assembly "
                f"realizes gaps ONLY as PCM already inside the chunk's FLAC. Splicing a "
                f"generated silence file into the concat list would break the "
                f"max-blocksize homogeneity ffmpeg's concat demuxer requires. Bake the "
                f"gap into the audio (see electron/scripts/normalize_gaps.py) and point "
                f"the manifest at that set."
            )
        path = chunk_path(manifest, chunk)
        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"chapter {chapter.index} is missing chunk {chunk.index}: {path}"
            )
        if os.path.getsize(path) == 0:
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index} is 0 bytes: {path}"
            )
        info = read_expected(path, manifest.sampleRate, channels=1)
        if chunk.samples is not None and info.samples != chunk.samples:
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index}: the manifest records "
                f"{chunk.samples} samples but the file holds {info.samples} - the audio "
                f"changed after the manifest was built ({path})"
            )
        paths.append(path)
        infos.append(info)

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


def plan_chapters(manifest: Manifest) -> list[ChapterPlan]:
    """Resolve every chapter to files + sample counts, running all the guards.

    This happens BEFORE a single ffmpeg is spawned: a book that is going to fail
    because chapter 41 lost a chunk should fail in the first second, not after
    forty chapters of encoding.
    """
    if not manifest.chapters:
        raise ValueError("plan_chapters(): the manifest has no chapters")
    return [_plan_one(manifest, chapter) for chapter in manifest.chapters]


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
