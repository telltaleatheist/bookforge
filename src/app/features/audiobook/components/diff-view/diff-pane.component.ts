import {
  Component,
  input,
  output,
  signal,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnChanges,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DiffWord } from '../../../../core/models/diff.types';

@Component({
  selector: 'app-diff-pane',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      #scrollContainer
      class="diff-pane"
      [class.original]="paneType() === 'original'"
      [class.cleaned]="paneType() === 'cleaned'"
      (scroll)="onScroll($event)"
    >
      <div class="pane-header">
        <span class="pane-title">{{ paneType() === 'original' ? 'Original' : 'Cleaned' }}</span>
        @if (changeCount() > 0) {
          <span class="change-badge">{{ changeCount() }} changes</span>
        }
      </div>
      <div class="pane-content">
        @for (word of diffWords(); track $index) {
          <span
            class="diff-word"
            [class.unchanged]="word.type === 'unchanged'"
            [class.added]="word.type === 'added'"
            [class.removed]="word.type === 'removed'"
            [class.hidden]="shouldHideWord(word)"
          >{{ word.text }}</span>
        }
        @if (diffWords().length === 0) {
          <span class="empty-text">{{ plainText() || 'No content' }}</span>
        }
      </div>
    </div>
  `,
  styles: [`
    .diff-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      overflow: hidden;
    }

    .pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-default);
    }

    .pane-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      color: var(--text-secondary);
    }

    .change-badge {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent);
      border-radius: 10px;
    }

    .pane-content {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
      font-size: 0.8125rem;
      line-height: 1.6;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .diff-word {
      &.unchanged {
        /* Default text appearance */
      }

      &.added {
        background: color-mix(in srgb, var(--accent-success) 20%, transparent);
        border-radius: 2px;
        padding: 0 2px;
      }

      &.removed {
        background: color-mix(in srgb, var(--accent-danger) 20%, transparent);
        text-decoration: line-through;
        border-radius: 2px;
        padding: 0 2px;
      }

      &.hidden {
        display: none;
      }
    }

    .empty-text {
      color: var(--text-muted);
      font-style: italic;
    }

    /* Original pane hides added words */
    .diff-pane.original .diff-word.added {
      display: none;
    }

    /* Cleaned pane hides removed words */
    .diff-pane.cleaned .diff-word.removed {
      display: none;
    }
  `]
})
export class DiffPaneComponent implements AfterViewInit, OnChanges {
  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;

  // Inputs
  readonly paneType = input.required<'original' | 'cleaned'>();
  readonly diffWords = input<DiffWord[]>([]);
  readonly plainText = input<string>('');
  readonly changeCount = input<number>(0);
  readonly scrollPosition = input<number>(0);
  readonly linkedScrolling = input<boolean>(true);

  // Outputs
  readonly scrolled = output<number>();

  // Internal state
  private isInternalScroll = signal(false);
  private lastExternalScrollPosition = 0;

  ngAfterViewInit(): void {
    // Initial scroll position sync
    this.syncScrollPosition();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['scrollPosition'] && this.scrollContainer && this.linkedScrolling()) {
      const newPosition = changes['scrollPosition'].currentValue;
      if (Math.abs(newPosition - this.lastExternalScrollPosition) > 1) {
        this.syncScrollPosition();
      }
    }
  }

  onScroll(event: Event): void {
    if (!this.linkedScrolling()) return;

    const target = event.target as HTMLDivElement;
    const scrollPercent = target.scrollTop / (target.scrollHeight - target.clientHeight || 1);

    // Emit scroll percentage for linked scrolling
    this.scrolled.emit(scrollPercent);
  }

  private syncScrollPosition(): void {
    if (!this.scrollContainer) return;

    const container = this.scrollContainer.nativeElement;
    const maxScroll = container.scrollHeight - container.clientHeight;
    const targetScroll = this.scrollPosition() * maxScroll;

    this.lastExternalScrollPosition = this.scrollPosition();
    container.scrollTop = targetScroll;
  }

  /**
   * Determine if a word should be hidden based on pane type.
   * Original pane hides added words, cleaned pane hides removed words.
   */
  shouldHideWord(word: DiffWord): boolean {
    if (this.paneType() === 'original' && word.type === 'added') {
      return true;
    }
    if (this.paneType() === 'cleaned' && word.type === 'removed') {
      return true;
    }
    return false;
  }
}
