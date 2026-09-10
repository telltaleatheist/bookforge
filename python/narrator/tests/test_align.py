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

class WorkerProtocolTest(unittest.TestCase):
    """The worker's result channel survives a library that prints on stdout.

    Runs the REAL `narrator.align.worker.main` in a subprocess with the
    backend faked to print a whisperx-style warning on stdout before
    answering: the parent must read exactly one JSON result on the worker's
    stdout and find the warning on stderr. Measured failure on 2026-09-05:
    whisperx's StreamHandler(sys.stdout) put "Failed to align segment" between
    two results and the parent died with JSONDecodeError("Extra data").
    """

    SCRIPT = """
import json, sys
sys.path.insert(0, {root!r})
import narrator.align.worker as worker
import narrator.align.aligner as aligner

class FakeAlignment:
    def as_dict(self):
        return {{'words': [], 'duration_s': 1.0}}

def fake_align_chunk(audio_path, text, **kw):
    print('2026-09-05 18:45:03 - whisperx.alignment - WARNING - Failed to align segment ("x")')
    sys.stdout.flush()
    return FakeAlignment()

worker.load_backend = lambda *a, **k: 0.0
worker.align_chunk = fake_align_chunk
sys.exit(worker.main())
"""

    def test_a_library_print_on_stdout_lands_on_stderr_not_in_the_results(self):
        import subprocess
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        job = json.dumps({'index': 7, 'audioPath': 'x.flac', 'text': 'hello',
                          'language': 'en', 'backend': 'whisperx', 'device': 'cpu'})
        proc = subprocess.run(
            [sys.executable, '-c', self.SCRIPT.format(root=root)],
            input=(job + '\n').encode('utf-8'), capture_output=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        lines = [l for l in proc.stdout.decode('utf-8').splitlines() if l.strip()]
        self.assertEqual(len(lines), 1, lines)
        result = json.loads(lines[0])
        self.assertEqual((result['ok'], result['index']), (True, 7))
        self.assertIn('Failed to align segment', proc.stderr.decode('utf-8', 'replace'))


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

    def test_mps_is_refused_by_the_same_lock_as_cuda(self):
        """The Mac case, and it is not a courtesy: `mps` IS the render's device.

        BookForge started offering "align on GPU" on 2026-09-07, which on this
        Mac resolves to `mps` - the same unified memory and the same Metal queue
        an Orpheus render is using. A lock that stops CUDA and waves MPS through
        would be a rule that protects the machine nobody is running on.
        """
        with tempfile.TemporaryDirectory() as tmp:
            lock = os.path.join(tmp, 'external-gpu-job.lock')
            open(lock, 'w').close()
            old = os.environ.get(A.GPU_LOCK_ENV)
            os.environ[A.GPU_LOCK_ENV] = lock
            try:
                with self.assertRaises(A.AlignerError) as caught:
                    A.check_device('mps')
                self.assertIn(lock, str(caught.exception))
                self.assertIn('MPS', str(caught.exception))
                # And the way out is still named.
                self.assertIn('device=cpu', str(caught.exception))
            finally:
                if old is None:
                    del os.environ[A.GPU_LOCK_ENV]
                else:
                    os.environ[A.GPU_LOCK_ENV] = old

    def test_mps_is_allowed_when_no_job_owns_the_card(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get(A.GPU_LOCK_ENV)
            os.environ[A.GPU_LOCK_ENV] = os.path.join(tmp, 'absent.lock')
            try:
                self.assertEqual(A.check_device('mps'), 'mps')
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
    """Two aligners ship (2026-09-08) and BOTH arrive by name. There is still no
    runtime guess and no retry: a failing backend raises."""

    def test_both_aligners_ship_and_the_default_is_still_whisperx(self):
        """The DEFAULT is the contract. qwen3 is 22x faster and tighter on
        Shift's chunk starts, but its scores are derived against coverage
        thresholds calibrated on whisperx's model scores, so moving the app onto
        it is a separate decision with its own calibration behind it."""
        self.assertEqual(A.BACKENDS, ('whisperx', 'qwen3'))
        self.assertEqual(A.DEFAULT_BACKEND, 'whisperx')
        self.assertEqual(sorted(A._BACKEND_FUNCTIONS), ['qwen3', 'whisperx'])
        self.assertEqual(sorted(A._BACKEND_LOADERS), ['qwen3', 'whisperx'])
        self.assertEqual(sorted(E.BACKEND_MODULES), ['qwen3', 'whisperx'])
        # Every shipped backend says what its `score` field means, and there is
        # exactly one table saying it.
        self.assertEqual(sorted(A.SCORE_SOURCE_BY_BACKEND), sorted(A.BACKENDS))
        self.assertTrue(set(A.SCORE_SOURCE_BY_BACKEND.values())
                        <= set(A.SCORE_SOURCES))
        self.assertEqual(A.SCORE_SOURCE_BY_BACKEND['whisperx'], 'model')
        self.assertEqual(A.SCORE_SOURCE_BY_BACKEND['qwen3'], 'derived')

    def test_the_qwen3_backend_module_is_named_for_env_discovery(self):
        self.assertEqual(E.BACKEND_MODULES['qwen3'], 'qwen_asr')

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

    def test_a_word_whisperx_split_at_a_sentence_end_is_rejoined_by_exact_concatenation(self):
        """Measured 2026-09-05/06 (witches x8, Fuhrer chunk 6, SGLang chunk 5):
        whisperx splits the text into sentences first, so `grown!'"?` comes
        back as two words. They are rejoined only when their concatenation is
        exactly our word; anything else is still the refusal."""
        raw = [('the', 0.0, 0.1, 0.9), ("grown!'", 0.2, 0.5, 0.8), ('\'"?', 0.5, 0.55, 0.3),
               ('Yes.', 0.6, 0.8, 0.95)]
        expected = ('the', 'grown!\'"?', 'Yes.')
        self.assertEqual(A._rejoin_split_words(raw, expected), [
            ('the', 0.0, 0.1, 0.9), ('grown!\'"?', 0.2, 0.55, 0.3), ('Yes.', 0.6, 0.8, 0.95)])
        # A piece that is not a prefix of the word it should complete: refused.
        self.assertIsNone(A._rejoin_split_words(
            [('the', 0.0, 0.1, 0.9), ('grown', 0.2, 0.5, 0.8), ('up', 0.5, 0.6, 0.8)],
            ('the', 'grown!', 'up')))
        # Fewer words than ours cannot be explained by a split either.
        self.assertIsNone(A._rejoin_split_words([('the', 0.0, 0.1, 0.9)], ('the', 'end.')))
        # And through align_chunk with a faked backend the count no longer refuses.
        import numpy as np
        real = A._BACKEND_FUNCTIONS['whisperx']
        A._BACKEND_FUNCTIONS['whisperx'] = lambda audio, text, language, device: raw
        try:
            audio = np.zeros(int(A.SAMPLE_RATE * 1.0), dtype=np.float32)
            alignment = A.align_chunk('one.flac', 'the grown!\'"? Yes.', backend='whisperx', audio=audio)
        finally:
            A._BACKEND_FUNCTIONS['whisperx'] = real
        self.assertEqual([w.word for w in alignment.words], ['the', 'grown!\'"?', 'Yes.'])
        self.assertEqual(alignment.words[1].end_s, 0.55)

    def test_a_backend_that_returns_no_words_names_the_truncated_render(self):
        """whisperx returns NO words when the audio cannot carry the text
        (measured: 138 words in 6.5 s). That is a truncated render, and the
        refusal says so with the words-per-second, not "word lists must line
        up"."""
        import numpy as np
        real = A._BACKEND_FUNCTIONS['whisperx']
        A._BACKEND_FUNCTIONS['whisperx'] = lambda audio, text, language, device: []
        try:
            audio = np.zeros(int(A.SAMPLE_RATE * 6.5), dtype=np.float32)
            with self.assertRaises(A.AlignerError) as caught:
                A.align_chunk('one.flac', ' '.join(['word'] * 138), backend='whisperx',
                              audio=audio)
        finally:
            A._BACKEND_FUNCTIONS['whisperx'] = real
        message = str(caught.exception)
        self.assertIn('could not align this chunk at all', message)
        self.assertIn('6.5s of audio for 138 word(s)', message)
        self.assertIn('21 words per second', message)
        self.assertIn('Re-render this chunk', message)
        self.assertNotIn('line up', message)

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
# Pure: the qwen3 backend, on a fake qwen_asr
# =============================================================================

class _FakeItem:
    """One of Qwen3ForcedAligner's own units: text plus two seconds."""

    def __init__(self, text, start, end):
        self.text = text
        self.start_time = start
        self.end_time = end


class _FakeQwen3Module:
    """A `qwen_asr` for `sys.modules`.

    NO MODEL, NO GPU, NO DOWNLOAD. `from_pretrained` records what it was handed
    (so the dtype and device rules can be asserted) and `align` returns whatever
    the test scripted. Everything between here and `align_chunk` - the language
    table, the 5-minute cap, the temp wav, the item mapping, the derived scores -
    is the shipped code.
    """

    def __init__(self):
        self.loads = []
        self.calls = []
        self.items = []
        module = self

        class Qwen3ForcedAligner:
            @classmethod
            def from_pretrained(cls, model_id, dtype=None, device_map=None):
                module.loads.append({'model': model_id, 'dtype': dtype,
                                     'device': device_map})
                return cls()

            def align(self, audio, text, language):
                module.calls.append({'audio': audio, 'text': text,
                                     'language': language})
                return [list(module.items)]

        self.Qwen3ForcedAligner = Qwen3ForcedAligner


class Qwen3BackendTest(unittest.TestCase):
    """Qwen3-ForcedAligner-0.6B, the backend added 2026-09-08.

    THE MEASUREMENT THAT BOUGHT IT (Shift, 1,083 chunks, RTX 3090 Ti in WSL):
    395x realtime against whisperx's 18x, 890 chunk starts inside 0.1 s against
    39/61. What it does NOT give is a per-word confidence, which is why the
    scores here are DERIVED and why every one of these tests is really about
    saying so honestly.
    """

    def setUp(self):
        import sys
        self.qwen = _FakeQwen3Module()
        self._saved = sys.modules.get('qwen_asr')
        sys.modules['qwen_asr'] = self.qwen
        self.addCleanup(self._restore)
        # A cold cache per test: the loader keys on (backend, language, device)
        # and a model left over from another test would hide a load bug.
        for key in [k for k in A._MODEL_CACHE if k[0] == 'qwen3']:
            del A._MODEL_CACHE[key]
        self.addCleanup(lambda: [A._MODEL_CACHE.pop(k) for k in
                                 [k for k in A._MODEL_CACHE if k[0] == 'qwen3']])

    def _restore(self):
        import sys
        if self._saved is None:
            sys.modules.pop('qwen_asr', None)
        else:
            sys.modules['qwen_asr'] = self._saved

    def _audio(self, seconds=1.0, silent_from=None):
        """Speech-shaped noise, optionally going quiet part way through."""
        import numpy as np
        n = int(A.SAMPLE_RATE * seconds)
        audio = (np.random.RandomState(0).randn(n) * 0.2).astype('float32')
        if silent_from is not None:
            audio[int(A.SAMPLE_RATE * silent_from):] = 0.0
        return audio

    # ---- the item mapping ---------------------------------------------------

    def test_items_that_MERGE_and_SPLIT_our_words_still_map_one_to_one(self):
        """Qwen tokenizes the text itself - measured 2026-09-08 in the
        `qwen-align` env, 665 items for a 668-word window - so its units merge
        and split against a whitespace split. Both are mapped by walking the
        normalized characters, and every one of OUR words comes back."""
        items = [_FakeItem('the quick', 0.0, 0.5),   # merged over two words
                 _FakeItem('bro', 0.5, 0.7),          # split across one word
                 _FakeItem('wn', 0.7, 0.8),
                 _FakeItem('fox', 0.9, 1.1)]
        mapped = A._map_items_onto_words(items, ('the', 'quick', 'brown', 'fox'))
        self.assertEqual([m[0] for m in mapped],
                         ['the', 'quick', 'brown', 'fox'])
        # A MERGED item gives both its words the merged span - that is all the
        # model said about either, and leaving the second untimed would make
        # `sentence_cues` refuse a chunk for a merge the model may make.
        self.assertEqual(mapped[0][1:3], (0.0, 0.5))
        self.assertEqual(mapped[1][1:3], (0.0, 0.5))
        # A SPLIT word spans the first piece's start to the last piece's end.
        self.assertEqual(mapped[2][1:3], (0.5, 0.8))
        self.assertEqual(mapped[3][1:3], (0.9, 1.1))
        # No score comes back from the model, and none is invented here.
        self.assertEqual([m[3] for m in mapped], [None] * 4)

    def test_a_word_no_item_covers_is_UNTIMED_rather_than_guessed(self):
        items = [_FakeItem('the', 0.0, 0.3), _FakeItem('fox', 0.4, 0.7)]
        mapped = A._map_items_onto_words(items, ('the', '--', 'fox'))
        self.assertEqual([m[0] for m in mapped], ['the', '--', 'fox'])
        self.assertEqual(mapped[1][1:3], (None, None))

    def test_a_model_that_REWROTE_the_text_is_refused_by_name(self):
        items = [_FakeItem('the', 0.0, 0.3), _FakeItem('cat', 0.4, 0.7)]
        with self.assertRaises(A.AlignerError) as caught:
            A._map_items_onto_words(items, ('the', 'fox'))
        message = str(caught.exception)
        self.assertIn('qwen3', message)
        self.assertIn('not the text it was given', message)
        self.assertIn('thefox', message)
        self.assertIn('thecat', message)

    def test_no_items_at_all_is_refused_rather_than_read_as_a_rewrite(self):
        with self.assertRaises(A.AlignerError) as caught:
            A._map_items_onto_words([], ('the', 'fox'))
        self.assertIn('returned no items for 2 word(s)', str(caught.exception))

    # ---- the language table -------------------------------------------------

    def test_the_iso_code_becomes_the_models_english_language_NAME(self):
        self.assertEqual(A.qwen3_language_name('en'), 'English')
        self.assertEqual(A.qwen3_language_name('de'), 'German')
        self.assertEqual(A.qwen3_language_name('yue'), 'Cantonese')
        self.assertEqual(len(A.QWEN3_LANGUAGES), 11)

    def test_a_language_the_model_does_not_speak_is_refused_by_name(self):
        """It does not fall back to English for a language it was not trained
        on - it just places the words badly, which is a silently mis-aligned
        book."""
        for bad in ('sv', 'nl', 'eng', 'EN'):
            with self.assertRaises(A.AlignerError) as caught:
                A.qwen3_language_name(bad)
            message = str(caught.exception)
            self.assertIn(repr(bad), message)
            self.assertIn('whisperx', message)
        # ...and the loader refuses BEFORE a model is fetched, so an unsupported
        # code costs a refusal rather than a load plus a bad book.
        with self.assertRaises(A.AlignerError):
            A._load_qwen3('sv', 'cpu')
        self.assertEqual(self.qwen.loads, [])

    # ---- the loader ---------------------------------------------------------

    def test_the_checkpoint_the_dtype_and_the_device_are_what_was_measured(self):
        import torch
        A._load_qwen3('en', 'cpu')
        self.assertEqual(self.qwen.loads[-1]['model'],
                         'Qwen/Qwen3-ForcedAligner-0.6B')
        # float32 on CPU: bfloat16 matmuls are emulated there.
        self.assertIs(self.qwen.loads[-1]['dtype'], torch.float32)
        self.assertEqual(self.qwen.loads[-1]['device'], 'cpu')
        # bfloat16 on the accelerators, which is what the bake-off ran. NO GPU
        # IS TOUCHED: the model is the fake above and this only records a dtype.
        A._load_qwen3('en', 'cuda:0')
        self.assertIs(self.qwen.loads[-1]['dtype'], torch.bfloat16)
        self.assertEqual(self.qwen.loads[-1]['device'], 'cuda:0')

    def test_the_model_is_cached_per_backend_language_and_device(self):
        A._load_qwen3('en', 'cpu')
        A._load_qwen3('en', 'cpu')
        self.assertEqual(len(self.qwen.loads), 1)
        A._load_qwen3('de', 'cpu')
        self.assertEqual(len(self.qwen.loads), 2)
        self.assertIn(('qwen3', 'en', 'cpu'), A._MODEL_CACHE)

    # ---- the five-minute cap ------------------------------------------------

    def test_audio_past_five_minutes_is_refused_BY_NAME(self):
        """The model card's own limit: it places timestamps "within up to 5
        minutes". Narrator chunks are <= ~90 s and the corpus cutter windows to
        5 minutes itself, so anything longer is a caller's bug."""
        import numpy as np
        audio = np.zeros(int(A.SAMPLE_RATE * 301), dtype='float32')
        with self.assertRaises(A.AlignerError) as caught:
            A.align_chunk('long.flac', 'one two', backend='qwen3', audio=audio)
        message = str(caught.exception)
        self.assertIn('long.flac', message)
        self.assertIn('301.0s of audio', message)
        self.assertIn('300s', message)
        self.assertEqual(self.qwen.calls, [])

    def test_five_minutes_exactly_is_allowed(self):
        self.assertEqual(A.QWEN3_MAX_AUDIO_S, 300.0)

    # ---- what a qwen3 alignment SAYS ---------------------------------------

    def test_a_qwen3_alignment_is_marked_derived_and_names_its_pace_source(self):
        self.qwen.items = [_FakeItem('one', 0.0, 0.4),
                           _FakeItem('two', 0.5, 0.9)]
        audio = self._audio(1.0)

        measured = A.align_chunk('c.flac', 'one two', backend='qwen3',
                                 audio=audio)
        self.assertEqual(measured.score_source, 'derived')
        self.assertEqual(measured.pace_source, 'chunk')
        # The chunk's own printed characters over its own audio seconds.
        self.assertAlmostEqual(measured.pace_chars_per_sec, 7.0, places=6)
        self.assertEqual(measured.backend, 'qwen3')
        # It hands the model a PATH and the ENGLISH NAME, and cleans the wav up.
        call = self.qwen.calls[-1]
        self.assertEqual(call['language'], 'English')
        self.assertEqual(call['text'], 'one two')
        self.assertTrue(call['audio'].endswith('.wav'))
        self.assertFalse(os.path.exists(call['audio']))

        given = A.align_chunk('c.flac', 'one two', backend='qwen3', audio=audio,
                              pace_chars_per_sec=15.0)
        self.assertEqual(given.pace_source, 'given')
        self.assertEqual(given.pace_chars_per_sec, 15.0)

    def test_a_whisperx_alignment_carries_no_pace_at_all(self):
        """A model score was never measured against a pace, so reporting one
        would be a number nobody chose."""
        raw = [('one', 0.0, 0.4, 0.9), ('two', 0.5, 0.9, 0.8)]
        saved = A._BACKEND_FUNCTIONS['whisperx']
        A._BACKEND_FUNCTIONS['whisperx'] = lambda audio, text, language, device: raw
        try:
            alignment = A.align_chunk('c.flac', 'one two', audio=self._audio(),
                                      pace_chars_per_sec=15.0)
        finally:
            A._BACKEND_FUNCTIONS['whisperx'] = saved
        self.assertEqual(alignment.score_source, 'model')
        self.assertIsNone(alignment.pace_source)
        self.assertIsNone(alignment.pace_chars_per_sec)
        self.assertEqual([w.score for w in alignment.words], [0.9, 0.8])


class DerivedScoreTest(unittest.TestCase):
    """The three factors that stand in for a confidence the model never gives.

    THEY ARE FIRST ESTIMATES, NOT MEASUREMENTS - the calibration data is the
    Shift coverage run and it has not been scored against them yet. What these
    tests pin is that each factor is WIRED and that the product is the score, so
    a later calibration moves numbers rather than discovering that one of the
    three was never applied.
    """

    #: 14 chars/sec - the middle of the measured Higgs band (deathstalker 16.73,
    #: mistborn 15.01 at the standing 0.8/0.95/50 sampling), rounded to make the
    #: arithmetic in these tests readable.
    PACE = 14.0

    def _score(self, words, silences=()):
        return [w.score for w in A._derive_scores(words, silences, self.PACE)]

    def test_a_word_placed_entirely_inside_a_pause_scores_zero(self):
        words = (_word(0, 'hello', 1.0, 1.4, None),)
        self.assertEqual(self._score(words, silences=((0.9, 1.5),)), [0.0])

    def test_a_normal_word_scores_about_one(self):
        # 5 letters in 0.36 s is 13.9 chars/sec - dead on the pace.
        words = (_word(0, 'hello', 0.0, 0.36, None),)
        self.assertAlmostEqual(self._score(words)[0], 1.0, places=6)

    def test_an_implausibly_fast_word_scores_low(self):
        """A 0.02 s span carrying a 9-character word is not a word the model
        found; it is a word the model had nowhere to put."""
        fast = self._score((_word(0, 'certainly', 0.0, 0.02, None),))[0]
        self.assertLess(fast, 0.1)
        # ...and past 6x the pace it is zero, not merely small.
        self.assertEqual(self._score((_word(0, 'certainly', 0.0, 0.01, None),))[0],
                         0.0)

    def test_an_implausibly_slow_word_scores_low_too(self):
        # One letter over four seconds is 0.25 chars/sec, well under pace/6.
        self.assertEqual(self._score((_word(0, 'a', 0.0, 4.0, None),))[0], 0.0)

    def test_a_word_that_goes_BACKWARDS_scores_zero(self):
        """Forced alignment is monotonic; a word starting before the previous
        one ended is not a placement. 50 ms of slack, because adjacent word
        boundaries touch."""
        words = (_word(0, 'hello', 0.00, 0.36, None),
                 _word(1, 'there', 0.34, 0.70, None),   # 20 ms back: allowed
                 _word(2, 'again', 0.10, 0.46, None))   # 600 ms back: not
        scores = self._score(words)
        self.assertAlmostEqual(scores[0], 1.0, places=6)
        self.assertAlmostEqual(scores[1], 1.0, places=6)
        self.assertEqual(scores[2], 0.0)

    def test_the_score_is_the_PRODUCT_of_the_three(self):
        """Half the word in silence and a plausible rate and order: 0.5."""
        words = (_word(0, 'hello', 0.0, 0.36, None),)
        self.assertAlmostEqual(self._score(words, silences=((0.18, 0.36),))[0],
                               0.5, places=6)

    def test_an_untimed_word_keeps_score_None_the_stronger_signal(self):
        words = (A.AlignedWord(0, 'gone', None, None, None),)
        self.assertEqual(self._score(words), [None])

    def test_a_pace_of_zero_is_refused_rather_than_divided_by(self):
        with self.assertRaises(A.AlignerError) as caught:
            A._derive_scores((_word(0, 'x', 0.0, 0.1, None),), (), 0.0)
        self.assertIn('characters per second', str(caught.exception))


class AlignmentWireTest(unittest.TestCase):
    """`as_dict` / `alignment_from_dict` - the cross-interpreter worker's wire.

    `scoreSource` is REQUIRED there and has no default, because the one thing a
    default could mean is "the model scored this", which is exactly what a qwen3
    document must never be read as.
    """

    def _alignment(self, **kw):
        words = (_word(0, 'one', 0.0, 0.4), _word(1, 'two', 0.5, 0.9))
        return A.Alignment(audio_path='c.flac', text='one two', language='en',
                           backend='whisperx', device='cpu', duration_s=1.0,
                           words=words, elapsed_s=0.25, **kw)

    def test_a_model_scored_alignment_round_trips(self):
        original = self._alignment(score_source='model')
        back = A.alignment_from_dict(json.loads(json.dumps(original.as_dict())))
        self.assertEqual(back.score_source, 'model')
        self.assertIsNone(back.pace_chars_per_sec)
        self.assertIsNone(back.pace_source)
        self.assertEqual([w.score for w in back.words], [0.9, 0.9])

    def test_a_derived_alignment_round_trips_with_its_pace(self):
        original = self._alignment(score_source='derived',
                                   pace_chars_per_sec=14.0,
                                   pace_source='chunk')
        back = A.alignment_from_dict(json.loads(json.dumps(original.as_dict())))
        self.assertEqual(back.score_source, 'derived')
        self.assertEqual(back.pace_chars_per_sec, 14.0)
        self.assertEqual(back.pace_source, 'chunk')

    def test_a_document_with_no_scoreSource_is_REFUSED_not_defaulted(self):
        document = self._alignment(score_source='model').as_dict()
        del document['scoreSource']
        with self.assertRaises(A.AlignerError) as caught:
            A.alignment_from_dict(document)
        message = str(caught.exception)
        self.assertIn('scoreSource', message)
        self.assertIn('2026-09-08', message)

    def test_a_document_with_an_unknown_scoreSource_is_refused(self):
        document = self._alignment(score_source='model').as_dict()
        document['scoreSource'] = 'vibes'
        with self.assertRaises(A.AlignerError) as caught:
            A.alignment_from_dict(document)
        self.assertIn("'vibes'", str(caught.exception))

    def test_the_pace_keys_are_required_too(self):
        for key in ('paceCharsPerSecond', 'paceSource'):
            document = self._alignment(score_source='derived',
                                       pace_chars_per_sec=14.0,
                                       pace_source='given').as_dict()
            del document[key]
            with self.assertRaises(A.AlignerError) as caught:
                A.alignment_from_dict(document)
            self.assertIn(key, str(caught.exception))


# =============================================================================
# Pure: sentence cues
# =============================================================================

def _alignment(text, words, duration, silences=(), score_source='model',
               pace=None, pace_source=None):
    """A hand-built Alignment with its spans DERIVED, not declared.

    `_spans` is what `align_chunk` runs; deriving them here means a coverage
    test cannot pass by being handed spans the real path would not have drawn.

    `score_source` has no default on `Alignment` itself (a derived score must
    never reach `coverage.py` wearing the model's clothes), so every fixture
    states it. 'model' here, because these fixtures' scores are whisperx-shaped.
    """
    words = tuple(words)
    silences = tuple(silences)
    text_spans, audio_spans = A._spans(words, silences, duration)
    return A.Alignment(
        audio_path='chunk.flac', text=text, language='en', backend='whisperx',
        device='cpu', duration_s=duration, words=words,
        score_source=score_source,
        unaligned_text_spans=text_spans, unaligned_audio_spans=audio_spans,
        silences=silences, pace_chars_per_sec=pace, pace_source=pace_source)


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
        # SentenceVttError, not AlignerError: the writer lives in `assemble/`
        # now (assembly writes this file too and may not import `align/`), and
        # `align/run.write_outputs` is what turns it back into an AlignerError
        # for the CLI's one `except`.
        with self.assertRaises(S.SentenceVttError):
            S.build_sentence_vtt(bad)

    def test_an_estimated_cue_is_marked_in_the_file_and_a_measured_one_is_not(self):
        """THE representation, asserted: one `NOTE estimated chunk <i>` block
        per run of estimated cues, and nothing at all around a measured one."""
        from narrator.assemble import sentence_vtt as SV
        measured = S.SentenceCue(0, 0, 0.0, 1.0, 'Measured.')
        estimated = SV.proportional_cues(
            chunk_index=1, chunk_start_s=1.0, chunk_end_s=3.0,
            text='One two three. Four five six.')
        document = S.build_sentence_vtt([measured, *estimated])
        self.assertEqual(document.count('NOTE estimated chunk 1'), 1)
        self.assertNotIn('NOTE estimated chunk 0', document)
        # Every cue is still a cue: three of them, in order.
        self.assertEqual(document.count(' --> '), 3)

    def test_proportional_cues_fill_the_chunks_own_span_by_character_share(self):
        from narrator.assemble import sentence_vtt as SV
        cues = SV.proportional_cues(
            chunk_index=4, chunk_start_s=10.0, chunk_end_s=20.0,
            text='Aaaa. Bbbbbbbbbbbbbbbbbb.')
        self.assertEqual(len(cues), 2)
        self.assertTrue(all(c.estimated for c in cues))
        self.assertAlmostEqual(cues[0].start_s, 10.0, places=6)
        self.assertAlmostEqual(cues[-1].end_s, 20.0, places=6)
        self.assertAlmostEqual(cues[0].end_s, cues[1].start_s, places=6)
        # The longer sentence gets the longer cue.
        self.assertGreater(cues[1].end_s - cues[1].start_s,
                           cues[0].end_s - cues[0].start_s)

    def test_a_marker_only_chunk_estimates_to_no_cues_at_all(self):
        from narrator.assemble import sentence_vtt as SV
        self.assertEqual(
            SV.proportional_cues(chunk_index=2, chunk_start_s=0.0,
                                 chunk_end_s=1.0, text='[break]'),
            ())


class CueQualityTest(unittest.TestCase):
    """Every MEASURED cue's report card, and the NOTE line that carries it.

    WHY IT EXISTS. The qwen3 backend PLACES a window whose printed text differs
    from the speech instead of refusing it - that is what 116 of Shift's 1,083
    chunk-start misses were, headings like "2110." and the prose right after
    them. A consumer picking alignment-clean sentences out of a book needs the
    evidence, so each cue carries six measurements and the VTT writes them in a
    fixed, parseable form.

    NOTHING IN THIS PACKAGE ACTS ON THEM. No cue is dropped, re-timed or
    reclassified on a quality number; the thresholds belong to whoever reads the
    file. These tests assert the MEASUREMENT and the FORMAT, and nothing else.
    """

    def setUp(self):
        # The same fixture SentenceCueTest uses, so the seam is the known one:
        # the pause runs 0.95..2.05 and the seam lands on its midpoint, 1.50.
        self.text = 'One two. Three four.'
        self.words = [
            _word(0, 'One', 0.00, 0.40, 0.95), _word(1, 'two.', 0.40, 0.90, 0.90),
            _word(2, 'Three', 2.10, 2.50, 0.80), _word(3, 'four.', 2.50, 3.00, 0.99),
        ]
        self.al = _alignment(self.text, self.words, 3.20,
                             silences=((0.95, 2.05),), score_source='derived',
                             pace=10.0, pace_source='given')

    def _cues(self):
        return S.sentence_cues(self.al, chunk_index=7, chunk_start_s=0.0,
                               chunk_end_s=3.2)

    def test_every_measured_cue_carries_the_six_measurements(self):
        for cue in self._cues():
            self.assertEqual(
                sorted(cue.quality),
                ['boundary_silence_s', 'chars_per_sec', 'monotonic',
                 'pace_ratio', 'score_source', 'worst_word_score'])
            self.assertEqual(cue.quality['score_source'], 'derived')
            self.assertTrue(cue.quality['monotonic'])

    def test_the_numbers_are_measured_off_the_cue_and_the_silence_map(self):
        first, second = self._cues()
        # Cue 0: 8 characters over the 1.50 s up to the seam.
        self.assertAlmostEqual(first.end_s, 1.50, places=6)
        self.assertAlmostEqual(first.quality['chars_per_sec'], 8 / 1.5, places=6)
        self.assertAlmostEqual(first.quality['pace_ratio'], 8 / 1.5 / 10.0,
                               places=6)
        # It STARTS IN SPEECH (0.0 is before the pause), so there is no
        # boundary silence to report - 0.0, not "unknown".
        self.assertEqual(first.quality['boundary_silence_s'], 0.0)
        self.assertAlmostEqual(first.quality['worst_word_score'], 0.90, places=6)
        # Cue 1 starts at 1.50, inside the 0.95..2.05 pause: 1.10 s of it.
        self.assertAlmostEqual(second.quality['boundary_silence_s'], 1.10,
                               places=6)
        self.assertAlmostEqual(second.quality['worst_word_score'], 0.80,
                               places=6)

    def test_a_model_scored_alignment_reports_no_pace_ratio(self):
        """None, not 1.0: a whisperx alignment never measured a pace, and a
        ratio against a number nobody chose would be invented at write time."""
        model = _alignment(self.text, self.words, 3.20,
                           silences=((0.95, 2.05),))
        cues = S.sentence_cues(model, chunk_index=7, chunk_start_s=0.0,
                               chunk_end_s=3.2)
        self.assertIsNone(cues[0].quality['pace_ratio'])
        self.assertEqual(cues[0].quality['score_source'], 'model')

    def test_the_VTT_NOTE_line_is_the_exact_documented_format(self):
        document = S.build_sentence_vtt(self._cues())
        lines = document.splitlines()
        notes = [l for l in lines if l.startswith('NOTE quality')]
        self.assertEqual(len(notes), 2)
        self.assertEqual(
            notes[0],
            'NOTE quality monotonic=1 cps=5.3 pace_ratio=0.53 '
            'boundary_silence=0.00 worst=0.90 source=derived')
        self.assertEqual(
            notes[1],
            'NOTE quality monotonic=1 cps=6.5 pace_ratio=0.65 '
            'boundary_silence=1.10 worst=0.80 source=derived')
        # It sits IMMEDIATELY BEFORE its cue, with the blank line every WebVTT
        # block ends on between them.
        self.assertEqual(lines[lines.index(notes[0]) + 1], '')
        self.assertIn('-->', lines[lines.index(notes[0]) + 2])

    def test_a_none_valued_field_is_written_as_a_parseable_none(self):
        """Not a missing pair: a reader splitting the line on spaces would
        otherwise read the NEXT pair's value into this field's slot."""
        model = _alignment(self.text, self.words, 3.20,
                           silences=((0.95, 2.05),))
        cues = S.sentence_cues(model, chunk_index=7, chunk_start_s=0.0,
                               chunk_end_s=3.2)
        note = [l for l in S.build_sentence_vtt(cues).splitlines()
                if l.startswith('NOTE quality')][0]
        self.assertIn('pace_ratio=none', note)
        self.assertIn('source=model', note)
        self.assertEqual(len(note.split(' ')), 2 + len(S.QUALITY_NOTE_KEYS))

    def test_an_ESTIMATED_cue_carries_no_quality_line_at_all(self):
        """It was never measured. The `NOTE estimated chunk` block is still
        exactly where it was."""
        from narrator.assemble import sentence_vtt as SV
        estimated = SV.proportional_cues(
            chunk_index=1, chunk_start_s=3.2, chunk_end_s=5.2,
            text='One two three. Four five six.')
        self.assertTrue(all(c.quality is None for c in estimated))
        document = S.build_sentence_vtt([*self._cues(), *estimated])
        self.assertEqual(document.count('NOTE estimated chunk 1'), 1)
        # Two measured cues, two quality lines - and none for the estimates.
        self.assertEqual(document.count('NOTE quality'), 2)

    def test_a_cue_that_claims_to_be_both_estimated_and_measured_is_refused(self):
        bad = S.SentenceCue(0, 0, 0.0, 1.0, 'a', estimated=True,
                            quality=dict(self._cues()[0].quality))
        with self.assertRaises(S.SentenceVttError) as caught:
            S.build_sentence_vtt([bad])
        self.assertIn('estimated AND carries a quality', str(caught.exception))

    def test_a_quality_dict_missing_a_key_is_refused_not_written_short(self):
        quality = dict(self._cues()[0].quality)
        del quality['worst_word_score']
        bad = S.SentenceCue(0, 0, 0.0, 1.0, 'a', quality=quality)
        with self.assertRaises(S.SentenceVttError) as caught:
            S.build_sentence_vtt([bad])
        self.assertIn('worst_word_score', str(caught.exception))


class AlignTextWindowTest(unittest.TestCase):
    """`align/window.align_text_window` - the corpus cutter's door.

    It holds a decoded five-minute window of an existing audiobook and the book
    text it believes belongs to it. It has no session, no manifest and no FLAC
    per chunk, and minting a fake session per window to reach `align_chunk`
    would be a lie told to a schema. So: one function, one window, JSON-safe out.
    """

    TEXT = 'One two. Three four.'
    SECONDS = 3.2

    def setUp(self):
        import sys
        self.qwen = _FakeQwen3Module()
        self.qwen.items = [_FakeItem('One', 0.0, 0.4),
                           _FakeItem('two.', 0.4, 0.9),
                           _FakeItem('Three', 2.1, 2.5),
                           _FakeItem('four.', 2.5, 3.0)]
        self._saved = sys.modules.get('qwen_asr')
        sys.modules['qwen_asr'] = self.qwen
        self.addCleanup(self._restore)
        for key in [k for k in A._MODEL_CACHE if k[0] == 'qwen3']:
            del A._MODEL_CACHE[key]

    def _restore(self):
        import sys
        for key in [k for k in A._MODEL_CACHE if k[0] == 'qwen3']:
            del A._MODEL_CACHE[key]
        if self._saved is None:
            sys.modules.pop('qwen_asr', None)
        else:
            sys.modules['qwen_asr'] = self._saved

    def _samples(self):
        import numpy as np
        return (np.random.RandomState(0).randn(
            int(A.SAMPLE_RATE * self.SECONDS)) * 0.2).astype('float32')

    def _check(self, window):
        self.assertEqual(sorted(window),
                         ['alignment', 'backend', 'cues', 'score_source'])
        self.assertEqual(window['backend'], 'qwen3')
        self.assertEqual(window['score_source'], 'derived')
        self.assertEqual([c['text'] for c in window['cues']],
                         ['One two.', 'Three four.'])
        # WINDOW-RELATIVE SECONDS. The cutter knows where the window sits in the
        # book; this does not, so cue 0 starts at 0 and the last ends on the
        # window's own duration.
        self.assertEqual(window['cues'][0]['start'], 0.0)
        self.assertAlmostEqual(window['cues'][-1]['end'], self.SECONDS, places=3)
        self.assertEqual(window['cues'][0]['quality']['score_source'],
                         'derived')
        # It crosses a pipe: every value has to be JSON.
        json.loads(json.dumps(window))

    def test_an_already_decoded_array_is_aligned_and_cued(self):
        from narrator.align import window as W
        self._check(W.align_text_window(
            self._samples(), self.TEXT, backend='qwen3', language='en',
            device='cpu', sample_rate=A.SAMPLE_RATE))

    def test_a_path_is_decoded_here_and_aligned(self):
        from narrator.align import window as W
        if shutil.which('ffmpeg') is None:
            raise unittest.SkipTest('ffmpeg is not on PATH; a path window is '
                                    'decoded through it')
        import soundfile
        tmp = tempfile.mkdtemp(prefix='narrator-window-')
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        path = os.path.join(tmp, 'window.wav')
        soundfile.write(path, self._samples(), A.SAMPLE_RATE, subtype='PCM_16')
        self._check(W.align_text_window(path, self.TEXT, backend='qwen3',
                                        language='en', device='cpu'))

    def test_an_array_at_the_wrong_rate_is_REFUSED_not_resampled(self):
        """A resampler hidden in an alignment library would silently change the
        signal the timings are measured against."""
        from narrator.align import window as W
        with self.assertRaises(A.AlignerError) as caught:
            W.align_text_window(self._samples(), self.TEXT, backend='qwen3',
                                language='en', device='cpu', sample_rate=22050)
        message = str(caught.exception)
        self.assertIn('22050 Hz', message)
        self.assertIn('nothing here resamples', message)

    def test_an_array_with_no_rate_is_refused(self):
        from narrator.align import window as W
        with self.assertRaises(A.AlignerError) as caught:
            W.align_text_window(self._samples(), self.TEXT, backend='qwen3',
                                language='en', device='cpu')
        self.assertIn('no sample_rate', str(caught.exception))

    def test_a_path_AND_a_rate_is_two_claims_about_one_audio(self):
        from narrator.align import window as W
        with self.assertRaises(A.AlignerError) as caught:
            W.align_text_window('w.wav', self.TEXT, backend='qwen3',
                                language='en', device='cpu', sample_rate=16000)
        self.assertIn('two different claims', str(caught.exception))

    def test_it_is_exported_from_the_package(self):
        import narrator.align as pkg
        from narrator.align.window import align_text_window
        self.assertIs(pkg.align_text_window, align_text_window)
        self.assertIn('align_text_window', pkg.__all__)


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

    def _document(self, failed=False, engine='higgs-v3', audited=True,
                  chunks=2, aligned=None, skipped=0, errors=()):
        chunk = {'index': 0, 'failed': failed,
                 'reasons': ['aligned ratio 0.500 is below 0.90'] if failed else [],
                 'droppedText': ([{'words': 9, 'text': 'the words it never said'}]
                                 if failed else [])}
        return {
            'version': coverage_gate.SUPPORTED_REPORT_VERSION,
            'engine': engine, 'audited': audited,
            'sessionId': 'sid', 'chunksInManifest': chunks,
            'summary': {'chunksAligned': chunks if aligned is None else aligned,
                        'chunksSkipped': skipped, 'chunksFailed': int(failed)},
            'chunks': [chunk],
            'errors': list(errors),
        }

    def test_a_failed_chunk_is_LOGGED_with_the_dropped_text_and_the_retake(self):
        """Owen, 2026-09-05: the audit reports, it does not refuse. Everything
        the old refusal said still has to be SAID - it just goes to the log and
        the assembly continues."""
        lines = []
        indices = coverage_gate.report_failures(
            self._document(failed=True), where='coverage.json', log=lines.append)
        message = '\n'.join(lines)
        self.assertIn('chunk 0', message)
        self.assertIn('the words it never said', message)
        self.assertIn('narrator retake --indices 0', message)
        self.assertEqual(indices, [0])

    def test_report_failures_never_raises(self):
        """THE point of the ruling, asserted directly: a report full of
        failures returns, it does not blow up the assembly."""
        indices = coverage_gate.report_failures(
            self._document(failed=True, errors=[{'index': 7, 'stage': 'align',
                                                 'error': 'boom'}]),
            where='coverage.json', log=lambda line: None)
        self.assertEqual(indices, [0, 7])

    def test_an_unaudited_engines_report_is_read_out_too(self):
        """A report that EXISTS was asked for by somebody; reading it out is
        why it was written. Orpheus is not audited by default and that decides
        whether a run carries an Align row - not whether a report is read."""
        lines = []
        coverage_gate.report_failures(
            self._document(failed=True, engine='orpheus', audited=False),
            where='coverage.json', log=lines.append)
        self.assertIn('the words it never said', '\n'.join(lines))

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

    def test_an_audited_engine_with_no_report_STILL_ASSEMBLES(self):
        """The disease this ruling cures: a Higgs book that nobody aligned used
        to be unassemblable. It says so and proceeds."""
        lines = []
        self.assertIsNone(
            coverage_gate.check(self._manifest('higgs-v3'),
                                r'C:\tmp\no-such-report.json', lines.append))
        message = '\n'.join(lines)
        self.assertIn('no coverage report', message)
        self.assertIn('estimates', message)

    def test_an_unaudited_engine_with_no_report_assembles(self):
        lines = []
        self.assertIsNone(
            coverage_gate.check(self._manifest('orpheus'), None, lines.append))
        self.assertIn('no coverage report beside the session', '\n'.join(lines))

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

    def test_a_chunk_nobody_aligned_is_REPORTED_not_refused(self):
        """A hole in the audit is a fact about the audit, said out loud. It was
        a refusal, which meant one unplaceable chunk cost the whole book."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(self._document(chunks=2, aligned=1), handle)
            lines = []
            document = coverage_gate.check(self._manifest('higgs-v3'), path,
                                           lines.append)
            self.assertIsNotNone(document)
            self.assertIn('never measured', '\n'.join(lines))

    def test_a_stale_report_NOBODY_NAMED_is_ignored_rather_than_refused(self):
        """A leftover `coverage.json` beside a session that has since been
        resumed describes a smaller book. Refusing on a file nobody asked for
        would cost an audiobook for a stray; it is named in the log and dropped.
        A report the CALLER named is still refused - that is the caller's claim
        and its being wrong is the caller's bug."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'coverage.json')
            with open(path, 'w', encoding='utf-8') as handle:
                json.dump(self._document(chunks=9), handle)
            manifest = self._manifest('higgs-v3', chunks=2)
            manifest.source.processDir = tmp
            lines = []
            self.assertIsNone(coverage_gate.check(manifest, None, lines.append))
            self.assertIn('not about this book', '\n'.join(lines))
            # ...and named, it still refuses.
            with self.assertRaises(coverage_gate.CoverageRefusal):
                coverage_gate.check(manifest, path, lambda line: None)

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
        self.assertTrue(profile_for('higgs-v3').coverage.audited)
        self.assertFalse(profile_for('orpheus').coverage.audited)
        self.assertIs(profile_for('higgs-v3').coverage, HIGGS_V3_COVERAGE)
        self.assertIs(profile_for('orpheus').coverage, ORPHEUS_COVERAGE)


class EstimatedTranscriptTest(unittest.TestCase):
    """The NO-REPORT path: assembly cues the book itself, and says so.

    Owen, 2026-09-05: "we need to base assembly on the expected text and the
    actual real length of the audio". With no alignment there is nothing to
    measure, so the cues are proportional and the file says so - and the book is
    still assembled, which is the whole point.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='narrator-estimated-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _manifest(self, texts):
        from narrator.manifest import (Book, Chapter, Chunk, Manifest, Source,
                                       Voice)
        return Manifest(
            source=Source(kind='e2a-session-v1', processDir=self.tmp,
                          sessionId='sid', epubContentHash='h'),
            book=Book(title='T', author='A', language='en', language3='eng'),
            voice=Voice(engine='orpheus', fineTuned='v'),
            sampleRate=24000, sentencesDir=os.path.join(self.tmp, 's'),
            chapters=[Chapter(index=1, title='C', doc=None, chunks=[
                Chunk(index=i, text=text, kind='prose',
                      file=f'{i}.flac', samples=24000)
                for i, text in enumerate(texts)])])

    def test_it_writes_the_transcript_beside_the_session_and_marks_it(self):
        from narrator.assemble.run import write_estimated_sentence_vtt

        lines = []
        path = write_estimated_sentence_vtt(
            self._manifest(['One two. Three four.', 'Five six.']), 'Book',
            lines.append)
        self.assertEqual(path, os.path.join(self.tmp, 'Book.sentences.vtt'))
        with open(path, encoding='utf-8') as handle:
            document = handle.read()
        self.assertTrue(document.startswith('WEBVTT\n\n'))
        self.assertEqual(document.count(' --> '), 3)
        # EVERY cue is an estimate here, and each chunk says so once.
        self.assertEqual(document.count('NOTE estimated chunk 0'), 1)
        self.assertEqual(document.count('NOTE estimated chunk 1'), 1)
        self.assertIn('ESTIMATED', '\n'.join(lines))

    def test_it_never_overwrites_a_measured_transcript(self):
        from narrator.assemble.run import write_estimated_sentence_vtt

        existing = os.path.join(self.tmp, 'Book.sentences.vtt')
        with open(existing, 'w', encoding='utf-8') as handle:
            handle.write('WEBVTT\n\nmeasured\n')
        lines = []
        self.assertIsNone(write_estimated_sentence_vtt(
            self._manifest(['One two.']), 'Book', lines.append))
        with open(existing, encoding='utf-8') as handle:
            self.assertIn('measured', handle.read())

    def test_a_broken_manifest_costs_the_transcript_and_not_the_audiobook(self):
        """A zero-length chunk has no audio to spread text over. It is named in
        the log; it does not raise, because the m4b is the deliverable."""
        from narrator.assemble.run import write_estimated_sentence_vtt

        manifest = self._manifest(['One two.', 'Three four.'])
        manifest.chapters[0].chunks[0].samples = 0
        lines = []
        self.assertIsNone(write_estimated_sentence_vtt(manifest, 'Book',
                                                       lines.append))
        self.assertIn('could not be written', '\n'.join(lines))


class ReportSchemaTest(unittest.TestCase):

    def test_the_document_carries_what_the_gate_verifies(self):
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(10)]
        coverages = [C.evaluate_chunk(_alignment('t', words, 5.0),
                                      HIGGS_V3_COVERAGE, index=0)]
        document = C.coverage_document(
            coverages, engine_id='higgs-v3', policy=HIGGS_V3_COVERAGE,
            backend='whisperx', language='en', score_source='model',
            session_id='sid', process_dir='/p', chunks_in_manifest=1)
        self.assertEqual(document['version'],
                         coverage_gate.SUPPORTED_REPORT_VERSION)
        self.assertTrue(document['audited'])
        self.assertEqual(document['summary']['chunksAligned'], 1)
        self.assertEqual(document['summary']['chunksSkipped'], 0)
        # It must survive a JSON round trip: assembly reads it off disk.
        json.loads(json.dumps(document))

    def test_the_document_says_what_its_scores_MEAN(self):
        """A `alignedRatio` of 0.93 means two different things depending on
        whether the scores behind it are whisperx's CTC posterior or the qwen3
        estimate this package derives. The report says which, at the top and on
        every chunk - and the schema VERSION does not move for it, because the
        gate requires `engine`/`summary`/`chunks` and an added key keeps every
        older report readable."""
        words = [_word(i, start=i * 0.5, end=i * 0.5 + 0.45) for i in range(10)]
        alignment = _alignment('t', words, 5.0, score_source='derived',
                               pace=14.0, pace_source='chunk')
        coverages = [C.evaluate_chunk(alignment, HIGGS_V3_COVERAGE, index=0)]
        document = C.coverage_document(
            coverages, engine_id='higgs-v3', policy=HIGGS_V3_COVERAGE,
            backend='qwen3', language='en', score_source='derived',
            session_id='sid', process_dir='/p', chunks_in_manifest=1)
        self.assertEqual(document['scoreSource'], 'derived')
        self.assertEqual(document['chunks'][0]['scoreSource'], 'derived')
        self.assertEqual(document['version'],
                         coverage_gate.SUPPORTED_REPORT_VERSION)
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


#: A worker that is NOT the aligner, so a pool can be driven without a model.
#:
#: It speaks the same JSON-lines protocol, records the job indices IT was dealt
#: (a file named by its own pid, under `FAKE_ALIGN_OUT`) and can be told to die
#: mid-list. It is reached the way the real one is - `python -m
#: narrator.align.worker` with `package_root()` on PYTHONPATH - by pointing
#: `package_root` at a temp tree, so the SHIPPED spawn, dealing, threading and
#: refusal code all run. Nothing is faked between here and `subprocess`.
FAKE_ALIGN_WORKER = r"""
import json, os, sys

out_dir = os.environ['FAKE_ALIGN_OUT']
die_on = os.environ.get('FAKE_ALIGN_DIE_ON_INDEX')
seen = []


def record():
    with open(os.path.join(out_dir, '%d.json' % os.getpid()), 'w') as handle:
        json.dump(seen, handle)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    job = json.loads(line)
    if die_on is not None and not seen and str(job['index']) == die_on:
        record()
        sys.stderr.write('the fake worker died on job %s\n' % job['index'])
        sys.stderr.flush()
        os._exit(3)
    seen.append(job['index'])
    sys.stdout.write(json.dumps({'ok': True, 'index': job['index']}) + '\n')
    sys.stdout.flush()
record()
"""


class WorkerPoolTest(unittest.TestCase):
    """`run_jobs(workers=N)` - N worker processes over one job list.

    WHY THE POOL EXISTS. Owen, 2026-09-08, on the Shift book: "align is taking
    way too long... 3x slower than the TTS render. we have to find a more
    efficient way of handling this." Measured there: 11.4 chunks/min, 115 min of
    CPU for a book whose render took 37 (RTF ~0.08, one process, sharing the
    machine with the assembly encode).

    THREE THINGS ARE ASSERTED, because three things can silently go wrong when
    one stream of results becomes N: the results can come back in ARRIVAL order
    instead of job order (a transcript cued against the wrong chunks), a dead
    worker can be counted as a finished one (a third of the book missing and the
    run reporting success), and the dealing can pile the long chunks onto one
    worker.
    """

    JOBS = 7
    POOL = 3

    def _jobs(self, count=None):
        text = 'the quick brown fox jumps over the lazy dog. '
        return [{'index': i, 'audioPath': f'/nope/{i}.flac', 'text': text,
                 'language': 'en', 'backend': 'no-such-backend', 'device': 'cpu'}
                for i in range(self.JOBS if count is None else count)]

    def _fake_root(self, root):
        """A `narrator.align.worker` that is `FAKE_ALIGN_WORKER`, under a root
        `package_root()` can be pointed at."""
        pkg = os.path.join(root, 'narrator', 'align')
        os.makedirs(pkg)
        open(os.path.join(root, 'narrator', '__init__.py'), 'w').close()
        open(os.path.join(pkg, '__init__.py'), 'w').close()
        with open(os.path.join(pkg, 'worker.py'), 'w', encoding='utf-8') as handle:
            handle.write(FAKE_ALIGN_WORKER)
        return root

    def test_three_workers_over_seven_jobs_answer_in_JOB_order(self):
        """The REAL worker module, three of it. Every job fails (the backend
        does not exist) and a failure is still a result line, so this proves the
        counts and the ORDER without a model - result k answers job k however
        the seven were split across the three processes."""
        import sys
        seen = []
        results = E.run_jobs(sys.executable, self._jobs(), timeout=300,
                             on_result=lambda done, total: seen.append((done, total)),
                             workers=self.POOL)
        self.assertEqual([r['index'] for r in results], list(range(self.JOBS)))
        self.assertTrue(all(r['ok'] is False for r in results))
        self.assertIn('no-such-backend', results[0]['error'])
        # One callback per result, and the last one is the whole book. The
        # counts are the POOL's progress, so they are monotonic even though the
        # results arrive from three processes at once.
        self.assertEqual(len(seen), self.JOBS)
        self.assertEqual(seen[-1], (self.JOBS, self.JOBS))
        self.assertEqual([done for done, _total in seen],
                         list(range(1, self.JOBS + 1)))

    def test_the_jobs_are_dealt_ROUND_ROBIN_across_the_workers(self):
        """Job i goes to worker i % N, so a run of long chunks and a run of
        one-line headings land on different processes. Blocking (worker 1 gets
        the first third) would put the whole slow half of a book on one worker
        and finish no earlier than one process does."""
        import sys
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fake_root(os.path.join(tmp, 'tree'))
            out = os.path.join(tmp, 'out')
            os.makedirs(out)
            with mock.patch.object(E, 'package_root', lambda: root), \
                    mock.patch.dict(os.environ, {'FAKE_ALIGN_OUT': out}):
                results = E.run_jobs(sys.executable, self._jobs(), timeout=300,
                                     workers=self.POOL)
            self.assertEqual([r['index'] for r in results], list(range(self.JOBS)))
            dealt = sorted(
                json.load(open(os.path.join(out, name), encoding='utf-8'))
                for name in os.listdir(out))
            self.assertEqual(dealt, [[0, 3, 6], [1, 4], [2, 5]])

    def test_a_worker_that_dies_is_refused_BY_WHICH_WORKER(self):
        """Six jobs over three workers; the one dealt job 1 exits 3 before
        answering anything. The refusal has to say WHICH of the three, because
        "the align worker exited 3" leaves an operator no way to tell which
        third of the book is missing."""
        import sys
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fake_root(os.path.join(tmp, 'tree'))
            out = os.path.join(tmp, 'out')
            os.makedirs(out)
            with mock.patch.object(E, 'package_root', lambda: root), \
                    mock.patch.dict(os.environ, {'FAKE_ALIGN_OUT': out,
                                                 'FAKE_ALIGN_DIE_ON_INDEX': '1'}):
                with self.assertRaises(RuntimeError) as caught:
                    E.run_jobs(sys.executable, self._jobs(6), timeout=300,
                               workers=self.POOL)
        message = str(caught.exception)
        self.assertIn('align worker 2 of 3', message)
        self.assertIn('exited 3', message)
        # ...and the worker's own stderr rides along, so the reason is in the
        # same sentence as the name.
        self.assertIn('the fake worker died on job 1', message)

    def test_workers_below_one_is_refused_before_anything_is_spawned(self):
        import sys
        for bad in (0, -1):
            with self.assertRaises(ValueError) as caught:
                E.run_jobs(sys.executable, self._jobs(2), workers=bad)
            self.assertIn('1 or more', str(caught.exception))

    def test_the_default_is_one_worker_which_is_the_old_route(self):
        import inspect
        self.assertEqual(
            inspect.signature(E.run_jobs).parameters['workers'].default, 1)

    def test_a_pool_divides_the_torch_thread_budget_and_an_EXPLICIT_value_wins(self):
        """N processes that each open `cpu_count()` intra-op threads spend the
        pool's win on context switches. The single-worker route says nothing at
        all, and an operator who exported the variables has already decided."""
        divided = E.worker_environment({}, threads=5)
        for name in E.THREAD_ENV_VARS:
            self.assertEqual(divided[name], '5')
        untouched = E.worker_environment({})
        for name in E.THREAD_ENV_VARS:
            self.assertNotIn(name, untouched)
        explicit = E.worker_environment({'OMP_NUM_THREADS': '2'}, threads=5)
        self.assertEqual(explicit['OMP_NUM_THREADS'], '2')

    def test_a_pool_without_an_interpreter_to_spawn_is_REFUSED(self):
        """In process there is ONE interpreter and ONE loaded model, so there is
        nothing to spread the chunks over. Quietly aligning at 1 would make a
        caller who asked for four workers wait out the same 115 minutes and be
        told nothing."""
        with self.assertRaises(A.AlignerError) as caught:
            R._run([{'index': 0}], None, 'whisperx', lambda line: None, 4)
        self.assertIn('--workers 4', str(caught.exception))
        self.assertIn('--python', str(caught.exception))


class CliTest(unittest.TestCase):

    def test_align_is_a_subcommand_with_the_documented_flags(self):
        from narrator.cli import build_parser
        args = build_parser().parse_args(
            ['align', '--session-dir', 'D', '--out', 'o.vtt',
             '--report', 'c.json'])
        self.assertEqual(args.command, 'align')
        self.assertEqual(args.device, 'cpu')

    def test_the_backend_is_chosen_by_name_and_defaults_to_whisperx(self):
        """Two aligners ship, so there IS a flag - and it takes only the two
        that ship. torchaudio was measured and rejected in 2026-09-05 and is
        still not a choice."""
        from narrator.cli import build_parser
        default = build_parser().parse_args(['align', '--session-dir', 'D'])
        self.assertEqual(default.backend, 'whisperx')
        chosen = build_parser().parse_args(
            ['align', '--session-dir', 'D', '--backend', 'qwen3'])
        self.assertEqual(chosen.backend, 'qwen3')
        for bad in ('torchaudio', 'gentle', 'whisper'):
            with self.assertRaises(SystemExit):
                build_parser().parse_args(
                    ['align', '--session-dir', 'D', '--backend', bad])

    def test_continue_on_error_is_still_accepted_and_is_a_no_op(self):
        """The pass always audits the whole book now. The flag stays parseable
        so an old command line in a script still runs."""
        from narrator.cli import build_parser
        default = build_parser().parse_args(['align', '--session-dir', 'D'])
        self.assertFalse(default.continue_on_error)
        asked = build_parser().parse_args(
            ['align', '--session-dir', 'D', '--continue-on-error'])
        self.assertTrue(asked.continue_on_error)
        # ...and `align_session` has no such parameter to pass it to.
        import inspect
        self.assertNotIn('continue_on_error',
                         inspect.signature(R.align_session).parameters)

    def test_the_align_worker_pool_is_a_flag_and_zero_is_refused(self):
        """`--workers` defaults to the one process the app has always spawned;
        0 is refused at parse time rather than clamped, because it is a caller
        whose arithmetic came out empty and a silent 1 would hide that behind a
        two-hour run."""
        from narrator.cli import build_parser
        self.assertEqual(
            build_parser().parse_args(['align', '--session-dir', 'D']).workers, 1)
        self.assertEqual(
            build_parser().parse_args(
                ['align', '--session-dir', 'D', '--workers', '4']).workers, 4)
        for bad in ('0', '-2', 'four'):
            with self.assertRaises(SystemExit):
                build_parser().parse_args(
                    ['align', '--session-dir', 'D', '--workers', bad])

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

    # ---- a chunk the aligner cannot place -----------------------------------

    def test_a_failed_chunk_is_recorded_and_the_run_finishes(self):
        """Owen's ruling, 2026-09-05: the pass audits the WHOLE book. The
        failure is named in the report; it no longer stops anything."""
        texts = ['One two. Three four.', 'Five six. Seven eight.',
                 'Nine ten. Eleven twelve.']
        self.behaviour[texts[1]] = 'explode'
        result = R.align_session(self._manifest(texts),
                                 progress=lambda line: None)
        document = result['document']
        self.assertEqual(document['summary']['chunksAligned'], 2)
        self.assertEqual(document['summary']['errors'], 1)
        errors = document['errors']
        self.assertEqual([e['index'] for e in errors], [1])
        self.assertEqual(errors[0]['stage'], 'align')
        self.assertIn('the fake aligner refuses this chunk', errors[0]['error'])
        self.assertEqual(document['summary']['errorIndices'], [1])

    def test_an_unplaceable_chunk_still_gets_ESTIMATED_cues(self):
        """Point 2 of the ruling: expected text over the chunk's real audio,
        marked as an estimate. Every chunk of the book is cued."""
        texts = ['One two. Three four.', 'Five six. Seven eight.',
                 'Nine ten. Eleven twelve.']
        self.behaviour[texts[1]] = 'explode'
        result = R.align_session(self._manifest(texts),
                                 progress=lambda line: None)
        cues = result['cues']
        self.assertEqual(sorted({c.chunk_index for c in cues}), [0, 1, 2])
        estimated = [c for c in cues if c.estimated]
        self.assertEqual({c.chunk_index for c in estimated}, {1})
        # Two sentences, laid inside chunk 1's own second of audio.
        self.assertEqual(len(estimated), 2)
        self.assertAlmostEqual(estimated[0].start_s, 1.0, places=6)
        self.assertAlmostEqual(estimated[-1].end_s, 2.0, places=6)
        # ...and they are proportional to the sentences' character share.
        self.assertGreater(estimated[0].end_s, estimated[0].start_s)

    def test_the_run_writes_BOTH_outputs_even_with_failures(self):
        texts = ['One two.', 'Three four.']
        self.behaviour[texts[0]] = 'explode'
        vtt = os.path.join(self.tmp, 'out.sentences.vtt')
        report = os.path.join(self.tmp, 'coverage.json')
        result = R.align_session(self._manifest(texts),
                                 progress=lambda line: None)
        written = R.write_outputs(result, vtt_path=vtt, report_path=report,
                                  log=lambda line: None)
        self.assertEqual(written, {'vtt': vtt, 'report': report})
        with open(vtt, encoding='utf-8') as handle:
            document = handle.read()
        # The estimate SAYS it is one, and names its chunk.
        self.assertIn('NOTE estimated chunk 0', document)

    def test_in_process_every_chunk_is_attempted(self):
        """The other half of the old stop-on-failure rule: the in-process loop
        used to return at the first bad chunk, so chunks 2..N were never even
        looked at."""
        seen = []
        real = self._fake

        def counting(audio, text, language, device):
            seen.append(text)
            return real(audio, text, language, device)

        A._BACKEND_FUNCTIONS['whisperx'] = counting
        texts = [f'Word{i} word. Other{i} word.' for i in range(6)]
        self.behaviour[texts[1]] = 'explode'
        R.align_session(self._manifest(texts), progress=lambda line: None)
        self.assertEqual(len(seen), 6, seen)

    def test_a_report_with_a_hole_still_lets_the_book_assemble(self):
        """The whole point. A 3-chunk book with one unplaceable chunk was
        unassemblable; now the gate reports the hole and returns."""
        texts = ['One two.', 'Three four.', 'Five six.']
        self.behaviour[texts[1]] = 'explode'
        manifest = self._manifest(texts)
        result = R.align_session(manifest, progress=lambda line: None)
        path = os.path.join(self.tmp, 'coverage.json')
        R.write_outputs(result, vtt_path=None, report_path=path,
                        log=lambda line: None)
        lines = []
        document = coverage_gate.check(manifest, path, lines.append)
        self.assertIsNotNone(document)
        self.assertIn('narrator retake --indices 1', '\n'.join(lines))

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
        skip, aligned+skipped would equal chunks and the audit would report a
        book nobody measured as fully measured."""
        texts = ['One two.', 'Three four.', 'Five six.']
        self.behaviour[texts[1]] = 'explode'
        result = R.align_session(self._manifest(texts),
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
        result = R.align_session(manifest, progress=lambda line: None)
        errors = result['document']['errors']
        self.assertEqual([e['stage'] for e in errors], ['cues'])
        self.assertEqual(errors[0]['index'], 0)
        self.assertIn('come apart', errors[0]['error'])
        # It still counts as ALIGNED - the alignment happened; the cues did not.
        self.assertEqual(result['document']['summary']['chunksAligned'], 2)
        # ...and it is cued ANYWAY, as an estimate over its own audio.
        self.assertEqual(sorted({c.chunk_index for c in result['cues']}), [0, 1])
        self.assertEqual({c.chunk_index for c in result['cues'] if c.estimated},
                         {0})

    # ---- outputs -----------------------------------------------------------

    def test_write_outputs_refuses_an_empty_transcript(self):
        result = {'cues': [], 'document': {'summary': {}}}
        with self.assertRaises(A.AlignerError) as caught:
            R.write_outputs(result, vtt_path=os.path.join(self.tmp, 'x.vtt'),
                            report_path=None, log=lambda line: None)
        self.assertIn('empty transcript', str(caught.exception))

    def test_a_book_of_failures_exits_the_cli_with_zero(self):
        """Owen's ruling on the exit code: 0 when the RUN happened, whatever
        the chunks said. It was 1 whenever anything failed, which is what made
        BookForge's Align row fail and the assembly behind it never run."""
        import argparse

        texts = ['One two.', 'Three four.', 'Five six.']
        self.behaviour[texts[1]] = 'explode'
        from narrator.cli import _run_align
        args = argparse.Namespace(
            indices=None, out=os.path.join(self.tmp, 'out.sentences.vtt'),
            report=os.path.join(self.tmp, 'coverage.json'), language='en',
            backend='whisperx', device='cpu', python=None, ffmpeg=None,
            continue_on_error=False, workers=1, chapter_gap=0.0)
        self.assertEqual(_run_align(args, self._manifest(texts)), 0)
        self.assertTrue(os.path.isfile(args.out))
        self.assertTrue(os.path.isfile(args.report))

    def test_the_cli_backend_flag_REACHES_align_session(self):
        """The plumbing, end to end: `--backend qwen3` on the command line has
        to arrive as `backend='qwen3'` in `align_session`, and from there in
        every job. A flag the parser accepts and the body drops would run
        whisperx while the operator read qwen3 on their own command line."""
        import argparse
        from unittest import mock

        from narrator.cli import _run_align, build_parser

        parsed = build_parser().parse_args(
            ['align', '--session-dir', 'D', '--backend', 'qwen3'])
        self.assertEqual(parsed.backend, 'qwen3')

        seen = {}

        def capture(manifest, **kw):
            seen.update(kw)
            return {'cues': [S.SentenceCue(0, 0, 0.0, 1.0, 'One two.')],
                    'document': {
                        'summary': {'chunksAligned': 1, 'chunksFailed': 0,
                                    'errors': 0, 'failedIndices': [],
                                    'errorIndices': []}}}

        args = argparse.Namespace(
            indices=None, out=None, report=os.path.join(self.tmp, 'c.json'),
            language='en', backend='qwen3', device='cuda', python=None,
            ffmpeg=None, continue_on_error=False, workers=1, chapter_gap=0.0)
        with mock.patch('narrator.align.run.align_session', capture):
            self.assertEqual(_run_align(args, self._manifest(['One two.'])), 0)
        self.assertEqual(seen['backend'], 'qwen3')
        self.assertEqual(seen['device'], 'cuda')

    def test_a_qwen3_run_records_derived_scores_all_the_way_to_the_report(self):
        """The backend chosen by name reaches the jobs, the alignments and the
        coverage document - which is where a reader learns that a 0.93 aligned
        ratio is derived rather than whisperx's own."""
        import sys

        qwen = _FakeQwen3Module()
        qwen.items = [_FakeItem('One', 0.0, 0.25), _FakeItem('two.', 0.25, 0.5),
                      _FakeItem('Three', 0.5, 0.75), _FakeItem('four.', 0.75, 1.0)]
        saved = sys.modules.get('qwen_asr')
        sys.modules['qwen_asr'] = qwen
        self.addCleanup(lambda: sys.modules.__setitem__('qwen_asr', saved)
                        if saved is not None
                        else sys.modules.pop('qwen_asr', None))
        for key in [k for k in A._MODEL_CACHE if k[0] == 'qwen3']:
            del A._MODEL_CACHE[key]
        self.addCleanup(lambda: [A._MODEL_CACHE.pop(k) for k in
                                 [k for k in A._MODEL_CACHE if k[0] == 'qwen3']])
        # setUp already fakes `decode_audio` (one second) and `detect_silences`
        # (no pauses), which is what a derived score's SPEECH PRESENCE factor
        # reads - no silences means every word is fully in speech, so what these
        # scores test is the plumbing rather than the audio.
        result = R.align_session(self._manifest(['One two. Three four.']),
                                 backend='qwen3', progress=lambda line: None)
        document = result['document']
        self.assertEqual(document['backend'], 'qwen3')
        self.assertEqual(document['scoreSource'], 'derived')
        self.assertEqual(document['chunks'][0]['scoreSource'], 'derived')
        # ...and every cue's quality note says the same thing.
        self.assertTrue(all(c.quality['score_source'] == 'derived'
                            for c in result['cues']))

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
        self.assertTrue(higgs['document']['audited'])
        self.assertEqual(higgs['document']['summary']['chunksFailed'], 1)

        orpheus = R.align_session(self._manifest(texts, engine='orpheus'),
                                  progress=lambda line: None)
        self.assertFalse(orpheus['document']['audited'])
        # Same measurement, same failure count - the difference is whether a run
        # of that engine carries an Align row at all.
        self.assertEqual(orpheus['document']['summary']['chunksFailed'], 1)


class PerChunkGateTest(unittest.TestCase):
    """`run.gate_refusal` - the check that stops a placement nobody can believe
    from reaching the transcript (2026-09-08).

    WHY IT EXISTS, in one line: qwen3 never refuses. It returns word times for
    whatever window it is given, so a chunk whose printed text differs from the
    speech is PLACED rather than rejected, and the only tell is where it landed.

    THE FIVE MAC CASES, and what each one becomes at THIS door. The bake-off
    (M-series, mps bf16, Shift's first hour, 61 chunk starts) found +3.5 s,
    -7.8 s and three tiny chunks - 1857.5 / 1859.1 / 1861.1 s - all predicted at
    1855.43. This door aligns each chunk against its OWN audio file and lays the
    cues inside the chunk's own manifest span, so a chunk cannot be moved onto
    another chunk's audio here at all: the two shift cases become a SEAM that
    lands seconds from where the sentence's share of the audio puts it, and the
    collapse becomes an invariant that today's seam arithmetic already makes
    unreachable (tested directly, because `align_session` cannot produce it).
    The same aligner, the same failure, a different amount of damage - which is
    why the gate that matters for the whole-book door
    (`electron/scripts/align_audiobook.py`) is the same constant applied where a
    sentence really can move.
    """

    #: 12 s a chunk at the manifest's 24 kHz - long enough that a seam can miss
    #: its proportional position by more than `GATE_MAX_SHIFT_S` in either
    #: direction, which a 1 s chunk cannot.
    SAMPLES = 24000 * 12
    #: Two sentences, two words each, and the SAME character count (11 each), so
    #: the proportional seam is exactly half way: 6.000 s into the chunk.
    TEXT = 'Aaaa bbbbb. Ccccc dddd.'
    #: Two more of the same shape, for the neighbour test - DISTINCT strings,
    #: because the fake aligner is keyed on the SPOKEN text and two chunks that
    #: differ only in whitespace collapse to the same key.
    TEXT2 = 'Eeee fffff. Ggggg hhhh.'
    TEXT3 = 'Iiii jjjjj. Kkkkk llll.'

    def _manifest(self, texts, engine='higgs-v3'):
        from narrator.manifest import (Book, Chapter, Chunk, EdgeFadeMs, Engine,
                                       Manifest, Source, Voice)
        chunks = [
            Chunk(index=i, text=text, kind='prose',
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

        self.tmp = tempfile.mkdtemp(prefix='narrator-align-gate-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # 12 s of "audio" at the aligner's own 16 kHz, matching the manifest.
        self._audio = np.zeros(A.SAMPLE_RATE * 12, dtype='float32')
        self._patch(A, 'decode_audio', lambda path, ffmpeg=None: self._audio)
        self._patch(A, 'detect_silences',
                    lambda audio, noise_db=None, min_s=None: ())
        self._patch(E, 'backend_importable', lambda backend: True)
        A._BACKEND_LOADERS['whisperx'] = lambda language, device: (None, None)
        self.addCleanup(A._BACKEND_LOADERS.__setitem__, 'whisperx',
                        A._load_whisperx)
        #: text -> the four (start, end) pairs the fake aligner places.
        self.placement = {}
        A._BACKEND_FUNCTIONS['whisperx'] = self._fake
        self.addCleanup(A._BACKEND_FUNCTIONS.__setitem__, 'whisperx',
                        A._whisperx_words)

    def _patch(self, module, name, value):
        old = getattr(module, name)
        setattr(module, name, value)
        self.addCleanup(setattr, module, name, old)

    def _fake(self, audio, text, language, device):
        """The placement `self.placement` names, or an even spread."""
        words = [w for w in text.split(' ') if w]
        times = self.placement.get(text)
        if times is None:
            step = (audio.size / A.SAMPLE_RATE) / max(1, len(words))
            times = [(i * step, (i + 1) * step) for i in range(len(words))]
        return [(w, a, b, 0.9) for w, (a, b) in zip(words, times)]

    def _align(self, texts):
        return R.align_session(self._manifest(texts), progress=lambda line: None)

    def _gated(self, document):
        return [(e['index'], e['error']) for e in document['errors']
                if e['stage'] == 'gate']

    # ---- the clean chunk, which must NOT be gated ---------------------------

    def test_a_well_placed_chunk_is_not_gated(self):
        """The control. An even spread puts the seam at 6.0 s, which is exactly
        where the proportional estimate puts it, and every word runs forward."""
        result = self._align([self.TEXT])
        self.assertEqual(self._gated(result['document']), [])
        self.assertEqual([c.estimated for c in result['cues']], [False, False])

    # ---- shift, the check that actually fires -------------------------------

    def test_a_seam_placed_seconds_LATE_is_gated_and_estimated(self):
        """The Mac's +3.5 s case as this door can express it: the aligner puts
        the second sentence's words at the very end of the chunk, so its cue
        starts 3.5 s after its share of the audio says it should."""
        self.placement[self.TEXT] = [(0.0, 0.5), (0.5, 8.0),
                                     (11.0, 11.4), (11.4, 11.8)]
        result = self._align([self.TEXT])
        gated = self._gated(result['document'])
        self.assertEqual([index for index, _message in gated], [0])
        self.assertIn('gate/shift', gated[0][1])
        self.assertIn('sentence 1', gated[0][1])
        # ...and the chunk ships the ESTIMATE, marked as one.
        self.assertTrue(all(c.estimated for c in result['cues']))
        self.assertAlmostEqual(result['cues'][1].start_s, 6.0, places=3)

    def test_a_seam_placed_seconds_EARLY_is_gated(self):
        """The -7.8 s case: everything crammed into the first second."""
        self.placement[self.TEXT] = [(0.0, 0.05), (0.05, 0.10),
                                     (0.20, 0.30), (0.30, 0.40)]
        result = self._align([self.TEXT])
        gated = self._gated(result['document'])
        self.assertEqual([index for index, _message in gated], [0])
        self.assertIn('gate/shift', gated[0][1])

    def test_the_shift_limit_is_GATE_MAX_SHIFT_S_and_a_smaller_miss_passes(self):
        """A seam 1.5 s from proportional is inside the band the Mac's GOOD
        prose chunks sat in, and must survive; 2.0 s is where the two
        populations separate."""
        self.assertEqual(R.GATE_MAX_SHIFT_S, 2.0)
        # Words 1 and 2 straddle a raw seam at 7.5 s: 1.5 s from 6.0.
        self.placement[self.TEXT] = [(0.0, 0.5), (0.5, 7.0),
                                     (8.0, 8.5), (8.5, 9.0)]
        result = self._align([self.TEXT])
        self.assertEqual(self._gated(result['document']), [])
        self.assertAlmostEqual(result['cues'][1].start_s, 7.5, places=3)

    # ---- order --------------------------------------------------------------

    def test_words_placed_backwards_inside_a_sentence_are_gated(self):
        """`quality['monotonic']` is False - the alignment put this sentence's
        second word before its first. Checked BEFORE the shift, because a cue
        whose own words disagree about their order has no start worth
        comparing."""
        self.placement[self.TEXT] = [(0.0, 0.5), (0.5, 5.0),
                                     (7.0, 8.0), (6.5, 7.5)]
        result = self._align([self.TEXT])
        gated = self._gated(result['document'])
        self.assertEqual([index for index, _message in gated], [0])
        self.assertIn('gate/order', gated[0][1])

    # ---- collapse -----------------------------------------------------------

    def test_two_cues_at_one_position_are_refused(self):
        """The Mac's worst case - 1857.5 / 1859.1 / 1861.1 s all predicted at
        1855.43 - as an INVARIANT.

        `align_session` cannot produce it: `sentences.sentence_cues` clamps
        every seam to `MIN_CUE_S` past the previous one, so two cues of one
        chunk can never share a start. The check exists so a future change to
        that arithmetic cannot reintroduce it silently, which is why it is
        tested against `gate_refusal` directly rather than through a run that
        would have to be broken first.
        """
        from narrator.assemble.sentence_vtt import SentenceCue

        quality = {'monotonic': True, 'chars_per_sec': 10.0, 'pace_ratio': 1.0,
                   'boundary_silence_s': 0.0, 'worst_word_score': 0.9,
                   'score_source': 'derived'}
        collapsed = (
            SentenceCue(chunk_index=7, sentence_index=0, start_s=100.0,
                        end_s=100.0, text='Aaaa bbbbb.', quality=dict(quality)),
            SentenceCue(chunk_index=7, sentence_index=1, start_s=100.0,
                        end_s=112.0, text='Ccccc ddddd.', quality=dict(quality)),
        )
        refusal = R.gate_refusal(collapsed, chunk_index=7, chunk_start_s=100.0,
                                 chunk_end_s=112.0, text=self.TEXT,
                                 is_heading=False)
        self.assertIsNotNone(refusal)
        self.assertIn('gate/collapse', refusal)
        self.assertIn('100.000s', refusal)

    # ---- what the gate does NOT do ------------------------------------------

    def test_a_single_sentence_chunk_can_never_be_gated(self):
        """A HEADING IS ONE SENTENCE, AND THIS DOOR CANNOT MISPLACE IT.

        Its only cue starts at the chunk's own manifest start and ends at the
        chunk's own end, whatever the aligner said - so the 59 heading misses
        the Shift bake-off found cost this door nothing, and there is nothing
        for a gate to catch. Stated as a test because it is the finding, not an
        omission: the heading damage happens at the whole-book door, where a
        sentence's position comes from the alignment rather than from a
        manifest.
        """
        text = 'Two thousand one hundred and ten.'
        # The aligner puts every word in the last half-second of a 12 s chunk.
        self.placement[text] = [(11.5, 11.6), (11.6, 11.7), (11.7, 11.8),
                                (11.8, 11.85), (11.85, 11.9), (11.9, 11.95)]
        result = self._align([text])
        self.assertEqual(self._gated(result['document']), [])
        self.assertEqual(len(result['cues']), 1)
        self.assertAlmostEqual(result['cues'][0].start_s, 0.0, places=6)
        self.assertAlmostEqual(result['cues'][0].end_s, 12.0, places=6)

    def test_a_gated_chunk_does_not_touch_its_neighbours(self):
        """"So a heading never drags the following prose chunk with it": the
        gated chunk is estimated ALONE and the chunks around it keep their
        measured cues."""
        texts = [self.TEXT, self.TEXT2, self.TEXT3]
        self.placement[self.TEXT2] = [(0.0, 0.5), (0.5, 8.0),
                                      (11.0, 11.4), (11.4, 11.8)]
        result = self._align(texts)
        gated = self._gated(result['document'])
        self.assertEqual([index for index, _message in gated], [1])
        estimated = {c.chunk_index for c in result['cues'] if c.estimated}
        self.assertEqual(estimated, {1})
        # The aligner still MEASURED the gated chunk - the coverage document
        # counts it - and only its cues were replaced.
        self.assertEqual(result['document']['summary']['chunksAligned'], 3)


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
