/**
 * THE COVERAGE ALIGNMENT, AS ITS OWN QUEUE JOB — the step that produces the
 * report assembly refuses a book without.
 *
 * ── The hole this fills ─────────────────────────────────────────────────────
 *
 * `python/narrator/assemble/coverage_gate.py` refuses an ENFORCED engine's book
 * when there is no coverage report, and it is right to: Higgs v3 has no duration
 * guard worth the name — a chunk measured a duration ratio of 0.99 while dropping
 * 22 % of its text — so "nobody checked" and "it is fine" are the same book. The
 * refusal even names the command to run:
 *
 *     narrator align --session-dir <hash dir> --report <that coverage.json>
 *
 * Nothing in BookForge ran it. Every app-driven Higgs v3 book therefore rendered
 * for hours, spent whatever GPU the enhancement passes wanted, and stopped at
 * assembly quoting a command line to a user who had no reason to know what it
 * meant. The golden sessions were aligned by hand. This is the hand.
 *
 * ── Two environments, one command line ──────────────────────────────────────
 *
 * narrator's half of the alignment (manifest, chunk spans, sentence cues, the
 * report) is stdlib plus the tools env, and it runs in the TOOLS env like every
 * other post-render door — natively, on every platform, including Windows, where
 * `normalizeWslSessionToWindows` has already copied the session out of WSL for
 * exactly this reason.
 *
 * The ALIGNMENT itself needs torch and whisperx, which narrator's interpreters do
 * not have and must not grow (the Orpheus envs are pinned to torch 2.5.1 / vLLM
 * 0.7.3, which whisperx's torch 2.8 stack cannot coexist with). BookForge already
 * ships that interpreter as the managed "Ebook Alignment (WhisperX)" component,
 * and `narrator align --python <it>` drives it over `align/worker.py`'s
 * JSON-lines protocol with PYTHONPATH pointed back at this checkout. Nothing is
 * installed and nothing is copied.
 *
 * THE ENV IS RESOLVED BY `whisperx-align-bridge.ts`, not here. That bridge
 * already answers "where is WhisperX" for the whole-m4b alignment — managed
 * component, then `WHISPERX_ENV_PATH`, then a dev conda env by name — and a
 * second copy of that ladder is a second answer, of which the copy is always the
 * one that goes stale. It is imported.
 *
 * ── CPU, and deliberately not the card ──────────────────────────────────────
 *
 * `--device cpu`, always. `align/aligner.py` refuses CUDA by name while
 * BookForge's `external-gpu-job.lock` exists, and the measurement says it does
 * not need it: 213.5 s of wall clock for 2,615 s of audio, RTF 0.082 (median
 * 1.72 s a chunk). A guard that queued behind a nine-hour narration for a card it
 * cannot use would make every book slower to prove every book was read.
 */

