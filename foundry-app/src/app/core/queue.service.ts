import { Injectable, computed, signal } from '@angular/core';

import type { Job, JobRequest, TranslateRequest } from '@shared/types';

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
    const before = new Set(this.all().map((job) => job.id));
    const job = await api?.queue.enqueue(request);
    if (!job) return 'added';
    return before.has(job.id) ? 'already' : 'added';
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
   */
  async enqueueTranslate(request: TranslateRequest): Promise<'added' | 'already'> {
    const before = new Set(this.all().map((job) => job.id));
    const job = await api?.queue.enqueueTranslate(request);
    if (!job) return 'added';
    return before.has(job.id) ? 'already' : 'added';
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
}
