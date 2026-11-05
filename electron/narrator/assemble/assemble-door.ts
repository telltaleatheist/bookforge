/**
 * The door the bridges assemble through.
 *
 * ORPHEUS STAYS ON THE PYTHON until step 8 (lead's ruling, 2026-11-05): Orpheus is retired and not
 * ported, and its sessions' behaviour does not change before Owen rules. So the session's own
 * recorded engine picks the route. See docs/REORG-PLAN.md.
 *
 * A worker reads like a child to the bridges: lines on `stdout`, a `close` with a code, `kill()`.
 * Their parsers, their stage bars and their failure handling read those lines and did not change.
 *
 * Pre-encoded chapters and a post-render filter are not requests here: both come only from an
 * Orpheus session (the chapter closer, and its de-ring voice filter), which takes the Python.
 */

import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

/** How long a cancelled worker has to kill its ffmpegs before it is terminated anyway. */
const CANCEL_BUDGET_MS = 10_000;

export interface AssemblyRequest {
  readonly processDir: string;
  readonly outputDir: string;
  readonly sentencesDir?: string | null;
  readonly chapters?: string | null;
  readonly coverageReport?: string | null;
  readonly chapterGap: number;
  readonly finalDenoise: boolean;
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

/**
 * `python` for an Orpheus session and `typescript` for everything else. A state file that cannot
 * be read goes to the TypeScript, whose reader refuses it by name.
 */
export async function assemblyRoute(processDir: string): Promise<'python' | 'typescript'> {
  try {
    const state = JSON.parse(await fsp.readFile(path.join(processDir, 'session-state.json'), 'utf8')) as Record<string, unknown>;
    return state['tts_engine'] === 'orpheus' ? 'python' : 'typescript';
  } catch {
    return 'typescript';
  }
}

class AssemblyWorkerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = undefined;
  killed = false;
  private finished = false;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly worker: Worker;

  constructor(request: AssemblyRequest) {
    super();
    this.worker = new Worker(path.join(__dirname, 'assemble-worker.js'), { workerData: request });
    this.worker.on('message', (message: { stream?: 'stdout' | 'stderr'; text?: string; exit?: number }) => {
      if (message.stream !== undefined) this[message.stream].emit('data', Buffer.from(message.text as string, 'utf8'));
      else if (message.exit !== undefined) this.finish(message.exit);
    });
    this.worker.on('error', (err) => {
      this.stdout.emit('data', Buffer.from(`assemble_audiobook() Exception: ${err.message}\n`, 'utf8'));
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

export function startAssembly(request: AssemblyRequest): ChildProcess {
  return new AssemblyWorkerProcess(request) as unknown as ChildProcess;
}
