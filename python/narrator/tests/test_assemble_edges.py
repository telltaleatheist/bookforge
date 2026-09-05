"""Chunk edge treatment for engines that do not pad: fades and realized gaps.

The Orpheus (padded) path must be provably untouched by any of this - that is
what the golden parity tests guard, and `test_the_padded_path_never_processes`
here states it directly.
"""

from __future__ import annotations

import math
import os
import shutil
import tempfile
import unittest

import numpy as np
import soundfile as sf

from narrator import manifest as M
from narrator.assemble import edges as E
from narrator.assemble.chapters import plan_chapters
from narrator.assemble.engine_profiles import PROFILES, profile_for
from narrator.assemble.ffmpeg_tools import FfmpegError, resolve_binary
from narrator.assemble import vtt
from narrator.assemble.vtt import vtt_duration
from narrator.render.flac_header import read_streaminfo
from narrator.tests import synthetic

try:
    FFMPEG = resolve_binary("ffmpeg")
    FFPROBE = resolve_binary("ffprobe")
except FfmpegError:
    FFMPEG = FFPROBE = None

RATE = 24000


def write_square(path: str, seconds: float, level: float = 0.5,
                 sample_rate: int = RATE) -> int:
    """A clip with deliberately ABRUPT edges: full level from the first sample
    to the last. This is the shape a content-trimmed Higgs chunk has and the
    shape that clicks on a butt join."""
    n = int(round(seconds * sample_rate))
    data = np.full((n, 1), level, dtype=np.float64)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, data, sample_rate, subtype="PCM_16", format="FLAC")
    return n


class TestWindows(unittest.TestCase):
    def test_raised_cosine_shape(self):
        w = E.raised_cosine_in(4)
        self.assertEqual(len(w), 4)
        # strictly inside (0, 1), monotonically rising
        self.assertGreater(w[0], 0.0)
        self.assertLess(w[-1], 1.0)
        self.assertTrue(np.all(np.diff(w) > 0))
        # symmetric with its reverse
        np.testing.assert_allclose(E.raised_cosine_out(4), w[::-1])

    def test_raised_cosine_is_half_at_the_midpoint(self):
        w = E.raised_cosine_in(101)
        self.assertAlmostEqual(w[50], 0.5, places=12)

    def test_zero_length_window(self):
        self.assertEqual(len(E.raised_cosine_in(0)), 0)
        self.assertEqual(len(E.raised_cosine_in(-3)), 0)

    def test_fade_samples(self):
        self.assertEqual(E.fade_samples(10.0, 24000), 240)
        self.assertEqual(E.fade_samples(25.0, 24000), 600)
        self.assertEqual(E.fade_samples(0.0, 24000), 0)

    def test_gap_frames_rounds_once(self):
        self.assertEqual(E.gap_frames(0.5, 24000), 12000)
        self.assertEqual(E.gap_frames(0.0, 24000), 0)
        # the one rounding rule the VTT and the audio share
        self.assertEqual(E.gap_frames(0.3333333, 24000), round(0.3333333 * 24000))


class TestApplyEdgeFades(unittest.TestCase):
    def flat(self, n: int) -> np.ndarray:
        return np.ones((n, 1), dtype=np.float64)

    def test_length_is_unchanged(self):
        data = self.flat(1000)
        out = E.apply_edge_fades(data, 240, 600)
        self.assertEqual(out.shape, (1000, 1))

    def test_edges_are_attenuated_and_the_middle_is_not(self):
        data = E.apply_edge_fades(self.flat(2000), 240, 600)
        self.assertLess(data[0, 0], 0.001)          # first sample nearly silent
        self.assertLess(data[-1, 0], 0.001)         # last sample nearly silent
        self.assertAlmostEqual(data[1000, 0], 1.0)  # middle untouched

    def test_the_fade_is_monotonic_over_its_window(self):
        data = E.apply_edge_fades(self.flat(2000), 240, 600)
        self.assertTrue(np.all(np.diff(data[:240, 0]) > 0))
        self.assertTrue(np.all(np.diff(data[-600:, 0]) < 0))

    def test_windows_never_overlap_on_a_short_clip(self):
        # 35 ms of treatment on a 20 ms clip: no sample may be faded twice.
        n = E.fade_samples(20.0, RATE)
        data = E.apply_edge_fades(self.flat(n), E.fade_samples(10.0, RATE),
                                  E.fade_samples(25.0, RATE))
        self.assertEqual(data.shape[0], n)
        self.assertTrue(np.all(data[:, 0] <= 1.0 + 1e-12))
        self.assertTrue(np.all(data[:, 0] >= 0.0))

    def test_empty_audio_raises(self):
        with self.assertRaisesRegex(ValueError, "empty audio"):
            E.apply_edge_fades(np.zeros((0, 1)), 10, 10)


