/**
 * Unified metadata tool abstraction for audiobook tagging.
 *
 * Uses the bundled ffmpeg for everything — no third-party binary (previously
 * `tone` on Windows / `m4b-tool` + PHP on macOS/Linux). ffmpeg ships inside the
 * relocatable env, so audiobook tagging + cover art works on a clean machine
 * with nothing installed.
 *
 * The audiobook (.m4b) is already built by e2a via ffmpeg (chapters, cover, the
 * iTunes audiobook `media_type` atom). These functions are a post-step that
 * layers BookForge's user-edited metadata + chosen cover on top, as a lossless
 * `-c copy` remux that preserves chapters and the audio bitstream byte-for-byte.
 *
 * Validated recipe (replace cover + tags, keep chapters):
 *   ffmpeg -i in.m4b -i cover.jpg -map 0:a -map 1:0 -map_chapters 0 \
 *     -c:a copy -c:v copy -disposition:v:0 attached_pic \
 *     -metadata title=… -metadata artist=… -metadata composer=<narrator> \
 *     -metadata grouping=<series> -metadata genre=… -metadata media_type=2  out.m4b
 *
 * Narrator → `composer` and series → `grouping` match the long-standing m4b-tool
 * mapping (`--writer` = composer). Two gotchas, both verified empirically:
 *   - `-map 1:0` (explicit stream), NOT `-map 1:v` with global `-c copy` — the
 *     latter drops the cover when the chapter track is rebuilt.
 *   - Do NOT add `-movflags use_metadata_tags` — it also silently drops the
 *     attached_pic cover. Standard mp4 metadata keys don't need it.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import { getFfmpegPath, getFfprobePath } from './tool-paths';
import { getDefaultE2aPath, getPythonInvocation, buildCondaSpawnEnv, toUnpackedPath } from './e2a-paths';

const MAX_STDERR_BYTES = 10 * 1024;
function appendCapped(buf: string, chunk: string): string {
  buf += chunk;
  if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(-MAX_STDERR_BYTES);
  return buf;
}

// Tool type detection. ffmpeg is the only backend now; the type + shape are kept
// so existing callers (`getMetadataToolPath()`) are unchanged.
type MetadataTool = 'ffmpeg';

interface MetadataToolInfo {
  tool: MetadataTool;
  path: string;
}

/**
 * Get the metadata tool for the current platform. Always ffmpeg (bundled in the
 * relocatable env, with system/PATH fallback). Never null in practice — ffmpeg
 * is a hard dependency of the whole pipeline — but typed nullable for callers
 * that gate on it.
 */
export function getMetadataToolPath(): MetadataToolInfo | null {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return null;
  return { tool: 'ffmpeg', path: ffmpeg };
}

/**
 * Common metadata fields
 */
