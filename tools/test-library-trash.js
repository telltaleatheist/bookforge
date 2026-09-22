#!/usr/bin/env node
/**
 * DISCARDING A LIBRARY TREE IS A RENAME; THE UNLINKS COME LATER, SLOWLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-library-trash.js
 *
 * The finding (2026-09-21, measured on the live library): the library is ONE
 * shared tree on a NAS reached over SMB by both machines, and a project delete
 * — `fs.promises.rm(projectDir, {recursive:true})` in `manifest-service` —
 * issued 2,694 unlinks in 28 s (~96 metadata operations a second). The Mac's
 * SMB client stalled mid-burst and every process touching the share went into
 * uninterruptible wait until a reboot. Twice in two days.
 *
 * So `electron/library-trash.ts` owns every removal of a tree that lives in the
 * library: ONE rename into `<libraryRoot>/.trash` — which IS the delete, the
 * moment it returns — and then a paced background drain at 40 unlinks a second.
 * This suite defends the four things that make that safe:
 *
 *   the rename-aside shape   the tree leaves in one operation, intact
 *   the refusals             outside the library / the root itself / already trash
 *   the pace                 never more than N operations in any one second
 *   weather and the grace    a share that goes away PAUSES rather than failing,
 *                            and an entry the other machine may still be
 *                            publishing is left to settle
 *
 * Real filesystem, temp dirs only. No network, no library, no GPU. The clock,
 * the sleeps and — where a fault is needed — unlink are injected, so the pace
 * is asserted in milliseconds without spending them.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'library-trash.js'))) {
  console.error('dist/electron/library-trash.js is missing — compile first: '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  discardLibraryTree,
  drainLibraryTrashOnce,
  startLibraryTrashRemover,
  isInLibraryTrash,
  isHeld,
  libraryTrashDir,
  TRASH_DIR_NAME,
  DISCARD_MARKER_NAME,
  HELD_CODES,
  UNLINKS_PER_SECOND,
  SETTLE_GRACE_MS,
} = require(path.join(DIST, 'library-trash.js'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-trash-'));
process.on('exit', () => {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* temp */ }
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let libSeq = 0;
/** An empty library root, `projects/` and all. */
function makeLibrary() {
  const root = path.join(WORK, `lib-${libSeq++}`);
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  return root;
}

/** A project tree: `n` files spread over the project and two nested directories. */
function makeProject(root, slug, n) {
  const dir = path.join(root, 'projects', slug);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stages', '03-tts'), { recursive: true });
  for (let i = 0; i < n; i++) {
    const where = i % 3 === 0 ? dir
      : (i % 3 === 1 ? path.join(dir, 'source') : path.join(dir, 'stages', '03-tts'));
    fs.writeFileSync(path.join(where, `f${i}.bin`), `x${i}`);
  }
  return dir;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

function trashEntries(root) {
  try { return fs.readdirSync(path.join(root, TRASH_DIR_NAME)); } catch { return []; }
}

/** Age an entry past the settling grace instead of waiting a minute for it. */
function age(where, extraMs = 5_000) {
  const when = new Date(Date.now() - SETTLE_GRACE_MS - extraMs);
  fs.utimesSync(where, when, when);
}

/** A fake clock: `sleep` advances it, nothing waits in real time. */
function fakeClock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
}

