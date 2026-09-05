"""Sentence-level cues INSIDE a chunk's span, from the chunk's alignment.

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 3, in full:

    narrator's VTT contract (cue text = chunk text, times from sample counts)
    stays the CHUNK-level truth; the sentence-level cues are derived from the
    alignment inside each chunk's span.

So this module ADDS a file and replaces nothing. `assemble/vtt.py` keeps writing
`<stem>.vtt` - one cue per rendered chunk, times a running sum of FLAC sample
counts, which is what the training tools, the reassembly bridge and the retake
UI read as the binding between sentence index, file, text and time. The
sentence cues go beside it as `<stem>.sentences.vtt`, and every one of them
lives strictly inside its chunk's cue.

THE SPLITTER IS THE PACKER'S. `paragraph_packer.split_sentences` - PASS 1's
pattern, with the abbreviation guard and the closing-quote rule - and no other.
A second segmenter here would put a cue boundary where the packer would not have
put a chunk boundary, and the two files would disagree about what a sentence is.

THE EDGE RULE, point 3's own words. The first sentence starts at the chunk's
start and the last ends at the chunk's end - the chunk's span is exact (sample
counts), the aligner's first and last word times are not, and a cue that starts
40 ms after the audio does is a read-along that lags. Interior seams snap onto
the middle of the pause between the words, the way `align_audiobook.py`
snap_boundaries does it and for the same reason: forced alignment puts a seam at
the CTC frame where it thinks the last phone ended, which lands a couple of
hundred milliseconds early or late, while the narrator's actual pause is a
silence and its middle is the safest place to cut.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

from ..assemble.vtt import format_timestamp
from ..text.paragraph_packer import spoken, split_sentences
from .aligner import Alignment, AlignerError

#: How far a seam may move from the middle of the inter-word gap to land in a
#: pause. `align_audiobook.py` uses 0.6 s over a whole audiobook, where a cue
#: seam can be seconds from the nearest detected silence; inside one chunk the
#: gap is already the pause, so the snap only has to cover the CTC frame's
#: couple hundred milliseconds of slop.
SNAP_WINDOW_S = 0.30

#: No cue may be shorter than this once the seams have moved. A floor, not a
#: target: it exists so a snap can never collapse a cue to zero or invert two.
MIN_CUE_S = 0.05

#: How far the manifest's span for a chunk may differ from the audio the
#: aligner decoded before this module refuses to place cues in it. The two are
#: the same file, so any real difference means the manifest and the audio have
#: come apart - a re-render that never updated `samples`, or a sentences-dir
#: override pointing at a different set.
SPAN_TOLERANCE_S = 0.05


@dataclass(frozen=True)
class SentenceCue:
    """One sentence of one chunk, in the BOOK's timeline (seconds)."""

    chunk_index: int
    sentence_index: int
    start_s: float
    end_s: float
    text: str
    is_heading: bool = False


def split_chunk_sentences(text: str) -> Tuple[str, ...]:
    """A chunk's text -> its sentences, using the packer's own splitter.

    Takes text with or without markers: `spoken()` strips them first, which is
    the same reading the aligner was given, so the sentences partition exactly
    the words the alignment carries.
    """
    return tuple(split_sentences(spoken(text)))


def sentence_word_ranges(sentences: Sequence[str],
                         word_count: int) -> Tuple[Tuple[int, int], ...]:
    """Sentence -> `(first_word, last_word)` inclusive, over the chunk's words.

    `split_sentences` is text-preserving: the pieces rejoin to the input's own
    words in order, so the ranges are a straight running count. Refuses rather
    than guesses when the counts disagree - a mismatch means the splitter and
    the aligner saw different text, and lining them up anyway would slide every
    later sentence onto the wrong words.
    """
    ranges = []
    cursor = 0
    for sentence in sentences:
        n = len([w for w in sentence.split(' ') if w])
        if n == 0:
            raise AlignerError(
                f'the splitter produced an empty sentence in {sentences!r}')
        ranges.append((cursor, cursor + n - 1))
        cursor += n
    if cursor != word_count:
        raise AlignerError(
            f'the chunk splits into {cursor} sentence word(s) but the alignment '
            f'carries {word_count}; the splitter and the aligner disagree about '
            f'the text')
    return tuple(ranges)


def _snap(raw: float, low: float, high: float,
          silences: Sequence[Tuple[float, float]]) -> float:
    """Pull a seam onto the middle of the nearest pause inside `[low, high]`.

    `align_audiobook.snap_boundaries`' rule, kept conservative in the same three
    ways: only silences OVERLAPPING the window are candidates, the target is the
    midpoint of the candidate CLIPPED to the window (so a long pause pulls the
    seam to the window edge, not to its own distant centre), and the nearest
    candidate wins.
    """
    if high <= low:
        return min(max(raw, low), high) if high >= low else raw
    window_lo = max(low, raw - SNAP_WINDOW_S)
    window_hi = min(high, raw + SNAP_WINDOW_S)
    if window_hi <= window_lo:
        return min(max(raw, low), high)
    best = None
    for a, b in silences:
        overlap_lo, overlap_hi = max(a, window_lo), min(b, window_hi)
        if overlap_hi <= overlap_lo:
            continue
        middle = 0.5 * (overlap_lo + overlap_hi)
        distance = abs(middle - raw)
        if best is None or distance < best[0]:
            best = (distance, middle)
    if best is None:
        return min(max(raw, low), high)
    return best[1]


