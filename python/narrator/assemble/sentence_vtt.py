"""The sentence transcript: the cue type, the writer, and the ESTIMATED cue.

Owen's ruling, 2026-09-05, in full:

    there will always be truncations or errors of some sort. thats the nature of
    tts. nothing is going to come out perfect. we try our best to detect and
    reduce the number of errors but assembly will never function, ever, if we
    expect it to come out the other side flawless. we need to base assembly on
    the expected text and the actual real length of the audio. with orpheus, for
    truncations, we split at sentence boundaries and re-rendered. but the goal is
    to have zero truncations.

So a chunk the ALIGNER could not place still gets cues. Not invented ones - laid
over the chunk's REAL audio span (the manifest's own sample count, the same
running sum `build_vtt` uses) in proportion to each sentence's share of the
chunk's spoken characters, and MARKED as an estimate in the file itself. The
coverage report names the chunk; the VTT says the cue is an estimate; nothing is
hidden and nothing blocks.

WHY THIS LIVES IN `assemble/` AND NOT IN `align/`. Two callers need it and only
one of them can import the other:

  * `align/run.py` lays estimated cues over a chunk it could not place, or one
    whose measured cues it had to refuse, and writes the rest measured;
  * `assemble/run.py` has no report at all (the Align row never ran) and lays
    them over EVERY chunk.

Assembly must not import `align/` - the aligner needs torch and the whisperx env
and assembly runs on a machine with neither - so the shared half sits on the
assembly side, beside `vtt.chunk_spans`, which is the one place the running sum
of sample counts lives. One geometry, two callers, no second copy.

THE SPLITTER IS THE PACKER'S, imported LAZILY. `paragraph_packer.split_sentences`
is the same splitter `align/sentences.py` uses, so an estimated cue and a
measured one agree about what a sentence is. It is imported inside the function
rather than at module scope because it pulls in `regex`, and the rest of this
module - the cue type, the writer, `assemble/run.py`'s import of it - is stdlib.
An assembly that never estimates never pays for it.

HOW AN ESTIMATE IS MARKED, and this is THE representation (documented here,
tolerated by the readers): a WebVTT `NOTE` block immediately before the first
estimated cue of each run of them, naming the chunk:

    NOTE estimated chunk 41 - the aligner could not place this chunk; these cue
    times are proportional to sentence length over the chunk's real audio.

    00:03:11.480 --> 00:03:14.200
    He said nothing at all.

A `NOTE` block is standard WebVTT (a block whose first line begins `NOTE`,
terminated by a blank line) and carries no timing, so a reader that scans blocks
for `-->` skips it and a reader that shows cues shows exactly the cues.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence, Tuple

from .vtt import chunk_spans, format_timestamp


#: The sentence transcript's suffix. `<stem>.vtt` is the chunk-level file - the
#: one the reassembly bridge pairs to the m4b and the one training reads - and
#: this sits BESIDE it and never replaces it. Named here rather than in
#: `align/run.py` because assembly writes the file too, and assembly may not
#: import `align/`.
SENTENCE_VTT_SUFFIX = '.sentences.vtt'


class SentenceVttError(ValueError):
    """A sentence transcript could not be built. Always names the chunk."""


@dataclass(frozen=True)
class SentenceCue:
    """One sentence of one chunk, in the BOOK's timeline (seconds).

    `estimated` is the difference between a cue that was MEASURED - the aligner
    placed its words - and one laid proportionally over the chunk's real audio
    because there was no alignment to place it with. It is written into the file
    (see the module docstring) rather than kept in memory, because the operator
    reading the transcript is the person who needs to know.

    `quality` is the MEASURED cue's own report card - see
    `align/sentences.sentence_cues`, which is the only thing that fills it in,
    and `QUALITY_NOTE_KEYS` below for the shape. None on an estimated cue,
    because there is nothing measured to report; None also on a cue built by
    hand (the tests, the retake tooling), which is why it is a plain field with
    no default value read into it.
    """

    chunk_index: int
    sentence_index: int
    start_s: float
    end_s: float
    text: str
    is_heading: bool = False
    estimated: bool = False
    quality: Optional[dict] = None


def split_chunk_sentences(text: str) -> Tuple[str, ...]:
    """A chunk's text -> its sentences, using the packer's own splitter.

    Markers are stripped first (`spoken()`), which is the same reading the engine
    prompt and the aligner were given, so the sentences partition exactly the
    words that were spoken.

    THE IMPORT IS LAZY - see the module docstring. `paragraph_packer` needs
    `regex`; the writer and the cue type do not.
    """
    from ..text.paragraph_packer import spoken, split_sentences

    return tuple(split_sentences(spoken(text)))


def proportional_cues(*, chunk_index: int, chunk_start_s: float,
                      chunk_end_s: float, text: str,
                      is_heading: bool = False) -> Tuple[SentenceCue, ...]:
    """Estimated cues for ONE chunk: expected text over real audio.

    `chunk_start_s` / `chunk_end_s` are the chunk's own cue span - the manifest's
    running sum of sample counts, from `vtt.chunk_spans` - so the estimate lives
    strictly inside the chunk's own cue exactly as a measured one does, and the
    "real length of the audio" the ruling asks for is the length the audio
    actually has rather than a length anybody predicted.

    THE WEIGHT IS CHARACTERS, not words. A sentence's spoken duration tracks its
    character count more closely than its word count (a word is between one and
    fifteen characters of speech), and the chars/sec rate is the same instrument
    Orpheus's own duration guard uses.

    Returns () for a chunk that speaks nothing - a `[break]` row is silence by
    design and has no sentence to cue.
    """
    span = chunk_end_s - chunk_start_s
    if span <= 0:
        raise SentenceVttError(
            f'chunk {chunk_index}: the manifest gives it a {span:.3f}s cue span, '
            f'so there is no audio to lay cues over')

    sentences = split_chunk_sentences(text)
    if not sentences:
        return ()

    weights = [max(1, len(s.strip())) for s in sentences]
    total = float(sum(weights))

    cues = []
    elapsed = 0.0
    for position, (sentence, weight) in enumerate(zip(sentences, weights)):
        start = elapsed
        elapsed = elapsed + span * (weight / total)
        # The LAST cue ends on the chunk's own end, not on the running sum: the
        # divisions are floats and the last one must land on the span exactly,
        # or the cue ends a microsecond after its chunk's cue does.
        end = span if position == len(sentences) - 1 else elapsed
        cues.append(SentenceCue(
            chunk_index=chunk_index,
            sentence_index=position,
            start_s=chunk_start_s + start,
            end_s=chunk_start_s + end,
            text=sentence,
            is_heading=is_heading,
            estimated=True,
        ))
    return tuple(cues)


def estimated_cues_for_manifest(manifest, *,
                                where: str = 'estimated_cues_for_manifest',
                                ) -> Tuple[SentenceCue, ...]:
    """Estimated cues for EVERY chunk of a manifest - the no-report path.

    What assembly writes when the Align row never ran: the same spans the
    chunk-level VTT is built from (`chunk_spans`, imported rather than copied),
    with each chunk's text spread across its own audio.
    """
    cues = []
    for chunk, start, end in chunk_spans(manifest, where):
        cues.extend(proportional_cues(
            chunk_index=chunk.index, chunk_start_s=start, chunk_end_s=end,
            text=chunk.text, is_heading=chunk.kind == 'heading'))
    return tuple(cues)


#: The first words of the NOTE block that marks a run of estimated cues. THE
#: representation, named once so the writer, the tests and any future reader
#: agree on it rather than on a regex somebody wrote twice.
ESTIMATED_NOTE_PREFIX = 'NOTE estimated chunk'


def _estimated_note(chunk_index: int) -> str:
    return (
        f'{ESTIMATED_NOTE_PREFIX} {chunk_index} - the aligner did not place this '
        f'chunk, so these cue times are proportional to sentence length over the '
        f"chunk's real audio.")


#: The first words of the NOTE block that carries a MEASURED cue's quality.
QUALITY_NOTE_PREFIX = 'NOTE quality'

#: THE QUALITY NOTE CONTRACT, and it is a contract: one line, `key=value` pairs
#: separated by single spaces, IN THIS ORDER, immediately before the cue it
#: describes. The training side thresholds on these to pick alignment-clean
#: sentences out of a book; nothing here drops or reclassifies a cue on them,
#: because the thresholds are the reader's and the measurement is ours.
#:
#:     NOTE quality monotonic=1 cps=14.1 pace_ratio=1.00 boundary_silence=0.32 worst=0.91 source=derived
#:
#: `(key, quality-dict field, format)`. A field whose value is None is written
#: as the literal `none` - a parseable "not measurable here" rather than a
#: missing key that would shift every later pair for a positional reader.
QUALITY_NOTE_KEYS = (
    ('monotonic', 'monotonic', 'flag'),
    ('cps', 'chars_per_sec', '.1f'),
    ('pace_ratio', 'pace_ratio', '.2f'),
    ('boundary_silence', 'boundary_silence_s', '.2f'),
    ('worst', 'worst_word_score', '.2f'),
    ('source', 'score_source', 'text'),
)


def _quality_note(quality: dict) -> str:
    """One cue's quality dict -> the one NOTE line. Refuses a dict missing a
    key rather than writing a short line: a reader splitting on `=` would
    silently read the next pair's value into the missing field's slot."""
    parts = []
    for name, field_name, how in QUALITY_NOTE_KEYS:
        if field_name not in quality:
            raise SentenceVttError(
                f'a cue quality dict is missing {field_name!r}; the quality '
                f'NOTE is a fixed set of keys in a fixed order '
                f'({", ".join(k for k, _f, _h in QUALITY_NOTE_KEYS)})')
        value = quality[field_name]
        if value is None:
            parts.append(f'{name}=none')
        elif how == 'flag':
            parts.append(f'{name}={1 if value else 0}')
        elif how == 'text':
            parts.append(f'{name}={value}')
        else:
            parts.append(f'{name}={value:{how}}')
    return f'{QUALITY_NOTE_PREFIX} ' + ' '.join(parts)


def build_sentence_vtt(cues: Sequence[SentenceCue]) -> str:
    """The `.sentences.vtt` document, as a string.

    Same shape as `vtt.build_vtt` writes - `WEBVTT`, a blank line, then
    `HH:MM:SS.mmm --> HH:MM:SS.mmm` and the cue text, no cue identifiers - and the
    SAME `format_timestamp`, imported rather than copied, so a sentence cue and
    its chunk cue round the same number the same way. A heading cue is bold,
    exactly as the chunk-level file bolds it.

    THE ONE ADDITION is the `NOTE estimated chunk <i>` block before each run of
    estimated cues (module docstring). It is emitted ONCE per run rather than per
    cue: an unplaceable chunk of nine sentences is one fact about one chunk, and
    nine identical notes would bury the transcript it is annotating.

    THE SECOND ADDITION (2026-09-08) is the `NOTE quality ...` line before each
    MEASURED cue that carries one - `QUALITY_NOTE_KEYS` is the format. That one
    IS per cue, because it is a measurement OF THAT CUE and not a fact about its
    chunk. An estimated cue never has one: it was never measured.
    """
    if not cues:
        raise SentenceVttError('build_sentence_vtt(): no cues to write')
    previous_end: Optional[float] = None
    previous_note: Optional[int] = None
    blocks = []
    for cue in cues:
        if cue.end_s < cue.start_s:
            raise SentenceVttError(
                f'chunk {cue.chunk_index} sentence {cue.sentence_index}: cue '
                f'ends {cue.end_s:.3f}s before it starts {cue.start_s:.3f}s')
        if previous_end is not None and cue.start_s < previous_end - 1e-6:
            raise SentenceVttError(
                f'chunk {cue.chunk_index} sentence {cue.sentence_index}: cue '
                f'starts {cue.start_s:.3f}s, before the previous cue ended '
                f'{previous_end:.3f}s')
        previous_end = cue.end_s
        if cue.estimated and previous_note != cue.chunk_index:
            blocks.append(_estimated_note(cue.chunk_index) + '\n')
            previous_note = cue.chunk_index
        elif not cue.estimated:
            previous_note = None
        if cue.quality is not None:
            if cue.estimated:
                # An estimate is not a measurement, so it cannot carry one.
                # Writing both would tell a reader that a proportional guess had
                # a measured 0.91 worst-word score.
                raise SentenceVttError(
                    f'chunk {cue.chunk_index} sentence {cue.sentence_index} is '
                    f'marked estimated AND carries a quality measurement')
            blocks.append(_quality_note(cue.quality) + '\n')
        text = f'<b>{cue.text}</b>' if cue.is_heading and cue.text else cue.text
        blocks.append(
            f'{format_timestamp(cue.start_s)} --> {format_timestamp(cue.end_s)}'
            f'\n{text}\n')
    return 'WEBVTT\n\n' + '\n'.join(blocks)


def write_sentence_vtt(cues: Sequence[SentenceCue], path: str) -> str:
    """Write the sentence VTT to `path` (UTF-8, LF), and return the path.

    LF on every platform, the same declared deviation `vtt.write_vtt` makes and
    for the same reasons.
    """
    content = build_sentence_vtt(cues)
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        raise SentenceVttError(f'write_sentence_vtt(): {parent} is not a directory')
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(content)
    return path


def count_estimated(cues: Iterable[SentenceCue]) -> int:
    """How many of these cues are estimates - the number the log line says."""
    return sum(1 for cue in cues if cue.estimated)
