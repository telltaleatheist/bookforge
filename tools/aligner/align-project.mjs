#!/usr/bin/env node
/**
 * align-project — pre-label a BookForge project's OWN OCR blocks from a paired EPUB.
 *
 *   node --require ./cli/electron-stub.js tools/aligner/align-project.mjs \
 *        --blocks <training/{slug}/blocks.json> --epub <book.epub> \
 *        [--project <projects/{slug}>] [--out <dir>] [--book-id <title>] [--dry-run]
 *
 * The difference from `align-pair.mjs` is WHOSE BLOCKS get labelled. align-pair
 * brings its own render+Tesseract pass, so its blocks exist only inside its own
 * dataset.jsonl and can never be corrected by a human. This one starts from the
 * blocks the APP already stored (`cli/ocr-pdf.js --project`, i.e.
 * `manifest.editor.ocrBlocks` and the identically-segmented `blocks.json`), so
 * every label it produces is keyed to a block the picker's Label mode can edit.
 * The book therefore opens PRE-PAINTED and a human corrects from there.
 *
 * The alignment engine is `align-core.mjs`, unchanged and unforked — the same
 * anchor-4-gram + LIS + off-flow-verification + furniture machinery the batch CLI
 * and the app's in-editor "Align from EPUB" (`training:align`) already use.
 *
 * WHAT THIS ADDS IS A PRECISION GATE, and that is the whole point of the tool.
 * align-core is tuned for COVERAGE: it will call an unmatched block below the
 * prose envelope a footnote, an unmatched short island a caption, and an
 * unmatched line above the prose a chapter opening, because for a batch dataset a
 * ranked guess beats a hole. Here the output is handed to a person who will trust
 * what is already painted, so a wrong pre-label costs more than a missing one — it
 * has to be spotted and undone, and the ones that are not spotted become corpus
 * errors wearing a human's signature. So every guess-tier label is DROPPED and
 * only positively-attested ones survive:
 *
 *   body / quote / list  the block's words were found in the EPUB's paragraph,
 *                        blockquote or list-item flow, with enough of them to
 *                        rule out a coincidental 4-gram hit.
 *   chapter              the block's text IS an EPUB chapter-level heading
 *                        (near-exact, not merely overlapping) and does not
 *                        repeat across pages like a running head does.
 *   footnote             matched into EPUB footnote/endnote content AND sitting
 *                        in the page-bottom band (or on a page whose matched
 *                        blocks are overwhelmingly notes — a back-of-book Notes
 *                        page, where notes fill the whole measure).
 *   header / footer      UNMATCHED, short, inside the top/bottom band, and
 *                        either a bare page number or repeating across >= 5
 *                        pages. Position plus repetition, never position alone.
 *   title                the book's own title/subtitle/author, exact, on the
 *                        opening pages.
 *
 * Everything else is left UNLABELLED on purpose. In particular `caption`,
 * `image`, `table`, `heading` and `subheading` are never emitted: alignment has no
 * evidence for the first three at all, and the heading levels come out of the
 * EPUB's h2/h3 nesting, which is a different decision from the print book's
 * typographic levels. Those are precisely the classes the corpus is starving for
 * (docs/RUBRIC_TRAINING.md §2), which makes them the ones a plausible-looking
 * wrong pre-label would do the most damage to.
 *
 * TWO OUTPUTS, mirroring cli/ocr-pdf.js:
 *
 *   --project <dir>  paints the surviving categories into the manifest through
 *                    `electron/rubric-predictions.ts` — the same locked, atomic
 *                    write headless Detect uses, with the run snapshotted in
 *                    `editor.rubricPredictions` and hand labels left inviolable.
 *                    The run records `model: "epub-align"` so it is impossible to
 *                    confuse with a rubric model's predictions in the error report.
 *   --out <dir>      writes labels.json (the label-mode session shape
 *                    `gather-corpus.mjs` reads) + book.json + align-report.json.
 *
 * RUN IT WITH THE BOOK CLOSED. The picker rewrites `editor.ocrBlocks` on save, so
 * an open book will overwrite whatever this stores.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import * as cheerio from 'cheerio';

import { normTokens, parseEpub, buildStream, align, furniture, LABEL_SET } from './align-core.mjs';

/** One normalization, both sides of every comparison in this file. */
const norm = t => normTokens(t).join(' ');

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

function usage(msg) {
  if (msg) console.error(`align-project: ${msg}`);
  console.error(
    'usage: node --require ./cli/electron-stub.js tools/aligner/align-project.mjs\n' +
    '         --blocks <blocks.json> --epub <book.epub>\n' +
    '         [--project <projectDir>] [--out <dir>] [--book-id <title>]\n' +
    '         [--min-repeat 5] [--title-pages 15] [--dry-run]');
  process.exit(msg ? 1 : 0);
}
if (flag('help') || flag('h') || !argv.length) usage();

const blocksPath = opt('blocks');
const epubPath = opt('epub');
if (!blocksPath) usage('--blocks <blocks.json> is required');
if (!epubPath) usage('--epub <book.epub> is required');
if (!fs.existsSync(blocksPath)) usage(`no such file: ${blocksPath}`);
if (!fs.existsSync(epubPath)) usage(`no such file: ${epubPath}`);
const projectDir = opt('project');
const outDir = opt('out', path.dirname(path.resolve(blocksPath)));
const dryRun = flag('dry-run');

/**
 * How many distinct pages a short unmatched string must appear on before it counts
 * as a running head. align-core uses 3, which is enough for a dataset that will be
 * reviewed in bulk; a chapter title on a two-page spread repeated across a
 * three-page chapter would clear it. 5 is the threshold the pre-label brief sets
 * and it is the one place this tool deliberately diverges from the shared engine.
 */
const MIN_REPEAT = Number(opt('min-repeat', '5'));
/** How far into the book a `title` claim is still credible. */
const TITLE_PAGES = Number(opt('title-pages', '15'));

// ── the blocks the app stored ────────────────────────────────────────────────

/**
 * A previous run of THIS tool is undone before a new one starts.
 *
 * Splitting rewrites both blocks.json and `editor.ocrBlocks`, so re-running after
 * a policy change would otherwise cut already-cut blocks and leave the two
 * outputs describing different books. `blocks.presplit.json` is the exact
 * pre-split record, which makes the revert exact rather than a re-merge of
 * trimmed text: parents are restored from it, and the `<id>s1` children — whose
 * ids exist only because this tool minted them — are dropped.
 */
const presplitPath = path.join(path.dirname(path.resolve(blocksPath)), 'blocks.presplit.json');
let revertedSplits = 0;
{
  const cur = JSON.parse(fs.readFileSync(blocksPath, 'utf-8'));
  if (cur.segmentation === 'post-processed+epub-align-split') {
    if (!fs.existsSync(presplitPath)) {
      console.error(`align-project: ${blocksPath} was already split by this tool but ` +
        `${presplitPath} is missing — the original segmentation cannot be recovered.\n` +
        '  Re-OCR the book with cli/ocr-pdf.js --overwrite-ocr.');
      process.exit(1);
    }
    revertedSplits = cur.splitsApplied ?? 0;
    fs.copyFileSync(presplitPath, blocksPath);
    console.log(`[align-project] reverted ${revertedSplits} split(s) from a previous run ` +
      `(restored ${path.basename(blocksPath)} from blocks.presplit.json)`);
  }
}

