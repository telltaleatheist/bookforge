import { Component, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { LibraryBook } from '../../models/library.types';

@Component({
  selector: 'app-book-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="book-card"
      [class.selected]="selected()"
      (click)="onClick($event)"
      (dblclick)="cardDoubleClicked.emit(book())"
      draggable="true"
      (dragstart)="onDragStart($event)"
    >
      <div class="cover-container">
        @if (book().coverData) {
          <img [src]="book().coverData" class="cover-image" [alt]="book().title" />
        } @else {
          <div class="cover-placeholder">
            <span class="cover-icon">{{ formatIcon() }}</span>
          </div>
        }
        <span class="format-badge" [class]="'format-' + book().format">
          {{ book().format }}
        </span>
      </div>
      <div class="card-info">
        <div class="card-title" [title]="book().title">{{ book().title }}</div>
        <div class="card-author" [title]="displayAuthor()">{{ displayAuthor() }}</div>
      </div>
    </div>
  `,
  styles: [`
    .book-card {
      width: 160px;
      height: 280px;
      cursor: pointer;
      border-radius: 8px;
      padding: 8px;
      transition: all 0.15s ease;
      border: 2px solid transparent;
      overflow: hidden;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
        border-color: var(--accent-primary);
      }
    }

    .cover-container {
      position: relative;
      width: 144px;
      height: 200px;
      border-radius: 4px;
      overflow: hidden;
      background: var(--bg-elevated);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .cover-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .cover-placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-elevated);
    }

    .cover-icon {
      font-size: 2.5rem;
      opacity: 0.3;
    }

    .format-badge {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.6rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: white;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
    }

    .format-epub { background: rgba(46, 125, 50, 0.85); }
    .format-pdf { background: rgba(198, 40, 40, 0.85); }
    .format-azw3, .format-azw, .format-mobi { background: rgba(255, 143, 0, 0.85); }
    .format-fb2 { background: rgba(21, 101, 192, 0.85); }
    .format-cbz, .format-cbr { background: rgba(142, 36, 170, 0.85); }

    .card-info {
      padding: 6px 2px 0;
    }

    .card-title {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .card-author {
      font-size: 0.7rem;
      color: var(--text-secondary);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `]
})
export class BookCardComponent {
  readonly book = input.required<LibraryBook>();
  readonly selected = input(false);

  readonly cardClicked = output<{ book: LibraryBook; event: MouseEvent }>();
  readonly cardDoubleClicked = output<LibraryBook>();

  onClick(event: MouseEvent): void {
    this.cardClicked.emit({ book: this.book(), event });
  }

  readonly displayAuthor = computed(() => {
    const b = this.book();
    if (b.authorFull) return b.authorFull;
    if (b.authorLast && b.authorFirst) return `${b.authorLast}, ${b.authorFirst}`;
    return b.authorLast || '';
  });

  readonly formatIcon = computed(() => {
    switch (this.book().format) {
      case 'epub': return '\u{1F4D6}';
      case 'pdf': return '\u{1F4C4}';
      default: return '\u{1F4DA}';
    }
  });

  onDragStart(event: DragEvent): void {
    event.dataTransfer?.setData('text/plain', this.book().relativePath);
    event.dataTransfer?.setData('application/x-ebook-path', this.book().relativePath);
  }
}