function errno(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

const quiet = () => {};

/** `discardLibraryTree` returning just where the tree went, for the common case. */
async function discardTo(dir, reason, opts) {
  const result = await discardLibraryTree(dir, reason, opts);
  return result.trashPath;
}

async function refusal(fn, needle) {
  try {
    await fn();
  } catch (err) {
    assert.ok(String(err.message).includes(needle),
      `the refusal should name "${needle}": ${err.message}`);
    return;
  }
  assert.fail(`expected a refusal naming "${needle}"`);
}

// ── The rename-aside shape ──────────────────────────────────────────────────

test('a discard takes the tree out of the library in ONE rename, intact', async () => {
  const root = makeLibrary();
  const dir = makeProject(root, 'Book_-_Author_1999', 9);
  const where = await discardTo(dir, 'a test delete', { libraryRoot: root, log: quiet });

  assert.ok(where, 'the discard answers where the tree went');
  assert.strictEqual(fs.existsSync(dir), false, 'the project is gone from projects/');
  assert.strictEqual(path.dirname(where), path.join(root, TRASH_DIR_NAME));
  assert.ok(path.basename(where).startsWith('Book_-_Author_1999-'),
    `the trash name keeps the basename: ${path.basename(where)}`);
  // Every file travelled: a rename moves the tree, it does not copy part of it.
  assert.strictEqual(countFiles(where), 9);
  // Windows-safe: the ISO stamp's colons and dots are replaced.
  assert.ok(!/:/.test(path.basename(where)), 'no colons in the trash name');
});

test('.trash is created on first use, and two discards of one name cannot collide', async () => {
  const root = makeLibrary();
  assert.strictEqual(fs.existsSync(path.join(root, TRASH_DIR_NAME)), false);

  const first = await discardTo(
    makeProject(root, 'Same', 2), 'first', { libraryRoot: root, log: quiet });
  const second = await discardTo(
    makeProject(root, 'Same', 2), 'second', { libraryRoot: root, log: quiet });

  assert.notStrictEqual(first, second, 'the 6 hex keep two discards of one name apart');
  assert.strictEqual(trashEntries(root).length, 2);
});

test('discarding something that is not there answers null, not an error', async () => {
  const root = makeLibrary();
  const answer = await discardLibraryTree(
    path.join(root, 'projects', 'never-existed'), 'a race with the other machine',
    { libraryRoot: root, log: quiet });
  assert.strictEqual(answer.found, false);
  assert.strictEqual(answer.trashPath, null);
  assert.strictEqual(answer.markedInPlace, false);
});

// ── The refusals, each by name ──────────────────────────────────────────────

test('a path outside the library is refused by name, and nothing is touched', async () => {
  const root = makeLibrary();
  const elsewhere = path.join(WORK, `outsider-${libSeq}`);
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'mine');

  await refusal(
    () => discardLibraryTree(elsewhere, 'a mistake', { libraryRoot: root, log: quiet }),
    'not inside the library');
  assert.ok(fs.existsSync(path.join(elsewhere, 'keep.txt')));
});

test('the library root ITSELF is refused, with its own sentence', async () => {
  const root = makeLibrary();
  await refusal(
    () => discardLibraryTree(root, 'a catastrophe', { libraryRoot: root, log: quiet }),
    'the library folder itself');
  assert.ok(fs.existsSync(path.join(root, 'projects')));
});

test('a path already in .trash is refused — the remover owns it', async () => {
  const root = makeLibrary();
  const where = await discardTo(
    makeProject(root, 'Once', 2), 'first', { libraryRoot: root, log: quiet });
  await refusal(
    () => discardLibraryTree(where, 'again', { libraryRoot: root, log: quiet }),
    `already in ${TRASH_DIR_NAME}`);
  assert.ok(fs.existsSync(where), 'and it is still there for the remover');
});

test('isInLibraryTrash answers for the trash dir and everything under it', async () => {
  const root = makeLibrary();
  assert.strictEqual(isInLibraryTrash(libraryTrashDir(root), root), true);
  assert.strictEqual(isInLibraryTrash(path.join(root, TRASH_DIR_NAME, 'x', 'y'), root), true);
  assert.strictEqual(isInLibraryTrash(path.join(root, 'projects', 'x'), root), false);
});

// ── The drain, and the pace ────────────────────────────────────────────────

test('a drain removes a discarded tree whole and reports its file count', async () => {
  const root = makeLibrary();
  await discardTo(
    makeProject(root, 'Drained', 12), 'a test delete', { libraryRoot: root, log: quiet });

  const clock = fakeClock();
  const report = await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
  });

  assert.strictEqual(report.removed.length, 1);
  assert.strictEqual(report.removed[0].files, 12);
  assert.strictEqual(report.weather, null);
  assert.strictEqual(trashEntries(root).length, 0, '.trash is empty afterwards');
});

test('the pace is never exceeded in any one-second window', async () => {
  const root = makeLibrary();
  await discardTo(
    makeProject(root, 'Paced', 40), 'a test delete', { libraryRoot: root, log: quiet });

  const clock = fakeClock();
  const stamps = [];
  await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, graceMs: 0, opsPerSecond: 10,
    now: clock.now, sleep: clock.sleep,
    unlink: async (p) => { stamps.push(clock.now()); await fs.promises.unlink(p); },
    rmdir: async (p) => { stamps.push(clock.now()); await fs.promises.rmdir(p); },
  });

  assert.strictEqual(stamps.length, 44, 'every file AND every directory is one operation');
  for (const at of stamps) {
    const window = stamps.filter((t) => t > at - 1000 && t <= at);
    assert.ok(window.length <= 10,
      `${window.length} operations landed in the second ending at ${at} — the cap is 10`);
  }
  // And it took the time the pace implies, rather than racing through.
  assert.ok(stamps[stamps.length - 1] - stamps[0] >= 4_000,
    '44 operations at 10/s cannot finish inside 4 seconds');
});

