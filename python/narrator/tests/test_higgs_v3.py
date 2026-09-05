"""Higgs v3 without the GPU: the request, the response, the lifecycle, the wire.

Higgs v3 is a SERVED engine - the model runs in a vllm-omni process narrator
launches, health-checks and stops. Everything about it that can go wrong
silently is on the HTTP boundary, so this module puts a REAL HTTP server
(stdlib `http.server`, in a thread) where vllm-omni would be and drives the real
client against it.

WHAT IS FIXTURE AND WHAT IS CAPTURE. There is NO recorded request/response
capture yet: the delivered cloned renders were driven by
`<campaign>/higgs/work/render_final.py` and `work/confirm.py`, and those scripts
plus `HIGGS_V3_LEVERS.md` are what the expected request body below is built
from. So the shape assertions here are AGAINST THE SCRIPTS, NOT A CAPTURE. When
a real capture lands (it is owed to `<campaign>/higgs/captures/`),
`EXPECTED_REQUEST` is the one place it replaces, and `decode_response` is the
one place a response-format correction goes.

The three failures this is here to catch, all of which return HTTP 200 or look
fine:
  1. sampling sent at the TOP LEVEL is silently dropped (pydantic), so the
     render runs at the server default while the log says otherwise;
  2. an out-of-vocabulary control token is READ ALOUD and collapses the render
     (measured coverage 0.000);
  3. a reference over 30 s, or more than one reference, is refused by the server
     with a 400 - after a 55 s launch and a GPU allocation.
"""
import json
import os
import struct
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))   # .../python
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import registry                                  # noqa: E402
from narrator.engine.higgs import v3_served                           # noqa: E402
from narrator.engine.higgs.v3_engine import (HiggsV3Budget,           # noqa: E402
                                             HiggsV3Config,
                                             HiggsV3Defaults,
                                             HiggsV3Engine,
                                             higgs_v3_stop_policy)
from narrator.engine.higgs.v3_served import (HiggsV3ServedBackend,    # noqa: E402
                                             HiggsV3ServerError)
from narrator.engine.protocol import (ClipsVoice, ReferenceClip,      # noqa: E402
                                      SpeechRequest)

# The reference the delivered render used: work/refs/manifest.json entry "x2" -
# two same-book deathstalker clips pre-joined into one 27.42 s wav, transcripts
# joined in the same order.
X2_TEXT = ('They are little moments that help us to be genuinely present where we '
           'are. What else can we do?')


def a_wav(path, seconds=1.0, rate=24000):
    """A tiny real WAV on disk, so reference_data_uri has something to read."""
    samples = np.zeros(int(rate * seconds), dtype=np.float32)
    import soundfile as sf
    sf.write(path, samples, rate)
    return path


def wav_bytes(seconds=1.0, rate=24000, channels=1, tail_burst_dbfs=None):
    """A WAV FILE as bytes - what /v1/audio/speech returns with
    response_format 'wav'. Built by hand (PCM16 RIFF) so the fake server needs
    no soundfile of its own."""
    frames = int(rate * seconds)
    data = (np.sin(2 * np.pi * 220.0 * np.arange(frames) / rate) * 0.4 * 32767)
    # A patched server's clip ends in near-silence (our smoke measured -62 dBFS
    # over the last 300 ms). Fade the last 300 ms out so the fake matches.
    fade = min(frames, int(rate * 0.3))
    if fade:
        data[-fade:] *= np.linspace(1.0, 0.0, fade) ** 4
    if tail_burst_dbfs is not None:
        # An UNPATCHED server: ~250 ms of ramp-down sentinels decoded as real
        # sound at about -30 dB, cut off at its peak.
        burst = min(frames, int(rate * 0.25))
        amp = (10 ** (tail_burst_dbfs / 20.0)) * 32767 * np.sqrt(2)
        data[-burst:] = (np.sin(2 * np.pi * 90.0 * np.arange(burst) / rate) * amp)
    pcm = data.astype('<i2').tobytes()
    if channels == 2:
        pcm = b''.join(pcm[i:i + 2] * 2 for i in range(0, len(pcm), 2))
    block = 2 * channels
    header = (b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVE'
              + b'fmt ' + struct.pack('<IHHIIHH', 16, 1, channels, rate,
                                      rate * block, block, 16)
              + b'data' + struct.pack('<I', len(pcm)))
    return header + pcm


