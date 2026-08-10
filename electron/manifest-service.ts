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
  NarrationFlags,
  AppliedPass,
  AppliedPassKind,
  LedgerEntry,
  GeneratedEpubOutput,
  BookFamily,
  EpubOutput,
  BookEdit,
  MergeChapterOpeningEdit,
  NameChapterOpenersEdit,
  StampElementIdsEdit,
  SetBlockCategoryEdit,
  SourceType,
} from './manifest-types.js';
import { passesAfterEpubEvent } from '../shared/document/pass-lifecycle';
import {
  describeLedgerDeletion,
  ledgerAfterDeleting,
  ledgerEntryRelDir,
  listLedgerLabels,
  type LedgerDeletion,
} from '../shared/document/book-ledger';
import {
  EDITOR_LAYOUT_MANIFEST_KEY,
  LAYOUT_KEYED_EDITOR_FIELDS,
  type EditorLayoutIdentity,
} from '../shared/document/editor-layout';
import {
  describeWorkingCopyRemint,
  type WorkingCopyRemint,
} from '../shared/document/working-copy-remint';
import {
  describeFamilies,
  familyOwnsPickerRecords,
  familyStem,
  resolveFamily,
} from '../shared/document/book-families';
// The picker's working state is a per-project SIDECAR, not a manifest key — see
// electron/editor-state-store.ts for why and for the precedence rule. That
// module imports `atomicWriteFile` back from here; the cycle is safe because
// neither module runs anything at load time and every use is inside a function.
import {
  adoptLegacyEditorKey,
  deleteEditorState,
  migrateEditorState,
  peekEditorState,
  readEditorState,
  stripEditorKey,
  updateEditorState,
  writeEditorState,
} from './editor-state-store.js';
import {
  migrateNarrationDeletionsForFold,
  narrationDeletionsStaleReason,
  narrationEpubRelPath,
  narrationFingerprintsFor,
  type NarrationDeletions,
  type NarrationDeletionsCarry,
  type NarrationEpubOutput,
} from '../shared/vlm/narration-deletions';

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
/**
 * Path for a staging temp file adjacent to `targetPath` (same directory, so the
 * publishing rename() is always same-filesystem and therefore atomic).
 *
 * The basename hint is TRUNCATED: Windows caps a single path COMPONENT at 255
 * characters regardless of long-path support, so `.${fullBasename}.${uuid}.tmp`
 * overflows for long book titles and the write fails with a confusing ENOENT.
 * (Real case: a ~240-char audiobook filename + 42 chars of decoration = 282.)
 * The uuid alone guarantees uniqueness; the hint only aids debugging.
 */
function stagingTempPath(targetPath: string): string {
  const hint = path.basename(targetPath).slice(0, 80);
  return path.join(path.dirname(targetPath), `.${hint}.${uuidv4()}.tmp`);
}

export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  // Ensure target directory exists
  const targetDir = path.dirname(targetPath);
  await fs.promises.mkdir(targetDir, { recursive: true });

  // Stage in the same directory so rename() is always atomic (same filesystem)
  const tempPath = stagingTempPath(targetPath);

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

  const tempPath = stagingTempPath(targetPath);

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
    // Same treatment for every path INSIDE the manifest — see normalizeManifestPaths.
    // Done on read as well as write so manifests already carrying NFD resolve now,
    // without waiting for something to write them back.
    normalizeManifestPaths(manifest);

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
/**
 * Keys whose STRING value is a filesystem path (or embeds one) and must be NFC.
 *
 * macOS APFS hands back NFD from readdir, so a path captured on the Mac is stored
 * decomposed. Windows NTFS is normalization-SENSITIVE: the same name in NFD simply
 * does not exist, so the entry becomes unreachable — an audiobook that will not play,
 * a PDF the app reports as missing — while the file sits right there on disk. The
 * library is synced Mac<->Windows, so this is a routine occurrence, not an edge case.
 * (Found 2026-07-25 in 7 projects / 11 paths, incl. an entire book's audiobook and
 * English PDF.) `path-utils.ts` already documented the class; it just was not applied
 * to the paths INSIDE a manifest.
 */
const NFC_PATH_KEYS = new Set([
  'path', 'vttPath', 'coverPath', 'primaryVariantId',
  'originalFilename', 'outputFilename', 'sentencePairsPath',
]);

/**
 * NFC-normalize every path-bearing string in a manifest, in place.
 *
 * `id` is normalized ONLY when it starts with `arch:`, because that id is literally
 * 'arch:' + the archive path — it has to keep matching both the archive entry and
 * primaryVariantId. Every other id is a UUID and must not be touched.
 */
export function normalizeManifestPaths(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeManifestPaths(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      if (NFC_PATH_KEYS.has(key) || (key === 'id' && value.startsWith('arch:'))) {
        const nfc = value.normalize('NFC');
        if (nfc !== value) obj[key] = nfc;
      }
    } else if (value && typeof value === 'object') {
      normalizeManifestPaths(value);
    }
  }
}

async function saveManifestImpl(manifest: ProjectManifest): Promise<ManifestSaveResult> {
  try {
    // Last line of defence: whatever the caller built, NFD never reaches the file.
    normalizeManifestPaths(manifest);
    // And the other last line of defence: `editor` is a sidecar file now, and no
    // manifest write may put it back. The callers below preserve the ON-DISK
    // copy before they get here, so anything still on the object at this point
    // came from a caller that has not been converted — dropped, and said so.
    stripEditorKey(manifest, 'saveManifest');
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
 *
 * The manifest handed in is a WHOLE object from somewhere else — usually a
 * renderer that fetched it earlier — so the file on disk is migrated first and
 * the caller's own `editor` key is then dropped by `saveManifestImpl`. Both
 * halves are needed: the migration is what saves a project whose editor state is
 * still in its manifest from being overwritten by this call, and the drop is
 * what stops a stale renderer from putting megabytes back.
 */
export async function saveManifest(manifest: ProjectManifest): Promise<ManifestSaveResult> {
  return acquireLock(manifest.projectId, async () => {
    await migrateEditorState(getProjectPath(manifest.projectId));
    return saveManifestImpl(manifest);
  });
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
    // The object just read IS the disk copy, so a legacy `editor` on it is the
    // authoritative one — move it to the sidecar HERE. Without this, the first
    // unrelated write to an unmigrated project (a finished audiobook, a tag)
    // would drop a book's entire editing history at `saveManifestImpl`.
    await adoptLegacyEditorKey(getProjectPath(projectId), result.manifest);
    await fn(result.manifest);
    return saveManifestImpl(result.manifest);
  });
}

/**
 * Update specific fields in a manifest (locked read-modify-write)
 */
