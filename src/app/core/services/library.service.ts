import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';

export interface LibrarySettings {
  libraryPath: string | null;
  onboardingComplete: boolean;
}

/**
 * LibraryService - Manages the BookForge library location and settings
 *
 * The library folder structure:
 * [library]/
 *   projects/       - .bfp project files
 *   files/          - Source PDFs/EPUBs (SHA256-named)
 *   audiobooks/
 *     queue/        - EPUBs waiting for TTS conversion
 *     completed/    - Finished M4B files
 *   cache/          - Rendered page PNGs
 */
@Injectable({
  providedIn: 'root'
})
export class LibraryService {
  private readonly electronService = inject(ElectronService);

  // Reactive state
  private readonly _libraryPath = signal<string | null>(null);
  private readonly _onboardingComplete = signal<boolean>(false);
  private readonly _loading = signal<boolean>(true);

  // Public computed signals
  readonly libraryPath = computed(() => this._libraryPath());
  readonly onboardingComplete = computed(() => this._onboardingComplete());
  readonly loading = computed(() => this._loading());
  readonly isConfigured = computed(() => this._libraryPath() !== null && this._onboardingComplete());

  // Computed paths
  readonly projectsPath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/projects` : null;
  });

  readonly filesPath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/files` : null;
  });

  readonly audiobooksPath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/audiobooks` : null;
  });

  readonly audiobooksQueuePath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/audiobooks/queue` : null;
  });

  readonly audiobooksCompletedPath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/audiobooks/completed` : null;
  });

  readonly cachePath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/cache` : null;
  });

  private readonly STORAGE_KEY = 'bookforge_library_settings';

  constructor() {
    this.loadSettings();
  }

  /**
   * Load settings from localStorage
   */
  private loadSettings(): void {
    this._loading.set(true);
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const settings: LibrarySettings = JSON.parse(stored);
        console.log('[LibraryService] Loaded settings from localStorage:', settings);

        // Validate and sync library path to main process
        if (settings.libraryPath) {
          this.validateAndSyncPath(settings);
        } else {
          this._libraryPath.set(null);
          this._onboardingComplete.set(settings.onboardingComplete);
        }
      }
    } catch (e) {
      console.error('Failed to load library settings:', e);
    }
    this._loading.set(false);
  }

  /**
   * Validate stored path exists on current system, reset if not
   */
  private async validateAndSyncPath(settings: LibrarySettings): Promise<void> {
    try {
      const result = await this.electronService.setLibraryRoot(settings.libraryPath);
      if (result.success) {
        this._libraryPath.set(settings.libraryPath);
        this._onboardingComplete.set(settings.onboardingComplete);
        console.log('[LibraryService] Library path validated:', settings.libraryPath);
      } else {
        // Path doesn't exist (e.g., Mac path on Windows) - reset settings
        console.warn('[LibraryService] Stored path invalid, resetting:', result.error);
        this._libraryPath.set(null);
        this._onboardingComplete.set(false);
        this.saveSettings();
      }
    } catch (e) {
      console.error('[LibraryService] Failed to validate path:', e);
      this._libraryPath.set(null);
      this._onboardingComplete.set(false);
      this.saveSettings();
    }
  }

  /**
   * Sync library path to the main process
   */
  private async syncLibraryPathToMain(path: string | null): Promise<void> {
    try {
      await this.electronService.setLibraryRoot(path);
      console.log('[LibraryService] Synced library path to main:', path);
    } catch (e) {
      console.error('[LibraryService] Failed to sync library path to main:', e);
    }
  }

  /**
   * Save settings to localStorage
   */
  private saveSettings(): void {
    const settings: LibrarySettings = {
      libraryPath: this._libraryPath(),
      onboardingComplete: this._onboardingComplete()
    };
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
  }

  /**
   * Set the library path and mark onboarding as complete
   */
  async setLibraryPath(path: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Ensure the path is valid and create folders if needed
      const result = await this.ensureLibraryFolders(path);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      this._libraryPath.set(path);
      this._onboardingComplete.set(true);
      this.saveSettings();

      // Sync to main process
      await this.syncLibraryPathToMain(path);

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Ensure all library subfolders exist
   */
  private async ensureLibraryFolders(basePath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      // In browser mode, just accept the path
      return { success: true };
    }

    try {
      // Use the existing projects:ensure-folder pattern but with custom path
      // For now, we'll use the default BookForge folder structure
      const result = await this.electronService.projectsEnsureFolder();
      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Use the default library path (~/Documents/BookForge)
   */
  async useDefaultLibrary(): Promise<{ success: boolean; error?: string }> {
    try {
      // Clear custom library root in main process (use default)
      await this.syncLibraryPathToMain(null);

      const result = await this.electronService.projectsEnsureFolder();
      if (!result.success) {
        return { success: false, error: result.error };
      }

      // The default path is ~/Documents/BookForge
      // Get the actual path from the ensure folder result
      const path = result.path || '';

      this._libraryPath.set(path);
      this._onboardingComplete.set(true);
      this.saveSettings();

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Copy an EPUB file to the audiobook queue
   */
  async copyToAudiobookQueue(sourcePath: string, filename: string): Promise<{ success: boolean; destPath?: string; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    const queuePath = this.audiobooksQueuePath();
    if (!queuePath) {
      return { success: false, error: 'Library not configured' };
    }

    try {
      // Use IPC to copy the file
      const result = await (window as any).electron.library.copyToQueue(sourcePath, filename);
      return result;
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Reset library settings (for testing/debugging)
   */
  resetSettings(): void {
    this._libraryPath.set(null);
    this._onboardingComplete.set(false);
    localStorage.removeItem(this.STORAGE_KEY);
  }

  /**
   * Skip onboarding and use default library
   */
  async skipOnboarding(): Promise<void> {
    await this.useDefaultLibrary();
  }
}
