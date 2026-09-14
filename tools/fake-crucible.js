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
 *
 * `n` is 1-based: "the FIRST heartbeat fails, later ones do not" is the shape a
 * re-lease check needs and a flag could not express.
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
  };
  let nextId = 1;
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
        const leaseId = `lease-${nextId++}`;
        lease.taken.push({ ...attempt, leaseId });
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
        if (refusal) return refuse(res, refusal);
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
        if (refusal) return refuse(res, refusal);
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
};
