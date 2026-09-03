/**
 * Tab Recorder — the server side of `record.*` (docs/TAB_RECORDER.md).
 *
 * The browser hands us raw f32le PCM over the TTS API socket; this module owns
 * the file. Nothing is decoded here and nothing is re-encoded lossily: the frames
 * go straight into `ffmpeg -f f32le -ar R -ac C -i pipe:0 -c:a flac`, and `-ar`
 * / `-ac` describe the INPUT only — there is no resampling anywhere in the chain.
 *
 * Where things live is the USER'S choice — `~/Downloads` by default, set in the
 * extension's Options and carried on every `record.start` as `outputDir`. A
 * recording is a file someone made and wants to find, not app state, so it does
 * not live in a folder of ours.
 *
 * While it is being written it is `<dir>/.<stem>.partial.flac`: a dotfile with a
 * suffix nothing can mistake for a finished recording, in the SAME directory as
 * the final file. Same directory is not a detail — a staging folder elsewhere
 * would make the finishing rename cross-volume, and rename(2) answers EXDEV the
 * first time a user points this at an external disk. The sidecar is written
 * after the rename, so a `.json` always describes a file that exists.
 *
 * Crash recovery: `sweepPartialRecordings()` deletes leftover `.partial.flac`
 * files at server start, in every directory a recording has ever used. That list
 * is machine-local, in `{userData}/tab-recordings.json` — NOT tts-api.json,
 * whose loader rewrites the file from a fixed shape and would drop it.
 *
 * This module deliberately imports nothing from Electron — `getFfmpegPath` is
 * loaded lazily inside the ffmpeg factory — so the state machine is requirable
 * (and testable) from plain node. See `npm run test:tab-recorder`.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_RECORDINGS_DIR,
  RECORDER,
  RecordingMark,
  RecordingSidecar,
  RecordingState,
  isTerminalRecordingState,
  expandHome,
  isPartialFileName,
  partialFileName,
  recordingFileName,
  relabelRefusal,
  relabelledSampleRate,
  secondsFromBytes,
  sidecarFileName,
} from '../shared/audio/tab-recording';

// ─── Where recordings go ──────────────────────────────────────────────────────

/**
 * Turn the user's setting into an absolute directory, or say why it can't be.
 *
 * `~` is expanded here rather than in the extension because the extension has no
 * filesystem and no idea what the server's home directory is — and on Windows
 * that is `C:\Users\<name>`, which is exactly the case a client-side guess would
 * get wrong. Anything that is not absolute after expansion is REFUSED: a relative
 * path would resolve against whatever directory the app happened to be launched
 * from, which is a different folder depending on how BookForge was started.
 */
export function resolveRecordingDir(input?: string | null): string {
  const raw = (input ?? '').trim() || DEFAULT_RECORDINGS_DIR;
  const expanded = expandHome(raw, os.homedir());
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `'${raw}' is not an absolute folder — set a full path (or one starting with ~) ` +
      `in the extension's Options under "Save recordings to".`
    );
  }
  return path.normalize(expanded);
}

/** Create the directory if it isn't there, and prove we can write in it. Both
 *  failures are named: "the recording is going nowhere" must be said now, not
 *  after six hours. */
export async function ensureRecordingDir(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`cannot create the recordings folder ${dir}: ${(err as Error).message}`);
  }
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`the recordings folder ${dir} is not writable`);
  }
}

// ─── Remembering where recordings have gone (for the crash sweep) ─────────────

/** Machine-local list of every directory a recording has used. Set by the server
 *  from its userData path; until then, nothing is remembered and nothing is
 *  swept (which is the correct behaviour outside the app — e.g. in tests). */
let dirsStorePath: string | null = null;

export function setRecordingDirsStore(filePath: string): void {
  dirsStorePath = filePath;
}

async function readRecordingDirs(): Promise<string[]> {
  if (!dirsStorePath) return [];
  try {
    const parsed = JSON.parse(await fs.promises.readFile(dirsStorePath, 'utf-8')) as { dirs?: unknown };
    return Array.isArray(parsed.dirs) ? parsed.dirs.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return []; // never written, or unreadable — either way there is nothing to sweep
  }
}

