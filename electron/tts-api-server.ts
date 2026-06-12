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
 *     {action:'config.set', cpuWorkers?, voice?}       // persist worker count; warm voice
 *     {action:'speak',  requestId, text, settings?:{voice?, speed?, temperature?, topP?, repetitionPenalty?}, preempt?, background?}
 *     {action:'playhead', requestId, sentenceIndex}   // advances the lookahead window; promotes a background block to playing
 *     {action:'cancel', requestId}
 *
 *   speak flags: preempt (default true) cancels other sessions so this block takes
 *   over the audio output; background (default false) runs a read-ahead block at
 *   low pool priority alongside the playing one. The extension prefetches upcoming
 *   blocks with {preempt:false, background:true} so they all generate at once,
 *   keeping every CPU worker busy even when each block is a one-sentence paragraph.
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
 *     {type:'error',    requestId?, message}
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
import { xttsWorkerPool, PlaySettings, EngineState } from './xtts-worker-pool';
import { streamScheduler } from './stream-scheduler';

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
const DEFAULT_VOICE = 'ScarlettJohansson';

interface ClientState {
  authed: boolean;
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
      this.wss.on('connection', (ws) => this.handleConnection(ws));
      this.httpServer.once('error', reject);
      this.httpServer.listen(config.port, config.host, () => {
        this.httpServer!.removeListener('error', reject);
        resolve();
      });
    });

    // Push engine state changes to every authenticated client
    this.unsubscribeEngineState = xttsWorkerPool.onEngineState((state, serviceMode) => {
      this.broadcast({ type: 'state', state, serviceMode });
    });

    console.log(`[TTS API] Listening on ws://${config.host}:${config.port}`);
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.unsubscribeEngineState?.();
    this.unsubscribeEngineState = null;
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

  private handleConnection(ws: WebSocket): void {
    const state: ClientState = { authed: false, activeRequestIds: new Set() };
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
      if (!this.tokenMatches(msg.token)) {
        ws.close(4401, 'invalid token');
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
        await this.ensureEngine(typeof msg.voice === 'string' ? msg.voice : undefined);
        this.send(ws, { type: 'status', ...this.statusPayload() });
        return;
      }

      case 'engine.stop':
        await xttsWorkerPool.endSession();
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
        if (requestId !== undefined && typeof sentenceIndex === 'number' &&
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

    const requested = (msg.settings ?? {}) as Partial<PlaySettings>;
    const voice = requested.voice
      || xttsWorkerPool.getCurrentVoice()
      || xttsWorkerPool.getLastVoice()
      || DEFAULT_VOICE;
    const settings: PlaySettings = {
      voice,
      speed: typeof requested.speed === 'number' ? requested.speed : 1.0,
      temperature: requested.temperature,
      topP: requested.topP,
      repetitionPenalty: requested.repetitionPenalty
    };

    // Cold engine: start it now. The client sees progress via 'state' pushes.
    const started = await this.ensureEngine(voice);
    if (!started.success) {
      this.send(ws, { type: 'error', requestId, message: started.error || 'engine failed to start' });
      return;
    }

    const { splitForTts } = await import('./bilingual-processor.js');
    const sentences = splitForTts(text, 'en');
    if (sentences.length === 0) {
      this.send(ws, { type: 'error', requestId, message: 'no sentences found in text' });
      return;
    }

    // preempt (default true): take over the audio output, cancelling other
    // sessions. background (default false): a read-ahead block — coexist with the
    // playing session at low pool priority. The extension fans out read-ahead with
    // {preempt:false, background:true}; a plain client keeps the old take-over default.
    const preempt = msg.preempt !== false;
    const background = msg.background === true;

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

    // Echo the segmentation before audio starts so the client can index chunks
    this.send(ws, { type: 'speaking', requestId, sentences });
    const result = streamScheduler.start(sentences, 0, settings, requestId, sink, {
      preempt,
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
    if (typeof msg.cpuWorkers === 'number') {
      xttsWorkerPool.setStreamCpuWorkers(msg.cpuWorkers);
    }
    // A running engine can swap voices live; a stopped one just remembers it for
    // the next start (the client passes it again on engine.restart/start).
    if (typeof msg.voice === 'string' && msg.voice && xttsWorkerPool.getEngineState() === 'running') {
      const loaded = await xttsWorkerPool.loadVoice(msg.voice);
      if (!loaded.success) {
        this.send(ws, { type: 'error', message: loaded.error || 'failed to load voice' });
        return;
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
    if (typeof msg.cpuWorkers === 'number') {
      xttsWorkerPool.setStreamCpuWorkers(msg.cpuWorkers);
    }
    const wasService = xttsWorkerPool.isServiceMode();
    const voice = typeof msg.voice === 'string' && msg.voice ? msg.voice : undefined;

    await xttsWorkerPool.endSession();
    const started = await this.ensureEngine(voice);
    if (started.success && wasService) xttsWorkerPool.setServiceMode(true);

    if (!started.success) {
      this.send(ws, { type: 'error', message: started.error || 'engine failed to restart' });
    }
    // status carries the new topology (activeWorkers reflects the resized pool).
    this.send(ws, { type: 'status', ...this.statusPayload() });
  }

  /** Engine state + voices + topology, shared by hello/status. */
  private statusPayload(): Record<string, unknown> {
    return {
      state: xttsWorkerPool.getEngineState(),
      serviceMode: xttsWorkerPool.isServiceMode(),
      voices: xttsWorkerPool.getAvailableVoices(),
      currentVoice: xttsWorkerPool.getCurrentVoice(),
      config: xttsWorkerPool.getStreamWorkerConfig()
    };
  }

  /** Topology + voices, for the dedicated config event. */
  private configPayload(): Record<string, unknown> {
    return {
      config: xttsWorkerPool.getStreamWorkerConfig(),
      voices: xttsWorkerPool.getAvailableVoices(),
      currentVoice: xttsWorkerPool.getCurrentVoice()
    };
  }

  /** Start the worker pool (no-op if running) and warm the voice. */
  private async ensureEngine(voice?: string): Promise<{ success: boolean; error?: string }> {
    const result = await xttsWorkerPool.startSession();
    if (!result.success) return { success: false, error: result.error };
    const warmVoice = voice || xttsWorkerPool.getCurrentVoice() || xttsWorkerPool.getLastVoice() || DEFAULT_VOICE;
    const loaded = await xttsWorkerPool.loadVoice(warmVoice);
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
