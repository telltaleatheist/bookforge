/**
 * QueueTrayService — what the chip and the tray DRAW.
 *
 * The queue's truth is main's, mirrored read-only by QueueService. This turns
 * that mirror into the small vocabulary the top-bar chip and its dropdown speak:
 * a verb for what is happening, a cover, a per-step state, a right-hand column
 * that is either a percentage or a word.
 *
 * It is a VIEW MODEL and nothing else. No IPC of its own beyond loading cover
 * thumbnails, no state that is not derived from the mirror, and no scheduling
 * opinion — every action the tray offers goes back through QueueService, which
 * goes back to main.
 *
 * ── Why a service and not computeds on the component ────────────────────────
 *
 * The chip is mounted in every window's title bar and the tray is mounted under
 * it, opened and closed constantly. Cover thumbnails are read off disk through
 * IPC, so a component-local cache would re-read every cover each time the tray
 * opened. The cache belongs to the window, which is what a root service is.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import type { JobType, QueueJob as EngineJob, QueueStep as EngineStep, StepStatus } from '@shared/queue/engine-types';
import { TERMINAL_STEP_STATUSES, jobStatus } from '@shared/queue/engine-types';

import { ElectronService } from '../../../core/services/electron.service';
import { LibraryService } from '../../../core/services/library.service';
import type { AudiobookMetadata } from '../models/queue.types';
import { stagesFor } from '../models/job-stages';
import { JobEtaService, formatDuration } from './job-eta.service';
import { QueueService } from './queue.service';

/**
 * What each job type is DOING while it runs, as a sentence fragment.
 *
 * Exhaustive by construction: `Record<JobType, string>` refuses to compile when
 * a job type is added without a word for it, which is the point. A default here
 * would put "Processing" in the title bar of an app whose whole readout is
 * supposed to say what is actually happening.
 */
export const JOB_GERUND: Record<JobType, string> = {
  'tts-conversion': 'Narrating',
  'translation': 'Translating',
  'rvc-enhancement': 'Enhancing',
  'reassembly': 'Assembling',
  'bilingual-cleanup': 'Cleaning',
  'bilingual-translation': 'Translating',
  'bilingual-assembly': 'Assembling',
  'video-assembly': 'Rendering',
  'book-analysis': 'Analysing',
  'generate-sentences': 'Transcribing',
  'simplify': 'Simplifying',
  'translate-pass': 'Translating',
  'footnote-refs': 'Cleaning',
  'vlm-convert': 'Reading',
};

/** What a finished job of this type produced — the tray card's kicker. */
export const JOB_PRODUCT: Record<JobType, string> = {
  'tts-conversion': 'Narration',
  'translation': 'Translation',
  'rvc-enhancement': 'Voice enhancement',
  'reassembly': 'Audiobook',
  'bilingual-cleanup': 'Bilingual cleanup',
  'bilingual-translation': 'Bilingual translation',
  'bilingual-assembly': 'Bilingual audiobook',
  'video-assembly': 'Video',
  'book-analysis': 'Book analysis',
  'generate-sentences': 'Sentences',
  'simplify': 'Simplified text',
  'translate-pass': 'Translated text',
  'footnote-refs': 'Footnote clean-up',
  'vlm-convert': 'EPUB conversion',
};

/** One step row inside a tray card. */
export interface TrayStepView {
  id: string;
  /** The step's own heading — "Narrate with Leah". */
  name: string;
  status: StepStatus;
  /** 0-100. A done step is 100; a step that never ran is 0. */
  percent: number;
  /** The right-hand column: a percentage while running, a word otherwise. */
  right: string;
  running: boolean;
  /** A dashed, hollow dot: released-but-waiting, or held. */
  idle: boolean;
}

/** One job card in the tray. */
export interface TrayJobView {
  id: string;
  title: string;
  /** "Audiobook · 2 steps", or "held · 1 step · not started". */
  kicker: string;
  /** A data URI, or null when the project has no cover (or has not one yet). */
  cover: string | null;
  /** ETA while running, queue position while waiting, "▶ Start" while held. */
  right: string;
  status: StepStatus;
  held: boolean;
  steps: TrayStepView[];
}

/** The one-line summary under the cards. */
export interface TrayFinishedSummary {
  /** How many runs ended today, however they ended. */
  count: number;
  /** The titles of the ones that failed, in order. Empty when all went well. */
  failed: string[];
}

