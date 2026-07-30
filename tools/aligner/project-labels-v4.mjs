#!/usr/bin/env node
/**
 * project-labels-v4 — carry the hand-labelled corpus onto the split-only segmentation.
 *
 *   node tools/aligner/project-labels-v4.mjs --all [--dry-run]
 *   node tools/aligner/project-labels-v4.mjs --book Twisted_Cross_-_Bergen,_Doris_L_(1996)
 *   node tools/aligner/project-labels-v4.mjs --book aligned/understanding-jw --dry-run
 *
 * The Jul 30 2026 segmentation rework (e1fdfec) made block formation SPLIT-ONLY:
 * a new block only ever cuts an old one, never joins across a boundary, so every
 * new block nests wholly inside exactly one old labelled block (measured on a
 * full book: 100%, zero violations). The projection is therefore a containment
 * lookup, not a fuzzy match: each new block inherits the label of the old block
 * that contains it. No relabelling, no IoU thresholds, no judgement.
 *
 * The one imperfection is inherited, not created: an old block that merged two
 * things carried ONE label, and its children all inherit it — so one child may
 * be wrong where before the whole block was half-wrong. Those cases are exactly
 * the `splitParents` in the report: old blocks that produced more than one
 * child. They are the entire human review surface of this operation.
 *
 * Two source shapes, preserved exactly so gather-corpus.mjs runs unchanged:
 *   session   <slug>/labels.json      blocks in TextBlock shape + labels{id→class}
 *   aligned   aligned/<id>/dataset.jsonl   page records with normalized bboxes,
 *             labels{i→class} and human[]/aligned[] provenance tiers
 *
 * Originals are renamed to *.pre-v4, never destroyed — and a re-run projects
 * from the .pre-v4 file when present, so the tool is idempotent: it can never
 * project a projection.
 *
 * The Churches volume is the known special case: its old blocks are EMBEDDED
 * mupdf blocks, which do not share Tesseract boundaries, so containment is not
 * guaranteed there. Failures fall back to maximum-overlap (>=50% of the new
 * block's area), counted separately so the report shows how much of that book
 * rests on the weaker rule.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.join(os.homedir(), 'Documents', 'BookForge', 'training');
const LEGAL = new Set(['body', 'title', 'chapter', 'heading', 'subheading', 'quote',
  'caption', 'footnote', 'header', 'footer', 'image', 'table', 'list']);
const PAD = 2;          // pt — absorbs box-rounding, not disagreement
const OVERLAP_MIN = 0.5; // of the NEW block's area, for the fallback rule

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(`--${n}`);
const dryRun = has('dry-run');

/** Prefer the pristine original over a projected file — idempotence. */
function readSource(file) {
  const pre = `${file}.pre-v4`;
  if (fs.existsSync(pre)) return { path: pre, alreadyProjected: true };
  if (fs.existsSync(file)) return { path: file, alreadyProjected: false };
  return null;
}

function loadNewBlocks(dir) {
  const f = path.join(dir, 'blocks.json');
  if (!fs.existsSync(f)) return { error: 'no blocks.json (re-OCR not done yet)' };
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (d.segmentation !== 'post-processed') {
    return { error: 'blocks.json is the OLD raw-paragraph shape — re-OCR this book first' };
  }
  return { doc: d };
}

const contains = (outer, inner) =>
  inner.x >= outer.x - PAD && inner.y >= outer.y - PAD &&
  inner.x + inner.w <= outer.x + outer.w + PAD &&
  inner.y + inner.h <= outer.y + outer.h + PAD;

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The core: old labelled rects per page → label for each new block.
 * Old rects: { x, y, w, h, label, tier?, key } in page points.
 */
function project(newBlocks, oldByPage) {
  const out = [];
  const stats = { byContainment: 0, byOverlap: 0, dropped: 0 };
  const children = new Map();   // old key -> count
  for (const nb of newBlocks) {
    const olds = oldByPage.get(nb.page) ?? [];
    const rect = { x: nb.x, y: nb.y, w: nb.w, h: nb.h };
    let parent = olds.find(o => contains(o, rect));
    let via = 'containment';
    if (!parent) {
      const area = rect.w * rect.h;
      let best = null, bestA = 0;
      for (const o of olds) {
        const a = overlapArea(o, rect);
        if (a > bestA) { bestA = a; best = o; }
      }
      if (best && area > 0 && bestA / area >= OVERLAP_MIN) { parent = best; via = 'overlap'; }
    }
    if (!parent || !parent.label) { stats.dropped++; continue; }
    via === 'containment' ? stats.byContainment++ : stats.byOverlap++;
    children.set(parent.key, (children.get(parent.key) ?? 0) + 1);
    out.push({ nb, label: parent.label, tier: parent.tier, parent });
  }
  const splitParents = [...children.entries()].filter(([, n]) => n > 1);
  return { out, stats, splitParents };
}

