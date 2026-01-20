#!/usr/bin/env node
/**
 * Final test demonstrating working mupdf.js redaction
 *
 * KEY FINDING: The redaction DOES work, but you must use coordinates from
 * page.search() or structured text, NOT raw PDF content stream coordinates.
 *
 * mupdf.js uses a consistent coordinate system (y=0 at top, like screen coords)
 * for its API, even though PDF internally uses y=0 at bottom.
 */

import * as mupdf from 'mupdf';
import * as fs from 'fs';

const RESULTS_DIR = '/tmp/mupdf-redaction-tests';

function extractText(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const page = doc.loadPage(0);
  return page.toStructuredText().asText();
}

function createTestPdf() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const resources = doc.addObject({ Font: { F1: font } });

  const contents = `
    BT /F1 24 Tf 50 700 Td (SECRET: This text should be redacted) Tj ET
    BT /F1 16 Tf 50 650 Td (PUBLIC: This text should remain visible) Tj ET
    BT /F1 16 Tf 50 600 Td (CONFIDENTIAL: Another secret line) Tj ET
    BT /F1 12 Tf 50 550 Td (Normal text that stays in the document.) Tj ET
  `;

  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contents);
  doc.insertPage(-1, pageObj);

  const outputPath = `${RESULTS_DIR}/test-input.pdf`;
  fs.writeFileSync(outputPath, doc.saveToBuffer('compress').asUint8Array());
  return outputPath;
}

/**
 * Correctly redact text using search to find coordinates
 */