const blocksFile = JSON.parse(fs.readFileSync(blocksPath, 'utf-8'));
if (!Array.isArray(blocksFile.blocks) || !blocksFile.blocks.length) {
  console.error(`align-project: ${blocksPath} carries no blocks`);
  process.exit(1);
}
if (blocksFile.segmentation !== 'post-processed') {
  // Files without the field are raw Tesseract paragraphs, a DIFFERENT segmentation
  // from the one the manifest holds — so the ids would not exist in the project and
  // the paint would be refused halfway through. Say so now.
  console.error(
    `align-project: ${blocksPath} is not the post-processed segmentation ` +
    `(segmentation=${blocksFile.segmentation ?? 'absent'}).\n` +
    '  Re-OCR it with cli/ocr-pdf.js so blocks.json and the manifest carry the same blocks.');
  process.exit(1);
}

// align-core's block shape, which blocks.json already uses (page/x/y/w/h/text/
// fsize/lineCount/pageW/pageH). Kept as a view over the originals so the id and
// the corpus fields travel with each block.
const blocks = blocksFile.blocks.map(b => ({
  id: b.id, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h,
  text: b.text, lineCount: b.lineCount ?? 1, fsize: b.fsize ?? 0,
  conf: b.conf ?? 0, pageW: b.pageW ?? 612, pageH: b.pageH ?? 792,
  raw: b,
}));
blocks.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

// ── the EPUB, and the book's own name ────────────────────────────────────────

console.log(`[align-project] EPUB: ${path.basename(epubPath)}`);
const segments = parseEpub(epubPath);
const segStats = {};
for (const s of segments) segStats[s.cat] = (segStats[s.cat] || 0) + 1;
console.log(`[align-project]   ${segments.length} segments:`, segStats);

/**
 * The EPUB's own chapter openers and its own title text, read structurally.
 *
 * align-core's segment stream cannot answer this. It maps h1 -> chapter, h2 ->
 * heading, h3+ -> subheading, which is right for a book that uses h1 for its
 * chapters and wrong for one that does not — and the Deathstalker EPUBs do not:
 * every chapter opens `<h2>CHAPTER FOUR</h2>` followed by `<h3>` for the display
 * title, with no h1 anywhere in the book. Read through align-core alone, seven
 * novels would contribute zero `chapter` blocks and a pile of `heading`/
 * `subheading` this tool is right not to emit. The heading LEVEL is meaningless
 * in isolation; what identifies a chapter opener is being the SHALLOWEST heading
 * level the book uses, standing at the head of its document.
 *
 * So: find the shallowest heading level present across the prose-bearing spine
 * documents, then take each document's LEADING run of headings — everything
 * before its first real paragraph — when that run starts at that level.
 * LABELING.md puts the chapter number and the chapter's display title both in
 * `chapter`, which is exactly that run; the run's concatenation is recorded too,
 * because Tesseract routinely delivers the two as one block.
 *
 * A prose-free short document is a title page or a part divider, not a chapter,
 * so its headings go to the title set instead — the same call align-core makes
 * for its own segments, kept in step here deliberately.
 */
function readEpubStructure(file) {
  const unzipList = f => execFileSync('unzip', ['-Z1', f], { encoding: 'utf-8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean);
  const unzipRead = (f, entry) => execFileSync('unzip', ['-p', f, entry], { encoding: 'utf-8', maxBuffer: 64 << 20 });

  const chapterHeads = new Set();
  const titleHeads = new Set();
  const add = (set, text) => { const k = norm(text); if (k) set.add(k); };

  const entries = unzipList(file);
  const container = unzipRead(file, entries.find(e => e.endsWith('container.xml')));
  const opfPath = /full-path="([^"]+)"/.exec(container)[1];
  const opfDir = path.posix.dirname(opfPath);
  const opf = unzipRead(file, opfPath);

  for (const re of [/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/gi,
                    /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi,
                    /<dc:publisher[^>]*>([\s\S]*?)<\/dc:publisher>/gi]) {
    for (const m of opf.matchAll(re)) add(titleHeads, m[1].replace(/<[^>]+>/g, ''));
  }

  const $opf = cheerio.load(opf, { xmlMode: true });
  const manifest = new Map();
  $opf('manifest > item').each((_, it) => manifest.set($opf(it).attr('id'), $opf(it).attr('href')));
  const docs = [];
  $opf('spine > itemref').each((_, ir) => {
    const href = manifest.get($opf(ir).attr('idref'));
    if (!href || !/x?html?$/i.test(href)) return;
    const full = opfDir && opfDir !== '.' ? `${opfDir}/${href}` : href;
    try { docs.push({ href, $: cheerio.load(unzipRead(file, full)) }); } catch { /* absent entry */ }
  });

  /** The leading run of headings, and whether the document carries real prose. */
  const scan = (doc) => {
    const $ = doc.$;
    const run = [];
    let level = 0, prose = 0, stop = false, firstLeaf = '';
    $('body').find('h1,h2,h3,h4,h5,h6,p,li,blockquote,td').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (/^h[1-6]$/.test(tag)) {
        if (!stop && text) {
          if (!run.length) level = Number(tag[1]);
          run.push(text);
        }
        return;
      }
      if (!firstLeaf && text) firstLeaf = text;
      // An image wrapper or a spacer paragraph is not prose and must not close
      // the run — the Deathstalker chapter openers put exactly that between the
      // chapter number and the chapter title.
      if (text.length < 40) return;
      stop = true;
      prose += text.length;
    });
    return { run, level, prose, firstLeaf };
  };

/**
 * A chapter opener in an EPUB that has no headings at all.
 *
 * Three of the seven Deathstalker EPUBs are `pdftohtml` output with not one
 * `<h1>`–`<h6>` in the book: a chapter begins with a plain `<p>` reading
 * `CHAPTER ONE` followed by the display title and then the prose, sometimes with
 * no space between them (`CHAPTER ONECharnel House`). There is still real
 * structure to read — the string stands at the head of a spine document — but
 * nothing align-core can see, and those three books contributed zero `chapter`
 * blocks, in a class the corpus has 388 examples of across the whole project.
 *
 * Only the opener PHRASE is taken, never the display title beside it: the phrase
 * is unambiguous, and the title would have to be guessed out of a run-on string.
 */
const NUMBER_WORDS = ['one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
  'twenty','thirty','forty','fifty'].sort((a, b) => b.length - a.length);
const NAMED_SECTIONS = /^\s*(prologue|epilogue|interlude|foreword|afterword)/i;

