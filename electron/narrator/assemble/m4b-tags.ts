/**
 * WRITE MP4 TAGS WITHOUT EVER RISKING THE BOOK, and without Python.
 *
 * Owen, 2026-11-05: "if theres a better way to do it then we should implement the safer
 * way." mutagen, which this replaces, moved every byte of audio in place on the only copy
 * whenever new tags outgrew their padding, so an interruption damaged the book. Now a
 * crash at ANY point leaves the old book or the new one, whole and playable. Two paths:
 *
 *  - THE TAGS FIT IN THE PADDING: no audio moves and no chunk offset changes. The new
 *    `ilst` goes into the `free` atom's payload, which no reader looks at, and is synced.
 *    Then two 4-byte writes make it real, each one leaving a valid file: the `free`
 *    shrinks to expose the new `ilst` (both are now complete), then the old `ilst` is
 *    renamed `free`. A 4-byte field crossing a sector boundary takes the other path.
 *
 *  - ANYTHING ELSE: a complete new file beside the original on the same volume, verified
 *    (audio packet hash, chapters, tags, size), then one atomic rename over the original.
 *    The original is not touched until then. A leftover is `.bf-retag-*.partial`.
 *
 * The new file gets room for one more whole `ilst`, so the next edit to this book is the
 * first path rather than another whole-file copy on the NAS.
 *
 * `ilst` items are ported from mutagen 1.47's rules and measured against it on a copy of
 * every layout in the library. `node-taglib-sharp` was measured first and refused: it
 * moved the bytes of `chpl` on a real book, and made a book with a `keys` atom unopenable.
 */

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { renameWithRetry, unlinkWithRetry, LARGE_FILE_RETRY_DELAYS_MS } from '../../fs-retry';

/** mutagen's `AtomDataType`: what the `data` atom says its bytes are. */
const DATA_UTF8 = 1;
const DATA_JPEG = 13;
const DATA_PNG = 14;
const DATA_INTEGER = 21;

const LOCK_CODES: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM']);
const LOCK_RETRY_DELAYS_MS: readonly number[] = [300, 600, 1200, 2000];
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const UINT32_MAX = 0xffffffff;
const SECTOR_BYTES = 512;
/** Beyond what the new file needs, so a full volume is refused before it is reached. */
const ROOM_MARGIN_BYTES = 16 * 1024 * 1024;

/** Inside a project, where finished books live (239 of 239 on the library, 2026-11-05). */
const M4B_FOLDERS: ReadonlySet<string> = new Set(['output', 'archive']);

const PARTIAL_PREFIX = '.bf-retag-';
const PARTIAL_SUFFIX = '.partial';
/**
 * Older than this and nobody is still writing or hashing it. A live one on another
 * machine sharing the library is younger, and losing it would only refuse that write.
 */
const PARTIAL_STALE_MS = 60 * 60 * 1000;

export interface M4bItem {
  /** The atom's name, one latin1 character per byte: `\xa9nam`, `covr`. */
  readonly name: string;
  readonly dataType: number;
  readonly data: Buffer;
}

export class M4bTagError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'M4bTagError';
  }
}

