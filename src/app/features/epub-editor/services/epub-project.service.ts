import { Injectable, inject, signal, effect, DestroyRef } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { EpubEditorStateService } from './epub-editor-state.service';
import { EpubChapter } from '../../../core/models/book-metadata.types';
import { EpubHistoryAction } from '../../../core/models/epub-highlight.types';

export interface EpubProject {
  version: number;
  source_path: string;
  source_name: string;
  deleted_block_ids: string[];
  chapters?: EpubChapter[];
  chapters_source?: 'toc' | 'heuristic' | 'manual' | 'mixed';
  undo_stack?: EpubHistoryAction[];
  redo_stack?: EpubHistoryAction[];
  created_at: string;
  modified_at: string;
}

export interface EpubProjectListItem {
  name: string;
  path: string;
  sourceName: string;
  sourcePath: string;
  modifiedAt: string;
  createdAt: string;
}

/**
 * EpubProjectService - Manages EPUB project saving, loading, and auto-save
 *
 * Features:
 * - Auto-create project when EPUB opens
 * - Auto-save on changes (debounced)
 * - Project list management
 */
@Injectable({
  providedIn: 'root'
})
export class EpubProjectService {
  private readonly electronService = inject(ElectronService);
  private readonly editorState = inject(EpubEditorStateService);
  private readonly destroyRef = inject(DestroyRef);

  // Project state
  readonly projectPath = signal<string | null>(null);

  // Auto-save configuration
  private readonly AUTO_SAVE_DELAY = 1000; // 1 second debounce
  private autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;

  // Auto-save effect - triggers when hasUnsavedChanges becomes true
  private readonly autoSaveEffect = effect(() => {
    if (this.editorState.hasUnsavedChanges() && this.projectPath()) {
      this.scheduleAutoSave();
    }
  });

  constructor() {
    // Clean up auto-save timeout on destroy
    this.destroyRef.onDestroy(() => {
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
      }
    });
  }

  /**
   * Auto-create or load project when EPUB is opened
   */
  async autoCreateProject(epubPath: string, epubName: string): Promise<void> {
    const projectName = epubName.replace(/\.[^.]+$/, '');

    // Check if project already exists for this EPUB
    const existingProjects = await this.listProjects();
    const existing = existingProjects.find(p => p.sourcePath === epubPath);

    if (existing) {
      // Load existing project
      await this.loadFromPath(existing.path);
      return;
    }

    // Create new project - save directly to projects folder (no dialog)
    const projectData: EpubProject = {
      version: 1,
      source_path: epubPath,
      source_name: epubName,
      deleted_block_ids: [],
      chapters: [],
      chapters_source: 'manual',
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const result = await this.electronService.projectsSave(projectData, projectName + '.bfp');
    if (result.success && result.filePath) {
      this.projectPath.set(result.filePath);
    }
  }

  /**
   * Schedule auto-save (debounced)
   */
  private scheduleAutoSave(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }

    this.autoSaveTimeout = setTimeout(() => {
      this.performAutoSave();
    }, this.AUTO_SAVE_DELAY);
  }

  /**
   * Perform the actual auto-save
   */
  private async performAutoSave(): Promise<void> {
    const path = this.projectPath();
    if (!path || !this.editorState.epubLoaded()) return;

    await this.saveToPath(path, true); // silent = true
  }

  /**
   * Save project to a specific path
   */
  async saveToPath(filePath: string, silent: boolean = false): Promise<boolean> {
    const history = this.editorState.getHistory();
    const projectData: EpubProject = {
      version: 1,
      source_path: this.editorState.epubPath(),
      source_name: this.editorState.epubName(),
      deleted_block_ids: Array.from(this.editorState.deletedBlockIds()),
      chapters: this.editorState.chapters(),
      chapters_source: this.editorState.chaptersSource(),
      undo_stack: history.undoStack,
      redo_stack: history.redoStack,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const result = await this.electronService.saveProjectToPath(filePath, projectData);

    if (result.success) {
      this.editorState.markSaved();
      if (!silent) {
        console.log('[EPUB Project] Saved to:', filePath);
      }
      return true;
    }

    console.error('[EPUB Project] Save failed:', result.error);
    return false;
  }

  /**
   * Load project from a specific path
   */
  async loadFromPath(filePath: string): Promise<EpubProject | null> {
    const result = await this.electronService.projectsLoadFromPath(filePath);

    if (result.success && result.data) {
      const project = result.data as EpubProject;
      this.projectPath.set(filePath);

      // Restore deletion state
      if (project.deleted_block_ids) {
        this.editorState.deletedBlockIds.set(new Set(project.deleted_block_ids));
      }

      // Restore chapters
      if (project.chapters) {
        this.editorState.chapters.set(project.chapters);
      }
      if (project.chapters_source) {
        this.editorState.chaptersSource.set(project.chapters_source);
      }

      // Restore undo/redo history
      if (project.undo_stack || project.redo_stack) {
        this.editorState.setHistory({
          undoStack: project.undo_stack || [],
          redoStack: project.redo_stack || []
        });
      }

      this.editorState.markSaved();
      console.log('[EPUB Project] Loaded from:', filePath);
      return project;
    }

    return null;
  }

  /**
   * List all projects
   */
  async listProjects(): Promise<EpubProjectListItem[]> {
    const result = await this.electronService.projectsList();
    if (result.success && result.projects) {
      return result.projects.map(p => ({
        name: p.name,
        path: p.path,
        sourceName: p.sourceName,
        sourcePath: p.sourcePath,
        modifiedAt: p.modifiedAt,
        createdAt: p.createdAt
      }));
    }
    return [];
  }

  /**
   * Clear project state
   */
  reset(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
      this.autoSaveTimeout = null;
    }
    this.projectPath.set(null);
  }

  /**
   * Get current project data for serialization
   */
  getProjectData(): EpubProject {
    const history = this.editorState.getHistory();
    return {
      version: 1,
      source_path: this.editorState.epubPath(),
      source_name: this.editorState.epubName(),
      deleted_block_ids: Array.from(this.editorState.deletedBlockIds()),
      chapters: this.editorState.chapters(),
      chapters_source: this.editorState.chaptersSource(),
      undo_stack: history.undoStack,
      redo_stack: history.redoStack,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };
  }
}
