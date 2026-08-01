#!/usr/bin/env node
/**
 * matter-relabel — retire `front_matter` / `back_matter` by relabelling their
 * blocks with what they actually ARE.
 *
 *   node tools/aligner/matter-relabel.mjs extract [--out <dir>]
 *   node tools/aligner/matter-relabel.mjs apply   [--in  <dir>] [--dry]
 *   node tools/aligner/matter-relabel.mjs status  [--in  <dir>]
 *
 * WHY. Those two classes are 18.1% of the corpus and are defined by POSITION,
 * not appearance — align-core.mjs assigns them from `page < firstProsePage` /
 * `page > lastProsePage`, and the prompt already hands the model "47 of 300
 * (16% through the book)". So the model gets 18% of its marks from one number
 * it is told outright. Worse, align-core.mjs:101 OVERWRITES chapter/heading/
 * subheading inside front matter, taking examples straight out of the three
 * classes the v1 confusion matrix showed failing.
 *
 * An index is a `list`. Endnotes are `footnote`. A title page is `title`. Those
 * are facts about the blocks; "back matter" is a fact about where the page sits.
 *
 * WHY NOT JUST DELETE THE BLOCKS. A table of contents looks almost exactly like
 * a stack of chapter openings — short centred lines, a number at the right
 * margin. Dropped from training, the model meets one at inference with no
 * signal and calls it `chapter`, and those become spurious chapter breaks in
 * the exported EPUB. Relabelling keeps the discrimination; deleting loses it.
 *
 * EDITS THE SOURCES, not the derived corpus:
 *   ~/Documents/BookForge/training/<slug>/labels.json        (keyed by block id)
 *   ~/Documents/BookForge/training/aligned/<v>/dataset.jsonl (keyed by page+i)
 * so `gather-corpus` and `build-sft-dataset` rebuild clean afterwards.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const has = (name) => rest.includes(`--${name}`);

const ROOT = '/Volumes/Callisto/training/rubric';
const WORK = opt('out', opt('in', path.join(ROOT, 'matter-relabel')));
const MATTER = new Set(['front_matter', 'back_matter']);

/** The taxonomy after the retirement. `footnote_ref` goes too — 2 examples. */
export const NEW_LABELS = new Set(['body', 'title', 'chapter', 'heading',
  'subheading', 'quote', 'caption', 'footnote', 'header', 'footer', 'image',
  'table', 'list']);

