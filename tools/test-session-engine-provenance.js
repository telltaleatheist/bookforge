#!/usr/bin/env node
/**
 * WHICH FILE SAYS WHAT RENDERED A SESSION.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-session-engine-provenance.js
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * A process dir holds two files whose names differ by one character:
 *
 *   session-state.json   HYPHEN — narrator's own, written by EVERY prep on every
 *                        path, carrying `tts_engine`.
 *   session_state.json   UNDERSCORE — BookForge's sidecar (runs, rates, settings),
 *                        written ONLY by `savePersistentState`.
 *
 * The reassembly door's engine check read the UNDERSCORE one. The Mac's live run
 * of 2026-09-05 found what that costs: `renderRangeHeadless` — the CLI path — never
 * writes the sidecar, so a headless render that had just produced 108/108
 * sentences and 40 minutes of audio was refused at assembly with "This session
 * records no TTS engine", naming the absence of a file that was never part of the
 * record. Pre-sidecar app sessions fail the same way.
 *
 * The refusal was right and the source was wrong, which is the hardest kind of
 * bug to see in a diff: both files exist, both are called session state, and on
 * the machine it was written on the sidecar was always there.
 *
 * Fixtures on disk, because the thing under test is which FILE is read.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'reassembly-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => os.tmpdir(), isPackaged: false },
    BrowserWindow: class {},
  },
};

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok    ${name}`))
    .catch((err) => {
      failures++;
      console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
    });
}

/**
 * `narratorEngineForSession` is module-private (it is not part of the bridge's
 * surface and should not become part of it for a test). Lifted out of the compiled
 * file with its two dependencies rebound, so what runs here is the shipped code.
 */
const bridgeJs = fs.readFileSync(path.join(DIST, 'reassembly-bridge.js'), 'utf-8');
const fnSrc = bridgeJs.match(/async function narratorEngineForSession[\s\S]*?\n}\n/);
const provSrc = bridgeJs.match(/async function parseSessionProvenance[\s\S]*?\n}\n/);
if (!fnSrc || !provSrc) {
  console.error('narratorEngineForSession / parseSessionProvenance are not in the compiled bridge');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const narratorEngineForSession = eval(
  `(function (fs, path) { ${provSrc[0]} ${fnSrc[0]} return narratorEngineForSession; })`,
)(fs, path);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-provenance-'));
let n = 0;
/** A process dir with whichever of the two files the case is about. */
function makeSession({ narratorState, sidecar }) {
  const dir = path.join(ROOT, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (narratorState !== undefined) {
    fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify(narratorState, null, 2));
  }
  if (sidecar !== undefined) {
    fs.writeFileSync(path.join(dir, 'session_state.json'), JSON.stringify(sidecar, null, 2));
  }
  return dir;
}

async function main() {
  console.log('the headless shape — narrator\'s file ONLY');
  await check('a session with only session-state.json assembles', async () => {
    // EXACTLY the Mac's run 4: renderRangeHeadless writes no sidecar.
    const dir = makeSession({ narratorState: { tts_engine: 'orpheus', fine_tuned: 'deathstalker' } });
    assert.strictEqual(await narratorEngineForSession(dir), 'orpheus');
  });
  await check('a Higgs headless session assembles as higgs-v3', async () => {
    const dir = makeSession({ narratorState: { tts_engine: 'higgs-v3', higgs_voice: 'default' } });
    assert.strictEqual(await narratorEngineForSession(dir), 'higgs-v3');
  });

  console.log('the sidecar is a cross-check, never the source');
  await check('both files present and agreeing → assembles', async () => {
    const dir = makeSession({
      narratorState: { tts_engine: 'orpheus' },
      sidecar: { settings: { ttsEngine: 'orpheus', fineTuned: 'deathstalker' } },
    });
    assert.strictEqual(await narratorEngineForSession(dir), 'orpheus');
  });
  await check("the two spellings of Higgs are NOT a disagreement", async () => {
    // BookForge says `higgs`; narrator says `higgs-v3` (`higgs` is an
    // ENGINE_NEAR_MISS). Comparing them raw would refuse every Higgs assembly.
    const dir = makeSession({
      narratorState: { tts_engine: 'higgs-v3' },
      sidecar: { settings: { ttsEngine: 'higgs' } },
    });
    assert.strictEqual(await narratorEngineForSession(dir), 'higgs-v3');
  });
  await check('a REAL disagreement refuses, naming both', async () => {
    const dir = makeSession({
      narratorState: { tts_engine: 'orpheus' },
      sidecar: { settings: { ttsEngine: 'higgs' } },
    });
    let threw = null;
    try { await narratorEngineForSession(dir); } catch (e) { threw = e; }
    assert.ok(threw, 'a session that contradicts itself was assembled anyway');
    assert.match(threw.message, /orpheus/);
    assert.match(threw.message, /higgs/);
    assert.match(threw.message, /disagrees/i);
  });
  await check('a sidecar ALONE is not enough — narrator\'s file is required', async () => {
    // The inverse of the bug: the sidecar must not become the source either.
    const dir = makeSession({ sidecar: { settings: { ttsEngine: 'orpheus' } } });
    let threw = null;
    try { await narratorEngineForSession(dir); } catch (e) { threw = e; }
    assert.ok(threw, 'assembled from the sidecar with no narrator state at all');
    assert.match(threw.message, /session-state\.json/);
  });

  console.log('retired and unknown engines are refused BY NAME');
  await check('a legacy xtts session refuses', async () => {
    const dir = makeSession({ narratorState: { tts_engine: 'xtts', fine_tuned: 'ScarlettJohansson' } });
    let threw = null;
    try { await narratorEngineForSession(dir); } catch (e) { threw = e; }
    assert.ok(threw, 'an XTTS session was assembled under another engine\'s name');
    assert.match(threw.message, /xtts/i);
    assert.match(threw.message, /retired/i);
  });
  await check('an absent tts_engine refuses, naming the file it looked in', async () => {
    const dir = makeSession({ narratorState: { fine_tuned: 'deathstalker' } });
    let threw = null;
    try { await narratorEngineForSession(dir); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.match(threw.message, /session-state\.json/);
  });
  await check('an engine near-miss refuses rather than resolving helpfully', async () => {
    for (const bad of ['higgs_v3', 'higgs-v2', 'higgs-v2-scaffold']) {
      const dir = makeSession({ narratorState: { tts_engine: bad } });
      let threw = null;
      try { await narratorEngineForSession(dir); } catch (e) { threw = e; }
      assert.ok(threw, `'${bad}' was resolved instead of refused`);
    }
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll session-provenance checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
