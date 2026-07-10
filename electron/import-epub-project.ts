/**
 * import-epub-project.ts — create a BookForge project from a source file
 * (epub/pdf/…), extracted from the `audiobook:import-epub` IPC handler so it can
 * be shared: the IPC handler wraps it (book imports from Studio) and the bookshelf
 * server's mobile import→edit finalize calls it directly (article imports).
 *
 * The pristine file is copied into `archive/` and registered in `manifest.archive`
 * — that archived copy IS the read-only source (the editor writes
 * `source/exported.epub`; the archive file is never modified). The bookshelf
 * ebook/article list is built from `manifest.archive`, so this is what makes an
 * imported item show up.
 *
 * The ONE knob the two callers differ on is `projectType` ('book' | 'article');
 * cover art is passed in already-saved (as a media-relative path) so this module
 * stays free of renderer/main-only helpers.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as manifestService from './manifest-service';
import { getProjectsPath } from './manifest-service';
import * as ebookLibrary from './ebook-library';
import { toAsciiSlug } from './path-utils';
import type { ProjectType } from './manifest-types';

export interface ImportEpubOptions {
  /** Metadata confirmed by the user; when omitted, parsed from the filename. */
  confirmedMetadata?: { title: string; author: string; year?: string; language?: string; subtitle?: string };
  /** 'book' (Ebooks tab) or 'article' (Articles tab). Defaults to 'book'. */
  projectType?: ProjectType;
  /** Cover already saved to media/ by the caller (media-relative path). */
  coverRelPath?: string;
  /** Provenance for URL-sourced articles (recorded on manifest.source). */
  provenance?: { url?: string; fetchedAt?: string };
}

export interface ImportEpubResult {
  success: boolean;
  duplicate?: boolean;
  existingProjectId?: string;
  existingProjectPath?: string;
  existingTitle?: string;
  projectId?: string;
  projectPath?: string;
  bfpPath?: string;
  audiobookFolder?: string;
  epubPath?: string;
  projectName?: string;
  sourceType?: string;
  error?: string;
}

const sha256File = (p: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(p);
    stream.on('error', reject);
    stream.on('data', (d) => h.update(d));
    stream.on('end', () => resolve(h.digest('hex')));
  });