export async function updateManifest(update: ManifestUpdate): Promise<ManifestSaveResult> {
  return modifyManifest(update.projectId, async (manifest) => {
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
      // The SAME merge as before — a partial update layered over what is stored —
      // but against the sidecar, which is where editor state lives. It runs
      // inside `modifyManifest`'s per-project lock, so it cannot interleave with
      // another update of the same project, and `adoptLegacyEditorKey` has
      // already put any pre-sidecar copy where this reads from.
      //
      // The one caller today is Studio's `updateArticle` (deletedSelectors,
      // undoStack, redoStack); its contract is unchanged.
      const patch = update.editor;
      await updateEditorState(
        getProjectPath(update.projectId),
        (state) => ({ ...state, ...patch }),
      );
    }
    if (update.projectType !== undefined) {
      // Re-classify a project as a book or an article. Every consumer — Studio's
      // two sections, the Bookshelf's Ebooks/Articles split, `listProjects({type})`
      // — reads this ONE field, so flipping it is the whole operation; nothing on
      // disk moves. Refuse an unknown value rather than storing a type that would
      // make the project vanish from both lists.
      if (update.projectType !== 'book' && update.projectType !== 'article') {
        throw new Error(`Invalid projectType: ${String(update.projectType)}`);
      }
      manifest.projectType = update.projectType;
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
 * which silently no-ops when the (re)assembly job has no project directory or the renderer never
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

// ─────────────────────────────────────────────────────────────────────────────
// The export EPUB — the project's converted book
//
// It is named after the book, so nothing can find it by name pattern any more.
// `manifest.outputs.epub` is the ONE authority on where it is; this section is
// the ONE place that derives the name, reads the record and writes it. Callers
// (main's IPC handlers, the renderer through them) never build the name.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportEpubLocation {
  /** Project-relative, forward slashes — what goes in the manifest. */
  relPath: string;
  /** Resolved against the project directory this was asked about. */
  absPath: string;
  /** The record's timestamp. Absent for a target that has not been written yet. */
  modifiedAt?: string;
}

/**
 * Strip a title down to something every filesystem accepts, keeping it readable.
 *
 * Windows-reserved characters and control characters go; whitespace collapses;
 * trailing dots and spaces go LAST and again after truncation, because Windows
 * silently drops them from a name — "Vol. " resolves to a DIFFERENT file there,
 * and the library is synced Mac<->Windows. Unicode and ordinary spaces stay:
 * this is the book's name, not a slug.
 */
function sanitizeExportStem(raw: string): string {
  const trimTail = (s: string): string => s.replace(/[. ]+$/, '');
  return trimTail(
    trimTail(
      raw
        .replace(/[\\/:*?"<>|]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    // 255 is the per-component cap on Windows regardless of long-path support;
    // leave room for `.epub` and for atomicWriteFile's staging decoration.
    ).slice(0, 180)
  );
}

/** The suffix that makes a file in `source/` the one file the user edits. */
export const WORKING_EPUB_SUFFIX = '.working.epub';

/**
 * The suffix that marks the book a page reader cast out of a PDF.
 *
 * It sits beside `.working.epub` and `.tts.epub` in `source/`, and the four
 * names read as one family: the file you handed us (`archive/<name>.pdf`), the
 * book cast from its pages (`<name>.generated.epub`), the file you edit
 * (`<name>.working.epub`), the file narration reads (`<name>.tts.epub`).
 */
export const GENERATED_EPUB_SUFFIX = '.generated.epub';

/**
 * The project's archive original — the file the user handed us, whatever format
 * it is in.
 *
 * `role: 'original'`, and an audiobook is not one: an m4b is a rendering of a
 * book rather than the book, and a project whose only archive entry is one has
 * no document to work from. Returns null rather than throwing, because "this
 * project has no archive original" is a real state (73 of the library's 378
 * projects are imported audiobooks, measured 2026-08-08) and the callers that
 * cannot proceed without one say so in their own words.
 */
function archiveOriginalEntry(manifest: ProjectManifest): ArchiveEntry | null {
  const entry = (manifest.archive ?? []).find(
    (a) => a.role === 'original' && (a.format || '').toLowerCase() !== 'm4b');
  return entry ?? null;
}

/**
 * Which format the archive original is in, lowercased, or null when there is
 * none. `pdf` and `epub` are the two the pipeline knows; anything else is a
 * format nothing here can open, and it is returned verbatim so a refusal can
 * name it.
 */
export async function archiveOriginalFormat(projectDir: string): Promise<string | null> {
  const manifest = await readManifestAt(projectDir);
  const entry = archiveOriginalEntry(manifest);
  if (entry) return (entry.format || '').toLowerCase();
  // The pre-archive layout: an EPUB project's original sat at `source/original.epub`
  // and no archive entry was written for it. It is the same fact in an older
  // place, not a second kind of answer.
  return fs.existsSync(path.join(projectDir, 'source', 'original.epub')) ? 'epub' : null;
}

/** Where the archive original is, and which format the user handed it over in. */
export interface ArchiveOriginalLocation {
  /** Project-relative, forward slashes — as the manifest records it. */
  relPath: string;
  absPath: string;
  /** Lowercased, verbatim from the record: `pdf`, `epub`, or something else. */
  format: string;
}

/**
 * WHERE the archive original is, for the surfaces that have to recognise it.
 *
 * `archiveOriginalFormat` answers what KIND of project this is; this answers
 * which file, because a window deciding whether the book on screen is the
 * untouchable original cannot do it by name. The manifest is where an artifact's
 * identity is settled (`exportEpubRelPath`, `generatedEpubRelPath`), and a
 * renderer matching `archive/` or an extension would be a second derivation of
 * it — which is exactly how one file comes to be read as two different artifacts
 * by two different panels.
 *
 * Existence on disk is deliberately NOT checked here, matching `readExportEpub`
 * and `readGeneratedEpub`: the record is the answer, and a record whose file has
 * gone is a state the caller has to be able to see rather than have collapsed
 * into "there is none".
 */
export async function readArchiveOriginal(
  projectDir: string
): Promise<ArchiveOriginalLocation | null> {
  const manifest = await readManifestAt(projectDir);
  const entry = archiveOriginalEntry(manifest);
  if (entry?.path) {
    return {
      relPath: entry.path,
      absPath: toAbs(projectDir, entry.path),
      format: (entry.format || '').toLowerCase(),
    };
  }
  // The pre-archive layout, which `archiveOriginalFormat` already treats as the
  // same fact in an older place: an EPUB project's original sat at
  // `source/original.epub` with no archive entry written for it.
  const legacyRel = 'source/original.epub';
  const legacyAbs = toAbs(projectDir, legacyRel);
  if (fs.existsSync(legacyAbs)) {
    return { relPath: legacyRel, absPath: legacyAbs, format: 'epub' };
  }
  return null;
}

/**
 * The working copy's filename stem: THE ARCHIVE FILE'S OWN BASENAME.
 *
 * ── Why the archive's name and not the book's title ─────────────────────────
 *
 * Owen, 2026-08-08: "one working copy per archive file… the filename is a
 * sidecar declaration of which archive file it belongs to — nothing anonymous."
 * `<archive basename>.working.epub` sits in `source/` beside
 * `<archive basename>.tts.epub`, and the three names read as one family: the
 * file you handed us, the file you edit, the file narration reads.
 *
 * This REPLACES a derivation that took `manifest.source.originalFilename` and
 * fell back to the title. That name was not wrong, it was just unattached: the
 * library holds projects where the recorded source filename and the file in
 * `archive/` differ (Killing America's archive is "Killing America. Bailey,
 * Gene.epub" while its recorded source filename is the full subtitled one), so
 * the book on disk did not say which archive file it came out of. Now it does.
 *
 * NOT sanitized and NOT truncated. The stem is the name of a file that already
 * exists on this filesystem, so it is already legal; passing it through the
 * sanitizer would invent a second name for the same thing, and truncating it
 * would silently point the working copy at a different archive file than the one
 * it claims. The length is CHECKED instead — see below.
 */
export function workingEpubStem(manifest: ProjectManifest): string {
  const entry = archiveOriginalEntry(manifest);
  const fromArchive = entry ? path.basename(entry.path).replace(/\.[^./\\]+$/, '') : '';
  if (fromArchive) return fromArchive;

  // The pre-archive layout again: `source/original.epub` is the original, and
  // its basename is "original", which names nothing. Such a project has no
  // archive file to declare, so the recorded source filename is what it is
  // about — sanitized, because unlike a real basename it has never had to be a
  // legal filename.
  const recorded = sanitizeExportStem(
    (manifest.source?.originalFilename ?? '').replace(/\.[^./\\]+$/, ''));
  if (recorded) return recorded;

  throw new Error(
    `Project ${manifest.projectId || '(no id)'} has no archive original and no recorded source `
    + 'filename, so its working copy cannot be named after anything. Re-import the book.'
  );
}

/**
 * The 255-character cap is on ONE PATH COMPONENT, on every Windows filesystem,
 * regardless of long-path support — and a write over it fails as ENOENT, which
 * reads as "the folder is missing" and sends whoever hits it looking in the
 * wrong place entirely.
 *
 * So it is measured here and refused by name. Truncating instead is the one
 * thing that must not happen: `<archive basename>.working.epub` is a claim about
 * which archive file this is the working copy OF, and a shortened claim points
 * at a file that may not be the one.
 */
function requireLegalComponent(component: string, manifest: ProjectManifest): string {
  if (component.length <= 255) return component;
  throw new Error(
    `${manifest.projectId || '(no id)'}'s working copy would be called "${component}", which is `
    + `${component.length} characters — a filename may be at most 255 on this filesystem, and a `
    + 'longer one fails as a missing-folder error rather than a naming one. Rename the file in '
    + `archive/ to something shorter (at most ${255 - WORKING_EPUB_SUFFIX.length} characters before `
    + 'its extension) and open the book again.'
  );
}

/**
 * Where the project's working copy lives: `source/<archive basename>.working.epub`.
 *
 * ONE derivation, and every writer of the book goes through it — the EPUB
 * projects that copy their original, `foundry vlm-convert` writing a PDF's pages
 * out as a book, and the picker's own reflow export. That is what makes "the
 * working copy" a thing the user can point at rather than whichever of several
 * files happened to be written last.
 */
export function exportEpubRelPath(manifest: ProjectManifest): string {
  const component = requireLegalComponent(
    `${workingEpubStem(manifest)}${WORKING_EPUB_SUFFIX}`, manifest);
  return `source/${component}`;
}

/**
 * Where a FAMILY's working copy lives: `source/<family stem>.working.epub`.
 *
 * The per-chain form of `exportEpubRelPath` above, and the one every mint uses
 * now. The stem comes from the family's own SOURCE rather than from the
 * project's archive original (`familyStem`, shared/document/book-families.ts),
 * which is what lets two chains in one project have two working copies that each
 * declare which book they are a copy of.
 *
 * For a project's FIRST family the two derivations agree by construction — that
 * family's source IS the archive original, or the book cast from it — which is
 * why the migration renames nothing.
 */
export function familyEpubRelPath(family: BookFamily, manifest: ProjectManifest): string {
  const component = requireLegalComponent(
    `${familyStem(family.source)}${WORKING_EPUB_SUFFIX}`, manifest);
  return `source/${component}`;
}

/** Read a manifest straight off disk — works for a directory the library doesn't own. */
async function readManifestAt(projectDir: string): Promise<ProjectManifest> {
  const raw = await fs.promises.readFile(path.join(projectDir, MANIFEST_FILENAME), 'utf-8');
  const manifest = JSON.parse(raw) as ProjectManifest;
  if (manifest.projectId) manifest.projectId = normalizeFsPath(manifest.projectId);
  normalizeManifestPaths(manifest);
  return manifest;
}

/**
 * The projectId whose manifest.json IS this directory's, refusing anything else.
 *
 * Every write here goes through modifyManifest, which locates the file from the
 * projectId alone. A directory the library does not own would send the write to
 * a different manifest — or to none — so it is named and refused instead.
 */
function requireLibraryProjectId(projectDir: string, manifest: ProjectManifest): string {
  const projectId = manifest.projectId || path.basename(projectDir);
  const expected = path.resolve(getProjectPath(projectId));
  if (expected !== path.resolve(projectDir)) {
    throw new Error(
      `Cannot record the export for ${projectDir}: its manifest belongs to ${expected}, `
      + 'which is not the same directory. Point the library setting at the folder that owns this project.'
    );
  }
  return projectId;
}

function toAbs(projectDir: string, relPath: string): string {
  return path.join(projectDir, relPath.split('/').join(path.sep));
}

/**
 * Where the NEXT export must be written — derived from the manifest, always.
 *
 * Deliberately NOT the recorded path: a book retitled since its last export gets
 * the new name, and registerEpubExport removes the superseded file.
 */
export async function exportEpubTarget(
  projectDir: string,
  familyId?: string
): Promise<ExportEpubLocation> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const relPath = familyEpubRelPath(family, manifest);
  return { relPath, absPath: toAbs(projectDir, relPath) };
}

/**
 * Where the project's export EPUB IS, or null when it has never been exported.
 *
 * THE RECORD IS THE ONLY ANSWER. No record means the project has no book EPUB,
 * full stop — a `source/exported.epub` from before the rename is a stray file
 * this does not see, does not adopt, and does not complain about. Nothing on
 * disk is renamed, moved or deleted to reach an answer here.
 *
 * (An earlier build migrated the old name on the way past. It was removed
 * deliberately: the library is being re-run through the new pipeline, which
 * writes the record, and a migration that touches a user's files to save them a
 * re-run is a trade nobody asked for.)
 */
export async function readExportEpub(
  projectDir: string,
  familyId?: string
): Promise<ExportEpubLocation | null> {
  // Through the LISTING resolver: this is a READ whose null already means "the
  // project has no book", and a project with no working chain yet is exactly
  // that. Routing it through the act chokepoint made OPENING a bare-PDF project
  // fail with the chain refusal (found live 2026-08-10, the cleared-library
  // sweep made such projects common). A caller that names a familyId still gets
  // the refusal for a chain that is not there; acts that need the book to exist
  // resolve through requireFamilyEpub / requireFamilySource and keep refusing.
  const resolved = await familyForListing(projectDir, familyId);
  const recorded = resolved?.family.epub;
  if (!recorded?.path) return null;
  return { relPath: recorded.path, absPath: toAbs(projectDir, recorded.path), modifiedAt: recorded.modifiedAt };
}

/**
 * Where a cast book is written: `source/<archive basename>.generated.epub`.
 *
 * Same stem as the working copy and derived through the same
 * `requireLegalComponent` check, because it is a declaration of the same thing —
 * which archive file this book came out of.
 */
export function generatedEpubRelPath(manifest: ProjectManifest): string {
  const component = requireLegalComponent(
    `${workingEpubStem(manifest)}${GENERATED_EPUB_SUFFIX}`, manifest);
  return `source/${component}`;
}

/** Where the NEXT cast must write its book — derived from the manifest, always. */
export async function generatedEpubTarget(projectDir: string): Promise<ExportEpubLocation> {
  const manifest = await readManifestAt(projectDir);
  const relPath = generatedEpubRelPath(manifest);
  return { relPath, absPath: toAbs(projectDir, relPath) };
}

/** Where the generated book is, and what kind of bytes they are. */
export interface GeneratedEpubLocation extends ExportEpubLocation {
  origin: GeneratedEpubOutput['origin'];
  sha256: string;
}

/**
 * The project's generated book, or null when it has none.
 *
 * THE RECORD IS THE ONLY ANSWER, exactly as it is for `outputs.epub`: a
 * `.generated.epub` in `source/` that nothing records is a stray, not this
 * project's generated original. Existence on disk is a SEPARATE question, asked
 * by the callers that need the file rather than the record — a record whose file
 * has gone is a state somebody has to be told about, and collapsing it into
 * "there is none" is how it would be silently replaced instead.
 */
export async function readGeneratedEpub(projectDir: string): Promise<GeneratedEpubLocation | null> {
  const manifest = await readManifestAt(projectDir);
  const recorded = manifest.outputs?.generatedEpub;
  if (!recorded?.path) return null;
  return {
    relPath: recorded.path,
    absPath: toAbs(projectDir, recorded.path),
    modifiedAt: recorded.modifiedAt,
    origin: recorded.origin,
    sha256: recorded.sha256,
  };
}

/**
 * Record a written generated book as `outputs.generatedEpub`.
 *
 * The sha256 is measured HERE, off the file that was just written, rather than
 * accepted from the caller: it is what every working copy minted from this book
 * is proved against, and a digest somebody handed us is a claim about bytes
 * rather than a measurement of them.
 *
 * Unlike `registerEpubExport` this ends nothing. The generated book has no
 * provenance of its own — it IS the provenance, the one act that produced it is
 * recorded against the working copy minted from it — and it supersedes nothing,
 * because nothing has ever been applied to it.
 */
export async function registerGeneratedEpub(
  projectDir: string,
  epubAbsPath: string,
  origin: GeneratedEpubOutput['origin']
): Promise<GeneratedEpubLocation> {
  const manifest = await readManifestAt(projectDir);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const rel = path.relative(projectDir, epubAbsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Cannot record ${epubAbsPath} as ${projectDir}'s generated book: it lies outside the project `
      + 'directory.'
    );
  }
  const relPath = rel.split(path.sep).join('/');
  const sha256 = await sha256Of(epubAbsPath);
  const modifiedAt = new Date().toISOString();

  const saved = await modifyManifest(projectId, (m) => {
    if (!m.outputs) m.outputs = {};
    m.outputs.generatedEpub = { path: relPath, modifiedAt, sha256, origin };
    // ── The chain hanging off this book learns the new digest, here ──────────
    //
    // A re-cast writes different bytes to the same path, and the family's
    // `source.sha256` is what says which book its working copy is a copy OF. In
    // the same transaction as the record it describes, because a family stamped
    // with the previous cast is a claim that the copy beside it was proved
    // against bytes nobody has any more.
    for (const family of m.families ?? []) {
      if (family.source.path === relPath) family.source.sha256 = sha256;
    }
  });
  if (!saved.success) {
    throw new Error(
      `The generated book is at ${relPath}, but recording it in ${projectDir}'s manifest failed: `
      + `${saved.error}. Nothing may mint a working copy from a book the project does not record.`
    );
  }
  // A PDF project's FIRST cast is also the moment it becomes able to have a
  // chain at all — until now `classifyWorkingCopySource` refused it, having
  // nothing archive-grade to hang one off. Idempotent for every later cast.
  await ensureBookFamilies(projectDir);
  return { relPath, absPath: epubAbsPath, modifiedAt, sha256, origin };
}

/**
 * Forget the project's generated book — the record only; the file is the
 * caller's act, done after this returns.
 *
 * Records first, file last, the same ordering `forgetEpubExport` uses and for
 * the same reason: an unrecorded stray is invisible to every consumer, while a
 * record naming a file that is gone is what makes a versions page offer to mint
 * a working copy from nothing.
 */
export async function forgetGeneratedEpub(projectDir: string): Promise<GeneratedEpubLocation> {
  const manifest = await readManifestAt(projectDir);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const record = manifest.outputs?.generatedEpub;
  if (!record?.path) {
    throw new Error(
      `${path.basename(projectDir)} has no outputs.generatedEpub, so there is no generated book to `
      + 'delete. The record is the only thing that says a project has one.'
    );
  }
  const answer: GeneratedEpubLocation = {
    relPath: record.path,
    absPath: toAbs(projectDir, record.path),
    modifiedAt: record.modifiedAt,
    origin: record.origin,
    sha256: record.sha256,
  };
  const saved = await modifyManifest(projectId, (m) => {
    if (m.outputs) delete m.outputs.generatedEpub;
  });
  if (!saved.success) {
    throw new Error(
      `Could not forget ${record.path} in ${path.basename(projectDir)}'s manifest: ${saved.error}. `
      + 'Nothing was deleted.'
    );
  }
  return answer;
}

/** One chain removed with the cast it hung off, and what its records still vouched for. */
export interface RemovedGeneratedChain {
  id: string;
  /** The source basename the chain's custody was stated in. */
  sourceName: string;
  /**
   * Absolute paths of any book / narration copy the chain still recorded when it
   * went. The records die with the family in the same transaction; the FILES are
   * the caller's act, after this returns — records first, files last.
   */
  epubAbsPath: string | null;
  ttsAbsPath: string | null;
}

/**
 * Remove every working chain that hangs off the project's generated book.
 *
 * The other half of deleting the cast, and the reason it exists: a family whose
 * `source` is the generated book describes where its working copies come FROM,
 * so a cast deleted out from under it leaves a chain whose source cannot exist —
 * exactly the state `classifyRecordedFamilySource` refuses by name (found live
 * 2026-08-10: deleting the generated book left the versions page refusing the
 * whole project). Chains sourced on an archive EPUB the user handed us are not
 * touched; the cast was never their source.
 *
 * Must be called while `outputs.generatedEpub` still stands — the record is the
 * only thing that says which file the chains hang off.
 */
export async function removeGeneratedBookFamilies(
  projectDir: string
): Promise<RemovedGeneratedChain[]> {
  const manifest = await readManifestAt(projectDir);
  const projectId = requireLibraryProjectId(projectDir, manifest);
  const record = manifest.outputs?.generatedEpub;
  if (!record?.path) {
    throw new Error(
      `${path.basename(projectDir)} has no outputs.generatedEpub, so there is no cast to remove `
      + 'chains for. Call this before the generated book is forgotten, not after.'
    );
  }

  const removed: RemovedGeneratedChain[] = [];
  const saved = await modifyManifest(projectId, (m) => {
    // The callback can be re-run against a re-read manifest; the answer is
    // whatever the LAST run measured, never an accumulation across runs.
    removed.length = 0;
    const families = m.families ?? [];
    const kept: BookFamily[] = [];
    for (const family of families) {
      if (family.source.kind !== 'generated-epub' || family.source.path !== record.path) {
        if (family.source.kind === 'generated-epub') {
          // A chain claiming a generated source that is not THE generated book —
          // a state nothing writes (one cast per project). Left alone and said
          // out loud rather than swept up on a guess.
          console.warn(
            `[manifest-service] ${path.basename(projectDir)}: chain ${family.id} names generated `
            + `source ${family.source.path}, but the project's cast is ${record.path}; not removed.`
          );
        }
        kept.push(family);
        continue;
      }
      removed.push({
        id: family.id,
        sourceName: path.basename(family.source.path),
        epubAbsPath: family.epub?.path ? toAbs(projectDir, family.epub.path) : null,
        ttsAbsPath: family.ttsEpub?.path ? toAbs(projectDir, family.ttsEpub.path) : null,
      });
    }
    m.families = kept;
  });
  if (!saved.success) {
    throw new Error(
      `Could not remove ${path.basename(projectDir)}'s cast-sourced chains: ${saved.error}. `
      + 'Nothing was deleted — the generated book and its chains still stand.'
    );
  }
  return removed;
}

/** What a naming migration did, so a caller can say it once on the console. */
export interface WorkingEpubRenameSummary {
  /** The book's path before and after, project-relative. Null when nothing moved. */
  from: string | null;
  to: string | null;
  /** The narration copy's, when it moved with the book. */
  ttsFrom: string | null;
  ttsTo: string | null;
}

/**
 * Rename this project's book to the working-copy convention, if it is not
 * already there.
 *
 * ── Why a migration, and why here ───────────────────────────────────────────
 *
 * The book used to be named after the recorded source filename or the title, and
 * the library has four of those on disk (measured 2026-08-08: 4 of 378 projects
 * have an `outputs.epub`, none already named `.working.epub`). The name is now a
 * DECLARATION — `<archive basename>.working.epub` says which archive file this
 * is the editable copy of — and a declaration only means something if every book
 * makes it. So the file is renamed the next time anything resolves it, and the
 * manifest is repointed in the same act.
 *
 * ── The narration copy moves with it ────────────────────────────────────────
 *
 * `<stem>.tts.epub` is named FROM the book, so leaving it behind would strand a
 * file named after a book that no longer exists under that name — the exact
 * anonymity this convention removes. It is renamed too when the project has one,
 * and its record is repointed with the book's. If it is missing from disk the
 * record still moves: the next export writes the new name, and a record pointing
 * at where the file WILL be is better than one pointing at a name nothing
 * produces any more.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * It never overwrites. A target that already exists is a project that has both
 * names on disk, and picking one for the user would delete a book; it stops and
 * says so. And it never renames a file it cannot find — a record pointing at a
 * deleted book is left exactly as it is, because that is `ensureBookEpub`'s
 * problem and it has its own sentence for it.
 */
export async function migrateWorkingEpubNaming(
  projectDir: string,
  familyId?: string
): Promise<WorkingEpubRenameSummary> {
  const nothing: WorkingEpubRenameSummary = { from: null, to: null, ttsFrom: null, ttsTo: null };
  const { manifest, family } = await requireFamily(projectDir, familyId);

  const recorded = family.epub?.path;
  if (!recorded) return nothing;
  const targetRel = familyEpubRelPath(family, manifest);
  if (recorded === targetRel) return nothing;

  const fromAbs = toAbs(projectDir, recorded);
  const toAbsPath = toAbs(projectDir, targetRel);
  if (!fs.existsSync(fromAbs)) return nothing;
  if (fs.existsSync(toAbsPath)) {
    throw new Error(
      `${path.basename(projectDir)} has both ${recorded} and ${targetRel} on disk. The second is `
      + 'the name this project\'s book should have, and renaming the first onto it would destroy '
      + 'whichever of the two is the real one. Delete the copy you do not want, then open the book '
      + 'again.'
    );
  }

  // The narration copy is resolved BEFORE the book moves, because its name is
  // derived from the book's — asking afterwards would derive it from the new name
  // and find nothing.
  const ttsRecorded = family.ttsEpub?.path ?? null;
  const ttsTargetRel = narrationEpubRelPath(targetRel);

  await fs.promises.rename(fromAbs, toAbsPath);
  let ttsMoved = false;
  if (ttsRecorded !== null && ttsRecorded !== ttsTargetRel) {
    const ttsFromAbs = toAbs(projectDir, ttsRecorded);
    const ttsToAbs = toAbs(projectDir, ttsTargetRel);
    if (fs.existsSync(ttsFromAbs) && !fs.existsSync(ttsToAbs)) {
      await fs.promises.rename(ttsFromAbs, ttsToAbs);
    }
    ttsMoved = true;
  }

  const projectId = requireLibraryProjectId(projectDir, manifest);
  const saved = await modifyManifest(projectId, (m) => {
    // The record is repointed IN PLACE — `registerEpubExport` is deliberately not
    // used, because that call means "the book has been rebuilt" and drops the
    // applied passes, the narration strikes and the pass diffs with it. Nothing
    // has been rebuilt here: the same bytes have a truer name.
    const target = familyIn(m, family.id);
    if (target.epub) target.epub.path = targetRel;
    if (target.ttsEpub && ttsMoved) target.ttsEpub.path = ttsTargetRel;
  });
  if (!saved.success) {
    throw new Error(
      `${path.basename(projectDir)}'s book was renamed to ${targetRel} but the manifest could not `
      + `be repointed at it: ${saved.error}. The file is where the new name says; fix the manifest `
      + 'and open the book again.'
    );
  }

  console.log(
    `[manifest-service] ${path.basename(projectDir)}: ${recorded} -> ${targetRel}`
    + (ttsMoved ? ` (and ${ttsRecorded} -> ${ttsTargetRel})` : '')
  );
  return {
    from: recorded,
    to: targetRel,
    ttsFrom: ttsMoved ? ttsRecorded : null,
    ttsTo: ttsMoved ? ttsTargetRel : null,
  };
}

/**
 * The project's source original, when it is an EPUB.
 *
 * Two recorded locations, because two import eras wrote them: today's importer
 * copies the pristine file into `archive/` and records it in `manifest.archive`
 * with `role: 'original'`, and projects imported before that have
 * `source/original.epub`. Both are THE ORIGINAL — this is one question with two
 * answers on disk, not a fallback ladder — and either way the file is read-only
 * from here on.
 */
async function sourceOriginalEpub(
  projectDir: string,
  manifest: ProjectManifest
): Promise<string | null> {
  const archived = (manifest.archive ?? []).find(
    (a) => a.role === 'original' && (a.format || '').toLowerCase() === 'epub');
  if (archived?.path) {
    const abs = toAbs(projectDir, archived.path);
    if (fs.existsSync(abs)) return abs;
  }
  const legacy = path.join(projectDir, 'source', 'original.epub');
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** The archive-grade EPUB a project's working copy is minted from. */
export interface WorkingCopySource {
  absPath: string;
  /**
   * Which archive-grade book this is.
   *
   *  - `archive-epub` — the file the user handed us, in `archive/` (or, for a
   *    project from the pre-archive era, `source/original.epub`).
   *  - `generated-epub` — the book a page reader cast from the user's PDF.
   *
   * Nothing here may ever be written to. The kind travels because the surfaces
   * that talk about erasing changes have to name the book the user lands on, and
   * "your original" and "the book cast from your pages" are different sentences.
   */
  kind: 'archive-epub' | 'generated-epub';
}

/** The source, or the sentence saying why this project has none. Never both. */
type WorkingCopySourceAnswer =
  | { source: WorkingCopySource; refusal: null }
  | { source: null; refusal: string };

/**
 * Which file this project's working copy is a copy OF — decided by what the
 * ARCHIVE ORIGINAL IS, never by looking for whichever EPUB happens to be around.
 *
 * ── A classification, not a ladder ──────────────────────────────────────────
 *
 * Two kinds of project, and the archive original's format says which:
 *
 *  - Its original is an EPUB. The working copy is a copy of that file, and the
 *    project has no generated book because nothing generated one.
 *  - Its original is a PDF. The working copy is a copy of the book cast from its
 *    pages, and the project has no archive EPUB because the user never handed us
 *    one.
 *
 * The two are exclusive by construction, so this asks the format first and then
 * demands exactly one answer. Falling from one to the other would be a fallback
 * in the precise sense the house rule forbids: a project whose archive EPUB has
 * been moved away would silently start minting from something else, and every
 * record keyed to the original's bytes would then describe the wrong book.
 *
 * Every refusal is a whole sentence naming what is missing, because the callers
 * are a button the user just pressed and a project the user just opened.
 */
async function classifyWorkingCopySource(
  projectDir: string
): Promise<WorkingCopySourceAnswer> {
  const manifest = await readManifestAt(projectDir);
  const format = await archiveOriginalFormat(projectDir);

  if (format === 'epub') {
    const archived = await sourceOriginalEpub(projectDir, manifest);
    if (archived) return { source: { absPath: archived, kind: 'archive-epub' }, refusal: null };
    return {
      source: null,
      refusal: 'Its archive original is an EPUB, and that file is not in the project, so there is '
        + 'nothing to copy. Restore it from your backup or re-import the book.',
    };
  }

  if (format === 'pdf') {
    const generated = await readGeneratedEpub(projectDir);
    if (generated === null) {
      return {
        source: null,
        refusal: 'Its pages have not been read into a book yet, and a PDF reaches an editable book '
          + 'only through Convert to EPUB. Run that over it first.',
      };
    }
    if (!fs.existsSync(generated.absPath)) {
      return {
        source: null,
        // NOT answered by adopting the working copy instead. That copy has been
        // edited since it was cast, so treating it as the generated original
        // would quietly redefine "erase all changes" as "go back to whatever the
        // book said when its cast went missing".
        refusal: `Its generated book is recorded as ${generated.relPath}, and that file is not `
          + 'there. Only a fresh Convert to EPUB can make one — the working copy beside it has been '
          + 'edited since it was cast and is not the same book.',
      };
    }
    return { source: { absPath: generated.absPath, kind: 'generated-epub' }, refusal: null };
  }

  if (format === null) {
    return {
      source: null,
      refusal: 'It has no archive original — nothing was imported into it that a book could be '
        + 'made from.',
    };
  }
  return {
    source: null,
    refusal: `Its archive original is a ${format}, which nothing here can turn into a book.`,
  };
}

/**
 * The archive-grade EPUB this project's working copy comes from, or null.
 *
 * Null is a real state and the callers that use this form of the question treat
 * it as one: a project opening does not mint a working copy it has no source
 * for, and says nothing about it. The callers that were ASKED to mint use
 * `requireWorkingCopySource` and get the sentence.
 */
export async function workingCopySource(projectDir: string): Promise<WorkingCopySource | null> {
  return (await classifyWorkingCopySource(projectDir)).source;
}

// ─────────────────────────────────────────────────────────────────────────────
// The FAMILIES — one working chain per archive-grade EPUB
//
// `manifest.families` is the authority on every book a project has and on
// everything derived from each. The rules about identity are pure and live in
// shared/document/book-families.ts; this is where they meet the disk.
//
// EVERY reader and writer below goes through `requireFamily`. That is the whole
// mechanism: a project with one chain answers unambiguously, a project with
// several refuses unless the caller says which, and there is no third path in
// which something picks one.
// ─────────────────────────────────────────────────────────────────────────────

/** The project's working chains, in the order they were minted. */
export async function readBookFamilies(projectDir: string): Promise<BookFamily[]> {
  return (await readManifestAt(projectDir)).families ?? [];
}

/**
 * A family id: `fam-` and eight hex characters, from the same RNG the ledger
 * mints entry ids with.
 *
 * Not derived from the source path, the title, or a counter. See
 * `FamilyIdentity.id` for why — a name derived from a file is a name that
 * changes when the file is renamed, and every record keyed to the old one is
 * then orphaned in place.
 */
function mintFamilyId(): string {
  return `fam-${crypto.randomBytes(4).toString('hex')}`;
}

/** A family and the manifest it was read from, so a caller reads the file once. */
export interface ResolvedFamily {
  manifest: ProjectManifest;
  family: BookFamily;
}

/**
 * THE CHOKEPOINT. Which family this call is about, or a refusal that names the
 * alternatives.
 *
 * Every reader and writer of a book's records goes through here, and that is
 * what makes the ambiguity rule a property of the model rather than a habit of
 * its callers. The refusal sentences are `resolveFamily`'s, written once where
 * they can be tested without a project.
 */
export async function requireFamily(
  projectDir: string,
  familyId?: string
): Promise<ResolvedFamily> {
  let manifest = await readManifestAt(projectDir);

  // ── The migration happens HERE, at the one door everything comes through ───
  //
  // A project that predates chains has its book at the legacy record, and it has
  // to become a chain before anything can be asked about it. Doing that at the
  // chokepoint rather than at two or three "open" handlers is what makes it
  // total: the library has ~385 projects and dozens of paths that reach a book
  // (a listing, a narration state, a chapter rename), and a normalization only
  // some of them trigger is one that leaves the rest refusing a project that
  // used to work.
  //
  // A write from a read is deliberate, and has precedent alongside
  // `migrateWorkingEpubNaming` and `ensureGeneratedEpub` — a one-time
  // normalization happens the next time anything asks about the project, or it
  // never happens at all. It costs nothing once done: the check is on the
  // manifest already in hand.
  let adoptionRefusal: string | null = null;
  if ((manifest.families ?? []).length === 0) {
    adoptionRefusal = (await ensureBookFamilies(projectDir)).refusal;
    manifest = await readManifestAt(projectDir);
  }

  // ── The migration's own sentence wins, when it has one ────────────────────
  //
  // `resolveFamily` can only say "this project has no working chain", which is
  // true and useless: it does not say WHY, and every why is a different thing
  // for the user to do — read this PDF's pages, restore an EPUB you moved,
  // re-import a book whose original was never recorded. `ensureBookFamilies`
  // knows which, having just tried; discarding that for the generic line would
  // turn an actionable refusal into a dead end.
  if ((manifest.families ?? []).length === 0 && adoptionRefusal !== null) {
    throw new Error(adoptionRefusal);
  }

  const answer = resolveFamily(manifest.families ?? [], familyId, path.basename(projectDir));
  if (answer.refusal !== null) throw new Error(answer.refusal);
  return { manifest, family: answer.family };
}

/**
 * The family a LISTING is about, or null when the project simply has no working
 * chain yet.
 *
 * `requireFamily` is for ACTS, and its refusal is the right answer there: a
 * pass, a narration cut, an export each need a book to be about. A listing —
 * "what has been done to this book", "what would a reset remove" — has a
 * truthful answer for a project with no chain: nothing. Routing listings
 * through the act's refusal paints an ordinary project (a PDF nobody has
 * converted yet) as a broken record — the versions page drew "The record of
 * what's been done to this book could not be read" in red over exactly that
 * state, which `FamiliesAdoption.refusal` documents as NOT an exception.
 *
 * Null ONLY when no chain exists, none can be minted, and none was asked for
 * by name. A caller that names a family is asking about a specific chain, and
 * a named chain that is not there is still an error — `requireFamily`'s, with
 * its alternatives.
 */
export async function familyForListing(
  projectDir: string,
  familyId?: string
): Promise<ResolvedFamily | null> {
  if (familyId === undefined) {
    const manifest = await readManifestAt(projectDir);
    if ((manifest.families ?? []).length === 0
      && (await ensureBookFamilies(projectDir)).refusal !== null) {
      return null;
    }
  }
  return requireFamily(projectDir, familyId);
}

/**
 * The same family, located inside a manifest a `modifyManifest` callback is
 * holding — by ID, never by position.
 *
 * The resolution above happens on a manifest read before the lock was taken, and
 * the write happens on one read inside it. Indexing by position across those two
 * reads would write to whichever chain had moved into that slot; the id is what
 * survives the gap, which is the whole reason it is opaque and stable.
 */
function familyIn(m: ProjectManifest, id: string): BookFamily {
  const family = (m.families ?? []).find((f) => f.id === id);
  if (!family) {
    throw new Error(
      `${m.projectId || '(no id)'} has no working chain called ${id} any more — it had `
      + `${describeFamilies(m.families ?? [])} when this write was locked. Nothing was changed.`
    );
  }
  return family;
}

/** The family's book record, refusing by name when it has none. */
function requireFamilyEpub(family: BookFamily, projectDir: string): EpubOutput {
  if (!family.epub?.path) {
    throw new Error(
      `${path.basename(projectDir)}'s ${path.basename(family.source.path)} chain has no working `
      + 'copy recorded, so there is no book for this act to be about. Open the book once and it '
      + 'will be made.'
    );
  }
  return family.epub;
}

/**
 * WHICH archive-grade book a project's one chain hangs off — decided from the
 * RECORDS, without asking whether the file is still there.
 *
 * ── Why this is not `classifyWorkingCopySource` ─────────────────────────────
 *
 * Because that one answers "can a copy be made right now", and this one answers
 * "what is this chain OF" — and the difference is exactly a file that has been
 * moved away. THE RECORD IS THE ONLY ANSWER is the rule everywhere else in this
 * module (`readExportEpub`, `readGeneratedEpub`, `readArchiveOriginal` all say
 * so in as many words), and a migration that required the archive original to be
 * present would give no chain to a project whose EPUB the user had moved — which
 * would take a book they can still read, still narrate and still export, and
 * make every one of those refuse.
 *
 * So existence is asked LATER, by `requireFamilySource`, at the moment a copy is
 * actually about to be made, where the refusal can name the act it is refusing.
 *
 * A project with no record of an archive-grade book at all still gets nothing:
 * there is no identity to record, and inventing one would be a chain whose
 * source is a guess.
 */
async function classifyRecordedFamilySource(
  projectDir: string
): Promise<{ source: { relPath: string; kind: 'archive-epub' | 'generated-epub' }; refusal: null }
  | { source: null; refusal: string }> {
  const manifest = await readManifestAt(projectDir);
  const format = await archiveOriginalFormat(projectDir);

  if (format === 'epub') {
    const archived = (manifest.archive ?? []).find(
      (a) => a.role === 'original' && (a.format || '').toLowerCase() === 'epub');
    if (archived?.path) {
      return { source: { relPath: archived.path, kind: 'archive-epub' }, refusal: null };
    }
    // The pre-archive layout, which `archiveOriginalFormat` already treats as
    // the same fact in an older place. Located by EXISTENCE because nothing ever
    // recorded it — that is what makes it the older place.
    const legacyRel = 'source/original.epub';
    if (fs.existsSync(toAbs(projectDir, legacyRel))) {
      return { source: { relPath: legacyRel, kind: 'archive-epub' }, refusal: null };
    }
    return {
      source: null,
      refusal: 'Its archive original is recorded as an EPUB, and the manifest does not say where. '
        + 'Re-import the book.',
    };
  }

  if (format === 'pdf') {
    const generated = manifest.outputs?.generatedEpub;
    if (!generated?.path) {
      return {
        source: null,
        refusal: 'Its pages have not been read into a book yet, and a PDF reaches an editable book '
          + 'only through Convert to EPUB. Run that over it first.',
      };
    }
    return { source: { relPath: generated.path, kind: 'generated-epub' }, refusal: null };
  }

  if (format === null) {
    return {
      source: null,
      refusal: 'It has no archive original — nothing was imported into it that a book could be '
        + 'made from.',
    };
  }
  return {
    source: null,
    refusal: `Its archive original is a ${format}, which nothing here can turn into a book.`,
  };
}

/** What `ensureBookFamilies` did, so a caller can say it once on the console. */
export interface FamiliesAdoption {
  /** The family minted from what the project already recorded, or null. */
  minted: BookFamily | null;
  /**
   * The sentence for a project that has nothing archive-grade to hang a chain
   * off, or null. NOT an exception: a PDF nobody has converted is an ordinary
   * project that opens fine, and every act that needs a book refuses in its own
   * words.
   */
  refusal: string | null;
}

/**
 * Give a project its working chains, once.
 *
 * ── Why there is a migration at all ─────────────────────────────────────────
 *
 * Every project made before families has its one book at `outputs.epub` and its
 * narration copy at `outputs.ttsEpub`. Those records describe a chain that hangs
 * off exactly one archive-grade EPUB — the project just had no way to say which,
 * because there could only ever be one. `classifyWorkingCopySource` already
 * answers that question from the archive original's format, so the family is
 * minted from the answer the project has been giving all along, and the records
 * are MOVED under it.
 *
 * ── Moved, not copied ───────────────────────────────────────────────────────
 *
 * `outputs.epub` and `outputs.ttsEpub` are deleted in the same transaction. Two
 * copies of one record is how a book comes to be edited through one of them and
 * read through the other; the legacy fields are declared as legacy and read by
 * this function alone (see ManifestOutputs).
 *
 * NOT A SINGLE FILE MOVES. The family's stem is derived from its source exactly
 * as `workingEpubStem` derived it from the archive original, so
 * `<stem>.working.epub` and `<stem>.tts.epub` are the names they already have.
 *
 * ── Idempotent, and it never guesses ────────────────────────────────────────
 *
 * A project that already has families is left alone. A project whose source
 * cannot be classified gets NO family and the refusal is reported — never an
 * empty chain invented to have something to show, because a chain with no source
 * is a book nothing can ever make again.
 */
export async function ensureBookFamilies(projectDir: string): Promise<FamiliesAdoption> {
  if ((await readBookFamilies(projectDir)).length > 0) return { minted: null, refusal: null };

  // ── The OTHER migration runs first, and the order is not negotiable ────────
  //
  // A PDF project made before generated books were kept has its cast AS its
  // working copy, and no `outputs.generatedEpub`. `classifyWorkingCopySource`
  // refuses such a project — correctly, it has nothing archive-grade — so a
  // chain minted before the adoption would be no chain at all, and the project
  // would keep its book at the legacy record forever. Adopting first gives it
  // the archive-grade book the chain then hangs off.
  //
  // Idempotent (a project that already has one costs a read and a stat), and its
  // `missing` report is deliberately not surfaced here: this function's callers
  // are asking about chains, and the callers that own that sentence ask
  // `ensureGeneratedEpub` themselves.
  await ensureGeneratedEpub(projectDir);

  const existing = await readManifestAt(projectDir);
  const answer = await classifyRecordedFamilySource(projectDir);
  if (answer.source === null) {
    return {
      minted: null,
      refusal: `${path.basename(projectDir)} has no working chain yet. ${answer.refusal}`,
    };
  }
  const relPath = answer.source.relPath;
  const absPath = toAbs(projectDir, relPath);
  const family: BookFamily = {
    id: mintFamilyId(),
    source: {
      path: relPath,
      kind: answer.source.kind,
      // Measured off the file, not taken from a record: a digest handed to us is
      // a claim about bytes rather than a measurement of them.
      //
      // NULL when the file is not there. That is a real state — a project whose
      // archive EPUB the user moved away still has a book they can read — and
      // the honest record of it is "not measured", never a digest of nothing.
      // Nothing depends on this to prove a copy: `deriveWorkingCopy` measures
      // the source and the copy at the moment it makes one, which is the only
      // measurement that can say the copy came out right.
      sha256: fs.existsSync(absPath) ? await sha256Of(absPath) : null,
    },
  };

  const projectId = requireLibraryProjectId(projectDir, existing);
  const saved = await modifyManifest(projectId, (m) => {
    // Re-checked inside the lock: two windows opening one project would
    // otherwise both mint, and the project would end up with two chains hanging
    // off one book — which is exactly the ambiguity families exist to remove.
    if (m.families && m.families.length > 0) return;
    if (m.outputs?.epub) family.epub = m.outputs.epub;
    if (m.outputs?.ttsEpub) family.ttsEpub = m.outputs.ttsEpub;
    m.families = [family];
    if (m.outputs) {
      delete m.outputs.epub;
      delete m.outputs.ttsEpub;
    }
  });
  if (!saved.success) {
    throw new Error(
      `Could not give ${path.basename(projectDir)} its working chain: ${saved.error}. Nothing was `
      + 'moved — the book is still recorded where it was.'
    );
  }

  // Read back rather than reported from the object above: another window may
  // have won the race inside the lock, in which case THIS call minted nothing
  // and must say so rather than announce a chain it did not create.
  const minted = (await readBookFamilies(projectDir)).find((f) => f.id === family.id) ?? null;
  if (minted === null) return { minted: null, refusal: null };
  console.log(
    `[manifest-service] ${path.basename(projectDir)}: its book now hangs off `
    + `${minted.source.path} as ${minted.id}`
    + (minted.epub ? `, carrying ${minted.epub.path}` : ', with no working copy yet')
    + (minted.ttsEpub ? ` and ${minted.ttsEpub.path}` : '') + '.'
  );
  return { minted, refusal: null };
}

/**
 * Add a SECOND working chain beside the ones a project already has.
 *
 * Owen: "i do have different versions of books, and i want to be able to run
 * adjustment chains on different versions." This is that act — a different
 * edition of the book, archive-grade, getting a chain of its own with its own
 * working copy, its own ledger, its own strikes and its own narration copy.
 *
 * ── The stem collision is refused BY NAME ───────────────────────────────────
 *
 * Every file in a family is named `source/<family stem>.…`, and the stem is the
 * source's basename. Two sources that share a basename — `archive/Dune.epub` and
 * a second edition also called `Dune.epub` — would name ONE working copy, and
 * the second family's mint would silently overwrite the first family's book.
 * There is no name to fall back to that would still declare which source the
 * copy belongs to, so this refuses and says which file to rename.
 *
 * The source must be INSIDE the project and must already exist: a chain hanging
 * off a file the project does not hold is a book it can never make again.
 */
export async function addBookFamily(
  projectDir: string,
  source: WorkingCopySource
): Promise<BookFamily> {
  const manifest = await readManifestAt(projectDir);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  if (!fs.existsSync(source.absPath)) {
    throw new Error(
      `Cannot give ${path.basename(projectDir)} a chain for ${source.absPath}: that file is not `
      + 'there. A working chain hangs off a book the project holds.'
    );
  }
  const rel = path.relative(projectDir, source.absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Cannot give ${path.basename(projectDir)} a chain for ${source.absPath}: it lies outside the `
      + 'project directory, so nothing here could keep it.'
    );
  }
  const relPath = rel.split(path.sep).join('/');

  const family: BookFamily = {
    id: mintFamilyId(),
    source: { path: relPath, kind: source.kind, sha256: await sha256Of(source.absPath) },
  };
  const stem = familyStem(family.source);

  for (const existing of manifest.families ?? []) {
    if (existing.source.path.toLowerCase() === relPath.toLowerCase()) {
      throw new Error(
        `${path.basename(projectDir)} already has a working chain hanging off ${relPath} `
        + `(${existing.id}). A second one would give the same book two sets of edits and two `
        + 'working copies with one name.'
      );
    }
    if (familyStem(existing.source).toLowerCase() === stem.toLowerCase()) {
      throw new Error(
        `${path.basename(projectDir)} already has a chain whose files are named after "${stem}" `
        + `(${existing.source.path}). ${relPath} has the same name, so both chains would write to `
        + `source/${stem}${WORKING_EPUB_SUFFIX} and the second would destroy the first. Rename one `
        + 'of the two books and add it again.'
      );
    }
  }

  const saved = await modifyManifest(projectId, (m) => {
    if (!m.families) m.families = [];
    m.families.push(family);
  });
  if (!saved.success) {
    throw new Error(
      `Could not record ${path.basename(projectDir)}'s new working chain for ${relPath}: `
      + `${saved.error}. Nothing was added.`
    );
  }
  console.log(
    `[manifest-service] ${path.basename(projectDir)}: added the chain ${family.id} hanging off `
    + `${relPath}; its files will be named after "${stem}".`
  );
  return family;
}

/**
 * Forget a working chain — the records only; the files are the caller's act.
 *
 * Records first, files last, the ordering every remover here uses. Refuses the
 * LAST family: a project with no chain has no book, and the difference between
 * that and "this project's book cannot be found" is a difference the erase and
 * re-mint paths depend on being able to see.
 */
export async function forgetBookFamily(
  projectDir: string,
  familyId: string
): Promise<BookFamily> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  if ((manifest.families ?? []).length <= 1) {
    throw new Error(
      `${path.basename(projectDir)} has only the one working chain (${family.id}, off `
      + `${family.source.path}), and a project without one has no book at all. Erase its changes `
      + 'instead, or delete the project.'
    );
  }
  const saved = await modifyManifest(projectId, (m) => {
    m.families = (m.families ?? []).filter((f) => f.id !== familyId);
  });
  if (!saved.success) {
    throw new Error(
      `Could not forget ${path.basename(projectDir)}'s ${familyId} chain: ${saved.error}. Nothing `
      + 'was deleted.'
    );
  }
  return family;
}

/** The same question, for a caller that was asked to do something about it. */
export async function requireWorkingCopySource(projectDir: string): Promise<WorkingCopySource> {
  const answer = await classifyWorkingCopySource(projectDir);
  if (answer.source) return answer.source;
  throw new Error(`${path.basename(projectDir)} cannot be given a working copy. ${answer.refusal}`);
}

/**
 * The archive-grade book a FAMILY hangs off, proved to be on disk.
 *
 * This is what every mint and every erase resolves through now. It differs from
 * `requireWorkingCopySource` above in the one way that matters: that one asks
 * the PROJECT what its single book is (and is what mints the first family),
 * while this asks a NAMED chain what its own source is. A project with two
 * chains has two answers, and only this form can give the right one.
 */
export async function requireFamilySource(
  projectDir: string,
  familyId?: string
): Promise<WorkingCopySource> {
  const { family } = await requireFamily(projectDir, familyId);
  const absPath = toAbs(projectDir, family.source.path);
  if (!fs.existsSync(absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s ${family.id} chain hangs off ${family.source.path}, and that `
      + 'file is not there. Nothing was put in its place — the working copy beside it has been '
      + `edited since, so it is not that book. ${family.source.kind === 'archive-epub'
        ? 'Restore it from your backup or re-import the book.'
        : 'Only a fresh Convert to EPUB can make one.'}`
    );
  }
  return { absPath, kind: family.source.kind };
}

/**
 * Where a working copy may be minted to, having proved it is not somewhere it
 * must never go.
 *
 * TWO refusals, and they are the same rule stated about the two files that carry
 * it: the archive original is what the user handed us, and the generated book is
 * the hour of GPU that read their pages. Both are archive-grade — nothing may
 * write to either — so a mint whose target resolved onto one of them is refused
 * rather than performed. The generated book is checked even when it is not the
 * source, because "may never be written to" is a property of the file rather
 * than of which mint happens to be running.
 *
 * It resolves a path and compares strings; it writes nothing. That is what lets
 * `ensureBookEpub` ask it BEFORE it clears anything, so a project that was never
 * going to get a copy does not have its records cleared for one.
 */
async function mintTargetFor(
  projectDir: string,
  source: WorkingCopySource,
  familyId?: string
): Promise<ExportEpubLocation> {
  const target = await exportEpubTarget(projectDir, familyId);
  const resolved = path.resolve(target.absPath);
  if (resolved === path.resolve(source.absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s working copy would be written over the very book it is a copy `
      + `of (${target.relPath}). Refusing: ${source.kind === 'archive-epub'
        ? 'the archive is the one file nothing may edit.'
        : 'the book cast from your pages is kept as it was cast, and nothing may edit it.'}`
    );
  }
  const generated = await readGeneratedEpub(projectDir);
  if (generated !== null && resolved === path.resolve(generated.absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s working copy would be written over the book cast from its `
      + `pages (${generated.relPath}). Refusing: that book is archive-grade, and overwriting it `
      + 'would put an hour of page reading behind every edit the user makes.'
    );
  }
  // ── And over EVERY OTHER CHAIN'S source, and every other chain's copy ───────
  //
  // The two refusals above name the files THIS mint knows about. A project with
  // several chains has archive-grade books this mint has never heard of, and a
  // second chain's working copy is somebody's evening of edits — neither is a
  // file to discover by overwriting it. `addBookFamily` already refuses a source
  // that would collide by name, so reaching here means a manifest that says
  // something no act of this app writes; it is named rather than performed.
  for (const other of await readBookFamilies(projectDir)) {
    if (other.id === familyId) continue;
    if (resolved === path.resolve(toAbs(projectDir, other.source.path))) {
      throw new Error(
        `${path.basename(projectDir)}'s working copy would be written over ${other.source.path}, `
        + `which is the archive-grade book its ${other.id} chain hangs off. Refusing: nothing may `
        + 'write to a book another version is minted from.'
      );
    }
    if (other.epub?.path && resolved === path.resolve(toAbs(projectDir, other.epub.path))) {
      throw new Error(
        `${path.basename(projectDir)}'s working copy would be written over ${other.epub.path}, `
        + `which is the ${other.id} chain's own working copy. Refusing: that file carries a `
        + 'different version\'s edits, and this mint does not know what they are.'
      );
    }
  }
  return target;
}

