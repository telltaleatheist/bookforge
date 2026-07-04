"""Transcribe an audiobook into a synced WebVTT using faster-whisper.

Invoked by electron/transcribe-bridge.ts in the bundled e2a env (the whisper
overlay adds faster-whisper + av; ctranslate2 is already bundled). Decodes an audio
file (m4b/mp3/…) to a 16 kHz mono waveform, runs faster-whisper with word
timestamps IN BOUNDED WINDOWS, groups words into sentence cues, and writes a WebVTT
to the explicit OUT path. Progress is printed as `PROGRESS <frac> <processedSec>
<totalSec> <cueCount>` lines; coarse phases as `STAGE <name>`; the chosen device as
`DEVICE <cuda|cpu>`; the final status as a single JSON line.

Why windows and not one call: handing model.transcribe() an 18 h file makes
faster-whisper's feature extractor frame the WHOLE signal into a single array —
(1, ~6.5M, 400) float64 ≈ 19 GiB — which OOMs. Decoding once and transcribing in
~15 min windows keeps peak memory independent of book length.

This runs in its OWN process (never alongside a torch/TTS worker) — see the cuDNN
gotcha in the project notes: faster-whisper + torch-TTS in one process corrupts CUDA.

Usage:
  python transcribe_audiobook.py --audio <path> --model-dir <dir> --out <vtt>
                                 [--language auto|en|de|…] [--device auto|cpu|cuda]
"""
import argparse
import json
import os
import re
import sys
import time


# Sentence-final punctuation (incl. common closing quotes/brackets after the mark).
_SENT_END = re.compile(r'[.!?…]["”’\')\]]*$')
# A cue that grew too long without hitting punctuation is force-flushed here so the
# reader never has a runaway highlight (rare: unpunctuated OCR-ish speech).
_MAX_CUE_CHARS = 240

# faster-whisper works at 16 kHz mono. We transcribe in CHUNK_SEC windows, each
# extended by OVERLAP_SEC so a sentence straddling a cut is still spoken in full
# inside the window (the duplicate the next window makes is removed in the merge).
SAMPLE_RATE = 16000
# Overridable for low-RAM machines / testing; 15 min windows keep the per-window
# feature array ~0.3 GiB regardless of how long the book is.
CHUNK_SEC = int(os.environ.get('BOOKFORGE_WHISPER_CHUNK_SEC', '900'))
OVERLAP_SEC = int(os.environ.get('BOOKFORGE_WHISPER_OVERLAP_SEC', '15'))


