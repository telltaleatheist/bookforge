/**
 * Bridge to transcribe_audiobook.py — runs faster-whisper over an audiobook to
 * produce a synced WebVTT. Spawns NATIVELY in the bundled e2a env (the whisper
 * overlay + bundled ctranslate2); never through WSL (Whisper doesn't need vLLM
 * CUDA graphs, and running it natively avoids the slow /mnt mount).
 *
 * The GPU is coordinated through the arbiter so a transcription job doesn't fight
 * the TTS/LLM for VRAM; if the wait times out the arbiter lets us proceed and the
 * script's device auto-detect still picks CPU vs CUDA sensibly.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

import { getDefaultE2aPath, getPythonInvocation, buildCondaSpawnEnv, toUnpackedPath } from './e2a-paths';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { getMainLogger } from './rolling-logger';

function tlog(msg: string, data?: unknown): void {
  data !== undefined ? console.log(msg, data) : console.log(msg);
  try { getMainLogger().info(msg, data); } catch { /* logger not ready */ }
}

export interface TranscribeOptions {
  audioPath: string;
  modelDir: string;
  outPath: string;
  /** ISO language code, or 'auto' (default) to let Whisper detect it. */
  language?: string;
  /** 'auto' (default) | 'cpu' | 'cuda'. */
  device?: string;
  /** 0..1 progress, plus the live audio position + running cue count when known. */
  onProgress?: (frac: number, detail?: TranscribeProgressDetail) => void;
  /** Coarse phase for the silent front-load: 'loading' | 'decoding' | 'transcribing'. */
  onStage?: (stage: string) => void;
  /** The device the model actually landed on ('cuda' | 'cpu'), once known. */
  onDevice?: (device: string) => void;
  /** Abort signal — kills the python process. */
  signal?: AbortSignal;
}

export interface TranscribeProgressDetail {
  /** Audio seconds transcribed so far. */
  processedSec: number;
  /** Total audio duration in seconds. */
  totalSec: number;
  /** Sentence cues produced so far. */
  cues: number;
}

export interface TranscribeResult {
  ok: boolean;
  error?: string;
  out?: string;
  cues?: number;
  device?: string;
}

function resolveScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'transcribe_audiobook.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'transcribe_audiobook.py'),
    path.join(__dirname, 'scripts', 'transcribe_audiobook.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  // Packaged: the spawned python can't read inside app.asar — hand it the
  // asarUnpack'd real file (dist/electron/scripts/** is unpacked).
  return toUnpackedPath(found);
}

/** How long to wait for the GPU before proceeding without the lock (10 min). */
const GPU_WAIT_MS = 10 * 60_000;

/**
 * Transcribe an audiobook into a WebVTT at outPath. Resolves { ok, error? }.
 * Reports 0..1 progress via onProgress. Honors an AbortSignal (kills the process).
 */
export async function transcribeAudiobook(opts: TranscribeOptions): Promise<TranscribeResult> {
  const { audioPath, modelDir, outPath } = opts;
  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `Audio file not found: ${audioPath}` };
  }
  if (!fs.existsSync(path.join(modelDir, 'model.bin'))) {
    return { ok: false, error: `Whisper model not found at ${modelDir}` };
  }

  const scriptPath = resolveScript();
  const py = getPythonInvocation(getDefaultE2aPath());
  const env = buildCondaSpawnEnv();
  tlog(`[transcribe] resolved script=${scriptPath} python=${py.command}`, { args: py.args });

  const gpuOwner = `whisper-transcribe:${path.basename(outPath)}`;
  tlog(`[transcribe] waiting for GPU lock (up to ${Math.round(GPU_WAIT_MS / 60000)} min)…`);
  await acquireGpu(gpuOwner, { timeoutMs: GPU_WAIT_MS });
  tlog('[transcribe] GPU acquired (or wait elapsed) — spawning python');

  try {
    return await new Promise<TranscribeResult>((resolve) => {
      const args = [
        ...py.args, '-u', scriptPath,
        '--audio', audioPath,
        '--model-dir', modelDir,
        '--out', outPath,
        '--language', opts.language || 'auto',
        '--device', opts.device || 'auto',
      ];

      let child: ChildProcess;
      try {
        child = spawn(py.command, args, { env, windowsHide: true });
        tlog(`[transcribe] python spawned pid=${child.pid ?? 'unknown'}`);
      } catch (err) {
        tlog(`[transcribe] spawn FAILED: ${err instanceof Error ? err.message : String(err)}`);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }

      const onAbort = () => {
        try { child.kill(); } catch { /* already gone */ }
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      let stdout = '';
      let stderr = '';
      let carry = '';

      child.stdout?.on('data', (d) => {
        const text = carry + d.toString();
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          // PROGRESS <frac> [processedSec totalSec cues]
          const m = /^PROGRESS\s+([0-9.]+)(?:\s+([0-9.]+)\s+([0-9.]+)\s+([0-9]+))?/.exec(trimmed);
          if (m) {
            const frac = parseFloat(m[1]);
            if (Number.isFinite(frac)) {
              const detail = m[2] !== undefined
                ? { processedSec: parseFloat(m[2]), totalSec: parseFloat(m[3]), cues: parseInt(m[4], 10) }
                : undefined;
              opts.onProgress?.(frac, detail);
            }
            continue;
          }
          const stage = /^STAGE\s+(\w+)/.exec(trimmed);
          if (stage) { opts.onStage?.(stage[1]); continue; }
          const dev = /^DEVICE\s+(\w+)/.exec(trimmed);
          if (dev) { opts.onDevice?.(dev[1]); continue; }
          stdout += line + '\n';
        }
      });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        tlog(`[transcribe] python process error: ${err.message}`);
        resolve({ ok: false, error: err.message });
      });
      child.on('close', (code) => {
        tlog(`[transcribe] python closed code=${code}${stderr ? ' stderr(tail): ' + stderr.trim().slice(-300) : ''}`);
        opts.signal?.removeEventListener('abort', onAbort);
        if (opts.signal?.aborted) {
          resolve({ ok: false, error: 'Transcription cancelled' });
          return;
        }
        // Include the carried final line when scanning for the JSON result.
        const all = (stdout + carry).split('\n').map((l) => l.trim()).filter(Boolean);
        for (let i = all.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(all[i]);
            if (typeof parsed.ok === 'boolean') return resolve(parsed);
          } catch {
            /* not JSON */
          }
        }
        resolve({ ok: false, error: stderr.trim().slice(-500) || 'transcription produced no result' });
      });
    });
  } finally {
    releaseGpu(gpuOwner);
  }
}
