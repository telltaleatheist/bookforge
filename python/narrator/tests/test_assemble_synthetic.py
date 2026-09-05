"""End-to-end assembly of the synthetic book, with a real ffmpeg.

Skips (loudly) when ffmpeg/ffprobe are not on PATH - that is a missing TOOL, not
a missing input, and there is nothing this test could assert without it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

from narrator.assemble import encode as E
from narrator.assemble import run as R
from narrator.assemble import vtt as V
from narrator.assemble.chapters import plan_chapters, total_duration
from narrator.assemble.ffmpeg_tools import FfmpegError, probe_duration, resolve_binary
from narrator.render.session_v1 import build_manifest
from narrator.tests import synthetic

try:
    FFMPEG = resolve_binary("ffmpeg")
    FFPROBE = resolve_binary("ffprobe")
except FfmpegError:
    FFMPEG = FFPROBE = None

SKIP_REASON = "ffmpeg/ffprobe are not on PATH; assembly cannot be exercised"

EXPECTED_SECONDS = sum(synthetic.CHUNK_SECONDS)  # 10.75


def probe_json(path: str) -> dict:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_format", "-show_chapters", "-show_streams",
         "-of", "json", path],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


@unittest.skipIf(FFMPEG is None, SKIP_REASON)
class TestAssembleSynthetic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="narrator-assemble-")
        cls.process_dir = synthetic.build_session(cls.tmp)
        synthetic.make_real_cover(
            os.path.join(cls.process_dir, "cover.jpg"), FFMPEG
        )
        cls.manifest = build_manifest(cls.process_dir)
        cls.out_dir = os.path.join(cls.tmp, "out")
        cls.lines: list[str] = []
        started = time.monotonic()
        cls.result = R.assemble(
            cls.manifest, cls.out_dir,
            ffmpeg=FFMPEG, ffprobe=FFPROBE,
            progress=cls.lines.append,
        )
        cls.wall = time.monotonic() - started
        cls.probe = probe_json(cls.result.m4b_path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- the file itself ------------------------------------------------

    def test_m4b_exists_and_is_named_the_way_e2a_names_it(self):
        self.assertTrue(os.path.isfile(self.result.m4b_path))
        self.assertGreater(os.path.getsize(self.result.m4b_path), 0)
        self.assertEqual(
            os.path.basename(self.result.m4b_path),
            "A_Synthetic_Book._Test_Author.__1993_.m4b",
        )

    def test_duration_matches_the_sample_total(self):
        # This book takes the SERIAL path, so loudnorm is in the chain and its
        # lookahead flush lengthens the stream by ~50 ms. e2a has exactly the
        # same overshoot: Kershaw's e2a m4b measures 2624.000 s against a
        # 2623.941 s sample total, +59 ms. The stream-copy path (no loudnorm) is
        # sample-exact - see TestParallelPath.
        measured = probe_duration(self.result.m4b_path, FFPROBE)
        self.assertGreaterEqual(measured, EXPECTED_SECONDS)
        self.assertLessEqual(measured - EXPECTED_SECONDS, 0.100)
        self.assertAlmostEqual(self.result.duration_s, measured, places=6)

    def test_chapter_count_and_titles(self):
        chapters = self.probe["chapters"]
        self.assertEqual(len(chapters), 3)
        self.assertEqual(self.result.chapter_count, 3)
        self.assertEqual(
            [c["tags"]["title"] for c in chapters],
            ["The Opening", "Chapter Two: A Heading After A Break.", "The End"],
        )

    def test_chapter_boundaries_tile_the_book_with_no_gap(self):
        chapters = self.probe["chapters"]
        self.assertEqual(chapters[0]["start"], 0)
        for a, b in zip(chapters, chapters[1:]):
            self.assertEqual(a["end"], b["start"])
        plans = plan_chapters(self.manifest)
        self.assertEqual(
            [c["end"] - c["start"] for c in chapters],
            [int(round(p.duration(24000) * 1000)) for p in plans],
        )

    def test_codec_parameters_match_e2a(self):
        audio = [s for s in self.probe["streams"] if s["codec_type"] == "audio"]
        self.assertEqual(len(audio), 1)
        self.assertEqual(audio[0]["codec_name"], "aac")
        self.assertEqual(audio[0]["sample_rate"], "44100")
        self.assertEqual(audio[0]["channels"], 1)

    def test_cover_is_attached(self):
        video = [s for s in self.probe["streams"] if s["codec_type"] == "video"]
        self.assertEqual(len(video), 1, "expected exactly one attached picture")
        self.assertEqual(video[0]["codec_name"], "mjpeg")
        self.assertEqual(video[0]["disposition"]["attached_pic"], 1)

    def test_book_tags(self):
        tags = self.probe["format"]["tags"]
        self.assertEqual(tags["title"], "A Synthetic Book")
        self.assertEqual(tags["artist"], "Test Author")

    # -- the transcript -------------------------------------------------

    def test_vtt_exists_beside_the_m4b_with_the_same_stem(self):
        self.assertTrue(os.path.isfile(self.result.vtt_path))
        self.assertEqual(
            os.path.splitext(os.path.basename(self.result.vtt_path))[0],
            os.path.splitext(os.path.basename(self.result.m4b_path))[0],
        )

    def test_vtt_parses_and_covers_every_chunk(self):
        with open(self.result.vtt_path, encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.startswith("WEBVTT\n\n"))
        cues = [l for l in text.splitlines() if "-->" in l]
        self.assertEqual(len(cues), len(synthetic.CHUNK_SECONDS))
        self.assertIn("<b>Chapter One. The Opening.</b>", text)
        self.assertNotIn("[heading]", text)
        self.assertNotIn("[item]", text)

    def test_vtt_last_cue_end_is_not_ahead_of_the_m4b(self):
        # electron/reassembly-bridge.ts:2219 refuses to promote an audiobook more
        # than 5 s shorter than its own transcript.
        last_end = V.vtt_duration(self.manifest)
        self.assertLess(last_end - self.result.duration_s, 5.0)

    # -- what else is in output_dir ------------------------------------

    def test_output_dir_holds_only_the_m4b_and_the_vtt(self):
        entries = sorted(os.listdir(self.out_dir))
        files = [e for e in entries if os.path.isfile(os.path.join(self.out_dir, e))]
        self.assertEqual(
            sorted(files),
            sorted([os.path.basename(self.result.m4b_path),
                    os.path.basename(self.result.vtt_path)]),
        )

    def test_work_dir_is_named_for_this_process(self):
        # Two assemblies sharing one output_dir must not share a work dir: the
        # start-of-run rmtree would delete the other one's live concat list.
        self.assertIn(f"{os.getpid():x}", os.path.basename(R.work_dir_for(self.out_dir)))
        self.assertNotEqual(R.work_dir_for(self.out_dir),
                            os.path.join(self.out_dir, R.WORK_DIRNAME))

    def test_work_dir_is_removed_on_success(self):
        self.assertFalse(os.path.isdir(R.work_dir_for(self.out_dir)))
        # and nothing else calling itself a work dir either
        self.assertEqual(
            [e for e in os.listdir(self.out_dir) if e.startswith(R.WORK_DIRNAME)],
            [],
        )

    # -- the progress contract ------------------------------------------

    def test_emits_the_lines_the_reassembly_bridge_parses(self):
        joined = "\n".join(self.lines)
        self.assertIn("[ASSEMBLE] Assembling all 3 chapters...", self.lines)
        self.assertIn("[ASSEMBLE] Chapter 1: sentences 0-2", self.lines)
        self.assertIn("[ASSEMBLE] Chapter 3: sentences 7-9", self.lines)
        self.assertIn("Assemble completed!", self.lines)
        self.assertIn("[ASSEMBLE] Creating VTT subtitle file...", self.lines)
        self.assertIn("[ASSEMBLE] Combining chapters into final audiobook...", self.lines)
        self.assertTrue(any(l.startswith("Export - ") for l in self.lines))
        self.assertIn('"success": true', joined)

    def test_progress_lines_match_the_bridge_regexes(self):
        import re
        assembling = re.compile(r"Assembling (?:all |audiobook from )(\d+) chapters")
        chapter = re.compile(r"(?:\[ASSEMBLE\] Chapter|Combining chapter)\s*(\d+)")
        export = re.compile(r"Export\s*-\s*([\d.]+)%")
        self.assertEqual(
            [m.group(1) for l in self.lines for m in [assembling.search(l)] if m], ["3"]
        )
        self.assertEqual(
            [m.group(1) for l in self.lines for m in [chapter.search(l)] if m],
            ["1", "2", "3"],
        )
        pcts = [float(m.group(1)) for l in self.lines for m in [export.search(l)] if m]
        self.assertTrue(pcts)
        self.assertEqual(pcts, sorted(pcts))
        self.assertEqual(pcts[-1], 100.0)

    def test_all_log_lines_are_ascii(self):
        for line in self.lines:
            line.encode("ascii")

    def test_serial_path_was_taken_for_a_short_book(self):
        # 10.75 s is far under the 7200 s loudnorm cutoff, so e2a would encode it
        # serially with loudnorm - and so must narrator.
        self.assertTrue(any("Serial encode" in l for l in self.lines))
        self.assertFalse(any("Parallel encode" in l for l in self.lines))


@unittest.skipIf(FFMPEG is None, SKIP_REASON)
class TestParallelPath(unittest.TestCase):
    """The per-chapter encode + stream-copy concat, exercised directly.

    `assemble()` only reaches it for a book over two hours, which is 345 MB of
    24 kHz FLAC - so the gate is tested by its own unit tests and the machinery
    behind it is tested here.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-parallel-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.process_dir = synthetic.build_session(self.tmp)
        synthetic.make_real_cover(os.path.join(self.process_dir, "cover.jpg"), FFMPEG)
        self.manifest = build_manifest(self.process_dir)
        self.plans = plan_chapters(self.manifest)
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)
        self.lines: list[str] = []

    def encode_all(self, pre_encoded=None):
        return E.encode_chapters_parallel(
            plans=self.plans, pre_encoded=pre_encoded or {}, work_dir=self.work,
            ffmpeg=FFMPEG, ffprobe=FFPROBE, sample_rate=24000, channels=1,
            workers=3, log=self.lines.append,
        )

    def test_per_chapter_encode_then_stream_copy(self):
        chapter_paths = self.encode_all()
        self.assertEqual(len(chapter_paths), 3)
        for path, plan in zip(chapter_paths, self.plans):
            # No loudnorm on this path, so the encode is sample-exact.
            self.assertAlmostEqual(
                probe_duration(path, FFPROBE), plan.duration(24000), delta=0.050
            )

        durations = [int(round(p.duration(24000) * 1000)) for p in self.plans]
        meta = E.generate_ffmpeg_metadata(
            self.manifest, durations, os.path.join(self.work, "metadata.txt")
        )
        out = os.path.join(self.tmp, "book.m4b")
        E.concat_encoded(chapter_paths, meta, self.manifest.book.cover, out,
                         self.work, FFMPEG, self.lines.append)

        probe = probe_json(out)
        self.assertAlmostEqual(
            probe_duration(out, FFPROBE), EXPECTED_SECONDS, delta=0.050
        )
        self.assertEqual(len(probe["chapters"]), 3)
        audio = [s for s in probe["streams"] if s["codec_type"] == "audio"][0]
        self.assertEqual(audio["codec_name"], "aac")
        self.assertEqual(audio["sample_rate"], "44100")
        video = [s for s in probe["streams"] if s["codec_type"] == "video"]
        self.assertEqual(video[0]["disposition"]["attached_pic"], 1)
        # The stream-copy path carries no filter, so the join is sample-exact.
        self.assertAlmostEqual(
            probe_duration(out, FFPROBE), EXPECTED_SECONDS, delta=0.050
        )
        # e2a's tag shape, carried by -movflags +use_metadata_tags.
        self.assertEqual(probe["format"]["tags"]["year"], "1993")
        self.assertEqual(probe["format"]["tags"]["language"], "en")

    def test_pre_encoded_chapters_are_reused_verbatim(self):
        encoded = self.encode_all()
        # Hand chapter 2 back as a pre-encoded file named <chapterNum>.m4a,
        # the way electron/chapter-closer.ts:255 writes it.
        handoff = os.path.join(self.tmp, "encoded")
        os.makedirs(handoff)
        shutil.copyfile(encoded[1], os.path.join(handoff, "2.m4a"))

        accepted = E.load_encoded_chapters(
            handoff, self.plans, 24000, FFPROBE, self.lines.append)
        self.assertEqual(set(accepted), {2})

        work2 = os.path.join(self.tmp, "work2")
        os.makedirs(work2)
        lines: list[str] = []
        paths = E.encode_chapters_parallel(
            plans=self.plans, pre_encoded=accepted, work_dir=work2,
            ffmpeg=FFMPEG, ffprobe=FFPROBE, sample_rate=24000, channels=1,
            workers=3, log=lines.append,
        )
        self.assertEqual(paths[1], accepted[2])
        self.assertTrue(any("1 already encoded by BookForge" in l for l in lines))
        self.assertTrue(any("Parallel encode: 2 chapters" in l for l in lines))

    def test_unusable_pre_encoded_chapters_are_reported_and_rebuilt(self):
        handoff = os.path.join(self.tmp, "encoded")
        os.makedirs(handoff)
        open(os.path.join(handoff, "2.m4a"), "wb").close()          # 0 bytes
        open(os.path.join(handoff, "chapter-three.m4a"), "wb").close()  # unmappable
        with open(os.path.join(handoff, "9.m4a"), "wb") as f:       # not our chapter
            f.write(b"x" * 32)

        accepted = E.load_encoded_chapters(
            handoff, self.plans, 24000, FFPROBE, self.lines.append)
        self.assertEqual(accepted, {})
        joined = "\n".join(self.lines)
        self.assertIn("chapter 2 REJECTED", joined)
        self.assertIn("0 bytes", joined)
        self.assertIn("not named <chapter_number>.m4a", joined)
        self.assertIn("claims chapter 9", joined)

    def test_a_stale_pre_encoded_chapter_is_rejected_by_duration(self):
        """The case that name checks and probe checks both miss.

        `2.m4a` here is a perfectly valid, probeable, correctly named AAC file -
        it is just chapter 1's audio under chapter 2's name, which is what a
        leftover from an earlier sentence set looks like. Copied verbatim it
        would desync the book from its own transcript from that chapter on.
        """
        encoded = self.encode_all()
        handoff = os.path.join(self.tmp, "stale")
        os.makedirs(handoff)
        # Chapter 1 (4.50 s) under chapter 2's name (4.00 s). Only 0.50 s out -
        # INSIDE the 0.54 s that concat_tolerance would have allowed a 4-chunk
        # chapter, which is exactly why the pre-encoded guard uses the tight
        # PRE_ENCODED_TOLERANCE_S (0.06 s) instead.
        shutil.copyfile(encoded[0], os.path.join(handoff, "2.m4a"))

        lines: list[str] = []
        accepted = E.load_encoded_chapters(
            handoff, self.plans, 24000, FFPROBE, lines.append)
        self.assertEqual(accepted, {})
        joined = "\n".join(lines)
        self.assertIn("chapter 2 REJECTED", joined)
        self.assertIn("different sentence set", joined)

    def test_the_pre_encoded_tolerance_is_tighter_than_the_concat_guard(self):
        from narrator.assemble.chapters import concat_tolerance
        # The whole point: a 4-chunk chapter gets 0.54 s from concat_tolerance,
        # which is wide enough to swallow a neighbouring chapter.
        self.assertAlmostEqual(concat_tolerance(4), 0.54, places=9)
        self.assertEqual(E.PRE_ENCODED_TOLERANCE_S, 0.06)
        self.assertLess(E.PRE_ENCODED_TOLERANCE_S, concat_tolerance(1))

    def test_a_correct_pre_encoded_chapter_passes_the_duration_guard(self):
        encoded = self.encode_all()
        handoff = os.path.join(self.tmp, "good")
        os.makedirs(handoff)
        for i, plan in enumerate(self.plans):
            shutil.copyfile(encoded[i], os.path.join(handoff, f"{plan.index}.m4a"))
        lines: list[str] = []
        accepted = E.load_encoded_chapters(
            handoff, self.plans, 24000, FFPROBE, lines.append)
        self.assertEqual(set(accepted), {1, 2, 3})
        self.assertNotIn("REJECTED", "\n".join(lines))

    def test_a_missing_encoded_dir_is_a_hard_error(self):
        with self.assertRaisesRegex(FfmpegError, "not a directory"):
            E.load_encoded_chapters(os.path.join(self.tmp, "nope"), self.plans,
                                    24000, FFPROBE, self.lines.append)

    def test_no_encoded_dir_is_simply_empty(self):
        self.assertEqual(
            E.load_encoded_chapters(
                None, self.plans, 24000, FFPROBE, self.lines.append), {}
        )


