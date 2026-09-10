"""The silence BETWEEN chapters: `chapter_gap`, end to end.

WHAT IS BEING PROVED, and why each of these is its own test:

  1. IT IS IN THE AUDIO. Both encode paths - the serial whole-book encode and
     the per-chapter parallel one - have to put it there, by two different
     mechanisms (a FLAC in the sentence concat list, an .m4a in the encoded one),
     and a book assembled either way must come out the same length.
  2. IT IS IN THE TRANSCRIPT. The VTT is sealed into the m4b as its subtitle
     track. A gap in the audio that is not in the cue times drifts the whole
     transcript by one gap per chapter, and nothing downstream can detect it.
  3. IT BELONGS TO THE CHAPTER IT FOLLOWS. Seeking to a chapter must land on its
     first word, not three seconds of nothing.
  4. IT DOES NOT MOVE THE DURATION GUARDS. `plan.audio_samples` is what the two
     "did every sentence reach the encoder" checks compare against, and a chapter
     BookForge pre-encoded during the render contains no gap at all.
  5. THE FLAC IT WRITES MATCHES THE SET IT JOINS. ffmpeg's concat demuxer drops
     frames whose blocksize exceeds the first entry's and STILL EXITS 0, so a gap
     written at the wrong blocksize is silently not there. This is the one
     failure mode of this feature that nothing else in the pipeline would catch.
  6. ZERO IS THE OLD BEHAVIOUR, exactly - the plans, the cue times and the
     duration of a book assembled with no chapter gap are unchanged.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest

import numpy as np
import soundfile as sf

from narrator.assemble import encode as E
from narrator.assemble import run as R
from narrator.assemble import vtt as V
from narrator.assemble.chapters import plan_chapters, total_duration
from narrator.assemble.ffmpeg_tools import (
    FfmpegError,
    probe_duration,
    resolve_binary,
    write_concat_list,
)
from narrator.render.flac_header import StreamInfo, read_streaminfo
from narrator.render.session_v1 import build_manifest
from narrator.tests import synthetic
from narrator.tests.test_assemble_synthetic import EXPECTED_SECONDS, probe_json

try:
    FFMPEG = resolve_binary("ffmpeg")
    FFPROBE = resolve_binary("ffprobe")
except FfmpegError:
    FFMPEG = FFPROBE = None

SKIP_REASON = "ffmpeg/ffprobe are not on PATH; assembly cannot be exercised"

RATE = 24000
GAP = 3.0
#: Three chapters, so two gaps. The last chapter never gets one.
GAPS_IN_THE_BOOK = 2


class SessionCase(unittest.TestCase):
    """A fresh synthetic session per test, with its own manifest."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-chapgap-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.process_dir = synthetic.build_session(self.tmp)
        self.manifest = build_manifest(self.process_dir)
        self.lines: list[str] = []


class PlanTest(SessionCase):
    def test_every_chapter_but_the_last_carries_the_gap(self):
        plans = plan_chapters(self.manifest, log=self.lines.append, chapter_gap=GAP)
        self.assertEqual([p.gap_after for p in plans], [GAP, GAP, 0.0])
        self.assertEqual([p.gap_samples for p in plans],
                         [int(GAP * RATE), int(GAP * RATE), 0])

    def test_the_gap_is_not_in_the_chapter_s_own_audio(self):
        """`paths`/`infos` are the chapter's sentences and nothing else - which is
        what both encode duration guards compare against."""
        plain = plan_chapters(self.manifest, log=self.lines.append)
        gapped = plan_chapters(self.manifest, log=self.lines.append, chapter_gap=GAP)
        self.assertEqual([p.paths for p in gapped], [p.paths for p in plain])
        self.assertEqual([p.audio_samples for p in gapped],
                         [p.samples for p in plain])
        for plan in gapped:
            self.assertEqual(plan.samples, plan.audio_samples + plan.gap_samples)

    def test_the_whole_book_grows_by_exactly_the_gaps(self):
        plain = plan_chapters(self.manifest, log=self.lines.append)
        gapped = plan_chapters(self.manifest, log=self.lines.append, chapter_gap=GAP)
        self.assertAlmostEqual(
            total_duration(gapped, RATE),
            total_duration(plain, RATE) + GAP * GAPS_IN_THE_BOOK,
            places=9,
        )

    def test_zero_is_the_old_behaviour_exactly(self):
        plain = plan_chapters(self.manifest, log=self.lines.append)
        zero = plan_chapters(self.manifest, log=self.lines.append, chapter_gap=0.0)
        self.assertEqual([p.samples for p in zero], [p.samples for p in plain])
        self.assertEqual([p.gap_after for p in zero], [0.0, 0.0, 0.0])

    def test_a_negative_gap_is_refused_by_name(self):
        with self.assertRaises(ValueError) as caught:
            plan_chapters(self.manifest, log=self.lines.append, chapter_gap=-1.0)
        self.assertIn("chapter_gap", str(caught.exception))


