#!/usr/bin/env node
/**
 * split-ocr-block — cut an under-segmented OCR block at a real line boundary.
 *
 *   node tools/split-ocr-block.js --project <dir> --block <id> --at <lineIndex> \
 *        --cats header,heading [--text-at "Chapter"] [--dry-run]
 *
 * WHY THIS EXISTS. Tesseract sometimes merges two things that are not the same
 * thing — classically a running head with the section heading under it, or a
 * footnote with the body above it. That block has no correct label, and labelling
 * it anyway teaches the model something false: that a block containing a section
 * heading is header material. Over-segmentation is recoverable by merging;
 * under-segmentation is not, which is why `tools/aligner/ocr-book.mjs` keeps
 * per-line boxes so ground truth can drive granularity instead of Tesseract's guess.
 *
 * The picker's own split popover cannot do this job, because `manifest.editor.ocrBlocks`
 * stores only the paragraph bbox — the per-line boxes are dropped on the way in, so
 * there is nothing in the manifest to cut on. This re-OCRs the ONE page to recover
 * the line geometry, then applies the cut to the stored block.
 *
 * The stored TEXT is kept, not the re-OCR's text. Two runs of Tesseract on the same
 * page produce near-identical geometry but can differ in characters, and the stored
 * text is what any existing label was judged against.
 *
 * ID POLICY: the first part KEEPS the original id, so a label or prediction already
 * keyed to this block stays attached to it. Later parts get `<id>s1`, `<id>s2`. That
 * means splitting never orphans an existing label, only narrows what it refers to.
 *
 * RACE WARNING: the picker writes `editor.ocrBlocks` on save. If the book is open,
 * reload it after this runs, or the app's in-memory copy will overwrite the split.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

function usage(msg) {
  if (msg) console.error(`split-ocr-block: ${msg}`);
  console.error(
    'usage: node tools/split-ocr-block.js --project <dir> --block <id> --at <lineIndex>\n' +
    '         [--cats a,b] [--text-at "<substring>"] [--dry-run]\n\n' +
    '  --at        0-based index of the line that STARTS the second part\n' +
    '  --cats      category per resulting part, in order (default: keep the original)\n' +
    '  --text-at   split the stored text before this substring instead of guessing\n' +
    '              by character-proportion (strongly preferred — exact)');
  process.exit(msg ? 1 : 0);
}
if (flag('help') || flag('h') || !argv.length) usage();

const projectDir = opt('project');
const blockId = opt('block');
const at = Number(opt('at'));
if (!projectDir) usage('--project <dir> is required');
if (!blockId) usage('--block <id> is required');
if (!Number.isInteger(at) || at < 1) usage('--at wants the 0-based index of the line starting part 2 (>=1)');
const cats = (opt('cats', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const textAt = opt('text-at', null);
const dryRun = flag('dry-run');

const manifestPath = path.join(path.resolve(projectDir), 'manifest.json');
if (!fs.existsSync(manifestPath)) usage(`no manifest at ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const blocks = manifest.editor && manifest.editor.ocrBlocks;
if (!Array.isArray(blocks) || !blocks.length) usage(`${manifestPath} has no editor.ocrBlocks`);

const idx = blocks.findIndex(b => b.id === blockId);
if (idx < 0) usage(`no block ${blockId} in this manifest`);
const block = blocks[idx];
if (block.line_count <= at) {
  usage(`block ${blockId} has ${block.line_count} line(s); --at ${at} is out of range`);
}

// ── recover the line boxes by re-OCRing this one page ────────────────────────
const archiveDir = path.join(path.resolve(projectDir), 'archive');
const pdf = fs.existsSync(archiveDir)
  ? fs.readdirSync(archiveDir).filter(f => f.toLowerCase().endsWith('.pdf')).map(f => path.join(archiveDir, f))[0]
  : null;
if (!pdf) usage(`no PDF in ${archiveDir} — cannot recover line geometry`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'split-ocr-'));
console.log(`[split] re-OCR page ${block.page} of ${path.basename(pdf)} for line geometry…`);
execFileSync('node', [
  '--require', path.join(REPO_ROOT, 'cli', 'electron-stub.js'),
  path.join(REPO_ROOT, 'cli', 'ocr-pdf.js'),
  pdf, '--out', scratch, '--pages', String(block.page), '--jobs', '1',
], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] });

const fresh = JSON.parse(fs.readFileSync(path.join(scratch, 'blocks.json'), 'utf-8'));
// Match by geometry, not by index: the raw pass is pre-post-processing, so its
// block list is a different length and a positional match would silently pick a
// neighbour. Nearest top-left within a tolerance is unambiguous at this scale.
const near = fresh.blocks
  .map(b => ({ b, d: Math.abs(b.y - block.y) + Math.abs(b.x - block.x) }))
  .sort((p, q) => p.d - q.d)[0];
if (!near || near.d > 12) {
  console.error(`[split] could not find the same block in the re-OCR (closest was ${near ? near.d.toFixed(1) : 'none'} pt away).`);
  console.error('        The stored blocks may predate the OCR_RENDER_SCALE fix, in which case');
  console.error('        their geometry does not correspond to a current OCR pass at all.');
  process.exit(1);
}
const lineBoxes = near.b.lineBoxes || [];
if (lineBoxes.length <= at) {
  console.error(`[split] the re-OCR found ${lineBoxes.length} line(s) here, so --at ${at} has no boundary.`);
  process.exit(1);
}
console.log(`[split] matched (${near.d.toFixed(1)} pt away), ${lineBoxes.length} line boxes`);

// ── work out where the text divides ─────────────────────────────────────────
const groups = [lineBoxes.slice(0, at), lineBoxes.slice(at)];
let textParts;
if (textAt) {
  const cut = block.text.indexOf(textAt);
  if (cut <= 0) {
    console.error(`[split] --text-at ${JSON.stringify(textAt)} not found in the stored text (or at position 0):`);
    console.error(`        ${JSON.stringify(block.text)}`);
    process.exit(1);
  }
  textParts = [block.text.slice(0, cut).trim(), block.text.slice(cut).trim()];
} else {
  // Fallback: proportional by line width. Adequate only when the caller cannot
  // name the boundary; it can land mid-word, so --text-at is preferred.
  const w = groups.map(g => g.reduce((n, l) => n + l.w, 0));
  const cut = Math.round(block.text.length * (w[0] / (w[0] + w[1])));
  textParts = [block.text.slice(0, cut).trim(), block.text.slice(cut).trim()];
  console.log('[split] NOTE: no --text-at, so the text was cut by line-width proportion — check it.');
}

const bboxOf = (g) => {
  const x0 = Math.min(...g.map(l => l.x)), y0 = Math.min(...g.map(l => l.y));
  const x1 = Math.max(...g.map(l => l.x + l.w)), y1 = Math.max(...g.map(l => l.y + l.h));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

const parts = groups.map((g, i) => {
  const bb = bboxOf(g);
  const fsizes = g.map(l => l.fontSize).filter(Boolean);
  const bolds = g.map(l => l.boldFrac).filter(v => v !== undefined);
  const italics = g.map(l => l.italicFrac).filter(v => v !== undefined);
  return {
    ...block,
    id: i === 0 ? block.id : `${block.id}s${i}`,
    ...bb,
    text: textParts[i],
    char_count: textParts[i].length,
    line_count: g.length,
    font_size: fsizes.length ? fsizes.reduce((a, b) => a + b, 0) / fsizes.length : block.font_size,
    is_bold: bolds.length ? (bolds.reduce((a, b) => a + b, 0) / bolds.length) >= 0.6 : block.is_bold,
    is_italic: italics.length ? (italics.reduce((a, b) => a + b, 0) / italics.length) >= 0.6 : block.is_italic,
    category_id: cats[i] || block.category_id,
  };
});

console.log(`\n[split] ${blockId} (${block.line_count} lines, ${block.category_id}) becomes:`);
for (const p of parts) {
  console.log(`  ${p.id}  ${p.category_id.padEnd(11)} x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} ` +
    `w=${p.width.toFixed(0)} h=${p.height.toFixed(0)} lines=${p.line_count} fs=${p.font_size.toFixed(0)}` +
    `${p.is_bold ? ' bold' : ''}`);
  console.log(`      ${JSON.stringify(p.text)}`);
}

if (dryRun) { console.log('\n[split] --dry-run, nothing written'); process.exit(0); }

blocks.splice(idx, 1, ...parts);

// Atomic write: the library folder is Syncthing-monitored, so a partial manifest
// is a syncable event. Temp beside the target keeps the rename on one filesystem.
const tmp = `${manifestPath}.split-tmp`;
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
fs.renameSync(tmp, manifestPath);
console.log(`\n[split] wrote ${manifestPath} (${blocks.length} blocks)`);
console.log('[split] If the book is OPEN in the picker, reload it now — the app writes');
console.log('        editor.ocrBlocks on save and would overwrite this split.');
