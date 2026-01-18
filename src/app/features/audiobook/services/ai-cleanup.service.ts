import { Injectable, signal, computed, DestroyRef, inject } from '@angular/core';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface AICleanupOptions {
  fixHyphenation: boolean;
  fixOcrArtifacts: boolean;
  expandAbbreviations: boolean;
}

export interface CleanupProgress {
  chapterId: string;
  chapterTitle: string;
  currentChunk: number;
  totalChunks: number;
  percentage: number;
}

export interface CleanupResult {
  success: boolean;
  cleanedText?: string;
  error?: string;
}

export type ConnectionStatus = 'unknown' | 'checking' | 'connected' | 'disconnected';

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable({
  providedIn: 'root'
})
export class AICleanupService {
  private readonly destroyRef = inject(DestroyRef);

  // State signals
  private readonly _connectionStatus = signal<ConnectionStatus>('unknown');
  private readonly _models = signal<OllamaModel[]>([]);
  private readonly _selectedModel = signal<string>('llama3.2');
  private readonly _progress = signal<CleanupProgress | null>(null);
  private readonly _processing = signal(false);
  private readonly _error = signal<string | null>(null);

  // Cleanup options
  private readonly _options = signal<AICleanupOptions>({
    fixHyphenation: true,
    fixOcrArtifacts: true,
    expandAbbreviations: true
  });

  // Public computed values
  readonly connectionStatus = computed(() => this._connectionStatus());
  readonly models = computed(() => this._models());
  readonly selectedModel = computed(() => this._selectedModel());
  readonly progress = computed(() => this._progress());
  readonly processing = computed(() => this._processing());
  readonly error = computed(() => this._error());
  readonly options = computed(() => this._options());
  readonly isConnected = computed(() => this._connectionStatus() === 'connected');

  // Cleanup listener
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
  private get electron(): typeof window.electron | null {
    return typeof window !== 'undefined' && window.electron ? window.electron : null;
  }

  /**
   * Set up progress listener for AI cleanup
   */
  private setupProgressListener(): void {
    if (!this.electron) return;

    this.unsubscribeProgress = this.electron.ai.onCleanupProgress((progress) => {
      this._progress.set(progress);
    });
  }

  /**
   * Check connection to Ollama
   */
  async checkConnection(): Promise<boolean> {
    if (!this.electron) {
      this._connectionStatus.set('disconnected');
      this._error.set('Electron API not available');
      return false;
    }

    this._connectionStatus.set('checking');
    this._error.set(null);

    try {
      const result = await this.electron.ai.checkConnection();

      if (!result.success || !result.data) {
        this._connectionStatus.set('disconnected');
        this._error.set(result.error || 'Failed to check connection');
        return false;
      }

      if (result.data.connected) {
        this._connectionStatus.set('connected');
        if (result.data.models) {
          this._models.set(result.data.models);
        }
        return true;
      } else {
        this._connectionStatus.set('disconnected');
        this._error.set(result.data.error || 'Ollama not available');
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this._connectionStatus.set('disconnected');
      this._error.set(message);
      return false;
    }
  }

  /**
   * Get available models
   */
  async getModels(): Promise<OllamaModel[]> {
    if (!this.electron) {
      return [];
    }

    try {
      const result = await this.electron.ai.getModels();
      if (result.success && result.data) {
        this._models.set(result.data);
        return result.data;
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Set the model to use for cleanup
   */
  setModel(modelName: string): void {
    this._selectedModel.set(modelName);
  }

  /**
   * Set cleanup options
   */
  setOptions(options: Partial<AICleanupOptions>): void {
    this._options.update(current => ({ ...current, ...options }));
  }

  /**
   * Clean up a single chapter
   */
  async cleanupChapter(
    text: string,
    chapterId: string,
    chapterTitle: string
  ): Promise<CleanupResult> {
    if (!this.electron) {
      return { success: false, error: 'Electron API not available' };
    }

    if (!this.isConnected()) {
      const connected = await this.checkConnection();
      if (!connected) {
        return { success: false, error: 'Ollama not connected' };
      }
    }

    this._processing.set(true);
    this._progress.set(null);
    this._error.set(null);

    try {
      const result = await this.electron.ai.cleanupChapter(
        text,
        this._options(),
        chapterId,
        chapterTitle,
        this._selectedModel()
      );

      if (!result.success || !result.data) {
        this._error.set(result.error || 'Cleanup failed');
        return { success: false, error: result.error || 'Cleanup failed' };
      }

      return result.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this._error.set(message);
      return { success: false, error: message };
    } finally {
      this._processing.set(false);
      this._progress.set(null);
    }
  }

  /**
   * Clean up multiple chapters
   */
  async cleanupChapters(
    chapters: Array<{ id: string; title: string; text: string }>
  ): Promise<Map<string, CleanupResult>> {
    const results = new Map<string, CleanupResult>();

    for (const chapter of chapters) {
      const result = await this.cleanupChapter(chapter.text, chapter.id, chapter.title);
      results.set(chapter.id, result);

      // Stop if there's an error
      if (!result.success) {
        break;
      }
    }

    return results;
  }

  /**
   * Clear error state
   */
  clearError(): void {
    this._error.set(null);
  }
}
