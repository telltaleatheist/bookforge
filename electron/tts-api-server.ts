/**
 * TTS API Server — WebSocket front door to the streaming TTS engine for
 * external clients (browser extension, other devices on the LAN).
 *
 * Speaks JSON text frames. A client must authenticate with the shared token
 * as its first message, then can drive the engine and request speech:
 *
 *   client → server
 *     {action:'hello',  token}
 *     {action:'status'}
 *     {action:'engine.start', voice?}
 *     {action:'engine.stop'}
 *     {action:'engine.restart', engine?, voice?, cpuWorkers?}  // switch engine / voice / workers and restart
 *     {action:'config.get'}                            // read engine topology
 *     {action:'config.set', engine?, cpuWorkers?, voice?, idleMinutes?}  // select engine; persist worker count; warm voice; idle window
 *     {action:'speak',  requestId, text, settings?:{voice?, speed?, temperature?, topP?, repetitionPenalty?}, preempt?, background?, startSentence?, fastStart?}
 *     {action:'playhead', requestId, sentenceIndex}   // advances the lookahead window; promotes a background block to playing
 *     {action:'cancel', requestId}
 *
 *   speak flags: preempt (default true) cancels OTHER CLIENTS' sessions so this
 *   block takes over the audio output — a client's own sessions are spared, so
 *   pressing play never destroys the read-ahead that client already rendered.
 *   background (default false) runs a read-ahead block at low pool priority
 *   alongside the playing one. The extension prefetches upcoming blocks with
 *   {preempt:false, background:true} so they all generate at once, keeping every
 *   worker busy even when each block is a one-sentence paragraph. startSentence
 *   (default 0) resumes a partly-rendered block: the client still holds the audio
 *   for the earlier sentences, so only the tail is generated.
 *
 *   fastStart (default false) is the client saying it would rather hear something
 *   in a second than be guaranteed a read with no holes — the browser extension's
 *   "Buffer before playing" switch, turned OFF (Owen's ruling of 2026-09-04). The
 *   session's sentences then arrive as SEVERAL 'chunk' events each, emitted while
 *   the sentence is still generating, followed by its 'done'. Nothing else about
 *   the protocol changes and no client has to opt in: absent or false is the
 *   behaviour every client had before the flag existed. It is honoured only for a
 *   FOREGROUND speak (background read-ahead never streams — see
 *   stream-scheduler's StartOptions.fastStart).
 *
 *   An explicit settings.voice is a CONTRACT: the engine is loaded with that voice
 *   and the speak is rejected if it somehow isn't, rather than quietly rendering in
 *   whatever model happened to be warm. Only a speak that omits the voice inherits
 *   the engine's live/last/default one.
 *
 *   server → client
 *     {type:'hello',    state, serviceMode, voices, currentVoice, config, version}
 *     {type:'status',   state, serviceMode, voices, currentVoice, config}
 *     {type:'config',   config, voices, currentVoice}  // reply to config.* / engine.restart
 *     {type:'state',    state, serviceMode}            // pushed on engine state changes
 *     {type:'speaking', requestId, sentences}          // text was segmented; generation started
 *     {type:'chunk',    requestId, sentenceIndex, seq, data(pcm16 b64), duration, sampleRate}
 *     {type:'done',     requestId, sentenceIndex, duration}
 *     {type:'failed',   requestId, sentenceIndex, error}
 *     {type:'complete', requestId}
 *     {type:'cancelled',requestId}                     // stopped or preempted
 *     {type:'error',    requestId?, recordId?, code?, message}
 *
 *   Tab recording (docs/TAB_RECORDER.md) rides the same socket and never touches
 *   the stream scheduler — a `speak` while recording is fine, and vice versa:
 *
 *     {action:'record.start',  recordId, title, sampleRate, channels, speed?, outputDir?, sourceUrl?}
 *     {action:'record.stop',   recordId}
 *     {action:'record.cancel', recordId}
 *     {action:'record.mark',   recordId, label, seconds}   // no reply
 *     ...plus BINARY frames of raw f32le interleaved PCM, legal only between
 *     record.started and record.stop/cancel.
 *
 *     {type:'record.started',  recordId, path}
 *     {type:'record.progress', recordId, seconds, bytes}   // ~1 Hz
 *     {type:'record.done',     recordId, path, seconds, bytes}
 *     {type:'record.cancelled',recordId}
 *
 *   `code` is present only where a client can usefully branch on it. Today that is
 *   409: the requested voice needs a different model than the one loaded, and another
 *   session is streaming on it — a CONFLICT, not a bad request. Retrying later works;
 *   retrying immediately does not.
 *
 * Playback control (pause/seek/rewind) is entirely client-side: the client
 * keeps the PCM it receives, so the only transport verbs here are speak and
 * cancel. One generation session exists globally — a new speak (from any
 * client or a BookForge window) preempts the previous one, which is told via
 * {type:'cancelled'}.
 *
 * Binds 127.0.0.1 by default; set host '0.0.0.0' in tts-api.json (userData)
 * to allow other machines on the LAN. The token is required either way —
 * any webpage can open sockets to localhost ports.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { PlaySettings } from './orpheus-worker-pool';
import { streamScheduler } from './stream-scheduler';
import {
  getActiveEngine,
  getSelectedEngineName,
  getAvailableEngines,
  getStreamConfigPayload,
  getDefaultStreamVoice,
  setDefaultStreamVoice,
  setStreamConfig,
  onActiveEngineState,
  onStreamConfigChanged,
} from './streaming-engine';
import { setIdleMinutes } from './stream-idle';
import { setRecordingDirsStore, sweepPartialRecordings, tabRecorder } from './tab-recording';

export interface TtsApiConfig {
  port: number;
  /** '127.0.0.1' (local only) or '0.0.0.0' (LAN) */
  host: string;
  token: string;
}

