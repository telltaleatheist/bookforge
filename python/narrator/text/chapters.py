"""One EPUB -> one list of chapters, each a list of generation chunks.

Ported from ebook2audiobook@9daab0ba, lib/core.py:
  chapter_provenance_path (496)   save_chapter_provenance (503)
  load_chapter_provenance (522)   load_json_chapters (547)
  save_json_chapters (564)        get_chapters (837)
  _edge_chars (976)               _heading_text (991)
  _collapse_glue (1039)           filter_chapter (1092), incl. _tuple_row

`filter_chapter` is the walker: it turns one spine document's markup into a flat
row list, marking headings and list items on the way, and hands that to the
packer. `get_chapters` runs it over the spine and records the provenance that
binds a chapter to the document (and therefore to the TOC title) that produced it.

THREE JUDGMENTS LIVE IN THE WALKER and none of them is re-tuned here:

  2026-08-27  a heading is marked and reads as its own chunk
  2026-08-28  a heading's line breaks are read as SPACES, not welded
  2026-09-01  each <li> is marked and never shares a generation with a neighbour

plus the whitespace-fidelity machinery (`glue`/`sep` rows and `_collapse_glue`)
that keeps a drop cap one word and an inline emphasis from manufacturing a period.

THE SESSION DICT IS GONE. e2a read `language`, `language_iso1`, `tts_engine`,
`chapter_titles`, `skip_headings` and `sentence_per_paragraph` off a global
session registry, and wrote `chapter_titles`, `chapter_titles_by_doc` and
`chapter_docs` back into it. narrator passes a `ChapterContext` in and reads the
same fields back off it. Same values, same order of assignment; no global state.
"""
from __future__ import annotations

import json
import os
import traceback
from dataclasses import dataclass, field

import regex as re
from bs4 import BeautifulSoup, NavigableString, Tag

from . import epub as epub_mod
from .epub import UnsupportedInput
from .normalize import (BOOK_EXACT_ENGINES, ORPHEUS, UnsupportedEngine,
                        _refuse_engine, normalize_text)
from .packer import get_sentences, orpheus_max_chars
from .sml import (
    escape_sml,
    normalize_sml_tags,
    restore_sml,
    sml_heading,
    sml_item,
    sml_token,
    static_tokens,
)


def _dependency_error(message) -> None:
    """e2a's `DependencyError(msg)`: a class that is CONSTRUCTED, never raised.
    Its `__init__` prints the message and its `handle_exception` prints the
    current traceback and a `Caught DependencyError: <msg>` line. Reproduced as a
    function, because that is all it ever was at a call site."""
    print(message)
    traceback.print_exc()
    print(f'Caught DependencyError: {message}')


@dataclass
class ChapterContext:
    """What `filter_chapter` and `get_chapters` read from, and write back to.

    `chapter_titles`, `chapter_titles_by_doc` and `chapter_docs` are OUTPUTS that
    later documents also read (heading detection consults `chapter_titles`), which
    is exactly how the session dict behaved.
    """
    language: str
    language_iso1: str
    tts_engine: str
    process_dir: str
    skip_headings: bool = False
    sentence_per_paragraph: bool = False
    chapter_titles: list = field(default_factory=list)
    chapter_titles_by_doc: dict = field(default_factory=dict)
    chapter_docs: list = field(default_factory=list)


# =============================================================================
# Chapter provenance (core.py:496-575)
# =============================================================================

def chapter_provenance_path(process_dir: str) -> str:
    """Chapter provenance lives in the session's process_dir, NOT only in the
    session state: prepare, worker and assemble can be separate processes (and
    separate front ends), and all of them share process_dir."""
    return os.path.join(process_dir, 'chapter-provenance.json')


def save_chapter_provenance(ctx: ChapterContext) -> bool:
    if not ctx.process_dir:
        print('save_chapter_provenance(): no process_dir; chapter provenance NOT '
              'persisted')
        return False
    try:
        path = chapter_provenance_path(ctx.process_dir)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({
                'chapter_docs': list(ctx.chapter_docs),
                'chapter_titles_by_doc': dict(ctx.chapter_titles_by_doc),
                'chapter_titles': list(ctx.chapter_titles),
            }, f, ensure_ascii=False, indent=2)
        print(f'[TOC] Chapter provenance for {len(ctx.chapter_docs)} chapters '
              f'saved to {path}')
        return True
    except Exception as e:
        print(f'save_chapter_provenance() error: {e}')
        return False


