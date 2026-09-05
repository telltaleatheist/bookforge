"""`--prep_only` through `compat/app.py`, driven with the BRIDGE'S OWN ARGV.

The command lines here are transcribed from `parallel-tts-bridge.ts:3211-3260`
(`prepareSession`) - the base list, `pushVoiceArgs`' three Orpheus shapes, and the
two packer flags - so a change in either door fails a test rather than a book.

WHAT THE BRIDGE ACTUALLY PARSES: nothing on stdout. `prepareSession` logs prep's
stdout and explicitly skips any line starting with `{` (`:3305-3310`); it then
reads `<sessionDir>/<the one subdirectory>/session-state.json` (`:3394-3412`) and
builds `PrepInfo` from THAT (`:3435-3462`). So the assertions below are written
against the bridge's real reader:

  entries = readdir(sessionDir); processDir = entries.find(e => e.isDirectory())
  state = JSON.parse(read(processDir/session-state.json))
  throw unless state.total_sentences !== 0
             && Array.isArray(state.chapters) && state.chapters.length
  buildChunkTextMetrics(state.chapter_sentences)
  state.total_raw_sentences ?? <counted>          // e2a writes this key: NO
  state.chapters.map(c => c.chapter_num / sentence_count / sentence_start /
                          sentence_end)
  state.metadata

The result JSON is still reproduced byte-shape-for-byte (`handlers.py:70`:
`json.dumps(result, indent=2, default=str)`), because that is what the door
printed and a script may read it.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid
import zipfile
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from narrator.compat import app as compat_app        # noqa: E402
from narrator.compat import flags as flagdef          # noqa: E402
from narrator.tests.test_text_epub import build_epub  # noqa: E402


class _PrepDoorTest(unittest.TestCase):
    """Shared fixture: a synthetic EPUB and a sessions root."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-T-prep-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.session_id = str(uuid.uuid4())
        # The bridge stages the ebook as `staged-<sessionId>.epub` and passes
        # that path as --ebook (`:3186-3193`). Same shape here, because
        # `filename_noext` and `final_name` are derived from the basename.
        self.ebook = build_epub(
            os.path.join(self.root, f'staged-{self.session_id}.epub'))
        self.sessions_root = os.path.join(self.root, 'tmp')
        os.makedirs(self.sessions_root, exist_ok=True)
        self._saved_env = os.environ.get('NARRATOR_SESSIONS_ROOT')
        os.environ['NARRATOR_SESSIONS_ROOT'] = self.sessions_root
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        if self._saved_env is None:
            os.environ.pop('NARRATOR_SESSIONS_ROOT', None)
        else:
            os.environ['NARRATOR_SESSIONS_ROOT'] = self._saved_env

    def _bridge_argv(self, *, model_dir=None, adapter=None, base=None,
                     fine_tuned='deathstalker', extra=()):
        """`parallel-tts-bridge.ts:3211-3260`, verbatim in order."""
        argv = [
            '--headless',
            '--ebook', self.ebook,
            '--session', self.session_id,
            '--language', 'en',
            '--tts_engine', 'orpheus',
            '--device', 'CUDA',
            '--prep_only',
        ]
        # pushVoiceArgs, the Orpheus branch (`:241-270`)
        if model_dir:
            argv += ['--orpheus_model_dir', model_dir, '--fine_tuned', fine_tuned]
        elif adapter:
            argv += ['--orpheus_base_dir', base,
                     '--orpheus_adapter_dir', adapter,
                     '--fine_tuned', fine_tuned]
        else:
            argv += ['--fine_tuned', fine_tuned]
        argv += list(extra)
        return argv

    def _run(self, argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = compat_app.main(argv)
        return code, buf.getvalue()

    def _session_dir(self):
        return os.path.join(self.sessions_root, f'ebook-{self.session_id}')

    def _read_state_the_way_the_bridge_does(self):
        """`parallel-tts-bridge.ts:3394-3412`, step for step."""
        session_dir = self._session_dir()
        entries = [e for e in os.scandir(session_dir) if e.is_dir()]
        self.assertTrue(entries, f'No process directory found in {session_dir}')
        process_dir = entries[0].path
        with open(os.path.join(process_dir, 'session-state.json'),
                  encoding='utf-8') as f:
            return process_dir, json.load(f)


class FlagVerdictTest(unittest.TestCase):
    """The three rows migration step 4 flips, asserted against the table itself."""

    def test_prep_only_is_accepted_now(self):
        self.assertEqual(flagdef.FLAGS['--prep_only'][0], flagdef.ACCEPT)

    def test_the_two_packer_flags_are_accepted_now(self):
        for flag in ('--sentence_per_paragraph', '--skip_headings'):
            self.assertEqual(flagdef.FLAGS[flag][0], flagdef.ACCEPT, flag)

    def test_ebooks_dir_is_still_refused_and_says_why(self):
        self.assertEqual(flagdef.FLAGS['--ebooks_dir'][0], flagdef.REFUSE)
        self.assertIn('batch conversion', flagdef.FLAGS['--ebooks_dir'][1])
        # ...and no longer says "prep is not ported".
        self.assertNotIn('not ported', flagdef.FLAGS['--ebooks_dir'][1])

    def test_the_flags_the_prep_route_reads_are_all_accepted(self):
        for flag in ('--ebook', '--session', '--language', '--tts_engine',
                     '--device', '--fine_tuned', '--voice', '--output_format',
                     '--output_dir', '--session_dir', '--custom_model',
                     '--custom_model_dir', '--orpheus_model_dir',
                     '--orpheus_adapter_dir', '--orpheus_base_dir'):
            self.assertEqual(flagdef.FLAGS[flag][0], flagdef.ACCEPT, flag)


class PrepRoutingTest(_PrepDoorTest):

    def test_the_bridges_own_prep_argv_prepares_a_session(self):
        code, out = self._run(self._bridge_argv(
            model_dir=r'/home/telltale/orpheus-models/deathstalker'))
        self.assertEqual(code, 0, out)
        process_dir, state = self._read_state_the_way_the_bridge_does()

        # The bridge's own validity gate (`:3409-3411`).
        self.assertNotEqual(state['total_sentences'], 0)
        self.assertIsInstance(state['chapters'], list)
        self.assertTrue(state['chapters'])

        # The PrepInfo it builds (`:3435-3462`).
        self.assertEqual(state['session_id'], self.session_id)
        self.assertEqual(state['total_chapters'], len(state['chapters']))
        for c in state['chapters']:
            for key in ('chapter_num', 'sentence_count', 'sentence_start',
                        'sentence_end'):
                self.assertIn(key, c)
        self.assertEqual(set(state['metadata']),
                         {'title', 'creator', 'language'})
        self.assertIsInstance(state['chapter_sentences'], list)

        # `state.total_raw_sentences ?? (counted)` - e2a does NOT write this key
        # into the state (only into the printed result), and the bridge's comment
        # says so. Preserved, so the bridge keeps counting it itself.
        self.assertNotIn('total_raw_sentences', state)

        # The voice flags the bridge passed are what the worker will read back.
        self.assertEqual(state['fine_tuned'], 'deathstalker')
        self.assertEqual(state['orpheus_model_dir'],
                         r'/home/telltale/orpheus-models/deathstalker')
        self.assertIsNone(state['orpheus_adapter_dir'])
        self.assertEqual(state['tts_engine'], 'orpheus')
        self.assertEqual(state['language'], 'eng')
        self.assertEqual(state['language_iso1'], 'en')
        self.assertEqual(state['device'], 'cuda')
        self.assertEqual(state['status'], 'prepared')
        self.assertEqual(state['version'], 2)

        # The session layout the render and assembly stages then walk.
        self.assertTrue(os.path.isdir(os.path.join(process_dir, 'chapters',
                                                   'sentences')))
        self.assertTrue(os.path.isfile(os.path.join(process_dir,
                                                    'chapter-provenance.json')))
        self.assertTrue(os.path.isfile(os.path.join(
            process_dir, os.path.basename(self.ebook))))

    def test_the_adapter_shape_of_push_voice_args_lands_in_the_state(self):
        code, out = self._run(self._bridge_argv(
            adapter='/models/adapters/tr_ae2', base='/models/orpheus-base',
            fine_tuned='thirdreich'))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertEqual(state['orpheus_adapter_dir'], '/models/adapters/tr_ae2')
        self.assertEqual(state['orpheus_base_dir'], '/models/orpheus-base')
        self.assertEqual(state['fine_tuned'], 'thirdreich')
        self.assertIsNone(state['orpheus_model_dir'])

    def test_a_bare_fine_tuned_stock_voice_lands_in_the_state(self):
        code, out = self._run(self._bridge_argv(fine_tuned='leah'))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertEqual(state['fine_tuned'], 'leah')
        self.assertIsNone(state['orpheus_model_dir'])

    def test_the_printed_result_is_e2as_indented_json_with_e2as_keys(self):
        """`handlers.py:70`: `json.dumps(result, indent=2, default=str)`. Nothing
        reads it today; the shape is preserved because that is what the door
        printed."""
        code, out = self._run(self._bridge_argv(fine_tuned='leah'))
        self.assertEqual(code, 0, out)
        start = out.index('{')
        result = json.loads(out[start:out.rindex('}') + 1])
        self.assertEqual(
            set(result),
            {'session_id', 'session_dir', 'process_dir', 'chapters_dir',
             'chapters_dir_sentences', 'total_chapters', 'total_sentences',
             'total_raw_sentences', 'chapters', 'chapter_sentences', 'metadata'})
        # indent=2 - the pretty form, unlike the WORKER door's one compact line.
        self.assertIn('\n  "session_id"', out)
        # The result carries the real sentence count; the state does not.
        self.assertGreaterEqual(result['total_raw_sentences'],
                                result['total_sentences'])

    def test_an_explicit_session_dir_is_honoured_over_the_sessions_root(self):
        elsewhere = os.path.join(self.root, 'somewhere', 'ebook-x')
        code, out = self._run(self._bridge_argv(
            fine_tuned='leah', extra=['--session_dir', elsewhere]))
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isdir(elsewhere))
        self.assertFalse(os.path.isdir(self._session_dir()))

    def test_output_dir_becomes_audiobooks_dir(self):
        out_dir = os.path.join(self.root, 'audiobooks')
        code, out = self._run(self._bridge_argv(
            fine_tuned='leah', extra=['--output_dir', out_dir]))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertEqual(state['audiobooks_dir'], os.path.abspath(out_dir))

    def test_without_output_dir_audiobooks_dir_is_null_not_an_invented_path(self):
        code, out = self._run(self._bridge_argv(fine_tuned='leah'))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertIsNone(state['audiobooks_dir'])

    def test_sentence_per_paragraph_reaches_the_walker(self):
        code, out = self._run(self._bridge_argv(
            fine_tuned='leah', extra=['--sentence_per_paragraph']))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        # The synthetic book is <h1> + one <p> per document; in paragraph mode
        # the heading and the paragraph are separate chunks and the packer never
        # runs, so no chunk carries a [heading] marker's packing behaviour.
        chunks = [c for ch in state['chapter_sentences'] for c in ch]
        self.assertTrue(any('[heading]' in c for c in chunks))
        self.assertEqual(len(chunks), 4)     # 2 documents x (heading + prose)

    def test_skip_headings_drops_the_heading_text(self):
        code, out = self._run(self._bridge_argv(
            fine_tuned='leah', extra=['--skip_headings']))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        joined = ' '.join(c for ch in state['chapter_sentences'] for c in ch)
        self.assertNotIn('[heading]', joined)
        self.assertNotIn('First Document Second', joined)


