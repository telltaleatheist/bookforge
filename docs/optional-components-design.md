# Optional Component System — Design & Build Spec

**Status:** Phase 1 in progress (June 2026)
**Goal:** Ship a small XTTS-only core. Fetch heavy/platform-specific pieces
(Calibre, Orpheus, Tesseract, Resemble Enhance) on demand, gated by system
compatibility, with honest states that **replace today's silent fallbacks**.

The locked TypeScript contract lives in
[`electron/components/component-types.ts`](../electron/components/component-types.ts).
This doc is the architecture + build contract around it.

---

## Why

- BookForge today assumes Orpheus, Calibre, Tesseract, Resemble are all
  pre-installed. Missing pieces **warn and fall back, then crash at job time**
  (e.g. `e2a-paths.ts` falls back `orpheus_env → python_env`, then vLLM import
  fails mid-TTS). That violates the project's "no silent fallbacks" principle.
- All four optional pieces need the *same* missing capability: detect
  compatibility → download → install → verify → resolve a path. Build it **once**.
- Existing half-patterns to model on (do not fight them):
  - `scripts/download-mupdf.js` — the download primitive (redirects, progress,
    extract, verify). Currently **build-time only**; promote the logic to a
    runtime module.
  - `electron/tool-paths.ts` — config/detect/status: a JSON file in `userData`,
    priority-ordered resolvers, `getToolStatus() → {configured, detected, path}`.
    The component system is the missing **acquisition half**.

## Two acquisition modes (key design point)

Every component resolves through one seam — `componentManager.resolveEntry(id)` —
but can be obtained two ways:

- **`external` (BYO)** — the user installs it with the normal installer
  (Calibre `.dmg`/`.exe`, `brew install tesseract`, `conda create`), and
  BookForge **auto-detects** it (PATH + candidate-path scan, exactly like
  `tool-paths.ts` does for conda/ffmpeg) or the user points at it via a
  **"Locate…"** file picker. **Zero hosting, zero conda-pack.** This is the
  Phase 1 MVP.
- **`managed`** — BookForge downloads + extracts + installs it. Needs published
  artifacts (hosting). Slots in later **without changing any consumer** because
  everything still resolves through `resolveEntry`.

A component declares which modes it supports in `acquisition: AcquisitionMode[]`.

## Component shapes

| kind        | examples           | external (BYO)                  | managed (download)                         | verify                  |
|-------------|--------------------|---------------------------------|--------------------------------------------|-------------------------|
| `binary`    | Calibre, Tesseract | detect installer / Locate…      | archive → extract → chmod                  | run `--version`         |
| `conda-env` | Orpheus, Resemble  | detect user's conda env / point | conda-pack tarball → extract → conda-unpack | `python -c import ...` |
| `system`    | Apple Vision       | probe OS framework              | n/a                                        | probe availability      |

## File layout (all new)

```
electron/components/
  component-types.ts     ← LOCKED CONTRACT (already written)
  system-probe.ts        ← ISystemProbe: platform/arch/appleSilicon/CUDA+VRAM/RAM/disk
  downloader.ts          ← fetch(redirects)+progress+sha256+extract(tar/zip)
  component-catalog.ts   ← CATALOG: OptionalComponent[]  (Calibre first, then Orpheus)
  component-manager.ts   ← IComponentManager: install/uninstall/status + installed.json
```

