"""The engine seam is a CONTRACT, asserted at runtime and not in a docstring.

`narrator.engine.protocol` exists so the chunk packer, the render worker, the
serve worker and the assembler can be written once against ANY LLM-codec TTS
engine. That is only true if conformance is checked - a Protocol nobody
isinstance()s is a comment. Every type here is `runtime_checkable`, so this
module asks the question directly of both engines.

What is asserted:
  1. OrpheusEngine and HiggsEngine satisfy `Engine`; their codecs satisfy
     `Codec` and their budgets satisfy `Budget`.
  2. The registry knows its three ids - orpheus, higgs-v3, and the
     not-shipped higgs-v2-scaffold - and REFUSES a fourth by name, without
     defaulting to Orpheus.
  3. The two engines DISAGREE where the plan says they must: `pads`,
     `edge_fade_ms`, the codec's frame geometry, whether EOS is reliable, and
     the shape of `max_total_tokens`. A seam whose two implementations answer
     identically would not be evidence of anything.
  4. The Orpheus levers stayed Orpheus-private: nothing in the protocol names
     an eosBoost, and Orpheus's are inside StopPolicy.levers.

An engine INSTANCE normally loads a model, which this interpreter cannot do. The
protocol checks therefore use an uninitialised instance
(`object.__new__(cls)`) with the two attributes `__init__` sets - `backend` and
`voice` - assigned by hand. That is honest for what is being tested: isinstance
against a runtime_checkable Protocol is a hasattr sweep, so the value under test
is the CLASS's member set, and the two instance attributes are pinned separately
against `__init__`'s own source.
"""
import inspect
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))   # .../python
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import registry                                  # noqa: E402
from narrator.engine.higgs import (HiggsBudget, HiggsCodec, HiggsConfig,  # noqa: E402
                                   HiggsDefaults, HiggsEngine)
from narrator.engine.orpheus import OrpheusEngine                     # noqa: E402
from narrator.engine.orpheus.interface import (OrpheusBudget,         # noqa: E402
                                               OrpheusCodec)
from narrator.engine.protocol import (BackendSpec, Budget, ClipsVoice,  # noqa: E402
                                      Codec, Engine, ReferenceClip,
                                      ServedBackend, SpeechRequest,
                                      StopPolicy, TokenVoice)

# The members `Engine` names. Kept as a literal so a member SILENTLY dropped
# from the protocol is a failure here rather than an unnoticed relaxation.
ENGINE_MEMBERS = ('ENGINE_ID', 'SAMPLE_RATE', 'pads', 'edge_fade', 'backend',
                  'voice', 'backend_spec', 'codec', 'budget', 'stop_policy',
                  'resolve_load_voice', 'convert', 'convert_batch',
                  'generate_batch_stream', 'cleanup')


def _load_assembler_profiles():
    """`narrator/assemble/engine_profiles.py`, loaded BY PATH.

    NOT `from narrator.assemble import engine_profiles`: that runs the assemble
    package's `__init__`, which pulls in ffmpeg discovery and the whole assembly
    stack. This test is about one table of numbers and must not fail because an
    unrelated module in another builder's column is mid-edit.
    """
    import importlib.util
    path = os.path.join(_PYTHON_ROOT, 'narrator', 'assemble',
                        'engine_profiles.py')
    if not os.path.isfile(path):
        raise AssertionError(
            f'the assembler\'s engine-profile table is missing: {path}. The engine '
            'and the assembler each hold a copy of the pads/fade facts, and this '
            'test is the only thing keeping them equal.')
    spec = importlib.util.spec_from_file_location('_assembler_profiles', path)
    module = importlib.util.module_from_spec(spec)
    # Registered before exec: @dataclass resolves its annotations through
    # sys.modules[cls.__module__], so a module loaded outside sys.modules blows
    # up inside dataclasses rather than in anything this test is about.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(spec.name, None)
        raise
    return module


def _bare(cls, voice='deathstalker', backend='vllm'):
    """An uninitialised engine carrying the two attributes __init__ sets."""
    engine = object.__new__(cls)
    engine.backend = backend
    engine.voice = voice
    return engine


def _orpheus(voice='deathstalker', caps=None):
    """An OrpheusEngine shell with a config, enough for caps/budget/stop_policy
    (all of which read class constants and the per-voice cap registry)."""
    from narrator.engine import EngineConfig
    engine = _bare(OrpheusEngine, voice=voice)
    engine.config = EngineConfig(voice=voice, caps=caps)
    return engine


