"""The `lib/conf_lang.py` tables the prep path reads, copied at
ebook2audiobook@9daab0ba.

Ported from ebook2audiobook@9daab0ba:
  lib/conf_lang.py   default_language_code (30), year_to_decades_languages (33),
                     punctuation_switch (35), punctuation_split_hard (117),
                     punctuation_split_soft (135), chars_remove (155),
                     emojis_list (166), abbreviations_mapping['eng'] (481),
                     language_mapping['eng'] (828)
  lib/conf.py        default_output_format (260), default_audio_proc_format (259)
  lib/conf_models.py default_fine_tuned (172)

ONLY 'eng' IS CARRIED, and that is a refusal, not a subset. e2a's
`language_mapping` is ~100 rows; the only row reachable from narrator is 'eng',
because e2a's own Orpheus branch refuses any other language by name
(`filter_chapter`: "Orpheus is English-only (got '<lang>')") and narrator renders
Orpheus and nothing else. `language_entry()` raises with the same shape of message
for anything else, so an unsupported language is a sentence an operator can act on
rather than a KeyError. See PORT_NOTES "Unexercised e2a paths".

`abbreviations_mapping['eng']` is carried WHOLE even though only its KEYS are read
on the Orpheus path (PASS 1 builds the abbreviation guard out of the key stems;
the expansions run only for the acoustic engines, which narrator refuses). Keeping
the values makes the copy checkable against e2a byte for byte.
"""
from __future__ import annotations

#: ISO-639-3. e2a's default and the only language narrator accepts.
default_language_code = 'eng'

#: e2a builds a stanza pipeline when the book's language is in this list. Kept
#: because it is the condition, not because narrator uses the pipeline - see
#: `text/sentences.py`, which records the measurement that nothing on the Orpheus
#: path ever consults it.
year_to_decades_languages = ['eng', 'deu', 'nld', 'nob', 'dan', 'swe']

#: `conf.default_output_format` - the container `final_name` is built with.
default_output_format = 'm4b'

#: `conf_models.default_fine_tuned` - what `--fine_tuned` falls back to when a
#: spawn omits it. Recorded into session state; the engine KeyErrors on it, which
#: is why every live spawn passes a real voice (CLAUDE.md).
default_fine_tuned = 'internal'

punctuation_switch = {
    # Quotes causing hallucinations in some TTS engines
    '«': '"', '»': '"',    # French-style quotes
    '“': '"', '”': '"',    # Curly double quotes
    '‘': "'", '’': "'",    # Curly single quotes
    '„': '"',                    # German-style quote

    # Dashes, underscores & hyphens that might cause weird pauses
    '–': '.',    # En dash
    '_': ' ',         # U+005F LOW LINE
    '‗': ' ',    # DOUBLE LOW LINE
    '¯': ' ',    # MACRON
    'ˍ': ' ',    # MODIFIER LETTER LOW MACRON
    '﹍': ' ',    # DASHED LOW LINE
    '﹎': ' ',    # CENTRELINE LOW LINE
    '﹏': ' ',    # WAVY LOW LINE
    '＿': ' ',    # FULLWIDTH LOW LINE

    # Ellipsis (causes extreme long pauses in TTS)
    '...': '…',

    # Misinterpreted punctuation that can lead to hallucinations
    '‽': '?',      # Interrobang
    '⁉': '?!',     # Exclamation question mark
    '‼': '!!',     # Double exclamation

    # Odd Unicode punctuation that can create strange effects
    '⁈': '?!',     # Question exclamation mark
    '⁇': '??',     # Double question mark
    '﹖': '?',      # Small form question mark
    '﹗': '!',      # Small form exclamation mark

    # Misinterpreted pauses
    '۔': '.',      # Arabic full stop
    '॥': '.',      # Devanagari double danda
    '。': '.',      # Chinese full stop
    '።': '.',      # Ethiopic full stop
    '།': '.',      # Tibetan shad

    # Miscellaneous
    '፡': ':',      # Ethiopic colon
    '፤': ';',      # Ethiopic semicolon
    '।': '.',      # Hindi period
    '•': '.',      # bullet
    '›': '',       # Single right-pointing angle quotation mark
    '#': '-',
    '†': '-',      # Dagger
    '¶': '-',      # Pilcrow

    # Global replacement
    '—': '.',      # Em dash
    '(': ',',
    ')': ',',
}