/**
 * Mint the working copy: a byte-identical copy of an archive-grade book,
 * recorded as `outputs.epub`.
 *
 * THE ONE MINT. `ensureBookEpub` calls it after clearing what the old copy
 * carried, and `vlm-convert` calls it having just written a fresh generated
 * book; a second copy-and-register somewhere else is how the two would come to
 * produce different things.
 *
 * ── The copy is the source's bytes, and that is PROVED ──────────────────────
 *
 * Nothing is translated or rewritten here: the working copy IS the book it came
 * from. "Identical bytes" is the whole claim the naming, the analysis cache and
 * every stamp downstream rest on, and a short copy would break all of them
 * silently. A copy that is not identical is a failed copy and is refused as one.
 *
 * It does NOT clear anything. Clearing is `resetEditorRecords`, composed by the
 * caller that means it — a conversion that honoured the user's deleted pages
 * must not then throw that list away, and a re-mint of a deleted copy must.
 */
export async function mintWorkingCopyFrom(
  projectDir: string,
  source: WorkingCopySource,
  familyId?: string
): Promise<ExportEpubLocation> {
  // `keepRecords: false` is what this call has always done: `registerEpubExport`
  // replaced `outputs.epub` wholesale and the strikes went with it. Its callers
  // are a fresh cast and a fresh copy of the archive — neither is a book the old
  // strikes describe.
  return deriveWorkingCopy(
    projectDir, { from: 'base', base: source, keepRecords: false }, familyId);
}

