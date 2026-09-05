"""Internal-consistency tests for the committed golden fixtures.

These run with NO local binaries and NO audio: everything checked here lives in
`python/narrator/tests/golden/<slug>/`. The point is that a fixture cannot
quietly rot - if someone rebuilds one against the wrong sentences dir, or an
e2a change moves a chapter boundary, the arithmetic below stops adding up.

The one rule worth stating out loud, because it is the one that surprised us:

    len(parse_vtt(reference.vtt)) == len(sentences.json)

e2a writes exactly one cue per rendered chunk it assembled, INCLUDING chunks
whose cue text is empty (a row that is nothing but a `[break]` marker strips to
''). The `<book>.m4b.vtt` sidecar in a BookForge project is NOT that file - it
is ffmpeg re-muxing the m4b's `mov_text` track back to WebVTT, which silently
drops every empty cue. Each fixture's README says which file it holds.

Ported from ebook2audiobook@9daab0ba (lib/conf_models.py:116 vtt_cue_text,
bookforge_ext/parallel/session.py:836 build_vtt_file).
"""

from __future__ import annotations

import json
import os
import re
import unittest

from narrator.tests.golden_tools import local
from narrator.tests.golden_tools.compare import parse_vtt, summarize_probe

GOLDEN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'golden')

# The three books CONTRACTS.md pins for this phase. Hardcoded on purpose: if a
# fixture goes missing, these tests must FAIL, not quietly test nothing.
GOLDEN_SLUGS = ('kershaw', 'blacksun', 'mutineer')

# --- e2a's cue-text transform, ported verbatim so the VTT can be checked
# against session-state.json without importing e2a. -------------------------
SML_UNSPOKEN_PATTERN = re.compile(
    r'\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]',
    re.IGNORECASE,
)
SML_HEADING_PATTERN = re.compile(r'\[/?heading\]', re.IGNORECASE)


def vtt_cue_text(sentence: str) -> str:
    """e2a lib/conf_models.py:116, with SML_UNSPOKEN_PATTERN (what the two
    build_vtt_file copies pass). The heading test runs BEFORE stripping,
    because stripping deletes the marker that carries the fact."""
    is_heading = SML_HEADING_PATTERN.search(sentence) is not None
    text = re.sub(r'\s+', ' ', SML_UNSPOKEN_PATTERN.sub('', sentence)).strip()
    if is_heading and text:
        return '<b>%s</b>' % text
    return text


def load(slug: str, name: str):
    path = os.path.join(GOLDEN_DIR, slug, name)
    if not os.path.isfile(path):
        raise FileNotFoundError('golden fixture file missing: %s' % path)
    with open(path, encoding='utf-8') as f:
        return json.load(f) if name.endswith('.json') else f.read()


