/**
 * THE LISTEN PATH, ON SOMEBODY ELSE'S CARD — a Crucible streaming session behind
 * the interface `stream-scheduler.ts` already drives.
 *
 * ── The one seam ───────────────────────────────────────────────────────────
 *
 * Three surfaces stream audio: the in-app Play tab, the browser extension (and
 * LAN clients) through `electron/tts-api-server.ts` on ws :8766, and the
 * Bookshelf Reader through `electron/reader-stream-bridge.ts` riding :8765.
 * All three speak one protocol to ONE scheduler (`electron/stream-scheduler.ts`),
 * and the scheduler — plus the surfaces' own engine-lifecycle calls — drives one
 * interface: `StreamingEngine` in `electron/streaming-engine.ts`, reached through
 * `getActiveEngine()`. Until 2026-09-14 the only thing behind that interface was
 * the local narrator worker pool; on 2026-09-15 that pool was DELETED
 * (docs/LEGACY-REMOVAL.md) and this is the only thing left: a Crucible streaming
 * session (crucible `docs/PHASE3-TTS.md` section 7, `crucible/ttsstream.py`, the
 * SDK's `stream()`), behind a VENUE-ROUTED facade that decides WHICH SERVER
 * answers.
 *
 * The surfaces do not change and cannot tell. That is the whole point:
 * crucible `docs/PHASE7-LANES.md` section 5.1 — *"the Crucible integration is
 * ONE seam, not three."*
 *
 * ── How the venue is chosen ────────────────────────────────────────────────
 *
 * `decideWhereGenerationRuns` (`generation-venue.ts`) — the same decision the
 * audiobook render makes, reused rather than re-implemented: the caller's name
 * wins (Listen has no caller-named server today, so this arm is never taken
 * here), else the routing record's top-ranked / first-that-answers server. There
 * is no local narrator to fall back to: a Listen that cannot be placed FAILS by
 * name.
 *
 * The decision is taken when the backend is COLD — at `startSession()` with
 * nothing running — and sticks until `endSession()`, the way the engine
 * selection does ("takes effect on the next engine start"). A record edited
 * under a live session is honoured at the next cold start, never mid-sentence.
 *
 * ── What a session is, and what it refuses ─────────────────────────────────
 *
 * One Crucible server holds ONE streaming session, for ONE resident voice, and
 * the session holds the card WITHOUT occupying the exclusive lane (PHASE7-LANES
 * section 5.1; `Residency.claim(holder, may_mutate=False)`). So:
 *
 *  - `loadVoice(v)` OPENS the session on the mapped Crucible voice. The mapping
 *    is `render.ts`'s `CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE`, imported rather than
 *    copied (one table, one owner). A voice switch closes the session and opens
 *    another.
 *  - **The streaming door never loads a voice.** PHASE3-TTS.md section 6: *"A
 *    render job may load its voice; a stream may not."* The server refuses
 *    `voice_not_resident` naming what IS resident, and so does this file — it
 *    does not submit a `load-voice` job on the listener's behalf.
 *    RULING OWED: whether a Listen may make a voice resident itself. Today no
 *    BookForge door does (`--crucible-load` and Settings' Load are MODELS); a
 *    Listen that loaded would evict whatever a Foundry translate was using
 *    mid-book, which is the model-lease question in the rollout plan's section 3.
 *  - `stream_session_open` — another client is streaming there (the refusal
 *    names its session id). `engine_in_use` — a render holds narrator's wire.
 *    `server_busy` — the lane is held; the SDK's `busyLine` says by whom and how
 *    far along. Unreachable, wrong token, wrong API version, not a Crucible — all
 *    by name, none retried, none downgraded to the local card.
 *
 * ── AND IT DOES NOT LEASE, BECAUSE IT ALREADY HOLDS THE CLAIM ──────────────
 *
 * Owen ruled on 2026-09-14 that a Crucible unloads the resident thing the moment
 * nothing holds it, and `electron/crucible/lease.ts` is how this app's
 * chat-shaped runs say they still do. A streaming session is not one of them: it
 * is fact THREE of the four (`docs/PHASE7-LANES.md` §5.3, `Residency.claimed_by`)
 * — the session holds the resident engine's exclusive claim for its whole life,
 * which is exactly what a lease would buy and for exactly as long. Leasing beside
 * it would be the same claim twice, with two ways to get it wrong
 * (ARCHITECTURE.md R1). The gap a lease closes is a chat holding NOTHING; a
 * session holds the card outright.
 *
 * ── Listen never re-rolls ──────────────────────────────────────────────────
 *
 * docs/CRUCIBLE_ROLLOUT_PLAN.md ruling 3. And the streaming door is UNGUARDED by
 * a ruling of its own (`crucible/ttsstream.py`'s header): a `done` frame carries
 * the server's measurements of the row — `seconds`, `chars`, `chars_per_sec`,
 * `capped`, `cancelled` — and no verdict. Every `done` is RECORDED in
 * `chunk-guard-ledger.ts` (source `crucible-stream`, reason `stream-unguarded`,
 * the frame verbatim) and never acted on: a `capped: true` row is delivered to
 * the listener exactly as it came, and nothing here says a sentence twice.
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * No chunking and no text normalisation — the surfaces pack the rows before the
 * scheduler sees them (`shared/listen-text/chunks.ts`, `shared/listen-text/normalize.ts`). A row
 * longer than the (voice, backend) cap is refused by the server as
 * `chunk_too_long`, and it is never re-split here.
 *
 * WHAT THEY PACK TO IS THIS SERVER'S, as of 2026-09-15. The RULING OWED that
 * stood here — "pack to the venue server's advertised `pace` / `max_chars`
 * instead of the local catalog's" — is `electron/crucible/voice-band.ts`, and
 * this engine's `statedChunkCaps()` is the stream half of it: the surfaces ask
 * the ACTIVE engine for the band, this one answers from its `GET /v1/voices`
 * row (ceiling `safe_max_chars` when stated, never above `max_chars`), and the
 * local catalog is not consulted for a Crucible Listen. The local pool declares
 * no `statedChunkCaps` and the catalog stands for it, which is not a fallback:
 * that engine IS this machine's narrator and the catalog is how it was
 * configured.
 *
 * No `speed`. `PlaySettings.speed` is carried for wire compatibility and the
 * local pool ignores it (Orpheus's sampling is fixed per fine-tune); this backend
 * ignores it the same way.
 */

