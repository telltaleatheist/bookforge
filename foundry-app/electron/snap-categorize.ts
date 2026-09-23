/**
 * THE CATEGORIZE TILE'S RUN — bring snap up, ask every block, bring snap down,
 * and land the answers as an edit step.
 *
 * Owen, 2026-09-22: *"the foundry tile should bring the model up, categorize
 * everything, and bring the model back down."* This is that, in that order, with
 * the bring-down in a `finally` so a failure or a cancel still gives the card
 * back. What the model is shown and what its answers become is the pure half,
 * `shared/snap-categorize.ts`; this file owns the processes, the HTTP and the
 * landing.
 *
 * ── An experiment outside Crucible, deliberately ────────────────────────────
 *
 * Foundry deleted its local model server on 2026-09-17 (*"foundry shouldn't assume
 * there even is a local system … foundry does all ai work through crucible"*).
 * This brings one back for ONE tile, on Owen's word — *"not through crucible yet —
 * good call"* — because Crucible cannot return the letter probabilities snap
 * reads. It starts only on a press, only what it needs, and stops what it
 * started. If it earns its place it moves into Crucible as a job type.
 *
 * ── The stack: snap's own scripts, not a second spelling of them ────────────
 *
 * snap ships `scripts/serve.ps1` (llama-server, flags checked against the
 * binary's own --help, PID file, log under runs/) and `scripts/stop.ps1` (which
 * refuses to kill a reused PID). They are driven as they are; `snap serve` is the
 * decision server in front of them. A stack that is ALREADY answering is used and
 * left running — it is not this press's to stop.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  blockQuestion, bookHeader, buildWindows, decide, DEFAULT_SNAP_POLICY, estimateTokens,
  isAsked, windowState, type SnapCategorizeResult, type SnapCategorizeSettings,
  type SnapChoiceAnswer, type SnapPolicy, type SnapProgress, type SnapReportRow,
} from '../shared/snap-categorize';
import type { BookOp } from '../shared/ops';
import { applyBookOps, loadBook } from './book';
import { broadcast } from './window';

/** Where snap listens, and where its engine does — snap's README defaults. */
const SNAP_PORT = 8480;
const ENGINE_PORT = 8481;
const SNAP_URL = `http://127.0.0.1:${SNAP_PORT}`;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

/**
 * Questions per `/v1/decide` request. snap primes the shared state once per
 * request and llama-server keeps it cached between requests, so the size only
 * bounds how long one HTTP call runs and how much a cancel has to wait for.
 */
const QUESTIONS_PER_REQUEST = 48;

/** How long the engine may take to load, and how long one request may run. */
const ENGINE_READY_MS = 5 * 60_000;
const SNAP_READY_MS = 60_000;
const REQUEST_MS = 20 * 60_000;

/** Room kept free in the engine's window for the question, the options and the answer. */
const QUESTION_RESERVE_TOKENS = 1_024;

export class SnapCategorizeError extends Error {}

/** The one run in flight, so a second press is refused and Cancel has something to abort. */
let running: { projectDir: string; abort: AbortController } | null = null;

export function cancelSnapCategorize(): boolean {
  if (running === null) return false;
  running.abort.abort();
  return true;
}

function say(progress: SnapProgress): void {
  broadcast('snap:progress', progress);
}

/** GET a URL, answering whether it said 200 — never throws. */
async function answers200(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, ms: number, what: string, signal: AbortSignal): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (signal.aborted) throw new SnapCategorizeError('Cancelled while waiting for the model to start.');
    if (await answers200(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new SnapCategorizeError(`${what} did not answer ${url} within ${Math.round(ms / 1000)} s.`);
}

/** Run a snap PowerShell script to completion, answering its output or throwing its words. */
function runScript(snapHome: string, script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(snapHome, 'scripts', script), ...args,
    ], { cwd: snapHome, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', (err) => reject(new SnapCategorizeError(`${script} could not be run: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new SnapCategorizeError(`${script} failed (exit ${code}): ${out.trim().slice(-800)}`));
    });
  });
}

/** What this press brought up, so the `finally` brings down exactly that. */
interface Stack {
  startedEngine: boolean;
  snapChild: ChildProcess | null;
  /** The engine's actual context, read from it — never the one asked for. */
  contextTokens: number;
}

