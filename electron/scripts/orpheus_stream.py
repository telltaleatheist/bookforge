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
  stdin:  {action: 'load', voice, id?, modelDir?, adapterDir?, baseDir?, caps?}
          {action: 'generate', text, voice?, stream?: bool, ...}
          {action: 'generate_batch', items: [{i, text, voice?}], ...}
          {action: 'cancel' | 'stop' | 'quit'}
  stdout: {type: 'ready', device, backend?}
          {type: 'status' | 'loaded' | 'error' | 'stopped', ...}
          {type: 'audio', format:'pcm16', data, duration, sampleRate}        # batch
          {type: 'chunk', seq, format:'pcm16', data, duration, sampleRate}   # stream
          {type: 'done', duration, chunks, cancelled}                        # stream end

Four kinds of voice, distinguished by what a 'load' carries:

  STOCK        (no dirs)         tara, leah, jess, leo, dan, mia, zac, zoe, served
                                 from the HF cache. The voice is a prompt prefix.
  STOCK/BASE   (baseDir only)    the SAME stock voices, served from the local `_base`
                                 copy of the same checkpoint. Sent whenever the base
                                 is installed — see the key collapse below.
  MERGED       (modelDir)        a legacy full fine-tune. The voice IS the weights,
                                 so switching means a full engine reload.
  ADAPTER  (adapterDir+baseDir)  a LoRA over the shared base. The voice is a
                                 PER-REQUEST LoRARequest, so switching between two
                                 adapters on the same base is a registration —
                                 no reload, no CUDA-graph recapture — and one batch
                                 may mix voices, each with its own prompt token,
                                 sampling caps and adapter.

The engine is torn down and rebuilt only when the (modelDir, baseDir) pair
changes, which is exactly e2a's own engine cache key.

THE KEY COLLAPSE. Because a stock load carries baseDir whenever the base is
installed, stock and adapter voices produce the SAME pair — so stock↔adapter is a
free registration too, not a teardown. It used to be a teardown for byte-identical
weights (stock loaded `unsloth/orpheus-3b-0.1-ft` from the HF cache, the adapter
loaded the local copy of the same checkpoint), which on a cold cache could trigger
a multi-GB HuggingFace DOWNLOAD in the middle of a listening session. On a machine
with no base installed nothing changes: stock keeps the (None, None) key it always
had, and stock↔adapter still rebuilds.

