# Windows Packaging Handoff

Written Jun 12 2026 on the Mac, for continuing the packaging work on the
Windows machine. Read alongside `docs/packaging-pipeline.md` (the master plan —
phase numbers below refer to it). Everything in this doc assumes you've pulled
the branch this file shipped on and are sitting on the Windows box.

## Where things stand (done on Mac, all committed)

| Piece | Status |
|---|---|
| Phase 0 audit + cleanups | DONE — dead `computeSystemDiff` IPC chain and `pdf-pymupdf-bridge.ts` deleted |
| Phase 1: frozen relocatable env | DONE (Mac) — tarball + `getPythonInvocation()` seam + first-run unpack |
| Phase 2: bundled ffmpeg | DONE — `getFfmpegPath()` resolves the env's ffmpeg 8.1.1 when bundled |
| Phase 4: electron-builder (Mac) | DONE — staging script + extraResources + validated unpacked build |
| Bundled e2a code seam | DONE — snapshot → writable `userData/runtime/e2a` on first run |

**Validated end-to-end on Mac**: `npm run package:mac` produces an app whose
first launch copies the e2a snapshot (<1 s, APFS clone) and unpacks the 1.69 GB
env tarball + conda-unpack in ~36 s, after which all e2a spawns use the bundled
python with zero conda/Python/ffmpeg on the machine.

## How the bundled runtime works (recap)

```
resources/ (staged by packaging/stage-resources.js, gitignored)
├── e2a-env.tar.gz      conda-pack'd Python env (per-platform!)
└── e2a/                e2a checkout snapshot: code + assets + voices
                        (+ models/ when staged with --models)
        │ electron-builder extraResources
        ▼
<App>/Resources/{e2a-env.tar.gz, e2a/}     read-only
        │ first run (electron/e2a-env-bootstrap.ts, wired in main.ts)
        ▼
userData/runtime/e2a-env/   extracted env + conda-unpack  → python, ffmpeg, sox…
userData/runtime/e2a/       writable e2a root             → tmp/, models/, voices/
```

Resolution seams (all packaged-only via `app.isPackaged`; dev behavior unchanged):
- `getPythonInvocation()` → `runtime/e2a-env/python` directly, no conda
- `getE2aPath()` → `runtime/e2a` (config and `EBOOK2AUDIOBOOK_PATH` still win)
- `getFfmpegPath()` → ffmpeg inside the env (config and `FFMPEG_PATH` still win)
- Dev override for the env path: `BOOKFORGE_E2A_ENV=<unpacked-env-dir>`

Snapshot updates overwrite code but MERGE `models/`/`voices/` (downloads and
voice-conversion caches survive app updates). Stamp files key the idempotence:
`.bookforge-e2a-snapshot.json` (in the snapshot) vs `.bookforge-e2a-ready.json`
(in the runtime copy); the env tarball is keyed on size+mtime.

## What does NOT travel via git

1. **The env tarball** — `packaging/artifacts/*.tar.gz` is gitignored (1.6 GB).
   The Mac one is useless on Windows anyway; you'll build a Windows one (below).
2. **`resources/e2a*`** — staging output, rebuilt by the script on every package run.
3. **The e2a fork** — separate repo. The packaging-critical commits (espeak-ng
   loader in `lib/conf.py`, XTTS text-split changes) are pushed to
   `myfork` (github.com/telltaleatheist/ebook2audiobook). **Pull the fork on
   Windows before doing anything.**

## Progress (Windows session, Jun 12 2026)

Steps 1–3 DONE and validated. The relocatable Windows env tarball is built and
passes a minimal-PATH clean-machine smoke test.

- e2a fork synced (fast-forwarded to `c7a3cc59`; espeak-loader `conf.py` present).
- Built fresh CPU pack-env **`ebook2audiobook-pack`** (py 3.11.15, CPU torch
  2.7.1, coqui-tts 0.27.5, +ffmpeg 8.1.1/sox/mediainfo/espeakng-loader). The
  pre-existing `ebook2audiobook` env is the CUDA dev env — left untouched.