export interface AudiobookMetadata {
  title?: string;
  author?: string;
  year?: string;
  narrator?: string;
  series?: string;
  seriesNumber?: string;
  genre?: string;
  description?: string;
  coverPath?: string;
  contributors?: Array<{ first: string; last: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared ffmpeg remux helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run an ffmpeg remux that reads `filePath`, writes a sibling temp file, and —
 * only on a clean exit with a plausibly-sized output — atomically swaps it in.
 * The original is renamed aside first and restored on any failure, so the file
 * is never left half-written (the reason the old m4b-tool path needed a backup).
 *
 * Metadata is non-critical: a missing ffmpeg, a timeout, or an abort resolves
 * quietly (the file keeps its prior tags) rather than failing the job.
 */
function ffmpegRemuxInPlace(
  filePath: string,
  buildArgs: (tmpOut: string) => string[],
  options?: { timeoutMs?: number; signal?: AbortSignal; label?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) {
      console.log('[METADATA-TOOLS] ffmpeg not found, skipping');
      resolve();
      return;
    }
    if (options?.signal?.aborted) {
      console.log('[METADATA-TOOLS] Already aborted, skipping');
      resolve();
      return;
    }
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    const ext = path.extname(filePath);
    const tmpOut = `${filePath}.ffwork${ext}`;
    const tmpPrev = `${filePath}.ffprev${ext}`;
    const originalSize = fs.statSync(filePath).size;
    for (const stale of [tmpOut, tmpPrev]) {
      try { if (fs.existsSync(stale)) fs.unlinkSync(stale); } catch { /* ignore */ }
    }

    const args = buildArgs(tmpOut);
    const label = options?.label ?? 'remux';
    console.log(`[METADATA-TOOLS] ffmpeg ${label}: ${ffmpeg} ${args.join(' ')}`);

    const proc = spawn(ffmpeg, args);
    let stderr = '';
    let settled = false;
    const timeoutMs = options?.timeoutMs ?? 180_000;

    function cleanupTmp() {
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }

    const isLockError = (err: unknown): boolean => {
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Swap the finished temp file in over the original. On a cloud-synced drive
    // (OneDrive/Syncthing) the original file is intermittently locked by the sync
    // client mid-upload, so the rename transiently fails with EBUSY/EPERM. Retry
    // with backoff to ride out that lock window. Invariant: the original is only
    // ever moved to tmpPrev; if putting the new file in place ultimately fails we
    // restore it, so the audiobook is never lost.
    async function swapInPlace(): Promise<void> {
      const delays = [200, 400, 800, 1500, 2500];
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(filePath, tmpPrev); break; }
        catch (err) {
          if (isLockError(err) && attempt < delays.length) { await sleep(delays[attempt]); continue; }
          throw err; // original never moved — safe to fail here
        }
      }
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(tmpOut, filePath); break; }
        catch (err) {
          if (isLockError(err) && attempt < delays.length) { await sleep(delays[attempt]); continue; }
          try { fs.renameSync(tmpPrev, filePath); } catch { /* best-effort restore */ }
          throw err;
        }
      }
      try { if (fs.existsSync(tmpPrev)) fs.unlinkSync(tmpPrev); } catch { /* ignore */ }
    }

    function finish(resolution: 'resolve' | 'reject', error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort && options?.signal) options.signal.removeEventListener('abort', onAbort);
      if (resolution === 'resolve') resolve();
      else reject(error);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      console.warn(`[METADATA-TOOLS] Timeout after ${timeoutMs}ms, killing ffmpeg`);
      proc.kill('SIGKILL');
      cleanupTmp();
      finish('resolve'); // non-critical: leave the original untouched
    }, timeoutMs);

    let onAbort: (() => void) | null = null;
    if (options?.signal) {
      onAbort = () => {
        if (settled) return;
        console.log('[METADATA-TOOLS] Aborted, killing ffmpeg');
        proc.kill('SIGKILL');
        cleanupTmp();
        finish('resolve');
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout?.on('data', (d: Buffer) => console.log('[METADATA-TOOLS]', d.toString().trim()));
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = appendCapped(stderr, d.toString());
      const line = d.toString().trim();
      if (line) console.log('[METADATA-TOOLS STDERR]', line);
    });

    proc.on('error', (err) => { cleanupTmp(); finish('reject', err); });

    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        cleanupTmp();
        finish('reject', new Error(`ffmpeg ${label} failed with code ${code}: ${stderr}`));
        return;
      }
      // Sanity-check the output before swapping it in: a `-c copy` remux should
      // be within a hair of the original size. Guard against a 0-byte / truncated
      // file masquerading as success.
      if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < originalSize * 0.5) {
        cleanupTmp();
        finish('reject', new Error(`ffmpeg ${label} produced an implausible output (size check failed)`));
        return;
      }
      // Atomic-ish swap, same volume: original→prev, tmp→original, drop prev.
      // Retries transient cloud-sync locks (EBUSY/EPERM) before giving up.
      void swapInPlace().then(
        () => finish('resolve'),
        (err) => {
          cleanupTmp();
          const e = err instanceof Error ? err : new Error(String(err));
          finish('reject', isLockError(err)
            ? new Error(`The audiobook file is locked by another program — often OneDrive or Syncthing syncing it, or a media player has it open. Pause syncing (or close the player) and save again. [${label}: ${e.message}]`)
            : e);
        }
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cover optimization (already ffmpeg-based)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optimize a cover image for M4B embedding.
 * Converts to JPEG and resizes to fit within maxDim pixels on the longest side.
 * Many audiobook players silently skip covers that are too large or in PNG format.
 *
 * Returns the path to the optimized JPEG (in os.tmpdir()), or the original path
 * if ffmpeg is unavailable or conversion fails.
 */
export function optimizeCoverForM4b(coverPath: string, maxDim = 1400): string {
  const ext = path.extname(coverPath).toLowerCase();
  const stats = fs.statSync(coverPath);

  // Skip optimization if already a small JPEG (under 500KB)
  if ((ext === '.jpg' || ext === '.jpeg') && stats.size < 500 * 1024) {
    return coverPath;
  }

  const ffmpeg = getFfmpegPath();
  const optimizedPath = path.join(os.tmpdir(), `bookforge-cover-${Date.now()}.jpg`);

  try {
    execFileSync(ffmpeg, [
      '-y', '-i', coverPath,
      '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', '2',
      '-update', '1',
      optimizedPath,
    ], { timeout: 15_000, stdio: 'pipe' });

    if (fs.existsSync(optimizedPath)) {
      const optStats = fs.statSync(optimizedPath);
      console.log(`[METADATA-TOOLS] Optimized cover: ${path.basename(coverPath)} (${(stats.size / 1024).toFixed(0)}KB ${ext}) → ${(optStats.size / 1024).toFixed(0)}KB JPEG`);
      return optimizedPath;
    }
  } catch (err) {
    console.warn('[METADATA-TOOLS] Cover optimization failed, using original:', err instanceof Error ? err.message : err);
    try { fs.unlinkSync(optimizedPath); } catch { /* ignore */ }
  }

  return coverPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove cover/embedded pictures from an audiobook file.
 * Remuxes audio + chapters only (drops every video/attached_pic stream).
 */
export function removeCover(filePath: string): Promise<void> {
  return ffmpegRemuxInPlace(
    filePath,
    (tmpOut) => [
      '-v', 'error', '-y',
      '-i', filePath,
      '-map', '0:a',
      '-map_chapters', '0',
      '-c:a', 'copy',
      tmpOut,
    ],
    { label: 'removeCover', timeoutMs: 180_000 }
  ).catch((err) => {
    // Cover removal is non-critical; surface as a rejection so callers that
    // wrap it in try/catch can log, but it never corrupts the file.
    throw err instanceof Error ? err : new Error(String(err));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// In-place tag/cover writer (mutagen)
// ─────────────────────────────────────────────────────────────────────────────

function resolveM4bTagScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'write_m4b_tags.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'write_m4b_tags.py'),
    path.join(__dirname, 'scripts', 'write_m4b_tags.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  // Packaged: the spawned python can't read inside app.asar — hand it the
  // asarUnpack'd real file (dist/electron/scripts/** is unpacked).
  return toUnpackedPath(found);
}

/**
 * Write tags + cover into an M4B IN PLACE via mutagen (see write_m4b_tags.py).
 * Only the metadata atoms are rewritten — the audio bitstream and chapters are
 * untouched — so this is near-instant regardless of file size, versus the whole
 * -c copy remux it replaces. Runs in the bundled e2a env (mutagen is an e2a dep).
 */
function writeM4bTagsInPlace(
  filePath: string,
  tags: Record<string, string>,
  coverPath: string | undefined,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { resolve(); return; }
    if (!fs.existsSync(filePath)) { reject(new Error(`File not found: ${filePath}`)); return; }

    const script = resolveM4bTagScript();
    const py = getPythonInvocation(getDefaultE2aPath());
    const env = buildCondaSpawnEnv();
    const args = [...py.args, '-u', script];
    const payload = JSON.stringify({ file: filePath, tags, cover: coverPath ?? null });
    console.log(`[METADATA-TOOLS] mutagen tag write: ${py.command} ${script}`);

    let child: ChildProcess;
    try {
      child = spawn(py.command, args, { env, windowsHide: true });
    } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }

    const timeoutMs = options?.timeoutMs ?? 120_000;
    let settled = false;
    let onAbort: (() => void) | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort && options?.signal) options.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      done(() => reject(new Error('write_m4b_tags timed out')));
    }, timeoutMs);
    if (options?.signal) {
      onAbort = () => { try { child.kill('SIGKILL'); } catch { /* already dead */ } done(() => resolve()); };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr = appendCapped(stderr, d.toString()); });
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', () => {
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const r = JSON.parse(lines[i]);
          if (typeof r.ok === 'boolean') {
            return r.ok ? done(() => resolve())
                        : done(() => reject(new Error(r.error || 'write_m4b_tags failed')));
          }
        } catch { /* not the JSON result line */ }
      }
      done(() => reject(new Error(stderr.trim().slice(-400) || 'write_m4b_tags produced no result')));
    });

    try { child.stdin?.write(payload); child.stdin?.end(); }
    catch (err) { done(() => reject(err instanceof Error ? err : new Error(String(err)))); }
  });
}

