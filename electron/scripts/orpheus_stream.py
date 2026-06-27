#!/usr/bin/env python3
"""
Orpheus Streaming Server for BookForge Play/Listen (and the TTS API server).

The Orpheus counterpart to xtts_stream.py. It loads the Orpheus model ONCE and
serves sentence requests over stdin, emitting base64 PCM16 (24kHz mono) JSON
lines on stdout — the exact wire shape xtts_stream.py uses, so the TypeScript
worker pool / stream scheduler / browser-extension protocol are unchanged.

Unlike XTTS, Orpheus has no token-by-token waveform stream API in this codebase
(vLLM's offline LLM.generate() is batch, MLX yields whole-segment audio). For
the listen feature the "streaming" feel comes from the scheduler pumping one
sentence at a time with read-ahead — so here a sentence is generated WHOLE and,
in 'stream' mode, emitted as a single chunk followed by 'done'. Sentences are
short, so on a warm GPU first-audio latency is ~1s.

This worker REUSES e2a's Orpheus engine class (lib/classes/tts_engines/orpheus.py)
for model loading + token→audio logic, so "if Orpheus audiobooks work on this
machine, Orpheus listen works": same backend detection (MLX / vLLM / transformers),
same vLLM/CUDA-graph setup, same SNAC decode. We call its lower-level generation
methods and keep the audio in memory (no per-sentence WAV files).

Protocol (one JSON object per line):
  stdin:  {action: 'load', voice}
          {action: 'generate', text, stream?: bool, ...}
          {action: 'cancel' | 'stop' | 'quit'}
  stdout: {type: 'ready', device}
          {type: 'status' | 'loaded' | 'error' | 'stopped', ...}
          {type: 'audio', format:'pcm16', data, duration, sampleRate}        # batch
          {type: 'chunk', seq, format:'pcm16', data, duration, sampleRate}   # stream
          {type: 'done', duration, chunks, cancelled}                        # stream end

Voices: tara, leah, jess, leo, dan, mia, zac, zoe (default leah). Switching
voices is free — Orpheus encodes the voice as a prompt prefix, so the model is
loaded once and a 'load' for a different voice only changes the prefix.
"""

import json
import sys
import os
import re
import base64
import numpy as np

DEFAULT_SAMPLERATE = 24000


# ── e2a location (so we can import lib.classes.tts_engines.orpheus) ───────────
def get_e2a_path():
    # Honor the explicit path the spawner passes (Windows→WSL exports the WSL
    # e2a root here; native passes the Windows/Mac e2a root).
    env = os.environ.get('EBOOK2AUDIOBOOK_PATH')
    if env and os.path.isdir(env):
        return env
    # The spawner cd's into the e2a root, so cwd is a reliable fallback.
    cwd = os.getcwd()
    if os.path.isdir(os.path.join(cwd, 'lib', 'classes')):
        return cwd
    home = os.path.expanduser('~')
    for cand in (os.path.join(home, 'ebook2audiobook'),
                 os.path.join(home, 'Projects', 'ebook2audiobook')):
        if os.path.isdir(cand):
            return cand
    return cwd


E2A_PATH = get_e2a_path()
sys.path.insert(0, E2A_PATH)


# ── Text normalization (numbers/currency/years → words) ───────────────────────
# The listen path hands raw page text straight to the model; the e2a audiobook
# path normalizes upstream. Mirror the common cases here so "$5.50", "1995",
# "50%" read naturally. Guarded: if num2words isn't importable, pass through.
try:
    from num2words import num2words as _num2words
    _HAS_NUM2WORDS = True
except Exception:
    _HAS_NUM2WORDS = False


def _to_words(n, lang):
    try:
        return _num2words(int(n), lang=lang)
    except Exception:
        return str(n)


def _num_phrase(token, lang):
    token = token.replace(',', '')
    try:
        if '.' in token:
            intpart, frac = token.split('.', 1)
            words = _num2words(int(intpart or '0'), lang=lang)
            digits = ' '.join(_num2words(int(d), lang=lang) for d in frac)
            return f"{words} point {digits}"
        return _num2words(int(token), lang=lang)
    except Exception:
        return token


def _ordinal(n, lang):
    try:
        return _num2words(int(n), lang=lang, to='ordinal')
    except Exception:
        return str(n)


def _year_to_words(y, lang):
    if lang != 'en':
        return _to_words(y, lang)
    try:
        if 2000 <= y <= 2009:
            return f"two thousand {_to_words(y % 100, lang)}" if y % 100 else "two thousand"
        if 1100 <= y <= 1999 or 2010 <= y <= 2099:
            hi, lo = divmod(y, 100)
            if lo == 0:
                return f"{_to_words(hi, lang)} hundred"
            lo_words = _to_words(lo, lang) if lo >= 10 else f"oh {_to_words(lo, lang)}"
            return f"{_to_words(hi, lang)} {lo_words}"
        return _to_words(y, lang)
    except Exception:
        return str(y)


