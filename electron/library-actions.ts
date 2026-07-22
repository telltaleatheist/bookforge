/**
 * Library mutations shared by the Electron IPC layer and the headless CLI.
 *
 * These functions were lifted VERBATIM out of main.ts's ipcMain handlers so that
 * there is exactly ONE implementation of each library mutation. The IPC handlers
 * in main.ts are now thin wrappers that supply a progress callback; cli/library.js
 * calls the same functions under cli/electron-stub.js. A bug in this file surfaces
 * identically in the app and on the command line — which is the point: the CLI is
 * a test harness for the shipped path, not a parallel reimplementation of it.
 *
 * Nothing here touches Electron. The only main-process capability the original
 * code used was `mainWindow.webContents.send('import:progress', …)`, which is
 * injected as `opts.onProgress` instead.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as ebookLibrary from './ebook-library';
import * as manifestService from './manifest-service';
import { applyMetadata, normalizeAudioToM4b } from './metadata-tools';
import { normalizeFsPath, toAsciiSlug } from './path-utils';
import type { ProjectVariant } from './manifest-types';

/** Progress sink for long transcodes. In the app this forwards to the renderer's
 *  `import:progress` channel; in the CLI it prints. Never affects the outcome. */
export type ImportProgress = (name: string, fraction: number, projectId?: string) => void;

/** Extensions variant:add treats as audio (everything else is handled as an ebook). */
export const VARIANT_AUDIO_EXT = ['.m4b', '.m4a', '.mp3', '.wav', '.flac', '.ogg', '.oga', '.aac', '.opus', '.wma', '.aiff', '.aif'];

/** Content hash used for the library-wide duplicate guard and variant dedupe. */
export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const st = fsSync.createReadStream(p);
    st.on('error', reject);
    st.on('data', (d) => h.update(d));
    st.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Save a base64 image into <library>/media, returning the library-relative path.
 * Content-hashed for deduplication: two projects with byte-identical art share
 * one file.
 */
export async function saveImageToMedia(base64Data: string, prefix: string = 'cover'): Promise<string> {
  const mediaFolder = path.join(manifestService.getLibraryBasePath(), 'media');
  await fs.mkdir(mediaFolder, { recursive: true });

  // Extract actual base64 content and determine extension
  let data: Buffer;
  let ext = '.jpg';
  if (base64Data.startsWith('data:')) {
    const match = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      ext = '.' + (match[1] === 'jpeg' ? 'jpg' : match[1]);
      data = Buffer.from(match[2], 'base64');
    } else {
      // Fallback: strip data URL prefix
      const base64Content = base64Data.split(',')[1] || base64Data;
      data = Buffer.from(base64Content, 'base64');
    }
  } else {
    data = Buffer.from(base64Data, 'base64');
  }

  // Hash the content for deduplication
  const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  const filename = `${prefix}_${hash}${ext}`;
  const filePath = path.join(mediaFolder, filename);

  // Only write if file doesn't exist (deduplication)
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, data);
  }

  // Return relative path from library root
  return `media/${filename}`;
}

/** Seed title/author/narrator/year/cover from an audio file's embedded tags,
 *  falling back to the filename parser for anything the tags don't carry. */
