#!/usr/bin/env node
/**
 * Tests for `moveIntoPlace` — electron/processing-passes.ts — now that a book is
 * about to stop always being a FILE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-artifact-movement.js
 *
 * ── Why this is touched at all ──────────────────────────────────────────────
 *
 * The working copy becomes an exploded directory (`source/<base>.working/`) so
 * that editing one chapter writes one entry instead of re-deflating 25.7 MB.
 * Every pass that rewrites a book ends at `moveIntoPlace(staged, book.absPath)`,
 * and two steps in it assumed a single file: the EPERM-retry path copied with
 * `fs.copyFile` (EISDIR on a directory) and the source was removed with
 * `unlink`. A directory also cannot be renamed ONTO a directory that already
 * exists, which is the ordinary case for a book being replaced.
 *
 * WHAT IS ASSERTED, and why:
 *
 * THE FILE CASE IS UNCHANGED, first and at length, because this is phase 1 and
 * the whole promise of phase 1 is that nothing behaves differently. A move onto
 * a fresh path, a move ONTO an existing book, a cross-directory move, and the
 * two loud failures — a source that is not there, and a staged copy that cannot
 * be landed — all have to be exactly what they were.
 *
 * THE DIRECTORY CASE WORKS AT ALL, because in phase 2 every pass ends here.
 *
 * THE DESTINATION IS NEVER HALF OF EACH BOOK, because a directory is replaced by
 * stepping the old one aside and renaming the new one in. If that swap left the
 * two merged, a book would end up holding chapters of two different versions
 * with nothing anywhere saying so.
 *
 * NOTHING IS STRANDED BESIDE THE BOOK, because a `.bookforge-tmp` or
 * `.bookforge-old` left behind is adopted by nothing and synced by everything.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'processing-passes.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { moveIntoPlace } = require(MODULE);

let scratch = null;
let caseNumber = 0;
function tmp() {
  const dir = path.join(scratch, `case-${++caseNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTree(dir, entries) {
  for (const [name, text] of Object.entries(entries)) {
    const abs = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

function readTree(dir) {
  const out = {};
  const walk = (at, prefix) => {
    for (const dirent of fs.readdirSync(at, { withFileTypes: true })) {
      if (dirent.isDirectory()) walk(path.join(at, dirent.name), `${prefix}${dirent.name}/`);
      else out[`${prefix}${dirent.name}`] = fs.readFileSync(path.join(at, dirent.name), 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

/** Nothing beside the book may claim a move was half-way. */
function assertNothingStranded(dir) {
  const strays = fs.readdirSync(dir).filter((n) => /\.bookforge-(tmp|old|entry-tmp)$/.test(n));
  assert.deepStrictEqual(strays, [], `stranded beside the book: ${strays.join(', ')}`);
}

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── the file case: unchanged, and that is the point ─────────────────────────

test('a file lands on a path where nothing is', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'staged.epub'), 'the new book');
  await moveIntoPlace(path.join(dir, 'staged.epub'), path.join(dir, 'book.epub'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'book.epub'), 'utf8'), 'the new book');
  assert.ok(!fs.existsSync(path.join(dir, 'staged.epub')), 'the staged file was left behind');
  assertNothingStranded(dir);
});

test('a file lands ONTO the book that is already there', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'book.epub'), 'the old book');
  fs.writeFileSync(path.join(dir, 'staged.epub'), 'the new book');
  await moveIntoPlace(path.join(dir, 'staged.epub'), path.join(dir, 'book.epub'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'book.epub'), 'utf8'), 'the new book');
  assert.ok(!fs.existsSync(path.join(dir, 'staged.epub')));
  assertNothingStranded(dir);
});

test('a file lands in a destination directory that does not exist yet', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'staged.epub'), 'the new book');
  const to = path.join(dir, 'source', 'nested', 'book.epub');
  await moveIntoPlace(path.join(dir, 'staged.epub'), to);
  assert.strictEqual(fs.readFileSync(to, 'utf8'), 'the new book');
});

test('a source that is not there is the same loud failure it always was', async () => {
  const dir = tmp();
  await assert.rejects(
    () => moveIntoPlace(path.join(dir, 'absent.epub'), path.join(dir, 'book.epub')),
    /ENOENT/,
    'a missing source did not fail'
  );
  assert.ok(!fs.existsSync(path.join(dir, 'book.epub')), 'it created the destination anyway');
  assertNothingStranded(dir);
});

