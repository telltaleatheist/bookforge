"""AAC encoding, chapter atoms, cover art and tags.

Ported from ebook2audiobook@9daab0ba lib/core.py:
  - combine_audio_chapters.generate_ffmpeg_metadata  (the ;FFMETADATA1 document)
  - combine_audio_chapters.export_audio              (the serial encode)
  - combine_audio_chapters.export_audio_parallel     (the per-chapter encode)
  - parallel_export_unsupported_reason               (which of the two runs)
  - load_encoded_chapters                            (BookForge's pre-encoded set)
  - sanitize_meta_chapter_title / ellipsize_utf8_bytes

CODEC PARAMETERS ARE PART OF THE CONTRACT. A different bitrate is a silent parity
failure - the book still plays, it just is not the same file - so every one of
these is copied from e2a rather than chosen:

    -c:a aac  -b:a 192k  -ar 44100  -ac 1|2   (m4b/m4a/mp4/mov)
    -movflags +faststart+use_metadata_tags
    loudnorm=I=-16:LRA=11:TP=-1.5:linear=true,afftdn=nf=-70   (serial, <= 2 h)

Note that the SOURCE is 24 kHz mono and the encode resamples to 44.1 kHz. That is
e2a's choice, kept deliberately: changing it would make every narrator-assembled
book a different file from every e2a-assembled one.

TWO ENCODE PATHS, THE SAME GATE. e2a picks between a single serial encode of the
whole book and a per-chapter parallel encode, and the choice is audible: the
serial path applies loudnorm, the parallel path cannot (loudnorm with
linear=true MEASURES THE WHOLE FILE and does not decompose per chapter). narrator
reproduces the gate exactly rather than always taking the fast path, because
"assembly is 8x faster and also 3 LU louder" is not parity.

WHERE NARRATOR IS FASTER ANYWAY. e2a materializes a chapter FLAC per chapter and,
on the serial path, one whole-book FLAC on top of that (1.5 GB of pure write on a
20 h book) purely to hand one file to one encoder. narrator feeds the sentence
FLACs to ffmpeg's concat demuxer directly, so the PCM the encoder sees is
identical and no intermediate is ever written.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
import subprocess
import tempfile

from ..manifest import Manifest
from .chapters import (
    ChapterPlan,
    EXPORT_TOLERANCE_S,
    check_duration,
    concat_tolerance,
)
from .ffmpeg_tools import FfmpegError, probe_duration, run, write_concat_list

#: Copied from ebook2audiobook@9daab0ba lib/conf_models.py:102-105.
SML_UNSPOKEN_PATTERN = re.compile(
    r"\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]",
    re.IGNORECASE,
)

#: e2a lib/core.py:4132. Opt-in via FINAL_DENOISE=1.
FINAL_DENOISE_FILTER = "afftdn=nr=12:nf=-50:tn=1"

#: e2a lib/core.py:4321.
LOUDNORM_FILTER = "loudnorm=I=-16:LRA=11:TP=-1.5:linear=true,afftdn=nf=-70"

#: e2a lib/core.py:4310 / :3973. Above this, loudnorm(linear=true) is skipped
#: because it measures the whole file in memory - which is also exactly why the
#: parallel path is only available above it.
LOUDNORM_CUTOFF_S = 7200

MP4_FAMILY = ("m4b", "m4a", "mp4", "mov")

#: How far a PRE-ENCODED chapter's measured duration may sit from what the
#: manifest's sample counts say that chapter is, in seconds.
#:
#: TIGHT ON PURPOSE, and much tighter than `concat_tolerance`. A pre-encoded
#: chapter was encoded from the EXACT SAME sample set this manifest describes, so
#: the only legitimate difference is the encoder's own framing. `concat_tolerance`
#: (0.5 + 0.01*n) is the guard for a concat that may have silently dropped
#: frames; used here it is far too slack to notice a chapter from a DIFFERENT
#: sentence set - on a 4-chunk chapter it allows 0.54 s, enough to accept a
#: neighbouring chapter's audio wholesale.
#:
#: The theoretical worst case is AAC priming plus one frame, ~0.045 s at 24 kHz.
#: MEASURED (2026-09-04, ffmpeg 7.x, this encoder path) it is far smaller than
#: that, because the mp4 muxer writes an edit list that trims the priming and
#: ffprobe honours it:
#:
#:   19 synthetic chapters, 0.05 s to 20.02 s, 1 to 4 chunks .... max 0.000 ms
#:   4 real golden chapters, 46 to 178 chunks, 20 to 78 min .... max 0.676 ms
#:
#: 0.06 s therefore sits just above the theoretical bound and ~88x above the
#: worst value actually observed, so it cannot fire on a legitimate chapter while
#: still refusing one that is even a tenth of a second wrong.
PRE_ENCODED_TOLERANCE_S = 0.06


# --------------------------------------------------------------------------
# chapter titles
# --------------------------------------------------------------------------


def ellipsize_utf8_bytes(s: str, max_bytes: int, ellipsis: str = "…") -> str:
    """Ported verbatim from ebook2audiobook@9daab0ba lib/core.py:4867."""
    s = "" if s is None else str(s)
    if max_bytes <= 0:
        return ""
    raw = s.encode("utf-8")
    e = ellipsis.encode("utf-8")
    if len(raw) <= max_bytes:
        return s
    if len(e) >= max_bytes:
        return e[:max_bytes].decode("utf-8", errors="ignore")
    budget = max_bytes - len(e)
    out = bytearray()
    for ch in s:
        b = ch.encode("utf-8")
        if len(out) + len(b) > budget:
            break
        out.extend(b)
    return out.decode("utf-8") + ellipsis


def sanitize_meta_chapter_title(title: str, max_bytes: int = 140) -> str:
    """Ported from ebook2audiobook@9daab0ba lib/core.py:4887.

    A chapter's title is very often the chapter's OWN FIRST CHUNK, which means it
    arrives carrying whatever markers that row has - `[heading]` included since
    2026-08-27. A marker printed into an m4b chapter name is as wrong as one read
    aloud, so the whole unspoken set is stripped.
    """
    title = (title or "").replace("\x00", "")
    title = SML_UNSPOKEN_PATTERN.sub("", title).strip()
    return ellipsize_utf8_bytes(title, max_bytes=max_bytes, ellipsis="…")


def _escape_meta_value(value: str, where: str) -> str:
    """e2a's chapter-title escape, plus a refusal e2a does not have.

    e2a: `re.sub(r'(^#)|[=\\\\]|(-$)', ...)` (lib/core.py:4209) - it escapes a
    leading '#', every '=' and '\\', and a trailing '-'.

    A newline or a ';' is NOT escaped by that, and either one silently ends the
    ffmetadata record and turns the rest of the title into garbage keys. e2a would
    write the corrupt file; narrator refuses and says which title did it.
    """
    if "\n" in value or "\r" in value or ";" in value:
        raise ValueError(
            f"{where} contains a newline or a ';', which would terminate the "
            f"ffmetadata record and corrupt every chapter after it: {value!r}"
        )
    return re.sub(
        r"(^#)|[=\\]|(-$)",
        lambda m: "\\" + (m.group(1) or m.group(0)),
        value,
    )


def _escape_meta_text_value(value: str, where: str) -> str:
    """The ffmetadata escape for a FREE-TEXT book tag, which a chapter title's
    escape cannot be used for.

    `_escape_meta_value` REFUSES a newline or a ';'. That is right for a chapter
    title - one there means the source is malformed and every chapter after it
    would be garbage - and wrong for `description`, where a publisher's blurb
    routinely carries both and refusing would fail a whole audiobook over a tag.

    ffmpeg's ffmetadata spec names exactly five characters that must be escaped
    with a backslash: '=', ';', '#', '\\' and a newline. This escapes all five, so
    a multi-line blurb survives as ONE value and the [CHAPTER] blocks after it are
    read as chapters.

    A DECLARED DEVIATION from ebook2audiobook@9daab0ba, which applied its chapter
    -title regex here too (lib/core.py:4160-4168 writes the value RAW - no escape
    at all) and therefore wrote a file whose records ended at the blurb's first
    newline. Nothing was refused there and nothing is refused here; what changes
    is that the tag now survives instead of corrupting the rest of the document.
    """
    if "\x00" in value:
        raise ValueError(f"{where} contains a NUL byte: {value!r}")
    return re.sub(r"[=;#\\\n\r]", lambda m: "\\" + m.group(0), value)


def generate_ffmpeg_metadata(
    manifest: Manifest,
    chapter_durations_ms: list[int],
    output_path: str,
) -> str:
    """Write the `;FFMETADATA1` document: book tags then one [CHAPTER] per chapter.

    Ported from ebook2audiobook@9daab0ba lib/core.py:4150-4216, for the MP4 family
    (the only family this assembler targets; see `parallel_export_unsupported_reason`).

    Chapter boundaries are a running sum of the per-chapter durations in
    MILLISECONDS, `int(round(seconds * 1000))` each, exactly as e2a rounds them -
    so a marker lands on the same millisecond it lands on today.
    """
    if len(chapter_durations_ms) != len(manifest.chapters):
        raise ValueError(
            f"generate_ffmpeg_metadata(): {len(chapter_durations_ms)} durations for "
            f"{len(manifest.chapters)} chapters"
        )

    lines = [";FFMETADATA1"]
    if manifest.book.title:
        lines.append(f"title={_escape_meta_value(manifest.book.title, 'book title')}")
    if manifest.book.author:
        lines.append(f"artist={_escape_meta_value(manifest.book.author, 'book author')}")
    if manifest.book.language:
        lines.append(f"language={_escape_meta_value(manifest.book.language, 'language')}")
    # `description` and `publisher` sit BETWEEN language and year, which is the
    # order e2a wrote them in (lib/core.py:4165-4168) - `publisher` there is
    # gated on `is_mp4_like or is_mp3` and m4b is mp4-like, so both are written
    # for every container this assembler targets. A book with neither produces
    # the same bytes it always did.
    if manifest.book.description:
        lines.append(
            "description="
            + _escape_meta_text_value(manifest.book.description, "book description")
        )
    if manifest.book.publisher:
        lines.append(
            "publisher="
            + _escape_meta_text_value(manifest.book.publisher, "book publisher")
        )
    if manifest.book.year:
        lines.append(f"year={_escape_meta_value(str(manifest.book.year), 'year')}")

    start_time = 0
    for chapter, duration_ms in zip(manifest.chapters, chapter_durations_ms):
        clean_title = _escape_meta_value(
            sanitize_meta_chapter_title(chapter.title),
            f"chapter {chapter.index} title",
        )
        lines.append("[CHAPTER]")
        lines.append("TIMEBASE=1/1000")
        lines.append(f"START={start_time}")
        lines.append(f"END={start_time + duration_ms}")
        lines.append(f"title={clean_title}")
        start_time += duration_ms

    with open(output_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return output_path


# --------------------------------------------------------------------------
# which encode path
# --------------------------------------------------------------------------


def parallel_export_unsupported_reason(
    output_format: str,
    source_duration: float,
    post_render_filter: str | None,
    final_denoise: bool,
    output_split: bool,
) -> str | None:
    """Why the per-chapter parallel encode may NOT stand in for the serial one, or
    None when it may.

    Ported verbatim in behaviour from ebook2audiobook@9daab0ba lib/core.py:3933.
    Every condition is about producing a result equivalent IN INTENT, not about
    convenience.

      - MP4-family output only. Each chunk is a self-contained .m4a whose edit
        list records its encoder delay, which is why concatenating them is gapless
        (e2a measured 0.179 ms drift across 77 joins on a 20.07 h book). MP3 needs
        LAME gapless tags and Opus/Vorbis carry pre-skip per stream; neither
        survives a naive concat.
      - No pre-loudnorm filters. FINAL_DENOISE / post_render_filter are applied
        per-stream; running them per chunk would restart the filter's internal
        state once per chapter instead of once.
      - Not split into parts.
      - Longer than the 2 h loudnorm cutoff. Below it the serial path applies
        loudnorm(linear=true), which MEASURES THE WHOLE FILE and cannot be
        computed per chunk without changing the result.
    """
    if output_format not in MP4_FAMILY:
        return (
            f"output format {output_format} is not MP4-family (a naive concat is not "
            f"gapless there)"
        )
    if final_denoise:
        return "FINAL_DENOISE is active and must run once over the whole stream"
    if post_render_filter:
        return "a post_render_filter is active and must run once over the whole stream"
    if output_split:
        return "the output is split into parts, which merges chapters before encoding"
    if not source_duration:
        return "the total duration is unknown"
    if source_duration <= LOUDNORM_CUTOFF_S:
        return (
            f"the book is {source_duration:.0f}s, at or under the {LOUDNORM_CUTOFF_S}s "
            f"cutoff below which loudnorm(linear=true) measures the whole file and "
            f"cannot be split"
        )
    return None


# --------------------------------------------------------------------------
# BookForge's pre-encoded chapters
# --------------------------------------------------------------------------


def load_encoded_chapters(
    encoded_dir: str | None,
    plans: list[ChapterPlan],
    sample_rate: int,
    ffprobe: str,
    log,
) -> dict[int, str]:
    """The chapters BookForge already encoded to AAC while the GPU was still
    rendering, handed over as `<chapterNum>.m4a` (1-based, matching
    electron/chapter-closer.ts:255).

    Ported from ebook2audiobook@9daab0ba lib/core.py:3980, with ONE deliberate
    change of policy, per this build's brief: e2a ABORTS the whole assembly on any
    unusable entry; narrator says loudly on the log which chapter was rejected and
    why, and encodes THAT chapter from its sentences. Nothing is ever silently
    dropped or silently rebuilt - the rejection is always printed.

    EVERY accepted chapter is held to the SAME duration guard as a chapter this
    assembler encodes itself: its .m4a must carry the duration the manifest's
    sample counts say that chapter is, within `PRE_ENCODED_TOLERANCE_S`. Without
    that,
    a stale `<n>.m4a` left over from an earlier render - a different sentence
    set, a retaken chunk, a re-cut chapter - is copied verbatim into the
    audiobook, and the only symptom is that the book quietly disagrees with its
    own transcript from that chapter onward. "BookForge vouched for it" is not
    something this assembler can verify; the sample counts are.

    A missing or non-directory `encoded_dir` is still a hard error: the caller
    passed a path, and quietly ignoring it would ship a book from somewhere the
    caller did not intend.
    """
    if not encoded_dir:
        return {}
    if not os.path.isdir(encoded_dir):
        raise FfmpegError(
            f"--encoded-chapters-dir is not a directory: {encoded_dir}"
        )

    by_num = {p.index: p for p in plans}
    expected = set(by_num)
    accepted: dict[int, str] = {}
    for name in sorted(os.listdir(encoded_dir)):
        if not name.lower().endswith(".m4a"):
            continue
        path = os.path.join(encoded_dir, name)
        stem = name[: -len(".m4a")]
        if not stem.isdigit():
            log(
                f"[assembly] Pre-encoded chapter REJECTED (will be encoded from its "
                f"sentences): {path} is not named <chapter_number>.m4a - the file name "
                f"IS the chapter mapping."
            )
            continue
        num = int(stem)
        if num not in expected:
            log(
                f"[assembly] Pre-encoded chapter REJECTED (will be encoded from its "
                f"sentences): {path} claims chapter {num}, which is not one of the "
                f"{len(expected)} chapters this assembly is building."
            )
            continue
        if os.path.getsize(path) == 0:
            log(
                f"[assembly] Pre-encoded chapter {num} REJECTED (will be encoded from "
                f"its sentences): 0 bytes: {path}"
            )
            continue
        try:
            actual = probe_duration(path, ffprobe)
        except FfmpegError as e:
            log(
                f"[assembly] Pre-encoded chapter {num} REJECTED (will be encoded from "
                f"its sentences): unreadable duration: {e}"
            )
            continue
        plan = by_num[num]
        expected_seconds = plan.duration(sample_rate)
        tolerance = PRE_ENCODED_TOLERANCE_S
        if abs(actual - expected_seconds) > tolerance:
            log(
                f"[assembly] Pre-encoded chapter {num} REJECTED (will be encoded from "
                f"its sentences): it is {actual:.2f}s but chapter {num} of this "
                f"manifest is {expected_seconds:.2f}s "
                f"(delta {actual - expected_seconds:+.2f}s, tolerance "
                f"+/-{tolerance:.2f}s). It was encoded from a different sentence "
                f"set: {path}"
            )
            continue
        accepted[num] = path
    return accepted


# --------------------------------------------------------------------------
# encoding
# --------------------------------------------------------------------------


def _aac_args(channels: int) -> list[str]:
    return ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", str(channels)]


#: e2a's movflags, verbatim (lib/core.py:4278, :4514).
#:
#: `+use_metadata_tags` is what carries the ffmetadata keys the MP4 spec does not
#: define - `year` and `language` - into freeform (`----`) atoms. The golden
#: references prove it is load-bearing: all three carry container tags
#: `title`, `artist`, `language` and (where a year is known) `year`. Dropping the
#: flag drops `language` and `year` outright, so it stays.
#:
#: It also means the cover CANNOT be attached by this ffmpeg call. MEASURED with
#: ffmpeg 7.x on 2026-09-04: with `+use_metadata_tags` set, the mov muxer takes
#: the `mdta` keys/ilst path and writes no `covr` atom at all - an `-i cover.jpg`
#: + `-disposition:v:0 attached_pic` is silently dropped and ffprobe reports no
#: video stream. That is exactly why e2a attaches the cover afterwards, with
#: mutagen, and narrator now does the same (see `attach_cover`).
MOVFLAGS = "+faststart+use_metadata_tags"


def attach_cover(out_path: str, cover: str | None, log) -> None:
    """Write the cover into the finished m4b's `covr` atom, with mutagen.

    Ported from ebook2audiobook@9daab0ba lib/core.py:4384-4391 (finalize_export):

        from mutagen.mp4 import MP4, MP4Cover
        audio = MP4(ffmpeg_final_file)
        with open(cover_path, 'rb') as f:
            cover_data = f.read()
        audio['covr'] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_JPEG)]
        audio.save()

    This is a SECOND pass over the finished file, which is what e2a does and what
    the golden references were produced by. It is not free, but mutagen rewrites
    only the moov atom rather than re-encoding, and it is the only way to have
    both the freeform tags and the artwork (see MOVFLAGS).

    `FORMAT_JPEG` is hard-coded exactly as e2a hard-codes it: every cover this
    pipeline stages is a JPEG (`get_cover` writes `<filename_noext>.jpg` with
    PIL's JPEG encoder, and BookForge stages `cover.jpg`).
    """
    if not cover:
        return
    if not os.path.isfile(cover):
        raise FfmpegError(f"cover image not found: {cover}")
    # Imported here, not at module scope: a machine that only builds manifests
    # should not need mutagen installed to import narrator.assemble.
    from mutagen.mp4 import MP4, MP4Cover

    log(f"[assembly] Adding cover {cover} into the final audiobook file")
    audio = MP4(out_path)
    with open(cover, "rb") as f:
        cover_data = f.read()
    audio["covr"] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_JPEG)]
    audio.save()


def encode_chapter(
    ffmpeg: str,
    concat_list: str,
    out_path: str,
    channels: int,
) -> None:
    """One chapter, straight from its sentence FLACs to AAC.

    e2a encodes from a chapter FLAC it built first (lib/core.py:4445-4459); the
    PCM handed to the encoder is identical either way, because that FLAC was a
    lossless concat of exactly these files.
    """
    cmd = [
        ffmpeg, "-hide_banner", "-nostats", "-v", "error",
        "-f", "concat", "-safe", "0", "-i", concat_list,
        *_aac_args(channels),
        "-y", out_path,
    ]
    run(cmd, f"chapter encode -> {os.path.basename(out_path)}")
    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        raise FfmpegError(
            f"chapter encode exited 0 but produced no output: {out_path}"
        )


def encode_chapters_parallel(
    plans: list[ChapterPlan],
    pre_encoded: dict[int, str],
    work_dir: str,
    ffmpeg: str,
    ffprobe: str,
    sample_rate: int,
    channels: int,
    workers: int,
    log,
) -> list[str]:
    """Encode every chapter that is not already encoded, concurrently.

    Ported from ebook2audiobook@9daab0ba lib/core.py:export_audio_parallel:4407.
    ffmpeg's native AAC encoder is single-threaded, so the serial path pinned one
    core: e2a measured 2216 s for a 20.07 h book against 257 s + 95 s here.

    Returns the chapter audio paths in chapter order, ready for a stream copy.
    """
    # Short names: see WORK_DIRNAME in run.py. e2a uses parallel_encode/NNNNN.m4a
    # in the session directory; nothing reads these but the concat list we write
    # beside them, so they cost nothing but path length.
    chunk_dir = work_dir
    os.makedirs(chunk_dir, exist_ok=True)

    outputs: list[str | None] = [None] * len(plans)
    todo: list[tuple[int, ChapterPlan]] = []
    for i, plan in enumerate(plans):
        if plan.index in pre_encoded:
            outputs[i] = pre_encoded[plan.index]
        else:
            todo.append((i, plan))

    log(
        f"[assembly] Parallel encode: {len(todo)} chapters across {workers} workers"
        + (
            f"; {len(pre_encoded)} already encoded by BookForge"
            if pre_encoded
            else ""
        )
    )
    if not todo:
        # With every chapter pre-encoded there is no encode to report on at all,
        # so say so once rather than leaving the bar parked where it was.
        log("Export - 100.0%")

    def work(item: tuple[int, ChapterPlan]) -> tuple[int, str, str | None]:
        i, plan = item
        list_path = os.path.join(chunk_dir, f"{plan.index}.txt")
        out_path = os.path.join(chunk_dir, f"{plan.index}.m4a")
        try:
            write_concat_list(plan.paths, list_path)
            encode_chapter(ffmpeg, list_path, out_path, channels)
            actual = probe_duration(out_path, ffprobe)
            # concat_tolerance, NOT PRE_ENCODED_TOLERANCE_S: this is the guard
            # concat_tolerance was ported for. ffmpeg has just consumed a concat
            # list, and the demuxer can drop inputs and still exit 0 - the
            # question here is "did all N files reach the encoder", which scales
            # with N. Whether the chapter is the RIGHT chapter is not in doubt:
            # we built the list from this plan a line ago.
            check_duration(
                actual,
                plan.duration(sample_rate),
                concat_tolerance(len(plan.paths)),
                f"chapter {plan.index} encode",
                out_path,
            )
        except Exception as e:  # noqa: BLE001 - reported per chapter, then fatal
            return i, out_path, str(e)
        return i, out_path, None

    completed = 0
    failures: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, item) for item in todo]
        for fut in concurrent.futures.as_completed(futures):
            i, out_path, err = fut.result()
            if err is not None:
                failures.append(f"chapter {plans[i].index}: {err}")
            else:
                outputs[i] = out_path
            completed += 1
            log(f"Export - {completed / len(todo) * 100:.1f}%")

    if failures:
        raise FfmpegError(
            f"{len(failures)} chapter encode(s) failed:\n  "
            + "\n  ".join(failures[:10])
        )
    missing = [plans[i].index for i, p in enumerate(outputs) if p is None]
    if missing:
        raise FfmpegError(f"no encoded audio for chapter(s) {missing}")
    return [p for p in outputs if p is not None]


def concat_encoded(
    chapter_paths: list[str],
    metadata_file: str,
    cover: str | None,
    out_path: str,
    work_dir: str,
    ffmpeg: str,
    log,
) -> None:
    """Stream-copy the encoded chapters together and mux the chapter atoms, the
    cover and the tags in ONE pass.

    Ported from ebook2audiobook@9daab0ba lib/core.py:4504-4522, plus the cover
    (which e2a bolts on afterwards with mutagen).
    """
    concat_list = write_concat_list(
        chapter_paths, os.path.join(work_dir, "concat_list_encoded.txt")
    )
    cmd = [
        ffmpeg, "-hide_banner", "-nostats", "-v", "error",
        "-f", "concat", "-safe", "0", "-i", concat_list,
        "-f", "ffmetadata", "-i", metadata_file,
        "-map", "0:a", "-c:a", "copy",
        "-map_metadata", "1",
        "-movflags", MOVFLAGS,
        "-threads", "0",
        "-y", out_path,
    ]
    log("[assembly] Concatenating encoded chapters (stream copy)")
    run(cmd, "final concat")
    attach_cover(out_path, cover, log)


def encode_serial(
    plans: list[ChapterPlan],
    metadata_file: str,
    cover: str | None,
    out_path: str,
    work_dir: str,
    ffmpeg: str,
    channels: int,
    source_duration: float,
    post_render_filter: str | None,
    final_denoise: bool,
    log,
) -> None:
    """One encode of the whole book, with e2a's filter chain.

    Ported from ebook2audiobook@9daab0ba lib/core.py:export_audio:4222. e2a first
    concatenates every chapter FLAC into one whole-book FLAC and encodes that;
    narrator hands ffmpeg the sentence FLACs through the concat demuxer, which is
    the same PCM without the intermediate.

    Filter order is e2a's: the raw hiss bed is denoised and the per-voice
    corrective chain runs BEFORE loudnorm measures and normalizes the result.
    Above the 2 h cutoff loudnorm is skipped entirely (it measures the whole file
    in memory); the streaming pre-filters still run.
    """
    all_paths = [p for plan in plans for p in plan.paths]
    concat_list = write_concat_list(
        all_paths, os.path.join(work_dir, "concat_list_sentences.txt")
    )

    pre_filters = []
    if final_denoise:
        log(f"[assembly] FINAL_DENOISE active: {FINAL_DENOISE_FILTER}")
        pre_filters.append(FINAL_DENOISE_FILTER)
    if post_render_filter:
        log(f"[assembly] post_render_filter active: {post_render_filter}")
        pre_filters.append(post_render_filter)

    if source_duration > LOUDNORM_CUTOFF_S:
        log(
            f"[assembly] Skipping loudnorm for a long audiobook "
            f"({source_duration / 3600:.1f} hours) to avoid measuring it in memory"
        )
        filters = list(pre_filters)
    else:
        filters = pre_filters + [LOUDNORM_FILTER]

    cmd = [
        ffmpeg, "-hide_banner", "-nostats",
        "-thread_queue_size", "1024",
        "-f", "concat", "-safe", "0", "-i", concat_list,
        "-f", "ffmetadata", "-i", metadata_file,
        "-map", "0:a",
        *_aac_args(channels),
        "-movflags", MOVFLAGS,
        "-map_metadata", "1",
    ]
    if filters:
        cmd += ["-filter_threads", "0", "-af", ",".join(filters)]
    cmd += ["-threads", "0", "-progress", "pipe:1", "-y", out_path]

    _run_with_progress(cmd, source_duration, "serial encode", log)
    attach_cover(out_path, cover, log)


def _run_with_progress(cmd: list[str], total_seconds: float, what: str, log) -> None:
    """Run ffmpeg with `-progress pipe:1` and report `Export - N%`.

    stderr goes to a temp file rather than a pipe: with stdout already being read
    line by line, a second unread pipe is how a long encode deadlocks against
    ffmpeg's own buffer.
    """
    last_pct = -1.0
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errf:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=errf, text=True,
            encoding="utf-8", errors="replace", bufsize=1,
        )
        assert proc.stdout is not None
        stdout = proc.stdout
        for line in stdout:
            line = line.strip()
            value = None
            if line.startswith("out_time_us="):
                raw = line.split("=", 1)[1]
                if raw.isdigit():
                    value = int(raw) / 1_000_000.0
            elif line.startswith("out_time_ms="):
                raw = line.split("=", 1)[1]
                if raw.isdigit():
                    # ffmpeg's out_time_ms is microseconds despite the name.
                    value = int(raw) / 1_000_000.0
            if value is not None and total_seconds > 0:
                pct = min(100.0, value / total_seconds * 100.0)
                if pct - last_pct >= 0.5:
                    last_pct = pct
                    log(f"Export - {pct:.1f}%")
        stdout.close()
        code = proc.wait()
        if code != 0:
            errf.seek(0)
            tail = errf.read()[-1200:]
            raise FfmpegError(
                f"{what} failed (exit {code}):\n"
                f"  command: {' '.join(cmd)}\n"
                f"  stderr: {tail.strip()}"
            )
    log("Export - 100.0%")


def verify_export(out_path: str, source_duration: float, ffprobe: str) -> float:
    """The finished-file guard. Ported from lib/core.py:finalize_export:4342.

    exit-0 + file-exists proves nothing about completeness: ffmpeg can stop
    mid-encode and still FINALIZE a valid, playable, truncated file. Hold the
    export to the same standard as the concat - it must carry the whole input's
    duration.
    """
    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        raise FfmpegError(f"{os.path.basename(out_path)} is missing or empty: {out_path}")
    actual = probe_duration(out_path, ffprobe)
    check_duration(actual, source_duration, EXPORT_TOLERANCE_S, "export", out_path)
    return actual
