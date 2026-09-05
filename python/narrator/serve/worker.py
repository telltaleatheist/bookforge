#!/usr/bin/env python3
"""
Orpheus streaming worker for BookForge Play/Listen (and the TTS API server).

Ported from BookForge@3b4d0b17 electron/scripts/orpheus_stream.py. The JSON-lines
protocol, every message type and field, the stdout lock, the reader thread, the
warmup shapes and the env vars are UNCHANGED - electron/orpheus-worker-pool.ts
parses this wire format and was not touched. What changed is what sits under it:
the e2a `Orpheus` class and its session dict became `narrator.engine.OrpheusEngine`
and `EngineConfig`, and the sys.path dance that located an ebook2audiobook
checkout is gone (the engine ships in this package).

Run it as `python -m narrator.serve` (see __main__.py).

It loads the Orpheus model ONCE and serves sentence requests over stdin,
emitting base64 PCM16 (24kHz mono) JSON lines on stdout - the exact wire shape
xtts_stream.py uses, so the TypeScript worker pool / stream scheduler /
browser-extension protocol are unchanged.

Protocol (one JSON object per line):
  stdin:  {action: 'load', voice, id?, modelDir?, adapterDir?, baseDir?, caps?,
                            warm?: bool}   # warm=False: skip the first-load warmup
                                           # because a speak is already waiting
          {action: 'generate', text, voice?, stream?: bool, ...}
          {action: 'generate_batch', items: [{i, text, voice?, stream?: bool}], ...}
          {action: 'cancel' | 'stop' | 'quit'}
                 # 'cancel'/'stop' ABORT a running generate_batch - see the reader
                 # thread in run(). Un-rendered rows come back as ordinary per-item
                 # failures with message 'cancelled', then 'batch_done' as always.
  stdout: {type: 'ready', device, backend?}
          {type: 'status' | 'loaded' | 'error' | 'stopped', ...}
          {type: 'audio', format:'pcm16', data, duration, sampleRate}        # batch
          {type: 'chunk', seq, format:'pcm16', data, duration, sampleRate}   # stream
          {type: 'done', duration, chunks, cancelled}                        # stream end
          {type: 'batch_chunk', i, seq, format:'pcm16', data, duration, sampleRate}
          {type: 'batch_item', i, streamed: true, duration, chunks}          # fast start

FAST START (Owen's ruling of 2026-09-04). An item carrying `stream: true` is a row
whose audio must reach the client WHILE IT IS STILL GENERATING, in sub-sentence
chunks, so the browser extension can begin playing in about a second instead of
waiting out a whole batch. That is the ONLY thing it changes: the batch is the same
width, scheduled the same way, on the same engine. A generate_batch with no
`stream` flag anywhere takes the pre-existing code path, byte for byte.

Four kinds of voice, distinguished by what a 'load' carries:

  STOCK        (no dirs)         tara, leah, jess, leo, dan, mia, zac, zoe, served
                                 from the HF cache. The voice is a prompt prefix.
  STOCK/BASE   (baseDir only)    the SAME stock voices, served from the local `_base`
                                 copy of the same checkpoint. Sent whenever the base
                                 is installed - see the key collapse below.
  MERGED       (modelDir)        a legacy full fine-tune. The voice IS the weights,
                                 so switching means a full engine reload.
  ADAPTER  (adapterDir+baseDir)  a LoRA over the shared base. Switching between two
                                 adapters on the same base never reloads the base.
                                 HOW it is attached differs by backend:
                                   vLLM - a PER-REQUEST LoRARequest. Several adapter
                                     voices are servable at once and one batch may mix
                                     them. A 'load' is a registration; no CUDA-graph
                                     recapture.
                                   MLX  - APPLIED to the resident model's projection
                                     modules. Exactly ONE voice is servable at a time,
                                     so a 'load' swaps the wrappers and the previous
                                     voice stops being renderable - engine_voices is
                                     REPLACED, not added to.

The engine is torn down and rebuilt only when the (modelDir, baseDir) pair
changes, which is exactly the engine's own load cache key.

THE KEY COLLAPSE. Because a stock load carries baseDir whenever the base is
installed, stock and adapter voices produce the SAME pair - so stock<->adapter is a
free registration too, not a teardown. On a machine with no base installed nothing
changes: stock keeps the (None, None) key it always had.

A voice is servable per request only after a 'load' registered it against the
CURRENT engine - a generate naming anything else is an error, never a silent render
in whatever is loaded.
"""

import base64
import json
import os
import queue
import re
import signal
import sys
import threading

import numpy as np

DEFAULT_SAMPLERATE = 24000


def _graceful_exit(signum, frame):
    """Cooperative shutdown: SIGTERM/SIGINT -> SystemExit(143).

    Python's default SIGTERM disposition kills the process WITHOUT running atexit
    hooks, so vLLM/torch never release the GPU - and force-killing a process stuck
    in a WSL dxg GPU wait is what kernel-wedges the whole WSL VM. Raising SystemExit
    instead unwinds the stdin loop, runs atexit (the engine's CUDA cleanup), and
    releases the GPU from inside the process. The stdin 'quit' action remains the
    primary teardown; this covers the pkill path.
    """
    print(f"[ORPHEUS-STREAM] Signal {signum} received - shutting down cleanly (releasing GPU)...",
          file=sys.stderr, flush=True)
    raise SystemExit(143)


signal.signal(signal.SIGTERM, _graceful_exit)
signal.signal(signal.SIGINT, _graceful_exit)


# ---- the fake-engine test door ----------------------------------------------
#
# WHY AN ARGV FLAG AND NOT AN ENVIRONMENT VARIABLE. This module is the
# PRODUCTION entry point, and both spawn arms hand the worker the parent
# environment: the native arm passes `...process.env`, and the WSL arm exports a
# forwarded set into a bash subshell. An env switch is therefore something a
# leaked variable in a developer shell, a stale `.env`, or a CI runner can turn
# on by accident - and the failure it produces is a whole book rendered as
# 220 Hz sine tones, reported as success, with nothing in the protocol saying
# so. An argv flag cannot leak: it is written by whoever wrote the command line.
#
# `argv` is otherwise unused by this worker (its whole interface is the
# JSON-lines protocol on stdin/stdout), so the flag costs nothing and an
# unrecognised argument is a hard error rather than a silent ignore.
_FAKE_ENGINE = False

FAKE_ENGINE_BANNER = """\
=================================================================
[narrator.serve] FAKE ENGINE ACTIVE (--fake-engine)
[narrator.serve] No model is loaded. Every sentence is a 220 Hz
[narrator.serve] sine wave sized from its text length. This is a
[narrator.serve] PROTOCOL TEST MODE - audio from it is not speech.
================================================================="""


def _fake_engine_enabled() -> bool:
    """True only when this process was started with --fake-engine."""
    return _FAKE_ENGINE


def _warn_fake_engine(where: str) -> None:
    """Re-state the banner on stderr wherever the protocol says "I am ready to
    render", so a mode this loud cannot be missed in a log.

    STDERR, not a new JSON field: the wire shape is a contract with
    electron/orpheus-worker-pool.ts and this port keeps it byte-identical. A
    reader of the log sees it; a parser sees nothing new.
    """
    if _FAKE_ENGINE:
        print(FAKE_ENGINE_BANNER, file=sys.stderr, flush=True)
        print(f'[narrator.serve] (at: {where})', file=sys.stderr, flush=True)


#: Engine ids this worker refuses to serve, and why. `higgs-v2-scaffold` is
#: interface scaffolding kept to prove `narrator.engine.protocol` fits a
#: non-Orpheus engine (see narrator/engine/higgs/__init__.py); Higgs v2 was
#: dropped as a rendering engine on 2026-09-04. Letting a spawn select it would
#: put a not-shipped engine in front of a real book, and its id is the only
#: thing saying otherwise.
UNSERVABLE_ENGINES = {
    'higgs-v2-scaffold': (
        'higgs-v2-scaffold is interface SCAFFOLDING, not a shipping engine: '
        'Higgs v2 was dropped 2026-09-04 and the code is kept only to prove the '
        "engine Protocol fits something that is not Orpheus. Use 'orpheus' or "
        "'higgs-v3'."),
}


def engine_id() -> str:
    """Which engine this worker serves: NARRATOR_ENGINE, default 'orpheus'.

    An UNKNOWN value is refused by name at the first use (see
    narrator.engine.registry), never defaulted: a book rendered by a different
    model than the one asked for is a silent failure, and this worker is spawned
    with an environment it does not author.
    """
    engine = (os.environ.get('NARRATOR_ENGINE') or '').strip() or 'orpheus'
    if engine in UNSERVABLE_ENGINES:
        raise ValueError(f'NARRATOR_ENGINE={engine}: {UNSERVABLE_ENGINES[engine]}')
    return engine


def _engine_class():
    """The engine this worker builds, for the id NARRATOR_ENGINE names.

    --fake-engine substitutes a model-free stand-in (serve.fake_engine), which
    produces deterministic sine-wave audio and needs no model, no GPU and no
    torch. It exists so tests/test_engine_serve_protocol.py can drive THIS file
    - the real reader thread, the real stdout lock, the real batch bookkeeping -
    and assert the exact message sequence electron/orpheus-worker-pool.ts reads.
    It is a TEST DOOR, never a fallback: nothing selects it implicitly. The fake
    is chosen PER ENGINE too, so a Higgs protocol test sees Higgs's sample rate
    and its `pads = False`.
    """
    if _fake_engine_enabled():
        from .fake_engine import fake_engine_class
        return fake_engine_class(engine_id())
    from ..engine import registry
    return registry.engine_class(engine_id())


