"""Continuous batching must finish every row exactly once, at its OWN token cap.

Ported from ebook2audiobook@9daab0ba tools/test_mlx_continuous.py to unittest
and to narrator.engine.OrpheusEngine. Same fake scheduler, same 40-row slice,
same assertions - including the heartbeat regex, which is a BYTE-FOR-BYTE copy
of the one electron/mlx-batch-progress.ts:94 uses.

REQUIRES mlx (CPU device, no model, no GPU); a machine without it SKIPS - which
today is every machine but the Mac. THIS PORT HAS NOT BEEN RUN; see
PORT_NOTES.md "Could not verify".

WHAT IS BEING PROVED. With ORPHEUS_MLX_CONTINUOUS=1 (OFF by default; the switch
is set on the stub engine here) _convert_mlx_batch stops splitting a call into
fresh groups and hands ONE BatchGenerator every row up front; mlx-lm's scheduler
then refills a retired slot from its own queue instead of letting the tail of
each group decode at dwindling width. Three things change and each is asserted:

  * ONE generator, `completion_batch_size` = the memory-derived width and
    `prefill_batch_size` = min(width, MLX_CONTINUOUS_PREFILL) - not one
    generator per group;
  * the anti-runaway ceiling is now PER ROW (`insert(max_tokens=[...])`), so the
    cap-hit test after retirement must compare a row's token count against THAT
    row's cap. A row with a small budget sitting next to a long one must be
    caught at its own cap, and a long row that stops cleanly past a SHORT row's
    cap must NOT be mistaken for a runaway;
  * every one of the 40 rows lands in `results` exactly once, mapped to its own
    audio, with the decode-overlap hand-off unchanged;
  * the heartbeat's ` live N` field never exceeds the width (it is what tells
    the A/B apart in the log), and it does reach the width - i.e. refill really
    happened rather than the queue draining as one wide group.

And the kill switch: ORPHEUS_MLX_CONTINUOUS=0 reproduces the fresh-group path -
five generators for 40 rows at width 8, each with a UNIFORM cap equal to its
group's depth, and no ` live ` field in the heartbeat.
"""
import importlib
import os
import re
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

def _mlx_import_error(exc: BaseException) -> bool:
    """True only for "MLX is not installed here".

    NARROW ON PURPOSE (found on the Mac, 2026-09-04). This guard used to be a
    bare `except Exception`, so an ImportError raised by narrator's OWN layout -
    a module moved, a name not re-exported - was reported as "mlx is not
    installed (Mac only)" and SKIPPED 25 tests on a machine that has mlx. A skip
    that hides a broken import is worse than a failure: the suite goes green on
    the one machine that can actually exercise this code. Anything that is not
    an ImportError naming an mlx package is re-raised.
    """
    if not isinstance(exc, ImportError):
        return False
    name = (getattr(exc, 'name', '') or '').split('.')[0]
    return name in ('mlx', 'mlx_lm', 'mlx_audio')


try:
    import mlx.core as mx
    mx.set_default_device(mx.cpu)
    _HAS_MLX = True
except ImportError as exc:
    if not _mlx_import_error(exc):
        raise
    mx = None
    _HAS_MLX = False

# The book slice: 40 rows, width 8, prefill 3.
#
#   row 5   long budget, runs away            -> retires 'length' at cap 30
#   row 11  SHORT budget (6), runs away       -> retires 'length' at cap 6
#                                                (a depth-based check would
#                                                 miss it: 6 < 30)
#   row 17  long budget, stops cleanly at 20  -> 19 tokens, well past row 11's
#                                                cap, and must NOT be flagged
#   everything else                           -> stops cleanly in 3-9 tokens
N_ROWS = 40
WIDTH = 8
PREFILL = 3
MAX_TOKENS = 30           # MLX_MAX_TOKENS for this test
LONG_BUDGET = 30
SHORT_BUDGET = 6

CAP_ROW = 5               # hits its (long) cap
SHORT_CAP_ROW = 11        # hits its own SHORT cap
LONG_CLEAN_ROW = 17       # stops cleanly past the short row's cap

