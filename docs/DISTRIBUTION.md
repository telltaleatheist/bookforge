# Distribution — what BookForge downloads, where it lives, and how to publish more

**Status: REFERENCE.** Written 2026-08-04 from the code as it stands, so that the
publishing procedure stops living only in people's heads. Every rule below names
the file and symbol that enforces it, and every command is one that exists in
this repo (or in `telltaleatheist/foundry`). Where something could not be
verified from code or from a real command, it says so rather than guessing — a
runbook that is wrong in one step is worse than one that admits a hole. Open
problems found while writing this are collected in **Known gaps** at the end and
were deliberately left un-fixed.

BookForge ships a small core and fetches the heavy pieces at runtime. That is the
whole reason this document exists: nearly everything expensive — the Python
environment, the voices, the models, the CLI that does OCR — arrives over the
network after install, from one of three hosts, under version constants that a
human bumps by hand.

---

## 1. Orientation — where does X come from?

Every runtime-downloaded artifact, its host, the constant that pins its version,
and the code that decides whether the bytes that arrived are the right bytes.

| Artifact | Host | Version pinned by | Verified by |
|---|---|---|---|
| **Foundry CLI** (`foundry`/`foundry.exe`) | GitHub Releases · `telltaleatheist/foundry` · tag `v<version>` | `FOUNDRY_CLI_VERSION` — `electron/components/foundry-cli-components.ts` | sha256 in that file's `ASSETS`, checked by `downloadAndExtract` (`electron/components/downloader.ts`); then `foundry --version` via the component's `verify` spec |
| **Foundry stage models** (`foundry-4b-f16.gguf`, `foundry-blocks-v1-4b.gguf`, `foundry-ocr-v1-4b.gguf`, `foundry-footnotes-v1-4b.gguf`) | Hugging Face · `owenmorgan/foundry-models` | per-entry `sha256`/`bytes` in `FOUNDRY_MODELS` — foundry `src/models/catalog.ts` | `downloadVerified` — foundry `src/models/download.ts` |
| **Foundry's vendored Tesseract** | GitHub Releases · `telltaleatheist/foundry` · tag `assets` | `artifact{}` per platform in `vendor/tesseract/manifest.json` (foundry) | `ensureVendorTesseract` — foundry `src/models/vendor-tesseract.ts`; every binary, DLL and tessdata file hash-checked before the first page |
| **Page-layout ("blocks") GGUF, as used by BookForge Detect** | Hugging Face · `owenmorgan/foundry-models` | `BLOCKS_MODELS` — `electron/blocks-models.ts` | **byte count only** — `downloadBlocksModel` in the same file. See Known gaps §9.1 |
| **Bundled Python env** (`e2a-env-<platform>.tar.gz`) | GitHub Releases · `telltaleatheist/bookforge` · tag `assets` | `ENV_VERSION` + per-platform `sha256` in `ENV_RELEASES` — `electron/e2a-env-bootstrap.ts` | `ensureTarballDownloaded` (hashes before *and* after download), then a ready-marker recording version + sha |
| **First-run runtime assets** (default voice, `stanza-en`, library voices) | GitHub Releases · `telltaleatheist/bookforge` · tag `assets` | per-asset `version` + `sha256` in `RUNTIME_ASSETS` — `electron/e2a-env-bootstrap.ts` | `doEnsureRuntimeAsset` in the same file |
| **RVC engine env** (`urvc-env-*`) | GitHub Releases · `telltaleatheist/bookforge` · tag `assets` | `RVC_ENV_VERSION` — `electron/components/rvc-env.ts` | `downloadAndExtract` (sha256 of the reassembled whole) |
| **F5-TTS env** | same | `F5_ENV_VERSION` — `electron/components/f5-env.ts` | same |
| **Resemble Enhance env** | same | `RESEMBLE_ENV_VERSION` — `electron/components/resemble-env.ts` | same |
| **WhisperX alignment env** | same | `WHISPERX_ENV_VERSION` — `electron/components/whisperx-env.ts` | same |
| **Voxtral env** | same | `VOXTRAL_ENV_VERSION` — `electron/components/voxtral-env.ts` | same (macOS only; the Windows artifact is an unpublished stub — see §5.4) |
| **DeepSpeed overlay** | same | `DEEPSPEED_VERSION` — `electron/components/deepspeed-xtts.ts` | **nothing** — `ARTIFACT_SHA256` is declared but never checked; see Known gaps §9.2 |
| **RVC base models + built-in RVC voices** | `rvc-base-models.tar.gz` on the `assets` release; the four voices on Hugging Face `owenmorgan/owen-morgan-bookforge` | per-asset `version`/`sha256` in `electron/data/rvc-voice-assets.json` | `ensureRvcVoice` / `ensureRvcAsset` — `electron/rvc-models.ts` |
| **llama.cpp CUDA pack** (`llama-…-cuda-12.4-x64.zip` + `cudart-…zip`) | GitHub Releases · `ggml-org/llama.cpp` tag `b7482`, mirrored on our `assets` tag | `LLAMA_CPP_VERSION` — `electron/components/llama-cuda.ts` | `BUILD_SHA256` / `CUDART_SHA256`, checked inside `downloadZipWithFallback` in the same file |
| **CUDA PyTorch wheels** (`cuda-tts`, `cuda-rvc`) | PyTorch CDN · `download.pytorch.org/whl/cu126` | `TORCH_VERSION` + `CU_TAG` — `electron/components/cuda-tts.ts`, `electron/components/cuda-rvc.ts` | **not checksum-verified** — see Known gaps §9.2 |
| **faster-whisper package** | PyPI (via `pip install`) | `FASTER_WHISPER_VERSION` — `electron/components/whisper-env.ts` | pip's own wheel verification; no BookForge-side hash |
| **Whisper STT weights** | Hugging Face · `Systran/faster-whisper-*` | `WHISPER_MODELS` — `electron/whisper-models.ts` (no hash field exists) | size/presence only, via `whisper_download.py` → `snapshot_download` |
| **XTTS voices + XTTS base** | Hugging Face · `drewThomasson/fineTunedTTSModels`, `coqui/XTTS-v2` | none — the live catalog is fetched, see §7 | `snapshot_download` in `bookforge_ext/download_model.py` (**e2a repo**); repo allow-list in `electron/components/catalog-service.ts` |
| **Stanza language packs** | Stanford stanza-resources (upstream), via `stanza.download()` | `resources_1.10.0.json`, named in `catalog.bundled.ts` | none beyond stanza's own |
| **Orpheus voices (ours)** | Hugging Face · `owenmorgan/<token>-orpheus-3b[-lora]` — **private** | `electron/data/orpheus-models.json` | none — `snapshot_download` with a token; see §8.3 |
| **Cogito GGUFs for local AI cleanup** | Hugging Face · `bartowski/*` | `COGITO_MODELS` — `electron/llama-bridge.ts` | **nothing** — see Known gaps §9.3 |
| **Starter library** (sample project) | GitHub Releases · `telltaleatheist/bookforge` · tag `assets` | `starter` block in the remote `manifest.json` | `downloadAndExtract` via `electron/update/starter-library.ts` |
| **Voice/language catalog** (`catalog.json`) | `raw.githubusercontent.com/telltaleatheist/bookforge/catalog-data/` | `SUPPORTED_SCHEMA` — `electron/components/catalog-service.ts` | schema + sanity floors + `REPO_ALLOWLIST` in that file |
| **Update manifest** (`manifest.json`) | same `catalog-data` branch | `schemaVersion: 2` — `electron/update/remote-manifest.ts` | schema check only |
| **MuPDF / llama.cpp CPU build** | mupdf.com / `ggml-org/llama.cpp` | `MUPDF_VERSION` (`scripts/download-mupdf.js`), `LLAMA_CPP_VERSION` (`scripts/download-llama-cpp.js`) | none — these are **build-time**, not runtime, downloads (§6) |

