/**
 * Analyze Chrome-generated PDF structure to understand text/image relationship
 */

import * as fs from 'fs';

const TEST_PDF = '/Volumes/Callisto/books/ww2/Why Trump isn\'t a fascist. Evans, Richard J. (2021).pdf';

async function main() {
  const mupdf = await import('mupdf');

  console.log('Loading PDF:', TEST_PDF);
  const data = fs.readFileSync(TEST_PDF);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pdfDoc = doc.asPDF();

  if (!pdfDoc) {
    console.error('Failed to open as PDF document');
    return;
  }

  // Analyze page 8 (the one with the issue)
  const pageNum = 7; // 0-indexed
  const page = pdfDoc.loadPage(pageNum);
  const bounds = page.getBounds();
  console.log(`\nPage ${pageNum + 1} bounds: [${bounds.join(', ')}]`);

  // Get structured text
  const stext = page.toStructuredText('preserve-images');
  const stextJson = JSON.parse(stext.asJSON());

  console.log('\n=== Block Analysis ===');
  let imageCount = 0;
  let textCount = 0;

  for (const block of stextJson.blocks) {
    if (block.type === 'image') {
      imageCount++;
      const bbox = block.bbox;
      const bboxStr = typeof bbox === 'object' && 'x' in bbox
        ? `[${bbox.x.toFixed(1)}, ${bbox.y.toFixed(1)}, ${(bbox.x + bbox.w).toFixed(1)}, ${(bbox.y + bbox.h).toFixed(1)}]`
        : JSON.stringify(bbox);
      console.log(`IMAGE ${imageCount}: bbox=${bboxStr}`);
    } else if (block.type === 'text') {
      textCount++;
      const lines = block.lines || [];
      const firstLine = lines[0];
      const text = firstLine?.spans?.map(s => s.text).join('') || '';
      const font = firstLine?.font?.name || 'unknown';
      console.log(`TEXT ${textCount}: "${text.substring(0, 40)}..." font=${font}`);
    }
  }

  console.log(`\nTotal: ${imageCount} images, ${textCount} text blocks`);

  // Check page resources for fonts
  console.log('\n=== Page Resources (PDF Dictionary) ===');
  try {
    const pageObj = pdfDoc.findPage(pageNum);
    if (pageObj) {
      console.log('Page object type:', pageObj.constructor.name);

      // Get the Resources dictionary
      const resources = pageObj.get('Resources');
      if (resources) {
        console.log('Resources found');

        // Check fonts
        const fonts = resources.get('Font');
        if (fonts) {
          console.log('\nFonts:');
          fonts.forEach((value, key) => {
            console.log(`  ${key}: ${JSON.stringify(value).substring(0, 100)}`);
          });
        }

        // Check XObjects (images)
        const xobjects = resources.get('XObject');
        if (xobjects) {
          console.log('\nXObjects (images):');
          xobjects.forEach((value, key) => {
            const subtype = value.get ? value.get('Subtype')?.toString() : 'unknown';
            console.log(`  ${key}: Subtype=${subtype}`);
          });
        }
      }
    }
  } catch (err) {
    console.log('Error reading page resources:', err.message);
  }

  // Try to understand what happens when we create a redaction on an image area
  console.log('\n=== Test: Creating redaction on image area ===');

  // Find the small circle images
  const imageBlocks = stextJson.blocks.filter(b => b.type === 'image');
  if (imageBlocks.length > 0) {
    // Use first small image (circle icon)
    const smallImages = imageBlocks.filter(b => {
      const w = b.bbox.w || (b.bbox[2] - b.bbox[0]) || 100;
      return w < 100;
    });

    if (smallImages.length > 0) {
      const target = smallImages[0];
      const bbox = target.bbox;
      const rect = typeof bbox === 'object' && 'x' in bbox
        ? [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h]
        : bbox;

      console.log(`Target image bbox: [${rect.map(n => n.toFixed(1)).join(', ')}]`);

      // Create redaction
      const annot = page.createAnnotation('Redact');
      annot.setRect(rect);

      // Apply with image_method=2 (clear to white), text_method=1 (preserve)
      console.log('Applying redaction (image_method=2, text_method=1)...');
      page.applyRedactions(false, 2, 0, 1);

      // Check if any text was affected
      const stextAfter = page.toStructuredText('preserve-images');
      const stextAfterJson = JSON.parse(stextAfter.asJSON());

      const textAfter = stextAfterJson.blocks.filter(b => b.type === 'text').length;
      console.log(`Text blocks before: ${textCount}, after: ${textAfter}`);

      if (textAfter !== textCount) {
        console.log('WARNING: Text was affected by image redaction!');
      }
    }
  }
}

main().catch(console.error);
