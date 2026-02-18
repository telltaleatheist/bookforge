import { Component, inject, signal, output, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StudioService } from '../../services/studio.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { StudioItem } from '../../models/studio.types';

interface ImportProgress {
  total: number;
  completed: number;
  current: string;
  errors: string[];
}

/**
 * AddModalComponent - Modal for adding EPUBs or URLs
 *
 * Features:
 * - Drag & drop multiple ebook files
 * - Browse and multi-select files
 * - Paste URL and fetch article
 */
@Component({
  selector: 'app-add-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="close.emit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Add New Content</h2>
          <button class="btn-close" (click)="close.emit()">&times;</button>
        </div>

        <div class="modal-body">
          <!-- EPUB Drop Zone -->
          <div
            class="drop-zone"
            [class.drag-over]="isDragOver()"
            [class.loading]="isLoadingEpub()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave($event)"
            (drop)="onDrop($event)"
          >
            @if (isLoadingEpub()) {
              <div class="loading-state">
                <div class="spinner"></div>
                @if (batchProgress()) {
                  <p>{{ batchProgress()!.current }}</p>
                  <div class="progress-bar">
                    <div class="progress-fill" [style.width.%]="(batchProgress()!.completed / batchProgress()!.total) * 100"></div>
                  </div>
                  <p class="progress-count">{{ batchProgress()!.completed }} / {{ batchProgress()!.total }}</p>
                } @else {
                  <p>{{ loadingMessage() }}</p>
                }
              </div>
            } @else {
              <div class="drop-icon">📚</div>
              <p class="drop-text">Drop any ebooks or PDFs here</p>
              <p class="drop-hint">EPUB, PDF, MOBI, AZW3, DOCX, and more — drop multiple files at once</p>
              <button class="btn-browse" (click)="browseFiles()">
                Browse Files
              </button>
            }
          </div>
          @if (importError()) {
            <p class="import-error">{{ importError() }}</p>
          }

          <div class="divider">
            <span>or</span>
          </div>

          <!-- URL Input -->
          <div class="url-section">
            <div class="url-input-wrapper">
              <input
                type="url"
                class="url-input"
                placeholder="Paste article URL..."
                [(ngModel)]="urlValue"
                [disabled]="isLoadingUrl()"
                (keydown.enter)="fetchUrl()"
              />
              <button
                class="btn-fetch"
                [disabled]="!urlValue || isLoadingUrl()"
                (click)="fetchUrl()"
              >
                @if (isLoadingUrl()) {
                  <span class="spinner-small"></span>
                } @else {
                  Fetch
                }
              </button>
            </div>
            @if (urlError()) {
              <p class="url-error">{{ urlError() }}</p>
            }
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-content {
      background: var(--bg-surface);
      border-radius: 12px;
      width: 480px;
      max-width: 90vw;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-20px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-close {
      background: none;
      border: none;
      font-size: 24px;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0;
      line-height: 1;

      &:hover {
        color: var(--text-primary);
      }
    }

    .modal-body {
      padding: 24px;
    }

    .drop-zone {
      border: 2px dashed var(--border-default);
      border-radius: 8px;
      padding: 40px 20px;
      text-align: center;
      transition: all 0.2s ease;
      cursor: pointer;

      &:hover {
        border-color: var(--color-primary);
        background: var(--bg-hover);
      }

      &.drag-over {
        border-color: var(--color-primary);
        background: rgba(6, 182, 212, 0.1);
        border-style: solid;
      }

      &.loading {
        cursor: default;
        pointer-events: none;
      }
    }

    .drop-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }

    .drop-text {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .drop-hint {
      margin: 0 0 16px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .btn-browse {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-strong);
      }
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      color: var(--text-secondary);
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--color-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .spinner-small {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-default);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .progress-bar {
      width: 100%;
      max-width: 280px;
      height: 4px;
      background: var(--border-default);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--color-primary);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .progress-count {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0;
    }

    .divider {
      display: flex;
      align-items: center;
      margin: 24px 0;
      color: var(--text-muted);
      font-size: 13px;

      &::before,
      &::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--border-subtle);
      }

      span {
        padding: 0 16px;
      }
    }

    .url-section {
      .url-input-wrapper {
        display: flex;
        gap: 8px;
      }
    }

    .url-input {
      flex: 1;
      padding: 12px 16px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 14px;
      color: var(--text-primary);
      outline: none;

      &:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.15);
      }

      &::placeholder {
        color: var(--text-muted);
      }

      &:disabled {
        opacity: 0.6;
      }
    }

    .btn-fetch {
      padding: 12px 20px;
      background: var(--color-primary);
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      color: white;
      cursor: pointer;
      transition: all 0.15s ease;
      min-width: 80px;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }

    .import-error {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--color-error);
      text-align: center;
    }

    .url-error {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--color-error);
    }
  `]
})
export class AddModalComponent {
  private readonly studioService = inject(StudioService);
  private readonly electronService = inject(ElectronService);

  // Outputs
  readonly close = output<void>();
  readonly added = output<StudioItem>();

  // State
  readonly isDragOver = signal<boolean>(false);
  readonly isLoadingEpub = signal<boolean>(false);
  readonly isLoadingUrl = signal<boolean>(false);
  readonly loadingMessage = signal<string>('Importing...');
  readonly importError = signal<string | null>(null);
  readonly urlError = signal<string | null>(null);
  readonly batchProgress = signal<ImportProgress | null>(null);

  urlValue = '';

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.close.emit();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = (files[i] as any).path;
      if (filePath) paths.push(filePath);
    }

    if (paths.length === 1) {
      this.handleFile(paths[0]);
    } else if (paths.length > 1) {
      this.handleMultipleFiles(paths);
    }
  }

  async browseFiles(): Promise<void> {
    const result = await this.electronService.openPdfDialog();
    if (!result.success) return;

    // Support multi-select: use filePaths array if available
    const filePaths: string[] = (result as any).filePaths || (result.filePath ? [result.filePath] : []);
    if (filePaths.length === 0) return;

    if (filePaths.length === 1) {
      await this.handleFile(filePaths[0]);
    } else {
      await this.handleMultipleFiles(filePaths);
    }
  }

  private async handleFile(filePath: string): Promise<void> {
    this.importError.set(null);
    const name = filePath.toLowerCase();

    if (name.endsWith('.epub') || name.endsWith('.pdf')) {
      await this.importFile(filePath);
    } else {
      await this.convertAndImport(filePath);
    }
  }

  private async handleMultipleFiles(filePaths: string[]): Promise<void> {
    this.importError.set(null);
    this.isLoadingEpub.set(true);

    const progress: ImportProgress = {
      total: filePaths.length,
      completed: 0,
      current: '',
      errors: [],
    };
    this.batchProgress.set({ ...progress });

    let lastAdded: StudioItem | undefined;

    for (const filePath of filePaths) {
      const filename = filePath.split('/').pop() || filePath;
      progress.current = `Importing ${filename}...`;
      this.batchProgress.set({ ...progress });

      try {
        const name = filePath.toLowerCase();
        let importPath = filePath;

        // Convert non-native formats first
        if (!name.endsWith('.epub') && !name.endsWith('.pdf')) {
          progress.current = `Converting ${filename}...`;
          this.batchProgress.set({ ...progress });
          const convertResult = await this.electronService.convertEbook(filePath);
          if (!convertResult.success || !convertResult.outputPath) {
            progress.errors.push(`${filename}: ${convertResult.error || 'Conversion failed'}`);
            progress.completed++;
            this.batchProgress.set({ ...progress });
            continue;
          }
          importPath = convertResult.outputPath;
        }

        const result = await this.studioService.addBook(importPath);
        if (result.success && result.item) {
          lastAdded = result.item;
        } else {
          progress.errors.push(`${filename}: ${result.error || 'Import failed'}`);
        }
      } catch (err) {
        progress.errors.push(`${filename}: ${(err as Error).message}`);
      }

      progress.completed++;
      this.batchProgress.set({ ...progress });
    }

    this.isLoadingEpub.set(false);
    this.batchProgress.set(null);

    if (progress.errors.length > 0) {
      this.importError.set(`Failed: ${progress.errors.join('; ')}`);
    }

    if (lastAdded) {
      this.added.emit(lastAdded);
    }

    // Close modal if everything succeeded
    if (progress.errors.length === 0) {
      this.close.emit();
    }
  }

  private async importFile(filePath: string): Promise<void> {
    this.isLoadingEpub.set(true);
    const isPdf = filePath.toLowerCase().endsWith('.pdf');
    this.loadingMessage.set(isPdf ? 'Importing PDF...' : 'Importing EPUB...');

    try {
      const result = await this.studioService.addBook(filePath);

      if (result.success) {
        if (result.item) {
          this.added.emit(result.item);
        }
        if (isPdf && result.item?.bfpPath) {
          await this.electronService.editorOpenWindowWithBfp(result.item.bfpPath, filePath);
        }
        this.close.emit();
      } else {
        this.importError.set(result.error || 'Failed to import');
      }
    } finally {
      this.isLoadingEpub.set(false);
    }
  }

  private async convertAndImport(filePath: string): Promise<void> {
    this.isLoadingEpub.set(true);
    this.loadingMessage.set('Converting to EPUB...');

    try {
      const convertResult = await this.electronService.convertEbook(filePath);
      if (!convertResult.success || !convertResult.outputPath) {
        this.importError.set(convertResult.error || 'Conversion failed. Install Calibre for format conversion.');
        return;
      }

      this.loadingMessage.set('Importing...');
      await this.importFile(convertResult.outputPath);
    } catch (err) {
      this.importError.set('Conversion failed: ' + (err as Error).message);
    } finally {
      this.isLoadingEpub.set(false);
    }
  }

  async fetchUrl(): Promise<void> {
    if (!this.urlValue) return;

    this.urlError.set(null);
    this.isLoadingUrl.set(true);

    try {
      const result = await this.studioService.addArticle(this.urlValue);

      if (result.success && result.item) {
        this.added.emit(result.item);
        this.close.emit();
      } else {
        this.urlError.set(result.error || 'Failed to fetch URL');
      }
    } finally {
      this.isLoadingUrl.set(false);
    }
  }
}
