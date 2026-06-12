# Packaging Pipeline — Standalone Distributable

Goal: ship BookForge as a self-contained, per-platform unit (Electron shell + e2a +
frozen Python env + ffmpeg + models) that runs on a clean Win/Mac with **no dev
setup, no conda, no Python, no ffmpeg** preinstalled. Unsigned is acceptable (will
trip AV/Gatekeeper — document the bypass). Size-is-fine: the user has opted to
**bundle all models** for a fully-offline first launch.

See also: `docs/optional-components-design.md` (the Optional Component System that
handles everything *optional* — Calibre, Orpheus, Tesseract packs, CUDA torch).

## The size reality (measured Jun 2026)

| Piece | Size | Ship? |
|---|---|---|
| e2a **code** (lib + bookforge_ext + ext + scripts) | ~6 MB | ✅ All of it — keep 100%, it's free |
| conda env `ebook2audiobook` | **4.4 GB** (1.6 GB packed; now includes ffmpeg/sox/mediainfo/espeak) | ✅ The real payload (one freeze per platform) |
| `models/tts` (all 8 engines × languages) | **26 GB** | ✅ Bundling all (offline). Lean alt: XTTS-v2 ~1.8 GB + on-demand |
| `models/stanza` (NLP sentence/lang) | 590 MB | ✅ Bundle |
| `voices` | 198 MB | ✅ Bundle |
| ffmpeg / ffprobe | rides the env tarball | ✅ **84 ffmpeg + 24 ffprobe call sites — mandatory**; BookForge's own calls also resolve to the env's ffmpeg 8.1.1 when bundled |

**Key reframe:** keeping all e2a *code* costs ~6 MB; the "bloat" is model *weights*,
which are runtime downloads, not code. So "keep all of e2a" and "lean installer" are
NOT in conflict — they're only in conflict if you pre-bundle all 26 GB (which the
user has chosen to do for offline UX). The 4 GB env already runs 7 of 8 engines;
only **Orpheus** has its own env (`ebook2audiobook-orpheus`) → stays an optional
component. Fork is already clean for a possible give-back to e2a maintainers
(~25 lines touch upstream; all custom code in `bookforge_ext/`).

## Engines present in e2a
bark, fairseq, orpheus, tacotron, tortoise, vits, xtts, yourtts. XTTS is the
required core; Orpheus is optional (separate env). Others ride along in the 4 GB env.

---

## Steps

Tags: **[code]** source change · **[decision]** choice to lock · **[logistics]**
machine/host work (no code).

### Phase 0 — Audit the runtime contract (the seam)
- [x] **[code]** Enumerate every subprocess BookForge + e2a spawn (audit done
      Jun 12 2026 — findings below).
- [ ] **[code]** Single `app.isPackaged` branch concept: dev → current behavior;
      packaged → bundled-resources paths.

#### Audit findings (Jun 12 2026)

**Resolves correctly through central seams** (no change needed; Phase 1/2 just
repoint the resolvers):
- All e2a Python spawns — `tts-bridge`, `parallel-tts-bridge`, `xtts-worker-pool`,
  `xtts-streaming-bridge`, `reassembly-bridge`, `bilingual-assembly-bridge` — go
  through `getCondaPath()` + `buildCondaSpawnEnv()` (e2a-paths.ts). Name-based
  env resolution is the Phase 1 fix.
- ffmpeg in `video-assembly-bridge` and `metadata-tools` → `getFfmpegPath()`.
- ebook-convert → `componentManager.resolveEntry('calibre')` seam.
- Orpheus env → `getEnvPathForEngine('orpheus')` (throws, no silent fallback).

**Fixed during audit:**
- `chapter-recovery-bridge.ts` spawned bare `'ffmpeg'` → now `getFfmpegPath()`.
- ffmpeg-dir PATH enrichment lived only in reassembly-bridge → moved into
  `buildCondaSpawnEnv()` so EVERY e2a spawn finds ffmpeg/ffprobe under a packaged
  app's minimal PATH (e2a's Python — pydub etc. — resolves them from PATH).

