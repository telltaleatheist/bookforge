/**
 * One step in the queue panel: a job's own progress bar, plus everything that job
 * measures underneath it — stage bars, parallel workers, chunk counts, throughput.
 *
 * The same component renders a workflow child ("TTS" inside a 4-step workflow) and a
 * standalone job, because there is no real difference between them: a standalone job
 * is a workflow of one. That's what removed the old Sub-tasks/Overview split, where
 * the pipeline view and the drilled-in view each rendered half this information and
 * you could never see both.
 *
 * The header is a disclosure toggle. Expanded is the default — the point of the
 * rework is that everything is on screen — but a long-finished step is just noise
 * once you've seen it, so it can be folded away.
 */

import { Component, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { JobType, ParallelWorkerProgress, QueueJob } from '../../models/queue.types';
import { stagesFor } from '../../models/job-stages';
import { JobEtaService } from '../../services/job-eta.service';
import { StageBarsComponent } from '../stage-bars/stage-bars.component';

@Component({
  selector: 'app-job-step',
  standalone: true,
  imports: [CommonModule, StageBarsComponent],
  template: `
    <div class="step" [class]="job().status">
      <button
        class="step-header"
        [attr.aria-expanded]="expanded()"
        [title]="expanded() ? 'Collapse this step' : 'Expand this step'"
        (click)="toggle.emit(job().id)"
      >
        <span class="disclosure" [class.open]="expanded()">&#9656;</span>
        <span class="status-icon">
          @switch (job().status) {
            @case ('pending')    { <span>&#9711;</span> }
            @case ('processing') { <span class="spinning">&#10227;</span> }
            @case ('complete')   { <span>&#10003;</span> }
            @case ('error')      { <span>&#10007;</span> }
            @case ('stopped')    { <span>&#9208;</span> }
          }
        </span>
        <span class="step-name">{{ stepLabel() }}</span>
        @for (tag of configTags(); track tag) {
          <span class="config-tag">{{ tag }}</span>
        }
        <span class="spacer"></span>
        <span class="step-pct">
          @if (job().status === 'complete') { 100% }
          @else if (job().status === 'processing') { {{ overallPct() | number:'1.0-0' }}% }
          @else { -- }
        </span>
      </button>

      <div class="step-track">
        <div class="step-fill" [style.width.%]="overallPct()"></div>
      </div>

      @if (expanded()) {
        <div class="step-body">
          @if (stages().length > 0) {
            <app-stage-bars [stages]="stages()" [detail]="liveDetail()" [batch]="liveBatch()" />
          }

          @if (counters().length > 0) {
            <div class="counters">
              @for (counter of counters(); track counter.label) {
                <div class="counter">
                  <span class="counter-label">{{ counter.label }}</span>
                  <span class="counter-value">{{ counter.value }}</span>
                </div>
              }
            </div>
          }

          @if (workers().length > 0) {
            <div class="workers">
              <div class="workers-header">Workers</div>
              <div class="workers-grid">
                @for (worker of workers(); track worker.id) {
                  <div
                    class="worker-row"
                    [class.complete]="worker.status === 'complete'"
                    [class.error]="worker.status === 'error'"
                  >
                    <span class="worker-label">W{{ worker.id }}</span>
                    <div class="worker-track">
                      <div class="worker-fill" [style.width.%]="workerPct(worker)"></div>
                    </div>
                    <span class="worker-pct">{{ workerPct(worker) | number:'1.0-0' }}%</span>
                  </div>
                }
              </div>
            </div>
          }

          @if (job().progressMessage && job().status === 'processing') {
            <div class="step-message">{{ job().progressMessage }}</div>
          }

          @if (job().status === 'error' && job().error) {
            <div class="step-error">{{ job().error }}</div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .step {
      padding: 0.5rem 0.625rem 0.625rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;

      &.pending {
        opacity: 0.7;
      }

      &.processing {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
      }

      &.complete {
        border-color: color-mix(in srgb, var(--success) 45%, transparent);

        .status-icon { color: var(--success); }
      }

      &.error {
        border-color: var(--error);

        .status-icon { color: var(--error); }
      }

      &.stopped {
        border-color: var(--warning);

        .status-icon { color: var(--warning); }
      }
    }

    .step-header {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      width: 100%;
      padding: 0;
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      color: inherit;
      font: inherit;
    }

    .disclosure {
      flex-shrink: 0;
      width: 0.75rem;
      font-size: 0.625rem;
      color: var(--text-tertiary);
      transition: transform 0.15s ease;

      &.open {
        transform: rotate(90deg);
      }
    }

    .status-icon {
      flex-shrink: 0;
      width: 1.1rem;
      text-align: center;
      font-size: 0.8125rem;
      color: var(--text-secondary);

      .processing & { color: var(--accent); }
    }

    .spinning {
      display: inline-block;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .step-name {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
    }

    .config-tag {
      font-size: 0.625rem;
      color: var(--text-secondary);
      background: var(--bg-sunken);
      border: 1px solid var(--border-default);
      padding: 0.0625rem 0.3125rem;
      border-radius: 3px;
      white-space: nowrap;
    }

    .spacer {
      flex: 1;
    }

    .step-pct {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--accent);
      font-variant-numeric: tabular-nums;

      .complete & { color: var(--success); }
      .pending & { color: var(--text-tertiary); }
    }

    .step-track {
      height: 4px;
      margin: 0.375rem 0 0 1.15rem;
      background: var(--bg-sunken);
      border-radius: 2px;
      overflow: hidden;
    }

    .step-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      transition: width 0.3s ease;

      .complete & { background: var(--success); }
      .error & { background: var(--error); }
    }

    .step-body {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0.5rem 0 0 1.15rem;
    }

    .counters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1.25rem;
    }

    .counter {
      display: flex;
      align-items: baseline;
      gap: 0.375rem;
    }

    .counter-label {
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      color: var(--text-tertiary);
    }

    .counter-value {
      font-size: 0.75rem;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    .workers-header {
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      color: var(--text-tertiary);
      margin-bottom: 0.25rem;
    }

    .workers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: 0.25rem 1rem;
    }

    .worker-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .worker-label {
      flex: 0 0 1.75rem;
      font-size: 0.6875rem;
      color: var(--text-secondary);
    }

    .worker-track {
      flex: 1;
      min-width: 0;
      height: 5px;
      background: var(--bg-sunken);
      border-radius: 3px;
      overflow: hidden;
    }

    .worker-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.3s ease;

      .complete & { background: var(--success); }
      .error & { background: var(--error); }
    }

    .worker-pct {
      flex: 0 0 2.25rem;
      font-size: 0.6875rem;
      color: var(--text-secondary);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .step-message {
      font-size: 0.6875rem;
      color: var(--text-tertiary);
    }

    .step-error {
      font-size: 0.75rem;
      color: var(--error);
      white-space: pre-wrap;
      word-break: break-word;
    }
  `]
})
export class JobStepComponent {
  private readonly eta = inject(JobEtaService);