/** Note that a recording is being written here, so a crash can be cleaned up. */
export async function rememberRecordingDir(dir: string): Promise<void> {
  if (!dirsStorePath) return;
  try {
    const dirs = await readRecordingDirs();
    if (dirs.includes(dir)) return;
    dirs.push(dir);
    await fs.promises.mkdir(path.dirname(dirsStorePath), { recursive: true });
    await fs.promises.writeFile(dirsStorePath, JSON.stringify({ dirs }, null, 2), 'utf-8');
  } catch (err) {
    // Not fatal: the recording still works, we just lose the crash sweep for it.
    console.warn('[REC] could not remember the recordings folder:', (err as Error).message);
  }
}

/**
 * Delete every `.partial.flac` left behind by a recording that died (app quit,
 * power cut) in every directory we have ever recorded into. Called once when the
 * server starts, at which point no recording can be live, so anything matching is
 * by definition debris. Directories that no longer exist are skipped, not an
 * error — the user moved a folder, which is their business.
 *
 * Returns the paths removed, so the caller can say so rather than doing it
 * silently.
 */
export async function sweepPartialRecordings(): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of await readRecordingDirs()) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      continue; // gone, or unreadable — nothing to do about either
    }
    for (const name of entries) {
      if (!isPartialFileName(name)) continue;
      const file = path.join(dir, name);
      try {
        await fs.promises.rm(file, { force: true });
        removed.push(file);
      } catch (err) {
        console.warn(`[REC] could not sweep ${file}:`, (err as Error).message);
      }
    }
  }
  return removed;
}

// ─── The encoder ──────────────────────────────────────────────────────────────

/**
 * The thing PCM is written into. Real recordings get ffmpeg; the state-machine
 * tests get a stub, which is the only reason this is an interface — the session
 * must be exercisable without a media toolchain on the box.
 */
export interface RecordingEncoder {
  /** Feed raw f32le bytes. Returns false when the pipe is backed up (advisory). */
  write(chunk: Buffer): boolean;
  /** Close the input and resolve once the encoder has exited cleanly. */
  finish(): Promise<void>;
  /** Kill it now; the output file is garbage and the caller deletes it. */
  kill(): void;
}

export interface EncoderSpec {
  sampleRate: number;
  channels: number;
  /** The `.partial.flac` the encoder writes; renamed into place on stop. */
  outputPath: string;
}

export type EncoderFactory = (spec: EncoderSpec) => Promise<RecordingEncoder>;

/**
 * ffmpeg reading raw PCM off stdin and writing FLAC.
 *
 * `-f f32le -ar <rate> -ac <ch>` is the description of what is ARRIVING — the
 * stream has no header, so ffmpeg cannot know otherwise. There is no matching
 * output `-ar`/`-ac` on purpose: nothing resamples, ever. `spec.sampleRate` is
 * already the RELABELLED rate (capture ÷ speed), which is the only place the
 * speed feature touches the pipeline: the samples are untouched and the file is
 * simply declared to run at the slower rate.
 *
 * `-sample_fmt s32 -bits_per_raw_sample 24` writes 24-bit FLAC rather than
 * ffmpeg's default 32-bit. Measured 2026-09-03 with the homebrew ffmpeg:
 * ffprobe reports sample_fmt=s32 with bits_per_raw_sample=24, which is the
 * on-wire bit depth. 32-bit FLAC is legal but young, and libsndfile/librosa in
 * some training environments refuse it — a recording nothing can open is not a
 * recording. Float32 in, 24 bits out, no dither: the tab's decoded PCM does not
 * carry more than 24 bits of real information.
 */
export const spawnFfmpegEncoder: EncoderFactory = async (spec) => {
  // Lazy so this module stays requirable outside Electron (tool-paths imports
  // `app`). Everything else here is node-only by design.
  const { getFfmpegPath } = await import('./tool-paths.js');
  const ffmpeg = getFfmpegPath();

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'f32le',
    '-ar', String(spec.sampleRate),
    '-ac', String(spec.channels),
    '-i', 'pipe:0',
    '-c:a', 'flac',
    '-sample_fmt', 's32',
    '-bits_per_raw_sample', '24',
    spec.outputPath,
  ];

  const child: ChildProcess = spawn(ffmpeg, args, {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

  // A spawn failure (ffmpeg missing) arrives asynchronously as 'error', so a
  // caller that only awaited the factory would think it had an encoder. Latch it
  // and let write/finish report it by name.
  let spawnError: Error | null = null;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      spawnError =
        e.code === 'ENOENT'
          ? new Error(`ffmpeg not found at ${ffmpeg} — set it in BookForge's tool paths`)
          : new Error(`ffmpeg failed to start (${ffmpeg}): ${e.message}`);
      reject(spawnError);
    });
    child.once('close', (code, signal) => {
      exited = { code, signal };
      if (code === 0) resolve();
      else {
        const tail = stderrTail.trim().split('\n').slice(-8).join('\n');
        reject(
          new Error(
            `ffmpeg exited ${code ?? signal} while encoding the recording` +
              (tail ? `:\n${tail}` : '')
          )
        );
      }
    });
  });
  // Nobody may await `ended` until finish() does; without this an early failure
  // is an unhandled rejection that takes the main process down.
  ended.catch(() => { /* reported through finish() */ });

  // The pipe closing under us (ffmpeg died) would otherwise raise EPIPE on the
  // next write and crash main. The exit itself is the real report.
  child.stdin?.on('error', () => { /* surfaced by the close handler above */ });

  return {
    write(chunk: Buffer): boolean {
      if (spawnError) throw spawnError;
      if (exited) throw new Error('ffmpeg is no longer running — the recording ended early');
      return child.stdin?.write(chunk) ?? false;
    },
    async finish(): Promise<void> {
      if (spawnError) throw spawnError;
      child.stdin?.end();
      await ended;
    },
    kill(): void {
      try { child.stdin?.destroy(); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    },
  };
};