def _engine_config(**kwargs):
    """The config object this engine takes, or the fake's stand-in for it.

    Each engine's factory decides which of the load message's keywords it
    understands: Orpheus takes them all (voice / model_dir / base_dir /
    adapter_dir / caps) as EngineConfig; Higgs refuses base_dir and caps by
    name, because it has neither a shared-base split nor any of Orpheus's EOS
    levers, and resolves its voice - reference clips plus transcripts - from the
    NARRATOR_HIGGS_VOICES document.
    """
    if _fake_engine_enabled():
        from .fake_engine import fake_engine_config
        return fake_engine_config(engine_id(), **kwargs)
    from ..engine import registry
    return registry.engine_config(engine_id(), **kwargs)


# -- Text normalization (numbers/currency/years -> words) ----------------------
# The listen path hands raw page text straight to the model; the audiobook path
# normalizes upstream (BookForge's own model pass over the narration copy).
# Mirror the common cases here so "$5.50", "1995", "50%" read naturally.
# num2words is a DECLARED BASE DEPENDENCY (python/pyproject.toml), imported
# plainly. It used to sit behind `try/except -> _HAS_NUM2WORDS`, and that guard
# was a FALLBACK of the worst kind: with it, a machine missing the module read
# every "$5.50" out as punctuation and every "1995" digit by digit for a whole
# listening session, and said nothing. This path is NOT dead - `normalize_for_tts`
# runs on every `generate` and every streamed batch row, which is the browser
# extension's listen path. (The audiobook path normalizes upstream in BookForge
# and never arrives here.)
#
# A missing module is now an ImportError at worker start: loud, immediate, and
# fixed by installing the dependency the project already declares.
from num2words import num2words as _num2words


def _number_refusal(value, lang, exc):
    """Every num2words failure, refused by name.

    These four helpers each used to end in `except Exception: return str(n)` -
    the same silent passthrough as the import guard, one layer down. A number
    this function cannot say is a defect in the caller's regex or in the
    language, and the listener must not be the one to discover it.
    """
    return ValueError(
        f'num2words could not render {value!r} in {lang!r}: {exc}. The listen '
        'path normalizes numbers before the model sees them; handing the raw '
        'digits on would have the model read them as punctuation.')


def _to_words(n, lang):
    try:
        return _num2words(int(n), lang=lang)
    except Exception as exc:
        raise _number_refusal(n, lang, exc) from exc


def _num_phrase(token, lang):
    token = token.replace(',', '')
    try:
        if '.' in token:
            intpart, frac = token.split('.', 1)
            words = _num2words(int(intpart or '0'), lang=lang)
            digits = ' '.join(_num2words(int(d), lang=lang) for d in frac)
            return f"{words} point {digits}"
        return _num2words(int(token), lang=lang)
    except Exception as exc:
        raise _number_refusal(token, lang, exc) from exc


def _ordinal(n, lang):
    try:
        return _num2words(int(n), lang=lang, to='ordinal')
    except Exception as exc:
        raise _number_refusal(n, lang, exc) from exc


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
    except Exception as exc:
        raise _number_refusal(y, lang, exc) from exc


def normalize_for_tts(text, language='en'):
    if not text:
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
        except Exception as exc:
            # The FIFTH site of the same defect the reviewer named three of.
            # `return m.group(0)` hands "$5.50" back verbatim for the model to
            # read as punctuation - silently, for every price in the book.
            raise _number_refusal(m.group(0), lang, exc) from exc
    s = re.sub(r'\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?', _money, s)
    s = re.sub(r'(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?%',
               lambda m: f"{_num_phrase(m.group(1), lang)} percent", s)
    s = re.sub(r'\b(\d+)(?:st|nd|rd|th)\b', lambda m: _ordinal(m.group(1), lang), s)
    s = re.sub(r'(?<![\d,.])(1[1-9]\d{2}|20\d{2})(?![\d,.])',
               lambda m: _year_to_words(int(m.group(1)), lang), s)
    s = re.sub(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?',
               lambda m: _num_phrase(m.group(0), lang), s)
    return s


# -- stdout protocol -----------------------------------------------------------
# One lock around the ONE print. Every message used to be written from the main
# thread (see _read_stdin's note: the reader thread only ever sets a flag), so a
# JSON line could not be interleaved with another. Fast start breaks that
# assumption on MLX: the engine decodes streamed frames on its own decoder thread
# and invokes on_chunk from there, so two threads can reach this function at once
# and `print` is not atomic - a torn line is an unparseable line, and the pool logs
# a JSON parse error and drops it.
#
# A lock rather than a queue-to-the-main-thread hop because the main thread is
# BLOCKED inside generate_batch_stream for the whole batch and has nothing to
# drain with. The ordering guarantees the protocol actually relies on survive it:
# a row's chunks carry `seq` and the client assembles by (i, seq), and 'batch_done'
# is still written by the main thread after generate_batch_stream has returned and
# every callback with it. Uncontended on the classic path, so switch-ON pays
# nothing for it.
_stdout_lock = threading.Lock()


def send_response(response_type: str, data: dict = None):
    msg = {'type': response_type}
    if data:
        msg.update(data)
    line = json.dumps(msg)
    with _stdout_lock:
        print(line, flush=True)


def audio_to_pcm16_base64(audio_array) -> str:
    a = np.asarray(audio_array, dtype=np.float32)
    a = np.clip(a, -1.0, 1.0)
    return base64.b64encode((a * 32767).astype(np.int16).tobytes()).decode('utf-8')


# Inter-sentence gap appended to every streamed sentence (seconds). Orpheus trims
# its own trailing pause, so without this sentences run together - and the player
# concatenates them with no gap. A ~0.3s pad gives natural breathing AND masks the
# brief <audio> blob-reload at each sentence boundary (the reload lands in silence).
# Tunable via ORPHEUS_STREAM_GAP (0 disables).
try:
    STREAM_GAP_SEC = max(0.0, float(os.environ.get('ORPHEUS_STREAM_GAP', '0.3')))
except (TypeError, ValueError):
    STREAM_GAP_SEC = 0.3


#: The sample rate the LOADED engine produces. DEFAULT_SAMPLERATE until one is
#: loaded. Every duration and every `sampleRate` on the wire reads this, because
#: the wire describes the audio that was actually rendered - not a constant. Both
#: shipping engines are 24 kHz today, so this changes no byte on either path; it
#: is what stops the next engine from mis-timing every cue in a session.
_ACTIVE_SAMPLERATE = DEFAULT_SAMPLERATE
#: Whether the loaded engine BAKES its own silence into a clip (`Engine.pads`).
#: Orpheus does; Higgs does not. Read by finalize_audio - see there.
_ACTIVE_PADS = True


def _uses_orpheus_token_pipeline(engine) -> bool:
    """True when this worker must drive the engine through ORPHEUS's own render
    methods rather than through `render_audio(text, index=i)`.

    THE DISCRIMINATOR IS THE ENGINE, NOT THE BACKEND NAME. The mlx / vllm /
    transformers arms below call `_generate_mlx_safe`, `_generate_mlx_batch_audio`,
    `_generate_audio_vllm_safe`, `_guard_truncation` and `_tokens_to_audio` -
    every one of them an OrpheusEngine method. They used to be selected by
    `engine.backend`, which is a RUNTIME name and not an engine: Higgs v3 on the
    Mac loads through mlx-audio and truthfully reports `backend == 'mlx'` while
    having none of those methods, so a Higgs load would have been routed into
    Orpheus's MLX ladder and failed on the first sentence. The backend name now
    only picks BETWEEN Orpheus's three.

    Every other engine renders one chunk with `render_audio` - Higgs v2's
    scaffold, Higgs v3 served, Higgs v3 on MLX - and an engine that offers
    neither is a named error, never a fallback.
    """
    return getattr(engine, 'ENGINE_ID', None) == 'orpheus'


def _edge_fade_of(engine):
    """The engine's EdgeFade, as the manifest and the pool see it.

    A shape, not a number: Higgs's fade is asymmetric (10 in / 25 out) because a
    chunk ends on a decay the ear does not expect. Matches the manifest's
    `edgeFadeMs: {in, out}` and assemble.engine_profiles.

    NO FALLBACK. An engine with no `edge_fade` used to become EdgeFade(0, 0)
    here, which is Orpheus's answer - so a `pads = False` engine that forgot to
    declare one would report "no fade needed" and the assembler would join its
    chunks bare. That is a book that CLICKS AT EVERY JOIN, shipped as a success.
    `edge_fade` is a member of the Engine protocol; an object without it is not
    an engine.
    """
    fade = getattr(engine, 'edge_fade', None)
    if fade is None:
        raise RuntimeError(
            f"engine '{getattr(engine, 'ENGINE_ID', type(engine).__name__)}' "
            'declares no edge_fade. It is a required member of '
            'narrator.engine.protocol.Engine, and guessing it is EdgeFade(0, 0) '
            "would silently drop a pads=False engine's chunk-edge fades - every "
            'join in the book would click.')
    return fade


