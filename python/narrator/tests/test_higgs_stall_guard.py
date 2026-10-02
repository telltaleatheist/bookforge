"""The Higgs stall guard (engine/higgs/stall_guard.py; Owen, 2026-10-02).

The contract is pure arithmetic over a ring and a counter, so it is driven here
by a fake sampler over fake codebook-0 logits: a greedy pick (the case the guard
must cover, since it acts before temperature / top-k / top-p) from logits that
favour one silence code by a fixed margin - the runaway the guard exists for.

The one mlx call, `mlx_backend._lower_cb0`, is checked against NumPy where mlx
is installed (the Mac) and skipped by name elsewhere.
"""

from __future__ import annotations

import unittest

import numpy as np

from narrator.engine.higgs import stall_guard as G

N = 8          # codebooks
V = 1026       # codes incl. BOC/EOC
SILENCE = 5    # the code the runaway sticks on


class FakeState:
    """mlx_audio HiggsSamplerState's three fields the guard reads."""

    def __init__(self):
        self.delay_count = 0
        self.eoc_countdown = None
        self.generation_done = False


def fake_step(cb0_logits: np.ndarray, state: FakeState, eoc_id: int = 1025) -> int:
    """`generation.step`'s bookkeeping, greedy on codebook 0."""
    code = int(np.argmax(cb0_logits))
    if state.delay_count < N:
        state.delay_count += 1
    elif state.eoc_countdown is not None:
        state.eoc_countdown -= 1
        if state.eoc_countdown <= 0:
            state.generation_done = True
    elif code == eoc_id:
        state.eoc_countdown = N - 2
    return code


def render(guard, frames: int, margin: float = 6.0, eoc_at: int | None = None) -> list[int]:
    """Greedy-sample `frames` steps from logits that favour SILENCE by `margin`
    over code 7 (the exit), returning cb0 per step. `eoc_at`: the step whose
    logits favour EOC instead, to drive a wind-down."""
    state = FakeState()
    stall = None if guard is None else G.RowStall(guard)
    out = []
    for t in range(frames):
        if state.generation_done:
            break
        logits = np.zeros(V)
        logits[SILENCE] = margin
        logits[7] = 0.5
        if eoc_at is not None and t == eoc_at:
            logits[1025] = 100.0
        was_counted = stall is not None and G.counted(state, N)
        if was_counted and stall.penalty() > 0:
            logits[stall.codes()] -= stall.penalty()     # what _lower_cb0 does
        code = fake_step(logits, state)
        if stall is not None:
            steady = was_counted and not state.generation_done
            stall.observe(code if steady else -1, steady)
        out.append(code)
    return out


class ParseTest(unittest.TestCase):

    def test_unset_and_off_are_off(self):
        self.assertIsNone(G.stall_guard_from_env({}))
        self.assertIsNone(G.stall_guard_from_env({G.ENV: 'off'}))
        self.assertIsNone(G.stall_guard_from_env({G.ENV: '  off\t'}))
        self.assertEqual(G.stall_guard_from_env({G.ENV: ' 37,0.5,20,8 '}).frames, 37)

    def test_the_recommended_value(self):
        guard = G.stall_guard_from_env({G.ENV: G.RECOMMENDED})
        self.assertEqual(guard, G.StallGuard(frames=37, rate=0.5, max=20.0, window=8))

    def test_malformed_is_refused_naming_the_variable(self):
        # The PC sampler patch's grammar exactly (crucible-pc, 2026-10-02): the empty string, any case but `off`,
        # inner spaces, signs, exponents, inf/nan, a fractional frame count and every out-of-range value.
        for bad in ('', '   ', 'OFF', 'Off', '37, 0.5,20,8', '37,0.5,20', '37,0.5,20,8,1', 'a,0.5,20,8',
                    '+37,0.5,20,8', '37,1e-1,20,8', '37,0.5,inf,8', '37,nan,20,8', '37.0,0.5,20,8', '37,.5,20,8',
                    '0,0.5,20,8', '10001,0.5,20,8', '37,0,20,8', '37,100.5,20,8', '37,0.5,0,8', '37,0.5,1000.1,8',
                    '37,0.5,20,0', '37,0.5,20,65', '-1,0.5,20,8'):
            with self.assertRaises(ValueError, msg=bad) as caught:
                G.stall_guard_from_env({G.ENV: bad})
            self.assertIn(G.ENV, str(caught.exception))


