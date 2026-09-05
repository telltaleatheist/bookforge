"""THE SECOND CHUNKING POLICY: a chunk is a PARAGRAPH, not a character window.

Owen's rule, `docs/NARRATOR_PLAN.md` -> "Chunking rule (2026-09-04)". This module
is a NEW POLICY, not a port and not a replacement: `text/packer.py` stays exactly
as it is and remains THE PARITY PACKER - what every session on disk was rendered
with, and what a resume of one depends on. Nothing here may change a byte of it.

    prep_session(..., chunking='e2a')        -> text/packer.py       (default)
    prep_session(..., chunking='paragraph')  -> this module

## The rule, and the measurement behind it

Chunks represent complete thoughts. Measured on the EPUBs as printed: Mutineer's
Moon 2,107 blocks, median 221 chars, p99 822, max 1,213, 23% under 100 chars
(dialogue lines; 51% of blocks start with a quote); Pokemon 689 blocks, median
263, max 1,060; McKinley 1,134 blocks, median 263, p90 774, max 1,507, 44% under
100. So a paragraph-shaped chunk is SHORTER than e2a's packed chunk about a
quarter of the time and LONGER than any Orpheus cap about one time in a hundred.

**Tier 1 - EPUB paragraphs are authoritative.** A chunk ends ONLY at a paragraph
end. Consecutive SHORT PROSE paragraphs (dialogue turns) travel together up to a
floor of ~300 characters, so a one-line chunk is not rendered as a cold start.
Scene breaks, chapter starts, headings and list items are HARD WALLS.

**Tier 2 - PDF-derived blocks are PROVISIONAL.** A block that does not end in
terminal punctuation is a fragment - a page break, a column break, a running
header - and is JOINED to the following block BEFORE any floor or wall logic
runs: reconstruct the thought first, then chunk. This runs ONLY for a
PDF-derived source; an EPUB-native book is tier 1 only, and a book whose
provenance is unknown is REFUSED rather than guessed.

## What is a wall, and what the floor is NOT for

Owen, same day: *short blocks that are complete, separate thoughts are not
merged.* A list item is the example - each `[item]` is read on its own and is
never joined to its neighbours for context, which is the 2026-08-29 item rule and
it stands. So:

  - a HEADING is its own chunk and a wall, carrying `[heading]` as today;
  - a LIST ITEM is its own chunk and a wall, carrying `[item]` as today;
  - a TABLE ROW is its own chunk and a wall, carrying `[item]` (2026-09-05,
    `docs/NARRATOR_PLAN.md` "Higgs v3 path design points" point 2). See
    "Table-like fragments" below for what one is and why it borrows `[item]`;
  - a SCENE BREAK and a CHAPTER START are walls that speak nothing;
  - the ~300-char floor applies ONLY to consecutive short PROSE/dialogue
    paragraphs, and to the fragments tier 2 has already joined.

## Table-like fragments (2026-09-05)

A table is not prose and must never be packed with it: "1933 - Chancellor"
followed by "1934 - Fuhrer" read as one paragraph is a run-on the ear cannot
parse, and a table row welded onto the sentence before it is worse. (The real
separator is an em dash - `TABLE_CELL_JOIN` - written as an escape so this
module is ASCII on disk. The text it produces is not.) Two independent
detectors, because tables reach this module by two roads:

  MARKUP LINEAGE (authoritative, `extract_blocks`). A `<table>` becomes one
  TABLE block per `<tr>`, built with ebook2audiobook's own cell recipe
  (core.py:1461-1481 at 9daab0ba): the first row supplies the headers, each
  later row becomes `header: cell` pairs joined by `TABLE_CELL_JOIN`, or the
  cells joined by it when the widths disagree. narrator's only change is that each ROW is
  its own block - e2a appended the same lines into the running text and the
  character-window packer then packed several of them into one generation, which
  is precisely what point 2 forbids.

  TEXT SHAPE (`looks_table_like`, applied to PARAGRAPH blocks by
  `classify_table_blocks`). A block list that did NOT come from an EPUB - a
  PDF-derived conversion, where the layout model emits a table as plain blocks -
  carries the table only in its shape: cells separated by tabs, by a run of two
  or more spaces, or by a pipe, most of them short or numeric; or a short line
  that is mostly numbers with no sentence in it. The rule is deliberately narrow
  and every number in it is a named constant, because a false positive costs a
  paragraph of prose read as a table row and a false negative costs nothing that
  was not already broken.

THE MARKER IS `[item]`, NOT A NEW `[table]`. `TTS_SML` has five tags and
`SML_UNSPOKEN_PATTERN` strips seven names; a `[table]` marker is in neither, so
the engine would READ IT ALOUD and the VTT would print it. `[item]` already
means exactly what a table row needs - "this row is its own generation and never
merges with its neighbours" (2026-09-01) - so a table row is an item, and
`manifest.py` classifies it as one. Inventing a token would mean changing the
SML vocabulary in e2a, in narrator, in the VTT builder and in every session on
disk; borrowing the one whose meaning already fits costs nothing.

## Markers are unchanged, deliberately

`[heading]`, `[item]` and `[break]` are emitted exactly where `text/packer.py`
emits them, on a row's LEADING edge, so every downstream rule is untouched: the
engine prompt strips them through `SML_UNSPOKEN_PATTERN`, `vtt_cue_text` writes a
`[heading]` cue bold, and `manifest.py` classifies a chunk by the same test. A
merge drops the join's tokens and counts them - the same ratified trade-off the
parity packer makes, for the same reason (a token buried mid-row is stripped
before TTS and its pause is lost either way).

## The Budget seam

`budget` is `engine/protocol.py`'s `Budget` Protocol: `max_chars(voice)`,
`max_chars_per_sec(voice)`, `max_total_tokens(prompt_tokens, voice)`. It is
imported under `TYPE_CHECKING` ONLY and duck-typed at runtime, so this module
never imports `narrator.engine` - that package is being refactored by another
builder, and a `Protocol` exists precisely so a consumer need not import the
producer. Every number comes from the budget; there is no cap constant in this
file. For Higgs v3 the catalog's measured `max_chars` (600 is the zero-shot
PLACEHOLDER; the fine-tune's value is the min of the ladder length-sweep and the
corpus-derived cap = p1 training-clip seconds x chars/s) is simply what
`max_chars(voice)` returns, and at that size no paragraph in the measured corpus
is ever split.

## Sentence splitting inside an over-budget paragraph

Only ever at a SENTENCE boundary, never mid-sentence, and only when one paragraph
exceeds the budget on its own - which for Orpheus (430-520 chars) is the p99 tail
and for Higgs v3 is nothing at all. The splitter is a SECOND COPY of the parity
packer's PASS 1 pattern, because `text/packer.py` may not be edited to share it;
`tests/test_text_paragraph_packer.py` asserts the two agree, including the
abbreviation guard ('Mr. Darcy' is one sentence) and the closing-quote rule
('"Are you sure?" she said.' ends at the quote). No stanza, exactly as PASS 1
uses none.
"""
from __future__ import annotations