function checkLegality(book, labels) {
  const illegal = [...new Set(labels)].filter(c => !LEGAL.has(c));
  if (illegal.length) {
    console.error(`  !! ${book}: labels outside the 13-class contract: ${illegal.join(', ')} — SKIPPED`);
    console.error('     (this indicates a stale pre-v3-taxonomy source file)');
    return false;
  }
  return true;
}

function report(entry) {
  const f = path.join(ROOT, 'projection-report-v4.json');
  const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
  all[entry.book] = entry;
  if (!dryRun) fs.writeFileSync(f, JSON.stringify(all, null, 1));
  const e = entry;
  console.log(`  old ${e.oldBlocks} -> new ${e.newBlocks}, labelled ${e.labelled} ` +
    `(containment ${e.byContainment}, overlap ${e.byOverlap}, dropped ${e.dropped}), ` +
    `split parents ${e.splitParents}`);
}

// ── session books ────────────────────────────────────────────────────────────

function projectSession(slug) {
  const dir = path.join(ROOT, slug);
  console.log(`\n== ${slug}`);
  const src = readSource(path.join(dir, 'labels.json'));
  if (!src) { console.error('  !! no labels.json'); return; }
  const nb = loadNewBlocks(dir);
  if (nb.error) { console.error(`  !! ${nb.error}`); return; }

  const s = JSON.parse(fs.readFileSync(src.path, 'utf-8'));
  const oldByPage = new Map();
  for (const b of s.blocks) {
    const label = s.labels?.[b.id];
    if (!oldByPage.has(b.page)) oldByPage.set(b.page, []);
    oldByPage.get(b.page).push({ x: b.x, y: b.y, w: b.width, h: b.height, label, key: b.id });
  }
  if (!checkLegality(slug, Object.values(s.labels ?? {}))) return;

  const { out, stats, splitParents } = project(nb.doc.blocks, oldByPage);

  const blocks = []; const labels = {};
  for (const { nb: b, label } of out) {
    blocks.push({
      id: b.id, page: b.page, x: b.x, y: b.y, width: b.w, height: b.h,
      text: b.text, font_size: b.fsize, font_name: b.fontName || 'OCR',
      char_count: (b.text || '').length, region: 'body', category_id: label,
      line_count: b.lineCount, is_ocr: true, ocr_confidence: b.conf,
      ...(b.bold !== undefined ? { is_bold: b.bold } : {}),
      ...(b.italic !== undefined ? { is_italic: b.italic } : {}),
    });
    labels[b.id] = label;
  }

  const oldKeyed = new Map(s.blocks.map(b => [b.id, b]));
  report({
    book: slug, kind: 'session',
    oldBlocks: s.blocks.length, newBlocks: nb.doc.blocks.length,
    labelled: blocks.length, ...stats, splitParents: splitParents.length,
    splitParentSamples: splitParents.slice(0, 10).map(([key, n]) => {
      const o = oldKeyed.get(key);
      return { page: o?.page, label: s.labels?.[key], childCount: n, text: (o?.text ?? '').slice(0, 80) };
    }),
  });

  if (dryRun) return;
  if (!src.alreadyProjected) fs.renameSync(src.path, `${src.path}.pre-v4`.replace('.pre-v4.pre-v4', '.pre-v4'));
  fs.writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({
    version: s.version ?? 1,
    labelSet: [...LEGAL],
    savedAt: s.savedAt ?? null,
    sourceFile: s.sourceFile,
    blockSource: 'ocr',
    ocrEngine: s.ocrEngine ?? 'tesseract',
    pageDimensions: nb.doc.pageDimensions,
    blocks, labels,
  }, null, 1));
  console.log('  wrote labels.json (original kept as labels.json.pre-v4)');
}

// ── aligned books ────────────────────────────────────────────────────────────

