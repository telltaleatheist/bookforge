/**
 * Tab Recorder — the pure half.
 *
 * Everything here is platform-neutral arithmetic and state: it is imported by the
 * browser extension (esbuild bundles it into the offscreen document and the
 * AudioWorklet processor) AND by the Electron server (which needs the same
 * filename rule and the same bytes→seconds arithmetic). One copy, so the two ends
 * of the socket cannot drift apart about how long a recording is or what the file
 * is called.
 *
 * Contract: docs/TAB_RECORDER.md. Tests: `npm run test:tab-recorder`.
 *
 * No DOM, no Node — do not import anything here.
 */

/**
 * Every tunable the recorder has, in ONE place (the contract requires it: the
 * silence thresholds decide whether a book is captured or discarded, and two
 * copies of them is two different recorders).
 */
export const RECORDER = {
  /** PCM leaves the browser as raw float32 — 4 bytes per sample, per channel. */
  BYTES_PER_SAMPLE: 4,

  /** Target size of one binary frame, in milliseconds of audio. */
  CHUNK_MS: 100,

  /** How often the server reports {seconds, bytes} back to the client. */
  PROGRESS_INTERVAL_MS: 1000,

  /**
   * What counts as silence. Loose on purpose (1e-4, not digital zero): this is
   * judging "nothing is playing", and a stopped player, a muted tab and a dead
   * pipe can all still emit a dither-level floor.
   */
  SILENCE_PEAK: 1e-4,

  /**
   * Consecutive silence that ends a recording. It applies UNIFORMLY — from the
   * very first frame, not only after audio has been heard — so a Record pressed
   * and forgotten does not sit there writing zeroes, and a finished book stops
   * itself the same way. The recording is FINALIZED, never discarded: whatever
   * was captured is kept.
   *
   * 30 s, measured against the thing it must not cut: a chapter gap in a real
   * audiobook is 2-4 s, so this is an order of magnitude of headroom over the
   * legitimate case while still ending promptly when the audio does. It is also
   * the whole budget a user has to press play after pressing Record — which is
   * why the popup shows the countdown rather than waiting silently.
   */
  SILENCE_STOP_SECONDS: 30,

  /**
   * The lowest sample rate a recording may be written at. Speed capture buys
   * hours by relabelling the file's rate (see relabelledSampleRate), and that
   * divides the audio's bandwidth by the same number: a 48 kHz capture at 3x is
   * a 16 kHz file, which throws away everything above 8 kHz. 24 kHz is the floor
   * every training pipeline here assumes, so it is the floor a capture may not
   * cross.
   */
  TRAINING_FLOOR_HZ: 24000,
} as const;

/**
 * The speeds the recorder offers. Chrome mutes media above 4x, so 4 is the end
 * of the road, not an arbitrary cap — and which of these is actually usable
 * depends on the capture rate (see speedGuardRefusal).
 */
export const RECORD_SPEEDS = [1, 1.5, 2, 3, 4] as const;
export type RecordSpeed = (typeof RECORD_SPEEDS)[number];

// ─── Arithmetic ───────────────────────────────────────────────────────────────

/** Bytes one second of this stream occupies as raw f32le PCM. */
export function bytesPerSecond(sampleRate: number, channels: number): number {
  return sampleRate * channels * RECORDER.BYTES_PER_SAMPLE;
}

/** How much audio a byte count represents. The server has no other clock — it
 *  never decodes what it is piping — so this IS the recording's duration. */
export function secondsFromBytes(bytes: number, sampleRate: number, channels: number): number {
  const rate = bytesPerSecond(sampleRate, channels);
  if (rate <= 0) return 0;
  return bytes / rate;
}

/** Samples-per-channel in one ~CHUNK_MS frame at this rate. */
export function chunkFrameSize(sampleRate: number, chunkMs: number = RECORDER.CHUNK_MS): number {
  return Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
}

/** Largest absolute sample in an interleaved frame — what the silence gates judge. */
export function framePeak(frame: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] < 0 ? -frame[i] : frame[i];
    if (v > peak) peak = v;
  }
  return peak;
}

/** Root-mean-square of an interleaved frame — what the level meter draws. */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** h:mm:ss for the popup's elapsed readout. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}`;
}