import os
import re as _stdlib_re  # noqa: F401  (documented below; regex is the engine used)
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable, Sequence

import regex as re

from .lang import abbreviations_mapping, punctuation_split_hard_set
from .sml import SML_UNSPOKEN_PATTERN, sml_token, strip_escaped_sml  # noqa: F401

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from ..engine.protocol import Budget


# =============================================================================
# Blocks
# =============================================================================

#: The six kinds a source block can have. `paragraph` is the only one the floor
#: may merge; the other five are walls.
PARAGRAPH = 'paragraph'
HEADING = 'heading'
ITEM = 'item'
TABLE = 'table'
SCENE_BREAK = 'scene-break'
CHAPTER_START = 'chapter-start'

BLOCK_KINDS = (PARAGRAPH, HEADING, ITEM, TABLE, SCENE_BREAK, CHAPTER_START)

#: Everything that is not a prose paragraph is a wall. Passed in rather than
#: hard-coded so a caller can narrow it (and so a test can prove each one).
DEFAULT_WALLS = frozenset({HEADING, ITEM, TABLE, SCENE_BREAK, CHAPTER_START})

#: Consecutive short PROSE paragraphs travel together up to this many characters.
#: Not a minimum chunk length: a paragraph that is already this long stands
#: alone, and a run that runs out of paragraphs before reaching it stands short.
DEFAULT_FLOOR_CHARS = 300

#: The two source shapes. Tier 2 runs for exactly one of them.
EPUB_NATIVE = 'epub-native'
PDF_DERIVED = 'pdf-derived'

#: The two chunking policies `prep_session` selects between.
CHUNKING_E2A = 'e2a'
CHUNKING_PARAGRAPH = 'paragraph'


class UnknownProvenance(RuntimeError):
    """The source's provenance could not be read, so tier 2 cannot be decided."""


@dataclass(frozen=True)
class Block:
    """One block element of the source, in reading order.

    `text` is the block's text as printed, WITHOUT markers - the packer adds
    those. `doc` and `index` are provenance for the report and the tests; nothing
    in the algorithm reads them.
    """
    text: str
    kind: str = PARAGRAPH
    doc: str = ''
    index: int = -1

    def __post_init__(self):
        if self.kind not in BLOCK_KINDS:
            raise ValueError(f'unknown block kind {self.kind!r}; '
                             f'expected one of {BLOCK_KINDS}')


@dataclass
class Chunk:
    """One generation.

    NOT `manifest.Chunk`: that one carries `file`, `samples`, `take` and a global
    index, none of which exist before a render. `prep.py` is what turns these
    into the chapter lists the session state stores.
    """
    text: str
    #: 'prose' | 'heading' | 'item' - the same three `manifest.py` classifies by.
    kind: str
    #: Indices into the block list this chunk was built from.
    blocks: tuple = ()
    #: True when this chunk is one piece of a paragraph the budget forced apart.
    sentence_split: bool = False
    #: Join tokens dropped when merging, counted the way the parity packer counts.
    dropped_join_tokens: int = 0

    @property
    def chars(self) -> int:
        """The length the budget bounds: the text the model will read."""
        return len(spoken(self.text))


@dataclass
class PackReport:
    """What the pack did, for the ear check and for `bookforge_chunking`."""
    chunks: list = field(default_factory=list)
    paragraphs_sentence_split: int = 0
    merges: int = 0
    dropped_join_tokens: int = 0
    over_budget_sentences: int = 0


def spoken(text: str) -> str:
    """The text the model gets: markers stripped, whitespace collapsed. The same
    reading `vtt_cue_text` and the engine prompt take."""
    return re.sub(r'\s+', ' ', SML_UNSPOKEN_PATTERN.sub('', text)).strip()


# =============================================================================
# Tier 2 - provisional fragments
# =============================================================================

#: A complete thought ends in a terminal mark, optionally followed by closing
#: quotes or brackets. Same closing run the parity packer's PASS 1 uses, so
#: '"Are you sure?"' counts as ended and 'the column ran out' does not.
_TERMINAL_RE = re.compile(r'[.!?…][\"\'’”»)\]]*\s*$')


def ends_a_thought(text: str) -> bool:
    """True when a block ends in terminal punctuation."""
    return bool(_TERMINAL_RE.search(text or ''))


