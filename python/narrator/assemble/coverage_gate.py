"""The gate: assembly refuses a book whose chunks did not say their text.

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 4. The
MEASUREMENT is `align/coverage.py`'s - it needs a forced aligner, torch and the
whisperx env. The ENFORCEMENT is here, and it is pure stdlib on purpose:
assembly runs on a machine with none of those (the reassembly bridge spawns it
with `--tts_engine xtts` against a bundled CPU env), so it reads the coverage
REPORT and never the aligner.

    narrator align    --session-dir <hash dir> --report coverage.json
    narrator assemble --session-dir <hash dir> --coverage-report coverage.json

FOR AN ENFORCED ENGINE A MISSING REPORT IS A REFUSAL, not a pass. Higgs v3 has
no duration guard worth the name - a chunk measured a duration ratio of 0.99
while dropping 22 % of its text - so "nobody checked" and "it is fine" are the
same book, and only one of them is honest. Orpheus keeps its own chars/sec guard
and its resplit ladder; its policy is not enforced and a report there is read
for the log line and nothing else.

A STALE REPORT CATCHES ITSELF. The document records the session id, the process
dir and the number of chunks in the manifest it described; a report about a
different book, or about the same book before 300 more chunks were rendered, is
refused by name rather than believed.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from ..manifest import Manifest
from .engine_profiles import profile_for

#: What `narrator align --report` writes when nothing names a file, and what
#: assembly looks for beside a session. One constant, not a search.
DEFAULT_REPORT_NAME = 'coverage.json'

#: The report schema this reader understands. A report written by an older
#: aligner may have measured something else, so the version is checked rather
#: than assumed compatible.
SUPPORTED_REPORT_VERSION = 1

#: Blocks a report must carry before this reader will judge anything on it.
#: A document with no `summary` is a MALFORMED REPORT, not a report of zero
#: aligned chunks (review finding 7): the old `document.get('summary') or {}`
#: still refused - 0 + 0 != N - but blamed the RENDER ("align again after the
#: render changed") for a broken document, which sends the operator to
#: re-render a book that is fine.
REQUIRED_REPORT_KEYS = ('engine', 'summary', 'chunks', 'enforced')


class CoverageRefusal(RuntimeError):
    """One or more chunks did not say their text, and the engine's policy says
    that stops the book. Names every chunk and quotes the dropped text."""


def engine_id_of(manifest: Manifest) -> str:
    """Which engine rendered this book: the optional `engine` block when the
    manifest carries one, otherwise the voice's recorded `tts_engine`."""
    if manifest.engine is not None:
        return manifest.engine.id
    return manifest.voice.engine


def default_report_path(manifest: Manifest) -> str:
    return os.path.join(manifest.source.processDir, DEFAULT_REPORT_NAME)


def load_report(path: str) -> dict:
    """Read a coverage report, refusing by name for anything unreadable."""
    if not os.path.isfile(path):
        raise CoverageRefusal(f'no coverage report at {path}')
    try:
        with open(path, encoding='utf-8') as handle:
            document = json.load(handle)
    except (OSError, ValueError) as bad:
        raise CoverageRefusal(f'coverage report {path} is unreadable: {bad}') from bad
    if not isinstance(document, dict):
        raise CoverageRefusal(
            f'coverage report {path} is a {type(document).__name__}, not an object')
    version = document.get('version')
    if version != SUPPORTED_REPORT_VERSION:
        raise CoverageRefusal(
            f'coverage report {path} is version {version!r}; this assembler '
            f'understands version {SUPPORTED_REPORT_VERSION}. Re-run '
            f'`narrator align --report {path}`.')
    for key in REQUIRED_REPORT_KEYS:
        if key not in document:
            raise CoverageRefusal(
                f'coverage report {path} has no {key!r} block, so it is a '
                f'malformed report - not a report of zero aligned chunks. '
                f'Re-run `narrator align --report {path}`.')
    if not isinstance(document['summary'], dict):
        raise CoverageRefusal(
            f'coverage report {path}: "summary" is a '
            f'{type(document["summary"]).__name__}, not an object')
    return document


