/**
 * Video Assembly Bridge
 *
 * Renders subtitle video frames using a hidden BrowserWindow and assembles
 * them with FFmpeg into an MP4 alongside the existing M4B audio.
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { getFfmpegPath } from './tool-paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VideoAssemblyConfig {
  projectId: string;
  bfpPath: string;
  mode: 'bilingual' | 'monolingual';
  m4bPath: string;
  vttPath: string;
  sentencePairsPath?: string;
  title: string;
  sourceLang: string;
  targetLang?: string;
  resolution: '480p' | '720p' | '1080p';
  externalAudiobooksDir?: string;
  outputFilename?: string;
}

interface VttCue {
  startTime: number;
  endTime: number;
  text: string;
}

interface FrameState {
  mode: 'bilingual' | 'monolingual';
  title: string;
  sourceLang: string;
  targetLang?: string;
  sentences: Array<{ source: string; target?: string }>;
  activePairIndex: number;
  isSourceSpeaking: boolean;
  frameIndex: number;
  totalFrames: number;
}

interface FrameEntry {
  state: FrameState;
  duration: number; // seconds
}

const RESOLUTION_MAP: Record<string, { width: number; height: number }> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

// Inline HTML template — avoids file-path issues between source and dist directories.
// Matches the bilingual player's dark theme with sentence pair cards.
const RENDERER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>loading</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0e0d0c; color: #faf9f7;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden; display: flex; flex-direction: column;
    align-items: center; justify-content: center; height: 100vh; width: 100vw;
  }
  .container { width: 100%; height: 100vh; padding: 24px 64px; display: flex; flex-direction: column; justify-content: center; gap: 16px; }
  .card { background: #181715; border: 1px solid #2a2824; border-radius: 12px; padding: 24px 32px; flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 0; }
  .card.active { background: color-mix(in srgb, #22d3ee 8%, #181715); border-color: #22d3ee; }
  .card.past { opacity: 0.4; }
  .card.future { opacity: 0.6; }
  .sentence-row { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 8px; }
  .sentence-row:last-child { margin-bottom: 0; }
  .badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 40px; height: 28px; padding: 0 10px; border-radius: 6px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
    flex-shrink: 0; margin-top: 3px; background: #2a2824; color: #928b7f;
  }
  .badge.speaking { background: #22d3ee; color: #fff; }
  .sentence-text { font-size: 22px; line-height: 1.5; color: #faf9f7; }
  .sentence-text.speaking { font-weight: 500; }
  .sentence-text.target { font-style: italic; color: #c4bdb3; }
  .sentence-text.target.speaking { color: #faf9f7; }
  .mono .sentence-text { font-style: normal; }
</style>
</head>
<body>
<div class="container" id="container"></div>
<script>
  var VISIBLE_CARDS = 5, CENTER = 2;
  function setState(data) {
    document.title = 'rendering';
    var c = document.getElementById('container');
    c.innerHTML = '';
    c.className = data.mode === 'monolingual' ? 'container mono' : 'container';
    var active = data.activePairIndex, total = data.sentences.length, startIdx = active - CENTER;
    for (var slot = 0; slot < VISIBLE_CARDS; slot++) {
      var idx = startIdx + slot;
      var card = document.createElement('div');
      card.className = 'card';
      if (idx < 0 || idx >= total) { card.style.visibility = 'hidden'; c.appendChild(card); continue; }
      if (idx < active) card.classList.add('past');
      else if (idx === active) card.classList.add('active');
      else card.classList.add('future');
      var pair = data.sentences[idx], isActive = idx === active;
      if (data.mode === 'bilingual') {
        var sr = document.createElement('div'); sr.className = 'sentence-row';
        var sb = document.createElement('span'); sb.className = 'badge';
        if (isActive && data.isSourceSpeaking) sb.classList.add('speaking');
        sb.textContent = data.sourceLang;
        var st = document.createElement('span'); st.className = 'sentence-text';
        if (isActive && data.isSourceSpeaking) st.classList.add('speaking');
        st.textContent = pair.source || '';
        sr.appendChild(sb); sr.appendChild(st); card.appendChild(sr);
        if (pair.target) {
          var tr = document.createElement('div'); tr.className = 'sentence-row';
          var tb = document.createElement('span'); tb.className = 'badge';
          if (isActive && !data.isSourceSpeaking) tb.classList.add('speaking');
          tb.textContent = data.targetLang || '';
          var tt = document.createElement('span'); tt.className = 'sentence-text target';
          if (isActive && !data.isSourceSpeaking) tt.classList.add('speaking');
          tt.textContent = pair.target;
          tr.appendChild(tb); tr.appendChild(tt); card.appendChild(tr);
        }
      } else {
        var r = document.createElement('div'); r.className = 'sentence-row';
        var t = document.createElement('span'); t.className = 'sentence-text';
        if (isActive) t.classList.add('speaking');
        t.textContent = pair.source || '';
        r.appendChild(t); card.appendChild(r);
      }
      c.appendChild(card);
    }
    requestAnimationFrame(function() { requestAnimationFrame(function() { document.title = 'ready'; }); });
  }
  window.setState = setState;
</script>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Active jobs (for cancellation)
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveJob {
  ffmpegProcess?: ChildProcess;
  hiddenWindow?: BrowserWindow;
  tempDir: string;
  cancelled: boolean;
}

const activeJobs = new Map<string, ActiveJob>();

// ─────────────────────────────────────────────────────────────────────────────
// VTT Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseTimestamp(ts: string): number {
  // Format: HH:MM:SS.mmm or MM:SS.mmm
  const parts = ts.trim().split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
  } else if (parts.length === 2) {
    const [m, s] = parts;
    return parseFloat(m) * 60 + parseFloat(s);
  }
  return 0;
}

function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  const lines = content.split('\n');
  let i = 0;

  // Skip WEBVTT header
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->');
      const startTime = parseTimestamp(startStr);
      const endTime = parseTimestamp(endStr);

      // Collect text lines until empty line
      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      cues.push({ startTime, endTime, text: textLines.join('\n') });
    } else {
      i++;
    }
  }

  return cues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildBilingualFrames(
  cues: VttCue[],
  sentencePairs: Array<{ source: string; target: string }>,
  config: VideoAssemblyConfig
): FrameEntry[] {
  const frames: FrameEntry[] = [];
  const totalPairs = sentencePairs.length;

  // VTT has alternating cues: EN0, DE0, EN1, DE1...
  // Each pair of cues maps to one sentence pair
  for (let cueIdx = 0; cueIdx < cues.length; cueIdx++) {
    const pairIdx = Math.floor(cueIdx / 2);
    const isSource = cueIdx % 2 === 0;
    const cue = cues[cueIdx];

    // Calculate duration: cue duration + gap to next cue
    let duration = cue.endTime - cue.startTime;
    if (cueIdx + 1 < cues.length) {
      duration += cues[cueIdx + 1].startTime - cue.endTime;
    }
    // Minimum frame duration to avoid zero-length frames
    duration = Math.max(duration, 0.04);

    frames.push({
      state: {
        mode: 'bilingual',
        title: config.title,
        sourceLang: config.sourceLang.toUpperCase(),
        targetLang: config.targetLang?.toUpperCase(),
        sentences: sentencePairs,
        activePairIndex: Math.min(pairIdx, totalPairs - 1),
        isSourceSpeaking: isSource,
        frameIndex: cueIdx,
        totalFrames: cues.length,
      },
      duration,
    });
  }

  return frames;
}

function buildMonolingualFrames(
  cues: VttCue[],
  config: VideoAssemblyConfig
): FrameEntry[] {
  const frames: FrameEntry[] = [];
  const sentences = cues.map(c => ({ source: c.text }));

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];

    let duration = cue.endTime - cue.startTime;
    if (i + 1 < cues.length) {
      duration += cues[i + 1].startTime - cue.endTime;
    }
    duration = Math.max(duration, 0.04);

    frames.push({
      state: {
        mode: 'monolingual',
        title: config.title,
        sourceLang: config.sourceLang.toUpperCase(),
        sentences,
        activePairIndex: i,
        isSourceSpeaking: true,
        frameIndex: i,
        totalFrames: cues.length,
      },
      duration,
    });
  }

  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Reporting
// ─────────────────────────────────────────────────────────────────────────────

function sendProgress(
  mainWindow: BrowserWindow,
  jobId: string,
  phase: string,
  percentage: number,
  message: string
) {
  mainWindow.webContents.send('video-assembly:progress', {
    jobId,
    phase,
    percentage,
    message,
  });
}

function sendComplete(
  mainWindow: BrowserWindow,
  jobId: string,
  success: boolean,
  outputPath?: string,
  error?: string
) {
  mainWindow.webContents.send('video-assembly:complete', {
    jobId,
    success,
    outputPath,
    error,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// File Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve actual M4B and VTT paths in the output directory.
 *
 * The process wizard queues jobs with placeholder paths like "audiobook.m4b"
 * and "audiobook.vtt", but the standard pipeline names files differently:
 *   - M4B: "{title}.m4b" (from TTS output filename)
 *   - VTT: "subtitles.vtt" (renamed by parallel-tts-bridge)
 *
 * For bilingual, the names are predictable (bilingual-en-de.m4b/.vtt).
 *
 * This function checks the configured path first; if it doesn't exist,
 * it scans the output directory for the first .m4b / .vtt file.
 */
