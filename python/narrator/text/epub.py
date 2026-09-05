"""The EPUB seam: open the book, read its spine in reading order, its TOC, its
Dublin Core metadata and its cover; and compute the two md5 values the session
layout is named by.

Ported from ebook2audiobook@9daab0ba:
  lib/core.py   prepare_dirs (221) - the stage-into-process_dir copy
                convert2epub (577) - the EPUB branch ONLY
                get_cover (772)
                normalize_doc_key (803)
                flatten_toc (823)
                get_ebook_title (751)
                the DC metadata read and the session metadata template (core.py:176)
  bookforge_ext/parallel/session.py  prep_ebook_info (362) - the hash derivations

TWO md5 VALUES, AND NEITHER ONE HASHES THE FILE. MEASURED 2026-09-04 against all
three goldens:

  process_dir NAME    = md5(<the --ebook argument, as a string>)
  epub_content_hash   = md5(<process_dir>/<basename of --ebook>, as a string)

Both are `hashlib.md5(<path>.encode()).hexdigest()` over a PATH STRING. e2a
computes the first before `prepare_dirs` copies the book in and the second after,
by which point `session['ebook']` has been REBOUND to the copy - which is why the
two differ and why neither changes when the book's bytes change. The key is called
`epub_content_hash` and it is not a content hash; renaming it would break every
reader in `render/SESSION_READERS.md`, so it keeps its name and gets this note.

Verified on kershaw: `md5('/home/telltale/ebook2audiobook/tmp/staged-ccd14111-...
.epub')` == the process_dir name `645fe70686...`, and
`md5('<that process_dir>/staged-ccd14111-....epub')` == the stored
`epub_content_hash` `6d302f8c08...`.

CALIBRE IS NOT PORTED. `convert2epub` has five branches (epub / txt / pdf / image
/ everything-else) and four of them shell out to `ebook-convert`. Foundry
guarantees an EPUB - "by the time text reaches the engine it is an EPUB from
Foundry, every time" (docs/NARRATOR_PLAN.md) - and e2a's own EPUB branch returns
the file untouched with a comment saying the Calibre pass was actively
destructive on an EPUB (it exploded one 7-chapter book into 78 spine documents and
rewrote the book's straight quotes). So narrator ports the EPUB branch and refuses
every other extension BY NAME. See PORT_NOTES "Unexercised e2a paths".
"""
from __future__ import annotations

import hashlib
import io
import os

#: The Dublin Core keys e2a's session template declares, in its order
#: (`lib/core.py:176`). Each is looked up with `get_metadata('DC', key)`; the two
#: capitalized ones ('Source', 'Modified') never match anything, because DC names
#: are lowercase - kept because they are in the template and dropping them would
#: be a silent edit.
METADATA_KEYS = (
    'title', 'creator', 'contributor', 'language', 'identifier', 'publisher',
    'date', 'description', 'subject', 'rights', 'format', 'type', 'coverage',
    'relation', 'Source', 'Modified',
)

#: The only input extension narrator's prep accepts.
ACCEPTED_EXTENSION = '.epub'


class UnsupportedInput(RuntimeError):
    """An --ebook narrator's prep will not read."""


def path_md5(path: str) -> str:
    """`hashlib.md5(<path string>.encode()).hexdigest()` - e2a's derivation for
    BOTH the process_dir name and `epub_content_hash`. See the module docstring:
    this hashes the PATH, never the bytes."""
    return hashlib.md5(path.encode()).hexdigest()


def process_dir_for(session_dir: str, ebook_path: str) -> str:
    """`<session_dir>/<md5 of the --ebook path>` - e2a session.py:466."""
    return os.path.join(session_dir, path_md5(ebook_path))


def accept_epub(src: str) -> None:
    """e2a's `convert2epub` gate, narrowed to the one branch narrator ports.

    e2a refused an empty file and an unknown extension and Calibre-converted
    everything else; narrator refuses everything that is not an EPUB, by name.
    """
    if not os.path.isfile(src):
        raise UnsupportedInput(f'--ebook does not exist: {src}')
    if os.path.getsize(src) == 0:
        raise UnsupportedInput(f'Input file is empty: {src}')
    ext = os.path.splitext(src)[1].lower()
    if ext != ACCEPTED_EXTENSION:
        raise UnsupportedInput(
            f"narrator's prep reads EPUB only, not '{ext}' ({src}). "
            f"ebook2audiobook converted pdf/txt/image inputs with Calibre; "
            f"BookForge's Foundry produces an EPUB for every book, and running "
            f"Calibre over an EPUB was measurably destructive (it split one "
            f"7-chapter book into 78 spine documents and rewrote the book's "
            f"straight quotes). Convert this input in Foundry first.")


def stage_into_process_dir(src: str, process_dir: str) -> str:
    """`prepare_dirs`' one act that matters to the text layer: copy the book into
    `process_dir` and return the copy's path.

    e2a made SEVEN directories here (models/tts, session, process, custom_model,
    voice, audiobooks, chapters, sentences). narrator's prep makes the three the
    session layout actually needs and says so in `prep.py`; the models/voices/
    audiobooks dirs belong to e2a's own installation layout, which narrator does
    not have. Declared in PORT_NOTES.
    """
    import shutil

    os.makedirs(process_dir, exist_ok=True)
    dst = os.path.join(process_dir, os.path.basename(src))
    shutil.copy(src, dst)
    return dst


def read_epub(epub_path: str):
    """`epub.read_epub(path, {'ignore_ncx': True})`.

    `ignore_ncx` makes ebooklib prefer the EPUB 3 nav document over the legacy
    NCX when both are present; it is e2a's option and it decides which TOC
    `flatten_toc` walks, so it is load-bearing for `chapter_titles`.
    """
    from ebooklib import epub as _epub

    return _epub.read_epub(epub_path, {'ignore_ncx': True})