/** Human size for the popup ("412 MB"). Recordings are hours long, so this only
 *  ever needs to be readable, never precise. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── Chunk framing ────────────────────────────────────────────────────────────

/**
 * Turns the AudioWorklet's per-channel render quanta (128 frames at a time, one
 * Float32Array per channel) into fixed-size INTERLEAVED frames — exactly the
 * f32le layout ffmpeg is told to expect on stdin.
 *
 * Fixed size matters because it is the only thing keeping the socket honest: a
 * frame is emitted when it is full, not when a quantum ends, so a quantum that
 * straddles a frame boundary splits and the second half opens the next frame.
 * Nothing is dropped and nothing is duplicated, which is the whole job.
 */
export class InterleavedFramer {
  private readonly buf: Float32Array;
  /** frames (per-channel samples) currently held */
  private filled = 0;

  constructor(readonly channels: number, readonly frameSize: number) {
    if (!Number.isInteger(channels) || channels < 1) {
      throw new Error(`InterleavedFramer: channels must be a positive integer, got ${channels}`);
    }
    if (!Number.isInteger(frameSize) || frameSize < 1) {
      throw new Error(`InterleavedFramer: frameSize must be a positive integer, got ${frameSize}`);
    }
    this.buf = new Float32Array(channels * frameSize);
  }

  /** Samples-per-channel held back waiting for the frame to fill. */
  get pending(): number {
    return this.filled;
  }

  /**
   * Append one render quantum. `channelData[c]` is channel c's samples; every
   * channel must be present, because a missing one would silently shift the
   * interleave and put the left channel's audio in the right channel forever.
   */
  push(channelData: Float32Array[]): Float32Array[] {
    if (channelData.length !== this.channels) {
      throw new Error(
        `InterleavedFramer: expected ${this.channels} channels, got ${channelData.length}`
      );
    }
    const out: Float32Array[] = [];
    const n = channelData[0].length;
    let read = 0;
    while (read < n) {
      const take = Math.min(this.frameSize - this.filled, n - read);
      for (let c = 0; c < this.channels; c++) {
        const src = channelData[c];
        for (let k = 0; k < take; k++) {
          this.buf[(this.filled + k) * this.channels + c] = src[read + k];
        }
      }
      this.filled += take;
      read += take;
      if (this.filled === this.frameSize) {
        out.push(this.buf.slice());
        this.filled = 0;
      }
    }
    return out;
  }

  /** The partial frame left at the end of a recording — audio, so it ships. */
  flush(): Float32Array | null {
    if (this.filled === 0) return null;
    const out = this.buf.slice(0, this.filled * this.channels);
    this.filled = 0;
    return out;
  }
}

// ─── The silence gates ────────────────────────────────────────────────────────

/** The only thing the watch decides. `null` = carry on. */
export type SilenceVerdict = null | 'silence-stop';

/**
 * The recorder's ear: one pure state machine fed a peak per chunk.
 *
 * ONE rule, applied uniformly from the first frame — SILENCE_STOP_SECONDS of
 * consecutive silence stops the recording and keeps the file. It does not care
 * whether the silence is at the front (Record pressed before Play) or at the end
 * (the book finished); both mean the same thing, and both should stop.
 *
 * `waiting` is presentation only, not a different rule: it says no audio has been
 * heard YET, so the popup can say what it is waiting for instead of showing a
 * level meter that will never move. `secondsUntilStop` is the countdown behind
 * that message — the user's budget for pressing play, made visible rather than
 * sprung on them.
 */
export class SilenceWatch {
  /** any non-silent frame has arrived at all */
  private heard = false;
  /** the CURRENT run of consecutive silence */
  private silent = 0;
  private fired = false;

  /** No audio has arrived yet: the tab is not playing, or is not audible to us. */
  get waiting(): boolean {
    return !this.heard;
  }

  /** Seconds of consecutive silence right now (0 while audio is flowing). */
  get silentSeconds(): number {
    return this.silent;
  }

  /** Seconds of silence left before the recording stops itself. */
  get secondsUntilStop(): number {
    return Math.max(0, RECORDER.SILENCE_STOP_SECONDS - this.silent);
  }

