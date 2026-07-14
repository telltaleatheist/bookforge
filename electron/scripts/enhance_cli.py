#!/usr/bin/env python
"""Resemble Enhance CLI — the BookForge Enhance tab's denoise/enhance worker.

Contract (the app codes against this; later flags are optional extras):
  python enhance_cli.py --input in.wav --output out.wav \
      --nfe <int> --tau <float> --lambd <float> --solver midpoint \
      [--denoise-only] [--pre-denoise] [--chunk-s <float>] [--overlap-s <float>] [--seed <int>] \
      [--smart-chunk] [--seeds <int>] [--anchor]

Production recipe (ear-validated 2026-07-14 on piano + chatter narration benches):
  --nfe 64 --tau 0.75 --lambd 0.1 --smart-chunk --seeds 5 --anchor

Why not RE's own chunking: RE crossfades phase-unaligned resyntheses for 1 s at
each 30 s seam = chorus/wobble. --smart-chunk cuts at SILENCES instead (nothing
voiced ever crossfades), --seeds N renders each chunk N times and takes the
per-frame spectral median (cancels CFM warble; solo renders are seed-luck),
--anchor pins slow tonal balance to the input stem (kills Adobe-style drift).

Cross-platform: CUDA (Windows/Linux) or MPS (Apple Silicon). Refuses CPU-only —
the CFM enhancer is minutes-to-hours per clip on CPU, so no-GPU is a real error.
"""
import argparse
import sys
import time

SR = 44100
N_FFT, HOP = 2048, 512


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--nfe', type=int)
    ap.add_argument('--tau', type=float)
    ap.add_argument('--lambd', type=float)
    ap.add_argument('--solver', default='midpoint', choices=['midpoint', 'rk4', 'euler'])
    ap.add_argument('--denoise-only', action='store_true',
                    help='run only the mask-based denoiser (no generation)')
    ap.add_argument('--pre-denoise', action='store_true',
                    help='run the denoiser first, then enhance the denoised audio')
    ap.add_argument('--chunk-s', type=float, default=30.0,
                    help="legacy mode only: RE's own chunk length (crossfade seams)")
    ap.add_argument('--overlap-s', type=float, default=1.0,
                    help="legacy mode only: RE's own crossfade overlap")
    ap.add_argument('--seed', type=int, default=0,
                    help='base RNG seed (seeds N uses base..base+N-1)')
    ap.add_argument('--smart-chunk', action='store_true',
                    help='cut at silences (no voiced crossfades); required for long files')
    ap.add_argument('--seeds', type=int, default=1,
                    help='renders per chunk; >1 enables spectral-median ensemble (use odd)')
    ap.add_argument('--anchor', action='store_true',
                    help='pin slow tonal balance to the input stem (anti-drift)')
    args = ap.parse_args()
    if not args.denoise_only:
        missing = [n for n in ('nfe', 'tau', 'lambd') if getattr(args, n) is None]
        if missing:
            sys.exit(f'ERROR: --{", --".join(missing)} required unless --denoise-only')
    if args.denoise_only and args.pre_denoise:
        sys.exit('ERROR: --denoise-only and --pre-denoise are mutually exclusive')
    # In --denoise-only mode the mask denoiser is deterministic and non-generative,
    # so --seeds / --anchor simply don't apply (ignored below), NOT an error — the
    # app forwards the same full params dict to both the denoise and enhance stages.
    return args


def resolve_device(torch):
    if torch.cuda.is_available():
        return 'cuda'
    if getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available():
        return 'mps'
    sys.exit('ERROR: no GPU (CUDA or MPS) available — refusing a CPU-only enhance '
             '(minutes-to-hours per clip); check the GPU/driver')


# ---------------------------------------------------------------- chunking

