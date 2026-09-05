"""assemble/vtt.py: timestamp format, cue text rule, block structure, and the
running-sum arithmetic including gaps."""

from __future__ import annotations

import os
import tempfile
import unittest

from narrator import manifest as M
from narrator.assemble import vtt as V


def manifest_with(chunks, sample_rate=24000) -> M.Manifest:
    """One chapter holding `chunks` as (text, kind, samples[, gapBefore, gapAfter])."""
    built = []
    for i, spec in enumerate(chunks):
        text, kind, samples = spec[0], spec[1], spec[2]
        before = spec[3] if len(spec) > 3 else 0.0
        after = spec[4] if len(spec) > 4 else 0.0
        built.append(M.Chunk(index=i, text=text, kind=kind, samples=samples,
                             file=f"chapters/sentences/{i}.flac",
                             gapBefore=before, gapAfter=after))
    return M.Manifest(
        source=M.Source(kind="e2a-session-v1", processDir="/p", sessionId="s",
                        epubContentHash="h"),
        book=M.Book(epubPath=None, title="T", author="A", year=None,
                    language="en", language3="eng", cover=None),
        voice=M.Voice(engine="orpheus", fineTuned="v", modelDir=None,
                      adapterDir=None, baseDir=None),
        sampleRate=sample_rate,
        sentencesDir="/p/chapters/sentences",
        chapters=[M.Chapter(index=1, title="T", doc=None, chunks=built)],
    )


class TestTimestamp(unittest.TestCase):
    def test_format(self):
        self.assertEqual(V.format_timestamp(0.0), "00:00:00.000")
        self.assertEqual(V.format_timestamp(2.921), "00:00:02.921")
        self.assertEqual(V.format_timestamp(59.999), "00:00:59.999")
        self.assertEqual(V.format_timestamp(60.0), "00:01:00.000")
        self.assertEqual(V.format_timestamp(2623.841), "00:43:43.841")
        self.assertEqual(V.format_timestamp(3600.0), "01:00:00.000")
        self.assertEqual(V.format_timestamp(3661.5), "01:01:01.500")
        self.assertEqual(V.format_timestamp(72000.25), "20:00:00.250")

    def test_seconds_field_is_always_two_digits_plus_millis(self):
        # 06.3f means "at least 6 chars wide, 3 after the point" -> SS.mmm
        for value in (1.0, 9.999, 10.0, 59.999):
            self.assertRegex(V.format_timestamp(value), r"^\d{2}:\d{2}:\d{2}\.\d{3}$")

    def test_the_bridge_promotion_gate_regex_matches_what_we_write(self):
        # electron/reassembly-bridge.ts:36
        #   /-->\s+(\d{2,}):(\d{2}):(\d{2})\.(\d{3})/g
        import re
        cue_re = re.compile(r"-->\s+(\d{2,}):(\d{2}):(\d{2})\.(\d{3})")
        m = manifest_with([("Hello.", "prose", 24000)])
        self.assertTrue(cue_re.search(V.build_vtt(m)))


class TestCueText(unittest.TestCase):
    def test_markers_are_stripped(self):
        self.assertEqual(V.cue_text("[break]Hello there.", False), "Hello there.")
        self.assertEqual(V.cue_text("[item]An item.", False), "An item.")
        self.assertEqual(V.cue_text("[pause:1.5]Wait.", False), "Wait.")
        self.assertEqual(V.cue_text("[silence]Quiet.", False), "Quiet.")
        self.assertEqual(V.cue_text("[/heading]Closed.", False), "Closed.")

    def test_headings_are_bold(self):
        self.assertEqual(
            V.cue_text("[heading]Chapter Eight.", True), "<b>Chapter Eight.</b>"
        )
        self.assertEqual(
            V.cue_text("[break][heading]Chapter Eight.", True), "<b>Chapter Eight.</b>"
        )

    def test_items_are_not_bold(self):
        self.assertEqual(V.cue_text("[item]An item.", False), "An item.")

    def test_an_empty_payload_stays_empty(self):
        # A bare [break] row must never become '<b></b>'.
        self.assertEqual(V.cue_text("[break]", False), "")
        self.assertEqual(V.cue_text("[heading]", True), "")

    def test_whitespace_is_collapsed(self):
        self.assertEqual(V.cue_text("A   b\n c \t d ", False), "A b c d")


class TestBuildVtt(unittest.TestCase):
    def test_structure(self):
        m = manifest_with([
            ("[heading]One.", "heading", 24000),      # 1.000 s
            ("Two.", "prose", 12000),                 # 0.500 s
            ("[break]", "prose", 2400),               # 0.100 s, empty cue
        ])
        out = V.build_vtt(m)
        self.assertEqual(
            out,
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:01.000\n<b>One.</b>\n"
            "\n"
            "00:00:01.000 --> 00:00:01.500\nTwo.\n"
            "\n"
            "00:00:01.500 --> 00:00:01.600\n\n",
        )

    def test_no_cue_identifiers_and_no_note_blocks(self):
        m = manifest_with([("[heading]One.", "heading", 24000), ("Two.", "prose", 24000)])
        out = V.build_vtt(m)
        self.assertNotIn("NOTE", out)
        for line in out.splitlines():
            self.assertFalse(line.strip().isdigit(), f"cue identifier leaked: {line!r}")

    def test_running_sum_is_exact_across_many_chunks(self):
        chunks = [(f"Line {i}.", "prose", 2400 + i) for i in range(200)]
        m = manifest_with(chunks)
        out = V.build_vtt(m)
        total = sum(2400 + i for i in range(200)) / 24000
        self.assertIn(f"--> {V.format_timestamp(total)}", out.splitlines()[-2])
        self.assertAlmostEqual(V.vtt_duration(m), total, places=9)

    def test_cues_are_contiguous(self):
        m = manifest_with([(f"L{i}.", "prose", 3000 * (i + 1)) for i in range(5)])
        lines = [l for l in V.build_vtt(m).splitlines() if "-->" in l]
        for a, b in zip(lines, lines[1:]):
            self.assertEqual(a.split(" --> ")[1], b.split(" --> ")[0])

    def test_gaps_shift_the_timeline(self):
        m = manifest_with([
            ("One.", "prose", 24000, 0.0, 0.5),   # 0.000 -> 1.000, then +0.5
            ("Two.", "prose", 24000, 0.25, 0.0),  # +0.25 -> 1.750 -> 2.750
        ])
        out = V.build_vtt(m)
        self.assertIn("00:00:00.000 --> 00:00:01.000", out)
        self.assertIn("00:00:01.750 --> 00:00:02.750", out)
        self.assertAlmostEqual(V.vtt_duration(m), 2.75, places=9)

    def test_unrendered_chunk_raises(self):
        m = manifest_with([("One.", "prose", 24000)])
        m.chapters[0].chunks[0].samples = None
        with self.assertRaisesRegex(ValueError, "no sample count"):
            V.build_vtt(m)
        with self.assertRaisesRegex(ValueError, "no sample count"):
            V.vtt_duration(m)

    def test_write_vtt_uses_lf_and_utf8(self):
        m = manifest_with([("Führer. Über.", "prose", 24000)])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "book.vtt")
            V.write_vtt(m, path)
            with open(path, "rb") as f:
                raw = f.read()
        self.assertNotIn(b"\r\n", raw)
        self.assertIn("Über".encode("utf-8"), raw)

    def test_write_vtt_refuses_a_missing_directory(self):
        m = manifest_with([("One.", "prose", 24000)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "not a directory"):
                V.write_vtt(m, os.path.join(tmp, "nope", "book.vtt"))


if __name__ == "__main__":
    unittest.main()
