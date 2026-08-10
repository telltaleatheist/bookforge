#!/usr/bin/env node
/**
 * Tests for the narration strikes SURVIVING — a pass over the book, a book that
 * moved under the record, and the two things that must never happen either way.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-carry.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * Owen struck an evening of narration deletions on a book, ran the
 * footnote-reference pass, re-opened the book, and was told: "Your narration
 * deletions were cleared." Two things were wrong with that, and this file is
 * one test for each.
 *
 *  1. The pass PRESERVED every element of the book — it removes inline `<sup>`
 *     markers and repairs the one case that could shift the walk — so the
 *     strikes still named exactly what they had named. They should have been
 *     carried, and now they are: the pass proves the enumeration is unchanged
 *     and re-stamps the record in the SAME manifest transaction that records
 *     the pass.
 *
 *  2. Nothing should have been deleted in the first place. A record whose stamp
 *     no longer names the book is not evidence that the strikes are wrong; it
 *     is a reason to ask each strike for itself. So the clear is gone entirely,
 *     and a strike proves itself against the text it remembers striking.
 *
 * Every fixture is a real project under the OS temp directory with real (small)
 * EPUBs in it, and the pass is `runProcessingPass` — the same call the queue
 * makes. NOTHING in the user's library is read or written.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'processing-passes.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narration-carry-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const { ZipWriter, readEpubConversionUnits } =
  require(path.join(DIST, 'electron', 'epub-processor.js'));
const { runProcessingPass, verifyNarrationCarry } =
  require(path.join(DIST, 'electron', 'processing-passes.js'));
const narrationExport = require(path.join(DIST, 'electron', 'narration-export.js'));
const { narrationDocumentShapes } = require(path.join(DIST, 'electron', 'quire-stamp.js'));
const {
  narrationCarryRefusal,
  narrationDeletionsStaleReason,
  planNarrationRemoval,
  verifyNarrationStrikes,
} = require(path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));

/** The one working chain's book record. */
const bookRecordOf = (dir) => {
  const families = readManifest(dir).families ?? [];
  assert.strictEqual(families.length, 1, `expected one working chain, found ${families.length}`);
  return families[0].epub;
};

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A real (tiny) book, with real footnote references in it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chapter one, including the edge the footnote pass was built around: a
 * paragraph whose ENTIRE text is a marker. Stripped naively it would fall out
 * of the enumeration and shift every key after it; `keepEmptiedUnitsAudible`
 * gives it a `[break]` instead, and this fixture is what proves the carry
 * survives that.
 */
const CHAPTER_ONE = [
  'It was 1998, and the machine hummed in the corner of the room.<sup>1</sup>',
  'She counted twelve of them before the lights went out.',
  '<sup>2</sup>',
  'The third door was open, and nobody could say who had opened it.',
];
const CHAPTER_TWO = [
  'Nobody had been through it, which was the part that troubled him.<sup>3</sup>',
  'And that was the end of the matter for eleven years.',
];

async function writeEpub(outPath, chapters) {
  const docs = chapters.map((paragraphs, i) => ({
    name: `ch${i + 1}.xhtml`,
    xhtml: '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter '
      + `${i + 1}</title></head><body>`
      + paragraphs.map((p) => `<p>${p}</p>`).join('')
      + '</body></html>',
  }));
  const manifestItems = docs
    .map((d, i) => `<item id="d${i}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('');
  const spine = docs.map((_, i) => `<itemref idref="d${i}"/>`).join('');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:carry-test</dc:identifier>
<dc:title>The Carry</dc:title><dc:language>en</dc:language></metadata>
<manifest>${manifestItems}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine>${spine}</spine></package>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol>${docs
  .map((d, i) => `<li><a href="${d.name}">Chapter ${i + 1}</a></li>`).join('')}</ol></nav></body></html>`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const zw = new ZipWriter();
  zw.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zw.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zw.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zw.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  for (const d of docs) zw.addFile(`OEBPS/${d.name}`, Buffer.from(d.xhtml, 'utf8'));
  await zw.write(outPath);
  return outPath;
}

const projectsDir = path.join(ROOT, 'projects');
manifestService.setLibraryBasePath(ROOT);

async function makeProject(id, chapters = [CHAPTER_ONE, CHAPTER_TWO]) {
  const dir = path.join(projectsDir, id);
  await writeEpub(path.join(dir, 'archive', 'The Carry.epub'), chapters);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    projectId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    modifiedAt: '2026-08-01T00:00:00.000Z',
    metadata: { title: 'The Carry' },
    source: { type: 'epub', originalFilename: 'The Carry.epub' },
    archive: [{ path: 'archive/The Carry.epub', role: 'original', format: 'epub' }],
    outputs: {},
  }, null, 2));
  await manifestService.ensureBookEpub(dir);
  return dir;
}

