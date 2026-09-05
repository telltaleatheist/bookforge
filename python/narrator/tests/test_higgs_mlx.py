"""Higgs v3 on Apple Silicon: the platform split, the decode, and the routing.

FOUR THINGS ARE UNDER TEST, and only one of them needs a Mac:

  1. WHICH BACKEND `higgs-v3` IS, by platform. darwin -> the in-process MLX
     engine; anything else -> the vllm-omni served one. A pure function of
     `sys.platform`, so both arms are checked on every machine.
  2. THE DECODE, at the token level. `revert_delay_pattern` and
     `real_code_frames` are pure numpy and run everywhere. They are pinned
     against the SAVED TOKEN MATRICES from the vllm-omni sentinel investigation
     (`golden/higgs_sentinel/talker_rows_*.npy`, copied read-only from
     `E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\v3_ft\\probe\\sentinel\\`),
     because those are the only recordings of the RAGGED endings a healthy
     render does not produce.
  3. THE THREE VOICE SHAPES through the MLX config builder - checkpoint,
     clips, default - and every refusal at that boundary.
  4. THE WORKER'S RENDER ROUTING. `backend == 'mlx'` used to mean "Orpheus's
     MLX ladder"; Higgs v3 on the Mac is truthfully `backend == 'mlx'` and has
     none of those methods. The dispatch is now keyed on ENGINE_ID and this
     module proves it, with a stub engine, on any platform.

WHAT THE MAC MEASURED (2026-09-05, mlx-audio 0.4.8, mlx 0.32.0,
bosonai/higgs-audio-v3-tts-4b, two fixed seeds, 107-char chunk):

    seed 1234   152 rows -> 145 audio frames, 0 out-of-range codes, filter a
                no-op, trailing-300 ms RMS -60.13 dB untreated AND filtered
    seed 1235   154 rows -> 147 audio frames, 0 out-of-range codes, filter a
                no-op, trailing-300 ms RMS -47.64 dB untreated AND filtered

i.e. ON A CLEAN ENDING mlx-audio's revert is already exact and the filter
removes nothing - which is the measurement that says a trailing trim would have
been a band-aid REMOVING REAL AUDIO. The filter earns its place on the ragged
shapes in `golden/higgs_sentinel/`, where it is not a no-op.
"""
import os
import sys
import unittest

import numpy as np

from narrator.engine.higgs.mlx_backend import (AUDIO_BOC_ID, AUDIO_EOC_ID,
                                               NUM_CODEBOOKS, NUM_REAL_CODES,
                                               HiggsMlxStreamMisaligned,
                                               real_code_frames,
                                               revert_delay_pattern)
from narrator.engine.registry import (HIGGS_V3_BACKENDS,
                                      higgs_v3_backend_for_platform)

_HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(_HERE, 'golden', 'higgs_sentinel')


# ---------------------------------------------------------------------------
# 1. The platform split
# ---------------------------------------------------------------------------


