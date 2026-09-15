/**
 * Tab-record server — the WebSocket door the browser extension hands captured
 * tab audio to (docs/TAB_RECORDER.md).
 *
 * ── What this file WAS, and why it isn't ────────────────────────────────────
 *
 * Until Phase 16 it was `tts-api-server.ts`, and its main job was SPEECH: the
 * extension said `speak` here and got `chunk` / `done` / `complete` back, with
 * `engine.start` / `engine.stop` / `engine.restart` / `config.get` / `config.set`
 * / `playhead` / `cancel` around it, and BookForge relayed the whole thing to a
 * Crucible's streaming door. That relay is DELETED
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0 and step 8, Owen 2026-09-15: *"i think
 * the right way to do this is to connect directly to crucible with the
 * extension, fully. cut bookforge out of the picture"*). The extension is a
 * Crucible client now — its own registry, its own connect code, its own session
 * on `POST /v1/tts/stream` — and BookForge does not have to be running for it to
 * read a page.
 *
 * ── What is LEFT, and why it is permanent ───────────────────────────────────
 *
 * TAB RECORDING, and nothing else. A browser can capture a tab's audio but has
 * no filesystem and no ffmpeg; recording hands raw PCM to a machine that has
 * both, and this socket is how it reaches one. Nothing in Crucible replaces
 * that — a Crucible runs models and returns bytes; it does not own anybody's
 * Downloads folder. So Owen SPLIT the plan's step 6 on 2026-09-14: the speak
 * relay goes, this endpoint stays, and the extension keeps the BookForge
 * host/port/token rows in its Options that reach it.
 *
 * ── The wire ────────────────────────────────────────────────────────────────
 *
 * JSON text frames plus binary PCM. A client authenticates first, then records:
 *
 *   client → server
 *     {action:'hello', token}
 *     {action:'record.start',  recordId, title, sampleRate, channels, speed?, outputDir?, sourceUrl?}
 *     {action:'record.stop',   recordId}
 *     {action:'record.cancel', recordId}
 *     {action:'record.mark',   recordId, label, seconds}   // no reply
 *     ...plus BINARY frames of raw f32le interleaved PCM, legal only between
 *     record.started and record.stop/cancel.
 *
 *   server → client
 *     {type:'hello',           version}
 *     {type:'record.started',  recordId, path}
 *     {type:'record.progress', recordId, seconds, bytes}   // ~1 Hz
 *     {type:'record.done',     recordId, path, seconds, bytes}
 *     {type:'record.cancelled',recordId}
 *     {type:'error',           recordId?, message}
 *
 * Binds 127.0.0.1 by default; set host '0.0.0.0' in the config (userData) to
 * record from a browser on another machine. The token is required either way —
 * any webpage can open sockets to localhost ports.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { setRecordingDirsStore, sweepPartialRecordings, tabRecorder } from './tab-recording';

export interface TabRecordConfig {
  port: number;
  /** '127.0.0.1' (local only) or '0.0.0.0' (LAN) */
  host: string;
  token: string;
}

export interface TabRecordStatus {
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

/*
 * THE CONFIG FILE KEEPS ITS OLD NAME, ON PURPOSE.
 *
 * `tts-api.json` is not just this process's scratch file: `extension/build.mjs`
 * BAKES the host/port/token out of it into the extension at build time, and the
 * extension's Options page names the path so a user recording to BookForge on
 * another machine can find the token. Renaming it would mint a fresh token under
 * every running install and silently break every extension already pointed at
 * one — for a filename. The name is stale; the cost of fixing it is not zero,
 * and it is not this step's to pay. Whoever pays it changes three places at once
 * (here, extension/build.mjs, extension/static/options.html) and migrates the
 * existing file rather than leaving two names for one fact.
 */
const CONFIG_FILE = 'tts-api.json';

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
  /** The tab recording this connection owns, if any — ONE per client (and one
   *  per server). Binary frames belong to it, and its socket closing finalizes
   *  it rather than losing it. */
  recordId: string | null;
  /** When we last told this client it sent a binary frame outside a recording.
   *  A misbehaving client sends them at 10 Hz; it is told, not drowned. */
  lastStrayFrameAt: number;
}

