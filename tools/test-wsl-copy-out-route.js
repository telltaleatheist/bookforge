#!/usr/bin/env node
/**
 * Keeper: a WSL session's copy-out road is chosen from the DESTINATION.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-wsl-copy-out-route.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * A render that lived on ext4 has to come out of the guest. The fast road is
 * the guest's own `cp` from ext4 to `/mnt/<letter>`; it exists only when the
 * guest actually HAS that drive mounted. WSL2 auto-mounts fixed drives only,
 * so the library's Z: (the NAS, over SMB) has no `/mnt/z` at all, and the guest's
 * `mkdir -p /mnt/z/bookforge` answers "Permission denied" — which is how the
 * scratch rescue lost 2,728 rendered sentences across four events: the copy
 * failed, the sweep that followed deleted the only copy of the work.
 *
 * The road is therefore chosen UP FRONT from a probed fact, never tried and
 * retried: a drive the guest has mounted goes in-guest, everything else is
 * copied by Windows through the `\\wsl$` share (slow 9p, but it arrives).
 *
 * The claims:
 *
 *  1. A mounted drive takes the in-guest road.
 *  2. A drive the guest cannot see takes the `\\wsl$` road — it is not tried
 *     in the guest first.
 *  3. A UNC destination has no drive letter to mount, so it takes the `\\wsl$`
 *     road WITHOUT asking the guest anything.
 *  4. The probe is asked about the bare letter, once.
 *  5. The live probe asks `mountpoint -q`, not `test -d`: the mount POINT
 *     survives `wsl -t` as a root-owned empty directory, so `test -d` answered
 *     "mounted" for a share that was not (measured 2026-09-14).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'parallel-tts-bridge.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'estub';
  return origResolve.call(this, request, ...rest);
};
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: { getPath: () => REPO, getAppPath: () => REPO, on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {},
    shell: {},
  },
};
const bridge = require(MODULE);

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

/** A probe that answers for a fixed set of mounted letters and records its asks. */
function probeFor(mounted) {
  const asked = [];
  const probe = async (letter) => { asked.push(letter); return mounted.includes(letter.toLowerCase()); };
  probe.asked = asked;
  return probe;
}

(async () => {
  console.log('the road is chosen from the destination');

  await check('a drive the guest has mounted goes in-guest', async () => {
    const probe = probeFor(['c']);
    assert.strictEqual(
      await bridge.copyOutRouteFor('C:\\Users\\<user>\\library\\tmp\\.tmp-ebook-1', probe),
      'in-guest');
    assert.deepStrictEqual(probe.asked, ['C']);
  });

  await check('a mapped network drive the guest cannot see goes through \\\\wsl$', async () => {
    const probe = probeFor(['c', 'e']);
    assert.strictEqual(
      await bridge.copyOutRouteFor('Z:\\<library>\\projects\\Mutineer\\stages\\03-tts', probe),
      'through-wsl-share');
    assert.deepStrictEqual(probe.asked, ['Z'], 'the guest was asked about something other than Z');
  });

  await check('a UNC destination has no drive to mount, and the guest is never asked', async () => {
    const probe = probeFor(['c']);
    assert.strictEqual(
      await bridge.copyOutRouteFor('\\\\NAS\\bookforge\\projects\\x', probe),
      'through-wsl-share');
    assert.deepStrictEqual(probe.asked, [],
      'a UNC path with no drive letter still went out to the guest to ask about one');
  });

  await check('forward slashes name the same drive', async () => {
    const probe = probeFor(['e']);
    assert.strictEqual(await bridge.copyOutRouteFor('E:/training/out', probe), 'in-guest');
  });

  console.log('\nthe live probe');

  await check('it asks mountpoint -q, not test -d (a stale mount point is a directory)', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');
    const at = src.indexOf('async function wslSeesDrive(');
    assert.ok(at > 0, 'wslSeesDrive is gone — the probe moved');
    const body = src.slice(at, at + 2000);
    // The probe STATEMENT, not the prose around it — the comment beside it
    // quotes `test -d /mnt/z` as the thing that went wrong.
    assert.match(body, /const probe = `mountpoint -q /, 'the probe is not mountpoint -q');
    assert.ok(!/const probe = `test -d/.test(body), 'test -d is back');
    // And the mount POINT is the converter's answer, not a second spelling of
    // `/mnt/<letter>`: a probe of a directory nothing mounts at reads as a share
    // that is down.
    assert.match(body, /mountpoint -q \$\{windowsToWslPath\(/,
      'the probe spells the mount point itself instead of asking the one converter');
  });

  await check('copyDirOutOfWsl asks the route chooser rather than deciding again', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');
    const at = src.indexOf('async function copyDirOutOfWsl(');
    assert.ok(at > 0, 'copyDirOutOfWsl is gone');
    const body = src.slice(at, at + 2000);
    assert.match(body, /copyOutRouteFor\(/, 'the copy no longer routes through the one chooser');
  });

  if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nAll wsl-copy-out-route checks passed.');
})().catch((err) => {
  console.error('wsl-copy-out-route: the suite itself failed:', err);
  process.exit(1);
});
