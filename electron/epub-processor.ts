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
import * as os from 'os';
import * as crypto from 'crypto';
import { promisify } from 'util';
import * as cheerio from 'cheerio';
// epub-container.ts is a LEAF — fs/path only — and it imports ZipReader and
// ZipWriter back out of THIS file lazily, inside its factories. So this value
// import is safe in the one direction that matters: requiring epub-container
// pulls in nothing, while requiring epub-processor pulls in the seam it now
// routes every read and write through.
import type { EpubSink, EpubSource } from './epub-container';
import {
  createEpubSink,
  openEpubSource,
  removeEpubContainer,
  rewriteEpubEntries,
  stagedContainerKindFor,
  type EpubContainerKind,
} from './epub-container';
import { BLOCK_CATEGORY_IDS } from '../shared/ocr/block-categories';
import { blockCategoryForVlm } from '../shared/vlm/conversion';
import { isFootnoteMarkerSupText, stripFootnoteMarkerSups } from '../shared/text/sup-markers';
import { spliceForCollapsedText } from '../shared/document/element-text-edit';
import type { UnnamedChapterOpeningKind } from '../shared/document/chapter-opening-report';
import {
  narrationDocumentKey,
  narrationElementKey,
  narrationImageElementKey,
  parseNarrationElementKey,
  planNarrationRemoval,
  splitNarrationDeletions,
  type NarrationElementKey,
  type NarrationUnit,
} from '../shared/vlm/narration-deletions';

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
  contributors?: Array<{ first: string; last: string }>;
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
  // Non-fatal parse problems (dropped spine items, unreadable nav/ncx, …).
  // Callers that surface status to the user should show these.
  warnings?: string[];
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

/**
 * A book read out of a ZIP — the original and, at the two boundaries that stay
 * zipped (`archive/` and the `.tts.epub` handed to ebook2audiobook), the only
 * one. `implements EpubSource` is a claim, not a change: every method below is
 * exactly as it was, and the interface was derived FROM them.
 */
export class ZipReader implements EpubSource {
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

  hasEntry(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Read exactly `length` bytes, or refuse naming what fell short.
   *
   * `readSync` answers with the byte count and it was being IGNORED: a read
   * past a truncated or shrunk file leaves the tail of the `Buffer.alloc`
   * ZEROS, so a STORED entry comes back NUL-padded and the failure surfaces
   * far away — as a parse error blaming the XHTML for what was a torn read.
   * A file only comes up short when it has been truncated or replaced UNDER
   * this open reader, which is a state to refuse by name, never to pad.
   * (quire's own reader, packages/quire/src/epub/zip-reader.ts, keeps the
   * same promise for the same reason.)
   */
  private readExactly(fd: number, buffer: Buffer, length: number, position: number, what: string): void {
    const got = fsSync.readSync(fd, buffer, 0, length, position);
    if (got !== length) {
      throw new Error(
        `${this.filePath}: ${what} needed ${length} byte(s) at offset ${position} and the file `
        + `returned ${got} — the archive has been truncated or rewritten under this reader.`);
    }
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
    this.readExactly(this.fd, localHeader, 30, entry.localHeaderOffset,
      `entry "${name}"'s local header`);

    // Verify signature
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('Invalid local file header');
    }

    const fileNameLength = localHeader.readUInt16LE(26);
    const extraFieldLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;

    // Read compressed data
    const compressedData = Buffer.alloc(entry.compressedSize);
    this.readExactly(this.fd, compressedData, entry.compressedSize, dataOffset,
      `entry "${name}"'s data`);

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
    this.readExactly(this.fd, searchBuffer, searchSize, fileSize - searchSize,
      'the end-of-central-directory search window');

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
    this.readExactly(this.fd, eocd, 22, eocdOffset, 'the end-of-central-directory record');

    const centralDirOffset = eocd.readUInt32LE(16);
    const centralDirSize = eocd.readUInt32LE(12);
    const entryCount = eocd.readUInt16LE(10);

    // Read central directory
    const centralDir = Buffer.alloc(centralDirSize);
    this.readExactly(this.fd, centralDir, centralDirSize, centralDirOffset,
      'the central directory');

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

export class EpubProcessor {
  private source: EpubSource | null = null;
  private structure: EpubStructure | null = null;
  private currentPath: string = '';

  async open(epubPath: string): Promise<EpubStructure> {
    this.currentPath = epubPath;
    // Through the seam, so the container is whatever the path IS. `openEpubSource`
    // hands back an ALREADY-OPEN source and gives its handle back when the open
    // fails — the leak that used to leave an unopenable book undeletable.
    this.source = await openEpubSource(epubPath);

    // Find and parse container.xml
    const containerXml = await this.readFile('META-INF/container.xml');
    const opfPath = this.parseContainer(containerXml);

    // Parse OPF file
    const opfXml = await this.readFile(opfPath);
    // Get the directory containing the OPF file
    // If OPF is at root (e.g., 'content.opf'), dirname returns '.', which we convert to ''
    const rawRootPath = path.dirname(opfPath);
    const rootPath = rawRootPath === '.' ? '' : rawRootPath;

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

    // Try EPUB 3 nav.xhtml first.
    // NOTE: "no nav declared" (no navPath) is a legitimately-absent optional and
    // skips this block entirely. Reaching the catch means the OPF DECLARED a nav
    // document that couldn't be read — that must not be silent, or a path bug is
    // indistinguishable from "this EPUB has no nav".
    if (this.structure.navPath) {
      try {
        const navXml = await this.readFile(this.structure.navPath);
        this.parseNavXhtml(navXml, navTitles);
      } catch (err) {
        const msg = `Declared nav document "${this.structure.navPath}" could not be read: ${(err as Error).message}`;
        console.warn(`[EpubProcessor] ${msg}`);
        (this.structure.warnings ??= []).push(msg);
      }
    }

    // Fall back to EPUB 2 toc.ncx if no titles found
    if (navTitles.size === 0 && this.structure.ncxPath) {
      try {
        const ncxXml = await this.readFile(this.structure.ncxPath);
        this.parseNcx(ncxXml, navTitles);
      } catch (err) {
        const msg = `Declared toc.ncx "${this.structure.ncxPath}" could not be read: ${(err as Error).message}`;
        console.warn(`[EpubProcessor] ${msg}`);
        (this.structure.warnings ??= []).push(msg);
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
    // Find all <a> tags within the nav element.
    // Capture the full inner content (not just bare text) so anchors that wrap
    // their label in nested elements — e.g. <a href="..."><span>Title</span></a>,
    // common from some publishers — still yield the title instead of falling
    // through to the "Chapter N" default. Inner tags are stripped below; for a
    // plain-text anchor the strip is a no-op, so existing behaviour is unchanged.
    const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(xml)) !== null) {
      const href = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
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
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.structure = null;
  }

  /** The path this book was opened from. */
  get openedPath(): string {
    return this.currentPath;
  }

  /**
   * Every entry name in the book, in the container's own order.
   *
   * Public because eleven sites used to reach through `(processor as any).zipReader`
   * for exactly this and then write `|| []` after it — a fallback that turned
   * "I could not read this book" into "this book has no entries", and whose
   * result was a rewrite loop that iterated nothing and wrote an EMPTY EPUB over
   * a real one. A closed processor throws here, in the same words every other
   * read on it throws.
   */
  entryNames(): string[] {
    if (!this.source) {
      throw new Error('EPUB not open');
    }
    return this.source.getEntries();
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.source) {
      throw new Error('EPUB not open');
    }
    const buffer = await this.source.readEntry(filePath);
    return buffer.toString('utf8');
  }

  async readBinaryFile(filePath: string): Promise<Buffer> {
    if (!this.source) {
      throw new Error('EPUB not open');
    }
    return await this.source.readEntry(filePath);
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

  /**
   * A chapter's text.
   *
   * `keepFootnoteMarkers` turns OFF the extractor's own footnote-marker strip —
   * see `extractTextFromXhtml` for why the default has it on, and
   * `loadEpubForComparison` for the one caller that must turn it off.
   */
  async getChapterText(
    chapterId: string,
    keepFootnoteMarkers = false
  ): Promise<string> {
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
    return this.extractTextFromXhtml(xhtml, keepFootnoteMarkers);
  }

  /**
   * Get raw XHTML content for a chapter.
   */
  async getChapterXhtml(chapterId: string): Promise<string> {
    if (!this.structure) {
      throw new Error('EPUB not open');
    }

    const chapter = this.structure.chapters.find(c => c.id === chapterId);
    if (!chapter) {
      throw new Error(`Chapter not found: ${chapterId}`);
    }

    const href = this.resolvePath(chapter.href);
    return await this.readFile(href);
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

    // Parse all dc:creator elements into contributors
    const creators = getAllTags(xml, 'dc:creator');
    if (creators.length > 0) {
      metadata.contributors = creators.map(c => {
        const fileAs = c.attributes['opf:file-as'] || '';
        if (fileAs && fileAs.includes(',')) {
          const [last, first] = fileAs.split(',').map(s => s.trim());
          return { first: first || '', last: last || '' };
        }
        // Fall back to parsing content as "First Last"
        const parts = c.content.trim().split(' ');
        if (parts.length >= 2) {
          const last = parts.pop() || '';
          return { first: parts.join(' '), last };
        }
        return { first: c.content.trim(), last: '' };
      });
    }

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

    const warnings: string[] = [];
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
      } else {
        // A spine itemref that yields no chapter means CONTENT IS DROPPED from
        // the book — never do that silently.
        const reason = !item
          ? 'no manifest item matches this idref'
          : `unrecognized media-type "${item.mediaType}"${item.href ? ` (href: ${item.href})` : ''}`;
        console.warn(`[EpubProcessor] Spine item "${id}" dropped from chapters: ${reason}`);
        warnings.push(`Spine item "${id}" dropped from chapters: ${reason}`);
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
      ncxPath: ncxPath ? (rootPath ? `${rootPath}/${ncxPath}` : ncxPath) : undefined,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  resolvePath(href: string): string {
    if (!this.structure) return href;
    // Don't prepend rootPath if it's '.' (OPF at EPUB root)
    const root = this.structure.rootPath && this.structure.rootPath !== '.' ? this.structure.rootPath : '';
    const join = (p: string) => (root ? `${root}/${p}` : p);

    // A '#' normally starts a fragment identifier, but Calibre writes raw '#'
    // inside FILENAMES (e.g. "Book_#04_split_000.html"), and some tools
    // percent-encode hrefs. Pick whichever candidate actually exists in the
    // archive: literal href first, then fragment-stripped, then URL-decoded.
    const candidates = [href, href.split('#')[0]];
    for (const c of candidates.slice()) {
      try {
        const decoded = decodeURIComponent(c);
        if (decoded !== c) candidates.push(decoded);
      } catch { /* malformed percent-escape — not a URL-encoded href */ }
    }
    for (const c of candidates) {
      if (c && this.source?.hasEntry(join(c))) return join(c);
    }
    // Nothing matched — keep the historical behavior (fragment-stripped href)
    // so callers still surface a clear "Entry not found" error.
    return join(candidates[1]);
  }

  /**
   * `keepFootnoteMarkers` leaves the digits-only superscript references IN.
   *
   * The default (false) is the narration reading and is what every other caller
   * wants: the markers are not prose and nothing should read them out. The one
   * caller that must say true is the DIFF of the pass that removes them — see
   * `loadEpubForComparison`.
   */
  private extractTextFromXhtml(xhtml: string, keepFootnoteMarkers = false): string {
    // Remove the entire <head> section (contains <title> which we don't want as text)
    let text = xhtml.replace(/<head[\s\S]*?<\/head>/gi, '');

    // Remove script and style tags (in case any are in body)
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

    // SOURCE NEWLINES ARE NOT LINE BREAKS. A newline in XHTML is insignificant
    // whitespace — a browser renders it as a space. Publishers pretty-print their
    // markup, so a paragraph arrives wrapped at ~70 columns, and passing those
    // newlines through made TTS read the publisher's text editor settings out loud.
    // Measured across the 160 archived original EPUBs: 68,561 newlines sit inside a
    // <p>. Collapse them here, where the markup still says which breaks are real.
    //
    // Three things must survive the collapse:
    //  1. <pre> — the one element where newlines ARE significant. 302 of them in
    //     the archive, all verse. Parked and restored around the collapse. The
    //     lookahead skips a self-closing <pre/>, which would otherwise "open" a
    //     region running to some later </pre> and shield real prose.
    //  2. <br> — 7,606 authored breaks. Untouched: they are tags, not newlines,
    //     and become '\n' further down.
    //  3. Wrap hyphens — `word-\nword` is the only signal the cleanup hyphen
    //     pre-pass has (HYPHEN_SPLIT). Collapsing it would strand every split word
    //     as a permanent mid-word hyphen. Parked by the same mechanism.
    //
    // The park marker is wrapped in U+0001, which is not legal in XML and so cannot
    // have come from the book. A bare "P12" marker would collide with real prose.
    const parked: string[] = [];
    const park = (s: string): string => `P${parked.push(s) - 1}`;

    text = text.replace(/<pre\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/pre>/gi, park);
    text = text.replace(/[A-Za-zÀ-ÿ]-[ \t]*\r?\n[ \t]*(?=[A-Za-zÀ-ÿ])/g, park);
    text = text.replace(/\r\n?|\n/g, ' ');
    text = text.replace(/P(\d+)/g, (_m, i: string) => parked[Number(i)]);

    // Add period after headings (h1-h6) for natural TTS pause, but only if not already punctuated
    text = text.replace(/([^.!?\s])<\/h[1-6]>/gi, '$1.');

    // PRESERVE PARAGRAPH STRUCTURE: Convert block-level closing tags to double newlines
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n\n');
    text = text.replace(/<\/blockquote>/gi, '\n\n');
    text = text.replace(/<\/figcaption>/gi, '\n\n');
    // Don't convert </div> - divs are usually containers, not text blocks
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // Also add newlines BEFORE opening block tags (in case closing tags are missing or malformed)
    // Note: h1 tags are already removed above, so only h2-h6 here
    text = text.replace(/<(p|h[2-6]|li|blockquote|figcaption)([\s>])/gi, '\n\n<$1$2');

    // Dropcap / styled initial: publishers wrap a chapter's first letter in its
    // own inline element (<span class="dropcap">W</span>ax). The blanket tag→space
    // strip below would split that into "W ax" — an ugly read-along cue plus a
    // spurious word. Rejoin an inline element wrapping a single letter that is
    // glued (no whitespace) to a lowercase continuation → "Wax". Structural, so it
    // catches every initial (W/F/O/S…) that a text-only heuristic (A/I ambiguity)
    // would miss.
    text = text.replace(
      /<(span|i|b|em|strong|font)\b[^>]*>\s*([A-Za-z])\s*<\/\1>(?=[a-z])/gi,
      '$2',
    );

    // ENDNOTE REFERENCE MARKERS (2026-07-24). Academic titles mark endnotes with a
    // digits-only superscript — Evans's Third Reich books use
    // `<sup class="calibre11">55</sup>`, 1,864 of them in one volume (~15.6% of
    // sentences). The narrator never reads them, but the blanket strip below turns
    // each into a bare " 55 " glued to the following sentence, so TTS SPEAKS IT:
    // "...sooner or later. Five. The next..." — and e2a's number expansion first
    // inflates it ("one hundred forty seven"). Measured downstream damage: a voice
    // fine-tuned on that text learned the junk marks end-of-utterance and truncated
    // there, which is what broke the thirdreich model.
    //
    // THE RULE IS shared/text/sup-markers.ts, and it is shared with
    // `document:strip-sup-markers`, which removes the same markers from the book
    // itself. Two copies of it would mean the strip and the extractor disagreeing
    // about which superscripts are prose.
    //
    // AND THAT IS WHY IT CAN BE TURNED OFF (2026-08-10). The Remove footnote
    // references pass applies exactly this rule to the book, and its diff was
    // computed from text this line had ALREADY stripped on both sides — so the
    // frozen receipt recorded zero changes on every chapter and "Review changes"
    // on the footnote line opened a diff of the book against itself. Measured on
    // a real run: 3 markers removed, `2 units, 0 changes` written. The pass asks
    // for the markers to be KEPT so its diff is a record of what it did.
    if (!keepFootnoteMarkers) text = stripFootnoteMarkerSups(text).text;

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

    // Remove soft hyphens: rejoin words split across lines (e.g., "psy\u00AD\nchiatry" → "psychiatry")
    text = text.replace(/\u00AD\s*/g, '');
    // Also handle the HTML entity form
    text = text.replace(/&shy;\s*/g, '');

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

// ─────────────────────────────────────────────────────────────────────────────
// Shared CRC32 utility
// ─────────────────────────────────────────────────────────────────────────────

let crc32Table: number[] | null = null;

function getCrc32Table(): number[] {
  if (crc32Table) return crc32Table;

  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  crc32Table = table;
  return table;
}

function computeCrc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  const table = getCrc32Table();
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry logic for writing output files (shared by ZipWriter and StreamingZipWriter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copy a temp file to the output path with retry logic for Windows file locking.
 *
 * Writes ATOMICALLY: the build temp (in the OS temp dir, off any synced tree) is
 * copied onto a staging file on the DESTINATION volume, then renamed into place.
 * fs.rename on the same volume is atomic and replaces the existing file, so the
 * output only ever appears complete. Copying straight onto outputPath let
 * Syncthing watch the file grow mid-copy and create sync-conflict copies — this
 * removes that window. Deletes the temp file after success or on final failure.
 */
async function copyTempToOutput(tempPath: string, outputPath: string): Promise<void> {
  const maxRetries = 5;
  const stagePath = outputPath + '.tmp';
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.copyFile(tempPath, stagePath);   // onto the destination's volume
      await fs.rename(stagePath, outputPath);   // atomic same-volume replace
      await fs.unlink(tempPath);
      return;
    } catch (err: any) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      try { await fs.unlink(stagePath); } catch { /* ignore */ }
      try { await fs.unlink(tempPath); } catch { /* ignore */ }
      throw err;
    }
  }
}

/**
 * A book written as a ZIP. `implements EpubSink` is a claim, not a change — the
 * methods are untouched. Its directory counterpart (`DirectoryEpubSink`) differs
 * in exactly one observable way: an entry whose bytes are unchanged costs
 * nothing there, whereas here every entry is deflated into a fresh archive every
 * time, which is the 25.7 MB that made the seam worth building.
 */
export class ZipWriter implements EpubSink {
  private entries: Array<{ name: string; data: Buffer; isCompressed: boolean }> = [];

  /**
   * `mimetype` is not an ordinary entry, and callers do not get to treat it as
   * one. OCF requires it to be the archive's FIRST entry and STORED — a
   * deflated or misplaced one makes the book invalid, and strict readers refuse
   * it. Most sites here pass `name !== 'mimetype'` for exactly that reason;
   * `copyEpubReplaceBodies` and `replaceChapterTextsInEpub` did not, and took
   * the `compress = true` default, so every book they wrote carried a deflated
   * mimetype. That is not a mistake worth catching twice, so it is not the
   * caller's to make: the writer of the format owns the format's invariant.
   */
  addFile(name: string, data: Buffer, compress: boolean = true): void {
    this.entries.push({ name, data, isCompressed: name === 'mimetype' ? false : compress });
  }

  async write(outputPath: string): Promise<void> {
    const centralDirectory: Buffer[] = [];
    const fileData: Buffer[] = [];
    let offset = 0;

    // …and first. The sources hand entries over with `mimetype` leading, so add
    // order normally carries it, but "normally" is not what a format invariant
    // means: a caller that adds entries in any other order still gets a valid
    // book rather than one that opens everywhere except the strict readers.
    const ordered = [...this.entries];
    const mimetypeAt = ordered.findIndex((e) => e.name === 'mimetype');
    if (mimetypeAt > 0) ordered.unshift(...ordered.splice(mimetypeAt, 1));

    for (const entry of ordered) {
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

      const crc = computeCrc32(entry.data);

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

    const output = Buffer.concat([...fileData, ...centralDirectory, eocd]);
    const tempPath = path.join(os.tmpdir(), `bookforge-epub-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tempPath, output);
    await copyTempToOutput(tempPath, outputPath);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming ZIP Writer — writes entries directly to disk, keeping only
// central directory metadata (~50 bytes/entry) in memory.
// ─────────────────────────────────────────────────────────────────────────────

interface CentralDirRecord {
  nameBuffer: Buffer;
  compressionMethod: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class StreamingZipWriter {
  private fd: number | null = null;
  private tempPath: string = '';
  private offset: number = 0;
  private centralDirRecords: CentralDirRecord[] = [];

  async open(): Promise<void> {
    this.tempPath = path.join(os.tmpdir(), `bookforge-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    this.fd = fsSync.openSync(this.tempPath, 'w');
    this.offset = 0;
    this.centralDirRecords = [];
  }

  async addFile(name: string, data: Buffer, compress: boolean = true): Promise<void> {
    if (this.fd === null) {
      throw new Error('StreamingZipWriter not open');
    }

    const nameBuffer = Buffer.from(name, 'utf8');
    let compressedData: Buffer;
    let compressionMethod: number;

    if (compress && data.length > 0) {
      compressedData = await deflateRaw(data) as Buffer;
      compressionMethod = 8; // Deflate
    } else {
      compressedData = data;
      compressionMethod = 0; // Store
    }

    const crc = computeCrc32(data);

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
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuffer.copy(localHeader, 30);

    // Write local header + data directly to disk
    const localHeaderOffset = this.offset;
    fsSync.writeSync(this.fd, localHeader, 0, localHeader.length);
    this.offset += localHeader.length;
    fsSync.writeSync(this.fd, compressedData, 0, compressedData.length);
    this.offset += compressedData.length;

    // Keep only the central directory metadata in memory
    this.centralDirRecords.push({
      nameBuffer,
      compressionMethod,
      crc,
      compressedSize: compressedData.length,
      uncompressedSize: data.length,
      localHeaderOffset
    });
  }

  async finalize(outputPath: string): Promise<void> {
    if (this.fd === null) {
      throw new Error('StreamingZipWriter not open');
    }

    // Write central directory entries
    const centralDirOffset = this.offset;
    for (const rec of this.centralDirRecords) {
      const centralEntry = Buffer.alloc(46 + rec.nameBuffer.length);
      centralEntry.writeUInt32LE(0x02014b50, 0); // Signature
      centralEntry.writeUInt16LE(20, 4); // Version made by
      centralEntry.writeUInt16LE(20, 6); // Version needed
      centralEntry.writeUInt16LE(0, 8); // Flags
      centralEntry.writeUInt16LE(rec.compressionMethod, 10);
      centralEntry.writeUInt16LE(0, 12); // Modified time
      centralEntry.writeUInt16LE(0, 14); // Modified date
      centralEntry.writeUInt32LE(rec.crc, 16);
      centralEntry.writeUInt32LE(rec.compressedSize, 20);
      centralEntry.writeUInt32LE(rec.uncompressedSize, 24);
      centralEntry.writeUInt16LE(rec.nameBuffer.length, 28);
      centralEntry.writeUInt16LE(0, 30); // Extra field length
      centralEntry.writeUInt16LE(0, 32); // Comment length
      centralEntry.writeUInt16LE(0, 34); // Disk number
      centralEntry.writeUInt16LE(0, 36); // Internal attributes
      centralEntry.writeUInt32LE(0, 38); // External attributes
      centralEntry.writeUInt32LE(rec.localHeaderOffset, 42);
      rec.nameBuffer.copy(centralEntry, 46);

      fsSync.writeSync(this.fd, centralEntry, 0, centralEntry.length);
      this.offset += centralEntry.length;
    }

    const centralDirSize = this.offset - centralDirOffset;

    // EOCD
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // Signature
    eocd.writeUInt16LE(0, 4); // Disk number
    eocd.writeUInt16LE(0, 6); // Central dir disk
    eocd.writeUInt16LE(this.centralDirRecords.length, 8); // Entries on disk
    eocd.writeUInt16LE(this.centralDirRecords.length, 10); // Total entries
    eocd.writeUInt32LE(centralDirSize, 12);
    eocd.writeUInt32LE(centralDirOffset, 16); // Central dir offset
    eocd.writeUInt16LE(0, 20); // Comment length

    fsSync.writeSync(this.fd, eocd, 0, eocd.length);
    fsSync.closeSync(this.fd);
    this.fd = null;

    // Copy temp file to output with retry logic
    await copyTempToOutput(this.tempPath, outputPath);
    this.centralDirRecords = [];
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

  const zipWriter = await createEpubSink(outputPath, 'zip');

  // Determine cover file path (if we have a modified cover)
  let coverFilePath: string | null = null;
  if (modifiedCover && structure.metadata.coverPath) {
    coverFilePath = structure.rootPath
      ? `${structure.rootPath}/${structure.metadata.coverPath}`
      : structure.metadata.coverPath;
  }

  // Get all entries from the original EPUB
  const entries = currentProcessor.entryNames();

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
      // Read original XHTML and replace body content (preserves heading structure)
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
      const openTagMatch = match[0].match(new RegExp(`<dc:${tagName}([^>]*)>`, 'i'));
      const attributes = openTagMatch ? openTagMatch[1] : '';
      result = result.replace(regex, `<dc:${tagName}${attributes}>${escapeXml(value)}</dc:${tagName}>`);
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

  // Handle contributors (multiple authors) or single author
  if (metadata.contributors && metadata.contributors.length > 0) {
    // Remove ALL existing dc:creator elements
    result = result.replace(/<dc:creator[^>]*>[^<]*<\/dc:creator>\s*/gi, '');

    // Insert one dc:creator per contributor
    const metadataMatch = result.match(/<metadata[^>]*>/i);
    if (metadataMatch) {
      const insertPoint = metadataMatch.index! + metadataMatch[0].length;
      const creatorElements = metadata.contributors.map((c, i) => {
        const displayName = [c.first, c.last].filter(Boolean).join(' ') || 'Unknown';
        const fileAs = c.last && c.first ? `${c.last}, ${c.first}` : (c.last || c.first || 'Unknown');
        const role = i === 0 ? ' opf:role="aut"' : '';
        return `\n    <dc:creator opf:file-as="${escapeXml(fileAs)}"${role}>${escapeXml(displayName)}</dc:creator>`;
      }).join('');
      result = result.slice(0, insertPoint) + creatorElements + result.slice(insertPoint);
    }
  } else if (metadata.author !== undefined) {
    updateDcElement('creator', metadata.author);

    // Handle authorFileAs as file-as attribute on creator element
    if (metadata.authorFileAs !== undefined) {
      const creatorRegex = /<dc:creator([^>]*)>([^<]*)<\/dc:creator>/i;
      const creatorMatch = result.match(creatorRegex);
      if (creatorMatch) {
        let attributes = creatorMatch[1];
        attributes = attributes.replace(/\s*opf:file-as="[^"]*"/g, '');
        attributes = ` opf:file-as="${escapeXml(metadata.authorFileAs)}"` + attributes;
        result = result.replace(creatorRegex, `<dc:creator${attributes}>${creatorMatch[2]}</dc:creator>`);
      }
    }
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

  return result;
}

/**
 * Replace the body content in an XHTML document while preserving heading structure.
 *
 * The original XHTML has a heading tag (h1-h6) for the chapter title.
 * extractTextFromXhtml strips H1 entirely and includes H2-H6 as text.
 * This function detects the original heading and preserves the tag:
 * - H1-H6: sent to AI as first text block → first block goes back in heading tag
 * Heading text always ends with a period for TTS pause.
 */
function replaceXhtmlBody(xhtml: string, newText: string): string {
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return xhtml;

  const bodyContent = bodyMatch[1];
  const blocks = newText.split(/\n\n+/).filter(p => p.trim());
  if (blocks.length === 0) return xhtml;

  // Detect heading in original XHTML
  const headingMatch = bodyContent.match(/<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/i);

  if (!headingMatch) {
    // No heading in original — all blocks become <p> tags
    const htmlContent = blocks.map(p => `<p>${escapeXml(p.trim())}</p>`).join('\n');
    return xhtml.replace(/<body([^>]*)>[\s\S]*<\/body>/i, `<body$1>\n${htmlContent}\n</body>`);
  }

  const tag = headingMatch[1].toLowerCase();
  const attrs = headingMatch[2];

  // First block is the chapter title (AI may have modified it)
  let titleText = blocks[0].replace(/\s+/g, ' ').trim();
  if (titleText && !/[.!?]$/.test(titleText)) titleText += '.';
  const headingHtml = `<${tag}${attrs}>${escapeXml(titleText)}</${tag}>`;
  const bodyBlocks = blocks.slice(1);

  const bodyHtml = bodyBlocks.map(p => `<p>${escapeXml(p.trim())}</p>`).join('\n');
  const htmlContent = bodyHtml ? `${headingHtml}\n${bodyHtml}` : headingHtml;

  return xhtml.replace(/<body([^>]*)>[\s\S]*<\/body>/i, `<body$1>\n${htmlContent}\n</body>`);
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
// Embed Cover in Existing EPUB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add or replace a cover image in an existing EPUB file.
 * - If the EPUB already has a cover entry in the OPF, replaces the image data
 * - If the EPUB has no cover entry, adds the image file, OPF manifest item, and meta tag
 *
 * In place, through `rewriteEpubEntries` — which is also what makes the "writes
 * via temp file for atomicity" this docstring used to claim actually true. The
 * old shape opened the book, walked it into a writer with NO try/finally around
 * the walk, and landed it; a read that threw part way (an entry the central
 * directory names and the archive does not) left the reader's descriptor open on
 * the book forever, and on Windows a held descriptor is exactly what makes the
 * file undeletable and every later rename onto it EPERM.
 */
export async function embedCoverInEpub(epubPath: string, coverImagePath: string): Promise<void> {
  const coverData = await fs.readFile(coverImagePath);
  const coverExt = path.extname(coverImagePath).toLowerCase().replace('.', '') || 'jpg';
  const mediaType = coverExt === 'png' ? 'image/png'
    : coverExt === 'gif' ? 'image/gif'
    : coverExt === 'webp' ? 'image/webp'
    : 'image/jpeg';

  // The book's own account of itself, read and RELEASED before the rewrite
  // opens it again: the structure is a plain object, and a processor still
  // holding the book open is a descriptor across the land.
  const processor = new EpubProcessor();
  let structure: EpubStructure;
  try {
    structure = await processor.open(epubPath);
  } finally {
    processor.close();
  }

  const rootPath = structure.rootPath; // e.g. 'OEBPS' or ''

  // Determine if EPUB already has a cover
  const existingCoverHref = structure.metadata.coverPath; // relative to rootPath
  const existingCoverEntry = existingCoverHref
    ? (rootPath ? `${rootPath}/${existingCoverHref}` : existingCoverHref)
    : null;

  // Determine new cover entry path (used when no existing cover)
  const newCoverFilename = `cover.${coverExt === 'jpeg' ? 'jpg' : coverExt}`;
  const newCoverHref = newCoverFilename; // relative to rootPath for OPF
  const newCoverEntry = rootPath ? `${rootPath}/${newCoverFilename}` : newCoverFilename;

  await rewriteEpubEntries({
    from: epubPath,
    to: epubPath,
    toKind: await stagedContainerKindFor(epubPath),
    build: async (source, sink) => {
      for (const entryName of source.getEntries()) {
        // Replace existing cover image data
        if (existingCoverEntry && entryName === existingCoverEntry) {
          sink.addFile(entryName, coverData, true);
          continue;
        }

        // Modify OPF to add cover metadata if EPUB has no existing cover
        if (!existingCoverEntry && entryName === structure.opfPath) {
          let opfXml = (await source.readEntry(entryName)).toString('utf8');

          // Add <item> to manifest
          const manifestCloseMatch = opfXml.match(/<\/manifest>/i);
          if (manifestCloseMatch && manifestCloseMatch.index !== undefined) {
            const itemLine = `    <item id="cover-image" href="${newCoverHref}" media-type="${mediaType}"/>\n  `;
            opfXml = opfXml.slice(0, manifestCloseMatch.index) + itemLine + opfXml.slice(manifestCloseMatch.index);
          }

          // Add <meta name="cover" content="cover-image"/> to metadata
          const hasCoverMeta = /<meta[^>]+name\s*=\s*["']cover["']/i.test(opfXml);
          if (!hasCoverMeta) {
            const metadataCloseMatch = opfXml.match(/<\/metadata>/i);
            if (metadataCloseMatch && metadataCloseMatch.index !== undefined) {
              const metaLine = `    <meta name="cover" content="cover-image"/>\n  `;
              opfXml = opfXml.slice(0, metadataCloseMatch.index) + metaLine + opfXml.slice(metadataCloseMatch.index);
            }
          }

          sink.addFile(entryName, Buffer.from(opfXml, 'utf8'));
          continue;
        }

        // Copy all other entries as-is
        const data = await source.readEntry(entryName);
        const compress = entryName !== 'mimetype';
        sink.addFile(entryName, data, compress);
      }

      // If no existing cover was found, add the new cover file as a new entry
      if (!existingCoverEntry) {
        sink.addFile(newCoverEntry, coverData, true);
      }
    },
  });
}

/**
 * Update an EPUB's OPF metadata AND (optionally) its cover in a SINGLE in-place
 * rewrite. Folds embedCoverInEpub + updateEpubMetadataStandalone into one zip
 * pass so the primary EPUB isn't rewritten twice per save. Handles both an
 * existing cover (replace its bytes) and no cover (add the file + OPF entries).
 * Pass an empty `metadata` to change only the cover.
 */
export async function updateEpubCoverAndMetadata(
  epubPath: string,
  metadata: Partial<EpubMetadata>,
  coverImagePath?: string
): Promise<void> {
  let coverData: Buffer | null = null;
  let coverExt = 'jpg';
  let mediaType = 'image/jpeg';
  if (coverImagePath) {
    coverData = await fs.readFile(coverImagePath);
    coverExt = path.extname(coverImagePath).toLowerCase().replace('.', '') || 'jpg';
    mediaType = coverExt === 'png' ? 'image/png'
      : coverExt === 'gif' ? 'image/gif'
      : coverExt === 'webp' ? 'image/webp'
      : 'image/jpeg';
  }

  const processor = new EpubProcessor();
  let structure: EpubStructure;
  try {
    structure = await processor.open(epubPath);
  } finally {
    processor.close();
  }

  const rootPath = structure.rootPath;

  const existingCoverHref = structure.metadata.coverPath;
  const existingCoverEntry = existingCoverHref
    ? (rootPath ? `${rootPath}/${existingCoverHref}` : existingCoverHref)
    : null;
  const newCoverFilename = `cover.${coverExt === 'jpeg' ? 'jpg' : coverExt}`;
  const newCoverEntry = rootPath ? `${rootPath}/${newCoverFilename}` : newCoverFilename;
  const addingNewCover = !!coverData && !existingCoverEntry;

  // In place. The `epubPath + '.tmp'` + rename this used to end with was a
  // SECOND staging on top of the sink's own — `ZipWriter.write` already
  // materializes beside the target and renames on — and it is the half that is
  // wrong for a tree, where `path + '.tmp'` is a whole directory left behind.
  // The sink decides how its container lands; the site says only where.
  await rewriteEpubEntries({
    from: epubPath,
    to: epubPath,
    toKind: await stagedContainerKindFor(epubPath),
    build: async (source, sink) => {
      for (const entryName of source.getEntries()) {
        // Replace an existing cover image's bytes.
        if (coverData && existingCoverEntry && entryName === existingCoverEntry) {
          sink.addFile(entryName, coverData, true);
          continue;
        }
        // OPF: apply metadata, and inject cover manifest/meta when adding a new cover.
        if (entryName === structure.opfPath) {
          let opfXml = updateOpfMetadata(
            (await source.readEntry(entryName)).toString('utf8'), metadata);
          if (addingNewCover) {
            const manifestCloseMatch = opfXml.match(/<\/manifest>/i);
            if (manifestCloseMatch && manifestCloseMatch.index !== undefined) {
              const itemLine = `    <item id="cover-image" href="${newCoverFilename}" media-type="${mediaType}"/>\n  `;
              opfXml = opfXml.slice(0, manifestCloseMatch.index) + itemLine + opfXml.slice(manifestCloseMatch.index);
            }
            const hasCoverMeta = /<meta[^>]+name\s*=\s*["']cover["']/i.test(opfXml);
            if (!hasCoverMeta) {
              const metadataCloseMatch = opfXml.match(/<\/metadata>/i);
              if (metadataCloseMatch && metadataCloseMatch.index !== undefined) {
                const metaLine = `    <meta name="cover" content="cover-image"/>\n  `;
                opfXml = opfXml.slice(0, metadataCloseMatch.index) + metaLine + opfXml.slice(metadataCloseMatch.index);
              }
            }
          }
          sink.addFile(entryName, Buffer.from(opfXml, 'utf8'));
          continue;
        }
        const data = await source.readEntry(entryName);
        const compress = entryName !== 'mimetype';
        sink.addFile(entryName, data, compress);
      }

      if (addingNewCover && coverData) {
        sink.addFile(newCoverEntry, coverData, true);
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Export EPUB as Book (standalone — does not use module-level singleton)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Export an EPUB file with updated metadata and optional cover replacement.
 * Uses its own EpubProcessor instance to avoid interfering with the PDF editor.
 */
export async function exportEpubAsBook(
  sourcePath: string,
  outputPath: string,
  metadata: Partial<EpubMetadata>,
  coverPath?: string
): Promise<void> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(sourcePath);
    const zipWriter = await createEpubSink(outputPath, 'zip');

    // Resolve cover file path within the EPUB ZIP
    let coverEntryPath: string | null = null;
    let coverData: Buffer | null = null;
    if (coverPath) {
      coverData = await fs.readFile(coverPath);
      if (structure.metadata.coverPath) {
        coverEntryPath = structure.rootPath
          ? `${structure.rootPath}/${structure.metadata.coverPath}`
          : structure.metadata.coverPath;
      }
    }

    const entries = processor.entryNames();

    for (const entryName of entries) {
      // Replace cover image if provided
      if (coverData && coverEntryPath && entryName === coverEntryPath) {
        zipWriter.addFile(entryName, coverData, true);
        continue;
      }

      // Apply metadata to OPF
      if (entryName === structure.opfPath) {
        const originalOpf = await processor.readFile(entryName);
        const newOpf = updateOpfMetadata(originalOpf, metadata);
        zipWriter.addFile(entryName, Buffer.from(newOpf, 'utf8'));
        continue;
      }

      // Copy everything else as-is
      const data = await processor.readBinaryFile(entryName);
      const compress = entryName !== 'mimetype';
      zipWriter.addFile(entryName, data, compress);
    }

    await zipWriter.write(outputPath);
  } finally {
    processor.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update EPUB Metadata In-Place (standalone — does not use module-level singleton)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update metadata in an existing EPUB file in-place.
 * Opens the EPUB, updates OPF metadata fields, rewrites the book atomically.
 * Uses its own EpubProcessor instance to avoid interfering with the PDF editor.
 */
export async function updateEpubMetadataStandalone(
  epubPath: string,
  metadata: Partial<EpubMetadata>
): Promise<void> {
  const processor = new EpubProcessor();
  let opfPath: string;
  try {
    opfPath = (await processor.open(epubPath)).opfPath;
  } finally {
    processor.close();
  }

  await rewriteEpubEntries({
    from: epubPath,
    to: epubPath,
    toKind: await stagedContainerKindFor(epubPath),
    build: async (source, sink) => {
      for (const entryName of source.getEntries()) {
        if (entryName === opfPath) {
          const originalOpf = (await source.readEntry(entryName)).toString('utf8');
          const newOpf = updateOpfMetadata(originalOpf, metadata);
          sink.addFile(entryName, Buffer.from(newOpf, 'utf8'));
          continue;
        }

        const data = await source.readEntry(entryName);
        const compress = entryName !== 'mimetype';
        sink.addFile(entryName, data, compress);
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison Functions (for diff view)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load an EPUB for comparison without modifying global state.
 * Returns chapter content for all chapters.
 *
 * ── `keepFootnoteMarkers`, and the bug it exists for ────────────────────────
 *
 * The text extractor removes digits-only footnote-reference superscripts
 * (`extractTextFromXhtml` → `stripFootnoteMarkerSups`), which is right for every
 * comparison of two books that differ in their PROSE. It is wrong for exactly
 * one: the diff of the pass whose whole job is removing those markers. That pass
 * read its before-text and its after-text through here, the extractor took the
 * markers out of BOTH, and the frozen receipt it wrote recorded zero changes on
 * every chapter — so "Review changes" on the footnote line opened a diff of the
 * book against itself and there was nothing on screen (Owen, 2026-08-10: "when i
 * clicked review changes on the footnote removal line, it never loaded").
 *
 * So the pass says true and sees its own work. Nothing else does: a Simplify
 * diff showing marker churn would be noise about text the narrator never reads.
 */
export async function loadEpubForComparison(epubPath: string, keepFootnoteMarkers = false): Promise<{
  chapters: Array<{
    id: string;
    title: string;
    text: string;
    /**
     * The chapter's entry path inside the archive, resolved the same way
     * everything else here resolves one.
     *
     * Present because a tool that edited this book from the outside reports what
     * it did BY PATH — `foundry footnotes --epub` names the documents it changed
     * — and a spine id cannot be matched against a path. It is the join, and
     * without it a pass's report and its diff describe the same book with no way
     * to line them up.
     */
    path: string;
  }>;
}> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(epubPath);

    const chapters = [];
    for (const chapter of structure.chapters) {
      const archivePath = processor.resolvePath(chapter.href);
      try {
        const text = await processor.getChapterText(chapter.id, keepFootnoteMarkers);
        chapters.push({
          id: chapter.id,
          title: chapter.title,
          text,
          path: archivePath
        });
      } catch {
        // Skip chapters that can't be read
        chapters.push({
          id: chapter.id,
          title: chapter.title,
          text: '',
          path: archivePath
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
 * Compute the change count for each requested chapter by extracting both the
 * original and cleaned text and running the same compact diff used to build the
 * pre-computed cache during AI cleanup. This lets the Review Changes dropdown
 * show a real "N changes" (including "0 changes") for chapters that were never
 * part of a cleanup job — instead of leaving the count blank or guessing zero.
 *
 * Text is extracted, counted, and discarded one chapter at a time, so this stays
 * memory-light even on large books. The event loop is yielded between chapters
 * so a long book doesn't block other main-process IPC.
 */
export async function getComparisonChangeCounts(
  originalPath: string,
  cleanedPath: string,
  chapterIds?: string[]
): Promise<Array<{ id: string; changeCount: number }>> {
  const { computeCompactDiff } = await import('./diff-cache.js');

  const originalProcessor = new EpubProcessor();
  const cleanedProcessor = new EpubProcessor();
  const counts: Array<{ id: string; changeCount: number }> = [];

  try {
    const [originalExists, cleanedExists] = await Promise.all([
      fs.access(originalPath).then(() => true).catch(() => false),
      fs.access(cleanedPath).then(() => true).catch(() => false)
    ]);
    if (!originalExists || !cleanedExists) return counts;

    const originalStructure = await originalProcessor.open(originalPath);
    await cleanedProcessor.open(cleanedPath);

    const wanted = chapterIds ? new Set(chapterIds) : null;

    let processed = 0;
    for (const chapter of originalStructure.chapters) {
      if (wanted && !wanted.has(chapter.id)) continue;

      let originalText = '';
      let cleanedText = '';
      try {
        originalText = extractChapterAsText(await originalProcessor.getChapterXhtml(chapter.id));
      } catch {
        // Chapter missing in original — leave empty
      }
      try {
        cleanedText = extractChapterAsText(await cleanedProcessor.getChapterXhtml(chapter.id));
      } catch {
        // Chapter missing in cleaned — leave empty
      }

      const { changeCount } = computeCompactDiff(originalText, cleanedText);
      counts.push({ id: chapter.id, changeCount });

      // Yield periodically so a large book doesn't starve other IPC.
      if (++processed % 5 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return counts;
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

  let originalText = '';
  let cleanedText = '';

  try {
    // Check if files exist before trying to open
    const [originalExists, cleanedExists] = await Promise.all([
      fs.access(originalPath).then(() => true).catch(() => false),
      fs.access(cleanedPath).then(() => true).catch(() => false)
    ]);

    // IMPORTANT: Use extractChapterAsText (cheerio-based, block-level extraction)
    // to match how the diff cache was computed. Using getChapterText (regex-based)
    // produces different text, causing character position misalignment in hydration.
    if (originalExists) {
      await originalProcessor.open(originalPath);
      try {
        const xhtml = await originalProcessor.getChapterXhtml(chapterId);
        originalText = extractChapterAsText(xhtml);
      } catch {
        // Chapter not found in original
      }
    }

    if (cleanedExists) {
      await cleanedProcessor.open(cleanedPath);
      try {
        const xhtml = await cleanedProcessor.getChapterXhtml(chapterId);
        cleanedText = extractChapterAsText(xhtml);
      } catch {
        // Chapter not found in cleaned
      }
    }

    return { originalText, cleanedText };
  } finally {
    originalProcessor.close();
    cleanedProcessor.close();
  }
}

/**
 * Edit specific text within an EPUB file.
 * Uses plain-text extraction to match user edits from the diff view,
 * then rebuilds the chapter XHTML with the modified text.
 */
export async function editEpubText(
  epubPath: string,
  chapterId: string,
  oldText: string,
  newText: string
): Promise<{ success: boolean; error?: string }> {
  const processor = new EpubProcessor();

  // Helper to extract plain text from XHTML (same as replaceTextInEpub)
  function extractText(xhtml: string): string {
    let text = xhtml.replace(/<head[\s\S]*?<\/head>/gi, '');
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '');
    text = text.replace(/([^.!?\s])<\/h[2-6]>/gi, '$1.');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/h[2-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n\n');
    text = text.replace(/<\/blockquote>/gi, '\n\n');
    text = text.replace(/<\/figcaption>/gi, '\n\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<(p|h[2-6]|li|blockquote|figcaption)([\s>])/gi, '\n\n<$1$2');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    text = text.replace(/\u00AD\s*/g, '');
    text = text.replace(/&shy;\s*/g, '');
    text = text.replace(/[^\S\n]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');
    text = text.replace(/^ +| +$/gm, '');
    return text.trim();
  }

  function escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function rebuildXhtml(originalXhtml: string, newPlainText: string): string {
    const bodyMatch = originalXhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (!bodyMatch) return originalXhtml;

    const bodyContent = bodyMatch[1];
    const newBlocks = newPlainText.split(/\n\n+/).map(b => b.trim()).filter(b => b.length > 0);
    if (newBlocks.length === 0) return originalXhtml;

    const blockPattern = /<(p|h[1-6]|li|blockquote|figcaption)([^>]*)>([\s\S]*?)<\/\1>/gi;
    interface BlockMatch { full: string; tag: string; attrs: string; content: string; startIndex: number; hasText: boolean; }
    const matches: BlockMatch[] = [];
    let match;
    while ((match = blockPattern.exec(bodyContent)) !== null) {
      const textContent = match[3].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
      matches.push({ full: match[0], tag: match[1], attrs: match[2], content: match[3], startIndex: match.index, hasText: textContent.length > 0 });
    }
    const textMatches = matches.filter(m => m.hasText);

    if (textMatches.length === newBlocks.length) {
      let newBodyContent = bodyContent;
      for (let i = textMatches.length - 1; i >= 0; i--) {
        const m = textMatches[i];
        const newElement = `<${m.tag}${m.attrs}>${escapeXml(newBlocks[i])}</${m.tag}>`;
        newBodyContent = newBodyContent.substring(0, m.startIndex) + newElement + newBodyContent.substring(m.startIndex + m.full.length);
      }
      return originalXhtml.replace(/<body([^>]*)>[\s\S]*<\/body>/i, `<body$1>${newBodyContent}</body>`);
    }

    const paragraphs = newBlocks.map(p => `<p>${escapeXml(p)}</p>`).join('\n');
    return originalXhtml.replace(/<body([^>]*)>[\s\S]*<\/body>/i, `<body$1>\n${paragraphs}\n</body>`);
  }

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

    // Extract plain text to match against the user's edit
    const extractedText = extractText(xhtml);
    const normalizedOld = oldText.replace(/\s+/g, ' ').trim();
    const normalizedExtracted = extractedText.replace(/\s+/g, ' ').trim();

    if (!normalizedExtracted.includes(normalizedOld)) {
      return { success: false, error: 'Text not found in chapter (plain text match failed)' };
    }

    // Replace in extracted text and rebuild XHTML
    let modifiedText = extractedText.replace(oldText, newText);
    if (modifiedText === extractedText) {
      // Try flexible whitespace matching
      const escapedOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flexPattern = escapedOld.replace(/\s+/g, '\\s+');
      const regex = new RegExp(flexPattern, 's');
      modifiedText = extractedText.replace(regex, newText);
    }

    if (modifiedText === extractedText) {
      return { success: false, error: 'Text replacement produced no changes' };
    }

    const newXhtml = rebuildXhtml(xhtml, modifiedText);
    if (newXhtml === xhtml) {
      return { success: false, error: 'XHTML rebuild produced no changes' };
    }

    // The book, in place, with one document's bytes changed. The reader is
    // released before the land (see `rewriteEpubEntries`), so `processor` is
    // closed here rather than left to the `finally` — it is the descriptor a
    // ZIP's rename onto this same path would trip over.
    processor.close();
    await rewriteEpubEntries({
      from: epubPath,
      to: epubPath,
      toKind: await stagedContainerKindFor(epubPath),
      build: async (source, sink) => {
        for (const entryName of source.getEntries()) {
          if (entryName === href) {
            sink.addFile(entryName, Buffer.from(newXhtml, 'utf8'));
          } else {
            const data = await source.readEntry(entryName);
            const compress = entryName !== 'mimetype';
            sink.addFile(entryName, data, compress);
          }
        }
      },
    });

    // Invalidate the diff cache since the EPUB changed.
    //
    // Through `deriveDiffPath`, which is the ONE derivation of this sibling and
    // has been since it was written. What stood here was
    // `epubPath.replace('.epub', '.diff.json')`, and `String.replace` returns
    // its input UNCHANGED when the needle is not there — so for any book path
    // without a literal lowercase `.epub` in it (a `.EPUB`, a `.working`
    // directory, an extension-less staging name) this deleted THE BOOK THAT HAD
    // JUST BEEN WRITTEN, and reported success.
    const { deriveDiffPath } = await import('./diff-cache.js');
    const fs = await import('fs/promises');
    await fs.rm(deriveDiffPath(epubPath), { force: true });

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
    // Remove H1 tags entirely - they're chapter titles
    text = text.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '');
    text = text.replace(/([^.!?\s])<\/h[2-6]>/gi, '$1.');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/h[2-6]>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n\n');
    text = text.replace(/<\/blockquote>/gi, '\n\n');
    text = text.replace(/<\/figcaption>/gi, '\n\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // Add newlines BEFORE opening block tags too
    text = text.replace(/<(p|h[2-6]|li|blockquote|figcaption)([\s>])/gi, '\n\n<$1$2');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    text = text.replace(/\u00AD\s*/g, '');
    text = text.replace(/&shy;\s*/g, '');
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

    // The book, in place, with one document's bytes changed. `processor` is
    // released here rather than in the `finally` because it holds the very path
    // the sink is about to land on.
    const replacedHref = foundHref;
    const replacedXhtml = modifiedXhtml;
    processor.close();
    await rewriteEpubEntries({
      from: epubPath,
      to: epubPath,
      toKind: await stagedContainerKindFor(epubPath),
      build: async (source, sink) => {
        for (const entryName of source.getEntries()) {
          if (entryName === replacedHref) {
            // Write modified content
            sink.addFile(entryName, Buffer.from(replacedXhtml, 'utf8'));
          } else {
            // Copy file as-is
            const data = await source.readEntry(entryName);
            const compress = entryName !== 'mimetype';
            sink.addFile(entryName, data, compress);
          }
        }
      },
    });

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
    const zipWriter = await createEpubSink(outputPath, 'zip');
    const entries = processor.entryNames();

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
 * Copy an EPUB FILE to a new location — bytes, verbatim.
 *
 * ── Why this stayed a byte copy when the working copy became a tree ─────────
 *
 * It has exactly one caller, `epub:copy-file` in main.ts, and that channel has
 * no caller at all: `epubApi.copyFile` is declared in preload.ts and invoked
 * nowhere in the renderer (grepped across `src/`, 2026-08-11). So nothing hands
 * it an exploded book today, and giving it a tree form would be inventing a
 * second, untested copy path beside `copyBookProvingEveryEntry` — the one this
 * app actually copies books with, which proves the result entry by entry.
 *
 * What it will NOT do is discover that by accident. A directory reaches
 * `fs.readFile` as a bare `EISDIR`, which says nothing about books, so it is
 * named and refused here instead. If a caller ever does need to copy an exploded
 * book, the answer is the seam, not a second `readFile`.
 */
export async function copyEpubFile(
  inputPath: string,
  outputPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if ((await fs.stat(inputPath)).isDirectory()) {
      return {
        success: false,
        error: `${inputPath} is an exploded book — a folder of its parts — and this copies a book `
          + 'that is one file. Nothing was written. An exploded book is copied through the container '
          + 'seam (electron/epub-container.ts), which proves the copy entry by entry.',
      };
    }
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
    const zipWriter = await createEpubSink(outputPath, 'zip');
    const entries = processor.entryNames();

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
        const modifiedXhtml = removeBlocksFromXhtml(originalXhtml, sectionDeletions, entryName);
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

// Block-level elements an EPUB editing path may exclude. Also the base of
// EXPORT_UNIT_TAGS, the markup-preserving exporter's alignment unit set.
const EDITABLE_BLOCK_TAGS = new Set(
  ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'blockquote', 'ul', 'ol', 'figure'],
);

/**
 * Collect the editable block elements of one XHTML body, in document order.
 *
 * THE INDEX INTO THIS ARRAY IS THE BLOCK'S IDENTITY. Whoever selected element
 * `n` and `removeBlocksFromXhtml`, which deletes element `n`, must walk the tree
 * identically or the wrong paragraph disappears. That is the entire reason this
 * is one shared function rather than two matching ones — a "matching" pair is a
 * pair that can drift.
 *
 * Nested blocks are skipped: a `<p>` inside a collected `<blockquote>` is part of
 * that quote, not a separate row. Elements with under two characters of text are
 * skipped as layout filler unless they carry an image.
 */
function collectEditableBlocks(body: any): any[] {
  const found: any[] = [];

  function walk(node: any): void {
    if (node.nodeType !== 1) return; // ELEMENT_NODE only

    const tagName = node.tagName?.toLowerCase() || '';
    const isBlockTag = EDITABLE_BLOCK_TAGS.has(tagName);
    const isImageDiv = tagName === 'div' &&
      (node.getAttribute('class')?.includes('image') || node.getAttribute('class')?.includes('figure'));

    if (isBlockTag || isImageDiv) {
      const isNested = found.some((collected) => isDescendantOf(node, collected));
      if (!isNested) {
        const text = getTextContent(node).trim();
        const isImage = tagName === 'img' || node.getElementsByTagName('img').length > 0;
        if (isImage || text.length >= 2) {
          found.push(node);
        }
      }
    }

    for (let i = 0; i < node.childNodes.length; i++) {
      walk(node.childNodes[i]);
    }
  }

  walk(body);
  return found;
}

// XML predefines exactly these five. Every other named entity — &nbsp; &mdash;
// &rsquo; and the rest of the HTML set — is undefined in XML unless the document
// declares it, which EPUB XHTML almost never does.
const XML_PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'apos', 'quot']);

/**
 * Rewrite HTML named entities as numeric character references so an XML parser can
 * read them.
 *
 * xmldom does not resolve `&nbsp;` — it logs "entity not found" and leaves the raw
 * text, so a parse/serialize round trip turns `<p>C&nbsp;D</p>` into
 * `<p>C&amp;nbsp;D</p>`. That is not a cosmetic difference: the entity has become
 * literal text, the reader shows "C&nbsp;D", and TTS says "amp nbsp". Measured on
 * the library, this fires on many books' front matter.
 *
 * Surgical on purpose. It rewrites ONLY named entities, ONLY ones XML does not
 * predefine, and ONLY ones the HTML table actually knows — anything unrecognized is
 * left exactly as found rather than guessed at. Decoding the whole document instead
 * would turn `&lt;` into a real `<` and destroy the markup.
 */
function xmlSafeEntities(xhtml: string): string {
  const { decodeHTMLStrict } = require('entities');
  return xhtml.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole: string, name: string) => {
    if (XML_PREDEFINED_ENTITIES.has(name)) return whole;
    const decoded: string = decodeHTMLStrict(whole);
    if (decoded === whole) return whole; // not a known entity — leave it alone
    let out = '';
    for (const ch of decoded) out += `&#${ch.codePointAt(0)};`;
    return out;
  });
}

/**
 * Parse one XHTML document and hand back its DOM plus the `<body>` element.
 * Throws rather than degrading: a section whose markup will not parse cannot be
 * edited or preserved, and silently skipping it would drop the user's content.
 */
export function parseXhtmlBody(xhtml: string, whatFor: string): { doc: any; body: any } {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(xmlSafeEntities(xhtml), 'application/xhtml+xml');

  if (!doc || !doc.documentElement) {
    throw new Error(`Could not parse XHTML for ${whatFor} — the section's markup is malformed.`);
  }

  const body = doc.getElementsByTagName('body')[0];
  if (!body) {
    throw new Error(`No <body> element in ${whatFor} — the section's markup is malformed.`);
  }

  return { doc, body };
}

/**
 * Parse one XHTML document and hand back its `<body>` plus the editable blocks.
 * Throws rather than degrading: a section whose markup will not parse cannot have
 * the user's exclusions applied to it, and silently returning it unchanged would
 * ship content the user explicitly removed.
 */
function parseXhtmlBlocks(xhtml: string, whatFor: string): { doc: any; body: any; blocks: any[] } {
  const { doc, body } = parseXhtmlBody(xhtml, whatFor);
  return { doc, body, blocks: collectEditableBlocks(body) };
}

/**
 * Remove specific block elements from XHTML by their indices.
 * Indices come from `collectEditableBlocks` — the same walk the editor displayed.
 */
function removeBlocksFromXhtml(xhtml: string, indicesToRemove: number[], whatFor: string): string {
  if (indicesToRemove.length === 0) return xhtml;

  const { XMLSerializer } = require('@xmldom/xmldom');
  const { doc, blocks } = parseXhtmlBlocks(xhtml, whatFor);

  // An index past the end means the editor and this walk disagree about what the
  // section contains — the user's other deletions in this section are then landing
  // on unknown elements, so refuse rather than mangle the book.
  const stray = indicesToRemove.filter((i) => i < 0 || i >= blocks.length);
  if (stray.length > 0) {
    throw new Error(
      `Block index ${stray.join(', ')} is out of range for ${whatFor} `
      + `(it has ${blocks.length} blocks). The saved selection no longer matches this file.`,
    );
  }

  // Remove in reverse document order so earlier indices stay valid as we go.
  for (const index of [...indicesToRemove].sort((a, b) => b - a)) {
    const element = blocks[index];
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }

  return new XMLSerializer().serializeToString(doc);
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
  // Comments, processing instructions and other childless node types report
  // childNodes as null in xmldom — they contribute no text.
  if (!node.childNodes) return '';
  let text = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    text += getTextContent(node.childNodes[i]);
  }
  return text;
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
    // Strip soft hyphens and rejoin words split across lines
    const text = $(el).text().replace(/\u00AD\s*/g, '').trim();
    // Only include elements that have actual text
    if (text.length > 0) {
      texts.push(text);
    }
  });

  return texts;
}

/**
 * Extract text from each block element in XHTML using cheerio, also returning
 * the tag name AND the element's attributes per block.
 *
 * The attributes are not decoration. `data-bf-uid` is the element's identity,
 * `data-bf-cat` is what the model that read the page said it was,
 * `data-bf-user-cat` is what a person said it was, and
 * `data-bf-category`/`data-bf-group`/`data-bf-blocks` are the reflow's
 * provenance. A writer that rebuilds a chapter from these texts and emits bare
 * `<p>` tags destroys all of it \u2014 which is exactly what the AI-cleanup rebuild
 * did until 2026-08-10 (see `rebuildChapterPreservingHeadings` in
 * electron/ai-bridge.ts). Anything that takes text OUT of a document in order to
 * put text back must take the attributes with it.
 */
export function extractBlockTextsWithTags(
  xhtml: string,
): Array<{ text: string; tagName: string; attrs: Record<string, string> }> {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  const blocks: Array<{ text: string; tagName: string; attrs: Record<string, string> }> = [];
  $(BLOCK_SELECTORS).each((_, el) => {
    const text = $(el).text().replace(/\u00AD\s*/g, '').trim();
    if (text.length > 0) {
      blocks.push({
        text,
        tagName: (el as any).tagName?.toLowerCase() || 'p',
        attrs: { ...((el as any).attribs ?? {}) },
      });
    }
  });
  return blocks;
}

/**
 * Replace text in each block element in XHTML using cheerio.
 * Takes cleaned texts in the same order as extractBlockTexts returned them.
 * Returns the modified XHTML.
 */
export function replaceBlockTexts(xhtml: string, cleanedTexts: string[], options?: { skipHeadings?: boolean }): string {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  let textIndex = 0;
  const skipH1 = options?.skipHeadings ?? false;

  $(BLOCK_SELECTORS).each((_, el) => {
    // Only replace elements that had text (matching extractBlockTexts logic)
    const originalText = $(el).text().trim();
    if (originalText.length > 0) {
      // Skip h1 headings if requested (cleanup: headings pass through untouched)
      const tagName = (el as any).tagName?.toLowerCase();
      if (skipH1 && tagName === 'h1') {
        return; // Leave h1 unchanged
      }
      if (textIndex < cleanedTexts.length) {
        // Skip markers mean "keep the original" — leave element unchanged
        const SKIP_MARKERS = ['[SKIP]', '[NO READABLE TEXT]', '[NOTHING TO CLEAN]'];
        const trimmedCandidate = cleanedTexts[textIndex].trim();
        if (SKIP_MARKERS.some(m => trimmedCandidate === m || trimmedCandidate.startsWith(m))) {
          textIndex++;
          return; // Keep original element text unchanged
        }

        // Sanitize: strip any [[BLOCK]] markers that might have slipped into the text
        // These are internal processing markers and should NEVER appear in final output
        let cleanedText = cleanedTexts[textIndex].replace(/\[\[BLOCK\]\]/g, '');
        textIndex++;

        // If there are more cleaned text entries than remaining block elements,
        // join the overflow into this block. This prevents text loss when the AI
        // introduces paragraph breaks (double newlines) that produce more split
        // entries than there are block elements in the original XHTML.
        // Count how many non-skipped text blocks come AFTER this one
        let blocksAfter = 0;
        let pastCurrent = false;
        $(BLOCK_SELECTORS).each((_, candidate) => {
          if (candidate === el) { pastCurrent = true; return; }
          if (!pastCurrent) return;
          const candidateText = $(candidate).text().trim();
          if (candidateText.length === 0) return;
          const candidateTag = (candidate as any).tagName?.toLowerCase();
          if (skipH1 && candidateTag === 'h1') return;
          blocksAfter++;
        });

        const remainingTexts = cleanedTexts.length - textIndex;
        if (remainingTexts > 0 && remainingTexts > blocksAfter) {
          // More texts than remaining blocks — absorb overflow into this element
          const overflow = remainingTexts - blocksAfter;
          for (let j = 0; j < overflow; j++) {
            cleanedText += '\n\n' + cleanedTexts[textIndex].replace(/\[\[BLOCK\]\]/g, '');
            textIndex++;
          }
        }

        // Replace the element's text content
        $(el).text(cleanedText);
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
    const endPos = i + 1 < markers.length ? markers[i + 1].pos - markers[i + 1].num.toString().length - 6 : text.length;
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

/**
 * Chapter data with text content
 */
export interface ChapterData {
  id: string;
  title: string;
  text: string;
}

/**
 * Extract text from EPUB preserving chapter structure
 */
export async function extractChaptersFromEpub(
  epubPath: string
): Promise<{ success: boolean; chapters?: ChapterData[]; error?: string }> {
  try {
    console.log(`[EPUB] extractChaptersFromEpub: parsing ${epubPath}`);
    await parseEpub(epubPath);

    const chapters = getChapters();
    console.log(`[EPUB] Found ${chapters.length} chapters`);
    if (!chapters || chapters.length === 0) {
      closeEpub();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    const chapterData: ChapterData[] = [];
    for (const chapter of chapters) {
      try {
        const chapterText = await getChapterText(chapter.id);
        if (chapterText && chapterText.trim()) {
          chapterData.push({
            id: chapter.id,
            title: chapter.title || chapter.id,
            text: chapterText.trim()
          });
        }
      } catch (err) {
        console.warn(`[EPUB] Failed to extract chapter ${chapter.id}: ${(err as Error).message}`);
      }
    }

    closeEpub();

    console.log(`[EPUB] Extracted ${chapterData.length} chapters with content`);
    if (chapterData.length === 0) {
      return { success: false, error: 'No text content found in EPUB' };
    }

    return { success: true, chapters: chapterData };
  } catch (err) {
    console.error(`[EPUB] extractChaptersFromEpub error:`, err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Chapter data with block-level text and tag info.
 * Provides heading separately from body text for proper h1/p handling.
 */
export interface ChapterBlockData {
  chapterId: string;
  filePath: string;       // path within ZIP
  heading: string | null; // h1 text if present
  bodyText: string;       // non-h1 block texts joined by \n\n
  allBlocks: Array<{ text: string; tagName: string }>;
}

/**
 * Extract chapters with block-level text and tag info.
 * Unlike extractChaptersFromEpub which strips h1 (via extractTextFromXhtml),
 * this preserves heading info and returns all block elements with their tags.
 */
export async function extractChaptersWithBlocks(
  epubPath: string
): Promise<{ success: boolean; chapters?: ChapterBlockData[]; error?: string }> {
  const processor = new EpubProcessor();
  try {
    console.log(`[EPUB] extractChaptersWithBlocks: parsing ${epubPath}`);
    const structure = await processor.open(epubPath);

    const chapters = structure.chapters;
    if (!chapters || chapters.length === 0) {
      processor.close();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    const result: ChapterBlockData[] = [];
    for (const chapter of chapters) {
      try {
        const href = processor.resolvePath(chapter.href);
        const xhtml = await processor.readFile(href);
        const blocks = extractBlockTextsWithTags(xhtml);

        if (blocks.length === 0) continue;

        // First h1 block is the heading, rest are body
        const headingBlock = blocks.find(b => b.tagName === 'h1');
        const bodyBlocks = blocks.filter(b => b.tagName !== 'h1');

        result.push({
          chapterId: chapter.id,
          filePath: href,
          heading: headingBlock?.text || null,
          bodyText: bodyBlocks.map(b => b.text).join('\n\n'),
          allBlocks: blocks
        });
      } catch (err) {
        console.warn(`[EPUB] Failed to extract chapter ${chapter.id}: ${(err as Error).message}`);
      }
    }

    processor.close();
    console.log(`[EPUB] Extracted ${result.length} chapters with block info`);

    if (result.length === 0) {
      return { success: false, error: 'No text content found in EPUB' };
    }

    return { success: true, chapters: result };
  } catch (err) {
    processor.close();
    console.error(`[EPUB] extractChaptersWithBlocks error:`, err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Copy an EPUB and replace the body content of specified chapter files.
 * For translation: rebuilds body as h1 heading + one <p> per sentence.
 * Preserves everything else: CSS, images, fonts, nav, metadata, non-chapter files.
 */
export async function copyEpubReplaceBodies(
  inputPath: string,
  outputPath: string,
  chapterReplacements: Array<{
    chapterId: string;
    heading: string | null;
    sentences: string[];
    lang: string;
  }>,
  globalSentenceStartIndex: number = 0
): Promise<{ success: boolean; error?: string }> {
  try {
    const processor = new EpubProcessor();
    const structure = await processor.open(inputPath);

    // Build map of chapter ID → file path within ZIP
    const chapterPathMap = new Map<string, string>();
    for (const chapter of structure.chapters) {
      const href = processor.resolvePath(chapter.href);
      chapterPathMap.set(chapter.id, href);
    }

    // Build replacement lookup by file path
    const replacementByPath = new Map<string, typeof chapterReplacements[0]>();
    for (const r of chapterReplacements) {
      const filePath = chapterPathMap.get(r.chapterId);
      if (filePath) {
        replacementByPath.set(filePath, r);
      }
    }

    // The structure has been read; the processor's descriptor is not wanted
    // across the land, so it goes now rather than after the write.
    processor.close();

    let sentenceIndex = globalSentenceStartIndex;

    // Read all files from source, modify chapter bodies. The `outputPath + '.tmp'`
    // + rename this used to end with was a second staging on top of the sink's
    // own; the sink decides how its container lands.
    await rewriteEpubEntries({
      from: inputPath,
      to: outputPath,
      // ── ZIP, stated, because this is a DISTINCT ARTIFACT ──────────────────
      //
      // The result is a stage EPUB the language pipeline reads next
      // (stages/02-translate/<lang>.epub), not a staged replacement for the book
      // it was read from. So its container is its own: those files are archives
      // and stay archives however the book is stored.
      toKind: 'zip',
      build: async (source, sink) => {
        for (const file of source.getEntries()) {
          const replacement = replacementByPath.get(file);

          if (replacement) {
            // Read original xhtml to preserve head/structure
            const originalBuffer = await source.readEntry(file);
            const originalXhtml = originalBuffer.toString('utf8');

            // Build new body content
            const $ = cheerio.load(originalXhtml, { xmlMode: true });
            const body = $('body');
            if (body.length === 0) {
              // No body tag — just copy as-is
              sink.addFile(file, originalBuffer);
              continue;
            }

            // Clear body and rebuild
            body.empty();

            // Add heading if present
            if (replacement.heading) {
              body.append(`<h1>${escapeXmlText(replacement.heading)}</h1>\n`);
            }

            // Add one <p> per sentence with global sentence index
            for (const sentence of replacement.sentences) {
              body.append(`<p id="s${sentenceIndex}">${escapeXmlText(sentence)}</p>\n`);
              sentenceIndex++;
            }

            // Update lang attribute if present
            if (replacement.lang) {
              $('html').attr('xml:lang', replacement.lang);
              $('html').attr('lang', replacement.lang);
            }

            const newXhtml = $.xml();
            sink.addFile(file, Buffer.from(newXhtml, 'utf8'));
          } else {
            // Copy file as-is
            const content = await source.readEntry(file);
            sink.addFile(file, content);
          }
        }
      },
    });

    return { success: true };
  } catch (error) {
    console.error('[EPUB] copyEpubReplaceBodies error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Helper to escape XML text content
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Replace text in multiple chapters of an EPUB while preserving structure.
 *
 * ── Untangled (phase 2a) ────────────────────────────────────────────────────
 *
 * This used to DUPLICATE the whole book onto `outputPath` with `copyEpubFile`
 * and then use that duplicate as both the reader and the rewrite target — a full
 * copy of a 25 MB book whose every byte was immediately read back out and
 * written again through a second temp. The source of this rewrite is
 * `inputPath`; it always was, because the copy was byte-identical to it. So the
 * copy is gone and the read comes from the book, which also makes
 * `inputPath === outputPath` an ordinary in-place rewrite instead of the special
 * case that had to be skipped.
 */
export async function replaceChapterTextsInEpub(
  inputPath: string,
  outputPath: string,
  chapterReplacements: Array<{ chapterId: string; newText: string }>
): Promise<{ success: boolean; error?: string }> {
  try {
    // The book's structure, read from the BOOK and released before the rewrite.
    const processor = new EpubProcessor();
    const chapterPathMap = new Map<string, string>();
    try {
      const structure = await processor.open(inputPath);
      for (const chapter of structure.chapters) {
        chapterPathMap.set(chapter.id, processor.resolvePath(chapter.href));
      }
    } finally {
      processor.close();
    }

    await rewriteEpubEntries({
      from: inputPath,
      to: outputPath,
      // ── ZIP, stated, because this is a DISTINCT ARTIFACT ──────────────────
      //
      // The result is the cleanup stage's own book
      // (stages/01-cleanup/cleaned.epub, electron/ll-jobs.ts), not a staged
      // replacement for the book it was read from. Its only caller writes it
      // beside the book, never onto it.
      toKind: 'zip',
      build: async (source, sink) => {
        for (const file of source.getEntries()) {
          // Check if this file needs text replacement
          const replacement = chapterReplacements.find(r =>
            chapterPathMap.get(r.chapterId) === file
          );

          if (replacement) {
            // This is a chapter that needs replacement — use cheerio-based replaceBlockTexts
            const originalBuffer = await source.readEntry(file);
            const originalContent = originalBuffer.toString('utf8');

            // Split new text into paragraphs (on double newlines)
            const splitTexts = replacement.newText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);

            // Skip h1 headings — cleanup sends only body text, headings pass through untouched
            const newContent = replaceBlockTexts(originalContent, splitTexts, { skipHeadings: true });
            sink.addFile(file, Buffer.from(newContent, 'utf8'));
          } else {
            // Copy file as-is
            const content = await source.readEntry(file);
            sink.addFile(file, content);
          }
        }
      },
    });

    return { success: true };
  } catch (error) {
    console.error('[EPUB] replaceChapterTextsInEpub error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB-preserving export
//
// The picker editor analyzes an EPUB through mupdf layout, which hands back
// laid-out text blocks with page/y coordinates but NO link to the source XHTML
// element each block came from (verified down to the wasm bindings). The legacy
// exporter therefore rebuilt the whole book from plain text, destroying every
// piece of markup — <sup>, <em>, lists, headings, all of it.
//
// This section replaces that: it maps the picker's blocks back onto the EPUB's
// own elements by SEQUENTIAL TEXT ALIGNMENT (both sides read the book in the
// same order, so a monotonic cursor over the concatenated normalized text pins
// each block to its source elements), then exports surgically — deleted blocks
// remove their elements, corrected blocks rebuild only the touched elements,
// and everything untouched is serialized verbatim from the source DOM.
// ─────────────────────────────────────────────────────────────────────────────

/** One picker block, folded by the caller into export-ready form. */
export interface EpubExportBlock {
  id: string;
  page: number;
  y: number;
  /** ORIGINAL pre-correction text (merged blocks carry their joined text). */
  text: string;
  /** Deletion ∪ deleted-page, folded by the caller. */
  deleted: boolean;
  isImage: boolean;
  isFootnoteMarker: boolean;
  /** Set on footnote markers: the block the marker was extracted from. */
  parentBlockId?: string;
}

export interface EpubExportChapter {
  title: string;
  level: number;
  page: number;
  y: number;
  blockId?: string;
  mergedBlockIds?: string[];
}

export interface EpubExportMetadata {
  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  description?: string;
  year?: string;
}

export interface EpubPreservingEdits {
  /** ALL blocks incl. deleted, in reading order (page asc, then y asc). */
  blocks: EpubExportBlock[];
  /** ONLY blocks whose text genuinely changed (corrections / highlight strips). */
  effectiveTexts: Record<string, string>;
  chapters: EpubExportChapter[];
  metadata: EpubExportMetadata;
}

/** One alignable element of the source EPUB, in spine order. */
export interface ExportUnit {
  /** Zip entry name of the spine document this element lives in. */
  file: string;
  /**
   * `<file>#<index within that file's unit list>` — this element's positional
   * identity, and the only one it has: foundry's EPUB emitter gives elements no
   * ids. It is what the narration deletions are recorded as, and both the reader
   * that records them and the writer that applies them walk THIS unit list, so
   * the index means the same thing to both (shared/vlm/narration-deletions.ts).
   */
  key: string;
  tag: string;
  /** The live xmldom element — kept so the exporter can serialize it verbatim. */
  el: any;
  normText: string;
  /** [streamStart, streamEnd) into the alignment stream; -1 when excluded (image-only). */
  streamStart: number;
  streamEnd: number;
  imageOnly: boolean;
  /** True when the catch-all sweep collected this element (stray text outside the tag set). */
  fromCatchAll: boolean;
}

/**
 * A block the aligner could not place in the source markup, and WHY.
 *
 * The reason is the aligner's own words at the point it gave up, and the excerpt
 * is the block's opening text — together they are the difference between "one
 * block failed" (which no one can act on) and "the lone '3' on page 41 was too
 * short to place unambiguously" (which anyone can). Carried rather than counted
 * for exactly that reason: the count is derivable from the detail, the detail is
 * not recoverable from the count.
 */
export interface UnalignedBlock {
  blockId: string;
  page: number;
  excerpt: string;
  reason: string;
}

export interface EpubAlignmentResult {
  units: ExportUnit[];
  /** Block id → indices into `units` the block's text overlaps. */
  blockToUnits: Map<string, number[]>;
  unaligned: UnalignedBlock[];
  /** Indices of text units no block matched. */
  uncoveredUnits: number[];
  /** Every picture of the book, in spine order. */
  imageUnits: ImageUnit[];
  /** Image block id → index into `imageUnits`. */
  blockToImageUnit: Map<string, number>;
  /**
   * Image blocks the matcher REFUSED to pair, and why.
   *
   * Kept apart from `unaligned`, which is about text: these are pictures whose
   * document or ordinal could not be settled by counting, and the honest
   * consequence is that they cannot be struck. Reported rather than guessed —
   * see `alignImageBlocks`.
   */
  unmatchedImages: UnalignedBlock[];
}

// Tags collected as export units: everything the editor treats as a block, plus
// container tags the editor never offers for exclusion but which still hold text
// that mupdf lays out (tables, preformatted text, definition lists, addresses,
// and figcaptions that sit outside a <figure>).
const EXPORT_UNIT_TAGS = new Set([
  ...EDITABLE_BLOCK_TAGS,
  'table', 'pre', 'dl', 'address', 'figcaption',
]);

// Whitespace beyond \s that must vanish before comparison. NFKC already folds
// most exotic spaces to U+0020, but the raw code points are listed anyway so the
// function does not depend on the normalization table for correctness.
const ALIGN_WHITESPACE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;
// Soft hyphens, zero-width/formatting characters, and replacement characters.
const ALIGN_INVISIBLES = /[\u00AD\u200B-\u200D\uFEFF\u2060\uFFFC\uFFFD]/g;

/**
 * Normalize text for alignment. IDENTICAL for unit text and block text — the
 * whole alignment rests on both sides normalizing the same way. No case
 * folding, no punctuation mapping: those would hide real mismatches.
 */
function normalizeForAlignment(s: string): string {
  return s
    .normalize('NFKC')
    .replace(ALIGN_WHITESPACE, '')
    .replace(ALIGN_INVISIBLES, '');
}

// Elements whose text mupdf never lays out — their contents must not reach the
// alignment stream or the catch-all, or the two sides diverge on every book
// that ships an inline <style> or <script>.
const UNIT_TEXT_SKIP_TAGS = new Set(['script', 'style', 'template']);

/** `getUnitTextContent`, for the modules outside this file that walk with it. */
export function unitTextContent(node: any): string {
  return getUnitTextContent(node);
}

/**
 * Text content of a unit AS RENDERED: like getTextContent, but skips
 * script/style/template subtrees and includes CDATA sections. This is the text
 * the alignment compares against picker blocks, which come from mupdf layout.
 *
 * EXPORTED as `unitTextContent` below, because it is also what a narration
 * strike's fingerprint is taken from (shared/vlm/narration-deletions.ts) and
 * that has to be the SAME text the walk sees — a second reading of an element,
 * however similar, would compare two descriptions of the book rather than the
 * book against its record.
 */
function getUnitTextContent(node: any): string {
  if (node.nodeType === 3 || node.nodeType === 4) { // TEXT_NODE, CDATA_SECTION
    return node.nodeValue || '';
  }
  if (node.nodeType !== 1) return ''; // comments, PIs — no rendered text
  const tag = node.tagName?.toLowerCase() || '';
  if (UNIT_TEXT_SKIP_TAGS.has(tag)) return '';
  if (!node.childNodes) return '';
  let text = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    text += getUnitTextContent(node.childNodes[i]);
  }
  return text;
}

/**
 * Collect the export units of one XHTML body, in document order.
 *
 * Same top-level/nested walk discipline as `collectEditableBlocks` (a <p>
 * inside a collected <blockquote> belongs to the quote), but over the wider
 * EXPORT_UNIT_TAGS set, with a lower text threshold (a one-character drop-cap
 * <p> is a unit), and with a catch-all: any non-whitespace text the walk left
 * uncovered is collected as additional units so NO source text can silently
 * escape the alignment. The catch-all enforces the no-fallbacks rule — text
 * that still cannot be attributed to an element is a thrown error, not a
 * silent gap.
 *
 * The catch-all has two forms, both observed across the real library:
 *  1. Stray text inside an element that holds NO collected unit (e.g. a bare
 *     <td> chain, a custom tag): collect the maximal such ancestor.
 *  2. Stray text directly inside <body> or inside a MIXED container that also
 *     holds collected units (Calibre books write `<i>…</i>, he thought.` as
 *     bare inline content between paragraphs): no existing element can cover
 *     the run without duplicating its collected siblings, so the consecutive
 *     uncovered sibling nodes are MOVED into a synthesized <div> wrapper,
 *     which becomes the unit. The wrapper preserves the run's own inline
 *     markup verbatim; collected units are never touched.
 */
export function collectExportUnits(
  doc: any,
  body: any,
  whatFor: string,
): Array<{ el: any; tag: string; normText: string; imageOnly: boolean; fromCatchAll: boolean }> {
  const found: any[] = [];

  function walk(node: any): void {
    if (node.nodeType !== 1) return; // ELEMENT_NODE only

    const tagName = node.tagName?.toLowerCase() || '';
    const isUnitTag = EXPORT_UNIT_TAGS.has(tagName);
    const isImageDiv = tagName === 'div' &&
      (node.getAttribute('class')?.includes('image') || node.getAttribute('class')?.includes('figure'));

    if (isUnitTag || isImageDiv) {
      const isNested = found.some((collected) => isDescendantOf(node, collected));
      if (!isNested) {
        const normText = normalizeForAlignment(getUnitTextContent(node));
        const hasImage = tagName === 'img' || node.getElementsByTagName('img').length > 0;
        if (hasImage || normText.length >= 1) {
          found.push(node);
        }
      }
    }

    if (!node.childNodes) return;
    for (let i = 0; i < node.childNodes.length; i++) {
      walk(node.childNodes[i]);
    }
  }

  walk(body);

  // ── Catch-all: sweep for text the walk did not cover ──────────────────────
  const foundSet = new Set(found);
  const strayUnits = new Set<any>();
  const isCovered = (textNode: any): boolean => {
    for (let p = textNode.parentNode; p; p = p.parentNode) {
      if (foundSet.has(p)) return true;
    }
    return false;
  };
  const containsCollected = (el: any): boolean =>
    found.some((u) => u === el || isDescendantOf(u, el));
  const collect = (el: any): void => {
    found.push(el);
    foundSet.add(el);
    strayUnits.add(el);
  };

  // Pass 1 (read-only): gather uncovered non-whitespace text nodes in document
  // order, skipping script/style subtrees — mupdf never renders those.
  const strayTextNodes: any[] = [];
  const scan = (node: any): void => {
    if (node.nodeType === 1) {
      const tag = node.tagName?.toLowerCase() || '';
      if (UNIT_TEXT_SKIP_TAGS.has(tag)) return;
    }
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (normalizeForAlignment(node.nodeValue || '').length > 0 && !isCovered(node)) {
        strayTextNodes.push(node);
      }
      return;
    }
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) scan(node.childNodes[i]);
    }
  };
  scan(body);

  // Pass 2 (mutating): cover each stray. Re-check coverage first — an earlier
  // stray's unit may already cover this one.
  for (const textNode of strayTextNodes) {
    if (isCovered(textNode)) continue;
    const parent = textNode.parentNode;
    if (!parent || parent.nodeType !== 1) {
      throw new Error(
        `Export unit collection for ${whatFor} found stray text outside any element: `
        + `"${(textNode.nodeValue || '').trim().slice(0, 80)}"`,
      );
    }

    if (parent !== body && !containsCollected(parent)) {
      // Form 1: climb to the maximal ancestor containing no collected unit.
      let el = parent;
      while (
        el.parentNode && el.parentNode.nodeType === 1 && el.parentNode !== body &&
        !containsCollected(el.parentNode)
      ) {
        el = el.parentNode;
      }
      collect(el);
      continue;
    }

    // Form 2: mixed container (or <body> itself) — wrap the maximal run of
    // consecutive uncovered siblings around the stray in a synthesized <div>.
    const canAbsorb = (sib: any): boolean => {
      if (sib.nodeType === 1) {
        if (UNIT_TEXT_SKIP_TAGS.has(sib.tagName?.toLowerCase() || '')) return false;
        return !containsCollected(sib);
      }
      return true; // text, CDATA, comments travel with the run
    };
    const siblings: any[] = [];
    for (let n = parent.firstChild; n; n = n.nextSibling) siblings.push(n);
    const at = siblings.indexOf(textNode);
    if (at < 0) {
      throw new Error(
        `Export unit collection for ${whatFor} lost track of a stray text node — this is a bug.`,
      );
    }
    let lo = at;
    while (lo > 0 && canAbsorb(siblings[lo - 1])) lo--;
    let hi = at;
    while (hi + 1 < siblings.length && canAbsorb(siblings[hi + 1])) hi++;

    const wrapper = doc.createElement('div');
    parent.insertBefore(wrapper, siblings[lo]);
    for (let i = lo; i <= hi; i++) {
      wrapper.appendChild(siblings[i]); // appendChild MOVES the node
    }
    collect(wrapper);
  }

  // Final guarantee: nothing renderable may remain uncovered.
  const verify = (node: any): void => {
    if (node.nodeType === 1) {
      const tag = node.tagName?.toLowerCase() || '';
      if (UNIT_TEXT_SKIP_TAGS.has(tag)) return;
      if (foundSet.has(node)) return;
    }
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (normalizeForAlignment(node.nodeValue || '').length > 0 && !isCovered(node)) {
        throw new Error(
          `Export unit collection for ${whatFor} still has uncovered text after the catch-all: `
          + `"${(node.nodeValue || '').trim().slice(0, 80)}"`,
        );
      }
      return;
    }
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) verify(node.childNodes[i]);
    }
  };
  verify(body);

  // Emit in document order: one traversal, units never descend into each other
  // (a stray unit by construction contains no collected unit, and the walk
  // never collects nested units).
  const out: Array<{ el: any; tag: string; normText: string; imageOnly: boolean; fromCatchAll: boolean }> = [];
  const emit = (node: any): void => {
    if (node.nodeType === 1 && foundSet.has(node)) {
      const tag = node.tagName?.toLowerCase() || '';
      const normText = normalizeForAlignment(getUnitTextContent(node));
      const hasImage = tag === 'img' || node.getElementsByTagName('img').length > 0;
      out.push({
        el: node,
        tag,
        normText,
        imageOnly: hasImage && normText.length === 0,
        fromCatchAll: strayUnits.has(node),
      });
      return;
    }
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) emit(node.childNodes[i]);
    }
  };
  emit(body);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Images, which are elements too
//
// `collectExportUnits` above is a TEXT traversal: it collects the elements that
// contribute characters to the alignment stream. A picture contributes none, so
// it is either swallowed by the element around it or not collected at all —
// which left every image in the library with no identity, and therefore no way
// to be struck out of the narration copy. An image-only document (cover,
// half-title, title page, a plate) could never be emptied and so was never
// pruned, and the user's deletion of it did nothing at all.
//
// So images are enumerated SEPARATELY, in their own key namespace
// (shared/vlm/narration-deletions.ts): a document's Nth image in flow order is
// `<zip entry>#img<N>`. Nothing about the text numbering changes, so every
// strike already on disk still names what it named.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The image elements of one body, in flow order.
 *
 * The SAME element classes `bodyIsEmpty` counts as content — `<img>`, `<svg>`,
 * and a bare `<image>` — because the two questions are one question asked from
 * either end: this decides what can be struck, and that decides whether striking
 * it all leaves a document with nothing in it. A set that disagreed would leave
 * a document whose every picture was struck still counted as non-empty, i.e.
 * still in the book as a blank page.
 *
 * An `<svg>` is not descended into: a wrapped cover is `<svg><image/></svg>` and
 * counting both would make one picture two elements, so the outer element is the
 * picture and the inner `<image>` travels with it. A bare `<image>` outside any
 * `<svg>` is malformed markup that xmldom still hands back, and it is counted
 * where it stands rather than ignored.
 */
export function collectImageElements(body: any): any[] {
  const out: any[] = [];
  const walk = (node: any): void => {
    if (node.nodeType !== 1) return;
    const tag = node.tagName?.toLowerCase() || '';
    if (tag === 'img' || tag === 'svg' || tag === 'image') {
      out.push(node);
      return; // an <svg> IS the picture; its <image> children are part of it
    }
    if (UNIT_TEXT_SKIP_TAGS.has(tag)) return;
    if (!node.childNodes) return;
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  };
  walk(body);
  return out;
}

/** One picture of the source EPUB, in spine order. */
export interface ImageUnit {
  /** Zip entry name of the spine document it lives in. */
  file: string;
  /** Index of that document in the spine — the order the aligner walked. */
  docIndex: number;
  /** `<file>#img<ordinal>` — this picture's positional identity. */
  key: NarrationElementKey;
  /** The live xmldom element, so the narration writer can remove it. */
  el: any;
}

/**
 * Match the picker's IMAGE blocks onto the book's image ELEMENTS.
 *
 * ── The problem, stated exactly ─────────────────────────────────────────────
 *
 * mupdf lays the book out and reports `[Image 528x815]` blocks with a page and a
 * y, in flow order. It does not say which document they came from, and the DOM
 * is gone by then. Text blocks are placed by their own characters; a picture has
 * none, so the only evidence about WHERE it is is the text around it.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * 1. Every image block sits in a GAP between two text blocks the aligner did
 *    place (or before the first / after the last). Those two bound the span of
 *    spine documents the picture can be in: from the document of the previous
 *    aligned text block to the document of the next.
 * 2. A gap whose two ends are the SAME document is unambiguous — the picture is
 *    inline in that document, whatever else is going on.
 * 3. A gap that CROSSES documents is resolved by counting: the tail of the
 *    first document, every document in between (which have no aligned text at
 *    all — an image-only page is exactly this case), and the head of the last.
 *    The blocks are handed out in that order, and only if the number of pictures
 *    those documents still have to spare is EXACTLY the number of blocks in the
 *    gap.
 * 4. Within a document, blocks and elements are paired by ORDINAL — both are in
 *    flow order — and only when the document's counts agree exactly.
 *
 * ── The refusal, and why it is a refusal ────────────────────────────────────
 *
 * Any count that does not add up leaves the blocks unmatched and REPORTED. This
 * is not fussiness: mupdf drops images under 20×20 (pdf-analyzer's own filter)
 * and a document may hold a spacer GIF the layout never showed, so "3 pictures
 * in the markup, 2 blocks on screen" is a real state — and pairing them by
 * ordinal anyway would strike the wrong picture out of somebody's book. A
 * deletion that reached nothing is visible and fixable; a deletion that removed
 * a different plate is neither.
 */
function alignImageBlocks(
  imageUnits: readonly ImageUnit[],
  imageBlocks: readonly EpubExportBlock[],
  docIndexOfBlock: ReadonlyMap<string, number>,
  sortedBlocks: readonly EpubExportBlock[],
  docCount: number,
): { blockToImageUnit: Map<string, number>; unmatched: UnalignedBlock[] } {
  const blockToImageUnit = new Map<string, number>();
  const unmatched: UnalignedBlock[] = [];
  if (imageBlocks.length === 0) return { blockToImageUnit, unmatched };

  // Pictures per document, in flow order, as indices into `imageUnits`.
  const unitsOfDoc = new Map<number, number[]>();
  for (let i = 0; i < imageUnits.length; i++) {
    const list = unitsOfDoc.get(imageUnits[i].docIndex);
    if (list === undefined) unitsOfDoc.set(imageUnits[i].docIndex, [i]);
    else list.push(i);
  }

  // ── Pass 1: bound every image block by the aligned text around it ─────────
  const isImageBlock = new Set(imageBlocks.map((b) => b.id));
  const bounds = new Map<string, { prev: number; next: number }>();
  {
    let prev = -1;
    const prevOf = new Map<string, number>();
    for (const b of sortedBlocks) {
      if (isImageBlock.has(b.id)) { prevOf.set(b.id, prev); continue; }
      const doc = docIndexOfBlock.get(b.id);
      if (doc !== undefined) prev = doc;
    }
    let next = docCount;
    const nextOf = new Map<string, number>();
    for (let i = sortedBlocks.length - 1; i >= 0; i--) {
      const b = sortedBlocks[i];
      if (isImageBlock.has(b.id)) { nextOf.set(b.id, next); continue; }
      const doc = docIndexOfBlock.get(b.id);
      if (doc !== undefined) next = doc;
    }
    for (const b of imageBlocks) {
      // A book with no aligned text anywhere leaves both ends open; the window
      // is then the whole spine, which the counting rule below still decides.
      const prevDoc = prevOf.get(b.id) ?? -1;
      const nextDoc = nextOf.get(b.id) ?? docCount;
      bounds.set(b.id, {
        prev: prevDoc < 0 ? 0 : prevDoc,
        next: nextDoc >= docCount ? docCount - 1 : nextDoc,
      });
    }
  }

  // ── Pass 2: the certain ones — a gap that begins and ends in one document ──
  const blocksOfDoc = new Map<number, EpubExportBlock[]>();
  const ambiguous: EpubExportBlock[] = [];
  const ordered = imageBlocks
    .slice()
    .sort((a, b) => (a.page !== b.page ? a.page - b.page : a.y - b.y));
  for (const b of ordered) {
    const bound = bounds.get(b.id)!;
    if (bound.prev === bound.next) {
      const list = blocksOfDoc.get(bound.prev);
      if (list === undefined) blocksOfDoc.set(bound.prev, [b]);
      else list.push(b);
    } else {
      ambiguous.push(b);
    }
  }

  // ── Pass 3: the crossing gaps, resolved by capacity ───────────────────────
  //
  // Consecutive ambiguous blocks sharing the same window are ONE gap. Each
  // middle document belongs to at most one gap by construction — two gaps with
  // the same window would need an aligned text block between them, which would
  // put that document at one gap's end rather than in the other's middle.
  const refuse = (blocks: readonly EpubExportBlock[], reason: string): void => {
    for (const b of blocks) {
      unmatched.push({ blockId: b.id, page: b.page, excerpt: b.text.slice(0, 80), reason });
    }
  };

  let at = 0;
  while (at < ambiguous.length) {
    const window = bounds.get(ambiguous[at].id)!;
    let end = at + 1;
    while (end < ambiguous.length) {
      const w = bounds.get(ambiguous[end].id)!;
      if (w.prev !== window.prev || w.next !== window.next) break;
      end++;
    }
    const gap = ambiguous.slice(at, end);
    at = end;

    const capacity: Array<{ doc: number; take: number }> = [];
    let total = 0;
    for (let doc = window.prev; doc <= window.next; doc++) {
      const have = (unitsOfDoc.get(doc) ?? []).length;
      const spoken = (blocksOfDoc.get(doc) ?? []).length;
      const take = have - spoken;
      if (take <= 0) continue;
      capacity.push({ doc, take });
      total += take;
    }
    if (total !== gap.length) {
      refuse(
        gap,
        `${gap.length} picture(s) lie between two documents (${window.prev}–${window.next}) with `
        + `${total} unclaimed image element(s) between them, so which document each belongs to `
        + 'cannot be settled by counting',
      );
      continue;
    }
    let cursor = 0;
    for (const { doc, take } of capacity) {
      const list = blocksOfDoc.get(doc) ?? [];
      for (let i = 0; i < take; i++) list.push(gap[cursor++]);
      blocksOfDoc.set(doc, list);
    }
  }

  // ── Pass 4: pair by ordinal, per document, only when the counts agree ──────
  for (const [doc, blocks] of blocksOfDoc) {
    const units = unitsOfDoc.get(doc) ?? [];
    // Flow order on both sides: mupdf lays the document out top to bottom, and
    // `collectImageElements` walks the markup in document order.
    const inOrder = blocks
      .slice()
      .sort((a, b) => (a.page !== b.page ? a.page - b.page : a.y - b.y));
    if (units.length !== inOrder.length) {
      refuse(
        inOrder,
        `${inOrder.length} picture(s) were laid out from a document holding ${units.length} image `
        + 'element(s), so pairing them by position would be a guess',
      );
      continue;
    }
    for (let i = 0; i < inOrder.length; i++) blockToImageUnit.set(inOrder[i].id, units[i]);
  }

  return { blockToImageUnit, unmatched };
}

/**
 * Banded Levenshtein verification: does `pattern` match `text` starting exactly
 * at `offset` with at most `tolerance` edits? Returns the matched END offset in
 * `text` (from the DP's best final column), or -1 when the distance exceeds the
 * tolerance. The band doubles as the length window, so cost is O(m·tolerance).
 */
function bandedLevenshteinMatchEnd(
  pattern: string,
  text: string,
  offset: number,
  tolerance: number,
): number {
  const m = pattern.length;
  const width = Math.min(text.length - offset, m + tolerance);
  if (width < m - tolerance) return -1; // not enough text left to match
  const INF = tolerance + 1;

  let prev = new Int32Array(width + 1).fill(INF);
  for (let j = 0; j <= Math.min(tolerance, width); j++) prev[j] = j;
  let cur = new Int32Array(width + 1);

  for (let i = 1; i <= m; i++) {
    cur.fill(INF);
    const jLo = Math.max(0, i - tolerance);
    const jHi = Math.min(width, i + tolerance);
    const pc = pattern.charCodeAt(i - 1);
    let rowMin = INF;
    for (let j = jLo; j <= jHi; j++) {
      let best = prev[j] + 1; // pattern char unmatched by text
      if (j > 0) {
        const sub = prev[j - 1] + (text.charCodeAt(offset + j - 1) === pc ? 0 : 1);
        if (sub < best) best = sub;
        const ins = cur[j - 1] + 1; // extra text char
        if (ins < best) best = ins;
      }
      cur[j] = best < INF ? best : INF;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin >= INF) return -1; // whole band over tolerance — abandon
    const swap = prev; prev = cur; cur = swap;
  }

  let bestJ = -1;
  let bestD = INF;
  for (let j = Math.max(0, m - tolerance); j <= Math.min(width, m + tolerance); j++) {
    const d = prev[j];
    if (d < bestD) { bestD = d; bestJ = j; }
    else if (d === bestD && bestJ !== -1 && Math.abs(j - m) < Math.abs(bestJ - m)) { bestJ = j; }
  }
  return bestD <= tolerance ? offset + bestJ : -1;
}

// How far ahead of the cursor a block may match. Gaps happen legitimately —
// source text no picker block covered (e.g. content mupdf did not lay out) —
// but an unbounded search would let one bad block teleport the cursor across
// the book.
const ALIGN_GAP_WINDOW = 30000;
// Fuzzy resync anchor length (exact prefix used to find candidate positions).
const ALIGN_ANCHOR_LEN = 24;
// Blocks with fewer normalized chars than this get the strict tiny-block rules:
// a 1–3 char string matches everywhere, so positional evidence must carry it.
const ALIGN_TINY_LEN = 4;

// The most characters mupdf's layout is allowed to have DROPPED inside one
// block before the clipped-line bridge (rule c2) refuses to span the hole.
// Measured case: a 55-character-wide column wrapping an unbreakable URL loses
// one line-width of characters at the clip, so one line's worth with headroom.
// A larger hole is not "layout clipped a long token" any more — it is two
// different texts, and bridging them would attribute a block to markup it does
// not come from.
const ALIGN_CLIP_MAX = 160;

// List-marker furniture mupdf's layout SYNTHESIZES for <ol>/<ul> items and nav
// <ol> counters: "1.", "a)", "iv.", "•" etc. prefixes that exist in the laid-out
// text but nowhere in the source markup (they come from CSS counters). Measured
// across the library this is by far the largest alignment-failure class
// (endnote lists alone: hundreds of blocks per book). A block that fails every
// direct rule is retried once with a single leading marker token stripped.
const LIST_MARKER_PREFIX = /^\s*(?:[•◦▪‣⁃·]|\(?\d{1,4}[.)]|\(?[ivxlcdmIVXLCDM]{1,7}[.)]|\(?[a-zA-Z][.)])\s+/;
// Same tokens ANYWHERE in the text, bounded by whitespace. Used as a last
// retry for blocks where mupdf merged several list items (nav TOCs render as
// "2. PART I 3. 1. California Dreaming …" in one block). Stripping is safe
// because the result must still pass the exact/fuzzy match against the source
// text — a wrong strip simply fails to match, exactly like today.
const LIST_MARKER_ANYWHERE = /(^|\s)(?:[•◦▪‣⁃·]|\(?\d{1,4}[.)]|\(?[ivxlcdmIVXLCDM]{1,7}[.)]|\(?[a-zA-Z][.)])(?=\s|$)/g;

/** Resolve "." and ".." segments in a zip entry name (hrefs like "OPS/../x"). */
export function normalizeZipEntryName(name: string): string {
  const parts: string[] = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Every element of a book, in the ONE order everything else agrees on.
 *
 * The traversal half of `alignBlocksToEpub`, lifted out because it has two
 * callers that want completely different things from it. The aligner matches
 * geometry-only blocks back onto these elements by their text; the quire
 * analysis path is HANDED the element key on every block and needs no matching
 * at all — but it needs the same elements, in the same order, with the same
 * keys, or a key would mean two things.
 *
 * So there is one walk and one enumeration, and `narrationElementKey` /
 * `narrationImageElementKey` are minted here and nowhere else on this path.
 */
export interface EpubElementWalk {
  units: ExportUnit[];
  imageUnits: ImageUnit[];
  /**
   * Zip entry → its position in the SPINE, for the documents this walk parsed.
   *
   * The keys are the parsed documents in spine order; the values are the
   * document's true spine index whether or not every document before it was
   * parsed. A narrowed walk (`only`) therefore reports the same index for a
   * document that a whole-book walk does — the position is a fact about the
   * book, not about how much of it was read.
   */
  docIndexOfFile: Map<string, number>;
  /**
   * The normalized forms of the labels mupdf lays out in place of an image it
   * does not draw (`[<alt>]`). Meaningful only to the mupdf aligner — a browser
   * draws the picture — and carried here because the walk is where the `alt`
   * attributes are in hand.
   */
  imgAltNorms: Set<string>;
}

/**
 * `only` narrows the walk to some of the book's documents.
 *
 * Sound because an element's key is `<zip entry>#<index within that entry>`:
 * the index restarts at every document and the picture ordinals with it, so what
 * a document's elements are called is a function of that document alone and of
 * nothing before or after it. Skipping documents therefore changes no key of the
 * ones that are walked — the same argument `enumerateNarrationElements` makes
 * for its own `only` (electron/quire-stamp.ts), and the same one that lets the
 * spine INDEX still be reported truthfully for a document read out of a book
 * most of which was not.
 *
 * It narrows the PARSE, which is the whole cost: the spine itself is read from
 * the package document either way, and a document that is skipped is never
 * `readFile`d and never handed to `parseXhtmlBody`. Measured on the migrated
 * Nuremberg project, 2026-08-11: 106 ms of `readEpubElementCategories`'s 127 ms
 * was this walk over 20 documents.
 *
 * A document named in `only` that the book's spine does not list simply does not
 * appear in the result, exactly as it would not appear in a whole-book walk of a
 * book that does not have it. The callers that care refuse on the empty
 * enumeration, in their own words, naming the document.
 *
 * NOT every caller may narrow. What a book says about an element is not always a
 * function of that element's own document — see `readEpubElementCategories`,
 * which decides that question and is the only place it is decided.
 */
export async function walkEpubElements(
  epubSourcePath: string,
  only?: ReadonlySet<string>,
): Promise<EpubElementWalk> {
  const processor = new EpubProcessor();
  const units: ExportUnit[] = [];
  const imageUnits: ImageUnit[] = [];
  // mupdf lays out an image's ALT TEXT as "[<alt>]" when it does not draw the
  // image itself — that text exists in no DOM text node, so blocks matching a
  // known alt form are image furniture, not unalignable content.
  const imgAltNorms = new Set<string>();
  /** Zip entry → its position in the spine, for the documents parsed here. */
  const docIndexOfFile = new Map<string, number>();
  /**
   * Every distinct spine document SEEN, parsed or not.
   *
   * Apart from `docIndexOfFile` because the two answer different questions once
   * a walk may be narrowed: this one dedupes the spine and numbers it, and that
   * numbering has to count the documents this walk skipped or a narrowed walk
   * would report a different spine position for the same document.
   */
  const spineIndexOf = new Map<string, number>();

  try {
    const structure = await processor.open(epubSourcePath);

    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      // A spine document listed twice is ONE file: it is read, numbered and
      // enumerated once, exactly as the narration writer treats it.
      if (spineIndexOf.has(entryName)) continue;
      const docIndex = spineIndexOf.size;
      spineIndexOf.set(entryName, docIndex);
      if (only !== undefined && !only.has(entryName)) continue;
      docIndexOfFile.set(entryName, docIndex);
      const xhtml = await processor.readFile(entryName);
      const { doc, body } = parseXhtmlBody(xhtml, entryName);
      let indexInFile = 0;
      for (const c of collectExportUnits(doc, body, entryName)) {
        units.push({
          file: entryName,
          key: narrationElementKey(entryName, indexInFile++),
          tag: c.tag,
          el: c.el,
          normText: c.normText,
          streamStart: -1,
          streamEnd: -1,
          imageOnly: c.imageOnly,
          fromCatchAll: c.fromCatchAll,
        });
      }
      // The picture enumeration, in its own namespace and after the unit walk —
      // the unit collector MOVES stray runs into synthesized wrappers, and the
      // image ordinals must be read off the tree the narration writer will walk.
      collectImageElements(body).forEach((el, ordinal) => {
        imageUnits.push({
          file: entryName,
          docIndex,
          key: narrationImageElementKey(entryName, ordinal),
          el,
        });
      });
      const imgs = body.getElementsByTagName('img');
      for (let i = 0; i < imgs.length; i++) {
        const alt = imgs[i].getAttribute('alt');
        // No alt (or empty alt) → mupdf's default label is "image".
        imgAltNorms.add(normalizeForAlignment(`[${alt || 'image'}]`));
      }
      // SVG <image> elements (cover wraps) get the same default label.
      if (body.getElementsByTagName('image').length > 0) {
        imgAltNorms.add('[image]');
      }
    }
  } finally {
    processor.close();
  }

  return { units, imageUnits, docIndexOfFile, imgAltNorms };
}

/**
 * Map picker blocks onto the source EPUB's own elements by sequential text
 * alignment. Never throws on a block that merely fails to match — those are
 * reported in `unaligned` and POLICY (what is tolerable) belongs to the
 * exporter. It does throw on structural failures: unreadable/unparseable spine
 * sections and stray text the unit collector cannot attribute, because no
 * alignment over that book can be trusted.
 *
 * NOT on the EPUB ANALYSIS path any more. Analysis routes through quire, which
 * reports the caller's own element key on every block, so there is nothing to
 * match. This is still what the PRESERVING EXPORTER
 * (`exportEpubPreservingMarkup`) uses, because that one is handed the picker's
 * edited blocks and has to find them in the markup — and it is still what the
 * three block-keyed readers below use, which the tests drive directly.
 */
export async function alignBlocksToEpub(
  epubSourcePath: string,
  blocks: EpubExportBlock[],
): Promise<EpubAlignmentResult> {
  const { units, imageUnits, docIndexOfFile, imgAltNorms } =
    await walkEpubElements(epubSourcePath);

  // Stream S: concatenated normalized text of all non-image units, spine order.
  let stream = '';
  const streamOrder: number[] = []; // unit indices participating in S, ascending
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.imageOnly || u.normText.length === 0) continue;
    u.streamStart = stream.length;
    stream += u.normText;
    u.streamEnd = stream.length;
    streamOrder.push(i);
  }

  /** Unit indices whose [streamStart, streamEnd) overlaps [start, end). */
  const unitsOverlapping = (start: number, end: number): number[] => {
    // Binary search: first stream unit with streamEnd > start.
    let lo = 0;
    let hi = streamOrder.length - 1;
    let first = streamOrder.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (units[streamOrder[mid]].streamEnd > start) { first = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    const covering: number[] = [];
    for (let i = first; i < streamOrder.length && units[streamOrder[i]].streamStart < end; i++) {
      covering.push(streamOrder[i]);
    }
    return covering;
  };

  const sorted = [...blocks].sort((a, b) => (a.page !== b.page ? a.page - b.page : a.y - b.y));

  const blockToUnits = new Map<string, number[]>();
  const unaligned: EpubAlignmentResult['unaligned'] = [];
  let cursor = 0;
  let lastMatchedUnit = -1; // units[] index of the last unit of the previous match

  type NormMatch =
    | { kind: 'range'; start: number; end: number }
    | { kind: 'contained'; unit: number }
    | { kind: 'fail'; reason: string };

  /**
   * Match one normalized block text against the stream at/after the cursor.
   *  d.  tiny blocks: exact at cursor, or containment in the unit spanning the
   *      cursor / the previously matched unit (containment attributes WITHOUT
   *      moving the cursor — a drop-cap block can sort after its continuation).
   *  a.  exact at cursor.
   *  b.  exact within the gap window.
   *  c0. fuzzy AT the cursor (banded Levenshtein) — catches divergence near
   *      the block START, where the anchor of rule c is itself corrupted
   *      (e.g. nav counters and display:none colons in TOC entries).
   *  c.  bounded fuzzy resync: exact anchor prefix, banded verification.
   */
  const matchNormText = (norm: string): NormMatch => {
    if (norm.length < ALIGN_TINY_LEN) {
      if (stream.startsWith(norm, cursor)) {
        return { kind: 'range', start: cursor, end: cursor + norm.length };
      }
      const spanning = unitsOverlapping(cursor, cursor + 1);
      if (spanning.length === 1 && units[spanning[0]].normText.includes(norm)) {
        return { kind: 'contained', unit: spanning[0] };
      }
      if (lastMatchedUnit >= 0 && units[lastMatchedUnit].normText.includes(norm)) {
        return { kind: 'contained', unit: lastMatchedUnit };
      }
      return {
        kind: 'fail',
        reason: `tiny block (${norm.length} normalized chars) neither at the cursor nor contained in the current/previous element`,
      };
    }

    if (stream.startsWith(norm, cursor)) {
      return { kind: 'range', start: cursor, end: cursor + norm.length };
    }

    const at = stream.indexOf(norm, cursor);
    if (at !== -1 && at <= cursor + ALIGN_GAP_WINDOW) {
      return { kind: 'range', start: at, end: at + norm.length };
    }

    const tolerance = Math.max(3, Math.ceil(0.02 * norm.length));
    const atCursorEnd = bandedLevenshteinMatchEnd(norm, stream, cursor, tolerance);
    if (atCursorEnd >= 0) {
      return { kind: 'range', start: cursor, end: atCursorEnd };
    }

    const anchor = norm.slice(0, ALIGN_ANCHOR_LEN);
    let searchFrom = cursor;
    let sawAnchor = false;
    while (true) {
      const occ = stream.indexOf(anchor, searchFrom);
      if (occ === -1 || occ > cursor + ALIGN_GAP_WINDOW) break;
      sawAnchor = true;
      const matchEnd = bandedLevenshteinMatchEnd(norm, stream, occ, tolerance);
      if (matchEnd >= 0) {
        return { kind: 'range', start: occ, end: matchEnd };
      }
      /*
       * c2. The clipped-line bridge. mupdf's layout DROPS characters when an
       * unbreakable token overflows the column: Killing America's CDC citation
       * renders as `…%2Fvaccines%2Fco` ⏎ `by-product%2F…` — fourteen characters
       * of the URL (`vid-19%2Finfo-`) simply do not exist in the laid-out text,
       * measured against the markup, which carries the whole thing. Levenshtein
       * sees a 14-edit hole against a tolerance of 5 and rightly refuses; the
       * block then has no element key and the one line of a book a user least
       * wants narrated — a bare URL — becomes the one line they cannot strike.
       *
       * The bridge demands MORE positional evidence than the fuzzy rule it
       * follows, not less: the block's head already matched exactly (that is
       * the anchor that got us here), its TAIL must also match exactly, and the
       * two may only stand further apart than the block's own length by the
       * bounded clip allowance. Forty-eight exact characters bracketing a hole
       * of at most ALIGN_CLIP_MAX is not a coincidence any book supplies twice;
       * a tolerance of 20 would be.
       *
       * The matched range includes the dropped characters — they are part of
       * the element the block was laid out from, which is what a strike names.
       */
      if (norm.length >= ALIGN_ANCHOR_LEN * 3) {
        const tail = norm.slice(-ALIGN_ANCHOR_LEN);
        const tailFrom = occ + norm.length - ALIGN_ANCHOR_LEN * 2;
        const tailAt = stream.indexOf(tail, Math.max(occ + ALIGN_ANCHOR_LEN, tailFrom));
        if (tailAt !== -1) {
          const end = tailAt + tail.length;
          const stretch = end - occ - norm.length;
          if (stretch >= 0 && stretch <= ALIGN_CLIP_MAX) {
            return { kind: 'range', start: occ, end };
          }
        }
      }
      searchFrom = occ + 1;
    }
    return {
      kind: 'fail',
      reason: sawAnchor
        ? `anchor found but full text failed fuzzy verification (tolerance ${tolerance})`
        : `no exact or anchor match within ${ALIGN_GAP_WINDOW} chars of the cursor`,
    };
  };

  /** The image blocks, held back for the ordinal matcher below. */
  const imageBlocks: EpubExportBlock[] = [];

  for (const b of sorted) {
    // Footnote markers DUPLICATE their parent block's text in the analyzer
    // output — aligning them would double-count. Images have no text at all, so
    // this loop cannot place them; they are matched to image ELEMENTS after it,
    // by document and ordinal, using the text placements as their bounds.
    if (b.isImage) { imageBlocks.push(b); continue; }
    if (b.isFootnoteMarker) continue;
    const norm = normalizeForAlignment(b.text);
    if (norm.length === 0) continue;

    let match = matchNormText(norm);

    if (match.kind === 'fail') {
      // Image alt-text furniture: mupdf laid out "[<alt>]" for an image it did
      // not draw. That text exists in no DOM text node — skip like an image
      // block (the element itself is an image unit and is dropped on export).
      if (imgAltNorms.has(norm)) continue;

      // List-marker retry: strip ONE leading synthesized counter/bullet.
      const stripped = b.text.replace(LIST_MARKER_PREFIX, '');
      if (stripped !== b.text) {
        const strippedNorm = normalizeForAlignment(stripped);
        if (strippedNorm.length === 0) continue; // the block WAS the marker — pure furniture
        match = matchNormText(strippedNorm);
      }
    }

    if (match.kind === 'fail') {
      // Last retry: strip marker tokens EVERYWHERE — mupdf merges whole nav
      // TOCs / bullet lists into one block, interleaving synthesized counters
      // through the text.
      const strippedAll = b.text.replace(LIST_MARKER_ANYWHERE, '$1');
      if (strippedAll !== b.text) {
        const strippedNorm = normalizeForAlignment(strippedAll);
        if (strippedNorm.length === 0) continue; // nothing but markers — pure furniture
        match = matchNormText(strippedNorm);
      }
    }

    if (match.kind === 'fail') {
      unaligned.push({ blockId: b.id, page: b.page, excerpt: b.text.slice(0, 80), reason: match.reason });
      continue;
    }
    if (match.kind === 'contained') {
      blockToUnits.set(b.id, [match.unit]);
      continue;
    }
    const covering = unitsOverlapping(match.start, match.end);
    blockToUnits.set(b.id, covering);
    if (covering.length > 0) lastMatchedUnit = covering[covering.length - 1];
    cursor = match.end; // start >= cursor always, so the cursor never moves backward
  }

  const coveredUnits = new Set<number>();
  for (const idxs of blockToUnits.values()) {
    for (const i of idxs) coveredUnits.add(i);
  }
  const uncoveredUnits = streamOrder.filter((i) => !coveredUnits.has(i));

  // The pictures. A block's document is the document of the unit its text
  // begins in — the same first-unit tiebreak all three readers use.
  const docIndexOfBlock = new Map<string, number>();
  for (const [blockId, unitIndices] of blockToUnits) {
    if (unitIndices.length === 0) continue;
    const doc = docIndexOfFile.get(units[unitIndices[0]].file);
    if (doc !== undefined) docIndexOfBlock.set(blockId, doc);
  }
  const { blockToImageUnit, unmatched: unmatchedImages } = alignImageBlocks(
    imageUnits, imageBlocks, docIndexOfBlock, sorted, docIndexOfFile.size);

  return {
    units, blockToUnits, unaligned, uncoveredUnits,
    imageUnits, blockToImageUnit, unmatchedImages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — reading back the record the pipeline stamped into its own book
//
// Reflow knows exactly what it wrote: it turned a chapter block into an <h1> and
// a body group into a <p>, and since foundry 86c59bc every element it emits
// carries that knowledge as three data attributes. Anyone handed the finished
// EPUB afterwards can only guess the categories back from how the text looks —
// and that guess is wrong precisely where it matters, on every chapter opening
// not literally titled "Chapter N", which mupdf hands back as large type and the
// analyzer therefore calls a `title`.
//
// So: don't guess, read. The one thing standing between the laid-out block and
// its element is that mupdf's reflow throws the DOM away — and mapping blocks
// back onto the source elements is exactly what `alignBlocksToEpub` above
// already does for the preserving exporter. This reuses it rather than growing a
// second matcher: one aligner, one set of alignment rules, nothing to drift.
// ─────────────────────────────────────────────────────────────────────────────

/** The attributes foundry's EPUB emitter stamps on every element it writes. */
export const PROVENANCE_CATEGORY_ATTR = 'data-bf-category';
export const PROVENANCE_GROUP_ATTR = 'data-bf-group';
export const PROVENANCE_BLOCKS_ATTR = 'data-bf-blocks';

/** One element's stamp, as read off the markup. */
export interface EpubBlockProvenance {
  /** `data-bf-category` — a member of the one palette, verbatim. */
  category: string;
  /** `data-bf-group` — the paragraph group the element was rendered from. */
  group: string;
  /** `data-bf-blocks`, split on whitespace — the working PDF's own block ids. */
  sourceBlockIds: string[];
}

export interface EpubProvenanceReading {
  /**
   * True when the book carries stamps at all — i.e. our reflow wrote it. False
   * is a different INPUT CLASS (a book from elsewhere), not a failure: there is
   * no record to read, so `byBlockId` is empty and the caller classifies.
   */
  stamped: boolean;
  /** Block id → the stamp of the element it was laid out from. */
  byBlockId: Map<string, EpubBlockProvenance>;
  /**
   * Block id → the positional key of the element it was laid out from.
   *
   * EVERY aligned block has one, stamped or not: the key is a fact about the
   * book's markup and the aligner's traversal, not about what any emitter wrote
   * into it. It is the identity a narration strike is recorded as
   * (shared/vlm/narration-deletions.ts), so a block missing from here is a block
   * the user can strike through on screen while nothing is recorded.
   */
  elementByBlockId: Map<string, NarrationElementKey>;
  /** Blocks aligned to an element carrying no stamp (nav TOC, hand-added markup). */
  alignedToUnstampedElement: number;
  /** Blocks the aligner could not place in the source markup at all, and why. */
  unaligned: UnalignedBlock[];
  /** Image blocks the ordinal matcher refused to pair, and why. */
  unmatchedImages: UnalignedBlock[];
  /**
   * Blocks whose text spanned SEVERAL source elements. Their category is the
   * first one's — the element the block's text begins in — because a block that
   * runs across an element boundary has no single answer and reading order is
   * the only non-arbitrary tiebreak. Counted so it cannot happen invisibly.
   */
  spanningElements: number;
}

/**
 * Does this EPUB carry provenance stamps? A raw substring test over the spine
 * documents, deliberately: it is the class test, it runs before any parsing or
 * alignment, and a book from elsewhere must not pay for a lookup that can only
 * come back empty.
 */
export async function epubCarriesProvenance(epubSourcePath: string): Promise<boolean> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(epubSourcePath);
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      const xhtml = await processor.readFile(entryName);
      if (xhtml.includes(PROVENANCE_CATEGORY_ATTR)) return true;
    }
    return false;
  } finally {
    processor.close();
  }
}

/**
 * The stamp on an element or on the nearest ancestor that has one.
 *
 * Foundry writes the stamp on the OUTERMOST element of a group — the `<ul>` and
 * not each `<li>`, the `<blockquote>` and not the `<p>` inside it — while the
 * unit collector picks whichever of those it treats as a block. Walking up
 * covers both without either side having to know the other's tag list. A group
 * is one element, so at most one ancestor can carry a stamp; there is nothing to
 * choose between.
 *
 * A partial stamp is a broken writer, not a missing value: foundry emits all
 * three attributes in one expression or none of them.
 */
function provenanceOnOrAbove(el: any, whatFor: string): EpubBlockProvenance | null {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    if (typeof node.getAttribute !== 'function') break;
    const category = node.getAttribute(PROVENANCE_CATEGORY_ATTR);
    if (category === null || category === '') continue;
    const group = node.getAttribute(PROVENANCE_GROUP_ATTR);
    const blocks = node.getAttribute(PROVENANCE_BLOCKS_ATTR);
    if (group === null || group === '' || blocks === null || blocks === '') {
      throw new Error(
        `${whatFor}: a <${node.tagName}> carries ${PROVENANCE_CATEGORY_ATTR}="${category}" but not `
        + `both ${PROVENANCE_GROUP_ATTR} and ${PROVENANCE_BLOCKS_ATTR} `
        + `(group=${JSON.stringify(group)}, blocks=${JSON.stringify(blocks)}). `
        + `The three are written together; a partial stamp means the book was written by `
        + `something other than foundry's EPUB emitter.`,
      );
    }
    return {
      category,
      group,
      sourceBlockIds: blocks.split(/\s+/).filter((id: string) => id.length > 0),
    };
  }
  return null;
}

/**
 * Read each laid-out block's category, group and source block ids off the EPUB
 * element it came from.
 *
 * `blocks` are the picker's blocks in the aligner's own input shape; at analysis
 * time nothing is deleted yet, so callers pass `deleted: false` throughout.
 *
 * A stamped value outside the ONE palette (`shared/ocr/block-categories.ts`) is
 * a disagreement between foundry and BookForge about what a category IS, and it
 * throws naming the value — dropping it would leave the block silently wearing
 * the heuristic's guess while the book plainly states otherwise. The palette is
 * imported rather than passed in: a caller free to supply its own list is a
 * second palette waiting to happen.
 */
export async function readEpubBlockProvenance(
  epubSourcePath: string,
  blocks: EpubExportBlock[],
): Promise<EpubProvenanceReading> {
  const empty: EpubProvenanceReading = {
    stamped: false,
    byBlockId: new Map(),
    elementByBlockId: new Map(),
    alignedToUnstampedElement: 0,
    unaligned: [],
    unmatchedImages: [],
    spanningElements: 0,
  };
  // An unstamped book is not read here at all, and it does not need to be: the
  // caller asks the CONVERSION reader next, and that one aligns every EPUB and
  // answers the element keys whether or not it finds a stamp.
  if (!(await epubCarriesProvenance(epubSourcePath))) return empty;

  const legal = new Set<string>(BLOCK_CATEGORY_IDS);
  const whatFor = `EPUB provenance in ${path.basename(epubSourcePath)}`;
  const {
    units, blockToUnits, unaligned, imageUnits, blockToImageUnit, unmatchedImages,
  } = await alignBlocksToEpub(epubSourcePath, blocks);

  // One element serves many blocks; resolve each unit's stamp once.
  const stampByUnit = new Map<number, EpubBlockProvenance | null>();
  const stampFor = (unitIndex: number): EpubBlockProvenance | null => {
    if (stampByUnit.has(unitIndex)) return stampByUnit.get(unitIndex)!;
    const stamp = provenanceOnOrAbove(units[unitIndex].el, whatFor);
    if (stamp !== null && !legal.has(stamp.category)) {
      throw new Error(
        `${whatFor}: element <${units[unitIndex].tag}> in ${units[unitIndex].file} is stamped `
        + `${PROVENANCE_CATEGORY_ATTR}="${stamp.category}" (group ${stamp.group}), which is not a `
        + `block category BookForge knows. The palette is shared/ocr/block-categories.ts: `
        + `${BLOCK_CATEGORY_IDS.join(', ')}.`,
      );
    }
    stampByUnit.set(unitIndex, stamp);
    return stamp;
  };

  const byBlockId = new Map<string, EpubBlockProvenance>();
  const elementByBlockId = new Map<string, NarrationElementKey>();
  let alignedToUnstampedElement = 0;
  let spanningElements = 0;
  for (const [blockId, unitIndices] of blockToUnits) {
    if (unitIndices.length === 0) {
      // The aligner matched the text but it overlapped no unit — impossible for
      // a range built out of unit extents, so say so rather than absorb it.
      throw new Error(`${whatFor}: block ${blockId} aligned to zero source elements — this is a bug.`);
    }
    if (unitIndices.length > 1) spanningElements++;
    // The element key first, and unconditionally: it is where the block CAME
    // FROM, which is true of a nav-TOC entry nothing stamped exactly as it is
    // true of a stamped paragraph.
    elementByBlockId.set(blockId, units[unitIndices[0]].key);
    const stamp = stampFor(unitIndices[0]);
    if (stamp === null) alignedToUnstampedElement++;
    else byBlockId.set(blockId, stamp);
  }
  // The pictures, through the same join. An image block's key is the only thing
  // that lets it be struck out of the narration copy; its CATEGORY still comes
  // from the block's own `is_image` flag, so nothing is read off the stamp here.
  for (const [blockId, imageIndex] of blockToImageUnit) {
    elementByBlockId.set(blockId, imageUnits[imageIndex].key);
  }

  return {
    stamped: true,
    byBlockId,
    elementByBlockId,
    alignedToUnstampedElement,
    unaligned,
    unmatchedImages,
    spanningElements,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The OTHER stamp: a book a document vision model read
//
// `foundry vlm-convert` writes a book from page pictures rather than from a
// working PDF, so it has no working-PDF block ids and no paragraph groups to
// stamp. What it CAN say is what the model called each block and which page it
// was read from, and it says it as `data-bf-cat` and `data-bf-page` (foundry
// README §vlm-convert).
//
// Same job as the provenance reader above — don't guess the categories back out
// of type size, read the book's own record — and the same aligner, deliberately:
// one traversal of a book's elements, so a unit index means one thing.
// ─────────────────────────────────────────────────────────────────────────────

export const CONVERSION_CATEGORY_ATTR = 'data-bf-cat';
export const CONVERSION_PAGE_ATTR = 'data-bf-page';

/** One element's conversion stamp, as read off the markup. */
export interface EpubConversionStamp {
  /** The BookForge palette id, translated from `data-bf-cat`. */
  category: string;
  /** `data-bf-cat` verbatim — the model's own word for it. */
  statedCategory: string;
  /** `data-bf-page` — the PDF page this element was read from. */
  sourcePage: number;
  /** The element's positional key, for the narration deletions. */
  element: NarrationElementKey;
}

export interface EpubConversionReading {
  /** True when the book carries conversion stamps — i.e. vlm-convert wrote it. */
  converted: boolean;
  /** Block id → the stamp of the element it was laid out from. Stamped books only. */
  byBlockId: Map<string, EpubConversionStamp>;
  /**
   * Block id → the positional key of the element it was laid out from.
   *
   * Filled for EVERY aligned block of EVERY EPUB — see the reading below for
   * why that is not the same question as `converted`.
   */
  elementByBlockId: Map<string, NarrationElementKey>;
  /** Blocks aligned to an element carrying no stamp (nav TOC, hand-added markup). */
  alignedToUnstampedElement: number;
  /** Blocks the aligner could not place in the source markup at all, and why. */
  unaligned: UnalignedBlock[];
  /** Image blocks the ordinal matcher refused to pair, and why. */
  unmatchedImages: UnalignedBlock[];
}

/**
 * Does this EPUB carry conversion stamps?
 *
 * The test is `data-bf-cat="` WITH the quote, and that is not fussiness: a
 * reflowed book's `data-bf-category="` starts with the same eleven characters,
 * and a bare substring test would read every reflowed book as a converted one.
 */
export async function epubCarriesConversionStamps(epubSourcePath: string): Promise<boolean> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(epubSourcePath);
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      const xhtml = await processor.readFile(entryName);
      if (xhtml.includes(`${CONVERSION_CATEGORY_ATTR}="`)) return true;
    }
    return false;
  } finally {
    processor.close();
  }
}

/**
 * The conversion stamp on an element or on the nearest ancestor that has one.
 *
 * Walks up for the same reason the provenance reader does: foundry stamps the
 * outermost element of a group (the `<ul>`, not each `<li>`), while the unit
 * collector may pick either.
 *
 * A category with no page — or a page that is not a number — is a broken writer
 * rather than a missing value: foundry emits the pair in one expression.
 */
function conversionStampOnOrAbove(el: any, whatFor: string): {
  category: string;
  statedCategory: string;
  sourcePage: number;
} | null {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    if (typeof node.getAttribute !== 'function') break;
    const stated = node.getAttribute(CONVERSION_CATEGORY_ATTR);
    if (stated === null || stated === '') continue;
    const page = node.getAttribute(CONVERSION_PAGE_ATTR);
    const pageNumber = page === null ? NaN : Number(page);
    if (!Number.isInteger(pageNumber)) {
      throw new Error(
        `${whatFor}: a <${node.tagName}> carries ${CONVERSION_CATEGORY_ATTR}="${stated}" but `
        + `${CONVERSION_PAGE_ATTR}=${JSON.stringify(page)}, which is not a page number. The two are `
        + 'written together by foundry\'s vlm-convert emitter; a partial stamp means the book was '
        + 'written by something else.'
      );
    }
    return {
      category: blockCategoryForVlm(stated, whatFor),
      statedCategory: stated,
      sourcePage: pageNumber,
    };
  }
  return null;
}

/**
 * Every stamped element of a converted book, in the book's own order.
 *
 * This is what the narration writer plans against and what tells a caller
 * whether a book is a conversion at all. It reads the SAME unit list the block
 * aligner builds — `alignBlocksToEpub` with no blocks, which does the traversal
 * and aligns nothing — so a key here and a key on a block are the same key.
 */
export async function readEpubConversionUnits(epubSourcePath: string): Promise<NarrationUnit[]> {
  const whatFor = `conversion stamps in ${path.basename(epubSourcePath)}`;
  const { units, imageUnits } = await alignBlocksToEpub(epubSourcePath, []);
  const read = (el: any, key: NarrationElementKey, text: string): NarrationUnit => {
    const stamp = conversionStampOnOrAbove(el, whatFor);
    return {
      key,
      category: stamp?.statedCategory ?? null,
      sourcePage: stamp?.sourcePage ?? null,
      text,
    };
  };
  // Text elements, then pictures. The PICTURES ARE IN HERE because this list is
  // what the narration plan is checked against (`planNarrationRemoval`), and a
  // key the list does not hold stops the export by name — so leaving images out
  // would turn every image strike into a refusal to write the copy at all.
  // Order between the two namespaces is not meaningful: nothing indexes into
  // this list, every reader looks a key up in it.
  return [
    ...units.map((u) => read(u.el, u.key, getUnitTextContent(u.el))),
    // A picture says nothing, and `''` is that answer rather than a missing one
    // — image keys are not fingerprinted, exactly because there is no text.
    ...imageUnits.map((u) => read(u.el, u.key, '')),
  ];
}

/**
 * Read each laid-out block's element key — and, when the book states them, its
 * category and source page — off the book's own markup.
 *
 * ── The ALIGNER RUNS FOR EVERY EPUB, and that is the point ──────────────────
 *
 * The categories and the page numbers are a converted book's own record, and a
 * book with no stamps has none: `converted: false`, an empty `byBlockId`, a
 * different INPUT CLASS rather than a failure, exactly as with the reflow
 * provenance above.
 *
 * The ELEMENT KEY is not that. It is where the block came from — a zip entry and
 * a position in the aligner's traversal — and every EPUB has one for every block
 * it laid out, whoever wrote the book. Reading it only for stamped books is what
 * this used to do, by returning before the aligner ever ran, and it broke
 * striking for narration on every publisher EPUB: the picker enables the gesture
 * on any book on screen (`canStrikeForNarration`), the user strikes a paragraph,
 * the strike derivation skips every block with no `element`, and NOTHING is
 * recorded — silently, looking exactly like it worked. So the gate is now only
 * on what it can honestly gate: the stamps.
 */
export async function readEpubConversionStamps(
  epubSourcePath: string,
  blocks: EpubExportBlock[],
): Promise<EpubConversionReading> {
  const converted = await epubCarriesConversionStamps(epubSourcePath);
  const whatFor = `conversion stamps in ${path.basename(epubSourcePath)}`;
  const {
    units, blockToUnits, unaligned, imageUnits, blockToImageUnit, unmatchedImages,
  } = await alignBlocksToEpub(epubSourcePath, blocks);

  const stampByUnit = new Map<number, EpubConversionStamp | null>();
  const stampFor = (unitIndex: number): EpubConversionStamp | null => {
    if (stampByUnit.has(unitIndex)) return stampByUnit.get(unitIndex)!;
    const read = conversionStampOnOrAbove(units[unitIndex].el, whatFor);
    const stamp: EpubConversionStamp | null = read === null ? null : {
      ...read,
      element: units[unitIndex].key,
    };
    stampByUnit.set(unitIndex, stamp);
    return stamp;
  };

  const byBlockId = new Map<string, EpubConversionStamp>();
  const elementByBlockId = new Map<string, NarrationElementKey>();
  let alignedToUnstampedElement = 0;
  for (const [blockId, unitIndices] of blockToUnits) {
    if (unitIndices.length === 0) {
      throw new Error(`${whatFor}: block ${blockId} aligned to zero source elements — this is a bug.`);
    }
    // A block that spans several elements takes the FIRST one's, which is the
    // element its text begins in — the same tiebreak the provenance reader uses,
    // and the only non-arbitrary one when reading order is all there is.
    elementByBlockId.set(blockId, units[unitIndices[0]].key);
    if (!converted) continue;
    const stamp = stampFor(unitIndices[0]);
    if (stamp === null) alignedToUnstampedElement++;
    else byBlockId.set(blockId, stamp);
  }
  // The pictures. A converted book stamps them like everything else — foundry
  // writes `data-bf-cat="picture"` on the element it puts the `<img>` inside —
  // so an image block gets both its key and the model's own word for it.
  for (const [blockId, imageIndex] of blockToImageUnit) {
    const unit = imageUnits[imageIndex];
    elementByBlockId.set(blockId, unit.key);
    if (!converted) continue;
    const read = conversionStampOnOrAbove(unit.el, whatFor);
    if (read === null) continue;
    byBlockId.set(blockId, { ...read, element: unit.key });
  }

  return {
    converted,
    byBlockId,
    elementByBlockId,
    alignedToUnstampedElement,
    unaligned,
    unmatchedImages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The stamp the USER writes: a relabel, in the book
//
// ── Why the book and not the picker ────────────────────────────────────────
//
// Owen, 2026-08-10, after promoting a `title` to `chapter` in the picker and
// finding the naming pass would not name it: "it apparently didnt actually
// change it to chapter, just visually?" It had not. The relabel was recorded in
// the picker's editor state (`categoryCorrections`), which is a record about a
// SESSION, and every real derivation — the naming pass that re-runs at every
// project open, the chapter recovery, the narration cut, the exporters — reads
// the BOOK. So the book still said `title` and the overlay was invisible
// everywhere it mattered.
//
// A category change on a book block is therefore an EDIT OF THE BOOK, and this
// attribute is where it lands. One authority, one derivation, exactly as a
// chapter's name lives in the table of contents and nowhere else
// (electron/book-chapters.ts).
//
// ── Why a THIRD attribute rather than rewriting the book's own stamp ───────
//
// Because the two existing stamps are the book's record of what WROTE it, and
// neither can carry a user's correction without lying or breaking:
//
//  - `data-bf-category` is written with `data-bf-group` and `data-bf-blocks` in
//    one expression, and `provenanceOnOrAbove` THROWS on a partial stamp — so a
//    publisher's EPUB cannot be given one (there is no group and no working-PDF
//    block to name). Worse, `epubCarriesProvenance` is a raw substring test over
//    the spine, so a single stamped element would re-class the WHOLE book as a
//    reflow of ours and leave every other element with no category at all.
//  - `data-bf-cat` is dots' own word for what it saw, in dots' vocabulary. Four
//    of BookForge's thirteen classes (`subheading`, `header`, `footer`,
//    `discard`) have no spelling in it, and overwriting it would launder a
//    person's correction as the model's answer — destroying the one record that
//    says what the model actually read.
//
// So the user's statement gets its own attribute, in the ONE palette's
// vocabulary, and it OUTRANKS both stamps and the markup wherever a category is
// read. It is additive: the book's own record of what wrote it survives
// untouched beside it, which is what makes the edit reversible and auditable.
// The name shares no prefix with either stamp on purpose — `data-bf-user-cat`
// contains neither `data-bf-category` nor `data-bf-cat="`, so neither class test
// can mistake an override for the thing it is testing for.
// ─────────────────────────────────────────────────────────────────────────────

/** The attribute a user's relabel of a book element is written as. */
export const USER_CATEGORY_ATTR = 'data-bf-user-cat';

/**
 * What the USER says this element is, or null when they have said nothing.
 *
 * Read off the element ITSELF and never off an ancestor, which is the one place
 * it differs from the two stamp readers. They walk up because foundry stamps the
 * outermost element of a group while the unit collector may pick either; this is
 * written by `setElementCategoryInBookFile` onto the very element the unit
 * collector picked, resolved through the same walk. An ancestor search could
 * only find an override meant for a DIFFERENT element and spread it to its
 * neighbours.
 *
 * A value outside the one palette is a book edited by something that does not
 * share BookForge's vocabulary, and it throws naming the value — the same rule
 * `provenanceOnOrAbove` follows, and for the same reason: painting it as body
 * text would hide the disagreement behind a plausible screen.
 */
export function userCategoryOf(el: any, whatFor: string): string | null {
  if (el === null || el === undefined || el.nodeType !== 1) return null;
  if (typeof el.getAttribute !== 'function') return null;
  const stated = el.getAttribute(USER_CATEGORY_ATTR);
  if (stated === null || stated === '') return null;
  if (!BLOCK_CATEGORY_IDS.includes(stated)) {
    throw new Error(
      `${whatFor}: a <${el.tagName}> carries ${USER_CATEGORY_ATTR}="${stated}", which is not a `
      + `block category BookForge knows. The palette is shared/ocr/block-categories.ts: `
      + `${BLOCK_CATEGORY_IDS.join(', ')}.`,
    );
  }
  return stated;
}

// ─────────────────────────────────────────────────────────────────────────────
// The THIRD reading: a publisher's EPUB, which states its structure in the only
// place it has — its own markup
//
// Both readers above ask a book what OUR pipeline wrote into it. A book from a
// publisher was never written by us and carries neither stamp, so until now it
// fell all the way through to `classifyBlock` — a classifier written for SCANNED
// PAGES, which decides `header` and `footer` from where a block sits on the
// paper. An EPUB has no paper. mupdf reflows it onto pages of its own invention,
// so "this block is in the bottom tenth of the page" is a fact about the reflow
// window and about nothing else. Measured on Killing America (Harrison House,
// 2024): ordinary prose came back `footer`, and the chapter openings came back
// as an assortment of `title`, `heading` and `body` depending on how the reflow
// happened to break the page.
//
// But a publisher's EPUB is not silent. It says a great deal, in the vocabulary
// XHTML and EPUB give it:
//
//   - `<h1>`…`<h6>` are headings, `<blockquote>` is a quotation, `<figcaption>`
//     is a caption, `<ul>`/`<ol>`/`<dl>` are entry-per-line lists, `<table>` is
//     a table.
//   - `epub:type` (and the ARIA `role` that mirrors it) names notes outright.
//   - LINK TOPOLOGY names them even where `epub:type` does not: a `<sup>` around
//     an `<a href="#fn-7">` is a note reference, and the element carrying
//     `id="fn-7"` is the note it points at. Killing America carries 640 of those
//     and not one `epub:type`.
//   - The TABLE OF CONTENTS — the EPUB 3 nav document or the EPUB 2 `toc.ncx`
//     navMap — names which documents open a chapter, and what the book calls it.
//
// None of that is a guess and none of it is positional. This reader joins it to
// the laid-out blocks through the SAME aligner the other two readers use, so a
// unit index means one thing across all three.
//
// A plain `<p>` comes back `body`, and that is a STATE rather than a fallback:
// an unadorned paragraph in a book's markup is body text, which is why the
// markup does not adorn it.
// ─────────────────────────────────────────────────────────────────────────────

/** One entry of a book's own table of contents, resolved onto the archive. */
export interface EpubTocTarget {
  /**
   * Candidate zip entry names for the document the entry points at, best first.
   * More than one because an href may or may not be percent-encoded and the
   * archive may hold either spelling — the caller picks whichever it actually
   * has units for, exactly as `EpubProcessor.resolvePath` picks whichever the
   * archive actually holds.
   */
  entryCandidates: string[];
  /** The fragment after `#`, or null when the entry names the whole document. */
  fragment: string | null;
  /** The navigation label — what the book calls this chapter. */
  label: string;
}

/**
 * An href that is not percent-encoded decodes to itself; `decodeURIComponent`
 * throws on a lone `%` instead of saying so. Both spellings are kept as
 * candidates by the caller, so this never has to be right on its own.
 */
function decodeHrefPart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolve one navigation href against the document it was written in. */
function tocTargetForHref(href: string, baseDir: string, label: string): EpubTocTarget | null {
  // An absolute URI leaves the book — a nav may link to the publisher's site.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null;
  const hashAt = href.indexOf('#');
  const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
  const rawFragment = hashAt === -1 ? '' : href.slice(hashAt + 1);
  // `#frag` alone points inside the navigation document itself, which is not a
  // chapter of the book.
  if (rawPath === '') return null;
  const join = (p: string) => normalizeZipEntryName(baseDir ? `${baseDir}/${p}` : p);
  const decoded = decodeHrefPart(rawPath);
  const entryCandidates = decoded === rawPath ? [join(rawPath)] : [join(decoded), join(rawPath)];
  return {
    entryCandidates,
    fragment: rawFragment === '' ? null : decodeHrefPart(rawFragment),
    label,
  };
}

/** The directory of a zip entry, '' when it sits at the archive root. */
function zipEntryDir(entry: string): string {
  const at = entry.lastIndexOf('/');
  return at === -1 ? '' : entry.slice(0, at);
}

/** `epub:type` / ARIA `role` tokens on one element, lower-cased. */
function structureTokens(node: any): string[] {
  if (typeof node.getAttribute !== 'function') return [];
  const values = [
    node.getAttribute('epub:type'),
    typeof node.getAttributeNS === 'function'
      ? node.getAttributeNS('http://www.idpf.org/2007/ops', 'type')
      : null,
    node.getAttribute('role'),
  ];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || v === '') continue;
    for (const token of v.trim().toLowerCase().split(/\s+/)) {
      // `role="doc-footnote"` says the same thing `epub:type="footnote"` does.
      out.push(token.startsWith('doc-') ? token.slice(4) : token);
    }
  }
  return out;
}

// The `epub:type` values that make an element a note, on the element itself or
// on the section/aside that holds it. The plurals are the container forms
// (`<section epub:type="endnotes">`), which is where books that type anything at
// all usually type it.
const EPUB_TYPE_NOTE = new Set([
  'footnote', 'footnotes', 'endnote', 'endnotes', 'rearnote', 'rearnotes', 'note', 'notes',
]);

const MARKUP_HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// What a note REFERENCE looks like when the book does not say `epub:type`: an
// anchor whose whole text is a note marker. Anything longer is a cross-reference
// or a link, not a marker.
const NOTE_MARKER_TEXT =
  /^[\[(]?[\d¹²³⁰-⁹*†‡§¶abcdefghij]{1,4}[\]).]?$/;

// The most consecutive elements a chapter opening may be spelled across. A book
// that sets the number, the title and a subtitle on separate lines is the widest
// real case; more than that and the run has stopped being a heading.
const CHAPTER_TITLE_RUN_MAX = 4;

// The fewest characters a title match may rest on. A one- or two-character run
// ("1", "II") appears inside almost any navigation label by accident.
const CHAPTER_TITLE_MIN_CHARS = 4;

/**
 * Fold text for comparison against a navigation label: letters and digits only.
 *
 * Aggressive on purpose, and only ever used for THIS comparison. A book writes
 * "Chapter 1: Killing America" in its navMap and sets the same chapter opening
 * as `<p class="cn">1</p><p class="ct">KILLING AMERICA</p>` — different case,
 * different punctuation, the word "Chapter" present in one and not the other.
 * Everything that differs there is punctuation, case or spacing, so all three go.
 */
function foldForTitleMatch(s: string): string {
  return s.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Read the book's own table of contents: the EPUB 3 nav document if it declares
 * one, else the EPUB 2 `toc.ncx` navMap.
 *
 * Returned in navigation order, which is the order the book means them in.
 */
export async function readEpubTocTargets(epubSourcePath: string): Promise<EpubTocTarget[]> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(epubSourcePath);
    if (structure.navPath) {
      // A declared-but-unreadable nav is not swallowed here: `open()` above has
      // already read the same path and recorded the failure on
      // `structure.warnings`, which is what the caller shows the user. Throwing
      // a second time would turn a book that opens today into one that cannot be
      // analyzed at all.
      try {
        const targets = parseNavTocTargets(
          await processor.readFile(structure.navPath),
          normalizeZipEntryName(structure.navPath),
        );
        if (targets.length > 0) return targets;
      } catch (err) {
        console.warn(`[EpubProcessor] nav document ${structure.navPath} states no usable TOC: `
          + `${(err as Error).message}`);
      }
    }
    if (structure.ncxPath) {
      try {
        return parseNcxTocTargets(
          await processor.readFile(structure.ncxPath),
          normalizeZipEntryName(structure.ncxPath),
        );
      } catch (err) {
        console.warn(`[EpubProcessor] toc.ncx ${structure.ncxPath} states no usable TOC: `
          + `${(err as Error).message}`);
      }
    }
    return [];
  } finally {
    processor.close();
  }
}

/**
 * The `<nav epub:type="toc">` of an EPUB 3 navigation document, as targets.
 *
 * The type is REQUIRED rather than guessed at: a nav document also carries
 * `landmarks` and `page-list` navs, whose anchors point at cover pages and
 * printed page breaks. Reading the first `<nav>` because none says `toc` would
 * make chapter openings out of whichever list the publisher happened to put
 * first. A document with no `toc` nav states no table of contents, and the
 * caller asks the NCX next — which most EPUB 3 books still ship.
 */
function parseNavTocTargets(navXhtml: string, navEntry: string): EpubTocTarget[] {
  const { body } = parseXhtmlBody(navXhtml, `nav document ${navEntry}`);
  const navs = body.getElementsByTagName('nav');
  for (let i = 0; i < navs.length; i++) {
    if (!structureTokens(navs[i]).includes('toc')) continue;
    return anchorTocTargets(navs[i], zipEntryDir(navEntry));
  }
  return [];
}

/** Every in-book anchor under one element, in document order, as targets. */
function anchorTocTargets(root: any, baseDir: string): EpubTocTarget[] {
  const out: EpubTocTarget[] = [];
  const anchors = root.getElementsByTagName('a');
  for (let i = 0; i < anchors.length; i++) {
    const href = anchors[i].getAttribute('href');
    if (href === null || href === '') continue;
    const label = getUnitTextContent(anchors[i]).replace(/\s+/g, ' ').trim();
    if (label === '') continue;
    const target = tocTargetForHref(href, baseDir, label);
    if (target !== null) out.push(target);
  }
  return out;
}

/** The first child element of `el` with this tag name, or null. */
function childElementByTag(el: any, tag: string): any {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n.tagName || '').toLowerCase().split(':').pop() === tag) return n;
  }
  return null;
}

/**
 * The `navMap` of an EPUB 2 `toc.ncx`, as targets.
 *
 * `navLabel` and `content` are DIRECT children of their `navPoint` per the NCX
 * schema, and reading them as direct children is what keeps a nested navPoint's
 * label from being read as its parent's.
 */
function parseNcxTocTargets(ncxXml: string, ncxEntry: string): EpubTocTarget[] {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(xmlSafeEntities(ncxXml), 'application/xml');
  if (!doc || !doc.documentElement) {
    throw new Error(`Could not parse ${ncxEntry} — the navigation is malformed.`);
  }
  const baseDir = zipEntryDir(ncxEntry);
  const out: EpubTocTarget[] = [];
  const points = doc.getElementsByTagName('navPoint');
  for (let i = 0; i < points.length; i++) {
    const navLabel = childElementByTag(points[i], 'navlabel');
    const content = childElementByTag(points[i], 'content');
    if (navLabel === null || content === null) continue;
    const src = content.getAttribute('src');
    if (src === null || src === '') continue;
    const label = getUnitTextContent(navLabel).replace(/\s+/g, ' ').trim();
    if (label === '') continue;
    const target = tocTargetForHref(src, baseDir, label);
    if (target !== null) out.push(target);
  }
  return out;
}

/** Depth-first search for the element carrying this `id`. */
function findElementById(root: any, id: string): any {
  if (root.nodeType !== 1) return null;
  if (typeof root.getAttribute === 'function' && root.getAttribute('id') === id) return root;
  if (!root.childNodes) return null;
  for (let i = 0; i < root.childNodes.length; i++) {
    const hit = findElementById(root.childNodes[i], id);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every `id` in a subtree, including the root's own. */
function collectIds(node: any, into: Set<string>): void {
  if (node.nodeType !== 1) return;
  if (typeof node.getAttribute === 'function') {
    const id = node.getAttribute('id');
    if (id !== null && id !== '') into.add(id);
  }
  if (!node.childNodes) return;
  for (let i = 0; i < node.childNodes.length; i++) collectIds(node.childNodes[i], into);
}

/** The nearest ancestor tag names of `node`, stopping at `stopAt` (inclusive). */
function isInsideTag(node: any, stopAt: any, tag: string): boolean {
  for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
    if ((n.tagName || '').toLowerCase() === tag) return true;
    if (n === stopAt) return false;
  }
  return false;
}

export interface EpubMarkupReading {
  /** Block id → the category this book's own markup states for it. */
  byBlockId: Map<string, string>;
  /**
   * Block id → the positional key of the element it was laid out from. Filled
   * for every aligned block, exactly as the other two readers fill it — it is
   * what a narration strike is recorded as.
   */
  elementByBlockId: Map<string, NarrationElementKey>;
  /** Blocks the aligner could not place in the source markup, and why. */
  unaligned: UnalignedBlock[];
  /** Image blocks the ordinal matcher refused to pair, and why. */
  unmatchedImages: UnalignedBlock[];
  /** Navigation entries that resolved onto a document of this book. */
  tocTargets: number;
  /** Of those, how many opened with a heading this reader called `chapter`. */
  chapterOpenings: number;
  /** Note references found by `epub:type` or by `<sup>` link topology. */
  noterefs: number;
}

/**
 * Derive one category per export unit from the markup around it.
 *
 * Ordered by how specific the evidence is, not by tag alphabet:
 *
 *  1. A unit with no text of its own is the image it holds.
 *  2. A heading tag is a heading — including inside a notes section, where the
 *     "Notes" heading is a heading and the notes under it are not.
 *  3. `epub:type` on the unit or on the section/aside that holds it.
 *  4. The link topology: this unit carries the `id` some `<sup>` reference
 *     points at, so it IS the note.
 *  5. The remaining structural tags, each of which means one thing.
 *  6. Anything else — a `<p>`, a `<div>`, a `<pre>` — is body text.
 */
function markupCategoryForUnit(unit: MarkupUnit, isNoteTarget: boolean): string {
  if (unit.imageOnly) return 'image';
  if (MARKUP_HEADING_TAGS.has(unit.tag)) return 'heading';
  for (let node = unit.el; node && node.nodeType === 1; node = node.parentNode) {
    if (structureTokens(node).some((t) => EPUB_TYPE_NOTE.has(t))) return 'footnote';
  }
  if (isNoteTarget) return 'footnote';
  // A <figure> is collected whole, so the only text it contributes is the
  // caption its <figcaption> holds — the picture itself is an image block, which
  // never reaches the aligner.
  if (unit.tag === 'figcaption' || unit.tag === 'figure') return 'caption';
  if (unit.tag === 'table') return 'table';
  if (unit.tag === 'ul' || unit.tag === 'ol' || unit.tag === 'dl') return 'list';
  if (unit.tag === 'blockquote') return 'quote';
  if (unit.tag === 'img') return 'image';
  return 'body';
}

/**
 * The `id`s a book's own note REFERENCES point at, as `<zip entry>#<id>`.
 *
 * Two spellings, and a book uses one or the other:
 *
 *  - `epub:type="noteref"` on the anchor, which says it outright.
 *  - An anchor inside a `<sup>` whose whole text is a marker token. That is the
 *    form every book that types nothing uses, and it is unambiguous: no other
 *    construct puts a bare "12" in superscript and links it somewhere.
 *
 * `epub:type="backlink"` is deliberately NOT a reference. The note's own
 * "back to the text" anchor points AT the body paragraph, so reading it as a
 * reference would make the paragraph a footnote — which is exactly backwards.
 * The `<sup>` requirement rules the untyped form of the same anchor out too:
 * Killing America wraps its backlinks in `<span class="fn">`, never `<sup>`.
 */
function collectNoteReferenceTargets(units: MarkupUnit[]): Set<string> {
  const targets = new Set<string>();
  for (const unit of units) {
    if (typeof unit.el.getElementsByTagName !== 'function') continue;
    const anchors = unit.el.getElementsByTagName('a');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      if (href === null || !href.includes('#')) continue;
      const tokens = structureTokens(a);
      if (!tokens.includes('noteref')) {
        if (tokens.includes('backlink')) continue;
        if (!isInsideTag(a, unit.el, 'sup')) continue;
        if (!NOTE_MARKER_TEXT.test(getUnitTextContent(a).trim())) continue;
      }
      const hashAt = href.indexOf('#');
      const rawPath = href.slice(0, hashAt);
      const fragment = decodeHrefPart(href.slice(hashAt + 1));
      if (fragment === '') continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath)) continue;
      const dir = zipEntryDir(unit.file);
      const entry = rawPath === ''
        ? unit.file
        : normalizeZipEntryName(dir ? `${dir}/${decodeHrefPart(rawPath)}` : decodeHrefPart(rawPath));
      targets.add(`${entry}#${fragment}`);
    }
  }
  return targets;
}

/**
 * The part of an export unit the markup classifier actually reads.
 *
 * Narrower than {@link ExportUnit} on purpose. The classifier asks four
 * questions — what tag is this, does it hold only a picture, what does the
 * markup around it say, and which document is it in — and a caller that can
 * answer those should not have to invent an alignment-stream offset it has no
 * business having. `ExportUnit` satisfies this by having more.
 */
export interface MarkupUnit {
  file: string;
  /** `<file>#<index>` — the same key the narration walk stamps on the element. */
  key: string;
  tag: string;
  el: any;
  imageOnly: boolean;
  /**
   * Normalized text of the unit. Read only by the chapter-opening pass, which
   * has to compare what a document OPENS with against what the navigation calls
   * it, and cannot do that from tags alone.
   */
  normText: string;
}

/**
 * The whole markup reading of a book, in both the shapes its callers key by.
 *
 * `categoryByKey` is what a caller that already knows its elements wants; the
 * positional `categories` is what a caller that aligned blocks onto unit INDICES
 * wants. They are the same strings — the map is built from the array — rather
 * than two readings that have to be kept in step.
 */
export interface MarkupCategoryReading {
  /** Element key → category. One entry per unit; keys are unique or this threw. */
  categoryByKey: Map<string, string>;
  /** The same categories by unit position, for a caller holding unit indices. */
  categories: string[];
  /** Note-reference targets resolved across the whole book, as `<file>#<id>`. */
  noteTargets: Set<string>;
  /** Navigation entries whose document opened with a heading called `chapter`. */
  chapterOpenings: number;
}

/**
 * What a book's own markup says every one of its export units is.
 *
 * THE description of these rules — there is deliberately only one, and all three
 * readers stand on it: the block-keyed `readEpubMarkupCategories` (mupdf's
 * aligned blocks, and the preserving exporter's tests), the element-keyed
 * `readEpubElementCategories` (the quire analysis path, handed the element key
 * and needing no join at all), and `electron/quire-viewer-bridge.ts` (the live
 * viewer, holding the units straight off the narration walk). A second copy of
 * this loop would be a second opinion about what a `<blockquote>` is, and the
 * three would drift apart one bug fix at a time.
 *
 * Note targets are resolved across the units handed in, so pass a whole book's
 * worth. A footnote is a footnote because something elsewhere in the book points
 * at it, and a per-document call could not see that.
 *
 * `targets` is the book's navigation, and it is REQUIRED rather than optional:
 * chapter openings are part of what the markup says, so a caller that omitted
 * them would get a reading in which no chapter is a chapter — quietly different
 * from every other caller's. A book with no navigation passes an empty list and
 * says so.
 */
export function markupCategoriesForUnits(
  units: MarkupUnit[],
  targets: readonly EpubTocTarget[],
): MarkupCategoryReading {
  const noteTargets = collectNoteReferenceTargets(units);

  const categories = units.map((unit) => {
    let isNoteTarget = false;
    if (noteTargets.size > 0) {
      const ids = new Set<string>();
      collectIds(unit.el, ids);
      for (const id of ids) {
        if (noteTargets.has(`${unit.file}#${id}`)) { isNoteTarget = true; break; }
      }
    }
    return markupCategoryForUnit(unit, isNoteTarget);
  });

  // The navigation's reading first, then the USER's over the top of it: a
  // person looking at the page is correcting exactly this heuristic, so their
  // word is the last one said. See `applyUserCategories`.
  const chapterOpenings = markChapterOpenings(units, categories, targets)
    + applyUserCategories(units, categories);

  const categoryByKey = new Map<string, string>();
  for (let i = 0; i < units.length; i++) {
    if (categoryByKey.has(units[i].key)) {
      throw new Error(
        `Markup reading: two export units both claim the element key ${units[i].key}. An element `
        + 'key names one element of one book, so one of these two readings would silently win '
        + 'over the other. This is a bug in the unit walk, not a book problem.',
      );
    }
    categoryByKey.set(units[i].key, categories[i]);
  }

  return { categoryByKey, categories, noteTargets, chapterOpenings };
}

/**
 * Read each laid-out block's category off the STRUCTURE of a book that carries
 * neither of our stamps.
 *
 * `blocks` are the picker's blocks in the aligner's own input shape, exactly as
 * the other two readers take them.
 *
 * Every returned category is a member of the one palette
 * (`shared/ocr/block-categories.ts`) by construction — this reader writes the
 * ids itself rather than translating a stamp, so there is nothing to validate
 * and nothing that could disagree.
 */
export async function readEpubMarkupCategories(
  epubSourcePath: string,
  blocks: EpubExportBlock[],
): Promise<EpubMarkupReading> {
  const targets = await readEpubTocTargets(epubSourcePath);
  const {
    units, blockToUnits, unaligned, imageUnits, blockToImageUnit, unmatchedImages,
  } = await alignBlocksToEpub(epubSourcePath, blocks);

  const { categories, noteTargets, chapterOpenings } = markupCategoriesForUnits(units, targets);

  const byBlockId = new Map<string, string>();
  const elementByBlockId = new Map<string, NarrationElementKey>();
  for (const [blockId, unitIndices] of blockToUnits) {
    if (unitIndices.length === 0) {
      throw new Error(
        `Markup structure of ${path.basename(epubSourcePath)}: block ${blockId} aligned to zero `
        + 'source elements — this is a bug.',
      );
    }
    // A block spanning several elements takes the FIRST one's — the element its
    // text begins in, the same tiebreak both stamp readers use.
    elementByBlockId.set(blockId, units[unitIndices[0]].key);
    byBlockId.set(blockId, categories[unitIndices[0]]);
  }
  // The pictures. Their category is `image` by construction — the block IS a
  // picture, whatever the markup around it says — so only the key is joined.
  for (const [blockId, imageIndex] of blockToImageUnit) {
    elementByBlockId.set(blockId, imageUnits[imageIndex].key);
  }

  // Footnote MARKERS never reach the aligner — they duplicate their parent
  // block's text, so it skips them — but the markup has just proved the book
  // carries note references, and a superscript marker block IS one. Stated only
  // when references were actually found: in a book with none, a superscript is
  // whatever the classifier makes of it, which is the honest answer there.
  if (noteTargets.size > 0) {
    for (const b of blocks) {
      if (b.isFootnoteMarker) byBlockId.set(b.id, 'footnote');
    }
  }

  return {
    byBlockId,
    elementByBlockId,
    unaligned,
    unmatchedImages,
    tocTargets: targets.length,
    chapterOpenings,
    noterefs: noteTargets.size,
  };
}

/**
 * Turn the opening heading of every document the table of contents points at
 * into a `chapter`, in place on `categories`. Returns how many it found.
 *
 * `chapter` is the class the picker's Chapter tab lists (`isChapterBlock`), so
 * this is what gives a publisher's EPUB the chapter rows a converted book gets
 * from its `data-bf-cat="chapter"` stamps. The book names its own chapters in
 * its navigation; the only question is which element in the target document
 * spells that name, and there are two answers depending on how the book is set:
 *
 *  1. STRUCTURAL. The document opens with `<h1>`…`<h6>`. That run of headings is
 *     the chapter opening, full stop — no text comparison is needed or wanted.
 *  2. BY THE BOOK'S OWN LABEL. Many publisher EPUBs use no heading tags at all —
 *     Killing America sets every heading as a styled `<p>` and carries zero
 *     `<h1>`–`<h6>` in 21 documents. There the navigation label IS the evidence:
 *     the navMap says ch01.xhtml is "Chapter 1: Killing America" and the
 *     document opens `<p class="cn">1</p><p class="ct">KILLING AMERICA</p>`, so
 *     the run whose folded text the label starts or ends with is the heading the
 *     book means. Body prose cannot match — a label is short and a paragraph is
 *     not, so neither can contain the other.
 *
 * Deliberately not a third answer: a document whose opening matches nothing gets
 * no chapter block. Copyright pages, cover images and back matter reach here
 * like everything else in the navigation, and inventing an opening for them
 * would put rows in the Chapter tab the book never claimed.
 *
 * ── One chapter block per document ────────────────────────────────────────────
 *
 * Only the FIRST element of the run becomes `chapter`; the rest become
 * `heading`. That is not a hedge, it is what the Chapter tab counts: a converted
 * book carries `data-bf-cat="chapter"` on the ONE heading foundry split at, and
 * `bookChapterRows` gives the document's nav title to the first chapter block in
 * it and marks every later one "not the one its chapter document opens with".
 * Marking a two-line opening as two chapter blocks would put two rows in the tab
 * for one chapter of the book — the same chapter twice, the second unrenameable.
 * The lines after the first are still the chapter's heading, and `heading` says
 * exactly that.
 */
function markChapterOpenings(
  units: MarkupUnit[],
  categories: string[],
  targets: readonly EpubTocTarget[],
): number {
  const byFile = new Map<string, number[]>();
  for (let i = 0; i < units.length; i++) {
    const list = byFile.get(units[i].file);
    if (list === undefined) byFile.set(units[i].file, [i]);
    else list.push(i);
  }

  const alreadyOpened = new Set<number>();
  let found = 0;

  for (const target of targets) {
    const entry = target.entryCandidates.find((c) => byFile.has(c));
    if (entry === undefined) continue; // navigation points outside the spine
    const fileUnits = byFile.get(entry)!;

    // Where in the document the entry points. A fragment naming nothing this
    // book's units cover lands at the document start, which is where a reading
    // system lands too — the entry still names the document.
    let from = 0;
    if (target.fragment !== null) {
      const root = fileUnits.length > 0 ? units[fileUnits[0]].el.ownerDocument?.documentElement : null;
      const anchor = root ? findElementById(root, target.fragment) : null;
      if (anchor !== null) {
        const at = fileUnits.findIndex((u) => {
          const el = units[u].el;
          return el === anchor || isDescendantOf(anchor, el) || isDescendantOf(el, anchor);
        });
        if (at >= 0) from = at;
      }
    }

    // The text-bearing units from there on. A leading cover image or spacer
    // carries no text and cannot be a heading, so it is stepped over rather
    // than treated as the document's opening.
    const run: number[] = [];
    for (let i = from; i < fileUnits.length && run.length < CHAPTER_TITLE_RUN_MAX; i++) {
      const u = units[fileUnits[i]];
      if (u.imageOnly || u.normText.length === 0) continue;
      run.push(fileUnits[i]);
    }
    if (run.length === 0) continue;

    let opening: number[] = [];
    if (MARKUP_HEADING_TAGS.has(units[run[0]].tag)) {
      for (const idx of run) {
        if (!MARKUP_HEADING_TAGS.has(units[idx].tag)) break;
        opening.push(idx);
      }
    } else {
      const label = foldForTitleMatch(target.label);
      let folded = '';
      for (let k = 0; k < run.length; k++) {
        folded += foldForTitleMatch(units[run[k]].normText);
        if (folded.length < CHAPTER_TITLE_MIN_CHARS) continue;
        // The LONGEST run that still agrees with the label, not the first: a
        // book setting "CHAPTER 1" and "KILLING AMERICA" on two lines matches at
        // k=0 on the prefix alone, and stopping there would leave the title
        // itself labelled body text.
        if (label === folded || label.startsWith(folded) || label.endsWith(folded)) {
          opening = run.slice(0, k + 1);
        }
      }
    }

    if (opening.length === 0) continue;
    if (opening.some((idx) => alreadyOpened.has(idx))) continue;
    for (const idx of opening) alreadyOpened.add(idx);
    categories[opening[0]] = 'chapter';
    for (const idx of opening.slice(1)) categories[idx] = 'heading';
    found++;
  }

  return found;
}

/** The documents this reading says a chapter opens in. */
function filesOpeningAChapter(units: MarkupUnit[], categories: readonly string[]): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < units.length; i++) {
    if (categories[i] === 'chapter') files.add(units[i].file);
  }
  return files;
}

/**
 * Overlay what the USER said about these elements, in place on `categories`.
 * Returns how the number of documents a chapter opens in moved.
 *
 * ── Why LAST ───────────────────────────────────────────────────────────────
 *
 * Because the user's word is the one that wins. `markChapterOpenings` reads the
 * navigation and the tags and is right about most books; a person with the page
 * in front of them, relabelling a heading in the picker, is CORRECTING that
 * reading, and a correction that ran first and was then overwritten by the thing
 * it corrects would be no correction at all. This is the same order the picker's
 * palette implies and the reason the override lives in the book: it is read by
 * the naming pass, the Chapter tab, the narration cut and the exporters through
 * this one function.
 *
 * ── One chapter opening per document, kept ─────────────────────────────────
 *
 * `markChapterOpenings` guarantees it and the naming pass depends on it: that
 * pass writes a chapter's stored name into the FIRST element of its document
 * this reading calls `chapter`. So when a user names an opening in a document
 * that already had one, the other becomes `heading` — exactly what the rest of a
 * marked run becomes, and the true thing to say about it: still the chapter's
 * heading, no longer the split point. Two would put one chapter in the Chapter
 * tab twice and let the naming pass write the name into whichever came first,
 * which is the element the user just said was not the opening.
 *
 * A user's own labels are never demoted by this: only the reading's are.
 */
function applyUserCategories(units: MarkupUnit[], categories: string[]): number {
  const whatFor = "the user's own labels";
  const stated = new Map<number, string>();
  for (let i = 0; i < units.length; i++) {
    const said = userCategoryOf(units[i].el, whatFor);
    if (said !== null) stated.set(i, said);
  }
  if (stated.size === 0) return 0;

  const before = filesOpeningAChapter(units, categories);
  for (const [at, said] of stated) categories[at] = said;

  const namedOpening = new Set<string>();
  for (const [at, said] of stated) {
    if (said === 'chapter') namedOpening.add(units[at].file);
  }
  for (let i = 0; i < units.length; i++) {
    if (categories[i] !== 'chapter' || stated.has(i)) continue;
    if (namedOpening.has(units[i].file)) categories[i] = 'heading';
  }

  return filesOpeningAChapter(units, categories).size - before.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// The same three readings, keyed by ELEMENT instead of by block
//
// Everything above answers "what is the block with this id?", and to do that it
// has to first answer "which element was that block laid out from?" — by
// matching text, because mupdf reports boxes and throws the DOM away.
//
// quire does not throw the DOM away. It is handed the element key on every
// block it reports, because BookForge stamped it (electron/quire-stamp.ts), so
// on that path the join is already made and the question left is the simple one:
// what does this book say about the element named `<zip entry>#<index>`?
//
// One walk, one enumeration, one set of category rules — the readers below share
// `walkEpubElements`, `provenanceOnOrAbove`, `conversionStampOnOrAbove` and
// `markupCategoriesForUnits` with their block-keyed counterparts, so a book
// cannot be described two different ways depending on which one asked.
// ─────────────────────────────────────────────────────────────────────────────

/** One element of a book, as the analysis path needs to know it. */
export interface EpubElementFact {
  key: NarrationElementKey;
  /** Zip entry of the spine document it lives in. */
  file: string;
  /** Which enumeration produced the key — text units and pictures are separate namespaces. */
  kind: 'text' | 'image';
  tag: string;
  /**
   * Text units only: the element holds a picture and contributes no words.
   *
   * Load-bearing rather than descriptive. Such an element is enumerated in BOTH
   * namespaces — the wrapper `<div class="image">` is a unit and the `<img>`
   * inside it is a picture, and a bare `<img>` under `<body>` is literally both
   * at once — so emitting a block for each would put two overlapping rectangles
   * on one plate. The picture is the one that gets the block, exactly as the
   * mupdf path had it (`alignBlocksToEpub` keeps image-only units out of the
   * alignment stream, and `alignImageBlocks` pairs picture blocks with picture
   * ELEMENTS), and exactly as `writeNarrationEpub` treats a strike on either.
   */
  imageOnly: boolean;
  /** Text units only: normalized character count. Zero means it lays out no words. */
  textLength: number;
}

export interface EpubElementReading {
  /**
   * Which input class this book is, in the vocabulary of
   * `BlockCategoryProvenance.source`. `heuristic` never appears: an EPUB always
   * states its structure somewhere, even when it carries none of our stamps.
   */
  source: 'document' | 'markup';
  /**
   * The spine documents this reading describes, or null for the whole book.
   *
   * Non-null only when a caller asked for less with `only` AND the book's
   * reading is one that may be narrowed — see `readEpubElementCategories`, where
   * that is decided. A caller that asked and got null was not refused: it got a
   * superset, which answers by element key exactly what the subset would have.
   */
  describes: string[] | null;
  /** Every element of the reading, in the enumeration order the stamper walks. */
  elements: EpubElementFact[];
  /** Element key → the category this book states or implies for it. */
  categoryByElement: Map<NarrationElementKey, string>;
  /** Element key → the reflow stamp, on a book our reflow wrote. */
  provenanceByElement: Map<NarrationElementKey, EpubBlockProvenance>;
  /** Element key → the conversion stamp, on a book vlm-convert wrote. */
  conversionByElement: Map<NarrationElementKey, EpubConversionStamp>;
  /** Elements a `document`-class book carries no stamp on (nav TOC, hand-added markup). */
  unstampedElements: number;
  /** Navigation entries that resolved onto a document of this book. */
  tocTargets: number;
  /** Of those, how many opened with a heading the markup reader called `chapter`. */
  chapterOpenings: number;
  /** Note references found by `epub:type` or by `<sup>` link topology. */
  noterefs: number;
}

/** Which of the three readings a book gets. Decided WHOLE-BOOK, always. */
type CategoriesBranch = 'provenance' | 'conversion' | 'markup';

/**
 * Which reading this book gets — and the whole-book walk, when deciding needed
 * one.
 *
 * ── Why this is its own step ───────────────────────────────────────────────
 *
 * Because `readEpubElementCategories` may now be asked about SOME of a book's
 * documents, and a book must never change branch because of which documents
 * were touched. Two of the three answers are whole-book facts and are asked as
 * such here, before any narrowing exists:
 *
 *  - `epubCarriesProvenance` / `epubCarriesConversionStamps` scan the entire
 *    spine (they short-circuit on the first document that carries the stamp,
 *    which is why they cost 12 ms and 2 ms on Nuremberg against 106 ms to parse
 *    it). They are never given `only`.
 *  - The provenance branch's own fallthrough — the attribute is in the bytes but
 *    no element RESOLVES a stamp, so the book is not a reflow of ours in any
 *    usable sense — is a question about every element of the book. Asked here,
 *    over a whole-book walk, and never inferred from a narrowed one: a document
 *    that happens to carry no stamped element would otherwise flip a stamped
 *    book onto the markup reader, which reads it differently.
 *
 * The walk that decision needed is handed back rather than thrown away, so a
 * book whose branch cost a walk is still walked exactly once.
 */
async function categoriesBranchOf(epubSourcePath: string, whatFor: string): Promise<{
  branch: CategoriesBranch;
  /** The WHOLE-book walk, when deciding required one. Null when it did not. */
  walked: EpubElementWalk | null;
}> {
  if (await epubCarriesProvenance(epubSourcePath)) {
    const walked = await walkEpubElements(epubSourcePath);
    for (const u of walked.units) {
      if (provenanceOnOrAbove(u.el, whatFor) !== null) return { branch: 'provenance', walked };
    }
    // Nothing resolved. The next question is asked — and the walk travels with
    // it, because it is a whole-book walk of the same book and re-taking it
    // would be the same 100 ms for the same answer.
    if (await epubCarriesConversionStamps(epubSourcePath)) {
      return { branch: 'conversion', walked };
    }
    return { branch: 'markup', walked };
  }
  if (await epubCarriesConversionStamps(epubSourcePath)) {
    return { branch: 'conversion', walked: null };
  }
  return { branch: 'markup', walked: null };
}

/**
 * Everything a book says about its own elements, keyed by the element key.
 *
 * FOUR input classes asked in the same order `assignCategories` asks them, and
 * for the same reason: a book carries at most one of the two stamps, so this is
 * questions asked in turn rather than a precedence rule. A PDF never reaches
 * here — it has no markup at all — which is why `source` has no `heuristic`.
 *
 * ── `only`, and why it is a HINT rather than an instruction ────────────────
 *
 * A relabel touches one document and asks this twice — once to learn what the
 * book currently calls the element, once to verify what it now calls it — and
 * both walked all 20 of Nuremberg's spine documents to answer about one.
 * Measured 2026-08-11: 127 ms a call, 106 ms of it the parse.
 *
 * Whether that walk MAY be narrowed depends on which reading the book gets, and
 * the three differ:
 *
 *  - `provenance` and `conversion` — a book WE wrote. The category of an element
 *    is `userCategoryOf(el)` over `provenanceOnOrAbove(el)` /
 *    `conversionStampOnOrAbove(el)`, and both of those walk from the element up
 *    through its ancestors, which cannot leave its own document. Narrowing is
 *    exact.
 *  - `markup` — a publisher's book, read by `markupCategoriesForUnits`. That
 *    reading is NOT per-document: `collectNoteReferenceTargets` resolves note
 *    references across the whole book, and an element is a footnote because
 *    something ELSEWHERE points at it. Narrowing silently turns endnotes into
 *    body text — measured over the library, 2026-08-11: of three publisher
 *    working copies two would be misread, 591 elements of Balkans as `body` and
 *    3509 of Heinrich Himmler as `quote`. So `only` is IGNORED on this branch.
 *
 * Ignored, not refused, because the answer stays correct either way: a reading
 * of the whole book contains every element a narrowed one would have, with the
 * same category. `only` asks for less work, never for a different answer, and
 * `describes` says which it got. Every caller reaches this map by element key,
 * so a superset answers every question a subset would.
 */
export async function readEpubElementCategories(
  epubSourcePath: string,
  only?: ReadonlySet<string>,
): Promise<EpubElementReading> {
  const whatFor = `the elements of ${path.basename(epubSourcePath)}`;
  // WHOLE-BOOK, and before the walk that may be narrowed. See `categoriesBranchOf`.
  const decided = await categoriesBranchOf(epubSourcePath, whatFor);
  // Honoured only where the derivation is per-document — and only where the
  // branch decision did not already pay for the whole book, in which case the
  // wider reading is simply the one that is already in hand.
  const narrowTo = decided.branch === 'markup' || decided.walked !== null ? undefined : only;
  const walk = decided.walked !== null
    ? decided.walked
    : await walkEpubElements(epubSourcePath, narrowTo);
  const describes = narrowTo === undefined ? null : [...walk.docIndexOfFile.keys()];
  const { units, imageUnits } = walk;

  // The enumeration order the stamper walks and the narration writer applies:
  // per spine document, text units first, then that document's pictures.
  const unitsOfFile = new Map<string, ExportUnit[]>();
  for (const u of units) {
    const list = unitsOfFile.get(u.file);
    if (list === undefined) unitsOfFile.set(u.file, [u]); else list.push(u);
  }
  const imagesOfFile = new Map<string, ImageUnit[]>();
  for (const i of imageUnits) {
    const list = imagesOfFile.get(i.file);
    if (list === undefined) imagesOfFile.set(i.file, [i]); else list.push(i);
  }
  const elements: EpubElementFact[] = [];
  for (const file of walk.docIndexOfFile.keys()) {
    for (const u of unitsOfFile.get(file) ?? []) {
      elements.push({
        key: u.key, file, kind: 'text', tag: u.tag,
        imageOnly: u.imageOnly, textLength: u.normText.length,
      });
    }
    for (const i of imagesOfFile.get(file) ?? []) {
      elements.push({
        key: i.key, file, kind: 'image', tag: String(i.el.tagName || '').toLowerCase(),
        imageOnly: true, textLength: 0,
      });
    }
  }

  const categoryByElement = new Map<NarrationElementKey, string>();
  const provenanceByElement = new Map<NarrationElementKey, EpubBlockProvenance>();
  const conversionByElement = new Map<NarrationElementKey, EpubConversionStamp>();

  // ── 1. A book our reflow wrote ────────────────────────────────────────────
  //
  // Which branch this is was settled whole-book above, so the questions below
  // are no longer asked of the book a second time and — this is the part that
  // matters — cannot be answered differently by a narrowed walk.
  if (decided.branch === 'provenance') {
    const legal = new Set<string>(BLOCK_CATEGORY_IDS);
    let unstamped = 0;
    for (const u of units) {
      // The USER's own label first, because it is a correction OF the stamp —
      // see USER_CATEGORY_ATTR. The stamp is still read and still reported: it
      // is the book's record of what wrote the element, which the correction
      // does not erase and `bf_group`/`bf_blocks` still come off.
      const said = userCategoryOf(u.el, whatFor);
      const stamp = provenanceOnOrAbove(u.el, whatFor);
      if (stamp === null) {
        if (said === null) { unstamped++; continue; }
        categoryByElement.set(u.key, said);
        continue;
      }
      if (!legal.has(stamp.category)) {
        throw new Error(
          `${whatFor}: element <${u.tag}> in ${u.file} is stamped `
          + `${PROVENANCE_CATEGORY_ATTR}="${stamp.category}" (group ${stamp.group}), which is not a `
          + `block category BookForge knows. The palette is shared/ocr/block-categories.ts: `
          + `${BLOCK_CATEGORY_IDS.join(', ')}.`,
        );
      }
      provenanceByElement.set(u.key, stamp);
      categoryByElement.set(u.key, said === null ? stamp.category : said);
    }
    // Pictures take no category from the stamp — the block IS a picture, which
    // is what the block-keyed reader says too.
    //
    // The `provenanceByElement.size > 0` gate that used to stand here — the
    // attribute is in the bytes but no element resolves a stamp, so the book is
    // not a reflow of ours in any usable sense — has moved into
    // `categoriesBranchOf`, whole-book, where it belongs: asked here it would be
    // a question about whichever documents this call happened to walk, and a
    // narrowed walk that resolved no stamp would drop a stamped book onto the
    // markup reader.
    return {
      source: 'document', describes, elements, categoryByElement, provenanceByElement,
      conversionByElement, unstampedElements: unstamped,
      tocTargets: 0, chapterOpenings: 0, noterefs: 0,
    };
  }

  // ── 2. A book a document vision model wrote ───────────────────────────────
  if (decided.branch === 'conversion') {
    let unstamped = 0;
    const readOnto = (el: any, key: NarrationElementKey): void => {
      // The USER's own label outranks the model's, for the same reason it
      // outranks the reflow's above — and the model's word is still recorded, so
      // `bf_cat` keeps saying what dots actually read.
      const said = userCategoryOf(el, whatFor);
      const read = conversionStampOnOrAbove(el, whatFor);
      if (read === null) {
        if (said === null) { unstamped++; return; }
        categoryByElement.set(key, said);
        return;
      }
      conversionByElement.set(key, { ...read, element: key });
      categoryByElement.set(key, said === null ? read.category : said);
    };
    for (const u of units) readOnto(u.el, u.key);
    for (const i of imageUnits) readOnto(i.el, i.key);
    return {
      source: 'document', describes, elements, categoryByElement, provenanceByElement,
      conversionByElement, unstampedElements: unstamped,
      tocTargets: 0, chapterOpenings: 0, noterefs: 0,
    };
  }

  // ── 3. A publisher's book, which states its structure in its own markup ───
  //
  // `units` is the WHOLE book here and `describes` is null, because `narrowTo`
  // was withheld on this branch: what this reading calls an element is not a
  // function of that element's own document. See the header for the measurement.
  const targets = await readEpubTocTargets(epubSourcePath);
  const { categoryByKey, noteTargets, chapterOpenings } = markupCategoriesForUnits(units, targets);
  // The reading is already keyed the way this reader answers, so it is taken as
  // it comes rather than rebuilt from unit positions.
  for (const [key, category] of categoryByKey) categoryByElement.set(key, category);
  // Pictures are `image` by construction here too, and that is the block's own
  // flag rather than a reading of the markup — so nothing is written for them.
  return {
    source: 'markup', describes, elements, categoryByElement, provenanceByElement,
    conversionByElement, unstampedElements: 0,
    tocTargets: targets.length, chapterOpenings, noterefs: noteTargets.size,
  };
}

export interface NarrationEpubWriteResult {
  /** How many elements were removed. */
  removedElements: number;
  /** How many the book had. */
  totalElements: number;
  /**
   * How many elements were found ALIVE in the written file by the verification.
   *
   * Reported rather than kept private because it is the number that says the
   * guarantee was actually checked: `verifiedElements + removedElements +
   * dissolvedElements === totalElements`, measured against the file on disk
   * rather than against the plan that produced it.
   */
  verifiedElements: number;
  /**
   * How many elements left the copy WITHOUT being struck: a picture inside a
   * struck paragraph, a wrapper whose only picture was struck, anything in a
   * document the strikes emptied. Counted apart because they are not deletions
   * the user asked for by name, and the arithmetic has to say where they went.
   */
  dissolvedElements: number;
  /** How many digits-only `<sup>` footnote references were removed. */
  removedSupMarkers: number;
  /** How many elements speak an overridden text (chapter openings, mostly). */
  overriddenElements: number;
  /** The spine documents that were rewritten. */
  rewrittenFiles: string[];
  /**
   * The spine documents that were REMOVED, by zip entry name — the ones the
   * strikes emptied, and the ones a `<zip entry>#doc` key struck by name.
   *
   * Reported rather than counted quietly because it is the difference between
   * "your deletions worked" and "your deletions worked and the blank pages they
   * would have left are gone too" — and the second is what the user is looking
   * at when they open the copy to check.
   */
  removedDocuments: string[];
  /**
   * Strikes this cut applied on the user's authority alone: recorded before
   * fingerprints existed, on a book whose sha does not certify them.
   *
   * Reported rather than counted quietly because it is the one class the cut
   * cannot prove anything about, and the caller with a user in front of it is
   * the one that should say so.
   */
  unverifiableStrikes: string[];
}

export interface NarrationEpubWriteOptions {
  /**
   * Remove digits-only `<sup>` footnote references as the copy is written.
   *
   * DEFAULT ON, and the default is the point. A narrator reads `<sup>55</sup>`
   * out loud as "fifty-five", e2a's number expansion inflates it first, and a
   * voice fine-tuned on that text learns that junk means end-of-utterance. The
   * markers are noise in every narration copy that has them, so the copy comes
   * out without them unless a caller says otherwise.
   *
   * It is an option on THIS write and not a pass over the book because the book
   * is never edited — see shared/text/sup-markers.ts.
   */
  stripSupMarkers?: boolean;
  /**
   * Element key → the EXACT text the narration copy must carry for that
   * element, in place of whatever it prints.
   *
   * The chapter-name rule rides on this: a chapter opening speaks its chapter's
   * stored name — "Chapter 2: An Opportunity to Hope" — never the "2" it
   * happens to print (Owen, 2026-08-09: a chapter header is a single line and
   * it is always the chapter's name). The overrides are applied to the tree
   * BEFORE the verification signatures are computed, so the guarantee check
   * verifies the book as overridden rather than reporting every override as a
   * unit that lost its text. A key the book does not have is refused by name;
   * a struck key is skipped — its element is leaving the copy anyway.
   */
  textOverrides?: Readonly<Record<string, string>>;
  /**
   * What each strike remembers striking — the record's `fingerprints` — so this
   * cut can prove per strike that it is removing what the user chose.
   *
   * ABSENT means "no check is owed", and there is exactly one situation in
   * which that is true: the record is stamped with the sha of the book being
   * cut, so every key in it was minted against these very bytes. The caller
   * measures that (electron/narration-export.ts) because the caller is the one
   * holding both the record and the file. See `planNarrationRemoval`.
   */
  verifyStrikes?: Readonly<Record<string, string>>;
}

/**
 * Is this body EMPTY — nothing left in it that a reader would see?
 *
 * ── Why this test is about CONTENT and not about tags ───────────────────────
 *
 * The strikes remove the elements they name and nothing else, so a document
 * whose every paragraph was struck is left holding the wrappers those paragraphs
 * were inside: a `<div class="chapter">` around a `<section>` around nothing.
 * Counting tags would call that document non-empty; the reader sees a blank
 * page. So the question asked here is the reader's question — is there any TEXT,
 * and is there any PICTURE — and the wrapper hierarchy is beside the point.
 *
 * An image is content. That is not a special case: the five image-only pages of
 * a typical book (cover, half-title, title, colophon plate, back cover) have no
 * text and never did, so a document still holding its picture is a page the
 * reader sees and must stay in the book.
 *
 * Which is also why a picture can now be STRUCK (`<zip entry>#img<N>`, Aug
 * 2026). Before it could not, and the consequence was measured: a user struck
 * out the cover, the half-title and the title page, and all three came through
 * to the narration copy — the strikes had nothing to name, so the documents
 * never emptied and this test never said yes about them. Now it does, and the
 * pruning below removes them exactly as it removes a document whose every
 * paragraph was struck.
 *
 * The tag list here and `collectImageElements`'s are deliberately the same set:
 * one decides what can be struck, this decides whether striking it all leaves
 * nothing, and a disagreement between them would leave a blank page behind.
 *
 * `<svg>` counts alongside `<img>` because a wrapped cover is often an SVG
 * `<image>`, which is how EPUB 3 covers are usually written.
 */
function bodyIsEmpty(body: any): boolean {
  const text = (body.textContent ?? '').replace(/[\s ]+/g, '');
  if (text.length > 0) return false;
  for (const tag of ['img', 'image', 'svg']) {
    if (body.getElementsByTagName(tag).length > 0) return false;
  }
  return true;
}

/** Every `<a href>` / `<content src>` value in the document, with the element. */
function linkNodesOf(doc: any, tag: string, attr: string): Array<{ el: any; href: string }> {
  const out: Array<{ el: any; href: string }> = [];
  const nodes = doc.getElementsByTagName(tag);
  for (let i = 0; i < nodes.length; i++) {
    const href = nodes[i].getAttribute(attr);
    if (typeof href === 'string' && href.length > 0) out.push({ el: nodes[i], href });
  }
  return out;
}

/** The document a link points AT, without its fragment — resolved to a zip entry. */
function linkTargetEntry(href: string, fromEntry: string): string | null {
  // A link that names no document (a bare `#id`) points inside its own file, and
  // an absolute one points outside the book entirely. Neither can name a spine
  // document of this book, so neither is a candidate for pruning.
  if (href.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const withoutFragment = href.split('#')[0];
  if (withoutFragment.length === 0) return null;
  const dir = path.posix.dirname(fromEntry);
  return normalizeZipEntryName(path.posix.normalize(path.posix.join(dir, withoutFragment)));
}

/** Remove a node, then any ancestor the removal left with nothing in it. */
function removeAndCollapse(el: any, stopTag: string): void {
  let node = el;
  while (node && node.parentNode) {
    const parent = node.parentNode;
    parent.removeChild(node);
    if (typeof parent.tagName !== 'string') return;
    if (parent.tagName.toLowerCase() === stopTag) return;
    // A list item that held only the link to a removed document is a bullet
    // pointing at nothing; the list that held only that item is an empty list.
    // Both go, up to (never including) the container the caller names.
    if ((parent.textContent ?? '').replace(/[\s ]+/g, '').length > 0) return;
    if (parent.getElementsByTagName('img').length > 0) return;
    node = parent;
  }
}

/**
 * Take the removed documents out of the OPF: their manifest items and the spine
 * itemrefs that name them.
 *
 * Returns the ids it removed, because the spine names documents by id and the
 * manifest is the only place that says which id is which file.
 */
function pruneOpf(opfXml: string, pruned: ReadonlySet<string>, opfEntry: string): string {
  const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(opfXml, 'application/xml');

  const removedIds = new Set<string>();
  const items = doc.getElementsByTagName('item');
  for (let i = items.length - 1; i >= 0; i--) {
    const href = items[i].getAttribute('href');
    if (!href) continue;
    const entry = linkTargetEntry(href, opfEntry);
    if (entry === null || !pruned.has(entry)) continue;
    const id = items[i].getAttribute('id');
    if (id) removedIds.add(id);
    items[i].parentNode.removeChild(items[i]);
  }

  const refs = doc.getElementsByTagName('itemref');
  for (let i = refs.length - 1; i >= 0; i--) {
    const idref = refs[i].getAttribute('idref');
    if (idref && removedIds.has(idref)) refs[i].parentNode.removeChild(refs[i]);
  }

  // The EPUB 2 `<guide>`: a third place the OPF names documents, by href rather
  // than by id, and the one this missed on the first run — Killing America's
  // guide pointed `type="toc"` at the printed contents page the user had struck
  // out, so the file was gone from the zip and still named in the package.
  // A reader that follows the guide would have looked for it.
  const guideRefs = doc.getElementsByTagName('reference');
  for (let i = guideRefs.length - 1; i >= 0; i--) {
    const href = guideRefs[i].getAttribute('href');
    if (!href) continue;
    const entry = linkTargetEntry(href, opfEntry);
    if (entry !== null && pruned.has(entry)) guideRefs[i].parentNode.removeChild(guideRefs[i]);
  }

  return new XMLSerializer().serializeToString(doc);
}

/**
 * Take the removed documents out of the book's TABLE OF CONTENTS — whichever of
 * the two kinds this book has.
 *
 * ── Why this matters more than tidiness ─────────────────────────────────────
 *
 * ebook2audiobook takes its chapter titles from the book's own navigation,
 * matched to spine documents by identity (memory: chapter markers are paired by
 * POSITION, and a title that names nothing shifts every title after it). A TOC
 * entry pointing at a document that is not in the book any more is a chapter
 * marker for nothing — so leaving one would not merely be untidy, it would put
 * the wrong title on a chapter of the finished audiobook.
 *
 * Both dialects are handled because both are real: EPUB 3 books carry a nav
 * document (`<nav epub:type="toc">`, plus landmarks and page-list), EPUB 2 books
 * carry an NCX, and plenty of books carry both. Killing America is a 2.0 package
 * with an NCX and no nav at all (measured).
 *
 * Entries that point INTO a removed document by fragment go with it: the anchor
 * they name went when the document did.
 */
function pruneNavDocument(xhtml: string, pruned: ReadonlySet<string>, navEntry: string): string {
  const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(xmlSafeEntities(xhtml), 'application/xhtml+xml');
  for (const { el, href } of linkNodesOf(doc, 'a', 'href')) {
    const entry = linkTargetEntry(href, navEntry);
    if (entry !== null && pruned.has(entry)) removeAndCollapse(el, 'nav');
  }
  return new XMLSerializer().serializeToString(doc);
}

function pruneNcx(ncxXml: string, pruned: ReadonlySet<string>, ncxEntry: string): string {
  const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(ncxXml, 'application/xml');
  for (const { el, href } of linkNodesOf(doc, 'content', 'src')) {
    const entry = linkTargetEntry(href, ncxEntry);
    if (entry === null || !pruned.has(entry)) continue;
    // The `<content>` element is not the entry — its parent `<navPoint>` (or
    // `<pageTarget>`, in a page-list) is the thing with a label on it, and a
    // navPoint with no content is a heading that points nowhere.
    const owner = el.parentNode;
    removeAndCollapse(owner && typeof owner.tagName === 'string' ? owner : el, 'navMap');
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * A link in a SURVIVING document that points at a removed one: keep the words,
 * drop the href.
 *
 * ── Why not remove the link entirely, and why not leave it dangling ─────────
 *
 * The text of a cross-reference is usually a sentence a narrator reads — "see
 * the note on page 214" — so removing the element would delete prose the user
 * never struck. The href is the part that is now false.
 *
 * Leaving it would be cosmetic in practice: nobody reads the narration copy
 * visually, and TTS never follows a link. But it is not free — epubcheck flags a
 * dangling href as an error, and the narration copy is a file that gets handed
 * to other software (e2a reads it; a user may open it in a reader to verify,
 * which is the whole reason this pruning exists). A copy that a strict reader
 * refuses to open is a worse outcome than a link that no longer navigates.
 *
 * Measured on the book this was written for: ZERO surviving documents link into
 * either pruned document, so on that book this does nothing at all. It is here
 * because an index or a citation list in another book will, and a dangling href
 * that only appears in somebody else's library is the kind of thing that is
 * never found.
 */
function neutralizeLinksToPruned(doc: any, pruned: ReadonlySet<string>, entry: string): number {
  let neutralized = 0;
  for (const { el, href } of linkNodesOf(doc, 'a', 'href')) {
    const target = linkTargetEntry(href, entry);
    if (target === null || !pruned.has(target)) continue;
    el.removeAttribute('href');
    neutralized++;
  }
  return neutralized;
}

// ─── Verifying the cut before it lands ───────────────────────────────────────
//
// Owen, 2026-08-09: "it should just delete the blocks we tell it to delete,
// without fail. a guarantee; a promise… if it isn't, it should fail."
//
// Everything above this line decides what to remove. None of it CHECKS that the
// file that came out is the file that was described — and the failure this was
// written for is precisely a cut that reported success while 43 of 668 struck
// paragraphs were still in the copy. So the staged file is re-opened and
// re-walked with the SAME two enumerations that produced the keys, and the copy
// only moves into place if its contents are the contents that were planned.
//
// The check is a SEQUENCE of signatures rather than a count, because a count is
// satisfied by removing the wrong paragraph. It is a signature rather than a key
// because a key is an INDEX and every index after a removal has shifted by
// construction — the output's unit 8 is the input's unit 9, and comparing those
// numbers would fail on every correct cut.

/**
 * The text of one unit as the OUTPUT will spell it — i.e. with the footnote
 * markers the strip is about to remove already gone.
 *
 * Computed from the DOM rather than from the stripped bytes so the two sides of
 * the comparison are derived independently: the expectation comes from the input
 * tree, the observation from the written file. `stripFootnoteMarkerSups` works
 * on serialized markup, so the same rule is applied here to the sup's TEXT,
 * which is what that rule measures (shared/text/sup-markers.ts).
 */
function narrationUnitText(el: any, stripSups: boolean): string {
  let out = '';
  const walk = (node: any): void => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node.tagName ?? '').toLowerCase();
    if (stripSups && tag === 'sup'
      && isFootnoteMarkerSupText((node.textContent ?? '').trim())) return;
    if (!node.childNodes) return;
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  };
  walk(el);
  return out;
}

/**
 * What a TEXT unit is, for the purpose of recognizing it again in the output.
 *
 * Whitespace is removed entirely rather than collapsed: removing an element
 * changes the whitespace around the hole it leaves, and a re-serialization
 * normalizes indentation, so any comparison that kept it would fail on correct
 * cuts. The tag travels with the text because a paragraph and the heading above
 * it can carry the same words.
 */
export function narrationUnitSignature(el: any, stripSups: boolean): string {
  const tag = (el.tagName ?? '').toLowerCase();
  const text = narrationUnitText(el, stripSups).replace(/[\s ]+/g, '');
  return `${tag}|${text}`;
}

/** What an IMAGE element is: its tag and whatever it points at. */
export function narrationImageSignature(el: any): string {
  const tag = (el.tagName ?? '').toLowerCase();
  const src = el.getAttribute?.('src')
    ?? el.getAttribute?.('xlink:href')
    ?? el.getAttribute?.('href')
    ?? '';
  return `${tag}|${src}`;
}

/** The readable half of a signature: what the element says, for a sentence. */
function narrationSignatureExcerpt(signature: string): string {
  return signature.slice(signature.indexOf('|') + 1, signature.indexOf('|') + 61);
}

/** Is this element still reachable from the body it was collected out of? */
function isStillInBody(el: any, body: any): boolean {
  for (let node = el; node; node = node.parentNode) if (node === body) return true;
  return false;
}

/** One element the cut must account for: what it is, and what named it. */
interface NarrationSignedElement {
  key: NarrationElementKey;
  signature: string;
}

/** One element of a book, signed, and whether the CUT book will still hold it. */
export interface NarrationSignedUnit extends NarrationSignedElement {
  kind: 'unit' | 'image';
  /** Will a walk of the cut book still enumerate this element? */
  admitted: boolean;
}

/**
 * Sign every element of a book, and say which of them the cut leaves behind.
 *
 * ── Why "admitted" is not just "not struck" ─────────────────────────────────
 *
 * `collectExportUnits` admits an element as a unit when it holds an `<img>` OR
 * any text at all. So a wrapper whose ONLY content is a picture — the
 * `<div class="image">` a plate lives in — stops being a unit the moment that
 * picture is struck. It is not removed and it was never struck; it simply is not
 * there to be enumerated any more. The mirror of it: a picture INSIDE a struck
 * paragraph goes with the paragraph, unnamed.
 *
 * Two callers need that answer and must never disagree about it. `writeNarrationEpub`
 * uses it to state what the copy must contain before it removes anything, and
 * the narration-copy pairing (electron/narration-export.ts) uses it to line the
 * copy's elements back up with the book's. A second spelling of this rule would
 * put a strike made on the copy of an illustrated book onto the wrong paragraph,
 * which is the one failure the whole verification story exists to prevent — so
 * there is one spelling, here, beside the writer that owns it.
 *
 * `perFile` is the enumeration in the book's own order, per spine document, text
 * units then pictures — what `enumerateNarrationElements` walks and what the key
 * of every element was minted from.
 */
export function signNarrationElements(
  perFile: ReadonlyMap<string, ReadonlyArray<{ key: string; el: any }>>,
  struck: ReadonlySet<string>,
  stripSups: boolean,
): Map<string, NarrationSignedUnit[]> {
  const struckImageElements = new Set<any>();
  const struckUnitElements: any[] = [];
  for (const [, fileUnits] of perFile) {
    for (const unit of fileUnits) {
      if (!struck.has(unit.key)) continue;
      if (parseNarrationElementKey(unit.key).kind === 'image') struckImageElements.add(unit.el);
      else struckUnitElements.push(unit.el);
    }
  }
  const goesWithAStruckUnit = (el: any): boolean =>
    struckUnitElements.some((struckEl) => el === struckEl || isDescendantOf(el, struckEl));

  const out = new Map<string, NarrationSignedUnit[]>();
  for (const [file, fileUnits] of perFile) {
    const signed: NarrationSignedUnit[] = [];
    for (const unit of fileUnits) {
      const kind = parseNarrationElementKey(unit.key).kind === 'image' ? 'image' : 'unit';
      const signature = kind === 'image'
        ? narrationImageSignature(unit.el)
        : narrationUnitSignature(unit.el, stripSups);
      let admitted: boolean;
      if (struck.has(unit.key)) {
        admitted = false;
      } else if (kind === 'image') {
        admitted = !goesWithAStruckUnit(unit.el);
      } else {
        const imgs = unit.el.tagName?.toLowerCase() === 'img'
          ? [unit.el]
          : Array.from(unit.el.getElementsByTagName('img') as ArrayLike<any>);
        const keepsAnImage = imgs.some((img: any) => !struckImageElements.has(img));
        const keepsText =
          normalizeForAlignment(narrationUnitText(unit.el, stripSups)).length >= 1;
        admitted = keepsAnImage || keepsText;
      }
      signed.push({ key: unit.key, signature, kind, admitted });
    }
    out.set(file, signed);
  }
  return out;
}

/** What one spine document of the OUTPUT must look like for the cut to be right. */
interface NarrationCutExpectation {
  file: string;
  /** True when the whole document must be absent from the copy. */
  removed: boolean;
  /** The TEXT units that must still be there, in the book's own order. */
  keptUnits: NarrationSignedElement[];
  /** The IMAGE elements that must still be there, in flow order. */
  keptImages: NarrationSignedElement[];
  /** What this document was asked to lose, so a survivor can be NAMED. */
  struck: NarrationSignedElement[];
}

/**
 * Read the staged copy back and prove it is the copy that was planned.
 *
 * Throws naming what went wrong; returns the number of elements it accounted
 * for as still present, which the caller checks against the arithmetic of the
 * plan. It never repairs anything: a mismatch here means the cut and the record
 * disagree, and the only honest answer to that is a refusal.
 */
async function verifyNarrationCut(
  outputPath: string,
  expectations: readonly NarrationCutExpectation[],
  stripSups: boolean,
  whatFor: string,
): Promise<number> {
  const problems: string[] = [];
  let kept = 0;

  const zipReader = await openEpubSource(outputPath);
  try {
    for (const expected of expectations) {
      if (expected.removed) {
        if (zipReader.hasEntry(expected.file)) {
          problems.push(
            `${expected.file} was struck out whole and is still in the copy.`
          );
        }
        continue;
      }
      if (!zipReader.hasEntry(expected.file)) {
        problems.push(
          `${expected.file} was not struck out and is not in the copy at all.`
        );
        continue;
      }

      const xhtml = (await zipReader.readEntry(expected.file)).toString('utf8');
      const { doc, body } = parseXhtmlBody(xhtml, expected.file);
      const gotUnits = collectExportUnits(doc, body, whatFor)
        .map((c) => narrationUnitSignature(c.el, stripSups));
      const gotImages = collectImageElements(body).map((el) => narrationImageSignature(el));

      for (const [what, got, want] of [
        ['text element', gotUnits, expected.keptUnits],
        ['picture', gotImages, expected.keptImages],
      ] as Array<[string, string[], NarrationSignedElement[]]>) {
        // The multiset first, because it says WHICH strike survived; the
        // sequence second, because it says the survivors are in the right
        // places. Only the first difference of each is reported — past one the
        // list is the noise, and one named element is what the user acts on.
        const wanted = new Map<string, number>();
        for (const w of want) wanted.set(w.signature, (wanted.get(w.signature) ?? 0) + 1);
        const surplus = new Map<string, number>();
        for (const g of got) {
          const left = wanted.get(g);
          if (left === undefined || left === 0) {
            surplus.set(g, (surplus.get(g) ?? 0) + 1);
          } else {
            wanted.set(g, left - 1);
          }
        }
        for (const survivor of expected.struck) {
          if ((surplus.get(survivor.signature) ?? 0) === 0) continue;
          surplus.set(survivor.signature, surplus.get(survivor.signature)! - 1);
          problems.push(
            `${survivor.key} was struck and is still in the copy: `
            + `"${narrationSignatureExcerpt(survivor.signature)}"`
          );
        }
        for (const [, missing] of wanted) {
          if (missing === 0) continue;
          const lost = want.find((w) => wanted.get(w.signature)! > 0);
          problems.push(
            `${expected.file} lost a ${what} nobody struck — ${lost ? lost.key : 'unknown'}: `
            + `"${lost ? narrationSignatureExcerpt(lost.signature) : ''}"`
          );
          break;
        }
        if (got.length !== want.length) {
          problems.push(
            `${expected.file} should hold ${want.length} ${what}(s) after the cut and holds `
            + `${got.length}.`
          );
        }
        kept += Math.min(got.length, want.length);
      }
    }
  } finally {
    zipReader.close();
  }

  if (problems.length > 0) {
    const SHOWN = 8;
    throw new Error(
      `The narration copy was written and does not match what was struck, so it has been `
      + `discarded rather than put in place. ${problems.length} problem(s):\n`
      + problems.slice(0, SHOWN).map((p) => `  • ${p}`).join('\n')
      + (problems.length > SHOWN ? `\n  • …and ${problems.length - SHOWN} more.` : '')
      + '\n\nThis is a bug in the cut, not something you did — the record is intact, and nothing '
      + 'was written.'
    );
  }
  return kept;
}

/**
 * Write the narration copy: the book, with the struck elements gone and (by
 * default) its footnote reference markers with them.
 *
 * THE INPUT IS NEVER TOUCHED. Every zip entry is copied across; the spine
 * documents that lose an element are re-serialized from the same DOM the unit
 * list was built on, and everything else — the OPF, the nav, the CSS, the
 * cropped figures — goes over byte for byte. So the official book stays the
 * complete book it was, which is the whole point of there being two files. That
 * holds whatever the book IS: a conversion foundry wrote, or a copy of an EPUB
 * the user imported (manifest-service `ensureBookEpub`), whose archive original
 * is never opened for writing either.
 *
 * `planNarrationRemoval` decides WHICH ELEMENTS come out and refuses a key the
 * book does not have; the document keys are answered here, against the spine,
 * because the spine is what says which documents the book has. The output is
 * written to `outputPath` and the caller is responsible for moving it into
 * place.
 */
export async function writeNarrationEpub(
  inputPath: string,
  outputPath: string,
  deletions: readonly NarrationElementKey[],
  options?: NarrationEpubWriteOptions,
): Promise<NarrationEpubWriteResult> {
  const { XMLSerializer } = require('@xmldom/xmldom');
  const whatFor = `the narration copy of ${path.basename(inputPath)}`;

  // One traversal of the book, kept: the plan is checked against exactly the
  // elements that are about to be rewritten, so a key cannot pass the check and
  // then miss the element.
  const processor = new EpubProcessor();
  const perFile = new Map<string, { doc: any; body: any; units: Array<{ key: string; el: any }> }>();
  const units: NarrationUnit[] = [];
  // The three structural files, remembered from the one traversal: the OPF says
  // which documents the book HAS, and the nav or the NCX says what it calls
  // them. Removing a document means editing all three, so all three are needed
  // after the processor is closed.
  let opfEntry = '';
  let navEntry: string | null = null;
  let ncxEntry: string | null = null;
  try {
    const structure = await processor.open(inputPath);
    opfEntry = normalizeZipEntryName(structure.opfPath);
    navEntry = structure.navPath ? normalizeZipEntryName(structure.navPath) : null;
    ncxEntry = structure.ncxPath ? normalizeZipEntryName(structure.ncxPath) : null;
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      if (perFile.has(entryName)) continue;  // a spine document listed twice is one file
      const xhtml = await processor.readFile(entryName);
      const { doc, body } = parseXhtmlBody(xhtml, entryName);
      const collected: Array<{ key: string; el: any }> = [];
      let indexInFile = 0;
      for (const c of collectExportUnits(doc, body, entryName)) {
        const key = narrationElementKey(entryName, indexInFile++);
        collected.push({ key, el: c.el });
        const stamp = conversionStampOnOrAbove(c.el, whatFor);
        units.push({
          key,
          category: stamp?.statedCategory ?? null,
          sourcePage: stamp?.sourcePage ?? null,
          // Read BEFORE any text override is applied below, which is what makes
          // it the book's own text — a fingerprint of "Chapter 2: An
          // Opportunity to Hope" would describe the cut, not the book.
          text: getUnitTextContent(c.el),
        });
      }
      // The pictures, enumerated in the SAME order and after the SAME unit walk
      // as `alignBlocksToEpub` — that is what makes `#img<N>` mean one thing to
      // the reader that records a strike and to this writer that applies it.
      collectImageElements(body).forEach((el, ordinal) => {
        const key = narrationImageElementKey(entryName, ordinal);
        collected.push({ key, el });
        const stamp = conversionStampOnOrAbove(el, whatFor);
        units.push({
          key,
          category: stamp?.statedCategory ?? null,
          sourcePage: stamp?.sourcePage ?? null,
          text: '',
        });
      });
      perFile.set(entryName, { doc, body, units: collected });
    }
  } finally {
    processor.close();
  }

  // ── The documents struck BY NAME ──────────────────────────────────────────
  //
  // `<zip entry>#doc` says the whole document goes. It is checked against the
  // SPINE — the one authority on which documents this book has — and a key
  // naming a document the book does not contain is refused by name, exactly as
  // an element key that names no element is. Reachable, and left reachable: the
  // record is no longer voided by a book that moved under it, so a `#doc` key
  // for a document a pass removed arrives here and is named rather than
  // reconciled by guessing.
  const split = splitNarrationDeletions(deletions);
  const struckDocuments = new Set(split.documents);
  const absent = split.documents.filter((file) => !perFile.has(file));
  if (absent.length > 0) {
    throw new Error(
      `${absent.length} of the document(s) struck out of this book are not in its spine any more — `
      + `the first is ${narrationDocumentKey(absent[0])}. A pass that removed a document leaves the `
      + 'strike on it naming nothing. Your strikes are still on record and nothing has been '
      + 'cleared: open the book in the editor, take back the ones that name documents this book no '
      + 'longer has, and export again.'
    );
  }

  const plan = planNarrationRemoval(units, split.elements, options?.verifyStrikes);
  const struck = new Set(plan.remove);
  // Everything inside a struck document counts as removed, because the document
  // it is in is not going to be in the copy. Counted through the set so an
  // element named both individually and by its document is one removal.
  for (const file of struckDocuments) {
    for (const unit of perFile.get(file)!.units) struck.add(unit.key);
  }

  const stripSups = options?.stripSupMarkers !== false;

  // ── The elements that speak a stated text instead of their printed one ────
  //
  // Applied to the tree HERE — after the strikes are known, before the
  // expectation signatures are computed — so everything downstream (the
  // signatures, the admission test, the serialization, the verification)
  // describes the overridden book. The element's children are replaced with
  // one text node: the override IS the whole utterance, single line.
  const overrideTouched = new Set<string>();
  let overriddenElements = 0;
  if (options?.textOverrides !== undefined) {
    const elByKey = new Map<string, any>();
    const fileByKey = new Map<string, string>();
    for (const [file, { units: fileUnits }] of perFile) {
      for (const unit of fileUnits) {
        elByKey.set(unit.key, unit.el);
        fileByKey.set(unit.key, file);
      }
    }
    for (const [key, spoken] of Object.entries(options.textOverrides)) {
      const el = elByKey.get(key);
      if (el === undefined) {
        throw new Error(
          `The narration copy was asked to speak "${spoken}" for ${key}, and this book has no `
          + 'element by that key. Nothing was written.'
        );
      }
      if (parseNarrationElementKey(key).kind === 'image') {
        throw new Error(
          `${key} is a picture, and a picture has no text to override. Nothing was written.`
        );
      }
      if (struck.has(key)) continue;  // leaving the copy anyway
      const text = spoken.replace(/\s+/g, ' ').trim();
      if (text.length === 0) {
        throw new Error(
          `The narration copy was asked to speak an EMPTY text for ${key}. Silencing an element `
          + 'is a strike, not an override. Nothing was written.'
        );
      }
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(el.ownerDocument.createTextNode(text));
      overrideTouched.add(fileByKey.get(key)!);
      overriddenElements++;
    }
  }

  // ── What the copy must contain, decided BEFORE anything is removed ────────
  //
  // Read off the tree as it still is, so the expectation is a statement about
  // the book rather than a restatement of the removal loop. A bug in that loop
  // cannot flow into the check that is supposed to catch it.
  //
  // ── The one thing a strike does that it was not asked to do ───────────────
  //
  // `collectExportUnits` admits an element as a unit when it holds an `<img>` OR
  // any text at all. So a wrapper whose ONLY content is a picture — the
  // `<div class="image">` a plate lives in — stops being a unit the moment that
  // picture is struck. It is not removed and it was never struck; it simply is
  // not there to be enumerated any more. Counting it as a survivor would fail
  // every correct cut of an image, so it is classified here, by the SAME
  // admission rule, against the content the copy will actually have.
  //
  // The mirror of it: a picture INSIDE a struck paragraph goes with the
  // paragraph. It was not struck by name and it is not coming back, because the
  // element that held it is what the user struck.
  // The rule itself lives in `signNarrationElements` above, because the pairing
  // that translates a strike made on the narration COPY back into the book needs
  // exactly this answer and the two must never disagree about it.
  const signedPerFile = signNarrationElements(
    new Map([...perFile].map(([file, { units: fileUnits }]) => [file, fileUnits])),
    struck,
    stripSups,
  );

  const rewrittenFiles: string[] = [];
  const emptied: string[] = [];
  /** Serialized survivors, held until the pruning set is known. */
  const replacementsFromDoc = new Map<string, string>();
  for (const [file, { doc, body, units: fileUnits }] of perFile) {
    // A document struck by name goes WITHOUT being asked whether removing its
    // elements happened to leave the body empty. `bodyIsEmpty` answers a
    // question about the unit walk — did everything it collects come out — and
    // the whole reason a document can be struck is that the unit walk does not
    // account for everything in it (the plate gallery's unmatchable pictures).
    //
    // The NAV is the one document that is never dropped, here for the same
    // reason it is exempt below: it is structure rather than content, and e2a
    // reads the book's chapter titles out of it. Striking it whole empties it,
    // which is what striking every element of it does today.
    if (struckDocuments.has(file) && file !== navEntry) {
      emptied.push(file);
      continue;
    }
    const toRemove = fileUnits.filter((u) => struck.has(u.key));
    // A file can need re-serializing with NOTHING struck in it: an override
    // rewrote one of its elements' text.
    if (toRemove.length === 0 && !overrideTouched.has(file)) continue;
    for (const unit of toRemove) {
      // An element whose parent has already gone with an ancestor is already
      // out of the tree; removing it again would throw in xmldom.
      if (unit.el.parentNode) unit.el.parentNode.removeChild(unit.el);
    }
    // The skip above is the ONE place a strike could quietly do nothing, so
    // detachment is asserted rather than assumed: an element still reachable
    // from the body after the pass is a strike that was planned, checked, and
    // then had no effect on the tree that is about to be serialized.
    const stillThere = toRemove.filter((u) => isStillInBody(u.el, body));
    if (stillThere.length > 0) {
      throw new Error(
        `${stillThere.length} element(s) struck out of ${file} are still in the document after `
        + `they were removed — the first is ${stillThere[0].key}. Nothing was written.`
      );
    }
    // ── The document the strikes emptied ──────────────────────────────────
    //
    // Removing the ELEMENTS is not the whole job. A spine document whose body
    // is left with nothing in it is still a document, and mupdf lays it out as
    // a BLANK PAGE — so a user who deleted 64 pages, exported, and opened the
    // copy to check saw blank pages exactly where their deletions were and read
    // it as "the deletions didn't work". The narration was never affected (an
    // empty body narrates as nothing), but the whole point of being able to
    // open the copy is to verify intent, and a ghost page defeats that.
    //
    // The NAV DOCUMENT is never pruned, however empty it looks. It is
    // structure rather than content — it is what says what the book's chapters
    // are called, and e2a reads its titles — so a book that struck out its
    // printed contents page must still end up with a navigable book.
    if (bodyIsEmpty(body) && file !== navEntry) {
      emptied.push(file);
      continue;  // no point serializing a document that is about to be dropped
    }
    let serialized: string = new XMLSerializer().serializeToString(doc);
    if (!serialized.startsWith('<?xml')) {
      serialized = `<?xml version="1.0" encoding="utf-8"?>\n${serialized}`;
    }
    rewrittenFiles.push(file);
    perFile.get(file)!.doc = doc;
    replacementsFromDoc.set(file, serialized);
  }

  const pruned = new Set(emptied);

  // ── The expectation, now that the pruning set is known ────────────────────
  //
  // A dropped document takes its remaining elements with it — the plate wrapper
  // whose picture was struck, the `<img>` inside a struck paragraph. Those are
  // DISSOLVED: gone from the copy without having been struck by name, and
  // counted apart so the arithmetic below still adds up.
  //
  // The prune decision is checked rather than trusted: a document is only
  // allowed to be dropped when nothing the output's own walk would enumerate is
  // left in it. Otherwise a bug in `bodyIsEmpty` would silently take a chapter
  // out of the copy and this check would bless it.
  const expectations: NarrationCutExpectation[] = [];
  let dissolved = 0;
  for (const [file, signed] of signedPerFile) {
    const dropped = pruned.has(file);
    const keptUnits: NarrationSignedElement[] = [];
    const keptImages: NarrationSignedElement[] = [];
    const struckHere: NarrationSignedElement[] = [];
    const survivingInDroppedDocument: string[] = [];
    for (const el of signed) {
      if (struck.has(el.key)) {
        struckHere.push({ key: el.key, signature: el.signature });
        continue;
      }
      if (dropped) {
        dissolved++;
        if (el.admitted) survivingInDroppedDocument.push(el.key);
        continue;
      }
      if (!el.admitted) { dissolved++; continue; }
      (el.kind === 'image' ? keptImages : keptUnits).push(
        { key: el.key, signature: el.signature });
    }
    if (survivingInDroppedDocument.length > 0) {
      await removeEpubContainer(outputPath);
      throw new Error(
        `${file} was taken out of the narration copy, but ${survivingInDroppedDocument.length} `
        + `element(s) in it were never struck — the first is ${survivingInDroppedDocument[0]}. `
        + 'Nothing was written.'
      );
    }
    expectations.push({ file, removed: dropped, keptUnits, keptImages, struck: struckHere });
  }

  const replacements = new Map<string, Buffer>();

  // The surviving documents are serialized AFTER the pruning set is known,
  // because a link inside one of them may point at a document that is going —
  // and that can only be answered once every document has been judged.
  for (const [file, serialized] of replacementsFromDoc) {
    const { doc } = perFile.get(file)!;
    let text = serialized;
    if (pruned.size > 0 && neutralizeLinksToPruned(doc, pruned, file) > 0) {
      text = new XMLSerializer().serializeToString(doc);
      if (!text.startsWith('<?xml')) {
        text = `<?xml version="1.0" encoding="utf-8"?>\n${text}`;
      }
    }
    replacements.set(file, Buffer.from(text, 'utf8'));
  }

  // A document that lost NOTHING can still link into one that is going, so the
  // untouched documents are checked too — and rewritten only if they had one.
  if (pruned.size > 0) {
    for (const [file, { doc }] of perFile) {
      if (pruned.has(file) || replacements.has(file)) continue;
      if (neutralizeLinksToPruned(doc, pruned, file) === 0) continue;
      let text: string = new XMLSerializer().serializeToString(doc);
      if (!text.startsWith('<?xml')) text = `<?xml version="1.0" encoding="utf-8"?>\n${text}`;
      replacements.set(file, Buffer.from(text, 'utf8'));
      rewrittenFiles.push(file);
    }
  }

  let removedSupMarkers = 0;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await rewriteEpubEntries({
    from: inputPath,
    to: outputPath,
    // ── ZIP, stated, because the narration copy is one of the two BOUNDARIES ──
    //
    // `<stem>.tts.epub` is handed to ebook2audiobook, which is third-party
    // Python with its own ebook parser and cannot be given a folder. It is not a
    // staged replacement for the book either — it is a second, smaller book — so
    // its container is its own and does not follow the working copy's.
    toKind: 'zip',
    build: async (zipReader, zipWriter) => {
    // ── The book's own account of itself, brought in line ──────────────────
    //
    // Three files say what this book contains, and all three are edited before
    // anything is written: the OPF (which documents exist, and in what order),
    // and whichever table of contents the book carries — the EPUB 3 nav, the
    // EPUB 2 NCX, or both. Leaving any of them naming a document that is not in
    // the zip produces a book that a strict reader refuses and that e2a reads a
    // chapter title out of for a chapter that does not exist.
    if (pruned.size > 0) {
      const opfXml = (await zipReader.readEntry(opfEntry)).toString('utf8');
      replacements.set(opfEntry, Buffer.from(pruneOpf(opfXml, pruned, opfEntry), 'utf8'));
      rewrittenFiles.push(opfEntry);

      if (navEntry !== null && zipReader.hasEntry(navEntry)) {
        const navXhtml = (await zipReader.readEntry(navEntry)).toString('utf8');
        replacements.set(
          navEntry, Buffer.from(pruneNavDocument(navXhtml, pruned, navEntry), 'utf8'));
        rewrittenFiles.push(navEntry);
      }
      if (ncxEntry !== null && zipReader.hasEntry(ncxEntry)) {
        const ncxXml = (await zipReader.readEntry(ncxEntry)).toString('utf8');
        replacements.set(ncxEntry, Buffer.from(pruneNcx(ncxXml, pruned, ncxEntry), 'utf8'));
        rewrittenFiles.push(ncxEntry);
      }
    }

    for (const entry of zipReader.getEntries()) {
      // The emptied documents themselves. Their images, styles and fonts stay:
      // this removes documents the strikes emptied, not assets, and an asset
      // another document still uses would take that document's picture with it.
      if (pruned.has(entry)) continue;

      let data = replacements.get(entry) ?? await zipReader.readEntry(entry);

      // The marker strip runs on the BYTES that are about to be written — after
      // the element removals, so a document that lost both is edited once, and
      // as a string edit so every byte of markup nobody asked to touch comes
      // through unchanged. Content documents only: the OPF and the nav have no
      // prose in them, and `<sup>` there would not be a footnote reference.
      //
      // KEPT unconditionally even though the book may already have been through
      // the Remove footnote references pass (`stripFootnoteReferencesFromBook`).
      // Stripping already-stripped text is a no-op by construction — the pattern
      // matches nothing, `removed` is 0 and the guard below leaves the entry's
      // bytes alone — so the two never fight, and a book that never ran the pass
      // still narrates clean. Making this conditional on the pass having run
      // would be a way for a book to reach a narrator with its markers in.
      if (stripSups && isContentDocumentEntry(entry)) {
        const stripped = stripFootnoteMarkerSups(data.toString('utf8'));
        if (stripped.removed > 0) {
          removedSupMarkers += stripped.removed;
          data = Buffer.from(stripped.text, 'utf8');
          if (!rewrittenFiles.includes(entry)) rewrittenFiles.push(entry);
        }
      }

      // `mimetype` is stored, never deflated — the EPUB spec requires it, and a
      // compressed one makes the book unopenable in strict readers.
      zipWriter.addFile(entry, data, entry !== 'mimetype');
    }
    },
  });

  // ── The promise, kept or the file destroyed ───────────────────────────────
  //
  // The staged file is read back and re-walked with the same two enumerations
  // that produced the keys. Nothing downstream sees a copy that failed this:
  // the staged file is deleted and the error names what survived, so a caller
  // that moves the file into place cannot move an unverified one — there is
  // none to move.
  let verified = 0;
  try {
    const kept = await verifyNarrationCut(outputPath, expectations, stripSups, whatFor);
    verified = kept;
    // The arithmetic of the plan, checked against the file: every element the
    // book had is still in the copy, or was struck out of it, or dissolved with
    // the thing that held it. `struck` is the UNION — an element named
    // individually AND by its document is one removal — so this is also the
    // assertion that `removedElements` means what it says.
    if (kept + struck.size + dissolved !== plan.total) {
      throw new Error(
        `The narration copy accounts for ${kept + struck.size + dissolved} of the book's `
        + `${plan.total} element(s): ${kept} still in the copy, ${struck.size} struck, `
        + `${dissolved} dissolved with what held them. Nothing was written.`
      );
    }
  } catch (err) {
    await removeEpubContainer(outputPath);
    throw err;
  }

  return {
    removedElements: struck.size,
    totalElements: plan.total,
    verifiedElements: verified,
    dissolvedElements: dissolved,
    removedSupMarkers,
    overriddenElements,
    rewrittenFiles,
    removedDocuments: emptied.sort(),
    unverifiableStrikes: plan.unverifiable,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The book edits — the two writes that rewrite the book's own markup
// ─────────────────────────────────────────────────────────────────────────────
//
// The chapter-opening FOLD (a gesture, one chapter, removes elements) and the
// chapter-opening NAMING (unattended, whole book, text only) are two edits with
// one anatomy: walk the book the way the narration writer walks it, change
// elements in the parsed tree, copy the zip with the touched documents replaced,
// and re-walk what was written before the caller is allowed to move it over the
// working copy. The four helpers below are that anatomy, held in one place so
// the two can never come to disagree about what an image is, what an element's
// text says, or how a book is written back out.

/**
 * Does this element hold a picture?
 *
 * Asked before ANY edit that would replace or remove an element's children,
 * because an `<img>` that goes with them renumbers the image walk under every
 * `#img<N>` strike on record — the exact reconciliation the two key namespaces
 * exist to avoid. The fold refuses over it; the naming pass skips the one
 * chapter and says so.
 */
function elementHoldsImage(el: any): boolean {
  return (el.tagName ?? '').toLowerCase() === 'img'
    || (el.getElementsByTagName?.('img')?.length ?? 0) > 0;
}

/** An element's text as the book prints it, whitespace collapsed to one line. */
function collapsedUnitText(el: any): string {
  return getUnitTextContent(el).replace(/\s+/g, ' ').trim();
}

/** One edited document, serialized as a book entry: XML declaration and all. */
function serializeEditedDocument(doc: any): Buffer {
  const { XMLSerializer } = require('@xmldom/xmldom');
  let serialized: string = new XMLSerializer().serializeToString(doc);
  if (!serialized.startsWith('<?xml')) {
    serialized = `<?xml version="1.0" encoding="utf-8"?>\n${serialized}`;
  }
  return Buffer.from(serialized, 'utf8');
}

/**
 * Copy a book to `outputPath` with the named entries replaced, and every other
 * entry copied byte for byte.
 *
 * The byte-for-byte half is the load-bearing half: a book edit is about the
 * documents it names, and an entry nobody edited coming out different would
 * make every diff of a working copy unreadable and every re-analysis of it
 * suspect. `mimetype` is stored, never deflated — the EPUB spec requires it,
 * and a compressed one makes the book unopenable in strict readers.
 */
/**
 * Is this zip entry a document that can hold PROSE?
 *
 * The one rule, two callers: `writeNarrationEpub` strips footnote markers out of
 * these files as it writes the narration copy, and `stripFootnoteReferencesFromBook`
 * strips them out of the same files in the book itself. The OPF and the NCX are
 * excluded by extension rather than by name — they hold no prose, and a `<sup>`
 * in either would not be a footnote reference — and if the two callers ever
 * disagreed about which files count, a marker would leave one file and stay in
 * the other, which is exactly the state a user would report as "the pass missed
 * some".
 */
export function isContentDocumentEntry(entry: string): boolean {
  return /\.(xhtml|html|htm)$/i.test(entry);
}

/** What the footnote-reference strip did to a book. */
export interface FootnoteReferenceStrip {
  /** How many `<sup>` markers left the book. */
  removed: number;
  /** The zip entries that changed, in zip order. */
  files: string[];
  /**
   * How many elements the strip would have EMPTIED, kept audible with a
   * `[break]` instead. See `keepEmptiedUnitsAudible`.
   */
  breaks: number;
}

/**
 * Write a copy of `inputPath` with every footnote-reference superscript removed
 * from its content documents.
 *
 * ── Why this exists as a pass over the BOOK ─────────────────────────────────
 *
 * The strip used to happen only on the write of the narration copy, and the
 * header of shared/text/sup-markers.ts still says so of that path: the book was
 * never rewritten to take a marker out. Owen asked the question that changes it —
 * "if the user opens the working file and footnote reference numbers were
 * removed, will it show the change in the epub? will it show that the numbers are
 * actually gone? i.e. does it actually edit the text? we need a way to edit the
 * text directly" — and the answer is this function. The numbers leave the text
 * the user reads, not only the copy the narrator reads.
 *
 * ── The SAME rule, never a second implementation ────────────────────────────
 *
 * `stripFootnoteMarkerSups` is the discriminator, `isContentDocumentEntry` picks
 * the files, and both are shared with the narration writer. A pass that decided
 * for itself what a footnote marker is would drift from the copy the narrator
 * gets, and the two disagreeing is unfixable from the outside: the user would see
 * a number gone in the book and hear it read anyway, or the reverse.
 *
 * ── Text-only BY CONSTRUCTION, enumeration-stable BY REPAIR ─────────────────
 *
 * A `<sup>` is inline, inside a block the export walk enumerates; removing one
 * takes characters out of that block and leaves every block where it was. That
 * is what lets this be a LEDGER pass — the user's strikes and deletions name
 * block positions, and they must still name the same blocks afterwards. The
 * one way a text-only edit can still move the enumeration is an element whose
 * ENTIRE text was the marker: textless, it falls out of the walk, and every
 * position after it shifts. `keepEmptiedUnitsAudible` repairs exactly that
 * case with a `[break]`, and `registerLedgerPass` still measures the result
 * against the base and refuses the entry if a count moved anyway.
 *
 * Nothing else in the zip is touched — the untouched entries are copied through
 * as bytes, `mimetype` stored uncompressed, and the edit is a string replace so
 * the publisher's markup around each marker comes through exactly as written.
 */
export async function stripFootnoteReferencesFromBook(
  inputPath: string,
  outputPath: string,
): Promise<FootnoteReferenceStrip> {
  const replacements = new Map<string, Buffer>();
  const files: string[] = [];
  let removed = 0;
  let breaks = 0;

  const zipReader = await openEpubSource(inputPath);
  try {
    for (const entry of zipReader.getEntries()) {
      if (!isContentDocumentEntry(entry)) continue;
      const before = (await zipReader.readEntry(entry)).toString('utf8');
      const stripped = stripFootnoteMarkerSups(before);
      if (stripped.removed === 0) continue;
      const repaired = keepEmptiedUnitsAudible(before, stripped.text, entry);
      replacements.set(entry, repaired ? repaired.data : Buffer.from(stripped.text, 'utf8'));
      breaks += repaired ? repaired.breaks : 0;
      files.push(entry);
      removed += stripped.removed;
    }
  } finally {
    zipReader.close();
  }

  await writeBookWithReplacedEntries(inputPath, outputPath, replacements);
  return { removed, files, breaks };
}

/**
 * Keep an element the strip just emptied in the book's enumeration, by giving
 * it a `[break]` to say.
 *
 * ── The edge this repairs (Owen, 2026-08-09) ────────────────────────────────
 *
 * A paragraph whose ENTIRE text was one footnote marker — a bare `<p><sup>55</sup></p>`
 * between two prose paragraphs — comes out of the strip with no text at all,
 * and `collectExportUnits` does not enumerate a textless, imageless element.
 * One element vanishing from a file's walk shifts the position key of every
 * element after it, which is exactly what `registerLedgerPass`'s structural
 * guard exists to refuse: the pass would apply, but its ledger entry — the
 * thing that makes it deletable — would be refused.
 *
 * Owen picked the repair: "we could put [break] in instead of leaving it
 * blank". `[break]` is SML the pipeline already speaks — e2a realizes it as a
 * pause, the sentence tooling strips SML tokens on read — and a paragraph that
 * held only a footnote marker WAS a beat of silence in the audiobook all
 * along. So the element keeps one token of text, stays enumerated, and says
 * nothing.
 *
 * ── Only elements the STRIP emptied ─────────────────────────────────────────
 *
 * An element that was already textless in the base was already outside the
 * enumeration, and giving IT a `[break]` would ADD an element to the walk —
 * the same key shift from the other direction. So each unit is judged against
 * its counterpart in the before-document: text before, none after, no image
 * (an element with an `<img>` stays enumerated regardless of text). The two
 * walks pair 1:1 by document order because the strip removes only `<sup>`
 * subtrees, and `sup` is not a unit tag.
 *
 * Innermost first: a `<div>` whose only text lived in an inner `<p>` reads as
 * emptied too, but healing the `<p>` heals it — each candidate is re-read from
 * the live DOM after earlier injections, so exactly one `[break]` lands, in
 * the deepest element that needs it.
 *
 * Returns null when nothing needed repair — the caller then keeps the string
 * strip's byte-exact edit. A repaired file round-trips through the DOM
 * serializer instead (same trade `nameChapterOpeningsInBookFile` makes), which
 * is confined to the files that would otherwise have broken the ledger entry.
 */
function keepEmptiedUnitsAudible(
  beforeXhtml: string,
  afterXhtml: string,
  entry: string,
): { data: Buffer; breaks: number } | null {
  const whatFor = `the footnote-reference strip of ${entry}`;

  // The REAL enumeration, on throwaway parses: `collectExportUnits`'s
  // catch-all MUTATES its document (it wraps stray text runs in synthesized
  // divs), so it may never run on a DOM that is about to be serialized into
  // the book. Counting it here — instead of approximating "would this element
  // be enumerated" — is what keeps this repair from firing on an emptied
  // element that never counted (a <p> nested in a still-texted <blockquote>
  // is covered by the quote, and a [break] in it would be a pause the book
  // never had).
  const unitCountOf = (xhtml: string): number => {
    const { doc, body } = parseXhtmlBody(xhtml, whatFor);
    return collectExportUnits(doc, body, whatFor).length;
  };

  const beforeCount = unitCountOf(beforeXhtml);
  if (unitCountOf(afterXhtml) === beforeCount) return null;

  const before = parseXhtmlBody(beforeXhtml, whatFor);
  const after = parseXhtmlBody(afterXhtml, whatFor);
  const unitTagsOf = (body: any): any[] => {
    const units: any[] = [];
    const walk = (node: any): void => {
      if (node.nodeType !== 1) return;
      if (EXPORT_UNIT_TAGS.has(node.tagName?.toLowerCase() || '')) units.push(node);
      if (!node.childNodes) return;
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    };
    walk(body);
    return units;
  };

  // Paired 1:1 by document order: the strip removes only <sup> subtrees and
  // `sup` is not a unit tag, so the two walks see the same elements. A length
  // mismatch means this file's markup broke that assumption, and the pass must
  // not guess which element is which.
  const beforeUnits = unitTagsOf(before.body);
  const afterUnits = unitTagsOf(after.body);
  if (beforeUnits.length !== afterUnits.length) {
    throw new Error(
      `${whatFor} changed the document's structure: ${beforeUnits.length} unit element(s) before, `
      + `${afterUnits.length} after. The strip removes only <sup> subtrees, so this file's markup `
      + 'is doing something this pass does not understand. Nothing was written.'
    );
  }

  let breaks = 0;
  for (let i = afterUnits.length - 1; i >= 0; i--) {
    if (normalizeForAlignment(getUnitTextContent(beforeUnits[i])).length === 0) continue;
    if (normalizeForAlignment(getUnitTextContent(afterUnits[i])).length > 0) continue;
    const el = afterUnits[i];
    if (el.getElementsByTagName('img').length > 0) continue;
    el.appendChild(after.doc.createTextNode('[break]'));
    breaks++;
  }

  const repaired = serializeEditedDocument(after.doc);
  const repairedCount = unitCountOf(repaired.toString('utf8'));
  if (repairedCount !== beforeCount) {
    throw new Error(
      `${whatFor} could not keep the document's enumeration stable: ${beforeCount} unit element(s) `
      + `before the strip, ${repairedCount} after repairing ${breaks} emptied element(s) with `
      + '[break]. The ledger entry for this pass would mis-key every record after this point, so '
      + 'nothing was written.'
    );
  }
  return { data: repaired, breaks };
}

async function writeBookWithReplacedEntries(
  inputPath: string,
  outputPath: string,
  replacements: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const bookName = path.basename(inputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await rewriteEpubEntries({
    from: inputPath,
    to: outputPath,
    toKind: await stagedContainerKindFor(inputPath),
    build: async (source, sink) => {
      for (const entry of replacements.keys()) {
        if (!source.hasEntry(entry)) {
          throw new Error(
            `${bookName}'s spine lists ${entry} but its zip does not contain it, so there is nothing `
            + 'to rewrite. Nothing was written.'
          );
        }
      }
      for (const entry of source.getEntries()) {
        const replacement = replacements.get(entry);
        const data = replacement === undefined ? await source.readEntry(entry) : replacement;
        sink.addFile(entry, data, entry !== 'mimetype');
      }
    },
  });
}

/**
 * One entry's bytes, exactly as the book holds them.
 *
 * For the callers that have to be able to put a document BACK — an in-place
 * edit whose own verification refuses it. Bytes rather than the decoded string
 * the edit parsed: restoring means restoring, and re-encoding a string is a
 * claim about this file's encoding rather than a copy of its contents. The
 * refusal names the entry, because a caller asking for a document the book does
 * not have is a bug in the caller and not a missing file.
 */
async function readOneEpubEntry(bookPath: string, entry: string): Promise<Buffer> {
  const source = await openEpubSource(bookPath);
  try {
    if (!source.hasEntry(entry)) {
      throw new Error(
        `${path.basename(bookPath)} has no entry ${entry}, so its current bytes cannot be read.`);
    }
    return await source.readEntry(entry);
  } finally {
    source.close();
  }
}

/** One element the fold took out, and what it said before it went. */
export interface FoldedChapterElement {
  key: NarrationElementKey;
  /** Its text as the book printed it, whitespace collapsed. */
  textBefore: string;
}

/** What the fold did to one book file, in the terms an edit log records. */
export interface ChapterOpeningFoldResult {
  /** The zip entry the fold rewrote. */
  file: string;
  openerKey: NarrationElementKey;
  /** The opening's text before the fold, whitespace collapsed. */
  openerTextBefore: string;
  /** The opening's text after it: the chapter's stored name, single line. */
  openerTextAfter: string;
  folded: FoldedChapterElement[];
  /**
   * The TEXT-unit indices the fold removed from that file, ascending.
   *
   * The whole reason the strike record has to be carried rather than
   * re-stamped: everything after them is renumbered
   * (shared/vlm/narration-deletions.ts, `migrateNarrationDeletionsForFold`).
   */
  removedIndices: number[];
  /** How many text units the file held before the fold, and after. */
  unitsBefore: number;
  unitsAfter: number;
}

/**
 * Fold a chapter's opening: the opening element is rewritten to say the
 * chapter's stored name, and the elements folded into it are removed from the
 * markup.
 *
 * ── Why this EDITS the book, where everything else copies it ────────────────
 *
 * Because a chapter header is a fact about the book, not about one narration.
 * A chapter that prints "2" over an "An Opportunity to Hope" subhead is called
 * "Chapter 2: An Opportunity to Hope" in its own table of contents, and every
 * reader of the working copy — the viewer, the aligner, the narration cut, a
 * phone — should see one opening that says so. Doing it as a narration-time
 * override left the working copy still saying "2", so the correction had to be
 * re-derived by every consumer and was visible to none of them.
 *
 * Owen, 2026-08-09: "as long as we have a record of what it was before and what
 * it was changed to, it can be changed." The record is the caller's
 * (`outputs.epub.bookEdits`); the guarantee this function makes is that the
 * INPUT is never touched — the result is written to `outputPath`, and the
 * caller moves it into place. The archive original is never in this path at
 * all: the working copy is what a caller hands in.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 *
 * A key naming a picture, keys in two different files, an opener in its own
 * folded list, a key the file does not have, and — the one that is not
 * obvious — an element holding an `<img>`. Removing one of those would delete
 * a picture the user never asked to lose AND renumber the image walk under
 * every `#img<N>` strike on record, which is exactly the reconciliation the
 * key namespaces exist to avoid.
 */
export async function foldChapterOpeningInBookFile(
  inputPath: string,
  outputPath: string,
  openerKey: NarrationElementKey,
  foldedKeys: readonly NarrationElementKey[],
  name: string,
): Promise<ChapterOpeningFoldResult> {
  const bookName = path.basename(inputPath);
  const whatFor = `the chapter-opening fold in ${bookName}`;

  const spoken = name.replace(/\s+/g, ' ').trim();
  if (spoken.length === 0) {
    throw new Error(
      'A chapter opening cannot be folded into an empty name. Silencing an opening is a strike, '
      + 'not a fold. Nothing was written.'
    );
  }

  // ── The keys, taken apart before the book is opened ───────────────────────
  const opener = parseNarrationElementKey(openerKey);
  if (opener.kind !== 'unit') {
    throw new Error(
      `${openerKey} names ${opener.kind === 'image' ? 'a picture' : 'a whole document'}, and a `
      + 'chapter opening is a text element. Nothing was written.'
    );
  }
  const file = opener.file;
  const foldedIndices: number[] = [];
  const seen = new Set<NarrationElementKey>();
  for (const key of foldedKeys) {
    if (key === openerKey) {
      throw new Error(
        `${openerKey} is the chapter opening and is also listed among the elements to fold into `
        + 'it, so the fold would remove the very element it writes the name into. Nothing was '
        + 'written.'
      );
    }
    if (seen.has(key)) continue;  // the same element named twice is one removal
    seen.add(key);
    const parsed = parseNarrationElementKey(key);
    if (parsed.kind !== 'unit') {
      throw new Error(
        `${key} names ${parsed.kind === 'image' ? 'a picture' : 'a whole document'}, and only text `
        + 'elements can be folded into a chapter opening. Nothing was written.'
      );
    }
    if (parsed.file !== file) {
      throw new Error(
        `${key} is in ${parsed.file} and the chapter opening ${openerKey} is in ${file}. A fold is `
        + 'one chapter of one document, so the two cannot be folded together. Nothing was written.'
      );
    }
    foldedIndices.push(parsed.index);
  }

  // ── The one document, enumerated EXACTLY as the narration writer does ─────
  //
  // Same walk, same order, same minting: `collectExportUnits` then
  // `collectImageElements`. That is what makes a key the picker recorded and a
  // key resolved here the same element (electron/quire-stamp.ts is the third
  // caller of the same pair, and there is no fourth).
  const processor = new EpubProcessor();
  let doc: any;
  let body: any;
  const elByKey = new Map<NarrationElementKey, any>();
  let unitsBefore = 0;
  let imagesBefore = 0;
  try {
    const structure = await processor.open(inputPath);
    const spine = new Set(
      structure.chapters.map((c) => normalizeZipEntryName(processor.resolvePath(c.href))));
    if (!spine.has(file)) {
      throw new Error(
        `${bookName} has no spine document ${file}, so ${openerKey} names no element in this book. `
        + 'Nothing was written.'
      );
    }
    const parsed = parseXhtmlBody(await processor.readFile(file), file);
    doc = parsed.doc;
    body = parsed.body;
    for (const c of collectExportUnits(doc, body, whatFor)) {
      elByKey.set(narrationElementKey(file, unitsBefore++), c.el);
    }
    collectImageElements(body).forEach((el, ordinal) => {
      elByKey.set(narrationImageElementKey(file, ordinal), el);
      imagesBefore++;
    });
  } finally {
    processor.close();
  }

  const resolve = (key: NarrationElementKey): any => {
    const el = elByKey.get(key);
    if (el === undefined) {
      throw new Error(
        `${file} holds ${unitsBefore} text element(s), so ${key} names nothing in it. The book has `
        + 'been rewritten since these blocks were laid out; re-open it and fold again. Nothing was '
        + 'written.'
      );
    }
    return el;
  };

  const openerEl = resolve(openerKey);
  const foldedEls = foldedIndices.map((index) => ({
    key: narrationElementKey(file, index),
    el: resolve(narrationElementKey(file, index)),
  }));

  // ── No picture leaves the book by accident ────────────────────────────────
  //
  // The opener is checked too, and not only out of politeness to the picture:
  // its children are replaced by the name, so an `<img>` inside it would go the
  // same way a folded one would, and the image walk under every `#img<N>` on
  // record would renumber beneath a key namespace this fold promises not to
  // touch.
  if (elementHoldsImage(openerEl)) {
    throw new Error(
      `${openerKey} holds a picture, and writing the chapter name into it would take that picture `
      + 'out of the book. Nothing was written.'
    );
  }
  for (const folded of foldedEls) {
    if (elementHoldsImage(folded.el)) {
      throw new Error(
        `${folded.key} holds a picture, and folding it into the chapter opening would delete that `
        + 'picture from the book. Strike it instead if it should not be narrated. Nothing was '
        + 'written.'
      );
    }
  }

  const openerTextBefore = collapsedUnitText(openerEl);
  const folded: FoldedChapterElement[] = foldedEls.map((f) => ({
    key: f.key, textBefore: collapsedUnitText(f.el),
  }));

  // ── The edit ──────────────────────────────────────────────────────────────
  //
  // The opening's children are replaced with ONE text node, because the name is
  // the whole utterance: a `<h1>` that keeps a `<span class="num">2</span>`
  // beside the name is a heading that says the number twice.
  while (openerEl.firstChild) openerEl.removeChild(openerEl.firstChild);
  openerEl.appendChild(doc.createTextNode(spoken));

  for (const f of foldedEls) {
    // An element whose parent already went with an ancestor is out of the tree
    // already; removing it again throws in xmldom.
    if (f.el.parentNode) f.el.parentNode.removeChild(f.el);
  }
  const stillThere = foldedEls.filter((f) => isStillInBody(f.el, body));
  if (stillThere.length > 0) {
    throw new Error(
      `${stillThere.length} element(s) folded into ${openerKey} are still in ${file} after they `
      + `were removed — the first is ${stillThere[0].key}. Nothing was written.`
    );
  }

  // ── The book, with exactly one entry replaced ─────────────────────────────
  await writeBookWithReplacedEntries(
    inputPath, outputPath, new Map([[file, serializeEditedDocument(doc)]]));

  // ── The promise, kept or the file destroyed ───────────────────────────────
  //
  // The written file is re-walked with the same two enumerations that produced
  // the keys, because the arithmetic the caller is about to migrate a strike
  // record by is exactly this: N text units became N − |folded|, the opening
  // sits at its old index minus the folds before it and says the name, and not
  // one picture moved. A file that does not read back that way is deleted
  // rather than handed to a caller that will move it over the working copy.
  const removedIndices = foldedIndices.slice().sort((a, b) => a - b);
  const openerIndexAfter =
    opener.index - removedIndices.filter((i) => i < opener.index).length;
  try {
    // Through the factory, which gives its handle back when the open FAILS. A
    // bare `new ZipReader(p)` + `open()` takes an fs descriptor before it parses
    // the central directory, so a book that does not read back as an archive left
    // that descriptor held — and the very next thing this site does is DELETE the
    // file it could not read, which on Windows is exactly what a held descriptor
    // makes impossible. The refusal would then say "Nothing was written" over a
    // book that was still sitting there.
    const check = await openEpubSource(outputPath);
    let unitsAfter = 0;
    let imagesAfter = 0;
    let openerTextAfter = '';
    try {
      const written = parseXhtmlBody((await check.readEntry(file)).toString('utf8'), file);
      const units = collectExportUnits(written.doc, written.body, whatFor);
      unitsAfter = units.length;
      imagesAfter = collectImageElements(written.body).length;
      if (openerIndexAfter < units.length) {
        openerTextAfter = collapsedUnitText(units[openerIndexAfter].el);
      }
    } finally {
      check.close();
    }
    if (unitsAfter !== unitsBefore - removedIndices.length) {
      throw new Error(
        `${file} held ${unitsBefore} text element(s), ${removedIndices.length} were folded away, `
        + `and the rewritten file holds ${unitsAfter} rather than `
        + `${unitsBefore - removedIndices.length}. Nothing was written.`
      );
    }
    if (imagesAfter !== imagesBefore) {
      throw new Error(
        `${file} held ${imagesBefore} picture(s) and the rewritten file holds ${imagesAfter}. A `
        + 'fold moves no picture, so the strikes recorded against them would now name the wrong '
        + 'ones. Nothing was written.'
      );
    }
    if (openerTextAfter !== spoken) {
      throw new Error(
        `${file}'s chapter opening should read "${spoken}" after the fold and reads `
        + `"${openerTextAfter}". Nothing was written.`
      );
    }
    return {
      file,
      openerKey,
      openerTextBefore,
      openerTextAfter,
      folded,
      removedIndices,
      unitsBefore,
      unitsAfter,
    };
  } catch (err) {
    await removeEpubContainer(outputPath);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming the chapter openings — what every book gets, the moment it opens
// ─────────────────────────────────────────────────────────────────────────────

/** One chapter opening this pass rewrote, and what it printed before. */
export interface NamedChapterOpening {
  /** The zip entry the opening is in. */
  file: string;
  openerKey: NarrationElementKey;
  /** What it printed before, whitespace collapsed: "2", "CHAPTER TWO", "". */
  textBefore: string;
  /** What it says now: the chapter's stored name, single line. */
  textAfter: string;
}

/** One chapter this pass left alone, and why. It is never a refusal. */
export interface UnnamedChapterOpening {
  file: string;
  /** The opening it was about, or null when the document has none. */
  openerKey: NarrationElementKey | null;
  /**
   * Declared in `shared/` because the PICKER is told which of these happened to
   * the chapter it just renamed, and the sentence it says about that is chosen
   * by one pure rule over these kinds (`chapterOpeningRefusal`). A second
   * spelling of the union here would let the two drift.
   */
  kind: UnnamedChapterOpeningKind;
  /** The sentence a log says about it. */
  reason: string;
}

/** What the naming pass did to a book, in the terms an edit log records. */
export interface ChapterOpeningNamingResult {
  edits: NamedChapterOpening[];
  skipped: UnnamedChapterOpening[];
}

/**
 * Write every named chapter's opening AS its stored name, book-wide.
 *
 * ── Why this is unattended, where the fold is a gesture ────────────────────
 *
 * Owen, 2026-08-09: "from the moment the book opens, the chapter openers
 * contain the chapter's text. period. the user will delete surrounding blocks
 * if they're unnecessary." A chapter that prints "2" over an "An Opportunity to
 * Hope" subhead is called "Chapter 2: An Opportunity to Hope" in its own table
 * of contents, and there is no version of this app in which the user should
 * have to ask, chapter by chapter, for the book to say what the book already
 * says about itself. So it is a normalization the project's open runs, not a
 * button — and the surrounding blocks stay exactly where they are, because
 * whether a subhead is worth narrating is a judgement, and judgements are the
 * user's.
 *
 * ── Why NOTHING is removed ────────────────────────────────────────────────
 *
 * Every edit here is text inside one element. No element leaves the markup, so
 * no text-unit index moves and no image ordinal moves, so every narration
 * strike on record still names the element it always named — which is why the
 * caller re-stamps the record onto the new bytes rather than migrating its
 * keys, and why this pass may run over a book that has been struck without
 * asking anybody anything.
 *
 * ── Why one odd chapter never blocks the rest ─────────────────────────────
 *
 * The fold REFUSES over an opening holding an `<img>`, because a person asked
 * for that one fold and is owed the reason. This pass runs unattended over a
 * whole book, so refusing would mean one picture-titled chapter stopping the
 * project from opening. It skips that chapter, reports it, and names the other
 * two hundred.
 *
 * `namesByFile` is zip entry → the name that chapter's opening should say. A
 * document with no entry keeps its printed text: its print IS its name.
 *
 * A book that already reads right is NOT copied to `outputPath` — see below.
 *
 * ── `outputPath` may BE `inputPath` ────────────────────────────────────────
 *
 * And for the working copy it is. This pass runs behind every relabel that
 * promotes a block to `chapter`, and while it staged its result and landed it
 * with `moveIntoPlace` that click re-created every entry of the book: on the
 * migrated Nuremberg project, 84 entries and 32.5 MB of page images copied
 * twice to rewrite one heading, which then also forced the `bookDigest` after
 * it to re-hash all 32.5 MB because every entry had a new inode and mtime.
 * Measured 2026-08-11: ~1.3 s of a promote-to-chapter click was that.
 *
 * In place, `DirectoryEpubSink` writes only the documents whose bytes moved.
 * The staged form is kept, because the tests use it and because a caller may
 * genuinely want the named book beside the original; the only difference is the
 * FAILURE arm. Staged, a verification that refuses deletes the staged book and
 * the original was never touched. In place there is nothing to delete but the
 * book, so EVERY document this pass rewrote is put back — all of them, in one
 * write — and "Nothing was written" stays true of the book the caller holds.
 *
 * ── `beforeWriting`, and the ordering it exists for ───────────────────────
 *
 * Asked once, after the pass knows exactly what it would write and before one
 * byte of it is written. Throwing from it is a refusal that leaves the book
 * untouched.
 *
 * It exists because `nameChapterOpenings` (electron/narration-export.ts) has a
 * judgement it can only make in that window: a book whose narration strikes no
 * longer describe it must not be rewritten, but a book with NOTHING TO NAME
 * must still open even when those strikes are void — this pass runs at every
 * project open. While the result was staged that ordering came for free, since
 * the caller could look at `edits` and then decline to land the staged copy.
 * Writing in place removes that window, so the caller is handed it here rather
 * than being made to walk the whole book twice to get it back.
 *
 * Absent means nobody wants to be asked, which is every caller that has already
 * decided.
 */
export async function nameChapterOpeningsInBookFile(
  inputPath: string,
  outputPath: string,
  namesByFile: ReadonlyMap<string, string>,
  beforeWriting?: (edits: readonly NamedChapterOpening[]) => void | Promise<void>,
): Promise<ChapterOpeningNamingResult> {
  const bookName = path.basename(inputPath);
  const inPlace = path.resolve(inputPath) === path.resolve(outputPath);

  const wanted = new Map<string, string>();
  for (const [file, raw] of namesByFile) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name.length === 0) {
      throw new Error(
        `${bookName}'s chapter openings cannot be named: ${file} was handed an empty name. An `
        + 'opening with no stored name keeps what it prints, and the caller decides that before it '
        + 'gets here rather than this pass silencing a heading. Nothing was written.'
      );
    }
    wanted.set(file, name);
  }

  // ── The book, walked ONCE, exactly as the narration writer walks it ───────
  //
  // `collectExportUnits` then `collectImageElements`, per spine document, in
  // spine order — the one walk that makes a key the picker recorded and a key
  // resolved here the same element (`writeNarrationEpub` above,
  // electron/quire-stamp.ts, and this).
  const processor = new EpubProcessor();
  const perFile = new Map<string, {
    doc: any; body: any; units: MarkupUnit[]; images: number;
  }>();
  try {
    const structure = await processor.open(inputPath);
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      if (perFile.has(entryName)) continue;  // a spine document listed twice is one file
      const { doc, body } = parseXhtmlBody(await processor.readFile(entryName), entryName);
      const units: MarkupUnit[] = [];
      let indexInFile = 0;
      for (const c of collectExportUnits(doc, body, entryName)) {
        units.push({
          file: entryName,
          key: narrationElementKey(entryName, indexInFile++),
          tag: c.tag,
          el: c.el,
          imageOnly: c.imageOnly,
          normText: c.normText,
        });
      }
      perFile.set(entryName, {
        doc, body, units, images: collectImageElements(body).length,
      });
    }
  } finally {
    processor.close();
  }

  // ── Which element opens each chapter ──────────────────────────────────────
  //
  // The book's own markup says, read by the ONE classifier
  // (`markupCategoriesForUnits`) over the WHOLE book — note targets are
  // resolved across documents and chapter openings are marked against the
  // navigation, so a per-document reading would be a different reading. This is
  // the same derivation `chapterSpeechOverrides` makes in
  // electron/narration-export.ts, and it must stay the same one: that override
  // is what the narration copy says, and this is what the book says.
  const allUnits: MarkupUnit[] = [];
  for (const walked of perFile.values()) allUnits.push(...walked.units);
  const { categoryByKey } = markupCategoriesForUnits(
    allUnits, await readEpubTocTargets(inputPath));

  const edits: NamedChapterOpening[] = [];
  const skipped: UnnamedChapterOpening[] = [];
  const replacements = new Map<string, Buffer>();
  /** What the written file must read back as, per edited document. */
  const expected: Array<{
    file: string; openerIndex: number; name: string; units: number; images: number;
  }> = [];

  for (const [file, walked] of perFile) {
    const name = wanted.get(file);
    if (name === undefined) continue;  // not a named chapter; its print is its name

    const openerIndex = walked.units.findIndex((u) => categoryByKey.get(u.key) === 'chapter');
    if (openerIndex < 0) {
      skipped.push({
        file, openerKey: null, kind: 'no-chapter-element',
        reason: `${file} is called "${name}" in the table of contents, and its markup marks no `
          + 'chapter opening in it, so there is no element to write that name into.',
      });
      continue;
    }
    const opener = walked.units[openerIndex];
    const openerKey = opener.key as NarrationElementKey;

    const textBefore = collapsedUnitText(opener.el);
    if (textBefore === name) {
      skipped.push({
        file, openerKey, kind: 'already-named',
        reason: `${file}'s opening already reads "${name}".`,
      });
      continue;
    }
    if (elementHoldsImage(opener.el)) {
      skipped.push({
        file, openerKey, kind: 'holds-image',
        reason: `${file}'s chapter opening holds a picture, and writing "${name}" into it would `
          + 'take that picture out of the book. This chapter keeps what it prints; the rest of the '
          + 'book was named.',
      });
      continue;
    }

    // The opening's children are replaced with ONE text node, because the name
    // is the whole utterance: a `<h1>` that keeps a `<span class="num">2</span>`
    // beside the name is a heading that says the number twice.
    while (opener.el.firstChild) opener.el.removeChild(opener.el.firstChild);
    opener.el.appendChild(walked.doc.createTextNode(name));

    edits.push({ file, openerKey, textBefore, textAfter: name });
    replacements.set(file, serializeEditedDocument(walked.doc));
    expected.push({
      file, openerIndex, name, units: walked.units.length, images: walked.images,
    });
  }

  // A book with nothing to name is NOT copied. This runs on every project open,
  // and writing a byte-for-byte duplicate of a fifty-megabyte book to disk to
  // discover that it was a duplicate is work nobody asked for. An empty `edits`
  // therefore means `outputPath` was never created — which is exactly what the
  // caller does with it either way. It also means `beforeWriting` is never
  // asked: there is nothing for it to decide about.
  if (replacements.size === 0) return { edits, skipped };

  // The last moment at which nothing has happened. A throw from here is a
  // refusal with the book exactly as it was found, in place or staged alike.
  if (beforeWriting !== undefined) await beforeWriting(edits);

  // What the documents this pass is about to rewrite hold RIGHT NOW, as BYTES,
  // kept only for the in-place write's failure arm — read from the book rather
  // than re-encoded from the strings the parse started with, because "put them
  // back exactly" is the whole point and a re-encode is a claim about each
  // file's encoding rather than a copy of it. Nothing is read for the staged
  // form: there the undo is deleting the staged book.
  const originalEntries = new Map<string, Buffer>();
  if (inPlace) {
    for (const file of replacements.keys()) {
      originalEntries.set(file, await readOneEpubEntry(inputPath, file));
    }
  }

  await writeBookWithReplacedEntries(inputPath, outputPath, replacements);

  // ── The promise, kept or the file destroyed ───────────────────────────────
  //
  // Re-walked with the same two enumerations that produced the keys, because
  // the caller is about to re-stamp a positional strike record onto these bytes
  // WITHOUT migrating a single key, and the claim that entitles it to is
  // checked here: the document holds the same number of text units it held and
  // the same number of pictures, and the opening — still at its own index,
  // since nothing was removed — reads the name.
  try {
    // Through the factory, which gives its handle back when the open FAILS. A
    // bare `new ZipReader(p)` + `open()` takes an fs descriptor before it parses
    // the central directory, so a book that does not read back as an archive left
    // that descriptor held — and the very next thing this site does is DELETE the
    // file it could not read, which on Windows is exactly what a held descriptor
    // makes impossible. The refusal would then say "Nothing was written" over a
    // book that was still sitting there.
    const check = await openEpubSource(outputPath);
    try {
      for (const want of expected) {
        const written = parseXhtmlBody(
          (await check.readEntry(want.file)).toString('utf8'), want.file);
        const units = collectExportUnits(written.doc, written.body, want.file);
        const images = collectImageElements(written.body).length;
        if (units.length !== want.units) {
          throw new Error(
            `${want.file} held ${want.units} text element(s) and the rewritten file holds `
            + `${units.length}. Naming a chapter opening removes nothing, so every narration `
            + 'strike recorded against this book would now name the wrong element. Nothing was '
            + 'written.'
          );
        }
        if (images !== want.images) {
          throw new Error(
            `${want.file} held ${want.images} picture(s) and the rewritten file holds ${images}. `
            + 'Naming a chapter opening moves no picture. Nothing was written.'
          );
        }
        const reads = collapsedUnitText(units[want.openerIndex].el);
        if (reads !== want.name) {
          throw new Error(
            `${want.file}'s chapter opening should read "${want.name}" and reads "${reads}". `
            + 'Nothing was written.'
          );
        }
      }
    } finally {
      check.close();
    }
  } catch (err) {
    if (!inPlace) {
      await removeEpubContainer(outputPath);
    } else {
      // In place, so there is no staged book to destroy — destroying `outputPath`
      // here would take the user's book with it. This pass rewrote these
      // documents and no others, and their bytes from before it are held above,
      // so putting ALL of them back restores exactly the book it was handed.
      // Through the same writer, and in ONE write, so the undo lands the same
      // atomic way the naming did rather than one chapter at a time.
      await writeBookWithReplacedEntries(inputPath, outputPath, originalEntries);
    }
    throw err;
  }

  return { edits, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Element identity — the stamp that makes an element a THING rather than a place
//
// ── What is wrong with a position ───────────────────────────────────────────
//
// Every record this app keeps about a book element — a narration strike, a
// chapter marker, a saved deletion, a layout row — names it `<zip entry>#<index>`:
// the element's PLACE in one enumeration walk. A place is not an identity. Any
// edit that adds or removes an element renumbers every element after it, so
// every record past the edit now names a different paragraph, and the app has
// grown a whole apparatus to survive that: sha256 stamps that void a record when
// the bytes move, structural guards that refuse a ledger entry when a count
// changes, fingerprint-and-carry migrations that renumber strikes across a fold.
// All of it exists because the book has no way to say "this element is that
// element".
//
// ── What this is ────────────────────────────────────────────────────────────
//
// `data-bf-uid` on every narration unit and every picture of the WORKING COPY.
// Short, random, unique within the book, and once written never changed: the
// element carries its own name, and an edit somewhere else in the document
// cannot take it away. Phase 2 migrates the key formats onto it and retires the
// compensation machinery above; phase 1 — this — only makes sure the stamp
// EXISTS and that every writer preserves it.
//
// ── Why the working copy and not the archive ────────────────────────────────
//
// Because the archive original is immutable (memory:
// pipeline-source-model-archive-as-source) and the working copy is the one file
// this app edits. A stamp is an edit.
//
// ── Why the synthesized wrappers become real ────────────────────────────────
//
// `collectExportUnits` MUTATES the document it walks: a run of stray text that no
// element covers is moved into a synthesized `<div>` so it can be a unit at all.
// Every caller has been throwing that mutation away and re-doing it on the next
// parse, which means those units are phantoms — elements that exist in memory,
// during a walk, and nowhere on disk. An identity cannot be given to a phantom.
//
// So this pass PERSISTS them: the wrapper is written into the book and becomes
// real markup with a real uid. Ratified by Owen, 2026-08-10 — the working copy is
// the one editable file, and elements that exist only in memory are exactly the
// disease. It means the first stamp of such a book writes structural markup, and
// it moves NOTHING: the wrapper was already in the walk every reader performed,
// at the same index, so the enumeration before and after this pass is identical.
// That claim is measured below and the file is destroyed if it fails.
//
// ── Why re-running it writes nothing ────────────────────────────────────────
//
// A book whose every walked element already carries a uid is not copied. The
// bytes stamp the narration strike record and key the layout caches, so writing
// a book that differs only in its zip timestamps would void both for nothing.
// This is the same contract the naming pass keeps, for the same reasons.
// ─────────────────────────────────────────────────────────────────────────────

/** The attribute an element's stable identity is written as. */
export const ELEMENT_UID_ATTR = 'data-bf-uid';

/**
 * A fresh element id: four random bytes as hex, the same shape a ledger entry's
 * suffix uses. Short enough to read in a diff, wide enough that a book of a
 * hundred thousand elements does not collide by accident — and it is checked
 * for collision anyway.
 *
 * It contains only `[0-9a-f]`, which is what keeps it out of trouble with the
 * two characters that already mean something: `#` separates a document from an
 * index in a narration key, and `|` separates the ids sharing one quire stamp.
 */
function mintElementUid(): string {
  return crypto.randomBytes(4).toString('hex');
}

/** What the element-id stamp did to a book. */
export interface ElementIdStampResult {
  /** How many elements were given an id they did not have. */
  stamped: number;
  /** Every walked element of the book, stamped now or already. */
  total: number;
  /** The zip entries rewritten, in spine order. Empty when nothing was written. */
  files: string[];
  /**
   * How many synthesized wrappers this pass turned into real markup. Nonzero
   * only on a book's FIRST stamp, and only where the source had stray text.
   */
  wrappersPersisted: number;
}

/**
 * Give every narration unit and every picture of a book a stable id, in the
 * book.
 *
 * A book that already carries one on every walked element is NOT copied to
 * `outputPath` — see the section header above for why that is a contract and not
 * an optimization. An empty `files` therefore means `outputPath` was never
 * created.
 */
export async function stampElementIdsInBookFile(
  inputPath: string,
  outputPath: string,
): Promise<ElementIdStampResult> {
  const bookName = path.basename(inputPath);
  const whatFor = `the element-id stamp of ${bookName}`;

  // ── The book, walked ONCE, exactly as the narration writer walks it ───────
  //
  // `collectExportUnits` then `collectImageElements`, per spine document, in
  // spine order — the one walk that makes a key the picker recorded and a key
  // resolved here the same element.
  const processor = new EpubProcessor();
  const perFile = new Map<string, {
    doc: any;
    /** Every walked element of this document: text units then pictures. */
    elements: any[];
    units: number;
    images: number;
    wrappers: number;
  }>();
  const order: string[] = [];
  try {
    const structure = await processor.open(inputPath);
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      if (perFile.has(entryName)) continue;  // a spine document listed twice is one file
      const { doc, body } = parseXhtmlBody(await processor.readFile(entryName), entryName);
      // Every element the DOCUMENT holds, before the walk touches it. What the
      // walk then produces that is not in this set is an element the walk MADE:
      // a synthesized wrapper. `fromCatchAll` does not answer that question —
      // the catch-all's other form collects an EXISTING element (an `<i>` whose
      // text no unit covers), which is already real markup and needs no writing.
      const preexisting = new Set<any>();
      const noteElements = (node: any): void => {
        if (node.nodeType === 1) preexisting.add(node);
        if (!node.childNodes) return;
        for (let i = 0; i < node.childNodes.length; i++) noteElements(node.childNodes[i]);
      };
      noteElements(body);

      const elements: any[] = [];
      let wrappers = 0;
      for (const c of collectExportUnits(doc, body, entryName)) {
        elements.push(c.el);
        if (!preexisting.has(c.el)) wrappers++;
      }
      const units = elements.length;
      for (const el of collectImageElements(body)) elements.push(el);
      perFile.set(entryName, { doc, elements, units, images: elements.length - units, wrappers });
      order.push(entryName);
    }
  } finally {
    processor.close();
  }

  // ── The ids the book already carries ──────────────────────────────────────
  //
  // Read before a single one is minted, so a fresh id can be checked against
  // them. A book carrying the SAME id on two elements has no identity to build
  // on and is refused by name: nothing this app writes can produce that state
  // (a merge keeps the first source's id and drops the rest), so a book in it
  // has been edited by something else and guessing which element is the real
  // one would be forging an answer.
  const taken = new Set<string>();
  for (const [file, walked] of perFile) {
    for (const el of walked.elements) {
      const existing = el.getAttribute?.(ELEMENT_UID_ATTR);
      if (existing === null || existing === undefined || existing === '') continue;
      if (existing.includes('#') || existing.includes('|')) {
        throw new Error(
          `${file} carries the element id "${existing}", which contains a character that already `
          + 'separates the parts of a key (`#` a document from an index, `|` the ids sharing one '
          + 'stamp). An id no key can be built out of is not an identity. Nothing was written.'
        );
      }
      if (taken.has(existing)) {
        throw new Error(
          `${bookName} carries the element id "${existing}" on more than one element (${file}). An `
          + 'id that names two elements names neither, and nothing this app writes can produce '
          + 'that. Nothing was written.'
        );
      }
      taken.add(existing);
    }
  }

  // ── The stamp ─────────────────────────────────────────────────────────────
  let stamped = 0;
  let total = 0;
  let wrappersPersisted = 0;
  const replacements = new Map<string, Buffer>();
  const files: string[] = [];
  /** Every id this book should carry when it is read back, by document. */
  const expected = new Map<string, { ids: string[]; units: number; images: number }>();

  for (const file of order) {
    const walked = perFile.get(file)!;
    const ids: string[] = [];
    let mintedHere = 0;
    for (const el of walked.elements) {
      total++;
      const existing = el.getAttribute?.(ELEMENT_UID_ATTR);
      if (existing !== null && existing !== undefined && existing !== '') {
        ids.push(existing);
        continue;
      }
      if (typeof el.setAttribute !== 'function') {
        throw new Error(
          `${file} holds an element the walk produced that cannot be given an id (a <`
          + `${(el.tagName ?? '?').toLowerCase()}> with no attributes). Every element the walk `
          + 'produces is an element a record can name, so one that cannot be stamped would be a '
          + 'silent hole in the book\'s identity. Nothing was written.'
        );
      }
      let uid = mintElementUid();
      while (taken.has(uid)) uid = mintElementUid();
      taken.add(uid);
      el.setAttribute(ELEMENT_UID_ATTR, uid);
      ids.push(uid);
      stamped++;
      mintedHere++;
    }
    // A document is rewritten when it gained an id OR when its walk synthesized
    // a wrapper — the wrapper is the mutation this pass exists to make real, and
    // a document whose only change was one would otherwise be left with a
    // phantom element forever.
    if (mintedHere > 0 || walked.wrappers > 0) {
      replacements.set(file, serializeEditedDocument(walked.doc));
      files.push(file);
      wrappersPersisted += walked.wrappers;
      expected.set(file, { ids, units: walked.units, images: walked.images });
    }
  }

  if (replacements.size === 0) return { stamped: 0, total, files: [], wrappersPersisted: 0 };

  await writeBookWithReplacedEntries(inputPath, outputPath, replacements);

  // ── The promise, kept or the file destroyed ───────────────────────────────
  //
  // Re-walked with the same two enumerations that produced the ids, and the
  // written file must prove three things. That it holds the same elements it
  // held, in the same numbers — which is what entitles the caller to re-stamp a
  // positional strike record onto these bytes without migrating a key, and what
  // makes persisting a wrapper a no-op for every existing record. That every
  // walked element carries exactly ONE id and no id is used twice. And that the
  // document carries no id the walk did not produce — a stamp on an element
  // nothing enumerates is an identity nothing can resolve.
  try {
    // Through the factory, which gives its handle back when the open FAILS. A
    // bare `new ZipReader(p)` + `open()` takes an fs descriptor before it parses
    // the central directory, so a book that does not read back as an archive left
    // that descriptor held — and the very next thing this site does is DELETE the
    // file it could not read, which on Windows is exactly what a held descriptor
    // makes impossible. The refusal would then say "Nothing was written" over a
    // book that was still sitting there.
    const check = await openEpubSource(outputPath);
    try {
      const seen = new Set<string>();
      for (const [file, want] of expected) {
        const written = parseXhtmlBody((await check.readEntry(file)).toString('utf8'), file);
        const units = collectExportUnits(written.doc, written.body, whatFor);
        const images = collectImageElements(written.body);
        if (units.length !== want.units || images.length !== want.images) {
          throw new Error(
            `${file} held ${want.units} text element(s) and ${want.images} picture(s), and the `
            + `stamped file holds ${units.length} and ${images.length}. Stamping an element adds `
            + 'no element and removes none, so every narration strike recorded against this book '
            + 'would now name the wrong element. Nothing was written.'
          );
        }
        const walkedNow = [...units.map((u) => u.el), ...images];
        const ids: string[] = [];
        for (const el of walkedNow) {
          const uid = el.getAttribute?.(ELEMENT_UID_ATTR);
          if (uid === null || uid === undefined || uid === '') {
            throw new Error(
              `${file} came out of the stamp with an element that carries no id. A book whose `
              + 'identity is incomplete is one no record can be keyed to. Nothing was written.'
            );
          }
          if (seen.has(uid)) {
            throw new Error(
              `${file} came out of the stamp carrying the id "${uid}" on more than one element. An `
              + 'id that names two elements names neither. Nothing was written.'
            );
          }
          seen.add(uid);
          ids.push(uid);
        }
        if (ids.join('|') !== want.ids.join('|')) {
          throw new Error(
            `${file} came out of the stamp carrying different ids, or the same ids in a different `
            + 'order, than the walk that wrote them produced. Nothing was written.'
          );
        }

        // No id the walk did not produce: read off the BYTES, not the walk, so a
        // stamp hiding on an element nothing enumerates is caught.
        const mine = new Set(ids);
        const raw = (await check.readEntry(file)).toString('utf8');
        const re = new RegExp(`${ELEMENT_UID_ATTR}="([^"]*)"`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          if (!mine.has(m[1])) {
            throw new Error(
              `${file} carries the element id "${m[1]}" on something the walk does not enumerate, `
              + 'so it is an identity nothing can resolve. Nothing was written.'
            );
          }
        }
      }
    } finally {
      check.close();
    }
  } catch (err) {
    await removeEpubContainer(outputPath);
    throw err;
  }

  return { stamped, total, files, wrappersPersisted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relabelling one element — the picker's category change, written into the book
// ─────────────────────────────────────────────────────────────────────────────

/** One element relabelled, in the terms an edit log records. */
export interface BookElementCategoryEdit {
  /** The zip entry the element lives in. */
  file: string;
  /** `<zip entry>#<index>` — the element, unmoved by this edit. */
  elementKey: NarrationElementKey;
  /** The element's tag, so the record names something a person can find. */
  tag: string;
  /**
   * What the BOOK said this element was before, or null when it said nothing.
   *
   * Null is a real state and not a missing value: a `document`-class book can
   * carry an element nothing stamped (its nav TOC, hand-added markup), and the
   * category such a block wears on screen is the analyzer's classifier's rather
   * than the book's. Recording `''` there would claim the book had said
   * something it never said.
   */
  categoryBefore: string | null;
  /** What it says now — a member of the one palette. */
  categoryAfter: string;
  /** Its text, whitespace collapsed and cut short, so the record names the thing. */
  excerpt: string;
}

/** What a relabel did to one book file. */
export interface BookElementCategoryResult {
  /** False when the book already said this and no byte was written. */
  written: boolean;
  edit: BookElementCategoryEdit;
}

/** One element in a relabel, and what the caller says it is. */
export interface BookElementCategoryRequest {
  elementKey: NarrationElementKey;
  categoryId: string;
}

/**
 * Write a user's category for one element INTO the book.
 *
 * ── What this actually has to satisfy ──────────────────────────────────────
 *
 * Not "stamp an attribute" — "make every reader read it". The reader that
 * matters most is the unattended naming pass, which finds a chapter's opening
 * through `markupCategoriesForUnits` and re-runs at every project open; before
 * this existed it read the book's TAGS and the navigation labels and knew
 * nothing about a relabel, which is exactly why Owen's promoted `title` was
 * refused with "its markup marks no chapter opening in it". So the override is
 * applied inside that one classifier and inside both stamp readers, and the
 * check at the bottom of this function re-reads the WRITTEN FILE through
 * `readEpubElementCategories` and destroys it unless the book now answers with
 * the category that was asked for. The guarantee is the reading, not the
 * attribute.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 *
 * A category outside the palette; a key naming a picture or a whole document; a
 * document this book's spine does not have; a key naming no element in that
 * document. Each names the thing and why, and nothing is written.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 *
 * It moves no element, removes none and adds none — the edit is one attribute on
 * one element — so every text-unit index and every image ordinal is where it
 * was, and the caller re-stamps the positional strike record onto the new bytes
 * rather than migrating its keys. That is the same claim the naming pass makes,
 * and it is checked the same way: the rewritten document must hold the same
 * number of text units and the same number of pictures.
 *
 * The TAG is deliberately left alone. A chapter opening is not a `<h1>` — it is
 * whatever the reading calls `chapter` — and rewriting a publisher's `<p
 * class="ct">` into a heading would restyle their page to make a category
 * legible to a reader that now reads the category directly.
 *
 * ── `outputPath` may BE `inputPath`, and for the working copy it is ────────
 *
 * `rewriteEpubEntries` has always taken `from === to` (electron/epub-container.ts),
 * and for an exploded book that is what makes the "editing one chapter writes
 * one file" promise true: `DirectoryEpubSink` writes only the entries whose
 * bytes actually moved. Writing somewhere else and landing the result with
 * `moveIntoPlace` re-creates all 84 of Nuremberg's entries — 32 MB of page
 * images copied twice, for one attribute — and, worse, leaves every entry with a
 * new inode and a new mtime, so the two `bookDigest` calls that bracket the edit
 * have to hash all 32 MB again as well. Measured 2026-08-11: 1500 ms for one
 * click, ~1050 ms of it that copying and the re-hashing it forced.
 *
 * The staged form is kept — the tests use it, and so does anything that wants
 * the edited book beside the original — so the difference is only in the FAILURE
 * arm. Staged, a verification that fails deletes the staged book and the book
 * itself was never touched. In place there is nothing to delete but the book, so
 * the touched documents' original bytes are put back instead, and "Nothing was
 * written" stays true of the book the caller still has.
 *
 * ── Why this takes a LIST ──────────────────────────────────────────────────
 *
 * A person relabels a RUN of blocks, not one. The picker sent them one at a
 * time and awaited each, so a twenty-block selection paid twenty times for the
 * three whole-book steps that do not depend on how many elements are named: the
 * reading of every spine document that says what the book calls them, the write,
 * and the reading that verifies it. Measured on the migrated Nuremberg project,
 * 2026-08-11, one element cost ~500 ms and roughly 490 ms of that was those
 * three; a second element in the same gesture is a `setAttribute` and a
 * serialize.
 *
 * So the whole batch is read once, applied once, written once and verified once.
 * The per-element answer is unchanged — one `BookElementCategoryResult` each, in
 * the order asked, so the caller can tell the user what happened to each block.
 *
 * ── ALL OR NOTHING, and it is decided before the first byte ────────────────
 *
 * Every refusal this function has is raised for EVERY element BEFORE anything is
 * written: a category outside the palette, a key naming a picture or a document,
 * a key naming nothing, one element named twice. A batch with one bad element
 * writes none of them — half a gesture is the state the user cannot see and
 * cannot undo, and "which of my twenty landed?" is not a question this should
 * ever make them ask.
 *
 * An element the book ALREADY calls what the caller says is not a refusal — it
 * is `written: false` for that element and the rest of the batch proceeds, which
 * is the same idempotence the singular form has always had. A batch of nothing
 * but those writes no bytes at all.
 */
export async function setElementCategoriesInBookFile(
  inputPath: string,
  outputPath: string,
  requests: readonly BookElementCategoryRequest[],
): Promise<BookElementCategoryResult[]> {
  const bookName = path.basename(inputPath);
  // The gesture, named for whatever it is: the helpers below quote this in their
  // own refusals, and "the relabel of 12 elements" is what a person recognises
  // where a list of twelve keys is not. One element keeps the sentence it has
  // always had, so a single relabel's refusals read exactly as before.
  const whatFor = requests.length === 1
    ? `the relabel of ${requests[0].elementKey} in ${bookName}`
    : `the relabel of ${requests.length} elements in ${bookName}`;
  const inPlace = path.resolve(inputPath) === path.resolve(outputPath);

  if (requests.length === 0) {
    throw new Error(
      `A relabel of ${bookName} named no element at all. A caller that cannot say what it is `
      + 'labelling has nothing to ask for here. Nothing was written.'
    );
  }

  // ── Every refusal, for every element, before one byte ─────────────────────
  const targets: Array<{
    elementKey: NarrationElementKey; categoryId: string; file: string; index: number;
  }> = [];
  const named = new Set<string>();
  for (const request of requests) {
    const { elementKey, categoryId } = request;
    if (!BLOCK_CATEGORY_IDS.includes(categoryId)) {
      throw new Error(
        `"${categoryId}" is not a block category BookForge knows, so it cannot be written into `
        + `${bookName} as what ${elementKey} is. The palette is shared/ocr/block-categories.ts: `
        + `${BLOCK_CATEGORY_IDS.join(', ')}. Nothing was written.`
      );
    }

    const target = parseNarrationElementKey(elementKey);
    if (target.kind === 'doc') {
      throw new Error(
        `${elementKey} names a whole document, and a category is what one ELEMENT is. A document is `
        + 'not labelled; the things in it are. Nothing was written.'
      );
    }
    if (target.kind === 'image') {
      throw new Error(
        `${elementKey} names a picture, and a picture's category is what it is — every reading of `
        + 'every book calls it `image` because the block IS the plate, not because anything guessed. '
        + 'To keep a picture out of the audiobook, strike it instead. Nothing was written.'
      );
    }
    // Twice in one batch is a contradiction the caller has to resolve, not one
    // this function resolves by taking the last one it happened to read.
    if (named.has(elementKey)) {
      throw new Error(
        `${elementKey} is named twice in the same relabel, so this gesture says two things about `
        + 'one element. Which of them the book should end up saying is not something that can be '
        + 'decided here. Nothing was written.'
      );
    }
    named.add(elementKey);
    targets.push({ elementKey, categoryId, file: target.file, index: target.index });
  }

  // ── What the book says about them NOW ─────────────────────────────────────
  //
  // Through the ONE reader the analysis uses, so "the book already says this"
  // means the same thing here as it means on screen — and so a book that would
  // read the new category out of its own markup anyway is not rewritten for
  // nothing (the idempotence the naming pass keeps, for the same reasons: the
  // bytes carry the narration strikes' stamp and the analysis cache key).
  //
  // ONCE for the whole batch, and only over the documents the batch NAMES: this
  // used to walk every spine document and was the single most expensive thing
  // here (~125 ms on Nuremberg's 20, of which 106 ms was the parse). `only` is a
  // hint — a book whose reading is not per-document ignores it and answers about
  // the whole book, which is a superset and answers the same by key. See
  // `readEpubElementCategories`.
  const namedDocuments = new Set(targets.map((t) => t.file));
  const reading = await readEpubElementCategories(inputPath, namedDocuments);
  const factOfKey = new Map(reading.elements.map((e) => [e.key, e]));
  const facts = targets.map((target) => {
    const fact = factOfKey.get(target.elementKey);
    if (fact === undefined) {
      const inFile = reading.elements.filter(
        (e) => e.file === target.file && e.kind === 'text').length;
      throw new Error(
        inFile === 0
          ? `${bookName} has no document ${target.file}, so ${target.elementKey} names no element `
            + 'in this book. Nothing was written.'
          : `${target.file} holds ${inFile} text element(s), so ${target.elementKey} names nothing `
            + 'in it. The book has been rewritten since these blocks were laid out; re-open it and '
            + 'relabel again. Nothing was written.'
      );
    }
    const stated = reading.categoryByElement.get(target.elementKey);
    return { ...target, tag: fact.tag, categoryBefore: stated === undefined ? null : stated };
  });

  // ── The touched documents, enumerated EXACTLY as the narration writer does ─
  //
  // One parse per DOCUMENT however many of its elements the batch names — a run
  // of blocks the user dragged over is usually all in one chapter, and parsing
  // it once per block was most of what a batch used to cost.
  const touched = [...new Set(facts.map((f) => f.file))];
  const documents = new Map<string, {
    doc: any; units: any[]; imagesBefore: number;
  }>();
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(inputPath);
    const spine = new Set(
      structure.chapters.map((c) => normalizeZipEntryName(processor.resolvePath(c.href))));
    for (const file of touched) {
      if (!spine.has(file)) {
        const first = facts.find((f) => f.file === file)!;
        throw new Error(
          `${bookName} has no spine document ${file}, so ${first.elementKey} names no element in `
          + 'this book. Nothing was written.'
        );
      }
      const parsed = parseXhtmlBody(await processor.readFile(file), file);
      documents.set(file, {
        doc: parsed.doc,
        units: [...collectExportUnits(parsed.doc, parsed.body, whatFor)].map((c) => c.el),
        imagesBefore: collectImageElements(parsed.body).length,
      });
    }
  } finally {
    processor.close();
  }

  // ── What each element is, and which of them actually move a byte ──────────
  const results: BookElementCategoryResult[] = [];
  const elements: Array<{ el: any; categoryId: string }> = [];
  const rewritten = new Set<string>();
  for (const fact of facts) {
    const document = documents.get(fact.file)!;
    const el = document.units[fact.index];
    if (el === undefined) {
      throw new Error(
        `${fact.file} holds ${document.units.length} text element(s), so ${fact.elementKey} names `
        + 'nothing in it. The book has been rewritten since these blocks were laid out; re-open it '
        + 'and relabel again. Nothing was written.'
      );
    }

    const edit: BookElementCategoryEdit = {
      file: fact.file,
      elementKey: fact.elementKey,
      tag: fact.tag,
      categoryBefore: fact.categoryBefore,
      categoryAfter: fact.categoryId,
      excerpt: collapsedUnitText(el).slice(0, 120),
    };

    // The book already answers with this, and no override is needed to make it —
    // so nothing is written, exactly as a book whose openings already read their
    // names is not copied. The user's screen already showed this category.
    const override = userCategoryOf(el, whatFor);
    if ((fact.categoryBefore === fact.categoryId && override === null)
      || override === fact.categoryId) {
      results.push({ written: false, edit });
      continue;
    }
    elements.push({ el, categoryId: fact.categoryId });
    rewritten.add(fact.file);
    results.push({ written: true, edit });
  }

  // Every element in the batch was already labelled this way. No document is
  // rewritten, so — staged or in place — not one byte of the book moves, and the
  // caller is told so element by element.
  if (elements.length === 0) return results;

  // What the touched documents hold RIGHT NOW, as BYTES, kept only for the
  // in-place write's failure arm — read from the book rather than re-encoded
  // from the strings the parse started with, because "put them back exactly" is
  // the whole point and a re-encode is a claim about each file's encoding rather
  // than a copy of it. Nothing is read for the staged form: there the undo is
  // deleting the staged book.
  const originalEntries = new Map<string, Buffer>();
  if (inPlace) {
    for (const file of rewritten) originalEntries.set(file, await readOneEpubEntry(inputPath, file));
  }

  for (const { el, categoryId } of elements) el.setAttribute(USER_CATEGORY_ATTR, categoryId);
  const replacements = new Map<string, Buffer>();
  for (const file of rewritten) {
    replacements.set(file, serializeEditedDocument(documents.get(file)!.doc));
  }
  await writeBookWithReplacedEntries(inputPath, outputPath, replacements);

  // ── The promise, kept or the file destroyed ───────────────────────────────
  //
  // Two claims, both measured against the file on disk. That the edit MOVED
  // nothing, which is what entitles the caller to re-stamp the strike record
  // without migrating a key. And that the book now READS the new category
  // through the same reader the analysis uses — the claim that matters, because
  // an attribute no reader honours is the invisible overlay this replaces.
  //
  // Both are asked of EVERY element in the batch, including the ones that were
  // already labelled: their documents may have been rewritten around them, and
  // a reading that changed for a block nobody edited is exactly the kind of
  // damage this check exists to catch.
  try {
    // Through the factory, which gives its handle back when the open FAILS. A
    // bare `new ZipReader(p)` + `open()` takes an fs descriptor before it parses
    // the central directory, so a book that does not read back as an archive left
    // that descriptor held — and the very next thing this site does is DELETE the
    // file it could not read, which on Windows is exactly what a held descriptor
    // makes impossible. The refusal would then say "Nothing was written" over a
    // book that was still sitting there.
    const check = await openEpubSource(outputPath);
    const after = new Map<string, { units: number; images: number }>();
    try {
      for (const file of rewritten) {
        const written = parseXhtmlBody((await check.readEntry(file)).toString('utf8'), file);
        after.set(file, {
          units: collectExportUnits(written.doc, written.body, whatFor).length,
          images: collectImageElements(written.body).length,
        });
      }
    } finally {
      check.close();
    }
    for (const file of rewritten) {
      const document = documents.get(file)!;
      const counts = after.get(file)!;
      if (counts.units !== document.units.length) {
        throw new Error(
          `${file} held ${document.units.length} text element(s) and the rewritten file holds `
          + `${counts.units}. Relabelling an element removes nothing, so every narration strike `
          + 'recorded against this book would now name the wrong element. Nothing was written.'
        );
      }
      if (counts.images !== document.imagesBefore) {
        throw new Error(
          `${file} held ${document.imagesBefore} picture(s) and the rewritten file holds `
          + `${counts.images}. Relabelling an element moves no picture. Nothing was written.`
        );
      }
    }
    // The same documents the batch named — every element it is about lives in
    // one of them, so a wider reading would answer the identical questions.
    const readBack = (
      await readEpubElementCategories(outputPath, namedDocuments)).categoryByElement;
    for (const fact of facts) {
      const said = readBack.get(fact.elementKey);
      if (said !== fact.categoryId) {
        throw new Error(
          `${fact.elementKey} was written as "${fact.categoryId}" and ${bookName} reads it back as `
          + `${said === undefined ? 'nothing at all' : `"${said}"`}. A label the book does not `
          + 'answer with is the invisible correction this edit exists to end. Nothing was written.'
        );
      }
    }
  } catch (err) {
    if (!inPlace) {
      await removeEpubContainer(outputPath);
    } else {
      // In place, so there is no staged book to destroy — destroying `outputPath`
      // here would take the user's book with it. The edit touched these documents
      // and no others, and their bytes from before it are held above, so putting
      // ALL of them back restores exactly the book this function was handed.
      // Through the same writer, and in ONE write, so the undo lands the same
      // atomic way the edit did rather than one document at a time.
      await writeBookWithReplacedEntries(inputPath, outputPath, originalEntries);
    }
    throw err;
  }

  return results;
}

/**
 * One element's category, written into the book.
 *
 * The batch of one. Kept as its own name because most callers relabel one block
 * and because a `BookElementCategoryResult` rather than an array of them is what
 * they mean; every rule, refusal and sentence is
 * `setElementCategoriesInBookFile`'s, so there is one derivation and not two
 * that drift.
 */
export async function setElementCategoryInBookFile(
  inputPath: string,
  outputPath: string,
  elementKey: NarrationElementKey,
  categoryId: string,
): Promise<BookElementCategoryResult> {
  const [result] = await setElementCategoriesInBookFile(
    inputPath, outputPath, [{ elementKey, categoryId }]);
  return result;
}

/**
 * Sanitize text for rebuilt elements. Ported from the picker's
 * export.service.ts sanitizeText (kept byte-identical in behavior — the
 * process boundary forbids importing renderer code here).
 */
function sanitizeExportText(text: string): string {
  return text
    // Remove object replacement and replacement characters
    .replace(/[\uFFFC\uFFFD]/g, '')
    // Remove control characters except \n \r \t
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Remove zero-width characters
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Remove Private Use Area characters
    .replace(/[\uE000-\uF8FF]/g, '')
    // Collapse multiple spaces into one
    .replace(/  +/g, ' ')
    // Trim
    .trim();
}

/** Ported from export.service.ts escapeHtml — the legacy exporter's escaping. */
function escapeExportText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Ported from export.service.ts ensureTitleEndsWithPunctuation: TTS engines run
 * headings into the following text without punctuation, so add a period.
 */
function ensureTitleEndsWithPunctuation(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;
  const lastChar = trimmed[trimmed.length - 1];
  if (['.', '!', '?', ':', ';'].includes(lastChar)) {
    return trimmed;
  }
  return trimmed + '.';
}

/** Ported from export.service.ts generateUuid. */
function generateExportUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Serialize a whole unit element (own tag included), stripping the redundant
 * inline default-namespace declaration xmldom adds to a fragment serialized in
 * isolation — the chapter template declares it once on <html>. Prefixed namespaces
 * (xmlns:epub etc.) are left alone: xmldom re-declares them on the element,
 * which keeps the fragment well-formed on its own.
 */
function serializeUnitElement(el: any): string {
  const { XMLSerializer } = require('@xmldom/xmldom');
  return new XMLSerializer()
    .serializeToString(el)
    .replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
}

/**
 * Find, in document order, the first descendant <sup>/<a>/<span> whose
 * normalized text equals `markerNorm`. Used to surgically delete a footnote
 * marker from a verbatim element clone.
 */
function findMarkerDescendant(el: any, markerNorm: string): any | null {
  const MARKER_TAGS = new Set(['sup', 'a', 'span']);
  const search = (node: any): any | null => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType !== 1) continue;
      const tag = child.tagName?.toLowerCase() || '';
      if (MARKER_TAGS.has(tag) && normalizeForAlignment(getTextContent(child)) === markerNorm) {
        return child;
      }
      const nested = search(child);
      if (nested) return nested;
    }
    return null;
  };
  return search(el);
}

/**
 * Export the original EPUB with the picker's edits applied surgically.
 *
 * THROWS on any failure — an edit that cannot be honored must never be
 * silently dropped. Unaligned blocks the user never TOUCHED are the one
 * tolerated imperfection: they carry no edits, their source elements still
 * export verbatim (as uncovered units), so nothing is lost — they are counted
 * in `unalignedUntouched` and reported in `warnings`.
 */
export async function exportEpubPreservingMarkup(
  epubSourcePath: string,
  outputPath: string,
  edits: EpubPreservingEdits,
  /**
   * The container the result is written as — STATED by the caller, because the
   * two callers mean different things. The project's own export lands on the
   * working copy, which is a folder of the book's parts; a Save As lands on a
   * path the user picked in a file dialog, which is a file they will hand to
   * somebody. Inferring it from `outputPath` would guess, and the extension is
   * exactly the thing that stops being informative here.
   */
  outputKind: EpubContainerKind,
): Promise<{ chapterCount: number; blockCount: number; unalignedUntouched: number; warnings: string[] }> {
  const { blocks, effectiveTexts, chapters, metadata } = edits;
  const warnings: string[] = [];

  if (!metadata.title) {
    throw new Error('EPUB export requires a title — edits.metadata.title is missing.');
  }

  const blockById = new Map(blocks.map((b) => [b.id, b] as const));
  const hasCorrection = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(effectiveTexts, id);

  const { units, blockToUnits, unaligned } = await alignBlocksToEpub(epubSourcePath, blocks);

  // Blocks bound to chapter markers — their units render as synthesized
  // headings, never as body content (title dedup).
  const chapterBlockIds = new Set<string>();
  for (const ch of chapters) {
    if (ch.blockId) chapterBlockIds.add(ch.blockId);
    if (ch.mergedBlockIds) for (const id of ch.mergedBlockIds) chapterBlockIds.add(id);
  }

  // ── Policy: an unaligned block carrying an edit is fatal ──────────────────
  let unalignedUntouched = 0;
  for (const ua of unaligned) {
    const b = blockById.get(ua.blockId);
    if (!b) {
      throw new Error(`Alignment reported unknown block id "${ua.blockId}" — this is a bug.`);
    }
    const intents: string[] = [];
    if (b.deleted) intents.push('deletion');
    if (hasCorrection(b.id)) intents.push('text correction');
    if (chapterBlockIds.has(b.id)) intents.push('chapter title binding');
    if (intents.length > 0) {
      throw new Error(
        `EPUB-preserving export failed: block ${b.id} (page ${ua.page}) carries edits `
        + `(${intents.join(', ')}) but could not be aligned to the source EPUB `
        + `(${ua.reason}). Text: "${b.text.slice(0, 120)}"`,
      );
    }
    unalignedUntouched++;
  }
  if (unalignedUntouched > 0) {
    warnings.push(
      `${unalignedUntouched} untouched block(s) could not be aligned to the source EPUB; `
      + `their source elements are exported verbatim.`,
    );
  }

  // ── Per-unit covering blocks, in reading order ────────────────────────────
  const sortedBlocks = [...blocks].sort((a, b) => (a.page !== b.page ? a.page - b.page : a.y - b.y));
  const unitBlocks = new Map<number, EpubExportBlock[]>();
  for (const b of sortedBlocks) {
    const idxs = blockToUnits.get(b.id);
    if (!idxs) continue;
    for (const ui of idxs) {
      const list = unitBlocks.get(ui);
      if (list) list.push(b);
      else unitBlocks.set(ui, [b]);
    }
  }

  // ── Rebuild groups ────────────────────────────────────────────────────────
  // A merged picker block can span several units; rebuilding each of those
  // units from the block's full text would duplicate it. Units linked by a
  // shared covering block therefore rebuild TOGETHER: one element, the group's
  // blocks joined once, emitted at the first unit's position.
  const uf = Array.from({ length: units.length }, (_, i) => i);
  const ufFind = (x: number): number => {
    let root = x;
    while (uf[root] !== root) root = uf[root];
    while (uf[x] !== root) { const next = uf[x]; uf[x] = root; x = next; }
    return root;
  };
  const ufUnion = (a: number, b: number): void => {
    const ra = ufFind(a);
    const rb = ufFind(b);
    if (ra !== rb) uf[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const idxs of blockToUnits.values()) {
    for (let i = 1; i < idxs.length; i++) ufUnion(idxs[0], idxs[i]);
  }

  const groupBlocks = new Map<number, EpubExportBlock[]>(); // root → blocks, reading order
  for (const b of sortedBlocks) {
    const idxs = blockToUnits.get(b.id);
    if (!idxs || idxs.length === 0) continue;
    const root = ufFind(idxs[0]);
    const list = groupBlocks.get(root);
    if (list) list.push(b);
    else groupBlocks.set(root, [b]);
  }
  const groupNeedsRebuild = new Map<number, boolean>();
  for (const [root, gBlocks] of groupBlocks) {
    groupNeedsRebuild.set(root, gBlocks.some((b) => b.deleted || hasCorrection(b.id)));
  }

  // ── Deleted footnote markers ──────────────────────────────────────────────
  // Verbatim parent → surgically remove the marker element from a clone.
  // Rebuilt parent → remove the marker text from the parent block's
  // contribution to the join (more precise than searching the whole join,
  // where a bare digit could hit a neighboring block first).
  const markerTextRemovals = new Map<string, string[]>(); // parent block id → marker texts
  const unitClones = new Map<number, any>();
  const getClone = (ui: number): any => {
    let clone = unitClones.get(ui);
    if (!clone) {
      clone = units[ui].el.cloneNode(true);
      unitClones.set(ui, clone);
    }
    return clone;
  };

  for (const marker of sortedBlocks) {
    if (!marker.isFootnoteMarker || !marker.deleted) continue;
    if (!marker.parentBlockId) {
      throw new Error(
        `Deleted footnote marker ${marker.id} (page ${marker.page}, "${marker.text.slice(0, 40)}") `
        + `has no parentBlockId — cannot locate the element to edit.`,
      );
    }
    const parentBlock = blockById.get(marker.parentBlockId);
    if (!parentBlock) {
      throw new Error(
        `Deleted footnote marker ${marker.id} references parent block "${marker.parentBlockId}" `
        + `which is not in the export block list.`,
      );
    }
    if (parentBlock.deleted) continue; // the whole parent is going away — marker goes with it
    const parentUnits = blockToUnits.get(parentBlock.id);
    if (!parentUnits || parentUnits.length === 0) {
      throw new Error(
        `Deleted footnote marker "${marker.text}" (page ${marker.page}) cannot be applied: `
        + `its parent block ${parentBlock.id} is not aligned to any source element. `
        + `Parent text: "${parentBlock.text.slice(0, 120)}"`,
      );
    }
    const root = ufFind(parentUnits[0]);
    if (groupNeedsRebuild.get(root)) {
      const list = markerTextRemovals.get(parentBlock.id);
      if (list) list.push(marker.text);
      else markerTextRemovals.set(parentBlock.id, [marker.text]);
      continue;
    }
    const markerNorm = normalizeForAlignment(marker.text);
    if (markerNorm.length === 0) {
      throw new Error(
        `Deleted footnote marker ${marker.id} (page ${marker.page}) normalizes to empty text — `
        + `cannot match it against the source markup.`,
      );
    }
    let removed = false;
    for (const ui of parentUnits) {
      const clone = getClone(ui);
      const el = findMarkerDescendant(clone, markerNorm);
      if (el) {
        el.parentNode.removeChild(el);
        removed = true;
        break;
      }
    }
    if (!removed) {
      throw new Error(
        `Deleted footnote marker "${marker.text}" (page ${marker.page}) has no matching `
        + `<sup>/<a>/<span> descendant left in its parent element. `
        + `Parent text: "${parentBlock.text.slice(0, 120)}"`,
      );
    }
  }

  /** A block's contribution to a rebuilt element. */
  const effectiveBlockText = (b: EpubExportBlock): string => {
    let t = hasCorrection(b.id) ? effectiveTexts[b.id] : b.text;
    const removals = markerTextRemovals.get(b.id);
    if (removals) {
      for (const mt of removals) {
        const at = t.indexOf(mt);
        if (at === -1) {
          // A correction may legitimately have removed the marker already.
          warnings.push(
            `Deleted footnote marker "${mt}" was not found in the rebuilt text of block ${b.id} — `
            + `the text correction may already omit it.`,
          );
        } else {
          t = t.slice(0, at) + t.slice(at + mt.length);
        }
      }
    }
    return t;
  };

  const buildRebuildText = (root: number): string => {
    const pieces: string[] = [];
    for (const b of groupBlocks.get(root) ?? []) {
      if (b.deleted) continue;
      if (chapterBlockIds.has(b.id)) continue; // legacy title dedup inside content
      const t = sanitizeExportText(effectiveBlockText(b));
      if (t) pieces.push(t);
    }
    return pieces.join(' ');
  };

  const serializeVerbatim = (ui: number): string => {
    let el = unitClones.get(ui) ?? units[ui].el;
    // ALL <img> elements are dropped unconditionally (legacy behavior; no image
    // resources are packaged) — a <figure> keeps its caption, a <p> its text.
    if (el.getElementsByTagName('img').length > 0) {
      el = getClone(ui);
      const imgs: any[] = Array.from(el.getElementsByTagName('img'));
      for (const img of imgs) img.parentNode.removeChild(img);
    }
    return serializeUnitElement(el);
  };

  // ── Chapter boundaries (legacy semantics) ─────────────────────────────────
  const sortedChapters = [...chapters].sort((a, b) =>
    a.page !== b.page ? a.page - b.page : (a.y ?? 0) - (b.y ?? 0));
  const userDefinedChapters = sortedChapters.length > 0;

  // Boundary: the first aligned, non-deleted, non-marker block at/after the
  // marker position starts the chapter at its first covering unit. TOC-derived
  // chapters (no blockId) work purely positionally through the same rule.
  const orderedWalkBlocks = sortedBlocks.filter((b) =>
    !b.deleted && !b.isImage && !b.isFootnoteMarker && blockToUnits.has(b.id)
    && (blockToUnits.get(b.id) as number[]).length > 0);
  const chapterStartUnit: number[] = new Array(sortedChapters.length).fill(-1);
  let chapterWalkIdx = 0;
  for (const b of orderedWalkBlocks) {
    while (
      chapterWalkIdx < sortedChapters.length &&
      (b.page > sortedChapters[chapterWalkIdx].page ||
        (b.page === sortedChapters[chapterWalkIdx].page &&
          b.y >= (sortedChapters[chapterWalkIdx].y ?? 0)))
    ) {
      chapterStartUnit[chapterWalkIdx] = (blockToUnits.get(b.id) as number[])[0];
      chapterWalkIdx++;
    }
    if (chapterWalkIdx >= sortedChapters.length) break;
  }

  interface ExportSection { title: string; level: number; content: string[]; showHeading: boolean }
  const introSection: ExportSection = {
    title: 'Introduction',
    level: 1,
    content: [],
    showHeading: userDefinedChapters,
  };
  const chapterSections: ExportSection[] = sortedChapters.map((ch) => ({
    title: ch.title,
    level: ch.level || 1,
    content: [],
    showHeading: true,
  }));
  const resolvedChapters = sortedChapters
    .map((_, i) => i)
    .filter((i) => chapterStartUnit[i] >= 0);

  // ── Emit units into sections, document order ──────────────────────────────
  const emittedGroups = new Set<number>();
  let uncoveredEmitted = 0;
  let resolvedPtr = -1; // index into resolvedChapters of the current chapter

  for (let ui = 0; ui < units.length; ui++) {
    while (
      resolvedPtr + 1 < resolvedChapters.length &&
      chapterStartUnit[resolvedChapters[resolvedPtr + 1]] <= ui
    ) {
      resolvedPtr++;
    }
    const section = resolvedPtr < 0 ? introSection : chapterSections[resolvedChapters[resolvedPtr]];

    const u = units[ui];
    if (u.imageOnly) continue;

    const covering = unitBlocks.get(ui) ?? [];
    if (covering.length > 0 && covering.every((b) => chapterBlockIds.has(b.id))) {
      continue; // fully covered by chapter-title blocks — the heading is synthesized instead
    }

    if (covering.length === 0) {
      // No picker block matched this text — the user never saw it as an
      // editable row, so it cannot carry edits. Keep the book's own content.
      uncoveredEmitted++;
      section.content.push(serializeVerbatim(ui));
      continue;
    }

    const root = ufFind(ui);
    if (groupNeedsRebuild.get(root)) {
      if (emittedGroups.has(root)) continue; // group already emitted at its first unit
      emittedGroups.add(root);
      const text = buildRebuildText(root);
      if (text) {
        section.content.push(`<${u.tag}>${escapeExportText(text)}</${u.tag}>`);
      }
      // Empty result (every covering block deleted) → the element is omitted.
    } else {
      section.content.push(serializeVerbatim(ui));
    }
  }

  if (uncoveredEmitted > 0) {
    warnings.push(
      `${uncoveredEmitted} source element(s) had no matching picker block and were exported verbatim.`,
    );
  }

  // ── Assemble section list (legacy show/hide rules) ────────────────────────
  // Introduction only when it has content; chapter sections always (a
  // heading-only section is meaningful); chapters whose boundary never
  // resolved become trailing heading-only sections.
  const outSections: ExportSection[] = [];
  if (introSection.content.length > 0) outSections.push(introSection);
  for (const i of resolvedChapters) outSections.push(chapterSections[i]);
  for (let i = 0; i < sortedChapters.length; i++) {
    if (chapterStartUnit[i] < 0) outSections.push(chapterSections[i]);
  }

  if (outSections.length === 0) {
    throw new Error('No content to export after organizing by chapters.');
  }
  if (chapters.length > 0 && outSections.length === 1) {
    warnings.push(
      `Warning: ${chapters.length} chapters were defined, but only 1 chapter was generated. `
      + `This usually means the chapter page numbers don't match the text block page numbers. `
      + `The TTS engine will use automatic chapter detection instead.`,
    );
  }

  // ── Build the EPUB 3 (same shape as the legacy generateEpubBlobWithChapters)
  const uuid = 'urn:uuid:' + generateExportUuid();
  const date = new Date().toISOString().split('T')[0];

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const chapterManifest = outSections.map((_, i) =>
    `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join('\n');
  const chapterSpine = outSections.map((_, i) =>
    `    <itemref idref="chapter${i + 1}"/>`,
  ).join('\n');

  const authorMeta = metadata.author
    ? `    <dc:creator>${escapeExportText(metadata.author)}</dc:creator>`
    : '';
  const publisherMeta = metadata.publisher
    ? `    <dc:publisher>${escapeExportText(metadata.publisher)}</dc:publisher>`
    : '';
  const descriptionMeta = metadata.description
    ? `    <dc:description>${escapeExportText(metadata.description)}</dc:description>`
    : '';
  const dateMeta = metadata.year
    ? `    <dc:date>${escapeExportText(metadata.year)}</dc:date>`
    : '';

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${escapeExportText(metadata.title)}</dc:title>
${authorMeta}
${publisherMeta}
${descriptionMeta}
${dateMeta}
    <dc:language>${metadata.language || 'en'}</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapterManifest}
  </manifest>
  <spine>
${chapterSpine}
  </spine>
</package>`;

  const navItems = outSections.map((section, i) => {
    const indent = '      '.repeat(Math.max(1, section.level));
    return `${indent}<li><a href="chapter${i + 1}.xhtml">${escapeExportText(section.title)}</a></li>`;
  }).join('\n');

  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

  const chapterFiles = outSections.map((section, i) => {
    const level = Math.min(section.level, 3);
    const headingHtml = section.showHeading !== false
      ? `  <h${level}>${escapeExportText(ensureTitleEndsWithPunctuation(section.title))}</h${level}>\n`
      : '';
    return {
      name: `OEBPS/chapter${i + 1}.xhtml`,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeExportText(section.title)}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    h1 { font-size: 1.5em; margin-bottom: 1em; }
    h2 { font-size: 1.3em; margin-bottom: 0.8em; }
    h3 { font-size: 1.1em; margin-bottom: 0.6em; }
    p { margin: 0.5em 0; text-indent: 1em; }
  </style>
</head>
<body>
${headingHtml}${section.content.join('\n')}
</body>
</html>`,
    };
  });

  // Every chapter file must be well-formed XML — downstream mupdf and e2a parse
  // them. The units come from xmldom serialization so this should always hold;
  // assert it with the same parser before zipping.
  {
    const { DOMParser } = require('@xmldom/xmldom');
    for (const file of chapterFiles) {
      const parseProblems: string[] = [];
      const collect = (level: string) => (msg: string) => { parseProblems.push(`${level}: ${msg}`); };
      const doc = new DOMParser({
        errorHandler: { error: collect('error'), fatalError: collect('fatalError') },
      }).parseFromString(file.content, 'application/xhtml+xml');
      if (!doc || !doc.documentElement || parseProblems.length > 0) {
        throw new Error(
          `Generated chapter file ${file.name} is not well-formed XML: `
          + (parseProblems[0] ?? 'no document element produced'),
        );
      }
    }
  }

  const zipWriter = await createEpubSink(outputPath, outputKind);
  zipWriter.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zipWriter.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zipWriter.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zipWriter.addFile('OEBPS/nav.xhtml', Buffer.from(navXhtml, 'utf8'));
  for (const file of chapterFiles) {
    zipWriter.addFile(file.name, Buffer.from(file.content, 'utf8'));
  }
  await zipWriter.write(outputPath);

  return {
    chapterCount: outSections.length,
    blockCount: orderedWalkBlocks.length,
    unalignedUntouched,
    warnings,
  };
}


// ── Editing what an element SAYS ────────────────────────────────────────────

/** One element's text, before and after — the edit log's record of a fix. */
export interface BookElementTextEdit {
  file: string;
  elementKey: NarrationElementKey;
  tag: string;
  /** What the element read, collapsed, before the edit. */
  textBefore: string;
  /** What it reads now. */
  textAfter: string;
}

export interface BookElementTextResult {
  /** False when the element already read that way and no byte was written. */
  written: boolean;
  edit: BookElementTextEdit;
}

/** One text node of an element, and where its characters sit in the run. */
interface TextNodeSpan {
  node: any;
  /** Offset of this node's first character within the element's whole text. */
  start: number;
  /** One past its last. */
  end: number;
}

/**
 * The element's text nodes in document order, with their offsets in the text
 * `getUnitTextContent` reports.
 *
 * The SAME walk, skipping the same subtrees, because the offsets have to index
 * the string the rest of the app calls this element's text. A second description
 * of "which text belongs to this element" would put every splice out by however
 * much the two disagreed.
 */
function textNodeSpansOf(node: any, at = { offset: 0 }, out: TextNodeSpan[] = []): TextNodeSpan[] {
  if (node.nodeType === 3 || node.nodeType === 4) { // TEXT_NODE, CDATA_SECTION
    const value: string = node.nodeValue || '';
    out.push({ node, start: at.offset, end: at.offset + value.length });
    at.offset += value.length;
    return out;
  }
  if (node.nodeType !== 1) return out;
  const tag = node.tagName?.toLowerCase() || '';
  if (UNIT_TEXT_SKIP_TAGS.has(tag)) return out;
  if (!node.childNodes) return out;
  for (let i = 0; i < node.childNodes.length; i++) textNodeSpansOf(node.childNodes[i], at, out);
  return out;
}

/**
 * Say, in the book, what one element's text should read.
 *
 * ── Why this is an edit of the BOOK ────────────────────────────────────────
 *
 * For the same reason a category is (`electron/book-categories.ts`): the picker
 * has always been able to correct a block's text, and for a book that correction
 * lived in editor state, keyed by BLOCK ID, and was read by the picker's own
 * export and by nothing else. The narration cut, the preserving export, the
 * Chapter tab, the naming pass and the viewer all went on reading the book — so
 * a user who fixed a wrong chapter title saw it fixed on screen and heard the
 * old one in the audiobook. Owen, on the same shape of bug in categories: "it
 * apparently didnt actually change it to chapter, just visually?"
 *
 * A block id is also the wrong identity for it. `blockId(elementKey, page)` is a
 * function of the PAGE the element landed on, so a text correction was bound to
 * a pagination and had to be refused wholesale whenever the layout moved
 * (`shared/document/editor-layout.ts` counts them among the layout-keyed
 * records). Written into the book against the element key, it is bound to
 * nothing but the element.
 *
 * ── The smallest possible change ──────────────────────────────────────────
 *
 * `newText` is what the reader typed, and what they were shown was the
 * element's COLLAPSED text — so the difference between the two is worked out in
 * that space and translated back into markup offsets
 * (`shared/document/element-text-edit.ts`). Fixing one word rewrites one word.
 * Every byte of markup outside the changed span — an `<em>`, a footnote marker,
 * a line break the publisher put there — is untouched.
 *
 * What is REFUSED, rather than done destructively:
 *
 *  - a change whose span crosses an inline element, because applying it would
 *    delete that element's markup along with its words. Named, with the tag, so
 *    the user knows what is in the way.
 *  - a change that would leave the element with no text at all. An element that
 *    renders nothing gets no page from quire, and a book with one refuses to
 *    open — so emptying a block is not how a block gets deleted, and pretending
 *    otherwise would break the book at the next open rather than here.
 *  - anything that alters how many elements or pictures the document holds.
 *    Element keys are positions in the walk, so a text edit that moved one would
 *    leave every narration strike below it naming the wrong element.
 */
export async function setElementTextInBookFile(
  inputPath: string,
  outputPath: string,
  elementKey: NarrationElementKey,
  newText: string,
): Promise<BookElementTextResult> {
  const bookName = path.basename(inputPath);
  const whatFor = `the text edit of ${elementKey} in ${bookName}`;

  const target = parseNarrationElementKey(elementKey);
  if (target.kind === 'doc') {
    throw new Error(
      `${elementKey} names a whole document, and text is what one ELEMENT says. Nothing was `
      + 'written.'
    );
  }
  if (target.kind === 'image') {
    throw new Error(
      `${elementKey} names a picture, which has no text to correct. Nothing was written.`
    );
  }
  const file = target.file;

  const processor = new EpubProcessor();
  let doc: any;
  let el: any = null;
  let unitsBefore = 0;
  let imagesBefore = 0;
  try {
    const structure = await processor.open(inputPath);
    const spine = new Set(
      structure.chapters.map((c) => normalizeZipEntryName(processor.resolvePath(c.href))));
    if (!spine.has(file)) {
      throw new Error(
        `${bookName} has no spine document ${file}, so ${elementKey} names no element in this `
        + 'book. Nothing was written.'
      );
    }
    const parsed = parseXhtmlBody(await processor.readFile(file), file);
    doc = parsed.doc;
    for (const c of collectExportUnits(parsed.doc, parsed.body, whatFor)) {
      if (unitsBefore === target.index) el = c.el;
      unitsBefore++;
    }
    imagesBefore = collectImageElements(parsed.body).length;
  } finally {
    processor.close();
  }
  if (el === null) {
    throw new Error(
      `${file} holds ${unitsBefore} text element(s), so ${elementKey} names nothing in it. The `
      + 'book has been rewritten since these blocks were laid out; re-open it and edit again. '
      + 'Nothing was written.'
    );
  }

  const spans = textNodeSpansOf(el);
  const raw = spans.map((s) => s.node.nodeValue || '').join('');
  const textBefore = raw.replace(/\s+/g, ' ').trim();
  const wanted = newText.replace(/\s+/g, ' ').trim();
  const edit: BookElementTextEdit = {
    file, elementKey, tag: String(el.tagName || '').toLowerCase(), textBefore, textAfter: wanted,
  };

  if (wanted.length === 0) {
    throw new Error(
      `${elementKey} would be left with no text at all. An element that renders nothing gets no `
      + 'page, and a book with one in it does not open — so this is not how a block is removed. '
      + 'Strike it instead, which keeps it in the book and out of the audiobook. Nothing was '
      + 'written.'
    );
  }

  const splice = spliceForCollapsedText(raw, wanted);
  if (splice === null) return { written: false, edit };

  // ── Which text node the change belongs to ────────────────────────────────
  const touched = spans.filter((s) => s.start < splice.end && splice.start < s.end);
  let landing: TextNodeSpan | undefined;
  if (touched.length > 1) {
    const inTheWay = [...new Set(touched.map((s) => {
      const parent = s.node.parentNode;
      return parent && parent !== el ? String(parent.tagName || '').toLowerCase() : null;
    }).filter((t): t is string => t !== null))];
    throw new Error(
      `That change to ${elementKey} runs across ${touched.length} runs of text with markup between `
      + `them${inTheWay.length > 0 ? ` — ${inTheWay.map((t) => `<${t}>`).join(', ')}` : ''}, and `
      + 'applying it would delete that markup along with the words. Edit the text on one side of '
      + 'it at a time. Nothing was written.'
    );
  }
  if (touched.length === 1) {
    landing = touched[0];
  } else {
    // An insertion, which touches no character. It goes at the start of the run
    // that FOLLOWS it where there is one — so text appended after an `<em>`
    // lands outside it rather than inside — and otherwise at the end of the last
    // run, which is the only place left.
    landing = spans.find((s) => s.start === splice.start)
      ?? spans.find((s) => s.start <= splice.start && splice.start <= s.end);
  }
  if (landing === undefined) {
    throw new Error(
      `${elementKey} holds ${spans.length} run(s) of text and the change at character `
      + `${splice.start} falls in none of them. Nothing was written.`
    );
  }

  const value: string = landing.node.nodeValue || '';
  const edited =
    value.slice(0, splice.start - landing.start)
    + splice.replacement
    + value.slice(splice.end - landing.start);
  // BOTH, and not by choice. In @xmldom/xmldom a text node's `nodeValue` is an
  // ordinary assignable property, but `XMLSerializer` reads `data` — so setting
  // only `nodeValue` changes what every walk in this file reads back and NOTHING
  // about the bytes that get written, which is a silent no-op that verifies as
  // "the book reads it back as what it always said". Setting only `data` is the
  // mirror image: correct on disk, stale to the walks. Measured, not assumed.
  landing.node.data = edited;
  landing.node.nodeValue = edited;

  await writeBookWithReplacedEntries(
    inputPath, outputPath, new Map([[file, serializeEditedDocument(doc)]]));

  // ── The promise, kept or the file destroyed ───────────────────────────────
  try {
    const check = await openEpubSource(outputPath);
    let unitsAfter = 0;
    let imagesAfter = 0;
    let reads: string | null = null;
    try {
      const written = parseXhtmlBody((await check.readEntry(file)).toString('utf8'), file);
      for (const c of collectExportUnits(written.doc, written.body, whatFor)) {
        if (unitsAfter === target.index) {
          reads = getUnitTextContent(c.el).replace(/\s+/g, ' ').trim();
        }
        unitsAfter++;
      }
      imagesAfter = collectImageElements(written.body).length;
    } finally {
      check.close();
    }
    if (unitsAfter !== unitsBefore) {
      throw new Error(
        `${file} held ${unitsBefore} text element(s) and the rewritten file holds ${unitsAfter}. `
        + 'Correcting text adds and removes no element, so every narration strike recorded against '
        + 'this book would now name the wrong one. Nothing was written.'
      );
    }
    if (imagesAfter !== imagesBefore) {
      throw new Error(
        `${file} held ${imagesBefore} picture(s) and the rewritten file holds ${imagesAfter}. `
        + 'Correcting text moves no picture. Nothing was written.'
      );
    }
    if (reads !== wanted) {
      throw new Error(
        `${elementKey} was written to read "${wanted}" and ${bookName} reads it back as `
        + `${reads === null ? 'nothing at all' : `"${reads}"`}. Nothing was written.`
      );
    }
  } catch (err) {
    await removeEpubContainer(outputPath);
    throw err;
  }

  return { written: true, edit };
}
