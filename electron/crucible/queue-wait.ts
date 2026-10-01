/**
 * FOLLOWING A JOB THAT WAITS IN A CRUCIBLE'S LINE — the parts every door that
 * submits with `queue` shares (`job.ts`, `render.ts`). The policy itself (who
 * queues, for how long, what a `removed` means) is `shared/crucible/server-queue.ts`.
 *
 * Three things, each with one owner here:
 *
 *  - the WAITING STATE of a followed job: set by `queued`, cleared by `started`
 *    or any frame that means the job is on the lane;
 *  - the HEARTBEAT while it waits ({@link CRUCIBLE_QUEUE_HEARTBEAT_MS}): its
 *    answer beats the stall clock and refreshes the row's position;
 *  - the refusal a `queue_full` becomes: a WAIT naming the line, never a failure
 *    (nothing about the book is wrong; the server's line is full).
 */
import { CrucibleRefused } from '@crucible/client';
import type { CrucibleClient } from '@crucible/client';
import {
  CRUCIBLE_QUEUE_HEARTBEAT_MS,
  crucibleQueuedLine,
} from '../../shared/crucible/server-queue';

/** Where a waiting job stands, for a door's progress line. */
export interface CrucibleQueuePlace {
  readonly position: number;
  readonly of: number | null;
  /** {@link crucibleQueuedLine}: "waiting, #2 of 5 in crucible "shift"'s line". */
  readonly line: string;
}

export interface QueueWaitWatch {
  /** Feed every job event's NAME here; the watch knows which ones move it. */
  seen(event: string, data: unknown): void;
  /** True while the job is waiting in the server's line. */
  waiting(): boolean;
  /** Stops the heartbeat timer. Idempotent; call on every ending. */
  stop(): void;
}

/**
 * Watch one followed job's place in its server's line.
 *
 * `beat` is the stall clock's (it is a function the door updates as the clock
 * is re-armed across reconnects, so it is read on every tick, not captured).
 * `onPlace` is called on every `queued` frame and on every heartbeat answer
 * that still places the job in the line.
 */
export function watchQueueWait(options: {
  readonly server: string;
  readonly jobId: string;
  readonly client: Pick<CrucibleClient, 'queueHeartbeat'>;
  readonly beat: () => void;
  readonly onPlace: (place: CrucibleQueuePlace) => void;
  readonly onLog?: (line: string) => void;
  /** Keepers only; the policy is {@link CRUCIBLE_QUEUE_HEARTBEAT_MS}. */
  readonly everyMs?: number;
}): QueueWaitWatch {
  const log = options.onLog ?? (() => undefined);
  let isWaiting = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastOf: number | null = null;

  const place = (position: number, of: number | null): void => {
    lastOf = of;
    options.onPlace({ position, of, line: crucibleQueuedLine(options.server, position, of) });
  };
  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const tick = async (): Promise<void> => {
    if (!isWaiting) return;
    try {
      const answer = await options.client.queueHeartbeat(options.jobId);
      // THE SERVER TALKED ABOUT THIS JOB: that is what the stall clock measures.
      options.beat();
      if (isWaiting && answer.position !== null && answer.position > 0) place(answer.position, lastOf);
    } catch (err) {
      // Not a failure of the job: the event stream is what says how it ends.
      // A server that does not answer leaves the stall clock running, which is
      // the case the clock exists for.
      log(`queue heartbeat for crucible "${options.server}" job ${options.jobId} was not answered: `
        + `${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    seen(event: string, data: unknown): void {
      if (event === 'queued') {
        const d = (data ?? {}) as { position?: unknown; of?: unknown };
        const position = typeof d.position === 'number' ? d.position : null;
        const of = typeof d.of === 'number' ? d.of : null;
        if (position === null || position <= 0) return;
        isWaiting = true;
        place(position, of);
        if (timer === null) {
          timer = setInterval(() => { void tick(); }, options.everyMs ?? CRUCIBLE_QUEUE_HEARTBEAT_MS);
          timer.unref?.();
        }
        return;
      }
      // `started`, or any frame that only a job ON the lane sends, or a
      // terminal: the wait is over.
      if (event === 'started' || event === 'warming' || event === 'progress' || event === 'chunk'
        || event === 'artifact' || event === 'done' || event === 'failed' || event === 'cancelled'
        || event === 'removed') {
        isWaiting = false;
        stopTimer();
      }
    },
    waiting: () => isWaiting,
    stop(): void {
      isWaiting = false;
      stopTimer();
    },
  };
}

/**
 * `409 queue_full` → the sentence a WAITING row reads, or null for any other
 * error. The server's line is full (50 of this client's, or 200 in all): no
 * repair is owed by anyone, the line drains on its own, so the row waits.
 */
export function queueFullLine(err: unknown, server: string): string | null {
  if (!(err instanceof CrucibleRefused) || err.code !== 'queue_full') return null;
  const d = (err.details ?? {}) as { scope?: unknown; limit?: unknown; depth?: unknown };
  const scope = d.scope === 'client' ? 'this app\'s share of' : 'all of';
  const limit = typeof d.limit === 'number' ? ` (${d.limit})` : '';
  return `crucible "${server}"'s line is full — ${scope} its places are taken${limit}`;
}
