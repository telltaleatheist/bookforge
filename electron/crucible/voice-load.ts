/**
 * MAKING A VOICE RESIDENT ON A CRUCIBLE — including a zero-shot one, with its
 * clip.
 *
 * crucible `docs/PHASE3-TTS.md` §5 and its 2026-09-14 amendment;
 * docs/EXTENSION-TO-CRUCIBLE-PLAN.md §4b. `load-voice` is an OPERATOR VERB
 * exactly as `load-model` is (`probe.ts`'s `loadModelOn`): it takes the lane
 * and the card on that machine, so it happens when somebody presses a button
 * and never on the way past. Nothing in this file loads implicitly, and
 * nothing unloads anything to make room.
 *
 * ── THE FOUR ZERO-SHOT VOICES, AND WHY THEY NEEDED A DOOR ──────────────────
 *
 * BookForge's catalog carries four `zeroshot-*` entries
 * (`electron/data/higgs-models.json`, `kind: "clips"`): the BASE Higgs v3
 * weights plus ONE reference clip, whose wav lives in
 * `<userData>/runtime/higgs-models/refs/` and whose BOOK-EXACT transcript is
 * in the catalog row beside its file name. Crucible names ONE voice for all
 * four — `zeroshot`, the base weights at a pinned revision — because on a
 * server the clip is not the server's: it arrives with the load.
 *
 * So the app's four ids collapse onto Crucible's one, and the thing that tells
 * them apart travels in `params.reference`. That is why `render.ts`'s
 * `CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE` deliberately does NOT map them: the
 * RENDER door has no channel for a clip and refuses the kind
 * (`voice_kind_unsupported`), so mapping them there would render the
 * same-named FINE-TUNE — a different speaker — or fail one round trip later
 * with a worse message. This is the door that does have the channel, and it is
 * the only place in BookForge where a `zeroshot-*` id becomes `zeroshot`.
 *
 * ── THE TRANSCRIPT IS ALREADY IN THE CATALOG, AND IS NEVER DERIVED ─────────
 *
 * narrator refuses a clip with a blank transcript at construction: *"a
 * zero-shot clone conditioned on a wrong or absent transcript is a whole book
 * in a subtly wrong voice, reported as success"*. BookForge has had the text
 * since 2026-09-06 — `HiggsReferenceClip.transcript`, book-exact, chosen by
 * the training session from its treated corpus — and `resolveHiggsModel`
 * already refuses an untranscribed clip before anything else happens. Nothing
 * here transcribes, guesses at, or trims anything.
 *
 * ── AND IT CHECKS BEFORE IT SENDS ──────────────────────────────────────────
 *
 * `shared/crucible/voice-reference.ts` — the same module the browser extension
 * bundles — reads the wav's own header and refuses a clip that is not
 * RIFF/WAVE, is over narrator's 30-second budget, is over the 32 MiB ceiling,
 * or has no transcript, USING THE SERVER'S OWN CODES. Sending 8 MB to the Mac
 * over Tailscale so it can read the same header and answer
 * `reference_malformed` is a defect, not a safety net. It is not a second
 * opinion either: the server still decides, and every refusal it makes is
 * passed through untouched.
 */

import * as fs from 'fs';
import type { CrucibleClient, VoiceInfo } from '@crucible/client';
import {
  VoiceReferenceRefused,
  encodeReferenceData,
  refuseUnusableClip,
} from '../../shared/crucible/voice-reference.js';
import { higgsReferenceClipPath, resolveHiggsModel } from '../higgs-models';
import { CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE } from './render';

/**
 * The ONE Crucible voice every BookForge `zeroshot-*` entry loads as.
 *
 * `crucible/voices/zeroshot.toml` names the Higgs BASE weights, and a clip
 * makes it somebody. Four app ids, one voice subject, and the reference is
 * what distinguishes them — which is why this is a constant and not a fifth
 * row in `CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE`: that table maps identities, and
 * these four do not HAVE separate identities on a server.
 */
export const CRUCIBLE_ZEROSHOT_VOICE = 'zeroshot';

/** A load this app will not submit, named. */
export class CrucibleVoiceLoadRefused extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleVoiceLoadRefused';
    this.code = code;
  }
}

/** What crosses the wire beside the voice id. */
export interface CrucibleVoiceReference {
  /** Base64 of the wav, no `data:` prefix and no whitespace. */
  readonly data: string;
  /** The clip's BOOK-EXACT text, from the catalog. Never an ASR guess. */
  readonly transcript: string;
  /** The catalog's own label for the clip, for the resident report. */
  readonly name: string;
}

