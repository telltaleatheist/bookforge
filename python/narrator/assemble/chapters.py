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

PREPARING THE SENTENCES IS I/O, SO IT RUNS ON A POOL (2026-09-07). Measured on
Mutineer's Moon - 847 chunks, 25 chapters, the library on an SMB share - the
unpadded path read every sentence FLAC over the wire and wrote a faded copy plus
its gap silences back, one chunk at a time: about 5.6 files a second, roughly
1,700 files, four to five minutes in which the assembly card showed nothing at
all. Every one of those units is INDEPENDENT - distinct source, distinct
destination, no shared state - and every second of it is spent waiting on a
socket or inside libsndfile, both of which drop the GIL. They now run on a
`ThreadPoolExecutor` bounded by the same `workers` that sizes the encoder pool.

BOTH PATHS, not only the unpadded one. The padded path (Orpheus, the majority
engine) writes nothing and reads 42 bytes a chunk, which is why it was left
serial in the first pass - but the cost over SMB is the OPEN, not the bytes: one
round trip per chunk, hundreds of them, on the path most books take. Same pool,
same `workers`, same ordering guarantee.

Two properties are not negotiable and are pinned by
`tests/test_assemble_prepare_parallel.py`:

  - THE ORDER IS THE SERIAL ORDER. Each chunk's unit returns its own little
    list - gapBefore, the faded chunk, gapAfter - and those lists are stitched
    together in chunk order, so `paths`/`infos` are byte-for-byte the list the
    serial version built.
  - THE FILES ARE BIT-IDENTICAL. Nothing about a fade or a silence depends on
    what any other chunk did, so workers=1 and workers=8 write the same bytes.

Errors keep the serial order too: `Executor.map` re-raises the FIRST failing
unit in iteration order, so the message a broken book fails with is the one it
failed with before. Later units may have run by then; everything they wrote is
inside the assembly's own work dir, which is thrown away or kept as evidence.

THE CHAPTER GAP IS NOT A GAP RULE. `plan_chapters(chapter_gap=...)` is silence
BETWEEN CHAPTERS, and it is engine-agnostic: it is not inside a chunk, it is not
`Chunk.gapAfter`, and neither the padded nor the unpadded path above knows about
it. Each plan simply records how much silence follows it, and the file that
carries it is written by `assemble/encode.py`, where chapters are joined. That is
the only level at which a chapter BookForge PRE-ENCODED during the render gets
the same treatment as one this assembler encodes itself.

PROGRESS. The chunk total is known before any file is touched (`chunk_total`),
so preparation reports `[ASSEMBLE] Preparing sentences <done>/<total>` at 0, at
the total, and at most about once a second in between. That line is what the
reassembly card's `prepare` bar is driven from.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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
    #: Seconds of silence that FOLLOW this chapter, separating it from the next
    #: one (`plan_chapters(chapter_gap=...)`). It is 0.0 on the last chapter -
    #: the end of the book is not a boundary anyone needs marked - and 0.0
    #: everywhere when no chapter gap was asked for.
    #:
    #: IT IS NOT PART OF `paths`/`infos`. Those are the chapter's AUDIO, and the
    #: two duration guards that ask "did every sentence reach the encoder"
    #: (`load_encoded_chapters`, `encode_chapters_parallel`) compare against
    #: exactly that. The silence is realized where chapters are JOINED - one
    #: entry in the final concat list - which is the only place both encode
    #: paths and a chapter BookForge pre-encoded during the render can all be
    #: given the same treatment. See `encode.chapter_gap_flac` /
    #: `encode.chapter_gap_m4a`.
    gap_after: float = 0.0
    #: `gap_after` in samples, rounded ONCE (`edges.gap_frames`) so the audio,
    #: the chapter markers and the VTT cannot disagree about it.
    gap_samples: int = 0

    @property
    def audio_samples(self) -> int:
        """Every sample of AUDIO in this chapter, the realized inter-chunk gaps
        included and the chapter gap NOT.

        `infos` describes the files actually in the chapter's concat list, which
        on the unpadded path already includes the generated inter-chunk silence,
        so this is the exact length of what the chapter encode produces.
        """
        return sum(i.samples for i in self.infos)

    @property
    def samples(self) -> int:
        """Every sample this chapter occupies in the finished book - its audio
        plus the silence that separates it from the next chapter.

        This is what the chapter markers, the whole-book duration and the export
        guard are built from, because it is what a listener moves through.
        """
        return self.audio_samples + self.gap_samples

    def audio_duration(self, sample_rate: int) -> float:
        return self.audio_samples / sample_rate

    def duration(self, sample_rate: int) -> float:
        return self.samples / sample_rate


