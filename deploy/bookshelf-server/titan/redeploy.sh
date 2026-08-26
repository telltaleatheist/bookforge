#!/bin/sh
# Rebuild + restart the bookshelf mirror from a freshly staged context tarball.
# Run as owenmorgan (docker group) — no root needed once membership exists.
#   1. From the PC: build BookForge (npm run build:electron), tar the context,
#      scp it to /volume1/System/bookshelf-server/bookshelf-server-context.tgz
#   2. Here: sh /volume1/System/bookshelf-server/redeploy.sh
set -e
cd /volume1/System/bookshelf-server/context
tar -xzf ../bookshelf-server-context.tgz
docker compose -f /volume1/System/bookshelf-server/compose.yml build
docker compose -f /volume1/System/bookshelf-server/compose.yml up -d
docker ps --filter name=bookforge-bookshelf --format '{{.Names}} {{.Status}}'
