"""Higgs v2 without the model: budget, stop policy, voices, and the wire.

Everything here runs on the Windows test interpreter - no torch, no
transformers, no GPU. What it covers:

  * the BUDGET arithmetic, checked against the numbers the audition actually
    produced (`v2_pokemon_para_log.json`: 898 chars -> cap 2794 frames, EOS at
    1468);
  * the CONTEXT ceiling and its refusal, which is the shape Llasa's 2,048-token
    wall proved the seam needs;
  * the VOICE document - a Higgs voice is reference clips with BOOK-EXACT
    transcripts, read from a file, never guessed - and every refusal on the way
    in;
  * the load-message mapping, which REFUSES Orpheus's baseDir and caps by name
    rather than accepting a payload that would look applied and do nothing;
  * the serve worker driven end to end with NARRATOR_ENGINE=higgs-v2-scaffold and the
    Higgs fake, proving the environment selects the engine and that the wire
    carries Higgs's 24 kHz audio.
"""
import json
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))   # .../python
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import registry                                   # noqa: E402
from narrator.engine.higgs import (HiggsBudget, HiggsConfig,           # noqa: E402
                                   HiggsDefaults, HiggsEngine,
                                   higgs_config_from_worker_kwargs,
                                   higgs_stop_policy, load_voice, load_voices)
from narrator.engine.higgs.config import VOICES_ENV                    # noqa: E402
from narrator.engine.protocol import ClipsVoice, ReferenceClip         # noqa: E402


def a_voice(**kwargs):
    return ClipsVoice(
        clips=(ReferenceClip(path=__file__, transcript='A book-exact line.',
                             seconds=14.0),),
        name='deathstalker', **kwargs)


def a_config(**kwargs):
    return HiggsConfig(voice=kwargs.pop('voice', a_voice()), **kwargs)


class BudgetTest(unittest.TestCase):

    def setUp(self):
        self.budget = HiggsBudget(a_config())

    def test_the_cap_formula_reproduces_the_audition(self):
        """render_v2.py: int(chars / 15.0 * 25 * 1.8) + 100, in FRAMES. These
        are the caps the nine-chunk log recorded, chunk for chunk."""
        for chars, cap in ((898, 2794), (646, 2038), (325, 1075), (294, 982),
                           (522, 1665), (158, 574), (132, 496), (203, 709),
                           (465, 1495)):
            with self.subTest(chars=chars):
                self.assertEqual(self.budget.cap_frames('x' * chars), cap)

    def test_the_cap_was_never_reached(self):
        """The audition's longest chunk stopped at frame 1468 against a 2794
        cap - which is why `resplit_on_cap` is False and there is no ladder."""
        self.assertGreater(self.budget.cap_frames('x' * 898), 1468)

    def test_max_chars_is_the_auditions_proven_ceiling(self):
        self.assertEqual(self.budget.max_chars(), 900)
        self.assertEqual(HiggsDefaults.MAX_CHARS, 900)

    def test_max_chars_per_sec_is_above_every_measured_rate(self):
        """The audition measured 11.9-18.0 chars per second of audio."""
        self.assertGreaterEqual(self.budget.max_chars_per_sec(), 18.0)

    def test_the_context_is_a_ceiling_the_prompt_eats_into(self):
        window = HiggsDefaults.CONTEXT_TOKENS
        self.assertEqual(self.budget.max_total_tokens(0), window)
        # The measured 2-clip, 130-char prompt: 900 text positions + 732
        # reference frames.
        self.assertEqual(self.budget.max_total_tokens(900 + 732) - (900 + 732),
                         window - 1632)

    def test_a_prompt_that_fills_the_window_is_refused(self):
        for prompt in (HiggsDefaults.CONTEXT_TOKENS,
                       HiggsDefaults.CONTEXT_TOKENS + 1):
            with self.subTest(prompt=prompt):
                with self.assertRaises(ValueError) as caught:
                    self.budget.max_total_tokens(prompt)
                self.assertIn('nothing to generate', str(caught.exception))

    def test_a_negative_prompt_is_refused(self):
        with self.assertRaises(ValueError):
            self.budget.max_total_tokens(-1)

    def test_reference_length_is_paid_for_in_context(self):
        """The refusal message has to say WHY, because the fix is to shorten the
        references, not the chunk."""
        with self.assertRaises(ValueError) as caught:
            self.budget.max_total_tokens(HiggsDefaults.CONTEXT_TOKENS)
        self.assertIn('reference', str(caught.exception))


