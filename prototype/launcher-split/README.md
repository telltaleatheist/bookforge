# Launcher-split prototype (Approach A)

Validates the riskiest part of the app-update design before we build the real thing:
a thin **launcher** (the `.app` in `/Applications`) that boots **"BookForge proper"** — the
app code — from a swappable bundle in `userData`.

See memory `app-update-system-design.md` for the full design.

## What it proves

```
launcher/bootstrap.js   ← the thin launcher's main (what ships in the .app)
baseline/v1, baseline/v2 ← two code bundles (identical code, differ only in version.json)
```

1. **Boot from userData, not the .app.** `bootstrap.js` seeds a baseline bundle into
   `userData/app/<version>/` on first run, then `require()`s its `electron/main.js`.
   The code bundle reports `bundleDir = /tmp/.../app/v2`, confirming it ran from userData.
2. **Self-located renderer.** The code bundle finds `renderer/index.html` via `__dirname`,
   NOT `app.getAppPath()`. (The real `main.ts` change is to replace its ~7 `app.getAppPath()`
   renderer lookups with `path.join(__dirname, '..', '..')`.)
3. **Native module across the launcher→bundle boundary.** The code bundle does a bare
   `require('better-sqlite3')`. It resolves to the **launcher's** node_modules (injected via
   `NODE_PATH` + `Module._initPaths()`), loads, and runs a query. `native.ok = true`.
4. **Stage-now / boot-next + rollback.** `PROTO_STAGE=v2` stages a second bundle beside v1,
   flips `current.json`, and boots it. v1 is retained for rollback.

## Run it

```bash
# First run — seeds v1 (orange badge)
PROTO_USERDATA=/tmp/bookforge-proto npx electron prototype/launcher-split/launcher

# Stage + flip to v2 (blue badge), v1 kept for rollback
PROTO_USERDATA=/tmp/bookforge-proto PROTO_STAGE=v2 npx electron prototype/launcher-split/launcher
```

Add `PROTO_AUTOQUIT=1` to render-report-exit (headless/CI) instead of leaving the window open.

## Key finding: native modules are ABI-pinned, not N-API

`better-sqlite3` (the app's only native dep) is compiled for `NODE_MODULE_VERSION 121`
(Electron 29). It is rejected by plain Node (ABI 115) — it is a versioned C++ addon, not an
ABI-stable N-API module. **Consequence for the build split:**

- **Native modules MUST live in the launcher**, built for the launcher's Electron (electron-builder
  already rebuilds native deps for the target Electron during packaging — free).
- **Code bundles ship pure JS only** (compiled `electron/` + Angular `renderer/`), NO node_modules.
  They `require()` native deps from the launcher.
- This **isolates the entire ABI problem to the launcher**, which is exactly where Electron
  upgrades happen. A code-only update can never hit an ABI mismatch.
- The manifest's `minLauncher` gate is therefore only needed for the rare case where new code
  needs a newer better-sqlite3 *JS API* than the installed launcher ships — not for ABI.

## Not covered here (next steps)

- Verify after download (sha256) — reuse `electron/components/downloader.ts`.
- Boot-failure rollback (new bundle writes a "booted OK" marker; launcher reverts if absent).
- The actual build split (emit launcher `.app` + standalone code-bundle zip) in electron-builder.
- Refactor real `main.ts` to be self-locating (`__dirname`) instead of `app.getAppPath()`.