def _higgs_config(**kwargs):
    voice = ClipsVoice(
        clips=(ReferenceClip(path=__file__, transcript='A book-exact line.',
                             seconds=14.0),),
        name='deathstalker')
    return HiggsConfig(voice=voice, **kwargs)


class ProtocolConformanceTest(unittest.TestCase):

    def test_the_protocol_names_exactly_these_members(self):
        """Pins the surface itself: a member added to Engine without a decision
        shows up here, and one removed does too.

        The member set is computed rather than read off `__protocol_attrs__`,
        which only exists from Python 3.12 - and the WSL Orpheus env is 3.11.
        """
        declared = set(Engine.__annotations__)
        declared |= {name for name, value in vars(Engine).items()
                     if not name.startswith('_') and callable(value)}
        self.assertEqual(sorted(declared), sorted(ENGINE_MEMBERS))

    def test_orpheus_engine_satisfies_the_engine_protocol(self):
        self.assertIsInstance(_bare(OrpheusEngine), Engine)

    def test_higgs_engine_satisfies_the_engine_protocol(self):
        self.assertIsInstance(_bare(HiggsEngine, backend='transformers'), Engine)

    def test_init_is_what_sets_backend_and_voice(self):
        """The two members the class body does not carry. Read off __init__'s
        source rather than assumed, so a refactor that stopped setting one would
        fail here instead of at the first isinstance in production."""
        for cls in (OrpheusEngine, HiggsEngine):
            source = inspect.getsource(cls.__init__)
            with self.subTest(engine=cls.__name__):
                self.assertIn('self.backend', source)
                self.assertIn('self.voice', source)

    def test_the_codecs_satisfy_the_codec_protocol(self):
        self.assertIsInstance(OrpheusCodec(_bare(OrpheusEngine)), Codec)
        self.assertIsInstance(HiggsCodec(lambda codes: codes), Codec)

    def test_the_budgets_satisfy_the_budget_protocol(self):
        self.assertIsInstance(OrpheusBudget(_orpheus()), Budget)
        self.assertIsInstance(HiggsBudget(_higgs_config()), Budget)

    def test_the_v3_backend_satisfies_the_served_protocol(self):
        from narrator.engine.higgs.v3_served import HiggsV3ServedBackend
        backend = HiggsV3ServedBackend(base_url='http://127.0.0.1:8095')
        self.assertIsInstance(backend, ServedBackend)
        self.assertEqual(backend.spec.kind, 'served')

    def test_the_v3_engine_satisfies_the_engine_protocol(self):
        from narrator.engine.higgs import HiggsV3Engine
        self.assertIsInstance(_bare(HiggsV3Engine, backend='vllm-omni'), Engine)

    def test_a_served_backend_needs_a_url_or_a_launch_script(self):
        """Neither given is a refusal, not a default: guessing localhost:8095
        would either talk to somebody else's server or hang."""
        from narrator.engine.higgs.v3_served import (BASE_URL_ENV,
                                                     HiggsV3ServedBackend,
                                                     SERVE_SCRIPT_ENV)
        for name in (BASE_URL_ENV, SERVE_SCRIPT_ENV):
            previous = os.environ.pop(name, None)
            if previous is not None:
                self.addCleanup(os.environ.__setitem__, name, previous)
        with self.assertRaises(ValueError) as caught:
            HiggsV3ServedBackend()
        self.assertIn(BASE_URL_ENV, str(caught.exception))
        self.assertIn(SERVE_SCRIPT_ENV, str(caught.exception))