/** Same identity rule gather-corpus uses, so work files line up with the corpus. */
function bookId(name) {
  const n = name.toLowerCase();
  if (n.startsWith('gods-people')) return 'gods-people';
  if (n.includes('twisted_cross') || n.includes('twisted-cross')) return 'twisted-cross';
  if (n.includes('gospel_of_lies') || n.includes('gospel-of-lies')) return 'gospel-of-lies';
  if (n.includes('understanding-jw')) return 'understanding-jw';
  if (n.includes('hitler-an-atheist') || n.includes('was-hitler')) return 'was-hitler-an-atheist';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

const EXCLUDE = new Set(['the-coming-of-the-third-reich-richard-j-evans-20',
  'animal-farm-george-orwell-1999']);

/**
 * Every page carrying at least one matter block, with ALL of that page's blocks.
 *
 * The whole page goes in on purpose. "Is this line an index entry or a
 * bibliography entry" is not answerable from the line — it is answerable from
 * the page it sits on, and from the heading three blocks up.
 */
function collect() {
  const books = new Map();
  const add = (book, page, rec) => {
    if (!books.has(book)) books.set(book, { book, pages: new Map(), totalPages: 0 });
    const b = books.get(book);
    b.pages.set(page, rec);
  };

  // 1. Hand-labelled sessions — keyed by the real block id.
  for (const slug of fs.readdirSync(ROOT)) {
    const file = path.join(ROOT, slug, 'labels.json');
    if (slug === 'aligned' || slug === 'corpus' || slug === 'sft'
      || slug === 'matter-relabel' || !fs.existsSync(file)) continue;
    const book = bookId(slug);
    if (EXCLUDE.has(book)) continue;
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));

    const byPage = new Map();
    for (const b of s.blocks) {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page).push(b);
    }
    for (const [page, pageBlocks] of byPage) {
      // gather-corpus sorts the same way; keep the two in lockstep so a block's
      // position in this file is its position in the corpus.
      const sorted = [...pageBlocks].sort((a, b) => a.y - b.y || a.x - b.x);
      if (!sorted.some(b => MATTER.has(s.labels[b.id]))) continue;
      const dim = s.pageDimensions?.[page] ?? { width: 612, height: 792 };
      add(book, page, {
        pid: `${book}#${page}`,
        page,
        totalPages: s.pageDimensions?.length ?? 0,
        blocks: sorted.map((b, j) => ({
          // Globally unique. Session block ids are `ocr_p0_hand_0`-style and are
          // only unique WITHIN a book — Pohl and Niemöller both have an
          // `ocr_p0_hand_0` — so keying by the bare id silently made one book's
          // decision overwrite another's. The pid carries the book.
          key: `${book}#${page}#${j + 1}`,
          blockId: b.id,
          slug,
          i: j + 1,
          label: s.labels[b.id] ?? null,
          decide: MATTER.has(s.labels[b.id]),
          bbox: [b.x / dim.width, b.y / dim.height,
            (b.x + b.width) / dim.width, (b.y + b.height) / dim.height]
            .map(v => Math.round(v * 100)),
          fsize: b.font_size, lines: b.line_count || 1, chars: b.char_count,
          text: (b.text || '').slice(0, 300),
        })),
      });
      books.get(book).totalPages = s.pageDimensions?.length ?? 0;
      books.get(book).source = 'session';
      books.get(book).slug = slug;
    }
  }

  // 2. Aligner books — page records already; key is variant#page#i.
  const alignedDir = path.join(ROOT, 'aligned');
  if (fs.existsSync(alignedDir)) {
    for (const variant of fs.readdirSync(alignedDir)) {
      const file = path.join(alignedDir, variant, 'dataset.jsonl');
      if (!fs.existsSync(file)) continue;
      const book = bookId(variant);
      if (EXCLUDE.has(book)) continue;
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        const blocks = rec.blocks || [];
        if (!blocks.some(b => MATTER.has(rec.labels?.[b.i]))) continue;
        add(book, `${variant}:${rec.page}`, {
          pid: `${variant}#${rec.page}`,
          page: rec.page,
          variant,
          totalPages: rec.pages ?? 0,
          blocks: blocks.map(b => ({
            key: `${variant}#${rec.page}#${b.i}`,
            variant,
            pageNum: rec.page,
            i: b.i,
            label: rec.labels?.[b.i] ?? null,
            decide: MATTER.has(rec.labels?.[b.i]),
            bbox: (b.bbox || []).map(v => Math.round(v * 100)),
            fsize: b.fsize, lines: b.lines, chars: b.chars,
            text: (b.text || '').slice(0, 300),
          })),
        });
        books.get(book).totalPages = Math.max(books.get(book).totalPages, rec.pages ?? 0);
        books.get(book).source = 'aligned';
      }
    }
  }
  return books;
}

/**
 * Work unit, sized in BYTES rather than pages. Pages vary 5x in weight — a
 * sparse Vellum book spends a page on one running head, a dense endnote page
 * carries forty blocks — so a page count splits the light books into needless
 * chunks while leaving the heavy ones oversized.
 */
const BUDGET = Number(opt('budget', '170000'));
const PAGE_CAP = Number(opt('page-cap', '60'));

/**
 * The reader-facing view of a page: no `key`, `blockId`, `slug`, `variant`.
 *
 * Those exist so `apply` can address a block in the file that stores it, and
 * they must NOT reach the chunk files — not only because a reader has no use
 * for them, but because chunking is sized in bytes, so adding an internal field
 * would silently re-cut every chunk boundary and orphan the decisions already
 * written against the old ones.
 */
function viewPage(p) {
  return {
    pid: p.pid,
    page: p.page,
    ...(p.variant ? { variant: p.variant } : {}),
    totalPages: p.totalPages,
    blocks: p.blocks.map(b => ({
      i: b.i, label: b.label, decide: b.decide, bbox: b.bbox,
      fsize: b.fsize, lines: b.lines, chars: b.chars, text: b.text,
    })),
  };
}

/** Greedy fill to the byte budget; a runt tail is folded back into its predecessor. */
function chunkPages(pages) {
  const out = [];
  let cur = [], size = 0;
  for (const p of pages) {
    const w = JSON.stringify(viewPage(p)).length;
    if (cur.length && (size + w > BUDGET || cur.length >= PAGE_CAP)) {
      out.push(cur); cur = []; size = 0;
    }
    cur.push(p); size += w;
  }
  if (cur.length) out.push(cur);
  if (out.length > 1) {
    const tail = out[out.length - 1];
    if (JSON.stringify(tail).length < BUDGET * 0.25
      && out[out.length - 2].length + tail.length <= PAGE_CAP * 1.5) {
      out[out.length - 2].push(...out.pop());
    }
  }
  return out;
}

