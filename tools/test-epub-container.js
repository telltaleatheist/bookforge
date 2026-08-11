#!/usr/bin/env node
/**
 * Tests for the EPUB CONTAINER SEAM — electron/epub-container.ts and the tree
 * identity beside it (`epubTreeSha256` in electron/sidecar-binding.ts).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-epub-container.js
 *
 * ── What this seam is for ───────────────────────────────────────────────────
 *
 * Measured on `Dietrich Bonhoeffer - A Biography…working.epub` (2026-08-11):
 * changing one chapter LABEL — 84 KB of markup — re-deflated a 25.7 MB archive,
 * re-hashed it, minted a new cache identity off the moved bytes, and re-composed
 * a 25.7 MB stamped copy. Ten edits in four minutes left ~340 MB of cache. The
 * layout was never the slow part; the zip-as-identity was.
 *
 * So the working copy becomes an exploded DIRECTORY, and this file is the seam
 * that makes that flip mechanical. Nothing routes through it yet — phase 1 is
 * deliberately no behaviour change — which is exactly why it has to be tested on
 * its own terms now, before any call site depends on it being right.
 *
 * WHAT IS ASSERTED, and why each is a way the flip could be silently wrong:
 *
 * A TREE AND ITS ZIP ARE THE SAME BOOK — same entry names, same bytes, entry for
 * entry. If that equivalence does not hold, every consumer above the seam (spine
 * parse, layout, narration keys) reads a different book depending on which
 * container it happened to be handed, and nothing downstream would say so.
 *
 * `mimetype` COMES FIRST out of a tree, because a directory has no order and half
 * the rewrite sites in this app do `for (const e of source.getEntries())
 * sink.addFile(e, …)`. Sorted alphabetically, lowercase `mimetype` lands LAST,
 * and the `.tts.epub` minted from that tree would be an OCF violation that
 * strict readers refuse — discovered, if ever, in ebook2audiobook.
 *
 * AN UNCHANGED ENTRY IS NOT REWRITTEN, because that single property IS the win.
 * A rewrite loop that touched all 79 entries would be the 25.7 MB again with
 * extra steps, and it would look like it worked.
 *
 * A WRITE IS THE WHOLE BOOK, because `ZipWriter.write()` is: an entry that was
 * not added is not in the archive. A tree that kept members of books past would
 * drift from the zip semantics every call site was written against.
 *
 * THE TREE HASH IS CANONICAL — stable, order-independent, and moving the moment
 * one entry's bytes move. Identity is what a cache is keyed by and what a
 * snapshot is proved with; an identity that depended on readdir order would
 * differ between two machines holding the identical book.
 *
 * NAMES THAT CANNOT BE FILES ARE REFUSED, LOUDLY — traversal, absolute names,
 * backslashes, and the Windows device names (CLAUDE.md: NUL/CON/PRN/AUX/COM1-9/
 * LPT1-9). A tree that silently dropped an entry it could not write would be a
 * book missing a chapter with nothing anywhere saying so.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
for (const file of ['epub-container.js', 'epub-processor.js', 'sidecar-binding.js']) {
  if (!fs.existsSync(path.join(DIST, file))) {
    console.error(`Compile first: npx tsc -p tsconfig.electron.json (missing dist/electron/${file})`);
    process.exit(1);
  }
}

const {
  DirectoryEpubSource,
  DirectoryEpubSink,
  openEpubSource,
  createEpubSink,
  epubContainerKindAt,
  listEpubTreeEntries,
  orderEpubEntryNames,
  removeEpubContainer,
  resolveEpubEntryPath,
  rewriteEpubEntries,
} = require(path.join(DIST, 'epub-container.js'));
const {
  ZipReader,
  ZipWriter,
  replaceChapterTextsInEpub,
  updateEpubMetadataStandalone,
} = require(path.join(DIST, 'epub-processor.js'));
const { epubTreeSha256 } = require(path.join(DIST, 'sidecar-binding.js'));

// ── the fixture ─────────────────────────────────────────────────────────────
//
// A small but honest EPUB: the stored `mimetype`, the container, an OPF, two
// spine documents, an image with real binary bytes (so "same bytes" is not just
// a UTF-8 round trip), and a nested resource two directories deep — the depth an
// exploded tree adds over the archive it came from.
const BOOK = [
  ['mimetype', Buffer.from('application/epub+zip', 'utf8')],
  ['META-INF/container.xml', Buffer.from(
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>'
    + '</rootfiles></container>', 'utf8')],
  ['EPUB/content.opf', Buffer.from('<?xml version="1.0"?><package version="3.0"><manifest/></package>', 'utf8')],
  ['EPUB/text/c0001.xhtml', Buffer.from('<html><body><p>Chapter one.</p></body></html>', 'utf8')],
  ['EPUB/text/c0002.xhtml', Buffer.from('<html><body><p>Chapter two.</p></body></html>', 'utf8')],
  ['EPUB/images/plate-01.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x01])],
  ['EPUB/styles/nested/deep/print.css', Buffer.from('body { margin: 0 }', 'utf8')],
];

let scratch = null;
function tmp(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The fixture written as a real ZIP, through the writer the app actually uses. */
async function writeFixtureZip(outPath) {
  const writer = new ZipWriter();
  for (const [name, data] of BOOK) writer.addFile(name, data, name !== 'mimetype');
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await writer.write(outPath);
  return outPath;
}

