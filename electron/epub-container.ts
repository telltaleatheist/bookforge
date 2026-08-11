/**
 * The EPUB container seam — an EPUB is a set of named entries, not a zip file.
 *
 * Every piece of code in this app that touches a book reaches for `ZipReader` /
 * `ZipWriter` from epub-processor.ts and, by doing so, hard-codes the container
 * format into 33 call sites. That was fine while every EPUB we owned was a zip.
 * It stops being fine the moment the WORKING COPY becomes an exploded directory:
 * editing one chapter label should write one 84 KB file, not re-deflate a 25.7 MB
 * archive so that its bytes can be re-hashed into a brand-new cache identity.
 *
 * So this module names what those call sites actually use — `EpubSource` (read a
 * book entry by entry) and `EpubSink` (write a book entry by entry) — and gives
 * a directory-backed implementation of each beside the zip-backed ones. The
 * surface is not invented: it is exactly `open/close/getEntries/hasEntry/
 * readEntry` and `addFile/write`, the five and two methods the existing sites
 * call and nothing more.
 *
 * WHAT THIS MODULE DOES NOT DO (deliberately, this is phase 1):
 * nothing routes through it yet. `ZipReader` and `ZipWriter` are unchanged in
 * behaviour and still constructed directly everywhere; every artifact on disk is
 * still exactly what it was. Phase 2 points the call sites at `openEpubSource` /
 * `createEpubSink`, and because the surface below was derived from them rather
 * than designed for them, that is a mechanical change.
 *
 * This file is a LEAF — fs/path only. `ZipReader`/`ZipWriter` are pulled in
 * lazily inside the factories, so identity code (sidecar-binding.ts) can use the
 * tree walk without dragging the whole 9000-line EPUB processor and cheerio in
 * behind it.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// The surface, taken from the call sites
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A book that can be read entry by entry.
 *
 * Exactly what the 21 `new ZipReader(...)` sites use. `readEntry` on a name that
 * is not there throws `Entry not found: <name>` — both implementations, same
 * words, because a caller that catches it catches it by shape.
 */
export interface EpubSource {
  /** Make the book readable. Must be called before anything else. */
  open(): Promise<void>;
  /** Release the handles. Safe to call when already closed. */
  close(): void;
  /** Every entry name, forward-slash relative, `mimetype` first when present. */
  getEntries(): string[];
  hasEntry(name: string): boolean;
  /** The entry's bytes, decompressed. Throws when the entry is not there. */
  readEntry(name: string): Promise<Buffer>;
}

/**
 * A book that is written entry by entry, then materialized in one call.
 *
 * Exactly what the 12 `new ZipWriter()` sites use. `compress` is a ZIP storage
 * decision (`mimetype` must be stored, never deflated); a directory has no such
 * axis and ignores it — the bytes are the bytes either way.
 */
export interface EpubSink {
  addFile(name: string, data: Buffer, compress?: boolean): void;
  /**
   * Put the added entries at `outputPath`, which is the whole book: an entry
   * that was not added is not in the result.
   */
  write(outputPath: string): Promise<void>;
}

/**
 * What a tree write actually cost — the point of the exercise, made observable.
 *
 * Phase 2's entire claim is "editing one chapter writes one file". That claim is
 * only checkable if the sink says which entries it touched, so it does.
 */
