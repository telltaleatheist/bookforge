"""render/session_v1.py + render/flac_header.py, against a synthetic session dir
built from REAL FLACs."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

import soundfile as sf

from narrator.manifest import chunk_path, validate
from narrator.render import flac_header as FH
from narrator.render import session_v1 as S
from narrator.tests import synthetic


class SessionCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def build(self, **kw) -> str:
        return synthetic.build_session(self.tmp, **kw)

    def rewrite_state(self, process_dir, mutate):
        path = os.path.join(process_dir, "session-state.json")
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
        mutate(state)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f)


class TestFlacHeader(SessionCase):
    def test_reads_exact_sample_count(self):
        path = os.path.join(self.tmp, "a.flac")
        n = synthetic.write_flac(path, 1.5)
        info = FH.read_streaminfo(path)
        self.assertEqual(info.samples, n)
        self.assertEqual(info.sample_rate, 24000)
        self.assertEqual(info.channels, 1)
        self.assertEqual(info.bits_per_sample, 16)
        self.assertAlmostEqual(info.duration, 1.5, places=9)

    def test_matches_soundfile(self):
        path = os.path.join(self.tmp, "a.flac")
        synthetic.write_flac(path, 2.0)
        self.assertEqual(FH.read_streaminfo(path).samples, sf.info(path).frames)

    def test_missing_file(self):
        with self.assertRaises(FileNotFoundError):
            FH.read_streaminfo(os.path.join(self.tmp, "nope.flac"))

    def test_not_a_flac(self):
        path = os.path.join(self.tmp, "a.flac")
        with open(path, "wb") as f:
            f.write(b"RIFFxxxxWAVE" + b"\0" * 64)
        with self.assertRaisesRegex(ValueError, "Not a FLAC file"):
            FH.read_streaminfo(path)

    def test_truncated(self):
        src = os.path.join(self.tmp, "a.flac")
        synthetic.write_flac(src, 1.0)
        with open(src, "rb") as f:
            head = f.read(20)
        path = os.path.join(self.tmp, "trunc.flac")
        with open(path, "wb") as f:
            f.write(head)
        with self.assertRaisesRegex(ValueError, "Truncated"):
            FH.read_streaminfo(path)

    def test_zero_total_samples_raises(self):
        src = os.path.join(self.tmp, "a.flac")
        synthetic.write_flac(src, 1.0)
        with open(src, "rb") as f:
            raw = bytearray(f.read())
        # Bits 108..143 of the STREAMINFO block start 8 bytes in (4 magic +
        # 4 block header) at offset 8+13, low nibble.
        raw[8 + 13] &= 0xF0
        for i in range(14, 18):
            raw[8 + i] = 0
        path = os.path.join(self.tmp, "unsized.flac")
        with open(path, "wb") as f:
            f.write(bytes(raw))
        with self.assertRaisesRegex(ValueError, "total_samples 0"):
            FH.read_streaminfo(path)

    def test_read_expected_refuses_wrong_rate(self):
        path = os.path.join(self.tmp, "a.flac")
        synthetic.write_flac(path, 1.0, sample_rate=48000)
        with self.assertRaisesRegex(ValueError, "sample rate is 48000"):
            FH.read_expected(path, 24000, 1)

    def test_read_expected_refuses_wrong_channel_count(self):
        path = os.path.join(self.tmp, "a.flac")
        synthetic.write_flac(path, 1.0, channels=2)
        with self.assertRaisesRegex(ValueError, "2 channel"):
            FH.read_expected(path, 24000, 1)

    def test_homogeneity_guard(self):
        a = os.path.join(self.tmp, "a.flac")
        b = os.path.join(self.tmp, "b.flac")
        synthetic.write_flac(a, 1.0)
        synthetic.write_flac(b, 1.0, sample_rate=48000)
        infos = [FH.read_streaminfo(a), FH.read_streaminfo(b)]
        with self.assertRaisesRegex(ValueError, "samplerate is not homogeneous"):
            FH.assert_concat_homogeneous(infos)
        FH.assert_concat_homogeneous([infos[0]])

    def test_homogeneity_guard_rejects_empty(self):
        with self.assertRaisesRegex(ValueError, "nothing to concatenate"):
            FH.assert_concat_homogeneous([])


class TestBuildManifest(SessionCase):
    def test_shape_and_contiguity(self):
        process_dir = self.build()
        m = S.build_manifest(process_dir)
        validate(m)

        self.assertEqual(m.version, 1)
        self.assertEqual(m.source.kind, "e2a-session-v1")
        self.assertEqual(m.source.processDir, process_dir)
        self.assertEqual(m.source.sessionId, "ccd14111-da29-4fb0-a489-a19a0f126bac")
        self.assertEqual(m.sampleRate, 24000)
        self.assertEqual(len(m.chapters), 3)
        self.assertEqual([c.index for c in m.chapters], [1, 2, 3])
        self.assertEqual(
            [k.index for c in m.chapters for k in c.chunks],
            list(range(len(synthetic.CHUNK_SECONDS))),
        )

    def test_marker_kinds(self):
        m = S.build_manifest(self.build())
        kinds = [k.kind for c in m.chapters for k in c.chunks]
        self.assertEqual(
            kinds,
            ["heading", "prose", "prose",
             "heading", "item", "item", "prose",
             "heading", "prose", "prose"],
        )

    def test_heading_after_a_leading_break_is_still_a_heading(self):
        # '[break][heading]...' - the marker is not at position 0. e2a's own
        # heading test matches anywhere, and so must this one.
        m = S.build_manifest(self.build())
        chunk = m.chapters[1].chunks[0]
        self.assertTrue(chunk.text.startswith("[break][heading]"))
        self.assertEqual(chunk.kind, "heading")

    def test_text_keeps_its_markers(self):
        m = S.build_manifest(self.build())
        self.assertEqual(m.chapters[0].chunks[0].text, "[heading]Chapter One. The Opening.")

    def test_samples_are_exact_and_gaps_are_zero(self):
        process_dir = self.build()
        m = S.build_manifest(process_dir)
        for i, chunk in enumerate(k for c in m.chapters for k in c.chunks):
            expected = int(round(synthetic.CHUNK_SECONDS[i] * 24000))
            self.assertEqual(chunk.samples, expected, f"chunk {i}")
            self.assertEqual(chunk.gapBefore, 0.0)
            self.assertEqual(chunk.gapAfter, 0.0)

    def test_chapter_titles_bind_by_document_identity(self):
        m = S.build_manifest(self.build())
        # c0001 and c0003 come from the TOC; c0002 has no TOC entry, so that
        # chapter falls back to its OWN first row - markers and all.
        self.assertEqual(m.chapters[0].title, "The Opening")
        self.assertEqual(
            m.chapters[1].title, "[break][heading]Chapter Two: A Heading After A Break."
        )
        self.assertEqual(m.chapters[2].title, "The End")
        self.assertEqual(
            [c.doc for c in m.chapters],
            ["text/c0001.xhtml", "text/c0002.xhtml", "text/c0003.xhtml"],
        )

    def test_provenance_is_recovered_from_the_sidecar(self):
        m = S.build_manifest(self.build(write_provenance=True))
        self.assertEqual(m.chapters[0].title, "The Opening")
        self.assertEqual(m.chapters[2].title, "The End")

    def test_unusable_provenance_falls_back_to_own_first_row(self):
        process_dir = self.build(chapter_docs=["only/one.xhtml"], titles_by_doc={})
        m = S.build_manifest(process_dir)
        self.assertEqual(m.chapters[0].title, "[heading]Chapter One. The Opening.")
        self.assertEqual([c.doc for c in m.chapters], [None, None, None])

    def test_paths_in_the_state_file_are_ignored(self):
        # The synthetic state carries /nonexistent/... paths from another machine.
        process_dir = self.build()
        m = S.build_manifest(process_dir)
        self.assertTrue(m.sentencesDir.startswith(process_dir))
        first = m.chapters[0].chunks[0]
        self.assertEqual(first.file, "chapters/sentences/0.flac")
        self.assertTrue(os.path.isfile(chunk_path(m, first)))

    def test_cover_resolution(self):
        m = S.build_manifest(self.build(with_cover=True))
        self.assertEqual(m.book.cover, os.path.join(m.source.processDir, "cover.jpg"))

    def test_no_cover_anywhere_resolves_to_none(self):
        # A separate root: build() reuses one process_dir, so a cover written by
        # an earlier build would still be sitting there.
        root = tempfile.mkdtemp(dir=self.tmp)
        process_dir = synthetic.build_session(root, with_cover=False)
        self.assertIsNone(S.build_manifest(process_dir).book.cover)

    def test_cover_string_without_the_staged_file_raises(self):
        process_dir = self.build(with_cover=False)
        self.rewrite_state(process_dir, lambda s: s.update(cover="whatever.jpg"))
        with self.assertRaisesRegex(S.SessionError, "staged image is not there"):
            S.build_manifest(process_dir)

    def test_cover_of_a_wrong_type_raises(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.update(cover={"a": 1}))
        with self.assertRaisesRegex(S.SessionError, "must be a path string"):
            S.build_manifest(process_dir)

    def test_metadata(self):
        m = S.build_manifest(self.build())
        self.assertEqual(m.book.title, "A Synthetic Book")
        self.assertEqual(m.book.author, "Test Author")
        self.assertEqual(m.book.year, "1993")
        self.assertEqual(m.book.language, "en")
        self.assertEqual(m.book.language3, "eng")
        self.assertEqual(m.voice.engine, "orpheus")
        self.assertEqual(m.voice.fineTuned, "mistborn")

    def test_year_recovered_from_published_when_bookforge_metadata_is_absent(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.pop("bookforge_metadata"))
        m = S.build_manifest(process_dir)
        self.assertEqual(m.book.year, "1993")
        self.assertEqual(m.book.author, "Test Author")


class TestSentencesDirOverride(SessionCase):
    def test_override_repoints_the_audio_only(self):
        process_dir = self.build()
        denoised = os.path.join(process_dir, "chapters", "sentences-denoised")
        os.makedirs(denoised)
        # A DIFFERENT set: every chunk is 0.5 s longer, as a gap pass would leave it.
        for i, seconds in enumerate(synthetic.CHUNK_SECONDS):
            synthetic.write_flac(os.path.join(denoised, f"{i}.flac"), seconds + 0.5)

        base = S.build_manifest(process_dir)
        over = S.build_manifest(process_dir, denoised)

        self.assertEqual(over.sentencesDir, denoised)
        self.assertEqual(over.chapters[0].chunks[0].file,
                         "chapters/sentences-denoised/0.flac")
        # Chapter mapping, titles and cue text are unchanged; only samples move.
        self.assertEqual([c.title for c in base.chapters],
                         [c.title for c in over.chapters])
        self.assertEqual([k.text for c in base.chapters for k in c.chunks],
                         [k.text for c in over.chapters for k in c.chunks])
        for b, o in zip((k for c in base.chapters for k in c.chunks),
                        (k for c in over.chapters for k in c.chunks)):
            self.assertEqual(o.samples - b.samples, 12000)
        self.assertTrue(os.path.isfile(chunk_path(over, over.chapters[0].chunks[0])))

    def test_missing_override_dir_raises(self):
        process_dir = self.build()
        with self.assertRaisesRegex(S.SessionError, "sentences directory not found"):
            S.build_manifest(process_dir, os.path.join(process_dir, "nope"))


class TestChapterSelection(SessionCase):
    """e2a's --chapters, ported for the partially-rendered golden session."""

    def test_parse_chapters_arg(self):
        self.assertEqual(S.parse_chapters_arg(None, 5), [1, 2, 3, 4, 5])
        self.assertEqual(S.parse_chapters_arg("", 3), [1, 2, 3])
        self.assertIsNone(S.parse_chapters_arg("auto", 3))
        self.assertIsNone(S.parse_chapters_arg("  AUTO ", 3))
        self.assertEqual(S.parse_chapters_arg("1-3", 9), [1, 2, 3])
        self.assertEqual(S.parse_chapters_arg("1,3,5", 9), [1, 3, 5])
        self.assertEqual(S.parse_chapters_arg("1-3,7,9", 9), [1, 2, 3, 7, 9])
        self.assertEqual(S.parse_chapters_arg("2", 9), [2])

    def test_parse_chapters_arg_refuses_nonsense(self):
        # e2a warns and continues on both of these, which assembles a different
        # book than the caller asked for.
        with self.assertRaisesRegex(S.SessionError, "not a chapter number"):
            S.parse_chapters_arg("one-three", 9)
        with self.assertRaisesRegex(S.SessionError, "outside this book's 1..9"):
            S.parse_chapters_arg("8-12", 9)
        with self.assertRaisesRegex(S.SessionError, "selected no chapters"):
            S.parse_chapters_arg(",,", 9)

    def test_detect_completed_chapters(self):
        process_dir = self.build()
        sentences = os.path.join(process_dir, "chapters", "sentences")
        self.assertEqual(
            S.detect_completed_chapters(sentences, synthetic.CHAPTER_SENTENCES),
            [1, 2, 3],
        )
        # Chapter 2 is chunks 3..6; drop one and everything from 2 on is out.
        os.remove(os.path.join(sentences, "5.flac"))
        self.assertEqual(
            S.detect_completed_chapters(sentences, synthetic.CHAPTER_SENTENCES), [1]
        )

    def test_detect_stops_at_the_first_hole_not_at_the_last(self):
        # Chapter 1 incomplete, 2 and 3 whole: nothing is assemblable, because an
        # audiobook that starts at chapter 2 is a book with a hole at the front.
        process_dir = self.build()
        sentences = os.path.join(process_dir, "chapters", "sentences")
        os.remove(os.path.join(sentences, "1.flac"))
        self.assertEqual(
            S.detect_completed_chapters(sentences, synthetic.CHAPTER_SENTENCES), []
        )

    def test_auto_builds_a_partial_manifest(self):
        process_dir = self.build()
        sentences = os.path.join(process_dir, "chapters", "sentences")
        for i in (7, 8, 9):
            os.remove(os.path.join(sentences, f"{i}.flac"))
        m = S.build_manifest(process_dir, chapters="auto")
        self.assertEqual([c.index for c in m.chapters], [1, 2])
        self.assertEqual(
            [k.index for c in m.chapters for k in c.chunks], list(range(7))
        )
        validate(m)

    def test_auto_with_nothing_complete_raises(self):
        process_dir = self.build()
        os.remove(os.path.join(process_dir, "chapters", "sentences", "0.flac"))
        with self.assertRaisesRegex(S.SessionError, "no completed chapters"):
            S.build_manifest(process_dir, chapters="auto")

    def test_an_explicit_prefix_selection_works(self):
        m = S.build_manifest(self.build(), chapters="1-2")
        self.assertEqual([c.index for c in m.chapters], [1, 2])
        self.assertEqual(sum(len(c.chunks) for c in m.chapters), 7)

    def test_a_mid_book_selection_is_refused(self):
        with self.assertRaisesRegex(S.SessionError, "contiguous run from chapter 1"):
            S.build_manifest(self.build(), chapters="2-3")
        with self.assertRaisesRegex(S.SessionError, "contiguous run from chapter 1"):
            S.build_manifest(self.build(), chapters="1,3")

    def test_selecting_everything_is_the_whole_book(self):
        full = S.build_manifest(self.build())
        auto = S.build_manifest(self.build(), chapters="auto")
        explicit = S.build_manifest(self.build(), chapters="1-3")
        for other in (auto, explicit):
            self.assertEqual([c.title for c in full.chapters],
                             [c.title for c in other.chapters])
            self.assertEqual(sum(len(c.chunks) for c in full.chapters),
                             sum(len(c.chunks) for c in other.chapters))


