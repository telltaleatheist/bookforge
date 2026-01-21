/**
 * Test batch redaction to reproduce the font corruption issue
 */

import * as fs from 'fs';

const TEST_PDF = '/Volumes/Callisto/books/ww2/Why Trump isn\'t a fascist. Evans, Richard J. (2021).pdf';
const OUTPUT_DIR = '/tmp/batch-redact-test';

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const mupdf = await import('mupdf');

  console.log('Loading PDF:', TEST_PDF);
  const data = fs.readFileSync(TEST_PDF);

  // Page 8 (index 7) - the one with the issue
  const pageNum = 7;

  // Find all images on this page
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  const stext = page.toStructuredText('preserve-images');
  const stextJson = JSON.parse(stext.asJSON());

  const imageBlocks = stextJson.blocks.filter(b => b.type === 'image');
  console.log(`Found ${imageBlocks.length} images on page ${pageNum + 1}`);

  // Convert bbox format
  const bboxToRect = (bbox) => {
    if (typeof bbox === 'object' && 'x' in bbox) {
      return [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h];
    }
    return bbox;
  };

  // Test 1: Original page
  console.log('\n=== Test 1: Original page ===');
  await renderPage(mupdf, TEST_PDF, pageNum, `${OUTPUT_DIR}/01-original.png`);

  // Test 2: Delete ONE image with pixel painting (should work)
  console.log('\n=== Test 2: Delete one image (pixel paint) ===');
  await testPixelPaint(mupdf, TEST_PDF, pageNum, [bboxToRect(imageBlocks[0].bbox)], `${OUTPUT_DIR}/02-one-image-pixel.png`);

  // Test 3: Delete ALL images with pixel painting (should work)
  console.log('\n=== Test 3: Delete all images (pixel paint) ===');
  const allImageRects = imageBlocks.map(b => bboxToRect(b.bbox));
  await testPixelPaint(mupdf, TEST_PDF, pageNum, allImageRects, `${OUTPUT_DIR}/03-all-images-pixel.png`);

  // Test 4: Delete ONE image with applyRedactions (image_method=2, text_method=1)
  console.log('\n=== Test 4: Delete one image (redaction API, preserve text) ===');
  await testRedaction(mupdf, TEST_PDF, pageNum, [bboxToRect(imageBlocks[0].bbox)], 1, `${OUTPUT_DIR}/04-one-image-redact.png`, `${OUTPUT_DIR}/04-one-image-redact.pdf`);

  // Test 5: Delete ALL images with applyRedactions (image_method=2, text_method=1)
  console.log('\n=== Test 5: Delete all images (redaction API, preserve text) ===');
  await testRedaction(mupdf, TEST_PDF, pageNum, allImageRects, 1, `${OUTPUT_DIR}/05-all-images-redact.png`, `${OUTPUT_DIR}/05-all-images-redact.pdf`);

  // Test 6: Delete ALL images with Square annotation + bake
  console.log('\n=== Test 6: Delete all images (Square + bake) ===');
  await testOverlayBake(mupdf, TEST_PDF, pageNum, allImageRects, `${OUTPUT_DIR}/06-all-images-bake.png`, `${OUTPUT_DIR}/06-all-images-bake.pdf`);

  // Test 7: Multiple applyRedactions calls (one per image) vs single call
  console.log('\n=== Test 7: Multiple applyRedactions calls (one per image) ===');
  await testMultipleRedactionCalls(mupdf, TEST_PDF, pageNum, allImageRects, `${OUTPUT_DIR}/07-multi-redact-calls.png`, `${OUTPUT_DIR}/07-multi-redact-calls.pdf`);

  console.log('\n=== Done! ===');
  console.log(`Compare PNG files in: ${OUTPUT_DIR}`);
  console.log('open ' + OUTPUT_DIR);
}

async function renderPage(mupdf, pdfPath, pageNum, outPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const page = doc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(outPath, pixmap.asPNG());
  console.log(`  Saved: ${outPath}`);
}

async function testPixelPaint(mupdf, pdfPath, pageNum, rects, pngPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const page = doc.loadPage(pageNum);

  const scale = 2.0;
  const matrix = mupdf.Matrix.scale(scale, scale);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);

  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const n = pixmap.getNumberOfComponents();
  const samples = pixmap.getPixels();

  // Paint white over each rect
  for (const rect of rects) {
    const x1 = Math.floor(rect[0] * scale);
    const y1 = Math.floor(rect[1] * scale);
    const x2 = Math.ceil(rect[2] * scale);
    const y2 = Math.ceil(rect[3] * scale);

    for (let y = Math.max(0, y1); y < Math.min(height, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(width, x2); x++) {
        const i = (y * width + x) * n;
        samples[i] = 255;
        samples[i + 1] = 255;
        samples[i + 2] = 255;
      }
    }
  }

  fs.writeFileSync(pngPath, pixmap.asPNG());
  console.log(`  Saved: ${pngPath}`);
}

async function testRedaction(mupdf, pdfPath, pageNum, rects, textMethod, pngPath, pdfOutPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  // Create all redaction annotations first
  for (const rect of rects) {
    const annot = page.createAnnotation('Redact');
    annot.setRect(rect);
  }

  // Apply all at once: no black boxes, image_method=2 (pixels), line_art=0, text_method=1 (preserve)
  console.log(`  Applying ${rects.length} redactions (text_method=${textMethod})...`);
  page.applyRedactions(false, 2, 0, textMethod);

  // Save PDF
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(pdfOutPath, buffer.asUint8Array());
  console.log(`  Saved PDF: ${pdfOutPath}`);

  // Render to PNG
  const renderPage = doc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = renderPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(pngPath, pixmap.asPNG());
  console.log(`  Saved PNG: ${pngPath}`);
}

async function testOverlayBake(mupdf, pdfPath, pageNum, rects, pngPath, pdfOutPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  // Create Square annotations
  for (const rect of rects) {
    const annot = page.createAnnotation('Square');
    annot.setRect(rect);
    annot.setInteriorColor([1, 1, 1]); // White fill
    annot.setColor([1, 1, 1]); // White border
    annot.setBorderWidth(0);
    annot.update();
  }

  // Bake annotations into page content
  console.log(`  Baking ${rects.length} square annotations...`);
  pdfDoc.bake();

  // Save PDF
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(pdfOutPath, buffer.asUint8Array());
  console.log(`  Saved PDF: ${pdfOutPath}`);

  // Render to PNG (reload from saved file)
  const modifiedData = fs.readFileSync(pdfOutPath);
  const modifiedDoc = mupdf.Document.openDocument(modifiedData, 'application/pdf');
  const renderPage = modifiedDoc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = renderPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(pngPath, pixmap.asPNG());
  console.log(`  Saved PNG: ${pngPath}`);
}

async function testMultipleRedactionCalls(mupdf, pdfPath, pageNum, rects, pngPath, pdfOutPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  // Apply redactions one at a time
  for (let i = 0; i < rects.length; i++) {
    const annot = page.createAnnotation('Redact');
    annot.setRect(rects[i]);
    console.log(`  Applying redaction ${i + 1}/${rects.length}...`);
    page.applyRedactions(false, 2, 0, 1);
  }

  // Save PDF
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(pdfOutPath, buffer.asUint8Array());
  console.log(`  Saved PDF: ${pdfOutPath}`);

  // Render to PNG
  const renderPage = doc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = renderPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(pngPath, pixmap.asPNG());
  console.log(`  Saved PNG: ${pngPath}`);
}

main().catch(console.error);