/** A BookForge voice, resolved into what `loadVoice` actually takes. */
export interface CrucibleVoiceLoad {
  /** The Crucible voice id. */
  readonly voice: string;
  /** The clip, for a zero-shot voice; null for every other kind. */
  readonly reference: CrucibleVoiceReference | null;
}

/** Is this one of the catalog's zero-shot entries? */
export function isZeroshotVoiceId(voiceId: string): boolean {
  return resolveHiggsModel(voiceId).kind === 'clips';
}

/**
 * Turn a BookForge voice id into the load Crucible takes, reading the clip off
 * this machine's disk when there is one.
 *
 * `userDataDir` is REQUIRED for a zero-shot voice and refused as missing
 * rather than guessed — the clip is a NAME in the models area and there is no
 * default and no search (`higgsReferenceClipPath` says so in the same words).
 */
export function crucibleVoiceLoadFor(voiceId: string, userDataDir: string): CrucibleVoiceLoad {
  const model = resolveHiggsModel(voiceId);

  if (model.kind !== 'clips') {
    const mapped = CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE[model.id];
    if (mapped === undefined) {
      throw new CrucibleVoiceLoadRefused(
        'crucible_voice_unmapped',
        `BookForge voice "${model.id}" has no Crucible voice. Mapped: `
          + `${Object.keys(CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE).join(', ')}, plus every `
          + `zeroshot-* entry, which loads as "${CRUCIBLE_ZEROSHOT_VOICE}" with its clip.`,
      );
    }
    // A CHECKPOINT'S VOICE IS IN ITS WEIGHTS. Sending a clip with one is
    // `reference_not_allowed`, and it would clone from the clip and leave the
    // weights this load names doing nothing, under their own fingerprint.
    return { voice: mapped, reference: null };
  }

  const clips = model.voice.clips ?? [];
  if (clips.length !== 1) {
    throw new CrucibleVoiceLoadRefused(
      'reference_required',
      `Higgs voice "${model.id}" is kind 'clips' and declares ${clips.length} of them. `
        + 'Exactly one travels with a load — vllm-omni refuses multi-shot cloning, and two '
        + 'clips means one pre-joined wav (see HiggsReferenceClip).',
    );
  }
  const clip = clips[0]!;
  const file = higgsReferenceClipPath(model, clip, userDataDir);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new CrucibleVoiceLoadRefused(
      'reference_required',
      `Higgs voice "${model.id}" names reference clip ${clip.path}, which could not be read `
        + `from ${file}: ${(err as Error).message}. Copy the clip into the models area, `
        + "runtime/higgs-models/refs/ under the app's userData — it is a voice artifact staged "
        + 'per machine, like a checkpoint.',
    );
  }

  /*
   * THE CHECKS THE BYTES CAN ANSWER, before 1.4 MB crosses a tailnet. The
   * catalog also DECLARES `seconds`, and this deliberately does not compare
   * the two: the wav's header is the only honest source for a duration, and a
   * declared number that disagrees with it is the catalog's problem to fix,
   * not a reason to refuse a clip the server would accept. What is refused is
   * what the SERVER would refuse.
   */
  const facts = refuseUnusableClip(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    clip.transcript,
    `the reference clip for "${model.id}" (${file})`,
  );
  void facts;

  return {
    voice: CRUCIBLE_ZEROSHOT_VOICE,
    reference: {
      data: encodeReferenceData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
      transcript: clip.transcript,
      // The catalog's label, so `/v1/activity` says WHICH of the four is up.
      // Never derived from anything: a made-up name is one a client would then
      // look for (PHASE3-TTS.md §5).
      name: model.id,
    },
  };
}

/**
 * The CHECK half: does that server serve the voice, and does its row agree
 * about whether a clip is wanted?
 *
 * `needsReference` is the row's fact and this app does not hold a second
 * opinion about it — what it does is refuse EARLY and by the server's own name
 * when the two disagree, because the alternative is discovering it after the
 * upload. A voice the server does not list at all is refused naming what it
 * does list, the same discipline `render.ts`'s
 * `assertCrucibleVoiceAvailable` applies.
 */
export function refuseMismatchedReference(
  rows: readonly VoiceInfo[],
  load: CrucibleVoiceLoad,
  server: string,
): void {
  const row = rows.find((v) => v.id === load.voice);
  if (row === undefined) {
    throw new CrucibleVoiceLoadRefused(
      'crucible_unknown_voice',
      `crucible "${server}" does not serve a voice called "${load.voice}". It serves: `
        + `${rows.map((v) => v.id).join(', ') || '(none)'}.`,
    );
  }
  if (row.needsReference && load.reference === null) {
    throw new CrucibleVoiceLoadRefused(
      'reference_required',
      `crucible "${server}" says "${load.voice}" is cloned from a recording, and this load `
        + 'carries none. The base weights with no reference are the model\'s OWN speaker — a '
        + 'different narrator under the id you chose.',
    );
  }
  if (!row.needsReference && load.reference !== null) {
    throw new CrucibleVoiceLoadRefused(
      'reference_not_allowed',
      `crucible "${server}" says "${load.voice}" carries its speaker in its own weights, so a `
        + 'reference clip would clone somebody else and leave those weights doing nothing.',
    );
  }
}