def chunk_total(manifest: Manifest) -> int:
    """Every chunk the book will prepare, known before a file is touched.

    The denominator of the prepare bar. It is a manifest fact, not a directory
    scan, so it is available at the top of the run and cannot drift from what
    `plan_chapters` actually walks.
    """
    return sum(len(chapter.chunks) for chapter in manifest.chapters)


#: How often the prepare bar is allowed to say something, in seconds. The point
#: is "this is moving", not a frame-accurate count: 847 chunks at one line each
#: would be 847 lines through the bridge's stdout parser for no extra
#: information, and the bridge throttles its own publishing anyway.
PREPARE_LOG_INTERVAL_S = 1.0


class PrepareProgress:
    """Counts prepared chunks across the whole book and says so, ~once a second.

    Shared by every worker thread, so every read-modify-write of the counter -
    AND the log call itself - happens under one lock. Logging under the lock is
    deliberate: `log` is a plain callable (print, a list append, the bridge's
    stdout), none of which promise anything about concurrent callers, and a torn
    progress line is worse than a slightly serialized one.
    """

    def __init__(self, total: int, log) -> None:
        self._total = total
        self._log = log
        self._lock = threading.Lock()
        self._done = 0
        self._last_line_at = 0.0

    def start(self) -> None:
        self._last_line_at = time.monotonic()
        self._log(f"[ASSEMBLE] Preparing sentences 0/{self._total}")

    def step(self) -> None:
        with self._lock:
            self._done += 1
            done = self._done
            now = time.monotonic()
            if done < self._total and now - self._last_line_at < PREPARE_LOG_INTERVAL_S:
                return
            self._last_line_at = now
            self._log(f"[ASSEMBLE] Preparing sentences {done}/{self._total}")