test('the shipped pace stays well under the burst that wedged the client', async () => {
  // 2,694 unlinks in 28 s is ~96/s. The number is stated, not derived, so this
  // is the check that nobody quietly raised it back toward the wedge.
  assert.strictEqual(UNLINKS_PER_SECOND, 40);
  assert.ok(UNLINKS_PER_SECOND < 96 / 2, 'the pace must stay under half the wedging rate');
});

// ── Both machines drain the same .trash ────────────────────────────────────

test('a file that vanishes under foot (ENOENT) is skipped, not a failure', async () => {
  const root = makeLibrary();
  await discardTo(
    makeProject(root, 'Shared', 6), 'a test delete', { libraryRoot: root, log: quiet });

  const clock = fakeClock();
  let n = 0;
  const report = await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
    unlink: async (p) => {
      await fs.promises.unlink(p);
      // The other machine's remover got this one a moment earlier.
      if (++n === 3) throw errno('ENOENT', 'no such file or directory, unlink');
    },
  });

  assert.strictEqual(report.removed.length, 1, 'the tree still went');
  assert.strictEqual(report.weather, null);
  assert.strictEqual(trashEntries(root).length, 0);
});

// ── Weather pauses, it never fails ─────────────────────────────────────────

test('the share going away pauses the drain, and the next pass finishes it', async () => {
  const root = makeLibrary();
  await discardTo(
    makeProject(root, 'Weathered', 10), 'a test delete', { libraryRoot: root, log: quiet });

  const clock = fakeClock();
  let stormy = true;
  let gone = 0;
  const deps = {
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
    unlink: async (p) => {
      if (stormy && gone >= 3) throw errno('EIO', 'i/o error, unlink');
      gone++;
      await fs.promises.unlink(p);
    },
  };

  const first = await drainLibraryTrashOnce(deps);
  assert.notStrictEqual(first.weather, null, 'weather is REPORTED, not thrown');
  assert.strictEqual(first.removed.length, 0, 'a tree that did not finish is not claimed');
  assert.strictEqual(trashEntries(root).length, 1, 'it stays in .trash, part-removed');

  stormy = false;
  const second = await drainLibraryTrashOnce(deps);
  assert.strictEqual(second.weather, null);
  assert.strictEqual(second.removed.length, 1, 'the next pass takes it up where it stopped');
  assert.strictEqual(trashEntries(root).length, 0);
});

test('a .trash that does not exist is not an error', async () => {
  const root = makeLibrary();
  const report = await drainLibraryTrashOnce({ libraryRoot: root, log: quiet, graceMs: 0 });
  assert.deepStrictEqual(report.removed, []);
  assert.strictEqual(report.weather, null);
});

// ── The settling grace ─────────────────────────────────────────────────────

test('an entry younger than the grace is left alone', async () => {
  const root = makeLibrary();
  await discardTo(
    makeProject(root, 'JustLanded', 4), 'a test delete', { libraryRoot: root, log: quiet });

  const report = await drainLibraryTrashOnce({ libraryRoot: root, log: quiet });
  assert.strictEqual(report.settling, 1, 'it is counted as settling');
  assert.strictEqual(report.removed.length, 0);
  assert.strictEqual(trashEntries(root).length, 1, 'and untouched');
  assert.strictEqual(SETTLE_GRACE_MS, 60_000);
});

test('the same entry goes once the grace has passed', async () => {
  const root = makeLibrary();
  const where = await discardTo(
    makeProject(root, 'Settled', 4), 'a test delete', { libraryRoot: root, log: quiet });
  age(where);

  const clock = fakeClock(Date.now());
  const report = await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, now: clock.now, sleep: clock.sleep,
  });
  assert.strictEqual(report.settling, 0);
  assert.strictEqual(report.removed.length, 1);
});

