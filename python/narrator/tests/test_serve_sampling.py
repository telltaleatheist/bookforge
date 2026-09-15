"""THE PER-ITEM SAMPLING CHANNEL: one item, one rung, and the two refusals.

WHAT IS UNDER TEST AND WHY IT EXISTS. Owen ruled on 2026-09-14
(docs/EXTENSION-TO-CRUCIBLE-PLAN.md section 2) that *a retake must not reuse
the settings that produced the problem; the spread IS the take ladder*.
Crucible's ladder (crucible/docs/PHASE3-TTS.md section 3) is per VOICE, a job
carries `take: N`, and the server resolves the rung into numbers. It had
nowhere to send them: narrator's sampling arrived through the voices document,
which is written per LOAD, so Crucible refused every take above 0 by name -
`sampling_not_wired`, PHASE3-TTS section 4, "a rung is per RENDER and
narrator's `generate_batch` takes no sampling, so a ladder has no channel yet".
This file is the proof the channel is there.

THE SPELLING IS THE VOICES DOCUMENT'S, and `WireSpellingTest` below pins it to
`engine/higgs/config.py:_SAMPLING_KEYS` so the per-load channel and the
per-item channel cannot drift into two names for one lever.

HOW THE PROTOCOL TESTS SEE WHAT WAS APPLIED. They drive a real worker
SUBPROCESS, so the fake engine writes one JSON line per render to the file
named by `NARRATOR_FAKE_SAMPLING_LOG` (`FakeHiggsEngine._record_sampling`) and
the assertions read it back. What is recorded is the sampling the render
actually RAN at, not the sampling that was asked for, which is the only version
of the question worth asking.

NO GPU, NO MODEL: `--fake-engine`, sine tones, CPU only.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))   # .../python
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import item_sampling as S                       # noqa: E402
from narrator.tests.test_engine_serve_protocol import (         # noqa: E402
    Worker, _WorkerCase)


# ---------------------------------------------------------------------------
# The parser, on its own
# ---------------------------------------------------------------------------


class WireSpellingTest(unittest.TestCase):
    """One vocabulary for both channels."""

    def test_the_item_wire_spells_the_levers_exactly_as_the_document_does(self):
        """A second spelling would be two names for one fact - the shape
        crucible/docs/ARCHITECTURE.md's audit found seven times in one night."""
        from narrator.engine.higgs.config import _SAMPLING_KEYS
        self.assertEqual(S.WIRE_KEYS, _SAMPLING_KEYS)

    def test_the_refusal_names_are_the_ones_crucible_will_read(self):
        self.assertEqual(S.MALFORMED, 'sampling_malformed')
        self.assertEqual(S.NOT_SUPPORTED, 'sampling_not_supported')


