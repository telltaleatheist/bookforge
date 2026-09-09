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

EVERY MEASURED CUE CARRIES ITS OWN REPORT CARD (2026-09-08). `SentenceCue.quality`
is six numbers about THIS cue - is it in order, how fast it reads, how that
compares to the pace the alignment scored against, how long the pause it starts
in is, its worst word score, and whether those scores are the model's or
derived - written into the VTT as a `NOTE quality ...` line
(`assemble/sentence_vtt.QUALITY_NOTE_KEYS` is the format). It exists because the
qwen3 backend PLACES a window whose text differs from the speech rather than
refusing it (see `aligner.py` - 116 of Shift's 1,083 chunk starts), so a
consumer picking training-clean sentences needs the evidence. NOTHING HERE ACTS
ON IT: no cue is dropped, re-timed or reclassified on a quality number. The
thresholds belong to whoever reads the file.

THIS MODULE IS THE MEASURED HALF ONLY. The cue TYPE, the file writer and the
ESTIMATED cue - expected text laid over the chunk's real audio when there is no
alignment to measure with (Owen, 2026-09-05) - live in
`assemble/sentence_vtt.py`, because assembly needs them too and may not import
this package. They are re-exported here so `align.sentences` still names the
whole vocabulary its callers know it by.
"""

from __future__ import annotations

from typing import Optional, Sequence, Tuple

from ..assemble.sentence_vtt import (QUALITY_NOTE_KEYS,  # noqa: F401
                                     SentenceCue, SentenceVttError,
                                     build_sentence_vtt, proportional_cues,
                                     split_chunk_sentences, write_sentence_vtt)
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
    if high < low:
        # Unreachable: `sentence_cues` refuses a chunk too short for its
        # sentence count before it gets here, precisely so this function never
        # has to invent a seam (review finding 9 - it used to return `raw`
        # unbounded, which could land past the chunk and left the refusal to
        # `build_sentence_vtt`, blaming the cue instead of the geometry).
        raise AlignerError(
            f'_snap: no room for a seam between {low:.3f}s and {high:.3f}s')
    if high == low:
        return low
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


def _boundary_silence_s(start: float,
                        silences: Sequence[Tuple[float, float]]) -> float:
    """The length of the silence-map gap the cue START sits in; 0.0 in speech.

    A cue that begins in the middle of a 0.32 s pause began where the narrator
    stopped talking - the safest boundary there is. One that begins inside
    speech began in the middle of a word, which is what a boundary error looks
    like from the outside. The number, not the verdict: the training side
    thresholds on it.
    """
    for a, b in silences:
        if a <= start <= b:
            return b - a
    return 0.0


def _cue_quality(alignment: Alignment, words: Sequence, start: float,
                 end: float, sentence: str, monotonic: bool) -> dict:
    """One measured cue's report card. `start`/`end` are CHUNK-relative, which
    is the timeline `alignment.silences` is in.

    Every field is a MEASUREMENT and none of them is a judgement: nothing in
    this package drops, reclassifies or re-times a cue on them. The training
    side that consumes the sentence VTT picks its own thresholds, because it is
    the one that knows what it is training.
    """
    span = end - start
    chars = len(sentence.strip())
    cps = (chars / span) if span > 0 else 0.0
    pace = alignment.pace_chars_per_sec
    scores = [w.score for w in words if w.score is not None]
    return {
        'monotonic': monotonic,
        'chars_per_sec': cps,
        # None, not 1.0, when the alignment used no pace: a 'model' score source
        # never measured one, and a ratio against a number nobody chose would be
        # a fact invented at write time.
        'pace_ratio': (cps / pace) if (pace is not None and pace > 0) else None,
        'boundary_silence_s': _boundary_silence_s(start, alignment.silences),
        'worst_word_score': min(scores) if scores else None,
        'score_source': alignment.score_source,
    }


def sentence_cues(alignment: Alignment, *, chunk_index: int,
                  chunk_start_s: float, chunk_end_s: float,
                  is_heading: bool = False,
                  text: Optional[str] = None) -> Tuple[SentenceCue, ...]:
    """One chunk's alignment -> its sentence cues, in the BOOK's timeline.

    `chunk_start_s` / `chunk_end_s` are the chunk's own cue span from the
    manifest - a running sum of sample counts plus the realized gaps, computed
    exactly as `assemble/vtt.build_vtt` computes it, so the sentence cues and
    the chunk cue cannot drift apart.

    Refuses when a sentence has no placed word at all: a cue built from this
    function is a MEASUREMENT, and a sentence with nothing placed has nothing to
    measure. The caller records the refusal against the chunk by name and then
    lays `proportional_cues` over the chunk instead, marked as estimates - which
    is the ruling of 2026-09-05: expected text over the real length of the audio,
    said out loud rather than pretended.
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

    # THE GEOMETRY HAS TO FIT BEFORE ANY OF IT IS COMPUTED. n sentences need
    # n-1 seams and every cue needs `MIN_CUE_S`, so a chunk shorter than that
    # has no honest arrangement - and refusing HERE names the chunk and the
    # arithmetic, where refusing later (in `build_sentence_vtt`, on an inverted
    # cue) named the symptom.
    needed = MIN_CUE_S * len(sentences)
    if span < needed:
        raise AlignerError(
            f'chunk {chunk_index} is {span:.3f}s and splits into '
            f'{len(sentences)} sentence(s); at a {MIN_CUE_S}s floor per cue '
            f'that needs {needed:.3f}s. The chunk and its text do not match: '
            f'check the render before trusting either.')

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
    previous_end = None
    for position, sentence in enumerate(sentences):
        start = 0.0 if position == 0 else seams[position - 1]
        end = span if position == len(sentences) - 1 else seams[position]
        first, last = ranges[position]
        words = alignment.words[first:last + 1]
        timed = [w for w in words if w.timed]
        # MONOTONIC means both halves of "in order": this cue's own words run
        # forward, AND the cue starts at or after the previous cue ended. The
        # seam arithmetic above guarantees the second for a chunk it did not
        # refuse, so a False here is the FIRST half - a backend that placed a
        # word backwards - which is exactly the thing worth flagging.
        starts = [w.start_s for w in timed]
        monotonic = (starts == sorted(starts)
                     and (previous_end is None or start >= previous_end - 1e-9))
        previous_end = end
        cues.append(SentenceCue(
            chunk_index=chunk_index,
            sentence_index=position,
            start_s=chunk_start_s + start,
            end_s=chunk_start_s + end,
            text=sentence,
            # ONLY THE FIRST SENTENCE IS THE HEADING — the same rule and the same
            # reason as `assemble/sentence_vtt.proportional_cues`, which the gate
            # compares against position by position, so the two must agree.
            is_heading=is_heading and position == 0,
            quality=_cue_quality(alignment, words, start, end, sentence,
                                 monotonic),
        ))
    return tuple(cues)


