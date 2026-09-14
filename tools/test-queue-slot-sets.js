#!/usr/bin/env node
/**
 * Tests for ONE SLOT SET PER MACHINE — `shared/queue/slot-sets.ts` and the
 * scheduler that allocates from it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-slot-sets.js
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * crucible `docs/PHASE7-LANES.md` §2.4, and the one sentence the whole design
 * turns on:
 *
 * > A server's slots count what BOOKFORGE has in flight there. They are not a
 * > model of the server's capacity, and they are never read to decide whether
 * > the server is free.
 *
 * So what is defended here:
 *
 *  - TWO BOOKS RENDER ON TWO MACHINES AT ONCE. That is the entire reason a
 *    second server is registered, and one global `gpu: 1` made it impossible.
 *  - TWO BOOKS BOUND FOR ONE MACHINE DO NOT BOTH GET SUBMITTED. The second
 *    waits on the slot HERE rather than being sent and refused `409` there —
 *    a free slot licenses an attempt, an occupied one does not.
 *  - A DISABLED SERVER FINISHES WHAT IT HAS AND TAKES NOTHING NEW. §4.3: a job
 *    that started on a machine finishes on that machine, so its set survives
 *    marked `retiring` and disappears when the occupant lands.
 *  - THE LEGACY SPAWN KEEPS ITS OLD BEHAVIOUR — one GPU slot, always present
 *    while the layer exists, whatever the render switch says. A step whose
 *    module has not been taught to travel spawns here regardless.
 *  - THIS MACHINE HAS ONE CARD BEHIND TWO VENUES. The legacy spawn and the
 *    local Crucible are two sets over one 3090 Ti, and the single global slot
 *    used to stop them running together by accident.
 *  - THE BENCH STAYS TRUTHFUL. A lane belongs to a machine, and a row waiting
 *    for a card is told WHICH card.
 *
 * ── Why this is testable with no network and no userData ────────────────────
 *
 * The pure half is a function of facts. The scheduler half takes its routing
 * record and its prober as an injected host (`setCrucibleRoutingHost`), so
 * every branch is reachable with a scripted record at the speed of a unit
 * test. Nothing here opens a socket or spawns anything.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-engine.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const engine = require(path.join(DIST, 'queue-engine.js'));
const slots = require(path.join(REPO, 'dist', 'shared', 'queue', 'slot-sets.js'));
const bench = require(path.join(REPO, 'dist', 'shared', 'queue', 'bench.js'));
const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));

const LEGACY = waitFor.LEGACY_LOCAL_NARRATOR;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-slotsets-'));

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await wait(0); };

// ── The pure half ───────────────────────────────────────────────────────────

const stepOf = (over = {}) => ({
  id: 'sX', type: 'tts-conversion', label: 'Narrate', config: {},
  parentStepId: 'source', resource: 'gpu', status: 'running',
  progress: {}, metrics: {}, addedAt: '2026-09-14T00:00:00.000Z', ...over,
});
const jobOfSteps = (steps, over = {}) => ({
  id: 'jX', title: 'Mistborn', steps, createdAt: '2026-09-14T00:00:00.000Z', ...over,
});

test('a CPU step is work BookForge does itself, whatever its run says', () => {
  const step = stepOf({ resource: 'cpu' });
  const job = jobOfSteps([step], { waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, step), slots.LOCAL_WORK_SET);
});

test('a WAIT step belongs to no machine at all', () => {
  const step = stepOf({ resource: 'wait' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([step]), step), null);
});

test('an admitted step counts against the venue it was ADMITTED to, not the run\'s', () => {
  // The migration case: the render went to the Mac, and an RVC pass whose
  // module has not been taught to travel spawned here. Two venues, one run.
  const step = stepOf({ venue: LEGACY, travels: false });
  const job = jobOfSteps([step], { waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, step), LEGACY);
});

test('a GPU step that cannot travel is the legacy set even when its run went to a server', () => {
  const step = stepOf({ travels: false });
  const job = jobOfSteps([step], { waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, step), LEGACY,
    'it spawns on this machine, so it charges this machine');
});

test('a travelling GPU step follows its run once the run is assigned', () => {
  const step = stepOf({ travels: true, status: 'queued' });
  const job = jobOfSteps([step], { waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, step), 'mac');
});

test('a travelling GPU step with no assignment yet answers NULL, not a guess', () => {
  const step = stepOf({ travels: true, status: 'queued' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([step]), step), null,
    'nothing can say which card it wants, and admission says so in its own words');
});

test('every enabled server brings [gpu] AND its cloud lane; the legacy spawn [gpu]; local-work [cpu][cpu]', () => {
  const sets = slots.slotSets({ enabledServers: ['local', 'mac'], occupied: [] });
  assert.deepStrictEqual(sets.map((s) => s.id),
    ['local', 'local:cloud', 'mac', 'mac:cloud', LEGACY, slots.LOCAL_WORK_SET]);
  assert.strictEqual(sets[0].gpu, 1);
  assert.strictEqual(sets[0].cpu, slots.SERVER_CPU_SLOTS,
    '§2.4: the design is two, the realised number is nought until a server takes CPU work');
  assert.strictEqual(sets[4].gpu, 1, 'the legacy stopgap keeps exactly one card');
  assert.strictEqual(sets[5].cpu, 2);
  assert.strictEqual(sets[5].gpu, 0, 'there is no local GPU row — a GPU step goes to a server');
});

test('a cloud lane hangs off its engine, holds no card, and is two wide', () => {
  // crucible PHASE15 §5.3. A class the engine ROUTES upstream runs on
  // somebody's API: the engine forwards it and settles nothing, so the lane
  // has gpu 0 literally and not as an omission.
  const sets = slots.slotSets({ enabledServers: ['mac'], occupied: [] });
  const lane = sets.find((x) => x.id === slots.cloudLaneOf('mac'));
  assert.ok(lane !== undefined, 'every engine gets one');
  assert.strictEqual(lane.gpu, 0);
  assert.strictEqual(lane.cpu, slots.CLOUD_LANE_SLOTS);
  assert.strictEqual(lane.cpu, 2);
  assert.strictEqual(slots.slotsOf(sets, 'mac:cloud', 'cpu'), 2);
  assert.strictEqual(slots.slotsOf(sets, 'mac:cloud', 'gpu'), 0);
  assert.strictEqual(lane.label, 'mac — routed elsewhere');
});

test('cloudLaneOf and serverOfCloudLane are exact inverses, and nothing else is a lane', () => {
  for (const name of ['local', 'mac', 'droplet-1', 'a.b_c-d']) {
    assert.strictEqual(slots.serverOfCloudLane(slots.cloudLaneOf(name)), name);
    assert.strictEqual(slots.isCloudLane(slots.cloudLaneOf(name)), true);
  }
  for (const id of ['local', 'mac', LEGACY, slots.LOCAL_WORK_SET]) {
    assert.strictEqual(slots.isCloudLane(id), false, id);
    assert.strictEqual(slots.serverOfCloudLane(id), null, id);
  }
});

test('a step placed on a cloud lane charges THAT lane, not local-work', () => {
  // The whole reason `slotSetForStep` reads the venue before the resource: a
  // cloud-routed step is written `resource: 'cpu'` at admission because it
  // occupies no card, and the old order would have sent it to `local-work`,
  // which is this machine, which is not where it ran.
  const step = stepOf({ venue: 'mac:cloud', resource: 'cpu', travels: true });
  const job = jobOfSteps([step], { waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, step), 'mac:cloud');
  const occupancy = slots.slotSetOccupancy({ jobs: [job] });
  assert.strictEqual(occupancy.get('mac:cloud').cpu, 1);
  assert.strictEqual(occupancy.get('mac:cloud').gpu, 0);
  assert.strictEqual(occupancy.get(slots.LOCAL_WORK_SET), undefined,
    "this machine did nothing; charging it would be the bench blaming the wrong lane");
});

test('a plain CPU step still goes to local-work — it carries no venue', () => {
  const step = stepOf({ resource: 'cpu' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([step]), step), slots.LOCAL_WORK_SET);
});

test("a cloud lane is never THIS machine's card, even local's", () => {
  // `local:cloud` is the local engine FORWARDING work. Nothing is on the 3090.
  const occupancy = new Map([[LEGACY, { gpu: 1, cpu: 0 }]]);
  assert.strictEqual(slots.thisMachinesCardHeldBy({
    venue: slots.cloudLaneOf('local'), localServerName: 'local', occupancy,
  }), null);
  // …and the GPU venue beside it still is.
  assert.strictEqual(slots.thisMachinesCardHeldBy({
    venue: 'local', localServerName: 'local', occupancy,
  }), LEGACY);
});

test('a DISABLED server contributes no set, so nothing new is claimed there', () => {
  const sets = slots.slotSets({ enabledServers: ['local'], occupied: [] });
  assert.ok(!sets.some((s) => s.id === 'mac'));
  assert.strictEqual(slots.slotsOf(sets, 'mac', 'gpu'), 0,
    'an unknown set has no room, so a claim against it waits rather than launching');
});

test('a disabled server still HOLDING our work keeps its set, marked retiring', () => {
  const sets = slots.slotSets({ enabledServers: ['local'], occupied: ['mac'] });
  const mac = sets.find((s) => s.id === 'mac');
  assert.ok(mac, '§4.3: a job that started on a machine finishes on that machine');
  assert.strictEqual(mac.retiring, true);
  assert.strictEqual(sets.find((s) => s.id === 'local').retiring, false);
});

test('local-work is always there and is never retiring', () => {
  const sets = slots.slotSets({ enabledServers: [], occupied: [] });
  const own = sets.find((s) => s.id === slots.LOCAL_WORK_SET);
  assert.strictEqual(own.retiring, false);
  assert.strictEqual(own.cpu, 2, 'a machine with no server still assembles and muxes');
});

test('occupancy counts only what is RUNNING, per set', () => {
  const a = stepOf({ id: 'a', venue: 'mac', travels: true });
  const b = stepOf({ id: 'b', venue: 'mac', travels: true, status: 'queued' });
  const c = stepOf({ id: 'c', resource: 'cpu' });
  const counts = slots.slotSetOccupancy({ jobs: [jobOfSteps([a, b, c])] });
  assert.strictEqual(counts.get('mac').gpu, 1, 'a queued row occupies nothing');
  assert.strictEqual(counts.get(slots.LOCAL_WORK_SET).cpu, 1);
});

test('this machine has ONE card behind two venues', () => {
  const occupancy = new Map([[LEGACY, { gpu: 1, cpu: 0 }]]);
  assert.strictEqual(
    slots.thisMachinesCardHeldBy({ venue: 'local', localServerName: 'local', occupancy }),
    LEGACY,
    'a local-Crucible render must not start on a card the legacy spawn is using');
  assert.strictEqual(
    slots.thisMachinesCardHeldBy({ venue: 'mac', localServerName: 'local', occupancy }),
    null,
    'a REMOTE venue is a different card, which is the whole point of the sets');
});

test('with no local Crucible, only the legacy venue is this machine', () => {
  const occupancy = new Map([[LEGACY, { gpu: 1, cpu: 0 }]]);
  assert.strictEqual(
    slots.thisMachinesCardHeldBy({ venue: 'mac', localServerName: null, occupancy }),
    null);
});

// ── The bench draws a machine per lane ──────────────────────────────────────

function snapOf(jobs, servers) {
  const occupied = [];
  for (const j of jobs) {
    for (const s of j.steps) {
      if (s.status !== 'running') continue;
      const id = slots.slotSetForStep(j, s);
      if (id !== null && !occupied.includes(id)) occupied.push(id);
    }
  }
  return {
    jobs, running: true,
    slotSets: slots.slotSets({ enabledServers: servers, occupied }),
  };
}

test('every machine gets its own lanes, and a lane says which machine it is', () => {
  const snap = snapOf([], ['local', 'mac']);
  const lanes = bench.benchLanes(snap);
  const gpus = lanes.filter((l) => l.resource === 'gpu');
  assert.deepStrictEqual(gpus.map((l) => l.setId), ['local', 'mac', LEGACY]);
  assert.strictEqual(gpus[1].setLabel, 'mac');
  /*
   * SIX CPU LANES NOW, AND EVERY ONE OF THEM IS REAL WORK SOMEWHERE.
   *
   * Two are BookForge's own (`local-work`), and two per engine are its cloud
   * lane (crucible PHASE15 §5.3) — a class that engine ROUTES upstream runs on
   * somebody's API and holds no card. A server's OWN `[cpu]` lanes are still
   * nought (`SERVER_CPU_SLOTS`), which is the thing this check was written to
   * protect: no lane is drawn for work no server can take.
   */
  const cpus = lanes.filter((l) => l.resource === 'cpu');
  assert.deepStrictEqual(cpus.map((l) => l.setId).filter((id, i, a) => a.indexOf(id) === i),
    ['local:cloud', 'mac:cloud', slots.LOCAL_WORK_SET]);
  assert.strictEqual(cpus.length, 6);
  assert.strictEqual(slots.slotsOf(snap.slotSets, 'mac', 'cpu'), 0,
    "a server's own CPU lanes are still nought — nothing sends it CPU work");
});