class BackendSelectionTest(unittest.TestCase):
    """One engine id, two runtimes, chosen by platform and by nothing else."""

    def test_darwin_gets_the_in_process_mlx_backend(self):
        self.assertEqual(higgs_v3_backend_for_platform('darwin'), 'inprocess-mlx')

    def test_every_other_platform_gets_the_served_backend(self):
        for platform in ('win32', 'linux', 'linux2', 'cygwin', 'freebsd13'):
            with self.subTest(platform=platform):
                self.assertEqual(higgs_v3_backend_for_platform(platform), 'served')

    def test_both_answers_are_declared(self):
        for platform in ('darwin', 'win32'):
            self.assertIn(higgs_v3_backend_for_platform(platform),
                          HIGGS_V3_BACKENDS)

    def test_an_empty_platform_is_refused_not_guessed(self):
        """A blank `sys.platform` cannot choose between an in-process model and
        a server, and defaulting either way is a whole book rendered by
        something nobody asked for."""
        for bad in ('', '   ', None):
            with self.subTest(platform=bad):
                with self.assertRaises(ValueError):
                    higgs_v3_backend_for_platform(bad)

    def test_the_registry_answers_without_building_anything(self):
        """`ids()` and the platform function answer with no engine constructed.

        NOTE WHAT THIS DOES NOT ASSERT. It used to add
        `assertNotIn('mlx', sys.modules)`, which passed alone and FAILED in a
        full-suite run on the Mac: by then another test module has legitimately
        imported mlx into the same interpreter, so the assertion was about the
        order the suite happened to run in rather than about this module. The
        no-heavy-imports contract is a SUBPROCESS question and is proved as one -
        `LazyImportTest` below, and `tests/test_engine_lazy_imports.py`.
        """
        from narrator.engine import registry
        tripped = []
        saved = dict(registry.ENGINES)
        registry.ENGINES.update({
            engine_id: (lambda _i=engine_id: tripped.append(_i),
                        lambda **_kw: None)
            for engine_id in saved})
        try:
            ids = registry.ids()
        finally:
            registry.ENGINES.clear()
            registry.ENGINES.update(saved)
        self.assertIn('higgs-v3', ids)
        self.assertEqual(tripped, [],
                         'ids() must not call an engine factory: importing one '
                         'imports its backend, and the registry has to stay '
                         'readable on an interpreter with no torch and no mlx.')

    @unittest.skipUnless(sys.platform == 'darwin', 'the MLX arm is Mac only')
    def test_on_this_mac_the_registry_hands_back_the_mlx_engine(self):
        from narrator.engine import registry
        self.assertIs(registry.engine_class('higgs-v3'),
                      __import__('narrator.engine.higgs', fromlist=['x']
                                 ).HiggsV3MlxEngine)

    @unittest.skipIf(sys.platform == 'darwin', 'the served arm is not the Mac')
    def test_off_the_mac_the_registry_hands_back_the_served_engine(self):
        from narrator.engine import registry
        from narrator.engine.higgs import HiggsV3Engine
        self.assertIs(registry.engine_class('higgs-v3'), HiggsV3Engine)


# ---------------------------------------------------------------------------
# 2a. revert_delay_pattern
# ---------------------------------------------------------------------------


