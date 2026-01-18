import { Component, input, output, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export interface AICleanupOptions {
  fixHyphenation: boolean;
  fixOcrArtifacts: boolean;
  expandAbbreviations: boolean;
}

export interface ChapterPreview {
  id: string;
  title: string;
  originalText: string;
  cleanedText?: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  error?: string;
}

@Component({
  selector: 'app-ai-cleanup-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="ai-cleanup-panel">
      <!-- Connection Status -->
      <div class="connection-status" [class.connected]="ollamaConnected()" [class.error]="!ollamaConnected() && !checkingConnection()">
        @if (checkingConnection()) {
          <span class="status-icon">&#8635;</span>
          <span>Checking Ollama connection...</span>
        } @else if (ollamaConnected()) {
          <span class="status-icon">&#10003;</span>
          <span>Connected to Ollama</span>
        } @else {
          <span class="status-icon">&#10007;</span>
          <span>Ollama not available</span>
          <desktop-button variant="ghost" size="xs" (click)="checkConnection()">
            Retry
          </desktop-button>
        }
      </div>

      @if (!ollamaConnected() && !checkingConnection()) {
        <div class="setup-instructions">
          <h4>Setup Instructions</h4>
          <ol>
            <li>Install Ollama from <a href="https://ollama.ai" target="_blank">ollama.ai</a></li>
            <li>Start Ollama (it should run in the background)</li>
            <li>Pull a model: <code>ollama pull llama3.2</code></li>
            <li>Click Retry above to check connection</li>
          </ol>
        </div>
      } @else {
        <!-- Cleanup Options -->
        <div class="options-section">
          <h4>Cleanup Options</h4>
          <div class="option-list">
            <label class="option">
              <input
                type="checkbox"
                [ngModel]="options().fixHyphenation"
                (ngModelChange)="updateOption('fixHyphenation', $event)"
              />
              <div class="option-content">
                <span class="option-label">Fix Hyphenation</span>
                <span class="option-desc">Join words split across lines (tradi-tional → traditional)</span>
              </div>
            </label>

            <label class="option">
              <input
                type="checkbox"
                [ngModel]="options().fixOcrArtifacts"
                (ngModelChange)="updateOption('fixOcrArtifacts', $event)"
              />
              <div class="option-content">
                <span class="option-label">Fix OCR Artifacts</span>
                <span class="option-desc">Correct common OCR mistakes (rn→m, etc.)</span>
              </div>
            </label>

            <label class="option">
              <input
                type="checkbox"
                [ngModel]="options().expandAbbreviations"
                (ngModelChange)="updateOption('expandAbbreviations', $event)"
              />
              <div class="option-content">
                <span class="option-label">Expand Date Abbreviations</span>
                <span class="option-desc">Expand BCE/AD (500 BCE → 500 before the common era)</span>
              </div>
            </label>
          </div>
        </div>

        <!-- Chapter List -->
        <div class="chapters-section">
          <div class="section-header">
            <h4>Chapters</h4>
            <div class="progress-info">
              @if (isProcessing()) {
                <span>{{ processedCount() }}/{{ totalCount() }} chapters</span>
              }
            </div>
          </div>

          @if (chapters().length === 0) {
            <div class="no-chapters">
              <p>No chapters loaded. Click "Load Chapters" to analyze the EPUB.</p>
              <desktop-button variant="primary" [disabled]="isProcessing()" (click)="loadChapters()">
                Load Chapters
              </desktop-button>
            </div>
          } @else {
            <div class="chapter-list">
              @for (chapter of chapters(); track chapter.id) {
                <div
                  class="chapter-item"
                  [class.selected]="selectedChapter() === chapter.id"
                  [class.processing]="chapter.status === 'processing'"
                  [class.complete]="chapter.status === 'complete'"
                  [class.error]="chapter.status === 'error'"
                  (click)="selectChapter(chapter.id)"
                >
                  <div class="chapter-status">
                    @switch (chapter.status) {
                      @case ('pending') { <span class="dot"></span> }
                      @case ('processing') { <span class="spinner">&#8635;</span> }
                      @case ('complete') { <span class="check">&#10003;</span> }
                      @case ('error') { <span class="error">&#10007;</span> }
                    }
                  </div>
                  <div class="chapter-title">{{ chapter.title }}</div>
                </div>
              }
            </div>

            <!-- Preview Panel -->
            @if (selectedChapterData()) {
              <div class="preview-panel">
                <div class="preview-tabs">
                  <button
                    class="tab"
                    [class.active]="previewMode() === 'original'"
                    (click)="previewMode.set('original')"
                  >
                    Original
                  </button>
                  <button
                    class="tab"
                    [class.active]="previewMode() === 'cleaned'"
                    [disabled]="!selectedChapterData()?.cleanedText"
                    (click)="previewMode.set('cleaned')"
                  >
                    Cleaned
                  </button>
                  <button
                    class="tab"
                    [class.active]="previewMode() === 'diff'"
                    [disabled]="!selectedChapterData()?.cleanedText"
                    (click)="previewMode.set('diff')"
                  >
                    Diff
                  </button>
                </div>
                <div class="preview-content">
                  @switch (previewMode()) {
                    @case ('original') {
                      <pre>{{ selectedChapterData()?.originalText }}</pre>
                    }
                    @case ('cleaned') {
                      <pre>{{ selectedChapterData()?.cleanedText }}</pre>
                    }
                    @case ('diff') {
                      <pre>{{ selectedChapterData()?.cleanedText || 'Not yet processed' }}</pre>
                    }
                  }
                </div>
              </div>
            }

            <!-- Actions -->
            <div class="actions">
              <desktop-button
                variant="primary"
                [disabled]="!ollamaConnected() || isProcessing()"
                (click)="startCleanup()"
              >
                @if (isProcessing()) {
                  Processing...
                } @else {
                  Clean All Chapters
                }
              </desktop-button>
              @if (isProcessing()) {
                <desktop-button variant="ghost" (click)="cancelCleanup()">
                  Cancel
                </desktop-button>
              }
              @if (processedCount() === totalCount() && totalCount() > 0) {
                <desktop-button variant="primary" (click)="saveAndContinue()">
                  Save & Continue
                </desktop-button>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .ai-cleanup-panel {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .connection-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: var(--bg-subtle);
      border-radius: 6px;
      font-size: 0.875rem;
      color: var(--text-secondary);

      &.connected {
        background: color-mix(in srgb, var(--accent-success) 10%, transparent);
        color: var(--accent-success);
      }

      &.error {
        background: color-mix(in srgb, var(--accent-danger) 10%, transparent);
        color: var(--accent-danger);
      }

      .status-icon {
        font-size: 1rem;
      }
    }

    .setup-instructions {
      padding: 1rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      h4 {
        margin: 0 0 0.75rem 0;
        font-size: 0.875rem;
        color: var(--text-primary);
      }

      ol {
        margin: 0;
        padding-left: 1.25rem;

        li {
          margin-bottom: 0.5rem;
          font-size: 0.875rem;
          color: var(--text-secondary);
        }

        code {
          background: var(--bg-elevated);
          padding: 0.125rem 0.375rem;
          border-radius: 4px;
          font-size: 0.8125rem;
        }

        a {
          color: var(--accent-primary);
        }
      }
    }

    .options-section, .chapters-section {
      h4 {
        margin: 0 0 0.75rem 0;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        color: var(--text-secondary);
      }
    }

    .option-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg-subtle);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      input[type="checkbox"] {
        margin-top: 0.125rem;
      }

      .option-content {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }

      .option-label {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .option-desc {
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;

      .progress-info {
        font-size: 0.75rem;
        color: var(--text-secondary);
      }
    }

    .no-chapters {
      text-align: center;
      padding: 2rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      p {
        margin: 0 0 1rem 0;
        color: var(--text-secondary);
        font-size: 0.875rem;
      }
    }

    .chapter-list {
      max-height: 200px;
      overflow-y: auto;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      margin-bottom: 1rem;
    }

    .chapter-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--border-default);
      cursor: pointer;
      transition: background 0.15s;

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
      }

      &.complete .chapter-status {
        color: var(--accent-success);
      }

      &.error .chapter-status {
        color: var(--accent-danger);
      }

      .chapter-status {
        width: 1rem;
        text-align: center;

        .dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          background: var(--text-muted);
          border-radius: 50%;
        }

        .spinner {
          display: inline-block;
          animation: spin 1s linear infinite;
        }
      }

      .chapter-title {
        flex: 1;
        font-size: 0.8125rem;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .preview-panel {
      border: 1px solid var(--border-default);
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 1rem;
    }

    .preview-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-default);
      background: var(--bg-subtle);

      .tab {
        padding: 0.5rem 1rem;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--text-secondary);
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.15s;

        &:hover:not(:disabled) {
          color: var(--text-primary);
        }

        &.active {
          color: var(--accent-primary);
          border-bottom-color: var(--accent-primary);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }
    }

    .preview-content {
      max-height: 200px;
      overflow: auto;
      padding: 0.75rem;
      background: var(--bg-base);

      pre {
        margin: 0;
        font-size: 0.75rem;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text-secondary);
      }
    }

    .actions {
      display: flex;
      gap: 0.75rem;
    }
  `]
})
export class AiCleanupPanelComponent implements OnInit {
  // Inputs
  readonly epubPath = input<string>('');

  // Outputs
  readonly cleanupComplete = output<void>();

  // State
  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly isProcessing = signal(false);
  readonly options = signal<AICleanupOptions>({
    fixHyphenation: true,
    fixOcrArtifacts: true,
    expandAbbreviations: true
  });
  readonly chapters = signal<ChapterPreview[]>([]);
  readonly selectedChapter = signal<string | null>(null);
  readonly previewMode = signal<'original' | 'cleaned' | 'diff'>('original');

  // Computed
  readonly selectedChapterData = computed(() => {
    const id = this.selectedChapter();
    if (!id) return null;
    return this.chapters().find(c => c.id === id) || null;
  });

  readonly processedCount = computed(() =>
    this.chapters().filter(c => c.status === 'complete').length
  );

  readonly totalCount = computed(() => this.chapters().length);

  ngOnInit(): void {
    this.checkConnection();
  }

  async checkConnection(): Promise<void> {
    this.checkingConnection.set(true);
    try {
      // TODO: Use ai-bridge to check Ollama connection
      // For now, simulate connection check
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Try to connect to Ollama
      const response = await fetch('http://localhost:11434/api/tags').catch(() => null);
      this.ollamaConnected.set(!!response?.ok);
    } catch {
      this.ollamaConnected.set(false);
    } finally {
      this.checkingConnection.set(false);
    }
  }

  updateOption(key: keyof AICleanupOptions, value: boolean): void {
    this.options.update(opts => ({ ...opts, [key]: value }));
  }

  async loadChapters(): Promise<void> {
    // TODO: Load chapters from EPUB via epub.service
    // For now, use placeholder data
    this.chapters.set([
      { id: '1', title: 'Chapter 1: Introduction', originalText: 'Sample intro text...', status: 'pending' },
      { id: '2', title: 'Chapter 2: Background', originalText: 'Sample background text...', status: 'pending' },
      { id: '3', title: 'Chapter 3: Main Content', originalText: 'Sample main content...', status: 'pending' }
    ]);
  }

  selectChapter(id: string): void {
    this.selectedChapter.set(id);
    this.previewMode.set('original');
  }

  async startCleanup(): Promise<void> {
    if (!this.ollamaConnected()) return;

    this.isProcessing.set(true);

    // TODO: Implement actual cleanup using ai-cleanup.service
    // For now, simulate processing
    for (const chapter of this.chapters()) {
      this.chapters.update(chapters =>
        chapters.map(c => c.id === chapter.id ? { ...c, status: 'processing' as const } : c)
      );

      await new Promise(resolve => setTimeout(resolve, 1500));

      this.chapters.update(chapters =>
        chapters.map(c => c.id === chapter.id ? {
          ...c,
          status: 'complete' as const,
          cleanedText: c.originalText + ' [Cleaned]'
        } : c)
      );
    }

    this.isProcessing.set(false);
  }

  cancelCleanup(): void {
    // TODO: Cancel ongoing cleanup
    this.isProcessing.set(false);
  }

  saveAndContinue(): void {
    // TODO: Save cleaned EPUB
    this.cleanupComplete.emit();
  }
}