export interface TtsApiStatus {
  running: boolean;
  port: number;
  host: string;
  token: string;
  /** URLs clients can connect to (LAN addresses when host is 0.0.0.0) */
  addresses: string[];
}

const DEFAULT_PORT = 8766;
const AUTH_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = 1;

// The BookForge Reader extension's pinned id (from its manifest "key"). A
// browser stamps every WebSocket with an Origin header that page JavaScript
// cannot forge, so a connection from this exact origin is provably our
// extension — it's authorised WITHOUT a token, which is why users never paste
// one. Any other origin (a random website opening ws://localhost) still needs
// the shared token. NOTE: a non-browser client (curl, native code) can send any
// Origin, so on LAN (host 0.0.0.0) this is weaker than the token — but local
// native malware could read the token file anyway, so for the real threat (a
// drive-by webpage) origin-pinning is the right gate. Keep in sync with
// extension/static/manifest.json "key".
const ALLOWED_EXTENSION_ID = 'cjplggiaioccjfpagkgddldgaemggllc';

function isTrustedOrigin(origin: string | undefined): boolean {
  return origin === `chrome-extension://${ALLOWED_EXTENSION_ID}`;
}

/** `ws` hands a binary frame over as a Buffer, an ArrayBuffer, or (for a
 *  fragmented message) an array of Buffers. All three are the same PCM. */
function toBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(raw);
}

interface ClientState {
  authed: boolean;
  /** True when the connection's Origin is our pinned extension — authorised
   *  without a token (the browser sets Origin and pages can't forge it). */
  originTrusted: boolean;
  /** requestIds of this client's in-flight speaks (the playing block plus any
   *  read-ahead blocks it prefetched concurrently). */
  activeRequestIds: Set<string | number>;
  /** The tab recording this connection owns, if any — ONE per client (and one
   *  per server). Binary frames belong to it, and its socket closing finalizes
   *  it rather than losing it. */
  recordId: string | null;
  /** When we last told this client it sent a binary frame outside a recording.
   *  A misbehaving client sends them at 10 Hz; it is told, not drowned. */
  lastStrayFrameAt: number;
}

