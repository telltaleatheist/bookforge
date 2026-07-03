/**
 * Whisper speech-to-text runtime — an OPTIONAL overlay into the bundled e2a env.
 *
 * The "Generate sentences" feature transcribes an audiobook m4b into a synced
 * WebVTT so the bookshelf reader can highlight text against independently-recorded
 * (non-TTS) audio. The transcriber is faster-whisper (CTranslate2 backend).
 *
 * Why an overlay (like deepspeed-xtts / cuda-tts) and NOT a new conda env:
 * the heavy native piece — ctranslate2 4.6.3 — is ALREADY bundled in the e2a env
 * (it rides in for other reasons), along with onnxruntime, tokenizers,
 * huggingface_hub, soundfile, numpy and tqdm. The only genuinely missing pieces
 * are the thin `faster-whisper` wrapper and `av` (PyAV, which bundles its own
 * ffmpeg for audio decode). So this component just pip-installs those two into the
 * runtime env — a tiny download — rather than shipping a whole second env.
 *
 * Model WEIGHTS are NOT installed here — they download from HuggingFace on demand
 * via whisper-models.ts (Systran/faster-whisper-*), same split as Voxtral/Orpheus.
 *
 * Install mechanism mirrors deepspeed-xtts: pip-install into the env with
 * `--no-deps` (every dep except the two above is already satisfied, so nothing
 * else in the env is disturbed), then verify the import. A marker file inside the
 * env records the install; because it lives in the env dir it is automatically
 * gone if the env is ever re-unpacked (app update), so the component correctly
 * reverts to "available" then. CPU works everywhere; a CUDA GPU (via the cuda-tts
 * overlay) makes transcription much faster but is not required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { getActiveBundledEnvPath } from '../e2a-env-bootstrap';
import type { OptionalComponent, InstallProgress } from './component-types';

// ── Pins ──────────────────────────────────────────────────────────────────────
// faster-whisper 1.1.1 requires ctranslate2>=4.0,<5 (env has 4.6.3) and av>=11.
// Installed with --no-deps so these constraints are honored by the already-present
// packages and pip touches ONLY faster-whisper + av. av bundles its own ffmpeg and
// has no python deps, so --no-deps is safe for it too.
const FASTER_WHISPER_VERSION = '1.1.1';

export const WHISPER_ENV_ID = 'whisper';

// Marker written inside the env on success (auto-removed if the env re-unpacks).
const MARKER = '.bookforge-whisper.json';

// Rough download footprint (faster-whisper wheel is tiny; av ~30 MB). Headline
// size for the UI + disk pre-check; model weights are separate (whisper-models.ts).
const APPROX_BYTES = 35_000_000;

// ── Catalog entry ───────────────────────────────────────────────────────────

export function whisperEnvComponent(): OptionalComponent {
  return {
    id: WHISPER_ENV_ID,
    name: 'Speech to Text',
    description:
      'Transcribes a recorded audiobook into synced on-screen text ("Generate sentences"). '
      + 'Runs on the processor, or much faster on an NVIDIA GPU. ~35 MB download; '
      + 'transcription models are downloaded separately below.',
    kind: 'binary',
    acquisition: ['managed'],
    sizeBytes: APPROX_BYTES,
    requirements: {
      // Works on every platform (CPU); a GPU just makes it faster.
      platforms: ['win32', 'darwin', 'linux'],
      gpu: 'any',
    },
    // No archive artifact — this is a pip overlay (installed by the manager's
    // fetchWhisperEnv branch, like deepspeed-xtts). The array stays empty.
    artifacts: [],
    // Cheap catalog-side check is path-exists on the marker; the real proof is the
    // faster_whisper import run at install time (see installWhisperEnv).
    verify: { kind: 'path-exists' },
    version: FASTER_WHISPER_VERSION,
    entryPath: '',
  };
}

// ── Env helpers ─────────────────────────────────────────────────────────────

/** The runtime env's python executable, or null if the env isn't unpacked. */
function envPython(): string | null {
  const envDir = getActiveBundledEnvPath();
  if (!envDir) return null;
  const py = process.platform === 'win32'
    ? path.join(envDir, 'python.exe')
    : path.join(envDir, 'bin', 'python');
  return fs.existsSync(py) ? py : null;
}

export function whisperEnvMarkerPath(): string | null {
  const envDir = getActiveBundledEnvPath();
  return envDir ? path.join(envDir, MARKER) : null;
}

/** True when the Whisper overlay is installed in the current runtime env. */
export function isWhisperEnvInstalled(): boolean {
  const m = whisperEnvMarkerPath();
  return !!m && fs.existsSync(m);
}

// ── Install ──────────────────────────────────────────────────────────────────

/**
 * pip-install faster-whisper + av into the runtime env (online, --no-deps), then
 * verify the import. Throws on any failure. After this, transcribe_audiobook.py
 * can `from faster_whisper import WhisperModel` in the e2a env.
 */
export async function installWhisperEnv(
  emit: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const py = envPython();
  if (!py) {
    throw new Error('The audiobook engine isn’t ready yet — finish first-run setup, then add speech-to-text.');
  }

  // pip resolves the latest av wheel for this platform/python; faster-whisper is
  // pinned to the version whose ctranslate2 constraint the bundled 4.6.3 meets.
  emit({ id: WHISPER_ENV_ID, phase: 'download', pct: 0, message: 'Installing speech-to-text (Whisper)…' });
  const res = spawnSync(
    py,
    ['-m', 'pip', 'install', '--no-deps', '--no-warn-script-location',
      `faster-whisper==${FASTER_WHISPER_VERSION}`, 'av'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 },
  );
  if (signal.aborted) throw new Error('Install cancelled');
  if (res.status !== 0) {
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim().slice(-1500);
    throw new Error(`pip install of Whisper failed (exit ${res.status}): ${out}`);
  }
  emit({ id: WHISPER_ENV_ID, phase: 'postinstall', pct: 100 });

  // Verify the wrapper imports against the bundled ctranslate2.
  emit({ id: WHISPER_ENV_ID, phase: 'verify-run', pct: 0, message: 'Verifying Whisper…' });
  const check = spawnSync(
    py,
    ['-c', 'import faster_whisper,sys; sys.stdout.write(getattr(faster_whisper,"__version__","ok"))'],
    { encoding: 'utf8', windowsHide: true, timeout: 180_000 },
  );
  if (check.status !== 0 || !check.stdout || !check.stdout.trim()) {
    throw new Error(`faster-whisper did not import after install: ${(check.stderr || check.stdout || '').trim().slice(-800)}`);
  }
  emit({ id: WHISPER_ENV_ID, phase: 'verify-run', pct: 100 });

  const m = whisperEnvMarkerPath();
  if (m) {
    fs.writeFileSync(m, JSON.stringify({
      version: check.stdout.trim(),
      installedAt: new Date().toISOString(),
    }, null, 2));
  }
}

/**
 * Remove the overlay: clear the marker and pip-uninstall faster-whisper + av so
 * the runtime env reverts to no-transcription. Best-effort — the marker is cleared
 * even if the uninstall can't complete (stray packages are harmless).
 */
export function uninstallWhisperEnv(): void {
  const m = whisperEnvMarkerPath();
  if (m && fs.existsSync(m)) {
    try { fs.unlinkSync(m); } catch { /* ignore */ }
  }
  const py = envPython();
  if (!py) return;
  spawnSync(
    py, ['-m', 'pip', 'uninstall', '-y', 'faster-whisper', 'av'],
    { encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 },
  );
}
