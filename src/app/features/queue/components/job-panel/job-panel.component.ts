/**
 * The queue's right-hand panel — the ONE view of a selected job.
 *
 * It replaces the old three-way split (workflow pipeline / drilled-in child /
 * details) where each view showed a third of the picture and you had to toggle
 * "Sub-tasks" to trade one for another. Everything is here at once: the overall bar
 * and total estimate on top, every step with its own bars on the left, and the
 * job's book/configuration/timeline in a column beside them — which is what the
 * horizontal space was going spare for.
 *
 * A standalone job is rendered as a workflow of one step, so there is exactly one
 * layout to reason about.
 */

import { Component, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { JobType, QueueJob } from '../../models/queue.types';
import { stagesFor } from '../../models/job-stages';
import { JobEtaService } from '../../services/job-eta.service';
import { JobStepComponent } from '../job-step/job-step.component';
import { JobDetailsComponent } from '../job-details/job-details.component';

/** Emoji marker per job type — the same glyphs the queue has always used. */
const TYPE_ICONS: Record<JobType, string> = {
  'translation': '\u{1F310}',
  'tts-conversion': '\u{1F3A7}',
  'rvc-enhancement': '\u{1F399}',
  'reassembly': '\u{1F527}',
  'bilingual-cleanup': '\u{1F4DD}',
  'bilingual-translation': '\u{1F393}',
  'bilingual-assembly': '\u{1F3B5}',
  'video-assembly': '\u{1F3AC}',
  'audiobook': '\u{1F4D6}',
  'book-analysis': '\u{1F50D}',
  'generate-sentences': '\u{1F50A}',
  // Processing passes
  'simplify': '\u{1F4D6}',
  'translate-pass': '\u{1F310}',
  'footnote-refs': '\u{1F4CE}',
  // Making the book: a vision model reading pictures of pages.
  'vlm-convert': '\u{1F5A5}',
};

const TYPE_LABELS: Record<JobType, string> = {
  'translation': 'Translation',
  'tts-conversion': 'TTS Conversion',
  'rvc-enhancement': 'Voice Enhancement',
  'reassembly': 'Reassembly',
  'bilingual-cleanup': 'Bilingual Cleanup',
  'bilingual-translation': 'Bilingual Translation',
  'bilingual-assembly': 'Bilingual Assembly',
  'video-assembly': 'Video Assembly',
  'audiobook': 'Audiobook',
  'book-analysis': 'Book Analysis',
  'generate-sentences': 'Generate Sentences',
  'simplify': 'Simplify',
  'translate-pass': 'Translate',
  'footnote-refs': 'Remove footnote references',
  'vlm-convert': 'Convert to EPUB',
};

@Component({
  selector: 'app-job-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent, JobStepComponent, JobDetailsComponent],
  template: `
    @if (job(); as currentJob) {
      <div class="panel">
        <header class="panel-header">
          <span class="type-icon">{{ typeIcon() }}</span>
          <div class="identity">
            <div class="title" [title]="currentJob.metadata?.title || 'Untitled'">
              {{ currentJob.metadata?.title || 'Untitled' }}
            </div>
            <div class="subtitle">
              <span>{{ typeLabel() }}</span>
              @if (currentJob.metadata?.author) {
                <span class="dot">·</span>
                <span>{{ currentJob.metadata!.author }}</span>
              }
            </div>
          </div>

          <span class="status-badge" [class]="currentJob.status">
            @switch (currentJob.status) {
              @case ('pending')    { <span class="icon">&#9711;</span><span>Pending</span> }
              @case ('processing') { <span class="icon spinning">&#10227;</span><span>Processing</span> }
              @case ('complete')   { <span class="icon">&#10003;</span><span>Complete</span> }
              @case ('error')      { <span class="icon">&#10007;</span><span>Error</span> }
              @case ('stopped')    { <span class="icon">&#9208;</span><span>Stopped</span> }
            }
          </span>

          <div class="header-actions">
            @if (currentJob.status === 'processing') {
              <desktop-button variant="ghost" size="xs" (click)="cancel.emit(cancelTargetId())">Cancel</desktop-button>
            }
            @if (currentJob.status === 'pending') {
              <desktop-button variant="primary" size="xs" (click)="runNow.emit(currentJob.id)">&#9654; Run Now</desktop-button>
            }
            @if (currentJob.status === 'stopped') {
              <desktop-button variant="primary" size="xs" (click)="resume.emit(currentJob.id)">&#9654; Resume</desktop-button>
            }
            @if (currentJob.status === 'complete' || currentJob.status === 'error') {
              <desktop-button variant="primary" size="xs" (click)="retry.emit(currentJob.id)">Retry</desktop-button>
            }
            @if (currentJob.status !== 'processing') {
              <desktop-button variant="ghost" size="xs" (click)="remove.emit(currentJob.id)">Remove</desktop-button>
            }
          </div>
        </header>

        <!-- Overall progress + the broad "how long is this whole thing" readout -->
        <section class="overall">
          <div class="overall-bar-row">
            <div class="overall-track">
              @if (isAnalyzing()) {
                <!-- Pass-1 planning: no measurable fraction, so don't draw a fake one. -->
                <div class="overall-fill indeterminate"></div>
              } @else {
                <div class="overall-fill" [style.width.%]="overallPct()"></div>
              }
            </div>
            <span class="overall-pct">
              @if (isAnalyzing()) { Analyzing } @else { {{ overallPct() | number:'1.1-1' }}% }
            </span>
          </div>

          <div class="stats">
            <div class="stat">
              <span class="stat-label">Total elapsed</span>
              <span class="stat-value">{{ elapsed() }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Remaining</span>
              <span class="stat-value">{{ etaLabel() }}</span>
            </div>
            @if (finishTime(); as finish) {
              <div class="stat">
                <span class="stat-label">Finishes</span>
                <span class="stat-value">{{ finish }}</span>
              </div>
            }
            @if (steps().length > 1) {
              <div class="stat">
                <span class="stat-label">Steps</span>
                <span class="stat-value">{{ completedSteps() }}/{{ steps().length }}</span>
              </div>
            }
          </div>
        </section>

        <div class="columns">
          <div class="steps-column">
            @for (step of steps(); track step.id) {
              <app-job-step
                [job]="step"
                [expanded]="!collapsedStepIds().has(step.id)"
                (toggle)="toggleStep.emit($event)"
              />
            }
          </div>

          <aside class="details-column">
            <app-job-details
              [job]="detailsJob()"
              (showInFolder)="showInFolder.emit($event)"
            />
          </aside>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }

    .panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      gap: 0.875rem;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .type-icon {
      font-size: 1.5rem;
      line-height: 1;
      flex-shrink: 0;
    }

    .identity {
      flex: 1;
      min-width: 0;
    }

    .title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .subtitle {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dot {
      opacity: 0.5;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      flex-shrink: 0;
      font-size: 0.75rem;
      font-weight: 500;
      padding: 0.25rem 0.625rem;
      border-radius: 20px;

      .icon { font-size: 0.8125rem; }

      &.pending {
        background: var(--bg-sunken);
        color: var(--text-secondary);
      }

      &.processing {
        background: color-mix(in srgb, var(--accent) 15%, transparent);
        color: var(--accent);
      }

      &.complete {
        background: color-mix(in srgb, var(--success) 15%, transparent);
        color: var(--success);
      }

      &.error {
        background: color-mix(in srgb, var(--error) 15%, transparent);
        color: var(--error);
      }

      &.stopped {
        background: color-mix(in srgb, var(--warning) 15%, transparent);
        color: var(--warning);
      }
    }

    .spinning {
      display: inline-block;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .header-actions {
      display: flex;
      gap: 0.375rem;
      flex-shrink: 0;
    }

    .overall {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
      padding-bottom: 0.875rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .overall-bar-row {
      display: flex;
      align-items: center;
      gap: 0.875rem;
    }

    .overall-track {
      flex: 1;
      min-width: 0;
      height: 8px;
      background: var(--bg-sunken);
      border-radius: 4px;
      overflow: hidden;
    }

    .overall-fill {
      height: 100%;
      background: linear-gradient(
        90deg,
        var(--accent),
        color-mix(in srgb, var(--accent) 80%, var(--info))
      );
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .overall-fill.indeterminate {
      width: 40%;
      transition: none;
      animation: progress-indeterminate 1.2s ease-in-out infinite;
    }

    @keyframes progress-indeterminate {
      0% { margin-left: -40%; }
      100% { margin-left: 100%; }
    }

    .overall-pct {
      flex-shrink: 0;
      min-width: 3.75rem;
      text-align: right;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }

    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem 2rem;
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 0.0625rem;
    }

    .stat-label {
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-tertiary);
    }

    .stat-value {
      font-size: 0.8125rem;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    /* Two columns: the steps carry the eye, the details sit beside them instead of
       below the fold. Collapses to one column when the pane is too narrow to give
       the stage bars a readable track. */
    .columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 15rem;
      gap: 1.25rem;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      align-items: start;
    }

    .steps-column {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
    }

    .details-column {
      min-width: 0;
    }

    @media (max-width: 900px) {
      .columns {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `]
})
export class JobPanelComponent {
  private readonly eta = inject(JobEtaService);

