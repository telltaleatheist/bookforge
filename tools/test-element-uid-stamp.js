/**
 * Tests for the element-id stamp — `stampElementIdsInBookFile` in
 * electron/epub-processor.ts, and the one manifest rule that goes with it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-element-uid-stamp.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * Every record this app keeps about a book element names it by its PLACE in one
 * enumeration walk: `<zip entry>#<index>`. A place is not an identity, and every
 * edit that adds or removes an element renumbers every element after it — which
 * is why the app carries sha256 stamps that void records, structural guards that
 * refuse ledger entries, and fingerprint migrations that renumber strikes. The
 * stamp is the beginning of the end of all of that: `data-bf-uid` on every
 * narration unit and every picture of the WORKING COPY, minted once and never
 * changed.
 *
 * Six claims, each asserted against real files:
 *
 *  1. Every walked element — text unit AND picture — comes out with an id.
 *  2. The ids are UNIQUE within the book.
 *  3. It is IDEMPOTENT: a stamped book is not copied, not one byte. That is a
 *     contract and not an optimization — the bytes stamp the narration strike
 *     record and key the layout caches.
 *  4. The synthesized wrappers `collectExportUnits` has always created in memory
 *     around stray text runs become REAL MARKUP, and doing so moves NOTHING: the
 *     walk before and after holds the same elements at the same indices.
 *  5. A stamped book that fails its own proof is DESTROYED, naming the file.
 *  6. `workingChangesByFamily` excepts the stamp, exactly as it excepts the
 *     naming pass — both are unattended, both run at every open, and counting
 *     either would make every book report unerased working changes forever.
 *
 * Everything is written to a temp directory; nothing here touches the library.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'epub-processor.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-uid-stamp-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  ZipReader, ZipWriter,
  stampElementIdsInBookFile,
  readEpubElementCategories,
  ELEMENT_UID_ATTR,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
}

async function refuses(promise, ...fragments) {
  let message = null;
  try {
    await promise;
  } catch (err) {
    message = err.message;
  }
  assert.notStrictEqual(message, null, 'it did not refuse');
  for (const fragment of fragments) {
    assert.ok(
      message.includes(fragment),
      `the refusal does not say "${fragment}" — it says: ${message}`);
  }
  return message;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONTAINER = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
  + '  <rootfiles>\n'
  + '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
  + '  </rootfiles>\n</container>\n';

const PAGE = (title, bodyMarkup) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
  + `<head><title>${title}</title></head>\n<body>\n${bodyMarkup}\n</body>\n</html>\n`;

const OPF3 = (docs) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
  + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
  + `    <dc:identifier id="pub-id">urn:uuid:${path.basename(ROOT)}</dc:identifier>\n`
  + '    <dc:title>A Book</dc:title>\n    <dc:language>en</dc:language>\n'
  + '  </metadata>\n  <manifest>\n'
  + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
  + '    <item id="plate" href="plate.png" media-type="image/png"/>\n'
  + docs.map((d) => `    <item id="${d}" href="${d}.xhtml" media-type="application/xhtml+xml"/>\n`).join('')
  + '  </manifest>\n  <spine>\n'
  + docs.map((d) => `    <itemref idref="${d}"/>\n`).join('')
  + '  </spine>\n</package>\n';

const NAV = (entries) => PAGE('Contents',
  '<nav epub:type="toc"><ol>\n'
  + entries.map(([href, label]) => `<li><a href="${href}">${label}</a></li>\n`).join('')
  + '</ol></nav>');

const PLATE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function writeEpub(name, files) {
  const target = path.join(ROOT, name);
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'), true);
  zip.addFile('OEBPS/plate.png', PLATE, true);
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), true);
  }
  await zip.write(target);
  return target;
}

/** An ordinary two-document book, nothing stamped. */
function plainBook(name = 'plain.epub') {
  return writeEpub(name, {
    'OEBPS/content.opf': OPF3(['c0000', 'c0001']),
    'OEBPS/nav.xhtml': NAV([
      ['c0000.xhtml', 'The Nazi Revolution'],
      ['c0001.xhtml', 'Working Towards the Führer'],
    ]),
    'OEBPS/c0000.xhtml': PAGE('The Nazi Revolution', [
      '<h1>The Nazi Revolution</h1>',
      '<p>Hitler came to power in a country governed by decree for three years.</p>',
    ].join('\n')),
    'OEBPS/c0001.xhtml': PAGE('Working Towards the Führer', [
      '<h1>II</h1>',
      '<p>Everyone works towards the leader along the lines he would wish.</p>',
      '<div class="image"><img src="plate.png" alt="a plate"/></div>',
    ].join('\n')),
  });
}