export class TabRecordServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private config: TabRecordConfig | null = null;
  private userDataPath: string | null = null;
  private clients = new Map<WebSocket, ClientState>();

  // ───────────────────────────────────────────────────────────────────────────
  // Config
  // ───────────────────────────────────────────────────────────────────────────

  private configPath(): string {
    if (!this.userDataPath) throw new Error('Tab-record server not initialized with userDataPath');
    return path.join(this.userDataPath, CONFIG_FILE);
  }

  loadConfig(userDataPath: string): TabRecordConfig {
    this.userDataPath = userDataPath;
    let config: Partial<TabRecordConfig> = {};
    try {
      config = JSON.parse(fs.readFileSync(this.configPath(), 'utf-8'));
    } catch {
      // First run (or unreadable) — write a fresh config below
    }
    const complete: TabRecordConfig = {
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

  saveConfig(updates: Partial<Pick<TabRecordConfig, 'port' | 'host'>>): TabRecordConfig {
    if (!this.config) throw new Error('Tab-record config not loaded');
    if (typeof updates.port === 'number') this.config.port = updates.port;
    if (updates.host) this.config.host = updates.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
    fs.writeFileSync(this.configPath(), JSON.stringify(this.config, null, 2));
    return this.config;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async start(userDataPath: string): Promise<TabRecordStatus> {
    if (this.wss) await this.stop();
    const config = this.config && this.userDataPath === userDataPath
      ? this.config
      : this.loadConfig(userDataPath);

    await new Promise<void>((resolve, reject) => {
      this.httpServer = http.createServer((_req, res) => {
        // Plain HTTP probe support: lets a client cheaply detect BookForge.
        // The `service` string is the PUBLISHED answer (docs/TAB_RECORDER.md)
        // and keeps its old spelling for the same reason the config file does —
        // it is what already-built clients compare against, and renaming it
        // buys a truer word at the price of a silent detection failure.
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

    // No recording can be live at this instant, so any `.partial.flac` left in a
    // folder we have recorded into is debris from a run that died (app quit,
    // power cut). Clearing it here is what makes "a .flac in your Downloads is a
    // finished recording" true. The folder list is machine-local, beside the
    // server config — see tab-recording.ts.
    setRecordingDirsStore(path.join(userDataPath, 'tab-recordings.json'));
    const swept = await sweepPartialRecordings();
    if (swept.length > 0) {
      console.log(`[REC] swept ${swept.length} unfinished recording(s): ${swept.join(', ')}`);
    }

    console.log(`[REC] Tab-record server listening on ws://${config.host}:${config.port}`);
    return this.getStatus();
  }

  async stop(): Promise<void> {
    // The app is going away with a capture live: finalize it here rather than
    // racing the sockets' close handlers, which may never run before exit. The
    // file is complete up to the last frame, which is the whole point.
    await tabRecorder.finalizeOrphan('Tab-record server stopping');
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

  getStatus(): TabRecordStatus {
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
      // A recording is KEPT: the file is complete up to the last frame that
      // arrived, so a dropped socket finalizes exactly as record.stop would. No
      // .partial.flac is ever left behind.
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
      this.send(ws, { type: 'hello', version: PROTOCOL_VERSION });
      return;
    }

    if (!state.authed) {
      ws.close(4401, 'not authenticated');
      return;
    }

    switch (action) {
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
        // The speech verbs used to be answered here. A client still sending one
        // is told WHERE speech went rather than getting a bare "unknown action":
        // it is almost certainly an old extension build, and the fix is a
        // Crucible connect code in its Options, not a retry.
        if (
          action === 'speak' || action === 'playhead' || action === 'cancel' ||
          action === 'status' || action === 'config.get' || action === 'config.set' ||
          action === 'engine.start' || action === 'engine.stop' || action === 'engine.restart'
        ) {
          this.send(ws, {
            type: 'error',
            message:
              `'${String(action)}' is gone: BookForge no longer relays speech. This endpoint is the ` +
              'tab recorder only. Speech is a Crucible streaming session now — add a Crucible ' +
              'server in the extension\'s Options (Copy connect code) and it will read pages ' +
              'without BookForge running at all.'
          });
          return;
        }
        this.send(ws, { type: 'error', message: `unknown action: ${String(action)}` });
    }
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
}

export const tabRecordServer = new TabRecordServer();
