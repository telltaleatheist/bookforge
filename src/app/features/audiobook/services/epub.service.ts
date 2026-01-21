import { Injectable, signal, computed } from '@angular/core';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFirst?: string;
  authorLast?: string;
  year?: string;
  language: string;
  coverPath?: string;
  identifier?: string;
  publisher?: string;
  description?: string;
  outputFilename?: string;
}

export interface EpubChapter {
  id: string;
  title: string;
  href: string;
  order: number;
  wordCount: number;
}

export interface EpubStructure {
  metadata: EpubMetadata;
  chapters: EpubChapter[];
  spine: string[];
  opfPath: string;
  rootPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable({
  providedIn: 'root'
})
export class EpubService {
  // State signals
  private readonly _currentPath = signal<string | null>(null);
  private readonly _structure = signal<EpubStructure | null>(null);
  private readonly _cover = signal<string | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);

  // Public computed values
  readonly currentPath = computed(() => this._currentPath());
  readonly structure = computed(() => this._structure());
  readonly metadata = computed(() => this._structure()?.metadata ?? null);
  readonly chapters = computed(() => this._structure()?.chapters ?? []);
  readonly cover = computed(() => this._cover());
  readonly loading = computed(() => this._loading());
  readonly error = computed(() => this._error());
  readonly isOpen = computed(() => this._structure() !== null);

  // Check if we're running in Electron
  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron ? (window as any).electron : null;
  }

  /**
   * Open and parse an EPUB file
   */
  async open(epubPath: string): Promise<EpubStructure | null> {
    if (!this.electron) {
      this._error.set('Electron API not available');
      return null;
    }

    this._loading.set(true);
    this._error.set(null);

    try {
      const result = await this.electron.epub.parse(epubPath);

      if (!result.success || !result.data) {
        this._error.set(result.error || 'Failed to parse EPUB');
        return null;
      }

      this._currentPath.set(epubPath);
      this._structure.set(result.data);

      // Load cover image
      const coverResult = await this.electron.epub.getCover(epubPath);
      if (coverResult.success && coverResult.data) {
        this._cover.set(coverResult.data);
      }

      return result.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this._error.set(message);
      return null;
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Close the currently open EPUB
   */
  async close(): Promise<void> {
    if (!this.electron) return;

    try {
      await this.electron.epub.close();
    } catch (err) {
      // Ignore close errors
    }

    this._currentPath.set(null);
    this._structure.set(null);
    this._cover.set(null);
    this._error.set(null);
    this._hasModifications = false;
  }

  /**
   * Get text content for a chapter
   */
  async getChapterText(chapterId: string): Promise<string | null> {
    if (!this.electron) {
      this._error.set('Electron API not available');
      return null;
    }

    if (!this._structure()) {
      this._error.set('No EPUB open');
      return null;
    }

    try {
      const result = await this.electron.epub.getChapterText(chapterId);

      if (!result.success || result.data === undefined) {
        this._error.set(result.error || 'Failed to get chapter text');
        return null;
      }

      return result.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this._error.set(message);
      return null;
    }
  }

  /**
   * Get all chapter texts
   */
  async getAllChapterTexts(): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    const chapters = this.chapters();

    for (const chapter of chapters) {
      const text = await this.getChapterText(chapter.id);
      if (text !== null) {
        texts.set(chapter.id, text);
      }
    }

    return texts;
  }

  /**
   * Update cover image
   * This sets the cover in memory and marks it for embedding when the EPUB is saved
   */
  async setCover(coverDataUrl: string): Promise<void> {
    // Update local signal immediately for UI feedback
    this._cover.set(coverDataUrl);
    this._hasModifications = true;

    // Send to backend to mark for embedding when EPUB is saved
    if (this.electron) {
      try {
        const result = await this.electron.epub.setCover(coverDataUrl);
        if (!result.success) {
          console.error('[EpubService] Failed to set cover:', result.error);
          this._error.set(result.error || 'Failed to set cover');
        }
      } catch (err) {
        console.error('[EpubService] Error setting cover:', err);
      }
    }
  }

  /**
   * Save the EPUB with any modifications (cover, text edits) to a new file
   * Returns the path to the saved file
   */
  async saveModified(outputPath: string): Promise<string | null> {
    if (!this.electron) {
      return null;
    }

    try {
      const result = await this.electron.epub.saveModified(outputPath);
      if (result.success && result.data?.outputPath) {
        return result.data.outputPath;
      }
      console.error('[EpubService] Failed to save modified EPUB:', result.error);
      return null;
    } catch (err) {
      console.error('[EpubService] Error saving modified EPUB:', err);
      return null;
    }
  }

  /**
   * Check if there are pending modifications
   */
  hasModifications(): boolean {
    return this._hasModifications;
  }

  // Track whether there are unsaved modifications
  private _hasModifications = false;

  /**
   * Clear error state
   */
  clearError(): void {
    this._error.set(null);
  }

  /**
   * Get word count for current EPUB
   */
  readonly totalWordCount = computed(() => {
    const chapters = this.chapters();
    return chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
  });

  /**
   * Estimate conversion time based on word count
   * Rough estimate: ~100 words/minute for TTS
   */
  readonly estimatedDuration = computed(() => {
    const words = this.totalWordCount();
    const minutes = Math.ceil(words / 100);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${minutes}m`;
  });
}
