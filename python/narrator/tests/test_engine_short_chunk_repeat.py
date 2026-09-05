"""An ultra-short chunk must not be left unguarded by the anti-runaway levers.

Ported from ebook2audiobook@9daab0ba tools/test_short_chunk_repeat.py
(2026-08-28) to unittest and to narrator.engine.OrpheusEngine. Same fixture,
same assertions, same reference voice.

THE DEFECT. The 2026-08-27 header-own-chunks change exempted headings from the
packer's min-chars floor, which existed precisely so an ultra-short row is never
handed to TTS as its own starved prompt. Orpheus then sometimes failed to stop
after saying a two-word title and said it again: measured in a real render,
"Introduction." (13 chars) took 4.267 s where same-length titles took 1.5-1.6 s.

WHY it could happen: every anti-runaway lever sizes itself from
`chars / 18.4 ch-per-s`, a SPEECH estimate that ignores the model's own trained
tail (~0.8 s, flat, on every clip). The EOS boost papered over that with a flat
`max(300.0, ...)` floor, which made the boost's start identical - 600 tokens,
7.14 s of audio, at deathstalker's eosBoostStart 2.0 - for a 4-char title and a
65-char one alike. A healthy 13-char heading renders in ~130 tokens, so the boost
could not engage until a clip had run 4x its natural length; the doubled take
ended at 358 tokens having never received a single logit of help. The MLX
per-chunk budget had the mirror bug, capping "GOD." at 40 tokens against a
measured 108.

MEASURED, NOT GUARDED (2026-08-28). An earlier version of this re-rendered an
overrunning chunk and kept the shorter take. Owen removed it - "i dont want a
guard. i want to fix it at the source" - because the duplication is in the
generated AUDIO, not the text, so the cure belongs in the fine-tune, and a
silent second render would hide the signal the retrain has to be judged by.

WHAT THIS PROVES, driving the real methods (no GPU, no model):
  1. the EOS boost engages before the known doubled take, and on NO healthy
     clip in the reference set;
  2. it is a NO-OP at 48 chars and above - ordinary prose is untouched;
  3. the MLX per-chunk token budget covers every healthy short render;
  4. the overrun REPORT names the doubled take and nothing else, and leaves the
     audio byte-for-byte alone.

FIXTURE. The 52 non-empty chunks of <= 60 chars from the real render at
Z:\\bookforge\\projects\\witches_-_Unknown\\stages\\03-tts\\sessions\\en\\
ebook-38a708a4-cba0-486c-8af2-1bc7857c2092\\2055c81ef480ca96c96465726894841c
(deathstalker). Raw file duration IS the generated audio here: _save_audio does
not trim (NO-FALLBACK 2026-07-11) and deathstalker ships sentenceGap 0 - proven
by the set's minimum trailing silence, 0.490 s, sitting BELOW the 0.6 s gap
default, so no pad was appended. Hence tokens = seconds * TOKENS_PER_AUDIO_SECOND.
"""
import contextlib
import io
import os
import sys
import unittest

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import OrpheusEngine  # noqa: E402


@contextlib.contextmanager
def captured_engine_log():
    """Capture the ENGINE's log channel - not stdout.

    These reports used to be bare `print`s, so this file read them off stdout.
    They now go through `narrator.engine.log`, whose stream the HOST owns:
    `narrator.serve`'s stdout is the JSON-lines protocol and a stray engine line
    there breaks the client's parse, while `narrator.compat.worker` deliberately
    points the same channel AT stdout because parallel-tts-bridge.ts parses it
    (see narrator/engine/log.py and tests/test_engine_log_stream.py).

    Pointing that channel at a sink is also strictly MORE precise than
    redirecting stdout was: it captures the engine's own lines and nothing
    else's.
    """
    from narrator.engine.log import set_log_stream
    sink = io.StringIO()
    set_log_stream(sink)
    try:
        yield sink
    finally:
        set_log_stream(None)



