/**
 * Chunk edges for an engine that does not pad: fades, and realized gaps. A port of
 * `narrator/assemble/edges.py`.
 *
 * Higgs emits bare speech. After the codec's sentinel run is trimmed the edge still sits near
 * -30 dB, and butt-joining two of those clicks. The fade is raised-cosine rather than linear
 * because a linear ramp's corner is itself a smaller click.
 *
 *     fade-in over N samples:  w[i] = 0.5 - 0.5*cos(pi * (i+1)/(N+1))
 *     fade-out over N samples: the same window reversed
 *
 * A fade changes no length, and a gap is exactly `round(seconds * rate)` samples, so the audio
 * and the transcript's running sum agree. The session's files are read-only inputs.
 *
 * THE SAMPLES ARE THE PYTHON'S, TO THE LSB. It read through libsndfile as floats and wrote back
 * as PCM_16: both scale by 32768, so a sample outside the fade comes back unchanged, and a sample
 * inside rounds the float product half to even. {@link fadedSample} is that arithmetic, measured
 * sample by sample against the Python on real chunks. A wider source is requantized to 16 bits.
 *
 * THE FILES ARE OURS. Only PCM crosses to the encoder, so the FLACs in the work dir need only be
 * valid and homogeneous. They are written here as verbatim frames: no compression, because they
 * live on local scratch for minutes, and no spawn per file. Fixed blocksize, so the concat
 * demuxer's rule about a frame larger than the first entry's maximum can never bite.
 */

import * as fs from 'fs';
import * as path from 'path';

import { pyRoundHalfEven } from '../py-compat';
import { run, type RunOptions } from './ffmpeg-tools';

export const FLAC_BLOCKSIZE = 4096;

/** Window length in samples for a fade of `ms` milliseconds. */
export function fadeSamples(ms: number, sampleRate: number): number {
  if (ms <= 0) return 0;
  return pyRoundHalfEven((ms * sampleRate) / 1000);
}

/** The one rounding rule, so the audio and the VTT cannot disagree. */
export function gapFrames(seconds: number, sampleRate: number): number {
  return pyRoundHalfEven(seconds * sampleRate);
}

function raisedCosineIn(n: number): Float64Array {
  const window = new Float64Array(n);
  for (let i = 1; i <= n; i += 1) window[i - 1] = 0.5 - 0.5 * Math.cos((Math.PI * i) / (n + 1));
  return window;
}

/**
 * A window longer than the clip is clamped to it, and the two are clamped so they cannot
 * overlap: 35 ms of treatment on a 20 ms chunk would multiply the middle twice.
 */
export function clampWindows(frames: number, fadeInN: number, fadeOutN: number): [number, number] {
  let fadeIn = Math.max(0, Math.min(fadeInN, frames));
  let fadeOut = Math.max(0, Math.min(fadeOutN, frames));
  if (fadeIn + fadeOut > frames) {
    const share = Math.trunc((frames * fadeIn) / (fadeIn + fadeOut));
    fadeIn = share;
    fadeOut = frames - share;
  }
  return [fadeIn, fadeOut];
}

/** libsndfile's read scale, for each FLAC depth this pipeline meets. */
const READ_SCALE: Readonly<Record<number, number>> = { 16: 1 / 0x8000, 24: 1 / 0x800000 };
/** libsndfile's PCM_16 write scale, as measured: -16925 comes back -16925. */
const WRITE_SCALE_16 = 0x8000;

/** One sample through the Python's float round trip, the window applied. */
export function fadedSample(value: number, readScale: number, gain: number): number {
  const scaled = pyRoundHalfEven(value * readScale * gain * WRITE_SCALE_16);
  return scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
}

/** Fade PCM (as read at `bitsPerSample`) to PCM_16, in a new array. Every sample passes the round trip. */
export function fadePcm(source: Int32Array | Int16Array, bitsPerSample: number, fadeInN: number, fadeOutN: number): Int16Array {
  const readScale = READ_SCALE[bitsPerSample];
  if (readScale === undefined) throw new Error(`no read scale for ${bitsPerSample}-bit FLAC, which this pipeline does not render`);
  const frames = source.length;
  if (frames === 0) throw new Error('apply_edge_fades(): empty audio');
  const [fadeIn, fadeOut] = clampWindows(frames, fadeInN, fadeOutN);
  const out = new Int16Array(frames);
  const windowIn = raisedCosineIn(fadeIn);
  const windowOut = raisedCosineIn(fadeOut);
  for (let i = 0; i < frames; i += 1) {
    let gain = 1;
    if (i < fadeIn) gain *= windowIn[i];
    const fromEnd = frames - 1 - i;
    if (fromEnd < fadeOut) gain *= windowOut[fromEnd];
    out[i] = fadedSample(source[i], readScale, gain);
  }
  return out;
}

