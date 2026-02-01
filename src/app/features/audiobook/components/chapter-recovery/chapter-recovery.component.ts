import { Component, input, signal, computed, effect, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export interface ChapterMatch {
  id: string;
  title: string;
  epubOrder: number;
  // Detected from VTT
  detectedTimestamp: string | null;  // HH:MM:SS.mmm format
  detectedSeconds: number | null;
  confidence: 'high' | 'medium' | 'low' | 'manual' | 'not_found';
  // User can override
  manualTimestamp: string | null;
  // First few words for matching
  openingText: string;
}

export interface ChapterRecoveryResult {
  success: boolean;
  outputPath?: string;
  chaptersApplied?: number;
  error?: string;
}

@Component({
  selector: 'app-chapter-recovery',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="chapter-recovery">
      <div class="header">
        <h3>Chapter Recovery</h3>
        <p class="description">
          Match EPUB chapters to VTT timestamps and inject into M4B audiobook.
        </p>
      </div>

      @if (loading()) {
        <div class="loading">
          <div class="spinner"></div>
          <span>{{ loadingMessage() }}</span>
        </div>
      } @else if (error()) {
        <div class="error-message">
          <span class="icon">⚠️</span>
          <span>{{ error() }}</span>
          <desktop-button variant="ghost" (click)="retry()">Retry</desktop-button>
        </div>
      } @else if (chapters().length === 0) {
        <div class="no-chapters">
          <p>No chapters found in EPUB or no VTT file available.</p>
        </div>
      } @else {
        <div class="chapters-list">
          <div class="list-header">
            <span class="col-order">#</span>
            <span class="col-title">Chapter</span>
            <span class="col-timestamp">Timestamp</span>
            <span class="col-confidence">Match</span>
          </div>

          @for (chapter of chapters(); track chapter.id) {
            <div class="chapter-row" [class.not-found]="chapter.confidence === 'not_found'">
              <span class="col-order">{{ chapter.epubOrder }}</span>
              <div class="col-title">
                <span class="title">{{ chapter.title }}</span>
                <span class="opening-text">{{ chapter.openingText }}</span>
              </div>
              <div class="col-timestamp">
                @if (chapter.confidence === 'not_found') {
                  <input
                    type="text"
                    class="timestamp-input"
                    placeholder="HH:MM:SS"
                    [value]="chapter.manualTimestamp || ''"
                    (input)="onManualTimestamp(chapter.id, $event)"
                  />
                } @else {
                  <span class="timestamp">{{ formatTimestamp(chapter.detectedSeconds) }}</span>
                  @if (chapter.manualTimestamp) {
                    <span class="manual-override">({{ chapter.manualTimestamp }})</span>
                  }
                }
              </div>
              <span class="col-confidence" [class]="chapter.confidence">
                @switch (chapter.confidence) {
                  @case ('high') { ✓ High }
                  @case ('medium') { ~ Medium }
                  @case ('low') { ? Low }
                  @case ('manual') { ✎ Manual }
                  @case ('not_found') { ✗ Not Found }
                }
              </span>
            </div>
          }
        </div>

        <div class="summary">
          <span>{{ matchedCount() }} of {{ chapters().length }} chapters matched</span>
          @if (unmatchedCount() > 0) {
            <span class="warning">{{ unmatchedCount() }} need manual timestamps</span>
          }
        </div>

        <div class="actions">
          <desktop-button
            variant="ghost"
            (click)="redetect()"
            [disabled]="applying()"
          >
            Re-detect
          </desktop-button>
          <desktop-button
            variant="primary"
            (click)="applyChapters()"
            [disabled]="applying() || !canApply()"
          >
            @if (applying()) {
              Applying...
            } @else {
              Apply Chapters to M4B
            }
          </desktop-button>
        </div>

        @if (applyResult()) {
          <div class="result" [class.success]="applyResult()!.success" [class.error]="!applyResult()!.success">
            @if (applyResult()!.success) {
              <span>✓ Applied {{ applyResult()!.chaptersApplied }} chapters to audiobook</span>
            } @else {
              <span>✗ {{ applyResult()!.error }}</span>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .chapter-recovery {
      padding: 16px;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      margin-bottom: 16px;
    }

    .header h3 {
      margin: 0 0 4px 0;
      font-size: 16px;
      font-weight: 600;
    }

    .description {
      margin: 0;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .loading {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px;
      color: var(--text-secondary);
    }

    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-color);
      border-top-color: var(--accent-color);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-message {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: var(--error-bg, rgba(255, 0, 0, 0.1));
      border-radius: 6px;
      color: var(--error-color, #ff4444);
    }

    .no-chapters {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary);
    }

    .chapters-list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--border-color);
      border-radius: 6px;
    }

    .list-header {
      display: grid;
      grid-template-columns: 40px 1fr 120px 80px;
      gap: 8px;
      padding: 8px 12px;
      background: var(--surface-secondary);
      border-bottom: 1px solid var(--border-color);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-secondary);
      position: sticky;
      top: 0;
    }

    .chapter-row {
      display: grid;
      grid-template-columns: 40px 1fr 120px 80px;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-color);
      font-size: 13px;
    }

    .chapter-row:last-child {
      border-bottom: none;
    }

    .chapter-row.not-found {
      background: var(--warning-bg, rgba(255, 200, 0, 0.1));
    }

    .col-order {
      color: var(--text-secondary);
      font-size: 12px;
    }

    .col-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .col-title .title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .col-title .opening-text {
      font-size: 11px;
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .col-timestamp {
      font-family: monospace;
      font-size: 12px;
    }

    .timestamp-input {
      width: 100%;
      padding: 4px 8px;
      font-family: monospace;
      font-size: 12px;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--surface-primary);
      color: var(--text-primary);
    }

    .manual-override {
      font-size: 10px;
      color: var(--accent-color);
    }

    .col-confidence {
      font-size: 11px;
      font-weight: 500;
    }

    .col-confidence.high { color: var(--success-color, #44aa44); }
    .col-confidence.medium { color: var(--warning-color, #aaaa44); }
    .col-confidence.low { color: var(--warning-color, #aa8844); }
    .col-confidence.manual { color: var(--accent-color); }
    .col-confidence.not_found { color: var(--error-color, #aa4444); }

    .summary {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .summary .warning {
      color: var(--warning-color, #aa8844);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border-color);
    }

    .result {
      margin-top: 12px;
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
    }

    .result.success {
      background: var(--success-bg, rgba(0, 255, 0, 0.1));
      color: var(--success-color, #44aa44);
    }

    .result.error {
      background: var(--error-bg, rgba(255, 0, 0, 0.1));
      color: var(--error-color, #aa4444);
    }
  `]
})
export class ChapterRecoveryComponent {
  // Inputs
  readonly epubPath = input.required<string>();
  readonly vttPath = input.required<string>();
  readonly m4bPath = input.required<string>();

  // Outputs
  readonly chaptersApplied = output<ChapterRecoveryResult>();

  // State
  readonly loading = signal(true);
  readonly loadingMessage = signal('Loading chapters...');
  readonly error = signal<string | null>(null);
  readonly chapters = signal<ChapterMatch[]>([]);
  readonly applying = signal(false);
  readonly applyResult = signal<ChapterRecoveryResult | null>(null);

  // Computed
  readonly matchedCount = computed(() =>
    this.chapters().filter(c => c.confidence !== 'not_found' || c.manualTimestamp).length
  );

  readonly unmatchedCount = computed(() =>
    this.chapters().filter(c => c.confidence === 'not_found' && !c.manualTimestamp).length
  );

  readonly canApply = computed(() => this.matchedCount() > 0);

  private get electron(): any {
    return (window as any).electron;
  }

  constructor() {
    // Load chapters when inputs change
    effect(() => {
      const epub = this.epubPath();
      const vtt = this.vttPath();
      if (epub && vtt) {
        this.loadChapters();
      }
    });
  }

  async loadChapters(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.loadingMessage.set('Loading chapters from EPUB...');

    try {
      if (!this.electron?.chapterRecovery?.detectChapters) {
        throw new Error('Chapter recovery not available');
      }

      const result = await this.electron.chapterRecovery.detectChapters(
        this.epubPath(),
        this.vttPath()
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to detect chapters');
      }

      this.chapters.set(result.chapters || []);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      this.loading.set(false);
    }
  }

  retry(): void {
    this.loadChapters();
  }

  redetect(): void {
    this.loadChapters();
  }

  onManualTimestamp(chapterId: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();

    this.chapters.update(chapters =>
      chapters.map(c => {
        if (c.id !== chapterId) return c;
        return {
          ...c,
          manualTimestamp: value || null,
          confidence: value ? 'manual' : 'not_found'
        };
      })
    );
  }

  formatTimestamp(seconds: number | null): string {
    if (seconds === null) return '--:--:--';

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  async applyChapters(): Promise<void> {
    this.applying.set(true);
    this.applyResult.set(null);

    try {
      if (!this.electron?.chapterRecovery?.applyChapters) {
        throw new Error('Chapter recovery not available');
      }

      // Build chapter list with final timestamps
      const chaptersToApply = this.chapters()
        .filter(c => c.confidence !== 'not_found' || c.manualTimestamp)
        .map(c => ({
          title: c.title,
          timestamp: c.manualTimestamp || this.formatTimestamp(c.detectedSeconds)
        }));

      const result = await this.electron.chapterRecovery.applyChapters(
        this.m4bPath(),
        chaptersToApply
      );

      this.applyResult.set(result);

      if (result.success) {
        this.chaptersApplied.emit(result);
      }
    } catch (err) {
      const errorResult: ChapterRecoveryResult = {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      };
      this.applyResult.set(errorResult);
    } finally {
      this.applying.set(false);
    }
  }
}
