"""Render-side: the session store, the worker, resume, retakes, progress.

Session layout v1 is exactly today's, byte for byte. `SESSION_READERS.md`
enumerates every file in BookForge and ebook2audiobook that reads a part of it -
which is what proves nothing here moved - and `PORT_NOTES.md` records what was
ported, what deliberately differs, and every e2a defect reproduced rather than
repaired.

    session_v1     an e2a session directory -> a render Manifest (for assembly)
    session_store  session-state.json I/O, the resume scan, listing
    worker         the render loop, the signal handlers, the parent watchdog
    retake         Studio's per-sentence re-render: indices, takes, overrides
    flac_header    STREAMINFO, read from the bytes - never decoded, never ffprobe

There is deliberately no `gaps` module: the worker realizes no gap. Every gap is
PCM inside the chunk's own FLAC, put there by `engine/prompt.py:_classify_gap`
and `engine/audio.py:_save_audio`. See `assemble/README.md` section 1.
"""
