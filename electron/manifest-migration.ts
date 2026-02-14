/**
 * Manifest Migration Service
 *
 * Migrates legacy project formats to unified manifest.json:
 * - BFP files from ~/Documents/BookForge/projects/
 * - Audiobook project.json from legacy audiobooks/ (now deprecated)
 * - Language learning project.json from ~/Documents/BookForge/language-learning/projects/
 *
 * Migration creates backups before modifying anything.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  createProject,
  getProjectPath,
  getManifestPath,
  saveManifest,
  atomicCopyFile,
  getLibraryBasePath,
} from './manifest-service.js';
import type {
  ProjectManifest,
  MigrationResult,
  MigrationProgress,
} from './manifest-types.js';

// Generate UUID v4 without external dependency
function uuidv4(): string {
  return crypto.randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// Types for Legacy Formats
// ─────────────────────────────────────────────────────────────────────────────

interface LegacyBfpProject {
  version?: number;
  source_path: string;
  source_name: string;
  deleted_block_ids?: string[];
  page_order?: number[];
  undo_stack?: any[];
  redo_stack?: any[];
  created_at: string;
  modified_at: string;
  metadata?: {
    title?: string;
    author?: string;
    authorFileAs?: string;
    year?: string;
    language?: string;
    publisher?: string;
    description?: string;
    coverImagePath?: string;
  };
  chapters?: any[];
  exportedAt?: string;
  exportedEpubPath?: string;
  audiobookFolder?: string;
  linkedAudioPath?: string;
  bilingualAudioPath?: string;
  bilingualVttPath?: string;
  vttPath?: string;
}

interface LegacyAudiobookProject {
  version?: number;
  originalFilename: string;
  metadata: {
    title: string;
    subtitle?: string;
    author: string;
    authorFirstName?: string;
    authorLastName?: string;
    year?: string;
    language: string;
    coverPath?: string;
    outputFilename?: string;
  };
  state: {
    cleanupStatus: string;
    cleanupProgress?: number;
    cleanupError?: string;
    cleanupJobId?: string;
    ttsStatus: string;
    ttsProgress?: number;
    ttsError?: string;
    ttsJobId?: string;
    ttsSessionId?: string;
    ttsSessionDir?: string;
    ttsSentenceProgress?: { completed: number; total: number };
    ttsSettings?: {
      device: string;
      language: string;
      voice: string;
      temperature: number;
      speed: number;
    };
    enhancementStatus?: string;
    enhancementProgress?: number;
    enhancementError?: string;
  };
  createdAt: string;
  modifiedAt: string;
}

interface LegacyLanguageLearningProject {
  id: string;
  sourceUrl: string;
  title: string;
  byline?: string;
  excerpt?: string;
  wordCount?: number;
  sourceLang: string;
  targetLang: string;
  status: string;
  htmlPath: string;
  content?: string;
  textContent?: string;
  deletedSelectors: string[];
  undoStack?: any[];
  redoStack?: any[];
  bilingualEpubPath?: string;
  audiobookPath?: string;
  vttPath?: string;
  errorMessage?: string;
  createdAt: string;
  modifiedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Tracking
// ─────────────────────────────────────────────────────────────────────────────

type ProgressCallback = (progress: MigrationProgress) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Migration Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan for all legacy projects that need migration
 */
export async function scanLegacyProjects(): Promise<{
  bfpFiles: string[];
  audiobookFolders: string[];
  articleFolders: string[];
}> {
  const libraryPath = getLibraryBasePath();

  const bfpFiles: string[] = [];
  const audiobookFolders: string[] = [];
  const articleFolders: string[] = [];

  // Scan BFP files
  const bfpDir = path.join(libraryPath, 'projects');
  if (fs.existsSync(bfpDir)) {
    const entries = await fs.promises.readdir(bfpDir);
    for (const entry of entries) {
      if (entry.endsWith('.bfp')) {
        bfpFiles.push(path.join(bfpDir, entry));
      }
    }
  }

  // Legacy audiobooks/ and language-learning/ scanning removed — data moved to deprecated/

  return { bfpFiles, audiobookFolders, articleFolders };
}

/**
 * Create backup of legacy folder
 */
