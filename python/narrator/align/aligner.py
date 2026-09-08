"""Force-align ONE rendered chunk's audio against the text it was asked to say.

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 3: the model
exposes no text-to-time mapping, so the sentence-level cues and the coverage
guard both come from a CTC forced alignment of each chunk after it is rendered.
This module is the alignment itself; `sentences.py` turns it into cues and
`coverage.py` turns it into the guard.

TWO ALIGNERS SHIP, AND NEITHER IS EVER A RUNTIME GUESS. `BACKENDS` names them,
`backend` records which one produced a measurement, and a caller chooses by
name - which is exactly the door this docstring said a future aligner had to
arrive through.

  WHISPERX (the default, Owen's ruling 2026-09-05). Chosen over torchaudio's
  `forced_align` on ten kershaw chunks; the numbers, the per-pair table and the
  reasoning are in `README.md`, which is where the loser lives. In one line:
  both agree on word times to the CTC frame (median delta 0.000 s, p95 0.020 s
  over 529 words) and cost the same wall clock, but only WhisperX LOCALIZES the
  text inside longer audio - given a chunk's text against that chunk plus the
  next one, WhisperX ended the last word 0.42-0.94 s before the true text end
  while torchaudio smeared it to within 1.0-3.3 s of the AUDIO end in 6 pairs
  out of 6, which makes point 4's "audio with no text" undetectable. torchaudio's
  `forced_align` is also deprecated in 2.8 and removed in 2.9.

  QWEN3 (Qwen3-ForcedAligner-0.6B, added 2026-09-08). THE BAKE-OFF THAT BOUGHT
  IT, on Shift (Higgs mistborn render, 16.56 h, RTX 3090 Ti in WSL), scored
  against the exact chunk starts of 1,083 chunks in the assembled m4b, both arms
  on identical 5-minute windows with identical text:

    qwen3   395x realtime - 151 s of alignment for the whole book. 890/1083
            chunk starts within 0.1 s and 947 within 0.5 s after subtracting the
            chunk's own ~0.27 s head silence. 116 misses over 1 s decompose as
            59 headings and tiny chunks whose PRINTED text differs from the
            spoken words ("2110.", "* Silo one *."), 22 prose chunks directly
            after such a heading, 3 beside a truncated chunk, ~32 unexplained
            (3 %).
    whisperx  18x realtime on the same GPU (first hour). 39/61 within 0.1 s; 17
            boundaries over 0.5 s, parked ~0.9 s EARLY into the inter-chunk gap.

  The paper (arXiv 2601.21337) measures the same shape: accumulated average
  shift 42.9 ms against WhisperX 133 ms and NeMo 130 ms, and over 300 s
  concatenations WhisperX drifts to 2.7 s where Qwen holds 53 ms.

  Owen's ruling: "lets build that in instead then ... run it as a gpu job after
  tts finishes ... as long as its faster than assembly, we can do the proper
  job."

  WHAT QWEN3 CANNOT DO is judge itself: the model returns word times and NO
  confidence. Its scores are DERIVED here (`_derive_scores`) and the Alignment
  says so in `score_source`, so no reader mistakes a derived number for the
  model's own. A window whose text does not match the speech is PLACED, not
  refused - that is what the 116 Shift misses are.

There is still NO SWITCH and no retry: a backend that fails on a chunk raises
`AlignerError` naming the chunk, and the caller decides. `DEFAULT_BACKEND` stays
whisperx, because an unchanged default is the contract and moving the app onto
qwen3 is a separate decision.

CPU ONLY BY DEFAULT, and a GPU request is refused by name while BookForge's
`external-gpu-job.lock` exists - a render or a training run owns the card and an
aligner is not entitled to take it. That rule did NOT relax for qwen3, which is
a GPU job by design ("run it as a gpu job AFTER tts finishes"): it waits for the
card like everything else. On CPU, whisperx is seconds per chunk (measured
0.26-2.8 s for 5-30 s chunks) and there is nothing to gain by taking the card
for it.

WHAT AN ALIGNMENT SAYS, AND WHAT IT DOES NOT. CTC forced alignment is MONOTONIC
and TOTAL: every word of the text is assigned a span, whether or not it was
spoken. So "this word has no timestamp" is NOT the dropped-text signal - the
SCORE is. Measured on kershaw chunk 20: with the true text, 2 % of words score
under 0.4; with one extra sentence appended that the audio never says, 91 % of
that sentence's words do; with the audio truncated to 60 %, 94 % of the
stranded tail does. `coverage.py` owns the thresholds; this module reports the
scores and the spans and judges nothing.

AND THE SCORE IS NOT ALWAYS THE MODEL'S. Every `Alignment` carries
`score_source`: 'model' for whisperx's own CTC posterior, 'derived' for qwen3's
three-factor estimate. The two are NOT on the same scale and the thresholds in
`assemble/engine_profiles.py` were calibrated on the first, so a reader of a
coverage report has to know which it is holding - which is why the field is
required rather than defaulted, on the wire and in the report.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

# The alignment sample rate. wav2vec2 is a 16 kHz model; every backend here
# feeds it 16 kHz mono float32, whatever the chunk's own rate is.
SAMPLE_RATE = 16000

#: THE aligners, named - see the module docstring for what each is and what the
#: bake-off measured. A backend is CHOSEN BY NAME (`--backend`, the job's
#: `backend` field); nothing here inspects the machine and picks one.
BACKENDS = ('whisperx', 'qwen3')
#: Unchanged on purpose (2026-09-08). qwen3 is 22x faster and lands 82 % of
#: Shift's chunk starts inside 0.1 s, but its scores are DERIVED and the
#: coverage thresholds were calibrated on whisperx's model scores. Moving the
#: app's default is a separate decision with its own calibration behind it.
DEFAULT_BACKEND = 'whisperx'

#: What a backend's `score` field MEANS, per backend. 'model' is the aligner's
#: own confidence; 'derived' is this module's three-factor estimate standing in
#: for a model that publishes none (`_derive_scores`). One table, because the
#: Alignment, the coverage document and the VTT's quality note all quote it and
#: a second copy could disagree.
SCORE_SOURCE_BY_BACKEND = {'whisperx': 'model', 'qwen3': 'derived'}
SCORE_SOURCES = ('model', 'derived')

#: Silence-map parameters. `align_audiobook.py` scans a whole audiobook with
#: ffmpeg `silencedetect` at -45 dB / 0.25 s; the -45 dB threshold is the same
#: measurement of "a pause in mastered narration" and is kept. The MINIMUM
#: LENGTH is shorter here on purpose: that script snaps seams in a six-hour
#: file where a 0.25 s floor keeps intra-word gaps out of the map, while a cue
#: seam INSIDE one 20 s chunk routinely sits in a 0.15-0.20 s pause, and a map
#: that cannot see it cannot snap to it.
SILENCE_NOISE_DB = -45.0
SILENCE_MIN_S = 0.15
#: RMS window and hop for the silence scan, in seconds. 20 ms / 10 ms is the
#: standard speech frame; it resolves a 0.15 s pause to within one hop.
SILENCE_WINDOW_S = 0.020
SILENCE_HOP_S = 0.010

#: The shortest run of unexplained audio this module will report as its own
#: span. Geometry, not an engine threshold: below about a quarter second a gap
#: is a breath or a plosive, not an insertion. `coverage.py` applies the
#: ENGINE's threshold on top of these.
MIN_AUDIO_SPAN_S = 0.25

#: BookForge's cross-process "a GPU job owns the card" flag. Named here rather
#: than assumed: an operator can point at another one, and a platform without it
#: simply has no lock.
GPU_LOCK_ENV = 'NARRATOR_GPU_LOCK'


class AlignerError(RuntimeError):
    """An alignment could not be produced. Always names the file or the reason."""


# ---------------------------------------------------------------------------
# The data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AlignedWord:
    """One word of the chunk's text and where the aligner put it.

    `index` is the word's position in the chunk's own whitespace-split word
    list, which is what `sentences.py` maps sentence spans onto. `start_s` /
    `end_s` are seconds from the START OF THE CHUNK'S AUDIO, not from the start
    of the book.

    `score` is the aligner's confidence, 0..1. It is the number that says
    whether the audio actually contains this word - see the module docstring.
    `None` for a word the backend could not place at all (a whole-segment
    alignment failure), which is a stronger signal than a low score.
    """

    index: int
    word: str
    start_s: Optional[float]
    end_s: Optional[float]
    score: Optional[float]

    @property
    def timed(self) -> bool:
        return self.start_s is not None and self.end_s is not None

    @property
    def duration_s(self) -> float:
        if not self.timed:
            return 0.0
        return max(0.0, self.end_s - self.start_s)


@dataclass(frozen=True)
class TextSpan:
    """A run of the chunk's words the audio does not credibly contain.

    `audio_start_s` / `audio_end_s` are where the aligner PUT the run, which is
    where the missing speech would have been - useful for listening to the spot,
    meaningless as a duration.
    """

    first_word: int
    last_word: int
    text: str
    audio_start_s: Optional[float]
    audio_end_s: Optional[float]
    worst_score: Optional[float]

    @property
    def words(self) -> int:
        return self.last_word - self.first_word + 1


@dataclass(frozen=True)
class AudioSpan:
    """A stretch of the chunk's audio no word of the text is aligned to.

    `speech_fraction` is 1.0 minus the fraction of the span the silence map
    calls quiet - the same measurement `align_audiobook.speech_coverage` makes,
    and the reason a chapter gap or a long pause is not reported as an
    insertion.
    """

    start_s: float
    end_s: float
    speech_fraction: float
    where: str  # 'head' | 'interior' | 'tail'

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


@dataclass(frozen=True)
class Alignment:
    """The whole answer for one chunk.

    `score_source` is REQUIRED and has no default. It says what every word's
    `score` is: 'model' (whisperx's CTC posterior) or 'derived' (this module's
    estimate for a backend that publishes no confidence - see `_derive_scores`).
    A default would let a derived score reach `coverage.py`, whose thresholds
    were calibrated on model scores, wearing the model's clothes.

    `pace_chars_per_sec` / `pace_source` are the pace the RATE factor of a
    derived score was measured against, and where that number came from:
    'given' (the caller named a voice's measured pace) or 'chunk' (this chunk's
    own printed chars over its own audio seconds). Both are None for a 'model'
    score source, because nothing there uses a pace.
    """

    audio_path: str
    text: str
    language: str
    backend: str
    device: str
    duration_s: float
    words: Tuple[AlignedWord, ...]
    score_source: str
    unaligned_text_spans: Tuple[TextSpan, ...] = ()
    unaligned_audio_spans: Tuple[AudioSpan, ...] = ()
    silences: Tuple[Tuple[float, float], ...] = ()
    elapsed_s: float = 0.0
    pace_chars_per_sec: Optional[float] = None
    pace_source: Optional[str] = None

    @property
    def timed_words(self) -> Tuple[AlignedWord, ...]:
        return tuple(w for w in self.words if w.timed)

    def as_dict(self) -> dict:
        """A JSON-safe document. The worker protocol and the reports use it."""
        return {
            'audioPath': self.audio_path,
            'text': self.text,
            'language': self.language,
            'backend': self.backend,
            'device': self.device,
            'durationSeconds': self.duration_s,
            'elapsedSeconds': self.elapsed_s,
            'scoreSource': self.score_source,
            'paceCharsPerSecond': self.pace_chars_per_sec,
            'paceSource': self.pace_source,
            'words': [
                {'index': w.index, 'word': w.word, 'start': w.start_s,
                 'end': w.end_s, 'score': w.score}
                for w in self.words
            ],
            'silences': [[a, b] for a, b in self.silences],
        }


def _required(data: dict, key: str) -> object:
    """One key of a wire document, or a refusal NAMING it.

    Not `data.get(key)`: a missing `scoreSource` would then read as "the model
    scored this", which is the one thing the field exists to prevent. The three
    keys this guards are all emitted unconditionally by `as_dict`, so an absent
    one is a producer from before 2026-09-08 (or a hand-written document) and it
    says so instead of being papered over.
    """
    if key not in data:
        raise AlignerError(
            f'this alignment document is missing {key!r}; it was written by an '
            f'aligner from before the qwen3 backend landed (2026-09-08), when '
            f'every score was whisperx\'s own. Re-run the alignment rather than '
            f'guessing what its scores meant.')
    return data[key]


def alignment_from_dict(data: dict) -> Alignment:
    """The inverse of `Alignment.as_dict`, for the cross-interpreter worker.

    The spans are NOT carried on the wire: they are derived from the words and
    the silence map by `_spans`, so a round trip recomputes them rather than
    trusting a copy that could disagree with the words beside it.
    """
    words = tuple(
        AlignedWord(index=int(w['index']), word=w['word'],
                    start_s=w['start'], end_s=w['end'], score=w['score'])
        for w in data['words']
    )
    silences = tuple((float(a), float(b)) for a, b in data['silences'])
    duration = float(data['durationSeconds'])
    text_spans, audio_spans = _spans(words, silences, duration)
    score_source = _required(data, 'scoreSource')
    if score_source not in SCORE_SOURCES:
        raise AlignerError(
            f'this alignment document says scoreSource={score_source!r}; known: '
            f'{", ".join(SCORE_SOURCES)}')
    pace = _required(data, 'paceCharsPerSecond')
    return Alignment(
        audio_path=data['audioPath'],
        text=data['text'],
        language=data['language'],
        backend=data['backend'],
        device=data['device'],
        duration_s=duration,
        words=words,
        score_source=score_source,
        unaligned_text_spans=text_spans,
        unaligned_audio_spans=audio_spans,
        silences=silences,
        elapsed_s=float(data['elapsedSeconds']),
        pace_chars_per_sec=None if pace is None else float(pace),
        pace_source=_required(data, 'paceSource'),
    )


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


def resolve_ffmpeg(explicit: Optional[str] = None) -> str:
    """The ffmpeg binary to decode with. Explicit argument, then PATH, then a
    refusal naming what was looked for - never a hardcoded path."""
    if explicit:
        if not os.path.isfile(explicit):
            raise AlignerError(f'ffmpeg not found at {explicit}')
        return explicit
    found = shutil.which('ffmpeg')
    if not found:
        raise AlignerError(
            'ffmpeg is not on PATH and none was passed; the aligner decodes '
            'every chunk through it')
    return found


def decode_audio(path: str, ffmpeg: Optional[str] = None):
    """One audio file -> a 1-D float32 numpy array at `SAMPLE_RATE`, mono.

    Straight to memory: a chunk is seconds long, so the temp-file dance
    `align_audiobook.py` needs for a six-hour m4b buys nothing here.
    """
    import numpy as np

    if not os.path.isfile(path):
        raise AlignerError(f'no audio to align at {path}')
    binary = resolve_ffmpeg(ffmpeg)
    proc = subprocess.run(
        [binary, '-v', 'error', '-i', path, '-ac', '1',
         '-ar', str(SAMPLE_RATE), '-f', 'f32le', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise AlignerError(
            f'ffmpeg could not decode {path}: '
            f'{proc.stderr.decode("utf-8", "replace").strip()[-400:]}')
    audio = np.frombuffer(proc.stdout, dtype='<f4').copy()
    if audio.size == 0:
        raise AlignerError(f'{path} decoded to zero samples')
    return audio


def detect_silences(audio, noise_db: float = SILENCE_NOISE_DB,
                    min_s: float = SILENCE_MIN_S) -> Tuple[Tuple[float, float], ...]:
    """The chunk's pauses, as `[(start_s, end_s)]` in the chunk's own timeline.

    Same measurement `align_audiobook.detect_silences` gets out of ffmpeg
    `silencedetect` - windows whose RMS sits below `noise_db` dBFS, merged into
    runs of at least `min_s` - computed directly on the array because the array
    is already here. Two uses: a sentence seam is snapped onto the middle of the
    pause between the words (point 3's edge rule), and a stretch of audio that
    no word covers is only an INSERTION if somebody was speaking in it.
    """
    import numpy as np

    hop = max(1, int(round(SILENCE_HOP_S * SAMPLE_RATE)))
    win = max(hop, int(round(SILENCE_WINDOW_S * SAMPLE_RATE)))
    if audio.size < win:
        return ()
    n_frames = 1 + (audio.size - win) // hop
    # A strided view is the whole scan: no copy, one vectorized RMS.
    frames = np.lib.stride_tricks.as_strided(
        audio, shape=(n_frames, win),
        strides=(audio.strides[0] * hop, audio.strides[0]))
    rms = np.sqrt(np.maximum(np.mean(frames.astype(np.float64) ** 2, axis=1),
                             1e-20))
    quiet = 20.0 * np.log10(rms) < noise_db

    out = []
    start = None
    for i, is_quiet in enumerate(quiet):
        if is_quiet and start is None:
            start = i
        elif not is_quiet and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(quiet)))

    spans = []
    for a, b in out:
        t0 = a * hop / SAMPLE_RATE
        t1 = min((b * hop + win) / SAMPLE_RATE, audio.size / SAMPLE_RATE)
        if t1 - t0 >= min_s:
            spans.append((t0, t1))
    return tuple(spans)


def speech_fraction(start: float, end: float,
                    silences: Sequence[Tuple[float, float]]) -> float:
    """How much of `[start, end)` is NOT in the silence map, 0..1."""
    span = end - start
    if span <= 0:
        return 0.0
    quiet = 0.0
    for a, b in silences:
        quiet += max(0.0, min(b, end) - max(a, start))
    return max(0.0, 1.0 - quiet / span)


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------


def gpu_lock_path() -> Optional[str]:
    """Where BookForge's "a GPU job owns the card" flag lives, or None.

    `%APPDATA%\\BookForge\\external-gpu-job.lock` on Windows; overridable with
    `NARRATOR_GPU_LOCK` so a test can point at a file it made. On a platform
    with no such flag there is nothing to check and this returns None.
    """
    override = (os.environ.get(GPU_LOCK_ENV) or '').strip()
    if override:
        return override
    appdata = os.environ.get('APPDATA')
    if appdata:
        return os.path.join(appdata, 'BookForge', 'external-gpu-job.lock')
    return None


#: Every device name that means "the machine's graphics processor". `mps` is on
#: this list because on a Mac it is THE SAME PIECE OF SILICON the render uses -
#: unified memory, one Metal queue - so a lock that means "a BookForge GPU job
#: owns the card" means exactly as much there as it does over CUDA. It was
#: missing until 2026-09-07, when the app started offering the GPU as a choice
#: for the alignment and `mps` became a device this function actually sees.
GPU_DEVICES = ('cuda', 'mps')


def check_device(device: str) -> str:
    """Refuse a GPU alignment while another job owns the card.

    The aligner runs perfectly well on CPU - seconds per chunk - and taking the
    card from a render or a training run is not a trade narrator makes on its
    own. Named refusal, never a silent downgrade to CPU: a caller that asked for
    the GPU gets told why it cannot have it.

    The device NAME is the caller's (BookForge resolves its user-facing "on GPU"
    to `mps` or `cuda` per machine); what this owns is whether the card is free.
    """
    if device not in GPU_DEVICES:
        return device
    lock = gpu_lock_path()
    if lock and os.path.exists(lock):
        raise AlignerError(
            f'refusing to align on {device.upper()}: {lock} exists, so another '
            f'BookForge GPU job owns the card. Align on CPU (device=cpu) - a '
            f'chunk takes seconds there - or wait for that job to finish.')
    return device


# ---------------------------------------------------------------------------
# The word list
# ---------------------------------------------------------------------------


def chunk_words(text: str) -> Tuple[str, ...]:
    """The chunk's words, as the aligner will count them.

    A single whitespace split of the ALREADY-SPOKEN text (markers stripped,
    whitespace collapsed by the caller). WhisperX splits its own transcript on
    `" "` (alignment.py:163), so this and the backend cannot disagree about how
    many words there are - and `align_chunk` refuses the alignment if they ever
    do rather than lining up 53 times against 52.
    """
    return tuple(w for w in text.split(' ') if w)


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------

# One model per (backend, language, device) per process. Loading WhisperX's
# align model costs ~5.6 s warm and ~20 s cold; a book is hundreds of chunks.
_MODEL_CACHE: dict = {}


def _load_whisperx(language: str, device: str):
    try:
        import whisperx
    except ImportError as missing:
        raise AlignerError(
            "backend 'whisperx' needs the whisperx package, which is not "
            f'importable here ({missing}). Run the aligner under BookForge\'s '
            'whisperx-env interpreter, or pass --python pointing at it.'
        ) from missing

    key = ('whisperx', language, device)
    if key not in _MODEL_CACHE:
        _MODEL_CACHE[key] = whisperx.load_align_model(
            language_code=language, device=device)
    return _MODEL_CACHE[key]


def _whisperx_words(audio, text: str, language: str, device: str):
    """WhisperX align mode. THE DEFAULT BACKEND - model scores, CPU-friendly."""
    # The loader FIRST: it is the one that turns a missing whisperx into a
    # refusal naming the interpreter to use, rather than a bare ImportError
    # wrapped as "the backend failed to align 53 words".
    model, meta = _load_whisperx(language, device)

    import whisperx

    duration = audio.size / SAMPLE_RATE
    segments = [{'text': text, 'start': 0.0, 'end': duration}]
    result = whisperx.align(segments, model, meta, audio, device,
                            return_char_alignments=False)
    out = []
    for segment in result['segments']:
        for word in segment.get('words', []):
            out.append((word['word'], word.get('start'), word.get('end'),
                        word.get('score')))
    return out


#: The checkpoint. Pinned by name because the 0.6B is the model the bake-off
#: measured; a larger sibling would be a new measurement, not a free upgrade.
QWEN3_MODEL_ID = 'Qwen/Qwen3-ForcedAligner-0.6B'

#: The model card's own limit: it "supports timestamp prediction ... within up
#: to 5 minutes". Longer audio is REFUSED BY NAME rather than truncated or
#: chunked here - narrator chunks are <= ~90 s and the corpus cutter windows to
#: 5 minutes itself, so anything past this is a caller's bug, not a case to
#: handle silently.
QWEN3_MAX_AUDIO_S = 300.0

#: THE WHOLE SUPPORTED LANGUAGE LIST, ISO code -> the English NAME the model's
#: `align(language=...)` takes. Anything else is refused by name: the model does
#: not fall back to English for a language it was not trained on, it just places
#: words badly, and a silently mis-aligned book is worse than a refused one.
QWEN3_LANGUAGES = {
    'en': 'English', 'de': 'German', 'fr': 'French', 'es': 'Spanish',
    'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese',
    'ko': 'Korean', 'zh': 'Chinese', 'yue': 'Cantonese',
}


def qwen3_language_name(language: str) -> str:
    """One ISO code -> the model's English language NAME, or a refusal."""
    name = QWEN3_LANGUAGES.get(language)
    if name is None:
        raise AlignerError(
            f"backend 'qwen3' does not support language {language!r}; "
            f"Qwen3-ForcedAligner-0.6B takes one of "
            f"{', '.join(sorted(QWEN3_LANGUAGES))}. Align this book with "
            f"--backend whisperx instead.")
    return name


