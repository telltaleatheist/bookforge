/**
 * Test mupdf redaction with various parameter combinations
 */
import * as fs from 'fs';
import * as mupdf from 'mupdf';

const PDF_PATH = '/Volumes/Callisto/books/ww2/Ethnic Cleansing in the USSR, 1937-1949. Pohl, Otto. (1999).pdf';

async function testRedaction(testName, params) {
  const data = fs.readFileSync(PDF_PATH);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();

  const pageNum = 16;
  const page = pdfDoc.loadPage(pageNum);
  const bounds = page.getBounds();
  const pageHeight = bounds[3] - bounds[1];

  // Get target bbox
  const blocks = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON(1)).blocks;
  let bbox = null;
  for (const b of blocks) {
    if (!b.lines) continue;
    const text = b.lines.map(l => l.text || '').join('');
    if (text.toLowerCase().includes('koren')) {
      bbox = b.bbox;
      break;
    }
  }

  // Convert to PDF coords
  const rect = [
    bbox.x,
    pageHeight - (bbox.y + bbox.h),
    bbox.x + bbox.w,
    pageHeight - bbox.y
  ];

  // Create redaction annotation
  const annot = page.createAnnotation('Redact');
  annot.setRect(rect);

  // Apply with test params
  page.applyRedactions(...params);

  // Check result
  const outPath = `/tmp/redact-test-${testName}.pdf`;
  fs.writeFileSync(outPath, pdfDoc.saveToBuffer('garbage,compress').asUint8Array());

  const doc2 = mupdf.Document.openDocument(fs.readFileSync(outPath), 'application/pdf');
  const page2 = doc2.loadPage(pageNum);
  const blocks2 = JSON.parse(page2.toStructuredText('preserve-whitespace').asJSON(1)).blocks;

  let found = false;
  for (const b of blocks2) {
    if (!b.lines) continue;
    const text = b.lines.map(l => l.text || '').join('');
    if (text.toLowerCase().includes('koren')) {
      found = true;
      break;
    }
  }

  console.log(`${testName}: params=${JSON.stringify(params)} -> ${found ? 'FAIL (text remains)' : 'SUCCESS (removed)'}`);
  return !found;
}

try {
  console.log('Testing various applyRedactions parameters...\n');
  console.log('Parameters: (black_boxes, image_method, line_art_method, text_method)\n');

  // Test various combinations
  await testRedaction('default', []);
  await testRedaction('text1', [false, 0, 0, 1]);
  await testRedaction('text2', [false, 0, 0, 2]);
  await testRedaction('all1', [false, 1, 1, 1]);
  await testRedaction('all2', [false, 2, 2, 2]);
  await testRedaction('blackbox', [true, 0, 0, 1]);
  await testRedaction('noparams', [false]);
  await testRedaction('justtext', [false, 0, 0]);

  // Also check what methods the page annotation has
  const data = fs.readFileSync(PDF_PATH);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const page = doc.asPDF().loadPage(16);
  const annot = page.createAnnotation('Redact');

  console.log('\nAnnotation methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(annot)).filter(m => !m.startsWith('_')));

} catch (e) {
  console.error('Error:', e.message);
}
