/**
 * pcm16-wav.ts — THE RIFF header for mono 16-bit PCM, and the only place one is
 * built.
 *
 * Every engine on the Listen path hands back PCM16 samples and the rate it
 * produced them at (`AudioChunk` / `StreamChunk` in ./streaming-contract.ts);
 * the crucible session says so in as many words — the row layer "hands over the
 * samples and leaves the encoding to whoever is listening". Two surfaces are
 * that listener and both have to turn the samples into something a decoder can
 * read: the reader's per-block HTTP route (./reader-audio-store.ts) and the
 * whole-book render's per-sentence files (./book-render-service.ts).
 *
 * Until 2026-09-18 only the first of them built a header. The render wrote the
 * raw Int16 bytes into `render/sentences/<i>.wav`, where the extension was the
 * only thing claiming they were a WAV: the reader's route served them as
 * `audio/wav` and ffmpeg's concat demuxer was handed a file with no container
 * to probe. So the header has ONE owner, and the copy that used to sit in the
 * audio store calls it too.
 *
 * Mono and 16-bit are the engines' own output and are stated as constants here.
 * The RATE never is: it is the one field that cannot be inferred from the bytes
 * and the one whose being wrong is inaudible as an error and audible as pitch,
 * so every function takes it and refuses a missing one by name rather than
 * reaching for a default.
 */

/** A canonical RIFF/WAVE header — 'RIFF', 'fmt ' and 'data' and nothing else. */
export const WAV_HEADER_BYTES = 44;

const BYTES_PER_SAMPLE = 2;   // 16-bit
const CHANNELS = 1;           // mono

function assertSampleRate(sampleRate: number): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(
      `[pcm16-wav] cannot build a WAV header: the sample rate is ${String(sampleRate)}. `
      + 'The rate is the engine\'s own fact about the samples it produced and there is nothing '
      + 'to fall back to — a header that states the wrong rate plays at the wrong pitch and '
      + 'reports no error anywhere.');
  }
}

/** The 44-byte header for `dataBytes` of mono PCM16 sampled at `sampleRate`. */
export function pcm16WavHeader(dataBytes: number, sampleRate: number): Buffer {
  assertSampleRate(sampleRate);
  if (!Number.isInteger(dataBytes) || dataBytes < 0) {
    throw new Error(`[pcm16-wav] cannot build a WAV header for ${String(dataBytes)} bytes of audio.`);
  }
  const byteRate = sampleRate * CHANNELS * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                            // fmt chunk size
  header.writeUInt16LE(1, 20);                             // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);   // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);          // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** One playable WAV: the header for these samples, then the samples. */
export function pcm16Wav(pcm: Buffer, sampleRate: number): Buffer {
  return Buffer.concat([pcm16WavHeader(pcm.length, sampleRate), pcm], WAV_HEADER_BYTES + pcm.length);
}

/**
 * How long a WAV this module wrote plays for, read from ITS OWN fields — the
 * byte rate the header states, not a rate the caller remembers. A buffer whose
 * declared data size disagrees with the bytes present is a truncated write, and
 * that is surfaced rather than rounded away: the duration it would produce goes
 * into the audiobook's VTT and its chapter marks, where being wrong is silent.
 */
export function pcm16WavSeconds(wav: Buffer): number {
  if (wav.length < WAV_HEADER_BYTES
    || wav.toString('ascii', 0, 4) !== 'RIFF'
    || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.toString('ascii', 36, 40) !== 'data') {
    throw new Error(
      '[pcm16-wav] cannot measure this buffer: it is not a canonical RIFF/WAVE file with a '
      + '44-byte header. Raw PCM has no header to read and no rate of its own.');
  }
  const byteRate = wav.readUInt32LE(28);
  if (byteRate <= 0) throw new Error('[pcm16-wav] the WAV header states a byte rate of 0.');
  const dataBytes = wav.readUInt32LE(40);
  if (dataBytes !== wav.length - WAV_HEADER_BYTES) {
    throw new Error(
      `[pcm16-wav] the WAV header declares ${dataBytes} bytes of audio and the buffer holds `
      + `${wav.length - WAV_HEADER_BYTES} — the file was truncated as it was written.`);
  }
  return dataBytes / byteRate;
}
