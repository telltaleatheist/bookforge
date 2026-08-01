#!/usr/bin/env node
// Assemble hand-labeled chunks into an app-compatible training session.
//   node assemble-session.mjs <ocr-out-dir> <projectDir>
// Reads blocks.json + labels-*.json (blockId -> category) and writes
// ~/Documents/BookForge/training/<project basename>/labels.json

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const [outDir, projectDir] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(path.join(outDir, 'blocks.json'), 'utf-8'));

const labels = {};
for (const f of fs.readdirSync(outDir).filter(f => /^labels-.*\.json$/.test(f))) {
  Object.assign(labels, JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf-8')));
}

// Thirteen since Jul 2026; see LABEL_SET in align-core.mjs for why.
const LABEL_SET = ['body','title','chapter','heading','subheading','quote','caption',
  'footnote','header','footer','image','table','list'];

const bad = Object.entries(labels).filter(([, c]) => !LABEL_SET.includes(c));
if (bad.length) {
  console.error('invalid categories:', bad.slice(0, 10));
  process.exit(1);
}

const sessionBlocks = data.blocks.map((b, i) => {
  const id = b.id ?? `ocr_p${b.page}_hand_${i}`;
  return {
    id, page: b.page, x: b.x, y: b.y, width: b.w, height: b.h,
    text: b.text, font_size: Math.round(b.fsize * 10) / 10 || 10, font_name: 'OCR',
    char_count: b.text.length, region: 'body',
    category_id: labels[id] ?? 'body',
    line_count: b.lineCount, is_ocr: true, ocr_confidence: b.conf,
  };
});

const covered = sessionBlocks.filter(b => labels[b.id]).length;
console.log(`labels cover ${covered}/${sessionBlocks.length} blocks`);
const missing = sessionBlocks.filter(b => !labels[b.id]).slice(0, 10);
for (const m of missing) console.log('  UNLABELED:', m.id, m.text.slice(0, 60));

const slug = path.basename(projectDir.replace(/[\/]+$/, ''));
const dir = path.join('/Volumes/Callisto/training/rubric', slug);
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'labels.json');
if (fs.existsSync(target)) {
  console.error(`REFUSING to overwrite ${target}`);
  process.exit(1);
}
fs.writeFileSync(target, JSON.stringify({
  version: 1,
  labelSet: LABEL_SET,
  savedAt: new Date().toISOString(),
  sourceFile: data.pdf,
  blockSource: 'ocr',
  ocrEngine: 'tesseract',
  pageDimensions: data.pageDimensions,
  blocks: sessionBlocks,
  labels,
}, null, 1));
console.log(`session written -> ${target}`);