- Packed → `packaging/artifacts/e2a-env-windows-x64.tar.gz` (1.72 GB, gitignored),
  yml committed → `packaging/env/ebook2audiobook-windows-x64.yml`.
- Unpack test (`C:\tmp\e2a-env-test2`): conda-unpack + `compileall` clean +
  minimal-PATH smoke (torch/TTS/transformers/stanza/gradio import, numpy↔torch,
  espeak ru/ar, ffmpeg/ffprobe/sox/mediainfo resolve from relocated Library\bin).

**Two Windows-only gotchas the Mac freeze never surfaced:**
1. **`unidic` dictionary** — `import TTS` crashes with a MeCab error unless the
   full unidic dict is downloaded: `<envpy> -m unidic download` (526 MB into
   site-packages/unidic/dicdir; conda-pack then captures it). Do this BEFORE
   packing, after `pip install -r requirements.txt`.
2. **conda-pack `\\?\` corruption** — base conda-pack had a non-upstream patch in
   `conda_pack/prefixes.py::text_replace` that stripped EVERY `\\?\`/`//?/` from
   text files during conda-unpack, corrupting source files that use Windows
   long-path literals (huggingface_hub `file_download.py`/`_local_folder.py` →
   broke the whole TTS import chain; 7 files total). Fixed to strip the marker
   only where it precedes the inserted prefix. The fix lives ONLY in base's
   site-packages — re-apply if conda-pack is reinstalled, then clear its
   `__pycache__`. Always `compileall` a freshly-unpacked tarball to catch this.

Remaining: step 3.4 (BOOKFORGE_E2A_ENV electron:dev integration run) + step 4
(`npm run package:win-x64` + clean-machine NSIS validation) + the loose ends.

## Windows task list (in order)

### 1. Prereqs on the Windows box
- Pull this repo (branch this file is on) + the e2a fork.
- Miniforge (or existing conda), Node 20+, npm install in the repo.
- The app already runs in dev on Windows — confirm that still holds before
  changing anything: `npm run electron:dev`, run a short XTTS job.

### 2. Recreate the conda env on Windows (Phase 1 for win, Phase 5 decision)
The Mac ymls in `packaging/env/` are **osx-arm64 — do not feed them to the
solver on Windows.** Use them as the authoritative package list only. Steps:

```
conda create -n ebook2audiobook python=3.11
conda activate ebook2audiobook
# CPU torch FIRST (Phase 5 decision: core env is CPU; CUDA becomes an optional
# component later). Pin torch to the same major.minor as the Mac env (see yml).
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r <e2a>/requirements.txt        # e2a's own requirements
conda install -c conda-forge ffmpeg sox mediainfo
pip install espeakng-loader conda-pack
```

Watch for (all bit us on Mac):
- **coqui-tts ≥ 0.27.3** (streaming needs it).
- **espeakng-loader**: verify the wheel installs on win-x64 and that
  `python -c "from phonemizer.backend import EspeakBackend; print(EspeakBackend.is_available())"`
  prints True, and `echo привет | python -c "..."`-style ru/ar phonemize works.
  `lib/conf.py` prefers the loader and falls back to the Scoop path on Windows.
- **Solver drift**: on Mac, `--freeze-installed` still moved python 3.11.13→3.11.8
  and protobuf 5→6. Smoke-import the heavy stack afterwards
  (torch, TTS, transformers, stanza, gradio).

Then validate dev on Windows against this env (named-env resolution is the
existing default — `conda env list` must show `ebook2audiobook`).

### 3. Freeze + relocatable test (Windows)
```
conda run -n base conda-pack -n ebook2audiobook -o packaging/artifacts/e2a-env-windows-x64.tar.gz --n-threads -1
conda env export -n ebook2audiobook > packaging/env/ebook2audiobook-windows-x64.yml   # commit the yml
```
Unpack-test exactly like the Mac validation:
1. Extract the tarball to e.g. `C:\tmp\e2a-env-test` (`tar -xzf` — Windows 10
   1803+ ships `tar.exe` in System32; the bootstrap relies on this).
