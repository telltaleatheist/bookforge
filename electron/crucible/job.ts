/**
 * ONE CRUCIBLE JOB, END TO END — the helper every door shares.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * Every Crucible job type is the same conversation: park the inputs
 * (`POST /v1/uploads`), submit (`POST /v1/jobs`), follow the event stream
 * (`GET /v1/jobs/{id}/events`) until its terminal frame, and fetch what the job
 * wrote (`GET /v1/jobs/{id}/artifacts/{name}`). `electron/crucible/render.ts`
 * spelled that conversation out for `tts` on 2026-09-13 and it was right for
 * `tts`; the third door written the same way is a third copy of the refusal
 * vocabulary, the cancel handshake and the resume rule, and the day one of them
 * learns something the others do not. So this is the one place the
 * conversation is written, and `asr.ts` and `align.ts` are what a door looks
 * like when it only has to say WHAT it wants.
 *
 * `render.ts` is NOT yet on it (2026-09-14): it was left exactly as built for
 * Owen's in-app pass, and moving its orchestration here is a follow-up once
 * that pass is green. This helper is shaped so that move is a deletion: it
 * takes `attachTo` for resume, hands out a cancel handle, carries `warming`
 * and `progress` to the caller with the server's own fraction, and lands
 * artifacts under the local naming through the SDK's own writer.
 *
 * ── What it refuses, and what it never does ────────────────────────────────
 *
 * **Every refusal is by name, and none is retried.** A `409 server_busy` and a
 * `409 leased` both arrive as {@link CrucibleJobRefused} carrying the SDK's
 * own `busyLine` ("GPU busy: foundry, tts 62% done", "leased: foundry,
 * translate, until …") for the caller that can WAIT — the queue holds the row
 * (`queue-engine.noteStepBusy`); nothing here loops. The two are one question
 * with two clocks: the LANE frees in minutes, a client's RUN may hold the card
 * for an hour. Every other
 * SDK type — `engine_in_use`, `model_not_resident`, `job_type_disabled`,
 * `unknown_model`, `invalid_params`, `invalid_inputs`, the token, the API
 * version, a 5xx, an unreachable server, a non-crucible answering, a protocol
 * violation — is the same class with the server's own code in front. A job
 * that ran and ended `failed` is a different thing and its own class
 * ({@link CrucibleJobFailed}); a job that ended `cancelled` is
 * {@link CrucibleJobCancelled}. A caller matches on the class and the `code`.
 *
 * **No fallback to anything local.** A refused job is a refused job. Quietly
 * running the work on this machine instead would take a card somebody else is
 * using and report success (`crucible/docs/ARCHITECTURE.md` R3: nothing is
 * ever told "maybe").
 *
 * **Cancellation is a cancel, not a hang-up.** Abandoning the event stream
 * leaves the job RUNNING on the server, holding its exclusive lane. So an
 * aborted `signal` sends `DELETE /v1/jobs/{id}` and then lets the stream run
 * on to the `cancelled` frame it will now receive, which is what turns this
 * into a reported cancellation rather than a silence. What was already
 * downloaded stays on disk (R6: partial work survives failure, always).
 *
 * **Resume is the server's counter.** `attachTo.lastEventId` is `JobEvent.id`,
 * the server's own monotonic number; the server replays events above it and no
 * further. Nothing is uploaded and nothing is submitted on an attach.
 *
 * **Uploads stream from disk.** A path input goes up as a `Blob` opened over
 * the file (`fs.openAsBlob`, Node 19.8+; Electron 33 carries Node 20.18), so a
 * 900 MB m4b never sits in the main process's heap. A runtime without it is
 * refused by name rather than read whole into memory.
 *
 * ── NO LEASE HERE, AND THAT IS THE RULING RATHER THAN AN OVERSIGHT ─────────
 *
 * Owen ruled on 2026-09-14 that a Crucible unloads the resident model the moment
 * nothing holds it, and `electron/crucible/lease.ts` is how BookForge's
 * chat-shaped runs say they are still holding. **A job is not one of them.**
 *
 * "Done" is four facts (crucible `docs/PHASE7-LANES.md` §5.3) and the FIRST of
 * them is *no job is running or queued on the lane*. Everything that comes
 * through this helper — `asr`, `align`, `rvc`, `denoise`, a reroll's renders —
 * is exactly that: one submission, one lane, one row in `/v1/activity` reading
 * `running`, and a second submission refused `server_busy` naming it. The job
 * already holds what a lease would hold, for precisely as long, and a lease
 * around one would be a second owner of one fact (ARCHITECTURE.md R1).
 *
 * It would also be self-defeating, which is the part worth stating plainly:
 * `tts` and `align` are in crucible's `EVICTS_THE_RESIDENT_MODEL`, so a lease
 * taken around one of those jobs would make the server refuse `409 leased`
 * — **to its own holder**, since a lease has no exemption for the client that
 * took it. The run would refuse itself.
 *
 * A lease is for a SEQUENCE of requests with nothing else holding the card
 * between them: the four text acts, a cleanup run, a page read. Those lease,
 * once each, and `tools/test-crucible-lease.js` pins that these doors do not.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CrucibleAuthError,
  CrucibleBusy,
  CrucibleConfigError,
  CrucibleLeased,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';
import type {
  CrucibleClient,
  DoneData,
  JobEvent,
  JobInput,
  ServerInfo,
  WrittenArtifact,
} from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';

// ─────────────────────────────────────────────────────────────────────────────
// The refusal vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A job this door could not run: a server that said no, a transport that
 * failed, or a caller that asked for something that cannot be asked for.
 *
 * `code` is the server's own code wherever the server sent one
 * (`server_busy`, `engine_in_use`, `job_type_disabled`, …) and this module's
 * where it did not (`crucible_unreachable`, `crucible_protocol`, …), so a caller
 * matches on one spelling either way.
 *
 * `busyLine` is present exactly on the refusals a row can WAIT out — the SDK's
 * own "GPU busy: foundry, tts 62% done" for `server_busy`, and since
 * 2026-09-18 "leased: foundry, translate, until …" for `leased`, both built
 * from the holder the server named — and absent on every other refusal.
 * Carried beside the prose because the queue holds a row on it (crucible
 * `docs/ARCHITECTURE.md` §3: a 409 is a wait, not a failure) and would
 * otherwise dig it back out of a sentence.
 */