def _load_qwen3(language: str, device: str):
    """Load Qwen3-ForcedAligner-0.6B onto `device`, once per (language, device).

    The LANGUAGE is validated here even though the checkpoint is multilingual
    and one copy serves every language: `load_backend` runs before the first
    chunk is timed, so an unsupported code costs a refusal instead of a model
    load plus a book's worth of badly placed words.

    dtype: bfloat16 on cuda/mps (what the model card runs and what the bake-off
    measured), float32 on cpu, where bfloat16 matmuls are emulated and slower
    than the type they save memory over.
    """
    qwen3_language_name(language)
    try:
        import torch
        from qwen_asr import Qwen3ForcedAligner
    except ImportError as missing:
        raise AlignerError(
            "backend 'qwen3' needs the qwen-asr package and torch, which are "
            f'not importable here ({missing}). `pip install qwen-asr` into a '
            'CUDA torch env and pass --python pointing at it; on this PC the '
            'WSL env `qwen-align` has it.'
        ) from missing

    key = ('qwen3', language, device)
    if key not in _MODEL_CACHE:
        dtype = torch.float32 if device == 'cpu' else torch.bfloat16
        _MODEL_CACHE[key] = Qwen3ForcedAligner.from_pretrained(
            QWEN3_MODEL_ID, dtype=dtype, device_map=device)
    return _MODEL_CACHE[key]


