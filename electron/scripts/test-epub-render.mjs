/**
 * Test EPUB rendering with mupdf directly
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

  // Open as generic document (mupdf handles EPUB)
  const doc = mupdf.Document.openDocument(data, 'application/epub+zip');

  const totalPages = doc.countPages();
  console.log(`Total pages: ${totalPages}`);

  // Render first few pages
  for (let i = 0; i < Math.min(5, totalPages); i++) {
    console.log(`\nRendering page ${i + 1}...`);
    const page = doc.loadPage(i);
    const bounds = page.getBounds();
    console.log(`  Bounds: [${bounds.map(n => n.toFixed(1)).join(', ')}]`);

    // Render at 2x scale
    const matrix = mupdf.Matrix.scale(2.0, 2.0);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);

    const pngPath = `${OUTPUT_DIR}/page-${i + 1}.png`;
    fs.writeFileSync(pngPath, pixmap.asPNG());
    console.log(`  Saved: ${pngPath}`);

    // Also check structured text
    try {
      const stext = page.toStructuredText('preserve-whitespace');
      const json = JSON.parse(stext.asJSON());
      const textBlocks = json.blocks?.filter(b => b.type === 'text') || [];
      console.log(`  Text blocks: ${textBlocks.length}`);
      if (textBlocks.length > 0) {
        const firstLine = textBlocks[0]?.lines?.[0];
        const font = firstLine?.spans?.[0]?.font?.name || 'unknown';
        const text = firstLine?.spans?.map(s => s.text).join('') || '';
        console.log(`  First line font: ${font}`);
        console.log(`  First text: "${text.substring(0, 50)}..."`);
      }
    } catch (e) {
      console.log(`  Error getting structured text: ${e.message}`);
    }
  }

  console.log(`\n=== Done! ===`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch(console.error);
