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
 * env so RVC auto-uses the GPU; otherwise it runs on CPU. On Apple Silicon torch
 * auto-selects MPS (Metal). No device flag needed.
 *
 * Apple-Silicon memory: ultimate_rvc only freed GPU cache under
 * `if torch.cuda.is_available()`, a no-op on MPS, so Metal buffers accumulated
 * across a long convert-dir batch (a full book = 1000s of sentences) until
 * unified memory ballooned (~50 GB) into swap and RVC slowed ~5x. The env is
 * patched MPS-aware (torch.mps.empty_cache) by
 * packaging/env/patch-urvc-mps-memory.py — run at urvc-env build time. Keep that
 * patch in any rebuilt/republished urvc-env tarball.
 *
 * Spawn contract (see the env's gotchas): run the env's own `urvc` with the env
 * bin dirs on PATH (so its ffmpeg/sox resolve), `URVC_SKIP_INIT=1` (skip the
 * first-run model/sample downloads + audio-separator init), `URVC_MODELS_DIR`
 * pointing at the downloaded RVC models, and offline HF flags.
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { componentManager } from './components/component-manager';
import { RVC_ENV_ID } from './components/rvc-env';
import { relocatableEnvBinDirs, relocatableBinaryPath } from './e2a-env-bootstrap';
import { getRvcModelsDir, rvcBaseModelsReady } from './rvc-models';

/**
 * The rvc-env root, or null when the engine isn't installed.
 *
 * BOOKFORGE_RVC_ENV overrides it so `electron:dev` can point at an already-built
 * env (e.g. the `bookforge-urvc` conda env) instead of installing the managed
 * component — mirrors the BOOKFORGE_E2A_ENV dev seam.
 */
export function getRvcEnvRoot(): string | null {
  const override = process.env.BOOKFORGE_RVC_ENV?.trim();
  if (override) return override;
  return componentManager.resolveEntry(RVC_ENV_ID);
}

/**
 * The env's `urvc` console-script, or null when unavailable.
 *
 * NOTE: do NOT spawn this for actual work. pip's Windows console-script launcher
 * (`urvc.exe`) bakes the interpreter path in at install time as a `#!` shebang,
 * and our rvc-env is installed by extracting into a temp dir and moving it into
 * place — so the launcher points at a `…\Temp\bookforge-install-rvc-env-*\python.exe`
 * that no longer exists. Running it then dies with exit 1 and ZERO output (the
 * launcher fails before Python ever starts). We spawn the env's python with the
 * module instead (see {@link getRvcPython}); this path stays as an install probe.
 */
export function getUrvcPath(): string | null {
  const root = getRvcEnvRoot();
  return root ? relocatableBinaryPath(root, 'urvc') : null;
}

/** The env's `python` executable, or null when unavailable. Relocation-proof
 *  entry point for urvc — `python -m ultimate_rvc.cli.main` — that sidesteps the
 *  stale shebang baked into `urvc.exe`. */
export function getRvcPython(): string | null {
  const root = getRvcEnvRoot();
  return root ? relocatableBinaryPath(root, 'python') : null;
}

export interface RvcReadiness {
  ok: boolean;
  reason?: string;
}

/** Whether an RVC enhancement pass can actually run right now. */
export function rvcEnhancementReady(): RvcReadiness {
  const root = getRvcEnvRoot();
  if (!root) return { ok: false, reason: 'The RVC voice-enhancement engine is not installed.' };
  if (!getRvcPython()) return { ok: false, reason: 'The RVC engine is installed but its Python runtime was not found.' };
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
  /** Pitch-extraction method (rmvpe|crepe|crepe-tiny|fcpe). Default: the CLI's own
   *  (rmvpe). rmvpe is best for narration; crepe is music-oriented. */
  f0Method?: string;
  /** Input file glob (e2a sentence format). Default '*.flac'. */
  inputGlob?: string;
  /** Files per worker process before it's recycled (memory bound). Default 96. */
  batchSize?: number;
  /** Per-file progress callback. */
  onProgress?: (done: number, total: number) => void;
  /** Abort to cancel the run. */
  signal?: AbortSignal;
}

/**
 * Run the warm-model batch over `sentencesDir`, writing enhanced sentences
 * (same `{i}.<ext>` stems) into `outputDir`. Resolves with `outputDir`.
 *
 * Runs via {@link runConvertDirBatched}: instead of ONE convert-dir process over
 * the whole directory (which balloons unified memory on a full book — the MPS
 * empty_cache patch is necessary but NOT sufficient for large inputs, proven
 * 2026-07-17), it recycles the worker every `batchSize` files. Same files, same
 * names, same params as the single-process run — just memory-bounded.
 */
export function enhanceSentences(opts: EnhanceSentencesOptions): Promise<string> {
  const ready = rvcEnhancementReady();
  if (!ready.ok) return Promise.reject(new Error(ready.reason));
  const root = getRvcEnvRoot()!;
  const python = getRvcPython()!;

  fs.mkdirSync(opts.outputDir, { recursive: true });

  return runConvertDirBatched(python, root, {
    inputDir: opts.sentencesDir,
    outputDir: opts.outputDir,
    modelName: opts.modelName,
    indexRate: opts.indexRate ?? 0.5,
    protectRate: opts.protectRate ?? 0.5,
    nSemitones: opts.nSemitones ?? 0,
    f0Method: opts.f0Method,
    inputGlob: opts.inputGlob ?? '*.flac',
    outputExt: 'flac',
    // Thousands of SHORT sentences: 96 keeps model-reload overhead low while still
    // recycling often enough to bound memory across a whole book.
    batchSize: opts.batchSize ?? 96,
    onProgress: opts.onProgress,
    signal: opts.signal,
  }).then(() => opts.outputDir);
}

/** Options common to every urvc `generate convert-dir` spawn. */
interface UrvcConvertRunOpts {
  /** Per-file progress callback, driven by the `[RVC] done/total` lines. */
  onProgress?: (done: number, total: number) => void;
  /** Hands the spawned child back to the caller (e.g. so an external stop path can
   *  reap it via a process-tree kill). */
  onSpawn?: (child: ChildProcess) => void;
  /** Abort to cancel the run. */
  signal?: AbortSignal;
}

/**
 * The env vars every urvc convert spawn needs. Env bin dirs go on PATH so the
 * env's ffmpeg/ffprobe/sox resolve (the convert path prefers PATH ffmpeg over the
 * removed static-ffmpeg); both PATH and Path are set because Windows env lookups
 * are case-insensitive but Node keys aren't.
 *
 * The env bundles THREE OpenMP runtimes (torch, faiss-cpu, scikit-learn each ship
 * their own libomp). Loading more than one in a process is unsupported: on macOS
 * it SIGSEGVs in an OpenMP worker-thread barrier (__kmp_suspend_initialize_thread)
 * the moment conversion spins up its thread pool — reproduced as exit 139 on the
 * first sentence, on BOTH mps and cpu (the device was never the cause).
 * KMP_DUPLICATE_LIB_OK lets the duplicate runtimes co-load instead of aborting
 * (OMP Error #15), and a single OpenMP thread removes the cross-runtime barrier
 * that segfaults. RVC here is per-file inference (heavy work is on the torch
 * device), so serial OpenMP costs little. Set on all platforms — the duplicate
 * runtimes are bundled the same way on Windows/Linux.
 */
function urvcConvertEnv(root: string): NodeJS.ProcessEnv {
  const pathValue = [...relocatableEnvBinDirs(root), process.env.PATH || ''].join(path.delimiter);
  return {
    ...process.env,
    PATH: pathValue,
    Path: pathValue,
    URVC_SKIP_INIT: '1',
    URVC_MODELS_DIR: getRvcModelsDir(),
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    KMP_DUPLICATE_LIB_OK: 'TRUE',
    OMP_NUM_THREADS: '1',
  };
}

/**
 * Spawn the env's python running `ultimate_rvc.cli.main generate convert-dir …`
 * (via the module, NOT urvc.exe — see getUrvcPath()'s stale-shebang note) and
 * resolve on a clean exit. Shared by the directory batch (enhanceSentences) and
 * the single-file conversion (convertFileRvc); the caller builds `args`.
 */
function runUrvcConvertDir(
  python: string,
  root: string,
  args: string[],
  opts: UrvcConvertRunOpts,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(python, args, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: urvcConvertEnv(root),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    opts.onSpawn?.(child);

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
      if (code === 0) { resolve(); return; }
      reject(new Error(`RVC convert-dir exited with code ${code}: ${stderr || stdoutTail}`));
    });
  });
}

