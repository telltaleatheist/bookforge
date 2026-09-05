"""The EOS minimum-length floor forbids an early stop and touches nothing else.

Ported from ebook2audiobook@9daab0ba tools/test_eos_floor.py (2026-09-03), to
unittest and to narrator.engine.OrpheusEngine. Every case is the same; the
`engine()` helper builds a bare instance the same way (`__new__`, no model).

THE DEFECT. On the mistborn 240-draw battery every fine-tune shows EARLY stops
at 30-60% of the text (ASR-verified), 5-15 per 240 depending on epoch, on top
of the loops the EOS boost exists for. The served models only ever caught the
fast ones after the fact - the maxCharsPerSec rate guard flags the clip and it
is re-rendered. The floor refuses END_OF_SPEECH at decode time instead: while a
request has generated fewer than eosFloor x expected audio tokens (expected =
chars / eosFloorRate x 84), the EOS logit is -inf.

WHAT THIS PROVES, driving the real processor (no GPU, no model, no torch):
  1. the floor forbids EOS below its line and nothing at or above it;
  2. a read at the voice's own truncation-guard rate (the fastest read the
     pipeline calls honest) clears the floor at every chunk size, so the floor
     can only ever remove a stop the guard would have rejected anyway;
  3. a truncation at 0.3-0.6 of expected lands inside the floor;
  4. the boost's ramp is byte-for-byte unchanged by the floor: at every token
     past the boost start the EOS bias equals the boost-only processor's;
  5. a floor tighter than the guard is REFUSED at construction, not rendered;
  6. the caps cross register_voice_caps by their catalog names, a floor of 0
     builds no processor for an unboosted voice, and the MLX processor raises
     rather than render silently without a configured floor.
"""
import math
import os
import sys
import unittest

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import OrpheusEngine  # noqa: E402

EOS = OrpheusEngine.END_OF_AUDIO_TOKEN
TPS = OrpheusEngine.TOKENS_PER_AUDIO_SECOND

# thirdreich's live catalog guard (2026-09-03) with the floor at the shipped
# default; boost values are deathstalker's so the ramp assertion has a ramp.
VOICE = 'floor-test'
GUARD = 20.5
FLOOR, RATE = 0.55, 15.0
CAPS = {'repPenalty': 1.1, 'eosBoost': 8, 'eosBoostStart': 2, 'maxCharsPerSec': GUARD,
        'eosFloor': FLOOR, 'eosFloorRate': RATE}

CHUNK_SIZES = (4, 13, 48, 100, 200, 350, 450, 540)


def engine(voice, caps):
    """A bare instance: every method under test reads only class attributes and
    the registered caps, so __init__ (which loads a model) is not needed."""
    OrpheusEngine.register_voice_caps(voice, dict(caps))
    tts = OrpheusEngine.__new__(OrpheusEngine)
    tts.voice = voice
    return tts


def eos_logit_after(proc, n):
    """The EOS logit the real processor leaves on a zero row after `n` generated
    tokens."""
    logits = np.zeros(EOS + 1, dtype=np.float64)
    proc(list(range(n)), logits)
    return logits[EOS]


def first_allowed(proc, limit):
    """The first token index at which EOS is NOT -inf (probed, not re-derived)."""
    for n in range(0, limit):
        if not math.isinf(eos_logit_after(proc, n)):
            return n
    raise AssertionError(f'EOS never allowed within {limit} tokens')


def tokens_at_rate(chars, chars_per_sec):
    return chars / chars_per_sec * TPS


