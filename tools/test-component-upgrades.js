#!/usr/bin/env node
/**
 * Tests for the startup update check's decision layer:
 *   electron/components/component-upgrades.ts   — which components are stale
 *
 * (The foundry CLI's release check, and its tests, went with the `foundry-cli`
 * component on 2026-09-24: the foundry engine ships inside foundry-app/engine/.)
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-component-upgrades.js
 *
 * Everything asserted here is a rule someone can get wrong quietly. The one that
 * costs the most if it regresses:
 *
 *  - "upgrade what is installed, never install what is not". Several managed
 *    components are 2–4 GB (docs/DISTRIBUTION.md §4), and a sweep that queued one
 *    the user deliberately skipped would look like the app installing things by
 *    itself.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const UPGRADES = path.join(REPO, 'dist', 'electron', 'components', 'component-upgrades.js');
for (const m of [UPGRADES]) {
  if (!fs.existsSync(m)) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}

const { isSemver, planUpgrade, planUpgrades, upgradesFrom } = require(UPGRADES);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A candidate with the boring answers filled in; override what a test is about. */
const candidate = (over = {}) => ({
  id: 'rvc-env',
  name: 'RVC Engine',
  // A tool by default — the fixtures below are about version rules, and rule 0
  // would otherwise answer every one of them before they were asked.
  kind: 'conda-env',
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

// Owen, 2026-08-05: "the only situation in which a voice will be downloaded again
// is if its fully missing. they dont have versions." Weights are present-or-absent;
// this is rule 0 and it fires before any version is looked at.
test('a voice is never upgraded, however far its catalog version has moved', () => {
  const v = planUpgrade(candidate({
    id: 'rvc-voice-us-female-1', name: 'US Female 1', kind: 'rvc-model',
    targetVersion: '2027.01.01',
    installed: { source: 'managed', version: '2026.06.25' },
  }));
  assert.strictEqual(v.verdict, 'keep');
  assert.match(v.reason, /downloaded when it is missing/);
});

test('every content kind is present-or-absent, not upgraded', () => {
  for (const kind of ['rvc-model', 'stt-model', 'blocks-model']) {
    const v = planUpgrade(candidate({ kind, installed: { source: 'managed', version: '1.0.0' } }));
    assert.strictEqual(v.verdict, 'keep', `${kind} was queued for upgrade`);
    assert.match(v.reason, /downloaded when it is missing/);
  }
});

test('the tools ARE still upgraded — rule 0 must not silence everything', () => {
  for (const kind of ['binary', 'conda-env']) {
    const v = planUpgrade(candidate({ kind }));
    assert.strictEqual(v.verdict, 'upgrade', `${kind} was not queued`);
  }
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

// ── Rule 8: inequality, in BOTH directions ─────────────────────────────────

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
    id: 'llama-cuda',
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
    candidate({ id: 'llama-cuda', kind: 'binary', targetVersion: 'b7482', installed: { source: 'managed', version: 'b7000' } }),
    candidate({ id: 'rvc-env', targetVersion: '2026.07.01', installed: { source: 'managed', version: '2026.07.01' } }),
    candidate({ id: 'f5-env', targetVersion: '2026.08.01', installed: null }),
    candidate({ id: 'orpheus', targetVersion: '', installed: { source: 'external', version: '' } }),
    candidate({ id: 'whisperx-env', targetVersion: '2026.08.01', installed: { source: 'managed', version: '2026.05.01' } }),
  ]);
  assert.strictEqual(plan.length, 5);
  assert.deepStrictEqual(upgradesFrom(plan).map((p) => p.id), ['llama-cuda', 'whisperx-env']);
  // Every verdict explains itself — the reason is the log line a user will read.
  for (const item of plan) assert.ok(item.reason && item.reason.length > 0, `${item.id} has no reason`);
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
