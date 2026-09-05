"""`normalize_for_tts` - the listen path's number reading, and its refusals.

This runs on every `generate` and every streamed batch row, which is the browser
extension's path. (The audiobook path normalizes upstream in BookForge and never
arrives here.) It used to be built entirely out of fallbacks:

    _HAS_NUM2WORDS          a missing module read "$5.50" as punctuation, silently
    except Exception: ...   five sites returned the raw digits, silently
    (language or 'en')      a blank language narrated as English, silently

All three are gone. What replaces them is the point of this module: a refusal
that NAMES the thing it could not say, ONCE per request rather than once per
sentence - because the likeliest cause (a language num2words has no module for)
is a property of the session, and failing every digit-bearing sentence
separately with the same message is N refusals for one cause.
"""
import unittest

from narrator.serve.worker import (check_language, normalize_for_tts,
                                   resolve_language)
import narrator.serve.worker as worker


class ResolveLanguageTest(unittest.TestCase):
    """`x or 'en'` on a value the caller is meant to supply."""

    def test_a_subtag_is_taken_and_folded(self):
        for given, want in (('en', 'en'), ('en-GB', 'en'), ('EN', 'en'),
                            ('  en-us  ', 'en'), ('pt-BR', 'pt')):
            with self.subTest(given=given):
                self.assertEqual(resolve_language(given), want)

    def test_a_blank_language_is_refused_by_name_not_read_as_english(self):
        """The protocol field is optional and defaults to 'en' AT THE REQUEST
        BOUNDARY, which is documented. A blank one arriving this deep is a
        caller bug, and narrating an unknown language as English is exactly the
        silent substitution this path spent a commit removing."""
        for blank in ('', '   ', None, '-'):
            with self.subTest(given=blank):
                with self.assertRaises(ValueError) as caught:
                    resolve_language(blank)
                self.assertIn('language=', str(caught.exception))

    def test_normalize_for_tts_has_no_default_language(self):
        """It took `language='en'`, which was a SECOND default underneath the
        protocol's own - so a caller that forgot the argument silently got
        English instead of an error."""
        with self.assertRaises(TypeError):
            normalize_for_tts('some text')


class CheckLanguageTest(unittest.TestCase):
    """One refusal per request, not one per sentence."""

    def setUp(self):
        self._saved = dict(worker._LANGUAGE_VERDICTS)
        self.addCleanup(lambda: (worker._LANGUAGE_VERDICTS.clear(),
                                 worker._LANGUAGE_VERDICTS.update(self._saved)))

    def test_a_language_num2words_speaks_is_accepted(self):
        self.assertEqual(check_language('en'), 'en')

    def test_a_language_it_cannot_speak_is_refused_by_name(self):
        with self.assertRaises(ValueError) as caught:
            check_language('zz')
        message = str(caught.exception)
        self.assertIn('zz', message)
        self.assertIn('num2words', message)

    def test_the_verdict_is_reached_once_and_remembered(self):
        """THE WHOLE POINT. num2words is asked once per language per process; a
        book's worth of sentences must not each pay for - or each report - the
        same session-level answer."""
        worker._LANGUAGE_VERDICTS.clear()
        calls = []
        original = worker._num2words

        def counting(*args, **kwargs):
            calls.append(kwargs.get('lang'))
            return original(*args, **kwargs)

        worker._num2words = counting
        try:
            for _ in range(5):
                check_language('en')
        finally:
            worker._num2words = original
        self.assertEqual(len(calls), 1, f'asked {len(calls)} times, want 1')

    def test_a_bad_language_is_refused_before_any_probe_of_the_text(self):
        with self.assertRaises(ValueError):
            check_language('')


class NormalizeTest(unittest.TestCase):
    """What the listener actually hears."""

    def test_the_common_shapes_read_as_words(self):
        out = normalize_for_tts('It cost $5.50, up 50%, the 3rd time.', 'en')
        self.assertIn('five dollars and fifty cents', out)
        self.assertIn('fifty percent', out)
        self.assertIn('third', out)
        self.assertNotIn('$', out)
        self.assertNotIn('%', out)

    def test_a_year_reads_as_a_year(self):
        self.assertIn('nineteen ninety-five',
                      normalize_for_tts('Born in 1995 and never again.', 'en'))

    def test_empty_text_is_returned_untouched(self):
        for empty in ('', None):
            self.assertEqual(normalize_for_tts(empty, 'en'), empty)

    def test_a_number_it_cannot_say_is_refused_and_never_passed_through(self):
        """The five `except Exception: return <the digits>` sites. A number this
        cannot say is a defect in the caller's regex or the language, and the
        LISTENER must not be the one to discover it."""
        with self.assertRaises(ValueError) as caught:
            worker._to_words(7, 'zz')
        self.assertIn('num2words could not render', str(caught.exception))

    def test_every_helper_refuses_rather_than_returning_digits(self):
        for name, args in (('_to_words', (7, 'zz')),
                           ('_num_phrase', ('7', 'zz')),
                           ('_ordinal', (7, 'zz')),
                           ('_year_to_words', (1995, 'zz'))):
            with self.subTest(helper=name):
                with self.assertRaises(ValueError):
                    getattr(worker, name)(*args)


if __name__ == '__main__':
    unittest.main()
