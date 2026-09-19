/**
 * THE GENERATION STEP, RUN ON SOMEBODY ELSE'S CARD.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `electron/parallel-tts-bridge.ts` renders a book by spawning narrator — in
 * WSL for Orpheus and Higgs, natively elsewhere — and reading `<index>.flac`
 * out of the session's sentences directory afterwards. A Crucible `tts` job
 * renders the same chunks on a server (docs/CRUCIBLE_ROLLOUT_PLAN.md item 2.4,
 * crucible `docs/PHASE6-REMOTE-RENDER.md` section 6) and hands back the same
 * files over HTTP. This module is the swap: **one submit, one event stream, one
 * download, and the same directory afterwards.**
 *
 * It replaces the GENERATION step and nothing else. Prep runs before it exactly
 * as it does today, and `normalizeWslSessionToWindows`, the coverage audit, the
 * RVC pass, the denoise pass and assembly run after it exactly as they do
 * today — they read `<index>.flac` out of `prepInfo.chaptersDirSentences` and
 * cannot tell which machine wrote them. That is the whole design: the bytes
 * move, the shape does not.
 *
 * ── NO LEASE, FOR THE REASON `job.ts` SPELLS OUT ───────────────────────────
 *
 * A render is ONE `tts` job on the lane, so it already holds everything a lease
 * would hold — and `tts` is in crucible's `EVICTS_THE_RESIDENT_MODEL`, so a lease
 * taken around one would have the server refuse `409 leased` to the very
 * run that took it (a lease has no exemption for its own holder). The doors that
 * lease are the chat-shaped ones — the four text acts, a cleanup run, a page
 * read; see `electron/crucible/lease.ts`.
 *
 * ── What is NOT here, deliberately ─────────────────────────────────────────
 *
 * **No fallback to the local spawn, ever.** A Crucible server that is busy,
 * that has the type disabled, or that does not have the voice is a REFUSAL
 * with a name, and it fails the job carrying that name. Quietly rendering the
 * book on the local card instead would take the GPU somebody else is using,
 * produce audio from a different checkpoint than the operator asked for, and
 * report success. Every refusal below is surfaced verbatim, once, and never
 * retried in a loop — `crucible/docs/ARCHITECTURE.md` R5: queues belong to
 * clients, and the client here is the app's own queue, not a `while` loop.
 *
 * **No judgment about a chunk.** The guard and the retake decision belong to
 * the model and its inference (Owen, 2026-09-13). Every `chunk` event's verdict
 * goes into `electron/chunk-guard-ledger.ts` with source `crucible-chunk` and
 * nothing here reads inside it.
 *
 * **No pace state.** PHASE6 section 4 designs a `pace` object that round-trips
 * through the client so chapter two's guard starts centred where chapter one
 * finished. It is **not built on either side** — narrator's `generate_batch`
 * accepts no pace and Crucible's `TtsParams` refuses unknown keys — so nothing
 * here sends one. A stub would silently drop the state and make a 40-chapter
 * book guard worse than a 1-chapter one, with nothing failing.
 *
 * This door sidesteps that for now by submitting the WHOLE BOOK as one job, so
 * the guard warms once and stays warm for the run — which is also what gives
 * the server a real denominator. PHASE6 assumed a job would be a chapter; it
 * does not have to be, and until `pace` exists a chapter-per-job render would
 * be measurably worse than this one.
 */

import * as fsSync from 'fs';
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
import type { RenderChunk, RenderResult } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import { downloadRenderArtifacts } from './render-artifacts';
import { crucibleVoiceBand, describeVenueBand, refuseChunksOverVenueCap } from './voice-band';
import type { ChunkGuardSummary } from '../chunk-guard-ledger';

/**
 * The name that lands in the `User-Agent`, so a shared server's log says which
 * app queued the job — and, when a second client is refused `server_busy`, who
 * `CrucibleBusy.holder` names. One app, one name, declared once in servers.ts.
 */
const CLIENT_NAME = CRUCIBLE_CLIENT_NAME;

/**
 * The rung of the voice's take ladder a BookForge render asks for.
 *
 * **Zero, always, and it is not a default that stands in for a decision.**
 * PHASE6-REMOTE-RENDER.md section 1 removed `take` from the client's business
 * entirely: the ladder's steps are engine config now, the engine climbs them
 * itself, and one request is one ACCEPTED chunk with its take history attached.
 * The field survives on the wire and the SDK requires it, so this is the value
 * that means "the engine's own sampling, which is what asking for nothing
 * gets" — and Crucible refuses anything else on a voice whose manifest declares
 * no deviating rung anyway.
 */
