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

    @property
    def needs_processing(self) -> bool:
        """True when a chunk cannot go into the concat list as it is."""
        return not self.pads


#: Every engine assembly knows how to join. Adding one is a row here and a test.
PROFILES: dict[str, EngineProfile] = {
    "orpheus": EngineProfile("orpheus", pads=True, fade_in_ms=0.0, fade_out_ms=0.0),
    "higgs-v3": EngineProfile("higgs-v3", pads=False, fade_in_ms=10.0, fade_out_ms=25.0),
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
