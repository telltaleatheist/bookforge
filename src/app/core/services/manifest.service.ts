import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import { LibraryService } from './library.service';
import type {
  ProjectManifest,
  ProjectType,
  ManifestSource,
  ManifestMetadata,
  ManifestUpdate,
  MigrationProgress,
  ManifestCreateResult,
  ManifestGetResult,
  ManifestSaveResult,
  ManifestListResult,
} from '../models/manifest.types';

/**
 * ManifestService - Angular service for unified project management
 *
 * Wraps the electron manifest IPC methods and provides reactive state
 * for project lists and migration status.
 */
@Injectable({
  providedIn: 'root'
})
export class ManifestService {
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);

  // Reactive state
  private readonly _projects = signal<ProjectManifest[]>([]);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _migrationProgress = signal<MigrationProgress | null>(null);
  private readonly _needsMigration = signal<boolean | null>(null);

  // Public computed signals
  readonly projects = computed(() => this._projects());
  readonly loading = computed(() => this._loading());
  readonly error = computed(() => this._error());
  readonly migrationProgress = computed(() => this._migrationProgress());
  readonly needsMigration = computed(() => this._needsMigration());

  constructor() {
    // Set up migration progress listener
    this.setupMigrationListener();
  }

  private setupMigrationListener(): void {
    if (!this.electronService.isRunningInElectron) return;

    (window as any).electron?.manifest?.onMigrationProgress?.((progress: MigrationProgress) => {
      this._migrationProgress.set(progress);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Project CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new project
   */
  async createProject(
    projectType: ProjectType,
    source: Partial<ManifestSource>,
    metadata: Partial<ManifestMetadata>
  ): Promise<ManifestCreateResult> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      return await (window as any).electron.manifest.create(projectType, source, metadata);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Get a project manifest by ID
   */
  async getProject(projectId: string): Promise<ManifestGetResult> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      return await (window as any).electron.manifest.get(projectId);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Update specific fields in a manifest
   */
  async updateProject(update: ManifestUpdate): Promise<ManifestSaveResult> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      return await (window as any).electron.manifest.update(update);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Delete a project
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      const result = await (window as any).electron.manifest.delete(projectId);
      if (result.success) {
        // Remove from local cache
        this._projects.update(projects => projects.filter(p => p.projectId !== projectId));
      }
      return result;
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Loading and Listing
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Load full project manifests
   */
  async loadProjects(filter?: { type?: ProjectType }): Promise<void> {
    if (!this.electronService.isRunningInElectron) return;

    this._loading.set(true);
    this._error.set(null);

    try {
      const result = await (window as any).electron.manifest.list(filter);
      if (result.success && result.projects) {
        this._projects.set(result.projects);
      } else {
        this._error.set(result.error || 'Failed to load projects');
      }
    } catch (e) {
      this._error.set((e as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // File Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Import a source file into a project
   */
  async importSourceFile(
    projectId: string,
    sourcePath: string,
    targetFilename?: string
  ): Promise<{ success: boolean; relativePath?: string; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      return await (window as any).electron.manifest.importSource(projectId, sourcePath, targetFilename);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Resolve a relative manifest path to absolute OS path
   */
  async resolvePath(projectId: string, relativePath: string): Promise<string | null> {
    if (!this.electronService.isRunningInElectron) return null;

    try {
      const result = await (window as any).electron.manifest.resolvePath(projectId, relativePath);
      return result.path;
    } catch {
      return null;
    }
  }

  /**
   * Get the absolute path to a project folder
   */
  async getProjectPath(projectId: string): Promise<string | null> {
    if (!this.electronService.isRunningInElectron) return null;

    try {
      const result = await (window as any).electron.manifest.getProjectPath(projectId);
      return result.path;
    } catch {
      return null;
    }
  }

  /**
   * Check if a project exists
   */
  async projectExists(projectId: string): Promise<boolean> {
    if (!this.electronService.isRunningInElectron) return false;

    try {
      const result = await (window as any).electron.manifest.exists(projectId);
      return result.exists;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Migration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if there are legacy projects that need migration
   */
  async checkMigrationNeeded(): Promise<boolean> {
    if (!this.electronService.isRunningInElectron) return false;

    try {
      const result = await (window as any).electron.manifest.needsMigration();
      this._needsMigration.set(result.needsMigration);
      return result.needsMigration;
    } catch {
      return false;
    }
  }

  /**
   * Scan for legacy projects
   */
  async scanLegacyProjects(): Promise<{
    success: boolean;
    bfpCount: number;
    audiobookCount: number;
    articleCount: number;
    total: number;
  }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, bfpCount: 0, audiobookCount: 0, articleCount: 0, total: 0 };
    }

    try {
      return await (window as any).electron.manifest.scanLegacy();
    } catch (e) {
      return { success: false, bfpCount: 0, audiobookCount: 0, articleCount: 0, total: 0 };
    }
  }

  /**
   * Migrate all legacy projects
   * Subscribe to migrationProgress signal for updates
   */
  async migrateAllProjects(): Promise<{
    success: boolean;
    migrated: string[];
    failed: Array<{ path: string; error: string }>;
  }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, migrated: [], failed: [] };
    }

    this._migrationProgress.set({
      phase: 'scanning',
      current: 0,
      total: 0,
      migratedProjects: [],
      failedProjects: [],
    });

    try {
      const result = await (window as any).electron.manifest.migrateAll();

      // Clear progress after completion
      setTimeout(() => {
        this._migrationProgress.set(null);
      }, 2000);

      if (result.success || result.migrated.length > 0) {
        this._needsMigration.set(false);
      }

      return result;
    } catch (e) {
      this._migrationProgress.set({
        phase: 'error',
        current: 0,
        total: 0,
        migratedProjects: [],
        failedProjects: [{ path: 'unknown', error: (e as Error).message }],
      });
      return { success: false, migrated: [], failed: [{ path: 'unknown', error: (e as Error).message }] };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Clear error state
   */
  clearError(): void {
    this._error.set(null);
  }

  /**
   * Clean up listeners
   */
  cleanup(): void {
    if (this.electronService.isRunningInElectron) {
      (window as any).electron?.manifest?.offMigrationProgress?.();
    }
  }
}