function openerPhrase(text) {
  const named = NAMED_SECTIONS.exec(text);
  if (named) return named[1];
  const m = /^\s*(chapter)\s*([A-Za-z0-9]+)/i.exec(text);
  if (!m) return null;
  const rest = m[2];
  if (/^\d{1,3}$/.test(rest)) return `${m[1]} ${rest}`;
  // `CHAPTER ONECharnel House` — pdftohtml drops the break, so the number word
  // and the display title arrive welded. Take the longest number word that
  // PREFIXES the run-on token; longest-first so NINETEEN is not read as NINE.
  const hit = NUMBER_WORDS.find(w => rest.toLowerCase().startsWith(w));
  return hit ? `${m[1]} ${rest.slice(0, hit.length)}` : null;
}

  /**
   * What a document IS, decided from its contents rather than its filename.
   *
   * align-core routes notes and index documents by NOTE_HINTS/BACK_HINTS on the
   * href, which works for a publisher EPUB that calls its notes file `notes.xhtml`
   * and fails completely for a Calibre conversion of a Kindle file, where every
   * document is `CR!C9A24G218X4VKBR6TB1A6091JAPC_split_051.html`. Himmler is
   * exactly that: its twenty-six endnote documents and its two index documents are
   * wrapped in `<blockquote>` — Calibre's rendering of an indented block — so
   * 7,607 of the book's 10,275 segments came out as `quote`, and the pre-labels
   * would have told a human that the entire back matter of a 1,052-page biography
   * is block quotation. Seventy-four percent `quote` is not a book, it is a
   * conversion artefact, and the shape of the entries says what they really are:
   * an endnote is `12. Author, Title (Place, Year), 45.`, an index entry ends in
   * page numbers.
   */
  const roleOf = (doc) => {
    const texts = [];
    doc.$('body').find('p,li,blockquote,div').each((_, el) => {
      if (doc.$(el).children('p,li,blockquote,div').length) return;   // leaves only
      const t = doc.$(el).text().replace(/\s+/g, ' ').trim();
      if (t) texts.push(t);
    });
    // Apparatus first — notes and index entries have a recognisable shape, and a
    // long endnote citation would otherwise read as prose to the test below.
    const median = (xs) => xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0;
    if (texts.length >= 20) {
      const numbered = texts.filter(t => /^\d{1,4}[.)]\s*\S/.test(t));
      if (numbered.length / texts.length >= 0.6) {
        // Numbered entries alone do not make a Notes section: a table of contents is
        // numbered too, and Himmler's is `<blockquote>`-wrapped like everything else
        // in this conversion, so it came out as 37 endnotes. An endnote is a
        // CITATION and runs long; a contents line is a title and runs short.
        // LABELING.md: a table of contents is always `list`.
        return median(numbered.map(t => t.length)) >= 60 ? 'notes' : 'index';
      }
      const folioTail = texts.filter(t => /\b\d{1,4}(–\d{1,4})?[,;]?\s*$/.test(t)).length;
      const shortish = texts.filter(t => t.length <= 120).length;
      if (texts.length >= 50 && folioTail / texts.length >= 0.4 && shortish / texts.length >= 0.8) return 'index';
    }

    // Prose, which VETOES the filename hints. align-core routes a document to a
    // whole-document category when its href looks like front or back matter, and
    // `BACK_HINTS` matches the substring "index" — which is the filename
    // `pdftohtml` gives its output and therefore what Calibre calls every document
    // in three of the Deathstalker EPUBs (`index_split_004.html`). Read through
    // align-core alone, an entire novel arrives as one back-of-book index: 3,244
    // `list` blocks and not one `body`. Long paragraphs are not index entries,
    // whatever the file is called.
    const proseLike = texts.filter(t => t.length >= 200);
    if (proseLike.length >= 5 && proseLike.length / texts.length >= 0.3) return 'content';
    return null;
  };
  const docRoles = new Map();
  for (const d of docs) {
    const role = roleOf(d);
    if (role) docRoles.set(d.href, role);
  }

  /**
   * Which heading levels open a chapter — a RANGE, not one level.
   *
   * The shallowest level alone is wrong for any book that gives its parts and its
   * front-matter sections a shallower tag than its chapters. Himmler is that book:
   * `h2` opens "PART I", "Note on Sources", "Glossary of Terms", `h3` opens all
   * twenty-six chapters. Taking the minimum found five named front sections and
   * missed every chapter in the book. The MODE is where the chapters are, because
   * chapters are what a book has most of; everything from the shallowest level
   * down to it is chapter-or-shallower, and LABELING.md puts the named sections
   * ("Notes", "Introduction", "Conclusion") in `chapter` too. Anything DEEPER than
   * the mode is a section heading inside a chapter, which this tool never emits.
   */
  const scanned = docs.map(scan);
  const levels = scanned.filter(s => s.prose > 0 && s.run.length).map(s => s.level);
  const freq = new Map();
  for (const l of levels) freq.set(l, (freq.get(l) ?? 0) + 1);
  let modal = 1;
  for (const [l, n] of freq) if (n > (freq.get(modal) ?? 0) || (n === freq.get(modal) && l < modal)) modal = l;
  const minLevel = levels.length ? Math.min(...levels) : 1;
  const topLevel = levels.length ? modal : 1;

  scanned.forEach((s) => {
    if (!s.run.length) {
      // No headings anywhere in this document: fall back to the opener phrase.
      if (s.prose > 0 && s.firstLeaf) {
        const phrase = openerPhrase(s.firstLeaf);
        if (phrase) add(chapterHeads, phrase);
      }
      return;
    }
    if (s.prose === 0) { for (const t of s.run) add(titleHeads, t); return; }
    // A document whose first heading is DEEPER than the book's chapter level is a
    // mid-chapter split (Calibre breaks long chapters at section heads); its
    // heading is a section heading, and this tool does not emit those.
    if (s.level < minLevel || s.level > topLevel) return;
    for (const t of s.run) add(chapterHeads, t);
    if (s.run.length > 1) add(chapterHeads, s.run.join(' '));
  });

  return { chapterHeads, titleHeads, topLevel, docRoles };
}

const { chapterHeads, titleHeads, topLevel, docRoles } = readEpubStructure(epubPath);
console.log(`[align-project]   chapter level h${topLevel}: ` +
  `${chapterHeads.size} chapter-opener strings, ${titleHeads.size} title strings`);

// Re-route the documents whose contents contradict align-core's filename-based
// role. Done to `segments` before the stream is built, so the alignment and the
// gate both see one answer.
if (docRoles.size) {
  // Which documents align-core gave a WHOLE-DOCUMENT category to — the front/back/
  // notes branch, which pushes every element under one label. Only those can be
  // overridden to `content`: a document align-core parsed structurally already
  // distinguishes its paragraphs from its headings, and flattening it to `body`
  // would throw that away.
  const catsPerDoc = new Map();
  for (const s of segments) {
    if (!catsPerDoc.has(s.doc)) catsPerDoc.set(s.doc, new Set());
    catsPerDoc.get(s.doc).add(s.cat);
  }
  const moved = { notes: 0, index: 0, content: 0 };
  for (const s of segments) {
    const role = docRoles.get(s.doc);
    if (role === 'notes' && s.cat !== 'chapter') { s.cat = 'footnote'; moved.notes++; }
    else if (role === 'index' && s.cat !== 'chapter') { s.cat = 'list'; moved.index++; }
    else if (role === 'content' && s.cat !== 'body' && catsPerDoc.get(s.doc).size === 1) {
      s.cat = 'body'; moved.content++;
    }
  }
  console.log(`[align-project]   re-roled by content: ${moved.notes} segments -> footnote, ` +
    `${moved.index} -> list, ${moved.content} -> body (${docRoles.size} documents)`);
  for (const k of Object.keys(segStats)) delete segStats[k];
  for (const s of segments) segStats[s.cat] = (segStats[s.cat] || 0) + 1;
  console.log('[align-project]   segments now:', segStats);
}

/**
 * How long the EPUB's own passage is, per segment — the credibility test for a
 * `quote`. A real block quotation is a passage; a one-line `<blockquote>` is a
 * conversion wrapper around something else (an abbreviation entry, a caption, a
 * cross-reference), and calling it `quote` teaches the model that any short
 * indented line is quotation.
 */
const segLen = segments.map(s => s.text.length);

const stream = buildStream(segments);
console.log(`[align-project]   stream: ${stream.words.length} words`);

// ── the shared engine, unmodified ────────────────────────────────────────────

console.log(`[align-project] aligning ${blocks.length} blocks`);
const results = align(blocks, stream);
furniture(blocks, results, segments);

// ── the precision gate ───────────────────────────────────────────────────────

/** Digits masked, so "page 214" and "page 215" are the same running head. */
const furnitureKey = t => normTokens(String(t).replace(/\d+/g, '#')).join(' ');

