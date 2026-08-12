// Sidecar Binding Protocol v1 — bookforge-sidecar-binding-v1
//
// A cover or transcript (VTT) is delivered as a SIDECAR file next to its m4b,
// but is only ever served after we prove it belongs to THOSE EXACT m4b bytes.
// The proof is `m4b.sha256`: a reader accepts a sidecar only when the current
// m4b hashes to the value recorded in its binding. A mismatch fails closed
// (fall back to the embedded copy / a live fetch), so a cover or transcript can
// never spill onto the wrong audiobook — the guarantee the embed-only mono path
// gave, now decoupled from the audio bytes.
//
// Two identity tiers:
//   • delivery   — cached by (path,size,mtime); avoids re-hashing 500 MB on every
//                  cover/VTT request. The cache is invalidated the instant size or
//                  mtime moves, so a re-rendered m4b is never trusted from cache.
//   • authoritative (strict) — always streams and hashes every byte. Used at
//                  migration/commit and by the offline device before it pins a
//                  sidecar to a downloaded copy.
//
// This module is the single source of truth for the record shape, the co-located
// sidecar paths, hashing, and validation. It reuses the analysis protocol's
// canonical VTT cue digest so a transcript's identity is defined once.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { digestAudiobookCues, parseAudiobookVttStrict } from './audiobook-analysis-canonical';
import {
  listEpubTreeEntries,
  resolveEpubEntryPath,
  type EpubContainerKind,
} from './epub-container';
import {
  EPUB_FILE_DIGEST_ALGORITHM,
  EPUB_TREE_DIGEST_ALGORITHM,
  formatBookDigest,
  type BookDigestAlgorithm,
} from '../shared/book-digest';

export const SIDECAR_BINDING_VERSION = 'bookforge-sidecar-binding-v1' as const;
export const SIDECAR_VTT_DIGEST_ALGORITHM = 'bookforge-vtt-cues-v1' as const;

export type SidecarAssetKind = 'vtt' | 'cover';
export type SidecarAssetSource = 'embedded' | 'metadata' | 'external';

export interface SidecarAssetRecord {
  /** Project-relative path to the sidecar file. */
  path: string;
  /** SHA-256 of the sidecar file's own bytes (detects a corrupted/edited sidecar). */
  sha256: string;
  bytes: number;
  /** Where the migration sourced this asset from, for audit. */
  source: SidecarAssetSource;
  // VTT-only: the canonical transcript identity (same algorithm as the analysis
  // protocol) so a transcript is bound by MEANING, not just file bytes.
  transcriptDigestAlgorithm?: typeof SIDECAR_VTT_DIGEST_ALGORITHM;
  transcriptSha256?: string;
  cueCount?: number;
}

export interface SidecarBinding {
  protocol: typeof SIDECAR_BINDING_VERSION;
  /** The manifest project that owns the audiobook (folder slug). */
  projectId: string;
  /** The variant id from getVariants() — 'audiobook', 'bilingual:<pair>', or a UUID. */
  variantId: string;
  m4b: {
    /** Project-relative path recorded for audit; identity is the hash, not the path. */
    path: string;
    sha256: string;
    bytes: number;
  };
  assets: Partial<Record<SidecarAssetKind, SidecarAssetRecord>>;
  createdAt: string;
  generator: string;
}

// ── hashing ──────────────────────────────────────────────────────────────────

/** Stream every byte of a file to SHA-256, rejecting if the file changes mid-hash
 *  (mirrors the analysis protocol's TOCTOU guard). */
export async function sha256File(filePath: string): Promise<{ sha256: string; size: number }> {
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error(`Not a file: ${filePath}`);
  const hash = (await import('crypto')).createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const after = await fs.promises.stat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`File changed while its identity was being hashed: ${filePath}`);
  }
  return { sha256: hash.digest('hex'), size: after.size };
}

// The algorithm names, and how a digest of each is written down, live in
// `shared/book-digest.ts` — the renderer and the tools read the same recorded
// values, so the vocabulary cannot be an electron-only one. Re-exported here
// because this is where the digests are COMPUTED.
export {
  EPUB_FILE_DIGEST_ALGORITHM,
  EPUB_TREE_DIGEST_ALGORITHM,
  type BookDigestAlgorithm,
} from '../shared/book-digest';