def load_chapter_provenance(process_dir: str, ctx: ChapterContext) -> bool:
    """Restore what `save_chapter_provenance` wrote, into `ctx`.

    THE ASYMMETRY IS DELIBERATE AND IT IS e2a'S (`core.py:537-540`).
    `chapter_docs` and `chapter_titles_by_doc` are restored UNCONDITIONALLY,
    overwriting whatever the context holds, because the sidecar is the authority
    on which document produced which chapter. `chapter_titles` is restored ONLY
    WHEN THE CONTEXT HAS NONE:

        if data.get('chapter_titles') and not session.get('chapter_titles'):

    A live run has already read the TOC out of the book itself and that reading
    wins; the sidecar's copy is the fallback for a resume that never opened the
    EPUB. Restoring all three alike - which an earlier draft of this port did -
    would let a stale sidecar overwrite titles just read from the book.

    THE GUARD IS BEHAVIOURALLY INERT AT 9daab0ba, and is kept anyway. Both e2a
    call sites (`core.py:5163-5164`, the resume path, and `:4585-4586`, the
    assembly repair) reach it with an EMPTY `chapter_titles`, so the condition is
    always true and the unconditional form would produce identical values in
    every reachable case (traced by review, 2026-09-04). It stays because this is
    a PORT: the line is one line, it is what the source says, and the next caller
    - a prep that has already read the TOC and wants the docs re-bound - is
    exactly the case the guard was written for.

    MUTATES A `ChapterContext` and returns e2a's bool, rather than returning a
    payload, precisely so the asymmetry has somewhere to live: "only when empty"
    is a question about the CALLER's state, and a function that just returns a
    dict cannot ask it.

    ABSENT IS NOT AN ERROR and the keys are left EMPTY on purpose - assembly then
    uses per-chapter first sentences and says so, instead of pairing TOC titles
    by position, which is what mislabels chapters.
    """
    path = chapter_provenance_path(process_dir)
    if not os.path.exists(path):
        print(f'[TOC] No chapter provenance at {path}')
        return False
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        ctx.chapter_docs = list(data.get('chapter_docs', []))
        ctx.chapter_titles_by_doc = dict(data.get('chapter_titles_by_doc', {}))
        if data.get('chapter_titles') and not ctx.chapter_titles:
            ctx.chapter_titles = list(data['chapter_titles'])
        print(f'[TOC] Restored provenance for {len(ctx.chapter_docs)} chapters '
              f'from {path}')
        return True
    except Exception as e:
        print(f'[TOC] Chapter provenance {path} unreadable ({e})')
        return False


def load_json_chapters(filepath: str) -> list:
    """Raises on a missing or unreadable chapters cache instead of returning [].

    Only called on RESUME (checksum matched, so a prior run saved it). Returning
    [] made the caller silently re-run `get_chapters`; the fresh sentence split
    can differ from the split the existing numbered sentence files were rendered
    from, and resume-by-file-index then pairs old audio with the WRONG text.
    """
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        raise RuntimeError(
            f'Saved chapters cache {filepath} could not be read ({e}). Refusing '
            f'to re-split sentences over the existing session audio - delete the '
            f'session processing directory to start fresh.') from e


def save_json_chapters(chapters: list, filepath: str) -> bool:
    try:
        with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(chapters, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f'save_json_chapters() error: {e}')
        return False


# =============================================================================
# The heading text rule (core.py:976-1038)
# =============================================================================

def _edge_chars(tag) -> tuple:
    """(first char, last char) of a Tag's VERBATIM text - ('', '') when it has
    none. Unlike `get_text(strip=True)` this still knows whether the markup put
    whitespace at the tag's edges."""
    first = last = ''
    for s in tag.strings:
        if s:
            if not first:
                first = s[0]
            last = s[-1]
    return first, last


