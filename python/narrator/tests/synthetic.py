"""Build a synthetic e2a session directory with REAL FLACs.

Real files, not mocks: the whole point of the FLAC header reader, the
homogeneity guard and the duration guards is that they read bytes, so a test
that hands them a fake learns nothing.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess

import numpy as np
import soundfile as sf

SAMPLE_RATE = 24000

#: A 1x1 JPEG. Only has to EXIST for the cover-resolution tests; the end-to-end
#: assembly test generates a real one with ffmpeg instead.
TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAA"
    "AQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQR"
    "BRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RF"
    "RkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip"
    "qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEB"
    "AAA/APn+iiiiiiiiv//Z"
)


def write_flac(path: str, seconds: float, freq: float = 220.0,
               sample_rate: int = SAMPLE_RATE, channels: int = 1) -> int:
    """A short tone with a little trailing silence, so the file is real audio and
    its sample count is exactly what we asked for. Returns the sample count."""
    n = int(round(seconds * sample_rate))
    if n <= 0:
        raise ValueError(f"write_flac(): {seconds}s is not a positive length")
    t = np.arange(n, dtype=np.float64) / sample_rate
    # Fade the last 10% to zero so the file ends quietly, like a rendered chunk.
    env = np.ones(n)
    tail = max(1, n // 10)
    env[-tail:] = np.linspace(1.0, 0.0, tail)
    mono = (0.25 * np.sin(2 * np.pi * freq * t) * env)
    data = mono if channels == 1 else np.repeat(mono[:, None], channels, axis=1)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, data, sample_rate, subtype="PCM_16", format="FLAC")
    return n


#: The synthetic book: three chapters, exercising every marker kind, a bare
#: [break] row (which becomes an empty VTT cue) and a heading that is preceded by
#: a [break] carried over from a paragraph boundary.
CHAPTER_SENTENCES = [
    [
        "[heading]Chapter One. The Opening.",
        "[break]The first paragraph begins here.",
        "A second sentence follows it.",
    ],
    [
        "[break][heading]Chapter Two: A Heading After A Break.",
        "[item]The first list item.",
        "[item]The second list item.",
        "Plain prose to finish.",
    ],
    [
        "[heading]Chapter Three.",
        "One last line.",
        "[break]",
    ],
]

CHAPTER_DOCS = ["text/c0001.xhtml", "text/c0002.xhtml", "text/c0003.xhtml"]
CHAPTER_TITLES_BY_DOC = {
    "text/c0001.xhtml": "The Opening",
    # c0002 deliberately absent: that chapter must fall back to its own first row.
    "text/c0003.xhtml": "The End",
}

#: One duration per chunk, in the same flat order. Deliberately uneven.
CHUNK_SECONDS = [1.5, 2.25, 0.75, 1.0, 0.5, 0.5, 2.0, 1.25, 0.9, 0.1]


def build_session(
    root: str,
    *,
    chapter_sentences=None,
    with_cover: bool = True,
    sentences_subdir: str = os.path.join("chapters", "sentences"),
    chunk_seconds=None,
    chapter_docs=None,
    titles_by_doc=None,
    write_provenance: bool = False,
) -> str:
    """Create a process_dir under `root` and return it."""
    chapter_sentences = chapter_sentences or CHAPTER_SENTENCES
    chunk_seconds = chunk_seconds or CHUNK_SECONDS
    chapter_docs = CHAPTER_DOCS if chapter_docs is None else chapter_docs
    titles_by_doc = CHAPTER_TITLES_BY_DOC if titles_by_doc is None else titles_by_doc

    process_dir = os.path.join(root, "645fe7068635f759cbda0b8a6d3a348d")
    sentences_dir = os.path.join(process_dir, sentences_subdir)
    os.makedirs(sentences_dir, exist_ok=True)

    flat = [t for chapter in chapter_sentences for t in chapter]
    if len(chunk_seconds) < len(flat):
        raise ValueError(
            f"build_session(): {len(chunk_seconds)} durations for {len(flat)} chunks"
        )
    for i in range(len(flat)):
        write_flac(
            os.path.join(sentences_dir, f"{i}.flac"),
            chunk_seconds[i],
            freq=180.0 + 20.0 * i,
        )

    chapters = []
    offset = 0
    for i, chapter in enumerate(chapter_sentences):
        chapters.append({
            "chapter_num": i + 1,
            "sentence_count": len(chapter),
            "raw_sentence_count": len(chapter),
            "sentence_start": offset,
            "sentence_end": offset + len(chapter) - 1,
        })
        offset += len(chapter)

    state = {
        "version": 2,
        "session_id": "ccd14111-da29-4fb0-a489-a19a0f126bac",
        "epub_content_hash": "6d302f8c08300a7e695e44e1dcbc0209",
        "total_sentences": len(flat),
        "total_chapters": len(chapter_sentences),
        "chapters": chapters,
        "chapter_sentences": chapter_sentences,
        "language": "eng",
        "language_iso1": "en",
        "fine_tuned": "mistborn",
        "orpheus_model_dir": "/home/telltale/orpheus-models/mistborn",
        "orpheus_adapter_dir": None,
        "orpheus_base_dir": None,
        "tts_engine": "orpheus",
        "output_format": "m4b",
        "metadata": {
            "title": "A Synthetic Book",
            "creator": "Test Author",
            "language": "en",
            "published": "1993-01-01T00:00:00.000Z",
        },
        "bookforge_metadata": {
            "title": "A Synthetic Book",
            "author": "Test Author",
            "year": "1993",
        },
        # True == "the epub carried no cover"; the staged cover.jpg is used.
        "cover": True,
        "final_name": "staged-ccd14111-da29-4fb0-a489-a19a0f126bac.m4b",
        "filename_noext": "staged-ccd14111-da29-4fb0-a489-a19a0f126bac",
        "chapter_titles": [titles_by_doc.get(d, "") for d in chapter_docs],
        "chapter_docs": chapter_docs,
        "chapter_titles_by_doc": titles_by_doc,
        # Paths from a DIFFERENT machine, on purpose: the reader must ignore them.
        "session_dir": "/home/telltale/ebook2audiobook/tmp/ebook-ccd14111",
        "process_dir": "/home/telltale/ebook2audiobook/tmp/ebook-ccd14111/645fe70",
        "chapters_dir": "/nonexistent/chapters",
        "chapters_dir_sentences": "/nonexistent/chapters/sentences",
    }
    if write_provenance:
        state.pop("chapter_docs")
        state.pop("chapter_titles_by_doc")
        with open(os.path.join(process_dir, "chapter-provenance.json"), "w",
                  encoding="utf-8") as f:
            json.dump(
                {"chapter_docs": chapter_docs, "chapter_titles_by_doc": titles_by_doc},
                f,
            )

    with open(os.path.join(process_dir, "session-state.json"), "w",
              encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    if with_cover:
        with open(os.path.join(process_dir, "cover.jpg"), "wb") as f:
            f.write(TINY_JPEG)

    return process_dir


def make_real_cover(path: str, ffmpeg: str) -> str:
    """A 320x320 JPEG, made by ffmpeg, for the end-to-end mux."""
    subprocess.run(
        [ffmpeg, "-hide_banner", "-v", "error", "-f", "lavfi",
         "-i", "color=c=navy:s=320x320", "-frames:v", "1", "-y", path],
        check=True, capture_output=True,
    )
    return path
