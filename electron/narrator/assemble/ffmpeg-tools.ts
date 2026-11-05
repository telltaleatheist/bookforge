/**
 * Driving ffmpeg and ffprobe. A port of `narrator/assemble/ffmpeg_tools.py`.
 *
 * The binaries are stated by the caller: this code runs in a worker thread and cannot ask
 * Electron where they are, and a missing one is the caller's refusal to make.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/** Cancelling kills the running child and rejects with this. */
export class AssemblyCancelled extends Error {
  constructor() {
    super('Assembly was cancelled');
    this.name = 'AssemblyCancelled';
  }
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** Called with each stdout line, for `-progress pipe:1`. Stdout is otherwise dropped. */
  readonly onLine?: (line: string) => void;
  /** Called with each stdout buffer, for raw PCM. */
  readonly onData?: (data: Buffer) => void;
}

const STDERR_TAIL = 1200;

/** Stderr is held only as its tail, so a chatty child cannot grow this. */
export function run(cmd: readonly string[], what: string, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AssemblyCancelled());
      return;
    }
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let partial = '';
    // The tree, on Windows: the ffmpeg on PATH can be a package manager's shim, and killing the
    // shim leaves the real encoder running with the work dir open.
    const onAbort = (): void => {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      options.onData?.(data);
      if (options.onLine) {
        partial += data.toString('utf8');
        const lines = partial.split('\n');
        partial = lines.pop() as string;
        for (const line of lines) options.onLine(line.trim());
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`${what} could not start ${cmd[0]}: ${err.message}`));
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        reject(new AssemblyCancelled());
      } else if (code !== 0) {
        reject(new FfmpegError(`${what} failed (exit ${code}):\n  command: ${cmd.join(' ')}\n  stderr: ${stderr.trim()}`));
      } else {
        resolve();
      }
    });
  });
}

/** Container duration in seconds. Raises rather than returning 0: a zero looks like silence, and both duration guards would pass a truncated book. */
export async function probeDuration(file: string, ffprobe: string, signal?: AbortSignal): Promise<number> {
  if (!fs.existsSync(file)) throw new FfmpegError(`probe_duration(): file not found: ${file}`);
  let out = '';
  await run(
    [ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', file],
    `ffprobe of ${path.basename(file)}`,
    { signal, onData: (data) => { out += data.toString('utf8'); } },
  );
  const raw = out.trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) throw new FfmpegError(`probe_duration(): ffprobe reported no usable duration for ${file} (got '${raw}')`);
  if (value <= 0) throw new FfmpegError(`probe_duration(): ${file} reports a duration of ${value}s`);
  return value;
}

/**
 * A concat-demuxer list: forward slashes, a single quote in the demuxer's own spelling. Fsynced
 * and read back, because "I wrote it" and "another process can read it" differ on Windows.
 */
export async function writeConcatList(paths: readonly string[], listPath: string): Promise<string> {
  if (paths.length === 0) throw new FfmpegError(`write_concat_list(): nothing to write into ${listPath}`);
  const handle = await fs.promises.open(listPath, 'w');
  try {
    const text = paths.map((p) => `file '${p.split(path.sep).join('/').replace(/'/g, "'\\''")}'\n`).join('');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const written = await fs.promises.stat(listPath).catch(() => null);
  if (written === null || written.size === 0) {
    throw new FfmpegError(`write_concat_list(): ${listPath} is missing or empty immediately after writing ${paths.length} entries - something else is writing into this working directory`);
  }
  return listPath;
}
