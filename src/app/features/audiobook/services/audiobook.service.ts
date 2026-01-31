import { Injectable, signal, computed, DestroyRef, inject } from '@angular/core';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionPhase = 'preparing' | 'converting' | 'merging' | 'complete' | 'error';

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}

export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  voice: string;
  temperature: number;
  speed: number;
}

export interface TTSProgress {
  phase: ConversionPhase;
  currentChapter: number;
  totalChapters: number;
  percentage: number;
  estimatedRemaining: number;
  message?: string;
  error?: string;
}

export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration?: number;
}

export interface QueueFileInfo {
  path: string;
  filename: string;
  size: number;
  addedAt: string;
  // Project-based fields
  projectId?: string;
  hasCleaned?: boolean;
  cleanedFilename?: string;  // Filename of cleaned epub (may be 'exported_cleaned.epub' or 'cleaned.epub')
  skippedChunksPath?: string;
}

export type AvailabilityStatus = 'unknown' | 'checking' | 'available' | 'unavailable';

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable({
  providedIn: 'root'
})
export class AudiobookService {
  private readonly destroyRef = inject(DestroyRef);

  // State signals
  private readonly _availabilityStatus = signal<AvailabilityStatus>('unknown');
  private readonly _voices = signal<VoiceInfo[]>([]);
  private readonly _progress = signal<TTSProgress | null>(null);
  private readonly _converting = signal(false);
  private readonly _error = signal<string | null>(null);

  // Settings
  private readonly _settings = signal<TTSSettings>({
    device: 'mps', // Default to MPS on macOS
    language: 'en',
    voice: 'en_default',
    temperature: 0.75,
    speed: 1.0
  });

  // Public computed values
  readonly availabilityStatus = computed(() => this._availabilityStatus());
  readonly voices = computed(() => this._voices());
  readonly progress = computed(() => this._progress());
  readonly converting = computed(() => this._converting());
  readonly error = computed(() => this._error());
  readonly settings = computed(() => this._settings());
  readonly isAvailable = computed(() => this._availabilityStatus() === 'available');

  // Progress listener
  private unsubscribeProgress: (() => void) | null = null;

  constructor() {
    this.setupProgressListener();

    // Cleanup on destroy
    this.destroyRef.onDestroy(() => {
      if (this.unsubscribeProgress) {
        this.unsubscribeProgress();
      }
    });
  }

