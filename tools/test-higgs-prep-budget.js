#!/usr/bin/env node
/**
 * Keeper: a Higgs prep packs to the band BookForge resolves from the rendering
 * Crucible, and imports no model code to learn it (docs/REORG-PLAN.md, B1).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-higgs-prep-budget.js
 *
 * Until 2026-11-04 narrator's prep imported
 * `engine/higgs/v3_engine.py:higgs_v3_prep_budget`, which read the voice document
 * and re-derived the floor and the cap. The rule now has ONE owner —
 * `higgsPrepBudget` in `electron/higgs-models.ts` — and prep is handed its answer
 * as `--chunk_max_chars` / `--chunk_floor_chars`. This pins:
 *
 *  1. the rule, branch for branch, as narrator ran it (a band; a fine-tune with
 *     no floor refused by name; the model's own voice and a zero-shot clone at
 *     their target, else the placeholder; a floor above the cap refused);
 *  2. the placeholder equals narrator's `v3_served.MAX_CHARS` while that file
 *     is still in this repo;
 *  3. prepareSession puts the budget on the prep argv, from the venue's band;
 *  4. the host-prep probe asks for no `narrator.engine` module, and narrator's
 *     prep route imports none.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const HIGGS = path.join(REPO, 'dist', 'electron', 'higgs-models.js');
if (!fs.existsSync(HIGGS)) {
  console.log(skipLine('dist/electron/higgs-models.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-prep-budget-'));
const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      throw new Error(`test electron stub: app.getPath('${name}') is not stubbed`);
    },
    getAppPath: () => REPO,
    isPackaged: false,
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const higgs = require(HIGGS);
const narratorSpawn = require(path.join(REPO, 'dist', 'electron', 'narrator-spawn.js'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

/** A `CrucibleStatedBand` as `statedBandForDocument` hands prep one. */
function band(over) {
  return Object.assign({
    server: 'fake', voice: 'v', maxChars: 1000, ceilingChars: 800, floorChars: null,
    targetChars: null, paceCharsPerSec: 16, maxCharsPerSec: 21, minCharsPerSec: 12,
  }, over);
}
const model = (id) => higgs.resolveHiggsModel(id);
const kinds = { checkpoint: 'deathstalker', default: 'default', clips: 'zeroshot-mistborn' };

console.log('1. the rule, branch for branch');

check('the catalog still has a voice of each kind this rule distinguishes', () => {
  for (const [kind, id] of Object.entries(kinds)) assert.strictEqual(model(id).kind, kind, id);
});

check('a floor and a ceiling are packed between, for every kind', () => {
  for (const id of Object.values(kinds)) {
    assert.deepStrictEqual(higgs.higgsPrepBudget(model(id), band({ floorChars: 500, ceilingChars: 800 })),
      { floorChars: 500, capChars: 800 }, id);
  }
});

check('the live bands of 2026-11-04 (mac and the PC, GET /v1/voices) pack as they did', () => {
  // floor-ceiling as each server stated them; narrator packed exactly these.
  const live = { deathstalker: [600, 900], mistborn: [300, 600], sigma: [400, 800], thirdreich: [500, 800] };
  for (const [id, [lo, hi]] of Object.entries(live)) {
    assert.deepStrictEqual(higgs.higgsPrepBudgetArgs(model(id), band({ floorChars: lo, ceilingChars: hi })),
      ['--chunk_max_chars', String(hi), '--chunk_floor_chars', String(lo)], id);
  }
});

check('a fine-tune with no floor is refused BY NAME, never packed at the placeholder', () => {
  assert.throws(() => higgs.higgsPrepBudget(model('deathstalker'), band({ ceilingChars: 800, targetChars: 700 })),
    (e) => /fine-tune/.test(e.message) && /states no safe band/.test(e.message)
      && /deathstalker/.test(e.message) && /600-char placeholder/.test(e.message));
});

check('the model\'s own voice and a zero-shot clone with no floor pack at their TARGET, not the ceiling', () => {
  for (const id of [kinds.default, kinds.clips]) {
    assert.deepStrictEqual(higgs.higgsPrepBudget(model(id), band({ ceilingChars: 900, targetChars: 450 })),
      { floorChars: 450, capChars: 450 }, id);
  }
});

check('…and with no target either, at the placeholder', () => {
  // The PC and the Mac both state higgs-default as null-600 today: 600 either way.
  for (const id of [kinds.default, kinds.clips]) {
    assert.deepStrictEqual(higgs.higgsPrepBudget(model(id), band({ ceilingChars: 900 })),
      { floorChars: 600, capChars: 600 }, id);
  }
});

check('a stated floor at or above the ceiling is refused as not a band', () => {
  for (const floorChars of [800, 900]) {
    assert.throws(() => higgs.higgsPrepBudget(model('default'), band({ floorChars, ceilingChars: 800 })),
      /which is not a band/, String(floorChars));
  }
});

console.log('2. the placeholder has one value');

check('HIGGS_PREP_PLACEHOLDER_CHARS equals narrator v3_served.MAX_CHARS', () => {
  const served = path.join(REPO, 'python', 'narrator', 'engine', 'higgs', 'v3_served.py');
  if (!fs.existsSync(served)) return; // the engine half has left: this TS constant is the only copy
  const m = /^MAX_CHARS = (\d+)\s*$/m.exec(fs.readFileSync(served, 'utf8'));
  assert.ok(m, 'v3_served.py states no MAX_CHARS line');
  assert.strictEqual(higgs.HIGGS_PREP_PLACEHOLDER_CHARS, Number(m[1]));
});

console.log('3. prepareSession hands prep the budget');

check('the prep argv carries higgsPrepBudgetArgs of the VENUE\'s band', () => {
  const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
  const at = src.indexOf('export async function prepareSession(');
  const body = src.slice(at, src.indexOf('console.log(\'[PARALLEL-TTS] Running prep with:\'', at));
  assert.ok(at >= 0 && body.length > 0, 'prepareSession not found');
  assert.ok(/args\.push\(\.\.\.higgsPrepBudgetArgs\(higgsModel, packed\.band\)\)/.test(body),
    'prepareSession no longer puts the venue band on the prep argv');
});

console.log('4. prep imports no model code');

check('the host-prep probe imports no narrator.engine module', () => {
  assert.ok(Array.isArray(narratorSpawn.HOST_PREP_MODULES) && narratorSpawn.HOST_PREP_MODULES.length > 0);
  for (const m of narratorSpawn.HOST_PREP_MODULES) {
    assert.ok(!/^narrator\.engine(\.|$)/.test(m), `the probe still imports ${m}`);
  }
});

check('narrator\'s prep route and the packer name no engine module', () => {
  const app = fs.readFileSync(path.join(REPO, 'python', 'narrator', 'compat', 'app.py'), 'utf8');
  const route = app.slice(app.indexOf('def route_prep('), app.indexOf('\ndef ', app.indexOf('def route_prep(') + 1));
  assert.ok(!/from \.\.engine/.test(route), 'route_prep imports from narrator.engine again');
  const packer = fs.readFileSync(path.join(REPO, 'python', 'narrator', 'text', 'paragraph_packer.py'), 'utf8');
  assert.ok(!/from \.\.engine/.test(packer), 'paragraph_packer imports from narrator.engine again');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
