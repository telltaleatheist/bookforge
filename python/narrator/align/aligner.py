"""Force-align ONE rendered chunk's audio against the text it was asked to say.

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 3: the model
exposes no text-to-time mapping, so the sentence-level cues and the coverage
guard both come from a CTC forced alignment of each chunk after it is rendered.
This module is the alignment itself; `sentences.py` turns it into cues and
`coverage.py` turns it into the guard.

THE SHIPPED BACKEND IS WHISPERX. Both candidates were measured on ten kershaw
chunks (CPU, this machine, 2026-09-05); the numbers and the reasoning are in
`README.md`. In one line: the two agree on word times to the CTC frame (median
delta 0.000 s, p95 0.020 s over 529 words) and cost the same wall clock, but
only WhisperX LOCALIZES the text inside longer audio - given a chunk's text
against that chunk plus the next one, WhisperX ended the last word 0.4-0.9 s
past the true end while torchaudio's `forced_align` smeared it to within a
second of the audio end in 6 pairs out of 6. Point 4's "audio with no text" is
undetectable with the second behaviour, so WhisperX is what ships.

NO AUTOMATIC SWITCHING (Owen's ruling, 2026-09-05). `torchaudio` stays as an
operator-selected `--backend` for comparison and refuses BY NAME when its
dependency is missing. There is no "try A then B" path anywhere in this file: a
backend that fails on a chunk raises `AlignerError` naming the chunk, and the
run stops.

CPU ONLY BY DEFAULT, and a CUDA request is refused by name while BookForge's
`external-gpu-job.lock` exists - a render or a training run owns the card and an
aligner is not entitled to take it. Alignment is seconds per chunk on CPU
(measured 0.26-2.8 s for 5-30 s chunks), so there is nothing to gain.

WHAT AN ALIGNMENT SAYS, AND WHAT IT DOES NOT. CTC forced alignment is MONOTONIC
and TOTAL: every word of the text is assigned a span, whether or not it was
spoken. So "this word has no timestamp" is NOT the dropped-text signal - the
SCORE is. Measured on kershaw chunk 20: with the true text, 2 % of words score
under 0.4; with one extra sentence appended that the audio never says, 91 % of
that sentence's words do; with the audio truncated to 60 %, 94 % of the
stranded tail does. `coverage.py` owns the thresholds; this module reports the
scores and the spans and judges nothing.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

# The alignment sample rate. wav2vec2 is a 16 kHz model; every backend here
# feeds it 16 kHz mono float32, whatever the chunk's own rate is.
SAMPLE_RATE = 16000

#: The backends this module knows how to run. `whisperx` ships (see the module
#: docstring); `torchaudio` is comparison only and never selected implicitly.
BACKENDS = ('whisperx', 'torchaudio')
DEFAULT_BACKEND = 'whisperx'

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
    """The whole answer for one chunk."""

    audio_path: str
    text: str
    language: str
    backend: str
    device: str
    duration_s: float
    words: Tuple[AlignedWord, ...]
    unaligned_text_spans: Tuple[TextSpan, ...] = ()
    unaligned_audio_spans: Tuple[AudioSpan, ...] = ()
    silences: Tuple[Tuple[float, float], ...] = ()
    elapsed_s: float = 0.0

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
            'words': [
                {'index': w.index, 'word': w.word, 'start': w.start_s,
                 'end': w.end_s, 'score': w.score}
                for w in self.words
            ],
            'silences': [[a, b] for a, b in self.silences],
        }


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
    return Alignment(
        audio_path=data['audioPath'],
        text=data['text'],
        language=data['language'],
        backend=data['backend'],
        device=data['device'],
        duration_s=duration,
        words=words,
        unaligned_text_spans=text_spans,
        unaligned_audio_spans=audio_spans,
        silences=silences,
        elapsed_s=float(data['elapsedSeconds']),
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


def check_device(device: str) -> str:
    """Refuse a CUDA alignment while another job owns the GPU.

    The aligner is a CPU tool - seconds per chunk - and taking the card from a
    render or a training run to save two seconds is not a trade narrator makes
    on its own. Named refusal, never a silent downgrade to CPU: a caller that
    asked for CUDA gets told why it cannot have it.
    """
    if device != 'cuda':
        return device
    lock = gpu_lock_path()
    if lock and os.path.exists(lock):
        raise AlignerError(
            f'refusing to align on CUDA: {lock} exists, so another BookForge '
            f'GPU job owns the card. Align on CPU (device=cpu) - a chunk takes '
            f'seconds there - or wait for that job to finish.')
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
    """WhisperX align mode. THE SHIPPED BACKEND."""
    import whisperx

    model, meta = _load_whisperx(language, device)

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


#: torchaudio's forced_align is DEPRECATED (2.8 warns; the 2.9 release removes
#: it - pytorch/audio#3902). That, and its inability to localize text inside
#: longer audio, is why it is the comparison backend and not the shipped one.
TORCHAUDIO_BUNDLE = 'WAV2VEC2_ASR_BASE_960H'


def _load_torchaudio(language: str, device: str):
    if language != 'en':
        raise AlignerError(
            f"backend 'torchaudio' has one bundle here ({TORCHAUDIO_BUNDLE}, "
            f"English) and was asked for language {language!r}. Use "
            f"--backend whisperx, which carries a model per language.")
    try:
        import torch
        import torchaudio
        import torchaudio.functional as functional
    except ImportError as missing:
        raise AlignerError(
            f"backend 'torchaudio' needs torch and torchaudio ({missing})."
        ) from missing
    if not hasattr(functional, 'forced_align'):
        raise AlignerError(
            f'this torchaudio ({torchaudio.__version__}) has no '
            'functional.forced_align - it was deprecated in 2.8 and removed in '
            "2.9 (pytorch/audio#3902). Use --backend whisperx.")

    key = ('torchaudio', language, device)
    if key not in _MODEL_CACHE:
        bundle = getattr(torchaudio.pipelines, TORCHAUDIO_BUNDLE)
        model = bundle.get_model().to(device)
        labels = bundle.get_labels()
        # Label 0 is the CTC blank and label 1 is the word separator; neither
        # may appear as a transcript character, so a literal '-' in the text is
        # dropped rather than silently becoming the blank (which is what
        # forced_align refuses outright: "targets shouldn't contain blank").
        lookup = {c: i for i, c in enumerate(labels) if c not in ('-', '|')}
        _MODEL_CACHE[key] = (model, lookup, labels.index('|'))
    return _MODEL_CACHE[key]


def _torchaudio_words(audio, text: str, language: str, device: str):
    """torchaudio `functional.forced_align`. COMPARISON ONLY - see the README.

    The same wav2vec2 checkpoint WhisperX uses for English, driven through
    torchaudio's own CTC aligner. Refuses by name for a language it has no
    bundle for, and for a torchaudio that has dropped `forced_align`.
    """
    import torch
    import torchaudio.functional as functional

    model, lookup, separator = _load_torchaudio(language, device)

    words = [w for w in text.upper().split(' ') if w]
    tokens, owner = [], []
    for position, word in enumerate(words):
        chars = [c for c in word if c in lookup]
        if not chars:
            continue
        if tokens:
            tokens.append(separator)
            owner.append(-1)
        for char in chars:
            tokens.append(lookup[char])
            owner.append(position)
    if not tokens:
        raise AlignerError(
            f'no character of the chunk text is in the {TORCHAUDIO_BUNDLE} '
            f'alphabet: {text[:80]!r}')

    with torch.inference_mode():
        emission, _ = model(torch.tensor(audio).unsqueeze(0).to(device))
        log_probs = torch.log_softmax(emission, dim=-1)
        targets = torch.tensor([tokens], dtype=torch.int32, device=device)
        aligned, scores = functional.forced_align(log_probs, targets, blank=0)
        spans = functional.merge_tokens(aligned[0], scores[0].exp())

    ratio = audio.size / log_probs.size(1) / SAMPLE_RATE
    per_word: dict = {}
    for span, position in zip(spans, owner):
        if position >= 0:
            per_word.setdefault(position, []).append(span)
    out = []
    for position, word in enumerate(words):
        found = per_word.get(position)
        if not found:
            out.append((word, None, None, None))
            continue
        score = sum(float(s.score) for s in found) / len(found)
        out.append((word, found[0].start * ratio, found[-1].end * ratio, score))
    return out


_BACKEND_FUNCTIONS = {
    'whisperx': _whisperx_words,
    'torchaudio': _torchaudio_words,
}

_BACKEND_LOADERS = {
    'whisperx': _load_whisperx,
    'torchaudio': _load_torchaudio,
}


def load_backend(backend: str, language: str = 'en', device: str = 'cpu') -> float:
    """Load a backend's model into this process and return the seconds it took.

    Called BEFORE a run so `Alignment.elapsed_s` measures alignment and not a
    one-off model load. Measured on this machine: WhisperX 5.6 s warm / 19.5 s
    cold, torchaudio 0.6 s warm - charged to the first chunk otherwise, which
    made a 0.3 s chunk look like a 34 s one in the first report this wrote.
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
    (measured while writing the tests). The two lists answer different
    questions and must not overlap.
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
                ffmpeg: Optional[str] = None, audio=None) -> Alignment:
    """Align one chunk's audio against the text it was asked to say.

    `text` must be the SPOKEN text - markers stripped, whitespace collapsed.
    `sentences.py` and the CLI do that with `paragraph_packer.spoken`, which is
    the same reading the engine prompt and the VTT cue take; passing raw session
    text would ask the aligner to find `[heading]` in the audio.

    `audio` lets a caller pass an already-decoded array (the failure-case tests
    build theirs in memory). When it is None the file is decoded here.

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
    except AlignerError:
        raise
    except Exception as failure:  # backend internals: torch, numpy, pandas
        raise AlignerError(
            f'{audio_path}: backend {backend!r} failed to align '
            f'{len(expected)} word(s) against {duration:.2f}s of audio: '
            f'{type(failure).__name__}: {failure}') from failure
    elapsed = time.time() - started

    if len(raw) != len(expected):
        raise AlignerError(
            f'{audio_path}: backend {backend!r} returned {len(raw)} word(s) for '
            f'a {len(expected)}-word chunk. The word lists must line up index '
            f'for index or every sentence cue after the difference is wrong.')

    words = []
    for index, ((word, start, end, score), mine) in enumerate(zip(raw, expected)):
        start = None if start is None or _nan(start) else float(start)
        end = None if end is None or _nan(end) else float(end)
        score = None if score is None or _nan(score) else float(score)
        if start is not None and end is not None and end < start:
            raise AlignerError(
                f'{audio_path}: backend {backend!r} placed word {index} '
                f'({word!r}) ending {end:.3f}s before it starts {start:.3f}s')
        words.append(AlignedWord(index=index, word=mine, start_s=start,
                                 end_s=end, score=score))
    words = tuple(words)

    silences = detect_silences(audio)
    text_spans, audio_spans = _spans(words, silences, duration)
    return Alignment(
        audio_path=audio_path, text=spoken, language=language, backend=backend,
        device=device, duration_s=duration, words=words,
        unaligned_text_spans=text_spans, unaligned_audio_spans=audio_spans,
        silences=silences, elapsed_s=elapsed,
    )


def _nan(value) -> bool:
    try:
        return math.isnan(float(value))
    except (TypeError, ValueError):
        return True
