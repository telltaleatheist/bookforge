/**
 * Live TTS — WAV assembly helpers.
 *
 * The streaming engine emits base64 PCM16 (mono) chunks, one sequence per
 * sentence (see AudioPlayerService.decodePcm16 for the mirror decode used for
 * playback). Nothing in the streaming path produces a WAV file, so Live TTS
 * captures the raw Int16 samples in sentence order and encodes a downloadable
 * WAV here.
 */

import { PlaySettings } from '../audiobook/models/play.types';

/** One rendered take kept in the session take list. */
export interface LiveTake {
  id: string;
  /** Short label (timestamp + voice) for the list row. */
  label: string;
  /** The source text this take was rendered from. */
  text: string;
  /** Encoded WAV bytes (RIFF header + PCM16 mono). */
  wavBytes: Uint8Array;
  sampleRate: number;
  durationSec: number;
  /** Snapshot of the engine/voice/settings used, for A/B comparison. */
  engine: 'xtts' | 'orpheus';
  settings: PlaySettings;
  createdAt: number;
}

/** Decode a base64 PCM16 chunk into raw Int16 samples (mono). */
export function decodePcm16Base64(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // A base64 chunk may be an odd byte length only if truncated; floor to whole samples.
  const sampleCount = Math.floor(bytes.length / 2);
  return new Int16Array(bytes.buffer, 0, sampleCount);
}

/** Concatenate ordered Int16 chunks into a single buffer. */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Encode mono Int16 PCM samples as a 16-bit PCM WAV (44-byte RIFF header).
 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF chunk descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // ChunkSize
  writeString(8, 'WAVE');
  // fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);           // Subchunk1Size (PCM)
  view.setUint16(20, 1, true);            // AudioFormat = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // BitsPerSample
  // data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Sample data (little-endian Int16)
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }

  return new Uint8Array(buffer);
}

/** Base64-encode raw bytes (for handing WAV bytes to the save-dialog IPC). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
