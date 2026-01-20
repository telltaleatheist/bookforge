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
    return this.structure;
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

    // Build chapters from spine
    const chapters: EpubChapter[] = [];
    // Accept multiple content types that EPUBs might use
    const validMediaTypes = new Set([
      'application/xhtml+xml',
      'text/html',
      'text/x-oeb1-document',
      'application/x-dtbook+xml'
    ]);

    console.log('[EPUB] Spine has', spine.length, 'items');
    for (let i = 0; i < spine.length; i++) {
      const id = spine[i];
      const item = manifest[id];
      if (item) {
        console.log('[EPUB] Spine item', i, ':', id, '->', item.href, '(', item.mediaType, ')');
        if (validMediaTypes.has(item.mediaType)) {
          chapters.push({
            id,
            title: `Chapter ${i + 1}`,
            href: item.href,
            order: i,
            wordCount: 0
          });
        }
      } else {
        console.log('[EPUB] Spine item', i, ':', id, '- NOT IN MANIFEST');
      }
    }
    console.log('[EPUB] Found', chapters.length, 'chapters');

    return {
      metadata,
      chapters,
      spine,
      manifest,
      opfPath,
      rootPath
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
    // Remove script and style tags
    let text = xhtml.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

    // Remove all tags
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

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();

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

    // Write everything
    const output = Buffer.concat([...fileData, ...centralDirectory, eocd]);
    await fs.writeFile(outputPath, output);
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
  return structure?.metadata || null;
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
 * Save the EPUB with modified chapter content
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

  // Get all entries from the original EPUB
  const entries = (currentProcessor as any).zipReader?.getEntries() || [];

  for (const entryName of entries) {
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
 * Compare two EPUBs and return their chapter contents for diffing.
 * Returns matched chapters by ID.
 */
export async function compareEpubs(originalPath: string, cleanedPath: string): Promise<{
  chapters: Array<{
    id: string;
    title: string;
    originalText: string;
    cleanedText: string;
  }>;
}> {
  const [original, cleaned] = await Promise.all([
    loadEpubForComparison(originalPath),
    loadEpubForComparison(cleanedPath)
  ]);

  // Create a map of cleaned chapters by ID
  const cleanedMap = new Map(cleaned.chapters.map(c => [c.id, c]));

  // Match chapters by ID
  const chapters = original.chapters.map(origChapter => {
    const cleanedChapter = cleanedMap.get(origChapter.id);
    return {
      id: origChapter.id,
      title: origChapter.title,
      originalText: origChapter.text,
      cleanedText: cleanedChapter?.text || ''
    };
  });

  return { chapters };
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

  console.log(`[EPUB Export] Processing ${removals.length} text removals`);

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

    console.log(`[EPUB Export] Processing removal: text="${text}", cfi="${removal.cfi}"`);

    // Try to find the element using CFI path
    let targetNode: any = null;
    let charStart = 0;
    let charEnd = text.length;

    if (removal.cfi) {
      // Parse CFI to extract element path and character offsets
      // CFI format from epub.js: epubcfi(/6/4[chap01]!/4/2/1:5,/4/2/1:10)
      // The part after ! is the document path
      const cfiContent = removal.cfi.match(/!(.+)$/)?.[1] || '';
      console.log(`[EPUB Export] CFI content after !: "${cfiContent}"`);

      // Check for range (has comma) or single point
      const rangeParts = cfiContent.split(',');
      let startPath = rangeParts[0];
      let endPath = rangeParts[1] || startPath;
      console.log(`[EPUB Export] startPath="${startPath}", endPath="${endPath}"`);

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
      } else {
        // Text doesn't match at CFI position - log for debugging
        console.error(`CFI text mismatch: expected "${text}" at offset ${charStart}, found "${nodeText.substring(charStart, charStart + text.length + 20)}..."`);
      }
    } else {
      // CFI navigation failed
      console.error(`CFI navigation failed for: ${removal.cfi}, text: "${text}"`);
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

// Export the processor and ZipWriter for direct use if needed
export { EpubProcessor, ZipWriter };
