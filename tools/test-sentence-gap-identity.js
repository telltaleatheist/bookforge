#!/usr/bin/env node
/**
 * A DERIVED SET'S NAME DID NOT MOVE WHEN THE ORPHEUS GAP PASS LEFT (step 8, 2026-11-05).
 *
 * Every denoised or converted sentence set is filed under its params, and
 * `sentenceGapParams` is part of them. Before step 8, `planSentenceGap` answered a Higgs
 * session with no gap pass and `{gapSeconds: null, minGapSeconds: 0}`, voice null, MEASURED on
 * the compiled code before the change, for a Higgs session voiced `deathstalker` (a name the
 * retired Orpheus roster also carries, with a 0.55 s floor) and for one voiced `sigma` (a name it
 * does not). Those exact values are pinned here, so a Higgs set made before step 8 is still found
 * after it.
 *
 * An Orpheus session is now refused by name: its denoise or conversion depended on the gap pass,
 * and running it without one would be a quietly different output.
 *
 *   node tools/test-sentence-gap-identity.js        (after npx tsc -p tsconfig.electron.json)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return resolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir(), getAppPath: () => REPO, isPackaged: false, on() {} },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {},
  },
};
const gap = require(path.join(REPO, 'dist', 'electron', 'sentence-gap.js'));

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, null]); } catch (err) { results.push([name, err]); }
}

function session(root, name, settings) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session_state.json'), JSON.stringify({ settings }));
  return dir;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-identity-'));
  try {
    for (const voice of ['deathstalker', 'sigma']) {
      await check(`a Higgs ${voice} session keeps the params its sets were filed under`, async () => {
        const plan = await gap.planSentenceGap(session(root, `higgs-${voice}`, { ttsEngine: 'higgs', fineTuned: voice }));
        assert.strictEqual(JSON.stringify(gap.sentenceGapParams(plan)), '{"gapSeconds":null,"minGapSeconds":0}');
        assert.strictEqual(plan.voice, null);
        assert.strictEqual(plan.gapSeconds, undefined, 'no gap pass runs');
      });
    }
    await check('a session with no provenance plans no gap, as before', async () => {
      const plan = await gap.planSentenceGap(path.join(root, 'nothing-here'));
      assert.strictEqual(JSON.stringify(gap.sentenceGapParams(plan)), '{"gapSeconds":null,"minGapSeconds":0}');
    });
    await check('an Orpheus session is refused by name', async () => {
      await assert.rejects(gap.planSentenceGap(session(root, 'orpheus', { ttsEngine: 'orpheus', fineTuned: 'deathstalker' })),
        /rendered by Orpheus, which is retired.*not ported.*finished audiobook is untouched/s);
    });
    await check('nothing in the app applies a sentence gap any more', async () => {
      for (const gone of ['electron/chapter-closer.ts', 'electron/orpheus-assembly-tuning.ts', 'electron/scripts/normalize_gaps.py']) {
        assert.ok(!fs.existsSync(path.join(REPO, gone)), `${gone} is back`);
      }
      const bridge = fs.readFileSync(path.join(REPO, 'electron', 'denoise-bridge.ts'), 'utf8');
      assert.ok(!/normalizeSentenceGaps|normalize_gaps/.test(bridge), 'denoise-bridge spawns the gap normalizer again');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  let failed = 0;
  for (const [name, err] of results) {
    if (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${String(err.message).slice(0, 600)}`); } else console.log(`  ok    ${name}`);
  }
  console.log(`\nsentence-gap identity: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