async function bringUp(settings: SnapCategorizeSettings, signal: AbortSignal, projectDir: string): Promise<Stack> {
  const home = settings.snapHome;
  for (const needed of ['scripts/serve.ps1', 'scripts/stop.ps1', '.venv/Scripts/snap.exe']) {
    if (!existsSync(path.join(home, ...needed.split('/')))) {
      throw new SnapCategorizeError(`${path.join(home, ...needed.split('/'))} is missing — is "${home}" the snap folder, set up per its README?`);
    }
  }
  const stack: Stack = { startedEngine: false, snapChild: null, contextTokens: 0 };
  try {
    if (!await answers200(`${ENGINE_URL}/health`)) {
      say({ projectDir, phase: 'starting', message: `Starting the model (Qwen3.5 9B, ${settings.contextTokens.toLocaleString()}-token window)…` });
      await runScript(home, 'serve.ps1', [
        '-Background', '-Ctx', String(settings.contextTokens), '-Checkpoints', '32',
      ]);
      stack.startedEngine = true;
      await waitFor(`${ENGINE_URL}/health`, ENGINE_READY_MS, 'The model server', signal);
    } else {
      say({ projectDir, phase: 'starting', message: 'A model server is already running on this machine — using it, and leaving it running afterwards.' });
    }
    stack.contextTokens = await engineContext();
    if (!await answers200(`${SNAP_URL}/v1/health`)) {
      stack.snapChild = spawn(path.join(home, '.venv', 'Scripts', 'snap.exe'), [
        'serve', '--port', String(SNAP_PORT), '--engine', ENGINE_URL,
      ], { cwd: home, windowsHide: true, stdio: 'ignore' });
      await waitFor(`${SNAP_URL}/v1/health`, SNAP_READY_MS, 'snap', signal);
    }
    return stack;
  } catch (err) {
    await bringDown(stack, home);
    throw err;
  }
}