def join_provisional_fragments(blocks: Sequence[Block]) -> list:
    """TIER 2. Join every PARAGRAPH block that does not end a thought to the
    block that follows it, before any floor or wall logic sees them.

    A PDF-derived block list is a list of what the layout model found on the
    page, so one thought routinely arrives as two or three blocks split by a page
    break, a column break or a running header. Chunking that list directly makes
    a chunk that stops mid-sentence, which is the worst thing a TTS chunk can do.

    PARAGRAPHS ONLY, and that is a reading of the spec worth stating: a HEADING
    that ends in a letter is a heading, not a fragment - the parity packer
    appends the period a heading needs for exactly that reason - and a list ITEM
    is a complete thought by Owen's refinement even when it is one word
    ('fourteen'). Joining either into the block after it would destroy the two
    rules this policy is careful to keep. A fragment that runs INTO a heading or
    an item still joins it, because the fragment is the incomplete half.

    Idempotent, and text-preserving: the joined text is the parts separated by a
    single space, so nothing is lost and nothing is invented.
    """
    out: list = []
    pending: list = []
    for block in blocks:
        if pending:
            merged_text = ' '.join(p.text for p in pending) + ' ' + block.text
            block = Block(text=merged_text, kind=pending[0].kind,
                          doc=pending[0].doc, index=pending[0].index)
            pending = []
        if block.kind == PARAGRAPH and block.text and not ends_a_thought(block.text):
            pending.append(block)
            continue
        out.append(block)
    if pending:
        # A trailing fragment with nothing to join to is emitted as it stands:
        # dropping it would lose text, and inventing a terminator would put a
        # full stop where the book has none.
        out.append(Block(text=' '.join(p.text for p in pending),
                         kind=pending[0].kind, doc=pending[0].doc,
                         index=pending[0].index))
    return out


# =============================================================================
# Table-like fragments
# =============================================================================

#: What separates two CELLS on one line when the markup is gone: a tab, a run of
#: two or more spaces (what a PDF layout model leaves between columns), or a
#: pipe. A single space is NOT a separator - that is prose.
_CELL_SPLIT_RE = re.compile('\\t+|[ \\u00a0]{2,}|\\s*\\|\\s*')

#: A cell that is "numeric": a number, a year, a percentage, a currency
#: amount, a range or a count, with the punctuation a table puts around one.
#: Written with escapes rather than literal dashes and currency signs so this
#: module stays ASCII on disk.
_NUMERIC_CELL_RE = re.compile(
    '^[\\s\\u2013\\u2014\\-+(\\[]*[$\\u00a3\\u20ac]?\\d'
    '[\\d,.\\u2013\\u2014\\-/:%\\s]*[)\\]%]?[\\s.]*$')

#: A cell at or under this many characters is "short" - a column entry rather
#: than a sentence. Twenty-four characters is about four words; the longest
#: header in the kershaw/blacksun tables measured 19.
TABLE_CELL_MAX_CHARS = 24

#: How many of a line's cells must be short-or-numeric before the line is a
#: table row. Three fifths: a two-cell line needs both, a five-cell line needs
#: three.
TABLE_CELL_FRACTION = 0.6

#: A line with no cell separators at all is still a table row when it is SHORT
#: and mostly numbers - '1933 1934 1935 1936', a column of years whose spacing
#: the extractor already collapsed. Bounded at both ends: one token is not a
#: row, and a dozen tokens is prose with figures in it.
TABLE_BARE_MIN_TOKENS = 2
TABLE_BARE_MAX_TOKENS = 12
TABLE_BARE_NUMERIC_FRACTION = 0.5


def _is_numeric_cell(cell: str) -> bool:
    return bool(_NUMERIC_CELL_RE.match(cell)) and bool(re.search(r'\d', cell))


def looks_table_like(text: str) -> bool:
    """True when a block's TEXT is a table row rather than prose.

    THE SHAPE DETECTOR, for block lists that carry no markup - a PDF-derived
    conversion, where a table arrives as ordinary blocks whose only remaining
    evidence is their layout. An EPUB's own `<table>` never needs this:
    `extract_blocks` reads the lineage and says so outright.

    Two rules, in order:

      CELLS. Split on a tab, a run of two or more spaces, or a pipe. Two or more
      cells, of which at least `TABLE_CELL_FRACTION` are short
      (<= `TABLE_CELL_MAX_CHARS`) or numeric, is a row. A single space is never
      a separator, so no ordinary sentence can reach this rule.

      BARE NUMBERS. No separators, `TABLE_BARE_MIN_TOKENS`..
      `TABLE_BARE_MAX_TOKENS` tokens, at least `TABLE_BARE_NUMERIC_FRACTION` of
      them numeric, and NO sentence-terminal punctuation. 'In 1933, 1934 and
      1935 he wrote.' fails on both the fraction and the terminator; '1933 1934
      1935 1936' passes.

    Deliberately narrow. A false positive reads a paragraph of prose as its own
    unmerged chunk (audible, wrong); a false negative leaves a table packed the
    way e2a packed it, which is the behaviour that already exists.
    """
    text = (text or '').strip()
    if not text:
        return False
    cells = [c.strip() for c in _CELL_SPLIT_RE.split(text)]
    cells = [c for c in cells if c]
    if len(cells) >= 2:
        good = sum(1 for c in cells
                   if len(c) <= TABLE_CELL_MAX_CHARS or _is_numeric_cell(c))
        return good / len(cells) >= TABLE_CELL_FRACTION
    tokens = text.split()
    if not (TABLE_BARE_MIN_TOKENS <= len(tokens) <= TABLE_BARE_MAX_TOKENS):
        return False
    if ends_a_thought(text):
        return False
    numeric = sum(1 for t in tokens if _is_numeric_cell(t))
    return numeric / len(tokens) >= TABLE_BARE_NUMERIC_FRACTION


