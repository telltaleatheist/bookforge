import { Component, input, signal, computed, OnInit, OnDestroy, AfterViewInit, inject, ElementRef, ViewChild, output, effect, ChangeDetectionStrategy, NgZone, ChangeDetectorRef, Injector } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { DiffService, DiffLoadingProgress } from '../../services/diff.service';
import { DiffChapter, DiffChapterMeta, DiffWord } from '../../../../core/models/diff.types';
import { ElectronService } from '../../../../core/services/electron.service';
import { Subscription } from 'rxjs';

interface DiffSource {
  label: string;
  path: string;
  filename: string;
}

/**
 * A segment of text in the unified diff view.
 * Can be unchanged text, or a change region with original/new text.
 */
interface DiffSegment {
  id: string;             // Unique ID for this segment (chapterId-index)
  type: 'unchanged' | 'change';
  text: string;           // The displayed text (new/cleaned version for changes)
  originalText?: string;  // Original text that was replaced (for changes)
  changeIndex?: number;   // Index for navigation (only for changes with originalText)
  contextBefore?: string; // Words before the change for tooltip context
  contextAfter?: string;  // Words after the change for tooltip context
}

interface EditState {
  segmentIds: string[];   // All segment IDs in the paragraph block
  chapterId: string;      // Chapter for saving
  originalValue: string;
  editedValue: string;
}