class PenaltyTest(unittest.TestCase):

    def test_ramp_then_cap(self):
        guard = G.StallGuard(frames=37, rate=0.5, max=20.0, window=8)
        self.assertEqual(guard.penalty(37), 0.0)
        self.assertEqual(guard.penalty(38), 0.5)
        self.assertEqual(guard.penalty(47), 5.0)
        self.assertEqual(guard.penalty(500), 20.0)


class RingTest(unittest.TestCase):

    def test_a_code_already_in_the_ring_extends_the_run(self):
        row = G.RowStall(G.StallGuard(frames=3, rate=1, max=10, window=4))
        for code in (5, 9, 5, 9, 5):   # alternating between two silence codes still counts:
            row.observe(code, True)    # 5 new, 9 new, then each one is already in R
        self.assertEqual(row.run, 3)
        self.assertEqual(row.codes(), [5, 9])
        row.observe(11, True)          # a new code ends the run but joins the window
        self.assertEqual(row.run, 0)
        self.assertIn(11, row.codes())

    def test_the_window_evicts_the_oldest(self):
        row = G.RowStall(G.StallGuard(frames=3, rate=1, max=10, window=2))
        for code in (1, 2, 3):
            row.observe(code, True)
        self.assertEqual(row.codes(), [2, 3])

    def test_a_step_that_is_not_steady_resets_run_and_ring(self):
        row = G.RowStall(G.StallGuard(frames=3, rate=1, max=10, window=4))
        for _ in range(6):
            row.observe(5, True)
        self.assertGreater(row.penalty(), 0)
        row.observe(-1, False)
        self.assertEqual((row.run, row.codes()), (0, []))


class GuardedRenderTest(unittest.TestCase):

    def test_without_the_guard_greedy_never_leaves_the_silence(self):
        codes = render(None, 400)
        self.assertTrue(all(c == SILENCE for c in codes[N:]))

    def test_with_the_guard_the_run_is_broken_once_the_ramp_passes_the_margin(self):
        guard = G.StallGuard(frames=37, rate=0.5, max=20.0, window=8)
        codes = render(guard, 400)
        # The delay window is never counted; the run then reaches `frames`, the
        # ramp needs 6 / 0.5 = 12 more frames to pass the margin, and the
        # model's own next choice (code 7) takes over - nothing is forced.
        first_exit = codes.index(7)
        self.assertEqual(first_exit, N + 1 + 37 + 12)
        self.assertTrue(all(c == SILENCE for c in codes[N:first_exit]))

    def test_the_delay_window_is_never_penalised(self):
        guard = G.StallGuard(frames=0, rate=100.0, max=100.0, window=8)
        codes = render(guard, 20)
        self.assertTrue(all(c == SILENCE for c in codes[:N + 2]))

    def test_the_eoc_wind_down_carries_no_penalty_and_ends_clean(self):
        guard = G.StallGuard(frames=2, rate=100.0, max=100.0, window=8)
        codes = render(guard, 100, eoc_at=N + 3)
        self.assertEqual(codes[N + 3], 1025)
        # The wind-down runs its n - 2 frames on the model's own choice (SILENCE),
        # unpenalised, and the row finishes.
        self.assertEqual(codes[N + 4:], [SILENCE] * (N - 2))


class MlxScatterTest(unittest.TestCase):
    """`_lower_cb0` against NumPy, where mlx exists."""

    def setUp(self):
        try:
            import mlx.core  # noqa: F401
        except ImportError:
            self.skipTest('mlx is not installed here; this runs on the Mac')

    def test_single_row_and_batch(self):
        import mlx.core as mx
        from narrator.engine.higgs.mlx_backend import _lower_cb0
        rng = np.random.default_rng(0)
        one = rng.standard_normal((N, V)).astype(np.float32)
        got = np.asarray(_lower_cb0(mx.array(one), None, [3, 5, 9], 2.5))
        want = one.copy()
        want[0, [3, 5, 9]] -= 2.5
        np.testing.assert_allclose(got, want, rtol=0, atol=1e-6)
        batch = rng.standard_normal((3, N, V)).astype(np.float32)
        got = np.asarray(_lower_cb0(mx.array(batch), 1, [5], 4.0))
        want = batch.copy()
        want[1, 0, 5] -= 4.0
        np.testing.assert_allclose(got, want, rtol=0, atol=1e-6)


if __name__ == '__main__':
    unittest.main()