export const CRUCIBLE_RENDER_TAKE = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Voice identity: the app's catalog id → Crucible's voice id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE MAP, WRITTEN DOWN, BECAUSE THE TWO CATALOGS ARE TWO CATALOGS.
 *
 * BookForge names its voices in `electron/data/higgs-models.json`
 * (`deathstalker`, `mistborn`, `owen`, `thirdreich`, `sigma`, `default`, and
 * four `zeroshot-*`). Crucible names its own in `crucible/voices/*.toml`
 * (`deathstalker`, `mistborn`, `owen`, `sigma`, `thirdreich`, `zeroshot`,
 * `higgs-default`). Five ids coincide and two do not, and a coincidence is not
 * an identity: a server is entitled to rename a voice, and the day it does, a
 * `voiceId` passed straight through would render the wrong speaker rather than
 * refuse.
 *
 * So the correspondence is DECLARED here rather than assumed, and a voice with
 * no entry is refused by name. That is the same discipline
 * `electron/higgs-models.ts` applies to a voice it cannot resolve: "a whole book
 * in the base model's speaker is the failure this catalog exists to prevent".
 *
 * R1 note (crucible `docs/ARCHITECTURE.md`): this table is a SECOND copy of a
 * fact whose owner is the pair of catalogs, so it is CHECKED rather than
 * trusted — `assertCrucibleVoiceAvailable` reads `GET /v1/voices` and refuses
 * an id the server does not advertise, naming what it does. The table decides
 * WHICH id to ask for; the server decides whether it exists.
 */
export const CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE: Readonly<Record<string, string>> = {
  // The five merged Higgs v3 fine-tunes, same word both sides.
  deathstalker: 'deathstalker',
  mistborn: 'mistborn',
  owen: 'owen',
  sigma: 'sigma',
  thirdreich: 'thirdreich',
  // The base model with no reference. BookForge calls it `default` because it is
  // the catalog's default row; Crucible calls it `higgs-default` because on a
  // server "default" would have to mean something about the server.
  default: 'higgs-default',
};

/** A voice, an engine or a server this render cannot use, named. */
export class CrucibleRenderRefused extends Error {
  /** The refusal's own name, for a caller that acts on it. */
  readonly code: string;
  /**
   * The SDK's own "GPU busy: foundry, tts 62% done" — present exactly on the
   * refusals a row can WAIT out, absent on every other one.
   *
   * TWO of them, and the second was added on 2026-09-18: `server_busy`, where
   * the LANE is taken and frees in minutes, and `leased`, where a client has
   * said it is mid-run on what is on the card and may hold it for an hour.
   * Different clocks, one question — what is in the way, and whose is it — so
   * one field and one road.
   *
   * Carried beside the prose rather than dug back out of it, because a caller
   * that can WAIT needs a different sentence from the one below: the queue
   * holds the row and retries, and telling its operator to "queue it again
   * when that one is done" would be advice about a thing the queue is already
   * doing (the queue's `busyLineOf` seam, crucible `docs/ARCHITECTURE.md` §3 —
   * a 409 is a wait, not a failure). Added for that consumer, 2026-09-13.
   */
  readonly busyLine?: string;

  constructor(code: string, message: string, busyLine?: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleRenderRefused';
    this.code = code;
    if (busyLine !== undefined) this.busyLine = busyLine;
  }
}