export class TtsApiServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private config: TtsApiConfig | null = null;
  private userDataPath: string | null = null;
  private clients = new Map<WebSocket, ClientState>();
  private unsubscribeEngineState: (() => void) | null = null;
  private unsubscribeConfigChanged: (() => void) | null = null;
  // Voices whose model is installed (a subset of the full catalog). External
  // clients only see these. Refreshed at startup and whenever a voice is
  // downloaded, so the extension never lists a voice it can't play.
  private installedVoices: string[] = [];

  // ───────────────────────────────────────────────────────────────────────────
  // Config
  // ───────────────────────────────────────────────────────────────────────────

  private configPath(): string {
    if (!this.userDataPath) throw new Error('TTS API server not initialized with userDataPath');
    return path.join(this.userDataPath, 'tts-api.json');
  }

  loadConfig(userDataPath: string): TtsApiConfig {
    this.userDataPath = userDataPath;
    let config: Partial<TtsApiConfig> = {};
    try {
      config = JSON.parse(fs.readFileSync(this.configPath(), 'utf-8'));
    } catch {
      // First run (or unreadable) — write a fresh config below
    }
    const complete: TtsApiConfig = {
      port: typeof config.port === 'number' ? config.port : DEFAULT_PORT,
      host: config.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
      token: typeof config.token === 'string' && config.token.length >= 16
        ? config.token
        : crypto.randomBytes(24).toString('base64url')
    };
    fs.writeFileSync(this.configPath(), JSON.stringify(complete, null, 2));
    this.config = complete;
    return complete;
  }

  saveConfig(updates: Partial<Pick<TtsApiConfig, 'port' | 'host'>>): TtsApiConfig {
    if (!this.config) throw new Error('TTS API config not loaded');
    if (typeof updates.port === 'number') this.config.port = updates.port;
    if (updates.host) this.config.host = updates.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
    fs.writeFileSync(this.configPath(), JSON.stringify(this.config, null, 2));
    return this.config;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async start(userDataPath: string): Promise<TtsApiStatus> {
    if (this.wss) await this.stop();
    const config = this.config && this.userDataPath === userDataPath
      ? this.config
      : this.loadConfig(userDataPath);

    await new Promise<void>((resolve, reject) => {
      this.httpServer = http.createServer((_req, res) => {
        // Plain HTTP probe support: lets the extension cheaply detect BookForge
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'bookforge-tts', version: PROTOCOL_VERSION }));
      });
      this.wss = new WebSocketServer({ server: this.httpServer });
      this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
      this.httpServer.once('error', reject);
      this.httpServer.listen(config.port, config.host, () => {
        this.httpServer!.removeListener('error', reject);
        resolve();
      });
    });

    // Push engine state changes to every authenticated client. Bridged across
    // both engine pools so the active engine's state is always reported, even
    // when the previously-active pool stops during an engine switch.
    this.unsubscribeEngineState = onActiveEngineState((state, serviceMode) => {
      this.broadcast({ type: 'state', state, serviceMode });
      // The loaded voice is part of engine state: a stop (or a worker crash) drops
      // the model, so `currentVoice` falls back to the persisted default. Clients
      // mirror the voice we report, so they have to hear about that here — nothing
      // else fires for it, and a client left holding the dead model's name would
      // advertise a narrator that is no longer loaded.
      this.broadcast({ type: 'config', ...this.configPayload() });
    });

    // Live-sync the voice/engine selection to every client: when it changes from
    // ANY source (in-app Settings picker, or another extension client), push a
    // fresh `config` so all pickers reflect it. Refresh the installed-voice list
    // first (an engine switch changes the voice set).
    this.unsubscribeConfigChanged = onStreamConfigChanged(() => {
      void this.refreshInstalledVoices();
      this.broadcast({ type: 'config', ...this.configPayload() });
    });

    // Populate the installed-voice list before the first client connects.
    await this.refreshInstalledVoices();

    // No recording can be live at this instant, so any `.partial.flac` left in a
    // folder we have recorded into is debris from a run that died (app quit,
    // power cut). Clearing it here is what makes "a .flac in your Downloads is a
    // finished recording" true. The folder list is machine-local, beside the
    // API config — see tab-recording.ts.
    setRecordingDirsStore(path.join(userDataPath, 'tab-recordings.json'));
    const swept = await sweepPartialRecordings();
    if (swept.length > 0) {
      console.log(`[REC] swept ${swept.length} unfinished recording(s): ${swept.join(', ')}`);
    }

    console.log(`[TTS API] Listening on ws://${config.host}:${config.port}`);
    return this.getStatus();
  }

  async stop(): Promise<void> {
    // The app is going away with a capture live: finalize it here rather than
    // racing the sockets' close handlers, which may never run before exit. The
    // file is complete up to the last frame, which is the whole point.
    await tabRecorder.finalizeOrphan('TTS API server stopping');
    this.unsubscribeEngineState?.();
    this.unsubscribeEngineState = null;
    this.unsubscribeConfigChanged?.();
    this.unsubscribeConfigChanged = null;
    for (const ws of this.clients.keys()) {
      ws.close(1001, 'server shutting down');
    }
    this.clients.clear();
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  isRunning(): boolean {
    return this.wss !== null;
  }

  getStatus(): TtsApiStatus {
    const config = this.config;
    if (!config) {
      return { running: false, port: DEFAULT_PORT, host: '127.0.0.1', token: '', addresses: [] };
    }
    const addresses: string[] = [];
    if (this.isRunning()) {
      if (config.host === '0.0.0.0') {
        for (const ifaces of Object.values(os.networkInterfaces())) {
          for (const iface of ifaces ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) {
              addresses.push(`ws://${iface.address}:${config.port}`);
            }
          }
        }
      }
      addresses.unshift(`ws://127.0.0.1:${config.port}`);
    }
    return { running: this.isRunning(), port: config.port, host: config.host, token: config.token, addresses };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connection handling
  // ───────────────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const state: ClientState = {
      authed: false,
      originTrusted: isTrustedOrigin(req.headers.origin),
      activeRequestIds: new Set(),
      recordId: null,
      lastStrayFrameAt: 0
    };
    this.clients.set(ws, state);

    const authTimer = setTimeout(() => {
      if (!state.authed) ws.close(4401, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw, isBinary) => {
      // The binary branch comes FIRST and never reaches JSON.parse: a recording
      // frame is raw f32le PCM, and parsing it would burn CPU on every 100 ms of
      // audio only to fail.
      if (isBinary) {
        this.handleBinaryFrame(ws, state, toBuffer(raw));
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.send(ws, { type: 'error', message: 'invalid JSON' });
        return;
      }
      void this.handleMessage(ws, state, msg).catch((err) => {
        this.send(ws, { type: 'error', message: (err as Error).message });
      });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
      // A vanished client must not leave workers generating for nobody — stop
      // every session it had in flight (playing block + read-ahead blocks).
      for (const requestId of state.activeRequestIds) {
        if (streamScheduler.isActive(requestId)) streamScheduler.stop(requestId);
      }
      state.activeRequestIds.clear();
      // A recording, on the other hand, is KEPT: the file is complete up to the
      // last frame that arrived, so a dropped socket finalizes exactly as
      // record.stop would. No .partial.flac is ever left behind.
      if (state.recordId) {
        const id = state.recordId;
        state.recordId = null;
        void tabRecorder.finalizeOrphan(`client disconnected during recording '${id}'`);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tab recording (docs/TAB_RECORDER.md)
  // ───────────────────────────────────────────────────────────────────────────

  /** Raw PCM for the live recording. Everything else is a named error. */
  private handleBinaryFrame(ws: WebSocket, state: ClientState, data: Buffer): void {
    if (!state.authed) {
      ws.close(4401, 'not authenticated');
      return;
    }
    if (!state.recordId) {
      // Told once a second, not once a frame: this is a client bug, and burying
      // it is as wrong as flooding the socket with it.
      const now = Date.now();
      if (now - state.lastStrayFrameAt >= 1000) {
        state.lastStrayFrameAt = now;
        this.send(ws, {
          type: 'error',
          message: 'binary frame outside a recording — send record.start first'
        });
      }
      return;
    }
    try {
      tabRecorder.write(data);
    } catch (err) {
      // The encoder died under us (ffmpeg gone, disk full). The partial file is
      // debris, so the recording is cancelled and named rather than left to look
      // like it is still running.
      const recordId = state.recordId;
      state.recordId = null;
      void tabRecorder.cancel(recordId).catch(() => { /* already gone */ });
      this.send(ws, { type: 'error', recordId, message: (err as Error).message });
    }
  }

  private async handleRecordStart(
    ws: WebSocket,
    state: ClientState,
    msg: Record<string, unknown>
  ): Promise<void> {
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    if (!recordId) {
      this.send(ws, { type: 'error', message: 'record.start requires a recordId' });
      return;
    }
    if (state.recordId) {
      this.send(ws, {
        type: 'error',
        recordId,
        message: `this connection is already recording '${state.recordId}' — one recording per client`
      });
      return;
    }
    if (tabRecorder.isRecording()) {
      this.send(ws, { type: 'error', recordId, message: tabRecorder.busyMessage() });
      return;
    }
    const title = typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim() : 'tab-audio';
    try {
      const session = await tabRecorder.start(
        {
          recordId,
          title,
          sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : NaN,
          channels: typeof msg.channels === 'number' ? msg.channels : NaN,
          // Speed capture: the file is written at sampleRate / speed. Absent or
          // 1 means an ordinary realtime capture.
          speed: typeof msg.speed === 'number' ? msg.speed : 1,
          // Where the user wants it. May start with `~`; the session expands it
          // and refuses anything that is not absolute afterwards.
          outputDir: typeof msg.outputDir === 'string' ? msg.outputDir : null,
          sourceUrl: typeof msg.sourceUrl === 'string' ? msg.sourceUrl : null
        },
        {
          onProgress: (progress) => this.send(ws, { type: 'record.progress', ...progress })
        }
      );
      state.recordId = recordId;
      // The FINAL path, not the .partial.flac: it is where the file will be, and
      // it is what the popup shows while recording.
      this.send(ws, { type: 'record.started', recordId, path: session.finalPath });
      console.log(
        `[REC] recording '${title}' → ${session.finalPath} ` +
        `(${session.sampleRate} Hz, ${session.channels} ch, 24-bit` +
        (session.speed !== 1
          ? `, ${session.speed}x from a ${session.captureSampleRate} Hz capture`
          : '') +
        ')'
      );
    } catch (err) {
      this.send(ws, { type: 'error', recordId, message: (err as Error).message });
    }
  }

  private async handleRecordStop(
    ws: WebSocket,
    state: ClientState,
    msg: Record<string, unknown>
  ): Promise<void> {
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    if (!state.recordId || state.recordId !== recordId) {
      this.send(ws, {
        type: 'error',
        recordId,
        message: `record.stop: this connection has no recording '${recordId}'`
      });
      return;
    }
    state.recordId = null;
    try {
      const result = await tabRecorder.stop(recordId);
      this.send(ws, {
        type: 'record.done',
        recordId,
        path: result.path,
        seconds: result.seconds,
        bytes: result.bytes
      });
      console.log(`[REC] saved ${result.path} (${result.seconds.toFixed(1)}s, ${result.bytes} B)`);
    } catch (err) {
      this.send(ws, { type: 'error', recordId, message: (err as Error).message });
    }
  }

  private async handleRecordCancel(
    ws: WebSocket,
    state: ClientState,
    msg: Record<string, unknown>
  ): Promise<void> {
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    if (!state.recordId || state.recordId !== recordId) {
      this.send(ws, {
        type: 'error',
        recordId,
        message: `record.cancel: this connection has no recording '${recordId}'`
      });
      return;
    }
    state.recordId = null;
    try {
      await tabRecorder.cancel(recordId);
      this.send(ws, { type: 'record.cancelled', recordId });
      console.log(`[REC] discarded recording '${recordId}'`);
    } catch (err) {
      this.send(ws, { type: 'error', recordId, message: (err as Error).message });
    }
  }

  private async handleMessage(
    ws: WebSocket,
    state: ClientState,
    msg: Record<string, unknown>
  ): Promise<void> {
    const action = msg.action;

    if (action === 'hello') {
      // Our pinned extension is trusted by Origin and needs no token; any other
      // client (LAN device, script) must present the shared token.
      if (!state.originTrusted && !this.tokenMatches(msg.token)) {
        ws.close(4401, 'unauthorized');
        return;
      }
      state.authed = true;
      this.send(ws, { type: 'hello', version: PROTOCOL_VERSION, ...this.statusPayload() });
      return;
    }

    if (!state.authed) {
      ws.close(4401, 'not authenticated');
      return;
    }

    switch (action) {
      case 'status':
        this.send(ws, { type: 'status', ...this.statusPayload() });
        return;

      case 'engine.start': {
        // The prewarm: the client showed its reader UI and nobody is waiting on
        // audio yet, so this is exactly the window the warm-up renders are for.
        await this.ensureEngine(typeof msg.voice === 'string' ? msg.voice : undefined, true);
        this.send(ws, { type: 'status', ...this.statusPayload() });
        return;
      }

      case 'engine.stop':
        await getActiveEngine().endSession();
        return;  // engine state push notifies all clients

      case 'engine.restart':
        await this.handleRestart(ws, msg);
        return;

      case 'config.get':
        this.send(ws, { type: 'config', ...this.configPayload() });
        return;

      case 'config.set':
        await this.handleConfigSet(ws, msg);
        return;

      case 'speak':
        await this.handleSpeak(ws, state, msg);
        return;

      case 'playhead': {
        const requestId = msg.requestId as string | number | undefined;
        const sentenceIndex = msg.sentenceIndex;
        // Ownership check (like 'cancel'): reportPlayhead promotes the session to
        // priority unconditionally, so a client must only be able to move its OWN
        // playhead — not another client's.
        if (requestId !== undefined && typeof sentenceIndex === 'number' &&
            state.activeRequestIds.has(requestId) &&
            streamScheduler.isActive(requestId)) {
          streamScheduler.reportPlayhead(requestId, sentenceIndex);
        }
        return;
      }

      case 'cancel': {
        const requestId = msg.requestId as string | number | undefined;
        if (requestId !== undefined && state.activeRequestIds.has(requestId)) {
          streamScheduler.stop(requestId);
          state.activeRequestIds.delete(requestId);
        }
        return;
      }

      // ── Tab recording. Deliberately independent of the stream scheduler: a
      // speak while recording is fine, and record.* never touches generation.
      case 'record.start':
        await this.handleRecordStart(ws, state, msg);
        return;

      case 'record.stop':
        await this.handleRecordStop(ws, state, msg);
        return;

      case 'record.cancel':
        await this.handleRecordCancel(ws, state, msg);
        return;

      case 'record.mark': {
        // No reply, by contract — a mark is a note in the sidecar, not a
        // transaction. A mark for a recording this client doesn't own is dropped
        // with a log line rather than an error frame mid-capture.
        const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
        if (!state.recordId || state.recordId !== recordId) {
          console.warn(`[REC] mark for '${recordId}' ignored — not this connection's recording`);
          return;
        }
        try {
          tabRecorder.mark(
            recordId,
            typeof msg.label === 'string' ? msg.label : '',
            typeof msg.seconds === 'number' ? msg.seconds : NaN
          );
        } catch (err) {
          console.warn('[REC] mark ignored:', (err as Error).message);
        }
        return;
      }

      default:
        this.send(ws, { type: 'error', message: `unknown action: ${String(action)}` });
    }
  }

  private async handleSpeak(
    ws: WebSocket,
    state: ClientState,
    msg: Record<string, unknown>
  ): Promise<void> {
    const requestId = msg.requestId as string | number;
    const text = msg.text;
    if (requestId === undefined || requestId === null) {
      this.send(ws, { type: 'error', message: 'speak requires requestId' });
      return;
    }
    if (typeof text !== 'string' || !text.trim()) {
      this.send(ws, { type: 'error', requestId, message: 'speak requires non-empty text' });
      return;
    }

    const engine = getActiveEngine();
    const requested = (msg.settings ?? {}) as Partial<PlaySettings>;
    // An EXPLICIT voice is a contract, not a hint: whatever the client's picker
    // shows is what must speak. Only when the client sends none do we fall back
    // to the engine's live/last/default voice — and `lastVoice` (whatever the app
    // itself happened to load earlier this run) is exactly how a request used to
    // come out in a model the client never asked for.
    const voice = requested.voice
      || engine.getCurrentVoice()
      || engine.getLastVoice()
      || getDefaultStreamVoice();
    const settings: PlaySettings = {
      voice,
      speed: typeof requested.speed === 'number' ? requested.speed : 1.0,
      temperature: requested.temperature,
      topP: requested.topP,
      repetitionPenalty: requested.repetitionPenalty
    };

    // BEFORE the engine is touched: refuse a voice that would EVICT an engine another
    // session is streaming on right now.
    //
    // Voice loading is otherwise unrestricted, which is the point of per-request
    // voices — but only voices that share an engine are actually free. A merged
    // fine-tune (or a voice on a different base) forces a full rebuild: ~6 GB of
    // weights and a CUDA-graph recapture, during which the other session's engine
    // simply does not exist. Two clients alternating such voices would reload the
    // engine on every block, forever, each destroying the other's progress. Since
    // ensureEngine does the load, the check has to happen here, before it.
    //
    // Deliberately narrow: this is a brake, not a queue. Same-engine switches
    // (adapter or stock over the shared base) stay unrestricted, and a client is never
    // blocked by its OWN sessions. Nothing is deferred or retried — the client is told
    // no, with both voices named, and decides what to do.
    if (engine.wouldRebuildEngine?.(voice) === true) {
      const others = streamScheduler.activeIds().filter((id) => !state.activeRequestIds.has(id));
      if (others.length > 0) {
        const loaded = engine.getCurrentVoice();
        this.send(ws, {
          type: 'error',
          requestId,
          code: 409,
          message:
            `'${voice}' needs a different model than the one loaded${loaded ? ` ('${loaded}')` : ''}, ` +
            `and ${others.length} other session${others.length === 1 ? ' is' : 's are'} streaming on it right now. ` +
            `Loading '${voice}' would tear that engine down mid-sentence. Retry when the other session finishes, ` +
            `or use a voice that shares the loaded model.`,
        });
        return;
      }
    }

    // Cold engine: start it now. The client sees progress via 'state' pushes.
    // warm:false — this speak is the reason the engine is starting, so the listener
    // is already waiting; the first batch pays the compile instead of a warmup.
    const started = await this.ensureEngine(voice, false);
    if (!started.success) {
      this.send(ws, { type: 'error', requestId, message: started.error || 'engine failed to start' });
      return;
    }
    // Prove the promise rather than assume it. ensureEngine's loadVoice reports
    // success, but a concurrent load (another client, or the app's own Listen tab)
    // can land between it and the dispatch below — and when the loaded model IS the
    // voice, generating anyway would ship audio in the wrong narrator.
    //
    // That is only true of an EXCLUSIVE voice. Orpheus built-ins are a prompt prefix
    // and adapter voices are a per-request LoRA over a shared base: several coexist
    // on one engine, every sentence carries its own voice, and "loaded" is merely the
    // default for requests that name none. Applying the guard to those would make
    // concurrent clients on different voices reject each other for no reason — each
    // one's load would break the other's session. So the guard now covers exactly the
    // voices that really are exclusive (a merged Orpheus fine-tune, and any future
    // pool that does not implement the capability at all).
    const loaded = engine.getCurrentVoice();
    const perRequest = requested.voice
      ? engine.canServeVoicePerRequest?.(requested.voice) === true
      : false;
    if (!perRequest && requested.voice && loaded && loaded.toLowerCase() !== requested.voice.toLowerCase()) {
      this.send(ws, {
        type: 'error',
        requestId,
        message: `engine is loaded with '${loaded}', not the requested '${requested.voice}'`
      });
      return;
    }

    const { splitForTts } = await import('./text-ai.js');
    // PUNCTUATION ONLY, and nothing else, on the streaming path.
    //
    // The book path runs three stages (`foundry clean-text`):
    // punctuation, the number rules, then a model on the residue. Only the first
    // belongs here — it is pure, instant and has no opinion to get wrong, so the
    // reader's text reaches the voice with the same canonical ellipsis and the
    // same quotes an audiobook does. The other two are minutes of model time over
    // a book and are a PASS the user runs, not something to do to a paragraph
    // somebody is waiting to hear.
    const { canonicalizePunctuationText } = await import('./tts-punctuation.js');
    const speakable = canonicalizePunctuationText(text);
    // Orpheus packs to ITS OWN voice's cap — the same voice-manifest channel the
    // audiobook path reads for ORPHEUS_MAX_CHARS. Unconditional since 2026-09-05:
    // the ternary that guarded it fell back to splitForTts's XTTS default for any
    // other engine, and there is no other streaming engine left.
    const maxChars = (await import('./orpheus-models.js')).orpheusStreamMaxChars(voice);
    const sentences = splitForTts(speakable, 'en', maxChars);
    if (sentences.length === 0) {
      this.send(ws, { type: 'error', requestId, message: 'no sentences found in text' });
      return;
    }

    // preempt (default true): take over the audio output. It cancels OTHER
    // clients' sessions but deliberately spares this client's own — a client that
    // prefetches upcoming blocks would otherwise destroy its own read-ahead every
    // time the user pressed play, throwing away audio that was already rendered.
    // background (default false): a read-ahead block — coexist with the playing
    // session at low pool priority.
    const preempt = msg.preempt !== false;
    const background = msg.background === true;
    // The client's "I'd rather hear something now" flag. Strictly opt-in — anything
    // but an explicit true is the pre-2026-09-04 path — and the scheduler ignores it
    // on a background session anyway, so a client that sets it blanket-wide still
    // only streams the block being listened to.
    const fastStart = msg.fastStart === true;
    if (preempt) {
      for (const id of streamScheduler.activeIds()) {
        if (!state.activeRequestIds.has(id) && id !== requestId) streamScheduler.stop(id);
      }
    }

    // A resumed block: sentences before this index were rendered on an earlier
    // pass and are still held by the client, so only the tail needs generating.
    const startSentence = typeof msg.startSentence === 'number'
      ? Math.max(0, Math.min(Math.floor(msg.startSentence), sentences.length - 1))
      : 0;

    state.activeRequestIds.add(requestId);
    const sink = (event: Record<string, unknown>) => {
      // A terminal event frees this requestId from the client's in-flight set.
      if (event.kind === 'complete' || event.kind === 'cancelled') {
        state.activeRequestIds.delete(requestId);
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      // Scheduler events use 'kind'; the wire protocol uses 'type'
      const { kind, ...rest } = event;
      this.send(ws, { type: kind, ...rest });
    };

    // Echo the segmentation before audio starts so the client can index chunks.
    // startSentence rides along so a resuming client can verify its cached prefix
    // still lines up with this segmentation before splicing new audio onto it.
    this.send(ws, { type: 'speaking', requestId, sentences, startSentence });
    const result = streamScheduler.start(sentences, startSentence, settings, requestId, sink, {
      // Preemption is handled above (scoped to other clients), so the scheduler
      // must not run its own stopAll — that would take this client's read-ahead
      // down with everyone else's.
      preempt: false,
      priority: !background,
      fastStart
    });
    if (!result.success) {
      state.activeRequestIds.delete(requestId);
      this.send(ws, { type: 'error', requestId, message: result.error || 'failed to start generation' });
    }
  }

  /**
   * Persist a new CPU worker count and/or warm a voice without restarting. The
   * worker count only takes effect on the next engine start (the pool is never
   * resized live), so this is the "save settings" path; engine.restart applies it.
   */
  private async handleConfigSet(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    // WHICH ENGINE. Applied FIRST, because everything after it — the voice, the
    // worker count — is per-engine: a voice is a name in one engine's catalog and
    // means nothing in the other's, so setting it against the outgoing engine and
    // then switching would persist it in the wrong place.
    //
    // It does not restart a running engine. `setSelectedEngineName` stops the
    // previously-active pool and the choice takes effect on the next start, which
    // is what `engine.restart` is for — a client that wants the switch NOW sends
    // both, exactly as it already does for cpuWorkers.
    //
    // An unknown or unavailable name is REFUSED by setStreamConfig, by name, and
    // the refusal is reported rather than swallowed: a client told "ok" while the
    // old engine kept rendering is the failure this whole message exists to avoid.
    // A PRESENT but unusable `engine` is refused, not skipped. `{"engine": 123}` or
    // `{"engine": ""}` used to fall through to a plain `config` reply with the old
    // engine still selected — the client is told the message succeeded and goes on
    // believing it switched. Absent is a different thing and stays a no-op.
    if ('engine' in msg && (typeof msg.engine !== 'string' || !msg.engine)) {
      this.send(ws, {
        type: 'error',
        message: `engine must be a non-empty string; got ${JSON.stringify(msg.engine)}`,
      });
      this.send(ws, { type: 'config', ...this.configPayload() });
      return;
    }
    if ('engine' in msg && (typeof msg.engine !== 'string' || !msg.engine)) {
      this.send(ws, {
        type: 'error',
        message: `engine must be a non-empty string; got ${JSON.stringify(msg.engine)}`,
      });
      this.send(ws, { type: 'status', ...this.statusPayload() });
      return;
    }
    if (typeof msg.engine === 'string' && msg.engine) {
      try {
        await setStreamConfig({ engine: msg.engine });
      } catch (err) {
        this.send(ws, {
          type: 'error',
          message: err instanceof Error ? err.message : `failed to select engine '${msg.engine}'`,
        });
        this.send(ws, { type: 'config', ...this.configPayload() });
        return;
      }
    }
    // Worker count, AFTER the switch — `applyClientWorkerCount` reads
    // `getActiveEngine()`, so running it first would write the user's setting onto
    // the engine they are leaving and the switch would discard it. That is what the
    // comment above has always claimed and what the code did not do.
    this.applyClientWorkerCount(msg);
    // Idle-shutdown window (minutes; 0 = never). Takes effect on the running
    // engine's next sweep, so there's nothing to restart.
    if (typeof msg.idleMinutes === 'number') {
      setIdleMinutes(msg.idleMinutes);
    }
    // Persist the chosen voice as the shared default (and warm it live if the
    // engine is running). This is the single source of truth the in-app Settings
    // picker reads too, so an extension change shows up there — and the change
    // event broadcasts a fresh `config` to every other client below.
    //
    // A live load that FAILS must be reported: on Orpheus the voice is a whole
    // model, and a client that treats "switched" as fire-and-forget would keep
    // rendering in the old narrator with no sign anything went wrong. The config
    // reply still goes out, carrying the voice that is genuinely loaded.
    if (typeof msg.voice === 'string' && msg.voice) {
      const applied = await setDefaultStreamVoice(msg.voice);
      if (!applied.success) {
        this.send(ws, { type: 'error', message: applied.error || `failed to load voice '${msg.voice}'` });
      }
    }
    this.send(ws, { type: 'config', ...this.configPayload() });
  }

  /**
   * Stop and restart the pool so a new worker count takes effect, optionally
   * warming a chosen voice. Preserves service mode across the bounce (endSession
   * clears it) so a resident server stays resident after the restart.
   */
  private async handleRestart(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const voice = typeof msg.voice === 'string' && msg.voice ? msg.voice : undefined;

    // Residency is captured BEFORE the switch, deliberately, and it is the one thing
    // here that is not per-engine. "Is a client holding this server resident" is a
    // property of the session, not of whichever pool is loaded: a user who switches
    // engine and restarts wants the server still resident afterwards. Reading it
    // after the switch would ask a pool that has not been started yet, get `false`,
    // and quietly drop residency on every engine change.
    const wasService = getActiveEngine().isServiceMode();

    // The engine switch happens BEFORE the teardown below, so `getActiveEngine()`
    // from here on is the engine being restarted INTO. Selecting one already stops
    // the outgoing pool, which is why this is safe to do first and why the
    // endSession below is not redundant — it covers the no-switch case.
    if (typeof msg.engine === 'string' && msg.engine) {
      try {
        await setStreamConfig({ engine: msg.engine });
      } catch (err) {
        this.send(ws, {
          type: 'error',
          message: err instanceof Error ? err.message : `failed to select engine '${msg.engine}'`,
        });
        this.send(ws, { type: 'status', ...this.statusPayload() });
        return;
      }
    }

    // The worker count, on the other hand, IS per-engine, and it goes after the
    // switch. Before it, `applyClientWorkerCount` read `getActiveEngine()` and wrote
    // the user's setting onto the pool they were leaving, where the switch discarded
    // it — a silently ignored setting rather than a visible failure.
    this.applyClientWorkerCount(msg);

    await getActiveEngine().endSession();
    // A restart is a settings action, not a play action — no audio is pending, so
    // the engine comes back fully warmed.
    const started = await this.ensureEngine(voice, true);
    if (started.success && wasService) getActiveEngine().setServiceMode(true);

    if (!started.success) {
      this.send(ws, { type: 'error', message: started.error || 'engine failed to restart' });
    }
    // status carries the new topology (activeWorkers reflects the resized pool).
    this.send(ws, { type: 'status', ...this.statusPayload() });
  }

  /**
   * Apply a worker count sent by an external client (browser extension), but
   * only when the app has enabled the multi-worker capability — the gate is an
   * app-level decision, so a client can pick a count within it, not turn it on.
   */
  private applyClientWorkerCount(msg: Record<string, unknown>): void {
    if (typeof msg.cpuWorkers !== 'number') return;
    const engine = getActiveEngine();
    if (!engine.getStreamWorkerConfig().enabled) return;
    engine.setStreamWorkerConfig({ count: msg.cpuWorkers });
  }

  /** Engine state + voices + topology, shared by hello/status. The `config` blob
   *  carries the active engine's worker topology plus the engine selection
   *  (`engine`) and availability (`engines`) for clients that surface a chooser. */
  private statusPayload(): Record<string, unknown> {
    const engine = getActiveEngine();
    return {
      state: engine.getEngineState(),
      serviceMode: engine.isServiceMode(),
      voices: this.installedVoices,
      // The EFFECTIVE voice: the live-loaded one, else the persisted default. So
      // every picker reflects the chosen voice even when nothing is playing (a
      // change while idle persists the default but doesn't load it live).
      currentVoice: engine.getCurrentVoice() || getDefaultStreamVoice(),
      engine: getSelectedEngineName(),
      engines: getAvailableEngines(),
      config: getStreamConfigPayload()
    };
  }

  /** Topology + voices, for the dedicated config event. */
  private configPayload(): Record<string, unknown> {
    return {
      config: getStreamConfigPayload(),
      voices: this.installedVoices,
      currentVoice: getActiveEngine().getCurrentVoice() || getDefaultStreamVoice(),
      engine: getSelectedEngineName(),
      engines: getAvailableEngines()
    };
  }

  /**
   * Recompute which voices are installed and push the new list to connected
   * clients. Called at startup and whenever a voice download completes, so the
   * extension's voice list updates live without a reconnect.
   */
  async refreshInstalledVoices(): Promise<void> {
    try {
      // Orpheus voices are built into the model (no per-voice download), so the
      // "installed" list is simply the engine's voice set. It used to branch here
      // for XTTS, whose voices each needed their own checkpoint on disk; that pool
      // is gone, and with it the only engine whose voice list was a subset of its
      // catalog.
      const next: string[] = getActiveEngine().getAvailableVoices();
      const changed =
        next.length !== this.installedVoices.length ||
        next.some((v, i) => v !== this.installedVoices[i]);
      this.installedVoices = next;
      // Only broadcast when there are clients and the list actually changed.
      if (changed && this.clients.size > 0) {
        this.broadcast({ type: 'config', ...this.configPayload() });
      }
    } catch (err) {
      console.error('[TTS API] Failed to refresh installed voices:', err);
    }
  }

  /**
   * Start the worker pool (no-op if running) and load the voice.
   *
   * `warm` is NOT optional, because the whole point is that every call site states
   * whether a person is waiting. true = nobody is (the extension's engine.start
   * prewarm while the reader UI is shown, a settings restart): pay the engine's
   * discarded warm-up renders here, where the wait is free. false = a speak is
   * pending: skip them, and let the first real batch absorb the one-off lazy
   * compile instead of putting ~40s of unheard audio in front of the listener.
   */
  private async ensureEngine(
    voice: string | undefined,
    warm: boolean
  ): Promise<{ success: boolean; error?: string }> {
    const engine = getActiveEngine();
    const result = await engine.startSession();
    if (!result.success) return { success: false, error: result.error };
    const warmVoice = voice || engine.getCurrentVoice() || engine.getLastVoice() || getDefaultStreamVoice();
    const loaded = await engine.loadVoice(warmVoice, { warm });
    if (!loaded.success) return { success: false, error: loaded.error };
    return { success: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private tokenMatches(token: unknown): boolean {
    if (typeof token !== 'string' || !this.config) return false;
    const expected = crypto.createHash('sha256').update(this.config.token).digest();
    const actual = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(expected, actual);
  }

  private send(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private broadcast(data: Record<string, unknown>): void {
    for (const [ws, state] of this.clients) {
      if (state.authed) this.send(ws, data);
    }
  }
}

export const ttsApiServer = new TtsApiServer();