MARKER_BATCH = 1000
MARKER_RERENDER = 9000
RUNAWAY = 10 ** 6         # "would generate forever": always hits the cap

BUDGET = {i: LONG_BUDGET for i in range(N_ROWS)}
BUDGET[SHORT_CAP_ROW] = SHORT_BUDGET

PLAN = {i: 3 + (i % 7) for i in range(N_ROWS)}   # tokens before a clean stop
PLAN[CAP_ROW] = RUNAWAY
PLAN[SHORT_CAP_ROW] = RUNAWAY
PLAN[LONG_CLEAN_ROW] = 20

ITEMS = [(i, f'S{i} ' + 'lorem ipsum ' * 20) for i in range(N_ROWS)]

# BYTE-FOR-BYTE the pattern electron/mlx-batch-progress.ts uses (line 94), with
# an end anchor added so a trailing field could not slip past unnoticed.
HB = re.compile(
    r'\[ORPHEUS\] MLX batch generating: (\d+) rows, ~(\d+) tokens '
    r'\(step (\d+)/(\d+)\), (\d+)/(\d+) rows done, batch (\d+)/(\d+)(?: live (\d+))?$')


def _install_mlx_audio_stub():
    """SNAC's weights load at IMPORT of mlx_audio...llama; stub it first."""
    fake_llama = types.ModuleType('mlx_audio.tts.models.llama.llama')

    def _fake_decode_audio_from_codes(code_list):
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


class FakeBatchGenerator:
    """The real scheduler's shape, minus the model.

    Mirrors BatchGenerator._next in the order that matters: GENERATE for every
    live row first, THEN refill retired slots from the queue (bounded by
    completion_batch_size and prefill_batch_size). A queued row therefore reports
    for the first time on the step AFTER it is admitted, which is the property
    `live` in the heartbeat is derived from.
    """

    instances = []

    def __init__(self, model, *, max_tokens=None, stop_tokens=None, sampler=None,
                 logits_processors=None, completion_batch_size=1,
                 prefill_batch_size=1, **kwargs):
        self.default_max_tokens = max_tokens
        self.completion_batch_size = completion_batch_size
        self.prefill_batch_size = prefill_batch_size
        self.queue = []
        self.live = {}          # uid -> tokens emitted so far
        self.caps = {}          # uid -> the max_tokens this row was inserted with
        self.plan = {}
        self.inserted_max_tokens = None
        self.max_live_seen = 0
        self.closed = False
        FakeBatchGenerator.instances.append(self)

    def insert(self, prompts, max_tokens=None, logits_processors=None):
        caps = (list(max_tokens) if max_tokens is not None
                else [self.default_max_tokens] * len(prompts))
        self.inserted_max_tokens = list(caps)
        uids = []
        for prompt, cap in zip(prompts, caps):
            idx = prompt[0] - MARKER_BATCH
            uid = f'u{idx}'
            self.caps[uid] = cap
            self.plan[uid] = PLAN[idx]
            self.queue.append(uid)
            uids.append(uid)
        return uids

    def _step_once(self):
        responses = []
        for uid in list(self.live):
            self.live[uid] += 1
            n = self.live[uid]
            if n >= self.caps[uid]:
                responses.append(FakeResponse(uid, 7, 'length'))
                del self.live[uid]
            elif n >= self.plan[uid]:
                # 'stop' drops its token, exactly as the real one does.
                responses.append(FakeResponse(uid, 7, 'stop'))
                del self.live[uid]
            else:
                responses.append(FakeResponse(uid, 7, None))
        room = self.completion_batch_size - len(self.live)
        for _ in range(min(room, self.prefill_batch_size, len(self.queue))):
            self.live[self.queue.pop(0)] = 0
        self.max_live_seen = max(self.max_live_seen, len(self.live))
        return responses

    def next_generated(self):
        # Real next_generated() spins until it has GENERATION responses (a step
        # that only prefilled returns nothing to the caller).
        while True:
            responses = self._step_once()
            if responses:
                return responses
            if not self.live and not self.queue:
                return []

    def close(self):
        self.closed = True