/**
 * Which Crucible voice renders this job's voice, or a refusal that says why
 * none does.
 *
 * Three refusals, each for a different reason and each fixable by a different
 * action:
 *
 *  - `crucible_engine_unsupported` — the job is an Orpheus render. Every
 *    voice in `crucible/voices/` declares `narrator_engine = "higgs-v3"`;
 *    the Orpheus arm exists in narrator and has no manifest on a Crucible,
 *    and Orpheus is deprecated (Owen, 2026-09-14) rather than coming.
 *  - `crucible_voice_is_an_override` — the job renders an UNCERTIFIED local
 *    checkpoint (`higgsModelForRender` derives the id `<base>+<slug>` from
 *    `settings.higgsOverride`). Those weights are a directory on this machine;
 *    a Crucible pulls a published artifact at a pinned revision and has no way
 *    to be handed one. Publish it and add a manifest, or render it locally.
 *  - `crucible_voice_unmapped` — anything else, including the four
 *    `zeroshot-*` rows. **RULING OWED:** Crucible's `zeroshot` voice is
 *    `clips = "from-request"`, meaning a job naming it must carry the reference
 *    wav in `inputs` — and `CrucibleClient.render()` sends `inputs: {}` and the
 *    render door refuses a zero-shot voice outright (`voice_kind_unsupported`,
 *    `crucible/jobs/tts/render.py:289`), so there is no door to put a clip
 *    through today. Mapping `zeroshot-deathstalker` onto `zeroshot` would
 *    therefore be a refusal one round trip later with a worse message, and
 *    mapping it onto `deathstalker` would silently render the FINE-TUNE where a
 *    zero-shot clone was asked for — two different speakers. Refused here until
 *    Owen rules on which he wants (upload the clip, or say zero-shot is
 *    local-only).
 */
export function crucibleVoiceFor(ttsEngine: string | undefined, voiceId: string | undefined): string {
  const engine = (ttsEngine ?? '').trim().toLowerCase();
  if (engine !== 'higgs') {
    throw new CrucibleRenderRefused(
      'crucible_engine_unsupported',
      `a Crucible render was asked for with ttsEngine ${JSON.stringify(ttsEngine ?? null)}. `
      + 'Every voice a Crucible serves declares narrator_engine "higgs-v3" (crucible/voices/*.toml); '
      + 'the Orpheus arm exists only in a locally spawned narrator. Render this book '
      + 'locally, or select a Higgs voice.',
    );
  }
  const id = (voiceId ?? '').trim();
  if (id === '') {
    throw new CrucibleRenderRefused(
      'crucible_voice_not_named',
      'a Crucible render needs the voice the job selected (settings.fineTuned, resolved through '
      + 'higgsModelForJob). There is no default voice — a book rendered in a voice nobody chose '
      + 'is a book nobody asked for.',
    );
  }
  if (id.includes('+')) {
    throw new CrucibleRenderRefused(
      'crucible_voice_is_an_override',
      `"${id}" is a render override — higgsModelForRender derives "<voice>+<checkpoint>" when a run `
      + 'points at a checkpoint directory under test. Those weights live on this machine; a Crucible '
      + 'serves published artifacts at a pinned revision and has no way to be handed a local '
      + 'directory. Render the override locally, or publish the merge and give it a manifest.',
    );
  }
  const mapped = CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE[id];
  if (mapped === undefined) {
    const known = Object.keys(CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE).join(', ');
    throw new CrucibleRenderRefused(
      'crucible_voice_unmapped',
      `BookForge voice "${id}" has no Crucible voice. Mapped: ${known}. A zero-shot voice `
      + '(zeroshot-*) is deliberately not mapped: Crucible\'s `zeroshot` voice takes its reference '
      + 'clip from the job\'s inputs, the render door has no channel for one, and mapping it onto '
      + 'the same-named fine-tune would render a DIFFERENT SPEAKER. Render it locally.',
    );
  }
  return mapped;
}

/**
 * The fields of one `GET /v1/voices` row the doors in this module read.
 *
 * Structural rather than the SDK's `VoiceInfo`, for `voice-band.ts`'s reason:
 * a keeper can build one without importing the SDK, and a consumer can take it
 * without one either. Every field here is required on the wire — `takes`
 * included, which the SDK reads with `num(entry, 'takes')` and refuses the whole
 * document without — so nothing below ever has a shape to default.
 */
export interface CrucibleVoiceRow {
  readonly id: string;
  readonly installed: boolean;
  readonly loadable: boolean;
  readonly reason: string | null;
  /**
   * How many rungs this voice's take ladder has: the valid `take` values are
   * `0 .. takes - 1`, and the SDK's own words are "ask before you submit" —
   * a take past the end is refused `unknown_take` and NEVER clamped.
   */
  readonly takes: number;
}

