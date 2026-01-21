/**
 * Test script to investigate text distortion when removing images from PDF
 * Test page 2 which likely has more visible images
 */

import * as fs from 'fs';

const TEST_PDF = '/Volumes/Callisto/books/ww2/Why Trump isn\'t a fascist. Evans, Richard J. (2021).pdf';
const OUTPUT_DIR = '/tmp/pdf-test2';

async function main() {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Import mupdf
  const mupdf = await import('mupdf');

  // Load the test PDF
  console.log('Loading PDF:', TEST_PDF);
  const data = fs.readFileSync(TEST_PDF);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();

  if (!pdfDoc) {
    console.error('Failed to open as PDF document');
    return;
  }

  const totalPages = pdfDoc.countPages();
  console.log(`Total pages: ${totalPages}`);

  // Test page 2 (index 1) instead
  const pageNum = 1;
  const page = pdfDoc.loadPage(pageNum);
  const bounds = page.getBounds();
  console.log(`\nPage ${pageNum + 1} bounds: [${bounds.join(', ')}]`);

  // Find images on the page
  const stext = page.toStructuredText('preserve-images');
  const stextJson = JSON.parse(stext.asJSON());

  // Helper to convert bbox to array [x0, y0, x1, y1]
  const bboxToArray = (bbox) => {
    if (Array.isArray(bbox)) {
      return bbox;
    } else if (bbox && typeof bbox === 'object') {
      if ('x0' in bbox) {
        return [bbox.x0, bbox.y0, bbox.x1, bbox.y1];
      } else if ('x' in bbox) {
        return [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h];
      }
    }
    throw new Error(`Unknown bbox format: ${JSON.stringify(bbox)}`);
  };

  console.log('\n=== Page Structure ===');
  const imageBlocks = [];
  for (const block of stextJson.blocks) {
    if (block.type === 'image') {
      const bbox = bboxToArray(block.bbox);
      // Only include images that are on the visible page
      if (bbox[1] < bounds[3] && bbox[3] > 0) {
        console.log(`IMAGE: bbox=[${bbox.map(n => n.toFixed(1)).join(', ')}]`);
        imageBlocks.push(bbox);
      }
    } else if (block.type === 'text') {
      const lines = block.lines || [];
      const firstLine = lines[0];
      if (firstLine) {
        const text = firstLine.spans?.map((s) => s.text).join('') || '';
        const bbox = bboxToArray(block.bbox);
        console.log(`TEXT: "${text.substring(0, 40)}..." bbox=[${bbox.map(n => n.toFixed(1)).join(', ')}]`);
      }
    }
  }

  if (imageBlocks.length === 0) {
    console.log('\nNo visible images found on this page');
    return;
  }

  // Use the first visible image
  const targetBbox = imageBlocks[0];
  console.log(`\n=== Testing Image Removal ===`);
  console.log(`Target image bbox: [${targetBbox.map(n => n.toFixed(1)).join(', ')}]`);

  // Test 1: Original page (no changes)
  console.log('\nTest 1: Saving original page as reference...');
  await savePageAsPng(mupdf, TEST_PDF, pageNum, `${OUTPUT_DIR}/01-original.png`);

  // Test 2: Use applyRedactions with image preservation (text_method=1)
  console.log('\nTest 2: applyRedactions (image_method=2, text_method=1 - preserve text)...');
  await testRedactionPreserveText(mupdf, TEST_PDF, pageNum, targetBbox, `${OUTPUT_DIR}/02-redact-preserve-text.png`, `${OUTPUT_DIR}/02-redact-preserve-text.pdf`);

  // Test 3: Use removeWithOverlay (Square annotation + bake)
  console.log('\nTest 3: removeWithOverlay (Square annotation + bake)...');
  await testOverlayMethod(mupdf, TEST_PDF, pageNum, targetBbox, `${OUTPUT_DIR}/03-overlay-bake.png`, `${OUTPUT_DIR}/03-overlay-bake.pdf`);

  // Test 4: Pixel-level painting only (no PDF modification)
  console.log('\nTest 4: Pixel-level painting (render then paint over)...');
  await testPixelPainting(mupdf, TEST_PDF, pageNum, targetBbox, `${OUTPUT_DIR}/04-pixel-paint.png`);

  // Test 5: Use applyRedactions with all methods
  console.log('\nTest 5: applyRedactions (image_method=2, text_method=0 - remove text too)...');
  await testRedactionRemoveAll(mupdf, TEST_PDF, pageNum, targetBbox, `${OUTPUT_DIR}/05-redact-remove-all.png`, `${OUTPUT_DIR}/05-redact-remove-all.pdf`);

  console.log('\n=== Done! ===');
  console.log(`Output files saved to: ${OUTPUT_DIR}`);
  console.log('Compare the PNG files to see which methods cause text distortion.');
}