def _map_ordered(fn, items, workers: int) -> list:
    """`[fn(i) for i in items]`, on `workers` threads, results IN ORDER.

    One thread is not a pool: a single-worker run must be exactly the serial
    code path, so `workers <= 1` never touches the executor at all.
    """
    if workers <= 1 or len(items) <= 1:
        return [fn(item) for item in items]
    with ThreadPoolExecutor(max_workers=workers,
                            thread_name_prefix="narrator-prepare") as pool:
        return list(pool.map(fn, items))


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
                 log, workers: int,
                 progress: PrepareProgress) -> tuple[list[str], list[StreamInfo]]:
    """The original path: the session's own FLACs, untouched.

    The ONE exception is a set that mixes bit depth or blocksize because the
    book was rendered across machines - see `_normalize_mixed`. A homogeneous
    set (every book rendered on one machine, which is all of them today) never
    reaches it and nothing is written at all.

    IT RUNS ON THE SAME POOL AS THE UNPADDED PATH, and the reason is LATENCY
    rather than bytes. It writes nothing and reads 42 bytes a chunk, which is
    why it was left serial when the pool landed (73c2bc49) - but over SMB the
    cost of a chunk here is not the 42 bytes, it is the open: a round trip each,
    847 of them for Mutineer's Moon, tens of seconds of a card showing nothing.
    Orpheus is the majority engine and this is its path.

    The unit is one chunk: check it exists, read its STREAMINFO, compare it with
    the manifest. Independent by construction - it touches no shared state and
    writes nothing - so ordering is all that has to be preserved, and
    `_map_ordered` preserves it.
    """
    def prepare(chunk) -> tuple[str, StreamInfo]:
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
        info = read_expected(path, manifest.sampleRate, channels=1)
        if chunk.samples is not None and info.samples != chunk.samples:
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index}: the manifest records "
                f"{chunk.samples} samples but the file holds {info.samples} - the "
                f"audio changed after the manifest was built ({path})"
            )
        progress.step()
        return path, info

    paths: list[str] = []
    infos: list[StreamInfo] = []
    for path, info in _map_ordered(prepare, chapter.chunks, workers):
        paths.append(path)
        infos.append(info)

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
                   work_dir: str, workers: int,
                   progress: PrepareProgress) -> tuple[list[str], list[StreamInfo]]:
    """Fade every chunk and realize every gap, into `work_dir`.

    The session's files are read and never written. What comes back is the
    concat list for this chapter: silence and faded chunks interleaved, all
    written by one encoder so the list is homogeneous.

    One chunk's files are one INDEPENDENT unit of work (see the module
    docstring), so the units run on `workers` threads and their results are
    stitched back together in chunk order.
    """
    out_dir = edges.edge_dir(work_dir, chapter.index)
    rate = manifest.sampleRate

    def gap(seconds: float, tag: str) -> tuple[str, StreamInfo] | None:
        frames = edges.gap_frames(seconds, rate)
        if frames <= 0:
            return None
        path = os.path.join(out_dir, f"{tag}.flac")
        edges.write_silence(path, frames, rate, channels=1)
        info = read_streaminfo(path)
        if info.samples != frames:
            raise AssertionError(
                f"silence file {path} holds {info.samples} samples, expected {frames}"
            )
        return path, info

    def prepare(chunk) -> list[tuple[str, StreamInfo]]:
        """Everything this chunk contributes to the concat list, in order."""
        src = _check_chunk(manifest, chapter, chunk)
        source = read_expected(src, rate, channels=1)
        if chunk.samples is not None and source.samples != chunk.samples:
            raise ValueError(
                f"chapter {chapter.index} chunk {chunk.index}: the manifest records "
                f"{chunk.samples} samples but the file holds {source.samples} - the "
                f"audio changed after the manifest was built ({src})"
            )

        unit: list[tuple[str, StreamInfo]] = []
        before = gap(chunk.gapBefore, f"{chunk.index}b")
        if before is not None:
            unit.append(before)

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
        unit.append((dst, faded))

        after = gap(chunk.gapAfter, f"{chunk.index}a")
        if after is not None:
            unit.append(after)

        progress.step()
        return unit

    paths: list[str] = []
    infos: list[StreamInfo] = []
    for unit in _map_ordered(prepare, chapter.chunks, workers):
        for path, info in unit:
            paths.append(path)
            infos.append(info)
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
              work_dir: str | None, log, workers: int,
              progress: PrepareProgress) -> ChapterPlan:
    if profile.needs_processing:
        if not work_dir:
            raise ValueError(
                f"engine {profile.id!r} does not pad its chunks, so assembly must fade "
                f"their edges and realize their gaps into a working directory - but "
                f"plan_chapters() was given none"
            )
        paths, infos = _plan_unpadded(
            manifest, chapter, profile, work_dir, workers, progress
        )
    else:
        paths, infos = _plan_padded(
            manifest, chapter, work_dir, log, workers, progress
        )

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
                  log=None, workers: int = 1,
                  chapter_gap: float = 0.0) -> list[ChapterPlan]:
    """Resolve every chapter to files + sample counts, running all the guards.

    This happens BEFORE a single ffmpeg is spawned: a book that is going to fail
    because chapter 41 lost a chunk should fail in the first second, not after
    forty chapters of encoding.

    `work_dir` is REQUIRED for an engine that does not pad its chunks - that is
    where the faded copies and the generated silence go. It is unused, and may be
    None, for a padded engine, whose files go into the concat list untouched.

    `workers` bounds the per-chunk prepare pool on BOTH paths - the unpadded
    path's read-fade-write unit and the padded path's header read, which is a
    round trip apiece over SMB. `assemble()` passes the same number it sizes the
    encoder pool with. It DEFAULTS TO 1 - serial, exactly as this function has
    always behaved - so a caller that has not thought about concurrency does not
    silently acquire it.

    `chapter_gap` is seconds of silence to put BETWEEN chapters, so a listener
    hears the book move from one to the next. It is recorded on every plan but
    the last as `gap_after`/`gap_samples` and is NOT realized here - see
    `ChapterPlan.gap_after` for why the file that carries it is written where
    chapters are joined rather than where a chapter's chunks are gathered. It
    DEFAULTS TO 0.0, which is every book assembled before this existed.
    """
    if not manifest.chapters:
        raise ValueError("plan_chapters(): the manifest has no chapters")
    if workers < 1:
        raise ValueError(f"plan_chapters(): workers must be >= 1, got {workers}")
    if chapter_gap < 0:
        raise ValueError(
            f"plan_chapters(): chapter_gap must be >= 0 seconds, got {chapter_gap}"
        )
    profile = _resolve_profile(manifest)
    if log is None:
        def log(line):
            print(line, flush=True)
    progress = PrepareProgress(chunk_total(manifest), log)
    progress.start()
    plans = [
        _plan_one(manifest, chapter, profile, work_dir, log, workers, progress)
        for chapter in manifest.chapters
    ]
    if chapter_gap > 0:
        gap_samples = edges.gap_frames(chapter_gap, manifest.sampleRate)
        # Every chapter BUT THE LAST. A gap after the final chapter is not a
        # boundary between anything; it is a book that ends in dead air.
        for plan in plans[:-1]:
            plan.gap_after = chapter_gap
            plan.gap_samples = gap_samples
        log(
            f"[assembly] Chapter gap: {chapter_gap:.3f}s ({gap_samples} samples) "
            f"after each of the first {len(plans) - 1} chapter(s)"
        )
    return plans


def total_duration(plans: list[ChapterPlan], sample_rate: int) -> float:
    """Playing time of the whole book, from the chunk headers and the chapter
    gaps alone.

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
