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
 * ── THE CLOUD ARM MOVED, IT DID NOT GO (2026-09-14, crucible PHASE15 §5.3) ──
 *
 * This used to answer `cpu` for the `claude` and `openai` providers, on the
 * true observation that a pass against a hosted API is network latency: it
 * holds no card, and making it wait behind a nine-hour narration was the queue
 * punishing a job for the company it kept.
 *
 * Both providers are gone. The same WORK still happens — the engine forwards
 * an `upstream`-routed class to Anthropic or OpenAI on the operator's account
 * — but the fact that says so is no longer on the row. It is the ROUTE, which
 * belongs to the server and is read from `GET /v1/capability`, and a row that
 * routes upstream takes that server's `[cloud]` lane instead of its GPU slot
 * (`shared/queue/slot-sets.ts`). A config field here could not answer it: two
 * books on two servers with the same provider can route differently, and the
 * row's own config knows nothing about either server.
 *
 * So what is left is the honest remainder: both surviving providers are a
 * model on a card, and both belong in the exclusive pool. The function stays
 * rather than collapsing into a literal at four call sites, because "which
 * pool does an AI step contend for" is still one question with one owner.
 */
export function resourceForProvider(_config: Record<string, unknown>): StepResource {
  return 'gpu';
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

// ────────────────────────────────────────────────────────────────────────────
// A REFUSAL A ROW CAN WAIT OUT
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE STEP DID NOT FAIL — THE CARD IS HELD, AND THE ROW IS TO WAIT.
 *
 * Crucible answers `409 server_busy` when another job holds the lane and
 * `409 leased` when another client holds the model. Both are WAITS, not
 * failures (crucible `docs/ARCHITECTURE.md` §3): nothing about the book is
 * wrong and none of its work is lost, because it never started. `busyLine` is
 * the server's own sentence naming the holder — "GPU busy: foundry, tts 62%
 * done", "leased: foundry, translate, until …" — and it is the whole of what
 * turns the failure into a wait, because `settleStep` parks a step only when
 * one is present.
 *
 * ── Why a class and not a side call (Owen, 2026-09-19: "most step modules
 *    fail a row… let's fix that") ─────────────────────────────────────────────
 *
 * Until today the line reached the scheduler through `noteStepBusy(stepId,
 * line)` — a call each module had to REMEMBER to make before it threw. Four
 * modules did; five did not, so a translation, an analysis, an RVC pass, a
 * denoise or a page read that met a held card ended as a FAILED row in *Needs
 * you*, waiting on a Retry press for something nobody did wrong (bug hunt
 * 2026-09-19, finding A5).
 *
 * So the line rides on the THROW, which is the one thing every module already
 * does with a refusal. `launch` reads it with {@link busyLineOf} and hands it
 * to `settleStep`; a module that has a typed refusal from a bridge simply lets
 * it propagate, and one that has a `{ success: false, busyLine }` RESULT mints
 * this through {@link stepFailure}.
 */
export class StepParked extends Error {
  /** The server's own sentence naming the holder. Never empty — see the ctor. */
  readonly busyLine: string;

  constructor(message: string, busyLine: string) {
    super(message);
    this.name = 'StepParked';
    if (busyLine === '') {
      throw new Error(
        'StepParked was minted with an empty busyLine. A park is a sentence naming who holds '
        + 'the card; with nothing to say, the row must fail with its own reason instead.',
      );
    }
    this.busyLine = busyLine;
  }
}

/**
 * THE HOLDER'S LINE A THROWN REFUSAL CARRIES, or undefined for an ordinary
 * failure — the ONE rule that decides whether a step parks.
 *
 * Duck-typed on purpose, and this is the whole reason a module needs no side
 * call: every refusal this app already mints for a held card carries the line
 * under this exact name — `CrucibleJobRefused`, `CrucibleRenderRefused`,
 * `CruciblePagesError`, `CrucibleTextActError`, `CrucibleBusy`/`CrucibleLeased`
 * from the SDK, and {@link StepParked} — so the seam reads them all without a
 * table of classes that would go stale the first time a new door is built.
 *
 * A non-string, or an empty string, is NOT a line: it would park a row on a
 * blank sentence, which reads to an operator as a stall with no cause.
 */
export function busyLineOf(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const said = (err as { busyLine?: unknown }).busyLine;
  return typeof said === 'string' && said !== '' ? said : undefined;
}

/**
 * The refusal a bridge's RESULT describes: a park when it named a holder, an
 * ordinary failure when it did not.
 *
 * Bridges report `{ success: false, error, busyLine? }` rather than throwing,
 * because a caller with no queue behind it (the CLI, a Settings button) reads
 * the result. This is the one line that turns such a result back into the
 * throw the step seam reads, so no module has to remember which half of the
 * pair means "wait".
 */
export function stepFailure(message: string, busyLine?: string): Error {
  return busyLine === undefined || busyLine === ''
    ? new Error(message)
    : new StepParked(message, busyLine);
}