class RevertDelayPatternTest(unittest.TestCase):
    """`raw[t, c] = delayed[t + c, c]` - and nothing else.

    Equivalent in content to
    `mlx_audio...higgs_audio_v3.generation.reverse_delay_pattern`; narrator
    keeps its own so the arithmetic is testable without mlx and so the sentinel
    filter can run on the result before anything reaches the codec.
    """

    def test_it_takes_the_diagonal(self):
        delayed = np.arange(15 * NUM_CODEBOOKS).reshape(15, NUM_CODEBOOKS)
        raw = revert_delay_pattern(delayed)
        self.assertEqual(raw.shape, (15 - 7, NUM_CODEBOOKS))
        for t in range(raw.shape[0]):
            for c in range(NUM_CODEBOOKS):
                self.assertEqual(raw[t, c], delayed[t + c, c],
                                 f'raw[{t},{c}] must be delayed[{t + c},{c}]')

    def test_it_consumes_exactly_the_diagonal_and_no_more(self):
        for rows in (8, 20, 301):
            with self.subTest(rows=rows):
                delayed = np.zeros((rows, NUM_CODEBOOKS), dtype=np.int64)
                self.assertEqual(revert_delay_pattern(delayed).shape[0], rows - 7)

    def test_a_generation_shorter_than_the_diagonal_carries_no_audio(self):
        """Not an error - a row that stopped before it said anything."""
        for rows in (0, 1, 7):
            with self.subTest(rows=rows):
                out = revert_delay_pattern(
                    np.zeros((rows, NUM_CODEBOOKS), dtype=np.int64))
                self.assertEqual(out.shape, (0, NUM_CODEBOOKS))

    def test_a_wrong_shape_is_refused_by_name(self):
        for bad in (np.zeros((10, 7)), np.zeros((10,)), np.zeros((2, 10, 8))):
            with self.subTest(shape=bad.shape):
                with self.assertRaises(HiggsMlxStreamMisaligned):
                    revert_delay_pattern(bad)

    def test_the_forced_ramp_up_boc_never_reaches_the_output(self):
        """mlx-audio's sampler forces BOC into every codebook ABOVE the diagonal
        for the first 7 rows. The revert reads only ON and BELOW it, so a BOC
        cannot arrive from the head - and if that ever changed, this fails."""
        rows = 40
        delayed = np.full((rows, NUM_CODEBOOKS), 5, dtype=np.int64)
        for r in range(NUM_CODEBOOKS - 1):
            delayed[r, r + 1:] = AUDIO_BOC_ID
        raw = revert_delay_pattern(delayed)
        self.assertEqual(int((raw == AUDIO_BOC_ID).sum()), 0)

    def test_a_clean_eoc_diagonal_falls_one_frame_past_the_output(self):
        """THE MEASUREMENT THE WHOLE DESIGN RESTS ON. Codebook 0 emits EOC at
        row e; the sampler runs 6 more rows and stops, so L = e + 7 and the
        revert produces exactly e frames. The EOC diagonal sits at
        `delayed[e + c, c]`, which is frame e - one past the last frame
        produced. On a clean ending the revert is EXACT: nothing to trim."""
        e = 30
        delayed = np.full((e + 7, NUM_CODEBOOKS), 5, dtype=np.int64)
        for c in range(NUM_CODEBOOKS - 1):
            delayed[e + c, c] = AUDIO_EOC_ID       # the ramp-down diagonal
        raw = revert_delay_pattern(delayed)
        self.assertEqual(raw.shape[0], e)
        self.assertEqual(int((raw >= NUM_REAL_CODES).sum()), 0,
                         'a clean ending must leave NO sentinel in the audio frames')
        _kept, report = real_code_frames(raw)
        self.assertEqual(report.dropped, 0,
                         'the filter must be a NO-OP on a clean ending - a trim '
                         'here would remove real audio')


# ---------------------------------------------------------------------------
# 2b. real_code_frames - the root fix
# ---------------------------------------------------------------------------