/** The fixture written as a tree, by hand — NOT through the sink under test. */
function writeFixtureTree(dir, entries = BOOK) {
  for (const [name, data] of entries) {
    const abs = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
  return dir;
}

function mtimesOf(dir) {
  const seen = new Map();
  const walk = (at, prefix) => {
    for (const dirent of fs.readdirSync(at, { withFileTypes: true })) {
      const name = `${prefix}${dirent.name}`;
      if (dirent.isDirectory()) walk(path.join(at, dirent.name), `${name}/`);
      else seen.set(name, fs.statSync(path.join(at, dirent.name)).mtimeMs);
    }
  };
  walk(dir, '');
  return seen;
}

/** Freeze every file's mtime well in the past, so any rewrite is unmistakable. */
function ageEverything(dir, when = new Date('2020-01-01T00:00:00Z')) {
  for (const name of [...mtimesOf(dir).keys()]) {
    fs.utimesSync(path.join(dir, ...name.split('/')), when, when);
  }
}

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A tree and its zip are the same book
// ─────────────────────────────────────────────────────────────────────────────

test('a tree yields the same entry NAMES as the zip of it', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('same-names'), 'book.epub'));
  const treeDir = writeFixtureTree(tmp('same-names-tree'));

  const zip = new ZipReader(zipPath);
  await zip.open();
  const tree = new DirectoryEpubSource(treeDir);
  await tree.open();
  try {
    assert.deepStrictEqual(
      [...tree.getEntries()].sort(),
      [...zip.getEntries()].sort(),
      'the tree and the archive do not hold the same set of entries'
    );
    assert.strictEqual(tree.getEntries().length, BOOK.length);
  } finally {
    zip.close();
    tree.close();
  }
});

test('a tree yields the same BYTES as the zip of it, entry for entry', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('same-bytes'), 'book.epub'));
  const treeDir = writeFixtureTree(tmp('same-bytes-tree'));

  const zip = new ZipReader(zipPath);
  await zip.open();
  const tree = new DirectoryEpubSource(treeDir);
  await tree.open();
  try {
    for (const name of zip.getEntries()) {
      const fromZip = await zip.readEntry(name);
      const fromTree = await tree.readEntry(name);
      assert.ok(
        fromZip.equals(fromTree),
        `${name} differs between the archive and the tree `
        + `(${fromZip.length} vs ${fromTree.length} bytes)`
      );
    }
    // …including the binary one, which a UTF-8 round trip would have mangled.
    const png = await tree.readEntry('EPUB/images/plate-01.png');
    assert.ok(png.equals(BOOK.find(([n]) => n.endsWith('.png'))[1]), 'the image bytes moved');
  } finally {
    zip.close();
    tree.close();
  }
});

test('hasEntry agrees with the zip, both ways', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('has-entry'), 'book.epub'));
  const treeDir = writeFixtureTree(tmp('has-entry-tree'));
  const zip = new ZipReader(zipPath);
  await zip.open();
  const tree = new DirectoryEpubSource(treeDir);
  await tree.open();
  try {
    for (const name of ['mimetype', 'EPUB/text/c0002.xhtml', 'EPUB/text/c0009.xhtml', 'EPUB']) {
      assert.strictEqual(tree.hasEntry(name), zip.hasEntry(name), `hasEntry disagrees for ${name}`);
    }
    // `EPUB` is a directory in the tree and is not an entry in either container.
    assert.strictEqual(tree.hasEntry('EPUB'), false);
  } finally {
    zip.close();
    tree.close();
  }
});

test('a missing entry fails the same way it does in a zip', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('missing'), 'book.epub'));
  const treeDir = writeFixtureTree(tmp('missing-tree'));
  const zip = new ZipReader(zipPath);
  await zip.open();
  const tree = new DirectoryEpubSource(treeDir);
  await tree.open();
  try {
    let fromZip = null;
    let fromTree = null;
    try { await zip.readEntry('EPUB/text/nope.xhtml'); } catch (err) { fromZip = err.message; }
    try { await tree.readEntry('EPUB/text/nope.xhtml'); } catch (err) { fromTree = err.message; }
    assert.strictEqual(fromZip, 'Entry not found: EPUB/text/nope.xhtml');
    assert.strictEqual(fromTree, fromZip, 'the tree refuses a missing entry in different words');
  } finally {
    zip.close();
    tree.close();
  }
});

