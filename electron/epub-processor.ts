/**
 * EPUB Processor - Parse, read, and modify EPUB files
 *
 * Uses built-in Node.js modules for ZIP handling and XML parsing.
 * EPUBs are just ZIP files containing XHTML documents and metadata.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import * as cheerio from 'cheerio';

const inflateRaw = promisify(zlib.inflateRaw);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFileAs?: string;
  year?: string;
  language: string;
  coverPath?: string;
  identifier?: string;
  publisher?: string;
  description?: string;
}

export interface EpubChapter {
  id: string;
  title: string;
  href: string;
  order: number;
  wordCount: number;
}

export interface EpubStructure {
  metadata: EpubMetadata;
  chapters: EpubChapter[];
  spine: string[];
  manifest: Record<string, ManifestItem>;
  opfPath: string;
  rootPath: string;
  navPath?: string;  // EPUB 3 nav.xhtml path
  ncxPath?: string;  // EPUB 2 toc.ncx path
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP Parsing (minimal implementation for EPUB)
// ─────────────────────────────────────────────────────────────────────────────

class ZipReader {
  private fd: number | null = null;
  private entries: Map<string, ZipEntry> = new Map();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<void> {
    this.fd = fsSync.openSync(this.filePath, 'r');
    await this.readCentralDirectory();
  }

  close(): void {
    if (this.fd !== null) {
      fsSync.closeSync(this.fd);
      this.fd = null;
    }
  }

  getEntries(): string[] {
    return Array.from(this.entries.keys());
  }

  async readEntry(name: string): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Entry not found: ${name}`);
    }

    if (this.fd === null) {
      throw new Error('ZIP file not open');
    }

    // Read local file header
    const localHeader = Buffer.alloc(30);
    fsSync.readSync(this.fd, localHeader, 0, 30, entry.localHeaderOffset);

    // Verify signature
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('Invalid local file header');
    }

    const fileNameLength = localHeader.readUInt16LE(26);
    const extraFieldLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;

    // Read compressed data
    const compressedData = Buffer.alloc(entry.compressedSize);
    fsSync.readSync(this.fd, compressedData, 0, entry.compressedSize, dataOffset);

    // Decompress if needed
    if (entry.compressionMethod === 0) {
      // Stored (no compression)
      return compressedData;
    } else if (entry.compressionMethod === 8) {
      // Deflate
      return await inflateRaw(compressedData) as Buffer;
    } else {
      throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
    }
  }

  private async readCentralDirectory(): Promise<void> {
    if (this.fd === null) {
      throw new Error('ZIP file not open');
    }

    const stats = fsSync.fstatSync(this.fd);
    const fileSize = stats.size;

    // Find End of Central Directory record (search from end)
    const searchSize = Math.min(65557, fileSize);
    const searchBuffer = Buffer.alloc(searchSize);
    fsSync.readSync(this.fd, searchBuffer, 0, searchSize, fileSize - searchSize);

    let eocdOffset = -1;
    for (let i = searchSize - 22; i >= 0; i--) {
      if (searchBuffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = fileSize - searchSize + i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error('End of central directory not found');
    }

    // Read EOCD
    const eocd = Buffer.alloc(22);
    fsSync.readSync(this.fd, eocd, 0, 22, eocdOffset);

    const centralDirOffset = eocd.readUInt32LE(16);
    const centralDirSize = eocd.readUInt32LE(12);
    const entryCount = eocd.readUInt16LE(10);

    // Read central directory
    const centralDir = Buffer.alloc(centralDirSize);
    fsSync.readSync(this.fd, centralDir, 0, centralDirSize, centralDirOffset);

    // Parse entries
    let offset = 0;
    for (let i = 0; i < entryCount; i++) {
      if (centralDir.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error('Invalid central directory entry');
      }

      const compressionMethod = centralDir.readUInt16LE(offset + 10);
      const compressedSize = centralDir.readUInt32LE(offset + 20);
      const uncompressedSize = centralDir.readUInt32LE(offset + 24);
      const fileNameLength = centralDir.readUInt16LE(offset + 28);
      const extraFieldLength = centralDir.readUInt16LE(offset + 30);
      const commentLength = centralDir.readUInt16LE(offset + 32);
      const localHeaderOffset = centralDir.readUInt32LE(offset + 42);

      const fileName = centralDir.toString('utf8', offset + 46, offset + 46 + fileNameLength);

      this.entries.set(fileName, {
        name: fileName,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        localHeaderOffset
      });

      offset += 46 + fileNameLength + extraFieldLength + commentLength;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Parsing (minimal implementation using regex)
// ─────────────────────────────────────────────────────────────────────────────

function getTagContent(xml: string, tagName: string): string | null {
  // Handle namespaced tags like dc:title
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)</${escapedTag}>`, 'i');
  const match = xml.match(pattern);
  return match ? match[1].trim() : null;
}

function getAttribute(xml: string, attrName: string): string | null {
  const pattern = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = xml.match(pattern);
  return match ? match[1] : null;
}

function getAllTags(xml: string, tagName: string): Array<{ content: string; attributes: Record<string, string> }> {
  const results: Array<{ content: string; attributes: Record<string, string> }> = [];
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match both self-closing and regular tags
  const pattern = new RegExp(`<${escapedTag}([^>]*)(?:/>|>([\\s\\S]*?)</${escapedTag}>)`, 'gi');
  let match;

  while ((match = pattern.exec(xml)) !== null) {
    const attrString = match[1] || '';
    const content = match[2] || '';
    const attributes: Record<string, string> = {};

    // Parse attributes (supports hyphenated names like full-path, media-type)
    const attrPattern = /([\w-]+(?::[\w-]+)?)\s*=\s*["']([^"']*)["']/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }

    results.push({ content: content.trim(), attributes });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB Processor Class
// ─────────────────────────────────────────────────────────────────────────────

class EpubProcessor {
  private zipReader: ZipReader | null = null;
  private structure: EpubStructure | null = null;
  private currentPath: string = '';

  async open(epubPath: string): Promise<EpubStructure> {
    this.currentPath = epubPath;
    this.zipReader = new ZipReader(epubPath);
    await this.zipReader.open();

    // Find and parse container.xml
    const containerXml = await this.readFile('META-INF/container.xml');
    const opfPath = this.parseContainer(containerXml);

    // Parse OPF file
    const opfXml = await this.readFile(opfPath);
    const rootPath = path.dirname(opfPath);

    this.structure = this.parseOpf(opfXml, opfPath, rootPath);

    // Try to extract chapter titles from navigation document
    await this.loadChapterTitlesFromNav();

    return this.structure;
  }

  /**
   * Load chapter titles from nav.xhtml (EPUB 3) or toc.ncx (EPUB 2)
   */
  private async loadChapterTitlesFromNav(): Promise<void> {
    if (!this.structure) return;

    // Map of href -> title from navigation
    const navTitles = new Map<string, string>();

    // Try EPUB 3 nav.xhtml first
    if (this.structure.navPath) {
      try {
        const navXml = await this.readFile(this.structure.navPath);
        this.parseNavXhtml(navXml, navTitles);
      } catch {
        // nav.xhtml not found or unreadable
      }
    }

    // Fall back to EPUB 2 toc.ncx if no titles found
    if (navTitles.size === 0 && this.structure.ncxPath) {
      try {
        const ncxXml = await this.readFile(this.structure.ncxPath);
        this.parseNcx(ncxXml, navTitles);
      } catch {
        // toc.ncx not found or unreadable
      }
    }

    // Update chapter titles from navigation
    if (navTitles.size > 0) {
      for (const chapter of this.structure.chapters) {
        // Try exact match first
        let title = navTitles.get(chapter.href);

        // Try without fragment
        if (!title) {
          title = navTitles.get(chapter.href.split('#')[0]);
        }

        // Try matching just the filename
        if (!title) {
          const filename = chapter.href.split('/').pop() || '';
          for (const [href, navTitle] of navTitles) {
            if (href.endsWith(filename) || href.endsWith(filename.split('#')[0])) {
              title = navTitle;
              break;
            }
          }
        }

        if (title) {
          chapter.title = title;
        }
      }
    }
  }

  /**
   * Parse EPUB 3 nav.xhtml to extract chapter titles
   */
  private parseNavXhtml(xml: string, titles: Map<string, string>): void {
    // Find all <a> tags within the nav element
    // Pattern: <a href="...">Title</a>
    const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(xml)) !== null) {
      const href = match[1];
      const title = match[2].trim();
      if (href && title) {
        titles.set(href, title);
      }
    }
  }

  /**
   * Parse EPUB 2 toc.ncx to extract chapter titles
   */
  private parseNcx(xml: string, titles: Map<string, string>): void {
    // Find navPoint elements with content src and navLabel text
    // Pattern: <navPoint>...<navLabel><text>Title</text></navLabel>...<content src="..."/>...</navPoint>
    const navPointRegex = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi;
    let match;

    while ((match = navPointRegex.exec(xml)) !== null) {
      const navPoint = match[1];

      // Extract text from navLabel
      const textMatch = navPoint.match(/<text>([^<]+)<\/text>/i);
      // Extract src from content
      const srcMatch = navPoint.match(/<content[^>]+src=["']([^"']+)["']/i);

      if (textMatch && srcMatch) {
        const title = textMatch[1].trim();
        const href = srcMatch[1];
        if (href && title) {
          titles.set(href, title);
        }
      }
    }
  }

  close(): void {
    if (this.zipReader) {
      this.zipReader.close();
      this.zipReader = null;
    }
    this.structure = null;
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.zipReader) {
      throw new Error('EPUB not open');
    }
    const buffer = await this.zipReader.readEntry(filePath);
    return buffer.toString('utf8');
  }

  async readBinaryFile(filePath: string): Promise<Buffer> {
    if (!this.zipReader) {
      throw new Error('EPUB not open');
    }
    return await this.zipReader.readEntry(filePath);
  }

  getStructure(): EpubStructure | null {
    return this.structure;
  }

  async getCover(): Promise<Buffer | null> {
    if (!this.structure) return null;

    // Try to find cover in metadata
    const coverPath = this.structure.metadata.coverPath;
    if (coverPath) {
      try {
        const fullPath = this.resolvePath(coverPath);
        return await this.readBinaryFile(fullPath);
      } catch {
        // Cover file not found
      }
    }

    // Try common cover file names
    const commonNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'images/cover.jpg', 'Images/cover.jpg'];
    for (const name of commonNames) {
      try {
        const fullPath = this.structure.rootPath ? `${this.structure.rootPath}/${name}` : name;
        return await this.readBinaryFile(fullPath);
      } catch {
        // Not found, try next
      }
    }

    return null;
  }

  async getChapterText(chapterId: string): Promise<string> {
    if (!this.structure) {
      throw new Error('EPUB not open');
    }

    const chapter = this.structure.chapters.find(c => c.id === chapterId);
    if (!chapter) {
      throw new Error(`Chapter not found: ${chapterId}`);
    }

    const href = this.resolvePath(chapter.href);
    const xhtml = await this.readFile(href);

    // Extract text from XHTML
    return this.extractTextFromXhtml(xhtml);
  }

  private parseContainer(xml: string): string {
    const rootfile = getAllTags(xml, 'rootfile')[0];
    if (!rootfile?.attributes['full-path']) {
      throw new Error('No rootfile found in container.xml');
    }
    return rootfile.attributes['full-path'];
  }

  private parseOpf(xml: string, opfPath: string, rootPath: string): EpubStructure {
    // Parse metadata
    const metadata: EpubMetadata = {
      title: getTagContent(xml, 'dc:title') || 'Untitled',
      author: getTagContent(xml, 'dc:creator') || 'Unknown',
      language: getTagContent(xml, 'dc:language') || 'en',
      identifier: getTagContent(xml, 'dc:identifier') || '',
      publisher: getTagContent(xml, 'dc:publisher') || '',
      description: getTagContent(xml, 'dc:description') || ''
    };

    // Extract year from date
    const date = getTagContent(xml, 'dc:date');
    if (date) {
      const yearMatch = date.match(/(\d{4})/);
      if (yearMatch) {
        metadata.year = yearMatch[1];
      }
    }

    // Find cover image
    const coverMeta = getAllTags(xml, 'meta').find(m => m.attributes.name === 'cover');
    if (coverMeta) {
      const coverId = coverMeta.attributes.content;
      const coverItem = getAllTags(xml, 'item').find(i => i.attributes.id === coverId);
      if (coverItem) {
        metadata.coverPath = coverItem.attributes.href;
      }
    }

    // Parse manifest
    const manifest: Record<string, ManifestItem> = {};
    for (const item of getAllTags(xml, 'item')) {
      manifest[item.attributes.id] = {
        id: item.attributes.id,
        href: item.attributes.href,
        mediaType: item.attributes['media-type']
      };
    }

    // Parse spine
    const spine: string[] = [];
    for (const itemref of getAllTags(xml, 'itemref')) {
      spine.push(itemref.attributes.idref);
    }

    // Find navigation document for chapter titles (EPUB 3: nav, EPUB 2: ncx)
    let navItem = getAllTags(xml, 'item').find(i =>
      i.attributes.properties?.includes('nav')
    );
    const ncxItem = getAllTags(xml, 'item').find(i =>
      i.attributes['media-type'] === 'application/x-dtbncx+xml'
    );

    const navPath = navItem?.attributes.href || null;
    const ncxPath = ncxItem?.attributes.href || null;

    // Build chapters from spine
    const chapters: EpubChapter[] = [];
    // Accept multiple content types that EPUBs might use
    const validMediaTypes = new Set([
      'application/xhtml+xml',
      'text/html',
      'text/x-oeb1-document',
      'application/x-dtbook+xml'
    ]);

    for (let i = 0; i < spine.length; i++) {
      const id = spine[i];
      const item = manifest[id];
      if (item && validMediaTypes.has(item.mediaType)) {
        chapters.push({
          id,
          title: `Chapter ${i + 1}`,  // Default title, will be updated from nav
          href: item.href,
          order: i,
          wordCount: 0
        });
      }
    }

    return {
      metadata,
      chapters,
      spine,
      manifest,
      opfPath,
      rootPath,
      navPath: navPath ? (rootPath ? `${rootPath}/${navPath}` : navPath) : undefined,
      ncxPath: ncxPath ? (rootPath ? `${rootPath}/${ncxPath}` : ncxPath) : undefined
    };
  }

  private resolvePath(href: string): string {
    if (!this.structure) return href;
    // Handle fragment identifiers
    const cleanHref = href.split('#')[0];
    if (this.structure.rootPath) {
      return `${this.structure.rootPath}/${cleanHref}`;
    }
    return cleanHref;
  }

  private extractTextFromXhtml(xhtml: string): string {
    // Remove the entire <head> section (contains <title> which we don't want as text)
    let text = xhtml.replace(/<head[\s\S]*?<\/head>/gi, '');

    // Remove script and style tags (in case any are in body)
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

    // Add period after headings for natural TTS pause, but only if not already punctuated
    // This handles: <h1>Title</h1> → <h1>Title. </h1> but <h1>Title?</h1> stays as-is
    text = text.replace(/([^.!?\s])<\/h[1-6]>/gi, '$1.');

    // PRESERVE PARAGRAPH STRUCTURE: Convert block-level closing tags to double newlines
    // Only convert actual text-containing elements, NOT container divs
    // This must match the elements we look for in replaceXhtmlBodyLocal (ai-bridge.ts)
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n\n');
    text = text.replace(/<\/blockquote>/gi, '\n\n');
    text = text.replace(/<\/figcaption>/gi, '\n\n');
    // Don't convert </div> - divs are usually containers, not text blocks
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // Also add newlines BEFORE opening block tags (in case closing tags are missing or malformed)
    text = text.replace(/<(p|h[1-6]|li|blockquote|figcaption)([\s>])/gi, '\n\n<$1$2');

    // Remove all remaining tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

    // Clean up whitespace WITHIN paragraphs (preserve paragraph breaks)
    // First, normalize spaces within lines (but not newlines)
    text = text.replace(/[^\S\n]+/g, ' ');
    // Then collapse multiple newlines to exactly two (paragraph break)
    text = text.replace(/\n\s*\n/g, '\n\n');
    // Clean up leading/trailing whitespace on each line
    text = text.replace(/^ +| +$/gm, '');
    // Final trim
    text = text.trim();

    return text;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP Writing (for saving modified EPUBs)
// ─────────────────────────────────────────────────────────────────────────────

const deflateRaw = promisify(zlib.deflateRaw);

class ZipWriter {
  private entries: Array<{ name: string; data: Buffer; isCompressed: boolean }> = [];

  addFile(name: string, data: Buffer, compress: boolean = true): void {
    this.entries.push({ name, data, isCompressed: compress });
  }

  async write(outputPath: string): Promise<void> {
    const centralDirectory: Buffer[] = [];
    const fileData: Buffer[] = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      let compressedData: Buffer;
      let compressionMethod: number;

      if (entry.isCompressed && entry.data.length > 0) {
        compressedData = await deflateRaw(entry.data) as Buffer;
        compressionMethod = 8; // Deflate
      } else {
        compressedData = entry.data;
        compressionMethod = 0; // Store
      }

      // CRC32 of uncompressed data
      const crc = this.crc32(entry.data);

      // Local file header
      const localHeader = Buffer.alloc(30 + nameBuffer.length);
      localHeader.writeUInt32LE(0x04034b50, 0); // Signature
      localHeader.writeUInt16LE(20, 4); // Version needed
      localHeader.writeUInt16LE(0, 6); // Flags
      localHeader.writeUInt16LE(compressionMethod, 8);
      localHeader.writeUInt16LE(0, 10); // Modified time
      localHeader.writeUInt16LE(0, 12); // Modified date
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressedData.length, 18);
      localHeader.writeUInt32LE(entry.data.length, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28); // Extra field length
      nameBuffer.copy(localHeader, 30);

      fileData.push(localHeader, compressedData);

      // Central directory entry
      const centralEntry = Buffer.alloc(46 + nameBuffer.length);
      centralEntry.writeUInt32LE(0x02014b50, 0); // Signature
      centralEntry.writeUInt16LE(20, 4); // Version made by
      centralEntry.writeUInt16LE(20, 6); // Version needed
      centralEntry.writeUInt16LE(0, 8); // Flags
      centralEntry.writeUInt16LE(compressionMethod, 10);
      centralEntry.writeUInt16LE(0, 12); // Modified time
      centralEntry.writeUInt16LE(0, 14); // Modified date
      centralEntry.writeUInt32LE(crc, 16);
      centralEntry.writeUInt32LE(compressedData.length, 20);
      centralEntry.writeUInt32LE(entry.data.length, 24);
      centralEntry.writeUInt16LE(nameBuffer.length, 28);
      centralEntry.writeUInt16LE(0, 30); // Extra field length
      centralEntry.writeUInt16LE(0, 32); // Comment length
      centralEntry.writeUInt16LE(0, 34); // Disk number
      centralEntry.writeUInt16LE(0, 36); // Internal attributes
      centralEntry.writeUInt32LE(0, 38); // External attributes
      centralEntry.writeUInt32LE(offset, 42); // Local header offset
      nameBuffer.copy(centralEntry, 46);

      centralDirectory.push(centralEntry);
      offset += localHeader.length + compressedData.length;
    }

    // End of central directory
    const centralDirSize = centralDirectory.reduce((sum, b) => sum + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // Signature
    eocd.writeUInt16LE(0, 4); // Disk number
    eocd.writeUInt16LE(0, 6); // Central dir disk
    eocd.writeUInt16LE(this.entries.length, 8); // Entries on disk
    eocd.writeUInt16LE(this.entries.length, 10); // Total entries
    eocd.writeUInt32LE(centralDirSize, 12);
    eocd.writeUInt32LE(offset, 16); // Central dir offset
    eocd.writeUInt16LE(0, 20); // Comment length

    // Write to a temp file in the OS temp directory first, then rename into place.
    // This avoids EPERM errors when the target file is briefly locked by external
    // processes (e.g. Syncthing, antivirus, search indexer). Using the OS temp dir
    // ensures the temp file won't be picked up by folder-sync tools.
    const output = Buffer.concat([...fileData, ...centralDirectory, eocd]);
    const tempPath = path.join(os.tmpdir(), `bookforge-epub-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tempPath, output);

    // Copy temp file into place with retry. On Windows, the target file may be
    // briefly locked by Syncthing, antivirus, or search indexer. Using copyFile
    // (not rename) because temp and output may be on different drives.
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await fs.copyFile(tempPath, outputPath);
        await fs.unlink(tempPath);
        return;
      } catch (err: any) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        await fs.unlink(tempPath);
        throw err;
      }
    }
  }

  private crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    const table = this.getCrc32Table();
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  private static crc32Table: number[] | null = null;

  private getCrc32Table(): number[] {
    if (ZipWriter.crc32Table) return ZipWriter.crc32Table;

    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    ZipWriter.crc32Table = table;
    return table;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported Functions
// ─────────────────────────────────────────────────────────────────────────────

let currentProcessor: EpubProcessor | null = null;
// Track modified chapter content for saving
const modifiedChapters: Map<string, string> = new Map();
// Track modified cover image (buffer and media type)
let modifiedCover: { data: Buffer; mediaType: string } | null = null;
// Track modified metadata for saving
let modifiedMetadata: Partial<EpubMetadata> | null = null;

export async function parseEpub(epubPath: string): Promise<EpubStructure> {
  if (currentProcessor) {
    currentProcessor.close();
  }
  currentProcessor = new EpubProcessor();
  return await currentProcessor.open(epubPath);
}

export async function getCover(epubPath?: string): Promise<string | null> {
  if (epubPath && (!currentProcessor || epubPath !== currentProcessor['currentPath'])) {
    await parseEpub(epubPath);
  }
  if (!currentProcessor) {
    throw new Error('No EPUB open');
  }
  const coverBuffer = await currentProcessor.getCover();
  if (!coverBuffer) return null;

  // Detect image type and convert to data URL
  let mimeType = 'image/jpeg';
  if (coverBuffer[0] === 0x89 && coverBuffer[1] === 0x50) {
    mimeType = 'image/png';
  }

  return `data:${mimeType};base64,${coverBuffer.toString('base64')}`;
}

export async function getChapterText(chapterId: string): Promise<string> {
  if (!currentProcessor) {
    throw new Error('No EPUB open');
  }
  return await currentProcessor.getChapterText(chapterId);
}

export function getMetadata(): EpubMetadata | null {
  if (!currentProcessor) return null;
  const structure = currentProcessor.getStructure();
  // Return modified metadata merged with original if available
  if (modifiedMetadata && structure?.metadata) {
    return { ...structure.metadata, ...modifiedMetadata };
  }
  return structure?.metadata || null;
}

/**
 * Set metadata to be saved when saveModifiedEpub is called
 * Only provided fields will be updated; others remain unchanged
 */
export function setMetadata(metadata: Partial<EpubMetadata>): void {
  if (!currentProcessor) {
    throw new Error('No EPUB open');
  }
  modifiedMetadata = { ...modifiedMetadata, ...metadata };
}

export function getChapters(): EpubChapter[] {
  if (!currentProcessor) return [];
  const structure = currentProcessor.getStructure();
  return structure?.chapters || [];
}

export function closeEpub(): void {
  if (currentProcessor) {
    currentProcessor.close();
    currentProcessor = null;
  }
  modifiedChapters.clear();
  modifiedCover = null;
  modifiedMetadata = null;
}

/**
 * Update chapter text content (stored in memory until saveModifiedEpub is called)
 */
export async function updateChapterText(chapterId: string, newText: string): Promise<void> {
  if (!currentProcessor) {
    throw new Error('No EPUB open');
  }

  const structure = currentProcessor.getStructure();
  if (!structure) {
    throw new Error('No EPUB structure');
  }

  const chapter = structure.chapters.find(c => c.id === chapterId);
  if (!chapter) {
    throw new Error(`Chapter not found: ${chapterId}`);
  }

  // Store the modified text
  modifiedChapters.set(chapterId, newText);
}

/**
 * Set a new cover image for the EPUB
 * @param coverDataUrl Base64 data URL (e.g., "data:image/jpeg;base64,...")
 */
export function setCover(coverDataUrl: string): void {
  if (!currentProcessor) {
    throw new Error('No EPUB open');
  }

  // Parse the data URL
  const match = coverDataUrl.match(/^data:image\/(jpeg|jpg|png|gif|webp);base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid cover data URL format. Expected data:image/[type];base64,...');
  }

  const imageType = match[1].toLowerCase();
  const base64Data = match[2];

  // Determine media type
  let mediaType: string;
  switch (imageType) {
    case 'jpg':
    case 'jpeg':
      mediaType = 'image/jpeg';
      break;
    case 'png':
      mediaType = 'image/png';
      break;
    case 'gif':
      mediaType = 'image/gif';
      break;
    case 'webp':
      mediaType = 'image/webp';
      break;
    default:
      mediaType = `image/${imageType}`;
  }

  // Decode base64 to buffer
  const data = Buffer.from(base64Data, 'base64');

  // Store for saving
  modifiedCover = { data, mediaType };
}

/**
 * Clear the modified cover
 */
export function clearCover(): void {
  modifiedCover = null;
}

/**
 * Save the EPUB with modified chapter content, cover, and/or metadata
 */
export async function saveModifiedEpub(outputPath: string): Promise<void> {
  if (!currentProcessor) {
    throw new Error('No EPUB open');
  }

  const structure = currentProcessor.getStructure();
  if (!structure) {
    throw new Error('No EPUB structure');
  }

  const zipWriter = new ZipWriter();

  // Determine cover file path (if we have a modified cover)
  let coverFilePath: string | null = null;
  if (modifiedCover && structure.metadata.coverPath) {
    coverFilePath = structure.rootPath
      ? `${structure.rootPath}/${structure.metadata.coverPath}`
      : structure.metadata.coverPath;
  }

  // Get all entries from the original EPUB
  const entries = (currentProcessor as any).zipReader?.getEntries() || [];

  for (const entryName of entries) {
    // Check if this is the cover image that needs to be replaced
    if (modifiedCover && coverFilePath && entryName === coverFilePath) {
      zipWriter.addFile(entryName, modifiedCover.data, true);
      continue;
    }

    // Check if this is the OPF file and we have modified metadata
    if (modifiedMetadata && entryName === structure.opfPath) {
      const originalOpf = await currentProcessor.readFile(entryName);
      const newOpf = updateOpfMetadata(originalOpf, modifiedMetadata);
      zipWriter.addFile(entryName, Buffer.from(newOpf, 'utf8'));
      continue;
    }

    // Check if this is a chapter file that was modified
    let isModified = false;
    let modifiedContent: string | null = null;

    for (const chapter of structure.chapters) {
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
      if (entryName === href && modifiedChapters.has(chapter.id)) {
        isModified = true;
        modifiedContent = modifiedChapters.get(chapter.id) || null;
        break;
      }
    }

    if (isModified && modifiedContent !== null) {
      // Read original XHTML and replace body content
      const originalXhtml = await currentProcessor.readFile(entryName);
      const newXhtml = replaceXhtmlBody(originalXhtml, modifiedContent);
      zipWriter.addFile(entryName, Buffer.from(newXhtml, 'utf8'));
    } else {
      // Copy file as-is
      const data = await currentProcessor.readBinaryFile(entryName);
      // Don't compress mimetype file (EPUB spec requirement)
      const compress = entryName !== 'mimetype';
      zipWriter.addFile(entryName, data, compress);
    }
  }

  await zipWriter.write(outputPath);
}

/**
 * Update metadata in an OPF (Open Packaging Format) file
 */
function updateOpfMetadata(opf: string, metadata: Partial<EpubMetadata>): string {
  let result = opf;

  // Helper to update or add a dc: element
  const updateDcElement = (tagName: string, value: string | undefined) => {
    if (value === undefined) return;

    const regex = new RegExp(`<dc:${tagName}[^>]*>([^<]*)</dc:${tagName}>`, 'i');
    const match = result.match(regex);

    if (match) {
      // Replace existing element, preserving attributes
      result = result.replace(regex, `<dc:${tagName}${match[0].match(/[^>]*>/)![0].slice(0, -1)}>${escapeXml(value)}</dc:${tagName}>`);
    } else {
      // Add new element inside <metadata> tag
      const metadataMatch = result.match(/<metadata[^>]*>/i);
      if (metadataMatch) {
        const insertPoint = metadataMatch.index! + metadataMatch[0].length;
        result = result.slice(0, insertPoint) + `\n    <dc:${tagName}>${escapeXml(value)}</dc:${tagName}>` + result.slice(insertPoint);
      }
    }
  };

  // Update each metadata field
  if (metadata.title !== undefined) {
    updateDcElement('title', metadata.title);
  }

  if (metadata.author !== undefined) {
    updateDcElement('creator', metadata.author);
  }

  if (metadata.year !== undefined) {
    updateDcElement('date', metadata.year);
  }

  if (metadata.language !== undefined) {
    updateDcElement('language', metadata.language);
  }

  if (metadata.publisher !== undefined) {
    updateDcElement('publisher', metadata.publisher);
  }

  if (metadata.description !== undefined) {
    updateDcElement('description', metadata.description);
  }

  // Handle authorFileAs as file-as attribute on creator element
  if (metadata.authorFileAs !== undefined) {
    // Look for opf:file-as attribute on creator
    const creatorRegex = /<dc:creator([^>]*)>([^<]*)<\/dc:creator>/i;
    const creatorMatch = result.match(creatorRegex);
    if (creatorMatch) {
      let attributes = creatorMatch[1];
      // Remove existing file-as attribute if present
      attributes = attributes.replace(/\s*opf:file-as="[^"]*"/g, '');
      // Add new file-as attribute
      attributes = ` opf:file-as="${escapeXml(metadata.authorFileAs)}"` + attributes;
      result = result.replace(creatorRegex, `<dc:creator${attributes}>${creatorMatch[2]}</dc:creator>`);
    }
  }

  return result;
}

/**
 * Replace the body content in an XHTML document while preserving the structure
 */
function replaceXhtmlBody(xhtml: string, newText: string): string {
  // Find the body tag
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) {
    // No body tag, return as-is
    return xhtml;
  }

  // Convert plain text to paragraphs
  const paragraphs = newText.split(/\n\n+/).filter(p => p.trim());
  const htmlContent = paragraphs.map(p => `<p>${escapeXml(p.trim())}</p>`).join('\n');

  // Replace body content
  return xhtml.replace(
    /<body([^>]*)>[\s\S]*<\/body>/i,
    `<body$1>\n${htmlContent}\n</body>`
  );
}

/**
 * Escape text for XML
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison Functions (for diff view)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load an EPUB for comparison without modifying global state.
 * Returns chapter content for all chapters.
 */
export async function loadEpubForComparison(epubPath: string): Promise<{
  chapters: Array<{
    id: string;
    title: string;
    text: string;
  }>;
}> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(epubPath);

    const chapters = [];
    for (const chapter of structure.chapters) {
      try {
        const text = await processor.getChapterText(chapter.id);
        chapters.push({
          id: chapter.id,
          title: chapter.title,
          text
        });
      } catch {
        // Skip chapters that can't be read
        chapters.push({
          id: chapter.id,
          title: chapter.title,
          text: ''
        });
      }
    }

    return { chapters };
  } finally {
    processor.close();
  }
}

/**
 * Progress callback for comparison loading
 */
export interface CompareEpubsProgress {
  phase: 'loading-original' | 'loading-cleaned' | 'loading-metadata' | 'complete';
  currentChapter: number;
  totalChapters: number;
  chapterTitle?: string;
}

/**
 * Compare two EPUBs and return their chapter contents for diffing.
 * Returns matched chapters by ID.
 * Supports optional progress callback for UI feedback.
 */
export async function compareEpubs(
  originalPath: string,
  cleanedPath: string,
  onProgress?: (progress: CompareEpubsProgress) => void
): Promise<{
  chapters: Array<{
    id: string;
    title: string;
    originalText: string;
    cleanedText: string;
  }>;
}> {
  // Load original with progress
  const originalProcessor = new EpubProcessor();
  const originalChapters: Array<{ id: string; title: string; text: string }> = [];

  try {
    const originalStructure = await originalProcessor.open(originalPath);
    const totalOriginal = originalStructure.chapters.length;

    for (let i = 0; i < originalStructure.chapters.length; i++) {
      const chapter = originalStructure.chapters[i];
      if (onProgress) {
        onProgress({
          phase: 'loading-original',
          currentChapter: i + 1,
          totalChapters: totalOriginal,
          chapterTitle: chapter.title
        });
      }

      try {
        const text = await originalProcessor.getChapterText(chapter.id);
        originalChapters.push({ id: chapter.id, title: chapter.title, text });
      } catch {
        originalChapters.push({ id: chapter.id, title: chapter.title, text: '' });
      }
    }
  } finally {
    originalProcessor.close();
  }

  // Load cleaned with progress
  const cleanedProcessor = new EpubProcessor();
  const cleanedChapters: Array<{ id: string; title: string; text: string }> = [];

  try {
    const cleanedStructure = await cleanedProcessor.open(cleanedPath);
    const totalCleaned = cleanedStructure.chapters.length;

    for (let i = 0; i < cleanedStructure.chapters.length; i++) {
      const chapter = cleanedStructure.chapters[i];
      if (onProgress) {
        onProgress({
          phase: 'loading-cleaned',
          currentChapter: i + 1,
          totalChapters: totalCleaned,
          chapterTitle: chapter.title
        });
      }

      try {
        const text = await cleanedProcessor.getChapterText(chapter.id);
        cleanedChapters.push({ id: chapter.id, title: chapter.title, text });
      } catch {
        cleanedChapters.push({ id: chapter.id, title: chapter.title, text: '' });
      }
    }
  } finally {
    cleanedProcessor.close();
  }

  // Create a map of cleaned chapters by ID
  const cleanedMap = new Map(cleanedChapters.map(c => [c.id, c]));

  // Match chapters by ID
  const chapters = originalChapters.map(origChapter => {
    const cleanedChapter = cleanedMap.get(origChapter.id);
    return {
      id: origChapter.id,
      title: origChapter.title,
      originalText: origChapter.text,
      cleanedText: cleanedChapter?.text || ''
    };
  });

  if (onProgress) {
    onProgress({
      phase: 'complete',
      currentChapter: chapters.length,
      totalChapters: chapters.length
    });
  }

  return { chapters };
}

/**
 * Get chapter metadata for comparison without loading full text.
 * This is memory-efficient for large EPUBs - text is loaded on demand.
 */
export async function getComparisonMetadata(
  originalPath: string,
  cleanedPath: string,
  onProgress?: (progress: CompareEpubsProgress) => void
): Promise<{
  chapters: Array<{
    id: string;
    title: string;
    hasOriginal: boolean;
    hasCleaned: boolean;
  }>;
}> {
  const originalProcessor = new EpubProcessor();
  const cleanedProcessor = new EpubProcessor();

  try {
    if (onProgress) {
      onProgress({ phase: 'loading-metadata', currentChapter: 0, totalChapters: 0 });
    }

    const originalStructure = await originalProcessor.open(originalPath);
    const cleanedStructure = await cleanedProcessor.open(cleanedPath);

    // Create sets of chapter IDs
    const cleanedIds = new Set(cleanedStructure.chapters.map(c => c.id));

    // Map chapters with metadata only (no text)
    const chapters = originalStructure.chapters.map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      hasOriginal: true,
      hasCleaned: cleanedIds.has(chapter.id)
    }));

    if (onProgress) {
      onProgress({ phase: 'complete', currentChapter: chapters.length, totalChapters: chapters.length });
    }

    return { chapters };
  } finally {
    originalProcessor.close();
    cleanedProcessor.close();
  }
}

/**
 * Load a single chapter's text for comparison (lazy loading).
 * This loads text on-demand to avoid memory issues with large EPUBs.
 */
export async function getChapterComparison(
  originalPath: string,
  cleanedPath: string,
  chapterId: string
): Promise<{
  originalText: string;
  cleanedText: string;
}> {
  const originalProcessor = new EpubProcessor();
  const cleanedProcessor = new EpubProcessor();

  try {
    await originalProcessor.open(originalPath);
    await cleanedProcessor.open(cleanedPath);

    let originalText = '';
    let cleanedText = '';

    try {
      originalText = await originalProcessor.getChapterText(chapterId);
    } catch {
      // Chapter not found in original
    }

    try {
      cleanedText = await cleanedProcessor.getChapterText(chapterId);
    } catch {
      // Chapter not found in cleaned
    }

    return { originalText, cleanedText };
  } finally {
    originalProcessor.close();
    cleanedProcessor.close();
  }
}

/**
 * Edit specific text within an EPUB file.
 * Finds and replaces the old text with new text in the specified chapter.
 */
export async function editEpubText(
  epubPath: string,
  chapterId: string,
  oldText: string,
  newText: string
): Promise<{ success: boolean; error?: string }> {
  const processor = new EpubProcessor();

  try {
    const structure = await processor.open(epubPath);

    // Find the chapter
    const chapter = structure.chapters.find(c => c.id === chapterId);
    if (!chapter) {
      return { success: false, error: `Chapter not found: ${chapterId}` };
    }

    // Get the href for this chapter
    const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;

    // Read the current XHTML content
    const xhtml = await processor.readFile(href);

    // Find the old text and replace it
    if (!xhtml.includes(oldText)) {
      return { success: false, error: 'Text not found in chapter' };
    }

    const newXhtml = xhtml.replace(oldText, newText);

    // Create new EPUB with the modified chapter
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];

    for (const entryName of entries) {
      if (entryName === href) {
        // Write modified content
        zipWriter.addFile(entryName, Buffer.from(newXhtml, 'utf8'));
      } else {
        // Copy file as-is
        const data = await processor.readBinaryFile(entryName);
        const compress = entryName !== 'mimetype';
        zipWriter.addFile(entryName, data, compress);
      }
    }

    // Write to a temp file, then replace the original
    const tempPath = epubPath + '.tmp';
    await zipWriter.write(tempPath);

    // Replace original with temp
    const fs = await import('fs/promises');
    await fs.rename(tempPath, epubPath);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    processor.close();
  }
}

/**
 * Replace text in an EPUB by searching all chapters.
 * Used for editing skipped chunks where we don't know the chapter ID.
 *
 * This function extracts plain text from each chapter (like AI cleanup does),
 * finds the text there, replaces it, then rebuilds the chapter XHTML.
 */
export async function replaceTextInEpub(
  epubPath: string,
  oldText: string,
  newText: string
): Promise<{ success: boolean; error?: string; chapterFound?: string }> {
  const processor = new EpubProcessor();

  // Helper to extract plain text from XHTML (same as EpubProcessor.extractTextFromXhtml)
  function extractText(xhtml: string): string {
    let text = xhtml.replace(/<head[\s\S]*?<\/head>/gi, '');
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/([^.!?\s])<\/h[1-6]>/gi, '$1.');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n\n');
    text = text.replace(/<\/blockquote>/gi, '\n\n');
    text = text.replace(/<\/figcaption>/gi, '\n\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // Add newlines BEFORE opening block tags too
    text = text.replace(/<(p|h[1-6]|li|blockquote|figcaption)([\s>])/gi, '\n\n<$1$2');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    text = text.replace(/[^\S\n]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');
    text = text.replace(/^ +| +$/gm, '');
    return text.trim();
  }

  // Helper to escape XML special characters
  function escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Helper to rebuild XHTML body with new text (preserving structure where possible)
  function rebuildXhtml(originalXhtml: string, newPlainText: string): string {
    const bodyMatch = originalXhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (!bodyMatch) {
      return originalXhtml;
    }

    const bodyContent = bodyMatch[1];
    const newBlocks = newPlainText.split(/\n\n+/).map(b => b.trim()).filter(b => b.length > 0);

    if (newBlocks.length === 0) {
      return originalXhtml;
    }

    // Find block-level elements in original
    const blockPattern = /<(p|h[1-6]|li|blockquote|figcaption)([^>]*)>([\s\S]*?)<\/\1>/gi;
    interface BlockMatch {
      full: string;
      tag: string;
      attrs: string;
      content: string;
      startIndex: number;
      hasText: boolean;
    }

    const matches: BlockMatch[] = [];
    let match;

    while ((match = blockPattern.exec(bodyContent)) !== null) {
      const textContent = match[3]
        .replace(/<[^>]+>/g, '')
        .replace(/&[^;]+;/g, ' ')
        .trim();

      matches.push({
        full: match[0],
        tag: match[1],
        attrs: match[2],
        content: match[3],
        startIndex: match.index,
        hasText: textContent.length > 0
      });
    }

    const textMatches = matches.filter(m => m.hasText);

    // If block counts match, preserve structure
    if (textMatches.length === newBlocks.length) {
      let newBodyContent = bodyContent;
      for (let i = textMatches.length - 1; i >= 0; i--) {
        const m = textMatches[i];
        const newElement = `<${m.tag}${m.attrs}>${escapeXml(newBlocks[i])}</${m.tag}>`;
        newBodyContent =
          newBodyContent.substring(0, m.startIndex) +
          newElement +
          newBodyContent.substring(m.startIndex + m.full.length);
      }
      return originalXhtml.replace(
        /<body([^>]*)>[\s\S]*<\/body>/i,
        `<body$1>${newBodyContent}</body>`
      );
    }

    // Fallback: wrap in paragraphs
    const paragraphs = newBlocks.map(p => `<p>${escapeXml(p)}</p>`).join('\n');
    return originalXhtml.replace(
      /<body([^>]*)>[\s\S]*<\/body>/i,
      `<body$1>\n${paragraphs}\n</body>`
    );
  }

  try {
    const structure = await processor.open(epubPath);

    // Search through all chapters for the text
    let foundInChapter: string | null = null;
    let foundHref: string | null = null;
    let modifiedXhtml: string | null = null;

    // Strip [[BLOCK]] markers from the search text - these are internal processing artifacts
    // that don't exist in the actual EPUB content
    const cleanedOldText = oldText.replace(/\n*\[\[BLOCK\]\]\n*/g, '\n\n');
    const cleanedNewText = newText.replace(/\n*\[\[BLOCK\]\]\n*/g, '\n\n');

    // Normalize whitespace for comparison
    const normalizedOldText = cleanedOldText.replace(/\s+/g, ' ').trim();

    for (const chapter of structure.chapters) {
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;

      try {
        const xhtml = await processor.readFile(href);
        const extractedText = extractText(xhtml);
        const normalizedExtracted = extractedText.replace(/\s+/g, ' ').trim();

        // Check if this chapter contains the text (whitespace-normalized comparison)
        if (normalizedExtracted.includes(normalizedOldText)) {
          // Found it! Replace in the extracted text and rebuild
          // Use the cleaned text (without [[BLOCK]] markers) for replacement
          const modifiedText = extractedText.replace(cleanedOldText, cleanedNewText);

          // If direct replacement didn't work, try normalized
          if (modifiedText === extractedText) {
            // Try a more flexible replacement
            const escapedOld = cleanedOldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flexPattern = escapedOld.replace(/\s+/g, '\\s+');
            const regex = new RegExp(flexPattern, 's');
            const flexModified = extractedText.replace(regex, cleanedNewText);
            if (flexModified !== extractedText) {
              modifiedXhtml = rebuildXhtml(xhtml, flexModified);
            }
          } else {
            modifiedXhtml = rebuildXhtml(xhtml, modifiedText);
          }

          if (modifiedXhtml && modifiedXhtml !== xhtml) {
            foundInChapter = chapter.title || chapter.id;
            foundHref = href;
            break;
          }
        }
      } catch {
        // Skip chapters that can't be read
        continue;
      }
    }

    if (!foundHref || !modifiedXhtml) {
      return { success: false, error: 'Text not found in any chapter' };
    }

    // Create new EPUB with the modified chapter
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];

    for (const entryName of entries) {
      if (entryName === foundHref) {
        // Write modified content
        zipWriter.addFile(entryName, Buffer.from(modifiedXhtml, 'utf8'));
      } else {
        // Copy file as-is
        const data = await processor.readBinaryFile(entryName);
        const compress = entryName !== 'mimetype';
        zipWriter.addFile(entryName, data, compress);
      }
    }

    // Write to a temp file, then replace the original
    const tempPath = epubPath + '.tmp';
    await zipWriter.write(tempPath);

    // Replace original with temp
    const fs = await import('fs/promises');
    await fs.rename(tempPath, epubPath);

    return { success: true, chapterFound: foundInChapter || undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    processor.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Removal Functions (for EPUB editor export)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Text removal instruction
 */
export interface TextRemovalEntry {
  chapterId: string;
  text: string;
  cfi: string;
}

/**
 * Remove specified text from an EPUB and save to a new file.
 * Groups removals by chapter for efficient processing.
 */
export async function exportEpubWithRemovals(
  inputPath: string,
  removals: Map<string, TextRemovalEntry[]>,
  outputPath: string
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const processor = new EpubProcessor();

  try {
    const structure = await processor.open(inputPath);
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];

    // Build a map of chapter ID -> href
    const chapterHrefs = new Map<string, string>();
    for (const chapter of structure.chapters) {
      chapterHrefs.set(chapter.id, chapter.href);
    }

    for (const entryName of entries) {
      // Check if this entry is a chapter that needs modifications
      let modified = false;
      let modifiedContent: string | null = null;

      // Find if this entry matches any chapter with removals
      for (const [chapterId, chapterRemovals] of removals) {
        const chapterHref = chapterHrefs.get(chapterId);
        if (!chapterHref) continue;

        const fullHref = structure.rootPath ? `${structure.rootPath}/${chapterHref}` : chapterHref;

        if (entryName === fullHref && chapterRemovals.length > 0) {
          // Read the original XHTML
          const originalXhtml = await processor.readFile(entryName);

          // Apply removals
          modifiedContent = applyTextRemovals(originalXhtml, chapterRemovals);
          modified = true;
          break;
        }
      }

      if (modified && modifiedContent !== null) {
        zipWriter.addFile(entryName, Buffer.from(modifiedContent, 'utf8'));
      } else {
        // Copy file as-is
        const data = await processor.readBinaryFile(entryName);
        const compress = entryName !== 'mimetype';
        zipWriter.addFile(entryName, data, compress);
      }
    }

    await zipWriter.write(outputPath);

    return {
      success: true,
      outputPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    processor.close();
  }
}

/**
 * Apply text removals to an XHTML document using CFI-based positioning.
 *
 * The CFI (Canonical Fragment Identifier) contains the path to the exact element
 * and character offset. We parse the CFI to navigate to the correct location.
 *
 * CFI format example: epubcfi(/6/4!/4/2/1:5,/4/2/1:15)
 * - /6/4 = spine position (which chapter)
 * - ! separates spine from content path
 * - /4/2/1 = path within XHTML (even numbers = element indices, 1-indexed)
 * - :5,:15 = character offset range within the text node
 */
function applyTextRemovals(xhtml: string, removals: TextRemovalEntry[]): string {
  if (removals.length === 0) return xhtml;

  // Parse XHTML using DOMParser
  const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  // Parse as XHTML
  const doc = parser.parseFromString(xhtml, 'application/xhtml+xml');

  // Track which removals succeeded
  const processedRemovals: { node: any; start: number; end: number; text: string }[] = [];

  for (const removal of removals) {
    const text = removal.text;
    if (!text) continue;

    // Try to find the element using CFI path
    let targetNode: any = null;
    let charStart = 0;
    let charEnd = text.length;

    if (removal.cfi) {
      // Parse CFI to extract element path and character offsets
      // CFI format from epub.js: epubcfi(/6/4[chap01]!/4/2/1:5,/4/2/1:10)
      // The part after ! is the document path
      const cfiContent = removal.cfi.match(/!(.+)$/)?.[1] || '';

      // Check for range (has comma) or single point
      const rangeParts = cfiContent.split(',');
      let startPath = rangeParts[0];
      let endPath = rangeParts[1] || startPath;

      // Parse start offset
      const startMatch = startPath.match(/:(\d+)$/);
      if (startMatch) {
        charStart = parseInt(startMatch[1], 10);
        startPath = startPath.replace(/:(\d+)$/, '');
      }

      // Parse end offset
      const endMatch = endPath.match(/:(\d+)$/);
      if (endMatch) {
        charEnd = parseInt(endMatch[1], 10);
      }

      // Navigate to element using path
      // Path like /4/2/6/1 means: body(4) -> div(2) -> p(6) -> text(1)
      const pathParts = startPath.split('/').filter(p => p);
      let current: any = doc.documentElement; // Start at root

      for (const part of pathParts) {
        if (!current) break;

        // Parse index (and optional id assertion like "4[chapter1]")
        const indexMatch = part.match(/^(\d+)(?:\[([^\]]+)\])?$/);
        if (!indexMatch) continue;

        const cfiIndex = parseInt(indexMatch[1], 10);
        // CFI indices: even = element, odd = text node
        // CFI is 1-indexed, so /2 = 1st element, /4 = 2nd element, etc.
        const isTextNode = cfiIndex % 2 === 1;
        const childIndex = Math.floor(cfiIndex / 2);

        if (isTextNode) {
          // Find the nth text node (CFI text node index)
          const textNodeIndex = Math.floor(cfiIndex / 2);
          let textCount = 0;
          for (let i = 0; i < current.childNodes.length; i++) {
            const child = current.childNodes[i];
            if (child.nodeType === 3) { // TEXT_NODE
              if (textCount === textNodeIndex) {
                targetNode = child;
                break;
              }
              textCount++;
            }
          }
        } else {
          // Find the nth element
          let elemCount = 0;
          for (let i = 0; i < current.childNodes.length; i++) {
            const child = current.childNodes[i];
            if (child.nodeType === 1) { // ELEMENT_NODE
              if (elemCount === childIndex - 1) {
                current = child;
                break;
              }
              elemCount++;
            }
          }
        }
      }

      // If we ended on an element, get its first text node
      if (current && current.nodeType === 1 && !targetNode) {
        for (let i = 0; i < current.childNodes.length; i++) {
          if (current.childNodes[i].nodeType === 3) {
            targetNode = current.childNodes[i];
            break;
          }
        }
      }
    }

    // If CFI navigation succeeded, use exact position
    if (targetNode && targetNode.nodeType === 3) {
      const nodeText = targetNode.nodeValue || '';
      // Verify the text matches at the expected position
      if (nodeText.substring(charStart, charStart + text.length) === text) {
        processedRemovals.push({
          node: targetNode,
          start: charStart,
          end: charStart + text.length,
          text
        });
      }
    }
  }

  // Apply removals (in reverse order to preserve positions within same node)
  // Group by node first
  const byNode = new Map<any, typeof processedRemovals>();
  for (const removal of processedRemovals) {
    const existing = byNode.get(removal.node) || [];
    existing.push(removal);
    byNode.set(removal.node, existing);
  }

  // For each node, sort removals by position (descending) and apply
  for (const [node, nodeRemovals] of byNode) {
    nodeRemovals.sort((a, b) => b.start - a.start);
    let nodeText = node.nodeValue || '';
    for (const removal of nodeRemovals) {
      nodeText = nodeText.substring(0, removal.start) + nodeText.substring(removal.end);
    }
    node.nodeValue = nodeText;
  }

  // Serialize back to string
  let result = serializer.serializeToString(doc);

  // Clean up any empty elements that might result from removals
  result = result
    .replace(/<sup[^>]*>\s*<\/sup>/g, '')       // Empty sup tags
    .replace(/<sub[^>]*>\s*<\/sub>/g, '')       // Empty sub tags
    .replace(/<a[^>]*>\s*<\/a>/g, '')           // Empty anchor tags
    .replace(/<span[^>]*>\s*<\/span>/g, '')     // Empty spans
    .replace(/<p[^>]*>\s*<\/p>/g, '')           // Empty paragraphs
    .replace(/\s+<\/p>/g, '</p>')               // Trailing whitespace in paragraphs
    .replace(/<p>\s+/g, '<p>');                 // Leading whitespace in paragraphs

  return result;
}

/**
 * Copy an EPUB file to a new location
 */
export async function copyEpubFile(
  inputPath: string,
  outputPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const data = await fs.readFile(inputPath);
    await fs.writeFile(outputPath, data);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Copy failed'
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block-based Export (for EPUB editor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Export EPUB with deleted blocks removed.
 * Blocks are identified by ID format: "sectionHref:index"
 * where sectionHref is the relative path (e.g., "OEBPS/chapter1.xhtml")
 * and index is the 0-based position of the block element in document order.
 */
export async function exportEpubWithDeletedBlocks(
  inputPath: string,
  deletedBlockIds: string[],
  outputPath: string
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const processor = new EpubProcessor();

  try {
    const structure = await processor.open(inputPath);
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];

    // Group deleted blocks by section href
    const deletedBySection = new Map<string, number[]>();
    for (const blockId of deletedBlockIds) {
      const colonIndex = blockId.lastIndexOf(':');
      if (colonIndex > 0) {
        const sectionHref = blockId.substring(0, colonIndex);
        const index = parseInt(blockId.substring(colonIndex + 1), 10);
        if (!isNaN(index)) {
          const existing = deletedBySection.get(sectionHref) || [];
          existing.push(index);
          deletedBySection.set(sectionHref, existing);
        }
      }
    }

    for (const entryName of entries) {
      // Check if this entry has blocks to delete
      // The sectionHref from blocks may or may not include the rootPath prefix
      let sectionDeletions: number[] | undefined;

      // Try with the entry name as-is
      sectionDeletions = deletedBySection.get(entryName);

      // Also try without the root path prefix
      if (!sectionDeletions && structure.rootPath && entryName.startsWith(structure.rootPath + '/')) {
        const relativeHref = entryName.substring(structure.rootPath.length + 1);
        sectionDeletions = deletedBySection.get(relativeHref);
      }

      // Also try with root path added if not present
      if (!sectionDeletions && structure.rootPath) {
        const withRoot = `${structure.rootPath}/${entryName}`;
        sectionDeletions = deletedBySection.get(withRoot);
      }

      if (sectionDeletions && sectionDeletions.length > 0) {
        // Read and process the XHTML
        const originalXhtml = await processor.readFile(entryName);
        const modifiedXhtml = removeBlocksFromXhtml(originalXhtml, sectionDeletions);
        zipWriter.addFile(entryName, Buffer.from(modifiedXhtml, 'utf8'));
      } else {
        // Copy file as-is
        const data = await processor.readBinaryFile(entryName);
        const compress = entryName !== 'mimetype';
        zipWriter.addFile(entryName, data, compress);
      }
    }

    await zipWriter.write(outputPath);

    return {
      success: true,
      outputPath
    };
  } catch (error) {
    console.error('[EPUB Export] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    processor.close();
  }
}

/**
 * Remove specific block elements from XHTML by their indices.
 * Blocks are identified using the same selectors as the EPUB editor:
 * 'p, h1, h2, h3, h4, h5, h6, img, blockquote, ul, ol, figure, div.image, div.figure'
 */
function removeBlocksFromXhtml(xhtml: string, indicesToRemove: number[]): string {
  if (indicesToRemove.length === 0) return xhtml;

  const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  // Parse as XHTML
  const doc = parser.parseFromString(xhtml, 'application/xhtml+xml');

  if (!doc || !doc.documentElement) {
    console.error('[EPUB Export] Failed to parse XHTML');
    return xhtml;
  }

  // Find the body element
  const body = doc.getElementsByTagName('body')[0];
  if (!body) {
    console.error('[EPUB Export] No body element found');
    return xhtml;
  }

  // Same block selectors as epub editor
  const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'blockquote', 'ul', 'ol', 'figure']);

  // Collect all block elements in document order
  const allElements: Element[] = [];

  function collectElements(node: any): void {
    if (node.nodeType === 1) { // ELEMENT_NODE
      const tagName = node.tagName?.toLowerCase() || '';

      // Check if it's a block element
      const isBlockTag = blockTags.has(tagName);
      const isImageDiv = tagName === 'div' &&
        (node.getAttribute('class')?.includes('image') || node.getAttribute('class')?.includes('figure'));

      if (isBlockTag || isImageDiv) {
        // Skip if this element is a descendant of another collected block
        let isNested = false;
        for (const collected of allElements) {
          if (isDescendantOf(node, collected)) {
            isNested = true;
            break;
          }
        }

        if (!isNested) {
          // Check minimum content (same logic as editor)
          const text = getTextContent(node).trim();
          const isImage = tagName === 'img' || node.getElementsByTagName('img').length > 0;

          if (isImage || text.length >= 2) {
            allElements.push(node);
          }
        }
      }

      // Recurse into children
      for (let i = 0; i < node.childNodes.length; i++) {
        collectElements(node.childNodes[i]);
      }
    }
  }

  collectElements(body);

  // Create a set for faster lookup
  const removeSet = new Set(indicesToRemove);

  // Remove elements (in reverse order to preserve indices)
  const sortedIndices = [...indicesToRemove].sort((a, b) => b - a);
  for (const index of sortedIndices) {
    if (index >= 0 && index < allElements.length) {
      const element = allElements[index];
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    }
  }

  // Serialize back to string
  return serializer.serializeToString(doc);
}

/**
 * Check if a node is a descendant of another node
 */
function isDescendantOf(node: any, ancestor: any): boolean {
  let parent = node.parentNode;
  while (parent) {
    if (parent === ancestor) return true;
    parent = parent.parentNode;
  }
  return false;
}

/**
 * Get text content of an element (works with xmldom)
 */
function getTextContent(node: any): string {
  if (node.nodeType === 3) { // TEXT_NODE
    return node.nodeValue || '';
  }
  let text = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    text += getTextContent(node.childNodes[i]);
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// System Diff - Uses native diff command for efficient text comparison
// ─────────────────────────────────────────────────────────────────────────────

import { execSync, exec } from 'child_process';
import * as os from 'os';

export interface DiffSegment {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
}

/**
 * Compute word-level diff using git diff --word-diff or wdiff
 * This is much more efficient than doing LCS in JavaScript
 */
export async function computeSystemDiff(
  originalText: string,
  cleanedText: string
): Promise<DiffSegment[]> {
  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const origFile = path.join(tmpDir, `diff_orig_${timestamp}.txt`);
  const cleanFile = path.join(tmpDir, `diff_clean_${timestamp}.txt`);

  try {
    // Write texts to temp files
    await fs.writeFile(origFile, originalText, 'utf-8');
    await fs.writeFile(cleanFile, cleanedText, 'utf-8');

    // Try git diff --word-diff first (better output)
    let diffOutput: string;
    try {
      diffOutput = execSync(
        `git diff --no-index --word-diff=porcelain --no-color "${origFile}" "${cleanFile}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
    } catch (err: any) {
      // git diff returns exit code 1 when files differ, which throws
      if (err.stdout) {
        diffOutput = err.stdout;
      } else if (err.status === 1 && err.output) {
        diffOutput = err.output.filter(Boolean).join('');
      } else {
        // Fall back to regular diff
        try {
          diffOutput = execSync(
            `diff "${origFile}" "${cleanFile}"`,
            { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
          );
        } catch (diffErr: any) {
          diffOutput = diffErr.stdout || '';
        }
      }
    }

    // Parse git diff --word-diff=porcelain output
    return parseWordDiffPorcelain(diffOutput, cleanedText);
  } finally {
    // Clean up temp files
    try { await fs.unlink(origFile); } catch {}
    try { await fs.unlink(cleanFile); } catch {}
  }
}

/**
 * Parse git diff --word-diff=porcelain output into segments
 */
function parseWordDiffPorcelain(diffOutput: string, cleanedText: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  const lines = diffOutput.split('\n');

  let inDiff = false;
  let currentText = '';
  let currentType: 'unchanged' | 'added' | 'removed' = 'unchanged';

  for (const line of lines) {
    // Skip header lines
    if (line.startsWith('diff --git') || line.startsWith('index ') ||
        line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('@@')) {
      inDiff = true;
      continue;
    }

    if (!inDiff) continue;

    if (line.startsWith('~')) {
      // End of line marker in porcelain format - represents a newline in the original text
      // Flush current segment and add a newline as unchanged text
      if (currentText) {
        segments.push({ text: currentText, type: currentType });
        currentText = '';
      }
      // Add the newline character to preserve paragraph structure
      segments.push({ text: '\n', type: 'unchanged' });
      currentType = 'unchanged';
    } else if (line === '') {
      // Empty line after ~ represents the actual empty line between paragraphs
      // Skip it since we already added the newline with ~
      continue;
    } else if (line.startsWith(' ')) {
      // Unchanged word
      if (currentType !== 'unchanged' && currentText) {
        segments.push({ text: currentText, type: currentType });
        currentText = '';
      }
      currentType = 'unchanged';
      currentText += line.slice(1);
    } else if (line.startsWith('-')) {
      // Removed word
      if (currentType !== 'removed' && currentText) {
        segments.push({ text: currentText, type: currentType });
        currentText = '';
      }
      currentType = 'removed';
      currentText += line.slice(1);
    } else if (line.startsWith('+')) {
      // Added word
      if (currentType !== 'added' && currentText) {
        segments.push({ text: currentText, type: currentType });
        currentText = '';
      }
      currentType = 'added';
      currentText += line.slice(1);
    }
  }

  // Flush final segment
  if (currentText) {
    segments.push({ text: currentText, type: currentType });
  }

  // If parsing failed or produced no output, return cleaned text as unchanged
  if (segments.length === 0) {
    return [{ text: cleanedText, type: 'unchanged' }];
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cheerio-based Text Extraction and Replacement
// ─────────────────────────────────────────────────────────────────────────────

// Block-level elements that contain text we want to clean
const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption';

/**
 * Extract text from each block element in XHTML using cheerio.
 * Returns an array of text strings, one per element.
 * The order is preserved for later replacement.
 */
export function extractBlockTexts(xhtml: string): string[] {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  const texts: string[] = [];

  $(BLOCK_SELECTORS).each((_, el) => {
    // Get text content (strips nested tags, decodes entities)
    const text = $(el).text().trim();
    // Only include elements that have actual text
    if (text.length > 0) {
      texts.push(text);
    }
  });

  return texts;
}

/**
 * Replace text in each block element in XHTML using cheerio.
 * Takes cleaned texts in the same order as extractBlockTexts returned them.
 * Returns the modified XHTML.
 */
export function replaceBlockTexts(xhtml: string, cleanedTexts: string[]): string {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  let textIndex = 0;

  $(BLOCK_SELECTORS).each((_, el) => {
    // Only replace elements that had text (matching extractBlockTexts logic)
    const originalText = $(el).text().trim();
    if (originalText.length > 0) {
      if (textIndex < cleanedTexts.length) {
        // Sanitize: strip any [[BLOCK]] markers that might have slipped into the text
        // These are internal processing markers and should NEVER appear in final output
        let cleanedText = cleanedTexts[textIndex].replace(/\[\[BLOCK\]\]/g, '');
        // Replace the element's text content
        $(el).text(cleanedText);
        textIndex++;
      }
    }
  });

  // Get the modified XHTML
  let result = $.xml();

  // Post-process: ensure newlines between adjacent block elements
  // This fixes smashed-together text when extracted for TTS/display
  result = result.replace(
    /(<\/(?:p|h[1-6]|div|li|blockquote|section|article|header|footer|figcaption)>)(\s*)(<(?:p|h[1-6]|div|li|blockquote|section|article|header|footer|figcaption)[^>]*>)/gi,
    '$1\n$3'
  );

  return result;
}

/**
 * Old marker format - kept for backwards compatibility but deprecated.
 * Use numbered paragraph format instead (extractNumberedParagraphs/parseNumberedParagraphs).
 */
export const BLOCK_MARKER = '\n\n[[BLOCK]]\n\n';

export function extractBlockTextsWithMarkers(xhtml: string): string {
  const texts = extractBlockTexts(xhtml);
  return texts.join(BLOCK_MARKER);
}

/**
 * Split text that was joined with BLOCK_MARKER back into individual texts.
 * Uses a flexible regex to handle whitespace variations from AI responses.
 */
export function splitBlockTexts(markedText: string): string[] {
  // Match [[BLOCK]] with optional surrounding whitespace (AI might change \n\n to \n or remove it)
  const flexibleMarkerRegex = /\s*\[\[BLOCK\]\]\s*/g;
  return markedText.split(flexibleMarkerRegex).map(t => t.trim()).filter(t => t.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// NUMBERED PARAGRAPH FORMAT - More robust than [[BLOCK]] markers
// Each paragraph gets a unique number, making it impossible for AI to "merge"
// paragraphs by dropping markers. We parse by number, not by separator.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format paragraphs with numbered markers for AI processing.
 * Format: <<<1>>>paragraph text<<<2>>>paragraph text<<<3>>>...
 *
 * The AI must preserve these numbered markers. We parse by extracting
 * text between <<<N>>> and <<<N+1>>> (or end of string).
 *
 * @param texts Array of paragraph texts
 * @param startIndex Starting index for numbering (for chunking across paragraphs)
 * @returns Formatted string with numbered markers
 */
export function formatNumberedParagraphs(texts: string[], startIndex: number = 1): string {
  return texts.map((text, i) => `<<<${startIndex + i}>>>${text}`).join('\n\n');
}

/**
 * Parse AI response to extract paragraphs by their numbered markers.
 * Returns a Map of paragraph number -> cleaned text.
 *
 * This is robust because:
 * 1. We look for specific numbered markers, not generic separators
 * 2. If a marker is missing, we know exactly which paragraph failed
 * 3. If markers are reordered, we can still extract correctly by number
 *
 * @param text AI response with numbered markers
 * @returns Map of paragraph number to text, plus array of missing numbers
 */
export function parseNumberedParagraphs(text: string): { paragraphs: Map<number, string>; missing: number[] } {
  const paragraphs = new Map<number, string>();
  const missing: number[] = [];

  // Find all <<<N>>> markers and their positions
  const markerRegex = /<<<(\d+)>>>/g;
  const markers: { num: number; pos: number }[] = [];
  let match;

  while ((match = markerRegex.exec(text)) !== null) {
    markers.push({ num: parseInt(match[1], 10), pos: match.index + match[0].length });
  }

  // Extract text between each marker and the next (or end of string)
  for (let i = 0; i < markers.length; i++) {
    const startPos = markers[i].pos;
    const endPos = i + 1 < markers.length ? markers[i + 1].pos - markers[i + 1].num.toString().length - 5 : text.length;
    const paragraphText = text.substring(startPos, endPos).trim();
    paragraphs.set(markers[i].num, paragraphText);
  }

  return { paragraphs, missing };
}

/**
 * Validate that all expected paragraph numbers are present in the parsed result.
 *
 * @param parsed Result from parseNumberedParagraphs
 * @param expectedCount Number of paragraphs we expected
 * @param startIndex Starting index that was used
 * @returns Array of missing paragraph numbers
 */
export function validateNumberedParagraphs(
  parsed: Map<number, string>,
  expectedCount: number,
  startIndex: number = 1
): number[] {
  const missing: number[] = [];
  for (let i = startIndex; i < startIndex + expectedCount; i++) {
    if (!parsed.has(i)) {
      missing.push(i);
    }
  }
  return missing;
}

/**
 * Get the count of text-containing block elements in XHTML.
 */
export function countBlockElements(xhtml: string): number {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  let count = 0;

  $(BLOCK_SELECTORS).each((_, el) => {
    if ($(el).text().trim().length > 0) {
      count++;
    }
  });

  return count;
}

/**
 * Rebuild chapter XHTML from cleaned paragraph text.
 * Takes the original XHTML (for head/styles) and replaces the body content
 * with simple <p> elements from the cleaned paragraphs.
 *
 * This is used for TTS cleanup where we don't need to preserve
 * the original element structure (h1, h2, blockquote, etc.) -
 * everything becomes <p> elements since it's just spoken text.
 *
 * @param originalXhtml The original chapter XHTML (to preserve head, styles, etc.)
 * @param paragraphs Array of cleaned paragraph strings
 * @returns New XHTML with body replaced by <p> elements
 */
export function rebuildChapterFromParagraphs(originalXhtml: string, paragraphs: string[]): string {
  const $ = cheerio.load(originalXhtml, { xmlMode: true });

  // Clear the body
  const body = $('body');
  body.empty();

  // Add each paragraph as a <p> element
  for (const text of paragraphs) {
    if (text.trim()) {
      // Escape HTML entities in the text
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      body.append(`<p>${escaped}</p>\n`);
    }
  }

  return $.xml();
}

/**
 * Extract all text from a chapter as flowing prose.
 * Joins all block elements with double newlines (paragraph breaks).
 * This is the inverse of rebuildChapterFromParagraphs.
 *
 * @param xhtml The chapter XHTML
 * @returns Text with paragraphs separated by blank lines
 */
export function extractChapterAsText(xhtml: string): string {
  const blocks = extractBlockTexts(xhtml);
  return blocks.join('\n\n');
}

/**
 * Split cleaned text back into paragraphs.
 * Splits on double newlines (blank lines between paragraphs).
 *
 * @param text Cleaned text from AI
 * @returns Array of paragraph strings
 */
export function splitTextIntoParagraphs(text: string): string[] {
  // Split on one or more blank lines (double newline with optional whitespace)
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

/**
 * Extract all text from an EPUB file.
 * Parses the EPUB and concatenates text from all chapters.
 *
 * @param epubPath Path to the EPUB file
 * @returns Object with success flag and extracted text
 */
export async function extractTextFromEpub(
  epubPath: string
): Promise<{ success: boolean; text?: string; error?: string }> {
  try {
    // Parse the EPUB
    console.log(`[EPUB] extractTextFromEpub: parsing ${epubPath}`);
    await parseEpub(epubPath);

    // Get all chapters
    const chapters = getChapters();
    console.log(`[EPUB] Found ${chapters.length} chapters:`, chapters.map(c => c.id));
    if (!chapters || chapters.length === 0) {
      closeEpub();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    // Extract text from each chapter
    // Note: getChapterText already extracts plain text from XHTML, so we use it directly
    const textParts: string[] = [];
    for (const chapter of chapters) {
      try {
        const chapterText = await getChapterText(chapter.id);
        console.log(`[EPUB] Chapter ${chapter.id}: ${chapterText ? chapterText.length : 0} chars`);
        if (chapterText && chapterText.trim()) {
          textParts.push(chapterText.trim());
        }
      } catch (err) {
        console.warn(`[EPUB] Failed to extract chapter ${chapter.id}: ${(err as Error).message}`);
      }
    }

    closeEpub();

    console.log(`[EPUB] Total text parts: ${textParts.length}`);
    if (textParts.length === 0) {
      return { success: false, error: 'No text content found in EPUB' };
    }

    return {
      success: true,
      text: textParts.join('\n\n')
    };
  } catch (err) {
    console.error(`[EPUB] extractTextFromEpub error:`, err);
    return { success: false, error: (err as Error).message };
  }
}

// Export the processor and ZipWriter for direct use if needed
export { EpubProcessor, ZipWriter };