/** Run the footnote-reference pass exactly as the queue runs it. */
async function runFootnoteRefs(dir) {
  const stageRelDir = await manifestService.nextPassStageRelDir(dir, 'footnote-refs');
  return runProcessingPass('job-carry', { kind: 'footnote-refs', projectDir: dir, stageRelDir }, null);
}

const STRIKES = ['OEBPS/ch1.xhtml#1', 'OEBPS/ch2.xhtml#1'];

/**
 * Chapter one with two paragraphs taken out of the middle — the synthetic
 * "restructuring pass". `OEBPS/ch1.xhtml#1` then names the LAST paragraph
 * instead of the second, which is exactly the silent wrong cut this whole
 * mechanism exists to stop.
 */
const RESTRUCTURED_ONE = [CHAPTER_ONE[0], CHAPTER_ONE[3]];

// ─────────────────────────────────────────────────────────────────────────────
// 1. The pass carries the strikes
// ─────────────────────────────────────────────────────────────────────────────

test('the footnote-reference pass carries the strikes onto the book it writes', async () => {
  const dir = await makeProject('carry-footnote-refs');
  const before = await manifestService.readExportEpub(dir);
  const beforeSha = sha256(before.absPath);

  const struck = await narrationExport.editNarrationDeletions(
    dir, { strike: STRIKES, unstrike: [] });
  assert.deepStrictEqual(struck.elements, STRIKES);
  assert.strictEqual(struck.epubSha256, beforeSha);
  // Struck through the real door, so the fingerprints come off the real book.
  assert.ok(struck.fingerprints, 'a strike recorded no fingerprint');
  assert.ok(/She counted twelve of them/.test(struck.fingerprints['OEBPS/ch1.xhtml#1']),
    `the fingerprint is not the paragraph: ${struck.fingerprints['OEBPS/ch1.xhtml#1']}`);

  const result = await runFootnoteRefs(dir);
  assert.ok(result.success, `the pass failed: ${result.error}`);
  assert.strictEqual(result.narrationCarryNote, undefined,
    `the carry was refused: ${result.narrationCarryNote}`);

  const book = await manifestService.readExportEpub(dir);
  const afterSha = sha256(book.absPath);
  assert.notStrictEqual(afterSha, beforeSha, 'the pass did not change the book');

  const carried = await manifestService.readNarrationDeletions(dir);
  assert.ok(carried, 'THE FAILURE: the strikes were cleared by a pass that changed no element');
  assert.deepStrictEqual(carried.elements, STRIKES, 'a strike was dropped');
  assert.strictEqual(carried.epubSha256, afterSha, 'the record was not re-stamped');
  assert.strictEqual(narrationDeletionsStaleReason(carried, afterSha), null,
    'the carried record still reads as stale');
});