def classify_table_blocks(blocks: Sequence[Block]) -> list:
    """Re-read every PARAGRAPH block's shape and promote the table rows.

    Runs BEFORE tier 2 in `make_chapter_chunker`, because a table row rarely
    ends in a full stop and tier 2 would otherwise weld it onto the block after
    it - reconstructing a "thought" out of two things that were never one.

    Idempotent (a TABLE block is no longer a PARAGRAPH), and it touches nothing
    else: a heading, an item, a scene break and a chapter start keep the kind
    their source gave them, whatever they look like.
    """
    out = []
    for block in blocks:
        if block.kind == PARAGRAPH and looks_table_like(block.text):
            out.append(Block(text=block.text, kind=TABLE, doc=block.doc,
                             index=block.index))
        else:
            out.append(block)
    return out


# =============================================================================
# The sentence splitter (a second copy of the parity packer's PASS 1)
# =============================================================================

def _hard_sentence_pattern():
    """PASS 1's pattern, minus the escaped-token terminator.

    `text/packer.py` builds this inside `get_sentences` and may not be edited to
    share it, so this is a deliberate second copy. It reads the SAME tables -
    `abbreviations_mapping['eng']` and `punctuation_split_hard_set` from
    `text/lang.py` - so the two cannot drift on their inputs, and
    `tests/test_text_paragraph_packer.py` asserts they agree on behaviour.

    The `tok_class` terminator is dropped because a block's text carries no
    escaped SML: markers are added by the packer AFTER splitting, on a chunk's
    leading edge.
    """
    stems = set()
    for k in abbreviations_mapping.get('eng', {}):
        stem = (k[:-1] if k.endswith('.') else k).split('.')[-1].strip()
        if len(stem) >= 2:
            stems.add(stem)
    guards = ''.join(f'(?<!\\b{re.escape(s)})' for s in sorted(stems))
    guarded_dot = rf'(?<!\b[A-Za-z]){guards}\.'
    others = [re.escape(p) for p in punctuation_split_hard_set if p != '.']
    closing_run = r'["\'’”»)\]]*'
    return re.compile(
        rf"(?:{'|'.join([guarded_dot] + others)}){closing_run}(?=\s|$)",
        re.DOTALL,
    )


_HARD_SENTENCE_RE = _hard_sentence_pattern()


def split_sentences(text: str) -> list:
    """One paragraph -> its sentences, at PASS 1's boundaries.

    Never splits inside an abbreviation ('Mr. Darcy' is one sentence) and always
    splits AFTER a closing quote ('"Are you sure?" she said.' ends at the quote,
    not at the '?'). Text-preserving: the pieces rejoin to the input's own words.
    """
    pieces, last = [], 0
    for m in _HARD_SENTENCE_RE.finditer(text):
        piece = text[last:m.end()].strip()
        if piece:
            pieces.append(piece)
        last = m.end()
    tail = text[last:].strip()
    if tail:
        pieces.append(tail)
    return pieces or ([text.strip()] if text.strip() else [])


# =============================================================================
# Tier 1 - the pack
# =============================================================================

def effective_cap(budget, voice=None, audio_budget_s: float | None = None) -> int:
    """The largest chunk this pack may build, entirely from the Budget.

    `max_chars(voice)` is the cap. When `audio_budget_s` is given - Orpheus's
    44 s audio window, which the ENGINE owns and the packer does not compute -
    the rate guard tightens it to `audio_budget_s * max_chars_per_sec(voice)`.

    MEASURED: for Orpheus that guard never binds today. 44 s x 22.6 ch/s = 994
    characters, and the catalog's per-voice caps are 430 (mistborn) to 540
    (thirdreich), so `max_chars` is what limits every chunk. The guard is wired
    anyway because it is the engine-agnostic half of the rule and a voice with a
    slow read would need it.
    """
    cap = int(budget.max_chars(voice))
    if cap <= 0:
        raise ValueError(f'Budget.max_chars({voice!r}) must be positive, got {cap}')
    if audio_budget_s is not None:
        rate = float(budget.max_chars_per_sec(voice))
        if rate > 0:
            cap = min(cap, int(audio_budget_s * rate))
    return cap


def _marker_for(kind: str) -> str:
    if kind == HEADING:
        return sml_token('heading')
    # A TABLE ROW carries `[item]`: see the module docstring, "THE MARKER IS
    # [item], NOT A NEW [table]". `[table]` is in neither TTS_SML nor
    # SML_UNSPOKEN_PATTERN, so the engine would speak it.
    if kind in (ITEM, TABLE):
        return sml_token('item')
    return ''


def _chunk_kind(kind: str) -> str:
    return {HEADING: 'heading', ITEM: 'item', TABLE: 'item'}.get(kind, 'prose')


