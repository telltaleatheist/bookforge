/**
 * Downloader — runtime download + verify + extract primitive for optional
 * components. Promotes the logic from scripts/download-mupdf.js into a reusable
 * main-process module with progress, sha256 verification, and abort support.
 *
 * Emits InstallProgress for the 'download', 'verify', and 'extract' phases.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

import type { ComponentArtifact, InstallProgress } from './component-types';

const execAsync = promisify(exec);

export interface DownloadHandle {
  cancel(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: streamed download with redirects + progress + abort
// ─────────────────────────────────────────────────────────────────────────────

export function downloadFile(
  url: string,
  destPath: string,
  id: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Download aborted'));
      return;
    }

    const file = fs.createWriteStream(destPath);
    let activeRequest: http.ClientRequest | null = null;
    let settled = false;

    const cleanupPartial = () => {
      try {
        file.close();
      } catch {
        /* ignore */
      }
      fs.unlink(destPath, () => {});
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        activeRequest?.destroy();
      } catch {
        /* ignore */
      }
      cleanupPartial();
      reject(new Error('Download aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      fn();
    };

    const makeRequest = (currentUrl: string, redirectsLeft: number) => {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        finish(() => {
          cleanupPartial();
          reject(new Error(`Invalid URL: ${currentUrl}`));
        });
        return;
      }

      const protocol = parsed.protocol === 'https:' ? https : http;

      activeRequest = protocol.get(currentUrl, (response) => {
        const status = response.statusCode ?? 0;

        // Redirects.
        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirectsLeft <= 0) {
            response.resume();
            finish(() => {
              cleanupPartial();
              reject(new Error('Too many redirects'));
            });
            return;
          }
          const next = new URL(response.headers.location, currentUrl).toString();
          console.log(`[COMPONENTS] Redirecting to ${next}`);
          response.resume();
          makeRequest(next, redirectsLeft - 1);
          return;
        }

        if (status !== 200) {
          response.resume();
          finish(() => {
            cleanupPartial();
            reject(new Error(`HTTP ${status} downloading ${currentUrl}`));
          });
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let receivedBytes = 0;
        let lastPct = -1;

        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((receivedBytes / totalBytes) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress({
                id,
                phase: 'download',
                pct,
                receivedBytes,
                totalBytes,
              });
            }
          } else {
            onProgress({ id, phase: 'download', pct: 0, receivedBytes });
          }
        });

        response.on('error', (err) => {
          finish(() => {
            cleanupPartial();
            reject(err);
          });
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close((closeErr) => {
            if (closeErr) {
              finish(() => {
                cleanupPartial();
                reject(closeErr);
              });
              return;
            }
            onProgress({
              id,
              phase: 'download',
              pct: 100,
              receivedBytes,
              totalBytes: totalBytes || receivedBytes,
            });
            finish(resolve);
          });
        });
      });

      activeRequest.on('error', (err) => {
        finish(() => {
          cleanupPartial();
          reject(err);
        });
      });
    };

    file.on('error', (err) => {
      finish(() => {
        cleanupPartial();
        reject(err);
      });
    });

    makeRequest(url, 10);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: split (multi-part) download → concatenated archive
// ─────────────────────────────────────────────────────────────────────────────

/** Stream-append `src` onto the end of `dest` (dest opened in append mode). */
function appendFileStream(dest: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = fs.createReadStream(src);
    const writer = fs.createWriteStream(dest, { flags: 'a' });
    reader.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);
    reader.pipe(writer);
  });
}

/**
 * Download an ordered list of part URLs and concatenate them into `archivePath`,
 * for artifacts split to fit a host's per-file cap (GitHub Releases = 2 GiB).
 * Each part is fetched to a temp file, appended to the growing archive, then
 * deleted — so peak extra disk is one part, not the whole set. Progress is
 * reported as an aggregate against `totalBytes` (the reassembled size).
 */
