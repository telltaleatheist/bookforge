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
} = require(path.join(DIST, 'shared', 'vlm', 'narration-deletions.js'));

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

  // Where the pictures the matcher REFUSED live, so the refusal is legible.
  const refused = blocks.filter((b) => b.is_image && b.bf_element === undefined);
  if (refused.length > 0) {
    console.log(`\nimage blocks refused (no element, reported, not guessed): ${refused.length}`);
    for (const b of refused) console.log(`  page ${b.page}: ${b.text}`);
  }

  assert.strictEqual(sha(BOOK), beforeSha, 'THE BOOK WAS REWRITTEN');
  console.log('\nthe book on disk is byte-identical to what it was.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
