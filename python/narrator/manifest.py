"""THE render manifest (schema v1) - the one source of truth for a book render.

Prep will write it; render, assembly, the VTT, resume, retakes and the training
exporters READ it and never re-derive it. In this phase it is BUILT from an
existing ebook2audiobook session directory by `narrator.render.session_v1`.

The schema is fixed by `narrator/CONTRACTS.md`; this module owns it. Everything
here is stdlib.

NO FALLBACKS: `load` and `validate` raise on anything malformed, naming the field
and the path. A required key is read with `d[k]`, never `d.get(k, default)` -- a
manifest missing `sampleRate` is a bug to surface, not a 24000 to assume. The one
place `None` is legal is a value the schema declares nullable (`samples` for a
chunk not rendered yet, `cover`, `epubPath`, `year`, and the three voice dirs).

WHAT `file` IS RELATIVE TO: `source.processDir`, which is ABSOLUTE and lives
inside the document. Not the manifest file's own directory. A manifest can
therefore be written anywhere, copied, or never written at all, and every chunk
still resolves to the same audio; `save()` does not mutate the manifest and
`load()` does not need to know where it came from. `chunk_path()` is the only
resolver.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Iterator

SCHEMA_VERSION = 1

#: The `kind` values a chunk may carry, derived from its leading SML marker.
CHUNK_KINDS = ("prose", "heading", "item")


class ManifestError(ValueError):
    """A manifest is malformed. Carries the offending field and, where a file is
    involved, its path."""


# --------------------------------------------------------------------------
# dataclasses
# --------------------------------------------------------------------------


@dataclass
class Source:
    """Where this manifest came from."""

    kind: str
    processDir: str
    sessionId: str
    epubContentHash: str


@dataclass
class Book:
    title: str
    author: str
    language: str
    language3: str
    epubPath: str | None = None
    year: str | None = None
    cover: str | None = None


@dataclass
class Voice:
    engine: str
    fineTuned: str
    modelDir: str | None = None
    adapterDir: str | None = None
    baseDir: str | None = None


@dataclass
class Chunk:
    """One rendered unit: the smallest thing that gets its own FLAC and its own
    VTT cue.

    `index` is the GLOBAL 0-based sentence index across the whole book, and it is
    also the FLAC's stem (`chapters/sentences/<index>.flac`).

    `text` is the chunk text EXACTLY as the session stored it, markers kept
    (`[heading]`, `[item]`, `[break]`). Consumers strip them; the manifest does
    not, because the markers are what `kind` and the VTT's bolding are derived
    from and a stripped copy could not be checked against the session.

    `samples` is the FLAC's STREAMINFO total-samples - exact, never decoded and
    never ffprobed. `None` means "not rendered yet", which is the only legal
    absence.

    `gapBefore` / `gapAfter` are seconds of silence the ASSEMBLER inserts around
    this chunk. For an e2a session they are 0.0 and that is not a placeholder:
    every gap is already baked into the FLAC's own samples. See
    `narrator/assemble/README.md` for the measurement behind that.
    """

    index: int
    text: str
    kind: str
    file: str
    gapBefore: float = 0.0
    gapAfter: float = 0.0
    samples: int | None = None
    take: int = 1


@dataclass
class Chapter:
    index: int
    title: str
    doc: str | None
    chunks: list[Chunk] = field(default_factory=list)


@dataclass
class Manifest:
    source: Source
    book: Book
    voice: Voice
    sampleRate: int
    sentencesDir: str
    chapters: list[Chapter] = field(default_factory=list)
    version: int = SCHEMA_VERSION


# --------------------------------------------------------------------------
# (de)serialization
# --------------------------------------------------------------------------


def _require(d: dict[str, Any], key: str, where: str) -> Any:
    if not isinstance(d, dict):
        raise ManifestError(f"{where}: expected an object, got {type(d).__name__}")
    if key not in d:
        raise ManifestError(f"{where}: missing required key {key!r}")
    return d[key]


def from_dict(data: dict[str, Any]) -> Manifest:
    """Build a Manifest from a decoded JSON document. Raises ManifestError."""
    version = _require(data, "version", "manifest")
    if version != SCHEMA_VERSION:
        raise ManifestError(
            f"manifest.version is {version!r}, this build only reads schema "
            f"v{SCHEMA_VERSION}"
        )

    s = _require(data, "source", "manifest")
    source = Source(
        kind=_require(s, "kind", "source"),
        processDir=_require(s, "processDir", "source"),
        sessionId=_require(s, "sessionId", "source"),
        epubContentHash=_require(s, "epubContentHash", "source"),
    )

    b = _require(data, "book", "manifest")
    book = Book(
        title=_require(b, "title", "book"),
        author=_require(b, "author", "book"),
        language=_require(b, "language", "book"),
        language3=_require(b, "language3", "book"),
        epubPath=_require(b, "epubPath", "book"),
        year=_require(b, "year", "book"),
        cover=_require(b, "cover", "book"),
    )

    v = _require(data, "voice", "manifest")
    voice = Voice(
        engine=_require(v, "engine", "voice"),
        fineTuned=_require(v, "fineTuned", "voice"),
        modelDir=_require(v, "modelDir", "voice"),
        adapterDir=_require(v, "adapterDir", "voice"),
        baseDir=_require(v, "baseDir", "voice"),
    )

    chapters: list[Chapter] = []
    raw_chapters = _require(data, "chapters", "manifest")
    if not isinstance(raw_chapters, list):
        raise ManifestError("manifest.chapters must be a list")
    for ci, rc in enumerate(raw_chapters):
        where = f"chapters[{ci}]"
        raw_chunks = _require(rc, "chunks", where)
        if not isinstance(raw_chunks, list):
            raise ManifestError(f"{where}.chunks must be a list")
        chunks = []
        for ki, rk in enumerate(raw_chunks):
            kwhere = f"{where}.chunks[{ki}]"
            chunks.append(
                Chunk(
                    index=_require(rk, "index", kwhere),
                    text=_require(rk, "text", kwhere),
                    kind=_require(rk, "kind", kwhere),
                    file=_require(rk, "file", kwhere),
                    gapBefore=_require(rk, "gapBefore", kwhere),
                    gapAfter=_require(rk, "gapAfter", kwhere),
                    samples=_require(rk, "samples", kwhere),
                    take=_require(rk, "take", kwhere),
                )
            )
        chapters.append(
            Chapter(
                index=_require(rc, "index", where),
                title=_require(rc, "title", where),
                doc=_require(rc, "doc", where),
                chunks=chunks,
            )
        )

    return Manifest(
        version=version,
        source=source,
        book=book,
        voice=voice,
        sampleRate=_require(data, "sampleRate", "manifest"),
        sentencesDir=_require(data, "sentencesDir", "manifest"),
        chapters=chapters,
    )


def to_dict(manifest: Manifest) -> dict[str, Any]:
    """The JSON document for a Manifest. Key order matches CONTRACTS.md so a
    saved manifest diffs cleanly against the schema in the docs."""
    return {
        "version": manifest.version,
        "source": {
            "kind": manifest.source.kind,
            "processDir": manifest.source.processDir,
            "sessionId": manifest.source.sessionId,
            "epubContentHash": manifest.source.epubContentHash,
        },
        "book": {
            "epubPath": manifest.book.epubPath,
            "title": manifest.book.title,
            "author": manifest.book.author,
            "year": manifest.book.year,
            "language": manifest.book.language,
            "language3": manifest.book.language3,
            "cover": manifest.book.cover,
        },
        "voice": {
            "engine": manifest.voice.engine,
            "fineTuned": manifest.voice.fineTuned,
            "modelDir": manifest.voice.modelDir,
            "adapterDir": manifest.voice.adapterDir,
            "baseDir": manifest.voice.baseDir,
        },
        "sampleRate": manifest.sampleRate,
        "sentencesDir": manifest.sentencesDir,
        "chapters": [
            {
                "index": c.index,
                "title": c.title,
                "doc": c.doc,
                "chunks": [
                    {
                        "index": k.index,
                        "text": k.text,
                        "kind": k.kind,
                        "gapBefore": k.gapBefore,
                        "gapAfter": k.gapAfter,
                        "file": k.file,
                        "samples": k.samples,
                        "take": k.take,
                    }
                    for k in c.chunks
                ],
            }
            for c in manifest.chapters
        ],
    }


def save(manifest: Manifest, path: str) -> str:
    """Write the manifest as UTF-8 JSON and return the path it was written to.

    Writing NEVER mutates the manifest. `file` entries are relative to
    `source.processDir`, which is absolute and already inside the document, so
    the manifest resolves identically wherever it is written.
    """
    validate(manifest)
    path = os.path.abspath(path)
    parent = os.path.dirname(path)
    if not os.path.isdir(parent):
        raise ManifestError(f"cannot save manifest: {parent} is not a directory")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(to_dict(manifest), f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def load(path: str) -> Manifest:
    """Read and validate a manifest from disk."""
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise ManifestError(f"manifest not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            raise ManifestError(f"manifest is not valid JSON: {path}: {e}") from e
    manifest = from_dict(data)
    validate(manifest)
    return manifest


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------


def validate(manifest: Manifest) -> None:
    """Strict structural check. Raises ManifestError on the FIRST problem, naming
    the chapter/chunk it is in.

    Checks, in order: schema version; sample rate; chapter numbering (1-based,
    contiguous, no empty chapters); chunk kinds; non-negative finite gaps;
    `samples` int-or-None and positive when present; `take` a positive int;
    global chunk index contiguity 0..N-1 across the whole book; unique `file`.
    """
    if manifest.version != SCHEMA_VERSION:
        raise ManifestError(
            f"manifest.version is {manifest.version!r}, expected {SCHEMA_VERSION}"
        )
    if not isinstance(manifest.sampleRate, int) or isinstance(manifest.sampleRate, bool):
        raise ManifestError(
            f"manifest.sampleRate must be an int, got {manifest.sampleRate!r}"
        )
    if manifest.sampleRate <= 0:
        raise ManifestError(f"manifest.sampleRate must be > 0, got {manifest.sampleRate}")
    if not isinstance(manifest.sentencesDir, str) or not manifest.sentencesDir:
        raise ManifestError("manifest.sentencesDir must be a non-empty string")
    if not manifest.chapters:
        raise ManifestError("manifest.chapters is empty: there is no book to assemble")

    expected_index = 0
    seen_files: dict[str, int] = {}

    for pos, chapter in enumerate(manifest.chapters):
        want = pos + 1
        if not isinstance(chapter.index, int) or isinstance(chapter.index, bool):
            raise ManifestError(
                f"chapters[{pos}].index must be an int, got {chapter.index!r}"
            )
        if chapter.index != want:
            raise ManifestError(
                f"chapters[{pos}].index is {chapter.index}, expected {want}: chapter "
                f"numbers must be 1-based and contiguous"
            )
        if not isinstance(chapter.title, str):
            raise ManifestError(
                f"chapters[{pos}].title must be a string, got {type(chapter.title).__name__}"
            )
        if chapter.doc is not None and not isinstance(chapter.doc, str):
            raise ManifestError(
                f"chapters[{pos}].doc must be a string or null, got {chapter.doc!r}"
            )
        if not chapter.chunks:
            raise ManifestError(
                f"chapter {chapter.index} has no chunks: a chapter with no audio would "
                f"produce a chapter marker over silence"
            )

        for kpos, chunk in enumerate(chapter.chunks):
            where = f"chapter {chapter.index} chunk[{kpos}]"
            if not isinstance(chunk.index, int) or isinstance(chunk.index, bool):
                raise ManifestError(f"{where}.index must be an int, got {chunk.index!r}")
            if chunk.index != expected_index:
                raise ManifestError(
                    f"{where}.index is {chunk.index}, expected {expected_index}: chunk "
                    f"indices must cover 0..N-1 across the book with no holes and no "
                    f"repeats"
                )
            expected_index += 1

            if not isinstance(chunk.text, str):
                raise ManifestError(
                    f"{where}.text must be a string, got {type(chunk.text).__name__}"
                )
            if chunk.kind not in CHUNK_KINDS:
                raise ManifestError(
                    f"{where}.kind is {chunk.kind!r}, expected one of {CHUNK_KINDS}"
                )
            if not isinstance(chunk.file, str) or not chunk.file:
                raise ManifestError(f"{where}.file must be a non-empty string")

            for gap_name in ("gapBefore", "gapAfter"):
                gap = getattr(chunk, gap_name)
                if isinstance(gap, bool) or not isinstance(gap, (int, float)):
                    raise ManifestError(
                        f"{where}.{gap_name} must be a number, got {gap!r}"
                    )
                if gap != gap or gap in (float("inf"), float("-inf")):
                    raise ManifestError(f"{where}.{gap_name} is not finite: {gap!r}")
                if gap < 0:
                    raise ManifestError(f"{where}.{gap_name} is negative: {gap!r}")

            if chunk.samples is not None:
                if isinstance(chunk.samples, bool) or not isinstance(chunk.samples, int):
                    raise ManifestError(
                        f"{where}.samples must be an int or null, got {chunk.samples!r}"
                    )
                if chunk.samples <= 0:
                    raise ManifestError(
                        f"{where}.samples is {chunk.samples}: a rendered chunk of zero "
                        f"length is a damaged file, not silence ({chunk.file})"
                    )

            if isinstance(chunk.take, bool) or not isinstance(chunk.take, int):
                raise ManifestError(f"{where}.take must be an int, got {chunk.take!r}")
            if chunk.take < 1:
                raise ManifestError(f"{where}.take must be >= 1, got {chunk.take}")

            # Separators only, NOT case: ext4 and APFS are case-sensitive, so
            # `0.flac` and `0.FLAC` are two different files on the machines that
            # render these books, and folding them together here would reject a
            # legitimate manifest.
            key = chunk.file.replace("\\", "/")
            if key in seen_files:
                raise ManifestError(
                    f"{where}.file {chunk.file!r} is already used by chunk "
                    f"{seen_files[key]}: two chunks cannot share one audio file"
                )
            seen_files[key] = chunk.index


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def flat_chunks(manifest: Manifest) -> list[Chunk]:
    """Every chunk in the book, in global index order."""
    out: list[Chunk] = []
    for chapter in manifest.chapters:
        out.extend(chapter.chunks)
    return out


def iter_chapter_chunks(manifest: Manifest) -> Iterator[tuple[Chapter, Chunk]]:
    """(chapter, chunk) pairs in global index order."""
    for chapter in manifest.chapters:
        for chunk in chapter.chunks:
            yield chapter, chunk


def chunk_path(manifest: Manifest, chunk: Chunk) -> str:
    """The absolute path of a chunk's audio file.

    `Chunk.file` is relative to `source.processDir`, which is ABSOLUTE and travels
    inside the manifest. Nothing about where the manifest JSON happens to sit can
    change what a chunk points at, so a manifest can be written anywhere, copied,
    or held only in memory and still resolve to the same audio.

    (It used to be relative to the manifest's own directory, with `save()`
    repointing a hidden `baseDir` field. That made `narrator manifest --out
    C:\\anywhere\\m.json` silently resolve every chunk under C:\\anywhere.)

    An absolute `file` - written when the sentences directory is on a different
    drive from the session, where no relative path exists - passes through.
    """
    if os.path.isabs(chunk.file):
        return os.path.normpath(chunk.file)
    if not manifest.source.processDir:
        raise ManifestError(
            f"chunk {chunk.index} has the relative path {chunk.file!r} but the "
            f"manifest's source.processDir is empty, so there is nothing to resolve "
            f"it against"
        )
    return os.path.normpath(os.path.join(manifest.source.processDir, chunk.file))


def total_samples(manifest: Manifest) -> int:
    """Sum of every chunk's samples. Raises if any chunk is unrendered, because
    every consumer of this number (VTT timing, chapter markers, the duration
    guard) would otherwise draw a confidently short conclusion."""
    total = 0
    for chunk in flat_chunks(manifest):
        if chunk.samples is None:
            raise ManifestError(
                f"chunk {chunk.index} has no sample count ({chunk.file}): the book is "
                f"not fully rendered"
            )
        total += chunk.samples
    return total