class ParseTest(unittest.TestCase):

    def test_absent_is_none_and_is_not_a_refusal(self):
        """No `sampling` key means take 0, which is a documented meaning and
        not a value substituted for a missing one."""
        self.assertIsNone(S.parse_item_sampling(None, 'row 0'))

    def test_the_document_spelling_becomes_the_engine_spelling(self):
        self.assertEqual(
            S.parse_item_sampling({'temperature': 0.7, 'topP': 0.95, 'topK': 50},
                                  'row 0'),
            {'temperature': 0.7, 'top_p': 0.95, 'top_k': 50})

    def test_top_k_comes_back_a_whole_number(self):
        parsed = S.parse_item_sampling({'topK': 50}, 'row 0')
        self.assertIsInstance(parsed['top_k'], int)

    def test_a_partial_rung_is_legal_because_a_rung_is_an_overlay(self):
        """PHASE3-TTS's take 1 is one line, `temperature = 0.7`. It means
        "take 0, but cooler"."""
        self.assertEqual(S.parse_item_sampling({'temperature': 0.7}, 'row 0'),
                         {'temperature': 0.7})

    def test_a_non_object_is_malformed_by_name(self):
        for bad in (0.7, 'hot', [0.7], True):
            with self.assertRaises(S.SamplingMalformed) as caught:
                S.parse_item_sampling(bad, 'row 4')
            self.assertTrue(str(caught.exception).startswith(S.MALFORMED))
            self.assertIn('row 4', str(caught.exception))

    def test_an_empty_object_is_malformed_by_name(self):
        """`{}` is not "no rung" - `sampling` absent is. An empty object is a
        caller that meant to say something and said nothing."""
        with self.assertRaises(S.SamplingMalformed):
            S.parse_item_sampling({}, 'row 4')

    def test_an_unknown_lever_is_malformed_and_the_field_is_named(self):
        with self.assertRaises(S.SamplingMalformed) as caught:
            S.parse_item_sampling({'top_p': 0.95}, 'row 4')
        self.assertTrue(str(caught.exception).startswith(S.MALFORMED))
        self.assertIn('top_p', str(caught.exception))

    def test_a_non_positive_or_non_numeric_value_is_malformed(self):
        for bad in ({'temperature': 0}, {'temperature': -0.7},
                    {'topP': 'hot'}, {'topK': True}):
            with self.assertRaises(S.SamplingMalformed) as caught:
                S.parse_item_sampling(bad, 'row 4')
            self.assertIn(list(bad)[0], str(caught.exception))

    def test_a_fractional_top_k_is_malformed_by_name(self):
        with self.assertRaises(S.SamplingMalformed) as caught:
            S.parse_item_sampling({'topK': 50.5}, 'row 4')
        self.assertIn('topK', str(caught.exception))

    def test_a_lever_this_engine_has_not_got_is_NOT_SUPPORTED_not_malformed(self):
        """The difference matters to whoever sent it: one is a typo, the other
        is the wrong backend. mlx-audio has no repetition penalty."""
        with self.assertRaises(S.SamplingNotSupported) as caught:
            S.parse_item_sampling({'repetitionPenalty': 1.1}, 'row 4',
                                  levers=('temperature', 'topP', 'topK'))
        self.assertTrue(str(caught.exception).startswith(S.NOT_SUPPORTED))
        self.assertIn('repetitionPenalty', str(caught.exception))

    def test_an_engine_with_no_channel_refuses_by_name_and_says_why(self):
        with self.assertRaises(S.SamplingNotSupported) as caught:
            S.refuse_item_sampling({'temperature': 0.7}, 'Orpheus', 'because.')
        self.assertTrue(str(caught.exception).startswith(S.NOT_SUPPORTED))
        self.assertIn('because.', str(caught.exception))
        # ...and absent is still absent, even there.
        self.assertIsNone(S.refuse_item_sampling(None, 'Orpheus', 'because.'))


class OverlayTest(unittest.TestCase):

    def test_a_rung_overlays_and_does_not_replace(self):
        """THE MEASURED REASON: on SGLang-Omni an unset top_k is the
        untruncated 1026-way codebook tail - one chunk ran to the cap with 80 s
        of silence (2026-09-05). A partial rung that REPLACED the voice's
        sampling would produce exactly that."""
        base = {'temperature': 1.0, 'top_p': 0.95, 'top_k': 50}
        self.assertEqual(S.apply_over(base, {'temperature': 0.7}),
                         {'temperature': 0.7, 'top_p': 0.95, 'top_k': 50})

    def test_no_rung_leaves_the_base_exactly_as_it_was(self):
        base = {'temperature': 1.0, 'top_p': 0.95, 'top_k': 50}
        self.assertEqual(S.apply_over(base, None), base)

    def test_neither_argument_is_mutated(self):
        base = {'temperature': 1.0}
        item = {'temperature': 0.7}
        S.apply_over(base, item)
        self.assertEqual(base, {'temperature': 1.0})
        self.assertEqual(item, {'temperature': 0.7})


class AlignedAndGroupedTest(unittest.TestCase):

    def test_none_means_no_rung_anywhere(self):
        self.assertEqual(S.aligned(None, 3, 'where'), [None, None, None])

    def test_a_misaligned_list_is_refused_by_name(self):
        with self.assertRaises(S.SamplingMalformed) as caught:
            S.aligned([{'temperature': 0.7}], 3, 'where')
        self.assertTrue(str(caught.exception).startswith(S.MALFORMED))

    def test_the_group_key_is_the_numbers_not_the_dict(self):
        self.assertEqual(S.group_key({'temperature': 0.7, 'top_p': 0.95}),
                         S.group_key({'top_p': 0.95, 'temperature': 0.7}))
        self.assertNotEqual(S.group_key({'temperature': 0.7}),
                            S.group_key({'temperature': 0.8}))
        self.assertIsNone(S.group_key(None))