def _normalized(text: str) -> str:
    """The comparison form: casefolded, with everything that is not a letter or
    a digit removed.

    WHY A NORMALIZED FORM AT ALL. Qwen tokenizes the text itself and hands back
    ITS units, which merge or split against a whitespace split - measured
    2026-09-08 in the `qwen-align` WSL env, 665 items for a 668-word English
    window. So our words and its items are lined up on the one thing both agree
    about: the letters, in order.

    `str.isalnum()` RATHER THAN A LITERAL [a-z0-9]. For English the two are the
    same set. For German, Japanese or Cantonese - all on `QWEN3_LANGUAGES` - a
    literal [a-z0-9] normalizes the whole window to the empty string, both
    sequences compare equal, and every word maps onto item 0. The Unicode class
    is the same rule stated so it survives the languages this backend claims.
    """
    return ''.join(c for c in text.casefold() if c.isalnum())


def _offsets(pieces) -> list:
    """`[(start, end)]` in normalized-character space, one per piece."""
    out = []
    cursor = 0
    for piece in pieces:
        size = len(_normalized(piece))
        out.append((cursor, cursor + size))
        cursor += size
    return out


def _map_items_onto_words(items, expected):
    """Qwen's own items -> ONE `(word, start, end, score=None)` per OUR word.

    Both sequences are walked in normalized-character space (`_normalized`) and
    a word takes the times of every item it OVERLAPS there: the first
    overlapping item's start and the last overlapping item's end. A word no item
    overlaps is UNTIMED (None/None), and an item no word overlaps is ignored.

    OVERLAP, NOT "THE FIRST ITEM AT OR PAST THIS WORD'S OFFSET" - the two agree
    on a split (our `Christianity.).` arriving as two items) and disagree on a
    MERGE. When one item covers two of our words, the second word has no item
    starting at or past its offset and would come back untimed, which then makes
    `sentences.sentence_cues` refuse the whole chunk for a merge the model is
    entitled to make. Under overlap both words carry the merged item's span,
    which is the honest answer: that is all the model said about either.

    Scores are None here. Qwen publishes no confidence, and inventing one at
    this layer would hide that; `align_chunk` derives them from the audio it
    already has (`_derive_scores`) and stamps `score_source='derived'`.
    """
    if not items:
        raise AlignerError(
            f"backend 'qwen3' returned no items for {len(expected)} word(s). "
            'The model was given audio it could not place this text in at all.')
    texts = [item.text for item in items]
    ours, theirs = ''.join(_normalized(w) for w in expected), \
        ''.join(_normalized(t) for t in texts)
    if ours != theirs:
        # THE MODEL REWROTE THE TEXT. A forced aligner must return the text it
        # was given, retokenized; a different letter sequence means the items
        # cannot be mapped onto our words at all, and mapping them anyway would
        # slide every cue after the difference.
        raise AlignerError(
            "backend 'qwen3' returned text that is not the text it was given: "
            f'{len(theirs)} normalized character(s) against our {len(ours)}. '
            f'Ours starts {ours[:60]!r}, its {theirs[:60]!r}.')

    word_spans = _offsets(expected)
    item_spans = _offsets(texts)
    out = []
    cursor = 0  # items are in order, so the scan never restarts
    for (word_lo, word_hi), mine in zip(word_spans, expected):
        while cursor < len(item_spans) and item_spans[cursor][1] <= word_lo:
            cursor += 1
        first = None
        last = None
        probe = cursor
        while probe < len(item_spans) and item_spans[probe][0] < word_hi:
            if item_spans[probe][1] > word_lo:
                first = probe if first is None else first
                last = probe
            probe += 1
        if first is None:
            # A word whose normalized form is EMPTY (a bare "-" or "...") spans
            # zero characters and can overlap nothing. It is untimed, which is
            # exactly what it is: nothing in the audio corresponds to it.
            out.append((mine, None, None, None))
            continue
        out.append((mine, items[first].start_time, items[last].end_time, None))
    return out