def _fmt(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f'{h:02}:{m:02}:{s:06.3f}'


def _emit_progress(frac: float, processed: float, total: float, cues: int) -> None:
    """A progress line the bridge parses. Includes processed/total audio seconds and
    the running cue count so a long book shows a MOVING position even while the
    percentage is still rounding to 0 (18 h book → 0.5% is ~5 min of audio)."""
    frac = max(0.0, min(1.0, frac))
    sys.stdout.write(f'PROGRESS {frac:.4f} {processed:.1f} {total:.1f} {cues}\n')
    sys.stdout.flush()


def _emit_stage(name: str) -> None:
    """A coarse phase marker for the silent front-load (model load + full-file
    decode) that happens before the first segment, so the UI never sits blank."""
    sys.stdout.write(f'STAGE {name}\n')
    sys.stdout.flush()


def _emit_device(device: str) -> None:
    sys.stdout.write(f'DEVICE {device}\n')
    sys.stdout.flush()


def _resolve_device(requested: str) -> str:
    if requested in ('cpu', 'cuda'):
        return requested
    # auto: use CUDA only if CTranslate2 sees a device (no torch import — avoids the
    # cuDNN conflict and keeps this process light).
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return 'cuda'
    except Exception:
        pass
    return 'cpu'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--model-dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--language', default='auto')
    ap.add_argument('--device', default='auto')
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'faster-whisper not installed: {e}'}))
        return 1

    device = _resolve_device(args.device)
    compute_type = 'float16' if device == 'cuda' else 'int8'

    _emit_stage('loading')
    try:
        model = WhisperModel(args.model_dir, device=device, compute_type=compute_type)
    except Exception as e:
        # A GPU compute_type can fail on some drivers — fall back to CPU int8 once.
        if device == 'cuda':
            try:
                model = WhisperModel(args.model_dir, device='cpu', compute_type='int8')
                device = 'cpu'
            except Exception as e2:
                print(json.dumps({'ok': False, 'error': f'could not load model: {e2}'}))
                return 1
        else:
            print(json.dumps({'ok': False, 'error': f'could not load model: {e}'}))
            return 1

    # Tell the UI where it landed (cuda vs cpu) as soon as the model is loaded.
    _emit_device(device)

    language = None if args.language in ('auto', '', None) else args.language

    # Decode the whole file to a 16 kHz mono waveform ONCE (a compact float32 array),
    # rather than letting model.transcribe() decode + frame the entire 18 h file at
    # once. This is the phase that used to blow up (see module docstring).
    _emit_stage('decoding')
    try:
        audio = decode_audio(args.audio, sampling_rate=SAMPLE_RATE)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'could not decode audio: {e}'}))
        return 1

    total = len(audio) / float(SAMPLE_RATE)
    if total <= 0:
        print(json.dumps({'ok': False, 'error': 'audio decoded to zero length'}))
        return 1

    _emit_stage('transcribing')
    _emit_progress(0.0, 0.0, total, 0)

    cues = []  # (abs_start, abs_end, text) in absolute book time
    last_emit = -1.0
    last_wall = time.time()

    def group_segments(segments, offset: float) -> None:
        """Group one window's word-timestamped segments into sentence cues, shifting
        every timestamp by `offset` seconds to absolute book time, and drive progress
        as segments arrive. Appends to the outer `cues`."""
        nonlocal last_emit, last_wall
        cur_words = []
        cur_start = None
        cur_end = None

        def flush():
            nonlocal cur_words, cur_start, cur_end
            if cur_words and cur_start is not None:
                text = re.sub(r'\s+', ' ', ''.join(cur_words)).strip()
                if text:
                    cues.append((cur_start, cur_end, text))
            cur_words = []
            cur_start = None
            cur_end = None

        for seg in segments:
            words = getattr(seg, 'words', None)
            if words:
                for w in words:
                    if cur_start is None:
                        cur_start = offset + float(w.start)
                    cur_end = offset + float(w.end)
                    cur_words.append(w.word)
                    if _SENT_END.search(w.word.strip()) or sum(len(x) for x in cur_words) >= _MAX_CUE_CHARS:
                        flush()
            else:
                # No word timestamps for this segment — emit it as one cue.
                flush()
                txt = re.sub(r'\s+', ' ', str(seg.text)).strip()
                if txt:
                    cues.append((offset + float(seg.start), offset + float(seg.end), txt))
            # Position from this segment's end (absolute), clamped to the book length.
            processed = min(total, offset + float(seg.end))
            now = time.time()
            frac = processed / total if total > 0 else 0.0
            if frac - last_emit >= 0.002 or (now - last_wall) >= 1.5:
                last_emit = frac
                last_wall = now
                _emit_progress(frac, processed, total, len(cues))
        flush()

    try:
        start_sec = 0.0
        while start_sec < total:
            boundary_end = min(start_sec + CHUNK_SEC, total)
            a = int(start_sec * SAMPLE_RATE)
            b = int(min(boundary_end + OVERLAP_SEC, total) * SAMPLE_RATE)
            segments, _info = model.transcribe(
                audio[a:b],
                language=language,
                word_timestamps=True,
                vad_filter=True,
            )
            group_segments(segments, start_sec)
            start_sec = boundary_end
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'transcription failed mid-stream: {e}'}))
        return 1

    # Merge windows: sort by start and drop any cue that begins inside an already-kept
    # cue's span — those are the boundary duplicates the back-overlap produces.
    cues.sort(key=lambda c: c[0])
    merged = []
    for (s, e, t) in cues:
        if merged and s < merged[-1][1] - 0.1:
            continue
        merged.append((s, e, t))
    cues = merged

    if not cues:
        print(json.dumps({'ok': False, 'error': 'transcription produced no text'}))
        return 1

    try:
        lines = ['WEBVTT', '']
        for (start, end, text) in cues:
            lines.append(f'{_fmt(start)} --> {_fmt(end)}')
            lines.append(text)
            lines.append('')
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'could not write VTT: {e}'}))
        return 1

    _emit_progress(1.0, total, total, len(cues))
    print(json.dumps({'ok': True, 'out': args.out, 'cues': len(cues), 'device': device}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
