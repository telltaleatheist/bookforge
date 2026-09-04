"""Session layout v1 (today's ebook2audiobook session directory) -> Manifest.

Ported from ebook2audiobook@9daab0ba bookforge_ext/parallel/session.py:
assemble_audiobook (state loading, sentences_dir override, cover resolution) and
lib/core.py:combine_audio_chapters (chapter title resolution by document
identity).

THE ONE RULE ABOUT PATHS. `session-state.json` was written by whichever machine
rendered the book - a WSL guest, a Mac, or Windows - and every path inside it
(`session_dir`, `process_dir`, `chapters_dir`, `chapters_dir_sentences`,
`epub_path`) is that machine's. They are NOT trusted. Everything is derived from
the directory this function was HANDED, exactly as e2a's assemble_audiobook does
("Always derive directories from corrected process_dir").

NO FALLBACKS. A missing FLAC, a bad header, a zero sample count, a chapter with
no chunks, a chapter range that does not match `chapter_sentences`: raise, naming
the path.
"""

from __future__ import annotations

import json
import os
import re

from ..manifest import Chapter, Chunk, Manifest, Source, Book, Voice, validate
from .flac_header import read_expected

#: e2a's `default_audio_proc_format`. Every rendered chunk is a FLAC.
AUDIO_PROC_FORMAT = "flac"

#: Orpheus renders at 24 kHz mono. The assembler resamples to 44.1 kHz at the AAC
#: encode, exactly as e2a does; nothing before that point changes the rate.
SAMPLE_RATE = 24000
CHANNELS = 1

#: The tags no engine ever SPEAKS. Copied from ebook2audiobook@9daab0ba
#: lib/conf_models.py:SML_UNSPOKEN_PATTERN. Kept as a literal copy rather than an
#: import because narrator does not depend on the e2a checkout - that is the
#: point of the migration - and this pattern is part of the stored session
#: format, not of e2a's code.
SML_UNSPOKEN_PATTERN = re.compile(
    r"\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]",
    re.IGNORECASE,
)

#: THE test for "this row is a section heading" (e2a lib/conf_models.py:113).
#: It matches ANYWHERE in the row, not only at the leading edge, because
#: get_sentences emits rows like '[break][heading]Chapter 8: State of Confusion.'
#: where a [break] carried over from the paragraph boundary holds position 0.
#: CONTRACTS.md says "leading marker"; measured against real sessions that would
#: misclassify every heading that follows a paragraph break, so the marker is
#: tested for anywhere and the two readings agree on every row that has only one
#: marker. Verified on the Kershaw session, whose chunk 1 is '[break]IAN KERSHAW...'.
SML_HEADING_PATTERN = re.compile(r"\[/?heading\]", re.IGNORECASE)
SML_ITEM_PATTERN = re.compile(r"\[/?item\]", re.IGNORECASE)


class SessionError(RuntimeError):
    """The session directory is not one this reader can build a manifest from."""


def chunk_kind(text: str) -> str:
    """`heading`, `item` or `prose` for one stored chunk.

    Heading wins over item: a list item inside a heading row is still a heading
    as far as the VTT's bolding and the chapter marker are concerned, and e2a's
    vtt_cue_text tests for heading first for the same reason.
    """
    if SML_HEADING_PATTERN.search(text):
        return "heading"
    if SML_ITEM_PATTERN.search(text):
        return "item"
    return "prose"