test('a step on the Mac occupies the MAC\'s lane and leaves this machine\'s free', () => {
  const step = stepOf({ venue: 'mac', travels: true });
  const snap = snapOf([jobOfSteps([step], { waitForResolved: 'mac' })], ['local', 'mac']);
  const lanes = bench.benchLanes(snap).filter((l) => l.resource === 'gpu');
  assert.strictEqual(lanes.find((l) => l.setId === 'mac').occupant.title, 'Mistborn');
  assert.strictEqual(lanes.find((l) => l.setId === 'local').occupant, null);
  assert.strictEqual(lanes.find((l) => l.setId === LEGACY).occupant, null);
});

test('a row waiting for a card is told WHICH card', () => {
  const running = stepOf({ id: 'r', venue: 'mac', travels: true });
  const queued = stepOf({ id: 'q', venue: 'mac', travels: true, status: 'queued' });
  const job = jobOfSteps([running], { id: 'j1', waitForResolved: 'mac' });
  const other = jobOfSteps([queued], { id: 'j2', title: 'Wool', waitForResolved: 'mac' });
  const reason = bench.stillReason(snapOf([job, other], ['local', 'mac']), other, queued);
  assert.strictEqual(reason.kind, 'no-slot');
  assert.match(reason.sentence, /graphics card on mac/);
  assert.match(reason.sentence, /Narrating Mistborn/);
});