// ── The exploded book's entry hashes, remembered ────────────────────────────
//
// ── The measurement that made this necessary ────────────────────────────────
//
// Owen, 2026-08-11: "switching labels still takes forever." Measured on the
// migrated Nuremberg project (84 entries, 32.5 MB, of which 31 MB is 64 page
// images), one click on the category palette cost 1500 ms, and 740 ms of it was
// two `bookDigest` calls — `setBookBlockCategory` measures the book before its
// edit and again after it, and `nameChapterOpenings` runs behind every written
// relabel and measures it a third time. While the working copy was a single
// zip that was one 32 MB stream each; exploded it is the same 32 MB, and it is
// SHA-256 over all 64 page images to record that one `<p>` is now a heading.
//
// The images are not read, not parsed and not changed by any text edit. Hashing
// them is only ever asking "are these still the bytes I hashed a moment ago",
// and the filesystem already answers that.
//
// ── The rule, and why it is sound ───────────────────────────────────────────
//
// A remembered hash is used ONLY when all five of the entry's `stat` fields are
// bit-identical to the reading it was recorded under: device, inode, size,
// mtime and ctime, taken at NANOSECOND resolution (`{ bigint: true }` — the
// millisecond fields cannot see two writes inside one tick). Anything else —
// any field moved, no record at all — is hashed.
//
// That rule holds against both kinds of writer:
//
//  - THIS APP. Every byte that reaches a book entry goes through
//    `writeFileAtomically` (electron/epub-container.ts): bytes to a temp file,
//    rename onto the entry. The rename installs the temp file's own NTFS record,
//    so the INODE moves on every write we make — measured on E:, 2026-08-11:
//    two same-length atomic writes gave ino …855844 then …855845. A stale hit is
//    not merely unlikely there, it is unreachable.
//  - ANYTHING ELSE, rewriting an entry in place. Then the inode stays and the
//    timestamps are what tell: 200 same-length in-place rewrites in a tight loop
//    produced 197 distinct `mtimeNs` values, i.e. NTFS is stamping at ~1 µs, not
//    at the 15.6 ms scheduler tick. A foreign process would have to rewrite an
//    entry to the SAME byte length inside the same microsecond as our own
//    reading to be missed.
//
// The cache is recorded only when the entry's ns identity is UNCHANGED across
// the hash — if it moved, the value is still returned (`sha256File` owns that
// judgement and has always owned it) but nothing is written down, because we
// cannot say which bytes the hash describes. Nothing is refused that was not
// refused before; this adds no new way for a relabel to fail.
//
// This is the same tier the delivery-identity cache below already is, for the
// same reason and with a stricter key.
const treeEntryHashCache = new Map<string, { identity: string; sha256: string; size: number }>();

/**
 * How many entries are remembered before the map is emptied and refilled.
 *
 * A book has of the order of a hundred entries and the library has 43 books, so
 * this is roughly ten libraries' worth — the bound exists so a session that
 * walks every project on disk cannot grow the map without end, not because any
 * ordinary use approaches it. Cleared whole rather than evicted one at a time:
 * a miss costs one file hash, so the cheapest correct policy is the simplest.
 */
const TREE_ENTRY_CACHE_LIMIT = 20_000;

