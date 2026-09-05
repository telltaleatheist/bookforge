"""The PARAGRAPH chunking policy: Owen's rule, asserted.

Spec: `docs/NARRATOR_PLAN.md` -> "Chunking rule (Owen, 2026-09-04)". The fixtures
below reproduce the SHAPE the rule was measured on rather than a shape invented
for the test: Mutineer's Moon's 2,107 blocks (median 221 chars, p99 822, max
1,213, 23% under 100 chars, 51% of blocks quote-initial) is what makes the floor
necessary and what makes the p99 tail the only thing a sentence split ever
touches.

Nothing here touches `text/packer.py`. The parity packer is a separate policy and
its own tests (`test_text_packer.py`) are unchanged.
"""
from __future__ import annotations

import os
import random
import sys
import unittest

import regex as re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from narrator.text import paragraph_packer as pp  # noqa: E402
from narrator.text.sml import SML_UNSPOKEN_PATTERN  # noqa: E402


class FakeBudget:
    """A `Budget` built from numbers, which is the only way this policy takes
    them: there is no cap constant in `paragraph_packer.py`."""

    def __init__(self, chars, chars_per_sec=22.6, audio_tokens=3700):
        self._chars = chars
        self._rate = chars_per_sec
        self._tokens = audio_tokens

    def max_chars(self, voice=None):
        return self._chars

    def max_chars_per_sec(self, voice=None):
        return self._rate

    def max_total_tokens(self, prompt_tokens, voice=None):
        return self._tokens + prompt_tokens


#: The three budgets the rule names.
ORPHEUS_MISTBORN = FakeBudget(430)      # kershaw's voice, catalog f429050c
ORPHEUS_DEATHSTALKER = FakeBudget(520)  # mutineer's voice, catalog c1dbda5f
HIGGS_V3_ZERO_SHOT = FakeBudget(600)    # the PLACEHOLDER; the real one is measured
HIGGS_V3_FINETUNE = FakeBudget(1500)    # a ds_ad4l-shaped cut, 100 s clips


def spoken(chunk) -> str:
    return re.sub(r'\s+', ' ', SML_UNSPOKEN_PATTERN.sub('', chunk)).strip()


def para(text, index=0):
    return pp.Block(text=text, kind=pp.PARAGRAPH, index=index)


# =============================================================================
# The measured corpus shape, as a fixture
# =============================================================================

def mutineer_shaped_blocks(n=400, seed=20260904):
    """A block list with Mutineer's Moon's measured distribution.

    23% under 100 characters, 51% of blocks quote-initial, median ~221, a p99
    tail past 800 and a max past 1,200. The point is not to imitate the prose but
    to reproduce the two facts the rule turns on: a quarter of the book is
    dialogue lines far under any floor, and one block in a hundred is longer than
    any Orpheus cap.
    """
    rng = random.Random(seed)
    blocks = []
    for i in range(n):
        roll = rng.random()
        if roll < 0.23:
            target = rng.randint(20, 99)
        elif roll < 0.99:
            target = rng.randint(120, 500)
        else:
            target = rng.randint(820, 1213)
        sentences = []
        while sum(len(s) + 1 for s in sentences) < target:
            words = rng.randint(4, 18)
            sentences.append(' '.join(
                rng.choice(['the', 'ship', 'Colin', 'moved', 'toward', 'her',
                            'quietly', 'again', 'because', 'Dahak', 'said',
                            'nothing', 'more', 'about', 'it', 'then'])
                for _ in range(words)).capitalize() + '.')
        text = ' '.join(sentences)[:max(target, 20)]
        if not text.endswith('.'):
            text = text.rstrip() + '.'
        if rng.random() < 0.51:
            text = '"' + text[:-1] + '."'
        blocks.append(para(text, index=i))
    return blocks


class CorpusShapeTest(unittest.TestCase):
    """The fixture really does have the shape the rule was measured on."""

    def setUp(self):
        self.blocks = mutineer_shaped_blocks()

    def test_the_fixture_reproduces_the_measured_distribution(self):
        lengths = sorted(len(b.text) for b in self.blocks)
        short = sum(1 for n in lengths if n < 100) / len(lengths)
        quoted = sum(1 for b in self.blocks
                     if b.text.startswith('"')) / len(self.blocks)
        self.assertGreater(short, 0.15, 'not enough short dialogue blocks')
        self.assertLess(short, 0.32)
        self.assertGreater(quoted, 0.40, 'not enough quote-initial blocks')
        self.assertGreater(lengths[-1], 800, 'no p99 tail to sentence-split')


