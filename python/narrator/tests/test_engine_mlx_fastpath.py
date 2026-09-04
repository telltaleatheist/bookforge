"""The MLX fast path's batched logits math must equal mlx-lm's per-row loop.

Ported from ebook2audiobook@9daab0ba tools/test_mlx_fastpath_equivalence.py to
unittest and to narrator.engine.mlx_fastpath. Same rows, same tolerances, same
refusals; the sequential script's shared state is built once in setUpClass and
read by the individual cases.

REQUIRES mlx (CPU device, no model, no GPU); a machine without it SKIPS - which
today is every machine but the Mac. THIS PORT HAS NOT BEEN RUN; see
PORT_NOTES.md "Could not verify".

The fast path replaces GenerationBatch._step with a version that (a) applies the
repetition penalty and the EOS boost to the whole batch in two array ops instead
of a Python loop over rows, and (b) projects the head onto only the 28,680 ids
Orpheus can emit. (b) is a restriction of the same matmul and is exact by
construction; (a) is a REWRITE, and this is what proves the rewrite.

WHAT IS COMPARED. For a batch of synthetic rows, the reference applies
`mlx_lm.sample_utils.make_repetition_penalty` and a literal copy of the EOS
boost closure as it stood before this change, per row, over the FULL 156,940-wide
logits - exactly what stock GenerationBatch._step does. The fast path's own
functions (_bf_sync / _bf_mark_inputs / _bf_row_scalars / _bf_apply) run over
the sliced logits. The two must agree on the slice.

THE ROWS exercise every branch that differs:
  0  rep penalty only, no boost                       (mixed-sign logits)
  1  rep + boost, well past its start                 (ramp, saturating the 4x cap)
  2  rep + boost, n EXACTLY at start                  (must NOT fire: n > start)
  3  rep + boost, n below start                       (must not fire)
  4  rep only, every logit forced NEGATIVE            (the l*p arm)
  5  rep only, every logit forced POSITIVE            (the l/p arm)
  6  no processors at all                             (identity)
Every row's history mixes prompt-text ids (outside the emittable block, which
the mask must ignore) with repeated in-slice ids (which the mask must collapse
the same way stock's duplicate scatter does).
"""
import os
import sys
import types
import unittest

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

try:
    import mlx.core as mx
    mx.set_default_device(mx.cpu)
    from mlx_lm.sample_utils import make_repetition_penalty
    from narrator.engine import mlx_fastpath as fp
    _HAS_MLX = True
except Exception:                      # noqa: BLE001
    mx = None
    fp = None
    make_repetition_penalty = None
    _HAS_MLX = False

V = 156940
B = 7
TOL = 1e-6
PENALTY = 1.1
WINDOW = 8192


def reference_boost(base, start, expected, eos):
    """The `_boost` closure of _mlx_eos_boost_processor as it stood BEFORE the
    fast path existed - copied here so the reference cannot drift into being the
    thing under test."""
    def _boost(tokens, logits):
        n = len(tokens)
        if n > start:
            bias = base * min(4.0, 1.0 + (n - start) / expected)
            return logits.at[:, eos].add(bias)
        return logits
    return _boost


class FakeBatch:
    """Only the attributes _bf_sync / _bf_row_scalars read off a GenerationBatch."""

    def __init__(self, uids, tokens, logits_processors):
        self.uids = uids
        self.tokens = tokens
        self.logits_processors = logits_processors


def history(n_text, n_codes, repeats, seed):
    """A row's KV-cache tokens: some prompt text ids, then in-slice codes with
    deliberate repeats (the case where stock's gather writes the same column
    twice and the mask must not double-apply)."""
    r = np.random.default_rng(seed)
    text = r.integers(0, 128000, size=n_text).tolist()
    codes = r.integers(fp.AUDIO_LO, fp.SLICE_HI, size=n_codes).tolist()
    codes = codes + codes[:repeats]                 # exact duplicates
    codes.append(fp.END_OF_AUDIO_TOKEN)             # EOS lives in the slice too
    return text + codes


