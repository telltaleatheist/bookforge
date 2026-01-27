/**
 * Chapter List Component - Shows chapters with exclude toggles for reassembly
 */

import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { E2aChapter } from '../../models/reassembly.types';

@Component({
  selector: 'app-chapter-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="chapter-list">
      <div class="list-header">
        <span>Chapters</span>
        <span class="chapter-count">{{ chapters().length }} chapters</span>
      </div>

      @if (chapters().length === 0) {
        <div class="empty-state">
          No chapter information available
        </div>
      } @else {
        <div class="chapters">
          @for (chapter of chapters(); track chapter.chapterNum) {
            <div
              class="chapter-item"
              [class.excluded]="chapter.excluded"
              [class.incomplete]="chapter.completedCount < chapter.sentenceCount"
            >
              <label class="chapter-checkbox">
                <input
                  type="checkbox"
                  [checked]="!chapter.excluded"
                  (change)="toggleExclude.emit(chapter.chapterNum)"
                />
                <span class="checkmark"></span>
              </label>

              <div class="chapter-info">
                <div class="chapter-title">
                  <span class="chapter-num">Ch. {{ chapter.chapterNum }}</span>
                  @if (chapter.title) {
                    <span class="title-text">{{ chapter.title }}</span>
                  }
                </div>
                <div class="chapter-progress">
                  <div class="progress-bar">
                    <div
                      class="progress-fill"
                      [style.width.%]="getProgressPercent(chapter)"
                      [class.complete]="chapter.completedCount >= chapter.sentenceCount"
                    ></div>
                  </div>
                  <span class="progress-text">
                    {{ chapter.completedCount }}/{{ chapter.sentenceCount }} sentences
                    @if (chapter.completedCount < chapter.sentenceCount) {
                      <span class="missing">({{ chapter.sentenceCount - chapter.completedCount }} missing)</span>
                    }
                  </span>
                </div>
              </div>
            </div>
          }
        </div>

        @if (excludedCount() > 0) {
          <div class="excluded-info">
            {{ excludedCount() }} chapter(s) excluded from reassembly
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .chapter-list {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-default);
      font-weight: 500;
      color: var(--text-primary);

      .chapter-count {
        font-size: 12px;
        font-weight: normal;
        color: var(--text-secondary);
      }
    }

    .chapters {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      color: var(--text-secondary);
    }

    .chapter-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      margin-bottom: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
      }

      &.excluded {
        opacity: 0.5;
        background: var(--bg-muted);
      }

      &.incomplete:not(.excluded) {
        border-left: 3px solid var(--status-warning);
      }
    }

    .chapter-checkbox {
      position: relative;
      display: flex;
      align-items: center;
      cursor: pointer;
      margin-top: 2px;

      input {
        position: absolute;
        opacity: 0;
        cursor: pointer;
        height: 0;
        width: 0;
      }

      .checkmark {
        height: 18px;
        width: 18px;
        background: var(--bg-base);
        border: 2px solid var(--border-default);
        border-radius: 4px;
        transition: all 0.15s ease;

        &::after {
          content: '';
          position: absolute;
          display: none;
          left: 6px;
          top: 2px;
          width: 4px;
          height: 9px;
          border: solid var(--bg-base);
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
      }

      input:checked ~ .checkmark {
        background: var(--accent);
        border-color: var(--accent);

        &::after {
          display: block;
        }
      }
    }

    .chapter-info {
      flex: 1;
      min-width: 0;
    }

    .chapter-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;

      .chapter-num {
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
      }

      .title-text {
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    .chapter-progress {
      .progress-bar {
        height: 4px;
        background: var(--bg-muted);
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 4px;
      }

      .progress-fill {
        height: 100%;
        background: var(--status-warning);
        border-radius: 2px;
        transition: width 0.3s ease;

        &.complete {
          background: var(--status-success);
        }
      }

      .progress-text {
        font-size: 11px;
        color: var(--text-secondary);

        .missing {
          color: var(--status-warning);
        }
      }
    }

    .excluded-info {
      padding: 12px 16px;
      border-top: 1px solid var(--border-default);
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-muted);
    }
  `]
})
export class ChapterListComponent {
  readonly chapters = input.required<E2aChapter[]>();

  readonly toggleExclude = output<number>();

  excludedCount(): number {
    return this.chapters().filter(ch => ch.excluded).length;
  }

  getProgressPercent(chapter: E2aChapter): number {
    if (chapter.sentenceCount === 0) return 0;
    return Math.round((chapter.completedCount / chapter.sentenceCount) * 100);
  }
}
