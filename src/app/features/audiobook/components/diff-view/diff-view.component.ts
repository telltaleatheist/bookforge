import { Component, input, signal, computed, OnInit, OnDestroy, inject, ElementRef, ViewChild, output, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { DiffService, DiffLoadingProgress } from '../../services/diff.service';
import { DiffChapter, DiffChapterMeta, DiffWord } from '../../../../core/models/diff.types';
import { Subscription } from 'rxjs';

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
  segmentId: string;      // Unique segment ID
  chapterId: string;      // Chapter for saving
  originalValue: string;
  editedValue: string;
}

@Component({
  selector: 'app-diff-view',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="diff-view" [class.loading]="loading()">
      <!-- Header with chapter selector -->
      <div class="diff-header">
        <div class="header-left">
          <h4>Review Changes</h4>
          @if (totalChanges() > 0) {
            <span class="change-badge">{{ totalChanges() }} changes</span>
          }
          @if (backgroundLoading()) {
            <span class="background-loading-indicator" title="Loading remaining content in background">
              <span class="spinner-small">&#8635;</span>
            </span>
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

          <!-- Change navigation within chapter -->
          @if (currentChapterChangeCount() > 0) {
            <div class="change-nav">
              <span class="change-position">Change {{ currentChangeIndex() + 1 }} of {{ currentChapterChangeCount() }}</span>
              <desktop-button
                variant="ghost"
                size="xs"
                [disabled]="currentChangeIndex() <= 0"
                (click)="goToPrevChange()"
              >
                ← Prev
              </desktop-button>
              <desktop-button
                variant="ghost"
                size="xs"
                [disabled]="currentChangeIndex() >= currentChapterChangeCount() - 1"
                (click)="goToNextChange()"
              >
                Next →
              </desktop-button>
            </div>
          }

          <div class="chapter-content" #chapterContent>
            <div class="chapter-text">
              @for (segment of currentChapterSegments(); track segment.id) {
                @if (isEditing(segment.id)) {
                  <!-- Editing any segment -->
                  <span class="text-editing">
                    <input
                      type="text"
                      class="edit-input"
                      [value]="editState()?.editedValue"
                      (input)="onEditInput($event)"
                      (keydown.enter)="saveEdit()"
                      (keydown.escape)="cancelEdit()"
                      (blur)="onEditBlur()"
                      #editInput
                    />
                    <span class="edit-hint">Enter to save, Esc to cancel</span>
                  </span>
                } @else if (segment.type === 'unchanged') {
                  <!-- Unchanged text - editable on double-click -->
                  <span
                    class="text-editable"
                    (dblclick)="startEdit(segment)"
                  >{{ segment.text }}</span>
                } @else {
                  <!-- Changed text - show only new text, hover for original -->
                  <span
                    class="text-change"
                    [class.focused]="segment.changeIndex === currentChangeIndex()"
                    [class.is-deletion]="segment.text === '(deleted)'"
                    [attr.data-change-index]="segment.changeIndex"
                    (click)="focusChange(segment.changeIndex!)"
                    (dblclick)="startEdit(segment)"
                    (mouseenter)="showTooltip($event, segment)"
                    (mouseleave)="hideTooltip()"
                  >@if (segment.text === '(deleted)') {<span class="deletion-marker">&#9003;</span>} @else {{{ segment.text }}}</span>
                }
              }
            </div>
          </div>

          <!-- Load More button for large chapters -->
          @if (hasMoreContent()) {
            <div class="load-more-section">
              <desktop-button
                variant="secondary"
                size="sm"
                [disabled]="chapterLoading()"
                (click)="loadMore()"
              >
                @if (chapterLoading()) {
                  Loading...
                } @else {
                  Load More ({{ contentLoadProgress() }}% loaded)
                }
              </desktop-button>
            </div>
          }

          <!-- Tooltip showing original text -->
          @if (tooltipVisible() && tooltipSegment()) {
            <div
              class="change-tooltip"
              [style.left.px]="tooltipX()"
              [style.top.px]="tooltipY()"
            >
              <div class="tooltip-row">
                <span class="tooltip-label">Was:</span>
                <span class="tooltip-original">"{{ tooltipSegment()!.originalText }}"</span>
              </div>
              @if (tooltipSegment()!.text !== '(deleted)') {
                <div class="tooltip-row">
                  <span class="tooltip-label">Now:</span>
                  <span class="tooltip-new">"{{ tooltipSegment()!.text }}"</span>
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

    .background-loading-indicator {
      display: inline-flex;
      align-items: center;
      margin-left: 0.5rem;
      color: var(--text-tertiary);
    }

    .spinner-small {
      display: inline-block;
      animation: spin 1s linear infinite;
      font-size: 0.875rem;
      opacity: 0.6;
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
      border: 1px solid var(--border-default);
      border-radius: 4px;
      background: var(--bg-default);
      color: var(--text-primary);
      font-size: 0.75rem;
      max-width: 250px;
      cursor: pointer;

      &:focus {
        outline: none;
        border-color: var(--accent-primary);
      }
    }

    .chapter-nav-buttons {
      display: flex;
      gap: 0.25rem;
    }

    .change-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.25rem 0.75rem;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .change-position {
      font-size: 0.75rem;
      color: var(--text-secondary);
      min-width: 100px;
      text-align: center;
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

    .load-more-section {
      display: flex;
      justify-content: center;
      padding: 1rem;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-subtle);
      flex-shrink: 0;
    }

    .chapter-content {
      flex: 1;
      overflow: auto;
      padding: 1rem 1.5rem;
    }

    .chapter-text {
      font-size: 0.9375rem;
      line-height: 1.75;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-wrap: break-word;
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

      &.focused {
        outline: 2px solid #ff6b35;
        outline-offset: 2px;
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

    .text-editing {
      display: inline-flex;
      flex-direction: column;
      position: relative;
    }

    .edit-input {
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      padding: 2px 6px;
      border: 2px solid #ff6b35;
      border-radius: 3px;
      background: var(--bg-default);
      color: var(--text-primary);
      outline: none;
      min-width: 100px;
      max-width: 400px;

      &:focus {
        box-shadow: 0 0 0 3px rgba(255, 107, 53, 0.3);
      }
    }

    .edit-hint {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 4px;
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
export class DiffViewComponent implements OnInit, OnDestroy {
  @ViewChild('chapterContent') chapterContentRef!: ElementRef<HTMLDivElement>;

  private readonly diffService = inject(DiffService);
  private subscriptions: Subscription[] = [];

  // Inputs
  readonly originalPath = input<string>('');
  readonly cleanedPath = input<string>('');

  // State
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly currentChangeIndex = signal(0);
  readonly loadingProgress = signal<DiffLoadingProgress | null>(null);
  readonly chapterLoading = signal(false);
  readonly backgroundLoading = signal(false);

  // Tooltip state
  readonly tooltipVisible = signal(false);
  readonly tooltipX = signal(0);
  readonly tooltipY = signal(0);
  readonly tooltipSegment = signal<DiffSegment | null>(null);

  // Edit state
  readonly editState = signal<EditState | null>(null);

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

  constructor() {
    // Effect to watch for path changes and reload comparison
    effect(() => {
      const original = this.originalPath();
      const cleaned = this.cleanedPath();

      console.log('[DiffView] effect: paths=', { original: original?.slice(-30), cleaned: cleaned?.slice(-30) });

      // Only reload if paths changed and both are provided
      if (original && cleaned &&
          (original !== this.previousPaths.original || cleaned !== this.previousPaths.cleaned)) {
        console.log('[DiffView] effect: paths changed, will load');
        this.previousPaths = { original, cleaned };
        // Use setTimeout to avoid issues with effect running during change detection
        setTimeout(() => this.loadComparison(), 0);
      } else if (!original || !cleaned) {
        console.log('[DiffView] effect: missing paths');
      } else {
        console.log('[DiffView] effect: paths unchanged');
      }
    });
  }

  // Computed: segments for current chapter (shows all loaded content)
  readonly currentChapterSegments = computed((): DiffSegment[] => {
    const chapter = this.currentChapter();
    if (!chapter) return [];

    return this.buildSegments(chapter.diffWords, 0, chapter.id);
  });

  // Computed: change count for current chapter
  readonly currentChapterChangeCount = computed(() => {
    const chapter = this.currentChapter();
    return chapter?.changeCount ?? 0;
  });

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
      this.diffService.backgroundLoading$.subscribe(loading => this.backgroundLoading.set(loading)),
      this.diffService.session$.subscribe(session => {
        if (session) {
          this.chaptersMeta.set(session.chaptersMeta);
          this.currentChapterId.set(session.currentChapterId);

          // Get current chapter if loaded
          const current = session.chapters.find(c => c.id === session.currentChapterId);
          this.currentChapter.set(current || null);
          this.currentChangeIndex.set(0);
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
        this.loadComparison();
      }
    }, 100);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  private async loadComparison(): Promise<void> {
    const original = this.originalPath();
    const cleaned = this.cleanedPath();

    if (!original || !cleaned) {
      return;
    }

    await this.diffService.loadComparison(original, cleaned);
  }

  /**
   * Handle chapter selection change
   */
  async onChapterChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const chapterId = select.value;
    this.currentChangeIndex.set(0);
    await this.diffService.setCurrentChapter(chapterId);
  }

  /**
   * Navigate to previous chapter
   */
  async goToPrevChapter(): Promise<void> {
    this.currentChangeIndex.set(0);
    await this.diffService.previousChapter();
  }

  /**
   * Navigate to next chapter
   */
  async goToNextChapter(): Promise<void> {
    this.currentChangeIndex.set(0);
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

  goToNextChange(): void {
    const total = this.currentChapterChangeCount();
    const current = this.currentChangeIndex();
    if (current < total - 1) {
      this.focusChange(current + 1);
    }
  }

  goToPrevChange(): void {
    const current = this.currentChangeIndex();
    if (current > 0) {
      this.focusChange(current - 1);
    }
  }

  focusChange(index: number): void {
    this.currentChangeIndex.set(index);
    this.scrollToChange(index);
  }

  private scrollToChange(index: number): void {
    setTimeout(() => {
      const container = this.chapterContentRef?.nativeElement;
      if (!container) return;

      const changeEl = container.querySelector(`[data-change-index="${index}"]`) as HTMLElement;
      if (changeEl) {
        changeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 0);
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
    this.tooltipVisible.set(false);
    this.tooltipSegment.set(null);
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
    return state !== null && state.segmentId === segmentId;
  }

  /** Start editing a segment */
  startEdit(segment: DiffSegment): void {
    this.hideTooltip();
    const chapterId = this.currentChapterId();
    this.editState.set({
      segmentId: segment.id,
      chapterId,
      originalValue: segment.text,
      editedValue: segment.text
    });

    setTimeout(() => {
      const input = document.querySelector('.edit-input') as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  /** Handle input changes */
  onEditInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const state = this.editState();
    if (state) {
      this.editState.set({
        ...state,
        editedValue: input.value
      });
    }
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
