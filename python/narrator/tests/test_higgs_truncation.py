"""The Higgs truncation ladder (`engine/higgs/truncation.py`) without a GPU.

Measured case (Fuhrer, PC/SGLang, 2026-09-06): chunk 19, 1,127 chars, 3.0 s of
audio - a mid-chunk early stop that reproduces at its seed. The ladder must
re-roll at ANOTHER seed, then split at a sentence boundary, and never refuse.
"""
import os
import sys
import unittest

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine.higgs import truncation, sgl_served, served_common  # noqa: E402
from narrator.engine.higgs.v3_engine import HiggsV3Config, HiggsV3Engine  # noqa: E402
from narrator.tests.test_higgs_sgl import SglTestCase, state_env  # noqa: E402

RATE = 24000
PACE = 17.0  # chars per second of a normal take on this voice


def audio_for(chars: int, cps: float = PACE) -> np.ndarray:
    return np.zeros(int(chars / cps * RATE), dtype=np.float32)


SENTENCES = ('It would be hard to say this about Nazism. '
             'The goal of national redemption through racial purification and a racial empire was a fantasy, a utopian idea. '
             'The cruelty and destruction that came from trying to achieve this goal are known to everyone. '
             'Its main feature was a lack of system, disorder in administration and government, and the breakdown of clear patterns of governance. ')
TEXT = (SENTENCES * 3).strip()   # ~1,300 chars, 12 sentences


class FakeRender:
    """A render whose behaviour is scripted per (text, seed): `short` says which
    calls stop early (3 s of audio, the chunk-19 shape); `long` says which run
    on (1.5x the expected audio, the chunk-48 shape)."""

    def __init__(self, short, long=lambda t, s, n: False):
        self.short = short
        self.long = long
        self.calls = []

    def __call__(self, text, seed):
        self.calls.append((text, seed))
        if self.short(text, seed, len(self.calls)):
            return audio_for(50)          # ~3 s: stopped after the first sentence
        if self.long(text, seed, len(self.calls)):
            return audio_for(int(len(text) * 1.5))   # a 26 s tail on a 52 s chunk
        return audio_for(len(text))


