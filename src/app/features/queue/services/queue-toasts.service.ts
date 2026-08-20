/**
 * QueueToastsService — the queue, saying what landed.
 *
 * ── What it listens to, and why not the snapshot ────────────────────────────
 *
 * `jobs:step-finished` is the TRANSITION. The snapshot is a state, and a
 * completion read out of a diff of two states fires twice the first time an
 * event is lost and never at all if two land in one flush. The engine emits the
 * transition precisely so this kind of listener does not have to guess.
 *
 * ── What it says ───────────────────────────────────────────────────────────
 *
 * Not every step. A run of narrate → enhance → assemble is ONE piece of news to
 * the user — the audiobook is ready — and three toasts for it is the queue
 * talking about itself. So: the run's LAST step landing, or ANY step failing.
 * A failure is always news, because everything behind it was just cancelled.
 *
 * ── Reading the snapshot at event time ─────────────────────────────────────
 *
 * The engine announces the finish BEFORE it publishes the new snapshot (see
 * `settleStep` — the next step may read what this one wrote, so filing has to
 * have happened first). The mirror therefore still shows the finishing step as
 * running when this runs. That is not a problem to work around, it is the fact
 * to use: "was this the last one" is asked of the OTHER steps, with this one
 * excluded by id.
 */

import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';

import type {
  JobType, QueueJob as EngineJob, QueueNotice, QueueStep as EngineStep,
} from '@shared/queue/engine-types';
import { TERMINAL_STEP_STATUSES } from '@shared/queue/engine-types';
import { JOB_GERUND } from '@shared/queue/job-words';

import { ToastService } from '../../../core/services/toast.service';
import { isStandaloneWindow, shouldAnnounceHere } from '../../../core/window-role';
import { StudioService } from '../../studio/services/studio.service';
import { formatDuration } from './job-eta.service';
import { QueueTrayService } from './queue-tray.service';
import { QueueService } from './queue.service';

/** The engine's step-finished wire shape. Mirrors StepFinished in queue-engine.ts. */
interface StepFinishedEvent {
  jobId: string;
  stepId: string;
  type: JobType;
  label: string;
  projectId?: string;
  success: boolean;
  outputPath?: string;
  error?: string;
}

interface QueueEventBridge {
  onStepFinished(cb: (event: StepFinishedEvent) => void): () => void;
  onNotice(cb: (notice: QueueNotice) => void): () => void;
}

@Injectable({ providedIn: 'root' })
export class QueueToastsService {
  private readonly queue = inject(QueueService);
  private readonly tray = inject(QueueTrayService);
  private readonly toasts = inject(ToastService);
  private readonly studio = inject(StudioService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private started = false;

  /**
   * Begin listening. Called by the shell, once per window.
   *
   * Explicit rather than done in the constructor: a root service is created the
   * first time anything injects it, and a listener whose lifetime is "whenever
   * someone happened to ask for the tray" is a listener nobody owns.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const bridge = (window as unknown as { electron?: { queue?: QueueEventBridge } })
      .electron?.queue;
    if (!bridge) return;

    const stop = bridge.onStepFinished((event) => {
      this.zone.run(() => {
        this.announce(event).catch((err) => {
          // Said out loud. A toast that could not be raised is a bug in this
          // file or in the bridge it asks, and swallowing it would leave the
          // user with an app that silently stops reporting completions.
          console.error('[QUEUE] Could not announce a finished step:', err);
        });
      });
    });
    this.destroyRef.onDestroy(stop);

    /*
     * Work that never became a run at all.
     *
     * `onStepFinished` is news about a step; this is news about a REFUSAL — a
     * Narrate pressed on a Foundry step with nothing exported yet, an Enhance
     * whose settings name no model. It lands here rather than in the shell for
     * the reason everything else about queue news does: the focus rule, the
     * card, and the tone are already decided in one place, and a second toast
     * source in app.ts would be a second set of answers to the same questions.
     */
    const stopNotices = bridge.onNotice((notice) => {
      this.zone.run(() => {
        this.announceNotice(notice).catch((err) => {
          console.error('[QUEUE] Could not announce a queue notice:', err);
        });
      });
    });
    this.destroyRef.onDestroy(stopNotices);
  }

  /**
   * Say one refusal, in the window the user is looking at.
   *
   * No cover and no action, and neither is an omission: main refused before any
   * run existed, so there is no job to draw a cover from and nowhere for a click
   * to go. The sentence itself names what to do — it is composed in main, which
   * is the only side that knows what was wrong.
   */
  private async announceNotice(notice: QueueNotice): Promise<void> {
    if (!(await shouldAnnounceHere())) return;
    this.toasts.show({
      tone: notice.tone,
      kicker: notice.kicker,
      title: notice.title,
      meta: notice.message,
      cover: null,
      action: null,
    });
  }

  private async announce(event: StepFinishedEvent): Promise<void> {
    const job = this.queue.snapshot().jobs.find(j => j.id === event.jobId);
    if (!job) return;

    const wasLast = this.wasTheLastStep(job, event.stepId);
    if (event.success && !wasLast) return;

    // Asked LAST, and asked once: it is a question about the whole app, and
    // asking it for steps this window was never going to speak about would be an
    // IPC round-trip per finished step in every window.
    if (!(await shouldAnnounceHere())) return;

    if (!event.success) {
      this.toasts.show({
        tone: 'failure',
        kicker: 'Run failed',
        title: job.title,
        meta: `${event.label}: ${event.error ?? 'no reason given.'}`,
        cover: this.tray.coverForJobId(job.id),
        action: this.openAction(job),
      });
      return;
    }

    this.toasts.show({
      tone: 'success',
      kicker: `Finished ${JOB_GERUND[event.type].toLowerCase()}`,
      title: job.title,
      meta: this.successMeta(job, event),
      cover: this.tray.coverForJobId(job.id),
      action: this.openAction(job),
    });
  }

  /**
   * Was this the run's final step?
   *
   * Every OTHER step is already terminal. `held` counts as not-terminal on
   * purpose: a run with a held step still has work in it that the user composed
   * and can release, so the run is not over and saying it is would be wrong the
   * moment they press Start.
   */
  private wasTheLastStep(job: EngineJob, stepId: string): boolean {
    return job.steps
      .filter((step: EngineStep) => step.id !== stepId)
      .every((step: EngineStep) => TERMINAL_STEP_STATUSES.has(step.status));
  }

  private successMeta(job: EngineJob, event: StepFinishedEvent): string {
    const parts: string[] = [];
    if (job.startedAt) {
      const elapsed = Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000);
      parts.push(`Took ${formatDuration(elapsed)}`);
    }
    if (event.outputPath) {
      parts.push(event.outputPath.split(/[\\/]/).pop()!);
    }
    if (job.projectId && !isStandaloneWindow()) parts.push('click to open');
    return parts.join(' · ');
  }

  /**
   * Clicking the toast opens the book's versions page.
   *
   * Only in the main window: a Listen or alignment popup has no Studio to
   * navigate, and routing one away from the thing it was opened for would
   * destroy what the user was doing. Those windows show the news without a
   * destination rather than a destination that misbehaves.
   */
  private openAction(job: EngineJob): { label: string; run: () => void } | null {
    const projectId = job.projectId;
    if (!projectId || isStandaloneWindow()) return null;
    return {
      label: 'click to open',
      run: () => {
        this.studio.requestOpen(projectId);
        void this.router.navigate(['/studio']);
      },
    };
  }
}