class GoldenFixtureTests(unittest.TestCase):
    """One suite, looping the slugs, so a failure names the book."""

    def test_fixture_files_present(self):
        required = ('README.md', 'session-state.json', 'chapter-provenance.json',
                    'sentences.json', 'reference.vtt', 'reference-m4b.json')
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                d = os.path.join(GOLDEN_DIR, slug)
                self.assertTrue(os.path.isdir(d), 'no fixture dir: %s' % d)
                for name in required:
                    self.assertTrue(os.path.isfile(os.path.join(d, name)),
                                    'missing %s in %s' % (name, d))

    def test_fixture_under_size_budget(self):
        """CONTRACTS.md: under 2 MB per book."""
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                d = os.path.join(GOLDEN_DIR, slug)
                size = sum(os.path.getsize(os.path.join(d, n)) for n in os.listdir(d))
                self.assertLess(size, 2 * 1024 * 1024,
                                '%s fixture is %.2f MB' % (slug, size / 1e6))

    def test_sentences_rows_are_well_formed(self):
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                rows = load(slug, 'sentences.json')
                self.assertGreater(len(rows), 0)
                self.assertEqual([r['index'] for r in rows], list(range(len(rows))),
                                 'sentences.json indices are not contiguous from 0')
                rates = set()
                for r in rows:
                    self.assertIsInstance(r['samples'], int)
                    self.assertNotIsInstance(r['samples'], bool)
                    self.assertGreater(r['samples'], 0,
                                       'chunk %d has no samples' % r['index'])
                    self.assertIsInstance(r['bytes'], int)
                    self.assertGreater(r['bytes'], 0)
                    self.assertGreater(r['channels'], 0)
                    self.assertEqual(len(r['sha256']), 64)
                    self.assertRegex(r['sha256'], r'^[0-9a-f]{64}$')
                    self.assertTrue(r['file'].endswith('/%d.flac' % r['index']),
                                    'file %r does not match index %d' % (r['file'], r['index']))
                    rates.add(r['sampleRate'])
                self.assertEqual(len(rates), 1, 'mixed sample rates: %r' % sorted(rates))
                self.assertEqual(len({r['file'] for r in rows}), len(rows),
                                 'duplicate file paths in sentences.json')

    def test_all_rows_come_from_one_sentences_dir(self):
        """The dir the reference was assembled FROM is a parity input."""
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                rows = load(slug, 'sentences.json')
                dirs = {r['file'].rsplit('/', 1)[0] for r in rows}
                self.assertEqual(len(dirs), 1, 'rows span several dirs: %r' % sorted(dirs))
                the_dir = dirs.pop()
                # The three shapes session layout v1 allows (CONTRACTS.md).
                self.assertTrue(
                    the_dir in ('chapters/sentences', 'chapters/sentences-denoised')
                    or the_dir.startswith('chapters/sentences-rvc-'),
                    'unexpected sentences dir %r' % the_dir)
                readme = load(slug, 'README.md')
                self.assertIn(the_dir, readme,
                              'README does not name the sentences dir %r' % the_dir)

    def test_session_state_chapters_are_contiguous(self):
        """chapters[] must cover 0..total_sentences-1 with no holes or overlaps."""
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                state = load(slug, 'session-state.json')
                chapters = state['chapters']
                self.assertEqual(len(chapters), state['total_chapters'])
                self.assertEqual(len(state['chapter_sentences']), state['total_chapters'])

                expect = 0
                for i, ch in enumerate(chapters):
                    self.assertEqual(ch['chapter_num'], i + 1)
                    self.assertEqual(ch['sentence_start'], expect,
                                     'chapter %d starts at %d, expected %d'
                                     % (i + 1, ch['sentence_start'], expect))
                    self.assertEqual(ch['sentence_end'], expect + ch['sentence_count'] - 1)
                    self.assertEqual(ch['sentence_count'],
                                     len(state['chapter_sentences'][i]),
                                     'chapter %d sentence_count disagrees with '
                                     'chapter_sentences' % (i + 1))
                    expect += ch['sentence_count']
                self.assertEqual(expect, state['total_sentences'],
                                 'chapters cover %d chunks, total_sentences is %d'
                                 % (expect, state['total_sentences']))

    def test_reference_vtt_has_one_cue_per_covered_chunk(self):
        """THE rule. See the module docstring for why it is not `total_sentences`."""
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                rows = load(slug, 'sentences.json')
                cues = parse_vtt(load(slug, 'reference.vtt'))
                self.assertEqual(len(cues), len(rows),
                                 'reference.vtt has %d cues for %d covered chunks'
                                 % (len(cues), len(rows)))

    def test_covered_chunks_end_on_a_chapter_boundary(self):
        """A full render covers every chapter; a partial one covers a prefix.

        e2a's `--chapters auto` stops at the first chapter that is not fully
        rendered, so the covered count always lands exactly on a boundary.
        """
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                state = load(slug, 'session-state.json')
                covered = len(load(slug, 'sentences.json'))

                running = 0
                boundaries = {0: 0}
                for i, ch in enumerate(state['chapters']):
                    running += ch['sentence_count']
                    boundaries[running] = i + 1
                self.assertIn(covered, boundaries,
                              '%d covered chunks is not a chapter boundary' % covered)
                n_chapters = boundaries[covered]
                self.assertGreater(n_chapters, 0)

                full = covered == state['total_sentences']
                self.assertEqual(full, n_chapters == state['total_chapters'])

                # A partial fixture must SAY it is partial.
                readme = load(slug, 'README.md')
                if not full:
                    self.assertIn('PARTIAL', readme,
                                  'partial fixture %s does not say so in its README' % slug)

    def test_cue_times_are_the_running_sum_of_samples(self):
        """The heart of the contract: cue times ARE the sample counts.

        This is what makes the VTT and the audio unable to disagree, and it is
        checkable here with no audio present - the fixture carries both halves.
        1 ms is the contract's parity tolerance; the cue text is written with 3
        decimals, so rounding alone can cost 0.0005 s at each end.
        """
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                rows = load(slug, 'sentences.json')
                cues = parse_vtt(load(slug, 'reference.vtt'))
                rate = rows[0]['sampleRate']

                running = 0
                worst = 0.0
                for row, cue in zip(rows, cues):
                    start = running / rate
                    running += row['samples']
                    end = running / rate
                    worst = max(worst, abs(cue['start'] - start), abs(cue['end'] - end))
                self.assertLessEqual(
                    worst, 0.001,
                    '%s: cue times drift from the sample sum by up to %.6f s '
                    '(the reference was probably assembled from a different '
                    'sentences dir than sentences.json describes)' % (slug, worst))

    def test_cue_text_matches_session_state(self):
        """Each cue is `vtt_cue_text` of the stored chunk - headings bold."""
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                state = load(slug, 'session-state.json')
                cues = parse_vtt(load(slug, 'reference.vtt'))
                flat = [s for chapter in state['chapter_sentences'] for s in chapter]
                self.assertGreaterEqual(len(flat), len(cues))
                for i, cue in enumerate(cues):
                    self.assertEqual(cue['text'], vtt_cue_text(flat[i]),
                                     'cue %d text does not match chapter_sentences[%d]'
                                     % (i, i))

    def test_empty_cues_come_only_from_marker_only_rows(self):
        """An empty cue is legitimate, but only for a row that IS just markers.

        This is the check that would catch a chunk silently losing its text.
        """
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                state = load(slug, 'session-state.json')
                cues = parse_vtt(load(slug, 'reference.vtt'))
                flat = [s for chapter in state['chapter_sentences'] for s in chapter]
                for i, cue in enumerate(cues):
                    if cue['text'] == '':
                        stripped = SML_UNSPOKEN_PATTERN.sub('', flat[i]).strip()
                        self.assertEqual(stripped, '',
                                         'cue %d is empty but the stored row is %r'
                                         % (i, flat[i]))

    def test_reference_m4b_probe_is_usable(self):
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                doc = load(slug, 'reference-m4b.json')
                self.assertRegex(doc['sha256'], r'^[0-9a-f]{64}$')
                self.assertIsInstance(doc['bytes'], int)
                self.assertGreater(doc['bytes'], 0)

                summary = summarize_probe(doc, '%s/reference-m4b.json' % slug)
                self.assertGreater(summary['duration'], 0)
                self.assertEqual(summary['audio']['channels'], 1)
                # NOT asserted: a cover stream. e2a only muxes one when the
                # session actually has a cover.jpg on disk, and `blacksun`'s
                # session-state.json claims `"cover": true` while the file is
                # absent - a state field that lies, worth knowing about rather
                # than asserting away. Each README records what its m4b has.
                self.assertIsInstance(summary['has_cover'], bool)

                rows = load(slug, 'sentences.json')
                state = load(slug, 'session-state.json')
                running = 0
                boundaries = {0: 0}
                for i, ch in enumerate(state['chapters']):
                    running += ch['sentence_count']
                    boundaries[running] = i + 1
                self.assertEqual(len(summary['chapters']), boundaries[len(rows)],
                                 'm4b chapter count does not match the covered chapters')

    def test_m4b_chapters_match_the_session(self):
        """Titles and boundaries, against session-state and the sample sums.

        This is the check that catches a TRUNCATED reference. Assembled without
        `--no_split`, e2a splits a long book into parts that all export to the
        same `final_name`, so part 2 overwrites part 1 and the m4b silently
        becomes the book's tail - while still reporting one output file, and
        while the VTT (built earlier) still describes the whole book. The
        give-away is exactly here: chapter 0 of the m4b is not chapter 0 of the
        session, and its boundaries do not line up with the sample sums.
        """
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                state = load(slug, 'session-state.json')
                rows = load(slug, 'sentences.json')
                summary = summarize_probe(load(slug, 'reference-m4b.json'), slug)
                rate = rows[0]['sampleRate']

                titles = state['chapter_titles']
                self.assertGreaterEqual(len(titles), len(summary['chapters']))

                boundary = 0.0
                consumed = 0
                for i, ch in enumerate(summary['chapters']):
                    self.assertEqual(
                        ch['title'], titles[i],
                        'm4b chapter %d is %r, session says %r (a truncated or '
                        'shifted reference?)' % (i, ch['title'], titles[i]))
                    self.assertAlmostEqual(
                        ch['start'], boundary, delta=0.05,
                        msg='m4b chapter %d starts at %.3f s, the sample sums put '
                            'it at %.3f s' % (i, ch['start'], boundary))
                    consumed += state['chapters'][i]['sentence_count']
                    boundary = sum(r['samples'] for r in rows[:consumed]) / rate
                self.assertEqual(consumed, len(rows),
                                 'm4b chapters cover %d chunks, sentences.json has %d'
                                 % (consumed, len(rows)))

    def test_m4b_duration_matches_the_sample_sum(self):
        """AAC pads; the tolerance is per-chapter priming, not a free pass."""
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                rows = load(slug, 'sentences.json')
                doc = load(slug, 'reference-m4b.json')
                summary = summarize_probe(doc, slug)
                expected = sum(r['samples'] for r in rows) / rows[0]['sampleRate']
                delta = summary['duration'] - expected
                # One AAC frame (1024 samples at 44.1 kHz = 23 ms) per chapter
                # join, plus encoder priming.
                budget = 0.05 * max(1, len(summary['chapters'])) + 0.1
                self.assertLessEqual(
                    abs(delta), budget,
                    '%s: m4b is %.3f s, sample sum is %.3f s (delta %+.3f s, '
                    'budget %.3f s)' % (slug, summary['duration'], expected, delta, budget))

    def test_metadata_txt_when_present(self):
        """e2a's ;FFMETADATA1: one [CHAPTER] per covered chapter, ms timebase."""
        for slug in GOLDEN_SLUGS:
            path = os.path.join(GOLDEN_DIR, slug, 'metadata.txt')
            if not os.path.isfile(path):
                continue
            with self.subTest(slug=slug):
                text = load(slug, 'metadata.txt')
                self.assertTrue(text.startswith(';FFMETADATA1'))
                starts = [int(m) for m in re.findall(r'^START=(\d+)$', text, re.M)]
                ends = [int(m) for m in re.findall(r'^END=(\d+)$', text, re.M)]
                self.assertEqual(len(starts), len(ends))
                self.assertGreater(len(starts), 0)
                self.assertEqual(starts[0], 0)
                for i in range(1, len(starts)):
                    self.assertEqual(starts[i], ends[i - 1],
                                     'chapter %d does not start where %d ended'
                                     % (i, i - 1))

                rows = load(slug, 'sentences.json')
                expected_ms = round(
                    sum(r['samples'] for r in rows) / rows[0]['sampleRate'] * 1000)
                self.assertLessEqual(
                    abs(ends[-1] - expected_ms), 2,
                    'metadata.txt ends at %d ms, sample sum is %d ms'
                    % (ends[-1], expected_ms))

    def test_chapter_provenance_matches_session_state(self):
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                state = load(slug, 'session-state.json')
                prov = load(slug, 'chapter-provenance.json')
                self.assertIn('chapter_docs', prov)
                self.assertEqual(len(prov['chapter_docs']), state['total_chapters'],
                                 'chapter-provenance has %d docs for %d chapters'
                                 % (len(prov['chapter_docs']), state['total_chapters']))