export interface M4bTagProgress {
  readonly phase: 'copying' | 'verifying';
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

/** How a new file is proved to hold the same book. `ffmpegM4bProbe` is the real one. */
export interface M4bProbe {
  /** A hash of the audio packets, read through the file's own sample tables. */
  audioPackets(file: string): Promise<string>;
  chapters(file: string): Promise<string>;
}

export interface SetM4bItemsOptions {
  readonly probe: M4bProbe;
  readonly onProgress?: (progress: M4bTagProgress) => void;
  /** Honoured until the swap. Stopping removes the partial and leaves the book as it was. */
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  /** What the volume has free. A keeper hands it a small number; the door asks statfs. */
  readonly freeBytes?: (dir: string) => Promise<number>;
  /** Named points in the write, so a keeper can kill the process at each one. */
  readonly checkpoint?: (name: string) => void;
}

/** BookForge's fields. Narrator → composer and series → grouping, the m4b-tool mapping. */
const TEXT_ATOMS: Readonly<Record<string, string>> = {
  title: '\xa9nam',
  artist: '\xa9ART',
  composer: '\xa9wrt',
  grouping: '\xa9grp',
  genre: '\xa9gen',
  date: '\xa9day',
  description: 'desc',
};

/** The items an audiobook's tags come to. An empty value is skipped, not cleared. */
export function audiobookItems(
  tags: Readonly<Record<string, string | undefined>>,
  cover: { readonly data: Buffer; readonly path: string } | null,
): M4bItem[] {
  const items: M4bItem[] = [];
  for (const [field, name] of Object.entries(TEXT_ATOMS)) {
    const value = tags[field];
    if (value === undefined || value === '') continue;
    items.push({ name, dataType: DATA_UTF8, data: Buffer.from(value, 'utf8') });
  }
  // iTunes "audiobook" media kind, so players treat it as one.
  items.push({ name: 'stik', dataType: DATA_INTEGER, data: Buffer.from([2]) });
  if (cover !== null) items.push(coverItem(cover.data, cover.path));
  return items;
}

/** PNG by its extension, JPEG otherwise, as the Python writer decided it. */
export function coverItem(data: Buffer, file: string): M4bItem {
  return { name: 'covr', dataType: file.toLowerCase().endsWith('.png') ? DATA_PNG : DATA_JPEG, data };
}

interface Atom {
  readonly name: string;
  /** File position of the atom's first header byte. */
  readonly start: number;
  readonly length: number;
  readonly headerLength: number;
}

const atomEnd = (atom: Atom): number => atom.start + atom.length;

function renderAtom(name: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(name, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function renderItem(item: M4bItem): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(item.dataType, 0);
  return renderAtom(item.name, renderAtom('data', Buffer.concat([head, item.data])));
}

function atomAt(name: string, start: number, length: number, headerLength: number, file: string): Atom {
  if (length < headerLength) {
    throw new M4bTagError('m4b_malformed', `${file} has a "${name}" atom at ${start} that is ${length} bytes long.`);
  }
  return { name, start, length, headerLength };
}

/** The children of `[from, to)` in a buffer that begins at file position `base`. */
function childrenIn(buffer: Buffer, base: number, from: number, to: number, file: string): Atom[] {
  const atoms: Atom[] = [];
  let at = from;
  while (at + 8 <= to) {
    const i = at - base;
    let length = buffer.readUInt32BE(i);
    const name = buffer.toString('latin1', i + 4, i + 8);
    let headerLength = 8;
    if (length === 1) {
      length = Number(buffer.readBigUInt64BE(i + 8));
      headerLength = 16;
    } else if (length === 0) {
      length = to - at;
    }
    const atom = atomAt(name, at, length, headerLength, file);
    if (atomEnd(atom) > to) {
      throw new M4bTagError('m4b_malformed', `${file} has a "${name}" atom at ${at} that runs past its parent.`);
    }
    atoms.push(atom);
    at += length;
  }
  return atoms;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new M4bTagError('m4b_malformed', `the file ended at ${position + done}, inside an atom.`);
    done += bytesRead;
  }
  return buffer;
}

async function topLevelAtoms(handle: FileHandle, size: number, file: string): Promise<Atom[]> {
  const atoms: Atom[] = [];
  let at = 0;
  while (at + 8 <= size) {
    const head = await readAt(handle, at, Math.min(16, size - at));
    let length = head.readUInt32BE(0);
    let headerLength = 8;
    if (length === 1) {
      length = Number(head.readBigUInt64BE(8));
      headerLength = 16;
    } else if (length === 0) {
      length = size - at;
    }
    const atom = atomAt(head.toString('latin1', 4, 8), at, length, headerLength, file);
    atoms.push(atom);
    at += length;
  }
  return atoms;
}

function child(atoms: readonly Atom[], name: string): Atom | undefined {
  return atoms.find((atom) => atom.name === name);
}

/** Where this moov's tags live, and whichever of them exist. */
interface TagPath {
  readonly moovAtom: Atom;
  readonly udta: Atom | undefined;
  readonly meta: Atom | undefined;
  readonly metaKids: readonly Atom[];
  readonly ilst: Atom | undefined;
}

function tagPathOf(moov: Buffer, moovAtom: Atom, file: string): TagPath {
  const base = moovAtom.start;
  const moovKids = childrenIn(moov, base, base + moovAtom.headerLength, atomEnd(moovAtom), file);
  const udta = child(moovKids, 'udta');
  const udtaKids = udta ? childrenIn(moov, base, udta.start + udta.headerLength, atomEnd(udta), file) : [];
  const meta = child(udtaKids, 'meta');
  // meta is a full box: four bytes of version and flags before its children.
  const metaKids = meta ? childrenIn(moov, base, meta.start + meta.headerLength + 4, atomEnd(meta), file) : [];
  return { moovAtom, udta, meta, metaKids, ilst: child(metaKids, 'ilst') };
}

/** The existing `ilst`'s items in order, with the given ones replaced or added at the end. */
function mergedIlst(moov: Buffer, moovStart: number, ilst: Atom, items: readonly M4bItem[], file: string): Buffer {
  const given = new Map(items.map((item) => [item.name, renderItem(item)]));
  const parts: Buffer[] = [];
  for (const old of childrenIn(moov, moovStart, ilst.start + ilst.headerLength, atomEnd(ilst), file)) {
    const replacement = given.get(old.name);
    if (replacement === undefined) {
      parts.push(moov.subarray(old.start - moovStart, atomEnd(old) - moovStart));
    } else {
      parts.push(replacement);
      given.delete(old.name);
    }
  }
  parts.push(...given.values());
  return renderAtom('ilst', Buffer.concat(parts));
}

/** A 4-byte write inside one sector cannot tear. One that crosses a boundary might. */
const crossesSector = (position: number): boolean => Math.floor(position / SECTOR_BYTES) !== Math.floor((position + 3) / SECTOR_BYTES);

/** An `ilst` beside another means a crash between the two flips. The first one stays. */
function strayIlsts(tags: TagPath): Atom[] {
  return tags.metaKids.filter((atom) => atom.name === 'ilst' && atom !== tags.ilst);
}

/** Into which adjacent `free` the new `ilst` fits, with what is left a valid atom or nothing. */
function roomBeside(tags: TagPath, rendered: Buffer): Atom | null {
  if (!tags.ilst) return null;
  const index = tags.metaKids.indexOf(tags.ilst);
  for (const free of [tags.metaKids[index + 1], tags.metaKids[index - 1]]) {
    if (free?.name !== 'free' || free.headerLength !== 8) continue;
    const rest = free.length - 8 - rendered.length;
    if (rest !== 0 && rest < 8) continue;
    if (crossesSector(free.start) || crossesSector(tags.ilst.start + 4)) continue;
    if (strayIlsts(tags).some((stray) => crossesSector(stray.start + 4))) continue;
    return free;
  }
  return null;
}

async function writeFlip(handle: FileHandle, position: number, bytes: Buffer, checkpoint: string, options: SetM4bItemsOptions): Promise<void> {
  await handle.write(bytes, 0, bytes.length, position);
  await handle.sync();
  options.checkpoint?.(checkpoint);
}

const uint32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
};
const FREE_NAME = Buffer.from('free', 'latin1');