class TestEncodeGate(unittest.TestCase):
    """parallel_export_unsupported_reason - which encode path e2a would take."""

    def reason(self, **kw):
        args = dict(output_format="m4b", source_duration=20000.0,
                    post_render_filter=None, final_denoise=False, output_split=False)
        args.update(kw)
        return E.parallel_export_unsupported_reason(**args)

    def test_long_mp4_book_may_use_the_parallel_path(self):
        self.assertIsNone(self.reason())

    def test_short_book_may_not(self):
        self.assertIn("cutoff", self.reason(source_duration=7200.0))
        self.assertIn("cutoff", self.reason(source_duration=1.0))
        self.assertIsNone(self.reason(source_duration=7200.1))

    def test_non_mp4_output_may_not(self):
        self.assertIn("not MP4-family", self.reason(output_format="mp3"))
        for fmt in ("m4b", "m4a", "mp4", "mov"):
            self.assertIsNone(self.reason(output_format=fmt))

    def test_filters_may_not(self):
        self.assertIn("post_render_filter", self.reason(post_render_filter="anequalizer"))
        self.assertIn("FINAL_DENOISE", self.reason(final_denoise=True))

    def test_split_may_not(self):
        self.assertIn("split into parts", self.reason(output_split=True))

    def test_unknown_duration_may_not(self):
        self.assertIn("unknown", self.reason(source_duration=0.0))


