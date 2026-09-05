"""The worker loop, driven end to end without a model.

The engine is a fake with the surface `TTSManager` delegated to, so the loop's
real behaviours - resume, empty sentences, the take fan-out, batching, the
in-flight drop on a cooperative stop, the progress lines - are exercised against
REAL FLACs on a REAL session directory. Nothing here mocks the filesystem: the
resume rule is a file-size check and a test that fakes the file learns nothing.

`FakeRenderEngine` lives here rather than beside `serve/fake_engine.py` because
that one implements the STREAMING surface (generate_batch_stream) and this one
implements the RENDER surface (convert / convert_batch / _write_silence); they
share no methods. `test_render_retake.py` imports this one.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

import numpy as np
import soundfile as sf

from narrator.render import session_store
from narrator.render.worker import (
    WorkerRequest,
    chapter_range_to_sentences,
    orphan_reason,
    resolve_owner,
    run_worker,
    start_parent_watch,
)
from narrator.tests import synthetic

SAMPLE_RATE = 24000


# =============================================================================
# The bridge's own regexes, copied verbatim with their file:line
# =============================================================================
#
# From C:\Users\tellt\Projects\bookforge\electron\parallel-tts-bridge.ts. These
# are the JS sources, translated to Python only by dropping the `/.../i`
# delimiters. If the worker's output stops matching them, the render bar in
# BookForge stops moving and the watchdog kills a healthy worker after 12
# minutes - so they are asserted, not eyeballed.

#: :4175 - the OLD e2a progress shape, tried first. narrator never emits it.
BRIDGE_PROGRESS_RE_OLD = re.compile(
    r'Converting sentence (\d+) - ([\d.]+)%: (\d+)\/(\d+)', re.I)

#: :4176 - the shape `worker_core.run_worker_tts` emits and narrator emits.
BRIDGE_PROGRESS_RE = re.compile(
    r'Converting sentence (\d+)\/(\d+)\s*\(([\d.]+)%\)', re.I)

#: :2513 - watchdog "the GPU is doing something" activity.
BRIDGE_GENERATION_ACTIVITY_RE = re.compile(
    r'audio-token cap|re-rendering split|Processed prompts|Adding requests|'
    r'MLX batch generating', re.I)

#: :2526 / :2527 - the model-load stage boundary.
BRIDGE_MODEL_LOAD_START_RE = re.compile(
    r'Loading .*TTS with voice|Loading Orpheus model with|Loading .* model\b', re.I)
BRIDGE_MODEL_LOAD_DONE_RE = re.compile(r'TTS Loaded!|model loaded!', re.I)

#: :2534 - the repair-stage note.
BRIDGE_REPAIR_START_RE = re.compile(
    r'sentence (\d+) (?:hit the MLX audio-token cap|produced no audio|'
    r'audio too short for text)', re.I)

#: :110-120 - the guard-event prefix, sliced off before JSON.parse.
BRIDGE_GUARD_EVENT_PREFIX = '[ORPHEUS][ORPHEUS_GUARD_EVENT]'


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        h.update(f.read())
    return h.hexdigest()


# =============================================================================
# The fake engine
# =============================================================================

class FakeEngineConfig:
    """`EngineConfig`'s render-side fields. `sentences_dir` is MUTABLE because
    the worker repoints it per take, exactly as e2a repointed
    `session['sentences_dir']`."""

    def __init__(self, sentences_dir=None, process_dir=None, voice='deathstalker',
                 audio_format='flac', **rest):
        self.sentences_dir = sentences_dir
        self.process_dir = process_dir
        self.voice = voice
        self.audio_format = audio_format
        self.model_dir = rest.get('model_dir')
        self.adapter_dir = rest.get('adapter_dir')
        self.base_dir = rest.get('base_dir')


class FakeRenderEngine:
    """Writes a real FLAC per chunk. No model, no torch.

    Length is a function of the text so a test can predict a file's size, and
    every produced file is well over the 1024-byte resume floor while
    `_write_silence` is well under it - which is the pair of facts the resume and
    empty-sentence tests turn on.
    """

    SUPPORTS_BATCH = False
    BATCH_SIZE = 1
    SAMPLE_RATE = SAMPLE_RATE

    def __init__(self, config, *, fail_indices=(), stop_at=None):
        self.config = config
        self.voice = config.voice
        self.params = {'samplerate': SAMPLE_RATE}
        self.calls = []          # (index, text) in the order convert saw them
        self.batches = []        # the size of each convert_batch flush
        self.caps = []           # (voice, caps) each register_voice_caps call
        self.fail_indices = set(fail_indices)
        self.stop_at = stop_at   # raise SystemExit when this index is reached

    # -- the TTSManager surface ------------------------------------------------

    @property
    def batch_pool_size(self) -> int:
        return self.BATCH_SIZE

    def register_voice_caps(self, voice, caps):
        self.caps.append((voice, dict(caps)))
        return dict(caps)

    def convert(self, index: int, sentence: str) -> bool:
        if self.stop_at is not None and index == self.stop_at:
            self._write(index, 0.05)       # a half-written row, left behind
            raise SystemExit(143)
        self.calls.append((index, sentence))
        if index in self.fail_indices:
            return False
        self._write(index, 0.4 + 0.01 * len(sentence))
        return True

    def convert_batch(self, items: list) -> list:
        self.batches.append(len(items))
        out = []
        for index, sentence in items:
            out.append(self.convert(index, sentence))
        return out

    def _write_silence(self, index: int) -> bool:
        """0.1 s of digital silence, as `orpheus.py:_write_silence` writes it -
        about 100 bytes of FLAC, i.e. BELOW the 1024-byte resume floor."""
        path = self._path(index)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        sf.write(path, np.zeros(int(SAMPLE_RATE * 0.1), dtype=np.float32),
                 SAMPLE_RATE, subtype='PCM_16', format='FLAC')
        return True

    # -- internals -------------------------------------------------------------

    def _path(self, index: int) -> str:
        return os.path.join(self.config.sentences_dir,
                            f'{index}.{self.config.audio_format}')

    def _write(self, index: int, seconds: float) -> None:
        path = self._path(index)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        n = int(SAMPLE_RATE * seconds)
        t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
        sf.write(path, (0.3 * np.sin(2 * np.pi * 210.0 * t)).astype(np.float32),
                 SAMPLE_RATE, subtype='PCM_16', format='FLAC')


class BatchedFakeEngine(FakeRenderEngine):
    SUPPORTS_BATCH = True
    BATCH_SIZE = 4


class DeepPoolFakeEngine(BatchedFakeEngine):
    """An engine asking for a POOL deeper than its batch, like Orpheus/MLX with
    continuous batching on."""

    @property
    def batch_pool_size(self) -> int:
        return 4 * self.BATCH_SIZE


# =============================================================================
# Harness
# =============================================================================

class WorkerTestBase(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-worker-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.session_dir = os.path.join(self.root, 'ebook-ccd14111')
        os.makedirs(self.session_dir)
        self.process_dir = synthetic.build_session(self.session_dir)
        self.sentences_dir = os.path.join(self.process_dir, 'chapters', 'sentences')
        self.state = session_store.load_state_from_process_dir(self.process_dir)

    def request(self, **kw):
        base = dict(
            session_id='ccd14111-da29-4fb0-a489-a19a0f126bac',
            session_dir=self.session_dir,
            sentences_dir=self.sentences_dir,
            tts_engine='orpheus',
            fine_tuned='deathstalker',
            device='cpu',
        )
        base.update(kw)
        return WorkerRequest(**base)

    def run_it(self, request, engine_cls=FakeRenderEngine, **engine_kw):
        """Run the worker with a fake engine, capturing stdout.

        `resolve_device` imports torch, which the Windows test interpreter does
        not have, so the request always names a device the resolver passes
        through untouched ('cpu'): e2a only probes torch for 'cuda'/'mps'.
        """
        made = {}

        def factory(config):
            engine = engine_cls(FakeEngineConfig(
                sentences_dir=config.sentences_dir,
                process_dir=config.process_dir,
                voice=config.voice,
                audio_format=config.audio_format,
            ), **engine_kw)
            made['engine'] = engine
            return engine

        buf = io.StringIO()
        with redirect_stdout(buf):
            result = run_worker(request, engine_factory=factory)
        return result, buf.getvalue(), made.get('engine')


# =============================================================================
# Progress lines
# =============================================================================

class ProgressLineTest(WorkerTestBase):

    def setUp(self):
        super().setUp()
        # A skipped sentence prints NO progress line (e2a `continue`s before the
        # print), so an unrendered session is what these tests need.
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))

    def test_the_progress_line_matches_the_bridges_regex(self):
        result, out, _ = self.run_it(self.request(sentence_start=0, sentence_end=2))
        self.assertTrue(result['success'], result)

        lines = [l for l in out.splitlines() if l.startswith('Converting sentence')]
        self.assertEqual(len(lines), 3, out)
        for line in lines:
            match = BRIDGE_PROGRESS_RE.search(line)
            self.assertIsNotNone(
                match, f'parallel-tts-bridge.ts:4176 would not match: {line!r}')
            index, total, percent = match.groups()
            self.assertEqual(int(total), self.state['total_sentences'])
            self.assertLessEqual(float(percent), 100.0)
            # The old shape must NOT match, or the bridge would read the fields
            # off the wrong pattern (it tries :4175 first).
            self.assertIsNone(BRIDGE_PROGRESS_RE_OLD.search(line), line)

    def test_the_first_line_reports_zero_percent_and_the_last_under_a_hundred(self):
        _, out, _ = self.run_it(self.request(sentence_start=0, sentence_end=9))
        percents = [float(BRIDGE_PROGRESS_RE.search(l).group(3))
                    for l in out.splitlines() if l.startswith('Converting sentence')]
        # e2a prints the percentage BEFORE incrementing on the serial path, so the
        # first is 0.0 and the last is (n-1)/n - never 100. Preserved.
        self.assertEqual(percents[0], 0.0)
        self.assertEqual(percents[-1], round(9 / 10 * 100, 1))

    def test_the_worker_emits_nothing_that_falsely_trips_the_watchdog_regexes(self):
        """The activity and repair regexes must fire on ENGINE output, never on
        the worker's own bookkeeping - a false REPAIR_START match would show the
        user a repair that never happened."""
        _, out, _ = self.run_it(self.request(sentence_start=0, sentence_end=2))
        for line in out.splitlines():
            self.assertIsNone(BRIDGE_REPAIR_START_RE.search(line), line)
            self.assertIsNone(BRIDGE_GENERATION_ACTIVITY_RE.search(line), line)
            self.assertIsNone(BRIDGE_MODEL_LOAD_DONE_RE.search(line), line)
            self.assertNotIn(BRIDGE_GUARD_EVENT_PREFIX, line)

    def test_every_line_is_ascii(self):
        """CONTRACTS.md: non-ASCII renders as `?` on the Windows console. e2a's
        stop message carried an em dash; narrator's does not."""
        _, out, _ = self.run_it(self.request(sentence_start=0, sentence_end=2))
        out.encode('ascii')


