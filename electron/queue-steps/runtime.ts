/**
 * What every step module needs and none of them owns.
 *
 * The bridges were written to report to a window: they take `mainWindow` and
 * call `webContents.send`. That contract is not being changed — the bridges work
 * and only who LISTENS to them is moving — so the step modules have to be able
 * to hand one over. This is where it is kept.
 */
import type { BrowserWindow } from 'electron';

import type { StepReport } from '../queue-engine';
import type { JobStageProgress, StepResource } from '../../shared/queue/engine-types';

let mainWindow: BrowserWindow | null = null;

export function setQueueMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/**
 * The window the bridges report to. May be null — a headless run, or the beat
 * during quit when the window is gone and the worker's exit handler still fires.
 * Every bridge already guards for it.
 */
export function queueMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/**
 * Which pool a step contends for, given whose model it is about to use.
 *
 * A pass against a HOSTED api (Claude, OpenAI) is network latency: it holds no
 * card, no bundled llama, no Ollama runner, and making it wait behind a
 * nine-hour narration was the queue punishing a job for the company it kept. An
 * `ollama` or `local` provider is the GPU, and belongs in the exclusive pool.
 */
export function resourceForProvider(config: Record<string, unknown>): StepResource {
  const provider = config['aiProvider'];
  return provider === 'claude' || provider === 'openai' ? 'cpu' : 'gpu';
}

/** Percentage, message and stage bars from a bridge that reports all three. */
export function basicReport(
  percentage: number | undefined,
  message: string | undefined,
  stages?: JobStageProgress[],
): StepReport {
  const report: StepReport = {};
  if (percentage !== undefined) report.percent = percentage;
  if (message !== undefined) report.message = message;
  if (stages !== undefined) report.stages = stages;
  return report;
}

/**
 * The failure a bridge reported, or a sentence saying it reported none.
 *
 * NEVER "unknown error": a step that fails without a reason is a bug in the
 * bridge, and naming the bridge is what makes it findable.
 */
export function failureOf(
  result: { success?: boolean; error?: string } | null | undefined,
  what: string,
): string {
  if (result?.error) return result.error;
  return `${what} failed and gave no reason.`;
}