/**
 * A CALIBRE-SHAPED book: bare inline content sitting between paragraphs, which
 * no element covers. `collectExportUnits` has always MOVED that run into a
 * synthesized `<div>` in memory so it could be a unit at all — a phantom element
 * that exists during a walk and nowhere on disk. The stamp makes it real.
 */
function strayTextBook(name = 'stray.epub') {
  return writeEpub(name, {
    'OEBPS/content.opf': OPF3(['s0000']),
    'OEBPS/nav.xhtml': NAV([['s0000.xhtml', 'A Chapter']]),
    'OEBPS/s0000.xhtml': PAGE('A Chapter', [
      '<h1>A Chapter</h1>',
      '<p>The court rose at four.</p>',
      '<i>He would not look at them</i>, he thought.',
      '<p>Twenty-one men sat in two rows.</p>',
    ].join('\n')),
  });
}

async function entriesOf(bookPath) {
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    const out = new Map();
    for (const entry of reader.getEntries()) out.set(entry, await reader.readEntry(entry));
    return out;
  } finally {
    reader.close();
  }
}

async function documentText(bookPath, entry) {
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    return (await reader.readEntry(entry)).toString('utf8');
  } finally {
    reader.close();
  }
}

/** Every element key the book's ONE walk produces, in order. */
async function walkKeys(bookPath) {
  return (await readEpubElementCategories(bookPath)).elements.map((e) => e.key);
}

/** Every `data-bf-uid` the whole book carries, in document order. */
async function uidsIn(bookPath) {
  const out = [];
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    for (const entry of reader.getEntries()) {
      if (!/\.(xhtml|html|htm)$/i.test(entry)) continue;
      const xhtml = (await reader.readEntry(entry)).toString('utf8');
      const re = new RegExp(`${ELEMENT_UID_ATTR}="([^"]*)"`, 'g');
      let m;
      while ((m = re.exec(xhtml)) !== null) out.push(m[1]);
    }
  } finally {
    reader.close();
  }
  return out;
}

/** Rewrite one document of a book, leaving every other entry byte for byte. */
async function forge(bookPath, outName, entry, edit) {
  const target = path.join(ROOT, outName);
  const reader = new ZipReader(bookPath);
  await reader.open();
  try {
    const zip = new ZipWriter();
    for (const name of reader.getEntries()) {
      let data = await reader.readEntry(name);
      if (name === entry) data = Buffer.from(edit(data.toString('utf8')), 'utf8');
      zip.addFile(name, data, name !== 'mimetype');
    }
    await zip.write(target);
  } finally {
    reader.close();
  }
  return target;
}

// ── The tests ───────────────────────────────────────────────────────────────