  /** @param seconds how much audio this chunk represents */
  feed(peak: number, seconds: number): SilenceVerdict {
    if (this.fired) return null;
    if (peak >= RECORDER.SILENCE_PEAK) {
      this.heard = true;
      this.silent = 0;
      return null;
    }
    this.silent += seconds;
    if (this.silent >= RECORDER.SILENCE_STOP_SECONDS) {
      this.fired = true;
      return 'silence-stop';
    }
    return null;
  }
}

/** What the popup says while no audio has arrived. One place — docs quote it. */
export const WAITING_FOR_AUDIO_MESSAGE = 'Waiting for audio — press play in the tab';

/** Why a recording stopped itself. Named, so the popup and the docs agree. */
export function silenceStopReason(): string {
  return `Stopped after ${RECORDER.SILENCE_STOP_SECONDS} seconds of silence`;
}

// ─── Speed capture ────────────────────────────────────────────────────────────
//
// The player is driven at S× with `preservesPitch = false`, so the tab emits the
// whole book in 1/S of the time, pitch-shifted up. NOTHING RESAMPLES: the samples
// that arrive are written verbatim and the FILE is simply labelled with a sample
// rate of captureRate / S. Played back at 1×, that file is the book at its
// original pitch and its original duration.
//
// The cost is bandwidth, and it is exact: the file's Nyquist is (captureRate/S)/2.
//
//   capture    1x        1.5x      2x        3x        4x
//   44.1 kHz   44.1 kHz  29.4 kHz  22.05 ✗   14.7 ✗    11.03 ✗
//   48 kHz     48 kHz    32 kHz    24 kHz    16 ✗      12 ✗
//   96 kHz     96 kHz    64 kHz    48 kHz    32 kHz    24 kHz
//
// ✗ = below TRAINING_FLOOR_HZ and refused by name. On a Mac the capture rate is
// the output device's rate — Audio MIDI Setup is where 96 kHz is turned on.

/** The rate the FILE is written at: capture rate divided by the speed. */
export function relabelledSampleRate(captureSampleRate: number, speed: number): number {
  return captureSampleRate / speed;
}

/**
 * Why this speed cannot be used with this capture rate, or null if it can.
 * Client-side: the refusal happens before a single frame is sent, because the
 * alternative is discovering after six hours that the file is 16 kHz.
 */
export function speedGuardRefusal(captureSampleRate: number, speed: number): string | null {
  if (!(speed >= 1)) return `Playback speed must be at least 1x, got ${speed}x`;
  const kept = relabelledSampleRate(captureSampleRate, speed);
  if (kept < RECORDER.TRAINING_FLOOR_HZ) {
    return (
      `At ${speed}x a ${captureSampleRate} Hz capture keeps only ${Math.round(kept)} Hz of audio — ` +
      `below the ${RECORDER.TRAINING_FLOOR_HZ / 1000} kHz training floor. ` +
      `Set the Mac's output device to 96 kHz in Audio MIDI Setup, or pick a lower speed.`
    );
  }
  return null;
}

/**
 * Why the relabelled rate cannot be written, or null if it can. A sample rate is
 * an integer in every container; a speed that does not divide the capture rate
 * evenly has no honest file to land in, and rounding it would put the book
 * fractionally off pitch forever.
 */
export function relabelRefusal(captureSampleRate: number, speed: number): string | null {
  const kept = relabelledSampleRate(captureSampleRate, speed);
  if (!Number.isFinite(kept) || !Number.isInteger(kept)) {
    return (
      `${speed}x does not divide a ${captureSampleRate} Hz capture into a whole sample rate ` +
      `(${kept} Hz) — pick a speed that does.`
    );
  }
  return null;
}

/** The capture rate a speed needs in order to clear the training floor. */
export function minimumCaptureRateFor(speed: number): number {
  return RECORDER.TRAINING_FLOOR_HZ * speed;
}

// ─── Naming the file ──────────────────────────────────────────────────────────