class RealCodeFrameFilterTest(unittest.TestCase):
    """Keep a frame iff all 8 codebooks are in [0, 1023]. By TOKEN IDENTITY,
    never by position and never by audio content."""

    @staticmethod
    def _frames(n=20, fill=7):
        return np.full((n, NUM_CODEBOOKS), fill, dtype=np.int64)

    def test_all_real_codes_survive_untouched(self):
        frames = self._frames()
        kept, report = real_code_frames(frames)
        np.testing.assert_array_equal(kept, frames)
        self.assertEqual((report.total, report.kept), (20, 20))
        self.assertEqual((report.leading, report.interior, report.trailing),
                         (0, 0, 0))

    def test_nothing_is_substituted(self):
        """THE DEFECT THIS REPLACES. The upstream code turned every sentinel
        into codebook entry 0 - a VALID code that decodes to real sound - so
        the substitution WAS the artifact. A kept frame's values must come out
        exactly as they went in, and a dropped frame must be gone, not zeroed."""
        frames = self._frames(n=10, fill=513)
        frames[9] = AUDIO_EOC_ID
        kept, report = real_code_frames(frames)
        self.assertEqual(kept.shape[0], 9)
        self.assertEqual(int((kept == 0).sum()), 0,
                         'no frame may be zero-substituted; 0 is a real code')
        np.testing.assert_array_equal(kept, frames[:9])
        self.assertEqual(report.trailing, 1)

    def test_a_trailing_sentinel_run_is_dropped_and_counted(self):
        frames = self._frames()
        frames[17:] = AUDIO_EOC_ID
        kept, report = real_code_frames(frames)
        self.assertEqual(kept.shape[0], 17)
        self.assertEqual((report.leading, report.interior, report.trailing),
                         (0, 0, 3))

    def test_a_leading_sentinel_run_is_dropped_and_counted(self):
        frames = self._frames()
        frames[:2] = AUDIO_BOC_ID
        kept, report = real_code_frames(frames)
        self.assertEqual(kept.shape[0], 18)
        self.assertEqual((report.leading, report.interior, report.trailing),
                         (2, 0, 0))

    def test_an_interior_sentinel_is_dropped_and_reported_separately(self):
        """Interior contamination is NOT an expected shape. It is dropped -
        never substituted - and counted on its own so it can be logged loudly:
        a gate is a defect sensor, not a silent repair."""
        frames = self._frames()
        frames[8] = AUDIO_EOC_ID
        kept, report = real_code_frames(frames)
        self.assertEqual(kept.shape[0], 19)
        self.assertEqual((report.leading, report.interior, report.trailing),
                         (0, 1, 0))

    def test_one_out_of_range_codebook_condemns_the_whole_frame(self):
        """A frame is 8 codebooks of ONE 40 ms slice. Seven real codes and one
        sentinel is not seven-eighths of a frame, it is a frame the codec
        cannot render."""
        frames = self._frames()
        frames[5, 3] = AUDIO_BOC_ID
        kept, report = real_code_frames(frames)
        self.assertEqual(report.kept, 19)
        self.assertEqual(report.interior, 1)
        self.assertEqual(int(((kept >= NUM_REAL_CODES) | (kept < 0)).sum()), 0)

    def test_a_negative_pad_is_out_of_range_too(self):
        """The -1 the talker stages for a row it did not update. Out of range is
        out of range; there is no separate pad rule."""
        frames = self._frames()
        frames[11] = -1
        kept, report = real_code_frames(frames)
        self.assertEqual(report.interior, 1)
        self.assertEqual(int((kept < 0).sum()), 0)

    def test_1023_is_kept_and_1024_is_not(self):
        """The boundary, stated. 1023 is the last real code; 1024 is BOC."""
        frames = self._frames()
        frames[3] = NUM_REAL_CODES - 1
        frames[4] = NUM_REAL_CODES
        kept, report = real_code_frames(frames)
        self.assertEqual(report.kept, 19)
        self.assertIn(NUM_REAL_CODES - 1, kept)
        self.assertNotIn(NUM_REAL_CODES, kept)

    def test_a_row_that_is_all_sentinel_yields_no_audio_and_says_so(self):
        frames = self._frames()
        frames[:] = AUDIO_EOC_ID
        kept, report = real_code_frames(frames)
        self.assertEqual(kept.shape[0], 0)
        self.assertEqual(report.kept, 0)

    def test_an_empty_matrix_is_not_an_error(self):
        kept, report = real_code_frames(np.zeros((0, NUM_CODEBOOKS)))
        self.assertEqual(kept.shape[0], 0)
        self.assertEqual(report.total, 0)

    def test_a_wrong_shape_is_refused_by_name(self):
        with self.assertRaises(HiggsMlxStreamMisaligned):
            real_code_frames(np.zeros((10, 7)))


# ---------------------------------------------------------------------------
# 2c. The saved token matrices - the ragged endings, as they really happened
# ---------------------------------------------------------------------------


#: (fixture, raw frames, kept, leading, interior, trailing). MEASURED by running
#: this module's own functions over the saved matrices, 2026-09-05, and pinned
#: so a change to either function has to explain itself.
#:
#: The four `talker_rows_{0,1,2,clean}` matrices are CLEAN vllm-omni endings and
#: still lose ONE trailing frame: that talker appends a residual all-EOC row
#: which mlx-audio's sampler does not emit (measured: 0 out-of-range on the Mac).
#: `capped` and `partial_ramp` lose NOTHING - their sentinels all fall past the
#: revert's window, which is why upstream's blind one-frame trim was eating a
#: REAL 40 ms frame on exactly these shapes. `pad_row` is the one that matters:
#: 8 INTERIOR frames of -1 pad, which no positional trim can reach.
SAVED_MATRICES = (
    ('talker_rows_0.npy',            301, 300, 0, 0, 1),
    ('talker_rows_1.npy',            451, 450, 0, 0, 1),
    ('talker_rows_2.npy',            201, 200, 0, 0, 1),
    ('talker_rows_clean.npy',        301, 300, 0, 0, 1),
    ('talker_rows_capped.npy',       260, 260, 0, 0, 0),
    ('talker_rows_partial_ramp.npy', 236, 236, 0, 0, 0),
    ('talker_rows_pad_row.npy',      201, 192, 0, 8, 1),
)


