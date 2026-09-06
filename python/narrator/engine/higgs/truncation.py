"""The Higgs LENGTH guard: watch every chunk's audio against its text, and
re-render the ones that stopped early OR ran on - a seed change first, then the
chunk split at sentence boundaries. Shared by BOTH arms (served and MLX).

Owen, 2026-09-06: "im seeing the occasional truncation. we should watch for
truncations from higgs the same way we do in orpheus and re-render the split
sentences if one appears." And, the same evening, after the whole-book coverage
report: "deterministic solutions are not the right shape for this. i think we
need to detect the expected length and if it steps outside those bounds then
we split at sentence boundaries and re-render. same as orpheus."

MEASURED, the cases this exists for (Working Towards The Fuhrer, PC, SGLang,
deathstalker ckpt-1080, 2026-09-06 15:26, 49 chunks at 1,200; session pace
5.83 s per 100 characters = 17.2 chars/s; every clean chunk sat between 0.94x
and 1.10x of that expectation):

  TOO SHORT  chunk 19: 1,127 characters, 3.0 s of audio (375 chars/s) - it
             stopped at the end of its FIRST sentence and the render reported
             success. Training's live validation of the same book had flagged
             the same chunk; narrator seeds chunk i at `seed + i`, so an early
             stop REPRODUCES at its seed, and a retake at the same seed is not
             a retake. Chunk 32: the last 25 words never spoken, 0.84x.
  TOO LONG   chunks 48, 35, 26, 41: the text was read (aligned ratios 0.878,
             0.954, 1.000, 0.994) and then the model KEPT TALKING - 27.3 s,
             26.0 s, 8.8 s and 6.8 s of speech past the end of the text, at
             1.54x, 1.42x, 1.24x and 1.11x of expectation - and that audio
             shipped in the m4b. Training (field notes 4n.28): late-chunk EOS
             failures at temperature 1.0 - once the EOS draw is lost with no
             text left, the model is off-distribution and continues.

So on that render the run-on class (4) outnumbered the early-stop class (3),
and both are LENGTH defects: audio that is not the length its text should be.
`StopPolicy.max_chars_per_sec` (20.0, the short side) had named a threshold
since the engine landed and nothing enforced it; `min_chars_per_sec` (the long
side) is new with this module.

THE LADDER, per chunk, in order, for either side:

  take 0   the engine's own render (its seed rule: `seed + index`).
           Inside the band -> shipped, no event.
  take 1   RE-ROLL at a different seed (`reroll_seed`). Orpheus's finding
           (memory: orpheus-short-chunk-repeat) was that the re-roll backstop,
           not the EOS boost, is what fixes an early stop; the same holds for
           a run-on, because both are one lost sampling draw.
  split    the chunk cut into two halves at the sentence boundary nearest its
           middle, each half rendered through this same ladder (a half that
           misbehaves gets its own re-roll and its own split), joined with
           `RESPLIT_JOIN_SECONDS` of silence - the pause a sentence boundary
           inside one paragraph gets. This is Orpheus's `_generate_audio_vllm_safe`
           shape, and Owen's stated practice.
  accept   at `MAX_DEPTH`, or when the text cannot be split, the take whose
           length is CLOSEST to expectation is shipped and the event says
           `accepted-off-length` - the render never refuses, because assembly
           is built on the expected text and the real audio length (Owen's
           2026-09-05 ruling), and the coverage audit names the chunk.

WHAT THIS CANNOT SEE, stated: a chunk that repeats a section AND drops the rest
lands near the expected length and passes. Only the ASR coverage audit
(`align/`) sees inside a chunk; this guard is the cheap sensor for the common
shapes (Owen: "this solution will, at least, manage the most common problems").
DURATION IS NOT A COVERAGE PROXY for a dropped span inside a chunk that still
runs long (a v3 render measured ratio 0.99 while dropping 22 % of its text).

THE BAND is two numbers the policy carries, characters of text per second of
audio: above `max_chars_per_sec` the take is too short, below
`min_chars_per_sec` it is too long. At 17.2 chars/s book pace, 20.0 fires at
~0.86x and 14.5 at ~1.19x of expectation - outside every clean chunk of the
measured render (0.94x-1.10x), inside three of its four run-ons (the 6.8 s one
at 1.11x is left to the audit) and both early stops.

EVERY FIRE IS REPORTED: a log line a person can read and one parseable line,
`[HIGGS3][HIGGS_GUARD_EVENT] {json}`, the shape and prefix discipline of
Orpheus's `[ORPHEUS][ORPHEUS_GUARD_EVENT]` so the bridge's analytics count them
the same way. Every event carries the TAKE-0 verdict (chars, seconds,
chars_per_second, both thresholds) whatever rung it fired on, so the model's
raw off-length rate per voice is readable from the counts without re-rendering
(training's ask).
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, asdict
from typing import Callable, List, Optional

import numpy as np

from ..log import log

#: Silence between the halves of a re-split chunk. A sentence boundary inside a
#: paragraph; the same length `v3_served.REFERENCE_JOIN_SECONDS` uses between
#: joined reference clips, chosen for the same reason (a natural pause, not a
#: gap).
RESPLIT_JOIN_SECONDS = 0.35

#: How deep the split ladder goes: 3 halvings turn a 1,200-character chunk into
#: ~150-character parts, well inside any Higgs voice's measured safe zone.
#: Orpheus's ladder uses the same depth.
MAX_DEPTH = 3

#: A part shorter than this is not split further - two fragments of a
#: sentence are worse than one short take. Orpheus's ladder uses 80.
MIN_SPLIT_CHARS = 80

#: The re-roll's seed offset. Large and odd so `seed + index + STRIDE` never
#: collides with another chunk's own seed inside any book.
REROLL_SEED_STRIDE = 100_003

#: The parseable prefix. LOAD-BEARING for the bridge's event parser.
GUARD_EVENT_PREFIX = '[HIGGS3][HIGGS_GUARD_EVENT] '


@dataclass(frozen=True)
class LengthVerdict:
    chars: int
    seconds: float
    chars_per_second: float
    max_chars_per_sec: float   # above this: too SHORT (0 disables)
    min_chars_per_sec: float   # below this: too LONG  (0 disables)

    @property
    def short(self) -> bool:
        return self.max_chars_per_sec > 0 and self.chars_per_second > self.max_chars_per_sec

    @property
    def long(self) -> bool:
        return (self.min_chars_per_sec > 0 and self.chars > 0
                and self.chars_per_second < self.min_chars_per_sec)

    @property
    def off_length(self) -> bool:
        return self.short or self.long

    @property
    def side(self) -> Optional[str]:
        return 'short' if self.short else ('long' if self.long else None)


def check(text: str, audio, sample_rate: int, max_chars_per_sec: float,
          min_chars_per_sec: float = 0.0) -> LengthVerdict:
    """Is `audio` the wrong length for `text`? Characters per second against
    the band; a threshold of 0 disables that side."""
    chars = len((text or '').strip())
    seconds = float(len(audio)) / float(sample_rate) if audio is not None else 0.0
    cps = (chars / seconds) if seconds > 0 else float('inf')
    return LengthVerdict(chars=chars, seconds=round(seconds, 3),
                         chars_per_second=round(cps, 2) if cps != float('inf') else cps,
                         max_chars_per_sec=float(max_chars_per_sec),
                         min_chars_per_sec=float(min_chars_per_sec))


def band_for(voice, default_max: float, default_min: float) -> dict:
    """The guard's band for `voice`: the voice's own `max_chars_per_sec` /
    `min_chars_per_sec` when the catalog derived them from a measured pace,
    else the engine defaults. Keyword-ready for `render_guarded`."""
    own_max = getattr(voice, 'max_chars_per_sec', None)
    own_min = getattr(voice, 'min_chars_per_sec', None)
    if own_max is not None and own_min is not None:
        return {'max_chars_per_sec': float(own_max), 'min_chars_per_sec': float(own_min)}
    return {'max_chars_per_sec': float(default_max), 'min_chars_per_sec': float(default_min)}


def expected_chars_per_sec(max_chars_per_sec: float, min_chars_per_sec: float) -> float:
    """The band's centre - the geometric mean of its two edges, or whichever
    edge exists. What `accept` measures a take's distance from."""
    if max_chars_per_sec > 0 and min_chars_per_sec > 0:
        return math.sqrt(max_chars_per_sec * min_chars_per_sec)
    return max_chars_per_sec or min_chars_per_sec