def pack_paragraphs(blocks: Sequence[Block], budget, *,
                    floor_chars: int = DEFAULT_FLOOR_CHARS,
                    walls: Iterable[str] = DEFAULT_WALLS,
                    voice=None,
                    audio_budget_s: float | None = None,
                    lead_break: bool = True,
                    table_detect: bool = True) -> PackReport:
    """Tier 1. Blocks in reading order -> the chunks a render will generate.

    `blocks` must ALREADY have had `join_provisional_fragments` applied when the
    source is PDF-derived; this function does not decide provenance, because a
    pure function should not go looking for a file.

    THE MERGE RULE, exactly. Walking the paragraph run left to right, a group
    accepts the next paragraph only when ALL THREE hold:

      1. the incoming paragraph is itself SHORT (under `floor_chars`) - only
         short paragraphs travel, so a full-size thought is never swallowed into
         a run of dialogue turns in front of it;
      2. the group is still under `floor_chars` - the floor is what merging is
         FOR, not a target to overshoot;
      3. the result stays within the budget cap.

    So a 400-char paragraph stands alone; three 80-char dialogue turns become one
    240-char chunk and then accept a fourth to cross 300; and a run that ends
    before the floor is reached is emitted short, because inventing a neighbour
    is not an option.

    THE WALLS: every kind in `walls` flushes the run in progress. A heading or an
    item then becomes a chunk of its own carrying its marker; a scene break or a
    chapter start speaks nothing and emits no chunk - it exists to stop the merge
    reaching across it.

    OVER-BUDGET PARAGRAPHS are split at sentence boundaries and NEVER mid-
    sentence. A single sentence longer than the cap is emitted whole and counted
    in `over_budget_sentences`: splitting it would break the one rule this policy
    exists to keep, and the engine's own guards are what catch it.

    `table_detect` (default on) runs `classify_table_blocks` first, so a caller
    that hands this function a raw block list still gets the table rule. It is
    idempotent with `make_chapter_chunker`, which runs the same pass earlier -
    before tier 2, where it has to be. Pass False only to measure the rule's
    effect against its absence.
    """
    walls = frozenset(walls)
    if table_detect:
        blocks = classify_table_blocks(blocks)
    if PARAGRAPH in walls:
        raise ValueError('paragraph cannot be a wall: nothing would ever merge')
    if floor_chars < 0:
        raise ValueError(f'floor_chars must be >= 0, got {floor_chars}')
    cap = effective_cap(budget, voice, audio_budget_s)

    report = PackReport()
    run: list = []

    def emit_prose(group: list) -> None:
        """One group of merged paragraphs -> one or more chunks."""
        text = ' '.join(b.text.strip() for b in group if b.text.strip())
        if not text:
            return
        indices = tuple(b.index for b in group)
        lead = sml_token('break') if lead_break else ''
        # Every join past the first drops the boundary token that would have sat
        # between the two paragraphs - counted, never carried, because a token in
        # the middle of a row is stripped before TTS anyway.
        dropped = max(0, len(group) - 1) if lead_break else 0
        if len(group) > 1:
            report.merges += 1
        report.dropped_join_tokens += dropped

        if len(spoken(text)) <= cap:
            report.chunks.append(Chunk(text=f'{lead}{text}', kind='prose',
                                       blocks=indices,
                                       dropped_join_tokens=dropped))
            return

        # Over budget: sentence-split, greedily filling to the cap.
        report.paragraphs_sentence_split += 1
        pieces = split_sentences(text)
        parts: list = []
        for piece in pieces:
            if parts and len(spoken(parts[-1])) + 1 + len(spoken(piece)) <= cap:
                parts[-1] = parts[-1] + ' ' + piece
            else:
                parts.append(piece)
        for n, part in enumerate(parts):
            if len(spoken(part)) > cap:
                report.over_budget_sentences += 1
                print(f'pack_paragraphs: one SENTENCE is {len(spoken(part))} '
                      f'chars against a {cap}-char budget and is kept whole - '
                      f'this policy never splits mid-sentence: '
                      f'{spoken(part)[:80]!r}...')
            report.chunks.append(Chunk(
                text=f'{lead if n == 0 else ""}{part}', kind='prose',
                blocks=indices, sentence_split=True,
                dropped_join_tokens=dropped if n == 0 else 0))

    def flush() -> None:
        nonlocal run
        if not run:
            return
        group: list = []
        for block in run:
            block_len = len(spoken(block.text))
            if not group:
                group = [block]
                continue
            # ONLY SHORT PARAGRAPHS TRAVEL. A paragraph that already reaches the
            # floor on its own is a complete thought of full size: it neither
            # joins a run in front of it nor accepts one behind it. Without this
            # a 400-char paragraph following three dialogue turns was swallowed
            # into their chunk, which is the opposite of the rule.
            group_len = len(spoken(' '.join(b.text for b in group)))
            merged_len = len(spoken(' '.join(b.text for b in group + [block])))
            if (block_len < floor_chars and group_len < floor_chars
                    and merged_len <= cap):
                group.append(block)
                continue
            emit_prose(group)
            group = [block]
        if group:
            emit_prose(group)
        run = []

    for block in blocks:
        if block.kind in walls:
            flush()
            if block.kind in (HEADING, ITEM, TABLE) and block.text.strip():
                marker = _marker_for(block.kind)
                lead = sml_token('break') if lead_break else ''
                report.chunks.append(Chunk(
                    text=f'{lead}{marker}{block.text.strip()}',
                    kind=_chunk_kind(block.kind), blocks=(block.index,)))
            continue
        run.append(block)
    flush()
    return report


# =============================================================================
# Extracting blocks from an EPUB document
# =============================================================================

_HEADING_TAGS = {f'h{i}' for i in range(1, 7)}
_PARAGRAPH_TAGS = {'p', 'div', 'blockquote', 'pre'}

#: What e2a puts between two cells of one row (core.py:1474/1476 at 9daab0ba):
#: an em dash with a space either side. Spelled as an escape so this module is
#: ASCII on disk; the text it produces is not.
TABLE_CELL_JOIN = ' — '