test('mimetype is listed FIRST out of a tree, or the zip minted from it is invalid', async () => {
  const treeDir = writeFixtureTree(tmp('order'));
  const tree = new DirectoryEpubSource(treeDir);
  await tree.open();
  try {
    assert.strictEqual(tree.getEntries()[0], 'mimetype',
      `mimetype is not first: ${tree.getEntries().slice(0, 3).join(', ')}`);
    // Sorted alphabetically it would be LAST — that is the trap this guards.
    assert.notStrictEqual([...tree.getEntries()].sort()[0], 'mimetype');
    // Everything after it is deterministic, which is what makes a tree hashable.
    const rest = tree.getEntries().slice(1);
    assert.deepStrictEqual(rest, [...rest].sort(), 'the rest of the listing is not sorted');
  } finally {
    tree.close();
  }
});

test('a source that was never opened refuses rather than reporting an empty book', async () => {
  const tree = new DirectoryEpubSource(tmp('unopened'));
  assert.throws(() => tree.getEntries(), /not open/i);
  await assert.rejects(() => tree.readEntry('mimetype'), /not open/i);
});

test('a directory that is not there is a refusal, not an empty book', async () => {
  const tree = new DirectoryEpubSource(path.join(scratch, 'no-such-tree'));
  await assert.rejects(() => tree.open(), /ENOENT|no such file/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// The sink: an unchanged entry costs nothing
// ─────────────────────────────────────────────────────────────────────────────

test('an entry whose bytes are unchanged is NOT rewritten — the whole point', async () => {
  const treeDir = writeFixtureTree(tmp('no-rewrite'));
  ageEverything(treeDir);
  const before = mtimesOf(treeDir);

  // The shape every rewrite site in this app has: read every entry, swap one,
  // write every entry back.
  const sink = new DirectoryEpubSink(treeDir);
  for (const [name, data] of BOOK) {
    const swapped = name === 'EPUB/text/c0001.xhtml'
      ? Buffer.from('<html><body><p>Chapter one, renamed.</p></body></html>', 'utf8')
      : data;
    sink.addFile(name, swapped, name !== 'mimetype');
  }
  await sink.write(treeDir);

  const report = sink.lastWrite();
  assert.deepStrictEqual(report.written, ['EPUB/text/c0001.xhtml'],
    `more than the edited entry was written: ${report.written.join(', ')}`);
  assert.strictEqual(report.unchanged.length, BOOK.length - 1);
  assert.deepStrictEqual(report.removed, []);

  const after = mtimesOf(treeDir);
  for (const [name, mtime] of before) {
    if (name === 'EPUB/text/c0001.xhtml') {
      assert.notStrictEqual(after.get(name), mtime, 'the edited entry was not actually written');
    } else {
      assert.strictEqual(after.get(name), mtime, `${name} was rewritten and did not need to be`);
    }
  }
  assert.strictEqual(
    fs.readFileSync(path.join(treeDir, 'EPUB', 'text', 'c0001.xhtml'), 'utf8'),
    '<html><body><p>Chapter one, renamed.</p></body></html>'
  );
});

test('a write that changes nothing at all writes nothing at all', async () => {
  const treeDir = writeFixtureTree(tmp('idempotent'));
  ageEverything(treeDir);
  const before = mtimesOf(treeDir);

  const sink = new DirectoryEpubSink(treeDir);
  for (const [name, data] of BOOK) sink.addFile(name, data);
  await sink.write(treeDir);

  assert.deepStrictEqual(sink.lastWrite().written, []);
  assert.strictEqual(sink.lastWrite().bytesWritten, 0);
  assert.deepStrictEqual([...mtimesOf(treeDir)].sort(), [...before].sort(),
    'a no-op write still touched files');
});

test('an entry that was not added is REMOVED, as a re-written zip would not hold it', async () => {
  const treeDir = writeFixtureTree(tmp('removal'));
  const sink = new DirectoryEpubSink(treeDir);
  for (const [name, data] of BOOK) {
    if (name === 'EPUB/styles/nested/deep/print.css') continue;
    sink.addFile(name, data);
  }
  await sink.write(treeDir);

  assert.deepStrictEqual(sink.lastWrite().removed, ['EPUB/styles/nested/deep/print.css']);
  assert.ok(!fs.existsSync(path.join(treeDir, 'EPUB', 'styles', 'nested', 'deep', 'print.css')));
  // The directories the dropped entry lived in go with it — a tree that kept
  // empty scaffolding would not compare equal to the book it is supposed to be.
  assert.ok(!fs.existsSync(path.join(treeDir, 'EPUB', 'styles')), 'emptied directories were kept');
  assert.ok(fs.existsSync(path.join(treeDir, 'EPUB', 'text', 'c0001.xhtml')), 'it took a sibling with it');
});

test('a sink written into an empty place produces the same book as the zip', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('mint'), 'book.epub'));
  const treeDir = tmp('mint-tree');
  const sink = new DirectoryEpubSink(treeDir);
  for (const [name, data] of BOOK) sink.addFile(name, data, name !== 'mimetype');
  await sink.write(treeDir);
  assert.strictEqual(sink.lastWrite().written.length, BOOK.length);

  const zip = new ZipReader(zipPath);
  await zip.open();
  const tree = new DirectoryEpubSource(treeDir);
  await tree.open();
  try {
    assert.deepStrictEqual([...tree.getEntries()].sort(), [...zip.getEntries()].sort());
    for (const name of zip.getEntries()) {
      assert.ok((await zip.readEntry(name)).equals(await tree.readEntry(name)), `${name} differs`);
    }
  } finally {
    zip.close();
    tree.close();
  }
});