def _qwen3_words(audio, text: str, language: str, device: str):
    """Qwen3-ForcedAligner. The GPU backend - see the module docstring's numbers.

    The model takes a PATH (or a URL), not an array, so the decoded audio is
    written to a temporary 16 kHz mono PCM_16 wav for the call and deleted
    after. That is a documented property of the API as verified in the
    `qwen-align` env on 2026-09-08, not an assumption: if `align` is ever
    documented to accept arrays, this stays until somebody measures that it
    does.
    """
    model = _load_qwen3(language, device)
    name = qwen3_language_name(language)

    duration = audio.size / SAMPLE_RATE
    if duration > QWEN3_MAX_AUDIO_S:
        raise AlignerError(
            f"backend 'qwen3' was given {duration:.1f}s of audio; "
            f'Qwen3-ForcedAligner places timestamps within '
            f'{QWEN3_MAX_AUDIO_S:.0f}s and says nothing about longer input. '
            f'Cut the window before aligning it.')

    try:
        import soundfile
    except ImportError as missing:
        raise AlignerError(
            "backend 'qwen3' needs soundfile to hand the model a wav "
            f'({missing}); `pip install soundfile` into the same env as '
            'qwen-asr.') from missing

    handle, wav_path = tempfile.mkstemp(prefix='narrator-qwen3-', suffix='.wav')
    os.close(handle)
    try:
        soundfile.write(wav_path, audio, SAMPLE_RATE, subtype='PCM_16')
        results = model.align(audio=wav_path, text=text, language=name)
    finally:
        # The temp wav is this function's alone and a book is hundreds of them;
        # leaving them behind fills %TEMP% with a book's worth of audio.
        try:
            os.unlink(wav_path)
        except OSError:
            pass

    # ONE LIST PER AUDIO, and one audio was passed.
    return _map_items_onto_words(results[0], chunk_words(text))