def heading_text(tag) -> str:
    """A heading's text, with its LINE BREAKS READ AS SPACES (2026-08-28).

    `get_text(strip=True)` joins the strings with NOTHING, so a title typeset
    across four lines came out as 'God Will Not ProtectChildren When Parents...' -
    fused in the text, therefore fused in the audio and in the transcript cue.
    A blanket `get_text(' ')` is the same defect in the other direction:
    `<span class="dropcap">I</span>ntroduction` is ONE word and reads as
    'I ntroduction'.

    So a space is inserted at a piece boundary only where the markup means a new
    word: a <br> (always - that IS a line break), or a boundary where the text so
    far ends in a word character and the next piece opens with a capital or a
    digit. A SPACE and never a period: these breaks fall INSIDE one sentence.
    """
    out = []
    last_char = ''
    for node in tag.descendants:
        if isinstance(node, Tag):
            if node.name.lower() == 'br':
                out.append(' ')
                last_char = ' '
            continue
        if not isinstance(node, NavigableString):
            continue
        piece = str(node)
        if not piece:
            continue
        if (last_char and not last_char.isspace() and not piece[:1].isspace()
                and last_char.isalnum() and (piece[0].isupper() or piece[0].isdigit())):
            out.append(' ')
        out.append(piece)
        last_char = piece[-1]
    return re.sub(r'\s+', ' ', ''.join(out)).strip()


def _collapse_glue(rows: list) -> list:
    """Resolve the ('glue', payload) markers `_tuple_row` emits where two pieces
    of text ABUT in the markup with NO whitespace between them.

    Two text rows either side of a glue are concatenated with NOTHING between
    them, because that is what the document says. Every other case restores
    exactly what the walk emitted before the marker existed. This is deliberately
    NOT a drop-cap detector: it never looks at letter case or word length.

    The ('item_start'|'item_end', None) markers pass through untouched, like every
    other non-text row.
    """
    out = []
    glued = False
    suppressed = None
    for typ, payload in rows:
        if typ == 'glue':
            glued = True
            suppressed = payload if suppressed is None else suppressed
            continue
        if glued:
            glued = False
            pending, suppressed = suppressed, None
            if typ == 'text' and out and out[-1][0] == 'text':
                out[-1] = ('text', out[-1][1] + payload)
                continue
            if pending is not None:
                # The restore inherits the row's own inline-ness: a suppressed
                # break resolved by a 'sep' row must come back as 'sep', or the
                # restore re-manufactures the block boundary the walk declined.
                out.append(('sep' if typ == 'sep' else 'break', pending))
        out.append((typ, payload))
    return out


# =============================================================================
# filter_chapter (core.py:1092)
# =============================================================================

HEADING_TAGS = [f'h{i}' for i in range(1, 7)]
BREAK_TAGS = ['br', 'p', 'span']
PAUSE_TAGS = ['div']
PROC_TAGS = HEADING_TAGS + BREAK_TAGS + PAUSE_TAGS

#: `epub:type` values that name a non-chapter. Substring-matched.
EXCLUDED_EPUB_TYPES = {
    'frontmatter', 'backmatter', 'toc', 'titlepage', 'colophon',
    'acknowledgments', 'dedication', 'glossary', 'index',
    'appendix', 'bibliography', 'copyright-page', 'landmark',
}


def _norm_title(s) -> str:
    """Tolerant title normalization for dedup: lowercase, collapse whitespace,
    drop trailing sentence/colon punctuation, fold common smart punctuation."""
    s = (s or '').strip()
    s = (s.replace('’', "'").replace('‘', "'")
          .replace('“', '"').replace('”', '"')
          .replace('–', '-').replace('—', '-'))
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'[.!?…:]+$', '', s)
    return s.lower().strip()


