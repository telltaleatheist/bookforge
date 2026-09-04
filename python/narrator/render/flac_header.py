"""Exact FLAC facts from the 42 bytes at the front of the file - never a decode,
never an ffprobe.

Ported from ebook2audiobook@9daab0ba lib/core.py:_read_flac_streaminfo_block /
read_flac_streaminfo / read_flac_duration.

WHY IT MATTERS. A 20-hour book is ~2700 sentence files. Asking ffprobe for each
one was 2700 process spawns (~146 s of pure spawn overhead) and asking pydub was
a complete PCM decode of every chapter. The numbers are sitting in the header:
one 42-byte read each, exact, and verified to 3e-7 s against ffprobe.

THE STREAMINFO BLOCK. After the 4-byte `fLaC` magic comes a metadata block
header (4 bytes: 1 bit last-block flag, 7 bits type, 24 bits length). The FLAC
spec REQUIRES the first metadata block to be STREAMINFO (type 0), 34 bytes:

    byte  0..1    minimum block size
    byte  2..3    maximum block size      <- the concat-demuxer guard reads this
    byte  4..6    minimum frame size
    byte  7..9    maximum frame size
    bit 80..99    sample rate (20 bits)
    bit 100..102  channels - 1 (3 bits)
    bit 103..107  bits per sample - 1 (5 bits)
    bit 108..143  total samples (36 bits)  <- the whole timeline comes from here
    byte 18..33   MD5 of the unencoded audio

NO FALLBACKS. Every one of these raises with the path rather than returning a
zero: a 0.0 does not look like an error to any caller, it looks like silence, and
the VTT, the chapter markers and the duration guard all then draw a confidently
wrong conclusion from it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

STREAMINFO_LEN = 34


@dataclass(frozen=True)
class StreamInfo:
    """Everything the pipeline needs to know about a rendered chunk."""

    path: str
    min_blocksize: int
    max_blocksize: int
    sample_rate: int
    channels: int
    bits_per_sample: int
    samples: int

    @property
    def duration(self) -> float:
        return self.samples / self.sample_rate


def _read_block(path: str) -> bytes:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"FLAC not found: {path}")
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic != b"fLaC":
            raise ValueError(
                f"Not a FLAC file (magic is {magic!r}, expected b'fLaC'): {path}"
            )
        header = f.read(4)
        if len(header) < 4:
            raise ValueError(f"Truncated FLAC metadata block header: {path}")
        block_type = header[0] & 0x7F
        if block_type != 0:
            raise ValueError(
                f"First FLAC metadata block is type {block_type}, not STREAMINFO (0): "
                f"{path}"
            )
        declared = int.from_bytes(header[1:4], "big")
        if declared != STREAMINFO_LEN:
            raise ValueError(
                f"FLAC STREAMINFO block declares {declared} bytes, the spec fixes it at "
                f"{STREAMINFO_LEN}: {path}"
            )
        info = f.read(STREAMINFO_LEN)
        if len(info) < STREAMINFO_LEN:
            raise ValueError(f"Truncated FLAC STREAMINFO block: {path}")
    return info


def read_streaminfo(path: str) -> StreamInfo:
    """Parse the STREAMINFO block. Raises on a non-FLAC, a truncated header, a
    zero sample rate, or a zero sample count."""
    info = _read_block(path)

    min_blocksize = int.from_bytes(info[0:2], "big")
    max_blocksize = int.from_bytes(info[2:4], "big")
    sample_rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4)
    channels = ((info[12] >> 1) & 0x07) + 1
    bits_per_sample = (((info[12] & 0x01) << 4) | (info[13] >> 4)) + 1
    samples = (
        ((info[13] & 0x0F) << 32)
        | (info[14] << 24)
        | (info[15] << 16)
        | (info[16] << 8)
        | info[17]
    )

    if sample_rate == 0:
        raise ValueError(f"FLAC STREAMINFO declares sample rate 0: {path}")
    if samples == 0:
        # 0 means "unknown" in the spec (a stream written without the final
        # rewrite). This pipeline always writes complete files, so it means the
        # file is incomplete or was never finalized.
        raise ValueError(
            f"FLAC STREAMINFO declares total_samples 0 (unknown length) - the file is "
            f"incomplete or was never finalized: {path}"
        )
    return StreamInfo(
        path=path,
        min_blocksize=min_blocksize,
        max_blocksize=max_blocksize,
        sample_rate=sample_rate,
        channels=channels,
        bits_per_sample=bits_per_sample,
        samples=samples,
    )


def read_expected(path: str, sample_rate: int, channels: int = 1) -> StreamInfo:
    """`read_streaminfo`, and additionally refuse a file that is not the shape the
    session says every chunk is.

    A chunk at the wrong sample rate concatenates into audio that plays at the
    wrong speed, and a stereo chunk in a mono set makes ffmpeg's concat demuxer
    drop frames while still exiting 0. Both are silent in every downstream check
    except this one.
    """
    info = read_streaminfo(path)
    if info.sample_rate != sample_rate:
        raise ValueError(
            f"FLAC sample rate is {info.sample_rate} Hz, the session renders at "
            f"{sample_rate} Hz: {path}"
        )
    if info.channels != channels:
        raise ValueError(
            f"FLAC has {info.channels} channel(s), the session renders {channels}: {path}"
        )
    return info


def assert_concat_homogeneous(infos: list[StreamInfo]) -> None:
    """Refuse a set that ffmpeg's concat demuxer would silently damage.

    Ported from ebook2audiobook@9daab0ba lib/core.py:combine_audio_sentences.

    The demuxer drops every FLAC frame whose block size exceeds the FIRST list
    entry's STREAMINFO max-blocksize, AND STILL EXITS 0. A mixed-encoder sentence
    set (say, a book part re-rendered by a different backend) therefore produces a
    shorter audiobook with no error anywhere. A mixed sample rate corrupts timing
    the same way. Both are checked here, before a single byte is handed to ffmpeg.
    """
    if not infos:
        raise ValueError("assert_concat_homogeneous(): nothing to concatenate")

    for attr, label in (
        ("max_blocksize", "max-blocksize"),
        ("sample_rate", "samplerate"),
        ("channels", "channel count"),
    ):
        groups: dict[int, list[str]] = {}
        for info in infos:
            groups.setdefault(getattr(info, attr), []).append(info.path)
        if len(groups) > 1:
            lines = [
                f"FLAC {label} is not homogeneous - ffmpeg concat would silently drop "
                f"frames or corrupt timing:"
            ]
            for value in sorted(groups):
                paths = groups[value]
                lines.append(
                    f"  {label} {value}: {len(paths)} file(s) "
                    f"(e.g. {os.path.basename(paths[0])})"
                )
            raise ValueError("\n".join(lines))