test('the thermal reading never lands on a remote machine\'s lane', () => {
  const snap = snapOf([], ['mac']);
  snap.gpuThermal = { celsius: 84, throttleActive: true };
  const lanes = bench.benchLanes(snap).filter((l) => l.resource === 'gpu');
  assert.strictEqual(lanes.find((l) => l.setId === 'mac').thermal, null,
    'nvidia-smi samples THIS card; labelling it as the Mac\'s would be a lie');
  assert.ok(lanes.find((l) => l.setId === LEGACY).thermal);
});

// ── The scheduler ───────────────────────────────────────────────────────────

function fakeModule(type, opts = {}) {
  const runs = [];
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
    runs,
    run(ctx) {
      const record = { ctx, job: ctx.job, settled: false };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => {
          record.settled = true;
          resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
        };
        record.reject = (err) => { record.settled = true; reject(err); };
      });
      runs.push(record);
      return record.promise;
    },
    cancel() {},
  };
  if (opts.travels === true) mod.machines = () => 'any';
  return mod;
}

function fakeHost(initial) {
  const state = {
    ranked: initial.ranked ?? [],
    legacyLocalRender: initial.legacyLocalRender === true,
    localName: initial.localName === undefined ? 'local' : initial.localName,
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    reach: initial.reach ?? {},
  };
  state.host = {
    routing: () => ({
      ranked: state.ranked.map((row) => ({ ...row })),
      legacyLocalRender: state.legacyLocalRender,
      localName: state.localName,
    }),
    defaultWaitFor: () => state.defaultWaitFor,
    async reach(name) {
      const answer = state.reach[name];
      if (answer === undefined) return { reachable: false, detail: `Nothing answered at ${name}.` };
      return answer;
    },
  };
  return state;
}