/**
 * The CHECK half of the table above: does this server actually serve that id,
 * and can it load it?
 *
 * One `GET /v1/voices` per book, before a single chunk is sent — the same shape
 * and the same reason as `ai-bridge.ts`'s once-per-job residency check: at job
 * start it turns "the 47th chunk failed" into "this job cannot run". The render
 * door would refuse an unknown voice at submit anyway; what this adds is the
 * server's own row in the message (`installed`, `loadable`, and its `reason`),
 * which is the difference between "pull the weights on that host" and "the card
 * is busy" — two refusals that read identically as `unknown_model`.
 *
 * It does NOT require the voice to be RESIDENT. A render job owns the exclusive
 * lane for its whole duration and loads its own voice if it has to; that is the
 * one deliberate asymmetry with `llm`, where a chat never loads.
 *
 * `runCrucibleRender` itself no longer calls this: it needs the SAME row for the
 * cap (`voice-band.ts`), so it reads the row once and asserts both halves off it.
 * This entry point stays for the callers that only ask the question — the retake
 * door (`reroll.ts`) and the keepers.
 *
 * **It HANDS BACK the row it judged**, for the same reason `crucibleVoiceBand`
 * does: the row carries more than the two booleans checked here, and the retake
 * door needs one of them — `takes`, the length of this voice's take ladder,
 * which is what a caller spreading N candidates across the rungs must know
 * before it submits. One `GET /v1/voices` answers both questions. A second call
 * to ask how long the ladder is would be a second copy of one fact, which is
 * the shape crucible's `docs/ARCHITECTURE.md` R1 is about.
 */
export async function assertCrucibleVoiceAvailable(
  client: { voices(): Promise<readonly CrucibleVoiceRow[]> },
  server: string,
  voice: string,
): Promise<CrucibleVoiceRow> {
  let rows: readonly CrucibleVoiceRow[];
  try {
    rows = await client.voices();
  } catch (err) {
    throw describeCrucibleRefusal(err, server);
  }
  const row = rows.find((v) => v.id === voice);
  if (!row) {
    const known = rows.map((v) => v.id).join(', ');
    throw new CrucibleRenderRefused(
      'crucible_unknown_voice',
      `crucible "${server}" has no voice "${voice}" `
      + `(${rows.length === 0 ? 'it advertises none' : `known: ${known}`}). BookForge's catalog and `
      + 'the server\'s are two catalogs; see CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE.',
    );
  }
  assertVoiceRowLoadable(row, server, voice);
  return row;
}

/**
 * The `loadable` half of the row, refused by name.
 *
 * Its own function because the row is now fetched by two callers — this
 * module's `assertCrucibleVoiceAvailable` and `voice-band.ts`'s
 * `crucibleVoiceBand`, which reads the SAME single `GET /v1/voices` for the
 * cap — and "can this server load it" must mean one thing with one message.
 */