class GuardTest(unittest.TestCase):

    def test_chunk_19_is_truncated_by_the_policy_number(self):
        verdict = truncation.check('x' * 1127, audio_for(51), RATE, 20.0, 14.5)
        self.assertTrue(verdict.short)
        self.assertEqual(verdict.side, 'short')
        self.assertGreater(verdict.chars_per_second, 300)
        ok = truncation.check('x' * 1127, audio_for(1127), RATE, 20.0, 14.5)
        self.assertFalse(ok.off_length)
        self.assertFalse(truncation.check('x' * 1127, audio_for(51), RATE, 0, 0).off_length,
                         'thresholds of 0 disable the guard')

    def test_the_fuhrer_run_ons_are_long_by_the_policy_number(self):
        """Chunks 48/35/26 ran on at 1.54x/1.42x/1.24x of expectation; the
        1.11x one (chunk 41) is inside the band and left to the audit."""
        pace = 17.2
        for ratio, caught in ((1.54, True), (1.42, True), (1.24, True), (1.11, False), (1.10, False)):
            audio = np.zeros(int(1000 / pace * ratio * RATE), dtype=np.float32)
            verdict = truncation.check('x' * 1000, audio, RATE, 20.0, 14.5)
            self.assertEqual(verdict.long, caught, f'ratio {ratio}: {verdict}')
        # And every clean chunk of the render (0.94x-1.10x) is inside the band.
        for ratio in (0.94, 1.0, 1.10):
            audio = np.zeros(int(1000 / pace * ratio * RATE), dtype=np.float32)
            self.assertFalse(truncation.check('x' * 1000, audio, RATE, 20.0, 14.5).off_length, ratio)

    def test_a_run_on_is_rerolled_and_then_split_like_an_early_stop(self):
        render = FakeRender(lambda t, s, n: False, long=lambda t, s, n: t == TEXT)
        events = []
        out = truncation.render_guarded(render, TEXT, 48, sample_rate=RATE, max_chars_per_sec=20.0,
                                        min_chars_per_sec=14.5, base_seed=1234, on_event=events.append)
        self.assertEqual([e['action'] for e in events], ['long', 'resplit'])
        self.assertEqual(events[0]['side'], 'long')
        halves = truncation.split_halves(TEXT)
        expected = len(audio_for(len(halves[0]))) + len(audio_for(len(halves[1]))) \
            + int(round(truncation.RESPLIT_JOIN_SECONDS * RATE))
        self.assertEqual(len(out), expected)

    def test_at_the_bottom_the_take_nearest_the_expected_length_ships(self):
        # Take 0 far too long (3x), the re-roll far too short; nothing splits
        # (the text is one short sentence) -> the shorter miss ships? No: the
        # one CLOSEST to the band's centre - here the long one is 3x off and the
        # short one is ~7x off, so the long take ships.
        short_text = 'x' * 160    # over MIN_GUARD_CHARS, so the long side is judged
        render = FakeRender(lambda t, s, n: n == 2, long=lambda t, s, n: n == 1)
        render.long = lambda t, s, n: n == 1
        calls = {'n': 0}

        def scripted(text, seed):
            calls['n'] += 1
            render.calls.append((text, seed))
            return audio_for(480) if calls['n'] == 1 else audio_for(24)
        events = []
        out = truncation.render_guarded(scripted, short_text, 5, sample_rate=RATE, max_chars_per_sec=20.0,
                                        min_chars_per_sec=14.5, base_seed=1, on_event=events.append)
        self.assertEqual(events[-1]['action'], 'accepted-off-length')
        self.assertEqual(events[-1]['shipped_side'], 'long')
        self.assertEqual(len(out), len(audio_for(480)))

    def test_the_reroll_seed_differs_from_the_chunks_own_and_none_stays_none(self):
        self.assertNotEqual(truncation.reroll_seed(1234, 19, 1), 1234 + 19)
        self.assertNotEqual(truncation.reroll_seed(1234, 19, 1), truncation.reroll_seed(1234, 19, 2))
        self.assertIsNone(truncation.reroll_seed(None, 19, 1))

    def test_halves_cut_at_the_sentence_boundary_nearest_the_middle(self):
        parts = truncation.split_halves(TEXT)
        self.assertEqual(len(parts), 2)
        self.assertTrue(parts[0].endswith('.'))
        self.assertLess(abs(len(parts[0]) - len(parts[1])), 200)
        self.assertEqual(' '.join(parts), TEXT)
        self.assertEqual(truncation.split_halves('Too short to split.'), [])
        one = 'word ' * 60
        halves = truncation.split_halves(one.strip())
        self.assertEqual(len(halves), 2, 'a single long sentence splits at the middle space')

    def test_a_good_take_ships_untouched_with_no_event(self):
        render = FakeRender(lambda t, s, n: False)
        events = []
        out = truncation.render_guarded(render, TEXT, 19, sample_rate=RATE, max_chars_per_sec=20.0,
                                        base_seed=1234, on_event=events.append)
        self.assertEqual(len(render.calls), 1)
        self.assertEqual(render.calls[0], (TEXT, None), 'take 0 is the engine\'s own seed rule')
        self.assertEqual(events, [])
        self.assertEqual(len(out), len(audio_for(len(TEXT))))

    def test_an_early_stop_is_rerolled_at_another_seed_and_ships_the_reroll(self):
        render = FakeRender(lambda t, s, n: s is None)   # the chunk's own seed stops early, any other seed is fine
        events = []
        out = truncation.render_guarded(render, TEXT, 19, sample_rate=RATE, max_chars_per_sec=20.0,
                                        base_seed=1234, on_event=events.append)
        self.assertEqual([c[1] for c in render.calls], [None, truncation.reroll_seed(1234, 19, 1)])
        self.assertEqual([e['action'] for e in events], ['short', 'rerolled'])
        self.assertEqual(events[0]['index'], 19)
        self.assertEqual(len(out), len(audio_for(len(TEXT))))

    def test_a_stop_that_survives_the_reroll_is_split_and_each_half_rendered(self):
        # Every render of the WHOLE text stops early; halves render fine.
        render = FakeRender(lambda t, s, n: t == TEXT)
        events = []
        out = truncation.render_guarded(render, TEXT, 19, sample_rate=RATE, max_chars_per_sec=20.0,
                                        base_seed=1234, on_event=events.append)
        actions = [e['action'] for e in events]
        self.assertEqual(actions, ['short', 'resplit'])
        halves = truncation.split_halves(TEXT)
        self.assertEqual([c[0] for c in render.calls], [TEXT, TEXT] + halves)
        expected = len(audio_for(len(halves[0]))) + len(audio_for(len(halves[1]))) \
            + int(round(truncation.RESPLIT_JOIN_SECONDS * RATE))
        self.assertEqual(len(out), expected, 'the halves are joined with the sentence pause')

    def test_the_ladder_never_refuses_and_says_when_it_accepts_a_short_take(self):
        render = FakeRender(lambda t, s, n: True)   # nothing ever renders full length
        events = []
        out = truncation.render_guarded(render, TEXT, 19, sample_rate=RATE, max_chars_per_sec=20.0,
                                        base_seed=None, on_event=events.append)
        self.assertGreater(len(out), 0)
        self.assertIn('accepted-off-length', [e['action'] for e in events])
        depths = {e['depth'] for e in events}
        self.assertLessEqual(max(depths), truncation.MAX_DEPTH)
        self.assertTrue(all(c[1] is None for c in render.calls),
                        'an unseeded engine re-rolls by sampling fresh - no invented seed')

    def test_a_first_take_handed_in_is_not_rendered_again(self):
        render = FakeRender(lambda t, s, n: False)
        out = truncation.render_guarded(render, TEXT, 3, sample_rate=RATE, max_chars_per_sec=20.0,
                                        base_seed=1, first_take=audio_for(len(TEXT)))
        self.assertEqual(render.calls, [])
        self.assertEqual(len(out), len(audio_for(len(TEXT))))


