# Building the Mac (Apple Silicon) TTS engine environments — STUB / TODO

> **Status: STUB.** Written on the Windows box; **execute this on the M1 Ultra Mac Studio**
> when development moves there. The Windows builds (F5 first) happen separately on the PC.
>
> Goal: produce per-platform `conda-pack` tarballs for the new TTS engines (F5 now;
> Voxtral / Orpheus later), upload them to the **`assets`** GitHub release on
> `telltaleatheist/bookforge`, and wire each into a managed `conda-env` component —
> the **same machinery already proven for the RVC env** (`electron/components/rvc-env.ts`)
> and the e2a env (`electron/e2a-env-bootstrap.ts`).

---

## 0. The big decision FIRST: separate env vs. ride the existing e2a env

The macOS e2a env (`packaging/env/ebook2audiobook-macos-arm64.yml`) **already ships the full
MLX TTS stack**:

```
mlx==0.30.4   mlx-audio==0.3.0   mlx-lm==0.30.5   mlx-metal==0.30.4   snac==1.2.1
```

`mlx-audio` is the loader for Voxtral-mlx and several other TTS models; `snac` is the Orpheus
codec. So on **Mac, the cheap path is to NOT build separate envs** — add a small MLX engine
class in the e2a fork that loads the model through the *existing* env, and download only the
**weights** from HuggingFace (the RVC pattern: env shipped once, models pulled separately).

- **Voxtral on Mac** → `mlx-audio` + `mlx-community/Voxtral-4B-TTS-2603-mlx-4bit` (~2.5 GB weights).
  Likely **no new env needed** — verify `from mlx_audio.tts.utils import load` works in the
  current e2a env first.
- **Orpheus on Mac** → e2a's `orpheus.py` already has an `mlx` backend + `snac` is present.
  Likely **no new env needed**.
- **F5 on Mac** → needs `f5-tts-mlx` (lucasnewman/f5-tts-mlx), which is **not** in the e2a env.
  This is the one Mac engine that probably **does** want its own packed env (or an additive
  pip install layered on a clone of the e2a env). Decide: extend the e2a yml vs. separate env.

**Action:** before building anything, on the Mac run the verify snippets in §3 against the
*existing* e2a env. Only build a separate env for engines that genuinely fail to import there.

---

## 1. Prereqs (Mac)

- Apple Silicon miniconda (you already use it — e2a prefix is
  `/opt/homebrew/Caskroom/miniconda/base/envs/ebook2audiobook`).