/** THE FIRST PATH. Every step between these writes is a whole, playable book. */
async function writeIntoPadding(
  handle: FileHandle, tags: TagPath, free: Atom, rendered: Buffer, options: SetM4bItemsOptions, file: string,
): Promise<void> {
  const ilst = tags.ilst as Atom;
  const newAt = free.start + 8;
  const rest = free.length - 8 - rendered.length;
  const payload = rest === 0
    ? rendered
    : Buffer.concat([rendered, uint32(rest), FREE_NAME]);
  await handle.write(payload, 0, payload.length, newAt);
  await handle.sync();
  options.checkpoint?.('inplace:written');
  // `free` shrinks to its own header: the new ilst appears, whole, beside the old.
  await writeFlip(handle, free.start, uint32(8), 'inplace:both', options);
  await writeFlip(handle, ilst.start + 4, FREE_NAME, 'inplace:flipped', options);
  for (const stray of strayIlsts(tags)) {
    await writeFlip(handle, stray.start + 4, FREE_NAME, 'inplace:stray', options);
  }

  // Adjacent `free`s become one, so the room the old ilst leaves is there for the next edit.
  const meta = tags.meta as Atom;
  const kidsNow = async (): Promise<{ bytes: Buffer; kids: Atom[] }> => {
    const bytes = await readAt(handle, meta.start, meta.length);
    return { bytes, kids: childrenIn(bytes, meta.start, meta.start + meta.headerLength + 4, atomEnd(meta), file) };
  };
  const { kids } = await kidsNow();
  for (let i = 0; i < kids.length; i += 1) {
    if (kids[i].name !== 'free') continue;
    let last = i;
    while (kids[last + 1]?.name === 'free') last += 1;
    if (last > i && kids[i].headerLength === 8 && !crossesSector(kids[i].start)) {
      const total = atomEnd(kids[last]) - kids[i].start;
      await writeFlip(handle, kids[i].start, uint32(total), 'inplace:merge', options);
    }
    i = last;
  }
  options.checkpoint?.('inplace:merged');

  // A write nothing read back is not a success: one ilst, and it is the new one.
  const after = await kidsNow();
  const ilsts = after.kids.filter((atom) => atom.name === 'ilst');
  const only = ilsts[0];
  if (ilsts.length !== 1 || !after.bytes.subarray(only.start - meta.start, atomEnd(only) - meta.start).equals(rendered)) {
    throw new M4bTagError('m4b_write_unverified', `${file} did not read back as written.`);
  }
}

