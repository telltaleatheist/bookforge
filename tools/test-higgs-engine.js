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
const { spawnSync } = require('child_process');
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
  orpheus: [{ value: 'o', label: 'o' }],
  higgs: [{ value: 'h', label: 'h' }],
};

check('higgs gets the HIGGS list, and no other', () => {
  // The regression this replaced: `engine === 'orpheus' ? orpheus : xtts` gave
  // the Higgs picker a list of XTTS reference clips, and nothing failed until a
  // render came back in the wrong voice.
  assert.deepStrictEqual(nv.narrationVoicesFor('higgs', CATALOG), CATALOG.higgs);
});

check('orpheus still gets the orpheus list', () => {
  assert.deepStrictEqual(nv.narrationVoicesFor('orpheus', CATALOG), CATALOG.orpheus);
});

check("a retired engine gets an EMPTY list — and never another engine's", () => {
  // This asserted `CATALOG.xtts` until 2026-09-05, when XTTS left the root: that
  // list was a live read of installed XTTS checkpoints, and there is nothing left
  // to read. Empty is the only true answer. What must NOT happen — and is what
  // this check is really for — is a retired id falling through to the Orpheus or
  // Higgs list, which would offer a voice the record was never rendered in.
  for (const retired of ['xtts', 'f5', 'voxtral']) {
    assert.deepStrictEqual(nv.narrationVoicesFor(retired, CATALOG), [], retired);
  }
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

check('the default voice is kind DEFAULT — not an empty clone', () => {
  // The shape an earlier draft got wrong. It wrote `clips: []` and called that
  // "the served default voice"; narrator REFUSES a ClipsVoice with zero clips,
  // and rightly — a zero-shot clone with no reference is not a degenerate clone,
  // it is the model's own built-in speaker, a different person (12 % of the
  // narrator's ECAPA ceiling). Same shape in the wire format made the two
  // indistinguishable.
  const m = higgs.listHiggsModels().find((v) => v.id === 'default');
  assert.strictEqual(m.kind, 'default');
  assert.ok(!('clips' in m.voice), "kind 'default' must not carry a clips key");
  assert.ok(!m.voice.adapterDir);
});

check('deathstalker is kind CHECKPOINT, text-only, and CERTIFIED', () => {
  // Renamed from 'adapter' on 2026-09-04: vllm-omni cannot load a LoRA at
  // runtime (no adapter flags; the talker class lacks SupportsLoRA), so what a
  // voice IS, as far as this catalog is concerned, is a merged ~8.5 GB
  // checkpoint directory the server is started on. The LoRA is an archival
  // input to that merge and never a catalog field.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.kind, 'checkpoint');
  assert.ok(m.voice.checkpointDir, 'the checkpoint dir is missing');
  assert.ok(!('adapterDir' in m.voice), 'the old adapterDir field survived the rename');
  assert.ok(!('clips' in m.voice), 'a fine-tune is prompted TEXT-ONLY — no clips key');
  // Certified 2026-09-05T12:52:57 against THIS directory. The _pendingNote was
  // the loader's refusal while the sweep was outstanding; it is gone because the
  // sweep ran on ckpt-1080 itself, not because the sibling's number was reused.
  assert.ok(!m._pendingNote, 'the certified voice still carries a _pendingNote');
});

check('the checkpoint dir is the PRODUCTION one, not the staging convention', () => {
  // NOT /home/<user>/higgs-models/<voice>, and not its sibling. A certificate
  // binds (checkpoint dir, stage-processor patch sha, max_chars) together: a cap
  // is measured by rendering against ONE directory on ONE patched server, so two
  // merges of the same run are two directories and two certificates. ckpt-1080
  // (lowest loss, chosen by ear 2026-09-05) is production; ckpt-480 stays on
  // disk as the alternate with its own certified 1200.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.voice.checkpointDir,
    '/home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080');
  assert.ok(m._checkpointDirNote, 'nothing says why this is not the higgs-models convention');
});

check('a checkpoint NOTE describes the directory its row actually points at', () => {
  // THIS CAUGHT A REAL ONE. Re-pointing deathstalker from ckpt-480 to ckpt-1080
  // moved `checkpointDir` and nulled the cap, but left the previous note in
  // place — so the entry shipped saying "THE CERTIFIED CAP IS BOUND TO THIS
  // EXACT DIRECTORY: the 1200 below was measured against .../ds_ad4lm_prod"
  // beside a checkpointDir of .../ds_ad4lm_prod_ckpt1080 and a maxChars of null.
  // Every other check passed, because they all asked whether the note EXISTED.
  //
  // Two rules, both about the note agreeing with its own row:
  //   1. it must NAME the directory the row points at;
  //   2. a row with no cap may not claim a certificate — that sentence belongs
  //      only to a row that carries the measured number.
  for (const m of higgs.listHiggsModels().filter((v) => v.kind === 'checkpoint')) {
    const note = m._checkpointDirNote;
    assert.ok(note, `${m.id}: a checkpoint voice off the staging convention needs a note`);
    assert.ok(note.includes(m.voice.checkpointDir),
      `${m.id}: the note never names ${m.voice.checkpointDir}, the directory this row serves`);
    if (m.backends.served.maxChars === null) {
      assert.ok(!/CERTIFIED CAP IS BOUND/.test(note),
        `${m.id}: maxChars is null, but the note claims a certified cap for this directory`);
    }
  }
});

check('the shape must match the kind — all six malformed pairings refused', () => {
  const cases = [
    ['default with clips', { kind: 'default',
      voice: { clips: [{ path: '/a.wav', transcript: 't', seconds: 5 }] } }],
    ['default with checkpointDir', { kind: 'default', voice: { checkpointDir: '/x' } }],
    ['checkpoint with no checkpointDir', { kind: 'checkpoint', voice: {},
      backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } } }],
    ['checkpoint with clips', { kind: 'checkpoint',
      voice: { checkpointDir: '/x', clips: [{ path: '/a.wav', transcript: 't', seconds: 5 }] },
      backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } } }],
    ['clips with none', { kind: 'clips', voice: { clips: [] } }],
    ['clips with a checkpointDir', { kind: 'clips',
      voice: { clips: [{ path: '/a.wav', transcript: 't', seconds: 5 }], checkpointDir: '/x' } }],
  ];
  for (const [why, overrides] of cases) {
    const m = probeVoice(overrides);
    assert.throws(() => higgs.higgsVoicesDocument(m), /Higgs voice "probe"/,
      why + ' was accepted');
  }
});