class EosFloorTest(unittest.TestCase):

    def setUp(self):
        # A fresh announcement set per test keeps the "announced once per voice"
        # print out of the assertions and out of the other tests' output.
        OrpheusEngine._eos_floor_announced = set()
        self.tts = engine(VOICE, CAPS)

    def test_floor_forbids_eos_below_its_line_and_nothing_above(self):
        for chars in CHUNK_SIZES:
            with self.subTest(chars=chars):
                proc = self.tts._eos_boost_processor(chars)
                expected_floor = FLOOR * chars / RATE * TPS
                allowed = first_allowed(proc, 4 * OrpheusEngine.MAX_AUDIO_TOKENS)
                self.assertEqual(allowed, math.ceil(expected_floor),
                                 f'{chars} chars: floor is {expected_floor:.2f}')
                at_zero = eos_logit_after(proc, 0)
                self.assertTrue(math.isinf(at_zero) and at_zero < 0,
                                f'{chars} chars: EOS must be -inf at token 0')
                self.assertEqual(eos_logit_after(proc, allowed), 0.0,
                                 f'{chars} chars: EOS untouched right at the floor')

    def test_a_read_at_the_guard_rate_clears_the_floor(self):
        """THE INVARIANT that makes the floor safe: it forbids EOS exactly on a
        read faster than eosFloorRate / eosFloor ch/s (15 / 0.55 = 27.3), and a
        read that fast is one the rate guard would already reject."""
        for chars in CHUNK_SIZES:
            with self.subTest(chars=chars):
                proc = self.tts._eos_boost_processor(chars)
                honest = tokens_at_rate(chars, GUARD)
                self.assertFalse(math.isinf(eos_logit_after(proc, int(honest))),
                                 f'{chars} chars read at {GUARD} ch/s must be allowed to stop')

    def test_a_truncation_lands_inside_the_floor(self):
        for chars in (100, 450, 540):
            proc = self.tts._eos_boost_processor(chars)
            expected = chars / RATE * TPS
            for frac in (0.3, 0.45, 0.5):
                with self.subTest(chars=chars, frac=frac):
                    n = int(frac * expected)
                    self.assertTrue(math.isinf(eos_logit_after(proc, n)),
                                    f'{chars} chars stopping at {frac:.2f} x expected '
                                    f'({n} tokens) must be forbidden')

    def test_the_boost_ramp_is_unchanged_by_the_floor(self):
        boost_only = engine('boost-only', {k: v for k, v in CAPS.items()
                                           if k not in ('eosFloor', 'eosFloorRate')})
        for chars in (13, 48, 200, 450, 540):
            with self.subTest(chars=chars):
                with_floor = self.tts._eos_boost_processor(chars)
                without = boost_only._eos_boost_processor(chars)
                start = CAPS['eosBoostStart'] * self.tts._expected_audio_tokens(chars)
                floor_line = FLOOR * chars / RATE * TPS
                self.assertLess(floor_line, start,
                                f'{chars} chars: the floor must sit below the boost start')
                mismatches = [
                    n for n in range(int(floor_line) + 1,
                                     int(start) + 3 * int(self.tts._expected_audio_tokens(chars)))
                    if eos_logit_after(with_floor, n) != eos_logit_after(without, n)
                ]
                self.assertEqual(mismatches, [],
                                 f'{chars} chars: the floored processor must equal the '
                                 'boost-only one at every token above the floor')
                self.assertGreater(eos_logit_after(with_floor, int(start) + 50), 0,
                                   f'{chars} chars: the boost must still engage past its start')

    def test_a_floor_tighter_than_the_guard_is_refused(self):
        tight = engine('too-tight', dict(CAPS, eosFloor=0.8))   # 15 / 0.8 = 18.75 < 20.5
        with self.assertRaises(ValueError) as ctx:
            tight._eos_boost_processor(450)
        self.assertIn('tighter than its truncation guard', str(ctx.exception))

    def test_with_the_guard_disabled_the_same_floor_is_accepted(self):
        unguarded = engine('unguarded', dict(CAPS, eosFloor=0.8, maxCharsPerSec=0))
        self.assertIsNotNone(unguarded._eos_boost_processor(450))

    def test_out_of_range_floor_configurations_raise(self):
        for bad in ({'eosFloor': 1.0}, {'eosFloor': 1.5}, {'eosFloorRate': 0}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    engine('bad', dict(CAPS, **bad))._eos_boost_processor(450)

    def test_caps_cross_the_registry_by_their_catalog_names(self):
        stored = OrpheusEngine.register_voice_caps('reg', {'eosFloor': 0.55,
                                                           'eosFloorRate': 16.47})
        self.assertEqual(stored, {'eosFloor': 0.55, 'eosFloorRate': 16.47})

    def test_floor_zero_on_an_unboosted_voice_builds_no_processor(self):
        off = engine('off', {'maxCharsPerSec': GUARD, 'eosFloor': 0})
        self.assertIsNone(off._eos_boost_processor(450),
                          'an untuned voice must pay nothing')

    def test_floor_zero_on_a_boosted_voice_leaves_early_eos_untouched(self):
        off_boosted = engine('off-boosted', {'maxCharsPerSec': GUARD, 'eosFloor': 0,
                                             'eosBoost': 8, 'eosBoostStart': 2})
        proc = off_boosted._eos_boost_processor(450)
        self.assertIsNotNone(proc)
        self.assertEqual(eos_logit_after(proc, 0), 0.0)

    def test_the_mlx_processor_refuses_a_configured_floor(self):
        """vLLM-only: mlx-lm's processor counts PROMPT tokens in its context, so
        the same arithmetic would land the floor in the wrong place there. A voice
        tuned with a floor would otherwise render a whole book on the Mac without
        it and nothing would say so."""
        with self.assertRaises(NotImplementedError) as ctx:
            self.tts._mlx_eos_boost_processor(450)
        self.assertIn('vLLM-only', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