**Verified env fact (changes Phase 2 scope):** the `ebook2audiobook` conda env
contained NO ffmpeg/ffprobe/sox/espeak-ng/mediainfo — only `ebook-convert`.
**Superseded Jun 12 2026:** ffmpeg/sox/mediainfo conda-installed into the env,
espeak-ng via the `espeakng-loader` pip wheel — all ride the tarball now (see
Phase 1/2).

**Remaining leaks / cleanups:**
- [x] **[code]** `epub-processor.ts computeSystemDiff()` — DELETED Jun 12 2026
      (handler, preload entries, electron.service method, 134-line block).
- [x] **[code]** `pdf-pymupdf-bridge.ts` — DELETED Jun 12 2026.
- [ ] **[code]** `ocr-service.ts preprocessImage()` spawns bare `python3`
      (graceful-degrade preprocess step). Decide: route through a resolver, or
      accept degradation (OCR is optional/BYO anyway).
- [ ] **[decision]** `apple-vision-ocr` plugin spawns system `python3` (macOS).
      Needs CLT-installed python3 on target Macs — document or rework.
- [ ] **[decision]** `metadata-tools.ts` resolves `tone`/`m4b-tool` via its own
      candidate scan. For packaging: bundle `tone` (single static binary, no PHP)
      per platform and point the scan at it.
- [ ] **[note]** `jwpub-converter.ts` falls back to `sqlite3` CLI only when
      `better-sqlite3` is unavailable — packaged app always ships better-sqlite3,
      so not a blocker.
- [ ] **[note]** tesseract resolution is an ad-hoc candidate scan in
      `ocr-service.ts` — fold into the component system when doing the Tesseract
      language-pack work.
- [x] **[code, e2a]** `lib/conf.py` hardcoded Windows Scoop path for espeak-ng —
      fixed Jun 12 2026: prefers `espeakng-loader` paths, Scoop kept as Windows
      fallback. (Change lives in the e2a fork — commit it there.)
- [ ]  **[note, e2a]** demucs (inside the env) shells out to ffmpeg bare — covered
      by the PATH enrichment; no patch needed.

### Phase 1 — Freeze the Python env (the linchpin) — DONE Jun 12 2026
- [x] **[logistics]** `conda env export` → `packaging/env/ebook2audiobook-macos-arm64.yml`
      (canonical freeze; `.pre-binaries.yml` alongside is the pre-install snapshot).
- [x] **[logistics]** Binaries installed INTO the env first (see Phase 2 decision):
      `conda install -c conda-forge ffmpeg sox mediainfo` + `pip install
      espeakng-loader`. Solver side effects (all smoke-tested OK): python
      3.11.13→3.11.8, protobuf 5.29→6.33, grpcio 1.78, libcxx 22. Env grew
      4.0 → 4.4 GB.
- [x] **[code/logistics]** `conda-pack` → `packaging/artifacts/e2a-env-macos-arm64.tar.gz`
      (1.6 GB, gitignored). Repack command:
      `conda run -n base conda-pack -n ebook2audiobook -o packaging/artifacts/e2a-env-macos-arm64.tar.gz --n-threads -1`
- [x] **[code]** First-run unpack: `electron/e2a-env-bootstrap.ts`
      (`ensureBundledEnv()`), wired into `main.ts` app.whenReady. Extracts
      `resources/e2a-env.tar.gz` → `userData/runtime/e2a-env`, runs conda-unpack
      **via the env's own python** (its shebang is `#!/usr/bin/env python`, which
      fails on a clean machine), writes a ready-marker keyed on tarball
      size+mtime so a new tarball forces re-unpack.
- [x] **[code]** Env resolution seam: `resolveCondaEnv` gained a `relocatable`
      kind (wins over prefix/named; never used for Orpheus), and
      `getPythonInvocation()` replaced `getCondaRunArgs()`/`getCondaPath()`
      pairing at every e2a spawn site (6 bridges). Relocatable → direct
      `<env>/bin/python`, no conda. `buildCondaSpawnEnv` prepends the env's bin
      dirs + sets CONDA_PREFIX (replaces `conda activate`). shell:true sites
      (reassembly, xtts-streaming) now escape the command too — the bundled
      python lives under "Application Support" (space!).
