import { Component, output, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../../../core/services/electron.service';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

interface FileItem {
  name: string;
  path: string;
  type: 'directory' | 'pdf';
  size: number | null;
}

interface RecentFile {
  path: string;
  name: string;
  timestamp: number;
}

@Component({
  selector: 'app-file-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="modal-overlay" (click)="close.emit()">
      <div class="modal" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Open PDF</h2>
          <desktop-button variant="ghost" size="sm" [iconOnly]="true" (click)="close.emit()">
            ✕
          </desktop-button>
        </div>

        <!-- Path Input -->
        <div class="path-bar">
          <input
            type="text"
            class="path-input"
            [(ngModel)]="pathInput"
            placeholder="Enter file path or browse below..."
            (keydown.enter)="loadFromInput()"
          />
          <desktop-button variant="primary" size="sm" (click)="loadFromInput()">
            Open
          </desktop-button>
        </div>

        <div class="modal-body">
          <!-- Recent Files -->
          @if (recentFiles().length > 0) {
            <div class="section">
              <div class="section-header" (click)="recentExpanded.set(!recentExpanded())">
                <span class="toggle-icon" [class.expanded]="recentExpanded()">▶</span>
                <span class="section-label">RECENT FILES</span>
                <span class="section-count">{{ recentFiles().length }}</span>
              </div>
              @if (recentExpanded()) {
                <div class="section-items">
                  @for (file of recentFiles(); track file.path) {
                    <div class="file-item" (click)="selectFile(file.path)">
                      <span class="item-icon">📄</span>
                      <div class="item-info">
                        <div class="item-name">{{ file.name }}</div>
                        <div class="item-path">{{ file.path }}</div>
                      </div>
                    </div>
                  }
                </div>
              }
            </div>
          }

          <!-- Browse Directory -->
          <div class="section">
            <div class="section-header">
              <desktop-button variant="ghost" size="xs" [iconOnly]="true" (click)="browseParent()">
                ↑
              </desktop-button>
              <span class="section-label path">{{ currentPath() }}</span>
            </div>
            <div class="section-items">
              @if (loading()) {
                <div class="empty-message">Loading...</div>
              } @else if (browseError()) {
                <div class="empty-message error">{{ browseError() }}</div>
              } @else if (browseItems().length === 0) {
                <div class="empty-message">No PDF files or folders</div>
              } @else {
                @for (item of browseItems(); track item.path) {
                  <div
                    class="file-item"
                    [class.directory]="item.type === 'directory'"
                    (click)="item.type === 'directory' ? browse(item.path) : selectFile(item.path)"
                  >
                    <span class="item-icon">
                      {{ item.type === 'directory' ? '📁' : '📄' }}
                    </span>
                    <div class="item-info">
                      <div class="item-name">{{ item.name }}</div>
                    </div>
                    @if (item.size) {
                      <span class="item-meta">{{ formatSize(item.size) }}</span>
                    }
                  </div>
                }
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: var(--bg-overlay);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: $z-modal;
      animation: overlayFadeIn $duration-fast $ease-out forwards;
    }

    .modal {
      background: var(--bg-surface);
      border-radius: $radius-xl;
      border: 1px solid var(--border-default);
      box-shadow: var(--shadow-xl);
      max-width: 600px;
      width: 90%;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: modalSlideIn $duration-normal $ease-out forwards;
    }

    @keyframes overlayFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes modalSlideIn {
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
      align-items: center;
      justify-content: space-between;
      padding: $spacing-3 $spacing-4;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);

      h2 {
        font-size: $font-size-md;
        font-weight: $font-weight-semibold;
        margin: 0;
        color: var(--text-primary);
      }
    }

    .path-bar {
      display: flex;
      gap: $spacing-2;
      padding: $spacing-3 $spacing-4;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);
    }

    .path-input {
      flex: 1;
      padding: $spacing-2 $spacing-3;
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: $radius-md;
      color: var(--text-primary);
      font-size: $font-size-sm;
      font-family: $font-mono;

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: var(--focus-ring);
      }
    }

    .modal-body {
      overflow-y: auto;
      flex: 1;
    }

    .section {
      user-select: none;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: $spacing-2;
      padding: $spacing-2 $spacing-4;
      height: 36px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;

      &:hover {
        background: var(--hover-bg);
      }
    }

    .toggle-icon {
      font-size: 10px;
      color: var(--text-tertiary);
      transition: transform $duration-fast $ease-out;

      &.expanded {
        transform: rotate(90deg);
      }
    }

    .section-label {
      font-size: $font-size-xs;
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
      letter-spacing: 0.05em;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      &.path {
        font-family: $font-mono;
        font-weight: $font-weight-regular;
        letter-spacing: 0;
      }
    }

    .section-count {
      font-size: $font-size-2xs;
      color: var(--text-tertiary);
      font-weight: $font-weight-medium;
    }

    .section-items {
      max-height: 300px;
      overflow-y: auto;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: $spacing-3;
      padding: $spacing-2 $spacing-4;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: all $duration-fast $ease-out;

      &:hover {
        background: var(--hover-bg);
        transform: translateX(4px);
      }

      &:active {
        transform: scale(0.99);
      }

      &:last-child {
        border-bottom: none;
      }

      &.directory {
        background: var(--bg-elevated);

        &:hover {
          background: var(--hover-bg);
        }

        .item-icon {
          color: var(--accent);
        }
      }
    }

    .item-icon {
      font-size: 1.25rem;
      width: 28px;
      text-align: center;
      flex-shrink: 0;
    }

    .item-info {
      flex: 1;
      min-width: 0;
    }

    .item-name {
      font-size: $font-size-sm;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-path {
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      font-family: $font-mono;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-meta {
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .empty-message {
      padding: $spacing-6;
      text-align: center;
      color: var(--text-tertiary);
      font-size: $font-size-sm;

      &.error {
        color: var(--error-text);
      }
    }
  `],
})
export class FilePickerComponent implements OnInit {
  private readonly electron = inject(ElectronService);

  fileSelected = output<string>();
  close = output<void>();

  pathInput = '';
  recentExpanded = signal(true);
  recentFiles = signal<RecentFile[]>([]);
  currentPath = signal(this.getDefaultPath());
  browseItems = signal<FileItem[]>([]);
  loading = signal(false);
  browseError = signal<string | null>(null);

  private getDefaultPath(): string {
    // Start at user's home or root
    return '/Users';
  }

  ngOnInit(): void {
    this.loadRecentFiles();
    this.browse(this.currentPath());
  }

  loadRecentFiles(): void {
    try {
      // Try new key first, fall back to old one
      let stored = localStorage.getItem('bookforge-library-books');
      if (!stored) {
        stored = localStorage.getItem('bookforge-recent-files');
      }
      if (stored) {
        this.recentFiles.set(JSON.parse(stored));
      }
    } catch {
      this.recentFiles.set([]);
    }
  }

  async browse(path: string): Promise<void> {
    this.loading.set(true);
    this.browseError.set(null);
    this.currentPath.set(path);

    try {
      const result = await this.electron.browse(path);
      this.browseItems.set(result.items as FileItem[]);
    } catch (err) {
      this.browseError.set((err as Error).message);
      this.browseItems.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  browseParent(): void {
    const current = this.currentPath();
    const parts = current.split('/').filter(p => p);
    if (parts.length > 0) {
      parts.pop();
      this.browse('/' + parts.join('/') || '/');
    }
  }

  selectFile(path: string): void {
    this.fileSelected.emit(path);
  }

  loadFromInput(): void {
    if (this.pathInput.trim()) {
      this.fileSelected.emit(this.pathInput.trim());
    }
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
}
