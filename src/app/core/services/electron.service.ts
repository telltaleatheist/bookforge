import { Injectable } from '@angular/core';

interface BrowseResult {
  path: string;
  parent: string;
  items: Array<{ name: string; path: string; type: string; size: number | null }>;
}

interface PythonCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface ProjectSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

interface ProjectLoadResult {
  success: boolean;
  canceled?: boolean;
  data?: unknown;
  filePath?: string;
  error?: string;
}

interface OpenPdfResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

interface ProjectInfo {
  name: string;
  path: string;
  sourcePath: string;
  sourceName: string;
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
}

interface ProjectListResult {
  success: boolean;
  projects: ProjectInfo[];
  error?: string;
}

interface ProjectsDeleteResult {
  success: boolean;
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

interface ProjectsImportResult {
  success: boolean;
  canceled?: boolean;
  imported: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

/**
 * ElectronService - Provides access to Electron IPC from Angular
 *
 * In browser mode (ng serve without Electron), provides mock implementations
 * for development and testing.
 */
@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  private readonly isElectron: boolean;

  constructor() {
    this.isElectron = !!(window as any).electron;
  }

  get isRunningInElectron(): boolean {
    return this.isElectron;
  }

  get platform(): string {
    if (this.isElectron) {
      return (window as any).electron.platform;
    }
    return 'browser';
  }

  // File system operations
  async browse(dirPath: string): Promise<BrowseResult> {
    if (this.isElectron) {
      return (window as any).electron.fs.browse(dirPath);
    }

    // Mock for browser development - call HTTP API
    const response = await fetch(`http://localhost:5848/api/browse?path=${encodeURIComponent(dirPath)}`);
    return response.json();
  }

  // Python bridge operations
  async pythonCall(script: string, method: string, args: unknown[] = []): Promise<PythonCallResult> {
    if (this.isElectron) {
      return (window as any).electron.python.call(script, method, args);
    }

    // Mock for browser - would need HTTP backend
    console.warn('Python call not available in browser mode');
    return { success: false, error: 'Not running in Electron' };
  }

  async pythonSpawn(script: string, args: string[] = []): Promise<string> {
    if (this.isElectron) {
      return (window as any).electron.python.spawn(script, args);
    }

    console.warn('Python spawn not available in browser mode');
    return '';
  }

  async pythonKill(processId: string): Promise<boolean> {
    if (this.isElectron) {
      return (window as any).electron.python.kill(processId);
    }
    return false;
  }

  async pythonList(): Promise<Array<{ id: string; script: string; status: string; runtime: number }>> {
    if (this.isElectron) {
      return (window as any).electron.python.list();
    }
    return [];
  }

  async renderPage(pageNum: number, scale: number = 2.0, pdfPath?: string): Promise<string | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.python.renderPage(pageNum, scale, pdfPath);
      if (result.success && result.data?.image) {
        return `data:image/png;base64,${result.data.image}`;
      }
      console.error('Failed to render page:', result.error);
      return null;
    }

    // HTTP fallback for browser mode
    return `http://localhost:5848/api/page/${pageNum}?scale=${scale}`;
  }

  // Project file operations
  async saveProject(projectData: unknown, suggestedName?: string): Promise<ProjectSaveResult> {
    if (this.isElectron) {
      return (window as any).electron.project.save(projectData, suggestedName);
    }

    // Browser fallback - download as file
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName || 'project.bfp';
    a.click();
    URL.revokeObjectURL(url);
    return { success: true, filePath: suggestedName };
  }

  async loadProject(): Promise<ProjectLoadResult> {
    if (this.isElectron) {
      return (window as any).electron.project.load();
    }

    // Browser fallback - file input
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.bfp';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ success: false, canceled: true });
          return;
        }
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          resolve({ success: true, data, filePath: file.name });
        } catch (err) {
          resolve({ success: false, error: (err as Error).message });
        }
      };
      input.oncancel = () => resolve({ success: false, canceled: true });
      input.click();
    });
  }

  async saveProjectToPath(filePath: string, projectData: unknown): Promise<ProjectSaveResult> {
    if (this.isElectron) {
      return (window as any).electron.project.saveToPath(filePath, projectData);
    }
    // Browser mode can't save to specific path
    return this.saveProject(projectData);
  }

  // Native file dialog for opening PDFs
  async openPdfDialog(): Promise<OpenPdfResult> {
    if (this.isElectron) {
      return (window as any).electron.dialog.openPdf();
    }

    // Browser fallback - file input
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ success: false, canceled: true });
          return;
        }
        // In browser mode, we can't get the actual file path
        // but we can get the file object
        const filePath = (file as any).path || file.name;
        resolve({ success: true, filePath });
      };
      input.oncancel = () => resolve({ success: false, canceled: true });
      input.click();
    });
  }

  // Projects folder management
  async projectsEnsureFolder(): Promise<{ success: boolean; path?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.projects.ensureFolder();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async projectsGetFolder(): Promise<{ path: string }> {
    if (this.isElectron) {
      return (window as any).electron.projects.getFolder();
    }
    return { path: '' };
  }

  async projectsList(): Promise<ProjectListResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.list();
    }
    return { success: false, projects: [], error: 'Not running in Electron' };
  }

  async projectsSave(projectData: unknown, name: string): Promise<ProjectSaveResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.save(projectData, name);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async projectsDelete(filePaths: string[]): Promise<ProjectsDeleteResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.delete(filePaths);
    }
    return { success: false, deleted: [], failed: [], error: 'Not running in Electron' };
  }

  async projectsImport(): Promise<ProjectsImportResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.import();
    }
    return { success: false, imported: [], failed: [], error: 'Not running in Electron' };
  }

  async projectsExport(projectPath: string): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.projects.export(projectPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async projectsLoadFromPath(filePath: string): Promise<ProjectLoadResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.loadFromPath(filePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }
}