def active_samplerate() -> int:
    return _ACTIVE_SAMPLERATE


def set_active_engine_audio(samplerate: int, pads: bool) -> None:
    """Adopt the loaded engine's audio facts. Called once per engine load."""
    global _ACTIVE_SAMPLERATE, _ACTIVE_PADS
    _ACTIVE_SAMPLERATE = int(samplerate)
    _ACTIVE_PADS = bool(pads)


def finalize_audio(audio_np, pads=None):
    """Prepare one rendered sentence for the wire.

    THREE STEPS, AND ONLY THE FIRST IS ENGINE-SPECIFIC.

    1. TRIM, for a `pads=True` engine only. Orpheus bakes its own lead/trail
       silence into every clip (`_classify_gap` + `_save_audio`), and its
       trailing end-pause is long enough to hear as a stall; this cuts back to
       the last sample above 0.01 plus ~150 ms. For a `pads=False` engine -
       Higgs, measured: no pads, no fades, bare speech at both ends - THE SAME
       TRIM WOULD CUT INTO THE WORD. A quiet final consonant sits under 0.01,
       and there is no padding in front of it to absorb the cut. So it is
       skipped, and the audio goes out exactly as decoded, which is also what
       `Engine.edge_fade` assumes (the fades are the assembler's).
    2. Peak-normalize if it clipped. Engine-independent.
    3. APPEND THE INTER-SENTENCE GAP, FOR EVERY ENGINE. This is a CLIENT
       contract, not an engine property: the player concatenates streamed
       chunks with no gap of its own, so without it every sentence runs into
       the next. It is deliberately NOT conditioned on `pads` - `pads` says who
       owns the silence INSIDE a chunk file for ASSEMBLY, and this is the
       streaming wire, where the worker is the only thing that can put a gap
       between two sentences. (The audiobook path never goes through here; it
       writes chunk files and the assembler realizes the manifest's gaps.)

    `pads` defaults to the loaded engine's (see set_active_engine_audio).
    """
    if audio_np is None:
        return None
    a = np.asarray(audio_np, dtype=np.float32).flatten()
    if a.size == 0:
        return a
    rate = active_samplerate()
    if _ACTIVE_PADS if pads is None else pads:
        thr = 0.01
        idx = np.where(np.abs(a) > thr)[0]
        if idx.size:
            start = max(0, int(idx[0]) - int(rate * 0.05))
            end = min(a.size, int(idx[-1]) + int(rate * 0.15))
            a = a[start:end]
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak > 1.0:
        a = a / peak * 0.95
    if STREAM_GAP_SEC > 0:
        a = np.concatenate([a, np.zeros(int(rate * STREAM_GAP_SEC), dtype=np.float32)])
    return a


def detect_device() -> str:
    """Informational device label for the 'ready' message. Orpheus always runs a
    single worker regardless, so this only feeds status/UI, not topology."""
    if _fake_engine_enabled():
        return 'cpu'
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
    """The backend the engine WILL use in this process ('vllm' | 'mlx' |
    'transformers'), or None if it cannot be determined.

    Reported on the 'ready' line because the pool needs it BEFORE any voice loads:
    only vLLM can render a voice PER REQUEST, and only vLLM can be handed a local
    base dir for stock voices. Everything downstream of that answer is a correctness
    guard, so it is taken from the engine's own detector rather than re-derived here
    from the platform - a second implementation of "which backend" is a second thing
    to drift.

    Costs an import of the engine module (torch), NOT a model load; detect_device()
    above already pays the torch import.

    IT RAISES. It used to swallow every exception and return None, "reporting
    unknown", on the theory that an env with broken imports would degrade to
    pre-adapter behaviour. That theory was wrong, and the Mac validation run
    caught it: importing the engine is also how the engine's MODULE is loaded,
    so an ImportError here means no engine will EVER load in this process. The
    worker then printed `{"type":"ready","device":"mlx"}` with no `backend`, the
    pool saw a healthy handshake, and every generate answered "Model not loaded"
    - a worker that looks alive and can never render. A backend that cannot be
    determined is a dead worker; `main()` exits non-zero with the reason on
    stderr instead of handshaking.

    A backend NAME this worker does not recognise is a different thing and still
    returns None: the engine loaded and answered, we simply have no guard
    calibrated for what it said.
    """
    backend = _engine_class().detect_backend()
    known = ('vllm', 'mlx', 'transformers', 'vllm-omni')
    if backend not in known:
        print(f'[narrator.serve] engine reported backend {backend!r}, which is not '
              f'one of {known}; reporting unknown', file=sys.stderr)
        return None
    return backend


# -- Orpheus streaming server --------------------------------------------------
# Built-in voices. Custom finetunes are NOT listed here - they arrive with either a
# merged model dir (`modelDir`) or a LoRA adapter (`adapterDir` + `baseDir`) on the
# load request and use their token verbatim, bypassing this allowlist (mirrors the
# engine's model_dir / adapter_dir branches).
VALID_VOICES = {'tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'}
DEFAULT_VOICE = 'leah'