test('oldest first: a backlog drains in the order it filled', async () => {
  const root = makeLibrary();
  const where = [];
  for (const slug of ['First', 'Second', 'Third']) {
    where.push(await discardTo(
      makeProject(root, slug, 2), 'a test delete', { libraryRoot: root, log: quiet }));
  }
  // Written deliberately: three renames in the same millisecond would otherwise
  // be ordered by name, which is not what the rule says.
  const base = Date.now() - SETTLE_GRACE_MS - 60_000;
  where.forEach((entry, i) => {
    const when = new Date(base + i * 10_000);
    fs.utimesSync(entry, when, when);
  });

  const clock = fakeClock(Date.now());
  const report = await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, now: clock.now, sleep: clock.sleep,
  });
  assert.deepStrictEqual(
    report.removed.map((r) => r.name.split('-')[0]), ['First', 'Second', 'Third']);
});

// ── The folder that will not move: an open file over SMB ───────────────────
//
// Measured 2026-09-21: Owen deleted a project while macOS QuickLook had its
// archive PDF memory-mapped from a Finder preview. Over SMB an open file cannot
// be unlinked, so the client silly-renamed it to `archive/.smbdeleteAAA34f44.4`
// (smbd holds a read lease on it) and `fs.rm` failed
// `ENOTEMPTY: directory not empty, rmdir '.../archive'` — the user was told
// "Couldn't delete 1 item". Samba refuses to RENAME a directory with an open
// file below it the same way (NT_STATUS_ACCESS_DENIED → EACCES/EPERM), so the
// rename-aside meets the same wall. None of it is a failure: it all stops being
// true when the holder closes the file.

/** A `.smbdelete*` stand-in: present, and refusing to be unlinked. */
function sillyDelete(dir, name = '.smbdeleteAAA34f44.4') {
  fs.writeFileSync(path.join(dir, name), 'held');
  return name;
}

test('every held-open errno is retried, not reported', async () => {
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EEXIST']) {
    assert.ok(HELD_CODES.includes(code), `${code} must be a holder`);
    assert.strictEqual(isHeld(errno(code, 'x')), true);
  }
  assert.strictEqual(isHeld(errno('ENOSPC', 'no space')), false, 'a real answer is not a holder');
});

test('a rename refused by an open file marks the tree in place and still succeeds', async () => {
  const root = makeLibrary();
  const dir = makeProject(root, 'Previewed', 5);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"projectId":"Previewed"}');

  // Samba's answer when QuickLook holds a file below: the directory will not move.
  const realRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (path.resolve(from) === path.resolve(dir)) throw errno('EACCES', 'permission denied, rename');
    return realRename(from, to);
  };
  let result;
  try {
    result = await discardLibraryTree(dir, 'deleting the project Previewed',
      { libraryRoot: root, log: quiet });
  } finally {
    fs.promises.rename = realRename;
  }

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.markedInPlace, true, 'it was marked, not moved');
  assert.strictEqual(result.trashPath, null);
  assert.ok(result.note && result.note.includes('still open in another program'),
    `the caller gets a sentence to show: ${result.note}`);
  assert.ok(fs.existsSync(path.join(dir, DISCARD_MARKER_NAME)), 'the marker is written');

  const marker = JSON.parse(fs.readFileSync(path.join(dir, DISCARD_MARKER_NAME), 'utf-8'));
  assert.strictEqual(marker.reason, 'deleting the project Previewed');
  assert.ok(marker.discardedAt && marker.by, 'the press is recorded with a time and a machine');
  // No half-written marker left beside it.
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((n) => n.includes('.tmp')), [],
    'the marker is written through a temp name and a rename');
});

test('the remover drains a marked tree, and moves it the moment it is released', async () => {
  const root = makeLibrary();
  const dir = makeProject(root, 'Marked', 7);
  fs.writeFileSync(path.join(dir, DISCARD_MARKER_NAME),
    JSON.stringify({ reason: 'a test delete', discardedAt: new Date().toISOString(), by: 'mac' }));

  const clock = fakeClock();
  const report = await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
  });

  // Released by the time the remover looked: one rename, then it drains as
  // an ordinary `.trash` entry on the next pass.
  assert.strictEqual(fs.existsSync(dir), false, 'the marked project left projects/');
  assert.strictEqual(report.weather, null);

  const second = await drainLibraryTrashOnce({
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
  });
  assert.strictEqual(second.removed.length, 1);
  assert.strictEqual(trashEntries(root).length, 0);
});

