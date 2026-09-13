"""The interpreter running this suite satisfies narrator's DECLARED base
dependencies - as ONE named failure, not as forty scattered ones.

THE DEFECT THIS EXISTS FOR (2026-09-13). `python -m pytest narrator/tests` on
the Windows test interpreter gave 35 failures and 8 errors, in three unrelated
files, and every one of them was `ModuleNotFoundError: No module named
'ebooklib'` - a package `python/pyproject.toml` declares as a BASE dependency
(not an extra) and `electron/scripts/higgs/requirements-narrator-runtime.txt`
ships. R2: a guard that is red is a broken guard, and a permanently non-zero
exit is how the next real regression lands in a pile of red people scroll past.

WHY THE PROBE IS AN IMPORT OF THE API AND NOT `importlib.util.find_spec`.
Installing the missing `ebooklib` revealed a SECOND unsatisfied declaration
underneath it, and a find_spec check would have missed it: the interpreter has
`python-iso639` where narrator declares `iso639-lang`. BOTH INSTALL A TOP-LEVEL
MODULE CALLED `iso639`, so `import iso639` succeeds and
`from iso639 import Lang` - the line `text/prep.py:270` actually runs - does
not. pyproject names this trap in prose ("PyPI also carries `python-iso639` and
`iso-639`, both of which install a module called `iso639` with a DIFFERENT
API"); this is that prose made executable.

So each dependency is probed with THE IMPORT NARRATOR ITSELF MAKES, cited to
the file that makes it. A dependency whose declaration and whose installation
disagree is a fact with two owners, and this is the thing comparing them.

NOT A DEPENDENCY-RESOLVER TEST. It asserts nothing about versions - pyproject's
own notes explain why several are ranges - only that the interpreter can do
what the code will ask of it.
"""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))      # .../python
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

PYPROJECT = os.path.join(_PYTHON_ROOT, 'pyproject.toml')

#: distribution name -> (the source narrator runs, where it runs it).
#:
#: The right-hand side is copied from the real call site, so a dependency that
#: is satisfied only for an import narrator never makes cannot pass here. Keep
#: it that way: a probe weakened to `import <pkg>` is a probe that would have
#: let the `python-iso639` swap through.
PROBES = {
    'numpy': ('import numpy', 'everywhere'),
    'soundfile': ('import soundfile', 'engine/*/, assemble/edges.py, align/'),
    'psutil': ('import psutil', 'render/worker.py:log_memory'),
    'beautifulsoup4': ('from bs4 import BeautifulSoup, NavigableString, Tag',
                       'text/chapters.py, text/paragraph_packer.py'),
    'pillow': ('from PIL import Image', 'text/epub.py (the cover)'),
    'mutagen': ('from mutagen.mp4 import MP4, MP4Cover',
                'assemble/encode.py (the m4b cover atom)'),
    'ebooklib': ('import ebooklib\nfrom ebooklib import epub',
                 'text/epub.py, text/paragraph_packer.py'),
    # THE TRAP. `import iso639` succeeds under `python-iso639` too; only
    # `iso639-lang` has `Lang`.
    'iso639-lang': ('from iso639 import Lang', 'text/prep.py:resolve_language'),
    'unidecode': ('from unidecode import unidecode', 'text/normalize.py'),
    'num2words': ('from num2words import num2words',
                  'serve/worker.py (the Listen path\'s number normalization)'),
    'regex': ('import regex', 'six modules under text/'),
}


def _declared_base_dependencies():
    """The `[project] dependencies` names, lower-cased, from pyproject.toml."""
    try:
        import tomllib                       # stdlib from 3.11
    except ImportError as exc:               # pragma: no cover - 3.10 and down
        raise AssertionError(
            f'this interpreter cannot read pyproject.toml ({exc}); narrator '
            'requires Python >= 3.11') from None
    if not os.path.isfile(PYPROJECT):
        raise AssertionError(
            f'narrator\'s dependency declaration is missing: {PYPROJECT}')
    with open(PYPROJECT, 'rb') as handle:
        data = tomllib.load(handle)
    names = []
    for spec in data['project']['dependencies']:
        # 'iso639-lang>=2.2' -> 'iso639-lang'. No packaging dependency: the
        # separator is the first character that is not name-ish.
        name = ''
        for char in spec.strip():
            if char.isalnum() or char in '-_.':
                name += char
            else:
                break
        names.append(name.lower().replace('_', '-'))
    return names


class DeclaredDependenciesTest(unittest.TestCase):

    def test_the_probe_table_covers_every_declared_dependency(self):
        """A dependency added to pyproject with no probe here would be declared
        and unchecked, which is the state that produced this file."""
        self.assertEqual(sorted(_declared_base_dependencies()),
                         sorted(PROBES),
                         'pyproject.toml and this file disagree about what '
                         'narrator depends on')

    def test_this_interpreter_can_do_what_narrator_will_ask_of_it(self):
        """ONE failure naming EVERY unsatisfied declaration, with the command
        that fixes it - not one traceback per test that happened to touch the
        missing module."""
        broken = []
        for name in sorted(PROBES):
            source, where = PROBES[name]
            try:
                exec(compile(source, f'<probe:{name}>', 'exec'), {})
            except Exception as exc:
                broken.append(f'  {name}: {type(exc).__name__}: {exc}\n'
                              f'      narrator runs `{source.splitlines()[-1]}`'
                              f' in {where}')
        if broken:
            self.fail(
                'this interpreter does not satisfy narrator\'s declared base '
                'dependencies:\n' + '\n'.join(broken)
                + f'\n\n  Fix: python -m pip install -e "{_PYTHON_ROOT}"\n'
                '  If a probe fails while the distribution IS installed, a '
                'DIFFERENT distribution owns that module name - see the '
                '`iso639-lang` note in pyproject.toml and at the top of this '
                'file.')


if __name__ == '__main__':
    unittest.main()
