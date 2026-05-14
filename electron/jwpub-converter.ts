/**
 * JWPUB Converter - Convert JW Library .jwpub files to EPUB
 *
 * JWPUB files are nested ZIP archives containing a SQLite database
 * with AES-128-CBC encrypted, zlib-compressed HTML content.
 *
 * Structure: .jwpub (ZIP) → contents (ZIP) → *.db (SQLite) + cover images
 *
 * Decryption algorithm (from sws2apps/jw-epub-parser, MIT licensed):
 * 1. Build pubCard from Publication table: "{MepsLanguageIndex}_{Symbol}_{Year}"
 *    (periodicals append "_{IssueTagNumber}")
 * 2. SHA-256 hash the pubCard
 * 3. XOR with a static 32-byte key
 * 4. First 16 bytes = AES key, last 16 bytes = IV
 * 5. AES-128-CBC decrypt each Content blob
 * 6. zlib inflate → HTML
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface JwpubManifest {
  name: string;
  hash: string;
  timestamp: string;
  contentFormat: string;
  publication: {
    fileName: string;
    title: string;
    shortTitle: string;
    symbol: string;
    language: number;
    year: number;
    publicationType: string;
    images?: Array<{
      fileName: string;
      width: number;
      height: number;
    }>;
  };
}

interface JwpubDocument {
  documentId: number;
  title: string;
  html: string;
  chapterNumber: number | null;
  class: string;
}

export interface JwpubConvertResult {
  success: boolean;
  outputPath?: string;
  metadata?: {
    title: string;
    author: string;
    year: string;
    language: string;
  };
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decryption
// ─────────────────────────────────────────────────────────────────────────────

// Static XOR key used in JW Library's key derivation
const STATIC_KEY_HEX = Buffer.from(
  'MTFjYmI1NTg3ZTMyODQ2ZDRjMjY3OTBjNjMzZGEyODlmNjZmZTU4NDJhM2E1ODVjZTFiYzNhMjk0YWY1YWRhNw==',
  'base64'
).toString('ascii');

function deriveKeyIv(pubCard: string): { key: Buffer; iv: Buffer } {
  const pubHash = crypto.createHash('sha256').update(pubCard).digest('hex');
  const hashBytes = Buffer.from(pubHash, 'hex');
  const keyBytes = Buffer.from(STATIC_KEY_HEX, 'hex');

  const xored = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    xored[i] = hashBytes[i] ^ keyBytes[i];
  }

  return {
    key: xored.subarray(0, 16),
    iv: xored.subarray(16, 32),
  };
}

function decryptContent(data: Buffer, key: Buffer, iv: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return zlib.inflateSync(decrypted).toString('utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP handling (minimal, using built-in Node)
// ─────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

function parseZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];

  // Find End of Central Directory record
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;

    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf-8');

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function extractZipEntry(buf: Buffer, entry: ZipEntry): Promise<Buffer> {
  const pos = entry.localHeaderOffset;
  if (buf.readUInt32LE(pos) !== 0x04034b50) {
    throw new Error(`Invalid local file header for ${entry.name}`);
  }

  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const dataOffset = pos + 30 + nameLen + extraLen;
  const compressedData = buf.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    // Stored (no compression)
    return Buffer.from(compressedData);
  } else if (entry.compressionMethod === 8) {
    // Deflate
    return await inflateRaw(compressedData) as Buffer;
  } else {
    throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite reader (minimal, read-only, for JWPUB databases)
// ─────────────────────────────────────────────────────────────────────────────

// We use better-sqlite3 which is commonly available in Electron apps,
// but fall back to spawning sqlite3 CLI if not available.

async function queryDatabase(
  dbPath: string,
  query: string
): Promise<any[]> {
  // Try better-sqlite3 first (bundled with many Electron apps)
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(query).all();
    db.close();
    return rows;
  } catch {
    // Fall back to sqlite3 CLI
    const { execFile } = require('child_process');
    const { promisify: pfy } = require('util');
    const execFileAsync = pfy(execFile);

    const { stdout } = await execFileAsync('sqlite3', [
      dbPath, '-json', query
    ], { maxBuffer: 50 * 1024 * 1024 });

    return JSON.parse(stdout);
  }
}

async function queryDatabaseBlobs(
  dbPath: string,
  query: string
): Promise<Array<Record<string, any>>> {
  // For blob data we need better-sqlite3 (CLI can't handle binary)
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(query).all();
    db.close();
    return rows;
  } catch (err) {
    throw new Error(
      'better-sqlite3 is required for JWPUB conversion. ' +
      'Install it with: npm install better-sqlite3'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB builder
// ─────────────────────────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEpub(
  title: string,
  language: string,
  year: number,
  chapters: JwpubDocument[],
  coverImage?: Buffer,
  coverMimeType?: string
): Buffer {
  // We'll build the EPUB as a ZIP in memory using raw buffer construction.
  // Since Node doesn't have a built-in ZIP writer, we'll use the archiver-like
  // approach with zlib for individual entries.

  const files: Array<{ name: string; data: Buffer; store?: boolean }> = [];

  // mimetype (must be stored, not compressed)
  files.push({ name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true });

  // META-INF/container.xml
  files.push({
    name: 'META-INF/container.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
  });

  // CSS
  files.push({
    name: 'OEBPS/style.css',
    data: Buffer.from(`body {
  font-family: Georgia, "Times New Roman", serif;
  margin: 1em;
  line-height: 1.6;
}
h1, h2, h3 { margin-top: 1.5em; }
p { margin: 0.5em 0; }
p.st { text-align: center; margin-top: 2em; }
p.sb { text-indent: 1.5em; }
p.qu { font-style: italic; color: #555; margin: 0.8em 0; }
p.ss { font-weight: bold; margin-top: 1.5em; }
p.si { margin-left: 2em; }
.pageNum { display: none; }
`)
  });

  // Cover image
  const coverExt = coverMimeType === 'image/png' ? 'png' : 'jpg';
  if (coverImage) {
    files.push({
      name: `OEBPS/images/cover.${coverExt}`,
      data: coverImage,
    });
  }

  // Chapter XHTML files
  for (const ch of chapters) {
    const filename = `chapter_${String(ch.documentId).padStart(3, '0')}.xhtml`;
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}" lang="${language}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(ch.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${ch.html}
</body>
</html>`;
    files.push({ name: `OEBPS/${filename}`, data: Buffer.from(xhtml, 'utf-8') });
  }

  // NAV (EPUB 3 TOC)
  const tocEntries = chapters
    .map(ch => {
      const filename = `chapter_${String(ch.documentId).padStart(3, '0')}.xhtml`;
      return `      <li><a href="${filename}">${escapeXml(ch.title)}</a></li>`;
    })
    .join('\n');

  files.push({
    name: 'OEBPS/nav.xhtml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><title>Table of Contents</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>Table of Contents</h1>
  <ol>
${tocEntries}
  </ol>
</nav>
</body>
</html>`, 'utf-8')
  });

  // NCX (EPUB 2 compat)
  const bookUuid = crypto.randomUUID();
  const ncxPoints = chapters
    .map((ch, i) => {
      const filename = `chapter_${String(ch.documentId).padStart(3, '0')}.xhtml`;
      return `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
      <content src="${filename}"/>
    </navPoint>`;
    })
    .join('\n');

  files.push({
    name: 'OEBPS/toc.ncx',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${bookUuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${ncxPoints}
  </navMap>
</ncx>`, 'utf-8')
  });

  // content.opf
  const manifestItems: string[] = [];
  const spineItems: string[] = [];

  manifestItems.push('    <item id="style" href="style.css" media-type="text/css"/>');
  manifestItems.push('    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  manifestItems.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

  if (coverImage) {
    manifestItems.push(
      `    <item id="cover-image" href="images/cover.${coverExt}" media-type="${coverMimeType || 'image/jpeg'}" properties="cover-image"/>`
    );
  }

  for (const ch of chapters) {
    const itemId = `ch${String(ch.documentId).padStart(3, '0')}`;
    const filename = `chapter_${String(ch.documentId).padStart(3, '0')}.xhtml`;
    manifestItems.push(`    <item id="${itemId}" href="${filename}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${itemId}"/>`);
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  files.push({
    name: 'OEBPS/content.opf',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:${bookUuid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${language}</dc:language>
    <dc:date>${year}</dc:date>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx">
${spineItems.join('\n')}
  </spine>
</package>`, 'utf-8')
  });

  // Build ZIP
  return createZipBuffer(files);
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ZIP writer
// ─────────────────────────────────────────────────────────────────────────────

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZipBuffer(files: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf-8');
    const uncompressedData = file.data;
    const crc = crc32(uncompressedData);

    let compressedData: Buffer;
    let compressionMethod: number;

    if (file.store) {
      compressedData = uncompressedData;
      compressionMethod = 0; // Stored
    } else {
      const deflated = zlib.deflateRawSync(uncompressedData);
      // Only use deflate if it actually saves space
      if (deflated.length < uncompressedData.length) {
        compressedData = deflated;
        compressionMethod = 8; // Deflated
      } else {
        compressedData = uncompressedData;
        compressionMethod = 0;
      }
    }

    // Local file header (30 bytes + name + data)
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4); // Version needed
    localHeader.writeUInt16LE(0, 6); // Flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0, 12); // Mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(uncompressedData.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuffer.copy(localHeader, 30);

    // Central directory entry (46 bytes + name)
    const centralEntry = Buffer.alloc(46 + nameBuffer.length);
    centralEntry.writeUInt32LE(0x02014b50, 0); // Signature
    centralEntry.writeUInt16LE(20, 4); // Version made by
    centralEntry.writeUInt16LE(20, 6); // Version needed
    centralEntry.writeUInt16LE(0, 8); // Flags
    centralEntry.writeUInt16LE(compressionMethod, 10);
    centralEntry.writeUInt16LE(0, 12); // Mod time
    centralEntry.writeUInt16LE(0, 14); // Mod date
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(compressedData.length, 20);
    centralEntry.writeUInt32LE(uncompressedData.length, 24);
    centralEntry.writeUInt16LE(nameBuffer.length, 28);
    centralEntry.writeUInt16LE(0, 30); // Extra field length
    centralEntry.writeUInt16LE(0, 32); // Comment length
    centralEntry.writeUInt16LE(0, 34); // Disk number start
    centralEntry.writeUInt16LE(0, 36); // Internal attrs
    centralEntry.writeUInt32LE(0, 38); // External attrs
    centralEntry.writeUInt32LE(offset, 42); // Local header offset
    nameBuffer.copy(centralEntry, 46);

    localHeaders.push(Buffer.concat([localHeader, compressedData]));
    centralEntries.push(centralEntry);
    offset += localHeader.length + compressedData.length;
  }

  // End of central directory
  const centralDirData = Buffer.concat(centralEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // CD start disk
  eocd.writeUInt16LE(files.length, 8); // CD entries on this disk
  eocd.writeUInt16LE(files.length, 10); // Total CD entries
  eocd.writeUInt32LE(centralDirData.length, 12);
  eocd.writeUInt32LE(offset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localHeaders, centralDirData, eocd]);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEPS language index → ISO 639-1 mapping (common languages)
// ─────────────────────────────────────────────────────────────────────────────

const MEPS_LANG_MAP: Record<number, string> = {
  0: 'en', 1: 'es', 2: 'pt', 3: 'fr', 4: 'it', 5: 'de',
  6: 'el', 7: 'nl', 8: 'ja', 9: 'da', 10: 'no', 11: 'sv',
  12: 'fi', 13: 'ko', 14: 'zh', 15: 'ru', 16: 'pl', 17: 'cs',
  18: 'hu', 19: 'ro', 20: 'hr', 21: 'sk', 22: 'sl', 23: 'sr',
  24: 'uk', 25: 'bg', 26: 'mk', 27: 'tr', 28: 'ar', 29: 'he',
  30: 'hi', 31: 'th', 32: 'id', 33: 'ms', 34: 'tl', 35: 'vi',
  36: 'sw', 37: 'af', 38: 'sq', 39: 'et', 40: 'lv', 41: 'lt',
  42: 'ka', 43: 'hy', 44: 'is',
};

// ─────────────────────────────────────────────────────────────────────────────
// Main converter
// ─────────────────────────────────────────────────────────────────────────────

export async function convertJwpubToEpub(jwpubPath: string): Promise<JwpubConvertResult> {
  const tmpDir = path.join(os.tmpdir(), `bookforge-jwpub-${Date.now()}`);

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // 1. Read and parse the outer ZIP
    const jwpubData = await fs.readFile(jwpubPath);
    const outerEntries = parseZipEntries(jwpubData);

    // Read manifest.json
    const manifestEntry = outerEntries.find(e => e.name === 'manifest.json');
    if (!manifestEntry) throw new Error('No manifest.json found in JWPUB');
    const manifestData = await extractZipEntry(jwpubData, manifestEntry);
    const manifest: JwpubManifest = JSON.parse(manifestData.toString('utf-8'));

    // 2. Extract the inner "contents" ZIP
    const contentsEntry = outerEntries.find(e => e.name === 'contents');
    if (!contentsEntry) throw new Error('No contents archive found in JWPUB');
    const contentsData = await extractZipEntry(jwpubData, contentsEntry);

    // 3. Parse inner ZIP to find .db and cover images
    const innerEntries = parseZipEntries(contentsData);
    const dbEntry = innerEntries.find(e => e.name.endsWith('.db'));
    if (!dbEntry) throw new Error('No database file found in JWPUB contents');

    // Extract database to temp dir
    const dbData = await extractZipEntry(contentsData, dbEntry);
    const dbPath = path.join(tmpDir, 'content.db');
    await fs.writeFile(dbPath, dbData);

    // Extract largest cover image
    let coverImage: Buffer | undefined;
    let coverMimeType = 'image/jpeg';
    const imageEntries = innerEntries
      .filter(e => /\.(jpg|jpeg|png)$/i.test(e.name))
      .sort((a, b) => b.uncompressedSize - a.uncompressedSize);

    if (imageEntries.length > 0) {
      coverImage = await extractZipEntry(contentsData, imageEntries[0]);
      if (imageEntries[0].name.toLowerCase().endsWith('.png')) {
        coverMimeType = 'image/png';
      }
    }

    // 4. Read Publication metadata from database
    const pubRows = await queryDatabase(dbPath,
      'SELECT MepsLanguageIndex, Symbol, Year, IssueTagNumber, Title FROM Publication LIMIT 1'
    );
    if (pubRows.length === 0) throw new Error('No Publication record found in database');

    const pub = pubRows[0];
    const mepsLang: number = pub.MepsLanguageIndex;
    const symbol: string = pub.Symbol;
    const pubYear: number = pub.Year;
    const issueTag: string | null = pub.IssueTagNumber;
    const pubTitle: string = pub.Title || manifest.publication.title;

    // 5. Build pubCard and derive decryption key
    // Books: "{lang}_{symbol}_{year}"
    // Periodicals: "{lang}_{symbol}_{year}_{issueTag}"
    let pubCard = `${mepsLang}_${symbol}_${pubYear}`;

    // Try without IssueTagNumber first (books), then with it (periodicals)
    const pubCardCandidates = [pubCard];
    if (issueTag && issueTag !== '0' && issueTag !== '') {
      pubCardCandidates.unshift(`${pubCard}_${issueTag}`);
    }

    // 6. Read all document content blobs
    const docRows = await queryDatabaseBlobs(dbPath,
      'SELECT DocumentId, Title, Content, ChapterNumber, Class FROM Document ORDER BY DocumentId'
    );

    if (docRows.length === 0) throw new Error('No documents found in database');

    // 7. Try each pubCard candidate until decryption succeeds
    let chapters: JwpubDocument[] | null = null;
    let lastError: string = '';

    for (const candidate of pubCardCandidates) {
      try {
        const { key, iv } = deriveKeyIv(candidate);

        // Test with first document
        const testDoc = docRows[0];
        const testContent = testDoc.Content as Buffer;
        decryptContent(testContent, key, iv);

        // Success — decrypt all documents
        chapters = docRows.map(row => ({
          documentId: row.DocumentId as number,
          title: row.Title as string,
          html: decryptContent(row.Content as Buffer, key, iv),
          chapterNumber: row.ChapterNumber as number | null,
          class: row.Class as string,
        }));

        console.log(`[jwpub] Decryption succeeded with pubCard "${candidate}"`);
        break;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }

    if (!chapters) {
      throw new Error(`Failed to decrypt JWPUB content. Last error: ${lastError}`);
    }

    // 8. Map language
    const isoLang = MEPS_LANG_MAP[mepsLang] || 'en';

    // 9. Build EPUB
    const epubBuffer = buildEpub(pubTitle, isoLang, pubYear, chapters, coverImage, coverMimeType);

    // 10. Write EPUB to temp dir
    const safeName = manifest.publication.symbol || 'converted';
    const outputPath = path.join(tmpDir, `${safeName}.epub`);
    await fs.writeFile(outputPath, epubBuffer);

    console.log(`[jwpub] Converted ${path.basename(jwpubPath)} → ${outputPath} (${chapters.length} chapters, ${epubBuffer.length} bytes)`);

    return {
      success: true,
      outputPath,
      metadata: {
        title: pubTitle,
        author: 'Watch Tower Bible and Tract Society',
        year: String(pubYear),
        language: isoLang,
      },
    };
  } catch (err) {
    console.error('[jwpub] Conversion failed:', err);
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