# ---------------------------------------------------------------------------
# The wire, through a real worker subprocess
# ---------------------------------------------------------------------------


class _SamplingWorkerCase(_WorkerCase):
    """A worker whose fake engine writes down what it rendered each row under."""

    ENGINE_ID = 'higgs-v3'
    VOICE = 'deathstalker'

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-sampling-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.log_path = os.path.join(self.root, 'sampling.jsonl')
        self.WORKER_ENV = {'NARRATOR_ENGINE': self.ENGINE_ID,
                           'NARRATOR_FAKE_SAMPLING_LOG': self.log_path}
        super().setUp()

    def rendered(self):
        """Every render the fake made, in order: `[{index, text, sampling}]`."""
        if not os.path.exists(self.log_path):
            return []
        with open(self.log_path, encoding='utf-8') as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def sampling_by_index(self):
        """The sampling each chunk index rendered under. Asserts that every
        take of one chunk ran at the SAME numbers - a re-roll or a split half
        that quietly dropped the rung is the bug this channel exists to
        prevent."""
        out = {}
        for row in self.rendered():
            index = row['index']
            if index in out:
                self.assertEqual(out[index], row['sampling'],
                                 f'chunk {index} rendered two takes at different '
                                 'sampling')
            out[index] = row['sampling']
        return out

    def batch(self, items, voice=None):
        self._ready()
        self._load(voice or self.VOICE)
        self.w.send(action='generate_batch', items=items)
        msgs = self.w.read_until('batch_done')
        return self._assert_batch_closed(msgs, [it['i'] for it in items])


