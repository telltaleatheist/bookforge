#!/usr/bin/env python
"""Spectral blend of the Enhance tab's two speech stems.

Why this exists: Resemble Enhance re-synthesizes the waveform phase-decorrelated
and micro-shifted from its input, so a time-domain crossfade of the denoised and
enhanced speech at intermediate gains sums two unaligned copies of the same
voice — audible doubling plus comb-filter mud (measured ~50% worse on the
flutter metric than either endpoint). Intermediate Speech-slider values are
therefore blended in the STFT domain instead:

    |X|   = k * |enhanced| + (1 - k) * |denoised|   (magnitude interpolation)
    phase = angle(STFT(denoised))                   (phase from the NATURAL side)
    x     = iSTFT(|X| * e^{j*phase})

Phase source is the DENOISED (natural) stem, not the enhanced (synthetic) render:
Owen A/B'd identical 50% blends and denoised-phase clearly won (0.40 vs 0.56
flutter). The enhancer's phase carries its re-synthesis artefacts; borrowing the
natural stem's phase and only lending the enhancer's magnitude keeps the blend
clean.

Endpoints never reach this script — k=0/k=1 use voice_denoised.wav /
voice_enhanced.wav directly (pure copies) in the export mixer.

Runs inside the resemble-enhance env (numpy + librosa + soundfile are already
there). Invoked by electron/enhance-bridge.ts:

    python enhance_spectral_blend.py --voice v.wav --enhanced e.wav \
        --output blend.wav --k 0.35

Large-file design: stems can exceed 1 GB, so audio is processed in hop-aligned
blocks with an n_fft*4 context pad on each side; only the interior of each
block is written, so every kept sample sees the exact same STFT frames it would
in a whole-file transform (the pad exceeds the analysis window) and block
joints are seamless. Peak memory is a few hundred MB regardless of file size.

Progress lines: "BLEND <pct>%" on stdout (parsed by the bridge).
"""

import argparse
import sys

import librosa
import numpy as np
import soundfile as sf

N_FFT = 2048
HOP = 512
# Block interior kept per iteration (hop-aligned). ~48.7 s @ 44.1 kHz.
BLOCK = HOP * 4096
# Context pad on each side so kept frames match a whole-file STFT exactly.
PAD = N_FFT * 4


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def read_context(f: sf.SoundFile, lo: int, hi: int) -> np.ndarray:
    """Read [lo, hi) as float32 (samples, ch).

    The caller clamps lo/hi to the blend range — deliberately NO synthetic
    zero-padding at the file edges: the first/last chunk must start/end exactly
    at the signal boundary so the STFT's own center-padding there matches a
    whole-file transform (fabricated zero context adds edge frames a whole-file
    STFT never has, audibly warping the first/last ~n_fft/2 samples).
    """
    f.seek(lo)
    return f.read(hi - lo, dtype="float32", always_2d=True)


def match_channels(a: np.ndarray, channels: int) -> np.ndarray:
    """Tile a mono chunk up to `channels`; anything else mismatched is an error upstream."""
    if a.shape[1] == channels:
        return a
    return np.tile(a, (1, channels))


def main() -> None:
    ap = argparse.ArgumentParser(description="STFT-domain blend of voice/enhanced speech stems")
    ap.add_argument("--voice", required=True, help="k=0 endpoint stem (the denoised speech floor)")
    ap.add_argument("--enhanced", required=True, help="Resemble-enhanced stem (k=1 endpoint, phase source)")
    ap.add_argument("--output", required=True, help="blended WAV to write")
    ap.add_argument("--k", type=float, required=True, help="blend factor in (0, 1)")
    args = ap.parse_args()

    k = args.k
    if not (0.0 < k < 1.0):
        fail(f"--k must be strictly between 0 and 1 for a blend (got {k}); endpoints are plain file copies")

    fv = sf.SoundFile(args.voice)
    fe = sf.SoundFile(args.enhanced)

    if fv.samplerate != fe.samplerate:
        # Both stems come from this pipeline (44.1 kHz decode → separator → enhancer),
        # so differing rates mean the enhancer contract changed — surface it, don't
        # silently resample one side of a phase-sensitive operation.
        fail(
            f"sample-rate mismatch: voice={fv.samplerate} enhanced={fe.samplerate} — "
            "the stems must share a rate to blend"
        )
    sr = fe.samplerate

    channels = max(fv.channels, fe.channels)
    if fv.channels != fe.channels and min(fv.channels, fe.channels) != 1:
        fail(f"channel-count mismatch: voice={fv.channels} enhanced={fe.channels}")

    # The enhancer may emit a slightly different length than its input; blend the
    # overlap (the difference is a re-synthesis tail of at most a frame or two).
    total = min(len(fv), len(fe))
    if total <= 0:
        fail("one of the stems is empty")

    window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)

    with sf.SoundFile(args.output, "w", samplerate=sr, channels=channels, subtype="PCM_24") as out:
        n_blocks = (total + BLOCK - 1) // BLOCK
        for bi in range(n_blocks):
            start = bi * BLOCK
            end = min(total, start + BLOCK)
            # Context window, clamped to the blend range (never zero-padded — see
            # read_context). lo stays hop-aligned: start and PAD are HOP multiples.
            lo = max(0, start - PAD)
            hi = min(total, end + PAD)

            cv = match_channels(read_context(fv, lo, hi), channels)
            ce = match_channels(read_context(fe, lo, hi), channels)

            n = min(len(cv), len(ce))
            cv, ce = cv[:n], ce[:n]

            mixed = np.empty_like(ce)
            for ch in range(channels):
                # sd = denoised (--voice, the natural/phase side), se = enhanced.
                sd = librosa.stft(cv[:, ch], n_fft=N_FFT, hop_length=HOP, window=window)
                se = librosa.stft(ce[:, ch], n_fft=N_FFT, hop_length=HOP, window=window)
                frames = min(sd.shape[1], se.shape[1])
                sd, se = sd[:, :frames], se[:, :frames]

                mag = k * np.abs(se) + (1.0 - k) * np.abs(sd)
                phase = np.exp(1j * np.angle(sd))  # phase from the natural (denoised) side
                mixed[:, ch] = librosa.istft(
                    mag * phase, n_fft=N_FFT, hop_length=HOP, window=window, length=n
                )

            # Keep only this block's interior: the context is re-rendered by
            # neighbours. keep_from is PAD except at the file head, where the
            # chunk starts at the signal edge itself.
            keep_from = start - lo
            out.write(mixed[keep_from : keep_from + (end - start)])

            print(f"BLEND {int(((bi + 1) / n_blocks) * 100)}%", flush=True)

    print("BLEND done", flush=True)


if __name__ == "__main__":
    main()