// ── the directory case ──────────────────────────────────────────────────────

test('a tree lands on a path where nothing is', async () => {
  const dir = tmp();
  const staged = writeTree(path.join(dir, 'staged'), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one</html>',
    'EPUB/images/plate.png': 'binaryish',
  });
  const to = path.join(dir, 'book.working');
  await moveIntoPlace(staged, to);
  assert.deepStrictEqual(readTree(to), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one</html>',
    'EPUB/images/plate.png': 'binaryish',
  });
  assert.ok(!fs.existsSync(staged), 'the staged tree was left behind');
  assertNothingStranded(dir);
});

test('a tree lands ONTO the tree that is already there, and does not merge with it', async () => {
  const dir = tmp();
  // The old book has a chapter the new one does not. If the two merged, the book
  // would end up holding a chapter from a version nobody chose.
  const to = writeTree(path.join(dir, 'book.working'), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one, before</html>',
    'EPUB/text/c0099.xhtml': '<html>a chapter only the old book had</html>',
  });
  const staged = writeTree(path.join(dir, 'staged'), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one, after</html>',
  });
  await moveIntoPlace(staged, to);
  assert.deepStrictEqual(readTree(to), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one, after</html>',
  });
  assert.ok(!fs.existsSync(staged));
  assertNothingStranded(dir);
});

test('a tree lands across directories, where a rename cannot reach', async () => {
  const dir = tmp();
  const staged = writeTree(path.join(dir, 'stage', 'retitle-abc'), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one</html>',
  });
  const to = path.join(dir, 'project', 'source', 'book.working');
  await moveIntoPlace(staged, to);
  assert.deepStrictEqual(Object.keys(readTree(to)).sort(),
    ['EPUB/text/c0001.xhtml', 'mimetype']);
  assert.ok(!fs.existsSync(staged));
  assertNothingStranded(path.dirname(to));
});

test('a tree that replaces a FILE takes its place', async () => {
  // The migration shape: `source/<base>.working.epub` is a zip and the tree that
  // replaces it is written beside it. Not the naming the migration will use, but
  // the movement has to be capable of it.
  const dir = tmp();
  const to = path.join(dir, 'book.working');
  fs.writeFileSync(to, 'a zip used to be here');
  const staged = writeTree(path.join(dir, 'staged'), { 'mimetype': 'application/epub+zip' });
  await moveIntoPlace(staged, to);
  assert.ok(fs.statSync(to).isDirectory(), 'the destination is still a file');
  assert.deepStrictEqual(readTree(to), { 'mimetype': 'application/epub+zip' });
  assertNothingStranded(dir);
});

test('a FILE that replaces a tree takes its place', async () => {
  const dir = tmp();
  const to = writeTree(path.join(dir, 'book.working'), { 'mimetype': 'application/epub+zip' });
  fs.writeFileSync(path.join(dir, 'staged.epub'), 'a real zip now');
  await moveIntoPlace(path.join(dir, 'staged.epub'), to);
  assert.ok(fs.statSync(to).isFile(), 'the destination is still a directory');
  assert.strictEqual(fs.readFileSync(to, 'utf8'), 'a real zip now');
  assertNothingStranded(dir);
});

test('an empty tree is still a move, not a no-op', async () => {
  const dir = tmp();
  const staged = path.join(dir, 'staged');
  fs.mkdirSync(staged);
  const to = path.join(dir, 'book.working');
  await moveIntoPlace(staged, to);
  assert.ok(fs.statSync(to).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(to), []);
  assert.ok(!fs.existsSync(staged));
});

test('a stale sibling from a crashed move does not merge into the next one', async () => {
  const dir = tmp();
  const to = writeTree(path.join(dir, 'book.working'), { 'mimetype': 'application/epub+zip' });
  // Left behind by an earlier move that died between the copy and the landing.
  writeTree(`${to}.bookforge-tmp`, { 'EPUB/text/ghost.xhtml': '<html>a book that never was</html>' });
  const staged = writeTree(path.join(dir, 'staged'), {
    'mimetype': 'application/epub+zip',
    'EPUB/text/c0001.xhtml': '<html>one</html>',
  });
  await moveIntoPlace(staged, to);
  assert.deepStrictEqual(Object.keys(readTree(to)).sort(),
    ['EPUB/text/c0001.xhtml', 'mimetype'], 'a ghost entry came across');
  assertNothingStranded(dir);
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-artifact-movement-'));
  try {
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
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  console.log(`\nartifact-movement: ${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
