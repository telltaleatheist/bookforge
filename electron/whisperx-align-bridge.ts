/**
 * WhisperX force-alignment bridge — aligns a project's EPUB text to its audiobook
 * to produce ACCURATE read-along subtitles.
 *
 * Unlike the whisper transcription path (generate-sentences-bridge), which infers
 * the words from the audio (and so inherits ASR spelling/word errors), this path
 * takes the ebook as ground truth: it extracts the ebook's sentences in reading
 * order, hands them to `align_audiobook.py` (WhisperX rough-transcribe → coarse
 * DTW align → per-sentence forced alignment), and gets back a VTT whose text is
 * the ebook's own words with real audio timings.
 *
 * The heavy lifting runs in the CPU-only `whisperx-env` conda env; this bridge
 * resolves the env's python + the packaged script, spawns it, and translates the
 * script's STDOUT progress protocol into 'generate-sentences:progress' events.
 * The caller (startGenerateSentences) owns embed + manifest linking + completion.
 */

import { BrowserWindow, app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { loadEpubForComparison } from './epub-processor.js';
import { componentManager } from './components/component-manager.js';
import { namedCondaEnvCandidates } from './components/conda-env-detect.js';
import * as manifestService from './manifest-service.js';
import { toUnpackedPath } from './e2a-paths.js';
import { getFfmpegPath } from './tool-paths.js';
import { GenerateSentencesConfig, sendProgress, glog, gerror, AlignStageProgress } from './generate-sentences-bridge.js';

/** Managed-component id for the CPU-only WhisperX alignment env. */
export const WHISPERX_ENV_ID = 'whisperx-env';

/** Resolve the python executable inside a conda env root (mirrors component-manager's envPython). */
function envPython(envRoot: string): string {
  if (os.platform() === 'win32') {
    const direct = path.join(envRoot, 'python.exe');
    if (fs.existsSync(direct)) return direct;
    const scripts = path.join(envRoot, 'Scripts', 'python.exe');
    if (fs.existsSync(scripts)) return scripts;
    return direct; // best guess
  }
  return path.join(envRoot, 'bin', 'python');
}

/**
 * Resolve the WhisperX env root, in order of preference:
 *   1. the installed managed component (production),
 *   2. WHISPERX_ENV_PATH (explicit dev override),
 *   3. a local `whisperx` conda env auto-detected on disk (dev convenience).
 * Each candidate is only accepted if its python actually exists.
 */
function resolveWhisperxEnvRoot(): string | null {
  const managed = componentManager.resolveEntry(WHISPERX_ENV_ID);
  if (managed && fs.existsSync(envPython(managed))) return managed;

  const override = process.env.WHISPERX_ENV_PATH;
  if (override && fs.existsSync(envPython(override))) return override;

  for (const c of namedCondaEnvCandidates('whisperx')) {
    if (c.platform === process.platform && fs.existsSync(envPython(c.path))) {
      glog(`[epub-align] auto-detected whisperx env at ${c.path}`);
      return c.path;
    }
  }
  return null;
}

/** Locate align_audiobook.py in dev (electron/scripts) or packaged (dist/electron/scripts, asarUnpack'd). */
function resolveAlignScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'align_audiobook.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'align_audiobook.py'),
    path.join(__dirname, 'scripts', 'align_audiobook.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  // Packaged: the spawned python can't read inside app.asar — hand it the
  // asarUnpack'd real file (dist/electron/scripts/** is unpacked).
  return toUnpackedPath(found);
}

/**
 * Split a block of plain ebook text into sentences (reading order). Normalizes
 * whitespace, then splits on sentence-final punctuation followed by whitespace and
 * an opening capital/quote. Simple and robust — the aligner is tolerant of rough
 * boundaries, and keeping this cheap avoids dragging in an NLP dependency.
 *
 * Scene-break glyphs (`*`, `* * *`, `⁂`, `•`) between sentences are treated as
 * part of the separator and dropped. Gluing across them was an alignment trap:
 * `"She made us all love her." * Up in the director's gallery…` became ONE
 * sentence whose opening tokens belong to the PREVIOUS scene — and a scene seam
 * is exactly where dramatized audiobooks put music bridges, so the aligner keyed
 * the new scene's first cue on words that are never spoken there.
 */
function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?…]["”'’]?|["”])\s+(?:[*⁂•#]+\s+)*(?=[A-Z“"'‘“])/)
    // A scene-break glyph run at the very start of a piece has no preceding
    // terminator to hang the split on — strip it rather than let it poison the
    // sentence's opening tokens.
    .map((s) => s.replace(/^(?:[*⁂•#]+\s+)+/, '').trim())
    // Drop empties and trivial heading-only fragments (a lone number / single
    // short token with no sentence punctuation) that carry no alignable speech.
    .filter((s) => s.length > 1 && /[A-Za-z]/.test(s));
}

/** Map the script's STAGE names to friendly progress messages. */
function stageMessage(stage: string): string {
  switch (stage) {
    case 'prepare': return 'Preparing audio…';
    case 'transcribe': return 'Transcribing narration…';
    case 'coarse-align': return 'Aligning your ebook to the audio…';
    case 'align': return 'Aligning your ebook to the audio…';
    case 'write': return 'Writing subtitles…';
    default: return 'Aligning your ebook to the audio…';
  }
}

/**
 * The five pipeline stages, in order, each rendered as its own stacked bar. The
 * `weight` values are the stage's share of wall-clock time (they sum to 1) and
 * drive the headline master bar as a duration-weighted average of the per-stage
 * fractions — so it tracks real elapsed progress instead of lurching when the two
 * near-instant stages (prepare/coarse-align/write) snap to 100%. A flat average
 * would jump the master bar 40% for ~2s of actual work; these weights don't.
 */
const ALIGN_STAGES: ReadonlyArray<{ name: string; label: string; weight: number }> = [
  { name: 'prepare', label: 'Preparing audio', weight: 0.03 },
  { name: 'transcribe', label: 'Transcribing narration', weight: 0.45 },
  { name: 'coarse-align', label: 'Matching text to audio', weight: 0.04 },
  { name: 'align', label: 'Fine-aligning', weight: 0.46 },
  { name: 'write', label: 'Writing subtitles', weight: 0.02 },
];

interface AlignResult {
  ok: boolean;
  vtt?: string;
  cues?: number;
  fallbackCues?: number;
  trimmedHead?: number;
  trimmedTail?: number;
  aligned?: number;
  /** ok:false — the script's terminal error message. */
  error?: string;
  /** Rough-transcribe slices that errored (each ≈10 min of audio missing from the anchor stream). */
  failedSlices?: number;
  totalSlices?: number;
  /** Align chunks that errored (their sentences carry coarse timing, not forced alignment). */
  failedChunks?: number;
  totalChunks?: number;
  /** Drift self-check: cues verified against the rough transcript / worst pre-fix offset / cues corrected. */
  driftChecked?: number;
  driftMaxAbs?: number;
  driftFixed?: number;
  /** Path of the coverage report the script wrote (only when --report was passed). */
  report?: string | null;
}

/**
 * Force-align the ebook variant identified by `config.epubVariantId` to the
 * audiobook at `config.m4bPath`. Returns the produced VTT path + cue count.
 * Throws with a clear message if the engine is missing, the variant can't be
 * resolved, or the script fails — the caller catches and falls back to whisper.
 */
export async function runEpubAlign(
  jobId: string,
  win: BrowserWindow,
  config: GenerateSentencesConfig,
): Promise<{ vttPath: string; cues: number; warning?: string }> {
  if (!config.epubVariantId) throw new Error('epub-align requires an ebook variant id');

  // 1. Resolve the ebook variant → absolute epub path. (The file-based work lives in
  // runEpubAlignOnFiles so the headless CLI can align an arbitrary epub+audio pair
  // without a project manifest.)
  const mf = await manifestService.getManifest(config.projectId);
  if (!mf.success || !mf.manifest) {
    throw new Error(mf.error || `Project not found: ${config.projectId}`);
  }
  const { variants } = manifestService.getVariants(mf.manifest);
  const variant = variants.find((v) => v.id === config.epubVariantId);
  if (!variant) throw new Error(`Ebook variant not found: ${config.epubVariantId}`);
  if (variant.kind !== 'ebook') {
    throw new Error(`Variant ${config.epubVariantId} is not an ebook (kind=${variant.kind})`);
  }
  const epubPath = manifestService.resolveManifestPath(config.projectId, variant.path);
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);

  return runEpubAlignOnFiles(jobId, win, epubPath, config.m4bPath, config.language);
}

/**
 * File-based epub→audio forced alignment: everything runEpubAlign does AFTER the
 * manifest lookup. Takes explicit paths so the headless CLI (and any future caller
 * without a project) can drive the REAL alignment pipeline. `win` is only an event
 * sink (sendProgress guards isDestroyed) — a headless caller passes a stub.
 *
 * `opts.reportPath`: also write a coverage-report JSON there — which epub
 * sentence runs were never narrated and which audio ranges have no epub match
 * (ads/intros/disc breaks), each with text + timestamp anchors. The script fills
 * everything except the epub path (it only sees extracted sentences), which is
 * patched in here after a successful run.
 * `opts.holeMinS`: minimum unmatched-audio duration (s) treated as a hole — both
 * for the report and for whisper-fallback cue filling. 0 = every positive gap.
 * `opts.roughCachePath`: opt-in — cache the rough whisper transcript (words + segs
 * + lang) at this path so re-runs skip the ~30-40 min transcribe pass. Absent =
 * no caching (no behavior change). The caller supplies an explicit path.
 * `opts.alignWorkers`: opt-in override for the parallel align worker count. Absent
 * = the script auto-sizes (conservative: reserves 12 GB headroom for a concurrent
 * WSL vLLM lane, so it may pick 1 worker even with RAM free). Pass a positive int
 * only when the GPU/WSL lane is known idle; each worker budgets ~5 GB and the pool
 * self-shrinks under memory pressure regardless.
 */
export async function runEpubAlignOnFiles(
  jobId: string,
  win: BrowserWindow,
  epubPath: string,
  audioPath: string,
  language?: string,
  opts?: { reportPath?: string; holeMinS?: number; roughCachePath?: string; alignWorkers?: number; device?: string },
): Promise<{ vttPath: string; cues: number; warning?: string; reportPath?: string }> {
  const reportPath = opts?.reportPath;
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);
  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

  // 2. Extract sentences from the ebook in reading order.
  glog(`[epub-align] extracting sentences from ${epubPath}`);
  const { chapters } = await loadEpubForComparison(epubPath);
  const fullText = chapters.map((c) => c.text).join('\n');
  const sentences = splitSentences(fullText);
  if (sentences.length === 0) throw new Error('No sentences extracted from the ebook');
  glog(`[epub-align] extracted ${sentences.length} sentences`);

  // 3. Resolve the whisperx env python.
  const envRoot = resolveWhisperxEnvRoot();
  if (!envRoot) {
    throw new Error(
      'WhisperX alignment engine is not installed. Install it in Settings → Add-ons (or set WHISPERX_ENV_PATH for dev).',
    );
  }
  const python = envPython(envRoot);
  const scriptPath = resolveAlignScript();

  // 4. Write the sentences to a temp JSON file (cleaned up in finally).
  const sentsJsonPath = path.join(os.tmpdir(), `bookforge-align-${jobId}-${Date.now()}.json`);
  fs.writeFileSync(sentsJsonPath, JSON.stringify(sentences), 'utf-8');

  // VTT is a temporary build artifact. Generate Sentences embeds it into the m4b
  // and removes it; no persistent sidecar belongs in the project output folder.
  const m4bPath = audioPath;
  const outVtt = path.join(os.tmpdir(), `bookforge-align-${jobId}-${Date.now()}.vtt`);

  const langCode = language && language !== 'auto' ? language : 'en';

  // Managed torch cache so the wav2vec2 align model (~378 MB, fetched on first
  // use) persists in the app's runtime folder instead of the user's ~/.cache.
  // torch stores it at <TORCH_HOME>/hub/checkpoints/.
  const torchHome = path.join(app.getPath('userData'), 'runtime', 'whisperx-cache');
  try { fs.mkdirSync(torchHome, { recursive: true }); } catch { /* best-effort */ }

  // Put the app's bundled ffmpeg/ffprobe on PATH so the script's slicing calls
  // AND whisperx.load_audio's internal ffmpeg resolve correctly (packaged apps
  // don't have ffmpeg on the system PATH).
  let ffmpegDir = '';
  try { ffmpegDir = path.dirname(getFfmpegPath()); } catch { /* fall back to system ffmpeg */ }
  const spawnPath = ffmpegDir ? `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}` : (process.env.PATH || '');

  glog(`[epub-align] spawning python=${python} script=${scriptPath} lang=${langCode} out=${outVtt}`);

  try {
    return await new Promise<{ vttPath: string; cues: number; warning?: string; reportPath?: string }>((resolve, reject) => {
      const args = [
        scriptPath,
        '--audio', m4bPath,
        '--sentences', sentsJsonPath,
        '--out', outVtt,
        '--rough-model', 'base',
        '--lang', langCode,
      ];
      if (reportPath) args.push('--report', reportPath);
      // Explicit compute device (cpu|mps|cuda|auto). Absent -> align_audiobook.py
      // auto-selects (CUDA -> MPS -> CPU). Pass 'cpu' to keep align off a busy GPU.
      if (opts?.device) args.push('--device', opts.device);
      if (opts?.roughCachePath) args.push('--rough-cache', opts.roughCachePath);
      if (opts?.alignWorkers !== undefined) {
        if (!Number.isInteger(opts.alignWorkers) || opts.alignWorkers < 1) {
          reject(new Error(`alignWorkers must be a positive integer (got ${opts.alignWorkers})`));
          return;
        }
        args.push('--workers', String(opts.alignWorkers));
      }
      if (opts?.holeMinS !== undefined) {
        if (!Number.isFinite(opts.holeMinS) || opts.holeMinS < 0) {
          reject(new Error(`holeMinS must be a finite number >= 0 (got ${opts.holeMinS})`));
          return;
        }
        args.push('--hole-min-s', String(opts.holeMinS));
      }

      let child: ChildProcess;
      try {
        child = spawn(python, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: spawnPath,
            PYTHONIOENCODING: 'UTF-8',
            TOKENIZERS_PARALLELISM: 'false',
            TORCH_HOME: torchHome,
          },
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let result: AlignResult | null = null;
      let errorLine = '';
      let stderr = '';
      let buf = '';
      // Five stacked stage bars. The script reports a live fraction only for the
      // two long stages (transcribe/align) via SUBPROGRESS; the near-instant
      // stages are filled to 100% here the moment the next STAGE begins. The
      // headline percentage is the duration-weighted average (ALIGN_STAGES.weight),
      // which is naturally monotonic since every stage pct only ever increases.
      const stages: AlignStageProgress[] = ALIGN_STAGES.map((s) => ({
        name: s.name, label: s.label, pct: 0, status: 'pending',
      }));
      const stageIdx = (name: string) => ALIGN_STAGES.findIndex((s) => s.name === name);
      let stageMsg = stageMessage('prepare');
      const emitStages = () => {
        const master = Math.round(
          stages.reduce((acc, st, i) => acc + st.pct * ALIGN_STAGES[i].weight, 0),
        );
        sendProgress(win, jobId, master, stageMsg, stages.map((s) => ({ ...s })));
      };

      const handleLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        const stage = /^STAGE\s+(\S+)/.exec(line);
        if (stage) {
          const idx = stageIdx(stage[1]);
          if (idx >= 0) {
            for (let i = 0; i < stages.length; i++) {
              if (i < idx) { stages[i].pct = 100; stages[i].status = 'complete'; }
              else if (i === idx && stages[i].status === 'pending') { stages[i].status = 'running'; }
            }
            stageMsg = stageMessage(stage[1]);
            emitStages();
          }
          return;
        }
        const sub = /^SUBPROGRESS\s+(\S+)\s+(\d+)/.exec(line);
        if (sub) {
          const idx = stageIdx(sub[1]);
          if (idx >= 0) {
            stages[idx].pct = Math.max(stages[idx].pct, Math.min(100, parseInt(sub[2], 10)));
            if (stages[idx].status !== 'complete') stages[idx].status = 'running';
            emitStages();
          }
          return;
        }
        // Raw PROGRESS lines are now redundant for the align path — the master bar
        // is derived from the weighted stage fractions above — so they're ignored.
        if (/^PROGRESS\s+\d+/.test(line)) return;
        const res = /^RESULT\s+(.+)$/.exec(line);
        if (res) {
          try { result = JSON.parse(res[1]) as AlignResult; }
          catch { gerror('[epub-align] failed to parse RESULT line', { line }); }
          return;
        }
        const err = /^ERROR\s+(.+)$/.exec(line);
        if (err) { errorLine = err[1]; return; }
      };

      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      // stderr carries the script's diagnostic log (coarse match rate, dropped
      // runs, chunk failures) — stream it line-by-line so a CLI/console watcher
      // sees WHAT the aligner is doing, not just the progress percentage; the
      // rolling buffer stays for error reporting.
      let errBuf = '';
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-4000);
        errBuf += text;
        let nl: number;
        while ((nl = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, nl).trimEnd();
          errBuf = errBuf.slice(nl + 1);
          if (line) glog(`[epub-align] ${line}`);
        }
      });

      child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      child.on('close', (code) => {
        if (buf.trim()) handleLine(buf);
        if (code === 0 && result && result.ok === true && result.vtt) {
          for (const s of stages) { s.pct = 100; s.status = 'complete'; }
          emitStages();
          glog(`[epub-align] script DONE cues=${result.cues} fallbackCues=${result.fallbackCues ?? 0} trimmedHead=${result.trimmedHead} trimmedTail=${result.trimmedTail} failedSlices=${result.failedSlices ?? 0}/${result.totalSlices ?? 0} failedChunks=${result.failedChunks ?? 0}/${result.totalChunks ?? 0} driftChecked=${result.driftChecked ?? 0} driftMaxAbs=${result.driftMaxAbs ?? 0}s driftFixed=${result.driftFixed ?? 0}`);
          // Partial failures still complete (coverage exists) but must be SEEN:
          // each failed slice is ~10 min of audio absent from the anchor stream,
          // each failed chunk leaves its sentences on coarse timing.
          const warnings: string[] = [];
          if (result.failedSlices) {
            warnings.push(`${result.failedSlices} of ${result.totalSlices} transcription slice(s) failed — roughly ${result.failedSlices * 10} min of audio had no transcript to anchor against`);
          }
          if (result.failedChunks) {
            warnings.push(`${result.failedChunks} of ${result.totalChunks} alignment chunk(s) failed — their sentences carry rough timing instead of forced alignment`);
          }
          const warning = warnings.length ? warnings.join('; ') : undefined;
          if (warning) gerror(`[epub-align] completed WITH FAILURES: ${warning}`);
          if (reportPath) {
            // The script wrote the report (or died — we wouldn't be here); patch
            // in the epub path it couldn't know. A missing/corrupt report is a
            // real failure, not something to shrug past.
            try {
              const rep = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
              rep.epub = epubPath;
              fs.writeFileSync(reportPath, JSON.stringify(rep, null, 2), 'utf-8');
            } catch (e) {
              reject(new Error(`epub-align succeeded but the coverage report at ${reportPath} is unreadable: ${e instanceof Error ? e.message : e}`));
              return;
            }
            glog(`[epub-align] coverage report -> ${reportPath}`);
          }
          resolve({ vttPath: result.vtt, cues: result.cues ?? 0, warning, reportPath: reportPath || undefined });
          return;
        }
        // The script's terminal self-report (RESULT ok:false carries the most
        // specific message, e.g. "all slices failed"); then its ERROR line;
        // then raw stderr.
        const detail = (result && result.ok === false && result.error)
          || errorLine || stderr.trim().slice(-500) || `align script exited with code ${code}`;
        reject(new Error(`epub-align failed: ${detail}`));
      });
    });
  } catch (error) {
    try { fs.unlinkSync(outVtt); } catch { /* absent/no partial output */ }
    throw error;
  } finally {
    try { fs.unlinkSync(sentsJsonPath); } catch { /* best-effort cleanup */ }
  }
}