import { app, BrowserWindow } from 'electron';
import { execSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { publishBridgeEvent } from './bridge-events';
import { buildNarratorSpawn } from './narrator-spawn';
import { getDefaultE2aPath } from './e2a-paths';
import { resolveWhisperxEnvRoot, whisperxEnvPython } from './whisperx-align-bridge';
import { COVERAGE_REPORT_NAME } from '../shared/queue/coverage-policy';

export interface CoverageAlignConfig {
  /**
   * The session's HASH directory — the same string the assembly door passes as
   * `--session_dir`, and the same one `narrator align --session-dir` documents.
   *
   * NOT the `ebook-<uuid>` directory above it. `session_v1.build_manifest` opens
   * `<dir>/session-state.json` directly rather than walking for it, which is the
   * one place in narrator where the two are not interchangeable — the same trap
   * `runAssembly` records at its own `--session_dir`.
   */
  processDir: string;
  /** The language the wav2vec2 checkpoint is loaded for. Never defaulted here. */
  language: string;
}

export interface CoverageAlignProgress {
  phase: 'preparing' | 'aligning' | 'complete' | 'error';
  percentage: number;
  /** Chunks aligned so far / total — drives the queue's rate-based ETA. */
  processed?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface CoverageAlignResult {
  success: boolean;
  /** The coverage report, on success. */
  reportPath?: string;
  /** Chunks the aligner measured, for the job log. */
  chunksAligned?: number;
  error?: string;
  wasStopped?: boolean;
}

/** Live align children, keyed by step id, so a queue cancel can reach them. */
const activeAligns = new Map<string, ChildProcess>();
/** Step ids whose child was killed by a user stop, so the exit reads as one. */
const stoppedSteps = new Set<string>();

/**
 * Where the report for this session goes — `<processDir>/coverage.json`.
 *
 * ONE FUNCTION FOR FOUR CALLERS. The align step writes it, and both assembly
 * spawns pass it as `--coverage_report`; `coverage_gate.default_report_path`
 * looks for the same name beside the same directory when nobody names one. A
 * path spelled separately in any of those reads to the operator as "align never
 * ran", which is the one failure that looks exactly like the bug this whole step
 * was written to remove.
 */
export function coverageReportPath(processDir: string): string {
  return path.join(processDir, COVERAGE_REPORT_NAME);
}

function sendProgress(
  win: BrowserWindow | null, stepId: string, progress: CoverageAlignProgress,
): void {
  publishBridgeEvent('coverage-align:progress', { jobId: stepId, progress });
  if (!win || win.isDestroyed()) return;
  win.webContents.send('coverage-align:progress', { jobId: stepId, progress });
}

/**
 * The interpreter that can align, or the refusal naming the add-on.
 *
 * Exported because the plan-time check asks the same question — the narration
 * dialog refuses a guarded run whose aligner is missing BEFORE it queues
 * anything, which is the only point at which the answer is still cheap.
 */
export function coverageAlignPython(): string | null {
  const root = resolveWhisperxEnvRoot();
  if (!root) return null;
  const python = whisperxEnvPython(root);
  return fs.existsSync(python) ? python : null;
}

/**
 * Run the coverage alignment for one session. Progress flows out-of-band via
 * 'coverage-align:progress', as the denoise and reassembly jobs do.
 */
export async function runCoverageAlign(
  stepId: string,
  config: CoverageAlignConfig,
  mainWindow: BrowserWindow | null,
): Promise<CoverageAlignResult> {
  if (!fs.existsSync(config.processDir)) {
    const error = `The session this alignment was queued for is not on disk (${config.processDir}).`;
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  const python = coverageAlignPython();
  if (python === null) {
    // The same refusal the dialog raises at plan time, said again here because a
    // row can outlive the machine state that composed it: a queue restored after
    // the add-on was uninstalled must say WHICH add-on rather than "python not
    // found".
    const error =
      'The "Ebook Alignment (WhisperX)" add-on is not installed, so there is nothing on this '
      + 'machine that can align the rendered chunks. Install it from Settings → Add-ons and '
      + 'retry this step — the rendered audio is intact.';
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  const reportPath = coverageReportPath(config.processDir);

  /*
   * BookForge's managed torch cache, so the ~378 MB wav2vec2 align checkpoint is
   * fetched once for the whole app rather than once per user cache. The same
   * directory `whisperx-align-bridge.ts` points TORCH_HOME at; `align/env.py`
   * only adopts it when it EXISTS, so it is created here rather than assumed.
   */
  const torchHome = path.join(app.getPath('userData'), 'runtime', 'whisperx-cache');
  fs.mkdirSync(torchHome, { recursive: true });

  const args = [
    'align',
    '--session-dir', config.processDir,
    '--report', reportPath,
    '--language', config.language,
    // CPU by contract — see the header. Stated rather than left to the CLI's
    // own default so a reader of the job log can see which device measured the
    // book without going to look up what narrator defaults to.
    '--device', 'cpu',
    // The whisperx interpreter. Absent, narrator refuses BY NAME rather than
    // picking one, which is the behaviour we want everywhere else and the one
    // thing this door must not leave to chance.
    '--python', python,
  ];

  const plan = buildNarratorSpawn({
    // No engine: this is a tools-env door. `PHASE_ENGINE.align` is 'refused',
    // so naming one here would be a compile-time-legal, runtime-refused mistake.
    phase: 'align',
    args,
    envExtras: { TORCH_HOME: torchHome },
    cwdHint: getDefaultE2aPath(),
  });
  console.log('[COVERAGE-ALIGN] →', plan.describe());

  sendProgress(mainWindow, stepId, {
    phase: 'preparing', percentage: 0, message: 'Loading the aligner…',
  });

  return new Promise<CoverageAlignResult>((resolve) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
    });
    activeAligns.set(stepId, child);

    let total = 0;
    let aligned = 0;
    let tail = '';

    /*
     * WHAT THE ROW SHOWS, read out of the aligner's own two lines.
     *
     *   [align] 133 chunk(s) to align, 4 marker-only chunk(s) skipped; …
     *   [align] aligned 40/133 chunk(s)
     *
     * The second is a stated contract on narrator's side (`align/run.py`'s
     * `_progress_reporter`), not an incidental log line, because a bar wired to
     * an incidental log line stops the day somebody rewords it.
     */
    const TOTAL_RE = /\[align\] (\d+) chunk\(s\) to align/;
    const DONE_RE = /\[align\] aligned (\d+)\/(\d+) chunk\(s\)/;

    const readLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      console.log(`[COVERAGE-ALIGN] ${trimmed}`);
      const totalHit = TOTAL_RE.exec(trimmed);
      if (totalHit) {
        total = Number(totalHit[1]);
        sendProgress(mainWindow, stepId, {
          phase: 'aligning', percentage: 0, processed: 0, total,
          message: `Aligning ${total} chunk(s) against the book…`,
        });
        return;
      }
      const doneHit = DONE_RE.exec(trimmed);
      if (doneHit) {
        aligned = Number(doneHit[1]);
        total = Number(doneHit[2]);
        sendProgress(mainWindow, stepId, {
          phase: 'aligning',
          percentage: total > 0 ? Math.round((aligned / total) * 100) : 0,
          processed: aligned,
          total,
          message: `Aligning… (chunk ${aligned}/${total})`,
        });
      }
    };

    let stdoutBuf = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Kept for the failure message: narrator prints its refusals on stdout
      // (`Error: <message>`), the same asymmetry the assembly doors record.
      tail = (tail + text).slice(-4000);
      stdoutBuf += text;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) readLine(line);
    });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      activeAligns.delete(stepId);
      stoppedSteps.delete(stepId);
      const error = `The aligner could not be started: ${err.message}`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      resolve({ success: false, error });
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim() !== '') readLine(stdoutBuf);
      activeAligns.delete(stepId);
      const wasStopped = stoppedSteps.delete(stepId);

      if (wasStopped) {
        const error = 'Alignment cancelled';
        sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
        resolve({ success: false, error, wasStopped: true });
        return;
      }

      if (code === 0 && fs.existsSync(reportPath)) {
        sendProgress(mainWindow, stepId, {
          phase: 'complete', percentage: 100, processed: aligned, total,
          message: `Alignment complete — ${aligned} chunk(s) checked.`,
        });
        resolve({ success: true, reportPath, chunksAligned: aligned });
        return;
      }

      /*
       * A NON-ZERO EXIT IS NOT ONE THING, and the two it can be need different
       * sentences. `narrator align` exits 1 when a chunk FAILED TO ALIGN (it
       * stops there and writes nothing) and also when every chunk aligned but
       * one or more FAILED COVERAGE — in which case the report IS written, and
       * it names every failing chunk and quotes the text the audio did not say.
       * Pointing the operator at it is the whole point of the guard.
       */
      const detail = (tail.trim() || stderr.trim() || `exit ${code}`).slice(-1200);
      const error = fs.existsSync(reportPath)
        ? 'The forced alignment found chunk(s) whose audio did not say their text, so this book '
          + 'is not ready to assemble. The report names every one of them and quotes the dropped '
          + `text: ${reportPath}. Re-render those chunks (narrator retake --indices …) and align `
          + `again.\n${detail}`
        : `The forced alignment did not finish, so no coverage report was written.\n${detail}`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      resolve({ success: false, error });
    });
  });
}

/**
 * Stop an in-flight alignment, whole tree.
 *
 * The tree matters: `narrator align --python` spawns the whisperx interpreter as
 * a CHILD, and signalling only the parent leaves that one holding the model —
 * the same orphan `cancelEpubAlign` was written for after two align trees
 * survived a queue cancel and had to be taskkill'd by hand.
 */
export function stopCoverageAlign(stepId: string): void {
  const child = activeAligns.get(stepId);
  if (!child) return;
  stoppedSteps.add(stepId);
  const pid = child.pid;
  console.log(`[COVERAGE-ALIGN] Stopping alignment ${stepId} (pid ${pid ?? 'none'})`);
  try {
    if (pid && process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Already exited — the close handler clears the registry and reports it.
  }
}
