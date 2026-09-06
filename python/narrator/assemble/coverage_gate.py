"""The coverage AUDIT: assembly says what the alignment found, and assembles.

`docs/NARRATOR_PLAN.md` -> "Higgs v3 path design points", point 4. The
MEASUREMENT is `align/coverage.py`'s - it needs a forced aligner, torch and the
whisperx env. The REPORTING is here, and it is pure stdlib on purpose: assembly
runs on a machine with none of those (the reassembly bridge spawns it with
`--tts_engine xtts` against a bundled CPU env), so it reads the coverage REPORT
and never the aligner.

    narrator align    --session-dir <hash dir> --report coverage.json
    narrator assemble --session-dir <hash dir> --coverage-report coverage.json

IT IS NOT A GATE ANY MORE. Owen's ruling, 2026-09-05:

    there will always be truncations or errors of some sort. thats the nature of
    tts. nothing is going to come out perfect. we try our best to detect and
    reduce the number of errors but assembly will never function, ever, if we
    expect it to come out the other side flawless. we need to base assembly on
    the expected text and the actual real length of the audio. with orpheus, for
    truncations, we split at sentence boundaries and re-rendered. but the goal is
    to have zero truncations.

So a failed chunk is REPORTED - every index, the text the audio did not say, and
the `narrator retake --indices ...` line that fixes it - and the book is
assembled. A book with 36 minutes of good audio and 14 questionable chunks is a
book, and refusing it left the operator with neither the audio nor a way to see
what was wrong. A MISSING report is reported too, and assembly proceeds: what an
absent report costs is measured cues, not the audiobook.

WHAT IS STILL REFUSED, and this is the whole list: a report that cannot be read,
that is of a schema this reader does not understand, or that is ABOUT ANOTHER
BOOK - another engine, another session, or the same book before 300 more chunks
were rendered. Those are not "the render was imperfect", they are "this document
does not describe what you are assembling", and reporting on the wrong book is
worse than reporting on none.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from ..manifest import Manifest

#: What `narrator align --report` writes when nothing names a file, and what
#: assembly looks for beside a session. One constant, not a search.
DEFAULT_REPORT_NAME = 'coverage.json'

#: The report schema this reader understands. A report written by an older
#: aligner may have measured something else, so the version is checked rather
#: than assumed compatible.
SUPPORTED_REPORT_VERSION = 1

#: Blocks a report must carry before this reader will report anything from it.
#: A document with no `summary` is a MALFORMED REPORT, not a report of zero
#: aligned chunks (review finding 7): the old `document.get('summary') or {}`
#: still refused - 0 + 0 != N - but blamed the RENDER ("align again after the
#: render changed") for a broken document, which sends the operator to
#: re-render a book that is fine.
#:
#: `enforced` IS NO LONGER REQUIRED and is no longer read. It said whether the
#: engine's policy blocked assembly, and nothing blocks assembly now; the writer
#: emits `audited` in its place. Dropping it from this list is what lets a report
#: written by either aligner be read by this one - a report is an audit, and an
#: audit of a book is not invalidated by a key nobody consults.
REQUIRED_REPORT_KEYS = ('engine', 'summary', 'chunks')


class CoverageRefusal(RuntimeError):
    """This document does not describe the book being assembled - it is
    unreadable, of an unknown schema, or about another book. NOT raised for a
    chunk that failed coverage: that is reported and assembled."""


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
    """Refuse a report that is about a different book, or an older render.

    THE ONLY REFUSALS LEFT, and every one of them is "this document is not about
    this book". Whether the chunks it describes passed or failed is the audit's
    business (`report_failures`), not this function's.
    """
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


def retake_indices(document: dict) -> list:
    """Every chunk an operator should re-render: failed coverage, or unplaceable.

    ONE LIST, sorted and de-duplicated, because it is one thing to do -
    `narrator retake --indices <this>` - and the two ways a chunk gets on it
    (the audio did not say the text; the aligner could not place it at all) are
    the same instruction to the person reading it.
    """
    failed = [c['index'] for c in document.get('chunks', []) if c.get('failed')]
    errored = [e['index'] for e in document.get('errors', [])
               if isinstance(e, dict) and 'index' in e]
    return sorted(set(failed) | set(errored))


def report_failures(document: dict, *, where: str, log) -> list:
    """LOG every chunk the audit doubted, and return the retake list.

    Never raises. Owen's ruling: an imperfect render is the nature of TTS and it
    must not stop an assembly. What an operator needs is not a refusal, it is the
    indices, the text the audio did not say, and the command that fixes them -
    which a duration ratio could never have told them either way.

    Called for EVERY report, whatever the engine. Orpheus's policy is not audited
    by default, but a report that exists was asked for by somebody, and reading
    it out is the whole reason it was written.
    """
    failed = [c for c in document.get('chunks', []) if c.get('failed')]
    errors = [e for e in document.get('errors', []) if isinstance(e, dict)]
    summary = document.get('summary') or {}
    aligned = summary.get('chunksAligned')
    skipped = summary.get('chunksSkipped')
    total = document.get('chunksInManifest')

    log(f'[coverage] {where}: {aligned} chunk(s) aligned, {len(failed)} failed '
        f'coverage, {len(errors)} could not be placed, {skipped} marker-only, '
        f'of {total} chunk(s) in the manifest')

    accounted = sum(v for v in (aligned, skipped) if isinstance(v, int))
    if isinstance(total, int) and accounted + len(errors) < total:
        # NOT a refusal - a statement. A chunk nobody looked at is a fact about
        # the audit, and hiding it would be the thing this line exists against.
        log(f'[coverage] {where}: {total - accounted - len(errors)} chunk(s) '
            f'were never measured (a partial --indices run, or an align that was '
            f'stopped). Their cues are estimates.')

    for chunk in failed:
        log(f'[coverage]   chunk {chunk["index"]}: '
            + '; '.join(chunk.get('reasons') or ['no reason recorded']))
        for span in chunk.get('droppedText') or ():
            log(f'[coverage]     dropped {span["words"]} word(s): '
                f'{span["text"][:120]!r}')
    for error in errors:
        log(f'[coverage]   chunk {error.get("index")}: not placed at '
            f'{error.get("stage")} - {str(error.get("error"))[:160]}')

    indices = retake_indices(document)
    if indices:
        log('[coverage] The audiobook is assembled from what was rendered. To '
            'fix those chunks: narrator retake --indices '
            + ','.join(str(i) for i in indices)
            + '  (in BookForge: Correct sentences), then align and assemble '
              'again.')
    return indices


def check(manifest: Manifest, report_path: Optional[str], log) -> Optional[dict]:
    """The whole audit, as `assemble()` calls it. NEVER blocks the assembly.

    Find the report - the given path, or `coverage.json` beside the session -
    verify it is ABOUT THIS BOOK, read out what it found, and return it. With no
    report at all, say so and return None: `assemble()` then cues the sentence
    transcript proportionally from the manifest's own text and the real audio
    durations, which is what the ruling asks for.
    """
    path = report_path or default_report_path(manifest)
    if not os.path.isfile(path):
        # Two different sentences on purpose: a path the CALLER named and did not
        # find is a bug in the caller (BookForge passes the flag only when the
        # file is there), while nothing beside the session just means the Align
        # row never ran. Neither stops the book.
        if report_path:
            log(f'[coverage] no coverage report at {report_path}, which this '
                f'assembly was told to read. Assembling anyway; the sentence '
                f'cues will be estimates rather than measurements.')
        else:
            log(f'[coverage] no coverage report beside the session ({path}), so '
                f'nothing has checked that this render said its text. Assembling '
                f'anyway; run the Align step to measure it.')
        return None
    # A REPORT THE CALLER NAMED IS THE CALLER'S CLAIM, and a claim that turns out
    # to be about another book is that caller's bug: it is refused by name.
    # A report nobody named - the `coverage.json` that happens to sit beside the
    # session - is a FIND, and a stale find must not cost an audiobook. Assembly
    # says what is wrong with it and proceeds without it, because "a leftover
    # report from before the resume" and "this render is bad" are different
    # things and only one of them is a reason to stop.
    if report_path is None:
        try:
            document = load_report(path)
            verify_report(document, manifest, path)
        except CoverageRefusal as stale:
            log(f'[coverage] the report beside the session is not about this '
                f'book, so it is ignored: {stale}')
            return None
        report_failures(document, where=path, log=log)
        return document

    document = load_report(path)
    verify_report(document, manifest, path)
    report_failures(document, where=path, log=log)
    return document