test('a .smbdelete* leftover is retried, not treated as a failure', async () => {
  const root = makeLibrary();
  const dir = makeProject(root, 'Held', 4);
  fs.writeFileSync(path.join(dir, DISCARD_MARKER_NAME),
    JSON.stringify({ reason: 'a test delete', discardedAt: new Date().toISOString(), by: 'mac' }));
  const silly = sillyDelete(dir);

  const clock = fakeClock();
  let released = false;
  const deps = {
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
    unlink: async (p) => {
      if (!released && path.basename(p) === silly) {
        throw errno('EACCES', 'permission denied, unlink');
      }
      await fs.promises.unlink(p);
    },
    rmdir: async (p) => {
      if (!released && path.resolve(p) === path.resolve(dir)) {
        throw errno('ENOTEMPTY', "directory not empty, rmdir '" + dir + "'");
      }
      await fs.promises.rmdir(p);
    },
  };

  const realRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (!released && path.resolve(from) === path.resolve(dir)) {
      throw errno('EACCES', 'permission denied, rename');
    }
    return realRename(from, to);
  };

  let first;
  try {
    first = await drainLibraryTrashOnce(deps);
  } finally {
    fs.promises.rename = realRename;
  }

  assert.strictEqual(first.weather, null, 'a holder is not weather and not an error');
  assert.strictEqual(first.removed.length, 0, 'the tree is not claimed as removed');
  assert.deepStrictEqual(first.held, [path.join('projects', 'Held')],
    'it is reported as held, by name');
  assert.ok(fs.existsSync(path.join(dir, DISCARD_MARKER_NAME)),
    'the marker stays, so nothing lists the project and nothing calls it a stray');
  assert.ok(fs.existsSync(path.join(dir, silly)), 'the held file is still there');
  // Everything that COULD go, went.
  assert.strictEqual(countFiles(dir), 2, 'only the marker and the held file are left');

  // QuickLook closes; the stand-in disappears; the next pass finishes the job.
  released = true;
  fs.unlinkSync(path.join(dir, silly));
  const second = await drainLibraryTrashOnce(deps);
  assert.strictEqual(second.weather, null);
  assert.strictEqual(fs.existsSync(dir), false, 'the folder is gone on the retry');
});

// ── Stopping ───────────────────────────────────────────────────────────────

test('a stop lands between files and leaves a recoverable half-removed tree', async () => {
  const root = makeLibrary();
  await discardTo(
    makeProject(root, 'Interrupted', 12), 'a test delete', { libraryRoot: root, log: quiet });

  const clock = fakeClock();
  let removed = 0;
  let stopAfter = 4;
  let stop = false;
  const deps = {
    libraryRoot: root, log: quiet, graceMs: 0, now: clock.now, sleep: clock.sleep,
    stopped: () => stop,
    unlink: async (p) => { await fs.promises.unlink(p); if (++removed >= stopAfter) stop = true; },
  };

  const first = await drainLibraryTrashOnce(deps);
  assert.strictEqual(first.stopped, true, 'the pass says it stopped');
  assert.strictEqual(first.removed.length, 0, 'a part-removed tree is not claimed as removed');
  assert.strictEqual(trashEntries(root).length, 1,
    'it is still in .trash — already out of the library, which is the point');

  // The next start: nothing stops it this time.
  stop = false;
  stopAfter = Infinity;
  const second = await drainLibraryTrashOnce(deps);
  assert.strictEqual(second.removed.length, 1, 'the next start finishes it');
  assert.ok(removed > 4, 'and it removed the files the first pass did not reach');
  assert.strictEqual(trashEntries(root).length, 0);
});

test('the background remover drains what it was given, and stop() resolves', async () => {
  const root = makeLibrary();
  const where = await discardTo(
    makeProject(root, 'Background', 6), 'a test delete', { libraryRoot: root, log: quiet });
  age(where);

  const handle = startLibraryTrashRemover({
    libraryRoot: root, log: quiet, opsPerSecond: 100_000,
    sleep: async () => { /* a keeper does not wait in real time */ },
  });
  for (let i = 0; i < 500 && trashEntries(root).length > 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  await handle.stop();
  assert.strictEqual(trashEntries(root).length, 0, 'the loop drained it');
});

// ── Run ────────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push(`${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
    }
  }
  console.log(`library-trash: ${passed}/${tests.length} passed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
})();
