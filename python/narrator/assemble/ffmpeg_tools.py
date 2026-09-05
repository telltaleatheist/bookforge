"""Locating and driving ffmpeg/ffprobe.

The binary comes from an explicit argument or `shutil.which` - never a hardcoded
path, because the three machines that run this put it in three different places
(chocolatey on Windows, apt in WSL, homebrew on the Mac).

NO FALLBACKS: an ffmpeg that is not on PATH and was not named is a hard error
naming what was looked for, not a silent skip of the encode.
"""

from __future__ import annotations

import os
import shutil
import subprocess


class FfmpegError(RuntimeError):
    """An ffmpeg/ffprobe invocation failed. Carries the tail of its stderr."""


def resolve_binary(name: str, explicit: str | None = None) -> str:
    """Absolute path to `ffmpeg` or `ffprobe`."""
    if explicit:
        if os.path.isfile(explicit):
            return os.path.abspath(explicit)
        found = shutil.which(explicit)
        if found:
            return found
        raise FfmpegError(f"{name} was given as {explicit!r} but that is not an executable")
    found = shutil.which(name)
    if found:
        return found
    raise FfmpegError(
        f"{name} not found on PATH and no explicit path was given (pass --{name})"
    )


def run(cmd: list[str], what: str) -> subprocess.CompletedProcess:
    """Run an ffmpeg/ffprobe command, raising with its stderr tail on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    if proc.returncode != 0:
        raise FfmpegError(
            f"{what} failed (exit {proc.returncode}):\n"
            f"  command: {' '.join(cmd)}\n"
            f"  stderr: {(proc.stderr or '').strip()[-1200:]}"
        )
    return proc


def probe_duration(path: str, ffprobe: str) -> float:
    """Container duration in seconds.

    Raises rather than returning 0.0 for an unreadable file: a zero does not look
    like an error to any caller, it looks like silence, and both duration guards
    would then pass a truncated audiobook.
    """
    if not os.path.isfile(path):
        raise FfmpegError(f"probe_duration(): file not found: {path}")
    proc = run(
        [
            ffprobe, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nokey=1:noprint_wrappers=1",
            path,
        ],
        f"ffprobe of {os.path.basename(path)}",
    )
    raw = (proc.stdout or "").strip()
    try:
        value = float(raw)
    except ValueError:
        raise FfmpegError(
            f"probe_duration(): ffprobe reported no usable duration for {path} "
            f"(got {raw!r})"
        ) from None
    if value <= 0:
        raise FfmpegError(f"probe_duration(): {path} reports a duration of {value}s")
    return value


def write_concat_list(paths: list[str], list_path: str) -> str:
    """An ffmpeg concat-demuxer list.

    Paths are written with forward slashes exactly as e2a writes them
    (lib/core.py:4114 `path.replace(os.sep, '/')`); ffmpeg accepts them on
    Windows and it keeps the list readable when a session is inspected from WSL.
    Single quotes inside a path are escaped in the demuxer's own spelling
    (`'\\''`) - e2a does not do this and would produce an unparseable list for a
    book whose title carries an apostrophe.

    The write is FLUSHED AND FSYNCED before the handle closes, and the result is
    checked back off the filesystem. The next thing that happens to this file is
    that a separate ffmpeg process opens it by name, and "I wrote it" and "another
    process can read it" are not the same statement on Windows.
    """
    if not paths:
        raise FfmpegError(f"write_concat_list(): nothing to write into {list_path}")
    parent = os.path.dirname(os.path.abspath(list_path))
    if not os.path.isdir(parent):
        raise FfmpegError(
            f"write_concat_list(): {parent} is not a directory, so {list_path} "
            f"cannot be written"
        )
    with open(list_path, "w", encoding="utf-8", newline="\n") as f:
        for p in paths:
            safe = p.replace(os.sep, "/").replace("'", "'\\''")
            f.write(f"file '{safe}'\n")
        f.flush()
        os.fsync(f.fileno())
    if not os.path.isfile(list_path) or os.path.getsize(list_path) == 0:
        raise FfmpegError(
            f"write_concat_list(): {list_path} is missing or empty immediately "
            f"after writing {len(paths)} entries - something else is writing into "
            f"this working directory"
        )
    return list_path
