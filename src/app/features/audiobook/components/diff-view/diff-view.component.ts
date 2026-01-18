import { Component, input, output, signal, computed, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { DiffPaneComponent } from './diff-pane.component';
import { DiffService } from '../../services/diff.service';
import { DiffChapter } from '../../../../core/models/diff.types';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-diff-view',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, DiffPaneComponent],
  template: `
    <div class="diff-view" [class.loading]="loading()" [class.expanded]="expanded()">
      <!-- Header -->
      <div class="diff-header">
        <div class="header-left">
          <h4>Compare Changes</h4>
          @if (totalChanges() > 0) {
            <span class="total-changes">{{ totalChanges() }} total changes</span>
          }
        </div>
        <div class="header-controls">
          @if (chapters().length > 0) {
            <!-- Chapter selector -->
            <select
              class="chapter-select"
              [value]="currentChapterId()"
              (change)="selectChapter($any($event.target).value)"
            >
              @for (chapter of chapters(); track chapter.id) {
                <option [value]="chapter.id">
                  {{ chapter.title }}
                  @if (chapter.changeCount > 0) {
                    ({{ chapter.changeCount }})
                  }
                </option>
              }
            </select>

            <!-- Navigation buttons -->
            <div class="nav-buttons">
              <desktop-button
                variant="ghost"
                size="xs"
                [disabled]="!canGoPrevious()"
                (click)="previousChapter()"
              >
                &#8592; Prev
              </desktop-button>
              <desktop-button
                variant="ghost"
                size="xs"
                [disabled]="!canGoNext()"
                (click)="nextChapter()"
              >
                Next &#8594;
              </desktop-button>
            </div>
          }

          <!-- Expand/Collapse button -->
          <desktop-button
            variant="ghost"
            size="xs"
            (click)="toggleExpanded()"
          >
            {{ expanded() ? 'Collapse' : 'Expand' }}
          </desktop-button>

          <!-- Close button -->
          <desktop-button
            variant="ghost"
            size="xs"
            (click)="close.emit()"
          >
            &#10005;
          </desktop-button>
        </div>
      </div>

      <!-- Loading state -->
      @if (loading()) {
        <div class="loading-state">
          <span class="spinner">&#8635;</span>
          <span>Loading comparison...</span>
        </div>
      } @else if (error()) {
        <div class="error-state">
          <span class="error-icon">&#9888;</span>
          <span>{{ error() }}</span>
          <desktop-button variant="ghost" size="xs" (click)="retry()">
            Retry
          </desktop-button>
        </div>
      } @else if (currentChapter()) {
        <!-- Split pane view -->
        <div class="diff-split">
          <app-diff-pane
            paneType="original"
            [diffWords]="currentChapter()!.diffWords"
            [plainText]="currentChapter()!.originalText"
            [changeCount]="removedCount()"
            [scrollPosition]="scrollPosition()"
            [linkedScrolling]="linkedScrolling()"
            (scrolled)="onLeftScroll($event)"
          />
          <div class="divider"></div>
          <app-diff-pane
            paneType="cleaned"
            [diffWords]="currentChapter()!.diffWords"
            [plainText]="currentChapter()!.cleanedText"
            [changeCount]="addedCount()"
            [scrollPosition]="scrollPosition()"
            [linkedScrolling]="linkedScrolling()"
            (scrolled)="onRightScroll($event)"
          />
        </div>

        <!-- Summary bar -->
        <div class="diff-summary">
          <span class="summary-item removed">
            <span class="count">{{ removedCount() }}</span> removed
          </span>
          <span class="summary-item added">
            <span class="count">{{ addedCount() }}</span> added
          </span>
          <label class="linked-toggle">
            <input
              type="checkbox"
              [checked]="linkedScrolling()"
              (change)="linkedScrolling.set($any($event.target).checked)"
            />
            Linked scrolling
          </label>
        </div>
      } @else {
        <div class="empty-state">
          <p>No diff data available.</p>
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
      height: 300px;
      transition: height 0.2s ease;

      &.expanded {
        height: 500px;
      }

      &.loading {
        min-height: 120px;
      }
    }

    .diff-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-default);

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

    .total-changes {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent);
      border-radius: 10px;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .chapter-select {
      padding: 0.25rem 0.5rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--text-primary);
      font-size: 0.75rem;
      max-width: 200px;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }

      option {
        background: var(--bg-surface);
      }
    }

    .nav-buttons {
      display: flex;
      gap: 0.25rem;
    }

    .loading-state, .error-state, .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .error-state {
      color: var(--accent-danger);

      .error-icon {
        font-size: 1.5rem;
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

    .diff-split {
      flex: 1;
      display: flex;
      gap: 0;
      overflow: hidden;
      padding: 0.5rem;

      > app-diff-pane {
        flex: 1;
        min-width: 0;
      }
    }

    .divider {
      width: 1px;
      background: var(--border-default);
      margin: 0 0.5rem;
    }

    .diff-summary {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg-subtle);
      border-top: 1px solid var(--border-default);
      font-size: 0.75rem;
    }

    .summary-item {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: var(--text-secondary);

      .count {
        font-weight: 600;
      }

      &.removed .count {
        color: var(--accent-danger);
      }

      &.added .count {
        color: var(--accent-success);
      }
    }

    .linked-toggle {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 0.375rem;
      color: var(--text-secondary);
      cursor: pointer;

      input[type="checkbox"] {
        margin: 0;
      }
    }
  `]
})
export class DiffViewComponent implements OnInit, OnDestroy {
  private readonly diffService = inject(DiffService);
  private subscriptions: Subscription[] = [];

