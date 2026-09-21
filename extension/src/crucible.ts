/**
 * The extension's five doors onto a Crucible, and the words it refuses in.
 *
 * Phase 16 (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §1) maps the old 8766 WebSocket
 * onto these:
 *
 *   hello {token}                  -> a bearer on every request (the SDK's)
 *   status / state                 -> `GET /v1/info` + `GET /v1/activity`
 *   engine.start {voice}           -> job `load-voice {voice}` and its events
 *   engine.stop                    -> job `unload-voice`
 *   engine.restart {engine,…}      -> GONE. One engine; workers are server tuning.
 *   config.get/set                 -> `GET /v1/voices` for the list; the rest is
 *                                     the server's config and never a client's.
 *   speak / chunk / done / cancel  -> the streaming session (offscreen.ts)
 *
 * NOTHING HERE RETRIES AND NOTHING HERE FALLS BACK. Every refusal the server
 * makes is surfaced by its own code with a sentence a reader can act on; an
 * unreachable server is not "try again later", it is "that machine is not
 * answering and nothing is going to speak until it does".
 */

import {
  CrucibleAuthError,
  CrucibleBusy,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';
import type {
  Activity,
  CrucibleClient,
  ServerInfo,
  VoiceInfo,
  VoiceReference,
} from '@crucible/client';
import type { ServerEntry } from './servers';

/** What `Test` shows for one server: is it there, and what is on its card. */
export interface ServerProbe {
  /** The server's own name — not the name it is registered under here. */
  name: string;
  version: string;
  /** `cuda-linux` or `mlx-darwin`. Windows is never a backend. */
  backend: string;
  /** The voice (or model) on the card right now, or null. */
  resident: string | null;
  /** `tts`, `llm`, … or null when nothing is resident. */
  residentKind: string | null;
  /** Does this server serve `tts` at all? */
  servesTts: boolean;
}

/**
 * Every refusal in one sentence, with the server's own code in front so a
 * caller can still match on it.
 *
 * A thinner cousin of `electron/crucible/stream.ts`'s
 * `describeCrucibleStreamRefusal`: the prose differs because the reader is
 * someone with a web page open rather than someone rendering a book, but the
 * thing both switch on — the SDK's error TYPES — is the one shared fact.
 */
export function describeRefusal(err: unknown, serverName: string): string {
  const at = `Crucible "${serverName}"`;
  if (err instanceof CrucibleBusy) {
    return `${at} is running a job on its lane (${err.busyLine}) and will not take this as well. `
      + 'Try again when it is done, or pick another server in Options.';
  }
  if (err instanceof CrucibleRefused) {
    if (err.code === 'stream_session_open') {
      return `${at} already has a reading session open. A server holds one at a time — `
        + `${err.serverMessage}`;
    }
    if (err.code === 'engine_in_use') {
      return `${at}: ${err.serverMessage}. Something else holds the voice engine there.`;
    }
    if (err.code === 'voice_not_resident') {
      return `${at}: ${err.serverMessage}. Press "Load voice" first — a reading session never `
        + 'loads one by itself.';
    }
    if (err.code === 'job_type_disabled') {
      return `${at} does not serve speech (${err.serverMessage}). Pick a server that does.`;
    }
    /*
     * THE THREE ZERO-SHOT REFUSALS (PHASE3-TTS.md §5's amendment), all made
     * before the job is queued. Two of them this extension also makes itself,
     * with the same names, from the bytes it already has
     * (`shared/crucible/voice-reference.ts`); these sentences are for the
     * server's own, which are the authority.
     */
    if (err.code === 'reference_required') {
      return `${at}: ${err.serverMessage}. That voice is cloned from a recording and no clip was `
        + 'sent. Pick one under the voice in the popup, or add one in Options → Zero-shot clips.';
    }
    if (err.code === 'reference_not_allowed') {
      return `${at}: ${err.serverMessage}. That voice's speaker is in its own weights, so a clip `
        + 'would clone somebody else and leave the weights doing nothing. Clear the clip.';
    }
    if (err.code === 'reference_malformed') {
      // VERBATIM. The server read the bytes and said what was wrong with them
      // — the duration it measured, the ceiling it applies — and rewording
      // that into a friendlier sentence would lose the number to act on.
      return `${at}: ${err.serverMessage}`;
    }
    return `${at} refused this (HTTP ${err.status}, ${err.code}): ${err.serverMessage}`;
  }
  if (err instanceof CrucibleAuthError) {
    return `${at} rejected the token. Paste a fresh connect code in Options — the server prints `
      + 'one on its operator page.';
  }
  if (err instanceof CrucibleVersionError) {
    return `${at} speaks API version ${err.serverApiVersion} and this extension speaks `
      + `${err.clientApiVersion}. One of the two has to be updated.`;
  }
  if (err instanceof CrucibleServerError) {
    return `${at} broke on this request (HTTP ${err.status}): ${err.serverMessage}. Its own log `
      + 'says why.';
  }
  if (err instanceof CrucibleUnreachable) {
    return `${at} is not answering: ${err.message}. Nothing is read from anywhere else instead.`;
  }
  if (err instanceof CrucibleNotACrucible) {
    return `${at} answered but is not a Crucible. Check the address in Options.`;
  }
  if (err instanceof CrucibleProtocolError) {
    return `${at} sent something this extension does not understand: ${err.detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** `GET /v1/ping` + `GET /v1/info` — the Options page's Test. */
export async function probe(client: CrucibleClient): Promise<ServerProbe> {
  await client.ping();
  const info: ServerInfo = await client.info();
  const health = await client.health();
  return {
    name: info.server.name,
    version: info.server.version,
    backend: info.host.backend,
    resident: health.residentModels[0] ?? null,
    residentKind: health.residentKind,
    servesTts: info.jobTypes.includes('tts'),
  };
}

/**
 * The voices this server has a manifest for.
 *
 * Every row names its own `narratorEngine`. THAT is the multi-engine door
 * (plan §4a): a client shows the engine as a COLUMN when the list carries more
 * than one, and never as a selector — a voice implies its engine, so there is
 * no engine to choose apart from a voice and none to remove later.
 */
export function voicesOf(client: CrucibleClient): Promise<VoiceInfo[]> {
  return client.voices();
}

/** True when the voice list spans more than one narrator engine. */
export function hasMultipleEngines(voices: readonly VoiceInfo[]): boolean {
  return new Set(voices.map((v) => v.narratorEngine)).size > 1;
}

/** What is on the card right now, and who holds it. */
export function activityOf(client: CrucibleClient): Promise<Activity> {
  return client.activity();
}

/** The clip a resident `zeroshot` voice was cloned from, as the server reports it. */
export interface ResidentClip {
  /** The label whoever loaded it sent. Null when they sent none. */
  readonly name: string | null;
  /** Over the DECODED audio, so two clients sending the same wav agree. */
  readonly sha256: string;
  readonly seconds: number;
}

/**
 * WHICH CLIP IS ON THE CARD — read straight off `/v1/activity`, because the
 * vendored SDK drops the field.
 *
 * `zeroshot` is ONE voice id and any number of recordings, so the id alone is
 * two clients each assuming the resident one is theirs. PHASE3-TTS.md §5's
 * amendment answers it: `GET /v1/activity`'s `resident` block carries
 * `reference: {name, sha256, seconds}`, null for every other kind and for a
 * model, and the `load-voice` job's own `done` carries the same object.
 *
 * ── WHY THIS IS A `fetch` AND NOT `client.activity()` ─────────────────────
 *
 * The SDK's activity reader builds its `resident` out of four named
 * fields — `kind`, `id`, `since`, `memory_bytes_estimate` — and silently
 * drops everything else, `reference` included. Written against 0.6.0 and
 * STILL TRUE at the 1.0.6 tarball in `vendor/` (checked 2026-09-19:
 * `AcceleratorResident` in `dist/esm/types.d.ts` carries those four and no
 * fifth), which is why this is still here. The field IS on the wire and
 * IS in the contract; what is missing is a line in the SDK's shaper. This is
 * the same situation, and the same treatment, as
 * `electron/crucible/settings-wire.ts` before the phase-15 re-pack: BookForge
 * speaks the documented wire in the meantime and a keeper FAILS BY NAME the
 * day the SDK models it — which is the instruction to delete this function,
 * not a regression.
 *
 * It reads ONLY the reference. Everything else about that server still comes
 * from `client.activity()`, so there is no second opinion about anything the
 * SDK already answers.
 */
export async function residentClipOf(entry: ServerEntry): Promise<ResidentClip | null> {
  const response = await fetch(`${entry.url}/v1/activity`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${entry.token}`, 'X-Crucible-Api': '1' },
  });
  if (!response.ok) {
    throw new Error(
      `Crucible "${entry.name}" answered HTTP ${response.status} for /v1/activity, so which clip `
      + 'is resident there cannot be read.',
    );
  }
  const body = await response.json() as { resident?: { reference?: unknown } | null };
  const resident = body.resident;
  if (resident === null || resident === undefined) return null;
  const reference = resident.reference;
  // A checkpoint voice, or a model, reports `reference: null`. That is an
  // answer — "nothing was cloned" — and it is not the same as the key being
  // absent, which is a server that predates the field and is NOT read as
  // "no clip": it is read as "this server cannot say", and said so.
  if (reference === null) return null;
  if (reference === undefined) {
    throw new Error(
      `Crucible "${entry.name}" does not report a resident reference on /v1/activity. That server `
      + 'predates PHASE3-TTS.md §5\'s amendment, so which clip is loaded there is unknowable from '
      + 'here — update it.',
    );
  }
  const row = reference as { name?: unknown; sha256?: unknown; seconds?: unknown };
  if (typeof row.sha256 !== 'string' || typeof row.seconds !== 'number') {
    throw new Error(
      `Crucible "${entry.name}" reported a resident reference this extension cannot read `
      + '(no sha256, or no seconds).',
    );
  }
  return {
    name: typeof row.name === 'string' && row.name !== '' ? row.name : null,
    sha256: row.sha256,
    seconds: row.seconds,
  };
}

