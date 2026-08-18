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
import { familyStem } from '../shared/document/book-families';
import type { FoundryVariantSource, ProjectVariant } from './manifest-types';

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
 *
 * `takenStems` extends "free" to the project's working chains: every file in a
 * chain is named `source/<the source's basename>.…` (familyStem), so an archive
 * file whose stem matches an existing chain's could never be given a chain of
 * its own — `addBookFamily` refuses the collision by name, because both chains
 * would write one working copy. The stems are avoided at NAMING time for the
 * same reason vlm-convert's new-copy path numbers its readings: the descriptive
 * name is derived, never the user's choice, so refusing over it would refuse
 * the version.
 */
function uniqueArchiveName(dir: string, filename: string, takenStems?: ReadonlySet<string>): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  const taken = (name: string): boolean => {
    if (fsSync.existsSync(path.join(dir, name))) return true;
    if (!takenStems) return false;
    const stem = name.slice(0, name.length - path.extname(name).length);
    return takenStems.has(stem.toLowerCase());
  };
  let candidate = filename;
  for (let n = 2; taken(candidate); n++) {
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
  success: boolean; projectId?: string; projectPath?: string;
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
    return { success: true, projectId: slug, projectPath: projectDir, projectName: title, sourceType: 'audiobook' };
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
      // ONE FILE, ONE ANSWER. The flag lives in two places — outputs.audiobook and
      // the stored variant — and the SAME m4b is reachable through both, because
      // getVariants dedupes them by path (a stored variant keeps its own uuid while
      // outputs.audiobook stays authoritative for the 'audiobook' id). Writing only
      // the addressed one lets them disagree, and then which answer the UI shows
      // depends on which id the click happened to carry. That is exactly how a
      // professionally-read recording came to be labelled as TTS output
      // (God's People, 2026-07-25) and how Animal Farm ended up storing false while
      // its output record said true. So stamp every record pointing at the SAME file.
      const norm = (p?: string) => (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
      const target = variantId === 'audiobook'
        ? mf.outputs?.audiobook?.path
        : mf.variants.find((x) => x.id === variantId)?.path;
      if (found && target) {
        if (mf.outputs?.audiobook && norm(mf.outputs.audiobook.path) === norm(target)) {
          mf.outputs.audiobook.professionallyRead = value;
        }
        for (const v of mf.variants) {
          if (v.kind === 'audiobook' && norm(v.path) === norm(target)) v.professionallyRead = value;
        }
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
 * Mark ONE version as this book's TTS file, or clear the mark (`null`).
 *
 * Owen, 2026-08-17: "The user can mark the file as a tts file if they want. I
 * think the user should be able to send any EPUB through tts."
 *
 * THE SAME SHAPE AS `setPrimaryVariant`, and for the same reason: the answer is
 * a single pointer on the manifest (`ttsVariantId`), not a boolean on every
 * variant. One slot cannot hold two answers, so marking a second version clears
 * the first by construction — there is no sweep to forget, and no way for two
 * rows to come back marked. (`setVariantProfessional` is the other idiom in this
 * file, and it is deliberately NOT the one copied: that flag is independent per
 * row, and it needs the multi-record stamping this does not.)
 *
 * It does NOT adopt the variant's metadata onto the project the way
 * `setPrimaryVariant` does. Primary is the book's IDENTITY; this is a statement
 * about which file to read aloud, and a book whose title changed because the
 * user picked a narration source would be a surprise nobody asked for.
 *
 * Clearing is `variantId === null` — a real act with its own button ("Unmark"),
 * not the absence of one. Marking a version that does not exist is refused by
 * name rather than stored as a pointer to nothing.
 */
export async function setTtsVariant(
  projectId: string,
  variantId: string | null,
): Promise<{ success: boolean; error?: string }> {
  try {
    let found = false;
    const saved = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants;
      if (variantId === null) {
        delete mf.ttsVariantId;
        found = true;
        return;
      }
      const v = mf.variants.find((x) => x.id === variantId);
      if (!v) return;
      found = true;
      mf.ttsVariantId = variantId;
    });
    // saved before found, exactly as setPrimaryVariant orders them: a failed
    // manifest READ leaves found=false, and "version not found" would mask it.
    if (!saved?.success) {
      return { success: false, error: saved?.error || 'Failed to update project — the TTS mark is unchanged.' };
    }
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
      // The stems the working chains of legacy projects already own. A chain's
      // files are named after its source's stem, so landing this copy on a taken
      // stem would collide with files a migrated manifest still records — the
      // name steps around them.
      const chainStems = new Set(
        (await manifestService.readBookFamilies(projectDir))
          .map((f) => familyStem(f.source).toLowerCase()),
      );
      const descriptiveName = uniqueArchiveName(
        path.join(projectDir, 'archive'),
        manifestService.computeDescriptiveFilename({ title, author, year: p.year ? String(p.year) : undefined }, ext),
        chainStems,
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

/**
 * The one comparison that decides whether two landings name the same export.
 *
 * EXPORTED because a second reader of this identity exists: the startup sweep
 * (`sweepFoundryExportTrays`, electron/main.ts) decides which files in a tray
 * are already on the versions page, and it must answer that question with
 * exactly the predicate `addFoundryOutputVariant` would — a sweep that judged
 * "already landed" more loosely would skip a file this function would have
 * added, and one that judged it more strictly would hand back a file this
 * function then REPLACES IN PLACE, silently overwriting a version's bytes and
 * its landedAt on nothing more than an app restart. One comparison, one answer.
 */
export function sameFoundryExportFile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Land a file Foundry exported as a VERSION of this book, in `output/`.
 *
 * Owen, 2026-08-17: "I think exports should go to the project as a version" —
 * and, refining it: "maybe the exports should be moved to output and visually be
 * smaller indented line items under their parent file... And maybe we have an
 * option to make it an archive file if we want."
 *
 * ── Why this is a sibling of addVariant rather than a call into it ──────────
 *
 * `addVariant` lands in `archive/`, and that is not incidental to it — the
 * folder is the PROTECTED one, the descriptive name steps around working-chain
 * stems, and the audio branch transcodes. An export is none of those things: it
 * is a derived file the user has not adopted yet, so it belongs in `output/`
 * until they say otherwise (`promoteVariantToArchive`). Passing a flag into
 * addVariant to switch its destination folder would have made every one of its
 * archive-shaped decisions conditional on a caller it was not written for. The
 * idioms are reused verbatim instead: atomic copy, descriptive name through
 * `uniqueArchiveName`, a `ProjectVariant` written under `modifyManifest`, and
 * the same orphan-copy cleanup when the manifest write fails.
 *
 * ── output/ IS THE WIPEABLE FOLDER, AND THAT IS THE POINT ───────────────────
 *
 * `delete-output` blind-wipes `output/` (see `importAudiobookProject`, which
 * says so at length about why irreplaceable audio must never sit there). An
 * export is replaceable BY CONSTRUCTION — Foundry still holds the project that
 * made it and can export it again — so it is exactly the kind of file that
 * folder is for. A user who wants one kept says so with "Add to archive", which
 * moves it to the protected folder and severs the nesting.
 *
 * ── Re-export replaces; it never piles up ───────────────────────────────────
 *
 * A landing whose (projectKey, fileName) matches an existing variant's
 * `foundrySource` overwrites THAT VARIANT'S FILE, keeping its id, its row, its
 * descriptor and the user's TTS mark. Exporting the same book five times leaves
 * one version, not five. There is deliberately NO cross-variant `sourceFileHash`
 * refusal here (addVariant has one): an export whose bytes match the file that
 * was imported into Foundry is the ordinary result of exporting an unedited
 * book, and refusing it would mean the export the user just made never appears.
 * Same bytes under different provenance is a legitimate pair of rows.
 *
 * ── `landedAt` IS THE CALLER'S TO STATE, AND IT IS NOT ALWAYS NOW ───────────
 *
 * This function used to stamp `new Date()`, which was right while the only
 * caller was the live announcement — Foundry says "this landed" the instant it
 * lands, so now IS when. The startup sweep (`sweepFoundryExportTrays`,
 * electron/main.ts) reads trays that have been sitting there since before this
 * pipeline existed, and for those files the truth available is the file's own
 * mtime. A default of now() would have let a sweep on any morning re-date every
 * old export to that morning — and `landedAt` is what orders "the newest export"
 * for the shelf's Process button, so the whole library would have claimed to
 * have been exported the day it was first swept. So there is no default: both
 * callers say when, because only they know.
 */
export async function addFoundryOutputVariant(
  projectId: string,
  filePath: string,
  provenance: {
    projectKey: string;
    fileName: string;
    parentVariantId: string | null;
    /** When this export APPEARED — now() for a live landing, the file's mtime for a swept one. */
    landedAt: string;
    /**
     * The ledger step Foundry cast this export from, when the landing said so.
     * Absent is "unknown" and is written as an absent field rather than as an
     * empty string, so the record cannot claim a step it was never told about —
     * see {@link FoundryVariantSource.stepId}.
     */
    stepId?: string;
  },
  landingTitle: string,
): Promise<{ success: boolean; variantId?: string; replaced?: boolean; error?: string }> {
  try {
    const projectDir = manifestService.getProjectPath(projectId);
    const got0 = await manifestService.getManifest(projectId);
    if (!got0.manifest) return { success: false, error: 'Project not found' };
    const hash = await sha256File(filePath);
    const landedAt = provenance.landedAt;

    const existing = manifestService.getVariants(got0.manifest).variants.find((v) =>
      !!v.foundrySource
      && v.foundrySource.projectKey === provenance.projectKey
      && sameFoundryExportFile(v.foundrySource.fileName, provenance.fileName));

    if (existing) {
      // IN PLACE, at the path the row already names. The variant keeps its id, so
      // a TTS mark, a descriptor the user typed and anything pointing at this
      // version all survive the re-export — which is the whole reason the
      // provenance pair is recorded.
      const dest = normalizeFsPath(path.join(projectDir, ...existing.path.split('/')));
      await manifestService.atomicCopyFile(filePath, dest);
      const saved = await manifestService.modifyManifest(projectId, (mf) => {
        const cur = manifestService.getVariants(mf);
        mf.variants = cur.variants.map((v) => v.id === existing.id
          ? {
              ...v,
              // The file changed, so the hash that describes it must change with
              // it — a stale hash is what makes a later duplicate guard answer
              // about bytes that are no longer there.
              sourceFileHash: hash,
              foundrySource: {
                projectKey: provenance.projectKey,
                fileName: provenance.fileName,
                // Re-read from the mapping every landing: the user can re-import
                // a different version into the same Foundry project, and the
                // parent is whatever the mapping says NOW.
                parentVariantId: provenance.parentVariantId,
                landedAt,
                // Rebuilt rather than merged over the old record, which is what
                // makes a landing that names no step CLEAR the one that was
                // there. The file has been overwritten; a step kept from the
                // previous export would describe bytes that are gone.
                ...(provenance.stepId === undefined ? {} : { stepId: provenance.stepId }),
              } satisfies FoundryVariantSource,
            }
          : v);
      });
      if (!saved?.success) {
        return {
          success: false,
          error: saved?.error
            || `${provenance.fileName} was copied in, but recording the re-export failed. The version row may name the old file.`,
        };
      }
      return { success: true, variantId: existing.id, replaced: true };
    }

    // A VERSION OF A BOOK WE ALREADY KNOW, so the project's own metadata names
    // it — the same rule addVariant's audio branch states. Foundry's tray name
    // goes in `descriptor` (free text: "how this version differs"), where it is
    // the user's to edit and is never overwritten by a later re-export.
    const m = got0.manifest.metadata;
    const ext = path.extname(provenance.fileName).toLowerCase();
    const outputDir = path.join(projectDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });
    const descriptiveName = uniqueArchiveName(
      outputDir,
      manifestService.computeDescriptiveFilename(
        { title: m.title, author: m.author, year: m.year ? String(m.year) : undefined }, ext),
    );
    const dest = path.join(outputDir, descriptiveName);
    await manifestService.atomicCopyFile(filePath, dest);

    const variant: ProjectVariant = {
      id: crypto.randomUUID(),
      kind: 'ebook',
      format: ext.replace('.', ''),
      path: `output/${descriptiveName}`,
      descriptor: landingTitle,
      metadata: {
        title: m.title, author: m.author, year: m.year ? String(m.year) : undefined,
        language: m.language, coverPath: m.coverPath,
      },
      sourceFileHash: hash,
      addedAt: landedAt,
      foundrySource: {
        projectKey: provenance.projectKey,
        fileName: provenance.fileName,
        parentVariantId: provenance.parentVariantId,
        landedAt,
        ...(provenance.stepId === undefined ? {} : { stepId: provenance.stepId }),
      },
    };

    const savedAdd = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = [...cur.variants, variant];
      // Deliberately NOT touched: `primaryVariantId` (addVariant seeds it when a
      // project has none) and `ttsVariantId`. An export must not become the
      // book's identity, and it must not mark itself as the file to narrate —
      // the mark is the user's, and a Foundry export that claimed it would
      // silently redirect the shelf's Process button.
    });
    if (!savedAdd?.success) {
      // The copy is on disk but the manifest write failed. Remove the orphan so a
      // retry is clean, exactly as addVariant does.
      try { await fs.unlink(normalizeFsPath(dest)); } catch { /* leave it */ }
      return {
        success: false,
        error: savedAdd?.error || 'Failed to update project — the exported version was not added.',
      };
    }
    return { success: true, variantId: variant.id, replaced: false };
  } catch (err) {
    console.error('[library-actions] addFoundryOutputVariant:', err);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * "Add to archive": promote a Foundry export to a top-level version of the book.
 *
 * Owen, 2026-08-17: "maybe we have an option to make it an archive file if we
 * want. Like an 'add to archive' button or something that moves it to the top
 * level."
 *
 * A MOVE, not a copy — the file leaves `output/` (where `delete-output` may wipe
 * it) for the protected `archive/` folder, under a name unique THERE. One file
 * before, one file after; the version keeps its id, so nothing pointing at it
 * (the TTS mark above all) is disturbed.
 *
 * ── Why the provenance is CLEARED ──────────────────────────────────────────
 *
 * `foundrySource` is what makes a row render nested under its parent, and
 * promotion is the user saying this is their own file at the top level. Keeping
 * the provenance would leave it drawn as a derivative of another version while
 * living in the folder reserved for originals — the record and the picture
 * disagreeing. Clearing it also releases the (projectKey, fileName) pair, which
 * is the deliberate consequence: the NEXT export of that same file lands as a
 * fresh version in output/ rather than overwriting the copy the user just chose
 * to keep. That is the behaviour promotion is for.
 */
export async function promoteVariantToArchive(
  projectId: string,
  variantId: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const projectDir = manifestService.getProjectPath(projectId);
    const got0 = await manifestService.getManifest(projectId);
    if (!got0.manifest) return { success: false, error: 'Project not found' };
    const variant = manifestService.getVariants(got0.manifest).variants.find((v) => v.id === variantId);
    if (!variant) return { success: false, error: `Version ${variantId} not found` };
    if (!variant.foundrySource) {
      return {
        success: false,
        error: 'That version is already one of this book\'s own files, so there is nothing to add to '
          + 'the archive. Only a version Foundry exported can be promoted.',
      };
    }
    const from = normalizeFsPath(path.join(projectDir, ...variant.path.split('/')));
    if (!fsSync.existsSync(from)) {
      return {
        success: false,
        error: `${path.basename(from)} is not on disk, so there is nothing to move into the archive. `
          + 'It may have been deleted, or output/ may have been cleared.',
      };
    }
    const archiveDir = path.join(projectDir, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    const name = uniqueArchiveName(archiveDir, path.basename(from));
    const to = path.join(archiveDir, name);
    // Same project directory, so the same volume: a rename is atomic and leaves
    // no window in which the file is in both folders or neither.
    await fs.rename(from, to);

    const saved = await manifestService.modifyManifest(projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants.map((v) => {
        if (v.id !== variantId) return v;
        const promoted = { ...v, path: `archive/${name}` };
        delete promoted.foundrySource;
        return promoted;
      });
    });
    if (!saved?.success) {
      // The file moved but the record still names output/. Put it back rather
      // than leaving the manifest pointing at a path with nothing on it.
      try { await fs.rename(to, from); } catch { /* the move below is now the report */ }
      return {
        success: false,
        error: saved?.error || 'Failed to update project — the version was not moved into the archive.',
      };
    }
    return { success: true, path: `archive/${name}` };
  } catch (err) {
    console.error('[library-actions] promoteVariantToArchive:', err);
    return { success: false, error: (err as Error).message };
  }
}
