/**
 * Tests for pairing an element of the TTS COPY back to the element of the BOOK
 * it was cut from.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-pairing.js
 *
 * Owen ratified the rule on 2026-08-09: a delete made on the TTS copy must write
 * a RECORD as well as change the file, "because regeneration would silently drop
 * a file-only edit". The record keys against the BOOK, and the gesture happens on
 * the COPY, so everything rests on the translation between the two.
 *
 * Four things are worth a test, and they are the four ways this goes wrong.
 *
 * THE PAIRING ITSELF, because a strike landing one paragraph off is worse than a
 * strike that did not land — nobody looks at the file again. The copy is the book
 * minus what the cut took out, per document, in order, so the copy's Nth survivor
 * IS the book's Nth survivor.
 *
 * REPEATED TEXT, because it is the case a naive design gets wrong in the wrong
 * direction. Running heads, `* * *` separators and page numbers are exactly what
 * a user strikes out of a narration copy AND exactly what repeats, so a pairing
 * that looked an element up by what it says would refuse the whole common case.
 * Position settles what text cannot.
 *
 * THE REFUSAL, because a copy cut from an older book cannot be reconciled with
 * the book that is there now, and guessing which of the two is right is how a
 * deletion lands somewhere nobody looked.
 *
 * THE ROUND TRIP, on a real project with a real manifest: delete on the copy, and
 * the BOOK's key is what ends up on record — so the strike survives the next
 * regeneration, which is the whole point of recording it.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-pairing-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const { ZipReader, ZipWriter } = require(path.join(DIST, 'electron', 'epub-processor.js'));
const manifestService = require(path.join(DIST, 'electron', 'manifest-service.js'));
const narrationExport = require(path.join(DIST, 'electron', 'narration-export.js'));
const {
  pairNarrationCopyToBook,
  bookKeysForCopyKeys,
} = require(path.join(DIST, 'shared', 'vlm', 'narration-pairing.js'));

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        () => { results.push(['ok', name]); },
        (err) => { failures++; results.push(['FAIL', name, err && err.message]); }
      );
    }
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
  return Promise.resolve();
}

// ── Fixtures for the PURE pairing ────────────────────────────────────────────
//
// Signed elements, written by hand. The pure function never opens a book: it is
// handed what `signNarrationElements` produces, which is what keeps it testable
// without a DOM and keeps the signing rule in one place beside the writer.

/** A book element: key, what it says, and whether the cut leaves it behind. */
const B = (key, says, admitted = true) => ({ key, signature: `p|${says}`, admitted });
/** A copy element: key and what it says. */
const C = (key, says) => ({ key, signature: `p|${says}` });

const FILE = 'OEBPS/chapter-01.xhtml';