/**
 * Apply metadata (and optionally swap the cover) on an audiobook file.
 *
 * Writes IN PLACE via mutagen (see writeM4bTagsInPlace) — no full-file remux, so
 * this is near-instant even on a 500 MB audiobook, and it can't corrupt the audio
 * or chapters (it never touches them). Narrator → composer and series → grouping
 * preserve the long-standing m4b-tool mapping.
 */
export function applyMetadata(
  filePath: string,
  metadata: AudiobookMetadata,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<void> {
  // Build artist string from contributors if available
  const artistString = metadata.contributors && metadata.contributors.length > 0
    ? metadata.contributors
        .filter(c => c.first || c.last)
        .map(c => [c.first, c.last].filter(Boolean).join(' '))
        .join('; ')
    : metadata.author;

  // Optimize cover for M4B compatibility (convert to JPEG, resize)
  let optimizedCoverPath: string | undefined;
  if (metadata.coverPath && fs.existsSync(metadata.coverPath)) {
    optimizedCoverPath = optimizeCoverForM4b(metadata.coverPath);
  }

  // Collect the tags so we can skip the write entirely if there's nothing to
  // change and no cover to swap.
  const tags: Record<string, string> = {};
  if (metadata.title) tags.title = metadata.title;
  if (artistString) tags.artist = artistString;
  if (metadata.year) tags.date = metadata.year;          // YYYY or full date
  if (metadata.narrator) tags.composer = metadata.narrator;
  if (metadata.series) tags.grouping = metadata.series;
  if (metadata.genre) tags.genre = metadata.genre;
  if (metadata.description) tags.description = metadata.description;

  if (Object.keys(tags).length === 0 && !optimizedCoverPath) {
    console.log('[METADATA-TOOLS] No metadata or cover to apply');
    return Promise.resolve();
  }

  function cleanupOptimizedCover() {
    if (optimizedCoverPath && optimizedCoverPath !== metadata.coverPath) {
      try { fs.unlinkSync(optimizedCoverPath); } catch { /* non-critical */ }
    }
  }

  return writeM4bTagsInPlace(filePath, tags, optimizedCoverPath, {
    timeoutMs: options?.timeoutMs ?? 120_000,
    signal: options?.signal,
  }).then(
    () => { cleanupOptimizedCover(); },
    (err) => { cleanupOptimizedCover(); throw err; }
  );
}

/**
 * Check if a metadata tool is available (ffmpeg is bundled, so effectively always)
 */
export function isMetadataToolAvailable(): boolean {
  return getMetadataToolPath() !== null;
}

// ── Import an existing audio file as a normalized .m4b audiobook ───────────────

function runProc(bin: string, args: string[], timeoutMs: number, onStdout?: (chunk: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } reject(new Error(`${path.basename(bin)} timed out`)); }, timeoutMs);
    // When an `onStdout` consumer is attached the caller reads stdout incrementally
    // (e.g. ffmpeg `-progress pipe:1`), and the buffered copy is unused — cap it so a
    // long transcode's progress stream can't grow without bound. With no consumer the
    // caller parses the complete stdout (ffprobe `-print_format json`), so it must be
    // retained in full: capping from the front would truncate the opening `{` and
    // yield unparseable JSON. Only stderr (diagnostic text) is always capped.
    proc.stdout?.on('data', (d) => { const s = d.toString(); stdout = onStdout ? appendCapped(stdout, s) : stdout + s; onStdout?.(s); });
    proc.stderr?.on('data', (d) => { stderr = appendCapped(stderr, d.toString()); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** Probe an audio file for its audio codec, duration (s), and chapter count. */
export async function probeAudio(src: string): Promise<{ codec: string; durationSec: number; chapters: number }> {
  const ffprobe = getFfprobePath();
  const { code, stdout } = await runProc(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', src], 60_000);
  if (code !== 0) throw new Error('ffprobe failed to read the audio file');
  const j = JSON.parse(stdout || '{}');
  const audio = (j.streams || []).find((s: { codec_type?: string }) => s.codec_type === 'audio');
  return {
    codec: audio?.codec_name || '',
    durationSec: parseFloat(j.format?.duration || audio?.duration || '0') || 0,
    chapters: Array.isArray(j.chapters) ? j.chapters.length : 0,
  };
}

/**
 * Import any audio file as a normalized `.m4b` audiobook at `outPath`.
 *  - Audio is stream-copied when already AAC, otherwise transcoded to AAC.
 *  - Existing chapters are preserved; if the source has none, a single chapter
 *    spanning the whole file is synthesized, titled after the audiobook.
 *  - Title/author/narrator/year are written as tags + the iTunes audiobook kind.
 */
export async function normalizeAudioToM4b(
  src: string,
  outPath: string,
  meta: { title: string; author?: string; narrator?: string; year?: string; fallbackChapterTitle: string },
  options?: { timeoutMs?: number; onProgress?: (fraction: number) => void },
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const { codec, durationSec, chapters } = await probeAudio(src);
  const canCopy = codec === 'aac';
  const synth = chapters === 0 && durationSec > 0;

  let metaFile: string | undefined;
  // `-progress pipe:1` streams `out_time_us=…` lines to stdout so we can report a
  // determinate percentage (elapsed / total duration) while ffmpeg works.
  const wantProgress = !!options?.onProgress && durationSec > 0;
  const args = ['-v', 'error', ...(wantProgress ? ['-progress', 'pipe:1', '-nostats'] : []), '-y', '-i', src];
  if (synth) {
    const endMs = Math.max(1, Math.round(durationSec * 1000));
    const ff = `;FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=${endMs}\ntitle=${meta.fallbackChapterTitle.replace(/[\r\n]+/g, ' ')}\n`;
    metaFile = path.join(os.tmpdir(), `bf-chap-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(metaFile, ff, 'utf-8');
    args.push('-f', 'ffmetadata', '-i', metaFile);
  }
  args.push('-map', '0:a');
  if (chapters > 0) args.push('-map_chapters', '0');
  else if (synth) args.push('-map_chapters', '1');
  if (canCopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '128k');
  if (meta.title) args.push('-metadata', `title=${meta.title}`, '-metadata', `album=${meta.title}`);
  if (meta.author) args.push('-metadata', `artist=${meta.author}`);
  if (meta.narrator) args.push('-metadata', `composer=${meta.narrator}`);
  if (meta.year) args.push('-metadata', `date=${meta.year}`);
  args.push('-metadata', 'media_type=2', '-movflags', '+faststart', outPath);

  // Parse the streamed `-progress` output into a 0..1 fraction, throttled so we
  // only report meaningful advances.
  let progressBuf = '';
  let lastFraction = 0;
  const onStdout = wantProgress
    ? (chunk: string) => {
        progressBuf += chunk;
        if (progressBuf.length > 8192) progressBuf = progressBuf.slice(-2048);
        let us = -1;
        const re = /out_time_us=(\d+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(progressBuf)) !== null) us = parseInt(m[1], 10);
        if (us < 0) return;
        const frac = Math.max(0, Math.min(1, us / 1e6 / durationSec));
        if (frac - lastFraction >= 0.005 || frac >= 1) {
          lastFraction = frac;
          options!.onProgress!(frac);
        }
      }
    : undefined;

  try {
    const { code, stderr } = await runProc(ffmpeg, args, options?.timeoutMs ?? 1_800_000, onStdout);
    if (code !== 0) throw new Error(`ffmpeg failed to build the m4b (${code}): ${stderr.slice(-400)}`);
    if (wantProgress) options!.onProgress!(1);
  } finally {
    if (metaFile) { try { fs.unlinkSync(metaFile); } catch { /* non-critical */ } }
  }
}

/**
 * Read the ftyp major brand of an mp4/m4b (bytes 8–12 of the file) so a remux can
 * preserve it. e2a writes `M4A `; keeping it means players that key off the brand
 * (e.g. Apple Books, which uses it to treat a file as an audiobook) are unaffected.
 * Falls back to `M4A ` when the header can't be read.
 */
async function readMajorBrand(src: string): Promise<string> {
  try {
    const fd = await fs.promises.open(src, 'r');
    try {
      const buf = Buffer.alloc(12);
      await fd.read(buf, 0, 12, 0);
      if (buf.toString('latin1', 4, 8) === 'ftyp') {
        const brand = buf.toString('latin1', 8, 12);
        if (brand.trim()) return brand;
      }
    } finally {
      await fd.close();
    }
  } catch { /* fall through to default */ }
  return 'M4A ';
}

/**
 * Seal a WebVTT transcript INTO an `.m4b` as a `mov_text` (tx3g) subtitle track,
 * so the transcript travels *inside* the audio file. This is an unbreakable link:
 * no filename/sidecar heuristic can ever pair the wrong transcript with the wrong
 * audio, and it survives renames, moves, and copies.
 *
 * The operation is a lossless stream copy (audio/chapters/cover untouched, ~seconds
 * even for a multi-hour book) that preserves the ftyp brand and faststart layout, so
 * the file stays a fully compatible audiobook everywhere — players that don't read
 * timed text simply ignore the subtitle track. Re-embedding is idempotent: any
 * pre-existing subtitle track is dropped first (`-map -0:s`), so repeated assembles
 * never stack tracks.
 *
 * Verified empirically (see the linking-guarantee work): the `-f ipod`/m4b muxer
 * REJECTS `mov_text` ("Tag text incompatible"), so this uses `-f mp4` and restores
 * the original brand via `-brand`. `tx3g` round-trips plain sentence cues losslessly.
 */
export async function embedVttInM4b(
  m4bPath: string,
  vttPath: string,
  opts?: { language?: string; timeoutMs?: number },
): Promise<void> {
  if (!fs.existsSync(m4bPath)) throw new Error(`embedVttInM4b: audiobook not found: ${m4bPath}`);
  if (!fs.existsSync(vttPath)) throw new Error(`embedVttInM4b: transcript not found: ${vttPath}`);

  const ffmpeg = getFfmpegPath();
  const brand = await readMajorBrand(m4bPath);
  const lang = (opts?.language || 'und').slice(0, 3);
  // Write to a sibling temp file, then rename over the original — a same-directory
  // rename is atomic, so a crash mid-encode never corrupts the finished m4b.
  const tmpOut = path.join(path.dirname(m4bPath), `.embed-${process.pid}-${Date.now()}.m4b`);

  const args = [
    '-v', 'error', '-y',
    '-i', m4bPath,
    '-i', vttPath,
    // Keep EVERYTHING from the m4b except any prior subtitle track (idempotent
    // re-embed), then add this transcript as the sole subtitle stream.
    // Data tracks are dropped too: imported audiobooks can carry bin_data
    // tracks with corrupt sample tables whose rescaled packet durations
    // overflow the mp4 muxer's 32-bit limit ("Application provided duration
    // ... is invalid"). Chapters live at container level, so nothing is lost.
    '-map', '0', '-map', '-0:s', '-map', '-0:d', '-map', '1:s:0',
    '-c', 'copy', '-c:s', 'mov_text',
    '-map_metadata', '0',
    '-metadata:s:s:0', `language=${lang}`,
    // Not a "forced"/default subtitle — a video player that opens it shouldn't
    // burn it in; audiobook players ignore it regardless.
    '-disposition:s:0', '0',
    '-brand', brand,
    '-movflags', '+faststart',
    '-f', 'mp4',
    tmpOut,
  ];

  try {
    const { code, stderr } = await runProc(ffmpeg, args, opts?.timeoutMs ?? 600_000);
    if (code !== 0) throw new Error(`ffmpeg failed to embed the transcript (${code}): ${stderr.slice(-400)}`);
    // Verify the candidate before replacing the original. A malformed subtitle
    // mux must never destroy a previously-good embedded transcript or audiobook.
    if ((await extractVttFromM4b(tmpOut, opts?.timeoutMs ?? 120_000)) === null) {
      throw new Error('Embedded transcript verification failed');
    }
    fs.renameSync(tmpOut, m4bPath);
  } catch (err) {
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* non-critical */ }
    throw err;
  }
}

/**
 * Extract the WebVTT transcript embedded in an `.m4b` by {@link embedVttInM4b}.
 * Returns the VTT text, or `null` when the file carries no subtitle track (older
 * audiobooks produced before embedding — the caller then falls back to a sidecar
 * `.vtt`). Uses a dedicated full-stdout runner because a book's transcript far
 * exceeds `runProc`'s capped buffer.
 */
export async function extractVttFromM4b(m4bPath: string, timeoutMs = 120_000): Promise<string | null> {
  if (!fs.existsSync(m4bPath)) return null;
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-v', 'error', '-i', m4bPath, '-map', '0:s:0', '-f', 'webvtt', '-'], { windowsHide: true });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } resolve(null); }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; } // no subtitle stream / unreadable
      const out = Buffer.concat(chunks).toString('utf-8').trim();
      resolve(out.startsWith('WEBVTT') ? out : null);
    });
  });
}

/**
 * Resolve a readable WebVTT for an audiobook, embed-only-safe: return the sidecar
 * file if it exists, else extract the transcript EMBEDDED in the m4b to a temp
 * file. Returns `{ path, viaTemp }` (viaTemp temps live in os.tmpdir — the caller
 * may unlink after use, or leave them for OS cleanup) or null when neither source
 * yields a transcript. Lets features that need a .vtt on disk (video assembly,
 * chapter recovery) keep working after sidecars are deleted.
 */
export async function resolveReadableVtt(opts: { vttPath?: string; m4bPath?: string }): Promise<{ path: string; viaTemp: boolean } | null> {
  // Embed-FIRST: the transcript sealed inside the m4b is the trusted source
  // (guaranteed to match THIS audio). A sidecar is only consulted when the file
  // carries no embedded track — i.e. bilingual/imported audio that still uses one.
  if (opts.m4bPath) {
    const text = await extractVttFromM4b(opts.m4bPath);
    if (text) {
      const tmp = path.join(os.tmpdir(), `bf-vtt-${process.pid}-${Date.now()}-${Math.round(process.hrtime()[1] % 1e6)}.vtt`);
      fs.writeFileSync(tmp, text, 'utf-8');
      return { path: tmp, viaTemp: true };
    }
  }
  if (opts.vttPath && fs.existsSync(opts.vttPath)) return { path: opts.vttPath, viaTemp: false };
  return null;
}

/**
 * Embed a transcript into an m4b AND verify the track reads back (extract returns
 * cues). The candidate file is verified before it atomically replaces the original,
 * so failure preserves the existing audiobook and throws to the caller.
 */
export async function embedAndVerifyVtt(
  m4bPath: string,
  vttPath: string,
  opts?: { language?: string; timeoutMs?: number },
): Promise<boolean> {
  await embedVttInM4b(m4bPath, vttPath, opts);
  return (await extractVttFromM4b(m4bPath)) !== null;
}

/**
 * Delete the sidecar `.vtt`(s) belonging to a specific m4b (embed-only model keeps
 * transcripts INSIDE the m4b). Safe in shared/external folders: only removes the
 * exact `<stem>.vtt` match UNLESS the m4b is the ONLY one in its directory — then
 * every mono `.vtt` there is unambiguously its transcript, so all are removed (this
 * catches differently-named strays like `subtitles.vtt`, `audiobook.vtt`, and the
 * author-suffixed e2a name that caused the original mislink confusion). Always skips
 * `bilingual-*.vtt` (bilingual still uses sidecars) and `._` forks. Best-effort —
 * never throws. Returns the count removed.
 */
export function deleteSidecarsForM4b(m4bPath: string): number {
  const dir = path.dirname(m4bPath);
  const stem = path.parse(m4bPath).name;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  const vtts = entries.filter(
    (n) => n.toLowerCase().endsWith('.vtt') && !n.startsWith('._') && !n.startsWith('bilingual-'),
  );
  const m4bCount = entries.filter((n) => n.toLowerCase().endsWith('.m4b') && !n.startsWith('._')).length;
  const targets = m4bCount <= 1
    ? vtts                                              // sole audiobook → every mono .vtt is its transcript
    : vtts.filter((n) => path.parse(n).name === stem);  // shared dir → only the exact stem match, never a sibling's
  let removed = 0;
  for (const n of targets) {
    try { fs.unlinkSync(path.join(dir, n)); removed++; } catch { /* locked / already gone */ }
  }
  return removed;
}

/**
 * Get the name of the available metadata tool
 */
export function getMetadataToolName(): string | null {
  const toolInfo = getMetadataToolPath();
  return toolInfo?.tool || null;
}
