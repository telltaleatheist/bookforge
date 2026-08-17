/**
 * env-downloader — bytes off a release, verified, and out of an archive.
 *
 * Adapted from BookForge's electron/components/downloader.ts, keeping the three
 * ideas that took it several bugs to get right and none of the component-manager
 * machinery around them:
 *
 *   **Split assets are concatenated one part at a time.** GitHub caps a release
 *   asset at 2 GiB, so the WSL environment arrives as three. Each part is
 *   fetched to its own file, appended to the growing archive, then DELETED — so
 *   peak extra disk is the archive plus one part, not the archive twice.
 *
 *   **Redirects are followed by hand.** A release download is a 302 to
 *   objects.githubusercontent.com with a signed query string; `https.get` does
 *   not follow it, and a 302 body written to disk is a 200-byte "archive" that
 *   fails its hash a very long way from the cause.
 *
 *   **Abort is real.** The request is destroyed, the partial file is unlinked,
 *   and the promise rejects. A cancel that left four gigabytes of temp behind is
 *   not a cancel.
 *
 * ── Hashing rides along ──────────────────────────────────────────────────────
 *
 * Every byte is hashed AS IT MOVES: once on the way to the part file (that is
 * the part's own sha256) and once on the way from the part file into the archive
 * (that is the reassembled archive's). A 5 GB archive therefore costs zero extra
 * reads to verify, where the obvious implementation — write it all, then hash
 * the file — costs a full re-read of five gigabytes.
 *
 * ── A bad hash deletes the file ──────────────────────────────────────────────
 *
 * And names both hashes. Keeping a mis-hashed archive around invites the next
 * run to "resume" onto bytes that are already wrong, and a message that says
 * only "checksum failed" tells the user nothing they can check against the
 * release page.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

/** How many hops before we call it a loop. Releases use one; ten is generous. */
const MAX_REDIRECTS = 10;

export class AbortedError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'AbortedError';
  }
}

export function isAborted(err: unknown): boolean {
  return err instanceof AbortedError;
}

// ─────────────────────────────────────────────────────────────────────────────
// One file
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchedFile {
  bytes: number;
  /** Computed on the way to disk. Lowercase hex. */
  sha256: string;
}

/**
 * One URL to one path, with redirects, progress and abort.
 *
 * `onBytes` is called with the count SO FAR for this file; the caller adds the
 * bytes already banked from earlier parts, because only the caller knows what
 * the aggregate is meant to be.
 */
export function fetchToFile(
  url: string,
  destPath: string,
  onBytes: (received: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<FetchedFile> {
  return new Promise<FetchedFile>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }

    const hash = crypto.createHash('sha256');
    const file = fs.createWriteStream(destPath);
    let request: http.ClientRequest | null = null;
    let settled = false;
    let received = 0;

    const discard = (): void => {
      try { file.destroy(); } catch { /* already closed */ }
      fs.unlink(destPath, () => { /* best effort */ });
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try { request?.destroy(); } catch { /* already gone */ }
      discard();
      reject(new AbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      discard();
      reject(err);
    };
    const succeed = (result: FetchedFile): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const get = (current: string, hopsLeft: number): void => {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        fail(new Error(`${current} is not a URL this app can fetch.`));
        return;
      }
      const transport = parsed.protocol === 'https:' ? https : http;

      request = transport.get(current, { headers: { 'user-agent': 'foundry-app' } }, (response) => {
        const status = response.statusCode ?? 0;

        // ── Redirect: a release download IS one, every time ──────────────────
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (hopsLeft <= 0) {
            fail(new Error(`${url} redirected more than ${MAX_REDIRECTS} times.`));
            return;
          }
          get(new URL(location, current).toString(), hopsLeft - 1);
          return;
        }

        if (status !== 200) {
          response.resume();
          fail(new Error(
            status === 404
              // The single likeliest cause, said plainly rather than as an HTTP code.
              ? `${url} is not on the release (HTTP 404). The catalog names an asset that was never uploaded.`
              : `${url} answered HTTP ${status}.`,
          ));
          return;
        }

        const declared = Number(response.headers['content-length'] ?? 0);
        const total = declared > 0 ? declared : null;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
          onBytes(received, total);
        });
        response.on('error', fail);
        response.pipe(file);

        file.on('finish', () => {
          file.close((closeErr) => {
            if (closeErr) { fail(closeErr); return; }
            succeed({ bytes: received, sha256: hash.digest('hex') });
          });
        });
      });

      request.on('error', (err) => fail(err));
    };

    file.on('error', fail);
    get(url, MAX_REDIRECTS);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare, and on a mismatch DELETE the file and name both hashes.
 *
 * `expected` being null never reaches here — env-catalog's `requirePublished`
 * refuses that entry before anything is fetched. The parameter is nullable only
 * so callers can pass the catalog field straight through, and a null arriving
 * anyway is treated as the bug it is rather than as permission to skip.
 */