_BACKEND_FUNCTIONS = {
    'whisperx': _whisperx_words,
    'qwen3': _qwen3_words,
}

_BACKEND_LOADERS = {
    'whisperx': _load_whisperx,
    'qwen3': _load_qwen3,
}


def load_backend(backend: str, language: str = 'en', device: str = 'cpu') -> float:
    """Load a backend's model into this process and return the seconds it took.

    Called BEFORE a run so `Alignment.elapsed_s` measures alignment and not a
    one-off model load. Measured on this machine: 5.6 s warm, 19.5 s cold -
    charged to the first chunk otherwise, which made a 0.3 s chunk look like a
    34 s one in the first report this wrote.
    """
    if backend not in BACKENDS:
        raise AlignerError(
            f'unknown alignment backend {backend!r}; known: {", ".join(BACKENDS)}')
    check_device(device)
    started = time.time()
    _BACKEND_LOADERS[backend](language, device)
    return time.time() - started


# ---------------------------------------------------------------------------
# Spans
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Derived scores - for a backend that publishes no confidence
# ---------------------------------------------------------------------------

#: How far a word may start BEFORE the previous timed word ended and still count
#: as in order. A forced aligner's adjacent word boundaries touch; 50 ms is one
#: CTC frame's worth of slop, not a reordering.
DERIVED_ORDER_SLACK_S = 0.05
#: The RATE band. A word between pace/3 and pace*3 scores 1.0 on rate; the
#: factor falls linearly to 0 at pace/6 and pace*6.
DERIVED_RATE_INNER = 3.0
DERIVED_RATE_OUTER = 6.0


