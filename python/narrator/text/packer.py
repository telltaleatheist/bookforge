"""THE PACKER: one chapter's flat text -> the generation chunks stored in
`session-state.json`'s `chapter_sentences`.

Ported from ebook2audiobook@9daab0ba, lib/core.py:
  _normalize_for_dup (1725)          _is_near_duplicate (1733)
  _split_into_sentences_for_dup (1759)  _twin_anchor_grams (1772)
  _split_intra_twin (1785)           _split_near_dup_chunk (1816)
  _apply_near_dup_split (1850)       _has_word_chars (1864)
  _drop_wordless_rows (1875)         _sentence_min_chars (1926)
  _heading_min_words (1938)          _word_count (1954)
  _merge_short_headings_forward (1962)  _apply_min_chars_floor (2110)
  get_sentences (2277)

THIS IS THE ONE MODULE THE PLAN CALLS A JUDGMENT ("The packer is the one piece
whose 'parity' is partly a judgment (2026-08-27 headings, 2026-08-29 list items,
min-chars floor); keep it last" - docs/NARRATOR_PLAN.md, Risks). Nothing here is
re-tuned. Every threshold, every ordering and every logged sentence is the one
e2a ships; where a decision looks arbitrary, the e2a comment explaining it has
been carried across with it, because the comment IS the record of the
measurement that set it.

Six passes, in order:

  PASS 1  hard punctuation, with the Orpheus abbreviation guard and the
          "a row also ends immediately before a token" terminator
  PASS 2  soft punctuation, for rows still over the cap
  PASS 3  space split, last resort
  PASS 4  merge very short rows (boundary-aware)
  PASS 5  the Orpheus pack: balanced grouping into runs, headings unpackable,
          each <li> its own run
  PASS 6  the repetition-primed split (anti-runaway)

and, between 5 and 6, `_apply_min_chars_floor`, which itself runs
`_drop_wordless_rows` and `_merge_short_headings_forward` first.

ENGINE SCOPE. e2a's `get_sentences` carries three tails: an ideogram path
(zho/jpn/kor/tha/lao/mya/khm), a Voxtral packer and the Orpheus packer. narrator
renders Orpheus and e2a's own Orpheus branch refuses any language but English, so
only the Orpheus tail is reachable and only it is ported; the other two are
refused by name. See PORT_NOTES "Unexercised e2a paths".
"""
from __future__ import annotations

import difflib
import os

import regex as re

from .lang import abbreviations_mapping, language_entry, punctuation_split_hard_set, \
    punctuation_split_soft_set
from .normalize import ORPHEUS, _refuse_engine
from .sml import (
    SML_TAG_PATTERN,
    has_escaped_sml,
    heading_row_test,
    marker_row_test,
    sml_escape_tag,
    split_sml_edges,
    strip_escaped_sml,
)


# =============================================================================
# Near-duplicate / twin-anchor machinery (PASS 6's toolbox)
# =============================================================================