class TestMetadataDocument(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-meta-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.manifest = build_manifest(synthetic.build_session(self.tmp))

    def test_document_shape(self):
        path = E.generate_ffmpeg_metadata(
            self.manifest, [1000, 2000, 3000], os.path.join(self.tmp, "metadata.txt")
        )
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.startswith(";FFMETADATA1\n"))
        self.assertIn("title=A Synthetic Book\n", text)
        self.assertIn("artist=Test Author\n", text)
        self.assertIn("language=en\n", text)
        self.assertIn("year=1993\n", text)
        self.assertEqual(text.count("[CHAPTER]"), 3)
        self.assertIn("START=0\nEND=1000\ntitle=The Opening\n", text)
        self.assertIn("START=1000\nEND=3000\n", text)
        self.assertIn("START=3000\nEND=6000\ntitle=The End\n", text)
        # The marker-carrying fallback title is sanitized, never printed raw.
        self.assertNotIn("[heading]", text)
        self.assertNotIn("[break]", text)

    def test_duration_count_must_match_chapter_count(self):
        with self.assertRaisesRegex(ValueError, "2 durations for 3 chapters"):
            E.generate_ffmpeg_metadata(
                self.manifest, [1, 2], os.path.join(self.tmp, "m.txt")
            )

    def test_a_title_that_would_corrupt_the_document_is_refused(self):
        self.manifest.chapters[0].title = "Bad; title"
        with self.assertRaisesRegex(ValueError, "would terminate the ffmetadata record"):
            E.generate_ffmpeg_metadata(
                self.manifest, [1, 2, 3], os.path.join(self.tmp, "m.txt")
            )

    def test_escapes(self):
        self.assertEqual(E._escape_meta_value("#lead", "t"), "\\#lead")
        self.assertEqual(E._escape_meta_value("a=b", "t"), "a\\=b")
        self.assertEqual(E._escape_meta_value("a\\b", "t"), "a\\\\b")
        self.assertEqual(E._escape_meta_value("trail-", "t"), "trail\\-")

    def test_chapter_title_sanitizer(self):
        self.assertEqual(
            E.sanitize_meta_chapter_title("[break][heading]Chapter Two."), "Chapter Two."
        )
        self.assertEqual(E.sanitize_meta_chapter_title(None), "")
        self.assertEqual(E.sanitize_meta_chapter_title("a\x00b"), "ab")
        long = "x" * 200
        self.assertLessEqual(
            len(E.sanitize_meta_chapter_title(long).encode("utf-8")), 140
        )


class TestAssembleGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-guards-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.process_dir = synthetic.build_session(self.tmp)
        self.manifest = build_manifest(self.process_dir)

    def test_a_chunk_that_disappears_after_the_manifest_was_built(self):
        os.remove(os.path.join(self.process_dir, "chapters", "sentences", "5.flac"))
        with self.assertRaisesRegex(FileNotFoundError, r"missing chunk 5"):
            plan_chapters(self.manifest)

    def test_a_chunk_that_changed_after_the_manifest_was_built(self):
        synthetic.write_flac(
            os.path.join(self.process_dir, "chapters", "sentences", "5.flac"), 9.0
        )
        with self.assertRaisesRegex(ValueError, "the audio changed"):
            plan_chapters(self.manifest)

    def test_a_zero_byte_chunk(self):
        open(os.path.join(self.process_dir, "chapters", "sentences", "5.flac"),
             "wb").close()
        with self.assertRaisesRegex(ValueError, "is 0 bytes"):
            plan_chapters(self.manifest)

    def test_a_non_zero_gap_is_refused_for_a_padded_engine(self):
        # Not "not implemented" any more - realizing gaps IS implemented, for
        # engines that need it. For a padded engine a gap is double-counting,
        # and on that path it would be silently discarded.
        self.manifest.chapters[0].chunks[1].gapAfter = 0.55
        with self.assertRaisesRegex(ValueError, "already PCM inside the FLAC"):
            plan_chapters(self.manifest, self.tmp)

    def test_total_duration_is_the_sample_sum(self):
        plans = plan_chapters(self.manifest)
        self.assertAlmostEqual(total_duration(plans, 24000), EXPECTED_SECONDS, places=9)

    @unittest.skipIf(FFMPEG is None, SKIP_REASON)
    def test_a_non_mp4_output_format_is_refused(self):
        with self.assertRaisesRegex(FfmpegError, "MP4 family only"):
            R.assemble(self.manifest, os.path.join(self.tmp, "o"),
                       ffmpeg=FFMPEG, ffprobe=FFPROBE, output_format="mp3",
                       progress=lambda _l: None)

    @unittest.skipIf(FFMPEG is None, SKIP_REASON)
    def test_work_dir_survives_a_failure_as_evidence(self):
        out = os.path.join(self.tmp, "o2")
        self.manifest.chapters[0].title = "Bad; title"
        with self.assertRaises(ValueError):
            R.assemble(self.manifest, out, ffmpeg=FFMPEG, ffprobe=FFPROBE,
                       progress=lambda _l: None)
        self.assertTrue(os.path.isdir(R.work_dir_for(out)))


