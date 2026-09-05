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
    # SPEECH, THEN THE SERVER'S OWN TRIMMED SILENCE - which is the shape a
    # PATCHED server returns: our smoke's real clip measured -62 dBFS over its
    # last 300 ms, i.e. the words had already ended. The probe reads exactly
    # that window, so the fake has to have one.
    tail_frames = int(rate * 0.32)
    speech_frames = max(1, int(rate * seconds) - tail_frames)
    speech = (np.sin(2 * np.pi * 220.0 * np.arange(speech_frames) / rate)
              * 0.4 * 32767)
    # A -70 dBFS floor, not digital zero: real decoded audio has one, and a
    # probe that only passes on absolute silence would be untested against it.
    floor_amp = (10 ** (-70.0 / 20.0)) * 32767 * np.sqrt(2)
    tail = (np.sin(2 * np.pi * 60.0 * np.arange(tail_frames) / rate) * floor_amp)
    data = np.concatenate([speech, tail])
    if tail_burst_dbfs is not None:
        # An UNPATCHED server: ~250 ms of ramp-down sentinels decoded as real
        # sound at about -30 dB, cut off at its peak.
        burst = min(data.size, int(rate * 0.25))
        amp = (10 ** (tail_burst_dbfs / 20.0)) * 32767 * np.sqrt(2)
        data[-burst:] = (np.sin(2 * np.pi * 90.0 * np.arange(burst) / rate) * amp)
    frames = data.size
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


