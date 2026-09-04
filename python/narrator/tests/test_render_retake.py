"""The retake path: an explicit index set, N takes, take<k>/ subdirs.

The layout asserted here is what `electron/correct-sentences-bridge.ts:429-441`
globs; if it changes, Studio's candidate list silently comes back empty.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from narrator.render import retake
from narrator.render.retake import RetakeArgumentError, run_retake
from narrator.tests.test_render_worker import (
    BatchedFakeEngine,
    FakeEngineConfig,
    FakeRenderEngine,
    WorkerTestBase,
)


class ParsingTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-retake-parse-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_indices_parse_and_keep_their_order(self):
        self.assertEqual(retake.parse_sentence_indices('11,3,7'), [11, 3, 7])
        self.assertEqual(retake.parse_sentence_indices('4'), [4])
        self.assertIsNone(retake.parse_sentence_indices(None))

    def test_trailing_and_repeated_commas_are_tolerated(self):
        """e2a filters empty pieces (`if x.strip() != ''`), so a trailing comma is
        not an error. Preserved."""
        self.assertEqual(retake.parse_sentence_indices('1,2,'), [1, 2])
        self.assertEqual(retake.parse_sentence_indices('1,,2'), [1, 2])

    def test_a_non_integer_index_is_refused_with_e2as_message(self):
        with self.assertRaises(RetakeArgumentError) as caught:
            retake.parse_sentence_indices('1,two')
        self.assertIn('comma-separated list of integers', str(caught.exception))

    def test_an_empty_index_list_is_refused(self):
        with self.assertRaises(RetakeArgumentError) as caught:
            retake.parse_sentence_indices(' , ')
        self.assertIn('provided but empty', str(caught.exception))

    def test_temperatures_parse_and_set_the_take_count(self):
        temps = retake.parse_take_temperatures('0.4,0.8,1.0')
        self.assertEqual(temps, [0.4, 0.8, 1.0])
        # The COUNT wins over --num_takes, exactly as e2a's worker.py:454 does.
        self.assertEqual(retake.effective_num_takes(1, temps), 3)
        self.assertEqual(retake.effective_num_takes(9, temps), 3)
        self.assertEqual(retake.effective_num_takes(2, None), 2)

    def test_a_non_numeric_temperature_is_refused(self):
        with self.assertRaises(RetakeArgumentError) as caught:
            retake.parse_take_temperatures('0.4,hot')
        self.assertIn('comma-separated list of numbers', str(caught.exception))

    def test_overrides_are_read_with_int_keys_and_str_values(self):
        path = os.path.join(self.root, 'overrides.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'3': 'A replacement.', '11': 'Another.'}, f)
        self.assertEqual(retake.parse_sentence_overrides(path),
                         {3: 'A replacement.', 11: 'Another.'})
        self.assertIsNone(retake.parse_sentence_overrides(None))

    def test_an_unreadable_overrides_file_is_refused_by_path(self):
        with self.assertRaises(RetakeArgumentError) as caught:
            retake.parse_sentence_overrides(os.path.join(self.root, 'nope.json'))
        self.assertIn('failed to read --sentence_overrides', str(caught.exception))


class LayoutTest(unittest.TestCase):

    def test_multi_take_is_true_for_any_temperature_list_even_one(self):
        """A single-temperature 'long override' take must still land in take0/,
        because that is where the bridge globs. worker_core's own comment."""
        self.assertTrue(retake.is_multi_take(1, [0.6]))
        self.assertTrue(retake.is_multi_take(3, None))
        self.assertFalse(retake.is_multi_take(1, None))

    def test_the_candidate_paths_are_take_k_slash_index(self):
        paths = retake.candidate_files('/s', [3, 7], 1, [0.4, 0.8])
        self.assertEqual([p.replace('\\', '/') for p in paths],
                         ['/s/take0/3.flac', '/s/take0/7.flac',
                          '/s/take1/3.flac', '/s/take1/7.flac'])

    def test_a_single_take_with_no_temperatures_writes_beside_the_book(self):
        paths = retake.candidate_files('/s', [3], 1, None)
        self.assertEqual([p.replace('\\', '/') for p in paths], ['/s/3.flac'])