def _tuple_row(node, last_text_char=None):
    """The markup walk. Yields ('text'|'heading'|'break'|'pause'|'sep'|'glue'|
    'table'|'item_start'|'item_end', payload).

    WHITESPACE FIDELITY: `ws_pending` is True when the SOURCE markup puts
    whitespace between the last text character emitted at this level and whatever
    comes next. The walk used to answer that with "the previous sibling had text"
    alone and so separated EVERY pair of adjacent inline pieces, turning a drop
    cap into 'W e have freedom.' and `<i>Fu</i>ture` into 'Fu ture'.
    """
    try:
        prev_child_had_data = False
        ws_pending = False
        for idx, child in enumerate(node.children):
            current_child_had_data = False
            if isinstance(child, NavigableString):
                raw = str(child)
                text = child.strip()
                if text:
                    if prev_child_had_data:
                        if ws_pending or raw[:1].isspace():
                            # A text node reached across whitespace from an INLINE
                            # sibling is the same sentence, not a new block: 'sep'
                            # keeps the [break] token but never closes the block,
                            # so break_between_alnum_re can collapse it back to a
                            # space. As 'break' it manufactured a period ~140
                            # times in one real book.
                            yield ('sep', sml_token('break'))
                        else:
                            yield ('glue', sml_token('break'))
                    yield ('text', text)
                    last_text_char = text[-1]
                    current_child_had_data = True
                    ws_pending = raw[-1:].isspace()
                elif raw:
                    # A whitespace-only string is not data, but it IS whitespace.
                    ws_pending = True
            elif isinstance(child, Tag):
                name = child.name.lower()
                first_char, last_char = _edge_chars(child)
                lead_ws = ws_pending or first_char.isspace()
                if name in HEADING_TAGS:
                    title = heading_text(child)
                    if title:
                        if prev_child_had_data:
                            yield ('break', sml_token('break'))
                        yield ('heading', title)
                        last_text_char = title[-1]
                        current_child_had_data = True
                elif name == 'table':
                    if prev_child_had_data:
                        yield ('break', sml_token('break'))
                    yield ('table', child)
                    current_child_had_data = True
                elif name == 'li':
                    # A LIST ITEM IS ITS OWN CHUNK (2026-09-01). Handled here
                    # beside 'heading'/'table' and deliberately NOT by adding 'li'
                    # to BREAK_TAGS: a break alone is not enough, because the
                    # packers pack straight across a [break]. The item_start/
                    # item_end pair carries the IDENTITY the packers refuse to
                    # cross. ul/ol stay transparent.
                    if prev_child_had_data:
                        yield ('break', sml_token('break'))
                    yield ('item_start', None)
                    for inner in _tuple_row(child, last_text_char):
                        yield inner
                        if len(inner) > 1 and isinstance(inner[1], str) and inner[1]:
                            last_text_char = inner[1][-1]
                        current_child_had_data = True
                    yield ('item_end', None)
                    if current_child_had_data:
                        # The item is CLOSED before whatever follows it.
                        yield ('break', sml_token('break'))
                else:
                    return_data = False
                    if name in PROC_TAGS:
                        is_header = False
                        if prev_child_had_data and name in BREAK_TAGS:
                            # A <span> is INLINE: only the markup's own whitespace
                            # separates it. <br>/<p> are boxes and always separate.
                            if name == 'span' and not lead_ws:
                                yield ('glue', sml_token('break'))
                            elif name == 'span' and not first_char and not last_char:
                                # A span with NO text at all cannot be a block - it
                                # is a marker (EPUB pagebreak spans). NARROW on
                                # purpose: a span WITH text keeps 'break'.
                                yield ('sep', sml_token('break'))
                            else:
                                yield ('break', sml_token('break'))
                        for inner in _tuple_row(child, last_text_char):
                            return_data = True
                            yield inner
                            if len(inner) > 1 and isinstance(inner[1], str) and inner[1]:
                                last_text_char = inner[1][-1]
                            current_child_had_data = True
                            if (inner[0] in ('text', 'heading')
                                    and isinstance(inner[1], str) and inner[1]):
                                is_header = True
                        if return_data:
                            if name in BREAK_TAGS and name != 'span':
                                if is_header or (last_text_char
                                                 and not last_text_char.isalnum()
                                                 and not last_text_char.isspace()):
                                    yield ('break', sml_token('break'))
                            elif name in HEADING_TAGS or name in PAUSE_TAGS:
                                yield ('pause', sml_token('pause'))
                    else:
                        # Transparent inline tag (<em>, <i>, <b>, <a>, <sup>...):
                        # no break is emitted here. Glue with a None payload says
                        # "restore NOTHING if this cannot be merged".
                        if prev_child_had_data and not lead_ws:
                            yield ('glue', None)
                        yield from _tuple_row(child, last_text_char)
                        current_child_had_data = True
                # Whitespace state AFTER this tag.
                if (name in HEADING_TAGS or name == 'table' or name == 'li'
                        or name in PAUSE_TAGS
                        or (name in BREAK_TAGS and name != 'span')):
                    ws_pending = True
                elif current_child_had_data:
                    ws_pending = last_char.isspace()
                else:
                    ws_pending = ws_pending or last_char.isspace()
            if current_child_had_data:
                prev_child_had_data = True
    except Exception as e:
        _dependency_error(f'filter_chapter() _tuple_row() error: {e}')
        # e2a writes `return None` here. Inside a generator that is a bare stop,
        # so the row stream TRUNCATES silently after the printed error. Preserved:
        # the caller's "no tuples_list" / short-chapter branches are what e2a's
        # behaviour rests on.
        return