class RegistryTest(unittest.TestCase):

    def test_the_known_ids(self):
        self.assertEqual(registry.ids(),
                         ['higgs-v2-scaffold', 'higgs-v3', 'orpheus'])

    def test_every_entry_is_a_pair_of_factories(self):
        """The registry must be READABLE - "which engines exist?" - on an
        interpreter with no backend installed, which is why its values are
        zero-import callables rather than classes. (That importing them stays
        lazy is asserted in a fresh subprocess by
        tests/test_engine_lazy_imports.py; this pins the shape that makes it
        possible.)"""
        for engine_id, entry in registry.ENGINES.items():
            with self.subTest(engine=engine_id):
                self.assertEqual(len(entry), 2)
                self.assertTrue(all(callable(f) for f in entry))

    def test_an_unknown_id_is_refused_by_name(self):
        for call in (lambda: registry.engine_class('llasa'),
                     lambda: registry.engine_config('llasa', voice='x')):
            with self.assertRaises(ValueError) as caught:
                call()
            message = str(caught.exception)
            self.assertIn('llasa', message)
            self.assertIn('higgs-v3', message)
            self.assertIn('orpheus', message)
            self.assertIn('Refusing to substitute', message)

    def test_the_registry_resolves_every_engine(self):
        from narrator.engine.higgs import HiggsV3Engine
        self.assertIs(registry.engine_class('orpheus'), OrpheusEngine)
        self.assertIs(registry.engine_class('higgs-v3'), HiggsV3Engine)
        self.assertIs(registry.engine_class('higgs-v2-scaffold'), HiggsEngine)

    def test_every_engine_reports_the_id_that_selected_it(self):
        """An engine whose ENGINE_ID disagrees with its registry key makes a
        log line name the wrong engine at exactly the moment someone is trying
        to tell two of them apart."""
        for engine_id in registry.ids():
            with self.subTest(engine=engine_id):
                self.assertEqual(registry.engine_class(engine_id).ENGINE_ID,
                                 engine_id)

    def test_orpheus_config_is_still_EngineConfig(self):
        from narrator.engine import EngineConfig
        config = registry.engine_config('orpheus', voice='deathstalker')
        self.assertIsInstance(config, EngineConfig)
        self.assertEqual(config.voice, 'deathstalker')


class TheTwoEnginesDisagreeTest(unittest.TestCase):
    """Where the seam earns its keep. Each of these is a fact the assembler, the
    packer or the scheduler has to read off the engine instead of assuming."""

    def test_pads_and_edge_fade(self):
        from narrator.engine.higgs import HiggsV3Engine
        self.assertTrue(OrpheusEngine.pads,
                        'Orpheus bakes its gaps into each chunk FLAC')
        self.assertFalse(HiggsV3Engine.pads,
                         'Higgs emits bare speech; the assembler owns the gaps')
        self.assertEqual(OrpheusEngine.edge_fade.as_manifest(),
                         {'in': 0.0, 'out': 0.0})
        self.assertEqual(HiggsV3Engine.edge_fade.as_manifest(),
                         {'in': 10.0, 'out': 25.0})

    def test_the_fade_is_asymmetric_and_that_is_the_point(self):
        """One float cannot say this. A chunk begins on an attack the ear
        expects and ends on a decay it does not, so the tail needs more than
        twice the head's window."""
        from narrator.engine.higgs import HiggsV3Engine
        fade = HiggsV3Engine.edge_fade
        self.assertGreater(fade.out_ms, 2 * fade.in_ms)
        self.assertTrue(OrpheusEngine.edge_fade.is_none)
        self.assertFalse(fade.is_none)

    def test_the_engines_agree_with_the_assemblers_own_table(self):
        """`assemble/engine_profiles.py` is assembly's COPY of these facts - it
        exists because assembly runs on a machine with no engine to ask. Two
        copies of one truth need a test, or an audiobook clicks at every join
        and nobody knows which side was wrong."""
        engine_profiles = _load_assembler_profiles()
        from narrator.engine.higgs import HiggsV3Engine
        for engine in (OrpheusEngine, HiggsV3Engine):
            profile = engine_profiles.profile_for(engine.ENGINE_ID)
            with self.subTest(engine=engine.ENGINE_ID):
                self.assertEqual(profile.pads, engine.pads)
                self.assertEqual(profile.fade_in_ms, engine.edge_fade.in_ms)
                self.assertEqual(profile.fade_out_ms, engine.edge_fade.out_ms)

    def test_codec_geometry(self):
        orpheus = OrpheusCodec(_bare(OrpheusEngine))
        higgs = HiggsCodec(lambda codes: codes)
        self.assertEqual((orpheus.tokens_per_frame, orpheus.samples_per_frame,
                          orpheus.trim_frames), (7, 2048, 0))
        self.assertEqual((higgs.tokens_per_frame, higgs.samples_per_frame,
                          higgs.trim_frames), (8, 960, 7))
        # Same sample rate, DIFFERENT frame rate - which is why a duration is
        # never computed from a token count without asking the codec.
        self.assertEqual(orpheus.sample_rate, higgs.sample_rate)
        self.assertAlmostEqual(orpheus.frames_per_second, 24000 / 2048, places=6)
        self.assertEqual(higgs.frames_per_second, 25.0)

    def test_only_snac_has_a_windowed_decoder(self):
        from narrator.engine.orpheus.snac import WindowedFrameEmitter
        orpheus = OrpheusCodec(_bare(OrpheusEngine))
        self.assertIsInstance(orpheus.streaming_decoder(lambda a, b: None),
                              WindowedFrameEmitter)
        self.assertIsNone(HiggsCodec(lambda codes: codes).streaming_decoder(
            lambda a, b: None),
            'a delay-pattern codec has no sound windowed decode; returning None '
            'is the statement that says so')

    def test_max_total_tokens_has_two_shapes(self):
        """Orpheus's audio cap is INDEPENDENT of the prompt, so its answer grows
        with it; Higgs's context is a ceiling the prompt eats into."""
        orpheus = OrpheusBudget(_orpheus())
        self.assertEqual(orpheus.max_total_tokens(0),
                         OrpheusEngine.MAX_AUDIO_TOKENS)
        self.assertEqual(orpheus.max_total_tokens(500),
                         500 + OrpheusEngine.MAX_AUDIO_TOKENS)

        higgs = HiggsBudget(_higgs_config())
        self.assertEqual(higgs.max_total_tokens(0), HiggsDefaults.CONTEXT_TOKENS)
        self.assertEqual(higgs.max_total_tokens(1632),
                         HiggsDefaults.CONTEXT_TOKENS)
        with self.assertRaises(ValueError) as caught:
            higgs.max_total_tokens(HiggsDefaults.CONTEXT_TOKENS)
        self.assertIn('nothing to generate', str(caught.exception))

    def test_stop_policies_disagree_about_eos(self):
        orpheus = _orpheus().stop_policy()
        self.assertFalse(orpheus.eos_reliable)
        self.assertTrue(orpheus.resplit_on_cap)
        self.assertIsNone(orpheus.coverage_check)

        from narrator.engine.higgs import higgs_stop_policy
        higgs = higgs_stop_policy(_higgs_config())
        self.assertTrue(higgs.eos_reliable, 'measured: EOS 9/9, zero cap hits')
        self.assertFalse(higgs.resplit_on_cap)
        self.assertEqual(higgs.coverage_check, 'asr',
                         'duration is not a coverage proxy on this family')


