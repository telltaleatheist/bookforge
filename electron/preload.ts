import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script - Exposes safe IPC methods to renderer process
 */

export interface ProjectSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface ProjectLoadResult {
  success: boolean;
  canceled?: boolean;
  data?: unknown;
  filePath?: string;
  error?: string;
}

export interface OpenPdfResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  sourcePath: string;
  sourceName: string;
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
}

export interface ProjectListResult {
  success: boolean;
  projects: ProjectInfo[];
  error?: string;
}

export interface ProjectsDeleteResult {
  success: boolean;
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

export interface ProjectsImportResult {
  success: boolean;
  canceled?: boolean;
  imported: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

export interface ElectronAPI {
  python: {
    call: (script: string, method: string, args: unknown[]) => Promise<unknown>;
    spawn: (script: string, args: string[]) => Promise<string>;
    kill: (processId: string) => Promise<boolean>;
    list: () => Promise<Array<{ id: string; script: string; status: string; runtime: number }>>;
    renderPage: (pageNum: number, scale?: number, pdfPath?: string) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
  };
  fs: {
    browse: (dirPath: string) => Promise<{
      path: string;
      parent: string;
      items: Array<{ name: string; path: string; type: string; size: number | null }>;
    }>;
  };
  project: {
    save: (projectData: unknown, suggestedName?: string) => Promise<ProjectSaveResult>;
    load: () => Promise<ProjectLoadResult>;
    saveToPath: (filePath: string, projectData: unknown) => Promise<ProjectSaveResult>;
  };
  dialog: {
    openPdf: () => Promise<OpenPdfResult>;
  };
  projects: {
    ensureFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
    getFolder: () => Promise<{ path: string }>;
    list: () => Promise<ProjectListResult>;
    save: (projectData: unknown, name: string) => Promise<ProjectSaveResult>;
    delete: (filePaths: string[]) => Promise<ProjectsDeleteResult>;
    import: () => Promise<ProjectsImportResult>;
    export: (projectPath: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    loadFromPath: (filePath: string) => Promise<ProjectLoadResult>;
  };
  platform: string;
}

const electronAPI: ElectronAPI = {
  python: {
    call: (script: string, method: string, args: unknown[]) =>
      ipcRenderer.invoke('python:call', script, method, args),
    spawn: (script: string, args: string[]) =>
      ipcRenderer.invoke('python:spawn', script, args),
    kill: (processId: string) =>
      ipcRenderer.invoke('python:kill', processId),
    list: () =>
      ipcRenderer.invoke('python:list'),
    renderPage: (pageNum: number, scale: number = 2.0, pdfPath?: string) =>
      ipcRenderer.invoke('python:render-page', pageNum, scale, pdfPath),
  },
  fs: {
    browse: (dirPath: string) =>
      ipcRenderer.invoke('fs:browse', dirPath),
  },
  project: {
    save: (projectData: unknown, suggestedName?: string) =>
      ipcRenderer.invoke('project:save', projectData, suggestedName),
    load: () =>
      ipcRenderer.invoke('project:load'),
    saveToPath: (filePath: string, projectData: unknown) =>
      ipcRenderer.invoke('project:save-to-path', filePath, projectData),
  },
  dialog: {
    openPdf: () =>
      ipcRenderer.invoke('dialog:open-pdf'),
  },
  projects: {
    ensureFolder: () =>
      ipcRenderer.invoke('projects:ensure-folder'),
    getFolder: () =>
      ipcRenderer.invoke('projects:get-folder'),
    list: () =>
      ipcRenderer.invoke('projects:list'),
    save: (projectData: unknown, name: string) =>
      ipcRenderer.invoke('projects:save', projectData, name),
    delete: (filePaths: string[]) =>
      ipcRenderer.invoke('projects:delete', filePaths),
    import: () =>
      ipcRenderer.invoke('projects:import'),
    export: (projectPath: string) =>
      ipcRenderer.invoke('projects:export', projectPath),
    loadFromPath: (filePath: string) =>
      ipcRenderer.invoke('projects:load-from-path', filePath),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// Type declaration for renderer
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