class PrepRefusalTest(_PrepDoorTest):

    def test_prep_without_an_ebook_prints_e2as_line_and_no_json(self):
        code, out = self._run(['--headless', '--prep_only',
                               '--session', self.session_id])
        self.assertEqual(code, 1)
        self.assertIn('Error: --prep_only requires --ebook', out)
        self.assertNotIn('{', out)

    def test_a_failed_prep_reaches_the_caller_as_e2as_compact_failure_result(self):
        """`handlers.py:73-75`: `json.dumps(error_result)` - COMPACT, no indent -
        and `{'success': False, 'error': 'prep_ebook_info failed'}`.

        The input is a file that PASSES `accept_epub` (it is a non-empty `.epub`)
        and then fails inside prep, because that is the shape e2a's blanket
        `except` was for. narrator's own named refusals - a non-EPUB extension, a
        non-Orpheus engine - deliberately do NOT take this shape; see the two
        tests above.
        """
        broken = os.path.join(self.root, 'broken.epub')
        with open(broken, 'wb') as f:
            f.write(b'this is not a zip archive at all')
        code, out = self._run(['--headless', '--prep_only',
                               '--ebook', broken,
                               '--session', self.session_id,
                               '--tts_engine', 'orpheus'])
        self.assertEqual(code, 1)
        line = next(l for l in out.splitlines()
                    if l.startswith('{') and '"success"' in l)
        self.assertEqual(json.loads(line),
                         {'success': False, 'error': 'prep_ebook_info failed'})
        self.assertIn('prep_ebook_info() Exception:', out)

    def test_a_non_epub_input_is_refused_BY_NAME_not_as_a_generic_failure(self):
        """`UnsupportedInput` is narrator's own refusal and its message IS the
        answer, so it is printed as `Error: <message>` rather than buried under
        e2a's `prep_ebook_info failed`."""
        pdf = os.path.join(self.root, 'book.pdf')
        with open(pdf, 'wb') as f:
            f.write(b'%PDF-1.4')
        code, out = self._run(['--headless', '--prep_only', '--ebook', pdf,
                               '--session', self.session_id,
                               '--tts_engine', 'orpheus'])
        self.assertEqual(code, 1)
        self.assertIn('Error: ', out)
        self.assertIn('EPUB only', out)
        self.assertIn('Foundry', out)
        self.assertNotIn('prep_ebook_info failed', out)

    def _door_refusal(self, argv):
        """`main` raises `FlagRefused` (a SystemExit) for a door-level refusal;
        the process entry `run()` turns it into an exit code."""
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(SystemExit) as caught:
                compat_app.main(argv)
        return int(caught.exception.code or 0), buf.getvalue()

    def test_a_non_orpheus_engine_is_refused_BY_NAME_on_the_prep_route(self):
        """Refused AT THE DOOR, by the same `check_engine` the worker route
        uses, so an unknown engine never reaches the book."""
        code, out = self._door_refusal(['--headless', '--prep_only',
                                        '--ebook', self.ebook,
                                        '--session', self.session_id,
                                        '--tts_engine', 'xtts'])
        self.assertEqual(code, 1)
        self.assertIn('Error: --tts_engine xtts', out)
        self.assertNotIn('prep_ebook_info failed', out)
        # ...and NOT as "Error extracting Table of Content" followed by an empty
        # book, which is what a wrong engine reported before the engine check
        # moved to the top of get_chapters.
        self.assertNotIn('Error extracting Table of Content', out)
        self.assertNotIn('No chapters found', out)


