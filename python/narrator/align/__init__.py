"""Post-render forced alignment: sentence-level cues and the coverage guard.

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", points 3 and 4. The
design, the backend measurement and the thresholds are in `README.md` beside
this file; read that before changing a number here.

Nothing in this package is imported by `assemble/` or `engine/`: the aligner
needs torch and the whisperx env, and assembly runs on a machine with neither.
Assembly reads the coverage REPORT this package writes, never this package.
"""

from .aligner import (BACKENDS, DEFAULT_BACKEND, SCORE_SOURCE_BY_BACKEND,
                      SCORE_SOURCES, AlignedWord, Alignment, AlignerError,
                      AudioSpan, TextSpan, align_chunk, decode_audio,
                      detect_silences)
from .coverage import (ChunkCoverage, CoverageRefusal, coverage_document,
                       evaluate_chunk, report_failures)
from .sentences import (QUALITY_NOTE_KEYS, SentenceCue, build_sentence_vtt,
                        proportional_cues, sentence_cues,
                        split_chunk_sentences, write_sentence_vtt)
# The corpus cutter's door: one window of audio, one piece of text, no session.
from .window import align_text_window

__all__ = [
    'AlignedWord',
    'Alignment',
    'AlignerError',
    'AudioSpan',
    'BACKENDS',
    'ChunkCoverage',
    'CoverageRefusal',
    'DEFAULT_BACKEND',
    'QUALITY_NOTE_KEYS',
    'SCORE_SOURCES',
    'SCORE_SOURCE_BY_BACKEND',
    'SentenceCue',
    'TextSpan',
    'align_chunk',
    'align_text_window',
    'build_sentence_vtt',
    'coverage_document',
    'decode_audio',
    'detect_silences',
    'evaluate_chunk',
    'proportional_cues',
    'report_failures',
    'sentence_cues',
    'split_chunk_sentences',
    'write_sentence_vtt',
]
