#!/usr/bin/env node
/**
 * Test the MupdfJsBridge implementation
 */

import * as fs from 'fs';
import * as mupdf from 'mupdf';

const RESULTS_DIR = '/tmp/mupdf-bridge-tests';

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Create a test PDF with text and images
 */
function createTestPdf() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const resources = doc.addObject({ Font: { F1: font } });

  // Create 3 pages
  for (let i = 0; i < 3; i++) {
    const contents = `
      BT /F1 24 Tf 50 700 Td (Page ${i + 1}: Header Text) Tj ET
      BT /F1 16 Tf 50 650 Td (This is body text on page ${i + 1}) Tj ET
      BT /F1 12 Tf 50 600 Td (Footer - should be removed) Tj ET
      BT /F1 14 Tf 50 500 Td (More content here) Tj ET
    `;
    const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contents);
    doc.insertPage(-1, pageObj);
  }

  const outputPath = `${RESULTS_DIR}/test-input.pdf`;
  fs.writeFileSync(outputPath, doc.saveToBuffer('compress').asUint8Array());
  console.log(`Created test PDF: ${outputPath}`);
  return outputPath;
}

/**
 * Extract text from PDF for verification
 */
function extractText(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  let text = '';
  for (let i = 0; i < doc.countPages(); i++) {
    text += `--- Page ${i + 1} ---\n`;
    text += doc.loadPage(i).toStructuredText().asText() + '\n';
  }
  return text;
}

/**
 * Simplified MupdfJsBridge for testing (same logic as the real one)
 */
