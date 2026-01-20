#!/usr/bin/env node
/**
 * Detailed debugging test for mupdf.js redaction
 */

import * as mupdf from 'mupdf';
import * as fs from 'fs';

const INPUT_PDF = '/tmp/mupdf-redaction-tests/test-input.pdf';
const OUTPUT_PDF = '/tmp/mupdf-redaction-tests/debug-output.pdf';

function main() {
  console.log('=== MuPDF.js Redaction Debug Test ===\n');

  // Load the test PDF
  const data = fs.readFileSync(INPUT_PDF);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');

  console.log(`Document loaded: ${doc.countPages()} pages`);

  const pdfDoc = doc.asPDF();
  if (!pdfDoc) {
    console.log('ERROR: Not a PDF');
    return;
  }

  const page = pdfDoc.loadPage(0);
  const bounds = page.getBounds();
  console.log(`Page bounds: [${bounds.join(', ')}]`);

  // Check existing annotations
  const existingAnnots = page.getAnnotations();
  console.log(`Existing annotations: ${existingAnnots.length}`);

  // Get structured text to find where text actually is
  const stext = page.toStructuredText();
  console.log('\nStructured text analysis:');

  // Walk through text blocks to find positions
  let textPositions = [];
  stext.walk({
    beginTextBlock: (bbox) => {
      console.log(`  TextBlock at [${bbox.map(n => n.toFixed(1)).join(', ')}]`);
    },
    beginLine: (bbox, wmode, dir) => {
      console.log(`    Line at [${bbox.map(n => n.toFixed(1)).join(', ')}]`);
    },
    onChar: (c, origin, font, size, quad, color) => {
      // Collect first char of each word to understand positioning
      if (c === 'S' || c === 'C' || c === 'P' || c === 'N') {
        textPositions.push({ char: c, origin, quad });
      }
    }
  });

  console.log('\nKey character positions (first letter of key words):');
  for (const pos of textPositions) {
    console.log(`  '${pos.char}' at origin [${pos.origin.map(n => n.toFixed(1)).join(', ')}], quad: [${pos.quad.map(n => n.toFixed(1)).join(', ')}]`);
  }

  // Create redaction annotation
  console.log('\n--- Creating Redaction Annotation ---');

  // Find the SECRET line - it should be near the top of the page
  // Based on the structured text, let's use coordinates that definitely cover it
  // In PDF coords: [x0, y0, x1, y1] where y=0 is at bottom

  // Let's search for text to get exact positions
  const searchResults = page.search('SECRET');
  console.log(`\nSearch for "SECRET" found ${searchResults.length} results:`);
  for (const quads of searchResults) {
    console.log(`  Quads: ${JSON.stringify(quads)}`);
  }

  // Create redact annotation using search result bounds if available
  let redactRect;
  if (searchResults.length > 0 && searchResults[0].length > 0) {
    const quad = searchResults[0][0]; // First result, first quad
    // Quad is [x0,y0, x1,y1, x2,y2, x3,y3] - 4 corners
    const minX = Math.min(quad[0], quad[2], quad[4], quad[6]) - 5;
    const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]) + 200; // Extend to cover full line
    const minY = Math.min(quad[1], quad[3], quad[5], quad[7]) - 5;
    const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]) + 5;
    redactRect = [minX, minY, maxX, maxY];
  } else {
    // Fallback - use approximate position
    redactRect = [40, 690, 400, 720];
  }

  console.log(`\nCreating redaction annotation with rect: [${redactRect.join(', ')}]`);

  const redactAnnot = page.createAnnotation('Redact');
  console.log(`Annotation created, type: ${redactAnnot.getType()}`);

  // Set the rect
  redactAnnot.setRect(redactRect);

  // Verify rect was set
  const verifyRect = redactAnnot.getRect();
  console.log(`Verified rect: [${verifyRect.join(', ')}]`);

  // Check if annotation has rect
  console.log(`hasRect: ${redactAnnot.hasRect()}`);

  // Get annotation bounds
  const annotBounds = redactAnnot.getBounds();
  console.log(`Annotation bounds: [${annotBounds.join(', ')}]`);

  // Check annotations on page now
  const annotsAfter = page.getAnnotations();
  console.log(`\nAnnotations on page after creation: ${annotsAfter.length}`);
  for (const a of annotsAfter) {
    console.log(`  - Type: ${a.getType()}, Rect: [${a.getRect().join(', ')}]`);
  }

  // Try calling update() on the annotation
  console.log('\nCalling annotation.update()...');
  const updateResult = redactAnnot.update();
  console.log(`Update result: ${updateResult}`);

  // Now apply redactions
  console.log('\n--- Applying Redactions ---');
  console.log('Calling page.applyRedactions(false, 2, 2, 0)...');

  // Parameters: black_boxes=false, image_method=2, line_art_method=2, text_method=0 (remove)
  page.applyRedactions(false, 2, 2, 0);

  console.log('applyRedactions completed');

  // Check if annotations still exist
  // Need to refresh the annotation list
  const annotsAfterRedact = page.getAnnotations();
  console.log(`Annotations after applyRedactions: ${annotsAfterRedact.length}`);

  // Call page update
  console.log('\nCalling page.update()...');
  const pageUpdateResult = page.update();
  console.log(`Page update result: ${pageUpdateResult}`);

  // Save the document
  console.log('\n--- Saving Document ---');

  // Try different save options
  const saveOptions = 'garbage=4,compress,clean,sanitize';
  console.log(`Save options: "${saveOptions}"`);

  const buffer = pdfDoc.saveToBuffer(saveOptions);
  fs.writeFileSync(OUTPUT_PDF, buffer.asUint8Array());

  console.log(`Saved to: ${OUTPUT_PDF}`);
  console.log(`File size: ${buffer.asUint8Array().length} bytes`);

  // Verify by reopening
  console.log('\n--- Verification ---');
  const verifyData = fs.readFileSync(OUTPUT_PDF);
  const verifyDoc = mupdf.Document.openDocument(verifyData, 'application/pdf');
  const verifyPage = verifyDoc.loadPage(0);

  const verifyText = verifyPage.toStructuredText().asText();
  console.log('\nExtracted text from saved PDF:');
  console.log('---');
  console.log(verifyText);
  console.log('---');

  const hasSecret = verifyText.includes('SECRET');
  console.log(`\nSECRET text ${hasSecret ? 'STILL PRESENT (FAILED)' : 'REMOVED (SUCCESS)'}`);

  // Also check the raw page content stream
  console.log('\n--- Checking Page Content Stream ---');
  const pageObj = pdfDoc.findPage(0);
  console.log(`Page object: ${pageObj}`);

  const contents = pageObj.get('Contents');
  console.log(`Contents type: ${contents.isStream() ? 'stream' : contents.isArray() ? 'array' : 'other'}`);

  if (contents.isStream()) {
    const streamData = contents.readStream().asString();
    console.log(`Content stream length: ${streamData.length}`);
    console.log(`Contains "SECRET": ${streamData.includes('SECRET')}`);
    console.log('\nFirst 500 chars of content stream:');
    console.log(streamData.substring(0, 500));
  }
}

main();