import { BrowserWindow } from 'electron';
import {
  CrucibleAuthError,
  CrucibleBusy,
  CrucibleConfigError,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';
import type { CrucibleClient, StreamRowDone, TtsStreamSession, VoiceInfo } from '@crucible/client';
import {
  CRUCIBLE_STREAM_IN_FLIGHT as SHARED_STREAM_IN_FLIGHT,
  CRUCIBLE_STREAM_TAKE as SHARED_STREAM_TAKE,
  CrucibleRowSession,
  type CrucibleRowChunk,
} from '../../shared/listen-client/crucible-rows.js';
import { CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE, CrucibleRenderRefused, crucibleVoiceFor } from './render';
import { bandFromVoiceRow, venuePackingCeiling } from './voice-band';
import { decideWhereGenerationRuns, type VenueHost } from './generation-venue';
import { recordCrucibleStreamRow, takeChunkGuards } from '../chunk-guard-ledger';
import { IdleWatch } from '../stream-idle';
import type {
  AudioChunk,
  EngineState,
  LoadVoiceOptions,
  PlaySettings,
  StreamChunk,
  StreamResult,
  StreamWorkerConfig,
} from '../orpheus-worker-pool';
import type { StreamEngineName, StreamingEngine } from '../streaming-engine';

/**
 * The language every Listen row is spoken in.
 *
 * Not guessed here: it is the same literal the three surfaces already hand to
 * `splitForTts(speakable, 'en', …)` and the local worker's
 * `{action: 'generate', language: 'en'}`. Listen has no per-request language on
 * its protocol today, so this is the one place the fact is written for the
 * Crucible arm, beside the note that it mirrors the surfaces'.
 */
export const LISTEN_LANGUAGE = 'en';

/**
 * The take every Listen row asks for. Zero, always — the engine's own sampling,
 * which is what asking for nothing gets — for `render.ts`'s
 * `CRUCIBLE_RENDER_TAKE` reasons, and because the SDK's `say` has no default on
 * the wire (PHASE3-TTS.md section 7, difference 5).
 */
export const CRUCIBLE_STREAM_TAKE = SHARED_STREAM_TAKE;

/**
 * How many rows the scheduler may hold in flight against a session.
 *
 * SHARED since Phase 16 (`shared/listen-client/crucible-rows.ts`), because the
 * browser extension holds rows against a session of its own now and this is a
 * client's read-ahead depth rather than anything about the local pool. It is
 * still the same number as the local path's `STREAM_RAMP_WIDTH` — the
 * narrowest width measured to beat speech rate — and the two are compared by
 * `tools/test-listen-text-one-source.js` rather than trusted, because the
 * shared file cannot import the narrator pool without dragging Electron into a
 * browser bundle.
 */
export const CRUCIBLE_STREAM_IN_FLIGHT = SHARED_STREAM_IN_FLIGHT;

// ─────────────────────────────────────────────────────────────────────────────
// The refusal vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** A server, a voice or a session this Listen cannot use, named. */
export class CrucibleStreamRefused extends Error {
  /** The refusal's own name — the server's code, or this file's for a local one. */
  readonly code: string;
  /** The SDK's "busy: foundry, tts deathstalker, 62% done", on `server_busy` only. */
  readonly busyLine?: string;

  constructor(code: string, message: string, busyLine?: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleStreamRefused';
    this.code = code;
    if (busyLine !== undefined) this.busyLine = busyLine;
  }
}

/**
 * The SDK's error types, turned into one sentence a listener can act on, with
 * the server's own code kept in front so a caller can still match on it.
 *
 * Its own reader beside `render.ts`'s `describeCrucibleRefusal` rather than a
 * call into it: that one's prose is a render's ("queue the book again"), and
 * the SDK's error TYPES are the one shared fact both switch on (`probe.ts`
 * says the same about its own). The three refusals this door is known for get
 * their own sentences; everything else is the server's words with the code.
 */
export function describeCrucibleStreamRefusal(err: unknown, server: string): CrucibleStreamRefused | unknown {
  const at = `crucible "${server}"`;
  if (err instanceof CrucibleBusy) {
    return new CrucibleStreamRefused(
      err.code,
      `${at} is running a job on its lane and will not open a Listen session beside it. ${err.busyLine}`
      + ` (job ${err.jobId}, ${err.jobStatus} since ${err.since}). Nothing here waits for it or streams `
      + 'from this machine instead — listen again when it is done, or pick another server.',
      err.busyLine,
    );
  }
  if (err instanceof CrucibleRefused) {
    const details = (err.details ?? {}) as Record<string, unknown>;
    if (err.code === 'stream_session_open') {
      const who = typeof details['session_id'] === 'string' ? ` (session ${details['session_id']}` : ' (';
      const voice = typeof details['voice'] === 'string' ? `, speaking ${details['voice']})` : ')';
      return new CrucibleStreamRefused(
        err.code,
        `${at} already has a Listen session open${who}${voice}. A server holds one streaming session at `
        + 'a time; close that one — or pick another server. Nothing streams from this machine instead.',
      );
    }
    if (err.code === 'voice_not_resident') {
      return new CrucibleStreamRefused(
        err.code,
        `${at}: ${err.serverMessage}. The streaming door never loads a voice, and neither does this `
        + 'Listen — make it resident on that server first (a `load-voice` job: the SDK\'s `loadVoice`, '
        + 'or a render there, which loads its own voice). No BookForge verb does this yet.',
      );
    }
    if (err.code === 'engine_in_use') {
      return new CrucibleStreamRefused(
        err.code,
        `${at}: ${err.serverMessage}. A render holds narrator's wire on that server; a Listen cannot `
        + 'share it. Listen again when the render is done, or pick another server.',
      );
    }
    return new CrucibleStreamRefused(
      err.code,
      `${at} refused this Listen (HTTP ${err.status}): ${err.serverMessage}`,
    );
  }
  if (err instanceof CrucibleAuthError) {
    return new CrucibleStreamRefused(
      err.code,
      `${at} refused the token: ${err.serverMessage}. Re-add the server with the token `
      + '`crucible token --show` prints on that host.',
    );
  }
  if (err instanceof CrucibleVersionError) {
    return new CrucibleStreamRefused(
      err.code,
      `${at} speaks API version ${err.serverApiVersion}, this client speaks ${err.clientApiVersion}: `
      + `${err.serverMessage}. One of the two must be updated.`,
    );
  }
  if (err instanceof CrucibleServerError) {
    return new CrucibleStreamRefused(
      err.code,
      `${at} failed this Listen (HTTP ${err.status}): ${err.serverMessage}. The server broke; its own `
      + 'log says why.',
    );
  }
  if (err instanceof CrucibleUnreachable) {
    return new CrucibleStreamRefused(
      'crucible_unreachable',
      `${at} could not be reached: ${err.message}. Nothing streams from this machine instead — start `
      + 'the server, or pick another one.',
    );
  }
  if (err instanceof CrucibleNotACrucible) {
    return new CrucibleStreamRefused(
      'crucible_not_a_crucible',
      `${at} answered /v1/ping but is not a crucible: ${err.body}. Check the url.`,
    );
  }
  if (err instanceof CrucibleProtocolError) {
    return new CrucibleStreamRefused(
      'crucible_protocol',
      `${at} sent something API v1 does not describe: ${err.detail}. The server and this client `
      + 'disagree about the protocol.',
    );
  }
  if (err instanceof CrucibleConfigError) {
    return new CrucibleStreamRefused(
      'crucible_client_misconfigured',
      `${at}: this client was built wrong — ${err.message}`,
    );
  }
  if (err instanceof CrucibleRenderRefused) {
    // The voice table's own refusals (`crucible_voice_unmapped`,
    // `crucible_engine_unsupported`, …) already carry their code and their fix.
    return new CrucibleStreamRefused(err.code, err.message.replace(`${err.code}: `, ''));
  }
  // Not one of the SDK's types. Returned UNCHANGED, with its stack.
  return err;
}

/** One sentence for a `{success:false, error}` result. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM back to the scheduler's shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scheduler's `chunk` carries `data` as base64 PCM16 little-endian — what
 * narrator sends over its own pipe and what every client already decodes. The
 * SDK hands back an `Int16Array` it built with little-endian reads, so this
 * writes little-endian bytes back regardless of the host's order rather than
 * casting the array's buffer.
 */
function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) bytes.writeInt16LE(pcm[i] as number, i * 2);
  return bytes.toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────