def _rate_plausibility(chars: int, duration: float, pace: float) -> float:
    """Is this many characters in this many seconds a PLACEMENT or an artefact?

    A 0.02 s span carrying a 9-character word is not a word the model found; it
    is a word the model had nowhere to put. The instrument is the same chars/sec
    the packer and Orpheus's duration guard use, measured against a pace.
    """
    if duration <= 0 or chars <= 0:
        return 0.0
    cps = chars / duration
    low, high = pace / DERIVED_RATE_INNER, pace * DERIVED_RATE_INNER
    if low <= cps <= high:
        return 1.0
    if cps < low:
        floor = pace / DERIVED_RATE_OUTER
        return max(0.0, (cps - floor) / (low - floor))
    ceiling = pace * DERIVED_RATE_OUTER
    return max(0.0, (ceiling - cps) / (ceiling - high))


def _derive_scores(words: Sequence[AlignedWord],
                   silences: Sequence[Tuple[float, float]],
                   pace: float) -> Tuple[AlignedWord, ...]:
    """Score every word of a 'derived' alignment, 0..1, as a×b×c.

    Qwen3-ForcedAligner returns word times and NO per-word confidence, and
    `_spans` / `coverage.py` need a number that says "this word is not credibly
    in the audio". The two dishonest answers are `None` on every word (which
    reads as UNPLACED everywhere, and would make every qwen3 chunk one enormous
    dropped-text span) and a flat 1.0 (which reads as "the model is certain",
    which it never said). So three things this module can actually measure:

      a  SPEECH PRESENCE - the fraction of the word's span the silence map does
         NOT call quiet (`speech_fraction`, the same instrument the audio spans
         use). A word placed entirely inside a pause scores 0.
      b  RATE PLAUSIBILITY - `_rate_plausibility` above.
      c  ORDER - 1.0 when the word starts at or after the previous TIMED word's
         end less `DERIVED_ORDER_SLACK_S`, else 0. A forced alignment is
         monotonic; a word that goes backwards is not a placement.

    THESE NUMBERS ARE FIRST ESTIMATES, NOT MEASUREMENTS. The 3x/6x band, the
    50 ms slack and the plain product are chosen to be defensible, not because
    anything was measured at them: the calibration data is the Shift coverage
    run (1,083 chunks with known-good chunk starts), and until that has been
    scored against these scores nobody should read a derived 0.62 as meaning
    what a whisperx 0.62 means. `assemble/engine_profiles.py`'s
    `min_word_score` 0.4 was calibrated on whisperx's CTC posterior and is NOT
    yet calibrated on this.

    An UNTIMED word keeps score None - the stronger signal, and the same one
    whisperx gives - because there is nothing of it to measure.
    """
    if pace <= 0:
        raise AlignerError(
            f'a derived score needs a pace in characters per second and was '
            f'given {pace!r}; pass pace_chars_per_sec, or align a chunk whose '
            f'text and audio are both non-empty')
    out = []
    previous_end: Optional[float] = None
    for word in words:
        if not word.timed:
            out.append(word)
            continue
        presence = speech_fraction(word.start_s, word.end_s, silences)
        rate = _rate_plausibility(len(_normalized(word.word)),
                                  word.duration_s, pace)
        in_order = 1.0 if (previous_end is None
                           or word.start_s >= previous_end - DERIVED_ORDER_SLACK_S) \
            else 0.0
        previous_end = word.end_s
        out.append(AlignedWord(index=word.index, word=word.word,
                               start_s=word.start_s, end_s=word.end_s,
                               score=presence * rate * in_order))
    return tuple(out)


#: A word scoring at or above this is treated as PLACED for the purpose of
#: drawing spans. It is NOT the coverage threshold - `coverage.py` owns that -
#: it only decides which words' spans count as "audio the text explains".
#: Measured on kershaw: 2 % of words in a correct chunk fall below 0.4.
SPAN_SCORE_FLOOR = 0.4