class TranscriptTest(SessionCase):
    """The cue times are the FINISHED book's timeline, or the subtitle track that
    gets sealed into the m4b drifts a gap per chapter."""

    def test_every_cue_after_a_boundary_moves_by_one_gap(self):
        plain = V.chunk_spans(self.manifest)
        gapped = V.chunk_spans(self.manifest, chapter_gap=GAP)
        self.assertEqual(len(plain), len(gapped))

        # How many chapter boundaries each chunk sits after.
        boundaries = []
        for position, chapter in enumerate(self.manifest.chapters):
            boundaries.extend([position] * len(chapter.chunks))

        for (_c, p_start, p_end), (_g, g_start, g_end), behind in zip(
                plain, gapped, boundaries):
            self.assertAlmostEqual(g_start, p_start + GAP * behind, places=9)
            self.assertAlmostEqual(g_end, p_end + GAP * behind, places=9)

    def test_the_transcript_ends_where_the_last_word_does(self):
        """Not after a gap: the end of the book is not a boundary between
        anything, and `vtt_duration` is what the bridge holds the m4b to."""
        spans = V.chunk_spans(self.manifest, chapter_gap=GAP)
        self.assertAlmostEqual(
            V.vtt_duration(self.manifest, GAP), spans[-1][2], places=9
        )
        self.assertAlmostEqual(
            V.vtt_duration(self.manifest, GAP),
            V.vtt_duration(self.manifest) + GAP * GAPS_IN_THE_BOOK,
            places=9,
        )

    def test_the_written_vtt_carries_the_shifted_times(self):
        path = os.path.join(self.tmp, "book.vtt")
        V.write_vtt(self.manifest, path, GAP)
        body = open(path, encoding="utf-8").read()
        last_start = V.chunk_spans(self.manifest, chapter_gap=GAP)[-1][1]
        self.assertIn(V.format_timestamp(last_start), body)

    def test_the_sentence_transcript_moves_with_it(self):
        from narrator.assemble.sentence_vtt import estimated_cues_for_manifest

        plain = estimated_cues_for_manifest(self.manifest)
        gapped = estimated_cues_for_manifest(self.manifest, chapter_gap=GAP)
        self.assertEqual(len(plain), len(gapped))
        # The last cue is in the last chapter, two boundaries in.
        self.assertAlmostEqual(
            gapped[-1].start_s, plain[-1].start_s + GAP * GAPS_IN_THE_BOOK, places=6
        )


