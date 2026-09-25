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
 *  - THE LEGACY SPAWN IS DRAWN ONLY WHEN SOMETHING CHARGES IT. Owen,
 *    2026-09-15: *"we would have as many gpu slots as we have connected crucible
 *    serves … without a crucible server, there is no gpu slot, because bookforge
 *    shouldnt know how to drive gpu work in-app."* So with nothing queued the
 *    bench is one GPU row per registered server and `local-work [cpu][cpu]`, and
 *    the legacy row appears — with its one GPU slot, and its old behaviour
 *    unchanged — exactly while the queue holds a step that can run nowhere else
 *    (`epub-align` today). The fact is computed with `slotSetForStep`, the
 *    function the scheduler allocates with, so the bench and the pump cannot
 *    disagree about whether the row is there.
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

const LEGACY = slots.LONGFORM_ALIGN_SET;
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

/**
 * Every named server as `unknown` — nobody has read its settings.
 *
 * The DEFAULT for tests that are not about the cloud lane, because `unknown` is
 * what draws the bench those tests were written against: an engine the app has
 * not asked keeps the lane it has always had (absence of knowledge is not
 * absence of an upstream). The four cases that ARE about it state their own.
 */
const unknownUpstreams = (servers) =>
  Object.fromEntries(servers.map((name) => [name, 'unknown']));

/**
 * Every named server as a plain ENGINE — the overwhelmingly common case and
 * every pre-Phase-17 Crucible.
 *
 * The default for tests that are not about the orchestrator relation, because
 * an engine is what draws the bench those tests were written against. The
 * orchestrator cases state their own.
 */
const allEngines = (servers) =>
  Object.fromEntries(servers.map((name) => [name, 'engine']));

/**
 * The step that still charges the legacy set — `generate-sentences` with
 * `method: 'epub-align'`.
 *
 * Its module declares `machines()` `local` (it reads the project's EPUB off
 * THIS disk and Crucible has no `align-longform` job), so the engine writes
 * `travels: false` and `slotSetForStep` sends it to the legacy spawn. Built as a
 * STEP rather than named as a type because that is all the scheduler sees.
 */
const epubAlignStep = (over = {}) => stepOf({
  id: 'align', type: 'generate-sentences', label: 'Generate sentences',
  config: { method: 'epub-align' }, resource: 'gpu', travels: false,
  status: 'queued', ...over,
});

/**
 * The facts, with the legacy row answered the way the engine answers it: by
 * running `slotSetForStep` over the jobs. `jobs` defaults to none, which is the
 * bench Owen asked for — one GPU slot per registered server and nothing else.
 */
