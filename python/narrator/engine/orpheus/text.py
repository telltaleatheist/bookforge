"""The text facts the engine needs: the unspoken-SML pattern, the cardinal
number words, and the ASR-gate risk flag.

Ported from ebook2audiobook@9daab0ba:
  lib/conf_models.py            SML_UNSPOKEN_PATTERN
  lib/classes/tts_engines/common/orpheus_text.py
                                num_to_words, _big_num_words, asr_gate_risk,
                                _NUMBER_WORDS

WHAT IS DELIBERATELY NOT HERE. `to_tts_form` and its three transforms
(`expand_grouped_integers`, `normalize_scripture`, `expand_digits`, `year_words`)
are NOT ported. THE ENGINE READS THE TEXT AS PRINTED (Owen, 2026-09-02,
permanently): number normalization is BookForge's job - a model pass over the
narration copy, run by the CLI's cleanup step before its TTS step - and "we don't
need the pass done in two places". orpheus.py already never calls them
(`_clean_sentence_for_tts` strips SML and nothing else), so they are dead code on
the engine side; their only live reader was `asr_gate._norm_words`, which needs
`_big_num_words` alone. `year_words` additionally reached back into
`lib.core.year2words`, which drags in `num2words` and e2a's phoneme tables - a
dependency narrator would have taken on for a function it never calls. See
PORT_NOTES.md "Dropped: dead code".

Stdlib `re` only: NO torch, NO vLLM, NO mlx.
"""
import re

# THE tags no engine ever SPEAKS, as ONE pattern.
#
# Timing tags ([break]/[pause]) are realized as silence before this point and
# [heading]/[item] are pure markup, so by the time text reaches a model - or a
# VTT cue, or an m4b chapter title - none of them may still be in it.
#
# The optional '/' matches a closing form; none of these tags is paired today,
# but stripping '[/x]' is never wrong for a tag that is never spoken.
SML_UNSPOKEN_PATTERN = re.compile(
    r'\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]',
    re.IGNORECASE
)

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven",
         "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
         "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]


def num_to_words(n: int):
    """Port of orpheus-finetune align_excerpts.num_to_words (training-text style):
    cardinal, no hyphens, no 'and'. Returns a list of words, or None out of range."""
    if n < 0 or n > 9999:
        return None
    if n < 20:
        return [_ONES[n]]
    if n < 100:
        w = [_TENS[n // 10]]
        if n % 10:
            w.append(_ONES[n % 10])
        return w
    if n < 1000:
        w = [_ONES[n // 100], "hundred"]
        if n % 100:
            w += num_to_words(n % 100)
        return w
    w = [_ONES[n // 1000], "thousand"]
    if n % 1000:
        w += num_to_words(n % 1000)
    return w


def _big_num_words(n: int):
    """num_to_words extended past 9999 - same style (cardinal, no hyphens, no
    'and'), scales to millions. Beyond that a printed number is data, not prose;
    leave it. The ASR gate's reference normalization is its one live reader."""
    if n < 0 or n > 999_999_999:
        return None
    if n < 10000:
        return num_to_words(n)
    w = []
    if n >= 1_000_000:
        w += num_to_words(n // 1_000_000) + ["million"]
        n %= 1_000_000
    if n >= 1000:
        w += num_to_words(n // 1000) + ["thousand"]
        n %= 1000
    if n:
        w += num_to_words(n)
    return w


# -- ASR verify-gate risk flag (2026-08-29) ----------------------------------
# The Gods People census measured WHERE the model falls off the text mid-chunk:
# number-word runs from date expansion ('October fifteen, nineteen forty-four'
# spoken as 'October 9th, Cineology'), raw digit clusters left as printed
# (citations: '9201, Bl. 65-71'), and twin anchors that survive the split. Those
# chunks - ~10-15% of a citation-dense book, far less of plain fiction - are
# worth an ASR spot-check after generation; the rest are not worth the CPU.

_NUMBER_WORDS = frozenset(
    "zero one two three four five six seven eight nine ten eleven twelve "
    "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
    "thirty forty fifty sixty seventy eighty ninety hundred thousand million "
    "oh".split())


def asr_gate_risk(clean_text: str):
    """Why this MODEL-INPUT text deserves a post-generation ASR check, or None.

    Returns a short reason tag for the guard-event log: 'number-run' (>= 3
    consecutive number words - the spoken-date shape), 'digit-cluster' (>= 2
    digit-bearing tokens in one window of 6 - the citation shape), or None (no
    flag; the ordinary case, no ASR cost)."""
    words = re.sub(r"[^\w\s]", " ", clean_text.lower()).split()
    run = 0
    for w in words:
        run = run + 1 if w in _NUMBER_WORDS else 0
        if run >= 3:
            return "number-run"
    digit_idx = [i for i, w in enumerate(words) if any(ch.isdigit() for ch in w)]
    for a, b in zip(digit_idx, digit_idx[1:]):
        if b - a < 6:
            return "digit-cluster"
    return None