async function main() {
  // ── The pairing itself ─────────────────────────────────────────────────────

  await check('the copy\'s Nth survivor is the book\'s Nth survivor', () => {
    // The book's #1 and #3 are struck, so the copy holds #0, #2, #4 as 0, 1, 2.
    const pairing = pairNarrationCopyToBook({
      book: [
        B(`${FILE}#0`, 'alpha'),
        B(`${FILE}#1`, 'beta', false),
        B(`${FILE}#2`, 'gamma'),
        B(`${FILE}#3`, 'delta', false),
        B(`${FILE}#4`, 'epsilon'),
      ],
      copy: [C(`${FILE}#0`, 'alpha'), C(`${FILE}#1`, 'gamma'), C(`${FILE}#2`, 'epsilon')],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, true, pairing.reason);
    assert.strictEqual(pairing.pairs.get(`${FILE}#0`), `${FILE}#0`);
    // The one that matters: the copy's SECOND element is the book's THIRD.
    assert.strictEqual(pairing.pairs.get(`${FILE}#1`), `${FILE}#2`);
    assert.strictEqual(pairing.pairs.get(`${FILE}#2`), `${FILE}#4`);
  });

  await check('elements that all say the same thing pair by POSITION, not by text', () => {
    // A running head repeated on every page — the case a signature lookup cannot
    // answer at all, and the case a user most wants to strike.
    const pairing = pairNarrationCopyToBook({
      book: [
        B(`${FILE}#0`, 'CHAPTERONE'),
        B(`${FILE}#1`, 'body'),
        B(`${FILE}#2`, 'CHAPTERONE'),
        B(`${FILE}#3`, 'more body', false),
        B(`${FILE}#4`, 'CHAPTERONE'),
      ],
      copy: [
        C(`${FILE}#0`, 'CHAPTERONE'),
        C(`${FILE}#1`, 'body'),
        C(`${FILE}#2`, 'CHAPTERONE'),
        C(`${FILE}#3`, 'CHAPTERONE'),
      ],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, true, pairing.reason);
    // Three identical signatures, three DIFFERENT book keys — no ambiguity, and
    // nothing refused.
    assert.strictEqual(pairing.pairs.get(`${FILE}#0`), `${FILE}#0`);
    assert.strictEqual(pairing.pairs.get(`${FILE}#2`), `${FILE}#2`);
    assert.strictEqual(pairing.pairs.get(`${FILE}#3`), `${FILE}#4`);
    // Every copy key maps somewhere different: the table is injective, which is
    // what "no two gestures strike one paragraph" means.
    assert.strictEqual(new Set(pairing.pairs.values()).size, pairing.pairs.size);
  });

  await check('pictures and text units are two namespaces, lined up separately', () => {
    const pairing = pairNarrationCopyToBook({
      book: [
        B(`${FILE}#0`, 'alpha'),
        B(`${FILE}#1`, 'beta', false),
        { key: `${FILE}#img0`, signature: 'img|images/a.jpg', admitted: false },
        { key: `${FILE}#img1`, signature: 'img|images/b.jpg', admitted: true },
      ],
      copy: [
        C(`${FILE}#0`, 'alpha'),
        { key: `${FILE}#img0`, signature: 'img|images/b.jpg' },
      ],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, true, pairing.reason);
    // The copy's picture 0 is the book's picture 1 — the text strike did not
    // shift it, and the picture strike did.
    assert.strictEqual(pairing.pairs.get(`${FILE}#img0`), `${FILE}#img1`);
    assert.strictEqual(pairing.pairs.get(`${FILE}#0`), `${FILE}#0`);
  });

  await check('a document struck WHOLE is not expected in the copy', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha'), B('OEBPS/bm01.xhtml#0', 'index entry')],
      copy: [C(`${FILE}#0`, 'alpha')],
      struckDocuments: ['OEBPS/bm01.xhtml'],
    });
    assert.strictEqual(pairing.ok, true, pairing.reason);
    assert.strictEqual(pairing.pairs.size, 1);
  });

  await check('a document the strikes emptied is pruned, and that is not a mismatch', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha'), B('OEBPS/cover.xhtml#0', 'cover', false)],
      copy: [C(`${FILE}#0`, 'alpha')],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, true, pairing.reason);
  });

  // ── The refusals, each naming what the user can do ────────────────────────

  await check('a copy with the wrong NUMBER of elements is refused, naming the document', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha'), B(`${FILE}#1`, 'beta'), B(`${FILE}#2`, 'gamma')],
      copy: [C(`${FILE}#0`, 'alpha'), C(`${FILE}#1`, 'beta')],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, false);
    assert.ok(pairing.reason.includes(FILE), pairing.reason);
    assert.ok(/should hold 3 text element\(s\)/.test(pairing.reason), pairing.reason);
    assert.ok(/holds 2/.test(pairing.reason), pairing.reason);
    assert.ok(/Generate the TTS copy again/.test(pairing.reason), pairing.reason);
  });

  await check('a copy that says something ELSE is refused, quoting both sides', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha'), B(`${FILE}#1`, 'the book says this')],
      copy: [C(`${FILE}#0`, 'alpha'), C(`${FILE}#1`, 'the copy says that')],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, false);
    assert.ok(pairing.reason.includes('the copy says that'), pairing.reason);
    assert.ok(pairing.reason.includes('the book says this'), pairing.reason);
    assert.ok(pairing.reason.includes('text element 2'), pairing.reason);
  });

  await check('a copy holding a document the book does not have is refused BY NAME', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha')],
      copy: [C(`${FILE}#0`, 'alpha'), C('OEBPS/ghost.xhtml#0', 'from another book')],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, false);
    assert.ok(pairing.reason.includes('OEBPS/ghost.xhtml'), pairing.reason);
  });

  await check('a document the book kept and the copy lacks is refused BY NAME', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha'), B('OEBPS/ch02.xhtml#0', 'chapter two')],
      copy: [C(`${FILE}#0`, 'alpha')],
      struckDocuments: [],
    });
    assert.strictEqual(pairing.ok, false);
    assert.ok(pairing.reason.includes('OEBPS/ch02.xhtml'), pairing.reason);
    assert.ok(/1 element\(s\) nobody struck/.test(pairing.reason), pairing.reason);
  });

  await check('a deletion record handed in as an element is refused, not signed', () => {
    assert.throws(() => pairNarrationCopyToBook({
      book: [{ key: `${FILE}#doc`, signature: 'p|x', admitted: true }],
      copy: [],
      struckDocuments: [],
    }), /names a whole document/);
  });

  // ── Translating a gesture ─────────────────────────────────────────────────

  await check('a gesture becomes the book keys, in the order it named them', () => {
    const pairing = pairNarrationCopyToBook({
      book: [
        B(`${FILE}#0`, 'alpha'),
        B(`${FILE}#1`, 'beta', false),
        B(`${FILE}#2`, 'gamma'),
        B(`${FILE}#3`, 'delta'),
      ],
      copy: [C(`${FILE}#0`, 'alpha'), C(`${FILE}#1`, 'gamma'), C(`${FILE}#2`, 'delta')],
      struckDocuments: [],
    });
    const out = bookKeysForCopyKeys(pairing, [`${FILE}#2`, `${FILE}#1`]);
    assert.strictEqual(out.ok, true, out.reason);
    assert.deepStrictEqual(out.keys, [`${FILE}#3`, `${FILE}#2`]);
  });

  await check('a gesture naming an element the copy does not have strikes NOTHING', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha')],
      copy: [C(`${FILE}#0`, 'alpha')],
      struckDocuments: [],
    });
    const out = bookKeysForCopyKeys(pairing, [`${FILE}#0`, `${FILE}#99`]);
    assert.strictEqual(out.ok, false);
    assert.ok(out.reason.includes(`${FILE}#99`), out.reason);
    assert.ok(/Nothing was struck/.test(out.reason), out.reason);
  });

  await check('a refused pairing carries its own reason through, unchanged', () => {
    const pairing = pairNarrationCopyToBook({
      book: [B(`${FILE}#0`, 'alpha'), B(`${FILE}#1`, 'beta')],
      copy: [C(`${FILE}#0`, 'alpha')],
      struckDocuments: [],
    });
    const out = bookKeysForCopyKeys(pairing, [`${FILE}#0`]);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, pairing.reason);
  });

  // ── The round trip, on a real book and a real manifest ────────────────────
  //
  // The pure tests above prove the arithmetic. This proves the thing the feature
  // promises: the user points at a paragraph IN THE TTS COPY, and the key that
  // lands on record is the BOOK's — so the next regeneration still drops it.

  const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:sha256:pairing</dc:identifier>