2. Run conda-unpack via the env's own python:
   `C:\tmp\e2a-env-test\python.exe C:\tmp\e2a-env-test\Scripts\conda-unpack-script.py`
3. With a minimal PATH, verify ffmpeg/ffprobe/sox/mediainfo resolve from
   `Library\bin`, phonemizer works, and `python app.py --help` boots e2a.
4. Then the real integration test:
   `set BOOKFORGE_E2A_ENV=C:\tmp\e2a-env-test` + `npm run electron:dev`,
   run a TTS job end-to-end.

Windows-specific code paths to watch (already written, never executed):
- `relocatablePythonPath` → `<env>\python.exe` (root, not bin/)
- `relocatableEnvBinDirs` → env root, `Library\mingw-w64\bin`, `Library\usr\bin`,
  `Library\bin`, `Scripts`
- `buildCondaSpawnEnv` System32/COMSPEC handling
- `shellEscapeArgs` cmd.exe quoting at the two `shell: true` spawn sites
  (reassembly-bridge, xtts-streaming-bridge)

### 4. Package + clean-machine validation (Phases 4, 8)
```
npm run package:win-x64
```
The staging script auto-picks `e2a-env-windows-x64.tar.gz` by platform and
finds e2a via `EBOOK2AUDIOBOOK_PATH` or `--e2a` (default `~/Projects/...` won't
match Windows layout — set the env var).

