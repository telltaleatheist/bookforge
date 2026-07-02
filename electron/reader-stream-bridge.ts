/**
 * Reader Stream Bridge — WebSocket front door to the streaming TTS engine for the
 * Bookshelf web app's "Listen to anything" Reader (projects/bookshelf).
 *
 * This is the bookshelf-side twin of `tts-api-server.ts`. The difference:
 *   - tts-api-server is a STANDALONE ws server (its own port) for the Chrome
 *     extension + LAN clients, authed by a pinned Origin or a shared token.
 *   - This bridge rides the EXISTING bookshelf HTTP server (port 8765) via the
 *     `upgrade` event, and authenticates with the reader's own bearer token — the
 *     same identity the phone already uses for every /api call. No new port, no
 *     Origin dance; the phone is already a trusted, logged-in reader.
 *
 * Both drive the same in-process `streamScheduler`, so the wire protocol here is a
 * deliberate subset of the TTS API (no engine.start/config — engine lifecycle stays
 * owned by the app's Settings; the Reader only speaks and cancels):
 *
 *   client → server
 *     {action:'status'}
 *     {action:'speak',   requestId, text, settings?:{voice?, speed?, ...}, preempt?, background?}
 *     {action:'playhead', requestId, sentenceIndex}
 *     {action:'cancel',  requestId}
 *
 *   server → client
 *     {type:'hello',    state, voices, currentVoice, config, engine, engines}
 *     {type:'status',   ...same}
 *     {type:'speaking', requestId, sentences}
 *     {type:'chunk',    requestId, sentenceIndex, seq, data(pcm16 b64), duration, sampleRate}
 *     {type:'done',     requestId, sentenceIndex, duration}
 *     {type:'failed',   requestId, sentenceIndex, error}
 *     {type:'complete', requestId}
 *     {type:'cancelled',requestId}
 *     {type:'error',    requestId?, message}
 *
 * One generation session exists globally (shared with the app's Listen feature and
 * the extension): a new preempting speak cancels the previous one, which is told via
 * {type:'cancelled'} — the client keeps its already-received PCM playable.
 */

import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { streamScheduler } from './stream-scheduler';
import { PlaySettings } from './xtts-worker-pool';
import {
  getActiveEngine,
  getSelectedEngineName,
  getAvailableEngines,
  getStreamConfigPayload,
  getDefaultStreamVoice,
} from './streaming-engine';

/** Only requests to this path are upgraded to the Reader stream socket. */
const READER_WS_PATH = '/api/reader/ws';

/** Resolves a bearer token to a readerId, or null when the token is unknown. */
export type ReaderTokenResolver = (token: string) => string | null;

interface ReaderClientState {
  readerId: string;
  /** Sessions this socket has in flight, so a disconnect can stop them. */
  activeRequestIds: Set<string | number>;
}

export class ReaderStreamBridge {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ReaderClientState>();