def find_chunks(y, sr, target_s=30.0, max_chunk_s=50.0, min_gap_s=0.25, top_db=40):
    """Cut points inside silent gaps; spans with no usable gap are cut at their
    quietest point (logged loudly — never silently)."""
    import numpy as np
    import librosa

    n = len(y)
    intervals = librosa.effects.split(y, top_db=top_db)
    cands = []
    for i in range(len(intervals) - 1):
        g0, g1 = int(intervals[i][1]), int(intervals[i + 1][0])
        if g1 - g0 >= int(min_gap_s * sr):
            cands.append((g0 + g1) // 2)

    cuts, last = [], 0
    for c in cands:
        if c - last >= int(target_s * sr):
            cuts.append(c)
            last = c

    # enforce max chunk length: forced cut at the quietest point of the middle
    def subdivide(s0, s1):
        if s1 - s0 <= int(max_chunk_s * sr):
            return [s1]
        rms = librosa.feature.rms(y=y[s0:s1], frame_length=N_FFT, hop_length=HOP)[0]
        lo = int(0.2 * len(rms))
        hi = int(0.8 * len(rms))
        cut = s0 + (lo + int(np.argmin(rms[lo:hi]))) * HOP
        print(f'FORCED_CUT no silence gap in {s0/sr:.1f}s-{s1/sr:.1f}s; '
              f'cutting at quietest point {cut/sr:.1f}s', flush=True)
        return subdivide(s0, cut) + subdivide(cut, s1)

    bounds = [0]
    for s0, s1 in zip([0] + cuts, cuts + [n]):
        bounds.extend(subdivide(s0, s1))
    bounds = sorted(set(b for b in bounds if 0 < b <= n)) or [n]
    if bounds[-1] != n:
        bounds.append(n)
    return list(zip([0] + bounds[:-1], bounds))


# ------------------------------------------------------------- stabilizers

def spectral_median(renders):
    """Per-frame magnitude median across renders; phase from the first."""
    import numpy as np
    import librosa

    L = min(len(r) for r in renders)
    Ss = [librosa.stft(r[:L], n_fft=N_FFT, hop_length=HOP) for r in renders]
    med = np.median(np.stack([np.abs(S) for S in Ss]), axis=0)
    return librosa.istft(med * np.exp(1j * np.angle(Ss[0])), hop_length=HOP, length=L)


def envelope_anchor(y_in, y_en, smooth_s=3.0, cap_db=6.0, n_mels=32):
    """Pin y_en's slow per-mel-band tonal balance to y_in's. Bands where the
    input is near-silent are gated to 1.0 (never removes RE's repairs)."""
    import numpy as np
    import librosa

    L = min(len(y_in), len(y_en))
    S_en = librosa.stft(y_en[:L], n_fft=N_FFT, hop_length=HOP)
    S_in = librosa.stft(y_in[:L], n_fft=N_FFT, hop_length=HOP)
    mel = librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=n_mels)
    E_en = mel @ (np.abs(S_en) ** 2)
    E_in = mel @ (np.abs(S_in) ** 2)

    w = max(3, int(smooth_s * SR / HOP) | 1)
    k = np.ones(w) / w
    sm = lambda X: np.apply_along_axis(lambda r: np.convolve(r, k, mode='same'), 1, X)
    E_en_s, E_in_s = sm(E_en), sm(E_in)

    eps = 1e-10
    gain = np.sqrt((E_in_s + eps) / (E_en_s + eps))
    floor = np.percentile(E_in_s, 10, axis=1, keepdims=True) * 3
    gain = np.where(E_in_s < floor, 1.0, gain)
    cap = 10 ** (cap_db / 20)
    gain = np.clip(gain, 1 / cap, cap)

    colsum = mel.sum(axis=0)
    mel_norm = mel / (colsum[None, :] + 1e-12)
    gain_bins = mel_norm.T @ gain
    gain_bins[colsum < 1e-8, :] = 1.0
    return librosa.istft(S_en * gain_bins, hop_length=HOP, length=L)


# -------------------------------------------------------------------- main

