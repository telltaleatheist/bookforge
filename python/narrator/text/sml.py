"""SML - the in-band markup e2a's packer carries through the text.

Ported from ebook2audiobook@9daab0ba:
  lib/conf_models.py   TTS_SML (26), SML_UNSPOKEN_PATTERN (102),
                       SML_HEADING_PATTERN (113), sml_escape_tag (154),
                       SML_TAG_PATTERN (157)
  lib/core.py          normalize_sml_tags (3446), escape_sml (3487),
                       restore_sml (3496), sml_token (3501), sml_heading (3508),
                       sml_item (3524), _strip_escaped_sml (1860),
                       _split_sml_edges (2044), _has_escaped_sml (2063),
                       _marker_row_test (2067), _heading_row_test (2105)

WHY `regex`, NOT `re`. e2a's core.py does `import regex as re` (core.py:12), so
every pattern in the prep path was compiled by the `regex` module. `\\w` and the
alternation semantics agree with the stdlib for everything here, but the packer's
PASS 1 builds lookbehinds out of a table of abbreviations and `normalize_text`
uses `\\p{L}` / `\\p{N}` classes the stdlib cannot compile at all. Rather than
decide case by case which pattern is portable, the whole text layer uses the same
engine e2a used. `regex` is present in both Orpheus envs (measured 2026-09-04:
2026.1.15 on Windows python_env AND in WSL orpheus_tts).

THE TWO MARKERS ARE THE JUDGMENT THIS PORT MUST NOT TOUCH. `[heading]`
(2026-08-27) means "never merge this row into anything"; `[item]` (2026-09-01)
means "start a fresh pack here, and never merge this row away". Both are
NON-PAIRED and both sit on a row's LEADING edge, for the reason the e2a comment
records: a closing half never lands on the row it belongs to, because a row ENDS
at the next escaped token.
"""
from __future__ import annotations

import regex as re

#: `conf_models.TTS_SML`, verbatim. The long design comments live in e2a; what
#: matters here is the shape: `static` is the literal spelling, `paired` decides
#: whether `[/tag]` is legal.
TTS_SML = {
    'break': {'static': '[break]', 'paired': False},
    'pause': {'static': '[pause]', 'paired': False},
    'voice': {'paired': True},
    'heading': {'static': '[heading]', 'paired': False},
    'item': {'static': '[item]', 'paired': False},
}

#: The tags no engine ever SPEAKS, as ONE pattern (conf_models.py:88). Used by
#: the VTT builder and the m4b chapter-title sanitizer, both of which live
#: outside this column; re-exported here so there is one spelling in narrator.
SML_UNSPOKEN_PATTERN = re.compile(
    r'\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]',
    re.IGNORECASE,
)

#: "This row is a section heading", asked of text that still carries its markers.
#: Matches ANYWHERE in the row, because `get_sentences` emits rows like
#: `[break][heading]Chapter 8.` where a carried-over `[break]` holds position 0.
SML_HEADING_PATTERN = re.compile(r'\[/?heading\]', re.IGNORECASE)

#: `escape_sml` replaces each tag with ONE character at this offset. A character
#: with `ord(c) >= sml_escape_tag` IS an escaped tag, everywhere in the packer.
sml_escape_tag = 0xE000

_sml_tag_keys = '|'.join(map(re.escape, TTS_SML.keys()))

SML_TAG_PATTERN = re.compile(
    rf'''
    \[
        \s*
        (?P<close>/)?
        \s*
        (?P<tag>{_sml_tag_keys})
        (?:\s*:\s*(?P<value>.*?))?
        \s*
    \]
    ''',
    re.VERBOSE | re.DOTALL,
)


# =============================================================================
# Emitting tags (core.py:3501-3541)
# =============================================================================

def sml_token(tag: str, value: str | None = None, close: bool = False) -> str:
    if close:
        return f'[/{tag}]'
    if value is not None:
        return f'[{tag}:{value}]'
    return f'[{tag}]'


def sml_heading(title: str) -> str:
    """Mark a row as a section heading (2026-08-27).

    A PREFIX, deliberately. The title arrives already terminated - the caller adds
    the period that makes TTS stop - so this only prefixes the marker, and
    `_close_block`'s `last[-1].isalnum()` test still sees the row's own last
    character.
    """
    return f"{sml_token('heading')}{title}"


def sml_item(text: str) -> str:
    """Mark a row as the START of a list item (2026-09-01).

    A PREFIX for the same reason as `sml_heading`, and applied to the item's FIRST
    text only: the rest of the item is plain, token-free rows, and being token-free
    is what keeps them inside the item's pack.
    """
    return f"{sml_token('item')}{text}"


# =============================================================================
# Normalizing, escaping, restoring (core.py:3446-3499)
# =============================================================================