check('deathstalker carries its OWN certified cap, 1200 from a length sweep', () => {
  // Measured against ckpt-1080's own weights, not inherited from the sibling —
  // which is the whole discipline: a cap is bound to (directory, patch sha,
  // max_chars). Rule, quoted from the certificate: babble==0 across all seeds
  // AND min per-seed coverage >= 0.90, contiguous from the shortest tested
  // length. Ladder 150/300/600/900/1200; 1500 fails at 86.1 % coverage.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.backends.served.maxChars, 1200);
  assert.strictEqual(m.backends.served.maxCharsSource, 'length-sweep');
  const note = m.backends.served._maxCharsNote;
  assert.match(note, /97\.3/, 'the certified length\'s coverage is not recorded');
  assert.match(note, /86\.1/, 'the note does not say what stopped the ladder');
  assert.match(note, /0b36f6507dd11653/,
    'the note does not bind the cap to the server build it was measured on');
  assert.match(note, /max_chars_certificate_ckpt1080\.json/,
    'the note does not name the certificate file');
});

check("EVERY kind:'checkpoint' voice states its cap — measured, or null", () => {
  // The catalog-wide rule the loader refuses on, asserted over the shipped file
  // rather than over a synthesised entry, so a voice added later cannot ship
  // without its own sweep. Two legal states and no third: a RENDERABLE fine-tune
  // carries a positive integer with a source narrator's vocabulary knows; a
  // PENDING one declares null/null, which is "unmeasured", not "unspecified".
  const KNOWN_SOURCES = ['catalog', 'placeholder', 'length-sweep'];
  const fineTunes = higgs.listHiggsModels().filter((m) => m.kind === 'checkpoint');
  assert.ok(fineTunes.length > 0, 'no fine-tune in the catalog to check');
  for (const m of fineTunes) {
    const served = m.backends.served;
    if (m._pendingNote) {
      assert.strictEqual(served.maxChars, null,
        `${m.id}: pending, so its cap must be a DECLARED null`);
      assert.strictEqual(served.maxCharsSource, null,
        `${m.id}: pending, so it can name no source`);
      continue;
    }
    assert.ok(Number.isInteger(served.maxChars) && served.maxChars > 0,
      `${m.id}: maxChars is ${JSON.stringify(served.maxChars)}, not a positive integer`);
    assert.ok(typeof served.maxCharsSource === 'string' && served.maxCharsSource.trim(),
      `${m.id}: maxChars ${served.maxChars} with no maxCharsSource`);
    // narrator VALIDATES this vocabulary (protocol.MAX_CHARS_SOURCES) and the
    // value travels in the voice document, so a prose provenance string here is
    // a render refused at load_voices. The prose belongs in _maxCharsNote.
    assert.ok(KNOWN_SOURCES.includes(served.maxCharsSource),
      `${m.id}: maxCharsSource ${JSON.stringify(served.maxCharsSource)} is not one of ` +
      KNOWN_SOURCES.join(' | ') + " — narrator's load_voices refuses it by name");
  }
});

check("deathstalker's sampling MIRRORS its checkpoint dir's generation_config.json", () => {
  // The directory is the authority: vllm-omni resolves sampling from the model
  // directory and OpenAICreateSpeechRequest carries no sampling fields, so
  // nothing per-request can correct it. This block is a mirror kept so a reader
  // can see what the voice samples at without opening a directory inside WSL —
  // and a mirror nobody checks is how two copies of a number diverge. These are
  // the values read out of
  // /home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080/generation_config.json
  // on 2026-09-05 and recorded in docs/HIGGS_ENGINE.md. (Its sibling ckpt-480
  // dir holds the same four numbers — both were written from the same recorded
  // per-run override — so this check does not distinguish the directories; the
  // path assertion above is what does.)
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.deepStrictEqual(m.backends.served.sampling,
    { temperature: 1, topP: 0.95, topK: 50 });
  assert.ok(m.backends.served._samplingNote,
    'nothing records that the directory, not this block, is the authority');
});

check('the pending rule still holds over whatever the catalog ships', () => {
  // Offering-and-refusing is the honest pair; hiding-and-forgetting is not. No
  // voice ships pending today (deathstalker was promoted 2026-09-05), so this
  // asserts the RULE over every row rather than over one row that happens to be
  // in one of the two states.
  const renderable = new Set(higgs.listRenderableHiggsModels().map((m) => m.id));
  const offered = new Map(higgs.higgsNarrationVoices().map((v) => [v.value, v]));
  for (const m of higgs.listHiggsModels()) {
    if (m._pendingNote) {
      assert.ok(!renderable.has(m.id), `${m.id} is pending but in the renderable set`);
      const row = offered.get(m.id);
      assert.ok(row, `${m.id} is pending and not listed at all`);
      assert.match(row.label, /not installed yet/);
      assert.ok(row.unavailable, `${m.id} is offered pending with no reason`);
    } else {
      assert.ok(renderable.has(m.id), `${m.id} is not pending but not renderable`);
      const row = offered.get(m.id);
      if (row) assert.ok(!row.unavailable, `${m.id} is renderable but offered as unavailable`);
    }
  }
});

check('resolveHiggsModel REFUSES an unknown voice and lists the known ones', () => {
  let threw = null;
  try { higgs.resolveHiggsModel('nobody'); } catch (err) { threw = err; }
  assert.ok(threw, 'an unknown Higgs voice resolved');
  assert.match(threw.message, /nobody/);
  assert.match(threw.message, /default/, 'the refusal does not say what IS available');
});

// The spawn-env probe options, declared here because the two checks below need
// them and `PROMOTED_ENV_OPTS` in section 4 has not been initialised yet at this point.
const PROMOTED_ENV_OPTS = { voicesPath: '/mnt/c/tmp/higgs-probe-voices.json' };

