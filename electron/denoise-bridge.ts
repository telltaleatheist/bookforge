/**
 * Final-audio denoise runner (block-based mel-band roformer).
 *
 * Strips the faint background hiss that hiss-bed-trained voices reproduce
 * (Orpheus voices are trained on a deliberate ~-65 dBFS room-hiss bed —
 * load-bearing for reliable end-of-audio — so every raw render carries a hiss
 * during speech that cuts out at the digitally-silent assembly gaps). This runs
 * ONCE over a session's rendered sentence files, post-generation / pre-assembly,
 * as a sibling of the RVC enhancement pass: the denoised sentences land in a
 * separate dir (same `{i}.<ext>` stems) that either feeds the RVC pass
 * (denoise-first: RVC extracts f0/content features from its input, and input
 * noise corrupts that extraction) or goes straight to e2a assembly via
 * `--sentences_dir`. The original sentences are never mutated.
 *
 * Engine: the audio-separator package inside the RVC engine env (rvc-env) with
 * the denoise mel-band roformer — the exact model + invocation proven by the
 * seed-clip pipeline (bookforge_train/build_rvc_seeds.py). For efficiency it
 * does NOT denoise ~1,400 tiny files individually (a model load each): the
 * sentences are concatenated into ~22-minute blocks (with an offsets manifest of
 * every sentence's exact sample count), each block is denoised in ONE separator
 * process, and the "(dry)" stem is sliced back at the recorded offsets. The
 * roformer preserves timing exactly, so offset slicing is safe — and that
 * invariant is VERIFIED per block (dry frames must equal block frames).
 *
 * Rates: the model is 44.1 kHz native — feeding other rates makes its librosa
 * front-end crash — so sentences are resampled to 44.1 kHz stereo while building
 * the blocks, and each slice is resampled back to the session's own rate/channel
 * count on the way out. The dry stem is verified to still be 44.1 kHz (a
 * resampled stem would invalidate every offset).
 *
 * NO FALLBACKS: missing engine, no input files, a missing/ambiguous (dry) stem,
 * a rate or length mismatch, or a non-zero separator exit all fail the job
 * loudly. Nothing is ever silently skipped or approximated.
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

import { getRvcEnvRoot, getRvcPython } from './rvc-bridge';
import { relocatableEnvBinDirs, relocatableBinaryPath } from './e2a-env-bootstrap';
import { toUnpackedPath } from './e2a-paths';

/** The proven denoise model (44.1 kHz native — see the rate note above). */
const DENOISE_MODEL = 'denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt';

/** The model's native rate. Blocks are built at this rate; the dry stem must
 *  come back at it too. */
const DENOISE_SR = 44100;

/** Target block length. ~22 min sits in the proven 20–25 min window: long
 *  enough that model loads amortize (a full book is a handful of blocks), short
 *  enough that one separator process stays comfortably in memory. */
const BLOCK_TARGET_S = 22 * 60;

/** Where audio-separator downloads its model weights (same pinned dir as the
 *  Enhance tab's separation stage, so the weights download once, ever). */
function separatorModelDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'audio-separator-models');
}

/** The shipped run_audio_separator.py launcher (asarUnpack'd real file in
 *  packaged builds). Same resolution as the Enhance tab's — the audio-separator
 *  console script is unusable directly (no __main__ guard, stale .exe shebang). */
function resolveSeparatorLauncher(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'run_audio_separator.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'run_audio_separator.py'),
    path.join(__dirname, 'scripts', 'run_audio_separator.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('run_audio_separator.py is missing from the app bundle.');
  }
  return toUnpackedPath(found);
}

export interface DenoiseReadiness {
  ok: boolean;
  reason?: string;
}

/** Whether a final-denoise pass can run right now. The model weights themselves
 *  are NOT checked: audio-separator downloads them into the pinned model dir on
 *  first use, and a failed download exits non-zero → the job fails loudly. */
export function finalDenoiseReady(): DenoiseReadiness {
  const root = getRvcEnvRoot();
  if (!root) return { ok: false, reason: 'The RVC engine env (which carries audio-separator) is not installed.' };
  if (!getRvcPython()) return { ok: false, reason: 'The RVC engine env is installed but its Python runtime was not found.' };
  return { ok: true };
}

