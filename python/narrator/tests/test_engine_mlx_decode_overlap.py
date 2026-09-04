"""_convert_mlx_batch must finish every row exactly once whether the decode runs
on the decoder thread or serially after the batch.

Ported from ebook2audiobook@9daab0ba tools/test_mlx_decode_overlap.py to
unittest and to narrator.engine.OrpheusEngine. Same fake BatchGenerator, same
six rows, same assertions; only the module paths and the harness changed.

REQUIRES mlx: the stream plumbing under test (new_thread_unsafe_stream +
mx.stream in another thread) is genuinely exercised, pinned to the CPU device.
It needs no model and no GPU, but a machine with no mlx SKIPS - which today is
every machine but the Mac. THIS PORT HAS NOT BEEN RUN; see PORT_NOTES.md
"Could not verify".

WHAT IS BEING PROVED. A retired row used to wait for the slowest row of its
batch before anything was decoded; now it is handed to ONE decoder thread the
moment its finish_reason lands (ORPHEUS_MLX_DECODE_OVERLAP=1, the default), and
that thread does the model-free half only. The split is the whole risk surface:

  * every row lands in the returned list exactly once, mapped to ITS OWN audio,
    in BOTH modes and with the same values;
  * a cap-hit row and a guard-rerender row are finished on the MAIN thread AFTER
    the batch - _generate_mlx_safe is never called from the decoder thread, so
    the single-sentence path never runs next to a live BatchGenerator;
  * a decode exception fails ONE row (False) and leaves the others alone;
  * rows really are written while the batch is still generating (saves are
    recorded before close());
  * the decoder thread is joined - nothing outlives the call.

HOW. mlx_lm.generate.BatchGenerator is replaced with a fake that retires rows on
a fixed schedule, mlx_audio's llama module (which loads SNAC weights at import)
is stubbed in sys.modules, and the engine's parse_output / _save_audio /
_needs_resplit / _generate_mlx_safe / _keep_reject are fakes that record the
THREAD they ran on.
"""
import importlib
import os
import sys
import threading
import time
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
    _HAS_MLX = True
except Exception:                      # noqa: BLE001 - any import failure = skip
    mx = None
    _HAS_MLX = False

DEPTH = 5            # token cap for the fake batch - small so a cap hit is cheap
MARKER_BATCH = 1000  # audio value for a row decoded from its batch tokens
MARKER_RERENDER = 9000   # audio value for a row re-rendered by _generate_mlx_safe

# The fake batch: six rows, each exercising one branch.
#
#   0  plain row, retires early                      -> decoded, saved
#   1  plain row, retires later                      -> decoded, saved
#   2  hits the token cap (finish_reason 'length')   -> DEFERRED, re-rendered
#   3  clean stop but the guard says 'short'         -> DEFERRED, re-rendered
#   4  parse_output raises                           -> results False
#   5  NEVER reports a finish_reason                 -> swept up after close()
ROWS = [0, 1, 2, 3, 4, 5]
RETIRE_AT = {0: 2, 1: 4, 2: 6, 3: 3, 4: 5}   # step at which the row retires
# Row 5 never retires AND must not look capped, so it stops emitting after this
# step: its token list stays under DEPTH while the row remains live.
SILENT_AFTER = 3
CAP_ROW = 2
GUARD_ROW = 3
RAISE_ROW = 4
NEVER_RETIRES = 5
TOTAL_STEPS = 7          # the fake stops generating here, row 5 still unretired

ITEMS = [(i, f'S{i} ' + 'lorem ipsum ' * 30) for i in ROWS]

RECORDER = None


def _install_mlx_audio_stub():
    """SNAC's weights load at IMPORT of mlx_audio...llama, and this test must not
    load a model. Stub the module BEFORE anything can import it for real."""
    fake_llama = types.ModuleType('mlx_audio.tts.models.llama.llama')

    def _fake_decode_audio_from_codes(code_list):
        # One "waveform" per row, carrying the row's marker code so a save can be
        # traced back to the row it came from.
        return [[float(code_list[0])] * 4]

    fake_llama.decode_audio_from_codes = _fake_decode_audio_from_codes
    for name in ('mlx_audio', 'mlx_audio.tts', 'mlx_audio.tts.models',
                 'mlx_audio.tts.models.llama'):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules['mlx_audio.tts.models.llama.llama'] = fake_llama