async function createBackup(sourcePath: string, backupDir: string): Promise<string> {
  const name = path.basename(sourcePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${name}_${timestamp}`;
  const backupPath = path.join(backupDir, backupName);

  await fs.promises.mkdir(backupDir, { recursive: true });

  if (fs.statSync(sourcePath).isDirectory()) {
    await copyDirectoryRecursive(sourcePath, backupPath);
  } else {
    await fs.promises.copyFile(sourcePath, backupPath);
  }

  return backupPath;
}

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

/**
 * Migrate a single BFP file + associated audiobook folder
 */
export async function migrateBfpProject(
  bfpPath: string,
  backupDir: string
): Promise<MigrationResult> {
  const warnings: string[] = [];

  try {
    // Read BFP file
    const bfpContent = await fs.promises.readFile(bfpPath, 'utf-8');
    const bfp: LegacyBfpProject = JSON.parse(bfpContent);

    // Create backup
    await createBackup(bfpPath, backupDir);

    // Also backup audiobook folder if exists
    if (bfp.audiobookFolder && fs.existsSync(bfp.audiobookFolder)) {
      await createBackup(bfp.audiobookFolder, backupDir);
    }

    // Create new project structure
    const createResult = await createProject(
      'book',
      {
        type: bfp.source_name?.endsWith('.epub') ? 'epub' : 'pdf',
        originalFilename: bfp.source_name || path.basename(bfp.source_path),
        deletedBlockIds: bfp.deleted_block_ids,
        pageOrder: bfp.page_order,
      },
      {
        title: bfp.metadata?.title || bfp.source_name?.replace(/\.(epub|pdf)$/i, '') || 'Untitled',
        author: bfp.metadata?.author || 'Unknown',
        authorFileAs: bfp.metadata?.authorFileAs,
        year: bfp.metadata?.year,
        language: bfp.metadata?.language || 'en',
        publisher: bfp.metadata?.publisher,
        description: bfp.metadata?.description,
      }
    );

    if (!createResult.success) {
      return { success: false, error: createResult.error, warnings };
    }

    // Use the projectPath from createResult, not the local projectId
    const projectPath = createResult.projectPath!;

    // Copy source file if it exists
    if (bfp.source_path && fs.existsSync(bfp.source_path)) {
      const sourceFilename = path.basename(bfp.source_path);
      const targetPath = path.join(projectPath, 'source', `original${path.extname(sourceFilename)}`);
      await atomicCopyFile(bfp.source_path, targetPath);
    } else {
      warnings.push(`Source file not found: ${bfp.source_path}`);
    }

    // Copy exported EPUB if exists (user-edited version from PDF picker)
    if (bfp.exportedEpubPath && fs.existsSync(bfp.exportedEpubPath)) {
      const targetPath = path.join(projectPath, 'source', 'exported.epub');
      await atomicCopyFile(bfp.exportedEpubPath, targetPath);
    }

    // Copy cover image if exists
    let coverPath: string | undefined;
    if (bfp.metadata?.coverImagePath) {
      const coverSourcePath = bfp.metadata.coverImagePath;
      if (fs.existsSync(coverSourcePath)) {
        const coverFilename = path.basename(coverSourcePath);
        const targetCoverPath = path.join(projectPath, 'source', coverFilename);
        await atomicCopyFile(coverSourcePath, targetCoverPath);
        coverPath = `source/${coverFilename}`;
      }
    }

    // If there's an audiobook folder, migrate its contents
    let audiobookProjectData: LegacyAudiobookProject | null = null;
    if (bfp.audiobookFolder && fs.existsSync(bfp.audiobookFolder)) {
      const abProjectPath = path.join(bfp.audiobookFolder, 'project.json');
      if (fs.existsSync(abProjectPath)) {
        const abContent = await fs.promises.readFile(abProjectPath, 'utf-8');
        audiobookProjectData = JSON.parse(abContent);
      }

      // Copy cleaned/simplified EPUB if exists (check all naming conventions)
      const cleanedCandidates = ['simplified.epub', 'cleaned.epub', 'exported_cleaned.epub'];
      for (const candidate of cleanedCandidates) {
        const candidatePath = path.join(bfp.audiobookFolder, candidate);
        if (fs.existsSync(candidatePath)) {
          const targetPath = path.join(projectPath, 'stages', '01-cleanup', 'cleaned.epub');
          await atomicCopyFile(candidatePath, targetPath);
          break; // Use first found
        }
      }

      // Copy diff cache if exists
      const diffCachePath = path.join(bfp.audiobookFolder, 'diff-cache');
      if (fs.existsSync(diffCachePath)) {
        const targetPath = path.join(projectPath, 'stages', '01-cleanup', 'diff-cache');
        await copyDirectoryRecursive(diffCachePath, targetPath);
      }

      // Copy output.m4b if exists
      const outputM4bPath = path.join(bfp.audiobookFolder, 'output.m4b');
      if (fs.existsSync(outputM4bPath)) {
        const targetPath = path.join(projectPath, 'output', 'audiobook.m4b');
        await atomicCopyFile(outputM4bPath, targetPath);
      }

      // Copy VTT if exists
      const vttPath = path.join(bfp.audiobookFolder, 'subtitles.vtt');
      if (fs.existsSync(vttPath)) {
        const targetPath = path.join(projectPath, 'output', 'audiobook.vtt');
        await atomicCopyFile(vttPath, targetPath);
      }
    }

    // Update manifest with migrated data
    const manifestResult = await updateMigratedManifest(
      createResult.projectId!,
      bfp,
      audiobookProjectData,
      coverPath
    );

    if (!manifestResult.success) {
      return { success: false, error: manifestResult.error, warnings };
    }

    return {
      success: true,
      projectId: createResult.projectId!,
      manifestPath: getManifestPath(createResult.projectId!),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error: any) {
    return { success: false, error: error.message, warnings };
  }
}

/**
 * Migrate a standalone audiobook folder (no BFP)
 */
export async function migrateAudiobookFolder(
  folderPath: string,
  backupDir: string
): Promise<MigrationResult> {
  const warnings: string[] = [];

  try {
    const projectJsonPath = path.join(folderPath, 'project.json');
    if (!fs.existsSync(projectJsonPath)) {
      return { success: false, error: 'No project.json found' };
    }

    const content = await fs.promises.readFile(projectJsonPath, 'utf-8');
    const abProject: LegacyAudiobookProject = JSON.parse(content);

    // Create backup
    await createBackup(folderPath, backupDir);

    // Create new project
    const createResult = await createProject(
      'book',
      {
        type: 'epub',
        originalFilename: abProject.originalFilename,
      },
      {
        title: abProject.metadata.title,
        author: abProject.metadata.author,
        year: abProject.metadata.year,
        language: abProject.metadata.language || 'en',
        outputFilename: abProject.metadata.outputFilename,
      }
    );

    if (!createResult.success) {
      return { success: false, error: createResult.error, warnings };
    }

    // Use the projectPath from createResult, not the local projectId
    const projectPath = createResult.projectPath!;

    // Copy files from audiobook folder
    // Note: cleaned/simplified EPUBs are handled separately below with priority logic
    const filesToCopy = [
      { src: 'exported.epub', dest: 'source/original.epub' },
      { src: 'output.m4b', dest: 'output/audiobook.m4b' },
      { src: 'subtitles.vtt', dest: 'output/audiobook.vtt' },
    ];

    for (const { src, dest } of filesToCopy) {
      const srcPath = path.join(folderPath, src);
      if (fs.existsSync(srcPath)) {
        const destPath = path.join(projectPath, dest);
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await atomicCopyFile(srcPath, destPath);
      }
    }

    // Copy cleaned/simplified EPUB (check all naming conventions, use first found)
    const cleanedMigrationCandidates = ['simplified.epub', 'cleaned.epub', 'exported_cleaned.epub'];
    for (const candidate of cleanedMigrationCandidates) {
      const srcPath = path.join(folderPath, candidate);
      if (fs.existsSync(srcPath)) {
        const destPath = path.join(projectPath, 'stages', '01-cleanup', 'cleaned.epub');
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await atomicCopyFile(srcPath, destPath);
        break; // Use first found
      }
    }

    // Copy cover if exists
    let coverPath: string | undefined;
    if (abProject.metadata.coverPath) {
      const coverSrc = path.join(folderPath, abProject.metadata.coverPath);
      if (fs.existsSync(coverSrc)) {
        const coverFilename = path.basename(abProject.metadata.coverPath);
        const coverDest = path.join(projectPath, 'source', coverFilename);
        await atomicCopyFile(coverSrc, coverDest);
        coverPath = `source/${coverFilename}`;
      }
    }

    // Get manifest and update it
    const manifestPath = getManifestPath(createResult.projectId!);
    const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest: ProjectManifest = JSON.parse(manifestContent);

    // Update with audiobook state
    if (coverPath) {
      manifest.metadata.coverPath = coverPath;
    }

    if (abProject.state.cleanupStatus === 'complete') {
      manifest.pipeline.cleanup = {
        status: 'complete',
        outputPath: 'stages/01-cleanup/output.epub',
        completedAt: abProject.modifiedAt,
      };
    }

    if (abProject.state.ttsStatus === 'complete') {
      const lang = abProject.metadata.language || 'en';
      manifest.pipeline.tts = {
        [lang]: {
          status: 'complete',
          sessionId: abProject.state.ttsSessionId,
          completedAt: abProject.modifiedAt,
          settings: abProject.state.ttsSettings ? {
            engine: 'xtts',
            device: abProject.state.ttsSettings.device as any,
            voice: abProject.state.ttsSettings.voice,
            temperature: abProject.state.ttsSettings.temperature,
            speed: abProject.state.ttsSettings.speed,
          } : undefined,
        },
      };
    }

    // Check for output files
    if (fs.existsSync(path.join(projectPath, 'output', 'audiobook.m4b'))) {
      manifest.outputs.audiobook = {
        path: 'output/audiobook.m4b',
        vttPath: fs.existsSync(path.join(projectPath, 'output', 'audiobook.vtt'))
          ? 'output/audiobook.vtt'
          : undefined,
        completedAt: abProject.modifiedAt,
      };
    }

    manifest.createdAt = abProject.createdAt;
    manifest.modifiedAt = abProject.modifiedAt;

    await saveManifest(manifest);

    return {
      success: true,
      projectId: createResult.projectId!,
      manifestPath,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error: any) {
    return { success: false, error: error.message, warnings };
  }
}

/**
 * Migrate a language learning project
 */
export async function migrateArticleProject(
  folderPath: string,
  backupDir: string
): Promise<MigrationResult> {
  const warnings: string[] = [];

  try {
    const projectJsonPath = path.join(folderPath, 'project.json');
    if (!fs.existsSync(projectJsonPath)) {
      return { success: false, error: 'No project.json found' };
    }

    const content = await fs.promises.readFile(projectJsonPath, 'utf-8');
    const llProject: LegacyLanguageLearningProject = JSON.parse(content);

    // Create backup
    await createBackup(folderPath, backupDir);

    // Create new project
    const createResult = await createProject(
      'article',
      {
        type: 'url',
        originalFilename: llProject.title || 'article',
        url: llProject.sourceUrl,
        fetchedAt: llProject.createdAt,
      },
      {
        title: llProject.title,
        author: llProject.byline || 'Unknown',
        byline: llProject.byline,
        excerpt: llProject.excerpt,
        wordCount: llProject.wordCount,
        language: llProject.sourceLang || 'en',
      }
    );

    if (!createResult.success) {
      return { success: false, error: createResult.error, warnings };
    }

    // Use the projectPath from createResult, not the local projectId
    const projectPath = createResult.projectPath!;

    // Copy HTML file
    if (llProject.htmlPath && fs.existsSync(llProject.htmlPath)) {
      const destPath = path.join(projectPath, 'source', 'article.html');
      await atomicCopyFile(llProject.htmlPath, destPath);
    } else if (fs.existsSync(path.join(folderPath, 'source.html'))) {
      const destPath = path.join(projectPath, 'source', 'article.html');
      await atomicCopyFile(path.join(folderPath, 'source.html'), destPath);
    }

    // Copy sentence pairs if they exist
    const sentencePairsPath = path.join(folderPath, 'sentence_pairs.json');
    if (fs.existsSync(sentencePairsPath)) {
      const destPath = path.join(projectPath, 'stages', '02-translate', 'sentence_pairs.json');
      await atomicCopyFile(sentencePairsPath, destPath);
    }

    // Copy bilingual EPUB if exists
    if (llProject.bilingualEpubPath && fs.existsSync(llProject.bilingualEpubPath)) {
      const destPath = path.join(projectPath, 'stages', '02-translate', 'bilingual.epub');
      await atomicCopyFile(llProject.bilingualEpubPath, destPath);
    }

    // Copy audiobook if exists
    if (llProject.audiobookPath && fs.existsSync(llProject.audiobookPath)) {
      const destPath = path.join(projectPath, 'output', 'audiobook.m4b');
      await atomicCopyFile(llProject.audiobookPath, destPath);
    }

    // Copy VTT if exists
    if (llProject.vttPath && fs.existsSync(llProject.vttPath)) {
      const destPath = path.join(projectPath, 'output', 'audiobook.vtt');
      await atomicCopyFile(llProject.vttPath, destPath);
    }

    // Update manifest
    const manifestPath = getManifestPath(createResult.projectId!);
    const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest: ProjectManifest = JSON.parse(manifestContent);

    // Add editor state
    manifest.editor = {
      deletedSelectors: llProject.deletedSelectors || [],
      undoStack: llProject.undoStack?.map(a => ({
        type: a.type,
        ids: a.selectors || [],
        timestamp: a.timestamp,
      })) || [],
      redoStack: llProject.redoStack?.map(a => ({
        type: a.type,
        ids: a.selectors || [],
        timestamp: a.timestamp,
      })) || [],
    };

    // Add translation stage if content was translated
    if (fs.existsSync(path.join(projectPath, 'stages', '02-translate', 'sentence_pairs.json'))) {
      manifest.pipeline.translations = {
        [llProject.targetLang]: {
          status: 'complete',
          completedAt: llProject.modifiedAt,
        },
      };
    }

    // Add output if audiobook exists
    if (fs.existsSync(path.join(projectPath, 'output', 'audiobook.m4b'))) {
      const langPair = `${llProject.sourceLang}-${llProject.targetLang}`;
      manifest.outputs.bilingualAudiobooks = {
        [langPair]: {
          path: 'output/audiobook.m4b',
          vttPath: fs.existsSync(path.join(projectPath, 'output', 'audiobook.vtt'))
            ? 'output/audiobook.vtt'
            : undefined,
          completedAt: llProject.modifiedAt,
        },
      };
    }

    manifest.createdAt = llProject.createdAt;
    manifest.modifiedAt = llProject.modifiedAt;

    await saveManifest(manifest);

    return {
      success: true,
      projectId: createResult.projectId!,
      manifestPath,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error: any) {
    return { success: false, error: error.message, warnings };
  }
}

/**
 * Update manifest with data from BFP and audiobook project
 */
async function updateMigratedManifest(
  projectId: string,
  bfp: LegacyBfpProject,
  abProject: LegacyAudiobookProject | null,
  coverPath?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const manifestPath = getManifestPath(projectId);
    const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest: ProjectManifest = JSON.parse(manifestContent);

    // Update metadata with cover
    if (coverPath) {
      manifest.metadata.coverPath = coverPath;
    }

    // Add editor state
    manifest.editor = {
      undoStack: bfp.undo_stack?.map(a => ({
        type: a.type,
        ids: a.ids || a.blockIds || [],
        timestamp: a.timestamp || new Date().toISOString(),
      })) || [],
      redoStack: bfp.redo_stack?.map(a => ({
        type: a.type,
        ids: a.ids || a.blockIds || [],
        timestamp: a.timestamp || new Date().toISOString(),
      })) || [],
    };

    // If we have audiobook project data, add pipeline state
    if (abProject) {
      if (abProject.state.cleanupStatus === 'complete') {
        manifest.pipeline.cleanup = {
          status: 'complete',
          outputPath: 'stages/01-cleanup/cleaned.epub',
          completedAt: abProject.modifiedAt,
        };
      }

      if (abProject.state.ttsStatus === 'complete') {
        const lang = abProject.metadata.language || 'en';
        manifest.pipeline.tts = {
          [lang]: {
            status: 'complete',
            sessionId: abProject.state.ttsSessionId,
            completedAt: abProject.modifiedAt,
            settings: abProject.state.ttsSettings ? {
              engine: 'xtts',
              device: abProject.state.ttsSettings.device as any,
              voice: abProject.state.ttsSettings.voice,
              temperature: abProject.state.ttsSettings.temperature,
              speed: abProject.state.ttsSettings.speed,
            } : undefined,
          },
        };
      }

      // Check for output files
      const projectPath = getProjectPath(projectId);
      if (fs.existsSync(path.join(projectPath, 'output', 'audiobook.m4b'))) {
        manifest.outputs.audiobook = {
          path: 'output/audiobook.m4b',
          vttPath: fs.existsSync(path.join(projectPath, 'output', 'audiobook.vtt'))
            ? 'output/audiobook.vtt'
            : undefined,
          completedAt: abProject.modifiedAt,
        };
      }
    }

    // Set timestamps from BFP
    manifest.createdAt = bfp.created_at;
    manifest.modifiedAt = bfp.modified_at;

    await saveManifest(manifest);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Migrate all legacy projects
 */
export async function migrateAllProjects(
  onProgress?: ProgressCallback
): Promise<{
  success: boolean;
  migrated: string[];
  failed: Array<{ path: string; error: string }>;
}> {
  const libraryPath = getLibraryBasePath();
  const backupDir = path.join(libraryPath, 'deprecated', 'legacy-backup');

  const migrated: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Scan for legacy projects
  const { bfpFiles, audiobookFolders, articleFolders } = await scanLegacyProjects();
  const total = bfpFiles.length + audiobookFolders.length + articleFolders.length;

  if (total === 0) {
    onProgress?.({
      phase: 'complete',
      current: 0,
      total: 0,
      migratedProjects: [],
      failedProjects: [],
    });
    return { success: true, migrated: [], failed: [] };
  }

  let current = 0;

  onProgress?.({
    phase: 'scanning',
    current: 0,
    total,
    migratedProjects: [],
    failedProjects: [],
  });

  // Migrate BFP files (these may have associated audiobook folders)
  const migratedAudiobookFolders = new Set<string>();

  for (const bfpPath of bfpFiles) {
    current++;
    const name = path.basename(bfpPath);

    onProgress?.({
      phase: 'migrating',
      current,
      total,
      currentProject: name,
      migratedProjects: migrated,
      failedProjects: failed,
    });

    const result = await migrateBfpProject(bfpPath, backupDir);

    if (result.success) {
      migrated.push(name);

      // Track which audiobook folder was migrated with this BFP
      const bfpContent = await fs.promises.readFile(bfpPath, 'utf-8');
      const bfp: LegacyBfpProject = JSON.parse(bfpContent);
      if (bfp.audiobookFolder) {
        migratedAudiobookFolders.add(bfp.audiobookFolder);
      }
    } else {
      failed.push({ path: bfpPath, error: result.error || 'Unknown error' });
    }
  }

  // Migrate standalone audiobook folders (not associated with a BFP)
  for (const folderPath of audiobookFolders) {
    // Skip if already migrated with a BFP
    if (migratedAudiobookFolders.has(folderPath)) {
      continue;
    }

    current++;
    const name = path.basename(folderPath);

    onProgress?.({
      phase: 'migrating',
      current,
      total,
      currentProject: name,
      migratedProjects: migrated,
      failedProjects: failed,
    });

    const result = await migrateAudiobookFolder(folderPath, backupDir);

    if (result.success) {
      migrated.push(name);
    } else {
      failed.push({ path: folderPath, error: result.error || 'Unknown error' });
    }
  }

  // Migrate article projects
  for (const folderPath of articleFolders) {
    current++;
    const name = path.basename(folderPath);

    onProgress?.({
      phase: 'migrating',
      current,
      total,
      currentProject: name,
      migratedProjects: migrated,
      failedProjects: failed,
    });

    const result = await migrateArticleProject(folderPath, backupDir);

    if (result.success) {
      migrated.push(name);
    } else {
      failed.push({ path: folderPath, error: result.error || 'Unknown error' });
    }
  }

  onProgress?.({
    phase: 'complete',
    current: total,
    total,
    migratedProjects: migrated,
    failedProjects: failed,
  });

  return {
    success: failed.length === 0,
    migrated,
    failed,
  };
}

/**
 * Check if migration is needed
 */
export async function needsMigration(): Promise<boolean> {
  const { bfpFiles, audiobookFolders, articleFolders } = await scanLegacyProjects();
  return bfpFiles.length > 0 || audiobookFolders.length > 0 || articleFolders.length > 0;
}
