/**
 * ONE FAKE CRUCIBLE FOR THE JOB KEEPERS — the scaffold `test-crucible-job.js`,
 * `test-crucible-asr.js` and `test-crucible-align.js` share.
 *
 * It speaks the routes the SDK actually calls, in the shapes the SDK actually
 * parses: `POST /v1/uploads` as multipart (the SDK sends `FormData`, field
 * `file`, and the fake parses the part back out so a keeper can assert the
 * bytes and the filename that crossed), `POST /v1/jobs`, the SSE event stream
 * with ids the SDK requires and a `Last-Event-ID` it honours, artifacts with
 * their provenance sidecars, and `DELETE`. A fake that answered a looser shape
 * would pass a suite and fail against a real server, which is worse than no
 * suite (`test-crucible-render.js`'s own words; this is that fake, generalised
 * so three keepers do not carry three copies of the multipart parser).
 *
 * Not a keeper itself: `run-keepers.js` runs only the `test-*` names it lists.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');

/**
 * A userData of our own, and an electron that answers for it.
 *
 * `electron/crucible/servers.ts` reads the registry out of `app.getPath('userData')`
 * at call time, so pointing that at a temp directory keeps a keeper off the real
 * one. `coverage-align-job.ts` and `generate-sentences-bridge.ts` import
 * `electron` too, for `app` and `BrowserWindow`.
 */
function installElectronStub(prefix) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const userData = path.join(work, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const stub = {
    app: {
      getPath(name) {
        if (name === 'userData') return userData;
        if (name === 'temp') return os.tmpdir();
        throw new Error(`fake-crucible electron stub: app.getPath('${name}') is not stubbed`);
      },
      getAppPath: () => REPO,
      isPackaged: false,
      on: () => {},
    },
    BrowserWindow: class { static getAllWindows() { return []; } isDestroyed() { return true; } },
    ipcMain: { handle: () => {}, on: () => {} },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return origLoad.apply(this, arguments);
  };
  return { work, userData };
}

