/**
 * faster-whisper (CTranslate2) transcription models — downloadable, folder-backed.
 *
 * Models live in
 *
 *   <userData>/runtime/whisper-models/<id>/   (model.bin + config.json + tokenizer)
 *
 * and are fetched from HuggingFace (Systran/faster-whisper-*) on demand. Unlike the
 * runtime overlay (whisper-env.ts, which adds the faster-whisper PACKAGE to the e2a
 * env), this module manages the model WEIGHTS — same package/weights split as
 * Voxtral and Orpheus. The "Generate sentences" feature needs both: the overlay
 * installed AND at least one model downloaded.
 *
 * A model is a plain snapshot dir (no manifest needed — the filesystem is the source
 * of truth): present ⇔ <dir>/model.bin exists. Download progress is derived by
 * polling the dir size against the model's known byte count (snapshot_download has
 * no clean per-file callback), so the UI gets a smooth bar without parsing tqdm.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

import { getDefaultE2aPath, getPythonInvocation, buildCondaSpawnEnv, toUnpackedPath } from './e2a-paths';
import { getHfToken } from './orpheus-hf-catalog';

// ── Catalog ────────────────────────────────────────────────────────────────

export interface WhisperModelDef {
  /** Local id / folder name + dropdown value. */
  id: string;
  /** HuggingFace repo the CTranslate2 model is fetched from. */
  hfRepo: string;
  /** Human label for the picker. */
  label: string;
  /** One-line note on the accuracy/speed trade-off. */
  note: string;
  /** Approximate on-disk size in MB — headline for the UI + progress denominator. */
  sizeMB: number;
}

/**
 * Offered models, fastest → most accurate. distil-large-v3 is a distilled large
 * that runs ~2× faster at near-large accuracy (English-focused).
 */
export const WHISPER_MODELS: WhisperModelDef[] = [
  {
    id: 'tiny',
    hfRepo: 'Systran/faster-whisper-tiny',
    label: 'Tiny',
    note: 'Smallest and fastest. Rough transcript, lowest accuracy.',
    sizeMB: 75,
  },
  {
    id: 'base',
    hfRepo: 'Systran/faster-whisper-base',
    label: 'Base',
    note: 'Very fast, slightly better than Tiny. Good for a quick pass.',
    sizeMB: 145,
  },
  {
    id: 'small',
    hfRepo: 'Systran/faster-whisper-small',
    label: 'Small',
    note: 'Fast with solid accuracy. A good default.',
    sizeMB: 484,
  },
  {
    id: 'medium',
    hfRepo: 'Systran/faster-whisper-medium',
    label: 'Medium',
    note: 'Balanced speed and accuracy.',
    sizeMB: 1530,
  },
  {
    id: 'large-v3',
    hfRepo: 'Systran/faster-whisper-large-v3',
    label: 'Large v3',
    note: 'Most accurate, slowest. Best for final transcripts.',
    sizeMB: 3090,
  },
  {
    id: 'distil-large-v3',
    hfRepo: 'Systran/faster-distil-whisper-large-v3',
    label: 'Distil Large v3 (fast)',
    note: 'Near-large accuracy at ~2× the speed (English).',
    sizeMB: 1510,
  },
];

export function getWhisperModelDef(id: string): WhisperModelDef | undefined {
  return WHISPER_MODELS.find((m) => m.id === id);
}

// ── Paths ────────────────────────────────────────────────────────────────

/** The whisper-models root: <userData>/runtime/whisper-models. */
export function getWhisperModelsDir(): string {
  const override = process.env.BOOKFORGE_WHISPER_MODELS_DIR?.trim();
  if (override) return override;
  return path.join(app.getPath('userData'), 'runtime', 'whisper-models');
}

/** Absolute dir for a given model id (may not exist yet). */
export function whisperModelDir(id: string): string {
  return path.join(getWhisperModelsDir(), id);
}

/** A model is usable when its dir has model.bin (the CTranslate2 weights). */
export function isWhisperModelPresent(id: string): boolean {
  try {
    return fs.existsSync(path.join(whisperModelDir(id), 'model.bin'));
  } catch {
    return false;
  }
}

// ── Status ────────────────────────────────────────────────────────────────

export interface WhisperModelStatus extends WhisperModelDef {
  /** True when model.bin is present on disk. */
  present: boolean;
}

/** The catalog with a present/absent flag on each entry. */
export function listWhisperModels(): WhisperModelStatus[] {
  return WHISPER_MODELS.map((m) => ({ ...m, present: isWhisperModelPresent(m.id) }));
}