// ─── One recording ────────────────────────────────────────────────────────────

export interface TabRecordingRequest {
  recordId: string;
  title: string;
  /** what the TAB delivers — the capture rate, before any relabelling */
  sampleRate: number;
  channels: number;
  /** the rate the page's player was driven at (1 = normal). The file is written
   *  at sampleRate / speed; see relabelledSampleRate. */
  speed?: number;
  sourceUrl?: string | null;
  /** where to save it. May start with `~`; absolute after expansion or refused.
   *  Absent = the default (`~/Downloads`). */
  outputDir?: string | null;
}

export interface TabRecordingDeps {
  /** Defaults to the real ffmpeg spawn. */
  encoder?: EncoderFactory;
  /** Overrides the request's outputDir entirely. Tests point it at a tmpdir. */
  dir?: string;
  /** Defaults to `new Date()` — the filename stamp and the sidecar's startedAt. */
  now?: () => Date;
  /** Called ~every second with the live totals. */
  onProgress?: (progress: { recordId: string; seconds: number; bytes: number }) => void;
}

export interface TabRecordingResult {
  recordId: string;
  path: string;
  seconds: number;
  bytes: number;
}

/**
 * One capture, start to file.
 *
 * The state machine is the contract: `starting` → `recording` (the ONLY state in
 * which PCM is accepted) → `finalizing` → `done` | `cancelled` | `failed`. Every
 * refusal names itself; nothing here fails quietly, because the failure mode this
 * feature has to avoid is a user discovering after six hours that they have
 * nothing.
 */
export class TabRecordingSession {
  readonly recordId: string;
  readonly title: string;
  /** what the tab delivered */
  readonly captureSampleRate: number;
  /** the rate the player ran at while capturing (1 = normal) */
  readonly speed: number;
  /** what the FILE is labelled with: captureSampleRate / speed. Every duration
   *  in this class is computed from THIS, so `seconds` is book time. */
  readonly sampleRate: number;
  readonly channels: number;
  readonly sourceUrl: string | null;
  readonly startedAt: Date;

  /** Final destination, decided up front so `record.started` can report it. */
  readonly finalPath: string;
  /** Where it lives until stop — same directory, so the rename never crosses a
   *  volume boundary (rename(2) answers EXDEV when it does). */
  readonly partialPath: string;

  private state: RecordingState = 'starting';
  private bytes = 0;
  private marks: RecordingMark[] = [];
  private encoder: RecordingEncoder | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private readonly deps: TabRecordingDeps;

  constructor(request: TabRecordingRequest, deps: TabRecordingDeps = {}) {
    if (!request.recordId) throw new Error('record.start requires a recordId');
    if (!Number.isFinite(request.sampleRate) || request.sampleRate < 8000 || request.sampleRate > 384000) {
      throw new Error(`record.start: implausible sampleRate ${request.sampleRate}`);
    }
    if (!Number.isInteger(request.channels) || request.channels < 1 || request.channels > 8) {
      throw new Error(`record.start: implausible channel count ${request.channels}`);
    }
    const speed = request.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 1 || speed > 8) {
      throw new Error(`record.start: implausible speed ${request.speed}`);
    }
    // A speed that does not divide the capture rate into a whole number has no
    // honest file to land in. Refused here, before anything is opened, because
    // rounding it would put the whole book fractionally off pitch.
    const refusal = relabelRefusal(request.sampleRate, speed);
    if (refusal) throw new Error(refusal);

