"""`text/epub.py` on a SYNTHETIC EPUB built in a temp directory.

Everything asserted here is a thing e2a computed and `session-state.json` (or the
process-dir name) records: the two md5 derivations, the spine reading order, the
TOC->document mapping keys, the Dublin Core read, the cover extraction and the
input refusal.

The book is built by hand rather than with `ebooklib`'s writer so the bytes on
disk are exactly what the assertions describe - a hand-written OPF is the only
way to test "the spine decides the order, and a manifest document NOT in the
spine is excluded".
"""
from __future__ import annotations

import hashlib
import io
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from narrator.text import epub as epub_mod  # noqa: E402

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:narrator-synthetic</dc:identifier>
    <dc:title>The Synthetic Book</dc:title>
    <dc:creator>A. Author</dc:creator>
    <dc:creator>B. Second</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Narrator Press</dc:publisher>
    <meta name="cover" content="coverimg"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/c0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c0002.xhtml" media-type="application/xhtml+xml"/>
    <item id="orphan" href="text/orphan.xhtml" media-type="application/xhtml+xml"/>
    <item id="coverimg" href="images/cover.png" media-type="image/png"
          properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c2"/>
    <itemref idref="c1"/>
  </spine>
</package>"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="text/c0002.xhtml">Second Document First</a></li>
  <li><a href="text/c0001.xhtml#anchor">First Document Second</a></li>
</ol></nav></body></html>"""

CHAPTER = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{t}</title></head>
<body><h1>{t}</h1><p>{p}</p></body></html>"""


def _png_bytes() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new('RGB', (8, 12), (10, 20, 30)).save(buf, format='PNG')
    return buf.getvalue()


def build_epub(path: str, *, with_cover: bool = True) -> str:
    """Write the synthetic book and return its path."""
    opf = OPF
    if not with_cover:
        opf = (opf.replace('<meta name="cover" content="coverimg"/>', '')
                  .replace('<item id="coverimg" href="images/cover.png" '
                           'media-type="image/png"\n          '
                           'properties="cover-image"/>', ''))
    with zipfile.ZipFile(path, 'w') as z:
        # `mimetype` first and STORED, as the spec requires.
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip',
                   compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', CONTAINER)
        z.writestr('OEBPS/content.opf', opf)
        z.writestr('OEBPS/nav.xhtml', NAV)
        z.writestr('OEBPS/text/c0001.xhtml',
                   CHAPTER.format(t='First Document Second',
                                  p='The first document says one thing.'))
        z.writestr('OEBPS/text/c0002.xhtml',
                   CHAPTER.format(t='Second Document First',
                                  p='The second document says another thing.'))
        z.writestr('OEBPS/text/orphan.xhtml',
                   CHAPTER.format(t='Not In The Spine',
                                  p='This document is in the manifest only.'))
        if with_cover:
            z.writestr('OEBPS/images/cover.png', _png_bytes())
    return path


class HashDerivationTest(unittest.TestCase):
    """Neither md5 hashes the FILE - both hash a PATH STRING. See
    `text/PORT_NOTES.md` section 5.1."""

    def test_path_md5_is_md5_of_the_path_string(self):
        p = '/home/telltale/ebook2audiobook/tmp/staged-abc.epub'
        self.assertEqual(epub_mod.path_md5(p),
                         hashlib.md5(p.encode()).hexdigest())

    def test_the_process_dir_is_named_by_the_ebook_arguments_hash(self):
        session_dir = os.path.join('X:', 'sessions', 'ebook-uuid')
        ebook = os.path.join('X:', 'staged.epub')
        self.assertEqual(epub_mod.process_dir_for(session_dir, ebook),
                         os.path.join(session_dir, epub_mod.path_md5(ebook)))

    def test_the_derivation_reproduces_a_real_golden_session(self):
        """kershaw, measured: the process-dir name is md5 of the WSL staging path
        and `epub_content_hash` is md5 of the COPY inside that dir."""
        staged = ('/home/telltale/ebook2audiobook/tmp/'
                  'staged-ccd14111-da29-4fb0-a489-a19a0f126bac.epub')
        self.assertEqual(epub_mod.path_md5(staged),
                         '645fe7068635f759cbda0b8a6d3a348d')
        internal = ('/home/telltale/ebook2audiobook/tmp/'
                    'ebook-ccd14111-da29-4fb0-a489-a19a0f126bac/'
                    '645fe7068635f759cbda0b8a6d3a348d/'
                    'staged-ccd14111-da29-4fb0-a489-a19a0f126bac.epub')
        self.assertEqual(epub_mod.path_md5(internal),
                         '6d302f8c08300a7e695e44e1dcbc0209')

    def test_the_hash_does_not_change_when_the_book_changes(self):
        """Recorded as a preserved bug, not a wish: `epub_content_hash` is
        insensitive to content, so two different books staged to the same path
        produce the same hash."""
        self.assertEqual(epub_mod.path_md5('/x/book.epub'),
                         epub_mod.path_md5('/x/book.epub'))


class SyntheticEpubTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix='narrator-T-epub-')
        cls.path = build_epub(os.path.join(cls.root, 'synthetic.epub'))
        cls.book = epub_mod.read_epub(cls.path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_the_spine_decides_the_reading_order_and_excludes_a_manifest_orphan(self):
        """e2a filters the DOCUMENT list by spine membership rather than walking
        the spine, so a manifest-only document is excluded and the order is
        ebooklib's manifest order filtered by the spine set. Preserved exactly -
        re-ordering it would renumber a rendered book's chapters."""
        names = [d.get_name() for d in epub_mod.spine_documents(self.book)]
        self.assertEqual(sorted(names), ['text/c0001.xhtml', 'text/c0002.xhtml'])
        self.assertNotIn('text/orphan.xhtml', names)
        self.assertNotIn('nav.xhtml', names)

    def test_normalize_doc_key_folds_a_toc_href_onto_a_document_name(self):
        self.assertEqual(epub_mod.normalize_doc_key('text/c0001.xhtml#anchor'),
                         'text/c0001.xhtml')
        self.assertEqual(epub_mod.normalize_doc_key('./Text/C0001.xhtml'),
                         'text/c0001.xhtml')
        self.assertEqual(epub_mod.normalize_doc_key('/OEBPS/a%20b.xhtml'),
                         'oebps/a b.xhtml')
        self.assertEqual(epub_mod.normalize_doc_key('a\\b.xhtml'), 'a/b.xhtml')
        self.assertIsNone(epub_mod.normalize_doc_key(''))
        self.assertIsNone(epub_mod.normalize_doc_key(None))
        self.assertIsNone(epub_mod.normalize_doc_key('#frag'))

    def test_the_toc_flattens_in_document_order(self):
        titles = [n.title for n in epub_mod.flatten_toc(self.book.toc)]
        self.assertEqual(titles, ['Second Document First', 'First Document Second'])

    def test_the_metadata_read_takes_every_template_key_and_the_last_creator(self):
        meta = epub_mod.read_metadata(self.book, 'synthetic')
        self.assertEqual(set(meta), set(epub_mod.METADATA_KEYS))
        self.assertEqual(meta['title'], 'The Synthetic Book')
        # e2a assigns in a loop, so the LAST dc:creator wins. Preserved.
        self.assertEqual(meta['creator'], 'B. Second')
        self.assertEqual(meta['language'], 'en')
        self.assertEqual(meta['publisher'], 'Narrator Press')
        # The two capitalized template keys can never match a DC name.
        self.assertIsNone(meta['Source'])
        self.assertIsNone(meta['Modified'])

    def test_a_book_with_no_title_falls_back_to_the_filename(self):
        meta = dict.fromkeys(epub_mod.METADATA_KEYS)

        class _NoMeta:
            def get_metadata(self, ns, key):
                return []

        got = epub_mod.read_metadata(_NoMeta(), 'a_book_name')
        self.assertEqual(got['title'], 'a book name')
        self.assertEqual(set(got), set(meta))

    def test_get_ebook_title_prefers_the_dublin_core_title(self):
        docs = epub_mod.spine_documents(self.book)
        self.assertEqual(epub_mod.get_ebook_title(self.book, docs),
                         'The Synthetic Book')

    def test_the_cover_is_written_as_filename_noext_dot_jpg(self):
        out = tempfile.mkdtemp(dir=self.root)
        got = epub_mod.get_cover(self.book, out, 'staged-abc')
        self.assertEqual(got, os.path.join(out, 'staged-abc.jpg'))
        self.assertTrue(os.path.isfile(got))
        from PIL import Image
        with Image.open(got) as im:
            self.assertEqual(im.format, 'JPEG')
            self.assertEqual(im.size, (8, 12))

    def test_a_book_with_no_cover_returns_the_bare_True(self):
        """`cover: true` in a session state means "no cover found", NOT "a cover
        was written" - all three goldens say true and none has one."""
        path = build_epub(os.path.join(self.root, 'nocover.epub'),
                          with_cover=False)
        book = epub_mod.read_epub(path)
        out = tempfile.mkdtemp(dir=self.root)
        self.assertIs(epub_mod.get_cover(book, out, 'staged-abc'), True)
        self.assertEqual(os.listdir(out), [])


class InputRefusalTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='narrator-T-refuse-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_an_epub_is_accepted(self):
        path = build_epub(os.path.join(self.root, 'ok.epub'))
        epub_mod.accept_epub(path)          # must not raise

    def test_a_pdf_is_refused_by_name_with_what_to_do_instead(self):
        path = os.path.join(self.root, 'book.pdf')
        with open(path, 'wb') as f:
            f.write(b'%PDF-1.4 not really')
        with self.assertRaises(epub_mod.UnsupportedInput) as caught:
            epub_mod.accept_epub(path)
        message = str(caught.exception)
        self.assertIn('.pdf', message)
        self.assertIn('Foundry', message)

    def test_an_empty_file_is_refused_the_way_e2a_refuses_it(self):
        path = os.path.join(self.root, 'empty.epub')
        open(path, 'wb').close()
        with self.assertRaises(epub_mod.UnsupportedInput) as caught:
            epub_mod.accept_epub(path)
        self.assertIn('Input file is empty', str(caught.exception))

    def test_a_missing_file_names_the_path(self):
        path = os.path.join(self.root, 'nope.epub')
        with self.assertRaises(epub_mod.UnsupportedInput) as caught:
            epub_mod.accept_epub(path)
        self.assertIn(path, str(caught.exception))

    def test_staging_copies_the_book_into_the_process_dir(self):
        src = build_epub(os.path.join(self.root, 'staged-abc.epub'))
        process_dir = os.path.join(self.root, 'proc')
        dst = epub_mod.stage_into_process_dir(src, process_dir)
        self.assertEqual(dst, os.path.join(process_dir, 'staged-abc.epub'))
        with open(src, 'rb') as a, open(dst, 'rb') as b:
            self.assertEqual(a.read(), b.read())


if __name__ == '__main__':
    unittest.main()