export function assertVoiceRowLoadable(
  row: { installed: boolean; loadable: boolean; reason: string | null },
  server: string,
  voice: string,
): void {
  if (row.loadable) return;
  throw new CrucibleRenderRefused(
    row.installed ? 'crucible_voice_not_loadable' : 'crucible_voice_not_installed',
    `crucible "${server}" cannot load voice "${voice}": ${row.reason ?? 'it did not say why'}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The refusal vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SDK's error types, turned into one sentence a person can act on, with the
 * server's own code kept in front so a caller can still match on it.
 *
 * Deliberately its own function rather than a call into `ai-bridge.ts`'s
 * `translateCrucibleError`. That one exists to make a Crucible failure look
 * like an OpenAI failure to the cleanup pass's retry machinery — it maps
 * `CrucibleUnreachable` onto the word "network" precisely so the chunk is
 * RETRIED. A render must not be retried anywhere: the job is hours long, the
 * lane is exclusive, and a second submit while the first is still admitted is
 * how two renders end up writing one directory. Same SDK, opposite policy, so
 * two readers rather than one with a flag.
 *
 * `CrucibleBusy` and `CrucibleLeased` are the two that carry structure worth
 * printing, and both fill `busyLine` — the SDK's own "GPU busy: foundry, tts
 * 62% done" / "leased: foundry, translate, until …", built from the holder the
 * server named. The holder is `null` when the holding job or lease arrived
 * without a User-Agent, and the SDK refuses to invent a name there — so does
 * this.
 *
 * ORDER MATTERS in the table below: `CrucibleLeased` is a subclass of
 * `CrucibleRefused`, so it has to be asked about before the generic arm or it
 * loses the holder's line and the row fails where it should have parked.
 */
export function describeCrucibleRefusal(err: unknown, server: string): CrucibleRenderRefused | unknown {
  const at = `crucible "${server}"`;
  if (err instanceof CrucibleBusy) {
    return new CrucibleRenderRefused(
      err.code,
      `${at} takes one job at a time and is already running one. ${err.busyLine}`
      + ` (job ${err.jobId}, ${err.jobStatus} since ${err.since}`
      + `${err.jobMessage === null ? '' : `; latest: ${err.jobMessage}`}). `
      + 'Nothing here waits for it or renders this book somewhere else — queue it again when that '
      + 'one is done, or pick another server.',
      err.busyLine,
    );
  }
  /*
   * A LEASED CARD IS A WAIT, AND IT IS ASKED ABOUT BEFORE `CrucibleRefused`.
   *
   * `CrucibleLeased` is a subclass of {@link CrucibleRefused} and NOT of
   * {@link CrucibleBusy} (crucible `sdk/ts/src/errors.ts`), so until
   * 2026-09-18 it fell straight into the generic arm below: the sentence lost
   * the holder, no `busyLine` was carried, and `settleStep` — which parks a
   * row only when one is present — failed it. The row went red and waited for
   * somebody to press Retry, while Foundry, on the identical refusal, parked
   * with the holder's name and came back on its own. One refusal, two
   * clients, opposite answers: Foundry waited out BookForge's narrations and
   * BookForge died on Foundry's translations.
   *
   * It is the same question `server_busy` asks with a longer clock — a lane
   * frees in minutes, a lease may hold for an hour — so it takes the same road
   * (`leasedLine` → `busyLine` → the step's throw → `settleStep`). What it is
   * NOT is a retry
   * here: the queue holds the row and the ordinary admission tick asks again.
   */
  if (err instanceof CrucibleLeased) {
    return new CrucibleRenderRefused(
      err.code,
      `${at} has its resident ${err.kind} held by another client's run, and a render would take `
      + `it off the card. ${err.leasedLine} (lease ${err.leaseId}, since ${err.since}). Nothing `
      + 'here waits it out or renders this book somewhere else — the queue holds the row and '
      + 'tries again, or pick another server.',
      err.leasedLine,
    );
  }
  if (err instanceof CrucibleRefused) {
    return new CrucibleRenderRefused(
      err.code,
      `${at} refused this render (HTTP ${err.status}): ${err.serverMessage}`,
    );
  }
  if (err instanceof CrucibleAuthError) {
    return new CrucibleRenderRefused(
      err.code,
      `${at} refused the token: ${err.serverMessage}. Re-add the server with the token `
      + '`crucible token --show` prints on that host.',
    );
  }
  if (err instanceof CrucibleVersionError) {
    return new CrucibleRenderRefused(
      err.code,
      `${at} speaks API version ${err.serverApiVersion}, this client speaks ${err.clientApiVersion}: `
      + `${err.serverMessage}. One of the two must be updated.`,
    );
  }
  if (err instanceof CrucibleServerError) {
    return new CrucibleRenderRefused(
      err.code,
      `${at} failed this render (HTTP ${err.status}): ${err.serverMessage}. The server broke; its own `
      + 'log says why.',
    );
  }
  if (err instanceof CrucibleUnreachable) {
    return new CrucibleRenderRefused(
      'crucible_unreachable',
      `${at} could not be reached: ${err.message}. A render is not retried here — start the server `
      + 'and queue the book again, or pick another one.',
    );
  }
  if (err instanceof CrucibleNotACrucible) {
    return new CrucibleRenderRefused(
      'crucible_not_a_crucible',
      `${at} answered /v1/ping but is not a crucible: ${err.body}. Check the url.`,
    );
  }
  if (err instanceof CrucibleProtocolError) {
    return new CrucibleRenderRefused(
      'crucible_protocol',
      `${at} sent something API v1 does not describe: ${err.detail}. The server and this client `
      + 'disagree about the protocol.',
    );
  }
  if (err instanceof CrucibleConfigError) {
    return new CrucibleRenderRefused(
      'crucible_client_misconfigured',
      `${at}: this client was built wrong — ${err.message}`,
    );
  }
  // Not one of the SDK's types. Returned UNCHANGED, with its stack, because an
  // unexpected exception is not a refusal and dressing it as one loses where it
  // came from.
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// The render
// ─────────────────────────────────────────────────────────────────────────────