/** The five fields that decide whether an entry is still the file we hashed. */
function entryStatIdentity(st: fs.BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * One tree entry's SHA-256 — measured, or remembered from when it was measured.
 *
 * `sha256File` with a memory. See the block above for the invalidation rule and
 * for the measurements it rests on.
 */
async function treeEntrySha256(abs: string): Promise<{ sha256: string; size: number }> {
  const before = await fs.promises.stat(abs, { bigint: true });
  const identity = entryStatIdentity(before);
  const remembered = treeEntryHashCache.get(abs);
  if (remembered !== undefined && remembered.identity === identity) {
    return { sha256: remembered.sha256, size: remembered.size };
  }

  const measured = await sha256File(abs);
  const after = await fs.promises.stat(abs, { bigint: true });
  if (entryStatIdentity(after) !== identity) {
    // The file moved under the hash at a resolution `sha256File`'s own guard
    // cannot see. Its verdict on the VALUE stands; what does not stand is any
    // claim about which reading this hash belongs to, so it is not recorded and
    // whatever was recorded before is dropped.
    treeEntryHashCache.delete(abs);
    return measured;
  }
  if (treeEntryHashCache.size >= TREE_ENTRY_CACHE_LIMIT) treeEntryHashCache.clear();
  treeEntryHashCache.set(abs, { identity, sha256: measured.sha256, size: measured.size });
  return measured;
}

/**
 * `sha256File`'s directory sibling — the content identity of an EXPLODED EPUB.
 *
 * The working copy is becoming a directory (`source/<base>.working/`) so that
 * editing one chapter writes one file instead of re-deflating a 25.7 MB archive.
 * A directory has no bytes of its own to hash, and the bytes a zip of it would
 * have are not an identity either: they move with compression level, entry order
 * and the zero timestamps `ZipWriter` writes. So the identity is defined over
 * the CONTENT, canonically:
 *
 *     sha256( for each entry, sorted by name: `<name>\0<sha256 of its bytes>\n` )
 *
 * Order-independent (the listing is sorted, not enumerated), deterministic
 * across machines and across a mint, and blind to everything about the container
 * that is not the book.
 *
 * The integrity property is `sha256File`'s, twice over. Each entry is hashed
 * through `sha256File` itself, so a file that moves mid-hash is the same loud
 * `File changed while its identity was being hashed` it has always been; and the
 * tree is re-listed afterwards, so an entry appearing or disappearing WHILE the
 * hash was being taken is a refusal too. A tree hash that quietly described a
 * book that no longer exists is precisely the thing this is here to prevent.
 *
 * The entry hashes come through `treeEntrySha256`, which remembers them — see
 * its header for the measurement that made that necessary and for the rule that
 * decides when a remembered one may be used.
 */
export async function epubTreeSha256(
  dirPath: string
): Promise<{ sha256: string; size: number; entryCount: number }> {
  const abs = path.resolve(dirPath);
  const before = await fs.promises.stat(abs);
  if (!before.isDirectory()) throw new Error(`Not a directory: ${abs}`);

  // Sorted by name, NOT by the order the filesystem handed them over: two
  // machines enumerate a directory differently and must still agree on the book.
  const names = (await listEpubTreeEntries(abs)).slice().sort();
  const lines: string[] = [];
  let size = 0;
  for (const name of names) {
    const entry = await treeEntrySha256(resolveEpubEntryPath(abs, name));
    lines.push(`${name}\0${entry.sha256}\n`);
    size += entry.size;
  }

  const after = (await listEpubTreeEntries(abs)).slice().sort();
  const moved = after.length !== names.length || after.some((name, i) => name !== names[i]);
  if (moved) {
    throw new Error(
      `Tree changed while its identity was being hashed: ${abs} (${names.length} entries when the `
      + `hash started, ${after.length} when it finished). No digest was returned — a tree hash that `
      + 'described a book which no longer exists is worse than no hash at all.'
    );
  }

  const hash = crypto.createHash('sha256');
  hash.update(lines.join(''), 'utf8');
  return { sha256: hash.digest('hex'), size, entryCount: names.length };
}

/** A book's measured identity, and everything a caller needs to know about it. */
export interface BookIdentity {
  /**
   * The identity AS IT IS RECORDED AND COMPARED. Self-describing: an exploded
   * book's digest carries its algorithm, an archived book's is the bare 64 hex
   * characters every manifest on disk already holds (shared/book-digest.ts).
   */
  digest: string;
  /**
   * The 64 hex characters, tag stripped — for NAMES, not for identity. Slicing
   * `digest` for a staged filename would give every exploded book the same
   * prefix and collide two books' staging files.
   */
  hex: string;
  algorithm: BookDigestAlgorithm;
  /** What the book IS on disk, MEASURED. Never inferred from the path's name. */
  container: EpubContainerKind;
  /** The archive's length, or the sum of the tree's entries' lengths. */
  size: number;
  /** Entries in the tree. Absent for an archive, which is hashed, not opened. */
  entryCount?: number;
}

/**
 * A BOOK's identity, whichever container it is in — the one entry point every
 * site that hashes the working copy goes through.
 *
 * ── Why a dispatcher and not two call sites ─────────────────────────────────
 *
 * The working copy is becoming an exploded directory, and there are 20 places
 * that hash it: the strike record's stamp, every book edit's before-and-after,
 * the narration copy's provenance. `sha256File` throws `Not a file` on a
 * directory, so on the day the flip lands all 20 would throw at once — and the
 * fix "hash it the other way here too" written 20 times is 20 chances to record
 * an identity in a form the next reader does not expect. There is one rule and
 * it lives here: what the path IS decides how it is measured, and the value
 * says which way it was measured.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 *  - A regular FILE is hashed by `sha256File`, and `digest` is that hash
 *    UNCHANGED — the bare 64 hex characters. This is the behaviour-preservation
 *    guarantee: while every book is still a zip, every value this returns is
 *    byte-for-byte the value the call site recorded before it was moved here.
 *  - A DIRECTORY is hashed by `epubTreeSha256`, and `digest` carries the
 *    algorithm tag so a reader can tell the two apart rather than reading a
 *    re-measurement as a changed book.
 *  - Anything else — a named pipe, a device, a socket, nothing at all — is a
 *    refusal naming the path and what is actually there. There is no third way
 *    to hash a book and no default to fall back to.
 *
 * ── The integrity property, in both directions ──────────────────────────────
 *
 * `sha256File` refuses a file that moved while it was being read, and
 * `epubTreeSha256` refuses a tree whose entry list moved while it was being
 * walked. Dispatching adds one more way to be wrong that neither of them can
 * see: the CONTAINER ITSELF changing between the stat that chose the algorithm
 * and the digest coming back — which is precisely what the migration does, and
 * it does it by rename, so it is not hypothetical. So the kind is re-measured
 * afterwards and a digest whose container moved underneath it is refused. A
 * digest of something that is no longer there is not a digest.
 */
export async function bookDigest(bookPath: string): Promise<BookIdentity> {
  const abs = path.resolve(bookPath);
  const before = await statForDigest(abs);

  if (before.isFile()) {
    const { sha256, size } = await sha256File(abs);
    await refuseIfContainerMoved(abs, 'zip');
    return {
      digest: formatBookDigest(EPUB_FILE_DIGEST_ALGORITHM, sha256),
      hex: sha256,
      algorithm: EPUB_FILE_DIGEST_ALGORITHM,
      container: 'zip',
      size,
    };
  }

  if (before.isDirectory()) {
    const { sha256, size, entryCount } = await epubTreeSha256(abs);
    await refuseIfContainerMoved(abs, 'directory');
    return {
      digest: formatBookDigest(EPUB_TREE_DIGEST_ALGORITHM, sha256),
      hex: sha256,
      algorithm: EPUB_TREE_DIGEST_ALGORITHM,
      container: 'directory',
      size,
      entryCount,
    };
  }

  throw new Error(
    `${abs} cannot be measured as a book: it is ${describeStatKind(before)}. A book is either an `
    + 'archive file or a folder of its parts, and there is no way to take the identity of anything '
    + 'else.'
  );
}

async function statForDigest(abs: string): Promise<fs.Stats> {
  try {
    return await fs.promises.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `There is no book at ${abs}, so it has no identity to take. Nothing was measured.`
      );
    }
    throw err;
  }
}

