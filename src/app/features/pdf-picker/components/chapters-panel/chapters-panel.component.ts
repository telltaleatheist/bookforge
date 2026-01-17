import { Component, input, output, signal, ChangeDetectionStrategy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { Chapter } from '../../../../core/services/electron.service';

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
              Click blocks to mark chapters
            </div>
          }
          @case ('mixed') {
            <div class="info-box mixed">
              Combined from multiple sources
            </div>
          }
        }
      </div>

      <!-- Actions -->
      <div class="action-buttons">
        <desktop-button
          variant="secondary"
          size="sm"
          [disabled]="detecting()"
          (click)="autoDetect.emit()"
        >
          @if (detecting()) {
            Detecting...
          } @else {
            Auto-Detect Chapters
          }
        </desktop-button>

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
            <p class="hint">Click "Auto-Detect" or click on text blocks in chapters mode to mark chapter headings.</p>
            <p class="hint">Hold Shift while clicking to add as a section (level 2) instead of chapter (level 1).</p>
          </div>
        } @else {
          @for (chapter of chapters(); track chapter.id) {
            <div
              class="chapter-item"
              [class.selected]="selectedChapterId() === chapter.id"
              [class.editing]="editingChapterId() === chapter.id"
              (click)="onChapterClick($event, chapter.id)"
              (dblclick)="startEditing($event, chapter)"
            >
              <span class="level-indicator" [attr.data-level]="chapter.level">
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
            Finalizing...
          } @else {
            Finalize Chapters
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

  chapters = input.required<Chapter[]>();
  chaptersSource = input.required<'toc' | 'heuristic' | 'manual' | 'mixed'>();
  detecting = input<boolean>(false);
  finalizing = input<boolean>(false);
  selectedChapterId = input<string | null>(null);

  cancel = output<void>();
  autoDetect = output<void>();
  clearChapters = output<void>();
  selectChapter = output<string>();
  removeChapter = output<string>();
  finalizeChapters = output<void>();
  renameChapter = output<{ chapterId: string; newTitle: string }>();

  // Editing state
  readonly editingChapterId = signal<string | null>(null);
  readonly editingTitle = signal<string>('');
  private saveOnBlur = true;

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

  onRemove(event: Event, chapterId: string): void {
    event.stopPropagation();
    this.removeChapter.emit(chapterId);
  }
}
