"""`python -m narrator.serve` - the resident Orpheus streaming worker.

This is the entry point BookForge's spawn targets, replacing
`python electron/scripts/orpheus_stream.py` with an ebook2audiobook checkout on
sys.path:

    wsl.exe -d <distro> --exec /opt/orpheus/bin/python -m narrator.serve

The worker's whole interface is the JSON-lines protocol on stdin/stdout (see
worker.py) and its configuration is the ORPHEUS_* env the pool exports at spawn.
The one command-line argument is `--fake-engine`, the protocol-test door; it is
parsed in worker.main() and anything else is a hard error.
"""
import sys

from .worker import main

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
