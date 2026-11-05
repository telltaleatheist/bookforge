/**
 * An EPUB's ZIP, as Python's `zipfile` reads it. The app's own `ZipReader` is built for rewriting books;
 * prep has to refuse exactly what the Python refused, so a CRC, a header and a name are checked here, and
 * a member's bytes stream through the check rather than sit in memory.
 */

import { createReadStream, promises as fsp } from 'fs';
import { createInflateRaw } from 'zlib';

import { pyRepr } from '../../py-compat';

export class BadZipFile extends Error {}

/** A name not in the archive. `KeyError` in the Python, and ebooklib catches it by that type. */
export class NoSuchMember extends Error {
  constructor(name: string) {
    super(`"There is no item named ${pyRepr(name)} in the archive"`);
  }
}

interface Member {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly headerOffset: number;
}

const CP437 = Array.from(Buffer.from(
  'c7fce9e2e4e0e5e7eaebe8efeeecc4c5c9e6c6f4f6f2fbf9ffd6dca2a3a5', 'hex'), (b) => String.fromCharCode(b)).join('')
  + '₧ƒáíóúñÑªº¿⌐¬½¼¡«»'
  + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
  + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧'
  + '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀'
  + 'αßΓπΣσµτΦΘΩδ∞φε∩'
  + '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  return Array.from(raw, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80])).join('');
}

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(chunk: Buffer, seed: number): number {
  let c = ~seed;
  for (let i = 0; i < chunk.length; i += 1) c = CRC_TABLE[(c ^ chunk[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

const EOCD_SIZE = 22;
const EOCD_SEARCH = 65536 + EOCD_SIZE;

export class ZipFile {
  private readonly members = new Map<string, Member>();

  private constructor(private readonly file: string, private readonly handle: fsp.FileHandle) {}

  static async open(file: string): Promise<ZipFile> {
    const handle = await fsp.open(file, 'r');
    const zip = new ZipFile(file, handle);
    try {
      await zip.readDirectory();
    } catch (err) {
      await handle.close();
      throw err;
    }
    return zip;
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  private async bytesAt(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  private async readDirectory(): Promise<void> {
    const fileSize = (await this.handle.stat()).size;
    const tailStart = Math.max(0, fileSize - EOCD_SEARCH);
    const tail = await this.bytesAt(tailStart, fileSize - tailStart);
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (at < 0 || at + EOCD_SIZE > tail.length) throw new BadZipFile('File is not a zip file');
    const eocd = tailStart + at;
    let entries = tail.readUInt16LE(at + 10);
    let directorySize = tail.readUInt32LE(at + 12);
    let directoryOffset = tail.readUInt32LE(at + 16);
    let directoryEnd = eocd;

    const locator = eocd >= 20 ? await this.bytesAt(eocd - 20, 20) : Buffer.alloc(0);
    if (locator.length === 20 && locator.readUInt32LE(0) === 0x07064b50) {
      const record = await this.bytesAt(eocd - 76, 56);
      if (record.length !== 56 || record.readUInt32LE(0) !== 0x06064b50) throw new BadZipFile('Corrupt zip64 end of central directory');
      entries = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
      directoryEnd = eocd - 76;
    }
    const concat = directoryEnd - directorySize - directoryOffset;
    if (concat < 0) throw new BadZipFile('Bad offset for central directory');

    const directory = await this.bytesAt(directoryOffset + concat, directorySize);
    let p = 0;
    while (p < directory.length) {
      if (p + 46 > directory.length) throw new BadZipFile('Truncated central directory');
      if (directory.readUInt32LE(p) !== 0x02014b50) throw new BadZipFile('Bad magic number for central directory');
      const flags = directory.readUInt16LE(p + 8);
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      let compressedSize = directory.readUInt32LE(p + 20);
      let size = directory.readUInt32LE(p + 24);
      let headerOffset = directory.readUInt32LE(p + 42);
      const extra = directory.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const length = extra.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          const next = (): number => { const v = Number(extra.readBigUInt64LE(q)); q += 8; return v; };
          if (size === 0xffffffff) size = next();
          if (compressedSize === 0xffffffff) compressedSize = next();
          if (headerOffset === 0xffffffff) headerOffset = next();
        }
        e += 4 + length;
      }
      const rawName = directory.subarray(p + 46, p + 46 + nameLength);
      let name = decodeName(rawName, flags);
      const nul = name.indexOf(String.fromCharCode(0));
      if (nul >= 0) name = name.slice(0, nul);
      // A later member of one name replaces an earlier one. On Windows `zipfile` also folds
      // backslashes, and the sessions written so far were written there.
      name = name.replace(/\\/g, '/');
      this.members.set(name, {
        name, flags, method: directory.readUInt16LE(p + 10), crc: directory.readUInt32LE(p + 16),
        compressedSize, size, headerOffset: headerOffset + concat,
      });
      p += 46 + nameLength + extraLength + commentLength;
    }
    if (this.members.size === 0 && entries > 0) throw new BadZipFile('Truncated central directory');
  }

  /** Every byte of a member, past every check `ZipFile.read` makes. `sink` sees them as they come. */
  private async stream(name: string, sink: ((chunk: Buffer) => void) | null): Promise<void> {
    const member = this.members.get(name);
    if (!member) throw new NoSuchMember(name);
    const header = await this.bytesAt(member.headerOffset, 30);
    if (header.length !== 30) throw new BadZipFile('Truncated file header');
    if (header.readUInt32LE(0) !== 0x04034b50) throw new BadZipFile('Bad magic number for file header');
    const nameLength = header.readUInt16LE(26);
    const stored = decodeName(await this.bytesAt(member.headerOffset + 30, nameLength), header.readUInt16LE(6));
    if (stored.replace(/\\/g, '/') !== member.name) {
      throw new BadZipFile(`File name in directory ${pyRepr(member.name)} and header ${pyRepr(stored)} differ.`);
    }
    if (member.flags & 0x1) throw new Error(`File ${pyRepr(name)} is encrypted, password required for extraction`);
    if (member.method !== 0 && member.method !== 8) throw new Error(`compression type ${member.method}`);

    const start = member.headerOffset + 30 + nameLength + header.readUInt16LE(28);
    let crc = 0;
    let seen = 0;
    const take = (chunk: Buffer): void => {
      crc = crc32(chunk, crc);
      seen += chunk.length;
      sink?.(chunk);
    };
    if (member.compressedSize > 0) {
      const raw = createReadStream(this.file, { start, end: start + member.compressedSize - 1 });
      if (member.method === 0) {
        for await (const chunk of raw) take(chunk as Buffer);
      } else {
        const inflate = createInflateRaw();
        raw.on('error', (err) => inflate.destroy(err));
        raw.pipe(inflate);
        for await (const chunk of inflate) take(chunk as Buffer);
      }
    }
    if (seen !== member.size || crc !== member.crc) throw new BadZipFile(`Bad CRC-32 for file ${pyRepr(name)}`);
  }

  async read(name: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.stream(name, (chunk) => chunks.push(chunk));
    return Buffer.concat(chunks);
  }

  /** What `read` would refuse, without holding the bytes. */
  verify(name: string): Promise<void> {
    return this.stream(name, null);
  }
}
