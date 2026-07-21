/**
 * ClipForge Chain Engine — the ONE shared processing core.
 *
 * A "recipe" is an ordered list of processing steps (highpass, gate, loudness…).
 * Running a recipe over an input WAV produces the final output PLUS a per-stage
 * intermediate WAV for every step (this is what powers stage-soloing / A-B in the
 * UI). Every run also writes a `<output>.provenance.json` capturing the exact
 * recipe, per-step records (settings as-run, the literal ffmpeg filter used,
 * input/output sha256 + durations), the source hash, the ffmpeg version, and an
 * ISO timestamp. Provenance is the non-negotiable heart of ClipForge (the RVC
 * v1-blur archaeology happened because prep was UNRECORDED — never again).
 *
 * This module is imported by BOTH the Electron IPC layer (clipforge-bridge.ts)
 * and the headless CLI (cli/clipforge-process.js via the electron shim). It has
 * no Electron dependency of its own beyond ffmpeg/ffprobe resolution, which it
 * gets EXACTLY the way the phase-1 bridge does — getFfmpegPath()/getFfprobePath()
 * from tool-paths. Paths are never hardcoded.
 *
 * HARD RULES honoured here (project law):
 *  - NO FALLBACKS. A missing input, an unknown engine, a bad/absent setting, or a
 *    failed ffmpeg invocation is a LOUD thrown error — never a silent default, a
 *    guessed value, or a skipped step.
 *  - GPU engines (roformer denoise, resemble-enhance, RVC) are DECLARED but
 *    UNAVAILABLE in phase 2a: naming one in a recipe throws
 *    "engine X arrives in phase 2b" — it does NOT silently pass audio through.
 *  - low-pass and resample are GUARDED behind explicit allow flags (measured
 *    poison for training audio: low-pass muffles, silent resample caused the RVC
 *    blur disaster). No preset may enable them; only explicit Free-mode use.
 *  - Windows-safe: ffmpeg's null sink is `-f null -` (a dash), never `NUL`.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getFfmpegPath, getFfprobePath } from './tool-paths';

const execFileAsync = promisify(execFile);

// Bump when the provenance shape or step-record contract changes.
export const CLIPFORGE_CHAIN_VERSION = 1;
// The recipe JSON schema version this engine understands. A recipe declaring any
// other version is REJECTED (no best-effort interpretation of an unknown schema).
export const CLIPFORGE_RECIPE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Recipe + record shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface RecipeStep {
  /** Registered engine id (see STEP_REGISTRY). Unknown ids throw. */
  engine: string;
  /** Free-form settings bag validated by the engine's step function. */
  settings: Record<string, unknown>;
}

export interface Recipe {
  /** Must equal CLIPFORGE_RECIPE_VERSION. */
  recipeVersion: number;
  name: string;
  steps: RecipeStep[];
}

/** Per-step provenance record — everything needed to reproduce and audit a stage. */
export interface StepRecord {
  index: number;
  engine: string;
  settings: Record<string, unknown>;   // settings AS RUN (verbatim from the recipe)
  ffmpegFilter: string;                 // the literal ffmpeg filter/graph applied
  inputPath: string;
  outputPath: string;
  inputSha256: string;
  outputSha256: string;
  inputSizeBytes: number;
  outputSizeBytes: number;
  inputDurationSeconds: number;
  outputDurationSeconds: number;
}

export interface Provenance {
  clipforgeChainVersion: number;
  timestamp: string;                    // ISO
  ffmpegVersion: string;                // first line of `ffmpeg -version`
  recipe: Recipe;                       // verbatim
  input: {
    path: string;
    sha256: string;
    sizeBytes: number;
    durationSeconds: number;
    sampleRate: number;
    channels: number;
  };
  output: {
    path: string;
    sha256: string;
    sizeBytes: number;
    durationSeconds: number;
  };
  steps: StepRecord[];
}

export interface ChainRunResult {
  outputPath: string;
  provenancePath: string;
  provenance: Provenance;
  /** Absolute paths of the per-stage intermediates (present when keepStages). */
  stagePaths: string[];
}

