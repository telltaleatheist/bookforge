/**
 * RVC voice-enhancement runner.
 *
 * Drives the BookForge `ultimate-rvc` fork's warm-model batch command
 * (`urvc generate convert-dir`) to re-render a directory of TTS sentence files
 * through an RVC voice model in ONE process (the model loads once, see the fork's
 * convert-dir). The enhanced sentences land in a sibling folder; the caller then
 * runs e2a assembly with `--sentences_dir` pointed at it, leaving the original
 * XTTS sentences cached and untouched.
 *
 * Device follows whatever torch is installed in the rvc-env: the cuda-rvc GPU
 * overlay (part of the unified "GPU acceleration" choice) puts CUDA torch in the
 * env so RVC auto-uses the GPU; otherwise it runs on CPU. No device flag needed.
 *
 * Spawn contract (see the env's gotchas): run the env's own `urvc` with the env
 * bin dirs on PATH (so its ffmpeg/sox resolve), `URVC_SKIP_INIT=1` (skip the
 * first-run model/sample downloads + audio-separator init), `URVC_MODELS_DIR`
 * pointing at the downloaded RVC models, and offline HF flags.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { componentManager } from './components/component-manager';
import { RVC_ENV_ID } from './components/rvc-env';
import { relocatableEnvBinDirs, relocatableBinaryPath } from './e2a-env-bootstrap';
import { getRvcModelsDir, rvcBaseModelsReady } from './rvc-models';

/** The installed rvc-env root, or null when the engine isn't installed. */
export function getRvcEnvRoot(): string | null {
  return componentManager.resolveEntry(RVC_ENV_ID);
}

/** The env's `urvc` executable, or null when unavailable. */
export function getUrvcPath(): string | null {
  const root = getRvcEnvRoot();
  return root ? relocatableBinaryPath(root, 'urvc') : null;
}

export interface RvcReadiness {
  ok: boolean;
  reason?: string;
}

/** Whether an RVC enhancement pass can actually run right now. */
export function rvcEnhancementReady(): RvcReadiness {
  const root = getRvcEnvRoot();
  if (!root) return { ok: false, reason: 'The RVC voice-enhancement engine is not installed.' };
  if (!getUrvcPath()) return { ok: false, reason: 'The RVC engine is installed but its CLI was not found.' };
  if (!rvcBaseModelsReady()) return { ok: false, reason: 'The RVC base models are not installed.' };
  return { ok: true };
}

export interface EnhanceSentencesOptions {
  /** Directory of TTS sentence files to convert (e2a's chapters/sentences). */
  sentencesDir: string;
  /** Directory to write the enhanced sentences into (created if missing). */
  outputDir: string;
  /** urvc voice-model folder name (e.g. 'Sigma Male Narrator'). */
  modelName: string;
  /** Index influence (0–1). Pass 0 for index-less models. Default 0.5. */
  indexRate?: number;
  /** Consonant/breath protection (0–0.5). Default 0.5. */
  protectRate?: number;
  /** Pitch shift in semitones (default 0 — RVC carries the source pitch). */
  nSemitones?: number;
  /** Input file glob (e2a sentence format). Default '*.flac'. */
  inputGlob?: string;
  /** Per-file progress callback. */
  onProgress?: (done: number, total: number) => void;
  /** Abort to cancel the run. */
  signal?: AbortSignal;
}

/**
 * Run the warm-model batch over `sentencesDir`, writing enhanced sentences
 * (same `{i}.<ext>` stems) into `outputDir`. Resolves with `outputDir`.
 */
export function enhanceSentences(opts: EnhanceSentencesOptions): Promise<string> {
  const ready = rvcEnhancementReady();
  if (!ready.ok) return Promise.reject(new Error(ready.reason));
  const root = getRvcEnvRoot()!;
  const urvc = getUrvcPath()!;

  fs.mkdirSync(opts.outputDir, { recursive: true });

  const indexRate = opts.indexRate ?? 0.5;
  const protectRate = opts.protectRate ?? 0.5;
  const inputGlob = opts.inputGlob ?? '*.flac';

  const args = [
    'generate', 'convert-dir',
    opts.sentencesDir,
    opts.outputDir,
    opts.modelName,
    '--index-rate', String(indexRate),
    '--protect-rate', String(protectRate),
    '--input-glob', inputGlob,
    '--output-ext', 'flac',
    ...(opts.nSemitones ? ['--n-semitones', String(opts.nSemitones)] : []),
  ];

  // Env bin dirs on PATH so the env's ffmpeg/ffprobe/sox resolve (the convert
  // path prefers PATH ffmpeg over the removed static-ffmpeg). Set both PATH and
  // Path because Windows env lookups are case-insensitive but Node keys aren't.
  const pathValue = [...relocatableEnvBinDirs(root), process.env.PATH || ''].join(path.delimiter);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(urvc, args, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: pathValue,
          Path: pathValue,
          URVC_SKIP_INIT: '1',
          URVC_MODELS_DIR: getRvcModelsDir(),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stderr = '';
    let stdoutTail = '';
    let buf = '';
    const handleLine = (line: string) => {
      const m = /^\[RVC\]\s+(\d+)\/(\d+)/.exec(line.trim());
      if (m) opts.onProgress?.(parseInt(m[1], 10), parseInt(m[2], 10));
    };
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdoutTail = (stdoutTail + s).slice(-2000);
      buf += s;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });

    let aborted = false;
    if (opts.signal) {
      if (opts.signal.aborted) { aborted = true; try { child.kill(); } catch { /* ignore */ } }
      else opts.signal.addEventListener('abort', () => {
        aborted = true;
        // NOTE: force-killing a urvc process mid-CUDA-init can wedge the env's
        // torch import until a reboot (a known RVC-on-Windows gotcha). Acceptable
        // for an explicit user cancel; revisit with a cooperative-stop signal.
        try { child.kill(); } catch { /* ignore */ }
      }, { once: true });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      if (aborted) { reject(new Error('RVC enhancement cancelled')); return; }
      if (code === 0) { resolve(opts.outputDir); return; }
      reject(new Error(`RVC convert-dir exited with code ${code}: ${stderr || stdoutTail}`));
    });
  });
}