  readonly job = input.required<QueueJob>();
  readonly expanded = input<boolean>(true);

  readonly toggle = output<string>();

  readonly stages = computed(() => stagesFor(this.job()));

  /**
   * Live detail for the running stage — only while the job is actually running. A
   * finished job keeping "Rendering 21 sentences together…" pinned under a completed
   * bar would read as still working.
   */
  readonly liveDetail = computed(() =>
    this.job().status === 'processing' ? this.job().stageDetail : undefined
  );

  /**
   * The MLX batch decoding right now — same "only while running" rule as liveDetail,
   * for the same reason: a batch bar under a finished step would read as live work.
   */
  readonly liveBatch = computed(() =>
    this.job().status === 'processing' ? this.job().activeBatch : undefined
  );

  /**
   * The step's own headline percentage.
   *
   * TTS reports chunks rather than a percentage — `progress` stays at 0 for the
   * whole conversion — so it's computed from the chunk counts instead. Everything
   * else already publishes a real percentage.
   */
  readonly overallPct = computed(() => {
    const job = this.job();
    if (job.status === 'complete') return 100;
    if (job.type === 'tts-conversion' && job.totalChunksInJob) {
      return Math.min(100, ((job.chunksCompletedInJob || 0) / job.totalChunksInJob) * 100);
    }
    return Math.min(100, job.progress || 0);
  });

  readonly workers = computed(() => {
    const workers = this.job().parallelWorkers;
    // A single "worker" is just the job itself — a one-row grid says nothing.
    return workers && workers.length > 1 ? workers : [];
  });

  /**
   * The numeric readouts for this step: how much work, how fast. Only what this job
   * type actually measures — an empty row is worse than no row.
   */
  readonly counters = computed<{ label: string; value: string }[]>(() => {
    const job = this.job();
    const out: { label: string; value: string }[] = [];

    if (job.totalChunksInJob) {
      out.push({ label: 'Chunks', value: `${job.chunksCompletedInJob || 0}/${job.totalChunksInJob}` });
    } else if (job.currentChunk && job.totalChunks) {
      out.push({
        label: job.type === 'ocr-cleanup' || job.type === 'bilingual-cleanup' ? 'Chunks' : 'Sentences',
        value: `${job.currentChunk}/${job.totalChunks}`,
      });
    }

    if (job.totalChapters) {
      out.push({ label: 'Chapters', value: `${job.currentChapter || 0}/${job.totalChapters}` });
    }

    if (job.status === 'processing') {
      const speed = this.eta.speedLabel(job);
      if (speed) out.push({ label: 'Speed', value: speed });

      const stepEta = this.eta.etaDisplay(job, this.stages());
      if (stepEta !== '-') out.push({ label: 'ETA', value: stepEta });
    }

    if (job.status === 'complete' && job.startedAt && job.completedAt) {
      out.push({ label: 'Took', value: this.eta.elapsedDisplay(job) });
    }

    return out;
  });

