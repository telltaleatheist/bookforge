#!/usr/bin/env node
/**
 * THE NARRATION PICKER OFFERS HIGGS, AND ONLY HIGGS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-engine-retirement.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen ruled on 2026-09-14 that "orpheus is deprecated too but hasnt been removed
 * yet. higgs is the frontier". Every doc in the repo was updated to say so. What
 * nobody edited was `SELECTABLE_ORDER` in `shared/tts/engine-caps.ts` — the one
 * array the narration modal's Engine strip, the Pipeline Defaults panel and the
 * wizard all render from. So for a month the app went on offering Orpheus, FIRST,
 * ahead of Higgs, and the gap closed only when Owen opened the dialog himself:
 * "orpheus is still an option on the narrate modal. we removed it." It had not
 * been. A ruling written down in prose is not a ruling implemented in code, and
 * prose is what the repo had.
 *
 * This suite is the difference. It pins the RULING rather than the mechanism, so
 * the next engine decision either edits the list or turns this red.
 *
 * ── The two halves, which need opposite answers ─────────────────────────────
 *
 * Retirement is not deletion, and Orpheus is the sharpest case of that the repo
 * has: unlike XTTS — whose root was torn out on 2026-09-05 — the Orpheus spawn
 * layer, its `orpheus` component, its env routing, its fine-tune roster and its
 * WSL2 vLLM path are ALL still in this build and all still work. It was removed
 * from the CHOICE, not from the BUILD; the code dies as one piece with the legacy
 * e2a spawn layer after Owen's in-app pass. So:
 *
 *   - NOTHING OFFERS IT and nothing renders it. The picker's list, the shipped
 *     defaults, the CLI's default, the refusal messages.
 *   - EVERYTHING STILL PARSES IT. A finished audiobook's provenance, a queued
 *     job's config and a saved pipeline default all name `orpheus` on nearly
 *     every machine in existence — it was `DEFAULT_TTS_ENGINE` until the day it
 *     was retired — and refusing to READ those would be a far worse failure than
 *     refusing to RUN them.
 *
 * `tools/test-retired-engine-settings.js` owns the general retired-id doctrine
 * and `tools/test-higgs-engine.js` owns the Higgs wiring; this one owns the
 * narrowing itself and the shipped defaults that had to move with it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CAPS = path.join(REPO, 'dist', 'shared', 'tts', 'engine-caps.js');
if (!fs.existsSync(CAPS)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const caps = require(CAPS);

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

const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf-8');

/**
 * Source with its comments removed.
 *
 * Every check below that asks "does this file still NAME orpheus" has to ask it
 * of the CODE. This repo documents its decisions in the file that made them, so
 * the prose explaining an engine's retirement quotes the engine, quotes the line
 * that was deleted, and quotes the old fallback — and a naive `includes` reads
 * every one of those as the bug it is describing. Written down because the first
 * run of this suite failed on its own explanatory comments.
 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/** The same, for Python (`#` comments and the docstrings around them). */