/** What the chip says. */
export interface ChipView {
  /** 'running' | 'pending' | 'empty' — the chip's three forms. */
  state: 'running' | 'pending' | 'empty';
  /** "Narrating" — the running step's verb. Empty unless running. */
  verb: string;
  /** The book, as the user knows it. Empty unless running. */
  title: string;
  /** The running STEP's percentage, which is what the verb names. */
  percent: number;
  cover: string | null;
  /** Runs composed or released but not yet running. */
  pending: number;
}

/** A step nobody is waiting on any more. */
function terminal(step: EngineStep): boolean {
  return TERMINAL_STEP_STATUSES.has(step.status);
}

/** "1st", "2nd", "3rd", "11th"… */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  if (rem10 === 1) return `${n}st`;
  if (rem10 === 2) return `${n}nd`;
  if (rem10 === 3) return `${n}rd`;
  return `${n}th`;
}

/** The right-hand word for a step that is not running. */
function stepWord(step: EngineStep): string {
  switch (step.status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'skipped';
    case 'waiting': return 'waiting';
    case 'queued': return 'queued';
    case 'held': return step.wasInterrupted ? 'stopped' : 'held';
    case 'running': return `${Math.round(step.progress.percent ?? 0)}%`;
  }
}

function stepPercent(step: EngineStep): number {
  if (step.status === 'done') return 100;
  return Math.round(step.progress.percent ?? 0);
}

@Injectable({ providedIn: 'root' })
export class QueueTrayService {
  private readonly queue = inject(QueueService);
  private readonly eta = inject(JobEtaService);
  private readonly electron = inject(ElectronService);
  private readonly library = inject(LibraryService);

  /** Cover thumbnails by LIBRARY-RELATIVE path. One read per cover per window. */
  private readonly covers = signal<Record<string, string>>({});
  private readonly coversAsked = new Set<string>();

  /** Is the tray open? Owned here so the chip and the panel agree. */
  readonly open = signal(false);

  readonly isRunning = computed(() => this.queue.isRunning());

  /** Runs that have not ended, in the engine's order. */
  private readonly liveJobs = computed(() =>
    this.queue.snapshot().jobs.filter((job) => {
      const status = jobStatus(job);
      return status !== 'done' && status !== 'failed' && status !== 'cancelled';
    }));

  private readonly runningJob = computed(() =>
    this.liveJobs().find(job => job.steps.some(s => s.status === 'running')) ?? null);

  readonly chip = computed<ChipView>(() => {
    const running = this.runningJob();
    // Runs that are NOT running. Counted off the job status rather than off "is
    // it the one the chip names", because the pools admit three steps at once
    // (one GPU, two CPU) and calling a second RUNNING job pending would report
    // work that is happening as work that is waiting.
    const pending = this.liveJobs().filter(job => jobStatus(job) !== 'running').length;

    if (!running) {
      return {
        state: pending > 0 ? 'pending' : 'empty',
        verb: '', title: '', percent: 0, cover: null, pending,
      };
    }
    const step = running.steps.find(s => s.status === 'running')!;
    return {
      state: 'running',
      verb: JOB_GERUND[step.type],
      title: running.title,
      percent: stepPercent(step),
      cover: this.coverFor(running),
      pending,
    };
  });

  /** The cards, running first, then released, then held — the engine's order within each. */
  readonly jobs = computed<TrayJobView[]>(() => {
    const live = this.liveJobs();
    // Queue position is counted over the runs that are RELEASED and waiting for a
    // slot. A held run is not in line at all — nothing will pick it up — so
    // numbering it would promise a turn it is not waiting for.
    const inLine = live.filter((job) => {
      const status = jobStatus(job);
      return status === 'queued' || status === 'waiting';
    });

    const rank = (job: EngineJob): number => {
      const status = jobStatus(job);
      if (status === 'running') return 0;
      if (status === 'held') return 2;
      return 1;
    };

    return [...live]
      .sort((a, b) => rank(a) - rank(b))
      .map(job => this.cardFor(job, inLine.indexOf(job)));
  });