check('resolveHiggsModel RESOLVES the certified deathstalker — no refusal left', () => {
  // Every refusal this voice used to trip — pending, malformed, unmeasured cap,
  // oversized reference — must now pass, and it must build a real spawn env.
  const m = higgs.resolveHiggsModel('deathstalker');
  assert.strictEqual(m.id, 'deathstalker');
  assert.strictEqual(m.kind, 'checkpoint');
  assert.ok(higgs.higgsSpawnEnv(m, PROMOTED_ENV_OPTS).NARRATOR_HIGGS_VOICES,
    'the certified voice cannot build a spawn env');
});

check('MUTATION: null the certified cap and the refusal comes straight back', () => {
  // The guard is only real if removing the measurement restores the refusal.
  // Driven on CLONES of the SHIPPED row, so the rule is asserted against the
  // catalog's own entry rather than a synthesised one.
  const shipped = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  const nulled = JSON.parse(JSON.stringify(shipped));
  nulled.backends.served.maxChars = null;
  nulled.backends.served.maxCharsSource = null;
  let threw = null;
  try { higgs.higgsSpawnEnv(nulled, PROMOTED_ENV_OPTS); } catch (err) { threw = err; }
  assert.ok(threw, 'a fine-tune with a nulled cap was accepted');
  assert.match(threw.message, /MEASURED maxChars/);
  assert.match(threw.message, /length sweep/);

  // The number alone is not evidence either — that is the shape an INHERITED
  // cap would take, a figure copied across with no method beside it.
  const noSource = JSON.parse(JSON.stringify(shipped));
  delete noSource.backends.served.maxCharsSource;
  assert.throws(() => higgs.higgsSpawnEnv(noSource, PROMOTED_ENV_OPTS), /MEASURED maxChars/);
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
/**
 * A synthesised catalog entry. Defaults to kind 'default' — the one shape that
 * needs neither clips nor an adapter — so a test that is not about shape does
 * not have to state one, and so the default itself is never accidentally the
 * malformed `clips: []` this file used to build.
 */
function probeVoice(overrides) {
  return Object.assign({
    id: 'probe', label: 'probe', kind: 'default', engineVersion: 'v3',
    voice: {},
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
      kind: 'clips',
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
      kind: 'clips',
      voice: { clips: [{ path: '/tmp/a.wav', transcript: 'hello there', seconds: bad }] },
    });
    assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /duration/i,
      'seconds ' + JSON.stringify(bad) + ' was accepted');
  }
});

check('TWO reference clips are REFUSED — vllm-omni takes exactly one', () => {
  const m = probeVoice({
    kind: 'clips',
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
    kind: 'clips',
    voice: { clips: [{ path: '/tmp/a.wav', transcript: 'long one', seconds: 42 }] },
  });
  assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /cap/);
});

check('a 27 s single joined reference PASSES', () => {
  const m = probeVoice({
    kind: 'clips',
    voice: { clips: [{ path: '/tmp/joined.wav', transcript: 'a joined pair', seconds: 27.4 }] },
  });
  const e = higgs.higgsSpawnEnv(m, envOpts);
  assert.strictEqual(e.NARRATOR_HIGGS_VOICES, DOC_PATH);
});

check('a checkpoint with NO measured maxChars is REFUSED, and the message says why', () => {
  const m = probeVoice({
    kind: 'checkpoint',
    voice: { checkpointDir: '/home/x/higgs-models/probe' },
    backends: { served: { maxChars: null, maxCharsSource: null } },
  });
  let threw = null;
  try { higgs.higgsSpawnEnv(m, envOpts); } catch (err) { threw = err; }
  assert.ok(threw, 'an unmeasured fine-tune was accepted');
  assert.match(threw.message, /TRAINING CLIP LENGTH/);
  assert.match(threw.message, /length sweep/);
});

check('a checkpoint inheriting the zero-shot 600 with no source is still REFUSED', () => {
  // The number alone is not evidence; maxCharsSource is what makes it one.
  const m = probeVoice({
    kind: 'checkpoint',
    voice: { checkpointDir: '/home/x/higgs-models/probe' },
    backends: { served: { maxChars: 600 } },
  });
  assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /MEASURED maxChars/);
});

