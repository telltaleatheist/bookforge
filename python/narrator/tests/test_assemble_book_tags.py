"""`description` and `publisher`: the two book tags e2a stamped and the port dropped.

ebook2audiobook@9daab0ba `lib/core.py:generate_ffmpeg_metadata:4165-4168` wrote
`description=` and `publisher=` into the ffmetadata document for every MP4-family
container (m4b is one) whenever the session's `metadata` carried them. narrator's
`Manifest.Book` had no field for either, so `render/session_v1.build_manifest`
could not carry them and `assemble/encode.generate_ffmpeg_metadata` could not
write them - and BookForge's own EPUB export WRITES both DC keys
(`electron/epub-processor.ts:11374`, `:11377`), while nothing downstream
re-stamps a rendered m4b (`applyAudiobookMetadata` has no callers).

These tests pin the whole chain: the session reader, the manifest's additive
round-trip, and the document the assembler writes.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from narrator import manifest as M
from narrator.assemble import encode as E
from narrator.render.session_v1 import build_manifest
from narrator.tests import synthetic


def _session_with(root: str, **metadata_extras) -> str:
    """A synthetic process_dir whose `metadata` block carries `metadata_extras`."""
    process_dir = synthetic.build_session(root)
    state_path = os.path.join(process_dir, "session-state.json")
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)
    state["metadata"].update(metadata_extras)
    with open(state_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    return process_dir


class SessionReaderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-book-tags-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_the_two_tags_are_read_off_the_session_metadata(self):
        m = build_manifest(_session_with(
            self.tmp,
            description="A study of the German dictatorship.",
            publisher="Edward Arnold",
        ))
        self.assertEqual(m.book.description, "A study of the German dictatorship.")
        self.assertEqual(m.book.publisher, "Edward Arnold")

    def test_a_session_without_them_carries_None_and_is_not_refused(self):
        m = build_manifest(synthetic.build_session(self.tmp))
        self.assertIsNone(m.book.description)
        self.assertIsNone(m.book.publisher)

    def test_an_empty_string_is_absent_not_an_empty_tag(self):
        # e2a's `if session['metadata'].get('description')` treated '' as absent;
        # writing `description=` would put an empty tag in the container.
        m = build_manifest(_session_with(self.tmp, description="", publisher=""))
        self.assertIsNone(m.book.description)
        self.assertIsNone(m.book.publisher)


class ManifestRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-book-tags-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_they_survive_save_and_load(self):
        m = build_manifest(_session_with(
            self.tmp, description="Blurb.", publisher="Arnold"))
        path = M.save(m, os.path.join(self.tmp, "manifest.json"))
        back = M.load(path)
        self.assertEqual(back.book.description, "Blurb.")
        self.assertEqual(back.book.publisher, "Arnold")

    def test_a_book_without_them_emits_neither_key(self):
        # ADDITIVE: the document a book with no tags produces must be exactly
        # what it produced before these fields existed.
        m = build_manifest(synthetic.build_session(self.tmp))
        book = M.to_dict(m)["book"]
        self.assertNotIn("description", book)
        self.assertNotIn("publisher", book)

    def test_a_manifest_written_before_the_fields_existed_still_loads(self):
        m = build_manifest(synthetic.build_session(self.tmp))
        doc = M.to_dict(m)
        doc["book"].pop("description", None)
        doc["book"].pop("publisher", None)
        back = M.from_dict(doc)
        self.assertIsNone(back.book.description)
        self.assertIsNone(back.book.publisher)


class MetadataDocumentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-book-tags-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _write(self, manifest) -> str:
        path = E.generate_ffmpeg_metadata(
            manifest, [1000, 2000, 3000], os.path.join(self.tmp, "metadata.txt"))
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_both_tags_are_written_in_e2as_order(self):
        text = self._write(build_manifest(_session_with(
            self.tmp, description="A study.", publisher="Edward Arnold")))
        head = text.split("[CHAPTER]", 1)[0].splitlines()
        self.assertEqual(head, [
            ";FFMETADATA1",
            "title=A Synthetic Book",
            "artist=Test Author",
            "language=en",
            "description=A study.",
            "publisher=Edward Arnold",
            "year=1993",
        ])

    def test_a_book_with_neither_writes_the_same_head_it_always_did(self):
        text = self._write(build_manifest(synthetic.build_session(self.tmp)))
        head = text.split("[CHAPTER]", 1)[0].splitlines()
        self.assertEqual(head, [
            ";FFMETADATA1",
            "title=A Synthetic Book",
            "artist=Test Author",
            "language=en",
            "year=1993",
        ])

    def test_a_multiline_blurb_is_escaped_not_refused(self):
        # A publisher's blurb routinely carries newlines and semicolons. The
        # CHAPTER TITLE escape refuses both - correctly, there - so using it here
        # would fail a whole audiobook over a tag. Escaping keeps the value one
        # ffmetadata record and leaves every [CHAPTER] block after it readable.
        blurb = "Line one;\nline two = two\nline three"
        text = self._write(build_manifest(_session_with(self.tmp, description=blurb)))
        self.assertIn(
            "description=Line one\\;\\\nline two \\= two\\\nline three\n", text)
        self.assertEqual(text.count("[CHAPTER]"), 3)
        # The value ENDS at the first newline that is not escaped, and the next
        # record is the one that should follow it - so nothing in the blurb was
        # read as a key of its own and nothing after it was swallowed.
        head = text.split("[CHAPTER]", 1)[0].splitlines()
        self.assertEqual(head[-1], "year=1993")
        self.assertEqual(head[4], "description=Line one\\;\\")

    def test_the_escape_covers_exactly_the_five_ffmetadata_specials(self):
        esc = E._escape_meta_text_value
        self.assertEqual(esc("a=b", "t"), "a\\=b")
        self.assertEqual(esc("a;b", "t"), "a\\;b")
        self.assertEqual(esc("a#b", "t"), "a\\#b")
        self.assertEqual(esc("a\\b", "t"), "a\\\\b")
        self.assertEqual(esc("a\nb", "t"), "a\\\nb")
        self.assertEqual(esc("a\rb", "t"), "a\\\rb")
        # A '-' is NOT special in a value; only the chapter-title escape trims it.
        self.assertEqual(esc("trail-", "t"), "trail-")

    def test_a_NUL_in_a_tag_is_refused_by_name(self):
        with self.assertRaisesRegex(ValueError, "book description contains a NUL"):
            E._escape_meta_text_value("a\x00b", "book description")


if __name__ == "__main__":
    unittest.main()
