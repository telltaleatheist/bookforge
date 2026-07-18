# Remote Library Plan — BookForge ↔ titan (NAS-hosted library)

**Status: PLAN ONLY — not yet executed. Worked out 2026-07-18.**

## Goal

Host the published audiobook library on the NAS (titan, UGREEN UGOS,
`titan.owenmorgan.com` on the tailnet) so books are always served even when the
PC is off or BookForge is mid-refactor. BookForge (PC/Mac) stops being the
library's only home: it either manages a local library (default, exactly like
today) or connects to a server. Distribution goal: anyone who downloads
BookForge can run their own server instance with `bookforge serve`.

## Settled decisions (from design discussion)

1. **No full BookForge install on titan.** Titan gets a Node-only library
   service — no conda envs, no Python TTS stack. Generation stays on machines
   with GPUs. Deployment is a **Docker container** (UGOS updates wipe system
   files; the tailscale-in-Docker survival pattern applies). Library data
   bind-mounted from `/iO/bookforge`; container image is disposable.
2. **Single-writer discipline.** The library service is the ONLY writer to a
   library directory. No SMB mounts, no Syncthing on the served library, no
   direct fs writes from other machines.
3. **Artifact-registry pattern.** Build locally → publish immutable artifact +
   mutable metadata to the authoritative registry → verify by hash → clear
   local staging. Like `docker push`.
4. **Outbox, not sync engine.** The outbox holds *books, not operations*.
   Every book has exactly one home at a time: local (pending/outbox or
   local-only mode) or remote (uploaded + verified). Publishing lands locally
   first (works offline), a background uploader drains to the server, verifies
   by SHA-256, then clears the local copy. No server configured → the local
   library IS the final destination (same code path).