@unittest.skipIf(FFMPEG is None, SKIP_REASON)
class GapFileTest(unittest.TestCase):
    """THE failure mode nothing else would catch: a silence FLAC whose blocksize
    does not match the set it is concatenated with has its frames dropped by
    ffmpeg's concat demuxer, silently, with exit 0."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-gapfile-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _chunk_at(self, blocksize: int, name: str = "chunk.flac") -> str:
        """A real FLAC at a chosen blocksize - what a rendered chunk looks like.
        libsndfile only ever writes 4096, so this goes through ffmpeg."""
        path = os.path.join(self.tmp, name)
        src = os.path.join(self.tmp, "src-" + name)
        sf.write(src, np.zeros((RATE, 1)) + 0.1, RATE, subtype="PCM_16",
                 format="FLAC")
        E.run(
            [FFMPEG, "-hide_banner", "-v", "error", "-i", src,
             "-c:a", "flac", "-sample_fmt", "s16",
             "-frame_size", str(blocksize), "-y", path],
            "test chunk",
        )
        return path

    def test_the_gap_is_written_at_the_set_s_own_blocksize(self):
        for blocksize in (2304, 4096):
            with self.subTest(blocksize=blocksize):
                chunk = self._chunk_at(blocksize, f"c{blocksize}.flac")
                info = read_streaminfo(chunk)
                self.assertEqual(info.max_blocksize, blocksize)
                gap = E.chapter_gap_flac(
                    GAP, info, os.path.join(self.tmp, f"g{blocksize}.flac"), FFMPEG
                )
                written = read_streaminfo(gap)
                self.assertEqual(written.max_blocksize, blocksize)
                self.assertEqual(written.sample_rate, info.sample_rate)
                self.assertEqual(written.channels, info.channels)
                self.assertEqual(written.samples, int(GAP * RATE))

    def test_the_gap_survives_the_concat_demuxer(self):
        """The end of the argument: concatenate chunk + gap + chunk through the
        real demuxer and count the samples that came out. A blocksize mismatch
        loses the gap here and NOWHERE ELSE."""
        chunk = self._chunk_at(2304)
        info = read_streaminfo(chunk)
        gap = E.chapter_gap_flac(
            GAP, info, os.path.join(self.tmp, "gap.flac"), FFMPEG
        )
        lst = write_concat_list([chunk, gap, chunk],
                                os.path.join(self.tmp, "list.txt"))
        out = os.path.join(self.tmp, "joined.flac")
        E.run(
            [FFMPEG, "-hide_banner", "-v", "error", "-f", "concat", "-safe", "0",
             "-i", lst, "-c:a", "flac", "-y", out],
            "test concat",
        )
        self.assertEqual(
            read_streaminfo(out).samples, 2 * info.samples + int(GAP * RATE)
        )

    def test_a_24_bit_set_gets_a_24_bit_gap(self):
        """The Mac's MLX renders are PCM_24. The demuxer takes the whole stream's
        parameters from the first entry, so the gap declares the set's depth."""
        src = os.path.join(self.tmp, "src24.flac")
        sf.write(src, np.zeros((RATE, 1)) + 0.1, RATE, subtype="PCM_24",
                 format="FLAC")
        info = read_streaminfo(src)
        self.assertEqual(info.bits_per_sample, 24)
        gap = E.chapter_gap_flac(
            GAP, info, os.path.join(self.tmp, "gap24.flac"), FFMPEG
        )
        self.assertEqual(read_streaminfo(gap).bits_per_sample, 24)

    def test_a_depth_the_gap_cannot_match_is_refused_by_name(self):
        """Rather than written at some other depth and shipped.

        The StreamInfo is built by hand: FLAC permits 32-bit and libsndfile will
        not WRITE it, so there is no way to make the file this refusal is about -
        and the refusal has to exist anyway, because the answer to a depth the
        gap cannot match may not be a gap at some other depth."""
        info = StreamInfo(path="pretend.flac", min_blocksize=4096,
                          max_blocksize=4096, sample_rate=RATE, channels=1,
                          bits_per_sample=32, samples=RATE)
        with self.assertRaises(FfmpegError) as caught:
            E.chapter_gap_flac(GAP, info,
                               os.path.join(self.tmp, "gap32.flac"), FFMPEG)
        self.assertIn("bits per sample", str(caught.exception))

    def test_a_zero_gap_is_not_a_file(self):
        chunk = self._chunk_at(4096)
        with self.assertRaises(FfmpegError):
            E.chapter_gap_flac(0.0, read_streaminfo(chunk),
                               os.path.join(self.tmp, "no.flac"), FFMPEG)


@unittest.skipIf(FFMPEG is None, SKIP_REASON)
class SerialPathTest(SessionCase):
    """`assemble()` on a book under the loudnorm cutoff, which is the serial
    encode - the path that joins the SENTENCE FLACs, so the gap is a FLAC."""

    def _assemble(self, gap: float):
        out_dir = os.path.join(self.tmp, f"out-{gap}")
        return R.assemble(
            self.manifest, out_dir, ffmpeg=FFMPEG, ffprobe=FFPROBE,
            progress=self.lines.append, chapter_gap=gap,
        )

    def test_the_book_is_longer_by_exactly_the_gaps(self):
        result = self._assemble(GAP)
        self.assertTrue(any("Serial encode" in l for l in self.lines))
        self.assertAlmostEqual(
            probe_duration(result.m4b_path, FFPROBE),
            EXPECTED_SECONDS + GAP * GAPS_IN_THE_BOOK,
            # One AAC frame at 44.1 kHz is 23 ms and the serial encode's
            # loudnorm pass costs a couple of them either way. Three seconds is
            # 130 frames; this delta cannot mistake a missing gap for rounding.
            delta=0.100,
        )

    def test_a_chapter_marker_ends_after_its_own_gap(self):
        """The gap belongs to the chapter it FOLLOWS, so seeking to chapter two
        lands on its first word rather than on three seconds of nothing."""
        result = self._assemble(GAP)
        chapters = probe_json(result.m4b_path)["chapters"]
        self.assertEqual(len(chapters), 3)
        starts = [float(c["start_time"]) for c in chapters]
        ends = [float(c["end_time"]) for c in chapters]
        # No holes: each chapter starts where the previous one ended.
        for previous_end, start in zip(ends, starts[1:]):
            self.assertAlmostEqual(previous_end, start, delta=0.010)
        first_chapter_audio = sum(synthetic.CHUNK_SECONDS[:3])
        self.assertAlmostEqual(ends[0], first_chapter_audio + GAP, delta=0.050)

    def test_the_audio_at_the_boundary_is_actually_silent(self):
        """Not just longer - SILENT. A gap realized as a repeat of the last
        sentence would satisfy every duration check in this file."""
        result = self._assemble(GAP)
        boundary = sum(synthetic.CHUNK_SECONDS[:3])
        wav = os.path.join(self.tmp, "boundary.wav")
        E.run(
            [FFMPEG, "-hide_banner", "-v", "error",
             "-ss", f"{boundary + 0.5:.3f}", "-t", "2.0",
             "-i", result.m4b_path, "-y", wav],
            "boundary extract",
        )
        data, _rate = sf.read(wav, dtype="float64", always_2d=True)
        self.assertGreater(data.shape[0], 0)
        self.assertLess(float(np.max(np.abs(data))), 0.01)

    def test_the_transcript_and_the_audio_agree(self):
        result = self._assemble(GAP)
        self.assertAlmostEqual(
            probe_duration(result.m4b_path, FFPROBE),
            V.vtt_duration(self.manifest, GAP),
            delta=0.100,
        )

    def test_zero_assembles_the_book_it_always_did(self):
        result = self._assemble(0.0)
        self.assertAlmostEqual(
            probe_duration(result.m4b_path, FFPROBE), EXPECTED_SECONDS, delta=0.100
        )