/** mutagen's `PaddingInfo.get_default_padding`: 1 KiB + 0.1 % of what follows. */
const lowPadding = (contentSize: number): number => 1024 + Math.floor(contentSize / 1000);

/** What the new file's moov replaces, and who holds it. */
interface Edit {
  readonly offset: number;
  readonly length: number;
  readonly replacement: Buffer;
  /** Every atom whose stated size grows with the replacement. */
  readonly parents: readonly Atom[];
}

function planNewFile(moov: Buffer, tags: TagPath, fileSize: number, items: readonly M4bItem[], file: string): Edit {
  const { moovAtom, udta, meta, ilst, metaKids } = tags;
  if (udta && meta && ilst) {
    const index = metaKids.indexOf(ilst);
    const before = metaKids[index - 1];
    const after = metaKids[index + 1];
    const free = before?.name === 'free' ? before : after?.name === 'free' ? after : null;
    const offset = free === null ? ilst.start : Math.min(ilst.start, free.start);
    const length = ilst.length + (free === null ? 0 : free.length);
    const rendered = mergedIlst(moov, moovAtom.start, ilst, items, file);
    // Room for one more whole ilst, so the next edit needs no whole-file copy.
    const padding = rendered.length + 16 + lowPadding(fileSize - (offset + length));
    return {
      offset, length,
      replacement: Buffer.concat([rendered, renderAtom('free', Buffer.alloc(padding))]),
      parents: [moovAtom, udta, meta],
    };
  }
  // No tags at all: a new meta at the front of udta, or a new udta at the front of moov.
  const hdlr = renderAtom('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('mdirappl', 'latin1'), Buffer.alloc(9)]));
  const newIlst = renderAtom('ilst', Buffer.concat(items.map(renderItem)));
  const holder = udta ?? moovAtom;
  const offset = holder.start + holder.headerLength;
  const padding = newIlst.length + 16 + lowPadding(fileSize - offset);
  const newMeta = renderAtom('meta', Buffer.concat([Buffer.alloc(4), hdlr, newIlst, renderAtom('free', Buffer.alloc(padding))]));
  return {
    offset, length: 0,
    replacement: udta ? newMeta : renderAtom('udta', newMeta),
    parents: udta ? [moovAtom, udta] : [moovAtom],
  };
}

/** Add `delta` to every chunk offset past `offset`, in a moov held in memory. */
function patchChunkOffsets(moov: Buffer, moovAtom: Atom, offset: number, delta: number, file: string): void {
  const base = moovAtom.start;
  const kids = (atom: Atom) => childrenIn(moov, base, atom.start + atom.headerLength, atomEnd(atom), file);
  for (const trak of kids(moovAtom).filter((atom) => atom.name === 'trak')) {
    const mdia = child(kids(trak), 'mdia');
    const minf = mdia && child(kids(mdia), 'minf');
    const stbl = minf && child(kids(minf), 'stbl');
    if (!stbl) continue;
    for (const table of kids(stbl)) {
      if (table.name !== 'stco' && table.name !== 'co64') continue;
      const wide = table.name === 'co64';
      const countAt = table.start - base + table.headerLength + 4;
      const count = moov.readUInt32BE(countAt);
      for (let i = 0; i < count; i += 1) {
        const at = countAt + 4 + i * (wide ? 8 : 4);
        const chunk = wide ? Number(moov.readBigUInt64BE(at)) : moov.readUInt32BE(at);
        if (chunk <= offset) continue;
        if (wide) {
          moov.writeBigUInt64BE(BigInt(chunk + delta), at);
        } else {
          if (chunk + delta > UINT32_MAX) {
            throw new M4bTagError('m4b_offset_overflow', `${file} has 32-bit chunk offsets, and these tags would push one past 4 GB.`);
          }
          moov.writeUInt32BE(chunk + delta, at);
        }
      }
    }
  }
}

function composeNewMoov(moov: Buffer, tags: TagPath, size: number, items: readonly M4bItem[], file: string): Buffer {
  const { moovAtom } = tags;
  for (const stray of strayIlsts(tags)) {
    FREE_NAME.copy(moov, stray.start - moovAtom.start + 4);
  }
  const edit = planNewFile(moov, tags, size, items, file);
  const delta = edit.replacement.length - edit.length;
  patchChunkOffsets(moov, moovAtom, edit.offset, delta, file);
  for (const parent of edit.parents) {
    const at = parent.start - moovAtom.start;
    if (parent.headerLength === 16) moov.writeBigUInt64BE(BigInt(parent.length + delta), at + 8);
    else moov.writeUInt32BE(parent.length + delta, at);
  }
  const inMoov = edit.offset - moovAtom.start;
  return Buffer.concat([moov.subarray(0, inMoov), edit.replacement, moov.subarray(inMoov + edit.length)]);
}

/** A name that says what it is, and no longer than a book's own could already be. */
function partialPathFor(file: string): string {
  const host = os.hostname().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  return path.join(path.dirname(file), `${PARTIAL_PREFIX}${host}-${process.pid}-${Date.now()}${PARTIAL_SUFFIX}`);
}

export function isM4bTagPartial(name: string): boolean {
  return name.startsWith(PARTIAL_PREFIX) && name.endsWith(PARTIAL_SUFFIX);
}

/** Remove what a crash left in this folder. Never a young one: it may be another machine's. */
export async function removeM4bTagLeftovers(dir: string, now: number = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return removed;
    throw err;
  }
  for (const name of names.filter(isM4bTagPartial)) {
    const full = path.join(dir, name);
    const { mtimeMs } = await fsp.stat(full);
    if (now - mtimeMs < PARTIAL_STALE_MS) continue;
    await unlinkWithRetry(full, LARGE_FILE_RETRY_DELAYS_MS);
    removed.push(full);
  }
  return removed;
}

