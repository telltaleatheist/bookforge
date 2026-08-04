#!/usr/bin/env node
/**
 * Tests for electron/working-document-writer.ts — curation, written into the
 * working document as PDF incremental updates.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-working-document-writer.js
 *
 * ── Why every assertion reopens the file ────────────────────────────────────
 *
 * `saveIncremental` writes an EXISTING object only when that object has been
 * marked, and an unmarked mutation produces a valid update that silently does
 * not contain the change. An in-memory assertion cannot see that bug: the
 * document object in hand has the new label whether or not a byte of it reached
 * the disk. So nothing here trusts the writer's own document. Every check goes
 * back to the file through `working-document.ts` — the P2 reader, which is what
 * every stage downstream actually uses — after the writer has closed it.
 *
 * The fixture working.pdf carries a marker and no block layer, because that is
 * what `foundry scan --pdf` produces. `seedBlocks` puts a block layer on it the
 * way `foundry blocks` would, so these tests start where curation starts.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'working-document-writer.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const writer = require(path.join(DIST, 'working-document-writer.js'));
const reader = require(path.join(DIST, 'working-document.js'));
const pdfLib = require(path.join(REPO, 'node_modules', '@cantoo', 'pdf-lib'));
const {
  PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString,
} = pdfLib;

const FIXTURE = path.join(REPO, 'tools', 'fixtures', 'document-pipeline', 'working.pdf');

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-wdw-'));
let n = 0;

/**
 * A working document carrying a block layer, the way `foundry blocks` leaves
 * one. Written as an incremental update, which is also what foundry does, so
 * these tests exercise appending onto an append rather than onto a fresh file.
 */
async function seedBlocks(blocks) {
  const file = path.join(scratch, `working-${n++}.pdf`);
  fs.copyFileSync(FIXTURE, file);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = await PDFDocument.load(bytes, {
    forIncrementalUpdate: true,
    updateMetadata: false,
  });
  const snapshot = doc.takeSnapshot();
  const pages = doc.getPages();
  const byPage = new Map();
  for (const b of blocks) {
    const list = byPage.get(b.page);
    if (list) list.push(b); else byPage.set(b.page, [b]);
  }
  for (const [index, mine] of byPage) {
    const page = pages[index].node;
    const created = doc.context.obj([]);
    page.set(PDFName.of('Annots'), created);
    for (const b of mine) {
      const dict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: b.rect,
        F: 4,
        C: [0.2, 0.4, 0.9],
        BS: { W: 1, S: 'S' },
        NM: PDFHexString.fromText(b.id),
        T: PDFHexString.fromText(`${b.id} ${b.category}`),
        Contents: PDFHexString.fromText(b.text),
      });
      dict.set(PDFName.of('FoundryCategory'), PDFName.of(b.category));
      dict.set(PDFName.of('FoundrySeq'), PDFNumber.of(b.seq));
      if (b.deleted) dict.set(PDFName.of('FoundryDeleted'), PDFBool.True);
      created.push(doc.context.register(dict));
    }
    snapshot.markObjForSave(page);
  }
  const diff = await doc.saveIncremental(snapshot);
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, diff, 0, diff.length, bytes.length);
  fs.closeSync(fd);
  return file;
}

/** Three blocks on page 0, one on page 1 — enough for every gesture. */
function standardBlocks() {
  return [
    { id: 'b1', page: 0, seq: 0, category: 'chapter', text: 'Chapter One', rect: [72, 560, 360, 600] },
    { id: 'b2', page: 0, seq: 1, category: 'chapter', text: 'The Beginning', rect: [72, 520, 360, 556] },
    { id: 'b3', page: 0, seq: 2, category: 'body', text: 'It was a dark night.', rect: [72, 200, 360, 500] },
    { id: 'b4', page: 1, seq: 3, category: 'body', text: 'The next morning.', rect: [72, 200, 360, 600] },
  ];
}

/** The block layer as the file on disk has it — never as the writer remembers it. */
async function coldRead(file) {
  const { blocks, pages, marker } = await reader.readWorkingDocumentBlocks(file);
  return { blocks, pages, marker, byId: new Map(blocks.map((b) => [b.id, b])) };
}

/** The raw annotation dict, for the keys the typed reader does not surface. */
async function coldAnnot(file, blockId) {
  const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
    updateMetadata: false,
  });
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const nm = dict.lookup(PDFName.of('NM'));
      const id = nm instanceof PDFHexString || nm instanceof PDFString ? nm.decodeText() : null;
      if (id === blockId) return dict;
    }
  }
  return null;
}

async function refuses(fn, ...needles) {
  let message = null;
  try {
    await fn();
  } catch (err) {
    message = err && err.message ? err.message : String(err);
  }
  assert.ok(message !== null, `expected a refusal, got none`);
  for (const needle of needles) {
    assert.ok(
      message.includes(needle),
      `refusal should name ${JSON.stringify(needle)}, said: ${message}`
    );
  }
  return message;
}