/** Refuse a digest whose container changed while it was being taken. */
async function refuseIfContainerMoved(abs: string, was: EpubContainerKind): Promise<void> {
  const after = await statForDigest(abs);
  const now: EpubContainerKind | 'neither' = after.isFile()
    ? 'zip'
    : after.isDirectory() ? 'directory' : 'neither';
  if (now === was) return;
  throw new Error(
    `${abs} changed from ${describeContainer(was)} to ${
      now === 'neither' ? describeStatKind(after) : describeContainer(now)
    } while its identity was being taken. No digest was returned — one measured the way the old `
    + 'container was measured would describe a book that is no longer there.'
  );
}

function describeContainer(kind: EpubContainerKind): string {
  return kind === 'zip' ? 'an archive file' : 'a folder of its parts';
}

function describeStatKind(stat: fs.Stats): string {
  if (stat.isFile()) return 'a file';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFIFO()) return 'a named pipe';
  if (stat.isSocket()) return 'a socket';
  if (stat.isBlockDevice()) return 'a block device';
  if (stat.isCharacterDevice()) return 'a character device';
  if (stat.isSymbolicLink()) return 'a symbolic link with no target';
  return 'neither a file nor a directory';
}

// Delivery-tier identity cache: (absolute path) → last known {sha256,size,mtime}.
// Machine-local and process-lifetime only; never persisted (a persisted digest
// keyed by size/mtime is exactly what the protocol forbids for authoritative use).
const deliveryIdentityCache = new Map<string, { sha256: string; size: number; mtimeMs: number }>();