def normalize_sml_tags(text: str) -> tuple[bool, str]:
    """Rewrite every well-formed tag to its canonical spelling; refuse a malformed
    one. Returns `(True, text)` or `(False, error message)` - e2a's shape, kept so
    the caller's branch is the same branch.
    """
    out = []
    stack = []
    last = 0
    for m in SML_TAG_PATTERN.finditer(text):
        start, end = m.span()
        out.append(text[last:start])
        tag = m.group('tag')
        close = bool(m.group('close'))
        value = m.group('value')
        info = TTS_SML.get(tag)
        if not info:
            out.append(m.group(0))
            last = end
            continue
        if info.get('paired'):
            if close:
                if not stack or stack[-1] != tag:
                    return False, (f'normalize_sml_tags() error: unmatched closing '
                                   f'tag [/{tag}]')
                stack.pop()
                out.append(f'[/{tag}]')
            else:
                stack.append(tag)
                if value is not None:
                    out.append(f'[{tag}:{value.strip()}]')
                else:
                    return False, (f'normalize_sml_tags() error: paired tag [{tag}] '
                                   f'requires a value')
        else:
            if close:
                return False, (f'normalize_sml_tags() error: non-paired tag [/{tag}] '
                               f'is invalid')
            out.append(info['static'])
        last = end
    out.append(text[last:])
    if stack:
        return False, (f"normalize_sml_tags() error: unclosed tag(s): "
                       f"{', '.join(stack)}")
    return True, ''.join(out)


def escape_sml(text: str) -> tuple[str, list[str]]:
    """Replace each tag with ONE character, and return the block table.

    The table's INDEX is the escaped character's whole identity - that is why
    `sml_blocks` has to travel with the text into the packer, and why
    `_marker_row_test` can only be built once the table exists.
    """
    sml_blocks: list[str] = []

    def replace(m: re.Match) -> str:
        sml_blocks.append(m.group(0))
        return chr(sml_escape_tag + len(sml_blocks) - 1)

    return SML_TAG_PATTERN.sub(replace, text), sml_blocks


def restore_sml(text: str, sml_blocks: list[str]) -> str:
    """Put the tags back. e2a walks the WHOLE table for every sentence
    (`[restore_sml(s, sml_blocks) for s in sentences]`), which is quadratic in
    (blocks x sentences); kept as written, because narrowing it to the characters
    actually present is an optimization and this is a port.
    """
    for i, block in enumerate(sml_blocks):
        text = text.replace(chr(sml_escape_tag + i), block)
    return text


# =============================================================================
# Asking questions of an escaped row (core.py:1861-2108)
# =============================================================================

def strip_escaped_sml(s: str) -> str:
    """`_strip_escaped_sml`: the row with its escaped tokens removed."""
    return ''.join(c for c in s if ord(c) < sml_escape_tag)


def has_escaped_sml(s: str) -> bool:
    """`_has_escaped_sml`."""
    return any(ord(c) >= sml_escape_tag for c in s)


def split_sml_edges(row: str) -> tuple[str, str, str]:
    """`_split_sml_edges`: (leading tokens, plain core, trailing tokens).

    The core is returned VERBATIM, mid-row tokens included, so callers can refuse
    it: only a row's leading and trailing tokens are ever realized as silence, and
    a token left mid-row is stripped before TTS with its pause silently discarded.
    """
    i, j = 0, len(row)
    while i < j and (row[i].isspace() or ord(row[i]) >= sml_escape_tag):
        i += 1
    while j > i and (row[j - 1].isspace() or ord(row[j - 1]) >= sml_escape_tag):
        j -= 1
    lead = ''.join(c for c in row[:i] if ord(c) >= sml_escape_tag)
    trail = ''.join(c for c in row[j:] if ord(c) >= sml_escape_tag)
    return lead, row[i:j].strip(), trail


def marker_row_test(sml_blocks: list[str], tag: str):
    """`_marker_row_test`: THE predicate every merge pass asks before it glues a
    row to a neighbour - "does this row carry the <tag> marker?".

    ONE predicate per marker, built once per chapter and passed to all three merge
    passes. The whole row is searched rather than just its lead, so a row that
    carries the marker anywhere is one every pass can see.
    """
    marks = set()
    for i, block in enumerate(sml_blocks):
        m = SML_TAG_PATTERN.fullmatch(block)
        if m and m.group('tag') == tag:
            marks.add(chr(sml_escape_tag + i))

    def _is_marker_row(row: str) -> bool:
        return bool(marks) and any(c in marks for c in row)

    return _is_marker_row


def heading_row_test(sml_blocks: list[str]):
    """`_heading_row_test` - the heading predicate, which this names."""
    return marker_row_test(sml_blocks, 'heading')


def static_tokens() -> set:
    """`{v['static'] for v in TTS_SML.values() if 'static' in v}` - the set
    `filter_chapter` tests a row against to know it is a bare token."""
    return {v['static'] for v in TTS_SML.values() if 'static' in v}
