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
 * the local narrator worker pool. This file puts a second thing behind it: a
 * Crucible streaming session (crucible `docs/PHASE3-TTS.md` section 7,
 * `crucible/ttsstream.py`, the SDK's `stream()`), and a VENUE-ROUTED facade that
 * decides which of the two answers.
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
 * here), else the ONE legacy switch (`legacyLocalRender` in the routing record)
 * means the local narrator exactly as before, else the routing record's
 * top-ranked / first-that-answers server. There is no second switch and no
 * fallback: with the switch off, a Listen that cannot be placed FAILS by name.
 *
 * The decision is taken when the backend is COLD — at `startSession()` with
 * nothing running — and sticks until `endSession()`, the way the engine
 * selection does ("takes effect on the next engine start"). A switch flipped
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
 * scheduler sees them (`listen-chunks.ts`, `listen-text.ts`), from THIS
 * MACHINE'S catalog band. A row longer than the (voice, backend) cap is refused
 * by the server as `chunk_too_long`, never re-split here. RULING OWED: pack to
 * the venue server's advertised `pace` / `max_chars` (`GET /v1/voices`) instead
 * of the local catalog's, so a remote arm with a different cap is honoured.
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
import type { CrucibleClient, StreamEvent, TtsStreamSession, VoiceInfo } from '@crucible/client';
import { CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE, CrucibleRenderRefused, crucibleVoiceFor } from './render';
import { decideWhereGenerationRuns, type VenueHost } from './generation-venue';
import { recordCrucibleStreamRow, takeChunkGuards } from '../chunk-guard-ledger';
import { IdleWatch } from '../stream-idle';
import { STREAM_RAMP_WIDTH } from '../orpheus-worker-pool';
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
export const CRUCIBLE_STREAM_TAKE = 0;

/**
 * How many rows the scheduler may hold in flight against a session.
 *
 * The server batches (its width is engine tuning: `higgs-v3` 1, `orpheus` 8,
 * `crucible/ttsstream.py`'s `STREAM_BATCH_WIDTH`), so this is the CLIENT's
 * read-ahead depth, not a batch width: rows said and not yet done. It is the
 * ramp width the local path already dispatches — the narrowest width measured
 * to beat speech rate — so the scheduler's first wave is the same size on both
 * backends, and a per-row cancel of a pending row on the server is `dropped`
 * at no cost.
 */
export const CRUCIBLE_STREAM_IN_FLIGHT = STREAM_RAMP_WIDTH;

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

/** One row said and not yet done. */
interface Row {
  /** This row's ordinal within the session — the ledger's index. */
  readonly ordinal: number;
  /** The scheduler's sentence index, for the log. */
  readonly sentenceIndex: number;
  readonly onChunk: ((chunk: StreamChunk) => void) | undefined;
  readonly isCancelled: (() => boolean) | undefined;
  /** Audio held back until `done`, when the caller did not ask for fast start. */
  buffered: { seq: number; pcm: Int16Array; seconds: number }[];
  /** A `cancel` for this row has gone to the server. */
  cancelSent: boolean;
  /**
   * Fast-start audio for this row already reached the listener and the server
   * then RESTARTED the row (PHASE3-TTS.md section 7, difference 1). The chunks
   * cannot be taken back, so the row was failed by name and every later frame
   * for it is ignored — see `onRestart`.
   */
  abandoned: boolean;
  settled: boolean;
  resolve: (result: GenResult) => void;
}

/** The open session and everything that belongs to it. */
interface LiveSession {
  readonly session: TtsStreamSession;
  /** BookForge's voice id — what the pickers show. */
  readonly voice: string;
  /** Crucible's voice id — what the session was opened on. */
  readonly crucibleVoice: string;
  /** Keys the guard ledger for the life of the session. */
  readonly ledgerId: string;
  readonly rows: Map<string, Row>;
  ordinal: number;
  /** `closeSession` has started; the pump's end is expected. */
  closing: boolean;
  /** Why this side closed it — the reason the end is logged under, whichever side finalizes first. */
  closeReason: string | null;
  /** The ledger has been taken and the end logged. Exactly once. */
  finalized: boolean;
  /** A `say` has been accepted, so the server has seen our event stream attach. */
  attached: boolean;
}

