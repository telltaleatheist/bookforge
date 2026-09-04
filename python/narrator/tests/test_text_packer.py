"""The packer, driven through the REAL pipeline.

Ports, assertion for assertion, the three e2a tools tests that own this code:

  tools/test_heading_chunks.py     a header is its own chunk (2026-08-27), the
                                   short-heading forward merge (2026-08-29) and
                                   the wordless-row drop (2026-08-29)
  tools/test_list_item_chunks.py   each <li> is its own chunk (2026-09-01) and
                                   the floor's item exemption in both directions
  tools/test_twin_anchor_split.py  PASS 6's twin-anchor split (2026-08-29)

WHAT IS DIFFERENT FROM THE e2a ORIGINALS, and why:

- **Orpheus only.** Each e2a test ran its fixture through `xtts`, `orpheus` and
  `voxtral`. narrator renders Orpheus and refuses the other two by name, so the
  expected values are the `'orpheus'` rows of e2a's own tables ('Chapter 8', not
  'Chapter eight'; '13.', not 'thirteen.') and the XTTS-class `_convert_sml`
  checks are dropped with the engines they belonged to. The list-item test's own
  header explains that the XTTS route reached the SAME per-item result by a
  different road, so nothing about the ITEM rule is lost by testing one engine.
- **No stanza.** e2a passed `stanza_nlp=False` explicitly ("the real 'no NER
  pipeline loaded' value core passes"); narrator has no such parameter, because
  the Orpheus branch never consulted it. See `text/sentences.py`.
- **unittest, not a `main()` that returns 1.** CONTRACTS.md: tests are unittest
  modules run by `python -m unittest discover`.

NO STANZA MODEL IS NEEDED, so nothing here skips. The e2a originals needed e2a's
whole dependency set because they imported `lib.core`; this needs `regex`, `bs4`
and `ebooklib`'s absence (the fixture doc is a stub, exactly as e2a's was).
"""
from __future__ import annotations

import os
import sys
import unittest

import regex as re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from narrator.text import lang as lang_mod                      # noqa: E402
from narrator.text import packer, sml                            # noqa: E402
from narrator.text.chapters import ChapterContext, filter_chapter  # noqa: E402

#: The read-only ebook2audiobook checkout, for the copied-table comparison below.
#: Windows default; `NARRATOR_E2A_ROOT` names it on the other two machines
#: (WSL `/home/telltale/ebook2audiobook`, Mac
#: `/Users/telltale/Projects/ebook2audiobook-latest`).
E2A_ROOT = os.environ.get('NARRATOR_E2A_ROOT',
                          r'C:\Users\tellt\Projects\ebook2audiobook')


class _FixtureDoc:
    """The only thing `filter_chapter` asks of an epub document."""

    def __init__(self, html):
        self._html = html

    def get_body_content(self):
        return self._html


def _run_chapter(html, skip_headings=False, sentence_per_paragraph=False,
                 process_dir=''):
    ctx = ChapterContext(
        language='eng', language_iso1='en', tts_engine='orpheus',
        process_dir=process_dir, skip_headings=skip_headings,
        sentence_per_paragraph=sentence_per_paragraph,
    )
    return filter_chapter(0, _FixtureDoc(html), ctx)


def _spoken(chunk: str) -> str:
    """The text Orpheus will actually be handed, produced by the engine's OWN
    strip pattern (`SML_UNSPOKEN_PATTERN`), not a re-implementation of it."""
    return re.sub(r'\s+', ' ', sml.SML_UNSPOKEN_PATTERN.sub('', chunk)).strip()


# =============================================================================
# The language tables really are e2a's
# =============================================================================

