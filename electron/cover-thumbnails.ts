/**
 * Cover thumbnails + HTTP validators for the Bookshelf server.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * A shelf load asks for one cover per book. Every one of those covers was the
 * FULL-SIZE art out of `{library}/media/` — measured on Owen's live library
 * (543 covers): mean 536 KB, median 236 KB, largest 14.3 MB. Fifty tiles is
 * ~26 MB down a phone's wifi to draw fifty 180 px squares, and the old ETag was
 * a sha1 of the decoded bytes, so even a 304 cost a full read + hash of the
 * original file. That is the "it's often slow to load images".
 *
 * Two independent fixes, both here:
 *
 *   1. A THUMBNAIL keyed by the cover's identity — `(absolute path, size,
 *      mtimeMs)` for a cover that is a file, `sha1(bytes)` for one that only
 *      exists in memory (freshly cracked out of an m4b). Generated once with
 *      sharp (already a dependency; no new ones), written atomically into a
 *      cache dir under userData, and re-read as a plain file forever after.
 *      Because the identity carries size+mtime, a re-saved cover simply lands
 *      on a DIFFERENT cache filename — there is no invalidation step to get
 *      wrong, and no stale-thumbnail failure mode.
 *
 *   2. A STRONG ETAG derived from that same identity plus the requested width.
 *      It is known before a single image byte is read, so a conditional request
 *      answers 304 off one `stat()`. `Cache-Control` lets the phone skip even
 *      that for an hour.
 *
 * Everything here is pure or filesystem-only — no express, no sockets — which
 * is what makes tools/test-cover-thumbnails.js able to check the 304 logic.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

/** sharp is a native module. Loaded on first use so importing this file (from a
 *  CLI tool or a keeper) costs nothing until a thumbnail is actually made. */
let sharpModule: typeof import('sharp') | null = null;
function getSharp(): typeof import('sharp') {
  if (!sharpModule) sharpModule = require('sharp') as typeof import('sharp');
  return sharpModule;
}

/**
 * A cover, resolved to bytes-or-a-path plus the identity that versions it.
 *
 * `identity` is the ONE input to both the ETag and the cache filename. It must
 * change whenever the image changes and never otherwise — that is the whole
 * contract, and it is why size+mtime are in it.
 */
export interface ResolvedCover {
  identity: string;
  contentType: string;
  /** Set when the cover is a plain file on disk (the overwhelmingly common case). */
  filePath?: string;
  /** Set when the cover was extracted into memory and is not (yet) a file. */
  buffer?: Buffer;
}

export interface CoverBytes {
  buffer: Buffer;
  contentType: string;
}

/**
 * The width the shelf asks for. 480 px covers a 180 px tile at DPR 2.5 — the
 * densest phone the shelf runs on — with no visible softening, and lands in the
 * 25–60 KB range instead of the 236 KB median of the originals.
 */
export const SHELF_THUMBNAIL_WIDTH = 480;

/** Widths we will generate. A free-form `?w=` would let a caller fill the cache
 *  dir with one file per pixel, so the set is closed and anything else is a 400. */
export const ALLOWED_THUMBNAIL_WIDTHS = [240, 480, 960] as const;

/**
 * Parse `?w=`. `null` means "no width given — serve the original", which is what
 * the player's detail view and the offline downloader both want. An unsupported
 * width is `undefined`: the caller answers 400 rather than quietly serving
 * something else (a silently-substituted size is exactly the kind of fallback
 * that hides a client bug).
 */
export function parseThumbnailWidth(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return undefined;
  return (ALLOWED_THUMBNAIL_WIDTHS as readonly number[]).includes(n) ? n : undefined;
}

/** Identity of a cover that is a file: path + size + mtime. */
export function fileCoverIdentity(absPath: string, stat: { size: number; mtimeMs: number }): string {
  // mtimeMs is rounded: NTFS and ext4 disagree in the sub-millisecond digits and
  // a Syncthing copy can round-trip them, which would churn the cache for free.
  return `file:${absPath}|${stat.size}|${Math.round(stat.mtimeMs)}`;
}

/** Identity of a cover that only exists in memory (cracked out of an m4b). */
export function bytesCoverIdentity(buffer: Buffer): string {
  return `bytes:${crypto.createHash('sha1').update(buffer).digest('hex')}`;
}

