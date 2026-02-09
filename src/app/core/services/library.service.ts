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
  private readonly _ready = signal<boolean>(false);

  // Promise that resolves when initialization is complete
  private initPromise: Promise<void> | null = null;

  // Public computed signals
  readonly libraryPath = computed(() => this._libraryPath());
  readonly onboardingComplete = computed(() => this._onboardingComplete());
  readonly loading = computed(() => this._loading());
  readonly ready = computed(() => this._ready());
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

  readonly languageLearningPath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/language-learning` : null;
  });

  readonly articlesPath = computed(() => {
    const lib = this._libraryPath();
    return lib ? `${lib}/language-learning/projects` : null;
  });

  private readonly STORAGE_KEY = 'bookforge_library_settings';

  constructor() {
    this.initPromise = this.loadSettings();
  }

  /**
   * Wait for the service to be fully initialized.
   * Call this before accessing libraryPath() to avoid race conditions.
   */
  async whenReady(): Promise<void> {
    if (this._ready()) return;
    await this.initPromise;
  }

  /**
   * Load settings from localStorage
   */
  private async loadSettings(): Promise<void> {
    this._loading.set(true);
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      this.logToMain(`[LibraryService] localStorage raw value: ${stored}`);

      if (stored) {
        const settings: LibrarySettings = JSON.parse(stored);
        this.logToMain(`[LibraryService] Parsed settings: libraryPath=${settings.libraryPath}, onboardingComplete=${settings.onboardingComplete}`);

        // Validate and sync library path to main process
        if (settings.libraryPath) {
          await this.validateAndSyncPath(settings);
        } else {
          this.logToMain('[LibraryService] No libraryPath in settings');
          this._libraryPath.set(null);
          this._onboardingComplete.set(settings.onboardingComplete);
        }
      } else {
        this.logToMain('[LibraryService] No settings in localStorage');
      }
    } catch (e) {
      this.logToMain(`[LibraryService] Error loading settings: ${(e as Error).message}`);
    }
    this._loading.set(false);
    this._ready.set(true);
  }

  private logToMain(message: string): void {
    // Log to renderer console
    console.log(message);
    // Also log to main process via IPC
    if (this.electronService.isRunningInElectron) {
      (window as any).electron?.debug?.log?.(message);
    }
  }

  /**
   * Validate stored path exists on current system, reset if not
   */
  private async validateAndSyncPath(settings: LibrarySettings): Promise<void> {
    this.logToMain(`[LibraryService] Validating path: ${settings.libraryPath}`);
    try {
      const result = await this.electronService.setLibraryRoot(settings.libraryPath);
      this.logToMain(`[LibraryService] setLibraryRoot result: ${JSON.stringify(result)}`);
      if (result.success) {
        this._libraryPath.set(settings.libraryPath);
        this._onboardingComplete.set(settings.onboardingComplete);
        this.logToMain(`[LibraryService] Path validated successfully`);
      } else {
        // Path doesn't exist (e.g., Mac path on Windows) - reset settings
        this.logToMain(`[LibraryService] Path invalid, resetting: ${result.error}`);
        this._libraryPath.set(null);
        this._onboardingComplete.set(false);
        this.saveSettings();
      }
    } catch (e) {
      this.logToMain(`[LibraryService] Exception during validation: ${(e as Error).message}`);
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
    const json = JSON.stringify(settings);
    localStorage.setItem(this.STORAGE_KEY, json);
    this.logToMain(`[LibraryService] Saved settings: ${json}`);

    // Verify it was saved
    const verify = localStorage.getItem(this.STORAGE_KEY);
    this.logToMain(`[LibraryService] Verify saved: ${verify}`);
  }

  /**
   * Set the library path and mark onboarding as complete
   */
  async setLibraryPath(path: string): Promise<{ success: boolean; error?: string }> {
    this.logToMain(`[LibraryService] setLibraryPath called with: ${path}`);
    try {
      // Ensure the path is valid and create folders if needed
      const result = await this.ensureLibraryFolders(path);
      if (!result.success) {
        this.logToMain(`[LibraryService] ensureLibraryFolders failed: ${result.error}`);
        return { success: false, error: result.error };
      }

      this._libraryPath.set(path);
      this._onboardingComplete.set(true);
      this.saveSettings();

      // Sync to main process
      await this.syncLibraryPathToMain(path);

      this.logToMain(`[LibraryService] setLibraryPath complete`);
      return { success: true };
    } catch (e) {
      this.logToMain(`[LibraryService] setLibraryPath error: ${(e as Error).message}`);
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