5. **Metadata writes route by the book's home.** Local book → local write
   (today's code). Remote book + online → live API call. Remote book +
   offline → edit unavailable (disabled UI), never queued. Only new publishes
   go through the outbox. The one race — edit during in-flight upload — is
   handled by the uploader diffing metadata after verify and pushing a
   follow-up update via the live API before clearing.
6. **Workspace/library split.** Sentence caches, sessions, diff caches,
   sources, stages stay local (the workspace). The library holds published
   artifacts only.
7. **API version handshake** on day one so an old container and a new app fail
   loudly.
8. **Out of scope (explicitly):** offline edit queues / conflict resolution;
   remote job orchestration ("titan asks PC to render"); server-side
   transcoding; multi-user collaborative libraries. The API-only-writer design
   keeps all of these retrofittable later.

---

## Current-state reality (from codebase exploration 2026-07-18)

These findings correct earlier assumptions and anchor the plan. File:line refs
are to current `main`.

### There is no single library manifest

The manifest is **per-project**: `projects/<id>/manifest.json`
(`electron/manifest-types.ts:20`, `ProjectManifest` v2). A finished m4b is
never moved into a library folder — it stays at
`projects/<slug>/output/<Title>. <Author>.m4b` and the manifest points at it
in-place (`outputs.audiobook.path`, project-relative). `bookshelf.json` at the
library root is **server config, not a manifest**.

### The library root is really a workspace with published bits inside

| Path under library root | Role | Published or workspace? |
|---|---|---|
| `projects/<id>/manifest.json` | source of truth for the book | **Published** |
| `projects/<id>/output/*.m4b` + `*.sidecars.json` / `*.vtt` / `*.cover.jpg` | finished audiobooks + hash-bound sidecars | **Published** |
| `projects/<id>/archive/*` | archive-as-source ebooks | **Published** |
| `projects/<id>/source/`, `stages/01..04/` | pipeline workspace incl. TTS session caches (`stages/03-tts/sessions/`) | Workspace |
| `media/cover_<hash>.*` | content-hashed covers referenced by manifests | **Published** |
| `audiobooks/` | external drop-in m4bs (human-read books), manifest-less | **Published** |
| `.bookshelf/` | reader profiles/positions/analytics (append-only JSON) | **Published** (server-side state) |
| `files/`, `cache/`, `tmp/`, `logs/`, `deprecated/` | staging/scratch | Workspace |
| `bookshelf.json` | server config + access key | Config |

So the "split" is not folder A vs folder B — it's **the published subset of
each project** vs the rest of that project. This reshapes the publish design
(below).

### One registration chokepoint (very good news)

Every producer of a finished audiobook funnels through
`registerAudiobookOutput()` (`electron/manifest-service.ts:641`):
`parallel-tts-bridge.ts:4910`, `reassembly-bridge.ts:1764`,
`book-render-service.ts:476`, `audiobook:import-audiobook` (`main.ts:6646`),
`variant:add` (`main.ts:6809`), and the headless CLI
(`cli/orpheus-audiobook-render.js:234` via reassembly). This is the single
insertion point for "and now enqueue to the outbox."

### The headless story already exists

- `electron/bookshelf-server.ts` (class `BookshelfServer`, Express 5, port
  8765, binds 0.0.0.0) does **not** import Electron. Neither does
  `manifest-service.ts`.
- The CLI (`cli/bookforge-tts.py` dispatching to Node adapters) already runs
  compiled `dist/electron/*.js` under `cli/electron-stub.js`, which fakes
  `app.getPath` etc. — including Linux userData paths. Transitive deps of the
  server that DO import electron (`tool-paths.ts:17`, `metadata-tools.ts`,
  `ebook-render.ts`, …) are already handled by this stub. `tool-paths.ts`
  already has Linux ffmpeg paths (`:359`, fallback to PATH `:471`).
- Adding a CLI subcommand = one line in the `COMMANDS` registry
  (`cli/bookforge-tts.py:522`) + one handler.
- **Conclusion: `bookforge serve` is a small adapter, not a rewrite.**

### Client-side multi-server already works

The bookshelf web/iOS player (`projects/bookshelf/`) already supports multiple
servers (`server-config.service.ts`, `MULTI_SERVER.md`): persisted
`ServerEntry[]`, merged shelves, per-book origin routing, `?accessKey=` auth.
Titan becomes just another server entry for the players — zero player work for
phase 1.

### Auth today

Opt-in shared key: `serverAccessKey` in `bookshelf.json` gates all of `/api`
(`bookshelf-server.ts:315`); absent = open (trusted-tailnet). Mutation routes
additionally need a reader token. Fails closed on unparseable config.

### Existing warts to fix first (prep phase)

1. **`bookshelf.json` schema collision** — two writers with different shapes:
   `main.ts:386` writes `{enabled, port, externalAudiobooksDir}`;
   `bookshelf-server.ts:545` reads `{externalAudiobooksDir, serverAccessKey}`.
   `saveBookshelfConfig` round-trips only its own keys and will **silently
   drop a hand-added `serverAccessKey`**.
2. **`audiobook:import-audiobook` writes a hand-built `version:1` manifest**
   (`main.ts:6642`) bypassing `createProject` (v2). Normalize.
3. `bookshelf-server.ts` imports `ebook-render` (mupdf) at top level even
   though shelf/audio/vtt endpoints don't need it — fine under the stub, but
   note for the Docker image (mupdf installs on Linux; keep it).

---

## Architecture

### The remote library replicates the published-project shape

The server-side library is the **same on-disk layout** the local library uses,
minus workspace dirs:

```
/iO/bookforge/
  projects/<id>/manifest.json
  projects/<id>/output/*.m4b (+ .sidecars.json, .vtt, .cover.jpg)
  projects/<id>/archive/*            (source ebooks — small, included)
  media/cover_<hash>.*
  audiobooks/                        (external human-read drop-ins)
  .bookshelf/                        (reader state, written by the server)
  bookshelf.json                     (server config)
```

Rationale: `bookshelf-server.ts` + `manifest-service.ts` + the sidecar-binding
scheme (`sidecar-binding.ts`) already read exactly this layout. Inventing a
new flat "library entry" format would mean a parallel read path, a migration,
and re-testing the players. Replicating the published subset means the
headless server is **today's server pointed at a different root** — the new
engineering is only the write API and the client/outbox.

Known limitation to accept: reader features that read `source/`/`stages/`
(pristine-source `/api/read-*`) won't work for remote-published books
initially — those dirs stay on the authoring machine. `archive/` (the
archive-as-source file) IS included, so ebook download/reading works.

### Component 1 — Library write API (new endpoints on BookshelfServer)

All under `/api/library/*`, gated by `serverAccessKey` (REQUIRED for
mutations even on trusted tailnet — reachability-as-auth is fine for reads,
not for deletes):

- `GET  /api/library/info` — apiVersion handshake, library root, capabilities.
- `POST /api/library/publish/begin` — declare `{projectId, manifest (published
  subset), files: [{relPath, sha256, bytes}]}` → returns upload session +
  per-file status (server may already have some files → dedupe/resume).
- `PUT  /api/library/publish/chunk` — chunked upload (multi-GB m4bs over
  tailnet from remote networks; must be resumable across app restarts).
- `POST /api/library/publish/commit` — server verifies every file's SHA-256
  against the declaration, atomically installs the project dir
  (temp-dir + rename, mirroring `atomicWriteFile` discipline), registers,
  invalidates caches. Returns verified hashes. **Commit response is what
  authorizes the client to clear its local copy.**
- `PATCH /api/library/project/:id/metadata` — metadata edit; server re-embeds
  m4b tags via existing `applyMetadata` (Docker image ships ffmpeg).
- `PUT  /api/library/project/:id/cover` — cover replace (media/ + rebind
  sidecars via `regenerateBoundSidecars`).
- `DELETE /api/library/project/:id` and variant-level deletes — mirror the
  `variant:delete` / `audiobook:delete-output` semantics (write-before-unlink).
- `POST /api/library/external` — upload into `audiobooks/` drop-in folder
  (human-read books; manifest-less path).

Implementation note: these handlers should call the SAME manifest-service
functions the IPC handlers call today (`modifyManifest`,
`registerAudiobookOutput`, `archiveFile`, cover helpers). Where that logic
currently lives inline in `main.ts` IPC closures (e.g. `variant:save-metadata`
`main.ts:6815`, `saveImageToMedia` `main.ts:2307`), **extract it into
`manifest-service.ts` / a new `library-service.ts` first** so Electron IPC and
HTTP API are two thin skins over one implementation. That extraction is the
heart of the refactor.

### Component 2 — `bookforge serve` (headless host)

- New handler in `cli/bookforge-tts.py` (`COMMANDS` registry) → spawns
  `node --require cli/electron-stub.js cli/serve.js --library <root> --port
  <p>`; also runnable directly via node (Docker doesn't need Python — prefer
  a direct `node cli/serve.js` entrypoint; keep the Python registry entry for
  parity on dev machines).
- `cli/serve.js`: `setLibraryBasePath(root)` (as
  `cli/orpheus-audiobook-render.js:89` already does) → `new
  BookshelfServer().start({port, userDataPath})` where userDataPath is a
  writable volume path (duration cache, external-meta cache, reader tokens).
- Must NOT import `main.ts`. Any serve-path code discovered to hard-require
  Electron beyond what the stub provides gets fixed by extending the stub, not
  by forking the module.

### Component 3 — Docker deployment on titan

- Image: `node:20-slim` + `ffmpeg` (required for chapters/VTT
  extract/metadata embed). Contents: `dist/electron/` (compiled),
  `dist/electron/bookshelf-ui/` (built Angular player), `cli/serve.js` +
  `cli/electron-stub.js`, production `node_modules` (better-sqlite3 and mupdf
  have Linux prebuilds).
- Volumes: `/iO/bookforge` → library root; a small persistent volume for
  userData caches.
- Network: bind to the tailscale interface (titan = 100.64.0.3;
  `titan.owenmorgan.com` via headscale split-DNS). Restart policy `unless-
  stopped` + the existing titan self-heal script pattern (UGOS updates wipe
  system files; Docker volumes on /iO and /volume1 persist).
- `serverAccessKey` set in the titan library's `bookshelf.json` (after the
  config-collision fix so the app can't clobber it).

### Component 4 — App server mode (Settings → Library)

- Settings: "Local library" (default, zero-config) vs "Connect to server"
  (URL + access key). Persisted next to `library-root.json`.
- The library-facing IPC surface routes on the **book's home**, not globally:
  the union view lists remote books (via `/api/books` — already exists) plus
  local pending/outbox books (via manifest-service as today), each entry
  tagged `home: 'remote' | 'local'` and pending items badged.
- Local-home books: all existing handlers unchanged.
- Remote-home books: `variant:save-metadata`-class edits, cover ops, deletes
  become HTTP calls; offline → surface "server unreachable", disabled
  controls (players already render controls disabled, never hidden — same
  convention).
- Version handshake on connect via `/api/library/info`; mismatch = loud error.
- Scope discipline: project/workspace surfaces (stages, cleanup, TTS, queue)
  are NOT abstracted — they are local-only by definition.

### Component 5 — Outbox publish

- After `registerAudiobookOutput` succeeds locally (all producers), if server
  mode is on: enqueue `{projectId, variantId}` in a persisted outbox
  (`userData/outbox.json`), never blocking the render pipeline.
- Uploader (main process, serialized, retry with backoff, survives restarts):
  begin → chunks (resumable) → commit → **verify** (server-returned hashes vs
  local; sidecar-binding records at `sidecar-binding.ts:49` already carry
  m4b + asset SHA-256s — reuse them, don't re-hash multi-GB files
  needlessly) → post-verify metadata diff (the in-flight-edit race) → **then**
  clear local: remove `output/` artifacts + published-subset duplication,
  stamp the local manifest with a publish record
  `{serverId, publishedAt, m4bSha256}` replacing `outputs.audiobook`.
  The workspace (`source/`, `stages/` incl. sentence caches) is untouched —
  regeneration continues to work locally and republishes as a new version.
- Any verify mismatch or unreachable server: item stays in outbox, local copy
  stays intact, error surfaced. **Nothing is ever deleted on hope**
  (no-fallbacks rule).
- Local-mode users: outbox code path short-circuits — publish destination is
  the local library, done (today's behavior, unchanged).

---

## Phasing (each independently shippable; app keeps working locally throughout)

**Phase 0 — prep/normalization (small, do first):**
`bookshelf.json` schema unification (one shape, one reader/writer module);
`audiobook:import-audiobook` v1-manifest fix; extract inline library logic
from `main.ts` IPC closures into `manifest-service.ts`/`library-service.ts`
(pure refactor, IPC behavior identical — this is the riskiest-to-regress
step, keep it mechanical and reviewed).

**Phase 1 — headless read-only serve + Docker:** `cli/serve.js`, `bookforge
serve` registry entry, Dockerfile, deploy to titan pointed at a manually
copied library snapshot in `/iO/bookforge`. Value shipped: phones add titan
as a server entry; books served even with the PC off. No write API yet.

**Phase 2 — write API:** `/api/library/*` endpoints on BookshelfServer,
chunked/resumable upload, atomic commit, hash verify, access-key-required
mutations, `/api/library/info` handshake. Testable against a local headless
serve instance before titan sees it.

**Phase 3 — app server mode:** settings UI, union library view with `home`
tagging, remote routing for metadata/cover/delete, offline disabled states.

**Phase 4 — outbox:** persisted queue, uploader, verified clear, publish
records, in-flight-edit reconciliation.

**Phase 5 — titan production:** access key, tailscale-interface binding,
self-heal integration, migrate the real library to `/iO/bookforge`
(one-time: through the publish API or a supervised rsync-then-verify — NOT
ongoing sync), decommission any Syncthing coverage of the served library
(single-writer rule).

## Testing strategy

- Phases 0/2/3/4 get exercised against `bookforge serve` running **locally**
  (localhost server + second library root) — full publish/edit/delete/offline
  cycle without touching titan.
- Kill-mid-upload and edit-mid-upload tests for the outbox (resume + verify +
  reconcile paths).
- Phase 1 smoke on titan: player on phone vs titan entry, PC off.
- Regression: local mode must be byte-identical in behavior after Phase 0 —
  the existing CLI render (`cli/orpheus-audiobook-render.js`) doubles as a
  headless regression harness for the registration chokepoint.

## Open questions (for Owen before/while delegating)

1. **Clearing scope:** after verified upload, delete just `output/` artifacts
   locally, or also prompt to archive the whole project workspace? (Plan
   assumes: clear output/ only; workspace untouched.)
2. **External drop-ins:** should the app offer "publish to server" for
   `audiobooks/` external m4bs too (plan says yes, simple endpoint), and
   should titan's existing human-read collection just be moved into
   `/iO/bookforge/audiobooks/` at Phase 1 (cheapest path to value)?
3. **Reader state:** in server mode, should the desktop `/listen` player point
   at the server's `.bookshelf/` state (consistent positions with phones)?
   Plan assumes yes when online.
4. **Access key UX:** generate-on-first-run on the server + paste into app,
   or app-generated and pushed at setup? (Plan assumes server generates,
   prints to logs/console, user pastes into app + phone once.)
