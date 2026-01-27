/**
 * Session Detail Component - Right panel showing session details, metadata editing, and actions
 */

import { Component, inject, signal, computed, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReassemblyService } from '../../services/reassembly.service';
import { ChapterListComponent } from '../chapter-list/chapter-list.component';
import { ConfirmModalComponent } from '../confirm-modal/confirm-modal.component';
import { QueueService } from '../../../queue/services/queue.service';
import { ReassemblyJobConfig } from '../../../queue/models/queue.types';

type Tab = 'metadata' | 'chapters' | 'actions';

@Component({
  selector: 'app-session-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, ChapterListComponent, ConfirmModalComponent],
  template: `
    <div class="session-detail">
      @if (!session()) {
        <div class="empty-state">
          <p>Select a session to view details</p>
        </div>
      } @else {
        <!-- Session Header -->
        <div class="detail-header">
          <h2>{{ session()?.metadata?.title || 'Untitled Session' }}</h2>
          @if (session()?.metadata?.author) {
            <p class="author">by {{ session()?.metadata?.author }}</p>
          }

          <!-- Completion Warning -->
          @if (session()!.percentComplete < 100) {
            <div class="warning-banner">
              <span class="warning-icon">&#x26A0;</span>
              <span>
                This session is {{ session()!.percentComplete }}% complete.
                Missing {{ session()!.totalSentences - session()!.completedSentences }} sentences.
                Reassembly will produce an incomplete audiobook.
              </span>
            </div>
          }
        </div>

        <!-- Tabs -->
        <div class="tabs">
          <button
            class="tab"
            [class.active]="activeTab() === 'metadata'"
            (click)="activeTab.set('metadata')"
          >
            Metadata
          </button>
          <button
            class="tab"
            [class.active]="activeTab() === 'chapters'"
            (click)="activeTab.set('chapters')"
          >
            Chapters ({{ session()?.chapters?.length || 0 }})
          </button>
          <button
            class="tab"
            [class.active]="activeTab() === 'actions'"
            (click)="activeTab.set('actions')"
          >
            Actions
          </button>
        </div>

        <!-- Tab Content -->
        <div class="tab-content">
          @if (activeTab() === 'metadata') {
            <div class="metadata-tab">
              <!-- Cover & Basic Info Row -->
              <div class="cover-info-row">
                <!-- Cover Image -->
                <div
                  class="cover-container"
                  [class.drag-over]="isDragOver()"
                  [class.has-cover]="editCoverDataUrl || (sessionCoverPath() && !sessionCoverError())"
                  (dragover)="onDragOver($event)"
                  (dragleave)="onDragLeave($event)"
                  (drop)="onDrop($event)"
                  (click)="selectCover()"
                  tabindex="0"
                  (keydown)="onCoverKeydown($event)"
                >
                  @if (editCoverDataUrl) {
                    <img [src]="editCoverDataUrl" alt="Cover" class="cover-image" />
                    <div class="cover-overlay">
                      <span>Change</span>
                    </div>
                    <button class="cover-clear-btn" (click)="clearCover(); $event.stopPropagation()" title="Remove cover">
                      &#10005;
                    </button>
                  } @else if (sessionCoverPath() && !sessionCoverError()) {
                    <img [src]="getCoverUrl(sessionCoverPath())" alt="Cover" class="cover-image" (error)="onSessionCoverLoadError()" />
                    <div class="cover-overlay">
                      <span>Change</span>
                    </div>
                  } @else {
                    <div class="cover-placeholder">
                      <span class="cover-icon">&#128247;</span>
                      <span class="cover-hint">{{ isDragOver() ? 'Drop' : 'Add Cover' }}</span>
                    </div>
                  }
                </div>

                <!-- Title & Author -->
                <div class="basic-info">
                  <div class="form-group">
                    <label>Title</label>
                    <input type="text" [(ngModel)]="editTitle" placeholder="Audiobook title" />
                  </div>
                  <div class="form-group">
                    <label>Author</label>
                    <input type="text" [(ngModel)]="editAuthor" placeholder="Author name" />
                  </div>
                </div>
              </div>

              <!-- Additional Metadata -->
              <div class="metadata-grid">
                <div class="form-group">
                  <label>Narrator</label>
                  <input type="text" [(ngModel)]="editNarrator" placeholder="Narrator name" />
                </div>
                <div class="form-group">
                  <label>Year</label>
                  <input type="text" [(ngModel)]="editYear" placeholder="2024" />
                </div>
                <div class="form-group">
                  <label>Series</label>
                  <input type="text" [(ngModel)]="editSeries" placeholder="Series name" />
                </div>
                <div class="form-group">
                  <label>Series #</label>
                  <input type="text" [(ngModel)]="editSeriesNumber" placeholder="1" />
                </div>
                <div class="form-group">
                  <label>Genre</label>
                  <input type="text" [(ngModel)]="editGenre" placeholder="Fiction, History..." />
                </div>
                <div class="form-group">
                  <label>Output Filename</label>
                  <input type="text" [(ngModel)]="editOutputFilename" placeholder="Auto-generated" />
                </div>
              </div>

              <div class="form-group">
                <label>Description</label>
                <textarea [(ngModel)]="editDescription" placeholder="Book description or synopsis" rows="2"></textarea>
              </div>

              <!-- Session Info (collapsible) -->
              <details class="session-info-details">
                <summary>Session Info</summary>
                <div class="info-grid">
                  <span class="label">Session ID:</span>
                  <span class="value">{{ session()?.sessionId }}</span>
                  <span class="label">Total Sentences:</span>
                  <span class="value">{{ session()?.totalSentences }}</span>
                  <span class="label">Completed:</span>
                  <span class="value">{{ session()?.completedSentences }} ({{ session()?.percentComplete }}%)</span>
                  <span class="label">Language:</span>
                  <span class="value">{{ session()?.metadata?.language || 'Unknown' }}</span>
                </div>
              </details>
            </div>
          }

          @if (activeTab() === 'chapters') {
            <div class="chapters-tab">
              <app-chapter-list
                [chapters]="reassemblyService.selectedSessionChapters()"
                (toggleExclude)="onToggleChapter($event)"
              />
            </div>
          }

          @if (activeTab() === 'actions') {
            <div class="actions-tab">
              <!-- Reassembly Progress -->
              @if (reassemblyService.progress()) {
                <div class="progress-section">
                  <div class="progress-header">
                    <span>{{ getProgressPhaseLabel() }}</span>
                    <span>{{ reassemblyService.progress()!.percentage }}%</span>
                  </div>
                  <div class="progress-bar">
                    <div
                      class="progress-fill"
                      [style.width.%]="reassemblyService.progress()!.percentage"
                    ></div>
                  </div>
                  @if (reassemblyService.progress()!.message) {
                    <div class="progress-message">
                      {{ reassemblyService.progress()!.message }}
                    </div>
                  }
                  @if (reassemblyService.progress()!.error) {
                    <div class="progress-error">
                      {{ reassemblyService.progress()!.error }}
                    </div>
                  }
                </div>
              }

              <!-- Action Buttons -->
              <div class="action-buttons">
                <button
                  class="btn"
                  [class.btn-primary]="!addedToQueue()"
                  [class.btn-success]="addedToQueue()"
                  [disabled]="isProcessing() || addedToQueue()"
                  (click)="onAddToQueue()"
                >
                  @if (isProcessing()) {
                    <span class="spinner"></span>
                    Processing...
                  } @else if (addedToQueue()) {
                    <span class="check-icon">&#10003;</span>
                    Added to Queue
                  } @else {
                    Add to Queue
                  }
                </button>

                <button
                  class="btn btn-danger"
                  [disabled]="isProcessing()"
                  (click)="onDelete()"
                >
                  Delete Session
                </button>
              </div>

              <div class="action-info">
                <p>
                  <strong>Add to Queue:</strong> Creates a reassembly job that will combine
                  the existing sentence audio files into a final M4B audiobook.
                </p>
                <p>
                  <strong>Delete Session:</strong> Permanently removes the session folder
                  and all associated audio files.
                </p>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Delete Confirmation Modal -->
    <app-confirm-modal
      [show]="showDeleteModal()"
      [title]="'Delete Session'"
      [message]="deleteModalMessage()"
      [confirmText]="'Delete'"
      [cancelText]="'Cancel'"
      [variant]="'danger'"
      (confirm)="onConfirmDelete()"
      (cancel)="onCancelDelete()"
    />
  `,
  styles: [`
    .session-detail {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-secondary);
    }

    .detail-header {
      padding: 16px;
      border-bottom: 1px solid var(--border-default);

      h2 {
        margin: 0 0 4px 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .author {
        margin: 0;
        color: var(--text-secondary);
        font-size: 14px;
      }
    }

    .warning-banner {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-top: 12px;
      padding: 12px;
      background: var(--status-warning-bg, rgba(255, 193, 7, 0.1));
      border: 1px solid var(--status-warning, #ffc107);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);

      .warning-icon {
        color: var(--status-warning, #ffc107);
        font-size: 16px;
      }
    }

    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border-default);
      padding: 0 16px;
    }

    .tab {
      padding: 12px 16px;
      border: none;
      background: none;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.15s ease;

      &:hover {
        color: var(--text-primary);
      }

      &.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
    }

    .metadata-tab,
    .actions-tab {
      padding: 16px;
    }

    .chapters-tab {
      height: 100%;
    }

    .cover-info-row {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-default);
    }

    .cover-container {
      position: relative;
      width: 90px;
      height: 120px;
      flex-shrink: 0;
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-muted);
      border: 1px dashed var(--border-default);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover, &:focus {
        border-color: var(--accent);

        .cover-overlay {
          opacity: 1;
        }
      }

      &.has-cover {
        border-style: solid;
      }

      &.drag-over {
        border-color: var(--accent);
        border-style: solid;
        background: color-mix(in srgb, var(--accent) 20%, transparent);
      }

      .cover-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .cover-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        font-size: 12px;
        font-weight: 500;
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      .cover-clear-btn {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        font-size: 10px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: var(--status-error, #ef4444);
        }
      }

      &:hover .cover-clear-btn {
        opacity: 1;
      }

      .cover-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        color: var(--text-muted);
        gap: 4px;

        .cover-icon {
          font-size: 20px;
          opacity: 0.5;
        }

        .cover-hint {
          font-size: 10px;
          text-align: center;
        }
      }
    }

    .basic-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;

      .form-group {
        margin-bottom: 0;
      }
    }

    .metadata-grid {
      display: grid;
      grid-template-columns: 1fr 100px;
      gap: 12px;
      margin-bottom: 12px;

      .form-group {
        margin-bottom: 0;
      }
    }

    .form-group {
      margin-bottom: 12px;

      label {
        display: block;
        margin-bottom: 4px;
        font-size: 11px;
        font-weight: 500;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      input, textarea {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 13px;
        font-family: inherit;

        &:focus {
          outline: none;
          border-color: var(--accent);
        }

        &::placeholder {
          color: var(--text-muted);
        }
      }

      textarea {
        resize: vertical;
        min-height: 50px;
      }
    }

    .session-info-details {
      margin-top: 16px;

      summary {
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        padding: 8px 0;

        &:hover {
          color: var(--text-primary);
        }
      }
    }

    .info-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px 12px;
      padding: 12px;
      background: var(--bg-surface);
      border-radius: 6px;
      font-size: 13px;

      .label {
        color: var(--text-secondary);
      }

      .value {
        color: var(--text-primary);
        word-break: break-all;
      }
    }

    .progress-section {
      margin-bottom: 24px;
      padding: 16px;
      background: var(--bg-surface);
      border-radius: 6px;

      .progress-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 14px;
        color: var(--text-primary);
      }

      .progress-bar {
        height: 8px;
        background: var(--bg-muted);
        border-radius: 4px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background: var(--accent);
        border-radius: 4px;
        transition: width 0.3s ease;
      }

      .progress-message {
        margin-top: 8px;
        font-size: 12px;
        color: var(--text-secondary);
      }

      .progress-error {
        margin-top: 8px;
        font-size: 12px;
        color: var(--status-error);
      }
    }

    .action-buttons {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
    }

    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 8px;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-small {
      padding: 6px 12px;
      font-size: 12px;
    }

    .btn-ghost {
      background: transparent;
      border: 1px solid var(--border-default);
      color: var(--text-secondary);

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
        border-color: var(--border-hover);
      }
    }

    .btn-primary {
      background: var(--accent);
      color: white;

      &:hover:not(:disabled) {
        filter: brightness(1.1);
      }
    }

    .btn-danger {
      background: var(--status-error, #dc3545);
      color: white;

      &:hover:not(:disabled) {
        filter: brightness(1.1);
      }
    }

    .btn-success {
      background: var(--status-success, #22c55e);
      color: white;
      cursor: default;

      .check-icon {
        font-size: 12px;
        margin-right: 4px;
      }
    }

    .action-info {
      padding: 16px;
      background: var(--bg-surface);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-secondary);

      p {
        margin: 0 0 12px 0;

        &:last-child {
          margin-bottom: 0;
        }
      }

      strong {
        color: var(--text-primary);
      }
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class SessionDetailComponent {
  readonly reassemblyService = inject(ReassemblyService);
  private readonly queueService = inject(QueueService);

  // State
  readonly activeTab = signal<Tab>('metadata');
  readonly isDragOver = signal(false);
  readonly editCoverError = signal(false);
  readonly sessionCoverError = signal(false);

  // Delete modal state
  readonly showDeleteModal = signal(false);

  // Track if job was added to queue
  readonly addedToQueue = signal(false);

  // Editable metadata - basic
  editTitle = '';
  editAuthor = '';
  editYear = '';
  editOutputFilename = '';

  // Editable metadata - extended
  editCoverPath = '';      // File path for reassembly job
  editCoverDataUrl = '';   // Data URL for display
  editNarrator = '';
  editSeries = '';
  editSeriesNumber = '';
  editGenre = '';
  editDescription = '';

  // Computed
  readonly session = this.reassemblyService.selectedSession;

  // Get cover path from session if available
  sessionCoverPath(): string {
    const session = this.session();
    if (!session) return '';
    // Use coverPath from metadata if available
    return session.metadata?.coverPath || '';
  }

  // Convert path to file:// URL (handle spaces and special chars)
  getCoverUrl(path: string): string {
    if (!path) return '';
    // Encode the path for use in file:// URL
    return 'file://' + encodeURI(path).replace(/#/g, '%23');
  }

  // Handle paste event globally when in metadata tab
  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    // Only handle paste if we're in the metadata tab and have a session
    if (this.activeTab() !== 'metadata' || !this.session()) return;

    // Don't intercept paste if user is in an input/textarea
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    const items = event.clipboardData?.items;
    if (!items) {
      console.log('[COVER] No clipboard items');
      return;
    }

    console.log('[COVER] Paste event, items:', items.length);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log('[COVER] Item type:', item.type);
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          console.log('[COVER] Got image file:', file.name, file.type, file.size);
          this.handleImageFile(file);
        }
        return;
      }
    }
  }

  constructor() {
    // Watch for session changes to update editable fields
    // Using a simple check in template would be cleaner but this works
  }

  ngOnChanges(): void {
    this.updateEditFields();
  }

  ngDoCheck(): void {
    // Update edit fields when session changes
    const session = this.session();
    if (session && this.editTitle === '' && session.metadata?.title) {
      this.updateEditFields();
    }
  }

  private updateEditFields(): void {
    const session = this.session();
    if (session) {
      this.editTitle = session.metadata?.title || '';
      this.editAuthor = session.metadata?.author || '';
      this.editYear = '';
      this.editOutputFilename = '';
      // Reset extended metadata
      this.editCoverPath = '';
      this.editCoverDataUrl = '';
      this.editNarrator = '';
      this.editSeries = '';
      this.editSeriesNumber = '';
      this.editGenre = '';
      this.editDescription = '';
      // Reset cover error states
      this.editCoverError.set(false);
      this.sessionCoverError.set(false);
      // Reset added to queue state
      this.addedToQueue.set(false);
    }
  }

  // Cover drop zone handlers
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
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('image/')) {
        this.handleImageFile(file);
      }
    }
  }

  onCoverAreaClick(): void {
    // Clicking the cover area focuses it for paste support
    // The actual file picker is triggered by the Browse button
  }

  onCoverKeydown(event: KeyboardEvent): void {
    // Handle Cmd+V / Ctrl+V for paste
    if ((event.metaKey || event.ctrlKey) && event.key === 'v') {
      // Paste is handled by the global paste listener
    }
  }

  onEditCoverLoadError(): void {
    console.log('[COVER] Edit cover failed to load');
    this.editCoverError.set(true);
  }

  onSessionCoverLoadError(): void {
    console.log('[COVER] Session cover failed to load');
    this.sessionCoverError.set(true);
  }

  onCoverLoadSuccess(): void {
    console.log('[COVER] Cover loaded successfully');
    this.editCoverError.set(false);
  }

  private async handleImageFile(file: File): Promise<void> {
    console.log('[COVER] handleImageFile called:', file.name, file.type, file.size);

    // Save the image to a temp location and set the path
    const electron = (window as any).electron;
    if (!electron?.fs?.writeTempFile) {
      console.error('[COVER] Temp file writing not available - electron.fs.writeTempFile missing');
      return;
    }

    try {
      // Read file as array buffer
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      console.log('[COVER] Read buffer, size:', uint8Array.length);

      // Determine extension from mime type
      let ext = 'jpg';
      if (file.type === 'image/png') ext = 'png';
      else if (file.type === 'image/webp') ext = 'webp';

      const filename = `cover_${Date.now()}.${ext}`;
      console.log('[COVER] Saving to temp file:', filename);

      // Save to temp file
      const result = await electron.fs.writeTempFile(filename, uint8Array);
      console.log('[COVER] writeTempFile result:', result);

      if (result.success && result.path && result.dataUrl) {
        this.editCoverPath = result.path;
        this.editCoverDataUrl = result.dataUrl;
        this.editCoverError.set(false);
        console.log('[COVER] Cover path set to:', result.path);
        console.log('[COVER] DataUrl length:', result.dataUrl.length);
      } else {
        console.error('[COVER] writeTempFile failed:', result.error);
      }
    } catch (err) {
      console.error('[COVER] Failed to save cover image:', err);
    }
  }

  async selectCover(): Promise<void> {
    // Use electron dialog to select image file
    const electron = (window as any).electron;
    if (!electron?.dialog?.showOpenDialog) {
      console.error('[COVER] File picker not available');
      return;
    }

    const result = await electron.dialog.showOpenDialog({
      title: 'Select Cover Image',
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }
      ],
      properties: ['openFile']
    });

    if (result.success && result.data?.filePaths?.[0]) {
      const filePath = result.data.filePaths[0];
      this.editCoverPath = filePath;
      this.editCoverError.set(false);

      // Read the file and convert to data URL for display
      try {
        const readResult = await electron.fs.readBinary(filePath);
        if (readResult.success && readResult.data) {
          const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg';
          const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          const base64 = this.uint8ArrayToBase64(readResult.data);
          this.editCoverDataUrl = `data:${mimeType};base64,${base64}`;
          console.log('[COVER] Loaded cover from file picker');
        }
      } catch (err) {
        console.error('[COVER] Failed to read selected file:', err);
      }
    }
  }

  private uint8ArrayToBase64(data: Uint8Array): string {
    let binary = '';
    const len = data.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  clearCover(): void {
    this.editCoverPath = '';
    this.editCoverDataUrl = '';
    this.editCoverError.set(false);
  }

  isProcessing(): boolean {
    return this.reassemblyService.currentJobId() !== null;
  }

  getProgressPhaseLabel(): string {
    const phase = this.reassemblyService.progress()?.phase;
    switch (phase) {
      case 'preparing': return 'Preparing...';
      case 'combining': return 'Combining chapters...';
      case 'encoding': return 'Encoding M4B...';
      case 'metadata': return 'Adding metadata...';
      case 'complete': return 'Complete!';
      case 'error': return 'Error';
      default: return 'Processing...';
    }
  }

  onToggleChapter(chapterNum: number): void {
    this.reassemblyService.toggleChapterExclusion(chapterNum);
  }

  async onAddToQueue(): Promise<void> {
    const session = this.session();
    if (!session) return;

    // Get output directory from settings (use default for now)
    const outputDir = '/Volumes/Callisto/books/audiobooks';

    // Determine cover path - use user selection or fall back to session cover
    const coverPath = this.editCoverPath || this.sessionCoverPath() || undefined;

    // Create job config with all metadata
    const config: Partial<ReassemblyJobConfig> = {
      type: 'reassembly',
      sessionId: session.sessionId,
      sessionDir: session.sessionDir,
      processDir: session.processDir,
      outputDir,
      metadata: {
        title: this.editTitle || session.metadata?.title || 'Untitled',
        author: this.editAuthor || session.metadata?.author || 'Unknown',
        year: this.editYear || undefined,
        coverPath,
        outputFilename: this.editOutputFilename || undefined,
        // Extended metadata
        narrator: this.editNarrator || undefined,
        series: this.editSeries || undefined,
        seriesNumber: this.editSeriesNumber || undefined,
        genre: this.editGenre || undefined,
        description: this.editDescription || undefined
      },
      excludedChapters: this.reassemblyService.getExcludedChapters()
    };

    // Add to queue
    await this.queueService.addJob({
      type: 'reassembly',
      epubPath: session.processDir, // Use processDir as identifier
      config,
      metadata: {
        title: config.metadata?.title,
        author: config.metadata?.author
      }
    });

    // Update button state
    this.addedToQueue.set(true);

    console.log('[REASSEMBLY] Added job to queue with metadata:', config.metadata);
  }

  onDelete(): void {
    this.showDeleteModal.set(true);
  }

  deleteModalMessage(): string {
    const session = this.session();
    if (!session) return '';
    const title = session.metadata?.title || session.sessionId;
    return `Are you sure you want to delete "${title}"? This will permanently remove all audio files.`;
  }

  async onConfirmDelete(): Promise<void> {
    const session = this.session();
    this.showDeleteModal.set(false);
    if (!session) return;

    const result = await this.reassemblyService.deleteSession(session.sessionId);
    if (!result.success) {
      console.error('Failed to delete session:', result.error);
    }
  }

  onCancelDelete(): void {
    this.showDeleteModal.set(false);
  }
}