# =============================================================================
# Resume
# =============================================================================

class DeviceTest(WorkerTestBase):

    def test_the_device_is_lowercased_before_it_is_compared(self):
        """`worker.py:487` lowercases the flag, and the bridge always sends the
        UPPERCASE form (`resolveTtsDeviceArg` -> 'CUDA', because `app.py` wants
        uppercase). Without the `.lower()` neither branch of the availability
        check is ever entered and the "falling back to CPU" diagnostic can never
        print - on exactly the machine that needs to see it.

        Driven with a stub torch so the assertion is about the comparison, not
        about this machine's CUDA."""
        import sys
        import types

        from narrator.render import worker as worker_mod

        stub = types.ModuleType('torch')
        stub.cuda = types.SimpleNamespace(is_available=lambda: False)
        stub.backends = types.SimpleNamespace(
            mps=types.SimpleNamespace(is_available=lambda: False))
        real = sys.modules.get('torch')
        sys.modules['torch'] = stub
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                resolved = worker_mod.resolve_device(
                    self.request(device='CUDA'), self.state)
            self.assertEqual(resolved, 'cpu')
            self.assertIn('[WORKER] CUDA not available, falling back to CPU',
                          buf.getvalue())

            buf = io.StringIO()
            with redirect_stdout(buf):
                resolved = worker_mod.resolve_device(
                    self.request(device='MPS'), self.state)
            self.assertEqual(resolved, 'cpu')
            self.assertIn('[WORKER] MPS not available, falling back to CPU',
                          buf.getvalue())
        finally:
            if real is None:
                sys.modules.pop('torch', None)
            else:
                sys.modules['torch'] = real