/** Build the `python -m ultimate_rvc.cli.main generate convert-dir …` argv for one
 *  input dir → output dir pass. Shared by the batched runner and the single-file path. */
function buildConvertDirArgs(o: {
  inputDir: string; outputDir: string; modelName: string;
  indexRate: number; protectRate: number; nSemitones: number;
  f0Method?: string; inputGlob: string; outputExt: string; overwrite?: boolean;
}): string[] {
  return [
    '-m', 'ultimate_rvc.cli.main',
    'generate', 'convert-dir',
    o.inputDir, o.outputDir, o.modelName,
    '--index-rate', String(o.indexRate),
    '--protect-rate', String(o.protectRate),
    '--input-glob', o.inputGlob,
    '--output-ext', o.outputExt,
    ...(o.f0Method ? ['--f0-method', o.f0Method] : []),
    ...(o.nSemitones ? ['--n-semitones', String(o.nSemitones)] : []),
    ...(o.overwrite ? ['--overwrite'] : []),
  ];
}

/** List files in `dir` matching a simple glob (only `*` wildcards, case-insensitive).
 *  Sorted for a stable, reproducible processing order. */
function listDirGlob(dir: string, glob: string): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp('^' + glob.split('*').map(esc).join('.*') + '$', 'i');
  return fs.readdirSync(dir).filter((n) => rx.test(n)).sort();
}