async function resolveOutputPaths(config: VideoAssemblyConfig): Promise<{
  m4bPath: string;
  vttPath: string;
}> {
  let m4bPath = config.m4bPath;
  let vttPath = config.vttPath;

  // Check if configured paths exist; if not, scan the output directory
  const outputDir = path.join(config.bfpPath, 'output');

  const m4bExists = await fileExists(m4bPath);
  const vttExists = await fileExists(vttPath);

  if (!m4bExists || !vttExists) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(outputDir);
    } catch {
      throw new Error(`Output directory not found: ${outputDir}`);
    }

    if (!m4bExists) {
      // For bilingual, prefer bilingual-*.m4b; for mono, prefer any .m4b
      const m4bFiles = entries.filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
      if (config.mode === 'bilingual' && config.targetLang) {
        const bilingualM4b = m4bFiles.find(f => f.includes(`bilingual-${config.sourceLang}-${config.targetLang}`));
        m4bPath = path.join(outputDir, bilingualM4b || m4bFiles[0]);
      } else {
        // Prefer non-bilingual M4B for monolingual mode
        const monoM4b = m4bFiles.find(f => !f.startsWith('bilingual-')) || m4bFiles[0];
        m4bPath = path.join(outputDir, monoM4b);
      }
      if (!m4bFiles.length) {
        throw new Error(`No M4B file found in ${outputDir}`);
      }
      console.log(`[VideoAssembly] Resolved M4B: ${m4bPath}`);
    }

    if (!vttExists) {
      const vttFiles = entries.filter(f => f.endsWith('.vtt') && !f.startsWith('._'));
      if (config.mode === 'bilingual' && config.targetLang) {
        const bilingualVtt = vttFiles.find(f => f.includes(`bilingual-${config.sourceLang}-${config.targetLang}`));
        vttPath = path.join(outputDir, bilingualVtt || vttFiles[0]);
      } else {
        // Standard pipeline: VTT is "subtitles.vtt" or any .vtt
        const monoVtt = vttFiles.find(f => !f.startsWith('bilingual-')) || vttFiles[0];
        vttPath = path.join(outputDir, monoVtt);
      }
      if (!vttFiles.length) {
        throw new Error(`No VTT file found in ${outputDir}`);
      }
      console.log(`[VideoAssembly] Resolved VTT: ${vttPath}`);
    }
  }

  return { m4bPath, vttPath };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export async function startVideoAssembly(
  jobId: string,
  mainWindow: BrowserWindow,
  config: VideoAssemblyConfig
): Promise<void> {
  const tempDir = path.join(os.tmpdir(), 'bookforge-video', jobId);
  const job: ActiveJob = { tempDir, cancelled: false };
  activeJobs.set(jobId, job);

  let hiddenWindow: BrowserWindow | null = null;

  try {
    // ── Phase 1: Preparing (0–5%) ──
    sendProgress(mainWindow, jobId, 'preparing', 0, 'Locating audio files...');

    // Resolve actual M4B and VTT paths — the queued paths may be placeholders
    // (e.g., "audiobook.m4b") when the real filenames depend on TTS output.
    const resolvedPaths = await resolveOutputPaths(config);
    config = { ...config, m4bPath: resolvedPaths.m4bPath, vttPath: resolvedPaths.vttPath };

    sendProgress(mainWindow, jobId, 'preparing', 1, 'Parsing VTT...');
    const vttContent = await fs.readFile(config.vttPath, 'utf-8');
    const cues = parseVtt(vttContent);
    if (cues.length === 0) {
      throw new Error('No cues found in VTT file');
    }

    if (job.cancelled) throw new Error('Cancelled');

    // Build frame list
    let frames: FrameEntry[];
    if (config.mode === 'bilingual' && config.sentencePairsPath) {
      sendProgress(mainWindow, jobId, 'preparing', 2, 'Loading sentence pairs...');
      const pairsContent = await fs.readFile(config.sentencePairsPath, 'utf-8');
      const sentencePairs = JSON.parse(pairsContent);
      frames = buildBilingualFrames(cues, sentencePairs, config);
    } else {
      frames = buildMonolingualFrames(cues, config);
    }

    if (frames.length === 0) {
      throw new Error('No frames to render');
    }

    sendProgress(mainWindow, jobId, 'preparing', 3, `${frames.length} frames to render`);

    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true });

    if (job.cancelled) throw new Error('Cancelled');

    // ── Phase 2: Rendering frames (5–80%) ──
    const res = RESOLUTION_MAP[config.resolution] || RESOLUTION_MAP['1080p'];

    hiddenWindow = new BrowserWindow({
      width: res.width,
      height: res.height,
      show: false,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    job.hiddenWindow = hiddenWindow;

    // Load the renderer HTML via data URL (avoids dist vs source path issues)
    await hiddenWindow.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(RENDERER_HTML)
    );

    sendProgress(mainWindow, jobId, 'rendering', 5, 'Starting frame capture...');

    // Build concat file entries
    const concatEntries: string[] = [];

    for (let i = 0; i < frames.length; i++) {
      if (job.cancelled) throw new Error('Cancelled');

      const frame = frames[i];
      const frameName = `frame_${String(i).padStart(6, '0')}.png`;
      const framePath = path.join(tempDir, frameName);

      // Set state in hidden window
      await hiddenWindow.webContents.executeJavaScript(
        `setState(${JSON.stringify(frame.state)})`
      );

      // Wait for rendering to complete (document.title === 'ready')
      await waitForReady(hiddenWindow, 5000);

      // Capture the page
      const image = await hiddenWindow.webContents.capturePage();
      const pngBuffer = image.toPNG();
      await fs.writeFile(framePath, pngBuffer);

      // Add to concat list
      concatEntries.push(`file '${frameName}'`);
      concatEntries.push(`duration ${frame.duration.toFixed(6)}`);

      // Report progress (5% to 80%)
      const pct = 5 + Math.round((i / frames.length) * 75);
      if (i % 10 === 0 || i === frames.length - 1) {
        sendProgress(mainWindow, jobId, 'rendering', pct, `Frame ${i + 1}/${frames.length}`);
      }
    }

    // Close hidden window
    hiddenWindow.destroy();
    hiddenWindow = null;
    job.hiddenWindow = undefined;

    if (job.cancelled) throw new Error('Cancelled');

    // Write concat file (need to repeat last frame for FFmpeg concat demuxer)
    const lastFrameName = `frame_${String(frames.length - 1).padStart(6, '0')}.png`;
    concatEntries.push(`file '${lastFrameName}'`);
    const concatPath = path.join(tempDir, 'concat.txt');
    await fs.writeFile(concatPath, concatEntries.join('\n'));

    // ── Phase 3: Encoding (80–99%) ──
    sendProgress(mainWindow, jobId, 'encoding', 80, 'Starting FFmpeg encode...');

    // Determine output path
    const outputDir = path.join(config.bfpPath, 'output');
    await fs.mkdir(outputDir, { recursive: true });

    let outputFilename: string;
    if (config.mode === 'bilingual' && config.targetLang) {
      outputFilename = `bilingual-${config.sourceLang}-${config.targetLang}.mp4`;
    } else {
      outputFilename = 'audiobook.mp4';
    }
    const outputPath = path.join(outputDir, outputFilename);

    // Calculate total audio duration for FFmpeg progress parsing
    const totalDuration = cues.length > 0
      ? cues[cues.length - 1].endTime
      : 0;

    await runFfmpeg(jobId, tempDir, concatPath, config.m4bPath, outputPath, totalDuration, mainWindow);

    if (job.cancelled) throw new Error('Cancelled');

    // Copy to external audiobooks dir if configured
    if (config.externalAudiobooksDir) {
      try {
        await fs.mkdir(config.externalAudiobooksDir, { recursive: true });
        let extFilename: string;
        if (config.outputFilename) {
          // Use the user-configured filename, sanitize and add .mp4
          const sanitized = config.outputFilename.replace(/\.mp4$/i, '').replace(/[<>:"/\\|?*]/g, '_');
          extFilename = `${sanitized}.mp4`;
        } else {
          extFilename = outputFilename;
        }
        const extPath = path.join(config.externalAudiobooksDir, extFilename);
        await fs.copyFile(outputPath, extPath);
        console.log(`[VideoAssembly] Copied to external: ${extPath}`);
      } catch (err) {
        console.error('[VideoAssembly] Failed to copy to external dir:', err);
      }
    }

    // ── Phase 4: Complete (100%) ──
    sendProgress(mainWindow, jobId, 'complete', 100, 'Video assembly complete');
    sendComplete(mainWindow, jobId, true, outputPath);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Video assembly failed';
    if (message !== 'Cancelled') {
      console.error('[VideoAssembly] Error:', message);
    }
    sendComplete(mainWindow, jobId, false, undefined, message);
  } finally {
    // Cleanup
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.destroy();
    }
    activeJobs.delete(jobId);

    // Clean up temp dir (fire-and-forget)
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function cancelVideoAssembly(jobId: string): void {
  const job = activeJobs.get(jobId);
  if (!job) return;

  job.cancelled = true;

  if (job.ffmpegProcess) {
    job.ffmpegProcess.kill('SIGTERM');
  }

  if (job.hiddenWindow && !job.hiddenWindow.isDestroyed()) {
    job.hiddenWindow.destroy();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function waitForReady(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      if (win.isDestroyed()) {
        reject(new Error('Window destroyed'));
        return;
      }
      if (win.getTitle() === 'ready') {
        resolve();
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        resolve(); // Don't fail on timeout, just proceed
        return;
      }
      setTimeout(check, 16);
    };
    check();
  });
}

function runFfmpeg(
  jobId: string,
  tempDir: string,
  concatPath: string,
  audioPath: string,
  outputPath: string,
  totalDuration: number,
  mainWindow: BrowserWindow
): Promise<void> {
  return new Promise((resolve, reject) => {
    const job = activeJobs.get(jobId);
    if (!job) { reject(new Error('Job not found')); return; }

    const ffmpegPath = getFfmpegPath();

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-i', audioPath,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log('[VideoAssembly] FFmpeg command:', ffmpegPath, args.join(' '));

    const proc = spawn(ffmpegPath, args, { cwd: tempDir });
    job.ffmpegProcess = proc;

    let stderrBuffer = '';

    proc.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();

      // Parse time= from FFmpeg stderr for progress
      const timeMatch = stderrBuffer.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (timeMatch && totalDuration > 0) {
        const [, h, m, s] = timeMatch;
        const currentTime = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
        const encodePct = Math.min(currentTime / totalDuration, 1);
        const pct = 80 + Math.round(encodePct * 19);
        sendProgress(mainWindow, jobId, 'encoding', pct, `Encoding... ${Math.round(encodePct * 100)}%`);
        // Trim buffer to avoid unbounded growth
        if (stderrBuffer.length > 4096) {
          stderrBuffer = stderrBuffer.slice(-2048);
        }
      }
    });

    proc.on('close', (code) => {
      job.ffmpegProcess = undefined;

      if (job.cancelled) {
        reject(new Error('Cancelled'));
        return;
      }

      if (code === 0) {
        resolve();
      } else {
        // Extract last few lines of stderr for error context
        const errLines = stderrBuffer.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`FFmpeg exited with code ${code}: ${errLines}`));
      }
    });

    proc.on('error', (err) => {
      job.ffmpegProcess = undefined;
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}
