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
ENGINE_MEMBERS = ('ENGINE_ID', 'SAMPLE_RATE', 'pads', 'edge_fade_ms', 'backend',
                  'voice', 'backend_spec', 'codec', 'budget', 'stop_policy',
                  'convert', 'convert_batch', 'generate_batch_stream', 'cleanup')


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

    def test_the_registry_resolves_both_engines(self):
        self.assertIs(registry.engine_class('orpheus'), OrpheusEngine)
        self.assertIs(registry.engine_class('higgs-v2-scaffold'), HiggsEngine)

    def test_orpheus_config_is_still_EngineConfig(self):
        from narrator.engine import EngineConfig
        config = registry.engine_config('orpheus', voice='deathstalker')
        self.assertIsInstance(config, EngineConfig)
        self.assertEqual(config.voice, 'deathstalker')


class TheTwoEnginesDisagreeTest(unittest.TestCase):
    """Where the seam earns its keep. Each of these is a fact the assembler, the
    packer or the scheduler has to read off the engine instead of assuming."""

    def test_pads_and_edge_fade(self):
        self.assertTrue(OrpheusEngine.pads,
                        'Orpheus bakes its gaps into each chunk FLAC')
        self.assertFalse(HiggsEngine.pads,
                         'Higgs emits bare speech; the assembler owns the gaps')
        self.assertEqual(OrpheusEngine.edge_fade_ms, 0.0)
        self.assertEqual(HiggsEngine.edge_fade_ms, 10.0)

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