// ─────────────────────────────────────────────────────────────────────────────

test('the seed itself round-trips: four blocks, in reading order', async () => {
  const file = await seedBlocks(standardBlocks());
  const { blocks } = await coldRead(file);
  assert.strictEqual(blocks.length, 4);
  assert.deepStrictEqual(blocks.map((b) => b.id), ['b1', 'b2', 'b3', 'b4']);
  assert.strictEqual(blocks[2].category, 'body');
  assert.strictEqual(blocks[0].text, 'Chapter One');
});

test('relabel survives a cold reopen — the category, the colour and the label', async () => {
  const file = await seedBlocks(standardBlocks());
  await writer.applyWorkingDocumentEdits(file, [
    { kind: 'relabel', blockId: 'b3', category: 'footnote' },
  ]);

  const { byId } = await coldRead(file);
  assert.strictEqual(byId.get('b3').category, 'footnote');

  const dict = await coldAnnot(file, 'b3');
  const colour = dict.lookup(PDFName.of('C'));
  assert.ok(colour instanceof PDFArray && colour.size() === 3, '/C is three components');
  // shared/ocr/block-categories.ts: footnote is #2196F3.
  const components = [0, 1, 2].map((i) => colour.lookup(i).asNumber());
  assert.deepStrictEqual(
    components.map((c) => Math.round(c * 255)),
    [0x21, 0x96, 0xf3],
    'the colour is the one palette\'s, not the one the seed wrote'
  );
  const title = dict.lookup(PDFName.of('T'));
  assert.strictEqual(title.decodeText(), 'b3 footnote');
});

test('delete is a flag, and restore takes it off', async () => {
  const file = await seedBlocks(standardBlocks());

  await writer.applyWorkingDocumentEdits(file, [{ kind: 'delete', blockId: 'b3' }]);
  let cold = await coldRead(file);
  assert.strictEqual(cold.byId.get('b3').deleted, true);
  assert.strictEqual(cold.blocks.length, 4, 'a deleted block is still in the layer');
  assert.strictEqual(cold.byId.get('b3').text, 'It was a dark night.', 'and keeps its text');

  await writer.applyWorkingDocumentEdits(file, [{ kind: 'restore', blockId: 'b3' }]);
  cold = await coldRead(file);
  assert.strictEqual(cold.byId.get('b3').deleted, false);
  const dict = await coldAnnot(file, 'b3');
  assert.strictEqual(
    dict.lookup(PDFName.of('FoundryDeleted')), undefined,
    'restore REMOVES the key rather than writing false'
  );
});

test("a retyped chapter title keeps its em dashes, quotes and ligatures", async () => {
  const file = await seedBlocks(standardBlocks());
  // The exact population foundry measured losing to literal strings: an em dash,
  // curly quotes, a ligature, an accented capital, and a character whose low
  // byte is `)`.
  const title = 'Chapter I — “The Beginning” of the ﬁrst Étude )©';
  await writer.applyWorkingDocumentEdits(file, [
    { kind: 'retitle', blockId: 'b1', text: title },
  ]);
  const { byId, blocks } = await coldRead(file);
  assert.strictEqual(byId.get('b1').text, title);
  assert.strictEqual(blocks.length, 4, 'no annotation was lost to a broken string');
});

test('merge: one block, union box, joined text, every id recorded', async () => {
  const file = await seedBlocks(standardBlocks());
  await writer.applyWorkingDocumentEdits(file, [
    { kind: 'merge', blockIds: ['b2', 'b1'] },
  ]);

  const { blocks, byId } = await coldRead(file);
  assert.strictEqual(blocks.length, 3, 'two blocks became one');
  assert.strictEqual(byId.has('b2'), false, 'the member is gone from the layer');

  const lead = byId.get('b1');
  assert.ok(lead, 'the earliest block in reading order is the one that survives');
  assert.strictEqual(lead.seq, 0, 'and keeps its place in the book');
  assert.strictEqual(lead.category, 'chapter');
  assert.strictEqual(lead.text, 'Chapter One The Beginning', 'text joins in reading order');
  assert.deepStrictEqual(lead.rect, [72, 520, 360, 600], 'the box is the union');
  assert.deepStrictEqual(lead.merged, ['b1', 'b2'], 'every id that went in, the lead included');
});

test('merge refuses to cross a page break, naming both pages', async () => {
  const file = await seedBlocks(standardBlocks());
  await refuses(
    () => writer.applyWorkingDocumentEdits(file, [
      { kind: 'merge', blockIds: ['b3', 'b4'] },
    ]),
    'b3', 'b4', 'page 1', 'page 2'
  );
  const { blocks } = await coldRead(file);
  assert.strictEqual(blocks.length, 4, 'the refusal wrote nothing');
});

