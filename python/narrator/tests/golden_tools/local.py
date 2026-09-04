"""Locating the LOCAL (uncommitted) golden binaries.

The committed fixtures under `python/narrator/tests/golden/<slug>/` are text
only. The audio, the EPUBs, the covers and the reference m4b/VTT live outside
the repo, in the directory CONTRACTS.md calls the golden local copy:

    C:\\tmp\\narrator-golden\\
        index.json
        <slug>\\ebook-<uuid>\\<hash>\\        the whole process_dir
        <slug>\\reference.m4b                e2a's assembly of THAT session
        <slug>\\reference.vtt                e2a's own VTT for it
        <slug>\\shipped.m4b                  what the project actually shipped
        <slug>\\shipped.m4b.vtt              its sidecar (a mov_text round-trip)

Override the root with `NARRATOR_GOLDEN_LOCAL`.

A test that needs those binaries must SKIP when the directory is absent, and
say why. That is the ONE place a missing input is not an error (CONTRACTS.md,
"Golden fixtures"): the copies are 4.6 GB and are not on every machine. Every
other missing input still raises.

Typical use in a parity test:

    from narrator.tests.golden_tools import local

    class AssembleParity(unittest.TestCase):
        def setUp(self):
            self.book = local.require(self, 'kershaw')

        def test_vtt(self):
            produced = my_assembler(self.book['sentencesDir'])
            diff = compare_vtt(produced, local.read_reference_vtt('kershaw'))
            self.assertTrue(diff.ok, diff.describe())
"""

from __future__ import annotations

import json
import os

ENV_VAR = 'NARRATOR_GOLDEN_LOCAL'
DEFAULT_ROOT = r'C:\tmp\narrator-golden'

__all__ = ['ENV_VAR', 'DEFAULT_ROOT', 'root', 'available', 'index', 'slugs', 'book',
           'require', 'read_reference_vtt']


def root() -> str:
    """The golden local root, from the env var or the documented default."""
    return os.environ.get(ENV_VAR) or DEFAULT_ROOT


def available() -> bool:
    """True when the local copies are present AND indexed on this machine."""
    return os.path.isfile(os.path.join(root(), 'index.json'))


def why_unavailable() -> str:
    return (
        'golden local binaries not found: no index.json under %s. '
        'Set %s to the golden copy root, or rebuild it with '
        'python/narrator/tests/golden_tools/build_fixture.py inputs '
        '(see each fixture README for the session path on Z:).'
        % (root(), ENV_VAR)
    )


def index() -> dict:
    path = os.path.join(root(), 'index.json')
    if not os.path.isfile(path):
        raise FileNotFoundError(why_unavailable())
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def slugs() -> list:
    """Every book in the index. Top-level keys are slugs; `_meta` is not one."""
    return sorted(k for k in index() if not k.startswith('_'))


def book(slug: str) -> dict:
    """The index entry for one slug. Raises when absent - no fallback.

    Guaranteed keys (CONTRACTS.md, plus what parity needs): `localProcessDir`,
    `sentencesDir` (the dir the reference was assembled FROM), `referenceM4b`,
    `referenceVtt`, `sourceProcessDir`, `chapters` ("auto" unless a book needs
    an explicit selection).
    """
    doc = index()
    if slug not in doc or slug.startswith('_'):
        raise KeyError('no golden book %r (have: %s)'
                       % (slug, ', '.join(sorted(k for k in doc if not k.startswith('_')))))
    return doc[slug]


def require(test_case, slug: str) -> dict:
    """`book(slug)`, or skip `test_case` with a clear message."""
    if not available():
        test_case.skipTest(why_unavailable())
    entry = book(slug)
    for key in ('localProcessDir', 'sentencesDir', 'referenceM4b', 'referenceVtt'):
        if not os.path.exists(entry[key]):
            test_case.skipTest('%s: %s missing at %s' % (slug, key, entry[key]))
    return entry


def read_reference_vtt(slug: str) -> str:
    """e2a's own VTT for this session, from the local copy.

    The COMMITTED `golden/<slug>/reference.vtt` is the same bytes; prefer that
    one when the test does not otherwise need the binaries.
    """
    with open(book(slug)['referenceVtt'], encoding='utf-8') as f:
        return f.read()