# (chars, raw_seconds, label). BAD marks the one take Owen heard spoken twice.
BAD = 'Introduction.'
# Named in the report as a second suspect (6.3 ch/s where 30-40 char peers run
# 10-13): not asserted either way, only reported.
SUSPECT = 'Turtles Are "Zeroes," Not "Heroes".'
FIXTURE = [
    (11, 1.621, 'Dedication.'),
    (8, 1.365, 'Preface.'),
    (13, 4.267, BAD),
    (55, 3.669, 'CAN CHRISTIAN CHILDREN BE AFFECTED BY DEMONIC ACTIVITY?'),
    (33, 2.645, 'UnderstandingWhich WitchIs Which.'),
    (51, 3.243, 'HOW CAN THEY TELL THE FUTUREIF THEY ARE NOT OF GOD?'),
    (40, 2.304, 'WHAT IS THE TRUE TEST OF A REAL PROPHET?'),
    (46, 3.072, 'SHOULD WE BE AFRAID OF THESEWITCHES AND SEERS?'),
    (12, 1.536, 'WHITE MAGIC.'),
    (12, 2.048, 'BLACK MAGIC.'),
    (37, 3.157, 'Witches ActivelyProselytize Children.'),
    (7, 1.621, 'CASE 1.'),
    (7, 1.365, 'CASE 2.'),
    (16, 1.963, 'Major festivals.'),
    (16, 1.621, 'Minor festivals.'),
    (35, 3.072, 'PROBLEMS WHICH STEM FROM ASTROLOGY.'),
    (7, 1.621, 'CASE 3.'),
    (48, 3.499, 'Witches and Satanists HaveSome Things In Common.'),
    (42, 4.779, 'NINE ABOMINATIONS IN DEUTERONOMY 18:10-11.'),
    (48, 3.584, 'WHAT SUPERNATURAL PHENOMENA DO TEENS BELIEVE IN?'),
    (54, 3.584, 'Do people who die have a desire to talk to the living?'),
    (40, 3.072, 'THREE DANGERS INVOLVED IN REINCARNATION.'),
    (46, 4.096, 'Witches and Satanists Usethe Media to Recruit.'),
    (43, 2.816, 'THREE WAYS THAT THE MEDIA HELPS WITCHCRAFT.'),
    (34, 2.987, 'SYMBOLISM BEHIND THE WIZARD OF OZ.'),
    (30, 3.243, 'Satan Is "Trolling" for Souls.'),
    (59, 4.267, 'In the occult, they teach that there are two sexual demons.'),
    (27, 2.304, 'Lucifer Is Quite a Charmer.'),
    (27, 2.987, 'Witches Do "Knot"Play Fair.'),
    (26, 3.840, 'Smurfs Are Not"True Blue".'),
    (57, 6.144, 'Something Smells a "Little Fishy" WithThe Little Mermaid.'),
    (35, 5.547, SUSPECT),
    (34, 3.072, 'DANGERS OF THESE REPTILIAN HEROES.'),
    (25, 2.219, 'HERE ARE A FEW QUESTIONS.'),
    (49, 2.816, 'Are they teaching that mutants can turn out good?'),
    (39, 3.413, 'Bart Simpson Has His Own Values System.'),
    (26, 3.840, '"He\'s Man" and"She\'s God".'),
    (38, 3.755, 'Ecology or Theology,You Make the Call.'),
    (56, 3.413, 'HOW DO WE KNOW THAT GOD DOES NOT SHOW FAVORITISM TO MEN?'),
    (21, 2.048, 'Beauty and the Beast.'),
    (27, 2.048, 'THE METABOLISM OF THE BODY.'),
    (7, 1.109, 'Barney.'),
    (41, 3.413, 'Situation Ethics and Those Who Have None.'),
    (25, 2.731, 'Bereavement andBraindead.'),
    (23, 2.901, 'Yin and YangMade Plain.'),
    (6, 1.792, 'SATAN.'),
    (4, 1.280, 'GOD.'),
    (25, 1.963, 'Twenty-Seven Admonitions.'),
    (10, 1.280, 'THE FLESH.'),
    (19, 2.219, "SATAN'S BACKGROUND."),
    (8, 2.304, 'NEW AGE.'),
    (17, 1.621, 'About the Author.'),
]