Validate the NSIS installer on a machine/VM with **no conda, no Python, no
ffmpeg** (the MSI laptop is the canary):
- First launch: watch the unpack (logs say `[E2A-CODE]` / `[E2A-ENV]`).
- Run a short XTTS job; confirm M4B output + cover metadata (BookForge's own
  ffmpeg calls now use the env's ffmpeg).
- SmartScreen/Defender will warn on the unsigned exe — document the exact
  click-through for the install doc.

### 5. Loose ends (either machine, not blockers)
- **Phase 3**: offline build = `npm run package:mac:offline` / add a win
  equivalent (`stage:packaging:offline` works anywhere) — stages the 26 GB
  `models/` into the snapshot; first-run merge-copies them. Not yet exercised.
- **Phase 6**: first-run gating — block job submission until the bootstrap
  finishes (currently a job started in the first ~40 s of first launch would
  miss the bundled runtime and fail loudly). Plus the doctor/health screen.
- **WSL/Orpheus**: intentionally OUT of the core Windows build. Orpheus stays
  an optional component; WSL routing is untouched.
- `tone`/`m4b-tool` bundling decision; `ocr-service` bare `python3` decision
  (see packaging-pipeline.md Phase 0 list).

## Quick reference — new/changed pieces from the Mac session

| File | What |
|---|---|
| `packaging/stage-resources.js` | Stages `resources/e2a-env.tar.gz` + `resources/e2a/` snapshot; `--models` for offline builds; clone-on-write copies |
| `electron/e2a-env-bootstrap.ts` | `ensureBundledEnv()` (tarball→runtime) + `ensureBundledE2a()` (snapshot→runtime) + `getActiveBundled*Path()` resolvers + `relocatableBinaryPath()` |
| `electron/tool-paths.ts` | `getFfmpegPath()` / `getE2aPath()` bundled tiers |
| `electron/e2a-paths.ts` | `getPythonInvocation()` (Phase 1), `buildCondaSpawnEnv()` PATH enrichment |
| `package.json` | `stage:packaging[:offline]`, `package:mac[:offline]`/`package:win*` chain staging; extraResources; `compression: store` + ULFO dmg (payload is already-compressed) |

Build commands: `npm run package:mac` (lean), `npm run package:mac:offline`
(+26 GB models), `npm run package:win-x64`. For an unpacked test build append
nothing — use `npm run electron:build -- --mac --dir` (output in `release/`).

---

# llama.cpp local-LLM bundling (added Jun 13 2026, on Mac)

This wires the **AI Setup wizard's local-model path** (`electron/llama-bridge.ts`)
so the bundled `llama-server` actually ships. Until now `resolveBinary()` found
nothing, `localStatus().binaryPresent` was false, and the wizard steered users to
Ollama / API keys. See memory notes `ws2-ai-setup-wizard-direction` and
`packaging-distribution-initiative`.

## Done on Mac (committed, verified end-to-end)

| Piece | Status |
|---|---|
| `scripts/download-llama-cpp.js` | NEW — fetches the pinned llama.cpp prebuilt for the **host** platform (build-on-target, like `download-mupdf.js`), stages into `resources/bin/` |
| `package.json` scripts | `download:llama` added; chained into `package:mac[:lean:offline]` + `package:win[-x64]` right after `download:mupdf` |
| `package.json` extraResources | mac: `llama-server-${arch}` + `*.dylib`; win: `llama-server.exe` + `*.dll` — mirrors the mutool pattern |
| Mac binary | VERIFIED — `version: 7482`, runs from inside the packaged `.app` `Resources/bin` in a **clean env** (no `DYLD_LIBRARY_PATH`); all load commands rewritten to `@loader_path`, ad-hoc codesigned |
| e2a snapshot re-stage | DONE — bumped from stale `d92629b9-dirty` to `b267cd11+seed`, so the **custom-voice** code (args/session/worker_core/worker.py) now ships |

### Decisions locked in (with the user)
1. **llama.cpp version**: pinned **`b7482`** (matches Briefcase's proven pin; `LLAMA_CPP_VERSION` in the script).
2. **Windows flavor**: **CUDA 12.4** build (`WIN_CUDA_TAG`), not CPU-only. The CUDA
   binary still runs on CPU where no NVIDIA GPU/driver is present — it hard-links
   only the bundled CUDA *runtime* (cudart), not the GPU driver. So we bundle the
   CUDA build **plus** `cudart-llama-bin-win-cuda-12.4-x64.zip`. (12.4 over 13.1 for
   wider driver compatibility.)
3. **Seed model**: **download-on-demand** (unchanged). Binary ships; the wizard
   downloads Cogito 3B (~2.2 GB) on first use. No GGUF in the installer.
4. **Linux**: deferred. Script `warn()`s and skips on Linux; no `build.linux`
   llama entry. The release has `llama-b7482-bin-ubuntu-x64.zip` when we want it.

### How the Mac path resolves (recap)
`download-llama-cpp.js` → `resources/bin/llama-server-arm64` + `lib*.dylib`
(original leaf names — no whisper here, so none of Briefcase's rename/prefix
dance) → electron-builder extraResources → `<App>/Resources/bin/` →
`resolveBinary()` finds `process.resourcesPath/bin/llama-server-<arch>`. Dev
fallback `resources/bin/` also works after `npm run download:llama`.

## Windows task list (do these on the Windows box)

> **Build-on-target**: `download-llama-cpp.js` keys off `process.platform`, so
> running it on Windows fetches the Windows CUDA build. Nothing Windows-specific
> needs editing — just run the package script. These steps are mostly *verify*.

1. **Pull this repo + the e2a fork.** Confirm the e2a fork is at **`b267cd11`**
   (or later) so the custom-voice code stages — `npm run package:win-x64` runs
   `stage:packaging:seed`, which snapshots whatever the fork checkout currently is.
   (Set `EBOOK2AUDIOBOOK_PATH` to your Windows e2a path; the `~/Projects/...`
   default won't match.)

2. **Fetch + stage the binary** (happens automatically inside `package:win-x64`,
   but you can run it standalone first to eyeball it):
   ```
   npm run download:llama
   ```
   Expect ~595 MB of downloads (204 MB CUDA build + 391 MB cudart), cached in
   `.llama-build/` (gitignored). It copies `llama-server.exe` + all `*.dll` from
   both archives into `resources/bin/`.

3. **VC++ runtime — VERIFY.** When run on Windows the script copies
   `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`,
   `MSVCP140_CODECVT_IDS.dll` from `System32` into `resources/bin/`. Confirm they
   land. If your build box somehow lacks them, install the **VC++ 2015–2022
   Redistributable** first. (It cannot bundle these when cross-built from Mac —
   that's why this must run on Windows.)

4. **Smoke-test the binary from the staged path** (PowerShell):
   ```
   .\resources\bin\llama-server.exe --version
   ```
   Should print `version: 7482 ...` and exit 0. The bridge sets `cwd` to the
   binary dir at runtime so the DLLs resolve; running it from `resources/bin`
   directly mimics that.

5. **Package + inspect the bundle.**
   ```
   npm run package:win-x64
   ```
   Then confirm `release\win-unpacked\resources\bin\` contains `llama-server.exe`
   + the DLLs (cudart64_*, cublas*, ggml*, llama*). `resolveBinary()` looks at
   `process.resourcesPath\bin\llama-server.exe`.

6. **CPU-fallback check (important for the CUDA decision).** On a machine with
   **no NVIDIA GPU/driver**, confirm `llama-server.exe` still loads and serves
   (it should find 0 CUDA devices and fall back to CPU). If it fails to load due
   to a missing `nvcuda.dll`, that's a driver-only DLL we do NOT bundle and the
   binary shouldn't hard-link — flag it if it happens.

7. **End-to-end** (the real acceptance test, either platform): package →
   first-run → **AI Setup → download Cogito 3B → run an AI cleanup job** →
   confirm the local provider generates (not Ollama/API). On Mac this is ready to
   try now; on Windows after steps 1–6.

## CUDA acceleration as a download-on-demand component (added Jun 13 2026, Windows)

Done — the Windows bundle now ships **CPU-only** llama and the CUDA build is an
optional component gated on a detected NVIDIA GPU.

- `scripts/download-llama-cpp.js` → `setupWindows()` now fetches
  `llama-b7482-bin-win-cpu-x64.zip` (~20 MB) instead of the CUDA build + cudart.
- `electron/components/llama-cuda.ts` (NEW): the `llama-cuda` catalog entry
  (managed `binary`, `requirements.platforms:['win32']`, `gpu:'cuda'`) +
  `downloadLlamaCudaInto()`. Fetches the two release zips (build 204 MB + cudart
  391 MB) **upstream llama.cpp GitHub first, falling back to the BookForge GitHub
  release (`assets` tag)** (byte-identical; the mirror has both zips, but NOT the CPU zip),
  flattens `llama-server.exe` + all CUDA/ggml DLLs + cudart + the bundled VC++
  runtime (copied from `resources/bin`) side-by-side into
  `userData/components/llama-cuda/`.
- `component-manager.install()` branches the download step for `llama-cuda`; the
  rest of the generic binary flow (compat/disk pre-check, verify-run, atomic
  move, record) is reused. Verify = `llama-server.exe --version` (expects
  `version`).
- `llama-bridge.ts` `resolveBinary()` prefers `componentManager.resolveEntry('llama-cuda')`
  on Windows, else the bundled CPU build. The server now tracks `loadedBinary`
  and restarts when the resolved binary changes (install/remove the pack →
  next generate switches CPU↔GPU without an app restart).
- UI: the Add-ons panel shows a detected-GPU explainer on the CUDA card ("We
  found your <GPU>…") and an add-ons "Delete all downloads" (managed installs
  only). The first-run "Optional tools" step embeds this panel, so CUDA surfaces
  there too. Uninstall (delete option) is the standard managed-component button.
- **VALIDATED**: extract→flatten→VCRUNTIME against the cached zips produces a
  binary that loads the CUDA backend (RTX 3090 Ti detected) and prints
  `version: 7482`, exit 0. Full app-driven download+install not yet run.
- **`resources/bin` re-staged to CPU (DONE Jun 13 2026)**: deleted the stale GPU
  DLLs (`cublas64_12.dll`, `cublasLt64_12.dll`, `cudart64_12.dll`,
  `ggml-cuda.dll`, ~1 GB) and ran `npm run download:llama -- --force`. `resources/bin`
  is now 68 MB; `llama-server.exe --version` loads only RPC + CPU backends (no
  CUDA), `version: 7482`. Note the script copies, never cleans — if you ever
  re-introduce the CUDA build into `resources/bin`, delete those four DLLs by
  hand before re-staging CPU.

## Fallback-mirror wiring for downloads (added Jun 13 2026)

Done — component downloads try upstream first, then the BookForge GitHub release
mirror (`assets` tag). (The former owenmorgan.com mirror was retired Jun 30 2026.)

- **CUDA**: handled in `components/llama-cuda.ts` (GitHub → mirror), see above.
- **XTTS voices + base**: `bookforge_ext/download_model.py` (in the e2a fork). On
  any `snapshot_download` failure it calls `_download_xtts_from_mirror()`, which
  fetches the files from `…/bookforge/xtts-v2/` (base, repo `coqui/XTTS-v2`) or
  `…/bookforge/voices/<id>/` (fine-tuned, repo `drewThomasson/fineTunedTTSModels`;
  `<id>` = last path component of the voice's `sub`) and writes a **valid HF-cache
  layout** (`refs/main` + `snapshots/<sha>/<sub>/<file>`). It uses the real `main`
  sha from `HfApi().model_info()` when the hub metadata is reachable (so the entry
  resolves transparently online too — no re-download), else a deterministic fake
  sha (offline-only). VERIFIED: a mirror-built entry resolves via
  `hf_hub_download(local_files_only=True)`, which is exactly how `xtts.py`/`utils.py`
  load checkpoints.
- **Stanza language packs**: `_download_stanza_from_mirror()` fetches
  `…/bookforge/stanza/<lang>/default.zip` and extracts it into
  `models/stanza/<lang>/`. The full `resources.json` catalog already ships with the
  bundled core langs, so `Pipeline(REUSE_RESOURCES)` finds the new lang once its
  model files are present. The mirror does NOT host `resources.json` — this relies
  on at least one bundled stanza lang (English is always bundled). Mirror only
  hosts a subset of voices/langs; a non-mirrored file 404s and the fallback
  cleanly reports "no mirror fallback available".
- Mirror base is overridable via `BOOKFORGE_MIRROR_BASE` (for testing).
- **NOTE**: this edits the **e2a fork** (`bookforge_ext/download_model.py`), a
  separate repo — commit it there so `stage:packaging:seed` snapshots it.

## First-run "select now, download at the end" + dockable progress (Jun 14 2026)

The first-run setup no longer downloads inline. Each step's panel runs in a new
selection mode (checkboxes); a final "Review & download" step batches everything.

- `core/services/setup-download.service.ts` (NEW, root singleton): holds the
  checked-component id set + a SEQUENTIAL batch runner (one `componentService.install`
  at a time so the queue isn't overloaded), gating voice/language items on
  `runtime.whenReady()` (added — resolves on ready OR error so a stalled setup
  fails loud instead of hanging). Uncheck a queued item → skipped; cancel the
  running one or the whole batch.
- `components/setup-download-dock/`: a fixed bottom-right progress widget mounted
  in `app.ts` (above the router-outlet) so it SURVIVES leaving first-run and the
  batch keeps running. Expand/collapse via the arrow; collapses to a corner pill
  when the user hits "Start … & finish".
- Selection mode added to `voices-panel`, `languages-panel`, `add-ons-panel` via
  an `input(false)` `selectionMode` — checkboxes replace Get/Install; Settings is
  unchanged (default off). Per the user: only downloadable add-ons (CUDA) get a
  checkbox; external BYO tools (Calibre/Tesseract) keep Locate.
- `first-run-setup` gains a 5th `download` step (review list + total size) and a
  footer "Start N downloads & finish" / "Finish without downloading".
- **Locate… upgraded**: now auto-searches the platform's common locations first
  (`componentManager.detectExternal`), and only if nothing's found reveals an
  inline form to type the full path OR browse (for users with a specific version).
  `ComponentService.autoLocate()` / `setManualPath()` added; `locate()` now
  returns a boolean.
- Verified: both projects build clean (strict templates) + electron tsc clean.
  NOT yet visually driven in a running app — fold a first-run click-through into
  the next manual pass.

## Slim single-file Inno installer (Jun 14 2026)

Target met: the seed payload now fits a single Setup.exe (< Inno's ~4.2 GB cap).

- **CPU llama (CUDA out)**: done (resources/bin 68 MB; see above).
- **Stanza trim** (`packaging/stage-resources.js`): the seed stanza copy now
  filters each lang dir to only the processor models the pipeline loads —
  `tokenize`, `mwt`, `ner` + the NER dependency closure (`pretrain`,
  `forward_charlm`, `backward_charlm`). Drops `default.zip` (502 MB redundant
  archive), `depparse`, `pos`, `lemma`, `constituency`, `sentiment`. English:
  **1.1 GB → 209 MB**. VERIFIED: (a) the trimmed pack loads `tokenize,ner,mwt`
  via the exact `REUSE_RESOURCES` Pipeline call and NER still tags DATE entities
  (`1945`, `the 1960s`) — `get_date_entities` (year→decades) keeps working; (b)
  the cpSync filter copies only the 6 kept dirs on Windows (the `\\?\` prefix is
  stripped, or the filter silently passes everything — same gotcha as the
  snapshot filter). The task's "tokenizer-only" guess was wrong — NER IS used
  (lib/core.py `doc.ents`), so tokenize-alone would break date handling.
- **Inno single-file**: `bookforge.iss` default flipped to
  `EnableSpanning="no"`; `build-inno.js` passes `/DEnableSpanning=no` by default
  (+ a raw-size > 4.2 GB warning) and takes `--spanning` for the offline
  (+26 GB models) build. Compression stays `lzma2/max`. `package:win-inno` →
  single file.
- **Estimated seed payload** (no full build run here): env tarball 1.84 GB +
  Scarlett 1.74 GB + stanza 0.21 GB + electron/code ≈ **~4.0 GB raw → ~3.8–3.9 GB
  compressed** single file. Seed bundles NO base XTTS (download-on-demand), only
  Scarlett. Headroom to the 4.2 GB cap is modest — if a future seed addition
  pushes it over, fall back to `build-inno.js --spanning`. The real installer
  size is confirmed only by an actual `npm run package:win-inno`.

## Known caveats / possible cleanups

- **Mac dylib tripling**: the release tarball ships versioned symlink chains
  (`libggml.dylib → .0.dylib → .0.9.4.dylib`); `copyFileSync` follows them, so we
  stage 3 real copies of each (~10 MB extra total). Harmless, the binary refs the
  `.0.dylib` variants. Could preserve symlinks later to shave size — low priority.
- **CUDA bundle size**: RESOLVED — the installer now ships the CPU-only build
  (~20 MB) and CUDA is a download-on-demand component (see the CUDA section
  above). Watch the task-4 follow-up: `resources/bin` must be re-staged to the
  CPU build before the next package.
- **WS5 custom voice — NOT runtime-tested**: the e2a code now ships, but nobody
  has run full audiobook gen with a real user fine-tuned checkpoint through the
  pre-staged `custom_model_dir`. Fold a real-checkpoint test into the Windows pass.
- **Linux**: no llama-server (and no e2a env) — local-LLM path is unavailable on
  Linux builds by design for now.