/**
 * WHERE the working copy is being derived from — the archive-grade base, or a
 * point in the book's ledger.
 *
 * The two are the same act on two different files, which is why they are one
 * function: copy, prove the bytes, record. What differs is only what the record
 * says afterwards, and that difference is the whole of the ledger's truth table.
 */
export type WorkingCopyDerivation =
  /**
   * The archive-grade book. The copy carries no passes and no ledger, which is
   * what "byte-identical to the archive original" means.
   */
  | { from: 'base'; base: WorkingCopySource; keepRecords: boolean }
  /**
   * The snapshot the last KEPT entry left. The copy carries those entries' bytes
   * and, with them, their provenance — so the entries and their `AppliedPass`
   * records are put back after the register has ended the old book's.
   */
  | { from: 'ledger'; keep: readonly LedgerEntry[]; keepRecords: boolean };

/**
 * Whether this derivation is one the user's WORKING CHANGES survive.
 *
 * Stated by the caller rather than inferred from where the bytes come from,
 * because the two are genuinely independent. Deleting the only ledger entry
 * derives from the BASE and must keep every strike and deletion ("if they delete
 * footnotes, itll only have working changes present"); a re-mint of a deleted
 * working copy derives from a SNAPSHOT and must keep none, the reset having just
 * cleared them. Guessing from the source would get one of those two wrong.
 *
 * It governs only the records that live inside `outputs.epub` —
 * `narrationDeletions` and `bookEdits` — because those are the ones
 * `registerEpubExport` replaces along with the record. Everything else the user
 * recorded lives elsewhere in the manifest and no derivation touches it.
 */

/**
 * Derive the working copy — from the archive-grade base, or from a ledger
 * snapshot — and record it.
 *
 * THE ONE DERIVATION. Everything that puts a working copy on disk comes through
 * here: `ensureBookEpub` after a missing file, the erase acts, the ledger
 * deletion, and `vlm-convert` having just cast a book. A second copy-and-register
 * somewhere else is how two of them would come to produce different things.
 *
 * ── The copy is the source's bytes, and that is PROVED ──────────────────────
 *
 * Nothing is translated or rewritten here: the working copy IS the book it came
 * from. "Identical bytes" is the whole claim the naming, the analysis cache and
 * every stamp downstream rest on, and a short copy would break all of them
 * silently. A copy that is not identical is a failed copy and is refused as one.
 * A ledger snapshot is checked against the digest recorded WITH the entry as
 * well, because a snapshot whose bytes have changed since it was taken is not
 * the book that pass produced and deriving from it would put unknown text under
 * a record that names a known one.
 *
 * It does NOT clear anything. Clearing is `resetEditorRecords`, composed by the
 * caller that means it — a conversion that honoured the user's deleted pages
 * must not then throw that list away, and a re-mint of a deleted copy must.
 */
export async function deriveWorkingCopy(
  projectDir: string,
  derivation: WorkingCopyDerivation,
  familyId?: string
): Promise<ExportEpubLocation> {
  const resolved = await requireFamily(projectDir, familyId);
  const family = resolved.family;

  // The refusals that protect the archive-grade files are asked about the BASE
  // in both cases: they are properties of those files, not of which copy happens
  // to be running, and `mintTargetFor` writes nothing so it is safe to ask first.
  const base = derivation.from === 'base'
    ? derivation.base
    : await requireFamilySource(projectDir, family.id);
  const target = await mintTargetFor(projectDir, base, family.id);

  const sourceAbs = derivation.from === 'base'
    ? base.absPath
    : toAbs(projectDir, derivation.keep[derivation.keep.length - 1].snapshot);

  const priorEpub = family.epub;

  // ── The one edit that cannot be carried across, named before anything moves ─
  //
  // A chapter-opening FOLD removes elements from the book, which re-keys every
  // strike after it — and the strike record was migrated to match in the same
  // transaction (`recordChapterOpeningFold`). Deriving back past that fold undoes
  // it in the bytes while the migrated record still describes the folded book, so
  // every strike after a fold would land an element out. It only matters when the
  // records are being kept: a derivation that clears them has nothing to
  // mis-apply.
  //
  // A fold made BEFORE a pass ran cannot reach here — `registerLedgerPass`
  // compares the snapshot's enumeration to the base's and refuses the entry when
  // they differ — so the comparison is against the point being returned to.
  if (derivation.keepRecords) {
    const returningTo = derivation.from === 'ledger'
      ? derivation.keep[derivation.keep.length - 1].createdAt
      : '';
    const foldedSince = (priorEpub?.bookEdits ?? []).filter(
      (edit) => edit.kind === 'merge-chapter-opening' && edit.at > returningTo);
    if (foldedSince.length > 0) {
      const target = derivation.from === 'ledger'
        ? `the snapshot ${derivation.keep[derivation.keep.length - 1].label} left`
        : 'the archive-grade original';
      throw new Error(
        `${path.basename(projectDir)}'s book has had ${foldedSince.length} chapter opening(s) folded `
        + `since ${target} was written, and a fold REMOVES elements from the book. Going back to it `
        + 'would put those elements back while your strikes still describe the folded book, so every '
        + 'strike after a fold would name the wrong paragraph. Erase this book\'s working changes '
        + 'first (that clears the folds with everything else), then delete the ledger entry.'
      );
    }
  }

  if (derivation.from === 'ledger') {
    const entry = derivation.keep[derivation.keep.length - 1];
    if (!fs.existsSync(sourceAbs)) {
      throw new Error(
        `${path.basename(projectDir)}'s ledger records ${entry.label} with a snapshot at `
        + `${entry.snapshot}, and that file is not there. Nothing has been put in its place — the `
        + 'working copy beside it has been edited since, so it is not that book. Delete the ledger '
        + 'entry to go back to what came before it.'
      );
    }
    const onDisk = await sha256Of(sourceAbs);
    if (onDisk !== entry.snapshotSha256) {
      throw new Error(
        `${path.basename(projectDir)}'s ledger snapshot for ${entry.label} (${entry.snapshot}) is `
        + `not the book it was recorded as (${entry.snapshotSha256.slice(0, 12)} vs `
        + `${onDisk.slice(0, 12)}). Nothing was copied. A snapshot that has changed since it was `
        + 'taken is not what that pass produced, and deriving a working copy from it would put text '
        + 'nobody recorded under a record that names text somebody did.'
      );
    }
  }

  await atomicCopyFile(sourceAbs, target.absPath);

  const [sourceDigest, copyDigest] = await Promise.all([
    sha256Of(sourceAbs),
    sha256Of(target.absPath),
  ]);
  if (sourceDigest !== copyDigest) {
    await fs.promises.rm(target.absPath, { force: true });
    throw new Error(
      `${path.basename(projectDir)}'s working copy did not come out identical to the book it was `
      + `copied from (${sourceDigest.slice(0, 12)} vs ${copyDigest.slice(0, 12)}). The copy has been `
      + 'removed. A working copy that is not those bytes is not this book, and every stamp written '
      + 'against it afterwards would name paragraphs that are not where they say. Try opening the '
      + 'book again; if it keeps happening, the disk is the place to look.'
    );
  }

  // A carry is passed whenever this derivation preserves ANYTHING — the ledger
  // entries, the working-change records, or both. A derivation that preserves
  // neither passes none, which is the ordinary rebuild `registerEpubExport` was
  // written for and behaves exactly as it always has.
  const carry: EpubCarry | undefined = derivation.from === 'ledger' || derivation.keepRecords
    ? {
      ledger: derivation.from === 'ledger' ? derivation.keep : [],
      records: derivation.keepRecords
        ? {
          // Re-stamped onto the bytes that are there now, keys untouched. The
          // record is what the user struck; the stamp is only the claim about
          // WHICH book those positions are in, and the enumeration is the same
          // one the ledger's invariant guarantees.
          ...(priorEpub?.narrationDeletions
            ? {
              narrationDeletions: {
                ...priorEpub.narrationDeletions,
                epubSha256: copyDigest,
              },
            }
            : {}),
          ...(priorEpub?.bookEdits ? { bookEdits: priorEpub.bookEdits } : {}),
        }
        : {},
    }
    : undefined;
  await registerEpubExport(projectDir, target.absPath, carry, family.id);
  const fromWhat = derivation.from === 'base'
    ? `its ${base.kind === 'archive-epub' ? 'EPUB original' : 'generated book'}`
    : `the ledger snapshot ${listLedgerLabels(derivation.keep)} left`;
  console.log(
    `[manifest-service] ${path.basename(projectDir)}: minted ${target.relPath} from ${fromWhat}, `
    + `byte-identical (${copyDigest.slice(0, 12)}).`
  );
  return target;
}

/** What `ensureGeneratedEpub` found, so a caller can say it once. */
export interface GeneratedEpubAdoption {
  /** The generated book that was adopted from the working copy, or null. */
  adopted: GeneratedEpubLocation | null;
  /**
   * The sentence for a project whose recorded generated book is not on disk, or
   * null. Not an exception: the project still opens, and every act that needs
   * the generated book refuses with its own sentence.
   */
  missing: string | null;
}

/**
 * Give a PDF-origin project the generated book it predates, once.
 *
 * ── Why there is a migration at all ─────────────────────────────────────────
 *
 * Every PDF project made before 2026-08-09 has its cast book AS its working
 * copy: `vlm-convert` wrote straight onto `outputs.epub`. Erasing changes on one
 * of those would delete the cast, so the erase act has to refuse them — and a
 * feature that refuses the whole library is not a feature. So the working copy
 * is COPIED to `source/<archive basename>.generated.epub` and that copy becomes
 * the project's archive-grade book.
 *
 * ── Why copying an EDITED book is honest ────────────────────────────────────
 *
 * Those bytes may already carry folded chapter openings and named headings. They
 * are still the earliest state of the book that exists on this disk — the
 * pristine cast is gone, and only re-reading the pages could bring it back — so
 * they are recorded as `origin: 'adopted'` and every surface that offers to
 * erase changes says which book the user lands on. The alternative was to leave
 * those projects with no generated book at all, which costs them the hour of GPU
 * the first time they want their edits cleared.
 *
 * ── Idempotent, and it never guesses ────────────────────────────────────────
 *
 * A project that already records a generated book is left alone, whether or not
 * the file is there — a record whose file has gone is REPORTED, never replaced
 * by the working copy, because that copy has been edited since and adopting it
 * would silently redefine what erasing changes goes back to. A project that is
 * not PDF-origin, or has no book on disk yet, has nothing to adopt and that is
 * an ordinary answer rather than a refusal.
 */
export async function ensureGeneratedEpub(projectDir: string): Promise<GeneratedEpubAdoption> {
  const nothing: GeneratedEpubAdoption = { adopted: null, missing: null };

  if (await archiveOriginalFormat(projectDir) !== 'pdf') return nothing;

  const recorded = await readGeneratedEpub(projectDir);
  if (recorded !== null) {
    if (fs.existsSync(recorded.absPath)) return nothing;
    return {
      adopted: null,
      missing: `${path.basename(projectDir)} records its generated book as ${recorded.relPath}, and `
        + 'that file is not there. Nothing has been put in its place — the working copy beside it '
        + 'has been edited since it was cast, so it is not the same book. Convert to EPUB again to '
        + 'make one.',
    };
  }

  // ── Read from the LEGACY record, and why that is not a second authority ────
  //
  // A project that reaches this line has an archive PDF and no generated book,
  // so `classifyWorkingCopySource` refuses it and `ensureBookFamilies` gives it
  // no chain — by construction it has none, and its book is still where projects
  // kept it before chains existed. This migration runs FIRST for exactly that
  // reason (`ensureBookFamilies` calls it), and once it has, the chain minted
  // afterwards hangs off the generated book this adopted.
  const manifest = await readManifestAt(projectDir);
  if ((manifest.families ?? []).length > 0) {
    throw new Error(
      `${path.basename(projectDir)} has working chains but no generated book, while its archive `
      + 'original is a PDF — a state nothing here writes. A chain off a PDF project hangs off the '
      + 'book cast from its pages, so this manifest describes a chain whose source cannot exist.'
    );
  }
  const legacy = manifest.outputs?.epub;
  const book = legacy?.path
    ? { relPath: legacy.path, absPath: toAbs(projectDir, legacy.path) }
    : null;
  // No book yet is the ordinary state of a PDF nobody has converted. The cast
  // itself writes the generated book, so there is nothing here to do for it.
  if (book === null || !fs.existsSync(book.absPath)) return nothing;

  const target = await generatedEpubTarget(projectDir);
  if (path.resolve(target.absPath) === path.resolve(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s generated book and its working copy would be the same file `
      + `(${target.relPath}). The two names are derived from one stem and must differ; this project's `
      + 'manifest records a book under a name nothing here produces.'
    );
  }
  await atomicCopyFile(book.absPath, target.absPath);

  const [bookDigest, copyDigest] = await Promise.all([
    sha256Of(book.absPath),
    sha256Of(target.absPath),
  ]);
  if (bookDigest !== copyDigest) {
    await fs.promises.rm(target.absPath, { force: true });
    throw new Error(
      `${path.basename(projectDir)}'s generated book did not come out identical to the working copy `
      + `it was adopted from (${bookDigest.slice(0, 12)} vs ${copyDigest.slice(0, 12)}). The copy has `
      + 'been removed and nothing was recorded, because a generated book that is not those bytes '
      + 'would put a different book behind every future erase.'
    );
  }

  const adopted = await registerGeneratedEpub(projectDir, target.absPath, 'adopted');
  console.log(
    `[manifest-service] ${path.basename(projectDir)}: adopted ${book.relPath} as its generated book `
    + `${adopted.relPath} (${copyDigest.slice(0, 12)}). Erasing this book's changes now costs a file `
    + 'copy instead of an hour of page reading.'
  );
  return { adopted, missing: null };
}

/**
 * The keys under `manifest.source` that are the picker's RECORDS — deletions,
 * ordering, the layout stamp — as opposed to the source IDENTITY keys
 * (type/originalFilename/fileHash/url/fetchedAt) that must survive every reset.
 *
 * ONE list, shared by the reset that clears them (`resetEditorRecords`) and the
 * measurement that says whether there is anything to clear
 * (`workingChangesByFamily`). Two lists here would drift, and the drift would be
 * a working-changes line that shows for records the erase does not remove — or
 * an erase that removes records the line never admitted to.
 */