/**
 * STOPGAP, LABELLED — how long the first `say` of a session may wait for the
 * SDK's event stream to attach, and how often it asks.
 *
 * The server refuses a `say` on a session whose event stream has never been
 * opened (`stream_not_attached`, crucible/ttsstream.py `StreamSession.say`),
 * and the SDK's session attaches its stream from inside its iterator — on the
 * first `next()`, asynchronously — while swallowing the `ready` frame that is
 * the one signal "attached" has. So a client cannot know when its first `say`
 * is allowed; the SDK's own docstring example (`void session.say(...)` before
 * `for await`) is refused by the real server for exactly this reason.
 *
 * ROOT CAUSE: the SDK hides attachment (`sdk/ts/src/stream.ts`). The fix is
 * there — expose it (an `attached` promise, or yield `ready`) — and the day
 * it lands this block is deleted. Until then: ONLY that code, ONLY before the
 * session's first accepted row, bounded, and logged once; then the refusal
 * surfaces by name like any other. Nothing is substituted and nothing is
 * retried after the session is known to be attached.
 */
const ATTACH_WAIT_MS = 5_000;
const ATTACH_POLL_MS = 25;

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
    const live: LiveSession = {
      session,
      voice,
      crucibleVoice,
      ledgerId: `crucible-stream:${session.sessionId}`,
      rows: new Map(),
      ordinal: 0,
      closing: false,
      closeReason: null,
      finalized: false,
      attached: false,
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
   * Read the session's frames for as long as it lives. One reader per session;
   * rows are keyed by the id `say` handed the server, so a frame for an id this
   * session never said is reported loudly rather than dropped — the two sides
   * would disagree about which rows exist, and silence would be a sentence of
   * missing audio nobody can trace (the local pool's rule for the same case).
   */
  private async pump(live: LiveSession): Promise<void> {
    let ended = 'the server closed the session';
    try {
      for await (const event of live.session) this.onEvent(live, event);
    } catch (err) {
      const refusal = describeCrucibleStreamRefusal(err, this.server ?? '?');
      ended = `the session failed: ${errorText(refusal)}`;
    }
    this.sessionGone(live, ended);
  }

  private onEvent(live: LiveSession, event: StreamEvent): void {
    const row = live.rows.get(event.id);
    if (row === undefined) {
      console.error(`[CrucibleStream] ${event.kind} frame for row ${event.id}, which this session never `
        + 'said — dropping it');
      return;
    }
    if (row.abandoned) {
      if (event.kind === 'done') live.rows.delete(event.id);
      return;
    }
    switch (event.kind) {
      case 'audio': {
        if (row.isCancelled?.() === true) return;
        if (row.onChunk !== undefined) {
          row.onChunk({
            seq: event.seq,
            data: pcm16ToBase64(event.pcm),
            duration: event.seconds,
            sampleRate: live.session.sampleRate,
          });
        } else {
          row.buffered.push({ seq: event.seq, pcm: event.pcm, seconds: event.seconds });
        }
        return;
      }
      case 'restart': {
        if (row.onChunk !== undefined) {
          // The audio below `fromSeq` is void and it has already been played.
          // The scheduler's chunk protocol has no frame that takes audio back,
          // so the honest answer is a failed sentence, by name, rather than the
          // row's first seconds twice. Unreachable on every voice that ships
          // (higgs-v3, width 1); an Orpheus manifest would reach it.
          row.abandoned = true;
          this.settle(row, {
            success: false,
            error: `crucible restarted row ${event.id} from seq ${event.fromSeq} (${event.reason}) after its `
              + 'first chunks were already handed to the listener; a fast-start row cannot be restarted',
          });
          return;
        }
        row.buffered = row.buffered.filter((chunk) => chunk.seq >= event.fromSeq);
        return;
      }
      case 'done': {
        live.rows.delete(event.id);
        // RECORDED, NEVER ACTED ON. The frame is the server's own measurement of
        // the row; the door is unguarded by ruling, and Listen never re-rolls.
        recordCrucibleStreamRow(live.ledgerId, {
          index: row.ordinal,
          seconds: event.seconds,
          chars: event.chars,
          charsPerSec: event.charsPerSec,
          capped: event.capped,
          cancelled: event.cancelled,
        });
        if (event.capped === true) {
          console.warn(`[CrucibleStream] row ${event.id} (sentence ${row.sentenceIndex}) hit the frame cap `
            + `after ${event.seconds.toFixed(1)}s — delivered as is; Listen never re-rolls`);
        }
        if (event.cancelled) {
          this.settle(row, { success: false, error: `row ${event.id} was cancelled on the server` });
          return;
        }
        if (row.onChunk !== undefined) {
          this.settle(row, { success: true, streamed: true, duration: event.seconds });
          return;
        }
        row.buffered.sort((a, b) => a.seq - b.seq);
        const samples = row.buffered.reduce((n, chunk) => n + chunk.pcm.length, 0);
        const pcm = new Int16Array(samples);
        let at = 0;
        for (const chunk of row.buffered) {
          pcm.set(chunk.pcm, at);
          at += chunk.pcm.length;
        }
        this.settle(row, {
          success: true,
          audio: { data: pcm16ToBase64(pcm), duration: event.seconds, sampleRate: live.session.sampleRate },
        });
        return;
      }
      case 'error': {
        live.rows.delete(event.id);
        this.settle(row, { success: false, error: `${event.code}: ${event.message}` });
        return;
      }
      default: {
        // The SDK narrows the union; a kind it does not know is thrown inside it,
        // never yielded. Stated so a widened union is a compile error here.
        const never: never = event;
        throw new Error(`crucible stream event of unknown kind: ${JSON.stringify(never)}`);
      }
    }
  }

  private settle(row: Row, result: GenResult): void {
    if (row.settled) return;
    row.settled = true;
    row.resolve(result);
  }

  /** The pump ended, by our close or the server's. Exactly once per session. */
  private sessionGone(live: LiveSession, reason: string): void {
    if (this.live === live) this.live = null;
    for (const [id, row] of live.rows) {
      this.settle(row, { success: false, error: `Listen session on crucible closed before row ${id} finished: ${reason}` });
    }
    live.rows.clear();
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
    for (const [id, row] of live.rows) {
      this.settle(row, { success: false, error: `Listen session on crucible closed before row ${id} finished: ${reason}` });
    }
    try {
      await live.session.close();
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
    sentenceIndex: number,
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
    if (isCancelled?.() === true) return { success: false, error: 'cancelled before dispatch' };

    live.ordinal += 1;
    const id = `r${live.ordinal}`;
    let resolve!: (result: GenResult) => void;
    const promise = new Promise<GenResult>((r) => { resolve = r; });
    const row: Row = {
      ordinal: live.ordinal,
      sentenceIndex,
      onChunk,
      isCancelled,
      buffered: [],
      cancelSent: false,
      abandoned: false,
      settled: false,
      resolve,
    };
    live.rows.set(id, row);
    const waitUntil = Date.now() + ATTACH_WAIT_MS;
    let waitedOnce = false;
    for (;;) {
      try {
        await live.session.say(id, text, CRUCIBLE_STREAM_TAKE);
        live.attached = true;
        break;
      } catch (err) {
        const notAttachedYet = err instanceof CrucibleRefused && err.code === 'stream_not_attached'
          && !live.attached && this.live === live && Date.now() < waitUntil;
        if (notAttachedYet) {
          // See ATTACH_WAIT_MS: the SDK's stream has not attached yet.
          if (!waitedOnce) {
            waitedOnce = true;
            console.log(`[CrucibleStream] first row of session ${live.session.sessionId} is waiting for the `
              + 'event stream to attach (SDK exposes no attach signal; see ATTACH_WAIT_MS)');
          }
          await new Promise((r) => setTimeout(r, ATTACH_POLL_MS));
          continue;
        }
        live.rows.delete(id);
        const refusal = describeCrucibleStreamRefusal(err, this.server ?? '?');
        if (refusal instanceof CrucibleStreamRefused) return { success: false, error: refusal.message };
        throw refusal;
      }
    }
    return promise;
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
    const live = this.live;
    if (live === null) return;
    for (const [id, row] of live.rows) {
      if (row.cancelSent || row.settled || row.isCancelled?.() !== true) continue;
      row.cancelSent = true;
      void live.session.cancel(id).then(
        (outcome) => console.log(`[CrucibleStream] cancelled stale row ${id}: ${outcome}`),
        (err) => console.error(`[CrucibleStream] cancelling row ${id}: ${errorText(describeCrucibleStreamRefusal(err, this.server ?? '?'))}`),
      );
    }
  };

  stop = (): void => {
    const live = this.live;
    if (live === null) return;
    void live.session.cancelAll().then(
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
  /** The local narrator pool for the selected engine (the pre-2026-09-14 backend). */
  local(): StreamingEngine;
  /** The Crucible backend, already wrapped `observable()`. */
  crucible: StreamingEngine;
  /** The same Crucible engine, unwrapped, for `bind`. */
  crucibleEngine: CrucibleStreamingEngine;
  /** What `decideWhereGenerationRuns` reads. */
  venue: VenueHost;
  /**
   * The ONE legacy switch, read cheaply (the routing FILE only — never the
   * resolved view, which reads the local server's config through `wsl.exe`).
   * Decides which backend answers the sync questions before anything has
   * started, so the pickers show the right catalog.
   */
  legacySwitchIsOn(): boolean;
}

/**
 * A `StreamingEngine` that is one of two, decided at cold start.
 *
 * Every method delegates to the BOUND backend — the one the last
 * `startSession()` chose — or, before anything has started, to the backend the
 * legacy switch points at. `startSession()` is where the venue is decided, and
 * only when nothing is running: a live backend keeps answering until it is
 * ended, so a switch flipped mid-Listen takes effect at the next cold start,
 * exactly as an engine selection does.
 */
export function venueRoutedStreamingEngine(deps: VenueRoutedDeps): StreamingEngine {
  let bound: 'local' | 'crucible' | null = null;

  const backend = (): StreamingEngine => {
    if (bound === 'local') return deps.local();
    if (bound === 'crucible') return deps.crucible;
    return deps.legacySwitchIsOn() ? deps.local() : deps.crucible;
  };

  const startSession = async (): Promise<{ success: boolean; voices?: string[]; error?: string }> => {
    if (bound !== null && backend().isSessionActive()) {
      // Warm and running: the venue was decided when it was started.
      return backend().startSession();
    }
    let venue;
    try {
      venue = await decideWhereGenerationRuns(undefined, deps.venue);
    } catch (err) {
      // `no_enabled_server` / `no_reachable_server` / a corrupt record — in the
      // decision's own words, which name the settings page that fixes each.
      // NOT the local narrator: nothing streams on this machine by accident.
      const code = (err as { code?: unknown }).code;
      console.error(`[StreamVenue] Listen has nowhere to run: ${errorText(err)}`);
      return { success: false, error: typeof code === 'string' ? `${code}: ${errorText(err)}` : errorText(err) };
    }
    if (venue.where === 'legacy-local-narrator') {
      bound = 'local';
      console.log(`[StreamVenue] Listen renders through the local narrator: ${venue.because} `
        + '(Settings → Crucible Servers; removed after the in-app pass)');
      return deps.local().startSession();
    }
    bound = 'crucible';
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
      // Both backends batch and both define it; a backend that did not would be
      // a contract change, refused here rather than read as "one at a time".
      const engine = backend();
      if (typeof engine.getMaxConcurrentSentences !== 'function') {
        throw new Error('the bound streaming backend reports no batch width (getMaxConcurrentSentences)');
      }
      return engine.getMaxConcurrentSentences();
    },
    getEngineState: () => backend().getEngineState(),
    isServiceMode: () => backend().isServiceMode(),
    setServiceMode: (on) => backend().setServiceMode(on),
    onEngineState: (listener) => {
      // Both backends, because a state change on either is "the active engine
      // changed state" to a subscriber that only knows there is one engine.
      const offLocal = deps.local().onEngineState(() => listener(backend().getEngineState(), backend().isServiceMode()));
      const offCrucible = deps.crucible.onEngineState(() => listener(backend().getEngineState(), backend().isServiceMode()));
      return () => { offLocal(); offCrucible(); };
    },
    getStreamWorkerConfig: () => backend().getStreamWorkerConfig(),
    setStreamWorkerConfig: (updates) => backend().setStreamWorkerConfig(updates),
  };
}
