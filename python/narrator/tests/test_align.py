"""The aligner, the sentence cues and the coverage guard.

TWO TIERS, deliberately.

  PURE tests need no model and no audio: spans, cue geometry, the report
  schema, the gate's refusals, the CLI's parser. They run under the Windows
  interpreter with the rest of the suite.

  MEASURED tests align REAL AUDIO - ten chunks of the kershaw golden session,
  plus three failures built by hand out of the same chunks - through
  BookForge's installed whisperx-env, on CPU. They SKIP with the exact reason
  when that env or the golden copy is absent, and they FAIL when the env is
  present but broken: a broken aligner reported as "skipped" is how a guard
  quietly stops guarding.

The measured tier drives `python -m narrator.align.worker` in the whisperx
interpreter over its JSON-lines protocol, which is the same door
`narrator align --python ...` uses, so the tests exercise the shipped path
rather than a copy of it.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import tempfile
import unittest

from narrator.align import aligner as A
from narrator.align import coverage as C
from narrator.align import env as E
from narrator.align import run as R
from narrator.align import sentences as S
from narrator.assemble import coverage_gate
from narrator.assemble.engine_profiles import (HIGGS_V3_COVERAGE,
                                               ORPHEUS_COVERAGE, profile_for)


def _default_golden_local() -> str:
    """`C:\\tmp\\narrator-golden` - AS THIS INTERPRETER CAN REACH IT.

    The same three lines as `test_text_prep_golden._default_golden_local`, and
    copied rather than imported ON PURPOSE: that module imports
    `narrator.text.prep`, which needs ebooklib, and this one is deliberately
    free of every heavy dependency so it runs on any interpreter. Importing it
    for five lines of stdlib would make the aligner's tests unrunnable wherever
    ebooklib is missing - which is exactly the interpreter the review ran on.

    Why it exists at all (review nit 13): hard-coding the Windows path made the
    prep parity suite silently SKIP under WSL, which sees the same bytes at
    `/mnt/c/tmp/narrator-golden`.
    """
    if os.name == 'nt':
        return r'C:\tmp\narrator-golden'
    if os.path.isdir('/mnt/c'):
        return '/mnt/c/tmp/narrator-golden'
    return r'C:\tmp\narrator-golden'


GOLDEN_ROOT = os.environ.get('NARRATOR_GOLDEN_LOCAL') or _default_golden_local()
KERSHAW = os.path.join(
    GOLDEN_ROOT, 'kershaw',
    'ebook-ccd14111-da29-4fb0-a489-a19a0f126bac',
    '645fe7068635f759cbda0b8a6d3a348d')
KERSHAW_SENTENCES = os.path.join(KERSHAW, 'chapters', 'sentences')

#: The ten chunks the measured tier aligns. Spread across the book and across
#: lengths (chunk 60 is 4.9 s, chunk 5 is 29.6 s).
MEASURED_INDICES = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80]


def _word(index, word='word', start=0.0, end=0.1, score=0.9):
    return A.AlignedWord(index=index, word=word, start_s=start, end_s=end,
                         score=score)


# =============================================================================
# Pure: spans
# =============================================================================

class SpanTest(unittest.TestCase):

    def test_a_clean_chunk_has_no_spans_of_either_kind(self):
        words = tuple(_word(i, start=i * 0.5, end=i * 0.5 + 0.4)
                      for i in range(10))
        text_spans, audio_spans = A._spans(words, (), 5.0)
        self.assertEqual(text_spans, ())
        self.assertEqual(audio_spans, ())

    def test_a_run_of_weak_words_becomes_one_text_span(self):
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.4) for i in range(10)]
        for i in (6, 7, 8, 9):
            words[i] = A.AlignedWord(index=i, word=f'w{i}', start_s=i * 0.5,
                                     end_s=i * 0.5 + 0.4, score=0.02)
        text_spans, _ = A._spans(tuple(words), (), 5.0)
        self.assertEqual(len(text_spans), 1)
        self.assertEqual((text_spans[0].first_word, text_spans[0].last_word),
                         (6, 9))
        self.assertEqual(text_spans[0].words, 4)

    def test_a_word_with_no_time_at_all_is_a_text_span(self):
        words = (_word(0), A.AlignedWord(1, 'gone', None, None, None), _word(2))
        text_spans, _ = A._spans(words, (), 1.0)
        self.assertEqual([s.first_word for s in text_spans], [1])
        self.assertIsNone(text_spans[0].audio_start_s)

    def test_audio_no_word_covers_becomes_an_audio_span(self):
        words = (_word(0, start=0.0, end=1.0), _word(1, start=9.0, end=10.0))
        _, audio_spans = A._spans(words, (), 10.0)
        self.assertEqual(len(audio_spans), 1)
        self.assertAlmostEqual(audio_spans[0].start_s, 1.0)
        self.assertAlmostEqual(audio_spans[0].end_s, 9.0)
        self.assertEqual(audio_spans[0].where, 'interior')
        self.assertAlmostEqual(audio_spans[0].speech_fraction, 1.0)

    def test_a_pause_in_the_silence_map_is_not_speech(self):
        words = (_word(0, start=0.0, end=1.0), _word(1, start=9.0, end=10.0))
        _, audio_spans = A._spans(words, ((1.0, 9.0),), 10.0)
        self.assertAlmostEqual(audio_spans[0].speech_fraction, 0.0)

    def test_a_gap_shorter_than_the_geometry_floor_is_not_a_span(self):
        words = (_word(0, start=0.0, end=1.0), _word(1, start=1.1, end=2.0))
        _, audio_spans = A._spans(words, (), 2.0)
        self.assertEqual(audio_spans, ())

    def test_trailing_audio_is_a_tail_span(self):
        words = (_word(0, start=0.0, end=1.0),)
        _, audio_spans = A._spans(words, (), 10.0)
        self.assertEqual([s.where for s in audio_spans], ['tail'])


class SilenceTest(unittest.TestCase):

    def test_a_gap_of_digital_silence_is_found(self):
        import numpy as np
        noise = (np.random.RandomState(0).randn(A.SAMPLE_RATE) * 0.2).astype('float32')
        quiet = np.zeros(A.SAMPLE_RATE // 2, dtype='float32')
        audio = np.concatenate([noise, quiet, noise])
        spans = A.detect_silences(audio)
        self.assertEqual(len(spans), 1, spans)
        self.assertAlmostEqual(spans[0][0], 1.0, delta=0.05)
        self.assertAlmostEqual(spans[0][1], 1.5, delta=0.05)

    def test_a_pause_shorter_than_the_floor_is_not_a_silence(self):
        import numpy as np
        noise = (np.random.RandomState(0).randn(A.SAMPLE_RATE) * 0.2).astype('float32')
        quiet = np.zeros(int(A.SAMPLE_RATE * 0.05), dtype='float32')
        spans = A.detect_silences(np.concatenate([noise, quiet, noise]))
        self.assertEqual(spans, ())


class DeviceTest(unittest.TestCase):

    def test_cuda_is_refused_by_name_while_the_gpu_lock_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, 'external-gpu-job.lock')
            open(lock, 'w').close()
            old = os.environ.get(A.GPU_LOCK_ENV)
            os.environ[A.GPU_LOCK_ENV] = lock
            try:
                with self.assertRaises(A.AlignerError) as caught:
                    A.check_device('cuda')
                self.assertIn(lock, str(caught.exception))
                self.assertEqual(A.check_device('cpu'), 'cpu')
            finally:
                if old is None:
                    del os.environ[A.GPU_LOCK_ENV]
                else:
                    os.environ[A.GPU_LOCK_ENV] = old

    def test_cuda_is_allowed_when_no_job_owns_the_card(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get(A.GPU_LOCK_ENV)
            os.environ[A.GPU_LOCK_ENV] = os.path.join(tmp, 'absent.lock')
            try:
                self.assertEqual(A.check_device('cuda'), 'cuda')
            finally:
                if old is None:
                    del os.environ[A.GPU_LOCK_ENV]
                else:
                    os.environ[A.GPU_LOCK_ENV] = old


class BackendSelectionTest(unittest.TestCase):
    """Owen's ruling, 2026-09-05: ONE aligner ships. There is no second backend
    in the package to switch to, and a failing one raises."""

    def test_exactly_one_aligner_ships_and_it_is_whisperx(self):
        self.assertEqual(A.BACKENDS, ('whisperx',))
        self.assertEqual(A.DEFAULT_BACKEND, 'whisperx')
        self.assertEqual(sorted(A._BACKEND_FUNCTIONS), ['whisperx'])
        self.assertEqual(sorted(A._BACKEND_LOADERS), ['whisperx'])
        self.assertEqual(sorted(E.BACKEND_MODULES), ['whisperx'])

    def test_no_torchaudio_aligner_is_shipped(self):
        """The measurement that rejected it lives in align/README.md and in
        this module's docstring; the IMPLEMENTATION must not live in the
        package (review note 14).

        Checked on the code with the docstrings removed - the prose is supposed
        to name the rejected candidate, and a test that forbade the name would
        forbid recording why it was rejected.
        """
        import ast

        with open(A.__file__, encoding='utf-8') as handle:
            source = handle.read()
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)):
                # Blank the docstring, keep the code.
                body = node.body
                if (body and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    body[0].value.value = ''
        code = ast.unparse(tree)
        self.assertNotIn('torchaudio', code)
        self.assertNotIn('forced_align', code)
        self.assertFalse(hasattr(A, '_torchaudio_words'))
        self.assertFalse(hasattr(A, '_load_torchaudio'))

    def test_an_unknown_backend_is_refused_by_name(self):
        with self.assertRaises(A.AlignerError) as caught:
            A.align_chunk('x.flac', 'text', backend='gentle')
        self.assertIn('gentle', str(caught.exception))
        with self.assertRaises(A.AlignerError):
            A.load_backend('gentle')
        with self.assertRaises(ValueError):
            E.backend_importable('gentle')

    def test_a_backend_that_fails_raises_rather_than_running_another(self):
        """The rule, exercised: make the ONE backend fail and check that
        `align_chunk` comes out as an AlignerError naming the chunk, with
        nothing else attempted. The previous version of this test grepped the
        source for `for backend in`, which a `try/except: run(other)` would
        have passed (review note 12)."""
        import numpy as np

        def explode(audio, text, language, device):
            raise RuntimeError('the model is not there')

        saved = A._BACKEND_FUNCTIONS['whisperx']
        A._BACKEND_FUNCTIONS['whisperx'] = explode
        try:
            with self.assertRaises(A.AlignerError) as caught:
                A.align_chunk('chunk-7.flac', 'one two three',
                              audio=np.zeros(A.SAMPLE_RATE, dtype='float32'))
        finally:
            A._BACKEND_FUNCTIONS['whisperx'] = saved
        message = str(caught.exception)
        self.assertIn('chunk-7.flac', message)
        self.assertIn('the model is not there', message)


# =============================================================================
# Pure: sentence cues
# =============================================================================

def _alignment(text, words, duration, silences=()):
    """A hand-built Alignment with its spans DERIVED, not declared.

    `_spans` is what `align_chunk` runs; deriving them here means a coverage
    test cannot pass by being handed spans the real path would not have drawn.
    """
    words = tuple(words)
    silences = tuple(silences)
    text_spans, audio_spans = A._spans(words, silences, duration)
    return A.Alignment(
        audio_path='chunk.flac', text=text, language='en', backend='whisperx',
        device='cpu', duration_s=duration, words=words,
        unaligned_text_spans=text_spans, unaligned_audio_spans=audio_spans,
        silences=silences)


class SentenceCueTest(unittest.TestCase):

    def setUp(self):
        # "One two. Three four." -> two sentences, two words each.
        self.text = 'One two. Three four.'
        self.words = [
            _word(0, 'One', 0.00, 0.40), _word(1, 'two.', 0.40, 0.90),
            _word(2, 'Three', 2.10, 2.50), _word(3, 'four.', 2.50, 3.00),
        ]
        self.al = _alignment(self.text, self.words, 3.20,
                             silences=((0.95, 2.05),))

    def test_the_splitter_is_the_packers(self):
        self.assertEqual(S.split_chunk_sentences('[break]One two. Three four.'),
                         ('One two.', 'Three four.'))

    def test_the_first_cue_starts_at_the_chunk_start_and_the_last_ends_at_its_end(self):
        cues = S.sentence_cues(self.al, chunk_index=7, chunk_start_s=100.0,
                               chunk_end_s=103.2)
        self.assertAlmostEqual(cues[0].start_s, 100.0)
        self.assertAlmostEqual(cues[-1].end_s, 103.2)

    def test_the_interior_seam_lands_in_the_middle_of_the_pause(self):
        cues = S.sentence_cues(self.al, chunk_index=7, chunk_start_s=0.0,
                               chunk_end_s=3.2)
        # The pause runs 0.95..2.05, so its middle is 1.50; the un-snapped
        # midpoint of the word gap would have been 1.50 too, but the snap is
        # what puts it there when the aligner's frame lands off-centre.
        self.assertAlmostEqual(cues[0].end_s, 1.50, delta=0.02)
        self.assertAlmostEqual(cues[1].start_s, cues[0].end_s)

    def test_cues_are_monotonic_non_overlapping_and_inside_the_chunk(self):
        cues = S.sentence_cues(self.al, chunk_index=7, chunk_start_s=10.0,
                               chunk_end_s=13.2)
        for previous, following in zip(cues, cues[1:]):
            self.assertLessEqual(previous.end_s, following.start_s + 1e-9)
        for cue in cues:
            self.assertGreaterEqual(cue.start_s, 10.0 - 1e-9)
            self.assertLessEqual(cue.end_s, 13.2 + 1e-9)

    def test_a_manifest_span_that_disagrees_with_the_audio_is_refused(self):
        with self.assertRaises(A.AlignerError) as caught:
            S.sentence_cues(self.al, chunk_index=7, chunk_start_s=0.0,
                            chunk_end_s=9.0)
        self.assertIn('come apart', str(caught.exception))

    def test_a_sentence_with_no_placed_word_is_refused_not_invented(self):
        words = list(self.words)
        words[2] = A.AlignedWord(2, 'Three', None, None, None)
        words[3] = A.AlignedWord(3, 'four.', None, None, None)
        al = _alignment(self.text, words, 3.20)
        with self.assertRaises(A.AlignerError) as caught:
            S.sentence_cues(al, chunk_index=7, chunk_start_s=0.0,
                            chunk_end_s=3.2)
        self.assertIn('invented', str(caught.exception))

    def test_a_word_count_disagreement_is_refused(self):
        with self.assertRaises(A.AlignerError):
            S.sentence_word_ranges(('One two.', 'Three four.'), 5)

    def test_the_vtt_reuses_the_assemblers_timestamp_format(self):
        cues = S.sentence_cues(self.al, chunk_index=0, chunk_start_s=0.0,
                               chunk_end_s=3.2)
        document = S.build_sentence_vtt(cues)
        self.assertTrue(document.startswith('WEBVTT\n\n'))
        self.assertIn('00:00:00.000 --> ', document)
        self.assertIn('One two.', document)

    def test_a_heading_cue_is_bold_as_the_chunk_level_file_bolds_one(self):
        al = _alignment('Chapter One.',
                        [_word(0, 'Chapter', 0.0, 0.5), _word(1, 'One.', 0.5, 1.0)],
                        1.0)
        cues = S.sentence_cues(al, chunk_index=0, chunk_start_s=0.0,
                               chunk_end_s=1.0, is_heading=True)
        self.assertIn('<b>Chapter One.</b>', S.build_sentence_vtt(cues))

    def test_out_of_order_cues_are_refused_rather_than_written(self):
        bad = [S.SentenceCue(0, 0, 0.0, 2.0, 'a'),
               S.SentenceCue(0, 1, 1.0, 3.0, 'b')]
        with self.assertRaises(A.AlignerError):
            S.build_sentence_vtt(bad)


# =============================================================================
# Pure: coverage and the gate
# =============================================================================

class CoverageTest(unittest.TestCase):

    def _al(self, words, duration=10.0, silences=()):
        return _alignment('t', words, duration, silences)

    def test_a_clean_chunk_passes_with_ratio_one(self):
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(20)]
        result = C.evaluate_chunk(self._al(words), HIGGS_V3_COVERAGE, index=3)
        self.assertEqual(result.aligned_ratio, 1.0)
        self.assertFalse(result.failed)

    def test_a_long_run_of_weak_words_is_dropped_text_and_fails(self):
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(20)]
        for i in range(12, 20):
            words[i] = A.AlignedWord(i, f'w{i}', i * 0.5, i * 0.5 + 0.45, 0.01)
        result = C.evaluate_chunk(self._al(words), HIGGS_V3_COVERAGE, index=3)
        self.assertEqual(len(result.dropped_text), 1)
        self.assertEqual(result.dropped_text[0].words, 8)
        self.assertTrue(result.failed)
        self.assertTrue(any('dropped-text' in r for r in result.reasons))

    def test_a_short_run_of_weak_words_is_not_dropped_text(self):
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(40)]
        for i in (5, 6):
            words[i] = A.AlignedWord(i, f'w{i}', i * 0.5, i * 0.5 + 0.45, 0.01)
        result = C.evaluate_chunk(self._al(words, 20.0), HIGGS_V3_COVERAGE,
                                  index=3)
        self.assertEqual(result.dropped_text, ())
        self.assertFalse(result.failed)

    def test_a_short_chunk_is_not_failed_on_the_ratio_alone(self):
        """A ratio is a bad instrument on ten words; `min_uncredible_words` is
        the floor that keeps a chunk from failing for being short."""
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(11)]
        for i in (3, 7):
            words[i] = A.AlignedWord(i, 'w', i * 0.5, i * 0.5 + 0.45, 0.01)
        result = C.evaluate_chunk(self._al(words, 5.5), HIGGS_V3_COVERAGE,
                                  index=3)
        self.assertLess(result.aligned_ratio, HIGGS_V3_COVERAGE.min_aligned_ratio)
        self.assertFalse(result.failed)

    def test_speech_nobody_asked_for_is_inserted_audio(self):
        words = [_word(0, start=0.0, end=1.0), _word(1, start=5.0, end=6.0)]
        result = C.evaluate_chunk(self._al(words, 6.0), HIGGS_V3_COVERAGE,
                                  index=3)
        self.assertEqual(len(result.inserted_audio), 1)
        self.assertTrue(result.failed)

    def test_a_long_silence_is_not_an_insertion(self):
        words = [_word(0, start=0.0, end=1.0), _word(1, start=5.0, end=6.0)]
        result = C.evaluate_chunk(self._al(words, 6.0, silences=((1.0, 5.0),)),
                                  HIGGS_V3_COVERAGE, index=3)
        self.assertEqual(result.inserted_audio, ())
        self.assertFalse(result.failed)


class GateTest(unittest.TestCase):
    """The half of point 4 that assembly owns - and it must be reachable from
    an interpreter with no torch, which is why it lives in `assemble/`."""

    def _document(self, failed=False, engine='higgs-v3', enforced=True,
                  chunks=2, aligned=None, skipped=0):
        chunk = {'index': 0, 'failed': failed,
                 'reasons': ['aligned ratio 0.500 is below 0.90'] if failed else [],
                 'droppedText': ([{'words': 9, 'text': 'the words it never said'}]
                                 if failed else [])}
        return {
            'version': coverage_gate.SUPPORTED_REPORT_VERSION,
            'engine': engine, 'enforced': enforced,
            'sessionId': 'sid', 'chunksInManifest': chunks,
            'summary': {'chunksAligned': chunks if aligned is None else aligned,
                        'chunksSkipped': skipped, 'chunksFailed': int(failed)},
            'chunks': [chunk],
        }

    def test_a_failed_chunk_refuses_and_quotes_the_dropped_text(self):
        with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
            coverage_gate.refuse_on_failures(self._document(failed=True),
                                             where='coverage.json')
        message = str(caught.exception)
        self.assertIn('chunk 0', message)
        self.assertIn('the words it never said', message)
        self.assertIn('narrator retake --indices 0', message)

    def test_an_unenforced_report_blocks_nothing(self):
        coverage_gate.refuse_on_failures(
            self._document(failed=True, engine='orpheus', enforced=False),
            where='coverage.json')

    def test_a_report_of_the_wrong_version_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump({'version': 99}, handle)
            with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
                coverage_gate.load_report(path)
            self.assertIn('version', str(caught.exception))

    def test_a_missing_report_is_refused_not_passed(self):
        with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
            coverage_gate.load_report(r'C:\tmp\no-such-coverage-report.json')
        self.assertIn('no coverage report', str(caught.exception))

    def _manifest(self, engine_id, chunks=2):
        from narrator.manifest import (Book, Chapter, Chunk, EdgeFadeMs, Engine,
                                       Manifest, Source, Voice)
        return Manifest(
            source=Source(kind='e2a-session-v1', processDir=r'C:\p',
                          sessionId='sid', epubContentHash='h'),
            book=Book(title='T', author='A', language='en', language3='eng'),
            voice=Voice(engine=engine_id, fineTuned='v'),
            sampleRate=24000, sentencesDir=r'C:\p\s',
            engine=(Engine(id=engine_id, pads=False,
                           edgeFadeMs=EdgeFadeMs(10.0, 25.0))
                    if engine_id == 'higgs-v3' else None),
            chapters=[Chapter(index=1, title='C', doc=None, chunks=[
                Chunk(index=i, text=f't{i}', kind='prose',
                      file=f'chapters/sentences/{i}.flac', samples=24000)
                for i in range(chunks)])])

    def test_an_enforced_engine_with_no_report_refuses_the_assembly(self):
        lines = []
        with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
            coverage_gate.check(self._manifest('higgs-v3'),
                                r'C:\tmp\no-such-report.json', lines.append)
        self.assertIn('no coverage report', str(caught.exception))

    def test_an_unenforced_engine_with_no_report_assembles(self):
        lines = []
        self.assertIsNone(
            coverage_gate.check(self._manifest('orpheus'), None, lines.append))

    def test_a_report_for_another_book_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            document = self._document(chunks=9)
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(document, handle)
            with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
                coverage_gate.check(self._manifest('higgs-v3', chunks=2),
                                    path, lambda line: None)
            message = str(caught.exception)
            # Not assertIn('9') - '9' appears in almost any message
            # (review nit 12). Name both counts and the reason.
            self.assertIn('written for a manifest of 9 chunk(s)', message)
            self.assertIn('this one has 2', message)

    def test_a_chunk_nobody_aligned_is_refused_for_an_enforced_engine(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(self._document(chunks=2, aligned=1), handle)
            with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
                coverage_gate.check(self._manifest('higgs-v3'), path,
                                    lambda line: None)
            self.assertIn('needs every chunk measured', str(caught.exception))

    def test_a_marker_only_chunk_counts_as_accounted_for(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(self._document(chunks=2, aligned=1, skipped=1), handle)
            coverage_gate.check(self._manifest('higgs-v3'), path,
                                lambda line: None)

    def test_a_clean_enforced_report_lets_the_assembly_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(self._document(chunks=2), handle)
            lines = []
            document = coverage_gate.check(self._manifest('higgs-v3'), path,
                                           lines.append)
            self.assertIsNotNone(document)
            self.assertTrue(any('[coverage]' in line for line in lines))

    def test_the_two_engines_carry_the_policies_the_design_asks_for(self):
        self.assertTrue(profile_for('higgs-v3').coverage.enforced)
        self.assertFalse(profile_for('orpheus').coverage.enforced)
        self.assertIs(profile_for('higgs-v3').coverage, HIGGS_V3_COVERAGE)
        self.assertIs(profile_for('orpheus').coverage, ORPHEUS_COVERAGE)


class ReportSchemaTest(unittest.TestCase):

    def test_the_document_carries_what_the_gate_verifies(self):
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(10)]
        coverages = [C.evaluate_chunk(_alignment('t', words, 5.0),
                                      HIGGS_V3_COVERAGE, index=0)]
        document = C.coverage_document(
            coverages, engine_id='higgs-v3', policy=HIGGS_V3_COVERAGE,
            backend='whisperx', language='en', session_id='sid',
            process_dir='/p', chunks_in_manifest=1)
        self.assertEqual(document['version'],
                         coverage_gate.SUPPORTED_REPORT_VERSION)
        self.assertTrue(document['enforced'])
        self.assertEqual(document['summary']['chunksAligned'], 1)
        self.assertEqual(document['summary']['chunksSkipped'], 0)
        # It must survive a JSON round trip: assembly reads it off disk.
        json.loads(json.dumps(document))


class EnvTest(unittest.TestCase):

    def test_the_package_root_is_this_checkouts_python_dir(self):
        root = E.package_root()
        self.assertTrue(os.path.isdir(os.path.join(root, 'narrator')))

    def test_the_worker_environment_puts_this_checkout_on_pythonpath(self):
        """Asserted against THIS FILE's own location, not against a second call
        to the function under test (review nit 12): the worker has to be able
        to `import narrator`, and what proves that is the directory this test
        module itself lives two levels under."""
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        expected = os.path.dirname(here)
        env = E.worker_environment({})
        self.assertEqual(env['PYTHONPATH'], expected)
        self.assertTrue(os.path.isfile(
            os.path.join(env['PYTHONPATH'], 'narrator', 'align', 'worker.py')))

    def test_an_existing_pythonpath_is_prepended_to_not_replaced(self):
        env = E.worker_environment({'PYTHONPATH': 'X'})
        self.assertTrue(env['PYTHONPATH'].endswith(os.pathsep + 'X'))


class ProgressLineTest(unittest.TestCase):
    """The one line BookForge's Align queue row parses.

    It is a CONTRACT, not a log message: `electron/coverage-align-job.ts` matches
    `[align] aligned <done>/<total> chunk(s)` to move the row's bar and to give
    it a rate-based ETA. Reword it and the bar silently stops - a book that takes
    minutes then looks hung, which is the failure a progress bar exists to
    prevent. Asserted here so the wording cannot drift out from under it.
    """

    def _lines(self, total):
        out = []
        report = R._progress_reporter(out.append)
        for done in range(1, total + 1):
            report(done, total)
        return out

    def test_the_wording_is_what_the_app_parses(self):
        self.assertEqual(self._lines(10)[-1], '[align] aligned 10/10 chunk(s)')

    def test_it_reports_every_ten_and_ALWAYS_on_the_last(self):
        # Every chunk would be hundreds of lines in a job log for a pass whose
        # whole point is that it is fast; every tenth moves visibly on a 130-chunk
        # book. The last one always reports, so the count a reader ends on is the
        # real one rather than the last multiple of ten.
        lines = self._lines(133)
        self.assertEqual(lines[0], '[align] aligned 10/133 chunk(s)')
        self.assertEqual(lines[-1], '[align] aligned 133/133 chunk(s)')
        self.assertEqual(len(lines), 133 // R.PROGRESS_EVERY + 1)

    def test_a_book_shorter_than_the_interval_still_reports_once(self):
        self.assertEqual(self._lines(3), ['[align] aligned 3/3 chunk(s)'])

    def test_run_jobs_takes_the_callback_by_name(self):
        """`on_result` is a keyword argument of `run_jobs`, because `run.py`
        passes it as one and a positional rename would silently become the
        `timeout`."""
        import inspect
        params = inspect.signature(E.run_jobs).parameters
        self.assertIn('on_result', params)
        self.assertIsNone(params['on_result'].default)


class WorkerProtocolTest(unittest.TestCase):
    """`run_jobs` drives a real child over a job list BIGGER THAN A PIPE.

    THE BUG THIS EXISTS FOR. `run_jobs` used `subprocess.run(input=...)`, which
    feeds stdin and drains stdout and stderr together. Streaming the results (so
    the queue row can show progress) meant reading stdout in a loop - and an
    inline `proc.stdin.write(payload)` beside that loop DEADLOCKS on any real
    book: a job line is ~500 bytes, 1,400 chunks is ~700 kB, and a pipe holds
    64 kB. The parent blocks writing, the worker fills its own stdout buffer with
    results nobody is reading, and neither moves again. It would have looked like
    a hung Align row on long books and worked perfectly on every short one.

    NO MODEL, NO TORCH, NO AUDIO. The jobs name a backend that does not exist, so
    `load_backend` refuses each one instantly and the worker still emits one
    result line per job - which is the whole protocol, and exactly what a
    deadlock would prevent. That makes this runnable on any interpreter that can
    import narrator, which is every one the suite runs on.
    """

    #: A pipe is 64 kB on Linux and 4-64 kB on Windows. Sized well past both, so
    #: the test fails on the write side if the payload is ever fed inline again.
    JOBS = 400

    def _jobs(self):
        # Padded so the payload is unambiguously bigger than any pipe buffer.
        text = 'the quick brown fox jumps over the lazy dog. ' * 6
        return [{'index': i, 'audioPath': f'/nope/{i}.flac', 'text': text,
                 'language': 'en', 'backend': 'no-such-backend', 'device': 'cpu'}
                for i in range(self.JOBS)]

    def test_a_payload_bigger_than_a_pipe_completes(self):
        import sys
        jobs = self._jobs()
        payload = sum(len(json.dumps(j)) for j in jobs)
        # Twice the 64 kB Linux pipe, and many times any Windows one. The fixture
        # measures ~157 kB; the floor is what it must never quietly fall under,
        # because a payload that fits in a pipe proves nothing.
        self.assertGreater(payload, 131_072,
                           'the fixture is no longer big enough to prove anything')

        seen = []
        results = E.run_jobs(sys.executable, jobs,
                             timeout=300,
                             on_result=lambda done, total: seen.append((done, total)))

        self.assertEqual(len(results), self.JOBS)
        # Order is the protocol: result k answers job k.
        self.assertEqual([r['index'] for r in results], list(range(self.JOBS)))
        # Every one failed, by name, because the backend does not exist - and a
        # FAILED job is still a result line, which is what keeps the counts equal.
        self.assertTrue(all(r['ok'] is False for r in results))
        self.assertIn('no-such-backend', results[0]['error'])

    def test_the_callback_fires_as_results_ARRIVE_not_at_the_end(self):
        import sys
        seen = []
        E.run_jobs(sys.executable, self._jobs(), timeout=300,
                   on_result=lambda done, total: seen.append((done, total)))
        self.assertEqual(len(seen), self.JOBS)
        self.assertEqual(seen[0], (1, self.JOBS))
        self.assertEqual(seen[-1], (self.JOBS, self.JOBS))


class CliTest(unittest.TestCase):

    def test_align_is_a_subcommand_with_the_documented_flags(self):
        from narrator.cli import build_parser
        args = build_parser().parse_args(
            ['align', '--session-dir', 'D', '--out', 'o.vtt',
             '--report', 'c.json'])
        self.assertEqual(args.command, 'align')
        self.assertEqual(args.device, 'cpu')
        # ONE aligner ships, so there is nothing to choose and no flag for it.
        self.assertFalse(hasattr(args, 'backend'))
        with self.assertRaises(SystemExit):
            build_parser().parse_args(
                ['align', '--session-dir', 'D', '--backend', 'torchaudio'])

    def test_a_failure_stops_the_run_unless_the_operator_says_otherwise(self):
        from narrator.cli import build_parser
        default = build_parser().parse_args(['align', '--session-dir', 'D'])
        self.assertFalse(default.continue_on_error)
        asked = build_parser().parse_args(
            ['align', '--session-dir', 'D', '--continue-on-error'])
        self.assertTrue(asked.continue_on_error)

    def test_assemble_takes_the_coverage_report(self):
        from narrator.cli import build_parser
        args = build_parser().parse_args(
            ['assemble', '--session-dir', 'D', '--output-dir', 'O',
             '--coverage-report', 'c.json'])
        self.assertEqual(args.coverage_report, 'c.json')


# =============================================================================
# Pure: the orchestrator, on a real session layout with a fake aligner
# =============================================================================

class AlignSessionTest(unittest.TestCase):
    """`align/run.align_session` - the function that wires every proven piece
    together, and the one the first round of this work left untested (review
    finding B1).

    NO MODEL AND NO AUDIO. The session layout is real - a manifest built by
    hand with the same dataclasses `render/session_v1` produces - and the
    ALIGNER is faked at `_BACKEND_FUNCTIONS`, which is the seam `align_chunk`
    dispatches through, so everything from `chunk_spans` down through the
    coverage document is the shipped code. Audio is faked one layer up, at
    `decode_audio`, because a chunk's audio only has to have the right LENGTH
    for this: what the words say is the fake backend's business.

    Why it matters, in the reviewer's words: a regression that quietly turned a
    FAILED chunk into a SKIPPED one would pass the whole suite and would then
    pass the enforced gate, because `aligned + skipped` would still equal
    `chunks`.
    """

    SAMPLES = 24000  # 1.0 s per chunk at the manifest's 24 kHz

    def _manifest(self, texts, engine='higgs-v3'):
        from narrator.manifest import (Book, Chapter, Chunk, EdgeFadeMs, Engine,
                                       Manifest, Source, Voice)
        chunks = [
            Chunk(index=i, text=text,
                  kind='heading' if '[heading]' in text else 'prose',
                  file=f'chapters/sentences/{i}.flac', samples=self.SAMPLES)
            for i, text in enumerate(texts)
        ]
        return Manifest(
            source=Source(kind='e2a-session-v1', processDir=self.tmp,
                          sessionId='sid', epubContentHash='h'),
            book=Book(title='T', author='A', language='en', language3='eng'),
            voice=Voice(engine=engine, fineTuned='v'),
            sampleRate=24000, sentencesDir=os.path.join(self.tmp, 'chapters'),
            engine=Engine(id=engine, pads=False,
                          edgeFadeMs=EdgeFadeMs(10.0, 25.0)),
            chapters=[Chapter(index=1, title='C', doc=None, chunks=chunks)])

    def setUp(self):
        import numpy as np

        self.tmp = tempfile.mkdtemp(prefix='narrator-align-session-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        # One second of "audio" per chunk, matching the manifest's samples.
        self._audio = np.zeros(A.SAMPLE_RATE, dtype='float32')
        self._patch(A, 'decode_audio', lambda path, ffmpeg=None: self._audio)
        self._patch(A, 'detect_silences',
                    lambda audio, noise_db=None, min_s=None: ())
        # This interpreter has no whisperx, and `_run` refuses (correctly)
        # rather than guessing an interpreter - so the fake has to stand in for
        # BOTH halves: "yes, importable here" and the model load.
        self._patch(E, 'backend_importable', lambda backend: True)
        A._BACKEND_LOADERS['whisperx'] = lambda language, device: (None, None)
        self.addCleanup(A._BACKEND_LOADERS.__setitem__, 'whisperx',
                        A._load_whisperx)
        # The fake aligner. `self.behaviour` decides, per chunk text, what it
        # does; the default places every word evenly with a good score.
        self.behaviour = {}
        A._BACKEND_FUNCTIONS['whisperx'] = self._fake
        self.addCleanup(A._BACKEND_FUNCTIONS.__setitem__, 'whisperx',
                        A._whisperx_words)

    def _patch(self, module, name, value):
        old = getattr(module, name)
        setattr(module, name, value)
        self.addCleanup(setattr, module, name, old)

    def _fake(self, audio, text, language, device):
        """words -> (word, start, end, score), evenly spread over the second."""
        how = self.behaviour.get(text, 'ok')
        if how == 'explode':
            raise RuntimeError('the fake aligner refuses this chunk')
        words = [w for w in text.split(' ') if w]
        step = (audio.size / A.SAMPLE_RATE) / max(1, len(words))
        score = 0.02 if how == 'weak' else 0.9
        return [(w, i * step, (i + 1) * step, score)
                for i, w in enumerate(words)]

    # ---- the stop-on-failure rule ------------------------------------------

    def test_a_failed_chunk_stops_the_run_and_names_it(self):
        texts = ['One two. Three four.', 'Five six. Seven eight.',
                 'Nine ten. Eleven twelve.']
        self.behaviour[texts[1]] = 'explode'
        with self.assertRaises(A.AlignerError) as caught:
            R.align_session(self._manifest(texts), progress=lambda line: None)
        message = str(caught.exception)
        self.assertIn('chunk 1', message)
        self.assertIn('the fake aligner refuses this chunk', message)
        self.assertIn('--continue-on-error', message)

    def test_the_stopped_run_writes_nothing(self):
        texts = ['One two.', 'Three four.']
        self.behaviour[texts[0]] = 'explode'
        vtt = os.path.join(self.tmp, 'out.sentences.vtt')
        report = os.path.join(self.tmp, 'coverage.json')
        with self.assertRaises(A.AlignerError):
            result = R.align_session(self._manifest(texts),
                                     progress=lambda line: None)
            R.write_outputs(result, vtt_path=vtt, report_path=report)
        self.assertFalse(os.path.exists(vtt))
        self.assertFalse(os.path.exists(report))

    def test_in_process_the_run_stops_at_the_failing_chunk(self):
        """Review finding 10: a chunk-3 failure must not cost the whole pass."""
        seen = []
        real = self._fake

        def counting(audio, text, language, device):
            seen.append(text)
            return real(audio, text, language, device)

        A._BACKEND_FUNCTIONS['whisperx'] = counting
        texts = [f'Word{i} word. Other{i} word.' for i in range(6)]
        self.behaviour[texts[1]] = 'explode'
        with self.assertRaises(A.AlignerError):
            R.align_session(self._manifest(texts), progress=lambda line: None)
        self.assertEqual(len(seen), 2, seen)

    # ---- the sweep ---------------------------------------------------------

    def test_continue_on_error_finishes_and_records_the_failure(self):
        texts = ['One two. Three four.', 'Five six. Seven eight.',
                 'Nine ten. Eleven twelve.']
        self.behaviour[texts[1]] = 'explode'
        result = R.align_session(self._manifest(texts), continue_on_error=True,
                                 progress=lambda line: None)
        document = result['document']
        self.assertEqual(document['summary']['chunksAligned'], 2)
        self.assertEqual(document['summary']['errors'], 1)
        errors = document['errors']
        self.assertEqual([e['index'] for e in errors], [1])
        self.assertEqual(errors[0]['stage'], 'align')
        self.assertIn('the fake aligner refuses this chunk', errors[0]['error'])
        # The two good chunks still produced their cues.
        self.assertEqual(sorted({c.chunk_index for c in result['cues']}), [0, 2])

    def test_a_swept_report_with_a_hole_is_then_REFUSED_by_the_gate(self):
        """The sweep is for auditing, not for shipping: a report missing a
        chunk must not let an enforced engine assemble."""
        texts = ['One two.', 'Three four.', 'Five six.']
        self.behaviour[texts[1]] = 'explode'
        manifest = self._manifest(texts)
        result = R.align_session(manifest, continue_on_error=True,
                                 progress=lambda line: None)
        path = os.path.join(self.tmp, 'coverage.json')
        R.write_outputs(result, vtt_path=None, report_path=path,
                        log=lambda line: None)
        with self.assertRaises(coverage_gate.CoverageRefusal) as caught:
            coverage_gate.check(manifest, path, lambda line: None)
        self.assertIn('needs every chunk measured', str(caught.exception))

    # ---- marker-only chunks, and the accounting the gate rests on ----------

    def test_a_marker_only_chunk_is_skipped_not_failed(self):
        texts = ['One two. Three four.', '[break]', 'Five six.']
        result = R.align_session(self._manifest(texts),
                                 progress=lambda line: None)
        summary = result['document']['summary']
        self.assertEqual(summary['chunksAligned'], 2)
        self.assertEqual(summary['chunksSkipped'], 1)
        self.assertEqual(summary['errors'], 0)
        self.assertEqual([s['index'] for s in result['document']['skipped']], [1])
        self.assertEqual(result['document']['skipped'][0]['reason'],
                         'no spoken text')

    def test_aligned_plus_skipped_accounts_for_every_manifest_chunk(self):
        """THE INVARIANT the enforced gate rests on, asserted end to end."""
        texts = ['One two. Three four.', '[break]', 'Five six.', '[break]']
        manifest = self._manifest(texts)
        result = R.align_session(manifest, progress=lambda line: None)
        summary = result['document']['summary']
        self.assertEqual(summary['chunksAligned'] + summary['chunksSkipped'],
                         len(texts))
        self.assertEqual(result['document']['chunksInManifest'], len(texts))
        path = os.path.join(self.tmp, 'coverage.json')
        R.write_outputs(result, vtt_path=None, report_path=path,
                        log=lambda line: None)
        # ...and the gate accepts exactly that report.
        document = coverage_gate.check(manifest, path, lambda line: None)
        self.assertIsNotNone(document)

    def test_a_failed_chunk_is_never_mistaken_for_a_skipped_one(self):
        """The regression the reviewer named: if a failure were recorded as a
        skip, aligned+skipped would still equal chunks and the gate would pass
        a book nobody measured."""
        texts = ['One two.', 'Three four.', 'Five six.']
        self.behaviour[texts[1]] = 'explode'
        result = R.align_session(self._manifest(texts), continue_on_error=True,
                                 progress=lambda line: None)
        summary = result['document']['summary']
        self.assertEqual(summary['chunksSkipped'], 0)
        self.assertEqual(summary['errors'], 1)
        self.assertLess(summary['chunksAligned'] + summary['chunksSkipped'],
                        len(texts))

    # ---- the cues stage ----------------------------------------------------

    def test_a_cue_refusal_is_recorded_under_its_own_stage(self):
        """A chunk that aligns but cannot be cut into cues is a DIFFERENT
        failure from one that would not align, and the report says which."""
        texts = ['One two. Three four.', 'Five six.']
        manifest = self._manifest(texts)
        # Make the manifest disagree with the audio for chunk 0 only: the cue
        # builder refuses a span that does not match what was decoded.
        manifest.chapters[0].chunks[0].samples = self.SAMPLES * 9
        result = R.align_session(manifest, continue_on_error=True,
                                 progress=lambda line: None)
        errors = result['document']['errors']
        self.assertEqual([e['stage'] for e in errors], ['cues'])
        self.assertEqual(errors[0]['index'], 0)
        self.assertIn('come apart', errors[0]['error'])
        # It still counts as ALIGNED - the alignment happened; the cues did not.
        self.assertEqual(result['document']['summary']['chunksAligned'], 2)
        self.assertEqual(sorted({c.chunk_index for c in result['cues']}), [1])

    # ---- outputs -----------------------------------------------------------

    def test_write_outputs_refuses_an_empty_transcript(self):
        result = {'cues': [], 'document': {'summary': {}}}
        with self.assertRaises(A.AlignerError) as caught:
            R.write_outputs(result, vtt_path=os.path.join(self.tmp, 'x.vtt'),
                            report_path=None, log=lambda line: None)
        self.assertIn('empty transcript', str(caught.exception))

    def test_the_written_vtt_and_report_are_what_the_run_produced(self):
        texts = ['One two. Three four.', 'Five six.']
        result = R.align_session(self._manifest(texts),
                                 progress=lambda line: None)
        vtt = os.path.join(self.tmp, 'out.sentences.vtt')
        report = os.path.join(self.tmp, 'coverage.json')
        written = R.write_outputs(result, vtt_path=vtt, report_path=report,
                                  log=lambda line: None)
        self.assertEqual(written, {'vtt': vtt, 'report': report})
        with open(vtt, encoding='utf-8') as handle:
            document = handle.read()
        self.assertTrue(document.startswith('WEBVTT\n\n'))
        self.assertEqual(document.count(' --> '), len(result['cues']))
        with open(report, encoding='utf-8') as handle:
            self.assertEqual(json.load(handle), result['document'])

    def test_indices_align_a_subset_and_the_report_says_so(self):
        texts = ['One two.', 'Three four.', 'Five six.']
        result = R.align_session(self._manifest(texts), indices=[2],
                                 progress=lambda line: None)
        self.assertEqual(result['document']['summary']['chunksAligned'], 1)
        self.assertEqual([c.chunk_index for c in result['cues']], [2])
        # A partial report cannot satisfy an enforced engine.
        self.assertEqual(result['document']['chunksInManifest'], 3)

    def test_an_index_that_is_not_in_the_session_is_refused(self):
        with self.assertRaises(A.AlignerError) as caught:
            R.align_session(self._manifest(['One two.']), indices=[7],
                            progress=lambda line: None)
        self.assertIn('7', str(caught.exception))

    # ---- the engine seam ---------------------------------------------------

    def test_the_engines_policy_is_the_one_that_judges(self):
        texts = ['One two. Three four.']
        self.behaviour[texts[0]] = 'weak'
        higgs = R.align_session(self._manifest(texts, engine='higgs-v3'),
                                progress=lambda line: None)
        self.assertTrue(higgs['document']['enforced'])
        self.assertEqual(higgs['document']['summary']['chunksFailed'], 1)

        orpheus = R.align_session(self._manifest(texts, engine='orpheus'),
                                  progress=lambda line: None)
        self.assertFalse(orpheus['document']['enforced'])
        # Same measurement, same failure count - the difference is enforcement.
        self.assertEqual(orpheus['document']['summary']['chunksFailed'], 1)


# =============================================================================
# Measured: real audio through the installed whisperx env
# =============================================================================

def _align_python():
    """The whisperx interpreter, or None. Never guessed into a run - this is
    only used to decide whether the measured tier can run at all."""
    found = E.discover_align_python()
    return found if found and os.path.isfile(found) else None


def _write_wav(path, audio, rate=A.SAMPLE_RATE):
    """A 16-bit PCM wav, with no soundfile: the whisperx env has none, and the
    failure cases have to be built out of arrays."""
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype('<i2').tobytes()
    with open(path, 'wb') as handle:
        handle.write(b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ')
        handle.write(struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16))
        handle.write(b'data' + struct.pack('<I', len(pcm)) + pcm)
    return path


class MeasuredAlignTest(unittest.TestCase):
    """Ten real kershaw chunks and three hand-built failures, on CPU.

    SKIPS with the exact reason when the env or the golden copy is absent;
    FAILS when the env is there and the alignment does not work.
    """

    @classmethod
    def setUpClass(cls):
        cls.python = _align_python()
        if cls.python is None:
            raise unittest.SkipTest(
                'no whisperx interpreter: set NARRATOR_ALIGN_PYTHON or '
                'WHISPERX_ENV_PATH, or install "Ebook Alignment (WhisperX)" '
                'from Settings -> Add-ons')
        if not os.path.isdir(KERSHAW_SENTENCES):
            raise unittest.SkipTest(
                f'no golden kershaw audio at {KERSHAW_SENTENCES} (set '
                f'NARRATOR_GOLDEN_LOCAL)')
        if shutil.which('ffmpeg') is None:
            raise unittest.SkipTest('ffmpeg is not on PATH')

        state_path = os.path.join(KERSHAW, 'session-state.json')
        with open(state_path, encoding='utf-8') as handle:
            state = json.load(handle)
        cls.texts = [t for chapter in state['chapter_sentences'] for t in chapter]
        cls.tmp = tempfile.mkdtemp(prefix='narrator-align-test-')
        cls.results = cls._run([
            {'index': i,
             'audioPath': os.path.join(KERSHAW_SENTENCES, f'{i}.flac'),
             'text': cls._spoken(cls.texts[i]), 'language': 'en',
             'backend': 'whisperx', 'device': 'cpu', 'ffmpeg': None}
            for i in MEASURED_INDICES
        ])

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'tmp', None):
            shutil.rmtree(cls.tmp, ignore_errors=True)

    @staticmethod
    def _spoken(text):
        from narrator.text.paragraph_packer import spoken
        return spoken(text)

    @classmethod
    def _run(cls, jobs):
        return E.run_jobs(cls.python, jobs, timeout=1800)

    def _alignment(self, position):
        result = self.results[position]
        self.assertTrue(result['ok'],
                        f'chunk {result["index"]} failed: {result.get("error")}')
        return A.alignment_from_dict(result['alignment'])

    # ---- the ten good chunks ------------------------------------------------

    def test_every_word_lands_inside_its_chunks_own_audio(self):
        for position, index in enumerate(MEASURED_INDICES):
            alignment = self._alignment(position)
            for word in alignment.words:
                self.assertTrue(word.timed, f'chunk {index} word {word.index}')
                self.assertGreaterEqual(word.start_s, -1e-6)
                self.assertLessEqual(word.end_s, alignment.duration_s + 1e-6)
                self.assertLessEqual(word.start_s, word.end_s + 1e-6)

    def test_words_are_in_order_and_match_the_text(self):
        for position, index in enumerate(MEASURED_INDICES):
            alignment = self._alignment(position)
            expected = A.chunk_words(self._spoken(self.texts[index]))
            self.assertEqual(tuple(w.word for w in alignment.words), expected)
            starts = [w.start_s for w in alignment.words]
            self.assertEqual(starts, sorted(starts), f'chunk {index}')

    def test_a_correctly_rendered_chunk_covers_its_text(self):
        for position, index in enumerate(MEASURED_INDICES):
            alignment = self._alignment(position)
            result = C.evaluate_chunk(alignment, ORPHEUS_COVERAGE, index=index)
            self.assertGreaterEqual(result.aligned_ratio, 0.90,
                                    f'chunk {index}: {result.reasons}')
            self.assertEqual(result.dropped_text, (),
                             f'chunk {index} reported dropped text')
            self.assertFalse(result.failed, f'chunk {index}: {result.reasons}')

    def test_sentence_cues_are_monotonic_and_inside_the_chunk_span(self):
        for position, index in enumerate(MEASURED_INDICES):
            alignment = self._alignment(position)
            start, end = 100.0, 100.0 + alignment.duration_s
            cues = S.sentence_cues(alignment, chunk_index=index,
                                   chunk_start_s=start, chunk_end_s=end)
            self.assertAlmostEqual(cues[0].start_s, start, places=6)
            self.assertAlmostEqual(cues[-1].end_s, end, places=6)
            for previous, following in zip(cues, cues[1:]):
                self.assertLessEqual(previous.end_s, following.start_s + 1e-9,
                                     f'chunk {index} cues overlap')
            # The cues partition the chunk: no gap, no overlap, nothing outside.
            self.assertAlmostEqual(sum(c.end_s - c.start_s for c in cues),
                                   end - start, places=6)

    def test_cpu_cost_is_seconds_per_chunk(self):
        seconds = [self._alignment(p).elapsed_s
                   for p in range(len(MEASURED_INDICES))]
        audio = [self._alignment(p).duration_s
                 for p in range(len(MEASURED_INDICES))]
        print(f'\n[measured] {len(seconds)} chunk(s): '
              f'{sum(audio):.1f}s of audio aligned in {sum(seconds):.1f}s CPU '
              f'(RTF {sum(seconds)/sum(audio):.3f}); per chunk '
              f'min {min(seconds):.2f}s max {max(seconds):.2f}s')
        self.assertLess(max(seconds), 30.0,
                        'a chunk should align in seconds on CPU')

    # ---- the three hand-built failures --------------------------------------

    def test_dropped_text_a_sentence_the_audio_never_says(self):
        """Point 4's first half: text with no aligned audio."""
        index = MEASURED_INDICES[3]
        extra = self._spoken(self.texts[index + 1]).split('. ')[0] + '.'
        job = {'index': index,
               'audioPath': os.path.join(KERSHAW_SENTENCES, f'{index}.flac'),
               'text': self._spoken(self.texts[index]) + ' ' + extra,
               'language': 'en', 'backend': 'whisperx', 'device': 'cpu',
               'ffmpeg': None}
        alignment = A.alignment_from_dict(self._run([job])[0]['alignment'])
        result = C.evaluate_chunk(alignment, HIGGS_V3_COVERAGE, index=index)
        self.assertTrue(result.failed, result.reasons)
        self.assertTrue(result.dropped_text,
                        'the appended sentence was not reported as dropped')
        worst = max(result.dropped_text, key=lambda s: s.words)
        print(f'\n[measured] dropped-text case: ratio {result.aligned_ratio:.3f}, '
              f'{len(result.dropped_text)} span(s), worst {worst.words} word(s)')

    def test_inserted_audio_two_chunks_under_one_chunks_text(self):
        """Point 4's second half: audio with no text."""
        import numpy as np

        index = MEASURED_INDICES[3]
        first = A.decode_audio(os.path.join(KERSHAW_SENTENCES, f'{index}.flac'))
        second = A.decode_audio(
            os.path.join(KERSHAW_SENTENCES, f'{index + 1}.flac'))
        path = _write_wav(os.path.join(self.tmp, 'concatenated.wav'),
                          np.concatenate([first, second]))
        job = {'index': index, 'audioPath': path,
               'text': self._spoken(self.texts[index]), 'language': 'en',
               'backend': 'whisperx', 'device': 'cpu', 'ffmpeg': None}
        alignment = A.alignment_from_dict(self._run([job])[0]['alignment'])
        result = C.evaluate_chunk(alignment, HIGGS_V3_COVERAGE, index=index)
        self.assertTrue(result.inserted_audio,
                        'the second chunk was not reported as inserted audio')
        self.assertTrue(result.failed, result.reasons)
        longest = max(result.inserted_audio, key=lambda s: s.duration_s)
        self.assertGreater(longest.duration_s, 5.0)
        print(f'\n[measured] inserted-audio case: {longest.duration_s:.1f}s '
              f'unexplained at {longest.start_s:.1f}s of '
              f'{alignment.duration_s:.1f}s ({longest.speech_fraction:.0%} speech)')

    def test_truncated_audio_strands_the_tail_of_the_text(self):
        """A chunk cut short: the stranded words must be reported."""
        index = MEASURED_INDICES[3]
        audio = A.decode_audio(os.path.join(KERSHAW_SENTENCES, f'{index}.flac'))
        path = _write_wav(os.path.join(self.tmp, 'truncated.wav'),
                          audio[:int(0.6 * audio.size)])
        job = {'index': index, 'audioPath': path,
               'text': self._spoken(self.texts[index]), 'language': 'en',
               'backend': 'whisperx', 'device': 'cpu', 'ffmpeg': None}
        alignment = A.alignment_from_dict(self._run([job])[0]['alignment'])
        result = C.evaluate_chunk(alignment, HIGGS_V3_COVERAGE, index=index)
        self.assertTrue(result.failed, result.reasons)
        self.assertTrue(result.dropped_text,
                        'the stranded tail was not reported as dropped')
        worst = max(result.dropped_text, key=lambda s: s.words)
        self.assertGreater(worst.last_word, len(alignment.words) * 0.6,
                           'the dropped run should be at the TAIL of the text')
        print(f'\n[measured] truncated case: ratio {result.aligned_ratio:.3f}, '
              f'worst span {worst.words} word(s) ending at word '
              f'{worst.last_word} of {len(alignment.words)}')

if __name__ == '__main__':
    unittest.main()
