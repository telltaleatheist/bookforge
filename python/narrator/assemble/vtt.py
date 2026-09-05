"""The VTT transcript, built from the manifest's sample counts.

Ported from ebook2audiobook@9daab0ba bookforge_ext/parallel/session.py:build_vtt_file
(the copy the reassembly bridge actually reaches, via handlers.py's --assemble_only
branch) and lib/conf_models.py:vtt_cue_text / SML_UNSPOKEN_PATTERN.

WHAT E2A ACTUALLY WRITES - measured, not assumed:

    WEBVTT<LF><LF>
    HH:MM:SS.mmm --> HH:MM:SS.mmm<LF>
    <cue text><LF>
    <LF>
    HH:MM:SS.mmm --> HH:MM:SS.mmm<LF>
    ...

One block per RENDERED CHUNK, in global index order, with no cue identifiers and
no NOTE blocks. Blocks are joined with a single LF and each block already ends in
one, which is what produces the blank line between them; the file therefore ends
with a single LF after the last cue text.

LINE ENDINGS - A DECLARED DEVIATION. e2a opens the file with plain
`open(vtt_path, 'w', encoding='utf-8')` and no `newline=` argument
(bookforge_ext/parallel/session.py:932), so Python's text layer translates every
LF to CRLF when the assembly runs on WINDOWS, and leaves LF when it runs in WSL
or on the Mac. e2a's VTT line endings are therefore a property of the machine
that happened to assemble the book, not of the format.

narrator writes LF on every platform, deliberately. The parity claim for the VTT
is CUE-LEVEL - identical cue count, identical cue text, cue times within 1 ms -
and explicitly NOT byte-level. Three reasons this is safe: the reassembly
bridge's own cue regex (`reassembly-bridge.ts:36`) matches LF output; WebVTT
permits either terminator; and the sidecar a reader ends up with is regenerated
from the m4b's mov_text track anyway (`electron/sidecar-migration.ts`), so the
bytes narrator writes here are never the bytes that ship.

DIVERGENCE FROM docs/NARRATOR_PLAN.md, DELIBERATE. The plan (contract 5) and
CONTRACTS.md both describe "cue index = sentence index" and "`NOTE heading` /
`NOTE asr-fallback` blocks". Neither exists in ebook2audiobook@9daab0ba: a grep
for `NOTE ` across lib/ and bookforge_ext/ returns nothing, and neither
build_vtt_file writes a cue identifier. Emitting them would break the byte parity
the same contract demands, so this reproduces what e2a writes and the difference
is reported rather than invented.

CUE TEXT. Markers stripped with the unspoken-tag pattern, whitespace collapsed,
and BOLD when the row is a heading - in WebVTT's own spelling, `<b>...</b>`. No
classes and no STYLE block: `<b>` is the portable form every WebVTT reader
understands, and ffmpeg turns it into a real tx3g `styl` record with the bold
face-style flag when the transcript is muxed into the m4b. An empty payload stays
empty: a bare `[break]` row must never become `<b></b>`.

TIMING. A running float sum of `samples / sampleRate` plus the manifest's
realized gaps, accumulated in exactly the order and the arithmetic e2a uses, so
the two cannot differ by a rounding step. For an e2a session every gap is 0.0 and
the sum is the sentence headers alone.
"""

from __future__ import annotations

import os
import re

from ..manifest import Manifest, flat_chunks

#: Copied from ebook2audiobook@9daab0ba lib/conf_models.py:102-105.
SML_UNSPOKEN_PATTERN = re.compile(
    r"\[/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]",
    re.IGNORECASE,
)


def format_timestamp(seconds: float) -> str:
    """`HH:MM:SS.mmm`, byte-for-byte as e2a's format_timestamp writes it.

    Ported from bookforge_ext/parallel/session.py:909-913. The float arithmetic
    (`//`, `%`) is reproduced rather than improved on: an integer-sample
    computation would be marginally more accurate and would therefore DIFFER from
    e2a in the last digit on some cues, which is the one thing parity forbids.
    """
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{int(h):02}:{int(m):02}:{s:06.3f}"


def cue_text(text: str, is_heading: bool) -> str:
    """The payload of one cue.

    Ported from ebook2audiobook@9daab0ba lib/conf_models.py:vtt_cue_text. The
    heading test runs on the STORED text there, before stripping; here the
    manifest has already recorded the answer as `chunk.kind`, so the two cannot
    drift and the strip order stops mattering.
    """
    stripped = re.sub(r"\s+", " ", SML_UNSPOKEN_PATTERN.sub("", text)).strip()
    if is_heading and stripped:
        return f"<b>{stripped}</b>"
    return stripped


def build_vtt(manifest: Manifest) -> str:
    """The complete VTT document for a manifest, as a string.

    Raises when a chunk has no sample count: an unrendered chunk timed as 0.0
    would slide every later cue earlier by that chunk's true length and desync
    the whole transcript from there on.
    """
    chunks = flat_chunks(manifest)
    if not chunks:
        raise ValueError("build_vtt(): the manifest has no chunks")

    rate = manifest.sampleRate
    blocks = []
    current_time = 0.0
    for chunk in chunks:
        if chunk.samples is None:
            raise ValueError(
                f"build_vtt(): chunk {chunk.index} has no sample count ({chunk.file}); "
                f"the book is not fully rendered"
            )
        start_time = current_time + chunk.gapBefore
        end_time = start_time + chunk.samples / rate
        current_time = end_time + chunk.gapAfter

        text = cue_text(chunk.text, chunk.kind == "heading")
        blocks.append(
            f"{format_timestamp(start_time)} --> {format_timestamp(end_time)}\n{text}\n"
        )

    return "WEBVTT\n\n" + "\n".join(blocks)


def write_vtt(manifest: Manifest, path: str) -> str:
    """Write the VTT to `path` (UTF-8, LF line endings) and return the path.

    `newline=""` keeps Python from translating the LFs to CRLF on Windows. That
    makes narrator's output platform-independent and e2a's not - see the module
    docstring, "LINE ENDINGS - A DECLARED DEVIATION". It is the one place the VTT
    is deliberately not byte-identical to e2a's.
    """
    content = build_vtt(manifest)
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        raise ValueError(f"write_vtt(): {parent} is not a directory")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    return path


def vtt_duration(manifest: Manifest) -> float:
    """The end time of the last cue - the transcript's own idea of the book's
    length. The reassembly bridge compares this against the finished m4b and
    refuses to promote a file more than 5 s shorter."""
    rate = manifest.sampleRate
    total = 0.0
    for chunk in flat_chunks(manifest):
        if chunk.samples is None:
            raise ValueError(
                f"vtt_duration(): chunk {chunk.index} has no sample count ({chunk.file})"
            )
        total += chunk.gapBefore + chunk.samples / rate + chunk.gapAfter
    return total
