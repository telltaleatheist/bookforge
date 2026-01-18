/**
 * Standalone PDF text removal test
 * Run with: node test-pdf-edit.mjs
 */
import * as fs from 'fs';
import * as mupdf from 'mupdf';

// Test PDF
const PDF_PATH = '/Volumes/Callisto/books/ww2/Ethnic Cleansing in the USSR, 1937-1949. Pohl, Otto. (1999).pdf';
const OUTPUT_PATH = '/tmp/test-edited.pdf';

// Page to test (0-indexed)
const TEST_PAGE = 24;

console.log('=== PDF Text Removal Test ===\n');

// Load PDF
const data = fs.readFileSync(PDF_PATH);
const doc = mupdf.Document.openDocument(data, 'application/pdf');
const pdfDoc = doc.asPDF();

console.log(`Loaded: ${PDF_PATH}`);
console.log(`Pages: ${pdfDoc.countPages()}`);

// Get page info
const page = pdfDoc.loadPage(TEST_PAGE);
const bounds = page.getBounds();
const pageHeight = bounds[3] - bounds[1];
console.log(`\nPage ${TEST_PAGE + 1} bounds:`, bounds);
console.log(`Page height: ${pageHeight}`);

// Get structured text
console.log('\n=== Structured Text ===');
const stext = page.toStructuredText('preserve-whitespace');
const json = stext.asJSON(1);
const stextData = JSON.parse(json);

// Show blocks with text
let blockCount = 0;
for (const block of stextData.blocks) {
  if (!block.lines) continue;
  if (blockCount >= 8) {
    console.log('... (more blocks)');
    break;
  }

  const bbox = block.bbox;
  let text = '';

  for (const line of block.lines) {
    // Text is directly in line.text for this JSON format
    if (line.text) {
      text += line.text + ' ';
    }
  }
  text = text.trim().substring(0, 80);

  if (text) {
    console.log(`Block at (${bbox.x.toFixed(0)}, ${bbox.y.toFixed(0)}) size ${bbox.w.toFixed(0)}x${bbox.h.toFixed(0)}: "${text}"`);
    blockCount++;
  }
}

// Read content stream properly
console.log('\n=== Content Stream ===');
const pageObj = pdfDoc.findPage(TEST_PAGE);
const contents = pageObj.get('Contents');

// Helper to convert mupdf buffer to string
function bufferToString(buf) {
  if (typeof buf === 'string') return buf;
  if (buf && buf.asUint8Array) {
    return Buffer.from(buf.asUint8Array()).toString('latin1');
  }
  if (buf instanceof Uint8Array) {
    return Buffer.from(buf).toString('latin1');
  }
  if (Buffer.isBuffer(buf)) {
    return buf.toString('latin1');
  }
  // Last resort - it might be a node Buffer already
  try {
    return Buffer.from(buf).toString('latin1');
  } catch (e) {
    console.log('Buffer conversion failed:', e.message);
    return '';
  }
}

let contentStr = '';
if (contents.isStream()) {
  const streamData = contents.readStream();
  console.log('Stream data type:', typeof streamData, streamData?.constructor?.name);
  contentStr = bufferToString(streamData);
} else if (contents.isArray()) {
  console.log(`Content is array with ${contents.length} elements`);
  for (let i = 0; i < contents.length; i++) {
    const elem = contents.get(i);
    if (elem.isStream()) {
      contentStr += bufferToString(elem.readStream()) + '\n';
    }
  }
} else if (contents.isIndirect()) {
  // It might be an indirect reference
  const resolved = contents.resolve();
  console.log('Resolved type:', resolved.isStream() ? 'stream' : resolved.isArray() ? 'array' : 'other');
  if (resolved.isStream()) {
    contentStr = bufferToString(resolved.readStream());
  }
}

console.log(`Content stream length: ${contentStr.length} characters`);

if (contentStr.length > 0) {
  console.log('\nFirst 800 chars of content stream:');
  console.log(contentStr.substring(0, 800));

  // Count operators
  const btCount = (contentStr.match(/\bBT\b/g) || []).length;
  const etCount = (contentStr.match(/\bET\b/g) || []).length;
  const tmCount = (contentStr.match(/\bTm\b/g) || []).length;
  const tjCount = (contentStr.match(/\bTJ\b/g) || []).length;
  const tjLowerCount = (contentStr.match(/\bTj\b/g) || []).length;

  console.log(`\nOperator counts: BT=${btCount}, ET=${etCount}, Tm=${tmCount}, TJ=${tjCount}, Tj=${tjLowerCount}`);

  // Show some Tm positions
  const tmPattern = /([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+Tm/g;
  let match;
  let count = 0;
  console.log('\nFirst 5 Tm (text matrix) positions:');
  while ((match = tmPattern.exec(contentStr)) !== null && count < 5) {
    const x = parseFloat(match[5]);
    const y = parseFloat(match[6]);
    const scale = parseFloat(match[4]) || parseFloat(match[1]);
    console.log(`  Tm: x=${x.toFixed(1)}, y=${y.toFixed(1)}, scale=${scale.toFixed(1)}`);
    count++;
  }
} else {
  console.log('WARNING: Could not read content stream');
}

console.log('\n=== Coordinate Comparison ===');
console.log('Structured text uses y coordinate with origin at:',
  stextData.blocks[0]?.bbox?.y < pageHeight / 2 ? 'TOP (screen coords)' : 'BOTTOM (PDF coords)');
console.log('If blocks at top of page have small y values, coords are screen-style (y=0 at top)');

console.log('\n=== Done ===');