class OrpheusStreamServer:
    def __init__(self):
        self.orph = None              # OrpheusEngine instance (lazy)
        self.current_voice = None
        self.current_model_dir = None  # None = stock/adapter; else a merged model dir
        self.current_base_dir = None   # the shared base (adapter mode, or stock-from-base)
        # Voices this engine can serve RIGHT NOW: token -> adapter dir (None for a
        # stock or merged voice). Populated by 'load', emptied by teardown - so it
        # can never claim a voice whose weights or adapter registration went away
        # with a previous engine.
        self.engine_voices = {}
        # token -> the CATALOG ID that claimed it (see _check_token_owner). The pool
        # keys voices by catalog id, this server keys them by prompt token, and two
        # ids declaring the same token would otherwise collapse into one slot.
        self.engine_voice_ids = {}
        self.device = None
        self.backend = None           # the engine's detected backend, probed at 'ready'
        # Set by the STDIN READER THREAD the moment a 'cancel'/'stop' arrives, so a
        # generate_batch already running on the main thread can see it between decode
        # steps and abandon what is left. Cleared by the main loop when it dequeues
        # that same cancel and acknowledges it - never anywhere else, so the flag can
        # only ever describe work that was already in flight when the cancel landed.
        self._cancel = threading.Event()

    def _ensure_engine(self, voice: str, model_dir: str = None, caps: dict = None,
                       adapter_dir: str = None, base_dir: str = None,
                       voice_id: str = None, warm: bool = True):
        """Load (or reload) the Orpheus model and make `voice` the default; on first
        load WARM the generate path before reporting ready - unless the caller asked
        for a cold ready (`warm=False`), see _warmup.

        Four modes (see the module docstring). The engine is torn down ONLY when the
        (model_dir, base_dir) pair changes - the same key the engine's own load cache
        uses - because that pair, and nothing else, decides which WEIGHTS are served:

          adapter -> adapter, same base   same pair  -> register + switch, NO reload
          stock   -> stock                same pair  -> prompt prefix, NO reload
          stock  <-> adapter, same base   same pair  -> register + switch, NO reload
          merged  -> anything             differs    -> reload
          stock (no base) <-> adapter     differs    -> reload

        The third line is the KEY COLLAPSE (vLLM only - the pool sends a stock load no
        baseDir on MLX, where stock comes from a different repo). An engine can serve
        an adapter if and only if it was given a base_dir: on vLLM because enable_lora
        is a construction-time property keyed on it, on MLX because that dir is the
        model the wrappers get applied to.
        """
        if adapter_dir and model_dir:
            send_response('error', {
                'message': f"Orpheus load for '{voice}' carried both a merged modelDir "
                           f'({model_dir}) and an adapterDir ({adapter_dir}). They select '
                           'different weights - pass exactly one.'
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
                           'turns it into a voice - it needs both.'
            })
            return False

        # THE ENGINE VALIDATES ITS OWN VOICES. Orpheus's rule is an allowlist of
        # eight stock TOKENS plus "anything, verbatim, when a modelDir or an
        # adapterDir names weights"; Higgs v3's is an entry in the
        # NARRATOR_HIGGS_VOICES document. Checking a v3 load against Orpheus's
        # list rejected every real v3 voice ("Unknown Orpheus voice
        # 'deathstalker'") - the engine that will render it is the only thing
        # that knows what a voice IS for it.
        try:
            v = _engine_class().resolve_load_voice(
                voice, model_dir=model_dir, adapter_dir=adapter_dir,
                base_dir=base_dir)
        except Exception as e:
            send_response('error', {'message': str(e)})
            return False

        if not self._check_token_owner(v, voice_id):
            return False

        # Different weights (a merged model on either side, or a different shared
        # base) -> tear the engine down and reload. Same pair -> the engine stays up.
        if self.orph is not None and (model_dir, base_dir) != (self.current_model_dir,
                                                               self.current_base_dir):
            send_response('status', {'message': 'Switching Orpheus model...'})
            self._teardown_engine()

        first_load = self.orph is None
        if first_load:
            send_response('status', {'message': 'Loading Orpheus model...'})
            # Imported here so 'ready' is sent before the heavy vLLM/MLX import, and
            # so an env without these deps fails on load (surfaced) not at startup.
            engine_cls = _engine_class()
            config = _engine_config(
                voice=v,
                model_dir=model_dir,
                # baseDir alone is the STOCK-FROM-LOCAL-BASE mode: the engine serves
                # the base checkpoint from the local folder and - on vLLM - builds
                # the engine with enable_lora, which is a CONSTRUCTION-time property.
                # That is what lets an adapter voice later join this engine without a
                # reload.
                base_dir=base_dir,
                adapter_dir=adapter_dir,
                # Registered at construction rather than after it, so the warm-up
                # renders below exercise the same sampling path the real sentences
                # will. (e2a's worker registered them in a separate step; the engine
                # now takes them on the config, which removes the window in which a
                # loaded engine could serve one request with default tuning.)
                caps=caps or {},
            )
            self.orph = engine_cls(config)      # __init__ -> load_engine() loads model
            # Every duration, every `sampleRate` on the wire and finalize_audio's
            # trim now describe THIS engine instead of a module constant. Both
            # shipping engines are 24 kHz, so nothing on either path changes
            # today; what it prevents is the next engine mis-timing a session.
            set_active_engine_audio(getattr(self.orph, 'SAMPLE_RATE',
                                            DEFAULT_SAMPLERATE),
                                    bool(getattr(self.orph, 'pads', True)))
            self.current_model_dir = model_dir
            self.current_base_dir = base_dir
            send_response('status', {'message': 'Model loaded'})
        else:
            # Warm engine, same weights. NOT EVERY ENGINE CAN SWITCH IN PLACE: a
            # served engine's voice is baked into the server it launched (the
            # reference clip rides in every request, an adapter is a launch
            # argument), so it refuses BY NAME instead of raising a bare
            # AttributeError from a method it does not have.
            if not hasattr(self.orph, 'set_voice'):
                send_response('error', {
                    'message': f"engine '{getattr(self.orph, 'ENGINE_ID', '?')}' "
                               'cannot switch voice on a live worker: it has no '
                               'set_voice(). Quit this worker and start one for '
                               'that voice.'
                })
                return False
            # For a stock voice this is the free
            # prompt-prefix switch it always was; for an adapter voice it registers
            # (and VALIDATES) the LoRA and re-points the engine's default voice at it
            # in one step. set_voice keeps orph.voice and orph.adapter_dir in lockstep
            # in BOTH directions - attaching the adapter for an adapter voice, and
            # detaching the previous one for a stock voice, which is what makes the
            # collapsed stock<->adapter switch safe.
            self.orph.set_voice(v, adapter_dir)
            # A registration failure must not leave the loaded engine serving requests
            # with default tuning, so tear the engine down and let the error propagate
            # as a load failure.
            try:
                self._apply_voice_caps(v, caps)
            except Exception:
                self._teardown_engine()
                raise
        self.current_voice = v
        # What this engine can serve RIGHT NOW. On vLLM a load ADDS a voice: the
        # previous one keeps its registration and stays renderable, per request, in the
        # same batch. On MLX a load REPLACES the voice: the adapter is applied to the
        # resident model itself, so the moment set_voice returns the previous voice
        # cannot be rendered at all. Accumulating there would leave _row_voice accepting
        # a token the engine no longer has weights for.
        if self.orph.backend == 'mlx':
            self.engine_voices = {v: adapter_dir}
        else:
            self.engine_voices[v] = adapter_dir
        # Only a load that NAMES an id claims the token. A load without one (an older
        # pool build) must not overwrite an existing claim with None - that would
        # quietly disarm _check_token_owner for every load after it.
        #
        # This one ACCUMULATES on every backend, MLX included: it does not describe what
        # is servable, it records which catalog id owns a prompt token for the life of
        # the engine.
        if voice_id:
            self.engine_voice_ids[v] = voice_id

        # Warm the generate path ONCE per load, so the cold-start cost is paid here
        # (absorbed by the user's "start the server and find an article" window),
        # not on the first sentences they actually play.
        #
        # That trade only holds while NOBODY IS WAITING. A load the pool marks
        # warm=False was triggered by a pending speak: the listener is already on a
        # spinner, and ~40s of discarded renders in front of their first sentence
        # costs far more than the ~10s of lazy compile the first real batch would
        # absorb by itself. So the warmup is skipped and the batch pays it.
        if first_load and warm:
            self._warmup()

        send_response('status', {'message': f'Voice loaded: {v}'})
        return True

    def _is_cancelled(self) -> bool:
        """Has a 'cancel'/'stop' arrived since this work started?

        Handed to the engine as `should_stop` and checked around each group, so it
        must stay a plain flag read - no I/O, no locking beyond Event's own.
        """
        return self._cancel.is_set()

    def _check_token_owner(self, token: str, voice_id: str) -> bool:
        """Refuse a load whose PROMPT TOKEN is already claimed by a different catalog id.

        The pool identifies a voice by its catalog id; this server identifies it by the
        prompt token, because that is what the model actually conditions on and what
        keys the adapter registry. Those are usually the same string, but a catalog
        entry may declare a token that differs from its id - and nothing in the wire
        format stops TWO ids from declaring the SAME token. If that happened they would
        collapse into one slot here: loading v2 would re-point the token at v2's
        adapter, and every subsequent request for v1 would be served v2's voice, as a
        success.

        The installer already refuses colliding tokens at install time, so this is
        defense for the path that bypasses it: a hand-edited models.json.

        A load that carries no id (an older pool build) claims nothing and is accepted -
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
                       'cannot share one token - the second would be rendered with the '
                       "first's adapter and reported as a success. Give one of them a "
                       'distinct token in the Orpheus models manifest.'
        })
        return False

    def _teardown_engine(self):
        """Release the current Orpheus engine (and its ~6 GB of VRAM) so a different
        model can take its place.

        engine_voices is emptied with it: every entry describes what THIS engine can
        serve - a prompt token it has weights for, or an adapter registered under a
        lora id that only means anything inside the vLLM object being destroyed. A
        surviving entry would let a request for a voice from the previous engine be
        accepted and rendered in whatever is loaded now."""
        # The engine's audio facts go with it - a later load re-adopts.
        set_active_engine_audio(DEFAULT_SAMPLERATE, True)
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
        without this the lag lands minutes later on the first played sentences.
        MLX can recompile per sequence length, so warm a few increasing lengths.
        Output is discarded; we only want the compile/cache side effect. Failures
        are non-fatal - a warmup hiccup must never block the voice from loading.

        THREE shapes are warmed, not every width: the single-sentence path (width 1),
        the scheduler's first-wave RAMP width (ORPHEUS_STREAM_RAMP), and ONE batch at
        the full ORPHEUS_STREAM_BATCH width, which is the shape essentially every
        read-ahead group uses. Warming every width 1..16 measured 176s of a 184s
        load - and load time is user-visible on EVERY server start, while an
        unwarmed intermediate width just compiles lazily, ~10s, once, behind a
        buffer that is by then many sentences deep.
        """
        if os.environ.get('ORPHEUS_SKIP_WARMUP') == '1':
            return
        # The GROUPING cap can be much wider than anything worth warming: the pool
        # ramps batch width up to it, and the wide rungs are only ever reached behind
        # a buffer many sentences deep. ORPHEUS_STREAM_WARM_MAX is the widest shape
        # worth paying for at load; it falls back to the grouping cap.
        try:
            n = int(os.environ.get('ORPHEUS_STREAM_WARM_MAX')
                    or os.environ.get('ORPHEUS_STREAM_BATCH', '16'))
        except ValueError:
            n = 16
        if n < 1:
            n = 1
        try:
            ramp = int(os.environ.get('ORPHEUS_STREAM_RAMP', '8'))
        except ValueError:
            ramp = 8
        # A ramp of 1 or of the full width is already covered by the other two shapes.
        ramp = max(1, min(ramp, n))
        widths = sorted({w for w in (ramp, n) if w > 1})
        shapes = ', '.join(str(w) for w in (1, *widths))
        send_response('status', {'message': f'Warming up voice (widths {shapes})...'})
        warm_texts = (
            'Hello.',
            'This is a brief warmup.',
            'Here is a slightly longer warmup sentence to prepare smooth playback.',
        )
        # 1) Single-sentence path (width 1 - the solo render, and any width-1 group).
        #    MLX recompiles per sequence length, so warm a few increasing lengths.
        for t in warm_texts:
            try:
                self._generate_audio(t)  # discard - the side effect is the warmup
            except Exception as e:
                print(f'[narrator.serve] warmup generation failed (non-fatal): {e}',
                      file=sys.stderr)
        # 2) BATCHED path, at the ramp width and the FULL width. UNIFORM texts on
        #    purpose: identical sentences -> identical token lengths -> exactly one
        #    bucket at exactly this width.
        for w in widths:
            try:
                self._generate_audio_batch([warm_texts[1]] * w)  # discard - warms the graph
            except Exception as e:
                print(f'[narrator.serve] batch warmup (width {w}) failed (non-fatal): {e}',
                      file=sys.stderr)
        send_response('status', {'message': 'Warmup complete'})

    def load_voice(self, voice: str, model_dir: str = None, caps: dict = None,
                   adapter_dir: str = None, base_dir: str = None,
                   voice_id: str = None, warm: bool = True) -> bool:
        try:
            return self._ensure_engine(voice, model_dir, caps, adapter_dir, base_dir,
                                       voice_id, warm)
        except Exception as e:
            # NAME THE ENGINE THAT ACTUALLY FAILED. This said "Failed to load
            # Orpheus" for every engine, so a Higgs load failure on the Mac
            # reported the wrong model by name - which is precisely the moment
            # someone is trying to work out WHICH of two engines is broken.
            # engine_id() cannot raise here: an unservable NARRATOR_ENGINE is
            # refused in main() before any load is accepted.
            send_response('error',
                          {'message': f'Failed to load {engine_id()}: {e}'})
            return False

    def _row_voice(self, voice) -> str:
        """The voice token one generate row must render in.

        Absent/blank -> the server's current default voice, which is what every
        request meant before per-request voices existed. Anything else must have been
        registered against the LIVE engine by a 'load'; a voice this engine cannot
        serve is an ERROR, never a quiet render in whatever happens to be loaded -
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
            'Send a load for it first - an adapter can only be served by an engine that '
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
        voices; and the values it fed were read at IMPORT for everything except the
        chars/sec guard, so a repPenalty set on the second voice load never took
        effect at all. eosBoost was omitted entirely on the (incorrect) grounds that
        it is "read at engine load", so streaming ran every voice with eosBoost=0
        while the catalog declares 8 @ 2.0 for the bed-free fine-tunes.

        Registration REPLACES the voice's caps, so a cap the payload omits reverts
        to env/default rather than lingering from an earlier load. Non-tuning keys
        in the same payload (maxChars = prep packing, sentenceGap = assembly, and
        neither is read on any streaming path - streaming pads with its own
        STREAM_GAP) are accepted and ignored BY NAME by the engine; a key that is
        neither raises.
        """
        applied = self.orph.register_voice_caps(voice, caps or {})
        print(f'[narrator.serve] voice caps registered for {voice}: '
              f'{applied or "none (engine defaults)"}', file=sys.stderr)

    def _reject_per_request_voice(self, voice: str) -> None:
        """Only the vLLM backend renders a per-request voice - say so instead of
        rendering the wrong one.

        MLX can SERVE an adapter voice (the engine applies it to the resident model),
        but only one at a time: the adapter is part of the weights the forward pass
        runs through, so there is no per-row selection to be had. Its batch path also
        builds ONE sampler per bucket from the engine's own caps, so even a stock
        per-row prompt token would carry the wrong voice's sampling. On
        MLX/transformers a row may therefore only use the loaded voice.

        Raised PER ROW, never over a whole batch. It used to be checked for every item
        up front, before any group was built, so one stray voice failed all 16
        sentences - two whole reading blocks - when 15 of them were ordinary sentences
        in a voice that was right there."""
        if voice != self.current_voice:
            raise ValueError(
                f"The '{self.orph.backend}' backend cannot render '{voice}' per request - "
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

    def _generate_audio(self, text: str, voice: str = None, index: int = 0):
        """Generate one sentence to a float numpy waveform via the engine's
        backend-specific path (mirrors OrpheusEngine.convert(), but in-memory).

        `voice` (default: the loaded voice) selects the prompt token, the sampling
        caps and - in adapter mode - the LoRA, all the way down through the retake
        ladder, so a per-request voice is honoured end to end."""
        orph = self.orph
        v = self._row_voice(voice)
        clean = orph._clean_sentence_for_tts(text)
        if not clean:
            return np.zeros(int(active_samplerate() * 0.05), dtype=np.float32)
        if not _uses_orpheus_token_pipeline(orph):
            # NOT AN ORPHEUS ENGINE. Higgs v3 - served by vllm-omni on
            # Windows/Linux, in-process through mlx-audio on the Mac. Either
            # way there is no token stream on this side to decode and none of
            # Orpheus's re-render ladders apply (v3 stops on its own; what it
            # does instead is drop the tail of a long chunk, which is a PACKER
            # concern - StopPolicy.max_chars - not a retry). One call, one
            # waveform.
            self._reject_per_request_voice(v)   # one voice per loaded engine
            render = getattr(orph, 'render_audio', None)
            # `index` seeds the row (seed + i). The sequential fallback in
            # _generate_audio_batch passes the row's own index, so a batch does
            # not render every sentence from the same draw; a single 'generate'
            # is index 0, which is the whole batch it is.
            if render is None:
                raise RuntimeError(
                    f"engine '{getattr(orph, 'ENGINE_ID', '?')}' is not Orpheus and "
                    'offers no render_audio(text). This worker has no way to render '
                    'one sentence with it.')
            audio = render(clean, index=index)
        elif orph.backend == 'mlx':
            self._reject_per_request_voice(v)
            # _safe variant: render the sentence WHOLE, and only re-render it split at
            # sentence boundaries if that render hit the token cap, so a long sentence
            # is never shipped clipped (matches the audiobook path).
            audio = orph._generate_mlx_safe(clean)
            # Backstop a SILENT early-EOS truncation (clean stop, audio too short for
            # the text) the token-cap check can't see - mirrors convert().
            # force_split: a whole-chunk re-render would just clean-EOS (truncated)
            # again - the resplit must actually split.
            audio = orph._guard_truncation(
                0, clean, audio,
                lambda c: orph._generate_mlx_safe(c, force_split=True)
            )
        elif orph.backend == 'vllm':
            audio = orph._generate_audio_vllm_safe(clean, voice=v)
            # Same early-EOS backstop.
            audio = orph._guard_truncation(
                0, clean, audio,
                lambda c: orph._generate_audio_vllm_safe(c, force_split=True, voice=v),
                v
            )
        elif orph.backend not in ('vllm', 'mlx', 'transformers'):
            # An ORPHEUS engine reporting a backend Orpheus does not have. Not a
            # served engine - that arm is the first branch now - so there is
            # nothing calibrated to render it with.
            raise RuntimeError(
                f"Orpheus reports backend '{orph.backend}', which is none of its "
                'three (vllm / mlx / transformers). This worker has no path for it.')
        else:
            self._reject_per_request_voice(v)   # transformers: same one-voice limit
            audio = orph._tokens_to_audio(
                orph._generate_tokens_transformers(f"{orph.voice}: {clean}")
            )
        return finalize_audio(audio)

    def _generate_audio_batch(self, texts, voices=None):
        """Generate many sentences at once. On the vLLM backend this is a TRUE
        batch - one engine.generate([prompts]) call whose continuous batching runs
        the sequences concurrently on the GPU (the same path Orpheus audiobooks use
        in convert_batch). MLX and transformers have no batched path wired here, so
        they fall back to sequential. Returns a list of float waveforms aligned to
        `texts` (a tiny silence for empty sentences, None for a non-empty sentence
        that FAILED to render - the caller reports those as failures).

        `voices`, when given, is aligned to `texts` and names each row's voice; None
        (or None entries) means the loaded voice. On vLLM every per-row property -
        prompt token, sampling caps, LoRA - is resolved from that row's own voice, so
        ONE batch can carry several voices."""
        orph = self.orph
        cleaned = [orph._clean_sentence_for_tts(t) for t in texts]
        row_voices = [self._row_voice(voices[i] if voices else None)
                      for i in range(len(texts))]

        if _uses_orpheus_token_pipeline(orph) and orph.backend == 'vllm':
            from vllm import TokensPrompt
            results = [None] * len(texts)
            nonempty = [i for i, c in enumerate(cleaned) if c]
            # Feed raw token IDs via TokensPrompt - byte-identical to the audiobook
            # batch path (convert_batch) and the single-sentence streaming path
            # (_generate_audio_vllm_safe). Decoding IDs back to a STRING for vLLM to
            # re-tokenize prepends a stray second BOS (the voice-token leak).
            prompts = [TokensPrompt(prompt_token_ids=orph._format_prompt_ids(cleaned[i], row_voices[i]))
                       for i in nonempty]
            # Sampling comes from the engine's _vllm_sampling_params - the ONE builder
            # the audiobook path uses - instead of a SamplingParams assembled here.
            # Assembling it locally meant streaming silently diverged from the
            # audiobook path every time the config grew: it dropped the per-request
            # EOS-boost logits processor outright, so every streamed voice ran with
            # eosBoost=0 no matter what the catalog declared. A LIST aligned to
            # `prompts` because the boost's start threshold is sized from each
            # sentence's own length - and from each item's own voice.
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
                        # Cap hit without finishing -> the audio would be clipped.
                        # Re-render split at sentence boundaries (same ladder the
                        # audiobook convert_batch uses) so nothing is cut off.
                        print(f'[narrator.serve] batch sentence [{i}] hit the audio-token cap; re-rendering split',
                              file=sys.stderr)
                        audio_np = orph._generate_audio_vllm_safe(cleaned[i], voice=row_voices[i])
                    # Backstop a SILENT early-EOS truncation (clean stop, audio too
                    # short for the text) the cap check above can't catch - mirrors
                    # the audiobook convert_batch. The row's voice is BOUND into the
                    # retake (default arg, not the loop variable) so a late-firing
                    # lambda can't re-render one row in another row's voice.
                    audio_np = orph._guard_truncation(
                        i, cleaned[i], audio_np,
                        lambda c, rv=row_voices[i]: orph._generate_audio_vllm_safe(
                            c, force_split=True, voice=rv),
                        row_voices[i]
                    )
                    results[i] = finalize_audio(audio_np)
            for i, c in enumerate(cleaned):
                if not c:
                    results[i] = np.zeros(int(active_samplerate() * 0.05), dtype=np.float32)
            return results

        if _uses_orpheus_token_pipeline(orph) and orph.backend == 'mlx':
            # In-memory MLX batch (_generate_mlx_batch_audio): one BatchGenerator pass
            # over the cleaned sentences, ~3.6x per-sentence throughput. Returns raw
            # waveforms (None for empty/failed); finalize each, fill tiny silence ONLY
            # for genuinely-empty texts (the "empty -> silence" contract), and keep
            # None for failed non-empty items.
            #
            # One voice only: the engine builds ONE sampler per MLX bucket from its own
            # caps, so a per-row voice could get its prompt token but never its tuning.
            # A BACKSTOP, not the gate: generate_batch checks every item with
            # _resolve_row and fails the offending ones individually, so nothing
            # unservable reaches here; the only caller left on this branch is _warmup.
            for rv in row_voices:
                self._reject_per_request_voice(rv)
            raw = orph._generate_mlx_batch_audio(cleaned)
            out = []
            for i in range(len(cleaned)):
                a = raw[i] if i < len(raw) else None
                # Same early-EOS/failed-row backstop as the ordered read-ahead path
                # (a no-op for empty cleaned texts and plausible audio).
                a = orph._guard_truncation(
                    i, cleaned[i], a,
                    lambda c: orph._generate_mlx_safe(c, force_split=True)
                )
                if a is None or len(a) == 0:
                    if cleaned[i]:
                        # Non-empty text with no audio = FAILED render. Keep None so
                        # the caller emits the 'No audio generated' failure item -
                        # never substitute silence for a failure.
                        out.append(None)
                    else:
                        # Genuinely empty text -> tiny silence (the designed contract).
                        out.append(np.zeros(int(active_samplerate() * 0.05), dtype=np.float32))
                else:
                    out.append(finalize_audio(a))
            return out

        # transformers and every SERVED engine: no batched API - sequentially.
        # The row index goes with each call so a served engine seeds row i with
        # `seed + i` (see HiggsV3Engine._seed_for); Orpheus ignores it.
        return [self._generate_audio(t, row_voices[i], index=i)
                for i, t in enumerate(texts)]

    @staticmethod
    def _emit_batch_item(it, audio):
        """Emit one 'batch_item', keyed by the caller-supplied index `i`. Empty/None
        audio -> the 'No audio generated' message; otherwise the PCM16 payload. This
        is the exact per-item wire shape the non-MLX single-dispatch loop uses, so
        MLX group emission and non-MLX emission are byte-identical per item."""
        if audio is None or len(audio) == 0:
            send_response('batch_item', {'i': it.get('i'), 'message': 'No audio generated'})
        else:
            send_response('batch_item', {
                'i': it.get('i'),
                'format': 'pcm16',
                'data': audio_to_pcm16_base64(audio),
                'duration': len(audio) / active_samplerate(),
                'sampleRate': active_samplerate(),
            })

    def _generate_batch_mlx_ordered(self, items, language: str):
        """MLX read-ahead in READING ORDER, in groups of up to ORPHEUS_STREAM_BATCH.

        Sentences are grouped as CONSECUTIVE runs so the next sentences a listener
        needs are the ones in flight. WITHIN a group, items are emitted PER ROW AS IT
        RETIRES (_generate_mlx_batch_audio's on_row callback) rather than when the
        whole group finishes: mlx-lm retires rows spread across the batch - the
        shortest at ~70% of its depth - so the earliest sentences of a 30-43s batch
        reach the client ~12s sooner. Rows therefore arrive in RETIREMENT order, not
        reading order; the wire protocol is explicitly out-of-order (clients assemble
        by sentence index - see docs/TTS_API.md). One bad group fails only its own
        items; every item is emitted exactly once; batch_done always fires last.

        MLX renders ONE voice - see _reject_per_request_voice - so every item is
        checked before the groups are built, and an item asking for anything but the
        loaded voice is FAILED INDIVIDUALLY (reported with the reason) and left out of
        the grouping.

        CANCELLABLE. The engine's generator is handed self._is_cancelled and checks it
        once per decode step, so a 'cancel' arriving on stdin frees this worker within
        a step (~50-60ms) instead of at the end of a 30-43s batch. Rows already
        emitted through on_row stand; every row that never rendered is reported as an
        ordinary per-item failure with message 'cancelled' (the sweep in `finally`),
        and batch_done fires exactly as it always does.
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
            # Clean per item (normalize -> engine clean), aligned 1:1 to `items`. An
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
                    # empty one does - the group must stay a CONSECUTIVE run of
                    # sentences that will actually be rendered.
                    if cur:
                        groups.append(cur)
                        cur = []
                    continue
                if not c:
                    if cur:
                        groups.append(cur)
                        cur = []
                    groups.append([pos])  # empty -> silence singleton
                    continue
                if len(cur) >= cap:
                    groups.append(cur)
                    cur = []
                cur.append(pos)
            if cur:
                groups.append(cur)

            for group in groups:
                if self._is_cancelled():
                    break
                # Empty singleton -> tiny silence (the "empty -> silence" contract).
                if len(group) == 1 and not cleaned[group[0]]:
                    pos = group[0]
                    self._emit_batch_item(
                        items[pos], np.zeros(int(active_samplerate() * 0.05), dtype=np.float32))
                    emitted.add(pos)
                    continue

                group_texts = [cleaned[p] for p in group]

                def _resolve(k, a, group=group):
                    """Guard + emit ONE row of this group, exactly once.

                    Called from the engine's on_row the moment that row retires, and
                    again from the sweep below for any row on_row never reached (a
                    bucket-level failure inside the engine) - `emitted` makes the
                    second call a no-op for rows already sent.

                    The guard runs FIRST so a failed row (None/empty from a decode
                    error or immediate early-EOS) gets the same one-retake backstop
                    as a truncated one - mirrors _convert_mlx_batch. Never substitute
                    silence for a FAILURE: a non-empty sentence that still yields
                    nothing is emitted as a 'No audio generated' failure item.
                    """
                    p = group[k]
                    if p in emitted:
                        return
                    # force_split: the guard fires on a CLEAN early EOS (or an empty
                    # row), so a whole-chunk re-render would very likely reproduce it.
                    a = orph._guard_truncation(
                        p, cleaned[p], a,
                        lambda c: orph._generate_mlx_safe(c, force_split=True)
                    )
                    if a is None or len(a) == 0:
                        # A legit empty sentence gets a tiny silence slot; a non-empty
                        # sentence that STILL produced nothing after the retake is a
                        # real failure - emit it as one ('No audio generated') so the
                        # scheduler marks the sentence failed instead of playing air.
                        if cleaned[p]:
                            print(f'[narrator.serve] MLX batch produced no audio for non-empty '
                                  f'sentence [{items[p].get("i")}] - reporting failure',
                                  file=sys.stderr)
                        audio = np.zeros(int(active_samplerate() * 0.05), dtype=np.float32) if not cleaned[p] else None
                    else:
                        audio = finalize_audio(a)
                    self._emit_batch_item(items[p], audio)
                    emitted.add(p)

                try:
                    # One consecutive reading-order group == one engine batch, whose
                    # rows stream out through _resolve as they retire - and which
                    # abandons what is left the moment a cancel lands on stdin.
                    raw = orph._generate_mlx_batch_audio(
                        group_texts, on_row=_resolve, should_stop=self._is_cancelled)
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
                # SKIPPED on a cancel: those rows were abandoned unrendered, and
                # resolving them here would run the retake ladder (a fresh solo
                # render each) on the very work the cancel exists to stop.
                if self._is_cancelled():
                    break
                for k in range(len(group)):
                    _resolve(k, raw[k] if k < len(raw) else None)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            for pos, it in enumerate(items):
                if pos not in emitted:
                    send_response('batch_item', {'i': it.get('i'), 'message': f'Batch generation failed: {e}'})
        finally:
            # Every item is answered exactly once, cancel or not - the pool resolves a
            # batch by index and a row with no message would hang its sentence until
            # the 180s timeout tainted the worker. On the cancel path that message is
            # 'cancelled'; the scheduler is already dropping these as stale.
            cancelled = self._is_cancelled()
            for pos, it in enumerate(items):
                if pos in emitted:
                    continue
                emitted.add(pos)
                send_response('batch_item', {
                    'i': it.get('i'),
                    'message': 'cancelled' if cancelled else 'No audio generated',
                })
            send_response('batch_done', {'count': len(items)})

    def _generate_batch_streaming(self, items, language: str):
        """FAST START: render the batch through the engine's generate_batch_stream so
        the rows marked `stream: true` deliver sub-sentence chunks WHILE THEY
        GENERATE.

        Owen's ruling of 2026-09-04: without it the extension waits ~30s before the
        first word, because a sentence only exists once its whole batch retires and
        the client then gates playback on a cushion. With the extension's "Buffer
        before playing" switch OFF, the row being listened to streams instead - 4
        SNAC frames (~0.34s) at a time - and the client starts on about a second of
        audio. Stalls are an accepted cost of that mode; the switch is how you avoid
        them.

        This does NOT change batching or scheduling. Same width, same order, same
        engine, same sampling (the EOS boost/floor apply per request exactly as they
        do on the classic path). The only thing that moves is WHEN audio leaves the
        worker.

        Wire shape, per streamed row i:
            {type:'batch_chunk', i, seq, format:'pcm16', data, duration, sampleRate}
            ... in seq order from 0 ...
            {type:'batch_item',  i, streamed:true, duration, chunks}    # no data
        A failed/cancelled row is the ordinary {type:'batch_item', i, message} and
        the client throws away whatever chunks it already had. Non-streamed rows in
        the same batch keep the exact per-item shape _emit_batch_item has always
        sent, so a mixed batch needs nothing new on the client.

        WHAT IS NOT DONE TO STREAMED AUDIO. finalize_audio trims the leading/trailing
        silence, peak-normalizes and appends the inter-sentence gap - all decisions
        about a whole waveform, and by the time the last chunk exists the first has
        already been PLAYED. So streamed chunks go out raw and unretouched, and the
        only piece of finalize_audio that can still be honoured is the gap: it is
        emitted as one final silent chunk after the row's audio. For the same reason
        a streamed row is never re-rendered: the engine logs the truncation guard's
        verdict and the audio stands.

        The retake ladder and the truncation guard for NON-streamed rows live inside
        generate_batch_stream (that is what "exactly as today" means for them), so
        unlike _generate_batch_mlx_ordered this method does not run _guard_truncation
        itself - running it here would be a second, divergent copy of a ladder the
        engine has already applied.

        THREADING: on MLX the SNAC decode runs on the engine's decoder thread, so
        on_chunk (and possibly on_row) is called from a thread that is not this one.
        Every stdout write goes through send_response's lock, and the bookkeeping
        below is guarded so a row can be answered exactly once no matter which thread
        gets there first.
        """
        orph = self.orph

        state_lock = threading.Lock()
        emitted = set()          # positions in `items` already answered
        chunk_counts = {}        # position -> chunks emitted for that row so far

        def _claim(pos) -> bool:
            """Take the right to answer `pos`. False when someone already has."""
            with state_lock:
                if pos in emitted:
                    return False
                emitted.add(pos)
                return True

        try:
            # Per-item voice check first, exactly as the other batch paths do: a row
            # this engine/backend cannot serve fails ON ITS OWN and its neighbours
            # render normally.
            positions = []          # positions into `items` that will be rendered
            for pos, it in enumerate(items):
                try:
                    voice = self._resolve_row(it)
                except Exception as e:
                    if _claim(pos):
                        send_response('batch_item', {'i': it.get('i'), 'message': str(e)})
                    continue
                cleaned = orph._clean_sentence_for_tts(
                    normalize_for_tts(it.get('text', ''), language))
                if not cleaned:
                    # Genuinely empty text -> tiny silence, the same contract every
                    # other path here keeps. Never streamed: there is nothing to wait
                    # for, so it is answered immediately and dropped from the batch.
                    if _claim(pos):
                        self._emit_batch_item(
                            it, np.zeros(int(active_samplerate() * 0.05), dtype=np.float32))
                    continue
                positions.append((pos, cleaned, voice))

            if not positions:
                return

            texts = [c for _pos, c, _v in positions]
            voices = [v for _pos, _c, v in positions]
            # Row index (into `texts`) -> position into `items`, since the engine's
            # callbacks speak in row indices and the wire speaks in the caller's `i`.
            row_to_pos = [pos for pos, _c, _v in positions]
            stream_rows = {row for row, (pos, _c, _v) in enumerate(positions)
                           if items[pos].get('stream') is True}
            print(f'[narrator.serve] fast-start: streaming {len(stream_rows)} of '
                  f'{len(texts)} rows', file=sys.stderr)

            def on_chunk(row, seq, audio):
                """One sub-sentence payload of a streaming row. Called from the
                engine's decoder thread on MLX - see the THREADING note above."""
                pos = row_to_pos[row]
                if audio is None or len(audio) == 0:
                    return
                a = np.asarray(audio, dtype=np.float32).flatten()
                with state_lock:
                    if pos in emitted:
                        # The row was already answered (a failure, or the cancel
                        # sweep). Chunks after that point belong to nothing and the
                        # client has discarded the row - say so rather than emit an
                        # orphan the pool would have to reject.
                        print(f'[narrator.serve] dropping chunk seq={seq} for row '
                              f'[{items[pos].get("i")}] - already answered',
                              file=sys.stderr)
                        return
                    chunk_counts[pos] = chunk_counts.get(pos, 0) + 1
                send_response('batch_chunk', {
                    'i': items[pos].get('i'),
                    'seq': seq,
                    'format': 'pcm16',
                    'data': audio_to_pcm16_base64(a),
                    'duration': len(a) / active_samplerate(),
                    'sampleRate': active_samplerate(),
                })

            def on_row(row, audio):
                """A row retired. Streamed rows are CLOSED here (their audio already
                went out as chunks); every other row is emitted exactly as the
                classic batch path emits it."""
                pos = row_to_pos[row]
                streamed = row in stream_rows
                if not streamed:
                    if _claim(pos):
                        self._emit_batch_item(
                            items[pos],
                            None if audio is None or len(audio) == 0 else finalize_audio(audio))
                    return
                total = 0.0 if audio is None else len(audio) / active_samplerate()
                with state_lock:
                    sent = chunk_counts.get(pos, 0)
                if sent == 0 or total <= 0:
                    # Nothing was ever streamed: a failed row. Report it as a
                    # failure - never as a silent success the client would play as a
                    # missing sentence.
                    if _claim(pos):
                        send_response('batch_item',
                                      {'i': items[pos].get('i'), 'message': 'No audio generated'})
                    return
                # The inter-sentence gap finalize_audio would have appended, sent as
                # the row's LAST chunk (see the docstring): the only part of
                # finalization that can still be applied to audio already in flight.
                if STREAM_GAP_SEC > 0:
                    gap = np.zeros(int(active_samplerate() * STREAM_GAP_SEC), dtype=np.float32)
                    on_chunk(row, sent, gap)
                    total += STREAM_GAP_SEC
                    with state_lock:
                        sent = chunk_counts.get(pos, 0)
                if _claim(pos):
                    send_response('batch_item', {
                        'i': items[pos].get('i'),
                        'streamed': True,
                        'duration': total,
                        'chunks': sent,
                    })

            try:
                orph.generate_batch_stream(texts, voices, stream_rows,
                                           on_chunk, on_row, self._is_cancelled)
            except Exception as e:
                import traceback
                traceback.print_exc(file=sys.stderr)
                for pos, _c, _v in positions:
                    if _claim(pos):
                        send_response('batch_item',
                                      {'i': items[pos].get('i'),
                                       'message': f'Batch generation failed: {e}'})
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            for pos, it in enumerate(items):
                if _claim(pos):
                    send_response('batch_item',
                                  {'i': it.get('i'), 'message': f'Batch generation failed: {e}'})
        finally:
            # Same one-answer-per-item guarantee the other two batch paths keep: the
            # pool resolves a batch by index, and a row with no message hangs its
            # sentence until the 180s timeout taints the worker.
            cancelled = self._is_cancelled()
            for pos, it in enumerate(items):
                if _claim(pos):
                    send_response('batch_item', {
                        'i': it.get('i'),
                        'message': 'cancelled' if cancelled else 'No audio generated',
                    })
            send_response('batch_done', {'count': len(items)})

    def generate_batch(self, items, language: str = 'en'):
        """Generate a batch of sentences (read-ahead). Emits one 'batch_item' per
        item (keyed by its caller-supplied index `i`) then a 'batch_done'. A failure
        is reported per item so one bad sentence never sinks the batch.

        MLX uses ordered adjacency grouping (_generate_batch_mlx_ordered) so the
        next sentence in reading order streams out first. vLLM/transformers keep the
        single-dispatch path below.

        An item may carry its own `voice`; omitted means the loaded one. On vLLM the
        batch is NOT regrouped by voice - vLLM takes a per-prompt LoRA list, so mixed
        voices ride one call and the read-ahead window keeps its reading order.

        An item may also carry `stream: true` (fast start, Owen 2026-09-04), which
        routes the WHOLE batch through _generate_batch_streaming so those rows emit
        sub-sentence 'batch_chunk's as they generate. The test is deliberately "does
        ANY item ask for it": a batch mixes the block being listened to with
        read-ahead behind it, and only the former streams, so the streaming path has
        to be able to carry both. With no stream flag anywhere - which is what the
        extension's default "Buffer before playing" produces - nothing below this
        line is reached and the batch takes the code that was already here."""
        if self.orph is None:
            for it in items:
                send_response('batch_item', {'i': it.get('i'), 'message': 'Model not loaded'})
            send_response('batch_done', {'count': len(items)})
            return

        if any(it.get('stream') is True for it in items):
            self._generate_batch_streaming(items, language)
            return

        if _uses_orpheus_token_pipeline(self.orph) and self.orph.backend == 'mlx':
            # ORPHEUS's MLX grouping (_generate_mlx_batch_audio). Higgs v3 on MLX
            # also reports backend 'mlx' and has no such method: it renders one
            # chunk at a time through the classic loop below.
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
                            'duration': len(audio) / active_samplerate(),
                            'sampleRate': active_samplerate(),
                        })
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            # Only items that never got a result - an item already reported (its own
            # voice rejection, or a successful render before the failure) must not be
            # emitted twice; the pool resolves by index and a second message for one
            # index would be dropped as stale.
            for it in items:
                if id(it) not in emitted:
                    send_response('batch_item', {'i': it.get('i'), 'message': f'Batch generation failed: {e}'})
        finally:
            # Same one-answer-per-item guarantee as the MLX path. vLLM's
            # engine.generate() is one blocking call with no abort hook, so a cancel
            # cannot shorten a vLLM batch - it can only label the rows that never made
            # it. (Nothing here pretends otherwise: the flag is read, not waited on.)
            cancelled = self._is_cancelled()
            for it in items:
                if id(it) in emitted:
                    continue
                emitted.add(id(it))
                send_response('batch_item', {
                    'i': it.get('i'),
                    'message': 'cancelled' if cancelled else 'No audio generated',
                })
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
            duration = len(audio) / active_samplerate()
            data = audio_to_pcm16_base64(audio)
            if stream:
                # Whole sentence as a single chunk, then the stream terminator -
                # satisfies the scheduler's streaming-first-sentence contract.
                send_response('chunk', {
                    'seq': 0,
                    'format': 'pcm16',
                    'data': data,
                    'duration': duration,
                    'sampleRate': active_samplerate(),
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
                    'sampleRate': active_samplerate(),
                })
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            send_response('error', {'message': f'Generation failed: {e}'})

    def _read_stdin(self, inbox: "queue.Queue"):
        """Read stdin on its OWN thread and hand each request to the main loop.

        The main loop used to BE the stdin loop (`for raw in sys.stdin`), which meant
        a message could only be seen between requests - and a read-ahead batch is
        30-43s long. So a 'cancel' sent the instant the listener switched voice was
        not read until the batch it was meant to abort had already finished, and the
        new voice's load queued behind renders nobody would ever hear. A reader thread
        is the smallest thing that fixes that: it OBSERVES the cancel while the main
        thread is inside the engine, sets the flag the generator polls, and still puts
        the request on the queue so the main loop acknowledges it in arrival order.

        Everything else stays exactly as it was - one request executed at a time, all
        stdout writes from the main thread, so the JSON-lines protocol keeps both of
        its ordering guarantees (a request's messages are contiguous, and 'batch_done'
        is the last of its batch).
        """
        try:
            for raw in sys.stdin:
                line = raw.strip()
                if not line:
                    continue
                try:
                    request = json.loads(line)
                except Exception as e:
                    inbox.put(('bad-json', str(e)))
                    continue
                # THE POINT OF THE THREAD: flip the flag here, not when the main loop
                # gets around to this message. A generate_batch already running sees
                # it at its next decode step.
                if request.get('action') in ('cancel', 'stop'):
                    self._cancel.set()
                inbox.put(('request', request))
        except Exception as e:
            print(f'[narrator.serve] stdin reader failed: {e}', file=sys.stderr, flush=True)
        finally:
            inbox.put(('eof', None))

    def run(self):
        self.device = detect_device()
        # NOT guarded: a failure here means no engine can ever load in this
        # process, and `main()` turns it into a non-zero exit with the reason on
        # stderr. A handshake would be a lie. (See detect_backend.)
        self.backend = detect_backend()
        # `backend` is what the pool gates its per-request-voice guard on, so it is
        # sent even when it could not be determined - as absent, which the pool reads
        # as "unknown" and treats as NOT capable.
        _warn_fake_engine('ready')
        send_response('ready', {'device': self.device,
                                **({'backend': self.backend} if self.backend else {})})

        inbox: "queue.Queue" = queue.Queue()
        reader = threading.Thread(target=self._read_stdin, args=(inbox,),
                                  name='orpheus-stdin', daemon=True)
        reader.start()

        while True:
            kind, payload = inbox.get()
            if kind == 'eof':
                break
            if kind == 'bad-json':
                send_response('error', {'message': f'Invalid JSON: {payload}'})
                continue
            request = payload

            action = request.get('action')
            if action == 'load':
                # 'warm' says whether a FIRST load may spend time on discarded
                # warm-up renders. Read explicitly, and ABSENT MEANS TRUE: the app
                # and this worker ship together, but a message from anything older
                # must mean the behaviour that message was written against.
                warm = request.get('warm')
                warm = True if warm is None else bool(warm)
                if self.load_voice(request.get('voice', DEFAULT_VOICE), request.get('modelDir'),
                                   request.get('caps'), request.get('adapterDir'),
                                   request.get('baseDir'), request.get('id'), warm):
                    # The CONSTRUCTED engine's backend, not the pre-load probe's - same
                    # value in every normal case, but this one is ground truth, so a
                    # probe that failed at startup is corrected here rather than
                    # leaving the pool's guard permanently armed.
                    self.backend = self.orph.backend
                    _warn_fake_engine(f'loaded voice {self.current_voice!r}')
                    # ADDITIVE fields, so the existing pool reader is unaffected
                    # (it takes `voice` and `backend` and ignores the rest):
                    #   engine        which engine actually loaded
                    #   sampleRate    the rate this engine renders at, so a
                    #                 client does not assume 24 kHz forever
                    #   pads          whether chunk audio already contains its
                    #                 own silence (Orpheus true, Higgs false)
                    #   edgeFadeMs    the fade an ASSEMBLER must apply at each
                    #                 chunk edge before joining (Higgs 25, since
                    #                 a decoded edge sits near -30 dB and clicks)
                    send_response('loaded', {
                        'voice': self.current_voice,
                        'backend': self.backend,
                        'engine': getattr(self.orph, 'ENGINE_ID', None),
                        'sampleRate': active_samplerate(),
                        'pads': bool(getattr(self.orph, 'pads', True)),
                        'edgeFadeMs': _edge_fade_of(self.orph).as_manifest(),
                    })
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
                # The reader thread already SET the flag when this line arrived -
                # whatever was in flight has seen it. Reaching it here means that work
                # is over, so this is where the flag is cleared, and the only place:
                # the queue is FIFO and the reader only ever sets it, so a cancel can
                # never outlive the request it arrived during and can never suppress a
                # batch queued after it (that batch is behind this ack in the queue).
                self._cancel.clear()
                send_response('stopped')
            elif action == 'quit':
                break
            else:
                send_response('error', {'message': f'Unknown action: {action}'})