/**
 * THE JOBS THIS EXTENSION SUBMITTED AND HAS NOT SEEN END — so that when the
 * bench names the holder of the engine, this extension can recognise itself.
 *
 * Owen, 2026-09-20, reading the popup: *"Mozilla/5.0 (Macintosh …) Chrome/154
 * … is running a load-voice job here (0%). it looks like an error. is it
 * necessary info or can it be removed?"* It was this extension describing ITS
 * OWN load — a Listen pressed while the voice was still loading was refused
 * `engine_in_use`, and the holder line duly named the holder: this browser, by
 * the only name Crucible had for it. A browser cannot set `User-Agent`, so the
 * SDK's `clientName` never reached the server and the job was recorded under
 * Chrome's own string.
 *
 * The job id is the strongest of the three ways {@link describeHolder} knows a
 * holder is itself; the other two are the User-Agent this browser sends and the
 * `clientName` it asks the SDK to send.
 */
const ownJobs = new Set<string>();

/** What this extension knows about itself, for recognising its own name. */
export interface SelfIdentity {
  /** `navigator.userAgent` — what Crucible records when nothing better arrives. */
  readonly userAgent: string;
  /** The name the SDK is asked to send (`CLIENT_NAME`). */
  readonly clientName: string;
}

/** A holder line for the popup: the sentence, and whether it is about ourselves. */
export interface HolderNote {
  readonly text: string;
  /**
   * TRUE when the engine is held by THIS extension. The popup then draws the
   * line as information rather than as a refusal: waiting for your own load to
   * finish is expected, not an error.
   */
  readonly ours: boolean;
}