test('the same entry added twice is refused, not silently collapsed', async () => {
  const sink = new DirectoryEpubSink(tmp('dup'));
  sink.addFile('EPUB/text/c0001.xhtml', Buffer.from('a'));
  assert.throws(() => sink.addFile('EPUB/text/c0001.xhtml', Buffer.from('b')), /twice/);
});

test('a sink asked to write somewhere other than its own directory refuses', async () => {
  const sink = new DirectoryEpubSink(tmp('bound'));
  sink.addFile('mimetype', Buffer.from('application/epub+zip'));
  await assert.rejects(() => sink.write(tmp('bound-elsewhere')), /bound to its directory|asked to write/);
});

test('a sink pointed at an existing FILE refuses instead of deleting it', async () => {
  const dir = tmp('file-in-the-way');
  const inTheWay = path.join(dir, 'book.epub');
  fs.writeFileSync(inTheWay, 'not a directory');
  const sink = new DirectoryEpubSink(inTheWay);
  sink.addFile('mimetype', Buffer.from('application/epub+zip'));
  await assert.rejects(() => sink.write(inTheWay), /is a file/);
  assert.strictEqual(fs.readFileSync(inTheWay, 'utf8'), 'not a directory', 'it removed the file anyway');
});

test('asking what a write cost before any write refuses rather than reporting zero', () => {
  const sink = new DirectoryEpubSink(tmp('unwritten'));
  assert.throws(() => sink.lastWrite(), /has not been written/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Names that cannot become files
// ─────────────────────────────────────────────────────────────────────────────

test('a traversing entry name is refused, at add time, by name', () => {
  const root = tmp('traversal');
  const sink = new DirectoryEpubSink(root);
  assert.throws(() => sink.addFile('../escaped.xhtml', Buffer.from('x')), /path segment|traversing/);
  assert.throws(() => sink.addFile('EPUB/../../escaped.xhtml', Buffer.from('x')), /path segment|traversing/);
  assert.throws(() => resolveEpubEntryPath(root, '/etc/passwd'), /absolute/);
  assert.throws(() => resolveEpubEntryPath(root, 'C:/Windows/system.ini'), /absolute/);
  assert.throws(() => resolveEpubEntryPath(root, 'EPUB\\text\\c1.xhtml'), /backslash/);
  assert.throws(() => resolveEpubEntryPath(root, ''), /Empty/);
});

test('a Windows device name is refused rather than becoming an unwritable file', () => {
  const root = tmp('devices');
  for (const name of ['NUL', 'EPUB/text/CON.xhtml', 'aux/thing.png', 'EPUB/COM1']) {
    assert.throws(() => resolveEpubEntryPath(root, name), /reserves|device/i,
      `${name} was not refused`);
  }
  assert.doesNotThrow(() => resolveEpubEntryPath(root, 'EPUB/text/console.xhtml'),
    'a name that merely starts with a device name was refused');
});

test('a path component past the filesystem cap is refused by name, not as an ENOENT', () => {
  const root = tmp('long');
  assert.throws(() => resolveEpubEntryPath(root, `EPUB/text/${'a'.repeat(256)}.xhtml`), /component/);
  assert.doesNotThrow(() => resolveEpubEntryPath(root, `EPUB/text/${'a'.repeat(200)}.xhtml`));
});

// ─────────────────────────────────────────────────────────────────────────────
// The factories
// ─────────────────────────────────────────────────────────────────────────────

test('the factory chooses by what the path IS, and names the kind', async () => {
  const dir = tmp('factory');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  const treeDir = writeFixtureTree(path.join(dir, 'book.working'));

  assert.strictEqual(await epubContainerKindAt(zipPath), 'zip');
  assert.strictEqual(await epubContainerKindAt(treeDir), 'directory');
  assert.strictEqual(await epubContainerKindAt(path.join(dir, 'absent')), null);

  const fromZip = await openEpubSource(zipPath);
  const fromTree = await openEpubSource(treeDir);
  try {
    assert.ok(fromZip instanceof ZipReader, 'a file did not open as a ZIP');
    assert.ok(fromTree instanceof DirectoryEpubSource, 'a directory did not open as a tree');
    // Already open: the factory hands back a source that is ready to read.
    assert.deepStrictEqual([...fromZip.getEntries()].sort(), [...fromTree.getEntries()].sort());
  } finally {
    fromZip.close();
    fromTree.close();
  }
});

test('opening something that is not there says so, and says where', async () => {
  await assert.rejects(() => openEpubSource(path.join(scratch, 'nothing-here.epub')),
    /No EPUB at .*nothing-here\.epub/);
});

test('a directory that cannot be read as a book says it was a DIRECTORY', async () => {
  const dir = tmp('bad-tree');
  fs.symlinkSync(path.join(dir, 'absent-target'), path.join(dir, 'link.xhtml'), 'file');
  await assert.rejects(() => openEpubSource(dir), /is a directory and could not be read/);
});

test('a file that is not a zip says it was a FILE', async () => {
  const junk = path.join(tmp('bad-zip'), 'book.epub');
  fs.writeFileSync(junk, 'this is not an archive');
  await assert.rejects(() => openEpubSource(junk), /is a file and could not be read as a ZIP/);
});

test('the sink factory writes the container it was TOLD to write', async () => {
  const dir = tmp('sink-factory');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  const treeDir = writeFixtureTree(path.join(dir, 'book.working'));
  assert.ok(await createEpubSink(zipPath, 'zip') instanceof ZipWriter);
  assert.ok(await createEpubSink(treeDir, 'directory') instanceof DirectoryEpubSink);
  // A path that is not there yet needs no guess — the caller said which.
  assert.ok(await createEpubSink(path.join(dir, 'fresh.epub'), 'zip') instanceof ZipWriter);
  assert.ok(await createEpubSink(path.join(dir, 'fresh.working'), 'directory')
    instanceof DirectoryEpubSink);
});

test('the name never decides the container: a staging file named .epub can be a tree', async () => {
  // The real case this protects: book-chapters.ts stages a retitle as
  // `retitle-<sha>.epub` and lands it on the book. When the book is a TREE, an
  // extension-driven factory would silently write a zip there.
  const dir = tmp('sink-name-lies');
  const staged = path.join(dir, 'retitle-abc123.epub');
  assert.ok(await createEpubSink(staged, 'directory') instanceof DirectoryEpubSink);
});

test('a sink may not change what a path already is', async () => {
  const dir = tmp('sink-conflict');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  const treeDir = writeFixtureTree(path.join(dir, 'book.working'));
  await assert.rejects(() => createEpubSink(zipPath, 'directory'),
    /is already a file, but it was asked for as an exploded directory/);
  await assert.rejects(() => createEpubSink(treeDir, 'zip'),
    /is already an exploded directory, but it was asked for as a ZIP/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tree identity
// ─────────────────────────────────────────────────────────────────────────────

test('the tree hash is stable across two runs of the same tree', async () => {
  const treeDir = writeFixtureTree(tmp('stable'));
  const first = await epubTreeSha256(treeDir);
  const second = await epubTreeSha256(treeDir);
  assert.strictEqual(first.sha256, second.sha256);
  assert.strictEqual(first.entryCount, BOOK.length);
  assert.strictEqual(first.size, BOOK.reduce((sum, [, data]) => sum + data.length, 0));
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
});

test('the tree hash MOVES when one entry\'s bytes move — by one byte', async () => {
  const treeDir = writeFixtureTree(tmp('one-byte'));
  const before = await epubTreeSha256(treeDir);
  const abs = path.join(treeDir, 'EPUB', 'text', 'c0002.xhtml');
  fs.writeFileSync(abs, '<html><body><p>Chapter twe.</p></body></html>');
  const after = await epubTreeSha256(treeDir);
  assert.notStrictEqual(after.sha256, before.sha256, 'an edited chapter did not move the identity');
  assert.strictEqual(after.entryCount, before.entryCount);
});

test('the tree hash moves when an entry is added or dropped', async () => {
  const treeDir = writeFixtureTree(tmp('membership'));
  const before = await epubTreeSha256(treeDir);
  fs.writeFileSync(path.join(treeDir, 'EPUB', 'text', 'c0003.xhtml'), '<html/>');
  const added = await epubTreeSha256(treeDir);
  assert.notStrictEqual(added.sha256, before.sha256);
  fs.rmSync(path.join(treeDir, 'EPUB', 'text', 'c0003.xhtml'));
  assert.strictEqual((await epubTreeSha256(treeDir)).sha256, before.sha256,
    'putting the tree back did not put the identity back');
});

test('the tree hash does not depend on the order the filesystem hands entries over', async () => {
  // Two trees, the same book, written in opposite orders.
  const forwards = writeFixtureTree(tmp('order-a'), BOOK);
  const backwards = writeFixtureTree(tmp('order-b'), [...BOOK].reverse());
  assert.strictEqual(
    (await epubTreeSha256(forwards)).sha256,
    (await epubTreeSha256(backwards)).sha256,
    'creation order changed the identity'
  );

  // And, independently of what readdir happens to do on this machine: the digest
  // is recomputed here from a SHUFFLED entry list. If the listing inside were not
  // sorted, this could not match.
  const shuffled = [...BOOK];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (i * 7 + 3) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const canonical = [...shuffled]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, data]) => `${name}\0${crypto.createHash('sha256').update(data).digest('hex')}\n`)
    .join('');
  const expected = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  assert.strictEqual((await epubTreeSha256(forwards)).sha256, expected,
    'the digest is not sha256 over the canonical sorted `<name>\\0<sha256>\\n` listing');
});

test('a tree hash of something that is not a directory is a refusal', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('not-a-tree'), 'book.epub'));
  await assert.rejects(() => epubTreeSha256(zipPath), /Not a directory/);
});

