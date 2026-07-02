/**
 * epub-writer.ts — build a minimal, valid EPUB 3 in-process, no Calibre and no
 * external zip binary. Generalises the single-chapter writer that used to live
 * inline in `language-learning:finalize-content` (main.ts) to N chapters, so the
 * mobile import→edit flow can turn edited blocks + chapter markers into a real
 * chaptered epub.
 *
 * The ZIP is hand-assembled (local headers + central directory + EOCD) with the
 * mimetype entry first and stored uncompressed, exactly as the EPUB spec wants.
 */

import * as zlib from 'zlib';
import { promisify } from 'util';

const deflateRaw = promisify(zlib.deflateRaw);

export interface EpubChapter {
  /** Chapter title — used in the nav (TOC). */
  title: string;
  /** Ordered paragraph texts for this chapter (plain text; escaped for us). */
  paragraphs: string[];
}

export interface EpubDoc {
  title: string;
  author?: string;
  language?: string;
  /** Stable unique id (e.g. a project slug); defaults to a title-derived urn. */
  identifier?: string;
  /** ISO timestamp for dcterms:modified. Passed in so callers control determinism. */
  modifiedAt: string;
  chapters: EpubChapter[];
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CRC32 over a buffer (ZIP variant). */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Render one chapter's XHTML. The title becomes an <h2>; paragraphs become <p>. */
function chapterXhtml(chapter: EpubChapter, language: string): string {
  const heading = chapter.title.trim() ? `  <h2>${escapeXml(chapter.title)}</h2>\n` : '';
  const body = chapter.paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `  <p>${escapeXml(p)}</p>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(chapter.title)}</title>
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; margin: 2em; }
    p { margin-bottom: 1em; }
    h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  </style>
</head>
<body>
${heading}${body}
</body>
</html>`;
}

/**
 * Build a complete .epub as a Buffer. At least one chapter is required; empty
 * chapters (no paragraphs and no title) are dropped, and if that leaves nothing
 * a single placeholder chapter keeps the epub valid.
 */
export async function buildEpubBuffer(doc: EpubDoc): Promise<Buffer> {
  const language = doc.language || 'en';
  const identifier = doc.identifier || `urn:bookforge:${encodeURIComponent(doc.title || 'untitled')}`;

  let chapters = doc.chapters.filter((c) => c.title.trim() || c.paragraphs.some((p) => p.trim()));
  if (chapters.length === 0) chapters = [{ title: doc.title || 'Untitled', paragraphs: [] }];

  // Assemble the in-memory file set. mimetype MUST be first + uncompressed.
  const files: Array<{ name: string; data: Buffer; compress: boolean }> = [];
  files.push({ name: 'mimetype', data: Buffer.from('application/epub+zip'), compress: false });

  files.push({
    name: 'META-INF/container.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
    compress: true,
  });

  const manifestItems = chapters
    .map((_c, i) => `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spineItems = chapters.map((_c, i) => `    <itemref idref="chapter${i + 1}"/>`).join('\n');

  files.push({
    name: 'OEBPS/content.opf',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(doc.title || 'Untitled')}</dc:title>
    ${doc.author ? `<dc:creator>${escapeXml(doc.author)}</dc:creator>` : ''}
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${doc.modifiedAt.replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
${manifestItems}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>`),
    compress: true,
  });

  const navList = chapters
    .map((c, i) => `      <li><a href="chapter${i + 1}.xhtml">${escapeXml(c.title || `Chapter ${i + 1}`)}</a></li>`)
    .join('\n');
  files.push({
    name: 'OEBPS/nav.xhtml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head><title>Navigation</title></head>
<body>
  <nav epub:type="toc">
    <ol>
${navList}
    </ol>
  </nav>
</body>
</html>`),
    compress: true,
  });

  chapters.forEach((c, i) => {
    files.push({
      name: `OEBPS/chapter${i + 1}.xhtml`,
      data: Buffer.from(chapterXhtml(c, language)),
      compress: true,
    });
  });

  // Hand-write the ZIP.
  const centralDir: Buffer[] = [];
  const fileChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of files) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = entry.compress && entry.data.length > 0 ? ((await deflateRaw(entry.data)) as Buffer) : entry.data;
    const method = entry.compress && entry.data.length > 0 ? 8 : 0;
    const crc = crc32(entry.data);

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(entry.data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); nameBuf.copy(lh, 30);
    fileChunks.push(lh, compressed);

    const ce = Buffer.alloc(46 + nameBuf.length);
    ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0, 8); ce.writeUInt16LE(method, 10); ce.writeUInt16LE(0, 12);
    ce.writeUInt16LE(0, 14); ce.writeUInt32LE(crc, 16); ce.writeUInt32LE(compressed.length, 20);
    ce.writeUInt32LE(entry.data.length, 24); ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(0, 30); ce.writeUInt16LE(0, 32); ce.writeUInt16LE(0, 34);
    ce.writeUInt16LE(0, 36); ce.writeUInt32LE(0, 38); ce.writeUInt32LE(offset, 42);
    nameBuf.copy(ce, 46);
    centralDir.push(ce);
    offset += lh.length + compressed.length;
  }

  const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...fileChunks, ...centralDir, eocd]);
}
