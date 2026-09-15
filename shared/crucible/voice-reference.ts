/**
 * THE ZERO-SHOT REFERENCE CLIP, CHECKED BEFORE IT IS SENT — one module, two
 * clients.
 *
 * crucible `docs/PHASE3-TTS.md` §5's amendment: a `zeroshot` voice is the base
 * weights plus somebody's recording, and the recording is the CLIENT'S. It
 * travels with `load-voice`:
 *
 * ```json
 * {"type": "load-voice", "model": "zeroshot",
 *  "params": {"reference": {"data": "<base64 RIFF/WAVE>",
 *                           "transcript": "<book-exact text of the clip>",
 *                           "name": "<label>"}}}
 * ```
 *
 * The SDK spells it `loadVoice(voice, {reference})`, and a voice's
 * `GET /v1/voices` row says whether one is wanted (`needsReference`).
 *
 * ── WHY THE CLIENT CHECKS AT ALL, AND WHERE THE LINE IS ────────────────────
 *
 * The server is the authority and refuses by name before the job is queued:
 * `reference_required`, `reference_not_allowed`, `reference_malformed`. This
 * module does NOT hold a second opinion about any of that — it checks the
 * three things whose ANSWER IS ALREADY IN THE BYTES ON THIS SIDE (is it a
 * RIFF/WAVE container, is it over 30 seconds, is it over 32 MiB) and refuses
 * with THE SERVER'S OWN CODE. Uploading 40 MB of audio across a LAN so that a
 * server can read the same header this side already has and say "too big" is a
 * defect, not a safety net; and on the Mac it is 40 MB over Tailscale.
 *
 * It is not a fallback either: nothing here repairs, resamples, truncates or
 * re-encodes. A clip over the budget is REFUSED — cut a shorter one — because
 * a client that trimmed a 40-second clip to 30 would clone from audio nobody
 * chose and report success.
 *
 * ── THE NUMBERS ARE NARRATOR'S, AND THEY ARE WRITTEN DOWN HERE ONCE ────────
 *
 * 30.0 s is `v3_served.MAX_REFERENCE_SECONDS` — above it vllm-omni answers
 * HTTP 400 "Reference audio too long". 32 MiB is Crucible's decoded ceiling,
 * checked against the ENCODED length first so a gigabyte is never decoded. Both
 * are stated in §5's refusal table; they are copied here so a client can answer
 * without a round trip, and `tools/test-zeroshot-reference.js` is what says so
 * out loud if they ever drift.
 *
 * ── THE TRANSCRIPT IS REQUIRED, AND IT IS NEVER GUESSED ────────────────────
 *
 * narrator refuses a `ReferenceClip` with a blank transcript AT CONSTRUCTION,
 * in as many words: *"a zero-shot clone conditioned on a wrong or absent
 * transcript is a whole book in a subtly wrong voice, reported as success"*. It
 * is the BOOK-EXACT text the clip was cut from and never an ASR guess — the
 * same law the training corpora are held to (memory
 * `orpheus-training-text-doctrine`). So a blank one is refused here too, and
 * nothing in either client transcribes anything.
 *
 * Platform-neutral on purpose: the extension bundles it with esbuild and the
 * app compiles it with tsc, the way `shared/listen-text/` is bundled twice.
 * No `node:` imports, no DOM, no `Buffer`.
 */

/**
 * narrator's own cap on a reference clip (`v3_served.MAX_REFERENCE_SECONDS`).
 *
 * Two ~14 s clips joined into one wav is the practical maximum, and §5 notes
 * that a same-BOOK clip is worth far more than a second one.
 */
export const REFERENCE_MAX_SECONDS = 30.0;

/** Crucible's decoded ceiling for the clip's bytes. */
export const REFERENCE_MAX_BYTES = 32 * 1024 * 1024;

/** The codes the server uses. A client refusing early uses the SAME words. */
export type VoiceReferenceRefusalCode =
  /** The voice's row says `needsReference` and no clip was picked. */
  | 'reference_required'
  /** A clip was offered for a voice whose speaker is in its weights. */
  | 'reference_not_allowed'
  /** Not a readable WAV, no transcript, over 30 s, or over 32 MiB. */
  | 'reference_malformed';

/** A clip this client will not send, named with the server's own code. */
export class VoiceReferenceRefused extends Error {
  readonly code: VoiceReferenceRefusalCode;

  constructor(code: VoiceReferenceRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VoiceReferenceRefused';
    this.code = code;
  }
}

/** What a clip's RIFF header says about it. */
export interface WavFacts {
  /** From the data chunk's size over the byte rate. Never estimated. */
  readonly seconds: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** The whole file, header included — what actually crosses the wire. */
  readonly byteLength: number;
}

const ASCII_RIFF = 0x52494646; // 'RIFF'
const ASCII_WAVE = 0x57415645; // 'WAVE'

