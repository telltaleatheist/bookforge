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
 */
function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?"”])\s+(?=[A-Z“"'‘“])/)
    .map((s) => s.trim())
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
  trimmedHead?: number;
  trimmedTail?: number;
  aligned?: number;
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
): Promise<{ vttPath: string; cues: number }> {
  if (!config.epubVariantId) throw new Error('epub-align requires an ebook variant id');

  // 1. Resolve the ebook variant → absolute epub path.
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

  // VTT lands next to the m4b (same basename, .vtt) — matches the whisper path.
  const m4bPath = config.m4bPath;
  const outVtt = path.join(path.dirname(m4bPath), `${path.parse(m4bPath).name}.vtt`);

  const langCode = config.language && config.language !== 'auto' ? config.language : 'en';

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
    return await new Promise<{ vttPath: string; cues: number }>((resolve, reject) => {
      const args = [
        scriptPath,
        '--audio', m4bPath,
        '--sentences', sentsJsonPath,
        '--out', outVtt,
        '--rough-model', 'base',
        '--lang', langCode,
      ];

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
      child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });

      child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      child.on('close', (code) => {
        if (buf.trim()) handleLine(buf);
        if (code === 0 && result && result.ok === true && result.vtt) {
          for (const s of stages) { s.pct = 100; s.status = 'complete'; }
          emitStages();
          glog(`[epub-align] script DONE cues=${result.cues} trimmedHead=${result.trimmedHead} trimmedTail=${result.trimmedTail}`);
          resolve({ vttPath: result.vtt, cues: result.cues ?? 0 });
          return;
        }
        const detail = errorLine || stderr.trim().slice(-500) || `align script exited with code ${code}`;
        reject(new Error(`epub-align failed: ${detail}`));
      });
    });
  } finally {
    try { fs.unlinkSync(sentsJsonPath); } catch { /* best-effort cleanup */ }
  }
}
