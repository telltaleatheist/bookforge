"""The fast-start windowed decoder must reproduce the whole clip, exactly once.

Ported from ebook2audiobook@9daab0ba tools/test_stream_window_decode.py (a
script with its own check/exit-code harness) to unittest, against
narrator.engine.snac instead of lib.classes.tts_engines.orpheus_stream_decode.
Every case, every awkward token count and every refusal is the same; only the
assertion mechanics changed.

WHAT IS BEING PROVED. WindowedFrameEmitter cuts a row's audio into ~0.34 s
payloads while the row is still generating. Nothing downstream can check its
work: by the time a wrong slice is noticeable it is already playing in someone's
browser. So the arithmetic is proved here, against a FAKE decoder, with no
model, no GPU and no Mac:

  * CONTIGUITY / NO OVERLAP / NO GAP - the concatenation of a row's payloads is
    exactly frames 0..n in order, sample for sample, where n = tokens // 7;
  * TOTAL LENGTH - that concatenation is exactly (tokens // 7) * 2048 samples,
    which is what the whole-clip decode this replaces would have produced;
  * CADENCE - every payload but the last is exactly 4 frames, and the first one
    is not emitted until 6 frames exist (4 payload + 2 right context);
  * CONTEXT - each window really is [max(0, a-1), b+2) during the row and
    [max(0, a-1), n) at the flush, so every payload frame is decoded with a real
    left neighbour and (except at the very end) two real right ones;
  * SEQ - seq numbers start at 0 and increase by one, per row;
  * the awkward counts: 0, 1, 5, 6, 27 (not a frame boundary), 28 (exactly 4
    frames), 63 and 1015 (9 and 145 frames - the cases whose flush tail is the
    maximum FIVE frames), 100 and 1001 tokens, each driven token-by-token as
    generation really arrives, and again in one shot to prove the answer does
    not depend on when push() was called.

HOW THE FAKE DECODER WORKS. It returns frame k as 2048 copies of the value k,
so the concatenated payloads can be compared against the ideal whole-clip
waveform element by element - a payload cut one frame off would show up as a
run of the wrong integer, not as a length that happens to match.
"""
import os
import sys
import unittest

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine.snac import (  # noqa: E402
    LEFT_CONTEXT_FRAMES, PAYLOAD_FRAMES, RIGHT_CONTEXT_FRAMES,
    SAMPLES_PER_FRAME, TOKENS_PER_FRAME, StreamDecodeMisaligned,
    WindowedFrameEmitter,
)

AWKWARD = (0, 1, 5, 6, 27, 28, 63, 100, 1001, 1015)


class FakeDecoder:
    """Frame k decodes to 2048 samples all equal to k. Records every window."""

    def __init__(self, total_frames):
        self.total_frames = total_frames
        self.calls = []

    def __call__(self, first, last):
        self.calls.append((first, last))
        if not (0 <= first <= last <= self.total_frames):
            raise AssertionError(
                f'decoder asked for frames [{first}, {last}) but the row only '
                f'has {self.total_frames}')
        return np.concatenate([
            np.full(SAMPLES_PER_FRAME, float(k), dtype=np.float32)
            for k in range(first, last)
        ]) if last > first else np.zeros(0, dtype=np.float32)


def ideal(n_frames):
    """What the whole-clip decode would have produced for n frames."""
    if n_frames == 0:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate([
        np.full(SAMPLES_PER_FRAME, float(k), dtype=np.float32)
        for k in range(n_frames)
    ])


def run_row(n_tokens, incremental):
    """Drive one row and return (chunks, decoder, emitter). `incremental` feeds
    the emitter one token at a time, the way a decode step really does."""
    n_frames = n_tokens // TOKENS_PER_FRAME
    dec = FakeDecoder(n_frames)
    em = WindowedFrameEmitter(dec, label=f'row({n_tokens})')
    chunks = []
    if incremental:
        for t in range(1, n_tokens + 1):
            chunks.extend(em.push(t))
    chunks.extend(em.flush(n_tokens))
    return chunks, dec, em