const pyCode = (src) => src.replace(/^\s*#[^\n]*$/gm, '');

// ─────────────────────────────────────────────────────────────────────────────
// 1. What the picker offers
// ─────────────────────────────────────────────────────────────────────────────
console.log('the narration picker');

check('offers exactly one engine, and it is Higgs', () => {
  assert.deepStrictEqual([...caps.narrationEngineOrder()], ['higgs'],
    'the narration picker\'s list is not exactly [higgs]');
});

check('offers no engine that is marked retired', () => {
  // The two facts could disagree — an id can sit in the order AND carry a
  // retirement — and the symptom would be a button that refuses itself when
  // pressed. Held together here rather than trusted to stay in step.
  for (const id of caps.narrationEngineOrder()) {
    assert.strictEqual(caps.TTS_ENGINES[id].retired, null,
      `${id} is offered by the picker but marked retired`);
  }
});

check('offers nothing the render door would refuse', () => {
  for (const id of caps.narrationEngineOrder()) {
    assert.strictEqual(caps.assertRunnableTtsEngine(id), id);
  }
});

check('the modal and the defaults panel both render that list, not a hardcoded one', () => {
  /*
   * SOURCE-LEVEL, because these are Angular components that cannot be require()d
   * under plain node. The property is the one `engine-caps.ts`'s own comment
   * states: a hardcoded `@for` in each template "is exactly how a 'removed'
   * engine survives in one forgotten page". Both pages must ask.
   */
  const MODAL = read('src', 'app', 'features', 'studio', 'components',
    'narration-modal', 'narration-modal.component.ts');
  const PANEL = read('src', 'app', 'features', 'settings', 'components',
    'pipeline-defaults-panel.component.ts');
  for (const [name, src] of [['narration modal', MODAL], ['pipeline defaults panel', PANEL]]) {
    assert.ok(/selectableEngines\(/.test(src),
      `the ${name} does not build its engine list from selectableEngines()`);
    assert.ok(!/['"`]Orpheus['"`]/.test(code(src)),
      `the ${name} spells the label "Orpheus" itself — a second engine list`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A record naming orpheus still parses and still displays
// ─────────────────────────────────────────────────────────────────────────────
console.log('a record written when orpheus was a choice');

check('the id still LOADS — it never becomes unknown', () => {
  assert.strictEqual(caps.isTtsEngine('orpheus'), true,
    'orpheus is no longer a nameable id, so every old job record fails to parse');
  assert.ok(caps.engineCaps('orpheus'), 'orpheus has no capability row');
});

check('the id still DISPLAYS, and says it is retired', () => {
  assert.strictEqual(caps.engineDisplayName('orpheus'), 'Orpheus (retired)');
});

check('its capability row survives whole — voices, device, runtime', () => {
  // A row reduced to a stub would still "parse", and an old audiobook's details
  // page would then show an engine with no voices and no device policy. The row
  // is the record's only way to describe the run that produced it.
  const row = caps.TTS_ENGINES.orpheus;
  assert.strictEqual(row.displayName, 'Orpheus');
  assert.ok(row.voices && Array.isArray(row.voices.presets) && row.voices.presets.length > 0,
    'the Orpheus fine-tune roster was deleted with the picker entry');
  assert.ok(row.device && row.device.gpuRequired === true);
  assert.ok(typeof row.maxWorkers === 'number');
});

check('the retirement carries a DATE and a reason a person can act on', () => {
  const r = caps.TTS_ENGINES.orpheus.retired;
  assert.ok(r, 'orpheus is not marked retired at all');
  assert.strictEqual(r.since, '2026-09-14');
  assert.match(r.reason, /Higgs/, 'the reason does not say what to render on instead');
  assert.ok(r.reason.length > 60, 'the reason is too thin to act on');
  // THE READER MUST NOT CONCLUDE THE CODE IS GONE. Orpheus's spawn layer is
  // still in the build and still runs; only the choice was removed. Saying so
  // in the reason is what stops the next session "finishing the job" by ripping
  // out a path that is scheduled to die with the legacy e2a layer, as one piece.
  assert.match(r.reason, /still (in this build|runs)|not from the build/i,
    'the reason does not say the spawn layer is still present');
});

check('the render door refuses it BY NAME, and never coerces to Higgs', () => {
  let threw = null;
  try { caps.assertRunnableTtsEngine('orpheus'); } catch (err) { threw = err; }
  assert.ok(threw, 'the render door accepted a retired engine');
  assert.match(threw.message, /Orpheus/);
  assert.match(threw.message, /2026-09-14/);
});

check('a saved PREFERENCE migrates loudly instead — the other half of the rule', () => {
  // Refusing here is not free: the engine button group would show nothing
  // selected on essentially every machine, from the one page that could repair
  // it. A default is the seed for the NEXT run, shown in a picker before
  // anything renders.
  const r = caps.resolveSavedTtsEngine('orpheus');
  assert.strictEqual(r.engine, 'higgs');
  assert.strictEqual(r.migratedFrom, 'orpheus');
  assert.ok(r.note && r.note.includes('orpheus'),
    'the migration note does not name what was stored, so the log is not actionable');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. No shipped default names a retired engine
// ─────────────────────────────────────────────────────────────────────────────
console.log('shipped defaults');

check('DEFAULT_TTS_ENGINE is an engine this build renders', () => {
  assert.ok(caps.isRunnableTtsEngine(caps.DEFAULT_TTS_ENGINE),
    `DEFAULT_TTS_ENGINE is "${caps.DEFAULT_TTS_ENGINE}", which cannot render`);
});

const SETTINGS = read('src', 'app', 'core', 'services', 'settings.service.ts');

check('DEFAULT_PIPELINE_DEFAULTS names a runnable engine', () => {
  /*
   * THE ONE DEFAULT THE MIGRATION CANNOT SAVE. `getPipelineDefaults` repairs a
   * STORED engine, and gates that repair on the user having stored one — so a
   * shipped default that went stale reaches a FRESH machine unrepaired: nothing
   * selected in the picker, and every run throwing at `assertRunnableTtsEngine`
   * from a page that offers no way to fix it. That is why this literal has to
   * move on the same day an engine is retired, and it now has, three times.
   */
  const block = SETTINGS.slice(
    SETTINGS.indexOf('export const DEFAULT_PIPELINE_DEFAULTS'),
    SETTINGS.indexOf('export const DEFAULT_PIPELINE_DEFAULTS') + 4000);
  const m = /^\s*ttsEngine:\s*'([a-z0-9-]+)'/m.exec(block);
  assert.ok(m, 'DEFAULT_PIPELINE_DEFAULTS states no ttsEngine');
  assert.ok(caps.isRunnableTtsEngine(m[1]),
    `the shipped default engine is "${m[1]}", which is retired and cannot render`);
});

check('and a voice that BELONGS to that engine', () => {
  // The pair, not just the engine. `leah` is an Orpheus fine-tune; carrying it
  // onto a Higgs default would ship exactly the unrenderable engine/voice pair
  // the stored-settings migration exists to clean up — and the modal refuses it
  // by name rather than substituting, so the dialog would open blocked.
  const block = SETTINGS.slice(
    SETTINGS.indexOf('export const DEFAULT_PIPELINE_DEFAULTS'),
    SETTINGS.indexOf('export const DEFAULT_PIPELINE_DEFAULTS') + 4000);
  const engine = /^\s*ttsEngine:\s*'([a-z0-9-]+)'/m.exec(block)[1];
  const voice = /^\s*ttsVoice:\s*'([^']*)'/m.exec(block);
  assert.ok(voice, 'DEFAULT_PIPELINE_DEFAULTS states no ttsVoice');
  assert.strictEqual(engine, 'higgs',
    'this check knows how to read the Higgs roster only — teach it the new engine');
  const catalog = JSON.parse(read('electron', 'data', 'higgs-models.json'));
  const ids = catalog.models.map((m) => m.id);
  assert.ok(ids.includes(voice[1]),
    `the shipped default voice "${voice[1]}" is not in the Higgs catalog (${ids.join(', ')})`);
});

check('no shipped PRESET selects an engine at all', () => {
  /*
   * Presets stopped carrying `ttsEngine` on 2026-09-09, and the incident that
   * ended it is the reason this is pinned rather than assumed: Owen picked
   * Higgs, applied "Deathstalker → Sigma" for its conversion rates, and the
   * preset's `ttsEngine: 'orpheus'` silently moved the run back to Orpheus —
   * invisible, because both engines ship a voice called `deathstalker`. 826
   * chunks rendered on the wrong engine. A preset that names a RETIRED engine
   * would now be the same bug with a louder ending.
   */
  const block = SETTINGS.slice(
    SETTINGS.indexOf('export const BUILTIN_PIPELINE_PRESETS'),
    SETTINGS.indexOf('export const BUILTIN_PIPELINE_PRESETS') === -1
      ? 0 : SETTINGS.indexOf('getPipelineDefaults(): PipelineDefaults {'));
  assert.ok(block.length > 0, 'BUILTIN_PIPELINE_PRESETS was not found');
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/ttsEngine\s*:/.test(stripped),
    'a shipped preset sets ttsEngine — applying it would move the run off the chosen engine');
  assert.ok(!/ttsVoice\s*:/.test(stripped),
    'a shipped preset sets ttsVoice — the same bug, one field over');
});

check('the CLI\'s --engine default is an engine this build renders', () => {
  // The CLI mirrors the app's code path: it hands `ttsEngine` to the same
  // `renderRangeHeadless`, which calls `assertRunnableTtsEngine`. A default of
  // `orpheus` here would make the bare `--tts` invocation throw on every machine.
  const CLI = pyCode(read('cli', 'bookforge-tts.py'));
  const m = /p\.add_argument\("--engine",\s*default="([a-z0-9-]+)"/.exec(CLI);
  assert.ok(m, 'the CLI no longer declares a --engine default in a form this can read');
  assert.ok(caps.isRunnableTtsEngine(m[1]),
    `the CLI's default engine is "${m[1]}", which is retired and cannot render`);
});

check('no narration door falls back to an engine the caller did not name', () => {
  /*
   * NO FALLBACKS. `cli/orpheus-batch-render.js` read `args.engine || 'orpheus'`
   * until 2026-09-14 — a caller that forgot the flag got a silent engine rather
   * than an error, and after the retirement that silent engine became a
   * guaranteed throw several layers down, naming an engine nobody asked for.
   */
  const BATCH = code(read('cli', 'orpheus-batch-render.js'));
  assert.ok(!/args\.engine\s*(\|\||\?\?)\s*['"]/.test(BATCH),
    'orpheus-batch-render.js defaults the engine instead of requiring it');
  assert.ok(/--engine is required/.test(BATCH),
    'orpheus-batch-render.js does not refuse a missing --engine by name');
});

console.log(
  failed === 0
    ? `\nALL OK  narration engine retirement: ${passed} passed, 0 failed`
    : `\nFAILED  narration engine retirement: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