/**
 * THE RECONCILER. At app start, over every project folder and the folders a book lives
 * in, so a partial from a crash does not sit on the NAS at the size of a book until
 * somebody edits that one again.
 */
export async function sweepM4bTagLeftovers(projectsDir: string): Promise<string[]> {
  const removed: string[] = [];
  const projects = await fsp.readdir(projectsDir, { withFileTypes: true });
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const root = path.join(projectsDir, project.name);
    removed.push(...await removeM4bTagLeftovers(root));
    const kids = await fsp.readdir(root, { withFileTypes: true });
    for (const kid of kids.filter((entry) => entry.isDirectory() && M4B_FOLDERS.has(entry.name))) {
      removed.push(...await removeM4bTagLeftovers(path.join(root, kid.name)));
    }
  }
  return removed;
}

async function freeBytesOf(dir: string): Promise<number> {
  const room = await fsp.statfs(dir);
  return Number(room.bavail) * Number(room.bsize);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** THE SECOND PATH. The original is only read, until the one rename that replaces it. */
async function writeNewFile(
  source: FileHandle, closeSource: () => Promise<void>, file: string, size: number, moovAtom: Atom,
  newMoov: Buffer, sourceMtimeMs: number, items: readonly M4bItem[], options: SetM4bItemsOptions,
): Promise<void> {
  const newSize = size - moovAtom.length + newMoov.length;
  const dir = path.dirname(file);
  const available = await (options.freeBytes ?? freeBytesOf)(dir);
  if (available < newSize + ROOM_MARGIN_BYTES) {
    throw new M4bTagError('m4b_no_room',
      `Writing these tags needs a whole new copy of ${path.basename(file)} beside it: `
      + `${Math.ceil((newSize + ROOM_MARGIN_BYTES) / 1e6)} MB, and ${Math.floor(available / 1e6)} MB are free. `
      + 'The book was not touched. Free some space and try again.');
  }

  const partial = partialPathFor(file);
  let swapped = false;
  try {
    const out = await fsp.open(partial, 'wx');
    try {
      let written = 0;
      let halfSeen = false;
      const put = async (bytes: Buffer): Promise<void> => {
        await out.write(bytes, 0, bytes.length, written);
        written += bytes.length;
        options.onProgress?.({ phase: 'copying', bytesDone: written, bytesTotal: newSize });
        if (!halfSeen && written >= newSize / 2) {
          halfSeen = true;
          options.checkpoint?.('copy:mid');
        }
      };
      const copyRange = async (from: number, to: number): Promise<void> => {
        let at = from;
        while (at < to) {
          if (aborted(options.signal)) return;
          const take = Math.min(COPY_CHUNK_BYTES, to - at);
          await put(await readAt(source, at, take));
          at += take;
        }
      };
      await copyRange(0, moovAtom.start);
      await put(newMoov);
      await copyRange(atomEnd(moovAtom), size);
      if (aborted(options.signal)) return;
      await out.sync();
    } finally {
      await out.close();
    }
    options.checkpoint?.('copy:written');

    options.onProgress?.({ phase: 'verifying', bytesDone: 0, bytesTotal: newSize });
    await verifyNewFile(partial, newSize, moovAtom, newMoov, file, items, options.probe);
    if (aborted(options.signal)) return;

    // The book must still be what was copied. A write since would be lost by this rename.
    const now = await source.stat();
    if (now.size !== size || now.mtimeMs !== sourceMtimeMs) {
      throw new M4bTagError('m4b_changed_underneath',
        `${path.basename(file)} changed while its new copy was being written, so the new copy was discarded and the book left as it is. Try again.`);
    }
    options.checkpoint?.('copy:verified');
    // Windows will not replace a file this process still has open.
    await closeSource();
    await renameWithRetry(partial, file, LARGE_FILE_RETRY_DELAYS_MS);
    swapped = true;
    options.checkpoint?.('copy:swapped');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new M4bTagError('m4b_no_room', `The volume filled while a new copy of ${path.basename(file)} was being written. The book was not touched.`);
    }
    if (LOCK_CODES.has((err as NodeJS.ErrnoException).code ?? '')) {
      throw new M4bTagError('m4b_file_held',
        `${path.basename(file)} is held by something else (a sync client or a player), after waiting. `
        + `The new tags were not applied and the book was not touched. ${(err as Error).message}`);
    }
    throw err;
  } finally {
    if (!swapped) {
      await unlinkWithRetry(partial, LARGE_FILE_RETRY_DELAYS_MS).catch((cleanupErr: Error) => {
        // The startup sweep finds it. Said out loud, because it is the size of a book.
        console.error(`[m4b-tags] Could not remove ${partial}: ${cleanupErr.message}`);
      });
    }
  }
}