def reroll_seed(base_seed: Optional[int], index: int, attempt: int) -> Optional[int]:
    """The seed for re-roll `attempt` (1-based) of chunk `index`. None stays
    None - an unseeded engine samples fresh anyway, which IS the re-roll."""
    if base_seed is None:
        return None
    return int(base_seed) + int(index) + REROLL_SEED_STRIDE * int(attempt)


def split_halves(text: str) -> List[str]:
    """`text` as two parts cut at the sentence boundary nearest its middle, or
    at the space nearest the middle when it is one sentence. `[]` when it
    cannot be split into two parts of at least `MIN_SPLIT_CHARS` each."""
    from ...text.paragraph_packer import split_sentences
    text = (text or '').strip()
    if len(text) < 2 * MIN_SPLIT_CHARS:
        return []
    sentences = [s for s in split_sentences(text) if s.strip()]
    if len(sentences) >= 2:
        best, best_gap = None, None
        total = len(text)
        running = 0
        for i in range(1, len(sentences)):
            running += len(sentences[i - 1]) + 1
            gap = abs(running - total / 2)
            if best_gap is None or gap < best_gap:
                best, best_gap = i, gap
        left = ' '.join(sentences[:best]).strip()
        right = ' '.join(sentences[best:]).strip()
    else:
        mid = len(text) // 2
        cut = text.rfind(' ', 0, mid)
        if cut < 0:
            cut = text.find(' ', mid)
        if cut < 0:
            return []
        left, right = text[:cut].strip(), text[cut:].strip()
    if len(left) < MIN_SPLIT_CHARS or len(right) < MIN_SPLIT_CHARS:
        return []
    return [left, right]