/** Split a file list into fixed-size batches (last batch may be short). Pure — the
 *  memory bound is one batch's worth, since each batch runs in its own process. */
export function planBatches<T>(items: T[], batchSize: number): T[][] {
  if (batchSize < 1) throw new Error(`batchSize must be >= 1 (got ${batchSize})`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

interface BatchedConvertOptions {
  inputDir: string;
  outputDir: string;
  modelName: string;
  indexRate: number;
  protectRate: number;
  nSemitones: number;
  f0Method?: string;
  inputGlob: string;
  outputExt: string;
  batchSize: number;
  onProgress?: (done: number, total: number) => void;
  onSpawn?: (child: ChildProcess) => void;
  signal?: AbortSignal;
}

/**
 * Memory-bounded convert-dir. Processes `inputDir` in batches of `batchSize`, each
 * batch in its OWN convert-dir process that EXITS before the next starts — so the OS
 * reclaims ALL of that process's memory (RAM + MPS/Metal) between batches, regardless
 * of what leaks inside it. This is the GUARANTEED fix: the env's per-file
 * torch.mps.empty_cache patch helps but is not sufficient for large inputs (a 10-min
 * chunk grew ~1.5 GB and never released; a 64 GB Mac hit swap — proven 2026-07-17).
 * The trade-off is a model reload per batch (~seconds), so batchSize trades reload
 * overhead against peak memory.
 *
 * Each batch's files are hardlinked (fallback: copied) into a fresh temp dir and
 * convert-dir writes straight into the REAL outputDir (same basenames). Every output
 * is verified before we advance — a missing one fails loudly (no silent gaps).
 */
export async function runConvertDirBatched(
  python: string,
  root: string,
  o: BatchedConvertOptions,
): Promise<void> {
  const files = listDirGlob(o.inputDir, o.inputGlob);
  if (files.length === 0) {
    throw new Error(`RVC: no input files matching '${o.inputGlob}' in ${o.inputDir}`);
  }
  fs.mkdirSync(o.outputDir, { recursive: true });

  const total = files.length;
  const batches = planBatches(files, o.batchSize);
  let done = 0;
  for (const batch of batches) {
    if (o.signal?.aborted) throw new Error('RVC enhancement cancelled');
    const tmpIn = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rvc-batch-'));
    try {
      for (const name of batch) {
        const src = path.join(o.inputDir, name);
        const dst = path.join(tmpIn, name);
        try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
      }
      const args = buildConvertDirArgs({
        inputDir: tmpIn, outputDir: o.outputDir, modelName: o.modelName,
        indexRate: o.indexRate, protectRate: o.protectRate, nSemitones: o.nSemitones,
        f0Method: o.f0Method, inputGlob: o.inputGlob, outputExt: o.outputExt, overwrite: true,
      });
      const base = done;
      // eslint-disable-next-line no-await-in-loop -- batches are intentionally serial (memory bound)
      await runUrvcConvertDir(python, root, args, {
        signal: o.signal,
        onSpawn: o.onSpawn,
        onProgress: (d) => o.onProgress?.(base + d, total),   // batch-local → global
      });
      // Verify every file in the batch produced an output before advancing.
      for (const name of batch) {
        const stem = path.basename(name, path.extname(name));
        const produced = path.join(o.outputDir, `${stem}.${o.outputExt}`);
        if (!fs.existsSync(produced)) {
          throw new Error(`RVC batch produced no output for ${name} (expected ${path.basename(produced)})`);
        }
      }
      done += batch.length;
      o.onProgress?.(done, total);
    } finally {
      try { fs.rmSync(tmpIn, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

export interface ConvertFileOptions {
  /** The single audio file to convert (e.g. an isolated voice stem). */
  inputPath: string;
  /** Where to write the converted audio. Its extension picks the output format. */
  outputPath: string;
  /** urvc voice-model folder name (e.g. 'Owen Morgan'). */
  modelName: string;
  /** Index influence (0–1). Pass 0 for index-less models. Default 0.5. */
  indexRate?: number;
  /** Consonant/breath protection (0–0.5). Default 0.5. */
  protectRate?: number;
  /** Pitch shift in semitones (default 0 — RVC carries the source pitch). */
  nSemitones?: number;
  /** Per-file progress callback ([RVC] done/total — total is 1 for a single file). */
  onProgress?: (done: number, total: number) => void;
  /** Hands the spawned child back (so the caller can reap it on stop). */
  onSpawn?: (child: ChildProcess) => void;
  /** Abort to cancel the run. */
  signal?: AbortSignal;
}

/**
 * Convert ONE audio file through an RVC voice model, writing the result to
 * `outputPath`. The fork's convert-dir is directory-oriented (one warm model
 * load, `[RVC] done/total` progress), so this points it at the input's own
 * directory with an exact `--input-glob`, writes into a throwaway output dir, and
 * relocates the single produced file to `outputPath`. Resolves with `outputPath`.
 *
 * NOTE: this does NOT take the GPU arbiter lease — the caller is expected to hold
 * it for the surrounding pipeline (as the Enhance tab does).
 */
export async function convertFileRvc(opts: ConvertFileOptions): Promise<string> {
  const ready = rvcEnhancementReady();
  if (!ready.ok) throw new Error(ready.reason);
  const root = getRvcEnvRoot()!;
  const python = getRvcPython()!;

  if (!fs.existsSync(opts.inputPath)) {
    throw new Error(`RVC conversion input not found: ${opts.inputPath}`);
  }

  const inputDir = path.dirname(opts.inputPath);
  const inputName = path.basename(opts.inputPath);
  const stem = path.basename(inputName, path.extname(inputName));
  const outExt = (path.extname(opts.outputPath).replace(/^\./, '') || 'wav').toLowerCase();

  const indexRate = opts.indexRate ?? 0.5;
  const protectRate = opts.protectRate ?? 0.5;
  const nSemitones = opts.nSemitones ?? 0;

  // Isolate the single file into its own throwaway output dir so convert-dir
  // never touches sibling stems in the input directory (the exact --input-glob
  // already restricts the input side to just this file).
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rvc-file-'));
  const producedPath = path.join(outDir, `${stem}.${outExt}`);

  const args = [
    '-m', 'ultimate_rvc.cli.main',
    'generate', 'convert-dir',
    inputDir,
    outDir,
    opts.modelName,
    '--index-rate', String(indexRate),
    '--protect-rate', String(protectRate),
    '--input-glob', inputName,
    '--output-ext', outExt,
    '--overwrite',
    ...(nSemitones ? ['--n-semitones', String(nSemitones)] : []),
  ];

  try {
    await runUrvcConvertDir(python, root, args, {
      onProgress: opts.onProgress,
      onSpawn: opts.onSpawn,
      signal: opts.signal,
    });
    if (!fs.existsSync(producedPath)) {
      throw new Error(`RVC conversion produced no output for ${inputName}.`);
    }
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.copyFileSync(producedPath, opts.outputPath);
    return opts.outputPath;
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------- whole-file chunked
// Run the env's ffmpeg/ffprobe, returning captured stderr (silencedetect) or stdout
// (ffprobe). ffmpeg is safe to kill on abort (unlike a mid-init RVC process).
function runFfmpegCapture(binary: string, root: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: urvcConvertEnv(root) });
    } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let aborted = false;
    const onAbort = () => { aborted = true; try { child.kill(); } catch { /* ignore */ } };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', reject);
    child.on('close', (code) => {
      if (aborted) { reject(new Error('RVC conversion cancelled')); return; }
      if (code === 0) { resolve(stderr); return; }
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function ffprobeDurationSeconds(ffprobe: string, root: string, file: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file];
    try {
      child = spawn(ffprobe, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: urvcConvertEnv(root) });
    } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
    let out = ''; let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    let aborted = false;
    const onAbort = () => { aborted = true; try { child.kill(); } catch { /* ignore */ } };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', reject);
    child.on('close', (code) => {
      if (aborted) { reject(new Error('RVC conversion cancelled')); return; }
      const d = parseFloat(out.trim());
      if (code === 0 && isFinite(d) && d > 0) { resolve(d); return; }
      reject(new Error(`ffprobe could not read duration of ${file} (exit ${code}): ${err.slice(-1000)}`));
    });
  });
}

/** Parse ffmpeg `silencedetect` stderr into silence-interval MIDPOINTS (seconds) —
 *  each is a safe place to cut (the seam lands in silence). Pure/testable. */
export function parseSilenceMids(stderr: string): number[] {
  const mids: number[] = [];
  let cur: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) { cur = parseFloat(m[1]); continue; }
    m = /silence_end:\s*([\d.]+)/.exec(line);
    if (m && cur !== null) { mids.push((cur + parseFloat(m[1])) / 2); cur = null; }
  }
  return mids;
}

/** Chunk boundaries [0, …, dur] for silence-aware splitting: greedily place a cut
 *  near each `chunkSeconds` mark at the nearest silence midpoint (± window); if none is
 *  close enough, a hard cut. Mirrors the proven rvc_fullbook.sh chunker. Pure/testable. */
export function computeChunkCutPoints(mids: number[], dur: number, chunkSeconds: number): number[] {
  const WIN = 180, MIN_SPACING = 150, TAIL = 90, EDGE = 30;
  const bounds: number[] = [0];
  let last = 0;
  while (last + chunkSeconds < dur - TAIL) {
    const ideal = last + chunkSeconds;
    let cut = ideal;            // fallback: hard cut if no nearby silence
    let bestDist = WIN;
    for (const m of mids) {
      if (m <= last + MIN_SPACING || m >= dur - EDGE) continue;
      const dist = Math.abs(m - ideal);
      if (dist < bestDist) { bestDist = dist; cut = m; }
    }
    bounds.push(cut);
    last = cut;
  }
  bounds.push(dur);
  return bounds;
}

export interface ConvertFileChunkedOptions {
  /** The (possibly long) audio file to convert. */
  inputPath: string;
  /** Output path; its extension picks the container/codec (.flac → flac, .wav → pcm). */
  outputPath: string;
  /** urvc voice-model folder name. */
  modelName: string;
  /** Index influence (0–1). Default 0.5. */
  indexRate?: number;
  /** Consonant/breath protection (0–0.5). Default 0.5. */
  protectRate?: number;
  /** Pitch shift in semitones. Default 0. */
  nSemitones?: number;
  /** Pitch-extraction method. Default 'rmvpe' (best for narration). */
  f0Method?: string;
  /** Silence-chunk length in seconds. Default 600 (proven under the OOM ceiling). */
  chunkSeconds?: number;
  /** Chunks per recycled worker process (memory bound). Default 4. */
  batchSize?: number;
  /** Chunk extraction / stitch sample rate. Default 48000 (RVC v2 model rate). */
  sampleRate?: number;
  /** Progress over chunks converted. */
  onProgress?: (done: number, total: number) => void;
  /** Hands each spawned child back (so a caller can reap it on stop). */
  onSpawn?: (child: ChildProcess) => void;
  /** Abort to cancel. */
  signal?: AbortSignal;
}

/**
 * Convert a WHOLE audio file through an RVC voice model, memory-safely. A single
 * convert-dir over a multi-hour file OOMs (proven), so this: (1) silence-chunks the
 * file (~chunkSeconds pieces, seams in silence), (2) converts the chunks via
 * {@link runConvertDirBatched} (recycled worker → bounded memory), and (3) stitches
 * them back in order into `outputPath`. Every chunk must convert or it fails loudly
 * (never stitches a gapped result). Mirrors the hand-run rvc_fullbook / rvc_batched
 * pipeline that reconstructed the Marked Man audiobook on a 64 GB Mac.
 */
export async function convertFileRvcChunked(opts: ConvertFileChunkedOptions): Promise<string> {
  const ready = rvcEnhancementReady();
  if (!ready.ok) throw new Error(ready.reason);
  const root = getRvcEnvRoot()!;
  const python = getRvcPython()!;
  if (!fs.existsSync(opts.inputPath)) throw new Error(`RVC input not found: ${opts.inputPath}`);
  const modelDir = path.join(getRvcModelsDir(), 'rvc', 'voice_models', opts.modelName);
  if (!fs.existsSync(modelDir)) throw new Error(`RVC voice model not found: ${modelDir}`);

  const ffmpeg = relocatableBinaryPath(root, 'ffmpeg');
  const ffprobe = relocatableBinaryPath(root, 'ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error(`RVC env at ${root} is missing ffmpeg/ffprobe`);
  const chunkSeconds = opts.chunkSeconds ?? 600;
  const batchSize = opts.batchSize ?? 4;
  const sr = opts.sampleRate ?? 48000;
  const outExt = (path.extname(opts.outputPath).replace(/^\./, '') || 'flac').toLowerCase();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rvc-chunked-'));
  const chunksIn = path.join(work, 'in');
  const chunksOut = path.join(work, 'out');
  fs.mkdirSync(chunksIn); fs.mkdirSync(chunksOut);
  try {
    // 1. Plan silence-aware chunk boundaries.
    const dur = await ffprobeDurationSeconds(ffprobe, root, opts.inputPath, opts.signal);
    const detect = await runFfmpegCapture(ffmpeg, root,
      ['-v', 'info', '-i', opts.inputPath, '-af', 'silencedetect=noise=-30dB:d=0.4', '-f', 'null', '-'],
      opts.signal);
    const cuts = computeChunkCutPoints(parseSilenceMids(detect), dur, chunkSeconds);
    const nChunks = cuts.length - 1;

    // 2. Extract each chunk (mono, model rate) — seams fall in silence.
    for (let i = 0; i < nChunks; i++) {
      if (opts.signal?.aborted) throw new Error('RVC conversion cancelled');
      const s = cuts[i]; const len = cuts[i + 1] - cuts[i];
      const dst = path.join(chunksIn, `chunk_${String(i).padStart(4, '0')}.wav`);
      // eslint-disable-next-line no-await-in-loop -- serial extraction keeps memory/disk flat
      await runFfmpegCapture(ffmpeg, root,
        ['-v', 'error', '-ss', s.toFixed(3), '-t', len.toFixed(3), '-i', opts.inputPath,
          '-ar', String(sr), '-ac', '1', '-y', dst], opts.signal);
    }

    // 3. Convert all chunks, memory-bounded (worker recycled every batchSize).
    await runConvertDirBatched(python, root, {
      inputDir: chunksIn, outputDir: chunksOut, modelName: opts.modelName,
      indexRate: opts.indexRate ?? 0.5, protectRate: opts.protectRate ?? 0.5,
      nSemitones: opts.nSemitones ?? 0, f0Method: opts.f0Method ?? 'rmvpe',
      inputGlob: '*.wav', outputExt: 'wav', batchSize,
      onProgress: opts.onProgress, onSpawn: opts.onSpawn, signal: opts.signal,
    });

    // 4. Verify every chunk converted (never stitch a gapped book).
    const parts: string[] = [];
    for (let i = 0; i < nChunks; i++) {
      const p = path.join(chunksOut, `chunk_${String(i).padStart(4, '0')}.wav`);
      if (!fs.existsSync(p)) throw new Error(`RVC produced no output for chunk ${i} — refusing to stitch a gapped result`);
      parts.push(p);
    }

    // 5. Stitch in order via the concat demuxer (forward-slash paths; single-quoted).
    const listFile = path.join(work, 'concat.txt');
    fs.writeFileSync(listFile,
      parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    fs.mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });
    const codec = outExt === 'flac' ? ['-c:a', 'flac'] : outExt === 'wav' ? ['-c:a', 'pcm_s16le'] : [];
    await runFfmpegCapture(ffmpeg, root,
      ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-ar', String(sr), '-ac', '1', ...codec, '-y', opts.outputPath], opts.signal);
    return opts.outputPath;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
