/**
 * Test if concurrent rendering causes font corruption
 */

import * as fs from 'fs';

const TEST_PDF = '/Volumes/Callisto/books/ww2/Why Trump isn\'t a fascist. Evans, Richard J. (2021).pdf';
const OUTPUT_DIR = '/tmp/concurrent-test';

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const mupdf = await import('mupdf');

  console.log('Loading PDF:', TEST_PDF);
  const data = fs.readFileSync(TEST_PDF);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');

  const totalPages = Math.min(10, doc.countPages());
  console.log(`Testing with ${totalPages} pages`);

  // Test 1: Sequential rendering
  console.log('\n=== Test 1: Sequential rendering ===');
  for (let i = 0; i < totalPages; i++) {
    const page = doc.loadPage(i);
    const matrix = mupdf.Matrix.scale(2.0, 2.0);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    const pngPath = `${OUTPUT_DIR}/sequential-page-${i + 1}.png`;
    fs.writeFileSync(pngPath, pixmap.asPNG());
    console.log(`  Page ${i + 1} done`);
  }

  // Test 2: Concurrent rendering (like the app does)
  console.log('\n=== Test 2: Concurrent rendering (4 at a time) ===');
  const concurrency = 4;
  const renderPage = async (pageNum) => {
    const page = doc.loadPage(pageNum);
    const matrix = mupdf.Matrix.scale(2.0, 2.0);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    const pngPath = `${OUTPUT_DIR}/concurrent-page-${pageNum + 1}.png`;
    fs.writeFileSync(pngPath, pixmap.asPNG());
    return pageNum;
  };

  const batch = [];
  for (let i = 0; i < totalPages; i++) {
    batch.push(renderPage(i));
    if (batch.length >= concurrency) {
      const results = await Promise.all(batch);
      console.log(`  Pages ${results.map(r => r + 1).join(', ')} done`);
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    const results = await Promise.all(batch);
    console.log(`  Pages ${results.map(r => r + 1).join(', ')} done`);
  }

  // Test 3: Fresh document instance per render (isolated)
  console.log('\n=== Test 3: Fresh document instance per render ===');
  for (let i = 0; i < totalPages; i++) {
    const freshData = fs.readFileSync(TEST_PDF);
    const freshDoc = mupdf.Document.openDocument(freshData, 'application/pdf');
    const page = freshDoc.loadPage(i);
    const matrix = mupdf.Matrix.scale(2.0, 2.0);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    const pngPath = `${OUTPUT_DIR}/isolated-page-${i + 1}.png`;
    fs.writeFileSync(pngPath, pixmap.asPNG());
    console.log(`  Page ${i + 1} done`);
  }

  console.log('\n=== Done! ===');
  console.log(`Compare pages in: ${OUTPUT_DIR}`);
  console.log('Look for differences between sequential, concurrent, and isolated renders');
}

main().catch(console.error);
