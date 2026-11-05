"""THE BUDGET: how much one chunk may carry, per voice. The chunk packer asks this.

Moved here from `engine/protocol.py` on 2026-11-04, BODY UNCHANGED, for the reason
`text/gaps.py` moved down before it: the dependency has to point one way, and
`text/` is the lower layer. The packer is BookForge's - it decides how a book is
cut into chunks - while `engine/` is the model half that is leaving for Crucible
(docs/REORG-PLAN.md, B1). A prep that had to import `narrator.engine` to learn a
chunk's size could not run on a machine without the model code; with the type at
the bottom, prep imports nothing from `engine/` at all.

`engine/protocol.py` re-exports this class rather than keeping a second copy, so
every engine's own budget (`HiggsV3Budget`, `OrpheusBudget`, ...) is still checked
against ONE definition by `tests/test_engine_protocol.py`.

What a prep is HANDED is not one of those engine budgets: it is
`paragraph_packer.CatalogBudget`, built from the numbers the rendering Crucible
states for the voice on `GET /v1/voices`, which BookForge resolves and passes on
the prep argv (`--chunk_max_chars` / `--chunk_floor_chars`).
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Budget(Protocol):
    """How much one chunk may carry, per voice. The chunk packer asks THIS.

    Every method takes `voice` because tuning is keyed on (engine, voice), not
    on voice alone and never on a module constant: deathstalker reads ~23.5 ch/s
    where the Orpheus default guard is 19.0, and a per-voice model has its own
    packed-chunk size in the catalog.
    """

    def max_chars(self, voice=None) -> int:
        """The largest chunk, in characters of text, the packer may build."""

    def max_chars_per_sec(self, voice=None) -> float:
        """Characters of text per second of audio above which the audio is too
        short for the text (0 = no guard)."""

    def max_total_tokens(self, prompt_tokens: int, voice=None) -> int:
        """The largest TOTAL sequence - prompt plus generated - one chunk may
        run to.

        The generation budget is therefore `max_total_tokens(p) - p`. Orpheus's
        audio-token cap is independent of the prompt (3,700 audio tokens
        whatever the prompt costs), so its answer GROWS with the prompt; Higgs's
        8,192-token context is a hard ceiling the prompt eats into, so its
        answer is constant and it refuses a prompt that already fills the
        window. Llasa's 2,048-token wall is what proved both shapes have to be
        expressible here.
        """


__all__ = ['Budget']