def filter_chapter(idx: int, doc, ctx: ChapterContext) -> list | None:
    """One spine document -> its generation chunks, or [] (skip), or None (fail).

    The three return shapes are load-bearing: `get_chapters` ABORTS THE WHOLE BOOK
    on None (the old `break` returned the chapters gathered so far as if the whole
    book had been processed) and simply produces no chapter for [].
    """
    if ctx.tts_engine != ORPHEUS:
        # filter_chapter IS the e2a port and stays Orpheus-only: a Higgs
        # book chunks through `paragraph_packer.make_chapter_chunker`,
        # which `get_chapters` takes in place of this function.
        _refuse_engine(ctx.tts_engine, 'filter_chapter')
    try:
        print(f'----------\nParsing doc {idx}')
        lang, lang_iso1, tts_engine = ctx.language, ctx.language_iso1, ctx.tts_engine

        doc_body = doc.get_body_content()
        raw_html = doc_body.decode('utf-8') if isinstance(doc_body, bytes) else doc_body
        soup = BeautifulSoup(raw_html, 'html.parser')
        # ebooklib's get_body_content() returns ONE OF TWO SHAPES: the INNER html
        # for a bare <body>, the WHOLE element for a <body> with attributes (it
        # strips the wrapper with a literal `startswith(b'<body>')` check).
        # Calibre stamps class="calibre" onto every body, so while every book was
        # force-converted only the second shape was ever seen; a publisher/
        # BookForge EPUB gives the first, `soup.body` is None, and this read as
        # "no body found" - silently skipping EVERY document on a book whose text
        # was sitting right there (measured: 21,255 characters in the document
        # that reported no body).
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

        for tag in soup(['script', 'style']):
            tag.decompose()

        tuples_list = _collapse_glue(list(_tuple_row(body)))
        if not tuples_list:
            print('No tuples_list from body created!')
            return None
        print('Parsing xhtml markers...')

        # Build the set of normalized TOC titles, for detecting chapter titles
        # that lost their heading tags (e.g. after AI cleanup turned <h2> into <p>)
        toc_titles_normalized = set()
        for t in ctx.chapter_titles:
            ct = _norm_title(t)
            if ct:
                toc_titles_normalized.add(ct)
        if toc_titles_normalized:
            print(f'[HEADING] {len(toc_titles_normalized)} TOC titles loaded for '
                  f'heading detection')

        text_list = []
        handled_tables = set()
        prev_typ = None
        last_heading_normalized = None
        chapter_title_normalized = None
        item_pending = False
        sml_statics = static_tokens()

        def _close_block(items):
            """A BLOCK BOUNDARY FOLLOWS THE LAST ITEM. A standalone line carrying
            no terminal punctuation - a signature, a label, a title paragraph the
            TOC never listed - would otherwise weld to the next block: the
            flattened text keeps the boundary only as an SML token, and the
            "remove any [break] between words" pass deletes that token whenever
            WORD characters flank it. The period is the same treatment headings
            get, and it also makes the token survive that pass.

            GATED ON A WORD CHARACTER, not on "lacks .!?...": a line ending in a
            closing quote, a comma, a colon or a dash already says how it ends.
            """
            if items:
                last = items[-1]
                if last not in sml_statics and last and last[-1].isalnum():
                    items[-1] = last + '.'

        for typ, payload in tuples_list:
            if typ == 'heading':
                _close_block(text_list)
                if not ctx.skip_headings:
                    title = payload.strip()
                    norm = _norm_title(title)
                    if norm and norm == last_heading_normalized:
                        print(f'[HEADING] Skipping duplicate heading: "{title}"')
                        prev_typ = typ
                        continue
                    if title and title[-1] not in '.!?…':
                        title += '.'
                    # ...and MARK it, so the period is not the only thing the
                    # splitter knows (2026-08-27). A period alone made this a
                    # short punctuated row and nothing more, and all three merge
                    # passes then glued 'Prologue.' onto the paragraph under it.
                    # Only headings that are actually VOICED get marked.
                    text_list.append(sml_heading(title))
                    last_heading_normalized = norm
                    if chapter_title_normalized is None:
                        chapter_title_normalized = norm
            elif typ == 'item_start':
                # EVERY ITEM STARTS ON A PARAGRAPH BOUNDARY (2026-09-01): close
                # the block behind it and put a [break] there if the boundary is
                # not already marked. The break matters even though the packers
                # cross it - it is what keeps PASS 1 from running a row on THROUGH
                # the item's marker.
                _close_block(text_list)
                if prev_typ not in ('break', 'pause') and text_list:
                    text_list.append(sml_token('break'))
                item_pending = True
            elif typ == 'item_end':
                # THE PERIOD AN ITEM NEEDS. `<li>fourteen</li>` ends in a letter
                # and would otherwise weld to the next item at the ' '.join.
                _close_block(text_list)
                # Cleared unconditionally - an item that yielded no text at all
                # must not leave the marker armed for the prose after the list.
                item_pending = False
            elif typ in ('break', 'pause'):
                _close_block(text_list)
                if prev_typ != typ:
                    text_list.append(sml_token(typ))
                # Don't clear last_heading - breaks often sit between a heading
                # and its duplicate text.
            elif typ == 'sep':
                # An inline whitespace separator: the [break] token is kept (so a
                # pagebreak span still pauses where nothing flanks it) but the
                # block is NOT closed.
                if prev_typ not in ('break', 'pause', 'sep'):
                    text_list.append(sml_token('break'))
            elif typ == 'table':
                _close_block(text_list)
                last_heading_normalized = None
                table = payload
                if table in handled_tables:
                    prev_typ = typ
                    continue
                handled_tables.add(table)
                rows = table.find_all('tr')
                if not rows:
                    prev_typ = typ
                    continue
                headers = [c.get_text(strip=True)
                           for c in rows[0].find_all(['td', 'th'])]
                for row in rows[1:]:
                    cells = [c.get_text(strip=True).replace('\xa0', ' ')
                             for c in row.find_all('td')]
                    if not cells:
                        continue
                    if len(cells) == len(headers) and headers:
                        line = ' — '.join(f'{h}: {c}'
                                          for h, c in zip(headers, cells))
                    else:
                        line = ' — '.join(cells)
                    if line:
                        text_list.append(line.strip())
            else:
                text = payload.strip()
                if text:
                    text_check = _norm_title(text)
                    # Deduplicate: skip body text that repeats the heading we just
                    # added OR the chapter title (catches a non-adjacent echo).
                    if text_check and (text_check == last_heading_normalized
                                       or text_check == chapter_title_normalized):
                        print(f'[HEADING] Skipping duplicate body text: "{text}"')
                        last_heading_normalized = None
                        prev_typ = typ
                        continue
                    last_heading_normalized = None
                    if text_check in toc_titles_normalized:
                        if text[-1] not in '.!?…':
                            text += '.'
                        print(f'[HEADING] Detected chapter title from TOC match: '
                              f'"{text}"')
                        # A title recovered from the TOC is a heading in everything
                        # but markup. NOTE it is NOT gated on skip_headings and
                        # never was: this row is body text that happens to match a
                        # TOC entry, and skip_headings only ever suppressed real
                        # h1-h6 tags.
                        text_list.append(sml_heading(text))
                        # A TOC title inside a list is a heading and nothing else -
                        # one marker per row, and the heading rule is the stronger
                        # one. The pending mark is spent.
                        item_pending = False
                    elif item_pending:
                        # FIRST body text of this <li> - the marker goes here and
                        # only here (2026-09-01).
                        text_list.append(sml_item(text))
                        item_pending = False
                    else:
                        text_list.append(text)
            prev_typ = typ

        # The document's end is a block boundary too.
        _close_block(text_list)
        print('Flattening as raw text...')

        # e2a computes a cap here as well as in get_sentences, "so both passes
        # agree". It is NEVER READ AGAIN in this function - the only surviving
        # effect is that an invalid ORPHEUS_MAX_CHARS raises HERE rather than one
        # call later. Kept for exactly that failure mode.
        max_chars = orpheus_max_chars()
        del max_chars

        clean_list = []
        i = 0
        while i < len(text_list):
            current = text_list[i]
            if current in sml_statics:
                if clean_list:
                    prev = clean_list[-1]
                    if prev in sml_statics:
                        i += 1
                        continue
                clean_list.append(current)
                i += 1
                continue
            clean_list.append(current)
            i += 1
        text = ' '.join(clean_list)
        if not re.search(r'[^\W_]', text):
            print('No valid text found!')
            return None

        # clean SML tags badly coded
        ok, text = normalize_sml_tags(text)
        if ok is False:
            print(text)
            return None

        # remove any [break] between words or cutting words
        break_token = re.escape(sml_token('break'))
        strip_break_spaces_re = re.compile(rf'\s*{break_token}\s*')
        text = strip_break_spaces_re.sub(sml_token('break'), text)

        # In sentence_per_paragraph mode, split on breaks NOW, before escape_sml
        # replaces them. Each paragraph becomes one sentence.
        if ctx.sentence_per_paragraph:
            print('Sentence-per-paragraph mode: preserving paragraph boundaries...')
            paragraphs = text.split(sml_token('break'))
            sentences = [p.strip() for p in paragraphs if p.strip()]
            if len(sentences) == 0:
                print('No sentences found!')
                return None
            print(f'[sentence_per_paragraph] Extracted {len(sentences)} paragraphs '
                  f'as sentences')
            return sentences

        break_between_alnum_re = re.compile(rf'(?<=[\w]){break_token}(?=[\w])',
                                            flags=re.UNICODE)
        text = break_between_alnum_re.sub(' ', text)

        # escape all SML tags so no text treatment touches them
        text, sml_blocks = escape_sml(text)

        # Orpheus fine-tunes are trained on book-exact text, so the whole
        # date/year/roman/clock/math pipeline is SKIPPED - digits like '5,000',
        # '1930s', '7th' and romans like 'Henry VIII' stay as printed. NO lexical
        # transform runs at the engine boundary either (permanently disabled
        # 2026-09-02): number normalization is BookForge's model pass over the
        # narration copy, run before the text reaches prep. Orpheus is
        # English-only by design; any other language is an XTTS job.
        if lang != 'eng':
            print(f"Orpheus is English-only (got '{lang}') - route this language "
                  f"to another engine (XTTS).")
            return None
        print('Orpheus: book-exact sentences (no lexical transform - numbers are '
              'normalized upstream by BookForge)...')

        print('Normalize text...')
        text = normalize_text(text, lang, lang_iso1, tts_engine)

        print('Get sentences...')
        sentences = get_sentences(text, lang, tts_engine, sml_blocks)
        # get_sentences returns None on a genuine failure and [] for empty text.
        if sentences is None:
            print('Failed to split chapter text into sentences')
            return None
        return [restore_sml(s, sml_blocks) for s in sentences]
    except Exception as e:
        _dependency_error(f'filter_chapter() error: {e}')
        return None


