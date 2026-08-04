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
 *     {action:'engine.restart', voice?, cpuWorkers?}   // apply a new worker count / voice
 *     {action:'config.get'}                            // read engine topology
 *     {action:'config.set', cpuWorkers?, voice?, idleMinutes?}  // persist worker count; warm voice; idle window
 *     {action:'speak',  requestId, text, settings?:{voice?, speed?, temperature?, topP?, repetitionPenalty?}, preempt?, background?, startSentence?}
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
 *     {type:'error',    requestId?, code?, message}
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
import { PlaySettings } from './xtts-worker-pool';
import { streamScheduler } from './stream-scheduler';
import {
  getActiveEngine,
  getSelectedEngineName,
  getAvailableEngines,
  getStreamConfigPayload,
  getDefaultStreamVoice,
  setDefaultStreamVoice,
  onActiveEngineState,
  onStreamConfigChanged,
} from './streaming-engine';
import { setIdleMinutes } from './stream-idle';

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

interface ClientState {
  authed: boolean;
  /** True when the connection's Origin is our pinned extension — authorised
   *  without a token (the browser sets Origin and pages can't forge it). */
  originTrusted: boolean;
  /** requestIds of this client's in-flight speaks (the playing block plus any
   *  read-ahead blocks it prefetched concurrently). */
  activeRequestIds: Set<string | number>;
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

    console.log(`[TTS API] Listening on ws://${config.host}:${config.port}`);
    return this.getStatus();
  }

  async stop(): Promise<void> {
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
      activeRequestIds: new Set()
    };
    this.clients.set(ws, state);

    const authTimer = setTimeout(() => {
      if (!state.authed) ws.close(4401, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
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
    });
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
    // voices that really are exclusive (a merged Orpheus fine-tune, and every XTTS
    // voice, whose pool does not implement the capability at all).
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

    const { splitForTts } = await import('./bilingual-processor.js');
    const sentences = splitForTts(text, 'en');
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
      priority: !background
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
    this.applyClientWorkerCount(msg);
    const wasService = getActiveEngine().isServiceMode();
    const voice = typeof msg.voice === 'string' && msg.voice ? msg.voice : undefined;

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
      // "installed" list is simply the engine's voice set. XTTS lists only voices
      // whose checkpoint is actually present.
      let next: string[];
      if (getSelectedEngineName() === 'orpheus') {
        next = getActiveEngine().getAvailableVoices();
      } else {
        const { getInstalledVoiceIds } = await import('./components/installed-voices.js');
        next = await getInstalledVoiceIds();
      }
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