class TestEngineProfiles(unittest.TestCase):
    def test_orpheus_pads_and_does_not_fade(self):
        p = profile_for("orpheus")
        self.assertTrue(p.pads)
        self.assertEqual((p.fade_in_ms, p.fade_out_ms), (0.0, 0.0))
        self.assertFalse(p.needs_processing)

    def test_higgs_does_not_pad_and_fades_10_25(self):
        p = profile_for("higgs-v3")
        self.assertFalse(p.pads)
        self.assertEqual((p.fade_in_ms, p.fade_out_ms), (10.0, 25.0))
        self.assertTrue(p.needs_processing)

    def test_an_unknown_engine_raises(self):
        with self.assertRaisesRegex(KeyError, "no assembly profile"):
            profile_for("xtts")

    def test_every_profile_id_matches_its_key(self):
        for key, profile in PROFILES.items():
            self.assertEqual(key, profile.id)


class EdgeCase(unittest.TestCase):
    """A synthetic unpadded book: square-edged chunks, real gaps."""

    #: chunk seconds, gapBefore, gapAfter
    CHUNKS = [
        (0.50, 0.0, 0.25),
        (0.75, 0.0, 0.40),
        (0.60, 0.10, 0.0),
    ]

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-edges-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.session = os.path.join(self.tmp, "session")
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)
        self.sample_counts = []
        for i, (secs, _b, _a) in enumerate(self.CHUNKS):
            self.sample_counts.append(
                write_square(os.path.join(self.session, f"{i}.flac"), secs)
            )

    def manifest(self, pads: bool = False, fade=(10.0, 25.0)) -> M.Manifest:
        chunks = [
            M.Chunk(index=i, text=f"Line {i}.", kind="prose",
                    file=os.path.join(self.session, f"{i}.flac"),
                    gapBefore=(0.0 if pads else b), gapAfter=(0.0 if pads else a),
                    samples=self.sample_counts[i])
            for i, (_s, b, a) in enumerate(self.CHUNKS)
        ]
        return M.Manifest(
            source=M.Source(kind="synthetic", processDir=self.session,
                            sessionId="s", epubContentHash="h"),
            book=M.Book(epubPath=None, title="T", author="A", year=None,
                        language="en", language3="eng", cover=None),
            voice=M.Voice(engine="higgs-v3", fineTuned="v", modelDir=None,
                          adapterDir=None, baseDir=None),
            engine=M.Engine(
                id=("orpheus" if pads else "higgs-v3"),
                pads=pads,
                edgeFadeMs=M.EdgeFadeMs(*((0.0, 0.0) if pads else fade)),
            ),
            sampleRate=RATE,
            sentencesDir=self.session,
            chapters=[M.Chapter(index=1, title="T", doc=None, chunks=chunks)],
        )