@Component({
  selector: 'app-diff-view',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="diff-view" [class.loading]="loading()">
      <!-- Header with chapter selector -->
      <div class="diff-header">
        <div class="header-left">
          <h4>Review Changes</h4>
          @if (totalChanges() > 0) {
            <span class="change-badge">{{ totalChanges() }} changes</span>
          }
          <label class="whitespace-toggle" title="When enabled, ignores differences in whitespace, paragraph breaks, and newlines">
            <input
              type="checkbox"
              [checked]="ignoreWhitespace()"
              (change)="toggleIgnoreWhitespace()"
              [disabled]="loading() || chapterLoading()"
            />
            <span class="toggle-label">Ignore whitespace</span>
          </label>
        </div>

        <!-- Chapter selector -->
        @if (chaptersMeta().length > 1) {
          <div class="chapter-selector">
            <select
              class="chapter-dropdown"
              [value]="currentChapterId()"
              (change)="onChapterChange($event)"
            >
              @for (chapter of chaptersMeta(); track chapter.id) {
                <option [value]="chapter.id">
                  {{ chapter.title }}
                  @if (chapter.changeCount !== undefined) {
                    ({{ chapter.changeCount }} changes)
                  }
                </option>
              }
            </select>
            <div class="chapter-nav-buttons">
              <desktop-button
                variant="ghost"
                size="xs"
                [disabled]="!canGoPrev()"
                (click)="goToPrevChapter()"
              >
                ← Prev
              </desktop-button>
              <desktop-button
                variant="ghost"
                size="xs"
                [disabled]="!canGoNext()"
                (click)="goToNextChapter()"
              >
                Next →
              </desktop-button>
            </div>
          </div>
        }
      </div>

      <!-- Source picker (shown when multiple processed EPUBs exist) -->
      @if (availableSources().length > 1) {
        <div class="source-picker">
          @for (source of availableSources(); track source.path) {
            <button
              class="source-box"
              [class.active]="source.path === activeCleanedPath()"
              (click)="selectSource(source)"
            >
              {{ source.label }}
            </button>
          }
        </div>
      }

      <!-- Loading state -->
      @if (loading()) {
        <div class="state-message loading-state">
          @if (loadingProgress(); as progress) {
            <div class="progress-container">
              <div class="progress-bar">
                <div class="progress-fill" [style.width.%]="progress.percentage"></div>
              </div>
              <div class="progress-info">
                <span class="progress-phase">
                  @switch (progress.phase) {
                    @case ('loading-metadata') { Loading chapters... }
                    @case ('loading-chapter') { Loading chapter... }
                    @case ('computing-diff') { Computing differences... }
                    @default { Loading... }
                  }
                </span>
                @if (progress.chapterTitle) {
                  <span class="progress-detail">{{ progress.chapterTitle }}</span>
                }
              </div>
            </div>
          } @else {
            <span class="spinner">&#8635;</span>
            <span>Loading...</span>
          }
        </div>
      } @else if (error()) {
        <div class="state-message error">
          <span>{{ error() }}</span>
          <desktop-button variant="ghost" size="xs" (click)="retry()">
            Retry
          </desktop-button>
        </div>
      } @else if (chaptersMeta().length > 0) {
        <!-- Chapter content -->
        @if (chapterLoading()) {
          <div class="state-message loading-state">
            <span class="spinner">&#8635;</span>
            <span>Loading chapter...</span>
          </div>
        } @else if (currentChapterSegments().length > 0) {
          <!-- Large chapter info with load progress -->
          @if (hasMoreContent()) {
            <div class="load-progress-banner">
              <span class="info-icon">&#8987;</span>
              <span>Showing {{ loadedCharsDisplay() }} ({{ contentLoadProgress() }}%)</span>
              <div class="mini-progress">
                <div class="mini-progress-fill" [style.width.%]="contentLoadProgress()"></div>
              </div>
            </div>
          }

          <div
            class="chapter-content"
            #chapterContent
            (dblclick)="onContentDblClick($event)"
          >
            <div class="chapter-text" [innerHTML]="safeRenderedContent()"></div>

            <!-- Streaming progress indicator -->
            @if (hasMoreContent()) {
              <div class="streaming-indicator">
                <span class="streaming-spinner">&#8635;</span>
                <span class="streaming-text">Loading more content... {{ contentLoadProgress() }}%</span>
              </div>
            }

            <!-- Editing overlay (positioned absolutely over the text) -->
            @if (editState(); as state) {
              <div class="edit-overlay" [style.top.px]="editPosition().top">
                <textarea
                  class="edit-textarea"
                  [value]="state.editedValue"
                  (input)="onEditInput($event)"
                  (keydown)="onEditKeydown($event)"
                  (blur)="onEditBlur()"
                  #editTextarea
                ></textarea>
                <span class="edit-hint">Enter to save · Shift+Enter for newline · Esc to cancel</span>
              </div>
            }
          </div>

          <!-- Tooltip showing original text -->
          @if (tooltipVisible() && tooltipSegment()) {
            <div
              class="change-tooltip"
              [style.left.px]="tooltipX()"
              [style.top.px]="tooltipY()"
            >
              <div class="tooltip-row">
                <span class="tooltip-label">Was:</span>
                <span class="tooltip-original">{{ tooltipSegment()!.originalText }}</span>
              </div>
              @if (tooltipSegment()!.text !== '(deleted)') {
                <div class="tooltip-row">
                  <span class="tooltip-label">Now:</span>
                  <span class="tooltip-new">{{ tooltipSegment()!.text }}</span>
                </div>
              }
            </div>
          }
        } @else {
          <div class="state-message">
            <p>No changes in this chapter.</p>
          </div>
        }

        <!-- Footer -->
        <div class="diff-footer">
          <span class="hint">Hover over highlighted text to see original. Double-click to edit.</span>
        </div>
      } @else {
        <div class="state-message">
          <p>No chapters to compare.</p>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      width: 100%;
    }

    .diff-view {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      overflow: hidden;
      flex: 1;
      min-height: 0;
      width: 100%;
      position: relative;
    }

    .diff-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-default);
      flex-shrink: 0;
      flex-wrap: wrap;
      gap: 0.5rem;

      h4 {
        margin: 0;
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .source-picker {
      display: flex;
      gap: 0.375rem;
      padding: 0.375rem 0.75rem;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-default);
      flex-shrink: 0;
    }

    .source-box {
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      border: 1px solid var(--border-default);
      border-radius: 4px;
      background: var(--bg-default);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-elevated);
        color: var(--text-primary);
      }

      &.active {
        background: rgba(255, 107, 53, 0.15);
        border-color: #ff6b35;
        color: #ff6b35;
      }
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .change-badge {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      background: rgba(255, 107, 53, 0.2);
      color: #ff6b35;
      border-radius: 10px;
      font-weight: 500;
    }

    .whitespace-toggle {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      cursor: pointer;
      font-size: 0.6875rem;
      color: var(--text-secondary);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-default);
      }

      input[type="checkbox"] {
        width: 14px;
        height: 14px;
        cursor: pointer;
        accent-color: #ff6b35;
      }

      .toggle-label {
        white-space: nowrap;
      }
    }

    .chapter-selector {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .chapter-dropdown {
      padding: 0.25rem 0.5rem;
      border: 1px solid var(--border-input);
      border-radius: 4px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 0.75rem;
      max-width: 250px;
      cursor: pointer;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }
    }

    .chapter-nav-buttons {
      display: flex;
      gap: 0.25rem;
    }

    .state-message {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      color: var(--text-secondary);
      font-size: 0.875rem;

      &.error {
        color: var(--accent-danger);
      }

      &.loading-state {
        padding: 2rem;
      }
    }

    .progress-container {
      width: 100%;
      max-width: 400px;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .progress-bar {
      height: 8px;
      background: var(--bg-subtle);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #ff6b35 0%, #ff8c5a 100%);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .progress-info {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
    }

    .progress-phase {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    .progress-detail {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      max-width: 300px;
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
    }

    .spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
      font-size: 1.25rem;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .load-progress-banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: rgba(100, 181, 246, 0.15);
      border-bottom: 1px solid rgba(100, 181, 246, 0.3);
      color: #64b5f6;
      font-size: 0.75rem;
      flex-shrink: 0;
    }

    .info-icon {
      font-size: 0.875rem;
    }

    .mini-progress {
      margin-left: auto;
      width: 80px;
      height: 4px;
      background: rgba(100, 181, 246, 0.2);
      border-radius: 2px;
      overflow: hidden;
    }

    .mini-progress-fill {
      height: 100%;
      background: #64b5f6;
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .chapter-content {
      flex: 1;
      overflow: auto;
      padding: 1rem 1.5rem;
      position: relative;
    }

    .edit-overlay {
      position: absolute;
      z-index: 10;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      left: 0;
      right: 0;
    }

    .streaming-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 1rem;
      color: var(--text-tertiary);
      font-size: 0.8125rem;
    }

    .streaming-spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
      font-size: 1rem;
    }

    .streaming-text {
      opacity: 0.8;
    }

    .chapter-text {
      font-size: 0.9375rem;
      line-height: 1.75;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-wrap: break-word;

      // Use ::ng-deep to style innerHTML content (not scoped by Angular)
      ::ng-deep {
        .text-editable,
        .text-change {
          // Ensure whitespace is preserved within spans
          white-space: pre-wrap;
        }

        .text-editable {
          cursor: text;
          border-radius: 2px;
          transition: background 0.15s;

          &:hover {
            background: rgba(255, 255, 255, 0.05);
          }
        }

        .text-change {
          cursor: pointer;
          background: rgba(255, 183, 77, 0.2);
          border-bottom: 1px dashed rgba(255, 183, 77, 0.6);
          border-radius: 2px;
          padding: 1px 2px;
          transition: background 0.15s, border-color 0.15s;

          &:hover {
            background: rgba(255, 183, 77, 0.35);
            border-bottom-color: rgba(255, 183, 77, 0.9);
          }

          &.is-deletion {
            background: rgba(244, 67, 54, 0.2);
            border-bottom-color: rgba(244, 67, 54, 0.6);

            &:hover {
              background: rgba(244, 67, 54, 0.35);
            }
          }
        }

        .deletion-marker {
          color: #f44336;
          font-size: 0.75em;
          vertical-align: middle;
        }

        .text-editing-placeholder {
          display: inline;
          opacity: 0;
          pointer-events: none;
        }
      }
    }

    .edit-textarea {
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      padding: 8px 12px;
      border: 2px solid #ff6b35;
      border-radius: 3px;
      background: var(--bg-default);
      color: var(--text-primary);
      outline: none;
      width: 100%;
      min-height: 3em;
      resize: none;
      box-sizing: border-box;
      white-space: pre-wrap;

      &:focus {
        box-shadow: 0 0 0 3px rgba(255, 107, 53, 0.3);
      }
    }

    .edit-hint {
      margin-top: 4px;
      padding: 0 6px 4px;
      font-size: 0.625rem;
      color: var(--text-tertiary);
      white-space: nowrap;
      pointer-events: none;
    }

    .change-tooltip {
      position: fixed;
      z-index: 1000;
      max-width: 350px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      padding: 0.5rem 0.75rem;
      pointer-events: none;
      animation: tooltipFadeIn 0.1s ease;
    }

    @keyframes tooltipFadeIn {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .tooltip-row {
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      margin-bottom: 0.25rem;

      &:last-child {
        margin-bottom: 0;
      }
    }

    .tooltip-label {
      font-size: 0.6875rem;
      font-weight: 600;
      color: var(--text-tertiary);
      min-width: 32px;
    }

    .tooltip-original {
      font-size: 0.8125rem;
      color: #f44336;
      text-decoration: line-through;
      word-break: break-word;
    }

    .tooltip-new {
      font-size: 0.8125rem;
      color: #4caf50;
      font-weight: 500;
      word-break: break-word;
    }


    .diff-footer {
      padding: 0.5rem 0.75rem;
      background: var(--bg-subtle);
      border-top: 1px solid var(--border-default);
      flex-shrink: 0;
    }

    .hint {
      font-size: 0.6875rem;
      color: var(--text-tertiary);
    }
  `]
})
export class DiffViewComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('chapterContent') chapterContentRef!: ElementRef<HTMLDivElement>;

  private readonly diffService = inject(DiffService);
  private readonly electronService = inject(ElectronService);
  private readonly ngZone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly injector = inject(Injector);
  private readonly sanitizer = inject(DomSanitizer);
  private subscriptions: Subscription[] = [];

  // Inputs
  readonly originalPath = input<string>('');
  readonly cleanedPath = input<string>('');

  // Source picker: when multiple processed EPUBs exist in the same directory
  readonly availableSources = signal<DiffSource[]>([]);
  readonly activeCleanedPath = signal<string>('');

  // State
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly loadingProgress = signal<DiffLoadingProgress | null>(null);
  readonly chapterLoading = signal(false);

  // Tooltip state
  readonly tooltipVisible = signal(false);
  readonly tooltipX = signal(0);
  readonly tooltipY = signal(0);
  readonly tooltipSegment = signal<DiffSegment | null>(null);

  // Edit state
  readonly editState = signal<EditState | null>(null);
  readonly editPosition = signal<{ top: number; left: number }>({ top: 0, left: 0 });

  // Whitespace toggle state (default: true to compare words only)
  readonly ignoreWhitespace = signal(true);

  // Output for text edits
  readonly textEdited = output<{ chapterId: string; oldText: string; newText: string }>();

  // Session data
  readonly chaptersMeta = signal<DiffChapterMeta[]>([]);
  readonly currentChapterId = signal<string>('');
  readonly currentChapter = signal<DiffChapter | null>(null);

  // Track previous paths to detect changes
  private previousPaths = { original: '', cleaned: '' };

  // Tooltip debounce
  private tooltipTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly TOOLTIP_DELAY = 50; // ms before showing tooltip (short delay to avoid flicker)

  // Flag to stop all processing after destroy
  private isDestroyed = false;

  constructor() {
    // Effect to watch for input path changes and discover available sources
    effect(() => {
      const original = this.originalPath();
      const cleaned = this.cleanedPath();

      if (original && cleaned &&
          (original !== this.previousPaths.original || cleaned !== this.previousPaths.cleaned)) {
        this.previousPaths = { original, cleaned };
        setTimeout(() => this.discoverAndLoad(original, cleaned), 0);
      }
    });
  }

  // Computed: segments for current chapter (shows all loaded content)
  readonly currentChapterSegments = computed((): DiffSegment[] => {
    const chapter = this.currentChapter();
    if (!chapter) return [];

    return this.buildSegments(chapter.diffWords, 0, chapter.id);
  });

  // Computed: pre-rendered HTML content for performance (avoids thousands of Angular bindings)
  readonly renderedContent = computed((): string => {
    const segments = this.currentChapterSegments();
    const editingIds = this.editState()?.segmentIds;

    if (segments.length === 0) return '';

    // Build HTML string directly - much faster than Angular template bindings
    let html = '';
    for (const segment of segments) {
      if (editingIds?.includes(segment.id)) {
        // Editing state - will be replaced by overlay
        html += `<span class="text-editing-placeholder" data-segment-id="${this.escapeHtml(segment.id)}">...</span>`;
      } else if (segment.type === 'unchanged') {
        html += `<span class="text-editable" data-segment-id="${this.escapeHtml(segment.id)}">${this.escapeHtml(segment.text, true)}</span>`;
      } else {
        const deletionClass = segment.text === '(deleted)' ? ' is-deletion' : '';
        const displayText = segment.text === '(deleted)'
          ? '<span class="deletion-marker">&#9003;</span>'
          : this.escapeHtml(segment.text, true);
        // Store original text in data attribute for hover box
        const originalAttr = segment.originalText
          ? ` data-original="${this.escapeAttr(segment.originalText)}" data-new-text="${this.escapeAttr(segment.text)}"`
          : '';

        html += `<span class="text-change${deletionClass}" data-segment-id="${this.escapeHtml(segment.id)}"${originalAttr}>${displayText}</span>`;
      }
    }
    return html;
  });

  // Computed: SafeHtml version that bypasses Angular's sanitizer (content is trusted/escaped)
  readonly safeRenderedContent = computed((): SafeHtml => {
    const html = this.renderedContent();
    return this.sanitizer.bypassSecurityTrustHtml(html);
  });

  private escapeHtml(text: string, preserveNewlines = false): string {
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Convert newlines to <br> for proper HTML rendering
    if (preserveNewlines) {
      escaped = escaped.replace(/\n/g, '<br>');
    }

    return escaped;
  }

  private escapeAttr(text: string): string {
    return this.escapeHtml(text).replace(/'/g, '&#39;');
  }

  // Computed: total changes across all loaded chapters
  readonly totalChanges = computed(() => {
    return this.chaptersMeta().reduce((sum, m) => sum + (m.changeCount || 0), 0);
  });

  // Computed: can navigate to previous/next chapter
  readonly canGoPrev = computed(() => {
    const meta = this.chaptersMeta();
    const currentId = this.currentChapterId();
    const idx = meta.findIndex(m => m.id === currentId);
    return idx > 0;
  });

  readonly canGoNext = computed(() => {
    const meta = this.chaptersMeta();
    const currentId = this.currentChapterId();
    const idx = meta.findIndex(m => m.id === currentId);
    return idx < meta.length - 1;
  });

  // Computed: has more content to load
  readonly hasMoreContent = computed(() => {
    const chapter = this.currentChapter();
    if (!chapter) return false;
    return chapter.loadedChars < chapter.totalChars;
  });

  // Computed: content loading progress percentage
  readonly contentLoadProgress = computed(() => {
    const chapter = this.currentChapter();
    if (!chapter || chapter.totalChars === 0) return 100;
    return Math.round((chapter.loadedChars / chapter.totalChars) * 100);
  });

  // Computed: formatted loaded/total chars
  readonly loadedCharsDisplay = computed(() => {
    const chapter = this.currentChapter();
    if (!chapter) return '';
    return `${this.formatSize(chapter.loadedChars)} of ${this.formatSize(chapter.totalChars)}`;
  });

  ngOnInit(): void {
    // Initialize whitespace toggle from current setting
    this.ignoreWhitespace.set(this.diffService.isIgnoringWhitespace());

    // Subscribe to service state
    this.subscriptions.push(
      this.diffService.loading$.subscribe(loading => this.loading.set(loading)),
      this.diffService.error$.subscribe(error => this.error.set(error)),
      this.diffService.loadingProgress$.subscribe(progress => this.loadingProgress.set(progress)),
      this.diffService.chapterLoading$.subscribe(loading => this.chapterLoading.set(loading)),
      this.diffService.session$.subscribe(session => {
        // Skip processing if component is destroyed
        if (this.isDestroyed) return;

        if (session) {
          // Only update signals when values actually change to avoid re-render storms
          // during background chapter loading (hundreds of session emissions)
          if (this.chaptersMeta() !== session.chaptersMeta) {
            this.chaptersMeta.set(session.chaptersMeta);
          }
          if (this.currentChapterId() !== session.currentChapterId) {
            this.currentChapterId.set(session.currentChapterId);
          }
          const current = session.chapters.find(c => c.id === session.currentChapterId) || null;
          if (this.currentChapter() !== current) {
            this.currentChapter.set(current);
          }
        } else {
          this.chaptersMeta.set([]);
          this.currentChapterId.set('');
          this.currentChapter.set(null);
        }
      })
    );

    // Fallback: also try loading after a short delay in case effect doesn't fire
    setTimeout(() => {
      const original = this.originalPath();
      const cleaned = this.cleanedPath();
      if (original && cleaned && this.chaptersMeta().length === 0 && !this.loading()) {
        this.discoverAndLoad(original, cleaned);
      }
    }, 100);
  }

  ngAfterViewInit(): void {
    // Set up a MutationObserver to attach hover listeners when content changes
    this.setupHoverListeners();
  }

  /**
   * Attach hover listeners to text-change elements after innerHTML is rendered.
   * Uses MutationObserver to detect when content changes.
   */
  private setupHoverListeners(): void {
    // Use an effect to re-attach listeners when content changes
    effect(() => {
      // This will re-run whenever renderedContent changes
      const content = this.renderedContent();
      if (!content || this.isDestroyed) return;

      // Wait for DOM to update
      setTimeout(() => this.attachHoverListeners(), 0);
    }, { injector: this.injector });
  }

  private attachHoverListeners(): void {
    const container = this.chapterContentRef?.nativeElement;
    if (!container) return;

    const changeElements = container.querySelectorAll('.text-change[data-original]');
    changeElements.forEach((el: Element) => {
      const htmlEl = el as HTMLElement;

      // Skip if already initialized
      if (htmlEl.dataset['hoverInit']) return;
      htmlEl.dataset['hoverInit'] = 'true';

      htmlEl.addEventListener('mouseenter', (e: MouseEvent) => {
        const target = e.currentTarget as HTMLElement;
        const original = target.getAttribute('data-original');
        const newText = target.getAttribute('data-new-text') || target.textContent || '';

        if (!original) return;

        const rect = target.getBoundingClientRect();

        this.ngZone.run(() => {
          this.tooltipSegment.set({
            id: target.getAttribute('data-segment-id') || '',
            type: 'change',
            text: newText,
            originalText: original
          });
          this.tooltipX.set(rect.left);
          this.tooltipY.set(rect.bottom + 8);
          this.tooltipVisible.set(true);
          this.cdr.markForCheck();
        });
      });

      htmlEl.addEventListener('mouseleave', () => {
        this.ngZone.run(() => {
          this.tooltipVisible.set(false);
          this.tooltipSegment.set(null);
          this.cdr.markForCheck();
        });
      });
    });
  }

  ngOnDestroy(): void {
    // Set destroyed flag FIRST to stop all processing
    this.isDestroyed = true;

    // Stop any streaming diff computation in the service
    this.diffService.stopStreaming();

    // Clear chapter data to stop expensive computeds from running
    this.currentChapter.set(null);
    this.chaptersMeta.set([]);

    // Unsubscribe from all observables
    this.subscriptions.forEach(s => s.unsubscribe());
    this.subscriptions = [];

    // Clear any pending timeouts
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
    }
  }

  private async loadComparison(): Promise<void> {
    const original = this.originalPath();
    const cleaned = this.activeCleanedPath() || this.cleanedPath();

    if (!original || !cleaned) {
      return;
    }

    await this.diffService.loadComparison(original, cleaned);
  }

  /**
   * Discover available processed EPUBs in the same directory as cleanedPath.
   * If both cleaned.epub and simplified.epub exist, show picker boxes.
   * Otherwise, auto-select the one that exists (or fall back to cleanedPath).
   */
  private async discoverAndLoad(original: string, cleaned: string): Promise<void> {
    if (!cleaned || !this.electronService.isRunningInElectron) {
      this.availableSources.set([]);
      this.activeCleanedPath.set(cleaned);
      this.loadComparison();
      return;
    }

    // Derive directory and check for both known filenames
    const lastSlash = cleaned.lastIndexOf('/');
    const dir = lastSlash > 0 ? cleaned.substring(0, lastSlash) : '';

    if (!dir) {
      this.availableSources.set([]);
      this.activeCleanedPath.set(cleaned);
      this.loadComparison();
      return;
    }

    const candidates: DiffSource[] = [
      { label: 'AI Cleaned', path: `${dir}/cleaned.epub`, filename: 'cleaned.epub' },
      { label: 'AI Simplified', path: `${dir}/simplified.epub`, filename: 'simplified.epub' },
    ];

    // Check which files exist in parallel
    const existChecks = await Promise.all(
      candidates.map(c => this.electronService.fsExists(c.path))
    );

    const found = candidates.filter((_, i) => existChecks[i]);

    if (found.length > 1) {
      // Both exist - show picker, default to whichever was passed in
      this.availableSources.set(found);
      const matchingSource = found.find(s => s.path === cleaned);
      this.activeCleanedPath.set(matchingSource ? matchingSource.path : found[0].path);
    } else if (found.length === 1) {
      // Only one exists - use it, no picker needed
      this.availableSources.set([]);
      this.activeCleanedPath.set(found[0].path);
    } else {
      // Neither found at standard names - use the provided path as-is
      this.availableSources.set([]);
      this.activeCleanedPath.set(cleaned);
    }

    this.loadComparison();
  }

  /**
   * User clicked a source picker box - switch to that diff source.
   */
  selectSource(source: DiffSource): void {
    if (source.path === this.activeCleanedPath()) return;
    this.activeCleanedPath.set(source.path);
    this.loadComparison();
  }

  /**
   * Handle chapter selection change
   */
  async onChapterChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const chapterId = select.value;
    await this.diffService.setCurrentChapter(chapterId);
  }

  /**
   * Navigate to previous chapter
   */
  async goToPrevChapter(): Promise<void> {
    await this.diffService.previousChapter();
  }

  /**
   * Navigate to next chapter
   */
  async goToNextChapter(): Promise<void> {
    await this.diffService.nextChapter();
  }

  /**
   * Convert diffWords array into display segments.
   * Groups changes (removed/added words) into change regions.
   */
  private buildSegments(diffWords: DiffWord[], startingChangeIndex: number, chapterId: string): DiffSegment[] {
    const segments: DiffSegment[] = [];
    let i = 0;
    let changeIndex = startingChangeIndex;
    let segmentIndex = 0;

    while (i < diffWords.length) {
      const word = diffWords[i];

      if (word.type === 'unchanged') {
        // Accumulate consecutive unchanged words
        let text = word.text;
        i++;
        while (i < diffWords.length && diffWords[i].type === 'unchanged') {
          text += diffWords[i].text;
          i++;
        }
        segments.push({
          id: `${chapterId}-${segmentIndex}`,
          type: 'unchanged',
          text
        });
        segmentIndex++;
      } else {
        // We have a change region - collect ALL removed and added words until we hit unchanged
        let removedText = '';
        let addedText = '';

        while (i < diffWords.length && diffWords[i].type !== 'unchanged') {
          if (diffWords[i].type === 'removed') {
            removedText += diffWords[i].text;
          } else if (diffWords[i].type === 'added') {
            addedText += diffWords[i].text;
          }
          i++;
        }

        // Create the change segment
        if (addedText || removedText) {
          segments.push({
            id: `${chapterId}-${segmentIndex}`,
            type: 'change',
            text: addedText || '(deleted)',
            originalText: removedText || '(added)',
            changeIndex: changeIndex++
          });
          segmentIndex++;
        }
      }
    }

    return segments;
  }

  /**
   * Format byte size for display
   */
  formatSize(chars: number): string {
    if (chars < 1000) return `${chars} chars`;
    if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}K chars`;
    return `${(chars / 1_000_000).toFixed(1)}M chars`;
  }

  showTooltip(event: MouseEvent, segment: DiffSegment): void {
    if (!segment.originalText) return;

    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();

    this.tooltipX.set(rect.left);
    this.tooltipY.set(rect.bottom + 8);
    this.tooltipSegment.set(segment);
    this.tooltipVisible.set(true);
  }

  hideTooltip(): void {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }
    this.tooltipVisible.set(false);
    this.tooltipSegment.set(null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Delegation Handlers (performance optimization - single handler per event type)
  // ─────────────────────────────────────────────────────────────────────────────

  onContentDblClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const segmentId = target.getAttribute('data-segment-id');
    if (!segmentId) return;

    const block = this.getParagraphBlock(segmentId);
    if (block && block.segmentIds.length > 0 && block.paragraphText.length > 0) {
      this.startBlockEdit(block.segmentIds, block.paragraphText);
    }
  }

  retry(): void {
    this.loadComparison();
  }

  /** Toggle the ignore whitespace setting and recompute diff */
  async toggleIgnoreWhitespace(): Promise<void> {
    await this.diffService.toggleIgnoreWhitespace();
    this.ignoreWhitespace.set(this.diffService.isIgnoringWhitespace());
  }

  /** Load more content for the current chapter */
  async loadMore(): Promise<void> {
    await this.diffService.loadMore();
  }

  /** Public method to refresh the diff comparison */
  refresh(): void {
    this.loadComparison();
  }

  /** Check if a specific segment is being edited */
  isEditing(segmentId: string): boolean {
    const state = this.editState();
    return state !== null && state.segmentIds.includes(segmentId);
  }

  /**
   * Find the paragraph block around a clicked segment.
   * Uses \n\n as paragraph boundaries, concatenates segment text (AI's version for changes).
   */
  private getParagraphBlock(clickedSegmentId: string): { segmentIds: string[], paragraphText: string } | null {
    const segments = this.currentChapterSegments();
    const clickedIndex = segments.findIndex(s => s.id === clickedSegmentId);
    if (clickedIndex === -1) return null;

    // Build full text using actual EPUB content (skip deletion display markers)
    let fullText = '';
    const ranges: { start: number; end: number }[] = [];
    for (const seg of segments) {
      const start = fullText.length;
      const actualText = (seg.type === 'change' && seg.text === '(deleted)') ? '' : seg.text;
      fullText += actualText;
      ranges.push({ start, end: fullText.length });
    }

    // Find \n\n paragraph boundaries around the clicked segment
    const clickedStart = ranges[clickedIndex].start;
    const clickedEnd = ranges[clickedIndex].end;

    let paraStart = 0;
    const prevBound = fullText.lastIndexOf('\n\n', clickedStart > 0 ? clickedStart - 1 : 0);
    if (prevBound !== -1) {
      paraStart = prevBound + 2;
    }

    let paraEnd = fullText.length;
    const nextBound = fullText.indexOf('\n\n', clickedEnd);
    if (nextBound !== -1) {
      paraEnd = nextBound;
    }

    // Collect all segments that overlap with the paragraph range
    const segmentIds: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const r = ranges[i];
      if ((r.start < paraEnd && r.end > paraStart) ||
          (r.start === r.end && r.start >= paraStart && r.start <= paraEnd)) {
        segmentIds.push(segments[i].id);
      }
    }

    return { segmentIds, paragraphText: fullText.substring(paraStart, paraEnd) };
  }

  /** Start editing a paragraph block */
  startBlockEdit(segmentIds: string[], paragraphText: string): void {
    this.hideTooltip();
    const chapterId = this.currentChapterId();

    // Find position of first segment in the block
    const container = this.chapterContentRef?.nativeElement;
    const firstSegmentEl = container?.querySelector(`[data-segment-id="${segmentIds[0]}"]`) as HTMLElement;

    let top = 0;
    if (firstSegmentEl && container) {
      const containerRect = container.getBoundingClientRect();
      const segmentRect = firstSegmentEl.getBoundingClientRect();
      top = segmentRect.top - containerRect.top + container.scrollTop;
    }

    this.editPosition.set({ top, left: 0 });

    this.editState.set({
      segmentIds,
      chapterId,
      originalValue: paragraphText,
      editedValue: paragraphText
    });

    setTimeout(() => {
      const textarea = document.querySelector('.edit-textarea') as HTMLTextAreaElement;
      if (textarea) {
        this.autoSizeTextarea(textarea);
        textarea.focus();
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
      }
    }, 0);
  }

  /** Handle textarea input changes */
  onEditInput(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    const state = this.editState();
    if (state) {
      this.editState.set({
        ...state,
        editedValue: textarea.value
      });
      this.autoSizeTextarea(textarea);
    }
  }

  /** Handle keydown in textarea: Enter saves, Shift+Enter inserts newline, Escape cancels */
  onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.saveEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  /** Auto-size textarea to fit content */
  private autoSizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  /** Save the edit */
  saveEdit(): void {
    const state = this.editState();
    if (!state) return;

    if (state.editedValue !== state.originalValue) {
      this.textEdited.emit({
        chapterId: state.chapterId,
        oldText: state.originalValue,
        newText: state.editedValue
      });
    }

    this.editState.set(null);
  }

  /** Cancel the edit */
  cancelEdit(): void {
    this.editState.set(null);
  }

  /** Handle blur - save on blur unless cancelled */
  onEditBlur(): void {
    setTimeout(() => {
      if (this.editState()) {
        this.saveEdit();
      }
    }, 100);
  }
}
