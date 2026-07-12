import { Component, input, output, computed, signal, effect, inject, ChangeDetectionStrategy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';
import { Chapter, TocLine } from '../../../../core/services/electron.service';

const MIN_LEVEL = 1;
const MAX_LEVEL = 3;

@Component({
  selector: 'app-chapters-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, PanelShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell
      [title]="'Chapters'"
      [statusLine]="statusLine()"
      (close)="cancel.emit()"
    >
      <!-- Source Info -->
      <div class="source-info">
        @switch (chaptersSource()) {
          @case ('toc') {
            <div class="info-box toc">Loaded from document outline</div>
          }
          @case ('heuristic') {
            <div class="info-box heuristic">Auto-detected from content</div>
          }
          @case ('manual') {
            <div class="info-box manual">Click anywhere to add chapters</div>
          }
          @case ('mixed') {
            <div class="info-box mixed">Combined from multiple sources</div>
          }
        }
      </div>

      <!-- TOC wizard: Step 1 — block selection -->
      @if (tocMode() && tocStep() === 'blocks') {
        <div class="stepper">
          <div class="step-heading">Step 1 of 2</div>
          <div class="step-instruction">Select the table-of-contents block(s) on the page.</div>
          @if (tocEntryCount() > 0) {
            <div class="step-count">{{ tocEntryCount() }} block{{ tocEntryCount() !== 1 ? 's' : '' }} selected</div>
          }
          <div class="step-actions">
            <desktop-button
              variant="ghost"
              size="sm"
              (click)="toggleTocMode.emit()"
            >
              Cancel
            </desktop-button>
            <desktop-button
              variant="primary"
              size="sm"
              [disabled]="tocEntryCount() === 0 || detecting()"
              (click)="splitTocBlocks.emit()"
            >
              @if (detecting()) { Loading… } @else { Next → }
            </desktop-button>
          </div>
        </div>
      }

      <!-- TOC wizard: Step 2 — line picker -->
      @if (tocMode() && tocStep() === 'lines') {
        <div class="stepper">
          <div class="step-heading">Step 2 of 2</div>
          <div class="step-instruction">Check the lines that are chapter entries.</div>
          <div class="step-count">{{ checkedCount() }} of {{ tocLines().length }} line{{ tocLines().length !== 1 ? 's' : '' }} checked</div>
        </div>

        <div class="toc-line-list">
          @for (line of tocLines(); track $index) {
            <div
              class="toc-line-item"
              [class.checked]="tocCheckedIndexes().has($index)"
              [class.dimmed]="line.isPageNumber && !tocCheckedIndexes().has($index)"
              (click)="toggleTocLineCheck.emit($index)"
            >
              <span class="toc-line-check">
                @if (tocCheckedIndexes().has($index)) { &#10003; }
              </span>
              <span class="toc-line-text">{{ line.text }}</span>
              @if (line.isPageNumber) {
                <span class="toc-line-badge">page #</span>
              }
            </div>
          }
        </div>

        <div class="step-actions">
          <desktop-button
            variant="ghost"
            size="sm"
            (click)="tocGoBack.emit()"
          >
            ← Back
          </desktop-button>
          <desktop-button
            variant="primary"
            size="sm"
            [disabled]="checkedCount() === 0 || detecting()"
            (click)="mapTocEntries.emit()"
          >
            @if (detecting()) {
              Mapping…
            } @else {
              Map {{ checkedCount() }} chapter{{ checkedCount() !== 1 ? 's' : '' }}
            }
          </desktop-button>
        </div>
      }

      <!-- Actions (hidden mid-wizard) -->
      @if (!tocMode()) {
        <div class="action-buttons">
          <desktop-button
            variant="secondary"
            size="sm"
            [disabled]="detecting()"
            (click)="autoDetect.emit()"
          >
            @if (detecting()) { Detecting… } @else { Auto-Detect }
          </desktop-button>

          <desktop-button
            variant="secondary"
            size="sm"
            [disabled]="detecting()"
            (click)="toggleTocMode.emit()"
          >
            From TOC
          </desktop-button>

          @if (chapters().length >= 2) {
            <desktop-button
              variant="secondary"
              size="sm"
              [disabled]="detecting()"
              (click)="findSimilarChapters.emit()"
            >
              @if (detecting()) { Finding… } @else { Find Similar }
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
      }

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
              (click)="onChapterClick(chapter.id)"
            >
              <!-- Visible level control: −/+ around the level dot -->
              <div class="level-control" (click)="$event.stopPropagation()">
                <button
                  type="button"
                  class="level-btn"
                  [disabled]="chapter.level <= MIN_LEVEL"
                  (click)="decreaseLevel(chapter)"
                  title="Promote (outdent)"
                >
                  &minus;
                </button>
                <span
                  class="level-dot"
                  [attr.data-level]="chapter.level"
                  [title]="'Level ' + chapter.level"
                >
                  @switch (chapter.level) {
                    @case (1) { &#9679; }
                    @case (2) { &#9675; }
                    @default { &#183; }
                  }
                </span>
                <button
                  type="button"
                  class="level-btn"
                  [disabled]="chapter.level >= MAX_LEVEL"
                  (click)="increaseLevel(chapter)"
                  title="Demote (indent)"
                >
                  +
                </button>
              </div>

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

              @if (editingChapterId() !== chapter.id) {
                <button
                  class="edit-btn"
                  (click)="onEditClick($event, chapter)"
                  title="Rename chapter"
                >
                  &#9998;
                </button>
              }
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

      <div footer class="footer-content">
        @if (chapters().length > 0) {
          <desktop-button
            variant="primary"
            size="sm"
            class="finalize-btn"
            [disabled]="finalizing()"
            (click)="finalizeChapters.emit()"
          >
            @if (finalizing()) { Saving… } @else { Save Chapters }
          </desktop-button>
          <div class="hint-text">
            {{ chapters().length }} chapter{{ chapters().length !== 1 ? 's' : '' }} ready to export
          </div>
        } @else {
          <div class="hint-text">No chapters defined</div>
        }
      </div>
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: block;
      height: 100%;
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

    .stepper {
      margin-top: var(--ui-spacing-md);
      padding: var(--ui-spacing-md);
      background: var(--accent-subtle, rgba(6, 182, 212, 0.1));
      border: 1px solid rgba(6, 182, 212, 0.3);
      border-radius: $radius-md;
    }

    .step-heading {
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-semibold;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--accent, #06b6d4);
      margin-bottom: var(--ui-spacing-xs);
    }

    .step-instruction {
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      line-height: 1.4;
    }

    .step-count {
      margin-top: var(--ui-spacing-xs);
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
    }

    .step-actions {
      display: flex;
      gap: var(--ui-spacing-sm);
      margin-top: var(--ui-spacing-md);
      justify-content: flex-end;
    }

    .stepper .step-actions {
      margin-top: var(--ui-spacing-sm);
    }

    .toc-line-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 400px;
      overflow-y: auto;
      margin-top: var(--ui-spacing-sm);
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

    .toc-line-check {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
      color: var(--accent, #06b6d4);
      font-size: var(--ui-font-sm);
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
      flex-wrap: wrap;
      gap: var(--ui-spacing-sm);
      margin-top: var(--ui-spacing-md);

      desktop-button {
        flex: 1;
      }
    }

    .chapter-list {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
      margin-top: var(--ui-spacing-md);
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

    .level-control {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .level-btn {
      width: 18px;
      height: 18px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      border-radius: $radius-sm;
      font-size: 13px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background-color 0.15s ease, color 0.15s ease;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.35;
        cursor: default;
      }
    }

    .level-dot {
      width: 18px;
      text-align: center;
      font-size: var(--ui-font-sm);
      color: var(--accent);

      &[data-level="2"] {
        color: var(--text-secondary);
      }

      &[data-level="3"] {
        color: var(--text-tertiary);
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

    .footer-content {
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

  readonly MIN_LEVEL = MIN_LEVEL;
  readonly MAX_LEVEL = MAX_LEVEL;

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

  /** How many lines are checked in the TOC line picker. */
  readonly checkedCount = computed(() => this.tocCheckedIndexes().size);

  /** Live count summary shown in the panel-shell status line. */
  readonly statusLine = computed(() => {
    const n = this.chapters().length;
    return n === 0 ? 'none marked' : `${n} chapter${n !== 1 ? 's' : ''}`;
  });

  // Editing state — a SINGLE rename path (✎ button → input; Enter/blur save, Esc cancel).
  readonly editingChapterId = signal<string | null>(null);
  readonly editingTitle = signal<string>('');

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

  onChapterClick(chapterId: string): void {
    // Don't select while editing another row's title.
    if (this.editingChapterId()) {
      return;
    }
    this.selectChapter.emit(chapterId);
  }

  onEditClick(event: Event, chapter: Chapter): void {
    event.stopPropagation();
    this.editingChapterId.set(chapter.id);
    this.editingTitle.set(chapter.title);
    // Focus the input after Angular renders it.
    setTimeout(() => {
      this.editInput?.nativeElement.focus();
      this.editInput?.nativeElement.select();
    }, 0);
  }

  onEditInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.editingTitle.set(input.value);
  }

  saveEdit(chapterId: string): void {
    // Guard against a stale blur firing after the row already left edit mode.
    if (this.editingChapterId() !== chapterId) return;
    const newTitle = this.editingTitle().trim();
    const current = this.chapters().find(c => c.id === chapterId)?.title;
    if (newTitle && newTitle !== current) {
      this.renameChapter.emit({ chapterId, newTitle });
    }
    this.clearEditing();
  }

  cancelEdit(): void {
    this.clearEditing();
  }

  onEditBlur(chapterId: string): void {
    // Blur commits — the input already left the DOM on Enter/Esc, so the
    // editingChapterId guard in saveEdit makes a post-cancel blur a no-op.
    this.saveEdit(chapterId);
  }

  private clearEditing(): void {
    this.editingChapterId.set(null);
    this.editingTitle.set('');
  }

  increaseLevel(chapter: Chapter): void {
    if (chapter.level >= MAX_LEVEL) return;
    this.changeLevelChapter.emit({ chapterId: chapter.id, level: chapter.level + 1 });
  }

  decreaseLevel(chapter: Chapter): void {
    if (chapter.level <= MIN_LEVEL) return;
    this.changeLevelChapter.emit({ chapterId: chapter.id, level: chapter.level - 1 });
  }

  onRemove(event: Event, chapterId: string): void {
    event.stopPropagation();
    this.removeChapter.emit(chapterId);
  }
}