async function fresh(name, mods, host) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(host === null ? null : host.host);
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });
  return dir;
}

const REACHABLE = { local: { reachable: true }, mac: { reachable: true } };
const TWO = [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }];

function narrate(title, waitFor) {
  return {
    title,
    ...(waitFor === undefined ? {} : { waitFor }),
    steps: [{
      type: 'tts-conversion', label: 'Narrate', config: {},
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  };
}
const jobById = (id) => engine.snapshot().jobs.find((j) => j.id === id);

test('TWO BOOKS RENDER ON TWO MACHINES AT ONCE — the whole reason for a second server', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('two-machines', [gpu], host);

  const a = engine.enqueue(narrate('Mistborn', 'local'));
  const b = engine.enqueue(narrate('Wool', 'mac'));
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length, 2, 'one global GPU slot allowed only one of these');
  assert.strictEqual(jobById(a.id).waitForResolved, 'local');
  assert.strictEqual(jobById(b.id).waitForResolved, 'mac');
});

test('TWO BOOKS FOR ONE MACHINE TAKE TURNS — the second waits on the slot, not on a 409', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('one-machine', [gpu], host);

  const a = engine.enqueue(narrate('Mistborn', 'mac'));
  const b = engine.enqueue(narrate('Wool', 'mac'));
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length, 1, 'nothing was submitted to be refused');
  const snap = engine.snapshot();
  const second = snap.jobs.find((j) => j.id === b.id);
  const reason = bench.stillReason(snap, second, second.steps[0]);
  assert.strictEqual(reason.kind, 'no-slot');
  assert.match(reason.sentence, /graphics card on mac/);

  gpu.runs[0].resolve({ kind: 'epub', path: '/out/a' });
  await settle(40);
  assert.strictEqual(gpu.runs.length, 2, 'the slot freed and the queue took it');
});