type GenResult = { success: boolean; audio?: AudioChunk; streamed?: boolean; duration?: number; error?: string };

/*
 * THE ROW MACHINERY LEFT THIS FILE (Phase 16 step 2).
 *
 * `Row`, `onEvent`, `settle` and the `pump` that drove them are
 * `shared/listen-client/crucible-rows.ts` now, because the browser extension
 * and the Angular renderer open their own streaming sessions since Phase 16
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0) and every one of the four frames has
 * a rule that is easy to get subtly wrong: a `restart` that must void audio
 * already handed over, a `done` whose `capped` is `null` and never `false`, a
 * frame for a row nobody said, a `cancel` whose cost depends on where the row
 * was. Three copies of that is three chances.
 *
 * What stayed here is what is BookForge's: the venue decision, the voice
 * mapping, the `StreamingEngine` interface, the PCM-to-base64 the scheduler's
 * wire wants, the refusal vocabulary, and the guard ledger.
 */

/** The open session and everything that belongs to it. */
interface LiveSession {
  readonly session: TtsStreamSession;
  /** The rows on it — the shared layer (see the note above). */
  readonly rows: CrucibleRowSession;
  /** BookForge's voice id — what the pickers show. */
  readonly voice: string;
  /** Crucible's voice id — what the session was opened on. */
  readonly crucibleVoice: string;
  /** Keys the guard ledger for the life of the session. */
  readonly ledgerId: string;
  /** Next row id, so an id is unique within the session. */
  ordinal: number;
  /** `closeSession` has started; the pump's end is expected. */
  closing: boolean;
  /** Why this side closed it — the reason the end is logged under, whichever side finalizes first. */
  closeReason: string | null;
  /** The ledger has been taken and the end logged. Exactly once. */
  finalized: boolean;
}