- `conda install -n base conda-pack` (or `pip install conda-pack` in the env you'll pack).
  **Re-apply the conda-pack source fix if reinstalled** — see the `\\?\` corruption note in
  CLAUDE.md memory; the prefix-rewrite patch lives in `conda_pack/prefixes.py`. (That bug is
  Windows-specific, but always `compileall` a freshly-unpacked tarball before trusting it.)
- `gh` CLI authed as `telltaleatheist` (already set up).

---

## 2. Per-engine env build recipe

Naming MUST match the existing convention (see `rvc-env.ts:40-54`):
`<engine>-env-macos-arm64.tar.gz`, hosted under the **`assets`** release tag.

### F5-TTS (the one that likely needs its own Mac env)

```bash
conda create -n f5-mac python=3.11 -y
conda activate f5-mac
pip install f5-tts-mlx          # Apple-Silicon-native MLX build (NOT the CUDA f5-tts)
# (weights download from HF on first use — do NOT bake them into the env tarball)

# smoke-test a render BEFORE packing (see §3), then:
conda-pack -n f5-mac -o f5-env-macos-arm64.tar.gz --format tar.gz
```

### Voxtral / Orpheus

Only if §0 verify shows they can't ride the e2a env. If they need isolation, mirror the F5
recipe with `mlx-audio` (Voxtral) / the Orpheus MLX deps. Keep the **8 GB Voxtral BF16 weights
out of the tarball** — pull `mlx-community/Voxtral-4B-TTS-2603-mlx-4bit` (~2.5 GB) from HF at
runtime.

---

## 3. Verify BEFORE packing (and before deciding §0)

Run in the *existing* e2a env first (to test §0), then in any new env:

```python
# Voxtral (mlx-audio)
from mlx_audio.tts.utils import load
m = load("mlx-community/Voxtral-4B-TTS-2603-mlx-4bit")   # downloads weights

# F5 (f5-tts-mlx)
from f5_tts_mlx.generate import generate                 # import must succeed
```

A clean render to a wav is the real test. Then pack, **extract the tarball to a scratch dir,
run `conda-unpack`, and confirm the relocated `bin/python -c "import <module>"` still works** —
this is exactly what `e2a-env-bootstrap.ts` does on the user's machine.

---

## 4. Publish to GitHub Releases (`assets` tag) + record sha/bytes

```bash
gh release upload assets f5-env-macos-arm64.tar.gz --clobber --repo telltaleatheist/bookforge
shasum -a 256 f5-env-macos-arm64.tar.gz      # sha256 for the component
stat -f%z   f5-env-macos-arm64.tar.gz        # bytes for the component
```

> The env tarballs are referenced **directly in TypeScript** (url + sha256 + bytes), NOT through
> `publish-release.js --component` (that path is for catalog/manifest binaries like ffmpeg).
> Follow the `rvc-env.ts` / `e2a-env-bootstrap.ts` pattern.

---

## 5. Wire it up: a managed `conda-env` component

Create `electron/components/f5-env.ts` modeled exactly on `rvc-env.ts`. Fill the recorded
sha256/bytes from §4:

```ts
export const F5_ENV_ID = 'f5-env';
const F5_ENV_VERSION = 'YYYY.MM.DD';        // bump to force re-download

const F5_ENV_ARTIFACTS: ComponentArtifact[] = [
  { platform: 'win32',  arch: 'x64',   gpu: 'cuda', url: '…/f5-env-windows-x64.tar.gz', sha256: '…', bytes: 0, condaUnpack: true },
  { platform: 'darwin', arch: 'arm64', gpu: 'none', url: '…/f5-env-macos-arm64.tar.gz', sha256: '…', bytes: 0, condaUnpack: true },
];

export function f5EnvComponent(): OptionalComponent {
  return {
    id: F5_ENV_ID,
    name: 'F5-TTS',
    description: 'Flow-matching TTS with strong long-form prosody. ~N GB download.',
    kind: 'conda-env',
    acquisition: ['managed'],
    sizeBytes: 0,
    requirements: { platforms: ['win32', 'darwin'], gpu: 'none', minDiskMB: 6000 },
    artifacts: F5_ENV_ARTIFACTS,
    verify: { kind: 'python-import', module: 'f5_tts_mlx' },   // module name per platform!
    version: F5_ENV_VERSION,
    entryPath: '',
  };
}
```

Then register it in the component catalog next to `orpheus` / `rvcEnvComponent()`, add the new
e2a engine class (`lib/classes/tts_engines/f5.py`), extend the `TTSEngine` union + the wizard
picker, and route `--tts_engine f5` through `parallel-tts-bridge.ts` (the engine-registry refactor
makes this last part one entry instead of scattered conditionals).

---

## 6. Gotchas carried from prior work

- **>2 GiB GitHub asset limit.** A CUDA F5 env (~3 GB) or Voxtral env exceeds it → split archive
  (`.tar.gz.001/.002…`) reassembled on download (net-new bootstrap support). The current e2a env
  (1.8 GB) and RVC env (755 MB) fit under the cap. Mac MLX envs are usually smaller (no CUDA).
- **Weights ≠ env.** Always pull model checkpoints from HuggingFace at runtime; pack only code+deps.
- **`conda-unpack` must run via the env's own python** (its shebang assumes none on PATH) — the
  bootstrap already does this; just mirror it when smoke-testing locally.
- **You can't cross-build.** Mac tarballs build on the Mac; Windows on the PC. (That's why this
  file exists.)
</content>
</invoke>