def table_rows(table) -> list:
    """One `<table>` element -> one spoken line per DATA row.

    Ported from ebook2audiobook@9daab0ba lib/core.py:1461-1481, cell recipe
    unchanged: the FIRST row supplies the headers and speaks no line of its own,
    and every later row becomes `header: cell` pairs joined by an em dash, or -
    when the row's width does not match the header's, or there are no headers -
    the cells joined by the same dash. A row with no `<td>` at all is skipped,
    exactly as e2a skips it.

    THE ONE CHANGE narrator makes is structural, not textual: e2a appended these
    lines into the running text of the chapter and let the character-window
    packer pack several of them into one generation. Here each line is its own
    BLOCK, so each becomes its own chunk - `docs/NARRATOR_PLAN.md` "Higgs v3
    path design points" point 2.
    """
    rows = table.find_all('tr')
    if not rows:
        return []
    headers = [c.get_text(strip=True) for c in rows[0].find_all(['td', 'th'])]
    lines = []
    for row in rows[1:]:
        cells = [c.get_text(strip=True).replace('\xa0', ' ')
                 for c in row.find_all('td')]
        if not cells:
            continue
        if len(cells) == len(headers) and headers:
            line = TABLE_CELL_JOIN.join(f'{h}: {c}'
                                        for h, c in zip(headers, cells))
        else:
            line = TABLE_CELL_JOIN.join(cells)
        line = line.strip()
        if line:
            lines.append(line)
    return lines


def extract_blocks(doc, doc_name: str = '', start_index: int = 0) -> list:
    """One spine document -> its blocks, in reading order.

    A DIFFERENT WALK FROM `chapters.filter_chapter`, and deliberately so: that
    one flattens markup into ROWS for a character-window packer, resolving
    whitespace fidelity, drop caps and inline separators. This policy wants the
    document's own BLOCK STRUCTURE, which is the thing the rule calls
    authoritative, so it walks block elements and takes each one's text whole.

      h1-h6            -> heading   (a wall, its own chunk, terminated as the
                                     parity packer terminates one)
      li               -> item      (a wall, its own chunk)
      table            -> one TABLE block per data row (a wall, its own chunk),
                          built with e2a's cell recipe - see `table_rows`
      hr               -> scene-break
      p/div/blockquote -> paragraph, or scene-break when it has no word in it
                          (a rule of asterisks, a dinkus, a decorative bullet)
      everything else  -> descended into

    A `div` that contains block children contributes nothing itself; only leaf
    blocks carry text, so a wrapper never duplicates its children.
    """
    from bs4 import NavigableString, Tag

    body = doc.get_body_content()
    html = body.decode('utf-8') if isinstance(body, bytes) else body
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    root = soup.body if soup.body is not None else soup
    for tag in soup(['script', 'style']):
        tag.decompose()

    blocks: list = []
    counter = start_index

    def block_text(tag) -> str:
        # The heading rule of `chapters.heading_text` in miniature: a <br> is a
        # word boundary, everything else joins on the markup's own whitespace.
        parts = []
        for node in tag.descendants:
            if isinstance(node, Tag):
                if node.name.lower() == 'br':
                    parts.append(' ')
                continue
            if isinstance(node, NavigableString):
                parts.append(str(node))
        return re.sub(r'\s+', ' ', ''.join(parts)).strip()

    def has_block_child(tag) -> bool:
        return any(isinstance(c, Tag)
                   and c.name.lower() in (_HEADING_TAGS | _PARAGRAPH_TAGS
                                          | {'li', 'ul', 'ol', 'table', 'hr'})
                   for c in tag.descendants)

    def walk(tag):
        nonlocal counter
        for child in tag.children:
            if not isinstance(child, Tag):
                continue
            name = child.name.lower()
            if name in _HEADING_TAGS:
                text = block_text(child)
                if text:
                    # The period a heading needs so TTS stops there - the same
                    # one `filter_chapter` appends, for the same reason.
                    if text[-1] not in '.!?…':
                        text += '.'
                    blocks.append(Block(text=text, kind=HEADING, doc=doc_name,
                                        index=counter))
                    counter += 1
                continue
            if name == 'li':
                text = block_text(child)
                inner = [c for c in child.children
                         if isinstance(c, Tag) and c.name.lower() in ('ul', 'ol')]
                if text:
                    if text[-1] not in '.!?…':
                        text += '.'
                    blocks.append(Block(text=text, kind=ITEM, doc=doc_name,
                                        index=counter))
                    counter += 1
                for nested in inner:
                    walk(nested)
                continue
            if name == 'table':
                for line in table_rows(child):
                    # The period a table row needs so TTS stops at the end of
                    # it - the same one a heading and an item get, for the same
                    # reason.
                    if line[-1] not in '.!?…':
                        line += '.'
                    blocks.append(Block(text=line, kind=TABLE, doc=doc_name,
                                        index=counter))
                    counter += 1
                continue
            if name == 'hr':
                blocks.append(Block(text='', kind=SCENE_BREAK, doc=doc_name,
                                    index=counter))
                counter += 1
                continue
            if name in _PARAGRAPH_TAGS and not has_block_child(child):
                text = block_text(child)
                if not text:
                    continue
                kind = PARAGRAPH if re.search(r'\w', text) else SCENE_BREAK
                blocks.append(Block(text='' if kind == SCENE_BREAK else text,
                                    kind=kind, doc=doc_name, index=counter))
                counter += 1
                continue
            walk(child)

    walk(root)
    return blocks


# =============================================================================
# Provenance
# =============================================================================

#: `NARRATOR_SOURCE_KIND` names the provenance when the caller already knows it
#: (the BookForge project does). Values: 'epub-native' | 'pdf-derived'.
SOURCE_KIND_ENV = 'NARRATOR_SOURCE_KIND'


