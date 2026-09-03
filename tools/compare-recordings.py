#!/usr/bin/env python3
"""
Null-test two recordings of the SAME passage — e.g. a 1x tab capture against a
2x speed capture whose file was written at the relabelled rate — and report how
much of the signal survives the subtraction. The question it answers: "does the
speed trick cost anything the training pipeline would see?"

Both files are decoded by ffmpeg to mono float at the TRAINING rate (24 kHz by
default), because that is the only domain that matters: whatever lives above
12 kHz is discarded by the pipeline whichever way the book was recorded.

    python3 tools/compare-recordings.py ref.flac test.flac [--rate 24000] [--png out.png]

Prints: the alignment offset it found, the residual level relative to the
reference (dB — more negative is better; below about -40 dB is inaudible, and
the AAC source itself sits well above that), and a per-band table so a rolloff
near the ceiling shows up as its own row rather than hiding in one number.
"""
import argparse
import subprocess
import sys

import numpy as np
from scipy.signal import fftconvolve, stft


def decode(path: str, rate: int) -> np.ndarray:
    """ffmpeg → mono f32 at `rate`. Downmix and resample are identical for both
    files, so they cancel in the comparison."""
    cmd = [
        'ffmpeg', '-v', 'error', '-i', path,
        '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-acodec', 'pcm_f32le', '-'
    ]
    out = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(out, dtype=np.float32).astype(np.float64)


def align(ref: np.ndarray, test: np.ndarray, max_lag_s: float, rate: int) -> int:
    """Lag (samples) that best lines `test` up with `ref`, by cross-correlation
    over the first minute. Positive = test starts LATER than ref."""
    n = min(len(ref), len(test), rate * 60)
    a = ref[:n] - ref[:n].mean()
    b = test[:n] - test[:n].mean()
    corr = fftconvolve(a, b[::-1], mode='full')
    max_lag = int(max_lag_s * rate)
    centre = len(b) - 1
    window = corr[centre - max_lag: centre + max_lag + 1]
    return int(np.argmax(window)) - max_lag


def db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-12))


def band_table(ref: np.ndarray, resid: np.ndarray, rate: int) -> list[tuple[str, float, float]]:
    """Per-band reference level and residual-to-reference ratio, in dB."""
    edges = [0, 250, 500, 1000, 2000, 4000, 6000, 8000, 10000, 11000, rate // 2]
    f, _, Zr = stft(ref, fs=rate, nperseg=2048)
    _, _, Zt = stft(resid, fs=rate, nperseg=2048)
    pr = np.abs(Zr) ** 2
    pt = np.abs(Zt) ** 2
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (f >= lo) & (f < hi)
        r = pr[sel].mean()
        t = pt[sel].mean()
        rows.append((f'{lo:>5}–{hi:<5} Hz', 10 * np.log10(max(r, 1e-24)), 10 * np.log10(max(t, 1e-24) / max(r, 1e-24))))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('ref')
    ap.add_argument('test')
    ap.add_argument('--rate', type=int, default=24000, help='training sample rate (default 24000)')
    ap.add_argument('--max-lag', type=float, default=20.0, help='seconds of start offset to search')
    ap.add_argument('--png', help='write a residual spectrogram here')
    args = ap.parse_args()

    ref = decode(args.ref, args.rate)
    test = decode(args.test, args.rate)
    lag = align(ref, test, args.max_lag, args.rate)
    if lag >= 0:
        ref_a, test_a = ref[lag:], test
    else:
        ref_a, test_a = ref, test[-lag:]
    n = min(len(ref_a), len(test_a))
    ref_a, test_a = ref_a[:n], test_a[:n]

    # Sub-sample alignment and a level match: the tab's gain is nominally unity
    # both times, but a least-squares scale keeps a 0.1 dB difference from
    # masquerading as a residual.
    scale = float(np.dot(ref_a, test_a) / max(np.dot(test_a, test_a), 1e-12))
    resid = ref_a - scale * test_a

    ref_rms = np.sqrt(np.mean(ref_a ** 2))
    res_rms = np.sqrt(np.mean(resid ** 2))
    print(f'aligned {n / args.rate:.1f} s at {args.rate} Hz; test lags ref by {lag / args.rate:+.3f} s; level match ×{scale:.4f}')
    print(f'reference RMS    {db(ref_rms):7.1f} dBFS')
    print(f'residual RMS     {db(res_rms):7.1f} dBFS')
    print(f'residual / ref   {db(res_rms / max(ref_rms, 1e-12)):7.1f} dB   (below -40 dB: inaudible; -20 dB or worse: something is wrong)')
    print()
    print(f'{"band":>18}   {"ref level":>10}   {"resid/ref":>10}')
    for name, lvl, ratio in band_table(ref_a, resid, args.rate):
        print(f'{name:>18}   {lvl:>8.1f} dB   {ratio:>8.1f} dB')

    if args.png:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(2, 1, figsize=(14, 7), sharex=True)
        for ax, sig, title in ((axes[0], ref_a, 'reference'), (axes[1], resid, 'residual (ref − test)')):
            f, t, Z = stft(sig, fs=args.rate, nperseg=1024)
            ax.pcolormesh(t, f, 20 * np.log10(np.abs(Z) + 1e-9), vmin=-120, vmax=-20, shading='auto')
            ax.set_title(title)
            ax.set_ylabel('Hz')
        axes[1].set_xlabel('s')
        fig.tight_layout()
        fig.savefig(args.png, dpi=110)
        print(f'\nwrote {args.png}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
