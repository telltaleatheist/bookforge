#!/usr/bin/env node
/**
 * Keeper: the book window's tiles on a scan, before and after OCR (Owen, 2026-11-06).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-tile-gates.js
 *
 * Owen, on a bare PDF: *"bookforge has three enabled tiles: OCR (correct), narrate,
 * and pronunciation guide. pronunciation guide is part of ai cleanup. it shouldnt have
 * its own tile ... narrate shouldnt be enabled yet - theres nothing to narrate... we
 * can narrate once OCR has run, but higgs cant read a pdf."*
 *
 * The project records here are real: made by foundry-core's own `summarise` and
 * `recordReading` over a temp library, so the states are the ones the window draws.
 *
 *   1. A bare PDF: Narrate is grey, and its press would refuse ('a-scan').
 *   2. A catalogue that says "read" over a ledger holding only the scan (88 Reasons,
 *      the book Owen was testing): still grey. The old gray read the catalogue alone
 *      and lit here, over a press that refused.
 *   3. Right after OCR lands: lit, the press names the reading's step, and the EPUB
 *      the Narrate door asks Foundry for (`exportEpubFromStep` → `identifyExport`) is
 *      made from that reading's bank.
 *   4. The guide has no tile on any row, and its door stays registered for the tree's
 *      guide row and the cleanup modal's "Review it".
 *   5. A cleanup pressed from the Clean tile on a step with no guide builds the guide
 *      first by default.
 *
 * What it cannot prove without a window: that the Narrate overlay draws. The door from
 * the press to `exportEpubFromStep` is code this keeper reads, not runs.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..');
const { NODE_DIST, SHARED_DIST } = require('./foundry-core-lib.js');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-tile-gates-'));
const USER_DATA = path.join(SCRATCH, 'userData');
const LIBRARY = path.join(SCRATCH, 'library');
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(path.join(LIBRARY, 'projects'), { recursive: true });
// electron/update/managed-bins.js resolves userData at load, outside Electron.
process.env.BOOKFORGE_USERDATA_DIR = USER_DATA;
fs.writeFileSync(path.join(USER_DATA, 'app-settings.json'), JSON.stringify({ libraryDir: LIBRARY }));

require(path.join(NODE_DIST, 'platform.js')).setPlatform({
  userDataDir: () => USER_DATA,
  tempDir: () => path.join(SCRATCH, 'temp'),
  broadcast: () => {},
  image: {
    createFromPath: () => { throw new Error('no image codec in this keeper'); },
    createFromBuffer: () => { throw new Error('no image codec in this keeper'); },
  },
});
const { summarise } = require(path.join(NODE_DIST, 'projects-list.js'));
const { recordReading } = require(path.join(NODE_DIST, 'projects-landing.js'));
const { identifyExport } = require(path.join(NODE_DIST, 'workspace-export.js'));
const { hostActAimFrom } = require(path.join(SHARED_DIST, 'stages.js'));
const { ledgerOf } = require(path.join(NODE_DIST, 'projects-steps.js'));
const { offeredFrom } = require(path.join(SHARED_DIST, 'host-ops.js'));
const { originalOf } = require(path.join(SHARED_DIST, 'original.js'));

/** The window's own gray, compiled from its source so this keeper asks the function the tile asks. */
function loadHostActLit() {
  const source = read('foundry-app/src/app/components/action-menu/action-menu.host-act.ts');
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const mod = { exports: {} };
  const local = (name) => require(name.replace('@owen/foundry-core/shared/', `${SHARED_DIST}/`));
  new Function('require', 'module', 'exports', out.outputText)(local, mod, mod.exports);
  return mod.exports.hostActLit;
}
const hostActLit = loadHostActLit();

let failed = 0;
const pending = [];
const check = (name, fn) => pending.push({ name, fn });

const KEY = 'Tile-Gate-Book-0000aaaa';
const PDF = 'Tile Gate Book. Tester, T. (2026).pdf';