def verify_report(document: dict, manifest: Manifest, path: str) -> None:
    """Refuse a report that is about a different book, or an older render."""
    engine = engine_id_of(manifest)
    if document.get('engine') != engine:
        raise CoverageRefusal(
            f'coverage report {path} covers engine {document.get("engine")!r} '
            f'but this book was rendered by {engine!r}')
    session = manifest.source.sessionId
    if document.get('sessionId') not in (None, session):
        raise CoverageRefusal(
            f'coverage report {path} covers session '
            f'{document.get("sessionId")!r}, not {session!r}')
    chunks = sum(len(chapter.chunks) for chapter in manifest.chapters)
    if document.get('chunksInManifest') != chunks:
        raise CoverageRefusal(
            f'coverage report {path} was written for a manifest of '
            f'{document.get("chunksInManifest")!r} chunk(s); this one has '
            f'{chunks}. Align again after the render changed.')
    # `load_report` has already refused a document with no summary, so
    # these are reads, not rescues. A count that is absent from a report
    # that HAS a summary is still the document's bug, not a zero.
    summary = document['summary']
    aligned = _count(summary, 'chunksAligned', path)
    # A marker-only chunk (`[break]`) speaks nothing, so there is nothing to
    # align in it; it is SKIPPED and counted. Everything else must have been
    # measured - a chunk nobody looked at never passes for one that was.
    skipped = _count(summary, 'chunksSkipped', path)
    if aligned + skipped != chunks:
        raise CoverageRefusal(
            f'coverage report {path} accounts for {aligned} aligned + '
            f'{skipped} marker-only of {chunks} chunk(s); an enforced engine '
            f'needs every chunk measured or explicitly skipped. The rest are in '
            f'the report\'s "errors".')


def _count(summary: dict, key: str, path: str) -> int:
    """One of the summary's chunk counts, or a refusal naming the document.

    NOT `summary.get(key) or 0`. The gate DECIDES on these numbers, and a
    missing count read as zero turns "this report does not say" into "this
    report says none", which then produces a refusal blaming the render.
    """
    if key not in summary:
        raise CoverageRefusal(
            f'coverage report {path}: summary has no {key!r}. The document is '
            f'malformed; re-run `narrator align --report {path}`.')
    value = summary[key]
    if not isinstance(value, int) or isinstance(value, bool):
        raise CoverageRefusal(
            f'coverage report {path}: summary.{key} is {value!r}, not a count')
    return value


def refuse_on_failures(document: dict, *, where: str) -> None:
    """Raise `CoverageRefusal` when an ENFORCED report carries a failed chunk.

    The message names every failing chunk index and quotes the text the audio
    did not say - the thing an operator needs in order to re-render, and the
    thing a duration ratio could never have told them.
    """
    if not document.get('enforced'):
        return
    failed = [c for c in document.get('chunks', []) if c.get('failed')]
    if not failed:
        return
    lines = [
        f'{where}: {len(failed)} chunk(s) did not say their text, and engine '
        f'{document.get("engine")!r} refuses a book on that.',
    ]
    for chunk in failed:
        lines.append(f'  chunk {chunk["index"]}: '
                     + '; '.join(chunk.get('reasons') or ['no reason recorded']))
        for span in chunk.get('droppedText') or ():
            lines.append(
                f'    dropped {span["words"]} word(s): {span["text"][:120]!r}')
    lines.append(
        'Re-render those chunks (narrator retake --indices '
        + ','.join(str(c['index']) for c in failed)
        + ') and align again before assembling.')
    raise CoverageRefusal('\n'.join(lines))


def check(manifest: Manifest, report_path: Optional[str], log) -> Optional[dict]:
    """The whole gate, as `assemble()` calls it.

    For an engine whose policy is ENFORCED: find the report (the given path, or
    `coverage.json` beside the session), verify it is about this book, and
    refuse on any failed chunk. For an engine whose policy is not enforced: read
    a report if one was NAMED, log its summary, and block nothing.
    """
    policy = profile_for(engine_id_of(manifest)).coverage
    if not policy.enforced:
        if not report_path:
            return None
        document = load_report(report_path)
        summary = document['summary']
        log(f'[coverage] {report_path}: {summary.get("chunksFailed")} of '
            f'{summary.get("chunksAligned")} chunk(s) below the alignment '
            f'thresholds (informational for this engine)')
        return document

    path = report_path or default_report_path(manifest)
    if not os.path.isfile(path):
        raise CoverageRefusal(
            f'engine {engine_id_of(manifest)!r} is guarded by post-render '
            f'forced alignment and there is no coverage report at {path}. '
            f'A duration ratio cannot see a chunk that dropped a fifth of its '
            f'text, so assembly will not proceed on one. Run: '
            f'narrator align --session-dir <hash dir> --report {path}')
    document = load_report(path)
    verify_report(document, manifest, path)
    refuse_on_failures(document, where=path)
    summary = document['summary']
    log(f'[coverage] {path}: {summary.get("chunksAligned")} chunk(s) aligned, '
        f'none failed; median ratio {summary.get("alignedRatioMedian")}')
    return document
