/**
 * SIMPLE TEST: Remove specific text from a PDF
 * Run with: node test-simple-remove.mjs
 */
import * as fs from 'fs';
import * as mupdf from 'mupdf';
import { execSync } from 'child_process';

const PDF_PATH = '/Volumes/Callisto/books/ww2/Ethnic Cleansing in the USSR, 1937-1949. Pohl, Otto. (1999).pdf';
const OUTPUT_PATH = '/tmp/simple-test.pdf';
const TEST_PAGE = 3;  // Title page (page 4, 0-indexed as 3)

console.log('=== Simple Text Removal Test ===\n');

// Load PDF
const data = fs.readFileSync(PDF_PATH);
const doc = mupdf.Document.openDocument(data, 'application/pdf');
const pdfDoc = doc.asPDF();

// Get the page
const pageObj = pdfDoc.findPage(TEST_PAGE);
const contents = pageObj.get('Contents');

// Read content stream
function bufToStr(buf) {
  if (buf?.asUint8Array) return Buffer.from(buf.asUint8Array()).toString('latin1');
  return Buffer.from(buf).toString('latin1');
}

let contentStr = bufToStr(contents.readStream());
console.log('Original content length:', contentStr.length);

// Show what text we have
console.log('\nOriginal text on page (via mutool):');
const originalText = execSync(`/opt/homebrew/bin/mutool draw -o - -F text "${PDF_PATH}" ${TEST_PAGE + 1} 2>&1`).toString();
console.log(originalText);

// Let's remove "Ethnic Cleansing" by finding and removing the TJ that contains it
console.log('\n--- Attempting to remove "Ethnic Cleansing" ---');

// Find TJ arrays containing "Ethnic"
const ethnicMatch = contentStr.match(/\[([^\]]*Ethnic[^\]]*)\]\s*TJ/i);
if (ethnicMatch) {
  console.log('Found TJ containing "Ethnic":');
  console.log('  ', ethnicMatch[0].substring(0, 100));

  // Remove it
  contentStr = contentStr.replace(ethnicMatch[0], '');
  console.log('Removed!');
} else {
  console.log('Did not find TJ with "Ethnic"');
}

// Also try to remove "USSR"
const ussrMatch = contentStr.match(/\[([^\]]*USSR[^\]]*)\]\s*TJ/i);
if (ussrMatch) {
  console.log('Found TJ containing "USSR":');
  console.log('  ', ussrMatch[0].substring(0, 100));
  contentStr = contentStr.replace(ussrMatch[0], '');
  console.log('Removed!');
} else {
  console.log('Did not find TJ with "USSR"');
}

console.log('\nModified content length:', contentStr.length);

// Write back
contents.writeStream(Buffer.from(contentStr, 'latin1'));
console.log('Content stream updated');

// Save
const buffer = pdfDoc.saveToBuffer('garbage,compress');
fs.writeFileSync(OUTPUT_PATH, buffer.asUint8Array());
console.log('Saved to:', OUTPUT_PATH);

// Verify
console.log('\n--- Verification ---');
const newText = execSync(`/opt/homebrew/bin/mutool draw -o - -F text "${OUTPUT_PATH}" ${TEST_PAGE + 1} 2>&1`).toString();
console.log('Text after modification:');
console.log(newText);

if (newText.includes('Ethnic')) {
  console.log('\n❌ FAIL: "Ethnic" still in PDF');
} else {
  console.log('\n✓ SUCCESS: "Ethnic" removed from PDF');
}

console.log('\nOpen', OUTPUT_PATH, 'to verify visually');
