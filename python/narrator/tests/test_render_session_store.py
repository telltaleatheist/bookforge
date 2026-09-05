"""`session-state.json` and the resume scan, against the three golden fixtures.

The fixtures were written by ebook2audiobook@9daab0ba's own
`save_session_state`, so comparing narrator's key set and key ORDER against them
is comparing against e2a's writer directly - not against a copy of it in this
repo.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from narrator.render import session_store
from narrator.render.session_store import SessionStateError
from narrator.tests import synthetic

GOLDEN_DIR = os.path.join(os.path.dirname(__file__), 'golden')
SLUGS = ('kershaw', 'blacksun', 'mutineer')


def golden_state_path(slug: str) -> str:
    return os.path.join(GOLDEN_DIR, slug, 'session-state.json')


def load_golden(slug: str) -> dict:
    with open(golden_state_path(slug), encoding='utf-8') as f:
        return json.load(f)


class GoldenKeySetTest(unittest.TestCase):
    """`STATE_KEY_ORDER` IS e2a's writer, and these prove it."""

    def test_every_golden_state_is_version_2(self):
        for slug in SLUGS:
            self.assertEqual(load_golden(slug)['version'], 2, slug)

    def test_the_golden_key_order_is_a_subsequence_of_ours(self):
        """Every key a real e2a session carries appears in STATE_KEY_ORDER, in the
        same relative order. A key inserted in the wrong place fails here."""
        for slug in SLUGS:
            keys = [k for k in load_golden(slug) if k in session_store.STATE_KEY_ORDER]
            expected = [k for k in session_store.STATE_KEY_ORDER if k in set(keys)]
            self.assertEqual(keys, expected, slug)

    def test_no_golden_key_is_missing_from_our_order(self):
        for slug in SLUGS:
            unknown = [k for k in load_golden(slug)
                       if k not in session_store.STATE_KEY_ORDER]
            self.assertEqual(unknown, [], f'{slug} carries keys our writer drops')

    def test_the_keys_the_layout_contract_names_are_all_present(self):
        """CONTRACTS.md's "keys that matter", asserted against the real files."""
        required = {
            'session_id', 'epub_content_hash', 'total_sentences', 'total_chapters',
            'chapters', 'chapter_sentences', 'language', 'language_iso1',
            'fine_tuned', 'tts_engine', 'output_format', 'metadata', 'cover',
            'final_name', 'chapter_titles', 'chapters_dir_sentences', 'status',
            'created_at', 'updated_at',
        }
        for slug in SLUGS:
            missing = required - set(load_golden(slug))
            self.assertEqual(missing, set(), slug)

    def test_status_is_prepared_and_never_moves(self):
        """e2a writes `session-state.json` ONCE, at prep. `save_session_state` is
        called from `prep_ebook_info` and nowhere else in the checkout; nothing
        restamps `status` or `updated_at`. All three goldens agree.

        `created_at` and `updated_at` are two separate `datetime.now()` calls in
        the same dict literal (session.py:84-85), so they differ by microseconds
        and agree to the second - which is the assertion that means "never
        restamped"."""
        for slug in SLUGS:
            state = load_golden(slug)
            self.assertEqual(state['status'], 'prepared', slug)
            self.assertEqual(state['updated_at'].split('.')[0],
                             state['created_at'].split('.')[0], slug)


class RoundTripTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-store-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def _copy_golden(self, slug: str) -> str:
        process_dir = os.path.join(self.root, slug, 'a1b2c3')
        os.makedirs(process_dir)
        shutil.copy(golden_state_path(slug),
                    os.path.join(process_dir, 'session-state.json'))
        return process_dir

    def test_load_modify_save_reload_preserves_the_key_order(self):
        for slug in SLUGS:
            with self.subTest(slug=slug):
                process_dir = self._copy_golden(slug)
                original = load_golden(slug)

                state = session_store.load_state_from_process_dir(process_dir)
                session_store.set_status(state, 'rendering')
                session_store.save_session_state(process_dir, state)
                reloaded = session_store.load_state_from_process_dir(process_dir)

                self.assertEqual(reloaded['status'], 'rendering')
                self.assertNotEqual(reloaded['updated_at'], original['updated_at'])
                # Order: the two injected path keys are already in the file, so a
                # round trip must not move anything.
                self.assertEqual(list(reloaded), list(original))
                # Every other value survives untouched.
                for key in original:
                    if key in ('status', 'updated_at', 'process_dir', 'session_dir'):
                        continue
                    self.assertEqual(reloaded[key], original[key], f'{slug}:{key}')

    def test_a_round_trip_without_a_change_is_value_identical(self):
        process_dir = self._copy_golden('kershaw')
        state = session_store.load_state_from_process_dir(process_dir)
        session_store.save_session_state(process_dir, state)
        again = session_store.load_state_from_process_dir(process_dir)
        self.assertEqual(again, state)

    def test_the_write_is_atomic_and_leaves_no_temp_file(self):
        process_dir = self._copy_golden('kershaw')
        state = session_store.load_state_from_process_dir(process_dir)
        session_store.save_session_state(process_dir, state)
        leftovers = [n for n in os.listdir(process_dir)
                     if n.startswith('.session-state-')]
        self.assertEqual(leftovers, [])

    def test_the_file_is_written_with_LF_and_indent_2(self):
        """Two declared deviations, one match.

        LF: e2a's text-mode open writes CRLF when prep runs on Windows and LF in
        WSL, so its own bytes already depend on the machine. narrator writes LF
        everywhere; every reader is a JSON parser.

        `indent=2` is e2a's and is matched exactly."""
        process_dir = self._copy_golden('kershaw')
        state = session_store.load_state_from_process_dir(process_dir)
        path = session_store.save_session_state(process_dir, state)
        with open(path, 'rb') as f:
            raw = f.read()
        self.assertNotIn(b'\r\n', raw)
        self.assertIn(b'\n  "version": 2,', raw)

    def test_non_ascii_is_written_literally_not_escaped(self):
        """`ensure_ascii=False`, where e2a takes json's `True` default.

        The LAST writer of a live `session-state.json` is not e2a: it is
        `reassembly-bridge.ts:1108-1159`, writing metadata back through
        `JSON.stringify`, which never escapes non-ASCII. A real file on disk
        therefore already carries the literal character, and re-emitting it as
        `\\u00fc` would churn bytes on every book with an accent in its title.
        Matching the file's actual last writer is the smaller deviation."""
        process_dir = self._copy_golden('kershaw')
        state = session_store.load_state_from_process_dir(process_dir)
        state['metadata'] = dict(state.get('metadata') or {})
        # Written as escapes so THIS FILE stays ASCII (CONTRACTS.md) while the
        # VALUE under test is genuinely non-ASCII.
        title = 'Der F\u00fchrer und die M\u00fcnchener Zeit'
        state['metadata']['title'] = title
        path = session_store.save_session_state(process_dir, state)
        with open(path, 'rb') as f:
            raw = f.read()
        self.assertIn(title.encode('utf-8'), raw)     # literal UTF-8 bytes
        self.assertNotIn(b'\\u00fc', raw)             # not a JSON escape
        # ...and it still round-trips to the same string.
        again = session_store.load_state_from_process_dir(process_dir)
        self.assertEqual(again['metadata']['title'], title)

    def test_an_unknown_key_survives_the_round_trip(self):
        process_dir = self._copy_golden('kershaw')
        state = session_store.load_state_from_process_dir(process_dir)
        state['a_key_from_the_future'] = {'x': 1}
        session_store.save_session_state(process_dir, state)
        reloaded = session_store.load_state_from_process_dir(process_dir)
        self.assertEqual(reloaded['a_key_from_the_future'], {'x': 1})
        # ...and it lands AFTER the known keys, not in the middle of them.
        self.assertEqual(list(reloaded)[-1], 'a_key_from_the_future')


class LocateTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-locate-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.session_dir = os.path.join(self.root, 'ebook-ccd14111')
        os.makedirs(self.session_dir)
        self.process_dir = synthetic.build_session(self.session_dir)

    def test_load_session_state_finds_the_hash_dir_and_overwrites_the_stale_paths(self):
        """The paths inside the file name a WSL machine. e2a overwrites both with
        the directories it actually walked, and so does narrator - that overwrite
        is what makes a session portable between Windows and WSL."""
        state = session_store.load_session_state(self.session_dir)
        self.assertIsNotNone(state)
        self.assertEqual(state['process_dir'], self.process_dir)
        self.assertEqual(state['session_dir'], self.session_dir)
        self.assertNotIn('/home/telltale', state['process_dir'])

    def test_no_session_anywhere_is_none_not_an_error(self):
        empty = os.path.join(self.root, 'nothing-here')
        os.makedirs(empty)
        self.assertIsNone(session_store.load_session_state(empty))
        self.assertIsNone(session_store.load_session_state(
            os.path.join(self.root, 'does-not-exist')))

    def test_a_corrupt_state_raises_rather_than_reading_as_no_session(self):
        """e2a hardened this deliberately: treating a corrupt state as "no
        session" made callers start fresh OVER an existing session's rendered
        files. (worker_core.py keeps an older copy that still swallows it; the
        loud one is ported - see PORT_NOTES.md.)"""
        with open(os.path.join(self.process_dir, 'session-state.json'), 'w',
                  encoding='utf-8') as f:
            f.write('{ not json')
        with self.assertRaises(SessionStateError) as caught:
            session_store.load_session_state(self.session_dir)
        self.assertIn('Refusing to treat it as "no session"', str(caught.exception))

    def test_resolve_process_dir_accepts_either_shape(self):
        self.assertEqual(session_store.resolve_process_dir(self.session_dir),
                         self.process_dir)
        self.assertEqual(session_store.resolve_process_dir(self.process_dir),
                         self.process_dir)

    def test_resolve_process_dir_refuses_rather_than_guessing(self):
        empty = os.path.join(self.root, 'empty')
        os.makedirs(empty)
        with self.assertRaises(SessionStateError):
            session_store.resolve_process_dir(empty)

    def test_require_v2_names_the_version_it_found(self):
        with self.assertRaises(SessionStateError) as caught:
            session_store.require_v2({'version': 1}, 'somewhere')
        self.assertIn('version is 1', str(caught.exception))

    def test_the_sentences_dir_precedence_is_e2as(self):
        state = session_store.load_session_state(self.session_dir)
        # 1. the explicit override wins
        self.assertEqual(session_store.sentences_dir_for(state, '/override'),
                         '/override')
        # 2. then the stored key (stale here, on purpose - the bridge rewrites it)
        self.assertEqual(session_store.sentences_dir_for(state),
                         '/nonexistent/chapters/sentences')
        # 3. then the derived path
        del state['chapters_dir_sentences']
        self.assertEqual(
            session_store.sentences_dir_for(state),
            os.path.join(self.process_dir, 'chapters', 'sentences'))


class ScanTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-scan-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_scan_parity_against_every_golden_sentences_json(self):
        """`sentences.json` lists every FLAC the golden session actually holds,
        with its byte size. Recreating that directory with the same sizes and
        scanning it must reproduce exactly the same completed/missing split."""
        for slug in SLUGS:
            with self.subTest(slug=slug):
                with open(os.path.join(GOLDEN_DIR, slug, 'sentences.json'),
                          encoding='utf-8') as f:
                    rows = json.load(f)
                state = load_golden(slug)
                total = state['total_sentences']
                present = {row['index']: row['bytes'] for row in rows}

                sentences_dir = os.path.join(self.root, slug)
                os.makedirs(sentences_dir)
                for index, size in present.items():
                    with open(os.path.join(sentences_dir, f'{index}.flac'), 'wb') as f:
                        f.write(b'\x00' * size)

                scan = session_store.scan_completed_sentences(sentences_dir, total)
                expected_done = sorted(i for i, size in present.items()
                                       if size >= session_store.MIN_RENDERED_FILE_BYTES)
                self.assertEqual(scan['completed'], expected_done)
                self.assertEqual(scan['completed_count'], len(expected_done))
                self.assertEqual(scan['missing_count'], total - len(expected_done))
                self.assertEqual(
                    scan['progress_percent'],
                    round(len(expected_done) / total * 100, 1))
                self.assertEqual(
                    sorted(scan['completed'] + scan['missing']), list(range(total)))

    def test_blacksun_is_a_partially_rendered_session(self):
        """The fixture chosen for exactly this: 512 of 2358 chunks. If a change
        made every golden complete, the partial path would stop being tested."""
        with open(os.path.join(GOLDEN_DIR, 'blacksun', 'sentences.json'),
                  encoding='utf-8') as f:
            rows = json.load(f)
        state = load_golden('blacksun')
        self.assertLess(len(rows), state['total_sentences'])

    def test_a_file_below_the_floor_is_missing(self):
        sentences_dir = os.path.join(self.root, 'floor')
        os.makedirs(sentences_dir)
        with open(os.path.join(sentences_dir, '0.flac'), 'wb') as f:
            f.write(b'\x00' * 1023)
        with open(os.path.join(sentences_dir, '1.flac'), 'wb') as f:
            f.write(b'\x00' * 1024)
        scan = session_store.scan_completed_sentences(sentences_dir, 2)
        self.assertEqual(scan['missing'], [0])
        self.assertEqual(scan['completed'], [1])

    def test_the_extension_order_is_flac_wav_mp3_and_first_hit_wins(self):
        sentences_dir = os.path.join(self.root, 'ext')
        os.makedirs(sentences_dir)
        # A tiny flac beside a big wav: e2a breaks on the FIRST extension that
        # EXISTS and is big enough, and a too-small flac does not stop the walk.
        with open(os.path.join(sentences_dir, '0.flac'), 'wb') as f:
            f.write(b'\x00' * 10)
        with open(os.path.join(sentences_dir, '0.wav'), 'wb') as f:
            f.write(b'\x00' * 5000)
        scan = session_store.scan_completed_sentences(sentences_dir, 1)
        self.assertEqual(scan['completed'], [0])

    def test_an_empty_book_reports_zero_percent_rather_than_dividing_by_zero(self):
        sentences_dir = os.path.join(self.root, 'empty')
        os.makedirs(sentences_dir)
        scan = session_store.scan_completed_sentences(sentences_dir, 0)
        self.assertEqual(scan['progress_percent'], 0)

    def test_missing_ranges_collapse_to_contiguous_runs(self):
        self.assertEqual(session_store.calculate_missing_ranges([]), [])
        self.assertEqual(
            session_store.calculate_missing_ranges([3, 4, 5, 9, 11, 12]),
            [{'start': 3, 'end': 5, 'count': 3},
             {'start': 9, 'end': 9, 'count': 1},
             {'start': 11, 'end': 12, 'count': 2}])
        self.assertEqual(session_store.calculate_missing_ranges([7]),
                         [{'start': 7, 'end': 7, 'count': 1}])


class ListAndResumeTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-R-list-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.session_dir = os.path.join(self.root, 'ebook-ccd14111')
        os.makedirs(self.session_dir)
        self.process_dir = synthetic.build_session(self.session_dir)
        self.sentences_dir = os.path.join(self.process_dir, 'chapters', 'sentences')
        self._saved_root = os.environ.get('NARRATOR_SESSIONS_ROOT')
        os.environ['NARRATOR_SESSIONS_ROOT'] = self.root

    def tearDown(self):
        if self._saved_root is None:
            os.environ.pop('NARRATOR_SESSIONS_ROOT', None)
        else:
            os.environ['NARRATOR_SESSIONS_ROOT'] = self._saved_root

    def test_a_complete_session_is_not_resumable(self):
        self.assertEqual(session_store.list_resumable_sessions(self.root), [])

    def test_an_incomplete_session_is_listed_with_e2as_field_set(self):
        os.remove(os.path.join(self.sentences_dir, '4.flac'))
        listed = session_store.list_resumable_sessions(self.root)
        self.assertEqual(len(listed), 1)
        row = listed[0]
        self.assertEqual(set(row), {
            'session_id', 'session_dir', 'title', 'total_sentences',
            'completed_sentences', 'missing_sentences', 'progress_percent',
            'created_at', 'language', 'voice'})
        self.assertEqual(row['missing_sentences'], 1)
        self.assertEqual(row['completed_sentences'], 9)
        self.assertEqual(row['title'], 'A Synthetic Book')

    def test_a_directory_that_is_not_ebook_prefixed_is_skipped(self):
        os.remove(os.path.join(self.sentences_dir, '4.flac'))
        os.rename(self.session_dir, os.path.join(self.root, 'something-else'))
        self.assertEqual(session_store.list_resumable_sessions(self.root), [])

    def test_the_sessions_root_env_is_the_whole_interface(self):
        """And the refusal must say what to do instead, because the variable is
        genuinely absent inside WSL: the guest arm of `buildNarratorSpawn`
        exports only the caller's `envExtras` plus four of its own, and this is
        not one of them. Every live render/retake spawn passes --session_dir."""
        os.environ.pop('NARRATOR_SESSIONS_ROOT', None)
        with self.assertRaises(SessionStateError) as caught:
            session_store.sessions_root()
        message = str(caught.exception)
        self.assertIn('NARRATOR_SESSIONS_ROOT is not set', message)
        self.assertIn('pass --session_dir', message)
        self.assertIn('will not guess', message)

    def test_the_old_name_is_refused_by_name_not_accepted_as_an_alias(self):
        """`E2A_TMP_DIR` named this variable until 2026-09-05.

        Honouring it as an alias is the failure this refusal exists to prevent:
        a machine with a stale export would keep rendering while every other name
        in the system said narrator, and nothing would report the disagreement
        until the two roots differed - at which point a book is written into a
        directory nothing looks in, with a success exit code.

        It fires EVEN WHEN the new variable is also set, because "both are set"
        is precisely the half-migrated machine.
        """
        os.environ['E2A_TMP_DIR'] = self.root
        self.addCleanup(os.environ.pop, 'E2A_TMP_DIR', None)
        with self.assertRaises(SessionStateError) as caught:
            session_store.sessions_root()
        message = str(caught.exception)
        self.assertIn('E2A_TMP_DIR is set', message)
        self.assertIn('NARRATOR_SESSIONS_ROOT', message)

    def test_the_old_name_is_refused_on_every_door_not_only_the_root_readers(self):
        """A door carrying `--session_dir` never reaches `sessions_root()`, so
        `compat.app.main` refuses BEFORE the flag parse - otherwise a render
        would proceed happily on a machine still exporting the old name, which
        is exactly "keeps working by accident"."""
        import io
        from contextlib import redirect_stdout
        from ..compat import app as compat_app

        os.environ['E2A_TMP_DIR'] = self.root
        self.addCleanup(os.environ.pop, 'E2A_TMP_DIR', None)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = compat_app.main(['--headless', '--list_sessions'])
        self.assertEqual(code, 1)
        self.assertIn('E2A_TMP_DIR is set', buf.getvalue())

    def test_the_listing_is_not_sorted_because_e2as_is_not(self):
        """`session.py:230` iterates raw `os.listdir`. Nothing reads the order -
        the one caller discards the whole answer - so matching costs nothing."""
        import inspect
        source = inspect.getsource(session_store.list_resumable_sessions)
        self.assertIn('for session_name in os.listdir(root):', source)
        self.assertNotIn('sorted(os.listdir(root))', source)

    def test_resume_on_a_complete_session_reports_ready_for_assembly(self):
        result = session_store.resume_session(self.session_dir)
        self.assertTrue(result['success'])
        self.assertTrue(result['complete'])
        self.assertEqual(result['message'],
                         'All sentences already complete - ready for assembly')

    def test_resume_reports_every_field_the_bridge_maps(self):
        """`parallel-tts-bridge.ts:8818-8840` maps these snake_case names onto its
        own camelCase result. A dropped key becomes an `undefined` in the app."""
        for i in (2, 3, 7):
            os.remove(os.path.join(self.sentences_dir, f'{i}.flac'))
        result = session_store.resume_session(self.session_dir)

        for key in ('success', 'complete', 'session_id', 'session_dir',
                    'process_dir', 'total_sentences', 'total_chapters',
                    'completed_sentences', 'missing_sentences', 'missing_indices',
                    'missing_ranges', 'progress_percent', 'chapters', 'metadata',
                    'warnings'):
            self.assertIn(key, result, key)
        self.assertEqual(result['missing_indices'], [2, 3, 7])
        self.assertEqual(result['missing_ranges'],
                         [{'start': 2, 'end': 3, 'count': 2},
                          {'start': 7, 'end': 7, 'count': 1}])
        self.assertEqual(result['completed_sentences'], 7)

    def test_resume_accepts_a_bare_uuid_under_the_root(self):
        """e2a's three input shapes (session.py:293-299): an absolute directory,
        an `ebook-`-prefixed name, or a bare id that gets the prefix."""
        os.remove(os.path.join(self.sentences_dir, '0.flac'))
        by_uuid = session_store.resume_session('ccd14111')
        by_name = session_store.resume_session('ebook-ccd14111')
        by_path = session_store.resume_session(self.session_dir)
        self.assertTrue(by_uuid['success'], by_uuid)
        self.assertEqual(by_uuid['missing_indices'], [0])
        self.assertEqual(by_uuid['session_dir'], by_name['session_dir'])
        self.assertEqual(by_uuid['session_dir'], by_path['session_dir'])

    def test_resume_on_a_missing_directory_says_which(self):
        result = session_store.resume_session(os.path.join(self.root, 'gone'))
        self.assertFalse(result['success'])
        self.assertIn('Session directory not found', result['error'])

    def test_a_changed_setting_warns_but_stays_compatible(self):
        """e2a NEVER refuses a resume; it only warns, and only about the two keys
        it compares. A state with no `voice` (the Orpheus shape - the voice is in
        `fine_tuned`) can only produce the engine warning."""
        state = session_store.load_session_state(self.session_dir)
        self.assertNotIn('voice', state)
        compat = session_store.check_resume_compatibility(
            state, voice='someone-else', tts_engine='xtts')
        self.assertTrue(compat['compatible'])
        self.assertEqual(compat['warnings'],
                         ["TTS engine changed from 'orpheus' to 'xtts'"])

        state['voice'] = 'old-clip.wav'
        compat = session_store.check_resume_compatibility(
            state, voice='new-clip.wav', tts_engine='orpheus')
        self.assertEqual(compat['warnings'],
                         ["Voice changed from 'old-clip.wav' to 'new-clip.wav'"])


if __name__ == '__main__':
    unittest.main()
