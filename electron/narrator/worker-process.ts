/**
 * A worker thread that reads like a child process to the bridges that start it: lines on `stdout`,
 * a `close` with a code, `kill()`. Their parsers, their stage bars and their failure handling read
 * those lines, and heavy PCM stays off the main process.
 */

import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';

/** How long a cancelled worker has to kill its ffmpegs before it is terminated anyway. */
const CANCEL_BUDGET_MS = 10_000;

class WorkerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = undefined;
  killed = false;
  private finished = false;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly worker: Worker;

  constructor(script: string, request: unknown, exceptionLine: string) {
    super();
    this.worker = new Worker(script, { workerData: request });
    this.worker.on('message', (message: { stream?: 'stdout' | 'stderr'; text?: string; exit?: number }) => {
      if (message.stream !== undefined) this[message.stream].emit('data', Buffer.from(message.text as string, 'utf8'));
      else if (message.exit !== undefined) this.finish(message.exit);
    });
    this.worker.on('error', (err) => {
      this.stdout.emit('data', Buffer.from(`${exceptionLine}${err.message}\n`, 'utf8'));
      this.stderr.emit('data', Buffer.from(`${err.stack ?? err.message}\n`, 'utf8'));
      this.finish(1);
    });
    this.worker.on('exit', (code) => this.finish(code === 0 ? 1 : code));
  }

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    if (this.cancelTimer !== null) clearTimeout(this.cancelTimer);
    void this.worker.terminate();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  /** The worker kills its own ffmpegs: terminating it first would orphan them. */
  kill(): boolean {
    this.killed = true;
    if (this.finished) return false;
    this.worker.postMessage('cancel');
    this.cancelTimer ??= setTimeout(() => this.finish(1), CANCEL_BUDGET_MS);
    return true;
  }
}

/** `exceptionLine` starts the line a worker that died outright leaves, in the words its bridge reads. */
export function startWorkerProcess(script: string, request: unknown, exceptionLine: string): ChildProcess {
  return new WorkerProcess(script, request, exceptionLine) as unknown as ChildProcess;
}