async function downloadParts(
  parts: string[],
  archivePath: string,
  id: string,
  totalBytes: number,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  // Start from a clean archive so a retry can't append onto stale bytes.
  try { fs.unlinkSync(archivePath); } catch { /* not there yet */ }

  let completedBytes = 0;
  for (let i = 0; i < parts.length; i++) {
    if (signal?.aborted) throw new Error('Download aborted');
    const partPath = `${archivePath}.part${i}`;
    await downloadFile(parts[i], partPath, id, (p) => {
      const received = completedBytes + (p.receivedBytes ?? 0);
      onProgress({
        id,
        phase: 'download',
        pct: totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0,
        receivedBytes: received,
        totalBytes: totalBytes || undefined,
      });
    }, signal);
    await appendFileStream(archivePath, partPath);
    completedBytes += fs.statSync(partPath).size;
    fs.unlinkSync(partPath);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: sha256 verification
// ─────────────────────────────────────────────────────────────────────────────

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The archiver binary to invoke — RAW path, no shell quoting (use with execFile/spawn-style
 * array args). The extraction code relies on bsdtar semantics: it reads .zip archives and
 * accepts drive-letter paths like "C:\…". On Windows that archiver is the OS-bundled bsdtar at
 * %SystemRoot%\System32\tar.exe (present since Win10 1803). We pin to its absolute path rather
 * than resolving "tar" off PATH, because a GNU tar earlier on PATH (e.g. Git for Windows'
 * usr\bin\tar) would BREAK this in two ways: it treats "C:\…" as a remote "C" host (the colon =
 * host separator), and it cannot read zip archives at all. macOS/Linux already provide a
 * suitable tar on PATH, so there we just use "tar".
 *
 * Exported as the single source of truth — other tar shell-outs (e2a env extraction) reuse it.
 * For a string passed to a shell (exec/execAsync), wrap the result in quotes; see tarCmd().
 */
export function osTarBin(): string {
  if (os.platform() === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

/** osTarBin() shell-quoted for interpolation into an exec/execAsync command string. */
function tarCmd(): string {
  const bin = osTarBin();
  return bin === 'tar' ? 'tar' : `"${bin}"`;
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  url: string
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  const lower = (url || archivePath).toLowerCase();
  const isTarGz = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const isZip = lower.endsWith('.zip');

  const maxBuffer = 50 * 1024 * 1024;
  const tar = tarCmd();

  if (isTarGz) {
    await execAsync(`${tar} -xzf "${archivePath}" -C "${destDir}"`, { maxBuffer });
    return;
  }

  if (isZip) {
    if (os.platform() === 'win32') {
      // Win10+ ships bsdtar, which reads zip files (pinned via tarCmd()).
      await execAsync(`${tar} -xf "${archivePath}" -C "${destDir}"`, { maxBuffer });
    } else {
      await execAsync(`unzip -q -o "${archivePath}" -d "${destDir}"`, { maxBuffer });
    }
    return;
  }

  throw new Error(
    `Unsupported archive type for ${url || archivePath} (expected .tar.gz/.tgz/.zip)`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: downloadAndExtract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download an artifact (with redirects + progress), verify its sha256, and
 * extract it into destDir. Throws on any failure (http error, bad checksum,
 * extract failure, abort). Cleans up partial downloads on error.
 */
export async function downloadAndExtract(
  artifact: ComponentArtifact,
  destDir: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const hasParts = Array.isArray(artifact.parts) && artifact.parts.length > 0;
  if (!artifact.url && !hasParts) {
    throw new Error('Artifact has no download URL');
  }

  const id = `${artifact.platform}-${artifact.arch}`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-dl-'));

  // Derive a sensible archive filename from the URL (the canonical archive name,
  // even for split artifacts — used for the extraction's archive-type sniff).
  let fileName = 'artifact';
  try {
    const parsed = new URL(artifact.url);
    const base = path.basename(parsed.pathname);
    if (base) fileName = base;
  } catch {
    /* keep default */
  }
  const archivePath = path.join(tmpRoot, fileName);

  try {
    // ── Download (single file, or reassembled from parts) ──
    if (hasParts) {
      await downloadParts(artifact.parts!, archivePath, id, artifact.bytes, onProgress, signal);
    } else {
      await downloadFile(artifact.url, archivePath, id, onProgress, signal);
    }

    if (signal?.aborted) {
      throw new Error('Download aborted');
    }

    // ── Verify (sha256) ──
    if (artifact.sha256 && artifact.sha256.trim() !== '') {
      onProgress({ id, phase: 'verify', pct: 0, message: 'Verifying checksum…' });
      const actual = await sha256File(archivePath);
      if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) {
        throw new Error(
          `Checksum mismatch: expected ${artifact.sha256}, got ${actual}`
        );
      }
      onProgress({ id, phase: 'verify', pct: 100, message: 'Checksum OK' });
    } else {
      console.warn(
        '[COMPONENTS] Artifact sha256 is empty — skipping checksum verification'
      );
      onProgress({ id, phase: 'verify', pct: 100, message: 'Checksum skipped (none provided)' });
    }

    if (signal?.aborted) {
      throw new Error('Download aborted');
    }

    // ── Extract ──
    onProgress({ id, phase: 'extract', pct: 0, message: 'Extracting…' });
    await extractArchive(archivePath, destDir, artifact.url);
    onProgress({ id, phase: 'extract', pct: 100, message: 'Extracted' });
  } finally {
    // Always clean up the temp download dir (archive + partials).
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