async function savePageAsPng(mupdf, pdfPath, pageNum, outPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const page = doc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const pngData = pixmap.asPNG();
  fs.writeFileSync(outPath, pngData);
  console.log(`  Saved: ${outPath}`);
}

async function testRedactionPreserveText(mupdf, pdfPath, pageNum, bbox, pngPath, pdfOutPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  // Create redaction annotation
  const rect = [bbox[0], bbox[1], bbox[2], bbox[3]];
  const annot = page.createAnnotation('Redact');
  annot.setRect(rect);

  // Apply with: no black boxes, clear images to white (2), no line art (0), PRESERVE text (1)
  page.applyRedactions(false, 2, 0, 1);

  // Save PDF
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(pdfOutPath, buffer.asUint8Array());
  console.log(`  Saved PDF: ${pdfOutPath}`);

  // Render to PNG
  const renderPage = doc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = renderPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const pngData = pixmap.asPNG();
  fs.writeFileSync(pngPath, pngData);
  console.log(`  Saved PNG: ${pngPath}`);
}

async function testOverlayMethod(mupdf, pdfPath, pageNum, bbox, pngPath, pdfOutPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  // Create Square annotation (filled rectangle)
  const rect = [bbox[0], bbox[1], bbox[2], bbox[3]];
  const annot = page.createAnnotation('Square');
  annot.setRect(rect);
  annot.setInteriorColor([1, 1, 1]); // White fill
  annot.setColor([1, 1, 1]); // White border
  annot.setBorderWidth(0);
  annot.update();

  // Bake annotations into page content
  pdfDoc.bake();

  // Save PDF
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(pdfOutPath, buffer.asUint8Array());
  console.log(`  Saved PDF: ${pdfOutPath}`);

  // Render to PNG (need to reload the modified document)
  const modifiedData = fs.readFileSync(pdfOutPath);
  const modifiedDoc = mupdf.Document.openDocument(modifiedData, 'application/pdf');
  const renderPage = modifiedDoc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = renderPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const pngData = pixmap.asPNG();
  fs.writeFileSync(pngPath, pngData);
  console.log(`  Saved PNG: ${pngPath}`);
}

async function testPixelPainting(mupdf, pdfPath, pageNum, bbox, pngPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const page = doc.loadPage(pageNum);
  const scale = 2.0;
  const matrix = mupdf.Matrix.scale(scale, scale);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);

  // Paint over the image region with white
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const n = pixmap.getNumberOfComponents();
  const samples = pixmap.getPixels();

  const x1 = Math.floor(bbox[0] * scale);
  const y1 = Math.floor(bbox[1] * scale);
  const x2 = Math.ceil(bbox[2] * scale);
  const y2 = Math.ceil(bbox[3] * scale);

  for (let y = Math.max(0, y1); y < Math.min(height, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(width, x2); x++) {
      const i = (y * width + x) * n;
      samples[i] = 255;     // R
      samples[i + 1] = 255; // G
      samples[i + 2] = 255; // B
    }
  }

  const pngData = pixmap.asPNG();
  fs.writeFileSync(pngPath, pngData);
  console.log(`  Saved PNG: ${pngPath}`);
}

async function testRedactionRemoveAll(mupdf, pdfPath, pageNum, bbox, pngPath, pdfOutPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(pageNum);

  // Create redaction annotation
  const rect = [bbox[0], bbox[1], bbox[2], bbox[3]];
  const annot = page.createAnnotation('Redact');
  annot.setRect(rect);

  // Apply with: no black boxes, clear images (2), remove line art if touched (2), REMOVE text (0)
  page.applyRedactions(false, 2, 2, 0);

  // Save PDF
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(pdfOutPath, buffer.asUint8Array());
  console.log(`  Saved PDF: ${pdfOutPath}`);

  // Render to PNG
  const renderPage = doc.loadPage(pageNum);
  const matrix = mupdf.Matrix.scale(2.0, 2.0);
  const pixmap = renderPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const pngData = pixmap.asPNG();
  fs.writeFileSync(pngPath, pngData);
  console.log(`  Saved PNG: ${pngPath}`);
}

main().catch(console.error);
