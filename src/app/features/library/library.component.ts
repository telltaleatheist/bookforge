import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EbookLibraryService } from './services/ebook-library.service';
import { CategorySidebarComponent } from './components/category-sidebar/category-sidebar.component';
import { BookGridComponent } from './components/book-grid/book-grid.component';
import { BookMetadataComponent } from './components/book-metadata/book-metadata.component';
import type { LibraryBook } from './models/library.types';

@Component({
  selector: 'app-library',
  standalone: true,
  imports: [
    CommonModule,
    CategorySidebarComponent,
    BookGridComponent,
    BookMetadataComponent,
  ],
  template: `
    <div
      class="library-container"
      (dragenter)="onDragEnter($event)"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      <app-category-sidebar />

      <div class="main-area">
        <app-book-grid
          (bookDoubleClicked)="onBookDoubleClick($event)"
        />
      </div>

      <app-book-metadata />

      <!-- Full-screen drop overlay -->
      @if (isDragOver) {
        <div class="drop-overlay">
          <div class="drop-message">
            <div class="drop-icon">\u{1F4E5}</div>
            <div>Drop ebooks to add to library</div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .library-container {
      display: flex;
      height: 100%;
      overflow: hidden;
      position: relative;
    }

    .main-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .drop-overlay {
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--bg-default) 85%, transparent);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      border: 3px dashed var(--accent-primary);
      border-radius: 8px;
      margin: 4px;
      pointer-events: none;
    }

    .drop-message {
      text-align: center;
      color: var(--accent-primary);
      font-size: 1.1rem;
      font-weight: 500;
    }

    .drop-icon {
      font-size: 3rem;
      margin-bottom: 8px;
    }
  `]
})
export class LibraryComponent implements OnInit {
  private readonly libraryService = inject(EbookLibraryService);

  isDragOver = false;
  private dragCounter = 0;

  async ngOnInit(): Promise<void> {
    await this.libraryService.init();
  }

  async addBooks(paths: string[]): Promise<void> {
    await this.libraryService.addBooks(paths);
  }

  onBookDoubleClick(book: LibraryBook): void {
    // Double-click could open in system viewer or import to studio
    // For now, just select it
    this.libraryService.selectBook(book.relativePath);
  }

  onDragEnter(event: DragEvent): void {
    const hasFiles = event.dataTransfer?.types.includes('Files');
    const hasEbook = event.dataTransfer?.types.includes('application/x-ebook-path');
    if (hasFiles && !hasEbook) {
      this.dragCounter++;
      if (this.dragCounter === 1) {
        this.isDragOver = true;
      }
    }
  }

  onDragOver(event: DragEvent): void {
    // Must preventDefault on dragover to allow drop
    const hasFiles = event.dataTransfer?.types.includes('Files');
    if (hasFiles) {
      event.preventDefault();
    }
  }

  onDragLeave(_event: DragEvent): void {
    this.dragCounter--;
    if (this.dragCounter <= 0) {
      this.isDragOver = false;
      this.dragCounter = 0;
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
    this.dragCounter = 0;

    const files = event.dataTransfer?.files;
    if (!files?.length) return;

    const hasEbook = event.dataTransfer?.types.includes('application/x-ebook-path');
    if (hasEbook) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = (files[i] as any).path;
      if (filePath) paths.push(filePath);
    }
    if (paths.length > 0) {
      this.addBooks(paths);
    }
  }
}