const PICKER_SOURCE_RECORD_KEYS = [
  'deletedBlockIds',
  'deletedBlockLines',
  'foundryAutoDiscardedLines',
  'deletedHighlightIds',
  'pageOrder',
  'deletedPages',
  'removeBackgrounds',
  EDITOR_LAYOUT_MANIFEST_KEY,
] as const;

/**
 * Throw away everything the user has recorded against this project's book.
 *
 * ── ONE reset shape, in one place ───────────────────────────────────────────
 *
 * This is the whole of what "start this book over" means, and it has exactly
 * two callers: the rail's "Erase all changes and start over" button
 * (`pipeline:reset-editor-state` in electron/main.ts, which additionally
 * destroys any open editor window so its autosave cannot put the records back)
 * and `ensureBookEpub` below, when the working copy the manifest names is not on
 * disk any more. They MUST clear the same things — a user who deletes the file
 * and a user who presses the button are doing the same thing by two routes — and
 * the way to guarantee that is for there to be one list, here, rather than two
 * that drift.
 *
 * ── What is cleared, and why each ───────────────────────────────────────────
 *
 *  1. `manifest.editor` WHOLESALE — the undo/redo stacks, block edits, custom
 *     and OCR categories and blocks, category corrections, learned categories,
 *     paragraph breaks, block splits and merges, crop regions, text
 *     corrections. Wholesale is the structural point: a hardcoded list of
 *     sub-fields is what drifted from what the editor writes and produced the
 *     old "reset doesn't fully take" bug. Never add per-field handling.
 *  2. A fixed subset of `manifest.source`, key by key, because that object ALSO
 *     holds source IDENTITY (type/originalFilename/fileHash/url/fetchedAt) which
 *     must survive. `editorLayout` is in the subset because it is not a fact
 *     about the source document — it is the stamp saying WHICH LAYOUT the
 *     records above were made in, and with those records gone it is a claim
 *     about nothing.
 *  3. `manifest.chapters` / `chaptersSource` — the editor's chapter markers.
 *  4. The narration strikes and the book edits, both sub-fields of the FAMILY's
 *     `epub`. A strike IS an editor edit said as the element it names
 *     (shared/vlm/narration-deletions.ts), and a book edit is a chapter opening
 *     the user folded; a reset that cleared one and left the other would put the
 *     book back on screen looking untouched and then quietly cut the narration
 *     copy by strikes nothing on screen explains.
 *  5. The editor's scratch and diagnostics files under `source/`, which have no
 *     other delete path.
 *
 * ── Which of those a NON-OWNING chain clears ────────────────────────────────
 *
 * Only 4. Items 1, 2, 3 and 5 are the picker's curation of the document the
 * ARCHIVE ORIGINAL is, and a second version added beside it is a different file
 * that was never laid out with them (`familyOwnsPickerRecords`). For a project
 * with one chain — every project in the library today — that chain always owns
 * them, so this is the same reset it has always been.
 *
 * The BOOK ITSELF is not touched, and neither is any other deliverable: this
 * clears RECORDS. `ensureBookEpub` replaces the file in its own act, after this
 * one; the button leaves the file exactly where it is.
 *
 * ── Raw read, raw atomic write ──────────────────────────────────────────────
 *
 * Deliberately not `modifyManifest`: that locates the file from the projectId
 * and so refuses a directory the library does not own, and it round-trips
 * through the typed shape, which would normalize paths and drop the very
 * untyped sub-fields this is here to delete. A malformed manifest throws out of
 * the JSON.parse and is never overwritten with a guessed structure.
 */
export async function resetEditorRecords(projectDir: string, familyId?: string): Promise<void> {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Cannot reset ${projectDir}: it has no ${MANIFEST_FILENAME}.`);
  }
  // WHICH chain is being reset is settled before the raw read below, through the
  // one chokepoint, so a project with several refuses here rather than clearing
  // the picker's curation on behalf of a book nobody named.
  const { family } = await requireFamily(projectDir, familyId);
  const archiveOriginal = await readArchiveOriginal(projectDir);

  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));

  // ── The picker's records go only with the chain they describe ──────────────
  //
  // `familyOwnsPickerRecords` is the rule and shared/document/book-families.ts
  // is where it is argued: the editor state, the deletion keys under `source`
  // and the chapter markers are the curation of the document the ARCHIVE
  // ORIGINAL is, so a second version added beside it must not have them cleared
  // when its own changes are erased — that curation is not about its book.
  if (familyOwnsPickerRecords(family, archiveOriginal?.relPath ?? null)) {
    // Editor state is a sidecar file (electron/editor-state-store.ts) and the
    // manifest key is its pre-sidecar location, so BOTH go — the delete below is
    // the migration for a project that has not been swept yet.
    //
    // The sidecar goes FIRST, before the manifest transaction. A crash in
    // between then leaves the legacy key in place, which re-migrates on the next
    // contact and puts the state back — so the whole reset reads as not having
    // happened, and pressing the button again does it. The other order would
    // leave an orphan sidecar that is authoritative and stale: a reset that
    // cleared the deletions and the chapters but silently kept the undo stack.
    await deleteEditorState(projectDir);
    delete manifest.editor;
    if (manifest.source && typeof manifest.source === 'object') {
      for (const key of PICKER_SOURCE_RECORD_KEYS) {
        delete manifest.source[key];
      }
    }
    delete manifest.chapters;
    delete manifest.chaptersSource;
  }

  // The book's OWN records, always: they are positional inside this family's
  // working copy and describe nothing else.
  const target = (manifest.families ?? []).find(
    (f: { id?: string }) => f.id === family.id);
  if (target?.epub) {
    delete target.epub.narrationDeletions;
    delete target.epub.bookEdits;
  }

  manifest.modifiedAt = new Date().toISOString();
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Scratch written BY the picker, about the document it curated — so it goes
  // with that curation, on the same condition, and a non-owning chain leaves it
  // exactly where it is.
  if (familyOwnsPickerRecords(family, archiveOriginal?.relPath ?? null)) {
    const sourceDir = path.join(projectDir, 'source');
    for (const file of [
      'load-trace.log',
      'save-diagnostics.json',
      'export-diagnostics.json',
      'deleted-examples.json',
    ]) {
      try { await fs.promises.unlink(path.join(sourceDir, file)); } catch { /* absent */ }
    }
  }
}

/**
 * Whether erasing each chain's working changes would erase ANYTHING, by family
 * id. The versions page gates its working-changes line on this — a line that
 * drew whenever a working copy existed reappeared the instant a successful
 * erase re-minted the copy, which read as the erase having done nothing.
 *
 * The measurement mirrors `resetEditorRecords` clause for clause, against the
 * same shared key list, with two deliberate exceptions: the AUTOMATIC book
 * edits do not count. `name-chapter-openers` and `stamp-element-ids` are both
 * unattended — they run when the project opens, and every fresh mint writes one
 * of each — so counting either would put the answer back to "always yes", which
 * is the bug this measurement exists to fix.
 *
 * Empty containers do not count either: the picker's save writes
 * `undoStack: []` / `redoStack: []` on every save, so the KEY existing is a
 * fact about the picker having saved, not about the user having changed
 * anything.
 */
export async function workingChangesByFamily(
  projectDir: string
): Promise<Record<string, boolean>> {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  // Raw read for the same reason resetEditorRecords reads raw: the records
  // being measured include untyped sub-fields the typed round-trip would drop.
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
  const archiveOriginal = await readArchiveOriginal(projectDir);
  // The editor state through the store's own precedence rule (sidecar, or the
  // legacy manifest key while it is still there) — and through the PEEK, since
  // a listing must not migrate the project as a side effect of drawing it.
  const editorState = await peekEditorState(projectDir);

  const hasContent = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.values(v).some(hasContent);
    return true;
  };

  const pickerRecords =
    hasContent(editorState)
    || PICKER_SOURCE_RECORD_KEYS.some((key) => hasContent(manifest.source?.[key]))
    || hasContent(manifest.chapters)
    || hasContent(manifest.chaptersSource);

  const answer: Record<string, boolean> = {};
  for (const family of (manifest.families ?? []) as BookFamily[]) {
    // The book's OWN records — positional inside this family's working copy.
    const strikes = hasContent(family.epub?.narrationDeletions?.elements);
    const deliberateEdits = (family.epub?.bookEdits ?? [])
      .some((edit) => edit.kind !== 'name-chapter-openers' && edit.kind !== 'stamp-element-ids');
    answer[family.id] = strikes || deliberateEdits
      || (pickerRecords
        && familyOwnsPickerRecords(family, archiveOriginal?.relPath ?? null));
  }
  return answer;
}

/** Where the book is, and whether making it there was a re-mint. */
export interface EnsuredBookEpub extends ExportEpubLocation {
  /**
   * Non-null ONLY when a recorded book was missing from disk and has been made
   * again. Null for a book that was already there and for a project's first
   * copy — see `ensureBookEpub` below for why those are not the same event.
   */
  remint: WorkingCopyRemint | null;
}

/**
 * The project's book EPUB, minting it from the project's archive-grade book if
 * there is none.
 *
 * ── WHAT PROBLEM THIS SOLVES ────────────────────────────────────────────────
 *
 * `outputs.epub` is the ONE book a pass reads and rewrites, and it must never be
 * a file the project cannot get back. Both kinds of project have exactly one
 * archive-grade book behind it (`classifyWorkingCopySource`): an EPUB-native
 * project has the file the user handed us, and a PDF-origin one has the book a
 * page reader cast from its pages. Neither may be written to — the first is
 * unrecoverable, and the second is an hour of GPU — so Simplify, Translate and
 * the narration strikes all write to a COPY.
 *
 * So the book is minted lazily: the first act that needs one copies the
 * archive-grade book into `source/<archive basename>.working.epub` and records
 * it. From then on every pass writes to the copy, and the book it was copied
 * from is still there to make it again.
 *
 * ── NO PROVENANCE ENTRY ─────────────────────────────────────────────────────
 *
 * `registerEpubExport` starts the book's provenance over, and nothing is
 * appended after it: this book has had nothing done to it. It IS the book it was
 * copied from. An `appliedPasses` entry here would claim a transformation that
 * did not happen, and a diff viewer would offer a review of nothing. (The
 * conversion that CAST a generated book is recorded by `vlm-convert` against the
 * copy it mints, which is where that history belongs.)
 *
 * The one exception proves the rule: a copy derived from a LEDGER SNAPSHOT is
 * not a copy of the archive-grade book, it is a copy of what a pass produced, so
 * that pass's record is carried across with the bytes it describes
 * (`deriveWorkingCopy`). The claim and the file still agree — which is the only
 * thing this paragraph has ever been about.
 *
 * A project with nothing archive-grade to copy is REFUSED by name — a PDF whose
 * pages have never been read has no book, and this helper is not a second,
 * silent way to end up with something to narrate.
 *
 * ── The naming migration runs FIRST ─────────────────────────────────────────
 *
 * A project whose book predates `<archive basename>.working.epub` has one under
 * the old name. `migrateWorkingEpubNaming` renames it before anything here looks
 * for one, so this never mints a SECOND copy of a book the project already has —
 * which is exactly what would happen otherwise, the recorded path being a file
 * that exists under a name the derivation no longer produces.
 *
 * ── A RE-mint CLEARS first, and is answered for ─────────────────────────────
 *
 * Making the FIRST copy and making it AGAIN are two different events, and only
 * the second is news: a record naming a file that is not on disk is evidence
 * that a file somebody was editing has gone. Owen, 2026-08-09: "if i delete the
 * working copy, all of its deletions and changes should go with it. thats how it
 * works right." So they do — `resetEditorRecords` runs first, the same wholesale
 * reset the rail's "Erase all changes and start over" button performs, and only
 * then is the copy made. A re-mint therefore produces a book with nothing
 * recorded against it, which is what a book made fresh from the archive is.
 *
 * The answer carries the fact and the counts of what was cleared, and
 * `shared/document/working-copy-remint.ts` says in what words; the caller that
 * has a user in front of it is the one that tells them.
 */
export async function ensureBookEpub(
  projectDir: string,
  familyId?: string
): Promise<EnsuredBookEpub> {
  // `requireFamily` gives a project that predates chains its chain on the way
  // past, so this reaches a project that has one or refuses by name.
  const { family } = await requireFamily(projectDir, familyId);

  await migrateWorkingEpubNaming(projectDir, family.id);
  const existing = await readExportEpub(projectDir, family.id);
  if (existing && fs.existsSync(existing.absPath)) return { ...existing, remint: null };

  const manifest = await readManifestAt(projectDir);
  // Two different situations, and they get the same answer for the same reason:
  // this chain's archive-grade book is not there to be copied.
  let source: WorkingCopySource;
  try {
    source = await requireFamilySource(projectDir, family.id);
  } catch (err) {
    throw new Error(
      existing
        ? `${path.basename(projectDir)}'s manifest records its book as ${existing.relPath}, but that `
          + `file is not there, and it cannot be made again. ${(err as Error).message}`
        : `${path.basename(projectDir)} has no book EPUB. ${(err as Error).message}`
    );
  }

  // Asked BEFORE anything is cleared, and it writes nothing: a project whose
  // copy would land on the archive original or on the generated book is refused
  // here rather than after its records have been thrown away for a copy it was
  // never going to get.
  await mintTargetFor(projectDir, source, family.id);

  // ── Counted BEFORE anything is cleared ─────────────────────────────────────
  //
  // This is the last instant at which the numbers exist: the reset below drops
  // the two `manifest.source` lists and `registerEpubExport` later replaces this
  // family's `epub` wholesale, which takes the strikes with it. All three are
  // read from one manifest snapshot, so they describe one moment.
  //
  // An absent list is a real state (a project nothing has been deleted in) and
  // is the only thing its absence can mean; it is not a missing value standing
  // in for one that should have been there.
  //
  // The picker's two counts are reported only when THIS chain is the one whose
  // reset would clear them (`familyOwnsPickerRecords`) — a receipt naming block
  // deletions that are still there afterwards would be a lie about what the act
  // cost.
  const ownsPickerRecords = familyOwnsPickerRecords(
    family, (await readArchiveOriginal(projectDir))?.relPath ?? null);
  const clearedBlocks = ownsPickerRecords ? manifest.source?.deletedBlockIds?.length ?? 0 : 0;
  const clearedPages = ownsPickerRecords ? manifest.source?.deletedPages?.length ?? 0 : 0;
  const bookRecord = (manifest.families ?? []).find((f) => f.id === family.id)?.epub;
  const strikes = bookRecord?.narrationDeletions?.elements.length ?? 0;

  // ── The ledger is not a record of the user's edits, so it does not go ───────
  //
  // Owen's truth table: "if they delete working changes but keep footnotes, the
  // working copy will have no changes except footnotes removed." Deleting the
  // working copy IS deleting working changes, so a book with recorded passes
  // comes back from the last snapshot in its ledger rather than from the archive
  // — the passes rewrote the book itself, they have their own rows, and the
  // user has their own act for taking those back. Throwing an hour of model time
  // away because somebody meant "start my edits over" is the failure this branch
  // exists to prevent, and the receipt names what stood so it is never silent.
  const ledger = bookRecord?.ledger ?? [];

  // A record that named a book, for a book that was not there. The FIRST copy
  // has no record to have named anything, and is not this.
  const remint: WorkingCopyRemint | null = existing === null ? null : {
    relPath: existing.relPath,
    source: source.kind,
    deletedBlockIds: clearedBlocks,
    deletedPages: clearedPages,
    narrationStrikes: strikes,
    kept: ledger.map((entry) => entry.label),
  };

  // ── The deletions and changes go with the file the user deleted ────────────
  //
  // BEFORE the copy, not after, and that ordering is the guarantee: an interrupt
  // between the two leaves a project with no records and no book, which the next
  // open mints cleanly. The other order would leave a fresh copy carrying an
  // evening's worth of strikes — the exact failure this is the fix for.
  //
  // It runs only here, past both refusals above, so a project that has no
  // archive original to mint from never has its records cleared for a copy it
  // was not going to get.
  if (remint !== null) await resetEditorRecords(projectDir, family.id);

  // `keepRecords: false` in both branches: a re-mint has just run the wholesale
  // reset above, and a FIRST copy has nothing recorded against it. There is
  // nothing to keep, and saying so is what keeps the flag from becoming a place
  // records could quietly survive a reset.
  const target = ledger.length === 0
    ? await deriveWorkingCopy(
      projectDir, { from: 'base', base: source, keepRecords: false }, family.id)
    : await deriveWorkingCopy(
      projectDir, { from: 'ledger', keep: ledger, keepRecords: false }, family.id);
  if (remint !== null) {
    console.warn(`[manifest-service] ${path.basename(projectDir)}: ${describeWorkingCopyRemint(remint)}`);
  }
  return { ...target, modifiedAt: new Date().toISOString(), remint };
}

/**
 * sha256 of a file, streamed — the same digest every identity check here uses,
 * and the one a ledger snapshot is proved with (electron/book-ledger.ts). Two
 * digest implementations is how a snapshot would come to be "identical" to one
 * of them and not the other.
 */
export function sha256OfFile(filePath: string): Promise<string> {
  return sha256Of(filePath);
}

