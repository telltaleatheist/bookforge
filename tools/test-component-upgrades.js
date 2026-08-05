#!/usr/bin/env node
/**
 * Tests for the startup update check's decision layer:
 *   electron/components/component-upgrades.ts   — which components are stale
 *   electron/components/foundry-release-check.ts — the pure half of "is there a
 *                                                   release newer than the pin"
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-component-upgrades.js
 *
 * Everything asserted here is a rule someone can get wrong quietly. The two that
 * cost the most if they regress:
 *
 *  - "upgrade what is installed, never install what is not". Several managed
 *    components are 2–4 GB (docs/DISTRIBUTION.md §4), and a sweep that queued one
 *    the user deliberately skipped would look like the app installing things by
 *    itself.
 *  - "never install an artifact you cannot verify". A release published without a
 *    checksums.txt line for a tarball is a REFUSAL BY NAME, never a quiet install
 *    and never a silent shrug back to the pin. See the trade-off argued at the
 *    top of foundry-release-check.ts — the whole reason discovery is allowed at
 *    all is that the checksum lookup is unconditional.
 *
 * NO NETWORK. `artifactsForRelease` and `parseChecksums` take the GitHub API's
 * JSON and the checksums file as plain values, which is exactly why they were
 * split out of the fetching.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const UPGRADES = path.join(REPO, 'dist', 'electron', 'components', 'component-upgrades.js');
const RELEASE = path.join(REPO, 'dist', 'electron', 'components', 'foundry-release-check.js');
const CATALOG = path.join(REPO, 'dist', 'electron', 'components', 'foundry-cli-components.js');
for (const m of [UPGRADES, RELEASE, CATALOG]) {
  if (!fs.existsSync(m)) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}

const { isSemver, chooseTargetVersion, planUpgrade, planUpgrades, upgradesFrom } = require(UPGRADES);
const { versionFromTag, parseChecksums, artifactsForRelease, CHECKSUMS_FILE } = require(RELEASE);
const { FOUNDRY_ASSETS, FOUNDRY_CLI_VERSION } = require(CATALOG);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A candidate with the boring answers filled in; override what a test is about. */
const candidate = (over = {}) => ({
  id: 'rvc-env',
  name: 'RVC Engine',
  targetVersion: '2.0.0',
  supportsManaged: true,
  installed: { source: 'managed', version: '1.0.0' },
  envPinned: false,
  installing: false,
  ...over,
});

// ── Rule 1: upgrade what is installed, never install what is not ────────────