/**
 * Distinct pages each short string appears on — two maps, for two different jobs.
 *
 * `unmatched` is the evidence behind every `header`/`footer` emitted: the brief
 * asks for repetition among blocks the EPUB did not account for, and anything it
 * did account for is book content by definition.
 *
 * `all` is a VETO, and it has to include matched blocks. A running head carrying
 * the chapter's title matches that chapter's EPUB heading perfectly — align-core
 * says so itself ("known chapter title text wins wherever it sits on the page") —
 * so restricting the repetition test to unmatched blocks would let exactly the
 * blocks it exists to catch walk straight past it and be painted `chapter` on
 * every page of the chapter. The cost is losing the genuine opener in books whose
 * running head repeats it; that is the trade this tool is supposed to make.
 */
//
// NOTE the definition of "matched" here. `furniture()` REWRITES results[i] to
// `{ matched: true, furniture: 'header', ... }` for every block it eliminates by
// position, so `r.matched` alone means "align-core reached a conclusion", not
// "the EPUB accounted for these words". Reading it as the latter put every
// running head in the wrong bucket and left the repetition rules firing on
// nothing.
const isContent = i => results[i].matched && !results[i].furniture;

const repeatPages = { all: new Map(), unmatched: new Map() };
blocks.forEach((b, i) => {
  if (b.text.length > 80) return;
  const k = furnitureKey(b.text);
  if (!k) return;
  for (const which of isContent(i) ? ['all'] : ['all', 'unmatched']) {
    if (!repeatPages[which].has(k)) repeatPages[which].set(k, new Set());
    repeatPages[which].get(k).add(b.page);
  }
});
const repeatCount = (b, which) =>
  (b.text.length > 80 ? 0 : repeatPages[which].get(furnitureKey(b.text))?.size ?? 0);

/**
 * The book's own page-numbering offset, learned from the page numbers that DID
 * arrive as blocks of their own: printed number minus PDF page index, modal.
 *
 * This is the test that makes splitting a numeral off a paragraph safe. A stray
 * "4" at the foot of PDF page 280 is OCR noise; the printed folio there is 271 or
 * whatever the modal offset says, and nothing else available distinguishes the
 * two. Requiring agreement to within a page turns "there is a digit at the bottom"
 * — which is a guess — into positive evidence. Roman numerals are not accepted at
 * all in a merged block: a stray `i` or `l` off a page edge is far more common in
 * these scans than a front-matter folio welded to a paragraph.
 */
const folioOffset = (() => {
  const votes = new Map();
  blocks.forEach((b, i) => {
    if (isContent(i)) return;
    const m = /^\s*([0-9]{1,4})\s*$/.exec(b.text);
    if (!m) return;
    const off = Number(m[1]) - b.page;
    votes.set(off, (votes.get(off) ?? 0) + 1);
  });
  let best = null;
  for (const [off, n] of votes) if (!best || n > best.n) best = { off, n };
  return best && best.n >= 20 ? best : null;
})();
if (folioOffset) {
  console.log(`[align-project] folio offset ${folioOffset.off >= 0 ? '+' : ''}${folioOffset.off} ` +
    `(${folioOffset.n} standalone page numbers agree)`);
}

/** Which bands this book actually prints page numbers in, and how often. */
const folioBands = { header: 0, footer: 0 };
blocks.forEach((b, i) => {
  if (isContent(i)) return;
  if (!/^\s*([0-9]{1,4}|[ivxlc]{1,7})\s*$/i.test(b.text)) return;
  if ((b.y + b.h) / b.pageH <= 0.3) folioBands.header++;
  else if (b.y / b.pageH >= 0.7) folioBands.footer++;
});

/**
 * Pages whose matched content is overwhelmingly EPUB note text — a back-of-book
 * Notes section, where entries run the full measure instead of hugging the page
 * bottom. Without this the bottom-band rule would silently refuse to label the
 * densest footnote pages in the book.
 */
const notesPages = new Set();
{
  const perPage = new Map();
  blocks.forEach((b, i) => {
    const r = results[i];
    if (!r.matched || r.furniture || r.segIndex == null) return;
    const cat = segments[r.segIndex].cat;
    const p = perPage.get(b.page) ?? { n: 0, notes: 0 };
    p.n++; if (cat === 'footnote') p.notes++;
    perPage.set(b.page, p);
  });
  for (const [page, p] of perPage) if (p.n >= 3 && p.notes / p.n >= 0.6) notesPages.add(page);
}

const yTop = b => b.y / b.pageH;
const yBottom = b => (b.y + b.h) / b.pageH;

/**
 * Enough matched words to rule out a coincidental anchor.
 *
 * align-core accepts 0.55 on-flow because an unlabelled block costs it coverage.
 * A four-token block clearing 0.55 is two words in common with a nearby
 * paragraph, which is noise; the two-tier rule below asks either for length or
 * for near-perfect agreement.
 */
function strongMatch(b, r) {
  const n = b.toks?.length ?? 0;
  if (n >= 8) return r.ratio >= 0.7;
  if (n >= 4) return r.ratio >= 0.9;
  return false;
}

/**
 * The block's text IS one of these headings, not merely overlapping it.
 *
 * Exact first; then the two ways OCR legitimately disagrees about where a heading
 * begins and ends — it split a two-line opener, or it welded the number onto the
 * title. Both directions are bounded, so a paragraph that happens to quote a
 * chapter title cannot claim to be one.
 */
function isHeadingIn(set, text) {
  const k = norm(text);
  if (!k) return false;
  if (set.has(k)) return true;
  for (const hk of set) {
    if (hk.length < 8 || k.length < 8) continue;
    if (hk.includes(k) && k.length >= hk.length * 0.6) return true;
    if (k.includes(hk) && hk.length >= k.length * 0.7) return true;
  }
  return false;
}

const decisions = new Map();   // blockId -> { category, evidence, ratio, tier, segCat }
const rejected = {};           // reason -> n
const reject = (why) => { rejected[why] = (rejected[why] ?? 0) + 1; };

/**
 * Strings this book PROVED are furniture, and in which band.
 *
 * Recorded as rule 1 fires, so the split pass inherits the same evidence instead
 * of re-deriving a weaker version of it. Deriving the running-head list straight
 * from the repeat map was a real bug: in Himmler, index entries like "Soviet
 * Union:" and stray words like "conclusion" appear as standalone unmatched blocks
 * on well over five pages, and cutting them off the front of a paragraph produced
 * splits labelled `header` in the middle of the book. Repetition ALONE is not
 * furniture; repetition in a furniture band is.
 */
const provenFurniture = new Map();   // furnitureKey -> { header, footer }
const provenBand = (b, band) => {
  const k = furnitureKey(b.text);
  if (!k) return;
  const rec = provenFurniture.get(k) ?? { header: 0, footer: 0 };
  rec[band]++;
  provenFurniture.set(k, rec);
};

