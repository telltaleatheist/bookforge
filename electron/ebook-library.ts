/**
 * Ebook Library - Manages a collection of ebook files with Calibre ebook-meta integration
 *
 * Books are stored in {library}/ebooks/ organized by category folders.
 * Metadata is cached in .cache/metadata.json with mtime-based invalidation.
 * Calibre's ebook-meta CLI is used for reading/writing metadata and covers.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import { getLibraryBasePath } from './manifest-service';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BookMetadata {
  title: string;
  subtitle?: string;
  authorFirst?: string;
  authorLast?: string;
  authorFull?: string;
  year?: number;
  language?: string;
}

export interface LibraryBookEntry {
  relativePath: string;
  filename: string;
  title: string;
  subtitle?: string;
  authorFirst?: string;
  authorLast?: string;
  authorFull?: string;
  year?: number;
  language?: string;
  format: string;
  category: string;
  fileSize: number;
  dateAdded: number;
}

export interface CategoryEntry {
  name: string;
  bookCount: number;
}

export interface DuplicateEntry {
  sourcePath: string;
  existingBook: LibraryBookEntry;
  reason: 'same-title-author' | 'same-file-hash';
}

interface CachedBookData {
  title: string;
  subtitle?: string;
  authorFirst?: string;
  authorLast?: string;
  authorFull?: string;
  year?: number;
  language?: string;
  format: string;
  fileSize: number;
  mtime: number;
  coverFile?: string;
  dateAdded: number;
}

type MetadataCache = Record<string, CachedBookData>;

// Supported ebook extensions
const EBOOK_EXTENSIONS = new Set([
  '.epub', '.pdf', '.azw3', '.azw', '.mobi', '.kfx',
  '.fb2', '.lit', '.pdb', '.cbz', '.cbr', '.djvu',
]);

// ─────────────────────────────────────────────────────────────────────────────
// ebook-meta Path Detection
// ─────────────────────────────────────────────────────────────────────────────

const EBOOK_META_PATHS = [
  '/Applications/calibre.app/Contents/MacOS/ebook-meta',
  '/opt/homebrew/bin/ebook-meta',
  '/usr/local/bin/ebook-meta',
  '/usr/bin/ebook-meta',
  'C:\\Program Files\\Calibre2\\ebook-meta.exe',
  'C:\\Program Files (x86)\\Calibre2\\ebook-meta.exe',
];

let cachedEbookMetaPath: string | null | undefined = undefined;

export async function findEbookMeta(): Promise<string | null> {
  if (cachedEbookMetaPath !== undefined) {
    return cachedEbookMetaPath;
  }

  for (const checkPath of EBOOK_META_PATHS) {
    try {
      await fs.access(checkPath, fsSync.constants.X_OK);
      cachedEbookMetaPath = checkPath;
      console.log('[EbookLibrary] Found ebook-meta at:', checkPath);
      return checkPath;
    } catch { /* not found */ }
  }

  // PATH lookup fallback
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = await runCommand(cmd, ['ebook-meta']);
    if (result.success && result.output) {
      const foundPath = result.output.trim().split('\n')[0];
      cachedEbookMetaPath = foundPath;
      console.log('[EbookLibrary] Found ebook-meta in PATH:', foundPath);
      return foundPath;
    }
  } catch { /* not in PATH */ }

  console.log('[EbookLibrary] ebook-meta not found - metadata editing disabled');
  cachedEbookMetaPath = null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Runner
// ─────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  success: boolean;
  output: string;
  error: string;
  code: number | null;
}

function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({ success: code === 0, output: stdout, error: stderr, code });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: err.message, code: null });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getEbooksRoot(): string {
  return path.join(getLibraryBasePath(), 'ebooks');
}

function getCacheDir(): string {
  return path.join(getEbooksRoot(), '.cache');
}

function getCachePath(): string {
  return path.join(getCacheDir(), 'metadata.json');
}

