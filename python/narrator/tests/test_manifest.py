"""manifest.py: round trip, and every validation failure."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest

from narrator import manifest as M


def sample_manifest() -> M.Manifest:
    return M.Manifest(
        source=M.Source(
            kind="e2a-session-v1",
            processDir=r"C:\sessions\hash",
            sessionId="ccd14111-da29-4fb0-a489-a19a0f126bac",
            epubContentHash="6d302f8c08300a7e695e44e1dcbc0209",
        ),
        book=M.Book(
            epubPath=None,
            title="A Book",
            author="An Author",
            year="1993",
            language="en",
            language3="eng",
            cover=None,
        ),
        voice=M.Voice(
            engine="orpheus", fineTuned="mistborn",
            modelDir="/models/mistborn", adapterDir=None, baseDir=None,
        ),
        sampleRate=24000,
        sentencesDir=r"C:\sessions\hash\chapters\sentences",
        chapters=[
            M.Chapter(index=1, title="One", doc="text/c0001.xhtml", chunks=[
                M.Chunk(index=0, text="[heading]One.", kind="heading",
                        file="chapters/sentences/0.flac", samples=36000),
                M.Chunk(index=1, text="Prose.", kind="prose",
                        file="chapters/sentences/1.flac", samples=54000),
            ]),
            M.Chapter(index=2, title="Two", doc=None, chunks=[
                M.Chunk(index=2, text="[item]An item.", kind="item",
                        file="chapters/sentences/2.flac", samples=18000),
            ]),
        ],
    )


class TestRoundTrip(unittest.TestCase):
    def test_save_load_is_lossless(self):
        original = sample_manifest()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "manifest.json")
            M.save(original, path)
            loaded = M.load(path)
        self.assertEqual(M.to_dict(original), M.to_dict(loaded))
        self.assertEqual(original.chapters, loaded.chapters)
        self.assertEqual(original.book, loaded.book)

    def test_saved_json_matches_the_documented_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "manifest.json")
            M.save(sample_manifest(), path)
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        self.assertEqual(
            list(data),
            ["version", "source", "book", "voice", "sampleRate", "sentencesDir",
             "chapters"],
        )
        self.assertEqual(data["version"], 1)
        chunk = data["chapters"][0]["chunks"][0]
        self.assertEqual(
            set(chunk),
            {"index", "text", "kind", "gapBefore", "gapAfter", "file", "samples", "take"},
        )
        # Markers are NOT stripped in the manifest.
        self.assertEqual(chunk["text"], "[heading]One.")

    def test_chunk_path_resolves_against_source_process_dir(self):
        m = sample_manifest()
        self.assertEqual(
            M.chunk_path(m, m.chapters[0].chunks[0]),
            os.path.normpath(
                os.path.join(r"C:\sessions\hash", "chapters/sentences/0.flac")
            ),
        )

    def test_where_the_manifest_is_saved_cannot_change_what_a_chunk_points_at(self):
        # The trap this replaces: save() used to repoint a hidden baseDir at the
        # manifest's new home while `file` stayed relative to the session, so
        # `narrator manifest --out C:\anywhere\m.json` resolved every chunk under
        # C:\anywhere.
        m = sample_manifest()
        before = M.chunk_path(m, m.chapters[0].chunks[0])
        with tempfile.TemporaryDirectory() as tmp:
            deep = os.path.join(tmp, "somewhere", "else")
            os.makedirs(deep)
            M.save(m, os.path.join(deep, "manifest.json"))
            self.assertEqual(M.chunk_path(m, m.chapters[0].chunks[0]), before)
            loaded = M.load(os.path.join(deep, "manifest.json"))
            self.assertEqual(M.chunk_path(loaded, loaded.chapters[0].chunks[0]), before)

    def test_save_does_not_mutate_the_manifest(self):
        m = sample_manifest()
        snapshot = M.to_dict(m)
        with tempfile.TemporaryDirectory() as tmp:
            M.save(m, os.path.join(tmp, "manifest.json"))
        self.assertEqual(M.to_dict(m), snapshot)

    def test_chunk_path_passes_absolute_files_through(self):
        m = sample_manifest()
        m.chapters[0].chunks[0].file = os.path.abspath(os.path.join("x", "0.flac"))
        self.assertTrue(os.path.isabs(M.chunk_path(m, m.chapters[0].chunks[0])))

    def test_chunk_path_without_a_process_dir_raises(self):
        m = sample_manifest()
        m.source.processDir = ""
        with self.assertRaisesRegex(M.ManifestError, "processDir is empty"):
            M.chunk_path(m, m.chapters[0].chunks[0])

    def test_flat_chunks_is_global_order(self):
        m = sample_manifest()
        self.assertEqual([c.index for c in M.flat_chunks(m)], [0, 1, 2])
        self.assertEqual(
            [(ch.index, k.index) for ch, k in M.iter_chapter_chunks(m)],
            [(1, 0), (1, 1), (2, 2)],
        )

    def test_total_samples(self):
        self.assertEqual(M.total_samples(sample_manifest()), 36000 + 54000 + 18000)

    def test_total_samples_raises_on_unrendered_chunk(self):
        m = sample_manifest()
        m.chapters[1].chunks[0].samples = None
        with self.assertRaisesRegex(M.ManifestError, "not fully rendered"):
            M.total_samples(m)


class TestLoadFailures(unittest.TestCase):
    def test_missing_file(self):
        with self.assertRaisesRegex(M.ManifestError, "not found"):
            M.load(os.path.join(tempfile.gettempdir(), "definitely-not-here.json"))

    def test_not_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write("{not json")
            with self.assertRaisesRegex(M.ManifestError, "not valid JSON"):
                M.load(path)

    def test_wrong_schema_version(self):
        data = M.to_dict(sample_manifest())
        data["version"] = 2
        with self.assertRaisesRegex(M.ManifestError, "schema v1"):
            M.from_dict(data)

    def test_every_required_key_is_required(self):
        good = M.to_dict(sample_manifest())
        # top level
        for key in ("source", "book", "voice", "sampleRate", "sentencesDir", "chapters"):
            data = copy.deepcopy(good)
            del data[key]
            with self.assertRaisesRegex(M.ManifestError, f"missing required key '{key}'"):
                M.from_dict(data)
        # nested objects
        for section, keys in (
            ("source", ("kind", "processDir", "sessionId", "epubContentHash")),
            ("book", ("epubPath", "title", "author", "year", "language",
                      "language3", "cover")),
            ("voice", ("engine", "fineTuned", "modelDir", "adapterDir", "baseDir")),
        ):
            for key in keys:
                data = copy.deepcopy(good)
                del data[section][key]
                with self.assertRaisesRegex(
                    M.ManifestError, f"missing required key '{key}'"
                ):
                    M.from_dict(data)
        # chapter and chunk keys
        for key in ("index", "title", "doc", "chunks"):
            data = copy.deepcopy(good)
            del data["chapters"][0][key]
            with self.assertRaisesRegex(M.ManifestError, f"missing required key '{key}'"):
                M.from_dict(data)
        for key in ("index", "text", "kind", "gapBefore", "gapAfter", "file",
                    "samples", "take"):
            data = copy.deepcopy(good)
            del data["chapters"][0]["chunks"][0][key]
            with self.assertRaisesRegex(M.ManifestError, f"missing required key '{key}'"):
                M.from_dict(data)

    def test_chapters_must_be_a_list(self):
        data = M.to_dict(sample_manifest())
        data["chapters"] = {}
        with self.assertRaisesRegex(M.ManifestError, "must be a list"):
            M.from_dict(data)

    def test_chunks_must_be_a_list(self):
        data = M.to_dict(sample_manifest())
        data["chapters"][0]["chunks"] = "nope"
        with self.assertRaisesRegex(M.ManifestError, "must be a list"):
            M.from_dict(data)


class TestValidate(unittest.TestCase):
    def assert_invalid(self, mutate, pattern):
        m = sample_manifest()
        mutate(m)
        with self.assertRaisesRegex(M.ManifestError, pattern):
            M.validate(m)

    def test_valid_manifest_passes(self):
        M.validate(sample_manifest())

    def test_version(self):
        self.assert_invalid(lambda m: setattr(m, "version", 7), "expected 1")

    def test_sample_rate_type(self):
        self.assert_invalid(lambda m: setattr(m, "sampleRate", 24000.0), "must be an int")

    def test_sample_rate_positive(self):
        self.assert_invalid(lambda m: setattr(m, "sampleRate", 0), "must be > 0")

    def test_sentences_dir_non_empty(self):
        self.assert_invalid(lambda m: setattr(m, "sentencesDir", ""), "non-empty")

    def test_no_chapters(self):
        self.assert_invalid(lambda m: setattr(m, "chapters", []), "no book to assemble")

    def test_chapter_index_must_be_one_based_and_contiguous(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0], "index", 0), "expected 1")
        self.assert_invalid(
            lambda m: setattr(m.chapters[1], "index", 3), "expected 2")

    def test_chapter_index_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0], "index", "1"), "must be an int")

    def test_chapter_title_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0], "title", 5), "must be a string")

    def test_chapter_doc_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0], "doc", 5), "must be a string or null")

    def test_empty_chapter(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[1], "chunks", []), "has no chunks")

    def test_chunk_index_hole(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[1].chunks[0], "index", 5), "no holes")

    def test_chunk_index_repeat(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[1].chunks[0], "index", 1), "no holes")

    def test_chunk_index_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "index", 0.0), "must be an int")

    def test_chunk_text_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "text", None), "must be a string")

    def test_chunk_kind(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "kind", "title"), "expected one of")

    def test_chunk_file_empty(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "file", ""), "non-empty string")

    def test_negative_gaps(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "gapBefore", -0.1), "negative")
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "gapAfter", -1), "negative")

    def test_non_finite_gap(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "gapAfter", float("inf")),
            "not finite")
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "gapAfter", float("nan")),
            "not finite")

    def test_gap_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "gapBefore", "0"),
            "must be a number")

    def test_positive_gaps_are_allowed_in_the_schema(self):
        m = sample_manifest()
        m.chapters[0].chunks[0].gapAfter = 0.55
        M.validate(m)  # the SCHEMA allows it; assemble/chapters.py is what refuses it

    def test_samples_type(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "samples", 1.5),
            "must be an int or null")

    def test_samples_zero(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "samples", 0),
            "damaged file")

    def test_samples_none_is_allowed(self):
        m = sample_manifest()
        m.chapters[0].chunks[0].samples = None
        M.validate(m)

    def test_take_type_and_range(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "take", "1"), "must be an int")
        self.assert_invalid(
            lambda m: setattr(m.chapters[0].chunks[0], "take", 0), "must be >= 1")

    def test_duplicate_file(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[1].chunks[0], "file",
                              "chapters/sentences/0.flac"),
            "cannot share one audio file")

    def test_duplicate_file_differing_only_in_separator(self):
        self.assert_invalid(
            lambda m: setattr(m.chapters[1].chunks[0], "file",
                              "chapters\\sentences\\0.flac"),
            "cannot share one audio file")

    def test_files_differing_only_in_CASE_are_two_files(self):
        # ext4 and APFS are case-sensitive and that is where these books render,
        # so 0.flac and 0.FLAC are genuinely different files.
        m = sample_manifest()
        m.chapters[1].chunks[0].file = "chapters/sentences/0.FLAC"
        M.validate(m)

    def test_save_validates_before_writing(self):
        m = sample_manifest()
        m.chapters[0].chunks[0].kind = "bogus"
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.json")
            with self.assertRaises(M.ManifestError):
                M.save(m, path)
            self.assertFalse(os.path.exists(path))


if __name__ == "__main__":
    unittest.main()
