import { Component, input, signal, computed, OnInit, OnDestroy, inject, ElementRef, ViewChild, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { DiffService } from '../../services/diff.service';
import { DiffChapter, DiffWord } from '../../../../core/models/diff.types';
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

interface ChapterWithSegments {
  id: string;
  title: string;
  segments: DiffSegment[];
  changeCount: number;
}

@Component({
  selector: 'app-diff-view',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="diff-view" [class.loading]="loading()">
      <!-- Header -->
      <div class="diff-header">
        <div class="header-left">
          <h4>Review Changes</h4>
          @if (totalChanges() > 0) {
            <span class="change-badge">{{ totalChanges() }} changes</span>
          }
        </div>
        @if (totalChanges() > 0) {
          <div class="change-nav">
            <span class="change-position">{{ currentChangeIndex() + 1 }} of {{ totalChanges() }}</span>
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
              [disabled]="currentChangeIndex() >= totalChanges() - 1"
              (click)="goToNextChange()"
            >
              Next →
            </desktop-button>
          </div>
        }
      </div>

      <!-- Loading state -->
      @if (loading()) {
        <div class="state-message">
          <span class="spinner">&#8635;</span>
          <span>Loading...</span>
        </div>
      } @else if (error()) {
        <div class="state-message error">
          <span>{{ error() }}</span>
          <desktop-button variant="ghost" size="xs" (click)="retry()">
            Retry
          </desktop-button>
        </div>
      } @else if (chaptersWithSegments().length > 0) {
        <!-- Full book content -->
        <div class="book-content" #bookContent>
          @for (chapter of chaptersWithSegments(); track chapter.id) {
            <div class="chapter">
              <h3 class="chapter-title">
                {{ chapter.title }}
                @if (chapter.changeCount > 0) {
                  <span class="chapter-changes">({{ chapter.changeCount }} changes)</span>
                }
              </h3>
              <div class="chapter-text">
                @for (segment of chapter.segments; track segment.id) {
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
                      (dblclick)="startEdit(chapter.id, segment)"
                    >{{ segment.text }}</span>
                  } @else {
                    <!-- Changed text - show only new text, hover for original -->
                    <span
                      class="text-change"
                      [class.focused]="segment.changeIndex === currentChangeIndex()"
                      [class.is-deletion]="segment.text === '(deleted)'"
                      [attr.data-change-index]="segment.changeIndex"
                      (click)="focusChange(segment.changeIndex!)"
                      (dblclick)="startEdit(chapter.id, segment)"
                      (mouseenter)="showTooltip($event, segment)"
                      (mouseleave)="hideTooltip()"
                    >@if (segment.text === '(deleted)') {<span class="deletion-marker">⌫</span>} @else {{{ segment.text }}}</span>
                  }
                }
              </div>
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

        <!-- Footer -->
        <div class="diff-footer">
          <span class="hint">Hover over highlighted text to see original. Double-click to edit.</span>
        </div>
      } @else {
        <div class="state-message">
          <p>No changes to review.</p>
        </div>
      }
    </div>
  `,
  styles: [`
    .diff-view {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      overflow: hidden;
      height: 100%;
      min-height: 300px;
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

    .change-nav {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .change-position {
      font-size: 0.75rem;
      color: var(--text-secondary);
      min-width: 60px;
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

    .book-content {
      flex: 1;
      overflow: auto;
      padding: 1rem 1.5rem;
    }

    .chapter {
      margin-bottom: 2rem;

      &:last-child {
        margin-bottom: 0;
      }
    }

    .chapter-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 0.75rem 0;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .chapter-changes {
      font-size: 0.75rem;
      font-weight: 400;
      color: #ff6b35;
      margin-left: 0.5rem;
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
  @ViewChild('bookContent') bookContentRef!: ElementRef<HTMLDivElement>;

  private readonly diffService = inject(DiffService);
  private subscriptions: Subscription[] = [];

  // Inputs
  readonly originalPath = input<string>('');
  readonly cleanedPath = input<string>('');

  // State
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly currentChangeIndex = signal(0);

  // Tooltip state
  readonly tooltipVisible = signal(false);
  readonly tooltipX = signal(0);
  readonly tooltipY = signal(0);
  readonly tooltipSegment = signal<DiffSegment | null>(null);

  // Edit state
  readonly editState = signal<EditState | null>(null);

  // Output for text edits
  readonly textEdited = output<{ chapterId: string; oldText: string; newText: string }>();

  // From service
  readonly chapters = signal<DiffChapter[]>([]);

  // Computed: total changes across all chapters (only those with originalText)
  readonly totalChanges = computed(() => {
    let count = 0;
    for (const chapter of this.chaptersWithSegments()) {
      for (const segment of chapter.segments) {
        if (segment.type === 'change' && segment.originalText) {
          count++;
        }
      }
    }
    return count;
  });

  // Computed: all chapters with their segments pre-built
  readonly chaptersWithSegments = computed((): ChapterWithSegments[] => {
    let changeIndex = 0;
    return this.chapters().map(chapter => {
      const segments = this.buildSegments(chapter.diffWords, changeIndex, chapter.id);
      // Count how many changes had originalText
      const changesInChapter = segments.filter(s => s.type === 'change' && s.originalText).length;
      changeIndex += changesInChapter;
      return {
        id: chapter.id,
        title: chapter.title,
        segments,
        changeCount: changesInChapter
      };
    });
  });

  ngOnInit(): void {
    // Subscribe to service state
    this.subscriptions.push(
      this.diffService.loading$.subscribe(loading => this.loading.set(loading)),
      this.diffService.error$.subscribe(error => this.error.set(error)),
      this.diffService.session$.subscribe(session => {
        if (session) {
          this.chapters.set(session.chapters);
          this.currentChangeIndex.set(0);
        } else {
          this.chapters.set([]);
        }
      })
    );

    // Load comparison if paths provided
    this.loadComparison();
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
   * Convert diffWords array into display segments.
   * Groups changes (removed/added words) into change regions, handling interleaved patterns.
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
        // This handles interleaved patterns like: removed, added, removed, added
        let removedText = '';
        let addedText = '';

        // Collect all change words (both removed and added) until we hit unchanged
        while (i < diffWords.length && diffWords[i].type !== 'unchanged') {
          if (diffWords[i].type === 'removed') {
            removedText += diffWords[i].text;
          } else if (diffWords[i].type === 'added') {
            addedText += diffWords[i].text;
          }
          i++;
        }

        // Create the change segment - show EXACTLY what changed without any normalization
        if (addedText || removedText) {
          // Always show the change, even if only whitespace differs
          segments.push({
            id: `${chapterId}-${segmentIndex}`,
            type: 'change',
            text: addedText || '(deleted)',  // Show what it became
            originalText: removedText || '(added)',  // Show what it was
            changeIndex: changeIndex++
          });
          segmentIndex++;
        }
      }
    }

    // Add context to change segments - get 2-3 surrounding words for context
    for (let j = 0; j < segments.length; j++) {
      if (segments[j].type === 'change' && segments[j].originalText) {
        // Get 2-3 words before the change for context
        if (j > 0 && segments[j - 1].type === 'unchanged') {
          segments[j].contextBefore = this.getLastWords(segments[j - 1].text, 3);
        }
        // Get 2-3 words after the change for context
        if (j < segments.length - 1 && segments[j + 1].type === 'unchanged') {
          segments[j].contextAfter = this.getFirstWords(segments[j + 1].text, 3);
        }
      }
    }

    return segments;
  }

  goToNextChange(): void {
    const total = this.totalChanges();
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
    // Use setTimeout to let Angular update the DOM first
    setTimeout(() => {
      const container = this.bookContentRef?.nativeElement;
      if (!container) return;

      const changeEl = container.querySelector(`[data-change-index="${index}"]`) as HTMLElement;
      if (changeEl) {
        // Scroll the change into view, centered vertically
        changeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 0);
  }

  /** Extract the last N words from a text string */
  private getLastWords(text: string, count: number): string {
    const words = text.trim().split(/\s+/);
    if (words.length <= count) return text.trim();
    return words.slice(-count).join(' ');
  }

  /** Extract the first N words from a text string */
  private getFirstWords(text: string, count: number): string {
    const words = text.trim().split(/\s+/);
    if (words.length <= count) return text.trim();
    return words.slice(0, count).join(' ');
  }

  showTooltip(event: MouseEvent, segment: DiffSegment): void {
    if (!segment.originalText) return;

    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();

    // Position tooltip below the element
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
  startEdit(chapterId: string, segment: DiffSegment): void {
    this.hideTooltip();
    this.editState.set({
      segmentId: segment.id,
      chapterId,
      originalValue: segment.text,
      editedValue: segment.text
    });

    // Focus the input after Angular updates the DOM
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

    // Only emit if the value actually changed
    if (state.editedValue !== state.originalValue) {
      // Update the segment in our local state
      const chapters = this.chaptersWithSegments();
      const chapter = chapters.find(c => c.id === state.chapterId);
      if (chapter) {
        const segment = chapter.segments.find(s => s.id === state.segmentId);
        if (segment) {
          segment.text = state.editedValue;
        }
      }

      // Emit the change
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
    // Small delay to allow click on other elements
    setTimeout(() => {
      if (this.editState()) {
        this.saveEdit();
      }
    }, 100);
  }
}
