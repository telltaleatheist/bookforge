#!/usr/bin/env node
/**
 * test-queue-bench-sections.js — the bench's grouping, and the Pending / live
 * partition.
 *
 *   • **The bench's grouping** — `benchSections` in `shared/queue/bench.ts`.
 *     Owen, 2026-09-15: *"maybe we should have a local cpu slot section and a
 *     gpu slot section. they look kind of ugly clustered together randomly."*
 *     Sections in a fixed order, an empty one never drawn, and the aligner row
 *     filed by its RESOURCE.
 *
 *   • **The Pending band's own shape** (`pendingPlans` / `bookPlans` /
 *     `upNext`), because the two bands must partition the live runs exactly and
 *     neither may show the other's.
 *
 * ── Why the name changed ────────────────────────────────────────────────────
 *
 * This was `tools/test-queue-gpu-dial.js`, whose first third drove the
 * queue-wide GPU dial's own record. The dial is GONE (Owen, 2026-09-19: *"that
 * works for me"*) and so is `electron/crucible/gpu-dial.ts`; these two halves
 * never had anything to do with it and are not dropped along with it. Which
 * lanes are DOWN is `test-queue-bench`'s subject, not this one's; the per-row
 * routing decision is `test-queue-wait-for`'s.
 *
 * Build first: `npx tsc -p tsconfig.electron.json`.
 * Run:  node tools/test-queue-bench-sections.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const bench = require(path.join(REPO, 'dist', 'shared', 'queue', 'bench.js'));
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

// ── The bench, grouped ──────────────────────────────────────────────────────

function snapOf(sets, jobs = []) {
  // `servers: []` — no machine has been asked whether it answers, so no lane is
  // `down`. Which lanes are DOWN is `test-queue-bench`'s subject, not this one's.
  return { jobs, running: true, slotSets: sets, servers: [] };
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

console.log(`\nqueue bench sections + pending band: ${ran} check(s), exit ${process.exitCode || 0}`);