class TestFailureModes(SessionCase):
    def test_missing_process_dir(self):
        with self.assertRaisesRegex(S.SessionError, "not a directory"):
            S.build_manifest(os.path.join(self.tmp, "nope"))

    def test_missing_state_file(self):
        process_dir = self.build()
        os.remove(os.path.join(process_dir, "session-state.json"))
        with self.assertRaisesRegex(S.SessionError, "session-state.json not found"):
            S.build_manifest(process_dir)

    def test_bad_json_state(self):
        process_dir = self.build()
        with open(os.path.join(process_dir, "session-state.json"), "w") as f:
            f.write("{oops")
        with self.assertRaisesRegex(S.SessionError, "not valid JSON"):
            S.build_manifest(process_dir)

    def test_wrong_state_version(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.update(version=1))
        with self.assertRaisesRegex(S.SessionError, "state version 2 only"):
            S.build_manifest(process_dir)

    def test_no_chapter_sentences(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.update(chapter_sentences=[]))
        with self.assertRaisesRegex(S.SessionError, "no chapter_sentences"):
            S.build_manifest(process_dir)

    def test_missing_sentences_dir(self):
        process_dir = self.build()
        shutil.rmtree(os.path.join(process_dir, "chapters", "sentences"))
        with self.assertRaisesRegex(S.SessionError, "sentences directory not found"):
            S.build_manifest(process_dir)

    def test_missing_chunk_audio(self):
        process_dir = self.build()
        os.remove(os.path.join(process_dir, "chapters", "sentences", "4.flac"))
        with self.assertRaisesRegex(S.SessionError, r"missing chunk audio.*4\.flac"):
            S.build_manifest(process_dir)

    def test_damaged_chunk_audio(self):
        process_dir = self.build()
        with open(os.path.join(process_dir, "chapters", "sentences", "2.flac"), "wb") as f:
            f.write(b"not a flac at all")
        with self.assertRaisesRegex(ValueError, "Not a FLAC file"):
            S.build_manifest(process_dir)

    def test_chunk_at_the_wrong_sample_rate(self):
        process_dir = self.build()
        synthetic.write_flac(
            os.path.join(process_dir, "chapters", "sentences", "3.flac"),
            1.0, sample_rate=22050,
        )
        with self.assertRaisesRegex(ValueError, "sample rate is 22050"):
            S.build_manifest(process_dir)

    def test_declared_chapter_range_disagreeing_with_the_texts(self):
        process_dir = self.build()

        def mutate(s):
            s["chapters"][1]["sentence_end"] += 1
        self.rewrite_state(process_dir, mutate)
        with self.assertRaisesRegex(S.SessionError, "declares sentences"):
            S.build_manifest(process_dir)

    def test_chapters_list_length_mismatch(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s["chapters"].pop())
        with self.assertRaisesRegex(S.SessionError, "disagrees with itself"):
            S.build_manifest(process_dir)

    def test_total_sentences_mismatch(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.update(total_sentences=99))
        with self.assertRaisesRegex(S.SessionError, "total_sentences=99"):
            S.build_manifest(process_dir)

    def test_required_fields_are_required_not_defaulted(self):
        # Each of these used to be `state.get(k) or "<something>"`. The
        # fine_tuned one is the worst: e2a's own default is the literal
        # 'internal', which CLAUDE.md records as KeyError-ing for Orpheus.
        for key in ("language_iso1", "language", "tts_engine", "fine_tuned"):
            for bad in (None, ""):
                process_dir = self.build()
                self.rewrite_state(process_dir, lambda s, k=key, b=bad: s.update({k: b}))
                with self.assertRaisesRegex(
                    S.SessionError, f"{key!r} is required"
                ):
                    S.build_manifest(process_dir)

    def test_missing_author_raises(self):
        process_dir = self.build()

        def mutate(s):
            s["bookforge_metadata"].pop("author")
            s["metadata"].pop("creator")
        self.rewrite_state(process_dir, mutate)
        with self.assertRaisesRegex(S.SessionError, "has no author"):
            S.build_manifest(process_dir)

    def test_missing_chapters_ranges_raises(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.pop("chapters"))
        with self.assertRaisesRegex(S.SessionError, "no 'chapters' ranges"):
            S.build_manifest(process_dir)

    def test_missing_total_sentences_raises(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.pop("total_sentences"))
        with self.assertRaisesRegex(S.SessionError, "no 'total_sentences'"):
            S.build_manifest(process_dir)

    def test_a_bilingual_session_is_refused(self):
        # The one e2a assembly path that inserts silence of its own.
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda s: s.update(bilingual=True))
        with self.assertRaisesRegex(S.SessionError, "bilingual session"):
            S.build_manifest(process_dir)

    def test_empty_chapter_in_state(self):
        process_dir = self.build(
            chapter_sentences=[["[heading]One."], [], ["Two."]],
            chunk_seconds=[1.0, 1.0],
        )
        with self.assertRaisesRegex(S.SessionError, "has no chunks"):
            S.build_manifest(process_dir)


