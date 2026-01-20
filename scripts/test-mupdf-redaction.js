#!/usr/bin/env node
/**
 * Test script for mupdf.js redaction functionality
 *
 * This script tests whether mupdf.js redaction actually removes text from PDFs
 * by trying different approaches and save options.
 *
 * Usage: node scripts/test-mupdf-redaction.js [path-to-test.pdf]
 *
 * If no PDF is provided, creates a simple test PDF with text to redact.
 */

import * as mupdf from 'mupdf';
import * as fs from 'fs';
import * as path from 'path';

const RESULTS_DIR = '/tmp/mupdf-redaction-tests';

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Create a simple test PDF with known text content
 */
function createTestPdf() {
  console.log('\n--- Creating Test PDF ---');

  const doc = new mupdf.PDFDocument();

  // Add a built-in font
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));

  // Create resources with font
  const resources = doc.addObject({
    Font: { F1: font }
  });

  // Create content with text that we'll try to redact
  // Text at different positions for testing
  const contents = `
    BT
    /F1 24 Tf
    50 700 Td
    (SECRET: This text should be redacted) Tj
    ET
    BT
    /F1 16 Tf
    50 650 Td
    (PUBLIC: This text should remain visible) Tj
    ET
    BT
    /F1 16 Tf
    50 600 Td
    (CONFIDENTIAL: Another secret line here) Tj
    ET
    BT
    /F1 12 Tf
    50 550 Td
    (Normal paragraph text that stays in the document.) Tj
    ET
  `;

  // Create page (Letter size: 612x792 points)
  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contents);
  doc.insertPage(-1, pageObj);

  const outputPath = path.join(RESULTS_DIR, 'test-input.pdf');
  const buffer = doc.saveToBuffer('compress');
  fs.writeFileSync(outputPath, buffer.asUint8Array());

  console.log(`Created test PDF: ${outputPath}`);
  return outputPath;
}

/**
 * Extract all text from a PDF for verification
 */
function extractText(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');

  let allText = '';
  const pageCount = doc.countPages();

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const stext = page.toStructuredText('preserve-whitespace');
    allText += stext.asText() + '\n';
  }

  return allText;
}

/**
 * Test redaction using page.applyRedactions() method
 */