def source_kind_from_env() -> str | None:
    value = (os.environ.get(SOURCE_KIND_ENV) or '').strip()
    if not value:
        return None
    if value not in (EPUB_NATIVE, PDF_DERIVED):
        raise UnknownProvenance(
            f'{SOURCE_KIND_ENV}={value!r} is not one of '
            f'{EPUB_NATIVE!r} / {PDF_DERIVED!r}')
    return value


# =============================================================================
# The chapter chunker: this policy, plugged into get_chapters' one seam
# =============================================================================

def make_chapter_chunker(budget, *, source_kind: str,
                         floor_chars: int = DEFAULT_FLOOR_CHARS,
                         walls: Iterable[str] = DEFAULT_WALLS,
                         voice=None,
                         audio_budget_s: float | None = None,
                         reports: list | None = None):
    """A callable with `filter_chapter`'s exact contract, backed by this policy.

    `get_chapters(book, ctx, chapter_chunker=make_chapter_chunker(...))` reuses
    the spine walk, the TOC identity mapping and the provenance sidecar unchanged
    - only what one document becomes changes.

    THE CONTRACT, kept literally: returns a list of chunk strings, `[]` to skip
    the document (front matter, an empty body) so it consumes no chapter and no
    TOC title, and `None` to abort the whole book. The two skip tests are
    `filter_chapter`'s own, applied to the same soup, so both policies select the
    SAME set of chapters out of a spine - which the golden run checks by
    comparing chapter counts against the parity packer.

    TIER 2 runs here, once per document, when `source_kind` is `pdf-derived`.
    `epub-native` is tier 1 only. There is no third value and no default: a
    caller that does not know the provenance must find out, because joining
    fragments in a publisher EPUB would weld a paragraph that ends without a
    full stop onto the next one, and NOT joining them in a PDF conversion leaves
    chunks that stop mid-sentence.
    """
    if source_kind not in (EPUB_NATIVE, PDF_DERIVED):
        raise UnknownProvenance(
            f'source_kind must be {EPUB_NATIVE!r} or {PDF_DERIVED!r}, got '
            f'{source_kind!r}. narrator will not guess: tier 2 (joining '
            f'provisional fragments) is right for a PDF conversion and wrong '
            f'for a publisher EPUB.')

    def chunk_document(idx: int, doc, ctx) -> list | None:
        from bs4 import BeautifulSoup

        from .chapters import EXCLUDED_EPUB_TYPES

        print(f'----------\nParsing doc {idx} (paragraph policy)')
        body_content = doc.get_body_content()
        html = (body_content.decode('utf-8') if isinstance(body_content, bytes)
                else body_content)
        soup = BeautifulSoup(html, 'html.parser')
        body = soup.body if soup.body is not None else soup
        if not body.get_text(strip=True):
            print('No body found. Skip to next doc...')
            return []
        epub_type = body.get('epub:type', '').lower()
        if not epub_type:
            section_tag = soup.find('section')
            if section_tag:
                epub_type = section_tag.get('epub:type', '').lower()
        if any(part in epub_type for part in EXCLUDED_EPUB_TYPES):
            print('No body part. Skip to next doc...')
            return []

        blocks = extract_blocks(doc, doc_name=doc.get_name())
        if not blocks:
            print('No blocks in this document. Skip to next doc...')
            return []
        # BEFORE tier 2, and that order is load-bearing: a table row rarely ends
        # in a full stop, so tier 2 would join it to the block after it and
        # weld a column entry onto a sentence.
        before_tables = sum(1 for b in blocks if b.kind == TABLE)
        blocks = classify_table_blocks(blocks)
        promoted = sum(1 for b in blocks if b.kind == TABLE) - before_tables
        if promoted:
            print(f'[tables] {promoted} block(s) promoted to table rows by shape')
        if source_kind == PDF_DERIVED:
            before = len(blocks)
            blocks = join_provisional_fragments(blocks)
            print(f'[tier 2] PDF-derived source: {before} blocks -> '
                  f'{len(blocks)} after joining provisional fragments')

        if ctx.skip_headings:
            # Same reading as `filter_chapter`: skip_headings suppresses the TEXT
            # of real h1-h6 headings. The block still exists as a WALL, so the
            # paragraphs either side of it never merge across it.
            blocks = [Block(text='', kind=CHAPTER_START, doc=b.doc, index=b.index)
                      if b.kind == HEADING else b for b in blocks]

        report = pack_paragraphs(blocks, budget, floor_chars=floor_chars,
                                 walls=walls, voice=voice,
                                 audio_budget_s=audio_budget_s)
        if reports is not None:
            reports.append(report)
        print(f'[paragraph policy] {len(blocks)} block(s) -> '
              f'{len(report.chunks)} chunk(s); {report.merges} merge(s), '
              f'{report.dropped_join_tokens} join token(s) dropped, '
              f'{report.paragraphs_sentence_split} paragraph(s) sentence-split')
        return [c.text for c in report.chunks]

    return chunk_document


# =============================================================================
# A Budget built from the catalog, never from a constant in this file
# =============================================================================

#: The per-voice speaking rate, characters of text per second of audio. BookForge
#: resolves it from the voice's catalog row the same way it resolves the cap.
#: Absent means "no rate guard", which is `Budget.max_chars_per_sec`'s own
#: documented sentinel (0 = no guard) - not a fallback value.
ORPHEUS_CHARS_PER_SEC_ENV = 'ORPHEUS_MAX_CHARS_PER_SEC'


