#!/usr/bin/env node
/**
 * Keeper: a book's whole run is listed in the queue — done, running, to do — and the
 * running step names its work (Owen, 2026-11-06).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-run-ladder.js
 *
 * Owen: *"i expected there to be progress bars and a list of done/to do items for this
 * book. like i had triage/cleanup, tts, assembly, etc listed for this one book. but its
 * showing at best one progress bar and sometimes no progress bars at all for this job.
 * and its not even telling me which step its on."* It showed everything once TTS ran,
 * and nothing like it during the triage and the cleanup.
 *
 * The run here is the one he was watching (88 Reasons): triage, cleanup, the EPUB, then
 * the narration's four steps, all one queue job. It is driven through the bench's own
 * functions at each phase, and the surfaces are held to drawing what those return:
 *
 *   1. Every step is on the ladder in chain order, finished ones included.
 *   2. The running step carries its percent when it measured one, null when it did not,
 *      and always its own words for what it is doing when it has said anything.
 *   3. The running Foundry step (triage, cleanup) is a lane occupant on its server, and
 *      that lane's ladder is the book's ladder.
 *   4. The tray's card and the queue page's book card draw `plan.ladder`, and the tray
 *      opens a running book's card without a click.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const D = path.join(REPO, 'dist', 'shared', 'queue');
if (!fs.existsSync(path.join(D, 'bench.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const bench = require(path.join(D, 'bench.js'));
const slots = require(path.join(D, 'slot-sets.js'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); } catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

const SERVER = 'crucible@owens-pc-wsl';
const LABELS = ['Clean text — triage', 'Clean text', 'Make the EPUB', 'Prepare', 'TTS', 'Align', 'Assembly'];

/** The run at one phase: `at` is the index of the running step; before it is done, after it waits. */
function run(at, progress) {
  const shape = [
    { type: 'foundry-job', resource: 'gpu', venue: SERVER, travels: true },
    { type: 'foundry-job', resource: 'gpu', venue: SERVER, travels: true },
    { type: 'foundry-export-landing', resource: 'wait', travels: false },
    { type: 'prepare', resource: 'cpu', travels: false },
    { type: 'tts-conversion', resource: 'gpu', travels: true },
    { type: 'align', resource: 'gpu', travels: true },
    { type: 'reassembly', resource: 'cpu', travels: false },
  ];
  const steps = shape.map((s, i) => ({
    id: `step_${i}`, label: LABELS[i], config: {}, metrics: {}, addedAt: '2026-11-06T16:40:00.000Z',
    parentStepId: i === 0 ? 'source' : `step_${i - 1}`,
    ...s,
    status: i < at ? 'done' : i === at ? 'running' : 'waiting',
    progress: i < at ? { percent: 100 } : i === at ? progress : {},
  }));
  return { id: 'job_88', title: '88 Reasons', projectId: 'Z:/projects/88-reasons', steps,
    createdAt: '2026-11-06T16:40:00.000Z', waitFor: SERVER, waitForResolved: SERVER };
}

function snap(jobs) {
  const occupied = [];
  for (const j of jobs) for (const s of j.steps) {
    if (s.status !== 'running') continue;
    const id = slots.slotSetForStep(j, s);
    if (id !== null && !occupied.includes(id)) occupied.push(id);
  }
  return {
    jobs, running: true, servers: [],
    slotSets: slots.slotSets({
      rankedServers: [{ name: SERVER, enabled: true }], upstreams: { [SERVER]: 'unknown' }, roles: { [SERVER]: 'engine' },
      occupied, alignerCharged: slots.longformAlignCharged({ jobs }),
    }),
  };
}

const PHASES = [
  { name: 'triage, before it measures anything', at: 0, progress: { message: 'clean-triage: reading 1084 positions', foundryPhase: 'triage' },
    percent: null, doing: 'clean-triage: reading 1084 positions' },
  { name: 'the cleanup, 30% in', at: 1, progress: { percent: 30, message: 'clean-text: 264/873', foundryPhase: 'clean' },
    percent: 30, doing: 'clean-text: 264/873' },
  { name: 'the EPUB landing, which says nothing', at: 2, progress: {}, percent: null, doing: null },
  { name: 'TTS, loading the voice', at: 4, progress: { percent: 0, message: 'Loading voice model…' }, percent: 0, doing: 'Loading voice model…' },
];