// ── Download ────────────────────────────────────────────────────────────────

/** Total bytes currently on disk under a dir (recursive), for progress polling. */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      /* file vanished mid-scan */
    }
  }
  return total;
}

function resolveDownloadScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'whisper_download.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'whisper_download.py'),
    path.join(__dirname, 'scripts', 'whisper_download.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  // Packaged: the spawned python can't read inside app.asar — hand it the
  // asarUnpack'd real file (dist/electron/scripts/** is unpacked).
  return toUnpackedPath(found);
}

export interface WhisperDownloadProgress {
  id: string;
  /** 0–100. */
  pct: number;
  receivedBytes: number;
  totalBytes: number;
}

/** One live download per model id: concurrent callers (the settings panel, the
 *  download dock, a queued generate-sentences job) share the same promise and
 *  all receive progress, instead of racing two snapshot_downloads into one dir. */
interface InFlightDownload {
  promise: Promise<{ ok: boolean; error?: string }>;
  listeners: Set<(p: WhisperDownloadProgress) => void>;
  lastProgress?: WhisperDownloadProgress;
}
const inFlightDownloads = new Map<string, InFlightDownload>();

/**
 * Download a Whisper model into its dir, reporting progress by polling dir size.
 * Resolves { ok, error? }. Idempotent: a model already present resolves ok
 * immediately, and a download already running for this id is joined (shared
 * promise + fanned-out progress) rather than started twice. Runs natively in the
 * bundled e2a env (huggingface_hub is bundled).
 */
export function downloadWhisperModel(
  id: string,
  onProgress?: (p: WhisperDownloadProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const def = getWhisperModelDef(id);
  if (!def) return Promise.resolve({ ok: false, error: `Unknown Whisper model: ${id}` });
  if (isWhisperModelPresent(id)) return Promise.resolve({ ok: true });

  const running = inFlightDownloads.get(id);
  if (running) {
    if (onProgress) {
      running.listeners.add(onProgress);
      if (running.lastProgress) onProgress(running.lastProgress);
    }
    return running.promise;
  }

  const entry: InFlightDownload = {
    listeners: new Set(onProgress ? [onProgress] : []),
    promise: undefined as unknown as Promise<{ ok: boolean; error?: string }>,
  };
  entry.promise = runWhisperModelDownload(id, def, (p) => {
    entry.lastProgress = p;
    for (const fn of entry.listeners) {
      try { fn(p); } catch { /* one listener's error must not starve the rest */ }
    }
  }).finally(() => inFlightDownloads.delete(id));
  inFlightDownloads.set(id, entry);
  return entry.promise;
}

/** The actual (single) download run for a model. Only called via the in-flight map. */
function runWhisperModelDownload(
  id: string,
  def: WhisperModelDef,
  onProgress: (p: WhisperDownloadProgress) => void,
): Promise<{ ok: boolean; error?: string }> {

  const dest = whisperModelDir(id);
  const totalBytes = def.sizeMB * 1024 * 1024;
  const scriptPath = resolveDownloadScript();
  const token = getHfToken();

  const py = getPythonInvocation(getDefaultE2aPath());
  const env = buildCondaSpawnEnv(token ? { HF_TOKEN: token } : {});

  return new Promise((resolve) => {
    const child = spawn(py.command, [...py.args, '-u', scriptPath, def.hfRepo, dest], {
      env,
      windowsHide: true,
    });

    // Poll the dir size for a smooth progress bar (cap at 99% until the process
    // confirms success, so we never show 100% before validation).
    const poll = setInterval(() => {
      const received = dirSizeBytes(dest);
      const pct = Math.min(99, Math.round((received / totalBytes) * 100));
      onProgress?.({ id, pct, receivedBytes: received, totalBytes });
    }, 600);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearInterval(poll);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', () => {
      clearInterval(poll);
      // The script prints a single JSON line; find the last JSON object.
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (typeof parsed.ok === 'boolean') {
            if (parsed.ok) onProgress?.({ id, pct: 100, receivedBytes: totalBytes, totalBytes });
            return resolve(parsed);
          }
        } catch {
          /* not JSON */
        }
      }
      resolve({ ok: false, error: stderr.trim().slice(-400) || 'download produced no result' });
    });
  });
}

/** Delete a model's folder (best-effort). */
export function deleteWhisperModel(id: string): { ok: boolean; error?: string } {
  if (!getWhisperModelDef(id)) return { ok: false, error: `Unknown Whisper model: ${id}` };
  try {
    fs.rmSync(whisperModelDir(id), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
