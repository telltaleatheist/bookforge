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