  /** The selected job — a workflow master, or a standalone job. */
  readonly job = input.required<QueueJob>();
  /** The workflow's children, or [job] when it stands alone. */
  readonly steps = input.required<QueueJob[]>();
  /** Steps the user has explicitly folded away. Expanded is the default. */
  readonly collapsedStepIds = input<Set<string>>(new Set());

  readonly cancel = output<string>();
  readonly remove = output<string>();
  readonly retry = output<string>();
  readonly runNow = output<string>();
  readonly resume = output<string>();
  readonly toggleStep = output<string>();
  readonly showInFolder = output<string>();

  readonly typeIcon = computed(() => TYPE_ICONS[this.job().type]);

  readonly typeLabel = computed(() => {
    const job = this.job();
    // A workflow master's own type is its first step's; naming it after that step
    // would claim the whole job is "AI Cleanup".
    if (job.workflowId && !job.parentJobId) return 'Workflow';
    return TYPE_LABELS[job.type];
  });

  /**
   * Pass-1 planning has no measurable fraction, so the overall bar must not draw one.
   * Read from the STEPS: the row above them is a container and never plans anything,
   * so asking it would quietly lose the state the moment a run gained a master row.
   */
  readonly isAnalyzing = computed(() =>
    this.steps().some(s => s.status === 'processing' && s.cleanupPhase === 'analyzing')
  );