class ResumeTest(WorkerTestBase):

    def test_an_untouched_session_is_entirely_skipped(self):
        before = {i: sha256(os.path.join(self.sentences_dir, f'{i}.flac'))
                  for i in range(10)}
        result, out, engine = self.run_it(
            self.request(sentence_start=0, sentence_end=9))

        self.assertTrue(result['success'])
        self.assertEqual(result['sentences_skipped'], 10)
        self.assertEqual(result['sentences_converted'], 0)
        self.assertEqual(engine.calls, [])
        for i, digest in before.items():
            self.assertEqual(sha256(os.path.join(self.sentences_dir, f'{i}.flac')),
                             digest, f'{i}.flac was rewritten')

    def test_only_the_missing_files_are_rendered_and_the_rest_stay_byte_identical(self):
        for i in (3, 4, 5):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        untouched = {i: sha256(os.path.join(self.sentences_dir, f'{i}.flac'))
                     for i in range(10) if i not in (3, 4, 5)}

        result, out, engine = self.run_it(
            self.request(sentence_start=0, sentence_end=9))

        self.assertTrue(result['success'], result)
        self.assertEqual(result['sentences_converted'], 3)
        self.assertEqual(result['sentences_skipped'], 7)
        self.assertEqual([i for i, _ in engine.calls], [3, 4, 5])
        for i, digest in untouched.items():
            self.assertEqual(sha256(os.path.join(self.sentences_dir, f'{i}.flac')),
                             digest, f'{i}.flac was rewritten')
        for i in (3, 4, 5):
            self.assertTrue(os.path.exists(os.path.join(self.sentences_dir,
                                                        f'{i}.flac')))

    def test_a_file_at_or_below_the_floor_is_re_rendered(self):
        """The loop's skip is STRICTLY `> 1024`, so a 1024-byte file re-renders
        even though `scan_completed_sentences` calls it complete. Preserved from
        e2a - see PORT_NOTES.md."""
        path = os.path.join(self.sentences_dir, '7.flac')
        with open(path, 'wb') as f:
            f.write(b'\x00' * 1024)
        self.assertEqual(os.path.getsize(path), 1024)

        scan = session_store.scan_completed_sentences(self.sentences_dir, 10)
        self.assertIn(7, scan['completed'])          # the scanner says done

        _, _, engine = self.run_it(self.request(sentence_start=0, sentence_end=9))
        self.assertEqual([i for i, _ in engine.calls], [7])   # the worker says no

    def test_the_silence_written_for_an_empty_row_is_rescanned_forever(self):
        """A 0.1 s silence FLAC is ~100 bytes, below the floor, so the empty row
        is listed missing by every later scan and rewritten on every pass. e2a's
        behaviour, documented in worker_core's own comment."""
        chapters = [['Real text here.', '   ', 'More real text.']]
        root = tempfile.mkdtemp(prefix='narrator-R-empty-')
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        session_dir = os.path.join(root, 'ebook-x')
        os.makedirs(session_dir)
        process_dir = synthetic.build_session(
            session_dir, chapter_sentences=chapters, chunk_seconds=[1.0, 1.0, 1.0],
            chapter_docs=['text/c1.xhtml'], titles_by_doc={'text/c1.xhtml': 'One'})
        sentences_dir = os.path.join(process_dir, 'chapters', 'sentences')
        for i in range(3):
            os.remove(os.path.join(sentences_dir, f'{i}.flac'))

        request = WorkerRequest(
            session_id='x', session_dir=session_dir, sentences_dir=sentences_dir,
            tts_engine='orpheus', device='cpu', sentence_start=0, sentence_end=2)
        result, _, engine = self.run_it(request)

        self.assertTrue(result['success'])
        silence = os.path.join(sentences_dir, '1.flac')
        self.assertTrue(os.path.exists(silence))
        self.assertLess(os.path.getsize(silence), 1024)
        self.assertEqual([i for i, _ in engine.calls], [0, 2])
        self.assertEqual(result['sentences_skipped'], 1)
        scan = session_store.scan_completed_sentences(sentences_dir, 3)
        self.assertEqual(scan['missing'], [1])