test('the carried record still resolves against the book, strike for strike', async () => {
  const dir = await makeProject('carry-resolves');
  await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });
  assert.ok((await runFootnoteRefs(dir)).success);

  const book = await manifestService.readExportEpub(dir);
  const record = await manifestService.readNarrationDeletions(dir);
  const units = await readEpubConversionUnits(book.absPath);
  const plan = planNarrationRemoval(units, record.elements, record.fingerprints);
  assert.deepStrictEqual(plan.remove.sort(), [...STRIKES].sort(),
    'a carried strike no longer names an element of the book');
  assert.deepStrictEqual(plan.unverifiable, [],
    'a carried strike lost its fingerprint on the way across');

  // And the fingerprints describe the book they now name, not the one they came
  // from: the pass re-read them off the file it wrote.
  const checked = verifyNarrationStrikes(units, record.elements, record.fingerprints);
  assert.deepStrictEqual(checked.mismatched, [],
    'the carried fingerprints describe a book nobody has');
  assert.deepStrictEqual(checked.verified.sort(), [...STRIKES].sort());
});

test('the narration copy still cuts what was struck before the pass', async () => {
  const dir = await makeProject('carry-cuts');
  await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });
  assert.ok((await runFootnoteRefs(dir)).success);

  const written = await narrationExport.exportNarrationEpub(dir);
  assert.strictEqual(written.removedElements, STRIKES.length,
    'the copy was cut by a different number of strikes than were recorded');
  assert.deepStrictEqual(written.unverifiableStrikes, [],
    'the cut could not check a strike it should have been able to');
});

test('a pass on a book with NO strikes records the pass and nothing else', async () => {
  const dir = await makeProject('carry-nothing');
  const result = await runFootnoteRefs(dir);
  assert.ok(result.success, `the pass failed: ${result.error}`);
  assert.strictEqual(result.narrationCarryNote, undefined);
  assert.strictEqual(bookRecordOf(dir).narrationDeletions, undefined,
    'a record was invented for a book nobody struck');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A rewrite that DOES move an element
// ─────────────────────────────────────────────────────────────────────────────

test('a rewrite that removes a unit REFUSES the carry, and says which file', async () => {
  const dir = await makeProject('carry-refused');
  await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });

  const book = await manifestService.readExportEpub(dir);
  // The synthetic pass: chapter one loses a paragraph, so every key after it
  // names the element one further on. This is what a genuinely restructuring
  // pass looks like to the walk.
  const restructured = path.join(dir, 'stages', 'synthetic.epub');
  await writeEpub(restructured, [RESTRUCTURED_ONE, CHAPTER_TWO]);

  const verdict = await verifyNarrationCarry(dir, book.absPath, restructured);
  assert.strictEqual(verdict.outcome, 'refused', 'a unit removal was carried anyway');
  assert.ok(/ch1\.xhtml/.test(verdict.reason), `the refusal names no file: ${verdict.reason}`);
  assert.ok(/4 element\(s\) before the pass and holds 2/.test(verdict.reason),
    `the refusal does not say what moved: ${verdict.reason}`);
});

test('a refused carry LEAVES the record — it is the user\'s, not the pass\'s', async () => {
  const dir = await makeProject('carry-refused-keeps');
  const struck = await narrationExport.editNarrationDeletions(
    dir, { strike: STRIKES, unstrike: [] });

  // The book is rewritten under the record without a pass at all — which is
  // also what Syncthing carrying a manifest and a book across two machines a
  // few seconds apart looks like from here.
  const book = await manifestService.readExportEpub(dir);
  await writeEpub(book.absPath, [RESTRUCTURED_ONE, CHAPTER_TWO]);

  const state = await narrationExport.readNarrationState(dir);
  assert.ok(state.deletions, 'THE FAILURE: reading the state deleted the user\'s strikes');
  assert.deepStrictEqual(state.deletions.elements, STRIKES);
  assert.strictEqual(state.deletions.epubSha256, struck.epubSha256,
    'the record was silently re-stamped onto a book nobody proved anything about');
  assert.ok(state.staleReason, 'the user was not told the book had changed');
  assert.ok(!/cleared/i.test(state.staleReason),
    `the warning still claims a clear: ${state.staleReason}`);

  // On disk, too: the read is a read.
  assert.ok(await manifestService.readNarrationDeletions(dir),
    'the record was cleared on disk by a read');
});