/** sha256 of a file, streamed — the same digest every identity check here uses. */
function sha256Of(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Remove what a set of superseded records left on disk.
 *
 * TWO kinds of path reach this, and neither is decided here: the stage
 * directories of dropped passes, from `passesAfterEpubEvent`
 * (`shared/document/pass-lifecycle.ts`, `tools/test-pass-lifecycle.js`), and the
 * directories of dropped LEDGER entries, from `ledgerAfterDeleting`
 * (`shared/document/book-ledger.ts`). This function carries out decisions
 * already made and tested. Each path is re-checked to be inside the project
 * before anything is removed, because a manifest is a file on a synced drive and
 * a field that had walked out of the project would otherwise aim an `rm` at
 * whatever it named.
 *
 * A path that is already gone is not an error: the record and the file are two
 * things, and the record outliving the file is the ordinary way a half-finished
 * delete or a half-synced folder shows up.
 */
async function removeSupersededArtifacts(
  projectDir: string,
  relPaths: readonly string[]
): Promise<string[]> {
  const removed: string[] = [];
  for (const relPath of relPaths) {
    const abs = path.resolve(projectDir, relPath.split('/').join(path.sep));
    const inside = path.relative(path.resolve(projectDir), abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(
        `${projectDir}'s manifest records a superseded artifact at "${relPath}", which resolves `
        + 'outside the project. Nothing was removed. Fix the record — a diff and a snapshot belong '
        + 'to the book they were made from, and a book cannot own a file in another folder.'
      );
    }
    if (!fs.existsSync(abs)) continue;
    await fs.promises.rm(abs, { recursive: true, force: true });
    removed.push(relPath);
  }
  return removed;
}

/**
 * Record a written export as `outputs.epub`.
 *
 * ── This is a REBUILD, and a rebuild ends the old book's provenance ─────────
 *
 * Every caller of this has just written the book: Reflow from the picker, Reflow
 * from the queue, the markup-preserving exporter. So the file `outputs.epub`
 * named a moment ago either no longer exists or no longer holds those bytes, and
 * the passes recorded against it did not happen to what is there now
 * (docs/PIPELINE_V2_PLAN.md: "Rebuilding regenerates a clean EPUB, which
 * discards the EPUB passes done to the old one — their stars clear, honestly").
 * Replacing `m.outputs.epub` wholesale has always dropped `appliedPasses` with
 * it; what is new here is that the diffs those passes left on disk go too, so a
 * `stages/NN-<kind>/` that no record can name is never left behind for the next
 * pass at the same index to overwrite.
 *
 * WHICH passes and WHICH files is not decided here — `passesAfterEpubEvent`
 * decides, and it is tested without a project.
 *
 * The record still goes first: if it is written and the cleanup then fails, the
 * project has a correct record and some stale directories. The other order would
 * delete a user's diffs and then leave the record pointing at them.
 *
 * A file the record used to point at — the old-title EPUB after a retitle, a
 * pre-rename `exported.epub` — stops being the project's book the moment this
 * returns, and stays on disk until its owner deletes it. This code does not
 * delete a user's books.
 *
 * ── The one caller that is NOT a rebuild says so, by carrying ───────────────
 *
 * `deriveWorkingCopy` from a LEDGER SNAPSHOT writes bytes that a pass really did
 * produce, so ending that pass's provenance would delete a true record to
 * describe an event that did not happen. That caller — and only that caller —
 * passes `carry`, and what it carries is put back in the SAME manifest
 * transaction that replaces the record. Everything not carried is superseded
 * exactly as before, files and all, so the ledger and the pass list can only
 * shrink here and never grow behind the caller's back.
 *
 * An absent `carry` is a real state, not a missing argument: it is the sentence
 * "this is a new book, and nothing that was true of the old one is true of it".
 */
export interface EpubCarry {
  /**
   * The ledger entries the bytes being recorded still carry, oldest first, with
   * the `AppliedPass` records those entries hold. Entries the book no longer
   * carries are dropped, and their directories come off disk.
   */
  ledger: readonly LedgerEntry[];
  /**
   * The WORKING-CHANGE records that live inside `outputs.epub` and would
   * otherwise be replaced with it.
   *
   * `narrationDeletions` and `bookEdits` are not facts about the file — they are
   * the user's edits, kept here only because a rebuild invalidates them and this
   * is where a rebuild can reach them. A re-derivation is not a rebuild: the
   * ledger's invariant says the element enumeration is unchanged, so every
   * strike still names the paragraph it named. Dropping them here would clear an
   * evening of strikes as a side effect of deleting a pass, which is the exact
   * opposite of "if they delete footnotes, itll only have working changes
   * present".
   *
   * The caller re-stamps `narrationDeletions.epubSha256` onto the new bytes
   * before handing it over — keys untouched, stamp refreshed, which is the same
   * move `nameChapterOpenings` makes after a text-only rewrite.
   */
  records: {
    narrationDeletions?: NarrationDeletions;
    bookEdits?: BookEdit[];
  };
}

/** `simplify@2026-08-09T…` — what makes two pass records the same record. */
function passIdentity(pass: AppliedPass): string {
  return `${pass.kind}@${pass.at}`;
}

export async function registerEpubExport(
  projectDir: string,
  epubAbsPath: string,
  carry?: EpubCarry,
  familyId?: string
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const rel = path.relative(projectDir, epubAbsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Cannot record ${epubAbsPath} as ${projectDir}'s export: it lies outside the project directory.`);
  }
  const relPath = rel.split(path.sep).join('/');

  const carried = carry ? [...carry.ledger] : [];
  const carriedPasses = carried.map((entry) => entry.pass);
  const carriedPassIds = new Set(carriedPasses.map(passIdentity));
  const carriedEntryIds = new Set(carried.map((entry) => entry.id));

  // Only the passes the new bytes do NOT carry are superseded. Asked this way
  // round rather than by trimming afterwards, because `passesAfterEpubEvent` is
  // what decides which FILES come off, and handing it a carried pass would aim
  // that removal at a receipt the book still needs.
  const superseded = passesAfterEpubEvent(
    'epub-rebuilt',
    (family.epub?.appliedPasses ?? []).filter(
      (pass) => !carriedPassIds.has(passIdentity(pass))));
  const droppedEntries = (family.epub?.ledger ?? []).filter(
    (entry) => !carriedEntryIds.has(entry.id));

  const saved = await modifyManifest(projectId, (m) => {
    const target = familyIn(m, family.id);
    target.epub = { path: relPath, modifiedAt: new Date().toISOString() };
    if (carried.length > 0) {
      target.epub.appliedPasses = carriedPasses;
      target.epub.ledger = carried;
    }
    if (carry?.records.narrationDeletions) {
      target.epub.narrationDeletions = carry.records.narrationDeletions;
    }
    if (carry?.records.bookEdits) {
      target.epub.bookEdits = carry.records.bookEdits;
    }
    // The narration copy was cut from the book that has just been replaced, and
    // so were the strikes it was cut by (they go with this family's `epub` in
    // the assignment above). A record that survived would tell the TTS step to
    // narrate a file made out of a book nobody has any more. The FILE is left
    // where it is: this code does not delete a user's EPUBs, and the next export
    // writes over it under the same derived name. Only THIS chain's copy goes —
    // another version's narration copy was cut from a book nothing here touched.
    delete target.ttsEpub;
  });
  if (!saved.success) {
    throw new Error(`Exported to ${epubAbsPath}, but recording it in the manifest failed: ${saved.error}`);
  }

  const removed = await removeSupersededArtifacts(projectDir, [
    ...superseded.removePaths,
    ...droppedEntries.map((entry) => entry.dir),
  ]);
  if (removed.length > 0) {
    console.log(`[manifest-service] the rebuilt book supersedes ${superseded.dropped.length} pass`
      + `(es) and ${droppedEntries.length} ledger entr(y/ies); removed ${removed.join(', ')}`);
  }
}

/** What `forgetEpubExport` found and did, so the caller can say it. */
export interface EpubForgetSummary {
  /** The book the record named, project-relative. */
  relPath: string;
  absPath: string;
  /** The passes whose record went with it. */
  droppedPasses: number;
  /** What came off disk with them, project-relative. */
  removedPaths: string[];
}

/**
 * Forget the project's book EPUB: the record, its provenance, and the diffs that
 * provenance pointed at.
 *
 * Owen, third session: "if that file is removed, so is the diff and its viewing
 * button." This is the record half of removing the book. The FILE is the
 * caller's act, done after this returns, in that order — a failure part-way
 * leaves an unrecorded stray (invisible to every consumer, per the export
 * contract) rather than a record vouching for a file that is gone.
 *
 * Deliberately NOT `clearProcessingRecords`: that one also clears the
 * scan-stamped keys under `manifest.source` — the user's block deletions — which
 * belong to the working PDF and have nothing to do with the book being deleted.
 * "Start over" is the act that takes those.
 *
 * Refuses a project with no `outputs.epub`, naming it: the caller believed there
 * was a book to delete, and there is not.
 */
export async function forgetEpubExport(
  projectDir: string,
  familyId?: string
): Promise<EpubForgetSummary> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const record = family.epub;
  if (!record?.path) {
    throw new Error(
      `${projectDir}'s ${path.basename(family.source.path)} chain records no book, so there is no `
      + 'book EPUB to delete. The record is the only thing that says where a chain\'s book is; a '
      + 'file in the folder that nothing records is not this project\'s book.'
    );
  }
  const relPath = record.path;
  const lifecycle = passesAfterEpubEvent('epub-deleted', record.appliedPasses ?? []);

  const saved = await modifyManifest(projectId, (m) => {
    const target = familyIn(m, family.id);
    delete target.epub;
    // Cut from the book that is going. See registerEpubExport for why the file
    // itself is left alone.
    delete target.ttsEpub;
  });
  if (!saved.success) {
    throw new Error(
      `Could not forget ${relPath} in ${projectDir}'s manifest: ${saved.error}. Nothing was `
      + 'deleted — the book and its diffs are still there.'
    );
  }

  const removedPaths = await removeSupersededArtifacts(projectDir, [
    ...lifecycle.removePaths,
    // The ledger's snapshots are copies of the book that has just been forgotten.
    // With no book they are a chain to nothing, and their entries went with
    // `outputs.epub` in the transaction above.
    ...(record.ledger ?? []).map((entry) => entry.dir),
  ]);
  return {
    relPath,
    absPath: toAbs(projectDir, relPath),
    droppedPasses: lifecycle.dropped.length,
    removedPaths,
  };
}

/**
 * The name of a pass's stage directory, project-relative.
 *
 * The number is the pass's position in the book's WHOLE provenance list, not its
 * position in the run that queues it: two runs against one book would otherwise
 * both start at `01` and the second would overwrite the first's diff with a diff
 * of different text. It is still execution order — the list only grows, and only
 * at the end.
 *
 * One function so the planner and the pass agree on the path down to the digit;
 * a stage dir a pass works in but nothing can find is a diff nobody reads.
 */
export function passStageRelDir(index: number, kind: AppliedPassKind): string {
  return `stages/${String(index).padStart(2, '0')}-${kind}`;
}

/**
 * Where the NEXT pass over the book already on disk will work.
 *
 * The single-pass case of the planner's numbering (processing-chain.ts): a pass
 * that does not rebuild the book takes the position after everything the book
 * already records, and both sides spell the directory through
 * `passStageRelDir`. It is for a run that is not planned as a chain — the
 * picker's inline footnote removal — which has no plan to take a number from.
 */
export async function nextPassStageRelDir(
  projectDir: string,
  kind: AppliedPassKind,
  familyId?: string
): Promise<string> {
  const passes = await readAppliedPasses(projectDir, familyId);
  return passStageRelDir(passes.length + 1, kind);
}

/** What recording a pass did about the strike record it found. */
export interface AppliedPassRecord {
  /** True when the strikes were re-stamped onto the book the pass wrote. */
  narrationCarried: boolean;
  /** Why they were not, in full, or null. Null also when there were none. */
  narrationNote: string | null;
}

/**
 * Record a completed pass against the project's book EPUB — and, in the SAME
 * transaction, carry the narration strikes onto the book it wrote.
 *
 * ── Why the two are one write ───────────────────────────────────────────────
 *
 * Because they are one fact, exactly as `recordChapterOpeningFold` is: the pass
 * rewrote the book, and the strike record's `epubSha256` is what says which
 * book its positions are in. Two writes would leave a moment in which the
 * manifest says a pass ran against a book the strikes disown — readable by
 * another window, or synced, and no longer distinguishable from a book somebody
 * edited by hand.
 *
 * ── What `narration` is allowed to do, and what it may never do ────────────
 *
 * It may re-stamp. It may leave the record exactly as it found it. It may NOT
 * delete a strike. Since 2026-08-10 nothing in this app deletes the user's
 * strikes but the user (shared/vlm/narration-deletions.ts): a record whose
 * stamp no longer names the book is checked strike by strike at use, against
 * the text each strike remembers, and a pass that cannot prove its carry simply
 * leaves that check to happen.
 *
 * The carry is re-checked HERE against `fromSha256`, inside the lock. The proof
 * the caller made is a proof about the record it read; a record edited while the
 * pass ran is a different record, and re-stamping it on that proof would be
 * forging agreement. The fingerprints are refreshed from the book the pass
 * WROTE, so a record carried across a pass that changed text (footnote
 * references leaving a paragraph) keeps describing the book it now names.
 *
 * Refuses a project with no `outputs.epub`: a pass record describes what was done
 * to a specific file, and there is no such file to describe. That is a caller bug
 * (the pass ran against something it did not register), not a state to paper over.
 */
export async function appendAppliedPass(
  projectDir: string,
  pass: AppliedPass,
  narration: NarrationDeletionsCarry,
  familyId?: string
): Promise<AppliedPassRecord> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  let narrationCarried = false;
  let narrationNote: string | null = null;

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record the ${pass.kind} pass for ${projectDir}: its ${family.id} chain records no `
        + 'book, so there is nothing for the pass to have been applied to.'
      );
    }
    epub.appliedPasses = [...(epub.appliedPasses ?? []), pass];
    epub.modifiedAt = pass.at;

    const recorded = epub.narrationDeletions;
    if (recorded === undefined) return;

    if (narration.outcome === 'none') {
      narrationNote =
        `Narration strikes were recorded on ${path.basename(projectDir)}'s book while the `
        + `${pass.kind} pass was running, so the pass never checked them against the book it wrote. `
        + 'They are kept as they are, and each is checked against the text it struck when the '
        + 'narration copy is cut.';
      return;
    }
    if (narration.outcome === 'refused') {
      narrationNote =
        `The narration strikes were not carried onto the book the ${pass.kind} pass wrote: `
        + `${narration.reason} They are kept exactly as they are — nothing has been cleared — and `
        + 'each one is checked against the text it struck before it is applied.';
      return;
    }
    if (recorded.epubSha256 !== narration.fromSha256) {
      narrationNote =
        `${path.basename(projectDir)}'s narration strikes were edited while the ${pass.kind} pass `
        + 'was running, so the record on disk is not the one the pass proved its carry against. '
        + 'They are kept as they are and checked strike by strike when the copy is cut.';
      return;
    }

    epub.narrationDeletions = {
      ...recorded,
      epubSha256: narration.toSha256,
      updatedAt: pass.at,
      fingerprints: narrationFingerprintsFor(narration.fingerprints, recorded.elements),
    };
    narrationCarried = true;
  });
  if (!saved.success) {
    throw new Error(`The ${pass.kind} pass finished, but recording it in the manifest failed: ${saved.error}`);
  }
  if (narrationNote !== null) console.warn(`[manifest-service] ${narrationNote}`);
  return { narrationCarried, narrationNote };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger — the passes a user can take back, one at a time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The book's ledger, oldest first. An empty list is a real answer: this book has
 * had nothing run over it, or nothing that could be recorded as undoable.
 */
export async function readBookLedger(
  projectDir: string,
  familyId?: string
): Promise<LedgerEntry[]> {
  const { family } = await requireFamily(projectDir, familyId);
  return family.epub?.ledger ?? [];
}

/** Where an entry's directory is on this disk. */
export function ledgerEntryDir(projectDir: string, id: string): string {
  return toAbs(projectDir, ledgerEntryRelDir(id));
}

/**
 * Record a ledger entry against the book, as the last thing in the chain.
 *
 * The snapshot and the receipt are already on disk when this runs
 * (electron/book-ledger.ts writes them, and it is the only caller): the FILES go
 * first here, deliberately, so an interrupt leaves a directory nothing names —
 * invisible, and cleaned up by the next thing that supersedes it — rather than
 * an entry naming a snapshot that was never written, which is a "go back to
 * this" the project cannot honour.
 *
 * Refuses a project with no `outputs.epub` for the same reason
 * `appendAppliedPass` does: the caller believes a pass just rewrote a book this
 * project does not have.
 */
export async function appendLedgerEntry(
  projectDir: string,
  entry: LedgerEntry,
  familyId?: string
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const snapshot = toAbs(projectDir, entry.snapshot);
  if (!fs.existsSync(snapshot)) {
    throw new Error(
      `Cannot record the ${entry.label} ledger entry for ${path.basename(projectDir)}: its snapshot `
      + `${entry.snapshot} is not on disk. An entry without its snapshot offers the user a way back `
      + 'to a book nobody has.'
    );
  }

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record the ${entry.kind} ledger entry for ${projectDir}: its ${family.id} chain `
        + 'records no book, so there is nothing for the pass to have been applied to.'
      );
    }
    epub.ledger = [...(epub.ledger ?? []), entry];
  });
  if (!saved.success) {
    throw new Error(
      `The ${entry.kind} pass finished and its snapshot was taken, but recording the ledger entry `
      + `failed: ${saved.error}`
    );
  }
}

/** What clearing or deleting from the ledger did, so a caller can say it. */
export interface LedgerChange {
  /** The entries that went, in the order they ran. */
  dropped: LedgerEntry[];
  /** The entries that stand, oldest first. */
  kept: LedgerEntry[];
  /** What came off disk with the dropped ones, project-relative. */
  removedPaths: string[];
}

/**
 * Throw the whole ledger away: the entries, their snapshots and their receipts.
 *
 * This is the ledger's half of "erase EVERYTHING" — the counterpart of
 * `resetEditorRecords`, which is the working changes' half. Two named resets for
 * two record sets, each with exactly one implementation, rather than one
 * function with a flag: the sets are cleared by different acts as often as they
 * are cleared together (a re-mint of a deleted working copy clears the records
 * and KEEPS the ledger, which is the whole point of act 1).
 *
 * Records first, files last: an interrupt leaves directories nothing names, and
 * the derivation that follows is already correct. The other order would delete a
 * user's snapshots and leave entries offering to go back to them.
 *
 * It does not touch the book. The caller derives a fresh working copy afterwards
 * — with the ledger gone, that derivation comes off the archive-grade base,
 * which is what "byte-identical to the original" means.
 */
export async function clearBookLedger(
  projectDir: string,
  familyId?: string
): Promise<LedgerChange> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);
  const dropped = family.epub?.ledger ?? [];
  if (dropped.length === 0) return { dropped: [], kept: [], removedPaths: [] };

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (epub) delete epub.ledger;
  });
  if (!saved.success) {
    throw new Error(
      `Could not clear ${path.basename(projectDir)}'s ledger: ${saved.error}. Nothing was deleted — `
      + 'the snapshots and their diffs are still there.'
    );
  }

  const removedPaths = await removeSupersededArtifacts(
    projectDir, dropped.map((entry) => entry.dir));
  return { dropped: [...dropped], kept: [], removedPaths };
}

/** What `deleteLedgerEntry` did — including the entries it had to take with it. */
export interface LedgerEntryDeletion extends LedgerChange {
  /** The book the working copy was derived from afterwards. */
  book: ExportEpubLocation;
  /** The paragraph for the user, naming every entry that went. */
  message: string;
}

/**
 * Delete one entry from the ledger, and everything that was applied after it.
 *
 * ── The act, in the order it has to happen ──────────────────────────────────
 *
 *  1. `ledgerAfterDeleting` decides what stands and what cascades. That rule is
 *     pure and tested without a project (`shared/document/book-ledger.ts`), so
 *     the confirmation the UI shows and the deletion that happens cannot
 *     disagree about which entries are about to go.
 *  2. The working copy is DERIVED from the last standing snapshot, or from the
 *     archive-grade base when nothing stands. That derivation is the same
 *     `deriveWorkingCopy` every other copy comes through, digest-proved, and it
 *     is what carries the standing entries and their provenance across
 *     `registerEpubExport` — which is also what drops the cascaded ones and
 *     takes their directories off disk.
 *  3. The user's WORKING CHANGES are not touched. They are records keyed to the
 *     base's element enumeration, a ledger pass may not change that enumeration
 *     (`registerLedgerPass` refuses one that would), and so they describe the
 *     re-derived book exactly as they described the old one. That is the whole
 *     reason the two are separate lines in the UI.
 *
 * The caller re-names the chapter openings afterwards, as it does after every
 * mint: naming is idempotent and derived from the chapter titles the project
 * stores, so it is a normalization that can be re-applied to any rebuild rather
 * than a layer that has to be preserved.
 */