/** Is this the name Crucible would have recorded for us? */
function isOurs(client: string | null, jobId: string | null, self: SelfIdentity): boolean {
  if (jobId !== null && ownJobs.has(jobId)) return true;
  if (client === null) return false;
  if (client === self.userAgent) return true;
  // The SDK's spelling is `<clientName> crucible-client/<version>`; a server that
  // reads `X-Crucible-Client` records the bare name.
  return client === self.clientName || client.startsWith(`${self.clientName} `);
}

/**
 * A holder's name as a person would say it.
 *
 * A User-Agent string is not a name — it is what a browser sends when nobody
 * gave it one — so it is read for what it IS ("another browser") rather than
 * printed. Everything else is a name somebody chose and is used as given.
 */
function holderName(client: string | null): string {
  if (client === null || client === '') return 'a client that did not name itself';
  if (/^Mozilla\//.test(client)) return 'another browser';
  return client;
}

/**
 * Who is using the voice engine on that server, as one sentence — for the
 * popup, after an `engine_in_use` or a `stream_session_open`.
 *
 * PREEMPT IS NEVER SILENT. There is deliberately no "take it anyway" in this
 * module: a session belongs to whoever opened it, and taking one over is an
 * explicit act through the engine (plan §1), not something a Load button does
 * because the first attempt was refused.
 *
 * WHEN THE HOLDER IS OURSELVES the sentence says so, in the first person and
 * about the wait rather than the refusal — see {@link ownJobs} for the evening
 * this was a Chrome User-Agent string printed in red.
 */
export function describeHolder(activity: Activity, self: SelfIdentity): HolderNote | null {
  if (activity.streaming !== null) {
    const stream = activity.streaming;
    if (isOurs(stream.client, null, self)) {
      return {
        ours: true,
        text: `This browser is already reading aloud here (${stream.voice}, `
          + `${stream.finished} of ${stream.said} rows done).`,
      };
    }
    return {
      ours: false,
      text: `${holderName(stream.client)} is reading aloud on this server (${stream.voice}, `
        + `${stream.finished} of ${stream.said} rows done).`,
    };
  }
  if (activity.claim !== null) {
    return { ours: false, text: `${activity.claim.heldBy} holds the voice engine on this server.` };
  }
  const running = activity.running[0];
  if (running !== undefined) {
    const pct = Math.round(running.progress * 100);
    if (isOurs(running.client, running.jobId, self)) {
      const what = running.type === 'load-voice'
        ? `Still loading the voice here (${pct}%) — Listen starts when it is resident.`
        : `This browser is running a ${running.type} job here (${pct}%).`;
      return { ours: true, text: what };
    }
    return {
      ours: false,
      text: `${holderName(running.client)} is running a ${running.type} job here (${pct}%).`,
    };
  }
  return null;
}

/** One line of a load's progress, as the popup shows it. */
export type JobProgress = (line: string) => void;

/**
 * Make a voice resident: `POST /v1/jobs {type: "load-voice", …}` and watch it.
 *
 * Resolves when the server says `done`. A failure is the server's own code and
 * message — `env_missing`, `not_installed`, `insufficient_vram`, `server_busy`,
 * `leased` — none of which this extension can fix and none of which it retries.
 */
export async function loadVoice(
  client: CrucibleClient,
  voice: string,
  reference: VoiceReference | null,
  onProgress?: JobProgress,
): Promise<void> {
  /*
   * THE CLIP TRAVELS WITH THE LOAD, which is the one moment it is needed
   * (PHASE3-TTS.md §5's amendment). `null` is a real answer and not an
   * omission: it is what every checkpoint voice sends, and sending one on a
   * checkpoint is `reference_not_allowed`. Whether a voice wants one is the
   * ROW's to say (`needsReference`), never this function's to guess.
   */
  const jobId = reference === null
    ? await client.loadVoice(voice)
    : await client.loadVoice(voice, { reference });
  // Ours, from the moment it exists until it ends — see `ownJobs`.
  ownJobs.add(jobId);
  try {
    for await (const event of client.events(jobId)) {
      if (event.event === 'warming') onProgress?.(event.data.message);
      else if (event.event === 'queued') onProgress?.(`queued (position ${event.data.position})`);
      else if (event.event === 'done') return;
      else if (event.event === 'failed') {
        throw new Error(`${event.data.error.code}: ${event.data.error.message}`);
      } else if (event.event === 'cancelled') {
        throw new Error(`the load of "${voice}" was cancelled on the server`);
      }
    }
    // `events()` ends only on a terminal event or a dead connection, and the SDK
    // throws for the latter — so falling out of the loop means the contract
    // changed under us, and that is said rather than treated as success.
    throw new Error(
      `the load of "${voice}" ended with no done, failed or cancelled event. The server's job `
      + 'event stream did something API v1 does not describe.',
    );
  } finally {
    ownJobs.delete(jobId);
  }
}

/**
 * Take the voice off the card: `POST /v1/jobs {type: "unload-voice"}`.
 *
 * It names the resident voice because the server's unload door does
 * (`voice_not_resident` otherwise, which is a DIFFERENT refusal from "nothing
 * is loaded" and says so). A card holding a MODEL is not unloaded by this
 * extension: a language model on that machine belongs to whatever put it
 * there, and evicting it to read a web page is not this button's business.
 */
export async function unloadVoice(
  client: CrucibleClient,
  voice: string,
  onProgress?: JobProgress,
): Promise<void> {
  const jobId = await client.unloadVoice(voice);
  for await (const event of client.events(jobId)) {
    if (event.event === 'warming') onProgress?.(event.data.message);
    else if (event.event === 'done') return;
    else if (event.event === 'failed') {
      throw new Error(`${event.data.error.code}: ${event.data.error.message}`);
    } else if (event.event === 'cancelled') {
      throw new Error(`the unload of "${voice}" was cancelled on the server`);
    }
  }
  throw new Error(
    `the unload of "${voice}" ended with no done, failed or cancelled event. The server's job `
    + 'event stream did something API v1 does not describe.',
  );
}
