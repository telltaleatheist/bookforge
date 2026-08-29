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
  /**
   * The measured throughput — "7.2x realtime (2,040 words/min · 150 sent/min)"
   * — or null until an honest window exists (two progress flushes at least 45s
   * apart; see JobEtaService.rateSample). The redesign dropped this line and
   * Owen missed it within the hour: on a long render the RATE is the number
   * that says whether tonight is going well, not the percentage.
   */
  speed: string | null;
  /** "128 / 1,617" — chunks done over total, when the step counts them. */
  count: string | null;
  /** Ticking elapsed for the step in this lane. Null before it has begun. */
  elapsed: string | null;
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

  /**
   * IS ANYTHING ACTUALLY MOVING, and is there anything left to do — the two
   * questions the Start/Pause control asks, in ONE place because the tray and
   * the queue page both draw that control and must not disagree.
   *
   * Neither is `isRunning`. That is the engine's LATCH: Start sets it, only
   * Pause clears it, so it stays true over a queue that finished everything an
   * hour ago, and the button then offered to "pause" a queue doing nothing.
   * Owen, 2026-08-23: something running → Pause; nothing running but something
   * still to do → Start; nothing to do at all → Start, grayed.
   *
   * `held` counts as something to do, because Start is exactly the gesture that
   * releases it. Finished states do not — a shelf of completed runs is not a
   * queue waiting on a press.
   */
  private readonly stepStatuses = computed<string[]>(() =>
    this.queue.snapshot().jobs.flatMap((job) => job.steps.map((step) => step.status)));

  readonly anythingRunning = computed(() => this.stepStatuses().includes('running'));

  readonly anythingToDo = computed(() =>
    this.stepStatuses().some((s) => s === 'queued' || s === 'waiting' || s === 'held'));

  // ── The bands ────────────────────────────────────────────────────────────

  /** The three slots, always all three. */
  readonly lanes = computed<LaneView[]>(() =>
    benchLanes(this.queue.snapshot()).map((lane) => {
      // The legacy row is the ETA adapter: JobEtaService measures against it.
      const row = lane.occupant
        ? this.queue.jobs().find(r => r.id === lane.occupant!.stepId) ?? null
        : null;
      const seconds = row ? this.eta.etaSeconds(row, stagesFor(row)) : null;
      return {
        ...lane,
        cover: lane.occupant ? this.coverForJobId(lane.occupant.jobId) : null,
        eta: seconds === null ? null : `${formatDuration(seconds)} left`,
        speed: row ? this.eta.speedLabel(row) : null,
        count: row?.totalChunksInJob
          ? `${(row.chunksCompletedInJob ?? 0).toLocaleString()} / ${row.totalChunksInJob.toLocaleString()}`
          : null,
        elapsed: row && row.startedAt ? this.eta.elapsedDisplay(row) : null,
      };
    }));

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
   * TWO stopping gestures, both honest (Owen, 2026-08-29, refining 2026-08-19).
   *
   * 2026-08-19's ruling ("Pause, and MEAN it") made Pause stop the running work
   * too, because the old drain-only pause looked like it did nothing for nine
   * hours while a narration held the card. That fixed the invisibility by
   * deleting the drain — and tonight the drain turned out to be a real gesture
   * with no button: "let this denoise finish, but do not start the next one."
   *
   * So the two acts get two names instead of one button lying about either:
   *  - `pauseAfterCurrent` DRAINS: the engine latch goes off (engine pause()),
   *    running steps finish what they are doing, nothing new claims a slot. The
   *    tray says "Finishing, then pausing" the whole time, which is what the
   *    2026-08-19 complaint was actually about.
   *  - `haltProcessing` takes the card back NOW: latch off AND every running
   *    step cancelled — safe because a stop is resumable by construction
   *    (`held` + `wasInterrupted`; Start resumes from what is already rendered).
   *
   * `stopStep` below stays the narrow act: one step off, engine still claiming.
   */
  async pauseAfterCurrent(): Promise<void> {
    await this.queue.pauseQueue();
  }

  async haltProcessing(): Promise<void> {
    await this.queue.stopQueue();
  }

  async startQueue(): Promise<void> {
    await this.queue.startQueue();
  }

  /**
   * Stop ONE running step, leaving the queue running.
   *
   * The bench used to offer nothing here on the reasoning that Pause covered it
   * (see the two-gesture note above). It does not: "take this book off the card and get on
   * with the next one" was only reachable by pausing everything, and Owen could
   * not find a way to do it at all (2026-08-21). The step keeps what it has
   * rendered and comes back `held`, so Start resumes it from there.
   */
  async stopStep(stepId: string): Promise<void> {
    await this.queue.cancelJob(stepId);
  }

  /** Release one held or stopped step. */
  async startStep(stepId: string): Promise<void> {
    await this.queue.runJobStandalone(stepId);
  }

  /** Release every run in a book's plan, in order. */
  async startPlan(plan: BookPlan): Promise<void> {
    for (const jobId of plan.jobIds) await this.queue.runJobStandalone(jobId);
  }

  /**
   * Take every run in a book's plan out of the queue.
   *
   * Sequential, and NOT wrapped in a catch: if the second run refuses, the
   * caller says so and the first is genuinely gone. Swallowing that would leave
   * the page claiming a book was cancelled while half its chain still ran.
   */
  async cancelPlan(plan: BookPlan): Promise<void> {
    for (const jobId of plan.jobIds) await this.removeRun(jobId);
  }

  /**
   * Move a book's plan to a new place in "Up next" — the drop half of the page's
   * drag and drop.
   *
   * ── Why plans move but the engine only knows runs ──────────────────────────
   *
   * A plan is a GROUP: one book's narrate/enhance/assemble can be spread across
   * several runs, and `bookPlans` gathers them by project. The engine has no
   * such concept — it holds one flat `jobs[]` and claims from it in array order
   * (queue-engine.ts `pump`, `for (const job of jobs)`), so moving a book means
   * moving each of its runs.
   *
   * The target is the FIRST run of whatever plan follows the drop position once
   * the moved plan is lifted out, or `null` when it was dropped last. Every run
   * of the moved plan is then placed before that same target.
   *
   * ── Why repeating one target keeps the book's own order ────────────────────
   *
   * This looks like it should pile the runs up backwards, and it does not.
   * `reorder(job, before)` splices the job in AT the target's index, so the
   * target is pushed one along each time and the second sibling lands between
   * the first and the target — the book's chain comes out in the order it went
   * in. Say it out loud here, because a reader would otherwise "fix" it into a
   * moving target and get the reversal it was written to avoid.
   *
   * A plan can also be INTERLEAVED with another book's runs in `jobs[]` (nothing
   * has ever required a book's runs to be adjacent). Placing every one of them
   * before a single target makes them contiguous, which is what the card that
   * was just dragged claims to be.
   *
   * Sequential, and NOT wrapped in a catch, for `cancelPlan`'s reason: if the
   * second run refuses, the caller says so. The refusal is the engine's own
   * sentence and the first run has genuinely moved.
   */
  async reorderPlans(plans: BookPlan[], previousIndex: number, currentIndex: number): Promise<void> {
    if (previousIndex === currentIndex) return;
    const moved = plans[previousIndex];
    if (moved === undefined) throw new Error('That book is no longer in the queue.');
    const remaining = plans.filter((_, index) => index !== previousIndex);
    // Past the end is a real drop position, not a missing plan: dropped last,
    // there is nothing to go in front of.
    const following = currentIndex < remaining.length ? remaining[currentIndex] : null;
    const beforeJobId = following === null ? null : following.jobIds[0];
    for (const jobId of moved.jobIds) await this.queue.reorderJobsById(jobId, beforeJobId);
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