async function readAudioTags(filePath: string): Promise<{
  title: string; author: string; year?: number; narrator?: string; coverData?: string;
}> {
  let title = '';
  let author = 'Unknown';
  let year: number | undefined;
  let narrator: string | undefined;
  let coverData: string | undefined;
  try {
    const mm = await import('music-metadata');
    const { common } = await mm.parseFile(filePath);
    if (common.title) title = common.title;
    author = common.albumartist || common.artist || (common.artists && common.artists[0]) || 'Unknown';
    if (common.year) year = common.year;
    if (common.composer && common.composer.length) narrator = common.composer[0];
    const pic = common.picture && common.picture[0];
    if (pic) coverData = `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
  } catch (tagErr) {
    console.warn('[library-actions] Could not read embedded tags:', tagErr);
  }
  if (!title) {
    const parsed = ebookLibrary.parseFilename(path.basename(filePath));
    title = parsed.title || path.basename(filePath).replace(/\.[^.]+$/i, '');
    if (!year) year = parsed.year;
    if (author === 'Unknown') author = parsed.authorFull || parsed.authorLast || 'Unknown';
  }
  return { title, author, year, narrator, coverData };
}

/**
 * A name that is free inside `dir`, appending " (2)", " (3)", … before the
 * extension until one is. Versions of one book share a title/author, so their
 * descriptive filenames collide by construction — without this, adding a second
 * narration or a second edition silently overwrites the first one's file while
 * both variants still point at that single path.
 */
function uniqueArchiveName(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = filename;
  for (let n = 2; fsSync.existsSync(path.join(dir, candidate)); n++) {
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

/**
 * Import an existing audio file (m4b/mp3/wav/…) as a "complete" audiobook
 * project: create the project dir, transcode/normalize the audio into
 * archive/<descriptive>.m4b (the PROTECTED folder — professionally-read uploads
 * are irreplaceable and must never sit in output/, which delete-output wipes),
 * seed metadata + cover from the file's embedded tags, and register the output
 * so it appears on the Bookshelf like any book.
 */
export async function importAudiobookProject(
  audioSourcePath: string,
  opts?: { onProgress?: ImportProgress },
): Promise<{
  success: boolean; projectId?: string; projectPath?: string; bfpPath?: string;
  projectName?: string; sourceType?: string; duplicate?: boolean;
  existingProjectId?: string; existingTitle?: string; error?: string;
}> {
  try {
    const filename = path.basename(audioSourcePath);

    // Duplicate guard — same as epub import, keyed on a content hash.
    const importHash = await sha256File(audioSourcePath);
    {
      const existingFolder = manifestService.getProjectsPath();
      let names: string[] = [];
      try { names = await fs.readdir(existingFolder); } catch { /* no projects yet */ }
      for (const name of names) {
        let mf: any;
        try { mf = JSON.parse(await fs.readFile(path.join(existingFolder, name, 'manifest.json'), 'utf-8')); }
        catch { continue; }
        if (mf.source?.fileHash === importHash) {
          const dupTitle = mf.metadata?.title || name;
          return { success: false, duplicate: true, existingProjectId: name, existingTitle: dupTitle,
            error: `“${dupTitle}” is already in your library — skipped to avoid a duplicate.` };
        }
      }
    }

    const { title, author, year, narrator, coverData } = await readAudioTags(audioSourcePath);

    // Project folder (human-readable, ASCII slug — same convention as epub import).
    const cleanTitle = toAsciiSlug(title.replace(/\s+/g, '_'));
    const cleanAuthor = toAsciiSlug(author.replace(/\s+/g, '_'));
    const yearStr = year ? `_(${year})` : '';
    let slug = toAsciiSlug(`${cleanTitle}_-_${cleanAuthor}${yearStr}`).substring(0, 150);
    const projectsFolder = manifestService.getProjectsPath();
    if (fsSync.existsSync(path.join(projectsFolder, slug))) slug = `${slug}_${Date.now()}`;
    const projectDir = path.join(projectsFolder, slug);
    await fs.mkdir(path.join(projectDir, 'archive'), { recursive: true });

    // Normalize the audio into archive/<descriptive>.m4b (transcode if needed,
    // preserve or synthesize a single title-named chapter). This is a
    // professionally-read upload — it lives in the protected archive/ folder so
    // pipeline:delete-output can never destroy it. The manifest's playable
    // pointer (outputs.audiobook.path, set by registerAudiobookOutput below)
    // points straight at this archive file; metadata-level edits (tags, cover,
    // chapters, embedded transcript) may still rewrite it in place atomically.
    const archiveMetadata = { title, author, year: year ? String(year) : undefined };
    const outputFilename = manifestService.computeDescriptiveFilename(archiveMetadata, '.m4b');
    const outPath = path.join(projectDir, 'archive', outputFilename);
    await normalizeAudioToM4b(audioSourcePath, outPath, {
      title, author, narrator, year: year ? String(year) : undefined, fallbackChapterTitle: title,
    }, { onProgress: (f) => opts?.onProgress?.(filename, f) });

    let coverPath: string | undefined;
    if (coverData) {
      try { coverPath = await saveImageToMedia(coverData, 'cover'); }
      catch (coverErr) { console.warn('[library-actions] Failed to save cover:', coverErr); }
    }
    // Embed the cover INTO the imported m4b so the file is fully self-contained:
    // downloaded/offline copies (and any other player) read the art straight from
    // the audio, with no sidecar and no server. normalizeAudioToM4b writes tags
    // but not our chosen cover; applyMetadata layers it on losslessly, keeping
    // chapters. Non-fatal — a failure just leaves the media/ copy in place.
    if (coverPath) {
      try {
        const coverAbs = path.join(manifestService.getLibraryBasePath(), coverPath);
        if (fsSync.existsSync(coverAbs)) {
          await applyMetadata(outPath, { title, author, narrator, year: year ? String(year) : undefined, coverPath: coverAbs } as any);
        }
      } catch (embedErr) { console.warn('[library-actions] Failed to embed cover in m4b:', embedErr); }
    }

    const manifest = {
      version: 1,
      projectId: slug,
      projectType: 'book',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      source: { type: 'audiobook', originalFilename: filename, fileHash: importHash, deletedBlockIds: [] },
      metadata: { title, author, year, language: 'en', outputFilename, coverPath },
      sortOrder: -1,
      chapters: [],
      pipeline: {},
      outputs: {},
      archive: [],
    };
    await fs.writeFile(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Mark the project "complete" (sets outputs.audiobook.path) so it lists on
    // the Studio grid and the Bookshelf just like a generated book.
    await manifestService.registerAudiobookOutput(outPath, { professionallyRead: true });

    console.log(`[library-actions] Imported audiobook project: ${projectDir}`);
    return { success: true, projectId: slug, projectPath: projectDir, bfpPath: projectDir, projectName: title, sourceType: 'audiobook' };
  } catch (err) {
    console.error('[library-actions] importAudiobookProject:', err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Flag a version as professionally read (a bought/ripped narration) or not (TTS
 * output). Accepts the synthesized ids too: 'audiobook' for outputs.audiobook and
 * 'bilingual:<pair>' for a bilingual output.
 */
export async function setVariantProfessional(
  projectId: string,
  variantId: string,
  value: boolean,
): Promise<{ success: boolean; error?: string }> {
  try {
    let found = false;
    const saved = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants;
      if (variantId === 'audiobook') {
        if (mf.outputs?.audiobook) { mf.outputs.audiobook.professionallyRead = value; found = true; }
      } else if (variantId.startsWith('bilingual:')) {
        const pair = variantId.slice('bilingual:'.length);
        const bo = mf.outputs?.bilingualAudiobooks?.[pair];
        if (bo) { bo.professionallyRead = value; found = true; }
      } else {
        const v = mf.variants.find((x) => x.id === variantId);
        if (v) { v.professionallyRead = value; found = true; }
      }
    });
    if (!saved?.success) return { success: false, error: saved?.error || 'Failed to save manifest' };
    if (!found) return { success: false, error: `Version ${variantId} not found` };
    return { success: true };
  } catch (err) { return { success: false, error: (err as Error).message }; }
}

/**
 * Make `variantId` the project's primary version. The project-level title,
 * author, year and cover are adopted from that variant — the primary IS the
 * book's identity, so a mismatch here is what makes a shelf entry disagree with
 * the file it opens.
 */
export async function setPrimaryVariant(
  projectId: string,
  variantId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    let found = false;
    const saved = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants;
      const v = mf.variants.find((x) => x.id === variantId);
      if (!v) return;
      found = true;
      mf.primaryVariantId = variantId;
      mf.metadata.title = v.metadata.title ?? mf.metadata.title;
      mf.metadata.author = v.metadata.author ?? mf.metadata.author;
      mf.metadata.year = v.metadata.year ?? mf.metadata.year;
      mf.metadata.coverPath = v.metadata.coverPath ?? mf.metadata.coverPath;
    });
    // saved before found: a failed manifest READ leaves found=false, and reporting
    // "version not found" there would mask the real error (project missing/corrupt).
    if (!saved?.success) return { success: false, error: saved?.error || 'Failed to update project — primary version unchanged.' };
    if (!found) return { success: false, error: `Version ${variantId} not found` };
    return { success: true };
  } catch (err) { return { success: false, error: (err as Error).message }; }
}

/**
 * Update one variant's metadata. When the variant is the project's primary, the
 * project-level metadata is kept in sync; when it is an audiobook, the effective
 * tags (and cover) are embedded into the m4b immediately so the file on disk and
 * the manifest never disagree.
 */
export async function saveVariantMetadata(
  projectId: string,
  variantId: string,
  meta: Record<string, unknown>,
  coverData?: string,
): Promise<{ success: boolean; coverPath?: string; error?: string }> {
  try {
    let coverPath: string | undefined;
    if (coverData) { try { coverPath = await saveImageToMedia(coverData, 'cover'); } catch (e) { console.warn('[library-actions] variant cover:', e); } }
    const override: Record<string, unknown> = {};
    // `descriptor` is a top-level variant field (free text, blank allowed), not part of metadata.
    let descriptor: string | undefined;
    for (const [k, v] of Object.entries(meta || {})) {
      if (k === 'descriptor') { descriptor = v == null ? '' : String(v); continue; }
      if (v !== undefined && v !== null && v !== '') override[k] = v;
    }
    if (coverPath) override.coverPath = coverPath;

    let updated: ProjectVariant | null = null;
    const saved = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants.map((v) => v.id === variantId ? { ...v, descriptor: descriptor !== undefined ? descriptor : v.descriptor, metadata: { ...v.metadata, ...override } } : v);
      if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
      updated = mf.variants.find((v) => v.id === variantId) || null;
      if (updated && mf.primaryVariantId === variantId) {
        const md = (updated as ProjectVariant).metadata;
        mf.metadata.title = md.title ?? mf.metadata.title;
        mf.metadata.author = md.author ?? mf.metadata.author;
        mf.metadata.year = md.year ?? mf.metadata.year;
        mf.metadata.narrator = md.narrator ?? mf.metadata.narrator;
        mf.metadata.series = md.series ?? mf.metadata.series;
        mf.metadata.description = md.description ?? mf.metadata.description;
        mf.metadata.coverPath = md.coverPath ?? mf.metadata.coverPath;
      }
    });
    if (!saved?.success) return { success: false, error: saved?.error || 'Failed to update manifest' };

    const uv = updated as ProjectVariant | null;
    if (uv && uv.kind === 'audiobook') {
      const m4bAbs = normalizeFsPath(path.join(manifestService.getProjectPath(projectId), uv.path));
      if (fsSync.existsSync(m4bAbs)) {
        const md = uv.metadata;
        const coverAbs = md.coverPath ? path.join(manifestService.getLibraryBasePath(), md.coverPath) : undefined;
        await applyMetadata(m4bAbs, { title: md.title, author: md.author, year: md.year, narrator: md.narrator, series: md.series, description: md.description, coverPath: coverAbs && fsSync.existsSync(coverAbs) ? coverAbs : undefined } as any);
      }
    }
    return { success: true, coverPath };
  } catch (err) {
    console.error('[library-actions] saveVariantMetadata:', err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Add another version (variant) of an existing book — an alternate edition, a
 * translation, or a professionally-read audiobook — to a project that already
 * exists. Audio lands in the protected archive/ folder and is flagged
 * professionallyRead; the first audiobook added also becomes the project's
 * shelf-visible output.
 *
 * Callers are responsible for converting non-native ebook formats via Calibre
 * first (the Studio does this in studio-versions.component before calling).
 */
export async function addVariant(
  projectId: string,
  filePath: string,
  opts?: { onProgress?: ImportProgress },
): Promise<{ success: boolean; variantId?: string; variant?: ProjectVariant; error?: string }> {
  try {
    const projectDir = manifestService.getProjectPath(projectId);
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const isAudio = VARIANT_AUDIO_EXT.includes(ext);
    const hash = await sha256File(filePath);

    const got0 = await manifestService.getManifest(projectId);
    if (!got0.manifest) return { success: false, error: 'Project not found' };
    const hadAudiobook = !!got0.manifest.outputs?.audiobook?.path;
    if (manifestService.getVariants(got0.manifest).variants.some((v) => v.sourceFileHash && v.sourceFileHash === hash)) {
      return { success: false, error: 'That file is already a version of this book.' };
    }

    let variant: ProjectVariant;
    if (isAudio) {
      // A version of a book we ALREADY know: the project's own metadata names it,
      // not the audio file's tags. An uploaded narration is routinely tagged with
      // whatever the source export produced ("opening credits", "Track 01",
      // "Unknown" artist) — adopting that renames the version, the archive file,
      // the m4b tags AND the synthesized chapter after a stray tag. Only the tags
      // the project has no answer for (narrator, cover art) come from the file.
      const { narrator: taggedNarrator, coverData } = await readAudioTags(filePath);
      const eff = manifestService.effectiveAudiobookMetadata(got0.manifest.metadata);
      const { title, author, year } = eff;
      // The file's composer tag is the one naming the person who READ it, which
      // the project only knows if the user already typed it in.
      const narrator = eff.narrator ?? taggedNarrator;
      // Professionally-read audio → protected archive/ (never output/, which
      // delete-output blind-wipes). The variant path + outputs.audiobook.path
      // both point straight at this archive file.
      await fs.mkdir(path.join(projectDir, 'archive'), { recursive: true });
      const outputFilename = uniqueArchiveName(
        path.join(projectDir, 'archive'),
        manifestService.computeDescriptiveFilename({ title, author, year: year ? String(year) : undefined }, '.m4b'),
      );
      const outAbs = path.join(projectDir, 'archive', outputFilename);
      await normalizeAudioToM4b(filePath, outAbs, { title, author, narrator, year: year ? String(year) : undefined, fallbackChapterTitle: title }, { onProgress: (f) => opts?.onProgress?.(filename, f, projectId) });
      let coverPath: string | undefined;
      if (coverData) { try { coverPath = await saveImageToMedia(coverData, 'cover'); } catch { /* ignore */ } }
      // Embed the cover into the m4b so the file is self-contained (see import-audiobook).
      if (coverPath) {
        try {
          const coverAbs = path.join(manifestService.getLibraryBasePath(), coverPath);
          if (fsSync.existsSync(coverAbs)) await applyMetadata(outAbs, { title, author, narrator, year: year ? String(year) : undefined, coverPath: coverAbs } as any);
        } catch (e) { console.warn('[library-actions] Failed to embed cover in m4b:', e); }
      }
      variant = { id: crypto.randomUUID(), kind: 'audiobook', format: 'm4b', path: `archive/${outputFilename}`, metadata: { title, author, year: year ? String(year) : undefined, narrator, coverPath }, sourceFileHash: hash, addedAt: new Date().toISOString(), professionallyRead: true };
    } else {
      const p = ebookLibrary.parseFilename(filename);
      const title = p.title || filename.replace(/\.[^.]+$/i, '');
      const author = p.authorFull || p.authorLast || 'Unknown';
      await fs.mkdir(path.join(projectDir, 'archive'), { recursive: true });
      const descriptiveName = uniqueArchiveName(
        path.join(projectDir, 'archive'),
        manifestService.computeDescriptiveFilename({ title, author, year: p.year ? String(p.year) : undefined }, ext),
      );
      const ebookDest = path.join(projectDir, 'archive', descriptiveName);
      await manifestService.atomicCopyFile(filePath, ebookDest);
      // Extract the ebook's cover now so the variant has one from the start
      // (the Versions editor + browse grid read variant/book coverPath).
      let coverPath: string | undefined;
      try {
        const tmpOut = path.join(os.tmpdir(), 'bookforge-covers', `${crypto.randomUUID()}.jpg`);
        if (await ebookLibrary.extractCover(ebookDest, tmpOut)) {
          const buf = await fs.readFile(tmpOut);
          coverPath = await saveImageToMedia(`data:image/jpeg;base64,${buf.toString('base64')}`, 'cover');
          try { await fs.unlink(tmpOut); } catch { /* temp cleanup */ }
        }
      } catch (e) { console.warn('[library-actions] ebook cover:', e); }
      variant = { id: crypto.randomUUID(), kind: 'ebook', format: ext.replace('.', ''), path: `archive/${descriptiveName}`, metadata: { title, author, year: p.year ? String(p.year) : undefined, language: p.language, coverPath }, sourceFileHash: hash, addedAt: new Date().toISOString() };
    }

    const savedAdd = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = [...cur.variants, variant];
      if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId ?? variant.id;
    });
    if (!savedAdd?.success) {
      // The copied file is on disk but the manifest write failed — clean up the
      // orphan copy so a retry doesn't hit the sourceFileHash "already a version"
      // guard, and report the failure instead of pretending the add worked.
      try { await fs.unlink(normalizeFsPath(path.join(projectDir, variant.path))); } catch { /* leave it */ }
      return { success: false, error: savedAdd?.error || 'Failed to update project — the version was not added.' };
    }
    // First audiobook of a project → make it the shelf-visible one (don't clobber an existing one; Phase 2 lists them all).
    if (isAudio && !hadAudiobook) { try { await manifestService.registerAudiobookOutput(path.join(projectDir, variant.path), { professionallyRead: true }); } catch { /* non-fatal */ } }

    return { success: true, variantId: variant.id, variant };
  } catch (err) {
    console.error('[library-actions] addVariant:', err);
    return { success: false, error: (err as Error).message };
  }
}
