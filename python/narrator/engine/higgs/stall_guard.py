"""The Higgs stall guard: a row stuck on one silence code is nudged off it.

Owen, 2026-10-02 (training-pc, then crucible-pc): a runaway silence. Codebook 0
repeats a silence code frame after frame, and top-k / top-p cut every exit token
to zero, so nothing in the sampler can ever leave it - Mistborn MM02 rendered 90 s
with 98 % of frames identical to the one before. The render-door pause cap
(`serve/pause_cap.py`) makes such a chunk listenable after the fact; this keeps
the model from getting stuck in the first place. training-pc's prototype on the
sglang stack took the no-bed Mistborn A/B from 5 pauses over 5 s to 0, and the
longest pause from 108.6 s to 4.7 s, with coverage unchanged. The ring buffer
below is the refinement meant to bring 4.7 s toward 2 s.

THE CONTRACT, identical on every stack that implements it (crucible-pc owns the
Crucible side and the PC sglang-omni patch; this file is the MLX arm):

  HIGGS_STALL_GUARD="<frames>,<rate>,<max>,<window>"  read ONCE, at engine start.
  Unset or `off` = no guard. Crucible always sets it explicitly; the recommended
  value is "37,0.5,20,8". A malformed value is a startup error naming the
  variable.

  Per row: a ring R of the last <window> sampled codebook-0 codes, and `run`.

  Each frame, BEFORE temperature / top-k / top-p (so greedy is covered too), for
  a row that is active, past the delay window and not winding down after EOC:
  if run > frames, the cb0 logit of every code in R is lowered by
  min(max, rate * (run - frames)). Nothing is forced: the model's own next
  choice takes over.

  AFTER sampling, on a STEADY step (the row was counted, and this step did not
  finish it): run += 1 if the cb0 code is already in R, else run = 0; the code
  is pushed into R, evicting the oldest. On a step that is NOT steady - the
  delay window, the EOC wind-down, the step that finishes the row - run = 0 and
  R is emptied (crucible-pc, 2026-10-02: RESET), so a wind-down never carries a
  penalty and a new row starts clean. That is ONE line in `observe` to flip.

COST. Only cb0, and only for a row whose run is past `frames`: a row that is not
stalling touches no logits at all, and a stalling one scatters into at most
<window> entries - never a full-codebook bias per step, which is what cost the
prototype ~11 % of its speed.

PURE PYTHON. No mlx here, so the arithmetic is tested with fake logits on any
machine; `mlx_backend` does the one scatter.
"""

from __future__ import annotations

import os
from collections import deque
from dataclasses import dataclass

ENV = 'HIGGS_STALL_GUARD'
#: The value Crucible sets (crucible-pc, 2026-10-02). Stated for the docs and the
#: tests; an UNSET variable is OFF, never this.
RECOMMENDED = '37,0.5,20,8'


@dataclass(frozen=True)
class StallGuard:
    """The guard's four numbers."""
    frames: int
    rate: float
    max: float
    window: int

    def penalty(self, run: int) -> float:
        """How far each code in R is lowered for a row at `run`; 0 at or below `frames`."""
        if run <= self.frames:
            return 0.0
        return min(self.max, self.rate * (run - self.frames))


def stall_guard_from_env(environ=None) -> StallGuard | None:
    """The guard `HIGGS_STALL_GUARD` asks for, None when unset or `off`."""
    env = os.environ if environ is None else environ
    raw = (env.get(ENV) or '').strip()
    if raw == '' or raw.lower() == 'off':
        return None
    parts = [p.strip() for p in raw.split(',')]
    if len(parts) != 4:
        raise ValueError(
            f'{ENV}={raw!r} is not "<frames>,<rate>,<max>,<window>" (e.g. {RECOMMENDED!r}) '
            'or "off". The stall guard refuses to guess at a malformed setting.')
    try:
        frames, window = int(parts[0]), int(parts[3])
        rate, top = float(parts[1]), float(parts[2])
    except ValueError:
        raise ValueError(
            f'{ENV}={raw!r}: frames and window are whole numbers, rate and max are '
            f'numbers (e.g. {RECOMMENDED!r}).') from None
    if frames < 0 or window < 1 or not rate > 0 or not top > 0:
        raise ValueError(
            f'{ENV}={raw!r}: frames must be >= 0, window >= 1, and rate and max > 0.')
    return StallGuard(frames=frames, rate=rate, max=top, window=window)


def counted(state, num_codebooks: int) -> bool:
    """Is this row counted on the step about to be taken - active, past the
    delay window, not winding down? Read from the sampler state BEFORE the step
    (mlx_audio `HiggsSamplerState`: `delay_count < n` is the delay window,
    `eoc_countdown is not None` the wind-down)."""
    return (not state.generation_done
            and state.delay_count >= num_codebooks
            and state.eoc_countdown is None)


class RowStall:
    """One row's ring R and run."""

    def __init__(self, guard: StallGuard):
        self.guard = guard
        self.ring: deque[int] = deque(maxlen=guard.window)
        self.run = 0

    def penalty(self) -> float:
        return self.guard.penalty(self.run)

    def codes(self) -> list[int]:
        """The distinct codes in R - each lowered once, never once per repeat."""
        return sorted(set(self.ring))

    def observe(self, code: int, steady: bool) -> None:
        """Record this step's sampled cb0 code; `steady` per the module docstring."""
        if not steady:
            # RESET (crucible-pc, 2026-10-02). To flip to "untouched", replace
            # the next line with `return`.
            self.run = 0; self.ring.clear()  # noqa: E702 - the one line
            return
        self.run = self.run + 1 if code in self.ring else 0
        self.ring.append(int(code))

