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
 * Start a fake on 127.0.0.1. `route(req, res, ctx)` is the keeper's own
 * behaviour; it returns true when it handled the request. What every keeper
 * needs — uploads recorded and answered, DELETE recorded — is handled here
 * first, so a route only has to speak its job type.
 */
function startFakeCrucible(route) {
  const state = {
    uploads: [],      // {filename, bytes, blobId}
    submitted: [],    // every POST /v1/jobs body
    cancelled: [],    // every DELETE /v1/jobs/<id>
    eventsRequests: [], // {jobId, lastEventId}
    jobs: new Map(),
  };
  let nextBlob = 1;
  let nextJob = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const routePath = url.pathname;
    const ctx = {
      state, send, sseWriter, provenanceFor, readBody, url,
      newJobId: () => `job-${nextJob++}`,
    };

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
  let registered = 0;
  return function registerFake(url) {
    const name = `fake${++registered}`;
    fakesByName.set(name, { url });
    return name;
  };
}

/** A VenueHost that names one server as top-ranked with the legacy switch off. */
function crucibleHost(serverName) {
  return {
    view: () => ({ ranked: [{ name: serverName, enabled: true }], newJobsWaitFor: 'top-ranked', legacyLocalRender: false }),
    enabled: () => [{ name: serverName, enabled: true }],
    ping: async () => ({ outcome: 'ok', serverName: 'fake-crucible', apiVersion: 1 }),
  };
}

/** A VenueHost with the legacy switch ON: every door must go local and say so. */
function legacyHost() {
  return {
    view: () => ({ ranked: [{ name: 'local', enabled: true }], newJobsWaitFor: 'top-ranked', legacyLocalRender: true }),
    enabled: () => { throw new Error('the legacy branch must not ask which servers are enabled'); },
    ping: async () => { throw new Error('the legacy branch must not ping anybody'); },
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
 *   omitRoute         true -> capability rows carry NO `route` (an old server)
 *   noSettingsDoor    true -> 404 on every settings route (a pre-phase-15 one)
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
          key_hint: configured(name) ? String(u.key).slice(-4) : null,
        };
      }
    }
    return {
      routes: routeDoc,
      upstreams: upstreamDoc,
      desktop_allowance_bytes: 3221225472,
      backend_kind: backendKind,
    };
  };

  const capabilityRow = (c) => {
    const upstream = routes[c] !== undefined && routes[c] !== 'local';
    if (WSL_ONLY_CLASSES.indexOf(c) !== -1) {
      const here = backendKind === 'llama-windows';
      return {
        capability: c,
        enabled: !here,
        selected: here ? '' : 'higgs-v3',
        reason: here ? WSL_ONLY_REASON : 'installed',
        shortfallBytes: 0,
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
      shortfallBytes: 0,
    };
  };

  const capability = () => ({
    backend_kind: backendKind,
    total_bytes: 25769803776,
    desktop_allowance_bytes: 3221225472,
    classes: LLM_CLASSES.concat(['pages'], WSL_ONLY_CLASSES).map((c) => {
      const row = capabilityRow(c === 'pages' ? 'pages' : c);
      if (c === 'pages') {
        row.enabled = true;
        row.selected = 'dots-ocr';
        row.reason = 'dots-ocr fits';
      }
      if (behaviour.omitRoute !== true) {
        row.route = routes[c] !== undefined && routes[c] !== 'local' ? 'upstream' : 'local';
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
              details: { field: 'routes.' + cls },
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

module.exports = {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  crucibleHost, legacyHost, send,
  leaseRoutes, modelLeasedRefusal, unknownLeaseRefusal,
  settingsRoutes, LLM_CLASSES, UPSTREAM_NAMES, WSL_ONLY_CLASSES, WSL_ONLY_REASON,
};