export class CrucibleJobRefused extends Error {
  readonly code: string;
  readonly server: string;
  readonly busyLine?: string;

  constructor(code: string, server: string, message: string, busyLine?: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleJobRefused';
    this.code = code;
    this.server = server;
    if (busyLine !== undefined) this.busyLine = busyLine;
  }
}

/**
 * A job the server admitted, ran, and ended `failed` — `asr_window_failed`,
 * `worker_failed`, an engine that died. Its own class because it is not a
 * refusal: the lane was taken, time was spent, and the server's message
 * carries the engine's last words (PHASE4-AUDIO.md §6, the log tail rides in
 * `message`). A caller that would retry a refusal must not retry this.
 */
export class CrucibleJobFailed extends Error {
  readonly code: string;
  readonly server: string;
  readonly jobId: string;

  constructor(server: string, jobId: string, code: string, message: string) {
    super(`crucible "${server}" job ${jobId} failed ${code}: ${message}`);
    this.name = 'CrucibleJobFailed';
    this.code = code;
    this.server = server;
    this.jobId = jobId;
  }
}

/** A job that ended `cancelled` — ours through `signal`, or somebody else's DELETE. */
export class CrucibleJobCancelled extends Error {
  readonly code = 'cancelled';
  readonly server: string;
  /** Null when the caller aborted before the job existed. */
  readonly jobId: string | null;

  constructor(server: string, jobId: string | null, message: string) {
    super(message);
    this.name = 'CrucibleJobCancelled';
    this.server = server;
    this.jobId = jobId;
  }
}

/**
 * The SDK's error types, turned into one sentence a person can act on, with
 * the server's own code kept in front so a caller can still match on it.
 *
 * `verb` names the thing being asked for ("an asr job", "the align job's
 * events") so the sentence says what was refused and not just where.
 *
 * Not one of the SDK's types comes back UNCHANGED, with its stack: an
 * unexpected exception is not a refusal and dressing it as one loses where it
 * came from. (render.ts carries the same table for `tts`; that copy is the one
 * to delete when render.ts moves onto this helper.)
 */
