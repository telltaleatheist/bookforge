#!/usr/bin/env node
/**
 * Tests for the CROSS-MACHINE manifest lock (electron/library-lock.ts).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-library-lock.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * Owen's library lives on a Samba share both the PC and the Mac mount, and both
 * machines' BookForge instances write it (ruling 2026-08-17). The one dangerous
 * operation is a manifest read-modify-write racing between machines: the last
 * writer silently discards the other's registration. The lock is an exclusive-
 * create `.manifest.lock` beside the manifest — the only primitive a plain
 * filesystem gives us that is atomic over SMB.
 *
 * The claims:
 *
 *  1. A held lock makes a second writer WAIT, and both writes land — proven
 *     with a real second PROCESS, because the in-process promise chain would
 *     mask an on-disk lock that did nothing.
 *  2. A refused wait REFUSES — deadline passed, error names the holder, and
 *     the file on disk is untouched.
 *  3. A STALE lock (a crash's leftovers) is taken over, not waited on forever.
 *  4. The lock is released when the work throws — the next writer proceeds.
 *  5. `modifyManifest` takes it end to end: while a foreign process holds the
 *     lock file, `modifyManifest` does not write until it clears.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LOCK_MODULE = path.join(REPO, 'dist', 'electron', 'library-lock.js');
const MANIFEST_MODULE = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
for (const m of [LOCK_MODULE, MANIFEST_MODULE]) {
  if (!fs.existsSync(m)) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}
const { withManifestFileLock, configureLibraryLock } = require(LOCK_MODULE);
const manifestService = require(MANIFEST_MODULE);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-library-lock-'));
const LOCK_NAME = '.manifest.lock';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  // Every test restores production-shaped (but fast) timings first, so one
  // test's shortened deadline cannot leak into the next.
  configureLibraryLock({ timeoutMs: 5_000, staleMs: 60_000, retryMs: 25 });
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function freshDir(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A second real process that takes the lock file with exclusive create, holds
 * it for `holdMs`, then unlinks it. Resolves once the child HAS the lock, so
 * the test body races against a lock that is genuinely held.
 */
function foreignHolder(dir, holdMs) {
  const script = `
    const fs = require('fs');
    const p = process.argv[1];
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, JSON.stringify({ host: 'foreign-box', pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    console.log('HELD');
    setTimeout(() => { fs.unlinkSync(p); process.exit(0); }, ${holdMs});
  `;
  const child = spawn(process.execPath, ['-e', script, path.join(dir, LOCK_NAME)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('HELD')) resolve(child); });
    child.on('error', reject);
    child.on('exit', (code) => { if (code !== 0) reject(new Error(`holder exited ${code} before HELD`)); });
  });
}

(async () => {
  console.log('library-lock:');

  await test('a lock held by another PROCESS makes the writer wait, and both writes land', async () => {
    const dir = freshDir('wait');
    const file = path.join(dir, 'value.txt');
    fs.writeFileSync(file, 'from-foreign');
    await foreignHolder(dir, 300);
    const t0 = Date.now();
    await withManifestFileLock(dir, async () => {
      // read-modify-write against what the foreign process left behind
      const seen = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(file, seen + '+ours');
    });
    const waited = Date.now() - t0;
    assert.ok(waited >= 250, `must actually wait for the holder (waited ${waited}ms)`);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'from-foreign+ours');
    assert.ok(!fs.existsSync(path.join(dir, LOCK_NAME)), 'released on the way out');
  });

  await test('a deadline passed is a REFUSAL that names the holder, and nothing runs', async () => {
    const dir = freshDir('refuse');
    configureLibraryLock({ timeoutMs: 200, staleMs: 60_000, retryMs: 25 });
    fs.writeFileSync(path.join(dir, LOCK_NAME),
      JSON.stringify({ host: 'other-machine', pid: 1234, at: new Date().toISOString() }));
    let ran = false;
    await assert.rejects(
      withManifestFileLock(dir, async () => { ran = true; }),
      /other-machine[\s\S]*Nothing was written/,
    );
    assert.strictEqual(ran, false, 'the refused work must never have started');
    assert.ok(fs.existsSync(path.join(dir, LOCK_NAME)), 'a refusal does not steal the lock');
  });

  await test('a STALE lock is taken over instead of waited on', async () => {
    const dir = freshDir('stale');
    configureLibraryLock({ timeoutMs: 5_000, staleMs: 100, retryMs: 25 });
    const lockPath = path.join(dir, LOCK_NAME);
    fs.writeFileSync(lockPath, JSON.stringify({ host: 'crashed-box', pid: 9, at: '2026-01-01T00:00:00Z' }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    let ran = false;
    await withManifestFileLock(dir, async () => { ran = true; });
    assert.strictEqual(ran, true);
    assert.ok(!fs.existsSync(lockPath), 'the dead process’s lock is gone');
  });

  await test('a throw inside releases the lock for the next writer', async () => {
    const dir = freshDir('throw');
    await assert.rejects(
      withManifestFileLock(dir, async () => { throw new Error('the work failed'); }),
      /the work failed/,
    );
    assert.ok(!fs.existsSync(path.join(dir, LOCK_NAME)), 'released despite the throw');
    let ran = false;
    await withManifestFileLock(dir, async () => { ran = true; });
    assert.strictEqual(ran, true);
  });

  await test('modifyManifest waits out a foreign holder end to end', async () => {
    // A real project under a library root, the way every other keeper builds one.
    const libraryRoot = freshDir('library');
    fs.mkdirSync(path.join(libraryRoot, 'projects'), { recursive: true });
    manifestService.setLibraryBasePath(libraryRoot);
    const projectId = 'Locked_Book_-_Test_(2026)';
    const projectDir = path.join(libraryRoot, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({
      version: 2, projectId, source: { type: 'ebook', path: 'archive/x.epub' },
      metadata: { title: 'Locked Book' }, createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    }, null, 2));

    await foreignHolder(projectDir, 300);
    const t0 = Date.now();
    const result = await manifestService.modifyManifest(projectId, (m) => {
      m.metadata.title = 'Locked Book, Renamed';
    });
    const waited = Date.now() - t0;
    assert.strictEqual(result.success, true, result.error);
    assert.ok(waited >= 250, `modifyManifest must have waited for the foreign lock (waited ${waited}ms)`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf-8'));
    assert.strictEqual(onDisk.metadata.title, 'Locked Book, Renamed');
    assert.ok(!fs.existsSync(path.join(projectDir, LOCK_NAME)), 'released after the write');
  });

  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(`\nlibrary-lock: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
    process.exit(1);
  }
})();