if (cmd === 'extract') {
  fs.mkdirSync(WORK, { recursive: true });
  // Chunk boundaries move whenever the budget or the page payload changes, so
  // stale chunk files from an earlier run would leave pages listed twice.
  // Decisions are keyed by pid and survive re-chunking — never delete those.
  for (const f of fs.readdirSync(WORK)) {
    if (f.endsWith('.json') && !f.endsWith('.decisions.json') && f !== '_index.json') {
      fs.unlinkSync(path.join(WORK, f));
    }
  }
  const books = collect();
  let totalDecide = 0, totalPages = 0;
  const index = [];
  for (const [book, b] of [...books.entries()].sort()) {
    const pages = [...b.pages.values()].sort((x, y) => x.page - y.page);
    const chunks = chunkPages(pages);
    for (let c = 0; c < chunks.length; c++) {
      const slice = chunks[c];
      const name = chunks.length > 1 ? `${book}.part${c + 1}` : book;
      const decide = slice.reduce((n, p) => n + p.blocks.filter(x => x.decide).length, 0);
      const view = slice.map(viewPage);
      const bytes = JSON.stringify(view).length;
      fs.writeFileSync(path.join(WORK, `${name}.json`), JSON.stringify({
        chunk: name, book, source: b.source, totalPages: b.totalPages, pages: view,
      }, null, 1));
      index.push({ chunk: name, book, source: b.source, pages: slice.length, decide, bytes });
      totalDecide += decide; totalPages += slice.length;
      console.log(`${name.padEnd(54)} ${String(slice.length).padStart(3)} pages `
        + `${String(decide).padStart(5)} to decide  ${(bytes / 1024).toFixed(0)}KB`);
    }
  }
  fs.writeFileSync(path.join(WORK, '_index.json'), JSON.stringify(index, null, 1));
  console.log(`\n${books.size} books, ${index.length} chunks, ${totalPages} pages, `
    + `${totalDecide} blocks to relabel`);
}

/**
 * Expand page rules into per-block labels.
 *
 * A decision file names a DEFAULT for each page plus exceptions by block index,
 * because that is the shape of the truth: an endnotes page is entirely
 * `footnote` apart from its running head and folio. Listing 7,571 blocks
 * individually would be the same information, stated in a way nobody can check.
 */
function expand(problems) {
  const books = collect();
  const byPid = new Map();
  for (const b of books.values()) {
    for (const p of b.pages.values()) byPid.set(p.pid, p);
  }
  // Enumerate the DECISIONS, not the chunks. Chunking is a work-distribution
  // device whose boundaries move if the budget or the page payload changes;
  // decisions are keyed by pid, which is stable, so binding apply to chunk
  // names would orphan finished work for no reason.
  const decisionFiles = fs.readdirSync(WORK).filter(f => f.endsWith('.decisions.json')).sort();
  const all = new Map();
  const kinds = new Map();
  const seenPid = new Map();

  for (const f of decisionFiles) {
    const name = f.replace(/\.decisions\.json$/, '');
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf-8')); }
    catch (err) { problems.push(`${name}: unreadable JSON (${err.message})`); continue; }

    for (const [pid, rule] of Object.entries(d.pages || {})) {
      const page = byPid.get(pid);
      if (!page) { problems.push(`${name}: unknown page "${pid}"`); continue; }
      // Two files claiming the same page would make the result depend on read
      // order — the same silent-overwrite class of bug as duplicate block keys.
      if (seenPid.has(pid)) {
        problems.push(`page "${pid}" decided twice: ${seenPid.get(pid)} and ${name}`);
        continue;
      }
      seenPid.set(pid, name);
      kinds.set(pid, rule.kind || '?');
      const dflt = rule.default;
      if (dflt !== undefined && dflt !== null && !NEW_LABELS.has(dflt)) {
        problems.push(`${name}/${pid}: illegal default "${dflt}"`); continue;
      }
      const except = rule.except || {};
      for (const [i, label] of Object.entries(except)) {
        if (!NEW_LABELS.has(label)) problems.push(`${name}/${pid}: illegal label "${label}" for block ${i}`);
      }
      for (const blk of page.blocks) {
        if (!blk.decide) continue;
        const label = except[String(blk.i)] ?? dflt;
        if (label === undefined || label === null) {
          problems.push(`${name}/${pid}: block ${blk.i} has no default and no exception`);
          continue;
        }
        all.set(blk.key, label);
      }
    }
  }
  return { all, kinds, byPid, decisionFiles };
}