function projectAligned(id) {
  const dir = path.join(ROOT, 'aligned', id);
  console.log(`\n== aligned/${id}`);
  const src = readSource(path.join(dir, 'dataset.jsonl'));
  if (!src) { console.error('  !! no dataset.jsonl'); return; }
  const nb = loadNewBlocks(dir);
  if (nb.error) { console.error(`  !! ${nb.error}`); return; }

  const rows = fs.readFileSync(src.path, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
  const oldByPage = new Map();
  const rowByPage = new Map();
  let oldBlocks = 0;
  const allLabels = [];
  for (const r of rows) {
    rowByPage.set(r.page, r);
    const human = new Set((r.human ?? []).map(Number));
    const aligned = new Set((r.aligned ?? []).map(Number));
    const rects = [];
    for (const b of r.blocks) {
      const label = r.labels?.[b.i] ?? r.labels?.[String(b.i)];
      if (label) allLabels.push(label);
      rects.push({
        x: b.bbox[0] * r.pageWidth, y: b.bbox[1] * r.pageHeight,
        w: (b.bbox[2] - b.bbox[0]) * r.pageWidth, h: (b.bbox[3] - b.bbox[1]) * r.pageHeight,
        label, key: `${r.page}#${b.i}`,
        tier: human.has(Number(b.i)) ? 'human' : aligned.has(Number(b.i)) ? 'aligned' : undefined,
      });
      oldBlocks++;
    }
    oldByPage.set(r.page, rects);
  }
  if (!checkLegality(`aligned/${id}`, allLabels)) return;

  const { out, stats, splitParents } = project(nb.doc.blocks, oldByPage);

  // Rebuild page records: only pages that had an old record can carry labels.
  const perPage = new Map();
  for (const item of out) {
    if (!rowByPage.has(item.nb.page)) { stats.dropped++; continue; }
    if (!perPage.has(item.nb.page)) perPage.set(item.nb.page, []);
    perPage.get(item.nb.page).push(item);
  }
  const newRows = [];
  for (const [page, items] of [...perPage.entries()].sort((a, b) => a[0] - b[0])) {
    const r = rowByPage.get(page);
    items.sort((a, b) => a.nb.y - b.nb.y || a.nb.x - b.nb.x);
    const rec = {
      book: r.book, page, pages: r.pages,
      pageWidth: r.pageWidth, pageHeight: r.pageHeight,
      blocks: [], labels: {}, aligned: [], human: [],
    };
    items.forEach((item, j) => {
      const i = j + 1; const b = item.nb;
      rec.blocks.push({
        i,
        bbox: [b.x / r.pageWidth, b.y / r.pageHeight,
          (b.x + b.w) / r.pageWidth, (b.y + b.h) / r.pageHeight]
          .map(v => Math.round(v * 1000) / 1000),
        fsize: b.fsize, lines: b.lineCount, chars: (b.text || '').length,
        conf: Math.round((b.conf ?? 1) * 100) / 100,
        text: (b.text || '').slice(0, 400),
      });
      rec.labels[i] = item.label;
      if (item.tier === 'human') rec.human.push(i);
      else if (item.tier === 'aligned') rec.aligned.push(i);
    });
    newRows.push(rec);
  }

  report({
    book: `aligned/${id}`, kind: 'aligned',
    oldBlocks, newBlocks: nb.doc.blocks.length,
    labelled: out.length, ...stats, splitParents: splitParents.length,
    splitParentSamples: splitParents.slice(0, 10).map(([key, n]) => {
      const [page, i] = key.split('#');
      const r = rowByPage.get(Number(page));
      const b = r?.blocks.find(x => String(x.i) === i);
      return { page: Number(page), label: r?.labels?.[i], childCount: n, text: (b?.text ?? '').slice(0, 80) };
    }),
  });

  if (dryRun) return;
  if (!src.alreadyProjected) fs.renameSync(src.path, `${src.path}.pre-v4`);
  fs.writeFileSync(path.join(dir, 'dataset.jsonl'),
    newRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('  wrote dataset.jsonl (original kept as dataset.jsonl.pre-v4)');
}

// ── entry ────────────────────────────────────────────────────────────────────

const EXCLUDE = new Set(['Animal_Farm_-_George_Orwell_(1999)',
  'The_Coming_of_the_Third_Reich_-_Richard_J_Evans_(2004)',
  'aligned', 'corpus', 'sft', 'matter-relabel', 'dagger',
  'bonhoeffer-ethics', 'deliverance-handbook', 'hungarys-admiral-on-horseback',
  'siege-of-budapest', 'unspeakable-truths']);

const book = opt('book');
if (book) {
  book.startsWith('aligned/') ? projectAligned(book.slice(8)) : projectSession(book);
} else if (has('all')) {
  for (const slug of fs.readdirSync(ROOT)) {
    if (EXCLUDE.has(slug) || !fs.statSync(path.join(ROOT, slug)).isDirectory()) continue;
    if (!fs.existsSync(path.join(ROOT, slug, 'labels.json')) &&
        !fs.existsSync(path.join(ROOT, slug, 'labels.json.pre-v4'))) continue;
    projectSession(slug);
  }
  const alignedDir = path.join(ROOT, 'aligned');
  for (const id of fs.readdirSync(alignedDir)) {
    if (!fs.statSync(path.join(alignedDir, id)).isDirectory()) continue;
    projectAligned(id);
  }
} else {
  console.error('usage: project-labels-v4.mjs (--all | --book <slug or aligned/<id>>) [--dry-run]');
  process.exit(1);
}