export interface DirectorySinkWriteReport {
  readonly root: string;
  /** Entries whose bytes are new or changed — the only files actually written. */
  readonly written: readonly string[];
  /** Entries already on disk with byte-identical content: not rewritten at all. */
  readonly unchanged: readonly string[];
  /** Entries that were on disk and are not in this book any more. */
  readonly removed: readonly string[];
  readonly bytesWritten: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry names
// ─────────────────────────────────────────────────────────────────────────────

// Windows device names. A book entry called `NUL` cannot become a file on
// Windows, and a silent skip would produce a tree that is quietly not the book.
// (CLAUDE.md: never create a file named NUL/CON/PRN/AUX/COM1-9/LPT1-9.)
const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// ExFAT/APFS/NTFS all cap ONE path component at 255. An exploded book adds a
// level of depth over the zip it came from, so this is checked where the name
// becomes a file rather than discovered as a misleading ENOENT later.
const MAX_COMPONENT_CHARS = 255;

/**
 * The absolute path an entry name maps to inside `root`, or a refusal saying why
 * it does not map to one.
 *
 * Every way an entry name can escape the tree it claims to be in is a refusal
 * here — `..`, a leading slash, a drive letter, a backslash (a ZIP entry name is
 * forward-slash by specification, and on Windows a backslash would silently
 * become a directory separator and change what the name means).
 */
export function resolveEpubEntryPath(root: string, name: string): string {
  const rootAbs = path.resolve(root);
  if (name.length === 0) {
    throw new Error(`Empty EPUB entry name under ${rootAbs}: an entry has to be called something.`);
  }
  if (name.includes('\\')) {
    throw new Error(
      `EPUB entry name "${name}" contains a backslash. Entry names are forward-slash by `
      + 'specification; on Windows a backslash would silently become a directory separator and '
      + 'change which file the name refers to, so it is refused rather than normalized.'
    );
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(
      `EPUB entry name "${name}" is absolute. An entry is addressed relative to the book, and an `
      + `absolute name would write outside ${rootAbs}.`
    );
  }
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(
        `EPUB entry name "${name}" has a "${segment}" path segment, so it does not name one entry `
        + `inside ${rootAbs}. Refused: a traversing name is how a book writes over something that `
        + 'is not the book.'
      );
    }
    if (segment.length > MAX_COMPONENT_CHARS) {
      throw new Error(
        `EPUB entry name "${name}" has a ${segment.length}-character path component and the `
        + `filesystem caps one component at ${MAX_COMPONENT_CHARS}. Refused here so it fails by `
        + 'name rather than as a misleading ENOENT.'
      );
    }
    const stem = segment.split('.')[0].toUpperCase();
    if (WINDOWS_DEVICE_NAMES.has(stem)) {
      throw new Error(
        `EPUB entry name "${name}" has the path component "${segment}", which Windows reserves for `
        + `a device (${stem}). It cannot become a file, and a book missing an entry is not the book.`
      );
    }
  }
  const abs = path.resolve(rootAbs, ...segments);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (!abs.startsWith(prefix)) {
    throw new Error(
      `EPUB entry name "${name}" resolves to ${abs}, which is outside ${rootAbs}. Refused.`
    );
  }
  return abs;
}

/**
 * Entry names in a zip's canonical EPUB order: `mimetype` first when it is
 * there, everything else sorted.
 *
 * The order is not decoration. A directory has no order of its own, and half the
 * re-write sites in this app do `for (const e of source.getEntries()) sink.addFile(e, ...)`
 * — so if a tree handed its names back alphabetically, `mimetype` (lowercase,
 * therefore last in ASCII) would land last in the zip that gets minted from it,
 * and OCF requires it first. Sorting the rest makes a tree's listing
 * deterministic, which is what makes a tree hash comparable at all.
 */
export function orderEpubEntryNames(names: readonly string[]): string[] {
  const rest = names.filter((n) => n !== 'mimetype').sort();
  return names.includes('mimetype') ? ['mimetype', ...rest] : rest;
}

/**
 * Every FILE under `root`, as forward-slash entry names in EPUB order.
 *
 * Files only: a zip written by `ZipWriter` has no directory entries, so a tree
 * that reported its directories would not have the same entry set as the archive
 * it came from. A symlink is a refusal — it is neither a book entry nor a thing
 * whose bytes we can honestly claim as the book's.
 */
