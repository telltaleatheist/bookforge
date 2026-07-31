/**
 * Audio duration straight from a FLAC's STREAMINFO header.
 *
 * 42 bytes and no decode: 4-byte magic, 4-byte metadata-block header, then STREAMINFO,
 * whose 20-bit sample rate and 36-bit total-sample count are all a duration needs. Cheap
 * enough to use where decoding would not be — sampling a run's output while it is still
 * being written, or totalling thousands of files across the WSL 9p mount.
 *
 * Two callers, for two different reasons:
 *  - parallel-tts-bridge samples rendered sentences to report a realtime factor, since
 *    audio produced per wall-clock is the only throughput figure comparable across books.
 *  - reassembly-bridge totals the chapter files to learn the book's length, so ffmpeg's
 *    `time=` position becomes a real percentage instead of a pinned placeholder.
 */

import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

/**
 * Seconds of audio in `file`, or null when it is not a readable FLAC right now — most
 * often a file caught mid-write. Null is a state the caller handles (skip it, try again
 * later); nothing is ever substituted for it.
 */
export async function flacDurationSeconds(file: string): Promise<number | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(42);
    const { bytesRead } = await handle.read(buf, 0, 42, 0);
    if (bytesRead < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
    const si = buf.subarray(8, 42);
    const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    // 36-bit field: the low nibble of si[13] then four whole bytes. Multiplication rather
    // than shifts — `<<` is 32-bit in JS and would silently drop the top nibble.
    const totalSamples = (si[13] & 0x0f) * 4294967296
      + si[14] * 16777216 + si[15] * 65536 + si[16] * 256 + si[17];
    if (!sampleRate || !totalSamples) return null;
    return totalSamples / sampleRate;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Total seconds across every `*.flac` directly in `dir`, or null if the directory can't
 * be read or holds no readable FLAC.
 *
 * Null rather than 0: a zero total would divide into a percentage of Infinity, and a
 * caller that cannot tell "no audio" from "couldn't measure" would publish it.
 */
export async function sumFlacDurationsSeconds(dir: string): Promise<number | null> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith('.flac'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  let total = 0;
  let measured = 0;
  for (const name of names) {
    const seconds = await flacDurationSeconds(path.join(dir, name));
    if (seconds === null) continue;
    total += seconds;
    measured++;
  }
  return measured > 0 ? total : null;
}