/**
 * The strong ETag for (identity, width). Strong — not `W/` — because the bytes
 * really are byte-identical for a given identity: the same source through the
 * same encoder at the same width. A weak validator would forbid the Range
 * requests we may want later for nothing gained.
 */
export function coverEtag(identity: string, width: number | null): string {
  const h = crypto.createHash('sha1').update(`${identity}|w=${width ?? 'full'}`).digest('hex');
  return `"${h}"`;
}

/**
 * Does this `If-None-Match` header excuse us from sending the body?
 *
 * Handles the three shapes a real client sends: a single tag, a comma list (a
 * browser that has seen the full-size AND the thumbnail), and `*`. A `W/` prefix
 * on the incoming tag is accepted — RFC 9110 says conditional GET compares with
 * the WEAK comparison function, so `W/"x"` matches `"x"`.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  const want = strip(etag);
  return trimmed.split(',').some((t) => strip(t) === want);
}

/** Where a thumbnail for (identity, width) lives. Flat dir, hashed name. */
export function thumbnailCachePath(cacheDir: string, identity: string, width: number): string {
  const h = crypto.createHash('sha1').update(identity).digest('hex');
  return path.join(cacheDir, `${h}-${width}.jpg`);
}

/**
 * The bytes to send for (cover, width).
 *
 * `width === null` returns the original untouched. Otherwise: the cached
 * thumbnail if it exists, else generate → write atomically → return. A null
 * `cacheDir` (a server started with no userData path) still generates, it just
 * has nowhere to keep the result; that is stated at the call site rather than
 * silently degrading.
 */
export async function coverBytes(
  cacheDir: string | null,
  cover: ResolvedCover,
  width: number | null,
): Promise<CoverBytes> {
  if (width === null) return readOriginal(cover);

  if (cacheDir) {
    const cached = thumbnailCachePath(cacheDir, cover.identity, width);
    try {
      return { buffer: await fs.readFile(cached), contentType: 'image/jpeg' };
    } catch (err) {
      // ENOENT is the ordinary "not generated yet". Anything else is a cache dir
      // we cannot read, and generating is still the right answer — but say so.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[CoverThumbnails] thumbnail cache unreadable:', (err as Error).message);
      }
    }
  }

  const source = await readOriginal(cover);
  const buffer = await getSharp()(source.buffer)
    .rotate() // honour EXIF orientation; resize() drops the tag
    .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: true })
    .toBuffer();

  if (cacheDir) await writeThumbnailAtomically(cacheDir, cover.identity, width, buffer);
  return { buffer, contentType: 'image/jpeg' };
}

async function readOriginal(cover: ResolvedCover): Promise<CoverBytes> {
  if (cover.buffer) return { buffer: cover.buffer, contentType: cover.contentType };
  if (!cover.filePath) {
    throw new Error('A resolved cover carried neither a file path nor bytes — nothing to serve.');
  }
  return { buffer: await fs.readFile(cover.filePath), contentType: cover.contentType };
}

async function writeThumbnailAtomically(
  cacheDir: string,
  identity: string,
  width: number,
  buffer: Buffer,
): Promise<void> {
  const target = thumbnailCachePath(cacheDir, identity, width);
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    // A cache we could not write is a slow shelf, not a broken one — the bytes
    // are already in hand and get served. Loud enough to notice in the log.
    console.warn('[CoverThumbnails] could not cache thumbnail:', (err as Error).message);
  }
}

/**
 * Keep the cache bounded. A cover that is re-saved leaves its old thumbnail
 * behind (by design — the identity changed), so without a sweep the dir grows
 * forever. Oldest-mtime-first, run once at server start. Cheap: one readdir +
 * one stat per file, and only when we are actually over the cap.
 */
export function sweepThumbnailCache(cacheDir: string, maxFiles: number): void {
  let names: string[];
  try {
    names = fsSync.readdirSync(cacheDir).filter((n) => n.endsWith('.jpg'));
  } catch {
    return; // no cache dir yet
  }
  if (names.length <= maxFiles) return;
  const withAge = names.map((n) => {
    const p = path.join(cacheDir, n);
    try { return { p, mtimeMs: fsSync.statSync(p).mtimeMs }; } catch { return { p, mtimeMs: 0 }; }
  });
  withAge.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { p } of withAge.slice(0, withAge.length - maxFiles)) {
    try { fsSync.unlinkSync(p); } catch { /* raced with another sweep */ }
  }
}
