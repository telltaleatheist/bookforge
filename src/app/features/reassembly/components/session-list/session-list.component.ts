/**
 * Session List Component - Left panel showing incomplete e2a sessions
 */

import { Component, inject, output, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { E2aSession } from '../../models/reassembly.types';
import { ReassemblyService } from '../../services/reassembly.service';
import { ConfirmModalComponent } from '../confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-session-list',
  standalone: true,
  imports: [CommonModule, ConfirmModalComponent],
  template: `
    <div class="session-list">
      <div class="list-header">
        <h3>Past Sessions</h3>
        <button
          class="refresh-btn"
          [disabled]="reassemblyService.loading()"
          (click)="onRefresh()"
          title="Refresh sessions"
        >
          @if (reassemblyService.loading()) {
            <span class="spinner"></span>
          } @else {
            <span class="refresh-icon">&#x21BB;</span>
          }
        </button>
      </div>

      @if (reassemblyService.error()) {
        <div class="error-message">
          {{ reassemblyService.error() }}
        </div>
      }

      <div class="list-content">
        @if (reassemblyService.loading() && sessions().length === 0) {
          <div class="loading-placeholder">
            <span class="spinner"></span>
            Scanning for sessions...
          </div>
        } @else if (sessions().length === 0) {
          <div class="empty-state">
            <p>No incomplete sessions found.</p>
            <p class="hint">Sessions appear here when TTS conversion is interrupted.</p>
          </div>
        } @else {
          @for (session of sessions(); track session.sessionId) {
            <div
              class="session-item"
              [class.selected]="session.sessionId === selectedId()"
              [class.complete]="session.percentComplete >= 100"
              [class.incomplete]="session.percentComplete < 100 && session.percentComplete > 0"
              [class.empty]="session.percentComplete === 0"
              (click)="selectSession.emit(session.sessionId)"
            >
              <!-- Cover -->
              <div class="item-cover">
                @if (session.metadata.coverPath && !coverErrors[session.sessionId]) {
                  <img
                    [src]="'file://' + session.metadata.coverPath"
                    alt="Cover"
                    (error)="onCoverError(session.sessionId)"
                  />
                } @else {
                  <div class="no-cover">&#128214;</div>
                }
              </div>

              <!-- Info -->
              <div class="item-info">
                <div class="item-title">
                  {{ session.metadata.title || 'Untitled' }}
                </div>
                <div class="item-meta">
                  <span class="item-author">{{ session.metadata.author || 'Unknown Author' }}</span>
                  <span class="item-date">{{ formatDate(session.modifiedAt) }}</span>
                </div>
                <div class="item-status">
                  <div class="progress-bar">
                    <div
                      class="progress-fill"
                      [style.width.%]="session.percentComplete"
                      [class.complete]="session.percentComplete >= 100"
                      [class.partial]="session.percentComplete < 100"
                    ></div>
                  </div>
                  <span class="progress-text" [class.complete]="session.percentComplete >= 100">
                    {{ session.percentComplete }}%
                  </span>
                </div>
              </div>

              <!-- Delete button -->
              <button
                class="delete-btn"
                title="Delete session"
                (click)="onDelete($event, session)"
              >
                &#215;
              </button>
            </div>
          }
        }
      </div>

      @if (reassemblyService.tmpPath()) {
        <div class="tmp-path">
          <small>{{ reassemblyService.tmpPath() }}</small>
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
    .session-list {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
    }

    .list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-default);

      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .refresh-btn {
      background: none;
      border: none;
      padding: 4px 8px;
      cursor: pointer;
      color: var(--text-secondary);
      border-radius: 4px;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .refresh-icon {
        font-size: 16px;
      }
    }

    .error-message {
      padding: 8px 16px;
      background: var(--status-error-bg);
      color: var(--status-error-text);
      font-size: 12px;
    }

    .list-content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .loading-placeholder,
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      color: var(--text-secondary);
      text-align: center;
      gap: 8px;

      p {
        margin: 0;
      }

      .hint {
        font-size: 12px;
        opacity: 0.7;
      }
    }

    .session-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem;
      margin-bottom: 0.5rem;
      border-radius: 6px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);

        .delete-btn {
          opacity: 1;
        }
      }

      &.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 5%, transparent);
      }

      // Complete sessions - green indicator
      &.complete {
        border-left: 3px solid var(--status-success, #22c55e);
      }

      // Incomplete sessions - yellow/orange indicator
      &.incomplete {
        border-left: 3px solid var(--status-warning, #f59e0b);
      }

      // Empty sessions (0%) - red indicator
      &.empty {
        border-left: 3px solid var(--status-error, #ef4444);
      }
    }

    .item-cover {
      width: 40px;
      height: 56px;
      flex-shrink: 0;
      background: var(--bg-muted);
      border-radius: 4px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .no-cover {
        font-size: 1.25rem;
        opacity: 0.5;
      }
    }

    .item-info {
      flex: 1;
      min-width: 0;
    }

    .item-title {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
      white-space: nowrap;
      overflow: hidden;
    }

    .item-author {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-date {
      color: var(--text-muted);
      flex-shrink: 0;
      font-size: 0.6875rem;
    }

    .item-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;

      .progress-bar {
        flex: 1;
        height: 3px;
        background: var(--bg-muted);
        border-radius: 2px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.3s ease;

        &.complete {
          background: var(--status-success, #22c55e);
        }

        &.partial {
          background: var(--status-warning, #f59e0b);
        }
      }

      .progress-text {
        font-size: 0.6875rem;
        color: var(--text-muted);
        min-width: 28px;
        text-align: right;

        &.complete {
          color: var(--status-success, #22c55e);
        }
      }
    }

    .delete-btn {
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted);
      font-size: 1rem;
      cursor: pointer;
      opacity: 0;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        background: var(--bg-hover);
        color: var(--status-error, #ef4444);
      }
    }

    .tmp-path {
      padding: 8px 16px;
      border-top: 1px solid var(--border-default);
      font-size: 10px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--text-muted);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class SessionListComponent {
  readonly reassemblyService = inject(ReassemblyService);

  // Inputs
  readonly sessions = input.required<E2aSession[]>();
  readonly selectedId = input<string | null>(null);

  // Outputs
  readonly selectSession = output<string>();
  readonly refresh = output<void>();
  readonly deleteSession = output<string>();

  // Track which covers failed to load
  coverErrors: Record<string, boolean> = {};

  // Delete modal state
  readonly showDeleteModal = signal(false);
  private sessionToDelete: E2aSession | null = null;

  deleteModalMessage(): string {
    if (!this.sessionToDelete) return '';
    const title = this.sessionToDelete.metadata.title || this.sessionToDelete.sessionId;
    return `Are you sure you want to delete "${title}"? This will permanently remove all audio files.`;
  }

  onCoverError(sessionId: string): void {
    this.coverErrors[sessionId] = true;
  }

  onRefresh(): void {
    this.refresh.emit();
  }

  onDelete(event: Event, session: E2aSession): void {
    event.stopPropagation();  // Don't select the session
    this.sessionToDelete = session;
    this.showDeleteModal.set(true);
  }

  onConfirmDelete(): void {
    if (this.sessionToDelete) {
      this.deleteSession.emit(this.sessionToDelete.sessionId);
    }
    this.showDeleteModal.set(false);
    this.sessionToDelete = null;
  }

  onCancelDelete(): void {
    this.showDeleteModal.set(false);
    this.sessionToDelete = null;
  }

  formatDate(date: string): string {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