export function verifyHash(
  label: string,
  filePath: string,
  expected: string | null,
  actual: string,
): void {
  if (expected === null) {
    fs.rmSync(filePath, { force: true });
    throw new Error(
      `${label} has no expected sha256 in the catalog, so the download cannot be verified. `
      + 'Refusing to install it. (This is a bug: an unpublished entry should never have been fetched.)',
    );
  }
  if (actual.toLowerCase() === expected.toLowerCase()) return;
  fs.rmSync(filePath, { force: true });
  throw new Error(
    `${label} does not match the catalog and has been deleted.\n`
    + `  expected sha256 ${expected.toLowerCase()}\n`
    + `  got      sha256 ${actual.toLowerCase()}\n`
    + 'Either the release asset changed or the download was corrupted in transit.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Many files, one archive
// ─────────────────────────────────────────────────────────────────────────────

/** Append `src` onto `dest`, feeding every byte to `hash` on the way past. */
function appendInto(dest: string, src: string, hash: crypto.Hash): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const reader = fs.createReadStream(src);
    const writer = fs.createWriteStream(dest, { flags: 'a' });
    reader.on('data', (chunk) => hash.update(chunk));
    reader.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', () => resolve());
    reader.pipe(writer);
  });
}

export interface ArchiveSource {
  url: string;
  bytes: number | null;
  sha256: string | null;
}

/**
 * Fetch an ordered list of sources into one archive and return its sha256.
 *
 * A single-source list is the ordinary case and costs no extra copy: it is
 * fetched straight to `archivePath` and its download-time hash IS the archive's.
 * A split list is concatenated in the order given — nothing here sorts, because
 * the only correct order is the catalog's and `part10` sorts before `part2`.
 */
export async function fetchArchive(
  sources: readonly ArchiveSource[],
  archivePath: string,
  totalBytes: number,
  onProgress: (received: number, total: number, detail: string) => void,
  signal: AbortSignal,
): Promise<string> {
  if (sources.length === 0) throw new Error('The catalog names no asset to download.');

  // Start clean: appending onto a stale archive from a previous attempt is a
  // file that is the right size in the wrong way.
  fs.rmSync(archivePath, { force: true });

  const only = sources[0];
  if (sources.length === 1 && only) {
    const fetched = await fetchToFile(
      only.url,
      archivePath,
      (received, total) => onProgress(received, total ?? totalBytes, sizeLine(received, totalBytes)),
      signal,
    );
    verifyHash(path.basename(only.url), archivePath, only.sha256, fetched.sha256);
    return fetched.sha256;
  }

  const whole = crypto.createHash('sha256');
  let banked = 0;

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (!source) continue;
    if (signal.aborted) throw new AbortedError();

    const partPath = `${archivePath}.part${index}`;
    const name = path.basename(new URL(source.url).pathname);
    const fetched = await fetchToFile(
      source.url,
      partPath,
      (received) => onProgress(
        banked + received,
        totalBytes,
        `${sizeLine(banked + received, totalBytes)} · part ${index + 1} of ${sources.length}`,
      ),
      signal,
    );

    // Each part is checked the moment it lands. A bad part0 is worth naming now
    // rather than after two more gigabytes and a failing archive hash.
    verifyHash(name, partPath, source.sha256, fetched.sha256);

    await appendInto(archivePath, partPath, whole);
    banked += fetched.bytes;
    fs.rmSync(partPath, { force: true });
  }

  return whole.digest('hex');
}

