#!/usr/bin/env node
/**
 * COORDINATION: THE BUTTON THAT IS NOT THERE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-coordinate.js
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a, Owen 2026-09-14: *"if its present,
 * bookforge should coordinate with the installed crucible to make sure it has
 * what it needs to run all of its features"*, and *"lets make it as simple as
 * possible"* — no consent step, nothing to press, on any server.
 *
 * `electron/crucible/coordinate.ts` is the one owner of that. Against a FAKE
 * Crucible, this pins the five things the design turns on, each of which is a
 * defect if it goes the other way:
 *
 *  1. **ASK, THEN ACT.** A fully stocked engine gets a READ and ZERO posts to
 *     `/v1/tasks`. This is the amendment Foundry's review produced: a module
 *     whose every entry would come back `skipped` must not be posted on a
 *     server that runs ONE task at a time, or two apps starting together
 *     collide on `task_busy` and a running book refuses its own app with
 *     `server_busy`.
 *  2. **One missing subject → exactly one POST**, and the task's frames reach
 *     the state.
 *  3. **`task_busy` is FOLLOWED, not re-posted.** Tasks have no queue, so a
 *     second post is refused again; the running one's events are joined.
 *  4. **`server_busy` is a WAIT with the holder named**, retried when
 *     `/v1/activity` says the card is free — never a tight poll, never a
 *     generic failure (§5.4: a lease means another app is mid-run).
 *  5. **A refusal about the REQUEST fails ONCE by name.** `invalid_module` is
 *     remembered for the session and not re-posted on the next connect.
 *  6. **THE CONNECT IS THREE READS, AND THE THIRD IS THE SCHEDULER'S**
 *     (2026-09-14). `GET /v1/capability` joined `/v1/info` and `/v1/catalog`
 *     so the route record (`electron/crucible/routes.ts`) is filled at the one
 *     moment BookForge already has the server on the line — nothing polls for
 *     which class an engine routes upstream. It does not change the verdict
 *     about what is missing, and a capability read that FAILS is the same
 *     `unreachable` as the other two: a server that cannot answer one of the
 *     three is not answering.
 *
 * Plus the two surface checks the brief asks for: the "Set up for BookForge"
 * button is GONE from every renderer source, the wizard's connected face
 * offers no button at all, and every job type the vendored module asks for has
 * words a person can read.
 *
 * No GPU, no Crucible, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, settingsRoutes,
} = require('./fake-crucible');

const COORDINATE = path.join(REPO, 'dist', 'electron', 'crucible', 'coordinate.js');
if (!fs.existsSync(COORDINATE)) {
  console.log('SKIP: dist/electron/crucible/coordinate.js is not built — run npx tsc -p tsconfig.electron.json');
  process.exit(0);
}
installElectronStub('bf-crucible-coordinate-');
const coordinate = require(COORDINATE);
const moduleSetup = require(path.join(REPO, 'dist', 'electron', 'crucible', 'module-setup.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));

/*
 * ONE DOOR AGAIN: `fakeNamer` swaps `crucibleClientFor`, and all three of
 * coordination's reads go through it.
 *
 * For a while the third did not. `GET /v1/capability` was read by BookForge's
 * own `fetch` off `getServer(name).url`, because the vendored SDK's parser
 * DROPPED `route` and the queue's cloud lane is decided on that field — so
 * this file had to enter the same fake in the registry as well, or the third
 * read was a registry miss and the whole connect came back `unreachable`. The
 * phase-15 SDK keeps `route`, `engine-settings.ts` reads capability through
 * `client.capability()` like everything else, and the second stub is gone
 * with it.
 */
const registerFake = fakeNamer(servers);

const { check, summary } = makeChecker();

const MODULE = JSON.parse(fs.readFileSync(
  path.join(REPO, 'shared', 'crucible', 'bookforge.module.json'), 'utf-8'));

/**
 * WHAT THE FAKE'S CAPABILITY RESOLVES THE MODULE'S CLASSES TO.
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a: the module carries `needs` as CLASSES
 * and the SERVER resolves each one through its own capability record, so the
 * subject a class becomes is the FAKE's answer and not the module's. This is
 * the fake's `localModelFor` default (`fake-crucible.js`: `clean` →
 * `qwen3.5-9b`), written out here so the catalog can carry a row for it — the
 * catalog is the second half of the question and without the row every connect
 * would report the cleanup model missing.
 */
const CLASS_MODELS = { clean: 'qwen3.5-9b' };

/** A capability record as the shared wire shapes it, for the pure comparison. */
function capabilityView(classes) {
  return {
    backendKind: 'cuda-linux',
    totalBytes: 25769803776,
    desktopAllowanceBytes: 3221225472,
    classes,
  };
}

/** One row of it. `route` defaults to `local`, which is what most rows are. */
function capabilityRow(capability, overrides) {
  return Object.assign({
    capability,
    enabled: true,
    selected: CLASS_MODELS[capability] === undefined ? '' : CLASS_MODELS[capability],
    reason: 'it fits',
    shortfallBytes: 0,
    route: 'local',
  }, overrides || {});
}

/** Deps with no real clock: a keeper must not wait twenty seconds for a settle. */
function deps(overrides) {
  return Object.assign({
    isEnabled: () => true,
    sleep: async () => {},
    now: () => '2026-09-14T12:00:00Z',
  }, overrides || {});
}

/**
 * A fake whose CATALOG is the knob.
 *
 * `missing` names the subject ids this engine has NOT pulled; `jobTypes` is
 * what `/v1/info` reports as installed. `refuse` makes the POST say one of the
 * awkward things. Everything it answers is the real wire shape — snake_case,
 * `{rows: …}` / `{tasks: …}` envelopes — because a fake that answered a looser
 * shape would pass this suite and fail against a server.
 *
 * ── IT SERVES CAPABILITY TOO, BY DELEGATION (2026-09-14) ──────────────────
 *
 * Coordination stopped being two reads. `coordinate.ts` now also asks
 * `GET /v1/capability` on every connect, so the scheduler's route record is
 * filled by the one moment BookForge already talks to a server and nothing
 * has to poll for it. A fake with no capability door therefore makes EVERY
 * connect `unreachable` — which is coordination telling the truth, and which
 * silently turned twelve of these checks into assertions about a server that
 * was not answering.
 *
 * The door is not re-typed here: `settingsRoutes` in `fake-crucible.js` owns
 * `/v1/settings*` and `/v1/capability` in the server's own spelling, and this
 * suite DELEGATES to it exactly as the lease suites delegate to
 * `leaseRoutes` — a second capability body written out over here would be the
 * duplicated fact the whole file exists to avoid. `settings` passes that
 * handler's behaviour through, which is how `noCapabilityDoor` reaches it.
 */