  // Inputs
  readonly originalPath = input<string>('');
  readonly cleanedPath = input<string>('');

  // Outputs
  readonly close = output<void>();

  // State
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly expanded = signal(false);
  readonly linkedScrolling = signal(true);
  readonly scrollPosition = signal(0);

  // From service
  readonly chapters = signal<DiffChapter[]>([]);
  readonly currentChapterId = signal<string>('');
  readonly currentChapter = signal<DiffChapter | null>(null);

  // Computed
  readonly totalChanges = computed(() =>
    this.chapters().reduce((sum, ch) => sum + ch.changeCount, 0)
  );

  readonly canGoPrevious = computed(() => {
    const chapters = this.chapters();
    const currentId = this.currentChapterId();
    const index = chapters.findIndex(c => c.id === currentId);
    return index > 0;
  });

  readonly canGoNext = computed(() => {
    const chapters = this.chapters();
    const currentId = this.currentChapterId();
    const index = chapters.findIndex(c => c.id === currentId);
    return index < chapters.length - 1;
  });

  readonly addedCount = computed(() => {
    const chapter = this.currentChapter();
    if (!chapter) return 0;
    return chapter.diffWords.filter(w => w.type === 'added').length;
  });

  readonly removedCount = computed(() => {
    const chapter = this.currentChapter();
    if (!chapter) return 0;
    return chapter.diffWords.filter(w => w.type === 'removed').length;
  });

  ngOnInit(): void {
    // Subscribe to service state
    this.subscriptions.push(
      this.diffService.loading$.subscribe(loading => this.loading.set(loading)),
      this.diffService.error$.subscribe(error => this.error.set(error)),
      this.diffService.session$.subscribe(session => {
        if (session) {
          this.chapters.set(session.chapters);
          this.currentChapterId.set(session.currentChapterId);
          this.currentChapter.set(
            session.chapters.find(c => c.id === session.currentChapterId) || null
          );
        } else {
          this.chapters.set([]);
          this.currentChapterId.set('');
          this.currentChapter.set(null);
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

  selectChapter(chapterId: string): void {
    this.diffService.setCurrentChapter(chapterId);
    this.scrollPosition.set(0); // Reset scroll on chapter change
  }

  previousChapter(): void {
    if (this.diffService.previousChapter()) {
      this.scrollPosition.set(0);
    }
  }

  nextChapter(): void {
    if (this.diffService.nextChapter()) {
      this.scrollPosition.set(0);
    }
  }

  toggleExpanded(): void {
    this.expanded.update(v => !v);
  }

  onLeftScroll(position: number): void {
    if (this.linkedScrolling()) {
      this.scrollPosition.set(position);
    }
  }

  onRightScroll(position: number): void {
    if (this.linkedScrolling()) {
      this.scrollPosition.set(position);
    }
  }

  retry(): void {
    this.loadComparison();
  }
}