/*
 * THE ATTACH-WAIT STOPGAP IS DELETED, BECAUSE THE SDK FIXED IT (2026-09-14).
 *
 * What stood here: `ATTACH_WAIT_MS` / `ATTACH_POLL_MS` and a bounded poll
 * around the first `say` of a session. The server refuses a `say` on a
 * session whose event stream has never been opened (`stream_not_attached`,
 * `crucible/ttsstream.py`'s `StreamSession.say`), and the SDK up to v0.5.0
 * attached its stream from inside the iterator — on the first `next()`,
 * asynchronously — while swallowing the `ready` frame that was the one signal
 * attachment had. A client could not know when its first row was allowed.
 *
 * That block named its own root cause and named where the fix belonged: *"the
 * SDK hides attachment. The fix is there — expose it — and the day it lands
 * this block is deleted."* v0.6.0 is that day. Its `StreamSession.say` now
 * carries the guarantee in its own contract: *"The session's event stream is
 * attached, and the server's `ready` frame read, before the session is handed
 * over, so the server's `stream_not_attached` refusal cannot be met by a
 * caller of this client."*
 *
 * So the poll is gone and nothing replaced it. A `stream_not_attached` that
 * arrives anyway is now what it should always have been: a refusal, surfaced
 * BY NAME like every other, because it would mean the guarantee above is
 * false and retrying would hide that.
 */

/** What this engine needs from the world, so a keeper can drive it against a fake. */
export interface CrucibleStreamingEngineDeps {
  /** Which Listen engine is selected — decides which catalog the voice ids belong to. */
  selectedEngine(): StreamEngineName;
  /** A client bound to a registered server (or `local`), named `bookforge`. */
  clientFor(server: string): CrucibleClient;
}

/**
 * A `StreamingEngine` whose worker is a Crucible streaming session.
 *
 * Methods are arrow properties on purpose: `streaming-engine.ts`'s
 * `observable()` spread-copies a pool into a wrapper, and prototype methods do
 * not survive a spread.
 */
export class CrucibleStreamingEngine {
  private server: string | null = null;
  private client: CrucibleClient | null = null;
  /** `GET /v1/voices` as answered at `startSession`; null until then. */
  private serverRows: readonly VoiceInfo[] | null = null;
  private live: LiveSession | null = null;
  private lastVoice: string | null = null;
  private starting = false;
  private opening = false;
  private serviceMode = false;
  private readonly stateListeners = new Set<(state: EngineState, isServiceMode: boolean) => void>();
  private readonly idleWatch: IdleWatch;

  constructor(private readonly deps: CrucibleStreamingEngineDeps) {
    // The SAME idle rule as the local pool, from the same module: the user's
    // window, read per sweep; service mode parks rather than stops.
    this.idleWatch = new IdleWatch({
      label: '[CrucibleStream]',
      isActive: () => this.isSessionActive(),
      isServiceMode: () => this.serviceMode,
      park: () => { void this.endSession({ keepServiceArmed: true }); },
      shutdown: () => { void this.endSession(); },
    });
  }

  // ------------------------------------------------------------------ venue

  /** The server this engine will open its session on. Null until the venue is decided. */
  boundServer(): string | null {
    return this.server;
  }

  /**
   * Bind the venue the facade decided. Refused while a session is open: the
   * venue is a cold-start decision, and re-pointing a live Listen would leave
   * its rows on one server and its next sentence on another.
   */
  bind(server: string): void {
    if (this.live !== null && this.server !== server) {
      throw new CrucibleStreamRefused(
        'crucible_stream_rebind_refused',
        `a Listen session is open on crucible "${this.server}"; it cannot be re-pointed at "${server}" `
        + 'mid-session. End it first.',
      );
    }
    if (this.server !== server) {
      this.server = server;
      this.client = this.deps.clientFor(server);
      this.serverRows = null;
    }
  }

  // ------------------------------------------------------------ lifecycle

  setMainWindow = (_window: Electron.BrowserWindow | null): void => {
    // The local pool takes the window to report warm-up percentages
    // (`tts-service:warmup`). A session opens in one HTTP round trip and has no
    // warm-up to report; the state broadcasts below go to every window, as the
    // pool's do. Accepted and unused, like `LoadVoiceOptions.warm` on a pool
    // whose load is its warm-up.
  };

  startSession = async (): Promise<{ success: boolean; voices?: string[]; error?: string }> => {
    if (this.server === null || this.client === null) {
      return {
        success: false,
        error: 'crucible_stream_no_venue: no Crucible server is bound for this Listen. The venue is '
          + 'decided by the routed engine (getActiveEngine()); nothing opens a session without one.',
      };
    }
    if (this.serverRows !== null) {
      return { success: true, voices: this.getAvailableVoices() };
    }
    this.starting = true;
    this.broadcastState();
    try {
      // One GET, before anything else: is it a Crucible, does the token work,
      // does it serve `tts`, and which voices does it advertise. The answer is
      // what the pickers show from here on.
      this.serverRows = await this.client.voices();
    } catch (err) {
      this.starting = false;
      this.broadcastState();
      const refusal = describeCrucibleStreamRefusal(err, this.server);
      if (refusal instanceof CrucibleStreamRefused) return { success: false, error: refusal.message };
      throw refusal;
    }
    this.starting = false;
    this.idleWatch.arm();
    console.log(`[CrucibleStream] crucible "${this.server}" is up for Listen: `
      + `${this.serverRows.length} voice(s) advertised, ${this.getAvailableVoices().length} mapped`);
    this.broadcastState();
    return { success: true, voices: this.getAvailableVoices() };
  };

