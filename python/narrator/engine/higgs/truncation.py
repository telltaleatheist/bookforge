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

THE RUNGS ABOVE ARE THE POLICY; WHEN their renders happen is the driver's, and
there are two - `render_guarded` (one chunk, serial, depth-first: the served arm
and every single-chunk path) and `GuardPlan` (many chunks, a ROUND of renders at
a time, so a batch's retakes render as one batch instead of as N solos: the MLX
arm, where a solo re-roll costs a whole batch). Same rungs, same events, same
accept rule under either. See "THE LADDER: ONE POLICY, TWO DRIVERS" below.

WHAT THIS CANNOT SEE, stated: a chunk that repeats a section AND drops the rest
lands near the expected length and passes. Only the ASR coverage audit
(`align/`) sees inside a chunk; this guard is the cheap sensor for the common
shapes (Owen: "this solution will, at least, manage the most common problems").
DURATION IS NOT A COVERAGE PROXY for a dropped span inside a chunk that still
runs long (a v3 render measured ratio 0.99 while dropping 22 % of its text).

THE BAND is two numbers, characters of text per second of audio: above
`max_chars_per_sec` the take is too short, below `min_chars_per_sec` it is too
long. Until 2026-09-08 they were FIXED for the whole book, derived by the
catalog from the voice's ladder pace with 15 % headroom on the ladder's own
tails (p99 x 1.15 / p05 / 1.15). MEASURED on the first full book rendered under
that band (Shift, mistborn, 1,313 chunks, 16.4 h), it was the wrong shape:

  THE BOOK PACES ITSELF. The ladder bank is uniform nonfiction prose; Shift is
  fiction with dialogue, and its clean chunks ran at a median of 14.09 chars/s
  against the bank's 15.12 - 7 % slower. So the fixed band's edges sat at the
  wrong distance from THIS book: the long edge (11.97) fired on 340 healthy
  chunks and re-rolled or split every one of them, while the short edge (19.27)
  sat at 1.37x the book's own pace and let takes at 0.76x of their expected
  length ship (998 chars in 53.6 s), which is the truncation Owen heard.
  TINY CHUNKS SAY NOTHING: a heading is 4-18 characters over a second of
  audio with silence around it (Shift: 274 headings, median 8.3 chars/s), so
  every one of them read as a run-on and the ladder chewed them for nothing.

