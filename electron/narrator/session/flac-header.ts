/**
 * Exact FLAC facts from the 42 bytes at the front of the file: never a decode, never an
 * ffprobe. A port of `narrator/render/flac_header.py`.
 *
 * A 20-hour book is about 2,700 files. Asking ffprobe for each was 2,700 spawns; the
 * numbers are sitting in the header, one 42-byte read each, and exact.
 *
 * Every failure here says so with the path rather than returning a zero: a 0.0 does not
 * look like an error to any caller, it looks like silence.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

const STREAMINFO_LEN = 34;

export class FlacHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlacHeaderError';
  }
}

export interface StreamInfo {
  readonly path: string;
  readonly minBlocksize: number;
  readonly maxBlocksize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly samples: number;
}

async function readBlock(file: string): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FlacHeaderError(`FLAC not found: ${file}`);
    throw err;
  }
  try {
    const front = Buffer.alloc(8 + STREAMINFO_LEN);
    const { bytesRead } = await handle.read(front, 0, front.length, 0);
    const magic = front.subarray(0, Math.min(bytesRead, 4));
    if (!magic.equals(Buffer.from('fLaC', 'latin1'))) {
      throw new FlacHeaderError(`Not a FLAC file (magic is ${JSON.stringify(magic.toString('latin1'))}, expected fLaC): ${file}`);
    }
    if (bytesRead < 8) throw new FlacHeaderError(`Truncated FLAC metadata block header: ${file}`);
    const blockType = front[4] & 0x7f;
    if (blockType !== 0) {
      throw new FlacHeaderError(`First FLAC metadata block is type ${blockType}, not STREAMINFO (0): ${file}`);
    }
    const declared = front.readUIntBE(5, 3);
    if (declared !== STREAMINFO_LEN) {
      throw new FlacHeaderError(`FLAC STREAMINFO block declares ${declared} bytes, the spec fixes it at ${STREAMINFO_LEN}: ${file}`);
    }
    if (bytesRead < front.length) throw new FlacHeaderError(`Truncated FLAC STREAMINFO block: ${file}`);
    return front.subarray(8);
  } finally {
    await handle.close();
  }
}

/** Parse the block. Refuses a non-FLAC, a truncated header, a zero rate or a zero count. */
export async function readStreaminfo(file: string): Promise<StreamInfo> {
  const info = await readBlock(file);
  const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const channels = ((info[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((info[12] & 0x01) << 4) | (info[13] >> 4)) + 1;
  // 36 bits, so no shifts: JavaScript's stop at 32, and a double holds 36 exactly.
  const samples = (info[13] & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
  if (sampleRate === 0) throw new FlacHeaderError(`FLAC STREAMINFO declares sample rate 0: ${file}`);
  if (samples === 0) {
    throw new FlacHeaderError(`FLAC STREAMINFO declares total_samples 0 (unknown length) - the file is incomplete or was never finalized: ${file}`);
  }
  return {
    path: file,
    minBlocksize: info.readUInt16BE(0),
    maxBlocksize: info.readUInt16BE(2),
    sampleRate,
    channels,
    bitsPerSample,
    samples,
  };
}

/** Also refuses a file that is not the shape the session says every chunk is. */
export function checkExpected(info: StreamInfo, sampleRate: number, channels = 1): StreamInfo {
  if (info.sampleRate !== sampleRate) {
    throw new FlacHeaderError(`FLAC sample rate is ${info.sampleRate} Hz, the session renders at ${sampleRate} Hz: ${info.path}`);
  }
  if (info.channels !== channels) {
    throw new FlacHeaderError(`FLAC has ${info.channels} channel(s), the session renders ${channels}: ${info.path}`);
  }
  return info;
}

type Attribute = 'sampleRate' | 'channels' | 'maxBlocksize' | 'bitsPerSample';

/** Mismatches that change what the audio MEANS. No rewrite can reconcile them. */
const FATAL_PROPERTIES: ReadonlyArray<readonly [Attribute, string]> = [
  ['sampleRate', 'samplerate'],
  ['channels', 'channel count'],
];

/** Mismatches that break only the CONTAINER. A lossless rewrite through one encoder fixes them. */
const FIXABLE_PROPERTIES: ReadonlyArray<readonly [Attribute, string]> = [
  ['maxBlocksize', 'max-blocksize'],
  ['bitsPerSample', 'bit depth'],
];

function describeGroups(infos: readonly StreamInfo[], attribute: Attribute, label: string): string | null {
  const groups = new Map<number, string[]>();
  for (const info of infos) {
    const paths = groups.get(info[attribute]) ?? [];
    paths.push(info.path);
    groups.set(info[attribute], paths);
  }
  if (groups.size <= 1) return null;
  return [...groups.keys()].sort((a, b) => a - b).map((value) => {
    const paths = groups.get(value) as string[];
    return `${label} ${value}: ${paths.length} file(s) (e.g. ${path.basename(paths[0])})`;
  }).join('; ');
}

function refuseEmpty(infos: readonly StreamInfo[], who: string): void {
  if (infos.length === 0) throw new FlacHeaderError(`${who}(): nothing to concatenate`);
}

export function fatalInhomogeneity(infos: readonly StreamInfo[]): string | null {
  refuseEmpty(infos, 'fatalInhomogeneity');
  for (const [attribute, label] of FATAL_PROPERTIES) {
    const described = describeGroups(infos, attribute, label);
    if (described) return described;
  }
  return null;
}

/**
 * The three machines that render these books differ here (measured 2026-09-04: PCM_16 or
 * PCM_24, max-blocksize 2304 or 4096), so a book resumed on another machine has a mixed
 * set through no fault of the audio, and every sample in it is correct.
 */
export function fixableInhomogeneity(infos: readonly StreamInfo[]): string | null {
  refuseEmpty(infos, 'fixableInhomogeneity');
  const described = FIXABLE_PROPERTIES
    .map(([attribute, label]) => describeGroups(infos, attribute, label))
    .filter((one): one is string => one !== null);
  return described.length > 0 ? described.join('; ') : null;
}

/** The last-line check on what actually goes into a concat list. */
export function assertConcatHomogeneous(infos: readonly StreamInfo[]): void {
  refuseEmpty(infos, 'assertConcatHomogeneous');
  const problems: string[] = [];
  for (const [attribute, label] of [...FATAL_PROPERTIES, ...FIXABLE_PROPERTIES]) {
    const described = describeGroups(infos, attribute, label);
    if (described) {
      problems.push(`FLAC ${label} is not homogeneous - ffmpeg concat would silently drop frames or corrupt timing: ${described}`);
    }
  }
  if (problems.length > 0) throw new FlacHeaderError(problems.join('\n'));
}
