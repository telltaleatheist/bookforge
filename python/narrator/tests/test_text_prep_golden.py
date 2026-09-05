"""GOLDEN PARITY: narrator's prep against the sessions e2a actually produced.

This is the deliverable of migration step 4. For each golden the prepared chunk
list is compared to the `chapter_sentences` in that session's committed
`tests/golden/<slug>/session-state.json`, chapter by chapter, plus `chapters[]`
ranges, `chapter_titles`, `chapter_docs`, `chapter_titles_by_doc`,
`total_sentences`, `total_chapters`, `cover`, `final_name` and `filename_noext`.

## The cap is a fixture fact

`ORPHEUS_MAX_CHARS` is the packing cap and BookForge injects it per voice from
`electron/data/orpheus-models.json` (`parallel-tts-bridge.ts:3300-3306`). The
catalog MOVES - thirdreich has been 470, 500 and 540 in three weeks - so the
value each session was prepped with is pinned here from the catalog commit that
was current at that session's `created_at`, NOT read from today's catalog. Getting
it wrong changes every chunk boundary, so it is stated with its provenance.

## blacksun cannot match, and the reason is measured

blacksun was prepped 2026-08-31, before e2a commit `b33f2f78` (2026-09-02) made
the packer measure rows AS PRINTED. Until then an Orpheus row was measured through
`expand_digits(normalize_scripture(s))`, so `'in 1959.'` counted as 16 characters
longer and the cap bounded the EXPANDED length. Restoring that one function
reproduces blacksun EXACTLY (2358 chunks, all 18 chapters byte-identical);
9daab0ba's identity form gives 2310. Measured 2026-09-04 - see
`text/PORT_NOTES.md` section 6.

So blacksun is asserted on what a faithful port MUST still hold: **the spoken text
of every chapter is identical, character for character**. Only chunk BOUNDARIES
moved. If a future golden is re-prepped at 9daab0ba or later, move its slug into
`BYTE_IDENTICAL` and this test gets stricter for free.

## Skips

Skips ONLY when `C:\\tmp\\narrator-golden` (or `$NARRATOR_GOLDEN_LOCAL`) is absent
- that is the one permitted "missing input" behaviour in CONTRACTS.md, and it is
the staged EPUBs that live there. NOTHING here needs a stanza model, so there is
no stanza skip to write: `text/sentences.py` records the measurement that e2a's
stanza pipeline is never consulted on the Orpheus path, and this test is the proof
- it produces byte-identical chunk lists on an interpreter with no stanza resources
at all.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from narrator.text import epub as epub_mod                 # noqa: E402
from narrator.text.prep import PrepOptions, prep_session    # noqa: E402
from narrator.text.sml import SML_UNSPOKEN_PATTERN          # noqa: E402

def _default_golden_local() -> str:
    """`C:\\tmp\\narrator-golden` - as THIS interpreter can reach it.

    CONTRACTS.md names the Windows path, and the WSL interpreter sees the same
    bytes at `/mnt/c/tmp/narrator-golden`. Without the translation the whole
    parity suite SKIPPED under WSL (Ran 0, skipped=1) while `text/sentences.py`
    claimed it was proven under both interpreters - the claim was true only
    because the WSL run had been given `NARRATOR_GOLDEN_LOCAL` by hand.
    """
    if os.name == 'nt':
        return r'C:\tmp\narrator-golden'
    if os.path.isdir('/mnt/c'):
        return '/mnt/c/tmp/narrator-golden'
    return r'C:\tmp\narrator-golden'


GOLDEN_LOCAL = os.environ.get('NARRATOR_GOLDEN_LOCAL') or _default_golden_local()
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'golden')

#: slug -> (ORPHEUS_MAX_CHARS, the catalog commit that set it, the voice).
#: See the module docstring: pinned from history, never read from today's catalog.
CAPS = {
    'kershaw': (430, 'f429050c (2026-09-02 21:09)', 'mistborn'),
    'blacksun': (500, '9d9687b9 (2026-08-28 22:39)', 'thirdreich'),
    'mutineer': (520, 'c1dbda5f (2026-09-04 11:28)', 'deathstalker'),
}

#: The goldens prepped at or after e2a b33f2f78 (2026-09-02), which narrator
#: reproduces byte for byte.
BYTE_IDENTICAL = ('kershaw', 'mutineer')

#: Prepped BEFORE b33f2f78, so the packer measured expanded lengths. Asserted on
#: spoken-text identity instead; see the module docstring.
BOUNDARIES_ONLY = ('blacksun',)

#: Every state key compared by value.
COMPARED_KEYS = (
    'version', 'total_sentences', 'total_chapters', 'chapters', 'language',
    'language_iso1', 'voice', 'fine_tuned', 'custom_model', 'orpheus_model_dir',
    'orpheus_adapter_dir', 'orpheus_base_dir', 'tts_engine', 'device',
    'output_format', 'status', 'cover', 'final_name', 'filename_noext',
    'chapter_titles', 'chapter_docs', 'chapter_titles_by_doc',
)

#: Every state key NOT compared by value, and WHY. Nothing may be left out of
#: the comparison silently: `test_the_two_key_sets_account_for_every_key`
#: asserts that COMPARED_KEYS + these = the whole key set, on both sides.
EXCLUDED_KEYS = {
    'chapter_sentences':
        'the chunk list - compared chunk by chunk by its own tests, so that a '
        'difference is reported verbatim rather than as "a list differs"',
    'metadata':
        "rewritten AFTER prep by reassembly-bridge.ts:1117-1159, so the golden's "
        "copy is BookForge's project metadata rather than the EPUB's Dublin "
        'Core. Prep-side shape is asserted separately',
    'bookforge_metadata':
        'same writer, same reason; prep always writes {} because no CLI flag has '
        'ever set it',
    'epub_path': 'an absolute path on the machine that prepped the book',
    'source_epub_path': 'an absolute path on the machine that prepped the book',
    'epub_path_internal': 'an absolute path on the machine that prepped the book',
    'session_dir': 'an absolute path on the machine that prepped the book',
    'process_dir': 'an absolute path on the machine that prepped the book',
    'chapters_dir': 'an absolute path on the machine that prepped the book',
    'chapters_dir_sentences':
        'an absolute path on the machine that prepped the book',
    'epub_content_hash':
        'md5 of an absolute POSIX path on the WSL machine (see PORT_NOTES 5.1); '
        'compared BY RULE on both sides instead',
    'session_id': 'passed in by the test, so comparing it proves nothing',
    'created_at': 'a wall-clock timestamp',
    'updated_at': 'a wall-clock timestamp',
    'audiobooks_dir':
        'narrator writes null where e2a wrote <e2a_root>/audiobooks/cli - '
        'declared behaviour difference, PORT_NOTES 3.3. Nothing reads it',
    'custom_model_dir':
        'narrator writes null where e2a wrote <models_dir>/__sessions/'
        'model-<id> - same declared difference, PORT_NOTES 3.3. Nothing on the '
        'Orpheus path reads it',
}

#: Keys narrator ADDS that e2a never wrote, so the goldens cannot carry them.
#: Additive by design and asserted to be exactly this set, so a key cannot be
#: added to the state without a test saying why.
NARRATOR_ADDED_KEYS = {
    'higgs_voice':
        "the Higgs voice, a CATALOG ID. Higgs has no --fine_tuned voice TOKEN, "
        'so it gets its own key rather than sharing one that names a different '
        'kind of thing. Always null on an Orpheus prep, which is every golden',
    'bookforge_chunking':
        'which chunking policy built the chunks (text/paragraph_packer.py, '
        "2026-09-04). Always {'policy': 'e2a'} on the default path, which is "
        'what every golden was prepped with. Additive: it sorts last and every '
        'existing reader reads named fields',
}


def _index() -> dict:
    with open(os.path.join(GOLDEN_LOCAL, 'index.json'), encoding='utf-8') as f:
        return json.load(f)


def _local_process_dir(entry: dict) -> str:
    """The golden's process dir, as this interpreter can reach it. The index is
    written with Windows paths; under WSL the same bytes live at /mnt/c."""
    p = entry['localProcessDir']
    if os.name != 'nt':
        p = p.replace('C:\\', '/mnt/c/').replace('\\', '/')
    return p


def _spoken_chapter(chunks) -> str:
    return re.sub(r'\s+', ' ',
                  ' '.join(SML_UNSPOKEN_PATTERN.sub('', c) for c in chunks)).strip()


class GoldenParityTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not os.path.isdir(GOLDEN_LOCAL):
            raise unittest.SkipTest(
                f'golden binaries absent at {GOLDEN_LOCAL} - set '
                f'$NARRATOR_GOLDEN_LOCAL to the directory holding index.json, '
                f'or run the golden builder. (The staged EPUBs each session was '
                f'prepped from live there; the committed session-state.json '
                f'fixtures alone are not enough to re-prep. Under WSL the '
                f'Windows copy is visible at /mnt/c/tmp/narrator-golden, which '
                f'is this interpreter default.)')
        cls.index = _index()
        cls.root = tempfile.mkdtemp(prefix='narrator-T-golden-')
        cls.prepared = {}
        cls.gold = {}
        for slug, (cap, _why, _voice) in CAPS.items():
            gold_path = os.path.join(FIXTURES, slug, 'session-state.json')
            with open(gold_path, encoding='utf-8') as f:
                gold = json.load(f)
            cls.gold[slug] = gold
            proc = _local_process_dir(cls.index[slug])
            staged = [f for f in os.listdir(proc)
                      if f.startswith('staged-') and f.endswith('.epub')]
            if not staged:
                raise unittest.SkipTest(
                    f'{slug}: no staged-*.epub in {proc}; the golden copy is '
                    f'incomplete and prep cannot be re-run')
            saved = os.environ.get('ORPHEUS_MAX_CHARS')
            os.environ['ORPHEUS_MAX_CHARS'] = str(cap)
            try:
                with redirect_stdout(io.StringIO()):
                    cls.prepared[slug] = prep_session(
                        os.path.join(proc, staged[0]),
                        os.path.join(cls.root, slug,
                                     'ebook-' + gold['session_id']),
                        PrepOptions(
                            session=gold['session_id'],
                            language=gold['language'],
                            tts_engine=gold['tts_engine'],
                            fine_tuned=gold['fine_tuned'],
                            voice=gold['voice'],
                            device=gold['device'],
                            output_format=gold['output_format'],
                            custom_model=gold['custom_model'],
                            orpheus_model_dir=gold['orpheus_model_dir'],
                            orpheus_adapter_dir=gold['orpheus_adapter_dir'],
                            orpheus_base_dir=gold['orpheus_base_dir'],
                        ),
                    )
            finally:
                if saved is None:
                    os.environ.pop('ORPHEUS_MAX_CHARS', None)
                else:
                    os.environ['ORPHEUS_MAX_CHARS'] = saved

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, 'root', ''), ignore_errors=True)

    # -- the chunk lists ---------------------------------------------------

    def _assert_chunks_identical(self, slug):
        mine = self.prepared[slug].state['chapter_sentences']
        gold = self.gold[slug]['chapter_sentences']
        self.assertEqual(len(mine), len(gold),
                         f'{slug}: {len(mine)} chapters, want {len(gold)}')
        for ci, (a, b) in enumerate(zip(mine, gold), start=1):
            if a == b:
                continue
            # Report the FIRST difference verbatim - a chunk boundary change is
            # an ear-check for Owen, never something to smooth over.
            for i, (x, y) in enumerate(zip(a, b)):
                if x != y:
                    self.fail(
                        f'{slug} chapter {ci}: chunk {i} differs\n'
                        f'  narrator: {x!r}\n'
                        f'  golden  : {y!r}\n'
                        f'  ({len(a)} chunks vs {len(b)})')
            self.fail(f'{slug} chapter {ci}: {len(a)} chunks vs {len(b)}, '
                      f'identical up to the shorter one')

    def test_kershaw_chunks_are_byte_identical(self):
        self._assert_chunks_identical('kershaw')

    def test_mutineer_chunks_are_byte_identical(self):
        self._assert_chunks_identical('mutineer')

    def test_blacksun_speaks_the_same_text_even_though_boundaries_moved(self):
        """Prepped before e2a b33f2f78; see the module docstring. What must still
        hold, and does: not one character of SPOKEN text moved."""
        mine = self.prepared['blacksun'].state['chapter_sentences']
        gold = self.gold['blacksun']['chapter_sentences']
        self.assertEqual(len(mine), len(gold))
        for ci, (a, b) in enumerate(zip(mine, gold), start=1):
            sa, sb = _spoken_chapter(a), _spoken_chapter(b)
            if sa == sb:
                continue
            for i, (x, y) in enumerate(zip(sa, sb)):
                if x != y:
                    self.fail(
                        f'blacksun chapter {ci}: spoken text differs at char {i}\n'
                        f'  narrator: {sa[max(0, i - 80):i + 80]!r}\n'
                        f'  golden  : {sb[max(0, i - 80):i + 80]!r}')
            self.fail(f'blacksun chapter {ci}: spoken text lengths differ '
                      f'({len(sa)} vs {len(sb)})')

    def test_blacksun_is_the_only_golden_whose_boundaries_moved(self):
        """Guards the exception itself: if blacksun is re-prepped at 9daab0ba or
        later this test fails and its slug moves into BYTE_IDENTICAL."""
        mine = self.prepared['blacksun'].state['chapter_sentences']
        gold = self.gold['blacksun']['chapter_sentences']
        self.assertNotEqual(
            mine, gold,
            'blacksun now matches byte for byte - move its slug from '
            'BOUNDARIES_ONLY into BYTE_IDENTICAL and delete this test')

    # -- everything else in the state --------------------------------------

    def test_every_compared_state_key_matches_for_every_golden(self):
        for slug in CAPS:
            state = self.prepared[slug].state
            gold = self.gold[slug]
            for key in COMPARED_KEYS:
                if slug in BOUNDARIES_ONLY and key in (
                        'total_sentences', 'chapters'):
                    # Both are counts OF the chunks, so they move with the
                    # boundaries; the chunk assertion above owns that case.
                    continue
                self.assertEqual(state.get(key), gold.get(key),
                                 f'{slug}: session-state key {key!r} differs')

    def test_the_two_key_sets_account_for_every_key_on_both_sides(self):
        """No key may fall out of the comparison silently. Every key narrator
        writes and every key the golden holds is either compared by value or
        listed in EXCLUDED_KEYS with a reason."""
        accounted = (set(COMPARED_KEYS) | set(EXCLUDED_KEYS)
                     | set(NARRATOR_ADDED_KEYS))
        for slug in CAPS:
            mine = set(self.prepared[slug].state)
            gold = set(self.gold[slug])
            self.assertEqual(mine - gold, set(NARRATOR_ADDED_KEYS),
                             f'{slug}: narrator writes key(s) the golden does '
                             f'not have, beyond the declared additions')
            self.assertEqual(gold - mine, set(),
                             f'{slug}: the golden has key(s) narrator does not '
                             f'write: {sorted(gold - mine)}')
            self.assertEqual(mine - accounted, set(),
                             f'{slug}: key(s) neither compared nor excluded')
            self.assertEqual(accounted - mine, set(),
                             f'{slug}: EXCLUDED_KEYS names a key that does not '
                             f'exist')

    def test_the_default_prep_records_the_e2a_chunking_policy(self):
        """The policy switch must be invisible on the default path: every golden
        was prepped by e2a's packer, and so was this run."""
        for slug in CAPS:
            self.assertEqual(self.prepared[slug].state['bookforge_chunking'],
                             {'policy': 'e2a'}, slug)

    def test_every_excluded_key_carries_a_reason(self):
        for key, reason in {**EXCLUDED_KEYS, **NARRATOR_ADDED_KEYS}.items():
            self.assertTrue(reason and len(reason) > 20,
                            f'{key} is excluded without a reason')

    def test_the_two_install_relative_keys_are_null_by_design(self):
        """PORT_NOTES 3.3: narrator has no ebook2audiobook installation to be
        relative to and will not invent one. e2a wrote a path into both."""
        for slug in CAPS:
            state = self.prepared[slug].state
            self.assertIsNone(state['audiobooks_dir'], slug)
            self.assertIsNone(state['custom_model_dir'], slug)
            # ...and the golden, prepped by e2a, holds e2a's install path.
            self.assertTrue(self.gold[slug]['custom_model_dir']
                            .endswith(f"model-{self.gold[slug]['session_id']}"),
                            slug)

    def test_the_chapter_ranges_are_contiguous_and_cover_every_chunk(self):
        for slug in CAPS:
            state = self.prepared[slug].state
            offset = 0
            for i, ch in enumerate(state['chapters'], start=1):
                self.assertEqual(ch['chapter_num'], i, slug)
                self.assertEqual(ch['sentence_start'], offset, slug)
                self.assertEqual(ch['sentence_end'],
                                 offset + ch['sentence_count'] - 1, slug)
                self.assertEqual(ch['sentence_count'],
                                 len(state['chapter_sentences'][i - 1]), slug)
                offset += ch['sentence_count']
            self.assertEqual(offset, state['total_sentences'], slug)

    def test_chapter_docs_stays_index_aligned_with_the_chapters(self):
        for slug in CAPS:
            state = self.prepared[slug].state
            self.assertEqual(len(state['chapter_docs']),
                             len(state['chapter_sentences']), slug)

    def test_the_provenance_sidecar_holds_what_the_state_holds(self):
        for slug in CAPS:
            outcome = self.prepared[slug]
            path = os.path.join(outcome.process_dir, 'chapter-provenance.json')
            self.assertTrue(os.path.isfile(path), slug)
            with open(path, encoding='utf-8') as f:
                prov = json.load(f)
            self.assertEqual(prov['chapter_docs'], outcome.state['chapter_docs'])
            self.assertEqual(prov['chapter_titles_by_doc'],
                             outcome.state['chapter_titles_by_doc'])
            self.assertEqual(prov['chapter_titles'],
                             outcome.state['chapter_titles'])

    def test_the_state_file_on_disk_round_trips_to_the_state_returned(self):
        for slug in CAPS:
            outcome = self.prepared[slug]
            with open(outcome.state_path, encoding='utf-8') as f:
                on_disk = json.load(f)
            self.assertEqual(on_disk, outcome.state, slug)

    def test_prep_writes_no_cover_because_none_of_these_books_carries_one(self):
        """All three goldens say `cover: true`, which means "no cover found".
        A live process_dir's `cover.jpg` is BookForge's, not prep's."""
        for slug in CAPS:
            outcome = self.prepared[slug]
            self.assertIs(outcome.state['cover'], True, slug)
            self.assertFalse(
                os.path.isfile(os.path.join(
                    outcome.process_dir,
                    outcome.state['filename_noext'] + '.jpg')), slug)

    # -- epub_content_hash, compared BY RULE -------------------------------

    def test_the_content_hash_rule_holds_on_both_sides(self):
        """The stored value is md5 of an absolute POSIX path on the WSL machine
        that prepped the book, so a run under any other root cannot reproduce it
        and must not fake it. What IS comparable is the RULE, proven twice."""
        for slug in CAPS:
            state = self.prepared[slug].state
            self.assertEqual(state['epub_content_hash'],
                             hashlib.md5(state['epub_path_internal'].encode())
                             .hexdigest(), slug)
            gold = self.gold[slug]
            self.assertEqual(gold['epub_content_hash'],
                             hashlib.md5(gold['epub_path_internal'].encode())
                             .hexdigest(),
                             f'{slug}: the GOLDEN does not follow the rule')

    def test_the_process_dir_is_named_by_the_ebook_arguments_hash(self):
        for slug in CAPS:
            outcome = self.prepared[slug]
            self.assertEqual(
                os.path.basename(outcome.process_dir),
                epub_mod.path_md5(outcome.state['source_epub_path']), slug)

    # -- the two keys prep does NOT own ------------------------------------

    def test_metadata_is_what_the_epub_says_not_what_the_golden_stores(self):
        """`metadata` and `bookforge_metadata` in a live session-state are
        BookForge's, written after prep by `reassembly-bridge.ts:1117-1159`. Prep
        writes exactly {title, creator, language} from Dublin Core, and
        `bookforge_metadata` as {} - no CLI flag has ever set it."""
        for slug in CAPS:
            state = self.prepared[slug].state
            self.assertEqual(set(state['metadata']),
                             {'title', 'creator', 'language'}, slug)
            self.assertEqual(state['bookforge_metadata'], {}, slug)
        # blacksun never went through the reassembly metadata write, so its
        # golden still carries prep's own empty dict - which is the evidence for
        # the claim above.
        self.assertEqual(self.gold['blacksun']['bookforge_metadata'], {})
        self.assertEqual(set(self.gold['blacksun']['metadata']),
                         {'title', 'creator', 'language'})
        # ...and kershaw's does not, because BookForge overwrote it.
        self.assertIn('published', self.gold['kershaw']['metadata'])