class OrpheusLeversStayPrivateTest(unittest.TestCase):

    def test_no_orpheus_lever_is_named_in_the_protocol(self):
        """The whole point of StopPolicy: a scheduler must never have to know
        what an eosFloor is."""
        import narrator.engine.protocol as protocol
        source = inspect.getsource(protocol)
        for lever in ('eosBoost', 'eosFloor', 'eosBoostStart', 'eosFloorRate',
                      'repPenalty', 'minP'):
            with self.subTest(lever=lever):
                self.assertNotIn(f"'{lever}'", source)
                self.assertNotIn(f'"{lever}"', source)

    def test_orpheus_levers_ride_inside_stop_policy(self):
        policy = _orpheus().stop_policy()
        self.assertEqual(
            sorted(policy.levers),
            ['eosBoost', 'eosBoostStart', 'eosFloor', 'eosFloorRate', 'minP',
             'repPenalty', 'temperature', 'topP'])
        self.assertEqual(policy.max_new_tokens, OrpheusEngine.MAX_AUDIO_TOKENS)
        self.assertEqual(policy.max_chars_per_sec,
                         float(OrpheusEngine.DEFAULT_MAX_CHARS_PER_SEC))

    def test_a_registered_cap_reaches_the_stop_policy(self):
        """The three-step lookup (registered -> env -> default) is unchanged by
        the extraction; the policy is a VIEW of it, not a copy taken early."""
        OrpheusEngine.register_voice_caps('capstest', {'eosFloor': 0.65,
                                                       'maxCharsPerSec': 23.5})
        self.addCleanup(OrpheusEngine._voice_caps.pop, 'capstest', None)
        policy = _orpheus(voice='capstest').stop_policy()
        self.assertEqual(policy.levers['eosFloor'], 0.65)
        self.assertEqual(policy.max_chars_per_sec, 23.5)