Three hosts, and the split between them is not arbitrary:

- **GitHub Releases** carries everything *we build* — CLI binaries, conda-pack
  environments, bundled asset tarballs. It is free, versioned by tag, and needs
  no credentials to read from a public repo.
- **Hugging Face** carries everything that is *model weights* — our fine-tunes
  and third-party checkpoints alike. It is built for large files, it is where the
  training tools already push, and its cache layout is what the Python engines
  expect to find on disk.
- **Upstream vendors** (mupdf.com, PyTorch's CDN, PyPI, Stanford) carry things we
  do not build and should not re-host.

---

## 2. Foundry CLI releases — the worked example

Foundry (`telltaleatheist/foundry`, public) is the standalone binary that does
scan segmentation, block labelling, OCR repair and footnote-marker removal.
BookForge drives it as a subprocess. v0.5.0 was cut on 2026-08-05 and is the
freshest example to copy.

### 2.1 Building: `tools/release-build.sh`

```bash
tools/release-build.sh            # every target a release ships
tools/release-build.sh host       # just this machine's
tools/release-build.sh darwin-arm64
```

The four targets are `darwin-arm64`, `darwin-x64`, `linux-x64`, `windows-x64`,
and `bun build --compile --target=<platform>` produces a single self-contained
executable per target. Cross-compiling downloads that platform's Bun runtime on
first use, so the first cross-build of a new target needs network.

Two details are load-bearing:

**The git commit is baked in.** The script passes
`--define FOUNDRY_GIT_COMMIT='"<short-sha>"'`, which `src/version.ts` reads
through a `declare const` and exposes as `GIT_COMMIT`. A dirty tree is allowed
(that is how you test a build) but is **marked** with a `+dirty` suffix, so a
binary reporting `a1b2c3d+dirty` can never be mistaken for the commit it was
nearly built from. This is the reason the build is a shell script and not four
lines of `package.json`: the define's value needs shell substitution wrapped in
the quoting that makes it a JS string literal, and spelling that four times in
JSON is how one of the four ends up subtly wrong and ships a binary that reports
the wrong commit.

**`host` is spelled out, never defaulted.** `release-build.sh` with *no*
arguments means "everything a release ships". If `host` were the default, running
the script in the wrong place would quietly produce one binary and you would
discover the missing three when a user on another platform could not install. The
`host` branch also maps MSYS/MinGW to the `windows` target — Git Bash reports
`MINGW64_NT-…`, and without that case `npm run build` simply refused to run on
Windows.

A target that fails is reported and the script exits non-zero. It is never
skipped quietly, because a missing binary in a release is a platform of users who
cannot install.

### 2.2 Packaging: `tools/release-package.sh`

```bash
tools/release-package.sh [dist-dir] [out-dir]    # defaults: dist, dist/release
```

For every binary present in `dist/`, it produces:

```
dist/release/foundry-<platform>-<arch>.tar.gz     one executable, named `foundry` (or `foundry.exe`)
dist/release/checksums.txt                        plain sha256sum format
```

The archive is built with `tar -C` from a staging dir, so it holds `foundry`, not
`dist/foundry-darwin-arm64` — an archive that unpacks a path is an archive that
unpacks somewhere surprising. `checksums.txt` is written in plain `sha256sum`
format (falling back to `shasum -a 256` on macOS) with the `./` prefix stripped,
so both `sha256sum -c checksums.txt` and a trivial parse work.

Only binaries that **actually exist** are packaged. A target that failed to build
is absent from the release and absent from `checksums.txt`, rather than present
as a stale copy of a previous build. A release asset that is quietly older than
its tag is worse than a missing one, because it installs.

### 2.3 The naming is a contract

`foundry-<platform>-<arch>.tar.gz` is read by a program, not just by a person.
`electron/components/foundry-cli-components.ts` builds every download URL as:

```ts
const RELEASE_BASE =
  `https://github.com/telltaleatheist/foundry/releases/download/v${FOUNDRY_CLI_VERSION}`;
// …
url: `${RELEASE_BASE}/${a.file}`,   // a.file === 'foundry-darwin-arm64.tar.gz', etc.
```

So the platform/arch pair in the filename and the version in the release tag
together *are* the address. Two consequences follow, and both are deliberate:

- **The version is not in the filename**, because it is in the tag the assets
  hang from. A name carrying both could disagree with itself.
- **Renaming an asset breaks installs on that platform only**, silently, until
  someone on that platform tries to install. The names in `release-package.sh`'s
  `pack` calls and the `file:` fields in `ASSETS` must be kept identical.

The executable inside is named `foundry` on POSIX and `foundry.exe` on Windows,
and the component's `entryPath` is computed to match by `entryName()` in
`foundry-cli-components.ts`.

### 2.4 Publishing

Push the code and the tag first — the release hangs off a tag that must exist,
and a release pointing at a tag nobody can fetch is not reproducible:

```bash
git push origin main
git push origin v0.5.0
gh release create v0.5.0 dist/release/*.tar.gz dist/release/checksums.txt \
  --repo telltaleatheist/foundry
```

Verify the upload landed before touching BookForge:

```bash
gh release view v0.5.0 --repo telltaleatheist/foundry \
  --json assets -q '.assets[] | "\(.name)\t\(.size)"'
```

For v0.5.0 that returns five assets: `checksums.txt` plus the four tarballs.

### 2.5 The consumption side

`electron/components/foundry-cli-components.ts` declares foundry as an ordinary
optional component so it rides the *same* ComponentService download/install/
verify/remove machinery as the conda envs, the voices and the model GGUFs, rather
than needing a bespoke downloader and a bespoke settings row.

```ts
export const FOUNDRY_CLI_VERSION = '0.5.0';
```

Below it, `ASSETS` lists one entry per platform with `file`, `sha256` and `bytes`.

**Hashes and byte counts are PASTED from the published `checksums.txt`, never
predicted.** The file header states the reason and it is worth restating: an
invented hash turns a clear failure — "this asset is not there" — into a checksum
mismatch, which reads as a corrupt transfer and sends the reader off to
investigate their network instead of the release they forgot to upload. The URLs
derive from the version constant, so they follow on their own; the hashes never
can.

What happens at install time:

1. `install()` (`electron/components/component-manager.ts`) resolves the artifact
   for this platform/arch, refuses stub artifacts (empty url, or `bytes: 0` with
   no `parts`), pre-checks compatibility and free disk (2.5× the artifact size),
   and creates a temp dir.
2. `downloadAndExtract` (`electron/components/downloader.ts`) fetches with
   redirect-following and progress, compares `sha256File(archive)` against the
   declared hash, and extracts with the OS tar (`osTarBin()` pins
   `%SystemRoot%\System32\tar.exe` on Windows, because a GNU tar earlier on PATH
   treats `C:\…` as a remote host and cannot read zips at all).
3. The tree is **moved into `<userData>/components/foundry-cli/` before**
   post-install and verification, not after. For conda envs this is essential
   (`conda-unpack` bakes the current path into every console-script launcher);
   for foundry it just means the binary is verified where it will live.
4. `chmodEntry` makes it executable on POSIX — `component.kind === 'foundry-cli'`
   takes the same post-extract branch as any other managed binary.
5. `runVerify` executes the `verify` spec: `foundry --version`, expecting the
   output to contain `foundry`. That proves both that the binary runs and that it
   *is* foundry rather than something else that happens to accept `--version`.
6. `putRecord` writes an `InstalledRecord` — including `version` — into
   `<userData>/components/installed.json`.

### 2.6 Resolution precedence, and the auto-upgrade

`electron/foundry-bridge.ts` owns this. Exactly two places are ever *searched* —
the env var and the component record — and deliberately no third: **PATH is never
searched**, because a `foundry` on PATH is an unknown build with an unknown prompt
format and an unknown Tesseract pin, and running it would make a book quietly
worse instead of failing. When neither place has one, `ensureFoundryPath`
downloads it rather than telling a user to go and find a binary.

**Precedence, as implemented in `ensureFoundryPath`:**

1. **`FOUNDRY_CLI_PATH`** (the env var named by `FOUNDRY_CLI_ENV_VAR`). If it is
   set and names a runnable file, it wins outright. If it is set and does *not*
   name a runnable file, that is an **error**, not an invitation to download one:
   the user said where their foundry is, and the useful answer is that it isn't
   there — not a silent second copy that makes their setting a lie.
2. **A path set on the `foundry-cli` component in Settings → Add-ons**, recorded
   as an `external` install. Honored at whatever version it is; a configured
   foundry is never downloaded over.
3. **The managed download.** If nothing is configured, `ensureFoundryPath`
   fetches through `componentManager.install()` rather than refusing to start.

`resolveFoundryPath()` and `requireFoundryPath()` are the synchronous
counterparts: they answer "is there one here" without awaiting a ~38 MB transfer,
which is a question a spawn site has to be able to ask. A pass that is about to
need foundry awaits `ensureFoundryPath` *first*, so by the time `runFoundry` asks
the sync question the answer is yes.

**The upgrade path** lives in the same function. When an entry resolves,
`ensureFoundryPath` reads the installed record and:

```ts
if (record?.source !== 'managed' || record.version === FOUNDRY_CLI_VERSION) {
  return entry;
}
```

— i.e. an *external* install is returned unchanged at any version, and a
*managed* install whose recorded version differs from `FOUNDRY_CLI_VERSION` is
replaced on the next pass that needs foundry. BookForge put the managed copy
there, so BookForge keeps it at the version the catalog names. Without this
check, a version bump would reach only fresh machines while every machine that
already installed kept answering with the old binary forever — which is the
documented uninstall-and-reinstall limitation the conda-env components live with
(see the comment block at the top of `electron/components/rvc-env.ts`). That is
livable for a 2 GiB env and wrong for a 38 MB CLI the app versions in lockstep
with its own document-stage contract.

Concurrency is handled in `foundry-bridge.ts`, not in the component manager:
`componentManager.install()` does not serialize, so two queued foundry passes
starting at once would race two extractions into the same directory. The module
keeps one shared install promise and every other caller joins it.

### 2.7 Version-bump checklist

Follow in order. The one ordering that is not negotiable is that the release
exists and is verified (steps 7–8) **before** any hash is pasted (steps 9–11) —
the hashes are read out of the published artifact, so there is nothing to read
until it is published.

1. **Bump `package.json`** in the foundry repo. That file is the one authority —
   `src/version.ts` does `import pkg from '../package.json'` and the bundler
   inlines the literal. (It used to be a second hand-bumped constant, and v0.2.0
   and v0.2.1 both shipped binaries introducing themselves as `foundry 0.1.0`.)
2. **Commit** the bump.
3. **Tag** it: `git tag v<x.y.z>`.
4. **Build all targets**: `npm run build:all` (`tools/release-build.sh` with no
   arguments). Confirm four binaries in `dist/`.
5. **Package**: `npm run release:package` (`tools/release-package.sh`). Confirm
   four tarballs plus `checksums.txt` in `dist/release/`.
6. **Push** `main` and the tag: `git push origin main && git push origin v<x.y.z>`.
7. **Create the release**:
   `gh release create v<x.y.z> dist/release/*.tar.gz dist/release/checksums.txt --repo telltaleatheist/foundry`
8. **Verify the assets uploaded** —
   `gh release view v<x.y.z> --repo telltaleatheist/foundry --json assets`. Five
   assets, sizes non-zero.
9. **Download the published `checksums.txt`** (not the local one) and read the
   hashes out of it, e.g.
   `gh release download v<x.y.z> --repo telltaleatheist/foundry --pattern checksums.txt -O -`.
   Byte counts come from the release's asset `size` fields in step 8.
10. **Paste hashes AND byte counts** into `ASSETS` in
    `electron/components/foundry-cli-components.ts` (BookForge repo).
11. **Bump `FOUNDRY_CLI_VERSION`** in the same file.
12. **Typecheck**: `npx tsc -p tsconfig.electron.json` — the same compile the
    repo's own `test:*` scripts run before their harness.
13. **Commit** the BookForge-side change.

### 2.8 Foundry's own downloads

Foundry is itself a downloader, and its artifacts are separate from the CLI
binary. This matters because BookForge and foundry share one copy on disk.

**Stage models** — `src/models/catalog.ts` declares one base
(`foundry:4b`, `foundry-4b-f16.gguf`, 8,051,285,600 bytes) and three stage models
(`foundry-ocr-v1-4b`, `foundry-footnotes-v1-4b` — LoRA adapters at ~132 MB each;
`foundry-blocks-v1-4b` — a *fused* full checkpoint at ~8 GB, declared
`kind: 'full'` for that reason). All four live at
`https://huggingface.co/owenmorgan/foundry-models/resolve/main/…`, each with an
sha256 and byte count, verified on arrival by `downloadVerified`
(`src/models/download.ts`). Two standing rules in that file are worth carrying
anywhere else a catalog like this is written: **entries are never deleted once
published** (someone is mid-book with those weights on disk), and **`rank` picks
the default** among the models actually present, so a new version becomes the
default without anything being uninstalled first.

**The vendored Tesseract** — foundry pins an exact Tesseract *and* exact
tessdata, because Tesseract is the segmenter its models were trained against;
picking up whatever is on PATH silently shifts the input distribution and every
symptom then points at the models. The pin lives in
`vendor/tesseract/manifest.json` (committed) and is compiled into the binary; the
files are downloaded by `foundry models pull` from the **`assets`** release tag on
`telltaleatheist/foundry`. To record and publish a platform, in this order:

```bash
tools/scan-vendor-tesseract.sh [path/to/tesseract] [lang ...]
tar -czf tesseract-<version>-<platform>.tar.gz -C vendor/tesseract/<platform> .
gh release upload assets tesseract-<version>-<platform>.tar.gz --clobber
node tools/record-vendor-artifact.mjs <platform> <url>
```

`record-vendor-artifact.mjs` **downloads the URL and hashes what arrives** — it
never reads the tarball you just built. A hash taken from the local file asserts
things nobody checked: that the upload finished, that it landed on the tag you
meant, that nothing rewrote it. Same rule as §2.5: upload, verify the uploaded
bytes, *then* record. Today only `win32-x64` has a published artifact; the
darwin-arm64 pin is explicitly `"portable": false` (a Homebrew launcher whose
dylibs are not beside it) and linux-x64 is unrecorded. `vendor/tesseract/README.md`
documents both honestly and says what a real bundle would need.

**One copy on disk.** `getBlocksModelsDir()` in `electron/blocks-models.ts`
resolves to *foundry's* platform data dir —
`~/Library/Application Support/foundry/models` on macOS,
`%LOCALAPPDATA%\foundry\models` on Windows, `$XDG_DATA_HOME/foundry/models`
otherwise. `foundry models pull` and BookForge's Settings → Add-ons fetch the same
8 GB file into the same directory, so there is never a second copy. That is why
the file is named for the foundry stage rather than for the app asking.

---

## 3. The BookForge `assets` release

Everything BookForge builds and hosts itself lives on a **single, stable,
non-versioned release tag** — `assets` on `telltaleatheist/bookforge`:

```
https://github.com/telltaleatheist/bookforge/releases/download/assets/<filename>
```

The tag never moves; the *filenames* and the version constants in TypeScript do
the versioning. That is a deliberate trade: a per-version tag would mean creating
a release for every env repack, and the envs are versioned independently of each
other and of the app. The cost is that `--clobber` overwrites in place, so a
mistaken upload is not recoverable from the tag alone.

As of 2026-08-04 the tag carries 23 assets: five conda-pack envs (some split into
parts — §4), the two e2a Python envs, three first-run runtime assets, the RVC base
models, the DeepSpeed overlay, the llama.cpp CUDA mirror pair, and the starter
library.

### 3.1 Publishing a new env or asset

The recipe, verbatim from `packaging/env/MAC-TTS-ENVS.md` §4:

```bash
gh release upload assets <file>.tar.gz --clobber --repo telltaleatheist/bookforge
shasum -a 256 <file>.tar.gz      # sha256 for the component (or sha256sum on Linux/Git Bash)
stat -f%z   <file>.tar.gz        # bytes for the component (stat -c%s on Linux)
```

> These artifacts are referenced **directly in TypeScript** (url + sha256 +
> bytes). They do *not* go through `packaging/publish-release.js --component`,
> which is the separate manifest-driven tier described in §7.

Then paste the sha256 and byte count into the component file and bump its version
constant. Same rule as foundry: hashes are pasted from the uploaded artifact,
never predicted.

Before packing a conda env: extract the tarball to a scratch dir, run
`conda-unpack`, and confirm the relocated `bin/python -c "import <module>"` still
works. That is exactly what the user's machine will do, and it is the only way to
catch a prefix-rewrite failure before it is a download.

You cannot cross-build these. Mac tarballs are packed on the Mac, Windows on the
PC — which is why `packaging/env/MAC-TTS-ENVS.md` exists at all.

### 3.2 The e2a Python environment

`electron/e2a-env-bootstrap.ts` is a separate, older mechanism from the component
system — it predates it and bootstraps the environment *everything else* runs in,
so it cannot depend on components being installed.

```ts
const ENV_VERSION = '2026.06.16';

const ENV_RELEASES: Record<string, EnvRelease> = {
  'win32-x64':    { url: '…/e2a-env-windows-x64.tar.gz', sha256: 'ece7471e…', bytes: 1842123032 },
  'darwin-arm64': { url: '…/e2a-env-macos-arm64.tar.gz', sha256: '1bbc63bf…', bytes: 1728116297 },
};
```

Readiness is keyed on **both** `ENV_VERSION` and the artifact sha256, recorded
together in a ready-marker inside the unpacked env. The split of responsibility is
the useful part: a new tarball's sha alone refreshes exactly the platforms whose
artifact changed, while `ENV_VERSION` is global to all platforms and should be
bumped only for a semantic change that must force every platform to rebuild even
with unchanged tarballs — an unpack-layout or marker-format change. A platform
with no entry in `ENV_RELEASES` has no managed env, and callers fall back to
conda-based resolution.

On first run the tarball is downloaded to a cache under `userData`, verified,
extracted to `<userData>/runtime/e2a-env`, and `conda-unpack` is run to rewrite
the prefixes baked in at pack time. The cached tarball survives retries and is
deleted once a build succeeds, to reclaim its ~1.8 GB. From then on every e2a
spawn invokes the env's python directly — there is no conda on the target machine.

`BOOKFORGE_E2A_ENV` overrides the whole thing with an already-unpacked env, for
dev builds exercising the relocatable code path without packaging. Set but
invalid throws: a configured override must not be silently ignored.

Three further assets ride the same bootstrap as `RUNTIME_ASSETS` — the default
Scarlett Johansson voice (1.74 GB), the English Stanza pack (197 MB) and the
voice-library reference clips (43 MB). Each carries its own `version` and
`sha256`, each gets a per-asset ready-marker inside the e2a runtime dir, and each
is platform-independent (model weights, JSON and audio), so one archive serves
Windows and macOS. Bump an asset's `version` *with* a new archive to force a
re-download.

---

## 4. The split-asset mechanism

**Why it exists.** GitHub Releases caps a single asset at 2 GiB. Three of our
Windows conda envs exceed it after their CUDA payload was added: `urvc-env`
(4.16 GB), `f5-env` (3.48 GB), `resemble-env` (3.47 GB). Splitting is the only
way to keep them on the same host as everything else.

**How it is declared.** `ComponentArtifact` in
`electron/components/component-types.ts` carries an optional `parts?: string[]`:

```ts
/** Ordered part URLs for a SPLIT artifact. When present, the downloader fetches
 *  each part and concatenates them (in this order) into the archive before
 *  verify + extract. … `sha256`/`bytes` describe the REASSEMBLED whole, not any
 *  single part. */
parts?: string[];
```

When `parts` is set, `url` is **not fetched**. It survives only as the canonical
archive *name*, which `downloadAndExtract` uses to derive the temp filename and to
sniff the archive type for extraction.

**How it is reassembled.** `downloadParts` in `electron/components/downloader.ts`:

- Unlinks any existing archive first, so a retry cannot append onto stale bytes.
- Fetches each part in order to `<archive>.part<i>`, appends it to the growing
  archive with a stream, then deletes the part. Peak extra disk is therefore
  **one part**, not the whole set.
- Reports progress as an aggregate against `artifact.bytes` — the reassembled
  size — so the bar tracks the real total rather than restarting per part.

**How it is verified.** Exactly as an unsplit artifact: `downloadAndExtract`
hashes the reassembled file and compares it to `artifact.sha256`. No individual
part is hashed, and none needs to be — a bad part produces a bad whole, and the
error names both hashes.

**Naming.** The published parts use a zero-padded `.part00`, `.part01`, … suffix
appended to the full archive name, e.g.
`urvc-env-windows-x64.tar.gz.part00`. All parts observed on the `assets` release
are exactly **1,992,294,400 bytes** (1900 MiB) except the last. The reassembly is
plain byte concatenation, so any byte-exact splitter produces a valid set — but
see Known gaps §9.4: **no script in this repo produces the parts**, so the exact
split command used is not recorded anywhere.

Current users of `parts[]`:

| Component | Platform | Parts | Reassembled bytes |
|---|---|---|---|
| `rvc-env` (`electron/components/rvc-env.ts`) | win32-x64 | 3 | 4,158,992,878 |
| `f5-env` (`electron/components/f5-env.ts`) | win32-x64 | 2 | 3,476,487,943 |
| `resemble-env` (`electron/components/resemble-env.ts`) | win32-x64 | 2 | 3,474,943,074 |

All three declared byte counts match the sum of the published part sizes.

---

## 5. Everything else BookForge downloads

### 5.1 The component system, in one paragraph

`electron/components/component-manager.ts` owns
`<userData>/components/installed.json` and one directory per managed component at
`<userData>/components/<id>/`. `install(id)` dispatches in two passes: first on
`component.kind` (`tts-model`, `language-pack`, `rvc-model`, `stt-model`,
`blocks-model` each get their own `fetch*` function, because they land somewhere
other than `components/<id>/`), then on `component.id` for the four overlays
(`cuda-tts`, `cuda-rvc`, `deepspeed-xtts`, `whisper`, which install *into* another
env). Everything that falls through — `binary`, `conda-env`, `foundry-cli` — takes
the generic `downloadAndExtract` path. All of them honor the same
`InstallProgress` contract, so the UI never has to know which is which.
`resolveEntry(id)` is the single seam every consumer uses to get an absolute path
for an installed-and-verified component instead of guessing.

### 5.2 Conda-pack environments

`f5-env`, `rvc-env`, `resemble-env`, `voxtral-env`, `whisperx-env` are all
`kind: 'conda-env'` with `condaUnpack: true`. After extraction the manager runs
the env's own `conda-unpack` **in the final directory**, never in the temp dir.
This ordering is load-bearing and was learned the hard way: `conda-unpack`
rewrites every absolute prefix in the env — including the shebang or launcher of
every console-script entry point — to wherever the env *currently* sits. Unpacking
in a temp dir and then moving baked the temp path into every entry point, so
`urvc.exe` exited 1 with no output on Windows and `bin/urvc` reported a bad
interpreter on POSIX, while `python.exe` and `python -m <pkg>` kept working
(Python resolves `sys.prefix` from the interpreter's own location) — which is why
most of the env worked and only console scripts failed.

Verification for these is `kind: 'python-import'`: the manager runs the env's own
python and imports the module (or several, via `modules[]`, when one top-level
import is too shallow to catch a broken sub-path).

**Weights are never packed into an env tarball.** Every engine pulls its
checkpoints from Hugging Face at runtime — F5's MLX weights, Voxtral's 4-bit MLX
model, WhisperX's wav2vec2 aligner. The env carries code and dependencies only.
That is what keeps a 3.5 GB tarball from being an 11 GB one.

### 5.3 Overlays: CUDA torch, DeepSpeed, faster-whisper

Four components are not archives that become a directory; they install *into* an
env that already exists, and each is dispatched by id rather than by kind:

- **`cuda-tts` / `cuda-rvc`** download CUDA PyTorch + torchaudio wheels from
  `https://download.pytorch.org/whl/cu126` (pinned `TORCH_VERSION = '2.7.1'`,
  `CU_TAG = 'cu126'`) and pip-install them over the e2a env and the rvc-env
  respectively.