class StopPolicyTest(unittest.TestCase):

    def test_higgs_needs_no_eos_help(self):
        policy = higgs_stop_policy(a_config())
        self.assertTrue(policy.eos_reliable)
        self.assertFalse(policy.resplit_on_cap)
        self.assertEqual(sorted(policy.levers), ['temperature', 'topK', 'topP'])
        self.assertEqual(policy.levers['temperature'], 0.3)

    def test_coverage_must_be_asr_checked(self):
        """Duration is not a coverage proxy on this family: one v3 chunk
        measured a 0.99 ratio while dropping 22 % of its text."""
        self.assertEqual(higgs_stop_policy(a_config()).coverage_check, 'asr')

    def test_max_new_tokens_is_the_cap_for_the_largest_chunk(self):
        config = a_config()
        self.assertEqual(higgs_stop_policy(config).max_new_tokens,
                         HiggsBudget(config).cap_frames('x' * config.max_chars))


class VoiceDocumentTest(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='narrator-H-voices-')
        self.addCleanup(self._cleanup)
        self.clip = os.path.join(self.dir, 'ref.wav')
        with open(self.clip, 'wb') as handle:
            handle.write(b'RIFF')
        self.path = os.path.join(self.dir, 'voices.json')

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, document):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        return self.path

    def test_a_voice_round_trips(self):
        path = self._write({'deathstalker': {
            'scene': 'Audio is recorded from a quiet room.',
            'clips': [{'path': self.clip, 'transcript': 'A book-exact line.',
                       'seconds': 14.02}]}})
        voice = load_voice('deathstalker', path)
        self.assertEqual(voice.name, 'deathstalker')
        self.assertEqual(voice.scene, 'Audio is recorded from a quiet room.')
        self.assertEqual(len(voice.clips), 1)
        self.assertEqual(voice.clips[0].transcript, 'A book-exact line.')
        self.assertEqual(voice.clips[0].seconds, 14.02)

    def test_an_unknown_voice_lists_the_known_ones(self):
        path = self._write({'deathstalker': {
            'clips': [{'path': self.clip, 'transcript': 'A line.'}]}})
        with self.assertRaises(ValueError) as caught:
            load_voice('mistborn', path)
        message = str(caught.exception)
        self.assertIn('mistborn', message)
        self.assertIn('deathstalker', message)
        self.assertIn("model's own default narrator", message)

    def test_a_clip_with_no_transcript_is_refused(self):
        path = self._write({'v': {'clips': [{'path': self.clip}]}})
        with self.assertRaises(ValueError) as caught:
            load_voices(path)
        self.assertIn('transcript', str(caught.exception))
        self.assertIn('never a transcription', str(caught.exception))

    def test_a_clip_that_does_not_exist_is_refused(self):
        path = self._write({'v': {'clips': [
            {'path': os.path.join(self.dir, 'missing.wav'),
             'transcript': 'A line.'}]}})
        with self.assertRaises(ValueError) as caught:
            load_voices(path)
        self.assertIn('missing.wav', str(caught.exception))

    def test_a_voice_with_no_clips_key_is_refused(self):
        path = self._write({'v': {'scene': 'nowhere'}})
        with self.assertRaises(ValueError) as caught:
            load_voices(path)
        self.assertIn('clips', str(caught.exception))

    def test_an_unset_env_var_is_a_refusal_not_a_search(self):
        previous = os.environ.pop(VOICES_ENV, None)
        if previous is not None:
            self.addCleanup(os.environ.__setitem__, VOICES_ENV, previous)
        with self.assertRaises(ValueError) as caught:
            load_voice('deathstalker')
        self.assertIn(VOICES_ENV, str(caught.exception))

    def test_the_total_reference_cap_is_enforced_at_construction(self):
        """Higgs v3 rejects more than 30 s of reference outright (42 s -> HTTP
        400). The cap rides on the voice so the refusal happens before a render
        starts, not after a server round trip."""
        voice = ClipsVoice(
            clips=(ReferenceClip(__file__, 'One.', seconds=20.0),
                   ReferenceClip(__file__, 'Two.', seconds=22.0)),
            name='toolong', max_reference_seconds=30.0)
        with self.assertRaises(ValueError) as caught:
            HiggsConfig(voice=voice)
        self.assertIn('42.0 s', str(caught.exception))