  loadVoice = async (voice: string, _opts?: LoadVoiceOptions): Promise<{ success: boolean; error?: string }> => {
    const server = this.server;
    const client = this.client;
    if (server === null || client === null || this.serverRows === null) {
      return {
        success: false,
        error: 'crucible_stream_not_started: startSession() has not brought a Crucible up for this Listen.',
      };
    }
    let crucibleVoice: string;
    try {
      crucibleVoice = crucibleVoiceFor(this.deps.selectedEngine(), voice);
    } catch (err) {
      if (err instanceof CrucibleRenderRefused) return { success: false, error: err.message };
      throw err;
    }
    const current = this.live;
    if (current !== null && current.voice === voice) return { success: true };
    if (current !== null) {
      // A voice switch is a session switch: the server holds one session, on
      // one resident voice. The old one goes first — the server would refuse
      // the new one `stream_session_open` otherwise, and that would be this
      // engine's own session refusing itself.
      await this.closeSession(current, `switching voice from ${current.voice} to ${voice}`);
    }
    this.opening = true;
    this.broadcastState();
    let session: TtsStreamSession;
    try {
      session = await client.stream({ voice: crucibleVoice, language: LISTEN_LANGUAGE });
    } catch (err) {
      this.opening = false;
      this.broadcastState();
      const refusal = describeCrucibleStreamRefusal(err, server);
      if (refusal instanceof CrucibleStreamRefused) {
        console.error(`[CrucibleStream] ${refusal.message}`);
        return { success: false, error: refusal.message };
      }
      throw refusal;
    }
    const ledgerId = `crucible-stream:${session.sessionId}`;
    const live: LiveSession = {
      session,
      rows: new CrucibleRowSession(session, {
        // RECORDED, NEVER ACTED ON. The frame is the server's own measurement of
        // the row; the door is unguarded by ruling, and Listen never re-rolls.
        onRowDone: (id: string, ordinal: number, done: StreamRowDone) => {
          recordCrucibleStreamRow(ledgerId, {
            index: ordinal,
            seconds: done.seconds,
            chars: done.chars,
            charsPerSec: done.charsPerSec,
            capped: done.capped,
            cancelled: done.cancelled,
          });
          if (done.capped === true) {
            console.warn(`[CrucibleStream] row ${id} hit the frame cap after `
              + `${done.seconds.toFixed(1)}s — delivered as is; Listen never re-rolls`);
          }
        },
        warn: (line: string) => console.error(`[CrucibleStream] ${line}`),
      }),
      voice,
      crucibleVoice,
      ledgerId,
      ordinal: 0,
      closing: false,
      closeReason: null,
      finalized: false,
    };
    this.live = live;
    this.lastVoice = voice;
    this.opening = false;
    this.idleWatch.touch();
    console.log(`[CrucibleStream] session ${session.sessionId} open on crucible "${server}": `
      + `${voice} → ${session.fingerprint}, ${session.sampleRate} Hz, ${session.backend}`);
    void this.pump(live);
    this.broadcastState();
    return { success: true };
  };

  /**
   * Read the session's frames for as long as it lives, and settle every row
   * against them. One reader per session; the rules for each of the four
   * frames — and for a frame naming a row nobody said — are the shared row
   * layer's (shared/listen-client/crucible-rows.ts).
   */
  private async pump(live: LiveSession): Promise<void> {
    const ended = await live.rows.run();
    this.sessionGone(live, ended);
  }

  /** The pump ended, by our close or the server's. Exactly once per session. */
  private sessionGone(live: LiveSession, reason: string): void {
    if (this.live === live) this.live = null;
    // `run()` has already failed every live row by name.
    // Our own close races the `closed` frame it causes — the frame can land
    // before the DELETE answers — so whichever side finalizes first logs it
    // under OUR reason when the close was ours.
    this.finalize(live, live.closing ? 'closed' : 'ended', live.closeReason ?? reason, live.closing ? 'log' : 'error');
    this.broadcastState();
  }

  /** Take the ledger and log the end. Exactly once per session. */
  private finalize(live: LiveSession, verb: 'closed' | 'ended', reason: string, level: 'log' | 'error'): void {
    if (live.finalized) return;
    live.finalized = true;
    const summary = takeChunkGuards(live.ledgerId);
    console[level](`[CrucibleStream] session ${live.session.sessionId} ${verb} (${reason}): `
      + `${summary.chunks} row(s) recorded, ${summary.unknown} unguarded by ruling`);
  }

  /** Close one session and wait for the server to say so. */
  private async closeSession(live: LiveSession, reason: string): Promise<void> {
    if (live.closing) return;
    live.closing = true;
    live.closeReason = reason;
    if (this.live === live) this.live = null;
    try {
      // Fails every live row by name, then closes the session on the server.
      await live.rows.close(reason);
    } catch (err) {
      // A session the server has already dropped is not a failure to close it;
      // anything else is reported and the server's own grace window ends the
      // session on its side.
      const refusal = describeCrucibleStreamRefusal(err, this.server ?? '?');
      console.error(`[CrucibleStream] closing session ${live.session.sessionId}: ${errorText(refusal)}`);
    }
    // The pump may still be draining the `closed` frame; the ledger is taken
    // here so `endSession()` resolving means the record is complete.
    this.finalize(live, 'closed', reason, 'log');
  }

  // ----------------------------------------------------------- generation