function startFake(options) {
  const opts = Object.assign({
    missing: [], uncatalogued: [], jobTypes: MODULE.job_types.map((j) => j.type), refuse: null,
    acceptsWorkAfter: 0, settings: {}, taskUnmet: undefined,
    /*
     * EXTRA KEYS ON `/v1/info`, in the server's own spelling — PHASE17's `role`,
     * `managed_by` and `engine`. Absent by default, which is exactly what a
     * pre-Phase-17 Crucible answers and what the SDK reads as a plain `engine`.
     */
    info: {},
  }, options);
  const seen = {
    info: 0, catalog: 0, posts: [], taskLists: 0, eventStreams: [], activity: 0, cancelled: [],
    taskReads: [],
  };
  const settings = settingsRoutes(opts.settings);
  let posted = 0;

  return startFakeCrucible(async (req, res, ctx) => {
    const { send, sseWriter, url } = ctx;
    const route = url.pathname;

    // The delegated door first, and its answer is final when it took the
    // request — the same idiom `test-crucible-lease.js` uses, so a route this
    // suite never knew about cannot be shadowed by one of the handlers below.
    if (await settings.handle(req, res, ctx)) return true;

    if (route === '/v1/info' && req.method === 'GET') {
      seen.info += 1;
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.6.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux',
          gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 25757220864 } },
        job_types: ['echo'],
        capabilities: opts.jobTypes.map((jobType) => ({ job_type: jobType, models: [] })),
        ...opts.info,
      });
      return true;
    }

    if (route === '/v1/catalog' && req.method === 'GET') {
      seen.catalog += 1;
      /*
       * THE MODULE'S EXPLICIT SUBJECTS **AND** WHAT ITS CLASSES RESOLVE TO.
       *
       * §5.3a splits the module in two: `subjects` are ids BookForge chose (a
       * voice, the whisper size, the rvc base) and `needs` are CLASSES the
       * server resolves. Both halves end up as catalog lookups, so a fake
       * whose catalog listed only the first half would report the cleanup
       * model missing on every connect — which is a true statement about that
       * fake and a useless one about this app.
       */
      const rows = MODULE.subjects.map((subject) => ({
        kind: subject.kind,
        id: subject.id,
        name: subject.id === 'higgs-default' ? 'Higgs default' : null,
        job_type: subject.kind === 'voice' ? 'tts' : 'llm',
        installed: !opts.missing.includes(subject.id),
        installed_bytes: opts.missing.includes(subject.id) ? null : 1024,
        expected_bytes: subject.kind === 'denoise' ? 9126805504 : null,
        floors: [],
        license: null,
        source: `hf:fake/${subject.id}`,
        resident: false,
      }));
      for (const id of Object.values(CLASS_MODELS)) {
        if (opts.uncatalogued.includes(id)) continue;
        rows.push({
          kind: 'model',
          id,
          name: 'Qwen3.5 9B',
          job_type: 'llm',
          installed: !opts.missing.includes(id),
          installed_bytes: opts.missing.includes(id) ? null : 1024,
          expected_bytes: 9663676416,
          floors: [],
          license: null,
          source: `hf:fake/${id}`,
          resident: false,
        });
      }
      send(res, 200, { rows });
      return true;
    }

    if (route === '/v1/activity' && req.method === 'GET') {
      seen.activity += 1;
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.6.0', api_version: 1, backend: 'cuda-linux', uptime_s: 10 },
        resident: null, warming: null, claim: null, streaming: null,
        chat: { in_flight: 0, rows: [] }, lease: null,
        slots: { accelerated: { busy: 0, of: 1, queue_depth: 0, accepts_work: seen.activity >= opts.acceptsWorkAfter } },
        running: [], queued: [],
      });
      return true;
    }

    if (route === '/v1/tasks' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      seen.posts.push(body);
      posted += 1;
      const refusal = typeof opts.refuse === 'function' ? opts.refuse(posted) : opts.refuse;
      if (refusal !== null && refusal !== undefined) {
        send(res, refusal.status, { error: {
          code: refusal.code, message: refusal.message, details: refusal.details || null } });
        return true;
      }
      send(res, 202, { task_id: `task-${posted}` });
      return true;
    }

    if (route === '/v1/tasks' && req.method === 'GET') {
      seen.taskLists += 1;
      send(res, 200, { tasks: [{
        task_id: 'task-already-running', type: 'module', request: { type: 'module' },
        state: 'running', error: null,
        created: '2026-09-14T11:59:00Z', started: '2026-09-14T11:59:00Z', finished: null,
      }] });
      return true;
    }

    const events = /^\/v1\/tasks\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const taskId = decodeURIComponent(events[1]);
      seen.eventStreams.push(taskId);
      const sse = sseWriter(req, res);
      sse.frame('started', { type: 'module' });
      sse.frame('step', { name: 'pull denoise-roformer', index: 1, total: 2 });
      sse.frame('progress', { bytes_done: 3435973836, bytes_total: 9126805504, file: 'denoise-roformer' });
      sse.frame('skipped', { reason: 'llm is installed' });
      sse.frame('step', { name: 'reload', index: 2, total: 2, job_types: ['llm', 'tts'] });
      sse.frame('done', {});
      sse.end();
      return true;
    }

    /*
     * THE TASK DOCUMENT, WHICH IS THE ONLY PLACE `unmet` LIVES.
     *
     * §5.3a puts the classes an engine does not serve on `TaskStatus.unmet`
     * and on NO frame of the stream, so `module-setup.ts` reads the document
     * once when the stream ends. `taskUnmet: undefined` leaves the field off
     * the body entirely — a server that predates the field — which the SDK
     * reads as `[]`; a list puts it there.
     */
    const document = /^\/v1\/tasks\/([^/]+)$/.exec(route);
    if (document && req.method === 'GET') {
      const taskId = decodeURIComponent(document[1]);
      seen.taskReads.push(taskId);
      if (opts.taskUnmet === 'unreadable') {
        send(res, 500, { error: { code: 'internal', message: 'the lid closed', details: null } });
        return true;
      }
      const body = {
        task_id: taskId, type: 'module', request: { type: 'module' }, state: 'done', error: null,
        created: '2026-09-14T11:59:00Z', started: '2026-09-14T11:59:00Z',
        finished: '2026-09-14T12:00:00Z',
      };
      if (opts.taskUnmet !== undefined) body.unmet = opts.taskUnmet;
      send(res, 200, body);
      return true;
    }

    const cancel = /^\/v1\/tasks\/([^/]+)$/.exec(route);
    if (cancel && req.method === 'DELETE') {
      seen.cancelled.push(decodeURIComponent(cancel[1]));
      send(res, 200, { task_id: decodeURIComponent(cancel[1]), status: 'cancelling' });
      return true;
    }

    return false;
  }).then((fake) => Object.assign(fake, { seen, settings: settings.settings }));
}

const BUSY = {
  status: 409,
  code: 'server_busy',
  message: 'a lease holds the card',
  details: {
    fact: 'a lease',
    who: "foundry/owens-pc for 'translate' on qwen3.8-27b-4bit until 03:12",
    lease_id: 'lease-1', kind: 'llm', client: 'foundry/owens-pc', act: 'translate',
    subject: 'qwen3.8-27b-4bit', since: '2026-09-14T03:00:00Z', expires_at: '2026-09-14T03:12:00Z',
  },
};

