#!/usr/bin/env node
/**
 * THE FINISHED AUDIOBOOK CROSSES INTO THE LIBRARY ONCE, WITH A BAR.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-library-copy.js
 *
 * 2026-09-22, Pursuit of Power: assembly staging lived on the NAS, so narrator's
 * faststart pass (1.4 MB/s) and the transcript embed (4.5 MB/s) each worked on a
 * 2.7 GB file over SMB behind a row at 95%. Staging is local now and
 * `copyIntoLibrary` (electron/reassembly-bridge.ts) is the one trip across: a
 * rename on one volume, otherwise one streamed copy that reports bytes, is
 * size-checked, and removes the local file only after. A failed copy leaves the
 * local file and no partial.
 *
 * Real filesystem, temp dirs only. The cross-volume case is produced by making
 * the rename answer EXDEV, which is what it answers across drives.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
process.env.BOOKFORGE_USER_DATA = process.env.BOOKFORGE_USER_DATA
  || fs.mkdtempSync(path.join(os.tmpdir(), 'bf-libcopy-ud-'));
require('../cli/electron-stub.js');

const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'reassembly-bridge.js'))) {
  console.error('dist/electron/reassembly-bridge.js is missing — compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const bridge = require(path.join(DIST, 'reassembly-bridge.js'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-libcopy-'));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); }
}

function withCrossDeviceRename(run) {
  const real = fs.promises.rename;
  fs.promises.rename = async (src, dst) => {
    const err = new Error(`EXDEV: cross-device link not permitted, rename '${src}' -> '${dst}'`);
    err.code = 'EXDEV';
    throw err;
  };
  return Promise.resolve().then(run).finally(() => { fs.promises.rename = real; });
}

(async () => {
  await check('one volume: a rename, reported whole', async () => {
    const src = path.join(WORK, 'a.m4b');
    const dest = path.join(WORK, 'a-dest.m4b');
    fs.writeFileSync(src, Buffer.alloc(1234, 7));
    const seen = [];
    await bridge.copyIntoLibrary(src, dest, (n) => seen.push(n));
    assert.ok(!fs.existsSync(src) && fs.statSync(dest).size === 1234);
    assert.deepStrictEqual(seen, [1234]);
  });

  await check('across volumes: one streamed copy, byte-exact, progress as it goes, source removed after', async () => {
    const src = path.join(WORK, 'b.m4b');
    const dest = path.join(WORK, 'b-dest.m4b');
    const payload = Buffer.alloc(20 * 1024 * 1024 + 99);
    for (let i = 0; i < payload.length; i += 4096) payload[i] = i % 251;
    fs.writeFileSync(src, payload);
    const seen = [];
    await withCrossDeviceRename(() => bridge.copyIntoLibrary(src, dest, (n) => seen.push(n)));
    assert.ok(fs.readFileSync(dest).equals(payload), 'the library holds the same bytes');
    assert.ok(!fs.existsSync(src), 'the local copy is gone only once the library has it');
    assert.ok(seen.length >= 2, `progress was reported during the copy (${seen.length} reports)`);
    assert.strictEqual(seen[seen.length - 1], payload.length);
  });

  await check('a copy that fails leaves the local file and no partial', async () => {
    const src = path.join(WORK, 'c.m4b');
    fs.writeFileSync(src, Buffer.alloc(4096, 1));
    // A destination whose folder does not exist: the write stream fails.
    const dest = path.join(WORK, 'no-such-folder', 'c.m4b');
    await assert.rejects(withCrossDeviceRename(() => bridge.copyIntoLibrary(src, dest, () => {})));
    assert.ok(fs.existsSync(src), 'the built file survives');
    assert.ok(!fs.existsSync(dest), 'nothing half-written is left');
    // And NOTHING HOLDS IT: a failed copy must not leave a read handle on the
    // staged audiobook (a bare pipe did). Deleting it and then its folder only
    // works on Windows once every handle is closed.
    await new Promise((r) => setTimeout(r, 250));
    const probe = path.join(WORK, 'probe');
    fs.mkdirSync(probe);
    fs.renameSync(src, path.join(probe, 'c.m4b'));
    fs.rmSync(probe, { recursive: true });
    assert.ok(!fs.existsSync(probe), 'the source is released');
  });

  await check('staging is built locally, beside the render scratch — never under the output folder', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'reassembly-bridge.ts'), 'utf8');
    assert.ok(/stagingDir = path\.join\(narratorScratchRoot\(\), 'assembly-staging'/.test(src));
    assert.ok(!/path\.join\(config\.outputDir, `\.staging-\$\{jobId\}`\)/.test(src));
    assert.ok(/name: 'library', label: 'Copying into the library'/.test(src), 'and the copy has its own bar');
  });

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed`);
  fs.rmSync(WORK, { recursive: true, force: true });
  if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exitCode = 1; }
})();