class LoadMessageTest(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='narrator-H-load-')
        self.addCleanup(self._cleanup)
        clip = os.path.join(self.dir, 'ref.wav')
        with open(clip, 'wb') as handle:
            handle.write(b'RIFF')
        path = os.path.join(self.dir, 'voices.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump({'deathstalker': {'clips': [
                {'path': clip, 'transcript': 'A book-exact line.'}]}}, handle)
        previous = os.environ.get(VOICES_ENV)
        os.environ[VOICES_ENV] = path
        self.addCleanup(self._restore, previous)

    def _restore(self, previous):
        if previous is None:
            os.environ.pop(VOICES_ENV, None)
        else:
            os.environ[VOICES_ENV] = previous

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_a_voice_name_resolves_to_its_clips(self):
        config = higgs_config_from_worker_kwargs(voice='deathstalker')
        self.assertIsInstance(config, HiggsConfig)
        self.assertEqual(config.voice.name, 'deathstalker')
        self.assertEqual(config.model_id, HiggsDefaults.MODEL_ID)

    def test_the_registry_builds_the_same_thing(self):
        config = registry.engine_config('higgs-v2-scaffold', voice='deathstalker')
        self.assertIsInstance(config, HiggsConfig)

    def test_a_base_dir_is_refused_by_name(self):
        with self.assertRaises(ValueError) as caught:
            higgs_config_from_worker_kwargs(voice='deathstalker',
                                            base_dir='/models/base')
        self.assertIn('baseDir', str(caught.exception))

    def test_orpheus_caps_are_refused_by_name(self):
        """Accepting eosBoost here would mean a payload that looks applied and
        does nothing - the exact failure the caps registry refuses too."""
        with self.assertRaises(ValueError) as caught:
            higgs_config_from_worker_kwargs(voice='deathstalker',
                                            caps={'eosBoost': 8})
        self.assertIn('eosBoost', str(caught.exception))
        self.assertIn('needs no EOS help', str(caught.exception))

    def test_an_unknown_keyword_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            higgs_config_from_worker_kwargs(voice='deathstalker', nonsense=1)
        self.assertIn('nonsense', str(caught.exception))

    def test_a_missing_voice_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            higgs_config_from_worker_kwargs(voice='')
        self.assertIn('no default', str(caught.exception))

    def test_a_checkpoint_dir_rides_on_the_voice(self):
        """The pool's field is still called `adapterDir`, but what it names is a
        MERGED CHECKPOINT: there is no runtime LoRA on this stack."""
        config = higgs_config_from_worker_kwargs(voice='deathstalker',
                                                 adapter_dir='/models/ds-merged')
        self.assertEqual(config.voice.checkpoint_dir, '/models/ds-merged')

    def test_the_engine_refuses_a_config_of_the_wrong_type(self):
        with self.assertRaises(ValueError) as caught:
            HiggsEngine({'voice': 'deathstalker'})
        self.assertIn('HiggsConfig', str(caught.exception))


class TheScaffoldIsNotServableTest(unittest.TestCase):
    """This engine cannot reach the wire at all, and that is the design.

    There used to be a HiggsServeProtocolTest here driving `narrator.serve` with
    NARRATOR_ENGINE=higgs-v2-scaffold. It was removed when the worker began
    REFUSING that id: Higgs v2 was dropped as a rendering engine on 2026-09-04
    and this package is kept only as a reference implementation of
    `narrator.engine.protocol`. A protocol test that ran it would have been
    testing that a not-shipped engine can render a book.

    The wire is exercised for the SHIPPING engines instead - Orpheus in
    tests/test_engine_serve_protocol.py, Higgs v3 in tests/test_higgs_v3.py
    (which also asserts this refusal, from the worker's side).
    """

    def test_the_worker_refuses_the_scaffold_by_name(self):
        from narrator.serve import worker as W
        self.assertIn('higgs-v2-scaffold', W.UNSERVABLE_ENGINES)
        previous = os.environ.get('NARRATOR_ENGINE')
        os.environ['NARRATOR_ENGINE'] = 'higgs-v2-scaffold'
        try:
            with self.assertRaises(ValueError) as caught:
                W.engine_id()
        finally:
            if previous is None:
                os.environ.pop('NARRATOR_ENGINE', None)
            else:
                os.environ['NARRATOR_ENGINE'] = previous
        message = str(caught.exception)
        self.assertIn('SCAFFOLDING', message)
        self.assertIn('higgs-v3', message)

    def test_the_registry_still_resolves_it_for_the_tests_that_use_it(self):
        """Refused on the WIRE, not deleted: this module exercises the engine
        directly, which is the whole point of keeping it."""
        self.assertIs(registry.engine_class('higgs-v2-scaffold'), HiggsEngine)


class UnknownEngineTest(unittest.TestCase):

    def test_an_unknown_NARRATOR_ENGINE_never_handshakes(self):
        """Not defaulted to Orpheus, and not a worker that looks alive: this
        spawn cannot render anything, so it exits non-zero with the reason on
        stderr and prints no `ready` (the Mac's "healthy handshake, every
        generate fails" failure, 2026-09-04)."""
        import subprocess
        env = dict(os.environ)
        env.update({'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8',
                    'NARRATOR_ENGINE': 'llasa'})
        env.pop('NARRATOR_GOLDEN_LOCAL', None)
        out = subprocess.run(
            [sys.executable, '-m', 'narrator.serve', '--fake-engine'],
            cwd=_PYTHON_ROOT, input='{"action": "quit"}\n', capture_output=True,
            text=True, encoding='utf-8', env=env, timeout=180)
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn('"type": "ready"', out.stdout)
        self.assertIn('llasa', out.stderr)


if __name__ == '__main__':
    unittest.main()
