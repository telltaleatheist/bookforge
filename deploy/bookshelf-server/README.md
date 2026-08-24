# Bookshelf server, standalone — Docker for titan (UGREEN NAS)

The library lives **on the NAS**. This runs BookForge's real bookshelf server
there, headless, so the shelf stays reachable when BookForge is down on both the
PC and the Mac.

It is a **library-only mirror**, not a second BookForge. It serves what already
exists and refuses, with `HTTP 501` and the capability named, everything that
needs the TTS engine or would change the library. The bookshelf web app reads
`/api/health` → `capabilities` and shows those controls **disabled with the
reason** — Owen's standing ruling: disabled, never hidden.

| Serves | Refuses (501) |
|---|---|
| shelf + ebook list, covers & thumbnails, downloads | live TTS and the whole-book renderer (`/api/render/*`, `/api/tts/*`, the reader WebSocket) |
| range-streamed audio, chapters, transcripts, analysis | document ingest (`/api/reader/ingest`, `/api/edit/ingest-pdf`, `/api/edit/page`) |
| in-app reader: EPUB bytes **and** rasterized PDF pages | project creation (`/api/edit/finalize`) |
| reader profiles, sign-in, positions, bookmarks, heard, analytics | the processing queue (`/api/queue*`) |
| the bookshelf web UI itself | library mutations (`DELETE /api/project`, `/api/ebooks/reclassify`) |

PDF pages are **not** gated: mupdf is a pure-WASM npm package with no native
binding and no platform restriction, so a headless Linux box rasterizes them
exactly as the desktop app does.

## Reader state — why the library mount is read-write

Positions, bookmarks, heard coverage, analytics and profiles live under
`<library>/.bookshelf/` as **per-device files merged on read**. This server
writes its own device's file; BookForge on the PC writes its own. They converge
by construction — no primary, no coordination, no conflict. Mounting the library
read-only would silently drop every position the phone saves while the PC is off.

## Build and run

`dist/electron` is built on a **workstation**, not in the image: it needs the
Angular toolchain and the full devDependency tree, and its output is
platform-neutral JavaScript. So build first, then build the image from the repo
root.

```sh
# On the PC or the Mac, in the repo:
npm run build:electron        # dist/electron (+ bookshelf-ui, + data) and dist/shared

# Then, from the repo root:
docker compose -f deploy/bookshelf-server/docker-compose.yml build
docker compose -f deploy/bookshelf-server/docker-compose.yml up -d
docker compose -f deploy/bookshelf-server/docker-compose.yml logs -f
```

Check it: `curl http://titan:8765/api/health` →

```json
{"status":"ok","name":"...","capabilities":["library","reader","pdf"]}
```

Three `capabilities` is the mirror. Eight is the desktop app.

### Before the first run — fix the library path

`docker-compose.yml` mounts `/volume1/iO/bookforge:/library` as a **placeholder**
for titan's real path to the share the PC sees as `Z:\bookforge`
(`\\TITAN\iO\bookforge`). Confirm it on the NAS (`ls /volume*`) and edit the
mount before bringing the stack up. A wrong path gives an empty shelf, not an
error, because an empty library is a legitimate library.

### What the image contains

`node:22-bookworm-slim`, plus `ffmpeg` from apt (ffprobe reads chapter marks and
durations; ffmpeg extracts the embedded transcript from an m4b — the CLI verifies
both actually run at startup and refuses to serve if they do not), plus
production `node_modules` installed with `npm ci --omit=dev --ignore-scripts`.

The build context is the repo root, so `Dockerfile.dockerignore` (BuildKit reads
it in preference to a context-root `.dockerignore`) excludes everything and names
only the five paths the image copies — otherwise `node_modules`, `foundry-app`
and the whole source tree ride along to the daemon on every build.

`--ignore-scripts` is deliberate: `postinstall` is `electron-rebuild --only
better-sqlite3` plus a mupdf binary download, both desktop-app concerns. Nothing
the mirror serves needs either — `sharp` ships prebuilt glibc binaries as
optional dependencies (which is also why the base is Debian, not Alpine), `mupdf`
is WASM, and `better-sqlite3` is used only by the JWPUB converter, a feature a
mirror does not have.

## UGOS caveat — nothing on the system volume

**A UGOS update wipes system files.** Anything installed onto the NAS's system
volume — packages, binaries, systemd units, hand-edited config — is gone after
the next firmware update, and comes back only if you remember to redo it.

So everything here lives in the **container image** and in **data volumes**:

- No `apt install` on the NAS itself. ffmpeg is inside the image.
- No node, npm, or BookForge checkout on the NAS. Only the built image.
- Per-machine state is the named volume `bookshelf-state`, not a path under a
  system directory.
- The only NAS-side path referenced is the **library share**, which is user data
  on a data volume and survives updates.

Recovery after a UGOS update is therefore: make sure Docker is running, then
`docker compose up -d`. If the image itself was lost, rebuild it from a
workstation and push/load it — nothing has to be reinstalled on the NAS.

## Not deployed

These files are the deliverable; nothing here has been run on titan. Bring it up
by hand once the library mount path is confirmed.