/** What the server said about how far along it is, as the caller sees it. */
export interface CrucibleRenderProgress {
  /** The SERVER's own fraction, 0..1. Never re-derived on this side. */
  readonly fraction: number;
  /** The server's own progress line. */
  readonly message: string;
  /** `rendered` / `failed` / `total` off the `tts` job's progress frame, when it sent them. */
  readonly rendered: number | null;
  readonly failed: number | null;
  readonly total: number | null;
  /** How many `<index>.flac` have landed in `sentencesDir` so far, counted here. */
  readonly downloaded: number;
}

export interface RunCrucibleRenderOptions {
  /** Names an entry in `<userData>/crucible-servers.json`. `local` once 2.1 lands. */
  readonly server: string;
  /**
   * BookForge's OWN id for this render — `session.jobId`. Keys the guard ledger,
   * so a book rendered half locally and half remotely lands in ONE summary.
   */
  readonly renderId: string;
  /** The Crucible voice id, from {@link crucibleVoiceFor}. */
  readonly voice: string;
  /** The manifest's language tag for this text, e.g. `en`. Never guessed. */
  readonly language: string;
  /**
   * EVERY chunk this render must produce, up front.
   *
   * All of them in one job on purpose: the server then has a denominator and
   * reports a real percentage, the whole book shares one exclusive lane instead
   * of racing other clients for it between chapters, and narrator's own batch
   * scheduler sees the whole list (`crucible/jobs/tts/render.py`: "cutting the
   * list up here would be Crucible second-guessing a read-ahead window it
   * cannot see"). A resume passes only the chunks that are still missing — that
   * is a smaller book, not a smaller batch.
   */
  readonly chunks: readonly RenderChunk[];
  /** `prepInfo.chaptersDirSentences`. Must already exist — prep makes it. */
  readonly sentencesDir: string;
  /**
   * Resume an EXISTING Crucible job instead of submitting a new one: its id and
   * the last event this caller already acted on. The server replays above that
   * id and no further.
   */
  readonly attachTo?: { readonly jobId: string; readonly lastEventId?: number };
  /** Called once the job exists, with the handle that cancels it. */
  readonly onStarted?: (started: { readonly jobId: string; readonly cancel: () => Promise<void> }) => void;
  /** Every progress frame, with the server's fraction. */
  readonly onProgress?: (progress: CrucibleRenderProgress) => void;
  /** One call per `<index>.flac` that lands on this disk, with its chunk index. */
  readonly onChunkWritten?: (index: number, file: string) => void;
  /** Free-text for the job log. */
  readonly onLog?: (message: string) => void;
}

export interface CrucibleRenderOutcome {
  readonly jobId: string;
  /** How many `<index>.flac` this call wrote. */
  readonly written: number;
  /** The job's terminal news, INCLUDING the authoritative `failed` list. */
  readonly result: RenderResult;
  /** What the engine's guard decided about this render's chunks. */
  readonly guard: ChunkGuardSummary;
  /** The highest event id seen, for a later `attachTo`. */
  readonly lastEventId: number;
}

/**
 * Ask a Crucible to render these chunks, and put the audio where a local render
 * would have put it.
 *
 * Resolves when the sentences directory is complete — the downloader's iterator
 * ends only after the terminal event AND after every outstanding write has
 * landed. Rejects with a {@link CrucibleRenderRefused} for anything the server
 * said no to, and with whatever the downloader threw otherwise.
 *
 * **A failed chunk is not a failed render.** One bad sentence never sinks the
 * other 1,399 (PHASE3-TTS.md section 6): the indices with no audio are in
 * `outcome.result.failed`, they have no file, and BookForge's coverage audit
 * and resume already know what to do about a file that is not there. That is
 * Owen's 2026-09-05 ruling — the audit reports, it does not block — and
 * throwing here would be this module overruling it.
 */