def normalize_for_tts(text, language='en'):
    if not _HAS_NUM2WORDS or not text:
        return text
    lang = (language or 'en').split('-')[0].lower()
    s = text

    def _money(m):
        whole = m.group(1).replace(',', '')
        cents = m.group(2)
        try:
            dollars = int(whole)
            out = f"{_to_words(dollars, lang)} dollar" + ('' if dollars == 1 else 's')
            if cents:
                c = int(cents.ljust(2, '0')[:2])
                if c:
                    out += f" and {_to_words(c, lang)} cent" + ('' if c == 1 else 's')
            return out
        except Exception:
            return m.group(0)
    s = re.sub(r'\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?', _money, s)
    s = re.sub(r'(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?%',
               lambda m: f"{_num_phrase(m.group(1), lang)} percent", s)
    s = re.sub(r'\b(\d+)(?:st|nd|rd|th)\b', lambda m: _ordinal(m.group(1), lang), s)
    s = re.sub(r'(?<![\d,.])(1[1-9]\d{2}|20\d{2})(?![\d,.])',
               lambda m: _year_to_words(int(m.group(1)), lang), s)
    s = re.sub(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?',
               lambda m: _num_phrase(m.group(0), lang), s)
    return s


# ── stdout protocol ───────────────────────────────────────────────────────────
def send_response(response_type: str, data: dict = None):
    msg = {'type': response_type}
    if data:
        msg.update(data)
    print(json.dumps(msg), flush=True)


def audio_to_pcm16_base64(audio_array) -> str:
    a = np.asarray(audio_array, dtype=np.float32)
    a = np.clip(a, -1.0, 1.0)
    return base64.b64encode((a * 32767).astype(np.int16).tobytes()).decode('utf-8')


# Inter-sentence gap appended to every streamed sentence (seconds). Orpheus trims
# its own trailing pause, so without this sentences run together — and the player
# concatenates them with no gap. A ~0.3s pad gives natural breathing AND masks the
# brief <audio> blob-reload at each sentence boundary (the reload lands in silence).
# Tunable via ORPHEUS_STREAM_GAP (0 disables).
try:
    STREAM_GAP_SEC = max(0.0, float(os.environ.get('ORPHEUS_STREAM_GAP', '0.3')))
except (TypeError, ValueError):
    STREAM_GAP_SEC = 0.3


def finalize_audio(audio_np):
    """Trim Orpheus's long trailing end-pause, normalize, and append a short
    inter-sentence gap so streamed sentences breathe instead of running together
    (the player concatenates chunks with no gap). Keeps a small head and ~150ms
    tail so words aren't clipped."""
    if audio_np is None:
        return None
    a = np.asarray(audio_np, dtype=np.float32).flatten()
    if a.size == 0:
        return a
    thr = 0.01
    idx = np.where(np.abs(a) > thr)[0]
    if idx.size:
        start = max(0, int(idx[0]) - int(DEFAULT_SAMPLERATE * 0.05))
        end = min(a.size, int(idx[-1]) + int(DEFAULT_SAMPLERATE * 0.15))
        a = a[start:end]
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak > 1.0:
        a = a / peak * 0.95
    if STREAM_GAP_SEC > 0:
        a = np.concatenate([a, np.zeros(int(DEFAULT_SAMPLERATE * STREAM_GAP_SEC), dtype=np.float32)])
    return a


def detect_device() -> str:
    """Informational device label for the 'ready' message. Orpheus always runs a
    single worker regardless, so this only feeds status/UI, not topology."""
    try:
        import torch
        if torch.cuda.is_available():
            return 'cuda'
    except Exception:
        pass
    try:
        from mlx_audio.tts.utils import load_model  # noqa: F401
        return 'mlx'
    except Exception:
        pass
    return 'cpu'


# ── Orpheus streaming server ──────────────────────────────────────────────────
VALID_VOICES = {'tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'}
DEFAULT_VOICE = 'leah'


