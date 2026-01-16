import { Injectable, inject } from '@angular/core';
import { PdfService, TextBlock } from './pdf.service';

export interface ExportableBlock {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  is_image?: boolean;
}

export interface DeletedRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportResult {
  success: boolean;
  message: string;
  filename?: string;
  charCount?: number;
  blockCount?: number;
  chapterCount?: number;
  regionCount?: number;
}

/**
 * ExportService - Handles TXT, EPUB, and PDF export functionality
 *
 * Stateless service - all data passed as method parameters for testability.
 */
@Injectable({
  providedIn: 'root'
})
export class ExportService {
  private readonly pdfService = inject(PdfService);
  private crc32Table: number[] | null = null;

  /**
   * Export text content to a .txt file
   */
  async exportText(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    pdfName: string,
    textCorrections?: Map<string, string>
  ): Promise<ExportResult> {
    const exportBlocks = blocks
      .filter(b => !deletedIds.has(b.id) && !b.is_image)
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    if (exportBlocks.length === 0) {
      return {
        success: false,
        message: 'No text to export. All blocks have been deleted.'
      };
    }

    const lines: string[] = [];
    let currentPage = -1;

    for (const block of exportBlocks) {
      if (block.page !== currentPage) {
        if (currentPage >= 0) lines.push('');
        currentPage = block.page;
      }
      // Use corrected text if available, otherwise original
      const blockText = textCorrections?.get(block.id) ?? block.text;
      const cleanedText = this.stripFootnoteRefs(blockText);
      if (cleanedText.trim()) {
        lines.push(cleanedText);
      }
    }

    const text = lines.join('\n');
    const filename = this.generateFilename(pdfName, 'txt');

    this.downloadBlob(
      new Blob([text], { type: 'text/plain' }),
      filename
    );

    return {
      success: true,
      message: `Exported ${text.length.toLocaleString()} characters from ${exportBlocks.length} blocks.`,
      filename,
      charCount: text.length,
      blockCount: exportBlocks.length
    };
  }

  /**
   * Export content to an EPUB file
   */
  async exportEpub(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    pdfName: string,
    textCorrections?: Map<string, string>
  ): Promise<ExportResult> {
    const exportBlocks = blocks
      .filter(b => !deletedIds.has(b.id) && !b.is_image)
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    if (exportBlocks.length === 0) {
      return {
        success: false,
        message: 'No text to export. All blocks have been deleted.'
      };
    }

    const bookTitle = pdfName.replace(/\.pdf$/i, '');
    const chapters: string[] = [];
    let currentChapter: string[] = [];
    let lastPage = -1;

    for (const block of exportBlocks) {
      if (block.page !== lastPage && block.page % 10 === 0 && currentChapter.length > 0) {
        chapters.push(currentChapter.join('\n'));
        currentChapter = [];
      }
      lastPage = block.page;

      // Use corrected text if available, otherwise original
      const blockText = textCorrections?.get(block.id) ?? block.text;
      const cleanedText = this.stripFootnoteRefs(blockText);
      if (cleanedText.trim()) {
        currentChapter.push(`<p>${this.escapeHtml(cleanedText)}</p>`);
      }
    }

    if (currentChapter.length > 0) {
      chapters.push(currentChapter.join('\n'));
    }

    const epub = this.generateEpubBlob(bookTitle, chapters);
    const filename = this.generateFilename(pdfName, 'epub');

    this.downloadBlob(epub, filename);

    return {
      success: true,
      message: `Exported EPUB with ${chapters.length} chapters, ${exportBlocks.length} blocks.`,
      filename,
      chapterCount: chapters.length,
      blockCount: exportBlocks.length
    };
  }

