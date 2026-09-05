"""`normalize_text` and `foreign2latin` - the last thing that touches a chapter's
flat text before the packer splits it.

Ported from ebook2audiobook@9daab0ba:
  lib/core.py   foreign2latin (3366), normalize_text (3543)

WHAT ACTUALLY RUNS FOR ORPHEUS, and what does not. `normalize_text` is one
function with nine `if tts_engine != TTS_ENGINES['ORPHEUS']` gates in it. Six
whole transforms are gated OFF for Orpheus and are NOT ported:

  - abbreviation expansion ('Mr.' -> 'Mister') and acronym de-dotting
  - the quote-to-comma rewrite and the quote strip
  - 'ok' -> 'Okay'
  - the punctuation-run collapse and its re-spacing (`_collapse`)
  - the letter/digit spacing rule
  - the special-character word substitution

Every one of them is off because Orpheus fine-tunes are trained on book-exact
text; the reasons are in e2a's own comments and in memory
`orpheus-raw-verbatim-pivot.md`. narrator refuses a non-Orpheus engine by name
rather than carrying a second behaviour nothing exercises - see PORT_NOTES
"Unexercised e2a paths".

NUMBER NORMALIZATION IS NOT HERE AND NEVER WAS, on this path. e2a's date/year/
roman/clock/math pipeline is skipped for Orpheus (permanently, 2026-09-02):
number normalization is BookForge's own model pass over the narration copy, run
before the text ever reaches prep (`prepareNarrationInput`). So the rows this
module produces already carry the words the model reads.
"""
from __future__ import annotations

import unicodedata
from typing import Dict

import regex as re

from .lang import (
    chars_remove,
    emojis_list,
    language_entry,
    punctuation_switch,
)
from .sml import SML_TAG_PATTERN, sml_token

#: The one engine narrator's text layer PORTED a branch of.
ORPHEUS = 'orpheus'

#: Higgs v3, the second engine (`docs/NARRATOR_PLAN.md`, Owen 2026-09-04). The
#: registry id, exactly: `higgs` and `higgs-v2` are not it.
HIGGS_V3 = 'higgs-v3'

#: THE ENGINES THAT READ BOOK-EXACT TEXT, and therefore take the branch of
#: `normalize_text` this module implements.
#:
#: A DECISION, NOT A PORT, and flagged as one for the orchestrator.
#: ebook2audiobook has no Higgs branch, because Higgs did not exist in it. But
#: every reason the Orpheus branch exists is a property of an LLM-based TTS
#: reading printed prose, not of Orpheus: numbers are normalized upstream by
#: BookForge's model pass, quotation marks are the cue that a span is dialogue,
#: and the training text keeps parentheses and dashes verbatim. What the branch
#: DOES is strip emojis, romanize a non-Latin word, fold the
#: hallucination-causing punctuation, and touch nothing else. Higgs v3 is the
#: same kind of model reading the same narration copy, so it reads the same
#: text. If that proves wrong for Higgs the fix is a Higgs branch here, not a
#: different packer.
#:
#: WHAT IS NOT EXTENDED: `text/packer.py` and `chapters.filter_chapter` stay
#: Orpheus-only. They are the ported e2a packer, whose caps, floors and merge
#: passes were calibrated on Orpheus voices; a Higgs book chunks through
#: `text/paragraph_packer.py`, which asks a `Budget` instead of a constant.
BOOK_EXACT_ENGINES = frozenset({ORPHEUS, HIGGS_V3})


class UnsupportedEngine(RuntimeError):
    """A tts_engine narrator's text layer does not implement."""


def _refuse_engine(tts_engine: str, where: str) -> None:
    raise UnsupportedEngine(
        f"{where}: narrator's text layer reads book-exact text for "
        f"{sorted(BOOK_EXACT_ENGINES)}, not '{tts_engine}'. "
        f"ebook2audiobook's other engines (XTTS, Voxtral, bark, ...) are "
        f"refused by name across narrator - see narrator/compat/FLAGS.md.")


# =============================================================================
# foreign2latin (core.py:3366)
# =============================================================================

def _script_of(word: str) -> str:
    for ch in word:
        if ch.isalpha():
            name = unicodedata.name(ch, '')
            if 'CYRILLIC' in name:
                return 'cyrillic'
            if 'LATIN' in name:
                return 'latin'
            if 'ARABIC' in name:
                return 'arabic'
            if 'HANGUL' in name:
                return 'hangul'
            if 'HIRAGANA' in name or 'KATAKANA' in name:
                return 'japanese'
            if 'CJK' in name or 'IDEOGRAPH' in name:
                return 'chinese'
    return 'unknown'


