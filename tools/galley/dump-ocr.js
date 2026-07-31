#!/usr/bin/env node
/**
 * dump_ocr — the app's OWN headless OCR path, with the per-LINE results kept.
 *
 * cli/ocr-pdf.js writes blocks.json, which carries each block's line BOXES but
 * not each line's TEXT — and per-line text is exactly what an OCR-error corpus
 * needs, because a line box is the unit that maps cleanly onto the typesetter's
 * word boxes. So this is a second thin driver over the same two app modules
 * (getHeadlessOcrService + processOcrPageResults, both from dist/), adding
 * nothing of its own except the writer. Same 200 dpi, same PSM/OEM, same
 * preprocessing-off default, because none of that is decided here.
 *
 *   node --require cli/electron-stub.js dump_ocr.js <pdf> <outJson> <p0> <p1>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');

const { getHeadlessOcrService } = require(path.join(REPO, 'dist/electron/headless-ocr.js'));
const { OCR_DPI } = require(path.join(REPO, 'dist/electron/ocr-service.js'));
const { processOcrPageResults } = require(path.join(REPO, 'dist/shared/ocr/ocr-post-processing.js'));

const [pdfPath, outJson, p0, p1] = process.argv.slice(2);
const pages = [];
for (let i = Number(p0); i <= Number(p1); i++) pages.push(i);

(async () => {
  const results = await getHeadlessOcrService().processPdf(path.resolve(pdfPath), {
    engine: 'tesseract', language: 'eng', pages, concurrency: 6, preprocess: false,
  });
  const dims = [];
  for (const r of results) {
    if (r.pageWidth !== undefined && r.pageHeight !== undefined) {
      dims[r.page] = { width: r.pageWidth, height: r.pageHeight };
    }
  }
  const processed = processOcrPageResults(results, dims);
  fs.writeFileSync(outJson, JSON.stringify({
    pdf: path.resolve(pdfPath), dpi: OCR_DPI, renderScale: OCR_DPI / 72,
    producer: 'dump_ocr.js (app headless-ocr + shared post-processor)',
    pageDimensions: dims,
    // Raw recognized lines, in IMAGE PIXELS (see shared/ocr/ocr-line.ts).
    pages: results.map(r => ({
      page: r.page, pageWidth: r.pageWidth, pageHeight: r.pageHeight,
      lines: (r.textLines || []).map(l => ({
        text: l.text, bbox: l.bbox, conf: l.confidence,
        blockNum: l.blockNum, parNum: l.parNum, xSize: l.xSize,
      })),
    })),
    // Post-processed blocks, in PAGE POINTS — the app's own segmentation.
    blocks: processed.blocks.map(b => ({
      id: b.id, page: b.page, x: b.x, y: b.y, w: b.width, h: b.height,
      text: b.text, category: b.category_id, lineCount: b.line_count,
      lineBoxes: b.line_boxes, conf: b.ocr_confidence, fsize: b.font_size,
    })),
  }));
  console.error(`[dump_ocr] ${processed.blocks.length} blocks, ${results.length} pages -> ${outJson}`);
})().catch(e => { console.error(e); process.exit(1); });
