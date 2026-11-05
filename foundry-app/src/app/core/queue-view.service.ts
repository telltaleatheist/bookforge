import { Injectable, computed, inject, signal } from '@angular/core';

import { typeLabel } from '@owen/foundry-core/shared/documents';
import { fold } from '@owen/foundry-core/shared/original';
import {
  CPU_LANE_SLOTS, JOB_RESOURCE, LANES, computeLanes, laneOf, laneOfRun, slotOfLane,
  type ComputeLane, type JobResource, type Lane,
} from '@owen/foundry-core/shared/queue-board';
import type { ComputeSlot, ComputeSlotKind, SlotRefusal } from '@owen/foundry-core/shared/slots';
import type { Job, JobProgress } from '@owen/foundry-core/shared/types';

import { OpenDocumentsService } from './documents.service';
import { NoticeService } from './notice.service';
import { ProjectsService } from './projects.service';
import { QueueEtaService } from './queue-eta.service';
import { QueueService } from './queue.service';
import { api } from './foundry';
import { StageBar } from './queue-view.model';
export type { BoardSection, SlotView, StageBar, BookGroup } from './queue-view.model';
import * as boarding from './queue-view.board';
import * as wording from './queue-view.words';

/**
 * THE QUEUE AS IT IS DRAWN — one description of the board, read by both surfaces
 * that draw it.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * Every sentence in here used to be a protected method on the queue shelf, which
 * was fine while the shelf was the only place a job was ever shown. Owen asked
 * for two places (his ruling is quoted in full at the head of the queue bar):
 * a dropdown you click open from the top-right corner, and a whole page behind a
 * *More info* button. Two surfaces onto one queue is exactly the arrangement
 * BookForge landed on — its tray and its queue page both read one service, and
 * its own note about that is the argument for this one: *"Both read
 * `shared/queue/bench.ts` now, so there is one description of the queue and one
 * set of words for it."* Before that they *"spoke different dialects"*.
 *
 * So the shelf's own answers moved here rather than being copied into two
 * components. Copying them would have been a drift machine with a two-week fuse:
 * the day somebody fixes the failure sentence, or teaches `made()` a new kind, or
 * changes which lane the aggregate bar follows, they fix it in the surface they
 * happened to have open and the other one goes on saying the old thing. A queue
 * that says two different things about one job in two places is worse than
 * either sentence alone, because now the user has to work out which to believe.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not a second queue. `QueueService` is the mirror of main's list and this
 * reads it; nothing here writes a job, guesses a state, or holds anything of its
 * own between renders. Every computed below is a pure function of
 * `queue.jobs()`, and the three methods that DO something (`open`, `reveal`,
 * `saveCopy`) are the same one-line hand-offs the shelf made — they are here
 * because they belong to a row, and a row is drawn in two places now.
 *
 * It is also not a scheduler. The lanes, the slot counts and the resource of
 * each kind are `shared/queue-board.ts` — the same table `electron/job-queue.ts`
 * rations by — read and never second-guessed, so the lane a row is DRAWN in
 * cannot disagree with the lane the pump holds it against.
 */