A voice is servable per request only after a 'load' registered it against the
CURRENT engine — a generate naming anything else is an error, never a silent render
in whatever is loaded.
"""

import json
import signal
import sys
import os
import re
import base64
import numpy as np

DEFAULT_SAMPLERATE = 24000


def _graceful_exit(signum, frame):
    """Cooperative shutdown: SIGTERM/SIGINT → SystemExit(143).

    Python's default SIGTERM disposition kills the process WITHOUT running atexit
    hooks, so vLLM/torch never release the GPU — and force-killing a process stuck
    in a WSL dxg GPU wait is what kernel-wedges the whole WSL VM. Raising SystemExit
    instead unwinds the stdin loop, runs atexit (e2a orpheus.py's CUDA cleanup), and
    releases the GPU from inside the process. The stdin 'quit' action remains the
    primary teardown; this covers the pkill path.
    """
    print(f"[ORPHEUS-STREAM] Signal {signum} received — shutting down cleanly (releasing GPU)...",
          file=sys.stderr, flush=True)
    raise SystemExit(143)


signal.signal(signal.SIGTERM, _graceful_exit)
signal.signal(signal.SIGINT, _graceful_exit)


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


def detect_backend():
    """The backend e2a WILL use in this process ('vllm' | 'mlx' | 'transformers'),
    or None if it cannot be determined.

    Reported on the 'ready' line because the pool needs it BEFORE any voice loads:
    only vLLM can render a voice PER REQUEST, and only vLLM can be handed a local
    base dir for stock voices. Everything downstream of that answer is a correctness
    guard, so it is taken from e2a's own detector rather than re-derived here from
    the platform — a second implementation of "which backend" is a second thing to
    drift.

    Costs an import of the e2a Orpheus module (torch + e2a headers), NOT a model
    load; detect_device() above already pays the torch import. Failure returns None,
    which the pool reads as "unknown" and treats as NOT per-request capable — armed,
    never waived — and which then also suppresses the stock-from-local-base path, so
    an env whose imports are broken degrades to exactly the pre-adapter behaviour
    instead of to a wrong render.
    """
    try:
        from lib.classes.tts_engines.orpheus import Orpheus
        backend = Orpheus.detect_backend()
    except Exception as e:
        print(f'[orpheus_stream] backend detection failed ({e}); reporting unknown',
              file=sys.stderr)
        return None
    return backend if backend in ('vllm', 'mlx', 'transformers') else None


# ── Orpheus streaming server ──────────────────────────────────────────────────
# Built-in voices. Custom finetunes are NOT listed here — they arrive with either a
# merged model dir (`modelDir`) or a LoRA adapter (`adapterDir` + `baseDir`) on the
# load request and use their token verbatim, bypassing this allowlist (mirrors e2a
# orpheus.py's orpheus_model_dir / orpheus_adapter_dir branches).
VALID_VOICES = {'tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'}
DEFAULT_VOICE = 'leah'


class OrpheusStreamServer:
    def __init__(self):
        self.orph = None              # e2a Orpheus engine instance (lazy)
        self.current_voice = None
        self.current_model_dir = None # None = stock/adapter; else a merged model dir
        self.current_base_dir = None  # the shared base (adapter mode, or stock-from-base)
        # Voices this engine can serve RIGHT NOW: token -> adapter dir (None for a
        # stock or merged voice). Populated by 'load', emptied by teardown — so it
        # can never claim a voice whose weights or adapter registration went away
        # with a previous engine.
        self.engine_voices = {}
        # token -> the CATALOG ID that claimed it (see _check_token_owner). The pool
        # keys voices by catalog id, this server keys them by prompt token, and two
        # ids declaring the same token would otherwise collapse into one slot.
        self.engine_voice_ids = {}
        self.device = None
        self.backend = None           # e2a's detected backend, probed at 'ready'

    def _ensure_engine(self, voice: str, model_dir: str = None, caps: dict = None,
                       adapter_dir: str = None, base_dir: str = None,
                       voice_id: str = None):
        """Load (or reload) the Orpheus model and make `voice` the default; on first
        load WARM the generate path before reporting ready.

        Four modes (see the module docstring). The engine is torn down ONLY when the
        (model_dir, base_dir) pair changes — the same key e2a's own load_engine cache
        uses — because that pair, and nothing else, decides which WEIGHTS are served:

          adapter -> adapter, same base   same pair  -> register + switch, NO reload
          stock   -> stock                same pair  -> prompt prefix, NO reload
          stock  <-> adapter, same base   same pair  -> register + switch, NO reload
          merged  -> anything             differs    -> reload
          stock (no base) <-> adapter     differs    -> reload

        The third line is the KEY COLLAPSE. An engine is built with vLLM's enable_lora
        if and only if it was given a base_dir — which a stock load now also carries
        whenever the base is installed — so "base_dir matches" remains a proof that
        the live engine can serve adapters at all. It is never possible for an adapter
        request to reach a LoRA-less engine; the last line is what that proof rejects.
        """
        if adapter_dir and model_dir:
            send_response('error', {
                'message': f"Orpheus load for '{voice}' carried both a merged modelDir "
                           f'({model_dir}) and an adapterDir ({adapter_dir}). They select '
                           'different weights — pass exactly one.'
            })
            return False
        if base_dir and model_dir:
            send_response('error', {
                'message': f"Orpheus load for '{voice}' carried both a merged modelDir "
                           f'({model_dir}) and a baseDir ({base_dir}). A merged fine-tune IS '
                           'its own weights and is never served on top of a base.'
            })
            return False
        if adapter_dir and not base_dir:
            send_response('error', {
                'message': f"Orpheus load for '{voice}' carried adapterDir={adapter_dir!r} "
                           'with no baseDir. An adapter is only a delta over the base that '
                           'turns it into a voice — it needs both.'
            })
            return False

        if model_dir or adapter_dir:
            # Custom token, verbatim — a single-speaker fine-tune is not in the
            # built-in allowlist, and validating it there would drop it to the default.
            v = (voice or '').strip().lower()
            if not v or v == 'internal':
                # 'internal' is e2a's "no --fine_tuned given" sentinel. For an adapter
                # it is fatal: the token is also the adapter's registry key, and
                # rendering under a token the adapter never saw sounds plausible and
                # is wrong.
                send_response('error', {
                    'message': f"Orpheus custom voice load is missing its voice token "
                               f'(got {voice!r}). The token the fine-tune was trained on '
                               'is required — refusing to guess.'
                })
                return False
        else:
            v = (voice or DEFAULT_VOICE).lower()
            if v not in VALID_VOICES:
                # Unknown built-in voice: FAIL the load instead of silently
                # substituting the default (the wrong narrator reading a whole
                # session is a silent failure). The TS pool already rejects
                # unknown voices upstream (orpheus-worker-pool.ts); this second
                # net now errors too rather than downgrading.
                send_response('error', {
                    'message': f"Unknown Orpheus voice '{voice}' — expected one of: "
                               f"{', '.join(sorted(VALID_VOICES))} (or a custom voice "
                               f"with a modelDir, or an adapter voice with adapterDir "
                               f"+ baseDir). Refusing to substitute '{DEFAULT_VOICE}'."
                })
                return False

        if not self._check_token_owner(v, voice_id):
            return False

        # Different weights (a merged model on either side, or a different shared
        # base) → tear the engine down and reload. Same pair → the engine stays up.
        if self.orph is not None and (model_dir, base_dir) != (self.current_model_dir,
                                                               self.current_base_dir):
            send_response('status', {'message': 'Switching Orpheus model...'})
            self._teardown_engine()

        first_load = self.orph is None
        if first_load:
            send_response('status', {'message': 'Loading Orpheus model...'})
            # Import here so 'ready' is sent before the heavy vLLM/MLX import, and
            # so an env without these deps fails on load (surfaced) not at startup.
            from lib.classes.tts_engines.orpheus import Orpheus
            # A plain dict satisfies the class's dict-style session access. It reads
            # ['tts_engine'], .get('fine_tuned') (voice), .get('orpheus_model_dir')
            # and the adapter pair .get('orpheus_adapter_dir')/.get('orpheus_base_dir').
            session = {'tts_engine': 'orpheus', 'fine_tuned': v}
            if model_dir:
                session['orpheus_model_dir'] = model_dir
            if base_dir:
                # baseDir alone is the STOCK-FROM-LOCAL-BASE mode: e2a serves the base
                # checkpoint from the local folder and — on vLLM — builds the engine
                # with enable_lora, which is a CONSTRUCTION-time property. That is what
                # lets an adapter voice later join this engine without a reload.
                session['orpheus_base_dir'] = base_dir
            if adapter_dir:
                session['orpheus_adapter_dir'] = adapter_dir
            self.orph = Orpheus(session)      # __init__ → load_engine() loads model
            self.current_model_dir = model_dir
            self.current_base_dir = base_dir
            send_response('status', {'message': 'Model loaded'})
        else:
            # Warm engine, same weights. For a stock voice this is the free
            # prompt-prefix switch it always was; for an adapter voice it registers
            # (and VALIDATES) the LoRA and re-points the engine's default voice at it
            # in one step. set_voice keeps orph.voice and orph.adapter_dir in lockstep
            # in BOTH directions — attaching the adapter for an adapter voice, and
            # detaching the previous one for a stock voice, which is what makes the
            # collapsed stock↔adapter switch safe.
            self.orph.set_voice(v, adapter_dir)
        self.current_voice = v
        self.engine_voices[v] = adapter_dir
        # Only a load that NAMES an id claims the token. A load without one (an older
        # pool build) must not overwrite an existing claim with None — that would
        # quietly disarm _check_token_owner for every load after it.
        if voice_id:
            self.engine_voice_ids[v] = voice_id

        # Register the voice's tuning BEFORE the warmup, so the warm-up renders
        # exercise the same sampling path the real sentences will. Must come after
        # the engine exists (the registry lives on the e2a Orpheus class) and after
        # `v` is resolved (caps are keyed by the token the engine actually uses).
        # A registration failure must not leave the loaded engine serving requests
        # with default tuning — generate/generate_batch guard only on `self.orph is
        # None`, and a consumed `first_load` would also skip the warmup forever —
        # so tear the engine down and let the error propagate as a load failure.
        try:
            self._apply_voice_caps(v, caps)
        except Exception:
            self._teardown_engine()
            raise

        # Warm the generate path ONCE per load, so the cold-start cost is paid here
        # (absorbed by the user's "start the server and find an article" window),
        # not on the first sentences they actually play.
        if first_load:
            self._warmup()

        send_response('status', {'message': f'Voice loaded: {v}'})
        return True

    def _check_token_owner(self, token: str, voice_id: str) -> bool:
        """Refuse a load whose PROMPT TOKEN is already claimed by a different catalog id.

        The pool identifies a voice by its catalog id; this server identifies it by the
        prompt token, because that is what the model actually conditions on and what
        keys the adapter registry. Those are usually the same string, but a catalog
        entry may declare a token that differs from its id — and nothing in the wire
        format stops TWO ids from declaring the SAME token. If that happened they would
        collapse into one slot here: loading v2 would re-point the token at v2's
        adapter, and every subsequent request for v1 would be served v2's voice, as a
        success.

        The installer already refuses colliding tokens at install time (two model cards
        claiming one orpheus_token), so this is defense for the path that bypasses it:
        a hand-edited models.json. Cheap, and the alternative failure is silent.

        A load that carries no id (an older pool build) claims nothing and is accepted —
        it cannot create a collision, only fail to detect one.
        """
        if not voice_id:
            return True
        owner = self.engine_voice_ids.get(token)
        if owner is None or owner == voice_id:
            return True
        send_response('error', {
            'message': f"Orpheus voice id '{voice_id}' wants the prompt token '{token}', "
                       f"which is already registered on this engine to '{owner}'. Two voices "
                       'cannot share one token — the second would be rendered with the '
                       "first's adapter and reported as a success. Give one of them a "
                       'distinct token in the Orpheus models manifest.'
        })
        return False

    def _teardown_engine(self):
        """Release the current Orpheus engine (and its ~6 GB of VRAM) so a different
        model can take its place.

        engine_voices is emptied with it: every entry describes what THIS engine can
        serve — a prompt token it has weights for, or an adapter registered under a
        lora id that only means anything inside the vLLM object being destroyed. A
        surviving entry would let a request for a voice from the previous engine be
        accepted and rendered in whatever is loaded now."""
        if self.orph is not None:
            try:
                self.orph.cleanup()
            except Exception:
                pass
            self.orph = None
        self.current_voice = None
        self.current_model_dir = None
        self.current_base_dir = None
        self.engine_voices = {}
        self.engine_voice_ids = {}

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

        TWO shapes are warmed, not every width: the single-sentence path (width 1,
        used by the audiobook-style solo render and any tail-of-one group) and ONE
        batch at the full ORPHEUS_STREAM_BATCH width, which is the shape essentially
        every read-ahead group uses. Warming every width 1..16 measured 176s of a
        184s load — and load time is user-visible on EVERY server start, while an
        unwarmed intermediate width (only a block's short tail group hits one) just
        compiles lazily, ~10s, once, behind a buffer that is by then many sentences
        deep. Trading a one-off hidden 10s for ~150s of visible startup is the whole
        point.
        """
        if os.environ.get('ORPHEUS_SKIP_WARMUP') == '1':
            return
        try:
            n = int(os.environ.get('ORPHEUS_STREAM_BATCH', '16'))
        except ValueError:
            n = 16
        if n < 1:
            n = 1
        send_response('status', {'message': f'Warming up voice (widths 1 and {n})...'})
        warm_texts = (
            'Hello.',
            'This is a brief warmup.',
            'Here is a slightly longer warmup sentence to prepare smooth playback.',
        )
        # 1) Single-sentence path (width 1 — the solo render, and any width-1 group).
        #    MLX recompiles per sequence length, so warm a few increasing lengths.
        for t in warm_texts:
            try:
                self._generate_audio(t)  # discard — the side effect is the warmup
            except Exception as e:
                print(f'[orpheus_stream] warmup generation failed (non-fatal): {e}',
                      file=sys.stderr)
        # 2) BATCHED path (read-ahead), at the FULL width only. generate_batch forms
        #    ordered adjacency groups capped at ORPHEUS_STREAM_BATCH, and a stream of
        #    read-ahead sentences produces full-width groups almost exclusively — only
        #    a block's trailing run is short, and that one lazily-compiled width is
        #    paid once, hidden behind an already-deep buffer. UNIFORM texts on purpose:
        #    identical sentences -> identical token lengths -> exactly one bucket at
        #    exactly this width. (This _generate_audio_batch call is the only MLX use
        #    of that method now that generate_batch renders groups directly.)
        try:
            self._generate_audio_batch([warm_texts[1]] * n)  # discard — warms the graph
        except Exception as e:
            print(f'[orpheus_stream] batch warmup (width {n}) failed (non-fatal): {e}',
                  file=sys.stderr)
        send_response('status', {'message': 'Warmup complete'})

    def load_voice(self, voice: str, model_dir: str = None, caps: dict = None,
                   adapter_dir: str = None, base_dir: str = None,
                   voice_id: str = None) -> bool:
        try:
            return self._ensure_engine(voice, model_dir, caps, adapter_dir, base_dir,
                                       voice_id)
        except Exception as e:
            send_response('error', {'message': f'Failed to load Orpheus: {e}'})
            return False

    def _row_voice(self, voice) -> str:
        """The voice token one generate row must render in.

        Absent/blank -> the server's current default voice, which is what every
        request meant before per-request voices existed. Anything else must have been
        registered against the LIVE engine by a 'load'; a voice this engine cannot
        serve is an ERROR, never a quiet render in whatever happens to be loaded —
        that is the wrong narrator delivered as a success.
        """
        if self.current_voice is None:
            raise RuntimeError('Model not loaded')
        if voice is None or not str(voice).strip():
            return self.current_voice
        v = str(voice).strip().lower()
        if v in self.engine_voices:
            return v
        known = ', '.join(sorted(self.engine_voices)) or '(none)'
        raise ValueError(
            f"Orpheus voice '{v}' is not loaded on this stream server. Loaded: {known}. "
            'Send a load for it first — an adapter can only be served by an engine that '
            'was built LoRA-capable and has it registered, and a merged voice needs its '
            'own weights, so neither can be conjured for a single request. If the engine '
            'was rebuilt for another model, restart the stream server or re-load the voice.'
        )

    def _apply_voice_caps(self, voice: str, caps: dict) -> None:
        """Register the catalog's per-voice tuning for the voice being loaded.

        This worker is RESIDENT and switches voices without respawning, so caps
        cannot ride the spawn environment the way the audiobook worker's do
        (parallel-tts-bridge sets them once per spawn). They arrive on the 'load'
        message instead and are handed to the engine's per-voice registry, which
        resolves every sampling value per REQUEST: registered cap -> ORPHEUS_* env
        -> class default.

        This used to write os.environ instead, which was wrong twice over. The env
        is ONE global slot per process, so it cannot describe a batch that mixes
        voices; and the values it fed are read by orpheus.py at IMPORT for
        everything except the chars/sec guard, so a repPenalty set on the second
        voice load never took effect at all — the first voice's value stayed bound
        to the class for the life of the server. eosBoost was omitted entirely on
        the (incorrect) grounds that it is "read at engine load", so streaming ran
        every voice with eosBoost=0 while the catalog declares 8 @ 2.0 for the
        bed-free fine-tunes. Registration fixes all of it in one place.

        Registration REPLACES the voice's caps, so a cap the payload omits reverts
        to env/default rather than lingering from an earlier load. Non-tuning keys
        in the same payload (maxChars = prep packing, sentenceGap = assembly, and
        neither is read on any streaming path — streaming pads with its own
        STREAM_GAP) are accepted and ignored BY NAME on the e2a side; a key that is
        neither raises.
        """
        orph = self.orph
        if not hasattr(orph, 'register_voice_caps'):
            raise RuntimeError(
                'This e2a checkout predates per-voice Orpheus caps '
                '(Orpheus.register_voice_caps is missing), so the catalog tuning for '
                f"'{voice}' cannot be applied — it would render with the wrong "
                'truncation guard, repetition penalty and no EOS boost. Update the '
                'e2a checkout this worker runs against.'
            )
        applied = orph.register_voice_caps(voice, caps or {})
        print(f'[orpheus_stream] voice caps registered for {voice}: '
              f'{applied or "none (e2a defaults)"}', file=sys.stderr)

    def _reject_per_request_voice(self, voice: str) -> None:
        """Only the vLLM backend renders a per-request voice — say so instead of
        rendering the wrong one.

        Adapter mode is vLLM-only by construction (e2a's load_engine refuses any other
        backend), and MLX's batch path builds ONE sampler per bucket from the engine's
        own caps, so even a stock per-row prompt token would carry the wrong voice's
        sampling. On MLX/transformers a row may therefore only use the loaded voice;
        anything else is an error.

        Raised PER ROW, never over a whole batch. It used to be checked for every item
        up front, before any group was built, so one stray voice failed all 16
        sentences — two whole reading blocks — when 15 of them were ordinary sentences
        in a voice that was right there. Callers now catch it around each item and
        report that item failed, exactly as they do for an unknown voice."""
        if voice != self.current_voice:
            raise ValueError(
                f"The '{self.orph.backend}' backend cannot render '{voice}' per request — "
                f"it serves one loaded voice at a time (currently '{self.current_voice}'). "
                'Load the voice before generating in it.'
            )

    def _resolve_row(self, item) -> str:
        """The voice token one BATCH item must render in, or raise with the reason.

        The two per-item rejections in one place: a voice this engine never loaded
        (_row_voice) and a voice this BACKEND cannot serve per request. Both fail the
        one item, not the batch."""
        v = self._row_voice(item.get('voice'))
        if self.orph.backend != 'vllm':
            self._reject_per_request_voice(v)
        return v

    def _generate_audio(self, text: str, voice: str = None):
        """Generate one sentence to a float numpy waveform via the e2a Orpheus
        engine's backend-specific path (mirrors Orpheus.convert(), but in-memory).

        `voice` (default: the loaded voice) selects the prompt token, the sampling
        caps and — in adapter mode — the LoRA, all the way down through the retake
        ladder, so a per-request voice is honoured end to end."""
        orph = self.orph
        v = self._row_voice(voice)
        clean = orph._clean_sentence_for_tts(text)
        if not clean:
            return np.zeros(int(DEFAULT_SAMPLERATE * 0.05), dtype=np.float32)
        if orph.backend == 'mlx':
            self._reject_per_request_voice(v)
            # _safe variant: render the sentence WHOLE, and only re-render it split at
            # sentence boundaries if that render hit the token cap, so a long sentence
            # is never shipped clipped (matches the audiobook path).
            audio = orph._generate_mlx_safe(clean)
            # Backstop a SILENT early-EOS truncation (clean stop, audio too short for
            # the text) the token-cap check can't see — mirrors Orpheus.convert().
            # force_split: a whole-chunk re-render would just clean-EOS (truncated)
            # again — the resplit must actually split.
            audio = orph._guard_truncation(
                0, clean, audio,
                lambda c: orph._generate_mlx_safe(c, force_split=True)
            )
        elif orph.backend == 'vllm':
            audio = orph._generate_audio_vllm_safe(clean, voice=v)
            # Same early-EOS backstop. force_split: a whole-chunk re-render would just
            # clean-EOS (truncated) again — the resplit must actually split.
            audio = orph._guard_truncation(
                0, clean, audio,
                lambda c: orph._generate_audio_vllm_safe(c, force_split=True, voice=v),
                v
            )
        else:
            self._reject_per_request_voice(v)   # transformers: same one-voice limit
            audio = orph._tokens_to_audio(
                orph._generate_tokens_transformers(f"{orph.voice}: {clean}")
            )
        return finalize_audio(audio)

    def _generate_audio_batch(self, texts, voices=None):
        """Generate many sentences at once. On the vLLM backend this is a TRUE
        batch — one engine.generate([prompts]) call whose continuous batching runs
        the sequences concurrently on the GPU (the same path Orpheus audiobooks use
        in convert_batch, ~30 sentences/min vs sequential's trickle). MLX and
        transformers have no batched path wired here, so they fall back to
        sequential. Returns a list of float waveforms aligned to `texts` (a tiny
        silence for empty sentences, None for a non-empty sentence that FAILED
        to render — the caller reports those as failures).

        `voices`, when given, is aligned to `texts` and names each row's voice; None
        (or None entries) means the loaded voice. On vLLM every per-row property —
        prompt token, sampling caps, LoRA — is resolved from that row's own voice, so
        ONE batch can carry several voices."""
        orph = self.orph
        cleaned = [orph._clean_sentence_for_tts(t) for t in texts]
        row_voices = [self._row_voice(voices[i] if voices else None)
                      for i in range(len(texts))]

        if orph.backend == 'vllm':
            from vllm import TokensPrompt
            results = [None] * len(texts)
            nonempty = [i for i, c in enumerate(cleaned) if c]
            # Feed raw token IDs via TokensPrompt — byte-identical to the fixed
            # audiobook batch path (e2a convert_batch) and the single-sentence
            # streaming path (_generate_audio_vllm_safe). The OLD call here,
            # _format_prompt_with_special_tokens, decoded IDs back to a STRING that
            # vLLM re-tokenized with a stray second BOS (the voice-token leak); that
            # method was deleted by the BOS fix, so this path must use _format_prompt_ids.
            prompts = [TokensPrompt(prompt_token_ids=orph._format_prompt_ids(cleaned[i], row_voices[i]))
                       for i in nonempty]
            # Sampling comes from e2a's _vllm_sampling_params — the ONE builder the
            # audiobook path uses (convert_batch) — instead of a SamplingParams
            # assembled here. Assembling it locally meant streaming silently
            # diverged from the audiobook path every time the config grew: it
            # dropped the per-request EOS-boost logits processor outright, so every
            # streamed voice ran with eosBoost=0 no matter what the catalog
            # declared. A LIST aligned to `prompts` (vLLM accepts one params per
            # prompt) because the boost's start threshold is sized from each
            # sentence's own length — and from each item's own voice.
            sp = [orph._vllm_sampling_params(len(cleaned[i]), voice=row_voices[i]) for i in nonempty]
            # lora_request must ride on BOTH arms: the fallback without it would
            # render the base voice the moment adapter mode reaches streaming.
            # A LIST aligned to `prompts` so a mixed-voice batch applies each row's
            # OWN adapter (vLLM 0.7.3 indexes a sequence per prompt in
            # _validate_and_add_requests; a scalar fans out to all of them). Collapsed
            # back to the scalar None when nothing in the batch uses an adapter, which
            # keeps the stock/merged call byte-identical to what it always sent.
            lora_rows = [orph._lora_request(row_voices[i]) for i in nonempty]
            lora = None if all(r is None for r in lora_rows) else lora_rows
            if prompts:
                try:
                    outputs = orph.engine.generate(prompts, sp, use_tqdm=False,
                                                   lora_request=lora)
                except TypeError:
                    outputs = orph.engine.generate(prompts, sp, lora_request=lora)
                # vLLM returns outputs in prompt order.
                for i, out in zip(nonempty, outputs):
                    tokens = list(out.outputs[0].token_ids)
                    if orph.END_OF_AUDIO_TOKEN in tokens:
                        # Finished cleanly: decode up to the end-of-audio token.
                        tokens = tokens[:tokens.index(orph.END_OF_AUDIO_TOKEN)]
                        audio_np = orph._tokens_to_audio(tokens)
                    else:
                        # Cap hit without finishing → the audio would be clipped.
                        # Re-render split at sentence boundaries (same ladder the
                        # audiobook convert_batch uses) so nothing is cut off.
                        print(f'[orpheus_stream] batch sentence [{i}] hit the audio-token cap; re-rendering split',
                              file=sys.stderr)
                        audio_np = orph._generate_audio_vllm_safe(cleaned[i], voice=row_voices[i])
                    # Backstop a SILENT early-EOS truncation (clean stop, audio too
                    # short for the text) the cap check above can't catch — mirrors
                    # the audiobook convert_batch. force_split so the resplit actually
                    # splits (a whole-chunk re-render would clean-EOS/truncate again).
                    # The row's voice is BOUND into the retake (default arg, not the
                    # loop variable) so a late-firing lambda can't re-render one row
                    # in another row's voice.
                    audio_np = orph._guard_truncation(
                        i, cleaned[i], audio_np,
                        lambda c, rv=row_voices[i]: orph._generate_audio_vllm_safe(
                            c, force_split=True, voice=rv),
                        row_voices[i]
                    )
                    results[i] = finalize_audio(audio_np)
            for i, c in enumerate(cleaned):
                if not c:
                    results[i] = np.zeros(int(DEFAULT_SAMPLERATE * 0.05), dtype=np.float32)
            return results

        if orph.backend == 'mlx':
            # In-memory MLX batch (e2a Orpheus._generate_mlx_batch_audio): one
            # BatchGenerator pass over the cleaned sentences, ~3.6x per-sentence
            # throughput. Returns raw waveforms (None for empty/failed); finalize
            # each, fill tiny silence ONLY for genuinely-empty texts (the "empty →
            # silence" contract), and keep None for failed non-empty items.
            #
            # No shape-pinning / filler padding here: ordered adjacency grouping in
            # generate_batch hands the MLX backend one consecutive run at a time
            # (width ≤ ORPHEUS_STREAM_BATCH), which e2a renders as exactly ONE
            # batch — no reordering of the next-needed sentence. Mixed lengths in a
            # group are safe since mlx-lm 0.31.3 right-pads batch prefills.
            # Group widths vary 1..cap by design; _warmup pre-compiles widths 1 and
            # cap (the two that runtime almost always produces) — any other width a
            # trailing group happens to need compiles lazily, once.
            #
            # On the MLX backend generate_batch renders groups directly, so the only
            # remaining caller of this branch is _warmup (uniform texts, one bucket
            # at a fixed width). It is kept general — map results straight through,
            # aligned to `texts`.
            #
            # One voice only: e2a builds ONE sampler per MLX bucket from the engine's
            # own caps, so a per-row voice could get its prompt token but never its
            # tuning. Refuse rather than render an approximation.
            #
            # A BACKSTOP, not the gate. generate_batch checks every item with
            # _resolve_row and fails the offending ones individually, so nothing
            # unservable reaches here; the only caller left on this branch is _warmup
            # (uniform texts, no per-row voices). Kept so a future caller cannot make
            # the MLX batch render a voice it can't tune.
            for rv in row_voices:
                self._reject_per_request_voice(rv)
            raw = orph._generate_mlx_batch_audio(cleaned)
            out = []
            for i in range(len(cleaned)):
                a = raw[i] if i < len(raw) else None
                # Same early-EOS/failed-row backstop as the ordered read-ahead path
                # (a no-op for empty cleaned texts and plausible audio). force_split
                # so the resplit actually splits (a whole re-render would clean-EOS
                # /truncate again).
                a = orph._guard_truncation(
                    i, cleaned[i], a,
                    lambda c: orph._generate_mlx_safe(c, force_split=True)
                )
                if a is None or len(a) == 0:
                    if cleaned[i]:
                        # Non-empty text with no audio = FAILED render. Keep None so
                        # the caller emits the 'No audio generated' failure item —
                        # never substitute silence for a failure.
                        out.append(None)
                    else:
                        # Genuinely empty text → tiny silence (the designed contract).
                        out.append(np.zeros(int(DEFAULT_SAMPLERATE * 0.05), dtype=np.float32))
                else:
                    out.append(finalize_audio(a))
            return out

        # transformers: no batched API — generate sequentially.
        return [self._generate_audio(t, row_voices[i]) for i, t in enumerate(texts)]

    @staticmethod
    def _emit_batch_item(it, audio):
        """Emit one 'batch_item', keyed by the caller-supplied index `i`. Empty/None
        audio → the 'No audio generated' message; otherwise the PCM16 payload. This
        is the exact per-item wire shape the non-MLX single-dispatch loop uses, so
        MLX group emission and non-MLX emission are byte-identical per item."""
        if audio is None or len(audio) == 0:
            send_response('batch_item', {'i': it.get('i'), 'message': 'No audio generated'})
        else:
            send_response('batch_item', {
                'i': it.get('i'),
                'format': 'pcm16',
                'data': audio_to_pcm16_base64(audio),
                'duration': len(audio) / DEFAULT_SAMPLERATE,
                'sampleRate': DEFAULT_SAMPLERATE,
            })

    def _generate_batch_mlx_ordered(self, items, language: str):
        """MLX read-ahead in READING ORDER, in groups of up to ORPHEUS_STREAM_BATCH.

        Sentences are grouped as CONSECUTIVE runs so the next sentences a listener
        needs are the ones in flight. WITHIN a group, items are emitted PER ROW AS IT
        RETIRES (e2a's _generate_mlx_batch_audio on_row callback) rather than when the
        whole group finishes: mlx-lm retires rows spread across the batch — the
        shortest at ~70% of its depth — so the earliest sentences of a 30-43s batch
        reach the client ~12s sooner. Rows therefore arrive in RETIREMENT order, not
        reading order; the wire protocol is explicitly out-of-order (clients assemble
        by sentence index — see docs/TTS_API.md). One bad group fails only its own
        items; every item is emitted exactly once; batch_done always fires last.

        Groups used to ALSO break on a length outlier (max/min > 1.5), because
        mlx-lm left-padded batch prefills and a short row next to a long one
        stochastically decoded to gibberish — so a chapter heading rendered alone at
        width 1. mlx-lm 0.31.3 right-pads prefills and root-fixes that (see the MLX
        memory block in e2a orpheus.py), so the length gate is gone: a heading now
        rides along in its neighbours' group instead of costing a solo render.

        MLX renders ONE voice — see _reject_per_request_voice — so every item is
        checked before the groups are built, and an item asking for anything but the
        loaded voice is FAILED INDIVIDUALLY (reported with the reason) and left out of
        the grouping. It used to fail the entire batch, which meant one stray voice
        killed both reading blocks in flight; the offending item is the only one that
        cannot be rendered, so it is the only one that fails.
        """
        try:
            cap = int(os.environ.get('ORPHEUS_STREAM_BATCH', '16'))
        except (TypeError, ValueError):
            cap = 16
        if cap < 1:
            cap = 1

        orph = self.orph
        emitted = set()  # positions in `items` already emitted (crash-safety)
        try:
            # Per-item voice check. A row this backend cannot serve fails on its own
            # and is dropped from the grouping; its neighbours render normally.
            unservable = set()
            for pos, it in enumerate(items):
                try:
                    self._resolve_row(it)
                except Exception as e:
                    send_response('batch_item', {'i': it.get('i'), 'message': str(e)})
                    emitted.add(pos)
                    unservable.add(pos)
            # Clean per item (normalize → e2a clean), aligned 1:1 to `items`. An
            # empty cleaned string keeps its slot and renders as tiny silence.
            cleaned = [orph._clean_sentence_for_tts(normalize_for_tts(it.get('text', ''), language))
                       for it in items]

            # Build ordered groups of item positions. Empty positions break the
            # current group and become their own silence unit (kept in order).
            groups = []          # list of lists of positions into `items`
            cur = []
            for pos, c in enumerate(cleaned):
                if pos in unservable:
                    # Already reported failed. It breaks the run for the same reason an
                    # empty one does — the group must stay a CONSECUTIVE run of
                    # sentences that will actually be rendered.
                    if cur:
                        groups.append(cur)
                        cur = []
                    continue
                if not c:
                    if cur:
                        groups.append(cur)
                        cur = []
                    groups.append([pos])  # empty → silence singleton
                    continue
                if len(cur) >= cap:
                    groups.append(cur)
                    cur = []
                cur.append(pos)
            if cur:
                groups.append(cur)

            for group in groups:
                # Empty singleton → tiny silence (the "empty → silence" contract).
                if len(group) == 1 and not cleaned[group[0]]:
                    pos = group[0]
                    self._emit_batch_item(
                        items[pos], np.zeros(int(DEFAULT_SAMPLERATE * 0.05), dtype=np.float32))
                    emitted.add(pos)
                    continue

                group_texts = [cleaned[p] for p in group]

                def _resolve(k, a, group=group):
                    """Guard + emit ONE row of this group, exactly once.

                    Called from e2a's on_row the moment that row retires, and again
                    from the sweep below for any row on_row never reached (a
                    bucket-level failure inside e2a) — `emitted` makes the second
                    call a no-op for rows already sent.

                    The guard runs FIRST so a failed row (None/empty from a decode
                    error or immediate early-EOS) gets the same one-retake backstop
                    as a truncated one — mirrors _convert_mlx_batch. Previously None
                    rows skipped the guard and shipped 50ms of silence marked success
                    (silent sentence loss). Never substitute silence for a FAILURE: a
                    non-empty sentence that still yields nothing is emitted as a 'No
                    audio generated' failure item (same wire shape as the vLLM path).
                    """
                    p = group[k]
                    if p in emitted:
                        return
                    # force_split: the guard fires on a CLEAN early EOS (or an empty
                    # row), so a whole-chunk re-render would very likely reproduce it —
                    # the retake must actually split.
                    a = orph._guard_truncation(
                        p, cleaned[p], a,
                        lambda c: orph._generate_mlx_safe(c, force_split=True)
                    )
                    if a is None or len(a) == 0:
                        # A legit empty sentence gets a tiny silence slot; a non-empty
                        # sentence that STILL produced nothing after the retake is a
                        # real failure — emit it as one ('No audio generated') so the
                        # scheduler marks the sentence failed instead of playing air.
                        if cleaned[p]:
                            print(f'[orpheus_stream] MLX batch produced no audio for non-empty '
                                  f'sentence [{items[p].get("i")}] — reporting failure',
                                  file=sys.stderr)
                        audio = np.zeros(int(DEFAULT_SAMPLERATE * 0.05), dtype=np.float32) if not cleaned[p] else None
                    else:
                        audio = finalize_audio(a)
                    self._emit_batch_item(items[p], audio)
                    emitted.add(p)

                try:
                    # One consecutive reading-order group == one e2a batch, whose rows
                    # stream out through _resolve as they retire.
                    raw = orph._generate_mlx_batch_audio(group_texts, on_row=_resolve)
                except Exception as e:
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    for p in group:
                        if p in emitted:
                            continue
                        send_response('batch_item',
                                      {'i': items[p].get('i'), 'message': f'Batch generation failed: {e}'})
                        emitted.add(p)
                    continue

                # Sweep: rows the generator never retired through on_row (an internal
                # bucket failure) still get their item, from the returned list.
                for k in range(len(group)):
                    _resolve(k, raw[k] if k < len(raw) else None)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            for pos, it in enumerate(items):
                if pos not in emitted:
                    send_response('batch_item', {'i': it.get('i'), 'message': f'Batch generation failed: {e}'})
        finally:
            send_response('batch_done', {'count': len(items)})

    def generate_batch(self, items, language: str = 'en'):
        """Generate a batch of sentences (read-ahead). Emits one 'batch_item' per
        item (keyed by its caller-supplied index `i`) then a 'batch_done'. A failure
        is reported per item so one bad sentence never sinks the batch.

        MLX uses ordered adjacency grouping (_generate_batch_mlx_ordered) so the
        next sentence in reading order streams out first and length-mixing can't
        corrupt short rows. vLLM/transformers keep the single-dispatch path below.

        An item may carry its own `voice`; omitted means the loaded one. On vLLM the
        batch is NOT regrouped by voice — vLLM takes a per-prompt LoRA list, so mixed
        voices ride one call and the read-ahead window keeps its reading order."""
        if self.orph is None:
            for it in items:
                send_response('batch_item', {'i': it.get('i'), 'message': 'Model not loaded'})
            send_response('batch_done', {'count': len(items)})
            return

        if self.orph.backend == 'mlx':
            self._generate_batch_mlx_ordered(items, language)
            return

        emitted = set()
        try:
            # Resolve each item's voice FIRST and fail only the items that name one
            # this engine (or this backend) cannot serve. A single unservable voice
            # must not sink the batch: the rest are ordinary sentences in a voice that
            # is right there.
            rows = []   # (item, normalized text, voice token)
            for it in items:
                try:
                    v = self._resolve_row(it)
                except Exception as e:
                    send_response('batch_item', {'i': it.get('i'), 'message': str(e)})
                    emitted.add(id(it))
                    continue
                rows.append((it, normalize_for_tts(it.get('text', ''), language), v))

            if rows:
                audios = self._generate_audio_batch([t for _, t, _ in rows],
                                                    [v for _, _, v in rows])
                for (it, _text, _v), audio in zip(rows, audios):
                    emitted.add(id(it))
                    if audio is None or len(audio) == 0:
                        send_response('batch_item', {'i': it.get('i'), 'message': 'No audio generated'})
                    else:
                        send_response('batch_item', {
                            'i': it.get('i'),
                            'format': 'pcm16',
                            'data': audio_to_pcm16_base64(audio),
                            'duration': len(audio) / DEFAULT_SAMPLERATE,
                            'sampleRate': DEFAULT_SAMPLERATE,
                        })
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            # Only items that never got a result — an item already reported (its own
            # voice rejection, or a successful render before the failure) must not be
            # emitted twice; the pool resolves by index and a second message for one
            # index would be dropped as stale.
            for it in items:
                if id(it) not in emitted:
                    send_response('batch_item', {'i': it.get('i'), 'message': f'Batch generation failed: {e}'})
        finally:
            send_response('batch_done', {'count': len(items)})

    def generate(self, text: str, language: str = 'en', stream: bool = False,
                 voice: str = None, **_ignored):
        """Render ONE sentence. `voice` (optional) must be a voice a 'load'
        registered against the live engine; omitted means the loaded voice."""
        if self.orph is None:
            send_response('error', {'message': 'Model not loaded'})
            return
        try:
            text = normalize_for_tts(text, language)
            audio = self._generate_audio(text, voice)
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
        self.backend = detect_backend()
        # `backend` is what the pool gates its per-request-voice guard on, so it is
        # sent even when it could not be determined — as absent, which the pool reads
        # as "unknown" and treats as NOT capable.
        send_response('ready', {'device': self.device,
                                **({'backend': self.backend} if self.backend else {})})

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
                if self.load_voice(request.get('voice', DEFAULT_VOICE), request.get('modelDir'),
                                   request.get('caps'), request.get('adapterDir'),
                                   request.get('baseDir'), request.get('id')):
                    # The CONSTRUCTED engine's backend, not the pre-load probe's — same
                    # value in every normal case, but this one is ground truth, so a
                    # probe that failed at startup is corrected here rather than
                    # leaving the pool's guard permanently armed.
                    self.backend = self.orph.backend
                    send_response('loaded', {'voice': self.current_voice,
                                             'backend': self.backend})
            elif action == 'generate':
                text = request.get('text', '')
                if not text:
                    send_response('error', {'message': 'No text provided'})
                    continue
                self.generate(
                    text=text,
                    language=request.get('language', 'en'),
                    stream=bool(request.get('stream', False)),
                    voice=request.get('voice'),
                )
            elif action == 'generate_batch':
                self.generate_batch(
                    request.get('items', []),
                    language=request.get('language', 'en'),
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
