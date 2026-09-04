"""Parity against e2a's own assembly of the same session.

For each golden slug: build a manifest from the LOCAL copy of the session,
assemble it, and compare the result to what e2a produced from the identical
inputs.

Parity target (CONTRACTS.md):
  - identical cue count and cue text
  - every cue time within 1 ms
  - m4b duration within 50 ms
  - same chapter count and the same chapter titles
  - same audio stream (codec, sample rate, channels)
  - same cover presence and the same container tag set

The VTT is compared at CUE level, not byte level: narrator writes LF on every
platform while e2a's line endings follow whichever machine assembled the book
(see assemble/vtt.py, "LINE ENDINGS - A DECLARED DEVIATION").

Skips with a clear message when the local golden copies are absent - that is the
ONE permitted "missing input" behaviour, and only in tests.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
import unittest

from narrator.assemble import run as R
from narrator.assemble.ffmpeg_tools import FfmpegError, resolve_binary
from narrator.render.session_v1 import build_manifest
from narrator.tests.golden_tools import local

try:
    from narrator.tests.golden_tools.compare import (
        compare_m4b, compare_vtt, probe_m4b,
    )
    COMPARE_IMPORT_ERROR = None
except Exception as e:  # noqa: BLE001 - reported as a skip, never silently
    COMPARE_IMPORT_ERROR = str(e)

try:
    FFMPEG = resolve_binary("ffmpeg")
    FFPROBE = resolve_binary("ffprobe")
except FfmpegError:
    FFMPEG = FFPROBE = None

SLUGS = ("kershaw", "blacksun", "mutineer")

#: Wall times, printed at the end of the run so the design target ("Mutineer
#: 8 min -> under 1 min") is measured rather than asserted.
TIMINGS: dict[str, float] = {}


class GoldenParity(unittest.TestCase):
    """One sub-test per slug, so one missing book does not hide the others."""

    def setUp(self):
        if FFMPEG is None:
            self.skipTest("ffmpeg/ffprobe are not on PATH")
        if COMPARE_IMPORT_ERROR:
            self.skipTest(
                f"golden_tools/compare.py is not importable: {COMPARE_IMPORT_ERROR}"
            )

    def assemble_one(self, slug: str):
        entry = local.require(self, slug)
        process_dir = entry["localProcessDir"]
        sentences_dir = entry.get("sentencesDir")
        # An entry whose sentencesDir IS the session's own sentences directory
        # needs no override; anything else (Mutineer's sentences-denoised, an
        # RVC set) must be passed through, because that is what e2a assembled.
        default = os.path.join(process_dir, "chapters", "sentences")
        override = None
        if sentences_dir and os.path.normcase(os.path.abspath(sentences_dir)) != \
                os.path.normcase(os.path.abspath(default)):
            override = sentences_dir

        # "auto" by default: for a fully rendered session it selects every
        # chapter, and for a partially rendered one (blacksun) it selects the
        # same completed prefix e2a's own assembly did. An index entry may name
        # an explicit selection instead.
        manifest = build_manifest(process_dir, override, entry.get("chapters") or "auto")
        out_dir = tempfile.mkdtemp(prefix=f"narrator-golden-{slug}-")
        self.addCleanup(shutil.rmtree, out_dir, ignore_errors=True)

        started = time.monotonic()
        result = R.assemble(
            manifest, out_dir, ffmpeg=FFMPEG, ffprobe=FFPROBE,
            progress=lambda _line: None,
        )
        TIMINGS[slug] = time.monotonic() - started
        return entry, manifest, result

    # -- the tests ------------------------------------------------------

    def _parity(self, slug: str):
        entry, _manifest, result = self.assemble_one(slug)

        with open(result.vtt_path, encoding="utf-8") as f:
            candidate_vtt = f.read()
        with open(entry["referenceVtt"], encoding="utf-8") as f:
            reference_vtt = f.read()

        vtt_diff = compare_vtt(candidate_vtt, reference_vtt, tolerance_s=0.001)
        m4b_diff = compare_m4b(
            probe_m4b(result.m4b_path, FFPROBE),
            probe_m4b(entry["referenceM4b"], FFPROBE),
            duration_tolerance_s=0.05,
        )

        print(
            f"\n[golden:{slug}] wall {TIMINGS[slug]:.1f}s | "
            f"cues {vtt_diff.candidate_cues}/{vtt_diff.reference_cues} | "
            f"max cue delta {vtt_diff.max_abs_delta_s * 1000:.3f} ms | "
            f"duration delta {m4b_diff.duration_delta_s * 1000:+.1f} ms | "
            f"chapters {m4b_diff.chapter_count_candidate}/"
            f"{m4b_diff.chapter_count_reference} | "
            f"cover {m4b_diff.cover_candidate}/{m4b_diff.cover_reference} | "
            f"tag mismatches {len(m4b_diff.tag_mismatches)} | "
            f"stream mismatches {len(m4b_diff.audio_mismatches)}",
            flush=True,
        )

        self.assertTrue(vtt_diff.ok, "VTT parity:\n" + vtt_diff.describe())
        self.assertTrue(m4b_diff.ok, "m4b parity:\n" + m4b_diff.describe())

    def test_kershaw(self):
        self._parity("kershaw")

    def test_blacksun(self):
        self._parity("blacksun")

    def test_mutineer(self):
        self._parity("mutineer")


if __name__ == "__main__":
    unittest.main()
