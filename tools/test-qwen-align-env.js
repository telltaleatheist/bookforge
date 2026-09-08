#!/usr/bin/env node
/**
 * Keeper for the Qwen3 forced-aligner component's SHAPE:
 *   electron/components/qwen-align-env.ts
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-qwen-align-env.js
 *
 * Everything asserted here is a fact someone can break quietly, and each one
 * costs a user a download that cannot work:
 *
 *  - The platform gate. This env is darwin-arm64 ONLY. Windows is served by a
 *    WSL env named `qwen-align` through the `qwenAlignEnv` tool-path setting,
 *    which is not something a managed install can lay down — so an artifact or
 *    a `platforms` entry for win32 here would offer a download that is wrong on
 *    arrival, not merely unhelpful.
 *  - The checksum. A managed artifact whose sha256 is empty INSTALLS WITHOUT
 *    VERIFYING (component-types.ts says the check is skipped with a warning);
 *    for a 476 MB env that is the difference between "refused by name" and
 *    "silently unpacked something else".
 *  - `condaUnpack`. The tarball is conda-pack'd and relocatable; without the
 *    post-extract `conda-unpack` every shebang and prefix in it still points at
 *    the build machine's path and the env's python cannot import anything.
 *  - The detect candidates. The env this component was packed FROM lives at
 *    /opt/homebrew/Caskroom/miniconda/base/envs/qwen-align on the Mac Studio.
 *    If the candidate list stops naming `qwen-align`, that machine is told to
 *    download half a gigabyte it already has.
 *
 * NO NETWORK, and nothing here fetches the artifact — this reads the catalog
 * entry as the plain data it is.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MOD = path.join(REPO, 'dist', 'electron', 'components', 'qwen-align-env.js');
if (!fs.existsSync(MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { qwenAlignEnvComponent, QWEN_ALIGN_ENV_ID } = require(MOD);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const c = qwenAlignEnvComponent();

test('the id is the one every consumer types, and the export agrees with it', () => {
  assert.strictEqual(QWEN_ALIGN_ENV_ID, 'qwen-align-env');
  assert.strictEqual(c.id, 'qwen-align-env');
  assert.strictEqual(c.kind, 'conda-env');
  assert.deepStrictEqual(c.acquisition, ['managed']);
});

test('darwin-arm64 ONLY — no win32 anywhere, because Windows uses a WSL env', () => {
  assert.deepStrictEqual(c.requirements.platforms, ['darwin']);
  // gpu:'apple-silicon' is what makes an INTEL Mac say "Requires Apple Silicon"
  // instead of being offered an arm64 tarball it cannot run.
  assert.strictEqual(c.requirements.gpu, 'apple-silicon');
  assert.strictEqual(c.artifacts.length, 1, 'one platform, one artifact');
  const [a] = c.artifacts;
  assert.strictEqual(a.platform, 'darwin');
  assert.strictEqual(a.arch, 'arm64');
  for (const art of c.artifacts) {
    assert.notStrictEqual(art.platform, 'win32', 'no Windows artifact may appear here');
  }
});

test('the artifact is a published, verifiable, relocatable conda-pack tarball', () => {
  const [a] = c.artifacts;
  assert.ok(
    a.url.startsWith('https://github.com/telltaleatheist/bookforge/releases/download/assets/'),
    `artifact must live on the assets release tag, got ${a.url}`);
  assert.ok(a.url.endsWith('/qwen-align-env-macos-arm64.tar.gz'),
    `naming convention is <engine>-env-macos-arm64.tar.gz, got ${a.url}`);
  // An empty sha256 is an INSTALL THAT SKIPS VERIFICATION, not a missing test.
  assert.ok(/^[0-9a-f]{64}$/.test(a.sha256), `sha256 must be 64 lowercase hex, got ${JSON.stringify(a.sha256)}`);
  assert.strictEqual(a.bytes, 499191377);
  assert.strictEqual(a.condaUnpack, true, 'conda-pack output is unusable un-relocated');
  assert.ok(!a.parts, 'single file — under GitHub\'s 2 GiB per-file cap');
});

test('a hand-built `qwen-align` env is adopted rather than re-downloaded', () => {
  const cands = (c.detect && c.detect.candidates) || [];
  const darwin = cands.filter((x) => x.platform === 'darwin').map((x) => x.path);
  assert.ok(darwin.length > 0, 'no darwin candidates at all');
  for (const p of darwin) {
    assert.ok(p.endsWith(path.join('envs', 'qwen-align')), `candidate does not name the env: ${p}`);
  }
  // The exact env this tarball was packed from, on the Mac Studio.
  assert.ok(
    darwin.includes(path.join('/opt/homebrew/Caskroom/miniconda/base', 'envs', 'qwen-align')),
    'the Homebrew miniconda root that holds this Mac\'s own qwen-align env is missing');
  // Its own variable, mirroring whisperx-env's WHISPERX_ENV_PATH. NOT
  // NARRATOR_ALIGN_PYTHON: that is the operator's override over every backend,
  // and a component claiming it would silently redirect whisperx runs too.
  assert.strictEqual(c.detect.envVar, 'QWEN_ALIGN_ENV_PATH');
});

test('verify imports the three packages an align run actually needs', () => {
  assert.strictEqual(c.verify.kind, 'python-import');
  assert.deepStrictEqual(c.verify.modules, ['qwen_asr', 'torch', 'soundfile']);
});

test('the headline size and disk gate leave room for the HF-pulled weights', () => {
  assert.strictEqual(c.sizeBytes, c.artifacts[0].bytes);
  // ~476 MB download + ~2 GB extracted + the ~1.2 GB Qwen3-ForcedAligner-0.6B
  // that from_pretrained fetches on first use. A gate that only covered the
  // tarball would green-light a machine that runs out mid-model.
  assert.ok(c.requirements.minDiskMB >= 3700,
    `minDiskMB ${c.requirements.minDiskMB} does not cover download + extract + weights`);
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
})();