function fourCC(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

/**
 * Read the clip's own header — the same thing the server reads.
 *
 * `reference_malformed` for anything that is not a RIFF/WAVE container with a
 * `fmt ` chunk and a `data` chunk, which is the server's word for it. The
 * duration comes from the DATA chunk over the byte rate and is never guessed
 * from the file size: a wav with a `LIST` chunk after the audio would read
 * long, and reading long is how a 29-second clip gets refused by a client.
 */
export function readWavFacts(bytes: Uint8Array, where: string): WavFacts {
  if (bytes.length < 44) {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} is ${bytes.length} bytes, which is shorter than a WAV header. narrator's arms `
        + 'both want a RIFF/WAVE file.',
    );
  }
  if (fourCC(bytes, 0) !== ASCII_RIFF || fourCC(bytes, 8) !== ASCII_WAVE) {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} is not a RIFF/WAVE file (its first bytes are not "RIFF"…"WAVE"). Both of `
        + 'narrator\'s arms want a wav; an mp3, an m4a or a FLAC renamed .wav is refused here '
        + 'rather than uploaded and refused there.',
    );
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataBytes = -1;

  // RIFF chunks: 4-byte id, 4-byte size, payload, padded to even.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = fourCC(bytes, at);
    const size = u32(bytes, at + 4);
    const body = at + 8;
    if (id === 0x666d7420 /* 'fmt ' */) {
      if (body + 16 > bytes.length) {
        throw new VoiceReferenceRefused(
          'reference_malformed',
          `${where} has a truncated "fmt " chunk — the file ends inside its own header.`,
        );
      }
      channels = u16(bytes, body + 2);
      sampleRate = u32(bytes, body + 4);
      byteRate = u32(bytes, body + 8);
      bitsPerSample = u16(bytes, body + 14);
    } else if (id === 0x64617461 /* 'data' */) {
      // A `data` size that runs past the end is a truncated recording; what is
      // ACTUALLY there is the honest number, because that is what gets sent.
      dataBytes = Math.min(size, bytes.length - body);
      break;
    }
    at = body + size + (size % 2);
  }

  if (sampleRate === 0 || channels === 0 || byteRate === 0) {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} is a RIFF/WAVE file with no readable "fmt " chunk, so nothing here can say how `
        + 'long it is or what it contains.',
    );
  }
  if (dataBytes < 0) {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} is a RIFF/WAVE file with no "data" chunk — it carries no audio.`,
    );
  }

  return {
    seconds: dataBytes / byteRate,
    sampleRate,
    channels,
    bitsPerSample,
    byteLength: bytes.length,
  };
}

/**
 * Everything this side can know about a clip before it is sent, refused with
 * the server's own names.
 *
 * Order matters and is the server's: the SIZE is checked before anything is
 * parsed (a gigabyte is never walked), then the container, then the duration,
 * then the transcript.
 */
export function refuseUnusableClip(
  bytes: Uint8Array,
  transcript: string,
  where: string,
): WavFacts {
  if (bytes.length > REFERENCE_MAX_BYTES) {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} is ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB and the ceiling is `
        + `${REFERENCE_MAX_BYTES / (1024 * 1024)} MiB. A reference clip is about fifteen `
        + 'seconds of one voice; something this size is a recording, not a reference.',
    );
  }
  const facts = readWavFacts(bytes, where);
  if (facts.seconds > REFERENCE_MAX_SECONDS) {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} is ${facts.seconds.toFixed(1)} s and narrator's budget is `
        + `${REFERENCE_MAX_SECONDS} s (vllm-omni answers "Reference audio too long" above it). `
        + 'Cut a shorter clip — nothing here trims it for you, because a clone from audio '
        + 'nobody chose would be reported as success.',
    );
  }
  refuseBlankTranscript(transcript, where);
  return facts;
}

/**
 * The transcript, which narrator refuses at construction when it is blank.
 *
 * Separate from the audio checks because it is a separate act by the person:
 * the Options page wants to say "this clip has no transcript" while the file
 * is still fine.
 */
export function refuseBlankTranscript(transcript: string, where: string): void {
  if (transcript.trim() === '') {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      `${where} has no transcript. It is REQUIRED and it is the book-exact text the clip was `
        + 'cut from, never an ASR guess: a zero-shot clone conditioned on a wrong or absent '
        + 'transcript is a whole book in a subtly wrong voice, reported as success.',
    );
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The clip's bytes as the wire wants them: strict base64, **no `data:` prefix
 * and no whitespace** (§5 — a prefix or a pasted newline is a refusal, not a
 * silent skip).
 *
 * Written out rather than reached for, for the reason `@crucible/client`'s own
 * `encodeBase64` gives and which applies twice as hard here: `Buffer` is
 * Electron-only, `btoa` needs a binary string that `String.fromCharCode(...)`
 * cannot build for a megabyte without overflowing the call stack, and the SDK
 * does not export its copy from the package index. One implementation compiled
 * into the app and bundled into the extension beats two spellings of one
 * encoding that must agree byte for byte, since the server's `sha256` over the
 * decoded audio is how two clients tell their clips apart.
 */
export function encodeReferenceData(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!;
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >>> 18) & 63]!}${B64[(n >>> 12) & 63]!}==`;
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >>> 18) & 63]!}${B64[(n >>> 12) & 63]!}${B64[(n >>> 6) & 63]!}=`;
  }
  return out;
}
