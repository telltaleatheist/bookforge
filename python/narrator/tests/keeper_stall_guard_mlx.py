"""The stall guard through the REAL MLX loops, on a machine with mlx-audio.

    python -m narrator.tests.keeper_stall_guard_mlx

Not a unittest module (it needs mlx and mlx-audio, which only the Mac has): it
drives `HiggsV3MlxEngine._generate_delayed_rows` (mlx-audio's own `step`) and
`_generate_delayed_rows_batch` (mlx-audio's own `Model._step_batch_sampler`)
with a model stub whose codebook-0 logits always favour one silence code by 6
over the exit code - the runaway - and greedy sampling. Without the guard cb0
never leaves the silence; with HIGGS_STALL_GUARD's recommended numbers it
leaves at frame 8 (delay) + 1 + 37 (frames) + 12 (6 / 0.5 ramp) = 58, on both
arms, exactly as test_higgs_stall_guard's pure-Python sampler predicts.
"""

from __future__ import annotations

import sys
import types

import mlx.core as mx
from mlx_audio.tts.models.higgs_audio_v3.model import Model as RealModel

from narrator.engine.higgs import stall_guard as G
from narrator.engine.higgs.mlx_backend import HiggsV3MlxEngine

N, V, H = 8, 1026, 4
SILENCE, EXIT = 5, 7
CAP = 120


class StubModel:
    layers: list = []
    config = types.SimpleNamespace(audio_boc_token_id=1024, audio_eoc_token_id=1025,
                                   audio_num_codebooks=N)

    def make_cache(self):
        return []

    def _build_prompt_embeddings(self, text, references):
        return mx.zeros((1, 3, H)), 3

    def backbone(self, ids, cache=None, input_embeddings=None):
        return mx.zeros((input_embeddings.shape[0], input_embeddings.shape[1], H))

    def _audio_logits(self, hidden):
        row = mx.zeros((N, V))
        row = row.at[0, SILENCE].add(6.0).at[0, EXIT].add(0.5)
        return mx.broadcast_to(row[None], (hidden.shape[0], N, V))

    def _embed_audio_codes(self, codes):
        return mx.zeros((codes.shape[0], H)) if codes.ndim == 2 else mx.zeros((H,))


StubModel._step_batch_sampler = RealModel._step_batch_sampler


def engine(guard):
    e = object.__new__(HiggsV3MlxEngine)
    e._model = StubModel()
    e._stall_guard = guard
    e._sampling = {'temperature': 0.0, 'top_p': 1.0, 'top_k': 1}
    e._budget = types.SimpleNamespace(max_total_tokens=lambda n: None)
    e._references_for = lambda: None
    return e


def first_exit(matrix):
    cb0 = [int(c) for c in matrix[:, 0]]
    return cb0.index(EXIT) if EXIT in cb0 else None


def main() -> int:
    guard = G.stall_guard_from_env({G.ENV: G.RECOMMENDED})
    expected = N + 1 + guard.frames + 12
    failures = []
    single_off = first_exit(engine(None)._generate_delayed_rows('x', CAP, seed=1))
    single_on = first_exit(engine(guard)._generate_delayed_rows('x', CAP, seed=1))
    prompts = [(mx.zeros((1, 3, H)), 3)] * 2
    batch_off = [first_exit(m) for m in engine(None)._generate_delayed_rows_batch(
        ['x', 'y'], [CAP, CAP], seed=1, prompts=prompts)]
    batch_on = [first_exit(m) for m in engine(guard)._generate_delayed_rows_batch(
        ['x', 'y'], [CAP, CAP], seed=1, prompts=prompts)]
    for name, got, want in (('single, guard off', single_off, None),
                            ('single, guard on', single_on, expected),
                            ('batch, guard off', batch_off, [None, None]),
                            ('batch, guard on', batch_on, [expected, expected])):
        ok = got == want
        print(f'  {"ok  " if ok else "FAIL"} {name}: first exit at {got}, expected {want}')
        if not ok:
            failures.append(name)
    print(f'stall guard through the real MLX loops: {4 - len(failures)}/4')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
