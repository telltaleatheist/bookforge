#!/usr/bin/env node
/**
 * Keeper: a finished audiobook stays on Foundry's tree, under the node it was rendered
 * from (Owen, 2026-11-07).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-audiobook-tree-rows.js
 *
 * Owen: *"i think we should add the rendered book as a line item in the worktree on
 * foundry/bookforge, so the user can see that an audiobook was rendered from a specific
 * item."* A run's rows left the tree with the run; nothing recorded where the audiobook
 * came from. Held here, on a temp library and a temp Foundry project:
 *
 *   1. A Foundry press stamps the node it was made on onto the run's audio steps, and
 *      only those (shared/queue/narration-run.ts), and the live rows hang there even in
 *      a run with no Foundry lineage of its own.
 *   2. A finished render, written down, draws one row under its parent: the voice, the
 *      file and the date.
 *   3. A cleared queue still shows it; while the run is in the queue, its live rows win
 *      and the audiobook is not drawn twice.
 *   4. A re-render of the same node replaces its row; a deleted m4b drops it; a file
 *      outside the library is refused by name.
 *   5. Main writes the record when an assembly finishes and the press sends the parent.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const E = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(E, 'audiobook-render-nodes.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const rows = require(path.join(E, 'audiobook-render-nodes.js'));
const hostNodes = require(path.join(E, 'foundry-host-nodes.js'));
const { buildNarrationSteps } = require(path.join(REPO, 'dist', 'shared', 'queue', 'narration-run.js'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ── The temp library and Foundry project ────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-audiobook-rows-'));
const LIBRARY = path.join(TMP, 'library');
const PROJECT = path.join(LIBRARY, 'foundry', 'projects', 'Fuhrer-d3f7');
const BOOK_OUT = path.join(LIBRARY, 'projects', 'Fuhrer', 'output');
fs.mkdirSync(path.join(PROJECT, 'readings'), { recursive: true });
fs.mkdirSync(BOOK_OUT, { recursive: true });
fs.writeFileSync(path.join(PROJECT, 'project.json'), JSON.stringify({ key: 'Fuhrer-d3f7', ledger: { steps: [] } }));
const M4B = path.join(BOOK_OUT, 'Working Towards The Fuhrer.m4b');
fs.writeFileSync(M4B, 'm4b');
const PARENT = 'step_clean_7';
const FINISHED = '2026-11-07T22:40:00.000Z';

const BOOK = {
  epubPath: 'E:/lib/projects/Fuhrer/exports/book.epub', projectDir: 'E:/lib/projects/Fuhrer', variantId: 'v-1',
  title: 'Working Towards The Fuhrer', author: 'Ian Kershaw', year: '1993', coverPath: '',
  outputFilename: 'Working Towards The Fuhrer.m4b', isArticle: false,
};
const SETTINGS = {
  language: 'en', textCleanup: 'required', ttsEngine: 'higgs', voice: 'third-reich', device: 'gpu',
  temperature: 0.6, topP: 0.9, repetitionPenalty: 1.1, speed: 1, workers: 1, outputDir: 'E:/audiobooks',
  finalDenoise: false, enhancementOrder: 'denoise-first', applyDeRing: false, rvc: null, startFresh: false,
};

/** A queued narration run as the engine holds it: the plan's steps, with no job lineage. */
function narrationJob(status) {
  const plan = buildNarrationSteps({ ...BOOK, treeParent: { projectDir: PROJECT, parentStepId: PARENT } }, SETTINGS,
    { narrate: true, enhance: false, assemble: true });
  return {
    id: 'job_n1', title: 'Working Towards The Fuhrer', createdAt: FINISHED,
    steps: plan.map((p, i) => ({
      id: `step_n${i}`, type: p.type, label: p.type, config: { ...p.config }, metrics: {}, addedAt: FINISHED,
      parentStepId: i === 0 ? 'source' : `step_n${i - 1}`, resource: 'cpu', travels: false,
      status, progress: {}, ...(status === 'done' && p.type === 'reassembly' ? { outputPath: M4B } : {}),
    })),
  };
}

/** What `publishHostNodes` pushes for the project, given a queue. */
function pushed(jobs) {
  const got = new Map();
  hostNodes.publishHostNodes({ jobs, running: false, servers: [], slotSets: [] }, (dir, nodes) => got.set(dir, nodes));
  return got.get(PROJECT) ?? null;
}

const render = (over = {}) => ({ voice: 'Third Reich', finishedAt: FINISHED, jobId: 'job_n1', stepId: 'step_n4', ...over });

check('a Foundry press stamps its node on the reading, the conversion and the assembly, and nothing else', () => {
  const plan = buildNarrationSteps({ ...BOOK, treeParent: { projectDir: PROJECT, parentStepId: PARENT } }, SETTINGS,
    { narrate: true, enhance: false, assemble: true });
  for (const step of plan) {
    const want = ['tts-conversion', 'rvc-enhancement', 'reassembly'].includes(step.type);
    assert.strictEqual(step.config.treeParent !== undefined, want, `${step.type} ${want ? 'lacks' : 'carries'} the tree parent`);
    if (want) assert.deepStrictEqual(step.config.treeParent, { projectDir: PROJECT, parentStepId: PARENT });
  }
  const bare = buildNarrationSteps(BOOK, SETTINGS, { narrate: true, enhance: false, assemble: true });
  assert.ok(bare.every((s) => s.config.treeParent === undefined), 'a press from BookForge\'s own pages got a tree parent');
});

