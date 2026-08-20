/**
 * QueueTrayService — what the chip and the shelf DRAW.
 *
 * The queue's truth is main's, mirrored read-only by QueueService. The STRUCTURE
 * of what is drawn — which slot holds what, and why every other row is still —
 * is derived by `shared/queue/bench.ts`, which is pure and keeper-tested and
 * shared with main. This service is what remains once that is taken out: the
 * decoration only a renderer can add (cover thumbnails read over IPC, measured
 * ETAs held by JobEtaService) and the small vocabulary the chip speaks.
 *
 * It is a VIEW MODEL and nothing else. No scheduling opinion — every action the
 * shelf offers goes back through QueueService, which goes back to main.
 *
 * ── Why a service and not computeds on the component ────────────────────────
 *
 * The chip is mounted in every window's title bar and the shelf is mounted under
 * it, opened and closed constantly. Cover thumbnails are read off disk through
 * IPC, so a component-local cache would re-read every cover each time the shelf
 * opened. The cache belongs to the window, which is what a root service is.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import type { QueueJob as EngineJob, StepStatus } from '@shared/queue/engine-types';
import { jobStatus } from '@shared/queue/engine-types';
import {
  benchLanes,
  bookPlans,
  finishedSince,
  needsYou,
  startOfDay,
  upNext,
  type BenchLane,
  type BookPlan,
  type FailedRun,
  type FinishedRun,
  type StillStep,
} from '@shared/queue/bench';

import { ElectronService } from '../../../core/services/electron.service';
import { LibraryService } from '../../../core/services/library.service';
import type { AudiobookMetadata } from '../models/queue.types';
import { stagesFor } from '../models/job-stages';
import { JobEtaService, formatDuration } from './job-eta.service';
import { QueueService } from './queue.service';

/** A bench lane, plus the decoration only this side can supply. */
export interface LaneView extends BenchLane {
  /** A data URI, or null when the project has no cover (or has not one yet). */
  cover: string | null;
  /**
   * The MEASURED time left for the step in this lane — "1h 04m left" — or null.
   *
   * Null is not "unknown, show a spinner": it means nothing has been measured
   * yet, and the lane says so in words rather than showing a number that would
   * look measured. There is deliberately no whole-RUN estimate anywhere in this
   * file; see `QueueTrayService` docs and the design note on the page.
   */
  eta: string | null;
}

/** A still row, plus its book's cover. */
export interface StillRowView extends StillStep {
  cover: string | null;
}

/** A failure, plus its book's cover. */
export interface FailedView extends FailedRun {
  cover: string | null;
}

/** A book's plan, plus its cover. */
export interface BookPlanView extends BookPlan {
  cover: string | null;
}

/** The one-line summary under the shelf's cards. */
export interface FinishedSummary {
  /** How many steps ended today, however they ended. */
  count: number;
  /** The titles of the ones that failed, in order. Empty when all went well. */
  failed: string[];
  /** The books that finished, in order, deduplicated — for the summary line. */
  titles: string[];
}

/** What the chip says. */
export interface ChipView {
  /**
   * The chip's four forms. `blocked` is new and is the one that earns its keep:
   * a queue holding work off a card somebody else is using looks EXACTLY like an
   * idle queue from the outside, and that is the state a user is most likely to
   * misread as a hang.
   */
  state: 'running' | 'blocked' | 'pending' | 'empty';
  /** "Narrating" — the running step's verb. Empty unless running. */
  verb: string;
  /** The book, as the user knows it. Empty unless running. */
  title: string;
  /** The running STEP's percentage, which is what the verb names. Null when unmeasured. */
  percent: number | null;
  cover: string | null;
  /** Runs composed or released but not yet running. */
  pending: number;
  /** Failures waiting for a decision. Drawn as a red badge. */
  failed: number;
  /** Why work is being held off the card, when it is. Empty otherwise. */
  hold: string;
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

  /** Is the shelf open? Owned here so the chip and the panel agree. */
  readonly open = signal(false);

  readonly isRunning = computed(() => this.queue.isRunning());

  // ── The bands ────────────────────────────────────────────────────────────

  /** The three slots, always all three. */
  readonly lanes = computed<LaneView[]>(() =>
    benchLanes(this.queue.snapshot()).map(lane => ({
      ...lane,
      cover: lane.occupant ? this.coverForJobId(lane.occupant.jobId) : null,
      eta: lane.occupant ? this.etaFor(lane.occupant.stepId) : null,
    })));

  /** Failures, each with the sentence the engine wrote. */
  readonly failures = computed<FailedView[]>(() =>
    needsYou(this.queue.snapshot()).map(run => ({
      ...run,
      cover: this.coverForJobId(run.jobId),
    })));

  /** Everything waiting, flat, in engine order — the shelf's shape. */
  readonly waiting = computed<StillRowView[]>(() =>
    upNext(this.queue.snapshot()).map(row => ({
      ...row,
      cover: this.coverForJobId(row.jobId),
    })));

  /** Everything waiting, grouped by book with chains intact — the page's shape. */
  readonly plans = computed<BookPlanView[]>(() =>
    bookPlans(this.queue.snapshot()).map(plan => ({
      ...plan,
      cover: this.coverForJobId(plan.jobIds[0]),
    })));

  /** What finished today, newest first. */
  readonly finishedToday = computed<FinishedRun[]>(() =>
    finishedSince(this.queue.snapshot(), startOfDay(Date.now())));