/** Decode one source FLAC to its integers. A chunk is a minute at most, so this is a small buffer. */
export async function decodeFlac(file: string, ffmpeg: string, bitsPerSample: number, options: Pick<RunOptions, 'signal'> = {}): Promise<Int16Array | Int32Array> {
  const wide = bitsPerSample > 16;
  const parts: Buffer[] = [];
  await run(
    [ffmpeg, '-hide_banner', '-nostats', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', wide ? 's32le' : 's16le', '-acodec', wide ? 'pcm_s32le' : 'pcm_s16le', '-'],
    `decode of ${path.basename(file)}`,
    { signal: options.signal, onData: (data) => parts.push(data) },
  );
  const bytes = Buffer.concat(parts);
  if (!wide) {
    const copy = new Int16Array(bytes.length >> 1);
    for (let i = 0; i < copy.length; i += 1) copy[i] = bytes.readInt16LE(i * 2);
    return copy;
  }
  // ffmpeg left-justifies a 24-bit FLAC in s32. libsndfile reads the same value at its own scale.
  const copy = new Int32Array(bytes.length >> 2);
  const shift = 32 - bitsPerSample;
  for (let i = 0; i < copy.length; i += 1) copy[i] = bytes.readInt32LE(i * 4) >> shift;
  return copy;
}

const CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    table[i] = c;
  }
  return table;
})();
const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i << 8;
    for (let j = 0; j < 8; j += 1) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    table[i] = c;
  }
  return table;
})();

function crc8(bytes: Buffer, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i += 1) crc = CRC8_TABLE[crc ^ bytes[i]];
  return crc;
}

function crc16(bytes: Buffer, end: number): number {
  let crc = 0;
  for (let i = 0; i < end; i += 1) crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[(crc >> 8) ^ bytes[i]];
  return crc;
}

/** FLAC's UTF-8-shaped frame number, for numbers well under a book's worth of frames. */
function codedNumber(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
  if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
  return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

function frameHeader(frameNumber: number, blockSamples: number): Buffer {
  const coded = codedNumber(frameNumber);
  const header = Buffer.alloc(4 + coded.length + 2 + 1);
  header[0] = 0xff;
  header[1] = 0xf8; // sync, fixed blocksize
  header[2] = 0x70; // blocksize in 16 bits at the end of the header; rate from STREAMINFO
  header[3] = 0x08; // mono, 16 bits per sample
  coded.forEach((b, i) => { header[4 + i] = b; });
  header.writeUInt16BE(blockSamples - 1, 4 + coded.length);
  header[header.length - 1] = crc8(header, header.length - 1);
  return header;
}

function streamInfoBlock(sampleRate: number, samples: number): Buffer {
  const out = Buffer.alloc(4 + 4 + 34);
  out.write('fLaC', 0, 'latin1');
  out[4] = 0x80; // last metadata block, type STREAMINFO
  out.writeUIntBE(34, 5, 3);
  out.writeUInt16BE(FLAC_BLOCKSIZE, 8);
  out.writeUInt16BE(FLAC_BLOCKSIZE, 10);
  // min/max frame size stay 0: unknown is legal. MD5 stays 0: unset is legal.
  const packed = (BigInt(sampleRate) << 44n) | (0n << 41n) | (15n << 36n) | BigInt(samples);
  out.writeBigUInt64BE(packed, 18);
  return out;
}

/** Mono PCM_16 as a FLAC of verbatim frames, or of constant frames when `pcm` is all zeros by construction. */
export async function writeFlac(file: string, sampleRate: number, frames: number, pcm: Int16Array | null): Promise<void> {
  if (frames <= 0) throw new Error(`write_flac(): ${frames} frames is nothing to write`);
  const handle = await fs.promises.open(file, 'w');
  try {
    await handle.write(streamInfoBlock(sampleRate, frames));
    let frameNumber = 0;
    for (let at = 0; at < frames; at += FLAC_BLOCKSIZE) {
      const count = Math.min(FLAC_BLOCKSIZE, frames - at);
      const header = frameHeader(frameNumber, count);
      const bodyLength = pcm === null ? 3 : 1 + count * 2;
      const frame = Buffer.alloc(header.length + bodyLength + 2);
      header.copy(frame);
      let w = header.length;
      if (pcm === null) {
        frame[w] = 0x00; // constant subframe; its one sample is already zero
        w += 3;
      } else {
        frame[w] = 0x02; // verbatim subframe
        w += 1;
        for (let i = 0; i < count; i += 1) {
          frame.writeInt16BE(pcm[at + i], w);
          w += 2;
        }
      }
      frame.writeUInt16BE(crc16(frame, w), w);
      await handle.write(frame);
      frameNumber += 1;
    }
  } finally {
    await handle.close();
  }
}

/** Read `src`, fade both edges, write `dst`. Returns the sample count, which a fade may not change. */
export async function writeFadedChunk(src: string, dst: string, sampleRate: number, bitsPerSample: number, fadeInMs: number, fadeOutMs: number, ffmpeg: string, signal?: AbortSignal): Promise<number> {
  const source = await decodeFlac(src, ffmpeg, bitsPerSample, { signal });
  const faded = fadePcm(source, bitsPerSample, fadeSamples(fadeInMs, sampleRate), fadeSamples(fadeOutMs, sampleRate));
  await writeFlac(dst, sampleRate, faded.length, faded);
  return faded.length;
}

export async function writeSilence(file: string, frames: number, sampleRate: number): Promise<number> {
  if (frames <= 0) throw new Error(`write_silence(): ${frames} frames is not a gap`);
  await writeFlac(file, sampleRate, frames, null);
  return frames;
}