def load_session_state(process_dir: str) -> dict:
    """Read `session-state.json` (e2a's, version 2) from the given directory.

    Note the hyphen: `session_state.json` in the same folder is BookForge's own
    sidecar (runs, rates, settings) and is not ours.
    """
    path = os.path.join(process_dir, "session-state.json")
    if not os.path.isfile(path):
        raise SessionError(f"session-state.json not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        try:
            state = json.load(f)
        except json.JSONDecodeError as e:
            raise SessionError(f"session-state.json is not valid JSON: {path}: {e}") from e
    version = state.get("version")
    if version != 2:
        raise SessionError(
            f"session-state.json is version {version!r}; this reader implements layout "
            f"v1 / state version 2 only: {path}"
        )
    return state


def parse_chapters_arg(chapters_arg: str | None, total_chapters: int) -> list[int] | None:
    """`--chapters` -> 1-based chapter numbers, or None for "auto".

    Ported from ebook2audiobook@9daab0ba bookforge_ext/parallel/session.py:707.
    Absent or empty means every chapter. `auto` returns None, which
    `build_manifest` resolves with `detect_completed_chapters`.

    e2a WARNS and continues on an unparseable part, which silently assembles a
    different book than the caller asked for; this raises instead.
    """
    if not chapters_arg:
        return list(range(1, total_chapters + 1))

    text = chapters_arg.strip().lower()
    if text == "auto":
        return None

    result: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                start, end = part.split("-", 1)
                lo, hi = int(start.strip()), int(end.strip())
            else:
                lo = hi = int(part)
        except ValueError:
            raise SessionError(
                f"--chapters: {part!r} is not a chapter number or range"
            ) from None
        for ch in range(lo, hi + 1):
            if not (1 <= ch <= total_chapters):
                raise SessionError(
                    f"--chapters: chapter {ch} is outside this book's 1..{total_chapters}"
                )
            result.add(ch)
    if not result:
        raise SessionError(f"--chapters: {chapters_arg!r} selected no chapters")
    return sorted(result)


def detect_completed_chapters(sentences_dir: str, chapter_sentences: list) -> list[int]:
    """The chapters whose every chunk has audio, as a contiguous run from 1.

    Ported from ebook2audiobook@9daab0ba bookforge_ext/parallel/session.py:755.
    It stops at the FIRST incomplete chapter rather than skipping it, because
    chapters render in order and a later complete chapter over an earlier gap
    would be an audiobook with a hole in the middle.
    """
    completed = []
    offset = 0
    for i, chapter in enumerate(chapter_sentences):
        for j in range(len(chapter)):
            if not os.path.isfile(
                os.path.join(sentences_dir, f"{offset + j}.{AUDIO_PROC_FORMAT}")
            ):
                return completed
        completed.append(i + 1)
        offset += len(chapter)
    return completed


def _required_str(state: dict, key: str, process_dir: str) -> str:
    """A session field that must be present and non-empty.

    NO FALLBACKS: every one of these used to be `state.get(k) or "<something>"`,
    and each substitution turned a malformed session into a book rendered under
    the wrong assumption rather than an error naming the field.
    """
    value = state.get(key)
    if not isinstance(value, str) or not value:
        raise SessionError(
            f"session-state.json {key!r} is required and must be a non-empty string, "
            f"got {value!r} ({process_dir})"
        )
    return value


def _resolve_chapter_titles(process_dir: str, state: dict, chapter_sentences: list) -> list[str]:
    """Chapter marker titles, bound to chapters by DOCUMENT IDENTITY.

    Ported from ebook2audiobook@9daab0ba lib/core.py:combine_audio_chapters
    lines 4577-4614.

    NEVER by position: the TOC and the chapter list describe different sets (a
    part-title page has a TOC entry but yields no audio; leading front matter
    yields audio but has no TOC entry) and the counts can coincidentally match
    while the sets differ, so a length check cannot detect the skew.

    A chapter's own FIRST chunk is correct BY CONSTRUCTION - the pipeline voices
    the heading as that chapter's first chunk - so it is what an unmatched
    chapter falls back to. The title is kept RAW here, markers and all; the
    ffmetadata writer sanitizes it, exactly as e2a does.
    """
    own_titles = [
        chapter[0] if chapter else f"Chapter {i + 1}"
        for i, chapter in enumerate(chapter_sentences)
    ]

    chapter_docs = list(state.get("chapter_docs", []))
    titles_by_doc = dict(state.get("chapter_titles_by_doc", {}))

    # Assembly can run in a different process than prepare, so recover the
    # provenance from process_dir when the state file does not carry it.
    if len(chapter_docs) != len(chapter_sentences):
        provenance_path = os.path.join(process_dir, "chapter-provenance.json")
        if os.path.isfile(provenance_path):
            with open(provenance_path, "r", encoding="utf-8") as f:
                provenance = json.load(f)
            chapter_docs = list(provenance.get("chapter_docs", []))
            titles_by_doc = dict(provenance.get("chapter_titles_by_doc", {}))

    if len(chapter_docs) != len(chapter_sentences):
        print(
            f"[ASSEMBLE] Chapter provenance unusable: {len(chapter_docs)} chapter_docs "
            f"entries for {len(chapter_sentences)} chapters. Using each chapter's OWN "
            f"first chunk as its marker title. TOC titles are deliberately NOT paired by "
            f"position - that pairing is what mislabelled chapters.",
            flush=True,
        )
        return own_titles

    titles = []
    from_toc = 0
    for i, doc_name in enumerate(chapter_docs):
        toc_title = titles_by_doc.get(doc_name)
        if toc_title:
            titles.append(toc_title)
            from_toc += 1
        else:
            titles.append(own_titles[i])
    print(
        f"[ASSEMBLE] {from_toc}/{len(chapter_sentences)} chapter titles resolved from the "
        f"TOC by document identity; {len(chapter_sentences) - from_toc} from the chapter's "
        f"own first chunk",
        flush=True,
    )
    return titles


def _resolve_chapter_docs(process_dir: str, state: dict, count: int) -> list[str | None]:
    docs = list(state.get("chapter_docs", []))
    if len(docs) != count:
        provenance_path = os.path.join(process_dir, "chapter-provenance.json")
        if os.path.isfile(provenance_path):
            with open(provenance_path, "r", encoding="utf-8") as f:
                docs = list(json.load(f).get("chapter_docs", []))
    if len(docs) != count:
        return [None] * count
    return list(docs)


def _resolve_cover(process_dir: str, state: dict) -> str | None:
    """The cover image to embed, as a PATH or None.

    Ported from ebook2audiobook@9daab0ba bookforge_ext/parallel/session.py:1042-1070.

    THE THREE STATES, and what each one means (e2a `lib/core.py:get_cover`, :772):

      - `cover` is a STRING: the EPUB carried cover art, and get_cover already
        wrote it to `<filename_noext>.jpg` in the process dir. That file must
        exist; if it does not, this raises. (e2a instead hands the path straight
        to `open()` in finalize_export and dies there with a bare
        FileNotFoundError, after the whole book has been encoded.)
      - `cover` is `True`: the EPUB carried NO cover art. It does NOT mean the
        audiobook ends up bare - BookForge stages its own chosen artwork at
        `<process_dir>/cover.jpg`, and that is the usual case. Kershaw and
        Mutineer are both `cover: true` with a staged `cover.jpg`, and e2a's
        reference m4b for each carries an attached picture.
      - `cover` is `True` (or null) with NO staged `cover.jpg`: the book really
        has no artwork and ships bare. This is NOT a fallback and NOT an error -
        it is the answer. Blacksun is exactly this case, and e2a's reference m4b
        for it has no cover stream (verified with ffprobe, 2026-09-04). Refusing
        here would refuse a session e2a assembles correctly.

    `True` must never reach an `open()`: Python's open() accepts an integer fd
    and True == 1, so open(True) opens this process's own stdout and the
    following read() blocks forever on a pipe whose only writer is itself
    (Nuremberg, 2026-08-14). "No cover" is representable exactly one way from
    here down: None.
    """
    raw = state.get("cover")
    filename_noext = state.get("filename_noext")
    if isinstance(raw, str) and filename_noext:
        candidate = os.path.join(process_dir, filename_noext + ".jpg")
        if os.path.isfile(candidate):
            return candidate
        # e2a would hand this path to open() unconditionally. Say what is missing
        # rather than deadlocking or shipping bare.
        raise SessionError(
            f"session-state.json says the epub carried a cover, but the staged image is "
            f"not there: {candidate}"
        )
    if raw is None or isinstance(raw, bool):
        staged = os.path.join(process_dir, "cover.jpg")
        if os.path.isfile(staged):
            print(f"[ASSEMBLE] Using staged cover {staged}", flush=True)
            return staged
        print(
            f"[ASSEMBLE] No cover: the epub carried none and none is staged at "
            f"{staged}. This audiobook ships without artwork.",
            flush=True,
        )
        return None
    raise SessionError(
        f"session-state.json 'cover' must be a path string, a bool sentinel, or null - "
        f"got {type(raw).__name__}: {raw!r}"
    )


def _relative_file(process_dir: str, path: str) -> str:
    """`path` expressed relative to the SESSION's process_dir where it can be.

    That is what `manifest.chunk_path` resolves against (`source.processDir`),
    and it is absolute inside the manifest - so where the manifest JSON is
    written has no bearing on what a chunk points at.

    On Windows a sentences directory can legitimately sit on a different drive
    from the session (an RVC pass writes into %TEMP%), and no relative path
    between two drives exists. Those entries keep their absolute form; the
    manifest's `chunk_path` handles both.
    """
    try:
        rel = os.path.relpath(path, process_dir)
    except ValueError:
        return os.path.abspath(path)
    return rel.replace(os.sep, "/")


def build_manifest(
    process_dir: str,
    sentences_dir: str | None = None,
    chapters: str | None = None,
) -> Manifest:
    """Build a schema-v1 Manifest from an e2a session's process directory.

    `process_dir` is the hash directory:
    `<project>/stages/03-tts/sessions/<lang>/ebook-<uuid>/<epub_content_hash>/`.

    `sentences_dir` is the `--sentences_dir` the reassembly bridge passes when a
    post-processing pass produced a derived set (`chapters/sentences-denoised`,
    `chapters/sentences-rvc-<voice>`, or a temporary gap-normalized directory).
    It overrides ONLY the audio source: the chapter mapping, the metadata and the
    cue text still come from the unchanged session state, exactly as e2a's
    assemble_audiobook does.

    `chapters` is e2a's `--chapters`: absent for the whole book, `"auto"` for the
    chapters whose audio is complete, or a selection like `"1-3"`. The reassembly
    bridge never passes it (it refuses to assemble an incomplete render at all),
    but a partially rendered session is exactly what the `blacksun` golden
    fixture is, so the path is implemented and tested.

    A selection must be a CONTIGUOUS RUN FROM CHAPTER 1. e2a accepts a mid-book
    selection and then writes a wrong VTT for it - its build_vtt_file pairs the
    files it globs (which start at 0) with the SELECTED chapters' texts, so every
    cue carries the wrong text. narrator refuses rather than reproducing that.
    """
    process_dir = os.path.abspath(process_dir)
    if not os.path.isdir(process_dir):
        raise SessionError(f"process_dir is not a directory: {process_dir}")

    state = load_session_state(process_dir)

    # BILINGUAL sessions are the ONE e2a assembly path that inserts silence of
    # its own: combine_bilingual_audio re-cuts the whole book into a single
    # chapter of interleaved source/target chunks with a `bilingual_pause` (0.3 s)
    # between the pair and a `bilingual_gap` (1.0 s) between pairs
    # (bookforge_ext/parallel/session.py:1163-1222). Every timing rule this module
    # and assemble/ rest on - gaps live in the FLAC, a chapter is a pure concat of
    # its chunks - is false there, so it is refused rather than mis-assembled.
    #
    # e2a drives it from `args['bilingual']` and writes NOTHING about it into
    # session-state.json (verified against save_session_state,
    # bookforge_ext/parallel/session.py:54-123), so a session on disk cannot
    # normally be identified as bilingual and narrator exposes no --bilingual
    # flag. This checks the one key a future writer would plausibly use.
    if state.get("bilingual"):
        raise SessionError(
            f"this is a bilingual session, which e2a assembles by interleaving "
            f"source/target chunks with inserted pauses. narrator's assembler "
            f"realizes no silence of its own and would produce the wrong timings "
            f"({process_dir})"
        )

    chapter_sentences = state.get("chapter_sentences")
    if not chapter_sentences:
        raise SessionError(
            f"session-state.json has no chapter_sentences: there is no book to assemble "
            f"({process_dir})"
        )

    if sentences_dir:
        resolved_sentences = os.path.abspath(sentences_dir)
        if not os.path.isdir(resolved_sentences):
            raise SessionError(f"sentences directory not found: {resolved_sentences}")
        print(f"[ASSEMBLE] Using overridden sentences_dir: {resolved_sentences}", flush=True)
    else:
        resolved_sentences = os.path.join(process_dir, "chapters", "sentences")
        if not os.path.isdir(resolved_sentences):
            raise SessionError(f"sentences directory not found: {resolved_sentences}")

    # ------------------------------------------------------------------
    # Cross-check the chapter ranges the state declares against the chapter
    # texts it stores. They are two independent records of the same fact and a
    # disagreement slides every later chapter onto the wrong audio, silently.
    # ------------------------------------------------------------------
    # Both records are REQUIRED. Skipping the check when the key is absent makes
    # the guard evaporate on exactly the malformed state file it exists to catch.
    if "chapters" not in state:
        raise SessionError(
            f"session-state.json has no 'chapters' ranges to cross-check "
            f"chapter_sentences against ({process_dir})"
        )
    declared = state["chapters"]
    if len(declared) != len(chapter_sentences):
        raise SessionError(
            f"session-state.json disagrees with itself: 'chapters' has "
            f"{len(declared)} entries but 'chapter_sentences' has "
            f"{len(chapter_sentences)} ({process_dir})"
        )
    offset = 0
    for i, entry in enumerate(declared):
        want_start = offset
        want_end = offset + len(chapter_sentences[i]) - 1
        got_start = entry["sentence_start"]
        got_end = entry["sentence_end"]
        if (got_start, got_end) != (want_start, want_end):
            raise SessionError(
                f"session-state.json chapter {i + 1} declares sentences "
                f"{got_start}-{got_end} but its chapter_sentences run "
                f"{want_start}-{want_end} ({process_dir})"
            )
        offset += len(chapter_sentences[i])

    if "total_sentences" not in state:
        raise SessionError(
            f"session-state.json has no 'total_sentences' ({process_dir})"
        )
    total_sentences = state["total_sentences"]
    flat_count = sum(len(c) for c in chapter_sentences)
    if total_sentences != flat_count:
        raise SessionError(
            f"session-state.json declares total_sentences={total_sentences} but its "
            f"chapter_sentences hold {flat_count} chunks ({process_dir})"
        )

    titles = _resolve_chapter_titles(process_dir, state, chapter_sentences)
    docs = _resolve_chapter_docs(process_dir, state, len(chapter_sentences))

    # ------------------------------------------------------------------
    # Which chapters this manifest covers.
    # ------------------------------------------------------------------
    selected = parse_chapters_arg(chapters, len(chapter_sentences))
    if selected is None:
        print("[ASSEMBLE] Auto-detecting completed chapters...", flush=True)
        selected = detect_completed_chapters(resolved_sentences, chapter_sentences)
        if not selected:
            raise SessionError(
                f"no completed chapters found in {resolved_sentences}: the render has "
                f"not finished a single chapter"
            )
        print(
            f"[ASSEMBLE] Found {len(selected)} completed chapters: "
            f"{selected[0]}-{selected[-1]}",
            flush=True,
        )
    if selected != list(range(1, len(selected) + 1)):
        raise SessionError(
            f"chapter selection {selected} is not a contiguous run from chapter 1. "
            f"A manifest's chunk indices are GLOBAL and must cover 0..N-1, and e2a's "
            f"own VTT is wrong for a mid-book selection (it pairs files from index 0 "
            f"with the selected chapters' texts). Refusing rather than reproducing that."
        )
    if len(selected) < len(chapter_sentences):
        print(
            f"[ASSEMBLE] Partial assembly: chapters {selected[0]}-{selected[-1]} of "
            f"{len(chapter_sentences)}",
            flush=True,
        )
        chapter_sentences = chapter_sentences[: len(selected)]
        titles = titles[: len(selected)]
        docs = docs[: len(selected)]

    # ------------------------------------------------------------------
    # Chapters -> chunks, with global indices and exact sample counts.
    # ------------------------------------------------------------------
    chapters_out: list[Chapter] = []
    global_index = 0
    for ci, texts in enumerate(chapter_sentences):
        if not texts:
            raise SessionError(
                f"chapter {ci + 1} has no chunks in session-state.json: a chapter with no "
                f"audio would produce a chapter marker over silence ({process_dir})"
            )
        chunks: list[Chunk] = []
        for text in texts:
            audio_path = os.path.join(
                resolved_sentences, f"{global_index}.{AUDIO_PROC_FORMAT}"
            )
            if not os.path.isfile(audio_path):
                raise SessionError(
                    f"chapter {ci + 1} is missing chunk audio {audio_path}"
                )
            info = read_expected(audio_path, SAMPLE_RATE, CHANNELS)
            chunks.append(
                Chunk(
                    index=global_index,
                    text=text,
                    kind=chunk_kind(text),
                    file=_relative_file(process_dir, audio_path),
                    # Every gap is already inside `samples`. See assemble/README.md.
                    gapBefore=0.0,
                    gapAfter=0.0,
                    samples=info.samples,
                    take=1,
                )
            )
            global_index += 1
        chapters_out.append(
            Chapter(index=ci + 1, title=titles[ci], doc=docs[ci], chunks=chunks)
        )

    metadata = state.get("metadata", {})
    bf_metadata = state.get("bookforge_metadata", {})

    # e2a's precedence (session.py:1087-1110): the state's own metadata, then
    # bookforge_metadata over it, then a year recovered from `published`.
    title = bf_metadata.get("title") or metadata.get("title")
    if not title:
        filename_noext = state.get("filename_noext")
        if not filename_noext:
            raise SessionError(
                f"session-state.json has neither a title nor a filename_noext to build "
                f"one from ({process_dir})"
            )
        title = filename_noext.replace("_", " ")
    author = bf_metadata.get("author") or metadata.get("creator")
    if not author:
        raise SessionError(
            f"session-state.json has no author: neither bookforge_metadata.author nor "
            f"metadata.creator is set. The author is part of the output filename and "
            f"of the m4b's artist tag ({process_dir})"
        )
    year = bf_metadata.get("year") or metadata.get("year")
    if not year:
        published = metadata.get("published")
        if isinstance(published, str) and len(published) >= 4:
            year = published[:4]
    year = str(year) if year else None

    epub_path = None
    filename_noext = state.get("filename_noext")
    if filename_noext:
        candidate = os.path.join(process_dir, filename_noext + ".epub")
        if os.path.isfile(candidate):
            epub_path = candidate

    manifest = Manifest(
        source=Source(
            kind="e2a-session-v1",
            processDir=process_dir,
            sessionId=state["session_id"],
            epubContentHash=state["epub_content_hash"],
        ),
        book=Book(
            epubPath=epub_path,
            title=title,
            author=author,
            year=year,
            language=_required_str(state, "language_iso1", process_dir),
            language3=_required_str(state, "language", process_dir),
            cover=_resolve_cover(process_dir, state),
        ),
        voice=Voice(
            engine=_required_str(state, "tts_engine", process_dir),
            # NEVER default this. e2a's own default is the literal 'internal',
            # which is the value CLAUDE.md records as KeyError-ing for Orpheus
            # (the voice is passed in --fine_tuned), so substituting it turns a
            # missing field into a crash three layers away.
            fineTuned=_required_str(state, "fine_tuned", process_dir),
            modelDir=state.get("orpheus_model_dir"),
            adapterDir=state.get("orpheus_adapter_dir"),
            baseDir=state.get("orpheus_base_dir"),
        ),
        sampleRate=SAMPLE_RATE,
        sentencesDir=resolved_sentences,
        chapters=chapters_out,
    )
    validate(manifest)
    return manifest
