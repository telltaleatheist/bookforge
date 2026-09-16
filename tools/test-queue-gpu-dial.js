#!/usr/bin/env node
/**
 * test-queue-gpu-dial.js — the dial's RECORD, and the bench's grouping.
 *
 * Two halves of `docs/PENDING-QUEUE-AND-GPU-DIAL.md` that the routing keeper
 * does not reach:
 *
 *   • **Where the dial's value lives** — `electron/crucible/gpu-dial.ts`, its own
 *     record under `<userData>`, driven here over a temp file and a SCRIPTED
 *     server set. A missing file is `any` (the position of a dial nobody has
 *     turned); a file that exists and is not the record is REFUSED rather than
 *     replaced; a server this machine does not have is refused BY NAME; a
 *     DISABLED one is accepted, because the parked row's own sentence says so
 *     and refusing here would force the operator to resolve two controls in one
 *     particular order.
 *
 *   • **The bench's grouping** — `benchSections` in `shared/queue/bench.ts`.
 *     Owen, 2026-09-15: *"maybe we should have a local cpu slot section and a
 *     gpu slot section. they look kind of ugly clustered together randomly."*
 *     Sections in a fixed order, an empty one never drawn, and the aligner row
 *     filed by its RESOURCE.
 *
 * …plus the Pending band's own shape (`pendingPlans` / `bookPlans`), because the
 * two must partition the live runs exactly and neither may show the other's.
 *
 * Build first: `npx tsc -p tsconfig.electron.json`.
 * Run:  node tools/test-queue-gpu-dial.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const dial = require(path.join(REPO, 'dist', 'electron', 'crucible', 'gpu-dial.js'));
const bench = require(path.join(REPO, 'dist', 'shared', 'queue', 'bench.js'));
const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));
const slotSets = require(path.join(REPO, 'dist', 'shared', 'queue', 'slot-sets.js'));

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

function refuses(fn, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught, 'expected a refusal, got none');
  assert.ok(caught instanceof dial.CrucibleGpuDialError,
    `expected CrucibleGpuDialError, got ${caught.name}: ${caught.message}`);
  assert.strictEqual(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-gpu-dial-'));
let seq = 0;
function fresh(contents) {
  seq += 1;
  const file = path.join(tmp, `dial-${seq}.json`);
  if (contents !== undefined) {
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return new dial.GpuDial(file);
}

const KNOWN = ['3090 Ti', 'M1 Ultra'];

// ── The record ──────────────────────────────────────────────────────────────

check('a dial nobody has turned is `any` — a real state, not a fallback', () => {
  assert.strictEqual(fresh().read(), waitFor.GPU_DIAL_ANY);
  assert.strictEqual(waitFor.GPU_DIAL_ANY, 'any');
  // One spelling of the word, shared with a row's own answer, because the two
  // are compared to each other on every admission pass.
  assert.strictEqual(waitFor.GPU_DIAL_ANY, waitFor.WAIT_FOR_ANY);
});

check('turning it and reading it back is the whole round trip', () => {
  const store = fresh();
  assert.strictEqual(store.set('M1 Ultra', KNOWN), 'M1 Ultra');
  assert.strictEqual(store.read(), 'M1 Ultra');
  assert.strictEqual(store.set('any', KNOWN), 'any');
  assert.strictEqual(store.read(), 'any');
});

check('a server this machine does not have is refused BY NAME', () => {
  const err = refuses(() => fresh().set('Threadripper', KNOWN), 'unknown_server');
  assert.match(err.message, /Threadripper/);
  assert.match(err.message, /3090 Ti, M1 Ultra/, 'and the refusal lists what there is');
});

check('a DISABLED server is accepted — the parked row says so in its own words', () => {
  // The enable switch is standing state about hardware; refusing here would make
  // the operator resolve the dial and the switch in one particular order for no
  // reason, and `holdDisabled` already names the switch and where to flip it.
  const store = fresh();
  assert.strictEqual(store.set('M1 Ultra', KNOWN), 'M1 Ultra');
  const verdict = waitFor.decideWaitFor({
    waitFor: 'any',
    resolved: undefined,
    ranked: [{ name: '3090 Ti', enabled: true }, { name: 'M1 Ultra', enabled: false }],
    dial: store.read(),
    state: () => ({ kind: 'ready' }),
    gpuSlotTaken: () => null,
  });
  assert.strictEqual(verdict.kind, 'hold');
  assert.match(verdict.sentence, /M1 Ultra: disabled/);
});

check('a record that is not JSON is REFUSED, never replaced', () => {
  const store = fresh('{ not json');
  const err = refuses(() => store.read(), 'corrupt_gpu_dial');
  assert.match(err.message, /repair or delete the file by hand/i);
});

check('a record whose `dial` is the wrong shape is refused the same way', () => {
  refuses(() => fresh({ dial: 3 }).read(), 'corrupt_gpu_dial');
  refuses(() => fresh({ dial: '' }).read(), 'corrupt_gpu_dial');
  refuses(() => fresh({}).read(), 'corrupt_gpu_dial');
});

check('a name the registry no longer has is KEPT and honoured, never pruned', () => {
  // `routing.ts`'s argument about a removed machine's rank, applied here: the
  // record is the operator's, and turning their dial back to `any` because a
  // server was renamed would start sending books to cards they had steered away
  // from with nothing saying so. The hold NAMES the missing machine.
  const store = fresh({ dial: 'Retired box' });
  assert.strictEqual(store.read(), 'Retired box');
  const verdict = waitFor.decideWaitFor({
    waitFor: 'any',
    resolved: undefined,
    ranked: [{ name: '3090 Ti', enabled: true }],
    dial: store.read(),
    state: () => ({ kind: 'ready' }),
    gpuSlotTaken: () => null,
  });
  assert.strictEqual(verdict.kind, 'hold');
  assert.match(verdict.sentence, /Retired box: it is not one of this machine's Crucible servers/);
});

check('the record is its OWN file — turning the dial rewrites no preference', () => {
  // The whole reason it is not a key in crucible-routing.json: that file holds
  // the ranks and the enable switches, and a half-written one loses every
  // preference at once. This is a lever somebody flicks three times an evening.
  assert.ok(dial.gpuDialPath.toString().includes('queue-gpu-dial.json'));
});

// ── The bench, grouped ──────────────────────────────────────────────────────

function snapOf(sets, jobs = []) {
  return { jobs, running: true, slotSets: sets, gpuDial: 'any' };
}

const SERVER_SET = (id) => ({ id, label: id, gpu: 1, cpu: 0, retiring: false });
const LOCAL_WORK = {
  id: slotSets.LOCAL_WORK_SET, label: 'CPU slots', gpu: 0, cpu: 2, retiring: false, disabled: false,
};

check('two sections: the engines\' cards first, then what BookForge does itself', () => {
  const sections = bench.benchSections(snapOf([SERVER_SET('3090 Ti'), SERVER_SET('M1 Ultra'), LOCAL_WORK]));
  assert.deepStrictEqual(sections.map((s) => s.group), ['gpu', 'cpu']);
  assert.match(sections[0].heading, /^GPU — the Crucible engines$/);
  assert.match(sections[1].heading, /^CPU slots$/);
  assert.strictEqual(sections[0].lanes.length, 2, 'one card per engine');
  assert.deepStrictEqual(sections[0].lanes.map((l) => l.setId), ['3090 Ti', 'M1 Ultra']);
  assert.strictEqual(sections[1].lanes.length, 2, 'local-work\'s two CPU slots');
});

check('an EMPTY section is not drawn — a heading with nothing under it is worse', () => {
  // A machine with no Crucible server registered has no GPU row at all (Owen:
  // "without a crucible server, there is no gpu slot").
  const sections = bench.benchSections(snapOf([LOCAL_WORK]));
  assert.deepStrictEqual(sections.map((s) => s.group), ['cpu']);
});

check('the in-app aligner is filed by its RESOURCE, so it lands with the cards', () => {
  const aligner = {
    id: slotSets.LONGFORM_ALIGN_SET, label: 'the local long-form aligner',
    gpu: 1, cpu: 0, retiring: false,
  };
  const sections = bench.benchSections(snapOf([SERVER_SET('3090 Ti'), aligner, LOCAL_WORK]));
  const gpu = sections.find((s) => s.group === 'gpu');
  assert.deepStrictEqual(gpu.lanes.map((l) => l.setId), ['3090 Ti', slotSets.LONGFORM_ALIGN_SET]);
});

check('a cloud lane is neither section — it holds no card and is not BookForge', () => {
  // "CPU slots" would be a heading that lies about what is in it:
  // the work is on somebody's API and the engine is only forwarding it.
  const lane = {
    id: slotSets.cloudLaneOf('3090 Ti'), label: '3090 Ti — routed elsewhere',
    gpu: 0, cpu: 2, retiring: false,
  };
  const sections = bench.benchSections(snapOf([SERVER_SET('3090 Ti'), lane, LOCAL_WORK]));
  assert.deepStrictEqual(sections.map((s) => s.group), ['gpu', 'cpu', 'cloud']);
  const cpu = sections.find((s) => s.group === 'cpu');
  assert.deepStrictEqual(new Set(cpu.lanes.map((l) => l.setId)), new Set([slotSets.LOCAL_WORK_SET]),
    'the local section holds local-work and nothing else');
  const cloud = sections.find((s) => s.group === 'cloud');
  assert.deepStrictEqual(new Set(cloud.lanes.map((l) => l.setId)), new Set([lane.id]));
});

check('a section counts only its OWN lanes as in use', () => {
  const step = {
    id: 's1', type: 'tts-conversion', label: 'Narrate', config: {}, parentStepId: 'source',
    resource: 'gpu', travels: true, venue: '3090 Ti', status: 'running',
    progress: {}, metrics: {}, addedAt: '2026-09-15T00:00:00.000Z',
  };
  const job = { id: 'j1', title: 'Mistborn', steps: [step], createdAt: '2026-09-15T00:00:00.000Z' };
  const sections = bench.benchSections(snapOf([SERVER_SET('3090 Ti'), LOCAL_WORK], [job]));
  assert.strictEqual(sections.find((s) => s.group === 'gpu').inUse, 1);
  assert.strictEqual(sections.find((s) => s.group === 'cpu').inUse, 0);
});

// ── Pending and the live queue partition the runs ───────────────────────────

function narrationJob(id, title, pending) {
  return {
    id,
    title,
    ...(pending ? { pending: true } : {}),
    waitFor: 'any',
    createdAt: '2026-09-15T00:00:00.000Z',
    steps: [{
      id: `${id}_s`, type: 'tts-conversion', label: 'Narrate', config: {},
      parentStepId: 'source', resource: 'gpu', travels: true, status: 'held',
      progress: {}, metrics: {}, addedAt: '2026-09-15T00:00:00.000Z',
    }],
  };
}

check('a staged book is in Pending and NOWHERE else', () => {
  const snap = snapOf([SERVER_SET('3090 Ti'), LOCAL_WORK], [
    narrationJob('j_staged', 'Staged', true),
    narrationJob('j_live', 'Live', false),
  ]);
  assert.deepStrictEqual(bench.pendingPlans(snap).map((p) => p.title), ['Staged']);
  assert.deepStrictEqual(bench.bookPlans(snap).map((p) => p.title), ['Live']);
  assert.deepStrictEqual(bench.upNext(snap).map((r) => r.title), ['Live'],
    'the tray\'s flat list is the live queue — a staged book is not up next');
});

check('a pending row says PENDING, not "you haven\'t started it"', () => {
  // `held` invites a press that `release` refuses by name. Two states, two
  // sentences, two gestures.
  const snap = snapOf([SERVER_SET('3090 Ti'), LOCAL_WORK], [narrationJob('j_p', 'Staged', true)]);
  const plan = bench.pendingPlans(snap)[0];
  assert.strictEqual(plan.steps[0].reason.kind, 'pending');
  assert.strictEqual(plan.steps[0].reason.sentence, 'Pending — not sent to the queue yet.');
  assert.strictEqual(plan.travels, true, 'so the picker is always drawn in this band');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nqueue gpu dial + bench sections: ${ran} check(s), exit ${process.exitCode || 0}`);