def _spans(words: Sequence[AlignedWord],
           silences: Sequence[Tuple[float, float]],
           duration: float) -> tuple:
    """Words + the silence map -> the two span lists.

    TEXT SPANS are maximal runs of words the audio does not credibly contain:
    no time at all, or a score under `SPAN_SCORE_FLOOR`. Every run is reported,
    however short - it is `coverage.py` that decides how long a run has to be
    before a chunk FAILS, because that is an engine policy and this is a
    measurement.

    AUDIO SPANS are the stretches of `[0, duration]` that NO PLACED WORD
    covers, at least `MIN_AUDIO_SPAN_S` long, with the fraction of each that
    somebody was actually speaking in.

    "Placed" here means TIMED, not credible, and that is deliberate: a weak
    word still claims the audio the aligner put it on. Counting a weak word's
    seconds as "audio with no text" would report ONE defect twice - once as
    dropped text and once as an insertion - and a run of two weak words in a
    40-word chunk would fail a chunk that has no insertion in it at all
    (measured while writing the tests).

    THE ONE CASE THAT DOES APPEAR TWICE is an UNTIMED word (review finding 11).
    It lands in a text span AND leaves a hole that can become an audio span,
    because it claims no audio at all. That is rare - it takes a whole-segment
    alignment failure - and it is arguably two real facts about the chunk
    ("this text was not placed" and "this audio explains nothing"), so it is
    reported rather than suppressed. What must never happen, and does not, is
    the WEAK-BUT-TIMED word being counted twice.
    """
    text_spans = []
    run: list = []
    for word in words:
        weak = (not word.timed) or (word.score is None) \
            or (word.score < SPAN_SCORE_FLOOR)
        if weak:
            run.append(word)
            continue
        if run:
            text_spans.append(_text_span(run))
            run = []
    if run:
        text_spans.append(_text_span(run))

    placed = [w for w in words if w.timed]
    audio_spans = []
    cursor = 0.0
    for word in placed:
        if word.start_s - cursor >= MIN_AUDIO_SPAN_S:
            audio_spans.append(_audio_span(cursor, word.start_s, silences,
                                           'head' if cursor == 0.0 else 'interior'))
        cursor = max(cursor, word.end_s)
    if duration - cursor >= MIN_AUDIO_SPAN_S:
        audio_spans.append(_audio_span(cursor, duration, silences,
                                       'tail' if placed else 'head'))
    return tuple(text_spans), tuple(audio_spans)


def _text_span(run: Sequence[AlignedWord]) -> TextSpan:
    timed = [w for w in run if w.timed]
    scores = [w.score for w in run if w.score is not None]
    return TextSpan(
        first_word=run[0].index,
        last_word=run[-1].index,
        text=' '.join(w.word for w in run),
        audio_start_s=timed[0].start_s if timed else None,
        audio_end_s=timed[-1].end_s if timed else None,
        worst_score=min(scores) if scores else None,
    )


def _audio_span(start: float, end: float,
                silences: Sequence[Tuple[float, float]], where: str) -> AudioSpan:
    return AudioSpan(start_s=start, end_s=end,
                     speech_fraction=speech_fraction(start, end, silences),
                     where=where)


# ---------------------------------------------------------------------------
# The entry point
# ---------------------------------------------------------------------------


def align_chunk(audio_path: str, text: str, *, language: str = 'en',
                backend: str = DEFAULT_BACKEND, device: str = 'cpu',
                ffmpeg: Optional[str] = None, audio=None,
                pace_chars_per_sec: Optional[float] = None) -> Alignment:
    """Align one chunk's audio against the text it was asked to say.

    `text` must be the SPOKEN text - markers stripped, whitespace collapsed.
    `sentences.py` and the CLI do that with `paragraph_packer.spoken`, which is
    the same reading the engine prompt and the VTT cue take; passing raw session
    text would ask the aligner to find `[heading]` in the audio.

    `audio` lets a caller pass an already-decoded array (the failure-case tests
    build theirs in memory). When it is None the file is decoded here.

    `pace_chars_per_sec` is the voice's measured speaking rate, and it is used
    by exactly one thing: the RATE factor of a DERIVED score (`_derive_scores`),
    so a backend with model confidences ignores it. None means "measure this
    chunk's own printed characters over its own audio seconds", and the
    Alignment records which of the two it was in `pace_source` - the number is
    never silently one or the other.

    Raises `AlignerError` for anything it cannot do, naming the chunk. There is
    no second attempt and no other backend: see the module docstring.
    """
    if backend not in BACKENDS:
        raise AlignerError(
            f'unknown alignment backend {backend!r}; known: {", ".join(BACKENDS)}')
    device = check_device(device)
    spoken = ' '.join(text.split())
    if not spoken:
        raise AlignerError(f'{audio_path}: the chunk text is empty, so there is '
                           'nothing to align the audio against')

    if audio is None:
        audio = decode_audio(audio_path, ffmpeg)
    duration = audio.size / SAMPLE_RATE
    expected = chunk_words(spoken)

    started = time.time()
    try:
        raw = _BACKEND_FUNCTIONS[backend](audio, spoken, language, device)
    except AlignerError as refused:
        # A BACKEND'S REFUSAL KNOWS ITS OWN REASON AND NOT WHICH CHUNK. This
        # function's contract is that every refusal names the chunk, so the path
        # is prefixed here rather than threaded through every backend's
        # messages (the qwen3 mapping, for one, only ever sees a temp wav).
        raise AlignerError(f'{audio_path}: {refused}') from refused
    except Exception as failure:  # backend internals: torch, numpy, pandas
        raise AlignerError(
            f'{audio_path}: backend {backend!r} failed to align '
            f'{len(expected)} word(s) against {duration:.2f}s of audio: '
            f'{type(failure).__name__}: {failure}') from failure
    elapsed = time.time() - started

    if len(raw) == 0 and expected:
        # THE BACKEND GAVE UP ON THE WHOLE CHUNK, which is a different fact from
        # a word-count disagreement and deserves its own sentence. Measured
        # 2026-09-05 (witches chunk 4: 100 words in 4.5 s; Fuhrer chunk 1: 138
        # words in 6.5 s): whisperx logs "backtrack failed" and returns no
        # words when the audio cannot carry the text - a render that stopped
        # early, or one that says something else. The old sentence talked about
        # word lists lining up, which sent the operator looking at the text.
        rate = len(expected) / duration if duration > 0 else float('inf')
        raise AlignerError(
            f'{audio_path}: backend {backend!r} could not align this chunk at all: '
            f'{duration:.1f}s of audio for {len(expected)} word(s) '
            f'({rate:.0f} words per second). The render stopped early or does not '
            f'say this text. Re-render this chunk and align again.')
    if len(raw) != len(expected):
        rejoined = _rejoin_split_words(raw, expected)
        if rejoined is None:
            raise AlignerError(
                f'{audio_path}: backend {backend!r} returned {len(raw)} word(s) for '
                f'a {len(expected)}-word chunk. The word lists must line up index '
                f'for index or every sentence cue after the difference is wrong.')
        raw = rejoined

    words = []
    for index, ((word, start, end, score), mine) in enumerate(zip(raw, expected)):
        start = _number(start, 'start', index, word, audio_path, backend)
        end = _number(end, 'end', index, word, audio_path, backend)
        score = _number(score, 'score', index, word, audio_path, backend)
        if start is not None and end is not None and end < start:
            raise AlignerError(
                f'{audio_path}: backend {backend!r} placed word {index} '
                f'({word!r}) ending {end:.3f}s before it starts {start:.3f}s')
        words.append(AlignedWord(index=index, word=mine, start_s=start,
                                 end_s=end, score=score))
    words = tuple(words)

    silences = detect_silences(audio)

    # THE SCORES, AND WHAT THEY MEAN. A backend with model confidences is taken
    # at its word; one without gets the three-factor estimate, and either way
    # the Alignment says which the reader is holding.
    score_source = SCORE_SOURCE_BY_BACKEND[backend]
    pace = pace_chars_per_sec
    pace_source: Optional[str] = None
    if score_source == 'derived':
        if pace is None:
            # The chunk's OWN rate: printed characters over its own audio. It is
            # a weaker instrument than a voice's measured pace (a chunk that is
            # half silence reads slow), but it is measured on the thing being
            # scored, and `pace_source` says so in the report and in the VTT.
            pace = len(spoken) / duration if duration > 0 else 0.0
            pace_source = 'chunk'
        else:
            pace = float(pace)
            pace_source = 'given'
        words = _derive_scores(words, silences, pace)

    text_spans, audio_spans = _spans(words, silences, duration)
    return Alignment(
        audio_path=audio_path, text=spoken, language=language, backend=backend,
        device=device, duration_s=duration, words=words,
        score_source=score_source,
        unaligned_text_spans=text_spans, unaligned_audio_spans=audio_spans,
        silences=silences, elapsed_s=elapsed,
        pace_chars_per_sec=pace if score_source == 'derived' else None,
        pace_source=pace_source,
    )


