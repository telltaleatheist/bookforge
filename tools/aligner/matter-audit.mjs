#!/usr/bin/env node
/**
 * matter-audit — check relabelling decisions against the geometry they claim.
 *
 *   node tools/aligner/matter-audit.mjs [--in <dir>]
 *
 * The apply step in matter-relabel.mjs enforces SHAPE: every page present,
 * every block covered, every label legal. That catches a malformed file. It
 * cannot catch a confidently wrong answer, which is the failure mode that
 * matters — a corpus that looks complete and teaches the wrong thing.
 *
 * So this checks the claims against the blocks themselves. A `header` sitting
 * at 60% down the page, a `title` set in body type, a `footnote` running
 * 900 characters: each is a label contradicted by the evidence on the page.
 * None is proof of an error — a bibliography really can carry a 900-character
 * entry — which is why these are reported for a human to read, not enforced.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ROOT = '/Volumes/Callisto/training/rubric';
const WORK = opt('in', path.join(ROOT, 'matter-relabel'));

// Chunk boundaries move between extracts, so pages are gathered by PID from
// whatever chunk files exist and decisions are enumerated separately. Binding
// the two by chunk name would make this script fail purely because the work was
// re-cut, which says nothing about the labels.
const files = fs.readdirSync(WORK);
const chunkFiles = files.filter(f => f.endsWith('.json')
  && !f.endsWith('.decisions.json') && f !== '_index.json');
const decisionFiles = files.filter(f => f.endsWith('.decisions.json')).sort();

const byPid = new Map();
const bookOf = new Map();
for (const f of chunkFiles) {
  const chunk = JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf-8'));
  for (const p of chunk.pages) { byPid.set(p.pid, p); bookOf.set(p.pid, chunk.book); }
}
// Font-size reference: each book's own modal size, so "large" means large FOR
// THIS SCAN. Raw points are meaningless across books (7 to 16 measured).
const bookSizes = new Map();
for (const [pid, p] of byPid) {
  const b = bookOf.get(pid);
  if (!bookSizes.has(b)) bookSizes.set(b, []);
  for (const blk of p.blocks) if (blk.fsize) bookSizes.get(b).push(blk.fsize);
}
const bookMode = new Map();
for (const [b, sizes] of bookSizes) {
  sizes.sort((x, y) => x - y);
  bookMode.set(b, sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10);
}

const labelCounts = new Map();
const kindCounts = new Map();
const suspects = [];
const unsure = [];
let decided = 0, pagesSeen = 0;
let expected = 0;
for (const p of byPid.values()) expected += p.blocks.filter(b => b.decide).length;

for (const f of decisionFiles) {
  const e = { chunk: f.replace(/\.decisions\.json$/, '') };
  const dec = JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf-8'));
  for (const u of dec.unsure || []) unsure.push({ chunk: e.chunk, ...u });

  for (const pid of Object.keys(dec.pages || {})) {
    const page = byPid.get(pid);
    if (!page) { suspects.push(`${e.chunk}: unknown page "${pid}"`); continue; }
    const mode = bookMode.get(bookOf.get(pid)) ?? 10;
    const rule = dec.pages[pid];
    pagesSeen++;
    kindCounts.set(rule.kind || '?', (kindCounts.get(rule.kind || '?') || 0) + 1);
    const except = rule.except || {};

    // A decision naming a block that was never ours to touch.
    for (const i of Object.keys(except)) {
      const blk = page.blocks.find(b => String(b.i) === String(i));
      if (!blk) suspects.push(`${page.pid} except names block ${i}, which is not on the page`);
      else if (!blk.decide) suspects.push(`${page.pid} block ${i} was NOT front/back matter (was "${blk.label}") but got "${except[i]}"`);
    }

    for (const b of page.blocks) {
      if (!b.decide) continue;
      const label = except[String(b.i)] ?? rule.default;
      if (label == null) continue;
      decided++;
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);

      const [x0, y0, x1, y1] = b.bbox;
      const big = b.fsize >= mode * 1.4;
      const txt = (b.text || '').trim();

      if (label === 'header' && y0 > 15) {
        suspects.push(`${page.pid} i${b.i} header at y=${y0}% — not in the top band: ${JSON.stringify(txt.slice(0, 50))}`);
      }
      if (label === 'footer' && y0 < 80 && y0 > 15) {
        suspects.push(`${page.pid} i${b.i} footer at y=${y0}% — neither top nor bottom band: ${JSON.stringify(txt.slice(0, 50))}`);
      }
      if (label === 'title' && !big && b.chars > 60) {
        suspects.push(`${page.pid} i${b.i} title in body-sized type (${b.fsize} vs mode ${mode}), ${b.chars} chars: ${JSON.stringify(txt.slice(0, 50))}`);
      }
      if (label === 'footnote' && b.chars > 1200) {
        suspects.push(`${page.pid} i${b.i} footnote of ${b.chars} chars — unusually long`);
      }
      if (label === 'quote' && b.chars > 600) {
        suspects.push(`${page.pid} i${b.i} quote of ${b.chars} chars — unusually long for a dedication/epigraph`);
      }
      if ((label === 'chapter' || label === 'heading') && b.lines > 4) {
        suspects.push(`${page.pid} i${b.i} ${label} spanning ${b.lines} lines: ${JSON.stringify(txt.slice(0, 50))}`);
      }
    }
  }
}

console.log(`decision files: ${decisionFiles.length}, pages available: ${byPid.size}`);
if (pagesSeen < byPid.size) {
  console.log(`UNDECIDED PAGES: ${byPid.size - pagesSeen}`);
}
console.log(`pages decided: ${pagesSeen}, blocks decided: ${decided}/${expected}\n`);

console.log('new label distribution:');
for (const [l, n] of [...labelCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${l.padEnd(12)} ${String(n).padStart(5)}  ${(100 * n / decided).toFixed(1)}%`);
}

console.log('\npage kinds:');
for (const [k, n] of [...kindCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}

if (unsure.length) {
  console.log(`\nflagged unsure (${unsure.length}):`);
  for (const u of unsure.slice(0, 40)) {
    console.log(`  ${u.chunk} ${u.pid ?? ''} i${u.i ?? '?'}: ${u.why ?? ''}`);
  }
}

console.log(`\ngeometry/shape suspects (${suspects.length}) — read, do not assume wrong:`);
for (const s of suspects.slice(0, 60)) console.log('  ' + s);
if (suspects.length > 60) console.log(`  … and ${suspects.length - 60} more`);
