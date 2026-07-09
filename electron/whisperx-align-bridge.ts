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
import * as manifestService from './manifest-service.js';
import { toUnpackedPath } from './e2a-paths.js';
import { GenerateSentencesConfig, sendProgress, glog, gerror } from './generate-sentences-bridge.js';

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
    case 'transcribe': return 'Transcribing narration…';
    case 'coarse-align': return 'Aligning your ebook to the audio…';
    case 'align': return 'Aligning your ebook to the audio…';
    case 'write': return 'Writing subtitles…';
    default: return 'Aligning your ebook to the audio…';
  }
}

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
  const envRoot = componentManager.resolveEntry(WHISPERX_ENV_ID) || process.env.WHISPERX_ENV_PATH || null;
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

      const handleLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        const stage = /^STAGE\s+(\S+)/.exec(line);
        if (stage) { sendProgress(win, jobId, 2, stageMessage(stage[1])); return; }
        const prog = /^PROGRESS\s+(\d+)/.exec(line);
        if (prog) {
          const pct = Math.max(0, Math.min(100, parseInt(prog[1], 10)));
          sendProgress(win, jobId, pct, 'Aligning your ebook to the audio…');
          return;
        }
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