  /**
   * Export PDF with deleted regions removed
   */
  async exportPdf(
    blocks: ExportableBlock[],
    deletedBlockIds: Set<string>,
    deletedHighlightIds: Set<string>,
    categoryHighlights: Map<string, Record<number, HighlightRect[]>>,
    libraryPath: string,
    pdfName: string,
    getHighlightId: (categoryId: string, page: number, x: number, y: number) => string
  ): Promise<ExportResult> {
    const deletedRegions: DeletedRegion[] = [];

    // Add deleted blocks
    for (const block of blocks) {
      if (deletedBlockIds.has(block.id)) {
        deletedRegions.push({
          page: block.page,
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height
        });
      }
    }

    // Add deleted custom category highlights
    if (deletedHighlightIds.size > 0) {
      for (const [categoryId, pageMap] of categoryHighlights) {
        for (const [pageStr, rects] of Object.entries(pageMap)) {
          const page = parseInt(pageStr);
          for (const rect of rects) {
            const highlightId = getHighlightId(categoryId, page, rect.x, rect.y);
            if (deletedHighlightIds.has(highlightId)) {
              deletedRegions.push({
                page,
                x: rect.x,
                y: rect.y,
                width: rect.w,
                height: rect.h
              });
            }
          }
        }
      }
    }

    if (deletedRegions.length === 0) {
      return {
        success: false,
        message: 'No blocks or highlights have been deleted. The exported PDF would be identical to the original.'
      };
    }

    if (!libraryPath) {
      return {
        success: false,
        message: 'No PDF file loaded'
      };
    }

    const pdfBase64 = await this.pdfService.exportCleanPdf(libraryPath, deletedRegions);

    const binaryString = atob(pdfBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const filename = this.generateFilename(pdfName, 'pdf');
    this.downloadBlob(
      new Blob([bytes], { type: 'application/pdf' }),
      filename
    );

    return {
      success: true,
      message: `Exported PDF with ${deletedRegions.length} regions removed.`,
      filename,
      regionCount: deletedRegions.length
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private generateFilename(pdfName: string, extension: string): string {
    const baseName = pdfName
      .replace(/\.(pdf|epub)$/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().slice(0, 10);
    return `${baseName}_cleaned_${timestamp}.${extension}`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private stripFootnoteRefs(text: string): string {
    // Unicode superscript numbers: ⁰¹²³⁴⁵⁶⁷⁸⁹
    const superscriptPattern = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g;

    // Regular numbers that look like footnote refs:
    // - Numbers at end of words (word123 -> word)
    // - Numbers after punctuation with no space (text.1 -> text.)
    const inlineRefPattern = /(?<=\w)(\d{1,3})(?=[\s\.,;:!?\)]|$)/g;

    // Bracketed references: [1], [12], (1), (12)
    const bracketedPattern = /[\[\(]\d{1,3}[\]\)]/g;

    let cleaned = text;
    cleaned = cleaned.replace(superscriptPattern, '');
    cleaned = cleaned.replace(bracketedPattern, '');
    cleaned = cleaned.replace(inlineRefPattern, '');

    // Clean up any double spaces left behind
    cleaned = cleaned.replace(/  +/g, ' ');

    return cleaned.trim();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  private generateEpubBlob(title: string, chapters: string[]): Blob {
    const uuid = 'urn:uuid:' + this.generateUuid();
    const date = new Date().toISOString().split('T')[0];

    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const chapterManifest = chapters.map((_, i) =>
      `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
    ).join('\n');

    const chapterSpine = chapters.map((_, i) =>
      `    <itemref idref="chapter${i + 1}"/>`
    ).join('\n');

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${this.escapeHtml(title)}</dc:title>
    <dc:language>en</dc:language>
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

    const navItems = chapters.map((_, i) =>
      `        <li><a href="chapter${i + 1}.xhtml">Chapter ${i + 1}</a></li>`
    ).join('\n');

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Navigation</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

    const chapterXhtmls = chapters.map((content, i) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Chapter ${i + 1}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    p { margin: 0.5em 0; text-indent: 1em; }
  </style>
</head>
<body>
  <h1>Chapter ${i + 1}</h1>
${content}
</body>
</html>`);

    const files: { name: string; content: string }[] = [
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: containerXml },
      { name: 'OEBPS/content.opf', content: contentOpf },
      { name: 'OEBPS/nav.xhtml', content: navXhtml },
      ...chapterXhtmls.map((content, i) => ({
        name: `OEBPS/chapter${i + 1}.xhtml`,
        content
      }))
    ];

    return this.createZipBlob(files);
  }

  private createZipBlob(files: { name: string; content: string }[]): Blob {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const centralDirectory: Uint8Array[] = [];
    let offset = 0;

    for (const file of files) {
      const fileData = encoder.encode(file.content);
      const fileName = encoder.encode(file.name);

      // Local file header
      const localHeader = new Uint8Array(30 + fileName.length);
      const view = new DataView(localHeader.buffer);

      view.setUint32(0, 0x04034b50, true);  // Local file header signature
      view.setUint16(4, 20, true);           // Version needed to extract
      view.setUint16(6, 0, true);            // General purpose bit flag
      view.setUint16(8, 0, true);            // Compression method (store)
      view.setUint16(10, 0, true);           // File last mod time
      view.setUint16(12, 0, true);           // File last mod date
      view.setUint32(14, this.crc32(fileData), true); // CRC-32
      view.setUint32(18, fileData.length, true);      // Compressed size
      view.setUint32(22, fileData.length, true);      // Uncompressed size
      view.setUint16(26, fileName.length, true);      // File name length
      view.setUint16(28, 0, true);           // Extra field length

      localHeader.set(fileName, 30);

      // Central directory entry
      const centralEntry = new Uint8Array(46 + fileName.length);
      const centralView = new DataView(centralEntry.buffer);

      centralView.setUint32(0, 0x02014b50, true);  // Central directory signature
      centralView.setUint16(4, 20, true);          // Version made by
      centralView.setUint16(6, 20, true);          // Version needed
      centralView.setUint16(8, 0, true);           // General purpose bit flag
      centralView.setUint16(10, 0, true);          // Compression method
      centralView.setUint16(12, 0, true);          // File last mod time
      centralView.setUint16(14, 0, true);          // File last mod date
      centralView.setUint32(16, this.crc32(fileData), true); // CRC-32
      centralView.setUint32(20, fileData.length, true);      // Compressed size
      centralView.setUint32(24, fileData.length, true);      // Uncompressed size
      centralView.setUint16(28, fileName.length, true);      // File name length
      centralView.setUint16(30, 0, true);          // Extra field length
      centralView.setUint16(32, 0, true);          // File comment length
      centralView.setUint16(34, 0, true);          // Disk number start
      centralView.setUint16(36, 0, true);          // Internal file attributes
      centralView.setUint32(38, 0, true);          // External file attributes
      centralView.setUint32(42, offset, true);     // Relative offset of local header

      centralEntry.set(fileName, 46);

      parts.push(localHeader);
      parts.push(fileData);
      centralDirectory.push(centralEntry);

      offset += localHeader.length + fileData.length;
    }

    // End of central directory record
    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const entry of centralDirectory) {
      parts.push(entry);
      centralDirSize += entry.length;
    }

    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);

    endView.setUint32(0, 0x06054b50, true);  // End of central dir signature
    endView.setUint16(4, 0, true);           // Disk number
    endView.setUint16(6, 0, true);           // Disk number with central dir
    endView.setUint16(8, files.length, true);  // Entries on this disk
    endView.setUint16(10, files.length, true); // Total entries
    endView.setUint32(12, centralDirSize, true); // Size of central directory
    endView.setUint32(16, centralDirOffset, true); // Offset of central directory
    endView.setUint16(20, 0, true);          // ZIP file comment length

    parts.push(endRecord);

    // Combine all parts
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }

    return new Blob([result], { type: 'application/epub+zip' });
  }

  private crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    const table = this.getCrc32Table();
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  private getCrc32Table(): number[] {
    if (this.crc32Table) return this.crc32Table;

    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    this.crc32Table = table;
    return table;
  }
}
