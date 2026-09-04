"""The Orpheus engine reads its text AS PRINTED - no engine-side number
transform (Owen, 2026-09-02, permanently).

Ported from ebook2audiobook@9daab0ba tools/test_engine_reads_as_printed.py,
minus the two of its four cases that are not narrator.engine's to answer:

  * case 3 (the PACKER measures printed length) drove `lib.core.filter_chapter`.
    The packer is migration step 4 - narrator's `text/` - and does not exist
    yet; the case moves there with it.
  * case 4 (`to_tts_form` still expands) asserted a transform narrator does NOT
    port: the engine never called it, its only live reader was the ASR gate's
    `_big_num_words`, and its year branch reached back into `lib.core.year2words`
    (num2words + e2a's phoneme tables). See PORT_NOTES.md "Dropped: dead code".

What is left is the case that IS this module's: the boundary between stored text
and model input.

Number normalization is BookForge's job (a model pass over the narration copy,
run by the CLI's cleanup step before its TTS step), and "we don't need the pass
done in two places". This proves, through the real code:

  1. _clean_sentence_for_tts strips the SML tags and changes NOTHING else -
     digits, comma-grouped integers, dates and scripture refs come out exactly
     as they went in;
  2. the environment has no say: the ORPHEUS_TEXT_TRANSFORM variable that
     briefly existed on 2026-09-02 is not read (there is no switch - a knob
     would be a second place);
  3. every marker in SML_UNSPOKEN_PATTERN is stripped, in any position, opening
     or closing, with or without a value - the one pattern all readers share.
"""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from narrator.engine import OrpheusEngine  # noqa: E402
from narrator.engine import text as engine_text  # noqa: E402

SAMPLE = '[break][item]Member number 670,992 joined on October 15, 1944; see John 3:16.[pause]'
PRINTED = 'Member number 670,992 joined on October 15, 1944; see John 3:16.'


def clean(s):
    # _clean_sentence_for_tts reads nothing from self, so a bare instance is
    # enough - the same trick e2a's script used.
    inst = OrpheusEngine.__new__(OrpheusEngine)
    return OrpheusEngine._clean_sentence_for_tts(inst, s)


class ReadsAsPrintedTest(unittest.TestCase):

    def setUp(self):
        os.environ.pop('ORPHEUS_TEXT_TRANSFORM', None)
        self.addCleanup(os.environ.pop, 'ORPHEUS_TEXT_TRANSFORM', None)

    def test_sml_stripped_every_digit_and_ref_as_printed(self):
        self.assertEqual(clean(SAMPLE), PRINTED)

    def test_the_environment_has_no_say(self):
        for v in ('0', '1', 'anything'):
            with self.subTest(value=v):
                os.environ['ORPHEUS_TEXT_TRANSFORM'] = v
                self.assertEqual(clean(SAMPLE), PRINTED)

    def test_no_switch_exists(self):
        """A knob would be a second place for the pass to live."""
        self.assertFalse(hasattr(engine_text, 'text_transform_enabled'))
        self.assertFalse(hasattr(engine_text, 'to_tts_form'),
                         'to_tts_form is deliberately NOT ported - see PORT_NOTES.md')

    def test_every_unspoken_marker_is_stripped(self):
        for tag in ('break', 'pause', 'heading', 'item', 'music', 'sfx', 'silence'):
            for form in (f'[{tag}]', f'[/{tag}]', f'[{tag}:1.5]', f'[{tag.upper()}]'):
                with self.subTest(tag=tag, form=form):
                    self.assertEqual(clean(f'{form}Chapter one.'), 'Chapter one.')
                    self.assertEqual(clean(f'Chapter one.{form}'), 'Chapter one.')

    def test_an_emotion_tag_survives(self):
        """Orpheus has its OWN inline tags, and stripping one would silently
        change the read."""
        self.assertEqual(clean('[heading]She laughed <laugh> once.'),
                         'She laughed <laugh> once.')

    def test_a_row_that_is_only_markup_cleans_to_empty(self):
        """The caller's contract for an empty chunk is a short silence, and both
        batch paths test the CLEANED string for it."""
        self.assertEqual(clean('[break][pause]'), '')
        self.assertEqual(clean('   '), '')
        self.assertEqual(clean(None), '')

    def test_the_number_words_the_asr_gate_still_needs(self):
        """`_big_num_words` is the ONE thing left alive from e2a's orpheus_text:
        the ASR gate's reference normalization reads it so a citation chunk's
        expected text does not lose its numbers while the transcript keeps them
        as spoken words."""
        self.assertEqual(engine_text._big_num_words(670992),
                         ['six', 'hundred', 'seventy', 'thousand', 'nine',
                          'hundred', 'ninety', 'two'])
        self.assertEqual(engine_text.num_to_words(1944),
                         ['one', 'thousand', 'nine', 'hundred', 'forty', 'four'])
        self.assertIsNone(engine_text.num_to_words(10000), 'out of range -> None')

    def test_the_asr_risk_flag(self):
        """Which chunks are worth a post-generation ASR spot-check, and which
        cost nothing."""
        self.assertEqual(engine_text.asr_gate_risk(
            'October fifteen, nineteen forty-four.'), 'number-run')
        self.assertEqual(engine_text.asr_gate_risk('9201, Bl. 65-71'), 'digit-cluster')
        self.assertIsNone(engine_text.asr_gate_risk(
            'It was a dark and stormy night, and nothing was numbered.'))


if __name__ == '__main__':
    unittest.main()