check('the live rows hang under the pressed node, in a run with no Foundry lineage', () => {
  hostNodes.resetPushedProjects();
  const nodes = pushed([narrationJob('queued')]);
  assert.ok(nodes !== null, 'nothing was pushed for the project');
  assert.deepStrictEqual(nodes.map((n) => [n.kind, n.parentStepId]), [['narrate', PARENT], ['assemble', PARENT]]);
});

check('a finished render draws one row under its parent: voice, file, date', async () => {
  await rows.recordAudiobookRender(PROJECT, PARENT, M4B, LIBRARY, render());
  const record = JSON.parse(fs.readFileSync(path.join(PROJECT, 'readings', 'Fuhrer-d3f7.audiobooks.json'), 'utf8'));
  assert.strictEqual(record.renders[PARENT].m4b, 'projects/Fuhrer/output/Working Towards The Fuhrer.m4b', 'not library-relative');
  const nodes = rows.audiobookNodesOf(PROJECT, LIBRARY);
  assert.strictEqual(nodes.length, 1);
  const [node] = nodes;
  assert.strictEqual(node.parentStepId, PARENT);
  assert.strictEqual(node.title, 'Audiobook · Third Reich');
  assert.strictEqual(node.detail, `finished · Working Towards The Fuhrer.m4b · ${rows.renderDate(FINISHED)}`);
  assert.ok(/^\d{1,2} [A-Z][a-z]{2} 2026$/.test(rows.renderDate(FINISHED)), rows.renderDate(FINISHED));
  assert.strictEqual(node.state, 'done');
  assert.strictEqual(node.opens, undefined, 'the row offers an act');
  assert.strictEqual(hostNodes.decodeNodeId(node.id), null, 'the row reads as a queue row of ours');
});

check('a cleared queue still shows it; a run in the queue on that node draws instead, once', () => {
  hostNodes.resetPushedProjects();
  hostNodes.setDiskAudiobookNodes(PROJECT, rows.audiobookNodesOf(PROJECT, LIBRARY));
  const cleared = pushed([]);
  assert.deepStrictEqual(cleared.map((n) => n.id), [`${rows.AUDIOBOOK_NODE_PREFIX}:${PARENT}`], 'the cleared queue lost the audiobook');
  for (const status of ['running', 'done']) {
    const live = pushed([narrationJob(status)]);
    assert.ok(!live.some((n) => n.id.startsWith(`${rows.AUDIOBOOK_NODE_PREFIX}:`)), `drawn twice while the run is ${status}`);
    assert.ok(live.some((n) => n.kind === 'assemble' && n.parentStepId === PARENT), `the live row is gone while ${status}`);
  }
  const elsewhere = narrationJob('running');
  for (const s of elsewhere.steps) if (s.config.treeParent) s.config.treeParent = { projectDir: PROJECT, parentStepId: 'step_other' };
  assert.ok(pushed([elsewhere]).some((n) => n.id === `${rows.AUDIOBOOK_NODE_PREFIX}:${PARENT}`),
    'a run on ANOTHER node hid this one\'s audiobook');
});

check('a re-render of the same node replaces its row; a deleted m4b drops it', async () => {
  const second = path.join(BOOK_OUT, 'Working Towards The Fuhrer (2).m4b');
  fs.writeFileSync(second, 'm4b');
  await rows.recordAudiobookRender(PROJECT, PARENT, second, LIBRARY, render({ voice: 'Owen Audiobook' }));
  let nodes = rows.audiobookNodesOf(PROJECT, LIBRARY);
  assert.strictEqual(nodes.length, 1, 'the re-render added a row');
  assert.strictEqual(nodes[0].title, 'Audiobook · Owen Audiobook');
  assert.ok(nodes[0].detail.startsWith('finished · Working Towards The Fuhrer (2).m4b · '));
  fs.unlinkSync(second);
  nodes = rows.audiobookNodesOf(PROJECT, LIBRARY);
  assert.deepStrictEqual(nodes, [], 'a deleted m4b still draws');
});

check('a file outside the library is refused by name', async () => {
  const outside = path.join(TMP, 'elsewhere.m4b');
  await assert.rejects(rows.recordAudiobookRender(PROJECT, PARENT, outside, LIBRARY, render()), /not inside the library/);
});

check('main records an assembly that finished, and the press sends the node', () => {
  const main = read('electron/main.ts');
  assert.ok(main.includes("if (step.type === 'reassembly' && event.status === 'done') void recordFinishedAudiobook(job, step, event.outputPath);"),
    'a finished assembly is not written down');
  assert.ok(main.includes('treeParent: { projectDir, parentStepId: target.exportNodeId },'), 'the press sends no tree parent');
  assert.ok(main.includes('if (projectDir !== undefined) void refreshAudiobookNodes(projectDir);'), 'opening the book does not re-read its audiobooks');
  assert.ok(main.includes('await refreshAudiobookNodes(dir);'), 'startup does not read the audiobooks');
  assert.ok(read('src/app/app.ts').includes('[treeParent]="r.target.treeParent"'), 'the shell drops the tree parent');
  assert.ok(read('src/app/features/studio/components/narration-modal/narration-modal.component.ts')
    .includes('...(this.treeParent() === undefined ? {} : { treeParent: this.treeParent()! }),'), 'the dialog drops the tree parent');
});

(async () => {
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ok    ${name}`); } catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed === 0 ? '\naudiobook tree rows: all checks passed' : `\naudiobook tree rows: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
