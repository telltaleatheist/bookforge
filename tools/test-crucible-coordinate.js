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
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
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
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

const MODULE = JSON.parse(fs.readFileSync(
  path.join(REPO, 'shared', 'crucible', 'bookforge.module.json'), 'utf-8'));

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
 */
function startFake(options) {
  const opts = Object.assign({
    missing: [], jobTypes: MODULE.job_types.map((j) => j.type), refuse: null, acceptsWorkAfter: 0,
  }, options);
  const seen = {
    info: 0, catalog: 0, posts: [], taskLists: 0, eventStreams: [], activity: 0, cancelled: [],
  };
  let posted = 0;

  return startFakeCrucible(async (req, res, ctx) => {
    const { send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/info' && req.method === 'GET') {
      seen.info += 1;
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.6.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux',
          gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 25757220864 } },
        job_types: ['echo'],
        capabilities: opts.jobTypes.map((jobType) => ({ job_type: jobType, models: [] })),
      });
      return true;
    }

    if (route === '/v1/catalog' && req.method === 'GET') {
      seen.catalog += 1;
      send(res, 200, {
        rows: MODULE.subjects.map((subject) => ({
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
        })),
      });
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

    const cancel = /^\/v1\/tasks\/([^/]+)$/.exec(route);
    if (cancel && req.method === 'DELETE') {
      seen.cancelled.push(decodeURIComponent(cancel[1]));
      send(res, 200, { task_id: decodeURIComponent(cancel[1]), status: 'cancelling' });
      return true;
    }

    return false;
  }).then((fake) => Object.assign(fake, { seen }));
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
    } finally { await fake.close(); }
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
  await check('missingForBookForge compares job types on the TYPE, as the server does', () => {
    const catalog = MODULE.subjects.map((s) => ({
      kind: s.kind, id: s.id, name: null, jobType: 'llm', installed: true,
      installedBytes: 1, expectedBytes: null, floors: [], license: null, source: 'hf:x', resident: false,
    }));
    const all = MODULE.job_types.map((j) => j.type);
    assert.deepStrictEqual(coordinate.missingForBookForge(all, catalog), [],
      'everything installed is nothing missing');
    const without = coordinate.missingForBookForge(all.filter((t) => t !== 'align'), catalog);
    assert.strictEqual(without.length, 1);
    assert.strictEqual(without[0].jobType, 'align');
  });

  await check('a subject this backend has no block for is carried, not dropped', () => {
    const all = MODULE.job_types.map((j) => j.type);
    const missing = coordinate.missingForBookForge(all, []);
    assert.strictEqual(missing.length, MODULE.subjects.length);
    assert.ok(missing.every((m) => m.inCatalog === false && m.expectedBytes === null),
      'uncatalogued subjects say so rather than inventing a size');
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

  summary('crucible coordination');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
