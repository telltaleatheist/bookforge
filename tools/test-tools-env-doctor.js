/**
 * Keeper for the tools env's DAMAGED case: electron/tools-env-bootstrap.ts
 * `toolsEnvIntegrity` and electron/doctor.ts `composeReport`.
 *
 *   node tools/test-tools-env-doctor.js      (after tsc -p tsconfig.electron.json)
 *
 * The integrity check used to be "the interpreter starts", so an env that could
 * not import PyMuPDF read "Installed and working", the doctor offered no Fix,
 * and the startup repair never ran. Now:
 *  - a missing interpreter is not intact, and says where it looked;
 *  - a damaged env reads BROKEN and offers the re-download when it is ours;
 *  - one somebody pointed at is broken too, but is theirs to repair;
 *  - a whole env reads ok, with nothing to fix.
 * The live check runs too when this machine has a tools env unpacked.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist', 'electron');
const { composeReport } = require(path.join(dist, 'doctor.js'));
const { toolsEnvIntegrity } = require(path.join(dist, 'tools-env-bootstrap.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
}

function envRow(integrity, configured = false) {
  const report = composeReport({
    tools: { toolsEnv: { configured, detected: true, path: 'X:/env' }, ffmpeg: { configured: false, detected: true, path: 'ffmpeg' } },
    toolsEnvIntegrity: integrity,
    components: [],
    hasManagedEnv: true,
    installableIds: [],
    externalInstallerIds: [],
  });
  return { row: report.checks.find((c) => c.id === 'tools-env'), healthy: report.healthy };
}

test('an env with no interpreter is not intact, and says where it looked', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-env-'));
  try {
    const got = toolsEnvIntegrity(empty);
    assert.strictEqual(got.ok, false);
    assert.ok(got.detail.includes(empty), got.detail);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('a damaged managed env reads broken and offers the re-download', () => {
  const { row, healthy } = envRow({ ok: false, detail: 'cannot import fitz, numpy: ModuleNotFoundError' });
  assert.strictEqual(row.state, 'broken');
  assert.strictEqual(row.fix, 'reinstall-env');
  assert.ok(row.detail.startsWith('Damaged:'), row.detail);
  assert.strictEqual(healthy, false);
});

test('a damaged env somebody pointed at is broken but not ours to re-download', () => {
  const { row } = envRow({ ok: false, detail: 'cannot import fitz' }, true);
  assert.strictEqual(row.state, 'broken');
  assert.strictEqual(row.fix, 'none');
});

test('a whole env reads ok with nothing to fix', () => {
  const { row, healthy } = envRow({ ok: true, detail: 'Installed and working.' });
  assert.strictEqual(row.state, 'ok');
  assert.strictEqual(row.fix, 'none');
  assert.strictEqual(healthy, true);
});

const appData = process.env.APPDATA;
const live = appData ? path.join(appData, 'bookforge', 'runtime', 'tools-env') : null;
if (live && fs.existsSync(path.join(live, 'python.exe'))) {
  test("this machine's tools env imports what it exists for", () => {
    const got = toolsEnvIntegrity(live);
    assert.strictEqual(got.ok, true, got.detail);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