export async function importEpubProject(
  epubSourcePath: string,
  opts: ImportEpubOptions = {},
): Promise<ImportEpubResult> {
  try {
    const filename = path.basename(epubSourcePath);
    const ext = path.extname(filename).toLowerCase();
    const projectType: ProjectType = opts.projectType || 'book';

    // ── Duplicate guard ──────────────────────────────────────────────────
    // Never import the same source file twice. Compare a content hash against
    // every existing project's stored source.fileHash; for older projects that
    // predate hashing, fall back to hashing their source file only when its size
    // matches (cheap — avoids re-hashing the whole library each import).
    const importHash = await sha256File(epubSourcePath);
    const importSize = (await fs.stat(epubSourcePath)).size;
    {
      const existingFolder = getProjectsPath();
      let names: string[] = [];
      try { names = await fs.readdir(existingFolder); } catch { /* no projects yet */ }
      for (const name of names) {
        const dir = path.join(existingFolder, name);
        let mf: any;
        try { mf = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8')); }
        catch { continue; }
        let match = false;
        if (mf.source?.fileHash) {
          match = mf.source.fileHash === importHash;
        } else {
          try {
            const srcDir = path.join(dir, 'source');
            const orig = (await fs.readdir(srcDir)).find((f) => f.startsWith('original.'));
            if (orig) {
              const st = await fs.stat(path.join(srcDir, orig));
              if (st.size === importSize) {
                match = (await sha256File(path.join(srcDir, orig))) === importHash;
              }
            }
          } catch { /* unreadable project — skip */ }
        }
        if (match) {
          const dupTitle = mf.metadata?.title || name;
          console.log(`[import-epub-project] Duplicate of existing project "${name}" — skipping import`);
          return {
            success: false,
            duplicate: true,
            existingProjectId: name,
            existingProjectPath: dir,
            existingTitle: dupTitle,
            error: `“${dupTitle}” is already in your library — skipped to avoid a duplicate.`,
          };
        }
      }
    }

    let title: string;
    let author: string;
    let authorFileAs: string | undefined;
    let year: number | undefined;
    let language = 'en';
    let subtitle: string | undefined;

    if (opts.confirmedMetadata) {
      title = opts.confirmedMetadata.title;
      author = opts.confirmedMetadata.author;
      year = opts.confirmedMetadata.year ? parseInt(opts.confirmedMetadata.year) : undefined;
      language = opts.confirmedMetadata.language || 'en';
      subtitle = opts.confirmedMetadata.subtitle;
    } else {
      // Fall back to filename parsing using the shared library convention parser
      const parsed = ebookLibrary.parseFilename(filename);
      title = parsed.title || filename.replace(/\.[^.]+$/i, '');
      year = parsed.year;
      language = parsed.language || 'en';
      subtitle = parsed.subtitle;
      if (parsed.authorFirst && parsed.authorLast) {
        author = `${parsed.authorFirst} ${parsed.authorLast}`;
        authorFileAs = `${parsed.authorLast}, ${parsed.authorFirst}`;
      } else {
        author = parsed.authorLast || parsed.authorFull || 'Unknown';
      }
    }

    // Human-readable, ASCII-only slug for the folder name (see path-utils).
    const cleanTitle = toAsciiSlug(title.replace(/\s+/g, '_'));
    const cleanAuthor = toAsciiSlug(author.replace(/\s+/g, '_'));
    const yearStr = year ? `_(${year})` : '';
    let slug = toAsciiSlug(`${cleanTitle}_-_${cleanAuthor}${yearStr}`).substring(0, 150);

    const projectsFolder = getProjectsPath();
    let projectDir = path.join(projectsFolder, slug);
    if (fsSync.existsSync(projectDir)) {
      slug = `${slug}_${importHash.substring(0, 8)}`; // stable, content-derived uniqueness
      projectDir = path.join(projectsFolder, slug);
    }

    // Create the project structure — only source, archive, output dirs. Stage
    // dirs (01-cleanup, 02-translate, 03-tts) are created when those stages run.
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, 'source'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'archive'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'output'), { recursive: true });

    const isEpub = ext === '.epub';
    const isPdf = ext === '.pdf';
    const sourceType = isEpub ? 'epub' : isPdf ? 'pdf' : ext.replace('.', '');

    // No redundant source/original copy — the pristine ARCHIVE file is the source.
    const archiveMetadata = {
      title,
      author,
      authorFileAs,
      year: year ? String(year) : undefined,
    };
    const descriptiveFilename = manifestService.computeDescriptiveFilename(archiveMetadata, ext);
    const archivePath = path.join(projectDir, 'archive', descriptiveFilename);
    await manifestService.atomicCopyFile(epubSourcePath, archivePath); // only copy — fatal on failure
    console.log(`[import-epub-project] Archived pristine copy: ${descriptiveFilename}`);

    const outputFilename = manifestService.computeDescriptiveFilename(archiveMetadata, '.m4b');

    let archiveSize: number | undefined;
    try { archiveSize = (await fs.stat(archivePath)).size; } catch { /* ignore */ }

    const manifest = {
      version: 1,
      projectId: slug,
      projectType,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      source: {
        type: sourceType,
        originalFilename: filename,
        fileHash: importHash,
        url: opts.provenance?.url,
        fetchedAt: opts.provenance?.fetchedAt,
        deletedBlockIds: [],
      },
      metadata: {
        title,
        subtitle,
        author,
        authorFileAs,
        year,
        language,
        outputFilename,
        coverPath: opts.coverRelPath,
      },
      sortOrder: -1,
      chapters: [],
      pipeline: {},
      outputs: {},
      archive: [{
        path: `archive/${descriptiveFilename}`,
        role: 'original' as const,
        format: ext.replace('.', ''),
        label: `Original ${ext.replace('.', '').toUpperCase()}`,
        archivedAt: new Date().toISOString(),
        size: archiveSize,
      }],
    };

    await fs.writeFile(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[import-epub-project] Created ${projectType} project: ${projectDir}`);

    return {
      success: true,
      projectId: slug,
      projectPath: projectDir,
      bfpPath: projectDir,
      audiobookFolder: path.join(projectDir, 'output'),
      epubPath: archivePath,
      projectName: title,
      sourceType,
    };
  } catch (err) {
    console.error('[import-epub-project] Error:', err);
    return { success: false, error: (err as Error).message };
  }
}
