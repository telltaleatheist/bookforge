/**
 * Queue Component - Main page for the unified processing queue
 */

import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { QueueService } from './services/queue.service';
import { JobEtaService } from './services/job-eta.service';
import { ElectronService } from '../../core/services/electron.service';
import { JobListComponent } from './components/job-list/job-list.component';
import { JobPanelComponent } from './components/job-panel/job-panel.component';
import { DiffViewComponent } from '../audiobook/components/diff-view/diff-view.component';
import { QueueJob } from './models/queue.types';

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    DesktopButtonComponent,
    JobListComponent,
    JobPanelComponent,
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
              @if (completedCount() > 0 || errorCount() > 0) {
                <desktop-button
                  variant="ghost"
                  size="xs"
                  title="Clear completed and errors"
                  (click)="clearCompleted()"
                >
                  Clear Done
                </desktop-button>
              }
              @if (queueService.jobs().length > 0) {
                <desktop-button
                  variant="ghost"
                  size="xs"
                  title="Clear all jobs from queue"
                  (click)="clearAll()"
                >
                  Clear All
                </desktop-button>
              }
            </div>
          </div>

          <div class="queue-stats">
            <div class="stat">
              <span class="stat-value">{{ pendingCount() }}</span>
              <span class="stat-label">Pending</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ completedCount() }}</span>
              <span class="stat-label">Complete</span>
            </div>
            @if (errorCount() > 0) {
              <div class="stat error">
                <span class="stat-value">{{ errorCount() }}</span>
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
                (select)="selectJob($event)"
                (reorder)="reorderJobs($event)"
                (runNow)="runJobStandalone($event)"
                (resume)="resumeStoppedJob($event)"
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
                      (select)="selectJob($event)"
                      (reorder)="reorderJobs($event)"
                      (runNow)="runJobStandalone($event)"
                    />
                  </div>
                }
              </div>
            }
          </div>

        </div>

        <!-- Right Panel: Selected Job / Current Job / Empty State -->
        <div pane-secondary class="details-panel">
          @switch (rightPanel().view) {
            @case ('job') {
              <!-- One view for everything: overall bar + total estimate, every step
                   with its own bars, and the job's details beside them. -->
              <app-job-panel
                [job]="$any(rightPanel()).job"
                [steps]="$any(rightPanel()).steps"
                [collapsedStepIds]="collapsedStepIds()"
                (cancel)="cancelJob($event)"
                (remove)="removeJob($event)"
                (retry)="retryJob($event)"
                (runNow)="runJobStandalone($event)"
                (resume)="resumeStoppedJob($event)"
                (toggleStep)="toggleStep($event)"
                (viewDiff)="openDiffModal($event)"
                (showInFolder)="showInFolder($event)"
              />
            }
            @case ('empty') {
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
            }
            @case ('idle') {
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
      background: var(--bg-sidebar);
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
      background: var(--bg-elevated);
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
  private readonly jobEta = inject(JobEtaService);

  // Selected job state
  readonly selectedJobId = signal<string | null>(null);

  // Steps the user has explicitly folded away. Expanded is the default — the panel
  // exists to show everything at once — so this tracks the exceptions, not the rule.
  readonly collapsedStepIds = signal<Set<string>>(new Set());

  // Diff modal state
  readonly diffModalPaths = signal<{ originalPath: string; cleanedPath: string } | null>(null);
  @ViewChild(DiffViewComponent) diffViewRef?: DiffViewComponent;

  // Computed: get the selected job object
  readonly selectedJob = computed(() => {
    const id = this.selectedJobId();
    if (!id) return null;
    return this.queueService.jobs().find(j => j.id === id) || null;
  });

  /**
   * Single computed driving the entire right panel, as a discriminated union so the
   * template is one flat @switch.
   *
   *   'job'   — the selected job (or, with nothing selected, whatever is running):
   *             overall progress, every step, and the details, all at once.
   *   'empty' — no jobs at all
   *   'idle'  — jobs exist but none selected and nothing running
   *
   * A standalone job reports itself as its own single step, so the panel has one
   * shape to render whether or not the job is part of a workflow.
   */
  readonly rightPanel = computed<
    | { view: 'job'; job: QueueJob; steps: QueueJob[] }
    | { view: 'empty' }
    | { view: 'idle' }
  >(() => {
    const job = this.selectedJob() ?? this.queueService.currentJob();

    if (job) {
      const isWorkflow = !!(job.workflowId && !job.parentJobId);
      const steps = isWorkflow ? this.queueService.getChildJobs(job.id) : [job];
      // A workflow whose children haven't been created yet still needs a step to show.
      return { view: 'job', job, steps: steps.length > 0 ? steps : [job] };
    }

    if (this.queueService.jobs().length === 0) {
      return { view: 'empty' };
    }

    return { view: 'idle' };
  });

  // Computed: active jobs (pending + processing), excluding sub-jobs
  readonly activeJobs = computed(() => {
    // 'stopped' rows stay in the ACTIVE list — they're paused work waiting for an
    // explicit resume (▶/Start), not finished work.
    return this.queueService.jobs().filter(j => (j.status === 'pending' || j.status === 'processing' || j.status === 'stopped') && !j.parentJobId);
  });

  // Computed: finished jobs (complete + error), excluding sub-jobs
  readonly finishedJobs = computed(() => {
    return this.queueService.jobs().filter(j => (j.status === 'complete' || j.status === 'error') && !j.parentJobId);
  });

  // Local stats excluding sub-jobs
  readonly pendingCount = computed(() => this.queueService.jobs().filter(j => j.status === 'pending' && !j.parentJobId).length);
  readonly completedCount = computed(() => this.queueService.jobs().filter(j => j.status === 'complete' && !j.parentJobId).length);
  readonly errorCount = computed(() => this.queueService.jobs().filter(j => j.status === 'error' && !j.parentJobId).length);

  // Accordion state
  readonly completedExpanded = signal(false);

  // Toolbar
  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const isRunning = this.queueService.isRunning();
    const hasCurrentJob = !!this.queueService.currentJob();
    // Stopped jobs count as startable: Start is the explicit consent that flips
    // them back to pending and resumes from their cached progress.
    const hasPendingJobs = this.queueService.pendingJobs().length > 0
      || this.queueService.jobs().some(j => j.status === 'stopped');

    // State: paused while job is still finishing
    const isPausing = !isRunning && hasCurrentJob;

    const items: ToolbarItem[] = [];

    // Start/Resume button - visible when not running (queue stopped or paused)
    if (!isRunning) {
      items.push({
        id: 'start',
        type: 'button',
        icon: '\u25B6', // ▶
        label: isPausing ? 'Resume' : 'Start',
        tooltip: isPausing
          ? 'Resume queue (process next job after current completes)'
          : 'Start queue processing (resumes stopped jobs)',
        disabled: !hasPendingJobs && !isPausing
      });
    }

    // Pause button - visible when running OR when pausing (to show state)
    if (isRunning || isPausing) {
      items.push({
        id: isPausing ? 'pausing' : 'pause',
        type: 'button',
        icon: '\u23F8', // ⏸
        label: isPausing ? 'Pausing...' : 'Pause',
        tooltip: isPausing
          ? 'Queue will stop after current job completes'
          : 'Pause queue (current job will complete, next job won\'t start)',
        disabled: isPausing
      });
    }

    // Stop button - visible when there's a current job
    if (hasCurrentJob) {
      items.push({
        id: 'stop',
        type: 'button',
        icon: '\u25A0', // ■
        label: 'Stop',
        tooltip: 'Stop immediately and reset current job to pending'
      });
    }

    items.push(
      {
        id: 'refresh',
        type: 'button',
        icon: '\u21BB',
        label: 'Refresh',
        tooltip: 'Re-sync with background jobs (use after app rebuild)'
      },
      { id: 'sep1', type: 'divider' },
      { id: 'spacer', type: 'spacer' }
    );

    return items;
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
      case 'refresh':
        this.queueService.refreshFromBackend();
        break;
    }
  }

  async removeJob(jobId: string): Promise<void> {
    if (this.collapsedStepIds().has(jobId)) {
      const next = new Set(this.collapsedStepIds());
      next.delete(jobId);
      this.collapsedStepIds.set(next);
    }
    if (this.selectedJobId() === jobId) {
      this.selectedJobId.set(null);
    }
    this.jobEta.forget(jobId);
    await this.queueService.removeJob(jobId);
  }

  retryJob(jobId: string): void {
    // A retry reuses the job id, so the previous run's throughput measurement has to
    // go with it — otherwise the fresh run inherits the old run's speed and ETA.
    this.jobEta.forget(jobId);
    this.queueService.retryJob(jobId);
  }

  cancelJob(jobId: string): void {
    this.queueService.cancelJob(jobId);
  }

  resumeStoppedJob(jobId: string): void {
    this.jobEta.forget(jobId);
    this.queueService.resumeStoppedJob(jobId);
  }

  async showInFolder(filePath: string): Promise<void> {
    await this.electronService.showItemInFolder(filePath);
  }

  reorderJobs(event: { fromId: string; toId: string }): void {
    this.queueService.reorderJobsById(event.fromId, event.toId);
  }

  clearCompleted(): void {
    this.forgetEtaFor(this.finishedJobs());
    this.queueService.clearCompleted();
  }

  clearAll(): void {
    this.forgetEtaFor(this.queueService.jobs());
    this.queueService.clearAll();
  }

  /** Drop cached throughput/stage state for jobs leaving the queue. */
  private forgetEtaFor(jobs: QueueJob[]): void {
    for (const job of jobs) {
      this.jobEta.forget(job.id);
      for (const child of this.queueService.getChildJobs(job.id)) {
        this.jobEta.forget(child.id);
      }
    }
  }

  startQueue(): void {
    this.queueService.startQueue();
  }

  /**
   * Run a job standalone (doesn't chain to next job when complete)
   * Allows running multiple jobs in parallel - useful for reassembly while TTS is running
   */
  async runJobStandalone(jobId: string): Promise<void> {
    const success = await this.queueService.runJobStandalone(jobId);
    if (!success) {
      console.error('[Queue] Failed to start standalone job:', jobId);
    }
  }

  selectJob(jobId: string): void {
    // Clicking the already-selected job is a no-op — it must not disturb which
    // steps the user has folded away.
    if (this.selectedJobId() === jobId) return;
    this.selectedJobId.set(jobId);
  }

  /** Fold a step away, or bring it back. Steps start expanded. */
  toggleStep(stepId: string): void {
    const next = new Set(this.collapsedStepIds());
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    this.collapsedStepIds.set(next);
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
      console.log('[Queue] Text edit saved to EPUB, refreshing diff view');
      if (this.diffViewRef) {
        this.diffViewRef.refresh();
      }
    } else {
      console.error('[Queue] Failed to save text edit:', result.error);
    }
  }

}