So (Owen, 2026-09-08: "change the guard to re-render if it deviates too far
from the calculated and recorded characters per second") the band now
FOLLOWS THE BOOK - `PaceTracker`:

  - the catalog still writes the voice's recorded pace and a seed band
    (`paceCharsPerSec`, `maxCharsPerSec` = pace x 1.3, `minCharsPerSec` = pace / 1.3
    - BookForge's PACE_GUARD_SHORT_FACTOR and PACE_GUARD_LONG_FACTOR. The short
    edge was 1.2x until 2026-09-08, when Owen's live MLX Shift run showed it
    re-rolling healthy brisk prose: the tracked pace settled at 13.1 (the slow
    opening chunks seed it, 7 % under the 14.09 shipped median measured below),
    so the edge sat at 15.7 and re-rolled takes at 15.75-16.15 chars/s that came
    back 3-8 % longer with the same words. Every real truncation sat at >= 17.3
    absolute; 1.3 x 13.1 = 17.0. IF THE TRACKER IS EVER RE-SEEDED from the
    shipped median, revisit: 14.09 x 1.3 = 18.3 sits inside the 17.3-18.6
    truncation band. The long side is looser because clean dialogue ran down to
    0.79x. The RATIOS of that seed band are the
    deviation the guard tolerates, and they are the only thing kept from it;
  - the guard's reference is the recorded pace until `PACE_WARMUP_CHUNKS`
    guarded takes have shipped, then the running MEDIAN of the shipped takes'
    own chars/s - the book's calculated pace, which a chunk is judged against;
  - a chunk under `MIN_GUARD_CHARS` is judged on the SHORT side only (a 100-
    character chunk cut in half is still twice too fast) and feeds nothing
    into the running pace.

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
import statistics
import threading
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

#: Under this many characters a chunk is judged on the SHORT side only and
#: does not feed the running pace. The ladder's own clean rule (`chars > 150`)
#: for the same reason: a chunk that short is a heading or a line of dialogue
#: whose seconds are mostly the silence around it (Shift: 281 chunks under
#: 150 chars, median 8.5 chars/s, p99 15.2 - not one over the short edge).
MIN_GUARD_CHARS = 150

#: Guarded takes the tracker sees before its reference moves from the recorded
#: pace to the book's own median. Ten is one batch on the served arm; a median
#: of fewer is one odd chunk.
PACE_WARMUP_CHUNKS = 10


class PaceTracker:
    """The band, re-centred on the book as it renders.

    Built once per engine from the voice's recorded pace and its seed band;
    `band()` is what `render_guarded` judges a take against and `observe()` is
    what it feeds the shipped take back into. Thread-safe: the served arm
    renders a batch on a pool.
    """

    def __init__(self, seed_pace: float, max_chars_per_sec: float,
                 min_chars_per_sec: float, *, warmup: int = PACE_WARMUP_CHUNKS,
                 min_chars: int = MIN_GUARD_CHARS):
        for label, value in (('seed_pace', seed_pace), ('max_chars_per_sec', max_chars_per_sec),
                             ('min_chars_per_sec', min_chars_per_sec)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                raise ValueError(f'PaceTracker: {label} must be a positive number; got {value!r}')
        if not (min_chars_per_sec < seed_pace < max_chars_per_sec):
            raise ValueError(
                f'PaceTracker: the seed band is min < pace < max; got min {min_chars_per_sec}, '
                f'pace {seed_pace}, max {max_chars_per_sec}')
        self.seed_pace = float(seed_pace)
        #: The tolerated deviation, as the seed band's own ratios: the short
        #: edge sits at reference x `short_ratio`, the long edge at
        #: reference / `long_ratio`.
        self.short_ratio = float(max_chars_per_sec) / self.seed_pace
        self.long_ratio = self.seed_pace / float(min_chars_per_sec)
        self.warmup = int(warmup)
        self.min_chars = int(min_chars)
        self._observed: List[float] = []
        self._lock = threading.Lock()

    @property
    def observed(self) -> int:
        with self._lock:
            return len(self._observed)

    @property
    def warm(self) -> bool:
        return self.observed >= self.warmup

    @property
    def reference(self) -> float:
        """The pace a take is judged against: the book's own median once warm,
        the recorded pace before that."""
        with self._lock:
            if len(self._observed) >= self.warmup:
                return statistics.median(self._observed)
        return self.seed_pace

    def band(self) -> dict:
        """Keyword-ready for `render_guarded`, and re-read on EVERY take."""
        ref = self.reference
        return {'max_chars_per_sec': round(ref * self.short_ratio, 2),
                'min_chars_per_sec': round(ref / self.long_ratio, 2)}

    def observe(self, chars: int, seconds: float) -> None:
        """A shipped take. Under `min_chars` it is not a pace measurement."""
        if chars < self.min_chars or seconds <= 0:
            return
        with self._lock:
            self._observed.append(chars / seconds)


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


def tracker_for(voice, default_max: float, default_min: float) -> PaceTracker:
    """The guard's tracker for `voice`: seeded from the voice's own recorded
    pace and band when the catalog measured them (`load_voices._length_band`
    reads all three or none), else from the engine's default band with its
    geometric centre as the pace - the Fuhrer whole-book measurement, not a
    guess. Built ONCE per engine; the band then follows the book."""
    own_pace = getattr(voice, 'pace_chars_per_sec', None)
    own_max = getattr(voice, 'max_chars_per_sec', None)
    own_min = getattr(voice, 'min_chars_per_sec', None)
    if own_pace is not None and own_max is not None and own_min is not None:
        return PaceTracker(float(own_pace), float(own_max), float(own_min))
    return PaceTracker(expected_chars_per_sec(float(default_max), float(default_min)),
                       float(default_max), float(default_min))


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


# ---------------------------------------------------------------------------
# THE LADDER: ONE POLICY, TWO DRIVERS
# ---------------------------------------------------------------------------
# The rungs above are the policy; WHEN their renders happen is the driver's.
# `render_guarded` drives one chunk serially, depth-first - the ladder's own
# order, unchanged, and what the served arm and the single-chunk path use.
# `GuardPlan` drives many chunks a ROUND at a time: every chunk that wants a
# retake asks for one, and the driver renders the whole round in a single batch.
#
# Owen, 2026-09-08 (through the Mac, after his MLX Shift run): "maybe we should
# batch the re-renders. take note of which ones we need to re-render and add
# them to the task list, and batch them at the end. instead of serializing every
# single one. would that be more efficient". MEASURED reason it is: an MLX batch
# of 32 rows costs about the wall time of ONE row, so a solo re-roll costs a
# whole batch - his log slice had 4 re-rolls in ~28 chunks, which roughly
# doubled the run. The served arm has no such asymmetry (a re-roll there is one
# more concurrent POST against a server that batches continuously), which is why
# it keeps the serial driver. Orpheus solved the same problem the same way, in
# `vllm_backend._render_deferred_resplits`.
#
# THE POLICY IS THE SAME UNDER EITHER DRIVER: same rungs in the same order, same
# events, same accept rule, same tracker discipline. Two things do differ under
# the batch driver, and both are stated rather than hidden:
#   - a re-roll is judged against the band AS IT STANDS WHEN ITS ROUND RUNS, by
#     which time the clean chunks of the same batch have shipped and fed the
#     running median. That is the better reference, not a worse one.
#   - a re-roll's sampling comes from its ROUND's batch seed (`reroll_seed` of
#     the round's first chunk) rather than from its own solo seed, because MLX
#     draws one RNG stream per batch. What the rung needs is a draw the first
#     take did not make; both give that, and a batched re-roll is reproducible
#     as a batch - the same guarantee `_generate_delayed_rows_batch` already
#     makes for take 0.


@dataclass(frozen=True)
class RenderRequest:
    """One render the ladder wants next, for the driver to satisfy.

    `text` at `seed` - the two arguments the serial `render(text, seed)`
    callable takes, with None meaning the engine's own seed rule for `index`.
    `path` is the ladder position that asked for it, handed straight back to
    `GuardPlan.offer`.
    """
    path: tuple
    index: int
    text: str
    seed: Optional[int]
    rung: str        # 'take' (take 0) | 'reroll' | 'part' (a split half's take 0)
    depth: int


class _LadderTask:
    """One text unit on the ladder: a chunk, or a half of one after a split.

    Advances exactly one rung per take offered to it. At any moment a task is
    WAITING for a render (`request()` says which), waiting for its children, or
    done.
    """

    def __init__(self, plan, path: tuple, index: int, text: str,
                 depth: int, parent=None):
        self.plan = plan
        self.path = path
        self.index = index
        self.text = text
        self.depth = depth
        self.parent = parent
        self.takes: List[tuple] = []
        self.children: List['_LadderTask'] = []
        self.stage = 'take0'      # take0 -> reroll -> children | accept -> done
        self.base: dict = {}
        self.audio = None
        self.clean = False
        self.done = False

    # -- what it wants next -------------------------------------------------
    def request(self) -> Optional[RenderRequest]:
        if self.stage == 'take0':
            return RenderRequest(self.path, self.index, self.text, None,
                                 'part' if self.depth else 'take', self.depth)
        if self.stage == 'reroll':
            return RenderRequest(self.path, self.index, self.text,
                                 reroll_seed(self.plan.base_seed, self.index, 1),
                                 'reroll', self.depth)
        return None

    # -- one rung -----------------------------------------------------------
    def offer(self, audio) -> None:
        if self.stage not in ('take0', 'reroll'):
            raise RuntimeError(
                f'GuardPlan: chunk {self.index} at {self.path} was handed a take '
                f'while it was waiting on {self.stage}.')
        max_edge, min_edge = self.plan.edges()
        chars = len((self.text or '').strip())
        long_edge = min_edge if chars >= MIN_GUARD_CHARS else 0.0
        verdict = check(self.text, audio, self.plan.sample_rate, max_edge, long_edge)

        if self.stage == 'take0':
            if not verdict.off_length:
                self._finish(audio, True)
                return
            self.takes.append((audio, verdict))
            self.base = {'index': self.index, 'depth': self.depth,
                         'side': verdict.side, **asdict(verdict)}
            if self.plan.tracker is not None:
                # WHAT THE BAND WAS CENTRED ON, so a reader of the log can tell a
                # band still on the recorded pace from one that has moved to the
                # book's.
                self.base['pace'] = round(self.plan.tracker.reference, 2)
                self.base['pace_source'] = ('book' if self.plan.tracker.warm
                                            else 'recorded')
            # Rung 1: the re-roll, at a seed the first take did not use.
            self.plan.on_event({**self.base, 'action': verdict.side, 'rung': 'reroll'})
            self.stage = 'reroll'
            return

        # stage == 'reroll'
        if not verdict.off_length:
            self.plan.on_event({**self.base, 'action': 'rerolled', 'rung': 'reroll',
                                'seconds_after': verdict.seconds})
            self._finish(audio, True)
            return
        self.takes.append((audio, verdict))

        # Rung 2: the split, each half through this same ladder.
        parts = split_halves(self.text) if self.depth < MAX_DEPTH else []
        if parts:
            self.plan.on_event({**self.base, 'action': 'resplit', 'rung': 'split',
                                'reroll_side': verdict.side,
                                'parts': [len(p) for p in parts]})
            self.stage = 'children'
            self.children = [self.plan.child(self, position, part)
                             for position, part in enumerate(parts)]
            return
        self._accept(max_edge, min_edge)

    # -- rung 3 -------------------------------------------------------------
    def _accept(self, max_edge: float, min_edge: float) -> None:
        """The take closest to the expected length ships, and the event says so:
        the render never refuses (Owen, 2026-09-05), and the coverage audit
        names the chunk."""
        centre = expected_chars_per_sec(max_edge, min_edge)
        best, best_verdict = min(
            self.takes,
            key=lambda tv: abs(math.log(max(tv[1].chars_per_second, 1e-9)) - math.log(centre))
            if tv[1].chars_per_second != float('inf') else float('inf'))
        self.plan.on_event({**self.base, 'action': 'accepted-off-length', 'rung': 'accept',
                            'shipped_side': best_verdict.side,
                            'seconds_shipped': best_verdict.seconds,
                            'why': ('at MAX_DEPTH' if self.depth >= MAX_DEPTH
                                    else 'text cannot be split')})
        self._finish(best, False)

    def _finish(self, audio, clean: bool) -> None:
        self.audio = audio
        self.clean = bool(clean)
        self.stage = 'done'
        self.done = True
        if self.parent is None:
            self.plan.finish_root(self)
            return
        siblings = self.parent.children
        if all(child.done for child in siblings):
            self.parent._finish(
                join_parts([child.audio for child in siblings], self.plan.sample_rate),
                all(child.clean for child in siblings))


class GuardPlan:
    """Chunks through the ladder, a ROUND of renders at a time.

    The batch driver's loop:

        plan = GuardPlan(sample_rate=..., base_seed=..., tracker=...)
        for index, text, take0 in batch:       # take 0 the engine already has
            plan.add(index, text, first_take=take0)
        ship(plan.finished())                  # everything take 0 got right
        while True:
            requests = plan.round()            # every retake the guard wants
            if not requests:
                break
            for request, audio in zip(requests, render_as_one_batch(requests)):
                plan.offer(request, audio)
            ship(plan.finished())

    `round()` is ordered by ladder position, so a driver that takes only its
    FIRST request walks the ladder depth-first - which is exactly what
    `render_guarded` does, and why the two drivers cannot drift apart.

    NOT THREAD-SAFE, deliberately: one plan belongs to one batch on one thread.
    The `PaceTracker` it feeds is the shared, locked one.
    """

    def __init__(self, *, sample_rate: int, base_seed: Optional[int],
                 tracker: Optional[PaceTracker] = None,
                 max_chars_per_sec: float = 0.0, min_chars_per_sec: float = 0.0,
                 on_event: Callable[[dict], None] = emit_event):
        self.sample_rate = int(sample_rate)
        self.base_seed = base_seed
        self.tracker = tracker
        self.fixed = (float(max_chars_per_sec), float(min_chars_per_sec))
        self.on_event = on_event
        self._tasks: dict = {}
        self._added = 0
        self._finished: List[tuple] = []

    # -- the band -----------------------------------------------------------
    def edges(self) -> tuple:
        """`(max_chars_per_sec, min_chars_per_sec)` for a take being judged NOW:
        the tracker's, read fresh, or the fixed pair when there is no tracker."""
        if self.tracker is None:
            return self.fixed
        band = self.tracker.band()
        return band['max_chars_per_sec'], band['min_chars_per_sec']

    # -- building -----------------------------------------------------------
    def add(self, index: int, text: str, first_take=None) -> None:
        """A chunk onto the ladder. `first_take` is take 0 when the caller
        already has it (every batch path), so it is never rendered twice."""
        task = _LadderTask(self, (self._added,), int(index), text, 0)
        self._tasks[task.path] = task
        self._added += 1
        if first_take is not None:
            task.offer(first_take)

    def child(self, parent, position: int, text: str):
        """A split half. Its path sorts INSIDE its parent's, so depth-first
        order falls out of sorting the pending tasks."""
        task = _LadderTask(self, parent.path + (position,), parent.index, text,
                           parent.depth + 1, parent=parent)
        self._tasks[task.path] = task
        return task

    # -- the round ----------------------------------------------------------
    def round(self) -> List[RenderRequest]:
        """Every render the ladder is waiting on, in ladder order. Empty once
        every chunk added has been decided."""
        requests = []
        for path in sorted(self._tasks):
            request = self._tasks[path].request()
            if request is not None:
                requests.append(request)
        return requests

    def offer(self, request: RenderRequest, audio) -> None:
        """The audio for one of `round()`'s requests."""
        task = self._tasks.get(request.path)
        if task is None:
            raise KeyError(f'GuardPlan.offer: no task at {request.path}')
        task.offer(audio)

    def finish_root(self, task) -> None:
        """A whole chunk is decided. THE SHIPPED TAKE FEEDS THE TRACKER ONLY
        WHEN IT IS CLEAN - an `accepted-off-length` take is a defect the ladder
        could not fix, and feeding it back would pull the reference toward the
        defect (Owen's worry, 2026-09-08: a truncation in the earliest chunks).
        """
        if self.tracker is not None and task.clean:
            self.tracker.observe(len((task.text or '').strip()),
                                 float(len(task.audio)) / float(self.sample_rate))
        self._finished.append((task.index, task.audio, task.clean))

    def finished(self) -> List[tuple]:
        """`(index, audio, clean)` for every chunk decided since the last call.
        Drains, so a driver ships as it goes."""
        out, self._finished = self._finished, []
        return out

    @property
    def pending(self) -> int:
        """Chunks still on the ladder."""
        return sum(1 for task in self._tasks.values()
                   if task.parent is None and not task.done)


def render_guarded(render: Callable[[str, Optional[int]], np.ndarray],
                   text: str, index: int, *, sample_rate: int,
                   base_seed: Optional[int],
                   max_chars_per_sec: float = 0.0,
                   min_chars_per_sec: float = 0.0,
                   tracker: Optional[PaceTracker] = None,
                   first_take: Optional[np.ndarray] = None,
                   on_event: Callable[[dict], None] = emit_event) -> np.ndarray:
    """The ladder, ONE chunk, driven serially. `render(text, seed)` is the
    engine's own single render (seed None = the engine's seed rule for `index`);
    `first_take` is take 0 when the caller already has it, so it is never
    rendered twice. Returns the audio to ship.

    THE BAND is the `tracker`'s when one is given - read fresh for every take,
    so a re-roll is judged against the same book pace the take before it was -
    and the fixed `max_chars_per_sec` / `min_chars_per_sec` pair otherwise (the
    tests, and any caller that wants a band that does not move). A chunk under
    `MIN_GUARD_CHARS` is judged on the short side only, either way.

    Taking `round()[0]` every time is what makes this DEPTH-FIRST: a split's
    left half is finished before its right half is begun, which is the order
    the ladder has always rendered and logged in. `GuardPlan` is the same
    policy with every waiting chunk rendered together instead.
    """
    plan = GuardPlan(sample_rate=sample_rate, base_seed=base_seed, tracker=tracker,
                     max_chars_per_sec=max_chars_per_sec,
                     min_chars_per_sec=min_chars_per_sec, on_event=on_event)
    plan.add(index, text, first_take=first_take)
    while True:
        requests = plan.round()
        if not requests:
            break
        request = requests[0]
        plan.offer(request, render(request.text, request.seed))
    decided = plan.finished()
    if len(decided) != 1:
        raise RuntimeError(
            f'render_guarded: the ladder decided {len(decided)} chunks for one call.')
    return decided[0][1]