class GuardedBatchSamplingTest(_SamplingWorkerCase):
    """The NON-STREAMING door - the one Crucible's render job drives."""

    def test_the_worker_really_built_the_higgs_fake(self):
        """If this fails, every other test in the class is testing Orpheus."""
        self._ready()
        loaded = self._load(self.VOICE)[-1]
        self.assertEqual(loaded['type'], 'loaded', loaded)
        self.assertEqual(loaded['engine'], 'higgs-v3')

    def test_absent_sampling_renders_at_the_voices_default(self):
        """Take 0. Not a fallback: the engine was loaded with its sampling and
        an item that names no rung is not asking for a different one."""
        by_i = self.batch([{'i': 0, 'text': 'The first chunk of the chapter.'},
                           {'i': 1, 'text': 'And the second one after it.'}])
        for i in (0, 1):
            self.assertIn('data', by_i[i], by_i[i])
        self.assertEqual(self.sampling_by_index(), {0: None, 1: None})

    def test_a_rung_is_honoured_for_the_item_that_carried_it(self):
        by_i = self.batch([
            {'i': 0, 'text': 'A chunk at the boson default.'},
            {'i': 1, 'text': 'A chunk on rung one, cooler.',
             'sampling': {'temperature': 0.7}},
        ])
        for i in (0, 1):
            self.assertIn('data', by_i[i], by_i[i])
        self.assertEqual(self.sampling_by_index(),
                         {0: None, 1: {'temperature': 0.7}})

    def test_one_batch_may_mix_rungs_and_each_row_gets_its_own(self):
        """The retake spread: Owen's ruling is that candidates are spread
        ACROSS rungs, so a batch carrying three different ones is the normal
        case and not an edge."""
        by_i = self.batch([
            {'i': 10, 'text': 'Row ten, take zero and nothing asked for.'},
            {'i': 11, 'text': 'Row eleven, rung one.',
             'sampling': {'temperature': 0.7}},
            {'i': 12, 'text': 'Row twelve, a whole triple.',
             'sampling': {'temperature': 0.9, 'topP': 0.9, 'topK': 40}},
        ])
        for i in (10, 11, 12):
            self.assertIn('data', by_i[i], by_i[i])
        self.assertEqual(
            self.sampling_by_index(),
            {10: None,
             11: {'temperature': 0.7},
             12: {'temperature': 0.9, 'top_p': 0.9, 'top_k': 40}})

    def test_every_take_of_a_chunk_runs_at_that_chunks_rung(self):
        """A re-roll and a split half carry their parent's index, and the whole
        point of a retake at another temperature is that the retake uses it.
        NARRATOR_FAKE_HIGGS_RATE bends chunk 1's take 0 so the ladder actually
        climbs."""
        self.w.close()
        env = dict(self.WORKER_ENV)
        env['NARRATOR_FAKE_HIGGS_RATE'] = json.dumps({'1': 0.4})
        self.w = Worker(extra_env=env)
        by_i = self.batch([
            {'i': 0, 'text': 'An ordinary opening chunk of the chapter.'},
            {'i': 1, 'text': 'The chunk whose first take comes back far too '
                             'short for its text, so the guard re-rolls it.',
             'sampling': {'temperature': 0.7}},
        ])
        self.assertIn('data', by_i[1], by_i[1])
        rows = [r for r in self.rendered() if r['index'] == 1]
        self.assertGreater(len(rows), 1,
                           'the guard never re-rolled; this test proves nothing')
        # sampling_by_index asserts the equality across takes; state it here too
        # so the failure reads as what it is.
        for row in rows:
            self.assertEqual(row['sampling'], {'temperature': 0.7})

    def test_a_malformed_rung_fails_ONLY_that_row_and_names_the_refusal(self):
        by_i = self.batch([
            {'i': 0, 'text': 'A perfectly ordinary neighbouring sentence.'},
            {'i': 1, 'text': 'The row with a broken rung.', 'sampling': 'hot'},
            {'i': 2, 'text': 'Another ordinary sentence behind it.'},
        ])
        self.assertIn('data', by_i[0])
        self.assertIn('data', by_i[2])
        self.assertNotIn('data', by_i[1])
        self.assertTrue(by_i[1]['message'].startswith(S.MALFORMED), by_i[1])
        self.assertIn('i=1', by_i[1]['message'])
        # The refused row never reached the engine.
        self.assertEqual(sorted(self.sampling_by_index()), [0, 2])

    def test_an_unknown_lever_names_the_field(self):
        by_i = self.batch([{'i': 3, 'text': 'A row.',
                            'sampling': {'temperatur': 0.7}}])
        self.assertTrue(by_i[3]['message'].startswith(S.MALFORMED), by_i[3])
        self.assertIn('temperatur', by_i[3]['message'])

    def test_a_fractional_top_k_names_the_field(self):
        by_i = self.batch([{'i': 3, 'text': 'A row.',
                            'sampling': {'topK': 50.5}}])
        self.assertTrue(by_i[3]['message'].startswith(S.MALFORMED), by_i[3])
        self.assertIn('topK', by_i[3]['message'])

    def test_a_lever_this_backend_cannot_honour_is_refused_by_the_OTHER_name(self):
        """`sampling_not_supported`, not `sampling_malformed`: the value is
        well formed and this engine simply has no such lever."""
        by_i = self.batch([{'i': 3, 'text': 'A row.',
                            'sampling': {'repetitionPenalty': 1.1}}])
        self.assertTrue(by_i[3]['message'].startswith(S.NOT_SUPPORTED), by_i[3])
        self.assertIn('repetitionPenalty', by_i[3]['message'])