const factsOf = ({ servers = [], off = [], ranked, upstreams, roles, occupied = [], jobs = [] }) => ({
  // RANK ORDER, one list. `servers` and `off` are a convenience for the many
  // tests that do not care about order; `ranked` is for the ones that do.
  rankedServers: ranked ?? [
    ...servers.map((name) => ({ name, enabled: true })),
    ...off.map((name) => ({ name, enabled: false })),
  ],
  upstreams: upstreams ?? unknownUpstreams(servers),
  roles: roles ?? allEngines(servers),
  occupied,
  alignerCharged: slots.longformAlignCharged({ jobs }),
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

// ── S12 · A NAMED row waits in the set it names ─────────────────────────────

/*
 * THE FINDING (bug hunt round 2, 2026-09-20). "Clean text — Lying About Hitler"
 * was NAMED for the PC by its own picker, had no venue and no `waitForResolved`,
 * and this function answered `null` for it. `unroutedHold` then drew its
 * admission hold — *"Waiting for crucible@<the PC>: busy … align …"* — on the
 * FIRST free GPU lane on the bench, which was the MAC's, under the heading
 * "Waiting for the card". The Mac was never waiting on the PC.
 */

test('S12: a row NAMED for a server waits in that server\'s set, venue or not', () => {
  const step = stepOf({ travels: true, status: 'queued' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([step], { waitFor: 'the-pc' }), step),
    'the-pc',
    'nothing will ever admit this row anywhere else, so that is the set it waits in');
});

test('S12: the ASSIGNMENT still outranks the ask', () => {
  const step = stepOf({ travels: true, status: 'queued' });
  const job = jobOfSteps([step], { waitFor: 'the-pc', waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, step), 'mac',
    '§4.3: the run was assigned, and what the operator asked for is history');
});

test('S12: "any" is not a machine, and neither is the retired narrator spawn', () => {
  const step = stepOf({ travels: true, status: 'queued' });
  assert.strictEqual(
    slots.slotSetForStep(jobOfSteps([step], { waitFor: waitFor.WAIT_FOR_ANY }), step), null,
    'an Any row genuinely has no machine to be drawn under — that is what unroutedHold is for');
  assert.strictEqual(
    slots.slotSetForStep(
      jobOfSteps([step], { waitFor: waitFor.RETIRED_LOCAL_NARRATOR_VENUE }), step), null,
    'a venue this app no longer has is not a set either');
});

test('S12: a QUEUED named row charges NOTHING — it has not been admitted', () => {
  /*
   * The consequence that had to be checked before the fallback could be added:
   * `slotSetForStep` is read by the occupancy count, and a row that started
   * charging the PC's one GPU slot just for NAMING it would lock every other
   * book out of that card for as long as it sat in the queue.
   *
   * It cannot. Occupancy counts `running` steps — and a running step carries a
   * venue, so it never reaches the new line — plus each job's GPU hold, which is
   * derived from `waitForResolved` alone and is null for a run that has never
   * been on a card.
   */
  const queued = stepOf({ id: 'q', travels: true, status: 'queued' });
  const job = jobOfSteps([queued], { waitFor: 'the-pc' });
  assert.strictEqual(slots.slotSetForStep(job, queued), 'the-pc', 'precondition: it is in the set');
  assert.strictEqual(slots.gpuHoldOf(job), null, 'and it holds no card: it has never been on one');

  const counts = slots.slotSetOccupancy({ jobs: [job] });
  assert.strictEqual(counts.get('the-pc'), undefined,
    'THE CONSEQUENCE: naming a machine is not taking its slot');

  // And the moment it IS admitted, it counts — through the venue, as always.
  const admitted = jobOfSteps(
    [stepOf({ id: 'q', travels: true, status: 'running', venue: 'the-pc' })],
    { waitFor: 'the-pc', waitForResolved: 'the-pc' });
  assert.strictEqual(slots.slotSetOccupancy({ jobs: [admitted] }).get('the-pc').gpu, 1);
});

test('every enabled server brings [gpu] AND its cloud lane; a charged legacy spawn [gpu]; local-work [cpu][cpu]', () => {
  const sets = slots.slotSets(factsOf({
    servers: ['local', 'mac'], jobs: [jobOfSteps([epubAlignStep()])],
  }));
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
  const sets = slots.slotSets(factsOf({ servers: ['mac'] }));
  const lane = sets.find((x) => x.id === slots.cloudLaneOf('mac'));
  assert.ok(lane !== undefined, 'every engine gets one');
  assert.strictEqual(lane.gpu, 0);
  assert.strictEqual(lane.cpu, slots.CLOUD_LANE_SLOTS);
  assert.strictEqual(lane.cpu, 2);
  assert.strictEqual(slots.slotsOf(sets, 'mac:cloud', 'cpu'), 2);
  assert.strictEqual(slots.slotsOf(sets, 'mac:cloud', 'gpu'), 0);
  assert.strictEqual(lane.label, 'mac — routed elsewhere');
});

// ── The cloud lane is drawn on ONE fact: has this engine an upstream at all ──
//
// Owen, 2026-09-15: *"i thought CPU work was done locally. so there would only
// be two cpu slots, and we would have as many gpu slots as we have connected
// crucible serves"* — four CPU rows were being drawn for lanes that can never
// fill, because the lane used to be unconditional. The four cases below are the
// whole of the new rule.

test('an engine WITH an upstream configured draws its cloud lane', () => {
  const sets = slots.slotSets(factsOf({ servers: ['mac'], upstreams: { mac: 'configured' } }));
  const lane = sets.find((s) => s.id === 'mac:cloud');
  assert.ok(lane, 'a key or a url on any of the three upstreams means it CAN forward work');
  assert.strictEqual(lane.cpu, slots.CLOUD_LANE_SLOTS);
  assert.strictEqual(lane.gpu, 0);
});

test('an engine with NO upstream configured draws no lane at all', () => {
  const sets = slots.slotSets(factsOf({
    servers: ['local', 'mac'],
    upstreams: { local: 'none', mac: 'none' },
    jobs: [jobOfSteps([epubAlignStep()])],
  }));
  assert.deepStrictEqual(sets.map((s) => s.id), ['local', 'mac', LEGACY, slots.LOCAL_WORK_SET],
    'a lane the scheduler can never fill is a row the bench must not draw (ARCHITECTURE R3)');
  assert.strictEqual(slots.slotsOf(sets, 'mac:cloud', 'cpu'), 0);
  // …and the CPU rows left are exactly BookForge's own two.
  const cpuRows = sets.filter((s) => s.cpu > 0);
  assert.deepStrictEqual(cpuRows.map((s) => s.id), [slots.LOCAL_WORK_SET]);
  assert.strictEqual(cpuRows[0].cpu, 2);
});

test('an engine nobody has ASKED keeps its lane — not knowing is not knowing there is none', () => {
  const sets = slots.slotSets(factsOf({ servers: ['mac'], upstreams: { mac: 'unknown' } }));
  assert.ok(sets.some((s) => s.id === 'mac:cloud'),
    'never read, unreachable, or older than the settings door: today\'s behaviour is kept');
});

test('a server the caller said NOTHING about is refused by name, never defaulted', () => {
  assert.throws(
    () => slots.slotSets({
      rankedServers: [{ name: 'mac', enabled: true }], upstreams: {}, roles: { mac: 'engine' },
      occupied: [], alignerCharged: false,
    }),
    /nothing was said about whether "mac" has an upstream/,
    'the two guesses are a lane that never fills and a lane that vanishes under a running row',
  );
  assert.throws(
    () => slots.slotSets({ rankedServers: [], roles: {}, occupied: [], alignerCharged: false }),
    /`upstreams` was not supplied/,
    'the type says required; this is for the callers the compiler does not see',
  );
});

test('a caller that said nothing about the LEGACY row is refused by name too', () => {
  assert.throws(
    // Every OTHER required fact is supplied, so the refusal under test is the
    // only thing missing — otherwise this asserts whichever guard happens to
    // run first.
    () => slots.slotSets({
      rankedServers: [], upstreams: {}, roles: {}, occupied: [],
    }),
    /`alignerCharged` was not supplied/,
    'true draws a GPU row Owen ruled out; false strands a step that can run nowhere else',
  );
  assert.throws(
    () => slots.slotSets({
      rankedServers: [], upstreams: {}, roles: {}, occupied: [LEGACY], alignerCharged: false,
    }),
    /`occupied` says the local long-form aligner is holding something of ours/,
    'both are read off the same steps, so they cannot honestly disagree — and the occupied '
    + 'pass would have drawn the row `retiring`, which is false of the one set that always '
    + 'takes new work until B7 is built',
  );
});

test('an engine with no upstream that is STILL HOLDING a routed row keeps the lane, retiring', () => {
  // The lane is skipped for `none`, so it is not marked seen — and the occupied
  // pass then draws it: the occupant keeps its slot and nothing new is placed.
  const sets = slots.slotSets(factsOf({
    servers: ['mac'], upstreams: { mac: 'none' }, occupied: ['mac:cloud'],
  }));
  const lane = sets.find((s) => s.id === 'mac:cloud');
  assert.ok(lane, '§4.3: work that started somewhere finishes there');
  assert.strictEqual(lane.retiring, true);
  assert.strictEqual(lane.cpu, slots.CLOUD_LANE_SLOTS);
  assert.strictEqual(lane.gpu, 0);
});

test('WITH NOTHING QUEUED there is no legacy row: one GPU slot per server, and two local CPU', () => {
  /*
   * Owen, 2026-09-15: *"we would have as many gpu slots as we have connected
   * crucible serves … without a crucible server, there is no gpu slot, because
   * bookforge shouldnt know how to drive gpu work in-app."* This is that bench,
   * exactly.
   */
  const sets = slots.slotSets(factsOf({
    servers: ['local', 'mac'], upstreams: { local: 'none', mac: 'none' },
  }));
  assert.deepStrictEqual(sets.map((s) => s.id), ['local', 'mac', slots.LOCAL_WORK_SET]);
  assert.deepStrictEqual(sets.filter((s) => s.gpu > 0).map((s) => s.id), ['local', 'mac'],
    'every GPU row is a registered server’s, and there is no other kind');
  assert.strictEqual(slots.slotsOf(sets, LEGACY, 'gpu'), 0,
    'a set that is not on the bench has no room — and nothing is asking for one');
});

/*
 * ── THE BENCH OWEN COUNTS ───────────────────────────────────────────────────
 *
 * Measured 2026-09-15: he launched and read *"0 of 8 slots in use"* over
 * `local · GPU`, `local — routed elsewhere · CPU ×2`, `mac · GPU`,
 * `mac — routed elsewhere · CPU ×2` and `CPU slots · CPU ×2`, with a
 * record on disk saying NEITHER engine has an upstream. His ruling: *"i should
 * see two cpu slots (local) and two gpu slots (one wsl crucible engine, one mlx
 * crucible engine)."*
 *
 * The number on that header is `benchLanes(snapshot).length`, so it is pinned
 * here at that level rather than at the set list: four LANES, not four rows.
 */
test('no engine has an upstream: the bench is FOUR lanes and not one says "routed elsewhere"', () => {
  const sets = slots.slotSets(factsOf({
    servers: ['local', 'mac'], upstreams: { local: 'none', mac: 'none' },
  }));
  // `servers: []` — nobody has asked any machine whether it is answering, which
  // is what a snapshot with no routing host carries. See `BenchLane.down`.
  const lanes = bench.benchLanes({ jobs: [], running: false, slotSets: sets, servers: [] });
  assert.strictEqual(lanes.length, 4, 'the header reads "of 4", never "of 8"');
  assert.deepStrictEqual(
    lanes.map((l) => `${l.setLabel} · ${l.resource} · slot ${l.index} of ${l.of}`),
    [
      'local · gpu · slot 1 of 1',
      'mac · gpu · slot 1 of 1',
      'CPU slots · cpu · slot 1 of 2',
      'CPU slots · cpu · slot 2 of 2',
    ],
  );
  assert.ok(!lanes.some((l) => l.setLabel.includes('routed elsewhere')),
    'a cloud lane belongs to an engine that CAN forward work, and neither of these can');
});

// ── An ORCHESTRATOR has no card, so it draws no row ─────────────────────────
//
// crucible `docs/PHASE17-ORCHESTRATOR.md` §1: backend kind `orchestrator`, ZERO
// job types, manages exactly one engine. Owen, 2026-09-15: *"crucible on windows
// is a passthrough orchestrator so it shouldnt show up."* Measured the same day
// on his machine: :7101 answers `role: orchestrator`, `jobTypes: []`,
// `engine {url: http://127.0.0.1:7100, backend: cuda-linux, owner: wsl-unit}`,
// and :7100 answers `role: engine` with eleven job types.

test('a registered ORCHESTRATOR draws no GPU row and no cloud lane', () => {
  const sets = slots.slotSets(factsOf({
    servers: ['tray', 'mac'],
    roles: { tray: 'orchestrator', mac: 'engine' },
    upstreams: { tray: 'configured', mac: 'none' },
  }));
  assert.deepStrictEqual(sets.map((s) => s.id), ['mac', slots.LOCAL_WORK_SET],
    'a GPU slot for a process that serves no job types is a lane nothing can fill');
  assert.strictEqual(slots.slotsOf(sets, 'tray', 'gpu'), 0);
  assert.strictEqual(slots.slotsOf(sets, 'tray:cloud', 'cpu'), 0,
    'not even a cloud lane: it settles nothing and forwards nothing of its own');
});

test('the ENGINE behind it draws the row, so the card is counted exactly once', () => {
  /*
   * Both halves registered — the tray process and the WSL engine it manages —
   * which is the shape that would otherwise draw two GPU rows over one 3090 Ti.
   * Nothing dedupes them: the orchestrator simply has no row to collide with.
   */
  const sets = slots.slotSets(factsOf({
    servers: ['tray', 'local'],
    roles: { tray: 'orchestrator', local: 'engine' },
    upstreams: { tray: 'none', local: 'none' },
  }));
  assert.deepStrictEqual(sets.filter((s) => s.gpu > 0).map((s) => s.id), ['local']);
});

test('an orchestrator STILL HOLDING something of ours keeps its row, retiring', () => {
  // It is skipped rather than marked seen, for the reason the absent cloud lane
  // is: a row is never yanked out from under a running step.
  const sets = slots.slotSets(factsOf({
    servers: ['tray'], roles: { tray: 'orchestrator' }, upstreams: { tray: 'none' },
    occupied: ['tray'],
  }));
  const row = sets.find((s) => s.id === 'tray');
  assert.ok(row, '§4.3: work that started somewhere finishes there');
  assert.strictEqual(row.retiring, true);
});

test('a server nobody has asked about its ROLE keeps its row — every older Crucible is an engine', () => {
  const sets = slots.slotSets(factsOf({
    servers: ['mac'], roles: { mac: 'unknown' }, upstreams: { mac: 'none' },
  }));
  assert.deepStrictEqual(sets.map((s) => s.id), ['mac', slots.LOCAL_WORK_SET],
    'absence of knowledge is not absence of an engine, and a bench that emptied itself '
    + 'until the first read landed would be worse than one that corrects itself a tick later');
});

test('a caller that said nothing about ROLES is refused by name, never defaulted', () => {
  assert.throws(
    () => slots.slotSets({
      enabledServers: ['mac'], upstreams: { mac: 'none' }, occupied: [], alignerCharged: false,
    }),
    /`roles` was not supplied/,
    'the type says required; this is for the callers the compiler does not see',
  );
  assert.throws(
    () => slots.slotSets({
      rankedServers: [{ name: 'mac', enabled: true }], upstreams: { mac: 'none' }, roles: {},
      occupied: [], alignerCharged: false,
    }),
    /nothing was said about whether "mac" is an engine or an orchestrator/,
    'a name with no entry is a caller that forgot, not a server with no role',
  );
});

test('A QUEUED epub-align brings the legacy row back, with its one card', () => {
  /*
   * The row exists exactly when something charges it, and this is the step that
   * does: `generate-sentences` with `method: 'epub-align'` reads the project
   * EPUB off THIS disk and Crucible has no `align-longform` job
   * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7). Deleting the row outright would leave
   * it charging a set with nought slots, and the scheduler would never launch it.
   */
  const job = jobOfSteps([epubAlignStep()]);
  assert.strictEqual(slots.slotSetForStep(job, job.steps[0]), LEGACY,
    'this is the scheduler’s own reading of the step, not a list of step types');
  const sets = slots.slotSets(factsOf({ servers: ['local', 'mac'], jobs: [job] }));
  const legacy = sets.find((s) => s.id === LEGACY);
  assert.ok(legacy, 'the row is drawn for the step that can run nowhere else');
  assert.strictEqual(legacy.gpu, 1, 'the legacy stopgap keeps exactly one card');
  assert.strictEqual(legacy.cpu, 0);
  assert.strictEqual(legacy.retiring, false,
    'it takes new work for as long as the layer exists — `retiring` would be a lie');
  assert.strictEqual(slots.slotsOf(sets, LEGACY, 'gpu'), 1);
});

test('EVERY GPU row that IS drawn is a registered server, bar the one named legacy exception', () => {
  // The shape, pinned rather than the row wished away: nothing else may join it.
  // A new in-app GPU venue has to come past this line.
  const servers = ['local', 'mac'];
  const sets = slots.slotSets(factsOf({
    servers, jobs: [jobOfSteps([epubAlignStep()])],
  }));
  const gpuRows = sets.filter((s) => s.gpu > 0).map((s) => s.id);
  assert.deepStrictEqual(gpuRows, ['local', 'mac', LEGACY]);
  for (const id of gpuRows) {
    assert.ok(servers.includes(id) || id === LEGACY,
      `${id} has a GPU slot and is neither a registered server nor the legacy spawn`);
  }
  assert.strictEqual(sets.find((s) => s.id === slots.LOCAL_WORK_SET).gpu, 0,
    "BookForge's own work has no card — CPU only");
});

test('longformAlignCharged reads the STEPS, so a finished one charges nothing', () => {
  const queued = jobOfSteps([epubAlignStep()]);
  assert.strictEqual(slots.longformAlignCharged({ jobs: [queued] }), true);
  for (const status of ['done', 'failed', 'cancelled']) {
    assert.strictEqual(
      slots.longformAlignCharged({ jobs: [jobOfSteps([epubAlignStep({ status })])] }), false,
      `a ${status} step is history, not a plan — and it is what empties the row`);
  }
  assert.strictEqual(
    slots.longformAlignCharged({ jobs: [jobOfSteps([epubAlignStep({ status: 'held' })])] }), true,
    'a held step is still work that can run nowhere else; the lane must not appear at the '
    + 'instant Start is pressed');
  assert.strictEqual(
    slots.longformAlignCharged({ jobs: [jobOfSteps([epubAlignStep({ status: 'running' })])] }), true,
    'and a running one charges it too, which is why the occupied pass never draws this row');
});

test('a travelling render charges no legacy row, and a CPU step charges none either', () => {
  const travelling = stepOf({ travels: true, status: 'queued' });
  assert.strictEqual(slots.longformAlignCharged({
    jobs: [jobOfSteps([travelling], { waitForResolved: 'mac' })],
  }), false, 'it goes to the Mac’s set, so nothing in-app is being driven');
  assert.strictEqual(slots.longformAlignCharged({
    jobs: [jobOfSteps([stepOf({ resource: 'cpu', status: 'queued' })])],
  }), false, 'work BookForge does itself is `local-work`, which is always there');
  const unrouted = stepOf({ travels: true, status: 'queued' });
  assert.strictEqual(slots.longformAlignCharged({ jobs: [jobOfSteps([unrouted])] }), false,
    'a row with no venue yet answers null, and null is not the legacy spawn');
});

test('VIDEO ASSEMBLY IS NOT INFERENCE, so it charges local-work and draws no GPU row', () => {
  /*
   * Measured 2026-09-15 (`electron/video-assembly-bridge.ts`): PNG frames drawn
   * in an offscreen BrowserWindow, muxed with `ffmpeg -c:v libx264` — a software
   * x264 encode, no NVENC and no model. Owen's boundary is MODEL INFERENCE vs
   * DETERMINISTIC work, not GPU vs CPU, so the step declares `cpu` and the
   * legacy row it used to charge stays empty. (The declaration itself is pinned
   * on the module in `tools/test-queue-step-travel.js`.)
   */
  const video = stepOf({
    id: 'v', type: 'video-assembly', label: 'Render video', resource: 'cpu', status: 'queued',
  });
  const job = jobOfSteps([video]);
  assert.strictEqual(slots.slotSetForStep(job, video), slots.LOCAL_WORK_SET);
  assert.strictEqual(slots.longformAlignCharged({ jobs: [job] }), false);
  const sets = slots.slotSets(factsOf({ servers: ['mac'], jobs: [job] }));
  assert.ok(!sets.some((s) => s.id === LEGACY),
    'a video mux must not make the bench draw a card nobody is using');
});

test('local-work is always present and always CPU-only, charged legacy row or not', () => {
  for (const jobs of [[], [jobOfSteps([epubAlignStep()])]]) {
    for (const servers of [[], ['mac']]) {
      const sets = slots.slotSets(factsOf({ servers, jobs }));
      const own = sets.find((s) => s.id === slots.LOCAL_WORK_SET);
      assert.ok(own, 'a machine with no server at all still assembles and muxes');
      assert.strictEqual(own.gpu, 0);
      assert.strictEqual(own.cpu, slots.LOCAL_WORK_CPU_SLOTS);
      assert.strictEqual(own.retiring, false);
      assert.strictEqual(sets[sets.length - 1].id, slots.LOCAL_WORK_SET, 'and it is last');
    }
  }
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
  const occupancy = slots.slotSetOccupancy({ jobs: [job], slotSets: [] });
  assert.strictEqual(occupancy.get('mac:cloud').cpu, 1);
  assert.strictEqual(occupancy.get('mac:cloud').gpu, 0);
  assert.strictEqual(occupancy.get(slots.LOCAL_WORK_SET), undefined,
    "this machine did nothing; charging it would be the bench blaming the wrong lane");
});

test('A VENUED STEP IS INDIVISIBLE: one slot, its venue\'s, whatever it does inside', () => {
  /*
   * Owen, 2026-09-15: *"The entire tts step goes to the other system. That
   * includes anything the step needs to do even if it's cpu."* A render prepares
   * its text, packs its chunks and writes its session inside the one step, and
   * none of that may be charged to this machine — `slotSetForStep` reads the
   * VENUE before the resource, which is what shuts that door.
   */
  const render = stepOf({ venue: 'mac', travels: true, resource: 'gpu' });
  const job = jobOfSteps([render], { waitForResolved: 'mac' });
  assert.strictEqual(slots.slotSetForStep(job, render), 'mac');
  const counts = slots.slotSetOccupancy({ jobs: [job], slotSets: [] });
  assert.deepStrictEqual([...counts.keys()], ['mac'], 'ONE set is charged, and it is the venue');
  assert.deepStrictEqual(counts.get('mac'), { gpu: 1, cpu: 0 });
  assert.strictEqual(counts.get(slots.LOCAL_WORK_SET), undefined,
    'no half of it is charged here; there is no separate prep step to re-charge either — '
    + 'tts-conversion declares `gpu` for the whole run and prepares inside it');
  // And the same step with the resource it would have had if anyone re-derived
  // it mid-run still charges the venue, because the record outranks the kind.
  const midRun = stepOf({ venue: 'mac', travels: true, resource: 'cpu' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([midRun], { waitForResolved: 'mac' }), midRun),
    'mac', 'asking `resource` first is the door a venued step’s CPU half would fall through');
});

test('a plain CPU step still goes to local-work — it carries no venue', () => {
  const step = stepOf({ resource: 'cpu' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([step]), step), slots.LOCAL_WORK_SET);
});

test('THERE IS NO CROSS-SET ONE-CARD RULE ANY MORE — Owen, 2026-09-19', () => {
  /*
   * *"Crucible is configured to be system agnostic … it should effectively be
   * treated the same locally or otherwise."* `thisMachinesCardHeldBy` held the
   * in-app aligner and a loopback Crucible apart on the theory that they are
   * one 3090 Ti. Crucible owns its card's memory — it holds its own lease and
   * probes its own accelerator — so the rule, and the only function that could
   * express it, are gone.
   */
  assert.strictEqual(slots.thisMachinesCardHeldBy, undefined);
  assert.strictEqual(slots.thisMachineSetId, undefined);
});

test('a DISABLED server contributes no set, so nothing new is claimed there', () => {
  const sets = slots.slotSets(factsOf({ servers: ['local'] }));
  assert.ok(!sets.some((s) => s.id === 'mac'));
  assert.strictEqual(slots.slotsOf(sets, 'mac', 'gpu'), 0,
    'an unknown set has no room, so a claim against it waits rather than launching');
});

test('a disabled server still HOLDING our work keeps its set, marked retiring', () => {
  const sets = slots.slotSets(factsOf({ servers: ['local'], occupied: ['mac'] }));
  const mac = sets.find((s) => s.id === 'mac');
  assert.ok(mac, '§4.3: a job that started on a machine finishes on that machine');
  assert.strictEqual(mac.retiring, true);
  assert.strictEqual(sets.find((s) => s.id === 'local').retiring, false);
});

test('occupancy counts only what is RUNNING, per set', () => {
  const a = stepOf({ id: 'a', venue: 'mac', travels: true });
  const b = stepOf({ id: 'b', venue: 'mac', travels: true, status: 'queued' });
  const c = stepOf({ id: 'c', resource: 'cpu' });
  const counts = slots.slotSetOccupancy({ jobs: [jobOfSteps([a, b, c])], slotSets: [] });
  assert.strictEqual(counts.get('mac').gpu, 1, 'a queued row occupies nothing');
  assert.strictEqual(counts.get(slots.LOCAL_WORK_SET).cpu, 1);
});

// ── A BOOK IS ATOMIC ON THE CARD (Owen, 2026-09-20) ────────────────────────
//
// > i want books to be atomic actions, ideally, where they keep the GPU until
// > all of their GPU steps are complete. they can run the preparation step
// > locally before going to the GPU, but CPU steps that might take place
// > between GPU steps are very small and fast. they shouldnt lose their GPU
// > slot because theyre doing a quick step.
//
// What he watched: Mistborn finished its render, moved to the CPU for the
// session copy, and then queued for the card it had just been on — behind its
// own render's activity line. So the slot is charged to the RUN, derived from
// the steps (`gpuHoldOf`), from the first GPU act starting to the last landing.

/**
 * The narration plan as the scheduler sees it: a local prepare, then two
 * travelling GPU acts. Every case below is one arrangement of its statuses.
 */
const narration = (render, align, over = {}) => jobOfSteps([
  stepOf({ id: 'prep', type: 'prepare', label: 'Prepare', resource: 'cpu', status: 'done' }),
  stepOf({ id: 'render', type: 'tts-conversion', label: 'Narrate', travels: true, ...render }),
  stepOf({ id: 'align', type: 'align', label: 'Align', travels: true, ...align }),
], { waitForResolved: 'mac', ...over });

const gpuOn = (job, setId) =>
  (slots.slotSetOccupancy({ jobs: [job] }).get(setId) ?? { gpu: 0 }).gpu;

test("THE RENDER'S CPU TAIL KEEPS THE CARD — the hand-over frees the pool, not the machine", () => {
  // `handOverGpuSlot` writes exactly this pair: recharged to cpu, venue cleared.
  const job = narration(
    { status: 'running', resource: 'cpu', venue: undefined },
    { status: 'waiting' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'mac' });
  assert.strictEqual(gpuOn(job, 'mac'), 1, "the copy is CPU work; the card is still this book's");
  assert.strictEqual(
    (slots.slotSetOccupancy({ jobs: [job] }).get(slots.LOCAL_WORK_SET) ?? { cpu: 0 }).cpu, 1,
    'and the copy is still counted where it is actually happening');
});

test('RENDER DONE, ALIGN QUEUED: the card is held across the gap with nothing running', () => {
  const job = narration({ status: 'done', venue: undefined }, { status: 'queued' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'mac' });
  assert.strictEqual(gpuOn(job, 'mac'), 1,
    'this is the moment the book used to queue behind its own tail');
});

test('the hold does not DOUBLE-charge a card the run is already running on', () => {
  const job = narration({ status: 'running', venue: 'mac' }, { status: 'waiting' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'mac' });
  assert.strictEqual(gpuOn(job, 'mac'), 1, 'one book, one slot — the hold covers the GAPS');
  assert.strictEqual(slots.gpuHoldCharges(job, 'mac'), false);
});

test('THE HOLD ENDS WHEN THE LAST TRAVELLING GPU STEP SETTLES', () => {
  const landed = narration({ status: 'done', venue: undefined }, { status: 'done', venue: 'mac' });
  assert.strictEqual(slots.gpuHoldOf(landed), null, 'the assembly that follows holds no card');
  assert.strictEqual(gpuOn(landed, 'mac'), 0);
  const failed = narration({ status: 'done', venue: undefined }, { status: 'failed' });
  assert.strictEqual(slots.gpuHoldOf(failed), null,
    'a failed act will never run: there is nothing left to hold the card for');
  const cancelled = narration({ status: 'cancelled' }, { status: 'cancelled' });
  assert.strictEqual(slots.gpuHoldOf(cancelled), null,
    'a cancelled book never started, whatever it was in the middle of');
});

test("A STOPPED NEXT STEP GIVES THE CARD BACK — a held step is nobody's order", () => {
  // A user Stop lands a step at `held`, and the queue will not start a held
  // step on its own. A card kept for it would be kept for an act nobody has
  // ordered, with nothing on screen counting down.
  const job = narration({ status: 'done', venue: undefined }, { status: 'held' });
  assert.strictEqual(slots.gpuHoldOf(job), null);
  assert.strictEqual(gpuOn(job, 'mac'), 0);
});

// ── THE HOLD ASKS THE NEXT ACT, NOT ALL OF THEM (2026-09-20 01:50) ─────────
//
// Owen's queue, live: "Clean text — Pursuit of Power" with `foundry-job` done
// on the PC, `prepare` done, `tts-conversion` HELD ("Interrupted when BookForge
// closed. Press Start to pick it up") and `align`/`reassembly` waiting behind
// it. Scanning ALL travelling GPU steps found `align` outstanding and kept the
// PC's card — for a step that cannot start until a human presses Start on the
// row above it. The bench drew "Holding the card · Align — waiting to start
// Align" over an idle Crucible and nothing else could have the machine.

/**
 * That job, as the scheduler sees it: the Foundry render travels to the PC, the
 * landing and the prepare are local, then the two narration GPU acts.
 */
const pursuit = (render, align, over = {}) => jobOfSteps([
  stepOf({ id: 'foundry', type: 'foundry-job', label: 'Clean text', travels: true,
    status: 'done', venue: undefined }),
  stepOf({ id: 'landing', type: 'foundry-export-landing', label: 'Land the export',
    resource: 'cpu', status: 'done' }),
  stepOf({ id: 'prep', type: 'prepare', label: 'Prepare', resource: 'cpu', status: 'done' }),
  stepOf({ id: 'render', type: 'tts-conversion', label: 'Narrate', travels: true, ...render }),
  stepOf({ id: 'align', type: 'align', label: 'Align', travels: true, ...align }),
  stepOf({ id: 'assemble', type: 'reassembly', label: 'Assemble', resource: 'cpu',
    status: 'waiting' }),
], { id: 'pursuit', title: 'Pursuit of Power', waitForResolved: 'pc', ...over });

test("OWEN'S PURSUIT CASE — a HELD step between two landed acts frees the card", () => {
  const job = pursuit({ status: 'held', wasInterrupted: true }, { status: 'waiting' });
  assert.strictEqual(slots.gpuHoldOf(job), null,
    'nobody has released the narration, so the card is kept for nothing');
  assert.strictEqual(slots.gpuHoldStep(job), null,
    'and the bench must not name Align, which cannot start until Start is pressed');
  assert.strictEqual(slots.gpuHoldWords(job), null);
  assert.strictEqual(gpuOn(job, 'pc'), 0, "the PC's card is free for any other book");
});

test('THE SAME BOOK AFTER START: the released narration takes the card straight back', () => {
  const job = pursuit({ status: 'queued' }, { status: 'waiting' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'pc' },
    'the Foundry render already put this book on that card');
  assert.strictEqual(slots.gpuHoldStep(job).id, 'render');
  assert.strictEqual(gpuOn(job, 'pc'), 1);
});

test('RENDER DONE, ALIGN HELD: Stop on the NEXT GPU step gives the card back', () => {
  const job = pursuit({ status: 'done', venue: undefined }, { status: 'held' });
  assert.strictEqual(slots.gpuHoldOf(job), null);
  assert.strictEqual(slots.gpuHoldStep(job), null);
  assert.strictEqual(gpuOn(job, 'pc'), 0);
});

test('RENDER DONE, ALIGN QUEUED: unchanged — the gap between two acts still holds', () => {
  const job = pursuit({ status: 'done', venue: undefined }, { status: 'queued' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'pc' });
  assert.strictEqual(slots.gpuHoldStep(job).id, 'align');
  assert.strictEqual(gpuOn(job, 'pc'), 1);
});

test('A HELD STEP AFTER THE NEXT ACT CHANGES NOTHING — only the next act decides', () => {
  // The book is genuinely about to be on the card: its narration is released
  // and admissible. What the user has done to a step BEYOND it is a question
  // for when that step is next, not now.
  const job = pursuit({ status: 'queued' }, { status: 'held' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'pc' });
  assert.strictEqual(slots.gpuHoldStep(job).id, 'render');
  assert.strictEqual(gpuOn(job, 'pc'), 1);
});

test('A BOUND BOOK\'S LOCAL PREP HOLDS ITS CARD — "it sohuld still hold the slot lease"', () => {
  // Owen, 2026-09-25: a book dragged onto the WSL lane ran its prep locally
  // holding nothing, and the next book dragged there took the card. Until then
  // this keeper said the opposite ("PREPARE ALONE HOLDS NOTHING").
  const job = narration({ status: 'queued' }, { status: 'waiting' });
  assert.deepStrictEqual(slots.gpuHoldOf(job), { server: 'mac' }, "the prep landed; the card is the book's");
  assert.strictEqual(gpuOn(job, 'mac'), 1);
  const dragged = jobOfSteps([
    stepOf({ id: 'prep', type: 'prepare', label: 'Prepare', resource: 'cpu', status: 'running' }),
    stepOf({ id: 'render', type: 'tts-conversion', label: 'Narrate', travels: true, status: 'waiting' }),
  ], { waitFor: 'mac' });
  assert.deepStrictEqual(slots.gpuHoldOf(dragged), { server: 'mac' },
    'a book its own picker binds holds from its first step, before any card assigned it');
  const notBegun = jobOfSteps([
    stepOf({ id: 'prep', type: 'prepare', label: 'Prepare', resource: 'cpu', status: 'queued' }),
    stepOf({ id: 'render', type: 'tts-conversion', label: 'Narrate', travels: true, status: 'waiting' }),
  ], { waitFor: 'mac' });
  assert.strictEqual(slots.gpuHoldOf(notBegun), null, 'nothing has begun, so nothing is held');
  const anyMachine = narration({ status: 'queued' }, { status: 'waiting' },
    { waitForResolved: undefined, waitFor: waitFor.WAIT_FOR_ANY });
  assert.strictEqual(slots.gpuHoldOf(anyMachine), null, 'and a run that will take any machine holds none');
});

test('A NON-TRAVELLING GPU STEP DOES NOT EXTEND A HOLD past the last act on the card', () => {
  // A local RVC or denoise pass is on `local-longform-align`, this machine's
  // own row. It has never been on the server's card.
  const started = jobOfSteps([
    stepOf({ id: 'rvc', type: 'rvc-enhancement', label: 'Convert voice', status: 'running' }),
    stepOf({ id: 'align', type: 'align', label: 'Align', travels: true, status: 'queued' }),
  ], { waitForResolved: 'mac' });
  // A BOUND book's local work holds its card (2026-09-25), GPU or CPU alike.
  assert.deepStrictEqual(slots.gpuHoldOf(started), { server: 'mac' },
    'a local pass of a bound book keeps the card for the act after it');
  const extended = jobOfSteps([
    stepOf({ id: 'render', type: 'tts-conversion', label: 'Narrate', travels: true,
      status: 'done' }),
    stepOf({ id: 'rvc', type: 'rvc-enhancement', label: 'Convert voice', status: 'queued' }),
  ], { waitForResolved: 'mac' });
  assert.strictEqual(slots.gpuHoldOf(extended), null,
    "the local pass is not an act the server's card is kept for");
  assert.strictEqual(gpuOn(extended, 'mac'), 0);
});

test('AN UPSTREAM-ROUTED ACT HOLDS NO CARD, because it is never on one', () => {
  const job = jobOfSteps([
    stepOf({ id: 'clean', type: 'pass', label: 'Simplify', travels: true,
      resource: 'cpu', venue: slots.cloudLaneOf('mac'), status: 'running' }),
    stepOf({ id: 'clean2', type: 'pass', label: 'Translate', travels: true,
      resource: 'cpu', venue: slots.cloudLaneOf('mac'), status: 'queued' }),
  ], { waitForResolved: 'mac' });
  assert.strictEqual(slots.gpuHoldOf(job), null, 'it costs the engine a socket, not its card');
  assert.strictEqual(gpuOn(job, 'mac'), 0);
});

test('a row assigned to the RETIRED narrator holds nothing — it is not a machine', () => {
  const job = narration({ status: 'done' }, { status: 'queued' },
    { waitForResolved: waitFor.RETIRED_LOCAL_NARRATOR_VENUE });
  assert.strictEqual(slots.gpuHoldOf(job), null);
});

test('THE HELD CARD SAYS WHOSE IT IS, and that the wait is a short one', () => {
  const copying = narration(
    { status: 'running', resource: 'cpu', venue: undefined }, { status: 'waiting' });
  assert.strictEqual(slots.gpuHoldWords(copying),
    'holding the card for Mistborn between GPU steps — Narrate is finishing on the CPU');
  assert.strictEqual(slots.gpuHoldStep(copying).id, 'render');
  const waiting = narration({ status: 'done', venue: undefined }, { status: 'queued' });
  assert.strictEqual(slots.gpuHoldWords(waiting),
    'holding the card for Mistborn between GPU steps — waiting to start Align');
  assert.strictEqual(slots.gpuHoldStep(waiting).id, 'align');
  // Before its first act on the card, a bound book holds from its prep
  // (2026-09-25), and the words do not say "between GPU steps".
  const prepped = narration({ status: 'queued' }, { status: 'waiting' });
  assert.strictEqual(slots.gpuHoldWords(prepped),
    'holding the card for Mistborn — waiting to start Narrate');
  const none = narration({ status: 'queued' }, { status: 'waiting' },
    { waitForResolved: undefined, waitFor: waitFor.WAIT_FOR_ANY });
  assert.strictEqual(slots.gpuHoldWords(none), null, 'no hold, nothing to say');
  assert.strictEqual(slots.gpuHoldStep(none), null);
});

test('a step that cannot travel is charged to the in-app row, never to a server', () => {
  // Owen, 2026-09-19. A registered server's lane is reached through a VENUE the
  // step carries and no other way, so no server — loopback or across the
  // tailnet — is ever charged for work this app runs itself.
  const step = stepOf({ resource: 'gpu' });
  assert.strictEqual(slots.slotSetForStep(jobOfSteps([step]), step), LEGACY);
  const onMac = stepOf({ resource: 'gpu' });
  assert.strictEqual(
    slots.slotSetForStep(jobOfSteps([onMac], { waitForResolved: 'local' }), onMac), LEGACY,
    'even a run already pointed at a machine: this step cannot go there');
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
  // The legacy row is answered exactly as `currentSlotSets` answers it — off
  // these jobs, with the scheduler's own function — so the bench under test is
  // the bench the engine would build.
  return {
    jobs, running: true,
    slotSets: slots.slotSets(factsOf({ servers, occupied, jobs })),
    // Nobody has probed any of them: `BenchLane.down` is null on every lane
    // here, which is the state these cases were written against.
    servers: [],
  };
}

test('every machine gets its own lanes, and a lane says which machine it is', () => {
  const snap = snapOf([], ['local', 'mac']);
  const lanes = bench.benchLanes(snap);
  const gpus = lanes.filter((l) => l.resource === 'gpu');
  assert.deepStrictEqual(gpus.map((l) => l.setId), ['local', 'mac'],
    'nothing is queued, so there is no legacy lane to draw');
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
  assert.strictEqual(lanes.find((l) => l.setId === LEGACY), undefined,
    'and nothing in this queue can only run in-app, so that row is not drawn at all');
});

test('a queued epub-align draws the legacy lane BESIDE the servers, and it is empty', () => {
  const job = jobOfSteps([epubAlignStep()], { id: 'j1', title: 'Wool' });
  const lanes = bench.benchLanes(snapOf([job], ['local', 'mac'])).filter((l) => l.resource === 'gpu');
  assert.deepStrictEqual(lanes.map((l) => l.setId), ['local', 'mac', LEGACY]);
  const legacy = lanes.find((l) => l.setId === LEGACY);
  assert.strictEqual(legacy.occupant, null, 'it is queued, not running');
  assert.strictEqual(legacy.setLabel, 'the local long-form aligner',
    'the heading is unchanged: a SlotSet has a heading and nothing else, and inventing a '
    + 'second sentence field for one row is a change to what a bench row IS');
  assert.strictEqual(legacy.retiring, false);
});

test('a row waiting for a card is told WHICH card', () => {
  const running = stepOf({ id: 'r', venue: 'mac', travels: true });
  const queued = stepOf({ id: 'q', venue: 'mac', travels: true, status: 'queued' });
  const job = jobOfSteps([running], { id: 'j1', waitForResolved: 'mac' });
  const other = jobOfSteps([queued], { id: 'j2', title: 'Wool', waitForResolved: 'mac' });
  const reason = bench.stillReason(snapOf([job, other], ['local', 'mac']), other, queued);
  assert.strictEqual(reason.kind, 'no-slot');
  // Owen's "the server is occupied" sentence, which NAMES the machine:
  // "Waiting for mac to become free" (docs/PENDING-QUEUE-AND-GPU-DIAL.md).
  assert.match(reason.sentence, /mac to become free/);
  assert.match(reason.sentence, /Narrating Mistborn/);
});

test("a row waiting for a full CLOUD lane is not told to look at its own processor", () => {
  /*
   * The lane's width lives in the `cpu` counter because the work occupies no
   * card — but it is not this machine's CPU, and "Waiting for a CPU slot"
   * would be true of the counter and false of the world.
   */
  const r1 = stepOf({ id: 'r1', venue: 'mac:cloud', resource: 'cpu', travels: true });
  const r2 = stepOf({ id: 'r2', venue: 'mac:cloud', resource: 'cpu', travels: true });
  const queued = stepOf({ id: 'q', venue: 'mac:cloud', resource: 'cpu', travels: true, status: 'queued' });
  const ja = jobOfSteps([r1], { id: 'j1', waitForResolved: 'mac' });
  const jb = jobOfSteps([r2], { id: 'j2', title: 'Wool', waitForResolved: 'mac' });
  const jc = jobOfSteps([queued], { id: 'j3', title: 'Dune', waitForResolved: 'mac' });
  const reason = bench.stillReason(snapOf([ja, jb, jc], ['local', 'mac']), jc, queued);
  assert.strictEqual(reason.kind, 'no-slot');
  assert.match(reason.sentence, /mac to finish what it is sending elsewhere/);
  assert.ok(!/CPU slot/.test(reason.sentence), reason.sentence);
  assert.ok(!/graphics card/.test(reason.sentence), reason.sentence);
});


test('the thermal reading never lands on a remote machine\'s lane', () => {
  // A legacy-charging row is queued so the lane the reading belongs on exists:
  // it is drawn on THIS machine's venue and on no server's, because nvidia-smi
  // samples this card and the snapshot does not carry which server is local.
  const snap = snapOf([jobOfSteps([epubAlignStep()])], ['mac']);
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
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    reach: initial.reach ?? {},
  };
  state.host = {
    routing: () => ({
      ranked: state.ranked.map((row) => ({ ...row })),
      legacyLocalRender: state.legacyLocalRender,
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

/**
 * Compose a run AND SEND IT — the two presses a person makes.
 *
 * Adding a book stages it in Pending now (docs/PENDING-QUEUE-AND-GPU-DIAL.md
 * §1), and a staged run is skipped by the pump whole, so every test here that
 * is about what the SCHEDULER does with a book has to get it into the live queue
 * first. Runs that cannot travel are never staged and pass straight through.
 */
function enqueueSent(spec) {
  const job = engine.enqueue(spec);
  if (job.pending === true) engine.sendToQueue(job.id);
  return job;
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

  const a = enqueueSent(narrate('Mistborn', 'local'));
  const b = enqueueSent(narrate('Wool', 'mac'));
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

  const a = enqueueSent(narrate('Mistborn', 'mac'));
  const b = enqueueSent(narrate('Wool', 'mac'));
  engine.start();
  await settle(40);

  assert.strictEqual(gpu.runs.length, 1, 'nothing was submitted to be refused');
  const snap = engine.snapshot();
  const second = snap.jobs.find((j) => j.id === b.id);
  const reason = bench.stillReason(snap, second, second.steps[0]);
  assert.strictEqual(reason.kind, 'no-slot');
  // Owen's "the server is occupied" sentence, which NAMES the machine:
  // "Waiting for mac to become free" (docs/PENDING-QUEUE-AND-GPU-DIAL.md).
  assert.match(reason.sentence, /mac to become free/);

  gpu.runs[0].resolve({ kind: 'epub', path: '/out/a' });
  await settle(40);
  assert.strictEqual(gpu.runs.length, 2, 'the slot freed and the queue took it');
});

test('a host address uses its engine lane, and registering that engine twice never doubles capacity', async () => {
  for (const direct of [false, true]) {
    routes.forgetCrucibleRoutes();
    const gpu = fakeModule('tts-conversion', { travels: true });
    const ranked = [{ name: 'tray', enabled: true }];
    if (direct) ranked.push({ name: 'gpu', enabled: true });
    const host = fakeHost({ ranked, defaultWaitFor: 'tray',
      reach: { tray: { reachable: true }, gpu: { reachable: true } } });
    await fresh(`host-engine-alias-${direct}`, [gpu], host);
    try {
      routes.noteCrucibleRole('tray', { role: 'orchestrator', engine: {
        name: 'native-engine', url: 'http://127.0.0.1:7100', backend: 'llama-windows', owner: 'native',
      } });
      routes.noteCrucibleEngineUrl('tray', 'http://127.0.0.1:7100');
      routes.noteCrucibleUpstreams('tray', false);
      if (direct) {
        routes.noteCrucibleRole('gpu', { role: 'engine' });
        routes.noteCrucibleEngineUrl('gpu', 'http://127.0.0.1:7100');
        routes.noteCrucibleUpstreams('gpu', false);
      }
      const first = enqueueSent(narrate('First', 'tray'));
      enqueueSent(narrate('Second', direct ? 'gpu' : 'tray'));
      engine.start(); await settle(40);
      assert.strictEqual(gpu.runs.length, 1, 'one engine admits one BookForge run');
      const visible = engine.snapshot().slotSets.filter((set) => set.gpu > 0);
      assert.deepStrictEqual(visible.map((set) => set.id), [direct ? 'gpu' : 'tray']);
      assert.strictEqual(jobById(first.id).steps[0].venue, visible[0].id);
      assert.strictEqual(jobById(first.id).waitForResolved, 'tray', 'the requested connection remains recorded');
      gpu.runs[0].resolve(); await settle(40);
      assert.strictEqual(gpu.runs.length, 2, 'the next alias takes the same freed slot');
      gpu.runs[1].resolve(); await settle(30);
    } finally { routes.forgetCrucibleRoutes(); }
  }
});

test('`any` skips a machine we are already using and takes the next in rank order', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('any-skips', [gpu], host);

  enqueueSent(narrate('Mistborn', 'any'));
  const b = enqueueSent(narrate('Wool', 'any'));
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

  enqueueSent(narrate('Mistborn', 'any'));
  enqueueSent(narrate('Wool', 'any'));
  const c = enqueueSent(narrate('Elantris', 'any'));
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

  const a = enqueueSent(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1);

  host.ranked = [{ name: 'local', enabled: true }, { name: 'mac', enabled: false }];
  const b = enqueueSent(narrate('Wool', 'mac'));
  await settle(40);

  assert.strictEqual(gpu.runs.length, 1, 'no new claim goes to a disabled server');
  // "paused" since 2026-09-22 — the switch says Running/Paused now, and the
  // hold sentence names the control the operator has to press.
  assert.match(jobById(b.id).steps[0].progress.admissionHold, /paused/);

  const snap = engine.snapshot();
  const mac = snap.slotSets.find((s) => s.id === 'mac');
  assert.ok(mac, 'the running step keeps its set on the bench');
  assert.strictEqual(mac.retiring, true);
  assert.strictEqual(jobById(a.id).steps[0].status, 'running', 'it is not stopped');

  gpu.runs[0].resolve({ kind: 'epub', path: '/out/a' });
  await settle(40);
  /*
   * AND THE ROW STAYS, GREY — changed 2026-09-15 on Owen's ruling: *"if a
   * crucible slot is unchecked, it grays it out until it's re-checked/
   * re-enabled."*
   *
   * It used to vanish here, and that was the reading worth fixing: a machine
   * you own and switched off became indistinguishable from one BookForge
   * cannot see, and those have completely different remedies. The row is now
   * the switch's own home, so the thing you turned off is the thing you turn
   * back on.
   */
  const after = engine.snapshot().slotSets.find((s) => s.id === 'mac');
  assert.ok(after, 'a switched-off server keeps its row so it can be switched back on');
  assert.strictEqual(after.disabled, true, 'and it reads as off, not as missing');
  assert.strictEqual(after.retiring, false,
    'nothing is finishing on it any more — it is simply off');
});

/*
 * ── THE DEFECT A UNIT TEST CANNOT SEE ───────────────────────────────────────
 *
 * Measured on Owen's machine, 2026-09-15. He launched, the window asked for one
 * snapshot while `crucible-upstreams.json` did not yet exist (it was created
 * three seconds later, at 15:04:16, by the very reads that answer this), so both
 * engines were `unknown` — which DRAWS the lane — and the bench read "0 of 8
 * slots in use". Coordination answered a moment later and the record became
 * right, and the window never heard: every other publication is a structural
 * change in the QUEUE, and an idle queue has none. `GET /api/queue/snapshot`
 * against that same running process answered three sets while the bench drew
 * five.
 *
 * So the fix is not an earlier read — the rest of these reads are HTTP to a WSL
 * guest and a Mac, and `unknown → draw it` stays the rule — but that the record
 * ANNOUNCES what it learns and the engine republishes. This is that, driven
 * through the real record and the real engine, with nothing in the queue.
 */
test('THE BENCH REDRAWS WHEN THE RECORD LEARNS — nothing else would ever redraw it', async () => {
  const routes = require(path.join(DIST, 'crucible', 'routes.js'));
  // As at launch: nothing has been asked, so every engine is `unknown`.
  routes.forgetCrucibleRoutes();
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('record-invalidates', [fakeModule('tts-conversion', { travels: true })], host);

  const published = [];
  const stop = engine.onQueueChanged((snap) => { published.push(snap); });

  assert.deepStrictEqual(
    engine.snapshot().slotSets.map((s) => s.id),
    ['local', 'local:cloud', 'mac', 'mac:cloud', slots.LOCAL_WORK_SET],
    'the launch bench is the conservative one BY DESIGN — this is the snapshot the window got',
  );

  // The two reads land. NOTHING is queued, so no pump, no step, no structural change.
  routes.noteCrucibleUpstreams('local', false);
  routes.noteCrucibleUpstreams('mac', false);

  assert.strictEqual(published.length, 2, 'each answer is news exactly once');
  const last = published[published.length - 1];
  assert.deepStrictEqual(last.slotSets.map((s) => s.id), ['local', 'mac', slots.LOCAL_WORK_SET]);
  assert.strictEqual(bench.benchLanes(last).length, 4, 'four slots, which is what Owen asked for');
  assert.ok(!bench.benchLanes(last).some((l) => l.setLabel.includes('routed elsewhere')));

  // Re-recording the SAME answer is not news: coordination runs on every connect.
  routes.noteCrucibleUpstreams('mac', false);
  assert.strictEqual(published.length, 2, 'a listener fired on every connect would be a timer');

  // A role landing is news too — and takes the orchestrator's row off the bench.
  routes.noteCrucibleRole('mac', {
    server: { name: 'crucible-orchestrator@example-pc', version: '0.6.0', apiVersion: 1 },
    role: 'orchestrator',
    engine: {
      name: 'crucible@example-pc-wsl', url: 'http://127.0.0.1:7100',
      backend: 'cuda-linux', owner: 'wsl-unit',
    },
  });
  assert.strictEqual(published.length, 3);
  assert.deepStrictEqual(
    published[2].slotSets.map((s) => s.id), ['local', slots.LOCAL_WORK_SET],
    'a process that serves no job types gets no card',
  );
  assert.strictEqual(
    routes.crucibleEngineBehind('mac').url, 'http://127.0.0.1:7100',
    'and the engine it fronts is remembered, so an operator can be told what to register',
  );

  stop();
  routes.forgetCrucibleRoutes();
});

test('the in-app row keeps ONE card, and a second step that cannot travel waits for it',
  async () => {
    /*
     * The row is this app's OWN GPU tenant and has one slot, exactly as the old
     * global number did. It was `gpu.runs + local.runs === 1` until Owen's
     * ruling of 2026-09-19, when the cross-set one-card rule went: a render on
     * `local` is Crucible's card to manage, so it no longer takes turns with
     * work this process runs itself. Two steps of OUR OWN still do.
     */
    const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
    const host = fakeHost({ ranked: TWO, defaultWaitFor: 'local', reach: REACHABLE });
    await fresh('in-app-one-card', [local], host);

    for (const title of ['Enhance A', 'Enhance B']) {
      enqueueSent({
        title,
        steps: [{
          type: 'rvc-enhancement', label: 'Enhance', config: {},
          sourceRef: { kind: 'audio-session', path: '/s' },
        }],
      });
    }
    engine.start();
    await settle(40);

    assert.strictEqual(local.runs.length, 1,
      'the in-app GPU row has one slot, exactly as the old global number did');

    local.runs[0].resolve({ kind: 'sentences', path: '/out/s' });
    await settle(40);
    assert.strictEqual(local.runs.length, 2, 'and the second takes it the moment it frees');
  });

test('IN-APP GPU WORK GETS ITS OWN ROW, whatever servers are registered', async () => {
  /*
   * Owen, 2026-09-19: *"Crucible is configured to be system agnostic … it should
   * effectively be treated the same locally or otherwise."*
   *
   * Between 2026-09-18 and that ruling this row was SWALLOWED whenever a
   * registered server answered on loopback — its two slots were held to BE the
   * card, and the aligner was filed into them. That is the queue treating one
   * registered server differently for being here, which is the thing the ruling
   * deleted. So the row is drawn on `alignerCharged` and nothing else, and
   * `local` keeps both of its own slots for renders.
   *
   * THE HAZARD THE ROW GUARDS is the last assertion here: a step with no set to
   * charge gets `slotsOf` 0 and is never launched. It launches.
   */
  const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('in-app-gpu-own-row', [local], host);

  assert.ok(!engine.snapshot().slotSets.some((s) => s.id === LEGACY),
    'nothing charges it, so the row is absent');

  enqueueSent({
    title: 'Enhance',
    steps: [{
      type: 'rvc-enhancement', label: 'Enhance', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  engine.start();
  await settle(40);

  const row = engine.snapshot().slotSets.find((s) => s.id === LEGACY);
  assert.ok(row, "this app's own GPU work has a lane of its own");
  assert.strictEqual(row.gpu, 1);
  assert.strictEqual(local.runs.length, 1, 'and it LAUNCHED — no set, no slots, no launch');

  const mine = bench.benchLanes(engine.snapshot())
    .filter((l) => l.resource === 'gpu' && l.setId === LEGACY);
  assert.strictEqual(mine.filter((l) => l.occupant !== null).length, 1,
    'the occupant is drawn on that row and not on a server\'s');
  assert.strictEqual(
    bench.benchLanes(engine.snapshot())
      .filter((l) => l.resource === 'gpu' && l.setId === 'local' && l.occupant !== null).length, 0,
    "and NOT on the loopback server's lane — that card is Crucible's to fill");

  local.runs[0].resolve({ kind: 'sentences', path: '/out/s' });
  await settle(40);
  assert.strictEqual(
    bench.benchLanes(engine.snapshot())
      .filter((l) => l.resource === 'gpu' && l.occupant !== null).length, 0,
    'and the slot is free again the moment it finishes');
});

test('a QUEUED in-app GPU step raises the row, because it has nowhere else to be',
  async () => {
    /*
     * The row is what such a step is ADMITTED INTO: with no row, `slotsOf`
     * answers 0 and the step waits for ever. So it is raised by any non-terminal
     * step that charges it, queued or running — uniformly, on every machine.
     * It was suppressed here while a loopback server was registered, which is
     * exactly the "a server here is a different sort of thing" the 2026-09-19
     * ruling removed.
     */
    const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
    const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
    await fresh('queued-in-app-gpu-raises-its-row', [local], host);

    enqueueSent({
      title: 'Enhance',
      steps: [{
        type: 'rvc-enhancement', label: 'Enhance', config: {},
        sourceRef: { kind: 'audio-session', path: '/s' },
      }],
    });
    await settle(40);   // enqueued, never started: Start was not pressed

    const row = engine.snapshot().slotSets.find((s) => s.id === LEGACY);
    assert.ok(row, 'the step has to have a lane to be admitted into');
    const lanes = bench.benchLanes(engine.snapshot())
      .filter((l) => l.resource === 'gpu' && l.setId === LEGACY);
    assert.strictEqual(lanes.filter((l) => l.occupant !== null).length, 0,
      'and nothing is IN it: the step is still in the queue');
  });

test('WITH NO LOCAL CRUCIBLE the row is still drawn, or the work could never start', async () => {
  /*
   * The fallback, and it is not a leftover. On a machine where no registered
   * server answers, this work still runs here and still needs a lane to be
   * admitted into; suppressing the row there would leave the step mapped to a
   * set the scheduler cannot fill, waiting for ever. So a queued align DOES
   * raise the row on such a machine, which is the price of it being able to run.
   */
  const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE,
  });
  await fresh('no-local-crucible-keeps-the-row', [local], host);

  enqueueSent({
    title: 'Enhance',
    steps: [{
      type: 'rvc-enhancement', label: 'Enhance', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  engine.start();
  await settle(40);

  const row = engine.snapshot().slotSets.find((s) => s.id === LEGACY);
  assert.ok(row, 'nothing here is this machine, so the work gets a lane of its own');
  assert.strictEqual(row.gpu, 1);
  assert.strictEqual(local.runs.length, 1, 'and it launched');
});

test('a loopback Crucible and this app\'s own GPU work run SIDE BY SIDE', async () => {
  /*
   * Owen, 2026-09-19: *"Crucible is configured to be system agnostic. Doesn't
   * matter if it's on this system or on a rented DigitalOcean GPU, it should
   * effectively be treated the same locally or otherwise. Like Ollama — the
   * user connects to it the same way whether local or remote."*
   *
   * This test used to assert the opposite — the two took turns, held apart
   * first by a cross-set one-card rule and then (2026-09-18) by being filed
   * into one set. Both were the queue deciding what may be resident on a card
   * Crucible manages. Crucible owns its card's memory: it holds its own lease,
   * probes its own accelerator, and refuses by name when it is full. So the
   * render goes to `local`'s lane, the enhance goes to this app's own row, and
   * neither waits for the other.
   *
   * THE CONSEQUENCE IS DELIBERATE AND IS WRITTEN DOWN IN `pump`: a render on a
   * Crucible here no longer waits behind `external-gpu-job.lock`, and
   * `acquireGpuForJob` no longer evicts Ollama for one.
   */
  const gpu = fakeModule('tts-conversion', { travels: true });
  const local = fakeModule('rvc-enhancement', { consumes: 'audio-session', produces: 'sentences' });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'local', reach: REACHABLE });
  await fresh('loopback-and-in-app-side-by-side', [gpu, local], host);

  enqueueSent({
    title: 'Enhance',
    steps: [{
      type: 'rvc-enhancement', label: 'Enhance', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  const b = enqueueSent(narrate('Mistborn', 'local'));
  engine.start();
  await settle(40);

  assert.strictEqual(local.runs.length, 1, "this app's own GPU row took the enhance");
  assert.strictEqual(gpu.runs.length, 1,
    'and the render went to the server, which is scheduled exactly as the Mac would be');
  // Nothing is held, so nothing has a reason written on it.
  assert.strictEqual(jobById(b.id).steps[0].progress.admissionHold, undefined);
});

test('a CPU step never waits for a card, however busy every machine is', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const cpu = fakeModule('reassembly', { resource: () => 'cpu', consumes: 'audio-session',
    produces: 'm4b' });
  const host = fakeHost({ ranked: TWO, defaultWaitFor: 'any', reach: REACHABLE });
  await fresh('cpu-unblocked', [gpu, cpu], host);

  enqueueSent(narrate('Mistborn', 'any'));
  enqueueSent(narrate('Wool', 'any'));
  enqueueSent({
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

  const a = enqueueSent(narrate('Mistborn', 'mac'));
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

test('a settings write speaks for its four classes and leaves the rest of the table alone', () => {
  /*
   * bookforge-pc-1, 2026-09-24: a settings PUT answers with the four llm
   * classes' routes, and recording it REPLACED the table, so `decide`, `pages`
   * and every other class a capability read had filled went back to `unknown`.
   */
  routes.forgetCrucibleRoutes();
  routes.noteCrucibleRoutes('pc', { clean: 'local', translate: 'local', decide: 'local', pages: 'local' });
  routes.noteCrucibleRouteSubset('pc', { clean: 'upstream', translate: 'local' });
  assert.strictEqual(routes.crucibleRouteOf('pc', 'clean'), 'upstream');
  assert.strictEqual(routes.crucibleRouteOf('pc', 'decide'), 'local');
  assert.strictEqual(routes.crucibleRouteOf('pc', 'pages'), 'local');
  routes.forgetCrucibleRoutes();
});

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

  const a = enqueueSent(translatePass('Mistborn', 'mac'));
  engine.start();
  await settle(40);

  const step = jobById(a.id).steps[0];
  assert.strictEqual(step.venue, 'mac:cloud', 'it was placed on the engine\'s cloud lane');
  assert.strictEqual(step.resource, 'cpu', 'it occupies no card, so it is not charged for one');
  assert.strictEqual(ai.runs.length, 1);

  // …and the Mac's GPU slot is untouched, so a render admits beside it.
  const b = enqueueSent(narrate('Wool', 'mac'));
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

  enqueueSent(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1, "the render took the Mac's card");

  const b = enqueueSent(translatePass('Wool', 'mac'));
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

  enqueueSent(translatePass('One', 'mac'));
  enqueueSent(translatePass('Two', 'mac'));
  const third = enqueueSent(translatePass('Three', 'mac'));
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

  const a = enqueueSent(translatePass('Mistborn', 'mac'));
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
  // THE ROW ASKS (Owen, 2026-09-24): a switch-on whose coordination stopped
  // early left this hold waiting for a connect that never came.
  const asked = [];
  engine.setCrucibleRouteReader((server) => { asked.push(server); });

  const a = enqueueSent(translatePass('Mistborn', 'mac'));
  engine.start();
  await settle(40);

  assert.strictEqual(ai.runs.length, 0, 'nothing ran on a lane nobody has chosen');
  const step = jobById(a.id).steps[0];
  assert.match(step.progress.admissionHold, /has not yet read where "mac" runs translate work/);
  assert.ok(asked.includes('mac'), 'the held row asked for the read itself');

  // A read that fails says so in the hold, instead of "has not yet read".
  routes.noteCrucibleRouteReadFailed('mac', 'connection refused');
  engine.pump();
  await settle(40);
  assert.match(jobById(a.id).steps[0].progress.admissionHold,
    /could not read where "mac" runs translate work \(connection refused\)/);
  engine.setCrucibleRouteReader(null);

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

  const a = enqueueSent(translatePass('Mistborn', 'mac'));
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

  const a = enqueueSent(narrate('Mistborn', 'mac'));
  engine.start();
  await settle(40);
  assert.strictEqual(gpu.runs.length, 1);
  assert.strictEqual(jobById(a.id).steps[0].venue, 'mac');
});

// ── The switched-off servers, drawn and grey ────────────────────────────────
// Owen, 2026-09-15: "if a crucible slot is unchecked, it grays it out until
// it's re-checked/re-enabled." Before this they were filtered out upstream and
// the row vanished, which reads exactly like a machine BookForge cannot see.

test('a switched-off server still draws its row, marked disabled', () => {
  const sets = slots.slotSets(factsOf({ servers: ['3090 Ti'], off: ['mac'] }));
  const mac = sets.find((set) => set.id === 'mac');
  assert.ok(mac, 'a server you own and switched off must not vanish from the bench');
  assert.strictEqual(mac.disabled, true);
  assert.strictEqual(mac.retiring, false,
    'retiring means finishing and then gone; this is a switch waiting to be flipped back');
  assert.strictEqual(mac.gpu, 1, 'the row keeps its shape so it can be switched back on');
});

test('an enabled server is not marked disabled', () => {
  const sets = slots.slotSets(factsOf({ servers: ['3090 Ti'] }));
  assert.strictEqual(sets.find((set) => set.id === '3090 Ti').disabled, false);
});

test('a switched-off server draws NO cloud lane', () => {
  // The lane exists because that engine forwards work somewhere. An engine the
  // queue will not send to forwards nothing.
  const sets = slots.slotSets(factsOf({
    servers: [], off: ['mac'], upstreams: { mac: 'cloud' }, roles: { mac: 'engine' },
  }));
  assert.strictEqual(sets.some((set) => set.id === 'mac:cloud'), false);
});

test('the rows keep their RANK ORDER when a switch is flipped', () => {
  /*
   * Owen, 2026-09-15: "the crucible slots shouldnt switch positions. i just
   * re-checked one and they switched where they were... whichever is at the top
   * shoudl be on the left. from left to right, like a book."
   *
   * The first draft drew every enabled server and then every disabled one, so
   * unchecking a row moved its card to the end — the one thing a row somebody
   * is pointing at must not do.
   */
  const ranked = [
    { name: '3090 Ti', enabled: true },
    { name: 'mac', enabled: true },
    { name: 'droplet', enabled: true },
  ];
  const order = (rows) => slots
    .slotSets(factsOf({ ranked: rows, servers: rows.map((r) => r.name) }))
    .map((set) => set.id)
    .filter((id) => rows.some((r) => r.name === id));

  assert.deepStrictEqual(order(ranked), ['3090 Ti', 'mac', 'droplet']);

  // The MIDDLE one goes off: it must stay in the middle.
  const middleOff = ranked.map((r) => (r.name === 'mac' ? { ...r, enabled: false } : r));
  assert.deepStrictEqual(order(middleOff), ['3090 Ti', 'mac', 'droplet'],
    'a switched-off row keeps its place');

  // And the FIRST one: still first, still leftmost.
  const firstOff = ranked.map((r) => (r.name === '3090 Ti' ? { ...r, enabled: false } : r));
  assert.deepStrictEqual(order(firstOff), ['3090 Ti', 'mac', 'droplet']);
});

test('a caller that says nothing about what is switched off is refused', () => {
  assert.throws(
    () => slots.slotSets({
      upstreams: {}, roles: {}, occupied: [],
      alignerCharged: false,
    }),
    /`rankedServers` was not supplied/,
    'an empty list is a claim that nothing is off, and every greyed row would vanish again',
  );
});

test('the CPU set is called CPU slots, not BookForge itself', () => {
  // Owen, 2026-09-15: "it shouldnt be called 'BookForge itself', it can be
  // called 'CPU slots'."
  const sets = slots.slotSets(factsOf({}));
  const local = sets.find((set) => set.id === slots.LOCAL_WORK_SET);
  assert.strictEqual(local.label, 'CPU slots');
  assert.strictEqual(local.disabled, false, 'the CPU slots have no switch — there is nowhere else for that work to go');
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
