"""Every flag in FLAGS.md: its verdict, its parser, and where it routes.

Two halves.

TABLE: the `flags.FLAGS` dict is the single source `compat/app.py`, `FLAGS.md`
and these tests read, so a flag added to the code without a verdict, or declared
in the parser but absent from the table, fails here rather than at a spawn.

ROUTING: each accepted flag is driven through `compat.app.main` with a fake
engine and a synthetic session, and the observable effect is asserted.
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

from narrator.compat import app as compat_app
from narrator.compat import flags as flagdef
from narrator.compat import worker as compat_worker
from narrator.compat.flags import ACCEPT, IGNORE, REFUSE, FlagRefused
from narrator.tests import synthetic
from narrator.tests.test_render_worker import FakeEngineConfig, FakeRenderEngine

FLAGS_MD = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                        'compat', 'FLAGS.md')

# ---------------------------------------------------------------------------
# The three e2a flag lists, transcribed from the source so the table is checked
# against ebook2audiobook and not against itself.
# ---------------------------------------------------------------------------

#: app.py:158-166, minus the four that are argparse's own or e2a-internal
#: (--version, --help are argparse; --session and --headless are in the table).
E2A_APP_OPTIONS = [
    '--script_mode', '--session', '--share', '--headless',
    '--ebook', '--ebooks_dir', '--language', '--voice', '--device', '--tts_engine',
    '--custom_model', '--fine_tuned', '--output_format', '--output_channel',
    '--temperature', '--length_penalty', '--num_beams', '--repetition_penalty',
    '--top_k', '--top_p', '--speed', '--enable_text_splitting',
    '--text_temp', '--waveform_temp',
    '--output_dir', '--workflow',
]

#: bookforge_ext/parallel/args.py:9-17, PARALLEL_OPTIONS verbatim.
E2A_PARALLEL_OPTIONS = [
    '--prep_only', '--worker_mode', '--assemble_only',
    '--sentence_start', '--sentence_end', '--chapter_start', '--chapter_end',
    '--resume_session', '--list_sessions', '--no_split', '--chapters', '--skip_deps',
    '--bilingual', '--bilingual_pause', '--bilingual_gap', '--skip_assembly',
    '--sentence_per_paragraph', '--skip_headings', '--session_dir',
    '--custom_model_dir', '--sentences_dir', '--orpheus_model_dir',
    '--orpheus_adapter_dir', '--orpheus_base_dir', '--post_render_filter',
    '--encoded_chapters_dir',
]

#: worker.py:357-427, the lightweight worker's own parser.
E2A_WORKER_OPTIONS = [
    '--session', '--session_dir', '--sentence_start', '--sentence_end',
    '--sentence_indices', '--num_takes', '--take_temperatures',
    '--sentence_overrides', '--chapter_start', '--chapter_end', '--device',
    '--output_dir', '--tts_engine', '--fine_tuned', '--voice', '--output_format',
    '--speed', '--custom_model', '--custom_model_dir', '--orpheus_model_dir',
    '--orpheus_adapter_dir', '--orpheus_base_dir', '--sentences_dir',
]


class TableTest(unittest.TestCase):

    def test_every_e2a_flag_has_a_verdict(self):
        for name, options in (('app.py', E2A_APP_OPTIONS),
                              ('args.py', E2A_PARALLEL_OPTIONS),
                              ('worker.py', E2A_WORKER_OPTIONS)):
            for flag in options:
                self.assertIn(flag, flagdef.FLAGS,
                              f'{flag} ({name}) has no verdict in compat/flags.py')

    #: Flags NARRATOR adds that no ebook2audiobook entry point ever declared.
    #: The compat door started as a pure shim, so this set was empty; narrator's
    #: second engine needs one flag of its own and it is named here rather than
    #: allowed by loosening the test.
    NARRATOR_ADDED_FLAGS = {
        '--higgs_voice':
            'Higgs has no --fine_tuned voice TOKEN - its voice is a CATALOG ID '
            'naming a fine-tuned adapter or a set of reference clips. e2a never '
            'had a Higgs engine, so it never had this flag.',
        '--coverage_report':
            'The report `narrator align --report` writes. An engine guarded by '
            'post-render forced alignment (higgs-v3) refuses to assemble '
            'without one, and this door had no way to supply it, so a v3 book '
            'through --assemble_only would have read as "assembly is broken" '
            'rather than "run align first". e2a had no such guard and so no '
            'such flag. A no-op for orpheus.',
    }

    def test_the_table_adds_no_flag_e2a_never_had_except_the_declared_ones(self):
        every = set(E2A_APP_OPTIONS) | set(E2A_PARALLEL_OPTIONS) | set(E2A_WORKER_OPTIONS)
        extra = set(flagdef.FLAGS) - every
        self.assertEqual(extra, set(self.NARRATOR_ADDED_FLAGS),
                         'compat accepts flags no e2a entry point declares and '
                         'that are not declared as narrator additions')
        for flag, reason in self.NARRATOR_ADDED_FLAGS.items():
            self.assertIn(flag, flagdef.FLAGS)
            self.assertTrue(reason)

    def test_every_verdict_is_one_of_three_and_carries_a_reason(self):
        for flag, (verdict, reason) in flagdef.FLAGS.items():
            self.assertIn(verdict, (ACCEPT, IGNORE, REFUSE), flag)
            if verdict != ACCEPT:
                self.assertTrue(reason, f'{flag} is {verdict} with no reason')

    def test_the_parser_declares_exactly_the_table(self):
        """A flag in the table with no argparse entry would be reported as
        'unrecognized' by argparse AFTER passing narrator's own check; a flag in
        the parser but not the table would be silently accepted."""
        parser = compat_app.build_parser()
        declared = set()
        for action in parser._actions:
            for opt in action.option_strings:
                if opt not in ('-h', '--help'):
                    declared.add(opt)
        self.assertEqual(declared, set(flagdef.FLAGS))

    def test_flags_md_lists_the_same_counts(self):
        with open(FLAGS_MD, encoding='utf-8') as f:
            text = f.read()
        counts = {v: sum(1 for _, (vv, _) in flagdef.FLAGS.items() if vv == v)
                  for v in (ACCEPT, IGNORE, REFUSE)}
        expected = (f'**Counts: {len(flagdef.FLAGS)} flags - {counts[ACCEPT]} '
                    f'ACCEPT, {counts[IGNORE]} IGNORE, {counts[REFUSE]} REFUSE.**')
        self.assertIn(expected, text)
        self.assertIn(f'Plus {len(flagdef.REFUSED_ENGINES)} engine names', text)

    def test_flags_md_names_every_flag(self):
        with open(FLAGS_MD, encoding='utf-8') as f:
            text = f.read()
        for flag in flagdef.FLAGS:
            self.assertIn(flag, text, f'{flag} is not documented in FLAGS.md')


class RefusalTest(unittest.TestCase):

    def _refusal(self, argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(SystemExit) as caught:
                compat_app.main(argv)
        return int(caught.exception.code or 0), buf.getvalue()

    def test_prep_only_without_an_ebook_prints_e2as_line_and_nothing_else(self):
        """`--prep_only` became ACCEPT at migration step 4 (`narrator.text.prep`).

        What is left to assert on THIS route is e2a's own argument refusal:
        `handlers.py:50-51` prints `Error: --prep_only requires --ebook` and
        returns a failure dict that `app.py:277` only reads for its exit code, so
        NO JSON is printed on this path. The prep route's real behaviour is
        `tests/test_compat_prep.py`.
        """
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = compat_app.main(['--headless', '--prep_only'])
        out = buf.getvalue()
        self.assertEqual(code, 1)
        self.assertIn('Error: --prep_only requires --ebook', out)
        self.assertNotIn('{', out)

    def test_every_refused_flag_names_itself(self):
        for flag, (verdict, _) in sorted(flagdef.FLAGS.items()):
            if verdict != REFUSE:
                continue
            argv = ['--headless', flag]
            if flag in ('--ebooks_dir', '--bilingual_pause', '--bilingual_gap'):
                argv.append('1')     # these take a value
            code, out = self._refusal(argv)
            self.assertEqual(code, 1, flag)
            self.assertIn(f'{flag} is not supported by narrator', out, flag)

    def test_bilingual_is_refused_with_the_timing_reason(self):
        _, out = self._refusal(['--headless', '--assemble_only', '--bilingual'])
        self.assertIn('assembly inserts silence of its own', out)

    def test_an_unknown_flag_lists_the_accepted_set(self):
        code, out = self._refusal(['--headless', '--not_a_flag'])
        self.assertEqual(code, 1)
        self.assertIn('Unrecognized option "--not_a_flag"', out)
        self.assertIn('--worker_mode', out)
        self.assertIn('--assemble_only', out)

    def test_an_unknown_flag_written_with_an_equals_names_the_flag_only(self):
        _, out = self._refusal(['--headless', '--nope=3'])
        self.assertIn('Unrecognized option "--nope"', out)

    def test_every_deleted_engine_is_refused_ON_THE_WORKER_ROUTE(self):
        for engine in sorted(flagdef.REFUSED_ENGINES):
            code, out = self._refusal(
                ['--headless', '--worker_mode', '--session', 'x',
                 '--tts_engine', engine])
            self.assertEqual(code, 1, engine)
            self.assertIn('narrator renders', out, engine)
            self.assertIn("'orpheus', 'higgs-v3'", out, engine)

    def test_an_engine_nobody_has_heard_of_is_refused_as_unknown(self):
        _, out = self._refusal(['--headless', '--worker_mode', '--session', 'x',
                                '--tts_engine', 'kokoro'])
        self.assertIn('unknown engine', out)

    def test_no_mode_at_all_is_refused_with_the_modes_it_wants(self):
        code, out = self._refusal(['--headless'])
        self.assertEqual(code, 1)
        self.assertIn('no mode selected', out)
        self.assertIn('--worker_mode', out)


class RoutingTest(unittest.TestCase):
    """Every ACCEPT flag, driven through the real door."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-compat-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.session_dir = os.path.join(self.root, 'ebook-ccd14111')
        os.makedirs(self.session_dir)
        self.process_dir = synthetic.build_session(self.session_dir)
        self.sentences_dir = os.path.join(self.process_dir, 'chapters', 'sentences')
        self.engines = []
        self._saved_root = os.environ.get('NARRATOR_SESSIONS_ROOT')
        os.environ['NARRATOR_SESSIONS_ROOT'] = self.root

    def tearDown(self):
        if self._saved_root is None:
            os.environ.pop('NARRATOR_SESSIONS_ROOT', None)
        else:
            os.environ['NARRATOR_SESSIONS_ROOT'] = self._saved_root

    def factory(self, config):
        engine = FakeRenderEngine(FakeEngineConfig(
            sentences_dir=config.sentences_dir, process_dir=config.process_dir,
            voice=config.voice, audio_format=config.audio_format,
            model_dir=config.model_dir, adapter_dir=config.adapter_dir,
            base_dir=config.base_dir))
        self.engines.append(engine)
        return engine

    def run_main(self, argv, entry=compat_app):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = entry.main(argv, engine_factory=self.factory)
        return code, buf.getvalue()

    def worker_result(self, out: str) -> dict:
        """THE BRIDGE'S OWN PARSER, verbatim.

        `parallel-tts-bridge.ts:3747`:

            if (t.startsWith('{') && t.includes('"success"')) {
              try { resultJson = JSON.parse(t); } catch { }
            }

        applied to each trimmed stdout line. If nothing matches, the bridge falls
        to `:3756-3768` and reports EVERY index failed with the stderr tail as the
        error - on a run that succeeded. So this test parses the way the consumer
        parses, and finding no line is the failure.
        """
        found = None
        for line in out.splitlines():
            t = line.strip()
            if t.startswith('{') and '"success"' in t:
                try:
                    found = json.loads(t)
                except ValueError:
                    continue
        self.assertIsNotNone(
            found,
            'parallel-tts-bridge.ts:3747 would find no result line in:\n' + out)
        return found

    def app_result(self, out: str) -> dict:
        """The app door's shape: `json.dumps(result, indent=2)`, handlers.py."""
        starts = [i for i, l in enumerate(out.splitlines()) if l == '{']
        self.assertTrue(starts, out)
        return json.loads('\n'.join(out.splitlines()[starts[-1]:]))

    # -- worker mode ---------------------------------------------------------

    def test_worker_mode_renders_the_named_range(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        code, out = self.run_main([
            '--headless', '--worker_mode', '--skip_deps',
            '--session', 'ccd14111', '--session_dir', self.session_dir,
            '--sentences_dir', self.sentences_dir,
            '--device', 'cpu', '--tts_engine', 'orpheus',
            '--fine_tuned', 'deathstalker',
            '--sentence_start', '2', '--sentence_end', '5',
        ])
        self.assertEqual(code, 0, out)
        self.assertEqual([i for i, _ in self.engines[0].calls], [2, 3, 4, 5])
        result = self.worker_result(out)
        self.assertTrue(result['success'])
        self.assertEqual(result['sentence_start'], 2)
        self.assertEqual(result['sentences_converted'], 4)

    def test_the_worker_result_is_ONE_line_like_e2as_worker(self):
        """`worker.py:518` is `print(json.dumps(result))` - compact, one line -
        because `parallel-tts-bridge.ts:3747` parses stdout line by line. An
        `indent=2` result is invisible to that scanner."""
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir, '--sentences_dir', self.sentences_dir,
            '--device', 'cpu', '--tts_engine', 'orpheus',
            '--sentence_start', '0', '--sentence_end', '0'])
        self.assertEqual(code, 0, out)

        candidates = [l.strip() for l in out.splitlines()
                      if l.strip().startswith('{') and '"success"' in l.strip()]
        self.assertEqual(len(candidates), 1, out)
        parsed = json.loads(candidates[0])
        self.assertTrue(parsed['success'])
        # It really is one line: no newline anywhere inside it, and no `indent`
        # padding after the opening brace.
        self.assertNotIn('\n', candidates[0])
        self.assertTrue(candidates[0].startswith('{"success":'), candidates[0])

    def test_a_worker_ERROR_result_is_also_one_line(self):
        """A refusal must reach the bridge as a parseable result too, or the run
        is reported as "every index failed" instead of "bad arguments"."""
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir, '--sentences_dir', self.sentences_dir,
            '--device', 'cpu', '--tts_engine', 'orpheus',
            '--sentence_start', '0', '--sentence_end', '99'])
        self.assertEqual(code, 1)
        result = self.worker_result(out)
        self.assertFalse(result['success'])
        self.assertIn('Invalid sentence range', result['error'])

    def test_a_result_without_a_success_key_exits_1(self):
        """`worker.py:521` is `result.get('success')`, with NO default, unlike
        `app.py:278`'s `.get('success', True)`. Both preserved as written."""
        self.assertEqual(compat_app._print_worker_result({'nothing': 1}), 1)
        self.assertEqual(compat_app._print_app_result({'nothing': 1}), 0)

    def test_the_worker_door_implies_worker_mode(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        code, out = self.run_main([
            '--session', 'ccd14111', '--session_dir', self.session_dir,
            '--sentences_dir', self.sentences_dir, '--device', 'cpu',
            '--tts_engine', 'orpheus', '--fine_tuned', 'deathstalker',
            '--sentence_start', '0', '--sentence_end', '1',
        ], entry=compat_worker)
        self.assertEqual(code, 0, out)
        self.assertEqual([i for i, _ in self.engines[0].calls], [0, 1])

    def test_chapter_mode_flags_route(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir, '--sentences_dir', self.sentences_dir,
            '--device', 'cpu', '--tts_engine', 'orpheus',
            '--chapter_start', '3', '--chapter_end', '3',
        ])
        self.assertEqual(code, 0, out)
        # Chapter 3 is the synthetic book's last, chunks 7..9 - including the bare
        # `[break]` row, which is non-empty text and so is rendered like any other.
        self.assertEqual([i for i, _ in self.engines[0].calls], [7, 8, 9])

    def test_the_orpheus_model_flags_reach_the_engine_config(self):
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir, '--sentences_dir', self.sentences_dir,
            '--device', 'cpu', '--tts_engine', 'orpheus',
            '--orpheus_base_dir', '/models/base',
            '--orpheus_adapter_dir', '/models/adapters/leah',
            '--fine_tuned', 'leah',
            '--sentence_start', '0', '--sentence_end', '0',
        ])
        self.assertEqual(code, 0, out)
        config = self.engines[0].config
        self.assertEqual(config.base_dir, '/models/base')
        self.assertEqual(config.adapter_dir, '/models/adapters/leah')
        self.assertEqual(config.voice, 'leah')
        # SUSPECTED BUG PRESERVED. e2a resolves each model key INDEPENDENTLY
        # (`args.get(k) or state.get(k)`, worker_core.py:202-206), so adapter
        # flags do not clear a `orpheus_model_dir` the state already carries -
        # this session's stays, and the real engine then refuses the pair
        # ("Orpheus got both model_dir and adapter_dir"). Loud, and e2a's.
        # See render/PORT_NOTES.md.
        self.assertEqual(config.model_dir, '/home/telltale/orpheus-models/mistborn')

    def test_a_missing_session_id_is_refused_the_way_e2a_refuses_it(self):
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session_dir', self.session_dir,
            '--sentence_start', '0', '--sentence_end', '0'])
        self.assertEqual(code, 1)
        self.assertIn('Error: --worker_mode requires --session', out)

    def test_no_range_at_all_is_refused_naming_all_three_shapes(self):
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir])
        self.assertEqual(code, 1)
        self.assertIn('--sentence_indices', out)
        self.assertIn('--chapter_start/--chapter_end', out)

    def test_both_modes_at_once_is_refused(self):
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir,
            '--sentence_start', '0', '--sentence_end', '1',
            '--chapter_start', '1', '--chapter_end', '1'])
        self.assertEqual(code, 1)
        self.assertIn('Cannot specify both sentence and chapter modes', out)

    # -- retake --------------------------------------------------------------

    def test_the_retake_flags_route_to_take_dirs(self):
        scratch = os.path.join(self.root, 'candidates')
        os.makedirs(scratch)
        overrides = os.path.join(scratch, 'overrides.json')
        with open(overrides, 'w', encoding='utf-8') as f:
            json.dump({'4': 'An edited line.'}, f)

        code, out = self.run_main([
            '--session', 'ccd14111', '--session_dir', self.session_dir,
            '--sentences_dir', scratch, '--device', 'cpu',
            '--tts_engine', 'orpheus', '--fine_tuned', 'deathstalker',
            '--sentence_indices', '4,6',
            '--take_temperatures', '0.4,0.8',
            '--sentence_overrides', overrides,
        ], entry=compat_worker)

        self.assertEqual(code, 0, out)
        for take in ('take0', 'take1'):
            for i in (4, 6):
                self.assertTrue(os.path.exists(
                    os.path.join(scratch, take, f'{i}.flac')))
        self.assertIn((4, 'An edited line.'), self.engines[0].calls)

    def test_num_takes_alone_sets_the_take_count(self):
        scratch = os.path.join(self.root, 'c2')
        os.makedirs(scratch)
        code, out = self.run_main([
            '--session', 'x', '--session_dir', self.session_dir,
            '--sentences_dir', scratch, '--device', 'cpu',
            '--tts_engine', 'orpheus', '--sentence_indices', '0',
            '--num_takes', '3',
        ], entry=compat_worker)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(os.listdir(scratch)),
                         ['take0', 'take1', 'take2'])

    def test_sentence_indices_routes_even_without_worker_mode(self):
        scratch = os.path.join(self.root, 'c3')
        os.makedirs(scratch)
        code, out = self.run_main([
            '--headless', '--session', 'x', '--session_dir', self.session_dir,
            '--sentences_dir', scratch, '--device', 'cpu',
            '--tts_engine', 'orpheus', '--sentence_indices', '1',
            '--take_temperatures', '0.5',
        ])
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.exists(os.path.join(scratch, 'take0', '1.flac')))

    def test_a_bad_index_list_prints_e2as_error_line_and_exits_1(self):
        """`worker.py:437` prints exactly
        `Error: --sentence_indices must be a comma-separated list of integers`
        and `sys.exit(1)`. A traceback is not something e2a ever produced here."""
        code, out = self.run_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir,
            '--sentence_indices', 'one,two'])
        self.assertEqual(code, 1)
        self.assertIn(
            'Error: --sentence_indices must be a comma-separated list of integers',
            out)
        self.assertEqual(self.engines, [])

    def test_every_retake_parse_error_prints_e2as_exact_line(self):
        base = ['--headless', '--worker_mode', '--session', 'x',
                '--session_dir', self.session_dir]
        cases = [
            (['--sentence_indices', 'x'],
             'Error: --sentence_indices must be a comma-separated list of integers'),
            (['--sentence_indices', ' , '],
             'Error: --sentence_indices was provided but empty'),
            (['--sentence_indices', '1', '--take_temperatures', 'hot'],
             'Error: --take_temperatures must be a comma-separated list of numbers'),
            (['--sentence_indices', '1', '--take_temperatures', ','],
             'Error: --take_temperatures was provided but empty'),
            (['--sentence_indices', '1', '--sentence_overrides', 'no-such.json'],
             'Error: failed to read --sentence_overrides'),
        ]
        for extra, expected in cases:
            code, out = self.run_main(base + extra)
            self.assertEqual(code, 1, extra)
            self.assertIn(expected, out, extra)

    # -- engine selection ----------------------------------------------------

    def test_the_higgs_render_route_reaches_the_worker_and_carries_the_voice(self):
        """`--tts_engine higgs-v3 --higgs_voice X` used to be refused at the door
        while `render/worker.py` could not carry a Higgs voice. It now routes,
        and the voice arrives on the WorkerRequest as a catalog id."""
        from narrator.engine import registry

        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        seen = {}

        def fake_engine_class(engine_id):
            seen['class_id'] = engine_id
            return lambda config: FakeRenderEngine(FakeEngineConfig(
                sentences_dir=config.sentences_dir, voice='fake'))

        def fake_engine_config(engine_id, **kwargs):
            seen['config_kwargs'] = kwargs

            class Cfg:
                voice = kwargs.get('voice')
                adapter_dir = kwargs.get('adapter_dir')
                sentences_dir = None
                process_dir = None
                audio_format = None
            return Cfg()

        # NO engine_factory: the point is that the DEFAULT path picks the class
        # through the registry. (run_main injects this suite's Orpheus fake,
        # which would bypass exactly what is under test.)
        real_class, real_config = registry.engine_class, registry.engine_config
        registry.engine_class, registry.engine_config = fake_engine_class, fake_engine_config
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                code = compat_app.main([
                    '--headless', '--worker_mode', '--session', 'x',
                    '--session_dir', self.session_dir,
                    '--sentences_dir', self.sentences_dir,
                    '--device', 'CUDA', '--tts_engine', 'higgs-v3',
                    '--higgs_voice', 'deathstalker-samebook',
                    '--sentence_start', '0', '--sentence_end', '1'])
        finally:
            registry.engine_class, registry.engine_config = real_class, real_config
        out = buf.getvalue()

        self.assertEqual(code, 0, out)
        self.assertEqual(seen['class_id'], 'higgs-v3')
        self.assertEqual(seen['config_kwargs'],
                         {'voice': 'deathstalker-samebook', 'adapter_dir': None})
        self.assertIn('[WORKER] TTS engine: higgs-v3', out)
        result = self.worker_result(out)
        self.assertTrue(result['success'])
        self.assertEqual(result['sentences_converted'], 2)

    def test_a_higgs_voice_on_an_orpheus_engine_is_refused_at_the_door(self):
        code, out = self._refusal_via_main([
            '--headless', '--worker_mode', '--session', 'x',
            '--session_dir', self.session_dir, '--tts_engine', 'orpheus',
            '--higgs_voice', 'deathstalker-samebook',
            '--sentence_start', '0', '--sentence_end', '1'])
        self.assertEqual(code, 1)
        self.assertIn('--higgs_voice names a Higgs voice', out)

    def _refusal_via_main(self, argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(SystemExit) as caught:
                compat_app.main(argv, engine_factory=self.factory)
        return int(caught.exception.code or 0), buf.getvalue()

    # -- sessions ------------------------------------------------------------

    def test_list_sessions_prints_e2as_json(self):
        os.remove(os.path.join(self.sentences_dir, '3.flac'))
        code, out = self.run_main(['--headless', '--list_sessions'])
        self.assertEqual(code, 0)
        rows = json.loads(out)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['missing_sentences'], 1)

    def test_resume_session_prints_the_payload_the_bridge_maps(self):
        os.remove(os.path.join(self.sentences_dir, '3.flac'))
        code, out = self.run_main(
            ['--headless', '--resume_session', self.session_dir])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload['success'])
        self.assertEqual(payload['missing_indices'], [3])

    def test_resume_session_on_a_broken_session_is_a_failure_result_not_a_crash(self):
        with open(os.path.join(self.process_dir, 'session-state.json'), 'w',
                  encoding='utf-8') as f:
            f.write('{ broken')
        code, out = self.run_main(
            ['--headless', '--resume_session', self.session_dir])
        self.assertEqual(code, 1)
        starts = [i for i, l in enumerate(out.splitlines()) if l == '{']
        payload = json.loads('\n'.join(out.splitlines()[starts[-1]:]))
        self.assertFalse(payload['success'])

    # -- assembly ------------------------------------------------------------

    def test_assemble_only_needs_a_session_dir_and_an_output_dir(self):
        code, out = self.run_main(
            ['--headless', '--assemble_only', '--session', 'x'])
        self.assertEqual(code, 1)
        self.assertIn('--assemble_only requires --session_dir', out)

        code, out = self.run_main(
            ['--headless', '--assemble_only', '--session', 'x',
             '--session_dir', self.session_dir])
        self.assertEqual(code, 1)
        self.assertIn('--assemble_only requires --output_dir', out)

    def test_the_reassembly_bridges_own_argv_reaches_the_assembler(self):
        """REPLAY of `reassembly-bridge.ts:1508-1534`, verbatim in shape and in
        its literal `--tts_engine xtts` - which is what an Orpheus book's
        assembly actually passes, because the flag is engine-agnostic scaffolding
        there (`parallel-tts-bridge.ts:5164` spells the same thing out:
        `asmEngineArg = assembleOrpheusNative ? 'xtts' : settings.ttsEngine`).

        Gating the engine before routing refused every real assembly. This test
        gets as far as the manifest build and stops there - it must NOT be
        refused, and it must NOT mention the engine.
        """
        out_dir = os.path.join(self.root, 'staging')
        os.makedirs(out_dir)
        argv = [
            '--headless',
            '--ebook', os.path.join(self.root, 'book.epub'),
            '--output_dir', out_dir,
            '--session', 'ccd14111-da29-4fb0-a489-a19a0f126bac',
            '--session_dir', self.session_dir,
            '--device', 'CPU',
            '--language', 'eng',
            '--tts_engine', 'xtts',
            '--assemble_only',
            '--no_split',
            '--post_render_filter', 'highpass=f=60,equalizer=f=7000:t=q:w=1:g=-6',
        ]
        # No refusal on the way in: unknown-flag check, refused-flag check and
        # dispatch all pass, and the engine check is not on this route.
        flagdef.reject_unknown(argv)
        compat_app.refuse_present_refusals(argv)
        args = compat_app.build_parser().parse_args(argv)
        self.assertTrue(args.assemble_only)
        self.assertEqual(args.tts_engine, 'xtts')

        buf = io.StringIO()
        with redirect_stdout(buf):
            try:
                compat_app.dispatch(args, argv)
            except SystemExit as exited:      # a refusal would arrive as this
                self.fail(f'the assembly door refused its own argv: '
                          f'{exited} / {buf.getvalue()}')
        out = buf.getvalue()
        # It got PAST the engine check and into the assembler (which then fails
        # on this synthetic session for its own reasons - reaching ffmpeg is out
        # of scope here). Anything naming the engine means the gate is back.
        self.assertNotIn('Orpheus only', out)
        self.assertNotIn('--tts_engine', out)
        # And the failure arrives as e2a's RESULT shape, not a bare traceback:
        # session.py:1310-1314 + handlers.py:138.
        self.assertIn('assemble_audiobook() Exception:', out)
        self.assertFalse(self.app_result(out)['success'])

    def test_the_assembly_door_can_supply_a_coverage_report(self):
        """Review finding 4: an engine guarded by post-render forced alignment
        REFUSES to assemble without a coverage report, and this door had no way
        to give it one - so a Higgs v3 book through `--assemble_only` would have
        read as "assembly is broken" rather than "run align first".

        Checked where it can be checked without an aligner: the flag parses,
        and it arrives at `assemble()` as `coverage_report`.
        """
        from unittest import mock

        out_dir = os.path.join(self.root, 'staging-coverage')
        os.makedirs(out_dir, exist_ok=True)
        report = os.path.join(self.root, 'coverage.json')
        argv = ['--headless', '--assemble_only', '--session', 'x',
                '--session_dir', self.session_dir, '--output_dir', out_dir,
                '--tts_engine', 'xtts', '--coverage_report', report]
        flagdef.reject_unknown(argv)
        args = compat_app.build_parser().parse_args(argv)
        self.assertEqual(args.coverage_report, report)

        seen = {}

        def fake_assemble(manifest, output_dir, **kwargs):
            seen.update(kwargs)
            raise RuntimeError('stop here - the wiring is what is under test')

        import narrator.assemble.run as assemble_run
        import narrator.render.session_v1 as session_v1
        with mock.patch.object(assemble_run, 'assemble', fake_assemble),                 mock.patch.object(session_v1, 'build_manifest',
                                  lambda *a, **k: object()):
            buf = io.StringIO()
            with redirect_stdout(buf):
                compat_app.dispatch(args, argv)
        self.assertEqual(seen.get('coverage_report'), report)

    def test_the_assembly_door_still_works_with_no_coverage_report(self):
        """Orpheus is not guarded, so absence must stay the ordinary case -
        `coverage_report=None` reaches `assemble()` and the gate no-ops."""
        from unittest import mock

        out_dir = os.path.join(self.root, 'staging-nocoverage')
        os.makedirs(out_dir, exist_ok=True)
        argv = ['--headless', '--assemble_only', '--session', 'x',
                '--session_dir', self.session_dir, '--output_dir', out_dir,
                '--tts_engine', 'xtts']
        args = compat_app.build_parser().parse_args(argv)

        seen = {}

        def fake_assemble(manifest, output_dir, **kwargs):
            seen.update(kwargs)
            raise RuntimeError('stop here')

        import narrator.assemble.run as assemble_run
        import narrator.render.session_v1 as session_v1
        with mock.patch.object(assemble_run, 'assemble', fake_assemble),                 mock.patch.object(session_v1, 'build_manifest',
                                  lambda *a, **k: object()):
            buf = io.StringIO()
            with redirect_stdout(buf):
                compat_app.dispatch(args, argv)
        self.assertIn('coverage_report', seen)
        self.assertIsNone(seen['coverage_report'])

    def test_the_inline_assembly_spawns_engine_literal_is_also_accepted(self):
        """`parallel-tts-bridge.ts:5164` + `:5199-5210`. Same literal, different
        spawn; both must route."""
        argv = ['--headless', '--assemble_only', '--session', 'x',
                '--session_dir', self.session_dir, '--tts_engine', 'xtts',
                '--skip_deps', '--no_split', '--device', 'CPU']
        args = compat_app.build_parser().parse_args(argv)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = compat_app.dispatch(args, argv)
        # Refused for a MISSING --output_dir, which is the assembly route talking.
        self.assertEqual(code, 1)
        self.assertIn('--assemble_only requires --output_dir', buf.getvalue())

    def test_the_engine_gate_still_guards_the_worker_route(self):
        code, out = self.run_main([
            '--headless', '--assemble_only', '--session', 'x',
            '--session_dir', self.session_dir, '--tts_engine', 'xtts',
            '--output_dir', self.root, '--list_sessions'])
        # --list_sessions wins the dispatch order and is not gated either.
        self.assertEqual(code, 0, out)

    # -- ignored -------------------------------------------------------------

    def test_every_ignored_flag_is_accepted_and_changes_nothing(self):
        """A bridge that passes `--speed 1.2 --language eng --no_split` must get
        the same render as one that does not."""
        for i in range(10):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        base = ['--headless', '--worker_mode', '--session', 'x',
                '--session_dir', self.session_dir,
                '--sentences_dir', self.sentences_dir,
                '--device', 'cpu', '--tts_engine', 'orpheus',
                '--sentence_start', '0', '--sentence_end', '1']
        noisy = base + [
            '--skip_deps', '--no_split', '--language', 'eng', '--voice', 'v.wav',
            '--speed', '1.2', '--temperature', '0.7', '--length_penalty', '1.0',
            '--num_beams', '3', '--repetition_penalty', '2.0', '--top_k', '50',
            '--top_p', '0.8', '--enable_text_splitting', '--text_temp', '0.7',
            '--waveform_temp', '0.7', '--output_channel', 'mono',
            '--script_mode', 'native', '--workflow', '--share',
            '--custom_model', 'cm', '--custom_model_dir', 'cmd',
            '--ebook', 'book.epub', '--output_format', 'm4b',
            '--output_dir', self.root,
        ]
        code, out = self.run_main(noisy)
        self.assertEqual(code, 0, out)
        self.assertEqual([i for i, _ in self.engines[0].calls], [0, 1])


