"""Higgs v3 on MLX, WIDER THAN ONE ROW: the ceiling, the budget, the slicing.

WHAT THIS FILE CAN PROVE, AND WHAT IT CANNOT.

Provable here, on any machine, with no model and no GPU:

  * the three environment variables - their defaults, and that garbage is
    REFUSED BY NAME rather than coerced or defaulted past;
  * the memory arithmetic: headroom = budget - weights - the PINNED buffer
    cache, and width = headroom / (depth x MB-per-position-per-row), clamped to
    [1, ceiling];
  * the slicing: consecutive book-order slices, each carrying its own depth
    (prompt positions + that row's frame cap), and an over-deep slice split
    EVENLY rather than into [allowed, remainder];
  * that a ceiling of 1 still takes the serial path, chunk by chunk;
  * that none of the names this backend reads is an ORPHEUS_ one - the Higgs
    spawn strips those deliberately, and a keeper on the TypeScript side asserts
    none rides along.

NOT provable here: that a batched render sounds like a single-row one. That is a
GPU measurement on the Mac - the left-padded prefill, the per-row retirement and
the cache `filter(keep)` are mirrored from mlx-audio's own `batch_generate`, and
nothing in this file loads a model. Owen measures it.
"""
import os
import unittest
from unittest import mock

from narrator.engine.higgs.mlx_backend import (BATCH_ENV, CACHE_LIMIT_ENV,
                                               MEM_BUDGET_ENV,
                                               HiggsV3MlxEngine,
                                               mlx_batch_ceiling,
                                               mlx_cache_limit_gb,
                                               mlx_mem_budget_gb)


def _engine(*, ceiling: int, budget: float = 42.0,
            kv_mb: float = 0.140625) -> HiggsV3MlxEngine:
    """An engine object with the batch knobs set and NOTHING loaded.

    `__new__` on purpose: `__init__` loads a model, and every method under test
    reads only these four numbers. That is the point of keeping the arithmetic
    off the model.
    """
    engine = HiggsV3MlxEngine.__new__(HiggsV3MlxEngine)
    engine.BATCH_SIZE = ceiling
    engine.MLX_MEM_BUDGET_GB = budget
    engine.MLX_KV_MB_PER_TOKEN_ROW = kv_mb
    return engine