class FakeMlxModel:
    def prepare_input_ids(self, clean, voice):
        idx = int(clean.split()[0][1:])
        return mx.array([[MARKER_BATCH + idx, 1, 2]])

    def parse_output(self, ids):
        return [[ids.tolist()[0][0]]]


class Tee:
    """Keep the printed lines so the heartbeat can be asserted on."""

    def __init__(self, real):
        self.real = real
        self.lines = []
        self._buf = ''
        self._lock = threading.Lock()

    def write(self, s):
        with self._lock:
            self._buf += s
            while '\n' in self._buf:
                line, self._buf = self._buf.split('\n', 1)
                self.lines.append(line)
        return len(s)

    def flush(self):
        pass


class Events:
    def __init__(self):
        self.lock = threading.Lock()
        self.saves = []        # (idx, value, thread)
        self.rerenders = []    # idx
        self.rejects = []      # (idx, token_cap)
        self.converts = []     # idx


def build_engine(continuous, events):
    from narrator.engine import OrpheusEngine
    eng = OrpheusEngine.__new__(OrpheusEngine)
    eng.voice = 'testvoice'
    eng.mlx_model = FakeMlxModel()
    eng.backend = 'mlx'
    eng.MLX_DECODE_OVERLAP = True
    eng.MLX_DECODE_JOIN_SECONDS = 30.0
    eng.MLX_CONTINUOUS = continuous
    eng.MLX_CONTINUOUS_PREFILL = PREFILL
    eng.MLX_MAX_TOKENS = MAX_TOKENS
    eng.BATCH_SIZE = WIDTH
    eng._rate_ceilings = {}

    eng._classify_gap = lambda sentence: (0.0, 0.0)
    eng._clean_sentence_for_tts = lambda sentence: sentence
    eng._mlx_token_budget = lambda clean: BUDGET[int(clean.split()[0][1:])]
    # Both paths get the SAME width rule; only the scheduling differs.
    eng._mlx_width_for_depth = lambda depth, steady=False: WIDTH
    eng._voice_cap = lambda key, voice=None: {
        'temperature': 0.6, 'topP': 0.8, 'minP': 0.0, 'repPenalty': 1.1,
    }.get(key, 0.0)
    eng._mlx_eos_boost_processor = lambda n_chars: None

    def fake_convert(idx, sentence):
        with events.lock:
            events.converts.append(idx)
        return False
    eng.convert = fake_convert

    def fake_save_audio(idx, audio, lead, trail):
        with events.lock:
            events.saves.append((idx,
                                 float(audio[0]) if audio is not None and len(audio) else None,
                                 threading.current_thread().name))
        return True
    eng._save_audio = fake_save_audio

    eng._needs_resplit = lambda idx, clean, audio, voice=None: None

    def fake_generate_mlx_safe(clean, depth=0, force_split=False):
        idx = int(clean.split()[0][1:])
        with events.lock:
            events.rerenders.append(idx)
        return np.array([float(MARKER_RERENDER + idx)] * 4, dtype=np.float32)
    eng._generate_mlx_safe = fake_generate_mlx_safe

    def fake_keep_reject(idx, clean, audio, reason, detail=None):
        with events.lock:
            events.rejects.append((idx, (detail or {}).get('token_cap')))
    eng._keep_reject = fake_keep_reject

    eng._ratchet_after_resplit = lambda clean, audio, voice=None: None
    return eng


def run(continuous):
    """One _convert_mlx_batch call against the fake, with the heartbeat's 10 s
    throttle defeated (fake clock jumps 11 s per reading) so EVERY step prints a
    line and `live` can be checked over the whole run."""
    mlx_lm_generate = importlib.import_module('mlx_lm.generate')
    events = Events()
    FakeBatchGenerator.instances = []
    stock_gen = mlx_lm_generate.BatchGenerator
    stock_time = time.time
    tee = Tee(sys.stdout)
    clock = [0.0]

    def fake_time():
        clock[0] += 11.0
        return clock[0]

    mlx_lm_generate.BatchGenerator = FakeBatchGenerator
    time.time = fake_time
    real_stdout = sys.stdout
    sys.stdout = tee
    # The heartbeat is an ENGINE log line, and the engine's log stream is the
    # HOST's to choose (narrator/engine/log.py): it defaults to stderr, because
    # narrator.serve's stdout is the JSON protocol. Swapping sys.stdout alone
    # therefore no longer captures it - point the engine's own channel at the
    # Tee. Both are swapped so a line that somehow still went to stdout is
    # caught here rather than in production.
    from narrator.engine.log import set_log_stream
    set_log_stream(tee)
    try:
        out = build_engine(continuous, events)._convert_mlx_batch(ITEMS)
    finally:
        set_log_stream(None)
        sys.stdout = real_stdout
        time.time = stock_time
        mlx_lm_generate.BatchGenerator = stock_gen
    return out, events, tee.lines, list(FakeBatchGenerator.instances)