export async function deleteLedgerEntry(
  projectDir: string,
  id: string,
  familyId?: string
): Promise<LedgerEntryDeletion> {
  const { family } = await requireFamily(projectDir, familyId);
  const entries = await readBookLedger(projectDir, family.id);
  const deletion: LedgerDeletion<LedgerEntry> = ledgerAfterDeleting(entries, id);

  const book = deletion.kept.length === 0
    ? await deriveWorkingCopy(projectDir, {
      from: 'base',
      base: await requireFamilySource(projectDir, family.id),
      keepRecords: true,
    }, family.id)
    : await deriveWorkingCopy(projectDir, {
      from: 'ledger', keep: deletion.kept, keepRecords: true,
    }, family.id);

  // `registerEpubExport` inside the derivation has already dropped the cascaded
  // entries and removed their directories — the record went first and the files
  // second, in one place, so this reports what happened rather than doing it a
  // second time.
  const removedPaths = deletion.cascaded
    .map((entry) => entry.dir)
    .filter((dir) => !fs.existsSync(toAbs(projectDir, dir)));

  const message = describeLedgerDeletion(deletion);
  console.log(`[manifest-service] ${path.basename(projectDir)}: ${message}`);
  return {
    dropped: [...deletion.cascaded],
    kept: [...deletion.kept],
    removedPaths,
    book,
    message,
  };
}

/**
 * The book's bytes changed in place, without the book becoming a different book.
 *
 * Exactly ONE kind of edit reaches this: a chapter retitle
 * (electron/book-chapters.ts), which rewrites the nav entry and the chapter
 * document's `<title>` and touches nothing a reader sees on the page. So the
 * record is amended rather than replaced — `registerEpubExport` is the other
 * shape of this and it is deliberately not what happens here: that one means a
 * NEW book has taken the old one's place, and it drops `appliedPasses` and the
 * narration copy with it. Neither is true of a retitle. The passes still ran
 * against this file and the narration copy is still cut from it, so throwing
 * either away would lose a true record to describe a change that did not happen.
 *
 * Refuses a project with no `outputs.epub` by name, for the same reason
 * `appendAppliedPass` does: the caller believes it just wrote a book this
 * project does not have.
 */
export async function touchBookEpub(
  projectDir: string,
  at: string,
  familyId?: string
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record an edit to ${projectDir}'s book: its ${family.id} chain records none, so `
        + 'there is no book to have been edited.'
      );
    }
    epub.modifiedAt = at;
  });
  if (!saved.success) {
    throw new Error(
      `The book was rewritten, but recording that in ${projectDir}'s manifest failed: ${saved.error}`
    );
  }
}

/** What the manifest did about a fold that has already been written to disk. */
export interface ChapterOpeningFoldRecord {
  /** Strike keys the fold left naming nothing, so they were dropped. */
  droppedStrikes: string[];
  /** Strike keys that name the same element under a new index. */
  renumberedStrikes: number;
}

/**
 * Record a chapter-opening fold: carry the strikes, touch the book, log the edit.
 *
 * ── Why all three are ONE transaction ───────────────────────────────────────
 *
 * Because they are one fact. The strikes are POSITIONS in the book and the fold
 * moved them (shared/vlm/narration-deletions.ts,
 * `migrateNarrationDeletionsForFold`); the record's `epubSha256` is what says
 * which book those positions are in; and the edit-log entry is the only thing
 * that will ever say what the opening used to print. A manifest written with
 * any two of the three would be a manifest that lies about the file on disk —
 * strikes carried but still stamped with the old book read as stale and get
 * cleared, and a re-stamped record whose indices were not carried strikes the
 * wrong paragraphs.
 *
 * The record's stamp is CHECKED against `fromSha256` rather than overwritten. A
 * record describing some other book cannot be carried — its indices are
 * positions in a file nobody has — and quietly re-stamping it here would forge
 * agreement. That is a refusal after the book has been written, which is the
 * right way round: the file is the user's edit and it is correct; the manifest
 * says why it could not follow.
 */
export async function recordChapterOpeningFold(
  projectDir: string,
  edit: MergeChapterOpeningEdit,
  removedIndices: readonly number[],
  familyId?: string,
): Promise<ChapterOpeningFoldRecord> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  let droppedStrikes: string[] = [];
  let renumberedStrikes = 0;

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record the chapter-opening fold in ${projectDir}: its ${family.id} chain records `
        + 'no book, so there is nothing to have been folded.'
      );
    }

    const recorded = epub.narrationDeletions;
    if (recorded !== undefined) {
      if (recorded.epubSha256 !== edit.fromSha256) {
        throw new Error(
          `${path.basename(projectDir)}'s narration strikes are stamped with a different book than `
          + 'the one that was just folded, so they name positions in a file nobody has and cannot '
          + 'be carried across the fold. The book has been edited; strike what you want left out '
          + 'of the narration again.'
        );
      }
      const carried = migrateNarrationDeletionsForFold(
        recorded.elements, edit.file, removedIndices);
      droppedStrikes = carried.dropped;
      renumberedStrikes = carried.renumbered;
      epub.narrationDeletions = {
        epubSha256: edit.toSha256,
        elements: carried.elements,
        updatedAt: edit.at,
      };
    }

    epub.modifiedAt = edit.at;
    (epub.bookEdits ??= []).push(edit);
  });
  if (!saved.success) {
    throw new Error(
      `The book was folded, but recording that in ${projectDir}'s manifest failed: ${saved.error}`
    );
  }
  return { droppedStrikes, renumberedStrikes };
}

/**
 * Record the chapter-opening naming: re-stamp the strikes, touch the book, log
 * the edit — one transaction, for the same reason the fold's is one.
 *
 * ── Why the strikes are RE-STAMPED and not migrated ────────────────────────
 *
 * Because the naming pass removes no element. Every edit it makes is text
 * inside one element, so every text-unit index and every image ordinal is
 * exactly where it was and each strike still names the element it named —
 * there is no renumbering to carry (contrast `recordChapterOpeningFold`, whose
 * whole difficulty is that a fold removes units). The record follows the book's
 * new bytes, with its keys untouched.
 *
 * The stamp is CHECKED against `fromSha256` rather than overwritten, exactly as
 * the fold checks it. A record describing some other book cannot be followed —
 * its positions are in a file nobody has — and quietly re-stamping it here
 * would forge agreement. The caller makes the same check BEFORE writing the
 * book, so this one should be unreachable; it is here because the manifest is
 * the thing being written and a guard that lives beside the write is the guard
 * that cannot be skipped by a future second caller.
 */
export async function recordChapterOpeningNaming(
  projectDir: string,
  edit: NameChapterOpenersEdit,
  familyId?: string,
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record the chapter-opening naming in ${projectDir}: its ${family.id} chain records `
        + 'no book, so there is nothing to have been named.'
      );
    }

    const recorded = epub.narrationDeletions;
    if (recorded !== undefined) {
      if (recorded.epubSha256 !== edit.fromSha256) {
        throw new Error(
          `${path.basename(projectDir)}'s narration strikes are stamped with a different book than `
          + 'the one whose chapter openings were just named, so they name positions in a file '
          + 'nobody has and cannot be carried onto it. The book has been edited; strike what you '
          + 'want left out of the narration again.'
        );
      }
      epub.narrationDeletions = {
        ...recorded,
        epubSha256: edit.toSha256,
        updatedAt: edit.at,
      };
    }

    epub.modifiedAt = edit.at;
    (epub.bookEdits ??= []).push(edit);
  });
  if (!saved.success) {
    throw new Error(
      `The book's chapter openings were named, but recording that in ${projectDir}'s manifest `
      + `failed: ${saved.error}`
    );
  }
}

/**
 * Record the ELEMENT-ID STAMP: re-stamp the strikes, touch the book, log the
 * edit — one transaction, for the same reason the naming pass's is one.
 *
 * ── Why the strikes are RE-STAMPED and not migrated ────────────────────────
 *
 * Because the stamp moves nothing. It writes an attribute onto elements that
 * were already there, and the synthesized wrappers it makes real were already IN
 * the walk — every reader has been creating them in memory and counting them for
 * as long as the walk has existed. So every text-unit index and every image
 * ordinal is exactly where it was, and each strike still names the element it
 * named. `stampElementIdsInBookFile` measures that claim against the written
 * file, per document, before this is ever reached.
 *
 * The sha256 pair on the edit is PROVENANCE — what the book was and what it
 * became. The stamp is the beginning of the end of sha-keyed records, but phase 1
 * changes no key format and retires nothing, so the strike record's own stamp
 * must follow the book across this edit like it follows it across every other.
 * A stamp that stranded the strike record would have thrown away the user's work
 * to lay the groundwork for keeping it.
 *
 * The stamp is CHECKED against `fromSha256` rather than overwritten, exactly as
 * the naming pass's record is. A record describing some other book cannot be
 * followed, and quietly re-stamping it here would forge agreement.
 */
export async function recordElementIdStamping(
  projectDir: string,
  edit: StampElementIdsEdit,
  familyId?: string,
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record the element-id stamp in ${projectDir}: its ${family.id} chain records no `
        + 'book, so there is nothing to have been stamped.'
      );
    }

    const recorded = epub.narrationDeletions;
    if (recorded !== undefined) {
      if (recorded.epubSha256 !== edit.fromSha256) {
        throw new Error(
          `${path.basename(projectDir)}'s narration strikes are stamped with a different book than `
          + 'the one whose elements were just given their ids, so they name positions in a file '
          + 'nobody has and cannot be carried onto it. The book has been edited; strike what you '
          + 'want left out of the narration again.'
        );
      }
      epub.narrationDeletions = {
        ...recorded,
        epubSha256: edit.toSha256,
        updatedAt: edit.at,
      };
    }

    epub.modifiedAt = edit.at;
    (epub.bookEdits ??= []).push(edit);
  });
  if (!saved.success) {
    throw new Error(
      `The book's elements were given their ids, but recording that in ${projectDir}'s manifest `
      + `failed: ${saved.error}`
    );
  }
}

/**
 * Record a RELABEL: re-stamp the strikes, touch the book, log the edit — one
 * transaction, for the same reason the naming pass's is one.
 *
 * The strikes are RE-STAMPED and not migrated because a relabel writes one
 * attribute on one element: nothing is added, removed or moved, so every
 * text-unit index and every image ordinal is exactly where it was and each
 * strike still names the element it named. `setElementCategoryInBookFile`
 * measures that claim against the written file before this is ever reached.
 *
 * The stamp is CHECKED against `fromSha256` rather than overwritten, exactly as
 * the naming pass's record is. A record describing some other book cannot be
 * followed, and quietly re-stamping it here would forge agreement.
 */
export async function recordBlockCategoryChange(
  projectDir: string,
  edit: SetBlockCategoryEdit,
  familyId?: string,
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record the relabel in ${projectDir}: its ${family.id} chain records no book, so `
        + 'there is no element to have been relabelled.'
      );
    }

    const recorded = epub.narrationDeletions;
    if (recorded !== undefined) {
      if (recorded.epubSha256 !== edit.fromSha256) {
        throw new Error(
          `${path.basename(projectDir)}'s narration strikes are stamped with a different book than `
          + 'the one whose element was just relabelled, so they name positions in a file nobody has '
          + 'and cannot be carried onto it. The book has been edited; strike what you want left out '
          + 'of the narration again.'
        );
      }
      epub.narrationDeletions = {
        ...recorded,
        epubSha256: edit.toSha256,
        updatedAt: edit.at,
      };
    }

    epub.modifiedAt = edit.at;
    (epub.bookEdits ??= []).push(edit);
  });
  if (!saved.success) {
    throw new Error(
      `${edit.elementKey} was relabelled in the book, but recording that in ${projectDir}'s `
      + `manifest failed: ${saved.error}`
    );
  }
}

/**
 * What has been done to the project's book, in execution order.
 *
 * The manifest's own list, verbatim. An empty array is a real answer three
 * times over: a project with no chain yet has had nothing done to any book, a
 * project with no book has had no passes applied to one, and a freshly built
 * book has had nothing done to it yet — and none is worth distinguishing here,
 * because the caller that cares whether there IS a book asks `readExportEpub`,
 * which answers that question exactly.
 */
export async function readAppliedPasses(
  projectDir: string,
  familyId?: string
): Promise<AppliedPass[]> {
  const resolved = await familyForListing(projectDir, familyId);
  return resolved?.family.epub?.appliedPasses ?? [];
}

