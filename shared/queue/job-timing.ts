/**
 * How long a queued run has been working, and how long each of its tasks has.
 *
 * A run is a MASTER row plus one child task per step — narrate, enhance, assemble.
 * The master row executes nothing itself (processNext skips it by type), so the only
 * honest source for "how long has this job taken" is the tasks underneath it.
 *
 * The run total is the SUM of its tasks rather than the wall clock from the first
 * task's start. processNext holds a task until every earlier sibling is complete, so
 * the tasks in one run cannot overlap and a sum cannot double-count them; what the
 * sum leaves out is the stretch where the queue sat paused between two steps, which
 * is not time this job spent working. (A task started by hand with Run Now can run
 * beside the queue's lane — that is the one arrangement where these two readings
 * diverge, and it is the user putting two things on the GPU deliberately.)
 *
 * Owen, 2026-08-10: "i need a job total time elapsed. right now the time elapsed
 * shows the task's time, not the overall job. tts took about 20 minutes, but master
 * elapsed just shows 5 minutes because thats how long reassembly has taken so far."
 * Both numbers were correct about the row they were read from — the master field was
 * reading a running TASK, because nothing had resolved the run that task belonged to.
 */

/** The two timestamps a task's duration is read from. */
export interface TaskTiming {
  /** Absent until the task starts. */
  readonly startedAt?: Date | string | number | null;
  /** Absent while the task is still running. Stamped on EVERY terminal outcome. */
  readonly completedAt?: Date | string | number | null;
}

/**
 * Milliseconds for a timestamp the task actually carries.
 *
 * A present-but-unreadable stamp is a bug in whatever wrote it — persisted queue.json
 * revives these from ISO strings — and reading it as 0 would silently report a job as
 * having run since 1970. It throws instead.
 */
function millisOf(value: Date | string | number, field: string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`Queue timing: ${field} is present but unreadable (${String(value)}).`);
  }
  return ms;
}

/**
 * Seconds this one task has been working: up to its completion, or up to `now` while
 * it runs. Zero before it starts — a task still queued has spent no time yet, and
 * that is a fact about it rather than a missing measurement.
 */
export function taskElapsedSeconds(task: TaskTiming, now: number): number {
  const startedAt = task.startedAt;
  if (startedAt === undefined || startedAt === null) return 0;
  const started = millisOf(startedAt, 'startedAt');
  const completedAt = task.completedAt;
  const ended = completedAt === undefined || completedAt === null
    ? now
    : millisOf(completedAt, 'completedAt');
  return Math.max(0, Math.floor((ended - started) / 1000));
}

/**
 * Seconds the whole run has been working — every task in it, added up.
 *
 * A standalone job is a run of one, so it goes through here too and there is one rule
 * on screen instead of two.
 */
export function runElapsedSeconds(tasks: readonly TaskTiming[], now: number): number {
  let total = 0;
  for (const task of tasks) total += taskElapsedSeconds(task, now);
  return total;
}
