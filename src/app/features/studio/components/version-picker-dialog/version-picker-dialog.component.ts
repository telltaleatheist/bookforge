import { Component, inject, signal, OnInit, ChangeDetectionStrategy, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { ElectronService } from '../../../../core/services/electron.service';
import { ProjectVersion } from '../../models/project-version.types';

/**
 * Data passed to the version picker dialog
 */
export interface VersionPickerDialogData {
  /** Title for the dialog */
  title?: string;
  /** Path to the BFP project file */
  bfpPath: string;
  /** Callback when a version is selected */
  onSelect: (version: ProjectVersion) => void;
  /** Callback when the dialog is cancelled */
  onCancel: () => void;
}

/**
 * VersionPickerDialog - Modal dialog for selecting which version to edit
 *
 * Shows all available versions of a project's source document:
 * - Original source (PDF/EPUB)
 * - Finalized EPUB
 * - Cleaned EPUB
 * - Translated EPUBs
 *
 * Usage:
 * ```typescript
 * // Show the dialog
 * this.showVersionPicker = true;
 * this.versionPickerData = {
 *   bfpPath: item.bfpPath,
 *   onSelect: (version) => this.openEditorWithVersion(version),
 *   onCancel: () => this.showVersionPicker = false
 * };
 * ```
 *
 * ```html
 * @if (showVersionPicker()) {
 *   <app-version-picker-dialog
 *     [data]="versionPickerData()"
 *   />
 * }
 * ```
 */
@Component({
  selector: 'app-version-picker-dialog',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dialog-backdrop" (click)="onBackdropClick($event)">
      <div class="dialog-container" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <h2 class="dialog-title">{{ data?.title || 'Select Version to Edit' }}</h2>
          <button class="close-btn" (click)="cancel()" title="Close">×</button>
        </div>

        <div class="dialog-content">
          @if (loading()) {
            <div class="loading-state">
              <div class="spinner"></div>
              <p>Loading versions...</p>
            </div>
          } @else if (error()) {
            <div class="error-state">
              <p class="error-icon">⚠️</p>
              <p>{{ error() }}</p>
              <desktop-button variant="secondary" size="sm" (click)="loadVersions()">
                Retry
              </desktop-button>
            </div>
          } @else if (versions().length === 0) {
            <div class="empty-state">
              <p class="empty-icon">📁</p>
              <p>No versions available for this project.</p>
            </div>
          } @else {
            <div class="version-list">
              @for (version of versions(); track version.id) {
                <div class="version-item-wrapper">
                  <button
                    class="version-item"
                    [class.selected]="selectedVersion()?.id === version.id"
                    [class.disabled]="!version.editable"
                    [disabled]="!version.editable"
                    (click)="selectVersion(version)"
                    (dblclick)="confirmSelection()"
                  >
                    <span class="version-icon">{{ version.icon }}</span>
                    <div class="version-info">
                      <span class="version-label">{{ version.label }}</span>
                      <span class="version-description">{{ version.description }}</span>
                      @if (version.modifiedAt) {
                        <span class="version-date">Modified: {{ formatDate(version.modifiedAt) }}</span>
                      }
                    </div>
                    <span class="version-extension">.{{ version.extension }}</span>
                  </button>
                  @if (canDelete(version)) {
                    <button
                      class="delete-btn"
                      (click)="deleteVersion(version)"
                      title="Delete this version"
                    >
                      ×
                    </button>
                  }
                </div>
              }
            </div>
          }
        </div>

        <div class="dialog-footer">
          <desktop-button variant="ghost" size="sm" (click)="cancel()">
            Cancel
          </desktop-button>
          <desktop-button
            variant="primary"
            size="sm"
            [disabled]="!selectedVersion()"
            (click)="confirmSelection()"
          >
            Open
          </desktop-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.15s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .dialog-container {
      background: var(--bg-surface);
      border-radius: 12px;
      border: 1px solid var(--border-default);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
      width: 480px;
      max-width: 90vw;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      animation: slideUp 0.2s ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-lg);
      border-bottom: 1px solid var(--border-subtle);
    }

    .dialog-title {
      margin: 0;
      font-size: var(--ui-font-lg);
      font-weight: 600;
      color: var(--text-primary);
    }

    .close-btn {
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 1.25rem;
      cursor: pointer;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .dialog-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-md);
      min-height: 200px;
    }

    .loading-state,
    .error-state,
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xl);
      text-align: center;
      color: var(--text-secondary);
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-icon,
    .empty-icon {
      font-size: 2rem;
      margin: 0;
    }

    .version-list {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
    }

    .version-item-wrapper {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
    }

    .version-item {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: left;
      flex: 1;

      &:hover:not(.disabled) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        border-color: var(--accent);
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .delete-btn {
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 1.5rem;
      cursor: pointer;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      flex-shrink: 0;

      &:hover {
        background: var(--error-bg);
        color: var(--error-text);
      }
    }

    .version-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
    }

    .version-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .version-label {
      font-size: var(--ui-font-md);
      font-weight: 500;
      color: var(--text-primary);
    }

    .version-description {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
    }

    .version-date {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .version-extension {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .dialog-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
    }
  `]
})
export class VersionPickerDialogComponent implements OnInit, OnChanges {
  private readonly electronService = inject(ElectronService);

  /** Input data for the dialog */
  @Input() data: VersionPickerDialogData | null = null;

  /** Loading state */
  readonly loading = signal(false);

  /** Error message if loading failed */
  readonly error = signal<string | null>(null);

  /** Available versions */
  readonly versions = signal<ProjectVersion[]>([]);

  /** Currently selected version */
  readonly selectedVersion = signal<ProjectVersion | null>(null);

  ngOnInit(): void {
    if (this.data?.bfpPath) {
      this.loadVersions();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] && this.data?.bfpPath) {
      this.loadVersions();
    }
  }

  /**
   * Load available versions from the project
   */
  async loadVersions(): Promise<void> {
    if (!this.data?.bfpPath) return;

    this.loading.set(true);
    this.error.set(null);

    try {
      const result = await this.electronService.editorGetVersions(this.data.bfpPath);

      if (result.success && result.versions) {
        // Map to ProjectVersion interface
        const versions: ProjectVersion[] = result.versions.map(v => ({
          id: v.id,
          type: v.type as ProjectVersion['type'],
          label: v.label,
          description: v.description,
          path: v.path,
          extension: v.extension,
          language: v.language,
          modifiedAt: v.modifiedAt,
          fileSize: v.fileSize,
          editable: v.editable,
          icon: v.icon
        }));

        this.versions.set(versions);

        // Auto-select first editable version
        const firstEditable = versions.find(v => v.editable);
        if (firstEditable) {
          this.selectedVersion.set(firstEditable);
        }
      } else {
        this.error.set(result.error || 'Failed to load versions');
      }
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Select a version
   */
  selectVersion(version: ProjectVersion): void {
    if (version.editable) {
      this.selectedVersion.set(version);
    }
  }

  /**
   * Confirm the selection and close the dialog
   */
  confirmSelection(): void {
    const version = this.selectedVersion();
    if (version && this.data?.onSelect) {
      this.data.onSelect(version);
    }
  }

  /**
   * Cancel and close the dialog
   */
  cancel(): void {
    if (this.data?.onCancel) {
      this.data.onCancel();
    }
  }

  /**
   * Handle backdrop click (close dialog)
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.cancel();
    }
  }

  /**
   * Format a date string for display
   */
  formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Check if a version can be deleted
   * Original source files cannot be deleted
   */
  canDelete(version: ProjectVersion): boolean {
    // Don't allow deleting original source files or finalized versions
    return version.type !== 'original' && version.type !== 'finalized';
  }

  /**
   * Delete a version file
   */
  async deleteVersion(version: ProjectVersion): Promise<void> {
    // Confirm deletion
    const confirmResult = await this.electronService.showConfirmDialog({
      title: 'Delete Version',
      message: `Are you sure you want to delete "${version.label}"?`,
      detail: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      type: 'warning'
    });

    if (!confirmResult.confirmed) return;

    try {
      // Delete the file
      const result = await this.electronService.deleteFile(version.path);

      if (result.success) {
        // If the deleted version was selected, clear selection
        if (this.selectedVersion()?.id === version.id) {
          this.selectedVersion.set(null);
        }

        // Reload the versions list
        await this.loadVersions();
      } else {
        console.error('[VersionPicker] Failed to delete version:', result.error);
        // Show error using the confirm dialog (as an error type)
        await this.electronService.showConfirmDialog({
          title: 'Delete Failed',
          message: result.error || 'Failed to delete the version file.',
          type: 'error',
          confirmLabel: 'OK'
        });
      }
    } catch (err) {
      console.error('[VersionPicker] Error deleting version:', err);
      // Show error using the confirm dialog
      await this.electronService.showConfirmDialog({
        title: 'Delete Failed',
        message: (err as Error).message || 'An unexpected error occurred.',
        type: 'error',
        confirmLabel: 'OK'
      });
    }
  }
}