class RetakeRunTest(WorkerTestBase):

    def scratch(self) -> str:
        d = os.path.join(self.root, 'candidates')
        os.makedirs(d, exist_ok=True)
        return d

    def test_three_temperatures_produce_three_take_dirs(self):
        scratch = self.scratch()
        request = self.request(sentences_dir=scratch,
                               sentence_indices=[3, 7],
                               take_temperatures=[0.4, 0.6, 0.8],
                               num_takes=3)
        result, out, engine = self.run_it(request)

        self.assertTrue(result['success'], result)
        for path in retake.candidate_files(scratch, [3, 7], 3, [0.4, 0.6, 0.8]):
            self.assertTrue(os.path.exists(path), path)
            self.assertGreater(os.path.getsize(path), 1024, path)

        # 2 indices x 3 takes = 6 conversions, none skipped.
        self.assertEqual(result['sentences_processed'], 6)
        self.assertEqual(result['sentences_converted'], 6)
        self.assertEqual(len(engine.calls), 6)
        self.assertEqual([i for i, _ in engine.calls], [3, 7, 3, 7, 3, 7])

    def test_each_take_registers_its_own_temperature_on_the_caps_registry(self):
        """A bare `engine.TEMPERATURE = t` loses to an inherited
        ORPHEUS_TEMPERATURE, so every take would render alike. The registry is the
        top of Orpheus's resolution order and is what e2a uses."""
        request = self.request(sentences_dir=self.scratch(),
                               sentence_indices=[0],
                               take_temperatures=[0.4, 0.9],
                               num_takes=2)
        result, out, engine = self.run_it(request)

        self.assertTrue(result['success'])
        registered = [caps for _, caps in engine.caps if 'temperature' in caps]
        self.assertEqual(registered, [{'temperature': 0.4}, {'temperature': 0.9}])
        self.assertIn('[WORKER] Take 0: sampling temperature = 0.4', out)
        self.assertIn('[WORKER] Take 1: sampling temperature = 0.9', out)

    def test_the_first_sentence_memory_line_is_logged_once_PER_TAKE(self):
        """e2a declares `first_logged` INSIDE the take loop's `use_batch` block
        (`worker_core.py:468`), so each take logs its own reading. A per-run flag
        would print it once and hide the growth a second take reveals - which is
        the only reason the line exists."""
        request = self.request(sentences_dir=self.scratch(),
                               sentence_indices=[0, 1],
                               take_temperatures=[0.4, 0.8, 1.2], num_takes=3)
        _, out, _ = self.run_it(request, engine_cls=BatchedFakeEngine)
        lines = [l for l in out.splitlines()
                 if 'After first sentence TTS' in l]
        self.assertEqual(len(lines), 3, out)

    def test_a_single_temperature_still_lands_in_take0(self):
        scratch = self.scratch()
        request = self.request(sentences_dir=scratch, sentence_indices=[5],
                               take_temperatures=[0.6], num_takes=1)
        result, _, _ = self.run_it(request)
        self.assertTrue(result['success'])
        self.assertTrue(os.path.exists(os.path.join(scratch, 'take0', '5.flac')))
        self.assertFalse(os.path.exists(os.path.join(scratch, '5.flac')))

    def test_an_override_replaces_the_text_that_is_rendered(self):
        request = self.request(sentences_dir=self.scratch(),
                               sentence_indices=[1],
                               sentence_overrides={1: 'The edited line.'},
                               take_temperatures=[0.5], num_takes=1)
        result, _, engine = self.run_it(request)
        self.assertTrue(result['success'])
        self.assertEqual(engine.calls, [(1, 'The edited line.')])

    def test_an_index_past_the_end_is_refused_before_any_model_loads(self):
        request = self.request(sentences_dir=self.scratch(),
                               sentence_indices=[999], num_takes=1,
                               take_temperatures=[0.5])
        result, _, engine = self.run_it(request)
        self.assertFalse(result['success'])
        self.assertIn('Invalid sentence index 999 (total: 10)', result['error'])
        self.assertIsNone(engine)     # the factory was never called

    def test_a_retake_never_touches_the_books_own_sentences(self):
        """The bridge points --sentences_dir at a scratch dir; the book's audio is
        only replaced at COMMIT time, by the bridge, after a person picks."""
        import hashlib

        def digest(i):
            with open(os.path.join(self.sentences_dir, f'{i}.flac'), 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()

        before = {i: digest(i) for i in range(10)}
        request = self.request(sentences_dir=self.scratch(),
                               sentence_indices=[0, 1, 2],
                               take_temperatures=[0.4, 0.8], num_takes=2)
        result, _, _ = self.run_it(request)
        self.assertTrue(result['success'])
        for i, d in before.items():
            self.assertEqual(digest(i), d, f'{i}.flac was modified by a retake')

    def test_nothing_selects_a_winner(self):
        """e2a ranks nothing. Every take is written and left; Studio commits one.
        Asserted so a future 'helpful' selector is a deliberate change."""
        scratch = self.scratch()
        request = self.request(sentences_dir=scratch, sentence_indices=[2],
                               take_temperatures=[0.4, 0.8, 1.2], num_takes=3)
        self.run_it(request)
        produced = sorted(n for n in os.listdir(scratch))
        self.assertEqual(produced, ['take0', 'take1', 'take2'])
        for take in produced:
            self.assertEqual(os.listdir(os.path.join(scratch, take)), ['2.flac'])

    def test_a_batched_engine_takes_the_same_path(self):
        scratch = self.scratch()
        request = self.request(sentences_dir=scratch,
                               sentence_indices=[0, 1, 2, 3, 4, 5],
                               take_temperatures=[0.5], num_takes=1)
        result, _, engine = self.run_it(request, engine_cls=BatchedFakeEngine)
        self.assertTrue(result['success'], result)
        self.assertEqual(engine.batches, [4, 2])
        for i in range(6):
            self.assertTrue(os.path.exists(
                os.path.join(scratch, 'take0', f'{i}.flac')))

    def test_a_second_run_resumes_within_a_take_dir(self):
        """The take dir is skip-checked like any sentences dir, so a retake
        interrupted halfway resumes rather than re-rolling what it already has."""
        scratch = self.scratch()
        request = self.request(sentences_dir=scratch,
                               sentence_indices=[0, 1, 2],
                               take_temperatures=[0.5], num_takes=1)
        self.run_it(request)
        result, _, engine = self.run_it(request)
        self.assertEqual(engine.calls, [])
        self.assertEqual(result['sentences_skipped'], 3)


    def test_run_retake_itself_produces_the_same_files(self):
        """The wrapper is thin on purpose - it validates and delegates - so this
        asserts the delegation, not a second implementation."""
        scratch = self.scratch()
        request = self.request(sentences_dir=scratch, sentence_indices=[4],
                               take_temperatures=[0.4, 0.8], num_takes=2)

        def factory(config):
            return FakeRenderEngine(FakeEngineConfig(
                sentences_dir=config.sentences_dir, voice=config.voice))

        buf = io.StringIO()
        with redirect_stdout(buf):
            result = run_retake(request, engine_factory=factory)
        self.assertTrue(result['success'], result)
        for path in retake.candidate_files(scratch, [4], 2, [0.4, 0.8]):
            self.assertTrue(os.path.exists(path), path)


class RetakeRefusalTest(WorkerTestBase):

    def test_run_retake_refuses_a_range(self):
        request = self.request(sentence_start=0, sentence_end=3)
        with self.assertRaises(RetakeArgumentError) as caught:
            run_retake(request)
        self.assertIn('a contiguous range is a render', str(caught.exception))

    def test_run_retake_refuses_zero_takes(self):
        request = self.request(sentence_indices=[1], num_takes=0)
        with self.assertRaises(RetakeArgumentError) as caught:
            run_retake(request)
        self.assertIn('num_takes must be at least 1', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