class TestGapSidecar(SessionCase):
    """`<sentences_dir>/gaps.json` - the one additive sidecar layout v1 gains.

    Prep writes it for engines that do not pad their chunks. Orpheus bakes its
    silence into the FLACs and must NOT have one.
    """

    def higgs_session(self, gaps=None, *, write_gaps=True, engine="higgs-v3",
                      version=1, where="sentences") -> str:
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda st: st.update(tts_engine=engine))
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        if gaps is None:
            gaps = {str(i): {"before": 0.0, "after": 0.6} for i in range(n)}
        if write_gaps:
            target = os.path.join(process_dir, "chapters", where)
            os.makedirs(target, exist_ok=True)
            with open(os.path.join(target, S.GAPS_FILENAME), "w",
                      encoding="utf-8") as f:
                json.dump({"version": version, "engine": engine, "gaps": gaps}, f)
        return process_dir

    # -- the happy path -------------------------------------------------

    def test_gaps_reach_the_manifest(self):
        process_dir = self.higgs_session()
        m = S.build_manifest(process_dir)
        self.assertIsNotNone(m.engine)
        self.assertFalse(m.engine.pads)
        self.assertEqual(m.engine.edgeFadeMs.fade_in, 10.0)
        self.assertEqual(m.engine.edgeFadeMs.fade_out, 25.0)
        for chunk in (k for c in m.chapters for k in c.chunks):
            self.assertEqual(chunk.gapBefore, 0.0)
            self.assertEqual(chunk.gapAfter, 0.6)
        validate(m)

    def test_per_chunk_values_land_on_the_right_chunks(self):
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        gaps = {str(i): {"before": i / 100.0, "after": 0.5} for i in range(n)}
        m = S.build_manifest(self.higgs_session(gaps))
        flat = [k for c in m.chapters for k in c.chunks]
        for i, chunk in enumerate(flat):
            self.assertAlmostEqual(chunk.gapBefore, i / 100.0)
            self.assertAlmostEqual(chunk.gapAfter, 0.5)

    def test_a_missing_field_defaults_to_no_gap_on_that_side(self):
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        m = S.build_manifest(self.higgs_session(
            {str(i): {"after": 0.6} for i in range(n)}))
        first = m.chapters[0].chunks[0]
        self.assertEqual(first.gapBefore, 0.0)
        self.assertEqual(first.gapAfter, 0.6)

    def test_a_derived_set_finds_the_canonical_copy(self):
        # gaps.json beside chapters/sentences; assembly pointed at a derived set.
        process_dir = self.higgs_session()
        denoised = os.path.join(process_dir, "chapters", "sentences-denoised")
        os.makedirs(denoised)
        for i, secs in enumerate(synthetic.CHUNK_SECONDS):
            synthetic.write_flac(os.path.join(denoised, f"{i}.flac"), secs)
        m = S.build_manifest(process_dir, denoised)
        self.assertEqual(m.chapters[0].chunks[0].gapAfter, 0.6)

    def test_a_copy_beside_the_derived_set_wins(self):
        process_dir = self.higgs_session()
        denoised = os.path.join(process_dir, "chapters", "sentences-denoised")
        os.makedirs(denoised)
        for i, secs in enumerate(synthetic.CHUNK_SECONDS):
            synthetic.write_flac(os.path.join(denoised, f"{i}.flac"), secs)
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        with open(os.path.join(denoised, S.GAPS_FILENAME), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "engine": "higgs-v3",
                       "gaps": {str(i): {"before": 0.0, "after": 0.25}
                                for i in range(n)}}, f)
        m = S.build_manifest(process_dir, denoised)
        self.assertEqual(m.chapters[0].chunks[0].gapAfter, 0.25)

    # -- the two refusals -----------------------------------------------

    def test_an_unpadded_session_without_the_file_is_refused(self):
        process_dir = self.higgs_session(write_gaps=False)
        with self.assertRaisesRegex(S.SessionError, "does not pad its chunks"):
            S.build_manifest(process_dir)

    def test_a_padded_session_with_the_file_is_refused(self):
        # Orpheus + gaps.json = the silence would be added twice.
        process_dir = self.build()
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        with open(os.path.join(process_dir, "chapters", "sentences",
                               S.GAPS_FILENAME), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "engine": "orpheus",
                       "gaps": {str(i): {"before": 0.0, "after": 0.6}
                                for i in range(n)}}, f)
        with self.assertRaisesRegex(S.SessionError, "a second time"):
            S.build_manifest(process_dir)

    # -- the file's own validation --------------------------------------

    def test_wrong_version(self):
        with self.assertRaisesRegex(S.SessionError, "gaps.json v1 only"):
            S.build_manifest(self.higgs_session(version=2))

    def test_engine_mismatch(self):
        process_dir = self.higgs_session()
        path = os.path.join(process_dir, "chapters", "sentences", S.GAPS_FILENAME)
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        doc["engine"] = "orpheus"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        with self.assertRaisesRegex(S.SessionError, "written for engine"):
            S.build_manifest(process_dir)

    def test_bad_json(self):
        process_dir = self.higgs_session()
        with open(os.path.join(process_dir, "chapters", "sentences",
                               S.GAPS_FILENAME), "w") as f:
            f.write("{oops")
        with self.assertRaisesRegex(S.SessionError, "not valid JSON"):
            S.build_manifest(process_dir)

    def test_incomplete_coverage_is_refused(self):
        # The failure the no-fallbacks rule exists for: a truncated file would
        # otherwise leave the rest of the book silently unpaused.
        with self.assertRaisesRegex(S.SessionError, "covers 3 of 10 chunks"):
            S.build_manifest(self.higgs_session(
                {str(i): {"before": 0.0, "after": 0.6} for i in range(3)}))

    def test_a_stray_index_is_refused(self):
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        gaps = {str(i): {"before": 0.0, "after": 0.6} for i in range(n)}
        gaps["999"] = {"before": 0.0, "after": 0.6}
        with self.assertRaisesRegex(S.SessionError, "outside this book's"):
            S.build_manifest(self.higgs_session(gaps))

    def test_a_non_numeric_key_is_refused(self):
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        gaps = {str(i): {"before": 0.0, "after": 0.6} for i in range(n)}
        gaps["last"] = {"before": 0.0, "after": 0.6}
        with self.assertRaisesRegex(S.SessionError, "is not a chunk index"):
            S.build_manifest(self.higgs_session(gaps))

    def test_negative_and_non_finite_and_non_numeric_values(self):
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        for bad, pattern in (
            ({"before": -0.1, "after": 0.6}, "negative"),
            ({"before": 0.0, "after": "0.6"}, "must be a number"),
            ({"before": 0.0, "after": float("inf")}, "not finite"),
        ):
            gaps = {str(i): {"before": 0.0, "after": 0.6} for i in range(n)}
            gaps["2"] = bad
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(S.SessionError, pattern):
                    S.build_manifest(self.higgs_session(gaps))

    def test_an_entry_that_is_not_an_object(self):
        n = sum(len(c) for c in synthetic.CHAPTER_SENTENCES)
        gaps = {str(i): {"before": 0.0, "after": 0.6} for i in range(n)}
        gaps["1"] = 0.6
        with self.assertRaisesRegex(S.SessionError, "is not an object"):
            S.build_manifest(self.higgs_session(gaps))

    def test_missing_gaps_object(self):
        process_dir = self.higgs_session()
        path = os.path.join(process_dir, "chapters", "sentences", S.GAPS_FILENAME)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "engine": "higgs-v3"}, f)
        with self.assertRaisesRegex(S.SessionError, "no 'gaps' object"):
            S.build_manifest(process_dir)

    def test_an_unknown_engine_is_refused_before_anything_else(self):
        process_dir = self.build()
        self.rewrite_state(process_dir, lambda st: st.update(tts_engine="xtts"))
        with self.assertRaisesRegex(KeyError, "no assembly profile"):
            S.build_manifest(process_dir)


if __name__ == "__main__":
    unittest.main()
