/**
 * Queue Component - Main page for the unified processing queue
 */

import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { QueueService } from './services/queue.service';
import { ElectronService } from '../../core/services/electron.service';
import { JobListComponent } from './components/job-list/job-list.component';
import { JobProgressComponent } from './components/job-progress/job-progress.component';
import { JobDetailsComponent } from './components/job-details/job-details.component';
import { DiffViewComponent } from '../audiobook/components/diff-view/diff-view.component';
import { QueueJob, JobType } from './models/queue.types';

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    DesktopButtonComponent,
    JobListComponent,
    JobProgressComponent,
    JobDetailsComponent,
    DiffViewComponent
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <div class="queue-container">
      <desktop-split-pane [primarySize]="320" [minSize]="250" [maxSize]="500">
        <!-- Left Panel: Job List -->
        <div pane-primary class="jobs-panel">
          <div class="panel-header">
            <h3>Processing Queue</h3>
            <div class="header-actions">
              @if (queueService.completedJobs().length > 0 || queueService.errorJobs().length > 0) {
                <desktop-button
                  variant="ghost"
                  size="xs"
                  title="Clear completed"
                  (click)="clearCompleted()"
                >
                  Clear
                </desktop-button>
              }
            </div>
          </div>

          <div class="queue-stats">
            <div class="stat">
              <span class="stat-value">{{ queueService.pendingJobs().length }}</span>
              <span class="stat-label">Pending</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ queueService.completedJobs().length }}</span>
              <span class="stat-label">Complete</span>
            </div>
            @if (queueService.errorJobs().length > 0) {
              <div class="stat error">
                <span class="stat-value">{{ queueService.errorJobs().length }}</span>
                <span class="stat-label">Errors</span>
              </div>
            }
          </div>

          <div class="jobs-list-container">
            <!-- Active jobs (pending/processing) -->
            @if (activeJobs().length > 0) {
              <app-job-list
                [jobs]="activeJobs()"
                [selectedJobId]="selectedJobId()"
                (remove)="removeJob($event)"
                (retry)="retryJob($event)"
                (cancel)="cancelJob($event)"
                (moveUp)="moveJobUp($event)"
                (moveDown)="moveJobDown($event)"
                (select)="selectJob($event)"
                (reorder)="reorderJobs($event)"
              />
            } @else if (finishedJobs().length === 0) {
              <div class="empty-jobs">
                <p>No jobs in queue</p>
              </div>
            }

            <!-- Completed jobs accordion -->
            @if (finishedJobs().length > 0) {
              <div class="completed-accordion">
                <button
                  class="accordion-header"
                  (click)="completedExpanded.set(!completedExpanded())"
                >
                  <span class="accordion-icon">{{ completedExpanded() ? '▼' : '▶' }}</span>
                  <span class="accordion-title">Completed</span>
                  <span class="accordion-count">{{ finishedJobs().length }}</span>
                </button>
                @if (completedExpanded()) {
                  <div class="accordion-content">
                    <app-job-list
                      [jobs]="finishedJobs()"
                      [selectedJobId]="selectedJobId()"
                      (remove)="removeJob($event)"
                      (retry)="retryJob($event)"
                      (cancel)="cancelJob($event)"
                      (moveUp)="moveJobUp($event)"
                      (moveDown)="moveJobDown($event)"
                      (select)="selectJob($event)"
                      (reorder)="reorderJobs($event)"
                    />
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <!-- Right Panel: Current Job / Selected Job / Empty State -->
        <div pane-secondary class="details-panel">
          @if (queueService.currentJob(); as currentJob) {
            <!-- Show progress for currently processing job -->
            <app-job-progress
              [job]="currentJob"
              [message]="progressMessage()"
              (cancel)="cancelCurrent()"
            />
          } @else if (selectedJob(); as selected) {
            <!-- Show progress if selected job is processing, otherwise show details -->
            @if (selected.status === 'processing') {
              <app-job-progress
                [job]="selected"
                [message]="progressMessage()"
                (cancel)="cancelCurrent()"
              />
            } @else {
              <app-job-details
                [job]="selected"
                (remove)="removeJob($event)"
                (retry)="retryJob($event)"
                (viewDiff)="openDiffModal($event)"
                (showInFolder)="showInFolder($event)"
              />
            }
          } @else if (queueService.jobs().length === 0) {
            <!-- Empty state -->
            <div class="empty-state">
              <div class="empty-icon">&#9881;</div>
              <h2>Processing Queue</h2>
              <p>Add jobs from the Audiobook Producer to process them automatically.</p>
              <div class="instructions">
                <h4>How to use:</h4>
                <ol>
                  <li>Go to the Audiobook Producer</li>
                  <li>Select an EPUB file</li>
                  <li>Choose "Add to Queue" for OCR Cleanup or TTS Conversion</li>
                  <li>Return here and click "Start Processing"</li>
                </ol>
              </div>
            </div>
          } @else {
            <!-- Queue idle / ready to start - prompt to select a job -->
            <div class="idle-state">
              @if (queueService.isRunning()) {
                <div class="idle-icon">&#10003;</div>
                <h3>Queue Running</h3>
                <p>Waiting for next job to process.</p>
              } @else {
                <div class="idle-icon">&#9654;</div>
                <h3>Ready to Process</h3>
                <p>{{ activeJobs().length }} job(s) in queue</p>
                <p class="hint">Click a job to view details</p>
                @if (activeJobs().length > 0) {
                  <desktop-button
                    variant="primary"
                    size="md"
                    (click)="startQueue()"
                  >
                    Start Processing
                  </desktop-button>
                }
              }
            </div>
          }
        </div>
      </desktop-split-pane>
    </div>

    <!-- Diff View Modal -->
    @if (diffModalPaths()) {
      <div class="diff-modal-backdrop" (click)="closeDiffModal()">
        <div class="diff-modal" (click)="$event.stopPropagation()">
          <app-diff-view
            [originalPath]="diffModalPaths()!.originalPath"
            [cleanedPath]="diffModalPaths()!.cleanedPath"
            (close)="closeDiffModal()"
            (textEdited)="onDiffTextEdited($event)"
          />
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }

    .queue-container {
      flex: 1;
      overflow: hidden;
    }

    .jobs-panel {
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-subtle);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-default);

      h3 {
        margin: 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .header-actions {
      display: flex;
      gap: 0.25rem;
    }

    .queue-stats {
      display: flex;
      gap: 1rem;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-base);
    }

    .stat {
      display: flex;
      align-items: baseline;
      gap: 0.375rem;

      &.error {
        color: var(--error);
      }
    }

    .stat-value {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);

      .error & {
        color: var(--error);
      }
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .jobs-list-container {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
    }

    .empty-jobs {
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .completed-accordion {
      margin-top: 1rem;
      border-top: 1px solid var(--border-subtle);
      padding-top: 0.75rem;
    }

    .accordion-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.5rem;
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .accordion-icon {
      font-size: 0.625rem;
      opacity: 0.7;
    }

    .accordion-title {
      flex: 1;
      text-align: left;
    }

    .accordion-count {
      background: var(--bg-elevated);
      padding: 0.125rem 0.5rem;
      border-radius: 10px;
      font-size: 0.6875rem;
    }

    .accordion-content {
      padding-top: 0.5rem;
    }

    .details-panel {
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-base);
      padding: 1rem;
    }

    .empty-state,
    .idle-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
    }

    .empty-icon,
    .idle-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .empty-state h2,
    .idle-state h3 {
      margin: 0 0 0.5rem 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .empty-state p,
    .idle-state p {
      margin: 0 0 1rem 0;
      max-width: 350px;
    }

    .idle-state desktop-button {
      margin-top: 0.5rem;
    }

    .idle-state .hint {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }

    .instructions {
      text-align: left;
      background: var(--bg-subtle);
      padding: 1rem 1.5rem;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);

      h4 {
        margin: 0 0 0.75rem 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      ol {
        margin: 0;
        padding-left: 1.25rem;

        li {
          margin-bottom: 0.375rem;
          font-size: 0.875rem;

          &:last-child {
            margin-bottom: 0;
          }
        }
      }
    }

    .diff-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
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

    .diff-modal {
      width: 90%;
      max-width: 1200px;
      height: 80%;
      max-height: 800px;
      background: var(--bg-elevated);
      border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
      overflow: hidden;
      animation: slideUp 0.2s ease;

      app-diff-view {
        height: 100%;
      }
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
  `]
})
export class QueueComponent implements OnInit, OnDestroy {
  readonly queueService = inject(QueueService);
  private readonly electronService = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  // Progress message state
  readonly progressMessage = signal<string | undefined>(undefined);

  // Selected job state
  readonly selectedJobId = signal<string | null>(null);

  // Diff modal state
  readonly diffModalPaths = signal<{ originalPath: string; cleanedPath: string } | null>(null);

  // Computed: get the selected job object
  readonly selectedJob = computed(() => {
    const id = this.selectedJobId();
    if (!id) return null;
    return this.queueService.jobs().find(j => j.id === id) || null;
  });

  // Computed: active jobs (pending + processing)
  readonly activeJobs = computed(() => {
    return this.queueService.jobs().filter(j => j.status === 'pending' || j.status === 'processing');
  });

  // Computed: finished jobs (complete + error)
  readonly finishedJobs = computed(() => {
    return this.queueService.jobs().filter(j => j.status === 'complete' || j.status === 'error');
  });

  // Accordion state
  readonly completedExpanded = signal(false);

  // Toolbar
  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const isRunning = this.queueService.isRunning();
    const hasCurrentJob = !!this.queueService.currentJob();
    return [
      {
        id: isRunning ? 'pause' : 'start',
        type: 'button',
        icon: isRunning ? '\u23F8' : '\u25B6',
        label: isRunning ? 'Pause' : 'Start',
        tooltip: isRunning ? 'Pause queue (job will complete)' : 'Start queue processing'
      },
      ...(hasCurrentJob ? [{
        id: 'stop',
        type: 'button' as const,
        icon: '\u25A0',
        label: 'Stop',
        tooltip: 'Stop immediately and reset current job'
      }] : []),
      { id: 'sep1', type: 'divider' },
      { id: 'spacer', type: 'spacer' }
    ];
  });

  ngOnInit(): void {
    // Progress message updates happen via IPC
  }

  ngOnDestroy(): void {
    // Cleanup handled by DestroyRef
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'start':
        this.queueService.startQueue();
        break;
      case 'pause':
        this.queueService.pauseQueue();
        break;
      case 'stop':
        this.queueService.stopQueue();
        break;
    }
  }

  async removeJob(jobId: string): Promise<void> {
    await this.queueService.removeJob(jobId);
  }

  retryJob(jobId: string): void {
    this.queueService.retryJob(jobId);
  }

  cancelJob(jobId: string): void {
    this.queueService.cancelCurrent();
  }

  async showInFolder(filePath: string): Promise<void> {
    await this.electronService.showItemInFolder(filePath);
  }

  cancelCurrent(): void {
    this.queueService.cancelCurrent();
  }

  moveJobUp(jobId: string): void {
    this.queueService.moveJobUp(jobId);
  }

  moveJobDown(jobId: string): void {
    this.queueService.moveJobDown(jobId);
  }

  reorderJobs(event: { fromIndex: number; toIndex: number }): void {
    this.queueService.reorderJobs(event.fromIndex, event.toIndex);
  }

  clearCompleted(): void {
    this.queueService.clearCompleted();
  }

  startQueue(): void {
    this.queueService.startQueue();
  }

  selectJob(jobId: string): void {
    // Toggle selection if clicking the same job
    if (this.selectedJobId() === jobId) {
      this.selectedJobId.set(null);
    } else {
      this.selectedJobId.set(jobId);
    }
  }

  openDiffModal(paths: { originalPath: string; cleanedPath: string }): void {
    this.diffModalPaths.set(paths);
  }

  closeDiffModal(): void {
    this.diffModalPaths.set(null);
  }

  async onDiffTextEdited(event: { chapterId: string; oldText: string; newText: string }): Promise<void> {
    const paths = this.diffModalPaths();
    if (!paths?.cleanedPath) return;

    const electron = window.electron;
    if (!electron?.epub) return;

    const result = await electron.epub.editText(
      paths.cleanedPath,
      event.chapterId,
      event.oldText,
      event.newText
    );

    if (result.success) {
      console.log('Text edit saved to EPUB');
    } else {
      console.error('Failed to save text edit:', result.error);
    }
  }

  private getStatusText(): string {
    const current = this.queueService.currentJob();
    const pending = this.queueService.pendingJobs().length;

    if (current) {
      return `Processing: ${current.metadata?.title || 'Untitled'}`;
    }

    if (!this.queueService.isRunning()) {
      return 'Paused';
    }

    if (pending === 0) {
      return 'Queue empty';
    }

    return `${pending} job${pending === 1 ? '' : 's'} waiting`;
  }
}
