import { Component, input, output, computed, signal, effect, inject, ChangeDetectionStrategy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { Chapter, TocLine } from '../../../../core/services/electron.service';

@Component({
  selector: 'app-chapters-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Chapters</h3>
      <desktop-button variant="ghost" size="xs" (click)="cancel.emit()">Done</desktop-button>
    </div>

    <div class="panel-content">
      <!-- Source Info -->
      <div class="source-info">
        @switch (chaptersSource()) {
          @case ('toc') {
            <div class="info-box toc">
              Loaded from document outline
            </div>
          }
          @case ('heuristic') {
            <div class="info-box heuristic">
              Auto-detected from content
            </div>
          }
          @case ('manual') {
            <div class="info-box manual">
              Click anywhere to add chapters
            </div>
          }
          @case ('mixed') {
            <div class="info-box mixed">
              Combined from multiple sources
            </div>
          }
        }
      </div>

      <!-- TOC Mode: Step 1 — Block selection -->
      @if (tocMode() && tocStep() === 'blocks') {
        <div class="info-box toc-mode">
          Click on TOC entries on the page
          @if (tocEntryCount() > 0) {
            <div class="toc-count">{{ tocEntryCount() }} block{{ tocEntryCount() !== 1 ? 's' : '' }} selected</div>
          }
          <div class="toc-actions">
            <desktop-button
              variant="primary"
              size="sm"
              [disabled]="tocEntryCount() === 0 || detecting()"
              (click)="splitTocBlocks.emit()"
            >
              @if (detecting()) {
                Loading...
              } @else {
                Next
              }
            </desktop-button>
            <desktop-button
              variant="ghost"
              size="sm"
              (click)="toggleTocMode.emit()"
            >
              Cancel
            </desktop-button>
          </div>
        </div>
      }

      <!-- TOC Mode: Step 2 — Line picker -->
      @if (tocMode() && tocStep() === 'lines') {
        <div class="info-box toc-mode">
          Select chapter titles
          <div class="toc-count">{{ checkedCount() }} of {{ tocLines().length }} lines checked</div>
        </div>

        <div class="toc-line-list">
          @for (line of tocLines(); track $index) {
            <div
              class="toc-line-item"
              [class.checked]="tocCheckedIndexes().has($index)"
              [class.dimmed]="line.isPageNumber && !tocCheckedIndexes().has($index)"
              (click)="toggleTocLineCheck.emit($index)"
            >
              <span class="toc-line-text">{{ line.text }}</span>
              @if (line.isPageNumber) {
                <span class="toc-line-badge">page #</span>
              }
            </div>
          }
        </div>

        <div class="toc-actions">
          <desktop-button
            variant="primary"
            size="sm"
            [disabled]="checkedCount() === 0 || detecting()"
            (click)="mapTocEntries.emit()"
          >
            @if (detecting()) {
              Mapping...
            } @else {
              Map Chapters
            }
          </desktop-button>
          <desktop-button
            variant="ghost"
            size="sm"
            (click)="tocGoBack.emit()"
          >
            Back
          </desktop-button>
        </div>
      }

      <!-- Actions -->
      <div class="action-buttons">
        <desktop-button
          variant="secondary"
          size="sm"
          [disabled]="detecting() || tocMode()"
          (click)="autoDetect.emit()"
        >
          @if (detecting() && !tocMode()) {
            Detecting...
          } @else {
            Auto-Detect
          }
        </desktop-button>

        <desktop-button
          variant="secondary"
          size="sm"
          [disabled]="detecting()"
          (click)="toggleTocMode.emit()"
        >
          @if (tocMode()) {
            Cancel TOC
          } @else {
            From TOC
          }
        </desktop-button>

        @if (chapters().length >= 2) {
          <desktop-button
            variant="secondary"
            size="sm"
            [disabled]="detecting() || tocMode()"
            (click)="findSimilarChapters.emit()"
          >
            @if (detecting() && !tocMode()) {
              Finding...
            } @else {
              Find Similar
            }
          </desktop-button>
        }

        @if (chapters().length > 0) {
          <desktop-button
            variant="ghost"
            size="sm"
            (click)="clearChapters.emit()"
          >
            Clear All
          </desktop-button>
        }
      </div>

      <!-- Chapter List -->
      <div class="chapter-list">
        @if (chapters().length === 0) {
          <div class="empty-state">
            <p>No chapters defined yet.</p>
            <p class="hint">Click "Auto-Detect" or click anywhere on a page to add a chapter marker.</p>
            <p class="hint">Markers snap to the nearest text block. Drag markers to reposition.</p>
            <p class="hint">Hold Shift while clicking to add as a section (level 2).</p>
          </div>
        } @else {
          @for (chapter of chapters(); track chapter.id) {
            <div
              class="chapter-item"
              [class.selected]="selectedChapterId() === chapter.id"
              [class.editing]="editingChapterId() === chapter.id"
              (click)="onChapterClick($event, chapter.id)"
              (dblclick)="startEditing($event, chapter)"
              (contextmenu)="onContextMenu($event, chapter)"
            >
              <span
                class="level-indicator"
                [attr.data-level]="chapter.level"
                [title]="'Level ' + chapter.level + ' — right-click to change'"
              >
                @switch (chapter.level) {
                  @case (1) { <span class="level-dot">&#9679;</span> }
                  @case (2) { <span class="level-dot">&#9675;</span> }
                  @default { <span class="level-dot">&#183;</span> }
                }
              </span>
              <div class="chapter-info">
                @if (editingChapterId() === chapter.id) {
                  <input
                    #editInput
                    type="text"
                    class="chapter-title-input"
                    [value]="editingTitle()"
                    (input)="onEditInput($event)"
                    (keydown.enter)="saveEdit(chapter.id)"
                    (keydown.escape)="cancelEdit()"
                    (blur)="onEditBlur(chapter.id)"
                    (click)="$event.stopPropagation()"
                  />
                } @else {
                  <span class="chapter-title" [title]="chapter.title">{{ chapter.title }}</span>
                }
                <span class="chapter-page">p. {{ chapter.page + 1 }}</span>
              </div>
              <button
                class="edit-btn"
                (click)="onEditClick($event, chapter)"
                title="Rename chapter"
              >
                &#9998;
              </button>
              <button
                class="remove-btn"
                (click)="onRemove($event, chapter.id)"
                title="Remove chapter"
              >
                &times;
              </button>
            </div>
          }
        }
      </div>
    </div>

    <div class="panel-footer">
      @if (chapters().length > 0) {
        <desktop-button
          variant="primary"
          size="sm"
          class="finalize-btn"
          [disabled]="finalizing()"
          (click)="finalizeChapters.emit()"
        >
          @if (finalizing()) {
            Saving...
          } @else {
            Save Chapters
          }
        </desktop-button>
        <div class="hint-text">
          {{ chapters().length }} chapter{{ chapters().length !== 1 ? 's' : '' }} ready to export
        </div>
      } @else {
        <div class="hint-text">
          No chapters defined
        </div>
      }
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      height: 100%;
      border-left: 1px solid var(--border-subtle);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      min-height: var(--ui-panel-header);
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
    }

    .panel-title {
      font-size: var(--ui-font-lg);
      font-weight: $font-weight-semibold;
      margin: 0;
      color: var(--text-primary);
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-lg);
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
    }

    .source-info {
      .info-box {
        padding: var(--ui-spacing-sm) var(--ui-spacing-md);
        border-radius: $radius-md;
        font-size: var(--ui-font-sm);
        text-align: center;

        &.toc {
          background: rgba(33, 150, 243, 0.1);
          color: #2196F3;
          border: 1px solid rgba(33, 150, 243, 0.3);
        }

        &.heuristic {
          background: rgba(255, 152, 0, 0.1);
          color: #FF9800;
          border: 1px solid rgba(255, 152, 0, 0.3);
        }

        &.manual {
          background: var(--bg-elevated);
          color: var(--text-secondary);
          border: 1px dashed var(--border-default);
        }

        &.mixed {
          background: rgba(156, 39, 176, 0.1);
          color: #9C27B0;
          border: 1px solid rgba(156, 39, 176, 0.3);
        }
      }
    }

    .info-box.toc-mode {
      background: var(--accent-subtle, rgba(6, 182, 212, 0.1));
      color: var(--accent, #06b6d4);
      border: 1px solid rgba(6, 182, 212, 0.3);
      padding: var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);
      text-align: center;

      .toc-count {
        margin-top: var(--ui-spacing-xs);
        font-weight: $font-weight-semibold;
      }
    }

    .toc-actions {
      display: flex;
      gap: var(--ui-spacing-sm);
      margin-top: var(--ui-spacing-sm);
      justify-content: center;
    }

    .toc-line-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 400px;
      overflow-y: auto;
    }

    .toc-line-item {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      border-radius: $radius-sm;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background-color 0.15s ease, border-color 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.checked {
        background: var(--selected-bg-muted, #cffafe);
        border-color: var(--accent, #06b6d4);

        .toc-line-text {
          color: var(--text-primary);
        }
      }

      &.dimmed {
        opacity: 0.45;
      }
    }

    .toc-line-text {
      flex: 1;
      min-width: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .toc-line-badge {
      flex-shrink: 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      background: var(--bg-elevated);
      padding: 1px 6px;
      border-radius: $radius-sm;
      border: 1px solid var(--border-subtle);
    }

    .action-buttons {
      display: flex;
      gap: var(--ui-spacing-sm);

      desktop-button {
        flex: 1;
      }
    }

    .chapter-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
    }

    .empty-state {
      text-align: center;
      padding: var(--ui-spacing-xl);
      color: var(--text-secondary);

      p {
        margin: 0 0 var(--ui-spacing-sm);

        &.hint {
          font-size: var(--ui-font-xs);
          color: var(--text-tertiary);
        }
      }
    }

    .chapter-item {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      cursor: pointer;
      transition: background-color 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: var(--bg-selected);
        border: 1px solid var(--accent);
      }

      &.editing {
        background: var(--bg-elevated);
      }
    }

    .level-indicator {
      flex-shrink: 0;
      width: 20px;
      display: flex;
      align-items: center;
      justify-content: center;

      .level-dot {
        color: var(--accent);
        font-size: var(--ui-font-sm);
      }

      &[data-level="2"] {
        padding-left: 8px;

        .level-dot {
          color: var(--text-secondary);
        }
      }

      &[data-level="3"] {
        padding-left: 16px;

        .level-dot {
          color: var(--text-tertiary);
        }
      }
    }

    .chapter-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .chapter-title {
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chapter-title-input {
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      background: var(--bg-surface);
      border: 1px solid var(--accent);
      border-radius: $radius-sm;
      padding: 2px 6px;
      width: 100%;
      outline: none;

      &:focus {
        box-shadow: 0 0 0 2px rgba(255, 107, 53, 0.2);
      }
    }

    .chapter-page {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .edit-btn,
    .remove-btn {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      border-radius: $radius-sm;
      font-size: 16px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.15s ease, background-color 0.15s ease;

      .chapter-item:hover & {
        opacity: 1;
      }

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .panel-footer {
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--ui-spacing-sm);
    }

    .finalize-btn {
      width: 100%;
    }

    .hint-text {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      text-align: center;
    }
  `]
})
export class ChaptersPanelComponent {
  @ViewChild('editInput') editInput?: ElementRef<HTMLInputElement>;
  private readonly elementRef = inject(ElementRef);

  chapters = input.required<Chapter[]>();
  chaptersSource = input.required<'toc' | 'heuristic' | 'manual' | 'mixed'>();
  detecting = input<boolean>(false);
  finalizing = input<boolean>(false);
  selectedChapterId = input<string | null>(null);
  tocMode = input<boolean>(false);
  tocEntryCount = input<number>(0);
  tocStep = input<'blocks' | 'lines'>('blocks');
  tocLines = input<TocLine[]>([]);
  tocCheckedIndexes = input<Set<number>>(new Set());

  cancel = output<void>();
  autoDetect = output<void>();
  findSimilarChapters = output<void>();
  toggleTocMode = output<void>();
  splitTocBlocks = output<void>();
  mapTocEntries = output<void>();
  toggleTocLineCheck = output<number>();
  tocGoBack = output<void>();
  clearChapters = output<void>();
  selectChapter = output<string>();
  removeChapter = output<string>();
  finalizeChapters = output<void>();
  renameChapter = output<{ chapterId: string; newTitle: string }>();
  changeLevelChapter = output<{ chapterId: string; level: number }>();

  // Computed: how many lines are checked
  readonly checkedCount = computed(() => this.tocCheckedIndexes().size);

  // Editing state
  readonly editingChapterId = signal<string | null>(null);
  readonly editingTitle = signal<string>('');
  private saveOnBlur = true;

  // Auto-scroll selected chapter into view
  private readonly scrollEffect = effect(() => {
    const id = this.selectedChapterId();
    if (!id) return;
    // Run after render so the DOM has the .selected class
    setTimeout(() => {
      const el = (this.elementRef.nativeElement as HTMLElement).querySelector('.chapter-item.selected');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 0);
  });

  onChapterClick(event: Event, chapterId: string): void {
    // Don't select if we're editing
    if (this.editingChapterId()) {
      return;
    }
    this.selectChapter.emit(chapterId);
  }

  startEditing(event: Event, chapter: Chapter): void {
    event.stopPropagation();
    this.editingChapterId.set(chapter.id);
    this.editingTitle.set(chapter.title);
    this.saveOnBlur = true;

    // Focus the input after Angular renders it
    setTimeout(() => {
      this.editInput?.nativeElement.focus();
      this.editInput?.nativeElement.select();
    }, 0);
  }

  onEditClick(event: Event, chapter: Chapter): void {
    event.stopPropagation();
    this.startEditing(event, chapter);
  }

  onEditInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.editingTitle.set(input.value);
  }

  saveEdit(chapterId: string): void {
    const newTitle = this.editingTitle().trim();
    if (newTitle && newTitle !== this.chapters().find(c => c.id === chapterId)?.title) {
      this.renameChapter.emit({ chapterId, newTitle });
    }
    this.cancelEdit();
  }

  cancelEdit(): void {
    this.saveOnBlur = false;
    this.editingChapterId.set(null);
    this.editingTitle.set('');
  }

  onEditBlur(chapterId: string): void {
    // Small delay to allow click events to fire first
    setTimeout(() => {
      if (this.saveOnBlur && this.editingChapterId() === chapterId) {
        this.saveEdit(chapterId);
      }
    }, 100);
  }

  onContextMenu(event: MouseEvent, chapter: Chapter): void {
    event.preventDefault();
    event.stopPropagation();
    const nextLevel = chapter.level >= 3 ? 1 : chapter.level + 1;
    this.changeLevelChapter.emit({ chapterId: chapter.id, level: nextLevel });
  }

  onRemove(event: Event, chapterId: string): void {
    event.stopPropagation();
    this.removeChapter.emit(chapterId);
  }
}