class LanguageTableTest(unittest.TestCase):
    """`text/lang.py` is a COPY of e2a's tables. Copies rot, so when the e2a
    checkout is on this machine the copy is compared against the original.

    Skips (only) when the read-only e2a checkout is absent - the package must be
    testable without it.
    """

    def setUp(self):
        if not os.path.isdir(E2A_ROOT):
            self.skipTest(f'ebook2audiobook checkout not present at {E2A_ROOT}; '
                          f'the copied conf_lang tables cannot be compared')
        if E2A_ROOT not in sys.path:
            sys.path.append(E2A_ROOT)
        # e2a's `lib/__init__` reads VERSION.txt RELATIVE TO THE CWD, so the
        # import only works from the checkout root. Restored immediately; nothing
        # is written.
        cwd = os.getcwd()
        os.chdir(E2A_ROOT)
        try:
            from lib import conf_lang  # noqa: F401
        except Exception as e:            # pragma: no cover - env-dependent
            self.skipTest(f'ebook2audiobook lib.conf_lang did not import ({e})')
        finally:
            os.chdir(cwd)
        self.e2a = conf_lang

    def test_the_punctuation_and_character_tables_match_e2a(self):
        for name in ('punctuation_switch', 'punctuation_split_hard',
                     'punctuation_split_soft', 'chars_remove', 'emojis_list',
                     'year_to_decades_languages', 'default_language_code'):
            self.assertEqual(getattr(self.e2a, name), getattr(lang_mod, name),
                             f'{name} has drifted from ebook2audiobook')

    def test_the_english_rows_match_e2a(self):
        self.assertEqual(self.e2a.abbreviations_mapping['eng'],
                         lang_mod.abbreviations_mapping['eng'])
        self.assertEqual(self.e2a.language_mapping['eng'],
                         lang_mod.language_mapping['eng'])

    def test_an_unsupported_language_is_refused_by_name(self):
        with self.assertRaises(lang_mod.UnsupportedLanguage) as caught:
            lang_mod.language_entry('deu')
        self.assertIn('deu', str(caught.exception))
        self.assertIn('English-only', str(caught.exception))


# =============================================================================
# tools/test_heading_chunks.py
# =============================================================================

#: e2a's fixture, verbatim. The four shapes headers come in, plus the DECORATED
#: header from Hugh Howey's "Shift" whose bullets become periods.
HEADING_FIXTURE = """<body>
<h1>PROLOGUE</h1>
<p>The city had been quiet for a very long time before that morning came.</p>
<h2>Chapter 8: State of Confusion</h2>
<p>Some consider Franklin D. Roosevelt to have been the greatest of them all.</p>
<h3>A Section Within</h3>
<p>No.</p>
<p>The argument continued for another hour without anyone changing their mind.</p>
<h2>&#8226; Silo 1 &#8226;</h2>
<p>Troy needed to see a doctor, and had needed to for very much longer than he cared to admit to anybody at all.</p>
</body>"""

#: e2a's EXPECTED_HEADERS['orpheus'] - book-exact, so 'Chapter 8', not 'eight'.
EXPECTED_HEADERS = ['PROLOGUE.', 'Chapter 8: State of Confusion.',
                    'A Section Within.']