test('a shifted strike is surfaced BY NAME, with both texts', async () => {
  const dir = await makeProject('carry-mismatch');
  await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });
  const book = await manifestService.readExportEpub(dir);
  await writeEpub(book.absPath, [RESTRUCTURED_ONE, CHAPTER_TWO]);

  const state = await narrationExport.readNarrationState(dir);
  const shifted = state.mismatched.find((m) => m.key === 'OEBPS/ch1.xhtml#1');
  assert.ok(shifted, 'the strike whose paragraph moved was not reported');
  assert.ok(/She counted twelve of them/.test(shifted.struck),
    `it does not say what was struck: ${shifted.struck}`);
  assert.ok(/The third door was open/.test(shifted.nowSays),
    `it does not say what that position says now: ${shifted.nowSays}`);
  // Chapter two was not touched, so its strike still names what it named.
  assert.deepStrictEqual(state.mismatched.map((m) => m.key), ['OEBPS/ch1.xhtml#1']);
  assert.deepStrictEqual(state.unverifiable, []);
});

test('a shifted strike does NOT get cut, and the refusal names it', async () => {
  const dir = await makeProject('carry-mismatch-cut');
  await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });
  const book = await manifestService.readExportEpub(dir);
  await writeEpub(book.absPath, [RESTRUCTURED_ONE, CHAPTER_TWO]);

  await assert.rejects(
    () => narrationExport.exportNarrationEpub(dir),
    (err) => /OEBPS\/ch1\.xhtml#1 was struck on/.test(err.message)
      && /nothing was cleared/i.test(err.message),
    'a strike that names a different paragraph was applied anyway');

  assert.ok(await manifestService.readNarrationDeletions(dir),
    'the refused cut cleared the record it refused');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The two shapes an older record comes in
// ─────────────────────────────────────────────────────────────────────────────

test('a record with NO fingerprints keeps working, and says it cannot be checked', async () => {
  const dir = await makeProject('carry-legacy');
  const book = await manifestService.readExportEpub(dir);
  // The shape a record written before Aug 2026 has: keys, a stamp, no prints.
  await manifestService.writeNarrationDeletions(dir, {
    epubSha256: sha256(book.absPath), elements: STRIKES, updatedAt: '2026-07-01T00:00:00.000Z',
  });

  // Stamp still matches: the fast path certifies it and nothing is owed.
  const fresh = await narrationExport.readNarrationState(dir);
  assert.strictEqual(fresh.staleReason, null);
  assert.deepStrictEqual(fresh.unverifiable, []);
  const written = await narrationExport.exportNarrationEpub(dir);
  assert.strictEqual(written.removedElements, STRIKES.length);
  assert.deepStrictEqual(written.unverifiableStrikes, [],
    'the fast path reported strikes it did not need to check');

  // Now the book moves. The record survives, the strikes still apply, and the
  // one thing that is said out loud is that nothing could check them.
  await writeEpub(book.absPath, [RESTRUCTURED_ONE, CHAPTER_TWO]);
  const stale = await narrationExport.readNarrationState(dir);
  assert.ok(stale.deletions, 'a record with no fingerprints was cleared');
  assert.ok(/recorded before BookForge remembered what each strike struck/.test(stale.staleReason),
    stale.staleReason);
  assert.deepStrictEqual(stale.mismatched, [], 'nothing can be mismatched with no print to compare');
  assert.deepStrictEqual(stale.unverifiable.sort(), [...STRIKES].sort());

  // And the cut still happens. An unfingerprinted strike is the user's strike;
  // there is no evidence against it, and refusing it would be the guillotine
  // again wearing a smaller hat. What the cut owes is to SAY so.
  const cut = await narrationExport.exportNarrationEpub(dir);
  assert.strictEqual(cut.removedElements, STRIKES.length);
  assert.deepStrictEqual(cut.unverifiableStrikes.sort(), [...STRIKES].sort());
});

