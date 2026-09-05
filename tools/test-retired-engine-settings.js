#!/usr/bin/env node
/**
 * A MACHINE THAT USED A RETIRED ENGINE STILL WORKS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-retired-engine-settings.js
 *
 * XTTS, F5 and Voxtral left the root on 2026-09-05. Their ids did not: a record
 * or a saved setting written before then names one, and `RetiredTtsEngine` exists
 * so it can still be LOADED and DISPLAYED while `assertRunnableTtsEngine` refuses
 * to RENDER it.
 *
 * That split has two halves and they need opposite answers, which is what this
 * file pins:
 *
 *  - CODE ABOUT TO QUEUE WORK refuses, full stop. Substituting an engine at
 *    render time hands back a whole book in a voice nobody chose and reports
 *    success.
 *  - A STORED PREFERENCE is migrated instead — `resolveSavedTtsEngine`. Refusing
 *    there is not free: a machine whose Pipeline Defaults said `xtts` showed an
 *    engine button group with NOTHING selected and threw on every run, from the
 *    one page that could have repaired it. That was live on main until this
 *    branch (the streaming half, `tts-engine.json`, had the same bug and the same
 *    fix). A default is the seed for the NEXT run, shown in a picker before
 *    anything renders — migrating one is not the failure the refusal prevents.
 *
 * And the queue's half of the same doctrine: a persisted `bilingual-*` row is
 * failed on load with a sentence a person can act on, not with the generic
 * "nothing in this build knows how to run it".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CAPS = path.join(REPO, 'dist', 'shared', 'tts', 'engine-caps.js');
const ENGINE_TYPES = path.join(REPO, 'dist', 'shared', 'queue', 'engine-types.js');
if (!fs.existsSync(CAPS) || !fs.existsSync(ENGINE_TYPES)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const caps = require(CAPS);
const engineTypes = require(ENGINE_TYPES);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

const RETIRED = ['xtts', 'f5', 'voxtral'];

console.log('a saved setting naming a retired engine');

check('every retired id still LOADS and still DISPLAYS', () => {
  for (const id of RETIRED) {
    assert.ok(caps.isTtsEngine(id), `${id} is not nameable`);
    assert.strictEqual(caps.isRunnableTtsEngine(id), false, `${id} claims to be runnable`);
    assert.match(caps.engineDisplayName(id), /\(retired\)$/, id);
  }
});

check('a stored retired engine MIGRATES, and says which one it was', () => {
  for (const id of RETIRED) {
    const r = caps.resolveSavedTtsEngine(id);
    assert.strictEqual(r.engine, 'orpheus', id);
    assert.strictEqual(r.migratedFrom, id, id);
    // The note has to name the engine, or a log line is not actionable.
    assert.ok(r.note && r.note.includes(id), `note does not name ${id}: ${r.note}`);
  }
});

check('a stored RUNNABLE engine is returned untouched, and never marked migrated', () => {
  for (const id of ['orpheus', 'higgs']) {
    const r = caps.resolveSavedTtsEngine(id);
    assert.strictEqual(r.engine, id);
    assert.strictEqual(r.migratedFrom, undefined, id);
  }
});

check('an engine this build has never had THROWS, by name', () => {
  assert.throws(() => caps.resolveSavedTtsEngine('bark'), /bark/);
  assert.throws(() => caps.resolveSavedTtsEngine(''), /never had/);
});

check('the RENDER door still refuses a retired engine outright', () => {
  // The asymmetry is the point: resolveSavedTtsEngine migrates, this one does not.
  for (const id of RETIRED) {
    assert.throws(() => caps.assertRunnableTtsEngine(id), /retired/i, id);
  }
  assert.strictEqual(caps.assertRunnableTtsEngine('orpheus'), 'orpheus');
});

console.log('a persisted queue row for a removed pipeline');

check('the three bilingual job types are refused BY NAME, not generically', () => {
  for (const type of ['bilingual-cleanup', 'bilingual-translation', 'bilingual-assembly']) {
    const message = engineTypes.RETIRED_JOB_TYPES.get(type);
    assert.ok(message, `${type} is not in RETIRED_JOB_TYPES`);
    // Same shape as the other nine: say what is gone, say what to do instead,
    // and tell the user the row can go.
    assert.match(message, /Remove this row\.$/, type);
    assert.ok(message.length > 60, `${type}'s message is too thin to act on`);
  }
});

check('a live job type is NOT in the retired table', () => {
  for (const type of ['tts-conversion', 'reassembly', 'rvc-enhancement']) {
    assert.strictEqual(engineTypes.RETIRED_JOB_TYPES.get(type), undefined, type);
  }
});

console.log('the settings service is wired to that rule');

// SOURCE-LEVEL, and deliberately. `settings.service.ts` is Angular — it inject()s
// and cannot be require()d under plain node, so the DECISION it makes lives in
// shared/ (asserted above) and what is checked here is that the service actually
// ASKS. The same technique the Orpheus argv snapshot uses on the bridge.
const SERVICE = fs.readFileSync(
  path.join(REPO, 'src', 'app', 'core', 'services', 'settings.service.ts'), 'utf-8');
const getDefaults = SERVICE.slice(
  SERVICE.indexOf('getPipelineDefaults(): PipelineDefaults {'),
  SERVICE.indexOf('setPipelineDefaults(defaults: PipelineDefaults): void {'));

check('getPipelineDefaults resolves the stored engine through the shared rule', () => {
  assert.ok(getDefaults.includes('resolveSavedTtsEngine(merged.ttsEngine)'),
    'it does not call resolveSavedTtsEngine on the stored engine');
  assert.ok(SERVICE.includes('resolveSavedTtsEngine') && SERVICE.includes('@shared/tts/engine-caps'),
    'it does not import the rule from shared/');
});

check('a migration is WRITTEN BACK, or the stale value is re-read forever', () => {
  assert.ok(getDefaults.includes('this.setPipelineDefaults(repaired)'),
    'the repair is returned but never persisted');
});

check('the migration resets the VOICE too — the pair has to stay renderable', () => {
  assert.ok(getDefaults.includes('ttsVoice: DEFAULT_PIPELINE_DEFAULTS.ttsVoice'),
    'the retired engine is replaced but its voice is carried onto the new one');
});

check('nothing recorded is NOT treated as a migration', () => {
  assert.ok(getDefaults.includes('stored?.ttsEngine === undefined'),
    'a fresh install would take the migration path and log an error');
});

console.log(`\n${failed === 0 ? 'ALL OK' : 'FAILED'}  retired engine settings: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