/** A scan project as an import leaves it: the archive, the working copy, one ledger step. */
function bareProject(name) {
  const dir = path.join(LIBRARY, 'projects', name);
  for (const sub of ['archive', 'working', 'readings', 'final', 'derived', 'ops']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive', PDF), '%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(dir, 'working', PDF), '%PDF-1.4\n%%EOF\n');
  const importId = '11111111-1111-4111-8111-111111111111';
  const manifest = {
    version: 2, key: KEY, title: 'Tile Gate Book', stem: 'Tile Gate Book', createdAt: 1, openedAt: 1,
    archive: { file: PDF, kind: 'pdf', contentKey: '0000aaaa' },
    documents: [{ kind: 'pdf', steps: [{ file: `archive/${PDF}`, kind: 'origin', label: 'The scan you imported',
      appliedAt: 1, retention: 'irreplaceable', why: 'the only copy' }] }],
    working: { files: [{ file: PDF, kind: 'pdf', from: `archive/${PDF}`, madeAt: 1 }] },
    final: [],
    reading: null,
    ledger: { position: importId, steps: [{ id: importId, action: 'import', parent: null,
      payload: `archive/${PDF}`, retention: 'irreplaceable', label: 'The scan you imported', createdAt: 1 }] },
  };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** What the dock gathers, from the records alone: nothing finished, nothing promised, nothing on screen. */
async function dockOf(dir) {
  const project = await summarise(dir, path.basename(dir));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const ledger = ledgerOf(manifest);
  const standing = ledger.steps.find((s) => s.id === ledger.position) ?? null;
  const aim = hostActAimFrom({ promised: null, finished: [], viewing: null, standing, ledger });
  return { project, ledger, standing, aim, lit: hostActLit(project, aim) };
}

check('a bare PDF: Narrate is grey, and a press would only refuse', async () => {
  const dock = await dockOf(bareProject('bare'));
  assert.strictEqual(dock.project.reading.done, false, 'the fixture is not a bare scan');
  assert.strictEqual(dock.project.reading.needed, true, 'OCR is not the act a bare scan is waiting on');
  assert.deepStrictEqual(dock.aim, { kind: 'refuse', why: 'a-scan' });
  assert.strictEqual(dock.lit, false, 'Narrate is lit on a bare PDF');
});

check('a catalogue that says read over a scan-only ledger stays grey (the 88 Reasons state)', async () => {
  const dir = bareProject('catalogue-only');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  manifest.reading = { generation: 'g-old', readAt: 5, pages: 3, completedAt: 5 };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(manifest, null, 2));
  const dock = await dockOf(dir);
  assert.strictEqual(dock.project.reading.done, true, 'the fixture does not reproduce the catalogue');
  assert.strictEqual(dock.aim.kind, 'refuse', 'the press no longer refuses here');
  assert.strictEqual(dock.lit, false, 'Narrate is lit over a press that refuses');
});

check('right after OCR: lit, the press names the reading, and the EPUB is made from its bank', async () => {
  const dir = bareProject('after-ocr');
  const bank = path.join(dir, 'readings', `${KEY}.jsonl`);
  fs.writeFileSync(bank, `${JSON.stringify({ page: 1, blocks: [{ text: 'The words on page one.' }] })}\n`);
  // What the engine leaves beside a bank it finished; without it the export refuses an interrupted reading.
  fs.writeFileSync(path.join(dir, 'readings', `${KEY}.completed.json`),
    JSON.stringify({ completedAt: new Date().toISOString(), outPath: null, pages: 1, language: 'en' }));
  await recordReading(bank, {});
  const dock = await dockOf(dir);
  const reading = dock.ledger.steps.find((s) => s.action === 'read');
  assert.ok(reading !== undefined, 'recordReading wrote no read step');
  assert.strictEqual(dock.standing.id, reading.id, 'the pointer does not stand on the reading OCR just landed');
  assert.deepStrictEqual(dock.aim, { kind: 'node', nodeId: reading.id }, 'the press does not name the reading');
  assert.strictEqual(dock.lit, true, 'Narrate is grey after OCR');
  // The Narrate door hands that id to `exportEpubFromStep`, which plans through `identifyExport`.
  const original = originalOf(dock.project.documents);
  const plan = await identifyExport(original.path, 'epub', reading);
  assert.strictEqual(path.resolve(plan.readingsPath), path.resolve(bank), 'the EPUB would not be made from this reading');
});