async function verifyNewFile(
  partial: string, newSize: number, moovAtom: Atom, newMoov: Buffer, file: string,
  items: readonly M4bItem[], probe: M4bProbe,
): Promise<void> {
  const refuse = (what: string): M4bTagError => new M4bTagError('m4b_write_unverified',
    `The new copy of ${path.basename(file)} did not verify (${what}), so it was discarded and the book left as it is.`);
  const handle = await fsp.open(partial, 'r');
  try {
    const { size } = await handle.stat();
    if (size !== newSize) throw refuse(`it is ${size} bytes, not ${newSize}`);
    const back = await readAt(handle, moovAtom.start, newMoov.length);
    if (!back.equals(newMoov)) throw refuse('its moov did not read back as written');
    const tags = tagPathOf(back, { ...moovAtom, length: newMoov.length }, partial);
    const written = tags.ilst
      ? childrenIn(back, moovAtom.start, tags.ilst.start + tags.ilst.headerLength, atomEnd(tags.ilst), partial)
      : [];
    for (const item of items) {
      const found = child(written, item.name);
      const expected = renderItem(item);
      if (!found || !back.subarray(found.start - moovAtom.start, atomEnd(found) - moovAtom.start).equals(expected)) {
        throw refuse(`its ${JSON.stringify(item.name)} tag did not read back`);
      }
    }
  } finally {
    await handle.close();
  }
  const [audioOld, audioNew, chaptersOld, chaptersNew] = await Promise.all([
    probe.audioPackets(file), probe.audioPackets(partial), probe.chapters(file), probe.chapters(partial),
  ]);
  if (audioOld !== audioNew) throw refuse('its audio packets differ');
  if (chaptersOld !== chaptersNew) throw refuse('its chapters differ');
}