class SavedTokenMatrixTest(unittest.TestCase):
    """The real thing, recorded. These are the token matrices the Higgs v3
    talker emitted for the vllm-omni sentinel investigation - the only saved
    recordings of the endings a healthy render does not produce."""

    def _load(self, name):
        path = os.path.join(FIXTURES, name)
        if not os.path.isfile(path):
            self.fail(f'missing fixture {path}. These are copied read-only from '
                      f'the campaign at v3_ft/probe/sentinel/ and are part of the '
                      f'repo - a missing one is not a reason to skip.')
        return np.load(path)

    def test_the_shapes_are_what_this_backend_expects(self):
        for name, *_ in SAVED_MATRICES:
            with self.subTest(name=name):
                rows = self._load(name)
                self.assertEqual(rows.ndim, 2)
                self.assertEqual(rows.shape[1], NUM_CODEBOOKS)

    def test_no_out_of_range_code_ever_reaches_the_codec(self):
        """THE ONE ASSERTION THE FIX EXISTS FOR, across every recorded shape."""
        for name, *_ in SAVED_MATRICES:
            with self.subTest(name=name):
                kept, _report = real_code_frames(
                    revert_delay_pattern(self._load(name)))
                out_of_range = int(((kept >= NUM_REAL_CODES) | (kept < 0)).sum())
                self.assertEqual(out_of_range, 0,
                                 f'{name}: {out_of_range} sentinel entries would '
                                 f'have been handed to the codec')

    def test_the_drop_counts_are_exactly_what_was_measured(self):
        for name, raw_n, kept_n, lead, interior, trail in SAVED_MATRICES:
            with self.subTest(name=name):
                raw = revert_delay_pattern(self._load(name))
                self.assertEqual(raw.shape[0], raw_n)
                _kept, report = real_code_frames(raw)
                self.assertEqual(
                    (report.kept, report.leading, report.interior, report.trailing),
                    (kept_n, lead, interior, trail))

    def test_the_capped_and_partial_ramp_shapes_lose_no_real_audio(self):
        """The defect a blind trim CAUSES. On a generation that hit the cap or
        was abandoned mid-ramp there is no sentinel inside the revert's window
        at all, so trimming one frame - as upstream did unconditionally - throws
        away 40 ms of speech. The filter takes nothing here."""
        for name in ('talker_rows_capped.npy', 'talker_rows_partial_ramp.npy'):
            with self.subTest(name=name):
                raw = revert_delay_pattern(self._load(name))
                kept, report = real_code_frames(raw)
                self.assertEqual(report.dropped, 0)
                np.testing.assert_array_equal(kept, raw)

    def test_the_pad_row_shape_is_the_one_no_trim_could_reach(self):
        """8 interior frames of -1 pad. A trailing trim walks back from the end
        and stops at the first real frame, so it never sees these; the
        substitution upstream turned all 8 into codebook entry 0 and decoded
        them as sound."""
        raw = revert_delay_pattern(self._load('talker_rows_pad_row.npy'))
        _kept, report = real_code_frames(raw)
        self.assertEqual(report.interior, 8)
        self.assertGreater(int((raw < 0).sum()), 0,
                           'this fixture is supposed to carry -1 pads')


# ---------------------------------------------------------------------------
# 3. The three voice shapes, through the MLX config builder
# ---------------------------------------------------------------------------