test('listEpubTreeEntries and orderEpubEntryNames are the one listing', async () => {
  const treeDir = writeFixtureTree(tmp('listing'));
  const names = await listEpubTreeEntries(treeDir);
  assert.deepStrictEqual(names, orderEpubEntryNames(BOOK.map(([n]) => n)));
  assert.deepStrictEqual(orderEpubEntryNames(['b', 'mimetype', 'a']), ['mimetype', 'a', 'b']);
  assert.deepStrictEqual(orderEpubEntryNames(['b', 'a']), ['a', 'b']);
});

// ─────────────────────────────────────────────────────────────────────────────
// The rewrite — phase 2a
//
// Every edit in this app now has one shape: `rewriteEpubEntries` opens the book,
// `build` walks its entries into a sink swapping what changed, and the SINK
// lands its own container. The twenty hand-rolled `path + '.tmp'` + rename
// dances that used to sit at each call site are gone, and this section is what
// says the zip still comes out a zip without them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a ZIP's FIRST local file header off the raw bytes.
 *
 * Not through `ZipReader` — the reader is order-blind, and the two things OCF
 * requires of an EPUB (`mimetype` first, and STORED rather than deflated) are
 * both properties of the byte layout that a reader would happily hide.
 */
function firstZipMember(zipPath) {
  const bytes = fs.readFileSync(zipPath);
  assert.strictEqual(bytes.readUInt32LE(0), 0x04034b50, 'the file does not begin with a local file header');
  const nameLength = bytes.readUInt16LE(26);
  return {
    name: bytes.toString('utf8', 30, 30 + nameLength),
    compressionMethod: bytes.readUInt16LE(8),
  };
}

