/**
 * The cover prep extracts to `<process_dir>/<stem>.jpg`, re-encoded as a JPEG at quality 75. The answer has
 * three shapes and each means something: the written path, true when the book has no cover at all, and
 * false when it could not be read. So `cover: true` does not mean a cover was written.
 *
 * sharp's JPEG is not Pillow's byte for byte, and a CMYK cover comes out sRGB here where Pillow kept CMYK.
 * Which covers get written and which refuse is what stays the same.
 */

import * as path from 'path';

import type { EpubBook } from './epub';

const coverBytes = async (book: EpubBook): Promise<Buffer | null> => {
  const [cover] = book.itemsOfType('cover');
  if (cover) {
    const content = await cover.content();
    if (content.length > 0) return content;
  }
  for (const item of book.itemsOfType('image')) {
    if (item.fileName.toLowerCase().includes('cover') || item.id.toLowerCase().includes('cover')) {
      const content = await item.content();
      if (content.length > 0) return content;
      break;
    }
  }
  return null;
};

export async function writeCover(book: EpubBook, processDir: string, filenameNoExt: string, log: (line: string) => void): Promise<string | boolean> {
  try {
    const bytes = await coverBytes(book);
    if (!bytes) return true;
    const sharp = require('sharp') as typeof import('sharp');
    const image = sharp(bytes, { pages: 1 });
    const meta = await image.metadata();
    // Pillow cannot read an SVG, and cannot write these two as a JPEG.
    if (meta.format === 'svg') throw new Error('cannot identify image file');
    if (meta.space === 'b-w' && meta.channels === 2) throw new Error('cannot write mode LA as JPEG');
    if (meta.depth === 'ushort' && meta.space !== 'srgb' && meta.space !== 'rgb16') throw new Error('cannot write mode I;16 as JPEG');
    const file = path.join(processDir, `${filenameNoExt}.jpg`);
    await image.removeAlpha().jpeg({ quality: 75, chromaSubsampling: '4:2:0' }).toFile(file);
    return file;
  } catch (err) {
    log(`get_cover() error: ${(err as Error).message}`);
    return false;
  }
}