def heartbeats(lines):
    return [HB.match(line) for line in lines if HB.match(line)]


@unittest.skipUnless(_HAS_MLX, 'mlx is not installed (Mac only)')
class MlxContinuousTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        _install_mlx_audio_stub()
        cls.out_c, cls.ev_c, cls.lines_c, cls.gens_c = run(continuous=True)
        cls.out_g, cls.ev_g, cls.lines_g, cls.gens_g = run(continuous=False)

    # ---- continuous ---------------------------------------------------------

    def test_one_generator_for_the_whole_call(self):
        self.assertEqual(len(self.gens_c), 1)
        bg = self.gens_c[0]
        self.assertEqual(bg.completion_batch_size, WIDTH,
                         'completion_batch_size is the memory-derived width')
        self.assertEqual(bg.prefill_batch_size, PREFILL,
                         'prefill_batch_size is min(width, MLX_CONTINUOUS_PREFILL)')
        self.assertTrue(bg.closed, 'the generator was closed')
        self.assertLessEqual(bg.max_live_seen, WIDTH,
                             'the generator never held more than the width live')

    def test_the_anti_runaway_ceiling_is_per_row(self):
        bg = self.gens_c[0]
        self.assertEqual(len(bg.inserted_max_tokens or []), N_ROWS,
                         'insert() got a PER-ROW max_tokens list')
        self.assertEqual(bg.inserted_max_tokens[SHORT_CAP_ROW], SHORT_BUDGET)
        self.assertEqual(bg.inserted_max_tokens[CAP_ROW], LONG_BUDGET)
        rejects = dict(self.ev_c.rejects)
        self.assertEqual(rejects.get(SHORT_CAP_ROW), SHORT_BUDGET,
                         'the short-budget row was caught at ITS OWN cap, not the '
                         f'batch depth {MAX_TOKENS}')
        self.assertEqual(rejects.get(CAP_ROW), LONG_BUDGET,
                         'the long runaway was caught at its own cap')

    def test_a_long_clean_row_is_not_mistaken_for_a_runaway(self):
        values = {idx: value for idx, value, _ in self.ev_c.saves}
        self.assertNotIn(LONG_CLEAN_ROW, self.ev_c.rerenders)
        self.assertEqual(values[LONG_CLEAN_ROW], float(MARKER_BATCH + LONG_CLEAN_ROW),
                         f'a clean row {PLAN[LONG_CLEAN_ROW] - 1} tokens long - past row '
                         f'{SHORT_CAP_ROW}\'s cap of {SHORT_BUDGET} - must survive')

    def test_every_row_lands_exactly_once_with_its_own_audio(self):
        self.assertEqual(self.out_c, [True] * N_ROWS)
        saved = sorted(idx for idx, _, _ in self.ev_c.saves)
        self.assertEqual(saved, list(range(N_ROWS)), 'every row saved exactly once')
        values = {idx: value for idx, value, _ in self.ev_c.saves}
        want = {i: float(MARKER_BATCH + i) for i in range(N_ROWS)}
        want[CAP_ROW] = float(MARKER_RERENDER + CAP_ROW)
        want[SHORT_CAP_ROW] = float(MARKER_RERENDER + SHORT_CAP_ROW)
        self.assertEqual(values, want, 'each save carries ITS OWN audio')
        self.assertEqual(self.ev_c.converts, [],
                         'no row fell back to per-item convert()')
        self.assertEqual(sorted(self.ev_c.rerenders), sorted([CAP_ROW, SHORT_CAP_ROW]),
                         'exactly the two runaway rows were re-rendered')

    def test_the_continuous_heartbeat(self):
        hb = heartbeats(self.lines_c)
        self.assertGreater(len(hb), 5, 'the heartbeat fires every step')
        self.assertTrue(all(m.group(1) == str(N_ROWS) and m.group(7) == '1'
                            and m.group(8) == '1' for m in hb),
                        'the continuous heartbeat reports the whole call as batch 1/1')
        self.assertTrue(all(m.group(9) is not None for m in hb),
                        'every continuous heartbeat carries the additive ` live N` field')
        lives = [int(m.group(9)) for m in hb]
        self.assertLessEqual(max(lives), WIDTH, '`live` never exceeds the width')
        self.assertEqual(max(lives), WIDTH,
                         '`live` reaches the width - the scheduler really did refill')
        self.assertTrue(all(int(m.group(5)) <= int(m.group(6)) for m in hb),
                        'rows-done never exceeds the row count')
        done = [int(m.group(5)) for m in hb]
        self.assertEqual(done, sorted(done), 'rows-done is monotone')
        self.assertEqual(done[-1], N_ROWS, 'rows-done is exact at completion')

    def test_the_continuous_announcements(self):
        announce = [line for line in self.lines_c if 'MLX continuous batching' in line]
        self.assertEqual(len(announce), 1)
        self.assertTrue(announce[0].startswith(
            f'[ORPHEUS] MLX continuous batching ON: width {WIDTH}, prefill {PREFILL}, '
            f'{N_ROWS} rows queued'), announce)
        final = [line for line in self.lines_c if 'MLX continuous batch done' in line]
        self.assertEqual(len(final), 1)
        self.assertIn(' peak ', final[0])
        self.assertIn(' GB', final[0])

    # ---- the kill switch ----------------------------------------------------

    def test_fresh_groups_reproduce_the_pre_continuous_path(self):
        self.assertEqual(len(self.gens_g), N_ROWS // WIDTH,
                         'one BatchGenerator per group')
        self.assertTrue(all(g.completion_batch_size == WIDTH
                            and g.prefill_batch_size == WIDTH for g in self.gens_g),
                        'each group runs at its own full width, prefilled in one go')
        self.assertTrue(all(set(g.inserted_max_tokens) == {MAX_TOKENS}
                            for g in self.gens_g),
                        'the group path keeps a UNIFORM cap per group')
        self.assertTrue(all(len(g.inserted_max_tokens) == WIDTH for g in self.gens_g),
                        'each group holds exactly its own rows')
        self.assertEqual(self.out_g, [True] * N_ROWS)
        self.assertEqual(sorted(idx for idx, _, _ in self.ev_g.saves),
                         list(range(N_ROWS)), 'every row saved exactly once')
        self.assertEqual(self.ev_g.converts, [])

    def test_the_group_heartbeat_is_byte_identical_to_before(self):
        hb = heartbeats(self.lines_g)
        self.assertTrue(hb and all(m.group(9) is None for m in hb),
                        'no ` live ` field on the group path')
        self.assertEqual({m.group(8) for m in hb}, {str(N_ROWS // WIDTH)},
                         'the group heartbeat counts the groups')
        self.assertEqual(sorted({int(m.group(7)) for m in hb}),
                         list(range(1, N_ROWS // WIDTH + 1)),
                         'every group reported its own batch number')

    def test_the_kill_switch_announces_itself(self):
        announce = [line for line in self.lines_g if 'MLX continuous batching' in line]
        self.assertEqual(announce, ['[ORPHEUS] MLX continuous batching OFF: fresh groups'])
        self.assertEqual([line for line in self.lines_g
                          if 'MLX continuous batch done' in line], [],
                         'no continuous-done line on the group path')

    def test_the_one_deliberate_difference_between_the_paths(self):
        """On the group path a row's cap IS its group's depth; the per-row ceiling
        is exactly what continuous batching restores."""
        self.assertEqual(dict(self.ev_g.rejects).get(SHORT_CAP_ROW), MAX_TOKENS)


if __name__ == '__main__':
    unittest.main()