function redactUsingSearch(inputPath, searchText) {
  console.log(`\nRedacting "${searchText}" using page.search()...`);

  const data = fs.readFileSync(inputPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(0);

  // Search for text to get correct coordinates
  const results = page.search(searchText);
  console.log(`Found ${results.length} matches`);

  if (results.length === 0) {
    console.log('No matches found!');
    return null;
  }

  // Create redaction annotation for each match
  for (const quads of results) {
    for (const quad of quads) {
      // Convert quad to rect [x0, y0, x1, y1]
      const x0 = Math.min(quad[0], quad[2], quad[4], quad[6]);
      const x1 = Math.max(quad[0], quad[2], quad[4], quad[6]);
      const y0 = Math.min(quad[1], quad[3], quad[5], quad[7]);
      const y1 = Math.max(quad[1], quad[3], quad[5], quad[7]);

      // Extend rect slightly to ensure full coverage
      const rect = [x0 - 2, y0 - 2, x1 + 2, y1 + 2];

      console.log(`  Creating redaction at [${rect.map(n => n.toFixed(1)).join(', ')}]`);
      const annot = page.createAnnotation('Redact');
      annot.setRect(rect);
    }
  }

  // Apply all redactions
  page.applyRedactions(false, 2, 2, 0);

  // Save with garbage collection
  const outputPath = `${RESULTS_DIR}/result-search-redact.pdf`;
  fs.writeFileSync(outputPath, pdfDoc.saveToBuffer('garbage=4,compress').asUint8Array());

  return outputPath;
}

/**
 * Redact entire lines by extending the rect horizontally
 */
function redactFullLine(inputPath, searchText) {
  console.log(`\nRedacting full line containing "${searchText}"...`);

  const data = fs.readFileSync(inputPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(0);
  const bounds = page.getBounds();

  const results = page.search(searchText);
  if (results.length === 0) return null;

  for (const quads of results) {
    for (const quad of quads) {
      const y0 = Math.min(quad[1], quad[3], quad[5], quad[7]) - 2;
      const y1 = Math.max(quad[1], quad[3], quad[5], quad[7]) + 2;

      // Extend to full page width
      const rect = [bounds[0], y0, bounds[2], y1];

      console.log(`  Creating full-width redaction at [${rect.map(n => n.toFixed(1)).join(', ')}]`);
      const annot = page.createAnnotation('Redact');
      annot.setRect(rect);
    }
  }

  page.applyRedactions(false, 2, 2, 0);

  const outputPath = `${RESULTS_DIR}/result-fullline-redact.pdf`;
  fs.writeFileSync(outputPath, pdfDoc.saveToBuffer('garbage=4,compress').asUint8Array());

  return outputPath;
}

async function main() {
  console.log('='.repeat(60));
  console.log('MuPDF.js Redaction - WORKING Solution');
  console.log('='.repeat(60));

  // Create test PDF
  const testPdf = createTestPdf();
  console.log(`\nCreated test PDF: ${testPdf}`);
  console.log('\nOriginal text:');
  console.log('-'.repeat(40));
  console.log(extractText(testPdf));
  console.log('-'.repeat(40));

  // Test 1: Redact just the word "SECRET"
  const result1 = redactUsingSearch(testPdf, 'SECRET');
  if (result1) {
    console.log('\nAfter redacting "SECRET":');
    console.log('-'.repeat(40));
    const text1 = extractText(result1);
    console.log(text1);
    console.log('-'.repeat(40));
    console.log(`SUCCESS: ${!text1.includes('SECRET') ? 'YES' : 'NO'}`);
  }

  // Test 2: Redact full line containing "SECRET"
  const result2 = redactFullLine(testPdf, 'SECRET');
  if (result2) {
    console.log('\nAfter redacting full SECRET line:');
    console.log('-'.repeat(40));
    const text2 = extractText(result2);
    console.log(text2);
    console.log('-'.repeat(40));
    console.log(`SECRET line removed: ${!text2.includes('SECRET') && !text2.includes('redacted') ? 'YES' : 'NO'}`);
  }

  // Test 3: Redact multiple items
  console.log('\n' + '='.repeat(60));
  console.log('Test: Redact both SECRET and CONFIDENTIAL');
  console.log('='.repeat(60));

  const data = fs.readFileSync(testPdf);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(0);
  const bounds = page.getBounds();

  for (const term of ['SECRET', 'CONFIDENTIAL']) {
    const results = page.search(term);
    for (const quads of results) {
      for (const quad of quads) {
        const y0 = Math.min(quad[1], quad[3], quad[5], quad[7]) - 2;
        const y1 = Math.max(quad[1], quad[3], quad[5], quad[7]) + 2;
        const rect = [bounds[0], y0, bounds[2], y1];
        const annot = page.createAnnotation('Redact');
        annot.setRect(rect);
        console.log(`Created redaction for "${term}" at y=${y0.toFixed(1)}-${y1.toFixed(1)}`);
      }
    }
  }

  page.applyRedactions(false, 2, 2, 0);
  const multiResult = `${RESULTS_DIR}/result-multi-redact.pdf`;
  fs.writeFileSync(multiResult, pdfDoc.saveToBuffer('garbage=4,compress').asUint8Array());

  const finalText = extractText(multiResult);
  console.log('\nFinal text:');
  console.log('-'.repeat(40));
  console.log(finalText);
  console.log('-'.repeat(40));

  const secretGone = !finalText.includes('SECRET');
  const confGone = !finalText.includes('CONFIDENTIAL');
  const publicKept = finalText.includes('PUBLIC');
  const normalKept = finalText.includes('Normal');

  console.log('\n' + '='.repeat(60));
  console.log('FINAL RESULTS');
  console.log('='.repeat(60));
  console.log(`SECRET removed:       ${secretGone ? 'PASS' : 'FAIL'}`);
  console.log(`CONFIDENTIAL removed: ${confGone ? 'PASS' : 'FAIL'}`);
  console.log(`PUBLIC kept:          ${publicKept ? 'PASS' : 'FAIL'}`);
  console.log(`Normal text kept:     ${normalKept ? 'PASS' : 'FAIL'}`);
  console.log();

  if (secretGone && confGone && publicKept && normalKept) {
    console.log('*** mupdf.js REDACTION WORKS! ***');
    console.log('\nThe key is to use page.search() to get coordinates,');
    console.log('not raw PDF content stream coordinates.');
  } else {
    console.log('*** Some tests failed ***');
  }

  console.log(`\nOutput files in: ${RESULTS_DIR}`);
}

main().catch(console.error);