  constructor() {
    // noServer: we drive handleUpgrade ourselves off the shared HTTP server so the
    // bookshelf Express app and this socket coexist on one port.
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Attach to the bookshelf HTTP server. Intercepts WebSocket upgrades for
   * READER_WS_PATH, authenticates the reader token from the query string, and hands
   * the socket to the connection handler. Non-matching paths are rejected (this is
   * currently the only WS on the bookshelf server).
   */
  attach(server: http.Server, resolveToken: ReaderTokenResolver): void {
    server.on('upgrade', (req, socket, head) => {
      let pathname: string;
      let token: string | null;
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        pathname = url.pathname;
        token = url.searchParams.get('token');
      } catch {
        socket.destroy();
        return;
      }

      if (pathname !== READER_WS_PATH) {
        socket.destroy();
        return;
      }

      const readerId = token ? resolveToken(token) : null;
      if (!readerId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.handleConnection(ws, readerId);
      });
    });
  }

  private async handleConnection(ws: WebSocket, readerId: string): Promise<void> {
    const state: ReaderClientState = { readerId, activeRequestIds: new Set() };
    this.clients.set(ws, state);

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
      this.clients.delete(ws);
      // A vanished client must not leave workers generating for nobody.
      for (const requestId of state.activeRequestIds) {
        if (streamScheduler.isActive(requestId)) streamScheduler.stop(requestId);
      }
      state.activeRequestIds.clear();
    });

    // Greet with current engine state + voices so the client can render its picker
    // and know whether the engine is cold before the first speak.
    this.send(ws, { type: 'hello', ...(await this.statusPayload()) });
  }

  private async handleMessage(
    ws: WebSocket,
    state: ReaderClientState,
    msg: Record<string, unknown>
  ): Promise<void> {
    switch (msg.action) {
      case 'status':
        this.send(ws, { type: 'status', ...(await this.statusPayload()) });
        return;

      case 'speak':
        await this.handleSpeak(ws, state, msg);
        return;

      case 'playhead': {
        const requestId = msg.requestId as string | number | undefined;
        const sentenceIndex = msg.sentenceIndex;
        if (
          requestId !== undefined &&
          typeof sentenceIndex === 'number' &&
          streamScheduler.isActive(requestId)
        ) {
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
        this.send(ws, { type: 'error', message: `unknown action: ${String(msg.action)}` });
    }
  }

  /**
   * Speak arbitrary text. Mirrors tts-api-server.handleSpeak but in-process: ensure
   * the engine is up + voice warmed, split the text with the engine's own splitter,
   * echo the segmentation, then stream via the scheduler with a per-request sink
   * that forwards scheduler events (keyed 'kind') to the socket (keyed 'type').
   */
  private async handleSpeak(
    ws: WebSocket,
    state: ReaderClientState,
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
    const voice =
      requested.voice ||
      engine.getCurrentVoice() ||
      engine.getLastVoice() ||
      getDefaultStreamVoice();
    const settings: PlaySettings = {
      voice,
      speed: typeof requested.speed === 'number' ? requested.speed : 1.0,
      temperature: requested.temperature,
      topP: requested.topP,
      repetitionPenalty: requested.repetitionPenalty,
    };

    // Cold engine: start it now. The client sees progress via 'state'/'status'.
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

    // preempt (default true): take over the audio output. background (default false):
    // a read-ahead block that coexists at low pool priority — the client fans out
    // upcoming blocks with {preempt:false, background:true}, exactly like the extension.
    const preempt = msg.preempt !== false;
    const background = msg.background === true;

    state.activeRequestIds.add(requestId);
    const sink = (event: Record<string, unknown>) => {
      if (event.kind === 'complete' || event.kind === 'cancelled') {
        state.activeRequestIds.delete(requestId);
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const { kind, ...rest } = event;
      this.send(ws, { type: kind, ...rest });
    };

    // Echo the segmentation before audio so the client can index incoming chunks.
    this.send(ws, { type: 'speaking', requestId, sentences });
    const result = streamScheduler.start(sentences, 0, settings, requestId, sink, {
      preempt,
      priority: !background,
    });
    if (!result.success) {
      state.activeRequestIds.delete(requestId);
      this.send(ws, { type: 'error', requestId, message: result.error || 'failed to start generation' });
    }
  }

  /** Start the worker pool (no-op if running) and warm the voice. */
  private async ensureEngine(voice?: string): Promise<{ success: boolean; error?: string }> {
    const engine = getActiveEngine();
    const result = await engine.startSession();
    if (!result.success) return { success: false, error: result.error };
    const warmVoice = voice || engine.getCurrentVoice() || engine.getLastVoice() || getDefaultStreamVoice();
    const loaded = await engine.loadVoice(warmVoice);
    if (!loaded.success) return { success: false, error: loaded.error };
    return { success: true };
  }

  /** Engine state + voices + topology, shared by hello/status. */
  private async statusPayload(): Promise<Record<string, unknown>> {
    const engine = getActiveEngine();
    return {
      state: engine.getEngineState(),
      voices: await this.installedVoices(),
      currentVoice: engine.getCurrentVoice() || getDefaultStreamVoice(),
      engine: getSelectedEngineName(),
      engines: getAvailableEngines(),
      config: getStreamConfigPayload(),
    };
  }

  /** The voices the active engine can actually use (mirrors tts-api-server). */
  private async installedVoices(): Promise<string[]> {
    if (getSelectedEngineName() === 'orpheus') {
      return getActiveEngine().getAvailableVoices();
    }
    const { getInstalledVoiceIds } = await import('./components/installed-voices.js');
    return getInstalledVoiceIds();
  }

  private send(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
}
