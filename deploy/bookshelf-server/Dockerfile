# BookForge Bookshelf — standalone (library-only) server.
#
# Runs the REAL compiled server (dist/electron/bookshelf-server.js) headless via
# cli/serve-bookshelf.js, in standalone mode: the library can be browsed,
# streamed and read, reader state is written under <library>/.bookshelf/, and
# everything that needs the TTS engine or mutates the library answers 501.
#
# ── The build is done on the HOST, not here ──────────────────────────────────
# `dist/electron` (including `bookshelf-ui` and `data`) is produced by
# `npm run build:electron`, which needs the Angular toolchain and the whole
# devDependency tree. Compiling that inside this image would double the build
# for output that is platform-neutral JavaScript either way. So: build first,
# then `docker build` from the repo root with this file. The COPY lines below
# fail loudly if you forget.
#
#   npm run build:electron
#   docker build -f deploy/bookshelf-server/Dockerfile -t bookforge-bookshelf .
#
# Node LTS. Debian (not Alpine) because sharp's prebuilt binaries are glibc.
FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./

# --omit=dev: none of the build tooling runs here.
# --ignore-scripts: `postinstall` is `electron-rebuild --only better-sqlite3`
#   plus a mupdf binary download — both are for the desktop app and neither can
#   run (or is wanted) in this image. Nothing the mirror serves needs them:
#     · sharp (cover thumbnails) ships prebuilt platform binaries as optional
#       dependencies, installed by npm itself — no build step.
#     · mupdf (PDF page rasterization, /api/read-page) is pure WASM.
#     · better-sqlite3 is a native module used ONLY by the JWPUB converter,
#       which is a desktop-app feature a library mirror does not have. It stays
#       unbuilt; requiring it would throw, and nothing here requires it.
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime

# ffprobe reads chapter marks and durations; ffmpeg extracts the embedded
# transcript out of an m4b. cli/serve-bookshelf.js verifies both RUN at startup
# and refuses to serve if they do not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY cli ./cli
# dist/electron carries the server, the bookshelf-ui bundle and the component
# data catalogs (loaded at import time); dist/shared carries the platform-neutral
# modules dist/electron requires by relative path.
COPY dist/electron ./dist/electron
COPY dist/shared ./dist/shared

# The library is bind-mounted here (see docker-compose.yml) and the per-machine
# state (duration cache, cover thumbnails, reader tokens, device id) lives in its
# own volume — never on the library share, never on the NAS system volume.
ENV BOOKFORGE_LIBRARY=/library \
    BOOKFORGE_STATE=/state \
    BOOKFORGE_PORT=8765
EXPOSE 8765

# A reachable /api/health is the only honest liveness signal: it is answered by
# the same express app every real request goes through.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BOOKFORGE_PORT||8765)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Shell form so the env vars expand. No fallbacks: an unset BOOKFORGE_LIBRARY
# reaches the CLI as an empty --library and is refused by name.
CMD node cli/serve-bookshelf.js --library "$BOOKFORGE_LIBRARY" --state-dir "$BOOKFORGE_STATE" --port "$BOOKFORGE_PORT"