class BatchEnvTest(unittest.TestCase):
    """The three variables, their defaults, and the refusals."""

    def test_defaults_are_one_row_forty_two_gb_and_eight_gb_of_cache(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(mlx_batch_ceiling(), 1)
            self.assertEqual(mlx_mem_budget_gb(), 42.0)
            self.assertEqual(mlx_cache_limit_gb(), 8.0)

    def test_the_ceiling_is_read_from_the_environment(self):
        with mock.patch.dict(os.environ, {BATCH_ENV: '16'}, clear=True):
            self.assertEqual(mlx_batch_ceiling(), 16)
        with mock.patch.dict(os.environ, {MEM_BUDGET_ENV: '34'}, clear=True):
            self.assertEqual(mlx_mem_budget_gb(), 34.0)
        with mock.patch.dict(os.environ, {CACHE_LIMIT_ENV: '6'}, clear=True):
            self.assertEqual(mlx_cache_limit_gb(), 6.0)

    def test_blank_is_the_default_not_a_refusal(self):
        # An exported-but-empty variable is what a shell hands over when a
        # setting was cleared; it means "unset", not "zero rows".
        with mock.patch.dict(os.environ, {BATCH_ENV: '   '}, clear=True):
            self.assertEqual(mlx_batch_ceiling(), 1)

    def test_garbage_is_refused_by_name(self):
        for value in ('banana', '8 rows', '1.5'):
            with mock.patch.dict(os.environ, {BATCH_ENV: value}, clear=True):
                with self.assertRaises(ValueError) as caught:
                    mlx_batch_ceiling()
                self.assertIn(BATCH_ENV, str(caught.exception))

    def test_a_ceiling_below_one_is_refused_by_name(self):
        with mock.patch.dict(os.environ, {BATCH_ENV: '0'}, clear=True):
            with self.assertRaises(ValueError) as caught:
                mlx_batch_ceiling()
            self.assertIn(BATCH_ENV, str(caught.exception))
        with mock.patch.dict(os.environ, {MEM_BUDGET_ENV: 'lots'}, clear=True):
            with self.assertRaises(ValueError) as caught:
                mlx_mem_budget_gb()
            self.assertIn(MEM_BUDGET_ENV, str(caught.exception))

    def test_no_variable_this_backend_reads_is_an_orpheus_one(self):
        # The Higgs spawn strips ORPHEUS_* deliberately (tools/test-higgs-engine.js
        # and tools/test-serve-spawn-env.js both assert none rides along), so a
        # Higgs knob spelled ORPHEUS_ would be read by nothing.
        for name in (BATCH_ENV, MEM_BUDGET_ENV, CACHE_LIMIT_ENV):
            self.assertNotIn('ORPHEUS', name)


class WidthMathTest(unittest.TestCase):
    """headroom, and the width it buys at a given depth."""

    def test_headroom_is_budget_minus_weights_minus_the_pinned_cache(self):
        engine = _engine(ceiling=64, budget=42.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            # 42 - 8.5 weights - 8 pinned cache
            self.assertAlmostEqual(engine._mlx_kv_headroom_gb(), 25.5, places=6)

    def test_a_smaller_cache_limit_buys_headroom(self):
        engine = _engine(ceiling=64, budget=42.0)
        with mock.patch.dict(os.environ, {CACHE_LIMIT_ENV: '4'}, clear=True):
            self.assertAlmostEqual(engine._mlx_kv_headroom_gb(), 29.5, places=6)

    def test_an_impossible_budget_is_refused_naming_all_three_knobs(self):
        engine = _engine(ceiling=64, budget=13.0)   # the 'light' tier's budget
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError) as caught:
                engine._mlx_kv_headroom_gb()
        message = str(caught.exception)
        self.assertIn(MEM_BUDGET_ENV, message)
        self.assertIn(CACHE_LIMIT_ENV, message)
        self.assertIn(BATCH_ENV, message)

    def test_the_worked_example(self):
        # budget 42, weights 8.5, cache 8 -> headroom 25.5 GB.
        # depth 2000 -> 2000 x 0.140625 / 1024 = 0.2747 GB per row.
        # 25.5 / 0.2747 = 92.8 -> 92 rows.
        engine = _engine(ceiling=1000, budget=42.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine._mlx_width_for_depth(2000), 92)

    def test_the_ceiling_is_never_exceeded(self):
        engine = _engine(ceiling=8, budget=42.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine._mlx_width_for_depth(10), 8)

    def test_one_row_is_always_attemptable(self):
        # A depth so large that the arithmetic says zero rows: one row is the
        # same work the single-row path would do, so it is never refused.
        engine = _engine(ceiling=64, budget=42.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine._mlx_width_for_depth(10_000_000), 1)

    def test_a_deeper_backbone_costs_width(self):
        # Same budget, twice the KV per position -> half the rows.
        engine = _engine(ceiling=1000, budget=42.0, kv_mb=0.28125)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine._mlx_width_for_depth(2000), 46)


class BatchGroupsTest(unittest.TestCase):
    """Consecutive book-order slices, each with its own depth."""

    @staticmethod
    def _entries(count: int, positions: int = 700, cap: int = 300):
        return [(i, f'chunk {i}', positions, cap) for i in range(count)]

    def test_slices_are_consecutive_and_in_book_order(self):
        engine = _engine(ceiling=4, budget=42.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            groups = engine._mlx_batch_groups(self._entries(10))
        self.assertEqual([[e[0] for e in bucket] for bucket, _d in groups],
                         [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]])

    def test_depth_is_the_deepest_prompt_plus_its_own_cap(self):
        engine = _engine(ceiling=4, budget=42.0)
        entries = [(0, 'a', 700, 300), (1, 'b', 900, 100), (2, 'c', 100, 1500)]
        with mock.patch.dict(os.environ, {}, clear=True):
            groups = engine._mlx_batch_groups(entries)
        self.assertEqual(len(groups), 1)
        # max(700+300, 900+100, 100+1500) = 1600, not 900 and not 1500.
        self.assertEqual(groups[0][1], 1600)

    def test_an_over_deep_slice_is_split_evenly_not_into_a_tail(self):
        # Ceiling 64 at a depth that only affords 50 rows: 32 + 32, never 50 + 14.
        # depth 4000 -> 4000 x 0.140625 / 1024 = 0.5493 GB/row; 25.5 / 0.5493 = 46.
        engine = _engine(ceiling=64, budget=42.0)
        entries = self._entries(64, positions=1000, cap=3000)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine._mlx_width_for_depth(4000), 46)
            groups = engine._mlx_batch_groups(entries)
        sizes = [len(bucket) for bucket, _d in groups]
        self.assertEqual(sizes, [32, 32])
        self.assertEqual(sum(sizes), 64)
        # Still consecutive, still in book order.
        self.assertEqual([e[0] for e in groups[0][0]], list(range(32)))
        self.assertEqual([e[0] for e in groups[1][0]], list(range(32, 64)))

    def test_an_uneven_split_puts_the_extra_row_first(self):
        engine = _engine(ceiling=5, budget=42.0)
        entries = self._entries(5, positions=1000, cap=3000)
        with mock.patch.dict(os.environ, {'PLACEHOLDER': '1'}, clear=True):
            with mock.patch.object(engine, '_mlx_width_for_depth', return_value=2):
                groups = engine._mlx_batch_groups(entries)
        self.assertEqual([len(bucket) for bucket, _d in groups], [2, 2, 1])

    def test_no_entries_is_no_groups(self):
        engine = _engine(ceiling=8, budget=42.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine._mlx_batch_groups([]), [])