Installed components live in `app.getPath('userData')/components/<id>/`.
Source of truth for what's installed: `userData/components/installed.json`
(`InstalledManifest`). The *catalog* (what's available) ships in-app.

---

## Locked cross-module signatures

Agents code against these exact exports. Do not rename.

```ts
// electron/components/system-probe.ts
export const systemProbe: ISystemProbe;

// electron/components/downloader.ts
export interface DownloadHandle { cancel(): void; }
export async function downloadAndExtract(
  artifact: ComponentArtifact,
  destDir: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<void>;   // throws on failure (bad checksum, http error, extract error)

// electron/components/component-catalog.ts
export const CATALOG: OptionalComponent[];
export function getComponent(id: string): OptionalComponent | undefined;

// electron/components/component-manager.ts
export const componentManager: IComponentManager;
```

### IPC channels (main ↔ renderer)

| channel                 | direction        | payload → result                          |
|-------------------------|------------------|-------------------------------------------|
| `components:list`       | invoke           | () → `ComponentStatus[]`                   |
| `components:get`        | invoke           | (id) → `ComponentStatus \| null`          |
| `components:probe`      | invoke           | (force?) → `SystemProfile`                 |
| `components:detect`     | invoke           | (id) → `string \| null` (external scan)    |
| `components:set-path`   | invoke           | (id, path) → `ComponentStatus` (external)  |
| `components:install`    | invoke           | (id) → `InstallResult` (managed)           |
| `components:cancel`     | invoke           | (id) → void                               |
| `components:uninstall`  | invoke           | (id) → void                               |
| `components:progress`   | main→renderer    | event: `InstallProgress`                  |

### Renderer surface (electron.service.ts, mirroring repo convention)

The renderer cannot import from `electron/`. Mirror the renderer-facing types
into `electron.service.ts` (this matches how `LayoutBlock` etc. were mirrored
before). Expose:

```ts
components: {
  list(): Promise<ComponentStatus[]>;
  get(id: string): Promise<ComponentStatus | null>;
  probe(force?: boolean): Promise<SystemProfile>;
  detectExternal(id: string): Promise<string | null>;
  setExternalPath(id: string, path: string): Promise<ComponentStatus>;
  install(id: string): Promise<InstallResult>;
  cancel(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  onProgress(cb: (p: InstallProgress) => void): () => void; // returns unsubscribe
}
```

---

## Compatibility rules (system-probe `evaluate`)

- `requirements.platforms` excludes → `incompatible: "Not available on <platform>."`
- `gpu: 'apple-silicon'` and not appleSilicon, AND `gpu` alternative not met →
  incompatible. Orpheus is `gpu: 'cuda'`-or-`apple-silicon`; encode as the
  catalog needs (see catalog notes).
- `minVramMB > cuda.vramMB` on a cuda-only path → incompatible (or `degraded`
  if a CPU fallback exists — Orpheus does not, so incompatible).
- `minRamMB`/`minDiskMB` unmet → incompatible with the specific shortfall in
  `reasons`.
- Probe specifics:
  - `appleSilicon = platform==='darwin' && arch==='arm64'`.
  - CUDA via `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
    (Windows/Linux); absent/error → `{available:false}`.
  - `ramMB = os.totalmem()/1MB`.
  - `freeDiskMB`: free space on the `userData` volume — `df -k` (unix) /
    `wmic logicaldisk` or `fsutil volume diskfree` (win). Best-effort; on failure
    report a large sentinel and skip the disk gate (logged).
  - Reuse `detectWslAvailability()` from `tool-paths.ts` for `wsl`.

## Catalog notes (Phase 1 entries)

- **calibre** (`binary`, FIRST), `acquisition: ['external']` for Phase 1
  (managed can be added later). platforms all, `gpu:'none'`. `detect`:
  - `commandNames: ['ebook-convert']`
  - `candidates` (reuse the paths already in `ebook-convert-bridge.ts`):
    macOS `/Applications/calibre.app/Contents/MacOS/ebook-convert`,
    `/opt/homebrew/bin/ebook-convert`, `/usr/local/bin/ebook-convert`;
    Windows `C:\Program Files\Calibre2\ebook-convert.exe` (+ x86);
    Linux `/usr/bin/ebook-convert`.
  - verify `exec ['--version']`. `externalHelpUrl` → calibre download page.
- **tesseract** (`binary`), `acquisition: ['external']`. `detect`:
  `commandNames:['tesseract']`; candidates `/opt/homebrew/bin/tesseract`,
  `/usr/local/bin/tesseract`, `/usr/bin/tesseract`, Windows Program Files.
  verify `exec ['--version']`.
- **orpheus** (`conda-env`, later), `acquisition: ['external','managed']`.
  Requirements: Apple Silicon **or** CUDA ≥ ~6 GB VRAM. external `detect`: look
  for a user conda env (named `orpheus_tts`/`orpheus_env`, or a prefix env
  beside e2a); managed artifact = per-platform conda-pack tarball, `condaUnpack:true`.
  `entryPath` → env root. verify `python-import` of the module the env exposes.
  Managed URLs stubbed until hosting chosen.

Stub URL handling: the manager surfaces an empty/placeholder managed `url` as a
clear "not yet available for download — install it yourself" error pointing at
`externalHelpUrl`. It never attempts a fetch against a stub.

---

## Manager behaviour (component-manager.ts)

External (BYO) — the Phase 1 primary path:
- `detectExternal(id)`: walk the `DetectSpec` — env var → PATH lookup
  (`which`/`where`) of `commandNames` → `candidates` for this platform. Return
  the first path that exists. No recording.
- `setExternalPath(id, entryPath)`: run the `VerifySpec` against the path; on
  success write an `InstalledRecord` with `source:'external'` (sha256/bytes
  omitted, `entryPath` absolute) and return the fresh `ComponentStatus`; on
  failure throw with the verify output as the reason.
- `listStatus()` auto-runs `detectExternal` for not-yet-recorded external
  components so they show as Installed when the user already has them.

Managed (download) — secondary, real fetch lands in Phase 2/3:
- `install(id)`: resolve artifact for this profile → pre-check compat + disk →
  `downloadAndExtract` into a temp dir → post-install (conda-unpack / chmod) →
  run `VerifySpec` → atomically move into `components/<id>/` → write
  `InstalledRecord` (`source:'managed'`) → return `InstallResult`. Emit
  `InstallProgress` at every phase. `installedAt` stamped here (main process).
  Against a stub URL: short-circuit to an `error` result that points at
  `externalHelpUrl`.
- `cancel(id)`: abort the in-flight `AbortController`; clean the temp dir.

Both:
- `uninstall(id)`: managed → remove `components/<id>/` and the record; external →
  drop the record only (**never** delete the user's own install).
- `resolveEntry(id)`: return the absolute `entryPath` only if recorded AND the
  path exists; else `null`. **This is the integration seam.**
- Atomic writes for `installed.json` (temp + rename), consistent with the repo's
  Syncthing-safe write convention.

## UI (Phase 1)

Settings → new **"Add-ons"** tab. One card per component:
status badge (Installed / Available / Incompatible / Installing), size,
compatibility note (`reasons` when not installable), and mode-appropriate
actions:
- external + detected → shows the resolved path + a **Remove** (forget) button.
- external + not found → **Locate…** file picker (`dialog.showOpenDialog`) +
  a **"How to install"** link (`externalHelpUrl`).
- managed available → **Install** / **Cancel** with a progress bar driven by
  `components:progress`. (Stubbed-URL components show "Install it yourself"
  instead until hosting lands.)
- incompatible → actions disabled, `reasons` shown in a tooltip.

---

## Phasing

1. **Infra + external/BYO MVP (this phase):** probe, downloader, catalog
   (Calibre + Tesseract external; Orpheus external+managed stub), manager
   (external detect/set-path fully working; managed install present but only
   exercised by a tiny dummy component), IPC, Add-ons tab. Ships a real,
   useful panel with **no hosting dependency** — detects an existing Calibre /
   Tesseract install and reports honest status.
2. **Calibre through the seam:** `ebook-convert-bridge.findEbookConvert()` checks
   `componentManager.resolveEntry('calibre')` first; (optional) native EPUB↔txt
   path to drop Calibre from the hot `pdf:export-text-only-epub`. Managed Calibre
   artifact + hosting decision optional here.
3. **Orpheus through the seam:** `e2a-paths` resolves the env via the manager and
   throws honestly when absent; gate the Orpheus option in the engine-selection
   UIs (ll-wizard, bilingual-cache-panel) on installed status; delete the
   `orpheus_env → python_env` silent fallback. Managed conda-pack artifact +
   hosting when we want push-button install.
4. **Tesseract + Resemble through the seam:** same pattern.

## Out of scope for Phase 1

- Real **managed** artifact hosting/URLs (Phase 2 decision). External/BYO needs none.
- conda-pack build scripts (Phase 2/3).
- Touching `e2a-paths.ts` / `ebook-convert-bridge.ts` (Phase 2/3 integration).
- Auto-update / remote catalog fetch (later).