class OrpheusBudgetTest(unittest.TestCase):

    def test_max_chars_comes_from_the_catalog_payload(self):
        budget = OrpheusBudget(_orpheus(caps={'maxChars': 450,
                                              'maxCharsPerSec': 23.5}))
        self.assertEqual(budget.max_chars(), 450)

    def test_max_chars_refuses_rather_than_guessing(self):
        """A chunk size derived from the token cap would be ~836 characters
        where the catalog says ~450. Refuse instead."""
        with self.assertRaises(ValueError) as caught:
            OrpheusBudget(_orpheus()).max_chars()
        self.assertIn('maxChars', str(caught.exception))
        self.assertIn('refusing to guess', str(caught.exception).lower())

    def test_max_chars_refuses_a_voice_this_engine_was_not_built_for(self):
        budget = OrpheusBudget(_orpheus(caps={'maxChars': 450}))
        with self.assertRaises(ValueError) as caught:
            budget.max_chars('someone_else')
        self.assertIn('someone_else', str(caught.exception))

    def test_max_chars_per_sec_is_the_live_guard(self):
        budget = OrpheusBudget(_orpheus())
        self.assertEqual(budget.max_chars_per_sec(),
                         float(OrpheusEngine.DEFAULT_MAX_CHARS_PER_SEC))


class StdoutIsTheProtocolTest(unittest.TestCase):
    """No engine written for narrator may print to STDOUT.

    `narrator.serve` writes one JSON object per line to stdout and
    electron/orpheus-worker-pool.ts parses every one of them; a bare
    `[HIGGS3] launching: ...` line there is a parse error that kills the
    session. It is an easy mistake - a `print(..., flush=True)` looks like
    logging - and it cost two protocol tests before this check existed.

    SCOPED TO THE NEW ENGINES. `engine/orpheus/**` is a faithful port of
    ebook2audiobook, whose prints go to stdout, and that behaviour is preserved
    deliberately (PORT_NOTES section 5 lists the load-bearing ones). Its output
    only appears during real model work, which the protocol tests never reach.
    """

    def _stdout_prints(self, path):
        import ast
        tree = ast.parse(open(path, encoding='utf-8').read())
        return [node.lineno for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and getattr(node.func, 'id', None) == 'print'
                and not any(kw.arg == 'file' for kw in node.keywords)]

    def test_the_higgs_engines_log_to_stderr(self):
        import narrator.engine.higgs as higgs
        directory = os.path.dirname(higgs.__file__)
        for name in sorted(os.listdir(directory)):
            if not name.endswith('.py'):
                continue
            path = os.path.join(directory, name)
            with self.subTest(module=name):
                self.assertEqual(
                    self._stdout_prints(path), [],
                    f'{name} prints to stdout, which is the JSON protocol')

    def test_the_fake_engines_too(self):
        from narrator.serve import fake_engine
        self.assertEqual(self._stdout_prints(fake_engine.__file__), [])