class FakeResponse:
    __slots__ = ('uid', 'token', 'finish_reason')

    def __init__(self, uid, token, finish_reason):
        self.uid = uid
        self.token = token
        self.finish_reason = finish_reason


class Recorder:
    """Every observable event, in order, with the thread that produced it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.events = []

    def add(self, kind, **fields):
        with self.lock:
            fields['kind'] = kind
            fields['thread'] = threading.current_thread().name
            fields['seq'] = len(self.events)
            self.events.append(fields)
            return fields

    def of(self, kind):
        with self.lock:
            return [e for e in self.events if e['kind'] == kind]


class FakeBatchGenerator:
    """Retires rows on RETIRE_AT. `before_close` lets the test wait for the
    decoder thread to have written something WHILE generation is still live."""

    before_close = None

    def __init__(self, *_args, **_kwargs):
        self.uids = []
        self.step = 0
        self.retired = set()

    def insert(self, prompts, max_tokens=None, logits_processors=None):
        # Per-row max_tokens is what the continuous path needs; the group path
        # passes [depth] * n, which is BatchGenerator's own default. Either way
        # the fake records it so the cap check can be read back.
        self.uids = [f'u{i}' for i in range(len(prompts))]
        self.max_tokens = list(max_tokens) if max_tokens else [DEPTH] * len(prompts)
        return list(self.uids)

    def next_generated(self):
        if self.step >= TOTAL_STEPS:
            return []
        self.step += 1
        responses = []
        for row, uid in enumerate(self.uids):
            if uid in self.retired:
                continue
            retire_at = RETIRE_AT.get(row)
            if retire_at is not None and self.step >= retire_at:
                self.retired.add(uid)
                # 'length' rows keep their last token (the cap), 'stop' rows
                # drop it - exactly what the real BatchGenerator reports.
                reason = 'length' if row == CAP_ROW else 'stop'
                responses.append(FakeResponse(uid, 7, reason))
            elif retire_at is not None or self.step <= SILENT_AFTER:
                responses.append(FakeResponse(uid, 7, None))
        return responses

    def close(self):
        if FakeBatchGenerator.before_close is not None:
            FakeBatchGenerator.before_close()
        RECORDER.add('close')


class FakeMlxModel:
    def prepare_input_ids(self, clean, voice):
        # A [1, T] array whose [0].tolist() is the prompt token list. The first
        # token is the row's marker, so parse_output can tell rows apart.
        idx = int(clean.split()[0][1:])
        return mx.array([[MARKER_BATCH + idx, 1, 2]])

    def parse_output(self, ids):
        marker = ids.tolist()[0][0]
        RECORDER.add('parse_output', marker=marker)
        if marker - MARKER_BATCH == RAISE_ROW:
            raise RuntimeError('synthetic parse_output failure')
        return [[marker]]


def build_engine(overlap):
    from narrator.engine import OrpheusEngine
    eng = OrpheusEngine.__new__(OrpheusEngine)
    eng.voice = 'testvoice'
    eng.mlx_model = FakeMlxModel()
    eng.MLX_DECODE_OVERLAP = overlap
    eng.MLX_DECODE_JOIN_SECONDS = 30.0
    # This file tests the FRESH-GROUP path (the _mlx_batch_groups stub below is
    # what it drives). Continuous batching has its own file.
    eng.MLX_CONTINUOUS = False
    eng.MLX_MAX_TOKENS = DEPTH
    eng._rate_ceilings = {}

    eng._classify_gap = lambda sentence: (0.0, 0.0)
    eng._clean_sentence_for_tts = lambda sentence: sentence
    eng._mlx_token_budget = lambda clean: DEPTH
    eng._mlx_batch_groups = lambda gen: [(list(gen), DEPTH)]
    eng._voice_cap = lambda key, voice=None: {
        'temperature': 0.6, 'topP': 0.8, 'minP': 0.0, 'repPenalty': 1.1,
    }.get(key, 0.0)
    eng._mlx_eos_boost_processor = lambda n_chars: None
    eng.convert = lambda idx, sentence: RECORDER.add('convert', idx=idx) and False

    def fake_save_audio(idx, audio, lead, trail):
        RECORDER.add('save', idx=idx,
                     value=(float(audio[0]) if audio is not None and len(audio) else None))
        return True
    eng._save_audio = fake_save_audio

    def fake_needs_resplit(idx, clean, audio_np, voice=None):
        RECORDER.add('verdict', idx=idx)
        return 'short' if idx == GUARD_ROW else None
    eng._needs_resplit = fake_needs_resplit

    def fake_generate_mlx_safe(clean, depth=0, force_split=False):
        idx = int(clean.split()[0][1:])
        RECORDER.add('rerender', idx=idx, force_split=force_split)
        return np.array([float(MARKER_RERENDER + idx)] * 4, dtype=np.float32)
    eng._generate_mlx_safe = fake_generate_mlx_safe

    def fake_keep_reject(idx, clean, audio_np, reason, detail=None):
        RECORDER.add('keep_reject', idx=idx, reason=reason)
    eng._keep_reject = fake_keep_reject

    def fake_ratchet(clean, audio_np, voice=None):
        RECORDER.add('ratchet')
    eng._ratchet_after_resplit = fake_ratchet
    return eng


def run(overlap, before_close=None):
    global RECORDER
    mlx_lm_generate = importlib.import_module('mlx_lm.generate')
    RECORDER = Recorder()
    FakeBatchGenerator.before_close = before_close
    stock = mlx_lm_generate.BatchGenerator
    mlx_lm_generate.BatchGenerator = FakeBatchGenerator
    try:
        return build_engine(overlap)._convert_mlx_batch(ITEMS), RECORDER
    finally:
        mlx_lm_generate.BatchGenerator = stock
        FakeBatchGenerator.before_close = None


def expected_values():
    """idx -> the audio value its save must carry (None = the row must fail)."""
    want = {i: float(MARKER_BATCH + i) for i in ROWS}
    want[CAP_ROW] = float(MARKER_RERENDER + CAP_ROW)
    want[GUARD_ROW] = float(MARKER_RERENDER + GUARD_ROW)
    want[RAISE_ROW] = None
    return want


@unittest.skipUnless(_HAS_MLX, 'mlx is not installed (Mac only)')
class MlxDecodeOverlapTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        _install_mlx_audio_stub()
        cls.out_serial, cls.rec_serial = run(overlap=False)

        # Hold close() until the decoder thread has written the rows that retired
        # early - that is what "overlapped" means, and without the wait the
        # assertion would be a race rather than a proof.
        def wait_for_early_saves():
            deadline = time.time() + 10.0
            while time.time() < deadline:
                if len(RECORDER.of('save')) >= 2:
                    return
                time.sleep(0.01)

        cls.out_overlap, cls.rec_overlap = run(overlap=True,
                                               before_close=wait_for_early_saves)
        cls.main_name = threading.current_thread().name

    def _assert_common(self, label, out, rec):
        want = expected_values()
        self.assertEqual(len(out), len(ITEMS), f'{label}: one result per item')
        self.assertEqual(out, [want[i] is not None for i in ROWS],
                         f'{label}: results aligned to items')

        saves = rec.of('save')
        saved_idx = [e['idx'] for e in saves]
        expected_saved = sorted(i for i in ROWS if want[i] is not None)
        self.assertEqual(sorted(saved_idx), expected_saved,
                         f'{label}: every finishable row saved exactly once')
        self.assertEqual(len(saved_idx), len(set(saved_idx)), f'{label}: no row saved twice')
        self.assertTrue(all(e['value'] == want[e['idx']] for e in saves),
                        f'{label}: each save must carry ITS OWN audio '
                        f'({ {e["idx"]: e["value"] for e in saves} })')

        rerendered = sorted(e['idx'] for e in rec.of('rerender'))
        self.assertEqual(rerendered, sorted([CAP_ROW, GUARD_ROW]),
                         f'{label}: exactly the cap row and the guard row re-rendered')
        self.assertTrue(all(e['force_split'] for e in rec.of('rerender')),
                        f'{label}: every re-render asked for force_split')
        self.assertEqual([e['reason'] for e in rec.of('keep_reject')], ['cap'],
                         f'{label}: the cap row kept its runaway as evidence')
        self.assertEqual(len(rec.of('ratchet')), 1,
                         f'{label}: the ratchet fired once, for the short row')
        self.assertEqual(rec.of('convert'), [],
                         f'{label}: no row fell back to the per-item convert() recovery')

    def test_serial_path(self):
        self._assert_common('serial', self.out_serial, self.rec_serial)
        off_main = [e for e in self.rec_serial.events if e['thread'] != self.main_name]
        self.assertEqual(off_main, [], 'serial: everything ran on the main thread')
        close_seq = self.rec_serial.of('close')[0]['seq']
        self.assertTrue(all(e['seq'] > close_seq for e in self.rec_serial.of('save')),
                        'serial: every save happened AFTER the batch closed')

    def test_overlap_path_is_equivalent(self):
        self._assert_common('overlap', self.out_overlap, self.rec_overlap)
        self.assertEqual(self.out_overlap, self.out_serial,
                         'overlap: identical result list to the serial path')

    def test_rows_are_written_while_the_batch_is_still_generating(self):
        close_seq = self.rec_overlap.of('close')[0]['seq']
        early = [e for e in self.rec_overlap.of('save') if e['seq'] < close_seq]
        self.assertGreaterEqual(len(early), 2,
                                f'rows written before close: {[e["idx"] for e in early]}')

    def test_the_split_between_the_threads(self):
        worker_saves = {e['idx'] for e in self.rec_overlap.of('save')
                        if e['thread'].startswith('orpheus-mlx-decode')}
        self.assertEqual(worker_saves, {0, 1, NEVER_RETIRES},
                         'the plain rows are saved by the decoder thread')
        main_saves = {e['idx'] for e in self.rec_overlap.of('save')
                      if e['thread'] == self.main_name}
        self.assertEqual(main_saves, {CAP_ROW, GUARD_ROW},
                         'the deferred rows are saved by the MAIN thread')
        verdict_threads = {e['thread'] for e in self.rec_overlap.of('verdict')}
        self.assertTrue(verdict_threads
                        and verdict_threads.issubset({'orpheus-mlx-decode-1'}),
                        f'the truncation VERDICT is taken on the decoder thread '
                        f'({verdict_threads})')

    def test_the_model_never_runs_next_to_a_live_batch(self):
        close_seq = self.rec_overlap.of('close')[0]['seq']
        rerender_threads = {e['thread'] for e in self.rec_overlap.of('rerender')}
        self.assertEqual(rerender_threads, {self.main_name},
                         '_generate_mlx_safe ran ONLY on the main thread')
        self.assertEqual({e['thread'] for e in self.rec_overlap.of('keep_reject')},
                         {self.main_name},
                         '_keep_reject for the cap row ran on the main thread')
        self.assertTrue(all(e['seq'] > close_seq for e in self.rec_overlap.of('rerender')),
                        'every model re-render happened AFTER bg.close()')

    def test_a_decode_exception_fails_one_row_alone(self):
        self.assertIs(self.out_overlap[RAISE_ROW], False)
        self.assertEqual(sum(1 for v in self.out_overlap if v), 5,
                         'the other five rows survived')

    def test_no_decoder_thread_outlives_the_call(self):
        live = [t.name for t in threading.enumerate()
                if t.name.startswith('orpheus-mlx-decode')]
        self.assertEqual(live, [])


if __name__ == '__main__':
    unittest.main()
