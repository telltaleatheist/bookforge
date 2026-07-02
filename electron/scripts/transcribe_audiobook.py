"""Transcribe an audiobook into a synced WebVTT using faster-whisper.

Invoked by electron/transcribe-bridge.ts in the bundled e2a env (the whisper
overlay adds faster-whisper + av; ctranslate2 is already bundled). Reads an audio
file (m4b/mp3/…; PyAV decodes it), runs faster-whisper with word timestamps, groups
words into sentence cues, and writes a WebVTT next to nothing — the OUT path is
given explicitly. Progress is printed as `PROGRESS <fraction 0..1>` lines that the
bridge parses; the final status is a single JSON line.

This runs in its OWN process (never alongside a torch/TTS worker) — see the cuDNN
gotcha in the project notes: faster-whisper + torch-TTS in one process corrupts CUDA.

Usage:
  python transcribe_audiobook.py --audio <path> --model-dir <dir> --out <vtt>
                                 [--language auto|en|de|…] [--device auto|cpu|cuda]
"""
import argparse
import json
import re
import sys


# Sentence-final punctuation (incl. common closing quotes/brackets after the mark).
_SENT_END = re.compile(r'[.!?…]["”’\')\]]*$')
# A cue that grew too long without hitting punctuation is force-flushed here so the
# reader never has a runaway highlight (rare: unpunctuated OCR-ish speech).
_MAX_CUE_CHARS = 240


def _fmt(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f'{h:02}:{m:02}:{s:06.3f}'


def _emit_progress(frac: float) -> None:
    frac = max(0.0, min(1.0, frac))
    sys.stdout.write(f'PROGRESS {frac:.4f}\n')
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
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'faster-whisper not installed: {e}'}))
        return 1

    device = _resolve_device(args.device)
    compute_type = 'float16' if device == 'cuda' else 'int8'

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

    language = None if args.language in ('auto', '', None) else args.language

    try:
        segments, info = model.transcribe(
            args.audio,
            language=language,
            word_timestamps=True,
            vad_filter=True,
        )
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'transcription failed: {e}'}))
        return 1

    total = float(getattr(info, 'duration', 0.0)) or 0.0

    cues = []  # (start, end, text)
    cur_words = []   # list of (text) with running start/end
    cur_start = None
    cur_end = None

    def flush():
        nonlocal cur_words, cur_start, cur_end
        if not cur_words or cur_start is None:
            cur_words = []
            cur_start = None
            cur_end = None
            return
        text = re.sub(r'\s+', ' ', ''.join(cur_words)).strip()
        if text:
            cues.append((cur_start, cur_end, text))
        cur_words = []
        cur_start = None
        cur_end = None

    last_emit = 0.0
    try:
        for seg in segments:
            words = getattr(seg, 'words', None)
            if words:
                for w in words:
                    if cur_start is None:
                        cur_start = float(w.start)
                    cur_end = float(w.end)
                    cur_words.append(w.word)
                    stripped = w.word.strip()
                    joined_len = sum(len(x) for x in cur_words)
                    if _SENT_END.search(stripped) or joined_len >= _MAX_CUE_CHARS:
                        flush()
            else:
                # No word timestamps for this segment — emit it as one cue.
                flush()
                txt = re.sub(r'\s+', ' ', str(seg.text)).strip()
                if txt:
                    cues.append((float(seg.start), float(seg.end), txt))
            # Progress from the segment end vs total duration.
            if total > 0:
                frac = float(seg.end) / total
                if frac - last_emit >= 0.005:
                    last_emit = frac
                    _emit_progress(frac)
        flush()
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'transcription failed mid-stream: {e}'}))
        return 1

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

    _emit_progress(1.0)
    print(json.dumps({'ok': True, 'out': args.out, 'cues': len(cues), 'device': device}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