test('a component that is not installed is never queued', () => {
  const v = planUpgrade(candidate({ installed: null }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /not installed/);
  assert.strictEqual(v.fromVersion, null);
});

test('an installed managed component behind the catalog is an upgrade', () => {
  const v = planUpgrade(candidate());
  assert.strictEqual(v.verdict, 'upgrade');
  assert.strictEqual(v.fromVersion, '1.0.0');
  assert.strictEqual(v.toVersion, '2.0.0');
});

// ── Rule: never touch an external or env-pinned install ─────────────────────

test('an EXTERNAL install is left alone at any version', () => {
  const v = planUpgrade(candidate({ installed: { source: 'external', version: '0.0.1' } }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /externally/);
});

test('an env-var-pinned component is left alone even when managed and stale', () => {
  const v = planUpgrade(candidate({ envPinned: true }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /environment variable/);
});

test('env pinning outranks the managed record — a developer build always wins', () => {
  const v = planUpgrade(candidate({ envPinned: true, installed: { source: 'managed', version: '0.1.0' } }));
  assert.strictEqual(v.verdict, 'keep');
});

// ── Rule: do not fight a component that is already installing ───────────────

test('an install already in flight is not queued a second time', () => {
  const v = planUpgrade(candidate({ installing: true }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /already running/);
});

// ── Rules: nothing to compare, nothing to download ──────────────────────────

test('an unversioned component (Calibre, Tesseract) is never stale', () => {
  const v = planUpgrade(candidate({
    id: 'calibre', name: 'Calibre', targetVersion: '',
    installed: { source: 'managed', version: '' },
  }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /does not version/);
});

// Regression, 2026-08-05: a Mac's first launch re-downloaded the US Female 1 RVC
// voice. Its record said `version: ''` — every voice record is written that way —
// the catalog names `2026.06.25`, and the mismatch read as staleness. An absent
// version is UNKNOWN, not old, and the remedy for guessing was gigabytes of
// already-present model weights over the wire.
test('a record with NO recorded version is unknown, not stale', () => {
  const v = planUpgrade(candidate({
    id: 'rvc-voice-us-female-1', name: 'US Female 1',
    targetVersion: '2026.06.25',
    installed: { source: 'managed', version: '' },
  }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /no version was recorded/);
});

test('an unrecorded version is not rescued by the version being undefined either', () => {
  // installed.json has carried records without the key at all.
  const v = planUpgrade(candidate({
    targetVersion: '2026.06.25',
    installed: { source: 'managed' },
  }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /no version was recorded/);
});

test('a component with no managed download is never queued', () => {
  const v = planUpgrade(candidate({ supportsManaged: false }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /no managed download/);
});

test('matching versions are up to date', () => {
  const v = planUpgrade(candidate({ installed: { source: 'managed', version: '2.0.0' } }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /up to date/);
});

// ── Rule 8: a downgrade is not an upgrade — but only where it can happen ────

test('foundry installed NEWER than the catalog is left alone', () => {
  // The offline-restart case: the machine took a discovered 0.6.0, and this
  // launch can only see the 0.5.0 pin. It must not be dragged backwards.
  const v = planUpgrade(candidate({
    id: 'foundry-cli', name: 'Foundry CLI', mayBeAheadOfCatalog: true,
    targetVersion: '0.5.0',
    installed: { source: 'managed', version: '0.6.0' },
  }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /downgrade is not an upgrade/);
});

test('a catalog-only component IS rolled back when its pin moves backwards', () => {
  // The guard must NOT leak to components the catalog fully controls. Rolling
  // RVC_ENV_VERSION back to a known-good tarball has to reach installed machines
  // — and the date-stamped env versions parse as X.Y.Z, so shape alone would
  // have silently blocked exactly that.
  assert.ok(isSemver('2026.06.16'), 'dated env versions do parse as X.Y.Z');
  const v = planUpgrade(candidate({
    id: 'rvc-env', targetVersion: '2026.05.01',
    installed: { source: 'managed', version: '2026.06.16' },
  }));
  assert.strictEqual(v.verdict, 'upgrade');
});

test('a version that is not semver at all is compared by inequality only', () => {
  const build = planUpgrade(candidate({
    id: 'llama-cuda', mayBeAheadOfCatalog: true,
    targetVersion: 'b7000',
    installed: { source: 'managed', version: 'b7482' },
  }));
  assert.strictEqual(build.verdict, 'upgrade', 'b7482 vs b7000 has no ordering to respect');
});

test('isSemver recognises X.Y.Z (with or without a leading v) and nothing else', () => {
  for (const yes of ['0.5.0', 'v1.2.3', '10.0.1', '1.2.3-beta', '1.2.3+build', '2026.06.16']) {
    assert.ok(isSemver(yes), `${yes} should be semver`);
  }
  for (const no of ['', '2026.06.16.1', 'b7482', '1.2', 'latest', '0.19']) {
    assert.ok(!isSemver(no), `${no} should not be semver`);
  }
});

// ── planUpgrades / upgradesFrom over a mixed machine ────────────────────────

test('a realistic mixed machine yields exactly the managed+installed+stale ones', () => {
  const plan = planUpgrades([
    candidate({ id: 'foundry-cli', name: 'Foundry CLI', targetVersion: '0.6.0', installed: { source: 'managed', version: '0.5.0' } }),
    candidate({ id: 'rvc-env', targetVersion: '2026.07.01', installed: { source: 'managed', version: '2026.07.01' } }),
    candidate({ id: 'f5-env', targetVersion: '2026.08.01', installed: null }),
    candidate({ id: 'orpheus', targetVersion: '', installed: { source: 'external', version: '' } }),
    candidate({ id: 'whisperx-env', targetVersion: '2026.08.01', installed: { source: 'managed', version: '2026.05.01' } }),
  ]);
  assert.strictEqual(plan.length, 5);
  assert.deepStrictEqual(upgradesFrom(plan).map((p) => p.id), ['foundry-cli', 'whisperx-env']);
  // Every verdict explains itself — the reason is the log line a user will read.
  for (const item of plan) assert.ok(item.reason && item.reason.length > 0, `${item.id} has no reason`);
});

// ── chooseTargetVersion: the pin vs the release ─────────────────────────────

test('a release NEWER than the pin wins', () => {
  const t = chooseTargetVersion('0.5.0', '0.6.0');
  assert.strictEqual(t.version, '0.6.0');
  assert.strictEqual(t.from, 'release');
});

test('the pin wins on a tie', () => {
  const t = chooseTargetVersion('0.5.0', '0.5.0');
  assert.strictEqual(t.version, '0.5.0');
  assert.strictEqual(t.from, 'pin');
});

test('the pin wins when it is AHEAD of the newest release — a downgrade is not an upgrade', () => {
  const t = chooseTargetVersion('0.6.0', '0.5.0');
  assert.strictEqual(t.version, '0.6.0');
  assert.strictEqual(t.from, 'pin');
});

test('no release discovered (offline, or nothing newer) keeps the pin', () => {
  const t = chooseTargetVersion('0.5.0', null);
  assert.strictEqual(t.version, '0.5.0');
  assert.strictEqual(t.from, 'pin');
  assert.match(t.reason, /no published release newer/);
});

test('a version that cannot be ordered against the pin keeps the pin, and says why', () => {
  const t = chooseTargetVersion('0.5.0', 'nightly');
  assert.strictEqual(t.from, 'pin');
  assert.match(t.reason, /not X\.Y\.Z/);
});

// ── versionFromTag ──────────────────────────────────────────────────────────

test('a release tag yields its version, and a non-version tag yields null', () => {
  assert.strictEqual(versionFromTag('v0.5.0'), '0.5.0');
  assert.strictEqual(versionFromTag('0.5.0'), '0.5.0');
  assert.strictEqual(versionFromTag('assets'), null);
  assert.strictEqual(versionFromTag(''), null);
});

// ── parseChecksums ──────────────────────────────────────────────────────────

test('both sha256sum spellings parse — binary mode is what foundry actually ships', () => {
  // Verbatim shape of the published v0.5.0 checksums.txt: one space, then `*`.
  const binary = parseChecksums(
    'b47c85e5f5c98d583f7a5efcb2f53320a9c4af77e9a1adfb49d4125b4aaa7a84 *foundry-darwin-arm64.tar.gz\n'
    + '97ce639d64c1220046b6318307c5a326baf50661c1bd95117f74e991c6553249 *foundry-windows-x64.tar.gz\n'
  );
  assert.strictEqual(
    binary['foundry-windows-x64.tar.gz'],
    '97ce639d64c1220046b6318307c5a326baf50661c1bd95117f74e991c6553249',
  );
  const text = parseChecksums('a'.repeat(64) + '  ./foundry-linux-x64.tar.gz\n');
  assert.strictEqual(text['foundry-linux-x64.tar.gz'], 'a'.repeat(64));
});

test('parsing is case-insensitive on the hash and ignores blank and comment lines', () => {
  const map = parseChecksums(['# generated', '', 'B'.repeat(64) + ' *x.tar.gz', ''].join('\n'));
  assert.deepStrictEqual(map, { 'x.tar.gz': 'b'.repeat(64) });
});

test('a line that is not a checksum is skipped rather than half-parsed', () => {
  assert.deepStrictEqual(parseChecksums('not a checksum at all\nshort *x.tar.gz\n'), {});
});

// ── artifactsForRelease ─────────────────────────────────────────────────────

/** A release payload shaped like the GitHub API's, built from the naming contract. */
const releaseWith = (files) => ({
  tag_name: 'v0.6.0',
  assets: files.map((f, i) => ({
    name: f,
    size: 1000 + i,
    browser_download_url: `https://github.com/telltaleatheist/foundry/releases/download/v0.6.0/${f}`,
  })),
});
const allFiles = FOUNDRY_ASSETS.map((a) => a.file);
const fullChecksums = Object.fromEntries(allFiles.map((f, i) => [f, String(i).repeat(64).slice(0, 64)]));

test('a complete release yields one artifact per published platform, hashed from checksums.txt', () => {
  const arts = artifactsForRelease(releaseWith(allFiles), fullChecksums, '0.6.0', 'win32', 'x64');
  assert.strictEqual(arts.length, allFiles.length);
  const win = arts.find((a) => a.platform === 'win32' && a.arch === 'x64');
  assert.strictEqual(win.file, 'foundry-windows-x64.tar.gz');
  assert.strictEqual(win.sha256, fullChecksums['foundry-windows-x64.tar.gz']);
  // The URL is the release's own, not one derived from the pin.
  assert.ok(win.url.includes('/v0.6.0/'));
  // The byte count is the asset's real size, which the disk pre-check uses.
  assert.strictEqual(typeof win.bytes, 'number');
});

test('a published tarball with NO checksum line is a refusal that names the file', () => {
  const missing = { ...fullChecksums };
  delete missing['foundry-windows-x64.tar.gz'];
  assert.throws(
    () => artifactsForRelease(releaseWith(allFiles), missing, '0.6.0', 'win32', 'x64'),
    (err) => {
      assert.match(err.message, /foundry-windows-x64\.tar\.gz/);
      assert.match(err.message, new RegExp(CHECKSUMS_FILE));
      assert.match(err.message, /will not install an artifact it cannot verify/);
      return true;
    },
  );
});

test('a missing hash anywhere in the release refuses, not just this platform', () => {
  // A partial set would ship a component whose OTHER platforms are unverifiable
  // as soon as the same release is read on another machine.
  const missing = { ...fullChecksums };
  delete missing['foundry-darwin-arm64.tar.gz'];
  assert.throws(
    () => artifactsForRelease(releaseWith(allFiles), missing, '0.6.0', 'win32', 'x64'),
    /foundry-darwin-arm64\.tar\.gz/,
  );
});

test('a platform absent from the release is skipped, not invented', () => {
  const partial = allFiles.filter((f) => f !== 'foundry-linux-x64.tar.gz');
  const arts = artifactsForRelease(releaseWith(partial), fullChecksums, '0.6.0', 'win32', 'x64');
  assert.strictEqual(arts.length, partial.length);
  assert.ok(!arts.some((a) => a.platform === 'linux'));
});

test('a release with nothing for THIS machine refuses and names the pin it stays on', () => {
  const noWindows = allFiles.filter((f) => f !== 'foundry-windows-x64.tar.gz');
  assert.throws(
    () => artifactsForRelease(releaseWith(noWindows), fullChecksums, '0.6.0', 'win32', 'x64'),
    (err) => {
      assert.match(err.message, /win32\/x64/);
      assert.match(err.message, new RegExp(FOUNDRY_CLI_VERSION.replace(/\./g, '\\.')));
      return true;
    },
  );
});

test('the asset names come from the catalog, so the contract has one spelling', () => {
  // docs/DISTRIBUTION.md §2.3: foundry-<platform>-<arch>.tar.gz. If this list and
  // release-package.sh ever disagree, installs break on one platform silently.
  assert.deepStrictEqual([...allFiles].sort(), [
    'foundry-darwin-arm64.tar.gz',
    'foundry-darwin-x64.tar.gz',
    'foundry-linux-x64.tar.gz',
    'foundry-windows-x64.tar.gz',
  ]);
});

// ── The catalog entry follows a discovered release ──────────────────────────

test('adopting a release changes the component version, URLs, hashes and help link', () => {
  // Loaded fresh so the module-level override cannot leak into other tests.
  delete require.cache[require.resolve(CATALOG)];
  const cat = require(CATALOG);
  const before = cat.foundryCliComponent();
  assert.strictEqual(before.version, cat.FOUNDRY_CLI_VERSION);
  assert.strictEqual(cat.effectiveFoundryVersion(), cat.FOUNDRY_CLI_VERSION);

  cat.setDiscoveredFoundryRelease({
    version: '9.9.9',
    artifacts: cat.FOUNDRY_ASSETS.map((a) => ({
      platform: a.platform,
      arch: a.arch,
      file: a.file,
      url: `https://github.com/telltaleatheist/foundry/releases/download/v9.9.9/${a.file}`,
      sha256: 'f'.repeat(64),
      bytes: 123,
    })),
  });

  const after = cat.foundryCliComponent();
  assert.strictEqual(after.version, '9.9.9');
  assert.strictEqual(cat.effectiveFoundryVersion(), '9.9.9');
  assert.ok(after.externalHelpUrl.endsWith('/v9.9.9'));
  for (const art of after.artifacts) {
    assert.ok(art.url.includes('/v9.9.9/'), `${art.url} still points at the pin`);
    assert.strictEqual(art.sha256, 'f'.repeat(64));
  }
  // The install path pre-checks disk against sizeBytes; it must follow too.
  const mine = after.artifacts.find((a) => a.platform === process.platform && a.arch === process.arch);
  if (mine) assert.strictEqual(after.sizeBytes, mine.bytes);

  delete require.cache[require.resolve(CATALOG)];
});

test('the pinned entry still carries pasted hashes and pin-derived URLs', () => {
  delete require.cache[require.resolve(CATALOG)];
  const cat = require(CATALOG);
  const comp = cat.foundryCliComponent();
  assert.strictEqual(comp.artifacts.length, cat.FOUNDRY_ASSETS.length);
  for (const a of cat.FOUNDRY_ASSETS) {
    const art = comp.artifacts.find((x) => x.platform === a.platform && x.arch === a.arch);
    assert.strictEqual(art.sha256, a.sha256);
    assert.strictEqual(art.bytes, a.bytes);
    assert.ok(art.url.endsWith(`/v${cat.FOUNDRY_CLI_VERSION}/${a.file}`));
    assert.match(a.sha256, /^[0-9a-f]{64}$/, `${a.file} has no pasted hash`);
  }
  delete require.cache[require.resolve(CATALOG)];
});

// ── Run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
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
