"""Preparing the sentences on a pool must change the CLOCK and nothing else.

`assemble/chapters.py` spreads the per-chunk prepare unit - read the source
FLAC, write the faded copy, write the gap silences, read every header back -
across a thread pool, because on a library over SMB that step was four to five
minutes of invisible serial round trips (Mutineer's Moon, 847 chunks,
2026-09-07).

Two things must survive that, and this file is what says so:

  - THE CONCAT LIST IS THE SERIAL LIST. Same paths, same order, same
    StreamInfos. ffmpeg's concat demuxer takes the order literally; a
    reordered list is a book whose sentences are shuffled, and every guard
    downstream (durations, VTT arithmetic, chapter markers) would still pass.
  - THE BYTES ARE THE SERIAL BYTES. Every file the pool writes is compared by
    sha256 against the one the serial run wrote.

`test_assemble_golden.py` pins the finished audiobook against e2a's; this pins
the step underneath it, so a regression is named here rather than surfacing as a
1 ms cue drift three suites away.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import unittest

import numpy as np
import soundfile as sf

from narrator import manifest as M
from narrator.assemble.chapters import PrepareProgress, chunk_total, plan_chapters

RATE = 24000

#: Enough chunks that a pool has something to overlap, spread over more than one
#: chapter so the cross-chapter stitching is exercised too. The gap pattern is
#: deliberately uneven: a chunk with no gap at all contributes ONE file, one with
#: both contributes three, and the interleave is where an order bug would live.
CHAPTERS = [
    # (chunk seconds, gapBefore, gapAfter)
    [(0.30, 0.00, 0.25), (0.22, 0.00, 0.00), (0.41, 0.10, 0.30), (0.18, 0.05, 0.00)],
    [(0.35, 0.00, 0.20), (0.27, 0.15, 0.15), (0.19, 0.00, 0.00)],
    [(0.24, 0.20, 0.10), (0.33, 0.00, 0.40)],
]


def _write_chunk(path: str, seconds: float, seed: int) -> int:
    """A chunk with abrupt edges and non-trivial content, so a fade that ran
    twice - or not at all - shows up in the digest."""
    n = int(round(seconds * RATE))
    rng = np.random.default_rng(seed)
    data = (rng.random((n, 1)) - 0.5).astype(np.float64) * 0.6
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, data, RATE, subtype="PCM_16", format="FLAC")
    return n


def _digest(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


class PrepareParallel(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-prepare-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.session = os.path.join(self.tmp, "session")
        self.samples: dict[tuple[int, int], int] = {}
        seed = 0
        for c, chunks in enumerate(CHAPTERS, start=1):
            for i, (secs, _b, _a) in enumerate(chunks):
                seed += 1
                self.samples[(c, i)] = _write_chunk(
                    os.path.join(self.session, f"{c}_{i}.flac"), secs, seed
                )

    def manifest(self) -> M.Manifest:
        chapters = []
        for c, chunks in enumerate(CHAPTERS, start=1):
            chapters.append(M.Chapter(
                index=c, title=f"Chapter {c}", doc=None,
                chunks=[
                    M.Chunk(index=i, text=f"Line {c}.{i}.", kind="prose",
                            file=os.path.join(self.session, f"{c}_{i}.flac"),
                            gapBefore=b, gapAfter=a, samples=self.samples[(c, i)])
                    for i, (_s, b, a) in enumerate(chunks)
                ],
            ))
        return M.Manifest(
            source=M.Source(kind="synthetic", processDir=self.session,
                            sessionId="s", epubContentHash="h"),
            book=M.Book(epubPath=None, title="T", author="A", year=None,
                        language="en", language3="eng", cover=None),
            voice=M.Voice(engine="higgs-v3", fineTuned="v", modelDir=None,
                          adapterDir=None, baseDir=None),
            engine=M.Engine(id="higgs-v3", pads=False,
                            edgeFadeMs=M.EdgeFadeMs(10.0, 25.0)),
            sampleRate=RATE,
            sentencesDir=self.session,
            chapters=chapters,
        )

    def run_plan(self, workers: int, tag: str):
        """Plan into a work dir of this run's own, and report what it produced."""
        work = os.path.join(self.tmp, f"work-{tag}")
        os.makedirs(work)
        lines: list[str] = []
        plans = plan_chapters(self.manifest(), work, lines.append, workers=workers)
        rel = [
            [os.path.relpath(p, work).replace(os.sep, "/") for p in plan.paths]
            for plan in plans
        ]
        # StreamInfo carries its own path, which is work-dir-specific; every
        # other field is the audio fact being compared.
        infos = [
            [(i.min_blocksize, i.max_blocksize, i.sample_rate, i.channels,
              i.bits_per_sample, i.samples) for i in plan.infos]
            for plan in plans
        ]
        digests = {}
        for root, _dirs, files in os.walk(work):
            for name in files:
                full = os.path.join(root, name)
                key = os.path.relpath(full, work).replace(os.sep, "/")
                digests[key] = _digest(full)
        return rel, infos, digests, lines, plans

    # -- the two claims -------------------------------------------------

    def test_one_worker_and_eight_agree_on_the_concat_list(self):
        serial_paths, serial_infos, _d1, _l1, serial_plans = self.run_plan(1, "s")
        pool_paths, pool_infos, _d2, _l2, pool_plans = self.run_plan(8, "p")
        self.assertEqual(serial_paths, pool_paths)
        self.assertEqual(serial_infos, pool_infos)
        self.assertEqual([p.samples for p in serial_plans],
                         [p.samples for p in pool_plans])
        self.assertEqual([(p.index, p.first_chunk, p.last_chunk) for p in serial_plans],
                         [(p.index, p.first_chunk, p.last_chunk) for p in pool_plans])

    def test_one_worker_and_eight_write_the_same_bytes(self):
        _p1, _i1, serial_digests, _l1, _pl1 = self.run_plan(1, "s")
        _p2, _i2, pool_digests, _l2, _pl2 = self.run_plan(8, "p")
        self.assertEqual(sorted(serial_digests), sorted(pool_digests))
        self.assertEqual(serial_digests, pool_digests)
        # and there really were files to compare
        self.assertGreater(len(serial_digests), chunk_total(self.manifest()))

    def test_the_interleave_is_gap_chunk_gap_per_chunk(self):
        """The order an order bug would break, spelled out for chapter 1."""
        paths, _i, _d, _l, _p = self.run_plan(4, "order")
        self.assertEqual(
            paths[0],
            ["e1/0.flac", "e1/0a.flac",       # no gapBefore, 0.25 s after
             "e1/1.flac",                     # no gaps at all
             "e1/2b.flac", "e1/2.flac", "e1/2a.flac",
             "e1/3b.flac", "e1/3.flac"],      # no gapAfter
        )

    # -- what the card is driven from -----------------------------------

    def test_progress_counts_every_chunk_exactly_once(self):
        _p, _i, _d, lines, _pl = self.run_plan(8, "prog")
        total = chunk_total(self.manifest())
        counts = [l for l in lines if l.startswith("[ASSEMBLE] Preparing sentences ")]
        self.assertTrue(counts, "no prepare progress was reported at all")
        self.assertEqual(counts[0], f"[ASSEMBLE] Preparing sentences 0/{total}")
        self.assertEqual(counts[-1], f"[ASSEMBLE] Preparing sentences {total}/{total}")
        seen = [int(l.rsplit(" ", 1)[1].split("/")[0]) for l in counts]
        self.assertEqual(seen, sorted(seen), f"the count went backwards: {seen}")

    def test_the_total_is_a_manifest_fact(self):
        self.assertEqual(chunk_total(self.manifest()),
                         sum(len(c) for c in CHAPTERS))

    def test_the_bar_is_throttled_not_one_line_per_chunk(self):
        """1,700 lines through the bridge's stdout parser would be the cure
        becoming the disease. Only the first and the last are guaranteed."""
        lines: list[str] = []
        progress = PrepareProgress(500, lines.append)
        progress.start()
        for _ in range(500):
            progress.step()
        self.assertEqual(lines[0], "[ASSEMBLE] Preparing sentences 0/500")
        self.assertEqual(lines[-1], "[ASSEMBLE] Preparing sentences 500/500")
        self.assertLess(len(lines), 20)

    # -- the guards still fire, with the same words ----------------------

    def test_a_missing_chunk_is_named_the_same_way_on_a_pool(self):
        m = self.manifest()
        os.remove(m.chapters[1].chunks[1].file)
        work = os.path.join(self.tmp, "work-missing")
        os.makedirs(work)
        with self.assertRaises(FileNotFoundError) as caught:
            plan_chapters(m, work, lambda _l: None, workers=8)
        self.assertIn("is missing chunk 1", str(caught.exception))

    def test_a_manifest_that_disagrees_with_the_audio_is_refused_on_a_pool(self):
        m = self.manifest()
        m.chapters[0].chunks[2].samples += 7
        work = os.path.join(self.tmp, "work-mismatch")
        os.makedirs(work)
        with self.assertRaisesRegex(ValueError, "audio changed after the manifest"):
            plan_chapters(m, work, lambda _l: None, workers=8)

    def test_workers_below_one_is_refused(self):
        with self.assertRaisesRegex(ValueError, "workers must be >= 1"):
            plan_chapters(self.manifest(), self.tmp, lambda _l: None, workers=0)