VOICE = 'deathstalker'
# deathstalker's live catalog values (electron/data/orpheus-models.json).
CAPS = {'repPenalty': 1.1, 'eosBoost': 8, 'eosBoostStart': 2, 'maxCharsPerSec': 23.5}


def engine():
    """A bare instance: every method under test reads only class attributes and
    the registered caps, so __init__ (which loads a model) is not needed."""
    OrpheusEngine.register_voice_caps(VOICE, dict(CAPS))
    tts = OrpheusEngine.__new__(OrpheusEngine)
    tts.voice = VOICE
    return tts


def boost_start(tts, n_chars):
    """The token index where the real processor first adds EOS bias, found by
    probing it rather than by re-deriving its arithmetic."""
    proc = tts._eos_boost_processor(n_chars)
    if proc is None:
        raise AssertionError('the reference voice must have a boost configured')
    for n in range(1, 4 * OrpheusEngine.MAX_AUDIO_TOKENS):
        logits = np.zeros(OrpheusEngine.END_OF_AUDIO_TOKEN + 1, dtype=np.float64)
        proc(list(range(n)), logits)
        if logits[OrpheusEngine.END_OF_AUDIO_TOKEN] > 0:
            return n
    raise AssertionError(f'boost never engaged for {n_chars} chars')


def old_start(n_chars):
    """The pre-fix start, for the no-op assertion: eosBoostStart x the flat floor."""
    return CAPS['eosBoostStart'] * max(
        300.0, n_chars / 18.4 * OrpheusEngine.TOKENS_PER_AUDIO_SECOND)


def tokens(seconds):
    return seconds * OrpheusEngine.TOKENS_PER_AUDIO_SECOND