def main(argv=None):
    """`python -m narrator.serve [--fake-engine]`.

    The ONLY production writer of _FAKE_ENGINE. An unrecognised argument is a
    hard error: this worker takes no configuration on the command line (its
    interface is the protocol on stdin/stdout and the ORPHEUS_* spawn env), so
    anything else here is a mistake worth surfacing before a model loads.

    Exit codes: 0 clean, 2 bad arguments, 3 the worker could not come up at all
    (and printed no `ready`).
    """
    global _FAKE_ENGINE
    # THIS WORKER'S STDOUT IS THE PROTOCOL. Engine log lines must never land on
    # it: one bare `print` between two JSON messages breaks the client's parse
    # (measured 2026-09-05 - a Higgs load banner arrived where a `loaded` line
    # was expected). stderr is `narrator.engine.log`'s default, and the pool
    # reads it (orpheus-worker-pool.ts logs `[Orpheus Pool stderr]`); this says
    # so explicitly rather than depending on a default staying put.
    # Imported HERE, not at module scope: `narrator.serve` sends its `ready`
    # line before any heavy import, and engine.log costs only `sys` but the
    # rule is worth keeping unbroken.
    from ..engine.log import set_log_stream
    set_log_stream(sys.stderr)
    argv = sys.argv[1:] if argv is None else list(argv)
    unknown = [a for a in argv if a != '--fake-engine']
    if unknown:
        print(f'[narrator.serve] unknown argument(s): {" ".join(unknown)}. '
              'Usage: python -m narrator.serve [--fake-engine]',
              file=sys.stderr, flush=True)
        return 2
    _FAKE_ENGINE = '--fake-engine' in argv
    if _FAKE_ENGINE:
        print(FAKE_ENGINE_BANNER, file=sys.stderr, flush=True)
    try:
        OrpheusStreamServer().run()
    except Exception as e:
        # A WORKER THAT CANNOT RENDER MUST NOT HANDSHAKE. The two ways to get
        # here are an unservable NARRATOR_ENGINE and a backend detection that
        # raised - both mean no engine will ever load in this process. Exiting
        # non-zero with the reason on stderr is what the pool can act on; a
        # `ready` line followed by "Model not loaded" on every generate is a
        # worker that looks alive forever (found on the Mac, 2026-09-04).
        print(f'[narrator.serve] FATAL: {type(e).__name__}: {e}',
              file=sys.stderr, flush=True)
        print('[narrator.serve] no engine can load in this process; exiting '
              'without a handshake.', file=sys.stderr, flush=True)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
