#!/usr/bin/env node
/**
 * Tests for THE HIGGS ENGINE OPTION — the engine-id model, the catalog's
 * refusals, the doctor's parsing, and the spawn's argv/env.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-higgs-engine.js
 *
 * ── What is worth testing here, and what is not ─────────────────────────────
 *
 * Not: that vllm-omni renders audio. That needs a GPU, 24 GB of VRAM and a
 * 55-second cold start, and it is not what breaks.
 *
 * What breaks is the wiring around it, and every one of these failures is
 * SILENT — none of them throws at the point of the mistake:
 *
 *  - a retired engine id that gets coerced instead of refused renders a whole
 *    book in a voice nobody chose and reports success;
 *  - a catalog voice that resolves when its artifact is not installed serves the
 *    model's own default speaker, which measures at 12% of the narrator's ECAPA
 *    ceiling — a DIFFERENT person, not a bad clone;
 *  - a reference clip sent without its transcript conditions every sentence on a
 *    mismatch;
 *  - a doctor that reads a missing probe line as a pass reports green for a
 *    machine with no WSL at all;
 *  - and an Orpheus argv that shifted by one flag during this work would not
 *    show up until somebody rendered a book.
 *
 * So: pure functions, compiled modules, no GPU, no WSL, no Electron main loop.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'higgs-models.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

/**
 * `electron` is not installed as a require-able module in this runner, and
 * higgs-models.js does not use it — but tool-paths.js, which higgs-spawn.js
 * pulls in, does. One stub for the whole file, rather than per-suite plumbing.
 */
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
/**
 * `app.getAppPath()` is a VARIABLE, not a constant, so the buildHiggsSpawn suite
 * can point it at a scratch root that contains a narrator package. See that
 * section for why a stub package is the right fixture here.
 */
let APP_PATH = REPO;
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: { app: { getAppPath: () => APP_PATH, isPackaged: false, getPath: () => REPO } },
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The engine-id model
// ─────────────────────────────────────────────────────────────────────────────
const caps = require(path.join(REPO, 'dist', 'shared', 'tts', 'engine-caps.js'));

console.log('engine ids');

check('orpheus and higgs are the runnable set, in that order', () => {
  assert.deepStrictEqual([...caps.narrationEngineOrder()], ['orpheus', 'higgs']);
});

check('every runnable engine has retired === null', () => {
  for (const id of caps.narrationEngineOrder()) {
    assert.strictEqual(caps.TTS_ENGINES[id].retired, null, `${id} is in the order but marked retired`);
  }
});

check('xtts still LOADS — a legacy record must not become unknown', () => {
  // The whole point of keeping the id in TTS_ENGINES. A record written before
  // the retirement has to resolve to something displayable.
  assert.strictEqual(caps.isTtsEngine('xtts'), true);
  assert.ok(caps.engineCaps('xtts'));
});

check('xtts is NOT runnable', () => {
  assert.strictEqual(caps.isRunnableTtsEngine('xtts'), false);
});

check('xtts displays as "XTTS (retired)"', () => {
  assert.strictEqual(caps.engineDisplayName('xtts'), 'XTTS (retired)');
});

check('a runnable engine displays without a suffix', () => {
  assert.strictEqual(caps.engineDisplayName('orpheus'), 'Orpheus');
  assert.strictEqual(caps.engineDisplayName('higgs'), 'Higgs');
});

check('an unknown id displays rather than throwing', () => {
  // Called while rendering a list; one bad row must not take the page down.
  assert.match(caps.engineDisplayName('bark'), /Unknown engine/);
});

check('assertRunnableTtsEngine REFUSES xtts by name, and never coerces', () => {
  let threw = null;
  try { caps.assertRunnableTtsEngine('xtts'); } catch (err) { threw = err; }
  assert.ok(threw, 'a retired engine was accepted');
  assert.match(threw.message, /XTTS/, 'the refusal does not name the engine');
  assert.match(threw.message, /retired/i);
});

check('assertRunnableTtsEngine passes a runnable engine through unchanged', () => {
  assert.strictEqual(caps.assertRunnableTtsEngine('orpheus'), 'orpheus');
  assert.strictEqual(caps.assertRunnableTtsEngine('higgs'), 'higgs');
});

