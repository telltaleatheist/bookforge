/**
 * Manifest Service - Unified project management for BookForge
 *
 * Handles:
 * - Creating new projects with proper folder structure
 * - Reading/writing manifest.json files
 * - Atomic writes via same-dir temp + rename (Syncthing-safe)
 * - Per-project write locks to prevent concurrent read-modify-write races
 * - Cross-platform path resolution
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { normalizeFsPath, toAsciiSlug, toAsciiFilename, collapseFilenameDots } from './path-utils';
import type {
  ProjectManifest,
  ProjectType,
  ManifestMetadata,
  ManifestSource,
  ManifestGetResult,
  ManifestSaveResult,
  ManifestCreateResult,
  ManifestListResult,
  ProjectSummary,
  ManifestUpdate,
  ArchiveEntry,
  ProjectVariant,
  VariantMetadata,
} from './manifest-types.js';

// Generate UUID v4 without external dependency
function uuidv4(): string {
  return crypto.randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_FILENAME = 'manifest.json';
const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');
const MANIFEST_VERSION = 2;

// Folder structure within each project
const PROJECT_FOLDERS = ['source', 'archive', 'stages', 'stages/01-cleanup', 'stages/02-translate', 'stages/03-tts', 'output'];

// ─────────────────────────────────────────────────────────────────────────────
// Per-project write lock (prevents concurrent read-modify-write races)
// ─────────────────────────────────────────────────────────────────────────────

const manifestLocks = new Map<string, Promise<any>>();

/**
 * Serialize async operations on the same project's manifest.
 * Concurrent calls for the same projectId are queued; different projects run in parallel.
 */
function acquireLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but swallow errors so a failed write doesn't block future writes
  manifestLocks.set(projectId, next.then(() => {}, () => {}));
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Library Path Management
// ─────────────────────────────────────────────────────────────────────────────

let libraryBasePath: string | null = null;

/**
 * Set the library base path (called from main.ts when settings change)
 */
export function setLibraryBasePath(basePath: string | null): void {
  libraryBasePath = basePath;
  console.log(`[ManifestService] Library base path set to: ${basePath}`);
}

/**
 * Get the current library base path
 */
export function getLibraryBasePath(): string {
  if (!libraryBasePath) {
    // Default to ~/Documents/BookForge
    return path.join(os.homedir(), 'Documents', 'BookForge');
  }
  return libraryBasePath;
}

/**
 * Get the projects directory path
 */