export interface DenoiseSentencesOptions {
  /** Directory of rendered TTS sentence files (e2a's chapters/sentences). */
  sentencesDir: string;
  /** Directory to write the denoised sentences into (created if missing). */
  outputDir: string;
  /** Block-level progress: `done` of `total` blocks fully denoised + sliced. */
  onProgress?: (done: number, total: number) => void;
  /** Abort to cancel the run (kills the in-flight separator/ffmpeg child). */
  signal?: AbortSignal;
}

/** One sentence's slot in a block: its original filename and its exact length
 *  in 44.1 kHz frames inside the concatenated block. */
interface BlockSegment {
  name: string;
  frames: number;
}

interface BlockPlan {
  /** block_<i>.wav inside the work dir. */
  blockPath: string;
  /** Total frames — must equal the sum of segment frames AND the dry stem's. */
  frames: number;
  segments: BlockSegment[];
}

/**
 * Denoise a whole sentences directory, block-based (see module docs). Writes
 * denoised sentences with the SAME basenames into `outputDir` and resolves with
 * `outputDir`. Every input must produce an output or the run fails loudly.
 */
export async function denoiseSentences(opts: DenoiseSentencesOptions): Promise<string> {
  const ready = finalDenoiseReady();
  if (!ready.ok) throw new Error(ready.reason);
  const root = getRvcEnvRoot()!;
  const python = getRvcPython()!;
  const ffmpeg = relocatableBinaryPath(root, 'ffmpeg');
  const ffprobe = relocatableBinaryPath(root, 'ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error(`RVC env at ${root} is missing ffmpeg/ffprobe`);

  // e2a sentence files are `{index}.flac` (or `.wav` on older sessions).
  const files = fs.readdirSync(opts.sentencesDir).filter((n) => /\.(flac|wav)$/i.test(n)).sort();
  if (files.length === 0) {
    throw new Error(`Final denoise: no sentence files (*.flac/*.wav) in ${opts.sentencesDir}`);
  }

  // The session's own output format — every slice is rendered back to this.
  const sessionFmt = await probeAudioFormat(ffprobe, root, path.join(opts.sentencesDir, files[0]), opts.signal);

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-denoise-'));
  const segDir = path.join(work, 'seg');
  fs.mkdirSync(segDir);
  try {
    // 1. Transcode every sentence to the model's native format (44.1 kHz stereo
    //    s16 WAV) and record its EXACT frame count from the WAV header — these
    //    counts are the offsets manifest that makes slicing sample-exact.
    const segments: BlockSegment[] = [];
    for (let i = 0; i < files.length; i++) {
      throwIfAborted(opts.signal);
      const seg = path.join(segDir, `seg_${String(i).padStart(6, '0')}.wav`);
      // eslint-disable-next-line no-await-in-loop -- serial keeps disk/CPU flat; transcode is fast
      await runFfmpeg(ffmpeg, root, [
        '-v', 'error', '-i', path.join(opts.sentencesDir, files[i]),
        '-ar', String(DENOISE_SR), '-ac', '2', '-c:a', 'pcm_s16le', '-y', seg,
      ], opts.signal);
      segments.push({ name: files[i], frames: readWavInfo(seg).frames });
    }

    // 2. Pack sentences into ~BLOCK_TARGET_S blocks (greedy, order-preserving)
    //    and concat each with `-c copy` — identical PCM segments, so the block
    //    is a byte-exact concatenation and the offsets stay sample-true (which
    //    the block header is then checked against).
    const blockTargetFrames = BLOCK_TARGET_S * DENOISE_SR;
    const blocks: BlockPlan[] = [];
    let cursor = 0;
    while (cursor < segments.length) {
      const blockStart = cursor;
      const blockSegs: BlockSegment[] = [];
      let frames = 0;
      while (cursor < segments.length && (blockSegs.length === 0 || frames + segments[cursor].frames <= blockTargetFrames)) {
        frames += segments[cursor].frames;
        blockSegs.push(segments[cursor]);
        cursor++;
      }
      const bi = blocks.length;
      const listFile = path.join(work, `concat_${bi}.txt`);
      fs.writeFileSync(listFile, blockSegs
        .map((_, j) => `file '${path.join(segDir, `seg_${String(blockStart + j).padStart(6, '0')}.wav`).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n', 'utf8');
      const blockPath = path.join(work, `block_${String(bi).padStart(2, '0')}.wav`);
      throwIfAborted(opts.signal);
      // eslint-disable-next-line no-await-in-loop -- serial: one block on disk at a time
      await runFfmpeg(ffmpeg, root, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', blockPath], opts.signal);
      const got = readWavInfo(blockPath).frames;
      if (got !== frames) {
        throw new Error(`Final denoise: block ${bi} is ${got} frames, expected ${frames} — concat drifted, offsets would be wrong.`);
      }
      blocks.push({ blockPath, frames, segments: blockSegs });
    }
    // The offsets manifest (debuggability during the run; the slicer uses the
    // in-memory plan). Mirrors the seed pipeline's blocks.json.
    fs.writeFileSync(path.join(work, 'blocks.json'), JSON.stringify({
      sr: DENOISE_SR,
      blocks: blocks.map((b) => ({ block: path.basename(b.blockPath), frames: b.frames, segments: b.segments })),
    }, null, 2));

    // 3. Denoise each block in ONE separator process, verify the (dry) stem,
    //    slice it back at the recorded offsets into the output dir.
    opts.onProgress?.(0, blocks.length);
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const dnDir = path.join(work, `dn_${String(bi).padStart(2, '0')}`);
      fs.mkdirSync(dnDir);
      throwIfAborted(opts.signal);
      // eslint-disable-next-line no-await-in-loop -- blocks are intentionally serial (one GPU process at a time)
      await runSeparator(python, root, block.blockPath, dnDir, opts.signal);

      // Exactly one (dry) stem, still at the model rate, still the block's exact
      // length — anything else invalidates the offsets. (NO FALLBACKS.)
      const dry = fs.readdirSync(dnDir).filter((n) => n.includes('(dry)'));
      if (dry.length !== 1) {
        throw new Error(`Final denoise: block ${bi} produced ${dry.length} "(dry)" stems in ${dnDir} — expected exactly 1.`);
      }
      const dryPath = path.join(dnDir, dry[0]);
      const dryInfo = readWavInfo(dryPath);
      if (dryInfo.sampleRate !== DENOISE_SR) {
        throw new Error(`Final denoise: block ${bi} dry stem is ${dryInfo.sampleRate} Hz, expected ${DENOISE_SR} — the denoiser resampled it.`);
      }
      if (dryInfo.frames !== block.frames) {
        throw new Error(`Final denoise: block ${bi} dry stem is ${dryInfo.frames} frames, expected ${block.frames} — the denoiser changed the block length.`);
      }

      // Slice back at the exact sample offsets, restoring the session's format.
      let start = 0;
      for (const seg of block.segments) {
        throwIfAborted(opts.signal);
        const outPath = path.join(opts.outputDir, seg.name);
        const codec = /\.wav$/i.test(seg.name) ? 'pcm_s16le' : 'flac';
        // eslint-disable-next-line no-await-in-loop -- serial slicing keeps disk flat; each cut is ~ms
        await runFfmpeg(ffmpeg, root, [
          '-v', 'error', '-i', dryPath,
          '-af', `atrim=start_sample=${start}:end_sample=${start + seg.frames},asetpts=PTS-STARTPTS`,
          '-ar', String(sessionFmt.sampleRate), '-ac', String(sessionFmt.channels),
          '-c:a', codec, '-y', outPath,
        ], opts.signal);
        start += seg.frames;
      }

      // Bounded disk: this block's inputs/stems are done — drop them now.
      fs.rmSync(dnDir, { recursive: true, force: true });
      fs.rmSync(block.blockPath, { force: true });
      opts.onProgress?.(bi + 1, blocks.length);
    }

    // 4. Every input must have produced an output (never hand assembly a gap).
    for (const name of files) {
      if (!fs.existsSync(path.join(opts.outputDir, name))) {
        throw new Error(`Final denoise produced no output for ${name} — refusing to continue with a gapped sentence set.`);
      }
    }
    return opts.outputDir;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Final denoise cancelled');
}

/** Env for every rvc-env spawn here: env bin dirs on PATH (its ffmpeg/librosa
 *  deps resolve), and the same OpenMP co-load guard as every other rvc-env use. */
function spawnEnv(root: string): NodeJS.ProcessEnv {
  const pathValue = [...relocatableEnvBinDirs(root), process.env.PATH || ''].join(path.delimiter);
  return {
    ...process.env,
    PATH: pathValue,
    Path: pathValue,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    KMP_DUPLICATE_LIB_OK: 'TRUE',
  };
}

/** Run a child to completion, capturing a bounded output tail for the error
 *  message. Non-zero exit / spawn error / abort all reject. */
function runChild(child: ChildProcess, what: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let tail = '';
    const onData = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let aborted = false;
    const onAbort = () => { aborted = true; try { child.kill(); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (aborted) { reject(new Error('Final denoise cancelled')); return; }
      if (code === 0) { resolve(); return; }
      reject(new Error(`${what} exited with code ${code}: ${tail.trim()}`));
    });
  });
}

function runFfmpeg(ffmpeg: string, root: string, args: string[], signal?: AbortSignal): Promise<void> {
  const child = spawn(ffmpeg, ['-nostdin', ...args], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv(root),
  });
  return runChild(child, 'ffmpeg', signal);
}

/** One separator process over one block — the exact seed-pipeline invocation. */
function runSeparator(python: string, root: string, blockPath: string, outDir: string, signal?: AbortSignal): Promise<void> {
  const modelDir = separatorModelDir();
  fs.mkdirSync(modelDir, { recursive: true });
  const child = spawn(python, [
    resolveSeparatorLauncher(),
    blockPath,
    '--model_filename', DENOISE_MODEL,
    '--output_dir', outDir,
    '--output_format', 'WAV',
    '--model_file_dir', modelDir,
  ], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv(root),
  });
  return runChild(child, 'audio-separator (denoise)', signal);
}

/** Probe an audio file's sample rate + channel count (the session format the
 *  denoised slices are rendered back to). */
function probeAudioFormat(
  ffprobe: string,
  root: string,
  file: string,
  signal?: AbortSignal,
): Promise<{ sampleRate: number; channels: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels',
      '-of', 'default=nw=1', file,
    ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv(root) });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    let aborted = false;
    const onAbort = () => { aborted = true; try { child.kill(); } catch { /* ignore */ } };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', reject);
    child.on('close', (code) => {
      if (aborted) { reject(new Error('Final denoise cancelled')); return; }
      const sr = parseInt(/sample_rate=(\d+)/.exec(out)?.[1] ?? '', 10);
      const ch = parseInt(/channels=(\d+)/.exec(out)?.[1] ?? '', 10);
      if (code === 0 && Number.isFinite(sr) && sr > 0 && Number.isFinite(ch) && ch > 0) {
        resolve({ sampleRate: sr, channels: ch });
        return;
      }
      reject(new Error(`ffprobe could not read the audio format of ${file} (exit ${code}): ${err.slice(-1000)}`));
    });
  });
}

/**
 * Exact PCM WAV info straight from the RIFF header — sample-precise (frames =
 * data-chunk bytes / block align) and instant, no decode. Only for the WAVs this
 * module writes/receives (PCM); anything unexpected errors loudly.
 */
export function readWavInfo(file: string): { sampleRate: number; channels: number; bitsPerSample: number; frames: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${file} is not a RIFF/WAVE file`);
    }
    const fileSize = fs.fstatSync(fd).size;
    let pos = 12;
    let fmt: { sampleRate: number; channels: number; bitsPerSample: number; blockAlign: number } | null = null;
    while (pos + 8 <= fileSize) {
      const hdr = Buffer.alloc(8);
      if (fs.readSync(fd, hdr, 0, 8, pos) !== 8) break;
      const id = hdr.toString('ascii', 0, 4);
      const size = hdr.readUInt32LE(4);
      if (id === 'fmt ') {
        const body = Buffer.alloc(16);
        if (fs.readSync(fd, body, 0, 16, pos + 8) !== 16) throw new Error(`${file}: truncated fmt chunk`);
        fmt = {
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          blockAlign: body.readUInt16LE(12),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (id === 'data') {
        if (!fmt) throw new Error(`${file}: data chunk before fmt chunk`);
        if (fmt.blockAlign <= 0 || size % fmt.blockAlign !== 0) {
          throw new Error(`${file}: data size ${size} is not a whole number of ${fmt.blockAlign}-byte frames`);
        }
        return {
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          bitsPerSample: fmt.bitsPerSample,
          frames: size / fmt.blockAlign,
        };
      }
      pos += 8 + size + (size % 2); // chunks are word-aligned
    }
    throw new Error(`${file}: no data chunk found`);
  } finally {
    fs.closeSync(fd);
  }
}