- **`deepspeed-xtts`** downloads `deepspeed-xtts-windows-x64.tar.gz` from our
  `assets` tag (`DEEPSPEED_VERSION = '0.19.2'`) — DeepSpeed plus a prebuilt,
  multi-arch `transformer_inference` kernel (sm_75…9.0 + PTX), dropped into the
  runtime env's `site-packages`. Its own file explains why it is an overlay
  rather than being baked into the e2a env tarball: the env is large and is
  re-downloaded on update, so shipping DeepSpeed separately keeps that download
  small and lets only CUDA users fetch it. win32-only.
- **`whisper`** has no artifact at all: `fetchWhisperEnv` runs
  `pip install --no-deps faster-whisper==1.1.1 av` inside the runtime env.
  `FASTER_WHISPER_VERSION` is the pin; PyPI is the host.

### 5.4 Stub artifacts, and why they are not 404s

Several artifacts are declared but not published: the whole `orpheus` component
(all three platforms have `url: ''`), and `voxtral-env`'s win32 entry
(`sha256: ''`, `bytes: 0`). `install()` treats these as *unpublished* and says so,
without attempting a fetch:

```ts
const unpublished = !artifact.url || artifact.url.trim() === '' || (!hasParts && artifact.bytes === 0);
```

The second clause matters: a real URL whose asset is not built yet would otherwise
404 mid-download and read as a broken install rather than a not-published-yet
engine. The user is told to install it themselves and pointed at
`externalHelpUrl`.