test('`any` skips a machine we are already using and takes the next in rank order', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('any-skips', [gpu], host);

  engine.enqueue(narrate('Mistborn', 'any'));
  const b = engine.enqueue(narrate('Wool', 'any'));
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length, 2);
  assert.strictEqual(jobById(b.id).waitForResolved, 'mac',
    '§2.4: `any` takes the first server whose GPU slot is FREE, in rank order');
});

test('`any` with every slot of ours full holds, and names what is on each', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('any-full', [gpu], host);

  engine.enqueue(narrate('Mistborn', 'any'));
  engine.enqueue(narrate('Wool', 'any'));
  const c = engine.enqueue(narrate('Elantris', 'any'));
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length, 2);
  const hold = jobById(c.id).steps[0].progress.admissionHold;
  assert.match(hold, /BookForge is already narrating/);
  assert.match(hold, /local/);
  assert.match(hold, /mac/);
});

test('a DISABLED server finishes what it has and takes nothing new', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('disable-midrun', [gpu], host);

  const a = engine.enqueue(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1);

  host.ranked = [{ name: 'local', enabled: true }, { name: 'mac', enabled: false }];
  const b = engine.enqueue(narrate('Wool', 'mac'));
  await settle(40);

  assert.strictEqual(gpu.runs.length, 1, 'no new claim goes to a disabled server');
  assert.match(jobById(b.id).steps[0].progress.admissionHold, /disabled/);

  const snap = engine.snapshot();
  const mac = snap.slotSets.find((s) => s.id === 'mac');
  assert.ok(mac, 'the running step keeps its set on the bench');
  assert.strictEqual(mac.retiring, true);
  assert.strictEqual(jobById(a.id).steps[0].status, 'running', 'it is not stopped');

  gpu.runs[0].resolve({ kind: 'epub', path: '/out/a' });
  await settle(40);
  assert.ok(!engine.snapshot().slotSets.some((s) => s.id === 'mac'),
    'and the set is gone once its occupant lands');
});