@Injectable({ providedIn: 'root' })
export class QueueViewService {
  readonly queue = inject(QueueService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly notices = inject(NoticeService);
  /** Only ever asked what a book is called, and what it filed. See `label`. */
  readonly projects = inject(ProjectsService);
  /**
   * HOW MUCH LONGER, measured in this window from the counts as they arrive.
   *
   * It is injected here rather than into the two surfaces for this file's whole
   * reason: the queue is drawn in two places, and an estimate they worked out
   * separately would be two forecasts about one job that a person has to choose
   * between. One measurement, one wording, read by both.
   */
  readonly eta = inject(QueueEtaService);

  /**
   * WHERE COMPUTE-HEAVY WORK MAY GO — the slot list, read once.
   *
   * ── Why the service holds it rather than each surface ─────────────────────
   *
   * This file's whole argument, applied to one more fact: the bench draws a card
   * per machine, the queue page draws a picker out of the same names, and the
   * chip counts the cards. Three reads of `slots:list` would be three answers
   * that can differ for a frame, and the one that differed would be the one
   * somebody was looking at.
   *
   * ONCE, AND NOT ON A TIMER. It is a settings fact — it changes when somebody
   * edits the Servers card, which is a different screen — and a queue that
   * re-read it on a clock would repaint the board for nothing.
   *
   * THE LIST ARRIVING LATE IS WHY {@link slotsRead} EXISTS. An empty list used to
   * mean one lane — the local one — so the bench before the read landed was the
   * bench a person with no Crucible saw forever, and drawing it early cost
   * nothing. Since Wave 66 an empty list means NO GPU lane (Owen: *"there should
   * be no local gpu listed in the queue"*), and the sentence that goes with it
   * tells somebody to add an engine. Saying that for a frame to a person who has
   * three would be the board being confidently wrong about itself.
   */
  readonly computeSlots = signal<ComputeSlot[]>([]);

  /**
   * HAS `slots:list` ANSWERED YET — the difference between "no engines" and "not
   * asked yet", which is only interesting because the two want different
   * sentences. See {@link computeSlots}.
   */
  private readonly slotsRead = signal(false);

  /**
   * WHY THERE IS NO PICKER, when the answer is not "nobody added a server".
   *
   * Null is the ordinary case and draws nothing. A sentence here is a hosted
   * window whose host offers no registry: the board is not broken and every
   * job still runs, but the person is owed the difference between a list they
   * have not filled in and a list nothing could ask for.
   */
  readonly slotRefusal = signal<SlotRefusal | null>(null);

  /**
   * THE ORDINARY EMPTY BOARD, IN ONE SENTENCE — or the empty string, which is
   * every window that has an engine and every window that has not asked yet.
   *
   * ── Why this is a sentence and not simply an absence of cards ─────────────
   *
   * Because until Wave 66 there was always a GPU card: this machine's own, called
   * "This computer". Owen deleted it — *"everything goes through a crucible server
   * now, including local… there should be no local gpu listed in the queue"* — so
   * a person with no engine registered now opens this page and finds the GPU side
   * of the bench empty. Drawing nothing would leave them looking for the card
   * they had yesterday; this says where it went and what to press, in the same
   * words the placement refuses a job with (`noEngineReason`,
   * electron/crucible-dispatch.ts).
   *
   * IT IS NOT DRAWN WHEN THE HOST HAS ALREADY EXPLAINED ITSELF: `slotRefusal` is
   * a different and more specific silence, and the page prefers it (the two are
   * one `@if`/`@else if`). Nor before the read lands — see {@link computeSlots}.
   */
  readonly noEngineNote = computed(() => (
    this.slotsRead() && this.computeSlots().length === 0
      ? 'No GPU engine is connected, so there is nowhere to translate, simplify, clean, analyse '
        + 'or read pages. Add one in Settings › Servers. Exports and compiles run here as always.'
      : ''
  ));

  /**
   * THE GPU SIDE OF THE BOARD — one lane per machine, derived from the list.
   *
   * The same `computeLanes` the scheduler rations by (electron/job-queue.ts), so
   * the number of cards drawn here and the number of runs main will actually
   * start are one fact rather than two that agree until somebody edits one.
   */
  readonly lanes = computed<ComputeLane[]>(() => computeLanes(this.computeSlots()));

  constructor() {
    if (api === null) return;
    void api.slots.list().then((answer) => {
      this.computeSlots.set(answer.slots);
      this.slotRefusal.set(answer.refusal);
      this.slotsRead.set(true);
    });
  }

  /**
   * WHAT THE CHIP MEASURES — the GPU side's first run, or the first one going.
   *
   * The bar has room for one fraction and the board can be running several jobs
   * (two CPU, and one per machine), so the choice has to be made somewhere and
   * this is where. The GPU work wins because it is what costs hours: a person
   * glancing at the corner is asking how the reading is getting on, and a bar
   * that tracked a thirty-second compile would answer a question nobody asked
   * and then jump back. Null when nothing is running at all, which is what draws
   * the ✓ or the ! in the chip.
   *
   * IT DOES NOT SAY WHICH MACHINE and does not need to: the chip is one line
   * about the whole board, and the bench is where the machines are drawn.
   */
  readonly leading = computed(() => {
    const active = this.queue.runningJobs();
    return active.find((job) => laneOf(job.kind) === 'gpu') ?? active[0] ?? null;
  });

  readonly headline = boarding.headline.call(this);

  readonly board = boarding.board.call(this);

  readonly slots = boarding.slots.call(this);

  waitingFor(name: string): string { return boarding.waitingFor.call(this, name); }

  readonly busySlots = boarding.busySlots.call(this);

  readonly waitingBooks = boarding.waitingBooks.call(this);

  occupancy(lane: Lane): string { return boarding.occupancy.call(this, lane); }

  /** What the Start button says to a screen reader, and on hover. */
  readonly startLabel = computed(() => {
    const held = this.queue.held().length;
    if (held === 0) return 'Nothing is waiting to start';
    return held === 1 ? 'Start the 1 job waiting' : `Start the ${held} jobs waiting`;
  });

  /** True when the bar has a real fraction behind it. */
  determinate(job: Job): boolean {
    return (job.progress?.total ?? 0) > 0;
  }

  percent(job: Job): number {
    const p = job.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.page / p.total) * 100));
  }

  stepLine(job: Job): string { return wording.stepLine.call(this, job); }

  stageBars(job: Job): StageBar[] | null { return wording.stageBars.call(this, job); }

  timeLeft(job: Job): string { return wording.timeLeft.call(this, job); }

  stepDetail(job: Job, room?: Parameters<typeof wording.stepDetail>[1]): string { return wording.stepDetail.call(this, job, room); }

  label(job: Job): string { return wording.label.call(this, job); }

  made(job: Job): string { return wording.made.call(this, job); }

  spent(job: Job): string { return wording.spent.call(this, job); }

  spentDetail(job: Job): string { return wording.spentDetail.call(this, job); }

  filed(job: Job): boolean { return wording.filed.call(this, job); }

  paths(job: Job): string { return wording.paths.call(this, job); }

  failureLine(error: string | undefined): string { return wording.failureLine.call(this, error); }

  reveal(job: Job): void {
    void api?.reveal(job.outputPath);
  }

  /** The OS save dialog over the export — a copy in the hand, not a hunt. */
  async saveCopy(job: Job): Promise<void> {
    try {
      await api?.saveExport(job.outputPath);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Open a finished conversion in a tab.
   *
   * `managed: true` — the book is still only in the workspace, so the tab gets
   * the unsaved dot. Re-opening one that is already open just focuses its tab
   * (OpenDocumentsService), so this button is safe to press twice.
   */
  open(job: Job): void {
    void this.documents.openFile(job.outputPath, true);
  }
}