class ChunkWriterTest(unittest.TestCase):
    """ONE writer, PCM_16, on every backend and every engine.

    Ruled 2026-09-04 after the Mac MLX run. e2a wrote chunks with
    `torchaudio.save(format='flac')`; on current wheels that routes through
    TorchCodec and needs FFmpeg dylibs (every sentence failed with "TorchCodec
    is required" until ffmpeg was installed), and it produced PCM_24 there
    against PCM_16 under WSL/vLLM. Mixed bit depths in one session are what
    ffmpeg's concat demuxer drops frames on - SILENTLY, which is how sentences
    disappeared out of an assembled book before.
    """

    def _written(self, write):
        import shutil
        import tempfile
        import soundfile as sf
        directory = tempfile.mkdtemp(prefix='narrator-writer-')
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, 'chunk.flac')
        write(path)
        info = sf.info(path)
        audio, rate = sf.read(path, dtype='float32')
        return info, audio, rate

    def test_orpheus_writes_24k_mono_pcm16_with_the_exact_sample_count(self):
        import numpy as np
        engine = _bare(OrpheusEngine)
        engine.params = {'samplerate': 24000}
        engine.config = type('C', (), {'audio_format': 'flac'})()
        wave = (0.25 * np.sin(np.linspace(0, 40, 7200))).astype(np.float32)
        info, audio, rate = self._written(
            lambda path: engine.write_chunk_file(path, wave, 24000))
        self.assertEqual(rate, 24000)
        self.assertEqual(info.channels, 1)
        self.assertEqual(info.subtype, 'PCM_16')
        self.assertEqual(info.format, 'FLAC')
        self.assertEqual(audio.size, 7200, 'not one sample added or lost')

    def test_it_accepts_the_shape_the_engine_actually_hands_it(self):
        """`_save_audio` builds a (1, N) tensor; the MLX path hands a 1-D numpy
        array. Both are mono and both must land identically."""
        import numpy as np
        engine = _bare(OrpheusEngine)
        engine.params = {'samplerate': 24000}
        engine.config = type('C', (), {'audio_format': 'flac'})()
        flat = np.zeros(2400, dtype=np.float32)
        for shape, wave in (('1-D', flat), ('(1, N)', flat.reshape(1, -1))):
            with self.subTest(shape=shape):
                _info, audio, _rate = self._written(
                    lambda path: engine.write_chunk_file(path, wave, 24000))
                self.assertEqual(audio.size, 2400)

    def test_stereo_is_refused_rather_than_downmixed(self):
        import numpy as np
        engine = _bare(OrpheusEngine)
        engine.params = {'samplerate': 24000}
        engine.config = type('C', (), {'audio_format': 'flac'})()
        with self.assertRaises(ValueError) as caught:
            engine.write_chunk_file('x.flac', np.zeros((2, 100), np.float32), 24000)
        self.assertIn('MONO', str(caught.exception))

    def test_the_silence_writer_uses_the_same_path(self):
        import shutil
        import tempfile
        import soundfile as sf
        directory = tempfile.mkdtemp(prefix='narrator-writer-')
        self.addCleanup(shutil.rmtree, directory, True)
        engine = _bare(OrpheusEngine)
        engine.params = {'samplerate': 24000}
        engine.config = type('C', (), {'audio_format': 'flac'})()
        engine._sentence_file = lambda i: os.path.join(directory, f'{i}.flac')
        engine._write_silence(3)
        info = sf.info(os.path.join(directory, '3.flac'))
        self.assertEqual(info.subtype, 'PCM_16')
        self.assertEqual(info.samplerate, 24000)
        self.assertEqual(info.channels, 1)

    def test_nothing_in_the_engine_calls_torchaudio_save(self):
        """torchaudio is gone from the WRITE path entirely - chunks AND the
        post-mortem reject clips. Reading (resume, trim) is unchanged from the
        port. Asserted over the AST, so the prose explaining the deviation does
        not satisfy it."""
        import ast
        import narrator.engine.orpheus as orpheus_pkg
        directory = os.path.dirname(orpheus_pkg.__file__)
        for name in sorted(os.listdir(directory)):
            if not name.endswith('.py'):
                continue
            tree = ast.parse(open(os.path.join(directory, name),
                                  encoding='utf-8').read())
            calls = [node.lineno for node in ast.walk(tree)
                     if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Attribute)
                     and node.func.attr == 'save'
                     and getattr(node.func.value, 'id', None) == 'torchaudio']
            with self.subTest(module=name):
                self.assertEqual(calls, [], f'{name} still writes with torchaudio')


class BackendSpecTest(unittest.TestCase):

    def test_orpheus_is_inprocess_on_every_backend(self):
        for backend in ('vllm', 'mlx', 'transformers'):
            spec = _bare(OrpheusEngine, backend=backend).backend_spec()
            with self.subTest(backend=backend):
                self.assertEqual((spec.kind, spec.name), ('inprocess', backend))
                self.assertIsNone(spec.base_url)

    def test_a_served_spec_must_carry_a_url(self):
        with self.assertRaises(ValueError) as caught:
            BackendSpec(kind='served', name='vllm-omni')
        self.assertIn('base_url', str(caught.exception))

    def test_an_inprocess_spec_must_not(self):
        with self.assertRaises(ValueError):
            BackendSpec(kind='inprocess', name='vllm', base_url='http://x')

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(ValueError):
            BackendSpec(kind='remote', name='x')

    def test_speech_request_defaults_to_the_servers_own_sampling(self):
        """An EMPTY sampling map means "server defaults" - which is what the
        delivered v3 render used, and what a client must not quietly replace."""
        request = SpeechRequest(text='hi', voice=TokenVoice('deathstalker'),
                                max_new_tokens=100)
        self.assertEqual(dict(request.sampling), {})


if __name__ == '__main__':
    unittest.main()