A related rule in `downloadAndExtract`: an empty `sha256` **skips verification
with a logged warning** rather than failing. That is a deliberate escape hatch for
pre-hosting stubs and user-supplied RVC voices, and it is why an empty hash should
never be left in a published entry.

### 5.5 The llama.cpp CUDA pack

`electron/components/llama-cuda.ts` is the one component that substitutes its own
fetch (`downloadLlamaCudaInto`) *inside* the generic install path — everything
else about it, including the move-then-verify sequence, is the standard flow. It
needs the substitution because it fetches *two* zips and flattens them into one
install:
the llama.cpp Windows CUDA build and the matching CUDA runtime. Both are tried
**upstream first** (`https://github.com/ggml-org/llama.cpp/releases/download/b7482`)
and fall back to our byte-identical mirror on the `assets` tag — upstream so we
are not the bandwidth, the mirror so a deleted upstream release does not break
installs. Both are sha256-checked against `BUILD_SHA256` / `CUDART_SHA256` inside
that function.

`LLAMA_CPP_VERSION = 'b7482'` here must stay in sync with the identically-named
constant in `scripts/download-llama-cpp.js` — the optional GPU pack must come from
the same release as the bundled CPU build, or the DLL set will not match.

---

## 6. Build-time downloads: MuPDF and llama.cpp