async function main() {
  // ── 1. A stocked engine: a READ and nothing else ─────────────────────────
  await check('a fully stocked engine is READ and nothing is posted', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({});
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.strictEqual(fake.seen.info, 1, 'info should be read once');
      assert.strictEqual(fake.seen.catalog, 1, 'the catalog should be read once');
      assert.strictEqual(fake.seen.posts.length, 0,
        `a stocked engine must get ZERO task posts, got ${fake.seen.posts.length}`);
      assert.deepStrictEqual(state.unmet, [],
        'an engine that serves every class BookForge names has nothing unmet');
    } finally { await fake.close(); }
  });

  await check('the connect is THREE reads, and a capability that 404s is unreachable', async () => {
    /*
     * THE THIRD READ IS PINNED HERE BECAUSE IT IS INVISIBLE EVERYWHERE ELSE.
     *
     * `crucibleCapabilityWithRoutes` fills the scheduler's route record, and
     * a route record is read inside a synchronous pump — so if this read were
     * quietly dropped, coordination would go on reporting `stocked` and the
     * only symptom would be a queue placing an upstream-routed class on a GPU
     * slot. So: it happens, exactly once, on the same connect as the other
     * two.
     *
     * And it is load-bearing in the same way they are. A server whose
     * capability door 404s is not a server with one feature missing; it is a
     * server this build cannot schedule against, and saying `stocked` about
     * it would be a "maybe" (crucible `docs/ARCHITECTURE.md` R3). The fake's
     * `noCapabilityDoor` breaks that ONE door — info and catalog still answer
     * perfectly — which is what makes the verdict attributable to it.
     */
    coordinate.resetCoordinationForTests();
    const stocked = await startFake({});
    try {
      const name = registerFake(stocked.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.strictEqual(stocked.seen.info, 1, 'info is read once');
      assert.strictEqual(stocked.seen.catalog, 1, 'the catalog is read once');
      assert.strictEqual(stocked.settings.capabilityReads, 1,
        'capability is read once, on the same connect — not on a timer of its own');
    } finally { await stocked.close(); }

    coordinate.resetCoordinationForTests();
    const noDoor = await startFake({ settings: { noCapabilityDoor: true } });
    try {
      const name = registerFake(noDoor.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'unreachable',
        'a server that cannot answer one of the three reads is not answering');
      assert.ok(state.message.includes(name), `the engine is named: ${state.message}`);
      assert.strictEqual(noDoor.seen.posts.length, 0,
        'and nothing is posted to a server whose answers could not all be read');
      assert.strictEqual(noDoor.settings.capabilityReads, 1,
        'the read was MADE and refused — the verdict is the door\'s, not a skipped call\'s');
    } finally { await noDoor.close(); }
  });

  await check('the connect also reads WHETHER THAT ENGINE HAS AN UPSTREAM — the bench\'s cloud lane', async () => {
    /*
     * A FOURTH READ, AND IT IS INVISIBLE EVERYWHERE ELSE TOO.
     *
     * The queue draws an engine's `[cloud]` lane only when that engine has an
     * upstream configured (`shared/queue/slot-sets.ts`, `SlotSetFacts.upstreams`),
     * and the scheduler answers that inside a synchronous pump — so the fact is
     * read at the moments it can change and held in `crucible/routes.ts`. This
     * is one of the two moments (the other being a settings write's own answer).
     * Dropped, the only symptom would be four CPU rows on the bench for lanes
     * that can never fill, which is exactly the defect this pins.
     *
     * The three arms are the three answers, and the third is the one that is
     * not an omission: a server with no settings door at all is UNKNOWN and
     * keeps its lane, because absence of knowledge is not absence of an
     * upstream — and it is still `stocked`, because a bench row is not a
     * reason to call a working Crucible unreachable.
     */
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));

    coordinate.resetCoordinationForTests();
    routes.forgetCrucibleRoutes();
    const withKey = await startFake({ settings: { upstreams: { anthropic: { key: 'sk-ant-1234' } } } });
    try {
      const name = registerFake(withKey.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.strictEqual(withKey.settings.reads, 1,
        'the document is read once, on the same connect — not on a timer of its own');
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'configured',
        'a key on any of the three means the engine CAN forward work, so the lane is drawn');
    } finally { await withKey.close(); }

    coordinate.resetCoordinationForTests();
    routes.forgetCrucibleRoutes();
    const bare = await startFake({});
    try {
      const name = registerFake(bare.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'none',
        'nowhere to forward anything: a lane here would be a row nothing can fill');
    } finally { await bare.close(); }

    coordinate.resetCoordinationForTests();
    routes.forgetCrucibleRoutes();
    const noDoor = await startFake({ settings: { noSettingsDoor: true } });
    try {
      const name = registerFake(noDoor.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked',
        'a pre-phase-15 Crucible is perfectly usable; a bench row is not a reason to refuse it');
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'unknown',
        "it could not say, so today's behaviour is kept and the lane stays");
    } finally { await noDoor.close(); }

    // …and a server that is FORGOTTEN is forgotten in both halves of the
    // record at once: a name pruned from one and answered from the other is
    // the two-owners defect the record exists as one module to avoid.
    routes.forgetCrucibleRoutes();
    assert.strictEqual(routes.crucibleUpstreamsOf('anything'), 'unknown');
  });

  await check('…and it is REMEMBERED across restarts, or `unknown` is every launch', async () => {
    /*
     * THE DEFECT, MEASURED 2026-09-15. Owen's bench drew
     * `mac — routed elsewhere · CPU ×2` for a Mac whose `GET /v1/settings` says
     * every upstream is unconfigured and whose four routes are `local`. The
     * rule was right; the record was EMPTY. It lived in memory only, so after
     * every app start every server was `unknown` until something happened to
     * connect to it — `local` had been coordinated that session and the Mac had
     * not — and `unknown` draws the lane. Phantom lanes were the steady state of
     * a fresh launch, not a rare one.
     *
     * So the fact is written beside the routing record and read back at start.
     * A restart is simulated the way a restart actually works: the module's
     * memory is empty, and then the file is read.
     */
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-upstreams-'));
    const file = path.join(dir, 'crucible-upstreams.json');
    const restart = () => {
      // Unbind FIRST: a `forget` with the file bound would rewrite it, and what
      // a restart does is lose the memory, not erase the record.
      routes.unbindCrucibleUpstreamsFile();
      routes.forgetCrucibleRoutes();
      routes.loadCrucibleUpstreams(file);
    };

    try {
      routes.unbindCrucibleUpstreamsFile();
      routes.forgetCrucibleRoutes();
      routes.loadCrucibleUpstreams(file);
      assert.strictEqual(routes.crucibleUpstreamsOf('nobody'), 'unknown',
        'a file that is not there is an app that has never asked anyone — not an empty answer');

      coordinate.resetCoordinationForTests();
      const bare = await startFake({});
      let name;
      try {
        name = registerFake(bare.url);
        await coordinate.coordinateServer(name, deps());
        assert.strictEqual(routes.crucibleUpstreamsOf(name), 'none');
      } finally { await bare.close(); }

      assert.ok(fs.existsSync(file), 'the answer was written the moment it was learned');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).upstreams, { [name]: false });

      restart();
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'none',
        'the next launch draws no lane for it WITHOUT asking — the engine is not even running '
        + 'in this check any more, which is the whole point');

      // A server that is forgotten is forgotten in the remembered half too: a
      // name pruned from memory and answered from disk at the next launch is
      // the two-owners defect this record exists as one module to avoid.
      routes.forgetCrucibleRoutes(name);
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'unknown');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).upstreams, {});
      restart();
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'unknown',
        'and it stays forgotten across the restart');

      // A corrupt record is refused BY NAME and not repaired — and the cost is
      // one launch of `unknown`, which is the behaviour before the file existed.
      fs.writeFileSync(file, '{ not json', 'utf-8');
      routes.unbindCrucibleUpstreamsFile();
      assert.throws(() => routes.loadCrucibleUpstreams(file),
        /^Error: crucible_upstreams_record_corrupt: /);
      assert.strictEqual(routes.crucibleUpstreamsOf(name), 'unknown',
        'every engine keeps its lane, which is what this app did before the file existed');
      fs.writeFileSync(file, JSON.stringify({ upstreams: { mac: 'yes' } }), 'utf-8');
      routes.unbindCrucibleUpstreamsFile();
      assert.throws(() => routes.loadCrucibleUpstreams(file),
        /crucible_upstreams_record_corrupt: .*"mac" is "yes"/s,
        'an engine either has an upstream configured or it does not');
    } finally {
      routes.unbindCrucibleUpstreamsFile();
      routes.forgetCrucibleRoutes();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }
  });

  await check('EVERY ENABLED ENGINE IS ASKED AT START, THE SAME WAY', async () => {
    /*
     * The other half of the same defect, and what Owen's ruling of 2026-09-15
     * did to it. Coordination is what reads this fact, and coordination at
     * start USED TO BE the reserved `local` row's alone (PHASE14 §4a:
     * coordinating is what this app does when it CONNECTS to a machine) — so
     * nothing ever asked a REMOTE until something happened to connect to it,
     * and the record above had nothing to remember on the first launch after a
     * server was added. The fix at the time was a second, smaller pass that
     * skipped `local`.
     *
     * With the reserved name gone there is ONE pass and every enabled server
     * goes through it, coordination and all. It stays cheap because coordination
     * is cheap when nothing is missing: three reads, a comparison, and NOTHING
     * POSTED — which is what the last assertion here is about.
     */
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    routes.unbindCrucibleUpstreamsFile();
    routes.forgetCrucibleRoutes();
    coordinate.resetCoordinationForTests();

    const withKey = await startFake({ settings: { upstreams: { openai: { key: 'sk-oai-9' } } } });
    const bare = await startFake({});
    try {
      const a = registerFake(withKey.url);
      const b = registerFake(bare.url);
      const asked = await coordinate.coordinateServersOnStart(deps(), () => [a, b]);

      assert.deepStrictEqual(asked, [a, b],
        'every enabled server is asked, and there is no row that is asked differently');
      assert.strictEqual(routes.crucibleUpstreamsOf(a), 'configured');
      assert.strictEqual(routes.crucibleUpstreamsOf(b), 'none',
        'and this is the row that used to be drawn as a phantom cloud lane');
      /*
       * THE SECOND BENCH FACT, read in the same pass. A server that predates
       * PHASE17 says no `role` at all and reads as an ENGINE — which is what
       * these fakes are — so it keeps the GPU row it has always had.
       */
      assert.strictEqual(routes.crucibleRoleOf(a), 'engine',
        'no `role` on the wire is an engine, not an unknown (PHASE17: additive)');
      assert.strictEqual(routes.crucibleRoleOf(b), 'engine');
      assert.strictEqual(routes.crucibleEngineBehind(a), null,
        'an engine fronts nothing — the ref belongs to an orchestrator');
      assert.strictEqual(withKey.settings.reads, 1, 'once each, and nothing polls');
      assert.strictEqual(bare.settings.reads, 1);
      assert.strictEqual(withKey.seen.posts.length + bare.seen.posts.length, 0,
        'ASK, THEN ACT: both engines are stocked, so the comparison stops and no module task is '
        + 'posted to anybody at startup');
    } finally {
      await withKey.close();
      await bare.close();
      routes.forgetCrucibleRoutes();
    }
  });

  await check('a server that does not answer stays UNKNOWN and keeps its lane', async () => {
    // Absence of knowledge is not absence of an upstream. A `catch` that wrote
    // `false` here would hide a lane an operator had just configured.
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    routes.unbindCrucibleUpstreamsFile();
    routes.forgetCrucibleRoutes();
    const dead = await startFake({});
    const name = registerFake(dead.url);
    await dead.close();
    const asked = await coordinate.coordinateServersOnStart(deps(), () => [name]);
    assert.deepStrictEqual(asked, [name], 'it was asked, and the failure did not stop the sweep');
    assert.strictEqual(routes.crucibleUpstreamsOf(name), 'unknown');
    assert.strictEqual(routes.crucibleRoleOf(name), 'unknown',
      'and it keeps its GPU row too: recording `engine` on a timeout would be the fallback');
    routes.forgetCrucibleRoutes();
  });

  await check('AN ORCHESTRATOR IS RECORDED AS ONE, and the engine it fronts is remembered', async () => {
    /*
     * crucible `docs/PHASE17-ORCHESTRATOR.md` §1. Owen, 2026-09-15: *"crucible
     * on windows is a passthrough orchestrator so it shouldnt show up."* The
     * bench draws no row for a process that serves no job types
     * (`shared/queue/slot-sets.ts`'s `EngineRole`), and this is the read that
     * tells it so — the SDK's `engineOf` is the whole of the rule, used once.
     */
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    routes.unbindCrucibleUpstreamsFile();
    routes.forgetCrucibleRoutes();
    const resolve = require(path.join(REPO, 'dist', 'electron', 'crucible', 'engine-resolve.js'));
    resolve.forgetResolvedEngine();
    /*
     * The live shape, measured on Owen's machine the same day: `:7101` answers
     * `role: orchestrator` with zero job types, naming `crucible@owens-pc-wsl`
     * at `:7100`, `backend: cuda-linux`, `owner: wsl-unit`; `:7100` answers
     * `role: engine`, `managed_by` the first. Two fakes, the same relation.
     */
    const wsl = await startFake({ info: { role: 'engine', managed_by: null } });
    const tray = await startFake({
      jobTypes: [],
      info: {
        role: 'orchestrator',
        engine: {
          name: 'crucible@owens-pc-wsl', url: wsl.url,
          backend: 'cuda-linux', owner: 'wsl-unit',
        },
      },
    });
    try {
      const name = registerFake(tray.url);
      await coordinate.coordinateServersOnStart(deps(), () => [name]);
      assert.strictEqual(routes.crucibleRoleOf(name), 'orchestrator');
      assert.strictEqual(routes.crucibleEngineBehind(name).url, wsl.url,
        'so an operator can be told which address to register instead of this one');

      const resolved = await resolve.resolveEngine(servers.getServer(name), 'keeper');
      assert.strictEqual(resolved.url, wsl.url, 'work goes to the engine, never to the front');
      assert.strictEqual(resolved.through.owner, 'wsl-unit');
      assert.strictEqual(resolved.info.role, 'engine',
        'the SECOND document is read, which is what makes "one hop" enforced and not assumed');
    } finally {
      await tray.close();
      await wsl.close();
      resolve.forgetResolvedEngine();
      routes.forgetCrucibleRoutes();
    }
  });

  await check('A CHAIN IS REFUSED BY NAME — an app follows one hop and no more', async () => {
    // An orchestrator whose `engine.url` names another orchestrator is a
    // misconfiguration on those machines. A client that followed it would loop.
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    const resolve = require(path.join(REPO, 'dist', 'electron', 'crucible', 'engine-resolve.js'));
    routes.unbindCrucibleUpstreamsFile();
    resolve.forgetResolvedEngine();
    const second = await startFake({
      jobTypes: [],
      info: {
        role: 'orchestrator',
        engine: { name: 'deeper', url: 'http://127.0.0.1:1', backend: null, owner: 'child' },
      },
    });
    const first = await startFake({
      jobTypes: [],
      info: {
        role: 'orchestrator',
        engine: { name: 'second', url: second.url, backend: null, owner: 'child' },
      },
    });
    try {
      const name = registerFake(first.url);
      await assert.rejects(
        () => resolve.resolveEngine(servers.getServer(name), 'keeper'),
        /crucible_orchestrator_chain/,
      );
    } finally {
      await first.close();
      await second.close();
      resolve.forgetResolvedEngine();
      routes.forgetCrucibleRoutes();
    }
  });

  await check('AN ORCHESTRATOR THAT MANAGES NOTHING is a fact, refused by its own name', async () => {
    // `orchestrator_has_no_engine` — a Windows machine whose WSL engine is not
    // installed yet. Something to show a person next to the install button.
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    const resolve = require(path.join(REPO, 'dist', 'electron', 'crucible', 'engine-resolve.js'));
    routes.unbindCrucibleUpstreamsFile();
    resolve.forgetResolvedEngine();
    const bare = await startFake({ jobTypes: [], info: { role: 'orchestrator', engine: null } });
    try {
      const name = registerFake(bare.url);
      await assert.rejects(
        () => resolve.resolveEngine(servers.getServer(name), 'keeper'),
        /crucible_orchestrator_has_no_engine/,
      );
      assert.strictEqual(routes.crucibleRoleOf(name), 'orchestrator',
        'the record still learns what that address IS — the refusal is about where work goes');
    } finally {
      await bare.close();
      resolve.forgetResolvedEngine();
      routes.forgetCrucibleRoutes();
    }
  });

  await check('THE CACHE HOLDS NO TOKEN: a rotated one is used, never the one it resolved with', async () => {
    /*
     * The resolution is keyed on NAME + URL and never on the token — a rotated
     * token cannot change which process answers an address — so the token has to
     * come from the entry in hand on EVERY call. BookForge owns the registry
     * these entries come from, so a rotation here is the case that would be ours
     * to cause, and a cached secret would be ours to send.
     */
    const resolve = require(path.join(REPO, 'dist', 'electron', 'crucible', 'engine-resolve.js'));
    resolve.forgetResolvedEngine();
    const bearers = [];
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/info') return false;
      bearers.push(req.headers.authorization);
      ctx.send(res, 200, {
        server: { name: 'fake-engine', version: '0.6.0', api_version: 1 },
        host: {
          platform: 'linux', arch: 'x86_64', backend: 'cuda-linux',
          gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 25757220864 },
        },
        job_types: ['echo'], capabilities: [], role: 'engine', managed_by: null,
      });
      return true;
    });
    try {
      const before = { name: 'rotator', url: fake.url, token: 'token-the-first' };
      await resolve.resolveEngine(before, 'keeper');
      const after = { name: 'rotator', url: fake.url, token: 'token-the-second' };
      const client = await resolve.engineClientFor(after, 'keeper');
      await client.info();
      assert.deepStrictEqual(bearers, ['Bearer token-the-first', 'Bearer token-the-second'],
        'the second call was served out of the cache and STILL carried the new token');
    } finally {
      await fake.close();
      resolve.forgetResolvedEngine();
    }
  });

  await check('NO REFUSAL CARRIES THE BEARER — these sentences land in queue rows', async () => {
    // A refusal from this door is read by a person, in a row, in a log. The
    // token must not be in it, and neither must the word.
    const resolve = require(path.join(REPO, 'dist', 'electron', 'crucible', 'engine-resolve.js'));
    resolve.forgetResolvedEngine();
    const secret = 'sk-do-not-print-me-0123456789';
    const bare = await startFake({ jobTypes: [], info: { role: 'orchestrator', engine: null } });
    const chained = await startFake({
      jobTypes: [],
      info: {
        role: 'orchestrator',
        engine: { name: 'deeper', url: bare.url, backend: null, owner: 'child' },
      },
    });
    try {
      for (const url of [bare.url, chained.url]) {
        let message = null;
        try {
          await resolve.resolveEngine({ name: 'secretive', url, token: secret }, 'keeper');
        } catch (err) {
          message = err.message;
        }
        assert.ok(message !== null, 'both of these refuse');
        assert.ok(!message.includes(secret), `the refusal quoted the token: ${message}`);
        assert.ok(!/bearer|authorization/i.test(message),
          'nor does it name the header, which is how a token ends up quoted next');
        assert.ok(message.includes(url), 'it names the ADDRESS, which is what a person can act on');
      }
    } finally {
      await bare.close();
      await chained.close();
      resolve.forgetResolvedEngine();
    }
  });

  await check('the state it published is the state a screen would read', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({});
    try {
      const name = registerFake(fake.url);
      const heard = [];
      const stop = coordinate.onCoordination((state) => heard.push(state.phase));
      await coordinate.coordinateServer(name, deps());
      stop();
      assert.deepStrictEqual(heard, ['checking', 'stocked'], `heard ${heard.join(', ')}`);
      assert.strictEqual(coordinate.coordinationStates()[name].phase, 'stocked');
    } finally { await fake.close(); }
  });

  // ── 2. One missing subject: exactly one POST ─────────────────────────────
  await check('one missing subject posts the module exactly once', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'] });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(fake.seen.posts.length, 1,
        `exactly one post, got ${fake.seen.posts.length}`);
      assert.strictEqual(fake.seen.posts[0].type, 'module');
      assert.deepStrictEqual(fake.seen.posts[0].module, MODULE,
        'the vendored file is posted byte for byte');
      assert.strictEqual(state.phase, 'preparing');
      assert.strictEqual(state.progress.state, 'done');
      assert.strictEqual(state.followed, false);
    } finally { await fake.close(); }
  });

  await check('the missing subject carries its name and its declared size', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer', 'higgs-default'] });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      const denoise = state.missing.find((m) => m.id === 'denoise-roformer');
      const voice = state.missing.find((m) => m.id === 'higgs-default');
      assert.strictEqual(denoise.expectedBytes, 9126805504, 'the declared size travels');
      assert.strictEqual(denoise.name, null, 'no manifest name is null, never the id guessed here');
      assert.strictEqual(voice.name, 'Higgs default', "the manifest's display name travels");
      assert.strictEqual(voice.expectedBytes, null,
        'a voice declares no size, and null is not 0');
      assert.ok(denoise.inCatalog && voice.inCatalog);
    } finally { await fake.close(); }
  });

  await check('a job type this engine has not installed is missing too', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ jobTypes: ['llm', 'asr', 'align', 'rvc'] });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'preparing');
      const tts = state.missing.find((m) => m.what === 'job-type' && m.jobType === 'tts');
      assert.ok(tts, 'the tts job type should be reported missing');
      assert.strictEqual(tts.narratorEngine, 'higgs-v3');
      assert.strictEqual(fake.seen.posts.length, 1);
    } finally { await fake.close(); }
  });

  await check("the task's frames reach the state — bytes, skips and what it now serves", async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'] });
    try {
      const name = registerFake(fake.url);
      const frames = [];
      const stop = coordinate.onCoordination((state) => {
        if (state.phase === 'preparing') frames.push(state.progress);
      });
      const state = await coordinate.coordinateServer(name, deps());
      stop();
      assert.ok(frames.some((f) => f.bytes !== null && f.bytes.done === 3435973836
        && f.bytes.total === 9126805504 && f.bytes.file === 'denoise-roformer'),
      'a pull\'s byte counts should reach a frame');
      assert.ok(frames.some((f) => f.skipped === 'llm is installed'),
        'a skipped entry is idempotence, reported');
      assert.deepStrictEqual(state.progress.jobTypes, ['llm', 'tts'],
        'the reload step says what became reachable');
    } finally { await fake.close(); }
  });

  // ── 3. task_busy is FOLLOWED ─────────────────────────────────────────────
  await check('a task already running is FOLLOWED, never re-posted', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({
      missing: ['denoise-roformer'],
      refuse: (n) => (n === 1
        ? { status: 409, code: 'task_busy', message: 'a module task is already running' }
        : null),
    });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(fake.seen.posts.length, 1,
        `the refused post is not retried, got ${fake.seen.posts.length} posts`);
      assert.strictEqual(fake.seen.taskLists, 1, 'the running task is looked up');
      assert.deepStrictEqual(fake.seen.eventStreams, ['task-already-running'],
        'its own stream is the one joined');
      assert.strictEqual(state.phase, 'preparing');
      assert.strictEqual(state.followed, true, 'the state says it joined somebody else\'s task');
    } finally { await fake.close(); }
  });

  // ── 4. server_busy is a WAIT with the holder named ───────────────────────
  await check('server_busy waits with the holder verbatim and retries on settle', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({
      missing: ['denoise-roformer'],
      refuse: (n) => (n === 1 ? BUSY : null),
      acceptsWorkAfter: 2,
    });
    try {
      const name = registerFake(fake.url);
      const waits = [];
      const stop = coordinate.onCoordination((state) => {
        if (state.phase === 'waiting') waits.push(state);
      });
      let slept = 0;
      const state = await coordinate.coordinateServer(name, deps({
        sleep: async () => { slept += 1; },
      }));
      stop();
      assert.strictEqual(waits.length, 1, `one wait was drawn, got ${waits.length}`);
      assert.strictEqual(waits[0].holder.fact, 'a lease');
      assert.strictEqual(waits[0].holder.who, BUSY.details.who,
        'the holder is the server\'s own sentence, verbatim');
      assert.strictEqual(waits[0].stopped, false);
      assert.strictEqual(waits[0].attempts, 1);
      assert.ok(slept >= 2, `the wait slept rather than spinning (slept ${slept})`);
      assert.ok(fake.seen.activity >= 2, 'the card was asked about, not guessed at');
      assert.strictEqual(fake.seen.posts.length, 2, 'one refused post, one accepted');
      assert.strictEqual(state.phase, 'preparing');
      assert.strictEqual(state.progress.state, 'done');
    } finally { await fake.close(); }
  });

  await check('a card held for ever STOPS being asked about, with the holder still named', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'], refuse: BUSY, acceptsWorkAfter: 0 });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps({ sleep: async () => {} }));
      assert.strictEqual(state.phase, 'waiting');
      assert.strictEqual(state.stopped, true);
      assert.strictEqual(state.attempts, coordinate.SETTLE_POLL_ATTEMPTS);
      assert.strictEqual(state.holder.who, BUSY.details.who);
      assert.strictEqual(fake.seen.posts.length, coordinate.SETTLE_POLL_ATTEMPTS);
    } finally { await fake.close(); }
  });

  // ── 5. A refusal about the REQUEST fails ONCE, by name ───────────────────
  await check('invalid_module fails once by name and is not posted again', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({
      missing: ['denoise-roformer'],
      refuse: { status: 400, code: 'invalid_module', message: 'subject qwen3-aligner is not a voice' },
    });
    try {
      const name = registerFake(fake.url);
      const first = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(first.phase, 'refused');
      assert.strictEqual(first.code, 'invalid_module');
      assert.ok(first.message.includes('subject qwen3-aligner is not a voice'),
        `the server's own sentence travels: ${first.message}`);

      const second = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(second.phase, 'refused', 'the refusal stands on the next connect');
      assert.strictEqual(fake.seen.posts.length, 1,
        `the same wrong answer is not posted on a timer, got ${fake.seen.posts.length} posts`);
      assert.strictEqual(fake.seen.catalog, 2, 'but the READ still happens');
    } finally { await fake.close(); }
  });

  await check('unknown_subject is a request refusal too, and named', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({
      missing: ['qwen3-aligner'],
      refuse: { status: 400, code: 'unknown_subject', message: 'this backend has no qwen3-aligner' },
    });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'refused');
      assert.strictEqual(state.code, 'unknown_subject');
    } finally { await fake.close(); }
  });

  // ── §5.3a against a live fake: unmet rides on the state ─────────────────
  await check('a class this engine does not mention is STOCKED with the class named', async () => {
    /*
     * NOTHING IS MISSING AND NOTHING IS POSTED, and both halves are the
     * ruling. No task could make this engine serve `clean`, so asking it to
     * download its way out of being a different machine would be a task whose
     * every entry is a skip — the exact post §4a's amendment deleted.
     */
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ settings: { dropClasses: ['clean'] } });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.strictEqual(state.unmet.length, 1, 'the class travels on the state');
      assert.strictEqual(state.unmet[0].class, 'clean');
      assert.strictEqual(fake.seen.posts.length, 0,
        'an unmet class is not a download, so there is nothing to post');
    } finally { await fake.close(); }
  });

  await check("a disabled class is stocked too, with the ENGINE's sentence", async () => {
    coordinate.resetCoordinationForTests();
    const reason = 'no mlx-darwin block for qwen3.5-9b';
    const fake = await startFake({ settings: { disableClasses: { clean: reason } } });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked');
      assert.deepStrictEqual(state.unmet, [{ class: 'clean', reason }],
        'the reason is the row\'s, verbatim — a word of ours makes a fixable thing a mystery');
      assert.strictEqual(fake.seen.posts.length, 0);
    } finally { await fake.close(); }
  });

  await check('a PRE-PHASE-15 document is all local and nothing is unmet', async () => {
    /*
     * §3.3's last bullet, as the SDK now reads it: a document in which NO row
     * carries `route` comes from a server that predates the phase, and every
     * class on such a server IS local — a fact the document states, not a
     * default a client fills. Every Crucible on this network today sends one.
     * So the class resolves, the catalog answers, and the connect is an
     * ordinary `stocked` with no `unmet` and no post.
     */
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ settings: { omitRoute: true } });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.deepStrictEqual(state.unmet, [],
        'a routeless document is not an undecided one');
      assert.strictEqual(fake.seen.posts.length, 0);
    } finally { await fake.close(); }
  });

  await check('a class ROUTED UPSTREAM is neither missing nor unmet', async () => {
    /*
     * The work runs on the operator's account (§3.3), so there are no weights
     * on that machine to be short of — and the engine has nothing to
     * download, which is why this is `stocked` and not `preparing`. The
     * catalog is emptied of the local model on purpose: if the route were
     * ignored, this would report the cleanup model missing and post a module.
     */
    coordinate.resetCoordinationForTests();
    const fake = await startFake({
      uncatalogued: [CLASS_MODELS.clean],
      settings: {
        routes: { clean: 'anthropic/claude-sonnet-5' },
        upstreams: { anthropic: { key: 'sk-ant-1234' } },
      },
    });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'stocked', `phase was ${state.phase}`);
      assert.deepStrictEqual(state.unmet, []);
      assert.strictEqual(fake.seen.posts.length, 0,
        'nothing is pulled for a class whose work leaves the card');
    } finally { await fake.close(); }
  });

  await check("the SERVER's unmet is read off the task document and WINS", async () => {
    /*
     * §5.3a puts `unmet` on `TaskStatus` and on no frame of the stream, so
     * `module-setup.ts` reads `GET /v1/tasks/{id}` once when the stream ends.
     * The fake's capability serves `clean` perfectly, so BookForge's own
     * prediction is EMPTY — and the server says otherwise. The server is the
     * thing that resolved the classes, so its answer is the one that reaches
     * the progress, beside the prediction rather than instead of it.
     */
    coordinate.resetCoordinationForTests();
    const unmet = [{ class: 'clean', reason: 'nothing on this card fits' }];
    const fake = await startFake({ missing: ['denoise-roformer'], taskUnmet: unmet });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'preparing');
      assert.strictEqual(state.progress.state, 'done');
      assert.deepStrictEqual(fake.seen.taskReads, ['task-1'],
        'the document is read once, after the stream');
      assert.deepStrictEqual(state.progress.unmet, unmet,
        'the engine\'s own answer reaches the progress');
      assert.deepStrictEqual(state.unmet, [],
        'and this app\'s prediction travels beside it, not overwritten');
    } finally { await fake.close(); }
  });

  await check('`unmet` is NULL while a task runs, and null is not empty', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'], taskUnmet: [] });
    try {
      const name = registerFake(fake.url);
      const frames = [];
      const stop = coordinate.onCoordination((state) => {
        if (state.phase === 'preparing') frames.push(state.progress);
      });
      const state = await coordinate.coordinateServer(name, deps());
      stop();
      assert.ok(frames.length > 1, 'there were frames to check');
      assert.ok(frames.filter((f) => f.state === 'running').every((f) => f.unmet === null),
        'every frame of a task still running says nobody has been asked');
      const first = frames.findIndex((f) => f.unmet !== null);
      assert.ok(first > 0 && frames.slice(0, first).every((f) => f.unmet === null),
        `an answer appears once and never un-appears (first at ${first} of ${frames.length})`);
      assert.deepStrictEqual(state.progress.unmet, [],
        'and the terminal frame carries the engine\'s empty answer, which is a different thing');
    } finally { await fake.close(); }
  });

  await check('a task document that cannot be re-read leaves unmet null, not a failure', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'], taskUnmet: 'unreadable' });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps());
      assert.strictEqual(state.phase, 'preparing');
      assert.strictEqual(state.progress.state, 'done',
        'a task that ran to done is a task that ran to done');
      assert.strictEqual(state.progress.unmet, null, 'and nobody said what was unmet');
    } finally { await fake.close(); }
  });

  await check('a WAIT carries the unmet classes too — half an hour is when it matters', async () => {
    coordinate.resetCoordinationForTests();
    const reason = 'no mlx-darwin block for qwen3.5-9b';
    const fake = await startFake({
      missing: ['denoise-roformer'],
      refuse: BUSY,
      acceptsWorkAfter: 0,
      settings: { disableClasses: { clean: reason } },
    });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps({ sleep: async () => {} }));
      assert.strictEqual(state.phase, 'waiting');
      assert.deepStrictEqual(state.unmet, [{ class: 'clean', reason }]);
    } finally { await fake.close(); }
  });

  // ── The guards around all of it ──────────────────────────────────────────
  await check('two connects at once are ONE run, not a manufactured task_busy', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'] });
    try {
      const name = registerFake(fake.url);
      const both = await Promise.all([
        coordinate.coordinateServer(name, deps()),
        coordinate.coordinateServer(name, deps()),
      ]);
      assert.strictEqual(fake.seen.posts.length, 1, 'one post for two callers');
      assert.strictEqual(fake.seen.info, 1, 'one read for two callers');
      assert.strictEqual(both[0], both[1], 'both callers got the same run');
    } finally { await fake.close(); }
  });

  await check('a DISABLED engine is asked nothing at all', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({ missing: ['denoise-roformer'] });
    try {
      const name = registerFake(fake.url);
      const state = await coordinate.coordinateServer(name, deps({ isEnabled: () => false }));
      assert.strictEqual(state.phase, 'unreachable');
      assert.ok(/switched off/.test(state.message), state.message);
      assert.strictEqual(fake.seen.info, 0, 'nothing was read');
      assert.strictEqual(fake.seen.posts.length, 0, 'nothing was posted');
    } finally { await fake.close(); }
  });

  await check('an engine that does not answer is a state, never a throw', async () => {
    coordinate.resetCoordinationForTests();
    const fake = await startFake({});
    const name = registerFake(fake.url);
    await fake.close();
    const state = await coordinate.coordinateServer(name, deps());
    assert.strictEqual(state.phase, 'unreachable');
    assert.ok(state.message.includes(name), `the engine is named: ${state.message}`);
  });

  // ── The pure comparison, driven directly ─────────────────────────────────
  /** A catalog with everything installed: the module's subjects and the classes'. */
  function fullCatalog() {
    const rows = MODULE.subjects.map((s) => ({
      kind: s.kind, id: s.id, name: null, jobType: 'llm', installed: true,
      installedBytes: 1, expectedBytes: null, floors: [], license: null, source: 'hf:x', resident: false,
    }));
    for (const id of Object.values(CLASS_MODELS)) {
      rows.push({
        kind: 'model', id, name: 'Qwen3.5 9B', jobType: 'llm', installed: true,
        installedBytes: 1, expectedBytes: 9663676416, floors: [], license: null,
        source: 'hf:x', resident: false,
      });
    }
    return rows;
  }

  /** The record a healthy cuda-linux engine sends: every class local and enabled. */
  function fullCapability() {
    return capabilityView(
      ['clean', 'translate', 'simplify', 'analysis', 'pages', 'tts', 'asr', 'align', 'rvc', 'denoise']
        .map((c) => capabilityRow(c)));
  }

  await check('missingForBookForge compares job types on the TYPE, as the server does', () => {
    const catalog = fullCatalog();
    const all = MODULE.job_types.map((j) => j.type);
    const stocked = coordinate.missingForBookForge(all, catalog, fullCapability());
    assert.deepStrictEqual(stocked.missing, [], 'everything installed is nothing missing');
    assert.deepStrictEqual(stocked.unmet, [], 'and nothing unmet on an engine that serves it all');
    const without = coordinate.missingForBookForge(
      all.filter((t) => t !== 'align'), catalog, fullCapability());
    assert.strictEqual(without.missing.length, 1);
    assert.strictEqual(without.missing[0].jobType, 'align');
  });

  await check('a subject this backend has no block for is carried, not dropped', () => {
    const all = MODULE.job_types.map((j) => j.type);
    const { missing } = coordinate.missingForBookForge(all, [], fullCapability());
    const subjects = missing.filter((m) => m.what === 'subject');
    assert.strictEqual(subjects.length, MODULE.subjects.length);
    assert.ok(subjects.every((m) => m.inCatalog === false && m.expectedBytes === null),
      'uncatalogued subjects say so rather than inventing a size');
  });

  // ── §5.3a: the module names CLASSES and the SERVER resolves them ─────────
  await check('a class with NO ROW is unmet BY NAME — never assumed local', () => {
    /*
     * THE §4.6 FINDING, IN THE SHAPE BOOKFORGE MEETS IT.
     *
     * Foundry measured it as `pages` against the Mac: a backend with no block
     * for a class has no capability row for it either, and the generator
     * having already resolved the class to the cuda-linux id got the WHOLE
     * module refused `unknown_subject`. BookForge's module names one class,
     * `clean`, so this is that document with `clean`'s row removed.
     *
     * THE ARM THAT MATTERS IS THE ABSENCE. A class nothing has decided about
     * is not a class that works: assuming `local` here would put a book's
     * cleanup pass on an engine that cannot run it, and the failure would
     * arrive an hour later wearing somebody else's name.
     */
    const all = MODULE.job_types.map((j) => j.type);
    const noClean = capabilityView(
      ['translate', 'simplify', 'analysis', 'pages'].map((c) => capabilityRow(c)));
    const { missing, unmet } = coordinate.missingForBookForge(all, fullCatalog(), noClean);
    assert.deepStrictEqual(missing, [], 'an unmet class is not a thing to download');
    assert.strictEqual(unmet.length, 1, `one class is unmet, got ${unmet.length}`);
    assert.strictEqual(unmet[0].class, 'clean');
    assert.ok(/does not mention it/.test(unmet[0].reason),
      `the absence itself is the reason: ${unmet[0].reason}`);
  });

  await check("a DISABLED class is unmet with the ENGINE's own reason, verbatim", () => {
    const all = MODULE.job_types.map((j) => j.type);
    const reason = 'no mlx-darwin block for qwen3.5-9b';
    const off = capabilityView([
      capabilityRow('clean', { enabled: false, selected: '', reason }),
      capabilityRow('pages'),
    ]);
    const { missing, unmet } = coordinate.missingForBookForge(all, fullCatalog(), off);
    assert.deepStrictEqual(missing, [], '§5.3a: a disabled class is not a refusal and not a pull');
    assert.deepStrictEqual(unmet, [{ class: 'clean', reason }],
      'the row said why; nothing of ours goes in its place');
  });

  await check('an ENABLED class that names nothing is unmet, not a pull of the empty string', () => {
    const all = MODULE.job_types.map((j) => j.type);
    const nothingFits = capabilityView([
      capabilityRow('clean', { selected: '', reason: 'nothing on this card fits' }),
    ]);
    const { missing, unmet } = coordinate.missingForBookForge(all, fullCatalog(), nothingFits);
    assert.deepStrictEqual(missing, [], 'a catalog search for "" would name the empty string');
    assert.deepStrictEqual(unmet, [{ class: 'clean', reason: 'nothing on this card fits' }]);
  });

  await check('a class the engine has not pulled is MISSING, and carries both halves', () => {
    const all = MODULE.job_types.map((j) => j.type);
    const catalog = fullCatalog().map((row) => (row.id === CLASS_MODELS.clean
      ? Object.assign({}, row, { installed: false, installedBytes: null })
      : row));
    const { missing, unmet } = coordinate.missingForBookForge(all, catalog, fullCapability());
    assert.deepStrictEqual(unmet, [], 'a thing to download is not a thing this engine cannot do');
    assert.strictEqual(missing.length, 1);
    assert.deepStrictEqual(missing[0], {
      what: 'class',
      class: 'clean',
      id: CLASS_MODELS.clean,
      kind: 'model',
      name: 'Qwen3.5 9B',
      jobType: 'llm',
      expectedBytes: 9663676416,
      inCatalog: true,
    }, 'the class BookForge asked for AND the subject that engine picked');
  });

  await check("a class whose selected id is not in that engine's catalog says so", () => {
    const all = MODULE.job_types.map((j) => j.type);
    const catalog = fullCatalog().filter((row) => row.id !== CLASS_MODELS.clean);
    const { missing } = coordinate.missingForBookForge(all, catalog, fullCapability());
    const cls = missing.find((m) => m.what === 'class');
    assert.ok(cls, 'the class is still reported');
    assert.strictEqual(cls.inCatalog, false);
    assert.strictEqual(cls.kind, null, 'the kind is the catalog\'s to say, never guessed');
    assert.strictEqual(cls.expectedBytes, null, 'and no size is invented for it');
  });

  // ── The surface: the button is gone, and the words exist ─────────────────
  await check('"Set up for BookForge" is gone from every renderer source', () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|html)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf-8');
        // The CAPITALISED sentence in a docblock saying the button is gone is
        // not the button; the label is.
        if (text.includes('Set up for BookForge')) hits.push(path.relative(REPO, full));
      }
    };
    walk(path.join(REPO, 'src'));
    assert.deepStrictEqual(hits, [],
      `the button's label survives in: ${hits.join(', ')}`);
  });

  await check('the wizard\'s connected face offers no button when local resolves', () => {
    const text = fs.readFileSync(
      path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-doors.component.ts'),
      'utf-8');
    const start = text.indexOf("@if (face() === 'connected')");
    assert.ok(start > 0, 'the connected face should still exist');
    const end = text.indexOf("} @else if (face() === 'install')", start);
    assert.ok(end > start, 'the install face should follow it');
    const face = text.slice(start, end);
    assert.ok(!face.includes('<desktop-button'),
      'the connected face must offer nothing to press but the wizard\'s own Next');
  });

  await check('every job type the module asks for has words a person can read', () => {
    const text = fs.readFileSync(
      path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-words.ts'),
      'utf-8');
    const block = /const JOB_TYPE_WORDS[^{]*\{([^}]*)\}/.exec(text);
    assert.ok(block, 'JOB_TYPE_WORDS should be a literal this check can read');
    for (const entry of MODULE.job_types) {
      assert.ok(new RegExp(`(^|\\s)${entry.type}:`, 'm').test(block[1]),
        `the module asks for "${entry.type}" and nothing says what that is in a person's words`);
    }
  });

  await check('the vendored module is what gets posted, and nothing rewrites it', () => {
    assert.deepStrictEqual(moduleSetup.BOOKFORGE_MODULE, MODULE);
  });

  await check('every class the module NEEDS has words a person can read', () => {
    const text = fs.readFileSync(
      path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-words.ts'),
      'utf-8');
    const block = /export function capabilityClassWords[\s\S]*?\n}/.exec(text);
    assert.ok(block, 'capabilityClassWords should be a function this check can read');
    for (const need of MODULE.needs) {
      assert.ok(new RegExp(`(^|\\s)${need.class}:`, 'm').test(block[0]),
        `the module needs the "${need.class}" class and nothing says what that is for`);
    }
  });

  await check('the two `stocked` sentences are both there, verbatim', () => {
    /*
     * PINNED AS TEXT, because this file is the renderer's and a keeper cannot
     * `require` a TypeScript source that imports `@shared/*` — the same reason
     * the two checks above read it rather than calling it. What the pin is
     * FOR is that `stocked` now makes two different claims and only one of
     * them is safe beside an unmet class: an engine told "has everything
     * BookForge needs" a clause before "not on this engine: cleaning up text"
     * is a row arguing with itself (§5.3a).
     */
    const text = fs.readFileSync(
      path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-words.ts'),
      'utf-8');
    assert.ok(text.includes("'Ready — this engine has everything BookForge needs.'"),
      'the sentence for an engine with nothing unmet should still be there');
    assert.ok(text.includes("'Ready — there is nothing left to download for this engine.'"),
      'the sentence for an engine with a class it cannot serve should be there');
    assert.ok(/return `Not on this engine: \$\{joinWords\(parts\)\}`/.test(text),
      'and the unmet line names the engine\'s own reason after the class');
  });

  summary('crucible coordination');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
