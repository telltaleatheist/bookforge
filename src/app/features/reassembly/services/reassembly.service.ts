/**
 * Reassembly Service - State management for browsing and reassembling incomplete e2a sessions
 */

import { Injectable, inject, signal, computed, DestroyRef, NgZone, effect } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { SettingsService } from '../../../core/services/settings.service';
import {
  E2aSession,
  E2aChapter,
  ReassemblyConfig,
  ReassemblyProgress
} from '../models/reassembly.types';

@Injectable({
  providedIn: 'root'
})
export class ReassemblyService {
  private readonly electronService = inject(ElectronService);
  private readonly settingsService = inject(SettingsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ngZone = inject(NgZone);

  // Default e2a path - empty string means use cross-platform default on backend
  private readonly DEFAULT_E2A_TMP_PATH = '';

  // State signals
  private readonly _sessions = signal<E2aSession[]>([]);
  private readonly _selectedSessionId = signal<string | null>(null);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _tmpPath = signal<string>('');

  // Reassembly progress
  private readonly _currentJobId = signal<string | null>(null);
  private readonly _progress = signal<ReassemblyProgress | null>(null);

  // Modified chapters (for excluding chapters)
  private readonly _modifiedChapters = signal<Map<string, E2aChapter[]>>(new Map());

  // Public readonly signals
  readonly sessions = computed(() => this._sessions());
  readonly selectedSessionId = computed(() => this._selectedSessionId());
  readonly loading = computed(() => this._loading());
  readonly error = computed(() => this._error());
  readonly tmpPath = computed(() => this._tmpPath());
  readonly currentJobId = computed(() => this._currentJobId());
  readonly progress = computed(() => this._progress());

  // Computed - e2a tmp path from settings (with fallback)
  readonly e2aTmpPath = computed(() => {
    const settingsPath = this.settingsService.get<string>('e2aTmpPath');
    return settingsPath || this.DEFAULT_E2A_TMP_PATH;
  });

  // Computed - selected session
  readonly selectedSession = computed(() => {
    const id = this._selectedSessionId();
    if (!id) return null;
    return this._sessions().find(s => s.sessionId === id) || null;
  });

  // Computed - selected session chapters with modifications
  readonly selectedSessionChapters = computed(() => {
    const session = this.selectedSession();
    if (!session) return [];

    // Check for modified chapters
    const modified = this._modifiedChapters().get(session.sessionId);
    return modified || session.chapters;
  });

  // Progress listener cleanup
  private unsubscribeProgress: (() => void) | null = null;

  constructor() {
    this.setupProgressListener();

    // Debug effect to track sessions changes
    effect(() => {
      const sessions = this._sessions();
      console.log('[REASSEMBLY-SERVICE] Sessions signal updated:', sessions.length, 'sessions');
    });

    this.destroyRef.onDestroy(() => {
      if (this.unsubscribeProgress) {
        this.unsubscribeProgress();
      }
    });
  }

  private setupProgressListener(): void {
    this.unsubscribeProgress = this.electronService.onReassemblyProgress((data) => {
      this.ngZone.run(() => {
        this._progress.set(data.progress);

        // If complete or error, clear job ID
        if (data.progress.phase === 'complete' || data.progress.phase === 'error') {
          this._currentJobId.set(null);
        }
      });
    });
  }

  /**
   * Scan for incomplete e2a sessions
   */
  async scanSessions(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      const customPath = this.e2aTmpPath();
      console.log('[REASSEMBLY-SERVICE] Scanning with path:', customPath);
      const result = await this.electronService.reassemblyScanSessions(customPath);
      console.log('[REASSEMBLY-SERVICE] Result:', result);
      if (result.success && result.data) {
        console.log('[REASSEMBLY-SERVICE] Sessions found:', result.data.sessions.length);
        this._sessions.set(result.data.sessions);
        this._tmpPath.set(result.data.tmpPath);
      } else {
        console.error('[REASSEMBLY-SERVICE] Error:', result.error);
        this._error.set(result.error || 'Failed to scan sessions');
      }
    } catch (err) {
      console.error('[REASSEMBLY-SERVICE] Exception:', err);
      this._error.set(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Select a session
   */
  selectSession(sessionId: string | null): void {
    this._selectedSessionId.set(sessionId);
    this._progress.set(null);
  }

  /**
   * Toggle chapter exclusion
   */
  toggleChapterExclusion(chapterNum: number): void {
    const session = this.selectedSession();
    if (!session) return;

    // Get current chapters (modified or original)
    const currentChapters = this.selectedSessionChapters();

    // Create modified chapters array
    const newChapters = currentChapters.map(ch => {
      if (ch.chapterNum === chapterNum) {
        return { ...ch, excluded: !ch.excluded };
      }
      return ch;
    });

    // Store in modified map
    const newMap = new Map(this._modifiedChapters());
    newMap.set(session.sessionId, newChapters);
    this._modifiedChapters.set(newMap);
  }

  /**
   * Get excluded chapter numbers for current session
   */
  getExcludedChapters(): number[] {
    return this.selectedSessionChapters()
      .filter(ch => ch.excluded)
      .map(ch => ch.chapterNum);
  }

  /**
   * Start reassembly job
   */
  async startReassembly(config: {
    outputDir: string;
    metadata: {
      title: string;
      author: string;
      year?: string;
      coverPath?: string;
      outputFilename?: string;
    };
  }): Promise<{ success: boolean; error?: string }> {
    const session = this.selectedSession();
    if (!session) {
      return { success: false, error: 'No session selected' };
    }

    const jobId = `reassembly_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    this._currentJobId.set(jobId);
    this._progress.set({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing reassembly...'
    });

    const reassemblyConfig: ReassemblyConfig = {
      sessionId: session.sessionId,
      sessionDir: session.sessionDir,
      processDir: session.processDir,
      outputDir: config.outputDir,
      metadata: config.metadata,
      excludedChapters: this.getExcludedChapters()
    };

    try {
      const result = await this.electronService.reassemblyStart(jobId, reassemblyConfig);
      if (!result.success) {
        this._currentJobId.set(null);
        this._progress.set({
          phase: 'error',
          percentage: 0,
          error: result.error
        });
        return { success: false, error: result.error };
      }

      return { success: true };
    } catch (err) {
      this._currentJobId.set(null);
      const error = err instanceof Error ? err.message : 'Unknown error';
      this._progress.set({
        phase: 'error',
        percentage: 0,
        error
      });
      return { success: false, error };
    }
  }

  /**
   * Stop current reassembly
   */
  async stopReassembly(): Promise<void> {
    const jobId = this._currentJobId();
    if (!jobId) return;

    await this.electronService.reassemblyStop(jobId);
    this._currentJobId.set(null);
    this._progress.set(null);
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const customPath = this.e2aTmpPath();
      const result = await this.electronService.reassemblyDeleteSession(sessionId, customPath);
      if (result.success) {
        // Remove from sessions list
        this._sessions.update(sessions =>
          sessions.filter(s => s.sessionId !== sessionId)
        );

        // Clear selection if this was selected
        if (this._selectedSessionId() === sessionId) {
          this._selectedSessionId.set(null);
        }

        return { success: true };
      }
      return { success: false, error: result.error };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Refresh session data
   */
  async refreshSession(sessionId: string): Promise<void> {
    try {
      const customPath = this.e2aTmpPath();
      const result = await this.electronService.reassemblyGetSession(sessionId, customPath);
      if (result.success && result.data) {
        this._sessions.update(sessions =>
          sessions.map(s => s.sessionId === sessionId ? result.data! : s)
        );
      }
    } catch (err) {
      console.error('[REASSEMBLY] Error refreshing session:', err);
    }
  }

  /**
   * Check if reassembly feature is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.electronService.reassemblyIsAvailable();
      return result.success && result.data?.available === true;
    } catch {
      return false;
    }
  }
}