test('merge refuses one block, and every edit refuses an id the document lacks', async () => {
  const file = await seedBlocks(standardBlocks());
  await refuses(
    () => writer.applyWorkingDocumentEdits(file, [{ kind: 'merge', blockIds: ['b1'] }]),
    'at least two'
  );
  await refuses(
    () => writer.applyWorkingDocumentEdits(file, [{ kind: 'delete', blockId: 'nope' }]),
    'no block nope'
  );
  await refuses(
    () => writer.applyWorkingDocumentEdits(file, [
      { kind: 'relabel', blockId: 'b1', category: 'sidebar' },
    ]),
    'sidebar', 'not a block category'
  );
});

test('a deleted page is a fact about the page, and restore takes it back', async () => {
  const file = await seedBlocks(standardBlocks());
  await writer.applyWorkingDocumentEdits(file, [{ kind: 'delete-page', page: 1 }]);
  let cold = await coldRead(file);
  assert.strictEqual(cold.pages[1].deleted, true);
  assert.strictEqual(cold.pages[0].deleted, false);

  await writer.applyWorkingDocumentEdits(file, [{ kind: 'restore-page', page: 1 }]);
  cold = await coldRead(file);
  assert.strictEqual(cold.pages[1].deleted, false);

  await refuses(
    () => writer.applyWorkingDocumentEdits(file, [{ kind: 'delete-page', page: 9 }]),
    'page 10', '3 pages'
  );
});

test('every save APPENDS — the bytes before the boundary never move', async () => {
  const file = await seedBlocks(standardBlocks());
  const before = fs.readFileSync(file);

  const first = await writer.applyWorkingDocumentEdits(file, [
    { kind: 'relabel', blockId: 'b3', category: 'quote' },
  ]);
  assert.strictEqual(first.bytes, before.length + first.appended);
  assert.ok(first.appended > 0);

  const after = fs.readFileSync(file);
  assert.strictEqual(after.length, first.bytes, 'the result is the file length');
  assert.ok(
    before.equals(after.subarray(0, before.length)),
    'the document as it stood is still there, byte for byte'
  );

  // Four more appends on top of each other: this is the sequence a curation
  // session actually is, and the file has to stay a readable PDF at every one.
  let bytes = first.bytes;
  for (const category of ['body', 'caption', 'list', 'heading']) {
    const result = await writer.applyWorkingDocumentEdits(file, [
      { kind: 'relabel', blockId: 'b3', category },
    ]);
    assert.ok(result.bytes > bytes, 'each update lands past the last');
    bytes = result.bytes;
    const { byId } = await coldRead(file);
    assert.strictEqual(byId.get('b3').category, category);
  }
  assert.strictEqual(fs.statSync(file).size, bytes);
});

test('a batch is one update, applied in the order it was given', async () => {
  const file = await seedBlocks(standardBlocks());
  const sizeBefore = fs.statSync(file).size;
  const result = await writer.applyWorkingDocumentEdits(file, [
    { kind: 'relabel', blockId: 'b1', category: 'heading' },
    { kind: 'retitle', blockId: 'b1', text: 'A Heading' },
    { kind: 'delete', blockId: 'b4' },
    { kind: 'merge', blockIds: ['b1', 'b2'] },
  ]);
  assert.strictEqual(result.bytes, sizeBefore + result.appended, 'one append, not four');

  const { blocks, byId } = await coldRead(file);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(byId.get('b1').category, 'heading', 'the relabel was not undone by the merge');
  assert.strictEqual(byId.get('b1').text, 'A Heading The Beginning');
  assert.strictEqual(byId.get('b4').deleted, true);
});

test('an empty batch is refused rather than written', async () => {
  const file = await seedBlocks(standardBlocks());
  const size = fs.statSync(file).size;
  await refuses(() => writer.applyWorkingDocumentEdits(file, []), 'no edits were given');
  assert.strictEqual(fs.statSync(file).size, size, 'and the file was not touched');
});

test('a working document that is not there names the stage that casts one', async () => {
  await refuses(
    () => writer.applyWorkingDocumentEdits(path.join(scratch, 'absent.pdf'), [
      { kind: 'delete', blockId: 'b1' },
    ]),
    'Get Text'
  );
});

test('the marker and the pages survive curation untouched', async () => {
  const file = await seedBlocks(standardBlocks());
  const before = await coldRead(file);
  await writer.applyWorkingDocumentEdits(file, [
    { kind: 'relabel', blockId: 'b3', category: 'footnote' },
    { kind: 'delete', blockId: 'b4' },
  ]);
  const after = await coldRead(file);
  assert.deepStrictEqual(after.marker, before.marker, 'curation is not a re-cast');
  assert.strictEqual(after.pages.length, before.pages.length);
  assert.deepStrictEqual(after.pages[0].cropBox, before.pages[0].cropBox);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push(`${name}: ${err && err.message ? err.message : err}`);
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`working-document-writer: ${passed} test(s) passed`);
})();