/** Every pass that has a diff, in execution order, with the diff resolved. */
export async function listPassDiffs(projectDir: string, familyId?: string): Promise<Array<{
  kind: AppliedPassKind;
  at: string;
  params?: Record<string, unknown>;
  relPath: string;
  absPath: string;
}>> {
  const resolved = await familyForListing(projectDir, familyId);
  return (resolved?.family.epub?.appliedPasses ?? [])
    .filter((p) => !!p.diff)
    .map((p) => ({
      kind: p.kind,
      at: p.at,
      params: p.params,
      relPath: p.diff!,
      absPath: toAbs(projectDir, p.diff!),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The narration copy
//
// The book with what the user struck out of it removed — a SECOND file, cut
// from `outputs.epub` and never written over it. Everything about WHY is in
// shared/vlm/narration-deletions.ts; what lives here is where the file goes and
// how the two records are read and written, for the same reason the book's own
// name lives here: one derivation, one authority.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A project's manifest, straight off disk.
 *
 * The public face of `readManifestAt`, for callers outside this module that need
 * the WHOLE record rather than one derived answer — the layout-identity reader
 * (electron/editor-layout.ts) is one, because the records it counts live under
 * `editor` keys that neither manifest declaration admits, so no typed accessor
 * can hand them over.
 */
export async function readProjectManifest(projectDir: string): Promise<ProjectManifest> {
  return readManifestAt(projectDir);
}

/**
 * The record classes a change of paginator invalidates, retired in one write.
 *
 * ── Why it is one call and not four ────────────────────────────────────────
 *
 * Because the intermediate states are all lies. A manifest that has been stamped
 * with the current layout but still holds the old layout's deleted pages says
 * "these deletions are current" about numbers that are not; one that has had the
 * old records taken out but not the new ones put in says the user deleted
 * nothing. Either could be read by another window, or synced, in the moment
 * between two writes. `clearProcessingRecords` is one transaction for the same
 * reason.
 *
 * ── What it does with each class ───────────────────────────────────────────
 *
 * `deletions` is the carried-over set, expressed in the CURRENT layout, or null
 * when there was nothing to carry. `narration` is the same intent as element
 * keys, which is the form that survives the next change of paginator too, and is
 * written into `outputs.epub.narrationDeletions` — the record the narration cut
 * actually reads.
 *
 * Everything else the old layout explained is DELETED: `pageOrder` (a
 * permutation of a page count that no longer holds), the undo and redo stacks,
 * the chapter list, and every block-keyed field under `editor`. They are named
 * in the migration's own sentence rather than removed in silence; see
 * electron/legacy-epub-layout.ts for why each one cannot come across.
 *
 * `editor.ocrCategories`, `classificationThresholds`, `sourceFileSha256` and
 * `rubricPredictions` are LEFT ALONE — none of them names a position in a
 * layout, so none of them went stale (see LAYOUT_KEYED_EDITOR_FIELDS).
 */
export async function applyEditorLayoutMigration(
  projectDir: string,
  migration: {
    layout: EditorLayoutIdentity;
    deletions: { deletedPages: number[]; deletedBlockIds: string[] } | null;
    narration: { epubSha256: string; elements: string[] } | null;
  },
  familyId?: string,
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, async (m) => {
    const source = (m.source ?? {}) as unknown as Record<string, unknown>;
    if (migration.deletions) {
      source.deletedPages = migration.deletions.deletedPages;
      source.deletedBlockIds = migration.deletions.deletedBlockIds;
    } else {
      delete source.deletedPages;
      delete source.deletedBlockIds;
    }
    delete source.pageOrder;
    source[EDITOR_LAYOUT_MANIFEST_KEY] = migration.layout;

    // The retired editor fields, in the sidecar they live in now
    // (electron/editor-state-store.ts). Inside `modifyManifest`'s lock, and
    // after `adoptLegacyEditorKey` has moved any pre-sidecar copy there, so this
    // reads and writes the one authoritative copy. A project with no editor
    // state has nothing to retire and is NOT given an empty sidecar.
    const editor = await readEditorState(projectDir) as unknown as Record<string, unknown> | null;
    if (editor) {
      delete editor.undoStack;
      delete editor.redoStack;
      for (const field of LAYOUT_KEYED_EDITOR_FIELDS) delete editor[field];
      await writeEditorState(projectDir, editor);
    }

    // The picker's chapter markers are position-linked and mostly carry only a
    // page — a list where a fifth of them moved is a table of contents pointing
    // at the wrong chapters. A `toc`-sourced marker re-reads itself from the
    // book on the next open, so dropping them loses nothing that is derived.
    m.chapters = [];

    const epub = familyIn(m, family.id).epub;
    if (migration.narration && epub) {
      epub.narrationDeletions = {
        epubSha256: migration.narration.epubSha256,
        elements: [...migration.narration.elements].sort(),
        updatedAt: new Date().toISOString(),
      };
    }
  });
  if (!saved.success) {
    throw new Error(
      `Carrying ${path.basename(projectDir)}'s editor records into the current layout failed: `
      + `${saved.error}. Nothing was changed.`
    );
  }
}

/**
 * Stamp the layout a save's page and block records were made in.
 *
 * Called by the picker's save for an EPUB project, so that from now on a record
 * SAYS which pagination explains it instead of leaving a later build to infer
 * it from the absence of a stamp. Never called for a PDF: a PDF's pages are the
 * PDF's own and there is no pagination to have changed.
 */
export async function writeEditorLayout(
  projectDir: string,
  layout: EditorLayoutIdentity,
): Promise<void> {
  const manifest = await readManifestAt(projectDir);
  const projectId = requireLibraryProjectId(projectDir, manifest);
  const saved = await modifyManifest(projectId, (m) => {
    const source = (m.source ?? {}) as unknown as Record<string, unknown>;
    source[EDITOR_LAYOUT_MANIFEST_KEY] = layout;
  });
  if (!saved.success) {
    throw new Error(
      `Recording the layout ${path.basename(projectDir)}'s editor records were made in failed: `
      + `${saved.error}`
    );
  }
}

/** What the user has struck out of the project's book, or null when nothing. */
export async function readNarrationDeletions(
  projectDir: string,
  familyId?: string
): Promise<NarrationDeletions | null> {
  // Listing resolver, same reasoning as readExportEpub: no chain ⇒ no book ⇒
  // no deletions record — a real null, not a refusal.
  const resolved = await familyForListing(projectDir, familyId);
  return resolved?.family.epub?.narrationDeletions ?? null;
}

/**
 * What the PICKER's editor state says has been deleted — the OTHER deletion
 * record, and the reason this reader exists.
 *
 * There have been two records of the same intent for as long as the narration
 * copy has existed. A Select-mode block deletion and a page deletion land here,
 * in `manifest.source`, because that is where the picker's edit set is saved
 * and where the OCR/rebuild path reads it from. Element strikes land in
 * `outputs.epub.narrationDeletions`, because that is what the narration cut is
 * expressed in. The cut read only the second, so everything a user did in
 * Select mode on a book was invisible to it.
 *
 * `sourceType` travels with the answer because it is what says whether these
 * numbers are ABOUT the book at all: a project made from a PDF is curated on
 * the PDF, where a deleted page is a page of paper and a block id belongs to the
 * scan's layout — neither means anything in the book's mupdf pagination.
 */
export interface EditorStateDeletions {
  /** Block ids, in the layout they were struck in. */
  blockIds: string[];
  /** Page numbers, in that same layout. */
  pages: number[];
  /** What the project was made from. */
  sourceType: SourceType;
  /**
   * WHICH layout that was, or null when the project states none.
   *
   * It travels with the answer for the same reason `sourceType` does: without
   * it, "page 140" is a number with two possible meanings and no way to tell
   * which. On an EPUB project a null stamp means mupdf's reflow — see
   * `editorLayout` on ManifestSource — and the caller must translate through
   * that layout or refuse, never resolve the number against a fresh analysis.
   */
  layout: EditorLayoutIdentity | null;
}

export async function readEditorStateDeletions(
  projectDir: string
): Promise<EditorStateDeletions> {
  const manifest = await readManifestAt(projectDir);
  const source = manifest.source;
  if (!source) {
    throw new Error(
      `${path.basename(projectDir)}'s manifest has no source record, so it cannot say what the `
      + 'editor deleted or what the project was made from.'
    );
  }
  return {
    // An absent list is a real state — a project nothing has been deleted in —
    // and is the only thing an empty array can honestly mean here, because the
    // picker writes both keys on every save (main's `project:save-to-path`).
    blockIds: source.deletedBlockIds ?? [],
    pages: source.deletedPages ?? [],
    sourceType: source.type,
    layout: source[EDITOR_LAYOUT_MANIFEST_KEY] ?? null,
  };
}

/**
 * Record what the user has struck out, stamped with the book it was struck from.
 *
 * Refuses a project with no `outputs.epub` by name: a strike is positional
 * inside a specific file, and there is no such file to be positional inside.
 * An empty list is a real state and is stored — "I looked at the book and want
 * all of it" is an answer, and clearing the record instead would make it
 * indistinguishable from never having looked.
 */
export async function writeNarrationDeletions(
  projectDir: string,
  deletions: NarrationDeletions,
  familyId?: string
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record narration deletions for ${projectDir}: its ${family.id} chain records no `
        + 'book, so there is nothing for them to be strikes out of.'
      );
    }
    epub.narrationDeletions = deletions;
  });
  if (!saved.success) {
    throw new Error(`Recording the narration deletions for ${projectDir} failed: ${saved.error}`);
  }
}

/**
 * Apply ONE EDIT to the strike record, inside the project's lock.
 *
 * ── Why the read and the write are one call ─────────────────────────────────
 *
 * Because the record is now an ACCUMULATOR — the picker sends what a gesture
 * changed, not what is struck — and an accumulator read outside the lock and
 * written inside it loses whatever landed between the two. Two picker windows on
 * one project, or one window striking faster than the manifest writes, is enough
 * (a "delete all like this" over a book's footnotes is one gesture and hundreds
 * of elements arriving as one message, but the next gesture need not wait for
 * it). So the whole read-modify-write happens under `modifyManifest`, which is
 * the same lock `saveManifest` takes.
 *
 * `bookSha256` is measured by the caller from the file on disk and compared HERE
 * against the stamp the record carries.
 *
 * ── A mismatch MERGES, and does not re-stamp ────────────────────────────────
 *
 * Until 2026-08-10 a mismatch DELETED the record and returned the reason. It
 * does not any more, and this is one of the two places that mattered: a user
 * striking a paragraph in a picker whose book had moved under it lost every
 * strike they had made, as the side effect of making one more.
 *
 * So the edit merges. The new keys carry `fingerprints` taken from the book the
 * user is looking at, so they can prove themselves later whatever the stamp
 * says. The old keys are left alone with whatever they had.
 *
 * And the stamp is NOT advanced to `bookSha256`. Advancing it would say "every
 * key in this record was minted against these bytes", which is the fast path's
 * exact promise, and it is false for the keys that were already there —
 * including any that predate fingerprints and can therefore never be checked.
 * A stamp left stale costs a per-strike check at use, which is cheap and true;
 * a stamp advanced falsely costs the user a paragraph in an audiobook they hear
 * about six weeks later.
 */
export async function editNarrationDeletions(
  projectDir: string,
  bookSha256: string,
  edit: {
    strike: readonly string[];
    unstrike: readonly string[];
    /** What the struck elements say in the book the gesture was made on. */
    fingerprints?: Readonly<Record<string, string>>;
  },
  familyId?: string,
): Promise<{ deletions: NarrationDeletions; staleWarning: string | null }> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  let written: NarrationDeletions | null = null;
  let staleWarning: string | null = null;

  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (!epub) {
      throw new Error(
        `Cannot record narration deletions for ${projectDir}: its ${family.id} chain records no `
        + 'book, so there is nothing for them to be strikes out of.'
      );
    }
    const recorded = epub.narrationDeletions ?? null;
    staleWarning = narrationDeletionsStaleReason(recorded, bookSha256);

    const elements = new Set(recorded?.elements ?? []);
    for (const key of edit.unstrike) elements.delete(key);
    // AFTER the unstrikes: one gesture can do both (a page toggle over a mixed
    // selection), and an element named by both halves of it is struck.
    for (const key of edit.strike) elements.add(key);
    const kept = [...elements].sort();

    // The prints the record already holds, minus the keys that just left, plus
    // the ones this gesture measured. Prints for unstruck keys are dropped
    // because they describe nothing on record; a key struck again later is
    // fingerprinted again from the book as it is then.
    const fingerprints = narrationFingerprintsFor(
      { ...(recorded?.fingerprints ?? {}), ...(edit.fingerprints ?? {}) }, kept);

    written = {
      // The stamp only advances when it was already right. See above.
      epubSha256: staleWarning === null ? bookSha256 : recorded!.epubSha256,
      elements: kept,
      updatedAt: new Date().toISOString(),
      ...(Object.keys(fingerprints).length > 0 ? { fingerprints } : {}),
    };
    epub.narrationDeletions = written;
  });
  if (!saved.success) {
    throw new Error(`Recording the narration deletions for ${projectDir} failed: ${saved.error}`);
  }
  if (written === null) {
    throw new Error(
      `Editing the narration deletions for ${projectDir} wrote nothing and gave no reason — this `
      + 'is a bug.'
    );
  }
  return { deletions: written, staleWarning };
}

/** Forget the strikes — the book stays exactly as it is. */
export async function clearNarrationDeletions(
  projectDir: string,
  familyId?: string
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);
  const saved = await modifyManifest(projectId, (m) => {
    const epub = familyIn(m, family.id).epub;
    if (epub) delete epub.narrationDeletions;
  });
  if (!saved.success) {
    throw new Error(`Clearing the narration deletions for ${projectDir} failed: ${saved.error}`);
  }
}

/**
 * Where the NEXT narration copy is written — derived from the BOOK's recorded
 * path, so it is named after the book and moves with it.
 *
 * Refuses a project with no book, because there is nothing to cut a copy from.
 */
export async function narrationEpubTarget(
  projectDir: string,
  familyId?: string
): Promise<ExportEpubLocation> {
  const book = await readExportEpub(projectDir, familyId);
  if (!book) {
    throw new Error(
      `${path.basename(projectDir)} has no book EPUB recorded on this chain, so there is `
      + 'nothing to cut a narration copy from. Convert or build the book first.'
    );
  }
  const relPath = narrationEpubRelPath(book.relPath);
  return { relPath, absPath: toAbs(projectDir, relPath) };
}

/**
 * Where the project's narration copy IS, or null when it has never been
 * exported. The record is the only answer — same rule as the book itself.
 */
export async function readNarrationEpub(
  projectDir: string,
  familyId?: string
): Promise<ExportEpubLocation | null> {
  // Listing resolver — see readExportEpub. No chain ⇒ no narration copy.
  const resolved = await familyForListing(projectDir, familyId);
  const recorded = resolved?.family.ttsEpub;
  if (!recorded?.path) return null;
  return {
    relPath: recorded.path,
    absPath: toAbs(projectDir, recorded.path),
    modifiedAt: recorded.modifiedAt,
  };
}

/**
 * The narration copy's WHOLE record, or null when it has never been exported.
 *
 * Separate from `readNarrationEpub` because that one answers "where is it",
 * which is all most callers want, and this one answers "which book was it cut
 * from and by how much" — the fields that say whether the copy still describes
 * the book on disk. A caller about to edit the book (electron/book-chapters.ts)
 * has to know that before it can decide whether the copy can come with it.
 */
export async function readNarrationEpubRecord(
  projectDir: string,
  familyId?: string
): Promise<NarrationEpubOutput | null> {
  // Listing resolver — see readExportEpub. No chain ⇒ no narration copy.
  const resolved = await familyForListing(projectDir, familyId);
  return resolved?.family.ttsEpub ?? null;
}

/**
 * Forget the project's narration copy — the record only; unlinking the file is
 * the caller's act, done after this returns.
 *
 * Records first, file last, the ordering every remover here uses: an
 * unrecorded stray is invisible, while a record naming a file that is gone is
 * what left the narration flow reading a path with nothing behind it — the
 * exact state the versions page used to refuse this delete to avoid. The copy
 * is the cheapest artifact in the project to lose: Export TTS copy cuts it
 * again from the book and the strikes, both of which are untouched by this.
 */
export async function forgetNarrationEpub(
  projectDir: string,
  familyId?: string
): Promise<ExportEpubLocation> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const recorded = family.ttsEpub;
  if (!recorded?.path) {
    throw new Error(
      `${path.basename(projectDir)}'s ${path.basename(family.source.path)} chain records no `
      + 'narration copy, so there is none to delete. The record is the only thing that says a '
      + 'chain has one.'
    );
  }
  const answer: ExportEpubLocation = {
    relPath: recorded.path,
    absPath: toAbs(projectDir, recorded.path),
    modifiedAt: recorded.modifiedAt,
  };
  const saved = await modifyManifest(projectId, (m) => {
    delete familyIn(m, family.id).ttsEpub;
  });
  if (!saved.success) {
    throw new Error(
      `Could not forget ${recorded.path} in ${path.basename(projectDir)}'s manifest: `
      + `${saved.error}. Nothing was deleted.`
    );
  }
  return answer;
}

/** Record a written narration copy against the chain it was cut from. */
export async function registerNarrationEpub(
  projectDir: string,
  record: NarrationEpubOutput,
  familyId?: string
): Promise<void> {
  const { manifest, family } = await requireFamily(projectDir, familyId);
  const projectId = requireLibraryProjectId(projectDir, manifest);

  const saved = await modifyManifest(projectId, (m) => {
    familyIn(m, family.id).ttsEpub = record;
  });
  if (!saved.success) {
    throw new Error(
      `The narration copy was written to ${record.path}, but recording it in the manifest failed: `
      + `${saved.error}`
    );
  }
}

/**
 * Which keys under `manifest.source` are records of a FOUNDRY RUN rather than of
 * the source document, and therefore die when the book starts over.
 *
 * `deletedBlockLines` is the family's founding member: the editor's deletions
 * said as scan LINE ids, stamped with the scan they were made against. Anything
 * shaped like it — an object (or array of objects) carrying a `scanId` — is one
 * of the same family, and that STRUCTURAL test is deliberate: the app keeps
 * growing these (the one-title rule's auto-discard ledger is the next), and a
 * hard-coded list would silently leave the newest one behind, refusing exports
 * forever against a scan that no longer exists.
 *
 * `deletedBlockIds` is the legacy shape (no scan stamp, block ids re-minted by
 * every blocks run), so it is named explicitly.
 *
 * NOT cleared: `deletedPages`, `pageOrder`, `removeBackgrounds`. Those are facts
 * about the SOURCE DOCUMENT — which of its pages to read, in what order — and a
 * re-scan does not invalidate a source page index. Starting the processing over
 * is not the same act as throwing away the user's page edits, which is what
 * `pipeline:reset-editor-state` is for.
 */
function isScanStampedRecord(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isScanStampedRecord);
  return !!value && typeof value === 'object' && 'scanId' in (value as Record<string, unknown>);
}

const LEGACY_SOURCE_RECORD_KEYS = ['deletedBlockIds'];

/** Which `manifest.source` keys a reset would clear, without clearing them. */
export function foundrySourceRecordKeys(manifest: ProjectManifest): string[] {
  const source = (manifest.source ?? {}) as unknown as Record<string, unknown>;
  const keys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (LEGACY_SOURCE_RECORD_KEYS.includes(key)) {
      // An empty array is what an untouched project carries — nothing to clear.
      if (Array.isArray(value) && value.length === 0) continue;
      keys.push(key);
      continue;
    }
    if (isScanStampedRecord(value)) keys.push(key);
  }
  return keys;
}

/**
 * Forget everything the manifest records ABOUT PROCESSING: which book EPUB the
 * project has, what was done to it, and the run-scoped records under `source`.
 *
 * One atomic write, through `modifyManifest`, so a reader (or Syncthing) never
 * sees a manifest that has dropped the record but kept the provenance.
 *
 * This clears the RECORD only. Deleting the book file is the caller's act and is
 * done after this returns — in that order, so a failure mid-reset leaves an
 * unrecorded stray (invisible to every consumer, per the export contract) rather
 * than a record pointing at a file that is gone.
 */
export async function clearProcessingRecords(projectDir: string, familyId?: string): Promise<{
  hadEpubRecord: boolean;
  appliedPasses: number;
  clearedSourceKeys: string[];
}> {
  // Through the listing resolver, not the act's: a project with no working
  // chain yet still has source records a reset must clear — the PDF editor's
  // block deletions live under `manifest.source`, not under any chain.
  const resolved = await familyForListing(projectDir, familyId);
  const manifest = resolved ? resolved.manifest : await readManifestAt(projectDir);
  const family = resolved?.family ?? null;
  const projectId = requireLibraryProjectId(projectDir, manifest);
  const hadEpubRecord = !!family?.epub;
  const appliedPasses = family?.epub?.appliedPasses?.length ?? 0;
  const clearedSourceKeys = foundrySourceRecordKeys(manifest);

  const saved = await modifyManifest(projectId, (m) => {
    if (family) {
      const target = familyIn(m, family.id);
      delete target.epub;
      // Cut from the book, and going with it. Its file is in the reset's own
      // item list, named, so the user reads it before saying yes.
      delete target.ttsEpub;
    }
    const source = m.source as unknown as Record<string, unknown> | undefined;
    if (source) for (const key of clearedSourceKeys) delete source[key];
  });
  if (!saved.success) {
    throw new Error(`Could not clear ${projectDir}'s processing records: ${saved.error}`);
  }
  return { hadEpubRecord, appliedPasses, clearedSourceKeys };
}

/**
 * The project's cover image as an absolute path, or null when it has none.
 *
 * `metadata.coverPath` is library-relative (covers live in `{library}/media/`),
 * so it resolves against the library root, not the project. A book without a
 * cover is ordinary — this returns null rather than throwing.
 */
export async function resolveProjectCover(projectDir: string): Promise<string | null> {
  const manifest = await readManifestAt(projectDir);

  const recorded = manifest.metadata?.coverPath;
  if (recorded) {
    const abs = path.join(getLibraryBasePath(), recorded.split('/').join(path.sep));
    if (fs.existsSync(abs)) return abs;
    console.warn(`[ManifestService] manifest.metadata.coverPath points at a missing file: ${abs}`);
  }

  const sourceDir = path.join(projectDir, 'source');
  try {
    const names = await fs.promises.readdir(sourceDir);
    const cover = names.find((n) => /^cover\.(jpe?g|png)$/i.test(n));
    if (cover) return path.join(sourceDir, cover);
  } catch { /* no source dir */ }

  return null;
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
 * Which kinds of narration a project has, derived from its REAL variant list.
 *
 * This must go through getVariants() rather than reading outputs.audiobook and
 * manifest.variants separately, because those two overlap: a professionally narrated
 * import is recorded BOTH as outputs.audiobook and as a stored variant pointing at the
 * same m4b. getVariants dedupes them by normalized path and stamps one
 * professionallyRead per real file; counting the raw fields instead applies two
 * different defaults to one audiobook — `outputs.audiobook` defaults to AI unless the
 * source was an import, a stored variant defaults to professional — so a single human
 * narration reads as both at once. That is exactly what put the Deathstalker and
 * Wool/Shift/Dust imports under "AI Narrated" when they have no TTS render at all.
 */
export function getNarrationFlags(manifest: ProjectManifest): NarrationFlags {
  const audiobooks = getVariants(manifest).variants.filter((v) => v.kind === 'audiobook');
  // getVariants stamps a definite professionallyRead on every audiobook variant, so
  // these are exhaustive rather than "true vs everything else".
  return {
    professional: audiobooks.some((v) => v.professionallyRead === true),
    ai: audiobooks.some((v) => v.professionallyRead === false),
  };
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
    const dirs = entries.filter(entry => entry.isDirectory());

    /**
     * Read every manifest concurrently.
     *
     * This runs on every Studio load and is the one phase the book list genuinely
     * has to wait for, so it does the minimum work possible: the reads overlap
     * instead of queueing one project behind the next, and a missing manifest is
     * detected from the read's own ENOENT rather than a separate existsSync — which
     * halves the filesystem round-trips against a library that may be on a synced
     * or network volume, where each one carries real latency.
     */
    const results = await Promise.all(dirs.map(async (entry): Promise<ProjectManifest | null> => {
      const manifestPath = path.join(projectsDir, entry.name, MANIFEST_FILENAME);

      let content: string;
      try {
        content = await fs.promises.readFile(manifestPath, 'utf-8');
      } catch (err) {
        // A directory without a manifest simply isn't a project — expected, silent.
        // Anything else (permissions, I/O) is worth knowing about.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[ManifestService] Could not read manifest in ${entry.name}:`, (err as Error).message);
        }
        return null;
      }

      try {
        const manifest = JSON.parse(content) as ProjectManifest;

        // The folder name on disk is authoritative — use it as projectId so all
        // downstream fs.* calls resolve correctly on Windows (NTFS is normalization-
        // sensitive, and manifests written on macOS may store projectId in NFD form
        // while the folder on disk is NFC, or vice versa).
        manifest.projectId = normalizeFsPath(entry.name);

        return manifest;
      } catch {
        // Skip invalid manifests
        console.warn(`[ManifestService] Invalid manifest in ${entry.name}`);
        return null;
      }
    }));

    const projects = results.filter((m): m is ProjectManifest =>
      m !== null && (!filter?.type || m.projectType === filter.type));

    // Sort by modification date (newest first)
    projects.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    // Derived here, alongside the manifests they describe, so the renderer never has to
    // re-derive variant semantics it can't see (and so this costs no extra disk reads).
    // Kept OUT of the manifest objects themselves — this is computed state, not stored.
    const narration: Record<string, NarrationFlags> = {};
    for (const manifest of projects) {
      narration[manifest.projectId] = getNarrationFlags(manifest);
    }

    return {
      success: true,
      projects,
      narration,
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