blocks.forEach((b, i) => {
  const r = results[i];
  const tier = r.why ?? (r.matched ? 'matched' : 'unmatched');
  const segCat = (r.matched && !r.furniture && r.segIndex != null) ? segments[r.segIndex].cat : null;
  const keep = (category, evidence) =>
    decisions.set(b.id, { category, evidence, ratio: Math.round((r.ratio ?? 0) * 100) / 100, tier, segCat });

  const t = b.text.trim();
  const repsAll = repeatCount(b, 'all');
  const reps = repeatCount(b, 'unmatched');
  const short = t.length <= 80;
  const inTop = yBottom(b) <= 0.25;
  const inBottom = yTop(b) >= 0.75;

  // 1. Repetition first, because it also VETOES the content classes below.
  if (!isContent(i) && short && reps >= MIN_REPEAT) {
    if (inTop) { keep('header', `repeats on ${reps} pages, top band`); provenBand(b, 'header'); return; }
    if (inBottom) { keep('footer', `repeats on ${reps} pages, bottom band`); provenBand(b, 'footer'); return; }
    reject('repeat-but-mid-page');
    return;
  }

  // 2. A bare page number. align-core recognised the shape; two checks are added
  //    because the shape alone is weak on a poor scan. A lone numeral mid-page is
  //    a list marker or a table cell, not furniture — hence the band. And a digit
  //    that does not agree with the book's own folio sequence is scanner speckle:
  //    Deathstalker Rebellion produces seventeen bottom-of-page "4"s across the
  //    book, and taking those as page numbers would put seventeen fabricated
  //    `footer` blocks into a starving class.
  if (tier === 'pagenum') {
    const band = inTop ? 'header' : inBottom ? 'footer' : null;
    if (!band) { reject('pagenum-mid-page'); return; }
    const digits = /^\s*([0-9]{1,4})\s*$/.exec(t);
    if (digits) {
      if (!folioOffset) { reject('pagenum-no-folio-sequence'); return; }
      if (Math.abs(Number(digits[1]) - (b.page + folioOffset.off)) > 1) {
        reject('pagenum-disagrees-with-folio'); return;
      }
      keep(band, `folio ${digits[1]} agrees with the book's sequence`);
      return;
    }
    // Roman numerals: front matter only, where they are the numbering scheme.
    if (b.page < TITLE_PAGES * 2) { keep(band, 'roman folio in the front matter'); return; }
    reject('roman-pagenum-outside-front-matter');
    return;
  }

  // 3. The block IS one of the book's own chapter openers. Checked against the
  //    EPUB's structure directly (readEpubStructure) rather than against
  //    align-core's h1/h2/h3 -> chapter/heading/subheading mapping, which is
  //    wrong for any book that does not open chapters with an h1.
  if (short && isHeadingIn(chapterHeads, b.text)) {
    if (repsAll >= MIN_REPEAT) { reject('chapter-text-repeats-as-running-head'); return; }
    // Chapter openers sit high on their page; the same words recognised in the
    // bottom third are a running foot or a cross-reference.
    if (yTop(b) > 0.6) { reject('chapter-low-on-page'); return; }
    keep('chapter', `EPUB chapter opener (h${topLevel} run)`);
    return;
  }

  // 4. The book's own title/author/imprint, and only where position agrees:
  //    the same publisher line is display type on the title page and prose on
  //    the copyright page, so position is doing real work here, not padding.
  if (short && b.page < TITLE_PAGES && isHeadingIn(titleHeads, b.text)) {
    if (repsAll >= MIN_REPEAT) { reject('title-text-repeats-as-running-head'); return; }
    keep('title', 'book title/author text on an opening page');
    return;
  }

  // A heading align-core recognised but this tool has no attested class for.
  if (tier === 'epub-title') { reject('epub-heading-not-chapter-or-title'); return; }

  // 5. Guess tiers from align-core's anchored-elimination pass. Every one of
  //    these is position-only inference with nothing from the EPUB behind it,
  //    which is exactly what this tool must not hand a human as a pre-label.
  //    Checked AFTER the heading tests: align-core calls any short unmatched line
  //    above the prose a chapter opening, so with these first, a book whose real
  //    chapter openers are unmatched (because its EPUB runs the opener into the
  //    first paragraph) had every one of them thrown away as an unattested guess
  //    before the evidence for them was ever consulted.
  if (tier === 'above-flow' || tier === 'below-flow' ||
      tier === 'weak:below-flow' || tier === 'weak:island' ||
      tier === 'repeat-above' || tier === 'repeat-below' || tier === 'repeat-nofly') {
    reject(`unattested:${tier}`);
    return;
  }


  // 6. Footnote text found in the EPUB, corroborated by where it sits.
  if (tier === 'inline-footnote' || segCat === 'footnote') {
    if (!strongMatch(b, r)) { reject('footnote-weak-match'); return; }
    if (yTop(b) >= 0.55 || notesPages.has(b.page)) {
      keep('footnote', notesPages.has(b.page)
        ? 'EPUB note text on a notes page' : 'EPUB note text in the page-bottom band');
      return;
    }
    reject('footnote-not-in-bottom-band');
    return;
  }

  // 7. Prose flow. `quote` and `list` are kept because the EPUB's own
  //    blockquote/li structure attests them — that is a fact about the book, not
  //    an inference from the scan.
  if (segCat === 'body' || segCat === 'quote' || segCat === 'list') {
    if (!strongMatch(b, r)) { reject(`weak-match:${segCat}`); return; }
    if (segCat === 'quote') {
      if (segLen[r.segIndex] < 120) { reject('quote-segment-too-short'); return; }
      // An illustration caption wrapped in the same `<blockquote>` the conversion
      // uses for everything indented. It is a `caption`, which this tool does not
      // emit — so it is dropped rather than passed off as quotation.
      if (/^\s*(ill|fig|figure|plate|map|photo|table)\b\.?\s*[\divxlc]/i.test(segments[r.segIndex].text)) {
        reject('quote-segment-is-a-caption'); return;
      }
    }
    keep(segCat, `matched EPUB ${segCat} flow`);
    return;
  }

  // 8. Everything align-core would call caption/image/table/heading/subheading.
  if (segCat) { reject(`class-not-emitted:${segCat}`); return; }
  reject('unmatched');
});

// ── mixed blocks: detect the category boundary, cut at the line edge ─────────
//
// Tesseract welds things that are not the same thing — a running head onto the
// first line of the paragraph under it, a page number onto the last line above
// it, a chapter opener onto the prose that follows. Over-segmentation is
// recoverable (label the halves the same and merge later); under-segmentation is
// not, because the merged block HAS no correct label, and a human staring at it
// in Label mode has no move that is right. So where the EPUB proves a boundary,
// the block is cut here rather than left for them.
//
// The cut position is found from the TEXT, not estimated from geometry: a known
// running head, a bare page number or a known chapter opener occupies a known
// number of leading (or trailing) tokens, and walking that many raw tokens gives
// an exact character offset. Geometry then has to AGREE — the offset must fall
// near a real line boundary, which is where the child bounding boxes come from.
// Both halves must independently earn a label under the same gate as everything
// else, and they must disagree; a "split" whose halves are both `body` is just a
// paragraph and is left alone.
//
// ID POLICY, matching `tools/split-ocr-block.js`: part 1 keeps the original id,
// part 2 becomes `<id>s1`. Splitting therefore never orphans a label already
// keyed to the block, it only narrows what that label refers to.

/** Raw-token spans, so a normalized token count converts to a character offset. */
function rawTokenSpans(text) {
  const spans = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, n: normTokens(m[0]).length });
  }
  return spans;
}

/** Character offset just past the first `n` normalized tokens, or null. */
function offsetAfterTokens(text, n) {
  let seen = 0;
  for (const s of rawTokenSpans(text)) {
    seen += s.n;
    if (seen >= n) return seen === n ? s.end : null;   // a token straddling the boundary is not a clean cut
  }
  return null;
}

/** Character offset at the START of the last `n` normalized tokens, or null. */
function offsetBeforeLastTokens(text, n) {
  const spans = rawTokenSpans(text);
  let seen = 0;
  for (let i = spans.length - 1; i >= 0; i--) {
    seen += spans[i].n;
    if (seen >= n) return seen === n ? spans[i].start : null;
  }
  return null;
}

/**
 * Align one piece of text on its own.
 *
 * `align()` takes an array, so a one-element array is a probe — the same
 * anchoring, the same verification, the same segment-majority attribution the
 * whole-book pass uses. Nothing about the matching is reimplemented here; only
 * the question is smaller.
 */