/**
 * Set these items on the file. A held file (a sync client, a player) is waited on within
 * a budget, but only until the first byte is written.
 */
export async function setM4bItems(file: string, items: readonly M4bItem[], options: SetM4bItemsOptions): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  await removeM4bTagLeftovers(path.dirname(file)).catch((err: Error) => {
    console.warn(`[m4b-tags] Could not clear old partials beside ${file}: ${err.message}`);
  });
  for (let tries = 0; ; tries += 1) {
    const state = { wrote: false };
    try {
      await attempt(file, items, options, state);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (state.wrote || typeof code !== 'string' || !LOCK_CODES.has(code)) throw err;
      if (tries >= LOCK_RETRY_DELAYS_MS.length) {
        throw new M4bTagError('m4b_file_held', `${file} is held by something else (a sync client or a player), after waiting: ${(err as Error).message}`);
      }
      await sleep(LOCK_RETRY_DELAYS_MS[tries]);
    }
  }
}

async function attempt(
  file: string, items: readonly M4bItem[], options: SetM4bItemsOptions, state: { wrote: boolean },
): Promise<void> {
  const handle = await fsp.open(file, 'r+');
  let open = true;
  const close = async (): Promise<void> => {
    if (open) {
      open = false;
      await handle.close();
    }
  };
  try {
    const { size, mtimeMs } = await handle.stat();
    const top = await topLevelAtoms(handle, size, file);
    const moovAtom = child(top, 'moov');
    if (!moovAtom) throw new M4bTagError('m4b_no_moov', `${file} has no moov atom, so it is not an MP4 file this can tag.`);
    if (child(top, 'moof')) {
      throw new M4bTagError('m4b_fragmented', `${file} is a fragmented MP4. BookForge does not write these, and tagging one is not supported.`);
    }

    const moov = await readAt(handle, moovAtom.start, moovAtom.length);
    const tags = tagPathOf(moov, moovAtom, file);
    const rendered = tags.ilst ? mergedIlst(moov, moovAtom.start, tags.ilst, items, file) : null;
    const free = rendered ? roomBeside(tags, rendered) : null;
    if (free && rendered) {
      state.wrote = true;
      await writeIntoPadding(handle, tags, free, rendered, options, file);
      return;
    }

    const newMoov = composeNewMoov(moov, tags, size, items, file);
    state.wrote = true;
    await writeNewFile(handle, close, file, size, moovAtom, newMoov, mtimeMs, items, options);
  } finally {
    await close();
  }
}

/** Runs one tool and hands back its stdout. A failure is the tool's own words. */
function run(tool: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tool, [...args], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(tool)} failed: ${stderr.trim().slice(-400) || err.message}`));
      else resolve(stdout);
    });
  });
}

export function ffmpegM4bProbe(ffmpeg: string, ffprobe: string): M4bProbe {
  return {
    audioPackets: (file) => run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).then((out) => out.trim()),
    chapters: (file) => run(ffprobe, ['-v', 'error', '-show_chapters', '-of', 'json', file]).then((out) => {
      const chapters = (JSON.parse(out) as { chapters?: Array<{ start_time: string; end_time: string; tags?: { title?: string } }> }).chapters ?? [];
      return JSON.stringify(chapters.map((c) => [c.start_time, c.end_time, c.tags?.title ?? null]));
    }),
  };
}