    this.deps = deps;
    this.recordId = request.recordId;
    this.title = request.title || 'tab-audio';
    this.captureSampleRate = request.sampleRate;
    this.speed = speed;
    this.sampleRate = relabelledSampleRate(request.sampleRate, speed);
    this.channels = request.channels;
    this.sourceUrl = request.sourceUrl ?? null;
    this.startedAt = (deps.now ?? (() => new Date()))();

    const dir = deps.dir ?? resolveRecordingDir(request.outputDir);
    const name = recordingFileName(this.title, this.startedAt);
    this.finalPath = path.join(dir, name);
    this.partialPath = path.join(dir, partialFileName(name));
  }

  /** The folder this recording is being written into. */
  get outputDir(): string {
    return path.dirname(this.finalPath);
  }

  getState(): RecordingState {
    return this.state;
  }

  getBytes(): number {
    return this.bytes;
  }

  /** BOOK seconds: the duration the finished file will have at 1x. Wall-clock
   *  time spent capturing is this divided by `speed`. */
  getSeconds(): number {
    return secondsFromBytes(this.bytes, this.sampleRate, this.channels);
  }

  /** Wall-clock seconds actually spent capturing. */
  getWallSeconds(): number {
    return secondsFromBytes(this.bytes, this.captureSampleRate, this.channels);
  }

  /** Create the directories and the encoder. Throws — by name — if either fails;
   *  the caller has not yet told the client the recording started. */
  async start(): Promise<void> {
    if (this.state !== 'starting') {
      throw new Error(`record.start: session ${this.recordId} is already ${this.state}`);
    }
    await ensureRecordingDir(this.outputDir);
    // Remembered before the first byte, so a crash one second later is still
    // sweepable. Best-effort by design — it must never fail a recording.
    await rememberRecordingDir(this.outputDir);
    const factory = this.deps.encoder ?? spawnFfmpegEncoder;
    this.encoder = await factory({
      sampleRate: this.sampleRate,
      channels: this.channels,
      outputPath: this.partialPath,
    });
    this.state = 'recording';
    if (this.deps.onProgress) {
      this.progressTimer = setInterval(() => {
        this.deps.onProgress!({
          recordId: this.recordId,
          seconds: this.getSeconds(),
          bytes: this.bytes,
        });
      }, RECORDER.PROGRESS_INTERVAL_MS);
      // A recording can outlive nothing here, but the app should still be able to
      // quit while one is live rather than being pinned by a timer.
      this.progressTimer.unref?.();
    }
  }

  /** Accept one binary frame. Legal ONLY while recording — a frame arriving
   *  outside that is the client's bug and is reported, never absorbed. */
  write(chunk: Buffer): void {
    if (this.state !== 'recording') {
      throw new Error(`binary frame for recording ${this.recordId} arrived while ${this.state}`);
    }
    if (!this.encoder) throw new Error(`recording ${this.recordId} has no encoder`);
    this.encoder.write(chunk);
    this.bytes += chunk.byteLength;
  }

  /** A label at a position, for the sidecar. No reply, by contract. */
  mark(label: string, seconds: number): void {
    if (isTerminalRecordingState(this.state)) return;
    if (!label) return;
    this.marks.push({ label, seconds: Number.isFinite(seconds) ? seconds : this.getSeconds() });
  }

  /**
   * Flush, close the encoder, rename the partial onto the final name and write
   * the sidecar. Called by `record.stop` AND by the client's socket closing — the
   * file is complete up to the last frame either way, which is the entire reason
   * a dropped socket is not a lost recording.
   */
  async stop(): Promise<TabRecordingResult> {
    if (this.state === 'done') {
      return { recordId: this.recordId, path: this.finalPath, seconds: this.getSeconds(), bytes: this.bytes };
    }
    if (this.state !== 'recording') {
      throw new Error(`record.stop: recording ${this.recordId} is ${this.state}, not recording`);
    }
    this.state = 'finalizing';
    this.clearTimer();
    try {
      await this.encoder!.finish();
      // Same directory, so this is a same-volume rename and cannot answer EXDEV.
      await fs.promises.rename(this.partialPath, this.finalPath);
      await this.writeSidecar();
    } catch (err) {
      this.state = 'failed';
      await this.removePartial();
      throw new Error(`recording ${this.recordId} failed to finalize: ${(err as Error).message}`);
    }
    this.state = 'done';
    return {
      recordId: this.recordId,
      path: this.finalPath,
      seconds: this.getSeconds(),
      bytes: this.bytes,
    };
  }

  /** Throw the recording away: kill the encoder, delete the partial, keep nothing. */
  async cancel(): Promise<void> {
    if (isTerminalRecordingState(this.state)) return;
    this.state = 'cancelled';
    this.clearTimer();
    try { this.encoder?.kill(); } catch { /* already dead */ }
    await this.removePartial();
  }

  private clearTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private async removePartial(): Promise<void> {
    try {
      await fs.promises.rm(this.partialPath, { force: true });
    } catch (err) {
      console.warn(`[REC] could not remove ${this.partialPath}:`, (err as Error).message);
    }
  }

  /** The sidecar is written AFTER the rename, so a `.json` beside a `.flac`
   *  always describes a file that exists. */
  private async writeSidecar(): Promise<void> {
    const sidecar: RecordingSidecar = {
      title: this.title,
      sourceUrl: this.sourceUrl,
      sampleRate: this.sampleRate,
      captureSampleRate: this.captureSampleRate,
      speed: this.speed,
      channels: this.channels,
      startedAt: this.startedAt.toISOString(),
      seconds: this.getSeconds(),
      marks: this.marks,
    };
    const target = path.join(path.dirname(this.finalPath), sidecarFileName(path.basename(this.finalPath)));
    const temp = `${target}.tmp-${process.pid}`;
    await fs.promises.writeFile(temp, JSON.stringify(sidecar, null, 2), 'utf-8');
    await fs.promises.rename(temp, target);
  }
}