export function describeCrucibleJobRefusal(err: unknown, server: string, verb: string): unknown {
  const at = `crucible "${server}"`;
  if (err instanceof CrucibleBusy) {
    return new CrucibleJobRefused(
      err.code,
      server,
      `${at} takes one job at a time and is already running one, so ${verb} was not admitted. `
      + `${err.busyLine} (job ${err.jobId}, ${err.jobStatus} since ${err.since}`
      + `${err.jobMessage === null ? '' : `; latest: ${err.jobMessage}`}). Nothing here waits for it `
      + 'or runs the work somewhere else.',
      err.busyLine,
    );
  }
  /*
   * A LEASED CARD IS A WAIT, AND IT IS ASKED ABOUT BEFORE `CrucibleRefused`.
   *
   * `CrucibleLeased` is a subclass of {@link CrucibleRefused} and NOT of
   * {@link CrucibleBusy} (crucible `sdk/ts/src/errors.ts`), so until
   * 2026-09-18 it fell into the generic arm below with no `busyLine` — and
   * `settleStep` parks a row only when one is present, so the row FAILED and
   * waited for a person to press Retry. Foundry, on the identical refusal,
   * parks with the holder's name and comes back on backoff; two clients
   * against one server must not answer one refusal in opposite directions.
   *
   * Same question as `server_busy` with a longer clock — a lane frees in
   * minutes, a lease may hold for an hour — so it takes the same road. Nothing
   * here retries: the queue holds the row and the admission tick asks again.
   */
  if (err instanceof CrucibleLeased) {
    return new CrucibleJobRefused(
      err.code,
      server,
      `${at} has its resident ${err.kind} held by another client's run, so ${verb} was not `
      + `admitted — it would take that ${err.kind} off the card. ${err.leasedLine} `
      + `(lease ${err.leaseId}, since ${err.since}). Nothing here waits for it or runs the work `
      + 'somewhere else.',
      err.leasedLine,
    );
  }
  if (err instanceof CrucibleRefused) {
    return new CrucibleJobRefused(
      err.code, server, `${at} refused ${verb} (HTTP ${err.status}): ${err.serverMessage}`,
    );
  }
  if (err instanceof CrucibleAuthError) {
    return new CrucibleJobRefused(
      err.code, server,
      `${at} refused the token for ${verb}: ${err.serverMessage}. Re-add the server with the token `
      + '`crucible token --show` prints on that host.',
    );
  }
  if (err instanceof CrucibleVersionError) {
    return new CrucibleJobRefused(
      err.code, server,
      `${at} speaks API version ${err.serverApiVersion}, this client speaks ${err.clientApiVersion}: `
      + `${err.serverMessage}. One of the two must be updated.`,
    );
  }
  if (err instanceof CrucibleServerError) {
    return new CrucibleJobRefused(
      err.code, server,
      `${at} failed ${verb} (HTTP ${err.status}): ${err.serverMessage}. The server broke; its own `
      + 'log says why.',
    );
  }
  if (err instanceof CrucibleUnreachable) {
    return new CrucibleJobRefused(
      'crucible_unreachable', server,
      `${at} could not be reached for ${verb}: ${err.message}. Nothing is retried here — start the `
      + 'server and queue the work again, or pick another one.',
    );
  }
  if (err instanceof CrucibleNotACrucible) {
    return new CrucibleJobRefused(
      'crucible_not_a_crucible', server,
      `${at} answered /v1/ping but is not a crucible: ${err.body}. Check the url.`,
    );
  }
  if (err instanceof CrucibleProtocolError) {
    return new CrucibleJobRefused(
      'crucible_protocol', server,
      `${at} sent something API v1 does not describe during ${verb}: ${err.detail}. The server `
      + 'and this client disagree about the protocol.',
    );
  }
  if (err instanceof CrucibleConfigError) {
    return new CrucibleJobRefused(
      'crucible_client_misconfigured', server, `${at}: this client was built wrong — ${err.message}`,
    );
  }
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Does this server offer that job type, and that model?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `GET /v1/info` before anything crosses the wire. The submit would refuse
 * `job_type_disabled` / `unknown_model` anyway; what this buys is the refusal
 * BEFORE a 900 MB m4b or 1,400 chunk FLACs go up, with the server's own list
 * in the message — and, for a host where the type is off (the Mac has no
 * `align`: no mlx-darwin block for qwen3-aligner), a sentence that says so
 * rather than a failed job after the uploads.
 *
 * It cannot say whether the weights are PULLED: `ModelDescriptor` has no
 * `installed` field yet (docs/CRUCIBLE_ROLLOUT_PLAN.md tier 3 lists it as owed
 * to Crucible), so that refusal is the submit's `model_not_installed`, by name.
 *
 * Codes: `crucible_<type>_not_offered`, `crucible_<type>_model_not_offered`.
 */
export async function assertCrucibleModelOffered(
  client: { info(): Promise<ServerInfo> },
  server: string,
  jobType: string,
  model: string,
): Promise<void> {
  let capabilities: ServerInfo['capabilities'];
  try {
    ({ capabilities } = await client.info());
  } catch (err) {
    throw describeCrucibleJobRefusal(err, server, 'reading /v1/info');
  }
  const offered = capabilities.find((c) => c.jobType === jobType);
  if (offered === undefined) {
    throw new CrucibleJobRefused(
      `crucible_${jobType}_not_offered`, server,
      `crucible "${server}" does not offer ${jobType} (it offers: `
      + `${capabilities.map((c) => c.jobType).join(', ') || 'nothing'}). Either [jobs] enable_${jobType} `
      + 'is off there or this host\'s backend has no recipe for it (`crucible doctor` on that host says which).',
    );
  }
  // Rows other than llm/tts are descriptors (`JobCapability`); a capability the
  // SDK could not read arrives as `RawCapability` with no `id` on its rows, and
  // that is a protocol disagreement, not "not offered".
  const ids = offered.models.map((row) => (row as { id?: unknown }).id);
  if (!ids.every((id): id is string => typeof id === 'string')) {
    throw new CrucibleJobRefused(
      'crucible_protocol', server,
      `crucible "${server}"'s ${jobType} capability rows carry no string id`
      + `${'unreadable' in offered ? ` (${String((offered as { unreadable: string }).unreadable)})` : ''}.`,
    );
  }
  if (!ids.includes(model)) {
    throw new CrucibleJobRefused(
      `crucible_${jobType}_model_not_offered`, server,
      `crucible "${server}" has no ${jobType} manifest "${model}" (it offers: ${ids.join(', ') || 'none'}).`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────

/** A local file to upload, or bytes already in hand. */
export type CrucibleJobInputSource = string | Uint8Array;

/**
 * What the server said about how far along it is. `warming` lines are the
 * engine's own readiness (a model being loaded for this job) and carry no
 * fraction; `progress` frames carry the SERVER's fraction, never re-derived on
 * this side, plus every other key the job type put on the frame
 * (`ProgressData.extra`: `asr` sends `{stage, processed_s, total_s, cues}`,
 * `align` sends `{stage, processed, total}`).
 */
/**
 * A warming line with the ENGINE LOG TAIL taken off, and the whole thing logged.
 *
 * Owen, 2026-09-18: *"the queue is giving me a lot of logs in the gpu slots. we
 * dont need logs to appear there. move it to the console logs."* What he was
 * reading in a slot was
 *
 *     Loading qwen3.5-9b on crucible@owens-pc-wsl: vllm loading; 6s elapsed,
 *     896s before give-up — === /home/telltale/.crucible/envs/llm/bin/python -m
 *     vllm.entrypoints.openai.api_server --model … --gpu-memory-utilization 0.84 …
 *
 * — a whole spawn command line, in a row that is four inches wide.
 *
 * THE TAIL IS THE ENGINE'S, AND IT IS NOT WRONG TO SEND IT. Crucible's
 * `warming_message` (crucible/engines/base.py) appends `log_tail(1)` after an
 * em dash, which is genuinely what an operator wants when a load is STUCK: the
 * last thing the engine said. Early in a load that last line is the log file's
 * own header, which is the command. So the tail is useful and the slot is the
 * wrong place for it, which is a display decision and belongs here rather than
 * in the engine — the same reasoning that moved the startup dialogs into the
 * renderer.
 *
 * So the slot gets the sentence and the console gets everything. Split on the
 * em dash the engine itself uses; a message without one is passed through
 * whole, because then there is no tail and the sentence is all there is.
 */
export function warmingHeadline(message: string): string {
  const cut = message.indexOf(' — ');
  if (cut < 0) return message;
  // The full line, once per frame, where a developer can read it and a person
  // reading their queue cannot.
  console.log(`[CRUCIBLE] warming: ${message}`);
  return message.slice(0, cut);
}

export type CrucibleJobProgress =
  | {
      readonly kind: 'progress';
      readonly fraction: number;
      readonly message: string;
      readonly extra: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'warming'; readonly message: string };

export interface RunCrucibleJobOptions {
  /** Names an entry in `<userData>/crucible-servers.json`, or the reserved `local`. Never a URL. */
  readonly server: string;
  /** The job type to POST: `asr`, `align`, `rvc`, … */
  readonly type: string;
  /** The Crucible model id. Omit for a job type that serves no models. */
  readonly model?: string;
  /** The job type's own params, verbatim. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Named inputs: `<name on the server>` → a local file path or bytes. Every
   * one is uploaded before the submit and named as a blob. A path that does not
   * exist, or is empty, is refused by name before anything crosses the wire.
   */
  readonly inputs: Readonly<Record<string, CrucibleJobInputSource>>;
  /** `warming` lines and `progress` frames, as they arrive. */
  readonly onProgress?: (progress: CrucibleJobProgress) => void;
  /** Every job event, unchanged — including kinds this SDK does not model (`cue`). */
  readonly onEvent?: (event: JobEvent) => void;
  /** Called once the job exists, with the handle that cancels it. */
  readonly onStarted?: (started: { readonly jobId: string; readonly cancel: () => Promise<void> }) => void;
  /** Free text for the job log. */
  readonly onLog?: (line: string) => void;
  /** Cancels: before the submit, nothing is submitted; after it, the job is DELETEd. */
  readonly signal?: AbortSignal;
  /**
   * A directory to write every artifact into, under its server name, with its
   * provenance sidecar beside it (the SDK's atomic writer). Must exist. Omit to
   * have the artifacts fetched into memory after `done`.
   */
  readonly artifactsTo?: string;
  /**
   * Resume an EXISTING job instead of submitting one: its id, and the last
   * event this caller already acted on. Nothing is uploaded or submitted.
   */
  readonly attachTo?: { readonly jobId: string; readonly lastEventId?: number };
}

export type CrucibleJobArtifacts =
  | {
      readonly where: 'disk';
      readonly dir: string;
      /** By artifact name, e.g. `transcript.json` → its written record. */
      readonly files: ReadonlyMap<string, WrittenArtifact>;
    }
  | {
      readonly where: 'memory';
      /** By artifact name, the bytes, fetched after `done` from its authoritative list. */
      readonly bytes: ReadonlyMap<string, Uint8Array>;
    };

export interface CrucibleJobOutcome {
  readonly jobId: string;
  /** The `done` frame, including the job type's own `extra`. */
  readonly done: DoneData;
  readonly artifacts: CrucibleJobArtifacts;
  /** The highest event id seen, for a later `attachTo`. */
  readonly lastEventId: number;
}

/** How many inputs are uploaded at once. A LAN, not a queue policy. */
const UPLOAD_CONCURRENCY = 4;

/**
 * Run one Crucible job to its end and hand back what it produced.
 *
 * Resolves on `done`, with every artifact landed. Rejects with
 * {@link CrucibleJobRefused} for anything the server or the transport said no
 * to, {@link CrucibleJobFailed} for a job that ran and failed,
 * {@link CrucibleJobCancelled} for one that ended cancelled, and with whatever
 * the SDK threw otherwise, unchanged.
 */
export async function runCrucibleJob(options: RunCrucibleJobOptions): Promise<CrucibleJobOutcome> {
  const { server, type } = options;
  const log = options.onLog ?? (() => undefined);

  if (typeof server !== 'string' || server.trim() === '') {
    throw new CrucibleJobRefused(
      'crucible_server_not_named', String(server),
      'a Crucible job needs the NAME of a registered server (or "local"). It is not a URL and there '
      + 'is no default server.',
    );
  }
  if (typeof type !== 'string' || type.trim() === '') {
    throw new CrucibleJobRefused('crucible_job_type_not_named', server, 'a Crucible job needs a job type.');
  }
  if (options.artifactsTo !== undefined && !fs.existsSync(options.artifactsTo)) {
    // Not created here: a caller's typo would become an empty directory that
    // reads as a job which produced nothing (render-artifacts.ts, same rule).
    throw new CrucibleJobRefused(
      'crucible_artifacts_dir_missing', server,
      `artifacts were to land in ${options.artifactsTo}, which does not exist. The caller creates `
      + 'it; creating it here would turn a typo into an empty directory.',
    );
  }
  if (options.signal?.aborted) {
    throw new CrucibleJobCancelled(server, null, `the ${type} job was cancelled before it was submitted`);
  }

  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  const verb = `the ${type} job`;

  let jobId: string;
  let lastEventId = options.attachTo?.lastEventId ?? 0;
  if (options.attachTo) {
    jobId = options.attachTo.jobId;
    log(`attaching to crucible "${server}" ${type} job ${jobId} after event ${lastEventId}`);
  } else {
    const inputs = await uploadInputs(client, server, type, options, log);
    if (options.signal?.aborted) {
      throw new CrucibleJobCancelled(server, null, `the ${type} job was cancelled before it was submitted`);
    }
    log(`submitting ${verb} to crucible "${server}"`
      + `${options.model === undefined ? '' : ` with model "${options.model}"`}`);
    try {
      jobId = await client.submit({
        type,
        ...(options.model === undefined ? {} : { model: options.model }),
        params: options.params,
        inputs,
      });
    } catch (err) {
      throw describeCrucibleJobRefusal(err, server, verb);
    }
    log(`crucible "${server}" admitted ${verb} as ${jobId}`);
  }

  // CANCELLATION IS A CANCEL, NOT A HANG-UP — see the header.
  let cancelAsked = false;
  const cancel = async (): Promise<void> => {
    if (cancelAsked) return;
    cancelAsked = true;
    log(`cancelling crucible "${server}" job ${jobId}`);
    try {
      const outcome = await client.cancel(jobId);
      log(`crucible "${server}" job ${jobId} is ${outcome.status}`);
    } catch (err) {
      // A job that already ended cannot be cancelled (`job_not_cancellable`),
      // and that is the stream's news to deliver, not this handle's. Anything
      // else is logged: the stream is what decides how this job ended.
      const described = describeCrucibleJobRefusal(err, server, `cancelling job ${jobId}`);
      log(`cancel of crucible "${server}" job ${jobId} was not accepted: `
        + `${described instanceof Error ? described.message : String(described)}`);
    }
  };
  const onAbort = (): void => { void cancel(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  // Submission is asynchronous. An abort while its response was in flight
  // predates this listener, but the admitted job still needs its DELETE.
  if (options.signal?.aborted) onAbort();
  options.onStarted?.({ jobId, cancel });

  let terminal: JobEvent | null = null;
  const files = new Map<string, WrittenArtifact>();
  const seeEvent = (event: JobEvent): void => {
    if (event.id > lastEventId) lastEventId = event.id;
    options.onEvent?.(event);
    if (event.event === 'warming') {
      options.onProgress?.({ kind: 'warming', message: warmingHeadline(event.data.message) });
    } else if (event.event === 'progress') {
      options.onProgress?.({
        kind: 'progress',
        fraction: event.data.fraction,
        message: event.data.message,
        extra: event.data.extra,
      });
    } else if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
      terminal = event;
    }
  };

  const resume = options.attachTo?.lastEventId === undefined ? {} : { lastEventId: options.attachTo.lastEventId };
  try {
    if (options.artifactsTo !== undefined) {
      for await (const write of client.writeArtifactsTo(jobId, options.artifactsTo, resume)) {
        if (write.kind === 'written') {
          files.set(write.written.name, write.written);
          continue;
        }
        seeEvent(write.event);
      }
    } else {
      for await (const event of client.events(jobId, resume)) seeEvent(event);
    }
  } catch (err) {
    throw describeCrucibleJobRefusal(err, server, `${verb}'s events`);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  // Narrowed through a local: TypeScript sees `terminal` assigned only inside a
  // closure and keeps its type at `null` past the loop.
  const ended = terminal as JobEvent | null;
  if (ended === null) {
    // Unreachable by the SDK's contract — its iterator ends only on a terminal
    // event or by throwing. Stated rather than assumed, because the alternative
    // is reading nothing as a finished job.
    throw new CrucibleJobRefused(
      'crucible_protocol', server,
      `the event stream for ${verb} (${jobId}) ended with no terminal event`,
    );
  }
  if (ended.event === 'cancelled') {
    throw new CrucibleJobCancelled(
      server, jobId,
      cancelAsked
        ? `crucible "${server}" job ${jobId} was cancelled at this side's request`
        : `crucible "${server}" job ${jobId} was cancelled on the server`,
    );
  }
  if (ended.event === 'failed') {
    throw new CrucibleJobFailed(server, jobId, ended.data.error.code, ended.data.error.message);
  }
  if (ended.event !== 'done') {
    throw new CrucibleJobRefused(
      'crucible_protocol', server, `${verb} (${jobId}) ended with ${ended.event}, which is not terminal`,
    );
  }
  const done: DoneData = ended.data;

  if (options.artifactsTo !== undefined) {
    log(`crucible "${server}" job ${jobId} done: ${files.size} artifact(s) written into `
      + `${path.basename(options.artifactsTo)}`);
    return { jobId, done, artifacts: { where: 'disk', dir: options.artifactsTo, files }, lastEventId };
  }

  // `done.artifacts` is the authoritative list (a `load-model` done has none
  // and that is a job that wrote nothing, not a protocol error).
  const bytes = new Map<string, Uint8Array>();
  for (const name of done.artifacts ?? []) {
    try {
      bytes.set(name, await client.artifact(jobId, name));
    } catch (err) {
      throw describeCrucibleJobRefusal(err, server, `fetching artifact ${name} of ${verb}`);
    }
  }
  log(`crucible "${server}" job ${jobId} done: ${bytes.size} artifact(s) fetched`);
  return { jobId, done, artifacts: { where: 'memory', bytes }, lastEventId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Uploads
// ─────────────────────────────────────────────────────────────────────────────

/** `fs.openAsBlob` typed as the optional it is on older runtimes. */
const openAsBlob: ((p: string) => Promise<Blob>) | undefined =
  (fs as unknown as { openAsBlob?: (p: string) => Promise<Blob> }).openAsBlob;

async function uploadInputs(
  client: CrucibleClient,
  server: string,
  type: string,
  options: RunCrucibleJobOptions,
  log: (line: string) => void,
): Promise<Record<string, JobInput>> {
  const entries = Object.entries(options.inputs);
  const out: Record<string, JobInput> = {};
  if (entries.length === 0) return out;

  // Every input is checked BEFORE the first byte crosses: a missing chunk file
  // found at upload 1,213 of 1,400 has cost twelve hundred uploads for nothing.
  for (const [name, source] of entries) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new CrucibleJobRefused('crucible_input_unnamed', server, 'an input has no name');
    }
    if (typeof source === 'string') {
      if (!fs.existsSync(source)) {
        throw new CrucibleJobRefused(
          'crucible_input_missing', server, `input "${name}" names ${source}, which does not exist`,
        );
      }
      if (fs.statSync(source).size === 0) {
        throw new CrucibleJobRefused(
          'crucible_input_empty', server,
          `input "${name}" names ${source}, which is empty. An empty file is not a file to `
          + 'transcribe or align; it is a producer that wrote nothing.',
        );
      }
      if (openAsBlob === undefined) {
        throw new CrucibleJobRefused(
          'crucible_runtime_too_old', server,
          `uploading ${source} needs fs.openAsBlob (Node 19.8+), which this runtime `
          + `(${process.versions.node}) does not have. Reading a whole audiobook into the heap `
          + 'instead is not done here.',
        );
      }
    } else if (!(source instanceof Uint8Array)) {
      throw new CrucibleJobRefused(
        'crucible_input_unreadable', server,
        `input "${name}" is neither a path nor bytes (${typeof source})`,
      );
    } else if (source.length === 0) {
      throw new CrucibleJobRefused('crucible_input_empty', server, `input "${name}" is zero bytes`);
    }
  }

  log(`uploading ${entries.length} input(s) for the ${type} job to crucible "${server}"`);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      if (options.signal?.aborted) return;
      const [name, source] = entries[next++];
      const data: Uint8Array | Blob = typeof source === 'string'
        ? await (openAsBlob as (p: string) => Promise<Blob>)(source)
        : source;
      let blobId: string;
      try {
        ({ blobId } = await client.upload(data, { filename: name }));
      } catch (err) {
        throw describeCrucibleJobRefusal(err, server, `uploading input "${name}"`);
      }
      out[name] = { blobId };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, () => worker()),
  );
  return out;
}
