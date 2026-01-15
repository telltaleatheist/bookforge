import { Injectable, inject, signal, effect, DestroyRef } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction } from './editor-state.service';

export interface BookForgeProject {
  version: number;
  source_path: string;
  source_name: string;
  deleted_block_ids: string[];
  page_order?: number[];
  undo_stack?: HistoryAction[];
  redo_stack?: HistoryAction[];
  created_at: string;
  modified_at: string;
}

export interface ProjectListItem {
  name: string;
  path: string;
  sourceName: string;
  sourcePath: string;
  modifiedAt: string;
  createdAt: string;
}

/**
 * ProjectService - Manages project saving, loading, and auto-save
 *
 * Features:
 * - Auto-create project when PDF opens
 * - Auto-save on changes (debounced)
 * - Project list management
 * - Import/export projects
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectService {
  private readonly electronService = inject(ElectronService);
  private readonly editorState = inject(PdfEditorStateService);
  private readonly destroyRef = inject(DestroyRef);

  // Project state
  readonly projectPath = signal<string | null>(null);

  // Auto-save configuration
  private readonly AUTO_SAVE_DELAY = 1000; // 1 second debounce
  private autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;

  // Auto-save effect
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

  // Auto-create project when PDF is opened
  async autoCreateProject(pdfPath: string, pdfName: string): Promise<void> {
    const projectName = pdfName.replace(/\.[^.]+$/, '');

    // Check if project already exists for this PDF
    const existingProjects = await this.listProjects();
    const existing = existingProjects.find(p => p.sourcePath === pdfPath);

    if (existing) {
      // Load existing project
      await this.loadFromPath(existing.path);
      return;
    }

    // Create new project
    const projectData: BookForgeProject = {
      version: 1,
      source_path: pdfPath,
      source_name: pdfName,
      deleted_block_ids: [],
      page_order: [],
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const result = await this.electronService.saveProject(projectData, projectName + '.bfp');
    if (result.success && result.filePath) {
      this.projectPath.set(result.filePath);
    }
  }

  // Schedule auto-save (debounced)
  private scheduleAutoSave(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }

    this.autoSaveTimeout = setTimeout(() => {
      this.performAutoSave();
    }, this.AUTO_SAVE_DELAY);
  }

  // Perform the actual auto-save
  private async performAutoSave(): Promise<void> {
    const path = this.projectPath();
    if (!path || !this.editorState.pdfLoaded()) return;

    await this.saveToPath(path, true); // silent = true
  }

  // Save project to a specific path
  async saveToPath(filePath: string, silent: boolean = false): Promise<boolean> {
    const history = this.editorState.getHistory();
    const projectData: BookForgeProject = {
      version: 1,
      source_path: this.editorState.pdfPath(),
      source_name: this.editorState.pdfName(),
      deleted_block_ids: Array.from(this.editorState.deletedBlockIds()),
      page_order: this.editorState.pageOrder(),
      undo_stack: history.undoStack,
      redo_stack: history.redoStack,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const result = await this.electronService.saveProjectToPath(filePath, projectData);

    if (result.success) {
      this.editorState.markSaved();
      return true;
    }

    return false;
  }

  // Load project from a specific path
  async loadFromPath(filePath: string): Promise<BookForgeProject | null> {
    const result = await this.electronService.projectsLoadFromPath(filePath);

    if (result.success && result.data) {
      const project = result.data as BookForgeProject;
      this.projectPath.set(filePath);

      // Restore deletion state
      if (project.deleted_block_ids) {
        this.editorState.deletedBlockIds.set(new Set(project.deleted_block_ids));
      }

      // Restore page order
      if (project.page_order) {
        this.editorState.pageOrder.set(project.page_order);
      }

      // Restore undo/redo history
      if (project.undo_stack || project.redo_stack) {
        this.editorState.setHistory({
          undoStack: project.undo_stack || [],
          redoStack: project.redo_stack || []
        });
      }

      this.editorState.markSaved();
      return project;
    }

    return null;
  }

  // List all projects
  async listProjects(): Promise<ProjectListItem[]> {
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

  // Delete projects
  async deleteProjects(paths: string[]): Promise<boolean> {
    const result = await this.electronService.projectsDelete(paths);
    return result.success;
  }

  // Export project to external location
  async exportProject(): Promise<boolean> {
    const path = this.projectPath();
    if (!path) return false;

    const result = await this.electronService.projectsExport(path);
    return result.success;
  }

  // Import project from external location
  async importProject(): Promise<string[] | null> {
    const result = await this.electronService.projectsImport();
    if (result.success && result.imported.length > 0) {
      return result.imported;
    }
    return null;
  }

  // Clear project state
  reset(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
      this.autoSaveTimeout = null;
    }
    this.projectPath.set(null);
  }

  // Get current project data for serialization
  getProjectData(): BookForgeProject {
    const history = this.editorState.getHistory();
    return {
      version: 1,
      source_path: this.editorState.pdfPath(),
      source_name: this.editorState.pdfName(),
      deleted_block_ids: Array.from(this.editorState.deletedBlockIds()),
      page_order: this.editorState.pageOrder(),
      undo_stack: history.undoStack,
      redo_stack: history.redoStack,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };
  }
}
