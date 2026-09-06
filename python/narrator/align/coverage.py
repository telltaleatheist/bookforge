"""The coverage guard: did the chunk SAY ALL THE TEXT, and only the text?

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 4:

    The same alignment is the coverage guard: text with no aligned audio =
    dropped / truncated; audio with no text = insertion. It replaces the
    duration-ratio guard, which cannot see a measured 22 % text loss. This is
    the `coverage_check: 'asr'` hook already on the Higgs StopPolicy, made
    concrete: an ALIGNMENT check, not a transcription diff.

WHY A DURATION RATIO CANNOT DO THIS. A v3 chunk was measured at a duration ratio
of 0.99 - a perfect-looking length - while dropping 22 % of its text and
inserting filler to fill the time. Length is conserved; content is not. An
alignment asks a different question: for each WORD of the text the model was
given, is that word actually in this audio, and at what second.

THE THRESHOLDS ARE NOT HERE. They are `assemble/engine_profiles.py`'s
`CoveragePolicy`, per engine, because assembly is what refuses a book on them
and assembly may not import `engine/` or this package. This module measures and
judges against a policy it is handed.

WHAT ASSEMBLY SEES. Nothing of this module: it reads the JSON `coverage_document`
writes. The aligner needs torch and the whisperx env; assembly runs on a CPU env
with neither, spawned by the reassembly bridge with `--tts_engine xtts`. So the
order is: `narrator align --report coverage.json` first, `narrator assemble
--coverage-report coverage.json` second.

THE REPORT DOES NOT BLOCK (Owen, 2026-09-05). It is an AUDIT: assembly reads it,
logs every failing chunk with the text the audio did not say and the retake
command, and then assembles the book. A missing report does not block either.
The refusals that remain are integrity ones - a report about a different book,
a different engine or an older render is refused BY NAME, because believing it
would be reporting on a book nobody measured.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

from ..assemble.coverage_gate import (SUPPORTED_REPORT_VERSION,
                                      CoverageRefusal, report_failures)
from ..assemble.engine_profiles import CoveragePolicy
from .aligner import Alignment, AudioSpan, TextSpan

#: The version of the coverage document. ONE definition, and it lives with the
#: reader: `assemble/coverage_gate.py` is what refuses a book on this document,
#: and a writer that could disagree with its reader about the schema is exactly
#: the bug the constant exists to prevent.
REPORT_VERSION = SUPPORTED_REPORT_VERSION

__all__ = ['ChunkCoverage', 'CoverageRefusal', 'REPORT_VERSION',
           'coverage_document', 'evaluate_chunk', 'report_failures']


@dataclass(frozen=True)
class ChunkCoverage:
    """What the alignment proves about one chunk."""

    index: int
    words_total: int
    words_credible: int
    aligned_ratio: float
    dropped_text: Tuple[TextSpan, ...]
    inserted_audio: Tuple[AudioSpan, ...]
    duration_s: float
    elapsed_s: float
    failed: bool
    reasons: Tuple[str, ...]

    def as_dict(self) -> dict:
        return {
            'index': self.index,
            'wordsTotal': self.words_total,
            'wordsCredible': self.words_credible,
            'alignedRatio': round(self.aligned_ratio, 4),
            'durationSeconds': round(self.duration_s, 3),
            'elapsedSeconds': round(self.elapsed_s, 3),
            'failed': self.failed,
            'reasons': list(self.reasons),
            'droppedText': [
                {'firstWord': s.first_word, 'lastWord': s.last_word,
                 'words': s.words, 'text': s.text,
                 'audioStart': s.audio_start_s, 'audioEnd': s.audio_end_s,
                 'worstScore': s.worst_score}
                for s in self.dropped_text
            ],
            'insertedAudio': [
                {'start': round(s.start_s, 3), 'end': round(s.end_s, 3),
                 'seconds': round(s.duration_s, 3),
                 'speechFraction': round(s.speech_fraction, 3),
                 'where': s.where}
                for s in self.inserted_audio
            ],
        }


def evaluate_chunk(alignment: Alignment, policy: CoveragePolicy, *,
                   index: int) -> ChunkCoverage:
    """One chunk's alignment, judged against one engine's policy.

    THREE MEASUREMENTS, and each maps to a sentence of point 4:

      `aligned_ratio` - the fraction of the chunk's words the aligner placed
      with a score at or above `min_word_score`. This is the headline number.

      `dropped_text` - runs of at least `dropped_run_words` consecutive
      non-credible words. TEXT WITH NO ALIGNED AUDIO. A run, not a count,
      because forced alignment is monotonic: dropped text does not scatter, it
      arrives as a block (usually the tail) crushed into whatever frames are
      left.

      `inserted_audio` - stretches of the chunk's audio at least
      `min_inserted_audio_s` long that no credible word covers AND in which
      somebody was speaking (`speech_fraction` above
      `max_inserted_speech_fraction`). AUDIO WITH NO TEXT. The silence map is
      what keeps an ordinary pause out of this list.
    """
    words = alignment.words
    credible = [w for w in words
                if w.timed and w.score is not None
                and w.score >= policy.min_word_score]
    ratio = (len(credible) / len(words)) if words else 0.0

    dropped = tuple(span for span in alignment.unaligned_text_spans
                    if span.words >= policy.dropped_run_words)
    inserted = tuple(
        span for span in alignment.unaligned_audio_spans
        if span.duration_s >= policy.min_inserted_audio_s
        and span.speech_fraction > policy.max_inserted_speech_fraction
    )

    reasons = []
    uncredible = len(words) - len(credible)
    if ratio < policy.min_aligned_ratio and uncredible >= policy.min_uncredible_words:
        reasons.append(
            f'aligned ratio {ratio:.3f} is below {policy.min_aligned_ratio:.2f} '
            f'({uncredible} of {len(words)} words not credible)')
    if len(dropped) > policy.max_dropped_spans:
        worst = max(dropped, key=lambda s: s.words)
        reasons.append(
            f'{len(dropped)} dropped-text span(s), worst {worst.words} word(s) '
            f'from word {worst.first_word}: {worst.text[:80]!r}')
    for span in inserted:
        reasons.append(
            f'{span.duration_s:.2f}s of {span.where} audio with no text at '
            f'{span.start_s:.2f}s ({span.speech_fraction:.0%} speech)')

    return ChunkCoverage(
        index=index,
        words_total=len(words),
        words_credible=len(credible),
        aligned_ratio=ratio,
        dropped_text=dropped,
        inserted_audio=inserted,
        duration_s=alignment.duration_s,
        elapsed_s=alignment.elapsed_s,
        failed=bool(reasons),
        reasons=tuple(reasons),
    )


def coverage_document(coverages: Sequence[ChunkCoverage], *, engine_id: str,
                      policy: CoveragePolicy, backend: str, language: str,
                      session_id: Optional[str] = None,
                      process_dir: Optional[str] = None,
                      chunks_in_manifest: Optional[int] = None,
                      errors: Optional[Sequence[dict]] = None,
                      skipped: Optional[Sequence[dict]] = None) -> dict:
    """The report `narrator align --report` writes and assembly reads.

    `chunksInManifest` is what makes a STALE report catch itself: assembly
    compares it against the manifest it is about to assemble and refuses a
    report that describes a different book.

    `skipped` is the marker-only chunks - `[break]` rows that speak nothing, so
    there is no alignment to make. They are listed rather than dropped, because
    assembly REPORTS that ALIGNED + SKIPPED + ERRORS accounts for every chunk: a
    chunk nobody looked at must never pass for a chunk that was measured, and
    saying which is which is what makes the audit worth reading.

    `errorIndices` sits beside `failedIndices` because the two are the operator's
    RETAKE LIST and they are different failures - one chunk said the wrong words,
    the other could not be placed at all - and BookForge's Align row quotes both
    on the queue card.
    """
    failed = [c for c in coverages if c.failed]
    ratios = sorted(c.aligned_ratio for c in coverages)
    seconds = sorted(c.elapsed_s for c in coverages)
    return {
        'version': REPORT_VERSION,
        'engine': engine_id,
        'backend': backend,
        'language': language,
        'sessionId': session_id,
        'processDir': process_dir,
        'chunksInManifest': chunks_in_manifest,
        # `audited`, not `enforced`: the report is an audit and no longer blocks
        # anything (Owen, 2026-09-05). Nothing READS this key any more - the
        # gate reports on every report it is given - so it is here for the
        # operator and for a reader of an old report, which still loads.
        'audited': policy.audited,
        'policy': {
            'minWordScore': policy.min_word_score,
            'minAlignedRatio': policy.min_aligned_ratio,
            'minUncredibleWords': policy.min_uncredible_words,
            'droppedRunWords': policy.dropped_run_words,
            'maxDroppedSpans': policy.max_dropped_spans,
            'minInsertedAudioSeconds': policy.min_inserted_audio_s,
            'maxInsertedSpeechFraction': policy.max_inserted_speech_fraction,
        },
        'summary': {
            'chunksAligned': len(coverages),
            'chunksSkipped': len(skipped or ()),
            'chunksFailed': len(failed),
            'failedIndices': [c.index for c in failed],
            'alignedRatioMin': round(ratios[0], 4) if ratios else None,
            'alignedRatioMedian': (round(ratios[len(ratios) // 2], 4)
                                   if ratios else None),
            'secondsPerChunkMedian': (round(seconds[len(seconds) // 2], 3)
                                      if seconds else None),
            'secondsPerChunkMax': round(seconds[-1], 3) if seconds else None,
            'errors': len(errors or ()),
            'errorIndices': sorted({e['index'] for e in (errors or ())}),
        },
        'chunks': [c.as_dict() for c in coverages],
        'errors': list(errors or ()),
        'skipped': list(skipped or ()),
    }


# `report_failures` is imported from `assemble/coverage_gate.py` and re-exported
# above: the reporting is ASSEMBLY's, and it must be reachable from an
# interpreter with no torch in it.