/** Every entry of a zip as `name → bytes`, through the reader the app uses. */
async function readZipEntries(zipPath) {
  const reader = await openEpubSource(zipPath);
  try {
    const out = new Map();
    for (const name of reader.getEntries()) out.set(name, await reader.readEntry(name));
    return out;
  } finally {
    reader.close();
  }
}

/** Every file sitting beside a book — a stray `.tmp` is a staging that leaked. */
function siblingsOf(bookPath) {
  return fs.readdirSync(path.dirname(bookPath)).sort();
}

test('an in-place rewrite of a ZIP book lands a byte-valid EPUB', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('inplace-zip'), 'book.epub'));
  const before = await readZipEntries(zipPath);

  await rewriteEpubEntries({
    from: zipPath,
    to: zipPath,
    toKind: 'zip',
    build: async (source, sink) => {
      for (const name of source.getEntries()) {
        const data = name === 'EPUB/text/c0001.xhtml'
          ? Buffer.from('<html><body><p>Chapter one, renamed.</p></body></html>', 'utf8')
          : await source.readEntry(name);
        sink.addFile(name, data, name !== 'mimetype');
      }
    },
  });

  const after = await readZipEntries(zipPath);
  assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort(),
    'the rewrite changed which entries the book has');
  for (const [name, data] of after) {
    if (name === 'EPUB/text/c0001.xhtml') {
      assert.strictEqual(data.toString('utf8'), '<html><body><p>Chapter one, renamed.</p></body></html>');
    } else {
      assert.ok(data.equals(before.get(name)), `${name} came through the rewrite different`);
    }
  }
});

test('an in-place rewrite keeps `mimetype` FIRST and STORED', async () => {
  const zipPath = await writeFixtureZip(path.join(tmp('inplace-ocf'), 'book.epub'));
  await rewriteEpubEntries({
    from: zipPath,
    to: zipPath,
    toKind: 'zip',
    build: async (source, sink) => {
      for (const name of source.getEntries()) {
        sink.addFile(name, await source.readEntry(name), name !== 'mimetype');
      }
    },
  });
  const first = firstZipMember(zipPath);
  assert.strictEqual(first.name, 'mimetype', 'mimetype is not the first member of the archive');
  assert.strictEqual(first.compressionMethod, 0, 'mimetype was deflated; OCF requires it stored');
});

