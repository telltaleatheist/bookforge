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
import type { Activity, CrucibleClient, ServerInfo, VoiceInfo } from '@crucible/client';

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

/**
 * Who is using the voice engine on that server, as one sentence — for the
 * popup, after an `engine_in_use` or a `stream_session_open`.
 *
 * PREEMPT IS NEVER SILENT. There is deliberately no "take it anyway" in this
 * module: a session belongs to whoever opened it, and taking one over is an
 * explicit act through the engine (plan §1), not something a Load button does
 * because the first attempt was refused.
 */
export function describeHolder(activity: Activity): string | null {
  if (activity.streaming !== null) {
    const who = activity.streaming.client ?? 'a client that did not name itself';
    return `${who} is reading aloud on this server (${activity.streaming.voice}, `
      + `${activity.streaming.finished} of ${activity.streaming.said} rows done).`;
  }
  if (activity.claim !== null) {
    return `${activity.claim.heldBy} holds the voice engine on this server.`;
  }
  const running = activity.running[0];
  if (running !== undefined) {
    const who = running.client ?? 'a client that did not name itself';
    return `${who} is running a ${running.type} job here (${Math.round(running.progress * 100)}%).`;
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
  onProgress?: JobProgress,
): Promise<void> {
  const jobId = await client.loadVoice(voice);
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