check('an unknown engine is refused and the message says what IS renderable', () => {
  let threw = null;
  try { caps.assertRunnableTtsEngine('nope'); } catch (err) { threw = err; }
  assert.ok(threw);
  assert.match(threw.message, /orpheus, higgs/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The voice catalog rule
// ─────────────────────────────────────────────────────────────────────────────
const nv = require(path.join(REPO, 'dist', 'shared', 'tts', 'narration-voices.js'));

console.log('voice catalog routing');

const CATALOG = {
  xtts: [{ value: 'x', label: 'x' }],
  orpheus: [{ value: 'o', label: 'o' }],
  higgs: [{ value: 'h', label: 'h' }],
};

check('higgs gets the HIGGS list, not the XTTS one', () => {
  // The regression this replaced: `engine === 'orpheus' ? orpheus : xtts` gave
  // the Higgs picker a list of XTTS reference clips, and nothing failed until a
  // render came back in the wrong voice.
  assert.deepStrictEqual(nv.narrationVoicesFor('higgs', CATALOG), CATALOG.higgs);
});

check('orpheus still gets the orpheus list', () => {
  assert.deepStrictEqual(nv.narrationVoicesFor('orpheus', CATALOG), CATALOG.orpheus);
});

check('a retired engine still gets the list its records were rendered against', () => {
  assert.deepStrictEqual(nv.narrationVoicesFor('xtts', CATALOG), CATALOG.xtts);
});

check('an unknown engine THROWS rather than defaulting into another list', () => {
  assert.throws(() => nv.narrationVoicesFor('bark', CATALOG), /No voice catalog is defined/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The Higgs catalog loader
// ─────────────────────────────────────────────────────────────────────────────
const higgs = require(path.join(DIST, 'higgs-models.js'));

console.log('higgs catalog');

check('the shipped catalog loads and has both seeded voices', () => {
  const ids = higgs.listHiggsModels().map((m) => m.id);
  assert.ok(ids.includes('default'), 'the zero-shot default voice is missing');
  assert.ok(ids.includes('deathstalker'), 'the deathstalker voice is missing');
});

check('the default voice is a clips voice with NO clips (the served default)', () => {
  const m = higgs.listHiggsModels().find((v) => v.id === 'default');
  assert.strictEqual(m.kind, 'clips');
  assert.strictEqual(m.voice.clips.length, 0);
  assert.ok(!m.voice.adapterDir);
});

check('deathstalker is an adapter voice and is marked pending', () => {
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.kind, 'adapter');
  assert.ok(m.voice.adapterDir, 'the adapter dir is missing');
  assert.ok(m._pendingNote, 'the placeholder adapter path is not marked pending');
});

check('the seeded adapter carries NO measured cap — that is the point of it', () => {
  // The training side measured that an adapter stops at its TRAINING CLIP
  // LENGTH, not at the text: one trained on 8-22 s clips stops after ~6-10 s on
  // any prompt over ~150 chars. So inheriting the zero-shot 600 would lose most
  // of every chunk while every duration check still looked fine.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.backends.served.maxChars, null);
  assert.strictEqual(m.backends.served.maxCharsSource, null);
});

check('a pending voice is EXCLUDED from the renderable set but LISTED for a picker', () => {
  // Offering-and-refusing is the honest pair; hiding-and-forgetting is not.
  assert.ok(!higgs.listRenderableHiggsModels().some((m) => m.id === 'deathstalker'));
  assert.ok(higgs.higgsNarrationVoices().some((v) => v.value === 'deathstalker'));
});

check('a pending voice is labelled as not installed', () => {
  const row = higgs.higgsNarrationVoices().find((v) => v.value === 'deathstalker');
  assert.match(row.label, /not installed yet/);
});

check('resolveHiggsModel REFUSES an unknown voice and lists the known ones', () => {
  let threw = null;
  try { higgs.resolveHiggsModel('nobody'); } catch (err) { threw = err; }
  assert.ok(threw, 'an unknown Higgs voice resolved');
  assert.match(threw.message, /nobody/);
  assert.match(threw.message, /default/, 'the refusal does not say what IS available');
});

check('resolveHiggsModel REFUSES a voice whose artifact has not landed', () => {
  let threw = null;
  try { higgs.resolveHiggsModel('deathstalker'); } catch (err) { threw = err; }
  assert.ok(threw, 'a pending voice resolved — it would serve the default speaker');
  assert.match(threw.message, /not installed yet/);
});

check('resolveHiggsModel REFUSES an empty voice rather than picking one', () => {
  assert.throws(() => higgs.resolveHiggsModel(''), /No Higgs voice was selected/);
  assert.throws(() => higgs.resolveHiggsModel(null), /No Higgs voice was selected/);
});

check('the served default voice resolves', () => {
  assert.strictEqual(higgs.resolveHiggsModel('default').id, 'default');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The per-voice refusals, driven through synthesised entries
// ─────────────────────────────────────────────────────────────────────────────
console.log('voice refusals');

const DOC_PATH = '/mnt/c/tmp/higgs-probe-voices.json';
function probeVoice(overrides) {
  return Object.assign({
    id: 'probe', label: 'probe', kind: 'clips', engineVersion: 'v3',
    voice: { clips: [] },
    license: 'x', commercialUse: false, sampleRate: 24000, addedAt: 'x',
    backends: { served: { referenceSecondsCap: 30, allowedControls: [] } },
  }, overrides);
}
const envOpts = { voicesPath: DOC_PATH };

check('a blank, whitespace or missing transcript is REFUSED, naming the file', () => {
  // This caught a real hole on 2026-09-04: the refusal lived only in
  // resolveHiggsModel, so a caller holding a model from listHiggsModels() —
  // which deliberately returns rows resolveHiggsModel refuses — got an
  // untranscribed clip all the way into the voice document. The check now lives
  // at the boundary that emits the value, which is what this asserts.
  for (const bad of ['', '   ', undefined]) {
    const m = probeVoice({
      voice: { clips: [{ path: '/tmp/cd_00001100.wav', transcript: bad, seconds: 14 }] },
    });
    let threw = null;
    try { higgs.higgsSpawnEnv(m, envOpts); } catch (err) { threw = err; }
    assert.ok(threw, 'transcript ' + JSON.stringify(bad) + ' was accepted');
    assert.match(threw.message, /cd_00001100/, 'the refusal does not name the clip');
    assert.match(threw.message, /transcript/i);
  }
});

check('a clip with no declared `seconds` is REFUSED', () => {
  // narrator refuses it rather than probing the file, so this would otherwise
  // fail only after the server had spent ~5 minutes coming up.
  for (const bad of [undefined, null, 0, -1, 'x']) {
    const m = probeVoice({
      voice: { clips: [{ path: '/tmp/a.wav', transcript: 'hello there', seconds: bad }] },
    });
    assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /duration/i,
      'seconds ' + JSON.stringify(bad) + ' was accepted');
  }
});

check('TWO reference clips are REFUSED — vllm-omni takes exactly one', () => {
  const m = probeVoice({
    voice: { clips: [
      { path: '/tmp/a.wav', transcript: 'one', seconds: 10 },
      { path: '/tmp/b.wav', transcript: 'two', seconds: 10 },
    ] },
  });
  let threw = null;
  try { higgs.higgsSpawnEnv(m, envOpts); } catch (err) { threw = err; }
  assert.ok(threw, 'a multi-clip voice was accepted');
  assert.match(threw.message, /EXACTLY ONE/);
  assert.match(threw.message, /join/i, 'the refusal does not say how to fix it');
});

check('a reference over the 30 s server cap is REFUSED before launch', () => {
  const m = probeVoice({
    voice: { clips: [{ path: '/tmp/a.wav', transcript: 'long one', seconds: 42 }] },
  });
  assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /cap/);
});

check('a 27 s single joined reference PASSES', () => {
  const m = probeVoice({
    voice: { clips: [{ path: '/tmp/joined.wav', transcript: 'a joined pair', seconds: 27.4 }] },
  });
  const e = higgs.higgsSpawnEnv(m, envOpts);
  assert.strictEqual(e.NARRATOR_HIGGS_VOICES, DOC_PATH);
});

check('an adapter with NO measured maxChars is REFUSED, and the message says why', () => {
  const m = probeVoice({
    kind: 'adapter',
    voice: { clips: [], adapterDir: '/home/x/higgs-models/probe' },
    backends: { served: { maxChars: null, maxCharsSource: null } },
  });
  let threw = null;
  try { higgs.higgsSpawnEnv(m, envOpts); } catch (err) { threw = err; }
  assert.ok(threw, 'an unmeasured adapter was accepted');
  assert.match(threw.message, /TRAINING CLIP LENGTH/);
  assert.match(threw.message, /length sweep/);
});

check('an adapter inheriting the zero-shot 600 with no source is still REFUSED', () => {
  // The number alone is not evidence; maxCharsSource is what makes it one.
  const m = probeVoice({
    kind: 'adapter',
    voice: { clips: [], adapterDir: '/home/x/higgs-models/probe' },
    backends: { served: { maxChars: 600 } },
  });
  assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /MEASURED maxChars/);
});

check('an adapter WITH a measured cap and its source passes', () => {
  const m = probeVoice({
    kind: 'adapter',
    voice: { clips: [], adapterDir: '/home/x/higgs-models/probe' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep 2026-09-05, ASR-verified' } },
  });
  assert.ok(higgs.higgsSpawnEnv(m, envOpts));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The voice document and the NARRATOR_* environment
// ─────────────────────────────────────────────────────────────────────────────
console.log('voice document and narrator env');

const defaultVoice = higgs.resolveHiggsModel('default');

check('the measured caps come through, with their provenance', () => {
  const c = higgs.higgsVoiceCapsForModel(defaultVoice);
  assert.strictEqual(c.maxChars, 600, 'the measured zero-shot cap moved');
  assert.strictEqual(c.maxCharsSource, 'zero-shot placeholder');
  assert.deepStrictEqual(c.edgeFadeMs, { in: 10, out: 25 });
  assert.deepStrictEqual(c.sampling, { temperature: 1.0, topP: 0.95, topK: 50 });
  assert.strictEqual(c.referenceSecondsCap, 30);
  assert.deepStrictEqual(c.allowedControls, []);
});

check('caps are ABSENT, not zero, for a voice that declares none', () => {
  const bare = Object.assign({}, defaultVoice, { backends: undefined });
  assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(bare), {});
});

check('the voice document is narrator-shaped and holds exactly ONE voice', () => {
  // One voice per document on purpose: narrator's load_voices validates EVERY
  // clip path in the file, so shipping the whole catalog would make one moved
  // reference fail every other voice's render with an unrelated filename.
  const doc = higgs.higgsVoicesDocument(defaultVoice);
  assert.deepStrictEqual(Object.keys(doc), ['default']);
  assert.deepStrictEqual(doc.default.clips, []);
  assert.strictEqual(doc.default.maxReferenceSeconds, 30);
  assert.deepStrictEqual(doc.default.allowedControls, []);
});

check('a clone voice document carries path, transcript AND seconds', () => {
  const m = probeVoice({
    id: 'ds',
    voice: { clips: [{ path: '/a/joined.wav', transcript: 'He said it was here.', seconds: 27.4 }] },
  });
  const doc = higgs.higgsVoicesDocument(m);
  assert.deepStrictEqual(doc.ds.clips, [
    { path: '/a/joined.wav', transcript: 'He said it was here.', seconds: 27.4 },
  ]);
});

check('an adapter document carries adapterDir AND its measured cap AND kind', () => {
  // THE CAP MUST TRAVEL. narrator's load_voices raises for an adapter entry with
  // no `maxChars` — so `refuseUnmeasuredAdapter` was guarding a number that never
  // reached the engine, and the day deathstalker is promoted with its length
  // sweep the render would have been refused while the measurement sat in a JSON
  // file nobody read. `kind` is stated rather than left to narrator's derivation
  // (absent + adapterDir => 'adapter'), so the refusal path has nothing to infer.
  const m = probeVoice({
    id: 'ft', kind: 'adapter',
    voice: { clips: [], adapterDir: '/home/x/higgs-models/ft' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep 2026-09-05' } },
  });
  const doc = higgs.higgsVoicesDocument(m);
  assert.strictEqual(doc.ft.adapterDir, '/home/x/higgs-models/ft');
  assert.deepStrictEqual(doc.ft.clips, []);
  assert.strictEqual(doc.ft.kind, 'adapter');
  assert.strictEqual(doc.ft.maxChars, 1350);
  assert.strictEqual(doc.ft.maxCharsSource, 'length-sweep 2026-09-05');
});

check('a zero-shot document carries its cap too, so nothing is inferred', () => {
  // narrator would otherwise fall back to HiggsV3Defaults.MAX_CHARS — also 600,
  // and labelled a placeholder on that side. The two agreeing today is a
  // coincidence, not a contract.
  const doc = higgs.higgsVoicesDocument(defaultVoice);
  assert.strictEqual(doc.default.kind, 'clips');
  assert.strictEqual(doc.default.maxChars, 600);
  assert.strictEqual(doc.default.maxCharsSource, 'zero-shot placeholder');
});

const env = higgs.higgsSpawnEnv(defaultVoice, {
  voicesPath: '/mnt/c/tmp/voices.json',
  serveScriptPath: '/home/t/anaconda3/envs/higgs3/bin/serve_higgs_v3.sh',
  wslDistro: 'Ubuntu',
});

check('the env uses NARRATOR_* names — every invented HIGGS_* one is gone', () => {
  assert.strictEqual(env.NARRATOR_HIGGS_VOICES, '/mnt/c/tmp/voices.json');
  assert.strictEqual(env.NARRATOR_HIGGS3_SERVE_SCRIPT,
    '/home/t/anaconda3/envs/higgs3/bin/serve_higgs_v3.sh');
  assert.strictEqual(env.NARRATOR_HIGGS3_WSL_DISTRO, 'Ubuntu');
  const invented = Object.keys(env).filter((k) => /^HIGGS_/.test(k));
  assert.deepStrictEqual(invented, [], 'invented HIGGS_* names survive: ' + invented);
});

check('the CAPS do not travel — narrator refuses a caps payload by name', () => {
  // maxChars/edgeFade/sampling are BookForge's own business (prep packing and
  // assembly). narrator's higgs_v3_config_from_worker_kwargs RAISES on `caps`
  // because those are Orpheus knobs that v3 implements none of.
  for (const k of Object.keys(env)) {
    assert.ok(!/MAX_CHARS|TEMPERATURE|TOP_P|TOP_K|EDGE_FADE/.test(k),
      'a cap leaked into the spawn env as ' + k);
  }
});

check('every env value is a STRING — a number would arrive as undefined', () => {
  for (const [k, v] of Object.entries(env)) {
    assert.strictEqual(typeof v, 'string', k + ' is not a string');
  }
});

check('NARRATOR_HIGGS3_URL is emitted only when a server is already up', () => {
  assert.ok(!('NARRATOR_HIGGS3_URL' in env));
  const attached = higgs.higgsSpawnEnv(defaultVoice, {
    voicesPath: DOC_PATH, baseUrl: 'http://127.0.0.1:8095',
  });
  assert.strictEqual(attached.NARRATOR_HIGGS3_URL, 'http://127.0.0.1:8095');
});

check('NO adapter strategy is emitted while none has been established', () => {
  // Both strategies require a server restart and neither has been exercised on
  // higgs_multimodal_qwen3. narrator refuses an unknown one rather than guessing,
  // and the wrong guess is a server serving the BASE voice for a whole book.
  const m = probeVoice({
    kind: 'adapter',
    voice: { clips: [], adapterDir: '/home/x/ft' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
  });
  assert.ok(!('NARRATOR_HIGGS3_ADAPTER_STRATEGY' in higgs.higgsSpawnEnv(m, envOpts)));
});

check('a declared adapter strategy IS emitted', () => {
  const m = probeVoice({
    kind: 'adapter', adapterStrategy: 'merged-dir',
    voice: { clips: [], adapterDir: '/home/x/ft' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
  });
  assert.strictEqual(
    higgs.higgsSpawnEnv(m, envOpts).NARRATOR_HIGGS3_ADAPTER_STRATEGY, 'merged-dir');
});

check('a voice on a serving stack it does not match is REFUSED', () => {
  const wrong = Object.assign({}, defaultVoice, { engineVersion: 'v9' });
  assert.throws(() => higgs.higgsServingFor(wrong), /shared serving block is for/);
});

check('the cold start recorded is the MEASURED 297 s, under the 300 s limit', () => {
  // narrator's READY_TIMEOUT_SECONDS is 300 and its GPU smoke measured 297 —
  // three seconds of margin. Anything that decides a job is dead must clear it.
  const spec = higgs.higgsServingSpec();
  assert.strictEqual(spec.coldStartSeconds, 297);
  assert.strictEqual(spec.readyTimeoutSeconds, 300);
  assert.ok(spec.coldStartSeconds < spec.readyTimeoutSeconds);
});

check('the bridge watchdogs all clear that cold start', () => {
  // Read from the SOURCE, so tightening one of them without re-reading the cold
  // start fails here rather than four minutes into somebody's render.
  const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');
  const coldMs = higgs.higgsServingSpec().readyTimeoutSeconds * 1000;
  for (const name of ['WORKER_STARTUP_TIMEOUT_MS', 'WORKER_PROGRESS_TIMEOUT_MS',
                      'PREP_STALL_TIMEOUT_MS']) {
    const m = src.match(new RegExp('const ' + name + ' = (\\d+) \\* 60 \\* 1000'));
    assert.ok(m, name + ' is no longer an "<n> * 60 * 1000" literal — re-check it by hand');
    const ms = Number(m[1]) * 60 * 1000;
    assert.ok(ms > coldMs,
      name + ' is ' + ms + ' ms, which does not clear the ' + coldMs + ' ms Higgs cold start');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The doctor's patch table must agree with the catalog's
// ─────────────────────────────────────────────────────────────────────────────
console.log('doctor / catalog agreement');

const toolPaths = require(path.join(DIST, 'tool-paths.js'));

check('the two patch tables name the same patches with the same markers', () => {
  // They are deliberately separate copies (tool-paths must not depend on the
  // catalog JSON — a malformed catalog would break WSL detection). This is what
  // keeps them in step.
  const fromCatalog = higgs.higgsServingSpec().patches;
  const fromDoctor = toolPaths.HIGGS_PATCHES;
  assert.strictEqual(fromDoctor.length, fromCatalog.length);
  for (const p of fromCatalog) {
    const d = fromDoctor.find((x) => x.id === p.id);
    assert.ok(d, `the doctor does not know about patch "${p.id}"`);
    assert.strictEqual(d.marker, p.marker, `patch "${p.id}" has drifting markers`);
    assert.ok(d.relPath.endsWith(p.target) || p.target.endsWith(d.relPath),
      `patch "${p.id}" targets differ: ${d.relPath} vs ${p.target}`);
  }
});

check('each patch marker is a string the PRISTINE file cannot contain', () => {
  // A marker that is ordinary code would report "patched" on an unpatched file.
  for (const p of toolPaths.HIGGS_PATCHES) {
    assert.ok(p.marker.length > 8, `marker "${p.marker}" is too generic to be evidence`);
  }
});

check('the checked-in patch scripts actually introduce their markers', () => {
  // The doctor greps site-packages for these; if the shipped script does not
  // write them, an applied patch would report as missing forever.
  const dir = path.join(REPO, 'electron', 'scripts', 'higgs');
  const byId = {
    'vllm-negative-token-id': 'patch_vllm.py',
    'higgs-tail-trim': 'patch_tail_trim.py',
  };
  for (const p of toolPaths.HIGGS_PATCHES) {
    const src = fs.readFileSync(path.join(dir, byId[p.id]), 'utf-8');
    assert.ok(src.includes(p.marker), `${byId[p.id]} never writes the marker "${p.marker}"`);
  }
});

check('the WSL scripts are LF — a CRLF shebang is a bad interpreter', () => {
  const dir = path.join(REPO, 'electron', 'scripts', 'higgs');
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(path.join(dir, f));
    assert.ok(!buf.includes('\r'), `${f} contains CR bytes and will not run under bash`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The narrator contract constants
// ─────────────────────────────────────────────────────────────────────────────
console.log('narrator contract');

const spawnMod = require(path.join(DIST, 'higgs-spawn.js'));

check('the e2a prep scaffolding is GONE — Higgs preps on narrator', () => {
  // HIGGS_PREP_ENGINE_ALIAS/-ENV_ENGINE existed to tell e2a's packer `orpheus`
  // while running in the bundled env. narrator's paragraph packer IS the Higgs
  // chunking rule now, and the e2a route also wrote a session recording the
  // WRONG engine with no higgs_voice — which resume and retake read back.
  assert.strictEqual(spawnMod.HIGGS_PREP_ENGINE_ALIAS, undefined);
  assert.strictEqual(spawnMod.HIGGS_PREP_ENV_ENGINE, undefined);
  assert.strictEqual(spawnMod.higgsPrepMaxChars, undefined);
});

check('the worker names higgs-v3, which is what narrator must accept', () => {
  assert.strictEqual(spawnMod.HIGGS_NARRATOR_ENGINE, 'higgs-v3');
  assert.strictEqual(spawnMod.HIGGS_NARRATOR_ENGINE_ENV, 'higgs-v3');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. buildHiggsSpawn — the function that produces the actual command line
// ─────────────────────────────────────────────────────────────────────────────
//
// This section exists because the review found THREE defects inside
// buildHiggsSpawn and nothing tested it: the narrator package was resolved with a
// message that blamed packaging, Windows paths were never translated for the
// guest (the guard's character class held an escaped FORWARD slash and nothing
// else), and the worker argv carried a spurious --fine_tuned beside
// --higgs_voice. All three are argv/env facts, all three are testable without a
// GPU, and none of them was covered.
console.log('buildHiggsSpawn');

const B = String.fromCharCode(92); // backslash, built so no editor eats it

check('the drive-path guard matches BOTH separators', () => {
  // The exact regression: /^[A-Za-z]:[\/]/ is a class containing an escaped
  // forward slash only, so it matched 'C:/x' and missed 'C:\x' — and path.join
  // on win32 emits backslashes, so every --session_dir crossed into the guest
  // as a literal Windows path that narrator then refused.
  const guard = /^[A-Za-z]:[\\/]/;
  assert.strictEqual(guard.test('C:' + B + 'Users' + B + 'x'), true, 'backslash path missed');
  assert.strictEqual(guard.test('C:/Users/x'), true);
  assert.strictEqual(guard.test('E:' + B + 'training' + B + 'x'), true);
  assert.strictEqual(guard.test('/mnt/c/x'), false);
  assert.strictEqual(guard.test('--session_dir'), false);
  assert.strictEqual(guard.test('higgs-v3'), false);
});

check('narratorPythonRoot refuses by NAME when the package is not checked out', () => {
  // It used to say "this is a packaging bug", which sends a reader to
  // electron-builder config for a checkout problem. python/narrator lives on
  // feat/narrator, which lands first.
  let threw = null;
  try { spawnMod.narratorPythonRoot(); } catch (err) { threw = err; }
  if (!threw) return; // the package IS present (feat/narrator merged) — fine
  assert.match(threw.message, /narrator package is not in this checkout/);
  assert.match(threw.message, /feat\/narrator/, 'the refusal does not name the branch');
  assert.ok(!/packaging bug/i.test(threw.message), 'still blames packaging');
});

// A SCRATCH narrator package, so these run on this branch as well as after
// feat/narrator lands.
//
// This is not testing a fake: `narratorPythonRoot` only asks whether
// `narrator/__init__.py` exists, and everything under test — argv order, path
// translation, which flags are present — is BookForge's own construction, none of
// which reads a line of narrator's source. Skipping instead would have left the
// three defects the review found in exactly the state that let them ship.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-higgs-spawn-'));
fs.mkdirSync(path.join(SCRATCH, 'python', 'narrator'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'python', 'narrator', '__init__.py'), '');
APP_PATH = SCRATCH;
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

// FORCE THE WSL ARM. Without a tool-paths.json the toggle is off, so on Windows
// buildHiggsSpawn takes the native arm and correctly refuses ("vLLM-Omni has no
// Windows build") — which is right behaviour and the wrong thing to test here.
// The compiled bridge calls `(0, tool_paths_1.shouldUseWsl2ForHiggs)()` through
// the module object, so overriding it is a real seam and not a rewrite. Writing
// a tool-paths.json instead would edit the developer's own configuration.
const wslWasOn = toolPaths.shouldUseWsl2ForHiggs();
toolPaths.shouldUseWsl2ForHiggs = () => true;
const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (process.platform !== 'win32') {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
}
process.on('exit', () => {
  toolPaths.shouldUseWsl2ForHiggs = () => wslWasOn;
  if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
});

{
  const model = higgs.resolveHiggsModel('default');
  const WIN_SESSION = 'C:' + B + 'Users' + B + 't' + B + 'proj' + B + 'tmp' + B + 'ebook-abc';
  const WIN_SENTENCES = 'C:' + B + 'Users' + B + 't' + B + 'proj' + B + 'sentences';
  const workerArgs = [
    '--session', 'abc-123',
    '--session_dir', WIN_SESSION,
    '--sentences_dir', WIN_SENTENCES,
    '--device', 'CUDA',
    '--tts_engine', 'higgs-v3',
    '--sentence_start', '0', '--sentence_end', '99',
    '--higgs_voice', 'default',
  ];
  const plan = spawnMod.buildHiggsSpawn('worker', {
    model, args: workerArgs, cwd: REPO, jobId: 'job1',
  });
  const line = plan.viaWsl ? plan.args[plan.args.length - 1] : plan.args.join(' ');

  check('the worker spawns narrator.compat.worker, never an e2a script', () => {
    assert.match(line, /-m narrator\.compat\.worker/);
    assert.ok(!/worker\.py/.test(line), 'an e2a script path reached a Higgs spawn');
  });

  check('NO Windows path survives into the command line', () => {
    // The whole of finding 3, asserted on the real output rather than the regex.
    const leaked = line.match(/[A-Za-z]:[\\\\/][^' ]*/g);
    assert.strictEqual(leaked, null, 'untranslated Windows path(s): ' + leaked);
  });

  check('the session and sentences dirs arrive as /mnt/<drive>/… paths', () => {
    if (!plan.viaWsl) return; // native arm: Windows paths are correct there
    assert.match(line, /\/mnt\/c\/Users\/t\/proj\/tmp\/ebook-abc/);
    assert.match(line, /\/mnt\/c\/Users\/t\/proj\/sentences/);
  });

  check('every ENV value is translated too, not just argv', () => {
    if (!plan.viaWsl) return;
    // NARRATOR_HIGGS_VOICES is written to the Windows temp dir and must be named
    // in the guest's filesystem. It used to be translated by its own call, which
    // is how the argv guard's bug stayed invisible in a log.
    const m = line.match(/NARRATOR_HIGGS_VOICES='([^']+)'/);
    assert.ok(m, 'NARRATOR_HIGGS_VOICES is not exported');
    assert.match(m[1], /^\/mnt\/[a-z]\//, 'voices path is not a guest path: ' + m[1]);
  });

  check('the worker carries --higgs_voice and NOT --fine_tuned', () => {
    // Finding 10: pushVoiceArgs falls through to --fine_tuned for any engine it
    // does not recognise, so a Higgs worker carried both. They are a prompt TOKEN
    // and a CATALOG ID; one handed where the other belongs renders a whole book
    // in the wrong voice.
    assert.match(line, /--higgs_voice/);
    assert.ok(!/--fine_tuned/.test(line), '--fine_tuned reached a Higgs worker');
  });

  check('the engine is higgs-v3 in BOTH the flag and NARRATOR_ENGINE', () => {
    assert.match(line, /--tts_engine' 'higgs-v3'|--tts_engine higgs-v3/);
    assert.match(line, /NARRATOR_ENGINE='higgs-v3'|NARRATOR_ENGINE=higgs-v3/);
  });

  check('PYTHONPATH points at the narrator package, in the guest filesystem', () => {
    const m = line.match(/PYTHONPATH='([^']+)'/);
    assert.ok(m, 'PYTHONPATH is not exported');
    if (plan.viaWsl) assert.match(m[1], /^\/mnt\/[a-z]\//);
  });

  check('no ORPHEUS_* variable rides along', () => {
    assert.ok(!/ORPHEUS_/.test(line), 'an Orpheus variable leaked into a Higgs spawn');
  });

  const prep = spawnMod.buildHiggsSpawn('prep', {
    model,
    args: ['--headless', '--prep_only', '--ebook', 'C:' + B + 'books' + B + 'a.epub',
           '--session', 'abc', '--session_dir', WIN_SESSION,
           '--tts_engine', 'higgs-v3', '--higgs_voice', 'default'],
    cwd: REPO, jobId: 'job1',
  });
  const prepLine = prep.viaWsl ? prep.args[prep.args.length - 1] : prep.args.join(' ');

  check('prep goes to compat.app --prep_only, never to e2a', () => {
    assert.match(prepLine, /-m narrator\.compat\.app/);
    assert.match(prepLine, /--prep_only/);
    assert.ok(!/app\.py/.test(prepLine), 'e2a app.py reached a Higgs prep');
  });

  check('prep ALWAYS carries --session_dir', () => {
    // narrator has no e2a root to fall back to and refuses to guess; forwarding
    // E2A_TMP_DIR is not an alternative because it holds a Windows path.
    assert.match(prepLine, /--session_dir/);
  });

  const asm = spawnMod.buildHiggsSpawn('assembly', {
    model,
    args: ['--headless', '--output_dir', 'C:' + B + 'out', '--session', 'abc',
           '--session_dir', WIN_SESSION, '--assemble_only', '--no_split'],
    cwd: REPO, jobId: 'job1',
  });
  const asmLine = asm.viaWsl ? asm.args[asm.args.length - 1] : asm.args.join(' ');

  check('assembly goes to compat.app and omits --tts_engine', () => {
    // dispatch routes --assemble_only before any engine resolution, and the value
    // the argv would otherwise carry is the literal 'higgs' — a documented
    // ENGINE_NEAR_MISS that would be refused by name the moment assembly is gated.
    assert.match(asmLine, /-m narrator\.compat\.app/);
    assert.match(asmLine, /--assemble_only/);
    assert.ok(!/--tts_engine/.test(asmLine), 'assembly still sends --tts_engine');
  });

  check('assembly translates its paths too', () => {
    const leaked = asmLine.match(/[A-Za-z]:[\\\\/][^' ]*/g);
    assert.strictEqual(leaked, null, 'untranslated Windows path(s) in assembly: ' + leaked);
  });
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