/** The m4b's content identity. `strict` re-hashes every byte (authoritative);
 *  otherwise a cached hash is returned when size AND mtime are unchanged. */
export async function m4bIdentity(m4bPath: string, opts?: { strict?: boolean }): Promise<{ sha256: string; size: number }> {
  const abs = path.resolve(m4bPath);
  const st = await fs.promises.stat(abs);
  if (!opts?.strict) {
    const cached = deliveryIdentityCache.get(abs);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return { sha256: cached.sha256, size: cached.size };
    }
  }
  const { sha256, size } = await sha256File(abs);
  deliveryIdentityCache.set(abs, { sha256, size, mtimeMs: st.mtimeMs });
  return { sha256, size };
}

/** Canonical transcript identity for a VTT string (throws on a malformed VTT). */
export function vttDigest(vttText: string): { transcriptSha256: string; cueCount: number } {
  const cues = parseAudiobookVttStrict(vttText);
  return { transcriptSha256: digestAudiobookCues(cues), cueCount: cues.length };
}

// ── sidecar paths ────────────────────────────────────────────────────────────

// The longest asset suffix we append (".sidecars.json") plus a little slack.
// Filenames must stay under the 255-BYTE component limit (ExFAT/APFS). Most book
// names fit as-is; the few very long ones get a deterministic hashed tail so the
// writer and reader always agree on the name without a directory scan.
const SIDECAR_MAX_BASE_BYTES = 255 - 16;

/** The co-located sidecar BASE path for an m4b (no extension). Deterministic:
 *  the reader derives the same base from the m4b path, so sidecars are found by
 *  derivation, never by scanning. Readable (`Book.m4b`) when the name fits; a
 *  truncated name + `~<sha1[:8]>` when it would overflow the filesystem limit. */
export function sidecarBase(m4bPath: string): string {
  return path.join(path.dirname(m4bPath), boundedSidecarName(path.basename(m4bPath)));
}

/**
 * The naming rule itself, without a directory — so a sidecar that CANNOT sit
 * beside its primary still gets the same name.
 *
 * The document pipeline needs exactly that: its primary is `archive/<Book>.pdf`
 * and archive/ is never written to, so the binding record lives in the project
 * ROOT while still being named after the primary (DOCUMENT_PIPELINE.md, "Documents,
 * names, and bindings"). One rule, two directories — the alternative was a second
 * copy of the 255-byte budget that would drift the day one of them was tuned.
 */
export function boundedSidecarName(name: string): string {
  if (Buffer.byteLength(name) <= SIDECAR_MAX_BASE_BYTES) return name;
  const tag = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  // Trim by characters conservatively (well under the byte budget for any script).
  return `${name.slice(0, 180)}~${tag}`;
}

/** Co-located sidecar paths for an m4b, e.g. output/Book.m4b →
 *  { vtt: output/Book.m4b.vtt, cover: output/Book.m4b.cover.jpg,
 *    binding: output/Book.m4b.sidecars.json }. The cover extension is a default;
 *  the authoritative cover path is recorded in the binding. Absolute in → out. */
