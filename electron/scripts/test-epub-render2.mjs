/**
 * Find and render the copyright page from the EPUB
 */

import * as fs from 'fs';

const TEST_EPUB = '/Volumes/Callisto/books/ww2/Bonhoeffer the Assassin. Nation, Mark Thiessen; Siegrist, Anthony G; Umbel, Daniel P.epub';
const OUTPUT_DIR = '/tmp/epub-test';

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const mupdf = await import('mupdf');

  console.log('Loading EPUB:', TEST_EPUB);
  const data = fs.readFileSync(TEST_EPUB);
  const doc = mupdf.Document.openDocument(data, 'application/epub+zip');

  const totalPages = doc.countPages();
  console.log(`Total pages: ${totalPages}`);

  // Search for page containing "2013" or "ISBN" (copyright page)
  for (let i = 0; i < Math.min(20, totalPages); i++) {
    const page = doc.loadPage(i);
    try {
      const stext = page.toStructuredText('preserve-whitespace');
      const json = JSON.parse(stext.asJSON());
      let pageText = '';
      for (const block of json.blocks || []) {
        if (block.type === 'text') {
          for (const line of block.lines || []) {
            for (const span of line.spans || []) {
              pageText += span.text + ' ';
            }
          }
        }
      }

      if (pageText.includes('ISBN') || pageText.includes('2013') || pageText.includes('Baker')) {
        console.log(`\nPage ${i + 1} contains copyright info:`);
        console.log(`  "${pageText.substring(0, 100)}..."`);

        // Render this page
        const matrix = mupdf.Matrix.scale(2.0, 2.0);
        const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
        const pngPath = `${OUTPUT_DIR}/copyright-page-${i + 1}.png`;
        fs.writeFileSync(pngPath, pixmap.asPNG());
        console.log(`  Saved: ${pngPath}`);
      }
    } catch (e) {
      // Skip pages that can't be parsed
    }
  }

  console.log('\n=== Done! ===');
}

main().catch(console.error);