check('a checkpoint WITH a measured cap and its source passes', () => {
  const m = probeVoice({
    kind: 'checkpoint',
    voice: { checkpointDir: '/home/x/higgs-models/probe' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
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
  assert.strictEqual(c.maxCharsSource, 'placeholder');
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
  assert.strictEqual(doc.default.kind, 'default');
  assert.strictEqual(doc.default.maxReferenceSeconds, 30);
  assert.deepStrictEqual(doc.default.allowedControls, []);
});

check('a clone voice document carries path, transcript AND seconds', () => {
  const m = probeVoice({
    id: 'ds', kind: 'clips',
    voice: { clips: [{ path: '/a/joined.wav', transcript: 'He said it was here.', seconds: 27.4 }] },
  });
  const doc = higgs.higgsVoicesDocument(m);
  assert.deepStrictEqual(doc.ds.clips, [
    { path: '/a/joined.wav', transcript: 'He said it was here.', seconds: 27.4 },
  ]);
});

check('a checkpoint document carries checkpointDir AND its measured cap AND kind', () => {
  // THE CAP MUST TRAVEL. narrator's load_voices raises for a fine-tune entry with
  // no `maxChars` — so `refuseUnmeasuredAdapter` was guarding a number that never
  // reached the engine, and the day deathstalker is promoted with its length
  // sweep the render would have been refused while the measurement sat in a JSON
  // file nobody read. `kind` is stated rather than left to narrator's derivation
  // (absent + checkpointDir => 'checkpoint'), so the refusal path infers nothing.
  const m = probeVoice({
    id: 'ft', kind: 'checkpoint',
    voice: { checkpointDir: '/home/x/higgs-models/ft' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
  });
  const doc = higgs.higgsVoicesDocument(m);
  assert.strictEqual(doc.ft.checkpointDir, '/home/x/higgs-models/ft');
  assert.ok(!('clips' in doc.ft), 'a fine-tune is TEXT-ONLY — no clips key');
  assert.ok(!('adapterDir' in doc.ft), 'the old adapterDir key is still emitted');
  assert.strictEqual(doc.ft.kind, 'checkpoint');
  assert.strictEqual(doc.ft.maxChars, 1350);
  assert.strictEqual(doc.ft.maxCharsSource, 'length-sweep');
});

check('the default document carries its cap too, so nothing is inferred', () => {
  // narrator would otherwise fall back to HiggsV3Defaults.MAX_CHARS — also 600,
  // and labelled a placeholder on that side. The two agreeing today is a
  // coincidence, not a contract.
  const doc = higgs.higgsVoicesDocument(defaultVoice);
  assert.strictEqual(doc.default.kind, 'default');
  assert.ok(!('clips' in doc.default), "kind 'default' must not emit a clips key");
  assert.strictEqual(doc.default.maxChars, 600);
  // narrator VALIDATES this vocabulary: 'catalog' | 'placeholder' | 'length-sweep'.
  assert.strictEqual(doc.default.maxCharsSource, 'placeholder');
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

check('NO adapter-strategy variable is emitted, ever — there is no LoRA path', () => {
  // Deleted 2026-09-04. NARRATOR_HIGGS3_ADAPTER_STRATEGY existed to choose
  // between 'lora-modules' and 'merged-dir' once someone established which
  // vllm-omni accepted. The answer is NEITHER-as-a-choice: vllm-omni cannot load
  // a LoRA at runtime at all (no adapter flags on `vllm-omni serve`; the
  // higgs_audio_v3 talker class does not implement SupportsLoRA), so a voice is
  // always a merged checkpoint and there is nothing to select between.
  const m = probeVoice({
    kind: 'checkpoint',
    voice: { checkpointDir: '/home/x/ft' },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
  });
  const e = higgs.higgsSpawnEnv(m, envOpts);
  assert.ok(!('NARRATOR_HIGGS3_ADAPTER_STRATEGY' in e));
  assert.deepStrictEqual(
    Object.keys(e).filter((k) => /ADAPTER|LORA/i.test(k)), [],
    'an adapter/LoRA variable survives in the spawn env',
  );
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
    // The absent-marker travels with the marker or the two tables mean different
    // things by "applied" — one would accept a file the other calls half-patched.
    assert.strictEqual(d.absentMarker, p.absentMarker,
      `patch "${p.id}" has drifting absent-markers`);
    assert.ok(d.relPath.endsWith(p.target) || p.target.endsWith(d.relPath),
      `patch "${p.id}" targets differ: ${d.relPath} vs ${p.target}`);
  }
});

check('the sentinel-filter patch is the one the Higgs stack requires', () => {
  // The rename is the point: patch_tail_trim.py was a band-aid that trimmed the
  // trailing run by position and kept the 0-substitution everywhere else, and it
  // is retired. Both tables must name the replacement, and the doctor must ask
  // for the string only the replacement writes.
  const fromCatalog = higgs.higgsServingSpec().patches.find(
    (p) => p.id === 'higgs-sentinel-filter');
  assert.ok(fromCatalog, 'the catalog does not require the sentinel filter');
  assert.strictEqual(fromCatalog.script, 'patch_sentinel_filter.py');
  assert.strictEqual(fromCatalog.marker, '_filter_sentinel_frames');
  assert.strictEqual(fromCatalog.absentMarker, '[:, :-1]');
  for (const table of [higgs.higgsServingSpec().patches, toolPaths.HIGGS_PATCHES]) {
    assert.ok(!table.some((p) => p.id === 'higgs-tail-trim'),
      'the retired tail-trim patch is still required somewhere');
    assert.ok(!table.some((p) => p.marker === '_trim_trailing_sentinel_frames'),
      'a table still greps for the helper BOTH patches write — that certifies the band-aid');
  }
});

check('each patch marker is a string the PRISTINE file cannot contain', () => {
  // A marker that is ordinary code would report "patched" on an unpatched file.
  for (const p of toolPaths.HIGGS_PATCHES) {
    assert.ok(p.marker.length > 8, `marker "${p.marker}" is too generic to be evidence`);
  }
});

check('the checked-in patch scripts introduce their markers AND remove the trim', () => {
  // The doctor greps site-packages for these; if the shipped script does not
  // write them, an applied patch would report as missing forever. And the
  // absent-marker is the other half of the sentinel filter's proof: the script
  // must REFUSE to write a file that still carries upstream's one-frame trim,
  // which is what `[:, :-1]` is.
  const dir = path.join(REPO, 'electron', 'scripts', 'higgs');
  const byId = {
    'vllm-negative-token-id': 'patch_vllm.py',
    'higgs-sentinel-filter': 'patch_sentinel_filter.py',
  };
  for (const p of toolPaths.HIGGS_PATCHES) {
    const src = fs.readFileSync(path.join(dir, byId[p.id]), 'utf-8');
    assert.ok(src.includes(p.marker), `${byId[p.id]} never writes the marker "${p.marker}"`);
    if (p.absentMarker) {
      assert.ok(src.includes('ABSENT_MARKER'),
        `${byId[p.id]} declares no ABSENT_MARKER, so nothing checks the trim is gone`);
      assert.ok(src.includes(p.absentMarker),
        `${byId[p.id]} does not name the absent-marker "${p.absentMarker}" the doctor greps for`);
    }
  }
});

check('the RETIRED patch_tail_trim.py is gone from the shipped scripts', () => {
  // It was superseded on 2026-09-05 and deleted rather than left beside its
  // replacement. The two edit the same file and must never stack; a retired
  // script sitting next to the live one is how a retirement gets undone by
  // somebody tidying up — and patch_sentinel_filter.py has to REPAIR a file that
  // carries the band-aid (it restores from .orig first), so the band-aid being
  // reachable is a live hazard, not a cosmetic one.
  const dir = path.join(REPO, 'electron', 'scripts', 'higgs');
  assert.ok(!fs.existsSync(path.join(dir, 'patch_tail_trim.py')),
    'the retired patch_tail_trim.py is still shipped');
  assert.ok(fs.existsSync(path.join(dir, 'patch_sentinel_filter.py')));
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
// The REAL host, captured before the override: two checks below assert on paths the
// code derives from the host (os.tmpdir(), the repo root), which are drive paths only
// on Windows. On a Mac/Linux host they are POSIX paths that toGuestPath passes through
// unchanged by design, so those two checks are host-conditional (Mac run, 2026-09-05).
const REAL_HOST = process.platform;
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
    if (REAL_HOST !== 'win32') return; // host tmpdir is POSIX here; nothing to translate
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
    if (plan.viaWsl && REAL_HOST === 'win32') assert.match(m[1], /^\/mnt\/[a-z]\//); // repo root is a drive path only on Windows
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

  check('the WSL arm translates catalog paths INSIDE the voice document', () => {
    // NEW-3: the document used to be written with raw catalog paths, so a
    // host-native path reached the guest untranslated. It is translated at
    // write time, per arm — not stored pre-translated, which is right on the
    // WSL arm by accident and meaningless on macOS/Linux.
    const m = probeVoice({
      id: 'winclone', kind: 'clips',
      voice: { clips: [{
        path: 'C:' + B + 'refs' + B + 'joined.wav', transcript: 'a joined pair', seconds: 27.4,
      }] },
      backends: { served: { maxChars: 600, maxCharsSource: 'catalog', referenceSecondsCap: 30, allowedControls: [] } },
    });
    const p2 = spawnMod.buildHiggsSpawn('worker', {
      model: m, args: workerArgs, cwd: REPO, jobId: 'jobpaths',
    });
    const docPath = (p2.viaWsl ? p2.args[p2.args.length - 1] : p2.args.join(' '))
      .match(/NARRATOR_HIGGS_VOICES='([^']+)'/);
    assert.ok(docPath, 'no voices document was named');
    // Read the document off the WINDOWS side — it is written there and only
    // NAMED in guest form.
    const hostDoc = docPath[1].replace(/^\/mnt\/([a-z])\//, (_m, d) => d.toUpperCase() + ':/');
    const doc = JSON.parse(fs.readFileSync(hostDoc, 'utf-8'));
    assert.strictEqual(doc.winclone.clips[0].path, '/mnt/c/refs/joined.wav',
      'the clip path was not translated for the guest');
  });

  check('a \\\\wsl$ UNC catalog path becomes a guest path, not a UNC string', () => {
    // The form tool-paths.ts documents for orpheusModelsDir on a Windows+WSL
    // machine: the models dir lives on ext4 and is NAMED from Windows as a UNC.
    // Handling only drive letters would translate a session dir correctly and
    // leave this one unusable.
    const m = probeVoice({
      id: 'uncft', kind: 'checkpoint',
      voice: { checkpointDir: B+B + 'wsl$' + B + 'Ubuntu' + B + 'home' + B + 't' + B + 'higgs-models' + B + 'ds' },
      backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep', referenceSecondsCap: 30, allowedControls: [] } },
    });
    const p3 = spawnMod.buildHiggsSpawn('worker', {
      model: m, args: workerArgs, cwd: REPO, jobId: 'jobunc',
    });
    const docPath = (p3.viaWsl ? p3.args[p3.args.length - 1] : p3.args.join(' '))
      .match(/NARRATOR_HIGGS_VOICES='([^']+)'/);
    const hostDoc = docPath[1].replace(/^\/mnt\/([a-z])\//, (_m, d) => d.toUpperCase() + ':/');
    const doc = JSON.parse(fs.readFileSync(hostDoc, 'utf-8'));
    assert.strictEqual(doc.uncft.checkpointDir, '/home/t/higgs-models/ds',
      'the UNC checkpoint path was not translated');
  });

  check('an already-guest-form path passes through unchanged', () => {
    // What makes the translation safe to apply to argv, to env values and to
    // catalog paths without tracking which were already translated.
    const m = probeVoice({
      id: 'guestft', kind: 'checkpoint',
      voice: { checkpointDir: '/home/t/higgs-models/ds' },
      backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep', referenceSecondsCap: 30, allowedControls: [] } },
    });
    const p4 = spawnMod.buildHiggsSpawn('worker', {
      model: m, args: workerArgs, cwd: REPO, jobId: 'jobguest',
    });
    const docPath = (p4.viaWsl ? p4.args[p4.args.length - 1] : p4.args.join(' '))
      .match(/NARRATOR_HIGGS_VOICES='([^']+)'/);
    const hostDoc = docPath[1].replace(/^\/mnt\/([a-z])\//, (_m, d) => d.toUpperCase() + ':/');
    const doc = JSON.parse(fs.readFileSync(hostDoc, 'utf-8'));
    assert.strictEqual(doc.guestft.checkpointDir, '/home/t/higgs-models/ds');
  });

  check('the NATIVE arm writes catalog paths through UNCHANGED', () => {
    // macOS/Linux: there is no guest, so translation would corrupt a perfectly
    // good host path. Driven by turning the WSL toggle off, which is the same
    // seam the arm-forcing above uses.
    toolPaths.shouldUseWsl2ForHiggs = () => false;
    const origPlat = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const m = probeVoice({
        id: 'macclone', kind: 'clips',
        voice: { clips: [{ path: '/Users/t/refs/joined.wav', transcript: 'a pair', seconds: 27.4 }] },
        backends: { served: { maxChars: 600, maxCharsSource: 'catalog', referenceSecondsCap: 30, allowedControls: [] } },
      });
      const written = higgs.writeHiggsVoicesDocument(m, 'jobmac');
      const doc = JSON.parse(fs.readFileSync(written, 'utf-8'));
      assert.strictEqual(doc.macclone.clips[0].path, '/Users/t/refs/joined.wav',
        'a native-arm path was translated when it should not have been');
      fs.rmSync(written, { force: true });
    } finally {
      Object.defineProperty(process, 'platform', origPlat);
      toolPaths.shouldUseWsl2ForHiggs = () => true;
    }
  });

  check('assembly translates its paths too', () => {
    const leaked = asmLine.match(/[A-Za-z]:[\\\\/][^' ]*/g);
    assert.strictEqual(leaked, null, 'untranslated Windows path(s) in assembly: ' + leaked);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. The refusal is WIRED, not merely defined
// ─────────────────────────────────────────────────────────────────────────────
//
// The review's finding 7 was not "assertRunnableTtsEngine has no call site" but
// something sharper: no main-process file imported `engine-caps` AT ALL, so the
// refusal four source comments and the design doc promised could not exist. A
// legacy `xtts` job re-run from the queue page went straight to a spawn.
//
// These assert the wiring by reading the SOURCE, because the alternative is
// booting Electron's IPC layer to prove an import exists.
console.log('the retired-engine refusal is wired');

const mainSrc = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
const bridgeSrc = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');

check('main imports the engine table — it is in shared/ so that main CAN', () => {
  assert.match(mainSrc, /import \{[^}]*assertRunnableTtsEngine[^}]*\} from '\.\.\/shared\/tts\/engine-caps'/);
});

check('no COMPILED main-process module requires an @shared alias', () => {
  // Caught for real on 2026-09-05: tsconfig.electron.json defines `@shared/*`
  // for TYPE resolution and tsc emits the specifier VERBATIM, so
  // `import ... from '@shared/tts/engine-caps'` compiled clean, passed both tsc
  // configs and ng build, and then threw MODULE_NOT_FOUND the instant Node
  // loaded parallel-tts-bridge.js — which main requires, so the whole main
  // process was broken. Every other electron/ file reaches shared/ relatively.
  const dir = path.join(REPO, 'dist', 'electron');
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (/require\("@shared\//.test(fs.readFileSync(full, 'utf-8'))) {
        offenders.push(path.relative(REPO, full));
      }
    }
  };
  walk(dir);
  assert.deepStrictEqual(offenders, [],
    'these compiled modules require an unresolvable alias: ' + offenders.join(', '));
});

check('the queue boundary refuses a retired engine before anything spawns', () => {
  // narrationInputRefusal is the main-process door every narration run goes
  // through, and it runs BEFORE the queue reports "running".
  const at = mainSrc.indexOf('const narrationInputRefusal');
  assert.ok(at > 0, 'narrationInputRefusal is gone — the gate moved');
  const body = mainSrc.slice(at, at + 2500);
  assert.match(body, /assertRunnableTtsEngine/,
    'the queue boundary does not check the engine');
  assert.match(body, /settings\?\.ttsEngine/,
    'the check does not read the engine off the job config');
});

check('the retake door refuses a retired engine too', () => {
  // It reads settings.ttsEngine straight out of session_state.json, so an old
  // XTTS book reaches it with no UI in between.
  const at = bridgeSrc.indexOf('export async function regenerateSentenceIndices');
  assert.ok(at > 0, 'regenerateSentenceIndices is gone');
  const body = bridgeSrc.slice(at, at + 4000);
  assert.match(body, /assertRunnableTtsEngine/, 'the retake door is ungated');
});

check('the retake door routes Higgs to narrator instead of e2a worker.py', () => {
  // Finding 8: it built pythonInvocation('higgs'), which returns the MARKER path
  // <e2a>/higgs_wsl_env — not a directory — and handed it e2a's worker.py.
  //
  // UPDATED at the Phase 3 cut-over. The `higgsRetakePlan` branch this used to
  // look for is gone, and so is the e2a command line it existed to differ from:
  // the door now builds ONE argv and hands it to `buildJobSpawn`, which routes by
  // engine. The intent is unchanged and is what is asserted — a Higgs retake
  // reaches narrator's worker module and carries --higgs_voice, never
  // --fine_tuned and never a script path.
  const at = bridgeSrc.indexOf('export async function regenerateSentenceIndices');
  const body = bridgeSrc.slice(at, at + 12000);
  assert.match(body, /buildJobSpawn\(\{/, 'the retake door does not go through the engine-routing spawn');
  assert.match(body, /phase: 'worker'/, 'the retake door does not open the worker door');
  assert.match(body, /HIGGS_VOICE_FLAG/, 'the Higgs retake does not pass --higgs_voice');
  // COMMENTS STRIPPED FIRST — BLOCK COMMENTS TOO. The door's prose still explains
  // what it used to do and why (the marker-path failure; what `compat/` answers),
  // and a few lines on a block comment records the Sep 1 2026 incident in which an
  // orphaned e2a worker.py rendered for 1h31m. That history is the reason the code
  // is shaped as it is. Asserting on the raw text would make the file's own
  // explanation the thing that fails it, which teaches people to delete comments
  // rather than write them.
  //
  // NO `$` ON THE LINE-COMMENT PATTERN. This repo is core.autocrlf=true, so a
  // split on '\n' leaves a '\r' at the end of every line; `.` does not match a
  // carriage return (it is a line terminator) and `$` without /m anchors to the
  // end of the whole string, so `/\/\/.*$/` matches NOTHING on a CRLF file and
  // every comment survives the strip.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
  assert.ok(!/worker\.py/.test(code), "e2a's worker.py is still SPAWNED by the retake door");
});

check('an Orpheus render with NO voice is refused, not defaulted', () => {
  // narrator has no self-limiting failure here the way e2a did: with no
  // `--fine_tuned`, `engine/orpheus/engine.py` takes DEFAULT_VOICE, validates
  // 'leah' as a legal stock voice, and renders the whole book in it with exit 0.
  // Asserted on the SOURCE (comments stripped) because pushVoiceArgs is
  // module-private and its inputs are a live settings object; what must not come
  // back is the shape where an absent voice reaches the argv builder unremarked.
  const at = bridgeSrc.indexOf('function pushVoiceArgs');
  assert.ok(at > 0, 'pushVoiceArgs is gone or renamed');
  const body = bridgeSrc.slice(at, at + 6000)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
  assert.match(body, /if \(!requested\)\s*\{[\s\S]{0,400}throw new Error\(/,
    'pushVoiceArgs no longer refuses an absent Orpheus voice — narrator would '
    + "render the whole book in 'leah' and report success");
  // And the refusal has to NAME the consequence, or it reads as a validation nit.
  // COMMENT-STRIPPED `body`, not raw `bridgeSrc`. Scanning the raw source meant the
  // guard could be satisfied by prose: a comment mentioning leah anywhere in those
  // 700 characters passed the check while the thrown message said nothing about it.
  // The retake door a few rows down already strips comments; this now matches.
  const at2 = body.indexOf('if (!requested)');
  assert.match(body.slice(at2, at2 + 700),
    /leah/, 'the refusal does not name the voice the book would have been rendered in');
  assert.ok(at2 < body.indexOf('ORPHEUS_STOCK_VOICES.includes(requested)'),
    'the absent-voice refusal must come BEFORE the not-installed one, or an absent '
    + 'voice falls through it');
});

check('no Higgs door calls pushVoiceArgs — that flag is Orpheus-shaped', () => {
  // Finding 10: one call site was not guarded, so a Higgs worker carried BOTH
  // `--fine_tuned default` and `--higgs_voice default`. They are a prompt TOKEN
  // and a CATALOG ID; one handed where the other belongs renders a whole book in
  // the wrong voice.
  //
  // UPDATED at the Phase 3 cut-over. The guard used to be `if
  // (!isHiggsJob(settings)) pushVoiceArgs(...)` with the Higgs voice appended
  // somewhere else; every door now writes the CHOICE in one place —
  // `if (isHiggsJob(settings)) { args.push(HIGGS_VOICE_FLAG, ...) } else {
  // pushVoiceArgs(...) }` — which is the same rule stated so that neither branch
  // can be forgotten. So the assertion is now that each call site sits in the
  // ELSE of a Higgs test, rather than after a negated one.
  let from = 0;
  let guarded = 0;
  let total = 0;
  for (;;) {
    const at = bridgeSrc.indexOf('pushVoiceArgs(args, settings)', from);
    if (at < 0) break;
    total++;
    const before = bridgeSrc.slice(Math.max(0, at - 400), at);
    // Either shape counts: the old negated guard, or the if/else that replaced it
    // (recognised by the Higgs test AND the voice flag its branch pushes).
    if (/!isHiggsJob\(settings\)/.test(before)
      || (/if \(isHiggsJob\(settings\)\)/.test(before) && /HIGGS_VOICE_FLAG/.test(before))) {
      guarded++;
    }
    from = at + 1;
  }
  assert.ok(total >= 3, 'expected at least 3 pushVoiceArgs call sites, saw ' + total);
  assert.strictEqual(guarded, total,
    (total - guarded) + ' of ' + total + ' pushVoiceArgs call sites are not guarded against Higgs');
});

check('the CLI accepts higgs for --mode tts and refuses it for streaming', () => {
  // The standing rule is that the CLI mirrors the app's code path; the branch
  // had added an engine the headless door could not run.
  const cli = fs.readFileSync(path.join(REPO, 'cli', 'bookforge-tts.py'), 'utf-8');
  assert.match(cli, /args\.engine in \("orpheus", "higgs"\)/,
    'the CLI still refuses --engine higgs');
  assert.match(cli, /has no streaming path/,
    'the CLI does not refuse Higgs streaming by name');
  const adapter = fs.readFileSync(path.join(REPO, 'cli', 'orpheus-batch-render.js'), 'utf-8');
  assert.match(adapter, /ttsEngine: engine/,
    'the batch adapter still hardcodes the engine');
});

check('the dropdown offers FINE-TUNES and the default — never a clone', () => {
  // Owen, 2026-09-04: production is fine-tuned voices only. A clone recovers 92 %
  // of the narrator's speaker identity and none of his phrasing (2.01 pauses per
  // 100 chars against his 1.39; pitch std 5.17 st against 4.36) — which is the
  // gap a fine-tune exists to close — so listing one beside a fine-tune invites
  // picking it for a book.
  //
  // The `clips` SHAPE stays fully supported below the picker: the loader
  // validates it, the document emits it, and the narrator cross-check drives
  // narrator's real loader with one. It is simply never offered.
  const offered = higgs.higgsNarrationVoices().map((v) => v.value);
  const byId = new Map(higgs.listHiggsModels().map((m) => [m.id, m]));
  for (const id of offered) {
    const kind = byId.get(id).kind;
    assert.ok(kind === 'checkpoint' || kind === 'default',
      `the dropdown offers "${id}", which is kind '${kind}'`);
  }
  // And the catalog is still ABLE to hold a clone — this is a policy about the
  // picker, not a hole in the shape support.
  assert.doesNotThrow(() => higgs.higgsVoicesDocument(probeVoice({
    id: 'diag', kind: 'clips',
    voice: { clips: [{ path: '/a.wav', transcript: 'a line', seconds: 12 }] },
    backends: { served: { maxChars: 600, maxCharsSource: 'catalog', referenceSecondsCap: 30, allowedControls: [] } },
  })));
});

check('the certified voice is offered SELECTABLE, with no warning attached', () => {
  // Finding 11 was the opposite state: a pending voice offered label-only and
  // fully selectable, so it queued a run that died at preflight. Now that
  // deathstalker renders, the row must carry no `unavailable` at all — a row
  // marked unavailable is rendered DISABLED by the picker, which would hide the
  // one production fine-tune behind a note that is no longer true.
  const row = higgs.higgsNarrationVoices().find((v) => v.value === 'deathstalker');
  assert.ok(row, 'the production fine-tune is not listed at all');
  assert.ok(!row.unavailable, 'the certified voice is still offered as unavailable');
  assert.ok(!/not installed/.test(row.label), 'the label still says not installed');
  const ok = higgs.higgsNarrationVoices().find((v) => v.value === 'default');
  assert.ok(!ok.unavailable, 'a renderable voice was marked unavailable');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. The document, through NARRATOR'S OWN load_voices
// ─────────────────────────────────────────────────────────────────────────────
//
// Every other assertion in this file describes narrator's contract from
// BookForge's side. This one RUNS it. The `clips: []` defect is exactly the kind
// the descriptions cannot catch: both sides were self-consistent, both had a
// comment explaining the shape, and the shapes disagreed.
//
// Read-only: narrator's checkout is imported, never written, and the documents
// are written to a scratch dir this test owns.
console.log('cross-check against narrator load_voices');

// narrator lives IN this repo (python/narrator) since feat/narrator merged; the
// sibling-worktree path is kept only for a checkout that predates the merge.
const NARRATOR_PY = fs.existsSync(path.join(REPO, 'python', 'narrator', 'engine', 'higgs', 'config.py'))
  ? path.join(REPO, 'python')
  : path.join(REPO, '..', 'narrator', 'python');
const CONFIG_PY = path.join(NARRATOR_PY, 'narrator', 'engine', 'higgs', 'config.py');

function crossCheckSkipReason() {
  if (!fs.existsSync(CONFIG_PY)) {
    return 'narrator is not checked out beside this worktree (' + CONFIG_PY + ')';
  }
  // SELF-CLEARING GATE. narrator is renaming adapter -> checkpoint alongside
  // this change; until its loader knows the new name, running the new document
  // through it would fail on a contract that has not shipped rather than on a
  // real disagreement. The moment the rename lands, this starts running for
  // real — which is the point of gating on the CONTRACT rather than on a version
  // number somebody has to remember to bump.
  const src = fs.readFileSync(CONFIG_PY, 'utf-8');
  const loader = src.slice(src.indexOf('def load_voices'));
  if (!/['"]default['"]/.test(loader)) {
    return "narrator's load_voices does not know kind 'default' yet (three-shape support landing)";
  }
  if (!/checkpointDir/.test(loader)) {
    return "narrator's load_voices still expects 'adapterDir' (checkpoint rename landing)";
  }
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const probe = spawnSync(py, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf-8' });
  if (probe.status !== 0) return 'no python on PATH to run narrator with';
  return null;
}

const skipWhy = crossCheckSkipReason();
if (skipWhy) {
  console.log('  --  SKIPPED: ' + skipWhy);
} else {
  const CROSS = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-higgs-cross-'));
  process.on('exit', () => { try { fs.rmSync(CROSS, { recursive: true, force: true }); } catch {} });

  // A real wav path is needed because load_voices does os.path.isfile on every
  // clip. An empty file is enough — it never opens it.
  const CLIP = path.join(CROSS, 'ref.wav');
  fs.writeFileSync(CLIP, '');

  const runLoad = (doc) => {
    const file = path.join(CROSS, 'voices.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const code = [
      'import json, sys',
      'sys.path.insert(0, ' + JSON.stringify(NARRATOR_PY) + ')',
      'from narrator.engine.higgs.config import load_voices',
      'v = load_voices(' + JSON.stringify(file) + ')',
      'name = next(iter(v))',
      'one = v[name]',
      // getattr, because the three shapes are three CLASSES on narrator's side —
      // DefaultVoice has no `clips` at all, which is the whole point of it being
      // a separate union member rather than an empty ClipsVoice. Reporting the
      // class name is what lets the assertions below check the SHAPE and not
      // just the field values.
      'print(json.dumps({"name": name, "cls": type(one).__name__,',
      '                  "clips": len(getattr(one, "clips", ()) or ()),',
      '                  "checkpoint": getattr(one, "checkpoint_dir", None),',
      '                  "max_chars": one.max_chars,',
      '                  "source": one.max_chars_source}))',
    ].join('\n');
    const py = process.platform === 'win32' ? 'python' : 'python3';
    return spawnSync(py, ['-c', code], { encoding: 'utf-8' });
  };

  check("narrator ACCEPTS the default voice's document", () => {
    const r = runLoad(higgs.higgsVoicesDocument(higgs.resolveHiggsModel('default')));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.name, 'default');
    // A DefaultVoice, not a ClipsVoice with an empty list. narrator makes them
    // different classes precisely so a clone that lost its references is an
    // error rather than a silent downgrade to the model's own speaker.
    assert.strictEqual(got.cls, 'DefaultVoice');
    assert.strictEqual(got.clips, 0);
    assert.strictEqual(got.max_chars, 600);
    assert.strictEqual(got.source, 'placeholder');
  });

  check('narrator ACCEPTS a clips voice, and reads back the cap we sent', () => {
    const m = probeVoice({
      id: 'clone', kind: 'clips',
      voice: { clips: [{ path: CLIP, transcript: 'He turned the corner.', seconds: 14.02 }] },
      backends: { served: { maxChars: 600, maxCharsSource: 'catalog', referenceSecondsCap: 30, allowedControls: [] } },
    });
    const r = runLoad(higgs.higgsVoicesDocument(m));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.clips, 1);
    assert.strictEqual(got.max_chars, 600);
    assert.strictEqual(got.source, 'catalog');
  });

  check('narrator ACCEPTS a checkpoint voice WITH a measured cap', () => {
    const m = probeVoice({
      id: 'ft', kind: 'checkpoint',
      voice: { checkpointDir: CROSS },
      backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep', referenceSecondsCap: 30, allowedControls: [] } },
    });
    const r = runLoad(higgs.higgsVoicesDocument(m));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.checkpoint, CROSS);
    assert.strictEqual(got.max_chars, 1350);
    assert.strictEqual(got.source, 'length-sweep');
  });

  check('narrator ACCEPTS the SHIPPED deathstalker document, cap and all', () => {
    // The promotion, driven through narrator's own loader rather than described
    // from this side. load_voices does not touch the checkpoint DIRECTORY (that
    // is require_generation_config's job, inside WSL), so the real document
    // loads here and proves the two sides agree about the certified row.
    const r = runLoad(higgs.higgsVoicesDocument(higgs.resolveHiggsModel('deathstalker')));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.name, 'deathstalker');
    assert.strictEqual(got.cls, 'DefaultVoice', 'a fine-tune is prompted TEXT-ONLY');
    assert.strictEqual(got.checkpoint,
      '/home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080');
    assert.strictEqual(got.max_chars, 1200);
    assert.strictEqual(got.source, 'length-sweep');
  });

  check('narrator REFUSES a checkpoint with no cap — the refusal we mirror', () => {
    // BookForge refuses this first (refuseUnmeasuredAdapter), so the document can
    // only be built by going round it. Doing so proves the two refusals are the
    // same rule rather than two rules that happen to agree today.
    const doc = { ft: { kind: 'checkpoint', checkpointDir: CROSS } };
    const r = runLoad(doc);
    assert.notStrictEqual(r.status, 0, 'narrator accepted an unmeasured fine-tune');
    assert.match(r.stderr, /maxChars/, 'refused for the wrong reason:\n' + r.stderr);
  });
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