function sizeLine(received: number, total: number): string {
  return total > 0 ? `${gib(received)} of ${gib(total)}` : gib(received);
}

/** Human bytes. Two decimals over a gigabyte, none below a megabyte. */
export function gib(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unpacking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tar to run — an ABSOLUTE path on Windows, never "tar" off PATH.
 *
 * BookForge learned this one the hard way and it is worth restating: Windows has
 * shipped bsdtar at %SystemRoot%\System32\tar.exe since Win10 1803, and bsdtar
 * accepts `C:\…` and reads gzip fine. A GNU tar earlier on PATH — Git for
 * Windows puts one at usr\bin\tar — reads `C:\path` as a REMOTE host named `C`
 * (the colon is its host separator) and fails in a way that reads like a network
 * error. Pinning the absolute path removes the whole class.
 */
export function tarBinary(): string {
  if (process.platform === 'win32') {
    const system32 = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(system32)) return system32;
  }
  return 'tar';
}

/**
 * Extract a .tar.gz into `destDir`, reporting files as they land.
 *
 * `-v` is not a debug flag here: unpacking five gigabytes of CUDA wheels takes
 * minutes, and the house rule (see backend-setup.ts) is that a long step talks
 * the whole time. There is no honest percentage — the file COUNT is what we
 * have, so that is what is reported, and the UI draws this phase as an
 * indeterminate bar rather than inventing a number.
 *
 * An argument ARRAY, never a shell string: destinations under
 * `C:\Users\Some One\AppData` are the normal case.
 */
export function unpackTarGz(
  archivePath: string,
  destDir: string,
  onFile: (count: number, last: string) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const child = spawn(tarBinary(), ['-xzvf', archivePath, '-C', destDir], { windowsHide: true });

    let files = 0;
    let pending = '';
    let stderrTail = '';
    let settled = false;

    const onAbort = (): void => {
      try { child.kill(); } catch { /* already gone */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };

    // bsdtar writes its file list to STDERR and GNU tar to stdout; both are read
    // rather than guessing which tar this is.
    const feed = (chunk: Buffer): void => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.slice(-4000);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const name = line.replace(/^x\s+/, '').trim();
        if (name.length === 0) continue;
        files += 1;
        // Every file would be tens of thousands of IPC messages for one bar.
        if (files % 250 === 0) onFile(files, name);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);

    child.on('error', (err) => finish(() => reject(
      new Error(`${tarBinary()} could not be started: ${err.message}`),
    )));
    child.on('close', (code) => finish(() => {
      if (signal.aborted) { reject(new AbortedError()); return; }
      if (code === 0) { onFile(files, ''); resolve(); return; }
      reject(new Error(`tar exited ${code} unpacking ${path.basename(archivePath)}.\n${stderrTail.trim()}`));
    }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Somewhere to put the archive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A temp directory for the download, on a volume with room for it.
 *
 * `FOUNDRY_ENV_TMP` overrides, because the WSL environment is five gigabytes and
 * a machine whose %TEMP% is on a small SSD needs somewhere to say otherwise.
 */
export function makeTempDir(): string {
  const root = process.env['FOUNDRY_ENV_TMP']?.trim() || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'foundry-env-'));
}

/**
 * Remove it, retrying briefly.
 *
 * `force: true` only forgives a directory that is already GONE — it does not
 * forgive one Windows still has a handle on, and a cancel destroys the write
 * stream microseconds before this runs. A single rmSync therefore leaves the
 * directory behind on exactly the path (cancel) that runs most often, one per
 * attempt, forever. Three tries a quarter-second apart is enough for the handle
 * to close; failing that it is left, because an installer that throws while
 * tidying up would replace a real error message with a housekeeping one.
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ }
}