class CheckpointVoiceTest(V3TestCase):
    """A fine-tuned Higgs voice is a MERGED CHECKPOINT, and one server serves
    exactly one of them.

    Measured by the training side, 2026-09-04: vllm-omni exposes no adapter
    flags and its higgs_audio_v3 talker does not implement `SupportsLoRA`, so a
    LoRA cannot be loaded at runtime and there is no per-request adapter either.
    The `lora-modules` strategy this module used to express is retired.
    """

    def test_the_only_strategy_is_checkpoint(self):
        self.assertEqual(v3_served.check_strategy('checkpoint'), 'checkpoint')

    def test_lora_modules_is_refused_and_says_why(self):
        with self.assertRaises(ValueError) as caught:
            v3_served.check_strategy('lora-modules')
        message = str(caught.exception)
        self.assertIn('SupportsLoRA', message)
        self.assertIn('merged', message.lower())
        self.assertIn('checkpoint', message)

    def test_the_old_merged_dir_name_is_refused_too(self):
        with self.assertRaises(ValueError) as caught:
            v3_served.check_strategy('merged-dir')
        self.assertIn('checkpoint', str(caught.exception))

    def test_an_unknown_strategy_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            v3_served.check_strategy('per-request')
        self.assertIn('per-request', str(caught.exception))

    def test_the_serve_target_is_the_checkpoint_itself(self):
        """No extra launch arguments: there is no adapter to name."""
        self.assertEqual(v3_served.checkpoint_serve_target('/models/ds-merged'),
                         '/models/ds-merged')
        with self.assertRaises(ValueError) as caught:
            v3_served.checkpoint_serve_target('')
        self.assertIn('checkpointDir', str(caught.exception))

    def test_a_load_message_adapterDir_is_refused_at_that_boundary_too(self):
        """The pool's field is called `adapterDir`, and a LoRA directory can
        arrive on it. Taking it as a merged checkpoint would hand
        `vllm-omni serve` a directory it cannot load - the server would come up
        on garbage or on the base model. `load_voices` refuses the same key at
        the document boundary; this is the other end.
        """
        from narrator.engine.higgs import higgs_v3_config_from_worker_kwargs
        with self.assertRaises(ValueError) as caught:
            higgs_v3_config_from_worker_kwargs(voice='deathstalker',
                                               adapter_dir='/models/ds-lora')
        message = str(caught.exception)
        self.assertIn('adapterDir', message)
        self.assertIn('checkpointDir', message)
        self.assertIn('no runtime LoRA', message)

    def test_a_checkpoint_voice_carries_its_directory_into_the_config(self):
        from narrator.engine.protocol import DefaultVoice
        voice = DefaultVoice(name='ds-ft', checkpoint_dir='/models/ds-merged',
                             max_chars=500, max_chars_source='length-sweep')
        config = HiggsV3Config(voice=voice, base_url=self.server.base_url)
        self.assertEqual(config.checkpoint_dir, '/models/ds-merged')

    def test_a_voice_and_a_config_that_disagree_are_refused(self):
        from narrator.engine.protocol import DefaultVoice
        voice = DefaultVoice(name='ds-ft', checkpoint_dir='/models/a',
                             max_chars=500, max_chars_source='catalog')
        with self.assertRaises(ValueError) as caught:
            HiggsV3Config(voice=voice, base_url=self.server.base_url,
                          checkpoint_dir='/models/b')
        self.assertIn('One server runs on one checkpoint', str(caught.exception))

    def test_a_server_on_another_checkpoint_is_refused(self):
        """The failure this prevents is silent: a leftover server for ANOTHER
        voice answers /health and /v1/models identically."""
        backend = HiggsV3ServedBackend(base_url=self.server.base_url,
                                       checkpoint_dir='/models/ours')
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.check_serves_expected_model(checkpoint_dir='/models/theirs')
        message = str(caught.exception)
        self.assertIn('/models/ours', message)
        self.assertIn('/models/theirs', message)
        self.assertIn('RESTARTING', message)

    def test_a_matching_checkpoint_passes(self):
        backend = HiggsV3ServedBackend(base_url=self.server.base_url,
                                       checkpoint_dir='/models/ours')
        backend.check_serves_expected_model(checkpoint_dir='/models/ours')

    def test_an_unstated_checkpoint_is_refused_naming_the_variable(self):
        """It cannot be discovered - /v1/models reports the served NAME and
        serve_v3.sh execs a hard-coded snapshot - so it has to be stated."""
        previous = os.environ.pop(v3_served.CHECKPOINT_ENV, None)
        if previous is not None:
            self.addCleanup(os.environ.__setitem__,
                            v3_served.CHECKPOINT_ENV, previous)
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        with self.assertRaises(HiggsV3ServerError) as caught:
            backend.check_serves_expected_model(checkpoint_dir='/models/ours')
        self.assertIn(v3_served.CHECKPOINT_ENV, str(caught.exception))

    def test_the_environment_can_state_it(self):
        os.environ[v3_served.CHECKPOINT_ENV] = '/models/ours'
        self.addCleanup(os.environ.pop, v3_served.CHECKPOINT_ENV, None)
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        self.assertEqual(backend.running_checkpoint(), '/models/ours')
        backend.check_serves_expected_model(checkpoint_dir='/models/ours')

    def test_a_voice_change_on_a_live_engine_names_the_restart(self):
        from narrator.engine.protocol import DefaultVoice
        os.environ[v3_served.CHECKPOINT_ENV] = '/models/ds-merged'
        self.addCleanup(os.environ.pop, v3_served.CHECKPOINT_ENV, None)
        voice = DefaultVoice(name='ds-ft', checkpoint_dir='/models/ds-merged',
                             max_chars=500, max_chars_source='catalog')
        engine = HiggsV3Engine(HiggsV3Config(voice=voice,
                                             base_url=self.server.base_url,
                                             probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        with self.assertRaises(ValueError) as caught:
            engine.set_voice('another-voice')
        message = str(caught.exception)
        self.assertIn('SupportsLoRA', message)
        self.assertIn('merged checkpoint', message)

    def test_a_checkpoint_voice_renders_text_only(self):
        """THE PRODUCTION PATH: no `references` key at all."""
        from narrator.engine.protocol import DefaultVoice
        os.environ[v3_served.CHECKPOINT_ENV] = '/models/ds-merged'
        self.addCleanup(os.environ.pop, v3_served.CHECKPOINT_ENV, None)
        voice = DefaultVoice(name='ds-ft', checkpoint_dir='/models/ds-merged',
                             max_chars=500, max_chars_source='catalog')
        engine = HiggsV3Engine(HiggsV3Config(voice=voice,
                                             base_url=self.server.base_url,
                                             probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        engine.render_audio('It was a Saturday morning.')
        self.assertNotIn('references', self.server.requests[-1])


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
        self.assertGreater(float(np.max(np.abs(audio[:4000]))), 0.1,
                           'the fake must carry real signal, not just a floor')

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
        self.assertEqual(engine.edge_fade.as_manifest(),
                         {'in': 10.0, 'out': 25.0})
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
        """One id, TWO backends, chosen by platform (PORT_NOTES 13).

        On darwin `higgs-v3` is the IN-PROCESS MLX engine - mlx-audio runs the
        whole model natively on Apple Silicon, so there is no server. Everywhere
        else it is this served one. Both carry ENGINE_ID 'higgs-v3' and the same
        geometry, budget and stop policy; only where the weights run differs.
        """
        from narrator.engine.higgs import HiggsV3MlxEngine
        expected = (HiggsV3MlxEngine if sys.platform.startswith('darwin')
                    else HiggsV3Engine)
        self.assertIs(registry.engine_class('higgs-v3'), expected)

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
                # readline() blocks, so EOF means the process ENDED - never a
                # slow start. Its stderr is the only thing that says why.
                try:
                    proc.wait(timeout=60)
                except Exception:
                    pass
                raise AssertionError(
                    f'worker exited {proc.returncode} before {types}.\n'
                    f'messages so far: {out}\n'
                    f'--- stderr ---\n{(proc.stderr.read() or "").strip()}')
            message = json.loads(line)
            out.append(message)
            if message['type'] in types:
                return out
        raise AssertionError(f'no {types} in {limit} messages: {out}')

    @unittest.skipIf(
        sys.platform.startswith('darwin'),
        'this drives the SERVED v3 engine through the worker, and on '
        "darwin 'higgs-v3' resolves to the in-process MLX engine instead "
        '(there is no server to fake). The Mac equivalents are '
        'tests/test_higgs_mlx.py and the live `python -m narrator.serve` '
        'smoke recorded in PORT_NOTES 13.6.')
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

    def test_a_base_voice_needs_no_checkpoint_check(self):
        """No checkpoint configured = the base model; `/v1/models` naming
        higgs-v3 is the whole check."""
        backend = HiggsV3ServedBackend(base_url=self.server.base_url)
        backend.check_serves_expected_model()

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

    def test_a_checkpoint_voice_without_maxChars_is_refused_at_load(self):
        """A fine-tune's safe chunk length is a measured property of THAT
        model; the base placeholder is not it."""
        from narrator.engine.higgs.config import load_voices
        path = self._voices_file({'ds-ft': {
            'kind': 'checkpoint', 'checkpointDir': '/models/ds-merged',
            'clips': [{'path': self.clip, 'transcript': X2_TEXT,
                       'seconds': 27.42}]}})
        with self.assertRaises(ValueError) as caught:
            load_voices(path, placeholder_max_chars=600)
        message = str(caught.exception)
        self.assertIn('maxChars', message)
        self.assertIn('refusing to guess', message.lower())

    def test_a_checkpoint_voice_with_maxChars_loads(self):
        from narrator.engine.higgs.config import load_voice
        path = self._voices_file({'ds-ft': {
            'kind': 'checkpoint', 'checkpointDir': '/models/ds-merged',
            'maxChars': 500,
            'clips': [{'path': self.clip, 'transcript': X2_TEXT,
                       'seconds': 27.42}]}})
        voice = load_voice('ds-ft', path, placeholder_max_chars=600)
        self.assertEqual(voice.max_chars, 500)
        self.assertEqual(voice.checkpoint_dir, '/models/ds-merged')

    def test_the_budget_refuses_a_checkpoint_voice_assembled_in_code(self):
        bare = ClipsVoice(clips=(ReferenceClip(self.clip, X2_TEXT, seconds=14.0),),
                          name='ds-ft', checkpoint_dir='/models/ds-merged')
        budget = HiggsV3Budget(HiggsV3Config(voice=bare,
                                             base_url=self.server.base_url))
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


class _LaunchTestBase(unittest.TestCase):
    """Shared fixture for the two platform arms of the launch/stop path."""

    def setUp(self):
        import shutil as _shutil
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='narrator-H-launch-')
        self.addCleanup(_shutil.rmtree, self.dir, True)
        self.fake_wsl = os.path.join(self.dir, 'wsl.exe')
        with open(self.fake_wsl, 'w', encoding='utf-8') as handle:
            handle.write('')
        os.chmod(self.fake_wsl, 0o755)       # shutil.which needs it on POSIX
        self._path = os.environ.get('PATH', '')
        os.environ['PATH'] = self.dir + os.pathsep + self._path
        self.addCleanup(os.environ.__setitem__, 'PATH', self._path)

    def assert_wrapper(self, wrapper, backend, script_in_guest):
        self.assertIn(script_in_guest, wrapper,
                      'the script path must be the one the GUEST sees')
        self.assertIn('echo $!', wrapper,
                      "serve_v3.sh execs vllm-omni, so $! IS the server's pid")
        self.assertIn(backend.pid_file(), wrapper)
        self.assertIn('wait $!', wrapper,
                      'the launcher must live as long as the server')


@unittest.skipUnless(sys.platform == 'win32', 'the Windows launch arm')
class WindowsLaunchTest(_LaunchTestBase):
    """The Windows arm: `wsl.exe -d <distro> bash -c <wrapper>`.

    NOT monkeypatched onto another platform. `shutil.which`, path translation
    and process termination all behave differently per OS, and a test that
    pretends otherwise proves nothing about either. The POSIX arm has its own
    twin below, so both are covered on the machine that can actually run them.
    """

    def test_the_launch_command_goes_through_wsl_with_a_pid_wrapper(self):
        backend = HiggsV3ServedBackend(
            serve_script=r'C:\campaign\serve_v3.sh', wsl_distro='Ubuntu')
        command = backend.launch_command()
        self.assertTrue(command[0].endswith('wsl.exe'), command)
        self.assertEqual(command[1:5], ['-d', 'Ubuntu', 'bash', '-c'])
        self.assert_wrapper(command[5], backend, '/mnt/c/campaign/serve_v3.sh')

    def test_a_script_inside_the_distro_is_not_mangled(self):
        backend = HiggsV3ServedBackend(
            serve_script=r'\\wsl$\Ubuntu\home\telltale\serve_v3.sh')
        self.assertIn('/home/telltale/serve_v3.sh', backend.launch_command()[5])

    def test_stop_signals_the_guest_pid_when_the_server_outlives_wsl_exe(self):
        """Terminating wsl.exe kills the Windows-side relay; the guest process
        can keep running and holding ~14 GB, while proc.poll() reports a tidy
        exit."""
        server = FakeV3Server()
        self.addCleanup(server.close)
        backend = HiggsV3ServedBackend(base_url=server.base_url,
                                       serve_script=r'C:\campaign\serve_v3.sh')
        backend._guest_pid = 4242
        calls = []
        real_run = v3_served.subprocess.run
        v3_served.subprocess.run = lambda argv, **kw: calls.append(argv)
        try:
            backend._verify_gone(timeout=2)
        finally:
            v3_served.subprocess.run = real_run
        self.assertTrue(calls, 'stop() must escalate to a guest-side signal')
        self.assertTrue(calls[0][0].endswith('wsl.exe'), calls[0])
        self.assertEqual(calls[0][1:3], ['-d', 'Ubuntu'])
        self.assertIn('4242', calls[0])
        self.assertIn('kill', calls[0])


@unittest.skipIf(sys.platform == 'win32', 'the POSIX launch arm')
class PosixLaunchTest(_LaunchTestBase):
    """The POSIX arm (Linux/WSL/macOS): `bash -c <wrapper>`, no wsl.exe.

    The same two assertions as the Windows arm - the wrapper records the
    server's own pid, and stop() escalates to that pid rather than to a pkill
    pattern that would take another agent's server with it.
    """

    def test_the_launch_command_is_a_plain_bash_wrapper(self):
        backend = HiggsV3ServedBackend(serve_script='/campaign/serve_v3.sh')
        command = backend.launch_command()
        self.assertEqual(command[:2], ['bash', '-c'])
        self.assert_wrapper(command[2], backend, '/campaign/serve_v3.sh')

    def test_a_posix_path_is_passed_through_untouched(self):
        backend = HiggsV3ServedBackend(serve_script='/home/t/serve_v3.sh')
        self.assertIn('/home/t/serve_v3.sh', backend.launch_command()[2])

    def test_stop_signals_the_pid_directly(self):
        server = FakeV3Server()
        self.addCleanup(server.close)
        backend = HiggsV3ServedBackend(base_url=server.base_url,
                                       serve_script='/campaign/serve_v3.sh')
        backend._guest_pid = 4242
        signalled = []
        real_kill = v3_served.os.kill
        v3_served.os.kill = lambda pid, sig: signalled.append((pid, sig))
        try:
            backend._verify_gone(timeout=2)
        finally:
            v3_served.os.kill = real_kill
        self.assertTrue(signalled, 'stop() must escalate to the server pid')
        self.assertEqual(signalled[0][0], 4242)

    def test_it_never_kills_a_server_it_did_not_launch(self):
        server = FakeV3Server()
        self.addCleanup(server.close)
        backend = HiggsV3ServedBackend(base_url=server.base_url)
        signalled = []
        real_kill = v3_served.os.kill
        v3_served.os.kill = lambda pid, sig: signalled.append(pid)
        try:
            backend._verify_gone(timeout=2)
        finally:
            v3_served.os.kill = real_kill
        self.assertEqual(signalled, [],
                         'no recorded pid means it is not ours to kill')


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


class WorkerRefusalTest(unittest.TestCase):
    """Things `python -m narrator.serve` must refuse rather than half-do."""

    def _run(self, extra_env, argv=()):
        import subprocess
        env = dict(os.environ)
        env.update({'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8'})
        env.update(extra_env)
        env.pop('NARRATOR_GOLDEN_LOCAL', None)
        return subprocess.run(
            [sys.executable, '-m', 'narrator.serve', *argv], cwd=_PYTHON_ROOT,
            input='{"action": "quit"}\n', capture_output=True, text=True,
            encoding='utf-8', env=env, timeout=180)

    def test_the_not_shipped_scaffold_is_refused_without_a_handshake(self):
        """`higgs-v2-scaffold` is interface scaffolding, not a rendering engine.
        A spawn that selects it must not get a worker that looks alive."""
        out = self._run({'NARRATOR_ENGINE': 'higgs-v2-scaffold'},
                        argv=('--fake-engine',))
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn('"type": "ready"', out.stdout)
        self.assertIn('scaffold', out.stderr)
        self.assertIn('higgs-v3', out.stderr)

    def test_an_unknown_engine_is_refused_without_a_handshake(self):
        out = self._run({'NARRATOR_ENGINE': 'llasa'}, argv=('--fake-engine',))
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn('"type": "ready"', out.stdout)
        self.assertIn('llasa', out.stderr)

    def test_a_backend_that_cannot_be_detected_never_prints_ready(self):
        """THE MAC FAILURE (2026-09-04), forced IN PROCESS.

        A swallowed ImportError printed {"type":"ready","device":"mlx"} with no
        backend; the pool saw a healthy handshake and every generate answered
        'Model not loaded' forever. An engine that cannot be IMPORTED is a dead
        worker and must say so with an exit code.

        Driven by patching `worker._engine_class` to raise the ImportError a
        broken env raises - which is exactly what the reviewer did by hand.
        NOT through an env hook: production code carries no test switches, and a
        subprocess arm could only assert "whatever happened, happened", which is
        what this test used to do.
        """
        import contextlib
        import io as _io
        from narrator.serve import worker as W

        real = W._engine_class

        def broken():
            raise ImportError("No module named 'torch'", name='torch')

        W._engine_class = broken
        stdout, stderr = _io.StringIO(), _io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout), \
                    contextlib.redirect_stderr(stderr):
                code = W.main([])
        finally:
            W._engine_class = real

        self.assertEqual(code, 3, 'a worker that cannot render must exit 3')
        self.assertEqual(stdout.getvalue(), '',
                         'NOTHING on stdout - not even a ready line; stdout is '
                         'the protocol and the pool would read a handshake')
        self.assertIn('FATAL', stderr.getvalue())
        self.assertIn('torch', stderr.getvalue(),
                      'the reason has to reach the operator')
        self.assertIn('no engine can load in this process', stderr.getvalue())

    def test_the_unservable_arm_also_exits_without_a_handshake(self):
        """The same guarantee through a REAL subprocess, on the arm that can be
        triggered from outside: an engine id the worker refuses to serve."""
        out = self._run({'NARRATOR_ENGINE': 'higgs-v2-scaffold'})
        self.assertEqual(out.returncode, 3)
        self.assertEqual(out.stdout.strip(), '')
        self.assertIn('FATAL', out.stderr)

    def test_a_fatal_startup_exits_three_and_explains(self):
        out = self._run({'NARRATOR_ENGINE': 'higgs-v2-scaffold'})
        self.assertEqual(out.returncode, 3)
        self.assertIn('no engine can load in this process', out.stderr)


class LoadedMessageTest(V3TestCase):
    """The `loaded` line has to carry what an ASSEMBLER will need."""

    def setUp(self):
        super().setUp()
        self.voices_path = os.path.join(self.dir, 'voices.json')
        with open(self.voices_path, 'w', encoding='utf-8') as handle:
            json.dump({'deathstalker': {'clips': [
                {'path': self.clip, 'transcript': X2_TEXT, 'seconds': 27.42}]}},
                handle)

    @unittest.skipIf(
        sys.platform.startswith('darwin'),
        'this drives the SERVED v3 engine through the worker, and on '
        "darwin 'higgs-v3' resolves to the in-process MLX engine instead "
        '(there is no server to fake). The Mac equivalents are '
        'tests/test_higgs_mlx.py and the live `python -m narrator.serve` '
        'smoke recorded in PORT_NOTES 13.6.')
    def test_it_carries_engine_samplerate_pads_and_the_asymmetric_fade(self):
        import subprocess
        env = dict(os.environ)
        env.update({
            'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8',
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
        self.addCleanup(proc.kill)
        try:
            ready = proc.stdout.readline()
            if not ready:
                try:
                    proc.wait(timeout=60)
                except Exception:
                    pass
                self.fail(f'worker exited {proc.returncode} before its handshake.'
                          f'\n--- stderr ---\n{(proc.stderr.read() or "").strip()}')
            self.assertEqual(json.loads(ready)['type'], 'ready')
            proc.stdin.write(json.dumps({'action': 'load',
                                         'voice': 'deathstalker',
                                         'warm': False}) + '\n')
            proc.stdin.flush()
            for _ in range(50):
                line = proc.stdout.readline()
                if not line:
                    try:
                        proc.wait(timeout=60)
                    except Exception:
                        pass
                    self.fail(f'worker exited {proc.returncode} before its '
                              f'`loaded` line.\n--- stderr ---\n'
                              f'{(proc.stderr.read() or "").strip()}')
                message = json.loads(line)
                if message['type'] in ('loaded', 'error'):
                    break
            self.assertEqual(message['type'], 'loaded', message)
            self.assertEqual(message['engine'], 'higgs-v3')
            self.assertEqual(message['sampleRate'], 24000)
            self.assertIs(message['pads'], False)
            self.assertEqual(message['edgeFadeMs'], {'in': 10.0, 'out': 25.0})
            # The pool's existing reads still work, unchanged.
            self.assertEqual(message['voice'], 'deathstalker')
            self.assertEqual(message['backend'], 'vllm-omni')
        finally:
            try:
                proc.stdin.write('{"action": "quit"}\n')
                proc.stdin.flush()
                proc.wait(timeout=20)
            except Exception:
                pass


class PadsOnTheWireTest(unittest.TestCase):
    """finalize_audio's trim is ORPHEUS behaviour; the gap is a CLIENT contract."""

    def setUp(self):
        from narrator.serve import worker as W
        self.W = W
        self.addCleanup(W.set_active_engine_audio, W.DEFAULT_SAMPLERATE, True)

    def test_a_pads_engine_is_trimmed(self):
        W = self.W
        W.set_active_engine_audio(24000, True)
        quiet = np.concatenate([np.zeros(2400, dtype=np.float32),
                                np.full(2400, 0.5, dtype=np.float32),
                                np.zeros(24000, dtype=np.float32)])
        out = W.finalize_audio(quiet)
        gap = int(24000 * W.STREAM_GAP_SEC)
        self.assertLess(out.size - gap, quiet.size,
                        "Orpheus's long trailing pause is cut back")

    def test_a_no_pads_engine_is_not_trimmed(self):
        """Higgs emits bare speech: a quiet final consonant sits under the 0.01
        threshold with no padding in front of it, so the same trim would cut
        into the word."""
        W = self.W
        W.set_active_engine_audio(24000, False)
        quiet = np.concatenate([np.zeros(2400, dtype=np.float32),
                                np.full(2400, 0.5, dtype=np.float32),
                                np.zeros(24000, dtype=np.float32)])
        out = W.finalize_audio(quiet)
        gap = int(24000 * W.STREAM_GAP_SEC)
        self.assertEqual(out.size - gap, quiet.size,
                         'nothing may be removed from a pads=False chunk')

    def test_the_gap_is_appended_for_BOTH(self):
        """DELIBERATE. `pads` says who owns the silence inside a chunk FILE for
        assembly; this is the streaming wire, where the worker is the only thing
        that can put a gap between two sentences - the player concatenates
        chunks with none of its own."""
        W = self.W
        tone = np.full(2400, 0.5, dtype=np.float32)
        gap = int(24000 * W.STREAM_GAP_SEC)
        for pads in (True, False):
            with self.subTest(pads=pads):
                W.set_active_engine_audio(24000, pads)
                self.assertEqual(W.finalize_audio(tone).size - gap, tone.size)

    def test_the_wire_rate_follows_the_loaded_engine(self):
        W = self.W
        W.set_active_engine_audio(16000, True)
        self.assertEqual(W.active_samplerate(), 16000)
        W.set_active_engine_audio(24000, True)
        self.assertEqual(W.active_samplerate(), 24000)


class VoiceDocumentShapesTest(V3TestCase):
    """THREE legitimate shapes, through the REAL loader and the REAL builder.

    The app catalog ships a `default` v3 voice - the model's own, no reference -
    and narrator used to refuse it, because it was written as a ClipsVoice with
    zero clips and ClipsVoice requires at least one. That rule is right and
    stays: a clone whose references went missing must be an error, never a
    silent downgrade. So "no reference" is its own member of the union.
    """

    def _load(self, document):
        from narrator.engine.higgs.config import load_voices
        path = os.path.join(self.dir, 'voices.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        return load_voices(
            path, allowed_controls=HiggsV3Defaults.ALLOWED_CONTROLS,
            max_reference_seconds=HiggsV3Defaults.MAX_REFERENCE_SECONDS,
            placeholder_max_chars=HiggsV3Defaults.MAX_CHARS)

    def _clip_entry(self):
        return {'path': self.clip, 'transcript': X2_TEXT, 'seconds': 27.42}

    # ---- shape 1: a zero-shot reference clone ------------------------------

    def test_a_clips_voice_sends_one_reference(self):
        voice = self._load({'ds': {'clips': [self._clip_entry()]}})['ds']
        self.assertIsInstance(voice, ClipsVoice)
        body = v3_served.build_request_body('Hello.', voice, 200)
        self.assertEqual(len(body['references']), 1)
        self.assertEqual(body['references'][0]['text'], X2_TEXT)

    # ---- shape 2: the model's own voice ------------------------------------

    def test_a_default_voice_loads_and_sends_no_references(self):
        from narrator.engine.protocol import DefaultVoice
        voice = self._load({'default': {'kind': 'default'}})['default']
        self.assertIsInstance(voice, DefaultVoice)
        self.assertEqual(voice.kind, 'default')
        self.assertEqual(voice.name, 'default')
        body = v3_served.build_request_body('Hello.', voice, 200)
        self.assertNotIn('references', body,
                         "the model's own voice takes no reference at all")
        self.assertEqual(body['input'], 'Hello.')

    def test_a_default_voice_uses_the_zero_shot_placeholder(self):
        voice = self._load({'default': {'kind': 'default'}})['default']
        self.assertEqual(voice.max_chars, HiggsV3Defaults.MAX_CHARS)
        self.assertEqual(voice.max_chars_source, 'placeholder')
        budget = HiggsV3Budget(HiggsV3Config(voice=voice,
                                             base_url=self.server.base_url))
        self.assertEqual(budget.max_chars(), 600)
        self.assertEqual(budget.max_chars_source(), 'placeholder')

    def test_the_reference_rules_do_not_apply_to_it(self):
        """No 30 s cap, no transcript - there is no reference to have either."""
        voice = self._load({'default': {'kind': 'default'}})['default']
        HiggsV3Config(voice=voice, base_url=self.server.base_url)   # no refusal

    def test_it_renders_end_to_end(self):
        voice = self._load({'default': {'kind': 'default'}})['default']
        engine = HiggsV3Engine(HiggsV3Config(voice=voice,
                                             base_url=self.server.base_url,
                                             probe_tail_trim=False))
        self.addCleanup(engine.cleanup)
        audio = engine.render_audio('It was a Saturday morning.')
        self.assertGreater(audio.size, 0)
        self.assertNotIn('references', self.server.requests[-1])

    # ---- shape 3: a fine-tune, whose weights ARE the voice -----------------

    def test_a_checkpoint_entry_needs_no_clips(self):
        from narrator.engine.protocol import DefaultVoice
        voice = self._load({'ds-ft': {'kind': 'checkpoint',
                                      'checkpointDir': '/models/ds-merged',
                                      'maxChars': 500}})['ds-ft']
        self.assertIsInstance(voice, DefaultVoice)
        self.assertEqual(voice.checkpoint_dir, '/models/ds-merged')
        self.assertEqual(voice.max_chars, 500)
        body = v3_served.build_request_body('Hello.', voice, 200)
        self.assertNotIn('references', body,
                         'a fine-tune is prompted with text alone')

    def test_a_checkpoint_still_needs_its_maxChars(self):
        with self.assertRaises(ValueError) as caught:
            self._load({'ds-ft': {'kind': 'checkpoint',
                                  'checkpointDir': '/models/ds-merged'}})
        self.assertIn('maxChars', str(caught.exception))

    def test_a_checkpoint_kind_without_a_directory_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            self._load({'ds-ft': {'kind': 'checkpoint', 'maxChars': 500}})
        self.assertIn('checkpointDir', str(caught.exception))

    def test_the_retired_adapterDir_key_is_refused_by_name(self):
        """There is no runtime LoRA on this stack, so an adapter directory has
        nothing to be loaded into. The refusal says what to write instead."""
        with self.assertRaises(ValueError) as caught:
            self._load({'ds-ft': {'kind': 'adapter',
                                  'adapterDir': '/models/ds-lora',
                                  'maxChars': 500}})
        message = str(caught.exception)
        self.assertIn('SupportsLoRA', message)
        self.assertIn('checkpointDir', message)

    # ---- the refusals that keep the shapes apart ---------------------------

    def test_a_clips_entry_with_an_empty_list_is_refused(self):
        """NOT quietly the default voice. ClipsVoice's >= 1 rule stands."""
        with self.assertRaises(ValueError) as caught:
            self._load({'ds': {'clips': []}})
        message = str(caught.exception)
        self.assertIn('no clips', message)
        self.assertIn("kind 'default'", message)

    def test_an_entry_that_says_nothing_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            self._load({'mystery': {'scene': 'a quiet room'}})
        message = str(caught.exception)
        self.assertIn('12 %', message, 'the refusal must say what default costs')

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            self._load({'x': {'kind': 'description'}})
        self.assertIn('description', str(caught.exception))

    def test_the_maxCharsSource_vocabulary_is_closed(self):
        from narrator.engine.protocol import MAX_CHARS_SOURCES
        self.assertEqual(MAX_CHARS_SOURCES,
                         ('catalog', 'placeholder', 'length-sweep'))
        voice = self._load({'ds': {'clips': [self._clip_entry()],
                                   'maxChars': 450,
                                   'maxCharsSource': 'length-sweep'}})['ds']
        self.assertEqual(voice.max_chars_source, 'length-sweep')
        with self.assertRaises(ValueError) as caught:
            self._load({'ds': {'clips': [self._clip_entry()],
                               'maxChars': 450, 'maxCharsSource': 'vibes'}})
        self.assertIn('vibes', str(caught.exception))

    def test_a_max_chars_without_a_source_cannot_be_built(self):
        from narrator.engine.protocol import DefaultVoice
        with self.assertRaises(ValueError) as caught:
            DefaultVoice(name='x', max_chars=600)
        self.assertIn('provenance', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