  readonly finished = computed<TrayFinishedSummary>(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = this.queue.snapshot().jobs.filter((job) => {
      if (!job.finishedAt) return false;
      return new Date(job.finishedAt).getTime() >= startOfDay.getTime();
    });
    return {
      count: today.length,
      failed: today.filter(job => jobStatus(job) === 'failed').map(job => job.title),
    };
  });

  toggle(): void {
    this.open.update(v => !v);
  }

  close(): void {
    this.open.set(false);
  }

  // ── Cards ────────────────────────────────────────────────────────────────

  private cardFor(job: EngineJob, linePosition: number): TrayJobView {
    const status = jobStatus(job);
    const held = status === 'held';
    const steps = job.steps.map(step => this.stepFor(step));

    const last = job.steps[job.steps.length - 1];
    const count = `${job.steps.length} step${job.steps.length === 1 ? '' : 's'}`;
    const kicker = held
      ? `held · ${count} · ${job.steps.some(s => s.wasInterrupted) ? 'stopped' : 'not started'}`
      : `${JOB_PRODUCT[last.type]} · ${count}`;

    return {
      id: job.id,
      title: job.title,
      kicker,
      cover: this.coverFor(job),
      right: this.rightFor(job, status, linePosition),
      status,
      held,
      steps,
    };
  }

  private stepFor(step: EngineStep): TrayStepView {
    const running = step.status === 'running';
    return {
      id: step.id,
      name: step.label,
      status: step.status,
      percent: stepPercent(step),
      right: stepWord(step),
      running,
      idle: !running && !terminal(step),
    };
  }

  /**
   * The card's right-hand line.
   *
   * A running card shows the ETA of the step that is running — the only measured
   * number there is. It is deliberately NOT a whole-run estimate: the steps
   * behind the running one have never been timed on this book, and adding a
   * guess to a measurement produces a number that looks measured. A held card
   * shows nothing here (the Start control takes the slot); a released one shows
   * where it is in line.
   */
  private rightFor(job: EngineJob, status: StepStatus, linePosition: number): string {
    if (status === 'running') {
      const step = job.steps.find(s => s.status === 'running')!;
      const row = this.queue.jobs().find(r => r.id === step.id);
      if (!row) return '';
      const seconds = this.eta.etaSeconds(row, stagesFor(row));
      return seconds === null ? this.eta.etaDisplay(row, stagesFor(row)) : `${formatDuration(seconds)} left`;
    }
    if (status === 'held') return '';
    return linePosition >= 0 ? `${ordinal(linePosition + 1)} in line` : '';
  }

  // ── Covers ───────────────────────────────────────────────────────────────

  /**
   * The project's cover, as a data URI, or null.
   *
   * The path a run carries is ABSOLUTE (it was built for the assembler, which
   * writes it into the M4B), and the media door reads LIBRARY-RELATIVE paths —
   * so the library root is taken off the front. A cover outside the library is
   * not a cover this can show, and it shows none rather than a stand-in.
   */
  private coverFor(job: EngineJob): string | null {
    const relative = this.coverRelPath(job);
    if (!relative) return null;
    const loaded = this.covers()[relative];
    if (loaded) return loaded;
    this.requestCover(relative);
    return null;
  }

  private coverRelPath(job: EngineJob): string | null {
    const root = this.library.libraryPath();
    if (!root) return null;
    for (const step of job.steps) {
      const metadata = (step.config as { metadata?: AudiobookMetadata }).metadata;
      const absolute = metadata?.coverPath;
      if (!absolute) continue;
      const normalized = absolute.replace(/\\/g, '/');
      const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
      if (!normalized.startsWith(prefix)) continue;
      return normalized.slice(prefix.length);
    }
    return null;
  }

  private requestCover(relative: string): void {
    if (this.coversAsked.has(relative)) return;
    this.coversAsked.add(relative);
    void this.electron.mediaLoadImage(relative, 120).then((result) => {
      if (result.success && result.data) {
        this.covers.update(map => ({ ...map, [relative]: result.data! }));
      }
    });
  }

  // ── What the tray's controls do ──────────────────────────────────────────

  async toggleQueue(): Promise<void> {
    if (this.queue.isRunning()) await this.queue.pauseQueue();
    else await this.queue.startQueue();
  }

  async startJob(jobId: string): Promise<void> {
    await this.queue.runJobStandalone(jobId);
  }

  async clearFinished(): Promise<void> {
    await this.queue.clearCompleted();
  }
}