class LoadAnnouncementTest(unittest.TestCase):
    """What the engine says about batching at load, and what it does about it."""

    def test_a_ceiling_of_one_announces_nothing(self):
        engine = _engine(ceiling=1, budget=42.0)
        with mock.patch('narrator.engine.higgs.mlx_backend._log') as logged:
            engine._announce_batch_budget()
        logged.assert_not_called()

    def test_a_budget_too_small_for_the_weights_turns_batching_OFF_by_name(self):
        # BookForge hands over the ORPHEUS memory tier's budget, and Orpheus's
        # weights are 6.9 GB against Higgs's 8.5: 'light' (13 GB) can hold this
        # model but not a batch of it. Refusing the LOAD there would break
        # single-row rendering that works fine on that machine.
        engine = _engine(ceiling=24, budget=13.0)
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch('narrator.engine.higgs.mlx_backend._log') as logged:
                engine._announce_batch_budget()
        self.assertEqual(engine.BATCH_SIZE, 1, 'batching stayed on a budget that cannot hold it')
        said = ' '.join(str(call.args[0]) for call in logged.call_args_list)
        self.assertIn('OFF', said)
        self.assertIn(MEM_BUDGET_ENV, said)

    def test_a_workable_budget_announces_the_width_and_the_certificate(self):
        engine = _engine(ceiling=64, budget=42.0)
        engine.config = mock.Mock(max_chars=900)
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch('narrator.engine.higgs.mlx_backend._log') as logged:
                engine._announce_batch_budget()
        self.assertEqual(engine.BATCH_SIZE, 64)
        said = ' '.join(str(call.args[0]) for call in logged.call_args_list)
        self.assertIn('batch budget 42 GB', said)
        # The maxChars certificate was measured SINGLE-ROW and the catalog is
        # unchanged; a widened render must say so rather than inherit it.
        self.assertIn('UNCERTIFIED', said)
        self.assertIn(BATCH_ENV, said)


class ConvertBatchRoutingTest(unittest.TestCase):
    """Which path a call takes, and what it answers."""

    def test_pool_size_is_the_plain_ceiling(self):
        self.assertEqual(_engine(ceiling=16, budget=42.0).batch_pool_size, 16)
        self.assertEqual(_engine(ceiling=1, budget=42.0).batch_pool_size, 1)

    def test_a_ceiling_of_one_still_renders_chunk_by_chunk(self):
        engine = _engine(ceiling=1, budget=42.0)
        seen = []

        def _convert(index, text):
            seen.append((index, text))
            return True

        engine.convert = _convert
        answers = engine.convert_batch([(3, 'first'), (4, 'second')])
        self.assertEqual(answers, [True, True])
        self.assertEqual(seen, [(3, 'first'), (4, 'second')])

    def test_an_empty_call_is_an_empty_answer(self):
        engine = _engine(ceiling=64, budget=42.0)
        engine.convert = lambda index, text: True
        self.assertEqual(engine.convert_batch([]), [])

    def test_convert_writes_through_the_one_shared_writer(self):
        # The batched path and the single-row path MUST land byte-identically,
        # which is only guaranteed while there is one `sf.write` call site.
        engine = _engine(ceiling=1, budget=42.0)
        written = []
        engine.render_audio = lambda text, index=0: f'audio for {text} @ {index}'
        engine._write_sentence = lambda number, audio: written.append((number, audio)) or True
        self.assertTrue(engine.convert(7, 'a chunk'))
        self.assertEqual(written, [(7, 'audio for a chunk @ 7')])


if __name__ == '__main__':
    unittest.main()