def _normalize_for_dup(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace - the cheap normal form
    for near-duplicate detection."""
    s = re.sub(r'[^\w\s]', ' ', s.lower())
    return re.sub(r'\s+', ' ', s).strip()


def _is_near_duplicate(a: str, b: str, threshold: float = 0.8) -> bool:
    """True when a and b are near-identical prose - the pattern that primes
    Orpheus into a repetition loop (real case: "Kershaw didn't use it in his
    book." / "Trevor-Roper didn't use it in his book.").

    Both sides must be >= 4 words and within a [0.6, 1.67] length ratio before the
    pricier SequenceMatcher ratio is computed. The ratio is over the WORD
    sequences, not the raw char stream: the real primer differs only by a subject
    name, and a different-length name prefix drags a char-level ratio under 0.8
    even though the sentences are clearly the same template.
    """
    wa, wb = _normalize_for_dup(a).split(), _normalize_for_dup(b).split()
    if len(wa) < 4 or len(wb) < 4:
        return False
    la, lb = len(wa), len(wb)
    if min(la, lb) / max(la, lb) < 0.6:
        return False
    return difflib.SequenceMatcher(None, wa, wb).ratio() >= threshold


def _split_into_sentences_for_dup(text: str) -> list:
    """Split a packed chunk back into its component sentences. Mirrors the
    boundary `_split_to_cap` uses (terminal .!?... plus trailing quotes/brackets).
    """
    parts, last = [], 0
    for m in re.finditer(r'[.!?…]["\'”’)\]]*\s+', text):
        parts.append(text[last:m.end()].strip())
        last = m.end()
    if last < len(text):
        parts.append(text[last:].strip())
    return [p for p in parts if p]


def _twin_anchor_grams(s: str) -> set:
    """The qualifying 4-grams of a sentence: 4 consecutive normalized words
    totalling >= 14 chars. Two copies inside one generation are a TWIN ANCHOR -
    attention resolves to the wrong copy and silently deletes the words between -
    while stock collocations ('at the end of') stay below the length bar."""
    w = _normalize_for_dup(s).split()
    return {tuple(w[i:i + 4]) for i in range(len(w) - 3)
            if sum(len(t) for t in w[i:i + 4]) >= 14}


def _split_intra_twin(sent: str) -> list:
    """Split ONE sentence containing the same qualifying 4-gram twice, at a
    comma/semicolon/dash between the copies. Each piece must keep its own copy of
    the anchor and be >= 25 chars, else the sentence is returned unsplit."""
    grams = _twin_anchor_grams(sent)
    words = _normalize_for_dup(sent).split()
    twin = None
    seen = {}
    for i in range(len(words) - 3):
        g = tuple(words[i:i + 4])
        if g not in grams:
            continue
        if g in seen and i - seen[g] >= 4:
            twin = g
            break
        seen.setdefault(g, i)
    if twin is None:
        return [sent]
    phrase = ' '.join(twin)
    for m in re.finditer(r'[,;—–]\s+', sent):
        left, right = sent[:m.end()].strip(), sent[m.end():].strip()
        if len(left) < 25 or len(right) < 25:
            continue
        if phrase in _normalize_for_dup(left) and phrase in _normalize_for_dup(right):
            return [left] + _split_intra_twin(right)
    return [sent]


def _split_near_dup_chunk(chunk: str) -> list:
    """Split one packed chunk so no single generation contains a repetition
    primer. Returns `[chunk]` UNCHANGED (exact original text) when nothing splits,
    so non-repetitive prose keeps its packing boundaries byte for byte."""
    sents = _split_into_sentences_for_dup(chunk)
    if not sents:
        return [chunk]
    pieces = []
    for s in sents:
        pieces.extend(_split_intra_twin(s))
    if len(pieces) < 2:
        return [chunk]
    groups = [[pieces[0]]]
    group_grams = _twin_anchor_grams(pieces[0])
    for s in pieces[1:]:
        sg = _twin_anchor_grams(s)
        if any(_is_near_duplicate(m, s) for m in groups[-1]) or (sg & group_grams):
            groups.append([s])
            group_grams = sg
        else:
            groups[-1].append(s)
            group_grams |= sg
    if len(groups) < 2:
        return [chunk]
    return [' '.join(g) for g in groups]


def _apply_near_dup_split(chunks: list) -> list:
    """PASS 6. A no-op for non-repetitive prose. Splitting only ever shortens a
    chunk, so no result can exceed the budget the packer already enforced."""
    out = []
    for c in chunks:
        out.extend(_split_near_dup_chunk(c))
    return out


# =============================================================================
# Row predicates and the two knobs
# =============================================================================

def _has_word_chars(s: str) -> bool:
    """True when a row has anything to SAY: at least one word character once the
    escaped SML tokens are gone."""
    return bool(re.search(r'\w', strip_escaped_sml(s)))


def _drop_wordless_rows(rows: list, has_words) -> list:
    """Remove every row that would reach TTS as text with NO word character in it
    (2026-08-29).

    The bug this fixes: `<h2>. Silo 1 .</h2>` split at its first period, leaving
    `[heading].` as a row of its own; a heading is exempt from the floor in both
    directions, so nothing could merge it away and 30 chunks whose entire text was
    '.' were handed to Orpheus in one book.

    DROP, not merge: a row with no word character is decoration and carries no
    audio content, so merging it would only prepend orphan punctuation to a
    neighbour's prompt. This is NOT the floor's 'too short' test and it does not
    care about length. SML-ONLY rows are not touched - a bare `[break]` is a real
    pause and the engines write silence for it.
    """
    out = []
    for row in rows:
        core = split_sml_edges(row)[1]
        if core and not has_words(row):
            tokens = sum(1 for c in row if ord(c) >= sml_escape_tag)
            print(f'get_sentences() wordless row: dropped, nothing to speak, '
                  f'{tokens} pause token(s) with it: {strip_escaped_sml(core)!r}')
            continue
        out.append(row)
    return out


def _sentence_min_chars() -> int:
    """SENTENCE_MIN_CHARS overrides the 25-char default; 0 disables the pass; an
    invalid value raises (NO FALLBACK)."""
    _mn = os.environ.get('SENTENCE_MIN_CHARS')
    min_chars = int(_mn) if _mn else 25
    if min_chars < 0:
        raise ValueError(f'SENTENCE_MIN_CHARS must be >= 0, got {min_chars}')
    return min_chars


def _heading_min_words() -> int:
    """HEADING_MIN_WORDS overrides the 3-word default; 0 disables the pass; an
    invalid value raises (NO FALLBACK).

    Below this a heading is merged FORWARD into the next row (2026-08-29, Owen's
    ruling): Orpheus can fail to voice an ultra-short prompt at all, and an unread
    chapter title is worse than one that flows into its first paragraph."""
    _mw = os.environ.get('HEADING_MIN_WORDS')
    min_words = int(_mw) if _mw else 3
    if min_words < 0:
        raise ValueError(f'HEADING_MIN_WORDS must be >= 0, got {min_words}')
    return min_words


def _word_count(core: str) -> int:
    """Words in a row's core as the reader would count them."""
    return sum(1 for t in strip_escaped_sml(core).split() if re.search(r'\w', t))


def _merge_short_headings_forward(rows: list, clean_len, max_chars: int,
                                  is_heading, min_words: int) -> list:
    """Merge every heading of fewer than min_words words FORWARD into the next
    text row (2026-08-29).

    Forward, never backward: a chapter title belongs to the text UNDER it. This
    deliberately narrows the 2026-08-27 heading isolation - a title of min_words
    or more still stands alone; a shorter one trades its isolation (and its bold
    VTT cue) for the guarantee of being spoken.

    The merged row is the TARGET row with the heading's text prepended after the
    target's leading tokens, so the target's own lead pause still plays and, when
    the target is itself a heading (stacked chapter-number headings), its
    [heading] marker survives. The loop re-examines the merged row, so stacked
    short headings coalesce.

    HEADINGS ONLY, and NOT extended to [item] (2026-09-01): a demoted heading
    joins the text it already belongs to, while a demoted list item would join a
    DIFFERENT item, which is the exact weld [item] exists to forbid.
    """
    if min_words <= 0:
        return rows
    out = list(rows)
    i = 0
    while i < len(out):
        if not is_heading(out[i]):
            i += 1
            continue
        lead, core, trail = split_sml_edges(out[i])
        if not core or _word_count(core) >= min_words:
            i += 1
            continue
        j = i + 1
        while j < len(out) and not split_sml_edges(out[j])[1]:
            j += 1
        if j >= len(out):
            print(f'get_sentences() short-heading merge: no following text in this '
                  f'chapter, heading kept: {strip_escaped_sml(core)!r}')
            i += 1
            continue
        t_lead, t_core, t_trail = split_sml_edges(out[j])
        merged = f'{t_lead}{core} {t_core}{t_trail}'
        if clean_len(merged) > max_chars:
            print(f'get_sentences() short-heading merge: merge would break '
                  f'max_chars, heading kept: {strip_escaped_sml(core)!r}')
            i += 1
            continue
        dropped = len(lead) + len(trail) + sum(
            len(split_sml_edges(r)[0]) + len(split_sml_edges(r)[2])
            for r in out[i + 1:j]
        )
        out[i:j + 1] = [merged]
        print(f'get_sentences() short-heading merge: merged {_word_count(core)}-word '
              f'heading forward, {dropped} join pause token(s) dropped: '
              f'{strip_escaped_sml(core)!r}')
        # No i += 1: the merged row may itself be a still-short heading.
    return out


def _apply_min_chars_floor(rows: list, clean_len, max_chars: int, min_chars: int,
                           is_heading, is_item, has_words) -> list:
    """Merge every row whose engine-read text is shorter than min_chars into a
    neighbour. FORWARD first; BACKWARD only when the forward merge would break
    max_chars.

    HEADINGS ARE EXEMPT, IN BOTH DIRECTIONS (2026-08-27), and the exemption
    IGNORES LENGTH - a two-character heading still stands alone. This pass was the
    main reason headers used to be spoken as part of the paragraph under them.

    LIST ITEMS ARE EXEMPT ON THE SAME TERMS (2026-09-01, Owen's ruling), also
    regardless of length. Unlike headings there is NO word-count narrowing.

    THE EXEMPTION IS FOR ROWS WITH WORDS IN THEM (2026-08-29):
    `_drop_wordless_rows` runs FIRST, so no row is still wordless when either
    exemption is consulted. That ORDER is the fix - the exemption made a wordless
    heading unmergeable, which is how 30 chunks reading '.' shipped in one book.

    RATIFIED TRADE-OFF: the SML tokens sitting AT THE JOIN are DROPPED and the
    pause they encode is lost. They cannot be carried - a token in the middle of a
    row is stripped before TTS anyway - so keeping it would lose the same pause
    while hiding the loss. Every dropped join is logged.
    """
    # BEFORE the early return: a wordless row must never ship even when the length
    # floor is switched off (SENTENCE_MIN_CHARS=0). The two rules are independent.
    rows = _drop_wordless_rows(rows, has_words)
    # Also before the early return, and reading its own knob.
    rows = _merge_short_headings_forward(rows, clean_len, max_chars, is_heading,
                                         _heading_min_words())
    if min_chars <= 0:
        return rows
    out = list(rows)
    i = 0
    while i < len(out):
        lead, core, trail = split_sml_edges(out[i])
        if is_heading(out[i]) or is_item(out[i]):
            # A SHORT ITEM ROW MAY STILL GATHER ITS OWN NEXT SENTENCE
            # (2026-09-01). The row that is safe to gather is recognisable by
            # shape: it is the IMMEDIATELY following row and it carries NO token
            # at all, because the next item and the prose after the list always
            # open on a [break]. A merge WITHIN one item, never between items.
            if (is_item(out[i]) and not is_heading(out[i]) and core
                    and clean_len(out[i]) < min_chars and i + 1 < len(out)
                    and not has_escaped_sml(out[i + 1])
                    and not is_heading(out[i + 1]) and not is_item(out[i + 1])):
                merged = f'{lead}{core} {out[i + 1].strip()}'
                if clean_len(merged) <= max_chars:
                    out[i:i + 2] = [merged]
                    print(f'get_sentences() min-chars floor: short list item '
                          f'gathered its own next sentence: '
                          f'{strip_escaped_sml(core)!r}')
                    continue
            if core and clean_len(out[i]) < min_chars:
                kind = 'heading' if is_heading(out[i]) else 'list item'
                print(f'get_sentences() min-chars floor: {kind} kept as its own '
                      f'row: {strip_escaped_sml(core)!r}')
            i += 1
            continue
        if not core or clean_len(out[i]) >= min_chars:
            i += 1
            continue
        if has_escaped_sml(core):
            print(f'get_sentences() min-chars floor: mid-row SML token, cannot '
                  f'merge short row: {strip_escaped_sml(out[i])!r}')
            i += 1
            continue
        # FORWARD - the next row carrying text; every row stepped over is SML-only
        # and is consumed as join fuel.
        j = i + 1
        while j < len(out) and not split_sml_edges(out[j])[1]:
            j += 1
        if j < len(out):
            next_lead, next_core, next_trail = split_sml_edges(out[j])
            # Never merge a short row INTO a heading (the header would stop being
            # the chunk's whole content) nor into a list ITEM (the row in front of
            # a list is the prose the list belongs to).
            if (not has_escaped_sml(next_core) and not is_heading(out[j])
                    and not is_item(out[j])):
                merged = f'{lead}{core} {next_core}{next_trail}'
                if clean_len(merged) <= max_chars:
                    dropped = len(trail) + len(next_lead) + sum(
                        len(split_sml_edges(r)[0]) + len(split_sml_edges(r)[2])
                        for r in out[i + 1:j]
                    )
                    out[i:j + 1] = [merged]
                    print(f'get_sentences() min-chars floor: merged short row '
                          f'forward, {dropped} join pause token(s) dropped: '
                          f'{strip_escaped_sml(core)!r}')
                    continue
        # BACKWARD - symmetric.
        k = i - 1
        while k >= 0 and not split_sml_edges(out[k])[1]:
            k -= 1
        if k >= 0:
            prev_lead, prev_core, prev_trail = split_sml_edges(out[k])
            if (not has_escaped_sml(prev_core) and not is_heading(out[k])
                    and not is_item(out[k])):
                merged = f'{prev_lead}{prev_core} {core}{trail}'
                if clean_len(merged) <= max_chars:
                    dropped = len(prev_trail) + len(lead) + sum(
                        len(split_sml_edges(r)[0]) + len(split_sml_edges(r)[2])
                        for r in out[k + 1:i]
                    )
                    out[k:i + 1] = [merged]
                    print(f'get_sentences() min-chars floor: merged short row '
                          f'backward, {dropped} join pause token(s) dropped: '
                          f'{strip_escaped_sml(core)!r}')
                    i = k
                    continue
        print(f'get_sentences() min-chars floor: NO merge fits under {max_chars} '
              f'chars, short row kept: {strip_escaped_sml(core)!r}')
        i += 1
    return out


# =============================================================================
# get_sentences (core.py:2277)
# =============================================================================

def _split_inclusive(text: str, pattern) -> list:
    result = []
    last_end = 0
    for match in pattern.finditer(text):
        result.append(text[last_end:match.end()].strip())
        last_end = match.end()
    if last_end < len(text):
        tail = text[last_end:].strip()
        if tail:
            result.append(tail)
    return result


def orpheus_max_chars() -> int:
    """The Orpheus packing cap. ORPHEUS_MAX_CHARS overrides the 350-char default;
    an invalid value raises (NO FALLBACK).

    350 was raised from 200 on 2026-07-12 for prosody. The 200-char era was
    calibrated against rohan-v2, later PROVEN a broken training recipe (38s clips
    / max_seq_length 4096 -> 19% runaway); EOS-safe voices (<=20s/2048) went 0/126
    on the very chunks that broke it, and 450 fails everywhere. The SAME env var
    is read by `filter_chapter`'s flatten so both passes agree - BookForge injects
    it from the selected voice's declared cap
    (`parallel-tts-bridge.ts:3300-3306`).
    """
    _mc = os.environ.get('ORPHEUS_MAX_CHARS')
    return int(_mc) if _mc else 350


def get_sentences(text: str, language: str, tts_engine: str,
                  sml_blocks: list) -> list | None:
    """One chapter's escaped flat text -> its generation chunks.

    `sml_blocks` is `escape_sml`'s block table for THIS text and it comes in
    because an escaped token is otherwise an anonymous character here: the merge
    passes have to be able to ask which token a character stands for, to keep a
    section heading out of every merge (2026-08-27) and each list item in a pack
    of its own (2026-09-01).

    Returns None on a genuine failure, exactly as e2a does, because
    `filter_chapter` branches on that.

    THE SESSION IS GONE. e2a took a `session_id` and read `language`/`tts_engine`
    off the session dict; narrator passes them, because narrator's text layer owns
    no global session registry. Same two values, same use.
    """
    if tts_engine != ORPHEUS:
        _refuse_engine(tts_engine, 'get_sentences')

    def _plain(s: str) -> bool:
        """A row is 'plain prose' only when it carries NO escaped SML token. Used
        by PASS 2 and PASS 4 to refuse a merge that would BURY a token mid-row,
        where the engine strips it before TTS and its pause is silently lost.
        Compares `strip_escaped_sml` directly, NOT `clean_len`."""
        return len(strip_escaped_sml(s)) == len(s)

    try:
        lang = language
        # e2a reads the language's cap and then replaces it for Orpheus. The read
        # is kept because it is what e2a does, NOT as a refusal: an unsupported
        # language raises inside this try and is swallowed into `None` by the
        # `except` below, exactly as e2a's own `language_mapping[lang]` KeyError
        # was - which `filter_chapter` turns into one dropped chapter. The loud
        # refusal for a non-English book is `filter_chapter`'s own `lang != 'eng'`
        # test, which runs BEFORE this function is ever called.
        max_chars = language_entry(lang)['max_chars']
        max_chars = orpheus_max_chars()

        min_chars = _sentence_min_chars()

        # The structural-marker tests, shared by every merge pass below
        # (heading 2026-08-27, item 2026-09-01).
        is_heading = heading_row_test(sml_blocks)
        is_item = marker_row_test(sml_blocks, 'item')

        # THE PACKER MEASURES THE TEXT AS PRINTED, every engine (Owen,
        # 2026-09-02). The transform an Orpheus row used to be measured through is
        # permanently disabled at the engine: number normalization is BookForge's
        # model pass over the narration copy, so the rows arriving here already
        # carry the words the model gets, and printed length IS model length.
        # `tts_form` stays as the seam `clean_len` and `has_words` read through.
        def tts_form(s: str) -> str:
            return s

        def clean_len(s: str) -> int:
            return len(strip_escaped_sml(tts_form(s)))

        def has_words(s: str) -> bool:
            return _has_word_chars(tts_form(s))

        assert not SML_TAG_PATTERN.search(text)

        # A row ends at whitespace, at end of text - or at a PARAGRAPH BOUNDARY.
        # escape_sml has replaced each token with ONE char of ord >= sml_escape_tag
        # and that char is not \s, so without this a paragraph boundary became an
        # unsplittable row with the token BURIED in the middle. The range matches
        # `strip_escaped_sml`'s own test rather than assuming the tokens stay
        # inside the Private Use Area.
        tok_class = rf'[{chr(sml_escape_tag)}-\U0010FFFF]'
        row_end = rf'(?=\s|$|{tok_class})'

        # A sentence that ends inside quotes ends AT THE CLOSING QUOTE, not at the
        # mark. Without this the lookahead lands on the '"' of '"Are you sure?"',
        # refuses to break, and the row runs on THROUGH the paragraph token that
        # follows. Hard marks only: a soft mark inside quotes is mid-sentence.
        closing_run = r'["\'’”»)\]]*'

        # PASS 1 - hard punctuation.
        #
        # Abbreviations stay unexpanded for Orpheus (book-exact text), so the
        # splitter must not treat their dot as a sentence end. Guard the dot with
        # lookbehinds for the known English abbreviation stems plus any single
        # letter (initials, 'C.I.A.', 'e.g.'). Cost of the guard: a dot that ends
        # BOTH an abbreviation and a real sentence no longer splits - two
        # sentences ride one row, far lesser evil than a mid-name break.
        #
        # A ROW ALSO ENDS IMMEDIATELY BEFORE A TOKEN, punctuation or not: ONE lazy
        # scan with two terminators, so laziness picks the EARLIER of a sentence
        # end and a token. The leading `{tok_class}*` lets a row start on its own
        # token(s) without the terminator matching empty at position zero.
        stems = set()
        for k in abbreviations_mapping.get('eng', {}):
            stem = (k[:-1] if k.endswith('.') else k).split('.')[-1].strip()
            if len(stem) >= 2:
                stems.add(stem)
        guards = ''.join(f'(?<!\\b{re.escape(s)})' for s in sorted(stems))
        guarded_dot = rf'(?<!\b[A-Za-z]){guards}\.'
        others = [re.escape(p) for p in punctuation_split_hard_set if p != '.']
        hard_pattern = re.compile(
            rf"{tok_class}*.*?"
            rf"(?:(?:{'|'.join([guarded_dot] + others)}){closing_run}{row_end}"
            rf"|(?={tok_class}))",
            re.DOTALL,
        )
        hard_list = _split_inclusive(text, hard_pattern)
        if not hard_list:
            hard_list = [text.strip()]
        hard_list = [s.strip() for s in hard_list if s.strip()]

        # PASS 2 - soft punctuation
        soft_pattern = re.compile(
            rf"(.*?(?:{'|'.join(map(re.escape, punctuation_split_soft_set))}))"
            rf"{row_end}",
            re.DOTALL,
        )
        soft_list = []
        i = 0
        n = len(hard_list)
        while i < n:
            s = hard_list[i].strip()
            if not s:
                i += 1
                continue
            if i + 1 < n:
                next_s = hard_list[i + 1].strip()
                next_clean = strip_escaped_sml(next_s)
                # _plain BOTH SIDES: this mini-merge used to glue an almost-empty
                # hard row onto its predecessor on length alone, which could bury
                # a token mid-row. Token-carrying fragments now fall through to
                # the min-chars floor, which merges at the EDGES.
                if (next_clean and sum(c.isalnum() for c in next_clean) < 3
                        and _plain(s) and _plain(next_s)):
                    s = f'{s} {next_s}'
                    i += 2
                else:
                    i += 1
            else:
                i += 1
            if clean_len(s) <= max_chars:
                soft_list.append(s)
                continue
            parts = _split_inclusive(s, soft_pattern)
            if parts:
                valid = False
                for p in parts:
                    if clean_len(p.strip()) <= max_chars:
                        valid = True
                        break
                if valid:
                    soft_list.extend([p.strip() for p in parts if p.strip()])
                else:
                    soft_list.append(s)
            else:
                soft_list.append(s)

        # PASS 3 - space split (last resort)
        last_list = []
        for s in soft_list:
            s = s.strip()
            if not s:
                continue
            rest = s
            while rest:
                current_len = clean_len(rest)
                if current_len <= max_chars:
                    last_list.append(rest.strip())
                    break
                cut = rest[:max_chars + 1]
                idx = cut.rfind(' ')
                if idx > 0:
                    left = rest[:idx].strip()
                    right = rest[idx + 1:].strip()
                else:
                    left = rest[:max_chars].strip()
                    right = rest[max_chars:].strip()
                if not left or right == rest:
                    last_list.append(rest.strip())
                    break
                last_list.append(left)
                rest = right

        # PASS 4 - merge very short rows. BOUNDARY-AWARE (like PASS 5): a row
        # carrying an SML token is NEVER merged in either direction. This pass
        # used to merge purely on length, producing chunks with a mid-chunk
        # [break] whose pause was then SILENTLY discarded before TTS.
        final_list = []
        merge_max_chars = int((max_chars / 2) / 3)
        i = 0
        n = len(last_list)
        while i < n:
            cur = last_list[i].strip()
            if not cur:
                i += 1
                continue
            if i == 0:
                final_list.append(cur)
                i += 1
                continue
            cur_len = clean_len(cur)
            if cur_len <= merge_max_chars and _plain(cur):
                j = i + 1
                while j < n:
                    nxt = last_list[j].strip()
                    if not nxt:
                        j += 1
                        continue
                    if _plain(nxt) and cur_len + clean_len(nxt) <= max_chars:
                        cur = cur.rstrip() + ' ' + nxt.lstrip()
                        cur_len = clean_len(cur)
                        j += 1
                        continue
                    break
                if final_list:
                    prev = final_list[-1]
                    if _plain(prev) and clean_len(prev) + cur_len <= max_chars:
                        final_list[-1] = prev.rstrip() + ' ' + cur.lstrip()
                        i = j
                        continue
                final_list.append(cur)
                i = j
                continue
            final_list.append(cur)
            i += 1

        # PASS 5 (Orpheus) - greedily pack adjacent sentences up to max_chars so
        # each generation spans 2-3 sentences: coherent timbre/prosody across a
        # passage instead of a per-sentence "take".
        #
        # PACKS ACROSS PARAGRAPH PAUSES (2026-08-10). The join's tokens - the
        # accumulating chunk's TRAILING token and the incoming row's LEADING token
        # - are dropped and counted (one summary line per chapter). They cannot be
        # carried: only a row's leading and trailing token are realized as
        # silence, so a token buried mid-row loses its pause anyway while hiding
        # the loss. For Orpheus the auto [break] and the valueless auto [pause]
        # collapse to the SAME sentence-gap floor every chunk already gets, so a
        # dropped auto token costs no measurable silence.
        #
        # SENTENCE-COUNT CAP - OFF by default (2026-07-12). ORPHEUS_MAX_SENTENCES
        # re-imposes one for a voice that trips the guards; invalid value raises
        # (NO FALLBACK). When set it is enforced BOTH ways: the merge will not
        # pack past it, and `_split_to_cap` splits items that ARRIVE
        # multi-sentence.
        _ms = os.environ.get('ORPHEUS_MAX_SENTENCES')
        max_sents = int(_ms) if _ms else None

        def _nsent(t):
            return max(1, len(re.findall(r'[.!?…]["\'”’)\]]*(?:\s|$)', t)))

        def _group_run(run, limit):
            """Greedy grouping of one run at `limit`, returning index lists.
            `clean_len` is measured on the merged CORE: lead/trail are SML and
            contribute nothing to it."""
            groups, cur, cur_core = [], [], ''
            for i, core in enumerate(r[1] for r in run):
                if not cur:
                    cur, cur_core = [i], core
                    continue
                merged_core = cur_core.rstrip() + ' ' + core.lstrip()
                if (clean_len(merged_core) <= limit
                        and (max_sents is None
                             or _nsent(cur_core) + _nsent(core) <= max_sents)):
                    cur.append(i)
                    cur_core = merged_core
                else:
                    groups.append(cur)
                    cur, cur_core = [i], core
            if cur:
                groups.append(cur)
            return groups

        def _balanced_groups(run):
            """BALANCED, not greedy-to-the-brim (Owen, 2026-08-13). Greedy filling
            emits a starved tail: a 600-char run at a 540 cap becomes 540 + 60,
            and that 60-char chunk is its own generation with its own take.
            Balancing costs NOTHING - k is fixed by the run's total length - so
            the only question is where the boundaries fall, and even is better on
            both axes that matter: no starved take, and a lower PEAK length.

            k is what greedy needs at the real cap. Then find the SMALLEST limit
            that still fits in k; binary search is exact because feasibility is
            monotone in the limit."""
            at_cap = _group_run(run, max_chars)
            if len(at_cap) <= 1:
                return at_cap
            k = len(at_cap)
            lo = max(clean_len(r[1]) for r in run)
            hi, best = max_chars, max_chars
            while lo <= hi:
                mid = (lo + hi) // 2
                if len(_group_run(run, mid)) <= k:
                    best, hi = mid, mid - 1
                else:
                    lo = mid + 1
            return _group_run(run, best)

        # Rows as (original, edges) - edges None for a row that must never be
        # packed into (SML-only, or a token buried mid-row that a merge would have
        # to discard silently). Those break the run they sit in.
        #
        # A HEADING IS THE THIRD KIND (2026-08-27): breaking the run is exactly
        # what a header needs and it comes for free - the row is emitted alone,
        # byte for byte, and neither neighbour can reach across it.
        #
        # A LIST ITEM IS NOT A FOURTH KIND (2026-09-01): classifying it
        # `edges is None` would emit the item's FIRST row alone and strand the
        # rest of the item. An item is a RUN BOUNDARY instead.
        items = []
        for s in final_list:
            s = s.strip()
            if not s:
                continue
            lead, core, trail = split_sml_edges(s)
            items.append((s, None if (not core or has_escaped_sml(core)
                                      or is_heading(s))
                          else (lead, core, trail, s)))

        packed = []
        dropped_join_tokens = 0

        def _emit(run):
            nonlocal dropped_join_tokens
            for g in _balanced_groups(run):
                if len(g) == 1:
                    # Untouched, byte for byte. `split_sml_edges` drops the
                    # whitespace around a token, so rebuilding a row that was
                    # never merged would quietly rewrite it.
                    packed.append(run[g[0]][3])
                    continue
                lead = run[g[0]][0]
                trail = run[g[-1]][2]
                core = run[g[0]][1]
                for i in g[1:]:
                    core = core.rstrip() + ' ' + run[i][1].lstrip()
                for i in g[:-1]:
                    dropped_join_tokens += len(run[i][2])
                for i in g[1:]:
                    dropped_join_tokens += len(run[i][0])
                packed.append(f'{lead}{core}{trail}')

        # EACH <li> IS ITS OWN RUN (2026-09-01). A run is what `_emit` packs into
        # chunks, so bounding the run bounds the pack: all of ONE item's sentences
        # may share a generation, and nothing else may join them. Two rules do it,
        # both leaning on PASS 1's row shape - a row ENDS immediately before any
        # escaped token and MAY START with tokens, so the first row of an item is
        # the one carrying [item], and the item's remaining sentences are the
        # TOKEN-FREE rows that follow. Only ITEM runs are fenced this tightly;
        # ordinary prose still packs across its paragraph [break]s.
        run = []
        run_is_item = False
        for s, e in items:
            if e is None:
                if run:
                    _emit(run)
                    run = []
                run_is_item = False
                packed.append(s)
                continue
            if is_item(s) or (run_is_item and has_escaped_sml(s)):
                if run:
                    _emit(run)
                    run = []
                run_is_item = is_item(s)
            run.append(e)
        if run:
            _emit(run)
        if dropped_join_tokens:
            print(f'get_sentences() Orpheus pack: {dropped_join_tokens} join pause '
                  f'token(s) dropped packing {len(final_list)} rows into '
                  f'{len(packed)} chunks (packing > pause)')

        if max_sents is None:
            # MIN-CHARS FLOOR runs BEFORE PASS 6: anti-runaway trumps the floor,
            # so if a near-duplicate re-split breaks a floored merge back apart,
            # near-dup wins.
            return _apply_near_dup_split(
                _apply_min_chars_floor(packed, clean_len, max_chars, min_chars,
                                       is_heading, is_item, has_words)
            )

        def _split_to_cap(t):
            parts, last = [], 0
            for m in re.finditer(r'[.!?…]["\'”’)\]]*\s+', t):
                parts.append(t[last:m.end()].strip())
                last = m.end()
            if last < len(t):
                parts.append(t[last:].strip())
            parts = [p for p in parts if p]
            out = []
            for p in parts:
                if (out and _nsent(out[-1]) + _nsent(p) <= max_sents
                        and clean_len(out[-1]) + 1 + clean_len(p) <= max_chars):
                    out[-1] = out[-1] + ' ' + p
                else:
                    out.append(p)
            return out or [t]

        capped = []
        for item in packed:
            if _nsent(item) > max_sents:
                capped.extend(_split_to_cap(item))
            else:
                capped.append(item)
        return _apply_near_dup_split(
            _apply_min_chars_floor(capped, clean_len, max_chars, min_chars,
                                   is_heading, is_item, has_words)
        )
    except Exception as e:
        # e2a's own `except Exception -> None`, kept because `filter_chapter`
        # branches on None and turns it into a named, whole-run failure.
        print(f'get_sentences() error: {e}')
        return None