export interface RunChainOptions {
  inputPath: string;
  recipe: Recipe;
  outputPath: string;
  /** Directory the per-stage intermediates are written into. Created if absent. */
  workDir: string;
  /** Keep the per-stage intermediate WAVs after the run (default false → cleaned). */
  keepStages: boolean;
  /**
   * Optional filename prefix for the per-stage intermediates (the IPC path uses a
   * recipe-tagged prefix so many runs can share one probes/ dir without colliding).
   * When omitted, stages are named `stageNN_<engine>.wav`.
   */
  stagePrefix?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small measurement / execution helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FileMeasurement {
  sha256: string;
  sizeBytes: number;
  durationSeconds: number;
}

interface ProbedAudio {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

/** Context threaded through every step (resolved binaries — never hardcoded). */
interface StepCtx {
  ffmpeg: string;
  ffprobe: string;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Run ffmpeg, throwing a loud error (with the binary + stderr tail) on failure. */
async function runFfmpeg(ffmpeg: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const tail = stderr ? `\n${stderr.split('\n').slice(-12).join('\n')}` : '';
    throw new Error(`ffmpeg failed (using ${ffmpeg}): ${e.message ?? String(err)}${tail}`);
  }
}

async function probeDurationSeconds(ffprobe: string, filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe could not determine the duration of ${path.basename(filePath)} (got "${stdout.trim()}").`);
  }
  return seconds;
}

async function probeAudio(ffprobe: string, filePath: string): Promise<ProbedAudio> {
  const { stdout } = await execFileAsync(
    ffprobe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries',
      'stream=sample_rate,channels:format=duration', '-of', 'json', filePath],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const s = (parsed.streams ?? [])[0];
  if (!s) throw new Error(`No audio stream found in ${path.basename(filePath)}.`);
  const sampleRate = s.sample_rate ? parseInt(s.sample_rate, 10) : NaN;
  const channels = typeof s.channels === 'number' ? s.channels : NaN;
  const durationSeconds = parsed.format?.duration ? parseFloat(parsed.format.duration) : NaN;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`ffprobe could not determine the sample rate of ${path.basename(filePath)}.`);
  }
  if (!Number.isFinite(channels) || channels <= 0) {
    throw new Error(`ffprobe could not determine the channel count of ${path.basename(filePath)}.`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe could not determine the duration of ${path.basename(filePath)}.`);
  }
  return { sampleRate, channels, durationSeconds };
}

async function measureFile(ctx: StepCtx, filePath: string): Promise<FileMeasurement> {
  if (!fsSync.existsSync(filePath)) {
    throw new Error(`Expected file does not exist: ${filePath}`);
  }
  const [sha256, stat, durationSeconds] = await Promise.all([
    hashFile(filePath),
    fs.stat(filePath),
    probeDurationSeconds(ctx.ffprobe, filePath),
  ]);
  return { sha256, sizeBytes: stat.size, durationSeconds };
}