export async function listEpubTreeEntries(root: string): Promise<string[]> {
  const rootAbs = path.resolve(root);
  const stat = await fs.promises.stat(rootAbs);
  if (!stat.isDirectory()) {
    throw new Error(`Not an EPUB directory: ${rootAbs}`);
  }
  const found: string[] = [];
  const walk = async (dirAbs: string, prefix: string): Promise<void> => {
    const dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      const name = `${prefix}${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        throw new Error(
          `${rootAbs} holds a symbolic link at ${name}. An exploded book is its own bytes; a link `
          + 'points at somebody else\'s, so this tree cannot be read as a book.'
        );
      }
      if (dirent.isDirectory()) {
        await walk(path.join(dirAbs, dirent.name), `${name}/`);
      } else if (dirent.isFile()) {
        found.push(name);
      } else {
        throw new Error(
          `${rootAbs} holds ${name}, which is neither a file nor a directory. An exploded book is `
          + 'files and the directories that hold them, and nothing else.'
        );
      }
    }
  };
  await walk(rootAbs, '');
  return orderEpubEntryNames(found);
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory-backed source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A book read out of a directory holding its entries as real files.
 *
 * `DirectoryEpubSource` over an exploded book yields the same entry names and
 * the same bytes as `ZipReader` over the zip of it — that equivalence is the
 * whole contract, and tools/test-epub-container.js asserts it against a fixture.
 */
export class DirectoryEpubSource implements EpubSource {
  private readonly rootAbs: string;
  private names: string[] | null = null;

  constructor(dirPath: string) {
    this.rootAbs = path.resolve(dirPath);
  }

  /** The directory this book is read from. */
  get root(): string {
    return this.rootAbs;
  }

  async open(): Promise<void> {
    this.names = await listEpubTreeEntries(this.rootAbs);
  }

  close(): void {
    this.names = null;
  }

  getEntries(): string[] {
    return [...this.requireOpen()];
  }

  hasEntry(name: string): boolean {
    return this.requireOpen().includes(name);
  }

  async readEntry(name: string): Promise<Buffer> {
    const names = this.requireOpen();
    if (!names.includes(name)) {
      // The same words ZipReader uses, so a caller that recognizes this failure
      // recognizes it whichever container the book is in.
      throw new Error(`Entry not found: ${name}`);
    }
    return fs.promises.readFile(resolveEpubEntryPath(this.rootAbs, name));
  }

  private requireOpen(): string[] {
    if (this.names === null) {
      throw new Error(`EPUB directory not open: ${this.rootAbs}`);
    }
    return this.names;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory-backed sink
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A book written into a directory, ONE FILE PER CHANGED ENTRY.
 *
 * This is where the win lives. The re-write sites in this app all have the same
 * shape — read every entry out of the book, swap the one or two that changed,
 * write every entry back — because a zip has no way to change one member in
 * place. Against a tree that same loop rewrites nothing it did not change: an
 * entry whose bytes match what is already on disk is not opened for writing, not
 * truncated, and does not get a new mtime. Editing one chapter of the Bonhoeffer
 * biography touches one 84 KB file instead of re-deflating 25.7 MB.
 *
 * `write()` materializes the WHOLE book, exactly as `ZipWriter.write()` does: an
 * entry that was on disk and was not added this time is removed, because a zip
 * written from the same calls would not have contained it either. Anything less
 * and the tree would silently accumulate members of books past.
 */
export class DirectoryEpubSink implements EpubSink {
  private readonly rootAbs: string;
  private readonly entries = new Map<string, Buffer>();
  private report: DirectorySinkWriteReport | null = null;

  constructor(dirPath: string) {
    this.rootAbs = path.resolve(dirPath);
  }

  /** The directory this book is written into. */
  get root(): string {
    return this.rootAbs;
  }

  addFile(name: string, data: Buffer, _compress?: boolean): void {
    // Validated at add time, not at write time: a name that cannot become a file
    // should fail where the caller can still see which entry it was talking about.
    resolveEpubEntryPath(this.rootAbs, name);
    if (this.entries.has(name)) {
      throw new Error(
        `${name} was added to ${this.rootAbs} twice. A ZIP would carry both copies and leave the `
        + 'reader to pick; a directory has one file per name, so the second add is refused rather '
        + 'than allowed to overwrite the first in silence.'
      );
    }
    this.entries.set(name, data);
  }

  async write(outputPath: string): Promise<void> {
    const outAbs = path.resolve(outputPath);
    if (outAbs !== this.rootAbs) {
      throw new Error(
        `This sink writes ${this.rootAbs} and was asked to write ${outAbs}. A directory sink is `
        + 'bound to its directory at creation; writing somewhere else would leave the entries it '
        + 'was told about in a place nobody asked for.'
      );
    }
    const existingStat = await statOrNull(outAbs);
    if (existingStat !== null && !existingStat.isDirectory()) {
      throw new Error(
        `${outAbs} is a file, and this book is being written as a directory. Nothing was written — `
        + 'removing a file to put a tree in its place is a decision for the caller, not for a sink.'
      );
    }
    await fs.promises.mkdir(outAbs, { recursive: true });

    const wanted = orderEpubEntryNames([...this.entries.keys()]);
    const onDisk = new Set(await listEpubTreeEntries(outAbs));

    const written: string[] = [];
    const unchanged: string[] = [];
    let bytesWritten = 0;

    for (const name of wanted) {
      const data = this.entries.get(name)!;
      const abs = resolveEpubEntryPath(outAbs, name);
      if (onDisk.has(name) && await bytesAlreadyThere(abs, data)) {
        unchanged.push(name);
        continue;
      }
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomically(abs, data);
      written.push(name);
      bytesWritten += data.length;
    }

    const removed: string[] = [];
    for (const name of onDisk) {
      if (this.entries.has(name)) continue;
      await fs.promises.rm(resolveEpubEntryPath(outAbs, name), { force: true });
      removed.push(name);
    }
    removed.sort();
    if (removed.length > 0) await pruneEmptyDirectories(outAbs);

    this.report = { root: outAbs, written, unchanged, removed, bytesWritten };
  }

  /**
   * What the last `write()` actually did. Throws before the first write — a
   * caller asking what a write cost when no write happened is asking about
   * nothing, and a zeroed report would answer "nothing was written", which is
   * true of a no-op and of a book that never got saved.
   */
  lastWrite(): DirectorySinkWriteReport {
    if (this.report === null) {
      throw new Error(`${this.rootAbs} has not been written yet, so there is nothing to report.`);
    }
    return this.report;
  }
}

/** True when the file at `abs` already holds exactly these bytes. */
async function bytesAlreadyThere(abs: string, data: Buffer): Promise<boolean> {
  const stat = await statOrNull(abs);
  if (stat === null || !stat.isFile()) return false;
  if (stat.size !== data.length) return false;
  const current = await fs.promises.readFile(abs);
  return current.equals(data);
}

/**
 * One entry, replaced whole or not at all.
 *
 * A tree write is not atomic across the book — nothing can make it so — but a
 * torn ENTRY is a different and worse thing: a half-written XHTML file is a book
 * that no longer parses. So the bytes land beside the entry and are renamed onto
 * it, with the same brief retry `processing-passes.ts` documents for Windows,
 * where a rename onto an open file is EPERM for as long as Defender, Syncthing
 * or the indexer happens to be holding it.
 */
async function writeFileAtomically(abs: string, data: Buffer): Promise<void> {
  const temp = `${abs}.bookforge-entry-tmp`;
  await fs.promises.writeFile(temp, data);
  const HOLDS = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const DELAYS_MS = [50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(temp, abs);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = process.platform === 'win32' && code !== undefined && HOLDS.has(code);
      if (!transient || attempt >= DELAYS_MS.length) {
        await fs.promises.rm(temp, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, DELAYS_MS[attempt]));
    }
  }
}

/** Directories left empty by removed entries, taken away bottom-up. */
async function pruneEmptyDirectories(rootAbs: string): Promise<void> {
  const prune = async (dirAbs: string): Promise<boolean> => {
    const dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    let remaining = 0;
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        const emptied = await prune(path.join(dirAbs, dirent.name));
        if (!emptied) remaining++;
      } else {
        remaining++;
      }
    }
    if (remaining === 0 && dirAbs !== rootAbs) {
      await fs.promises.rmdir(dirAbs);
      return true;
    }
    return false;
  };
  await prune(rootAbs);
}

async function statOrNull(abs: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The factories — the one place that decides zip or tree
// ─────────────────────────────────────────────────────────────────────────────

export type EpubContainerKind = 'zip' | 'directory';

/** Which container a path IS. `null` when nothing is there. */
export async function epubContainerKindAt(epubPath: string): Promise<EpubContainerKind | null> {
  const stat = await statOrNull(path.resolve(epubPath));
  if (stat === null) return null;
  return stat.isDirectory() ? 'directory' : 'zip';
}

/**
 * A book opened for reading, whichever container it is in.
 *
 * The kind is read off the filesystem — what the path IS, never what its name
 * suggests — and it is named in every failure, because "Entry not found" reads
 * very differently when you learn the thing you opened was a directory.
 *
 * Returns an ALREADY-OPEN source: the two lines every call site writes today
 * (`new ZipReader(p)` then `await r.open()`) become one, and there is no window
 * in which a caller holds a source it has forgotten to open.
 */
export async function openEpubSource(epubPath: string): Promise<EpubSource> {
  const abs = path.resolve(epubPath);
  const kind = await epubContainerKindAt(abs);
  if (kind === null) {
    throw new Error(`No EPUB at ${abs}: it is neither a file nor a directory.`);
  }
  // A failed open still has to give its handle back. `ZipReader.open()` does an
  // `fs.openSync` BEFORE it parses the central directory, so a file that turns
  // out not to be an archive leaves a descriptor held open — and on Windows that
  // descriptor is what later makes the file undeletable and a rename onto it
  // EPERM. (Caught by tools/test-epub-container.js, which could not clean up its
  // own scratch directory after opening a deliberately-not-a-zip file.)
  let source: EpubSource;
  if (kind === 'directory') {
    source = new DirectoryEpubSource(abs);
  } else {
    const { ZipReader } = await import('./epub-processor.js');
    source = new ZipReader(abs);
  }
  try {
    await source.open();
  } catch (err) {
    source.close();
    throw new Error(
      kind === 'directory'
        ? `${abs} is a directory and could not be read as an exploded EPUB: ${(err as Error).message}`
        : `${abs} is a file and could not be read as a ZIP EPUB: ${(err as Error).message}`
    );
  }
  return source;
}

/**
 * A book opened for writing, whichever container it is to be in.
 *
 * The kind is STATED by the caller, never inferred. Every site that writes a
 * book knows what it is writing — the `.tts.epub` handed to ebook2audiobook is
 * a zip because e2a parses a zip; the working copy is a tree because it gets
 * edited. Inferring it from the name is a guess, and it guesses wrong in the
 * one case that matters: a staging file named `retitle-<sha>.epub` that is
 * about to be landed on a book which is a TREE would be written as a zip, and
 * the mistake only surfaces later, as a book-shaped file in a tree's place.
 *
 * When something already exists at the path, its kind must agree with the one
 * asked for. Writing a zip over a tree (or the reverse) is never what a caller
 * meant, and it is caught here rather than half-done on disk.
 */
export async function createEpubSink(
  outputPath: string,
  kind: EpubContainerKind,
): Promise<EpubSink> {
  const abs = path.resolve(outputPath);
  const existing = await epubContainerKindAt(abs);
  if (existing !== null && existing !== kind) {
    throw new Error(
      `${abs} is already ${existing === 'directory' ? 'an exploded directory' : 'a file'}, but it `
      + `was asked for as ${kind === 'directory' ? 'an exploded directory' : 'a ZIP'}. A book does `
      + 'not change container by being written over; nothing was written.'
    );
  }
  if (kind === 'directory') return new DirectoryEpubSink(abs);
  const { ZipWriter } = await import('./epub-processor.js');
  return new ZipWriter();
}

// ─────────────────────────────────────────────────────────────────────────────
// The rewrite — the shape every edit in this app has
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a book, write the book it becomes, land it.
 *
 * ── Why this is one function and not twenty loops ───────────────────────────
 *
 * Every edit in this app has the same three lines and had them written out
 * twenty times: open the book, walk its entries into a writer swapping the one
 * or two that changed, put the result somewhere. The differences between the
 * copies were never about the book — they were about which temp file each site
 * invented, whether it remembered to close its reader, and in which order. Those
 * are exactly the details that are WRONG for a tree, so they live here now, once.
 *
 * ── `from` and `to` may be the same book ────────────────────────────────────
 *
 * That is the interesting case and the reason for the ordering below. A ZIP
 * cannot have one member replaced, so `ZipWriter.write()` materializes a
 * complete archive beside the target and renames it on — and Windows refuses
 * that rename while ANY descriptor is still open on the target, which is why the
 * source is released before the sink lands rather than in a `finally` after it.
 * A tree has no such constraint (`DirectoryEpubSink` opens only the entries whose
 * bytes actually changed), so releasing first is the rule that is correct for
 * both containers, and neither container's staging strategy is baked in here:
 * `write()` decides. That is what makes phase 2c's one-file write fall out of
 * these call sites for free instead of having to be re-plumbed through twenty
 * hand-rolled `path + '.tmp'` renames.
 *
 * `build` receives the OPEN source and the sink, and decides everything about
 * the result: an entry it does not add is not in the book that lands. It must
 * not use the source after it returns — `readEntry` on a released source throws.
 */
export async function rewriteEpubEntries(options: {
  /** The book to read. */
  from: string;
  /** Where the result lands. May be `from`. */
  to: string;
  /** The container `to` is written as — stated, never inferred. */
  toKind: EpubContainerKind;
  build: (source: EpubSource, sink: EpubSink) => Promise<void>;
}): Promise<EpubSink> {
  const source = await openEpubSource(options.from);
  try {
    const sink = await createEpubSink(options.to, options.toKind);
    await options.build(source, sink);
    // Before the land, never after it: see the header. Closing in the `finally`
    // alone would hold a descriptor across the rename that lands a ZIP over the
    // book it was read from. Both sources close idempotently, so the `finally`
    // below stays as the arm that covers a `build` that threw.
    source.close();
    await sink.write(options.to);
    return sink;
  } finally {
    source.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory MARKER entries — the one thing a ZIP has that a tree cannot
// ─────────────────────────────────────────────────────────────────────────────

/** A book's entries, split into the ones a tree can hold and the ones it cannot. */
export interface EpubEntryPartition {
  /** The book's real entries: everything a tree holds as a file. */
  readonly content: string[];
  /**
   * Zero-length `EPUB/`-style entries — a ZIP's record that a folder exists.
   * Empty by definition and dropped by an explosion; listed so a caller can say
   * out loud what it did not carry across.
   */
  readonly directoryMarkers: string[];
}

/**
 * Split an open book's entries into content and directory MARKERS.
 *
 * ── The decision this function IS ───────────────────────────────────────────
 *
 * A ZIP central directory may carry an entry whose name ends in `/` and whose
 * body is zero bytes — `EPUB/`, `OEBPS/images/`. It is a record that a folder
 * exists, written by some zip tools and by no EPUB requirement; `ZipWriter`
 * writes none, and no reader in this app or in quire ever reads one. An exploded
 * tree cannot reproduce them: `listEpubTreeEntries` reports FILES, and a folder
 * with no files in it is not a thing a tree can distinguish from a folder that
 * was never there.
 *
 * So the ruling, made here once rather than guessed at five call sites: **a
 * directory marker is not a book entry.** An explosion drops it, and an
 * entry-for-entry verification compares CONTENT against content. Deciding the
 * other way would refuse a valid migration of every publisher EPUB that happens
 * to have been zipped by a tool that writes them.
 *
 * The one thing that is NOT waved through is a trailing-slash entry with bytes
 * in it. That is not a folder record — it is a file whose name ends in a
 * separator, which no filesystem can hold and which a silent drop would erase.
 * It is refused by name.
 */
export async function partitionEpubEntries(source: EpubSource): Promise<EpubEntryPartition> {
  const content: string[] = [];
  const directoryMarkers: string[] = [];
  for (const name of source.getEntries()) {
    if (!name.endsWith('/')) {
      content.push(name);
      continue;
    }
    const bytes = await source.readEntry(name);
    if (bytes.length > 0) {
      throw new Error(
        `This book has an entry called "${name}", whose name ends in a separator but which holds `
        + `${bytes.length} bytes. A trailing slash means "this is a folder", and a folder has no `
        + 'contents of its own — so this entry is neither a file a tree can hold nor a folder record '
        + 'that can be dropped. Nothing was written.'
      );
    }
    directoryMarkers.push(name);
  }
  return { content, directoryMarkers };
}

/**
 * Take away whichever container is at `epubPath`.
 *
 * Every caller of this is the cleanup arm of a refusal whose message ends
 * "Nothing was written." A plain `fs.rm(path, { force: true })` makes that
 * sentence a lie for a directory: `rm` without `recursive` fails with ERR_FS_EISDIR
 * on a non-empty one, and `force` swallows only ENOENT — so the half-written book
 * stays on disk while the caller tells the user it does not exist, and the next
 * pass reads it as if it had been verified. `recursive` removes a file just as
 * happily as a tree, so one call is honest about both.
 */
export async function removeEpubContainer(epubPath: string): Promise<void> {
  await fs.promises.rm(path.resolve(epubPath), { force: true, recursive: true });
}