class TestFinalName(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-name-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.manifest = build_manifest(synthetic.build_session(self.tmp))

    def test_title_author_year(self):
        self.assertEqual(
            R.final_name(self.manifest), "A_Synthetic_Book._Test_Author.__1993_.m4b"
        )

    def test_title_author_only(self):
        self.manifest.book.year = None
        self.assertEqual(
            R.final_name(self.manifest), "A_Synthetic_Book._Test_Author.m4b"
        )

    def test_title_only(self):
        self.manifest.book.year = None
        self.manifest.book.author = ""
        self.assertEqual(R.final_name(self.manifest), "A_Synthetic_Book.m4b")

    def test_get_sanitized_matches_e2a(self):
        # Kershaw, the real session this was measured against.
        self.assertEqual(
            R.get_sanitized("Working Towards The Fuhrer. Ian Kershaw. (1993).m4b"),
            "Working_Towards_The_Fuhrer._Ian_Kershaw.__1993_.m4b",
        )
        self.assertEqual(R.get_sanitized("A & B"), "A_And_B")
        self.assertEqual(R.get_sanitized('a<>:"/\\|?*b'), "a_________b")

    def test_the_state_files_own_final_name_is_not_used(self):
        # session-state.json says staged-<uuid>.m4b; assembly recomputes the name.
        self.assertNotIn("staged-", R.final_name(self.manifest))


if __name__ == "__main__":
    unittest.main()