class PaceTrackerTest(unittest.TestCase):
    """The band follows the book (Owen, 2026-09-08). Numbers from the Shift
    render: mistborn recorded 15.12 chars/s; the book ran at 14.09."""

    def _tracker(self):
        # The catalog's seed band at F = 1.2: 18.14 / 12.6 around 15.12.
        return truncation.PaceTracker(15.12, 18.14, 12.6, warmup=4)

    def test_the_seed_band_is_the_documents_until_warm(self):
        t = self._tracker()
        self.assertEqual(t.band(), {'max_chars_per_sec': 18.14, 'min_chars_per_sec': 12.6})
        self.assertFalse(t.warm)
        self.assertEqual(t.reference, 15.12)

    def test_the_band_recentres_on_the_shipped_takes_median(self):
        t = self._tracker()
        for cps in (14.0, 14.2, 13.9, 14.3):
            t.observe(1000, 1000 / cps)
        self.assertTrue(t.warm)
        self.assertAlmostEqual(t.reference, 14.1, places=6)
        band = t.band()
        # The seed band's RATIOS, around the book's pace: 18.14/15.12 and 15.12/12.6.
        self.assertAlmostEqual(band['max_chars_per_sec'], round(14.1 * 18.14 / 15.12, 2))
        self.assertAlmostEqual(band['min_chars_per_sec'], round(14.1 / (15.12 / 12.6), 2))
        # Shift's fastest shipped take (998 chars in 53.6 s = 18.6) is now SHORT
        # against the book's pace, where the fixed band (19.27) let it through.
        self.assertTrue(truncation.check('x' * 998, audio_for(998, 18.6), RATE, **band).short)

    def test_small_chunks_feed_nothing_and_are_short_side_only(self):
        t = self._tracker()
        for _ in range(10):
            t.observe(8, 1.0)          # a heading: 8 chars/s, under MIN_GUARD_CHARS
        self.assertEqual(t.observed, 0)
        self.assertFalse(t.warm)
        # Through the ladder: a 40-char heading at 5 chars/s is not 'long'...
        render = FakeRender(lambda t_, s, n: False)
        events = []
        out = truncation.render_guarded(render, 'x' * 40, 3, sample_rate=RATE, tracker=t,
                                        base_seed=1, on_event=events.append)
        self.assertEqual(events, [])
        self.assertEqual(len(render.calls), 1)
        self.assertEqual(len(out), len(audio_for(40)))
        # ...but the same heading at 60 chars/s (cut off) IS short and re-rolled.
        events = []
        calls = {'n': 0}

        def fast_once(text, seed):
            calls['n'] += 1
            return audio_for(40, 60.0) if calls['n'] == 1 else audio_for(40)
        truncation.render_guarded(fast_once, 'x' * 40, 3, sample_rate=RATE, tracker=t,
                                  base_seed=1, on_event=events.append)
        self.assertEqual([e['action'] for e in events], ['short', 'rerolled'])
        self.assertEqual(events[0]['pace_source'], 'recorded')

    def test_the_ladder_feeds_shipped_takes_back_and_not_accepted_misses(self):
        t = self._tracker()
        render = FakeRender(lambda t_, s, n: False)
        for i in range(4):
            truncation.render_guarded(render, TEXT, i, sample_rate=RATE, tracker=t, base_seed=1,
                                      on_event=lambda e: None)
        self.assertTrue(t.warm)
        self.assertAlmostEqual(t.reference, PACE, places=1)
        # A chunk that stays short at every rung is accepted and NOT observed.
        before = t.observed
        always_short = FakeRender(lambda t_, s, n: True)
        events = []
        truncation.render_guarded(always_short, 'x' * 100 + ' ' + 'y' * 100, 9, sample_rate=RATE,
                                  tracker=t, base_seed=1, on_event=events.append)
        self.assertEqual(events[-1]['action'], 'accepted-off-length')
        self.assertEqual(events[-1]['pace_source'], 'book')
        self.assertEqual(t.observed, before)

    def test_a_malformed_seed_is_refused_by_name(self):
        for args, why in (((15.0, 14.0, 12.0), 'min < pace < max'),
                          ((0, 18.0, 12.0), 'positive'),
                          ((15.0, 18.0, -1), 'positive')):
            with self.assertRaises(ValueError) as caught:
                truncation.PaceTracker(*args)
            self.assertIn(why, str(caught.exception))