These are *not* runtime downloads. They run on the build machine and stage
binaries into `resources/bin/`, which electron-builder then ships via
`extraResources`.

```json
"download:mupdf": "node scripts/download-mupdf.js",
"download:llama": "node scripts/download-llama-cpp.js",
"postinstall": "npm run download:mupdf || echo 'MuPDF download skipped (run npm run download:mupdf manually if needed)'"
```

- **`scripts/download-mupdf.js`** — `MUPDF_VERSION = '1.27.0'`. On Windows it
  downloads the prebuilt zip from `mupdf.com/downloads/archive/`; on macOS it
  downloads the source tarball and compiles (Xcode command-line tools required).
  It is wired to `postinstall` with a `|| echo` so a failed or offline
  `npm install` still completes — the message tells you to run it by hand.
- **`scripts/download-llama-cpp.js`** — `LLAMA_CPP_VERSION = 'b7482'`. Downloads
  the official prebuilt `llama-server` for the *host* platform from
  `github.com/ggml-org/llama.cpp/releases`, plus its runtime libraries. On macOS
  it rewrites the binary's `@rpath/<lib>` load commands to
  `@loader_path/<lib>` and ad-hoc codesigns, because a modified Mach-O will not
  otherwise run. Windows gets the small CPU-only build (~20 MB) so the installer
  stays under the single-file size cap and runs on every machine; the ~570 MB CUDA
  build is the download-on-demand component in §5.5.

