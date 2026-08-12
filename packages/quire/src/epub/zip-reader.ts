/**
 * A read-only ZIP reader, kept inside the package so `quire` has no import edge
 * into `electron/`.
 *
 * It is deliberately the same algorithm as `ZipReader` in
 * `electron/epub-processor.ts` — end-of-central-directory, then the central
 * directory, then per-entry local headers — because the two must agree about
 * what the entries of a book ARE. Where that one is BookForge's, this one is
 * the package's, and the package is what gets swapped in for mupdf.
 */
import * as fsSync from 'fs';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { quireFail } from '../errors';
import type { QuireEntrySource, QuireEntrySourceKind } from './entry-source';

const inflateRaw = promisify(zlib.inflateRaw);

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

export class QuireZipReader implements QuireEntrySource {
  readonly kind: QuireEntrySourceKind = 'zip';

  private fd: number | null = null;
  private entries = new Map<string, ZipEntry>();

  constructor(readonly sourcePath: string) {}

  describe(): string {
    return `the EPUB archive ${this.sourcePath}`;
  }

  open(): void {
    this.fd = fsSync.openSync(this.sourcePath, 'r');
    try {
      this.readCentralDirectory();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close(): void {
    if (this.fd !== null) {
      fsSync.closeSync(this.fd);
      this.fd = null;
    }
  }

  hasEntry(name: string): boolean {
    return this.entries.has(name);
  }

  entryNames(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Read exactly `length` bytes, or refuse naming what fell short.
   *
   * `readSync`'s return value is the byte count and it was being IGNORED — a
   * read past a truncated or shrunk file quietly leaves the tail of the
   * `Buffer.alloc` ZEROS, and a STORED entry then comes back NUL-padded. That
   * is not a hypothetical: a run of NULs parses as nothing, so the book died
   * later, in the paginator, as `DOCUMENT_UNPARSEABLE` with no detail —
   * blaming the XHTML for what was a torn read of the archive. A file only
   * comes up short when it has been truncated or replaced UNDER this open
   * reader, which is exactly the state a reader must refuse, not paper over.
   */
  private readExactly(
    fd: number, buffer: Buffer, length: number, position: number, what: string,
  ): void {
    const got = fsSync.readSync(fd, buffer, 0, length, position);
    if (got !== length) {
      quireFail(
        'ZIP_SHORT_READ',
        `${this.sourcePath}: ${what} needed ${length} byte(s) at offset ${position} and the file `
        + `returned ${got} — the archive has been truncated or rewritten under this reader. `
        + 'Close and re-open the book.',
      );
    }
  }

  async readEntry(name: string): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) {
      quireFail('ZIP_ENTRY_MISSING', `the archive ${this.sourcePath} has no entry "${name}"`);
    }
    if (this.fd === null) {
      quireFail('ZIP_CLOSED', `the archive ${this.sourcePath} is closed`);
    }

    const localHeader = Buffer.alloc(30);
    this.readExactly(this.fd, localHeader, 30, entry.localHeaderOffset,
      `entry "${name}"'s local header`);
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      quireFail('ZIP_BAD_HEADER', `entry "${name}" has an invalid local file header`);
    }
    const nameLen = localHeader.readUInt16LE(26);
    const extraLen = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

    const compressed = Buffer.alloc(entry.compressedSize);
    this.readExactly(this.fd, compressed, entry.compressedSize, dataOffset,
      `entry "${name}"'s data`);

    if (entry.compressionMethod === 0) return compressed;
    if (entry.compressionMethod === 8) return (await inflateRaw(compressed)) as Buffer;
    quireFail(
      'ZIP_COMPRESSION',
      `entry "${name}" uses compression method ${entry.compressionMethod}, which this reader does not implement`,
    );
  }

  async readText(name: string): Promise<string> {
    return (await this.readEntry(name)).toString('utf8');
  }

  private readCentralDirectory(): void {
    if (this.fd === null) quireFail('ZIP_CLOSED', `the archive ${this.sourcePath} is closed`);
    const size = fsSync.fstatSync(this.fd).size;

    const searchSize = Math.min(65557, size);
    const search = Buffer.alloc(searchSize);
    this.readExactly(this.fd, search, searchSize, size - searchSize,
      'the end-of-central-directory search window');

    let eocd = -1;
    for (let i = searchSize - 22; i >= 0; i--) {
      if (search.readUInt32LE(i) === 0x06054b50) { eocd = size - searchSize + i; break; }
    }
    if (eocd === -1) {
      quireFail('ZIP_NO_EOCD', `${this.sourcePath} has no end-of-central-directory record — it is not a ZIP archive`);
    }

    const rec = Buffer.alloc(22);
    this.readExactly(this.fd, rec, 22, eocd, 'the end-of-central-directory record');
    const dirOffset = rec.readUInt32LE(16);
    const dirSize = rec.readUInt32LE(12);
    const count = rec.readUInt16LE(10);

    const dir = Buffer.alloc(dirSize);
    this.readExactly(this.fd, dir, dirSize, dirOffset, 'the central directory');

    let off = 0;
    for (let i = 0; i < count; i++) {
      if (dir.readUInt32LE(off) !== 0x02014b50) {
        quireFail('ZIP_BAD_DIRECTORY', `${this.sourcePath} has an invalid central directory entry at index ${i}`);
      }
      const compressionMethod = dir.readUInt16LE(off + 10);
      const compressedSize = dir.readUInt32LE(off + 20);
      const uncompressedSize = dir.readUInt32LE(off + 24);
      const nameLen = dir.readUInt16LE(off + 28);
      const extraLen = dir.readUInt16LE(off + 30);
      const commentLen = dir.readUInt16LE(off + 32);
      const localHeaderOffset = dir.readUInt32LE(off + 42);
      const name = dir.toString('utf8', off + 46, off + 46 + nameLen);
      this.entries.set(name, {
        name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset,
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
  }
}
