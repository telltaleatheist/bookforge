/**
 * Page render cache — shared location + age-based eviction.
 *
 * The cache lives at ~/Documents/BookForge/cache (NOT inside the library
 * folder — the library is Syncthing-synced and render caches must stay
 * machine-local). Layout: {cacheDir}/{fileHash}/{preview|full}/page-N.jpg
 * plus analysis-vN.json files, all keyed by truncated SHA256 of the source.
 *
 * Eviction is age-based: a document's hash dir mtime is touched every time
 * the document is opened (see PDFAnalyzer.getOrOpenRenderDoc), so dirs whose
 * mtime is older than MAX_AGE_DAYS belong to documents not opened in that
 * window and are deleted on app startup.
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