def main():
    args = parse_args()

    if sys.platform == 'win32':
        # RE's model_repo hparams.yaml serializes pathlib.PosixPath objects, which
        # cannot be instantiated on Windows. Alias them to WindowsPath for this
        # process — the affected fields are training-data dirs, unused at inference.
        import pathlib
        pathlib.PosixPath = pathlib.WindowsPath

    import numpy as np
    import torch
    import librosa
    import soundfile as sf

    device = resolve_device(torch)
    print(f'DEVICE:{device}', flush=True)

    print(f'STAGE:load {args.input}', flush=True)
    y, _ = librosa.load(args.input, sr=SR, mono=True)

    from pathlib import Path
    import resemble_enhance as _re
    from resemble_enhance.enhancer.inference import load_enhancer
    from resemble_enhance.inference import inference

    # Load the checkpoint bundled in the env (model_repo/enhancer_stage2) by passing
    # it as run_dir, so load_enhancer never calls download(). The shipped env MUST
    # NOT git-clone/lfs-pull from HuggingFace at runtime — download() needs git +
    # network and would fail offline; the weights ride in the conda-packed tarball.
    run_dir = Path(_re.__file__).parent / 'model_repo' / 'enhancer_stage2'
    if not (run_dir / 'hparams.yaml').exists():
        sys.exit(f'ERROR: bundled Resemble Enhance checkpoint missing at {run_dir} '
                 '(the env tarball must include model_repo/enhancer_stage2)')

    t0 = time.time()
    with torch.inference_mode():
        enhancer = load_enhancer(run_dir, device)

        def run_model(model, wav_np, chunk_s, overlap_s, seed):
            torch.manual_seed(seed)
            out, out_sr = inference(model=model, dwav=torch.from_numpy(wav_np), sr=SR,
                                    device=device, chunk_seconds=chunk_s, overlap_seconds=overlap_s)
            assert out_sr == SR, f'expected {SR}, model returned {out_sr}'
            return out.cpu().numpy()

        if args.denoise_only:
            # --seeds/--anchor are generative-stage knobs and don't apply to the
            # deterministic mask denoiser. --smart-chunk IS honoured so the denoised
            # floor uses the SAME silence-cut boundaries as the enhanced render,
            # keeping the per-frame magnitude blend aligned.
            if args.smart_chunk:
                chunks = find_chunks(y, SR)
                print(f'STAGE:denoise smart_chunks={len(chunks)}', flush=True)
                pieces = []
                for i, (s0, s1) in enumerate(chunks):
                    seg = y[s0:s1]
                    piece = run_model(enhancer.denoiser, seg, len(seg) / SR + 10, 1.0, args.seed)
                    if len(piece) < len(seg):
                        piece = np.pad(piece, (0, len(seg) - len(piece)))
                    pieces.append(piece[:len(seg)])
                    print(f'CHUNK {i + 1}/{len(chunks)} ({s0 / SR:.1f}s-{s1 / SR:.1f}s)', flush=True)
                result = np.concatenate(pieces)
            else:
                print('STAGE:denoise', flush=True)
                result = run_model(enhancer.denoiser, y, args.chunk_s, args.overlap_s, args.seed)
        else:
            if args.pre_denoise:
                print('STAGE:pre-denoise', flush=True)
                y = run_model(enhancer.denoiser, y, args.chunk_s, args.overlap_s, args.seed)
            enhancer.configurate_(nfe=args.nfe, solver=args.solver, lambd=args.lambd, tau=args.tau)

            if args.smart_chunk:
                chunks = find_chunks(y, SR)
                print(f'STAGE:enhance nfe={args.nfe} tau={args.tau} lambd={args.lambd} '
                      f'solver={args.solver} smart_chunks={len(chunks)} seeds={args.seeds} '
                      f'anchor={args.anchor}', flush=True)
                pieces = []
                for i, (s0, s1) in enumerate(chunks):
                    seg = y[s0:s1]
                    seg_s = len(seg) / SR
                    renders = [run_model(enhancer, seg, seg_s + 10, 1.0, args.seed + s)
                               for s in range(args.seeds)]
                    piece = spectral_median(renders) if args.seeds > 1 else renders[0]
                    if args.anchor:
                        piece = envelope_anchor(seg, piece)
                    # keep each output chunk exactly input-length so concatenation
                    # can't accumulate drift across chunks
                    if len(piece) < len(seg):
                        piece = np.pad(piece, (0, len(seg) - len(piece)))
                    pieces.append(piece[:len(seg)])
                    print(f'CHUNK {i + 1}/{len(chunks)} ({s0 / SR:.1f}s-{s1 / SR:.1f}s)', flush=True)
                result = np.concatenate(pieces)
            else:
                print(f'STAGE:enhance nfe={args.nfe} tau={args.tau} lambd={args.lambd} '
                      f'solver={args.solver} chunk_s={args.chunk_s} overlap_s={args.overlap_s} '
                      f'seeds={args.seeds} anchor={args.anchor} seed={args.seed}', flush=True)
                renders = [run_model(enhancer, y, args.chunk_s, args.overlap_s, args.seed + s)
                           for s in range(args.seeds)]
                result = spectral_median(renders) if args.seeds > 1 else renders[0]
                if args.anchor:
                    result = envelope_anchor(y, result)

    dt = time.time() - t0
    sf.write(args.output, result, SR, subtype='PCM_24')
    print(f'DONE {args.output} sr={SR} took={dt:.1f}s', flush=True)


if __name__ == '__main__':
    main()