class TestMupdfJsBridge {
  async redact(inputPath, outputPath, regions, options) {
    const inputData = fs.readFileSync(inputPath);
    const doc = mupdf.Document.openDocument(inputData, 'application/pdf');
    const pdfDoc = doc.asPDF();

    const totalPages = pdfDoc.countPages();
    const deletedPages = new Set(options?.deletedPages || []);

    // Group regions by page
    const regionsByPage = new Map();
    for (const region of regions) {
      if (!regionsByPage.has(region.page)) {
        regionsByPage.set(region.page, []);
      }
      regionsByPage.get(region.page).push(region);
    }

    // Apply redactions
    for (const [pageNum, pageRegions] of regionsByPage) {
      if (pageNum >= totalPages || deletedPages.has(pageNum)) continue;

      const page = pdfDoc.loadPage(pageNum);

      for (const region of pageRegions) {
        const rect = [region.x, region.y, region.x + region.width, region.y + region.height];
        const annot = page.createAnnotation('Redact');
        annot.setRect(rect);
      }
      // text_method=0 means REMOVE text
      page.applyRedactions(false, 2, 2, 0);
    }

    // Delete pages (reverse order)
    if (deletedPages.size > 0) {
      const sorted = Array.from(deletedPages).sort((a, b) => b - a);
      for (const pageNum of sorted) {
        if (pageNum < pdfDoc.countPages()) {
          pdfDoc.deletePage(pageNum);
        }
      }
    }

    // Add bookmarks
    if (options?.bookmarks?.length > 0) {
      const iterator = doc.outlineIterator();
      for (const bm of options.bookmarks) {
        iterator.insert({
          title: bm.title,
          uri: `#page=${bm.page + 1}`,
          open: true
        });
        iterator.next();
      }
    }

    const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
    fs.writeFileSync(outputPath, buffer.asUint8Array());
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('MupdfJsBridge Test');
  console.log('='.repeat(60));

  const bridge = new TestMupdfJsBridge();

  // Test 1: Create test PDF
  const inputPdf = createTestPdf();
  console.log('\nOriginal PDF:');
  console.log(extractText(inputPdf));

  // Test 2: Redaction
  console.log('\n--- Test: Redaction ---');
  const redactOutput = `${RESULTS_DIR}/test-redact.pdf`;

  // Search for "Footer" to get coordinates
  const doc = mupdf.Document.openDocument(fs.readFileSync(inputPdf), 'application/pdf');
  const page0 = doc.loadPage(0);
  const footerSearch = page0.search('Footer');

  let redactRegions = [];
  if (footerSearch.length > 0) {
    const quad = footerSearch[0][0];
    const y0 = Math.min(quad[1], quad[3], quad[5], quad[7]) - 2;
    const y1 = Math.max(quad[1], quad[3], quad[5], quad[7]) + 2;
    redactRegions = [
      { page: 0, x: 0, y: y0, width: 612, height: y1 - y0 },
      { page: 1, x: 0, y: y0, width: 612, height: y1 - y0 },
      { page: 2, x: 0, y: y0, width: 612, height: y1 - y0 },
    ];
  }

  await bridge.redact(inputPdf, redactOutput, redactRegions, {});
  console.log('After redacting "Footer" lines:');
  const redactedText = extractText(redactOutput);
  console.log(redactedText);
  console.log(`Footer removed: ${!redactedText.includes('Footer') ? 'PASS' : 'FAIL'}`);

  // Test 3: Page deletion
  console.log('\n--- Test: Page Deletion ---');
  const deleteOutput = `${RESULTS_DIR}/test-delete.pdf`;
  await bridge.redact(inputPdf, deleteOutput, [], { deletedPages: [1] }); // Delete page 2 (0-indexed)

  const deleteDoc = mupdf.Document.openDocument(fs.readFileSync(deleteOutput), 'application/pdf');
  console.log(`Original pages: 3, After deletion: ${deleteDoc.countPages()}`);
  console.log(`Page count correct: ${deleteDoc.countPages() === 2 ? 'PASS' : 'FAIL'}`);

  // Test 4: Bookmarks
  console.log('\n--- Test: Bookmarks ---');
  const bookmarkOutput = `${RESULTS_DIR}/test-bookmarks.pdf`;
  await bridge.redact(inputPdf, bookmarkOutput, [], {
    bookmarks: [
      { title: 'Chapter 1', page: 0, level: 1 },
      { title: 'Chapter 2', page: 1, level: 1 },
      { title: 'Chapter 3', page: 2, level: 1 },
    ]
  });

  const bmDoc = mupdf.Document.openDocument(fs.readFileSync(bookmarkOutput), 'application/pdf');
  const outline = bmDoc.loadOutline();
  console.log(`Bookmarks added: ${outline ? outline.length : 0}`);
  console.log(`Bookmark test: ${outline && outline.length === 3 ? 'PASS' : 'FAIL'}`);

  // Test 5: Combined (redact + delete + bookmarks)
  console.log('\n--- Test: Combined Operations ---');
  const combinedOutput = `${RESULTS_DIR}/test-combined.pdf`;
  await bridge.redact(inputPdf, combinedOutput, redactRegions, {
    deletedPages: [1],
    bookmarks: [
      { title: 'First Chapter', page: 0, level: 1 },
      { title: 'Last Chapter', page: 1, level: 1 }, // Page 2 becomes page 1 after deletion
    ]
  });

  const combinedDoc = mupdf.Document.openDocument(fs.readFileSync(combinedOutput), 'application/pdf');
  const combinedText = extractText(combinedOutput);
  const combinedOutline = combinedDoc.loadOutline();

  console.log(`Pages: ${combinedDoc.countPages()} (expected: 2)`);
  console.log(`Footer removed: ${!combinedText.includes('Footer')}`);
  console.log(`Bookmarks: ${combinedOutline ? combinedOutline.length : 0}`);

  const allPass = combinedDoc.countPages() === 2 &&
                  !combinedText.includes('Footer') &&
                  combinedOutline && combinedOutline.length === 2;

  console.log(`\nCombined test: ${allPass ? 'PASS' : 'FAIL'}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log('Test files saved to:', RESULTS_DIR);
}

main().catch(console.error);
