/**
 * Skipped Chunks Panel - Displays chunks that were skipped during AI cleanup
 * Shows copyright refusals and content skips with the original text content
 * Allows editing skipped chunks and saving changes back to the EPUB
 */

import { Component, input, output, signal, computed, inject, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../../../core/services/electron.service';
import { SkippedChunk } from '../../../queue/models/queue.types';

@Component({
  selector: 'app-skipped-chunks-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="skipped-chunks-panel">
      <!-- Header -->
      <div class="panel-header">
        <h4>Skipped Chunks</h4>
        @if (totalSkipped() > 0) {
          <span class="skip-badge">{{ totalSkipped() }} chunks</span>
        }
      </div>

      <!-- Loading state -->
      @if (loading()) {
        <div class="loading-state">
          <span class="spinner">&#8635;</span>
          <span>Loading skipped chunks...</span>
        </div>
      }

      <!-- Error state -->
      @if (error()) {
        <div class="error-state">
          <span class="error-icon">&#9888;</span>
          <span>{{ error() }}</span>
        </div>
      }

      <!-- Empty state -->
      @if (!loading() && !error() && chunks().length === 0) {
        <div class="empty-state">
          <p>No skipped chunks for this book.</p>
          <p class="hint">AI cleanup completed without issues.</p>
        </div>
      }

      <!-- Chunks list -->
      @if (chunks().length > 0) {
        <div class="chunks-list">
          @for (chunk of chunks(); track $index; let i = $index) {
            <div class="chunk-card" [class.expanded]="expandedChunks().has(i)" [class.editing]="editingChunkIndex() === i">
              <!-- Chunk header -->
              <div class="chunk-header" (click)="toggleChunk(i)">
                <div class="chunk-meta">
                  <span class="reason-badge" [class]="chunk.reason">
                    {{ getReasonLabel(chunk.reason) }}
                  </span>
                  <span class="chunk-index">Chunk {{ chunk.overallChunkNumber }}/{{ chunk.totalChunks }}</span>
                  <span class="chapter-title">{{ chunk.chapterTitle }}</span>
                </div>
                <span class="expand-icon">{{ expandedChunks().has(i) ? '▼' : '▶' }}</span>
              </div>

              <!-- Expanded content -->
              @if (expandedChunks().has(i)) {
                <div class="chunk-content">
                  <div class="content-section">
                    <div class="section-header">
                      <h5>Text in EPUB ({{ chunk.text.length }} chars)</h5>
                      @if (editingChunkIndex() !== i) {
                        <button class="edit-btn" (click)="startEditing(i, chunk.text)" title="Edit this chunk">
                          Edit
                        </button>
                      }
                    </div>

                    @if (editingChunkIndex() === i) {
                      <textarea
                        class="text-editor"
                        [(ngModel)]="editedText"
                        [disabled]="saving()"
                        rows="15"
                      ></textarea>
                      <div class="edit-actions">
                        <span class="char-count">{{ editedText.length }} chars</span>
                        <button class="cancel-btn" (click)="cancelEditing()" [disabled]="saving()">
                          Cancel
                        </button>
                        <button class="save-btn" (click)="saveEdit(i, chunk)" [disabled]="saving() || editedText === chunk.text">
                          @if (saving()) {
                            Saving...
                          } @else {
                            Save to EPUB
                          }
                        </button>
                      </div>
                    } @else {
                      <div class="text-preview">{{ chunk.text }}</div>
                    }
                  </div>

                  @if (chunk.aiResponse) {
                    <div class="content-section ai-response">
                      <h5>AI Response</h5>
                      <div class="text-preview small">{{ chunk.aiResponse }}</div>
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>

        <!-- Summary -->
        <div class="summary">
          <p>
            <strong>{{ copyrightCount() }}</strong> copyright refusals,
            <strong>{{ skipCount() }}</strong> content skips
          </p>
          <p class="hint">Edit chunks above to manually fix text, then save to update the EPUB.</p>
        </div>
      }
    </div>
  `,
  styles: [`
    .skipped-chunks-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-default);
      flex-shrink: 0;

      h4 {
        margin: 0;
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .skip-badge {
      font-size: 0.75rem;
      font-weight: 500;
      padding: 0.125rem 0.5rem;
      border-radius: 10px;
      background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent);
      color: var(--warning, #f59e0b);
    }

    .loading-state,
    .error-state,
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      text-align: center;
      color: var(--text-secondary);
    }

    .spinner {
      font-size: 1.5rem;
      animation: spin 1s linear infinite;
      margin-bottom: 0.5rem;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .error-state {
      color: var(--error);
    }

    .error-icon {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }

    .hint {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      margin-top: 0.25rem;
    }

    .chunks-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
    }

    .chunk-card {
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      margin-bottom: 0.5rem;
      overflow: hidden;

      &.expanded {
        border-color: var(--accent);
      }

      &.editing {
        border-color: var(--accent-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 20%, transparent);
      }
    }

    .chunk-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      cursor: pointer;
      transition: background 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .chunk-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .reason-badge {
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      letter-spacing: 0.02em;

      &.copyright {
        background: color-mix(in srgb, var(--error) 15%, transparent);
        color: var(--error);
      }

      &.content-skip {
        background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent);
        color: var(--warning, #f59e0b);
      }

      &.ai-refusal {
        background: color-mix(in srgb, var(--info) 15%, transparent);
        color: var(--info);
      }
    }

    .chapter-title {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    .chunk-index {
      font-size: 0.75rem;
      color: var(--text-tertiary);
    }

    .expand-icon {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .chunk-content {
      padding: 0 0.75rem 0.75rem;
      border-top: 1px solid var(--border-subtle);
    }

    .content-section {
      margin-top: 0.75rem;

      h5 {
        margin: 0;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      &.ai-response h5 {
        color: var(--warning, #f59e0b);
      }
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }

    .edit-btn {
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--accent-primary);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s ease;

      &:hover {
        background: var(--accent-hover);
      }
    }

    .text-preview {
      font-family: var(--font-mono, monospace);
      font-size: 0.75rem;
      line-height: 1.5;
      padding: 0.75rem;
      background: var(--bg-elevated);
      border-radius: 4px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-primary);

      &.small {
        max-height: 150px;
        font-size: 0.6875rem;
        color: var(--text-secondary);
      }
    }

    .text-editor {
      width: 100%;
      font-family: var(--font-mono, monospace);
      font-size: 0.75rem;
      line-height: 1.5;
      padding: 0.75rem;
      background: var(--bg-elevated);
      border: 2px solid var(--accent-primary);
      border-radius: 4px;
      color: var(--text-primary);
      resize: vertical;
      min-height: 200px;

      &:focus {
        outline: none;
        border-color: var(--accent-hover);
      }

      &:disabled {
        opacity: 0.6;
      }
    }

    .edit-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
      justify-content: flex-end;
    }

    .char-count {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      margin-right: auto;
    }

    .cancel-btn {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--bg-subtle);
      color: var(--text-secondary);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .save-btn {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--success, #22c55e);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s ease;

      &:hover:not(:disabled) {
        background: color-mix(in srgb, var(--success, #22c55e) 85%, black);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .summary {
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border-default);
      background: var(--bg-subtle);
      flex-shrink: 0;

      p {
        margin: 0;
        font-size: 0.8125rem;
        color: var(--text-secondary);
      }
    }
  `]
})
export class SkippedChunksPanelComponent implements OnChanges {
  private electronService = inject(ElectronService);

  // Inputs
  readonly skippedChunksPath = input<string | null>(null);
  readonly cleanedEpubPath = input<string | null>(null);

  // Outputs
  readonly chunkEdited = output<{ chapterTitle: string; oldText: string; newText: string }>();

  // State
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly chunks = signal<SkippedChunk[]>([]);
  readonly expandedChunks = signal<Set<number>>(new Set());

  // Editing state
  readonly editingChunkIndex = signal<number | null>(null);
  readonly saving = signal(false);
  editedText = '';

  // Computed values
  readonly totalSkipped = computed(() => this.chunks().length);
  readonly copyrightCount = computed(() =>
    this.chunks().filter(c => c.reason === 'copyright').length
  );
  readonly skipCount = computed(() =>
    this.chunks().filter(c => c.reason === 'content-skip').length
  );

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['skippedChunksPath']) {
      this.loadChunks();
    }
  }

  private async loadChunks(): Promise<void> {
    const path = this.skippedChunksPath();
    if (!path) {
      this.chunks.set([]);
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      const result = await this.electronService.loadSkippedChunks(path);
      if (result.success && result.chunks) {
        this.chunks.set(result.chunks);
      } else {
        this.error.set(result.error || 'Failed to load skipped chunks');
      }
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  toggleChunk(index: number): void {
    // Don't toggle if currently editing this chunk
    if (this.editingChunkIndex() === index) return;

    const expanded = new Set(this.expandedChunks());
    if (expanded.has(index)) {
      expanded.delete(index);
    } else {
      expanded.add(index);
    }
    this.expandedChunks.set(expanded);
  }

  startEditing(index: number, text: string): void {
    this.editingChunkIndex.set(index);
    this.editedText = text;
  }

  cancelEditing(): void {
    this.editingChunkIndex.set(null);
    this.editedText = '';
  }

  async saveEdit(index: number, chunk: SkippedChunk): Promise<void> {
    const epubPath = this.cleanedEpubPath();
    if (!epubPath) {
      this.error.set('No EPUB path available');
      return;
    }

    if (this.editedText === chunk.text) {
      this.cancelEditing();
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    try {
      // Call IPC to find and replace the text in the EPUB
      const result = await this.electronService.replaceTextInEpub(
        epubPath,
        chunk.text,
        this.editedText
      );

      if (result.success) {
        // Update the chunk in our local state
        this.chunks.update(chunks => {
          const updated = [...chunks];
          updated[index] = { ...updated[index], text: this.editedText };
          return updated;
        });

        // Also update the skipped-chunks.json file
        const skippedPath = this.skippedChunksPath();
        if (skippedPath) {
          await this.electronService.updateSkippedChunk(skippedPath, index, this.editedText);
        }

        // Emit event for parent component
        this.chunkEdited.emit({
          chapterTitle: chunk.chapterTitle,
          oldText: chunk.text,
          newText: this.editedText
        });

        this.cancelEditing();
      } else {
        this.error.set(result.error || 'Failed to save edit');
      }
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  getReasonLabel(reason: string): string {
    switch (reason) {
      case 'copyright':
        return 'Copyright';
      case 'content-skip':
        return 'Skip';
      case 'ai-refusal':
        return 'Refused';
      default:
        return reason;
    }
  }
}