@unittest.skipIf(FFMPEG is None, SKIP_REASON)
class ParallelPathTest(SessionCase):
    """The per-chapter encode + stream-copy concat, where the gap is an .m4a.
    `assemble()` only reaches this path for a book over two hours, so the
    machinery is driven directly - as `test_assemble_synthetic` does."""

    def setUp(self):
        super().setUp()
        self.plans = plan_chapters(self.manifest, log=self.lines.append,
                                   chapter_gap=GAP)
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)

    def _encode(self, pre_encoded=None):
        return E.encode_chapters_parallel(
            plans=self.plans, pre_encoded=pre_encoded or {}, work_dir=self.work,
            ffmpeg=FFMPEG, ffprobe=FFPROBE, sample_rate=RATE, channels=1,
            workers=3, log=self.lines.append,
        )

    def test_each_chapter_encode_holds_only_its_own_audio(self):
        """The chapter .m4a is the sentences. The gap is added where chapters are
        JOINED, which is the only level a pre-encoded chapter can reach too."""
        for path, plan in zip(self._encode(), self.plans):
            self.assertAlmostEqual(
                probe_duration(path, FFPROBE), plan.audio_duration(RATE), delta=0.050
            )

    def test_the_joined_book_carries_the_gaps(self):
        chapter_paths = self._encode()
        meta = E.generate_ffmpeg_metadata(
            self.manifest,
            R._chapter_durations_ms(self.plans, {}, RATE, FFPROBE),
            os.path.join(self.work, "metadata.txt"),
        )
        out = os.path.join(self.tmp, "book.m4b")
        E.concat_encoded(
            chapter_paths=chapter_paths, plans=self.plans, metadata_file=meta,
            cover=None, out_path=out, work_dir=self.work, ffmpeg=FFMPEG,
            channels=1, log=self.lines.append,
        )
        self.assertAlmostEqual(
            probe_duration(out, FFPROBE),
            EXPECTED_SECONDS + GAP * GAPS_IN_THE_BOOK,
            delta=0.100,
        )
        chapters = probe_json(out)["chapters"]
        self.assertEqual(len(chapters), 3)
        self.assertAlmostEqual(
            float(chapters[0]["end_time"]),
            sum(synthetic.CHUNK_SECONDS[:3]) + GAP,
            delta=0.100,
        )

    def test_a_pre_encoded_chapter_is_still_accepted(self):
        """BookForge's chapter-closer encodes a chapter's sentences and nothing
        else. Holding it to a duration that included a gap it cannot contain
        would reject every pre-encoded chapter in the library."""
        encoded_dir = os.path.join(self.tmp, "encoded")
        os.makedirs(encoded_dir)
        for path, plan in zip(self._encode(), self.plans):
            shutil.copy(path, os.path.join(encoded_dir, f"{plan.index}.m4a"))

        accepted = E.load_encoded_chapters(
            encoded_dir, self.plans, RATE, FFPROBE, self.lines.append
        )
        self.assertEqual(sorted(accepted), [p.index for p in self.plans])
        self.assertFalse([l for l in self.lines if "REJECTED" in l])

    def test_a_pre_encoded_chapter_s_marker_gets_the_gap_back(self):
        markers = R._chapter_durations_ms(self.plans, {}, RATE, FFPROBE)
        self.assertEqual(
            markers, [int(round(p.duration(RATE) * 1000)) for p in self.plans]
        )