Both are invoked by the packaging scripts before staging — e.g. `package:win` is
`npm run download:mupdf && npm run download:llama && npm run stage:packaging:seed && npm run electron:build -- --win`.

Because BookForge builds on the target platform (`package:mac` on a Mac,
`package:win` on Windows), both scripts key off `process.platform`/`process.arch`
rather than taking a target argument.

---

## 7. The catalog and manifest tier

Two JSON files are served from the `catalog-data` branch of
`telltaleatheist/bookforge` over `raw.githubusercontent.com`. They are *indexes*,
not hosting — no model bytes come from here.

**`catalog.json`** — the list of downloadable XTTS voices and Stanza language
packs. `electron/components/catalog-service.ts` resolves it in three tiers:
`BUNDLED_CATALOG` (embedded at build time, the permanent offline floor) → a
`userData` cache of the last good fetch → a live fetch that swaps in on success.
A failed or invalid refresh leaves the current catalog in place; no degraded or
empty list is ever used. Two guards matter:

- **Sanity floors.** `MIN_VOICES = 20`, `MIN_LANGUAGES = 60`. A smaller catalog
  means a broken upstream and is refused.
- **`REPO_ALLOWLIST`.** Voice entries whose `repo` is not
  `drewThomasson/fineTunedTTSModels` or `coqui/XTTS-v2` are dropped at load time.
  This is a tamper boundary: a compromised catalog cannot point downloads at an
  arbitrary Hugging Face repo.

The catalog is regenerated by `tools/catalog-indexer/build_catalog.py`, run as the
`catalog-indexer` GitHub Action (daily, or on demand). It reads the same upstream
sources the app downloads from, verifies each entry (a voice folder must contain
`config.json` + `model.pth` + `vocab.json`; a language must have a `tokenize`
model), applies `tools/catalog-indexer/curation.json`, and commits
`catalog.json` + `manifest.json` to `catalog-data`.

**`manifest.json`** — schema v2, fetched by `electron/update/remote-manifest.ts`,
consumed by two things:

- `electron/update/component-updater.ts` — the *watched managed binary* tier
  (ffmpeg, yt-dlp, …), installed to `<userData>/managed-bins/<id>/`. Here, and
  only here, a differing sha256 counts as an update even when the version string
  is unchanged, so replacing a binary on the server surfaces as an available
  update. **This list is currently empty** (`manifest.components == []`), so no
  component uses this path today.
- `electron/update/starter-library.ts` — the one-time sample project, seeded only
  into a library with no projects.