class PreparePaddedParallel(unittest.TestCase):
    """The PADDED path on a pool - Orpheus, and the majority of books.

    It writes nothing and reads 42 bytes a chunk, so it was left serial when the
    pool landed. Over SMB the cost is the OPEN and not the bytes: one round trip
    per chunk, 847 of them for Mutineer's Moon. What must survive the move is the
    same thing that had to survive it on the unpadded path - the concat list is
    the serial list, in order - plus the guards, which on this path are the only
    thing standing between a manifest that disagrees with the audio and a book
    that is quietly wrong.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="narrator-prepare-padded-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.session = os.path.join(self.tmp, "session")
        self.samples: dict[tuple[int, int], int] = {}
        seed = 100
        for c, chunks in enumerate(CHAPTERS, start=1):
            for i, (secs, _b, _a) in enumerate(chunks):
                seed += 1
                self.samples[(c, i)] = _write_chunk(
                    os.path.join(self.session, f"{c}_{i}.flac"), secs, seed
                )

    def manifest(self) -> M.Manifest:
        """An engine that PADS its own chunks: no gaps, nothing rewritten."""
        chapters = []
        for c, chunks in enumerate(CHAPTERS, start=1):
            chapters.append(M.Chapter(
                index=c, title=f"Chapter {c}", doc=None,
                chunks=[
                    M.Chunk(index=i, text=f"Line {c}.{i}.", kind="prose",
                            file=os.path.join(self.session, f"{c}_{i}.flac"),
                            gapBefore=0.0, gapAfter=0.0, samples=self.samples[(c, i)])
                    for i, (_s, _b, _a) in enumerate(chunks)
                ],
            ))
        return M.Manifest(
            source=M.Source(kind="synthetic", processDir=self.session,
                            sessionId="s", epubContentHash="h"),
            book=M.Book(epubPath=None, title="T", author="A", year=None,
                        language="en", language3="eng", cover=None),
            voice=M.Voice(engine="orpheus", fineTuned="v", modelDir=None,
                          adapterDir=None, baseDir=None),
            engine=M.Engine(id="orpheus", pads=True,
                            edgeFadeMs=M.EdgeFadeMs(0.0, 0.0)),
            sampleRate=RATE,
            sentencesDir=self.session,
            chapters=chapters,
        )

    def run_plan(self, workers: int):
        lines: list[str] = []
        plans = plan_chapters(self.manifest(), None, lines.append, workers=workers)
        paths = [list(plan.paths) for plan in plans]
        infos = [
            [(i.min_blocksize, i.max_blocksize, i.sample_rate, i.channels,
              i.bits_per_sample, i.samples) for i in plan.infos]
            for plan in plans
        ]
        return paths, infos, lines, plans

    def test_one_worker_and_eight_agree_on_the_concat_list(self):
        serial_paths, serial_infos, _l1, serial_plans = self.run_plan(1)
        pool_paths, pool_infos, _l2, pool_plans = self.run_plan(8)
        self.assertEqual(serial_paths, pool_paths)
        self.assertEqual(serial_infos, pool_infos)
        self.assertEqual([p.samples for p in serial_plans],
                         [p.samples for p in pool_plans])
        self.assertEqual([(p.index, p.first_chunk, p.last_chunk) for p in serial_plans],
                         [(p.index, p.first_chunk, p.last_chunk) for p in pool_plans])

    def test_the_session_files_go_in_untouched_and_in_chunk_order(self):
        paths, _i, _l, _p = self.run_plan(4)
        self.assertEqual(
            paths[0],
            [os.path.join(self.session, f"1_{i}.flac") for i in range(len(CHAPTERS[0]))])
        # Nothing is written on this path at all: the work dir was None.
        self.assertEqual(
            sorted(os.listdir(self.session)),
            sorted(f"{c}_{i}.flac"
                   for c, chunks in enumerate(CHAPTERS, start=1)
                   for i in range(len(chunks))))

    def test_progress_counts_every_chunk_exactly_once(self):
        _p, _i, lines, _pl = self.run_plan(8)
        total = chunk_total(self.manifest())
        counts = [l for l in lines if l.startswith("[ASSEMBLE] Preparing sentences ")]
        self.assertEqual(counts[0], f"[ASSEMBLE] Preparing sentences 0/{total}")
        self.assertEqual(counts[-1], f"[ASSEMBLE] Preparing sentences {total}/{total}")

    def test_a_missing_chunk_is_named_the_same_way_on_a_pool(self):
        m = self.manifest()
        os.remove(m.chapters[1].chunks[1].file)
        with self.assertRaises(FileNotFoundError) as caught:
            plan_chapters(m, None, lambda _l: None, workers=8)
        self.assertIn("is missing chunk 1", str(caught.exception))

    def test_a_manifest_that_disagrees_with_the_audio_is_refused_on_a_pool(self):
        m = self.manifest()
        m.chapters[0].chunks[2].samples += 7
        with self.assertRaisesRegex(ValueError, "audio changed after the manifest"):
            plan_chapters(m, None, lambda _l: None, workers=8)

    def test_a_gap_on_a_padding_engine_is_still_refused_on_a_pool(self):
        """The guard that only exists on this path: a gap here is not merely
        wrong, it is silently DISCARDED, because nothing downstream looks at it
        again."""
        m = self.manifest()
        m.chapters[0].chunks[1].gapAfter = 0.25
        with self.assertRaisesRegex(ValueError, "pads its own chunks"):
            plan_chapters(m, None, lambda _l: None, workers=8)


if __name__ == "__main__":
    unittest.main()
