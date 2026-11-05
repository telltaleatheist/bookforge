/**
 * ONE WHOLE AUDIO FILE THROUGH AN RVC VOICE, ON A CRUCIBLE — the door behind the
 * CLI's `--rvc` (`cli/rvc-convert.js`).
 *
 * `rvc.ts` converts a directory of files that already exist. A finished audiobook
 * is one file, so this side does what it always did around the conversion:
 * (1) silence-chunks it (~`chunkSeconds` pieces, seams in silence), (2) sends the
 * chunks through {@link convertSentencesAtVenue}, (3) verifies every chunk came
 * back and stitches them in order into `outputPath`. Only the model moved
 * (docs/REORG-PLAN.md, B2): this was `rvc-bridge.convertFileRvcChunked`, which ran
 * urvc in a recycled worker on this machine's card.
 *
 * The `batchSize` that bounded that worker's memory has no wire parameter
 * (`crucible_rvc_batch_size_is_the_servers`): the server owns its own memory.
 *
 * A voice is named by its urvc FOLDER on this door, because that is what `--rvc
 * --rvc-model` has always taken. {@link rvcVoiceIdForModelFolder} maps it to the
 * asset id the Crucible table is keyed on, and a folder the catalog does not know
 * is refused by name, as an unmapped voice is.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getAllRvcVoiceAssets } from '../rvc-models';
import { getFfmpegPath, getFfprobePath } from '../tool-paths';
import type { VenueHost } from './generation-venue';
import {
  convertSentencesAtVenue, CrucibleRvcRefused,
  type ConvertSentencesAtVenueOutcome, type CrucibleRvcKnobs, type CrucibleRvcProgress,
} from './rvc';

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
    let cut = ideal;            // no nearby silence: a hard cut
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

/** The catalog's asset id for a urvc voice-model folder, or a refusal naming the folders it knows. */
export function rvcVoiceIdForModelFolder(folder: string): string {
  const assets = getAllRvcVoiceAssets();
  const found = assets.find((v) => v.modelName === folder);
  if (found === undefined) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_voice_unmapped',
      `RVC voice-model folder "${folder}" is not in the catalog. Known: `
      + `${assets.map((v) => v.modelName).join(', ')}.`,
    );
  }
  return found.id;
}

/** Run a tool to completion and hand back its stderr; a non-zero exit or an abort throws. */
function runTool(binary: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('RVC conversion cancelled')); return; }
    const child = spawn(binary, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => { child.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { signal?.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(new Error('RVC conversion cancelled')); return; }
      if (code !== 0) {
        reject(new Error(`${path.basename(binary)} exited ${code}: ${stderr.trim().slice(-500)}`));
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

export interface ConvertFileAtVenueOptions {
  /** The caller's own server NAME (`--crucible-server`). Absent, the routing record decides. */
  readonly crucible?: { readonly server: string };
  readonly host: VenueHost;
  readonly inputPath: string;
  /** Its extension picks the codec: flac, wav, or ffmpeg's own choice. */
  readonly outputPath: string;
  /** The urvc voice-model folder; see {@link rvcVoiceIdForModelFolder}. */
  readonly modelFolder: string;
  readonly knobs: CrucibleRvcKnobs;
  /** Target chunk length. Default 600 s. */
  readonly chunkSeconds?: number;
  /** The rate chunks are cut at and the stitched file is written at. Default 48000. */
  readonly sampleRate?: number;
  readonly onProgress?: (progress: CrucibleRvcProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

/** Convert one audio file on a Crucible and write the stitched result to `outputPath`. */
export async function convertFileAtVenue(
  options: ConvertFileAtVenueOptions,
): Promise<ConvertSentencesAtVenueOutcome & { readonly outputPath: string; readonly chunks: number }> {
  const { inputPath, outputPath, signal } = options;
  if (!fs.existsSync(inputPath)) throw new Error(`RVC input not found: ${inputPath}`);
  const voiceId = rvcVoiceIdForModelFolder(options.modelFolder);
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  const chunkSeconds = options.chunkSeconds ?? 600;
  const sr = options.sampleRate ?? 48000;
  const outExt = (path.extname(outputPath).replace(/^\./, '') || 'flac').toLowerCase();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rvc-chunked-'));
  const chunksIn = path.join(work, 'in');
  const chunksOut = path.join(work, 'out');
  fs.mkdirSync(chunksIn);
  fs.mkdirSync(chunksOut);
  try {
    // 1. Plan silence-aware chunk boundaries.
    const probed = await runTool(ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath], signal);
    const dur = parseFloat(probed.trim());
    if (!Number.isFinite(dur) || dur <= 0) throw new Error(`ffprobe gave no duration for ${inputPath}: ${probed.trim()}`);
    const detect = await runTool(ffmpeg,
      ['-v', 'info', '-i', inputPath, '-af', 'silencedetect=noise=-30dB:d=0.4', '-f', 'null', '-'], signal);
    const cuts = computeChunkCutPoints(parseSilenceMids(detect), dur, chunkSeconds);
    const nChunks = cuts.length - 1;

    // 2. Extract each chunk (mono, model rate) — seams fall in silence.
    const chunkName = (i: number) => `chunk_${String(i).padStart(4, '0')}.wav`;
    for (let i = 0; i < nChunks; i++) {
      // eslint-disable-next-line no-await-in-loop -- serial extraction keeps memory/disk flat
      await runTool(ffmpeg,
        ['-v', 'error', '-ss', cuts[i].toFixed(3), '-t', (cuts[i + 1] - cuts[i]).toFixed(3), '-i', inputPath,
          '-ar', String(sr), '-ac', '1', '-y', path.join(chunksIn, chunkName(i))], signal);
    }

    // 3. Convert all chunks on the server.
    const outcome = await convertSentencesAtVenue({
      ...(options.crucible === undefined ? {} : { crucible: options.crucible }),
      host: options.host,
      sentencesDir: chunksIn,
      outputDir: chunksOut,
      voiceId,
      knobs: options.knobs,
      inputGlob: '*.wav',
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(signal === undefined ? {} : { signal }),
    });

    // 4. Verify every chunk converted (never stitch a gapped book).
    const parts: string[] = [];
    for (let i = 0; i < nChunks; i++) {
      const p = path.join(chunksOut, chunkName(i));
      if (!fs.existsSync(p)) throw new Error(`RVC produced no output for chunk ${i} — refusing to stitch a gapped result`);
      parts.push(p);
    }

    // 5. Stitch in order via the concat demuxer (forward-slash paths; single-quoted).
    const listFile = path.join(work, 'concat.txt');
    fs.writeFileSync(listFile,
      parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const codec = outExt === 'flac' ? ['-c:a', 'flac'] : outExt === 'wav' ? ['-c:a', 'pcm_s16le'] : [];
    await runTool(ffmpeg,
      ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-ar', String(sr), '-ac', '1', ...codec, '-y', outputPath], signal);
    return { ...outcome, outputPath, chunks: nChunks };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