async function testPageRedactions(inputPath, saveOptions, testName) {
  console.log(`\n--- Test: ${testName} ---`);
  console.log(`Save options: "${saveOptions}"`);

  const data = fs.readFileSync(inputPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();

  if (!pdfDoc) {
    console.log('ERROR: Could not get PDF document');
    return null;
  }

  const page = pdfDoc.loadPage(0);

  // Create redaction annotation for "SECRET" line (around y=700, top of page)
  // In PDF coordinates, y=0 is at bottom, so y=700 is near top
  // The rect is [x0, y0, x1, y1]
  const redactAnnot1 = page.createAnnotation('Redact');
  redactAnnot1.setRect([40, 690, 400, 720]); // Area containing "SECRET" text

  // Create another redaction for "CONFIDENTIAL" line
  const redactAnnot2 = page.createAnnotation('Redact');
  redactAnnot2.setRect([40, 590, 450, 620]); // Area containing "CONFIDENTIAL" text

  console.log('Created 2 redaction annotations');

  // Apply redactions with different parameter combinations
  // applyRedactions(black_boxes, image_method, line_art_method, text_method)
  // text_method: 0 = remove, 1 = none
  page.applyRedactions(false, 2, 2, 0); // false = no black boxes, remove text

  console.log('Applied redactions to page');

  // Save with specified options
  const outputPath = path.join(RESULTS_DIR, `result-${testName.replace(/\s+/g, '-')}.pdf`);
  const buffer = pdfDoc.saveToBuffer(saveOptions);
  fs.writeFileSync(outputPath, buffer.asUint8Array());

  console.log(`Saved to: ${outputPath}`);
  console.log(`File size: ${buffer.asUint8Array().length} bytes`);

  // Extract text to verify
  const extractedText = extractText(outputPath);
  console.log('\nExtracted text from result:');
  console.log('---');
  console.log(extractedText.trim() || '(empty)');
  console.log('---');

  // Check what was removed
  const hasSecret = extractedText.includes('SECRET');
  const hasConfidential = extractedText.includes('CONFIDENTIAL');
  const hasPublic = extractedText.includes('PUBLIC');
  const hasNormal = extractedText.includes('Normal');

  console.log('\nVerification:');
  console.log(`  SECRET text removed: ${!hasSecret ? 'YES' : 'NO (FAILED)'}`);
  console.log(`  CONFIDENTIAL removed: ${!hasConfidential ? 'YES' : 'NO (FAILED)'}`);
  console.log(`  PUBLIC text kept: ${hasPublic ? 'YES' : 'NO (unexpected)'}`);
  console.log(`  Normal text kept: ${hasNormal ? 'YES' : 'NO (unexpected)'}`);

  return {
    testName,
    outputPath,
    secretRemoved: !hasSecret,
    confidentialRemoved: !hasConfidential,
    publicKept: hasPublic,
    normalKept: hasNormal,
    success: !hasSecret && !hasConfidential && hasPublic && hasNormal
  };
}

/**
 * Test redaction using individual annotation.applyRedaction() method
 */
async function testAnnotationRedaction(inputPath, saveOptions, testName) {
  console.log(`\n--- Test: ${testName} ---`);
  console.log(`Save options: "${saveOptions}"`);

  const data = fs.readFileSync(inputPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();

  if (!pdfDoc) {
    console.log('ERROR: Could not get PDF document');
    return null;
  }

  const page = pdfDoc.loadPage(0);

  // Create and immediately apply each redaction annotation
  const redactAnnot1 = page.createAnnotation('Redact');
  redactAnnot1.setRect([40, 690, 400, 720]);
  redactAnnot1.applyRedaction(false, 2, 2, 0); // Apply immediately

  const redactAnnot2 = page.createAnnotation('Redact');
  redactAnnot2.setRect([40, 590, 450, 620]);
  redactAnnot2.applyRedaction(false, 2, 2, 0);

  console.log('Created and applied 2 redaction annotations individually');

  // Save
  const outputPath = path.join(RESULTS_DIR, `result-${testName.replace(/\s+/g, '-')}.pdf`);
  const buffer = pdfDoc.saveToBuffer(saveOptions);
  fs.writeFileSync(outputPath, buffer.asUint8Array());

  console.log(`Saved to: ${outputPath}`);

  // Verify
  const extractedText = extractText(outputPath);
  console.log('\nExtracted text:');
  console.log('---');
  console.log(extractedText.trim() || '(empty)');
  console.log('---');

  const hasSecret = extractedText.includes('SECRET');
  const hasConfidential = extractedText.includes('CONFIDENTIAL');
  const hasPublic = extractedText.includes('PUBLIC');
  const hasNormal = extractedText.includes('Normal');

  console.log('\nVerification:');
  console.log(`  SECRET text removed: ${!hasSecret ? 'YES' : 'NO (FAILED)'}`);
  console.log(`  CONFIDENTIAL removed: ${!hasConfidential ? 'YES' : 'NO (FAILED)'}`);
  console.log(`  PUBLIC text kept: ${hasPublic ? 'YES' : 'NO (unexpected)'}`);
  console.log(`  Normal text kept: ${hasNormal ? 'YES' : 'NO (unexpected)'}`);

  return {
    testName,
    outputPath,
    secretRemoved: !hasSecret,
    confidentialRemoved: !hasConfidential,
    publicKept: hasPublic,
    normalKept: hasNormal,
    success: !hasSecret && !hasConfidential && hasPublic && hasNormal
  };
}

/**
 * Test with an existing PDF file
 */
async function testWithExistingPdf(inputPath) {
  console.log(`\n--- Testing with existing PDF: ${inputPath} ---`);

  // First, show what text is in the original
  console.log('\nOriginal text content:');
  const originalText = extractText(inputPath);
  console.log('---');
  console.log(originalText.substring(0, 500) + (originalText.length > 500 ? '...' : ''));
  console.log('---');

  const data = fs.readFileSync(inputPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();

  if (!pdfDoc) {
    console.log('ERROR: Not a PDF document');
    return;
  }

  const page = pdfDoc.loadPage(0);
  const bounds = page.getBounds();
  console.log(`\nPage bounds: [${bounds.join(', ')}]`);

  // Create a redaction in the middle of the page
  const midX = (bounds[0] + bounds[2]) / 2;
  const midY = (bounds[1] + bounds[3]) / 2;
  const redactRect = [bounds[0] + 20, midY - 50, bounds[2] - 20, midY + 50];

  console.log(`Creating redaction at: [${redactRect.join(', ')}]`);

  const redactAnnot = page.createAnnotation('Redact');
  redactAnnot.setRect(redactRect);
  page.applyRedactions(false, 2, 2, 0);

  const outputPath = path.join(RESULTS_DIR, 'result-existing-pdf-test.pdf');
  const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
  fs.writeFileSync(outputPath, buffer.asUint8Array());

  console.log(`\nSaved to: ${outputPath}`);

  const newText = extractText(outputPath);
  console.log('\nText after redaction:');
  console.log('---');
  console.log(newText.substring(0, 500) + (newText.length > 500 ? '...' : ''));
  console.log('---');

  console.log(`\nOriginal text length: ${originalText.length}`);
  console.log(`New text length: ${newText.length}`);
  console.log(`Difference: ${originalText.length - newText.length} characters`);
}

/**
 * Main test runner
 */
async function main() {
  console.log('='.repeat(60));
  console.log('MuPDF.js Redaction Test Suite');
  console.log('='.repeat(60));
  console.log(`\nmupdf version: ${mupdf.PDFDocument ? 'loaded' : 'not loaded'}`);
  console.log(`Results directory: ${RESULTS_DIR}`);

  // Check if a PDF was provided
  const providedPdf = process.argv[2];

  if (providedPdf) {
    if (!fs.existsSync(providedPdf)) {
      console.error(`ERROR: File not found: ${providedPdf}`);
      process.exit(1);
    }
    await testWithExistingPdf(providedPdf);
    return;
  }

  // Create test PDF
  const testPdfPath = createTestPdf();

  // Show original content
  console.log('\n--- Original PDF Content ---');
  const originalText = extractText(testPdfPath);
  console.log(originalText.trim());

  // Run tests with different save options
  const results = [];

  // Test 1: page.applyRedactions() with no garbage collection
  results.push(await testPageRedactions(testPdfPath, 'compress', 'page-redact-no-garbage'));

  // Test 2: page.applyRedactions() with garbage=1
  results.push(await testPageRedactions(testPdfPath, 'garbage=1,compress', 'page-redact-garbage1'));

  // Test 3: page.applyRedactions() with garbage=2
  results.push(await testPageRedactions(testPdfPath, 'garbage=2,compress', 'page-redact-garbage2'));

  // Test 4: page.applyRedactions() with garbage=3
  results.push(await testPageRedactions(testPdfPath, 'garbage=3,compress', 'page-redact-garbage3'));

  // Test 5: page.applyRedactions() with garbage=4 (max)
  results.push(await testPageRedactions(testPdfPath, 'garbage=4,compress', 'page-redact-garbage4'));

  // Test 6: annotation.applyRedaction() with garbage=4
  results.push(await testAnnotationRedaction(testPdfPath, 'garbage=4,compress', 'annot-redact-garbage4'));

  // Test 7: page.applyRedactions() with incremental save (should NOT work for redaction)
  results.push(await testPageRedactions(testPdfPath, 'incremental', 'page-redact-incremental'));

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  for (const result of results) {
    if (result) {
      const status = result.success ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${result.testName}`);
      if (!result.success) {
        if (!result.secretRemoved) console.log('       - SECRET text not removed');
        if (!result.confidentialRemoved) console.log('       - CONFIDENTIAL text not removed');
        if (!result.publicKept) console.log('       - PUBLIC text unexpectedly removed');
        if (!result.normalKept) console.log('       - Normal text unexpectedly removed');
      }
    }
  }

  console.log(`\nTest files saved to: ${RESULTS_DIR}`);
  console.log('\nTo inspect results:');
  console.log(`  open ${RESULTS_DIR}`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