  // Check if we're running in Electron
  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron ? (window as any).electron : null;
  }

  /**
   * Set up progress listener for TTS conversion
   */
  private setupProgressListener(): void {
    if (!this.electron) return;

    this.unsubscribeProgress = this.electron.tts.onProgress((progress: TTSProgress) => {
      this._progress.set(progress);

      // Update converting state based on phase
      if (progress.phase === 'complete' || progress.phase === 'error') {
        this._converting.set(false);
      }
    });
  }

  /**
   * Check if ebook2audiobook is available
   */
  async checkAvailability(): Promise<boolean> {
    if (!this.electron) {
      this._availabilityStatus.set('unavailable');
      this._error.set('Electron API not available');
      return false;
    }

    this._availabilityStatus.set('checking');
    this._error.set(null);

    try {
      const result = await this.electron.tts.checkAvailable();

      if (!result.success || !result.data) {
        this._availabilityStatus.set('unavailable');
        this._error.set(result.error || 'Failed to check availability');
        return false;
      }

      if (result.data.available) {
        this._availabilityStatus.set('available');
        return true;
      } else {
        this._availabilityStatus.set('unavailable');
        this._error.set(result.data.error || 'ebook2audiobook not available');
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this._availabilityStatus.set('unavailable');
      this._error.set(message);
      return false;
    }
  }

  /**
   * Get available voice models
   */
  async getVoices(): Promise<VoiceInfo[]> {
    if (!this.electron) {
      return [];
    }

    try {
      const result = await this.electron.tts.getVoices();
      if (result.success && result.data) {
        this._voices.set(result.data);
        return result.data;
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Update TTS settings
   */
  setSettings(settings: Partial<TTSSettings>): void {
    this._settings.update(current => ({ ...current, ...settings }));
  }

  /**
   * Start TTS conversion
   */
  async startConversion(epubPath: string, outputDir: string): Promise<ConversionResult> {
    if (!this.electron) {
      return { success: false, error: 'Electron API not available' };
    }

    if (!this.isAvailable()) {
      const available = await this.checkAvailability();
      if (!available) {
        return { success: false, error: 'ebook2audiobook not available' };
      }
    }

    this._converting.set(true);
    this._progress.set({
      phase: 'preparing',
      currentChapter: 0,
      totalChapters: 0,
      percentage: 0,
      estimatedRemaining: 0,
      message: 'Starting conversion...'
    });
    this._error.set(null);

    try {
      const result = await this.electron.tts.startConversion(
        epubPath,
        outputDir,
        this._settings()
      );

      if (!result.success || !result.data) {
        this._error.set(result.error || 'Conversion failed');
        return { success: false, error: result.error || 'Conversion failed' };
      }

      return result.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this._error.set(message);
      return { success: false, error: message };
    } finally {
      this._converting.set(false);
    }
  }

  /**
   * Stop the current conversion
   */
  async stopConversion(): Promise<boolean> {
    if (!this.electron) {
      return false;
    }

    try {
      const result = await this.electron.tts.stopConversion();
      if (result.success) {
        this._converting.set(false);
        this._progress.set(null);
        return result.data ?? false;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Generate output filename based on metadata
   */
  async generateFilename(
    title: string,
    subtitle?: string,
    authorFirst?: string,
    authorLast?: string,
    year?: string
  ): Promise<string> {
    if (!this.electron) {
      // Fallback to basic filename
      return `${title}.m4b`;
    }

    try {
      // Build author in "Last, First" format
      const authorFileAs = authorLast
        ? (authorFirst ? `${authorLast}, ${authorFirst}` : authorLast)
        : authorFirst || '';

      const result = await this.electron.tts.generateFilename(
        title,
        subtitle,
        authorFirst && authorLast ? `${authorFirst} ${authorLast}` : (authorFirst || authorLast || ''),
        authorFileAs,
        year
      );

      if (result.success && result.data) {
        return result.data;
      }

      return `${title}.m4b`;
    } catch {
      return `${title}.m4b`;
    }
  }

  /**
   * Copy an EPUB to the audiobook queue
   */
  async copyToQueue(sourcePath: string, filename: string): Promise<{ success: boolean; destinationPath?: string; error?: string }> {
    if (!this.electron) {
      return { success: false, error: 'Electron API not available' };
    }

    try {
      const result = await this.electron.library.copyToQueue(sourcePath, filename);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * List EPUBs in the audiobook queue (legacy - uses old queue folder)
   * @deprecated Use listUnifiedProjects() instead
   */
  async listQueue(): Promise<QueueFileInfo[]> {
    if (!this.electron) {
      return [];
    }

    try {
      const result = await this.electron.library.listQueue();
      if (result.success && result.files) {
        return result.files;
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * List BFP projects that have been exported to audiobook (unified system)
   * This replaces listQueue() - audiobook data is stored in BFP projects
   */
  async listUnifiedProjects(): Promise<Array<{
    name: string;
    bfpPath: string;
    audiobookFolder: string;
    epubPath: string;
    status: string;
    exportedAt?: string;
    cleanedAt?: string;
    completedAt?: string;
    linkedAudioPath?: string;
    linkedAudioPathValid?: boolean;
    metadata?: {
      title?: string;
      author?: string;
      year?: string;
      coverImagePath?: string;
      outputFilename?: string;
    };
    analytics?: {
      ttsJobs?: any[];
      cleanupJobs?: any[];
    };
  }>> {
    if (!this.electron) {
      return [];
    }

    try {
      const result = await this.electron.audiobook.listProjectsWithAudiobook();
      if (result.success && result.projects) {
        return result.projects.map((p: {
          name: string;
          bfpPath: string;
          audiobookFolder: string;
          status: string;
          exportedAt?: string;
          cleanedAt?: string;
          completedAt?: string;
          linkedAudioPath?: string;
          linkedAudioPathValid?: boolean;
          metadata?: { title?: string; author?: string; year?: string; coverImagePath?: string; outputFilename?: string; };
          analytics?: { ttsJobs?: any[]; cleanupJobs?: any[]; };
        }) => ({
          ...p,
          epubPath: `${p.audiobookFolder}/exported.epub`
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get audiobooks paths
   */
  async getAudiobooksPath(): Promise<{ queuePath?: string; completedPath?: string }> {
    if (!this.electron) {
      return {};
    }

    try {
      const result = await this.electron.library.getAudiobooksPath();
      if (result.success) {
        return {
          queuePath: result.queuePath,
          completedPath: result.completedPath
        };
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Clear error state
   */
  clearError(): void {
    this._error.set(null);
  }
}
