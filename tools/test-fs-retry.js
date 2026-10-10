/**
 * Keeper for electron/fs-retry.ts — the one rename policy.
 *
 *   node tools/test-fs-retry.js      (after tsc -p tsconfig.electron.json)
 *
 *  - a holder that lets go (EPERM twice, as measured on the library's share on
 *    2026-10-10: ~0.1 s) is waited out, async and sync alike;
 *  - a directory renamed onto one that exists is an ANSWER, not a holder, and is
 *    thrown at once rather than after the whole budget;
 *  - an error that is not a holder (ENOENT) is thrown at once.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const retry = require(path.resolve(__dirname, '..', 'dist', 'electron', 'fs-retry.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-retry-'));
  const to = path.join(dir, 'product.json');
  fs.writeFileSync(to, 'old');
  fs.writeFileSync(`${to}.partial`, 'new');
  return { dir, from: `${to}.partial`, to };
}

/** fs.renameSync refusing EPERM `times` times, then the real one. */
function holder(times) {
  const real = fs.renameSync;
  let refused = 0;
  fs.renameSync = (a, b) => {
    if (refused < times) {
      refused += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return real(a, b);
  };
  return { refused: () => refused, restore: () => { fs.renameSync = real; } };
}

(async () => {
  console.log('fs-retry');

  await test('a holder that lets go is waited out (async)', async () => {
    const { from, to } = scratch();
    const h = holder(2);
    try { await retry.renameWithRetry(from, to); } finally { h.restore(); }
    assert.strictEqual(h.refused(), 2);
    assert.strictEqual(fs.readFileSync(to, 'utf8'), 'new');
  });

  await test('a holder that lets go is waited out (sync)', () => {
    const { from, to } = scratch();
    const h = holder(2);
    try { retry.renameSyncWithRetry(from, to); } finally { h.restore(); }
    assert.strictEqual(h.refused(), 2);
    assert.strictEqual(fs.readFileSync(to, 'utf8'), 'new');
  });

  await test('a directory onto one that exists is an answer, thrown at once', async () => {
    const { dir } = scratch();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'keep'), 'x');
    const started = Date.now();
    await assert.rejects(() => retry.renameWithRetry(a, b));
    assert.throws(() => retry.renameSyncWithRetry(a, b));
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms — it waited out the budget`);
  });

  await test('an error that is not a holder is thrown at once', async () => {
    const { dir } = scratch();
    const started = Date.now();
    await assert.rejects(() => retry.renameWithRetry(path.join(dir, 'missing'), path.join(dir, 'x')), /ENOENT/);
    assert.ok(Date.now() - started < 500);
  });

  console.log(`\nfs-retry: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
