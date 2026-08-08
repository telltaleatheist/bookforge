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
import { promisify } from 'util';
import * as cheerio from 'cheerio';
import { BLOCK_CATEGORY_IDS } from '../shared/ocr/block-categories';
import { blockCategoryForVlm } from '../shared/vlm/conversion';
import { stripFootnoteMarkerSups } from '../shared/text/sup-markers';
import {
  narrationElementKey,
  planNarrationRemoval,
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

export class ZipReader {
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

export class EpubProcessor {
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
      if (c && this.zipReader?.hasEntry(join(c))) return join(c);
    }
    // Nothing matched — keep the historical behavior (fragment-stripped href)
    // so callers still surface a clear "Entry not found" error.
    return join(candidates[1]);
  }

  private extractTextFromXhtml(xhtml: string): string {
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
    text = stripFootnoteMarkerSups(text).text;

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

export class ZipWriter {
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
 * - Writes via temp file for atomicity
 */
export async function embedCoverInEpub(epubPath: string, coverImagePath: string): Promise<void> {
  const coverData = await fs.readFile(coverImagePath);
  const coverExt = path.extname(coverImagePath).toLowerCase().replace('.', '') || 'jpg';
  const mediaType = coverExt === 'png' ? 'image/png'
    : coverExt === 'gif' ? 'image/gif'
    : coverExt === 'webp' ? 'image/webp'
    : 'image/jpeg';

  const processor = new EpubProcessor();
  let structure: EpubStructure;
  try {
    structure = await processor.open(epubPath);
  } catch (err) {
    processor.close();
    throw err;
  }

  const zipWriter = new ZipWriter();
  const entries = (processor as any).zipReader?.getEntries() || [];
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

  let coverWritten = false;

  for (const entryName of entries) {
    // Replace existing cover image data
    if (existingCoverEntry && entryName === existingCoverEntry) {
      zipWriter.addFile(entryName, coverData, true);
      coverWritten = true;
      continue;
    }

    // Modify OPF to add cover metadata if EPUB has no existing cover
    if (!existingCoverEntry && entryName === structure.opfPath) {
      let opfXml = await processor.readFile(entryName);

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

      zipWriter.addFile(entryName, Buffer.from(opfXml, 'utf8'));
      continue;
    }

    // Copy all other entries as-is
    const data = await processor.readBinaryFile(entryName);
    const compress = entryName !== 'mimetype';
    zipWriter.addFile(entryName, data, compress);
  }

  // If no existing cover was found, add the new cover file as a new entry
  if (!existingCoverEntry) {
    zipWriter.addFile(newCoverEntry, coverData, true);
  }

  processor.close();

  await zipWriter.write(epubPath);
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
  } catch (err) {
    processor.close();
    throw err;
  }

  try {
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];
    const rootPath = structure.rootPath;

    const existingCoverHref = structure.metadata.coverPath;
    const existingCoverEntry = existingCoverHref
      ? (rootPath ? `${rootPath}/${existingCoverHref}` : existingCoverHref)
      : null;
    const newCoverFilename = `cover.${coverExt === 'jpeg' ? 'jpg' : coverExt}`;
    const newCoverEntry = rootPath ? `${rootPath}/${newCoverFilename}` : newCoverFilename;
    const addingNewCover = !!coverData && !existingCoverEntry;

    for (const entryName of entries) {
      // Replace an existing cover image's bytes.
      if (coverData && existingCoverEntry && entryName === existingCoverEntry) {
        zipWriter.addFile(entryName, coverData, true);
        continue;
      }
      // OPF: apply metadata, and inject cover manifest/meta when adding a new cover.
      if (entryName === structure.opfPath) {
        let opfXml = updateOpfMetadata(await processor.readFile(entryName), metadata);
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
        zipWriter.addFile(entryName, Buffer.from(opfXml, 'utf8'));
        continue;
      }
      const data = await processor.readBinaryFile(entryName);
      const compress = entryName !== 'mimetype';
      zipWriter.addFile(entryName, data, compress);
    }

    if (addingNewCover && coverData) {
      zipWriter.addFile(newCoverEntry, coverData, true);
    }

    const tempPath = epubPath + '.tmp';
    await zipWriter.write(tempPath);
    await fs.rename(tempPath, epubPath);
  } finally {
    processor.close();
  }
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
    const zipWriter = new ZipWriter();

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

    const entries = (processor as any).zipReader?.getEntries() || [];

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
 * Opens the EPUB, updates OPF metadata fields, rewrites the ZIP atomically.
 * Uses its own EpubProcessor instance to avoid interfering with the PDF editor.
 */
export async function updateEpubMetadataStandalone(
  epubPath: string,
  metadata: Partial<EpubMetadata>
): Promise<void> {
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(epubPath);
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];

    for (const entryName of entries) {
      if (entryName === structure.opfPath) {
        const originalOpf = await processor.readFile(entryName);
        const newOpf = updateOpfMetadata(originalOpf, metadata);
        zipWriter.addFile(entryName, Buffer.from(newOpf, 'utf8'));
        continue;
      }

      const data = await processor.readBinaryFile(entryName);
      const compress = entryName !== 'mimetype';
      zipWriter.addFile(entryName, data, compress);
    }

    // Atomic write via temp file
    const tempPath = epubPath + '.tmp';
    await zipWriter.write(tempPath);
    await fs.rename(tempPath, epubPath);
  } finally {
    processor.close();
  }
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
        const text = await processor.getChapterText(chapter.id);
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

    // Create new EPUB with the modified chapter
    const zipWriter = new ZipWriter();
    const entries = (processor as any).zipReader?.getEntries() || [];

    for (const entryName of entries) {
      if (entryName === href) {
        zipWriter.addFile(entryName, Buffer.from(newXhtml, 'utf8'));
      } else {
        const data = await processor.readBinaryFile(entryName);
        const compress = entryName !== 'mimetype';
        zipWriter.addFile(entryName, data, compress);
      }
    }

    // Write to a temp file, then replace the original
    const tempPath = epubPath + '.tmp';
    await zipWriter.write(tempPath);

    const fs = await import('fs/promises');
    await fs.rename(tempPath, epubPath);

    // Invalidate the diff cache since the EPUB changed
    const diffCachePath = epubPath.replace('.epub', '.diff.json');
    try {
      await fs.unlink(diffCachePath);
    } catch {
      // Cache file may not exist - that's fine
    }

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
function parseXhtmlBody(xhtml: string, whatFor: string): { doc: any; body: any } {
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
 * Extract text from each block element in XHTML using cheerio,
 * also returning the tag name per block.
 */
export function extractBlockTextsWithTags(xhtml: string): Array<{ text: string; tagName: string }> {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  const blocks: Array<{ text: string; tagName: string }> = [];
  $(BLOCK_SELECTORS).each((_, el) => {
    const text = $(el).text().replace(/\u00AD\s*/g, '').trim();
    if (text.length > 0) {
      blocks.push({ text, tagName: (el as any).tagName?.toLowerCase() || 'p' });
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

    // Read all files from source, modify chapter bodies
    const zipReader = new ZipReader(inputPath);
    await zipReader.open();
    const files = zipReader.getEntries();
    const zipWriter = new ZipWriter();

    let sentenceIndex = globalSentenceStartIndex;

    for (const file of files) {
      const replacement = replacementByPath.get(file);

      if (replacement) {
        // Read original xhtml to preserve head/structure
        const originalBuffer = await zipReader.readEntry(file);
        const originalXhtml = originalBuffer.toString('utf8');

        // Build new body content
        const $ = cheerio.load(originalXhtml, { xmlMode: true });
        const body = $('body');
        if (body.length === 0) {
          // No body tag — just copy as-is
          zipWriter.addFile(file, originalBuffer);
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
        zipWriter.addFile(file, Buffer.from(newXhtml, 'utf8'));
      } else {
        // Copy file as-is
        const content = await zipReader.readEntry(file);
        zipWriter.addFile(file, content);
      }
    }

    zipReader.close();
    processor.close();

    // Write the new EPUB
    const tempPath = outputPath + '.tmp';
    await zipWriter.write(tempPath);
    await fs.rename(tempPath, outputPath);

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
 * This function duplicates the EPUB if outputPath differs from inputPath,
 * then replaces text content in specified chapters.
 */
export async function replaceChapterTextsInEpub(
  inputPath: string,
  outputPath: string,
  chapterReplacements: Array<{ chapterId: string; newText: string }>
): Promise<{ success: boolean; error?: string }> {
  try {
    // If output path differs, copy the EPUB first
    if (inputPath !== outputPath) {
      const copyResult = await copyEpubFile(inputPath, outputPath);
      if (!copyResult.success) {
        return { success: false, error: `Failed to copy EPUB: ${copyResult.error}` };
      }
    }

    // Now work with the output file
    const processor = new EpubProcessor();
    const structure = await processor.open(outputPath);

    // Process each chapter replacement
    const zipWriter = new ZipWriter();
    const tempOutputPath = outputPath + '.tmp';

    // Copy all files from the original EPUB
    const zipReader = new ZipReader(outputPath);
    await zipReader.open();
    const files = zipReader.getEntries();

    // Create a map of chapter IDs to their file paths
    const chapterPathMap = new Map<string, string>();
    for (const chapter of structure.chapters) {
      const href = processor.resolvePath(chapter.href);
      chapterPathMap.set(chapter.id, href);
    }

    // Process each file
    for (const file of files) {
      // Check if this file needs text replacement
      const replacement = chapterReplacements.find(r =>
        chapterPathMap.get(r.chapterId) === file
      );

      if (replacement) {
        // This is a chapter that needs replacement — use cheerio-based replaceBlockTexts
        const originalBuffer = await zipReader.readEntry(file);
        const originalContent = originalBuffer.toString('utf8');

        // Split new text into paragraphs (on double newlines)
        const splitTexts = replacement.newText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);

        // Skip h1 headings — cleanup sends only body text, headings pass through untouched
        const newContent = replaceBlockTexts(originalContent, splitTexts, { skipHeadings: true });
        zipWriter.addFile(file, Buffer.from(newContent, 'utf8'));
      } else {
        // Copy file as-is
        const content = await zipReader.readEntry(file);
        zipWriter.addFile(file, content);
      }
    }

    zipReader.close();
    processor.close();

    // Write the new EPUB
    await zipWriter.write(tempOutputPath);

    // Replace the original with the temp file
    await fs.rename(tempOutputPath, outputPath);

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

/**
 * Text content of a unit AS RENDERED: like getTextContent, but skips
 * script/style/template subtrees and includes CDATA sections. This is the text
 * the alignment compares against picker blocks, which come from mupdf layout.
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
function collectExportUnits(
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
function normalizeZipEntryName(name: string): string {
  const parts: string[] = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Map picker blocks onto the source EPUB's own elements by sequential text
 * alignment. Never throws on a block that merely fails to match — those are
 * reported in `unaligned` and POLICY (what is tolerable) belongs to the
 * exporter. It does throw on structural failures: unreadable/unparseable spine
 * sections and stray text the unit collector cannot attribute, because no
 * alignment over that book can be trusted.
 */
export async function alignBlocksToEpub(
  epubSourcePath: string,
  blocks: EpubExportBlock[],
): Promise<EpubAlignmentResult> {
  const processor = new EpubProcessor();
  const units: ExportUnit[] = [];
  // mupdf lays out an image's ALT TEXT as "[<alt>]" when it does not draw the
  // image itself — that text exists in no DOM text node, so blocks matching a
  // known alt form are image furniture, not unalignable content.
  const imgAltNorms = new Set<string>();

  try {
    const structure = await processor.open(epubSourcePath);

    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
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
      searchFrom = occ + 1;
    }
    return {
      kind: 'fail',
      reason: sawAnchor
        ? `anchor found but full text failed fuzzy verification (tolerance ${tolerance})`
        : `no exact or anchor match within ${ALIGN_GAP_WINDOW} chars of the cursor`,
    };
  };

  for (const b of sorted) {
    // Footnote markers DUPLICATE their parent block's text in the analyzer
    // output — aligning them would double-count. Images have no text at all.
    if (b.isImage || b.isFootnoteMarker) continue;
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

  return { units, blockToUnits, unaligned, uncoveredUnits };
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
    spanningElements: 0,
  };
  // An unstamped book is not read here at all, and it does not need to be: the
  // caller asks the CONVERSION reader next, and that one aligns every EPUB and
  // answers the element keys whether or not it finds a stamp.
  if (!(await epubCarriesProvenance(epubSourcePath))) return empty;

  const legal = new Set<string>(BLOCK_CATEGORY_IDS);
  const whatFor = `EPUB provenance in ${path.basename(epubSourcePath)}`;
  const { units, blockToUnits, unaligned } = await alignBlocksToEpub(epubSourcePath, blocks);

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

  return {
    stamped: true,
    byBlockId,
    elementByBlockId,
    alignedToUnstampedElement,
    unaligned,
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
  const { units } = await alignBlocksToEpub(epubSourcePath, []);
  return units.map((unit) => {
    const stamp = conversionStampOnOrAbove(unit.el, whatFor);
    return {
      key: unit.key,
      category: stamp?.statedCategory ?? null,
      sourcePage: stamp?.sourcePage ?? null,
    };
  });
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
  const { units, blockToUnits, unaligned } = await alignBlocksToEpub(epubSourcePath, blocks);

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

  return {
    converted,
    byBlockId,
    elementByBlockId,
    alignedToUnstampedElement,
    unaligned,
  };
}

export interface NarrationEpubWriteResult {
  /** How many elements were removed. */
  removedElements: number;
  /** How many the book had. */
  totalElements: number;
  /** How many digits-only `<sup>` footnote references were removed. */
  removedSupMarkers: number;
  /** The spine documents that were rewritten. */
  rewrittenFiles: string[];
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
 * `planNarrationRemoval` decides WHAT comes out and refuses a key the book does
 * not have; this function only carries that out. The output is written to
 * `outputPath` and the caller is responsible for moving it into place.
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
  const perFile = new Map<string, { doc: any; units: Array<{ key: string; el: any }> }>();
  const units: NarrationUnit[] = [];
  try {
    const structure = await processor.open(inputPath);
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
        });
      }
      perFile.set(entryName, { doc, units: collected });
    }
  } finally {
    processor.close();
  }

  const plan = planNarrationRemoval(units, deletions);
  const struck = new Set(plan.remove);

  const rewrittenFiles: string[] = [];
  const replacements = new Map<string, Buffer>();
  for (const [file, { doc, units: fileUnits }] of perFile) {
    const toRemove = fileUnits.filter((u) => struck.has(u.key));
    if (toRemove.length === 0) continue;
    for (const unit of toRemove) {
      // An element whose parent has already gone with an ancestor is already
      // out of the tree; removing it again would throw in xmldom.
      if (unit.el.parentNode) unit.el.parentNode.removeChild(unit.el);
    }
    let serialized: string = new XMLSerializer().serializeToString(doc);
    if (!serialized.startsWith('<?xml')) {
      serialized = `<?xml version="1.0" encoding="utf-8"?>\n${serialized}`;
    }
    replacements.set(file, Buffer.from(serialized, 'utf8'));
    rewrittenFiles.push(file);
  }

  const stripSups = options?.stripSupMarkers !== false;
  let removedSupMarkers = 0;

  const zipReader = new ZipReader(inputPath);
  await zipReader.open();
  try {
    const zipWriter = new ZipWriter();
    for (const entry of zipReader.getEntries()) {
      let data = replacements.get(entry) ?? await zipReader.readEntry(entry);

      // The marker strip runs on the BYTES that are about to be written — after
      // the element removals, so a document that lost both is edited once, and
      // as a string edit so every byte of markup nobody asked to touch comes
      // through unchanged. Content documents only: the OPF and the nav have no
      // prose in them, and `<sup>` there would not be a footnote reference.
      if (stripSups && /\.(xhtml|html|htm)$/i.test(entry)) {
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
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await zipWriter.write(outputPath);
  } finally {
    zipReader.close();
  }

  return {
    removedElements: plan.remove.length,
    totalElements: plan.total,
    removedSupMarkers,
    rewrittenFiles,
  };
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

  const zipWriter = new ZipWriter();
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