class MlxConfigTest(unittest.TestCase):
    """checkpoint / clips / default - and every refusal at the load boundary."""

    def setUp(self):
        import json
        import tempfile
        from narrator.engine.higgs.config import VOICES_ENV
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        # A real (silent) wav, because load_voices checks the clip exists.
        import soundfile as sf
        clip = os.path.join(root, 'ref.wav')
        sf.write(clip, np.zeros(24000, dtype=np.float32), 24000)
        checkpoint = os.path.join(root, 'merged')
        os.makedirs(checkpoint)
        with open(os.path.join(checkpoint, 'config.json'), 'w',
                  encoding='utf-8') as handle:
            handle.write('{}')
        self.checkpoint = checkpoint
        document = {
            'ft': {'kind': 'checkpoint', 'checkpointDir': checkpoint,
                   'maxChars': 420, 'maxCharsSource': 'catalog'},
            'clone': {'clips': [{'path': clip, 'transcript': 'A book-exact line.',
                                 'seconds': 1.0}]},
            'base': {'kind': 'default'},
        }
        self.doc = os.path.join(root, 'voices.json')
        with open(self.doc, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        self._saved = {k: os.environ.get(k) for k in
                       (VOICES_ENV, 'NARRATOR_HIGGS3_MLX_MODEL')}
        os.environ[VOICES_ENV] = self.doc
        os.environ['NARRATOR_HIGGS3_MLX_MODEL'] = os.path.join(root, 'basemodel')

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()

    def _build(self, voice, **kwargs):
        from narrator.engine.higgs import higgs_v3_mlx_config_from_worker_kwargs
        return higgs_v3_mlx_config_from_worker_kwargs(voice=voice, **kwargs)

    def test_a_checkpoint_voice_loads_its_own_merged_weights(self):
        """A fine-tune's WEIGHTS are the voice, so the model loaded IS the
        voice's directory - not the base plus something."""
        from narrator.engine.higgs import HiggsV3MlxBudget
        config = self._build("ft")
        self.assertEqual(config.model_dir, self.checkpoint)
        self.assertEqual(config.voice.kind, 'default')     # text-only prompt
        self.assertEqual(config.voice.checkpoint_dir, self.checkpoint)
        self.assertEqual(HiggsV3MlxBudget(config).max_chars(), 420)

    def test_a_clips_voice_loads_the_base_weights_and_keeps_its_clips(self):
        config = self._build('clone')
        self.assertEqual(config.voice.kind, 'clips')
        self.assertEqual(len(config.voice.clips), 1)
        self.assertTrue(config.model_dir.endswith('basemodel'))

    def test_a_default_voice_loads_the_base_weights_and_carries_no_reference(self):
        config = self._build('base')
        self.assertEqual(config.voice.kind, 'default')
        self.assertIsNone(config.voice.checkpoint_dir)
        self.assertTrue(config.model_dir.endswith('basemodel'))

    def test_a_clips_voice_gets_v3s_control_allowlist_stamped_on_it(self):
        """A voice read with the v2 scaffold's defaults carries an EMPTY
        allowlist, which is not 'anything goes' but 'no control tokens at all' -
        true of v2 and false of v3."""
        config = self._build('clone')
        self.assertIn('<|prosody:long_pause|>', config.voice.allowed_controls)
        self.assertEqual(config.voice.max_reference_seconds, 30.0)

    def test_an_unset_model_variable_is_a_refusal_naming_it(self):
        os.environ.pop('NARRATOR_HIGGS3_MLX_MODEL')
        with self.assertRaises(ValueError) as caught:
            self._build('base')
        self.assertIn('NARRATOR_HIGGS3_MLX_MODEL', str(caught.exception))

    def test_a_checkpoint_voice_does_not_need_the_model_variable(self):
        """Its weights are named in the document; there is nothing to fall back
        to and nothing to look up."""
        os.environ.pop('NARRATOR_HIGGS3_MLX_MODEL')
        self.assertEqual(self._build('ft').model_dir, self.checkpoint)

    def test_the_orpheus_shaped_load_fields_are_refused_by_name(self):
        for kwargs in ({'model_dir': '/somewhere'}, {'base_dir': '/somewhere'},
                       {'adapter_dir': '/somewhere'},
                       {'caps': {'eosBoost': 1.0}}):
            with self.subTest(**kwargs):
                with self.assertRaises(ValueError) as caught:
                    self._build('base', **kwargs)
                self.assertTrue(
                    any(k.split('_')[0] in str(caught.exception).lower()
                        for k in kwargs),
                    f'the refusal must name what it refused: {caught.exception}')

    def test_a_voice_the_document_does_not_carry_is_refused_not_substituted(self):
        with self.assertRaises(ValueError) as caught:
            self._build('nobody')
        message = str(caught.exception)
        self.assertIn('nobody', message)
        for known in ('ft', 'clone', 'base'):
            self.assertIn(known, message)

    def test_an_unknown_sampling_lever_is_refused(self):
        """`repetition_penalty` and `seed` are the SERVER's; mlx-audio's sampler
        takes temperature / top_p / top_k and nothing else. Accepting one would
        look applied and do nothing."""
        from narrator.engine.higgs import HiggsV3MlxConfig
        config = self._build('base')
        with self.assertRaises(ValueError):
            HiggsV3MlxConfig(voice=config.voice, model_dir=config.model_dir,
                             sampling={'repetition_penalty': 1.1})

    def test_the_sampling_defaults_are_v3s_own(self):
        config = self._build('base')
        self.assertEqual(config.mlx_sampling(),
                         {'temperature': 1.0, 'top_p': 0.95, 'top_k': 50})

    def test_the_stop_policy_reports_the_levers_that_will_be_applied(self):
        from narrator.engine.higgs import higgs_v3_mlx_stop_policy
        policy = higgs_v3_mlx_stop_policy(self._build('base'))
        self.assertTrue(policy.eos_reliable)
        self.assertFalse(policy.resplit_on_cap)
        self.assertEqual(policy.coverage_check, 'asr')
        self.assertEqual(sorted(policy.levers), ['temperature', 'top_k', 'top_p'])


# ---------------------------------------------------------------------------
# 4. The worker's render routing
# ---------------------------------------------------------------------------


class _StubEngine:
    """Just enough engine to be dispatched. Deliberately has NONE of Orpheus's
    render methods, so a mis-route is an AttributeError, not a wrong sound."""

    SAMPLE_RATE = 24000
    pads = False

    def __init__(self, engine_id, backend):
        self.ENGINE_ID = engine_id
        self.backend = backend
        self.voice = 'v'
        self.calls = []

    def _clean_sentence_for_tts(self, text):
        return (text or '').strip()

    def render_audio(self, text, seed=None, index=0):
        self.calls.append((text, index))
        return np.zeros(2400, dtype=np.float32)


def _loaded_server(engine):
    """A worker with `engine` already loaded, without spawning a process.

    `current_voice` and `engine_voices` are what `load_voice` would have set;
    setting them here is what makes `_row_voice` answer instead of raising
    'Model not loaded'.
    """
    from narrator.serve.worker import OrpheusStreamServer
    server = OrpheusStreamServer()
    server.orph = engine
    server.current_voice = engine.voice
    server.engine_voices = {engine.voice: None}
    return server


class WorkerRenderRoutingTest(unittest.TestCase):
    """`backend == 'mlx'` is a RUNTIME name, not an engine.

    Higgs v3 on the Mac loads through mlx-audio and truthfully reports
    `backend == 'mlx'`, while having none of `_generate_mlx_safe`,
    `_generate_mlx_batch_audio` or `_guard_truncation`. Before the dispatch was
    keyed on ENGINE_ID, a Higgs load on the Mac would have been routed straight
    into Orpheus's MLX ladder and failed on the first sentence.
    """

    def test_the_predicate_names_orpheus_and_nothing_else(self):
        from narrator.serve.worker import _uses_orpheus_token_pipeline
        self.assertTrue(_uses_orpheus_token_pipeline(
            _StubEngine('orpheus', 'mlx')))
        for engine_id in ('higgs-v3', 'higgs-v2-scaffold', 'higgs'):
            for backend in ('mlx', 'vllm-omni', 'transformers'):
                with self.subTest(engine=engine_id, backend=backend):
                    self.assertFalse(_uses_orpheus_token_pipeline(
                        _StubEngine(engine_id, backend)))

    def test_higgs_on_mlx_renders_through_render_audio(self):
        from narrator.serve.worker import OrpheusStreamServer
        server = _loaded_server(_StubEngine('higgs-v3', 'mlx'))
        engine = server.orph
        audio = server._generate_audio('Hello there.', index=4)
        self.assertEqual(engine.calls, [('Hello there.', 4)])
        self.assertGreater(len(audio), 0)

    def test_the_row_index_seeds_the_row_and_is_not_dropped(self):
        """chunk i renders with seed + i. A worker that passed 0 for every row
        would make a whole book of identical draws for identical text."""
        from narrator.serve.worker import OrpheusStreamServer
        server = _loaded_server(_StubEngine('higgs-v3', 'mlx'))
        engine = server.orph
        for i in (0, 1, 17):
            server._generate_audio('A line.', index=i)
        self.assertEqual([index for _text, index in engine.calls], [0, 1, 17])

    def test_an_engine_that_is_neither_orpheus_nor_renderable_is_a_named_error(self):
        from narrator.serve.worker import OrpheusStreamServer
        class _NoRender(_StubEngine):
            render_audio = None

            def __getattribute__(self, name):
                if name == 'render_audio':
                    raise AttributeError(name)
                return object.__getattribute__(self, name)

        server = _loaded_server(_NoRender('higgs-v3', 'mlx'))
        with self.assertRaises(RuntimeError) as caught:
            server._generate_audio('Hello.')
        self.assertIn('render_audio', str(caught.exception))

    def test_the_batch_dispatcher_does_not_send_higgs_down_orpheuss_mlx_path(self):
        """`_generate_batch_mlx_ordered` calls `_generate_mlx_batch_audio`,
        which is Orpheus's. The stub has no such method, so a mis-route would
        raise here rather than render."""
        import narrator.serve.worker as W
        server = _loaded_server(_StubEngine('higgs-v3', 'mlx'))
        engine = server.orph
        taken = []
        server._generate_batch_mlx_ordered = lambda *a, **k: taken.append('orpheus-mlx')
        sent = []
        original = W.send_response
        W.send_response = lambda kind, payload=None: sent.append((kind, payload))
        try:
            server.generate_batch([{'i': 0, 'text': 'One line.'}], 'en')
        finally:
            W.send_response = original
        self.assertEqual(taken, [], 'Higgs must not take Orpheus\'s MLX path')
        self.assertEqual(engine.calls, [('One line.', 0)])
        self.assertEqual(sent[-1][0], 'batch_done')


# ---------------------------------------------------------------------------
# 5. The lazy-import contract, for this module specifically
# ---------------------------------------------------------------------------


class LazyImportTest(unittest.TestCase):
    """Importing the MLX backend must not import mlx.

    `tests/test_engine_lazy_imports.py` asserts this for `narrator.engine` as a
    package; this pins the new module by name, because it is the one whose whole
    job is mlx and therefore the one most likely to acquire a module-scope
    import.
    """

    def test_importing_the_mlx_backend_pulls_in_no_mlx(self):
        import subprocess
        root = os.path.dirname(os.path.dirname(_HERE))
        probe = ('import sys\n'
                 'import narrator.engine.higgs.mlx_backend\n'
                 "bad = sorted(m for m in ('mlx', 'mlx_lm', 'mlx_audio', 'torch') "
                 'if m in sys.modules)\n'
                 "print(','.join(bad))\n")
        env = {k: v for k, v in os.environ.items()
               if not k.startswith('VLLM_') and not k.startswith('ORPHEUS_')}
        out = subprocess.run([sys.executable, '-c', probe], cwd=root, env=env,
                             capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), '',
                         'narrator.engine.higgs.mlx_backend must import no mlx')


if __name__ == '__main__':
    unittest.main()