  readonly overallPct = computed(() => {
    const job = this.job();
    if (job.status === 'complete') return 100;
    // TTS reports chunks, not a percentage — progress stays 0 through conversion.
    if (job.type === 'tts-conversion' && job.totalChunksInJob) {
      return Math.min(100, ((job.chunksCompletedInJob || 0) / job.totalChunksInJob) * 100);
    }
    return Math.min(100, job.progress || 0);
  });

  readonly completedSteps = computed(() => this.steps().filter(s => s.status === 'complete').length);

  /**
   * The step the details column describes: the one running, or the first otherwise.
   *
   * A run's own row carries no configuration — it is a container — so pointing the
   * column at it left an empty Configuration heading beside the steps. What is
   * actually being asked there ("which voice is this being read in") is a property
   * of the task doing the work.
   */
  readonly detailsJob = computed<QueueJob>(() => {
    const steps = this.steps();
    if (steps.length === 0) {
      throw new Error('The job panel was given a run with no steps. A run is at least one step — a '
        + 'standalone job is a run of one — so an empty list means the caller resolved the wrong row.');
    }
    const running = steps.find(s => s.status === 'processing');
    return running === undefined ? steps[0] : running;
  });

  /**
   * The step Cancel acts on.
   *
   * Stopping a run means stopping the task that is actually on the GPU: the run's own
   * row executes nothing and the backend has never been told its id. Between two
   * steps there is no such task, and the run's id is then the only thing to name.
   */
  readonly cancelTargetId = computed(() => {
    const running = this.steps().find(s => s.status === 'processing');
    return running === undefined ? this.job().id : running.id;
  });

  /**
   * Time this WHOLE run has taken — every step added up, not the step running now.
   *
   * Read from the steps rather than from the row above them, because that row is a
   * container that never runs. Twenty minutes of narration followed by five of
   * assembly reads 25m here and 5m on the assembly step, which is the split Owen
   * asked for: the master field is the job, the step field is the task.
   */
  readonly elapsed = computed(() => this.eta.runElapsedDisplay(this.steps()));

  readonly etaLabel = computed(() => this.eta.etaDisplay(this.job(), stagesFor(this.job())));

  /**
   * Clock time the job should finish. Only shown past ten minutes out — below that
   * the countdown is the more useful number and a wall-clock time is just clutter.
   */
  readonly finishTime = computed<string | null>(() => {
    const job = this.job();
    const seconds = this.eta.etaSeconds(job, stagesFor(job));
    if (seconds === null || seconds < 600) return null;
    return new Date(Date.now() + seconds * 1000)
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });
}