class ShortChunkRepeatTest(unittest.TestCase):

    def setUp(self):
        self.tts = engine()

    def test_boost_engages_on_the_doubled_take_and_on_no_healthy_clip(self):
        starts = {}
        tightest = (1e9, None)
        for chars, seconds, label in FIXTURE:
            if chars not in starts:
                starts[chars] = boost_start(self.tts, chars)
            start, generated = starts[chars], tokens(seconds)
            engaged = generated > start
            with self.subTest(label=label):
                if label == BAD:
                    self.assertTrue(
                        engaged,
                        f'the doubled take must be boosted: {generated:.0f} tokens '
                        f'vs start {start:.0f}')
                elif label == SUSPECT:
                    # Reported in e2a's script, asserted neither way there or here.
                    pass
                else:
                    self.assertFalse(
                        engaged,
                        f'healthy clip must NOT be boosted mid-speech: {label!r} '
                        f'({chars} chars, {generated:.0f} tokens) vs start {start:.0f}')
                    margin = (start - generated) / generated
                    if margin < tightest[0]:
                        tightest = (margin, label)
        # The reference set's thinnest healthy margin. Asserted as a floor so a
        # future SHORT_CHUNK_TAIL_TOKENS change that eats it is caught here rather
        # than by ear: e2a measured 4.8% on 'NEW AGE.'.
        self.assertGreater(tightest[0], 0.04,
                           f'thinnest healthy margin {tightest[0] * 100:.1f}% on {tightest[1]!r}')

    def test_no_op_for_ordinary_prose(self):
        for chars in (48, 55, 66, 100, 200, 350, 450, 540):
            with self.subTest(chars=chars):
                self.assertLessEqual(abs(boost_start(self.tts, chars) - old_start(chars)), 1.0,
                                     f'boost start must be unchanged at {chars} chars')

    def test_the_change_is_confined_below_48_chars(self):
        changed = [c for c in range(1, 200)
                   if abs(boost_start(self.tts, c) - old_start(c)) > 1.0]
        self.assertTrue(changed, 'the tail allowance must change SOMETHING')
        self.assertLess(max(changed), 48,
                        f'behaviour differs only for {min(changed)}-{max(changed)} chars')

    def test_the_mlx_budget_covers_every_healthy_short_render(self):
        tightest = (1e9, None)
        for chars, seconds, label in FIXTURE:
            if label in (BAD, SUSPECT):
                continue
            with self.subTest(label=label):
                budget = self.tts._mlx_token_budget('x' * chars)
                generated = tokens(seconds)
                self.assertGreaterEqual(
                    budget, generated,
                    f'MLX budget must not truncate a healthy render: {label!r} '
                    f'({chars} chars) needs {generated:.0f} tokens, budget {budget}')
                margin = (budget - generated) / budget
                if margin < tightest[0]:
                    tightest = (margin, label)
        # e2a measured 9.1% on 'NEW AGE.' at SHORT_CHUNK_TAIL_TOKENS 96.
        self.assertGreater(tightest[0], 0.05,
                           f'tightest budget margin {tightest[0] * 100:.1f}% on {tightest[1]!r}')

    def test_the_overrun_report_names_the_doubled_take_and_only_reports(self):
        reported = []
        for chars, seconds, label in FIXTURE:
            audio = np.zeros(int(seconds * OrpheusEngine.SAMPLE_RATE), dtype=np.float32)
            before = audio.copy()
            with captured_engine_log() as sink:
                said = self.tts._report_short_chunk_overrun(0, 'x' * chars, audio)
                line = sink.getvalue()
            if said:
                reported.append(label)
            # THE POINT OF THE WHOLE CHANGE: observing must not alter the take.
            self.assertTrue(np.array_equal(audio, before) and len(audio) == len(before),
                            f'the report must not touch the audio ({label!r})')
            self.assertEqual(bool(line.strip()), said,
                             f'a line is printed iff it reported ({label!r})')
        self.assertEqual(reported, [BAD],
                         f'report must name exactly [{BAD!r}], named {reported}')

    def test_the_log_line_is_one_greppable_line_with_every_field(self):
        audio = np.zeros(int(4.267 * OrpheusEngine.SAMPLE_RATE), dtype=np.float32)
        with captured_engine_log() as sink:
            self.tts._report_short_chunk_overrun(4242, 'Introduction.', audio)
            line = sink.getvalue().strip()
        self.assertEqual(line.count('\n'), 0,
                         'the report must be ONE line, so one grep counts it')
        self.assertIn(OrpheusEngine.SHORT_CHUNK_OVERRUN_TAG, line)
        for field in ('sentence=4242', 'chars=13', 'seconds=4.267', 'allowed=3.370',
                      'ratio=1.27', "text='Introduction.'"):
            self.assertIn(field, line, f'the line must carry {field!r}')

    def test_the_report_can_be_silenced(self):
        """ORPHEUS_SHORT_CHUNK_CHARS=0 - the same "0 disables" convention as the
        sentence gap and the min-chars floor - so a book can be rendered without
        the noise."""
        audio = np.zeros(int(4.267 * OrpheusEngine.SAMPLE_RATE), dtype=np.float32)
        saved = OrpheusEngine.SHORT_CHUNK_MAX_CHARS
        try:
            OrpheusEngine.SHORT_CHUNK_MAX_CHARS = 0
            with captured_engine_log() as sink:
                said = self.tts._report_short_chunk_overrun(0, 'Introduction.', audio)
                line = sink.getvalue()
            self.assertFalse(said)
            self.assertFalse(line.strip())
        finally:
            OrpheusEngine.SHORT_CHUNK_MAX_CHARS = saved


if __name__ == '__main__':
    unittest.main()
