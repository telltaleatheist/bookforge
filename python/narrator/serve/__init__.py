"""narrator.serve - the resident Orpheus streaming worker.

Ported from BookForge@3b4d0b17 electron/scripts/orpheus_stream.py, which spawned
a Python process against an ebook2audiobook checkout. It now lives beside the
engine it drives:

    python -m narrator.serve            # WSL: /opt/orpheus/bin/python -m narrator.serve

The stdin/stdout JSON-lines protocol is UNCHANGED - electron/orpheus-worker-pool.ts
parses it and was not touched. See worker.py's docstring for the full message set.
"""
from .worker import OrpheusStreamServer, main

__all__ = ['OrpheusStreamServer', 'main']
