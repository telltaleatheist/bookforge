import * as fs from 'fs';
import * as mupdf from 'mupdf';

const PDF_PATH = '/Volumes/Callisto/books/ww2/Ethnic Cleansing in the USSR, 1937-1949. Pohl, Otto. (1999).pdf';

const data = fs.readFileSync(PDF_PATH);
const doc = mupdf.Document.openDocument(data, 'application/pdf');
const pdfDoc = doc.asPDF();
const page = pdfDoc.loadPage(16);

// Get page object
const pageObj = page.getObject();
console.log('Page object keys:', Object.keys(pageObj));

// Check if page has Resources/XObject (Form XObjects contain embedded content)
const resources = pageObj.get('Resources');
if (resources) {
  console.log('\nResources keys:', resources.isIndirect() ? '[indirect]' : Object.keys(resources));
  const xobject = resources.get('XObject');
  if (xobject) {
    console.log('XObject exists - page may have embedded Form XObjects');
    // List XObjects
    const xobjDict = xobject.isIndirect() ? xobject.resolve() : xobject;
    console.log('XObject type:', typeof xobjDict, xobjDict?.constructor?.name);
  }
}

// Check Content type
const contents = pageObj.get('Contents');
console.log('\nContents type:', contents?.constructor?.name);
console.log('Contents is array:', Array.isArray(contents));

// Let's examine where the text lives - in a content stream or XObject?
// Run device over page to see structure
console.log('\n--- Text extraction test ---');
const stext = page.toStructuredText('preserve-whitespace');
const json = JSON.parse(stext.asJSON(1));
console.log('Number of blocks:', json.blocks.length);

// Check the first few blocks
for (let i = 0; i < Math.min(3, json.blocks.length); i++) {
  const b = json.blocks[i];
  if (b.lines) {
    const text = b.lines.map(l => l.text || '').join(' ').substring(0, 60);
    console.log(`Block ${i}: type=text, text="${text}..."`);
  } else {
    console.log(`Block ${i}: type=${b.type || 'image'}`);
  }
}