class HiggsEngineTest(_PrepDoorTest):
    """THE FIRST CUT-OVER SLICE: Higgs jobs spawn narrator's compat doors."""

    VOICES_ENV = 'NARRATOR_HIGGS_VOICES'

    def setUp(self):
        super().setUp()
        # A Higgs prep reads the voice document: the chunk cap is the VOICE's
        # measured maxChars, and a prep without one is refused. The fixture
        # is a fine-tune (a merged dir carrying generation_config.json) certified
        # at 900 - the Mac's number for deathstalker.
        self.checkpoint = os.path.join(self.root, 'ds-merged')
        os.makedirs(self.checkpoint, exist_ok=True)
        with open(os.path.join(self.checkpoint, 'config.json'), 'w',
                  encoding='utf-8') as handle:
            handle.write('{}')
        with open(os.path.join(self.checkpoint, 'generation_config.json'), 'w',
                  encoding='utf-8') as handle:
            handle.write('{"temperature": 1.0, "top_p": 0.95, "top_k": 50, '
                         '"repetition_penalty": 1.0}')
        self.voices_path = os.path.join(self.root, 'voices.json')
        self.write_voices({'ds_ad4l': {'kind': 'checkpoint',
                                       'checkpointDir': self.checkpoint,
                                       'maxChars': 900,
                                       'maxCharsSource': 'length-sweep'}})
        self._saved_voices = os.environ.get(self.VOICES_ENV)
        os.environ[self.VOICES_ENV] = self.voices_path
        self.addCleanup(self._restore_voices)

    def write_voices(self, document):
        import json as _json
        with open(self.voices_path, 'w', encoding='utf-8') as handle:
            _json.dump(document, handle)

    def _restore_voices(self):
        if self._saved_voices is None:
            os.environ.pop(self.VOICES_ENV, None)
        else:
            os.environ[self.VOICES_ENV] = self._saved_voices

    def _higgs_argv(self, *, voice='ds_ad4l', engine='higgs-v3', extra=()):
        return ['--headless', '--ebook', self.ebook,
                '--session', self.session_id, '--language', 'en',
                '--tts_engine', engine, '--device', 'CUDA',
                '--prep_only', '--higgs_voice', voice, *extra]

    def test_a_higgs_prep_packs_at_the_voices_cap_never_at_orpheus_350(self):
        """MEASURED BUG (2026-09-05, both arms): the route built no budget, prep
        fell through to ORPHEUS_MAX_CHARS's 350 default, and a 900/1200-certified
        voice was read in ~220-char chunks."""
        saved = os.environ.pop('ORPHEUS_MAX_CHARS', None)
        if saved is not None:
            self.addCleanup(os.environ.__setitem__, 'ORPHEUS_MAX_CHARS', saved)
        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        state = self._read_state_the_way_the_bridge_does()[1]
        record = state['bookforge_chunking']
        self.assertEqual(record['budget']['voice'], 'ds_ad4l')
        self.assertEqual(record['budget']['max_chars'], 900)
        self.assertNotEqual(record['budget']['max_chars'], 350)

    def test_a_higgs_prep_fills_toward_the_cap(self):
        """Owen, 2026-09-05: "combine paragraphs to reach closer to the cap".
        The merge floor equals the cap, so short paragraphs travel together
        until the next would overflow it."""
        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        record = self._read_state_the_way_the_bridge_does()[1]['bookforge_chunking']
        self.assertEqual(record['floor_chars'], record['budget']['max_chars'])
        self.assertEqual(record['floor_chars'], 900)

    def test_a_trainer_set_target_is_the_floor(self):
        """Owen, 2026-09-05: the target is set by the trainer from the training
        chunks; the prep packs toward it, under the cap."""
        self.write_voices({'ds_ad4l': {'kind': 'checkpoint',
                                       'checkpointDir': self.checkpoint,
                                       'maxChars': 900,
                                       'maxCharsSource': 'length-sweep',
                                       'targetChars': 600,
                                       'targetCharsSource': 'corpus p75'}})
        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        record = self._read_state_the_way_the_bridge_does()[1]['bookforge_chunking']
        self.assertEqual(record['floor_chars'], 600)
        self.assertEqual(record['budget']['max_chars'], 900)

    def test_a_target_above_the_cap_is_refused_by_name(self):
        self.write_voices({'ds_ad4l': {'kind': 'checkpoint',
                                       'checkpointDir': self.checkpoint,
                                       'maxChars': 900,
                                       'maxCharsSource': 'length-sweep',
                                       'targetChars': 1500}})
        code, out = self._run(self._higgs_argv())
        self.assertNotEqual(code, 0)
        self.assertIn('targetChars 1500', out)
        self.assertIn('maxChars 900', out)

    def test_a_higgs_prep_never_reads_ORPHEUS_MAX_CHARS(self):
        os.environ['ORPHEUS_MAX_CHARS'] = '123'
        self.addCleanup(os.environ.pop, 'ORPHEUS_MAX_CHARS', None)
        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        self.assertEqual(self._read_state_the_way_the_bridge_does()[1]['bookforge_chunking']['budget']['max_chars'],
                         900)

    def test_a_fine_tune_with_no_cap_is_refused_before_any_chunk(self):
        self.write_voices({'ds_ad4l': {'kind': 'checkpoint',
                                       'checkpointDir': self.checkpoint}})
        code, out = self._run(self._higgs_argv())
        self.assertNotEqual(code, 0)
        self.assertIn('maxChars', out)
        self.assertIn('ds_ad4l', out)

    def test_a_higgs_prep_without_a_voice_is_refused_by_name(self):
        argv = [a for a in self._higgs_argv() if a not in ('--higgs_voice', 'ds_ad4l')]
        code, out = self._run(argv)
        self.assertNotEqual(code, 0)
        self.assertIn('--higgs_voice', out)

    def test_prep_itself_refuses_a_higgs_options_with_no_budget(self):
        """The belt under the route: text/prep.py never reaches for Orpheus's
        env budget on a Higgs prep."""
        from narrator.text.prep import PrepOptions, PrepError, prep_session
        options = PrepOptions(session=self.session_id, tts_engine='higgs-v3',
                              higgs_voice='ds_ad4l', chunking='paragraph')
        with self.assertRaises(PrepError) as caught:
            prep_session(self.ebook,
                         os.path.join(self.sessions_root, f'ebook-{self.session_id}'),
                         options)
        self.assertIn('Orpheus', str(caught.exception))

    def _door_refusal(self, argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(SystemExit) as caught:
                compat_app.main(argv)
        return int(caught.exception.code or 0), buf.getvalue()

    def test_a_higgs_prep_records_the_engine_and_the_voice_as_given(self):
        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertEqual(state['tts_engine'], 'higgs-v3')
        self.assertEqual(state['higgs_voice'], 'ds_ad4l')
        # ...and NEVER as an Orpheus voice token, which names a different thing.
        self.assertNotEqual(state['fine_tuned'], 'ds_ad4l')

    def test_a_higgs_prep_chunks_by_paragraph_and_says_so(self):
        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        record = state['bookforge_chunking']
        self.assertEqual(record['policy'], 'paragraph')
        self.assertEqual(record['engine'], 'higgs-v3')
        self.assertEqual(record['budget']['voice'], 'ds_ad4l')
        self.assertIn(record['source_kind'], ('epub-native', 'pdf-derived'))

    def test_an_orpheus_prep_still_uses_the_parity_packer(self):
        code, out = self._run(self._bridge_argv(fine_tuned='leah'))
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertEqual(state['bookforge_chunking'], {'policy': 'e2a'})
        self.assertIsNone(state['higgs_voice'])

    def test_the_four_higgs_near_misses_are_refused_by_name(self):
        for bad in ('higgs', 'higgs-v2', 'higgs-v2-scaffold', 'higgs_v3'):
            code, out = self._door_refusal(self._higgs_argv(engine=bad))
            self.assertEqual(code, 1, bad)
            self.assertIn(f'--tts_engine {bad}', out)
            self.assertIn("'orpheus', 'higgs-v3'", out)

    def test_a_higgs_voice_without_the_higgs_engine_is_refused(self):
        code, out = self._door_refusal(['--headless', '--prep_only',
                                        '--ebook', self.ebook,
                                        '--session', self.session_id,
                                        '--tts_engine', 'orpheus',
                                        '--higgs_voice', 'ds_ad4l'])
        self.assertEqual(code, 1)
        self.assertIn('--higgs_voice', out)
        self.assertIn('--fine_tuned', out)

    def test_the_env_and_the_flag_must_agree(self):
        saved = os.environ.get('NARRATOR_ENGINE')
        os.environ['NARRATOR_ENGINE'] = 'orpheus'
        try:
            code, out = self._door_refusal(self._higgs_argv())
            self.assertEqual(code, 1)
            self.assertIn('NARRATOR_ENGINE=orpheus', out)
            self.assertIn('disagrees', out)
        finally:
            if saved is None:
                os.environ.pop('NARRATOR_ENGINE', None)
            else:
                os.environ['NARRATOR_ENGINE'] = saved

    def test_the_env_alone_selects_the_engine(self):
        saved = os.environ.get('NARRATOR_ENGINE')
        os.environ['NARRATOR_ENGINE'] = 'higgs-v3'
        try:
            code, out = self._run(['--headless', '--prep_only',
                                   '--ebook', self.ebook,
                                   '--session', self.session_id,
                                   '--higgs_voice', 'ds_ad4l'])
            self.assertEqual(code, 0, out)
            _, state = self._read_state_the_way_the_bridge_does()
            self.assertEqual(state['bookforge_chunking']['policy'], 'paragraph')
        finally:
            if saved is None:
                os.environ.pop('NARRATOR_ENGINE', None)
            else:
                os.environ['NARRATOR_ENGINE'] = saved

    def test_a_higgs_RENDER_is_no_longer_refused_at_the_door(self):
        """UPDATED once `render/worker.py` became engine-agnostic.

        This used to assert the door refusing `--tts_engine higgs-v3` on the
        render route, naming the two changes owed in `render/worker.py`
        (`WorkerRequest.higgs_voice`, and a config built through
        `engine/registry.py`). Both landed, so the refusal is gone and the route
        must now get PAST the door.

        It still fails - there is no session at this id to render - and that is
        the point: the failure is about the SESSION, not about the engine.
        """
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = compat_app.main(['--headless', '--worker_mode',
                                    '--session', self.session_id,
                                    '--session_dir', os.path.join(self.root, 'nope'),
                                    '--sentence_start', '0',
                                    '--sentence_end', '3',
                                    '--tts_engine', 'higgs-v3',
                                    '--higgs_voice', 'ds_ad4l'])
        out = buf.getvalue()
        self.assertEqual(code, 1)
        # Not a door refusal any more...
        self.assertNotIn('render/worker.py', out)
        self.assertNotIn('PREP accepts higgs-v3 today', out)
        # ...but the worker's own one-line result, about the missing session.
        self.assertIn('Session directory not found', out)

    def test_the_engine_and_voice_must_still_agree(self):
        """The one door check that survives: `--fine_tuned` is an Orpheus TOKEN
        and `--higgs_voice` is a CATALOG ID, so one where the other is expected
        renders a whole book in the wrong voice."""
        code, out = self._door_refusal(['--headless', '--worker_mode',
                                        '--session', self.session_id,
                                        '--sentence_start', '0',
                                        '--sentence_end', '3',
                                        '--tts_engine', 'orpheus',
                                        '--higgs_voice', 'ds_ad4l'])
        self.assertEqual(code, 1)
        self.assertIn('--higgs_voice names a Higgs voice', out)
        self.assertIn('--fine_tuned', out)

    def test_a_higgs_prep_writes_a_gap_file_keyed_by_every_chunk(self):
        """`chapters/sentences/gaps.json`: a key for every global chunk index,
        `0 .. N-1` as strings, and the values are `classify_gap`'s own."""
        from narrator.text.gaps import classify_gap_seconds
        from narrator.text.prep import GAPS_VERSION

        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        process_dir, state = self._read_state_the_way_the_bridge_does()
        path = os.path.join(process_dir, 'chapters', 'sentences', 'gaps.json')
        self.assertTrue(os.path.isfile(path), f'no gap file at {path}')
        with open(path, encoding='utf-8') as f:
            payload = json.load(f)

        self.assertEqual(payload['version'], GAPS_VERSION)
        self.assertEqual(payload['engine'], 'higgs-v3')
        total = state['total_sentences']
        self.assertEqual(sorted(int(k) for k in payload['gaps']),
                         list(range(total)),
                         'the keys must be exactly 0..N-1, the FLAC stems')

        # ...and every value is what the Orpheus engine would have baked in.
        flat = [c for chapter in state['chapter_sentences'] for c in chapter]
        self.assertEqual(len(flat), total)
        for index, chunk in enumerate(flat):
            before, after = classify_gap_seconds(chunk)
            self.assertEqual(payload['gaps'][str(index)],
                             {'before': before, 'after': after},
                             f'chunk {index}: {chunk!r}')

    def test_the_gap_file_covers_every_chunk_kind_the_book_has(self):
        """A heading, an item and prose all classify to the same floor at
        9daab0ba - the paragraph and section tiers were removed 2026-07-17. The
        test asserts the CLASSIFIER's answer per kind rather than a constant, so
        it still holds if a tier is ever reintroduced."""
        from narrator.text.gaps import classify_gap_seconds
        from narrator.text.sml import SML_HEADING_PATTERN

        code, out = self._run(self._higgs_argv())
        self.assertEqual(code, 0, out)
        process_dir, state = self._read_state_the_way_the_bridge_does()
        with open(os.path.join(process_dir, 'chapters', 'sentences',
                               'gaps.json'), encoding='utf-8') as f:
            gaps = json.load(f)['gaps']

        flat = [c for chapter in state['chapter_sentences'] for c in chapter]
        kinds = {'heading': 0, 'item': 0, 'prose': 0}
        for index, chunk in enumerate(flat):
            if SML_HEADING_PATTERN.search(chunk):
                kind = 'heading'
            elif '[item]' in chunk:
                kind = 'item'
            else:
                kind = 'prose'
            kinds[kind] += 1
            before, after = classify_gap_seconds(chunk)
            self.assertEqual(gaps[str(index)]['before'], before, chunk[:60])
            self.assertEqual(gaps[str(index)]['after'], after, chunk[:60])
        self.assertGreater(kinds['heading'], 0, 'the fixture book has no heading')
        self.assertGreater(kinds['prose'], 0)

    def test_an_orpheus_prep_writes_NO_gap_file(self):
        """Orpheus bakes its silence into each FLAC, so a gap file would be a
        second and contradictory source of truth. The absence IS the signal."""
        code, out = self._run(self._bridge_argv(fine_tuned='leah'))
        self.assertEqual(code, 0, out)
        process_dir, _ = self._read_state_the_way_the_bridge_does()
        self.assertFalse(os.path.exists(
            os.path.join(process_dir, 'chapters', 'sentences', 'gaps.json')))

    def test_the_writer_reads_the_profile_table_and_refuses_an_unknown_engine(self):
        """`assemble/engine_profiles.py` is THE table; this must not carry a
        second copy, and must not guess for an engine the table does not know."""
        from narrator.assemble.engine_profiles import PROFILES
        from narrator.text.prep import write_gaps_file

        self.assertFalse(PROFILES['higgs-v3'].pads)
        self.assertTrue(PROFILES['orpheus'].pads)
        target = os.path.join(self.root, 'sentences')
        self.assertIsNone(
            write_gaps_file(self.root, target, 'orpheus', [['[break]One.']]))
        self.assertFalse(os.path.exists(os.path.join(target, 'gaps.json')))
        with self.assertRaises(KeyError):
            write_gaps_file(self.root, target, 'kokoro', [['[break]One.']])

    def test_an_explicit_pause_is_the_one_thing_that_moves_a_gap(self):
        """The only surviving tier. Driven through the writer, not the
        classifier, so the SERIALIZED value is what is asserted."""
        from narrator.text.prep import write_gaps_file

        target = os.path.join(self.root, 'sentences-pause')
        write_gaps_file(self.root, target, 'higgs-v3',
                        [['[break]Plain.', '[pause:2.5]A deliberate beat.',
                          'Mid [pause:1.2] beat.']])
        with open(os.path.join(target, 'gaps.json'), encoding='utf-8') as f:
            gaps = json.load(f)['gaps']
        self.assertEqual(gaps['0'], {'before': 0.0, 'after': 0.6})
        self.assertEqual(gaps['1'], {'before': 2.5, 'after': 0.6})
        self.assertEqual(gaps['2'], {'before': 0.0, 'after': 1.2})

    def test_the_gap_values_are_json_floats_not_ints(self):
        """A `0` where `0.0` is meant round-trips as an int and changes type in
        every reader; the writer pins the type."""
        from narrator.text.prep import write_gaps_file

        target = os.path.join(self.root, 'sentences-types')
        write_gaps_file(self.root, target, 'higgs-v3', [['[break]One.']])
        raw = open(os.path.join(target, 'gaps.json'), encoding='utf-8').read()
        self.assertIn('"before": 0.0', raw)
        self.assertIn('"after": 0.6', raw)

    def test_a_higgs_prep_may_not_ask_for_the_parity_packer(self):
        """It has no Higgs branch and its caps were calibrated on Orpheus."""
        from narrator.text.normalize import UnsupportedEngine
        from narrator.text.prep import PrepOptions, prep_session
        with self.assertRaises(UnsupportedEngine) as caught:
            prep_session(self.ebook, os.path.join(self.root, 's'),
                         PrepOptions(tts_engine='higgs-v3', chunking='e2a'))
        self.assertIn('chunking', str(caught.exception))
        self.assertIn('paragraph', str(caught.exception))

    def test_get_chapters_refuses_a_wrong_engine_before_it_reads_the_toc(self):
        """The library-level half of the same fix: `get_chapters` is reachable
        without going through `prep_session`, and used to report a wrong engine
        as a TOC extraction error and then an empty book."""
        from narrator.text.chapters import ChapterContext, get_chapters
        from narrator.text.epub import read_epub
        from narrator.text.normalize import UnsupportedEngine

        book = read_epub(self.ebook)
        ctx = ChapterContext(language='eng', language_iso1='en',
                             tts_engine='voxtral', process_dir=self.root)
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(UnsupportedEngine) as caught:
                get_chapters(book, ctx)
        self.assertIn('voxtral', str(caught.exception))
        self.assertNotIn('Error extracting Table of Content', buf.getvalue())

    def test_no_session_dir_and_no_sessions_root_is_a_result_not_a_traceback(self):
        """THE CUT-OVER CASE, asserted rather than described.

        A prep spawn that passes no `--session_dir` has nothing but this variable
        to go on, and the WSL arm never carries it - it could not usefully, since
        it holds a HOST path while a guest render derives its session dir from
        the guest sessions root. So this is the shape a cut-over without the
        one-argument fix produces, and it must be e2a's failure result with a
        reason an operator can act on, NOT a bare traceback.

        The rest of this class sets `NARRATOR_SESSIONS_ROOT` in `setUp`; this test unsets
        it, which is the only place the bridge's argv is replayed truly verbatim.
        """
        os.environ.pop('NARRATOR_SESSIONS_ROOT', None)
        code, out = self._run(self._bridge_argv(fine_tuned='leah'))
        self.assertEqual(code, 1)
        line = next(l for l in out.splitlines()
                    if l.startswith('{') and '"success"' in l)
        self.assertEqual(json.loads(line),
                         {'success': False, 'error': 'prep_ebook_info failed'})
        # ...and the reason names both the variable and the flag that fixes it.
        self.assertIn('NARRATOR_SESSIONS_ROOT', out)
        self.assertIn('--session_dir', out)

    def test_a_non_english_book_fails_the_whole_prep_loudly(self):
        code, out = self._run(['--headless', '--prep_only',
                               '--ebook', self.ebook,
                               '--session', self.session_id,
                               '--language', 'de',
                               '--tts_engine', 'orpheus'])
        self.assertEqual(code, 1)
        self.assertIn('English-only', out)


class CliPrepTest(_PrepDoorTest):
    """`python -m narrator prep` - the same call under narrator's own names."""

    def test_the_cli_prep_subcommand_prepares_the_same_session(self):
        from narrator import cli

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main([
                'prep', '--ebook', self.ebook, '--session', self.session_id,
                '--language', 'en', '--fine-tuned', 'deathstalker',
                '--orpheus-model-dir', '/models/deathstalker',
            ])
        out = buf.getvalue()
        self.assertEqual(code, 0, out)
        _, state = self._read_state_the_way_the_bridge_does()
        self.assertEqual(state['fine_tuned'], 'deathstalker')
        self.assertEqual(state['orpheus_model_dir'], '/models/deathstalker')
        self.assertIn('[prep]', out)
        self.assertIn('chunk(s)', out)


if __name__ == '__main__':
    unittest.main()