class ExitCodeTest(unittest.TestCase):

    def test_there_is_no_special_exit_code_for_a_poisoned_cuda_context(self):
        """The engine re-raises a fatal CUDA error rather than retrying per item,
        the worker turns it into success=False, and the process exits 1. grep e2a
        for a dedicated code and there is none; the bridge's defence is the
        completeness gate (`findMissingSentenceFiles`,
        parallel-tts-bridge.ts:4564), not an exit code."""
        root = tempfile.mkdtemp(prefix='narrator-R-poison-')
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        session_dir = os.path.join(root, 'ebook-x')
        os.makedirs(session_dir)
        process_dir = synthetic.build_session(session_dir)
        sentences_dir = os.path.join(process_dir, 'chapters', 'sentences')
        for i in range(10):
            os.remove(os.path.join(sentences_dir, f'{i}.flac'))

        class PoisonedEngine(FakeRenderEngine):
            def convert(self, index, sentence):
                raise RuntimeError(
                    'CUDA error: device-side assert triggered')

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = compat_app.main(
                ['--headless', '--worker_mode', '--session', 'x',
                 '--session_dir', session_dir, '--sentences_dir', sentences_dir,
                 '--device', 'cpu', '--tts_engine', 'orpheus',
                 '--sentence_start', '0', '--sentence_end', '3'],
                engine_factory=lambda c: PoisonedEngine(FakeEngineConfig(
                    sentences_dir=c.sentences_dir, voice=c.voice)))
        self.assertEqual(code, 1)
        out = buf.getvalue()
        self.assertIn('CUDA error: device-side assert triggered', out)


if __name__ == '__main__':
    unittest.main()