# =============================================================================
# get_chapters (core.py:837)
# =============================================================================

def get_chapters(epub_book, ctx: ChapterContext, chapter_chunker=None) -> list:
    """The spine, walked. Fills `ctx.chapter_titles`, `ctx.chapter_titles_by_doc`
    and `ctx.chapter_docs`, writes `chapter-provenance.json`, and returns the
    chapter list.

    `chapters` and `chapter_docs` MUST stay index-aligned: they are appended
    together, so a document yielding no sentences produces no chapter and
    therefore consumes no title.

    `chapter_chunker` selects the CHUNKING POLICY and defaults to
    `filter_chapter`, which is e2a's. See the note beside it below.

    NO STANZA PIPELINE IS BUILT. e2a constructs one here for every book whose
    language is in `year_to_decades_languages` (English is) and then consults it
    only from `filter_chapter`'s non-Orpheus branch. See `text/sentences.py` for
    the measurement and `text/PORT_NOTES.md` behaviour difference 1.

    THE ENGINE IS CHECKED HERE, FIRST, and that placement is a fix rather than a
    flourish. Without it a wrong `tts_engine` reached the TOC loop, where
    `normalize_text`'s `UnsupportedEngine` was caught by the `except toc_error`
    below and reported as "Error extracting Table of Content"; the run then went
    on to `filter_chapter`, whose own refusal landed in THIS function's blanket
    `except -> []`, and the caller was told the book had no chapters. Two
    misleading messages for one wrong flag. The check runs before either.
    """
    if ctx.tts_engine not in BOOK_EXACT_ENGINES:
        _refuse_engine(ctx.tts_engine, 'get_chapters')
    # THE ONE SEAM THE SECOND CHUNKING POLICY NEEDS. `chapter_chunker` defaults
    # to `filter_chapter`, so the parity path is byte-identical and this argument
    # does not exist for it. `text/paragraph_packer.py` passes its own callable
    # with the same contract (list of chunks | [] to skip the document | None to
    # abort the book), so the spine walk, the TOC identity mapping and the
    # provenance sidecar have ONE implementation rather than two that drift.
    chunker = chapter_chunker if chapter_chunker is not None else filter_chapter
    try:
        # Step 1: the TOC. `toc_list` keeps the old flat title list (heading
        # detection reads it); `toc_by_href` is the identity-bearing form.
        toc_list = []
        toc_by_href = {}
        try:
            for item in epub_mod.flatten_toc(epub_book.toc):
                nt = normalize_text(str(item.title), ctx.language,
                                    ctx.language_iso1, ctx.tts_engine)
                if nt is None:
                    continue
                toc_list.append(nt)
                href_key = epub_mod.normalize_doc_key(getattr(item, 'href', None))
                # Several TOC entries can point into the SAME document (anchors);
                # the first one in reading order names that document.
                if href_key and href_key not in toc_by_href:
                    toc_by_href[href_key] = nt
            ctx.chapter_titles = toc_list
            print(f'[TOC] Extracted {len(toc_list)} chapter titles from TOC '
                  f'({len(toc_by_href)} distinct documents)')
        except UnsupportedEngine:
            # Never reported as a TOC problem: the engine check above makes this
            # unreachable today, and it stays here so it cannot become reachable
            # silently.
            raise
        except Exception as toc_error:
            print(f'Error extracting Table of Content: {toc_error}')
            ctx.chapter_titles = []

        all_docs = epub_mod.spine_documents(epub_book)
        if not all_docs:
            print('No document body found!')
            return []

        # Computed by e2a and used by nothing; see epub.get_ebook_title.
        epub_mod.get_ebook_title(epub_book, all_docs)

        # Resolve TOC titles onto spine documents by IDENTITY (never position),
        # keyed by the exact doc.get_name() also recorded in chapter_docs, so
        # assembly does a plain dict lookup with no re-normalization.
        titles_by_doc = {}
        toc_by_basename = {}
        for href_key in toc_by_href:
            toc_by_basename.setdefault(href_key.rsplit('/', 1)[-1], []).append(href_key)
        for doc in all_docs:
            doc_key = epub_mod.normalize_doc_key(doc.get_name())
            if not doc_key:
                continue
            if doc_key in toc_by_href:
                titles_by_doc[doc.get_name()] = toc_by_href[doc_key]
            else:
                # Some epubs write TOC hrefs relative to the nav document while
                # document names carry an OPF-root prefix. Match on basename ONLY
                # when it is unambiguous - still identity, not position.
                candidates = toc_by_basename.get(doc_key.rsplit('/', 1)[-1], [])
                if len(candidates) == 1:
                    titles_by_doc[doc.get_name()] = toc_by_href[candidates[0]]
                    print(f"[TOC] Matched document '{doc.get_name()}' to TOC href "
                          f"'{candidates[0]}' by basename")
        ctx.chapter_titles_by_doc = titles_by_doc
        unmatched_docs = [d.get_name() for d in all_docs
                          if d.get_name() not in titles_by_doc]
        print(f'[TOC] Mapped {len(titles_by_doc)}/{len(all_docs)} spine documents '
              f'to a TOC title')
        if unmatched_docs:
            print(f'[TOC] No TOC entry for: {unmatched_docs} (these use their own '
                  f'first sentence as title)')

        chapters = []
        chapter_docs = []
        for doc_idx, doc in enumerate(all_docs):
            sentences_list = chunker(doc_idx, doc, ctx)
            if sentences_list is None:
                # A genuine extraction error on ONE document must not silently
                # truncate the book.
                print(f'Chapter extraction failed at document index {doc_idx}; '
                      f'aborting so the audiobook is not silently truncated')
                return []
            elif len(sentences_list) > 0:
                chapters.append(sentences_list)
                chapter_docs.append(doc.get_name())
        ctx.chapter_docs = chapter_docs
        save_chapter_provenance(ctx)
        if len(chapters) == 0:
            print('No chapters found! possible reason: file corrupted or need to '
                  'convert images to text with OCR')
            return []
        return chapters
    except (UnsupportedEngine, UnsupportedInput):
        # narrator's own named refusals leave by name. e2a's blanket
        # `except -> []` had no such refusal to express, and turning one into
        # "No chapters found" is exactly the report this fix removes.
        raise
    except Exception as e:
        _dependency_error(f'Error extracting main content pages: {e}')
        return []
