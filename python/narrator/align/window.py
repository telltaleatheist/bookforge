"""Align ONE window of audio against ONE piece of text - the library door.

`align_chunk` and `align_session` are narrator's own doors: they take a session
manifest, a chunk's FLAC and the text that chunk was asked to say. THE CORPUS
CUTTER HAS NONE OF THAT. It holds a decoded five-minute window of an existing
audiobook and the book text it believes belongs to it, and it wants word times
and sentence cues back. Going through a manifest to ask that would mean minting
a fake session per window.

So this module is the one public function that other process calls, and it is
deliberately thin: `align_chunk` does the alignment, `sentence_cues` does the
cues over the window's OWN timeline (chunk 0, 0..duration), and everything that
comes back is JSON-safe so it can cross a pipe without either side importing the
other's dependencies.

WHY THE WINDOW IS FIVE MINUTES AND NOT THE BOOK. Qwen3-ForcedAligner places
timestamps "within up to 5 minutes" (`aligner.QWEN3_MAX_AUDIO_S`), and a longer
call is refused BY NAME rather than truncated. The cutter does its own windowing;
this refuses if it ever forgets.
"""

from __future__ import annotations

from typing import Optional

from .aligner import SAMPLE_RATE, AlignerError, align_chunk, decode_audio
from .sentences import sentence_cues

__all__ = ['align_text_window']

#: What an in-memory window is called in a refusal. `align_chunk`'s messages all
#: begin with the audio path, and an array has none; a caller reading "no audio
#: to align at <array>" would go looking for a file.
IN_MEMORY_LABEL = '<in-memory window>'


def align_text_window(audio, text, *, backend: str, language: str, device: str,
                      pace_chars_per_sec: Optional[float] = None,
                      sample_rate: Optional[int] = None,
                      ffmpeg: Optional[str] = None) -> dict:
    """One window of audio + the text it says -> word times and sentence cues.

    `backend`, `language` and `device` are REQUIRED and have no defaults, unlike
    `align_chunk`'s. This door is called by another process building a training
    corpus, and every one of the three changes what comes back: which aligner
    ran, whether the model was even asked for the right language, and whether
    the card was taken. A caller that has not decided them has not decided what
    it is measuring.

    `audio` is either a PATH (decoded here through `decode_audio`, i.e. ffmpeg
    to 16 kHz mono float32) or an ALREADY-DECODED 1-D float32 numpy array. An
    array MUST come with its `sample_rate`, and that rate must already be
    `SAMPLE_RATE` - nothing here resamples. That is not laziness: the caller
    that decoded the audio knows what it decoded and can ask ffmpeg for 16 kHz
    directly, whereas a resampler hidden in an alignment library would silently
    change the signal the timings are measured against. A rate that is not
    16 kHz is refused by name.

    `pace_chars_per_sec` is the voice's measured chars/sec, used only by a
    DERIVED word score's rate factor (the qwen3 backend). None means "measure
    this window's own", and the returned alignment says which in `paceSource`.

    Returns, all JSON-safe:

        {'alignment':    Alignment.as_dict(),
         'cues':         [{'text', 'start', 'end', 'quality'}, ...],
         'backend':      the backend that ran,
         'score_source': 'model' | 'derived'}

    `start`/`end` are seconds FROM THE START OF THIS WINDOW, because a window is
    its own timeline here; the cutter knows where the window sits in the book and
    this does not. `quality` is the same dict the sentence VTT's `NOTE quality`
    line carries (`assemble/sentence_vtt.QUALITY_NOTE_KEYS`).

    Raises `AlignerError` for everything it cannot do.
    """
    if isinstance(audio, str):
        if sample_rate is not None:
            raise AlignerError(
                f'align_text_window was given both a path ({audio}) and '
                f'sample_rate={sample_rate}; the path is decoded to '
                f'{SAMPLE_RATE} Hz here, so a rate beside it is two different '
                f'claims about the same audio')
        label = audio
        samples = decode_audio(audio, ffmpeg)
    else:
        if sample_rate is None:
            raise AlignerError(
                'align_text_window was given a decoded array and no '
                'sample_rate; there is no way to read seconds off samples '
                'without one')
        if int(sample_rate) != SAMPLE_RATE:
            raise AlignerError(
                f'align_text_window was given a {int(sample_rate)} Hz array; '
                f'the aligners are {SAMPLE_RATE} Hz models and nothing here '
                f'resamples. Decode the window at {SAMPLE_RATE} Hz mono '
                f'float32 and pass that.')
        label = IN_MEMORY_LABEL
        samples = audio

    alignment = align_chunk(label, text, language=language, backend=backend,
                            device=device, ffmpeg=ffmpeg, audio=samples,
                            pace_chars_per_sec=pace_chars_per_sec)

    # THE WINDOW IS ITS OWN CHUNK. `sentence_cues` checks the span it is handed
    # against the audio the aligner decoded (`SPAN_TOLERANCE_S`), which is what
    # catches a manifest that has come apart from its audio; here the two are
    # the same number by construction, so the check passes and the cues come out
    # in window-relative seconds.
    cues = sentence_cues(alignment, chunk_index=0, chunk_start_s=0.0,
                         chunk_end_s=alignment.duration_s)
    return {
        'alignment': alignment.as_dict(),
        'cues': [{'text': cue.text, 'start': cue.start_s, 'end': cue.end_s,
                  'quality': cue.quality}
                 for cue in cues],
        'backend': alignment.backend,
        'score_source': alignment.score_source,
    }