def _romanize(word: str) -> str:
    """One word token, romanized.

    A Latin word is returned UNCHANGED and touches no import, which is why an
    English book never reaches any of the branches below - the whole function is
    an identity for Latin-script prose. (A digits-only token like '1993' scores
    'unknown' and goes through `unidecode`, which returns it unchanged.)

    `unidecode` is imported HERE rather than at module scope, unlike e2a, which
    imports it beside `pypinyin`/`pykakasi`/`phonemizer` at the top of core.py.
    Every one of these is reachable only from a NON-LATIN word, so importing them
    at module scope would make `narrator.text` un-importable on a machine that
    can still prep every English book it will ever be asked to. Declared in
    PORT_NOTES: the failure moves later, the output does not move at all.
    """
    scr = _script_of(word)
    if scr == 'latin':
        return word
    from unidecode import unidecode
    try:
        if scr == 'chinese':
            from pypinyin import pinyin, Style
            return ''.join(x[0] for x in pinyin(word, style=Style.NORMAL))
        if scr == 'japanese':
            import pykakasi
            k = pykakasi.kakasi()
            k.setMode('H', 'a')
            k.setMode('K', 'a')
            k.setMode('J', 'a')
            k.setMode('r', 'Hepburn')
            return k.getConverter().do(word)
        if scr == 'hangul':
            return unidecode(word)
        if scr == 'arabic':
            from phonemizer import phonemize
            return unidecode(phonemize(word, language='ar', backend='espeak'))
        if scr == 'cyrillic':
            from phonemizer import phonemize
            return unidecode(phonemize(word, language='ru', backend='espeak'))
        return unidecode(word)
    except Exception:
        return unidecode(word)


def foreign2latin(text: str, base_lang: str) -> str:
    """Romanize non-Latin word tokens, rebuilding the ORIGINAL spacing.

    The tokenizer includes whitespace (`\\w+|\\s+|[^\\w\\s]`) so spacing is rebuilt
    rather than guessed: the previous `\\w+|[^\\w\\s]` form destroyed every space
    touching a punctuation mark, which mangled the spacing of every Latin-script
    book for a transform that is a semantic no-op on them.
    """
    protected: Dict[str, str] = {}
    for i, m in enumerate(SML_TAG_PATTERN.finditer(text)):
        key = f'__TTS_MARKER_{i}__'
        protected[key] = m.group(0)
        text = text.replace(m.group(0), key)
    tokens = re.findall(r'\w+|\s+|[^\w\s]', text, re.UNICODE)
    buf = []
    for t in tokens:
        if t in protected:
            buf.append(t)
        elif re.match(r'^\w+$', t):
            buf.append(_romanize(t))
        else:
            buf.append(t)
    out = ''.join(buf)
    for k, v in protected.items():
        out = out.replace(k, v)
    return out


# =============================================================================
# normalize_text (core.py:3543) - the Orpheus branch
# =============================================================================

_EMOJI_PATTERN = re.compile(f"[{''.join(emojis_list)}]+", flags=re.UNICODE)


def _orpheus_switch() -> dict:
    """`punctuation_switch` with e2a's book-exact overrides for Orpheus.

    The shared table rewrites em/en dashes to '.' (forcing sentence breaks
    mid-clause) and parens to commas - both wrong for a model whose training text
    folds dashes to hyphens and keeps parentheticals verbatim.
    """
    switch = dict(punctuation_switch)
    switch['–'] = '-'
    switch['—'] = ' - '
    del switch['(']
    del switch[')']
    return switch


def normalize_text(text: str, lang: str, lang_iso1: str, tts_engine: str) -> str:
    """The Orpheus branch of e2a's `normalize_text`, transform for transform.

    A SUSPECTED BUG IS PRESERVED. The punctuation switch is applied as a
    CHARACTER CLASS built from the table's keys (`f"[{...}]"`), so the only
    multi-character key, `'...' -> '…'`, can never fire: the class matches a
    single '.', and `switch.get('.')` is absent, so the character is returned
    unchanged. Every single-character key works. Ellipses therefore reach the
    packer as literal '...' - which for Orpheus is the book-exact form anyway, so
    the bug and the intent agree here. Ported as written.
    """
    if tts_engine not in BOOK_EXACT_ENGINES:
        _refuse_engine(tts_engine, 'normalize_text')

    # Remove emojis
    text = _EMOJI_PATTERN.sub('', text)

    # Abbreviation expansion and acronym de-dotting: OFF for Orpheus.

    # Romanize foreign words (only when the language's script is latin)
    if language_entry(lang)['script'] == 'latin':
        text = foreign2latin(text, lang)

    # Multiple newlines -> a [pause]; single newlines -> a space.
    text = re.sub(r'(?:\r\n|\r|\n){2,}', f" {sml_token('pause')} ", text)
    text = re.sub(r'\r\n|\r|\n', ' ', text)

    # Punctuation that causes hallucinations
    switch = _orpheus_switch()
    pattern = f"[{''.join(map(re.escape, switch.keys()))}]"
    text = re.sub(pattern, lambda m: switch.get(m.group(), m.group()), text)

    # Remove unwanted chars
    text = text.translate(str.maketrans({ch: ' ' for ch in chars_remove}))

    # Quote handling: OFF for Orpheus (quotation marks are the cue that a span is
    # spoken dialogue, and an LLM TTS reads them natively).

    text = re.sub(r'\s+', ' ', text)

    # 'ok' -> 'Okay': OFF for Orpheus.
    # The punctuation-run collapse and its re-spacing: OFF for Orpheus
    #   (measured on Killing America: of ~1,500 insertions, 645 split a domain
    #   name, 306 a URL, 104 a scripture reference and 138 a number).
    # Letter/digit spacing: OFF for Orpheus ('1930s' must not become '1930 s').
    # Special-character words: OFF for Orpheus ('40%' stays '40%').

    return ' '.join(text.split())