async function run() {
  // ── Every element gets one, and they are unique ──────────────────────────
  await check('every walked element — text and picture — comes out with an id', async () => {
    const book = await plainBook('stamp-in.epub');
    const out = path.join(ROOT, 'stamp-out.epub');
    const result = await stampElementIdsInBookFile(book, out);

    // c0000: heading + paragraph. c0001: heading, paragraph, image div, and the
    // <img> inside it as a picture of its own.
    assert.strictEqual(result.total, 6, `the walk produced ${result.total} elements`);
    assert.strictEqual(result.stamped, 6, 'not every element was stamped');
    assert.deepStrictEqual(result.files, ['OEBPS/c0000.xhtml', 'OEBPS/c0001.xhtml']);
    assert.strictEqual(result.wrappersPersisted, 0, 'a plain book synthesized a wrapper');

    const uids = await uidsIn(out);
    assert.strictEqual(uids.length, 6, `the book carries ${uids.length} ids`);
    assert.strictEqual(new Set(uids).size, 6, 'the ids are not unique within the book');
    for (const uid of uids) {
      assert.ok(/^[0-9a-f]{8}$/.test(uid), `"${uid}" is not a short random hex id`);
      assert.ok(!uid.includes('#') && !uid.includes('|'),
        `"${uid}" contains a character that already separates the parts of a key`);
    }
  });

  await check('the stamp moves no element — every key is where it was', async () => {
    const book = await plainBook('keys-in.epub');
    const before = await walkKeys(book);
    const out = path.join(ROOT, 'keys-out.epub');
    await stampElementIdsInBookFile(book, out);
    assert.deepStrictEqual(await walkKeys(out), before, 'the element enumeration moved');
  });

  await check('nothing but the spine documents changes', async () => {
    const book = await plainBook('surgical-in.epub');
    const out = path.join(ROOT, 'surgical-out.epub');
    await stampElementIdsInBookFile(book, out);

    const before = await entriesOf(book);
    const after = await entriesOf(out);
    assert.deepStrictEqual([...after.keys()], [...before.keys()], 'the zip entries changed');
    const changed = [...before.keys()].filter((e) => !before.get(e).equals(after.get(e)));
    assert.deepStrictEqual(changed, ['OEBPS/c0000.xhtml', 'OEBPS/c0001.xhtml'],
      `entries other than the spine documents changed: ${changed.join(', ')}`);
  });

  // ── Idempotence ─────────────────────────────────────────────────────────
  await check('a stamped book is not copied — not one byte, no output file', async () => {
    const book = await plainBook('idem-in.epub');
    const once = path.join(ROOT, 'idem-once.epub');
    await stampElementIdsInBookFile(book, once);

    const twice = path.join(ROOT, 'idem-twice.epub');
    const second = await stampElementIdsInBookFile(once, twice);
    assert.strictEqual(second.stamped, 0, 'an already-stamped element was stamped again');
    assert.strictEqual(second.total, 6, 'the second walk found a different book');
    assert.deepStrictEqual(second.files, [], 'a document was rewritten for nothing');
    assert.strictEqual(fs.existsSync(twice), false, 'a file was written anyway');
  });

  await check('a book stamped except for one new element gets that one only', async () => {
    const book = await plainBook('partial-in.epub');
    const once = path.join(ROOT, 'partial-once.epub');
    await stampElementIdsInBookFile(book, once);
    const kept = new Set(await uidsIn(once));

    // A pass added a paragraph to one document and left the rest alone.
    const edited = await forge(once, 'partial-edited.epub', 'OEBPS/c0000.xhtml',
      (x) => x.replace('</body>', '<p>A paragraph a later pass wrote.</p>\n</body>'));

    const out = path.join(ROOT, 'partial-out.epub');
    const result = await stampElementIdsInBookFile(edited, out);
    assert.strictEqual(result.stamped, 1, `${result.stamped} elements were stamped, not one`);
    assert.deepStrictEqual(result.files, ['OEBPS/c0000.xhtml'],
      'a document with nothing new in it was rewritten');

    const after = await uidsIn(out);
    assert.strictEqual(after.length, 7);
    assert.strictEqual(new Set(after).size, 7, 'the new id collided with an existing one');
    for (const uid of kept) {
      assert.ok(after.includes(uid), `the existing id ${uid} was not kept`);
    }
  });

  // ── The synthesized wrappers become real ────────────────────────────────
  await check('a synthesized wrapper becomes real markup, and moves nothing', async () => {
    const book = await strayTextBook('stray-in.epub');
    const before = await walkKeys(book);
    const out = path.join(ROOT, 'stray-out.epub');
    const result = await stampElementIdsInBookFile(book, out);

    assert.strictEqual(result.wrappersPersisted, 1,
      `${result.wrappersPersisted} wrappers were persisted, not one`);
    const xhtml = await documentText(out, 'OEBPS/s0000.xhtml');
    // The `<i>` is REAL markup the catch-all's other form collects where it
    // stands: it is stamped in place and nothing is wrapped around it. The bare
    // text after it is covered by nothing, so THAT is the synthesized wrapper.
    assert.ok(/<i [^>]*data-bf-uid="[0-9a-f]{8}"[^>]*>He would not look at them<\/i>/.test(xhtml),
      `the existing <i> was not stamped where it stands:\n${xhtml}`);
    assert.ok(/<div [^>]*data-bf-uid="[0-9a-f]{8}"[^>]*>, he thought\./.test(xhtml),
      `the stray run is not wrapped in a real, stamped <div>:\n${xhtml}`);

    // The whole point: the walk already counted that wrapper, so persisting it
    // adds no element and every positional record still names what it named.
    assert.deepStrictEqual(await walkKeys(out), before, 'persisting a wrapper moved the walk');
  });

  await check('the ledger\'s structural guard sees no change across a first stamp', async () => {
    // `registerLedgerPass` measures a pass by comparing `elementCountsByFile` of
    // the ARCHIVE-grade book behind the working copy against the book the pass
    // produced. The archive is never stamped, so this is exactly the comparison
    // a first stamp has to survive — and it does, because the walk synthesizes
    // the same wrapper in memory on the unstamped side that the stamped side
    // carries in its markup. There is no snapshot and no ordering to get wrong:
    // the base is re-walked live, every time.
    const { enumerateNarrationElements } = require(path.join(DIST, 'electron', 'quire-stamp.js'));
    const countsByFile = async (bookPath) => {
      const walked = await enumerateNarrationElements(bookPath, 'the ledger guard test');
      return new Map(walked.map((doc) => [doc.file, doc.entries.length]));
    };

    const archive = await strayTextBook('ledger-base.epub');
    const stamped = path.join(ROOT, 'ledger-stamped.epub');
    await stampElementIdsInBookFile(archive, stamped);

    assert.deepStrictEqual(
      [...(await countsByFile(stamped))], [...(await countsByFile(archive))],
      'the stamp would make registerLedgerPass refuse the next pass\'s ledger entry');
  });

  await check('a book whose wrappers are already real is not rewritten again', async () => {
    const book = await strayTextBook('stray-idem-in.epub');
    const once = path.join(ROOT, 'stray-idem-once.epub');
    await stampElementIdsInBookFile(book, once);
    const twice = path.join(ROOT, 'stray-idem-twice.epub');
    const second = await stampElementIdsInBookFile(once, twice);
    assert.strictEqual(second.wrappersPersisted, 0, 'a real wrapper was synthesized again');
    assert.deepStrictEqual(second.files, [], 'the document was rewritten for nothing');
    assert.strictEqual(fs.existsSync(twice), false, 'a file was written anyway');
  });

  // ── The refusals ────────────────────────────────────────────────────────
  await check('an id on two elements is refused by name, before anything is written', async () => {
    const book = await plainBook('dup-in.epub');
    const forged = await forge(book, 'dup-forged.epub', 'OEBPS/c0001.xhtml', (x) => x
      .replace('<h1>', `<h1 ${ELEMENT_UID_ATTR}="abadcafe">`)
      .replace('<p>', `<p ${ELEMENT_UID_ATTR}="abadcafe">`));
    const out = path.join(ROOT, 'dup-out.epub');
    await refuses(
      stampElementIdsInBookFile(forged, out),
      'carries the element id "abadcafe" on more than one element',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false, 'a file was written anyway');
  });

  await check('an id no key could be built out of is refused by name', async () => {
    const book = await plainBook('badid-in.epub');
    const forged = await forge(book, 'badid-forged.epub', 'OEBPS/c0001.xhtml',
      (x) => x.replace('<h1>', `<h1 ${ELEMENT_UID_ATTR}="OEBPS/c0001.xhtml#0">`));
    const out = path.join(ROOT, 'badid-out.epub');
    await refuses(
      stampElementIdsInBookFile(forged, out),
      'contains a character that already separates the parts of a key',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false, 'a file was written anyway');
  });

  await check('an id the walk did not produce fails the proof and DESTROYS the output', async () => {
    const book = await plainBook('phantom-in.epub');
    // An id on a <span> INSIDE a paragraph: nothing enumerates it, so it is an
    // identity nothing can resolve. The rest of the book still needs stamping,
    // so the file IS written and then destroyed by its own proof.
    const forged = await forge(book, 'phantom-forged.epub', 'OEBPS/c0001.xhtml',
      (x) => x.replace('Everyone works',
        `<span ${ELEMENT_UID_ATTR}="deadbeef">Everyone</span> works`));
    const out = path.join(ROOT, 'phantom-out.epub');
    await refuses(
      stampElementIdsInBookFile(forged, out),
      'carries the element id "deadbeef" on something the walk does not enumerate',
      'Nothing was written.');
    assert.strictEqual(fs.existsSync(out), false, 'the failed output was left on disk');
  });

  // ── The manifest rule ───────────────────────────────────────────────────
  await check('workingChangesByFamily excepts the stamp, and still counts a real edit', async () => {
    const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-uid-manifest-'));
    manifestService.setLibraryBasePath(LIB);
    const dir = path.join(LIB, 'projects', 'stamped');
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'archive', 'A Book.epub'), 'PK the archive');
    fs.writeFileSync(path.join(dir, 'source', 'A Book.working.epub'), 'PK the working copy');

    const manifest = {
      manifestVersion: 2,
      projectId: 'stamped',
      createdAt: '2026-08-10T00:00:00.000Z',
      modifiedAt: '2026-08-10T00:00:00.000Z',
      metadata: { title: 'A Book' },
      source: { type: 'epub', originalFilename: 'A Book.epub' },
      archive: [{ path: 'archive/A Book.epub', role: 'original', format: 'epub' }],
      families: [{
        id: 'fam-1',
        sourcePath: 'archive/A Book.epub',
        epub: {
          path: 'source/A Book.working.epub',
          modifiedAt: '2026-08-10T00:00:00.000Z',
          bookEdits: [
            { kind: 'stamp-element-ids', at: '2026-08-10T00:00:00.000Z', stamped: 6, total: 6,
              files: ['OEBPS/c0000.xhtml'], wrappersPersisted: 0,
              fromSha256: 'aa', toSha256: 'bb' },
            { kind: 'name-chapter-openers', at: '2026-08-10T00:00:01.000Z', named: [],
              fromSha256: 'bb', toSha256: 'cc' },
          ],
        },
      }],
      outputs: {},
    };
    const write = () =>
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    write();

    const automatic = await manifestService.workingChangesByFamily(dir);
    assert.strictEqual(automatic['fam-1'], false,
      'the two unattended passes were counted as the user\'s working changes');

    // A DELIBERATE edit beside them still counts — the exception is for the two
    // passes that run themselves, not for book edits in general.
    manifest.families[0].epub.bookEdits.push({
      kind: 'set-block-category', at: '2026-08-10T00:00:02.000Z',
      file: 'OEBPS/c0000.xhtml', elementKey: 'OEBPS/c0000.xhtml#0', tag: 'h1',
      categoryBefore: 'title', categoryAfter: 'chapter', excerpt: 'II',
      fromSha256: 'cc', toSha256: 'dd',
    });
    write();
    const deliberate = await manifestService.workingChangesByFamily(dir);
    assert.strictEqual(deliberate['fam-1'], true, 'a real edit stopped counting');

    fs.rmSync(LIB, { recursive: true, force: true });
  });

  for (const [status, name, detail] of results) {
    console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
  const passed = results.filter(([s]) => s === 'ok').length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