test('the WRITER keeps mimetype stored and first, however the caller adds it', async () => {
  // The two sites that copy a book entry by entry (copyEpubReplaceBodies,
  // replaceChapterTextsInEpub) called addFile(name, data) with no compress
  // argument and took the `true` default, so every book they wrote carried a
  // DEFLATED mimetype — invalid per OCF, refused by strict readers, and
  // invisible through ZipReader, which is order- and method-blind. Fixing those
  // two callers would leave the next one free to make the same mistake, so the
  // invariant belongs to the writer. Here the caller does BOTH wrong things at
  // once: adds mimetype last, and asks for it compressed.
  const zipPath = path.join(tmp('writer-owns-mimetype'), 'book.epub');
  const writer = new ZipWriter();
  for (const [name, data] of BOOK) {
    if (name === 'mimetype') continue;
    writer.addFile(name, data, true);
  }
  writer.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), true);
  await writer.write(zipPath);

  const first = firstZipMember(zipPath);
  assert.strictEqual(first.name, 'mimetype',
    'mimetype was added last and the writer did not move it to the front');
  assert.strictEqual(first.compressionMethod, 0,
    'mimetype was asked for compressed and the writer obeyed; OCF requires it stored');

  // The book is otherwise untouched: same entries, same bytes.
  const back = await readZipEntries(zipPath);
  assert.strictEqual(back.size, BOOK.length);
  for (const [name, data] of BOOK) assert.ok(data.equals(back.get(name)), `${name} changed`);
});

test('an in-place rewrite leaves no staging file beside the book', async () => {
  // The sink already stages and renames; the `epubPath + '.tmp'` the call sites
  // used to add on top of that is exactly the file that gets left behind when a
  // rewrite dies part way, and is a whole DIRECTORY once the book is a tree.
  const dir = tmp('inplace-no-staging');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  await rewriteEpubEntries({
    from: zipPath,
    to: zipPath,
    toKind: 'zip',
    build: async (source, sink) => {
      for (const name of source.getEntries()) {
        sink.addFile(name, await source.readEntry(name), name !== 'mimetype');
      }
    },
  });
  assert.deepStrictEqual(siblingsOf(zipPath), ['book.epub'],
    'the rewrite left something beside the book');
});

test('the source is RELEASED before the sink lands, and says so if used after', async () => {
  // The whole reason an in-place ZIP rewrite works on Windows at all. A source
  // still holding the target is what turns the landing rename into EPERM — and
  // it is checked by shape here rather than by hoping the platform complains.
  const zipPath = await writeFixtureZip(path.join(tmp('release-first'), 'book.epub'));
  let held = null;
  await rewriteEpubEntries({
    from: zipPath,
    to: zipPath,
    toKind: 'zip',
    build: async (source, sink) => {
      held = source;
      for (const name of source.getEntries()) {
        sink.addFile(name, await source.readEntry(name), name !== 'mimetype');
      }
    },
  });
  await assert.rejects(() => held.readEntry('mimetype'), /ZIP file not open/,
    'the source was still open after the book was landed');
});

test('a rewrite that refuses part way leaves the book exactly as it was', async () => {
  const dir = tmp('rewrite-refuses');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  const before = fs.readFileSync(zipPath);

  await assert.rejects(() => rewriteEpubEntries({
    from: zipPath,
    to: zipPath,
    toKind: 'zip',
    build: async (source, sink) => {
      sink.addFile('mimetype', await source.readEntry('mimetype'), false);
      throw new Error('the pass changed its mind');
    },
  }), /the pass changed its mind/);

  assert.ok(fs.readFileSync(zipPath).equals(before), 'a refused rewrite changed the book');
  assert.deepStrictEqual(siblingsOf(zipPath), ['book.epub']);
  // And the descriptor went back: on Windows a held one makes this throw.
  fs.renameSync(zipPath, path.join(dir, 'moved.epub'));
});

test('a rewrite onto a DIFFERENT path leaves the book it read alone', async () => {
  const dir = tmp('rewrite-copy');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  const before = fs.readFileSync(zipPath);
  const outPath = path.join(dir, 'copy.epub');

  await rewriteEpubEntries({
    from: zipPath,
    to: outPath,
    toKind: 'zip',
    build: async (source, sink) => {
      for (const name of source.getEntries()) {
        sink.addFile(name, await source.readEntry(name), name !== 'mimetype');
      }
    },
  });

  assert.ok(fs.readFileSync(zipPath).equals(before), 'the source book was touched');
  assert.deepStrictEqual(
    [...(await readZipEntries(outPath)).keys()].sort(),
    [...(await readZipEntries(zipPath)).keys()].sort());
});