class HeadingChunkTest(unittest.TestCase):
    """A header is read as its OWN chunk (2026-08-27)."""

    @classmethod
    def setUpClass(cls):
        cls.chunks = _run_chapter(HEADING_FIXTURE)
        assert cls.chunks is not None, 'filter_chapter returned None'
        cls.spoken = [_spoken(c) for c in cls.chunks]

    def test_a_header_of_three_or_more_words_is_a_chunk_of_its_own(self):
        for header in EXPECTED_HEADERS:
            if packer._word_count(header) < 3:
                continue
            if header in self.spoken:
                continue
            owner = next((s for s in self.spoken if header in s), None)
            self.fail(f'header {header!r} is not its own chunk'
                      + (f' - it was merged into {owner!r}' if owner
                         else ' - it is missing entirely'))

    def test_a_shorter_header_opens_the_chunk_under_it_instead(self):
        for header in EXPECTED_HEADERS:
            if packer._word_count(header) >= 3:
                continue
            self.assertNotIn(header, self.spoken,
                             f'short header {header!r} was left as its own chunk')
            self.assertTrue(
                any(s.startswith(header + ' ') for s in self.spoken),
                f'short header {header!r} does not open the chunk under it')

    def test_nothing_is_handed_to_the_model_with_no_word_in_it(self):
        """The '. Silo 1 .' carrier: PASS 1 splits at the first period and the
        leading '.' used to ship as a heading chunk of its own."""
        for chunk, spoken in zip(self.chunks, self.spoken):
            if spoken and not re.search(r'\w', spoken):
                self.fail(f'chunk has nothing to speak: {chunk!r} ({spoken!r})')

    def test_no_marker_survives_into_spoken_text(self):
        for spoken in self.spoken:
            self.assertNotIn('[heading]', spoken)
            self.assertNotIn('[/heading]', spoken)
            self.assertFalse(any(ord(ch) >= sml.sml_escape_tag for ch in spoken),
                             f'an escaped SML char survived: {spoken!r}')

    def test_skip_headings_still_means_skipped(self):
        skipped = _run_chapter(HEADING_FIXTURE, skip_headings=True)
        self.assertIsNotNone(skipped)
        joined = ' '.join(skipped)
        for header in EXPECTED_HEADERS:
            # A trailing period is the only part the fixture's prose could share.
            self.assertNotIn(header.rstrip('.'), joined,
                             f'skip_headings did not drop {header!r}')
        self.assertNotIn('[heading]', joined)


