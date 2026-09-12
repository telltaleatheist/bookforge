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

/**
 * THE PROJECT THIS ROW IS ABOUT — one rule, read by every step that needs one.
 *
 * Owen, 2026-09-12 16:31: Foundry "Clean text" on *Starcraft 1. Liberty's
 * Crusade* → Narrate from the pending export. The render finished (518 chunks,
 * 101.7 raw sent/min, cached under `stages/03-tts/sessions/en/`) and the
 * assembly chained behind it failed in one millisecond with "This assembly row
 * names no narration session and no project, so there is nothing for it to
 * assemble." — while that row's OWN config carried `bfpPath` and its input's
 * `detail` carried `projectDir`. Neither was looked at: the step asked
 * `ctx.job.projectId` and nothing else, and a Foundry-ORDERED run has none — it
 * is enqueued with a `documentPath` and no project (electron/foundry-host-queue.ts,
 * `enqueue`). Five steps had the identical shape, so the rule lives here once.
 *
 * The order is the order of who knows best:
 *
 *  1. `config.bfpPath` — a BOOK row's own project;
 *  2. `config.projectDir` — an ARTICLE row's. Exactly one of the two is ever
 *     set, and the pair is declared once, with its reason, in
 *     `shared/queue/narration-run.ts` (§ NarrationStepPlan) — every row of a
 *     narration plan carries one of them;
 *  3. `ctx.input.detail.projectDir` — what the artifact in FRONT of this step
 *     said it belongs to (`foundry-export-landing` mints it; `tts-conversion`
 *     repeats it);
 *  4. `ctx.job.projectId` — the RUN's, which is the only one of the four a
 *     Foundry-ordered run can be missing.
 *
 * AN EMPTY STRING IS NOT AN ANSWER. A narration plan writes `sessionId: ''`,
 * `sessionDir: ''`, `processDir: ''` on the rows whose session does not exist
 * yet, and a `bfpPath: ''` arriving the same way must fall through to the next
 * source rather than being taken for a project directory at the root.
 *
 * `undefined` when nothing answers, and the REFUSAL STAYS WITH THE STEP, in that
 * step's own words ("this assembly row", "this denoise row") — a shared sentence
 * would tell an operator less than the four of them already do.
 */
export function projectDirForStep(
  ctx: {
    readonly input?: { readonly detail?: Record<string, unknown> } | undefined;
    readonly job?: { readonly projectId?: string } | undefined;
  },
  // `unknown`-valued rather than `string`-valued so a step's typed config AND
  // the engine's untyped `Record<string, unknown>` both fit; every value is
  // checked below either way.
  config: { readonly bfpPath?: unknown; readonly projectDir?: unknown } | null | undefined,
): string | undefined {
  const said = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  return said(config?.bfpPath)
    ?? said(config?.projectDir)
    ?? said(ctx.input?.detail?.['projectDir'])
    ?? said(ctx.job?.projectId);
}