def sentence_cues(alignment: Alignment, *, chunk_index: int,
                  chunk_start_s: float, chunk_end_s: float,
                  is_heading: bool = False,
                  text: Optional[str] = None) -> Tuple[SentenceCue, ...]:
    """One chunk's alignment -> its sentence cues, in the BOOK's timeline.

    `chunk_start_s` / `chunk_end_s` are the chunk's own cue span from the
    manifest - a running sum of sample counts plus the realized gaps, computed
    exactly as `assemble/vtt.build_vtt` computes it, so the sentence cues and
    the chunk cue cannot drift apart.

    Refuses when a sentence has no placed word at all: cues for it would be
    invented, and a chunk in that state is one the coverage guard has already
    failed. The caller records the refusal against the chunk and carries on.
    """
    span = chunk_end_s - chunk_start_s
    if span <= 0:
        raise AlignerError(
            f'chunk {chunk_index}: the manifest gives it a {span:.3f}s cue span')
    if abs(span - alignment.duration_s) > SPAN_TOLERANCE_S:
        raise AlignerError(
            f'chunk {chunk_index}: the manifest says {span:.3f}s but '
            f'{alignment.audio_path} decodes to {alignment.duration_s:.3f}s. '
            f'The manifest and the audio have come apart; re-derive the '
            f'manifest from the sentences dir that was actually rendered.')

    sentences = split_chunk_sentences(text if text is not None else alignment.text)
    ranges = sentence_word_ranges(sentences, len(alignment.words))

    # Each sentence's own first and last PLACED word, in the chunk's timeline.
    bounds = []
    for position, (first, last) in enumerate(ranges):
        timed = [w for w in alignment.words[first:last + 1] if w.timed]
        if not timed:
            raise AlignerError(
                f'chunk {chunk_index}: sentence {position} '
                f'({sentences[position][:60]!r}) has no placed word, so its cue '
                f'would be invented rather than measured')
        bounds.append((timed[0].start_s, timed[-1].end_s))

    # Interior seams: the middle of the gap between the two sentences' words,
    # snapped into the pause that is actually there.
    #
    # THE GEOMETRY IS BOUNDED BY `span`, THE MANIFEST'S NUMBER, not by the
    # decoded duration. They differ by a hair - the manifest counts the FLAC's
    # own samples at 24 kHz and the aligner decoded the same file to 16 kHz -
    # and if the last cue ended at the DECODED duration it would land a
    # millisecond past its chunk's cue and therefore a millisecond after the
    # next chunk's first sentence starts. The tolerance check above is what
    # makes clamping to `span` safe rather than a fudge: the two are already
    # known to agree to `SPAN_TOLERANCE_S`.
    seams = []
    for position in range(len(bounds) - 1):
        left_end = bounds[position][1]
        right_start = bounds[position + 1][0]
        raw = 0.5 * (left_end + right_start) if right_start >= left_end \
            else max(left_end, right_start)
        low = (seams[-1] if seams else 0.0) + MIN_CUE_S
        high = span - MIN_CUE_S * (len(bounds) - position - 1)
        seams.append(_snap(raw, low, high, alignment.silences))

    cues = []
    for position, sentence in enumerate(sentences):
        start = 0.0 if position == 0 else seams[position - 1]
        end = span if position == len(sentences) - 1 else seams[position]
        cues.append(SentenceCue(
            chunk_index=chunk_index,
            sentence_index=position,
            start_s=chunk_start_s + start,
            end_s=chunk_start_s + end,
            text=sentence,
            is_heading=is_heading,
        ))
    return tuple(cues)


def build_sentence_vtt(cues: Sequence[SentenceCue]) -> str:
    """The `.sentences.vtt` document, as a string.

    Same shape as `assemble/vtt.build_vtt` writes - `WEBVTT`, a blank line,
    then `HH:MM:SS.mmm --> HH:MM:SS.mmm` and the cue text, no identifiers and no
    NOTE blocks - and the SAME `format_timestamp`, imported rather than copied,
    so a sentence cue and its chunk cue round the same number the same way.
    A heading cue is bold, exactly as the chunk-level file bolds it.
    """
    if not cues:
        raise AlignerError('build_sentence_vtt(): no cues to write')
    previous_end = None
    blocks = []
    for cue in cues:
        if cue.end_s < cue.start_s:
            raise AlignerError(
                f'chunk {cue.chunk_index} sentence {cue.sentence_index}: cue '
                f'ends {cue.end_s:.3f}s before it starts {cue.start_s:.3f}s')
        if previous_end is not None and cue.start_s < previous_end - 1e-6:
            raise AlignerError(
                f'chunk {cue.chunk_index} sentence {cue.sentence_index}: cue '
                f'starts {cue.start_s:.3f}s, before the previous cue ended '
                f'{previous_end:.3f}s')
        previous_end = cue.end_s
        text = f'<b>{cue.text}</b>' if cue.is_heading and cue.text else cue.text
        blocks.append(
            f'{format_timestamp(cue.start_s)} --> {format_timestamp(cue.end_s)}'
            f'\n{text}\n')
    return 'WEBVTT\n\n' + '\n'.join(blocks)


def write_sentence_vtt(cues: Sequence[SentenceCue], path: str) -> str:
    """Write the sentence VTT to `path` (UTF-8, LF), and return the path.

    LF on every platform, the same declared deviation `assemble/vtt.write_vtt`
    makes and for the same reasons.
    """
    content = build_sentence_vtt(cues)
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        raise AlignerError(f'write_sentence_vtt(): {parent} is not a directory')
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(content)
    return path