class FakeV3Handler(BaseHTTPRequestHandler):
    """Just enough of vllm-omni: /health, /v1/models, /v1/audio/speech.

    It records every request body it is given, and can be told to answer a 400
    the way the real server does.
    """

    server_version = 'fake-vllm-omni/0.28.0'

    def log_message(self, *args):
        pass                                   # keep the test output readable

    def do_GET(self):
        if self.path in (v3_served.HEALTH_PATH, '/ping'):
            if not self.server.healthy:
                self.send_error(503, 'not ready')
                return
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if self.path == v3_served.MODELS_PATH:
            if self.server.models_broken:
                # Something is listening, but it is not an OpenAI-shaped server.
                self.send_error(404)
                return
            payload = json.dumps(
                {'data': [{'id': m} for m in self.server.models]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)

    def do_POST(self):
        if self.path != v3_served.SPEECH_PATH:
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', '0'))
        body = json.loads(self.rfile.read(length).decode('utf-8'))
        self.server.requests.append(body)
        if self.server.error is not None:
            code, message = self.server.error
            payload = json.dumps({'message': message}).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        audio = wav_bytes(self.server.seconds, self.server.rate,
                          self.server.channels, self.server.tail_burst_dbfs)
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('x-vllm-omni-output-tokens', '509')
        self.send_header('Content-Length', str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


class FakeV3Server:
    """The fake, on a real port, in a thread."""

    def __init__(self, healthy=True, seconds=1.0, rate=24000, channels=1):
        self.httpd = HTTPServer(('127.0.0.1', 0), FakeV3Handler)
        self.httpd.requests = []
        self.httpd.healthy = healthy
        self.httpd.error = None
        self.httpd.seconds = seconds
        self.httpd.rate = rate
        self.httpd.channels = channels
        self.httpd.models = ['higgs-v3']
        self.httpd.models_broken = False
        self.httpd.tail_burst_dbfs = None
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        host, port = self.httpd.server_address[:2]
        return f'http://{host}:{port}'

    @property
    def requests(self):
        return self.httpd.requests

    def fail_with(self, code, message):
        self.httpd.error = (code, message)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=10)


class V3TestCase(unittest.TestCase):
    """A fake server and a one-clip deathstalker voice, for every subclass."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='narrator-H-v3-')
        self.addCleanup(self._rmtree)
        self.clip = a_wav(os.path.join(self.dir, 'ref_x2.wav'), seconds=1.0)
        self.server = FakeV3Server()
        self.addCleanup(self.server.close)

    def _rmtree(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def voice(self, seconds=27.42, clips=1, **kwargs):
        return ClipsVoice(
            clips=tuple(ReferenceClip(self.clip, X2_TEXT, seconds=seconds / clips)
                        for _ in range(clips)),
            name='deathstalker', **kwargs)

    def config(self, **kwargs):
        kwargs.setdefault('voice', self.voice())
        kwargs.setdefault('base_url', self.server.base_url)
        return HiggsV3Config(**kwargs)

    def quiet_config(self, **kwargs):
        """A config whose load runs no tail-trim probe - for the tests that are
        counting requests or asserting seeds."""
        kwargs.setdefault('probe_tail_trim', False)
        return self.config(**kwargs)


class RequestShapeTest(V3TestCase):
    """AGAINST THE SCRIPTS, NOT A CAPTURE - see the module docstring."""

    def test_the_body_matches_render_final_and_confirm(self):
        body = v3_served.build_request_body(
            'It was a Saturday morning.', self.voice(), 500, seed=1234)
        self.assertEqual(sorted(body), ['input', 'max_new_tokens', 'model',
                                        'references', 'response_format', 'seed'])
        self.assertEqual(body['model'], 'higgs-v3')
        self.assertEqual(body['response_format'], 'wav')
        self.assertEqual(body['max_new_tokens'], 500)
        self.assertEqual(body['seed'], 1234)
        self.assertEqual(len(body['references']), 1)
        self.assertEqual(body['references'][0]['text'], X2_TEXT)
        self.assertTrue(
            body['references'][0]['audio_path'].startswith('data:audio/wav;base64,'),
            'a bare path is rejected ("The URL must be either a HTTP, data or file '
            'URL") and file:// needs --allowed-local-media-path')

    def test_no_sampling_means_the_servers_own_defaults(self):
        """The delivered render sends NO extra_params, so the deploy defaults
        (temperature 1.0, top_p 0.95, top_k 50) apply verbatim. That is what
        Owen asked for."""
        body = v3_served.build_request_body('Hello.', self.voice(), 200)
        self.assertNotIn('extra_params', body)
        self.assertNotIn('temperature', body)

    def test_sampling_rides_in_extra_params_and_never_at_the_top_level(self):
        """THE bug of the first audition: pydantic drops top-level temperature
        without a word, so every one of those renders actually ran at the server
        default while the log said 0.3."""
        body = v3_served.build_request_body('Hello.', self.voice(), 200,
                                            sampling={'temperature': 0.7,
                                                      'top_p': 0.9})
        self.assertEqual(body['extra_params'], {'temperature': 0.7, 'top_p': 0.9})
        self.assertNotIn('temperature', body)
        self.assertNotIn('top_p', body)

    def test_an_unknown_sampling_key_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            v3_served.build_request_body('Hello.', self.voice(), 200,
                                         sampling={'min_p': 0.1})
        self.assertIn('min_p', str(caught.exception))

    def test_the_cap_formula_is_render_finals(self):
        """int(chars / 15.0 * 25 * 2.0) + 150."""
        for chars, cap in ((300, 1150), (600, 2150), (898, 3143)):
            with self.subTest(chars=chars):
                self.assertEqual(v3_served.cap_frames('x' * chars), cap)

    def test_no_voice_means_the_models_own_narrator(self):
        """Legitimate only for a smoke test: un-cloned sits at 12 % of the
        narrator ceiling."""
        body = v3_served.build_request_body('Hello.', None, 200)
        self.assertNotIn('references', body)


class ControlTokenTest(V3TestCase):

    def test_the_allowlist_is_the_measured_vocabulary(self):
        self.assertEqual(len(v3_served.ALLOWED_CONTROL_TOKENS), 45)
        self.assertIn('<|prosody:long_pause|>', v3_served.ALLOWED_CONTROL_TOKENS)
        self.assertIn('<|emotion:contemplation|>', v3_served.ALLOWED_CONTROL_TOKENS)

    def test_every_known_trap_is_refused(self):
        """Each of these was measured to collapse a render: coverage 0.000,
        pitch std 0.28 st, speaker cosine 0.05."""
        for trap in ('<|emotion:calm|>', '<|emotion:neutral|>',
                     '<|prosody:pause_long|>', '<|scene_desc_start|>'):
            with self.subTest(trap=trap):
                with self.assertRaises(ValueError) as caught:
                    v3_served.validate_control_tokens(trap + ' Hello.')
                self.assertIn(trap, str(caught.exception))

    def test_a_real_control_token_passes(self):
        v3_served.validate_control_tokens('<|prosody:long_pause|>Hello.')

    def test_the_request_builder_runs_the_check(self):
        with self.assertRaises(ValueError):
            v3_served.build_request_body('<|emotion:calm|>Hi.', self.voice(), 200)


class ReferenceTest(V3TestCase):

    def test_the_thirty_second_cap(self):
        with self.assertRaises(ValueError) as caught:
            self.voice(seconds=42.03)
            v3_served.check_reference_budget(self.voice(seconds=42.03))
        message = str(caught.exception)
        self.assertIn('42.0', message)
        self.assertIn('30', message)

    def test_joins_count_against_the_cap(self):
        """Concatenating N clips inserts N-1 x 0.35 s of silence, and the server
        measures the wav it is given."""
        total = v3_served.reference_seconds(self.voice(seconds=29.9, clips=2))
        self.assertAlmostEqual(total, 29.9, places=3)
        with self.assertRaises(ValueError):
            v3_served.check_reference_budget(self.voice(seconds=29.9, clips=2))

    def test_a_clip_without_a_duration_is_refused(self):
        voice = ClipsVoice(clips=(ReferenceClip(self.clip, X2_TEXT),),
                           name='deathstalker')
        with self.assertRaises(ValueError) as caught:
            v3_served.check_reference_budget(voice)
        self.assertIn('no duration', str(caught.exception))

    def test_more_than_one_reference_is_refused_with_the_instruction(self):
        """vllm-omni takes EXACTLY ONE reference. Using just the first clip
        would be a different voice, reported as success."""
        with self.assertRaises(ValueError) as caught:
            v3_served.reference_for(self.voice(seconds=27.0, clips=2))
        message = str(caught.exception)
        self.assertIn('EXACTLY ONE', message)
        self.assertIn('pre-joined', message)

    def test_a_clip_without_a_transcript_cannot_exist(self):
        with self.assertRaises(ValueError):
            ReferenceClip(self.clip, '')


class AdapterStrategyTest(unittest.TestCase):
    """How a fine-tuned v3 voice is served is NOT yet exercised - vllm-omni's
    LoRA support for this model class is unknown, and the fallback is a merged
    checkpoint. Both shapes are expressed so the answer is catalog data."""

    def test_lora_modules_is_a_launch_argument(self):
        self.assertEqual(
            v3_served.adapter_launch_args('lora-modules', 'ds', '/models/ds-lora'),
            ['--enable-lora', '--lora-modules', 'ds=/models/ds-lora'])

    def test_a_merged_dir_replaces_the_serve_argument(self):
        self.assertEqual(
            v3_served.adapter_launch_args('merged-dir', 'ds', '/models/ds-merged'),
            [])

    def test_an_unknown_strategy_is_refused_by_name(self):
        with self.assertRaises(ValueError) as caught:
            v3_served.adapter_launch_args('per-request', 'ds', '/models/x')
        message = str(caught.exception)
        self.assertIn('per-request', message)
        self.assertIn('lora-modules', message)
        self.assertIn('merged-dir', message)

    def test_an_adapter_with_no_strategy_is_refused_at_config_time(self):
        voice = ClipsVoice(clips=(ReferenceClip(__file__, 'A line.', seconds=14.0),),
                           name='ds')
        with self.assertRaises(ValueError) as caught:
            HiggsV3Config(voice=voice, base_url='http://127.0.0.1:1',
                          adapter_dir='/models/ds-lora')
        self.assertIn('no strategy', str(caught.exception))


class LifecycleTest(V3TestCase):

    def test_attach_mode_does_not_launch_or_kill(self):
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        backend.start()                        # no-op
        self.assertTrue(backend.wait_ready(5))
        backend.stop()                         # must not touch anything
        self.assertTrue(backend.ping(), 'stop() killed a server it did not start')

    def test_attach_mode_has_no_launch_command(self):
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        with self.assertRaises(ValueError):
            backend.launch_command()

    def test_wait_ready_returns_False_on_timeout(self):
        """A slow start is the caller's decision, not an exception. The measured
        cold start is ~55 s."""
        server = FakeV3Server(healthy=False)
        self.addCleanup(server.close)
        backend = HiggsV3ServedBackend(base_url=server.base_url)
        self.assertFalse(backend.wait_ready(2))

    def test_wait_ready_raises_when_the_process_died(self):
        """Waiting out a timeout on a corpse is the failure this avoids."""
        backend = HiggsV3ServedBackend(base_url='http://127.0.0.1:1',
                                       serve_script='/nonexistent.sh')

        class Dead:
            returncode = 1

            def poll(self):
                return 1

        backend._proc = Dead()
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.wait_ready(5)
        self.assertIn('status 1', str(caught.exception))

    def test_the_launch_command_invokes_their_script(self):
        backend = HiggsV3ServedBackend(serve_script='/campaign/serve_v3.sh')
        command = backend.launch_command()
        self.assertIn('/campaign/serve_v3.sh', ' '.join(command).replace('\\', '/'))
        self.assertIn('bash', ' '.join(command))

    def test_extra_launch_args_are_refused_because_the_script_takes_none(self):
        with self.assertRaises(ValueError) as caught:
            HiggsV3ServedBackend(serve_script='/campaign/serve_v3.sh',
                                 extra_args=['--enable-lora'])
        self.assertIn('takes no arguments', str(caught.exception))


class ResponseTest(V3TestCase):

    def test_a_wav_body_decodes_to_float32_mono(self):
        audio, rate = v3_served.decode_response(wav_bytes(seconds=0.5))
        self.assertEqual(rate, 24000)
        self.assertEqual(audio.dtype, np.float32)
        self.assertEqual(audio.ndim, 1)
        self.assertEqual(audio.size, 12000)

    def test_stereo_is_averaged_down(self):
        audio, _ = v3_served.decode_response(wav_bytes(seconds=0.5, channels=2))
        self.assertEqual(audio.ndim, 1)
        self.assertEqual(audio.size, 12000)

    def test_a_wrong_sample_rate_is_refused(self):
        """A manifest built on the wrong rate mis-times every cue after it."""
        with self.assertRaises(HiggsV3ServerError) as caught:
            v3_served.decode_response(wav_bytes(seconds=0.1, rate=16000))
        self.assertIn('24000', str(caught.exception))

    def test_an_empty_body_is_refused(self):
        with self.assertRaises(HiggsV3ServerError):
            v3_served.decode_response(b'')

    def test_a_server_error_carries_the_servers_own_message(self):
        self.server.fail_with(
            400, 'Reference audio too long (42.0s). Maximum 30s supported')
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        request = SpeechRequest(text='Hello.', voice=self.voice(),
                                max_new_tokens=200)
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.speak(request)
        self.assertIn('Maximum 30s', str(caught.exception))

    def test_an_unreachable_server_says_so(self):
        backend = HiggsV3ServedBackend(base_url='http://127.0.0.1:1')
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.post_speech({'model': 'higgs-v3'}, timeout=2)
        self.assertIn('unreachable', str(caught.exception))


class EngineTest(V3TestCase):

    def test_it_renders_a_chunk_through_the_server(self):
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        audio = engine.render_audio('It was a Saturday morning.')
        self.assertEqual(audio.dtype, np.float32)
        self.assertGreater(audio.size, 0)
        sent = self.server.requests[-1]
        self.assertEqual(sent['input'], 'It was a Saturday morning.')
        self.assertNotIn('extra_params', sent)

    def test_the_seam_facts(self):
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        self.assertEqual(engine.ENGINE_ID, 'higgs-v3')
        self.assertEqual(engine.SAMPLE_RATE, 24000)
        self.assertFalse(engine.pads, 'v3 emits bare speech; assembly owns gaps')
        self.assertEqual(engine.edge_fade_ms, 25.0)
        self.assertEqual(engine.backend_spec().kind, 'served')
        codec = engine.codec()
        self.assertEqual((codec.tokens_per_frame, codec.samples_per_frame,
                          codec.trim_frames), (8, 960, 7))
        self.assertIsNone(codec.streaming_decoder(lambda a, b: None))

    def test_the_codec_refuses_to_decode_because_the_server_did(self):
        """The patched server already trimmed the sentinel tail BY CONTENT
        (work/patch_tail_trim.py); a second client-side trim would eat speech,
        and there are no tokens on this side anyway."""
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        with self.assertRaises(NotImplementedError) as caught:
            engine.codec().decode([1, 2, 3])
        self.assertIn('SERVER-SIDE', str(caught.exception))

    def test_the_budget(self):
        budget = HiggsV3Budget(self.config())
        self.assertEqual(budget.max_chars(), 600)
        self.assertEqual(budget.max_total_tokens(0), 8192)
        self.assertEqual(budget.max_total_tokens(685), 8192)
        with self.assertRaises(ValueError):
            budget.max_total_tokens(8192)

    def test_the_stop_policy_reports_what_will_be_sent(self):
        policy = higgs_v3_stop_policy(self.config())
        self.assertTrue(policy.eos_reliable)
        self.assertFalse(policy.resplit_on_cap)
        self.assertEqual(policy.coverage_check, 'asr')
        self.assertEqual(policy.levers['temperature'], 1.0,
                         'no sampling override means the server default')
        self.assertEqual(policy.levers['top_p'], 0.95)

    def test_an_override_shows_up_in_the_levers(self):
        policy = higgs_v3_stop_policy(self.config(sampling={'temperature': 0.7}))
        self.assertEqual(policy.levers['temperature'], 0.7)

    def test_a_batch_renders_serially_and_answers_every_row(self):
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        rows = []
        chunks = []
        engine.generate_batch_stream(['One.', 'Two.'], None, {1},
                                     lambda i, seq, pcm: chunks.append((i, seq)),
                                     lambda i, pcm: rows.append(i))
        self.assertEqual(rows, [0, 1])
        self.assertEqual(chunks, [(1, 0)], 'a streamed row arrives whole, once')

    def test_a_stop_abandons_the_rest_without_an_on_row(self):
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        rows = []
        engine.generate_batch_stream(['One.', 'Two.'], None, None, None,
                                     lambda i, pcm: rows.append(i),
                                     should_stop=lambda: True)
        self.assertEqual(rows, [])

    def test_a_mixed_voice_batch_is_impossible(self):
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        with self.assertRaises(ValueError) as caught:
            engine.generate_batch_stream(['One.'], ['someone_else'], None, None,
                                         lambda i, pcm: None)
        self.assertIn('server restart', str(caught.exception))

    def test_a_dead_server_fails_the_load_not_the_first_sentence(self):
        """The caller is holding a GPU lock; it needs to know now."""
        server = FakeV3Server(healthy=False)
        self.addCleanup(server.close)
        with self.assertRaises(HiggsV3ServerError) as caught:
            HiggsV3Engine(self.config(base_url=server.base_url, ready_timeout=2))
        self.assertIn('did not answer', str(caught.exception))


class RegistrySelectionTest(unittest.TestCase):

    def test_higgs_v3_is_the_second_engine(self):
        self.assertIs(registry.engine_class('higgs-v3'), HiggsV3Engine)

    def test_v2_is_scaffolding_and_says_so(self):
        self.assertIn('higgs-v2-scaffold', registry.ids())
        self.assertNotIn('higgs-v2', registry.ids())
        self.assertIn('NOT SHIPPED', registry.__doc__)

    def test_the_defaults_carry_the_measured_numbers(self):
        self.assertEqual(HiggsV3Defaults.MAX_CHARS, 600)
        self.assertEqual(HiggsV3Defaults.CONTEXT_TOKENS, 8192)
        self.assertEqual(HiggsV3Defaults.MAX_REFERENCE_SECONDS, 30.0)
        self.assertEqual(HiggsV3Defaults.FRAMES_PER_SECOND, 25.0)
        self.assertEqual(HiggsV3Defaults.SAMPLE_RATE, 24000)


class ServeProtocolTest(V3TestCase):
    """The REAL serve worker, the REAL v3 client, the fake HTTP server.

    Not `--fake-engine`: the point is that `NARRATOR_ENGINE=higgs-v3` builds the
    actual HiggsV3Engine and that its audio reaches the pool's wire correctly.
    The worker runs as a subprocess and talks to the fake server over localhost,
    exactly as it would talk to vllm-omni.
    """

    def setUp(self):
        super().setUp()
        import json as _json
        self.voices_path = os.path.join(self.dir, 'voices.json')
        with open(self.voices_path, 'w', encoding='utf-8') as handle:
            # A REAL Higgs voice name. It used to say 'leah' - one of Orpheus's
            # eight stock tokens - which is the only reason this test passed
            # while the worker was validating v3 loads against Orpheus's
            # allowlist. A name no Orpheus allowlist contains is the whole
            # point.
            _json.dump({'deathstalker': {'clips': [{'path': self.clip,
                                                    'transcript': X2_TEXT,
                                                    'seconds': 27.42}]}}, handle)

    def _worker(self):
        import subprocess
        env = dict(os.environ)
        env.update({
            'PYTHONUNBUFFERED': '1',
            'PYTHONIOENCODING': 'utf-8',
            'ORPHEUS_SKIP_WARMUP': '1',
            'NARRATOR_ENGINE': 'higgs-v3',
            'NARRATOR_HIGGS_VOICES': self.voices_path,
            'NARRATOR_HIGGS3_URL': self.server.base_url,
        })
        env.pop('NARRATOR_GOLDEN_LOCAL', None)
        proc = subprocess.Popen(
            [sys.executable, '-m', 'narrator.serve'], cwd=_PYTHON_ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding='utf-8', env=env,
            bufsize=1)
        self.addCleanup(self._shutdown, proc)
        return proc

    def _shutdown(self, proc):
        try:
            proc.stdin.write('{"action": "quit"}\n')
            proc.stdin.flush()
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=20)
        except Exception:
            proc.kill()
        for handle in (proc.stdout, proc.stderr, proc.stdin):
            try:
                handle.close()
            except Exception:
                pass

    def _read_until(self, proc, *types, limit=200):
        out = []
        for _ in range(limit):
            line = proc.stdout.readline()
            if not line:
                raise AssertionError(f'worker closed stdout before {types}: {out}'
                                     f'\nstderr: {proc.stderr.read()}')
            message = json.loads(line)
            out.append(message)
            if message['type'] in types:
                return out
        raise AssertionError(f'no {types} in {limit} messages: {out}')

    def test_the_environment_selects_the_served_engine_and_it_renders(self):
        proc = self._worker()
        ready = self._read_until(proc, 'ready')[-1]
        self.assertEqual(ready['type'], 'ready')

        proc.stdin.write(json.dumps({'action': 'load',
                                     'voice': 'deathstalker',
                                     'warm': False}) + '\n')
        proc.stdin.flush()
        msgs = self._read_until(proc, 'loaded', 'error')
        self.assertEqual(msgs[-1]['type'], 'loaded', msgs)

        proc.stdin.write(json.dumps({'action': 'generate',
                                     'text': 'Hello there, listener.'}) + '\n')
        proc.stdin.flush()
        msgs = self._read_until(proc, 'audio', 'error')
        audio = msgs[-1]
        self.assertEqual(audio['type'], 'audio', msgs)
        self.assertEqual(audio['sampleRate'], 24000)
        self.assertGreater(audio['duration'], 0)
        # The request really went through the v3 client.
        self.assertTrue(self.server.requests)
        self.assertEqual(self.server.requests[-1]['model'], 'higgs-v3')
        self.assertEqual(self.server.requests[-1]['response_format'], 'wav')


class ServerIdentityTest(V3TestCase):
    """`/health` says something is listening. It does not say WHAT."""

    def test_adoption_requires_the_right_served_model(self):
        """A leftover server from another model on port 8095 would otherwise be
        adopted silently and render a whole book in the wrong voice."""
        self.server.httpd.models = ['some-other-model']
        backend = HiggsV3ServedBackend(base_url=self.server.base_url,
                                       serve_script='/campaign/serve_v3.sh')
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.start()
        message = str(caught.exception)
        self.assertIn('some-other-model', message)
        self.assertIn('higgs-v3', message)

    def test_adoption_accepts_our_own_server(self):
        backend = HiggsV3ServedBackend(base_url=self.server.base_url,
                                       serve_script='/campaign/serve_v3.sh')
        backend.start()                      # adopts, does not launch
        self.assertIsNone(backend._proc)

    def test_a_configured_adapter_must_actually_be_served(self):
        """An adapter is a LAUNCH argument; a running server cannot pick one
        up, so a server without it renders the BASE voice."""
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.check_serves_expected_model(adapter='/models/ds-lora')
        message = str(caught.exception)
        self.assertIn('ds-lora', message)
        self.assertIn('--lora-modules', message)

    def test_an_adapter_that_is_served_passes(self):
        self.server.httpd.models = ['higgs-v3', 'ds-lora']
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        backend.check_serves_expected_model(adapter='/models/ds-lora')

    def test_a_port_that_answers_health_but_not_models_is_refused(self):
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        self.server.httpd.models_broken = True
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.check_serves_expected_model()
        self.assertIn('cannot be identified', str(caught.exception))


class TailTrimProbeTest(V3TestCase):
    """The patch that fails SILENTLY. See probe_tail_trim's docstring."""

    def test_a_patched_server_passes(self):
        """Our smoke measured -62.4 dBFS over the last 300 ms; the fake's
        silence-tailed wav is quieter still."""
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        dbfs = backend.probe_tail_trim(self.voice())
        self.assertLess(dbfs, v3_served.HiggsV3ServedBackend.TAIL_TRIM_MAX_DBFS)

    def test_an_unpatched_server_is_refused_by_name(self):
        """Reproduce the defect's signature: ~250 ms of the ramp-down sentinels
        decoded as real sound at about -30 dB on the end of the clip."""
        self.server.httpd.tail_burst_dbfs = -30.0
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.probe_tail_trim(self.voice())
        message = str(caught.exception)
        self.assertIn('tail-trim probe FAILED', message)
        self.assertIn('patch_tail_trim.py', message)

    def test_the_gate_sits_between_the_two_measured_states(self):
        gate = v3_served.HiggsV3ServedBackend.TAIL_TRIM_MAX_DBFS
        self.assertLess(-62.4, gate, 'a patched server must pass')
        self.assertLess(gate, -31.0, 'an unpatched server must fail')

    def test_the_engine_runs_the_probe_at_load(self):
        engine = HiggsV3Engine(self.config())
        self.addCleanup(engine.cleanup)
        bodies = [r for r in self.server.requests
                  if r['input'] == v3_served.HiggsV3ServedBackend.TAIL_TRIM_PROBE_TEXT]
        self.assertEqual(len(bodies), 1, 'exactly one probe render per load')

    def test_the_probe_can_be_turned_off(self):
        engine = HiggsV3Engine(self.config(probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        self.assertEqual(self.server.requests, [])


class FailedLoadReleasesTheServerTest(V3TestCase):
    """A ~14 GB vllm-omni left running is a GPU nobody can name."""

    def test_a_ready_timeout_stops_the_server_it_started(self):
        server = FakeV3Server(healthy=False)
        self.addCleanup(server.close)
        stopped = []

        real_stop = HiggsV3ServedBackend.stop
        HiggsV3ServedBackend.stop = lambda self, *a, **k: stopped.append(True)
        try:
            with self.assertRaises(HiggsV3ServerError):
                HiggsV3Engine(self.config(base_url=server.base_url,
                                          ready_timeout=2))
        finally:
            HiggsV3ServedBackend.stop = real_stop
        self.assertTrue(stopped, 'a failed load must stop the server it started')

    def test_a_failed_probe_also_stops_it(self):
        self.server.httpd.tail_burst_dbfs = -30.0
        stopped = []
        real_stop = HiggsV3ServedBackend.stop
        HiggsV3ServedBackend.stop = lambda self, *a, **k: stopped.append(True)
        try:
            with self.assertRaises(HiggsV3ServerError):
                HiggsV3Engine(self.config())
        finally:
            HiggsV3ServedBackend.stop = real_stop
        self.assertTrue(stopped)

    def test_the_default_patience_covers_the_measured_cold_starts(self):
        """55 / 146 / 297 s measured on this box; 300 would have been a coin
        flip on the slowest of them."""
        self.assertGreaterEqual(HiggsV3Defaults.READY_TIMEOUT_SECONDS, 900.0)


class ResponseRefusalTest(V3TestCase):

    def test_a_non_wav_200_is_refused_by_name(self):
        """The shape a proxy or an error page produces. soundfile's own message
        ("Format not recognised") names nothing a reader can act on."""
        with self.assertRaises(HiggsV3ServerError) as caught:
            v3_served.decode_response(b'{"detail":"nope"}', 'application/json')
        message = str(caught.exception)
        self.assertIn('expected a WAV body', message)
        self.assertIn('application/json', message)
        self.assertIn('decode_response', message)

    def test_the_minus_100_error_names_the_missing_vllm_patch(self):
        """Without patch_vllm.py EVERY cloned request fails this way, and only
        an UN-cloned one succeeds - which is the model's own voice at 12 % of
        the narrator ceiling."""
        self.server.fail_with(400, 'Token id -100 is out of vocabulary')
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.speak(SpeechRequest(text='Hello.', voice=self.voice(),
                                        max_new_tokens=200))
        message = str(caught.exception)
        self.assertIn('patch_vllm.py', message)
        self.assertIn('THE vLLM PATCH IS MISSING', message)


class VoiceTuningTest(V3TestCase):
    """maxChars is per VOICE, and v3 voices carry v3's rules."""

    def _voices_file(self, document):
        path = os.path.join(self.dir, 'voices.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        return path

    def test_a_voice_gets_v3s_control_allowlist_and_reference_cap(self):
        """Read with the v2 scaffold's defaults a voice carries an EMPTY
        allowlist, which would reject <|prosody:long_pause|> that the model
        understands perfectly."""
        from narrator.engine.higgs.config import load_voice
        path = self._voices_file({'ds': {'clips': [
            {'path': self.clip, 'transcript': X2_TEXT, 'seconds': 27.42}]}})
        voice = load_voice('ds', path,
                           allowed_controls=HiggsV3Defaults.ALLOWED_CONTROLS,
                           max_reference_seconds=HiggsV3Defaults.MAX_REFERENCE_SECONDS,
                           placeholder_max_chars=HiggsV3Defaults.MAX_CHARS)
        self.assertEqual(len(voice.allowed_controls), 45)
        self.assertIn('<|prosody:long_pause|>', voice.allowed_controls)
        self.assertEqual(voice.max_reference_seconds, 30.0)
        self.assertEqual(voice.max_chars, 600)
        self.assertEqual(voice.max_chars_source, 'placeholder')

    def test_the_config_stamps_v3s_rules_on_a_hand_built_voice(self):
        bare = ClipsVoice(clips=(ReferenceClip(self.clip, X2_TEXT, seconds=14.0),),
                          name='ds')
        self.assertEqual(bare.allowed_controls, ())
        config = HiggsV3Config(voice=bare, base_url=self.server.base_url)
        self.assertEqual(len(config.voice.allowed_controls), 45)
        self.assertEqual(config.voice.max_reference_seconds, 30.0)

    def test_a_declared_maxChars_wins(self):
        from narrator.engine.higgs.config import load_voice
        path = self._voices_file({'ds': {'maxChars': 420, 'clips': [
            {'path': self.clip, 'transcript': X2_TEXT, 'seconds': 27.42}]}})
        voice = load_voice('ds', path, placeholder_max_chars=600)
        self.assertEqual(voice.max_chars, 420)
        self.assertEqual(voice.max_chars_source, 'catalog')
        budget = HiggsV3Budget(HiggsV3Config(voice=voice,
                                             base_url=self.server.base_url))
        self.assertEqual(budget.max_chars(), 420)
        self.assertEqual(budget.max_chars_source(), 'catalog')

    def test_an_adapter_voice_without_maxChars_is_refused_at_load(self):
        """A fine-tune's safe chunk length is a measured property of THAT
        model; the base placeholder is not it."""
        from narrator.engine.higgs.config import load_voices
        path = self._voices_file({'ds-ft': {
            'adapterDir': '/models/ds-lora',
            'clips': [{'path': self.clip, 'transcript': X2_TEXT,
                       'seconds': 27.42}]}})
        with self.assertRaises(ValueError) as caught:
            load_voices(path, placeholder_max_chars=600)
        message = str(caught.exception)
        self.assertIn('maxChars', message)
        self.assertIn('refusing to guess', message.lower())

    def test_an_adapter_voice_with_maxChars_loads(self):
        from narrator.engine.higgs.config import load_voice
        path = self._voices_file({'ds-ft': {
            'adapterDir': '/models/ds-lora', 'maxChars': 500,
            'clips': [{'path': self.clip, 'transcript': X2_TEXT,
                       'seconds': 27.42}]}})
        voice = load_voice('ds-ft', path, placeholder_max_chars=600)
        self.assertEqual(voice.max_chars, 500)
        self.assertEqual(voice.adapter_dir, '/models/ds-lora')

    def test_the_budget_refuses_an_adapter_voice_assembled_in_code(self):
        bare = ClipsVoice(clips=(ReferenceClip(self.clip, X2_TEXT, seconds=14.0),),
                          name='ds-ft', adapter_dir='/models/ds-lora')
        budget = HiggsV3Budget(HiggsV3Config(voice=bare,
                                             base_url=self.server.base_url,
                                             adapter_strategy='merged-dir',
                                             adapter_dir='/models/ds-lora'))
        with self.assertRaises(ValueError) as caught:
            budget.max_chars()
        self.assertIn('maxChars', str(caught.exception))


class SeedRuleTest(V3TestCase):

    def test_chunk_i_renders_with_seed_plus_i(self):
        """Rendering every sentence at a flat seed makes a whole book of
        identical draws for identical text."""
        engine = HiggsV3Engine(self.config(probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        engine.generate_batch_stream(['One.', 'Two.', 'Three.'], None, None, None,
                                     lambda i, pcm: None)
        seeds = [r['seed'] for r in self.server.requests]
        self.assertEqual(seeds, [1234, 1235, 1236])

    def test_convert_seeds_by_sentence_number(self):
        engine = HiggsV3Engine(self.config(probe_tail_trim=False,
                                           sentences_dir=self.dir))
        self.addCleanup(engine.cleanup)
        engine.convert(7, 'Hello.')
        self.assertEqual(self.server.requests[-1]['seed'], 1241)

    def test_a_seed_in_extra_params_is_refused(self):
        """One place carries the seed: the top-level field. vllm-omni copies
        extra_params onto the stage-0 params, so a seed in both is two sources
        for one number and nothing says which wins."""
        with self.assertRaises(ValueError) as caught:
            v3_served.build_request_body('Hi.', self.voice(), 200, seed=1,
                                         sampling={'seed': 9})
        self.assertIn('TOP-LEVEL', str(caught.exception))


class WindowsLaunchTest(unittest.TestCase):
    """The Windows arm is unexercised on this box's normal path - the smoke ran
    the launcher from INSIDE WSL. These pin the two things that would go wrong
    there: the command that gets built, and stop() giving up on a guest process
    that outlives wsl.exe."""

    def setUp(self):
        import shutil as _shutil
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='narrator-H-win-')
        self.addCleanup(_shutil.rmtree, self.dir, True)
        # A fake wsl.exe, first on PATH, so shutil.which finds it.
        self.fake_wsl = os.path.join(self.dir, 'wsl.exe')
        with open(self.fake_wsl, 'w', encoding='utf-8') as handle:
            handle.write('')
        self._path = os.environ.get('PATH', '')
        os.environ['PATH'] = self.dir + os.pathsep + self._path
        self.addCleanup(os.environ.__setitem__, 'PATH', self._path)

    def _as_windows(self):
        from unittest import mock
        patcher = mock.patch.object(v3_served.sys, 'platform', 'win32')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_launch_command_goes_through_wsl_with_a_pid_wrapper(self):
        self._as_windows()
        backend = HiggsV3ServedBackend(
            serve_script=r'C:\campaign\serve_v3.sh', wsl_distro='Ubuntu')
        command = backend.launch_command()
        self.assertEqual(command[:4],
                         [self.fake_wsl, '-d', 'Ubuntu', 'bash'])
        self.assertEqual(command[4], '-c')
        wrapper = command[5]
        self.assertIn('/mnt/c/campaign/serve_v3.sh', wrapper,
                      'the Windows path must be translated for the guest')
        self.assertIn('echo $!', wrapper,
                      "serve_v3.sh execs vllm-omni, so $! IS the server's pid")
        self.assertIn(backend.pid_file(), wrapper)
        self.assertIn('wait $!', wrapper,
                      'the launcher must live as long as the server')

    def test_a_script_inside_the_distro_is_not_mangled(self):
        self._as_windows()
        backend = HiggsV3ServedBackend(
            serve_script=r'\\wsl$\Ubuntu\home\telltale\serve_v3.sh')
        self.assertIn('/home/telltale/serve_v3.sh', backend.launch_command()[5])

    def test_stop_signals_the_guest_pid_when_the_server_outlives_wsl_exe(self):
        """Terminating wsl.exe kills the Windows-side relay; the guest process
        can keep running and holding ~14 GB, while proc.poll() reports a tidy
        exit."""
        self._as_windows()
        server = FakeV3Server()
        self.addCleanup(server.close)
        backend = HiggsV3ServedBackend(base_url=server.base_url,
                                       serve_script=r'C:\campaign\serve_v3.sh')
        backend._guest_pid = 4242
        calls = []
        real_run = v3_served.subprocess.run
        v3_served.subprocess.run = lambda argv, **kw: calls.append(argv)
        try:
            # The port keeps answering, so stop() must escalate to the guest.
            backend._verify_gone(timeout=2)
        finally:
            v3_served.subprocess.run = real_run
        self.assertTrue(calls, 'stop() must escalate to a guest-side signal')
        self.assertEqual(calls[0][:3], [self.fake_wsl, '-d', 'Ubuntu'])
        self.assertIn('4242', calls[0])
        self.assertIn('kill', calls[0])

    def test_it_never_kills_a_server_it_did_not_launch(self):
        self._as_windows()
        server = FakeV3Server()
        self.addCleanup(server.close)
        backend = HiggsV3ServedBackend(base_url=server.base_url)
        calls = []
        real_run = v3_served.subprocess.run
        v3_served.subprocess.run = lambda argv, **kw: calls.append(argv)
        try:
            backend._verify_gone(timeout=2)
        finally:
            v3_served.subprocess.run = real_run
        self.assertEqual(calls, [],
                         'no recorded guest pid means it is not ours to kill')


class SetVoiceTest(V3TestCase):

    def test_a_second_load_for_another_voice_is_refused_by_name(self):
        engine = HiggsV3Engine(self.config(probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        with self.assertRaises(ValueError) as caught:
            engine.set_voice('someone_else')
        message = str(caught.exception)
        self.assertIn('someone_else', message)
        self.assertIn('needs a NEW server', message)

    def test_reloading_the_same_voice_is_a_no_op(self):
        engine = HiggsV3Engine(self.config(probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        engine.set_voice(engine.voice)

    def test_orpheus_caps_on_a_v3_load_are_refused(self):
        engine = HiggsV3Engine(self.config(probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        engine._apply_voice_caps('deathstalker', {})     # the pool's reset: a no-op
        with self.assertRaises(ValueError):
            engine._apply_voice_caps('deathstalker', {'eosBoost': 8})


if __name__ == '__main__':
    unittest.main()