class GoldenLocalCopyTests(unittest.TestCase):
    """Ties the committed fixture to the real audio - when it is present.

    These SKIP without the local binaries, which is the one permitted
    "missing input" behaviour in CONTRACTS.md and only in tests. Everything in
    GoldenFixtureTests above runs with no binaries at all.
    """

    def test_reference_vtt_matches_the_local_copy(self):
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                local.require(self, slug)
                self.assertEqual(local.read_reference_vtt(slug), load(slug, 'reference.vtt'),
                                 'committed reference.vtt differs from the local copy')

    def test_sentences_json_describes_the_real_flacs(self):
        """Every row's sha256 and byte count must still match the file.

        This is what catches a fixture rebuilt against the wrong sentences dir,
        or a chunk retaken in Studio after the fixture was frozen.
        """
        import hashlib
        for slug in GOLDEN_SLUGS:
            with self.subTest(slug=slug):
                entry = local.require(self, slug)
                rows = load(slug, 'sentences.json')
                process_dir = entry['localProcessDir']
                # Hashing every chunk of every book is ~4 GB of IO; a spread of
                # 25 per book is enough to catch a wrong directory or a retake.
                step = max(1, len(rows) // 25)
                for row in rows[::step]:
                    path = os.path.join(process_dir, row['file'].replace('/', os.sep))
                    self.assertTrue(os.path.isfile(path), 'missing chunk: %s' % path)
                    self.assertEqual(os.path.getsize(path), row['bytes'],
                                     'size changed: %s' % path)
                    h = hashlib.sha256()
                    with open(path, 'rb') as f:
                        for blk in iter(lambda: f.read(1 << 20), b''):
                            h.update(blk)
                    self.assertEqual(h.hexdigest(), row['sha256'],
                                     'content changed: %s' % path)


if __name__ == '__main__':
    unittest.main()