  readonly stepLabel = computed(() => this.labelForType(this.job().type));

  /**
   * The settings that distinguish this run, as compact tags. Deliberately terse —
   * the full configuration lives in the details column; this is the "which model,
   * which voice" glance you want while watching progress.
   */
  readonly configTags = computed<string[]>(() => {
    const job = this.job();
    const config = job.config as Record<string, any> | undefined;
    if (!config) return [];
    const tags: string[] = [];

    switch (job.type) {
      case 'ocr-cleanup':
      case 'bilingual-cleanup':
        if (config['aiProvider'] && config['aiModel']) {
          tags.push(`${this.shortProvider(config['aiProvider'])} ${config['aiModel']}`);
        }
        if (config['simplifyForLearning']) tags.push('Simplify');
        if (config['testMode'] && config['testModeChunks']) tags.push(`Test: ${config['testModeChunks']}`);
        break;

      case 'translation':
      case 'bilingual-translation':
        if (config['aiProvider'] && config['aiModel']) {
          tags.push(`${this.shortProvider(config['aiProvider'])} ${config['aiModel']}`);
        }
        if (config['sourceLang'] && config['targetLang']) {
          tags.push(`${config['sourceLang']} → ${config['targetLang']}`);
        }
        if (config['monoTranslation']) tags.push('Mono');
        break;

      case 'tts-conversion':
        if (config['ttsEngine']) tags.push(this.capitalizeEngine(config['ttsEngine']));
        if (config['fineTuned']) tags.push(config['fineTuned']);
        if (config['speed'] && config['speed'] !== 1) tags.push(`${config['speed']}×`);
        if (config['device']) tags.push(String(config['device']).toUpperCase());
        if (config['useParallel'] && config['parallelWorkers'] > 1) {
          tags.push(`${config['parallelWorkers']} workers`);
        }
        break;

      case 'bilingual-assembly':
        if (config['sourceLang'] && config['targetLang']) {
          tags.push(`${config['sourceLang']} → ${config['targetLang']}`);
        }
        if (config['pattern']) tags.push(config['pattern']);
        break;

      case 'generate-sentences':
        if (config['modelLabel'] || config['modelId']) {
          tags.push(`${config['modelLabel'] || config['modelId']} model`);
        }
        break;
    }

    if (job.orpheusMemoryLevel) tags.push(`⚡ ${job.orpheusMemoryLevel}`);
    return tags;
  });

  /** Percentage for one parallel worker's slice of the book. */
  workerPct(worker: ParallelWorkerProgress): number {
    const job = this.job();
    const workerCount = job.parallelWorkers?.length || 1;

    // Resume jobs: the already-completed sentences are spread evenly as a baseline,
    // so every worker starts from the same percentage rather than from wherever its
    // own range happened to be left off.
    if (job.isResumeJob && job.resumeCompletedSentences !== undefined && job.resumeMissingSentences !== undefined) {
      const totalSentences = job.resumeCompletedSentences + job.resumeMissingSentences;
      if (totalSentences > 0 && workerCount > 0) {
        const totalPerWorker = totalSentences / workerCount;
        const baselinePerWorker = job.resumeCompletedSentences / workerCount;
        // actualConversions is the TTS work truly done this session (skips excluded).
        const workDone = worker.actualConversions ?? worker.completedSentences;
        return Math.min(100, ((baselinePerWorker + workDone) / totalPerWorker) * 100);
      }
    }

    const totalInRange = worker.sentenceEnd - worker.sentenceStart + 1;
    if (totalInRange <= 0) return 0;
    return Math.min(100, (worker.completedSentences / totalInRange) * 100);
  }

  private labelForType(type: JobType): string {
    switch (type) {
      case 'ocr-cleanup': return 'AI Cleanup';
      case 'translation': return 'Translation';
      case 'tts-conversion': return 'TTS';
      case 'rvc-enhancement': return 'Voice Enhancement';
      case 'reassembly': return 'Reassembly';
      case 'bilingual-cleanup': return 'AI Cleanup';
      case 'bilingual-translation': return 'Translation';
      case 'bilingual-assembly': return 'Assembly';
      case 'video-assembly': return 'Video Assembly';
      case 'audiobook': return 'Audiobook';
      case 'book-analysis': return 'Book Analysis';
      case 'generate-sentences': return 'Generate Sentences';
    }
  }

  private shortProvider(provider: string): string {
    switch (provider) {
      case 'ollama': return 'Ollama';
      case 'claude': return 'Claude';
      case 'openai': return 'OpenAI';
      default: return provider;
    }
  }

  private capitalizeEngine(engine: string): string {
    switch (engine.toLowerCase()) {
      case 'xtts': return 'XTTS';
      case 'orpheus': return 'Orpheus';
      default: return engine.charAt(0).toUpperCase() + engine.slice(1);
    }
  }
}