  readonly finished = computed<FinishedSummary>(() => {
    const runs = this.finishedToday();
    const titles: string[] = [];
    for (const run of runs) if (!titles.includes(run.title)) titles.push(run.title);
    return {
      count: runs.length,
      failed: runs.filter(r => r.status === 'failed').map(r => r.title),
      titles,
    };
  });

  // ── The chip ─────────────────────────────────────────────────────────────

  readonly chip = computed<ChipView>(() => {
    const lanes = this.lanes();
    const snapshot = this.queue.snapshot();
    const live = snapshot.jobs.filter((job) => {
      const status = jobStatus(job);
      return status !== 'done' && status !== 'failed' && status !== 'cancelled';
    });
    // Runs that are NOT running. Counted off the job status rather than off "is
    // it the one the chip names", because the pools admit three steps at once
    // and calling a second RUNNING job pending would report work that is
    // happening as work that is waiting.
    const pending = live.filter(job => jobStatus(job) !== 'running').length;
    const failed = this.failures().length;

    // The GPU lane leads the chip. Not because CPU work does not matter, but
    // because the card is the resource the user schedules their day around —
    // and when it is held off, saying so is the whole point of the chip.
    const gpu = lanes[0];
    if (gpu.occupant) {
      return {
        state: 'running',
        verb: gpu.occupant.verb,
        title: gpu.occupant.title,
        percent: gpu.occupant.percent,
        cover: gpu.cover,
        pending, failed, hold: '',
      };
    }
    if (gpu.hold) {
      return {
        state: 'blocked',
        verb: '', title: '', percent: null, cover: null,
        pending, failed, hold: gpu.hold,
      };
    }

    // Nothing on the card. A CPU step still counts as the queue working, and
    // saying "Queue" beside a running conversion would be a readout denying
    // what it can see.
    const cpu = lanes.find(lane => lane.occupant !== null);
    if (cpu?.occupant) {
      return {
        state: 'running',
        verb: cpu.occupant.verb,
        title: cpu.occupant.title,
        percent: cpu.occupant.percent,
        cover: cpu.cover,
        pending, failed, hold: '',
      };
    }

    return {
      state: pending > 0 ? 'pending' : 'empty',
      verb: '', title: '', percent: null, cover: null,
      pending, failed, hold: '',
    };
  });

  toggle(): void {
    this.open.update(v => !v);
  }

  close(): void {
    this.open.set(false);
  }

  // ── Measurement ──────────────────────────────────────────────────────────

  /**
   * The measured time left for one running step, or null.
   *
   * Reads through the mirror's legacy row because that is what JobEtaService
   * measures against — it holds a throughput sample per step id, taken when a
   * chunk completes and HELD between completions, which is the arithmetic that
   * keeps speed and ETA from disagreeing. Nothing about that belongs here.
   *
   * There is no equivalent for a whole run, deliberately. The steps behind the
   * running one have never been timed on this book, so summing a measurement
   * with a guess would produce a number that looks measured.
   */
  private etaFor(stepId: string): string | null {
    const row = this.queue.jobs().find(r => r.id === stepId);
    if (!row) return null;
    const seconds = this.eta.etaSeconds(row, stagesFor(row));
    return seconds === null ? null : `${formatDuration(seconds)} left`;
  }

  /** What a lane's step is saying about itself while a percentage cannot move. */
  detailFor(lane: LaneView): string {
    return lane.occupant?.detail ?? lane.occupant?.message ?? '';
  }

  // ── Covers ───────────────────────────────────────────────────────────────

  /**
   * A run's cover, by run id. Public because the completion toasts want the
   * same thumbnail this window has already read, and reading it twice would be
   * two IPC round-trips for one image.
   */
  coverForJobId(jobId: string): string | null {
    const job = this.queue.snapshot().jobs.find(j => j.id === jobId);
    return job ? this.coverFor(job) : null;
  }

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

  // ── What the shelf's controls do ─────────────────────────────────────────
  //
  // Every one of these is a sentence sent to main. The shelf can now do
  // everything the page can — stop what is running, start what is held, retry
  // what failed, remove what is unwanted — because a status readout whose every
  // control is "go and look somewhere else" is a status readout with an exit
  // link, which is what the old one was.

  /**
   * Pause, and MEAN it — Owen's ruling, 2026-08-19.
   *
   * Pause used to stop the queue CLAIMING work while leaving the running step
   * going, which meant pressing it while a nine-hour narration held the card did
   * nothing you could see for nine hours. It now stops the work as well, which
   * is safe because a stop is resumable by construction: cancelling a running
   * step settles it `held` + `wasInterrupted`, so Start picks it up from what is
   * already rendered rather than from sentence zero.
   *
   * That is also why there is no separate Stop control anywhere: with Pause
   * stopping the run, a second button would be the same act under two names.
   */
  async toggleQueue(): Promise<void> {
    if (this.queue.isRunning()) await this.queue.stopQueue();
    else await this.queue.startQueue();
  }

  /** Release one held or stopped step. */
  async startStep(stepId: string): Promise<void> {
    await this.queue.runJobStandalone(stepId);
  }

  /** Release every run in a book's plan, in order. */
  async startPlan(plan: BookPlan): Promise<void> {
    for (const jobId of plan.jobIds) await this.queue.runJobStandalone(jobId);
  }

  async retryStep(stepId: string): Promise<void> {
    this.eta.forget(stepId);
    await this.queue.retryJob(stepId);
  }

  async removeRun(jobId: string): Promise<void> {
    this.eta.forget(jobId);
    await this.queue.removeJob(jobId);
  }

  async clearFinished(): Promise<void> {
    await this.queue.clearCompleted();
  }
}