/** A small check runner: one line per check, a non-zero exit on any failure. */
function makeChecker() {
  let passed = 0;
  const failures = [];
  async function check(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push(name);
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err}`);
      process.exitCode = 1;
    }
  }
  function summary(label) {
    console.log(`\n${label}: ${passed} passed, ${failures.length} failed`);
    if (failures.length) console.log('  failed: ' + failures.join(', '));
  }
  return { check, summary };
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * The one part of a `FormData` upload: `{filename, bytes}`. The SDK appends
 * field `file` with the filename the caller gave, so there is exactly one part.
 */
function parseMultipart(req, body) {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!m) throw new Error(`upload without a multipart boundary: ${ct}`);
  const boundary = m[1] || m[2];
  const head = body.indexOf('\r\n\r\n');
  if (head === -1) throw new Error('multipart part has no header/body separator');
  const headers = body.slice(0, head).toString('utf-8');
  const fn = /filename="([^"]*)"/.exec(headers);
  if (!fn) throw new Error(`multipart part carries no filename: ${headers}`);
  const tail = body.lastIndexOf(`\r\n--${boundary}--`);
  if (tail === -1) throw new Error('multipart body has no closing boundary');
  return { filename: fn[1], bytes: body.slice(head + 4, tail) };
}

/**
 * An SSE writer that numbers frames from 1 and SKIPS every frame at or below
 * the request's `Last-Event-ID`, which is exactly what a real Crucible does on
 * a resume.
 */
function sseWriter(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const last = Number(req.headers['last-event-id'] || 0);
  let id = 0;
  return {
    frame(name, data) {
      id += 1;
      if (id <= last) return;
      res.write(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() { res.end(); },
    get lastId() { return id; },
  };
}

/** The provenance sidecar, in the shape the SDK's readProvenance() demands. */
function provenanceFor(name, jobType, model) {
  return {
    server: { name: 'fake-crucible', version: '0.5.0' },
    backend: 'cuda-linux',
    job_type: jobType,
    model: model === null ? null : { id: model, revision: 'abc1234', fingerprint: `${model}@abc1234` },
    params: {},
    started: '2026-09-14T02:00:00Z',
    finished: '2026-09-14T02:04:00Z',
    artifact: name,
  };
}

/**
 * THE PHASE-18 RENDER DOOR'S TWO REFUSALS, so a fake refuses what a real server
 * refuses (2026-09-19, crucible `docs/PHASE18-UNCERTIFIED.md` §4.0 and §9).
 *
 * A `tts` render request may now carry `retake` (which ARM renders the batch:
 * true is narrator's guarded driver, absent/false is the bare arm), `band` (the
 * three rates that arm measures against — the CALLER states them and the server
 * never looks them up), and `width` (the in-flight cap). The two ways a client
 * can get that wrong are refused whole:
 *
 *  - `retake_without_band` — asked to be guarded and said against what. It is
 *    NOT filled in from the voice and NOT downgraded to the bare arm, "because a
 *    client that asked to be guarded and was not would read every clean row as a
 *    verdict".
 *  - `band_malformed` — a band that is not one. One code for all of them,
 *    because a band is one statement.
 *
 * Checked even when `retake` is absent, exactly as the server does: "a malformed
 * band is a client mistake whether or not this run would have used it."
 *
 * Returns null when the params are fine, or `{status, code, message}` to send.
 * A fake that accepted anything would let "BookForge always states the band"
 * pass as a comment rather than as a measurement.
 */
function refuseRenderParams(params) {
  const band = params.band;
  if (band !== undefined && band !== null) {
    const rates = ['pace_chars_per_sec', 'max_chars_per_sec', 'min_chars_per_sec'];
    const bad = rates.find((k) => typeof band[k] !== 'number' || !(band[k] > 0));
    const ordered = !bad && band.min_chars_per_sec < band.pace_chars_per_sec
      && band.pace_chars_per_sec < band.max_chars_per_sec;
    if (bad || !ordered) {
      return {
        status: 400,
        code: 'band_malformed',
        message: `band is not a band (${JSON.stringify(band)}): all three rates must be positive `
          + 'numbers with min < pace < max',
      };
    }
  }
  if (params.retake === true && (band === undefined || band === null)) {
    return {
      status: 400,
      code: 'retake_without_band',
      message: 'retake: true states no band. The band is the caller\'s and is never looked up '
        + 'here; a guarded render with no band would be guarded against nothing.',
    };
  }
  if (params.width !== undefined && params.width !== null
    && (!Number.isInteger(params.width) || params.width < 1)) {
    return {
      status: 400,
      code: 'width_malformed',
      message: `width is ${JSON.stringify(params.width)}; it is a whole number of chunks in flight`,
    };
  }
  return null;
}

/**
 * The THREE fields a `tts` `done` gained on 2026-09-19, which the SDK reads
 * STRICTLY — `sampling` and `voice` are protocol errors when absent, and `width`
 * must be present even to be null (crucible `docs/PHASE18-UNCERTIFIED.md`
 * §4.0.1: "a record that cannot say what it ran at is comparable to nothing").
 *
 * `sampling` is the FULL triple as applied — the voice's take-0 numbers with
 * this take's rung laid over them — so a fake that echoed only an override
 * would be modelling a server that does not exist.
 */
function renderDoneProvenance(voice, take, width) {
  return {
    sampling: take === 0
      ? { temperature: 0.8, top_p: 0.95, top_k: 50 }
      : { temperature: 0.7, top_p: 0.95, top_k: 50 },
    voice: { id: voice, identity: 'abc1234'.padEnd(40, '0'), identity_basis: 'verified' },
    width: width === undefined ? 4 : width,
  };
}

/**
 * ── THE FAULT LAYER (PK13, 2026-09-20) ──────────────────────────────────────
 *
 * A server that misbehaves the way the real ones did on the night of Sep 19.
 * Every knob is a LIST of rules, each `{match, times?, …}`; `times` counts down
 * and `undefined` means for ever, so "the FIRST events GET is reset and the
 * second is not" — the shape every reconnect scenario needs — is expressible
 * without a flag per scenario.
 *
 *   resetAfterBytes  destroy the socket after N bytes of the RESPONSE have
 *                    been written (0 = before the status line), which is what
 *                    a keep-alive socket closed under a reply looks like and
 *                    what undici answers with `TypeError: terminated`. Works
 *                    mid-SSE because it wraps `res.write`.
 *   connectDelay     hold the request and answer NOTHING for `ms`. A listening
 *                    socket always completes TCP connect on loopback, so this
 *                    is a RESPONSE stall, not a connect stall — the observable
 *                    consequence (the client's own clock fires, headers never
 *                    arrive) is the same one undici's 10 s connect timeout
 *                    produces, and calling it what it is beats pretending.
 *   refuse           answer `{status, code, message}` in the server's refusal
 *                    envelope, with an optional `Retry-After`.
 *
 * `match` is `{method?, path?}`; `path` is a prefix string or a RegExp.
 *
 * Nothing here is armed unless a caller passes `faults`, so the fifteen suites
 * that already share this file are untouched.
 */
function faultMatches(rule, method, pathname) {
  // `match` is REQUIRED, and its absence is a rule that matches everything —
  // which is almost never what a scenario means and is exactly what silently
  // refused an UPLOAD when the rule said DELETE. Spelling it out here so the
  // shape is one thing: `{match: {method?, path?}, times?, …}`.
  const m = rule.match;
  if (m === undefined) return true;
  if (m.method !== undefined && m.method !== method) return false;
  if (m.path === undefined) return true;
  if (m.path instanceof RegExp) return m.path.test(pathname);
  return pathname.startsWith(m.path);
}

/** The first rule that matches and has fires left, with its counter decremented. */
function takeFault(list, method, pathname) {
  if (!Array.isArray(list)) return null;
  for (const rule of list) {
    if (rule.times !== undefined && rule.times <= 0) continue;
    if (!faultMatches(rule, method, pathname)) continue;
    if (rule.times !== undefined) rule.times -= 1;
    return rule;
  }
  return null;
}

/**
 * Arm a mid-response socket death. Wraps `res.write`/`res.end` so the count is
 * of BYTES THAT REACHED THE WIRE, which is what makes `resetAfterBytes` usable
 * against an SSE stream: "die after the third frame" is a byte count nobody has
 * to compute, because a scenario says 0 (before anything) or a number large
 * enough to let the opening frames through.
 */
function armReset(res, afterBytes) {
  if (afterBytes <= 0) {
    if (res.socket) res.socket.destroy();
    return;
  }
  let written = 0;
  let dead = false;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const kill = () => {
    dead = true;
    if (res.socket) res.socket.destroy();
  };
  res.write = (chunk, ...rest) => {
    if (dead) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (written + buf.length < afterBytes) {
      written += buf.length;
      return write(buf, ...rest);
    }
    const room = Math.max(0, afterBytes - written);
    if (room > 0) write(buf.subarray(0, room));
    written = afterBytes;
    kill();
    return false;
  };
  res.end = (...args) => {
    if (dead) return res;
    if (args.length > 0 && args[0] !== undefined && typeof args[0] !== 'function') {
      res.write(args[0]);
      if (dead) return res;
    }
    return end();
  };
}

/**
 * Start a fake on 127.0.0.1. `route(req, res, ctx)` is the keeper's own
 * behaviour; it returns true when it handled the request. What every keeper
 * needs — uploads recorded and answered, DELETE recorded — is handled here
 * first, so a route only has to speak its job type.
 *
 * `options.faults` arms the fault layer above; `options.slowRequestMs` is not a
 * thing — a stall is a `connectDelay` rule like any other.
 *
 * EVERY REQUEST IS RECORDED on `state.requests` as `{method, path, at}` (and
 * `body` for the routes this file parses), so a scenario can assert *"no DELETE
 * was sent"* and *"exactly one"* — which is the only way to tell a client that
 * cleaned up after itself from one that abandoned a job on somebody's card.
 */
function startFakeCrucible(route, options = {}) {
  const state = {
    uploads: [],      // {filename, bytes, blobId}
    submitted: [],    // every POST /v1/jobs body
    cancelled: [],    // every DELETE /v1/jobs/<id>
    eventsRequests: [], // {jobId, lastEventId}
    jobs: new Map(),
    /** Every request that crossed: {method, path, at, body?}. */
    requests: [],
    /** Mutable: a scenario adds and removes rules as it runs. */
    faults: options.faults || {},
  };
  let nextBlob = 1;
  let nextJob = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const routePath = url.pathname;
    const record = { method: req.method, path: routePath, at: Date.now() };
    state.requests.push(record);
    const ctx = {
      state, send, sseWriter, provenanceFor, readBody, url, record,
      newJobId: () => `job-${nextJob++}`,
    };

    // ── The fault layer, before any route ────────────────────────────────
    const reset = takeFault(state.faults.resetAfterBytes, req.method, routePath);
    if (reset) {
      record.fault = `reset after ${reset.afterBytes} byte(s)`;
      armReset(res, reset.afterBytes === undefined ? 0 : reset.afterBytes);
      if (reset.afterBytes === undefined || reset.afterBytes <= 0) return undefined;
    }
    const stall = takeFault(state.faults.connectDelay, req.method, routePath);
    if (stall) {
      record.fault = `no answer for ${stall.ms} ms`;
      await new Promise((r) => {
        const t = setTimeout(r, stall.ms);
        req.on('close', () => { clearTimeout(t); r(); });
      });
      if (res.writableEnded || res.destroyed) return undefined;
      if (stall.thenDestroy !== false) {
        if (res.socket) res.socket.destroy();
        return undefined;
      }
    }
    const refusal = takeFault(state.faults.refuse, req.method, routePath);
    if (refusal) {
      record.fault = `${refusal.status} ${refusal.code}`;
      const headers = { 'Content-Type': 'application/json' };
      if (refusal.retryAfter !== undefined) headers['Retry-After'] = String(refusal.retryAfter);
      res.writeHead(refusal.status, headers);
      res.end(JSON.stringify({
        error: {
          code: refusal.code,
          message: refusal.message || refusal.code,
          details: refusal.details === undefined ? null : refusal.details,
        },
      }));
      return undefined;
    }

    if (routePath === '/v1/ping' && req.method === 'GET') {
      return send(res, 200, { crucible: true, name: 'fake-crucible', api_version: 1 });
    }

    if (routePath === '/v1/uploads' && req.method === 'POST') {
      const body = await readBody(req);
      const part = parseMultipart(req, body);
      const blobId = `blob-${nextBlob++}`;
      state.uploads.push({ filename: part.filename, bytes: part.bytes, blobId });
      return send(res, 200, {
        blob_id: blobId,
        bytes: part.bytes.length,
        sha256: crypto.createHash('sha256').update(part.bytes).digest('hex'),
      });
    }

    const cancel = /^\/v1\/jobs\/([^/]+)$/.exec(routePath);
    if (cancel && req.method === 'DELETE') {
      const id = decodeURIComponent(cancel[1]);
      state.cancelled.push(id);
      return send(res, 200, { job_id: id, status: 'cancelling' });
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(routePath);
    if (events && req.method === 'GET') {
      state.eventsRequests.push({
        jobId: decodeURIComponent(events[1]),
        lastEventId: Number(req.headers['last-event-id'] || 0),
      });
    }

    const handled = await route(req, res, ctx);
    if (handled) return undefined;
    return send(res, 404, { error: { code: 'not_found', message: routePath } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

/**
 * Name fakes through the ONE function the doors use to turn a server name into
 * a client. `addServer` refuses loopback URLs on purpose (the local server has
 * one owner, its own config.toml), so a fake is reached by patching that
 * function rather than by weakening the registry — every byte still crosses a
 * real socket to the real fake.
 */
function fakeNamer(serversModule) {
  const { CrucibleClient } = require('@crucible/client');
  const fakesByName = new Map();
  const real = serversModule.crucibleClientFor;
  serversModule.crucibleClientFor = function crucibleClientForWithFakes(name, clientName) {
    const fake = fakesByName.get(name);
    if (!fake) return real(name, clientName);
    return new CrucibleClient({ url: fake.url, token: 'test-token-abcd', clientName });
  };
  /*
   * AND THE REGISTRY ROW ITSELF, because not every door goes through
   * `crucibleClientFor` any more. `engine-resolve.ts` takes the ENTRY — it has
   * to build a second client at the ORCHESTRATOR's `engine.url` with the same
   * token, which a name cannot express — so a fake that stubbed only the client
   * factory would make every resolver call refuse "no crucible server named
   * fakeN is registered". The token is the same invented one the client stub
   * uses; these fakes check no bearer.
   */
  const realGet = serversModule.getServer;
  serversModule.getServer = function getServerWithFakes(name) {
    const fake = fakesByName.get(name);
    if (!fake) return realGet(name);
    return { name, url: fake.url, token: 'test-token-abcd' };
  };
  let registered = 0;
  return function registerFake(url) {
    const name = `fake${++registered}`;
    fakesByName.set(name, { url });
    return name;
  };
}

/** A VenueHost that names one server as top-ranked. */
function crucibleHost(serverName) {
  return {
    view: () => ({ ranked: [{ name: serverName, enabled: true }], newJobsWaitFor: 'top-ranked' }),
    enabled: () => [{ name: serverName, enabled: true }],
    ping: async () => ({ outcome: 'ok', serverName: 'fake-crucible', apiVersion: 1 }),
  };
}

/**
 * A VenueHost with NOTHING ENABLED — every door must refuse `no_enabled_server`
 * BY NAME and touch no card.
 *
 * It replaces `legacyHost()`, which used to turn the legacy local-render switch
 * on and assert that each door spawned here instead. That switch and the spawn
 * layer behind it are DELETED (docs/LEGACY-REMOVAL.md), so the branch those
 * suites were pinning is now the one thing that must NOT exist: with no server
 * to place work on, the honest answer is a refusal naming the settings page,
 * never a quiet local run.
 *
 * `no_enabled_server` is `routing.ts`'s own code and wording, reproduced here
 * because a keeper drives this host with no record on disk.
 */
function noServerHost() {
  const refuse = () => {
    const err = new Error(
      'no Crucible server is available to the queue: this machine has none, and none is '
      + 'registered. Add one in Settings \u2192 Crucible Servers.',
    );
    err.name = 'CrucibleRoutingError';
    err.code = 'no_enabled_server';
    throw err;
  };
  return {
    view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [] }),
    enabled: refuse,
    ping: async () => { throw new Error('nothing enabled: there is nobody to ping'); },
  };
}

/**
 * ── THE THREE LEASE ROUTES ──────────────────────────────────────────────────
 *
 * `POST /v1/models/{id}/lease`, `POST /v1/leases/{id}/heartbeat` and
 * `DELETE /v1/leases/{id}` — crucible `docs/PHASE7-LANES.md` §5.2, built there on
 * 2026-09-14. Added here as a HANDLER a keeper's own `route` delegates to,
 * rather than wired into {@link startFakeCrucible}, because this file is shared
 * by six suites and none of them should grow a route they never asked for.
 *
 * It speaks the real shapes: `201` with the six-field receipt, `200 {expires_at}`
 * on a heartbeat, a bare `204` on a release (no body at all — which is what
 * proves the client does not try to parse one), and the refusal envelope
 * `{"error": {"code", "message", "details"}}` for every no.
 *
 * `behaviour` is how a keeper makes the server say the awkward things:
 *
 *   refuseLease(attempt, n)     → null, or {status, code, message, details}
 *   refuseHeartbeat(leaseId, n) → the same, e.g. 404 unknown_lease (a restart)
 *   refuseRelease(leaseId, n)   → the same, e.g. 404 unknown_lease (expired)
 *   releaseDelayMs             → how long a DELETE takes to ANSWER (default 0)
 *
 * `n` is 1-based: "the FIRST heartbeat fails, later ones do not" is the shape a
 * re-lease check needs and a flag could not express.
 *
 * ── ONE LEASE PER SERVER, ENFORCED (added 2026-09-14) ──────────────────────
 *
 * The real server holds exactly one (`crucible/leases.py`) and answers `409
 * leased` with the holder's name, act and clock to anything that asks for a
 * second — INCLUDING the client that already holds it, because it cannot tell
 * two of one app's runs apart. This fake used to grant every take, which made
 * a whole class of defect invisible: BookForge's row scope kept a lease across
 * a change of MODEL, and the next act's own load would have been refused by
 * the lease this app was still holding. The suite proved that "worked".
 *
 * So a take while one is open is refused here exactly as the server refuses
 * it, and the refusal is recorded on `lease.refusals` like every other. A
 * keeper that WANTS the old permissiveness passes `allowConcurrentLeases: true`
 * and has to say so.
 *
 * Everything that crossed is recorded on the returned `lease` object, including
 * the `User-Agent`, because the server records it as the holder's name and a
 * client that did not send one is a bench that cannot say whose run is on the
 * card.
 */
function leaseRoutes(behaviour = {}) {
  const lease = {
    /** {model, act, ttlSeconds, userAgent, leaseId} per granted lease. */
    taken: [],
    /** {leaseId} per heartbeat that reached the server, refused or not. */
    heartbeats: [],
    /** {leaseId} per release that reached the server, refused or not. */
    released: [],
    /** The refusals this fake answered, for a check that wants to count them. */
    refusals: [],
    /**
     * EVERY LEASE CALL THAT CROSSED, IN ORDER — `{kind, model?, leaseId, ok}`.
     *
     * `taken` and `released` answer "how many"; only this answers "in which
     * order", which is the question a run of acts is about: a release that
     * happens between two acts is a reload, and a take before the release
     * ahead of it is a 409 this app hands itself. Recorded for refused calls
     * too (`ok: false`), because a refusal is a thing that crossed.
     */
    wire: [],
  };
  let nextId = 1;
  /** The one lease this server is holding, or null. See the header. */
  let open = null;
  let leaseAttempts = 0;
  let heartbeatAttempts = 0;
  let releaseAttempts = 0;

  // Every branch answers `true` — `startFakeCrucible`'s dispatcher reads a falsy
  // return as "not handled" and sends its own 404 on top, which is a thrown
  // ERR_HTTP_HEADERS_SENT rather than a test failure.
  const refuse = (res, refusal) => {
    lease.refusals.push(refusal);
    send(res, refusal.status, {
      error: {
        code: refusal.code,
        message: refusal.message,
        details: refusal.details === undefined ? null : refusal.details,
      },
    });
    return true;
  };

  return {
    lease,
    async handler(req, res, ctx) {
      const take = /^\/v1\/models\/([^/]+)\/lease$/.exec(ctx.url.pathname);
      if (take && req.method === 'POST') {
        leaseAttempts += 1;
        const model = decodeURIComponent(take[1]);
        const body = JSON.parse((await ctx.readBody(req)).toString('utf-8') || '{}');
        const attempt = {
          model,
          act: body.act,
          ttlSeconds: body.ttl_seconds,
          userAgent: req.headers['user-agent'] || null,
        };
        const refusal = behaviour.refuseLease ? behaviour.refuseLease(attempt, leaseAttempts) : null;
        if (refusal) return refuse(res, refusal);
        /*
         * A SERVER HOLDS ONE LEASE. Named per test through `behaviour` only so
         * a keeper that is deliberately exercising the permissive shape has to
         * say so out loud; the default is what the server does.
         */
        if (open !== null && behaviour.allowConcurrentLeases !== true) {
          lease.wire.push({ kind: 'take', model, leaseId: null, ok: false });
          return refuse(res, modelLeasedRefusal({
            model: open.model,
            client: open.userAgent,
            act: open.act,
            since: '2026-09-14T02:00:00+00:00',
            expiresAt: '2026-09-14T02:02:00+00:00',
            leaseId: open.leaseId,
            kind: behaviour.leaseKind || 'llm',
          }));
        }
        const leaseId = `lease-${nextId++}`;
        open = { ...attempt, leaseId };
        lease.taken.push({ ...attempt, leaseId });
        lease.wire.push({ kind: 'take', model, leaseId, ok: true });
        send(res, 201, {
          // `subject` and `kind`, as crucible 5e04e5f sends them: a lease names
          // the resident THING, which is a voice or an aligner as often as a
          // model, and the receipt is the one document with no `resident`
          // beside it to read the id from.
          lease_id: leaseId,
          subject: model,
          kind: behaviour.leaseKind || 'llm',
          client: attempt.userAgent,
          act: attempt.act,
          since: '2026-09-14T02:00:00+00:00',
          expires_at: '2026-09-14T02:02:00+00:00',
        });
        return true;
      }

      const beat = /^\/v1\/leases\/([^/]+)\/heartbeat$/.exec(ctx.url.pathname);
      if (beat && req.method === 'POST') {
        heartbeatAttempts += 1;
        const leaseId = decodeURIComponent(beat[1]);
        lease.heartbeats.push({ leaseId });
        const refusal = behaviour.refuseHeartbeat
          ? behaviour.refuseHeartbeat(leaseId, heartbeatAttempts)
          : null;
        if (refusal) {
          /*
           * A SERVER THAT ANSWERS `unknown_lease` IS NOT HOLDING ONE.
           *
           * That refusal means the lease is gone — a restart forgot it, or it
           * expired — and the client's correct answer is to take a new one on
           * the same model. So the card has to be free here, or the fake would
           * refuse the re-lease with a lease it has just said it does not have,
           * which is a state no real server can be in.
           */
          if (refusal.code === 'unknown_lease' && open !== null && open.leaseId === leaseId) {
            open = null;
          }
          return refuse(res, refusal);
        }
        send(res, 200, { expires_at: '2026-09-14T02:04:00+00:00' });
        return true;
      }

      const give = /^\/v1\/leases\/([^/]+)$/.exec(ctx.url.pathname);
      if (give && req.method === 'DELETE') {
        releaseAttempts += 1;
        const leaseId = decodeURIComponent(give[1]);
        lease.released.push({ leaseId });
        const refusal = behaviour.refuseRelease
          ? behaviour.refuseRelease(leaseId, releaseAttempts)
          : null;
        if (refusal) {
          lease.wire.push({ kind: 'release', model: null, leaseId, ok: false });
          return refuse(res, refusal);
        }
        // The card is free again — a release the server ACCEPTED is what makes
        // the next take possible, which is the whole point of enforcing one.
        /*
         * A RELEASE TAKES TIME, and a keeper can say how much. The card is
         * free only once the server has processed the DELETE, so a client that
         * fires one and immediately asks for the next lease is refused. With
         * `releaseDelayMs` at 0 that window is too small to observe reliably,
         * which is exactly how a real race hides from a suite.
         */
        if (behaviour.releaseDelayMs) {
          await new Promise((r) => setTimeout(r, behaviour.releaseDelayMs));
        }
        const was = open !== null && open.leaseId === leaseId ? open.model : null;
        if (open !== null && open.leaseId === leaseId) open = null;
        lease.wire.push({ kind: 'release', model: was, leaseId, ok: true });
        // A BARE 204: no body, no Content-Type. A client that tried to parse one
        // would throw here rather than on a real server at 3 a.m.
        res.writeHead(204);
        res.end();
        return true;
      }

      return false;
    },
  };
}

/** `409 leased`, with the details the server actually sends (`leased` since crucible 5e04e5f:
 * a lease names the resident THING, so a code naming one kind would be false
 * whenever narrator or the aligner holds the card). */
function modelLeasedRefusal(held) {
  return {
    status: 409,
    code: 'leased',
    message: `'${held.model}' is leased by '${held.client}' for '${held.act}' since ${held.since}, `
      + `until at least ${held.expiresAt} — so leasing it is refused rather than taking the model `
      + 'off the card underneath a run in progress.',
    details: {
      lease_id: held.leaseId,
      kind: held.kind || 'llm',
      client: held.client,
      act: held.act,
      since: held.since,
      expires_at: held.expiresAt,
    },
  };
}

/**
 * -- THE SETTINGS DOOR (crucible docs/PHASE15-HOST.md 3.1, 3.2, 3.3) --------
 *
 * `GET /v1/settings`, `PUT /v1/settings`,
 * `POST /v1/settings/upstreams/{name}/test` and a `GET /v1/capability` whose
 * rows carry `route`. Added as a DELEGATED handler beside {@link leaseRoutes},
 * for the same reason that one is: this file is shared by fifteen suites and
 * none of them should grow a route it never asked for.
 *
 * It speaks the wire in the SERVER's spelling -- snake_case, `key_hint`,
 * `desktop_allowance_bytes`, `backend_kind` -- because the whole point of the
 * seam under test is that it reads THAT and hands up camelCase. A fake that
 * answered in the client's spelling would test nothing.
 *
 * -- A KEY IS WRITE-ONLY HERE TOO ------------------------------------------
 *
 * 3.1: "A key is write-only... There is no route that returns a key." So this
 * fake stores what it is sent, reports `configured` and the last four
 * characters, and has no branch that could put a key in a response. A keeper
 * asserts the served JSON never contains one, which is only a real assertion
 * because the fake is capable of holding one.
 *
 * -- THE THREE BACKENDS, INCLUDING WINDOWS ---------------------------------
 *
 * AMENDED 2026-09-14 (crucible 56cfe37): Windows IS a backend,
 * `llama-windows`, structurally what `mlx-darwin` is. It serves the llm
 * classes and `pages`; the five Python-job classes answer `enabled: false`
 * with ONE shared sentence (3.3). `backendKind: 'llama-windows'` makes this
 * fake answer that way, so a wizard's faces can be driven without a machine.
 *
 * `behaviour`:
 *   routes            initial routes, e.g. {translate: 'anthropic/claude-x'}
 *   upstreams         initial config, e.g. {anthropic: {key: 'sk-ant-1234'}}
 *   backendKind       'cuda-linux' (default), 'mlx-darwin', 'llama-windows'
 *   localModelFor(c)  the local model a class would use, or null
 *   refusePut(n)      null, or {status, code, message, details}
 *   refuseTest(name, n)  the same
 *   testModels(name)  what the upstream lists; default three ids
 *   omitRoute         true -> NO row carries `route` (a pre-phase-15 server)
 *   routeMissingFor   a class name -> every OTHER row carries `route` and that
 *                     one does not (the document a client must refuse)
 *   badRouteFor       a class name -> that row's `route` is a value from a
 *                     newer contract
 *   noSettingsDoor    true -> 404 on every settings route (a pre-phase-15 one)
 *   noCapabilityDoor  true -> 404 on `GET /v1/capability` and nothing else.
 *                     Spelled separately from `noSettingsDoor` because the two
 *                     are different servers: a pre-phase-15 engine has no
 *                     settings document but DOES answer capability, while a
 *                     server that cannot answer capability is simply a server
 *                     that is not answering — which is the third of the three
 *                     reads `electron/crucible/coordinate.ts` makes on every
 *                     connect, and the one a keeper has to be able to break on
 *                     its own to prove the verdict is not decided by the other
 *                     two. The attempt is still counted in `capabilityReads`:
 *                     a read that was made and refused is a read that crossed.
 *   dropClasses       a list of class names whose ROW IS ABSENT from the
 *                     capability document. The 5.3a shape: a Mac has no
 *                     `pages` block at all, so its record never mentions the
 *                     class, and a module that names it must be told "not on
 *                     this engine" rather than have `local` assumed for it.
 *   disableClasses    {class: reason} -> that row is `enabled: false` with
 *                     THAT reason, verbatim. The other half of 5.3a: a class
 *                     the backend has measured and turned off. The reason is
 *                     the knob because the whole point of the ruling is that
 *                     the SERVER's sentence is what an app shows.
 */
const LLM_CLASSES = ['clean', 'translate', 'simplify', 'analysis'];
const UPSTREAM_NAMES = ['anthropic', 'openai', 'ollama'];
/** The five classes only the WSL2 engine serves, and the one sentence for all of them (3.3). */
const WSL_ONLY_CLASSES = ['tts', 'asr', 'align', 'rvc', 'denoise'];
const WSL_ONLY_REASON = 'this job type needs the WSL2 engine (vLLM/SGLang); install it from the console';

function settingsRoutes(behaviour) {
  behaviour = behaviour || {};
  const state = {
    /** Every PUT body that crossed, in order. */
    puts: [],
    /** Every test that crossed: `{name, body}`. */
    tests: [],
    /** How many times the document was read. */
    reads: 0,
    /** How many times capability was read. */
    capabilityReads: 0,
    /** The refusals this fake answered. */
    refusals: [],
    /** Everything served, as text, so a keeper can grep it for a key. */
    served: [],
  };
  const routes = Object.assign({}, behaviour.routes || {});
  const upstreams = JSON.parse(JSON.stringify(behaviour.upstreams || {}));
  const backendKind = behaviour.backendKind || 'cuda-linux';
  const localModelFor = behaviour.localModelFor || function (c) {
    return c === 'clean' ? 'qwen3.5-9b' : null;
  };
  let putAttempts = 0;
  const testAttempts = {};

  const upstreamOf = (name) => (Object.prototype.hasOwnProperty.call(upstreams, name) ? upstreams[name] : null);
  const configured = (name) => {
    const u = upstreamOf(name);
    if (u === null) return false;
    return name === 'ollama'
      ? typeof u.url === 'string' && u.url !== ''
      : typeof u.key === 'string' && u.key !== '';
  };

  const document = () => {
    const routeDoc = {};
    for (const c of LLM_CLASSES) {
      const value = routes[c];
      routeDoc[c] = value === undefined || value === 'local'
        ? { route: 'local', model: localModelFor(c) }
        : { route: 'upstream', model: value };
    }
    const upstreamDoc = {};
    for (const name of UPSTREAM_NAMES) {
      const u = upstreamOf(name);
      if (name === 'ollama') {
        upstreamDoc[name] = { configured: configured(name), url: u === null ? null : (u.url || null) };
      } else {
        upstreamDoc[name] = {
          configured: configured(name),
          // WITH the leading ellipsis, exactly as the server sends it
          // (crucible c5482ff) — a client renders this verbatim, so a fake
          // that sent the four bare characters would let a stripper through.
          key_hint: configured(name) ? '\u2026' + String(u.key).slice(-4) : null,
        };
      }
    }
    /*
     * MODEL ASSIGNMENT, in the server's spelling. A 0.6.6 engine emits both
     * maps unconditionally, so the DEFAULT here emits both — a fake that left
     * them out would make every other keeper exercise the vintage path by
     * accident. `behaviour.localModels` names the three shapes worth testing:
     *   'absent'       — neither map, which is a server older than the feature
     *   'selected-only' / 'choices-only' — a PARTIAL document, which is a defect
     */
    const shape = behaviour.localModels || 'both';
    const selectedDoc = {};
    const choicesDoc = {};
    for (const c of LLM_CLASSES) {
      selectedDoc[c] = localModelFor(c);
      choicesDoc[c] = [
        { id: 'qwen3.5-9b', memory_bytes_estimate: 20950548480, fits: true, installed: true },
        { id: 'qwen3.8-27b', memory_bytes_estimate: 56368313144, fits: false, installed: false },
      ];
    }
    const doc = {
      routes: routeDoc,
      upstreams: upstreamDoc,
      desktop_allowance_bytes: 3221225472,
      backend_kind: backendKind,
    };
    if (shape === 'both' || shape === 'selected-only') doc.local_models = selectedDoc;
    if (shape === 'both' || shape === 'choices-only') doc.local_model_choices = choicesDoc;
    return doc;
  };

  /*
   * `shortfall_bytes`, not `shortfallBytes`: this fake speaks the SERVER's
   * spelling and `crucible/config.py` writes snake_case, which is also what
   * the SDK's own `readCapabilityRow` demands. It used to send the camelCase
   * one and nothing noticed, because the reader it was tested against accepted
   * either — a leniency that would have hidden the day a real server and this
   * app disagreed about the name of the number that turns a class off.
   */
  const capabilityRow = (c) => {
    const upstream = routes[c] !== undefined && routes[c] !== 'local';
    if (WSL_ONLY_CLASSES.indexOf(c) !== -1) {
      const here = backendKind === 'llama-windows';
      return {
        capability: c,
        enabled: !here,
        selected: here ? '' : 'higgs-v3',
        reason: here ? WSL_ONLY_REASON : 'installed',
        shortfall_bytes: 0,
      };
    }
    const local = localModelFor(c);
    return {
      capability: c,
      enabled: upstream ? true : local !== null,
      selected: upstream ? routes[c] : (local === null ? '' : local),
      reason: upstream
        ? 'routed to ' + String(routes[c]).split('/')[0] + '; the local answer would be: '
          + (local === null ? 'nothing fits' : local)
        : (local === null ? 'nothing on this card fits' : local + ' fits'),
      shortfall_bytes: 0,
    };
  };

  const dropped = behaviour.dropClasses || [];
  const disabled = behaviour.disableClasses || {};

  const capability = () => ({
    backend_kind: backendKind,
    total_bytes: 25769803776,
    desktop_allowance_bytes: 3221225472,
    classes: LLM_CLASSES.concat(['pages'], WSL_ONLY_CLASSES)
      // A DROPPED CLASS HAS NO ROW AT ALL -- not a row saying no. 5.3a's Mac
      // has no `pages` block, so its record never mentions the class, and the
      // two are different documents to read.
      .filter((c) => dropped.indexOf(c) === -1)
      .map((c) => {
        const row = capabilityRow(c === 'pages' ? 'pages' : c);
        if (c === 'pages') {
          row.enabled = true;
          row.selected = 'dots-ocr';
          row.reason = 'dots-ocr fits';
        }
        if (Object.prototype.hasOwnProperty.call(disabled, c)) {
          row.enabled = false;
          row.selected = '';
          row.reason = disabled[c];
        }
        if (behaviour.omitRoute !== true && behaviour.routeMissingFor !== c) {
          row.route = behaviour.badRouteFor === c
            ? 'somewhere-else'
            : routes[c] !== undefined && routes[c] !== 'local' ? 'upstream' : 'local';
        }
        return row;
      }),
  });

  // Every branch answers `true`; see the note in `leaseRoutes`.
  const serve = (res, status, body) => {
    state.served.push(JSON.stringify(body));
    send(res, status, body);
    return true;
  };
  const refuse = (res, refusal) => {
    state.refusals.push(refusal);
    return serve(res, refusal.status, {
      error: {
        code: refusal.code,
        message: refusal.message,
        details: refusal.details === undefined ? null : refusal.details,
      },
    });
  };

  return {
    settings: state,
    /** The document as the fake currently holds it -- what a keeper asserts against. */
    snapshot: document,
    async handle(req, res, ctx) {
      const route = ctx.url.pathname;
      if (route.indexOf('/v1/settings') !== 0 && route !== '/v1/capability') return false;

      if (behaviour.noSettingsDoor === true && route.indexOf('/v1/settings') === 0) {
        return serve(res, 404, { error: { code: 'not_found', message: 'no such route', details: null } });
      }

      if (route === '/v1/capability' && req.method === 'GET') {
        state.capabilityReads += 1;
        if (behaviour.noCapabilityDoor === true) {
          return serve(res, 404, { error: { code: 'not_found', message: 'no such route', details: null } });
        }
        return serve(res, 200, capability());
      }

      if (route === '/v1/settings' && req.method === 'GET') {
        state.reads += 1;
        return serve(res, 200, document());
      }

      if (route === '/v1/settings' && req.method === 'PUT') {
        putAttempts += 1;
        const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
        state.puts.push(body);
        const refusal = behaviour.refusePut ? behaviour.refusePut(putAttempts) : null;
        if (refusal) return refuse(res, refusal);
        // Upstreams first, then routes, then validate -- the server's own order
        // (3.2), which is what makes "one PUT configures AND routes" true.
        for (const name of Object.keys(body.upstreams || {})) {
          const value = body.upstreams[name];
          if (value === null) delete upstreams[name];
          else upstreams[name] = Object.assign({}, upstreams[name] || {}, value);
        }
        for (const cls of Object.keys(body.routes || {})) {
          const value = body.routes[cls];
          if (LLM_CLASSES.indexOf(cls) === -1) {
            return refuse(res, {
              status: 400,
              code: 'route_not_routable',
              message: 'the "' + cls + '" class is not routable',
              details: { field: 'routes.' + cls },
            });
          }
          if (value === 'local') { delete routes[cls]; continue; }
          const upstreamName = String(value).split('/')[0];
          if (String(value).indexOf('/') === -1 || UPSTREAM_NAMES.indexOf(upstreamName) === -1) {
            return refuse(res, {
              status: 400,
              code: 'route_bad_model',
              message: '"' + value + '" is not an upstream model id',
              details: { field: 'routes.' + cls },
            });
          }
          if (!configured(upstreamName)) {
            return refuse(res, {
              status: 400,
              code: 'route_upstream_unconfigured',
              message: upstreamName + ' has no key',
              details: { field: 'upstreams.' + upstreamName + '.key' },
            });
          }
          routes[cls] = value;
        }
        return serve(res, 200, document());
      }

      const test = /^\/v1\/settings\/upstreams\/([^/]+)\/test$/.exec(route);
      if (test !== null && req.method === 'POST') {
        const name = decodeURIComponent(test[1]);
        const body = JSON.parse((await ctx.readBody(req)).toString('utf-8') || '{}');
        state.tests.push({ name, body });
        testAttempts[name] = (testAttempts[name] || 0) + 1;
        const refusal = behaviour.refuseTest ? behaviour.refuseTest(name, testAttempts[name]) : null;
        if (refusal) return refuse(res, refusal);
        const probed = (body.key !== undefined && body.key !== '') || (body.url !== undefined && body.url !== '');
        if (!probed && !configured(name)) {
          return refuse(res, {
            status: 400,
            code: 'upstream_unconfigured',
            message: name + ' has nothing configured and the test carried nothing',
            details: null,
          });
        }
        const models = behaviour.testModels
          ? behaviour.testModels(name)
          : ['model-a', 'model-b', 'model-c'];
        return serve(res, 200, { models });
      }

      return serve(res, 405, {
        error: { code: 'method_not_allowed', message: req.method + ' ' + route, details: null },
      });
    },
  };
}

/** `404 unknown_lease` — the shape a heartbeat after a restart, or a late release, gets. */
function unknownLeaseRefusal(leaseId, why) {
  return {
    status: 404,
    code: 'unknown_lease',
    message: `lease ${leaseId} is no longer open: ${why}.`,
    details: { lease_id: leaseId, reason: why },
  };
}

/**
 * ── A WHOLE JOB LIFECYCLE, WITH THE WAYS IT GOES WRONG (PK13) ───────────────
 *
 * A delegated handler beside {@link leaseRoutes} and {@link settingsRoutes},
 * for the same reason those two are delegated: this file is shared by fifteen
 * suites and none of them should grow a route it never asked for.
 *
 * It owns `POST /v1/jobs`, the event stream, the artifact fetches, `DELETE` and
 * `GET /v1/activity`, and it can misbehave in the ways the night of Sep 19 did:
 *
 *   refuseSubmit(n, body)   → a refusal, e.g. `503 chat_queue_full` with a
 *                             `Retry-After`, or `409 server_busy`.
 *   slowFramesMs            → milliseconds BETWEEN frames. Past the caller's
 *                             stall clock this is a stream that went quiet.
 *   partialArtifacts        → the FIRST artifact GET fails `500` once, then the
 *                             same fetch succeeds. A `done` frame whose
 *                             artifacts cannot be landed is not a failed job.
 *   neverFinishes           → the stream stops after its opening frames and
 *                             says nothing more: the stall clock's case.
 *   endsFailed              → the job RAN and failed, which is not a refusal.
 *   holdUntilCancelled      → the stream emits its opening frames and then
 *                             waits for a DELETE, ending `cancelled`.
 *   activity                → `{residentId?, holder?, maxInFlight?, inFlight?}`
 *                             for `GET /v1/activity` (1.0.10's chat admission
 *                             number lives here as `chat.max_in_flight`).
 *
 * `restart()` on the handle is a server that FORGOT everything: a reconnecting
 * `events()` gets `404 unknown_job`, a heartbeat `404 unknown_lease`, and a
 * DELETE of a job it no longer knows `404 unknown_job` — which is what a client
 * sees when the box it was talking to came back up under it.
 */
function faultyJobRoutes(behaviour = {}) {
  const jobs = {
    /** Every submit body, in order. */
    submitted: [],
    /** Every events GET: {jobId, lastEventId, answered}. */
    streams: [],
    /** Every artifact GET: {jobId, name, ok}. */
    artifacts: [],
    /** How many times the server forgot everything. */
    restarts: 0,
    /**
     * Job ids the server is still RUNNING for anybody — a cancelled one is not
     * one, and the DELETE that cancelled it was handled by
     * {@link startFakeCrucible} rather than here, so the two records are joined
     * at the one place that answers the question.
     */
    live: () => [...open.keys()].filter((id) => (hostState === null ? true : hostState.cancelled.indexOf(id) === -1)),
  };
  /** jobId → {body, names} for the jobs this server still knows. */
  const open = new Map();
  /** The event-stream responses open right now, so a restart can kill them. */
  const streaming = new Set();
  /** The dispatcher's state, captured on the first request (see `live`). */
  let hostState = null;
  let submits = 0;
  let artifactFetches = 0;
  let nextId = 1;

  /**
   * WHAT IS ON THE CARD, AND WHETHER ANYBODY IS COMING BACK FOR IT.
   *
   * Crucible 1.0.11's two fields, modelled as the ONE fact they are. Nothing
   * sets both: `loaded()` puts something on the card held by whatever asked for
   * it; `stranded()` is a load whose asker walked away, which stamps
   * `unclaimedSince` and clears the holder.
   */
  const card = {
    id: null, kind: null, since: null, heldBy: null, unclaimedSince: null, warming: null,
  };

  // Every branch must answer `true`: `startFakeCrucible`'s dispatcher reads a
  // falsy return as "not handled" and sends its own 404 on top, which is a
  // thrown ERR_HTTP_HEADERS_SENT rather than a test failure.
  const serve = (res, status, body) => { send(res, status, body); return true; };
  const refuse = (res, status, code, message, extra = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (extra.retryAfter !== undefined) headers['Retry-After'] = String(extra.retryAfter);
    res.writeHead(status, headers);
    res.end(JSON.stringify({
      error: { code, message, details: extra.details === undefined ? null : extra.details },
    }));
    return true;
  };

  const artifactNames = (body) => (behaviour.artifacts
    ? behaviour.artifacts(body)
    : Object.keys(body.inputs || {}).map((n) => `${n}.out`));

  return {
    jobs,
    /** What the card currently says, for a scenario's assertion. */
    card,
    /** Something was loaded and SOMETHING holds it. */
    loaded(id, heldBy, kind = 'llm') {
      card.id = id;
      card.kind = kind;
      card.since = new Date().toISOString();
      card.heldBy = heldBy === undefined ? { fact: 'lease', who: 'bookforge', details: {} } : heldBy;
      card.unclaimedSince = null;
      card.warming = null;
    },
    /**
     * A LOAD THAT COMPLETED AND NOBODY CAME BACK FOR — S14's signature. The
     * card is resident, `held_by` is null, and `unclaimed_since` is when the
     * load finished. `at` so a scenario can state the moment rather than
     * measure it.
     */
    stranded(id, at = new Date().toISOString(), kind = 'llm') {
      // THE JOB IS OVER — that is what `409 job_not_cancellable` means. What is
      // left is the thing it loaded, and nothing holding it.
      open.clear();
      for (const res of streaming) { try { res.socket.destroy(); } catch { /* gone */ } }
      streaming.clear();
      card.id = id;
      card.kind = kind;
      card.since = at;
      card.heldBy = null;
      card.unclaimedSince = at;
      card.warming = null;
    },
    /** Nothing on the card at all. */
    empty() {
      card.id = null; card.kind = null; card.since = null;
      card.heldBy = null; card.unclaimedSince = null; card.warming = null;
    },
    /**
     * The server came back up with no memory of anything — and the open event
     * streams DIE WITH IT, because that is what a restart is. A fake that
     * forgot its jobs while its sockets kept writing frames would model a
     * server nobody has ever run.
     */
    restart() {
      jobs.restarts += 1;
      open.clear();
      for (const res of streaming) { try { res.socket.destroy(); } catch { /* already gone */ } }
      streaming.clear();
      card.id = null; card.kind = null; card.since = null;
      card.heldBy = null; card.unclaimedSince = null; card.warming = null;
    },
    async handle(req, res, ctx) {
      hostState = ctx.state;
      const route = ctx.url.pathname;

      if (route === '/v1/activity' && req.method === 'GET') {
        const a = behaviour.activity || {};
        const id = card.id === null ? (a.residentId === undefined ? null : a.residentId) : card.id;
        // WHO HOLDS IT, DERIVED — never taken on trust from a scenario. A job
        // this fake is running IS a holder, and a fake that let a test say
        // "nothing holds it" while a stream was open would model a server that
        // does not exist.
        const holder = open.size > 0
          ? { fact: 'job', who: 'a client', details: { job_id: [...open.keys()][0] } }
          : card.heldBy;
        return serve(res, 200, {
          server: { name: 'fake-crucible', version: '1.0.11', api_version: 1, backend: 'cuda-linux', uptime_s: 12 },
          resident: id === null || id === undefined
            ? null
            : {
              kind: card.kind || a.residentKind || 'llm',
              id,
              since: card.since || '2026-09-20T01:00:00Z',
              memory_bytes_estimate: null,
              /*
               * ── CRUCIBLE 1.0.11: THE CARD SAYS WHEN NOBODY IS COMING BACK ──
               *
               * `held_by` is `null` or `{fact, who, details}` — what is holding
               * the resident thing right now (a lease, a chat, a job, a
               * stream). `unclaimed_since` is the mirror: non-null means
               * RESIDENT AND HELD BY NOTHING, since that moment.
               *
               * The two are exclusive by construction here, because they are
               * one fact in the server: a load that completed with no lease, no
               * chat and no job behind it is a STRANDED CARD, and its
               * `unclaimed_since` is the load's completion time. That is S14's
               * signature — the DELETE that arrived one tick after the load
               * finished, `409 job_not_cancellable`, and 12 GB resident that
               * nobody ever asks for again.
               */
              held_by: holder === null || holder === undefined ? null : holder,
              unclaimed_since: holder === null || holder === undefined
                ? (card.unclaimedSince || a.unclaimedSince || null)
                : null,
            },
          stopping: null,
          warming: card.warming === null ? (a.warming === undefined ? null : a.warming) : card.warming,
          claim: a.holder ? { held_by: a.holder } : null,
          streaming: null,
          chat: {
            in_flight: a.inFlight === undefined ? 0 : a.inFlight,
            /*
             * 1.0.10's admission number, and 1.0.11's account of where it came
             * from. BookForge itself does not read either today — Foundry's
             * dispatcher does (PK8) — but the SDK READS BOTH KEYS STRICTLY, so
             * a fake that left one out is a `crucible_protocol` refusal rather
             * than a test of anything.
             */
            max_in_flight: a.maxInFlight === undefined ? 4 : a.maxInFlight,
            max_in_flight_basis: a.maxInFlightBasis === undefined ? 'stated' : a.maxInFlightBasis,
            rows: [],
          },
          lease: null,
          slots: { accelerated: { busy: open.size, of: 1, queue_depth: 0, accepts_work: open.size === 0 } },
          // THE TEN FIELDS AN ActivityJob CARRIES. The SDK requires every key,
          // null or not, so a three-field row is a protocol refusal and not a
          // running job.
          running: [...open.keys()].map((jid) => ({
            job_id: jid,
            type: open.get(jid).body.type,
            model: open.get(jid).body.model === undefined ? null : open.get(jid).body.model,
            status: 'running',
            position: null,
            progress: 0.5,
            message: null,
            created: '2026-09-20T01:00:00Z',
            started: '2026-09-20T01:00:01Z',
            client: 'bookforge',
          })),
          queued: [],
        });
      }

      if (route === '/v1/jobs' && req.method === 'POST') {
        submits += 1;
        const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
        jobs.submitted.push(body);
        ctx.record.body = body;
        const refusal = behaviour.refuseSubmit ? behaviour.refuseSubmit(submits, body) : null;
        if (refusal) {
          return refuse(res, refusal.status, refusal.code, refusal.message || refusal.code, refusal);
        }
        const id = `job-${nextId++}`;
        open.set(id, { body, names: artifactNames(body) });
        return serve(res, 200, { job_id: id });
      }

      /*
       * THERE IS NO `DELETE` BRANCH HERE, and that is not an omission.
       * {@link startFakeCrucible} handles it FIRST, for all fifteen suites, and
       * records it on `state.cancelled` — which is the record a scenario
       * asserts *"exactly one DELETE was sent"* against. A cancel that must be
       * REFUSED (S14's `409 job_not_cancellable`, a restarted server's `404
       * unknown_job`) is a `faults.refuse` rule matching `DELETE /v1/jobs/`,
       * applied above every route; {@link cancelRefusedFault} spells the two.
       */

      const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
      if (events && req.method === 'GET') {
        const id = decodeURIComponent(events[1]);
        const lastEventId = Number(req.headers['last-event-id'] || 0);
        const entry = open.get(id);
        if (entry === undefined) {
          // The server forgot it — a restart, or a job that never was.
          jobs.streams.push({ jobId: id, lastEventId, answered: 'unknown_job' });
          return refuse(res, 404, 'unknown_job',
            `no job ${id} on this server (it was restarted at ${new Date().toISOString()})`);
        }
        jobs.streams.push({ jobId: id, lastEventId, answered: 'stream' });
        const sse = sseWriter(req, res);
        streaming.add(res);
        req.on('close', () => streaming.delete(res));
        const gap = behaviour.slowFramesMs === undefined ? 0 : behaviour.slowFramesMs;
        const pause = () => (gap > 0 ? new Promise((r) => setTimeout(r, gap)) : Promise.resolve());
        let alive = true;
        req.on('close', () => { alive = false; });
        sse.frame('queued', { position: null });
        await pause();
        if (!alive) return true;
        sse.frame('warming', { message: 'loading the model' });
        await pause();
        if (!alive) return true;
        sse.frame('progress', { fraction: 0.1, message: 'started', stage: 'rendering' });
        if (behaviour.holdUntilCancelled === true) {
          // The DELETE is recorded by `startFakeCrucible` on `state.cancelled`;
          // this is the stream noticing it, which is the order a real server
          // ends a job in.
          await new Promise((done) => {
            const tick = setInterval(() => {
              if (!alive) { clearInterval(tick); done(); return; }
              if (ctx.state.cancelled.indexOf(id) === -1) return;
              clearInterval(tick);
              sse.frame('cancelled', { status: 'cancelled' });
              sse.end();
              open.delete(id);
              done();
            }, 10);
            req.on('close', () => { clearInterval(tick); done(); });
          });
          return true;
        }
        if (behaviour.neverFinishes === true) {
          // A stream that goes quiet and stays quiet: the stall clock's case.
          await new Promise((done) => { req.on('close', done); });
          return true;
        }
        for (const name of entry.names) {
          await pause();
          if (!alive) return true;
          sse.frame('artifact', { name });
        }
        await pause();
        if (!alive) return true;
        if (behaviour.endsFailed === true) {
          sse.frame('failed', { error: { code: 'render_failed', message: 'the model fell over' } });
          sse.end();
          open.delete(id);
          return true;
        }
        /*
         * A SETTLEMENT THAT TAKES TIME — and `/v1/activity` MUST STILL ANSWER.
         *
         * An unload holds the server's own card lock while it takes a 12 GB
         * model off, and the hazard this models is one the real server had:
         * `GET /v1/activity` behind that lock would have hung for the whole
         * unload — up to 180 s — and every poll in the queue with it. Modelled
         * here as a settlement that is SLOW and a read route that is NOT
         * blocked by it, because that is the contract; a scenario polls across
         * this gap and measures how long the answer took.
         */
        if (behaviour.settleHoldsMs) {
          await new Promise((r) => {
            const t = setTimeout(r, behaviour.settleHoldsMs);
            req.on('close', () => { clearTimeout(t); r(); });
          });
          if (!alive) return true;
        }
        if (behaviour.doneShape === 'resident') {
          // An unload's `done`: the card is empty and says so.
          card.id = null; card.kind = null; card.since = null;
          card.heldBy = null; card.unclaimedSince = null;
          sse.frame('done', { resident: null });
        } else {
          sse.frame('done', Object.assign({ artifacts: entry.names }, behaviour.doneExtra || {}));
        }
        sse.end();
        open.delete(id);
        return true;
      }

      const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
      if (artifact && req.method === 'GET') {
        const id = decodeURIComponent(artifact[1]);
        const name = decodeURIComponent(artifact[2]);
        artifactFetches += 1;
        if (behaviour.partialArtifacts === true && artifactFetches === 1) {
          jobs.artifacts.push({ jobId: id, name, ok: false });
          return refuse(res, 500, 'artifact_unavailable', `${name} could not be read back`);
        }
        jobs.artifacts.push({ jobId: id, name, ok: true });
        if (name.endsWith('.provenance.json')) {
          const base = name.replace(/\.provenance\.json$/, '');
          const body = (open.get(id) || {}).body || { type: behaviour.jobType || 'align', model: null };
          return serve(res, 200, provenanceFor(base, body.type, body.model === undefined ? null : body.model));
        }
        const bytes = Buffer.from(behaviour.artifactBytes ? behaviour.artifactBytes(name) : `artifact:${name}`);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
        res.end(bytes);
        return true;
      }

      return false;
    },
  };
}

/**
 * The two ways a server refuses a DELETE, as `faults.refuse` rules.
 *
 *   'not-cancellable' — S14: the job reached `done` one tick before the cancel
 *                       arrived (`409 job_not_cancellable`). Whatever it
 *                       loaded is now resident and nobody holds it.
 *   'unknown'         — the server was restarted and has never heard of it
 *                       (`404 unknown_job`).
 */
function cancelRefusedFault(kind, times = 1) {
  const rule = { match: { method: 'DELETE', path: /^\/v1\/jobs\// }, times };
  if (kind === 'not-cancellable') {
    return Object.assign(rule, {
      status: 409,
      code: 'job_not_cancellable',
      message: 'that job is already done; there is nothing to cancel',
    });
  }
  return Object.assign(rule, {
    status: 404,
    code: 'unknown_job',
    message: 'no such job on this server',
  });
}

module.exports = {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  refuseRenderParams, renderDoneProvenance,
  crucibleHost, noServerHost, send,
  leaseRoutes, modelLeasedRefusal, unknownLeaseRefusal,
  settingsRoutes, LLM_CLASSES, UPSTREAM_NAMES, WSL_ONLY_CLASSES, WSL_ONLY_REASON,
  faultyJobRoutes, cancelRefusedFault, armReset, takeFault,
};