async function ffmpegVersionLine(ffmpeg: string): Promise<string> {
  const { stdout } = await execFileAsync(ffmpeg, ['-version'], { maxBuffer: 1024 * 1024, windowsHide: true });
  const first = stdout.split('\n')[0]?.trim();
  if (!first) throw new Error(`Could not read ffmpeg version from ${ffmpeg}.`);
  return first;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings validators (LOUD — every one throws on absent/wrong-typed input)
// ─────────────────────────────────────────────────────────────────────────────

function reqNumber(settings: Record<string, unknown>, key: string, engine: string): number {
  const v = settings[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${engine}: setting "${key}" must be a finite number (got ${JSON.stringify(v)}).`);
  }
  return v;
}

function reqPositive(settings: Record<string, unknown>, key: string, engine: string): number {
  const v = reqNumber(settings, key, engine);
  if (v <= 0) throw new Error(`${engine}: setting "${key}" must be > 0 (got ${v}).`);
  return v;
}

function reqTrue(settings: Record<string, unknown>, key: string, engine: string, why: string): void {
  if (settings[key] !== true) throw new Error(why);
}

/** Reject a setting we cannot honestly apply, rather than silently ignoring it. */
function rejectSetting(settings: Record<string, unknown>, key: string, engine: string, why: string): void {
  if (key in settings) throw new Error(`${engine}: setting "${key}" is not supported — ${why}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg step primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Apply a single `-af` filter chain, preserving sample rate + channels. */
async function applyFilter(
  ctx: StepCtx,
  filter: string,
  inputPath: string,
  outputPath: string,
  extraOutputArgs: string[] = [],
): Promise<void> {
  await runFfmpeg(ctx.ffmpeg, [
    '-y', '-hide_banner',
    '-i', inputPath,
    '-af', filter,
    '-c:a', 'pcm_s16le',
    ...extraOutputArgs,
    '-f', 'wav',
    outputPath,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// silence_truncate — find long gaps with silencedetect, cut them in ONE graph
// ─────────────────────────────────────────────────────────────────────────────

interface SilenceInterval { start: number; end: number; }

/** Parse silencedetect stderr into [start,end] intervals (end→duration if open). */
function parseSilenceIntervals(stderr: string, totalDuration: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) {
      pendingStart = parseFloat(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (endMatch && pendingStart !== null) {
      intervals.push({ start: Math.max(0, pendingStart), end: parseFloat(endMatch[1]) });
      pendingStart = null;
    }
  }
  // A silence that runs to EOF has a start but no end.
  if (pendingStart !== null) intervals.push({ start: Math.max(0, pendingStart), end: totalDuration });
  return intervals;
}

/**
 * silence_truncate: internal silences longer than maxSilenceS (measured at/below
 * thresholdDb) are shortened to keepS; leading/trailing silence is likewise
 * trimmed to keepS. Mirrors the RVC prep rule (native rate + internal-silence
 * truncation, ~-42 dB, >0.25 s). We DETECT with silencedetect, then cut in a
 * single filter_complex atrim/concat graph — the audio is never decoded in JS.
 */
async function stepSilenceTruncate(
  ctx: StepCtx,
  settings: Record<string, unknown>,
  inputPath: string,
  outputPath: string,
): Promise<{ ffmpegFilter: string }> {
  const engine = 'silence_truncate';
  const thresholdDb = reqNumber(settings, 'thresholdDb', engine);   // e.g. -42
  const maxSilenceS = reqPositive(settings, 'maxSilenceS', engine);  // gaps longer than this get cut
  const keepS = reqPositive(settings, 'keepS', engine);             // shortened-to length
  if (keepS >= maxSilenceS) {
    throw new Error(`${engine}: keepS (${keepS}) must be < maxSilenceS (${maxSilenceS}); otherwise nothing is ever shortened.`);
  }

  const totalDuration = await probeDurationSeconds(ctx.ffprobe, inputPath);

  // Pass 1: detect silences of at least maxSilenceS at/below thresholdDb.
  const detectFilter = `silencedetect=noise=${thresholdDb}dB:d=${maxSilenceS}`;
  const { stderr } = await runFfmpeg(ctx.ffmpeg, [
    '-hide_banner', '-i', inputPath, '-af', detectFilter, '-f', 'null', '-',
  ]);
  const silences = parseSilenceIntervals(stderr, totalDuration);

  // Each detected silence keeps only keepS; the excess [start+keepS, end] is dropped.
  const drops: SilenceInterval[] = [];
  for (const s of silences) {
    const dropStart = s.start + keepS;
    if (dropStart < s.end) drops.push({ start: dropStart, end: s.end });
  }

  if (drops.length === 0) {
    // No gap exceeded keepS — nothing to cut. Re-encode with a no-op filter so we
    // still produce a real intermediate (and record an honest filter string).
    await applyFilter(ctx, 'anull', inputPath, outputPath);
    return { ffmpegFilter: `${detectFilter} (no gaps > keepS; anull)` };
  }

  // KEEP intervals = complement of the drops within [0, totalDuration].
  drops.sort((a, b) => a.start - b.start);
  const keeps: SilenceInterval[] = [];
  let cursor = 0;
  for (const d of drops) {
    if (d.start > cursor) keeps.push({ start: cursor, end: d.start });
    cursor = Math.max(cursor, d.end);
  }
  if (cursor < totalDuration) keeps.push({ start: cursor, end: totalDuration });
  if (keeps.length === 0) {
    throw new Error(`${engine}: computed an empty keep-set (all audio classified as droppable silence). Refusing to emit silence.`);
  }

  // Single filter_complex: atrim each keep segment, reset PTS, concat.
  const trims = keeps
    .map((k, i) => `[0:a]atrim=start=${k.start.toFixed(6)}:end=${k.end.toFixed(6)},asetpts=PTS-STARTPTS[s${i}]`);
  const labels = keeps.map((_k, i) => `[s${i}]`).join('');
  const graph = `${trims.join(';')};${labels}concat=n=${keeps.length}:v=0:a=1[out]`;

  await runFfmpeg(ctx.ffmpeg, [
    '-y', '-hide_banner',
    '-i', inputPath,
    '-filter_complex', graph,
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    outputPath,
  ]);
  return { ffmpegFilter: `detect: ${detectFilter}; cut: ${graph}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step registry
// ─────────────────────────────────────────────────────────────────────────────

type StepFn = (
  ctx: StepCtx,
  settings: Record<string, unknown>,
  inputPath: string,
  outputPath: string,
) => Promise<{ ffmpegFilter: string }>;

interface StepEntry {
  /** false → declared but not runnable in this phase (its run throws loudly). */
  available: boolean;
  run: StepFn;
  description: string;
}

/** Throwing stub for engines that arrive in a later phase (NO silent pass-through). */
function phase2bStub(engine: string): StepEntry {
  return {
    available: false,
    description: `${engine} (GPU) — arrives in phase 2b`,
    run: async () => {
      throw new Error(`engine "${engine}" arrives in phase 2b — it is declared but not available in phase 2a.`);
    },
  };
}

export const STEP_REGISTRY: Record<string, StepEntry> = {
  // ── phase-2a ffmpeg engines ────────────────────────────────────────────────
  highpass: {
    available: true,
    description: 'High-pass filter (freq Hz)',
    run: async (ctx, settings, input, output) => {
      const freq = reqPositive(settings, 'freq', 'highpass');
      const filter = `highpass=f=${freq}`;
      await applyFilter(ctx, filter, input, output);
      return { ffmpegFilter: filter };
    },
  },

  lowpass: {
    available: true,
    description: 'Low-pass filter (freq Hz) — GUARDED (allowLowpass)',
    run: async (ctx, settings, input, output) => {
      reqTrue(
        settings, 'allowLowpass', 'lowpass',
        'lowpass: low-pass filtering is BANNED for Orpheus training audio (measured muffle). ' +
        'No preset may enable it. Set settings.allowLowpass=true to force it in Free mode.',
      );
      const freq = reqPositive(settings, 'freq', 'lowpass');
      const filter = `lowpass=f=${freq}`;
      await applyFilter(ctx, filter, input, output);
      return { ffmpegFilter: filter };
    },
  },

  eq: {
    available: true,
    description: 'Parametric EQ — array of {freq, width, gain}',
    run: async (ctx, settings, input, output) => {
      const bands = settings['bands'];
      if (!Array.isArray(bands) || bands.length === 0) {
        throw new Error('eq: setting "bands" must be a non-empty array of {freq, width, gain}.');
      }
      const parts = bands.map((raw, i) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new Error(`eq: bands[${i}] must be an object {freq, width, gain}.`);
        }
        const band = raw as Record<string, unknown>;
        const freq = reqPositive(band, 'freq', `eq.bands[${i}]`);
        const width = reqPositive(band, 'width', `eq.bands[${i}]`);
        const gain = reqNumber(band, 'gain', `eq.bands[${i}]`);
        return `equalizer=f=${freq}:width_type=h:w=${width}:g=${gain}`;
      });
      const filter = parts.join(',');
      await applyFilter(ctx, filter, input, output);
      return { ffmpegFilter: filter };
    },
  },

  gate: {
    available: true,
    description: 'Noise gate (thresholdDb, attackMs, releaseMs) — ffmpeg agate',
    run: async (ctx, settings, input, output) => {
      const engine = 'gate';
      const thresholdDb = reqNumber(settings, 'thresholdDb', engine);
      const attackMs = reqPositive(settings, 'attackMs', engine);
      const releaseMs = reqPositive(settings, 'releaseMs', engine);
      // ffmpeg's agate has NO hold parameter; refuse rather than silently ignore.
      rejectSetting(settings, 'holdMs', engine, 'ffmpeg agate has no hold parameter.');
      rejectSetting(settings, 'hold', engine, 'ffmpeg agate has no hold parameter.');
      // agate threshold is a linear amplitude ratio (0..1), so convert from dB.
      const thresholdLin = Math.pow(10, thresholdDb / 20);
      const filter = `agate=threshold=${thresholdLin.toFixed(6)}:attack=${attackMs}:release=${releaseMs}`;
      await applyFilter(ctx, filter, input, output);
      return { ffmpegFilter: filter };
    },
  },

  silence_truncate: {
    available: true,
    description: 'Shorten internal/edge silences (maxSilenceS, thresholdDb → keepS)',
    run: stepSilenceTruncate,
  },

  loudness: {
    available: true,
    description: 'Loudness — mode "loudnorm" (I/TP/LRA) or "gain" (gainDb)',
    run: async (ctx, settings, input, output) => {
      const engine = 'loudness';
      const mode = settings['mode'];
      if (mode !== 'loudnorm' && mode !== 'gain') {
        throw new Error(`loudness: setting "mode" must be "loudnorm" or "gain" (got ${JSON.stringify(mode)}).`);
      }
      let filter: string;
      if (mode === 'loudnorm') {
        const I = reqNumber(settings, 'I', engine);
        const TP = reqNumber(settings, 'TP', engine);
        const LRA = reqPositive(settings, 'LRA', engine);
        filter = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
      } else {
        const gainDb = reqNumber(settings, 'gainDb', engine);
        filter = `volume=${gainDb}dB`;
      }
      await applyFilter(ctx, filter, input, output);
      return { ffmpegFilter: filter };
    },
  },

  resample: {
    available: true,
    description: 'Resample to an EXPLICIT rate — GUARDED (allowResample)',
    run: async (ctx, settings, input, output) => {
      reqTrue(
        settings, 'allowResample', 'resample',
        'resample: silent resampling caused the RVC blur disaster — native rate is the law. ' +
        'No preset may enable it. Set settings.allowResample=true to force it in Free mode.',
      );
      const rate = reqPositive(settings, 'rate', 'resample');
      const filter = `aresample=${rate}`;
      await applyFilter(ctx, filter, input, output, ['-ar', String(rate)]);
      return { ffmpegFilter: `${filter} (-ar ${rate})` };
    },
  },

  // ── phase-2b GPU engines: declared, NOT available ───────────────────────────
  roformer_denoise: phase2bStub('roformer_denoise'),
  resemble_enhance: phase2bStub('resemble_enhance'),
  rvc: phase2bStub('rvc'),
};

/** Public list of registered engines + availability (for UI / CLI introspection). */
export function listEngines(): Array<{ engine: string; available: boolean; description: string }> {
  return Object.entries(STEP_REGISTRY).map(([engine, e]) => ({
    engine,
    available: e.available,
    description: e.description,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipe validation
// ─────────────────────────────────────────────────────────────────────────────

/** Validate a recipe's SHAPE up front (loud on anything malformed). */
export function validateRecipe(recipe: unknown): Recipe {
  if (typeof recipe !== 'object' || recipe === null) {
    throw new Error('Recipe must be an object.');
  }
  const r = recipe as Record<string, unknown>;
  if (r.recipeVersion !== CLIPFORGE_RECIPE_VERSION) {
    throw new Error(`Unsupported recipeVersion ${JSON.stringify(r.recipeVersion)} — this engine understands version ${CLIPFORGE_RECIPE_VERSION}.`);
  }
  if (typeof r.name !== 'string' || !r.name.trim()) {
    throw new Error('Recipe "name" must be a non-empty string.');
  }
  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    throw new Error('Recipe "steps" must be a non-empty array.');
  }
  r.steps.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Recipe step ${i} must be an object { engine, settings }.`);
    }
    const step = raw as Record<string, unknown>;
    if (typeof step.engine !== 'string' || !step.engine) {
      throw new Error(`Recipe step ${i} is missing a string "engine".`);
    }
    if (!(step.engine in STEP_REGISTRY)) {
      throw new Error(`Recipe step ${i}: unknown engine "${step.engine}". Known engines: ${Object.keys(STEP_REGISTRY).join(', ')}.`);
    }
    if (typeof step.settings !== 'object' || step.settings === null || Array.isArray(step.settings)) {
      throw new Error(`Recipe step ${i} ("${step.engine}") must have a "settings" object.`);
    }
  });
  return { recipeVersion: CLIPFORGE_RECIPE_VERSION, name: r.name, steps: r.steps as RecipeStep[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// The chain runner
// ─────────────────────────────────────────────────────────────────────────────

function padIndex(i: number): string {
  return String(i).padStart(2, '0');
}

/**
 * Run a recipe over an input WAV. Produces the final output at outputPath, one
 * intermediate WAV per stage in workDir, and a `<output>.provenance.json`.
 */
export async function runChain(opts: RunChainOptions): Promise<ChainRunResult> {
  const { inputPath, outputPath, workDir, keepStages } = opts;

  if (!fsSync.existsSync(inputPath)) {
    throw new Error(`ClipForge chain: input file does not exist: ${inputPath}`);
  }
  const recipe = validateRecipe(opts.recipe);

  const ctx: StepCtx = { ffmpeg: getFfmpegPath(), ffprobe: getFfprobePath() };

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const ffmpegVersion = await ffmpegVersionLine(ctx.ffmpeg);
  const inputAudio = await probeAudio(ctx.ffprobe, inputPath);
  const inputMeasure = await measureFile(ctx, inputPath);

  const steps: StepRecord[] = [];
  const stagePaths: string[] = [];
  let currentInput = inputPath;
  let currentInputMeasure = inputMeasure;

  try {
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      const entry = STEP_REGISTRY[step.engine];
      // (validateRecipe already guaranteed the engine exists.)
      const stageBase = opts.stagePrefix
        ? `${opts.stagePrefix}__stage${padIndex(i)}_${step.engine}`
        : `stage${padIndex(i)}_${step.engine}`;
      const stagePath = path.join(workDir, `${stageBase}.wav`);

      // entry.run throws for unavailable engines (phase-2b stubs) — no skip.
      const { ffmpegFilter } = await entry.run(ctx, step.settings, currentInput, stagePath);
      if (!fsSync.existsSync(stagePath)) {
        throw new Error(`Stage ${i} ("${step.engine}") reported success but produced no output at ${stagePath}.`);
      }

      const stageMeasure = await measureFile(ctx, stagePath);
      steps.push({
        index: i,
        engine: step.engine,
        settings: step.settings,
        ffmpegFilter,
        inputPath: currentInput,
        outputPath: stagePath,
        inputSha256: currentInputMeasure.sha256,
        outputSha256: stageMeasure.sha256,
        inputSizeBytes: currentInputMeasure.sizeBytes,
        outputSizeBytes: stageMeasure.sizeBytes,
        inputDurationSeconds: currentInputMeasure.durationSeconds,
        outputDurationSeconds: stageMeasure.durationSeconds,
      });
      stagePaths.push(stagePath);
      currentInput = stagePath;
      currentInputMeasure = stageMeasure;
    }

    // Final output = the last stage's audio, copied to the caller's outputPath.
    const lastStage = stagePaths[stagePaths.length - 1];
    await fs.copyFile(lastStage, outputPath);
    const outputMeasure = await measureFile(ctx, outputPath);

    const provenance: Provenance = {
      clipforgeChainVersion: CLIPFORGE_CHAIN_VERSION,
      timestamp: new Date().toISOString(),
      ffmpegVersion,
      recipe,
      input: {
        path: inputPath,
        sha256: inputMeasure.sha256,
        sizeBytes: inputMeasure.sizeBytes,
        durationSeconds: inputMeasure.durationSeconds,
        sampleRate: inputAudio.sampleRate,
        channels: inputAudio.channels,
      },
      output: {
        path: outputPath,
        sha256: outputMeasure.sha256,
        sizeBytes: outputMeasure.sizeBytes,
        durationSeconds: outputMeasure.durationSeconds,
      },
      steps,
    };

    const provenancePath = `${outputPath}.provenance.json`;
    await fs.writeFile(provenancePath, JSON.stringify(provenance, null, 2), 'utf-8');

    if (!keepStages) {
      for (const p of stagePaths) {
        try { await fs.unlink(p); } catch { /* best-effort cleanup */ }
      }
    }

    return {
      outputPath,
      provenancePath,
      provenance,
      stagePaths: keepStages ? stagePaths : [],
    };
  } catch (err) {
    // On failure, leave nothing half-written that could masquerade as a good run.
    for (const p of stagePaths) {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }
    throw err;
  }
}
