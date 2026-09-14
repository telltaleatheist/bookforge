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
  /*
   * WHAT THIS PROTECTS, restated 2026-09-14 after the function was reworked.
   *
   * It used to read `resolveSavedTtsEngine(merged.ttsEngine)` literally, and
   * the local was renamed `merged` → `repaired` when a SECOND repair arm
   * landed beside it. The property was never the variable's name: it is that
   * the stored value goes through the ONE rule in shared/, and that no copy of
   * the retirement table is spelled out over here. A service that decided for
   * itself which ids are retired would be a second owner of that fact, and
   * would disagree with `assertRunnableTtsEngine` the first time the list
   * changed.
   */
  const call = /resolveSavedTtsEngine\((\w+)\.ttsEngine\)/.exec(getDefaults);
  assert.ok(call, 'it does not call resolveSavedTtsEngine on the merged record\'s engine');
  assert.ok(new RegExp(`${call[1]}\\s*(:|=)[^\\n]*DEFAULT_PIPELINE_DEFAULTS`).test(getDefaults),
    `it resolves ${call[1]}.ttsEngine, which is not the record merged over the built-in defaults`);
  assert.ok(SERVICE.includes('resolveSavedTtsEngine') && SERVICE.includes('@shared/tts/engine-caps'),
    'it does not import the rule from shared/');
  for (const id of RETIRED) {
    assert.ok(!new RegExp(`['"]${id}['"]`).test(getDefaults),
      `getPipelineDefaults names "${id}" itself — the retired list belongs to engine-caps`);
  }
  /*
   * AND THE SAME DOCTRINE FOR THE ARM THAT LANDED BESIDE IT. A stored AI
   * provider is repaired by `resolveSavedAIProvider`, imported from the model
   * types, for exactly the reason the engine is: `ollama`, `claude` and
   * `openai` left BookForge on 2026-09-14 and a role whose picker shows
   * nothing selected is the same dead page the retired engine used to make.
   */
  assert.ok(/resolveSavedAIProvider\(/.test(getDefaults),
    'the stored AI provider is repaired by hand rather than through the shared rule');
  for (const gone of ['ollama', 'claude', 'openai']) {
    assert.ok(!new RegExp(`['"]${gone}['"]`).test(getDefaults),
      `getPipelineDefaults names "${gone}" itself — the removed list belongs to ai-config.types`);
  }
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
  /*
   * A FRESH INSTALL HAS NO STORED RECORD, and must not be told one of its
   * choices was migrated.
   *
   * The built-in defaults are spread in first, so by the time the repair arms
   * run the merged record ALWAYS carries an engine and three providers — and
   * `resolveSavedTtsEngine` will happily answer about the default too. What
   * keeps a first launch quiet is that each arm asks the STORED record, not
   * the merged one, whether the user ever chose anything. Read the guards
   * rather than the shape of the migration: this used to pin the single
   * spelling `stored?.ttsEngine === undefined` from an early return, and the
   * rework turned that into a positive guard around the arm and a per-role
   * `continue` beside it. Both are the same property.
   */
  assert.ok(/if \(stored\?\.ttsEngine !== undefined\)/.test(getDefaults),
    'the engine repair is not gated on the STORED record carrying an engine, so a fresh '
    + 'install would take the migration path and log an error');
  assert.ok(/if \(stored\?\.\[`\$\{role\}Provider`\] === undefined\) continue;/.test(getDefaults),
    'the provider repair is not gated on the STORED record carrying that role\'s provider');
  /*
   * AND NOTHING IS WRITTEN BACK WHEN NOTHING WAS REPAIRED. A first launch
   * that persisted the defaults would turn "the user has never chosen" into
   * "the user chose exactly these", which is the same lie one step later —
   * and it would do it on every read, since `getPipelineDefaults` is called
   * from a picker's render.
   */
  assert.ok(/if \(!anyRepair\) return repaired;/.test(getDefaults),
    'a read with no repair in it still writes the settings file');
  /*
   * A TRIPWIRE ON THE COUNT: two arms, two sentences. A third console.error
   * appearing in this function is a repair nothing above accounts for, and it
   * would be the one that fires on a machine with nothing stored.
   */
  assert.strictEqual((getDefaults.match(/console\.error/g) || []).length, 2,
    'getPipelineDefaults logs a migration this check does not know about');
});

console.log(`\n${failed === 0 ? 'ALL OK' : 'FAILED'}  retired engine settings: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