class StreamingSamplingTest(_SamplingWorkerCase):
    """The STREAM door. Unguarded by ruling (Owen, 2026-09-13), which changes
    nothing about whose numbers a row renders at."""

    def test_a_streamed_row_renders_at_its_own_rung(self):
        by_i = self.batch([
            {'i': 0, 'text': 'The row being listened to right now.',
             'stream': True, 'sampling': {'temperature': 0.7}},
            {'i': 1, 'text': 'A read-ahead row behind it, at take zero.'},
        ])
        self.assertTrue(by_i[0].get('streamed'), by_i[0])
        self.assertIn('data', by_i[1], by_i[1])
        self.assertEqual(self.sampling_by_index(),
                         {0: {'temperature': 0.7}, 1: None})

    def test_a_malformed_rung_on_a_streamed_batch_fails_only_its_row(self):
        by_i = self.batch([
            {'i': 0, 'text': 'A streamed row that is fine.', 'stream': True},
            {'i': 1, 'text': 'A row with a broken rung.', 'sampling': {}},
        ])
        self.assertTrue(by_i[0].get('streamed'), by_i[0])
        self.assertTrue(by_i[1]['message'].startswith(S.MALFORMED), by_i[1])


class SingleGenerateSamplingTest(_SamplingWorkerCase):
    """`generate` - the one-sentence door. Same channel, same two refusals,
    reported as this door's `error` rather than a `batch_item`."""

    def _generate(self, **request):
        self._ready()
        self._load(self.VOICE)
        self.w.send(action='generate', **request)
        return self.w.read_until('audio', 'error')[-1]

    def test_a_rung_reaches_a_single_render(self):
        msg = self._generate(text='One sentence, on rung one.',
                             sampling={'temperature': 0.7})
        self.assertEqual(msg['type'], 'audio', msg)
        self.assertEqual([r['sampling'] for r in self.rendered()],
                         [{'temperature': 0.7}])

    def test_no_rung_is_the_loaded_sampling(self):
        msg = self._generate(text='One sentence, take zero.')
        self.assertEqual(msg['type'], 'audio', msg)
        self.assertEqual([r['sampling'] for r in self.rendered()], [None])

    def test_a_malformed_rung_is_an_error_by_name_and_renders_nothing(self):
        msg = self._generate(text='One sentence.', sampling={'topK': 0})
        self.assertEqual(msg['type'], 'error', msg)
        self.assertIn(S.MALFORMED, msg['message'])
        self.assertEqual(self.rendered(), [])


class OrpheusRefusesTheChannelTest(_WorkerCase):
    """ORPHEUS IS DEPRECATED AND HAS NO CHANNEL, so it refuses BY NAME rather
    than rendering at its voice caps and calling that the rung.

    Owen, 2026-09-14: *"orpheus is deprecated too but hasnt been removed yet.
    higgs is the frontier"*. It is not a Crucible engine and dies with the
    legacy layer; a rung silently ignored here would be a retake rendered at
    the very settings the retake exists to avoid.
    """

    WORKER_ENV = None       # the Orpheus fake, which is the default

    def test_a_batch_row_with_a_rung_is_refused_and_its_neighbours_render(self):
        self._ready()
        self._load('leah')
        self.w.send(action='generate_batch', items=[
            {'i': 0, 'text': 'An ordinary sentence.'},
            {'i': 1, 'text': 'A sentence asking for a rung.',
             'sampling': {'temperature': 0.7}},
        ])
        msgs = self.w.read_until('batch_done')
        by_i = self._assert_batch_closed(msgs, [0, 1])
        self.assertIn('data', by_i[0], by_i[0])
        self.assertNotIn('data', by_i[1])
        self.assertTrue(by_i[1]['message'].startswith(S.NOT_SUPPORTED), by_i[1])
        self.assertIn('Orpheus', by_i[1]['message'])

    def test_a_row_with_NO_rung_is_untouched(self):
        """The channel is additive: Orpheus's existing wire is unchanged."""
        self._ready()
        self._load('leah')
        self.w.send(action='generate_batch',
                    items=[{'i': 0, 'text': 'An ordinary sentence.'}])
        by_i = self._assert_batch_closed(self.w.read_until('batch_done'), [0])
        self.assertIn('data', by_i[0], by_i[0])

    def test_the_single_generate_door_refuses_it_too(self):
        self._ready()
        self._load('leah')
        self.w.send(action='generate', text='A sentence.',
                    sampling={'temperature': 0.7})
        msg = self.w.read_until('audio', 'error')[-1]
        self.assertEqual(msg['type'], 'error', msg)
        self.assertIn(S.NOT_SUPPORTED, msg['message'])


if __name__ == '__main__':
    unittest.main()