/** Control characters, as a class no filesystem accepts in a name. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * A page title is arbitrary user-facing text; a filename is not. Strip what no
 * filesystem will take (and what Windows in particular refuses: the reserved
 * device names, trailing dots and spaces), collapse whitespace, and cap the
 * length so title + timestamp + extension stays well inside every path limit.
 *
 * Never returns '' — an untitled tab still has to land somewhere findable.
 */
export function safeRecordingTitle(title: string): string {
  let s = (title || '')
    .replace(CONTROL_CHARS, ' ')
    // Path separators and the characters Windows forbids outright.
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Windows refuses trailing dots and spaces on any path component.
  s = s.replace(/[. ]+$/, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/, '');
  // Reserved device names.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `${s}_`;
  return s || 'tab-audio';
}

/** Local-time YYYYMMDD-HHMMSS — the stamp that makes two recordings of the same
 *  page two files instead of one overwrite. */
export function recordingStamp(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}

/** `<safe title>-<YYYYMMDD-HHMMSS>.flac` — the contract's filename, verbatim. */
export function recordingFileName(title: string, when: Date): string {
  return `${safeRecordingTitle(title)}-${recordingStamp(when)}.flac`;
}

/** The sidecar sits beside the audio and shares its stem. */
export function sidecarFileName(flacFileName: string): string {
  return flacFileName.replace(/\.flac$/i, '') + '.json';
}

// ─── Where the file goes ──────────────────────────────────────────────────────

/**
 * Where recordings land unless the user says otherwise. Downloads, not a folder
 * of ours: a recording is a file the user made and wants to find, not app state.
 * `~` is expanded by the SERVER (the extension has no filesystem), which is also
 * what makes it correct on Windows — `C:\Users\<name>\Downloads`.
 */
export const DEFAULT_RECORDINGS_DIR = '~/Downloads';

/**
 * Expand a leading `~` against a home directory. Pure, so it is the same rule on
 * both platforms and can be tested without a filesystem.
 *
 * Only a LEADING `~` is special, and only when it is the whole path or is
 * followed by a separator — `~foo` is a directory literally called that on some
 * systems, and guessing at another user's home directory is not this function's
 * business.
 */
export function expandHome(input: string, home: string): string {
  const p = (input || '').trim();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return home + p.slice(1);
  }
  return p;
}

/**
 * The name a recording is written under while it is still being written.
 *
 * A dotfile AND a `.partial.flac` suffix, both deliberate: it is hidden from a
 * casual look at the folder, and nothing that scans for finished recordings can
 * mistake it for one. It sits in the SAME directory as the final file so the
 * finishing rename is a same-volume rename — a staging directory elsewhere would
 * throw EXDEV the moment someone chose an output folder on another disk.
 */
export function partialFileName(flacFileName: string): string {
  return `.${flacFileName.replace(/\.flac$/i, '')}.partial.flac`;
}

/** True for a name written by {@link partialFileName} — what the sweep removes. */
export function isPartialFileName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.partial.flac');
}

/** A mark dropped on a recording. v1 sends none; `record.mark` exists so a later
 *  chapter-title observer has somewhere to write. */
export interface RecordingMark {
  label: string;
  seconds: number;
}

/** The sidecar's shape — written by the server, read by whatever consumes the
 *  recordings later. */
export interface RecordingSidecar {
  title: string;
  sourceUrl: string | null;
  /** the FILE's sample rate — capture rate ÷ speed (see relabelledSampleRate) */
  sampleRate: number;
  /** what the tab actually delivered, before the relabelling */
  captureSampleRate: number;
  /** the rate the player was driven at while capturing (1 = normal) */
  speed: number;
  channels: number;
  startedAt: string;
  /** BOOK seconds — the duration of the file at 1x, not the wall clock spent */
  seconds: number;
  marks: RecordingMark[];
}

// ─── What the two ends agree a recording IS ───────────────────────────────────

/**
 * A recording's life, as the SERVER sees it. `recording` is the only state in
 * which binary frames are legal; everything after it is terminal.
 */
export type RecordingState = 'starting' | 'recording' | 'finalizing' | 'done' | 'cancelled' | 'failed';

/** Terminal states — the session is finished and cannot be fed again. */
export function isTerminalRecordingState(state: RecordingState): boolean {
  return state === 'done' || state === 'cancelled' || state === 'failed';
}