# =============================================================================
# Batching
# =============================================================================

class BatchTest(WorkerTestBase):

    def test_a_batched_engine_flushes_at_its_batch_size(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        result, out, engine = self.run_it(
            self.request(sentence_start=0, sentence_end=9),
            engine_cls=BatchedFakeEngine)

        self.assertTrue(result['success'], result)
        self.assertEqual(engine.batches, [4, 4, 2])
        self.assertIn('[WORKER] Batched inference enabled (batch size 4)', out)
        # ONE progress line per sentence, still, so the bridge's counter is right.
        lines = [l for l in out.splitlines() if l.startswith('Converting sentence')]
        self.assertEqual(len(lines), 10)

    def test_a_deeper_pool_is_announced_and_used(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        result, out, engine = self.run_it(
            self.request(sentence_start=0, sentence_end=9),
            engine_cls=DeepPoolFakeEngine)

        self.assertTrue(result['success'], result)
        self.assertEqual(engine.batches, [10])
        self.assertIn('[WORKER] Batched inference enabled (batch size 4, '
                      'pooling 16 sentences per call)', out)

    def test_a_failed_row_is_reported_and_the_run_is_not_a_success(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        result, out, _ = self.run_it(
            self.request(sentence_start=0, sentence_end=9),
            engine_cls=BatchedFakeEngine, fail_indices=(2, 6))

        self.assertFalse(result['success'])
        self.assertEqual(result['failed_indices'], [2, 6])
        self.assertEqual(result['sentences_failed'], 2)
        self.assertIn('2 sentence(s) failed to convert: [2, 6]', result['error'])
        self.assertIn('[WORKER] Warning: Failed to convert sentence 2', out)
        # The rest of the batch still ran - e2a keeps going and reports at the end.
        self.assertIn('[WORKER] Warning: Failed to convert sentence 6', out)


# =============================================================================
# Ranges and refusals
# =============================================================================

class RangeTest(WorkerTestBase):

    def test_chapter_mode_maps_to_the_right_sentence_range(self):
        start, end = chapter_range_to_sentences(self.state, 2, 2)
        self.assertEqual((start, end), (3, 6))

        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        result, out, engine = self.run_it(
            self.request(chapter_start=2, chapter_end=2))

        self.assertTrue(result['success'], result)
        self.assertEqual([i for i, _ in engine.calls], [3, 4, 5, 6])
        self.assertIn('[WORKER] Chapter mode: chapters 2-2 = sentences 3-6', out)
        self.assertEqual(result['sentence_start'], 3)
        self.assertEqual(result['sentence_end'], 6)

    def test_a_range_past_the_end_is_refused(self):
        result, _, _ = self.run_it(self.request(sentence_start=0, sentence_end=99))
        self.assertFalse(result['success'])
        self.assertIn('Invalid sentence range: 0-99 (total: 10)', result['error'])

    def test_a_missing_session_directory_is_refused_by_path(self):
        result, _, _ = self.run_it(
            self.request(session_dir=os.path.join(self.root, 'nope'),
                         sentence_start=0, sentence_end=0))
        self.assertFalse(result['success'])
        self.assertIn('Session directory not found', result['error'])

    def test_a_deleted_e2a_engine_is_refused_by_name(self):
        """UPDATED when the worker became engine-agnostic: it renders every id in
        `narrator.engine.registry`, not Orpheus alone, so the old assertion
        ("narrator renders 'orpheus' only") is no longer a true statement. What
        must NOT change is that a deleted e2a engine is refused BY NAME and told
        where to go - "unknown engine" would read like a typo."""
        state_path = os.path.join(self.process_dir, 'session-state.json')
        with open(state_path, encoding='utf-8') as f:
            state = json.load(f)
        state['tts_engine'] = 'xtts'
        session_store.save_session_state(self.process_dir, state)

        result, _, _ = self.run_it(
            WorkerRequest(session_id='x', session_dir=self.session_dir,
                          sentences_dir=self.sentences_dir, device='cpu',
                          sentence_start=0, sentence_end=0))
        self.assertFalse(result['success'])
        self.assertIn("'xtts'", result['error'])
        self.assertIn('not ported', result['error'])
        self.assertIn('ebook2audiobook', result['error'])
        # ...and it still names what narrator CAN render, from the registry.
        self.assertIn("'orpheus'", result['error'])

    def test_a_session_with_no_engine_is_refused(self):
        state_path = os.path.join(self.process_dir, 'session-state.json')
        with open(state_path, encoding='utf-8') as f:
            state = json.load(f)
        del state['tts_engine']
        session_store.save_session_state(self.process_dir, state)

        result, _, _ = self.run_it(
            WorkerRequest(session_id='x', session_dir=self.session_dir,
                          sentences_dir=self.sentences_dir, device='cpu',
                          sentence_start=0, sentence_end=0))
        self.assertFalse(result['success'])
        self.assertIn('must name its engine', result['error'])


# =============================================================================
# The cooperative stop
# =============================================================================

class EngineSelectionTest(WorkerTestBase):
    """The worker picks its engine through `narrator.engine.registry`.

    A RECORDING factory stands in for each id, so these assert the SELECTION -
    which class is asked for, and which config it is handed - without importing
    a backend or loading a model.
    """

    def setUp(self):
        super().setUp()
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))

    def set_state_engine(self, engine_id, **extra):
        path = os.path.join(self.process_dir, 'session-state.json')
        with open(path, encoding='utf-8') as f:
            state = json.load(f)
        state['tts_engine'] = engine_id
        state.update(extra)
        session_store.save_session_state(self.process_dir, state)

    # -- the registry decides ------------------------------------------------

    def test_the_registry_knows_both_ids_this_worker_can_configure(self):
        """`CONFIG_BUILDERS` must not drift from the registry: an id narrator can
        build a config for that the registry cannot instantiate (or the reverse)
        is a gap that only shows up at render time."""
        from narrator.engine import registry
        from narrator.render.worker import CONFIG_BUILDERS

        self.assertIn('orpheus', registry.ids())
        self.assertIn('higgs-v3', registry.ids())
        for engine_id in CONFIG_BUILDERS:
            self.assertIn(engine_id, registry.ids(),
                          f'{engine_id} has a config builder but no registry entry')

    def test_build_engine_for_asks_the_registry_for_that_id(self):
        """The factory is one argument (so every existing fake still fits) and the
        id is closed over."""
        from narrator.engine import registry
        from narrator.render import worker as worker_mod

        asked = []

        def fake_engine_class(engine_id):
            asked.append(engine_id)
            return lambda config: ('engine-for', engine_id, config)

        real = registry.engine_class
        registry.engine_class = fake_engine_class
        try:
            factory = worker_mod.build_engine_for('higgs-v3')
            self.assertEqual(factory.engine_id, 'higgs-v3')
            built = factory('CONFIG')
        finally:
            registry.engine_class = real

        self.assertEqual(asked, ['higgs-v3'])
        self.assertEqual(built, ('engine-for', 'higgs-v3', 'CONFIG'))

    def test_an_orpheus_session_reaches_the_orpheus_class_with_an_EngineConfig(self):
        from narrator.engine import registry
        from narrator.render import worker as worker_mod

        seen = {}

        def fake_engine_class(engine_id):
            seen['id'] = engine_id

            def make(config):
                seen['config'] = config
                return FakeRenderEngine(FakeEngineConfig(
                    sentences_dir=config.sentences_dir, voice=config.voice))
            return make

        real = registry.engine_class
        registry.engine_class = fake_engine_class
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                result = worker_mod.run_worker(
                    self.request(sentence_start=0, sentence_end=1,
                                 fine_tuned='deathstalker'))
        finally:
            registry.engine_class = real

        self.assertTrue(result['success'], result)
        self.assertEqual(seen['id'], 'orpheus')
        # Byte-identical Orpheus config: an EngineConfig with the voice TOKEN.
        from narrator.engine import EngineConfig
        self.assertIsInstance(seen['config'], EngineConfig)
        self.assertEqual(seen['config'].voice, 'deathstalker')
        self.assertEqual(seen['config'].sentences_dir, self.sentences_dir)
        self.assertEqual(seen['config'].audio_format, 'flac')
        self.assertIn('[WORKER] TTS engine: orpheus, fine_tuned: deathstalker',
                      buf.getvalue())

    def test_a_higgs_session_reaches_the_higgs_class_with_a_higgs_config(self):
        """The config comes from the REGISTRY's own factory (which resolves the
        voice id against the catalog), then gets the three session fields."""
        from narrator.engine import registry
        from narrator.render import worker as worker_mod

        class FakeHiggsConfig:
            def __init__(self, voice, adapter_dir=None):
                self.voice = voice
                self.adapter_dir = adapter_dir
                self.sentences_dir = None
                self.process_dir = None
                self.audio_format = None

        seen = {}

        def fake_engine_config(engine_id, **kwargs):
            seen['config_id'] = engine_id
            seen['config_kwargs'] = kwargs
            return FakeHiggsConfig(**kwargs)

        def fake_engine_class(engine_id):
            seen['class_id'] = engine_id

            def make(config):
                seen['config'] = config
                return FakeRenderEngine(FakeEngineConfig(
                    sentences_dir=config.sentences_dir, voice='fake'))
            return make

        self.set_state_engine('higgs-v3', higgs_voice='deathstalker-samebook')
        real_class, real_config = registry.engine_class, registry.engine_config
        registry.engine_class, registry.engine_config = fake_engine_class, fake_engine_config
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                result = worker_mod.run_worker(
                    self.request(sentence_start=0, sentence_end=1,
                                 tts_engine=None, fine_tuned=None))
        finally:
            registry.engine_class, registry.engine_config = real_class, real_config

        self.assertTrue(result['success'], result)
        self.assertEqual(seen['class_id'], 'higgs-v3')
        self.assertEqual(seen['config_id'], 'higgs-v3')
        # Only what v3 understands: the catalog voice id, and an adapter dir.
        # NOT model_dir / base_dir / caps, which its factory refuses by name.
        self.assertEqual(seen['config_kwargs'],
                         {'voice': 'deathstalker-samebook', 'adapter_dir': None})
        self.assertEqual(seen['config'].sentences_dir, self.sentences_dir)
        self.assertEqual(seen['config'].audio_format, 'flac')

    def test_the_flag_beats_the_state_for_the_engine_too(self):
        from narrator.engine import registry
        from narrator.render import worker as worker_mod

        seen = {}

        def fake_engine_class(engine_id):
            seen['id'] = engine_id
            return lambda config: FakeRenderEngine(FakeEngineConfig(
                sentences_dir=config.sentences_dir, voice=config.voice))

        real = registry.engine_class
        registry.engine_class = fake_engine_class
        try:
            with redirect_stdout(io.StringIO()):
                worker_mod.run_worker(self.request(sentence_start=0, sentence_end=0,
                                                   tts_engine='orpheus'))
        finally:
            registry.engine_class = real
        self.assertEqual(seen['id'], 'orpheus')

    # -- refusals ------------------------------------------------------------

    def test_an_unknown_engine_id_is_refused_naming_the_registrys_ids(self):
        from narrator.engine import registry

        self.set_state_engine('llasa-8b')
        result, _, engine = self.run_it(
            WorkerRequest(session_id='x', session_dir=self.session_dir,
                          sentences_dir=self.sentences_dir, device='cpu',
                          sentence_start=0, sentence_end=0))
        self.assertFalse(result['success'])
        self.assertIn("Unknown narrator engine 'llasa-8b'", result['error'])
        for known in registry.ids():
            self.assertIn(known, result['error'],
                          f'the refusal does not name the registry id {known}')
        self.assertIsNone(engine)      # nothing was constructed

    def test_a_registry_id_this_worker_cannot_configure_is_refused_before_any_side_effect(self):
        """`higgs-v2-scaffold` IS in the registry - as scaffolding the registry
        itself says must never be selected by accident. It has no config builder
        here, and the refusal must land BEFORE the sentences dir is created."""
        from narrator.engine import registry

        self.assertIn('higgs-v2-scaffold', registry.ids())
        scratch = os.path.join(self.root, 'not-created-yet')
        self.set_state_engine('higgs-v2-scaffold')

        result, _, engine = self.run_it(
            WorkerRequest(session_id='x', session_dir=self.session_dir,
                          sentences_dir=scratch, device='cpu',
                          sentence_start=0, sentence_end=0))
        self.assertFalse(result['success'])
        self.assertIn("cannot configure engine 'higgs-v2-scaffold'", result['error'])
        self.assertIn('orpheus', result['error'])
        self.assertIsNone(engine)
        self.assertFalse(os.path.exists(scratch),
                         'the refusal created a directory before refusing')

    def test_a_higgs_session_with_no_voice_id_is_refused_and_never_falls_back(self):
        """`fine_tuned` is an Orpheus prompt token; using it as a Higgs catalog id
        would resolve to nothing, or to a different voice, for a whole book."""
        self.set_state_engine('higgs-v3')
        result, _, engine = self.run_it(
            self.request(sentence_start=0, sentence_end=0,
                         tts_engine=None, fine_tuned='deathstalker'))
        self.assertFalse(result['success'])
        self.assertIn('needs a voice id', result['error'])
        self.assertIn('--higgs_voice', result['error'])
        self.assertIn('NOT a substitute', result['error'])
        self.assertIsNone(engine)

    def test_the_voice_label_prints_a_name_not_a_ClipsVoice_repr(self):
        """A ClipsVoice's repr is its clips AND their transcripts - pages of text
        in a log line. The NAME is what the worker prints."""
        from narrator.render.worker import voice_label

        class V:
            name = 'deathstalker-samebook'

        class C:
            voice = V()

        class Orpheusish:
            voice = 'deathstalker'

        self.assertEqual(voice_label(C()), 'deathstalker-samebook')
        self.assertEqual(voice_label(Orpheusish()), 'deathstalker')


class CooperativeStopTest(WorkerTestBase):

    def test_a_stop_drops_the_in_flight_output_and_re_raises(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))

        buf = io.StringIO()

        def factory(config):
            return FakeRenderEngine(FakeEngineConfig(
                sentences_dir=config.sentences_dir, voice=config.voice),
                stop_at=4)

        with self.assertRaises(SystemExit) as caught:
            with redirect_stdout(buf):
                run_worker(self.request(sentence_start=0, sentence_end=9),
                           engine_factory=factory)

        self.assertEqual(caught.exception.code, 143)
        out = buf.getvalue()
        self.assertIn('[WORKER] Stop requested - dropped 1 in-flight output(s); '
                      'exiting cleanly', out)
        # 0..3 survive; the half-written 4 is gone so resume re-renders it.
        for i in range(4):
            self.assertTrue(os.path.exists(os.path.join(self.sentences_dir,
                                                        f'{i}.flac')), i)
        self.assertFalse(os.path.exists(os.path.join(self.sentences_dir, '4.flac')))

    def test_a_stop_in_a_batch_drops_the_whole_flush(self):
        """With a pool the flush is larger, so a stop discards a bit more finished
        work. Correctness is unaffected - they are re-rendered - and the engine
        gives no per-row completion signal to narrow it. e2a's comment, e2a's
        behaviour."""
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))

        def factory(config):
            return BatchedFakeEngine(FakeEngineConfig(
                sentences_dir=config.sentences_dir, voice=config.voice),
                stop_at=6)

        buf = io.StringIO()
        with self.assertRaises(SystemExit):
            with redirect_stdout(buf):
                run_worker(self.request(sentence_start=0, sentence_end=9),
                           engine_factory=factory)

        self.assertIn('dropped 4 in-flight output(s)', buf.getvalue())
        # The flush holding 4..7 is discarded whole, including 4 and 5 which had
        # already been written.
        for i in range(4):
            self.assertTrue(os.path.exists(os.path.join(self.sentences_dir,
                                                        f'{i}.flac')), i)
        for i in (4, 5, 6, 7):
            self.assertFalse(os.path.exists(os.path.join(self.sentences_dir,
                                                         f'{i}.flac')), i)