@unittest.skipUnless(_HAS_MLX, 'mlx is not installed (Mac only)')
class MlxFastPathEquivalenceTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        EOS = fp.END_OF_AUDIO_TOKEN
        rng = np.random.default_rng(20260901)

        # (label, boost spec, history spec) per row; start/expected are the
        # arithmetic the real _mlx_eos_boost_processor produces.
        cls.rows = [
            dict(label='rep only, mixed signs',     boost=None,                 hist=(12, 40, 5)),
            dict(label='boost past start (4x cap)', boost=(1.75, 300.0, 40.0),  hist=(9, 900, 11)),
            dict(label='boost exactly AT start',    boost=(1.75, 251.0, 60.0),  hist=(10, 240, 0)),
            dict(label='boost below start',         boost=(2.5, 5000.0, 400.0), hist=(8, 300, 3)),
            dict(label='rep only, all negative',    boost=None,                 hist=(7, 55, 9)),
            dict(label='rep only, all positive',    boost=None,                 hist=(6, 61, 2)),
            dict(label='no processors',             boost=None,                 hist=(15, 33, 4), bare=True),
        ]

        tokens, procs = [], []
        for i, spec in enumerate(cls.rows):
            tokens.append(history(*spec['hist'], seed=1000 + i))
            if spec.get('bare'):
                procs.append([])
                continue
            p = [fp.make_rep_penalty(PENALTY, WINDOW)]
            if spec['boost'] is not None:
                base, start, expected = spec['boost']
                p.append(fp.make_eos_boost(base, start, expected, EOS))
            procs.append(p)

        # Row 2 must sit exactly at n == start. n is len(tokens[i]) + 1.
        n2 = len(tokens[2]) + 1
        cls.rows[2]['boost'] = (1.75, float(n2), 60.0)
        procs[2] = [fp.make_rep_penalty(PENALTY, WINDOW),
                    fp.make_eos_boost(1.75, float(n2), 60.0, EOS)]
        cls.tokens, cls.procs = tokens, procs

        # The current input token of each step. Row 6 is given an out-of-slice
        # input (128257, START_OF_SPEECH - what the real first step sees) so the
        # "mark nothing" branch is exercised.
        cls.inputs_list = [
            int(rng.integers(fp.AUDIO_LO, fp.SLICE_HI)),
            int(rng.integers(fp.AUDIO_LO, fp.SLICE_HI)),
            EOS,
            int(rng.integers(fp.AUDIO_LO, fp.SLICE_HI)),
            int(rng.integers(fp.AUDIO_LO, fp.SLICE_HI)),
            int(rng.integers(fp.AUDIO_LO, fp.SLICE_HI)),
            128257,
        ]

        full = rng.standard_normal((B, V)).astype(np.float32) * 3.0
        full[4] = -np.abs(full[4]) - 0.5      # every logit negative  -> l * p
        full[5] = np.abs(full[5]) + 0.5       # every logit positive  -> l / p
        cls.full = full
        cls.full_mx = mx.array(full)

        cls.ref = cls._reference(cls.full_mx)
        cls.batch = FakeBatch(uids=list(range(B)),
                              tokens=[list(t) for t in tokens],
                              logits_processors=procs)
        cls.state = fp._bf_sync(cls.batch)
        fp._bf_mark_inputs(cls.state, mx.array(cls.inputs_list, dtype=mx.uint32), B)
        cls.bias, cls.any_bias = fp._bf_row_scalars(cls.batch, cls.state)
        cls.fast = fp._bf_apply(cls.full_mx[:, fp.SLICE_LO:fp.SLICE_HI],
                                cls.state, cls.bias, cls.any_bias)
        mx.eval(cls.fast, cls.state.seen)
        cls.seen_np = np.array(cls.state.seen)

    @classmethod
    def _reference(cls, logits):
        """Stock, per row, over the FULL vocab, sliced at the end."""
        EOS = fp.END_OF_AUDIO_TOKEN
        out = []
        for i in range(B):
            buf = mx.array(cls.tokens[i] + [cls.inputs_list[i]], dtype=mx.int32)
            row = logits[i:i + 1]
            if cls.procs[i]:
                row = make_repetition_penalty(PENALTY, WINDOW)(buf, row)
                spec = cls.rows[i]['boost']
                if spec is not None:
                    base, start, expected = spec
                    row = reference_boost(base, start, expected, EOS)(buf, row)
            out.append(row[0, fp.SLICE_LO:fp.SLICE_HI])
        stacked = mx.stack(out)
        mx.eval(stacked)
        return stacked

    # ---- 1. equivalence -----------------------------------------------------

    def test_row_1_saturates_the_ramp_cap(self):
        """The fixture must actually exercise the 4x clamp, or case 1 proves
        nothing about it."""
        self.assertGreater(len(self.tokens[1]) + 1 - self.rows[1]['boost'][1],
                           4.0 * self.rows[1]['boost'][2])

    def test_batched_matches_the_stock_per_row_loop(self):
        diff = np.abs(np.array(self.fast) - np.array(self.ref))
        for i, spec in enumerate(self.rows):
            with self.subTest(row=i, label=spec['label']):
                self.assertLessEqual(diff[i].max(), TOL,
                                     f'max |diff| = {diff[i].max():.3e}')
        self.assertLessEqual(diff.max(), TOL, f'whole batch max |diff| = {diff.max():.3e}')

    def test_bf16_is_bit_identical(self):
        """Production logits ARE bf16. Stock multiplies a bf16 row by a Python
        float; the fast path multiplies by a bf16 penalty array. Those must agree
        exactly on the bf16 grid, or the "same 1.1 penalty" is quietly two
        different numbers."""
        full_bf = self.full_mx.astype(mx.bfloat16)
        ref_bf = self._reference(full_bf)
        batch_bf = FakeBatch(uids=list(range(B)),
                             tokens=[list(t) for t in self.tokens],
                             logits_processors=self.procs)
        state_bf = fp._bf_sync(batch_bf)
        fp._bf_mark_inputs(state_bf, mx.array(self.inputs_list, dtype=mx.uint32), B)
        bias_bf, any_bias_bf = fp._bf_row_scalars(batch_bf, state_bf)
        fast_bf = fp._bf_apply(full_bf[:, fp.SLICE_LO:fp.SLICE_HI],
                               state_bf, bias_bf, any_bias_bf)
        mx.eval(ref_bf, fast_bf)
        self.assertEqual(fast_bf.dtype, mx.bfloat16, 'bf16 logits stay bf16')
        diff = np.abs(np.array(fast_bf.astype(mx.float32))
                      - np.array(ref_bf.astype(mx.float32)))
        self.assertEqual(diff.max(), 0.0, f'max |diff| = {diff.max():.3e}')

    def test_the_boost_fires_on_exactly_one_row_and_is_clamped(self):
        self.assertEqual(self.bias[0], 0.0)
        self.assertEqual(self.bias[2], 0.0, 'n EXACTLY at start must not fire (n > start)')
        self.assertEqual(self.bias[3], 0.0)
        self.assertGreater(self.bias[1], 0.0)
        self.assertAlmostEqual(self.bias[1], self.rows[1]['boost'][0] * 4.0, places=12,
                               msg='row 1 boost is clamped at 4x base')
        self.assertTrue(self.any_bias)

    def test_untouched_columns_are_byte_identical(self):
        sliced_in = np.array(self.full_mx[:, fp.SLICE_LO:fp.SLICE_HI])
        untouched = ~self.seen_np.copy()
        untouched[:, fp.EOS_INDEX] = False
        self.assertTrue(np.array_equal(np.array(self.fast)[untouched],
                                       sliced_in[untouched]),
                        'columns no row has seen must be byte-identical to the input')

    def test_the_seen_mask_ignores_out_of_slice_history_and_input(self):
        expected6 = np.zeros(fp.SLICE_N, dtype=bool)
        codes6 = np.array([t for t in self.tokens[6]
                           if fp.SLICE_LO <= t < fp.SLICE_HI])
        expected6[codes6 - fp.SLICE_LO] = True
        self.assertTrue(np.array_equal(self.seen_np[6], expected6),
                        'row 6: out-of-slice history and an out-of-slice input '
                        'mark nothing')
        self.assertTrue(self.seen_np[2][fp.END_OF_AUDIO_TOKEN - fp.SLICE_LO],
                        'row 2: the current input (EOS) is marked before the '
                        'penalty runs')

    # ---- 2. the marked factories -------------------------------------------

    def test_make_rep_penalty_is_the_stock_closure(self):
        probe_tokens = mx.array(self.tokens[1] + [self.inputs_list[1]], dtype=mx.int32)
        a = fp.make_rep_penalty(PENALTY, WINDOW)(probe_tokens, mx.array(self.full[1:2]))
        b = make_repetition_penalty(PENALTY, WINDOW)(probe_tokens, mx.array(self.full[1:2]))
        mx.eval(a, b)
        self.assertTrue(np.array_equal(np.array(a), np.array(b)))

    def test_make_eos_boost_is_the_pre_change_closure(self):
        probe_tokens = mx.array(self.tokens[1] + [self.inputs_list[1]], dtype=mx.int32)
        base, start, expected = 1.75, 300.0, 40.0
        eos = fp.END_OF_AUDIO_TOKEN
        a = fp.make_eos_boost(base, start, expected, eos)(
            probe_tokens, mx.array(self.full[1:2]))
        b = reference_boost(base, start, expected, eos)(
            probe_tokens, mx.array(self.full[1:2]))
        mx.eval(a, b)
        self.assertTrue(np.array_equal(np.array(a), np.array(b)))

    # ---- 3. state follows the live row set ---------------------------------

    def test_a_retirement_permutes_the_mask(self):
        keep = [0, 2, 5]
        batch = FakeBatch(uids=[self.batch.uids[i] for i in keep],
                          tokens=[list(self.tokens[i]) for i in keep],
                          logits_processors=[self.procs[i] for i in keep])
        # Seed the cache with the full state, then shrink it - the permute branch.
        batch._bf_state = self.state
        state2 = fp._bf_sync(batch)
        mx.eval(state2.seen)
        self.assertEqual(state2.seen.shape, (len(keep), fp.SLICE_N))
        self.assertTrue(np.array_equal(np.array(state2.seen),
                                       self.seen_np[np.array(keep)]),
                        'a retirement permutes the mask rather than losing or '
                        'shifting a row')

    def test_an_unknown_uid_rebuilds_from_the_rows_own_tokens(self):
        batch = FakeBatch(uids=[99], tokens=[list(self.tokens[3])],
                          logits_processors=[self.procs[3]])
        state3 = fp._bf_sync(batch)
        mx.eval(state3.seen)
        rebuilt = np.zeros(fp.SLICE_N, dtype=bool)
        c3 = np.array([t for t in self.tokens[3] if fp.SLICE_LO <= t < fp.SLICE_HI])
        rebuilt[c3 - fp.SLICE_LO] = True
        self.assertTrue(np.array_equal(np.array(state3.seen)[0], rebuilt))

    def test_a_uid_set_that_grows_rebuilds_exactly(self):
        """The continuous-batching case: BatchGenerator._next prefills queued
        prompts into their own GenerationBatch and extend()s it into the live one,
        so mid-generation self.uids gains ids the state has never seen. _bf_sync
        must take the FULL-REBUILD branch there (the permute branch is only valid
        for a subset) and rebuild every row exactly from self.tokens.

        WHY len(self.tokens[i]) IS STILL THE RIGHT LENGTH AFTER AN EXTEND, even
        though the row's KV cache is now PADDED to the oldest live row's _idx:
          * BatchKVCache.extend right-justifies the new rows at max_idx and
            records the gap as left_padding; create_causal_mask ANDs in
            `left_padding <= rinds`, so those positions are masked out of
            attention and are not tokens.
          * self.tokens is mlx-lm's own record of the tokens IN the cache;
            padding is never appended to it.
        """
        old_uid, old_tokens = 7, history(11, 120, 4, seed=7007)
        new_prompts = [
            [128259, 128000, 3923, 128009, 128260, 128261, 128257],          # all text ids
            [128259, 128000, 5000, 128009, 128260, 128261,
             fp.AUDIO_LO + 33, fp.AUDIO_LO + 33, 128257],                    # + repeats
        ]
        new_uids = [8, 9]

        grow = FakeBatch(uids=[old_uid], tokens=[list(old_tokens)],
                         logits_processors=[[fp.make_rep_penalty(PENALTY, WINDOW)]])
        before = fp._bf_sync(grow)
        mx.eval(before.seen)

        # ... one step later mlx-lm prefilled two queued rows and extended them in.
        grow.uids = [old_uid] + new_uids
        grow.tokens = [list(old_tokens)] + [list(p) for p in new_prompts]
        grow.logits_processors = [[fp.make_rep_penalty(PENALTY, WINDOW)]] * 3
        after = fp._bf_sync(grow)
        mx.eval(after.seen)

        self.assertIsNot(after, before, 'the grown uid set invalidates the cache')
        self.assertEqual(after.seen.shape, (3, fp.SLICE_N))
        after_np = np.array(after.seen)
        self.assertTrue(np.array_equal(after_np[0], np.array(before.seen)[0]),
                        'the row that was already generating keeps its history')
        for k, prompt in enumerate(new_prompts, start=1):
            with self.subTest(extended_row=k):
                want = np.zeros(fp.SLICE_N, dtype=bool)
                codes = np.array([t for t in prompt
                                  if fp.SLICE_LO <= t < fp.SLICE_HI], dtype=np.int64)
                if codes.size:
                    want[codes - fp.SLICE_LO] = True
                self.assertTrue(np.array_equal(after_np[k], want),
                                'an extended row is rebuilt EXACTLY from its own '
                                'prompt tokens')

    def test_the_window_bound_is_the_rows_own_token_count(self):
        """Row 0 carries ~135 tokens; the extended rows carry 7 and 9. A window of
        10 must therefore accept both new rows and refuse only the old one."""
        old_tokens = history(11, 120, 4, seed=7007)
        new_prompts = [
            [128259, 128000, 3923, 128009, 128260, 128261, 128257],
            [128259, 128000, 5000, 128009, 128260, 128261,
             fp.AUDIO_LO + 33, fp.AUDIO_LO + 33, 128257],
        ]
        narrow = FakeBatch(uids=[8, 9], tokens=[list(p) for p in new_prompts],
                           logits_processors=[[fp.make_rep_penalty(PENALTY, 10)]] * 2)
        bias_n, _ = fp._bf_row_scalars(narrow, fp._bf_sync(narrow))
        self.assertEqual(bias_n, [0.0, 0.0],
                         'a freshly extended row is bounded by len(self.tokens[i]) + 1 '
                         '- its PROMPT length - not by the padded KV length')
        too_long = FakeBatch(uids=[7, 8, 9],
                             tokens=[list(old_tokens)] + [list(p) for p in new_prompts],
                             logits_processors=[[fp.make_rep_penalty(PENALTY, 10)]] * 3)
        with self.assertRaises(fp.FastPathUnsupported) as ctx:
            fp._bf_row_scalars(too_long, fp._bf_sync(too_long))
        self.assertIn('repetition window is 10', str(ctx.exception))

    # ---- 4. unbatchable processors are refused by name ---------------------

    def _refuses(self, fn, needle):
        with self.assertRaises(fp.FastPathUnsupported) as ctx:
            fn()
        self.assertIn(needle, str(ctx.exception))

    def test_an_unmarked_processor_is_refused(self):
        self._refuses(lambda: fp._row_params([make_repetition_penalty(1.1, 20)], 0),
                      'unmarked logits processor')

    def test_a_boost_ordered_before_the_penalty_is_refused(self):
        eos = fp.END_OF_AUDIO_TOKEN
        self._refuses(lambda: fp._row_params([fp.make_eos_boost(1.0, 1.0, 1.0, eos),
                                              fp.make_rep_penalty(1.1, WINDOW)], 3),
                      'AFTER the EOS boost')

    def test_two_repetition_penalties_are_refused(self):
        self._refuses(lambda: fp._row_params([fp.make_rep_penalty(1.1, WINDOW),
                                              fp.make_rep_penalty(1.2, WINDOW)], 1),
                      'two repetition penalties')

    def test_a_boost_on_another_token_is_refused(self):
        self._refuses(lambda: fp._row_params([fp.make_eos_boost(1.0, 1.0, 1.0, 128009)], 2),
                      'not END_OF_AUDIO')

    def test_a_kv_cache_longer_than_the_window_is_refused(self):
        tiny = FakeBatch(uids=[0],
                         tokens=[list(range(fp.AUDIO_LO, fp.AUDIO_LO + 64))],
                         logits_processors=[[fp.make_rep_penalty(1.1, 8)]])
        self._refuses(lambda: fp._bf_row_scalars(tiny, fp._bf_sync(tiny)),
                      'repetition window is 8')


