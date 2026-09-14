#!/usr/bin/env node
/**
 * THE LISTEN PATH ON SOMEBODY ELSE'S CARD, AND THE WAYS IT GOES WRONG SILENTLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-stream.js
 *
 * `electron/crucible/stream.ts` puts a Crucible streaming session (PHASE3-TTS.md
 * section 7) behind the `StreamingEngine` interface `stream-scheduler.ts` and the
 * three streaming surfaces already drive, and a venue-routed facade in front of
 * both backends. It drives a FAKE Crucible — an in-process HTTP server speaking
 * the four stream routes and `/v1/voices` in the shapes the SDK actually parses —
 * because the real one needs a card, and tonight both cards are taken.
 *
 * What a fake can prove is exactly what would otherwise be found on a Sunday,
 * with the extension open, mid-article:
 *
 *  1. **The legacy switch routes to the local narrator and says so.** The one
 *     switch the render uses, reused; nothing else picks the local card.
 *  2. **open / say / close, in that order and on the wire.** One session per
 *     voice, `bookforge` in the User-Agent, `say` per sentence in dispatch order,
 *     one DELETE on stop.
 *  3. **Audio reaches the consumer in order, byte for byte**, as base64 PCM16 —
 *     the scheduler's own chunk shape — buffered per row, or streamed per chunk
 *     for a fast-start row.
 *  4. **Every row lands in the ledger as `crucible-stream` / `stream-unguarded`,
 *     and NOTHING re-rolls.** A row the server reports `capped: true` is
 *     delivered as is: one `say` per sentence, zero cancels. Listen never
 *     re-rolls (docs/CRUCIBLE_ROLLOUT_PLAN.md ruling 3).
 *  5. **`stream_session_open`, `server_busy`, `voice_not_resident`,
 *     `engine_in_use` and an unreachable server refuse BY NAME**, with the SDK's
 *     `busyLine` on the busy one, and the local pool is never started instead.
 *  6. **A stale row is cancelled on the server, a live one is not; the session
 *     closes on stop; a session the server drops fails its rows by name.**
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const STREAM = path.join(REPO, 'dist', 'electron', 'crucible', 'stream.js');

if (!fs.existsSync(STREAM)) {
  console.log('SKIP: dist/electron/crucible/stream.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// A userData of our own, and an electron that answers for it
// ─────────────────────────────────────────────────────────────────────────────

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-crucible-stream-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      throw new Error(`test electron stub: app.getPath('${name}') is not stubbed`);
    },
    getAppPath: () => REPO,
    isPackaged: false,
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const streamMod = require(STREAM);
const ledger = require(path.join(REPO, 'dist', 'electron', 'chunk-guard-ledger.js'));
const { CRUCIBLE_CLIENT_NAME } = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const { CrucibleClient } = require('@crucible/client');

let passed = 0;
const failures = [];

/** The engine logs its decisions; the checks below read them. */
const logLines = [];
const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;
console.log = (...args) => { logLines.push(args.map(String).join(' ')); };
console.error = (...args) => { logLines.push(args.map(String).join(' ')); };
console.warn = (...args) => { logLines.push(args.map(String).join(' ')); };
const say = (...args) => realLog(...args);
// The check reporter must still reach the terminal.
const reportOk = (name) => say(`  ok  ${name}`);
const reportFail = (name, err) => realError(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err}`);
async function checkQuiet(name, fn) {
  try {
    await fn();
    passed += 1;
    reportOk(name);
  } catch (err) {
    failures.push(name);
    reportFail(name, err);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// The fake Crucible
//
// It speaks the routes the SDK actually calls, in the shapes the SDK actually
// parses — every frame below is built from crucible/ttsstream.py, crucible/api.py
// and sdk/ts/src/stream.ts. It also enforces the server's own ordering rule: a
// `say` before the event stream has attached is `stream_not_attached`.
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_PACE = {
  pace_chars_per_sec: 17.28, max_chars_per_sec: 22.46, min_chars_per_sec: 13.29,
  target_chars: null, safe_min_chars: 400, safe_max_chars: 800,
};

function voiceRow(id, resident) {
  return {
    id, display: id, kind: 'checkpoint', language: 'en', narrator_engine: 'higgs-v3',
    backend_supported: true, installed: true, resident, loadable: true, reason: null,
    revision: 'abc1234', fingerprint: `${id}@abc1234`, memory_bytes_estimate: 19000000000,
    estimate_basis: 'declared', max_chars: 800, sample_rate: 24000, takes: 1, pace: FAKE_PACE,
  };
}

/** 240 samples of a deterministic ramp, so two rows never share bytes. */
function pcmFor(rowOrdinal, seq) {
  const samples = 240;
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) bytes.writeInt16LE(((rowOrdinal * 1000 + seq * 100 + i) % 30000) - 15000, i * 2);
  return bytes;
}

/**
 * One fake server. `options`:
 *   resident   — which voice ids are resident (default ['mistborn'])
 *   open       — 'ok' | 'session_open' | 'busy' | 'engine_in_use'  (what POST /v1/tts/stream does)
 *   delayMs    — how long a row generates before it retires (default 5)
 *   cappedRow  — which say ordinal (1-based) is reported `capped: true` (default 2)
 *   attachDelayMs — how long after the events GET answers before the server counts the
 *                stream as attached (default 0): the window in which a real server
 *                refuses `say` as `stream_not_attached`
 */
function startFakeCrucible(options = {}) {
  const resident = options.resident || ['mistborn'];
  const open = options.open || 'ok';
  const delayMs = options.delayMs === undefined ? 5 : options.delayMs;
  const cappedRow = options.cappedRow === undefined ? 2 : options.cappedRow;
  const attachDelayMs = options.attachDelayMs || 0;

  const state = {
    voicesAsked: 0,
    userAgents: [],
    opens: [],       // every POST /v1/tts/stream body
    says: [],        // every say op, in arrival order: {id, text, take}
    cancels: [],     // every cancel op's id
    cancelAlls: 0,
    closes: 0,       // DELETE + {op: close}
    pcmBySay: new Map(),  // id -> Buffer of the whole row
    session: null,   // the one open session
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res, status, code, message, details) => send(res, status, { error: { code, message, details } });
  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

  function newSession(voice) {
    const s = {
      id: `sess-${Math.random().toString(36).slice(2, 8)}`,
      voice,
      events: [],       // {id, event, data}
      readers: [],      // open SSE responses
      attached: false,
      rows: new Map(),  // id -> {text, state: 'pending'|'running'|'finished', ordinal, cancelled}
      ordinal: 0,
      running: false,
      closed: false,
    };
    const emit = (event, data) => {
      const frame = { id: s.events.length + 1, event, data };
      s.events.push(frame);
      const text = `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
      for (const res of s.readers) res.write(text);
      if (event === 'closed') {
        for (const res of s.readers) res.end();
        s.readers = [];
      }
    };
    s.emit = emit;
    emit('ready', { voice, fingerprint: `${voice}@abc1234`, sample_rate: 24000, backend: 'cuda-linux' });
    // Width 1, in say order: the higgs-v3 shape.
    const pumpRows = () => {
      if (s.running || s.closed) return;
      const next = [...s.rows.values()].find((r) => r.state === 'pending');
      if (!next) return;
      s.running = true;
      next.state = 'running';
      setTimeout(() => {
        if (s.closed) return;
        const chunks = [pcmFor(next.ordinal, 0), pcmFor(next.ordinal, 1)];
        if (!next.cancelled) {
          state.pcmBySay.set(next.id, Buffer.concat(chunks));
          chunks.forEach((bytes, seq) => emit('audio', {
            id: next.id, seq, pcm_base64: bytes.toString('base64'), seconds: 0.01,
          }));
        }
        next.state = 'finished';
        emit('done', {
          id: next.id,
          seconds: next.cancelled ? 0 : 0.02,
          chars: next.text.length,
          chars_per_sec: next.cancelled ? null : next.text.length / 0.02,
          capped: next.ordinal === cappedRow ? true : null,
          cancelled: next.cancelled,
        });
        s.running = false;
        pumpRows();
      }, delayMs);
    };
    s.pumpRows = pumpRows;
    return s;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    state.userAgents.push(req.headers['user-agent'] || '');

    if (route === '/v1/voices' && req.method === 'GET') {
      state.voicesAsked += 1;
      return send(res, 200, [
        voiceRow('mistborn', resident.includes('mistborn')),
        voiceRow('deathstalker', resident.includes('deathstalker')),
      ]);
    }

    if (route === '/v1/tts/stream' && req.method === 'POST') {
      const body = await readBody(req);
      state.opens.push(body);
      if (open === 'session_open') {
        return refuse(res, 409, 'stream_session_open',
          "session 'sess-other' is already streaming 'deathstalker' on this server, and a session holds "
          + "the resident voice's whole attention. Close it first",
          { session_id: 'sess-other', voice: 'deathstalker' });
      }
      if (open === 'busy') {
        return refuse(res, 409, 'server_busy', 'one job at a time, and it is not yours', {
          holder: 'foundry', job_id: 'j-held', type: 'tts', model: 'deathstalker', status: 'running',
          since: '2026-09-13T19:00:00Z', progress: 0.62, message: '640 of 1030 chunk(s) rendered',
        });
      }
      if (open === 'engine_in_use') {
        return refuse(res, 409, 'engine_in_use',
          "narrator's wire is claimed by 'tts render j-9' and a session may not share it",
          { holder: 'tts render j-9' });
      }
      if (state.session && !state.session.closed) {
        return refuse(res, 409, 'stream_session_open',
          `session '${state.session.id}' is already streaming '${state.session.voice}' on this server`,
          { session_id: state.session.id, voice: state.session.voice });
      }
      if (!resident.includes(body.voice)) {
        return refuse(res, 409, 'voice_not_resident',
          `'${body.voice}' is not resident on this server; ${resident.length ? `'${resident[0]}' is` : 'no voice is'}. `
          + 'The streaming door never loads a voice — post a load-voice job first',
          { requested: body.voice, resident: resident[0] || null });
      }
      const s = newSession(body.voice);
      state.session = s;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        session_id: s.id, voice: s.voice, fingerprint: `${s.voice}@abc1234`, sample_rate: 24000, backend: 'cuda-linux',
      }));
    }

    const events = /^\/v1\/tts\/stream\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const s = state.session;
      if (!s || s.id !== decodeURIComponent(events[1])) return refuse(res, 404, 'unknown_session', 'no such session', {});
      const after = Number(req.headers['last-event-id'] || 0);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const attach = () => {
        s.attached = true;
        s.readers.push(res);
        for (const frame of s.events) {
          if (frame.id > after) res.write(`id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        }
      };
      if (attachDelayMs > 0) setTimeout(attach, attachDelayMs); else attach();
      req.on('close', () => { s.readers = s.readers.filter((r) => r !== res); });
      return undefined;
    }

    const op = /^\/v1\/tts\/stream\/([^/]+)$/.exec(route);
    if (op && req.method === 'POST') {
      const s = state.session;
      if (!s || s.id !== decodeURIComponent(op[1])) return refuse(res, 404, 'unknown_session', 'no such session', {});
      const body = await readBody(req);
      if (body.op === 'say') {
        if (!s.attached) {
          return refuse(res, 409, 'stream_not_attached',
            `session ${s.id} has never had an event stream attached, so there is nowhere for this row's audio to go`,
            { session_id: s.id });
        }
        if (s.rows.has(body.id)) return refuse(res, 400, 'duplicate_row_id', `row ${body.id} exists`, {});
        state.says.push({ id: body.id, text: body.text, take: body.take });
        s.ordinal += 1;
        s.rows.set(body.id, { id: body.id, text: body.text, state: 'pending', ordinal: s.ordinal, cancelled: false });
        s.pumpRows();
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: body.id }));
      }
      if (body.op === 'cancel') {
        state.cancels.push(body.id);
        const row = s.rows.get(body.id);
        let outcome = 'already_finished';
        if (row && row.state !== 'finished') {
          row.cancelled = true;
          outcome = row.state === 'pending' ? 'dropped' : 'aborting_batch';
          if (row.state === 'pending') row.state = 'running', setTimeout(() => {
            row.state = 'finished';
            s.emit('done', { id: row.id, seconds: 0, chars: row.text.length, chars_per_sec: null, capped: null, cancelled: true });
          }, 1);
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: body.id, outcome }));
      }
      if (body.op === 'cancel_all') {
        state.cancelAlls += 1;
        let n = 0;
        for (const row of s.rows.values()) if (row.state !== 'finished') { row.cancelled = true; n += 1; }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ cancelled: n }));
      }
      if (body.op === 'close') {
        state.closes += 1;
        s.closed = true;
        s.emit('closed', { reason: 'the client closed the session' });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ session_id: s.id, closed: true }));
      }
      return refuse(res, 400, 'invalid_request', `unknown op ${body.op}`, {});
    }

    if (op && req.method === 'DELETE') {
      const s = state.session;
      if (!s || s.id !== decodeURIComponent(op[1])) return refuse(res, 404, 'unknown_session', 'no such session', {});
      state.closes += 1;
      s.closed = true;
      s.emit('closed', { reason: 'the client closed the session' });
      return send(res, 200, { session_id: s.id, closed: true });
    }

    return refuse(res, 404, 'not_found', route, {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        /** The server ends the session on its own — a grace window running out. */
        dropSession(reason) {
          const s = state.session;
          if (!s || s.closed) throw new Error('no open session to drop');
          s.closed = true;
          s.emit('closed', { reason });
        },
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Building an engine and a facade against a fake
// ─────────────────────────────────────────────────────────────────────────────

function engineFor(fake, selectedEngine = 'higgs') {
  return new streamMod.CrucibleStreamingEngine({
    selectedEngine: () => selectedEngine,
    clientFor: (server) => {
      assert.strictEqual(server, 'fake1', `the engine asked for a client to "${server}", not the venue "fake1"`);
      return new CrucibleClient({ url: fake.url, token: 'test-token-abcd', clientName: CRUCIBLE_CLIENT_NAME });
    },
  });
}

/** A local pool that must never be started when the venue is a Crucible. */
function localStub() {
  const calls = { startSession: 0, endSession: 0 };
  const listeners = new Set();
  return {
    calls,
    setMainWindow() {},
    async startSession() { calls.startSession += 1; return { success: true, voices: ['local-voice'] }; },
    async loadVoice() { return { success: true }; },
    async generateSentence() { return { success: false, error: 'local stub' }; },
    async generateSentenceStream() { return { success: false, error: 'local stub' }; },
    cancelPendingBatchIfStale() {},
    stop() {},
    async endSession() { calls.endSession += 1; },
    isSessionActive() { return false; },
    getAvailableVoices() { return ['local-voice']; },
    getCurrentVoice() { return null; },
    getLastVoice() { return null; },
    getDefaultVoice() { return 'local-voice'; },
    getWorkerCount() { return 0; },
    getMaxConcurrentSentences() { return 1; },
    getEngineState() { return 'stopped'; },
    isServiceMode() { return false; },
    setServiceMode() {},
    onEngineState(l) { listeners.add(l); return () => listeners.delete(l); },
    getStreamWorkerConfig() { return { enabled: false, count: 1, defaultCount: 1, minWorkers: 1, maxWorkers: 1, devicePref: 'auto', device: null, deviceWorkers: 1, activeWorkers: 0 }; },
    setStreamWorkerConfig() { return this.getStreamWorkerConfig(); },
  };
}

function venueHost({ legacy = false, waitFor = 'top-ranked', enabled = ['fake1'], noEnabled = false } = {}) {
  const calls = { view: 0, enabled: 0, ping: [] };
  return {
    calls,
    view() { calls.view += 1; return { legacyLocalRender: legacy, newJobsWaitFor: waitFor, servers: [] }; },
    enabled() {
      calls.enabled += 1;
      if (noEnabled) {
        const err = new Error('no Crucible server is enabled for the queue (Settings → Crucible Servers)');
        err.code = 'no_enabled_server';
        throw err;
      }
      return enabled.map((name, rank) => ({ name, rank, enabled: true, source: 'registry' }));
    },
    async ping(name) { calls.ping.push(name); return { outcome: 'ok', serverName: name, apiVersion: 1 }; },
  };
}

function facadeFor(fake, opts = {}) {
  const local = localStub();
  const engine = engineFor(fake, opts.selectedEngine);
  const venue = venueHost(opts);
  const facade = streamMod.venueRoutedStreamingEngine({
    local: () => local,
    crucible: engine,
    crucibleEngine: engine,
    venue,
    legacySwitchIsOn: () => opts.legacy === true,
  });
  return { facade, local, engine, venue };
}

const SENTENCES = [
  'He had been walking for some time.',
  'The road turned north at the mill and did not turn again.',
  'By evening he could see the lights.',
];
const SETTINGS = { voice: 'mistborn', speed: 1.0 };

// ─────────────────────────────────────────────────────────────────────────────
// 1. The legacy switch is the ONE way to the local narrator
// ─────────────────────────────────────────────────────────────────────────────

async function legacyChecks() {
  const fake = await startFakeCrucible();
  try {
    const { facade, local, venue } = facadeFor(fake, { legacy: true });
    await checkQuiet('the legacy switch routes startSession to the local narrator and says so', async () => {
      logLines.length = 0;
      const result = await facade.startSession();
      assert.strictEqual(result.success, true);
      assert.strictEqual(local.calls.startSession, 1, 'the local pool must have been started');
      assert.strictEqual(fake.state.opens.length, 0, 'no Crucible session may be opened');
      assert.strictEqual(fake.state.voicesAsked, 0, 'the Crucible must not even be asked for voices');
      assert.strictEqual(venue.calls.view, 1, 'the decision reads the routing record once');
      assert.ok(logLines.some((l) => /\[StreamVenue\].*legacy local-render switch is on/.test(l)),
        `the log must name the legacy switch; got: ${logLines.join(' | ')}`);
      assert.deepStrictEqual(facade.getAvailableVoices(), ['local-voice'],
        'once bound local, the facade answers with the local catalog');
    });
    await checkQuiet('before anything starts, the legacy switch decides which catalog the pickers see', () => {
      const { facade: cold } = facadeFor(fake, { legacy: true });
      assert.deepStrictEqual(cold.getAvailableVoices(), ['local-voice']);
      assert.strictEqual(cold.getEngineState(), 'stopped');
      const { facade: coldCrucible } = facadeFor(fake, { legacy: false });
      assert.deepStrictEqual(coldCrucible.getAvailableVoices(),
        ['deathstalker', 'mistborn', 'owen', 'sigma', 'thirdreich', 'default'],
        'with the switch off and nothing started, the pickers see every voice a Crucible can be asked for');
      assert.strictEqual(coldCrucible.getEngineState(), 'stopped');
    });
  } finally {
    await fake.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2–4. open / say / close, audio in order, ledger, nothing re-rolls
// ─────────────────────────────────────────────────────────────────────────────

async function happyPathChecks() {
  const fake = await startFakeCrucible();
  try {
    const { facade, local, venue } = facadeFor(fake);
    logLines.length = 0;

    await checkQuiet('startSession decides the venue, asks /v1/voices once, and offers the voices the server advertises', async () => {
      const result = await facade.startSession();
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(local.calls.startSession, 0, 'the local pool must not be started');
      assert.strictEqual(fake.state.voicesAsked, 1);
      assert.strictEqual(venue.calls.enabled, 1);
      assert.deepStrictEqual(result.voices, ['deathstalker', 'mistborn'],
        'mapped ids, in the table\'s order, filtered to what the server advertises');
      assert.deepStrictEqual(facade.getAvailableVoices(), ['deathstalker', 'mistborn']);
      assert.strictEqual(facade.getEngineState(), 'warming', 'a server is up and no session is open');
      assert.strictEqual(facade.isSessionActive(), false);
      assert.ok(logLines.some((l) => /\[StreamVenue\] Listen goes to crucible "fake1" \(the top-ranked server\)/.test(l)),
        `the log must name the venue and why; got: ${logLines.join(' | ')}`);
    });

    await checkQuiet('loadVoice OPENS the session on the mapped voice, in en, as bookforge', async () => {
      const result = await facade.loadVoice('mistborn', { warm: false });
      assert.strictEqual(result.success, true, result.error);
      assert.deepStrictEqual(fake.state.opens, [{ voice: 'mistborn', language: 'en' }]);
      assert.ok(fake.state.userAgents.every((ua) => ua.startsWith(`${CRUCIBLE_CLIENT_NAME} `)),
        `every call must identify itself as ${CRUCIBLE_CLIENT_NAME}; saw ${JSON.stringify(fake.state.userAgents)}`);
      assert.strictEqual(facade.isSessionActive(), true);
      assert.strictEqual(facade.getEngineState(), 'running');
      assert.strictEqual(facade.getCurrentVoice(), 'mistborn');
      assert.strictEqual(facade.getMaxConcurrentSentences(), streamMod.CRUCIBLE_STREAM_IN_FLIGHT);
    });

    await checkQuiet('loading the voice the session already speaks opens nothing new', async () => {
      const result = await facade.loadVoice('mistborn');
      assert.strictEqual(result.success, true);
      assert.strictEqual(fake.state.opens.length, 1);
    });

    let results;
    await checkQuiet('say per sentence, in dispatch order, take 0; audio comes back in order, byte for byte', async () => {
      const order = [];
      results = await Promise.all(SENTENCES.map((text, i) =>
        facade.generateSentence(text, i, SETTINGS, true, () => false).then((r) => { order.push(i); return r; })));
      assert.deepStrictEqual(fake.state.says.map((s) => s.text), SENTENCES, 'one say per sentence, in order');
      assert.deepStrictEqual(fake.state.says.map((s) => s.id), ['r1', 'r2', 'r3']);
      assert.ok(fake.state.says.every((s) => s.take === 0), 'take 0 on every say');
      assert.deepStrictEqual(order, [0, 1, 2], 'rows retire in say order on a width-1 engine');
      results.forEach((r, i) => {
        assert.strictEqual(r.success, true, `sentence ${i}: ${r.error}`);
        assert.ok(r.audio, `sentence ${i} must carry buffered audio`);
        assert.strictEqual(r.audio.sampleRate, 24000);
        assert.strictEqual(r.streamed, undefined);
        const got = Buffer.from(r.audio.data, 'base64');
        const sent = fake.state.pcmBySay.get(`r${i + 1}`);
        assert.ok(got.equals(sent), `sentence ${i}: the PCM handed to the consumer must be the bytes the server sent`);
        assert.strictEqual(r.audio.duration, 0.02, 'duration is the server\'s own seconds on done');
      });
    });

    await checkQuiet('a fast-start row streams its chunks through onChunk and resolves streamed:true with no audio', async () => {
      const chunks = [];
      const result = await facade.generateSentence('A fourth sentence, streamed.', 3, SETTINGS, true, () => false,
        (chunk) => chunks.push(chunk));
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.streamed, true);
      assert.strictEqual(result.audio, undefined);
      assert.strictEqual(result.duration, 0.02);
      assert.deepStrictEqual(chunks.map((c) => c.seq), [0, 1]);
      const joined = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')));
      assert.ok(joined.equals(fake.state.pcmBySay.get('r4')), 'the streamed chunks concatenate to the row\'s bytes');
      assert.ok(chunks.every((c) => c.sampleRate === 24000));
    });

    await checkQuiet('every row is in the ledger as crucible-stream / stream-unguarded, capped kept verbatim, and NOTHING re-rolled', () => {
      const sessionId = fake.state.session.id;
      const records = ledger.chunkGuards(`crucible-stream:${sessionId}`);
      assert.strictEqual(records.length, 4, 'one record per row said');
      for (const r of records) {
        assert.strictEqual(r.source, 'crucible-stream');
        assert.strictEqual(r.verdict, null, 'the streaming door carries no verdict and none may be invented');
        assert.strictEqual(r.unknownReason, 'stream-unguarded');
        assert.strictEqual(r.clean, null);
        assert.strictEqual(r.takes.length, 1, 'the done frame, verbatim, is the only evidence');
      }
      const capped = records.find((r) => r.index === 2);
      assert.strictEqual(capped.takes[0].capped, true, 'the server said row 2 hit the cap; the record must say so');
      assert.strictEqual(records.find((r) => r.index === 1).takes[0].capped, null, 'null stays null, never false');
      const summary = ledger.summarizeChunkGuards(`crucible-stream:${sessionId}`);
      assert.deepStrictEqual(summary.byVerdict, {}, 'no verdict word may appear for an unguarded door');
      assert.deepStrictEqual(summary.unknownBy, { 'stream-unguarded': 4 });
      assert.deepStrictEqual(summary.sources, ['crucible-stream']);
      // Listen never re-rolls: the capped row got one say and no cancel.
      assert.strictEqual(fake.state.says.length, 4, 'exactly one say per sentence — a re-roll would be a fifth');
      assert.deepStrictEqual(fake.state.cancels, [], 'nothing was cancelled');
      assert.ok(logLines.some((l) => /row r2 .*hit the frame cap.*never re-rolls/.test(l)),
        'the capped row is logged as delivered-as-is');
    });

    await checkQuiet('a request naming another voice is refused by name, not rendered in the loaded one', async () => {
      const result = await facade.generateSentence('Wrong voice.', 9, { voice: 'deathstalker', speed: 1 }, true);
      assert.strictEqual(result.success, false);
      assert.match(result.error, /speaks 'mistborn', not the requested 'deathstalker'/);
      assert.strictEqual(fake.state.says.length, 4, 'nothing crossed the wire');
    });

    await checkQuiet('endSession closes the session on the server (one DELETE), pops the ledger, and forgets the venue', async () => {
      const sessionId = fake.state.session.id;
      await facade.endSession();
      assert.strictEqual(fake.state.closes, 1, 'exactly one close');
      assert.strictEqual(facade.isSessionActive(), false);
      assert.strictEqual(facade.getEngineState(), 'stopped');
      assert.deepStrictEqual(ledger.chunkGuards(`crucible-stream:${sessionId}`), [],
        'the session\'s ledger is taken when it closes');
      assert.ok(logLines.some((l) => /session .* closed \(the session was ended\): 4 row\(s\) recorded, 4 unguarded by ruling/.test(l)),
        `the close must summarise the ledger; got: ${logLines.filter((l) => /closed/.test(l)).join(' | ')}`);
      // Cold again: the next start decides the venue afresh.
      const again = await facade.startSession();
      assert.strictEqual(again.success, true, again.error);
      assert.strictEqual(venue.calls.enabled, 2, 'a cold start asks the routing record again');
      assert.strictEqual(fake.state.voicesAsked, 2);
      await facade.endSession();
    });
  } finally {
    await fake.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cancel reaches the server for stale rows only; a dropped session fails by name
// ─────────────────────────────────────────────────────────────────────────────

async function cancelChecks() {
  const fake = await startFakeCrucible({ delayMs: 150 });
  try {
    const { facade } = facadeFor(fake);
    assert.strictEqual((await facade.startSession()).success, true);
    assert.strictEqual((await facade.loadVoice('mistborn')).success, true);

    await checkQuiet('cancelPendingBatchIfStale cancels exactly the rows the scheduler marked stale', async () => {
      let staleA = false;
      const a = facade.generateSentence('Stale soon.', 0, SETTINGS, true, () => staleA);
      const b = facade.generateSentence('Still wanted.', 1, SETTINGS, true, () => false);
      await sleep(30);  // both said; a is generating, b is pending
      staleA = true;
      facade.cancelPendingBatchIfStale();
      await sleep(30);
      assert.deepStrictEqual(fake.state.cancels, ['r1'], 'only the stale row is cancelled on the server');
      const [ra, rb] = await Promise.all([a, b]);
      assert.strictEqual(ra.success, false, 'the cancelled row does not succeed');
      assert.match(ra.error, /cancelled on the server/);
      assert.strictEqual(rb.success, true, rb.error);
      assert.ok(Buffer.from(rb.audio.data, 'base64').equals(fake.state.pcmBySay.get('r2')));
    });

    await checkQuiet('a session the server drops fails its in-flight rows by name and reads as stopped', async () => {
      const pending = facade.generateSentence('Never finishes.', 2, SETTINGS, true, () => false);
      await sleep(30);
      fake.dropSession('the grace window ran out');
      const result = await pending;
      assert.strictEqual(result.success, false);
      assert.match(result.error, /closed before row r3 finished/);
      assert.strictEqual(facade.isSessionActive(), false);
      assert.strictEqual(facade.getCurrentVoice(), null);
      assert.ok(logLines.some((l) => /session .* ended \(the server closed the session\)/.test(l)),
        'a session ended by the server is logged as such');
      await facade.endSession();
      assert.strictEqual(fake.state.closes, 0, 'nothing to close: the server already ended it');
    });
  } finally {
    await fake.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The labelled stopgap: the first say waits for the SDK's stream to attach
// ─────────────────────────────────────────────────────────────────────────────

async function attachChecks() {
  const fake = await startFakeCrucible({ attachDelayMs: 150 });
  try {
    const { facade } = facadeFor(fake);
    await checkQuiet('the first say of a session waits out stream_not_attached (labelled stopgap) instead of failing the sentence', async () => {
      assert.strictEqual((await facade.startSession()).success, true);
      assert.strictEqual((await facade.loadVoice('mistborn')).success, true);
      logLines.length = 0;
      const result = await facade.generateSentence(SENTENCES[0], 0, SETTINGS, true, () => false);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(fake.state.says.length, 1, 'the row was said once, after the stream attached');
      assert.ok(logLines.some((l) => /waiting for the event stream to attach/.test(l)),
        'the wait is logged once, naming the stopgap');
      // Attached now: a later row never waits, and a later refusal of that code would surface.
      logLines.length = 0;
      const again = await facade.generateSentence(SENTENCES[1], 1, SETTINGS, true, () => false);
      assert.strictEqual(again.success, true, again.error);
      assert.ok(!logLines.some((l) => /waiting for the event stream to attach/.test(l)));
      await facade.endSession();
    });
  } finally {
    await fake.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Refusals, by name, with no local spawn
// ─────────────────────────────────────────────────────────────────────────────

async function refusalChecks() {
  const refusedOpen = async (open, name, expect) => {
    const fake = await startFakeCrucible({ open });
    try {
      const { facade, local } = facadeFor(fake);
      await checkQuiet(name, async () => {
        assert.strictEqual((await facade.startSession()).success, true);
        const result = await facade.loadVoice('mistborn');
        assert.strictEqual(result.success, false, 'the load must be refused');
        expect(result.error);
        assert.strictEqual(local.calls.startSession, 0, 'the local pool must never be started instead');
        assert.strictEqual(facade.isSessionActive(), false);
        assert.strictEqual(facade.getEngineState(), 'warming', 'the server is still up; no session is open');
      });
    } finally {
      await fake.close();
    }
  };

  await refusedOpen('session_open', 'stream_session_open refuses by name, naming the other session, and nothing streams locally', (error) => {
    assert.match(error, /^stream_session_open: /);
    assert.match(error, /sess-other/);
    assert.match(error, /speaking deathstalker/);
  });
  await refusedOpen('busy', 'server_busy refuses by name with the SDK\'s busyLine', (error) => {
    assert.match(error, /^server_busy: /);
    assert.ok(error.includes('busy: foundry, tts deathstalker, 62% done — 640 of 1030 chunk(s) rendered'),
      `the busyLine must be the SDK's own; got: ${error}`);
  });
  await refusedOpen('engine_in_use', 'engine_in_use (a render holds narrator\'s wire) refuses by name', (error) => {
    assert.match(error, /^engine_in_use: /);
    assert.match(error, /A render holds narrator's wire/);
  });

  {
    const fake = await startFakeCrucible({ resident: ['deathstalker'] });
    try {
      const { facade, local } = facadeFor(fake);
      await checkQuiet('a voice that is not resident is refused by name — the streaming door never loads one', async () => {
        assert.strictEqual((await facade.startSession()).success, true);
        const result = await facade.loadVoice('mistborn');
        assert.strictEqual(result.success, false);
        assert.match(result.error, /^voice_not_resident: /);
        assert.match(result.error, /never loads a voice/);
        assert.strictEqual(local.calls.startSession, 0);
        assert.deepStrictEqual(fake.state.opens, [{ voice: 'mistborn', language: 'en' }],
          'the server is asked and answers; nothing here second-guesses residency');
      });
    } finally {
      await fake.close();
    }
  }

  {
    const fake = await startFakeCrucible();
    try {
      const { facade, local } = facadeFor(fake);
      await checkQuiet('the voice table refuses an unmapped voice and an Orpheus selection by name', async () => {
        assert.strictEqual((await facade.startSession()).success, true);
        const zero = await facade.loadVoice('zeroshot-deathstalker');
        assert.strictEqual(zero.success, false);
        assert.match(zero.error, /crucible_voice_unmapped/);
        assert.strictEqual(fake.state.opens.length, 0, 'nothing is opened for a voice the table refuses');
        assert.strictEqual(local.calls.startSession, 0);
      });
      const orpheus = facadeFor(fake, { selectedEngine: 'orpheus' });
      await checkQuiet('on the Orpheus selection a Crucible offers no voice and refuses a load by name', async () => {
        assert.strictEqual((await orpheus.facade.startSession()).success, true);
        assert.deepStrictEqual(orpheus.facade.getAvailableVoices(), []);
        const result = await orpheus.facade.loadVoice('mistborn');
        assert.strictEqual(result.success, false);
        assert.match(result.error, /crucible_engine_unsupported/);
        assert.throws(() => orpheus.facade.getDefaultVoice(), /Every voice a Crucible serves is higgs-v3/);
      });
    } finally {
      await fake.close();
    }
  }

  {
    // A port nothing listens on: unreachable, by name, and no local narrator.
    const closed = await startFakeCrucible();
    const url = closed.url;
    await closed.close();
    const { facade, local } = facadeFor({ url });
    await checkQuiet('an unreachable venue fails startSession by name and never starts the local pool', async () => {
      const result = await facade.startSession();
      assert.strictEqual(result.success, false);
      assert.match(result.error, /^crucible_unreachable: /);
      assert.match(result.error, /Nothing streams from this machine instead/);
      assert.strictEqual(local.calls.startSession, 0);
      assert.strictEqual(facade.getEngineState(), 'stopped');
    });
  }

  {
    const fake = await startFakeCrucible();
    try {
      const { facade, local } = facadeFor(fake, { noEnabled: true });
      await checkQuiet('no enabled server: startSession refuses in the routing record\'s words, and nothing runs locally', async () => {
        const result = await facade.startSession();
        assert.strictEqual(result.success, false);
        assert.match(result.error, /^no_enabled_server: /);
        assert.strictEqual(local.calls.startSession, 0);
        assert.strictEqual(fake.state.voicesAsked, 0);
      });
    } finally {
      await fake.close();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The refusal reader, on its own
// ─────────────────────────────────────────────────────────────────────────────

async function describeChecks() {
  const { CrucibleRefused, CrucibleUnreachable } = require('@crucible/client');
  await checkQuiet('describeCrucibleStreamRefusal keeps the server\'s code in front and returns foreign errors unchanged', () => {
    const refused = streamMod.describeCrucibleStreamRefusal(
      new CrucibleRefused(409, 'chunk_too_long', 'this row is 900 characters', { max_chars: 800 }), 'mac');
    assert.ok(refused instanceof streamMod.CrucibleStreamRefused);
    assert.strictEqual(refused.code, 'chunk_too_long');
    assert.match(refused.message, /^chunk_too_long: crucible "mac" refused this Listen \(HTTP 409\)/);
    const unreachable = streamMod.describeCrucibleStreamRefusal(new CrucibleUnreachable('http://x', 'ECONNREFUSED', null), 'mac');
    assert.strictEqual(unreachable.code, 'crucible_unreachable');
    const foreign = new TypeError('not the SDK\'s');
    assert.strictEqual(streamMod.describeCrucibleStreamRefusal(foreign, 'mac'), foreign);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  say('test-crucible-stream');
  await legacyChecks();
  await happyPathChecks();
  await cancelChecks();
  await attachChecks();
  await refusalChecks();
  await describeChecks();
  console.log = realLog;
  console.error = realError;
  console.warn = realWarn;
  fs.rmSync(WORK, { recursive: true, force: true });
  // exitCode, never process.exit(): a piped stdout is truncated by exit() and
  // run-keepers reads this suite through a pipe.
  if (failures.length > 0) {
    say(`\n${failures.length} FAILED, ${passed} passed:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  say(`\nall ${passed} checks passed`);
})().catch((err) => {
  console.log = realLog;
  console.error = realError;
  realError(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