export function getProjectsPath(): string {
  return path.join(getLibraryBasePath(), 'projects');
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a relative manifest path to an absolute OS path
 * Manifest paths use forward slashes, OS paths use platform-specific separators
 */
export function resolveManifestPath(projectId: string, relativePath: string): string {
  // Replace forward slashes with OS-specific separator
  const normalizedPath = relativePath.split('/').join(path.sep);
  return path.join(getProjectsPath(), projectId, normalizedPath);
}

/**
 * Convert an absolute OS path to a relative manifest path
 * Result uses forward slashes regardless of platform
 */
export function toManifestPath(projectId: string, absolutePath: string): string {
  const projectDir = path.join(getProjectsPath(), projectId);
  const relativePath = path.relative(projectDir, absolutePath);
  // Always use forward slashes in manifest
  return relativePath.split(path.sep).join('/');
}

/**
 * Get the absolute path to a project folder
 */
export function getProjectPath(projectId: string): string {
  return path.join(getProjectsPath(), projectId);
}

/**
 * Get the absolute path to a project's manifest.json
 */
export function getManifestPath(projectId: string): string {
  return path.join(getProjectsPath(), projectId, MANIFEST_FILENAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic Write Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a file atomically:
 * 1. Write to a temp file in the same directory as the target (guarantees same filesystem)
 * 2. Rename to final path (atomic on same filesystem)
 *
 * Previous implementation staged in /tmp/ which is a different filesystem from
 * /Volumes/Callisto. The rename() would fail with EXDEV and fall back to copyFile(),
 * which is NOT atomic — concurrent writes could interleave and corrupt the file.
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  // Ensure target directory exists
  const targetDir = path.dirname(targetPath);
  await fs.promises.mkdir(targetDir, { recursive: true });

  // Stage in the same directory so rename() is always atomic (same filesystem)
  const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.${uuidv4()}.tmp`);

  try {
    await fs.promises.writeFile(tempPath, content, 'utf-8');
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Copy a file atomically to a target location.
 * Stages temp file adjacent to target to guarantee same-filesystem rename.
 */
export async function atomicCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  const targetDir = path.dirname(targetPath);
  await fs.promises.mkdir(targetDir, { recursive: true });

  const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.${uuidv4()}.tmp`);

  try {
    await fs.promises.copyFile(sourcePath, tempPath);
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Move a directory atomically (for project creation)
 */
export async function atomicMoveDirectory(sourceDir: string, targetDir: string): Promise<void> {
  try {
    // Ensure parent of target exists
    await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

    // Try atomic rename first
    try {
      await fs.promises.rename(sourceDir, targetDir);
    } catch (renameError: any) {
      if (renameError.code === 'EXDEV') {
        // Cross-filesystem: recursive copy then delete
        await copyDirectoryRecursive(sourceDir, targetDir);
        await fs.promises.rm(sourceDir, { recursive: true, force: true });
      } else {
        throw renameError;
      }
    }
  } catch (error) {
    // Clean up target on error
    try {
      await fs.promises.rm(targetDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Helper: copy directory recursively
 */
async function copyDirectoryRecursive(source: string, target: string): Promise<void> {
  await fs.promises.mkdir(target, { recursive: true });

  const entries = await fs.promises.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath);
    } else {
      await fs.promises.copyFile(sourcePath, targetPath);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new project with proper folder structure
 */
export async function createProject(
  projectType: ProjectType,
  source: Partial<ManifestSource>,
  metadata: Partial<ManifestMetadata>
): Promise<ManifestCreateResult> {
  const projectId = uuidv4();

  // Stage in temp directory first
  const stagingProjectDir = path.join(STAGING_DIR, projectId);
  const targetProjectDir = getProjectPath(projectId);

  try {
    // Create folder structure in staging
    await fs.promises.mkdir(stagingProjectDir, { recursive: true });
    for (const folder of PROJECT_FOLDERS) {
      await fs.promises.mkdir(path.join(stagingProjectDir, folder), { recursive: true });
    }

    // Create initial manifest
    const manifest: ProjectManifest = {
      version: MANIFEST_VERSION,
      projectId,
      projectType,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      source: {
        type: source.type || (projectType === 'article' ? 'url' : 'epub'),
        originalFilename: source.originalFilename || 'unknown',
        fileHash: source.fileHash,
        url: source.url,
        fetchedAt: source.fetchedAt,
        deletedBlockIds: source.deletedBlockIds || [],
        pageOrder: source.pageOrder,
      },
      metadata: {
        title: metadata.title || 'Untitled',
        author: metadata.author || 'Unknown',
        authorFileAs: metadata.authorFileAs,
        year: metadata.year,
        language: metadata.language || 'en',
        publisher: metadata.publisher,
        description: metadata.description,
        coverPath: metadata.coverPath,
        byline: metadata.byline,
        excerpt: metadata.excerpt,
        wordCount: metadata.wordCount,
        narrator: metadata.narrator,
        series: metadata.series,
        seriesPosition: metadata.seriesPosition,
        outputFilename: metadata.outputFilename,
      },
      chapters: [],
      pipeline: {},
      outputs: {},
    };

    // Write manifest to staging
    const stagingManifestPath = path.join(stagingProjectDir, MANIFEST_FILENAME);
    await fs.promises.writeFile(stagingManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Atomically move to final location
    await atomicMoveDirectory(stagingProjectDir, targetProjectDir);

    return {
      success: true,
      projectId,
      projectPath: targetProjectDir,
      manifestPath: getManifestPath(projectId),
    };
  } catch (error: any) {
    // Clean up staging on error
    try {
      await fs.promises.rm(stagingProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Read a project manifest
 */
export async function getManifest(projectId: string): Promise<ManifestGetResult> {
  try {
    const manifestPath = getManifestPath(projectId);

    if (!fs.existsSync(manifestPath)) {
      return {
        success: false,
        error: `Project not found: ${projectId}`,
      };
    }

    const content = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as ProjectManifest;
    // Normalize to NFC so downstream path construction matches on-disk folder names
    // (older manifests written on macOS may store projectId in NFD form).
    if (manifest.projectId) manifest.projectId = normalizeFsPath(manifest.projectId);

    return {
      success: true,
      manifest,
      projectPath: getProjectPath(manifest.projectId || projectId),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Internal save — no lock. Called from within locked contexts.
 */
async function saveManifestImpl(manifest: ProjectManifest): Promise<ManifestSaveResult> {
  try {
    manifest.modifiedAt = new Date().toISOString();
    const manifestPath = getManifestPath(manifest.projectId);
    await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
    return { success: true, manifestPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Save (overwrite) a project manifest. Acquires the per-project lock.
 */
export async function saveManifest(manifest: ProjectManifest): Promise<ManifestSaveResult> {
  return acquireLock(manifest.projectId, () => saveManifestImpl(manifest));
}

/**
 * Read-modify-write a manifest atomically. The callback receives the current
 * manifest and can mutate it in place; the modified version is saved while
 * the per-project lock is held, preventing concurrent writes from interleaving.
 */
export async function modifyManifest(
  projectId: string,
  fn: (manifest: ProjectManifest) => Promise<void> | void,
): Promise<ManifestSaveResult> {
  return acquireLock(projectId, async () => {
    const result = await getManifest(projectId);
    if (!result.success || !result.manifest) {
      return { success: false, error: result.error || 'Project not found' };
    }
    await fn(result.manifest);
    return saveManifestImpl(result.manifest);
  });
}

/**
 * Update specific fields in a manifest (locked read-modify-write)
 */
export async function updateManifest(update: ManifestUpdate): Promise<ManifestSaveResult> {
  return modifyManifest(update.projectId, (manifest) => {
    if (update.source) {
      manifest.source = { ...manifest.source, ...update.source };
    }
    if (update.metadata) {
      manifest.metadata = { ...manifest.metadata, ...update.metadata };
    }
    if (update.chapters !== undefined) {
      manifest.chapters = update.chapters;
    }
    if (update.pipeline) {
      manifest.pipeline = { ...manifest.pipeline, ...update.pipeline };
    }
    if (update.outputs) {
      // Deep merge bilingualAudiobooks to preserve existing language pairs
      const mergedBilingualAudiobooks = update.outputs.bilingualAudiobooks
        ? { ...manifest.outputs?.bilingualAudiobooks, ...update.outputs.bilingualAudiobooks }
        : manifest.outputs?.bilingualAudiobooks;
      manifest.outputs = { ...manifest.outputs, ...update.outputs };
      if (mergedBilingualAudiobooks) {
        manifest.outputs.bilingualAudiobooks = mergedBilingualAudiobooks;
      }
    }
    if (update.editor) {
      manifest.editor = { ...manifest.editor, ...update.editor };
    }
    if (update.archived !== undefined) {
      manifest.archived = update.archived;
    }
    if (update.sortOrder !== undefined) {
      manifest.sortOrder = update.sortOrder;
    }
    if (update.archive !== undefined) {
      manifest.archive = update.archive;
    }
  });
}

/**
 * Register a finished audiobook (.m4b) in its project manifest — `outputs.audiobook`
 * is the single source of truth the library reads to surface a completed book
 * (studio.service keys "completed" status off `outputs.audiobook.path`).
 *
 * This is meant to run in the MAIN process at the authoritative assembly-completion
 * point, so a successfully assembled m4b is ALWAYS registered. Registration used to
 * happen ONLY via a renderer-side follow-up (queue.service → audiobook:link-audio)
 * which silently no-ops when the (re)assembly job has no bfpPath or the renderer never
 * processes the completion event — orphaning the m4b on disk with `outputs` left `{}`.
 *
 * The m4b is expected at <libraryBase>/projects/<projectId>/output/<file>.m4b, so the
 * projectId is derived from the path. If the m4b is NOT under the configured library
 * (so the projectId-based lookup wouldn't resolve to it), this returns `skipped:true`
 * and writes nothing — it never targets the wrong manifest.
 */
/**
 * The audiobook's effective metadata: per-format overrides (metadata.audiobook)
 * layered over the canonical ebook/project fields. This is what should be
 * embedded into the m4b and shown for the audiobook on the shelf.
 */
export function effectiveAudiobookMetadata(m: ManifestMetadata): {
  title: string; author: string; year?: string; narrator?: string;
  series?: string; seriesPosition?: number; description?: string; coverPath?: string;
} {
  const o = m.audiobook || {};
  return {
    title: o.title ?? m.title,
    author: o.author ?? m.author,
    year: o.year ?? m.year,
    narrator: o.narrator ?? m.narrator,
    series: o.series ?? m.series,
    seriesPosition: o.seriesPosition ?? m.seriesPosition,
    description: o.description ?? m.description,
    coverPath: o.coverPath ?? m.coverPath,
  };
}

/**
 * The project's book variants + which one is primary.
 *
 * The audiobook is represented in exactly ONE place: as an audiobook variant.
 * To guarantee no audiobook is ever lost — including the case where a project
 * already has real ebook variants and THEN produces a TTS audiobook that only
 * lives in `outputs.audiobook` — this ALWAYS starts from the real
 * `manifest.variants` and then FOLDS IN every `outputs.audiobook` /
 * `outputs.bilingualAudiobooks[pair]` whose file isn't already present as a
 * variant (deduped by normalized path). A folded output whose path already
 * matches a real variant is skipped, so the real variant's id/descriptor/metadata
 * win.
 *
 * When there are no real variants at all (legacy projects), ebook variants are
 * additionally derived from archive[] so those projects behave like variant
 * projects without a destructive migration. The derived/folded set is persisted
 * only when the caller next mutates (they reassign `mf.variants = cur.variants`).
 */
export function getVariants(manifest: ProjectManifest): { variants: ProjectVariant[]; primaryVariantId?: string } {
  const m = manifest.metadata;
  const baseMeta = (): VariantMetadata => ({
    title: m.title, author: m.author, year: m.year, language: m.language,
    narrator: m.narrator, series: m.series, seriesPosition: m.seriesPosition,
    description: m.description, coverPath: m.coverPath,
  });

  // Dedupe audiobook outputs against real variants by file path (case/slash-insensitive).
  const normPath = (p: string): string =>
    (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

  const real = (manifest.variants && manifest.variants.length) ? manifest.variants : [];
  const variants: ProjectVariant[] = [...real];
  const seen = new Set<string>(real.map((v) => normPath(v.path)));

  // Ebook synthesis from archive ONLY when the project has no real variants yet
  // (legacy migration). Once a project has adopted real variants, its archive is
  // not re-materialized so an already-imported ebook isn't duplicated.
  if (real.length === 0) {
    for (const a of manifest.archive || []) {
      if (a.role === 'audiobook' || a.format === 'm4b') continue; // audio folded below
      const key = normPath(a.path);
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({
        id: `arch:${a.path}`,
        kind: 'ebook',
        format: a.format,
        path: a.path,
        descriptor: a.label || a.language,
        metadata: { ...baseMeta(), language: a.language ?? m.language },
        addedAt: a.archivedAt || manifest.createdAt,
      });
    }
  }

  // Fold the mono audiobook output. `outputs.audiobook` is AUTHORITATIVE for the
  // single 'audiobook' variant — registerAudiobookOutput rewrites it on every
  // (re)assembly. If a reassembly RENAMED the file (e.g. the output filename
  // gained an author/year suffix), an existing 'audiobook' variant still points
  // at the OLD path. Deduping only by path would then MISS the match and append a
  // SECOND 'audiobook' variant — same id, different path — yielding duplicate
  // cards, a colliding variant id, and a stale entry whose m4b/vtt no longer
  // exist (breaking audio + synced-text in the player). So when an 'audiobook'
  // variant already exists, reconcile its path + vttPath from outputs.audiobook
  // (keeping its descriptor/metadata) instead of pushing a duplicate. This
  // self-heals divergent manifests on read; the corrected set is persisted the
  // next time the caller writes `mf.variants = cur.variants`.
  const ab = manifest.outputs?.audiobook;
  if (ab?.path) {
    const abNorm = normPath(ab.path);
    const existingIdx = variants.findIndex((v) => v.id === 'audiobook' && v.kind === 'audiobook');
    if (existingIdx >= 0) {
      const existing = variants[existingIdx];
      if (normPath(existing.path) !== abNorm) {
        seen.delete(normPath(existing.path));
        variants[existingIdx] = { ...existing, path: ab.path, vttPath: ab.vttPath ?? existing.vttPath };
        seen.add(abNorm);
      }
    } else if (!seen.has(abNorm)) {
      seen.add(abNorm);
      variants.push({
        id: 'audiobook',
        kind: 'audiobook',
        format: 'm4b',
        path: ab.path,
        metadata: { ...baseMeta(), ...(m.audiobook || {}) }, // fold the interim override
        vttPath: ab.vttPath,
        addedAt: ab.completedAt || manifest.createdAt,
      });
    }
  }

  // Always fold every bilingual audiobook output not already present as a variant.
  const bi = manifest.outputs?.bilingualAudiobooks;
  if (bi) {
    for (const [langPair, out] of Object.entries(bi)) {
      const o = out as { path?: string; vttPath?: string; completedAt?: string };
      if (!o?.path || seen.has(normPath(o.path))) continue;
      seen.add(normPath(o.path));
      variants.push({
        id: `bilingual:${langPair}`,
        kind: 'audiobook',
        format: 'm4b',
        path: o.path,
        descriptor: langPair,
        metadata: baseMeta(),
        vttPath: o.vttPath,
        addedAt: o.completedAt || manifest.createdAt,
      });
    }
  }

  // Stamp the user-settable "professionally read" flag on every audiobook variant,
  // filling only a missing value so an explicit flag is never overwritten (via ??):
  //   • the 'audiobook' output variant → outputs.audiobook.professionallyRead, else
  //     default true for imports (source.type 'audiobook') and false otherwise.
  //   • bilingual variants → outputs.bilingualAudiobooks[pair].professionallyRead ?? false.
  //   • any other stored audiobook variant → v.professionallyRead ?? true (variant:add is
  //     user-supplied human audio). Ebook variants are left untouched.
  // Runs after both folds so it also covers synthesized variants that a prior mutation
  // persisted into manifest.variants before this field existed.
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (v.kind !== 'audiobook') continue;
    let professionallyRead: boolean;
    if (v.id === 'audiobook') {
      professionallyRead = ab?.professionallyRead ?? (manifest.source?.type === 'audiobook');
    } else if (v.id.startsWith('bilingual:')) {
      const pair = v.id.slice('bilingual:'.length);
      professionallyRead = manifest.outputs?.bilingualAudiobooks?.[pair]?.professionallyRead ?? false;
    } else {
      professionallyRead = v.professionallyRead ?? true;
    }
    variants[i] = { ...v, professionallyRead };
  }

  // Primary: keep the manifest's choice if it still resolves; otherwise prefer
  // the original ebook, else the first ebook, else the first variant.
  let primaryVariantId = manifest.primaryVariantId;
  if (!primaryVariantId || !variants.some((v) => v.id === primaryVariantId)) {
    const orig = (manifest.archive || []).find((a) => a.role === 'original' && a.format !== 'm4b');
    const origId = orig ? `arch:${orig.path}` : undefined;
    primaryVariantId = (origId && variants.some((v) => v.id === origId) ? origId : undefined)
      ?? variants.find((v) => v.kind === 'ebook')?.id
      ?? variants[0]?.id;
  }

  return { variants, primaryVariantId };
}

export async function registerAudiobookOutput(
  m4bAbsPath: string,
  opts?: { narrator?: string; professionallyRead?: boolean },
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const outputDir = path.dirname(m4bAbsPath);
  const projectDir = path.dirname(outputDir);
  const projectId = path.basename(projectDir);

  // Only register when the m4b lives under THIS library's projects dir, so the
  // projectId-based manifest lookup targets this project and never a wrong one.
  if (path.resolve(getProjectPath(projectId)) !== path.resolve(projectDir)) {
    return { success: false, skipped: true, error: `m4b not under library projects dir: ${m4bAbsPath}` };
  }

  const m4bRel = toManifestPath(projectId, m4bAbsPath);

  return modifyManifest(projectId, (manifest) => {
    if (!manifest.outputs) manifest.outputs = {};
    manifest.outputs.audiobook = {
      ...manifest.outputs.audiobook,
      path: m4bRel,
      completedAt: new Date().toISOString(),
      // Embed-only model: the transcript lives INSIDE the m4b (subtitle track), never
      // a sidecar. ALWAYS clear vttPath (undefined drops the key on serialize) — the
      // player extracts the embedded track directly. This deliberately does NOT adopt
      // any stray sidecar sitting next to the m4b (that was a mislink source).
      vttPath: undefined,
    };
    // Stamp the "professionally read" flag when the caller sets it. Spreading above
    // preserved any prior value, so an absent opt never clobbers a flag already
    // recorded on this output (only write when the opt is explicitly defined).
    if (opts?.professionallyRead !== undefined) manifest.outputs.audiobook.professionallyRead = opts.professionallyRead;
    // Record the TTS voice as this audiobook's narrator so the Versions "Narrator"
    // box can show who narrated it — durably, even after the sentence cache (which
    // also holds the voice) is deleted. Never overrides a narrator already set at
    // the project level or the audiobook override (user metadata / imported tag).
    const voice = (opts?.narrator || '').trim();
    if (voice && manifest.metadata && !manifest.metadata.narrator && !manifest.metadata.audiobook?.narrator) {
      if (!manifest.metadata.audiobook) manifest.metadata.audiobook = {};
      manifest.metadata.audiobook.narrator = voice;
    }
    delete manifest.sortOrder;  // Bump to top of "recent" sort (matches link-audio).
  });
}

/**
 * List all projects as summaries
 */
export async function listProjects(filter?: { type?: ProjectType }): Promise<ManifestListResult> {
  try {
    const projectsDir = getProjectsPath();

    // Ensure projects directory exists
    if (!fs.existsSync(projectsDir)) {
      await fs.promises.mkdir(projectsDir, { recursive: true });
      return { success: true, projects: [] };
    }

    const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    const projects: ProjectManifest[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(projectsDir, entry.name, MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const content = await fs.promises.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content) as ProjectManifest;

        // The folder name on disk is authoritative — use it as projectId so all
        // downstream fs.* calls resolve correctly on Windows (NTFS is normalization-
        // sensitive, and manifests written on macOS may store projectId in NFD form
        // while the folder on disk is NFC, or vice versa).
        manifest.projectId = normalizeFsPath(entry.name);

        // Apply filter
        if (filter?.type && manifest.projectType !== filter.type) {
          continue;
        }

        projects.push(manifest);
      } catch {
        // Skip invalid manifests
        console.warn(`[ManifestService] Invalid manifest in ${entry.name}`);
      }
    }

    // Sort by modification date (newest first)
    projects.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    return {
      success: true,
      projects,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get project summaries (lightweight, for list views)
 */
export async function listProjectSummaries(filter?: { type?: ProjectType }): Promise<{ success: boolean; summaries?: ProjectSummary[]; error?: string }> {
  const result = await listProjects(filter);
  if (!result.success || !result.projects) {
    return { success: false, error: result.error };
  }

  const summaries: ProjectSummary[] = result.projects.map(manifest => ({
    projectId: manifest.projectId,
    projectType: manifest.projectType,
    title: manifest.metadata.title,
    author: manifest.metadata.author,
    coverPath: manifest.metadata.coverPath,
    language: manifest.metadata.language,
    createdAt: manifest.createdAt,
    modifiedAt: manifest.modifiedAt,
    hasCleanup: manifest.pipeline.cleanup?.status === 'complete',
    hasTranslations: Object.entries(manifest.pipeline.translations || {})
      .filter(([_, stage]) => stage.status === 'complete')
      .map(([lang]) => lang),
    hasTTS: Object.entries(manifest.pipeline.tts || {})
      .filter(([_, stage]) => stage.status === 'complete')
      .map(([lang]) => lang),
    hasAudiobook: !!manifest.outputs.audiobook?.path,
    hasBilingualAudiobooks: Object.keys(manifest.outputs.bilingualAudiobooks || {}),
    sourceUrl: manifest.source.url,
    wordCount: manifest.metadata.wordCount,
  }));

  return { success: true, summaries };
}

/**
 * Delete a project
 */
export async function deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const projectDir = getProjectPath(projectId);

    if (!fs.existsSync(projectDir)) {
      return { success: false, error: `Project not found: ${projectId}` };
    }

    await fs.promises.rm(projectDir, { recursive: true, force: true });

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Copy a source file into a project's source folder
 */
export async function importSourceFile(
  projectId: string,
  sourcePath: string,
  targetFilename?: string
): Promise<{ success: boolean; relativePath?: string; error?: string }> {
  try {
    const filename = targetFilename || path.basename(sourcePath);
    const projectSourceDir = path.join(getProjectPath(projectId), 'source');
    const targetPath = path.join(projectSourceDir, filename);

    // Ensure source directory exists
    await fs.promises.mkdir(projectSourceDir, { recursive: true });

    // Atomic copy
    await atomicCopyFile(sourcePath, targetPath);

    // Return relative path for manifest
    return {
      success: true,
      relativePath: `source/${filename}`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Check if a project exists
 */
export function projectExists(projectId: string): boolean {
  return fs.existsSync(getManifestPath(projectId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rename a project folder to a new slug derived from metadata.
 * If the target already exists, appends a timestamp for uniqueness.
 * Returns the new absolute path of the project folder.
 */
export async function renameProjectFolder(
  currentPath: string,
  newSlug: string
): Promise<string> {
  const projectsDir = path.dirname(currentPath);
  let targetPath = path.join(projectsDir, newSlug);

  // If target already exists and isn't the same folder, append timestamp
  if (fs.existsSync(targetPath) && targetPath !== currentPath) {
    const timestamp = Date.now();
    targetPath = path.join(projectsDir, `${newSlug}_${timestamp}`);
  }

  // No-op if path didn't change
  if (targetPath === currentPath) {
    return currentPath;
  }

  await fs.promises.rename(currentPath, targetPath);
  const newProjectId = path.basename(targetPath);
  console.log(`[ManifestService] Renamed project folder: ${path.basename(currentPath)} → ${newProjectId}`);

  // Update projectId inside manifest.json to match the new folder name.
  // Without this, all subsequent saves via modifyManifest(projectId) would
  // write to a ghost folder at the old path instead of the renamed one.
  const manifestPath = path.join(targetPath, MANIFEST_FILENAME);
  // If this write fails, the folder is at the new name but manifest.projectId
  // still holds the old id — a split-brain state where later modifyManifest
  // calls recreate a ghost folder at the old path. Propagate the failure so
  // the rename is treated as not-fully-applied rather than silently succeeding.
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    if (manifest.projectId !== newProjectId) {
      manifest.projectId = newProjectId;
      await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`[ManifestService] Updated projectId in manifest: ${manifest.projectId}`);
    }
  } catch (err) {
    throw new Error(
      `Project folder was renamed to ${newProjectId} but its manifest projectId could not be updated: ${(err as Error).message}`,
    );
  }

  return targetPath;
}

/**
 * Compute a project folder slug from metadata fields.
 * Format: Title_-_Author_(Year), truncated to 150 chars.
 */
export function computeProjectSlug(title: string, author: string, year?: string): string {
  const cleanTitle = toAsciiSlug(title.replace(/\s+/g, '_'));
  const cleanAuthor = toAsciiSlug(author.replace(/\s+/g, '_'));
  const yearStr = year ? `_(${year})` : '';
  return toAsciiSlug(`${cleanTitle}_-_${cleanAuthor}${yearStr}`).substring(0, 150);
}

// ─────────────────────────────────────────────────────────────────────────────
// Archive Operations
// ─────────────────────────────────────────────────────────────────────────────

/** Characters unsafe for filenames on Windows/macOS/Linux */
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;

/**
 * Compute a descriptive filename from project metadata.
 * Format: "Title. LastName, FirstName. (Year).ext"
 * Omits author if missing/Unknown, omits year if missing.
 */
export function computeDescriptiveFilename(
  metadata: { title: string; author?: string; authorFileAs?: string; year?: string },
  ext: string
): string {
  // Ensure extension starts with a dot
  if (!ext.startsWith('.')) ext = '.' + ext;

  const title = metadata.title.trim();

  // Build author part: prefer authorFileAs ("Last, First"), else parse author
  let authorPart = '';
  const author = metadata.author?.trim();
  if (author && author !== 'Unknown') {
    if (metadata.authorFileAs) {
      authorPart = metadata.authorFileAs.trim();
    } else {
      // Try to parse "First Last" → "Last, First"
      const parts = author.split(/\s+/);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const first = parts.slice(0, -1).join(' ');
        authorPart = `${last}, ${first}`;
      } else {
        authorPart = author;
      }
    }
  }

  // Build filename: "Title. Author. (Year).ext" — year at the end. Each segment
  // adds its own leading ". " so there are never double periods when a part
  // (author or year) is absent.
  let name = title;
  if (authorPart) name += `. ${authorPart}`;
  if (metadata.year) name += `. (${metadata.year})`;

  // ASCII-sanitize the on-disk name (diacritics stripped, ß→ss) so it's safe and
  // normalization-proof on every platform. The file's EMBEDDED metadata keeps the
  // correct Unicode — only the filename is simplified.
  name = toAsciiFilename(name);
  // Collapse accidental double dots in the BASE (e.g. "Last, First M." author like
  // "Green, Simon R." + ". (Year)" → "…R.. (Year)"). Done before the extension so
  // the "." before the ext is never touched.
  name = collapseFilenameDots(name);
  name += ext;

  // Sanitize unsafe characters
  return name.replace(UNSAFE_FILENAME_CHARS, '_');
}

/**
 * Archive a file into a project's archive/ folder.
 * - Copies the file with a descriptive name (never moves/deletes)
 * - Never overwrites — appends timestamp on name collision
 * - Adds an ArchiveEntry to the manifest
 */
export async function archiveFile(
  projectId: string,
  sourcePath: string,
  options: {
    role: ArchiveEntry['role'];
    format: string;
    language?: string;
    label?: string;
    descriptiveFilename: string;
  }
): Promise<{ success: boolean; entry?: ArchiveEntry; error?: string }> {
  try {
    const archiveDir = path.join(getProjectPath(projectId), 'archive');
    await fs.promises.mkdir(archiveDir, { recursive: true });

    // Determine target filename — never overwrite
    let targetFilename = options.descriptiveFilename;
    let targetPath = path.join(archiveDir, targetFilename);

    if (fs.existsSync(targetPath)) {
      // Append timestamp before extension to avoid collision
      const ext = path.extname(targetFilename);
      const base = targetFilename.slice(0, -ext.length);
      const timestamp = Date.now();
      targetFilename = `${base}_${timestamp}${ext}`;
      targetPath = path.join(archiveDir, targetFilename);
    }

    // Atomic copy
    await atomicCopyFile(sourcePath, targetPath);

    // Get file size
    const stats = await fs.promises.stat(targetPath);

    const entry: ArchiveEntry = {
      path: `archive/${targetFilename}`,
      role: options.role,
      format: options.format,
      language: options.language,
      label: options.label,
      archivedAt: new Date().toISOString(),
      size: stats.size,
    };

    // Append entry to manifest. If this write fails (e.g. EBUSY on a synced
    // drive) the file is on disk but the archive entry never persists — an
    // orphan. Surface that instead of reporting success.
    const saved = await modifyManifest(projectId, (manifest) => {
      if (!manifest.archive) manifest.archive = [];
      manifest.archive.push(entry);
    });
    if (!saved.success) {
      return { success: false, error: `Archived file copied but manifest update failed: ${saved.error}` };
    }

    console.log(`[ManifestService] Archived file: ${targetFilename} (${options.role})`);
    return { success: true, entry };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * List archive entries from a project's manifest.
 */
export async function listArchive(projectId: string): Promise<{ success: boolean; entries?: ArchiveEntry[]; error?: string }> {
  try {
    const result = await getManifest(projectId);
    if (!result.success || !result.manifest) {
      return { success: false, error: result.error || 'Project not found' };
    }
    return { success: true, entries: result.manifest.archive || [] };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Staging Directory Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up old temp files in staging directory
 */
export async function cleanupStagingDir(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    if (!fs.existsSync(STAGING_DIR)) return;

    const now = Date.now();
    const entries = await fs.promises.readdir(STAGING_DIR, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(STAGING_DIR, entry.name);
      const stats = await fs.promises.stat(entryPath);

      if (now - stats.mtimeMs > maxAgeMs) {
        await fs.promises.rm(entryPath, { recursive: true, force: true });
        console.log(`[ManifestService] Cleaned up stale staging entry: ${entry.name}`);
      }
    }
  } catch (error) {
    console.warn('[ManifestService] Error cleaning staging dir:', error);
  }
}