/** One line of a load's progress, for whoever is watching. */
export type VoiceLoadProgress = (line: string) => void;

/**
 * What the load ended with — the voice that is now resident, and WHICH CLIP it
 * was cloned from.
 *
 * `reference` comes off the job's own `done` frame
 * (`DoneData.extra.reference`, which the SDK carries verbatim — *"server
 * spelling, server types, nothing invented and nothing dropped"*). `zeroshot`
 * is one id and any number of recordings, so the id alone does not say whose
 * voice is on the card; `null` is the true answer for every other kind.
 */
export interface CrucibleVoiceLoaded {
  readonly jobId: string;
  readonly resident: string | null;
  readonly reference: { name: string | null; sha256: string; seconds: number } | null;
}

/**
 * Submit the `load-voice` job and watch it to its end.
 *
 * Every failure is the SERVER's own code and message — `env_missing`,
 * `not_installed`, `insufficient_vram`, `server_busy`, `leased`,
 * `reference_malformed` — and none is retried, worked around, or downgraded
 * to a local spawn.
 */
export async function loadVoiceOn(
  client: CrucibleClient,
  load: CrucibleVoiceLoad,
  onProgress?: VoiceLoadProgress,
): Promise<CrucibleVoiceLoaded> {
  const jobId = load.reference === null
    ? await client.loadVoice(load.voice)
    : await client.loadVoice(load.voice, { reference: load.reference });
  for await (const event of client.events(jobId)) {
    // Display only; either field may be unstated (Crucible 1.0.25) and is said to be.
    if (event.event === 'warming') onProgress?.(event.data.message === null ? 'warming up' : event.data.message);
    else if (event.event === 'queued') {
      onProgress?.(event.data.position === null ? 'queued' : `queued (position ${event.data.position})`);
    }
    else if (event.event === 'done') {
      return {
        jobId,
        resident: event.data.resident ?? null,
        reference: readDoneReference(event.data.extra),
      };
    } else if (event.event === 'failed') {
      throw new CrucibleVoiceLoadRefused(event.data.error.code, event.data.error.message);
    } else if (event.event === 'cancelled') {
      throw new CrucibleVoiceLoadRefused(
        'load_cancelled',
        `the load of "${load.voice}" was cancelled on the server`,
      );
    }
  }
  // `events()` ends only on a terminal event or a dead connection, and the SDK
  // throws for the latter — so falling out of the loop means the contract
  // moved, and that is said rather than treated as success.
  throw new CrucibleVoiceLoadRefused(
    'crucible_protocol',
    `the load of "${load.voice}" ended with no done, failed or cancelled event.`,
  );
}

/**
 * The clip the server says is now resident, off the `done` frame's extras.
 *
 * ABSENT IS NOT NULL. `null` means "nothing was cloned" (a checkpoint voice,
 * or a model), which is an answer; a frame that does not carry the key at all
 * is a server that predates §5's amendment, and reading that as "no clip"
 * would report a zero-shot load as a plain one. Said, rather than guessed.
 */
function readDoneReference(
  extra: Readonly<Record<string, unknown>>,
): { name: string | null; sha256: string; seconds: number } | null {
  const raw = extra['reference'];
  if (raw === null) return null;
  if (raw === undefined) {
    throw new CrucibleVoiceLoadRefused(
      'crucible_protocol',
      'the load finished without saying which reference clip is resident. That server predates '
        + 'PHASE3-TTS.md §5\'s amendment, so which clip a zero-shot voice was cloned from is '
        + 'unknowable from here — update it.',
    );
  }
  const row = raw as { name?: unknown; sha256?: unknown; seconds?: unknown };
  if (typeof row.sha256 !== 'string' || typeof row.seconds !== 'number') {
    throw new CrucibleVoiceLoadRefused(
      'crucible_protocol',
      'the load reported a resident reference with no sha256 or no seconds.',
    );
  }
  return {
    name: typeof row.name === 'string' && row.name !== '' ? row.name : null,
    sha256: row.sha256,
    seconds: row.seconds,
  };
}

export { VoiceReferenceRefused };