# =============================================================================
# Spine, TOC, title (core.py:751-836)
# =============================================================================

def normalize_doc_key(href) -> str | None:
    """Canonical form used to compare a TOC entry href with a spine document name.
    Drops the fragment, percent-decodes, folds separators and './' noise, and
    lowercases. Returns None for an empty/absent href."""
    import urllib.parse

    if not href:
        return None
    s = str(href).split('#')[0].strip()
    if not s:
        return None
    s = urllib.parse.unquote(s).replace('\\', '/')
    while s.startswith('./'):
        s = s[2:]
    s = s.lstrip('/')
    return s.lower() or None


def flatten_toc(nodes) -> list:
    """epub TOCs nest: a node is either a Link-like object (has .title/.href) or a
    (Section, [children]) tuple/list. The old flat comprehension dropped BOTH the
    Section itself and every child under it. Depth-first, document order."""
    out = []
    try:
        for node in nodes:
            if isinstance(node, (tuple, list)):
                for part in node:
                    if isinstance(part, (tuple, list)):
                        out.extend(flatten_toc(part))
                    elif hasattr(part, 'title'):
                        out.append(part)
            elif hasattr(node, 'title'):
                out.append(node)
    except Exception as e:
        print(f'flatten_toc() error: {e}')
    return out


def spine_documents(epub_book) -> list:
    """The ITEM_DOCUMENTs that are in the spine, in `get_items_of_type` order.

    NOT in spine order. e2a filters the document list by spine membership rather
    than walking the spine, so the reading order is ebooklib's manifest order
    filtered by the spine set. Preserved exactly: `chapter_docs` and every chapter
    index in the session state were produced by this ordering, and re-ordering
    them would renumber a rendered book's chapters.
    """
    import ebooklib

    spine_ids = [item[0] for item in epub_book.spine]
    return [item for item in epub_book.get_items_of_type(ebooklib.ITEM_DOCUMENT)
            if item.id in spine_ids]


def get_ebook_title(epub_book, all_docs: list) -> str | None:
    """DC title, else the first document's `<head><title>`, else a non-cover
    `<img alt>`. Computed by `get_chapters` and, at 9daab0ba, USED BY NOTHING -
    the local `title` it binds is never read again. Ported because dropping a call
    with a side-effect-free body is still an edit; see PORT_NOTES."""
    from bs4 import BeautifulSoup

    meta_title = epub_book.get_metadata('DC', 'title')
    if meta_title and meta_title[0][0].strip():
        return meta_title[0][0].strip()
    if all_docs:
        html = all_docs[0].get_content().decode('utf-8')
        soup = BeautifulSoup(html, 'html.parser')
        title_tag = soup.select_one('head > title')
        if title_tag and title_tag.text.strip():
            return title_tag.text.strip()
        img = soup.find('img', alt=True)
        if img:
            alt = img['alt'].strip()
            if alt and 'cover' not in alt.lower():
                return alt
    return None


# =============================================================================
# Metadata and cover
# =============================================================================

def read_metadata(epub_book, filename_noext: str) -> dict:
    """The session's metadata dict: every template key, overwritten by the LAST
    DC value found for it, with the title falling back to the filename.

    e2a iterates `for value, attributes in data` and assigns each time, so when a
    book declares two `dc:creator`s the LAST one wins. Preserved.
    """
    metadata = {key: None for key in METADATA_KEYS}
    for key in list(metadata.keys()):
        data = epub_book.get_metadata('DC', key)
        if data:
            for value, attributes in data:
                metadata[key] = value
    metadata['title'] = (metadata['title'] if metadata['title']
                         else filename_noext.replace('_', ' '))
    return metadata


def get_cover(epub_book, process_dir: str, filename_noext: str):
    """Extract the cover to `<process_dir>/<filename_noext>.jpg`.

    RETURNS THREE THINGS, and every one of them is meaningful:
      - the written path (str) when an image was found and saved
      - True when the EPUB carries no cover at all
      - False when extraction raised

    That is why `session-state.json`'s `cover` is `true` on all three goldens: the
    staged EPUBs carry no ITEM_COVER and no image whose file name or id contains
    'cover', so e2a returned the bare True. `cover: true` therefore does NOT mean
    "a cover was written" - `assemble/` must test for the FILE, not the flag. The
    `cover.jpg` sitting in a live process_dir is BookForge's own
    (`reassembly-bridge.ts:948` writes `bookforge_metadata.coverPath`), not this
    function's output.

    e2a wrapped the body in `except -> DependencyError(e); return False`;
    `prep_ebook_info` wraps the CALL in its own `except -> None` as well. Both are
    kept: a cover is genuinely optional and neither e2a nor narrator fails a book
    over one.
    """
    import ebooklib
    from PIL import Image

    try:
        cover_image = None
        cover_path = os.path.join(process_dir, filename_noext + '.jpg')
        for item in epub_book.get_items_of_type(ebooklib.ITEM_COVER):
            cover_image = item.get_content()
            break
        if not cover_image:
            for item in epub_book.get_items_of_type(ebooklib.ITEM_IMAGE):
                if ('cover' in item.file_name.lower()
                        or 'cover' in item.get_id().lower()):
                    cover_image = item.get_content()
                    break
        if cover_image:
            image = Image.open(io.BytesIO(cover_image))
            if image.mode in ('RGBA', 'P'):
                image = image.convert('RGB')
            image.save(cover_path, format='JPEG')
            return cover_path
        return True
    except Exception as e:
        print(f'get_cover() error: {e}')
        return False
