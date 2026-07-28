#!/usr/bin/env node
// Assign stable block ids and split blocks.json into page-range chunk files
// for parallel labeling.  node split-chunks.mjs <ocr-out-dir> <pagesPerChunk>

import * as fs from 'fs';
import * as path from 'path';

const [outDir, perChunkArg] = process.argv.slice(2);
const perChunk = Number(perChunkArg || 32);
const file = path.join(outDir, 'blocks.json');
const data = JSON.parse(fs.readFileSync(file, 'utf-8'));

data.blocks.forEach((b, i) => { b.id = `ocr_p${b.page}_hand_${i}`; });
fs.writeFileSync(file, JSON.stringify(data, null, 1));

const maxPage = Math.max(...data.blocks.map(b => b.page));
let nChunks = 0;
for (let start = 0; start <= maxPage; start += perChunk) {
  const end = Math.min(maxPage, start + perChunk - 1);
  const blocks = data.blocks
    .filter(b => b.page >= start && b.page <= end)
    .map(b => ({
      id: b.id, page: b.page,
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
      pageW: Math.round(b.pageW), pageH: Math.round(b.pageH),
      fsize: Math.round(b.fsize * 10) / 10, lines: b.lineCount,
      conf: Math.round(b.conf * 100) / 100,
      text: b.text.length > 300 ? b.text.slice(0, 300) + '…' : b.text,
    }));
  fs.writeFileSync(path.join(outDir, `chunk-${String(start).padStart(3, '0')}-${String(end).padStart(3, '0')}.json`),
    JSON.stringify({ pageStart: start, pageEnd: end, blocks }, null, 1));
  nChunks++;
}
console.log(`${data.blocks.length} blocks, pages 0-${maxPage}, ${nChunks} chunks of ${perChunk} pages`);