def join_parts(parts: List[np.ndarray], sample_rate: int) -> np.ndarray:
    """The halves, with `RESPLIT_JOIN_SECONDS` of silence between them."""
    gap = np.zeros(int(round(RESPLIT_JOIN_SECONDS * sample_rate)), dtype=np.float32)
    out: List[np.ndarray] = []
    for i, part in enumerate(parts):
        if i:
            out.append(gap)
        out.append(np.asarray(part, dtype=np.float32))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


def emit_event(record: dict) -> None:
    """One human line and one parseable line per guard fire."""
    log(f"[HIGGS3] length guard: chunk {record.get('index')} {record.get('action')} - "
        f"{record.get('chars')} chars in {record.get('seconds')} s "
        f"({record.get('chars_per_second')} chars/s; band {record.get('min_chars_per_sec')}"
        f"-{record.get('max_chars_per_sec')})"
        + (f" depth {record['depth']}" if record.get('depth') else ''), flush=True)
    log(GUARD_EVENT_PREFIX + json.dumps(record, ensure_ascii=False), flush=True)


def render_guarded(render: Callable[[str, Optional[int]], np.ndarray],
                   text: str, index: int, *, sample_rate: int,
                   max_chars_per_sec: float, base_seed: Optional[int],
                   min_chars_per_sec: float = 0.0,
                   first_take: Optional[np.ndarray] = None,
                   depth: int = 0,
                   on_event: Callable[[dict], None] = emit_event) -> np.ndarray:
    """The ladder. `render(text, seed)` is the engine's own single render
    (seed None = the engine's seed rule for `index`); `first_take` is take 0 when
    the caller already has it (the MLX batch path), so it is never rendered twice.
    Returns the audio to ship."""
    def verdict_of(audio):
        return check(text, audio, sample_rate, max_chars_per_sec, min_chars_per_sec)

    take0 = first_take if first_take is not None else render(text, None)
    verdict = verdict_of(take0)
    if not verdict.off_length:
        return take0
    takes = [(take0, verdict)]
    base = {'index': index, 'depth': depth, 'side': verdict.side, **asdict(verdict)}

    # Rung 1: the re-roll, at a seed the first take did not use.
    on_event({**base, 'action': verdict.side, 'rung': 'reroll'})
    take1 = render(text, reroll_seed(base_seed, index, 1))
    verdict1 = verdict_of(take1)
    if not verdict1.off_length:
        on_event({**base, 'action': 'rerolled', 'rung': 'reroll',
                  'seconds_after': verdict1.seconds})
        return take1
    takes.append((take1, verdict1))

    # Rung 2: the split, each half through the same ladder.
    parts = split_halves(text) if depth < MAX_DEPTH else []
    if parts:
        on_event({**base, 'action': 'resplit', 'rung': 'split',
                  'reroll_side': verdict1.side, 'parts': [len(p) for p in parts]})
        rendered = [render_guarded(render, part, index, sample_rate=sample_rate,
                                   max_chars_per_sec=max_chars_per_sec,
                                   min_chars_per_sec=min_chars_per_sec,
                                   base_seed=base_seed, depth=depth + 1,
                                   on_event=on_event)
                    for part in parts]
        return join_parts(rendered, sample_rate)

    # Rung 3: accept the take closest to the expected length, and say so.
    centre = expected_chars_per_sec(max_chars_per_sec, min_chars_per_sec)
    best, best_verdict = min(
        takes, key=lambda tv: abs(math.log(max(tv[1].chars_per_second, 1e-9)) - math.log(centre))
        if tv[1].chars_per_second != float('inf') else float('inf'))
    on_event({**base, 'action': 'accepted-off-length', 'rung': 'accept',
              'shipped_side': best_verdict.side,
              'seconds_shipped': best_verdict.seconds,
              'why': ('at MAX_DEPTH' if depth >= MAX_DEPTH else 'text cannot be split')})
    return best
