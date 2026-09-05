"""Chunk edge treatment for engines that do not pad: fades, and realized gaps.

WHY THIS EXISTS. Orpheus bakes its inter-chunk silence and its own trimmed edges
into every chunk's FLAC, so assembly concatenates and does nothing else. Higgs
emits bare speech: after the codec's sentinel run is content-trimmed, the chunk
edge still sits around -30 dB, and butt-joining two of those clicks audibly. The
engine declares the cure (`engine/protocol.py`: `pads`, `edge_fade_ms`); this
applies it.

THE FADE IS RAISED-COSINE, NOT LINEAR. A linear ramp is continuous in amplitude
but its first derivative jumps at both ends of the ramp, and that corner is
itself a (much smaller) click - it puts a -6 dB/octave spray across the spectrum.
The raised-cosine window `0.5 - 0.5*cos(pi*t)` starts and ends with zero slope,
so amplitude and its derivative are both continuous where the fade meets silence
and where it meets full-scale audio. It is the standard de-click window and costs
one cosine per edge sample.

    fade-in  over N samples:  w[i] = 0.5 - 0.5*cos(pi * (i+1)/(N+1))
    fade-out over N samples:  the same window reversed

The +1 offsets keep the window strictly inside (0, 1): a first sample multiplied
by exactly 0.0 would be a hard zero abutting real audio, which is the artefact
being removed, and a last sample of exactly 1.0 wastes a sample of the window.

SAMPLE-EXACT, ALWAYS. A fade multiplies in place and changes no length. A gap
contributes exactly `round(seconds * sample_rate)` samples. So the VTT's
arithmetic - a float running sum of `gapBefore + samples/rate + gapAfter` - and
the audio agree to within half a sample, and the manifest's `samples` stay true
of the audio that ships.

NOTHING IN THE SESSION IS EVER MODIFIED. Every processed chunk and every silence
frame is written into the assembly's own working directory. The session's chunk
FLACs are read-only inputs; they are the render's cache and other passes (Studio
retakes, training exports, a later re-assembly) read them expecting the bytes the
engine wrote.

HOMOGENEITY COMES FREE. ffmpeg's concat demuxer silently drops FLAC frames whose
blocksize exceeds the first list entry's, which is the reason gap realization was
refused before: a generated silence file would not match the rendered set. Here
it does not have to - when an engine needs edge treatment, EVERY chunk is
rewritten through this module too, so the whole concat list is written by one
encoder with one set of settings and is homogeneous by construction.
"""

from __future__ import annotations

import math
import os

import numpy as np
import soundfile as sf

#: What every file this module writes is encoded as. One writer, one setting, so
#: the concat list it produces cannot be non-homogeneous.
SUBTYPE = "PCM_16"


def raised_cosine_in(n: int) -> np.ndarray:
    """Rising raised-cosine window of `n` samples, strictly inside (0, 1)."""
    if n <= 0:
        return np.ones(0, dtype=np.float64)
    i = np.arange(1, n + 1, dtype=np.float64)
    return 0.5 - 0.5 * np.cos(math.pi * i / (n + 1))


def raised_cosine_out(n: int) -> np.ndarray:
    """Falling raised-cosine window of `n` samples."""
    return raised_cosine_in(n)[::-1]


def fade_samples(ms: float, sample_rate: int) -> int:
    """Window length in samples for a fade of `ms` milliseconds."""
    if ms <= 0:
        return 0
    return int(round(ms * sample_rate / 1000.0))


def apply_edge_fades(data: np.ndarray, fade_in_n: int, fade_out_n: int) -> np.ndarray:
    """Fade both edges of `data` (frames, channels) in place and return it.

    A window longer than the clip is clamped to it, and the two windows are
    clamped so they cannot overlap - a 35 ms treatment on a 20 ms chunk would
    otherwise multiply the middle twice and dig a hole in it. Each half gets at
    most its proportional share of the clip.
    """
    n_frames = data.shape[0]
    if n_frames == 0:
        raise ValueError("apply_edge_fades(): empty audio")

    fade_in_n = max(0, min(fade_in_n, n_frames))
    fade_out_n = max(0, min(fade_out_n, n_frames))
    if fade_in_n + fade_out_n > n_frames:
        total = fade_in_n + fade_out_n
        share_in = int(n_frames * fade_in_n / total)
        fade_in_n, fade_out_n = share_in, n_frames - share_in

    if fade_in_n:
        data[:fade_in_n] *= raised_cosine_in(fade_in_n)[:, None]
    if fade_out_n:
        data[n_frames - fade_out_n:] *= raised_cosine_out(fade_out_n)[:, None]
    return data


def write_faded_chunk(src: str, dst: str, sample_rate: int,
                      fade_in_ms: float, fade_out_ms: float) -> int:
    """Read `src`, fade both edges, write `dst`. Returns the sample count.

    The sample count is asserted to be unchanged: a fade that altered a length
    would desync the manifest from the audio, and every downstream number (the
    VTT, the chapter markers, the duration guards) is computed from the
    manifest.
    """
    data, rate = sf.read(src, dtype="float64", always_2d=True)
    if rate != sample_rate:
        raise ValueError(
            f"chunk is {rate} Hz, the manifest says the book is {sample_rate} Hz: {src}"
        )
    before = data.shape[0]
    apply_edge_fades(
        data,
        fade_samples(fade_in_ms, sample_rate),
        fade_samples(fade_out_ms, sample_rate),
    )
    if data.shape[0] != before:
        raise AssertionError(f"edge fade changed the length of {src}")
    sf.write(dst, data, sample_rate, subtype=SUBTYPE, format="FLAC")
    return before


def write_silence(path: str, frames: int, sample_rate: int, channels: int = 1) -> int:
    """Write `frames` samples of digital silence, with the same encoder settings
    every other file in the concat list is written with."""
    if frames <= 0:
        raise ValueError(f"write_silence(): {frames} frames is not a gap")
    sf.write(
        path,
        np.zeros((frames, channels), dtype=np.float64),
        sample_rate,
        subtype=SUBTYPE,
        format="FLAC",
    )
    return frames


def gap_frames(seconds: float, sample_rate: int) -> int:
    """Samples of silence a gap of `seconds` becomes. The one rounding rule, so
    the audio and the VTT cannot disagree about it."""
    return int(round(seconds * sample_rate))


def edge_dir(work_dir: str, chapter_index: int) -> str:
    """Where a chapter's processed chunks go. Short, because these paths sit
    under an already-deep staging directory (see run.py's WORK_DIRNAME)."""
    path = os.path.join(work_dir, f"e{chapter_index}")
    os.makedirs(path, exist_ok=True)
    return path