export function sidecarPathsFor(m4bPath: string): { vtt: string; cover: string; binding: string } {
  const base = sidecarBase(m4bPath);
  return {
    vtt: `${base}.vtt`,
    cover: `${base}.cover.jpg`,
    binding: `${base}.sidecars.json`,
  };
}

// ── read / write ─────────────────────────────────────────────────────────────

export async function readBinding(bindingPath: string): Promise<SidecarBinding | null> {
  let raw: string;
  try { raw = await fs.promises.readFile(bindingPath, 'utf8'); }
  catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isSidecarBinding(parsed)) return null;
  return parsed;
}

/** Atomically write JSON: temp file in the same directory, then rename. Same-dir
 *  rename is atomic on one filesystem and Syncthing-safe (no partial file synced). */
export async function writeFileAtomic(targetPath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(targetPath);
  // A SHORT temp name (not derived from the target basename, which can already be
  // ~240 chars) so temp + suffix never overflows the 255-byte filename limit.
  const tmp = path.join(dir, `.bftmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`);
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, targetPath);
}

export async function writeBinding(bindingPath: string, binding: SidecarBinding): Promise<void> {
  await writeFileAtomic(bindingPath, JSON.stringify(binding, null, 2));
}

// ── validation ───────────────────────────────────────────────────────────────

export interface SidecarResolution {
  /** True when the current m4b bytes hash to the binding's m4b.sha256. */
  m4bMatches: boolean;
  /** Absolute path to the valid VTT sidecar, or null (missing/stale/mismatched). */
  vtt: string | null;
  /** Absolute path to the valid cover sidecar, or null. */
  cover: string | null;
}

/**
 * Resolve which of a binding's sidecars are safe to serve for the m4b at
 * `m4bAbsPath`. Fails closed: if the m4b hash does not match the binding, NOTHING
 * is served (both null) — this is the anti-spillover guarantee. Each asset is
 * additionally checked for existence and (unless skipped) its own byte hash.
 *
 * `strict` forces a full re-hash of the m4b (authoritative). Default uses the
 * delivery-tier cache. `verifyAssetBytes` re-hashes each sidecar file too; leave
 * off for the hot delivery path (the m4b hash already proves the pairing).
 */
export async function resolveSidecars(
  binding: SidecarBinding,
  m4bAbsPath: string,
  bindingDir: string,
  opts?: { strict?: boolean; verifyAssetBytes?: boolean },
): Promise<SidecarResolution> {
  const out: SidecarResolution = { m4bMatches: false, vtt: null, cover: null };
  let current: { sha256: string };
  try { current = await m4bIdentity(m4bAbsPath, { strict: opts?.strict }); }
  catch { return out; }                       // m4b unreadable → serve nothing
  if (current.sha256 !== binding.m4b.sha256) return out;   // WRONG FILE → fail closed
  out.m4bMatches = true;

  for (const kind of ['vtt', 'cover'] as const) {
    const asset = binding.assets[kind];
    if (!asset) continue;
    const abs = path.resolve(bindingDir, path.basename(asset.path));
    try {
      if (opts?.verifyAssetBytes) {
        const { sha256 } = await sha256File(abs);
        if (sha256 !== asset.sha256) continue;             // corrupted/edited sidecar
      } else if (!fs.existsSync(abs)) {
        continue;
      }
      out[kind] = abs;
    } catch { /* missing/unreadable → leave null */ }
  }
  return out;
}

// ── guards ───────────────────────────────────────────────────────────────────

function isSidecarBinding(v: unknown): v is SidecarBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b['protocol'] !== SIDECAR_BINDING_VERSION) return false;
  if (typeof b['projectId'] !== 'string' || typeof b['variantId'] !== 'string') return false;
  const m4b = b['m4b'] as Record<string, unknown> | undefined;
  if (!m4b || typeof m4b['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(m4b['sha256'] as string)) return false;
  if (typeof m4b['bytes'] !== 'number') return false;
  if (!b['assets'] || typeof b['assets'] !== 'object') return false;
  return true;
}