<dc:title>The Paired Book</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`;

  // A real book states its chapter names, and the cut reads them: a chapter
  // opening SPEAKS its stored title in the narration copy, so its signature on
  // the book's side is the override's text rather than the printed one. A
  // fixture without a table of contents would never exercise that.
  const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="chapter-01.xhtml">Chapter One: The Paired Book</a></li>
</ol></nav></body>
</html>`;

  // Two paragraphs that say EXACTLY the same thing, on purpose: the round trip
  // has to pick the right one of them, and only position can.
  const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>One</title></head>
<body>
<h1 data-bf-page="1" data-bf-cat="title">The Paired Book</h1>
<p data-bf-page="1" data-bf-cat="text">The first paragraph of the book, ordinary body prose and long enough to align.</p>
<p data-bf-page="1" data-bf-cat="text">A repeated running head that appears twice in this chapter.</p>
<p data-bf-page="2" data-bf-cat="text">A second paragraph on the following page, also ordinary and also long enough.</p>
<p data-bf-page="2" data-bf-cat="text">A repeated running head that appears twice in this chapter.</p>
<p data-bf-page="3" data-bf-cat="footnote">1. The footnote nobody wants read aloud.</p>
</body>
</html>`;

  async function buildEpub(name) {
    const zip = new ZipWriter();
    zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
    zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
    zip.addFile('OEBPS/content.opf', Buffer.from(OPF, 'utf8'));
    zip.addFile('OEBPS/nav.xhtml', Buffer.from(NAV, 'utf8'));
    zip.addFile('OEBPS/chapter-01.xhtml', Buffer.from(CHAPTER, 'utf8'));
    const out = path.join(ROOT, name);
    await zip.write(out);
    return out;
  }

  /** A library of one project, with a book on disk and a manifest that names it. */
  function makeProject(suffix) {
    const library = fs.mkdtempSync(path.join(ROOT, `lib-${suffix}-`));
    const projectId = 'The_Paired_Book_-_A_Author_-_1999';
    const projectDir = path.join(library, 'projects', projectId);
    fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'archive'), { recursive: true });
    const bookRel = 'source/The Paired Book.working.epub';
    const bookAbs = path.join(projectDir, 'source', 'The Paired Book.working.epub');
    // A family hangs off an archive-grade original, and its stem — the archive
    // file's own basename — is what the working copy's name has to agree with.
    // The bytes here are never read by anything the tests below drive; only the
    // file's presence and its basename ("The Paired Book", matching `bookRel`)
    // matter to `ensureBookFamilies`.
    const archiveRel = 'archive/The Paired Book.epub';
    fs.writeFileSync(path.join(projectDir, archiveRel), Buffer.from('PK archive placeholder'));
    fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({
      version: 2,
      projectId,
      type: 'book',
      metadata: { title: 'The Paired Book' },
      source: { type: 'epub', path: bookRel, originalFilename: 'The Paired Book.epub' },
      archive: [{ path: archiveRel, role: 'original', format: 'epub' }],
      outputs: { epub: { path: bookRel, modifiedAt: new Date().toISOString() } },
    }, null, 2));
    manifestService.setLibraryBasePath(library);
    return { projectDir, bookAbs, bookRel };
  }

  const CH = 'OEBPS/chapter-01.xhtml';

  /**
   * The chapter's markup, out of the copy.
   *
   * Read through the zip rather than off the file's bytes: an EPUB is DEFLATED,
   * so searching the raw file for a sentence finds nothing whether the sentence
   * is in the book or not — an assertion that passes for the wrong reason.
   */
  async function chapterOf(epubPath) {
    const zip = new ZipReader(epubPath);
    await zip.open();
    try {
      return (await zip.readEntry(CH)).toString('utf8');
    } finally {
      zip.close();
    }
  }

  await check('a deletion on the TTS copy records the BOOK\'s key, not the copy\'s', async () => {
    const p = makeProject('roundtrip');
    fs.copyFileSync(await buildEpub('book1.epub'), p.bookAbs);

    // One strike made the ordinary way, so the copy's indices are already
    // shifted against the book's — which is the whole difficulty.
    await narrationExport.editNarrationDeletions(
      p.projectDir, { strike: [`${CH}#1`], unstrike: [] });
    await narrationExport.exportNarrationEpub(p.projectDir, { stripSupMarkers: true });

    // The copy now holds: #0 title, #1 running head, #2 second para,
    // #3 running head, #4 footnote. The user points at the FOOTNOTE, which is
    // the book's #5.
    const result = await narrationExport.strikeInNarrationCopy(p.projectDir, [`${CH}#4`]);
    assert.deepStrictEqual(result.struckInBook, [`${CH}#5`]);

    // On record, both of them, against the book.
    const onDisk = await manifestService.readNarrationDeletions(p.projectDir);
    assert.deepStrictEqual(onDisk.elements, [`${CH}#1`, `${CH}#5`]);

    // And the FILE changed: the copy is a paragraph shorter than it was.
    assert.strictEqual(result.removedElements, 2);
    assert.ok(fs.existsSync(result.epubPath));
    const cut = await chapterOf(result.epubPath);
    assert.ok(!cut.includes('The footnote nobody wants read aloud'),
      'the struck footnote is still in the re-cut copy');
    console.log(`  [pairing] the re-cut took ${result.recutMs} ms`);
  });

  await check('the SECOND of two identical paragraphs is the one that goes', async () => {
    const p = makeProject('identical');
    fs.copyFileSync(await buildEpub('book2.epub'), p.bookAbs);
    await narrationExport.exportNarrationEpub(p.projectDir, { stripSupMarkers: true });

    // Nothing struck yet, so the copy's indices ARE the book's. The two running
    // heads are #2 and #4 and say exactly the same thing; the user points at the
    // second one.
    const result = await narrationExport.strikeInNarrationCopy(p.projectDir, [`${CH}#4`]);
    assert.deepStrictEqual(result.struckInBook, [`${CH}#4`]);

    // One of the two is gone and the other is still there — the test a text
    // lookup could not have passed either way round.
    const cut = await chapterOf(result.epubPath);
    const heads = cut.split('A repeated running head').length - 1;
    assert.strictEqual(heads, 1, `expected one running head left, found ${heads}`);
  });

  await check('a copy cut from an OLDER book refuses the deletion, and records nothing', async () => {
    const p = makeProject('stale');
    fs.copyFileSync(await buildEpub('book3.epub'), p.bookAbs);
    await narrationExport.exportNarrationEpub(p.projectDir, { stripSupMarkers: true });

    // The book is rewritten under the copy — what a Simplify or Translate pass
    // does. Every position after the first change has moved.
    fs.writeFileSync(p.bookAbs, fs.readFileSync(await buildEpub('book3b.epub')));
    fs.appendFileSync(p.bookAbs, Buffer.from([0]));

    await assert.rejects(
      () => narrationExport.strikeInNarrationCopy(p.projectDir, [`${CH}#4`]),
      (err) => /cut from an earlier version|Generate the TTS copy again|voids/i.test(err.message),
    );
  });

  await check('a copy written before the strip choice was recorded refuses BY NAME', async () => {
    const p = makeProject('nostrip');
    fs.copyFileSync(await buildEpub('book4.epub'), p.bookAbs);
    await narrationExport.exportNarrationEpub(p.projectDir, { stripSupMarkers: true });

    // What a record written by an older build looks like: everything except the
    // one thing no other record describes.
    const record = await manifestService.readNarrationEpubRecord(p.projectDir);
    delete record.strippedSupMarkers;
    await manifestService.registerNarrationEpub(p.projectDir, record);

    await assert.rejects(
      () => narrationExport.strikeInNarrationCopy(p.projectDir, [`${CH}#4`]),
      /footnote reference numbers were taken out/,
    );
    // Nothing landed: the refusal is before the write, not after it.
    const onDisk = await manifestService.readNarrationDeletions(p.projectDir);
    assert.strictEqual(onDisk, null);
  });

  await check('a project with no TTS copy at all refuses, naming the act that makes one', async () => {
    const p = makeProject('nocopy');
    fs.copyFileSync(await buildEpub('book5.epub'), p.bookAbs);
    await assert.rejects(
      () => narrationExport.strikeInNarrationCopy(p.projectDir, [`${CH}#4`]),
      /no TTS copy on record.*Generate it from your book/s,
    );
  });

  await check('a deletion that names nothing is a bug, and says so', async () => {
    const p = makeProject('empty');
    fs.copyFileSync(await buildEpub('book6.epub'), p.bookAbs);
    await assert.rejects(
      () => narrationExport.strikeInNarrationCopy(p.projectDir, []),
      /named no elements/,
    );
  });

  // ── Report ────────────────────────────────────────────────────────────────
  for (const [status, name, detail] of results) {
    console.log(`  ${status === 'ok' ? 'ok ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`\n${results.length - failures}/${results.length} passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp dir */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
