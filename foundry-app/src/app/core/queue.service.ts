import { Injectable, computed, signal } from '@angular/core';

import type { AnalyzeRequest, CleanRequest, Job, JobRequest, TextPassRequest } from '@shared/types';

import { api } from './foundry';

/**
 * The renderer's MIRROR of main's queue.
 *
 * Every mutation is an IPC call and every update arrives as a whole list from
 * main — this class never edits a job. Optimistic local state would be a second
 * opinion about a process this window does not own.
 */
@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly all = signal<Job[]>([]);

  readonly jobs = this.all.asReadonly();

  /**
   * EVERY RUN ON THE MACHINE, because there can be three of them.
   *
   * The queue is a board of slots since Wave 35 — one GPU, two CPU
   * (shared/queue-board.ts) — so "what is running" stopped being a single row
   * the day the lanes landed. Everything that draws the board reads this; the
   * one below it is what the collapsed pill still needs.
   */
  readonly runningJobs = computed(() => this.all().filter((job) => job.state === 'running'));
  /**
   * ONE run, for the surfaces that have room for exactly one: the pill's
   * spinner and its aggregate bar. The FIRST in queue order, which is what it
   * has always been — the shelf picks the lane it prefers for the bar itself,
   * because that is a drawing decision and this is a mirror.
   */
  readonly running = computed(() => this.all().find((job) => job.state === 'running') ?? null);
  readonly queued = computed(() => this.all().filter((job) => job.state === 'queued'));
  /**
   * Waiting for the USER, not for the machine — what Start releases.
   *
   * The distinction the shelf is built around: `queued` is a job behind a
   * running one and `held` is a job behind a decision, and a person looking at
   * a still queue needs to know which of the two they are looking at before
   * they can tell a batch they have not committed from an app that has hung.
   */
  readonly held = computed(() => this.all().filter((job) => job.state === 'held'));
  readonly active = computed(() => this.all().filter(
    (job) => job.state === 'running' || job.state === 'queued' || job.state === 'held'));
  readonly finished = computed(() => this.all().filter(
    (job) => job.state !== 'running' && job.state !== 'queued' && job.state !== 'held'));
  readonly failed = computed(() => this.all().filter((job) => job.state === 'failed'));

  constructor() {
    if (!api) return;
    api.queue.onChanged((jobs) => this.all.set(jobs));
    void api.queue.list().then((jobs) => this.all.set(jobs));
  }

  /**
   * Put a conversion in the queue, held — and say whether it is a NEW row.
   *
   * Main dedupes on the output path and answers with the existing job when one
   * is already waiting to write that file, which is silent from here: the same
   * shape comes back either way. So the id is checked against the mirror as it
   * stood BEFORE the call. A user who presses Add twice deserves to be told the
   * second press changed nothing, rather than shown a confirmation and a shelf
   * that did not grow.
   */
  async enqueue(request: JobRequest): Promise<'added' | 'already'> {
    return (await this.enqueueNamed(request)).outcome;
  }

  /**
   * THE SAME ENQUEUE, AND IT SAYS WHICH ROW IT MADE.
   *
   * `enqueue` above throws the job away and keeps only the verdict, which is
   * everything a dialog that closes needs. A dialog that STAYS OPEN to watch the
   * run needs the id — Owen, 2026-09-17: *"if they hit start, progress shows in
   * the modal live."* Watching means finding this row in the mirror on every
   * push, and finding it by name is the only way that is not a guess.
   *
   * THE ID COMES BACK EVEN FOR `already`, deliberately. Main answers a duplicate
   * with the EXISTING row, and that row is the one already doing the work the
   * person just asked for — so a dialog can watch it rather than report that
   * nothing happened. The verdict still says which case it was; the caller
   * decides whether that distinction matters to it.
   */
  async enqueueNamed(
    request: JobRequest,
  ): Promise<{ outcome: 'added' | 'already'; id: string | null }> {
    return this.identify(() => api?.queue.enqueue(request));
  }

  /**
   * The same dedupe answer as `enqueue`, which this used to throw away.
   *
   * Main answers with the EXISTING row when one is already waiting or running to
   * write that translation, and the shape is identical either way — so
   * discarding it meant pressing Translate twice announced a success over a
   * duplicate that was never created. A user who pressed Add twice deserves to
   * be told the second press changed nothing, which is exactly the reasoning
   * written above `enqueue`; only this method had been left out of it.
   *
   * ONE METHOD FOR THREE DIALOGS, matching the one door beneath it: Translate,
   * Simplify and Clean text each build their own request and all three arrive
   * here, because the dedupe answer and the sentence it earns are the same for
   * all three (`enqueueTextPass`, electron/job-queue.ts).
   */
  async enqueueTextPass(request: TextPassRequest): Promise<'added' | 'already'> {
    return (await this.enqueueTextPassNamed(request)).outcome;
  }

  /** {@link enqueueTextPass}, saying which row — see {@link enqueueNamed}. */
  async enqueueTextPassNamed(
    request: TextPassRequest,
  ): Promise<{ outcome: 'added' | 'already'; id: string | null }> {
    return this.identify(() => api?.queue.enqueueTranslate(request));
  }

  /**
   * A CLEANUP WITH ITS TRIAGE IN FRONT OF IT — and the one door here that answers
   * with TWO rows, because the dialog that calls it acts on both (it pins a picked
   * server on each and its Start releases each).
   *
   * THE DEDUPE ANSWER IS THE CLEANUP'S, which is the row the person asked for.
   * Main answers a second press with the rows the first one made, and a press over
   * a cleanup already queued WITHOUT a triage with that row and a null triage — so
   * `already` is read off the cleanup's id against the mirror as it stood before
   * the call, exactly as {@link identify} reads it for the single-row doors.
   */
  async enqueueTriagedCleanup(request: CleanRequest): Promise<{
    outcome: 'added' | 'already';
    cleanId: string | null;
    triageId: string | null;
  }> {
    const before = new Set(this.all().map((job) => job.id));
    const made = await api?.queue.enqueueCleanTriaged(request);
    if (!made) return { outcome: 'added', cleanId: null, triageId: null };
    return {
      outcome: before.has(made.clean.id) ? 'already' : 'added',
      cleanId: made.clean.id,
      triageId: made.triage?.id ?? null,
    };
  }

  /**
   * The same dedupe answer again, for an analysis — and the one of these three
   * that can REJECT.
   *
   * Main refuses this door outright in a hosted window (`queue:enqueue-analysis`,
   * electron/ipc.ts, which carries the argument): the host's queue takes the two
   * request shapes its vendored copy of the API declares and this is a third, and
   * starting an hour of GPU in Foundry's own queue instead would put it where
   * nobody in either window can see it. The rejection is a sentence and the dialog
   * shows it where the button is — which is also why nothing is caught here: a
   * refusal swallowed by a mirror is a press that did nothing and said nothing.
   */
  async enqueueAnalysis(request: AnalyzeRequest): Promise<'added' | 'already'> {
    return (await this.enqueueAnalysisNamed(request)).outcome;
  }

  /**
   * {@link enqueueAnalysis}, saying which row.
   *
   * NOTHING IS CAUGHT HERE, as above: hosted, main refuses this door outright
   * and that rejection is a sentence the dialog shows where the button is. A
   * refusal swallowed by a mirror is a press that did nothing and said nothing.
   */
  async enqueueAnalysisNamed(
    request: AnalyzeRequest,
  ): Promise<{ outcome: 'added' | 'already'; id: string | null; rankId: string | null }> {
    // `enqueueCleanTriaged`'s arithmetic: the pair comes back, and the ANALYSIS
    // row is the one whose presence before the call says "already".
    const before = new Set(this.all().map((job) => job.id));
    const made = await api?.queue.enqueueAnalysis(request);
    if (!made) return { outcome: 'added', id: null, rankId: null };
    return {
      outcome: before.has(made.analysis.id) ? 'already' : 'added',
      id: made.analysis.id,
      rankId: made.rank?.id ?? null,
    };
  }

  /**
   * THE DEDUPE ANSWER AND THE ROW, out of one call.
   *
   * Main answers with the EXISTING row when one is already waiting to produce
   * the same thing, and the shape is identical either way — so the id is checked
   * against the mirror as it stood BEFORE the call. That trick was written three
   * times, once per enqueue door, which is three places for it to drift; it is
   * written here now and the three doors are two lines each.
   */
  private async identify(
    send: () => Promise<Job | undefined> | undefined,
  ): Promise<{ outcome: 'added' | 'already'; id: string | null }> {
    const before = new Set(this.all().map((job) => job.id));
    const job = await send();
    if (!job) return { outcome: 'added', id: null };
    return { outcome: before.has(job.id) ? 'already' : 'added', id: job.id };
  }

  /**
   * Run an EXPORT now and wait for the outcome — no queue, no Start, no row
   * left behind.
   *
   * The answer is the row as it settled, or the still-pending row of whatever
   * is already writing the same file (main's dedupe, `runNow`). The caller
   * reads `state` to tell the endings apart, which is the honest shape here:
   * unlike `enqueue` above there is no "did the list grow" question to answer,
   * because nothing was ever meant to appear in a list. Null only where there
   * is no API at all (a browser tab), which no caller treats as an outcome.
   */
  async run(request: JobRequest): Promise<Job | null> {
    return (await api?.queue.run(request)) ?? null;
  }

  /** Release the held batch. Main answers with how many; nothing here guesses. */
  /**
   * Release ONE row — the dialogs' Start, as against the shelf's.
   *
   * See `api.queue.release`: a modal committing to its own run must not let go
   * of a batch somebody parked deliberately.
   */
  async release(id: string): Promise<boolean> {
    return (await api?.queue.release(id)) ?? false;
  }

  async start(): Promise<void> {
    await api?.queue.start();
  }

  /** A held or queued row the user no longer wants. Leaves no row behind. */
  async remove(id: string): Promise<void> {
    await api?.queue.remove(id);
  }

  async cancel(id: string): Promise<void> {
    await api?.queue.cancel(id);
  }

  async clearFinished(): Promise<void> {
    await api?.queue.clearFinished();
  }

  /**
   * Send a waiting row to a different slot — a slot name, or `any`
   * (docs/SLOTS.md §3).
   *
   * NOTHING IS UPDATED HERE. The row comes back on `queue:changed` like every
   * other change, which is this service's whole contract: the renderer never
   * edits a Job. An optimistic local edit would be a second copy of the row
   * racing main's, and the one it raced would win half the time.
   */
  async setWaitFor(id: string, waitFor: string): Promise<void> {
    await api?.queue.setWaitFor(id, waitFor);
  }
}