test('the legacy spawn keeps ONE card, and a step that cannot travel waits for it', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'local', legacyLocalRender: true,
    reach: REACHABLE });
  await fresh('legacy-one-card', [gpu, local], host);

  engine.enqueue(narrate('Mistborn'));
  engine.enqueue({
    title: 'Enhance',
    steps: [{
      type: 'rvc-enhancement', label: 'Enhance', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length + local.runs.length, 1,
    'the legacy set has one GPU slot, exactly as the old global number did');
});

test('the local Crucible and the legacy spawn never run on the card together', async () => {
  // The switch is OFF, so the render goes to `local`; the enhance step has not
  // been taught to travel, so it spawns here. Two sets, one 3090 Ti.
  const gpu = fakeModule('tts-conversion', { travels: true });
  const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'local', reach: REACHABLE });
  await fresh('one-card-two-venues', [gpu, local], host);

  engine.enqueue({
    title: 'Enhance',
    steps: [{
      type: 'rvc-enhancement', label: 'Enhance', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  const b = engine.enqueue(narrate('Mistborn', 'local'));
  engine.start();
  await settle(40);

  assert.strictEqual(local.runs.length, 1);
  assert.strictEqual(gpu.runs.length, 0, 'the card is taken, by the other venue over it');
  assert.match(jobById(b.id).steps[0].progress.admissionHold,
    /this machine's graphics card/);

  local.runs[0].resolve({ kind: 'sentences', path: '/out/s' });
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1);
});

test('a CPU step never waits for a card, however busy every machine is', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const cpu = fakeModule('reassembly', { resource: () => 'cpu', consumes: 'audio-session',
    produces: 'm4b' });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('cpu-unblocked', [gpu, cpu], host);

  engine.enqueue(narrate('Mistborn', 'any'));
  engine.enqueue(narrate('Wool', 'any'));
  engine.enqueue({
    title: 'Assemble',
    steps: [{
      type: 'reassembly', label: 'Assemble', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length, 2);
  assert.strictEqual(cpu.runs.length, 1, 'assembly is BookForge\'s own work and has its own slots');
});

test('a step records the venue it was admitted to, and the bench reads it', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('step-venue', [gpu], host);

  const a = engine.enqueue(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(jobById(a.id).steps[0].venue, 'mac');

  const lanes = bench.benchLanes(engine.snapshot()).filter((l) => l.resource === 'gpu');
  assert.strictEqual(lanes.find((l) => l.setId === 'mac').occupant.title, 'Mistborn');
});

// ── The route decides the lane (crucible PHASE15 5.3) ──────────────────────

const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));

function translatePass(title, waitFor) {
  return {
    title,
    ...(waitFor === undefined ? {} : { waitFor }),
    steps: [{
      type: 'translation', label: 'Translate', config: {},
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  };
}

test('a class the engine ROUTES UPSTREAM takes its cloud lane, not its card', async () => {
  /*
   * The end of the story that starts in `electron/crucible/routes.ts`: the
   * engine says `translate` goes to Anthropic, so the run holds no card. It
   * must not sit behind a narration waiting for one, and it must not occupy
   * the Mac's GPU slot while it does not use it.
   */
  const ai = fakeModule('translation', { travels: true });
  ai.crucibleClass = () => 'translate';
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('cloud-lane', [ai, gpu], host);
  routes.forgetCrucibleRoutes();
  routes.noteCrucibleRoutes('mac', { translate: 'upstream', clean: 'local' });

  const a = engine.enqueue(translatePass('Mistborn', 'mac'));
  engine.start();
  await settle(40);

  const step = jobById(a.id).steps[0];
  assert.strictEqual(step.venue, 'mac:cloud', 'it was placed on the engine\'s cloud lane');
  assert.strictEqual(step.resource, 'cpu', 'it occupies no card, so it is not charged for one');
  assert.strictEqual(ai.runs.length, 1);

  // …and the Mac's GPU slot is untouched, so a render admits beside it.
  const b = engine.enqueue(narrate('Wool', 'mac'));
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1,
    'a routed-upstream translation must not block a render on the same engine');
  assert.strictEqual(jobById(b.id).steps[0].venue, 'mac');
});

test("a render HOLDING the engine's card does not block a routed translation", async () => {
  /*
   * The direction that actually matters, and the one a naive implementation
   * gets wrong: every gate after placement is about a CARD — the engine's GPU
   * slot, this machine's single card held by two venues, the training lock —
   * and an upstream-routed act touches none of them. Asking would make a
   * translation on somebody's API wait for a nine-hour narration, which is
   * exactly what the lane exists to stop.
   */
  const gpu = fakeModule('tts-conversion', { travels: true });
  const ai = fakeModule('translation', { travels: true });
  ai.crucibleClass = () => 'translate';
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('cloud-beside-render', [gpu, ai], host);
  routes.forgetCrucibleRoutes();
  routes.noteCrucibleRoutes('mac', { translate: 'upstream' });

  engine.enqueue(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1, "the render took the Mac's card");

  const b = engine.enqueue(translatePass('Wool', 'mac'));
  await settle(40);
  assert.strictEqual(ai.runs.length, 1,
    'the routed translation waited for a card it was never going to touch');
  assert.strictEqual(jobById(b.id).steps[0].venue, 'mac:cloud');
});

test('the cloud lane is TWO wide, and a third routed row waits for it', async () => {
  const ai = fakeModule('translation', { travels: true });
  ai.crucibleClass = () => 'translate';
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('cloud-width', [ai], host);
  routes.forgetCrucibleRoutes();
  routes.noteCrucibleRoutes('mac', { translate: 'upstream' });

  engine.enqueue(translatePass('One', 'mac'));
  engine.enqueue(translatePass('Two', 'mac'));
  const third = engine.enqueue(translatePass('Three', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(ai.runs.length, 2, "CLOUD_LANE_SLOTS is the queue's own appetite, and it is 2");

  ai.runs[0].resolve({ kind: 'epub', path: '/out/one' });
  await settle(40);
  assert.strictEqual(ai.runs.length, 3);
  assert.strictEqual(jobById(third.id).steps[0].venue, 'mac:cloud');
});

test('a class the engine runs LOCALLY still takes its GPU slot', async () => {
  const ai = fakeModule('translation', { travels: true });
  ai.crucibleClass = () => 'translate';
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('local-route', [ai], host);
  routes.forgetCrucibleRoutes();
  routes.noteCrucibleRoutes('mac', { translate: 'local' });

  const a = engine.enqueue(translatePass('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  const step = jobById(a.id).steps[0];
  assert.strictEqual(step.venue, 'mac');
  assert.strictEqual(step.resource, 'gpu');
});

test('an engine whose routes nobody has read yet is a WAIT, never a guess', async () => {
  /*
   * Assuming `local` would park an upstream-routed class on a card nothing
   * runs on, with a render waiting behind it and nothing saying why;
   * assuming `upstream` would do the mirror. So the row waits with a sentence
   * until coordination has read that engine — which is one connect away and
   * never a poll.
   */
  const ai = fakeModule('translation', { travels: true });
  ai.crucibleClass = () => 'translate';
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('unknown-route', [ai], host);
  routes.forgetCrucibleRoutes();

  const a = engine.enqueue(translatePass('Mistborn', 'mac'));
  engine.start();
  await settle(40);

  assert.strictEqual(ai.runs.length, 0, 'nothing ran on a lane nobody has chosen');
  const step = jobById(a.id).steps[0];
  assert.match(step.progress.admissionHold, /has not yet read where "mac" runs translate work/);

  // The read lands, and the next pass places it — no restart, no poll.
  routes.noteCrucibleRoutes('mac', { translate: 'upstream' });
  engine.pump();
  await settle(40);
  assert.strictEqual(ai.runs.length, 1);
  assert.strictEqual(jobById(a.id).steps[0].venue, 'mac:cloud');
});

test('a RESTART does not split the venue from the resource it was placed with', async () => {
  /*
   * The pair is written together at admission and the VENUE persists (§4.3, a
   * job that started on a machine finishes on that machine). Re-deriving only
   * the resource on load would leave a `gpu` step sitting on a lane whose gpu
   * count is 0: never admitted again, and nothing saying why.
   */
  const ai = fakeModule('translation', { travels: true });
  ai.crucibleClass = () => 'translate';
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  const dir = await fresh('cloud-restart', [ai], host);
  routes.forgetCrucibleRoutes();
  routes.noteCrucibleRoutes('mac', { translate: 'upstream' });

  const a = engine.enqueue(translatePass('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(jobById(a.id).steps[0].venue, 'mac:cloud');

  // Same state directory, a fresh engine: exactly what a restart is.
  const ai2 = fakeModule('translation', { travels: true });
  ai2.crucibleClass = () => 'translate';
  engine.clearStepModules();
  engine.registerStepModule(ai2);
  engine.setCrucibleRoutingHost(host.host);
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });
  const reloaded = engine.snapshot().jobs.find((j) => j.id === a.id);
  assert.ok(reloaded !== undefined, 'the row survived the restart');
  const step = reloaded.steps[0];
  assert.strictEqual(step.venue, 'mac:cloud', 'the venue persists — it is where the work went');
  assert.strictEqual(step.resource, 'cpu',
    'and the resource stays with it; re-deriving `gpu` here is a deadlock on a lane with none');
  assert.strictEqual(slots.slotsOf(engine.snapshot().slotSets, step.venue, step.resource), 2);
});

test('a step with no capability class is untouched by any of this', async () => {
  // A render is not a routable class, so it never asks and never waits: the
  // record can be completely empty and it still takes the card.
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'mac', reach: REACHABLE });
  await fresh('no-class', [gpu], host);
  routes.forgetCrucibleRoutes();

  const a = engine.enqueue(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1);
  assert.strictEqual(jobById(a.id).steps[0].venue, 'mac');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    }
  }
  engine.clearStepModules();
  engine.setCrucibleRoutingHost(null);
  routes.forgetCrucibleRoutes();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  console.log(`\nqueue slot-sets: ${passed} test(s) passed, ${failures.length} failed`);
  process.exitCode = failures.length === 0 ? 0 : 1;
})();
