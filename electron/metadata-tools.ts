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

import { spawn, execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getFfmpegPath, getFfprobePath } from './tool-paths';

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
      try {
        fs.renameSync(filePath, tmpPrev);
        try {
          fs.renameSync(tmpOut, filePath);
        } catch (swapErr) {
          try { fs.renameSync(tmpPrev, filePath); } catch { /* best effort restore */ }
          throw swapErr;
        }
        try { if (fs.existsSync(tmpPrev)) fs.unlinkSync(tmpPrev); } catch { /* ignore */ }
        finish('resolve');
      } catch (err) {
        cleanupTmp();
        finish('reject', err instanceof Error ? err : new Error(String(err)));
      }
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

/**
 * Apply metadata (and optionally swap the cover) on an audiobook file.
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

  // Collect the metadata flags so we can skip the whole remux if there's nothing
  // to write and no cover to swap.
  const metaFlags: string[] = [];
  if (metadata.title) metaFlags.push('-metadata', `title=${metadata.title}`);
  if (artistString) metaFlags.push('-metadata', `artist=${artistString}`);
  if (metadata.year) {
    // Full date if given (YYYY-MM-DD), else year-only — ffmpeg accepts both.
    metaFlags.push('-metadata', `date=${metadata.year}`);
  }
  if (metadata.narrator) metaFlags.push('-metadata', `composer=${metadata.narrator}`);
  if (metadata.series) metaFlags.push('-metadata', `grouping=${metadata.series}`);
  if (metadata.genre) metaFlags.push('-metadata', `genre=${metadata.genre}`);
  if (metadata.description) metaFlags.push('-metadata', `description=${metadata.description}`);

  if (metaFlags.length === 0 && !optimizedCoverPath) {
    console.log('[METADATA-TOOLS] No metadata or cover to apply');
    return Promise.resolve();
  }

  function cleanupOptimizedCover() {
    if (optimizedCoverPath && optimizedCoverPath !== metadata.coverPath) {
      try { fs.unlinkSync(optimizedCoverPath); } catch { /* non-critical */ }
    }
  }

  return ffmpegRemuxInPlace(
    filePath,
    (tmpOut) => {
      const args = ['-v', 'error', '-y', '-i', filePath];
      if (optimizedCoverPath) args.push('-i', optimizedCoverPath);

      // Audio first, then the cover. Chapters are regenerated from the source.
      args.push('-map', '0:a');
      if (optimizedCoverPath) {
        args.push('-map', '1:0');          // explicit stream — NOT 1:v (drops cover)
      } else {
        args.push('-map', '0:v?');         // keep an existing cover if present
      }
      args.push('-map_chapters', '0');
      args.push('-c:a', 'copy', '-c:v', 'copy');
      if (optimizedCoverPath) args.push('-disposition:v:0', 'attached_pic');
      // NOTE: do NOT add `-movflags use_metadata_tags` here — it silently drops
      // the attached_pic cover stream. All fields below are standard mp4 keys
      // (title/artist/composer/grouping/genre/date/media_type) and write fine
      // without it.
      args.push(...metaFlags);
      // iTunes "audiobook" media kind (stik=2) — keep players treating it right.
      args.push('-metadata', 'media_type=2');
      args.push(tmpOut);
      return args;
    },
    { label: 'applyMetadata', timeoutMs: options?.timeoutMs ?? 180_000, signal: options?.signal }
  ).then(
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
    proc.stdout?.on('data', (d) => { const s = d.toString(); stdout = appendCapped(stdout, s); onStdout?.(s); });
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
    '-map', '0', '-map', '-0:s', '-map', '1:s:0',
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
  if (opts.vttPath && fs.existsSync(opts.vttPath)) return { path: opts.vttPath, viaTemp: false };
  if (opts.m4bPath) {
    const text = await extractVttFromM4b(opts.m4bPath);
    if (text) {
      const tmp = path.join(os.tmpdir(), `bf-vtt-${process.pid}-${Date.now()}-${Math.round(process.hrtime()[1] % 1e6)}.vtt`);
      fs.writeFileSync(tmp, text, 'utf-8');
      return { path: tmp, viaTemp: true };
    }
  }
  return null;
}

/**
 * Embed a transcript into an m4b AND verify the track reads back (extract returns
 * cues). Returns true only when the m4b now carries a readable transcript — the
 * safe precondition for deleting the sidecar. Throws only if the embed ffmpeg
 * itself fails; callers treat throw/false as "keep the sidecar as fallback".
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