# =============================================================================
# The parent watchdog
# =============================================================================

class ParentWatchTest(unittest.TestCase):
    """Ported alongside `ebook2audiobook/tools/test_worker_parent_watch.py`'s
    subject. Nothing here starts a thread that outlives the test: every case
    inspects the DECISION, not the loop."""

    def setUp(self):
        self._saved = {k: os.environ.get(k)
                       for k in ('BOOKFORGE_OWNER_PID', 'BOOKFORGE_OWNER_PLATFORM',
                                 'ORPHEUS_WORKER_ORPHAN_GRACE_SECONDS')}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_no_owner_pid_says_so_and_returns_none(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertIsNone(resolve_owner())
        self.assertIn('no BOOKFORGE_OWNER_PID in the environment', buf.getvalue())

    def test_a_non_numeric_owner_pid_is_ignored_by_name(self):
        os.environ['BOOKFORGE_OWNER_PID'] = 'not-a-pid'
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertIsNone(resolve_owner())
        self.assertIn("is not a pid", buf.getvalue())

    def test_our_own_pid_is_not_a_usable_owner(self):
        os.environ['BOOKFORGE_OWNER_PID'] = str(os.getpid())
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertIsNone(resolve_owner())
        self.assertIn('is not a usable owner', buf.getvalue())

    def test_an_owner_on_another_platform_is_not_armed(self):
        """A Windows pid means nothing in a WSL guest's pid namespace, and might
        mean an unrelated guest process - which would be worse than no rule."""
        os.environ['BOOKFORGE_OWNER_PID'] = str(os.getppid() or 2)
        os.environ['BOOKFORGE_OWNER_PLATFORM'] = (
            'linux' if os.name == 'nt' else 'win32')
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertIsNone(resolve_owner())
        self.assertIn('the parent-pid rule is the only orphan check', buf.getvalue())

    def test_a_same_platform_live_owner_is_armed(self):
        os.environ['BOOKFORGE_OWNER_PID'] = str(os.getpid() + 0)
        # our own pid is refused, so use the parent's, which is alive and ours
        os.environ['BOOKFORGE_OWNER_PID'] = str(os.getppid())
        os.environ['BOOKFORGE_OWNER_PLATFORM'] = 'win32' if os.name == 'nt' else 'linux'
        buf = io.StringIO()
        with redirect_stdout(buf):
            owner = resolve_owner()
        if os.getppid() <= 1:
            self.skipTest('this process is detached; there is no owner to watch')
        self.assertIsNotNone(owner)
        self.assertEqual(owner[0], os.getppid())

    def test_nothing_has_fired_while_the_parent_is_alive(self):
        self.assertIsNone(orphan_reason(os.getppid(), None))

    def test_a_reparent_fires_the_ppid_rule(self):
        """The rule is 'the ppid CHANGED', which needs no pid to be remembered and
        therefore cannot race pid reuse."""
        fired = orphan_reason(os.getppid() + 100000, None)
        self.assertIsNotNone(fired)
        self.assertIn('reparented from', fired[1])

    def test_a_dead_owner_fires_the_owner_rule(self):
        dead = 0x7FFFFFF0        # not a live pid on any of the three platforms
        fired = orphan_reason(None, (dead, None))
        self.assertIsNotNone(fired)
        self.assertIn('exited', fired[1])

    def test_a_detached_run_arms_nothing_and_says_so(self):
        """A worker whose parent is already pid 1 has nothing to outlive. e2a
        compares against the ppid RECORDED AT STARTUP rather than testing
        `getppid() == 1` precisely so this case is not shot in the head two
        seconds in."""
        real_getppid = os.getppid
        os.getppid = lambda: 1
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertIsNone(start_parent_watch())
            out = buf.getvalue()
            self.assertIn('a detached run has nothing to outlive', out)
            self.assertIn('parent watchdog disabled', out)
        finally:
            os.getppid = real_getppid


if __name__ == '__main__':
    unittest.main()