for (const phase of PHASES) {
  check(`${phase.name}: every step listed, done and to do, with the running one's bar and words`, () => {
    const snapshot = snap([run(phase.at, phase.progress)]);
    const [plan] = bench.bookPlans(snapshot);
    assert.ok(plan !== undefined, 'the running book has no card');
    assert.deepStrictEqual(plan.ladder.map((r) => r.label), LABELS, 'the ladder is not the whole chain in order');
    plan.ladder.forEach((rung, i) => {
      const want = i < phase.at ? 'done' : i === phase.at ? 'running' : 'waiting';
      assert.strictEqual(rung.status, want, `${rung.label} reads ${rung.status}, not ${want}`);
      if (i !== phase.at) assert.strictEqual(rung.doing, null, `${rung.label} says it is doing something while ${rung.status}`);
    });
    const now = plan.ladder[phase.at];
    assert.strictEqual(now.percent, phase.percent, 'the running step\'s percent');
    assert.strictEqual(now.doing, phase.doing, 'the running step\'s own words');
    assert.deepStrictEqual(bench.runLadder(snapshot, plan.jobIds), plan.ladder, 'the lane and the card would read two ladders');
    // The schedulable list still leaves the finished steps out; it is the ladder that shows them.
    assert.strictEqual(plan.steps.length, LABELS.length - phase.at, 'plan.steps changed meaning');
  });
}

check('the running triage and cleanup are on their server\'s GPU lane, named', () => {
  for (const at of [0, 1]) {
    const snapshot = snap([run(at, { percent: at === 0 ? undefined : 30, message: 'x' })]);
    const lane = bench.benchLanes(snapshot).find((l) => l.occupant !== null && l.occupant.stepId === `step_${at}`);
    assert.ok(lane !== undefined, `${LABELS[at]} is on no lane`);
    assert.strictEqual(lane.setId, SERVER, `${LABELS[at]} is on ${lane.setId}`);
    assert.strictEqual(lane.resource, 'gpu');
    assert.strictEqual(lane.occupant.label, LABELS[at], 'the lane does not name the step');
    assert.strictEqual(lane.occupant.jobId, 'job_88');
  }
});

check('the tray and the page draw the ladder, and the tray opens a running book', () => {
  const tray = read('src/app/features/queue/components/queue-tray/queue-tray.component.ts');
  assert.ok(tray.includes('@for (rung of plan.ladder; track rung.stepId)'), 'the tray card no longer draws plan.ladder');
  assert.ok(tray.includes('@if (rung.doing; as doing)'), 'the tray card no longer says what the running step is doing');
  assert.ok(/@if \(isOpen\(plan\)\) \{/.test(tray), 'the tray card opens on something other than isOpen');
  assert.ok(/isOpen\(plan: BookPlanView\): boolean \{\n\s*if \(this\.chosen\(\)\) return this\.openKey\(\) === plan\.key;\n\s*return plan\.ladder\.some\(\(rung\) => rung\.status === 'running'\);/.test(tray),
    'a running book\'s card is not open by default');
  const page = read('src/app/features/queue/queue.component.ts');
  assert.ok(page.includes('@for (rung of plan.ladder; track rung.stepId)'), 'the page\'s book card no longer draws plan.ladder');
  assert.ok(page.includes('return runLadder(this.queueService.snapshot(), [jobId]).map('), 'the lane ladder no longer reads runLadder');
  assert.ok(page.includes('<div class="rdoing" [title]="doing">{{ doing }}</div>'), 'the lane ladder no longer says what the step is doing');
  assert.ok(page.includes('<div class="cdoing" [title]="doing">{{ doing }}</div>'), 'the book card no longer says what the step is doing');
});

console.log(failed === 0 ? '\nqueue run ladder: all checks passed' : `\nqueue run ladder: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