# =============================================================================
# Tier 1: the floor, and what it is NOT for
# =============================================================================

class FloorTest(unittest.TestCase):

    def test_consecutive_short_dialogue_paragraphs_merge_up_to_the_floor(self):
        blocks = [para('"Hello."', 0), para('"Hi there."', 1),
                  para('"And how are you today, then?"', 2),
                  para('"Well enough, considering everything that happened."', 3),
                  para('"Good. I had wondered about that for a while now."', 4)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=100)
        self.assertEqual(len(report.chunks), 2)
        self.assertGreaterEqual(report.chunks[0].chars, 100)
        self.assertEqual(report.chunks[0].blocks, (0, 1, 2, 3))

    def test_a_paragraph_that_already_reaches_the_floor_stands_alone(self):
        long_p = 'A sentence that is comfortably long. ' * 10
        blocks = [para('"Hi."', 0), para(long_p, 1), para('"Bye."', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual([c.blocks for c in report.chunks],
                         [(0,), (1,), (2,)])

    def test_a_long_paragraph_is_never_swallowed_by_the_run_in_front_of_it(self):
        """The bug this rule's third clause exists for: three dialogue turns
        followed by a full-size paragraph must not become one chunk."""
        blocks = [para('"One."', 0), para('"Two."', 1), para('"Three."', 2),
                  para('B' * 400 + '.', 3)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual([c.blocks for c in report.chunks], [(0, 1, 2), (3,)])

    def test_a_run_that_ends_before_the_floor_is_emitted_short(self):
        blocks = [para('"One."', 0), para('"Two."', 1)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual(len(report.chunks), 1)
        self.assertLess(report.chunks[0].chars, 300)

    def test_a_merge_never_exceeds_the_budget_cap(self):
        blocks = [para('x' * 90 + '.', i) for i in range(20)]
        report = pp.pack_paragraphs(blocks, FakeBudget(200), floor_chars=1000)
        for chunk in report.chunks:
            self.assertLessEqual(chunk.chars, 200)

    def test_the_floor_is_configurable_and_zero_means_no_merging(self):
        blocks = [para('"One."', 0), para('"Two."', 1), para('"Three."', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=0)
        self.assertEqual([c.blocks for c in report.chunks], [(0,), (1,), (2,)])
        self.assertEqual(report.merges, 0)


class WallTest(unittest.TestCase):
    """Owen's refinement: a short block that is a complete, separate thought is
    NOT merged. Items are the example."""

    def test_each_list_item_is_its_own_chunk_and_keeps_its_marker(self):
        blocks = [pp.Block('fourteen.', pp.ITEM, index=0),
                  pp.Block('fifteen.', pp.ITEM, index=1),
                  pp.Block('sixteen.', pp.ITEM, index=2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual(len(report.chunks), 3)
        for chunk in report.chunks:
            self.assertEqual(chunk.kind, 'item')
            self.assertIn('[item]', chunk.text)
        self.assertEqual(report.merges, 0)

    def test_an_item_is_never_merged_with_the_prose_around_it(self):
        blocks = [para('"Short."', 0), pp.Block('fourteen.', pp.ITEM, index=1),
                  para('"Also short."', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual([c.blocks for c in report.chunks],
                         [(0,), (1,), (2,)])

    def test_a_heading_is_its_own_chunk_and_keeps_its_marker(self):
        blocks = [para('"Short."', 0),
                  pp.Block('Chapter Two.', pp.HEADING, index=1),
                  para('"Also short."', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual(len(report.chunks), 3)
        self.assertEqual(report.chunks[1].kind, 'heading')
        self.assertIn('[heading]', report.chunks[1].text)
        self.assertEqual(spoken(report.chunks[1].text), 'Chapter Two.')

    def test_a_scene_break_speaks_nothing_but_still_stops_a_merge(self):
        blocks = [para('"One."', 0), para('"Two."', 1),
                  pp.Block('', pp.SCENE_BREAK, index=2),
                  para('"Three."', 3), para('"Four."', 4)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual([c.blocks for c in report.chunks], [(0, 1), (3, 4)])
        self.assertNotIn('', [spoken(c.text) for c in report.chunks])

    def test_a_chapter_start_is_a_wall_and_speaks_nothing(self):
        blocks = [para('"One."', 0),
                  pp.Block('', pp.CHAPTER_START, index=1),
                  para('"Two."', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual([c.blocks for c in report.chunks], [(0,), (2,)])

    def test_paragraph_may_not_be_declared_a_wall(self):
        with self.assertRaises(ValueError):
            pp.pack_paragraphs([para('x.', 0)], ORPHEUS_DEATHSTALKER,
                               walls={pp.PARAGRAPH})

    def test_every_wall_kind_holds_independently(self):
        for kind in (pp.HEADING, pp.ITEM, pp.SCENE_BREAK, pp.CHAPTER_START):
            blocks = [para('"One."', 0), pp.Block('Wall.', kind, index=1),
                      para('"Two."', 2)]
            report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER,
                                        floor_chars=300)
            prose = [c.blocks for c in report.chunks if c.kind == 'prose']
            self.assertEqual(prose, [(0,), (2,)], kind)


# =============================================================================
# Per-engine budget
# =============================================================================

class BudgetTest(unittest.TestCase):

    def test_no_paragraph_is_split_at_a_higgs_sized_budget(self):
        blocks = mutineer_shaped_blocks()
        report = pp.pack_paragraphs(blocks, HIGGS_V3_FINETUNE, floor_chars=300)
        self.assertEqual(report.paragraphs_sentence_split, 0,
                         'a 1,500-char budget covers the whole measured corpus')
        for chunk in report.chunks:
            self.assertFalse(chunk.sentence_split)

    def test_the_p99_tail_IS_split_at_an_orpheus_sized_budget(self):
        blocks = mutineer_shaped_blocks()
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertGreater(report.paragraphs_sentence_split, 0)
        for chunk in report.chunks:
            self.assertLessEqual(chunk.chars, 520)

    def test_a_split_never_falls_inside_a_sentence(self):
        text = ('She turned to Mr. Darcy and asked him about it. '
                '"Are you sure?" she said. He did not answer for a while. '
                'The C.I.A. had been clear enough about the matter already. '
                'Then he spoke, and what he said changed everything at once.')
        report = pp.pack_paragraphs([para(text, 0)], FakeBudget(90),
                                    floor_chars=300)
        for chunk in report.chunks:
            self.assertRegex(spoken(chunk.text), r'[.!?…]["\'’”»)\]]*$',
                             f'chunk does not end at a sentence: {chunk.text!r}')

    def test_a_single_sentence_longer_than_the_budget_is_kept_whole(self):
        """The policy never splits mid-sentence, so an impossible sentence is
        emitted over budget and COUNTED rather than cut."""
        text = 'word ' * 200 + 'end.'
        report = pp.pack_paragraphs([para(text, 0)], FakeBudget(100),
                                    floor_chars=300)
        self.assertEqual(len(report.chunks), 1)
        self.assertGreater(report.chunks[0].chars, 100)
        self.assertEqual(report.over_budget_sentences, 1)

    def test_the_cap_comes_only_from_the_budget(self):
        for cap in (200, 430, 520, 600, 1500):
            self.assertEqual(pp.effective_cap(FakeBudget(cap)), cap)

    def test_the_rate_guard_tightens_the_cap_when_an_audio_window_is_given(self):
        # 44 s x 22.6 ch/s = 994, so it does NOT bind for Orpheus...
        self.assertEqual(pp.effective_cap(ORPHEUS_DEATHSTALKER,
                                          audio_budget_s=44.0), 520)
        # ...but it does for a budget whose char cap is above the window.
        self.assertEqual(pp.effective_cap(FakeBudget(4000, 22.6),
                                          audio_budget_s=44.0), 994)

    def test_a_zero_rate_is_the_protocols_no_guard_sentinel(self):
        self.assertEqual(pp.effective_cap(FakeBudget(430, 0.0),
                                          audio_budget_s=44.0), 430)

    def test_a_nonpositive_cap_is_refused(self):
        with self.assertRaises(ValueError):
            pp.effective_cap(FakeBudget(0))

    def test_the_catalog_budget_carries_data_not_constants(self):
        b = pp.CatalogBudget(chars=430, chars_per_sec=22.6, audio_tokens=3700)
        self.assertEqual(b.max_chars(), 430)
        self.assertEqual(b.max_total_tokens(100), 3800)
        with self.assertRaises(ValueError):
            pp.CatalogBudget(chars=600).max_total_tokens(0)

    def test_the_orpheus_budget_reads_the_same_env_the_parity_packer_reads(self):
        from narrator.text.packer import orpheus_max_chars
        saved = os.environ.get('ORPHEUS_MAX_CHARS')
        os.environ['ORPHEUS_MAX_CHARS'] = '520'
        try:
            self.assertEqual(pp.orpheus_budget_from_env().max_chars(), 520)
            self.assertEqual(orpheus_max_chars(), 520)
        finally:
            if saved is None:
                os.environ.pop('ORPHEUS_MAX_CHARS', None)
            else:
                os.environ['ORPHEUS_MAX_CHARS'] = saved


# =============================================================================
# Tier 2: provisional fragments
# =============================================================================

class FragmentTest(unittest.TestCase):

    def test_a_block_that_does_not_end_a_thought_joins_the_next_one(self):
        blocks = [para('The column ran out mid', 0),
                  para('sentence and continued here.', 1)]
        joined = pp.join_provisional_fragments(blocks)
        self.assertEqual(len(joined), 1)
        self.assertEqual(joined[0].text,
                         'The column ran out mid sentence and continued here.')

    def test_a_running_header_between_two_halves_is_absorbed(self):
        blocks = [para('He walked toward the', 0),
                  para('MUTINEER S MOON', 1),
                  para('door and opened it.', 2)]
        joined = pp.join_provisional_fragments(blocks)
        self.assertEqual(len(joined), 1)
        self.assertIn('MUTINEER S MOON', joined[0].text)

    def test_a_complete_block_is_untouched(self):
        blocks = [para('A complete thought.', 0), para('Another one.', 1)]
        self.assertEqual([b.text for b in pp.join_provisional_fragments(blocks)],
                         ['A complete thought.', 'Another one.'])

    def test_a_closing_quote_after_the_mark_still_ends_a_thought(self):
        for text in ('"Are you sure?"', "'Yes.'", 'He left (finally.)',
                     'She said "no."', 'It ended...'):
            self.assertTrue(pp.ends_a_thought(text), text)

    def test_headings_and_items_are_never_treated_as_fragments(self):
        """A heading that ends in a letter is a heading, and an item is a
        complete thought by the refinement - joining either would destroy the
        two rules this policy is careful to keep."""
        blocks = [pp.Block('Chapter Two', pp.HEADING, index=0),
                  para('The prose under it.', 1),
                  pp.Block('fourteen', pp.ITEM, index=2),
                  para('More prose.', 3)]
        joined = pp.join_provisional_fragments(blocks)
        self.assertEqual([b.kind for b in joined],
                         [pp.HEADING, pp.PARAGRAPH, pp.ITEM, pp.PARAGRAPH])

    def test_a_fragment_running_into_a_heading_still_joins_it(self):
        blocks = [para('the sentence broke across the page', 0),
                  pp.Block('Chapter Two.', pp.HEADING, index=1)]
        joined = pp.join_provisional_fragments(blocks)
        self.assertEqual(len(joined), 1)
        self.assertEqual(joined[0].kind, pp.PARAGRAPH)

    def test_joining_is_idempotent_and_loses_no_text(self):
        blocks = [para('one two', 0), para('three four', 1),
                  para('five six.', 2), para('Seven.', 3)]
        once = pp.join_provisional_fragments(blocks)
        twice = pp.join_provisional_fragments(once)
        self.assertEqual([b.text for b in once], [b.text for b in twice])
        self.assertEqual(' '.join(b.text for b in once).split(),
                         ' '.join(b.text for b in blocks).split())

    def test_a_trailing_fragment_with_nothing_to_join_is_kept(self):
        blocks = [para('Complete.', 0), para('dangling half', 1)]
        joined = pp.join_provisional_fragments(blocks)
        self.assertEqual([b.text for b in joined],
                         ['Complete.', 'dangling half'])

    def test_tier_2_runs_before_the_floor_so_a_chunk_never_stops_mid_sentence(self):
        blocks = [para('The first half of a long thought that was broken', 0),
                  para('across a page boundary by the layout model.', 1),
                  para('"Short."', 2)]
        report = pp.pack_paragraphs(pp.join_provisional_fragments(blocks),
                                    ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual(len(report.chunks), 1)
        self.assertTrue(pp.ends_a_thought(spoken(report.chunks[0].text)))


# =============================================================================
# Provenance
# =============================================================================

class ProvenanceTest(unittest.TestCase):
    """`detect_source_kind` is `categoriesBranchOf`
    (`electron/epub-processor.ts:6483-6533`) narrowed to the two answers this
    policy needs. The stamp is in the XHTML, never in the OPF."""

    class _Doc:
        def __init__(self, ident, html):
            self.id = ident
            self._html = html

        def get_content(self):
            return self._html.encode('utf-8')

    class _Book:
        def __init__(self, docs):
            self._docs = docs
            self.spine = [(d.id, 'yes') for d in docs]

        def get_items_of_type(self, kind):
            return self._docs

    def _book(self, *htmls):
        return self._Book([self._Doc(f'c{i}', h)
                           for i, h in enumerate(htmls)])

    def test_the_reflow_dialect_is_pdf_derived(self):
        book = self._book('<p>plain</p>',
                          '<h1 data-bf-category="chapter" data-bf-group="p0001" '
                          'data-bf-blocks="p0006b003">Ch</h1>')
        self.assertEqual(pp.detect_source_kind(book), pp.PDF_DERIVED)

    def test_the_vision_model_dialect_is_pdf_derived(self):
        book = self._book('<h1 data-bf-page="6" data-bf-cat="title">Ch</h1>')
        self.assertEqual(pp.detect_source_kind(book), pp.PDF_DERIVED)

    def test_an_unstamped_book_is_epub_native_not_unknown(self):
        """`epub-processor.ts:5113-5116`: absence is "a different INPUT CLASS
        (a book from elsewhere), not a failure"."""
        book = self._book('<h1>Chapter One</h1><p>Prose.</p>')
        self.assertEqual(pp.detect_source_kind(book), pp.EPUB_NATIVE)

    def test_a_uid_attribute_alone_is_not_a_provenance_stamp(self):
        book = self._book('<p data-bf-uid="abc">Prose.</p>')
        self.assertEqual(pp.detect_source_kind(book), pp.EPUB_NATIVE)

    def test_a_manifest_only_document_is_not_consulted(self):
        book = self._Book([self._Doc('c0', '<p>plain</p>')])
        book._docs.append(self._Doc('orphan',
                                    '<p data-bf-cat="text">stamped</p>'))
        self.assertEqual(pp.detect_source_kind(book), pp.EPUB_NATIVE)

    def test_the_chunker_refuses_a_source_kind_it_was_not_told(self):
        for bad in (None, '', 'pdf', 'guess'):
            with self.assertRaises(pp.UnknownProvenance):
                pp.make_chapter_chunker(ORPHEUS_DEATHSTALKER, source_kind=bad)

    def test_an_invalid_env_override_is_refused_by_name(self):
        saved = os.environ.get(pp.SOURCE_KIND_ENV)
        os.environ[pp.SOURCE_KIND_ENV] = 'maybe'
        try:
            with self.assertRaises(pp.UnknownProvenance):
                pp.source_kind_from_env()
        finally:
            if saved is None:
                os.environ.pop(pp.SOURCE_KIND_ENV, None)
            else:
                os.environ[pp.SOURCE_KIND_ENV] = saved


# =============================================================================
# The sentence splitter agrees with the parity packer's PASS 1
# =============================================================================

class SentenceSplitterTest(unittest.TestCase):
    """A deliberate SECOND COPY of PASS 1's pattern (the parity packer may not be
    edited to share it), so its behaviour is asserted rather than assumed."""

    def test_it_reads_the_same_tables_the_parity_packer_reads(self):
        from narrator.text import packer
        self.assertIs(pp.abbreviations_mapping, packer.abbreviations_mapping)
        self.assertIs(pp.punctuation_split_hard_set,
                      packer.punctuation_split_hard_set)

    def test_an_abbreviation_does_not_end_a_sentence(self):
        for text in ('He asked Mr. Darcy about it.',
                     'She joined the C.I.A. that year.',
                     'They met on Ave. Foch in the spring.',
                     'It was e.g. a Tuesday.'):
            self.assertEqual(len(pp.split_sentences(text)), 1, text)

    def test_a_sentence_ends_AT_the_closing_quote_exactly_as_pass_1_does(self):
        """MEASURED against the parity packer's rule, not against intuition.

        PASS 1's `closing_run` makes a row end AT the closing quote, so
        `'"Are you sure?" she said.'` is TWO pieces and the dialogue tag is the
        second - that is what e2a produces too (its PASS 4/5 then merge them
        back, and here the greedy refill does). The point of the rule is that the
        boundary never lands between the `?` and the `"`.
        """
        pieces = pp.split_sentences('"Are you sure?" she said. He nodded.')
        self.assertEqual(pieces, ['"Are you sure?"', 'she said.', 'He nodded.'])
        # The thing that must never happen: a piece ending on the bare mark with
        # its closing quote stranded at the head of the next one.
        for piece in pieces:
            self.assertFalse(piece.startswith('"') and not piece.endswith('"'),
                             f'a boundary fell between the mark and its quote: '
                             f'{pieces!r}')

    def test_ordinary_sentences_split(self):
        self.assertEqual(
            pp.split_sentences('One thing happened. Then another! And a third?'),
            ['One thing happened.', 'Then another!', 'And a third?'])

    def test_splitting_loses_no_words(self):
        text = ('She turned to Mr. Darcy. "Are you sure?" she said. '
                'He did not answer... Then he did.')
        self.assertEqual(' '.join(pp.split_sentences(text)).split(),
                         text.split())

    def test_a_paragraph_with_no_terminal_mark_is_one_sentence(self):
        self.assertEqual(pp.split_sentences('no terminator here'),
                         ['no terminator here'])

    def test_it_uses_no_stanza(self):
        """PASS 1 uses none, and neither does this: `narrator.text` must stay
        importable on a machine with no stanza model (the Windows interpreter
        has none). Asserted by import, not by comment."""
        import narrator.text.paragraph_packer as module
        source = open(module.__file__, encoding='utf-8').read()
        self.assertNotIn('import stanza', source)
        self.assertNotIn('stanza.Pipeline', source)


# =============================================================================
# Markers, so the VTT and prompt rules are unchanged
# =============================================================================

class MarkerTest(unittest.TestCase):

    def test_every_chunk_leads_with_a_break_token_like_the_parity_packer(self):
        blocks = [para('One thing happened here.', 0),
                  para('Another thing happened.', 1)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=0)
        for chunk in report.chunks:
            self.assertTrue(chunk.text.startswith('[break]'), chunk.text)

    def test_a_heading_chunk_is_classified_the_way_the_manifest_classifies_it(self):
        from narrator.text.sml import SML_HEADING_PATTERN
        blocks = [pp.Block('Chapter Two.', pp.HEADING, index=0)]
        chunk = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER).chunks[0]
        self.assertIsNotNone(SML_HEADING_PATTERN.search(chunk.text))

    def test_no_marker_survives_into_the_spoken_text(self):
        blocks = [pp.Block('Chapter Two.', pp.HEADING, index=0),
                  pp.Block('fourteen.', pp.ITEM, index=1),
                  para('Some prose that runs on for a bit.', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER)
        for chunk in report.chunks:
            text = spoken(chunk.text)
            for marker in ('[break]', '[heading]', '[item]'):
                self.assertNotIn(marker, text)

    def test_a_merge_drops_the_join_tokens_and_counts_them(self):
        blocks = [para('"One."', 0), para('"Two."', 1), para('"Three."', 2)]
        report = pp.pack_paragraphs(blocks, ORPHEUS_DEATHSTALKER, floor_chars=300)
        self.assertEqual(len(report.chunks), 1)
        self.assertEqual(report.chunks[0].text.count('[break]'), 1)
        self.assertEqual(report.dropped_join_tokens, 2)


# =============================================================================
# Block extraction, and the whole policy through prep
# =============================================================================

FIXTURE = """<body>
<h1>Chapter One</h1>
<p>The first paragraph is a complete thought of full size, past the three hundred character floor all on its own, which is what makes it a chunk that neither joins the dialogue after it nor accepts anything into itself; it runs on for a good long while precisely so this fixture can tell the two cases apart.</p>
<p>"Hello."</p>
<p>"Hi there."</p>
<p>"And how are you today, then?"</p>
<hr/>
<p>After the scene break the prose starts again with a complete thought here.</p>
<ul><li>first item</li><li>second item</li></ul>
<p>* * *</p>
<p>And a closing paragraph to finish the chapter off properly.</p>
</body>"""


class _FixtureDoc:
    def __init__(self, html, name='text/c0001.xhtml'):
        self._html = html
        self._name = name

    def get_body_content(self):
        return self._html

    def get_name(self):
        return self._name


class ExtractBlocksTest(unittest.TestCase):

    def setUp(self):
        self.blocks = pp.extract_blocks(_FixtureDoc(FIXTURE), 'text/c0001.xhtml')

    def test_every_block_kind_is_recognised_in_reading_order(self):
        self.assertEqual([b.kind for b in self.blocks], [
            pp.HEADING, pp.PARAGRAPH, pp.PARAGRAPH, pp.PARAGRAPH, pp.PARAGRAPH,
            pp.SCENE_BREAK, pp.PARAGRAPH, pp.ITEM, pp.ITEM,
            pp.SCENE_BREAK, pp.PARAGRAPH,
        ])

    def test_a_heading_gets_the_period_the_parity_packer_gives_it(self):
        self.assertEqual(self.blocks[0].text, 'Chapter One.')

    def test_a_decorative_paragraph_with_no_word_in_it_is_a_scene_break(self):
        self.assertEqual(self.blocks[9].kind, pp.SCENE_BREAK)
        self.assertEqual(self.blocks[9].text, '')

    def test_the_whole_fixture_packs_the_way_the_rule_describes(self):
        report = pp.pack_paragraphs(self.blocks, ORPHEUS_DEATHSTALKER,
                                    floor_chars=300)
        kinds = [c.kind for c in report.chunks]
        self.assertEqual(kinds, ['heading', 'prose', 'prose', 'prose',
                                 'item', 'item', 'prose'])
        # ONLY the three dialogue turns merged: the full-size first paragraph
        # stands alone in front of them, the scene break stops the run, and the
        # two items are chunks of their own.
        merged = [c for c in report.chunks if len(c.blocks) > 1]
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].blocks, (2, 3, 4))
        self.assertEqual([c.blocks for c in report.chunks],
                         [(0,), (1,), (2, 3, 4), (6,), (7,), (8,), (10,)])


class PrepPolicyTest(unittest.TestCase):
    """The switch in `prep_session`, and that the default changes nothing."""

    def test_the_default_is_e2a_and_records_itself(self):
        from narrator.text.prep import PrepOptions
        self.assertEqual(PrepOptions().chunking, 'e2a')

    def test_an_unknown_policy_is_refused_by_name(self):
        from narrator.text.prep import PrepError, PrepOptions, _chunking
        with self.assertRaises(PrepError) as caught:
            _chunking(PrepOptions(chunking='greedy'), None)
        self.assertIn('greedy', str(caught.exception))

    def test_the_e2a_policy_passes_no_chunker_at_all(self):
        """`get_chapters`' default argument IS the parity path, so the paragraph
        module must not even be consulted for a default prep."""
        from narrator.text.prep import PrepOptions, _chunking
        chunker, record = _chunking(PrepOptions(), None)
        self.assertIsNone(chunker)
        self.assertEqual(record, {'policy': 'e2a'})

    def test_the_paragraph_policy_records_its_floor_budget_and_provenance(self):
        from narrator.text.prep import PrepOptions, _chunking
        options = PrepOptions(chunking='paragraph', fine_tuned='deathstalker',
                              source_kind=pp.EPUB_NATIVE,
                              chunking_floor_chars=300,
                              budget=ORPHEUS_DEATHSTALKER)
        chunker, record = _chunking(options, None)
        self.assertTrue(callable(chunker))
        self.assertEqual(record['policy'], 'paragraph')
        self.assertEqual(record['floor_chars'], 300)
        self.assertEqual(record['source_kind'], pp.EPUB_NATIVE)
        self.assertEqual(record['budget'],
                         {'voice': 'deathstalker', 'max_chars': 520,
                          'max_chars_per_sec': 22.6})
        self.assertEqual(record['walls'],
                         sorted(['chapter-start', 'heading', 'item',
                                 'scene-break']))


if __name__ == '__main__':
    unittest.main()
