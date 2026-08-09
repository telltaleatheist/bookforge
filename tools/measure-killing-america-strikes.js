#!/usr/bin/env node
/**
 * The real-book measurement behind the record-authoritative-strikes change.
 *
 *   npx tsc -p tsconfig.electron.json
 *   node tools/measure-killing-america-strikes.js <path to a COPY of the book>
 *
 * Killing America (Harrison House, 2024) is the book the failure was measured
 * on: the user struck out the title pages, the printed contents, the copyright
 * page, the picture pages and all 668 footnote elements — and the narration copy
 * still had most of it. Two holes: images had no identity at all, and the strike
 * record was re-derived from the picker's volatile view on every save.
 *
 * This lays the book out exactly as the picker does (the same analyzer, the same
 * cache), simulates the session as ELEMENT strikes, cuts the copy, and reports
 * what came out. It never touches the library — hand it a COPY.
 *
 * Read-only on the input: `writeNarrationEpub` copies every zip entry across and
 * writes somewhere else entirely, and the sha of the input is checked at the end.
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'pdf-analyzer.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// quire paginates an EPUB in a real browser, and PDFAnalyzer now goes through
// quire for every EPUB — so this harness has to run under Electron.
require('./electron-relaunch').relaunchUnderElectron(__filename);

const BOOK = process.argv[2];
if (!BOOK || !fs.existsSync(BOOK)) {
  console.error('Usage: node tools/measure-killing-america-strikes.js <copy of the book.epub>');
  process.exit(1);
}
if (/^[Ee]:/.test(path.resolve(BOOK))) {
  console.error('Refusing to run against E:\\ — copy the book somewhere else first.');
  process.exit(1);
}

if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-measure-'));
}

const { PDFAnalyzer } = require(path.join(DIST, 'electron', 'pdf-analyzer.js'));
const {
  ZipReader, writeNarrationEpub, readEpubConversionUnits,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
const {
  deriveNarrationStrikes, describeUnstruckDeletions, narrationDeletedPages,
  narrationDeletedBlockIds, narrationDeletionEdit, splitNarrationDeletions,
} = require(path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));
const { refuseUnresolvedDeletions } =
  require(path.join(DIST, 'electron', 'narration-export.js'));
const { SUP_ELEMENT_PATTERN, supInnerText, isFootnoteMarkerSupText } =
  require(path.join(DIST, 'shared', 'text', 'sup-markers.js'));

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Spine documents, in order, with their sizes. */
async function documentsOf(epubPath) {
  const reader = new ZipReader(epubPath);
  await reader.open();
  try {
    const out = [];
    for (const entry of reader.getEntries()) {
      if (!/\.(xhtml|html|htm)$/i.test(entry)) continue;
      out.push({ entry, bytes: (await reader.readEntry(entry)).length });
    }
    return out;
  } finally {
    reader.close();
  }
}