class WindowedFrameEmitterTest(unittest.TestCase):

    def _assert_row(self, n_tokens, incremental):
        label = f'{n_tokens} tokens ({"per-token" if incremental else "one shot"})'
        n_frames = n_tokens // TOKENS_PER_FRAME
        chunks, dec, em = run_row(n_tokens, incremental)

        # seq numbering
        self.assertEqual([seq for seq, _ in chunks], list(range(len(chunks))),
                         f'{label}: seq must run 0..{len(chunks) - 1}')

        # contiguity, no overlap, no gap, exact total
        joined = (np.concatenate([pcm for _, pcm in chunks]) if chunks
                  else np.zeros(0, dtype=np.float32))
        want = ideal(n_frames)
        self.assertEqual(len(joined), n_frames * SAMPLES_PER_FRAME,
                         f'{label}: total sample count')
        self.assertTrue(np.array_equal(joined, want),
                        f'{label}: payloads must reassemble the whole clip frame for frame')
        self.assertEqual(em.emitted_samples, n_frames * SAMPLES_PER_FRAME,
                         f'{label}: the emitter agrees on what it emitted')

        # cadence: everything but the last chunk is exactly PAYLOAD_FRAMES
        sizes = [len(pcm) // SAMPLES_PER_FRAME for _, pcm in chunks]
        self.assertTrue(all(s == PAYLOAD_FRAMES for s in sizes[:-1]),
                        f'{label}: cadence {sizes}')
        if sizes:
            # The tail can be up to PAYLOAD + RIGHT_CONTEXT - 1 = 5 frames, NOT 4:
            # the drain stops as soon as n < a + 4 + 2, so a row of 5, 9, 13 or 17
            # frames flushes 5 at once. 63 and 1015 tokens (9 and 145 frames) are
            # in AWKWARD to make sure a 5-frame tail is actually exercised.
            max_tail = PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES - 1
            self.assertTrue(1 <= sizes[-1] <= max_tail,
                            f'{label}: flush tail {sizes[-1]} outside [1, {max_tail}]')
        self.assertEqual(bool(chunks), n_frames > 0,
                         f'{label}: emits iff there is at least one whole frame')

        # windows: right context during the row, left context always
        expected_calls = []
        a = 0
        while n_frames >= a + PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES:
            b = a + PAYLOAD_FRAMES
            expected_calls.append((max(0, a - LEFT_CONTEXT_FRAMES),
                                   b + RIGHT_CONTEXT_FRAMES))
            a = b
        if n_frames > a:
            expected_calls.append((max(0, a - LEFT_CONTEXT_FRAMES), n_frames))
        self.assertEqual(dec.calls, expected_calls,
                         f'{label}: decode windows must carry the specified context')
        self.assertEqual(len(dec.calls), len(chunks),
                         f'{label}: one window decoded per payload')
        if chunks:
            first_win = dec.calls[0]
            self.assertEqual(first_win[0], 0,
                             f'{label}: the first window starts at frame 0')
            if len(chunks) > 1:
                self.assertEqual(first_win[1], PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES,
                                 f'{label}: the first full-cadence window is 6 frames wide')
        return chunks

    def test_awkward_counts_per_token_and_one_shot(self):
        for n in AWKWARD:
            with self.subTest(tokens=n, mode='per-token'):
                self._assert_row(n, incremental=True)
            with self.subTest(tokens=n, mode='one-shot'):
                self._assert_row(n, incremental=False)

    def test_when_push_is_called_cannot_change_what_is_emitted(self):
        for n in AWKWARD:
            with self.subTest(tokens=n):
                per_token, _d, _e = run_row(n, incremental=True)
                one_shot, _d2, _e2 = run_row(n, incremental=False)
                a = [(s, pcm.tolist()) for s, pcm in per_token]
                b = [(s, pcm.tolist()) for s, pcm in one_shot]
                self.assertEqual(a, b)

    def test_rows_on_and_off_a_frame_boundary(self):
        # 28 tokens = exactly 4 frames; 27 = 3 frames + 6 stray codes that are not
        # audio yet. Both must emit whole frames only, and the stray codes vanish.
        on_boundary, _d, _e = run_row(28, incremental=True)
        off_boundary, _d2, _e2 = run_row(27, incremental=True)
        self.assertEqual(sum(len(p) for _s, p in on_boundary), 4 * SAMPLES_PER_FRAME)
        self.assertEqual(sum(len(p) for _s, p in off_boundary), 3 * SAMPLES_PER_FRAME)
        # The boundary between 6 and 7 tokens is where the first frame appears.
        self.assertEqual(sum(len(p) for _s, p in run_row(6, incremental=True)[0]), 0)
        self.assertEqual(sum(len(p) for _s, p in run_row(7, incremental=True)[0]),
                         SAMPLES_PER_FRAME)

    def test_the_maximum_five_frame_tail(self):
        """The drain stops as soon as n < a + 4 + 2, so 5, 9, 13 and 17 frames all
        flush FIVE frames in one payload. An earlier version of this test asserted
        a tail of <= 4 and never picked a count that produced a 5-tail."""
        for frames in (5, 9, 13, 17):
            with self.subTest(frames=frames):
                chunks, _d, _e = run_row(frames * TOKENS_PER_FRAME, incremental=True)
                tail = len(chunks[-1][1]) // SAMPLES_PER_FRAME
                self.assertEqual(tail, PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES - 1)
                self.assertEqual(sum(len(p) for _s, p in chunks),
                                 frames * SAMPLES_PER_FRAME)

    def test_push_after_flush_is_refused(self):
        em = WindowedFrameEmitter(FakeDecoder(20), label='refusals')
        em.push(7 * 20)
        em.flush(7 * 20)
        with self.assertRaises(StreamDecodeMisaligned):
            em.push(7 * 20)

    def test_flush_twice_is_refused(self):
        em = WindowedFrameEmitter(FakeDecoder(20), label='refusals')
        em.push(7 * 20)
        em.flush(7 * 20)
        with self.assertRaises(StreamDecodeMisaligned):
            em.flush(7 * 20)

    def test_shrinking_token_count_is_refused(self):
        em = WindowedFrameEmitter(FakeDecoder(20), label='shrink')
        em.push(7 * 20)
        with self.assertRaises(StreamDecodeMisaligned):
            em.push(7 * 2)

    def test_negative_token_count_is_refused(self):
        with self.assertRaises(StreamDecodeMisaligned):
            WindowedFrameEmitter(FakeDecoder(20), label='negative').push(-1)

    def test_decoder_returning_the_wrong_sample_count_is_refused(self):
        def short_decoder(first, last):
            # One sample short of a whole number of frames: the exact failure that
            # would silently shift every later payload.
            return np.zeros((last - first) * SAMPLES_PER_FRAME - 1, dtype=np.float32)
        with self.assertRaises(StreamDecodeMisaligned):
            WindowedFrameEmitter(short_decoder, label='short').push(7 * 6)

    def test_decoder_returning_none_is_refused(self):
        with self.assertRaises(StreamDecodeMisaligned):
            WindowedFrameEmitter(lambda a, b: None, label='none').push(7 * 6)

    def test_a_long_row_holds_its_cadence_all_the_way_down(self):
        chunks, dec, em = run_row(1001, incremental=True)
        n_frames = 1001 // TOKENS_PER_FRAME
        self.assertEqual(n_frames, 143)
        self.assertEqual(len(chunks) - 1, 35, '35 full chunks + a tail')
        self.assertTrue(
            all(w[1] - w[0] == PAYLOAD_FRAMES + LEFT_CONTEXT_FRAMES + RIGHT_CONTEXT_FRAMES
                for w in dec.calls[1:-1]),
            'every interior window is 1 + 4 + 2 = 7 frames wide')
        self.assertEqual(em.decoded_windows, len(chunks),
                         '1.75x the frames of a whole-clip decode, as designed')


if __name__ == '__main__':
    unittest.main()
