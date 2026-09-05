"""What each engine leaves at a chunk edge, and what assembly must do about it.

THE TABLE LIVES HERE, not in `render/session_v1.py`, because these are facts
about ASSEMBLY - how a chunk has to be treated before it can be joined to the
next one - not facts about a session directory. The session reader only knows
which engine rendered the book; it asks this table what that implies.

TWO ENGINES, TWO CONTRACTS:

  orpheus   PADS. The engine bakes the inter-chunk silence into every chunk's
            own audio (`_classify_gap` -> `_save_audio`), and it trims and pads
            its own edges, so a chunk's FLAC is already the complete unit. The
            assembler concatenates and does nothing else: no fade, no inserted
            silence, gaps must be 0.

  higgs-v3  NO PADS. The engine emits bare speech. Two consequences, both the
            assembler's problem:
              - the inter-chunk silence is not in the audio; it is in the
                manifest's gapBefore/gapAfter and assembly must realize it.
              - after the codec's sentinel run is content-trimmed the chunk edge
                still sits around -30 dB, which CLICKS on a join. A 10 ms
                fade-in and a 25 ms fade-out take it to -45..-48 dB (measured by
                the training side, 2026-09-04).

The fade is asymmetric on purpose: a chunk begins on an attack the ear expects
and ends on a decay the ear does not, so the tail needs more than twice the
window the head does.

WHERE THESE NUMBERS COME FROM, AND WHY THEY ARE HERE TWICE. `engine/protocol.py`
declares `pads: bool` and `edge_fade: EdgeFade(in_ms, out_ms)` on the engine
itself, which is the right home - they are properties of the codec's edges, and
that type now expresses the asymmetry exactly (Higgs 10 in / 25 out; an earlier
draft had a single float, which could not).

THE DUPLICATE IS DELIBERATE AND STAYS: **assembly must not import `engine/`.**
Assembly runs on machines with no torch, no transformers and no engine
environment at all - the reassembly bridge spawns it with `--tts_engine xtts`
against a bundled CPU env - so it cannot ask an engine object what its edges
need. Importing one to read two numbers would drag a GPU stack into the one part
of the pipeline that is deliberately free of it.

What keeps the two copies honest is a TEST, not a convention:
`tests/test_engine_protocol.py::test_the_engines_agree_with_the_assemblers_own_table`
loads THIS module by path and asserts `pads`, `fade_in_ms` and `fade_out_ms`
equal each engine's own `pads` and `edge_fade`. A divergence is an audiobook
that clicks at every join, so it fails the suite instead.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CoveragePolicy:
    """What a forced alignment has to show before a chunk counts as SPOKEN.

    `docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 4: the
    alignment replaces the duration-ratio guard, which cannot see a measured
    22 % text loss (a v3 chunk scored a duration ratio of 0.99 while dropping a
    fifth of its text and inserting filler). `align/coverage.py` applies these;
    they live HERE because they are per-engine data and because assembly - which
    refuses a book on them - must not import `engine/` or `align/`.

    EVERY NUMBER WAS MEASURED, on the kershaw golden session, CPU, 2026-09-05;
    `align/README.md` carries the distributions. In outline: a correctly
    rendered chunk puts 2 % of its words under a 0.4 alignment score, while a
    sentence the audio never says puts 91 % of ITS words there, and a truncated
    tail puts 94-100 % there. So the score is the discriminator and the RUN
    LENGTH is what keeps the two apart.

    enforced             True when a failed chunk REFUSES assembly. Higgs v3 has
                         no duration guard worth the name, so this is its only
                         proof the book was read. Orpheus keeps its chars/sec
                         guard and its resplit ladder, so coverage there is
                         measured and REPORTED and never blocks - turning it on
                         for Orpheus would re-litigate a guard that already
                         works, on a corpus nobody has swept.
    min_word_score       below this an aligned word is not credible.
    min_aligned_ratio    the fraction of a chunk's words that must clear it.
    min_uncredible_words how many words must be non-credible before the RATIO
                         test may fire at all. Three, because a ratio is a bad
                         instrument on a short chunk: measured on kershaw, a
                         15-word chunk with ONE weak word scores 0.933 and a
                         10-word chunk with one scores 0.900 - at the threshold
                         - while the 38-word chunk that genuinely needed
                         flagging had five. Without this floor the guard would
                         punish chunks for being short.
    dropped_run_words    consecutive non-credible words that make a DROPPED TEXT
                         span. Six: at a 2 % per-word false rate a run of six is
                         a 1-in-10^10 accident, while real dropped text runs to
                         tens of words.
    max_dropped_spans    dropped-text spans a chunk may have and still pass.
                         Zero for Higgs: point 4 says text with no aligned audio
                         is a truncation, and a truncated chunk is re-rendered.
    min_inserted_audio_s a stretch of unexplained audio shorter than this is a
                         breath, a page turn or a codec edge, not an insertion.
    max_inserted_speech_fraction
                         how much of such a stretch may be SPEECH before it
                         counts. A pause is silent; an inserted word is not.
    """

    enforced: bool
    min_word_score: float
    min_aligned_ratio: float
    min_uncredible_words: int
    dropped_run_words: int
    max_dropped_spans: int
    min_inserted_audio_s: float
    max_inserted_speech_fraction: float


#: Orpheus: MEASURED AND REPORTED, never blocking. The thresholds are the same
#: measured numbers, so the report reads the same on both engines and a sweep
#: can compare them.
ORPHEUS_COVERAGE = CoveragePolicy(
    enforced=False,
    min_word_score=0.4,
    min_aligned_ratio=0.90,
    min_uncredible_words=3,
    dropped_run_words=6,
    max_dropped_spans=0,
    min_inserted_audio_s=1.0,
    max_inserted_speech_fraction=0.35,
)

#: Higgs v3: the guard. `StopPolicy.coverage_check == 'asr'` made concrete - an
#: ALIGNMENT check, not a transcription diff.
HIGGS_V3_COVERAGE = CoveragePolicy(
    enforced=True,
    min_word_score=0.4,
    min_aligned_ratio=0.90,
    min_uncredible_words=3,
    dropped_run_words=6,
    max_dropped_spans=0,
    min_inserted_audio_s=1.0,
    max_inserted_speech_fraction=0.35,
)


@dataclass(frozen=True)
class EngineProfile:
    """How assembly must treat one engine's chunks."""

    id: str
    #: True when the engine BAKES the inter-chunk silence into each chunk's
    #: audio. False when it emits bare speech and the assembler must realize the
    #: manifest's gaps itself.
    pads: bool
    #: Fade applied to the head of every chunk, in milliseconds.
    fade_in_ms: float
    #: Fade applied to the tail of every chunk, in milliseconds.
    fade_out_ms: float
    #: What a post-render forced alignment must show before a chunk counts as
    #: spoken, and whether a failure refuses the book.
    coverage: CoveragePolicy = ORPHEUS_COVERAGE

    @property
    def needs_processing(self) -> bool:
        """True when a chunk cannot go into the concat list as it is."""
        return not self.pads


#: Every engine assembly knows how to join. Adding one is a row here and a test.
PROFILES: dict[str, EngineProfile] = {
    "orpheus": EngineProfile("orpheus", pads=True, fade_in_ms=0.0, fade_out_ms=0.0,
                             coverage=ORPHEUS_COVERAGE),
    "higgs-v3": EngineProfile("higgs-v3", pads=False, fade_in_ms=10.0, fade_out_ms=25.0,
                              coverage=HIGGS_V3_COVERAGE),
}

#: What a manifest with no `engine` block means. Every manifest written before
#: the block existed came from an e2a Orpheus session, so the absent case is
#: Orpheus semantics: padded chunks, no fade, gaps must be zero.
DEFAULT_PROFILE = PROFILES["orpheus"]


def profile_for(engine_id: str) -> EngineProfile:
    """The profile for an engine id. Raises on one we have no edge contract for.

    NO FALLBACKS. Guessing `pads=True` for an unknown engine ships an audiobook
    that clicks at every one of its joins and is missing every gap; guessing
    `pads=False` fades and re-spaces audio that was already correct. Neither is
    a thing to decide silently on the strength of a string we do not recognize.
    """
    profile = PROFILES.get(engine_id)
    if profile is None:
        raise KeyError(
            f"no assembly profile for engine {engine_id!r} - assembly does not know "
            f"whether its chunks carry their own pads or need fades and gaps "
            f"(known: {', '.join(sorted(PROFILES))})"
        )
    return profile