check('the tile reads the gray this keeper asks, over the aim the press sends', () => {
  const menu = read('foundry-app/src/app/components/action-menu/action-menu.component.ts');
  assert.ok(menu.includes('return hostActLit(project, acts.hostActAim.call(this, dir));'), 'hostReady no longer asks hostActLit');
  const acts = read('foundry-app/src/app/components/action-menu/action-menu.acts.ts');
  assert.ok(acts.includes('const aim = hostActAim.call(this, dir);'), 'the press no longer reads the gather the gray reads');
});

check('the guide is on no row, and its door stays for the tree row and "Review it"', () => {
  const main = read('electron/main.ts');
  const table = main.slice(main.indexOf('const FOUNDRY_HOST_OPERATIONS'), main.indexOf('/** The project\'s manifest, as far as the guide needs it. */'));
  const offers = [...table.matchAll(/id: '(bookforge\.[a-z]+)'[\s\S]*?\n    appliesTo: ([^\n]+),\n/g)]
    .map(([, id, expr]) => ({ id, appliesTo: JSON.parse(expr.replace(/'/g, '"')) }));
  assert.deepStrictEqual(offers.map((o) => o.id), ['bookforge.narrate', 'bookforge.enhance', 'bookforge.assemble', 'bookforge.guide']);
  for (const produces of ['book', 'export', 'audio']) {
    assert.ok(!offeredFrom(offers, produces).some((o) => o.id === 'bookforge.guide'), `the guide is offered from a ${produces} row`);
  }
  assert.ok(offeredFrom(offers, 'book').some((o) => o.id === 'bookforge.narrate'), 'Narrate left the book rows');
  assert.ok(/invoke: \(projectDir, nodeId\) => openPronunciationGuide\(projectDir, nodeId\)/.test(table), 'the guide door is gone');
  const nodes = read('electron/pronunciation-guide-nodes.ts');
  assert.ok(/opens: GUIDE_OPERATION_ID/.test(nodes), 'the tree\'s guide row no longer opens the guide');
  const offer = read('electron/pronunciation-offer.ts');
  assert.ok(/review: \{ label: 'Review it', operationId: GUIDE_OPERATION_ID, nodeId: step \}/.test(offer), '"Review it" is gone');
});

check('a cleanup from the Clean tile on a step with no guide builds the guide first', () => {
  const dir = bareProject('clean-guide');
  const { guidePassOffer } = require(path.join(REPO, 'dist', 'electron', 'pronunciation-offer.js'));
  const offer = guidePassOffer(dir, 'step-without-guide', null);
  assert.strictEqual(offer.chosen, 'guide-build', 'the modal no longer builds the guide by default');
  assert.deepStrictEqual(offer.choices.find((c) => c.id === offer.chosen).queues, ['Build the pronunciation guide']);
  // The dialog sends the lit choice, and the host queue chains the cleanup under a guide row for it.
  const dialog = read('foundry-app/src/app/components/clean-dialog/clean-dialog.component.ts');
  assert.ok(/\.\.\.\(this\.offer\(\) !== null && this\.chosen\(\)\.length > 0 \? \{ hostChoice: this\.chosen\(\) \} : \{\}\)/.test(dialog),
    'the Clean dialog no longer sends the host\'s choice');
  const queue = read('electron/foundry-host-queue.ts');
  assert.ok(/hostChoice === GUIDE_CHOICE\.build \|\| hostChoice === GUIDE_CHOICE\.rebuild/.test(queue)
    && /const ahead = guideAhead\(projectDir, at, hostChoice === GUIDE_CHOICE\.rebuild\);/.test(queue),
  'the host queue no longer puts a guide row ahead of the cleanup');
  // And a cleanup with no choice on it (no modal answer) still builds one inside itself.
  const job = read('electron/queue-steps/foundry-job.ts');
  assert.ok(/} else if \(isCleanup && !noGuide\) \{[\s\S]*?ensureNarrationGlossary\(/.test(job), 'a cleanup no longer builds a missing guide');
});

(async () => {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}`);
    }
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(failed === 0 ? '\nbook tile gates: all checks passed' : `\nbook tile gates: ${failed} check(s) failed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