- **Dev override**: `BOOKFORGE_E2A_ENV=<unpacked-env>` forces the relocatable
  path without packaging (set-but-invalid throws; no silent fallback).
  Validated end-to-end: tarball → /tmp unpack → conda-unpack → minimal-PATH
  smoke (torch/TTS/stanza imports, ffmpeg/ffprobe/sox/mediainfo/ebook-convert
  all `shutil.which`-resolve into the env, ru/ar phonemize works, `app.py
  --help` boots).

### Phase 2 — Bundle native binaries
- [x] **[decision]** e2a-side binaries — RESOLVED Jun 12 2026 by riding the env
      tarball: `conda install -c conda-forge ffmpeg sox mediainfo` into the env
      before packing. All of e2a's ffmpeg/ffprobe/sox/mediainfo `shutil.which`
      call sites resolve from the env's bin (first on PATH via
      `buildCondaSpawnEnv`). This SUPERSEDES the npm-installer approach for the
      e2a side entirely.
- [x] **[decision]** espeak-ng — NOT on conda-forge for osx-arm64 at all.
      RESOLVED via `pip install espeakng-loader` (wheel ships libespeak-ng +
      espeak-ng-data inside site-packages → rides the tarball) + e2a
      `lib/conf.py` now sets PHONEMIZER_ESPEAK_LIBRARY/ESPEAK_DATA_PATH from the
      loader when importable (Scoop hack kept as Windows fallback). Bonus: this
      FIXED phonemizer — brew espeak-ng was never found by the env
      (`EspeakBackend.is_available()` was False even in dev), so ar/ru
      phonemization had silently never worked.
- [x] **[code]** BookForge's OWN direct ffmpeg calls (`video-assembly-bridge`,
      `metadata-tools`, `chapter-recovery-bridge` via `getFfmpegPath()`) —
      RESOLVED Jun 12 2026 by the "simpler alternative": `getFfmpegPath()`
      gained a bundled-env tier (config > FFMPEG_PATH > **relocatable env's
      ffmpeg** > system auto-detect). New `relocatableBinaryPath()` in
      `e2a-env-bootstrap.ts` finds binaries across the env's bin dirs
      (`Library/bin` on Windows). Briefcase's npm-installer approach was
      REJECTED: its `@ffmpeg-installer` binaries are ffmpeg 4.4 (2021) and
      would duplicate ~50 MB the tarball already ships; the env's ffmpeg is
      8.1.1 arm64 with libx264/aac and verified to run standalone (`env -i`)
      after conda-unpack. Smoke-tested under Electron: override →
      `<env>/bin/ffmpeg`, no override → dev behavior unchanged (brew), invalid
      override → throws. Briefcase's *pattern* (centralized resolver,
      bundled-beats-autodetect) is what carried over.
- [ ] **[note]** First-run edge: BookForge's own ffmpeg call before
      `ensureBundledEnv()` finishes unpacking resolves to system detection
      (nothing on a clean machine). In practice all three call sites run inside
      jobs the user can't start that early; Phase 6 first-run gating closes it
      properly.

### Phase 3 — Bundle models & assets
- [ ] **[decision]** Model strategy — CHOSEN: bundle all `models/tts` +
      `models/stanza` + `voices` (~27 GB) for fully-offline first launch.
- [x] **[code]** Mechanism done Jun 12 2026 via the e2a-code seam: e2a derives
      every model/cache path from its own root (lib/conf.py), and that root is
      the writable `userData/runtime/e2a` copy — no env-var pointing needed.
      `voices/` always ships; `models/` ships when staged with `--models`
      (`package:mac:offline`); first run merge-copies them (clone-on-write, so
      same-volume seeding is instant). Without `--models`, e2a downloads into
      the writable runtime dir on demand (online first run).
- [ ] **[logistics]** Exercise the offline build once: `npm run
      package:mac:offline`, verify a no-network first launch + TTS job.

### Phase 4 — electron-builder packaging
- [x] **[code]** Staging script `packaging/stage-resources.js` (Jun 12 2026):
      copies the platform tarball to `resources/e2a-env.tar.gz` and snapshots
      the e2a checkout to `resources/e2a/` (code + assets + voices; models
      with `--models`; excludes tmp/ebooks/git/caches). Clone-on-write copies
      (FICLONE) — staging is near-instant on APFS. Stamp file = e2a git rev.