class HiggsGapFileTest(unittest.TestCase):
    """A pads=False prep of a REAL book writes the gap file the assembler needs.

    Driven on the kershaw staged EPUB rather than a synthetic one, because the
    thing under test is that EVERY chunk of a real chapter gets a key: a book
    with headings, an epigraph and 60-odd paragraphs is what makes an off-by-one
    in the global index visible.
    """

    @classmethod
    def setUpClass(cls):
        if not os.path.isdir(GOLDEN_LOCAL):
            raise unittest.SkipTest(
                f'golden binaries absent at {GOLDEN_LOCAL} - set '
                f'$NARRATOR_GOLDEN_LOCAL to the directory holding index.json')
        from narrator.text.paragraph_packer import CatalogBudget

        entry = _index()['kershaw']
        proc = _local_process_dir(entry)
        staged = [f for f in os.listdir(proc)
                  if f.startswith('staged-') and f.endswith('.epub')]
        if not staged:
            raise unittest.SkipTest('kershaw: no staged-*.epub in the golden copy')

        cls.root = tempfile.mkdtemp(prefix='narrator-T-gaps-')
        with redirect_stdout(io.StringIO()):
            cls.higgs = prep_session(
                os.path.join(proc, staged[0]),
                os.path.join(cls.root, 'higgs', 'ebook-h'),
                PrepOptions(session='h', language='eng', tts_engine='higgs-v3',
                            higgs_voice='ds_ad4l', chunking='paragraph',
                            source_kind='pdf-derived',
                            budget=CatalogBudget(chars=1500, chars_per_sec=22.6)))
            saved = os.environ.get('ORPHEUS_MAX_CHARS')
            os.environ['ORPHEUS_MAX_CHARS'] = '430'
            try:
                cls.orpheus = prep_session(
                    os.path.join(proc, staged[0]),
                    os.path.join(cls.root, 'orpheus', 'ebook-o'),
                    PrepOptions(session='o', language='eng',
                                fine_tuned='mistborn'))
            finally:
                if saved is None:
                    os.environ.pop('ORPHEUS_MAX_CHARS', None)
                else:
                    os.environ['ORPHEUS_MAX_CHARS'] = saved

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, 'root', ''), ignore_errors=True)

    def _gap_path(self, outcome):
        return os.path.join(outcome.process_dir, 'chapters', 'sentences',
                            'gaps.json')

    def test_the_higgs_prep_of_kershaw_writes_a_key_for_every_chunk(self):
        from narrator.text.prep import GAPS_VERSION

        with open(self._gap_path(self.higgs), encoding='utf-8') as f:
            payload = json.load(f)
        total = self.higgs.state['total_sentences']
        self.assertEqual(payload['version'], GAPS_VERSION)
        self.assertEqual(payload['engine'], 'higgs-v3')
        self.assertEqual(sorted(int(k) for k in payload['gaps']),
                         list(range(total)))
        self.assertGreater(total, 50, 'kershaw should be a real chapter')

    def test_every_value_is_classify_gaps_own_answer_for_that_chunk(self):
        from narrator.text.gaps import classify_gap_seconds

        with open(self._gap_path(self.higgs), encoding='utf-8') as f:
            gaps = json.load(f)['gaps']
        flat = [c for chapter in self.higgs.state['chapter_sentences']
                for c in chapter]
        for index, chunk in enumerate(flat):
            before, after = classify_gap_seconds(chunk)
            self.assertEqual(gaps[str(index)],
                             {'before': before, 'after': after},
                             f'chunk {index}: {chunk[:70]!r}')

    def test_the_heading_chunk_is_covered_like_every_other_kind(self):
        """kershaw opens on a heading. At 9daab0ba it classifies to the same
        floor as prose - the 2026-07-17 ruling - and the point of the assertion
        is that it is PRESENT and matches the classifier, not that it differs."""
        from narrator.text.gaps import classify_gap_seconds
        from narrator.text.sml import SML_HEADING_PATTERN

        flat = [c for chapter in self.higgs.state['chapter_sentences']
                for c in chapter]
        headings = [i for i, c in enumerate(flat)
                    if SML_HEADING_PATTERN.search(c)]
        self.assertTrue(headings, 'kershaw has no heading chunk to check')
        with open(self._gap_path(self.higgs), encoding='utf-8') as f:
            gaps = json.load(f)['gaps']
        for i in headings:
            self.assertEqual(gaps[str(i)],
                             dict(zip(('before', 'after'),
                                      classify_gap_seconds(flat[i]))))

    def test_the_orpheus_prep_of_the_same_book_writes_none(self):
        self.assertFalse(os.path.exists(self._gap_path(self.orpheus)))
        # ...and still produced the parity chunk list.
        self.assertEqual(self.orpheus.state['total_sentences'], 133)


if __name__ == '__main__':
    unittest.main()