(async () => {
  await require('./electron-relaunch').prepareQuireHost(DIST);
  console.log(`book: ${BOOK} (${fs.statSync(BOOK).size} bytes)`);
  const beforeSha = sha(BOOK);

  // ── Lay it out exactly as the picker does ────────────────────────────────
  // `analyzeQuick` opens the document and serves the cache; on a miss the block
  // layer comes from `analyzeText`, which is the same two-step the picker takes.
  const analyzer = new PDFAnalyzer();
  const quick = await analyzer.analyzeQuick(BOOK);
  const result = quick.textReady && quick.blocks !== undefined
    ? quick
    : await analyzer.analyzeText(BOOK);
  const blocks = result.blocks;
  console.log(`blocks: ${blocks.length}`);
  console.log(`categories from: ${JSON.stringify(result.categoryProvenance)}`);
  for (const w of result.warnings ?? []) console.log(`WARNING ${w}`);

  const withElement = blocks.filter((b) => b.bf_element !== undefined);
  const images = blocks.filter((b) => b.is_image);
  const imagesPlaced = images.filter((b) => b.bf_element !== undefined);
  console.log(
    `elements: ${withElement.length}/${blocks.length} blocks carry one; `
    + `images ${imagesPlaced.length}/${images.length} placed`);

  // ── The session, as the user made it ─────────────────────────────────────
  //
  // The four front-matter documents by name, struck as PAGES — which is the
  // gesture the user used — plus every element the book's own markup calls a
  // footnote, struck as blocks.
  const FRONT = ['cover.xhtml', 'htit.xhtml', 'title.xhtml', 'fm01.xhtml'];
  const fileOf = (b) => (b.bf_element ?? '').split('#')[0];
  const inFront = (b) => FRONT.some((f) => fileOf(b).endsWith(`/${f}`) || fileOf(b) === f);

  const frontPages = new Set(blocks.filter(inFront).map((b) => b.page));
  const footnoteBlockIds = new Set(
    blocks.filter((b) => b.category_id === 'footnote').map((b) => b.id));
  console.log(
    `session: ${frontPages.size} page(s) for ${FRONT.join(', ')}, `
    + `${footnoteBlockIds.size} footnote block(s)`);

  const laid = blocks.map((b) => ({
    id: b.id,
    page: b.page,
    ...(b.bf_element !== undefined ? { element: b.bf_element } : {}),
    unplaceable: b.is_footnote_marker === true,
    excerpt: (b.text ?? '').slice(0, 80),
  }));
  const strikes = deriveNarrationStrikes(laid, footnoteBlockIds, frontPages);
  console.log(
    `strikes: ${strikes.elements.length} element(s) `
    + `(${strikes.fromBlocks} from blocks, ${strikes.fromPages} from pages alone)`);
  const unstruck = describeUnstruckDeletions(strikes);
  if (unstruck) console.log(`UNSTRUCK ${unstruck}`);

  // The presentation the picker would rebuild from that record.
  const struckIds = new Set(
    laid.filter((b) => b.element !== undefined && strikes.elements.includes(b.element))
      .map((b) => b.id));
  console.log(`view: ${narrationDeletedPages(laid, struckIds).size} page(s) read as deleted`);

  // ── Cut the copy ─────────────────────────────────────────────────────────
  const before = await documentsOf(BOOK);
  const out = path.join(path.dirname(BOOK), 'measured.tts.epub');
  const written = await writeNarrationEpub(BOOK, out, strikes.elements);
  const after = await documentsOf(out);

  console.log(
    `\ncut: ${written.removedElements}/${written.totalElements} element(s) removed, `
    + `${written.removedSupMarkers} sup marker(s) stripped, `
    + `${written.removedDocuments.length} document(s) pruned`);
  // THE VERIFICATION, measured against the file on disk rather than the plan.
  // `writeNarrationEpub` re-opened the copy it had just written and re-walked it
  // with the same two enumerations that produced the keys; these are its counts.
  console.log(
    `verified: ${written.verifiedElements} element(s) alive in the copy, `
    + `${written.removedElements} struck, ${written.dissolvedElements} dissolved with what held `
    + `them = ${written.verifiedElements + written.removedElements + written.dissolvedElements}`
    + ` of ${written.totalElements}`);
  assert.strictEqual(
    written.verifiedElements + written.removedElements + written.dissolvedElements,
    written.totalElements,
    'the cut does not account for every element of the book');
  console.log(`pruned: ${written.removedDocuments.join(', ') || '(none)'}`);

  console.log('\ndocument                                   before      after');
  const afterBytes = new Map(after.map((d) => [d.entry, d.bytes]));
  for (const d of before) {
    const now = afterBytes.has(d.entry) ? String(afterBytes.get(d.entry)) : 'PRUNED';
    console.log(`${d.entry.padEnd(42)} ${String(d.bytes).padStart(6)} ${now.padStart(10)}`);
  }
  console.log(
    `\nfile: ${fs.statSync(BOOK).size} → ${fs.statSync(out).size} bytes; `
    + `documents ${before.length} → ${after.length}`);

  // ── The assertions the change is judged by ───────────────────────────────
  const named = (f) => before.map((d) => d.entry).find((e) => e.endsWith(`/${f}`) || e === f);
  for (const f of ['cover.xhtml', 'htit.xhtml', 'title.xhtml']) {
    const entry = named(f);
    assert.ok(entry, `${f} is not in this book at all`);
    assert.ok(written.removedDocuments.includes(entry), `${f} was NOT pruned`);
  }
  const fm01 = named('fm01.xhtml');
  if (fm01) {
    const survived = afterBytes.get(fm01);
    assert.ok(
      survived === undefined || survived < before.find((d) => d.entry === fm01).bytes,
      'fm01.xhtml was neither pruned nor emptied of anything');
    console.log(`fm01: ${survived === undefined ? 'PRUNED' : `${survived} bytes (was cut down)`}`);
  }

  // Not one footnote left anywhere in the copy — asked the way the picker asks
  // it, by laying the CUT book out and reading its categories off its markup.
  // (`readEpubConversionUnits` would answer nothing here: this book carries no
  // `data-bf-cat` at all, which is exactly why the markup reader exists.)
  const cutAnalyzer = new PDFAnalyzer();
  const cutQuick = await cutAnalyzer.analyzeQuick(out);
  const cut = cutQuick.textReady && cutQuick.blocks !== undefined
    ? cutQuick
    : await cutAnalyzer.analyzeText(out);
  const stillFootnotes = cut.blocks.filter((b) => b.category_id === 'footnote');
  console.log(
    `footnote blocks: ${footnoteBlockIds.size} in the book → ${stillFootnotes.length} in the copy`);
  assert.strictEqual(stillFootnotes.length, 0, 'footnotes survived into the narration copy');

  // The pictures nothing could name. There used to be nine of them in this book
  // — mupdf laid 6 picture blocks out of a `bm01.xhtml` that states 3 image
  // elements, and 3 out of a `back.xhtml` that states 4, so no ordinal could
  // settle any of them and every one of those deletions reached nothing. quire
  // hands the element key back on every block it reports, so the count is now
  // zero by construction rather than by luck — and it is asserted rather than
  // printed, because a picture that could not be named would be a regression.
  const refused = blocks.filter((b) => b.is_image && b.bf_element === undefined);
  for (const b of refused) console.log(`  UNNAMED PICTURE page ${b.page}: ${b.text}`);
  assert.strictEqual(refused.length, 0,
    'a picture of this book has no element key — every block quire reports carries one');

  // ── Session B: the plate gallery, struck as DOCUMENTS ────────────────────
  //
  // The other half of the same evening, measured on its own so the escalation
  // is legible. The user deletes the pages of the two back-matter documents;
  // `bm01.xhtml` states 3 image elements and mupdf laid 6 picture blocks out of
  // it, `back.xhtml` states 4 and laid out 3, so no ordinal can settle any of
  // the nine and every one of those deletions used to reach nothing. Every
  // ALIGNED block of both documents is struck, so both escalate to one
  // `<zip entry>#doc` key each — and the nine pictures go with the documents
  // without ever being identified.
  console.log('\n── the plate gallery, struck as documents ──────────────────────');
  const GALLERY = ['bm01.xhtml', 'back.xhtml'];
  const inGallery = (b) => GALLERY.some((f) => fileOf(b).endsWith(`/${f}`) || fileOf(b) === f);
  const galleryAligned = blocks.filter(inGallery);
  // The page SPAN the user selects on screen: from the first page holding one of
  // these documents' aligned blocks to the last. The pages between hold nothing
  // but pictures — no aligned block names a document on them at all — and they
  // are part of the gallery on screen, so they are part of the gesture.
  const first = Math.min(...galleryAligned.map((b) => b.page));
  const last = Math.max(...galleryAligned.map((b) => b.page));
  const galleryPages = new Set();
  for (let p = first; p <= last; p++) galleryPages.add(p);
  console.log(
    `session: pages ${first}–${last} (${galleryPages.size}), holding `
    + `${galleryAligned.length} aligned block(s) and `
    + `${blocks.filter((b) => galleryPages.has(b.page) && b.bf_element === undefined).length} `
    + 'block(s) nothing could be struck for');

  const gallery = deriveNarrationStrikes(laid, new Set(), galleryPages);
  const galleryReport = describeUnstruckDeletions(gallery);
  console.log(`strikes: ${JSON.stringify(gallery.elements)}`);
  console.log(`unresolved: ${galleryReport === null ? '(none)' : galleryReport}`);

  const galleryDocs = splitNarrationDeletions(gallery.elements);
  assert.deepStrictEqual(galleryDocs.elements, [],
    'the gallery produced element keys as well as document keys');
  assert.strictEqual(galleryDocs.documents.length, 2,
    `expected two struck documents, got ${JSON.stringify(galleryDocs.documents)}`);
  for (const f of GALLERY) {
    assert.ok(galleryDocs.documents.some((d) => d.endsWith(`/${f}`) || d === f),
      `${f} was not struck as a document`);
  }
  assert.strictEqual(galleryReport, null,
    'the gallery deletions still report something they could not reach');

  // The round trip: the record, projected back into the view, derives back to
  // the same two keys — so re-opening the book does not rewrite the record.
  const galleryStruckIds = new Set(narrationDeletedBlockIds(laid, gallery.elements));
  const galleryViewPages = narrationDeletedPages(laid, galleryStruckIds);
  const pageOfBlock = new Map(laid.map((b) => [b.id, b.page]));
  for (const id of [...galleryStruckIds]) {
    if (galleryViewPages.has(pageOfBlock.get(id))) galleryStruckIds.delete(id);
  }
  const galleryAgain = deriveNarrationStrikes(laid, galleryStruckIds, galleryViewPages);
  assert.deepStrictEqual(
    narrationDeletionEdit(new Set(gallery.elements), new Set(galleryAgain.elements)),
    { strike: [], unstrike: [] },
    'reloading the book would have rewritten the record');
  console.log(
    `view: ${galleryViewPages.size} page(s) read as deleted; re-derivation `
    + `${JSON.stringify(galleryAgain.elements)}`);

  const galleryOut = path.join(path.dirname(BOOK), 'measured-gallery.tts.epub');
  const galleryWritten = await writeNarrationEpub(BOOK, galleryOut, gallery.elements);
  const galleryAfter = await documentsOf(galleryOut);
  console.log(
    `\ncut: ${galleryWritten.removedElements}/${galleryWritten.totalElements} element(s) removed, `
    + `${galleryWritten.removedDocuments.length} document(s) pruned`);
  console.log(`pruned: ${galleryWritten.removedDocuments.join(', ') || '(none)'}`);
  console.log(
    `documents ${before.length} → ${galleryAfter.length}; `
    + `file ${fs.statSync(BOOK).size} → ${fs.statSync(galleryOut).size} bytes`);

  for (const f of GALLERY) {
    const entry = named(f);
    assert.ok(entry, `${f} is not in this book at all`);
    assert.ok(galleryWritten.removedDocuments.includes(entry), `${f} was NOT removed`);
    assert.ok(!galleryAfter.some((d) => d.entry === entry), `${f} is still in the zip`);
  }
  assert.strictEqual(galleryWritten.removedDocuments.length, 2,
    `${galleryWritten.removedDocuments.join(', ')} — more than the gallery went`);

  // The nine pictures, gone with their documents. Asked of the CUT book the way
  // the picker asks it: lay it out and count what is left.
  const galleryAnalyzer = new PDFAnalyzer();
  const galleryQuick = await galleryAnalyzer.analyzeQuick(galleryOut);
  const galleryCut = galleryQuick.textReady && galleryQuick.blocks !== undefined
    ? galleryQuick
    : await galleryAnalyzer.analyzeText(galleryOut);
  const refusedBefore = blocks.filter((b) => b.is_image && b.bf_element === undefined);
  const refusedAfter = galleryCut.blocks.filter((b) => b.is_image && b.bf_element === undefined);
  console.log(
    `pictures no ordinal could settle: ${refusedBefore.length} in the book → `
    + `${refusedAfter.length} in the copy`);
  assert.strictEqual(refusedAfter.length, 0,
    'the unmatchable pictures survived into the narration copy');
  for (const w of galleryCut.warnings ?? []) console.log(`copy WARNING ${w}`);

  // -- Session C: a deletion that reaches NOTHING, refused by name ----------
  //
  // The other half of the guarantee. This USED TO BE measured on the book: the
  // nine plate-gallery pictures no ordinal could settle were its real
  // uncoverable blocks, and struck ALONE -- without the documents that would
  // carry them out -- there was nothing the cut could do with them. The old
  // contract wrote the file anyway and returned a warning string; it now
  // refuses, and the sentence names the page and says what to do instead.
  //
  // quire took that case off this book, which is the whole point of quire:
  // every block carries the key of the element it IS, so there is no such block
  // here any more (asserted above). The refusal is still the contract, so it is
  // proved against a block CONSTRUCTED to have no element -- stated as a
  // construction rather than dressed up as a finding, because pretending to
  // discover a fault the book no longer has would be the dishonest way to keep
  // a test alive.
  console.log('\n-- one uncoverable deletion, refused ---------------------------');
  const anyPicture = blocks.find((b) => b.is_image);
  assert.ok(anyPicture, 'this book has no picture at all to build the case from');
  const orphan = { id: 'constructed-unnameable-picture', page: anyPicture.page, text: anyPicture.text };
  const orphanLaid = [
    ...laid,
    { id: orphan.id, page: orphan.page, unplaceable: false, excerpt: orphan.text.slice(0, 80) },
  ];
  const orphanStrikes = deriveNarrationStrikes(orphanLaid, new Set([orphan.id]), new Set());
  const refusal = refuseUnresolvedDeletions(orphanStrikes, 'the blocks you deleted');
  assert.ok(refusal !== null, 'striking an unmatchable picture alone did not refuse');
  assert.ok(/was not written/.test(refusal), 'the refusal does not say nothing was written');
  assert.ok(/strike the whole page or the whole document/i.test(refusal),
    'the refusal does not say what to do about it');
  console.log(refusal.split('\n').map((l) => `  ${l}`).join('\n'));

  // ...and the SAME picture, inside the documents struck whole, is carried out
  // without ever being identified. The refusal is about a deletion that reaches
  // nothing, not about a picture that cannot be named.
  assert.strictEqual(
    refuseUnresolvedDeletions(gallery, 'the pages you deleted'), null,
    'the gallery deletions were refused even though the documents carry them out');
  console.log('  the same picture, struck with its document: no refusal.');

  // -- The <sup> the marker strip leaves behind, measured -------------------
  //
  // The rule is digits-only (shared/text/sup-markers.ts). This measures what it
  // leaves in the copy on a real book, so the rule is judged by the case rather
  // than by argument.
  console.log('\n-- the sup markers, measured ------------------------------------');
  const supSurvivors = async (epubPath) => {
    const reader = new ZipReader(epubPath);
    await reader.open();
    try {
      const out = [];
      for (const entry of reader.getEntries()) {
        if (!/\.(xhtml|html|htm)$/i.test(entry)) continue;
        const xhtml = (await reader.readEntry(entry)).toString('utf8');
        xhtml.replace(new RegExp(SUP_ELEMENT_PATTERN.source, 'gi'), (whole, inner) => {
          if (!isFootnoteMarkerSupText(supInnerText(inner))) out.push({ entry, whole });
          return whole;
        });
      }
      return out;
    } finally {
      reader.close();
    }
  };
  const keptInBook = await supSurvivors(BOOK);
  const keptInCopy = await supSurvivors(out);
  console.log(
    `book: ${written.removedSupMarkers} marker(s) the rule strips, `
    + `${keptInBook.length} sup(s) it keeps -- ${keptInBook.map((k) => k.whole).join(' ')}`);
  console.log(
    `copy: ${keptInCopy.length} sup(s) left -- `
    + `${keptInCopy.map((k) => `${k.entry.split('/').pop()} ${k.whole}`).join(' ')}`);
  // Every sup left in the copy is an ORDINAL SUFFIX, not a note reference. It
  // holds no digit at all, so no widening of a digit-based rule reaches it, and
  // removing it would turn "the 28th state" into "the 28 state" -- which the
  // narrator reads as "the twenty-eight state". The rule is right; the survivor
  // is not a marker.
  for (const kept of keptInCopy) {
    assert.ok(/^<sup[^>]*>(th|st|nd|rd)<\/sup>$/i.test(kept.whole),
      `a sup that is not an ordinal suffix survived the strip: ${kept.entry} ${kept.whole}`);
  }
  assert.strictEqual(keptInCopy.length, 1,
    `expected exactly the one measured ordinal in the copy, got ${keptInCopy.length}`);

  assert.strictEqual(sha(BOOK), beforeSha, 'THE BOOK WAS REWRITTEN');
  console.log('\nthe book on disk is byte-identical to what it was.');
  require('electron').app.exit(0);
})().catch((err) => {
  console.error(err);
  require('electron').app.exit(1);
});