class TestUnpaddedPlanning(EdgeCase):
    def test_the_concat_list_interleaves_silence_and_faded_chunks(self):
        plan = plan_chapters(self.manifest(), self.work)[0]
        names = [os.path.basename(p) for p in plan.paths]
        # chunk0, gapAfter0, chunk1, gapAfter1, gapBefore2, chunk2
        self.assertEqual(
            names, ["0.flac", "0a.flac", "1.flac", "1a.flac", "2b.flac", "2.flac"]
        )

    def test_total_samples_is_exactly_chunks_plus_gaps(self):
        m = self.manifest()
        plan = plan_chapters(m, self.work)[0]
        expected = sum(self.sample_counts) + sum(
            E.gap_frames(b, RATE) + E.gap_frames(a, RATE)
            for _s, b, a in self.CHUNKS
        )
        self.assertEqual(plan.samples, expected)
        # and that is what the concat list actually holds
        self.assertEqual(sum(i.samples for i in plan.infos), expected)

    def test_the_audio_and_the_vtt_agree(self):
        m = self.manifest()
        plan = plan_chapters(m, self.work)[0]
        # vtt_duration is the float running sum the transcript is built from.
        self.assertAlmostEqual(
            plan.duration(RATE), vtt_duration(m), delta=1.0 / RATE
        )

    def test_the_faded_copies_have_the_source_length(self):
        plan = plan_chapters(self.manifest(), self.work)[0]
        faded = [i for i, p in zip(plan.infos, plan.paths)
                 if os.path.basename(p) in ("0.flac", "1.flac", "2.flac")]
        self.assertEqual([i.samples for i in faded], self.sample_counts)

    def test_the_session_files_are_never_modified(self):
        before = {
            name: open(os.path.join(self.session, name), "rb").read()
            for name in sorted(os.listdir(self.session))
        }
        plan_chapters(self.manifest(), self.work)
        after = {
            name: open(os.path.join(self.session, name), "rb").read()
            for name in sorted(os.listdir(self.session))
        }
        self.assertEqual(before, after)
        # everything written went into the work dir
        self.assertTrue(os.path.isdir(os.path.join(self.work, "e1")))

    def test_the_concat_set_is_homogeneous(self):
        # Silence and faded chunks come out of one writer, so the guard that
        # used to make gap realization impossible now passes by construction.
        plan = plan_chapters(self.manifest(), self.work)[0]
        self.assertEqual(len({i.max_blocksize for i in plan.infos}), 1)
        self.assertEqual(len({i.sample_rate for i in plan.infos}), 1)
        self.assertEqual(len({i.channels for i in plan.infos}), 1)

    def test_silence_really_is_silent(self):
        plan_chapters(self.manifest(), self.work)
        data, _ = sf.read(os.path.join(self.work, "e1", "0a.flac"), always_2d=True)
        self.assertEqual(data.shape[0], E.gap_frames(0.25, RATE))
        self.assertEqual(float(np.max(np.abs(data))), 0.0)

    def test_the_envelope_at_every_chunk_edge(self):
        """The measured contract: 10 ms in, 25 ms out, on every chunk."""
        plan_chapters(self.manifest(), self.work)
        fade_in_n = E.fade_samples(10.0, RATE)
        fade_out_n = E.fade_samples(25.0, RATE)
        for i in range(len(self.CHUNKS)):
            data, _ = sf.read(os.path.join(self.work, "e1", f"{i}.flac"),
                              always_2d=True)
            mono = np.abs(data[:, 0])
            with self.subTest(chunk=i):
                # the source was flat 0.5 everywhere
                self.assertAlmostEqual(mono[fade_in_n + 10], 0.5, places=3)
                # Monotonic NON-STRICTLY: this is the file read back off disk,
                # and PCM_16 quantization (1 LSB = 3.05e-5) makes consecutive
                # samples equal wherever the window moves by less than one step,
                # which it does near both extremes. The float window itself is
                # strictly monotonic - TestApplyEdgeFades asserts that.
                # head: rises from near zero over exactly 10 ms
                self.assertLess(mono[0], 0.5 * 0.01)
                self.assertTrue(np.all(np.diff(mono[:fade_in_n]) >= 0))
                self.assertGreater(mono[fade_in_n // 2], 0.5 * 0.2)
                self.assertAlmostEqual(mono[fade_in_n - 1], 0.5, delta=0.5 * 0.01)
                # tail: falls to near zero over exactly 25 ms
                self.assertLess(mono[-1], 0.5 * 0.01)
                self.assertTrue(np.all(np.diff(mono[-fade_out_n:]) <= 0))
                self.assertGreater(mono[-fade_out_n // 2], 0.5 * 0.2)
                # -45..-48 dB is the target the training side measured; the
                # first/last sample of a raised-cosine window is far below it.
                self.assertLess(20 * math.log10(max(mono[0], 1e-12) / 0.5), -45.0)
                self.assertLess(20 * math.log10(max(mono[-1], 1e-12) / 0.5), -45.0)

    def test_a_missing_work_dir_is_refused(self):
        with self.assertRaisesRegex(ValueError, "given none"):
            plan_chapters(self.manifest(), None)

    def test_an_unknown_engine_is_refused(self):
        m = self.manifest()
        m.engine.id = "xtts"
        with self.assertRaisesRegex(KeyError, "no assembly profile"):
            plan_chapters(m, self.work)


class TestPaddedPathUntouched(EdgeCase):
    def test_the_padded_path_never_processes(self):
        """Orpheus semantics: the session's own files, in order, unmodified.

        This is the invariant the golden parity tests depend on - if the fade
        path ever ran for a padded engine, kershaw/blacksun/mutineer would stop
        being 0.000 ms.
        """
        m = self.manifest(pads=True)
        plan = plan_chapters(m, self.work)[0]
        self.assertEqual(
            plan.paths,
            [os.path.join(self.session, f"{i}.flac") for i in range(len(self.CHUNKS))],
        )
        self.assertEqual(plan.samples, sum(self.sample_counts))
        # nothing was written into the work dir at all
        self.assertEqual(os.listdir(self.work), [])

    def test_absent_engine_block_is_the_padded_path(self):
        m = self.manifest(pads=True)
        m.engine = None
        plan = plan_chapters(m, self.work)[0]
        self.assertEqual(plan.samples, sum(self.sample_counts))
        self.assertEqual(os.listdir(self.work), [])


@unittest.skipIf(FFMPEG is None, "ffmpeg/ffprobe are not on PATH")
class TestUnpaddedEndToEnd(EdgeCase):
    def test_the_encoded_chapter_carries_chunks_plus_gaps(self):
        from narrator.assemble import encode as ENC
        from narrator.assemble.ffmpeg_tools import probe_duration, write_concat_list

        m = self.manifest()
        plan = plan_chapters(m, self.work)[0]
        expected_samples = sum(self.sample_counts) + sum(
            E.gap_frames(b, RATE) + E.gap_frames(a, RATE)
            for _s, b, a in self.CHUNKS
        )
        self.assertEqual(plan.samples, expected_samples)

        lst = write_concat_list(plan.paths, os.path.join(self.work, "c.txt"))
        out = os.path.join(self.work, "ch.m4a")
        ENC.encode_chapter(FFMPEG, lst, out, 1)
        self.assertAlmostEqual(
            probe_duration(out, FFPROBE),
            expected_samples / RATE,
            delta=ENC.PRE_ENCODED_TOLERANCE_S,
        )


class TestHiggsSessionEndToEnd(unittest.TestCase):
    """A synthetic Higgs SESSION - gaps.json and all - through the real reader.

    The other cases in this file build a Manifest by hand. This one goes through
    `render.session_v1.build_manifest`, which is the path a real Higgs book takes,
    and proves the sidecar reaches the audio.
    """

    GAPS = {0: (0.0, 0.60), 1: (0.0, 0.25), 2: (0.10, 0.00),
            3: (0.0, 0.40), 4: (0.0, 0.30), 5: (0.0, 0.30), 6: (0.0, 0.50),
            7: (0.20, 0.35), 8: (0.0, 0.15), 9: (0.0, 0.00)}

    def setUp(self):
        import json

        from narrator.render import session_v1 as S

        self.S = S
        self.tmp = tempfile.mkdtemp(prefix="narrator-higgs-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.process_dir = synthetic.build_session(self.tmp)

        state_path = os.path.join(self.process_dir, "session-state.json")
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
        state["tts_engine"] = "higgs-v3"
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f)

        with open(os.path.join(self.process_dir, "chapters", "sentences",
                               S.GAPS_FILENAME), "w", encoding="utf-8") as f:
            json.dump({
                "version": 1,
                "engine": "higgs-v3",
                "gaps": {str(i): {"before": b, "after": a}
                         for i, (b, a) in self.GAPS.items()},
            }, f)

        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)

    def test_the_assembled_length_is_chunks_plus_gaps(self):
        m = self.S.build_manifest(self.process_dir)
        self.assertFalse(m.engine.pads)

        plans = plan_chapters(m, self.work)
        chunk_samples = sum(k.samples for c in m.chapters for k in c.chunks)
        gap_samples = sum(
            E.gap_frames(b, RATE) + E.gap_frames(a, RATE)
            for b, a in self.GAPS.values()
        )
        self.assertEqual(
            sum(p.samples for p in plans), chunk_samples + gap_samples
        )

    def test_the_vtt_and_the_audio_agree(self):
        m = self.S.build_manifest(self.process_dir)
        plans = plan_chapters(m, self.work)
        total = sum(p.samples for p in plans) / RATE
        self.assertAlmostEqual(total, vtt_duration(m), delta=len(self.GAPS) / RATE)

    def snapshot_session(self) -> dict:
        d = os.path.join(self.process_dir, "chapters", "sentences")
        out = {}
        for name in sorted(os.listdir(d)):
            with open(os.path.join(d, name), "rb") as f:
                out[name] = f.read()
        return out

    def test_every_chunk_was_faded_and_the_session_untouched(self):
        before = self.snapshot_session()
        m = self.S.build_manifest(self.process_dir)
        plan_chapters(m, self.work)
        self.assertEqual(before, self.snapshot_session())

        # One faded copy per chunk in the work dir. A chunk copy is named
        # "<index>.flac"; a gap is "<index>b.flac" / "<index>a.flac", so the
        # stem being all digits is what tells them apart.
        produced = []
        for chapter in range(1, len(m.chapters) + 1):
            d = os.path.join(self.work, f"e{chapter}")
            produced += [n for n in os.listdir(d)
                         if n.endswith(".flac") and n[:-len(".flac")].isdigit()]
        self.assertEqual(len(produced), sum(len(c.chunks) for c in m.chapters))

        # and one silence file per non-zero gap
        silences = []
        for chapter in range(1, len(m.chapters) + 1):
            d = os.path.join(self.work, f"e{chapter}")
            silences += [n for n in os.listdir(d)
                         if n.endswith(".flac") and not n[:-len(".flac")].isdigit()]
        expected = sum(1 for b, a in self.GAPS.values() for g in (b, a) if g > 0)
        self.assertEqual(len(silences), expected)


class TestGapSidecarInterop(unittest.TestCase):
    """The prep WRITER and the session READER are two builders' code meeting on
    one file. This asserts they agree, so neither can drift alone."""

    def setUp(self):
        import json

        from narrator.render import session_v1 as S
        from narrator.text import prep

        self.json = json
        self.S = S
        self.prep = prep
        self.tmp = tempfile.mkdtemp(prefix="narrator-interop-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.process_dir = synthetic.build_session(self.tmp)
        self.sentences = os.path.join(self.process_dir, "chapters", "sentences")

    def set_engine(self, engine_id: str) -> None:
        path = os.path.join(self.process_dir, "session-state.json")
        with open(path, encoding="utf-8") as f:
            state = self.json.load(f)
        state["tts_engine"] = engine_id
        with open(path, "w", encoding="utf-8") as f:
            self.json.dump(state, f)

    def test_the_two_sides_use_the_same_filename(self):
        self.assertEqual(self.prep.GAPS_FILENAME, self.S.GAPS_FILENAME)

    def test_what_prep_writes_is_what_the_reader_reads(self):
        self.set_engine("higgs-v3")
        written = self.prep.write_gaps_file(
            self.process_dir, self.sentences, "higgs-v3",
            synthetic.CHAPTER_SENTENCES,
        )
        self.assertTrue(os.path.isfile(written))

        m = self.S.build_manifest(self.process_dir)
        self.assertFalse(m.engine.pads)

        # every chunk got the value prep computed for it, in order
        from narrator.text.gaps import classify_gap_seconds

        expected = [
            classify_gap_seconds(text)
            for chapter in synthetic.CHAPTER_SENTENCES
            for text in chapter
        ]
        got = [(k.gapBefore, k.gapAfter) for c in m.chapters for k in c.chunks]
        self.assertEqual(got, expected)

    def test_prep_writes_nothing_for_a_padded_engine_and_the_reader_agrees(self):
        self.assertIsNone(self.prep.write_gaps_file(
            self.process_dir, self.sentences, "orpheus",
            synthetic.CHAPTER_SENTENCES,
        ))
        self.assertFalse(os.path.exists(
            os.path.join(self.sentences, self.S.GAPS_FILENAME)))
        m = self.S.build_manifest(self.process_dir)
        self.assertTrue(m.engine.pads)
        self.assertTrue(all(k.gapBefore == 0.0 and k.gapAfter == 0.0
                            for c in m.chapters for k in c.chunks))

    def test_prep_output_survives_a_full_plan(self):
        self.set_engine("higgs-v3")
        self.prep.write_gaps_file(
            self.process_dir, self.sentences, "higgs-v3",
            synthetic.CHAPTER_SENTENCES,
        )
        m = self.S.build_manifest(self.process_dir)
        work = os.path.join(self.tmp, "work")
        os.makedirs(work)
        plans = plan_chapters(m, work)
        chunk_samples = sum(k.samples for c in m.chapters for k in c.chunks)
        gap_samples = sum(
            E.gap_frames(k.gapBefore, RATE) + E.gap_frames(k.gapAfter, RATE)
            for c in m.chapters for k in c.chunks
        )
        self.assertEqual(sum(p.samples for p in plans), chunk_samples + gap_samples)
        self.assertGreater(gap_samples, 0)


class MixedEncodingCase(unittest.TestCase):
    """A book rendered across machines: WSL PCM_16/2304, Mac MLX PCM_24/2304,
    Windows soundfile PCM_16/4096. The audio is fine; only the container framing
    and declared depth disagree."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-mixed-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.session = os.path.join(self.tmp, "session")
        os.makedirs(self.session)
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)
        self.lines = []

    def write_chunk(self, index: int, seconds: float, subtype: str,
                    blocksize: int | None = None, rate: int = RATE,
                    channels: int = 1) -> int:
        """One chunk, at a chosen bit depth and (where asked) blocksize.

        libsndfile picks its own FLAC blocksize, so a 2304 set - what both WSL
        and the Mac produce - is made with ffmpeg, which exposes -frame_size.
        """
        n = int(round(seconds * rate))
        rng = np.random.default_rng(index + 1)
        data = (rng.random((n, channels)) * 2.0 - 1.0) * 0.4
        path = os.path.join(self.session, f"{index}.flac")
        if blocksize is None:
            sf.write(path, data, rate, subtype=subtype, format="FLAC")
        else:
            if FFMPEG is None:
                self.skipTest("ffmpeg is needed to write a chosen FLAC blocksize")
            import subprocess
            raw = os.path.join(self.tmp, f"raw{index}.wav")
            sf.write(raw, data, rate, subtype=subtype)
            depth = {"PCM_16": "s16", "PCM_24": "s32"}[subtype]
            bits = {"PCM_16": "16", "PCM_24": "24"}[subtype]
            subprocess.run(
                [FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", raw,
                 "-c:a", "flac", "-sample_fmt", depth,
                 "-bits_per_raw_sample", bits,
                 "-frame_size", str(blocksize), path],
                check=True, capture_output=True,
            )
            os.remove(raw)
        return read_streaminfo(path).samples

    def manifest_for(self, counts: list[int]) -> M.Manifest:
        chunks = [
            M.Chunk(index=i, text=f"Line {i}.", kind="prose",
                    file=os.path.join(self.session, f"{i}.flac"),
                    samples=n)
            for i, n in enumerate(counts)
        ]
        return M.Manifest(
            source=M.Source(kind="synthetic", processDir=self.session,
                            sessionId="s", epubContentHash="h"),
            book=M.Book(epubPath=None, title="T", author="A", year=None,
                        language="en", language3="eng", cover=None),
            voice=M.Voice(engine="orpheus", fineTuned="v", modelDir=None,
                          adapterDir=None, baseDir=None),
            sampleRate=RATE,
            sentencesDir=self.session,
            chapters=[M.Chapter(index=1, title="T", doc=None, chunks=chunks)],
        )


class TestMixedEncodingIsRewritten(MixedEncodingCase):
    def build_mixed(self) -> list[int]:
        """The three machines, in one chapter."""
        return [
            self.write_chunk(0, 0.50, "PCM_16", blocksize=2304),   # WSL
            self.write_chunk(1, 0.75, "PCM_24", blocksize=2304),   # Mac MLX
            self.write_chunk(2, 0.60, "PCM_16"),                   # Windows (4096)
        ]

    def test_the_set_really_is_mixed(self):
        self.build_mixed()
        infos = [read_streaminfo(os.path.join(self.session, f"{i}.flac"))
                 for i in range(3)]
        self.assertEqual([i.bits_per_sample for i in infos], [16, 24, 16])
        self.assertEqual({i.max_blocksize for i in infos}, {2304, 4096})
        # and the old guard would have refused it
        with self.assertRaises(ValueError):
            from narrator.render.flac_header import assert_concat_homogeneous
            assert_concat_homogeneous(infos)

    def test_it_is_rewritten_rather_than_refused(self):
        counts = self.build_mixed()
        m = self.manifest_for(counts)
        plan = plan_chapters(m, self.work, self.lines.append)[0]

        # every path now points into the work dir, and the set is homogeneous
        for path in plan.paths:
            self.assertTrue(path.startswith(self.work), path)
        self.assertEqual(len({i.max_blocksize for i in plan.infos}), 1)
        self.assertEqual(len({i.bits_per_sample for i in plan.infos}), 1)

    def test_the_assembled_length_is_the_sample_sum(self):
        counts = self.build_mixed()
        m = self.manifest_for(counts)
        plan = plan_chapters(m, self.work, self.lines.append)[0]
        self.assertEqual(plan.samples, sum(counts))
        self.assertEqual([i.samples for i in plan.infos], counts)

    def test_the_rewrite_is_lossless(self):
        counts = self.build_mixed()
        m = self.manifest_for(counts)
        plan = plan_chapters(m, self.work, self.lines.append)[0]
        # widest depth in the set wins, so the 24-bit chunk keeps its bits
        self.assertEqual({i.bits_per_sample for i in plan.infos}, {24})
        for i, dst in enumerate(plan.paths):
            src = os.path.join(self.session, f"{i}.flac")
            a, _ = sf.read(src, dtype="float64", always_2d=True)
            b, _ = sf.read(dst, dtype="float64", always_2d=True)
            with self.subTest(chunk=i):
                np.testing.assert_array_equal(a, b)

    def test_the_vtt_is_unchanged_by_the_rewrite(self):
        counts = self.build_mixed()
        m = self.manifest_for(counts)
        before = vtt.build_vtt(m)
        plan_chapters(m, self.work, self.lines.append)
        self.assertEqual(vtt.build_vtt(m), before)
        # the transcript's own total still matches the audio
        self.assertAlmostEqual(vtt_duration(m), sum(counts) / RATE, places=9)

    def test_exactly_one_log_line_names_the_mix(self):
        counts = self.build_mixed()
        plan_chapters(self.manifest_for(counts), self.work, self.lines.append)
        self.assertEqual(len(self.lines), 1, self.lines)
        line = self.lines[0]
        self.assertIn("Chapter 1", line)
        self.assertIn("mixed FLAC encodings", line)
        self.assertIn("bit depth", line)
        self.assertIn("max-blocksize", line)
        self.assertIn("PCM_24", line)
        line.encode("ascii")

    def test_the_session_is_never_touched(self):
        counts = self.build_mixed()
        before = {}
        for i in range(len(counts)):
            with open(os.path.join(self.session, f"{i}.flac"), "rb") as f:
                before[i] = f.read()
        plan_chapters(self.manifest_for(counts), self.work, self.lines.append)
        for i in range(len(counts)):
            with open(os.path.join(self.session, f"{i}.flac"), "rb") as f:
                self.assertEqual(f.read(), before[i], f"chunk {i} was modified")

    def test_a_bit_depth_mix_alone_is_enough(self):
        counts = [
            self.write_chunk(0, 0.50, "PCM_16"),
            self.write_chunk(1, 0.50, "PCM_24"),
        ]
        plan = plan_chapters(self.manifest_for(counts), self.work,
                             self.lines.append)[0]
        self.assertEqual(len(self.lines), 1)
        self.assertIn("bit depth", self.lines[0])
        self.assertEqual(plan.samples, sum(counts))

    def test_a_missing_work_dir_is_refused_by_name(self):
        counts = self.build_mixed()
        with self.assertRaisesRegex(ValueError, "no working directory"):
            plan_chapters(self.manifest_for(counts), None, self.lines.append)


class TestHomogeneousSetsNeverRewrite(MixedEncodingCase):
    def test_the_work_dir_stays_empty(self):
        """The invariant the golden parity tests rest on."""
        counts = [self.write_chunk(i, 0.5, "PCM_16") for i in range(3)]
        m = self.manifest_for(counts)
        plan = plan_chapters(m, self.work, self.lines.append)[0]
        self.assertEqual(os.listdir(self.work), [])
        self.assertEqual(self.lines, [])
        # and the concat list is still the session's own files
        self.assertEqual(
            plan.paths,
            [os.path.join(self.session, f"{i}.flac") for i in range(3)],
        )

    def test_a_uniform_24_bit_set_is_also_left_alone(self):
        counts = [self.write_chunk(i, 0.5, "PCM_24") for i in range(3)]
        plan = plan_chapters(self.manifest_for(counts), self.work,
                             self.lines.append)[0]
        self.assertEqual(os.listdir(self.work), [])
        self.assertEqual(plan.samples, sum(counts))


class TestFatalMismatchesStillRefuse(MixedEncodingCase):
    def test_a_sample_rate_mismatch_refuses(self):
        self.write_chunk(0, 0.5, "PCM_16")
        n1 = int(round(0.5 * 48000))
        sf.write(os.path.join(self.session, "1.flac"),
                 np.zeros((n1, 1)) + 0.1, 48000, subtype="PCM_16", format="FLAC")
        m = self.manifest_for([read_streaminfo(
            os.path.join(self.session, f"{i}.flac")).samples for i in range(2)])
        # read_expected catches the rate before the homogeneity question arises
        with self.assertRaisesRegex(ValueError, "sample rate is 48000"):
            plan_chapters(m, self.work, self.lines.append)
        self.assertEqual(self.lines, [])

    def test_a_channel_mismatch_refuses(self):
        self.write_chunk(0, 0.5, "PCM_16")
        self.write_chunk(1, 0.5, "PCM_16", channels=2)
        m = self.manifest_for([read_streaminfo(
            os.path.join(self.session, f"{i}.flac")).samples for i in range(2)])
        with self.assertRaisesRegex(ValueError, "2 channel"):
            plan_chapters(m, self.work, self.lines.append)
        self.assertEqual(self.lines, [])

    def test_the_fatal_and_fixable_split(self):
        from narrator.render import flac_header as FH

        self.write_chunk(0, 0.5, "PCM_16")
        self.write_chunk(1, 0.5, "PCM_24")
        infos = [read_streaminfo(os.path.join(self.session, f"{i}.flac"))
                 for i in range(2)]
        self.assertIsNone(FH.fatal_inhomogeneity(infos))
        self.assertIn("bit depth", FH.fixable_inhomogeneity(infos))


if __name__ == "__main__":
    unittest.main()
