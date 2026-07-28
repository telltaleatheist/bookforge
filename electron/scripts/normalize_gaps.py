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

UPDATE 2026-07-27 — e2a NO LONGER BAKES THE PAD. ORPHEUS_SENTENCE_GAP is now
derived from the voice's `sentenceGap` (0.0 for every current voice), so
`_classify_gap` returns 0 and `_save_audio` appends nothing. Verified: tonight's
render shows a 0.0199 s median exact-zero pad vs 0.6254 s pre-fix. The strip below
is therefore a NO-OP on new renders and is KEPT only because caches rendered before
today still carry the 0.6 s pad — re-assembling one of those without the strip
would double every join.

THE FLOOR (`min_gap_seconds`, added 2026-07-27). With no pad, a chunk join IS the
model's own trained tail, and that tail varies: measured over 1151 chunks of The
Mysterious Stranger, median 0.81 s but p10 0.39 s and MIN 0.00 s. Owen's ear caught
the short ones colliding. An ADDITIVE gap would fix them but stretch the 78% that
were already right, so instead the floor lifts only the clips below it:
    final trailing silence = max(tail + gap_seconds, min_gap_seconds)

Usage: normalize_gaps.py <in_dir> <out_dir> <gap_seconds> [min_gap_seconds]

For each `{i}.flac` / `{i}.wav` and legacy `sentence_{i}.flac` / `sentence_{i}.wav`
in <in_dir>: read it, drop the trailing exact-zero pad, top the trailing silence up
to the floor, and write to <out_dir>/<same name> preserving sample rate, channel
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


def measure_tail_seconds(core, sr, frame_s=0.010, above_floor_db=12.0):
    """Seconds of trailing QUIET at the end of `core` (the model's own tail).

    Threshold is relative to the clip's OWN NOISE FLOOR (p05 of the frame levels,
    +12 dB) — NOT absolute and NOT relative to the peak.

    WHY: every corpus this pipeline produces now carries a room-tone bed (−70 dBFS
    for thirdreich), so "silence" is not zero and an absolute threshold sees none.
    A peak-relative threshold fails the other way: −45 dB below a −20 dBFS peak
    lands at −65 dBFS, which is ABOVE a −62 dBFS bed, so the bed reads as speech
    and the tail measures ~0. Floor-relative is invariant to how loud the bed is.
    (Measured 2026-07-27: peak-relative reported a 0.10 s tail on Marked Man clips
    whose cut report records 0.90 s.)
    """
    mono = core.mean(axis=1) if core.ndim > 1 else core
    fr = max(1, int(frame_s * sr))
    n = len(mono) // fr
    if n < 3:
        return 0.0
    seg = mono[: n * fr].astype(np.float64).reshape(n, fr)
    rms = np.sqrt((seg ** 2).mean(1))
    db = 20 * np.log10(np.maximum(rms, 1e-12))
    floor = np.percentile(db, 5)
    voiced = np.nonzero(db > (floor + above_floor_db))[0]
    if voiced.size == 0:
        return 0.0
    return (n - 1 - int(voiced[-1])) * frame_s


def normalize_one(in_path, out_path, gap_seconds, min_gap_seconds=0.0):
    """Strip the trailing exact-zero pad, then guarantee the trailing silence.

    Final trailing silence = max(model's own tail + gap_seconds, min_gap_seconds).

    `gap_seconds` is the ADDITIVE inject (usually 0.0 now that clips keep their
    verbatim trained tails). `min_gap_seconds` is a FLOOR: it lifts only the clips
    whose tail is too short and leaves longer ones untouched.

    WHY THE FLOOR (Owen, 2026-07-27, by ear on The Mysterious Stranger): the join
    between chunks IS the model's own tail, and that tail varies a lot — measured
    across 1151 chunks it ran median 0.81 s but p10 0.39 s and MIN 0.00 s. The
    short ones collide audibly ("crammed together"). An additive gap would fix the
    collisions but stretch the 78% that were already right; a floor lifts only the
    bottom. At a 0.55 s floor, 22% of chunks get a mean 0.18 s and the book grows
    ~45 s over 4 hours.

    Returns (trimmed_frames, padded_seconds) for the summary stats.
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
    if nonzero_frames.size == 0:
        # A pure-silence sentence (e2a's _write_silence for an empty/heading line):
        # no model audio to protect and no pad to distinguish. Trimming it to the last
        # non-zero frame would leave an EMPTY array and write an unreadable file, so pass
        # it through unchanged — its silence is intentional content, not a gap pad.
        sf.write(out_path, data, sr, subtype=subtype)
        return 0, 0.0

    last = int(nonzero_frames[-1])
    core = data[:last + 1]
    trimmed = n_frames - core.shape[0]

    # The clip's own trailing quiet, AFTER the artificial pad is gone.
    tail = measure_tail_seconds(core, sr) if min_gap_seconds > 0 else 0.0
    # Additive inject, then lift to the floor if the result is still too short.
    add = max(gap_seconds, min_gap_seconds - tail)
    if add < 0:
        add = 0.0

    gap_frames = int(round(add * sr))
    if gap_frames > 0:
        pad = np.zeros((gap_frames, n_channels), dtype=data.dtype)
        out = np.concatenate([core, pad], axis=0)
    else:
        out = core

    sf.write(out_path, out, sr, subtype=subtype)
    return trimmed, add


def main(argv):
    if len(argv) not in (3, 4):
        sys.stderr.write('usage: normalize_gaps.py <in_dir> <out_dir> <gap_seconds> [min_gap_seconds]\n')
        return 2
    in_dir, out_dir, gap_arg = argv[0], argv[1], argv[2]
    min_arg = argv[3] if len(argv) == 4 else '0'
    try:
        gap_seconds = float(gap_arg)
    except ValueError:
        sys.stderr.write(f'gap_seconds is not a number: {gap_arg!r}\n')
        return 2
    if gap_seconds < 0:
        sys.stderr.write(f'gap_seconds must be >= 0: {gap_seconds}\n')
        return 2
    try:
        min_gap_seconds = float(min_arg)
    except ValueError:
        sys.stderr.write(f'min_gap_seconds is not a number: {min_arg!r}\n')
        return 2
    if min_gap_seconds < 0:
        sys.stderr.write(f'min_gap_seconds must be >= 0: {min_gap_seconds}\n')
        return 2

    if not os.path.isdir(in_dir):
        sys.stderr.write(f'input directory not found: {in_dir}\n')
        return 1

    os.makedirs(out_dir, exist_ok=True)

    processed = 0
    copied = 0
    trims = []
    pads = []
    for name in sorted(os.listdir(in_dir)):
        src = os.path.join(in_dir, name)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(out_dir, name)
        if SENTENCE_RE.match(name):
            try:
                t, added = normalize_one(src, dst, gap_seconds, min_gap_seconds)
                trims.append(t)
                pads.append(added)
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
    lifted = [p for p in pads if p > 0.001]
    floor_note = ''
    if min_gap_seconds > 0:
        floor_note = (f', floor={min_gap_seconds}s lifted {len(lifted)}/{processed} '
                      f'({100.0 * len(lifted) / processed:.0f}%) by mean '
                      f'{statistics.mean(lifted):.3f}s, total +{sum(pads):.1f}s'
                      if lifted else f', floor={min_gap_seconds}s lifted 0/{processed}')
    print(f'normalize_gaps: {processed} sentence(s) processed, {copied} file(s) copied, '
          f'gap={gap_seconds}s, median trailing-zeros trimmed={median_trim}{floor_note}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