if (cmd === 'status') {
  const problems = [];
  const { all, byPid, decisionFiles } = expand(problems);
  let expected = 0;
  for (const p of byPid.values()) expected += p.blocks.filter(b => b.decide).length;
  console.log(`${decisionFiles.length} decision files`);
  for (const f of decisionFiles) console.log(`  ${f.replace(/\.decisions\.json$/, '')}`);
  console.log(`\n${all.size}/${expected} blocks resolved across ${byPid.size} pages`);
  if (problems.length) {
    console.log(`${problems.length} problems:`);
    for (const p of problems.slice(0, 25)) console.log('  ' + p);
  }
}

if (cmd === 'apply') {
  const dry = has('dry');

  // Gather + validate EVERYTHING before writing a single file. A half-applied
  // relabel across 13 books is far worse than a refusal.
  const problems = [];
  const { all, byPid } = expand(problems);

  // Every matter block must have a decision — silence is not a label.
  const expected = [];
  for (const p of byPid.values()) {
    for (const blk of p.blocks) if (blk.decide) expected.push(blk.key);
  }
  const missing = expected.filter(k => !all.has(k));
  if (missing.length) problems.push(`${missing.length} blocks have no decision (e.g. ${missing.slice(0, 3).join(', ')})`);
  const expectedSet = new Set(expected);
  const extra = [...all.keys()].filter(k => !expectedSet.has(k));
  if (extra.length) problems.push(`${extra.length} decisions name blocks that are not front/back matter (e.g. ${extra.slice(0, 3).join(', ')})`);

  if (problems.length) {
    console.error('REFUSING to apply:');
    for (const p of problems.slice(0, 25)) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`validated ${all.size} decisions`);
  if (dry) { console.log('--dry: nothing written'); process.exit(0); }

  // Group the edits by the file that stores them, addressing each block the way
  // ITS source addresses it — session blocks by their own id, aligned blocks by
  // (page, index). The decision itself is looked up by the globally unique key,
  // never by the storage id, because those ids repeat across books.
  const sessionEdits = new Map();     // slug -> Map(blockId -> label)
  const alignedEdits = new Map();     // variant -> Map("page#i" -> label)
  for (const p of byPid.values()) {
    for (const blk of p.blocks) {
      if (!blk.decide) continue;
      const label = all.get(blk.key);
      if (label === undefined) continue;
      if (blk.blockId != null) {
        if (!sessionEdits.has(blk.slug)) sessionEdits.set(blk.slug, new Map());
        sessionEdits.get(blk.slug).set(blk.blockId, label);
      } else {
        if (!alignedEdits.has(blk.variant)) alignedEdits.set(blk.variant, new Map());
        alignedEdits.get(blk.variant).set(`${blk.pageNum}#${blk.i}`, label);
      }
    }
  }

  // 1. sessions
  let touched = 0;
  for (const [slug, edits] of sessionEdits) {
    const file = path.join(ROOT, slug, 'labels.json');
    if (!fs.existsSync(file)) { console.error(`  MISSING ${file}`); process.exit(1); }
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    let n = 0;
    for (const [id, label] of edits) {
      if (!MATTER.has(s.labels[id])) {
        console.error(`  ${slug}: ${id} is "${s.labels[id]}", not front/back matter — aborting`);
        process.exit(1);
      }
      s.labels[id] = label; n++;
    }
    s.labelSet = [...NEW_LABELS];
    fs.writeFileSync(file, JSON.stringify(s, null, 1));
    console.log(`  ${slug}: ${n} relabelled`);
    touched += n;
  }

  // 2. aligned
  const alignedDir = path.join(ROOT, 'aligned');
  for (const [variant, edits] of alignedEdits) {
    const file = path.join(alignedDir, variant, 'dataset.jsonl');
    if (!fs.existsSync(file)) { console.error(`  MISSING ${file}`); process.exit(1); }
    let n = 0;
    const out = [];
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      for (const i of Object.keys(rec.labels || {})) {
        const label = edits.get(`${rec.page}#${i}`);
        if (label === undefined) continue;
        if (!MATTER.has(rec.labels[i])) {
          console.error(`  ${variant} p${rec.page} i${i} is "${rec.labels[i]}", not front/back matter — aborting`);
          process.exit(1);
        }
        rec.labels[i] = label; n++;
      }
      out.push(JSON.stringify(rec));
    }
    fs.writeFileSync(file, out.join('\n') + '\n');
    console.log(`  aligned/${variant}: ${n} relabelled`);
    touched += n;
  }

  console.log(`\n${touched} blocks relabelled. Next:`);
  console.log('  node tools/aligner/gather-corpus.mjs');
  console.log('  node tools/aligner/build-sft-dataset.mjs');
}

if (!['extract', 'apply', 'status'].includes(cmd)) {
  console.error('usage: matter-relabel.mjs <extract|apply|status> [--out/--in dir] [--dry]');
  process.exit(1);
}