/** The context the running engine was started with (llama-server `/props`). */
async function engineContext(): Promise<number> {
  const res = await fetch(`${ENGINE_URL}/props`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SnapCategorizeError(`The model server's /props answered ${res.status}.`);
  const props = await res.json() as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
  const n = props.default_generation_settings?.n_ctx ?? props.n_ctx;
  if (typeof n !== 'number' || n <= 0) {
    throw new SnapCategorizeError('The model server did not say how large its context is (/props has no n_ctx).');
  }
  return n;
}

async function bringDown(stack: Stack, home: string): Promise<void> {
  if (stack.snapChild !== null && stack.snapChild.exitCode === null) stack.snapChild.kill();
  if (stack.startedEngine) {
    try {
      await runScript(home, 'stop.ps1', []);
    } catch (err) {
      // Said, not swallowed: a model left on the card is the one outcome of this
      // tile somebody has to act on.
      broadcast('snap:progress', {
        projectDir: '', phase: 'failed',
        message: `The model could not be stopped: ${(err as Error).message} — stop it with snap's scripts\\stop.ps1.`,
      } satisfies SnapProgress);
    }
  }
}

/** One `/v1/decide` call: a state and a batch of block questions. */
async function ask(
  state: string,
  questions: Record<string, ReturnType<typeof blockQuestion>>,
  signal: AbortSignal,
): Promise<Record<string, SnapChoiceAnswer>> {
  const res = await fetch(`${SNAP_URL}/v1/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
  });
  const body = await res.json() as { answers?: Record<string, SnapChoiceAnswer>; error?: { code: string; message: string } };
  if (!res.ok || body.answers === undefined) {
    throw new SnapCategorizeError(
      `snap refused the request (${res.status}): ${body.error ? `${body.error.code} — ${body.error.message}` : 'no answers in its reply'}`,
    );
  }
  return body.answers;
}

/**
 * CATEGORIZE THE BOOK AT THIS PROJECT'S POSITION.
 *
 * The book is read at the position with every recorded edit replayed
 * (`loadBook`), every block snap is asked about gets one `choice` question, and
 * the confident changes land through `applyBookOps` — the Apply button's own door
 * — as one edit step. The report of every answer is written beside the project
 * whatever happens to the step, because "how did it perform" is the question
 * this tile exists to answer.
 */
export async function snapCategorize(
  projectDir: string,
  settings: SnapCategorizeSettings,
): Promise<SnapCategorizeResult> {
  if (running !== null) {
    throw new SnapCategorizeError('A categorization is already running. Wait for it, or cancel it first.');
  }
  const abort = new AbortController();
  running = { projectDir, abort };
  let stack: Stack | null = null;
  try {
    const loaded = await loadBook(projectDir);
    if (!loaded.ok) throw new SnapCategorizeError(loaded.reason);
    const rows = loaded.rows;
    const policy: SnapPolicy = {
      minConfidence: settings.minConfidence ?? DEFAULT_SNAP_POLICY.minConfidence,
      minLabelMass: settings.minLabelMass ?? DEFAULT_SNAP_POLICY.minLabelMass,
    };

    stack = await bringUp(settings, abort.signal, projectDir);

    const header = bookHeader(loaded.title, loaded.chapters);
    const windows = buildWindows(
      rows,
      new Set(loaded.chapters.map((chapter) => chapter.id)),
      estimateTokens(header) + 64,
      stack.contextTokens - QUESTION_RESERVE_TOKENS,
    );
    const total = rows.filter(isAsked).length;
    const answers = new Map<string, SnapChoiceAnswer>();
    for (let w = 0; w < windows.length; w += 1) {
      const window = windows[w]!;
      const state = windowState(header, rows, window, w, windows.length);
      const asked = rows.slice(window.start, window.end).filter(isAsked);
      for (let at = 0; at < asked.length; at += QUESTIONS_PER_REQUEST) {
        if (abort.signal.aborted) throw new SnapCategorizeError('Cancelled.');
        const batch = asked.slice(at, at + QUESTIONS_PER_REQUEST);
        say({
          projectDir, phase: 'asking',
          message: windows.length === 1
            ? `Categorizing blocks (${answers.size.toLocaleString()} of ${total.toLocaleString()})…`
            : `Categorizing blocks, part ${w + 1} of ${windows.length} (${answers.size.toLocaleString()} of ${total.toLocaleString()})…`,
          done: answers.size, total,
        });
        const questions = Object.fromEntries(batch.map((row) => [row.id, blockQuestion(row)]));
        const got = await ask(state, questions, abort.signal);
        for (const row of batch) {
          const answer = got[row.id];
          if (answer === undefined) {
            throw new SnapCategorizeError(`snap answered the batch without an answer for block ${row.id}.`);
          }
          answers.set(row.id, answer);
        }
      }
    }

    say({ projectDir, phase: 'stopping', message: stack.startedEngine ? 'Stopping the model…' : 'Done asking.' });
    await bringDown(stack, settings.snapHome);
    const startedModel = stack.startedEngine;
    stack = null;

    const decision = decide(rows, answers, loaded.chapters, policy);
    const reportPath = await writeReport(projectDir, decision.report, { windows: windows.length, policy });
    const ops: BookOp[] = [...decision.categoryOps, ...decision.chapterOps];
    if (ops.length > 0) {
      say({ projectDir, phase: 'applying', message: `Applying ${decision.categoryOps.length} category change(s) and ${decision.chapterOps.length} chapter marker(s)…` });
      await applyBookOps(projectDir, ops);
    }
    const result: SnapCategorizeResult = {
      asked: answers.size,
      changed: decision.categoryOps.length,
      chapters: decision.chapterOps.length,
      lowConfidence: decision.report.filter((row) => row.outcome === 'low-confidence' || row.outcome === 'low-label-mass').length,
      windows: windows.length,
      reportPath,
      startedModel,
      applied: ops.length > 0,
    };
    say({
      projectDir, phase: 'done',
      message: ops.length > 0
        ? `Done: ${result.changed} block(s) recategorized, ${result.chapters} chapter marker(s) added.`
        : 'Done: every block already had the category snap chose — nothing to change.',
    });
    return result;
  } catch (err) {
    say({
      projectDir,
      phase: abort.signal.aborted ? 'cancelled' : 'failed',
      message: (err as Error).message,
    });
    throw err;
  } finally {
    if (stack !== null) await bringDown(stack, settings.snapHome);
    running = null;
  }
}

/** Every answer, one JSON line per block, under `<project>/snap/`. */
async function writeReport(
  projectDir: string,
  report: readonly SnapReportRow[],
  meta: { windows: number; policy: SnapPolicy },
): Promise<string> {
  const dir = path.join(projectDir, 'snap');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `categorize-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const lines = [JSON.stringify({ kind: 'snap-categorize', at: new Date().toISOString(), ...meta })];
  for (const row of report) lines.push(JSON.stringify(row));
  await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
