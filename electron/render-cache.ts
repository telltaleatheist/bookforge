/**
 * Page render cache — shared location + age-based eviction.
 *
 * The cache lives at ~/Documents/BookForge/cache (NOT inside the library
 * folder — the library is Syncthing-synced and render caches must stay
 * machine-local). Layout: {cacheDir}/{key}/{preview|full}/page-N.jpg plus
 * analysis-vN.json, and — under a different key — quire's page maps.
 *
 * Two kinds of key live side by side here, deliberately. The ANALYZER's is the
 * first 16 hex of the source file's SHA256, because an analysis payload
 * describes bytes and must never be read back for different ones. quire's is
 * `bookCacheKey`, the book's location, because a page map is a record about a
 * book being edited and carries its own per-document freshness inside it.
 *
 * Eviction is age-based: a directory's mtime is touched every time the document
 * is opened (PDFAnalyzer.getOrOpenRenderDoc) or its page map is read
 * (loadCachedPageMap), so dirs whose mtime is older than MAX_AGE_DAYS belong to
 * documents not opened in that window and are deleted on app startup.
 */
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export const RENDER_CACHE_MAX_AGE_DAYS = 30;

export function getRenderCacheBaseDir(): string {
  return path.join(os.homedir(), 'Documents', 'BookForge', 'cache');
}

async function dirSize(dirPath: string): Promise<number> {
  let size = 0;
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await dirSize(entryPath);
      } else {
        try {
          size += (await fsPromises.stat(entryPath)).size;
        } catch { /* file vanished mid-scan */ }
      }
    }
  } catch { /* dir vanished mid-scan */ }
  return size;
}

/**
 * Delete cache dirs for documents not opened in maxAgeDays.
 * Returns what was evicted so the caller can log it.
 */
export async function evictStaleRenderCache(
  maxAgeDays: number = RENDER_CACHE_MAX_AGE_DAYS
): Promise<{ evicted: number; freedBytes: number }> {
  const baseDir = getRenderCacheBaseDir();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let evicted = 0;
  let freedBytes = 0;

  let entries;
  try {
    entries = await fsPromises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return { evicted, freedBytes }; // no cache dir yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(baseDir, entry.name);
    try {
      const stat = await fsPromises.stat(dirPath);
      if (stat.mtimeMs >= cutoff) continue;
      freedBytes += await dirSize(dirPath);
      await fsPromises.rm(dirPath, { recursive: true, force: true });
      evicted++;
    } catch (err) {
      console.warn(`[render-cache] Failed to evict ${entry.name}:`, err);
    }
  }

  return { evicted, freedBytes };
}

/**
 * Delete the stamped copies of books that the cache no longer has any use for.
 *
 * quire used to be given a whole stamped COPY of every book it laid out —
 * `quire-vN-stamped.epub`, the book again with `data-quire-id` on its elements,
 * 25.7 MB for a book with pictures in it — because that was the only way to get
 * the stamps in front of a paginator that reads from a file. It is not any more:
 * the stamps are handed over in memory and the book is opened where it lives.
 *
 * So every one of these is dead weight, and there is one per book AND one per
 * EDIT of a book, because the cache directory used to be named after the book's
 * bytes. Age eviction would get to them in thirty days; a user who is short of
 * disk today should not have to wait, and a file nothing will ever open again
 * has no claim on a grace period.
 *
 * Reported rather than silent, and non-fatal: a stamped copy that cannot be
 * deleted (a session still holding it, an antivirus scan) is left where it is
 * and the next startup asks again.
 */
export async function removeRetiredStampedCopies(): Promise<{
  removed: number; freedBytes: number;
}> {
  const baseDir = getRenderCacheBaseDir();
  let removed = 0;
  let freedBytes = 0;

  let entries;
  try {
    entries = await fsPromises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return { removed, freedBytes }; // no cache dir yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(baseDir, entry.name);
    let files: string[];
    try {
      files = await fsPromises.readdir(dirPath);
    } catch {
      continue; // vanished mid-scan
    }
    for (const file of files) {
      if (!/^quire-v\d+-stamped\.epub$/.test(file)) continue;
      const at = path.join(dirPath, file);
      try {
        freedBytes += (await fsPromises.stat(at)).size;
        await fsPromises.rm(at, { force: true });
        removed++;
      } catch (err) {
        console.warn(`[render-cache] could not remove the retired stamped copy ${at}:`, err);
      }
    }
  }

  return { removed, freedBytes };
}