@unittest.skipUnless(_HAS_MLX, 'mlx is not installed (Mac only)')
class MlxFastPathInstallTest(unittest.TestCase):
    """install() refuses every model it cannot serve, BY NAME."""

    def setUp(self):
        import mlx.nn as nn
        self.nn = nn
        self.good_embed = nn.Embedding(fp.SLICE_HI + 2, 8)
        mx.eval(self.good_embed.weight)
        self.good = self._model(self.good_embed)

    @staticmethod
    def _model(embed, tied=True):
        inner = types.SimpleNamespace(embed_tokens=embed)
        return types.SimpleNamespace(
            args=types.SimpleNamespace(tie_word_embeddings=tied), model=inner)

    def _refuses(self, fn, needle):
        with self.assertRaises(fp.FastPathUnsupported) as ctx:
            fn()
        self.assertIn(needle, str(ctx.exception))

    def test_a_different_mlx_lm_version_is_refused(self):
        import mlx_lm
        real = mlx_lm.__version__
        try:
            mlx_lm.__version__ = '0.32.0'
            self._refuses(lambda: fp.install(self.good, rep_window=8192, max_tokens=3700),
                          'pinned to mlx-lm 0.31.3')
        finally:
            mlx_lm.__version__ = real

    def test_a_window_that_cannot_cover_prompt_plus_generation_is_refused(self):
        self._refuses(lambda: fp.install(self.good, rep_window=4096, max_tokens=3700),
                      'does not cover a full generation')

    def test_an_untied_head_is_refused(self):
        self._refuses(lambda: fp.install(self._model(self.good_embed, tied=False),
                                         rep_window=8192, max_tokens=3700),
                      'TIED input embedding')

    def test_a_quantized_embedding_is_refused(self):
        quant = self.nn.QuantizedEmbedding(fp.SLICE_HI + 2, 64)
        mx.eval(quant.weight, quant.scales)
        self._refuses(lambda: fp.install(self._model(quant),
                                         rep_window=8192, max_tokens=3700),
                      'QuantizedEmbedding')

    def test_a_vocabulary_too_small_for_the_snac_block_is_refused(self):
        self._refuses(lambda: fp.install(self._model(self.nn.Embedding(1024, 8)),
                                         rep_window=8192, max_tokens=3700),
                      'not an Orpheus checkpoint')

    def test_the_good_case_installs_is_idempotent_and_can_be_undone(self):
        from mlx_lm.generate import GenerationBatch
        stock_step = GenerationBatch._step
        try:
            line = fp.install(self.good, rep_window=8192, max_tokens=3700)
            self.assertIs(GenerationBatch._step, fp._bf_step,
                          'install() replaces GenerationBatch._step')
            self.assertEqual(self.good._bf_fastpath_head.shape, (fp.SLICE_N, 8),
                             'the head slice is [SLICE_N, hidden]')
            self.assertIsInstance(line, str)
            self.assertIn('fast path installed', line)
            fp.install(self.good, rep_window=8192, max_tokens=3700)
            self.assertIs(GenerationBatch._stock_step, stock_step,
                          'install() is idempotent')
        finally:
            fp.uninstall(self.good)
        self.assertIs(GenerationBatch._step, stock_step,
                      'uninstall() restores the stock step')
        self.assertFalse(hasattr(self.good, '_bf_fastpath_head'),
                         'uninstall() drops the head slice')


if __name__ == '__main__':
    unittest.main()
