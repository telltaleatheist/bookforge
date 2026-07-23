#!/usr/bin/env python
"""Normalize inter-sentence gaps on a directory of RAW cached TTS sentences.

WHY: Orpheus renders each sentence as a lossless FLAC and e2a bakes an ARTIFICIAL
trailing silence pad onto it (orpheus.py: `trail_pad = torch.zeros(1, int(sr *
trail_gap))` appended after the model audio, default trail_gap 0.6s). The model
ALSO produces its own ~0.83s trailing tail, so that pad is redundant double-counting
— the real inter-sentence gap ends up ~1.48s vs ~0.70s in the human source.

THE CLEAN TRICK: the artificial pad is EXACTLY 0.0 samples (torch.zeros, written
losslessly to FLAC), while the model's own audio + trained tail is never exactly
0.0. So "strip the pad" == trim trailing samples that are exactly 0 across all
channels; the model's trained tail is preserved untouched. Then append a chosen
amount of fresh silence (`gap_seconds`).

CRITICAL: this ONLY works on the RAW cached sentences. The denoise pass turns those
exact zeros into tiny non-zero values, so gap-normalization MUST run BEFORE denoise
(the bridge enforces the ordering).

Usage: normalize_gaps.py <in_dir> <out_dir> <gap_seconds>

For each `{i}.flac` / `{i}.wav` and legacy `sentence_{i}.flac` / `sentence_{i}.wav`
in <in_dir>: read it, drop the trailing exact-zero pad, append round(gap_seconds *
sr) zero samples, and write to <out_dir>/<same name> preserving sample rate, channel
count, and subtype. Any OTHER file in <in_dir> is copied verbatim.

NO FALLBACKS: a missing <in_dir>, or any read/write failure (named with the file),
exits non-zero. Nothing is silently skipped.
"""
import os
import re
import shutil
import statistics
import sys

import numpy as np
import soundfile as sf

# A cached sentence file (numbered, new `{i}` or legacy `sentence_{i}` form).
SENTENCE_RE = re.compile(r'^(?:\d+|sentence_\d+)\.(?:flac|wav)$', re.IGNORECASE)

# soundfile read dtype per subtype, chosen so the round-trip is LOSSLESS (integer
# subtypes read as ints; float subtypes as floats). Unknown subtypes fall back to
# float64, which still detects the exact-zero pad correctly (0 int -> 0.0 float).
SUBTYPE_DTYPE = {
    'PCM_16': 'int16',
    'PCM_24': 'int32',
    'PCM_32': 'int32',
    'FLOAT': 'float32',
    'DOUBLE': 'float64',
}


def normalize_one(in_path, out_path, gap_seconds):
    """Strip the trailing exact-zero pad, append `gap_seconds` of silence, write.

    Returns the number of trailing-zero frames trimmed (for the summary stats).
    Raises on any read/write failure — the caller turns that into a non-zero exit.
    """
    info = sf.info(in_path)
    subtype = info.subtype
    dtype = SUBTYPE_DTYPE.get(subtype, 'float64')

    # always_2d -> (frames, channels); mono stays (frames, 1) so the zero-pad shape
    # and the write both preserve the original channel count.
    data, sr = sf.read(in_path, dtype=dtype, always_2d=True)
    n_frames, n_channels = data.shape

    # Last frame index with ANY non-zero channel = end of real audio + model tail.
    # Everything after it is the exact-zero pad (torch.zeros), which we drop.
    nonzero_frames = np.nonzero(np.any(data != 0, axis=1))[0]
    last = int(nonzero_frames[-1]) if nonzero_frames.size else -1
    core = data[:last + 1]
    trimmed = n_frames - core.shape[0]

    gap_frames = int(round(gap_seconds * sr))
    pad = np.zeros((gap_frames, n_channels), dtype=data.dtype)
    out = np.concatenate([core, pad], axis=0)

    sf.write(out_path, out, sr, subtype=subtype)
    return trimmed


def main(argv):
    if len(argv) != 3:
        sys.stderr.write('usage: normalize_gaps.py <in_dir> <out_dir> <gap_seconds>\n')
        return 2
    in_dir, out_dir, gap_arg = argv
    try:
        gap_seconds = float(gap_arg)
    except ValueError:
        sys.stderr.write(f'gap_seconds is not a number: {gap_arg!r}\n')
        return 2
    if gap_seconds < 0:
        sys.stderr.write(f'gap_seconds must be >= 0: {gap_seconds}\n')
        return 2

    if not os.path.isdir(in_dir):
        sys.stderr.write(f'input directory not found: {in_dir}\n')
        return 1

    os.makedirs(out_dir, exist_ok=True)

    processed = 0
    copied = 0
    trims = []
    for name in sorted(os.listdir(in_dir)):
        src = os.path.join(in_dir, name)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(out_dir, name)
        if SENTENCE_RE.match(name):
            try:
                trims.append(normalize_one(src, dst, gap_seconds))
            except Exception as e:  # noqa: BLE001 -- surface the file + reason, then fail
                sys.stderr.write(f'failed on {name}: {e}\n')
                return 1
            processed += 1
        else:
            # Non-audio (e.g. a manifest) rides along verbatim so the output dir is a
            # complete stand-in for the input dir.
            try:
                shutil.copy2(src, dst)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f'failed to copy {name}: {e}\n')
                return 1
            copied += 1

    if processed == 0:
        sys.stderr.write(f'no sentence files (*.flac/*.wav) in {in_dir}\n')
        return 1

    median_trim = int(statistics.median(trims)) if trims else 0
    print(f'normalize_gaps: {processed} sentence(s) processed, {copied} file(s) copied, '
          f'gap={gap_seconds}s, median trailing-zeros trimmed={median_trim}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