test('the same rewrite over a TREE writes only the entry that changed', async () => {
  // The point of the exercise, on the shared path rather than on the sink alone:
  // phase 2c changes `toKind` and nothing else, and this is the property that
  // has to fall out of that one change.
  const treeDir = writeFixtureTree(tmp('rewrite-tree'));
  ageEverything(treeDir);
  const mtimesBefore = mtimesOf(treeDir);

  const sink = await rewriteEpubEntries({
    from: treeDir,
    to: treeDir,
    toKind: 'directory',
    build: async (source, into) => {
      for (const name of source.getEntries()) {
        const data = name === 'EPUB/text/c0001.xhtml'
          ? Buffer.from('<html><body><p>Chapter one, relabelled.</p></body></html>', 'utf8')
          : await source.readEntry(name);
        into.addFile(name, data);
      }
    },
  });

  const report = sink.lastWrite();
  assert.deepStrictEqual(report.written, ['EPUB/text/c0001.xhtml']);
  assert.strictEqual(report.unchanged.length, BOOK.length - 1);
  assert.deepStrictEqual(report.removed, []);

  const mtimesAfter = mtimesOf(treeDir);
  for (const [name, was] of mtimesBefore) {
    if (name === 'EPUB/text/c0001.xhtml') continue;
    assert.strictEqual(mtimesAfter.get(name), was, `${name} was rewritten and did not need to be`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The cleanup after a refusal
// ─────────────────────────────────────────────────────────────────────────────

test('a refusal\'s cleanup removes the book it claims nothing was written to', async () => {
  // Eight refusal arms in this app end with "Nothing was written." and then
  // delete the staged book. They all called `fs.rm(path, { force: true })`,
  // which cannot remove a directory — so the moment the staged book is a tree,
  // the sentence becomes a lie and the half-written book is left for the next
  // pass to read as if it had been verified.
  const dir = tmp('refusal-cleanup');
  const asTree = writeFixtureTree(path.join(dir, 'staged.working'));
  const asZip = await writeFixtureZip(path.join(dir, 'staged.epub'));

  await assert.rejects(() => fs.promises.rm(asTree, { force: true }),
    /EISDIR|ERR_FS_EISDIR|EPERM/,
    'the OLD cleanup call silently succeeded on a directory — this test proves nothing');
  assert.ok(fs.existsSync(asTree), 'the old call removed the tree after all');

  await removeEpubContainer(asTree);
  assert.ok(!fs.existsSync(asTree), 'the staged tree survived its own refusal');

  await removeEpubContainer(asZip);
  assert.ok(!fs.existsSync(asZip), 'the staged zip survived its own refusal');

  // And a refusal that fires before anything was staged is not itself a failure.
  await removeEpubContainer(path.join(dir, 'never-existed.epub'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The restructured call sites, end to end
// ─────────────────────────────────────────────────────────────────────────────

test('updateEpubMetadataStandalone rewrites in place, valid, with nothing left over', async () => {
  const dir = tmp('metadata-in-place');
  // The shared fixture's OPF has no <metadata> for a title to land in, so this
  // one book carries a real package document. Everything else is the fixture.
  const withMetadata = BOOK.map(([name, data]) => name === 'EPUB/content.opf'
    ? [name, Buffer.from(
      '<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf">'
      + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Before</dc:title>'
      + '</metadata><manifest/><spine/></package>', 'utf8')]
    : [name, data]);
  const zipPath = path.join(dir, 'book.epub');
  {
    const writer = new ZipWriter();
    for (const [name, data] of withMetadata) writer.addFile(name, data, name !== 'mimetype');
    await writer.write(zipPath);
  }
  const before = await readZipEntries(zipPath);

  await updateEpubMetadataStandalone(zipPath, { title: 'A Renamed Book' });

  const first = firstZipMember(zipPath);
  assert.strictEqual(first.name, 'mimetype');
  assert.strictEqual(first.compressionMethod, 0);
  assert.deepStrictEqual(siblingsOf(zipPath), ['book.epub'],
    'the in-place metadata write left its staging behind');

  const after = await readZipEntries(zipPath);
  assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort());
  assert.match(after.get('EPUB/content.opf').toString('utf8'), /A Renamed Book/);
  for (const [name, data] of after) {
    if (name === 'EPUB/content.opf') continue;
    assert.ok(data.equals(before.get(name)), `${name} changed and had no business changing`);
  }
});

test('replaceChapterTextsInEpub reads the BOOK, not a duplicate of itself', async () => {
  // It used to `copyEpubFile(input → output)` and then open the COPY as both the
  // reader and the rewrite target: a full duplicate of the book whose every byte
  // was immediately read back out and written again. The source is the book.
  const dir = tmp('replace-chapters');
  const zipPath = await writeFixtureZip(path.join(dir, 'book.epub'));
  const outPath = path.join(dir, 'cleaned.epub');
  const before = fs.readFileSync(zipPath);

  const result = await replaceChapterTextsInEpub(zipPath, outPath, []);
  assert.strictEqual(result.success, true, result.error);

  assert.ok(fs.readFileSync(zipPath).equals(before), 'the input book was written to');
  assert.deepStrictEqual(siblingsOf(outPath), ['book.epub', 'cleaned.epub'],
    'the copy-then-rewrite left a staging file behind');

  const written = await readZipEntries(outPath);
  const source = await readZipEntries(zipPath);
  assert.deepStrictEqual([...written.keys()].sort(), [...source.keys()].sort());
  for (const [name, data] of written) {
    assert.ok(data.equals(source.get(name)), `${name} did not survive the rewrite intact`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-epub-container-'));
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
    // A leaked descriptor would make this fail on Windows — and did, once, which
    // is how the factory's missing `close()` on a failed open was found.
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  console.log(`\nepub-container: ${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