`packaging/publish-release.js` is the tool that writes
`tools/catalog-indexer/releases.json` (the indexer's input) and prints the `gh`
upload and workflow-dispatch commands:

```bash
node packaging/publish-release.js --component <id> --comp-version <X> \
     --comp-file <archive> --platform <darwin-arm64> [--publish]
node packaging/publish-release.js --starter [--publish]
```

It is **dry-run by default** — it writes `releases.json` locally and prints the
plan, and only `--publish` actually runs the `gh` upload. Its own header states
the boundary that keeps the two tiers apart: it is *not* for Hugging Face models,
and (per `MAC-TTS-ENVS.md`) not for the env tarballs either, which are referenced
directly in TypeScript.

---

## 8. Hugging Face

### 8.1 What of ours lives there

Everything is under the **`owenmorgan`** user account (verified against the HF API
on 2026-08-04 with the local token). Thirteen model repos, four of them public —
ten rows below, because three rows cover a merged/adapter pair:

| Repo | Public? | Contents | Consumed by |
|---|---|---|---|
| `owenmorgan/foundry-models` | **public** | `foundry-4b-f16.gguf`, `foundry-blocks-v1-4b.gguf`, `foundry-ocr-v1-4b.gguf`, `foundry-footnotes-v1-4b.gguf` | foundry `src/models/catalog.ts`; BookForge `electron/blocks-models.ts` |
| `owenmorgan/owen-morgan-bookforge` | **public** | `xtts/` (config, model.pth, vocab, reference wav) and `rvc/*.tar.gz` (4 voices) | `electron/components/voice-components.ts`; `electron/data/rvc-voice-assets.json` |
| `owenmorgan/bookforge-rubric` | public | superseded by `foundry-models` | nothing in current code |
| `owenmorgan/bookforge-dagger` | public | superseded by `foundry-models` | nothing in current code |
| `owenmorgan/owen-morgan-orpheus-3b` | **private** | merged Orpheus fine-tune | `electron/data/orpheus-models.json` (`owen`) |
| `owenmorgan/ender-orpheus-3b` | **private** | merged Orpheus fine-tune | same (`ender`) |
| `owenmorgan/mistborn-orpheus-3b` + `…-lora` | **private** | merged + LoRA adapter | same (`mistborn`, serves the `-lora`) |
| `owenmorgan/thirdreich-orpheus-3b` + `…-lora` | **private** | merged + LoRA adapter | same (`thirdreich`) |
| `owenmorgan/deathstalker-orpheus-3b` + `…-lora` | **private** | merged + LoRA adapter | same (`deathstalker`) |
| `owenmorgan/headline-14b-titles` | **private** | the HEADLINE title model | not consumed by BookForge |

The Orpheus adapter voices share one base, `unsloth/orpheus-3b-0.1-ft` — that is
the point of the adapter layout: a ~0.4 GB LoRA per voice on top of one resident
base instead of a 6.6 GB merged copy each. `electron/data/orpheus-models.json` is
the repo-tracked, machine-independent tuning catalog and declares, per voice,
whether the adapter or the merged copy is served.

Third-party repos BookForge or e2a pull from: `coqui/XTTS-v2`,
`drewThomasson/fineTunedTTSModels` (~40 voices), `Systran/faster-whisper-*`,
`bartowski/*` (Cogito GGUFs), `hubertsiuzdak/snac_24khz` (Orpheus codec),
`unsloth/orpheus-3b-0.1-ft`, `drewThomasson/segmentation`.

### 8.2 Who does the pulling

**BookForge's TypeScript never fetches model bytes from Hugging Face.** There is
no `@huggingface/hub` dependency. Every weight download is a spawned Python
process, and the Python that actually calls `huggingface_hub` is:

| Path | Script | Lives in |
|---|---|---|
| XTTS voices + XTTS base (`kind: 'tts-model'`) | `python -m bookforge_ext.download_model`, spawned by `fetchTtsModel` (`electron/components/component-manager.ts`) | **the e2a repo**: `C:\Users\tellt\Projects\ebook2audiobook\bookforge_ext\download_model.py` |
| Stanza language packs | same module, different branch, spawned by `fetchLanguagePack` | same |
| Whisper STT models | `electron/scripts/whisper_download.py`, spawned by `runWhisperModelDownload` (`electron/whisper-models.ts`) | this repo (runs inside the e2a env) |
| Orpheus voices | `electron/scripts/orpheus_download.py`, spawned by `runDownload` (`electron/orpheus-hf-catalog.ts`) | this repo |
| Engine-time cache misses (SNAC, F5, Bark, XTTS) | `hf_hub_download` / `from_pretrained` inside the engines | the e2a repo, `lib/classes/tts_engines/*` |

The exceptions are metadata, not weights: `orpheus-hf-catalog.ts` does plain Node
`fetch()` against `https://huggingface.co/<repo>/raw/<branch>/README.md` and
`https://huggingface.co/api/models/<repo>` to read a voice's model card. That card
is the *only* place BookForge reads Orpheus voice metadata from.

Two non-HF wrinkles worth knowing. The blocks GGUF is a plain HTTPS `downloadFile`
in Node (`electron/blocks-models.ts`) — a single GGUF needs no Python at all, and
Detect should not fail because a TTS env is missing. And `download_model.py`
carries a `MIRROR_BASE` fallback pointing at `https://owenmorgan.com/bookforge`,
used only after upstream HF fails; that host now returns HTTP 403 (see Known gaps
§9.5).

### 8.3 Authentication

One resolver, `getHfToken()` in `electron/orpheus-hf-catalog.ts`, reused by
`electron/whisper-models.ts`. Order:

1. `getConfig().huggingFaceToken` — the Settings → Tools field
   (`huggingFaceToken` in `electron/tool-paths.ts`).
2. `process.env.HF_TOKEN`, then `process.env.HUGGING_FACE_HUB_TOKEN`.
3. `~/.config/bookforge/hf-owenmorgan.token`.
4. `~/.cache/huggingface/token` — the canonical location; this is where
   `huggingface-cli login` puts it. (There is also a copy at
   `Downloads\bookforge-hf-token.txt`; verified byte-identical to the canonical
   file on this machine.)

The token is passed to the child process **as the `HF_TOKEN` environment
variable, never as a CLI argument**, so it cannot appear in a process listing —
stated explicitly at the top of `electron/scripts/orpheus_download.py` and
implemented at the spawn sites in `orpheus-hf-catalog.ts` and `whisper-models.ts`.

Which pulls are authenticated:

- **Orpheus voices** — yes, and this is the reason the resolver exists. The five
  voice repos are private, and the model-card fetch reads each repo's `private`
  flag precisely because some are.
- **Whisper models** — the token is forwarded, though the `Systran/*` repos are
  public and resolve without one.
- **XTTS voices, XTTS base, Stanza** — effectively anonymous.
  `bookforge_ext/download_model.py` neither reads `HF_TOKEN` nor passes a `token=`
  kwarg to `snapshot_download`; it relies on `huggingface_hub`'s own ambient
  pickup. All repos on that path are public, and the catalog allow-list keeps them
  that way.

The token on this machine is a **fine-grained** token scoped to two entities:
write access to the `owenmorgan` namespace, and read+write on
`canopylabs/orpheus-3b-0.1-ft`. It is not a classic all-repos token, so a scope
that was never granted will read as a 401 on an unrelated repo rather than as a
missing token.

### 8.4 Publishing to Hugging Face

**A stage model (blocks / ocr / footnotes GGUF).** `tools/aligner/blocks-publish.sh`
is the whole procedure, and it runs on the Mac where llama.cpp and the token live:

```bash
./blocks-publish.sh <release-tag> <prompt-version> <merged-dir-or-f16-gguf> [quant]
./blocks-publish.sh v2-4b 6 ~/blocks-export/blocks-v6-4b-merged
```

It converts to f16 GGUF, quantizes, **loads the result on the same bundled
llama-server that will serve it** (so a bad quantize is caught before a 2.5 GB
upload and somebody's 2.5 GB download), uploads with
`HF_TOKEN=… hf upload owenmorgan/foundry-models <file> <basename> --repo-type model`,
and then **prints** the catalog entries to paste into foundry's
`src/models/catalog.ts` and BookForge's `electron/blocks-models.ts`.

**That last step is manual on purpose.** The sha256 and byte count in those
catalogs are what make a download verifiable, and a script that edited them itself
could quietly republish a model nobody had evaluated. Pasting them is a moment to
notice.

Three things the script is careful about, all learned:

- **The release tag and the prompt version are different numbers**, and both are
  arguments rather than inferred from a filename. `foundry-blocks-v1-4b` is
  release 1 of the blocks stage carrying the *v5* prompt. Inferring one from the
  other eventually serves a model a class list it was trained never to emit —
  which does not error, it just scores worse and reads as an undertrained model.
- **The quant is a measured decision, not a default.** `Q4_K_M` is the script's
  default and was chosen when it looked free; on v4, scored on the same held-out
  split, it gave up 9.2 points of page-exact-match against `Q8_0` — more than the
  entire v3→v4 model improvement, thrown away at packaging. Re-measure per
  release.
- **It quantizes with the same llama.cpp build the app bundles**, read out of
  `scripts/download-llama-cpp.js`, because a GGUF written by a newer converter can
  use tensor types the shipped `llama-server` does not know.

**An Orpheus voice.** `docs/CUSTOM_VOICE_DEPLOY.md` is the checklist. Repo naming
is `owenmorgan/<token>-orpheus-3b`; the repo must hold the merged 16-bit HF
checkpoint (`config.json` + `*.safetensors` + tokenizer files — no MLX conversion,
MLX loads HF safetensors directly); and the `README.md` **must** carry YAML
frontmatter with `tags: [bookforge-orpheus-voice]`, `orpheus_token`, `label` and
`sample_rate`, because that card is the only place BookForge reads voice metadata
from. For a replacement, push new weights to the same repo — no app-side change.
For a new voice, pick a new repo name and a unique `orpheus_token`.

**Note the honest gap:** neither repo contains the script that performs an Orpheus
upload. `docs/CUSTOM_VOICE_DEPLOY.md` documents only the pull side, and
`ORPHEUS_ADAPTER_MIGRATION.md` points at `deploy_voice.sh` / `upload_to_hf.py` in
a third repo (`orpheus-finetune`) that is outside both trees. The push itself is
done by hand or by that external tooling.

**An XTTS voice or an RVC voice.** No script exists in this repo for either. The
four RVC voices are ordinary tarballs in `owenmorgan/owen-morgan-bookforge`
recorded by hand in `electron/data/rvc-voice-assets.json` with a url, sha256,
bytes and a date-stamped `version`.

---

## 9. Known gaps

Found while writing this. **Nothing here was changed** — this section is the
record, not a to-do that was actioned.

**9.1 — The blocks GGUF is not hash-verified when BookForge downloads it.**
`electron/blocks-models.ts` (in `downloadBlocksModel`) checks the downloaded size
against `def.bytes` and comments:

```ts
// Size is the cheap integrity check; the sha256 in the catalog is checked
// by the component path, which has a verify phase to report it in.
```

That is not true of the current code. The component path is `fetchBlocksModel`
(`electron/components/component-manager.ts`), which calls `downloadBlocksModel`
and then writes the record — it never calls `sha256File` and never emits a
`verify` phase. So the 8 GB `sha256` in `BLOCKS_MODELS` is presently decorative on
the BookForge side. Foundry's own `downloadVerified` (`src/models/download.ts`)
*does* hash the same file, so the identical artifact is verified when
`foundry models pull` fetches it and unverified when Settings → Add-ons does.

**9.2 — Every overlay component downloads without an integrity check.** The four
components that install *into* an existing env all bypass `downloadAndExtract`
and therefore its verify phase, and none of them hashes anything itself — a grep
for `sha256File|createHash` returns zero hits in `cuda-tts.ts`, `cuda-rvc.ts`,
`deepspeed-xtts.ts` and `whisper-env.ts`.

- `cuda-tts` and `cuda-rvc` declare `sha256: ''` on their artifact, so even the
  generic path would have skipped it — a 2.7 GB PyTorch wheel each, unverified.
- `deepspeed-xtts` is the sharper case: it *declares* a real
  `ARTIFACT_SHA256 = 'd054d72c…'` and puts it on the artifact, but
  `installDeepspeedXtts` fetches with `downloadFile` and untars directly, so the
  constant is never compared against anything.
- `llama-cuda` is not an overlay but is worth naming alongside them: its catalog
  artifact is also `sha256: ''`, though its real fetch path
  (`downloadZipWithFallback`) *does* verify against `BUILD_SHA256` /
  `CUDART_SHA256`, so only the declared entry is empty and the bytes are checked.

`downloadAndExtract` itself behaves correctly here — it logs a warning and
continues on an empty hash, which is the intended escape hatch for pre-hosting
stubs and user-supplied RVC voices. The genuinely-unpublished stubs (`orpheus` on
all platforms, `voxtral-env` win32) are a different case again and are handled by
the `unpublished` check.

**9.3 — The Cogito GGUFs are downloaded with no integrity check at all.**
`electron/llama-bridge.ts` declares four models (2.2–19.9 GB) with `url` and
`sizeGB` but no hash field; a grep for `sha256|createHash|checksum` in that file
returns nothing. A truncated or substituted 20 GB download would surface as a
llama-server load error.

**9.4 — Nothing in this repo produces the split parts.** Three components consume
`parts[]`, and every non-final published part is exactly 1,992,294,400 bytes, but
no script, doc or comment records the command that splits an archive. The reassembly
is plain concatenation so any byte-exact splitter works — but the chunk size and
the zero-padded `.partNN` naming are conventions currently held only by the
already-published files.

**9.5 — The e2a download mirror is unreachable.**
`bookforge_ext/download_model.py` (e2a repo) defines
`MIRROR_BASE = "https://owenmorgan.com/bookforge"` as the fallback when
HuggingFace is unreachable for XTTS voices and Stanza packs. As of 2026-08-04 that
URL returns **HTTP 403**. The fallback therefore converts an upstream outage into
a second failure rather than a recovery. (This is consistent with the site having
been retired in favour of the `catalog-data` branch; the code was not updated.)

**9.6 — `packaging/env/MAC-TTS-ENVS.md` is stale in its status, correct in its
recipe.** It is marked "STUB / TODO — execute this on the M1 Ultra Mac Studio"
and speculates about whether F5 and Voxtral need their own envs. They now do have
published envs on the `assets` tag, so §0–§3 of that doc describe a decision that
has since been made. Its §4 publish recipe and §6 gotchas are still accurate and
are the source for §3.1 above.

**9.7 — `rvc-env.ts` carries a `TODO(enhance-envs): fill after upload` block whose
placeholders have since been filled.** The comment (lines ~63–91) says the values
below it are placeholders pending an upload, but `RVC_ENV_WIN_*` and
`RVC_ENV_MAC_*` now hold real hashes and byte counts that match the published
assets. Only the comment is stale.

**9.8 — The `assets` release tag cannot express a rollback.** Every BookForge-hosted
artifact is uploaded with `--clobber` to one non-versioned tag. A mistaken upload
overwrites the previous bytes irrecoverably, and the only record that a given
sha256 was ever live is whatever version constant happened to be committed at the
time. The conda-env components' `_VERSION` constants and the dated comments in
`rvc-env.ts` are doing that job informally.

**9.9 — Not a gap: the GitHub-hosted byte counts all check out.** For
completeness, the counter-check run while writing this. Every declared `bytes`
for an artifact on the `assets` tag matches the size reported by
`gh release view assets --repo telltaleatheist/bookforge` — the two e2a envs, the
three runtime assets, `f5-env` (both platforms, including the sum of its two
parts), `rvc-env` (both, including the sum of its three parts), `resemble-env`
(both), `whisperx-env` (both), `voxtral-env` darwin, `deepspeed-xtts`,
`rvc-base-models`, and both llama-cuda mirror zips. All four foundry v0.5.0
hashes and sizes in `foundry-cli-components.ts` match
`gh release view v0.5.0 --repo telltaleatheist/foundry`.

Not checked, because they are not on a GitHub release: the four RVC voice
tarballs and the foundry/blocks GGUFs on Hugging Face, and the PyTorch wheel
sizes in `cuda-tts.ts` / `cuda-rvc.ts` (whose `bytes` are explicitly an estimate —
`TORCH_BYTES + TORCHAUDIO_BYTES`, the latter a round 5,000,000).