- [x] **[code]** Bundled e2a code seam (Jun 12 2026): e2a writes under its own
      root (tmp/models/voices via lib/conf.py), so the read-only snapshot is
      copied to `userData/runtime/e2a` on first run by `ensureBundledE2a()`.
      Code overwrites on snapshot change; models/voices MERGE (no overwrite) so
      downloads/voice-caches survive updates. `getE2aPath()` gained a bundled
      tier. Both bundled resolvers (`getActiveBundledEnvPath`,
      `getActiveBundledE2aPath`) are **packaged-only** (`app.isPackaged`) —
      dev shares the same userData dir as a locally-built packaged app and must
      never silently resolve to stale runtime copies (BOOKFORGE_E2A_ENV is the
      dev override).
- [x] **[code]** `extraResources` (mac + win): env tarball + e2a snapshot +
      existing mutool. `compression: store` + dmg ULFO — the payload is an
      already-compressed tarball. No asarUnpack needed: nothing Python touches
      lives in the asar (env + e2a are extraResources).
- [x] **[logistics]** Validated Jun 12 2026: `electron-builder --mac --dir`
      build; first launch installed the e2a snapshot (<1 s, APFS clone) and
      unpacked + conda-unpacked the 1.69 GB env in ~36 s; the runtime python
      and e2a layout verified. dmg target configured but a full dmg not yet
      produced (do alongside Phase 8 clean-machine test).
- [ ] **[logistics]** Mac `dmg` smoke + offline variant (`package:mac:offline`
      stages the 26 GB models into the snapshot) — not yet exercised.

### Phase 5 — Torch / accelerator tiering
- [ ] **[decision/code]** Mac: arm64 torch (MPS/CPU) baseline — already in 4 GB env.
- [ ] **[code]** Windows: **CPU torch** in core env (runs everywhere) + **CUDA torch
      as an optional component** (managed download) for NVIDIA users (e.g. wife's
      RTX 3070). Reuses the component system.

### Phase 6 — First-run orchestration
- [ ] **[code]** First-launch routine: `conda-unpack` → verify Python launches →
      verify ffmpeg → write resolved paths → mark initialized.
- [ ] **[code]** A "doctor"/health screen surfacing component + runtime states
      (extends the Add-ons tab).

### Phase 7 — Build infrastructure
- [ ] **[logistics]** Mac build from the user's machine.
- [ ] **[logistics]** **Windows build needs a real Windows machine/VM/CI** —
      conda-pack can't cross-build. Reproduce env on Windows first, then pack there
      (wife's MSI or a cloud Windows runner).

### Phase 8 — Validation
- [ ] **[logistics]** Clean-machine test: Mac + Windows with NO conda/Python/ffmpeg.
      The MSI is the Windows canary.
- [ ] **[logistics]** Offline test (bundling all models → should pass with no net).
- [ ] **[logistics]** Gatekeeper/SmartScreen/AV: unsigned warns; document the bypass.

---

## Critical path & ordering
Phase 1 (env freeze + name→path resolution) → Phase 2 (ffmpeg) → Phase 4
(electron-builder). Phases 3, 5, 6 are additive. Phase 7 Windows is parallel
logistics, startable anytime.

**Realistic order vs. what's done:** ~~Phase 0~~ → ~~Phase 1 (Mac)~~ →
~~Phase 2~~ → ~~Phase 4 (Mac wiring + validated --dir build)~~ (all done
Jun 12 2026) → **Windows** (Phase 7 + win replication of 1/4 —
see `docs/windows-packaging-handoff.md` for the step-by-step) → Phase 6
first-run gating + doctor → Phase 3 offline-build exercise → Phase 8
validation → torch/CUDA tiering (Phase 5) as polish. Tesseract packs are the
optional-components track and don't block the standalone.

## Prerequisites already in place
- Optional Component System (Phases 1–3 done): Calibre + Orpheus wired through
  `componentManager.resolveEntry()`; Add-ons UI; honest install/incompatible states.
- Resemble/DeepFilter/denoise cut (−3,244 lines).
- Calibre format-gating + install prompt.
- Surya/Paddle OCR removed.

## Still ahead before packaging starts in earnest
- **Tesseract managed language packs** (first real managed-download exercise) —
  see `optional-components-design.md` and the packaging-distribution memory.