class VoiceBandTest(unittest.TestCase):
    """The catalog's recorded pace and seed band ride on the voice and seed the guard's tracker."""

    def _load(self, entry):
        import json, tempfile
        from narrator.engine.higgs.config import load_voices
        d = tempfile.mkdtemp()
        p = os.path.join(d, 'voices.json')
        with open(p, 'w', encoding='utf-8') as h:
            json.dump({'v': {'kind': 'default', **entry}}, h)
        return load_voices(p)['v']

    def test_a_band_in_the_document_lands_on_the_voice_and_seeds_the_tracker(self):
        v = self._load({'maxCharsPerSec': 21.7, 'minCharsPerSec': 13.6, 'paceCharsPerSec': 17.2})
        self.assertEqual((v.max_chars_per_sec, v.min_chars_per_sec, v.pace_chars_per_sec),
                         (21.7, 13.6, 17.2))
        tracker = truncation.tracker_for(v, 20.0, 14.5)
        self.assertEqual(tracker.seed_pace, 17.2)
        self.assertEqual(tracker.band(), {'max_chars_per_sec': 21.7, 'min_chars_per_sec': 13.6})
        bare = self._load({})
        self.assertIsNone(bare.max_chars_per_sec)
        self.assertIsNone(bare.pace_chars_per_sec)
        default = truncation.tracker_for(bare, 20.0, 14.5)
        self.assertEqual(default.band(), {'max_chars_per_sec': 20.0, 'min_chars_per_sec': 14.5})
        self.assertAlmostEqual(default.seed_pace, truncation.expected_chars_per_sec(20.0, 14.5))

    def test_a_partial_band_or_an_inverted_one_is_refused_by_name(self):
        for entry, why in (({'maxCharsPerSec': 21.7}, 'all three or none'),
                           ({'maxCharsPerSec': 21.7, 'minCharsPerSec': 13.6}, 'all three or none'),
                           ({'maxCharsPerSec': 10.0, 'minCharsPerSec': 14.5, 'paceCharsPerSec': 12.0},
                            'min < pace < max'),
                           ({'maxCharsPerSec': 21.7, 'minCharsPerSec': 13.6, 'paceCharsPerSec': 30.0},
                            'min < pace < max'),
                           ({'maxCharsPerSec': -1, 'minCharsPerSec': 14.5, 'paceCharsPerSec': 17.0},
                            'positive')):
            with self.assertRaises(ValueError) as caught:
                self._load(entry)
            self.assertIn(why, str(caught.exception))


class ServedEngineTest(SglTestCase):
    """The ladder through the real served engine against the fake SGLang server:
    the server answers a FIXED number of seconds, so a long chunk is 'short' and
    its halves are not - the ladder must split once and write the joined audio."""

    def test_convert_splits_a_chunk_the_server_stops_early_on(self):
        # 20 s for any request: TEXT (~1,300 chars) reads 65 chars/s -> short;
        # a half (~650) reads 32 -> short; a quarter (~325) reads 16 -> fine.
        self.server.httpd.seconds = 20.0
        checkpoint = self.merged_checkpoint()
        state_env(self, served_common.CHECKPOINT_ENV, checkpoint)
        config = HiggsV3Config(voice=self.checkpoint_voice(), base_url=self.server.base_url,
                               checkpoint_dir=checkpoint, sentences_dir=self.dir, seed=7)
        engine = HiggsV3Engine(config)
        self.addCleanup(engine.cleanup)
        engine.load_engine()
        self.assertTrue(engine.convert(19, TEXT))
        texts = [json_body['input'] for json_body in self.server.requests]
        self.assertEqual(texts[0], TEXT)
        self.assertEqual(texts[1], TEXT, 'the re-roll renders the whole text once more')
        self.assertNotEqual(self.server.requests[0].get('seed'), self.server.requests[1].get('seed'),
                            'the re-roll must use a different seed')
        self.assertGreater(len(texts), 4, 'the halves were split again into quarters')
        import soundfile as sf
        audio, rate = sf.read(os.path.join(self.dir, f'19.{config.audio_format}'))
        self.assertEqual(rate, 24000)
        # four quarters at 20 s each plus three joins
        self.assertGreater(len(audio) / rate, 4 * 20.0)


if __name__ == '__main__':
    unittest.main()