function probe(text) {
  const one = { text };
  const r = align([one], stream)[0];
  if (!r.matched || r.segIndex == null) return null;
  return { cat: segments[r.segIndex].cat, ratio: r.ratio, toks: one.toks.length };
}
const probeStrong = p => !!p && ((p.toks >= 8 && p.ratio >= 0.7) || (p.toks >= 4 && p.ratio >= 0.9));

/**
 * Running-head strings this book actually uses — the ones rule 1 already labelled
 * `header`/`footer` on their own, on at least MIN_REPEAT pages, with the band it
 * put them in. A key that never earned a furniture label standing alone is not
 * allowed to earn one welded to a paragraph.
 */
const runningHeads = [...provenFurniture.entries()]
  .map(([k, rec]) => ({ k, band: rec.header >= rec.footer ? 'header' : 'footer',
                        n: Math.max(rec.header, rec.footer) }))
  .filter(r => r.n >= MIN_REPEAT && r.k.length >= 4)
  .sort((a, b) => b.k.length - a.k.length);
const runningHeadBand = new Map(runningHeads.map(r => [r.k, r.band]));

const PAGE_NUM_HEAD = /^\s*([0-9]{1,4})[\s.:|]+/;
const PAGE_NUM_TAIL = /[\s.:|]+([0-9]{1,4})\s*$/;

/** Where the block's furniture ends / content begins, as character offsets. */
function candidateCuts(b) {
  const text = b.text;
  const nk = furnitureKey(text);
  const out = [];
  const push = (c, side, kind, key) => {
    if (c === null || c <= 0 || c >= text.length) return;
    out.push({ c, side, kind, key });
  };

  for (const { k: rh } of runningHeads) {
    if (nk === rh) continue;                       // the whole block IS the running head
    if (nk.startsWith(rh + ' ')) push(offsetAfterTokens(text, rh.split(' ').length), 'head', 'furniture', rh);
    if (nk.endsWith(' ' + rh)) push(offsetBeforeLastTokens(text, rh.split(' ').length), 'tail', 'furniture', rh);
  }
  const mh = PAGE_NUM_HEAD.exec(text);
  if (mh) push(mh[0].length, 'head', 'pagenum', mh[1]);
  const mt = PAGE_NUM_TAIL.exec(text);
  if (mt) push(text.length - mt[0].length, 'tail', 'pagenum', mt[1]);

  for (const h of chapterHeads) {
    if (h.length < 4 || nk === h) continue;
    if (nk.startsWith(h + ' ')) push(offsetAfterTokens(text, h.split(' ').length), 'head', 'chapter', h);
  }
  return out;
}

/**
 * Which line boundary a character offset falls on, if any.
 *
 * Line WIDTH is the proxy for character count — the only per-line quantity the
 * blocks carry, since hOCR word text is dropped at paragraph assembly.
 *
 * The tolerance is HALF A LINE, not a fixed share of the block, and that
 * distinction is what makes the test mean anything. At a flat 15% of block length,
 * a nine-line paragraph whose first word happens to be a proven running head
 * cleared the test trivially — one line is 11% of the block, so a cut after 10
 * characters "agreed" with the first line boundary. Himmler produced exactly that:
 * `conclusion that the indiscriminate shooting of hostages…` is one sentence
 * running on from the previous page, and it was cut into a `header` and a `body`.
 */
function lineEdgeFor(raw, c, textLen) {
  const lb = raw.lineBoxes ?? [];
  if (lb.length < 2) return null;
  const total = lb.reduce((n, l) => n + l.w, 0) || 1;
  const want = c / textLen;
  const tol = Math.max(0.02, 0.5 / lb.length);
  let best = null, cum = 0;
  for (let k = 0; k < lb.length - 1; k++) {
    cum += lb[k].w;
    const d = Math.abs(cum / total - want);
    if (!best || d < best.d) best = { k: k + 1, d };
  }
  return best && best.d <= tol ? best.k : null;
}