// ─── One recording per server ─────────────────────────────────────────────────

/**
 * The single-recording rule, in one place. ffmpeg would happily run twice, but
 * two tab captures competing for the same socket and the same disk is not a
 * feature anyone asked for, and refusing by name beats discovering later that
 * half the book went to the other file.
 */
export class TabRecorder {
  private session: TabRecordingSession | null = null;

  /** The live recording, if any. */
  get active(): TabRecordingSession | null {
    return this.session;
  }

  isRecording(): boolean {
    return this.session !== null;
  }

  /** Refusal text for a second start — the exact wording the popup surfaces. */
  busyMessage(): string {
    const live = this.session;
    return live
      ? `Another recording is in progress (${path.basename(live.finalPath)})`
      : 'Another recording is in progress';
  }

  async start(request: TabRecordingRequest, deps?: TabRecordingDeps): Promise<TabRecordingSession> {
    if (this.session) throw new Error(this.busyMessage());
    const session = new TabRecordingSession(request, deps);
    this.session = session;
    try {
      await session.start();
    } catch (err) {
      // A recording that never started must not hold the slot.
      this.session = null;
      await session.cancel();
      throw err;
    }
    return session;
  }

  /** Frames arrive with no id of their own — they belong to the live recording. */
  write(chunk: Buffer): void {
    if (!this.session) throw new Error('binary frame arrived with no recording in progress');
    this.session.write(chunk);
  }

  async stop(recordId: string): Promise<TabRecordingResult> {
    const session = this.require(recordId);
    try {
      return await session.stop();
    } finally {
      if (this.session === session) this.session = null;
    }
  }

  async cancel(recordId: string): Promise<void> {
    const session = this.require(recordId);
    try {
      await session.cancel();
    } finally {
      if (this.session === session) this.session = null;
    }
  }

  mark(recordId: string, label: string, seconds: number): void {
    this.require(recordId).mark(label, seconds);
  }

  /** Finalize whatever is live because its client vanished. Never throws — there
   *  is nobody left to tell. */
  async finalizeOrphan(reason: string): Promise<TabRecordingResult | null> {
    const session = this.session;
    if (!session) return null;
    this.session = null;
    try {
      const result = await session.stop();
      console.log(`[REC] ${reason}: finalized ${result.path} (${result.seconds.toFixed(1)}s)`);
      return result;
    } catch (err) {
      console.error(`[REC] ${reason}: could not finalize recording:`, (err as Error).message);
      return null;
    }
  }

  private require(recordId: string): TabRecordingSession {
    const session = this.session;
    if (!session) throw new Error(`no recording is in progress (asked about '${recordId}')`);
    if (session.recordId !== recordId) {
      throw new Error(
        `recordId '${recordId}' does not name the live recording ('${session.recordId}')`
      );
    }
    return session;
  }
}

/** The server's one recorder. */
export const tabRecorder = new TabRecorder();