punctuation_split_hard = [
    # Western
    '.', '!', '?', '…', '‽', '—',
    # Arabic-Persian
    '؟',
    # CJK
    '。', '！', '？',
    # Indic
    '।', '॥',
    # Ethiopic
    '።', '፧',
    # Tibetan
    '།',
    # Khmer
    '។', '៕',
]
punctuation_split_hard_set = set(punctuation_split_hard)

punctuation_split_soft = [
    # Western
    ',', ':', ';',
    # Arabic-Persian
    '،',
    # CJK
    '，', '、', '·',
    # Thai
    'ฯ',
    # Ethiopic
    '፡', '፣', '፤', '፥', '፦',
    # Hebrew
    '״',
    # Tibetan
    '༎',
    # Lao
    '໌', 'ໍ',
]
punctuation_split_soft_set = set(punctuation_split_soft)

chars_remove = [
    '\\', '|', '©', '®', '™',
    '*', '`', ' ', '\xa0',
]

emojis_list = [
    r'\U0001F600-\U0001F64F',    # Emoticons
    r'\U0001F300-\U0001F5FF',    # Symbols & pictographs
    r'\U0001F680-\U0001F6FF',    # Transport & map symbols
    r'\U0001F1E0-\U0001F1FF',    # Flags
    r'\U00002700-\U000027BF',    # Dingbats
    r'\U0001F900-\U0001F9FF',    # Supplemental symbols
    r'\U00002600-\U000026FF',    # Misc symbols
    r'\U0001FA70-\U0001FAFF',    # Extended pictographs
    r'\U00002480-\U00002BEF',    # Box drawing, etc.
    r'\U0001F018-\U0001F270',
    r'\U0001F650-\U0001F67F',
    r'\U0001F700-\U0001F77F',
]

#: The English abbreviation table. On the Orpheus path only the KEYS are read -
#: PASS 1 turns their stems into the lookbehind guard that keeps 'Mr. Darcy' from
#: splitting mid-name.
abbreviations_mapping = {
    'eng': {
        'Mr.': 'Mister',
        'Mrs.': 'Missus',
        'Dr.': 'Doctor',
        'St.': 'Saint',
        'Jr.': 'Junior',
        'Sr.': 'Senior',
        'Prof.': 'Professor',
        'Capt.': 'Captain',
        'Ave.': 'Avenue',
        'Blvd.': 'Boulevard',
        'Rd.': 'Road',
        'Mt.': 'Mount',
        'etc.': 'et cetera',
        'vs.': 'versus',
        'e.g.': 'for example',
        'i.e.': 'that is',
        'et al.': 'and others',
    },
}

language_mapping = {
    'eng': {
        'name': 'English',
        'native_name': 'English',
        'max_chars': 250,
        'script': 'latin',
    },
}


class UnsupportedLanguage(RuntimeError):
    """A language narrator's text layer does not carry a table for."""


def language_entry(lang: str) -> dict:
    """`language_mapping[lang]`, with a named refusal instead of a KeyError.

    e2a would have found ~100 rows here. narrator carries one, because the Orpheus
    branch of `filter_chapter` refuses anything but 'eng' before this value is ever
    consulted for a real decision.
    """
    entry = language_mapping.get(lang)
    if entry is None:
        raise UnsupportedLanguage(
            f"narrator's text layer carries language tables for "
            f"{sorted(language_mapping)} only, not '{lang}'. Orpheus is "
            f"English-only by design; route this language to another engine "
            f"(ebook2audiobook + XTTS).")
    return entry