class MinCharsFloorHeadingTest(unittest.TestCase):
    """The floor, driven DIRECTLY over row sequences the fixture markup cannot
    force. e2a's `_check_floor_wordless_rows`, case for case.

    A row is built the way `get_sentences` sees one: `escape_sml` has already
    turned each SML block into ONE char whose index into `sml_blocks` is its
    identity, so `chr(sml_escape_tag + i)` IS the token here.
    """

    def setUp(self):
        blocks = ['[heading]', '[break]']
        self.heading = chr(sml.sml_escape_tag)
        self.brk = chr(sml.sml_escape_tag + 1)
        self.is_heading = sml.heading_row_test(blocks)
        # No [item] in this block table, so the item predicate answers False for
        # every row here - these cases are about headings only.
        self.is_item = sml.marker_row_test(blocks, 'item')

    def _run(self, rows, min_chars=25, max_chars=350):
        return packer._apply_min_chars_floor(
            rows,
            lambda s: len(sml.strip_escaped_sml(s)),
            max_chars, min_chars, self.is_heading, self.is_item,
            packer._has_word_chars,
        )

    def test_a_bare_period_between_two_headings_is_dropped(self):
        """Both floor merges are refused - a heading is not a landing site in
        either direction - so this is the arrangement where the fall-through used
        to SHIP the row. The two short headings then coalesce forward."""
        h, b = self.heading, self.brk
        self.assertEqual(
            self._run([f'{h}Chapter One.', f'{b}.', f'{h}Chapter Two.']),
            [f'{h}Chapter One. Chapter Two.'])

    def test_a_heading_with_no_word_in_it_is_dropped_exemption_or_not(self):
        h, b = self.heading, self.brk
        self.assertEqual(
            self._run([f'{b}{h}.',
                       'Troy needed to see a doctor and had for a long while.']),
            ['Troy needed to see a doctor and had for a long while.'])

    def test_a_one_word_heading_merges_forward_into_its_paragraph(self):
        h = self.heading
        body = ('The argument continued for another hour without anyone '
                'changing their mind.')
        self.assertEqual(self._run([f'{h}II.', body]), [f'II. {body}'])

    def test_a_three_word_heading_still_stands_alone(self):
        h = self.heading
        rows = [f'{h}A Section Within.',
                'The argument continued for another hour without anyone '
                'changing their mind.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_stacked_one_word_headings_coalesce_into_one_heading(self):
        h, b = self.heading, self.brk
        body = 'Troy needed to see a doctor and had for a very long while.'
        self.assertEqual(
            self._run([f'{h}16.', f'{b}{h}2110.', f'{b}{h}Silo one.', body]),
            [f'{b}{h}16. 2110. Silo one.', body])

    def test_a_chapter_final_short_heading_is_kept(self):
        h, b = self.heading, self.brk
        rows = ['A sentence long enough to clear the floor entirely on its own.',
                f'{b}{h}II.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_the_short_heading_merge_holds_with_the_length_floor_disabled(self):
        h = self.heading
        body = 'Some prose that is comfortably long enough on its own.'
        self.assertEqual(self._run([f'{h}II.', body], min_chars=0),
                         [f'II. {body}'])

    def test_a_bare_break_row_is_a_pause_and_survives(self):
        """An SML-ONLY row is a PAUSE, not a wordless chunk: the engines never
        send it to the model (silence is written for it)."""
        rows = ['A sentence long enough to clear the floor entirely on its own.',
                self.brk,
                'Another sentence that also clears the floor without merging.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_the_wordless_rule_holds_with_the_length_floor_disabled(self):
        b = self.brk
        self.assertEqual(
            self._run([f'{b}.', 'Some prose that is comfortably long enough.'],
                      min_chars=0),
            ['Some prose that is comfortably long enough.'])


# =============================================================================
# tools/test_list_item_chunks.py
# =============================================================================

ITEM_FIXTURE = """<body>
<p>The committee recorded the following points before it adjourned for the evening</p>
<ol>
<li>The first point about printing</li>
<li>A second point that runs a little longer than the first one did</li>
<li>The <em>third</em> point</li>
<li>13. A printer is represented by a press. It stands for the whole trade.</li>
<li>fourteen</li>
<li>A point about the guild and its charter</li>
<li>The seventh point, briefly stated</li>
<li>A final point to close the list</li>
</ol>
<p>The argument continued for another hour without anyone changing their mind about it.</p>
</body>"""

NESTED_FIXTURE = """<body>
<p>The nested case is recorded here for the walker to prove out properly</p>
<ul><li>outer<ul><li>inner</li></ul></li></ul>
<p>And the prose after the nested list continues for a while without stopping.</p>
</body>"""

INTRO = ('The committee recorded the following points before it adjourned for '
         'the evening.')
TRAILING = ('The argument continued for another hour without anyone changing '
            'their mind about it.')

#: e2a's EXPECTED_ITEMS['orpheus'] - book-exact, so '13.', not 'thirteen.'.
EXPECTED_ITEMS = [
    'The first point about printing.',
    'A second point that runs a little longer than the first one did.',
    'The third point.',
    '13. A printer is represented by a press. It stands for the whole trade.',
    'fourteen.',
    'A point about the guild and its charter.',
    'The seventh point, briefly stated.',
    'A final point to close the list.',
]


def _group_chunks(chunks):
    """Group a chapter's chunks into ('item'|'prose', [indices]).

    A chunk carrying [item] OPENS an item group. A chunk carrying no SML tag at
    all that directly follows one CONTINUES it - that shape can only be an item's
    own later sentence, because PASS 1 ends a row immediately before any token
    and starts rows on tokens, so the next item and the paragraph after the list
    both open with at least a [break].
    """
    groups = []
    for i, c in enumerate(chunks):
        if '[item]' in c:
            groups.append(['item', [i]])
        elif (groups and groups[-1][0] == 'item'
              and sml.SML_TAG_PATTERN.search(c) is None):
            groups[-1][1].append(i)
        else:
            groups.append(['prose', [i]])
    return groups


class ListItemChunkTest(unittest.TestCase):
    """Every <li> is its OWN chunk (2026-09-01)."""

    @classmethod
    def setUpClass(cls):
        cls.chunks = _run_chapter(ITEM_FIXTURE)
        assert cls.chunks is not None, 'filter_chapter returned None'
        cls.spoken = [_spoken(c) for c in cls.chunks]
        cls.groups = _group_chunks(cls.chunks)

    def test_every_item_is_one_group_in_order_reading_exactly_the_item_text(self):
        items = [g for g in self.groups if g[0] == 'item']
        self.assertEqual(len(items), len(EXPECTED_ITEMS),
                         f'{len(items)} item group(s), want {len(EXPECTED_ITEMS)}')
        for n, (group, want) in enumerate(zip(items, EXPECTED_ITEMS)):
            got = ' '.join(self.spoken[i] for i in group[1]).strip()
            self.assertEqual(got, want, f'item {n}')

    def test_every_item_is_exactly_one_chunk(self):
        """The two-sentence item is the case this proves: '13.' must not be a
        generation of its own with its sentence stranded in the next."""
        items = [g for g in self.groups if g[0] == 'item']
        for n, (group, want) in enumerate(zip(items, EXPECTED_ITEMS)):
            self.assertEqual(
                len(group[1]), 1,
                f'item {n} ({want!r}) is {len(group[1])} chunk(s): '
                f'{[self.chunks[i] for i in group[1]]!r}')

    def test_the_prose_either_side_of_the_list_is_not_part_of_it(self):
        prose = [' '.join(self.spoken[i] for i in g[1]).strip()
                 for g in self.groups if g[0] == 'prose']
        prose = [p for p in prose if p]
        self.assertIn(INTRO, prose,
                      f'the intro paragraph is not a chunk of its own: {prose!r}')
        self.assertIn(TRAILING, prose,
                      f'the trailing paragraph is not a chunk of its own: {prose!r}')

    def test_no_chunk_holds_two_items_or_welds_prose_to_one(self):
        for chunk, spoken in zip(self.chunks, self.spoken):
            if not spoken:
                continue
            hits = [w for w in EXPECTED_ITEMS if w in spoken]
            self.assertLessEqual(len(hits), 1,
                                 f'one chunk holds {len(hits)} items: {chunk!r}')
            if hits:
                self.assertNotIn(INTRO, spoken, f'chunk welds prose: {chunk!r}')
                self.assertNotIn(TRAILING, spoken, f'chunk welds prose: {chunk!r}')

    def test_no_marker_survives_into_spoken_text(self):
        for spoken in self.spoken:
            self.assertNotIn('[item]', spoken)
            self.assertNotIn('[/item]', spoken)
            self.assertFalse(any(ord(ch) >= sml.sml_escape_tag for ch in spoken))
            if spoken:
                self.assertTrue(re.search(r'\w', spoken),
                                f'chunk has nothing to speak: {spoken!r}')

    def test_the_flattened_rows_are_still_legal_sml(self):
        ok, out = sml.normalize_sml_tags(' '.join(self.chunks))
        self.assertTrue(ok, out)

    def test_a_nested_list_gives_the_inner_item_its_own_marker(self):
        chunks = _run_chapter(NESTED_FIXTURE)
        self.assertIsNotNone(chunks)
        spoken = [_spoken(c) for c in chunks]
        items = [g for g in _group_chunks(chunks) if g[0] == 'item']
        got = [' '.join(spoken[i] for i in g[1]).strip() for g in items]
        self.assertEqual(got, ['outer.', 'inner.'])


class NormalizeSmlItemTest(unittest.TestCase):
    """[item] is NON-PAIRED, and `normalize_sml_tags` is where that is enforced.
    That rejection is the reason the marker is a single leading token."""

    def test_a_marked_list_passes_through_unchanged(self):
        ok, out = sml.normalize_sml_tags('[break][item]One. [break][item]Two.')
        self.assertTrue(ok, out)
        self.assertEqual(out, '[break][item]One. [break][item]Two.')

    def test_a_closing_half_is_rejected(self):
        ok, out = sml.normalize_sml_tags('[item]One.[/item]')
        self.assertFalse(ok, 'the tag must stay non-paired')
        self.assertIn('non-paired', out)


class MinCharsFloorItemTest(unittest.TestCase):
    """The floor's item exemption, driven directly. e2a's
    `_check_floor_item_exemption`, case for case."""

    def setUp(self):
        blocks = ['[item]', '[break]']
        self.item = chr(sml.sml_escape_tag)
        self.brk = chr(sml.sml_escape_tag + 1)
        # No [heading] in this block table, so the heading predicate answers
        # False for every row here - these cases are about the ITEM exemption.
        self.is_heading = sml.marker_row_test(blocks, 'heading')
        self.is_item = sml.marker_row_test(blocks, 'item')

    def _run(self, rows, min_chars=25, max_chars=350):
        return packer._apply_min_chars_floor(
            rows,
            lambda s: len(sml.strip_escaped_sml(s)),
            max_chars, min_chars, self.is_heading, self.is_item,
            packer._has_word_chars,
        )

    def test_a_nine_char_list_item_still_stands_alone(self):
        i, b = self.item, self.brk
        rows = [f'{b}{i}fourteen.',
                f'{b}{i}A point about the guild and its charter.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_a_short_row_is_not_merged_forward_into_an_item(self):
        i, b = self.item, self.brk
        rows = ['No.', f'{b}{i}A list item long enough to clear the floor.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_a_short_row_is_not_merged_backward_into_an_item(self):
        i, b = self.item, self.brk
        rows = [f'{b}{i}A list item long enough to clear the floor.', 'No.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_a_list_item_with_no_word_in_it_is_dropped_exemption_or_not(self):
        i, b = self.item, self.brk
        self.assertEqual(
            self._run([f'{b}{i}.', 'Some prose that is comfortably long enough.']),
            ['Some prose that is comfortably long enough.'])

    def test_the_wordless_rule_holds_for_items_with_the_floor_disabled(self):
        i, b = self.item, self.brk
        self.assertEqual(
            self._run([f'{b}{i}.', 'Some prose that is comfortably long enough.'],
                      min_chars=0),
            ['Some prose that is comfortably long enough.'])

    def test_a_short_item_gathers_its_own_next_token_free_sentence(self):
        i, b = self.item, self.brk
        self.assertEqual(
            self._run([f'{b}{i}13.', 'A printer is represented by a press.']),
            [f'{b}{i}13. A printer is represented by a press.'])

    def test_a_short_item_keeps_gathering_until_it_clears_the_floor(self):
        i, b = self.item, self.brk
        self.assertEqual(
            self._run([f'{b}{i}13.', 'A press.', 'It stands for the whole trade.']),
            [f'{b}{i}13. A press. It stands for the whole trade.'])

    def test_a_short_item_does_not_gather_the_next_paragraph(self):
        i, b = self.item, self.brk
        rows = [f'{b}{i}fourteen.',
                f'{b}The paragraph after the list is long enough on its own.']
        self.assertEqual(self._run(list(rows)), rows)

    def test_a_short_item_does_not_gather_the_next_item(self):
        i, b = self.item, self.brk
        rows = [f'{b}{i}fourteen.',
                f'{b}{i}A following item that is long enough on its own.']
        self.assertEqual(self._run(list(rows)), rows)


# =============================================================================
# tools/test_twin_anchor_split.py
# =============================================================================

KRAUSE = (
    "Krause's speech was catastrophic because it stripped away the respectable "
    "language the movement had been using and exposed its core ideology to the "
    "rest of the German church for the first time. Muller stripped Krause of "
    "his offices within days. But the damage was structural, not personal. He "
    "was now either a fraud who'd hidden the ideology, which made him "
    "unacceptable to the church moderates, or an incompetent who couldn't "
    "control his own movement, which made him unacceptable to Hitler."
)


class TwinAnchorSplitTest(unittest.TestCase):
    """A repeated phrase inside one generation is a SKIP primer (2026-08-29).

    The German name in e2a's fixture is written 'Muller' here rather than
    'Mueller' with an umlaut: this file's assertions reach a console on failure
    and CONTRACTS.md requires ASCII there. The name is not load-bearing - the
    anchor phrase is 'which made him unacceptable' - and the split it drives is
    asserted identically.
    """

    def test_the_measured_defect_chunk_splits_in_two(self):
        r = packer._split_near_dup_chunk(KRAUSE)
        self.assertEqual(len(r), 2, f'got {len(r)} pieces')
        self.assertIn('unacceptable to', r[0])
        self.assertIn('unacceptable to', r[1])

    def test_the_split_loses_no_text(self):
        r = packer._split_near_dup_chunk(KRAUSE)
        self.assertEqual(''.join(KRAUSE.split()), ''.join(''.join(r).split()))

    def test_the_intra_sentence_splitter_alone_handles_the_last_sentence(self):
        last = KRAUSE.split('But the damage was structural, not personal. ')[1]
        self.assertEqual(len(packer._split_intra_twin(last)), 2)

    def test_non_twin_prose_is_returned_byte_identical(self):
        plain = ('Szalasi, head of the Arrow Cross, seized power in Budapest on '
                 'October fifteen, nineteen forty-four. The movement had spent a '
                 'generation writing its program. Now it had a country.')
        self.assertEqual(packer._split_near_dup_chunk(plain), [plain])

    def test_a_short_collocation_does_not_split(self):
        glue = ('At the end of the street stood a bakery that had served the '
                'town for decades. At the end of the war it was the only '
                'building left standing on the block, and people remembered '
                'that.')
        self.assertEqual(packer._split_near_dup_chunk(glue), [glue])

    def test_a_cross_sentence_twin_splits_at_the_sentence_boundary(self):
        cross = ('The instruction to party members was explicit and it was '
                 'printed in the morning edition for everyone to read. The '
                 'instruction to party members was repeated on the radio that '
                 'evening in the same words.')
        self.assertEqual(len(packer._split_near_dup_chunk(cross)), 2)

    def test_a_twin_whose_pieces_would_be_tiny_is_left_alone(self):
        tiny = 'Yes he said, yes he said.'
        self.assertEqual(packer._split_near_dup_chunk(tiny), [tiny])

    def test_the_qualifying_bar_admits_the_anchor_and_rejects_short_glue(self):
        self.assertIn(('which', 'made', 'him', 'unacceptable'),
                      packer._twin_anchor_grams(
                          'which made him unacceptable to everyone'))
        self.assertNotIn(('at', 'the', 'end', 'of'),
                         packer._twin_anchor_grams('at the end of the day'))

    def test_the_near_duplicate_loop_primer_still_splits(self):
        """The pair PASS 6 was built for, before the twin-anchor extension."""
        chunk = ("Kershaw didn't use it in his book about the period. "
                 "Trevor-Roper didn't use it in his book about the period.")
        self.assertEqual(len(packer._split_near_dup_chunk(chunk)), 2)


# =============================================================================
# The two knobs, and the two prep flags no golden exercises
# =============================================================================

class KnobTest(unittest.TestCase):
    """SENTENCE_MIN_CHARS / HEADING_MIN_WORDS / ORPHEUS_MAX_CHARS: the defaults,
    and that an invalid value RAISES (NO FALLBACK)."""

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in
                       ('SENTENCE_MIN_CHARS', 'HEADING_MIN_WORDS',
                        'ORPHEUS_MAX_CHARS')}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_the_defaults_are_e2as(self):
        self.assertEqual(packer._sentence_min_chars(), 25)
        self.assertEqual(packer._heading_min_words(), 3)
        self.assertEqual(packer.orpheus_max_chars(), 350)

    def test_each_knob_is_honoured(self):
        os.environ['SENTENCE_MIN_CHARS'] = '40'
        os.environ['HEADING_MIN_WORDS'] = '5'
        os.environ['ORPHEUS_MAX_CHARS'] = '430'
        self.assertEqual(packer._sentence_min_chars(), 40)
        self.assertEqual(packer._heading_min_words(), 5)
        self.assertEqual(packer.orpheus_max_chars(), 430)

    def test_a_negative_floor_raises(self):
        os.environ['SENTENCE_MIN_CHARS'] = '-1'
        with self.assertRaises(ValueError):
            packer._sentence_min_chars()

    def test_a_negative_heading_word_count_raises(self):
        os.environ['HEADING_MIN_WORDS'] = '-1'
        with self.assertRaises(ValueError):
            packer._heading_min_words()

    def test_a_non_numeric_cap_raises(self):
        os.environ['ORPHEUS_MAX_CHARS'] = 'lots'
        with self.assertRaises(ValueError):
            packer.orpheus_max_chars()


class SentencePerParagraphTest(unittest.TestCase):
    """`--sentence_per_paragraph`: the packer is skipped ENTIRELY and each
    paragraph becomes one chunk. A live BookForge toggle (language-learning
    mode) that no golden session used, so this is its only coverage."""

    FIXTURE = """<body>
<p>The first paragraph runs on for a while and contains two sentences. Here is the second one.</p>
<p>The second paragraph is shorter.</p>
<p>And a third, also short.</p>
</body>"""

    def test_each_paragraph_is_one_chunk(self):
        chunks = _run_chapter(self.FIXTURE, sentence_per_paragraph=True)
        self.assertIsNotNone(chunks)
        self.assertEqual(
            [_spoken(c) for c in chunks],
            ['The first paragraph runs on for a while and contains two '
             'sentences. Here is the second one.',
             'The second paragraph is shorter.',
             'And a third, also short.'])

    def test_without_the_flag_the_packer_runs_and_packs_them_together(self):
        chunks = _run_chapter(self.FIXTURE)
        self.assertIsNotNone(chunks)
        self.assertLess(len(chunks), 3,
                        'the packer should have packed these three short '
                        f'paragraphs: {chunks!r}')


class EngineRefusalTest(unittest.TestCase):
    """THE PARITY PACKER is Orpheus-only, BY REFUSAL - it never quietly does
    something else for another engine.

    `normalize_text` and `get_chapters` accept `higgs-v3` as well (both engines
    read book-exact text; see `normalize.BOOK_EXACT_ENGINES`), but
    `get_sentences` and `filter_chapter` do NOT: they are the ported e2a packer,
    whose caps and floors were calibrated on Orpheus voices, and a Higgs book
    chunks through `text/paragraph_packer.py` instead."""

    def test_get_sentences_refuses_a_non_orpheus_engine_by_name(self):
        with self.assertRaises(Exception) as caught:
            packer.get_sentences('Some text.', 'eng', 'xtts', [])
        self.assertIn('xtts', str(caught.exception))
        self.assertIn('orpheus', str(caught.exception))

    def test_filter_chapter_refuses_a_non_orpheus_engine_by_name(self):
        ctx = ChapterContext(language='eng', language_iso1='en',
                             tts_engine='voxtral', process_dir='')
        with self.assertRaises(Exception) as caught:
            filter_chapter(0, _FixtureDoc('<body><p>Hi there.</p></body>'), ctx)
        self.assertIn('voxtral', str(caught.exception))

    def test_a_non_english_book_is_refused_the_way_e2a_refuses_it(self):
        """e2a prints the refusal and returns None from `filter_chapter`, which
        makes `get_chapters` abort the whole book. Same shape here."""
        ctx = ChapterContext(language='deu', language_iso1='de',
                             tts_engine='orpheus', process_dir='')
        self.assertIsNone(
            filter_chapter(0, _FixtureDoc('<body><p>Guten Tag.</p></body>'), ctx))


if __name__ == '__main__':
    unittest.main()