class OrpheusStreamServer:
    def __init__(self):
        self.orph = None              # e2a Orpheus engine instance (lazy)
        self.current_voice = None
        self.device = None

    def _ensure_engine(self, voice: str):
        """Load the Orpheus model once (heavy), set the voice (cheap), and on the
        first load WARM the generate path before reporting the voice ready."""
        v = (voice or DEFAULT_VOICE).lower()
        if v not in VALID_VOICES:
            v = DEFAULT_VOICE

        first_load = self.orph is None
        if first_load:
            send_response('status', {'message': 'Loading Orpheus model...'})
            # Import here so 'ready' is sent before the heavy vLLM/MLX import, and
            # so an env without these deps fails on load (surfaced) not at startup.
            from lib.classes.tts_engines.orpheus import Orpheus
            # A plain dict satisfies the class's dict-style session access. It only
            # reads ['tts_engine'] (presets/cache key) and .get('fine_tuned') (voice).
            session = {'tts_engine': 'orpheus', 'fine_tuned': v}
            self.orph = Orpheus(session)      # __init__ → load_engine() loads model
            send_response('status', {'message': 'Model loaded'})

        # Voice is just the prompt prefix — switch instantly, no reload.
        self.orph.voice = v
        self.current_voice = v

        # Warm the generate path ONCE, at load, so the cold-start cost is paid here
        # (absorbed by the user's "start the server and find an article" window),
        # not on the first sentences they actually play.
        if first_load:
            self._warmup()

        send_response('status', {'message': f'Voice loaded: {v}'})
        return True

    def _warmup(self):
        """Pay the backend's first-generate cold-start now, at load.

        Loading the model is NOT the same as warming it: the first generate() is
        when MLX compiles/caches its kernels (and the SNAC decode + sampler path
        finalize). vLLM captures CUDA graphs at engine init, but MLX is lazy, so
        without this the lag lands minutes later on the first played sentences —
        the 'buffers for the first few sentences, then hits its stride' symptom.
        MLX can recompile per sequence length, so warm a few increasing lengths.
        Output is discarded; we only want the compile/cache side effect. Failures
        are non-fatal — a warmup hiccup must never block the voice from loading.
        """
        if os.environ.get('ORPHEUS_SKIP_WARMUP') == '1':
            return
        send_response('status', {'message': 'Warming up voice...'})
        warm_texts = (
            'Hello.',
            'This is a brief warmup.',
            'Here is a slightly longer warmup sentence to prepare smooth playback.',
        )
        for t in warm_texts:
            try:
                self._generate_audio(t)  # discard — the side effect is the warmup
            except Exception as e:
                print(f'[orpheus_stream] warmup generation failed (non-fatal): {e}',
                      file=sys.stderr)
        send_response('status', {'message': 'Warmup complete'})

    def load_voice(self, voice: str) -> bool:
        try:
            return self._ensure_engine(voice)
        except Exception as e:
            send_response('error', {'message': f'Failed to load Orpheus: {e}'})
            return False

    def _generate_audio(self, text: str):
        """Generate one sentence to a float numpy waveform via the e2a Orpheus
        engine's backend-specific path (mirrors Orpheus.convert(), but in-memory)."""
        orph = self.orph
        clean = orph._clean_sentence_for_tts(text)
        if not clean:
            return np.zeros(int(DEFAULT_SAMPLERATE * 0.05), dtype=np.float32)
        if orph.backend == 'mlx':
            audio = orph._generate_mlx(clean)
        elif orph.backend == 'vllm':
            audio = orph._tokens_to_audio(orph._generate_tokens_vllm(clean))
        else:
            audio = orph._tokens_to_audio(
                orph._generate_tokens_transformers(f"{orph.voice}: {clean}")
            )
        return finalize_audio(audio)

    def generate(self, text: str, language: str = 'en', stream: bool = False, **_ignored):
        if self.orph is None:
            send_response('error', {'message': 'Model not loaded'})
            return
        try:
            text = normalize_for_tts(text, language)
            audio = self._generate_audio(text)
            if audio is None or len(audio) == 0:
                send_response('error', {'message': 'No audio generated'})
                return
            duration = len(audio) / DEFAULT_SAMPLERATE
            data = audio_to_pcm16_base64(audio)
            if stream:
                # Whole sentence as a single chunk, then the stream terminator —
                # satisfies the scheduler's streaming-first-sentence contract.
                send_response('chunk', {
                    'seq': 0,
                    'format': 'pcm16',
                    'data': data,
                    'duration': duration,
                    'sampleRate': DEFAULT_SAMPLERATE,
                })
                send_response('done', {
                    'duration': duration,
                    'chunks': 1,
                    'cancelled': False,
                })
            else:
                send_response('audio', {
                    'format': 'pcm16',
                    'data': data,
                    'duration': duration,
                    'sampleRate': DEFAULT_SAMPLERATE,
                })
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            send_response('error', {'message': f'Generation failed: {e}'})

    def run(self):
        self.device = detect_device()
        send_response('ready', {'device': self.device})

        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except Exception as e:
                send_response('error', {'message': f'Invalid JSON: {e}'})
                continue

            action = request.get('action')
            if action == 'load':
                if self.load_voice(request.get('voice', DEFAULT_VOICE)):
                    send_response('loaded', {'voice': self.current_voice})
            elif action == 'generate':
                text = request.get('text', '')
                if not text:
                    send_response('error', {'message': 'No text provided'})
                    continue
                self.generate(
                    text=text,
                    language=request.get('language', 'en'),
                    stream=bool(request.get('stream', False)),
                )
            elif action in ('cancel', 'stop'):
                # Orpheus generation is whole-sentence and not interruptible; the
                # scheduler drops stale results. Acknowledge and continue.
                send_response('stopped')
            elif action == 'quit':
                break
            else:
                send_response('error', {'message': f'Unknown action: {action}'})


if __name__ == '__main__':
    OrpheusStreamServer().run()
