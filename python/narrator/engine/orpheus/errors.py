"""Engine-wide exception types and the poisoned-CUDA test.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py
(TokenStreamMisaligned, _FATAL_CUDA_MARKERS, is_fatal_cuda_error) and
lib/classes/tts_engines/orpheus_stream_decode.py (StreamDecodeMisaligned is
re-exported from narrator.engine.snac, which owns it).

No torch, no vLLM, no mlx: importable anywhere.
"""


class TokenStreamMisaligned(ValueError):
    """The model emitted an audio-token stream whose codes don't fit their
    positional slots (see _redistribute_codes). Sampling is stochastic, so a
    single re-render usually fixes it - but the malformed codes must NEVER
    reach the GPU, where they trigger a device-side assert that poisons the
    CUDA context for the rest of the process."""


# Error-message markers that mean the CUDA context is dead for THIS PROCESS -
# every subsequent CUDA call will fail instantly, so continuing sentence-by-
# sentence just burns the rest of the book in a fast error loop (2026-07-05:
# 1034 sentences "failed" in seconds after one device-side assert). The only
# recovery is a fresh process; callers must re-raise, letting the worker die
# so BookForge's retry machinery respawns it and resumes from files on disk.
_FATAL_CUDA_MARKERS = (
    'device-side assert',
    'illegal memory access',
    'unspecified launch failure',
    'context is destroyed',
)


def is_fatal_cuda_error(err: BaseException) -> bool:
    """True if `err` indicates a poisoned CUDA context (unrecoverable in-process)."""
    msg = str(err)
    return any(marker in msg for marker in _FATAL_CUDA_MARKERS)