export async function runCrucibleRender(
  options: RunCrucibleRenderOptions,
): Promise<CrucibleRenderOutcome> {
  const { server, renderId, voice, language, sentencesDir } = options;

  // Every refusal below is by name and none has a default. A silently
  // substituted anything here is a book rendered wrong on a machine nobody is
  // watching.
  if (typeof server !== 'string' || server.trim() === '') {
    throw new CrucibleRenderRefused(
      'crucible_server_not_named',
      'a Crucible render needs the NAME of a registered server (bookforge-tts --crucible-list). '
      + 'It is not a URL and there is no default server.',
    );
  }
  if (typeof renderId !== 'string' || renderId === '') {
    throw new CrucibleRenderRefused(
      'crucible_render_not_identified',
      'a Crucible render needs BookForge\'s own job id: it keys the guard ledger, and an empty one '
      + 'would pool every book\'s chunks into a single summary.',
    );
  }
  if (typeof voice !== 'string' || voice === '') {
    throw new CrucibleRenderRefused(
      'crucible_voice_not_named',
      'a Crucible render needs a voice id — see crucibleVoiceFor.',
    );
  }
  if (typeof language !== 'string' || language.trim() === '') {
    throw new CrucibleRenderRefused(
      'crucible_language_not_named',
      'a Crucible render needs the language tag of this text. The server refuses a missing one '
      + 'rather than picking, and a book rendered in the wrong language is a silent substitution.',
    );
  }
  if (typeof sentencesDir !== 'string' || sentencesDir === '' || !fsSync.existsSync(sentencesDir)) {
    throw new CrucibleRenderRefused(
      'crucible_sentences_dir_missing',
      `a Crucible render writes its audio where a local render writes its audio, and `
      + `${JSON.stringify(sentencesDir)} is not a directory that exists. Prep creates it; creating `
      + 'it here would turn a typo into an empty directory that reads as a render which produced '
      + 'nothing.',
    );
  }
  if (!Array.isArray(options.chunks) || options.chunks.length === 0) {
    throw new CrucibleRenderRefused(
      'crucible_no_chunks',
      'a Crucible render was asked for with no chunks. An empty batch is not an empty book — it is '
      + 'a caller that computed the wrong set, and submitting it would produce a job that finishes '
      + 'instantly having written nothing.',
    );
  }

  const log = options.onLog ?? (() => undefined);
  const client = await crucibleClientFor(server, CLIENT_NAME);

  let jobId: string;
  let lastEventId = options.attachTo?.lastEventId ?? 0;
  if (options.attachTo) {
    jobId = options.attachTo.jobId;
    log(`attaching to crucible "${server}" job ${jobId} after event ${lastEventId}`);
  } else {
    // Before the whole book crosses the wire: does this server have this voice,
    // can it load it, and does every chunk fit the cap IT states. One GET, and
    // every refusal carries the server's own row.
    //
    // THE CAP IS READ FROM THE SERVER AND NEVER FROM THE LOCAL CATALOG (see
    // voice-band.ts's header): the two disagree today, and the server is the one
    // that refuses. Asked here, `chunk_too_long` arrives as a local refusal
    // naming the chunk and what packed it, rather than as an HTTP 400 after the
    // whole book has been serialised onto the wire.
    const { row, band } = await crucibleVoiceBand(client, server, voice);
    assertVoiceRowLoadable(row, server, voice);
    log(describeVenueBand(band));
    refuseChunksOverVenueCap(band, options.chunks);
    log(`submitting ${options.chunks.length} chunk(s) to crucible "${server}" as voice "${voice}"`);
    try {
      jobId = await client.render({
        voice,
        language,
        take: CRUCIBLE_RENDER_TAKE,
        chunks: options.chunks,
      });
    } catch (err) {
      throw describeCrucibleRefusal(err, server);
    }
    log(`crucible "${server}" admitted the render as job ${jobId}`);
  }

  // CANCELLATION IS A CANCEL, NOT A HANG-UP — AND IT IS NOT OVER ON THE 200.
  //
  // Abandoning the event stream would leave the job RUNNING on the server —
  // holding the exclusive lane, holding the card, for the rest of the book. So
  // the handle calls `DELETE /v1/jobs/{id}`, and then lets the stream run on to
  // the `cancelled` event it will now receive, which is what turns this into a
  // reported cancellation rather than a silence. The chunks already downloaded
  // stay on disk (ARCHITECTURE.md R6: partial work survives failure, always).
  // That much is `crucible/job.ts`'s generic door, and this is the same
  // handshake for `tts`.
  //
  // WHAT IT ALSO WAITS FOR, SINCE 2026-09-18. `client.cancel()` is one HTTP
  // DELETE and the server answers it `cancelling` in milliseconds — the engine
  // is still mid-chunk. A handle that resolved there was telling its caller the
  // far end had stopped when it had not: `stopParallelConversion` awaits this
  // precisely so the cache flush cannot race a render still being written, and
  // it then deleted the session, freed the GPU slot and flushed a sentences
  // directory the downloader was still landing `<index>.flac` into (measured:
  // one more chunk typically). So the handle resolves only once the stream this
  // call is ALREADY reading has reached the job's terminal frame — `cancelled`,
  // or `done`/`failed` where the job beat the cancel — and the downloader has
  // stopped with it. The SDK's writer ends its iterator only after that frame
  // AND after every outstanding write has landed, so when this resolves the
  // directory has stopped changing, which is the thing the caller was told.
  //
  // IT IS THEREFORE AS SLOW AS THE ENGINE IS, and it has no clock of its own: a
  // chunk in flight is finished first, and a server that will not stop at all
  // (measured 2026-09-15: a DELETE recorded as `cancelling` that nothing acts
  // on) is a wait with no end. A caller that cannot afford one puts its own
  // bound on this handle rather than having one invented here — the quit path
  // does exactly that (`parallel-tts-bridge.cancelRemoteRenderOnQuit`), because
  // quitting must not depend on another machine and stopping must not lie.
  let cancelled = false;
  /**
   * Resolved when the downloader below has ended, whether on the job's terminal
   * frame or by throwing. Held here rather than awaited on the render's own
   * promise because the two have different callers: the render's rejects with
   * the cancellation, and this one only says that nothing more will be written.
   */
  let downloaderStopped!: () => void;
  const downloaderHasStopped = new Promise<void>((resolve) => { downloaderStopped = resolve; });
  const cancel = async (): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    log(`cancelling crucible "${server}" job ${jobId}`);
    const outcome = await client.cancel(jobId);
    log(`crucible "${server}" job ${jobId} is ${outcome.status}; waiting for it to stop writing`);
    await downloaderHasStopped;
    log(`crucible "${server}" job ${jobId} has stopped: ${path.basename(sentencesDir)} is settled`);
  };
  options.onStarted?.({ jobId, cancel });

  let downloaded = 0;
  const outcome = await downloadRenderArtifacts({
    client,
    server,
    jobId,
    renderId,
    sentencesDir,
    ...(options.attachTo?.lastEventId === undefined ? {} : { lastEventId: options.attachTo.lastEventId }),
    onWritten: (written) => {
      downloaded += 1;
      // `<index>.flac` is the artifact's whole name; the sidecar is
      // `<index>.flac.provenance.json` and is never announced as an artifact.
      // A name this does not recognise is reported rather than counted — the
      // caller's tally is per CHUNK, and guessing an index would move a
      // progress bar for a file that is not a chunk.
      const m = /^(\d+)\.flac$/.exec(written.name);
      if (m) {
        options.onChunkWritten?.(parseInt(m[1], 10), written.path);
      } else {
        log(`crucible job ${jobId} wrote ${written.name}, which is not an <index>.flac`);
      }
    },
    onEvent: (event) => {
      if (event.id > lastEventId) lastEventId = event.id;
      if (event.event === 'warming') {
        log(`crucible "${server}": ${event.data.message}`);
        return;
      }
      if (event.event !== 'progress') return;
      const extra = event.data.extra;
      options.onProgress?.({
        fraction: event.data.fraction,
        message: event.data.message,
        rendered: typeof extra['rendered'] === 'number' ? extra['rendered'] : null,
        failed: typeof extra['failed'] === 'number' ? extra['failed'] : null,
        total: typeof extra['total'] === 'number' ? extra['total'] : null,
        downloaded,
      });
    },
  }).finally(() => {
    // THE DIRECTORY HAS STOPPED CHANGING, and `cancel()` above is what waits
    // for it. In the `finally` and not in the success arm because a stream that
    // threw has also stopped writing, and a cancel left waiting on a failed
    // download would hang the Stop button on a server that had gone away.
    downloaderStopped();
  }).catch((err) => {
    // A refusal that arrives mid-stream (the token rotated, the server
    // restarted) is named the same way one at submit is.
    throw describeCrucibleRefusal(err, server);
  });

  if (outcome.result.failed.length > 0) {
    log(`crucible job ${jobId}: ${outcome.result.failed.length} chunk(s) produced no audio — `
      + outcome.result.failed.slice(0, 8).map((f) => `${f.index}: ${f.message}`).join('; '));
  }
  log(`crucible job ${jobId} done: ${outcome.result.rendered} rendered, ${outcome.written} file(s) `
    + `written into ${path.basename(sentencesDir)}`);

  return {
    jobId,
    written: outcome.written,
    result: outcome.result,
    guard: outcome.guard,
    lastEventId,
  };
}