const bboxOf = (g) => {
  const x0 = Math.min(...g.map(l => l.x)), y0 = Math.min(...g.map(l => l.y));
  const x1 = Math.max(...g.map(l => l.x + l.w)), y1 = Math.max(...g.map(l => l.y + l.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Label a piece with its own geometry, under the same evidence rules as the gate. */
function labelPiece(text, geom, page, kind, lines) {
  const t = text.trim();
  if (!t) return null;
  const top = geom.y / geom.pageH, bottom = (geom.y + geom.h) / geom.pageH;
  if (kind === 'pagenum' || kind === 'furniture') {
    // Furniture welded onto a paragraph is always ONE line of it.
    if (lines !== 1) return null;
    const band = bottom <= 0.3 ? 'header' : top >= 0.7 ? 'footer' : null;
    if (!band) return null;
    // The book must actually print furniture in that band, proved by the blocks
    // where it arrived on its own.
    if (folioBands[band] < 5 && kind === 'pagenum') return null;
    if (kind === 'pagenum') {
      const n = Number(/([0-9]{1,4})/.exec(t)?.[1]);
      if (!folioOffset || !Number.isFinite(n)) return null;
      if (Math.abs(n - (page + folioOffset.off)) > 1) return null;
      return { category: band, evidence: `folio ${n} (offset ${folioOffset.off}) split off a merged block` };
    }
    // The band the string was PROVEN furniture in has to be the band it landed in
    // here; a running head cannot become a footer halfway through the book.
    const key = furnitureKey(t);
    if (runningHeadBand.get(key) !== band) return null;
    // A ONE-WORD running head is not enough to cut a paragraph on. "Conclusion" and
    // "Collapse" are both real running heads in Himmler AND ordinary words in its
    // prose, and a single token cannot tell the two apart. Two or more (a title
    // plus its folio, or a multi-word title) can.
    if (key.split(' ').length < 2) return null;
    return { category: band, evidence: `running head (proven ${band}) split off a merged block` };
  }
  if (kind === 'chapter') {
    return top <= 0.6 ? { category: 'chapter', evidence: 'EPUB chapter opener split off a merged block' } : null;
  }
  // content
  const p = probe(t);
  if (!probeStrong(p)) return null;
  if (p.cat === 'footnote') {
    return top >= 0.55 || notesPages.has(page)
      ? { category: 'footnote', evidence: 'EPUB note text, split off a merged block' } : null;
  }
  if (p.cat === 'body' || p.cat === 'quote' || p.cat === 'list') {
    return { category: p.cat, evidence: `matched EPUB ${p.cat} flow, split off a merged block` };
  }
  return null;
}

const splits = [];           // { parentId, page, parts:[{id,category,text}] }
const suspectedMixed = [];   // the owner's manual worklist

for (const b of blocks) {
  const raw = b.raw;
  if ((raw.lineCount ?? 1) < 2 || (raw.lineBoxes ?? []).length !== raw.lineCount) continue;
  const cuts = candidateCuts(b);
  if (!cuts.length) continue;

  let chosen = null;
  const misses = [];
  let anyOnLineEdge = false;
  for (const cut of cuts) {
    const k = lineEdgeFor(raw, cut.c, b.text.length);
    // No line edge means there is no merge here to find: the running head or the
    // numeral is a word or a figure inside the paragraph's own text, not a
    // separate line welded onto it. Those are not worklist entries — they are the
    // pattern firing on ordinary prose, and Himmler produces 398 of them against
    // 80 real candidates.
    if (k === null) { misses.push(`${cut.kind}/${cut.side}: cut is not at a line edge`); continue; }
    anyOnLineEdge = true;
    const lb = raw.lineBoxes;
    const groups = [lb.slice(0, k), lb.slice(k)];
    const geoms = groups.map(g => ({ ...bboxOf(g), pageH: b.pageH }));
    const texts = [b.text.slice(0, cut.c).trim(), b.text.slice(cut.c).trim()];
    const kinds = cut.side === 'head' ? [cut.kind, 'content'] : ['content', cut.kind];
    const labels = texts.map((t, i) => labelPiece(t, geoms[i], b.page, kinds[i], groups[i].length));
    if (!labels[0] || !labels[1]) {
      misses.push(`${cut.kind}/${cut.side}: ${labels[0] ? 'second' : 'first'} half is not independently labelable`);
      continue;
    }
    if (labels[0].category === labels[1].category) {
      misses.push(`${cut.kind}/${cut.side}: both halves label the same, not a boundary`);
      continue;
    }
    chosen = { cut, k, groups, geoms, texts, labels };
    break;
  }

  if (!chosen) {
    if (!anyOnLineEdge) continue;
    suspectedMixed.push({
      id: b.id, page: b.page, lines: raw.lineCount,
      text: b.text.slice(0, 220),
      currentLabel: decisions.get(b.id)?.category ?? null,
      why: misses[0] ?? 'no candidate boundary survived',
      candidates: cuts.map(c => ({ kind: c.kind, side: c.side, at: c.c, key: c.key })),
    });
    continue;
  }

  // Commit the split. The parent's own decision is dropped — it was a judgement
  // about a block that no longer exists.
  decisions.delete(b.id);
  const parts = chosen.groups.map((g, i) => {
    const bb = bboxOf(g);
    const id = i === 0 ? b.id : `${b.id}s${i}`;
    return {
      id, i, bb, lines: g.length, lineBoxes: g,
      text: chosen.texts[i],
      category: chosen.labels[i].category,
      evidence: chosen.labels[i].evidence,
    };
  });
  b.split = parts;
  for (const p of parts) {
    decisions.set(p.id, {
      category: p.category, evidence: p.evidence, ratio: 1,
      tier: 'split', segCat: null, splitFrom: b.id,
    });
  }
  splits.push({
    parentId: b.id, page: b.page, at: chosen.cut.c, lineEdge: chosen.k,
    boundary: `${chosen.cut.kind}/${chosen.cut.side}`,
    parts: parts.map(p => ({ id: p.id, category: p.category, text: p.text })),
  });
}

/**
 * The final block list: children in place of every parent that was cut.
 *
 * Both outputs consume this one array, so `blocks.json` and `editor.ocrBlocks`
 * cannot end up describing different books — the same reason `cli/ocr-pdf.js`
 * runs one post-processing pass for both writers.
 */
const outBlocks = [];
for (const b of blocks) {
  const raw = b.raw;
  if (!b.split) { outBlocks.push({ ...raw, page: b.page }); continue; }
  for (const p of b.split) {
    outBlocks.push({
      ...raw,
      id: p.id,
      x: p.bb.x, y: p.bb.y, w: p.bb.w, h: p.bb.h,
      text: p.text,
      category: p.category,
      lineCount: p.lines,
      lineBoxes: p.lineBoxes,
    });
  }
}

console.log(`[align-project] split ${splits.length} merged block(s) into ${splits.length * 2} parts; ` +
  `${suspectedMixed.length} left whole as suspected-mixed`);

// ── report ───────────────────────────────────────────────────────────────────

const counts = {};
for (const d of decisions.values()) counts[d.category] = (counts[d.category] ?? 0) + 1;
const pages = new Set(blocks.map(b => b.page));
const pct = n => `${(100 * n / outBlocks.length).toFixed(1)}%`;

console.log(`[align-project] labelled ${decisions.size}/${outBlocks.length} blocks (${pct(decisions.size)}) ` +
  `over ${pages.size} pages`);
console.log('[align-project] by class:', Object.fromEntries(
  Object.entries(counts).sort((a, b) => b[1] - a[1])));
console.log('[align-project] left unlabelled:', Object.fromEntries(
  Object.entries(rejected).sort((a, b) => b[1] - a[1])));
for (const s of splits.slice(0, 5)) {
  console.log(`[align-project] split p${s.page} ${s.boundary}: ` +
    `[${s.parts[0].category}] ${JSON.stringify(s.parts[0].text.slice(0, 60))} | ` +
    `[${s.parts[1].category}] ${JSON.stringify(s.parts[1].text.slice(0, 60))}`);
}

if (dryRun) { console.log('[align-project] --dry-run, nothing written'); process.exit(0); }

/**
 * The book's PDF as the LIBRARY holds it.
 *
 * `blocks.json` records the path the OCR was driven from, which here is the gold
 * pair's copy — byte-identical to the project's archive copy (ocr-pdf.js proved it
 * by sha256) but on a scratch volume. The corpus records provenance for someone
 * re-deriving a dataset months later, and the archive copy is the one that will
 * still be there, so that is the path written into labels.json and book.json.
 */
const projectPdf = (() => {
  if (!projectDir) return null;
  const archive = path.join(path.resolve(projectDir), 'archive');
  if (!fs.existsSync(archive)) return null;
  const hit = fs.readdirSync(archive).find(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('._'));
  return hit ? path.join(archive, hit) : null;
})();
const sourcePdf = projectPdf ?? blocksFile.pdf;

/** The block-category contract, read from the app rather than restated here. */
const BLOCK_CATEGORIES = (() => {
  try {
    return require_(path.join(REPO_ROOT, 'dist', 'shared', 'ocr', 'block-categories.js')).BLOCK_CATEGORIES;
  } catch { return []; }
})();
const regionOf = new Map(BLOCK_CATEGORIES.map(c => [c.id, c.region ?? 'body']));

// ── output A: the project paint ──────────────────────────────────────────────

if (projectDir) {
  const preds = require_(path.join(REPO_ROOT, 'dist', 'electron', 'rubric-predictions.js'));
  const ms = require_(path.join(REPO_ROOT, 'dist', 'electron', 'manifest-service.js'));
  const ref = preds.resolveProjectRef(projectDir);
  const { blocks: stored } = await preds.readProjectBlocks(ref);
  const storedIds = new Set(stored.map(b => b.id));

  // blocks.json and the manifest come out of ONE post-processing pass, so a
  // mismatch here means they were produced by different runs and every label is
  // keyed to blocks that no longer exist. Refuse whole rather than paint part.
  // Checked against the PARENT ids, before any split is applied.
  const strays = blocks.filter(b => !storedIds.has(b.id)).map(b => b.id);
  if (strays.length) {
    console.error(`align-project: ${strays.length} block id(s) from ${blocksPath} are not in ${ref.manifestPath} ` +
      `(e.g. ${strays.slice(0, 3).join(', ')}).\n` +
      '  blocks.json and the manifest are from different OCR runs — re-run cli/ocr-pdf.js with both outputs.');
    process.exit(1);
  }

  // Undo a previous run's splits, then apply this run's — one locked write, so the
  // manifest is never briefly holding half of each. Only ocrBlocks is touched; the
  // undo stack, paragraph breaks, merges and hand labels are left as found, the
  // same restraint `persistOcrToProject` shows.
  if (splits.length || revertedSplits) {
    const byParent = new Map();
    for (const b of blocks) if (b.split) byParent.set(b.id, b);
    const original = new Map(blocksFile.blocks.map(b => [b.id, b]));
    let restored = 0;
    const res = await ms.modifyManifest(ref.projectId, (manifest) => {
      const list = manifest.editor?.ocrBlocks;
      if (!Array.isArray(list)) throw new Error('manifest lost its ocrBlocks between read and write');
      const next = [];
      for (const sb of list) {
        // A child this tool minted, whose parent is back in the list: drop it.
        if (/s\d+$/.test(sb.id) && !original.has(sb.id) && original.has(sb.id.replace(/s\d+$/, ''))) {
          restored++;
          continue;
        }
        // A parent that a previous run cut down: put its geometry and text back.
        const orig = original.get(sb.id);
        const wasCut = orig && (orig.text !== sb.text || orig.lineCount !== sb.line_count);
        const base = wasCut ? {
          ...sb,
          x: orig.x, y: orig.y, width: orig.w, height: orig.h,
          text: orig.text, char_count: orig.text.length,
          line_count: orig.lineCount,
          line_boxes: (orig.lineBoxes ?? []).map(l => [l.x, l.y, l.w, l.h]),
        } : sb;

        const parent = byParent.get(sb.id);
        if (!parent) { next.push(base); continue; }
        for (const p of parent.split) {
          next.push({
            ...base,
            id: p.id,
            x: p.bb.x, y: p.bb.y, width: p.bb.w, height: p.bb.h,
            text: p.text,
            char_count: p.text.length,
            category_id: p.category,
            region: regionOf.get(p.category) ?? base.region ?? 'body',
            line_count: p.lines,
            line_boxes: p.lineBoxes.map(l => [l.x, l.y, l.w, l.h]),
          });
        }
      }
      manifest.editor.ocrBlocks = next;
    });
    if (!res.success) throw new Error(`failed to write ${ref.manifestPath}: ${res.error}`);
    if (restored) console.log(`[align-project] removed ${restored} child block(s) from a previous run`);
    if (splits.length) console.log(`[align-project] applied ${splits.length} split(s) to editor.ocrBlocks`);
  }

  const predictions = Object.fromEntries([...decisions].map(([id, d]) => [id, d.category]));
  const unpredicted = outBlocks.filter(b => !decisions.has(b.id)).map(b => b.id);
  const written = await preds.persistRubricPredictions(ref, {
    // The run's identity. `model` is what rubric-report and the picker surface,
    // so it carries the predictor name: these are alignment labels, and reading
    // them as a rubric checkpoint's output would corrupt every measurement made
    // against them.
    model: 'epub-align',
    predictor: 'epub-align',
    promptVersion: 0,
    epub: path.resolve(epubPath),
    blocksFile: path.resolve(blocksPath),
    ranAt: new Date().toISOString(),
    predictions, unpredicted,
    pages: pages.size,
  });
  console.log(`[align-project] painted ${written.applied} block(s) into ${written.manifestPath}`);
  if (written.skippedHandLabelled > 0) {
    console.log(`[align-project] left ${written.skippedHandLabelled} hand-labelled block(s) alone`);
  }
}

// ── output B: the corpus shape ───────────────────────────────────────────────

fs.mkdirSync(outDir, { recursive: true });

// blocks.json is rewritten when blocks were split, because the corpus and the
// manifest must describe the same blocks — that is the whole reason ocr-pdf.js
// feeds both writers from one pass. The pre-split file is kept beside it: it is
// the only record of what Tesseract actually produced.
if (splits.length) {
  const presplit = path.join(outDir, 'blocks.presplit.json');
  if (!fs.existsSync(presplit)) fs.copyFileSync(blocksPath, presplit);
  const tmp = `${blocksPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    ...blocksFile,
    segmentation: 'post-processed+epub-align-split',
    splitsApplied: splits.length,
    blocks: outBlocks,
  }, null, 1));
  fs.renameSync(tmp, blocksPath);
  console.log(`[align-project] rewrote ${blocksPath} with ${splits.length} split(s) ` +
    `(original kept as blocks.presplit.json)`);
}

/** blocks.json -> the label-mode session's block shape, field for field. */
const sessionBlocks = outBlocks.map(r => {
  const category = decisions.get(r.id)?.category ?? r.category;
  return {
    id: r.id, page: r.page, x: r.x, y: r.y, width: r.w, height: r.h,
    text: r.text,
    font_size: r.fsize, font_name: r.fontName ?? 'OCR',
    char_count: r.text.length,
    region: regionOf.get(category) ?? 'body',
    category_id: category,
    line_count: r.lineCount,
    line_boxes: (r.lineBoxes ?? []).map(l => [l.x, l.y, l.w, l.h]),
    is_ocr: true,
    ocr_confidence: r.conf,
    ...(r.bold !== undefined ? { is_bold: r.bold } : {}),
    ...(r.italic !== undefined ? { is_italic: r.italic } : {}),
  };
});

const labelsTarget = path.join(outDir, 'labels.json');
if (fs.existsSync(labelsTarget)) {
  // Same rule as `training-data.ts saveSession`: a labels.json is the only copy
  // of whatever labelling produced it, and this run cannot know whether the file
  // beside it is a human's work or its own from an hour ago.
  console.error(`[align-project] REFUSING to overwrite ${labelsTarget} — move it aside first`);
} else {
  const session = {
    version: 1,
    labelSet: LABEL_SET.filter(c => c !== 'discard'),
    savedAt: new Date().toISOString(),
    sourceFile: sourcePdf,
    blockSource: 'ocr',
    ocrEngine: blocksFile.engine ?? 'tesseract',
    pageDimensions: blocksFile.pageDimensions ?? [],
    blocks: sessionBlocks,
    // ONLY the attested ones. A session normally carries a label for every block;
    // this one is deliberately partial, and a missing key means "nobody has
    // judged this block yet", never "this block is body".
    labels: Object.fromEntries([...decisions].map(([id, d]) => [id, d.category])),
  };
  const tmp = `${labelsTarget}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 1));
  fs.renameSync(tmp, labelsTarget);
  console.log(`[align-project] wrote ${labelsTarget} (${decisions.size} labels, ${sessionBlocks.length} blocks)`);
}

const bookTarget = path.join(outDir, 'book.json');
if (!fs.existsSync(bookTarget)) {
  fs.writeFileSync(bookTarget, JSON.stringify({
    title: opt('book-id', path.basename(outDir)),
    pdfPath: sourcePdf,
    addedAt: new Date().toISOString(),
  }, null, 2));
}

// The provenance record. Which rule fired for each label, how strong the match
// was, and — as much to the point — what was thrown away and why: a class that
// shows up heavily in `rejected` is a class this book could contribute if the
// evidence rule were loosened, and there is no way to see that from labels.json.
fs.writeFileSync(path.join(outDir, 'align-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  predictor: 'epub-align',
  tool: 'tools/aligner/align-project.mjs',
  epub: path.resolve(epubPath),
  blocksFile: path.resolve(blocksPath),
  project: projectDir ? path.resolve(projectDir) : null,
  policy: { minRepeatPages: MIN_REPEAT, titlePages: TITLE_PAGES,
            neverEmitted: ['caption', 'image', 'table', 'heading', 'subheading'] },
  epubSegments: segStats,
  streamWords: stream.words.length,
  totals: { blocksBefore: blocks.length, blocks: outBlocks.length, pages: pages.size,
            labelled: decisions.size, split: splits.length, suspectedMixed: suspectedMixed.length },
  // The owner's manual-split worklist: blocks that look welded but that the
  // evidence could not cut safely. Kept whole and unlabelled on purpose.
  splits,
  suspectedMixed,
  counts, rejected,
  labels: Object.fromEntries([...decisions].map(([id, d]) => [id, d])),
}, null, 1));
console.log(`[align-project] wrote ${path.join(outDir, 'align-report.json')}`);