function getCoversDir(): string {
  return path.join(getCacheDir(), 'covers');
}

function coverHash(relativePath: string): string {
  return crypto.createHash('md5').update(relativePath).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Cache
// ─────────────────────────────────────────────────────────────────────────────

let metadataCache: MetadataCache | null = null;

function loadCache(): MetadataCache {
  if (metadataCache) return metadataCache;

  const cachePath = getCachePath();
  try {
    if (fsSync.existsSync(cachePath)) {
      const raw = fsSync.readFileSync(cachePath, 'utf-8');
      metadataCache = JSON.parse(raw);
      return metadataCache!;
    }
  } catch (err) {
    console.error('[EbookLibrary] Failed to load cache:', err);
  }

  metadataCache = {};
  return metadataCache;
}

async function saveCache(cache: MetadataCache): Promise<void> {
  metadataCache = cache;
  const cachePath = getCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// ebook-meta Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse ebook-meta stdout into structured metadata
 * Output format:
 *   Title               : Book Title
 *   Author(s)           : Last, First
 *   Published           : 2023-01-15T00:00:00+00:00
 *   Languages           : eng
 */
function parseEbookMetaOutput(output: string): BookMetadata {
  const meta: BookMetadata = { title: '' };

  for (const line of output.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'title':
        // Handle "Title - Subtitle" format
        const dashIdx = value.indexOf(' - ');
        if (dashIdx !== -1) {
          meta.title = value.substring(0, dashIdx).trim();
          meta.subtitle = value.substring(dashIdx + 3).trim();
        } else {
          meta.title = value;
        }
        break;

      case 'author(s)':
        meta.authorFull = value;
        // Parse "Last, First" or "First Last" or "Last, First & Last2, First2"
        const primaryAuthor = value.split('&')[0].trim().split(';')[0].trim();
        if (primaryAuthor.includes(',')) {
          const parts = primaryAuthor.split(',').map(s => s.trim());
          meta.authorLast = parts[0];
          meta.authorFirst = parts[1];
        } else {
          const parts = primaryAuthor.split(/\s+/);
          if (parts.length >= 2) {
            meta.authorFirst = parts.slice(0, -1).join(' ');
            meta.authorLast = parts[parts.length - 1];
          } else {
            meta.authorLast = primaryAuthor;
          }
        }
        break;

      case 'published':
        // Extract year from ISO date or "YYYY" format
        const yearMatch = value.match(/(\d{4})/);
        if (yearMatch) {
          meta.year = parseInt(yearMatch[1]);
        }
        break;

      case 'languages':
        meta.language = value.split(',')[0].trim();
        break;
    }
  }

  return meta;
}

/**
 * Read metadata from an ebook file using ebook-meta
 */
export async function readMetadata(filePath: string): Promise<BookMetadata> {
  const ebookMeta = await findEbookMeta();
  if (!ebookMeta) {
    // Fallback: parse from filename
    return parseFilename(path.basename(filePath));
  }

  const result = await runCommand(ebookMeta, [filePath]);
  if (!result.success) {
    console.warn('[EbookLibrary] ebook-meta failed for', filePath, result.error);
    return parseFilename(path.basename(filePath));
  }

  const meta = parseEbookMetaOutput(result.output);

  // If ebook-meta returned no title, fall back to filename
  if (!meta.title) {
    return parseFilename(path.basename(filePath));
  }

  return meta;
}

/**
 * Write metadata to an ebook file using ebook-meta
 */
export async function writeMetadata(filePath: string, meta: Partial<BookMetadata>): Promise<void> {
  const ebookMeta = await findEbookMeta();
  if (!ebookMeta) {
    throw new Error('Calibre ebook-meta is not installed');
  }

  const args: string[] = [filePath];

  if (meta.title) {
    args.push('--title', meta.title);
  }
  if (meta.authorFull) {
    args.push('--authors', meta.authorFull);
  } else if (meta.authorLast) {
    const author = meta.authorFirst
      ? `${meta.authorLast}, ${meta.authorFirst}`
      : meta.authorLast;
    args.push('--authors', author);
  }
  if (meta.year) {
    args.push('--date', String(meta.year));
  }
  if (meta.language) {
    args.push('--language', meta.language);
  }

  const result = await runCommand(ebookMeta, args);
  if (!result.success) {
    throw new Error(`Failed to write metadata: ${result.error}`);
  }
}

/**
 * Extract cover from an ebook file
 */
export async function extractCover(filePath: string, outPath: string): Promise<boolean> {
  const ebookMeta = await findEbookMeta();
  if (!ebookMeta) return false;

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const result = await runCommand(ebookMeta, [filePath, '--get-cover', outPath]);

  if (result.success) {
    // Verify the file was actually created
    try {
      await fs.access(outPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Set cover on an ebook file
 */
export async function setCover(filePath: string, coverPath: string): Promise<void> {
  const ebookMeta = await findEbookMeta();
  if (!ebookMeta) {
    throw new Error('Calibre ebook-meta is not installed');
  }

  const result = await runCommand(ebookMeta, [filePath, '--cover', coverPath]);
  if (!result.success) {
    throw new Error(`Failed to set cover: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filename Conventions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse metadata from a filename following naming convention:
 * "Title - Subtitle. LastName, FirstName. (Year).ext"
 * "Title. LastName, FirstName. (Year).ext"
 * "Title. Author.ext"
 */
function parseFilename(filename: string): BookMetadata {
  const ext = path.extname(filename);
  const base = filename.replace(ext, '');

  const meta: BookMetadata = { title: base };

  // Try: Title - Subtitle. Author. (Year)
  // Or:  Title. Author. (Year)
  // Or:  Title. Author
  const yearMatch = base.match(/\.\s*\((\d{4})\)\s*$/);
  let yearStr = '';
  let stripped = base;
  if (yearMatch) {
    meta.year = parseInt(yearMatch[1]);
    yearStr = yearMatch[0];
    stripped = base.substring(0, base.length - yearStr.length);
  }

  // Split on ". " to separate title from author
  const dotParts = stripped.split(/\.\s+/);
  if (dotParts.length >= 2) {
    const authorPart = dotParts[dotParts.length - 1].trim();
    const titlePart = dotParts.slice(0, -1).join('. ').trim();

    // Check for "Title - Subtitle" in title part
    const dashIdx = titlePart.indexOf(' - ');
    if (dashIdx !== -1) {
      meta.title = titlePart.substring(0, dashIdx).trim();
      meta.subtitle = titlePart.substring(dashIdx + 3).trim();
    } else {
      meta.title = titlePart;
    }

    // Parse author: "Last, First" or "First Last"
    if (authorPart.includes(',')) {
      const parts = authorPart.split(',').map(s => s.trim());
      meta.authorLast = parts[0];
      meta.authorFirst = parts[1];
      meta.authorFull = authorPart;
    } else if (authorPart.includes(' ')) {
      const parts = authorPart.split(/\s+/);
      meta.authorFirst = parts.slice(0, -1).join(' ');
      meta.authorLast = parts[parts.length - 1];
      meta.authorFull = `${meta.authorLast}, ${meta.authorFirst}`;
    } else {
      meta.authorLast = authorPart;
      meta.authorFull = authorPart;
    }
  }

  return meta;
}

/**
 * Generate a filename from metadata following naming convention
 */
export function generateFilename(meta: BookMetadata, ext: string): string {
  let name = meta.title;

  if (meta.subtitle) {
    name += ` - ${meta.subtitle}`;
  }

  if (meta.authorLast) {
    const author = meta.authorFirst
      ? `${meta.authorLast}, ${meta.authorFirst}`
      : meta.authorLast;
    name += `. ${author}`;
  }

  if (meta.year) {
    name += `. (${meta.year})`;
  }

  // Sanitize for filesystem
  name = name.replace(/[<>:"/\\|?*]/g, '_').replace(/_+/g, '_');

  return `${name}${ext.startsWith('.') ? ext : '.' + ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Library Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the ebook library folder structure exists
 */
export async function initLibrary(): Promise<{ ebookMetaAvailable: boolean }> {
  const root = getEbooksRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'Uncategorized'), { recursive: true });
  await fs.mkdir(getCacheDir(), { recursive: true });
  await fs.mkdir(getCoversDir(), { recursive: true });

  const ebookMeta = await findEbookMeta();
  return { ebookMetaAvailable: ebookMeta !== null };
}

/**
 * Scan the library folder and return all books, updating the cache as needed
 */
export async function scanLibrary(): Promise<LibraryBookEntry[]> {
  const root = getEbooksRoot();
  const cache = loadCache();
  const books: LibraryBookEntry[] = [];
  const newCache: MetadataCache = {};

  try {
    const topEntries = await fs.readdir(root, { withFileTypes: true });

    for (const entry of topEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const category = entry.name;
      const categoryDir = path.join(root, category);

      const files = await fs.readdir(categoryDir, { withFileTypes: true });

      for (const file of files) {
        if (!file.isFile()) continue;
        if (file.name.startsWith('.')) continue;

        const ext = path.extname(file.name).toLowerCase();
        if (!EBOOK_EXTENSIONS.has(ext)) continue;

        const relativePath = `${category}/${file.name}`;
        const absolutePath = path.join(categoryDir, file.name);

        try {
          const stat = await fs.stat(absolutePath);
          const cached = cache[relativePath];

          // Use cache if mtime matches
          if (cached && cached.mtime === stat.mtimeMs) {
            newCache[relativePath] = cached;
            books.push({
              relativePath,
              filename: file.name,
              title: cached.title,
              subtitle: cached.subtitle,
              authorFirst: cached.authorFirst,
              authorLast: cached.authorLast,
              authorFull: cached.authorFull,
              year: cached.year,
              language: cached.language,
              format: ext.replace('.', ''),
              category,
              fileSize: cached.fileSize,
              dateAdded: cached.dateAdded,
            });
            continue;
          }

          // Cache miss or stale - read metadata
          const meta = await readMetadata(absolutePath);
          const dateAdded = cached?.dateAdded || stat.birthtimeMs || stat.ctimeMs;

          // Extract cover thumbnail
          let coverFile: string | undefined;
          const coverOut = path.join(getCoversDir(), `${coverHash(relativePath)}.jpg`);
          const hasCover = await extractCover(absolutePath, coverOut);
          if (hasCover) {
            coverFile = `${coverHash(relativePath)}.jpg`;
          }

          const cacheEntry: CachedBookData = {
            title: meta.title,
            subtitle: meta.subtitle,
            authorFirst: meta.authorFirst,
            authorLast: meta.authorLast,
            authorFull: meta.authorFull,
            year: meta.year,
            language: meta.language,
            format: ext.replace('.', ''),
            fileSize: stat.size,
            mtime: stat.mtimeMs,
            coverFile,
            dateAdded,
          };

          newCache[relativePath] = cacheEntry;
          books.push({
            relativePath,
            filename: file.name,
            title: meta.title,
            subtitle: meta.subtitle,
            authorFirst: meta.authorFirst,
            authorLast: meta.authorLast,
            authorFull: meta.authorFull,
            year: meta.year,
            language: meta.language,
            format: ext.replace('.', ''),
            category,
            fileSize: stat.size,
            dateAdded,
          });
        } catch (err) {
          console.warn('[EbookLibrary] Failed to process:', relativePath, err);
        }
      }
    }

    await saveCache(newCache);
  } catch (err) {
    console.error('[EbookLibrary] Scan failed:', err);
  }

  return books;
}

/**
 * Add ebook files to the library (copies them in)
 */
export async function addBooks(
  sourcePaths: string[],
  category: string = 'Uncategorized'
): Promise<{ added: LibraryBookEntry[]; duplicates: DuplicateEntry[] }> {
  const root = getEbooksRoot();
  const categoryDir = path.join(root, category);
  await fs.mkdir(categoryDir, { recursive: true });

  const cache = loadCache();
  const added: LibraryBookEntry[] = [];
  const duplicates: DuplicateEntry[] = [];

  for (const sourcePath of sourcePaths) {
    const ext = path.extname(sourcePath).toLowerCase();
    if (!EBOOK_EXTENSIONS.has(ext)) {
      console.warn('[EbookLibrary] Skipping unsupported format:', sourcePath);
      continue;
    }

    // Read metadata from source file
    const meta = await readMetadata(sourcePath);

    // Check for duplicates (same title+author)
    const existingDuplicate = findDuplicateInCache(cache, meta);
    if (existingDuplicate) {
      duplicates.push({
        sourcePath,
        existingBook: existingDuplicate,
        reason: 'same-title-author',
      });
      continue;
    }

    // Generate target filename
    const targetFilename = generateFilename(meta, ext);
    const targetPath = path.join(categoryDir, targetFilename);

    // If the target file already exists on disk, treat it as a duplicate
    if (fsSync.existsSync(targetPath)) {
      // Also check if the source IS the target (file already in library)
      const sourceResolved = path.resolve(sourcePath);
      const targetResolved = path.resolve(targetPath);
      if (sourceResolved === targetResolved) continue;

      duplicates.push({
        sourcePath,
        existingBook: {
          relativePath: `${category}/${targetFilename}`,
          filename: targetFilename,
          title: meta.title,
          authorLast: meta.authorLast,
          authorFirst: meta.authorFirst,
          authorFull: meta.authorFull,
          year: meta.year,
          format: ext.replace('.', ''),
          category,
          fileSize: 0,
          dateAdded: 0,
        },
        reason: 'same-title-author',
      });
      continue;
    }

    // Copy file
    await fs.copyFile(sourcePath, targetPath);

    const stat = await fs.stat(targetPath);
    const relativePath = `${category}/${path.basename(targetPath)}`;

    // Extract cover
    let coverFile: string | undefined;
    const coverOut = path.join(getCoversDir(), `${coverHash(relativePath)}.jpg`);
    const hasCover = await extractCover(targetPath, coverOut);
    if (hasCover) {
      coverFile = `${coverHash(relativePath)}.jpg`;
    }

    // Update cache
    cache[relativePath] = {
      title: meta.title,
      subtitle: meta.subtitle,
      authorFirst: meta.authorFirst,
      authorLast: meta.authorLast,
      authorFull: meta.authorFull,
      year: meta.year,
      language: meta.language,
      format: ext.replace('.', ''),
      fileSize: stat.size,
      mtime: stat.mtimeMs,
      coverFile,
      dateAdded: Date.now(),
    };

    added.push({
      relativePath,
      filename: path.basename(targetPath),
      title: meta.title,
      subtitle: meta.subtitle,
      authorFirst: meta.authorFirst,
      authorLast: meta.authorLast,
      authorFull: meta.authorFull,
      year: meta.year,
      language: meta.language,
      format: ext.replace('.', ''),
      category,
      fileSize: stat.size,
      dateAdded: Date.now(),
    });
  }

  await saveCache(cache);
  return { added, duplicates };
}

/**
 * Remove a book from the library (deletes the copy)
 */
export async function removeBook(relativePath: string): Promise<void> {
  const absolutePath = path.join(getEbooksRoot(), relativePath);
  await fs.unlink(absolutePath);

  // Remove from cache
  const cache = loadCache();
  const cached = cache[relativePath];
  if (cached?.coverFile) {
    try {
      await fs.unlink(path.join(getCoversDir(), cached.coverFile));
    } catch { /* cover already gone */ }
  }
  delete cache[relativePath];
  await saveCache(cache);
}

/**
 * Move books to a different category
 */
export async function moveBooks(relativePaths: string[], targetCategory: string): Promise<void> {
  const root = getEbooksRoot();
  const targetDir = path.join(root, targetCategory);
  await fs.mkdir(targetDir, { recursive: true });

  const cache = loadCache();

  for (const relativePath of relativePaths) {
    const oldPath = path.join(root, relativePath);
    const filename = path.basename(relativePath);
    const newPath = path.join(targetDir, filename);
    const newRelative = `${targetCategory}/${filename}`;

    await fs.rename(oldPath, newPath);

    // Update cache entry key
    if (cache[relativePath]) {
      cache[newRelative] = cache[relativePath];
      delete cache[relativePath];

      // Update cover cache key
      if (cache[newRelative].coverFile) {
        const oldCoverPath = path.join(getCoversDir(), cache[newRelative].coverFile!);
        const newCoverFile = `${coverHash(newRelative)}.jpg`;
        const newCoverPath = path.join(getCoversDir(), newCoverFile);
        try {
          await fs.rename(oldCoverPath, newCoverPath);
          cache[newRelative].coverFile = newCoverFile;
        } catch { /* cover rename failed, will re-extract on next scan */ }
      }
    }
  }

  await saveCache(cache);
}

/**
 * Update book metadata - writes to file, renames file if needed, updates cache
 */
export async function updateBookMetadata(
  relativePath: string,
  meta: Partial<BookMetadata>
): Promise<{ book: LibraryBookEntry }> {
  const root = getEbooksRoot();
  const absolutePath = path.join(root, relativePath);

  // Write metadata to the ebook file
  await writeMetadata(absolutePath, meta);

  // Build the new full metadata by merging old cache + new values
  const cache = loadCache();
  const cached = cache[relativePath];
  const oldMeta: BookMetadata = {
    title: cached?.title || '',
    subtitle: cached?.subtitle,
    authorFirst: cached?.authorFirst,
    authorLast: cached?.authorLast,
    authorFull: cached?.authorFull,
    year: cached?.year,
    language: cached?.language,
  };
  const merged: BookMetadata = { ...oldMeta, ...meta };

  // Determine if we need to rename the file
  const ext = path.extname(relativePath);
  const newFilename = generateFilename(merged, ext);
  const oldFilename = path.basename(relativePath);
  const category = path.dirname(relativePath);

  let finalRelativePath = relativePath;

  if (newFilename !== oldFilename) {
    const newPath = path.join(root, category, newFilename);
    await fs.rename(absolutePath, newPath);
    finalRelativePath = `${category}/${newFilename}`;

    // Move cache entry
    if (cache[relativePath]) {
      cache[finalRelativePath] = cache[relativePath];
      delete cache[relativePath];
    }

    // Rename cached cover thumbnail to match new path hash
    const oldCoverPath = path.join(getCoversDir(), `${coverHash(relativePath)}.jpg`);
    const newCoverFile = `${coverHash(finalRelativePath)}.jpg`;
    const newCoverPath = path.join(getCoversDir(), newCoverFile);
    try {
      await fs.access(oldCoverPath);
      await fs.rename(oldCoverPath, newCoverPath);
      if (cache[finalRelativePath]) {
        cache[finalRelativePath].coverFile = newCoverFile;
      }
    } catch { /* no cached cover to rename */ }
  }

  // Update cache with new metadata + mtime
  const stat = await fs.stat(path.join(root, finalRelativePath));
  const entry = cache[finalRelativePath] || {} as CachedBookData;
  cache[finalRelativePath] = {
    ...entry,
    title: merged.title,
    subtitle: merged.subtitle,
    authorFirst: merged.authorFirst,
    authorLast: merged.authorLast,
    authorFull: merged.authorFull,
    year: merged.year,
    language: merged.language,
    mtime: stat.mtimeMs,
    fileSize: stat.size,
    dateAdded: entry.dateAdded || Date.now(),
    format: ext.replace('.', ''),
  };

  await saveCache(cache);

  return {
    book: {
      relativePath: finalRelativePath,
      filename: path.basename(finalRelativePath),
      title: merged.title,
      subtitle: merged.subtitle,
      authorFirst: merged.authorFirst,
      authorLast: merged.authorLast,
      authorFull: merged.authorFull,
      year: merged.year,
      language: merged.language,
      format: ext.replace('.', ''),
      category,
      fileSize: stat.size,
      dateAdded: cache[finalRelativePath].dateAdded,
    },
  };
}

/**
 * Get cover data for a book (base64 data URL)
 */
export async function getCoverData(relativePath: string): Promise<string | null> {
  const cache = loadCache();
  const cached = cache[relativePath];

  if (cached?.coverFile) {
    const coverPath = path.join(getCoversDir(), cached.coverFile);
    try {
      const data = await fs.readFile(coverPath);
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    } catch { /* cover file missing */ }
  }

  // Try extracting cover on demand
  const absolutePath = path.join(getEbooksRoot(), relativePath);
  const coverOut = path.join(getCoversDir(), `${coverHash(relativePath)}.jpg`);
  const hasCover = await extractCover(absolutePath, coverOut);
  if (hasCover) {
    if (cached) {
      cached.coverFile = `${coverHash(relativePath)}.jpg`;
      await saveCache(cache);
    }
    const data = await fs.readFile(coverOut);
    return `data:image/jpeg;base64,${data.toString('base64')}`;
  }

  return null;
}

/**
 * Set a cover image on a book from base64 data
 */
export async function setBookCover(relativePath: string, base64Data: string): Promise<void> {
  const root = getEbooksRoot();
  const absolutePath = path.join(root, relativePath);

  // Write the base64 data to a temp file
  const raw = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const tempCover = path.join(getCacheDir(), `temp_cover_${Date.now()}.jpg`);
  await fs.writeFile(tempCover, Buffer.from(raw, 'base64'));

  try {
    // Set the cover in the ebook file
    await setCover(absolutePath, tempCover);

    // Update the cached cover thumbnail
    const coverFile = `${coverHash(relativePath)}.jpg`;
    const coverPath = path.join(getCoversDir(), coverFile);
    await fs.copyFile(tempCover, coverPath);

    // Update cache
    const cache = loadCache();
    if (cache[relativePath]) {
      cache[relativePath].coverFile = coverFile;
      const stat = await fs.stat(absolutePath);
      cache[relativePath].mtime = stat.mtimeMs;
      await saveCache(cache);
    }
  } finally {
    try { await fs.unlink(tempCover); } catch { /* cleanup */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Category Operations
// ─────────────────────────────────────────────────────────────────────────────

export async function listCategories(): Promise<CategoryEntry[]> {
  const root = getEbooksRoot();
  const categories: CategoryEntry[] = [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const catDir = path.join(root, entry.name);
      const files = await fs.readdir(catDir);
      const bookCount = files.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return EBOOK_EXTENSIONS.has(ext);
      }).length;

      categories.push({ name: entry.name, bookCount });
    }
  } catch (err) {
    console.error('[EbookLibrary] Failed to list categories:', err);
  }

  return categories.sort((a, b) => {
    // Uncategorized always first
    if (a.name === 'Uncategorized') return -1;
    if (b.name === 'Uncategorized') return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function createCategory(name: string): Promise<void> {
  const sanitized = name.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!sanitized) throw new Error('Invalid category name');

  const catDir = path.join(getEbooksRoot(), sanitized);
  await fs.mkdir(catDir, { recursive: true });
}

export async function deleteCategory(name: string): Promise<void> {
  if (name === 'Uncategorized') throw new Error('Cannot delete Uncategorized');

  const root = getEbooksRoot();
  const catDir = path.join(root, name);
  const uncatDir = path.join(root, 'Uncategorized');

  // Move all books to Uncategorized
  const files = await fs.readdir(catDir, { withFileTypes: true });
  const cache = loadCache();

  for (const file of files) {
    if (!file.isFile()) continue;
    if (file.name.startsWith('.')) continue;
    const ext = path.extname(file.name).toLowerCase();
    if (!EBOOK_EXTENSIONS.has(ext)) continue;

    const oldRelative = `${name}/${file.name}`;
    const newRelative = `Uncategorized/${file.name}`;

    await fs.rename(path.join(catDir, file.name), path.join(uncatDir, file.name));

    if (cache[oldRelative]) {
      cache[newRelative] = cache[oldRelative];
      delete cache[oldRelative];
    }
  }

  await saveCache(cache);

  // Remove the empty directory
  try {
    await fs.rmdir(catDir);
  } catch {
    // Directory not empty (might have non-ebook files)
    console.warn('[EbookLibrary] Could not remove category dir (not empty?):', catDir);
  }
}

export async function renameCategory(oldName: string, newName: string): Promise<void> {
  if (oldName === 'Uncategorized') throw new Error('Cannot rename Uncategorized');

  const sanitized = newName.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!sanitized) throw new Error('Invalid category name');

  const root = getEbooksRoot();
  const oldDir = path.join(root, oldName);
  const newDir = path.join(root, sanitized);

  await fs.rename(oldDir, newDir);

  // Update all cache keys
  const cache = loadCache();
  const updatedCache: MetadataCache = {};

  for (const [key, value] of Object.entries(cache)) {
    if (key.startsWith(`${oldName}/`)) {
      const newKey = key.replace(`${oldName}/`, `${sanitized}/`);
      updatedCache[newKey] = value;
    } else {
      updatedCache[key] = value;
    }
  }

  await saveCache(updatedCache);
}

// ─────────────────────────────────────────────────────────────────────────────
// Import to Studio
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Import a library ebook into Studio as a new project.
 * Returns the project directory path. The actual import is handled
 * by the caller (main.ts) via the existing audiobook:import-epub flow.
 */
export function getAbsolutePath(relativePath: string): string {
  return path.join(getEbooksRoot(), relativePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate Detection
// ─────────────────────────────────────────────────────────────────────────────

function findDuplicateInCache(cache: MetadataCache, meta: BookMetadata): LibraryBookEntry | null {
  if (!meta.title) return null;

  const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizeAuthor = (a: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '');

  const targetTitle = normalizeTitle(meta.title);
  const targetAuthor = meta.authorLast ? normalizeAuthor(meta.authorLast) : '';

  for (const [relativePath, cached] of Object.entries(cache)) {
    const cachedTitle = normalizeTitle(cached.title);
    if (cachedTitle !== targetTitle) continue;

    if (targetAuthor && cached.authorLast) {
      const cachedAuthor = normalizeAuthor(cached.authorLast);
      if (cachedAuthor === targetAuthor) {
        const category = path.dirname(relativePath);
        return {
          relativePath,
          filename: path.basename(relativePath),
          title: cached.title,
          subtitle: cached.subtitle,
          authorFirst: cached.authorFirst,
          authorLast: cached.authorLast,
          authorFull: cached.authorFull,
          year: cached.year,
          language: cached.language,
          format: cached.format,
          category,
          fileSize: cached.fileSize,
          dateAdded: cached.dateAdded,
        };
      }
    }
  }

  return null;
}

export async function findDuplicates(filePaths: string[]): Promise<DuplicateEntry[]> {
  const cache = loadCache();
  const results: DuplicateEntry[] = [];

  for (const filePath of filePaths) {
    const meta = await readMetadata(filePath);
    const existing = findDuplicateInCache(cache, meta);
    if (existing) {
      results.push({
        sourcePath: filePath,
        existingBook: existing,
        reason: 'same-title-author',
      });
    }
  }

  return results;
}