  generateSentence = async (
    text: string,
    _sentenceIndex: number,
    settings: PlaySettings,
    _priority = false,
    isCancelled?: () => boolean,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<GenResult> => {
    this.idleWatch.touch();
    const live = this.live;
    if (live === null) {
      return { success: false, error: 'no Listen session is open on a Crucible — load a voice first' };
    }
    const requested = (settings?.voice ?? '').trim();
    if (requested !== '' && requested.toLowerCase() !== live.voice.toLowerCase()) {
      // A session speaks ONE voice. The local pool refuses the same mismatch for
      // Higgs; rendering it in whatever is loaded would be the wrong narrator
      // delivered as a success.
      return {
        success: false,
        error: `the Listen session on crucible "${this.server}" speaks '${live.voice}', not the requested `
          + `'${settings.voice}' — load it first`,
      };
    }

    live.ordinal += 1;
    const id = `r${live.ordinal}`;
    /*
     * ONE ATTEMPT. No poll, no wait: the SDK attaches the session's event
     * stream and reads the server's `ready` frame BEFORE handing the session
     * over (v0.6.0), so a row said here is a row the server is listening for.
     * A `stream_not_attached` refusal would mean that guarantee is false, and
     * it surfaces by name rather than being retried around.
     */
    let outcome;
    try {
      outcome = await live.rows.say(text, {
        id,
        isCancelled,
        // The scheduler's `chunk` carries base64 PCM16; the shared row layer
        // hands over the samples and leaves the encoding to whoever is
        // listening (a browser builds a WAV blob out of the same frames).
        onChunk: onChunk === undefined
          ? undefined
          : (chunk: CrucibleRowChunk) => onChunk({
              seq: chunk.seq,
              data: pcm16ToBase64(chunk.pcm),
              duration: chunk.seconds,
              sampleRate: chunk.sampleRate,
            }),
      });
    } catch (err) {
      const refusal = describeCrucibleStreamRefusal(err, this.server ?? '?');
      if (refusal instanceof CrucibleStreamRefused) return { success: false, error: refusal.message };
      throw refusal;
    }
    if (!outcome.success) return { success: false, error: outcome.error };
    if (outcome.streamed === true) {
      return { success: true, streamed: true, duration: outcome.seconds ?? 0 };
    }
    return {
      success: true,
      audio: {
        data: pcm16ToBase64(outcome.pcm as Int16Array),
        duration: outcome.seconds ?? 0,
        sampleRate: live.rows.sampleRate,
      },
    };
  };

  generateSentenceStream = async (
    text: string,
    settings: PlaySettings,
    onChunk: (chunk: StreamChunk) => void,
    isCancelled?: () => boolean,
  ): Promise<StreamResult> => {
    // The solo token-streamed opener the scheduler no longer dispatches; the
    // interface keeps it, so it is the fast-start row path with no sentence index.
    const result = await this.generateSentence(text, -1, settings, true, isCancelled, onChunk);
    return result.success
      ? { success: true, duration: result.duration ?? 0 }
      : { success: false, error: result.error ?? 'no audio generated' };
  };

  /**
   * Per-row cancel on the server for every in-flight row the scheduler has
   * marked stale. The local pool can only abort a whole batch and so waits
   * until EVERY row is stale; Crucible's `cancel` is per row (`dropped` for a
   * pending row, `aborting_batch` for a generating one — free on higgs-v3,
   * where the row is its own batch), so each stale row is cancelled on its own
   * and the live ones are untouched.
   */
  cancelPendingBatchIfStale = (): void => {
    this.live?.rows.cancelStale();
  };

  stop = (): void => {
    const live = this.live;
    if (live === null) return;
    void live.rows.cancelAll().then(
      (count) => console.log(`[CrucibleStream] stop: ${count} row(s) cancelled on the server`),
      (err) => console.error(`[CrucibleStream] stop: ${errorText(describeCrucibleStreamRefusal(err, this.server ?? '?'))}`),
    );
  };

  endSession = async (opts?: { keepServiceArmed?: boolean }): Promise<void> => {
    this.idleWatch.disarm();
    const live = this.live;
    const hadSession = live !== null;
    if (live !== null) await this.closeSession(live, 'the session was ended');
    // The venue is a cold-start decision, so a cold engine forgets it: the next
    // startSession asks decideWhereGenerationRuns again.
    this.server = null;
    this.client = null;
    this.serverRows = null;
    if (!opts?.keepServiceArmed) this.serviceMode = false;
    if (hadSession) broadcastToWindows('play:session-ended', { code: 0 });
    this.broadcastState();
  };

  // -------------------------------------------------------------- queries

  isSessionActive = (): boolean => this.live !== null;

  getAvailableVoices = (): string[] => {
    // Every Crucible voice is higgs-v3 (`crucibleVoiceFor` refuses Orpheus by
    // name), so on the Orpheus selection a Crucible offers nothing.
    if (this.deps.selectedEngine() !== 'higgs') return [];
    const mapped = Object.keys(CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE);
    const rows = this.serverRows;
    if (rows === null) return mapped;
    return mapped.filter((id) => rows.some((row) => row.id === CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE[id]));
  };

  getCurrentVoice = (): string | null => this.live?.voice ?? null;

  /**
   * THE BAND THIS SERVER STATES for a BookForge voice — `StreamingEngine`'s
   * `statedChunkCaps`, and the stream half of `voice-band.ts`'s ruling.
   *
   * The surfaces pack before the scheduler starts anything, so this answers off
   * `serverRows` when `startSession` has already fetched them and fetches them
   * itself when it has not: one `GET /v1/voices`, the same call `startSession`
   * makes moments later, and the venue must already be bound (the facade binds
   * it before asking).
   *
   * Refusals stay refusals: an unmapped voice, one this server does not
   * advertise, or a row with no cap THROWS by name rather than resolving `null`,
   * because packing to the local catalog after the server said no is how a book
   * gets rendered to a cap nobody measured. `null` means only one thing — this
   * engine has no venue bound yet, which the facade does not allow.
   */
  statedChunkCaps = async (voice: string): Promise<{
    maxChars: number | null;
    safeMinChars: number | null;
    safeMaxChars: number | null;
  } | null> => {
    const server = this.server;
    const client = this.client;
    if (server === null || client === null) return null;
    const crucibleVoice = crucibleVoiceFor(this.deps.selectedEngine(), voice);
    if (this.serverRows === null) this.serverRows = await client.voices();
    const row = this.serverRows.find((v) => v.id === crucibleVoice);
    if (row === undefined) {
      const known = this.serverRows.map((v) => v.id).join(', ');
      throw new CrucibleStreamRefused(
        'crucible_unknown_voice',
        `crucible "${server}" has no voice "${crucibleVoice}" `
        + `(${this.serverRows.length === 0 ? 'it advertises none' : `known: ${known}`}), so there is `
        + 'no band to pack this Listen into. Nothing packs to the local catalog instead.',
      );
    }
    const band = bandFromVoiceRow(server, crucibleVoice, row);
    return {
      maxChars: band.maxChars,
      safeMinChars: band.safeMinChars,
      // The ceiling rule has one owner (`venuePackingCeiling`): safe when stated,
      // never above the cap. `listenBandFromCaps` takes `safeMaxChars ?? maxChars`
      // and this hands it the already-resolved answer.
      safeMaxChars: venuePackingCeiling(band),
    };
  };

  /** Never: a session is opened ON one resident voice, and the server holds one. */
  canServeVoicePerRequest = (_voice: string): boolean => false;

  /** A voice switch closes the session, which is the other sessions' rebuild. */
  wouldRebuildEngine = (voice: string): boolean => {
    const live = this.live;
    if (live === null) return false;
    return voice.trim().toLowerCase() !== live.voice.toLowerCase();
  };

  getLastVoice = (): string | null => this.lastVoice;

  getDefaultVoice = (): string => {
    const current = this.getCurrentVoice();
    if (current !== null) return current;
    if (this.lastVoice !== null) return this.lastVoice;
    const available = this.getAvailableVoices();
    if (available.length === 0) {
      throw new Error(
        this.deps.selectedEngine() === 'higgs'
          ? `crucible "${this.server ?? '(none bound)'}" advertises none of the voices BookForge can ask a `
            + 'Crucible for (CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE), so there is nothing to stream. Pull a voice '
            + 'there (`crucible voices pull <id>`), or turn on the legacy local-render switch.'
          : 'Every voice a Crucible serves is higgs-v3; the Orpheus selection has nothing to stream through '
            + 'one. Select Higgs, or turn on the legacy local-render switch in Settings → Crucible Servers.',
      );
    }
    return available[0] as string;
  };

  getWorkerCount = (): number => (this.live !== null ? 1 : 0);

  getMaxConcurrentSentences = (): number => (this.live !== null ? CRUCIBLE_STREAM_IN_FLIGHT : 1);

  getEngineState = (): EngineState => {
    if (this.starting || this.opening) return 'starting';
    if (this.live !== null) return 'running';
    if (this.serverRows !== null) return 'warming';
    return 'stopped';
  };

  isServiceMode = (): boolean => this.serviceMode;

  setServiceMode = (on: boolean): void => {
    if (this.serviceMode === on) return;
    this.serviceMode = on;
    this.broadcastState();
  };

  onEngineState = (listener: (state: EngineState, isServiceMode: boolean) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  };

  getStreamWorkerConfig = (): StreamWorkerConfig => {
    const live = this.live;
    return {
      enabled: false,
      count: 1,
      defaultCount: 1,
      minWorkers: 1,
      maxWorkers: 1,
      devicePref: 'auto',
      device: live === null ? null : deviceForBackend(live.session.backend),
      // The extension reads this as its prefetch depth; a session's read-ahead
      // depth is CRUCIBLE_STREAM_IN_FLIGHT rows.
      deviceWorkers: live === null ? 1 : CRUCIBLE_STREAM_IN_FLIGHT,
      activeWorkers: this.getWorkerCount(),
    };
  };

  setStreamWorkerConfig = (_updates: {
    enabled?: boolean;
    count?: number;
    devicePref?: StreamWorkerConfig['devicePref'];
  }): StreamWorkerConfig => {
    // No-op, as on the local pool: the topology is the server's.
    return this.getStreamWorkerConfig();
  };

  // ------------------------------------------------------------ broadcast

  private broadcastState(): void {
    const state = this.getEngineState();
    broadcastToWindows('tts-service:state', { state, serviceMode: this.serviceMode });
    for (const listener of this.stateListeners) {
      try {
        listener(state, this.serviceMode);
      } catch (err) {
        console.error('[CrucibleStream] Engine state listener failed:', err);
      }
    }
  }
}

/**
 * The Crucible backend name as the settings payload's device word.
 *
 * `cuda-linux` is a CUDA card and `mlx-darwin` is Apple silicon (`mps` is what
 * the payload has always called it). A backend this build has not heard of is
 * a contract change, reported loudly and shown as `null` — the field's own
 * word for "not probed" — rather than guessed onto a card it is not.
 */
const unknownBackendsReported = new Set<string>();
function deviceForBackend(backend: string): 'cpu' | 'cuda' | 'mps' | null {
  if (backend === 'cuda-linux') return 'cuda';
  if (backend === 'mlx-darwin') return 'mps';
  if (!unknownBackendsReported.has(backend)) {
    unknownBackendsReported.add(backend);
    console.error(`[CrucibleStream] session backend "${backend}" is not one this build knows (cuda-linux, `
      + 'mlx-darwin); reporting no device');
  }
  return null;
}

function broadcastToWindows(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The venue-routed facade — the one thing `getActiveEngine()` returns
// ─────────────────────────────────────────────────────────────────────────────

export interface VenueRoutedDeps {
  /** The Crucible backend, already wrapped `observable()`. */
  crucible: StreamingEngine;
  /** The same Crucible engine, unwrapped, for `bind`. */
  crucibleEngine: CrucibleStreamingEngine;
  /** What `decideWhereGenerationRuns` reads. */
  venue: VenueHost;
}

/**
 * A `StreamingEngine` bound to a SERVER at cold start.
 *
 * There used to be two backends here and the facade chose between them; the
 * local narrator pool is deleted (docs/LEGACY-REMOVAL.md), so what is left
 * decides WHICH MACHINE rather than WHICH KIND. `startSession()` is where that
 * is decided, and only when nothing is running: a live session keeps answering
 * until it is ended, so a routing change mid-Listen takes effect at the next
 * cold start, exactly as an engine selection does.
 *
 * The indirection is kept rather than collapsed because the DECISION is the
 * thing — every sync question below must be answerable before a session exists,
 * and `bind` must happen exactly once, before `startSession` reaches the SDK.
 */
export function venueRoutedStreamingEngine(deps: VenueRoutedDeps): StreamingEngine {
  const backend = (): StreamingEngine => deps.crucible;

  const startSession = async (): Promise<{ success: boolean; voices?: string[]; error?: string }> => {
    if (backend().isSessionActive()) {
      // Warm and running: the venue was decided when it was started.
      return backend().startSession();
    }
    let venue;
    try {
      venue = await decideWhereGenerationRuns(undefined, deps.venue);
    } catch (err) {
      // `no_enabled_server` / `no_reachable_server` / a corrupt record — in the
      // decision's own words, which name the settings page that fixes each.
      // There is no local narrator: nothing streams on this machine by accident.
      const code = (err as { code?: unknown }).code;
      console.error(`[StreamVenue] Listen has nowhere to run: ${errorText(err)}`);
      return { success: false, error: typeof code === 'string' ? `${code}: ${errorText(err)}` : errorText(err) };
    }
    console.log(`[StreamVenue] Listen goes to crucible "${venue.server}" (${venue.because})`);
    try {
      deps.crucibleEngine.bind(venue.server);
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
    return deps.crucible.startSession();
  };

  return {
    setMainWindow: (window) => backend().setMainWindow(window),
    startSession,
    loadVoice: (voice, opts) => backend().loadVoice(voice, opts),
    generateSentence: (text, index, settings, priority, isCancelled, onChunk) =>
      backend().generateSentence(text, index, settings, priority, isCancelled, onChunk),
    generateSentenceStream: (text, settings, onChunk, isCancelled) =>
      backend().generateSentenceStream(text, settings, onChunk, isCancelled),
    cancelPendingBatchIfStale: () => backend().cancelPendingBatchIfStale?.(),
    stop: () => backend().stop(),
    endSession: () => backend().endSession(),
    isSessionActive: () => backend().isSessionActive(),
    getAvailableVoices: () => backend().getAvailableVoices(),
    getCurrentVoice: () => backend().getCurrentVoice(),
    canServeVoicePerRequest: (voice) => backend().canServeVoicePerRequest?.(voice) === true,
    wouldRebuildEngine: (voice) => backend().wouldRebuildEngine?.(voice) === true,
    getLastVoice: () => backend().getLastVoice(),
    getDefaultVoice: () => backend().getDefaultVoice(),
    getWorkerCount: () => backend().getWorkerCount(),
    getMaxConcurrentSentences: () => {
      // The backend batches and defines it; one that did not would be a contract
      // change, refused here rather than read as "one at a time".
      const engine = backend();
      if (typeof engine.getMaxConcurrentSentences !== 'function') {
        throw new Error('the bound streaming backend reports no batch width (getMaxConcurrentSentences)');
      }
      return engine.getMaxConcurrentSentences();
    },
    getEngineState: () => backend().getEngineState(),
    isServiceMode: () => backend().isServiceMode(),
    setServiceMode: (on) => backend().setServiceMode(on),
    onEngineState: (listener) => deps.crucible.onEngineState(
      () => listener(backend().getEngineState(), backend().isServiceMode()),
    ),
    getStreamWorkerConfig: () => backend().getStreamWorkerConfig(),
    setStreamWorkerConfig: (updates) => backend().setStreamWorkerConfig(updates),
    /**
     * THE BAND THE SURFACES PACK TO, from whichever backend will speak the rows.
     *
     * The venue has to be DECIDED before the answer means anything, and a surface
     * asks this before it packs — which is before the scheduler starts anything.
     * So this takes the same cold-start decision `startSession` takes, through
     * `startSession` itself: it is idempotent (a warm backend answers from what
     * it already has), it is the decision that was about to be taken anyway, and
     * taking it twice in two ways is how the pack and the render end up on two
     * different servers.
     *
     */
    statedChunkCaps: async (voice) => {
      const engine = backend();
      if (typeof engine.statedChunkCaps !== 'function') return null;
      const started = await startSession();
      if (!started.success) throw new Error(started.error ?? 'Listen has nowhere to run');
      return engine.statedChunkCaps(voice);
    },
  };
}
