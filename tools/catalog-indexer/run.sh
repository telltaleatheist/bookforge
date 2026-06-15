#!/bin/sh
# BookForge catalog indexer — cron entrypoint (Triton).
#
# Regenerates catalog.json on the public mirror from upstream (HuggingFace voice
# tree + Stanza manifest). On any failure (upstream unreachable or the build's
# sanity guard tripping) build_catalog.py exits non-zero and leaves the previous
# catalog.json untouched; cron then mails the logged output.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  echo "===== run $NOW ====="
  CATALOG_NOW="$NOW" /usr/bin/python3 build_catalog.py
  echo "exit: $?"
} >> "$DIR/catalog-indexer.log" 2>&1
