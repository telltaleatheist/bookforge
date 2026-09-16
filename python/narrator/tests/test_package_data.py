"""Every file the package ships that is not Python must be DECLARED.

WHY THIS EXISTS. `text/caps_acronyms.json` landed on 2026-09-13 and was never
added to `[tool.setuptools.package-data]`, so every `pip install` from git
carried narrator's code and not its data. Nothing noticed for two days, and the
reason is the shape worth guarding against rather than the file:

  * `paragraph_packer` reads the list at MODULE IMPORT;
  * the only importer on the render path is `truncation.split_halves`, which
    imports it LAZILY;
  * so the env installed clean, `crucible doctor` called it ready, the server
    loaded 9 GB of weights, and the render produced 82 correct chunks before
    meeting the first one long enough to need splitting - and died there with a
    bare FileNotFoundError, 116 of 376 sentences in.

A test that named that one file would have been written the day after it was
needed. This one asks the general question instead: does the build ship
everything under `narrator/` that is not a `.py` and not a test fixture?
"""

from __future__ import annotations

import fnmatch
import subprocess
from pathlib import Path

import pytest


PACKAGE = Path(__file__).resolve().parents[1]
PROJECT = PACKAGE.parent


def _declared_globs() -> dict[str, list[str]]:
    """The `[tool.setuptools.package-data]` table, as package -> globs."""
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover - python 3.10 and older
        pytest.skip("tomllib needs python 3.11+")
    with open(PROJECT / "pyproject.toml", "rb") as handle:
        return tomllib.load(handle)["tool"]["setuptools"]["package-data"]


def _shipped_files() -> list[Path]:
    """Tracked non-`.py` files under `narrator/`, minus the test fixtures.

    Asked of GIT rather than of the filesystem: a build ships what is committed,
    and a file sitting in a working tree unstaged is exactly the case where an
    author's machine works and everybody else's install does not.
    """
    out = subprocess.run(
        ["git", "ls-files", "narrator"],
        cwd=PROJECT, capture_output=True, text=True, check=True,
    ).stdout.split()
    return [
        Path(line) for line in out
        if not line.endswith(".py")
        # `narrator/tests/` is fixtures for the suite, not data the render
        # reads. They are deliberately not shipped, and sweeping them in here
        # would make this test demand several MB of golden audio in every wheel.
        and not line.startswith("narrator/tests/")
    ]


def _is_declared(path: Path, table: dict[str, list[str]]) -> bool:
    for package, globs in table.items():
        prefix = Path(*package.split("."))
        try:
            relative = path.relative_to(prefix)
        except ValueError:
            continue
        # setuptools matches a package's globs against paths relative to that
        # package. `**/` spans directories INCLUDING NONE - `**/*.md` ships
        # `narrator/CONTRACTS.md`, which is measurable in an installed env and
        # is not what `fnmatch` does with the pattern on its own.
        spelling = str(relative).replace("\\", "/")
        for pattern in globs:
            candidates = {pattern}
            if pattern.startswith("**/"):
                candidates.add(pattern[3:])
            if any(fnmatch.fnmatch(spelling, candidate) for candidate in candidates):
                return True
    return False


def test_every_non_python_file_narrator_ships_is_declared_package_data() -> None:
    table = _declared_globs()
    undeclared = sorted(
        str(path) for path in _shipped_files() if not _is_declared(path, table)
    )
    assert not undeclared, (
        "these files are committed under narrator/ and no package-data glob "
        "matches them, so `pip install` leaves them out and the failure lands "
        "at whatever moment first reads one: " + ", ".join(undeclared)
    )


def test_the_acronym_list_in_particular(sub=None) -> None:
    """The file that taught us, named once so a regression says its name."""
    assert _is_declared(
        Path("narrator/text/caps_acronyms.json"), _declared_globs()
    ), "caps_acronyms.json is read by the render, not by the docs"


def test_a_missing_acronym_list_refuses_by_name(tmp_path: Path) -> None:
    """Because the raw FileNotFoundError read as a bug in the retake logic."""
    from narrator.text import paragraph_packer

    with pytest.raises(FileNotFoundError) as caught:
        paragraph_packer._load_caps_acronyms(str(tmp_path / "gone.json"))
    message = str(caught.value)
    assert "without its package data" in message
    assert "pyproject.toml" in message, "say where the declaration goes"
