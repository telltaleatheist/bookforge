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

#: NARRATOR'S OWN sentence-break guard - NOT part of the e2a copy above.
#:
#: `abbreviations_mapping` is carried whole and byte-checkable against
#: ebook2audiobook@9daab0ba, so nothing may be added to it. This set exists
#: BESIDE it for the one thing narrator needs and e2a's table does not carry:
#: more abbreviations whose dot must not end a subtitle cue. It is read for its
#: MEMBERS ONLY - there are no expansions here, and there is nothing to expand,
#: because narrator renders the book's text as printed. What a member changes is
#: where a VTT cue breaks; it changes nothing that is spoken, because the
#: splitter is text-preserving and the pieces rejoin to the book's own words.
#: (Same reach as the e2a keys it sits beside: PASS 1 is also what an OVER-BUDGET
#: paragraph is cut on, so a guarded dot can move a chunk edge by a sentence
#: there - the same trade the 'Mr. Darcy' guard has always made.)
#:
#: Owen, 2026-09-09: "'No. 1' becomes two sentences, the first ending on 'no.'
#: and the second starting at '1' ... another example: 'Col. 2:1' - a bibleverse.
#: it reads 'colossians chapter 2 verse 1.' but the VTT reads 'Col.' ' 2:1.'"
#:
#: 'No.' IS DELIBERATELY ABSENT, and must stay absent. It is also an ordinary
#: sentence-final English word, so guarding it would weld `"No." Then he left.`
#: into one cue - a real regression in fiction, traded for a case the pattern
#: builders' digit rule already fixes precisely. Any token that doubles as an
#: ordinary sentence-final word belongs out here, not in.
#:
#: CASE MATTERS, and that is what makes the risky-looking members safe. The
#: guard the pattern builders emit is `(?<!\bStem)\.` in a pattern compiled with
#: re.DOTALL and nothing else - no re.IGNORECASE - so 'Ch.' guards 'Ch.' and not
#: 'much.', 'Sec.' not 'sec.', 'Fr.' not 'fr.'. What survives is the narrow
#: collision of a sentence ending in that exact CAPITALIZED word ('...to Sam.',
#: '...the Sun.'): those cues merge with the next. Cosmetic, rare, and the price
#: of catching the citations. 'Ezra' is left out for the same reason 'No.' is -
#: it is not abbreviated (it carries no dot), so guarding it could only suppress
#: a genuine break, and 'Ezra 7:10' never had a dot to break at.
SENTENCE_ABBREVIATIONS = frozenset({
    # Bible books, the case Owen hit ('Col. 2:1').
    'Gen.', 'Ex.', 'Exod.', 'Lev.', 'Num.', 'Deut.', 'Josh.', 'Judg.',
    'Sam.', 'Kgs.', 'Chron.', 'Neh.', 'Esth.', 'Ps.', 'Pss.', 'Prov.',
    'Eccl.', 'Isa.', 'Jer.', 'Lam.', 'Ezek.', 'Dan.', 'Hos.', 'Obad.',
    'Mic.', 'Nah.', 'Hab.', 'Zeph.', 'Hag.', 'Zech.', 'Mal.', 'Matt.',
    'Mk.', 'Lk.', 'Jn.', 'Rom.', 'Cor.', 'Gal.', 'Eph.', 'Phil.', 'Col.',
    'Thess.', 'Tim.', 'Tit.', 'Philem.', 'Heb.', 'Jas.', 'Pet.', 'Rev.',
    # Publishing apparatus and titles.
    'Vol.', 'Vols.', 'Ch.', 'Chap.', 'Fig.', 'Figs.', 'Sec.', 'Ed.',
    'Eds.', 'Trans.', 'cf.', 'viz.', 'approx.', 'Inc.', 'Ltd.', 'Co.',
    'Corp.', 'Univ.', 'Dept.', 'Gov.', 'Sen.', 'Rep.', 'Pres.', 'Sgt.',
    'Lt.', 'Maj.', 'Adm.', 'Fr.', 'Hon.', 'Msgr.', 'Esq.',
    # Months and days.
    'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.',
    'Sept.', 'Oct.', 'Nov.', 'Dec.', 'Mon.', 'Tue.', 'Tues.', 'Wed.',
    'Thu.', 'Thur.', 'Thurs.', 'Fri.', 'Sat.', 'Sun.',
})

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