test('the sha fast path reads no text at all', async () => {
  const dir = await makeProject('carry-fastpath');
  await narrationExport.editNarrationDeletions(dir, { strike: STRIKES, unstrike: [] });
  const state = await narrationExport.readNarrationState(dir);
  assert.strictEqual(state.staleReason, null, 'a fresh record read as stale');
  assert.deepStrictEqual(state.mismatched, []);
  assert.deepStrictEqual(state.unverifiable, []);

  // And the plan, asked the fast-path way, applies everything without looking.
  const book = await manifestService.readExportEpub(dir);
  const units = await readEpubConversionUnits(book.absPath);
  const plan = planNarrationRemoval(units, STRIKES);
  assert.deepStrictEqual(plan.remove.sort(), [...STRIKES].sort());
  assert.deepStrictEqual(plan.unverifiable, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. One transaction
// ─────────────────────────────────────────────────────────────────────────────

test('the re-stamp and the pass record land in ONE manifest write', async () => {
  const dir = await makeProject('carry-transaction');
  const book = await manifestService.readExportEpub(dir);
  const fromSha256 = sha256(book.absPath);
  await manifestService.writeNarrationDeletions(dir, {
    epubSha256: fromSha256, elements: STRIKES, updatedAt: '2026-08-01T00:00:00.000Z',
    fingerprints: { 'OEBPS/ch1.xhtml#1': 'She counted twelve' },
  });

  const at = '2026-08-10T00:00:00.000Z';
  const recorded = await manifestService.appendAppliedPass(
    dir, { kind: 'footnote-refs', at, params: {} },
    { outcome: 'carried', fromSha256, toSha256: 'the-new-book',
      fingerprints: { 'OEBPS/ch1.xhtml#1': 'She counted twelve of them before' } });
  assert.strictEqual(recorded.narrationCarried, true);
  assert.strictEqual(recorded.narrationNote, null);

  const epub = bookRecordOf(dir);
  assert.strictEqual(epub.appliedPasses.length, 1, 'the pass was not recorded');
  assert.strictEqual(epub.narrationDeletions.epubSha256, 'the-new-book',
    'the pass landed without the re-stamp — two writes, and a torn state between them');
  assert.strictEqual(
    epub.narrationDeletions.fingerprints['OEBPS/ch1.xhtml#1'],
    'She counted twelve of them before',
    'the fingerprints still describe the book the pass replaced');
  assert.deepStrictEqual(epub.narrationDeletions.elements, STRIKES);
});

test('a refused carry records the pass, leaves the record, and says why', async () => {
  const dir = await makeProject('carry-transaction-refused');
  const book = await manifestService.readExportEpub(dir);
  const fromSha256 = sha256(book.absPath);
  await manifestService.writeNarrationDeletions(dir, {
    epubSha256: fromSha256, elements: STRIKES, updatedAt: '2026-08-01T00:00:00.000Z',
  });

  const recorded = await manifestService.appendAppliedPass(
    dir, { kind: 'simplify', at: '2026-08-10T00:00:00.000Z', params: {} },
    { outcome: 'refused', reason: 'ch1.xhtml held 4 element(s) and holds 3.' });
  assert.strictEqual(recorded.narrationCarried, false);
  assert.ok(/not carried/.test(recorded.narrationNote), recorded.narrationNote);
  assert.ok(/nothing has been cleared/i.test(recorded.narrationNote), recorded.narrationNote);

  const epub = bookRecordOf(dir);
  assert.strictEqual(epub.appliedPasses.length, 1, 'the pass itself was not recorded');
  assert.deepStrictEqual(epub.narrationDeletions.elements, STRIKES, 'the record was touched');
  assert.strictEqual(epub.narrationDeletions.epubSha256, fromSha256,
    'a refused carry re-stamped the record anyway');
});

test('a record edited WHILE the pass ran is not re-stamped on a stale proof', async () => {
  const dir = await makeProject('carry-race');
  const book = await manifestService.readExportEpub(dir);
  await manifestService.writeNarrationDeletions(dir, {
    epubSha256: 'what-the-picker-was-looking-at', elements: STRIKES,
    updatedAt: '2026-08-01T00:00:00.000Z',
  });

  const recorded = await manifestService.appendAppliedPass(
    dir, { kind: 'footnote-refs', at: '2026-08-10T00:00:00.000Z', params: {} },
    { outcome: 'carried', fromSha256: sha256(book.absPath), toSha256: 'the-new-book',
      fingerprints: {} });
  assert.strictEqual(recorded.narrationCarried, false);
  assert.ok(/edited while/.test(recorded.narrationNote), recorded.narrationNote);
  assert.strictEqual(
    bookRecordOf(dir).narrationDeletions.epubSha256, 'what-the-picker-was-looking-at',
    'a proof about one record was used to re-stamp another');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The comparison itself
// ─────────────────────────────────────────────────────────────────────────────

test('the walk comparison passes a book against itself and nothing else', async () => {
  const dir = await makeProject('carry-shapes');
  const book = await manifestService.readExportEpub(dir);
  const shape = await narrationDocumentShapes(book.absPath, 'the fixture');
  assert.deepStrictEqual(shape.map((d) => d.file), ['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml']);
  assert.deepStrictEqual(shape[0].keys, [
    'OEBPS/ch1.xhtml#0', 'OEBPS/ch1.xhtml#1', 'OEBPS/ch1.xhtml#2', 'OEBPS/ch1.xhtml#3',
  ]);
  assert.deepStrictEqual(shape[0].tags, ['p', 'p', 'p', 'p']);
  assert.strictEqual(narrationCarryRefusal(STRIKES, shape, shape), null);

  // A document the book no longer has.
  assert.ok(/not a document of the book any more/.test(
    narrationCarryRefusal(STRIKES, shape, [shape[0]])));
  // A document ADDED by a pass moves no key minted against the old book.
  assert.strictEqual(
    narrationCarryRefusal(STRIKES, shape,
      [...shape, { file: 'OEBPS/ch3.xhtml', keys: ['OEBPS/ch3.xhtml#0'], tags: ['p'] }]),
    null);
  // Same count, different shape.
  const retagged = [{ ...shape[0], tags: ['p', 'div', 'p', 'p'] }, shape[1]];
  assert.ok(/was a <p> before the pass and is a <div>/.test(
    narrationCarryRefusal(STRIKES, shape, retagged)));
  // Same count, a text unit traded for a picture.
  const repictured = [{
    file: 'OEBPS/ch1.xhtml',
    keys: ['OEBPS/ch1.xhtml#0', 'OEBPS/ch1.xhtml#1', 'OEBPS/ch1.xhtml#2', 'OEBPS/ch1.xhtml#img0'],
    tags: ['p', 'p', 'p', 'img'],
  }, shape[1]];
  assert.ok(/element at position 3/.test(narrationCarryRefusal(STRIKES, shape, repictured)));
});

test('the footnote pass leaves the enumeration EXACTLY as it found it', async () => {
  // The per-pass claim, asserted rather than trusted: a `<sup>` is inline, and
  // the one element the strip could have emptied — `<p><sup>2</sup></p>` — is
  // kept in the walk by `keepEmptiedUnitsAudible`'s `[break]`.
  const dir = await makeProject('carry-enumeration');
  const book = await manifestService.readExportEpub(dir);
  const before = await narrationDocumentShapes(book.absPath, 'before');
  assert.ok((await runFootnoteRefs(dir)).success);
  const after = await narrationDocumentShapes(book.absPath, 'after');
  assert.deepStrictEqual(after, before,
    'the footnote-reference pass moved an element after all');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows locks */ }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