def _rejoin_split_words(raw, expected):
    """Put back together a word whisperx split at a sentence boundary.

    whisperx splits the segment text into SENTENCES before it splits words,
    so one of our words that carries a sentence end inside it comes back as
    two: `grown!'"?` as `grown!'` + `'"?`, `Christianity.).` as
    `Christianity.)` + `).` (MEASURED 2026-09-05/06: witches chunks 109, 117,
    205, 214, 259, 282, 302, 325 and Fuhrer chunk 6 / SGLang chunk 5 - the
    whole "returned N+1 word(s)" class). The pieces are substrings of our
    word in order, overlapping by the ONE closing character whisperx keeps on
    both sides of its sentence split; they are rejoined by exact concatenation
    with that overlap admitted and nothing else: the merged word spans the
    first placed start to the last placed end and carries the lowest of its
    pieces' scores. Any piece that does not complete the word it belongs to
    returns None and the caller refuses as before - a count that cannot be
    explained is still a refusal.
    """
    out = []
    i = 0
    for mine in expected:
        if i >= len(raw):
            return None
        word, start, end, score = raw[i]
        i += 1
        if word == mine:
            out.append((word, start, end, score))
            continue
        pieces = [(word, start, end, score)]
        joined = word
        while joined != mine and mine.startswith(joined) and i < len(raw):
            piece = raw[i]
            i += 1
            pieces.append(piece)
            # THE PIECES OVERLAP BY ONE CHARACTER: whisperx's sentence split
            # keeps the closing quote or bracket on BOTH sides, so `grown!'"?`
            # comes back as `grown!'` + `'"?` (measured on the real audio,
            # SGLang chunk 5, 2026-09-06). The overlap is admitted only when
            # the exact join is not a prefix and the one-char-shorter join is.
            text = piece[0]
            if not mine.startswith(joined + text) and text and joined \
                    and text[0] == joined[-1] and mine.startswith(joined + text[1:]):
                text = text[1:]
            joined += text
        if joined != mine:
            return None
        starts = [p[1] for p in pieces if p[1] is not None]
        ends = [p[2] for p in pieces if p[2] is not None]
        scores = [p[3] for p in pieces if p[3] is not None]
        out.append((mine,
                    starts[0] if starts else None,
                    ends[-1] if ends else None,
                    min(scores) if scores else None))
    if i != len(raw):
        return None
    return out


def _number(value, field: str, index: int, word: str, audio_path: str,
            backend: str) -> Optional[float]:
    """One of a word's three numbers: a float, or None, or a refusal.

    NOT a blanket "anything unconvertible becomes None" (review finding 8). NaN
    IS meaningful - WhisperX interpolates missing word times and leaves NaN
    where it cannot, so NaN means "the backend placed nothing here" and maps to
    None. A STRING, a list or an object does not mean that: it means the
    backend returned something this code does not understand, and silently
    calling it None would turn a backend bug into a coverage FAILURE on a chunk
    that is probably fine.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AlignerError(
            f'{audio_path}: backend {backend!r} returned {field}={value!r} '
            f'({type(value).__name__}) for word {index} ({word!r}); a word time '
            f'or score is a number or nothing')
    value = float(value)
    if math.isnan(value):
        return None
    if math.isinf(value):
        raise AlignerError(
            f'{audio_path}: backend {backend!r} returned {field}={value} for '
            f'word {index} ({word!r})')
    return value
