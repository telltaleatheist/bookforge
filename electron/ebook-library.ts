/**
 * Ebook catalog — the reading editions (EPUB/PDF/…) the Bookshelf's Ebooks and
 * Articles tabs list, plus the Calibre-backed metadata/cover helpers shared by
 * the import and variant paths.
 *
 * ONE SOURCE: `{library}/projects/{slug}/archive/`. Every book is a manifest
 * project, and its pristine imported file is the project's `archive` entry with
 * `role: 'original'`. The legacy `{library}/ebooks/{Category}/` folder — a second
 * copy of the same books, with its own `.cache/metadata.json` sidecar — was
 * retired in Jul 2026 and is no longer read or written by any code path.
 *
 * Entries are addressed as `__archive__/<projectId>/<filename>`; that string is
 * the Bookshelf's stable per-book key (reader position, bookmarks, covers), so
 * it stays even though the prefix no longer distinguishes it from anything.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { listProjects, getProjectPath, getVariants } from './manifest-service';
import { collapseFilenameDots } from './path-utils';
import type { ProjectManifest } from './manifest-types';

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
  /** `__archive__/<projectId>/<filename>` — the Bookshelf's stable per-book key. */
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
  fileSize: number;
  dateAdded: number;
  /** The owning project's tags — the Bookshelf's tag filter reads these. */
  tags?: string[];
  /** The owning project and its type tag; the Bookshelf splits Ebooks vs Articles by projectType. */
  projectId: string;
  projectType?: 'book' | 'article';
}

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
        // Strip Calibre's [file-as] bracket notation (e.g. "John Smith [Smith, John]")
        let primaryAuthor = value.split('&')[0].trim().split(';')[0].trim();
        primaryAuthor = primaryAuthor.replace(/\s*\[.*?\]\s*$/, '').trim();
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
export function parseFilename(filename: string): BookMetadata {
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

    // Parse author under the ONE rule (Owen, 2026-08-16): a comma means the
    // segment is written "[Last], [First]" — strip the comma and read it that
    // way; no comma means "[First] [Last]".
    //
    // `authorFull` is ALWAYS the natural "[First] [Last]" form. Every consumer
    // treats it as display order and derives "Last, First" itself when it
    // needs the file-as form (computeDescriptiveFilename, the shelf's
    // fallback) — handing the comma'd form through is how a file named
    // "… Bailey, Gene.epub" was inverted a second time into "Gene, Bailey,"
    // on the first imported version.
    if (authorPart.includes(',')) {
      const parts = authorPart.split(',').map(s => s.trim()).filter(Boolean);
      meta.authorLast = parts[0];
      const first = parts.slice(1).join(' ');
      if (first) meta.authorFirst = first;
      meta.authorFull = first ? `${first} ${parts[0]}` : parts[0];
    } else if (authorPart.includes(' ')) {
      const parts = authorPart.split(/\s+/);
      meta.authorFirst = parts.slice(0, -1).join(' ');
      meta.authorLast = parts[parts.length - 1];
      meta.authorFull = authorPart;
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

  // Collapse accidental double dots in the BASE before the extension is appended
  // (e.g. "Last, First M." author "Green, Simon R." + ". (Year)" → "…R.. (Year)").
  name = collapseFilenameDots(name);

  // Sanitize for filesystem
  name = name.replace(/[<>:"/\\|?*]/g, '_').replace(/_+/g, '_');

  return `${name}${ext.startsWith('.') ? ext : '.' + ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every reading edition in the library.
 *
 * A project can register an edition in two places and both are real:
 *   - `archive[]` with `role: 'original'` — the file the project was imported from
 *   - `variants[]` with `kind: 'ebook'`   — an edition added later (Studio → Versions)
 * `getVariants()` only synthesizes the archive ones into variants for projects
 * that have no real variants yet, so reading either list alone drops books: 19
 * projects here hold their only EPUB as a variant with an empty archive[], and one
 * (Black Sun) has an archive entry naming a file that no longer exists next to a
 * variant naming the file that does. So take the UNION, keyed by file path, and
 * list only editions that are actually on disk.
 *
 * There is no second source beyond the project. A project with no ebook file
 * simply has no reading edition to list (an audiobook-only import, for instance) —
 * that is an answer, not a lookup miss to be papered over elsewhere.
 */
export async function scanLibrary(): Promise<LibraryBookEntry[]> {
  // ALL project types — the Bookshelf splits Ebooks vs Articles by the project's
  // `projectType` tag, so articles must be listed here too.
  const result = await listProjects();
  if (!result.success || !result.projects) {
    throw new Error(`Could not list projects: ${result.error || 'unknown error'}`);
  }

  const entries: LibraryBookEntry[] = [];
  const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

  for (const manifest of result.projects as ProjectManifest[]) {
    const projectDir = getProjectPath(manifest.projectId);

    // path → the best description of that edition we have. Variant metadata wins
    // over the archive record (it is the per-edition title/author the user edits);
    // the archive record contributes the archivedAt date and recorded size.
    const editions = new Map<string, {
      path: string;
      size?: number;
      addedAt?: string;
      metadata?: { title?: string; author?: string; year?: string; language?: string };
    }>();

    for (const a of manifest.archive || []) {
      if (a.role !== 'original') continue;
      editions.set(normPath(a.path), { path: a.path, size: a.size, addedAt: a.archivedAt });
    }
    for (const v of getVariants(manifest).variants) {
      if (v.kind !== 'ebook') continue;
      const key = normPath(v.path);
      const prior = editions.get(key);
      editions.set(key, {
        path: v.path,
        size: prior?.size,
        addedAt: prior?.addedAt || v.addedAt,
        metadata: v.metadata,
      });
    }

    for (const edition of editions.values()) {
      const absPath = path.join(projectDir, edition.path);
      if (!fsSync.existsSync(absPath)) continue;

      const filename = path.basename(edition.path);
      const ext = path.extname(filename).toLowerCase();
      if (!EBOOK_EXTENSIONS.has(ext)) continue;

      const title = edition.metadata?.title || manifest.metadata.title;
      // authorFileAs is a "Last, First" sort key the project keeps alongside the
      // display author; prefer it when this edition has no author of its own.
      const author = edition.metadata?.author
        || manifest.metadata.authorFileAs
        || manifest.metadata.author;

      let authorFirst: string | undefined;
      let authorLast: string | undefined;
      let authorFull: string | undefined;
      if (author && author !== 'Unknown') {
        authorFull = author;
        if (author.includes(',')) {
          const parts = author.split(',').map(s => s.trim());
          authorLast = parts[0];
          authorFirst = parts[1];
        } else {
          const parts = author.split(/\s+/);
          if (parts.length >= 2) {
            authorFirst = parts.slice(0, -1).join(' ');
            authorLast = parts[parts.length - 1];
          } else {
            authorLast = author;
          }
        }
      }

      // The recorded size can be stale (or absent for a variant); the file is the
      // authority for what the shelf reports and the download will deliver.
      let fileSize = edition.size || 0;
      try { fileSize = fsSync.statSync(absPath).size; } catch { /* keep the recorded size */ }

      const yearStr = edition.metadata?.year || manifest.metadata.year;

      entries.push({
        relativePath: `__archive__/${manifest.projectId}/${filename}`,
        filename,
        title,
        subtitle: undefined,
        authorFirst,
        authorLast,
        authorFull,
        year: yearStr ? parseInt(yearStr) : undefined,
        language: edition.metadata?.language || manifest.metadata.language,
        format: ext.replace('.', ''),
        fileSize,
        dateAdded: new Date(edition.addedAt || manifest.createdAt).getTime(),
        // Tags live on the project (the same field the audiobook shelf reads), not
        // in a sidecar cache — one book, one set of tags, whichever tab shows it.
        tags: manifest.metadata.tags,
        projectId: manifest.projectId,
        projectType: manifest.projectType,
      });
    }
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Address Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** True for the only address shape the catalog issues: `__archive__/<projectId>/<file>`. */
export function isArchiveEntry(relativePath: string): boolean {
  return relativePath.startsWith('__archive__/');
}

/**
 * Absolute path for a catalog entry. Throws on anything that is not an
 * `__archive__/…` address — most likely a stale reference to the retired
 * `{library}/ebooks/{Category}/` layout, which callers must surface rather than
 * resolve to some plausible-looking file.
 */
export function getAbsolutePath(relativePath: string): string {
  if (!isArchiveEntry(relativePath)) {
    throw new Error(
      `Not a library ebook address: "${relativePath}". ` +
      'Expected __archive__/<projectId>/<filename> (the ebooks/ category layout was retired).'
    );
  }
  const parts = relativePath.split('/');
  // parts: ["__archive__", projectId, filename]
  const projectId = parts[1];
  const filename = parts.slice(2).join('/');
  return path.join(getProjectPath(projectId), 'archive', filename);
}

/** The owning project of a catalog entry, or null when the address isn't one. */
export function projectIdOfEntry(relativePath: string): string | null {
  if (!isArchiveEntry(relativePath)) return null;
  return relativePath.split('/')[1] || null;
}