@dataclass(frozen=True)
class CatalogBudget:
    """A `Budget` whose numbers came from the CATALOG, carried as data.

    There is no cap constant anywhere in this module: Orpheus's per-voice
    `maxChars` (430 mistborn / 500-540 thirdreich / 520 deathstalker, and it has
    moved three times in three weeks) and Higgs v3's `max_chars` (600 is the
    ZERO-SHOT PLACEHOLDER; a fine-tune's real value is the min of the ladder
    length-sweep recommendation and the corpus-derived cap = p1 training-clip
    seconds x chars/s, and will be MEASURED) are both catalog rows. Whoever
    constructs this reads them from there.

    Implements `engine/protocol.py`'s `Budget` structurally; it is not a
    subclass, because a Protocol is what lets this module never import that one.
    """
    chars: int
    chars_per_sec: float = 0.0
    audio_tokens: int = 0

    def max_chars(self, voice=None) -> int:
        return self.chars

    def max_chars_per_sec(self, voice=None) -> float:
        return self.chars_per_sec

    def max_total_tokens(self, prompt_tokens: int, voice=None) -> int:
        if self.audio_tokens <= 0:
            raise ValueError(
                'CatalogBudget was built with no audio-token cap, so '
                'max_total_tokens has no answer - construct it with '
                'audio_tokens from the catalog if a caller needs one.')
        return self.audio_tokens + prompt_tokens


def orpheus_budget_from_env() -> CatalogBudget:
    """The Orpheus budget as BookForge already injects it.

    `ORPHEUS_MAX_CHARS` is the per-voice cap the bridge resolves from
    `electron/data/orpheus-models.json` and exports at spawn
    (`parallel-tts-bridge.ts:3300-3306`); `text/packer.py:orpheus_max_chars()`
    reads the same variable with e2a's 350 default, and this reuses THAT function
    so the two policies can never disagree about the cap. The rate is optional
    and its absence means the Protocol's "no guard", not a guessed number.
    """
    from .packer import orpheus_max_chars

    raw_rate = (os.environ.get(ORPHEUS_CHARS_PER_SEC_ENV) or '').strip()
    return CatalogBudget(chars=orpheus_max_chars(),
                         chars_per_sec=float(raw_rate) if raw_rate else 0.0)


# =============================================================================
# Reading the provenance stamp out of the EPUB itself
# =============================================================================

#: The REFLOW dialect: foundry converting a working PDF through paragraph
#: reflow stamps every element it writes with these three
#: (`electron/epub-processor.ts:5097-5099`).
PROVENANCE_CATEGORY_ATTR = 'data-bf-category'
PROVENANCE_GROUP_ATTR = 'data-bf-group'
PROVENANCE_BLOCKS_ATTR = 'data-bf-blocks'

#: The VISION-MODEL dialect: `foundry vlm-convert` / dots.ocr reading page
#: images, no working PDF (`electron/epub-processor.ts:5310-5311`). The trailing
#: quote in the test is deliberate and is BookForge's own: `data-bf-category="`
#: shares the first eleven characters, so testing the bare name would call every
#: reflow book a conversion (`epubCarriesConversionStamps`, `:5352-5365`).
CONVERSION_CATEGORY_ATTR = 'data-bf-cat'
CONVERSION_PAGE_ATTR = 'data-bf-page'


def detect_source_kind(epub_book) -> str:
    """`epub-native` or `pdf-derived`, read from the book's own markup.

    This is `categoriesBranchOf` (`electron/epub-processor.ts:6483-6533`) with
    its three internal branches collapsed to the two this policy needs:

        epubCarriesProvenance()        -> data-bf-category anywhere  -> PDF
        epubCarriesConversionStamps() -> data-bf-cat="   anywhere    -> PDF
        neither                                                      -> native

    THE STAMP IS IN THE XHTML, NOT THE OPF. BookForge writes no provenance
    metadata into the package document at all - the only `<meta>` its EPUB
    writers emit is `dcterms:modified` - so there is nothing to read there and
    a `dc:source` check would always come back empty. The attributes are stamped
    by the `foundry` emitter, which lives outside the BookForge checkout, on the
    OUTERMOST element of each group; a whole-spine substring test is what
    BookForge itself uses and it is what this does.

    ABSENCE IS AN ANSWER, NOT A GUESS. `epub-processor.ts:5113-5116` says it
    outright - "False is a different INPUT CLASS (a book from elsewhere), not a
    failure" - and an unstamped book is then read from its own typesetting tags,
    "the book's own statement and never a guess". So a publisher EPUB reports
    `epub-native` and gets tier 1 only, which is exactly the rule. What narrator
    refuses to guess is a source it cannot inspect at all: see
    `make_chapter_chunker`, which takes the answer and will not default it.
    """
    import ebooklib

    spine_ids = {item[0] for item in epub_book.spine}
    for item in epub_book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        if item.id not in spine_ids:
            continue
        content = item.get_content()
        text = content.decode('utf-8', 'replace') if isinstance(content, bytes) \
            else str(content)
        if PROVENANCE_CATEGORY_ATTR in text:
            return PDF_DERIVED
        if f'{CONVERSION_CATEGORY_ATTR}="' in text:
            return PDF_DERIVED
    return EPUB_NATIVE


def resolve_source_kind(epub_book) -> str:
    """The provenance to chunk by: the explicit override, else the book's stamp.

    `NARRATOR_SOURCE_KIND` exists because the BookForge project already knows the
    answer (its manifest records which passes ran) and an operator re-preparing a
    hand-edited book may need to say so. Unset, the book is asked.
    """
    override = source_kind_from_env()
    if override:
        print(f'[provenance] {SOURCE_KIND_ENV}={override} (explicit override)')
        return override
    kind = detect_source_kind(epub_book)
    print(f'[provenance] {kind} (read from the book: '
          f'{PROVENANCE_CATEGORY_ATTR} / {CONVERSION_CATEGORY_ATTR})')
    return kind
