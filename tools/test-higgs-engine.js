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

// ─────────────────────────────────────────────────────────────────────────────
// THE ARM IS THE FIXTURE'S, NEVER THE HOST'S
// ─────────────────────────────────────────────────────────────────────────────
//
// Every catalog answer became ARM-DEPENDENT on 2026-09-05: a `checkpoint` voice
// names its merged directory ONCE PER ARM, its cap is certified per (directory,
// backend), and `resolveHiggsModel` refuses a voice this machine has no copy of.
// A keeper that read `process.platform` would therefore pass on Owen's PC and
// fail on the Mac while describing the same catalog — the shape of bug
// tools/serve-spawn-extract.js already carries a warning about.
//
// So the file runs on a FORCED arm: WSL (win32) by default, darwin inside
// `onArm('darwin', …)`. `TRUE_HOST` is captured first, for the two things that
// really are facts about this machine (whether `os.tmpdir()` yields a drive path,
// and which python binary is on PATH).
//
// TEMP/TMP: `os.tmpdir()` branches on `process.platform` at CALL time, so under a
// forced win32 on a Mac it returns `process.env.TEMP || TMP || …` — none of which
// exist there, i.e. the literal RELATIVE path `undefined\temp`, which the voices
// document then mkdirs inside the repo (found by the Mac agent, 2026-09-05). Point
// them at the host's real temp dir, exactly as serve-spawn-extract.js does.
const TRUE_HOST = process.platform;
const HOST_TMP = os.tmpdir();
const HOST_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform');
function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
  if (value === 'win32') {
    process.env.TEMP = HOST_TMP;
    process.env.TMP = HOST_TMP;
  }
}
setPlatform('win32');
process.on('exit', () => {
  if (HOST_PLATFORM_DESC) Object.defineProperty(process, 'platform', HOST_PLATFORM_DESC);
});
/** Run `fn` on one arm, then put the file's default (WSL) back. */
function onArm(arm, fn) {
  setPlatform(arm === 'darwin' ? 'darwin' : 'win32');
  try { return fn(); } finally { setPlatform('win32'); }
}

/**
 * The two document targets. A `HiggsDocumentTarget` says which arm's checkpoint
 * path to write and — on darwin — what the catalog's userData-relative path is
 * relative TO. There is no default: the whole point is that a document carries
 * exactly one arm's directory.
 */
const WSL_DOC = { arm: 'wsl' };
const MAC_USER_DATA = fs.mkdtempSync(path.join(HOST_TMP, 'bf-higgs-userdata-'));
const MAC_DOC = { arm: 'darwin', userDataDir: MAC_USER_DATA };

// THE PICKER'S userData. `higgsVoiceUnavailableReason` and the two lists over it
// check the DISK for what the host owns the location of — darwin checkpoints
// under userData, models-area clips on either arm — so the keeper stages an
// empty stand-in for everything the shipped catalog names there. A test that
// wants "not landed" uses its own bare directory.
const PICKER_USER_DATA = fs.mkdtempSync(path.join(HOST_TMP, 'bf-higgs-picker-userdata-'));
process.on('exit', () => { try { fs.rmSync(PICKER_USER_DATA, { recursive: true, force: true }); } catch {} });
process.on('exit', () => {
  try { fs.rmSync(MAC_USER_DATA, { recursive: true, force: true }); } catch {}
});

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
(function stagePickerUserData() {
  for (const m of higgs.listHiggsModels()) {
    const darwin = (m.voice.checkpoint && m.voice.checkpoint.darwin || '').trim();
    if (darwin) fs.mkdirSync(path.join(PICKER_USER_DATA, ...darwin.split(/[\\/]/)), { recursive: true });
    for (const c of (m.voice.clips || [])) {
      if (!path.isAbsolute(c.path)) {
        const refs = higgs.higgsRefsDir(PICKER_USER_DATA);
        fs.mkdirSync(refs, { recursive: true });
        fs.writeFileSync(path.join(refs, c.path), '');
      }
    }
  }
})();

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
  assert.ok(m.voice.checkpoint, 'the checkpoint locations are missing');
  assert.ok(!('checkpointDir' in m.voice),
    'the retired single-path checkpointDir survived the per-arm split');
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
  // merges of the same run are two directories and two certificates. Since the
  // 2026-09-07 promotion (Owen: 'promote the deathstalker model we just trained
  // as the definitive model locally ... delete the old one') the WSL arm is
  // ds_v5_prod, the ds_v5 train's ladder pick (ckpt-1102); ds_ad4lm_prod_ckpt1080
  // was deleted from the PC and survives on the Mac arm and on HF.
  // PROMOTED 2026-09-10 to the v7 retrain (ds_v7_prod, ckpt-744, holdout 3.8353). The v6 model was
  // never shipped: it did not emit EOS and ran to the token cap on 29% of probe renders, caused by
  // RETAINED post-chunk pauses (slice_vtt --tail-s 4.0). Re-sliced at 0.25 s and retrained -> 0/24
  // runaway. Field notes 4n.53/4n.54. ds_v5_prod (ckpt-1102) held this slot from 2026-09-07.
  // PROMOTED 2026-09-11 to ds_v7_930_prod (ckpt-930, the run's last checkpoint) by temper's PAUSE SCREEN:
  // every ds_v7 checkpoint rendered in the 500-600 band, 930 = 0 defects and pausing score 87/100 against the
  // corpus, while ckpt-744 (lowest loss) scored 45 with 3.5x the corpus's rate of pauses over 2 s. Owen's rule:
  // the latest CLEAN checkpoint wins (the voice settles in the later epochs). Band 600-800 held, not re-laddered.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.voice.checkpoint.wsl,
    '/home/telltale/higgs_v3_merged/ds_v7_930_prod');
  assert.ok(m._checkpointDirNote, 'nothing says why this is not the higgs-models convention');
});

check('deathstalker is staged on BOTH arms, each in that arm\'s own shape', () => {
  // THE GAP THIS BRANCH CLOSES. One `checkpointDir` string could only be one
  // machine's path, and it was the guest's — so the Mac's voice document carried
  // /home/telltale/… and the MLX backend refused a directory that machine has
  // never had. The Mac copy was staged 2026-09-05 (same basename, sha-verified
  // against the frozen WSL dir).
  //
  // THE TWO ENTRIES ARE SHAPED DIFFERENTLY, and each shape is asserted:
  //   wsl     ABSOLUTE — it is handed to the launch script inside the guest,
  //           whose home directory is fixed.
  //   darwin  RELATIVE to userData — a Mac's Application Support path carries the
  //           ACCOUNT NAME, so an absolute one in a repo-tracked catalog names a
  //           directory that exists on exactly one machine.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.voice.checkpoint.darwin,
    'runtime/higgs-models/ds_v7_930_prod');
  assert.ok(m.voice.checkpoint.wsl.startsWith('/'), 'the wsl path is not absolute');
  assert.ok(!m.voice.checkpoint.darwin.startsWith('/'),
    'the darwin path is absolute — it would name one machine only');
  // Beside `base`, which is where higgsMlxBaseDir puts the zero-shot weights, so
  // one directory holds everything the MLX arm loads.
  assert.match(m.voice.checkpoint.darwin, /^runtime\/higgs-models\//);
  assert.ok(m._checkpointArmNote, 'nothing says why a checkpoint is named per arm');
  assert.match(m._checkpointArmNote, /new certificate/i,
    'the arm note does not say a copy is a new certificate');
});

check('a MISSHAPEN per-arm path is refused when the catalog is READ, not when it renders', () => {
  // Both arms are checked from ANY machine on purpose: a Windows build is where
  // this catalog is usually edited, and a darwin entry written the WSL way would
  // otherwise be found by the one person who cannot fix it quickly.
  const wslRelative = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: 'higgs_v3_merged/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => higgs.higgsVoicesDocument(wslRelative, WSL_DOC),
    /wsl checkpoint .* is not a guest-resident path/,
    'a relative WSL path was accepted');

  const darwinAbsolute = probeVoice({
    kind: 'checkpoint',
    voice: { checkpoint: { darwin: '/Users/telltale/Library/Application Support/BookForge/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => higgs.higgsVoicesDocument(darwinAbsolute, MAC_DOC),
    /darwin checkpoint .* is absolute/,
    'an absolute darwin path was accepted — it names one machine only');

  const escapes = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { darwin: '../../elsewhere/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => higgs.higgsVoicesDocument(escapes, MAC_DOC), /climbs out of userData/);

  const unknownArm = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { linux: '/opt/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => higgs.higgsVoicesDocument(unknownArm, WSL_DOC), /linux/,
    'an arm BookForge does not render on was accepted as a staging key');
});

check('the RETIRED voice.checkpointDir is refused by name, never read', () => {
  // A catalog still written the old way would silently lose its per-arm staging.
  // The same shape of guard narrator applies to `adapterDir`.
  const legacy = probeVoice({
    kind: 'checkpoint', voice: { checkpointDir: '/home/x/merged' },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  let threw = null;
  // A literal rather than `envOpts`, which is a `const` declared in section 4 and
  // still in its temporal dead zone here.
  try {
    higgs.higgsSpawnEnv(legacy, { voicesPath: '/mnt/c/tmp/higgs-probe-voices.json' });
  } catch (err) { threw = err; }
  assert.ok(threw, 'the retired single-path shape was accepted');
  assert.match(threw.message, /voice\.checkpointDir, which is retired/);
  assert.match(threw.message, /ONE LOCATION PER ARM/);
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
    // EVERY STAGED PATH, not just the first. A second arm is a second directory
    // and a second certificate, and a note that names only one of them is how a
    // reader ends up believing the Mac renders the weights the WSL note
    // describes. The arm note may carry it instead — they are one document to a
    // reader — so the two are searched together.
    const prose = note + (m._checkpointArmNote || '');
    for (const [arm, dir] of Object.entries(m.voice.checkpoint)) {
      assert.ok(prose.includes(dir),
        `${m.id}: no note names the ${arm} directory ${dir}, which is what that arm renders`);
    }
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
    ['default with checkpointDir', { kind: 'default', voice: { checkpoint: { wsl: '/x' } } }],
    ['checkpoint with no checkpointDir', { kind: 'checkpoint', voice: {},
      backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } } }],
    ['checkpoint with clips', { kind: 'checkpoint',
      voice: { checkpoint: { wsl: '/x' }, clips: [{ path: '/a.wav', transcript: 't', seconds: 5 }] },
      backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } } }],
    ['clips with none', { kind: 'clips', voice: { clips: [] } }],
    ['clips with a checkpointDir', { kind: 'clips',
      voice: { clips: [{ path: '/a.wav', transcript: 't', seconds: 5 }], checkpoint: { wsl: '/x' } } }],
  ];
  for (const [why, overrides] of cases) {
    const m = probeVoice(overrides);
    assert.throws(() => higgs.higgsVoicesDocument(m, WSL_DOC), /Higgs voice "probe"/,
      why + ' was accepted');
  }
});

check('the deathstalker served cap is 800 BY RULING — and both older records stay on the page', () => {
  // Owen, 2026-09-09: 800 chars is where renders start truncating. That
  // supersedes the training ceiling (1764), which superseded the ckpt-1080
  // certificate (1200); each stays written where it happened. Provenance is a
  // wire value from narrator's closed set, so a ruling is 'catalog' and the
  // reason lives in _maxCharsNote.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.backends.served.maxChars, 800);
  assert.strictEqual(m.backends.served.maxCharsSource, 'catalog');
  const src = m.backends.served._maxCharsSourceNote;
  assert.match(src, /max chunk is what we trained on/, 'the note does not quote the rule the number comes from');
  assert.match(src, /MAX 1764/, 'the note does not give the training ceiling the number is');
  assert.match(src, /ds_v5/, 'the note does not name the corpus the ceiling was read from');
  // Owen, 2026-09-09: "I dont think we need a target anymore. Just a safe range."
  // A fine-tune declares a BAND; the point target is gone from every fine-tune arm.
  assert.strictEqual(m.backends.served.targetChars, undefined,
    'a fine-tune must not carry a point target any more - it declares a safe band');
  assert.strictEqual(m.backends.served.safeMinChars, 600, 'deathstalker floor');
  assert.strictEqual(m.backends.served.safeMaxChars, 800, 'deathstalker cap');
  const note = m.backends.served._maxCharsNote;
  assert.match(note, /OWEN'S RULING \(2026-09-09\)/, 'the note does not say the cap is a ruling');
  assert.match(note, /truncations/, 'the note does not give the reason the cap came down');
  assert.match(note, /PREVIOUS:/, 'the superseded note was overwritten instead of kept');
  assert.match(note, /SUPERSEDED DIRECTORY/, 'the old certificate is not marked as belonging to the deleted directory');
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




check('ONE engine-level sampling - 0.7 / 0.95 / 50 - reaches EVERY Higgs voice on BOTH arms', () => {
  // 0.7 AGAIN SINCE 2026-09-11 (late), MEASURED: the 0.6 trial fired the Mac
  // batched length guard on 21 of 62 Tender chunks against 4 at 0.7 on the same
  // rows and seeds (silence-token loops to the per-row cap - mlx-audio has no
  // repetition penalty), and halved a render to 37 raw sent/min. Owen: "switch
  // it back to 0.7". A sampling change is A/B'd on the Mac batched path first.
  //
  // THE 0.6 TRIAL, earlier the same day, was asked for by Owen,
  // listening to the extension's Listen path: "truncations dont really seem to
  // be a problem so far with extension streaming, but occasional gibberish is.
  // maybe we can try temp 0.6 and see if gibberish still happens there. thats
  // what orpheus's standard temp was and i didnt have any gibberish problems
  // with it. higgs is now the definitive model." Nothing here has been
  // re-scored at 0.6; if gibberish survives it, the number goes back UP. What
  // makes it safe to try is the evidence the earlier moves already collected:
  // the training sweep found 0.6-0.9 FLAT on early stops and run-ons (babble
  // from 1.0), so 0.6 is the BOTTOM of that band, and the Mac's 54-render WER
  // table has 0.6 and 1.0 tie with 0.3 the value that truncates. Being inside
  // the flat band, it does not re-open the pace figures measured at 0.8.
  //
  // 0.7 FROM 2026-09-09: Owen rendered known-gibberish chunks at 0.8 and 0.7 —
  // "gibberish gets cut in half at 0.7. set it to be global for higgs renders.
  // streaming and rendering both." 0.8 BEFORE THAT, on the reason "temperature
  // should be .8 everywhere, as it's the boson default" — a default asserted,
  // never compared. Every superseded note is kept in the catalog.
  //
  // ONE number for Listen streaming and book renders alike — both spawn through
  // higgs-spawn, which writes the document this rides in. Stated ONCE at the
  // catalog top with its reason; a per-block deviation must carry a reason too
  // or it is refused, so 14 copies of a number can never drift.
  const engine = higgs.higgsEngineSampling();
  assert.deepStrictEqual(engine, { temperature: 0.7, topP: 0.95, topK: 50 });
  assert.ok(/very good reason|boson default/i.test(higgs.higgsCatalogSamplingRule()));
  // WHAT THIS HOLDS THE CATALOG TO, and what it deliberately no longer does.
  // Until 2026-09-10 it asserted the shipped catalog carries NO per-block
  // sampling at all - the rule's absence, not its mechanism. mistborn/served now
  // states repetitionPenalty 1.1 with its reason, so the absence is false by
  // intent and asserting it would only record that nobody had needed the lever
  // yet. What is worth keeping is the shape: a block deviates only in
  // repetitionPenalty (a SERVED-ARM lever mlx-audio cannot honour), it restates
  // every engine value unchanged, and it says why.
  for (const m of higgs.listHiggsModels()) {
    for (const arm of ['wsl', 'darwin']) {
      const block = m.backends[arm === 'wsl' ? 'served' : 'mlx'];
      if (!block) continue;
      const caps = higgs.higgsVoiceCapsForModel(m, arm);
      const { repetitionPenalty, ...rest } = caps.sampling;
      assert.deepStrictEqual(rest, engine, `${m.id}/${arm}: deviates from the engine sampling in more than the penalty`);
      if (repetitionPenalty !== undefined) {
        assert.strictEqual(arm, 'wsl',
          `${m.id}/${arm}: a repetitionPenalty on the MLX arm - mlx-audio has no such lever and narrator refuses the key`);
        assert.ok(typeof repetitionPenalty === 'number' && repetitionPenalty > 0,
          `${m.id}/${arm}: repetitionPenalty ${repetitionPenalty} is not a positive number`);
        assert.ok(/reason/i.test(block._samplingNote || ''),
          `${m.id}/${arm}: a per-block sampling with no _samplingNote stating the REASON`);
      }
    }
    // The engine-level block may NEVER carry the penalty: it is written to both
    // arms' documents, and HiggsV3MlxConfig refuses the key by name, so a
    // penalty stated there would refuse every Mac render of every voice.
    assert.ok(higgs.higgsEngineSampling().repetitionPenalty === undefined,
      'the engine-level sampling carries a repetitionPenalty - that refuses every MLX render');
  }
  // A block that deviates WITHOUT a reason is refused by name.
  const silent = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 600, maxCharsSource: 'catalog', sampling: { temperature: 0.5 } } } });
  assert.throws(() => higgs.higgsVoiceCapsForModel(silent, 'wsl'), /REASON/);
  // With one, it rides instead of the engine's.
  const stated = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 600, maxCharsSource: 'catalog', sampling: { temperature: 0.5 },
                          _samplingNote: 'REASON: keeper fixture' } } });
  assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(stated, 'wsl').sampling, { temperature: 0.5 });
});

check('the pending rule still holds over whatever the catalog ships', () => {
  // Offering-and-refusing is the honest pair; hiding-and-forgetting is not. No
  // voice ships pending today (deathstalker was promoted 2026-09-05), so this
  // asserts the RULE over every row rather than over one row that happens to be
  // in one of the two states.
  const renderable = new Set(higgs.listRenderableHiggsModels(PICKER_USER_DATA).map((m) => m.id));
  const offered = new Map(higgs.higgsNarrationVoices(PICKER_USER_DATA).map((v) => [v.value, v]));
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
    voice: { checkpoint: { wsl: '/home/x/higgs-models/probe' } },
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
    voice: { checkpoint: { wsl: '/home/x/higgs-models/probe' } },
    backends: { served: { maxChars: 600 } },
  });
  assert.throws(() => higgs.higgsSpawnEnv(m, envOpts), /MEASURED maxChars/);
});

check('a checkpoint WITH a measured cap and its source passes', () => {
  const m = probeVoice({
    kind: 'checkpoint',
    voice: { checkpoint: { wsl: '/home/x/higgs-models/probe' } },
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
  assert.deepStrictEqual(c.sampling, higgs.higgsEngineSampling(), 'the default voice renders at the engine-level sampling');
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
  const doc = higgs.higgsVoicesDocument(defaultVoice, WSL_DOC);
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
  const doc = higgs.higgsVoicesDocument(m, WSL_DOC);
  assert.deepStrictEqual(doc.ds.clips, [
    { path: '/a/joined.wav', transcript: 'He said it was here.', seconds: 27.4 },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5a. ONE CHECKPOINT PER ARM — the gap this branch closes
// ─────────────────────────────────────────────────────────────────────────────
//
// A `checkpoint` voice is ~8.5 GB on disk and the two arms cannot see each
// other's disks. Until 2026-09-05 the catalog held ONE `checkpointDir`, and it
// was the WSL guest's — so a Mac render was handed /home/telltale/… and refused
// it deep inside narrator, after the environment had already been declared green.
console.log('per-arm checkpoint staging');

/** A fine-tune staged on exactly the arms named. */
function stagedVoice(checkpoint, extra) {
  return probeVoice(Object.assign({
    id: 'ft', kind: 'checkpoint', voice: { checkpoint },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep',
                          referenceSecondsCap: 30, allowedControls: [] } },
  }, extra));
}

check('a WSL-only fine-tune is REFUSED ON DARWIN, by name, and loads on WSL', () => {
  const m = stagedVoice({ wsl: '/home/telltale/higgs_v3_merged/ds' });

  const doc = onArm('wsl', () => higgs.higgsVoicesDocument(m, WSL_DOC));
  assert.strictEqual(doc.ft.checkpointDir, '/home/telltale/higgs_v3_merged/ds',
    'the arm that HAS the weights did not get them');

  let threw = null;
  try { onArm('darwin', () => higgs.higgsVoicesDocument(m, MAC_DOC)); } catch (err) { threw = err; }
  assert.ok(threw, "darwin was handed a document for a voice that machine has no copy of");
  // BY NAME: the voice, the arm, and what to do — never the other arm's path and
  // never a search of the disk.
  assert.match(threw.message, /Higgs voice "ft" is not staged for the Mac/);
  assert.match(threw.message, /no darwin checkpoint in the catalog/);
  assert.ok(!/\/home\/telltale/.test(threw.message.split('it names only')[0]),
    "the refusal offered the WSL path as if it were an answer");
  assert.match(threw.message, /new certificate/,
    'the refusal does not say that staging a copy means measuring again');
});

check('a darwin-only fine-tune is REFUSED ON WSL, by name', () => {
  // The mirror. Neither arm is the fallback for the other; a missing arm is a
  // voice that does not exist there.
  const m = stagedVoice({ darwin: 'runtime/higgs-models/ds' });
  let threw = null;
  try { onArm('wsl', () => higgs.higgsVoicesDocument(m, WSL_DOC)); } catch (err) { threw = err; }
  assert.ok(threw, 'WSL was handed the Mac\'s copy');
  assert.match(threw.message, /Higgs voice "ft" is not staged for WSL/);
  assert.match(threw.message, /no wsl checkpoint in the catalog/);
  assert.match(threw.message, /it names only: darwin/,
    'the refusal does not say where the voice IS staged');
});

check('staged on BOTH arms: each arm gets ITS path, absolute and arm-shaped', () => {
  const m = stagedVoice({
    wsl: '/home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080',
    darwin: 'runtime/higgs-models/ds_ad4lm_prod_ckpt1080',
  });

  const wsl = onArm('wsl', () => higgs.higgsVoicesDocument(m, WSL_DOC));
  assert.strictEqual(wsl.ft.checkpointDir,
    '/home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080',
    'the WSL document does not carry the GUEST path');

  const mac = onArm('darwin', () => higgs.higgsVoicesDocument(m, MAC_DOC));
  // RESOLVED TO ABSOLUTE against the fixture userData, because that is what
  // narrator's MLX backend opens — `require_generation_config` does
  // os.path.isdir on this exact string, and a relative one would resolve against
  // whatever cwd the worker happened to have.
  assert.strictEqual(mac.ft.checkpointDir,
    path.join(MAC_USER_DATA, 'runtime', 'higgs-models', 'ds_ad4lm_prod_ckpt1080'));
  assert.ok(path.isAbsolute(mac.ft.checkpointDir), 'the darwin path reached narrator relative');
  assert.ok(mac.ft.checkpointDir.startsWith(MAC_USER_DATA),
    'the darwin path was resolved against something other than userData');
  assert.notStrictEqual(wsl.ft.checkpointDir, mac.ft.checkpointDir,
    'both arms got the same directory — one of them cannot open it');
});

check('the darwin arm REFUSES to resolve without a userData directory', () => {
  // No default and no search: guessing where a Mac's Application Support lives is
  // how a render loads 8.5 GB of the wrong weights (or none).
  const m = stagedVoice({ darwin: 'runtime/higgs-models/ds' });
  let threw = null;
  try { onArm('darwin', () => higgs.higgsVoicesDocument(m, { arm: 'darwin' })); }
  catch (err) { threw = err; }
  assert.ok(threw, 'a userData-relative path was resolved against nothing');
  assert.match(threw.message, /no userData directory was given/);
  assert.match(threw.message, /no default and no search/);
});

check('the PICKER and Listen show a checkpoint voice only on an arm that has it', () => {
  // `listRenderableHiggsModels` is what the Listen voice list and the batch
  // preflight read; `higgsNarrationVoices` is the narration dropdown. Both must
  // agree with `resolveHiggsModel`, or the dropdown offers a voice the run then
  // refuses. deathstalker is the shipped row: staged on both arms, and PENDING on
  // both, so it is offered-and-disabled either way — which is the honest pair.
  for (const arm of ['wsl', 'darwin']) {
    onArm(arm, () => {
      const offered = new Map(higgs.higgsNarrationVoices(PICKER_USER_DATA).map((v) => [v.value, v]));
      const renderable = new Set(higgs.listRenderableHiggsModels(PICKER_USER_DATA).map((m) => m.id));
      for (const m of higgs.listHiggsModels()) {
        const row = offered.get(m.id);
        if (!row) continue;
        let refused = null;
        try { higgs.resolveHiggsModel(m.id); } catch (err) { refused = err; }
        assert.strictEqual(!!row.unavailable, !!refused,
          `${arm}/${m.id}: the dropdown and resolveHiggsModel disagree`);
        assert.strictEqual(renderable.has(m.id), !refused,
          `${arm}/${m.id}: the renderable list and resolveHiggsModel disagree`);
      }
    });
  }
});

/**
 * Run `fn` against a catalog with `extra` rows appended, then put the shipped one
 * back.
 *
 * THROUGH THE REAL FILE, because that is the only seam there is: the loader reads
 * `<dist>/electron/data/higgs-models.json` fresh on every call (deliberately — so
 * editing tuning and re-running takes effect without an app restart), and
 * `listRenderableHiggsModels` calls `listHiggsModels` directly rather than through
 * the module object, so there is nothing to stub.
 *
 * Needed because every row the catalog SHIPS is pending on both arms today, so a
 * picker that ignored the arm entirely would still agree with `resolveHiggsModel`
 * over the shipped file — the mutation would pass. A renderable-on-one-arm row is
 * what makes the arm-awareness observable.
 */
const CATALOG_FILE = path.join(DIST, 'data', 'higgs-models.json');
function withExtraVoices(extra, fn) {
  const shipped = fs.readFileSync(CATALOG_FILE, 'utf-8');
  const parsed = JSON.parse(shipped);
  parsed.models = [...parsed.models, ...extra];
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
  try { return fn(); } finally { fs.writeFileSync(CATALOG_FILE, shipped, 'utf-8'); }
}

check('a fine-tune certified on ONE arm is renderable there and greyed on the other', () => {
  const wslOnly = {
    id: 'wslonly', label: 'WSL-only fine-tune', kind: 'checkpoint', engineVersion: 'v3',
    voice: { checkpoint: { wsl: '/home/telltale/higgs_v3_merged/wslonly' } },
    license: 'x', commercialUse: false, sampleRate: 24000, addedAt: '2026-09-05',
    backends: { served: { maxChars: 1200, maxCharsSource: 'length-sweep' } },
  };
  withExtraVoices([wslOnly], () => {
    onArm('wsl', () => {
      assert.ok(higgs.listRenderableHiggsModels(PICKER_USER_DATA).some((m) => m.id === 'wslonly'),
        'the arm that has the weights and the certificate cannot render it');
      const row = higgs.higgsNarrationVoices(PICKER_USER_DATA).find((v) => v.value === 'wslonly');
      assert.ok(row && !row.unavailable, 'it is offered as unavailable on its own arm');
      assert.strictEqual(higgs.resolveHiggsModel('wslonly').id, 'wslonly');
    });
    onArm('darwin', () => {
      assert.ok(!higgs.listRenderableHiggsModels(PICKER_USER_DATA).some((m) => m.id === 'wslonly'),
        'the Mac lists a voice whose weights are in the WSL guest');
      const row = higgs.higgsNarrationVoices(PICKER_USER_DATA).find((v) => v.value === 'wslonly');
      assert.ok(row, 'the voice vanished from the dropdown instead of being greyed');
      assert.match(row.label, /not on this machine/);
      assert.match(row.unavailable, /is not staged for the Mac/);
      assert.throws(() => higgs.resolveHiggsModel('wslonly'), /is not staged for the Mac/);
    });
  });
});

check('the reason the picker shows is the REFUSAL, not a second description of it', () => {
  const m = stagedVoice({ wsl: '/home/telltale/higgs_v3_merged/ds' });
  const reason = onArm('darwin', () => higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA));
  assert.ok(reason, 'a voice with no copy on this arm was reported as available');
  assert.match(reason, /is not staged for the Mac/);
  assert.strictEqual(onArm('wsl', () => higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA)), null,
    'the arm that has the weights was told it does not');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5b. A CERTIFICATE IS PER (DIRECTORY, BACKEND)
// ─────────────────────────────────────────────────────────────────────────────
//
// The served cap was measured by driving vllm-omni on ONE merged directory with
// ONE patched stage processor. The MLX arm is a different sampler over a
// different runtime — mlx-audio's top-k/top-p and vLLM's are different
// implementations, so the same three numbers make the CONFIGURATION identical and
// not the draws (PORT_NOTES 13.11), and the seeds are not even comparable. So
// copying the merged directory to the Mac copies the weights and NOT the
// certificate: `backends.mlx` carries its own cap, null until it is measured.
console.log('per-backend certificates');

check('caps come from the ARM\'s own block, and never from the other one', () => {
  const m = probeVoice({
    id: 'twoarm', kind: 'checkpoint',
    voice: { checkpoint: { wsl: '/home/t/merged', darwin: 'runtime/higgs-models/merged' } },
    backends: {
      served: { maxChars: 1200, maxCharsSource: 'length-sweep' },
      mlx: { maxChars: 800, maxCharsSource: 'length-sweep' },
    },
  });
  assert.strictEqual(higgs.higgsVoiceCapsForModel(m, 'wsl').maxChars, 1200);
  assert.strictEqual(higgs.higgsVoiceCapsForModel(m, 'darwin').maxChars, 800);
  // And the document carries the arm's own number, because that is what sizes the
  // prep packer for the render this document describes.
  assert.strictEqual(higgs.higgsVoicesDocument(m, WSL_DOC).twoarm.maxChars, 1200);
  assert.strictEqual(higgs.higgsVoicesDocument(m, MAC_DOC).twoarm.maxChars, 800);
});

check('a null MLX cap REFUSES on darwin while the served cap still loads on WSL', () => {
  // The shape deathstalker ships in the moment its served sweep lands: staged on
  // both arms, certified on one. The refusal must be per arm, or the Mac renders
  // a book packed for a cap nobody measured on its sampler.
  const m = probeVoice({
    id: 'halfway', kind: 'checkpoint',
    voice: { checkpoint: { wsl: '/home/t/merged', darwin: 'runtime/higgs-models/merged' } },
    backends: {
      served: { maxChars: 1200, maxCharsSource: 'length-sweep' },
      mlx: { maxChars: null, maxCharsSource: null },
    },
  });

  const doc = onArm('wsl', () => higgs.higgsVoicesDocument(m, WSL_DOC));
  assert.strictEqual(doc.halfway.maxChars, 1200, 'the CERTIFIED arm was refused');
  assert.ok(onArm('wsl', () => higgs.higgsSpawnEnv(m, { voicesPath: DOC_PATH })));

  let threw = null;
  try { onArm('darwin', () => higgs.higgsSpawnEnv(m, { voicesPath: DOC_PATH })); }
  catch (err) { threw = err; }
  assert.ok(threw, 'an unmeasured MLX arm was accepted because the served arm was measured');
  assert.match(threw.message, /no MEASURED maxChars on the mlx backend/);
  assert.match(threw.message, /backends\.mlx/);
  assert.match(threw.message, /CERTIFICATE IS PER \(DIRECTORY, BACKEND\)/);
  assert.match(threw.message, /does not transfer/);

  // And the picker agrees: offered on WSL, greyed on the Mac, same reason text.
  assert.strictEqual(onArm('wsl', () => higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA)), null);
  assert.match(onArm('darwin', () => higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA)),
    /no MEASURED maxChars on the mlx backend/);

  // A MISSING mlx BLOCK is the same answer as a null one — "this backend has no
  // certificate" — and never the served block by default.
  const noBlock = probeVoice({
    id: 'halfway', kind: 'checkpoint',
    voice: { checkpoint: { wsl: '/home/t/merged', darwin: 'runtime/higgs-models/merged' } },
    backends: { served: { maxChars: 1200, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => onArm('darwin', () => higgs.higgsSpawnEnv(noBlock, { voicesPath: DOC_PATH })),
    /no MEASURED maxChars on the mlx backend/,
    'an absent mlx block silently inherited the served certificate');
});

check('the shipped deathstalker caps BOTH arms at the ruling, each keeping its own evidence', () => {
  // This row used to REQUIRE the arms to differ: two sweeps of identical
  // weights measured 1200 and 900, so an equal pair meant a number copied
  // across. Owen's ruling makes them equal on purpose, and that refusal cannot
  // tell a ruling from a copy, so what is checked now is that each arm states
  // its provenance and keeps its own superseded evidence.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  for (const backend of ['served', 'mlx']) {
    const caps = m.backends[backend];
    assert.strictEqual(caps.maxChars, 800,
      `${backend}: the ruling is 800 on both arms`);
    assert.strictEqual(caps.targetChars, undefined,
      `${backend}: the point target is retired - a fine-tune declares a safe band`);
    assert.ok(Number.isInteger(caps.safeMinChars) && Number.isInteger(caps.safeMaxChars),
      `${backend}: a fine-tune must declare safeMinChars and safeMaxChars`);
    assert.ok(caps.safeMinChars < caps.safeMaxChars,
      `${backend}: the floor must sit below the cap`);
    assert.ok(caps.safeMaxChars <= caps.maxChars,
      `${backend}: the band may sit inside maxChars, never past it`);
    assert.strictEqual(caps.maxCharsSource, 'catalog',
      `${backend}: a declared ruling is 'catalog' in narrator's vocabulary`);
    assert.match(caps._maxCharsNote, /OWEN'S RULING \(2026-09-09\)/,
      `${backend}: the note does not say where the 800 came from`);
    assert.match(caps._maxCharsNote, /PREVIOUS:/,
      `${backend}: the superseded certificate was overwritten rather than kept`);
  }

  // Each note must carry the evidence for ITS OWN arm: the rule, the scorer, the
  // ladder including the length that FAILED, and the artifact it came from.
  const served = m.backends.served._maxCharsNote;
  assert.match(served, /ASR alignment/, 'the served note does not name the scorer');
  assert.match(served, /never by duration ratio/i,
    'the served note does not refuse duration ratio — a v3 render measured 0.99 while dropping '
    + '22 % of its text');
  assert.match(served, /1500 FAILS/, 'the served note does not give the length that failed');
  assert.match(served, /max_chars_certificate_ckpt1080\.json/,
    'the served note does not name its certificate');
  assert.match(served, /max-num-seqs 64/,
    'the served note no longer records that the certifying server ran at a different batch '
    + 'width from the catalog\'s maxNumSeqs — the one observation that would matter if batch '
    + 'width moved the safe chunk length');

  const mlx = m.backends.mlx._maxCharsNote;
  assert.match(mlx, /faster-whisper/, 'the MLX note does not name the scorer');
  assert.match(mlx, /1200 FAILS/, 'the MLX note does not give the length that failed');
  assert.match(mlx, /max_chars_certificate_mlx_ckpt1080\.json/,
    'the MLX note does not name its certificate');
  assert.match(mlx, /ds_ad4lm_prod_ckpt1080/, 'the MLX note does not name the directory swept');
  assert.match(mlx, /NOT the served number|per \(directory, backend\)/i,
    'nothing says this number is not the served one');
});

check("EVERY backend block states its cap — measured, or null, with a KNOWN source", () => {
  // The catalog-wide rule, over every block of every fine-tune, so a voice added
  // later cannot ship one arm certified and the other silently blank.
  const KNOWN_SOURCES = ['catalog', 'placeholder', 'length-sweep'];
  for (const m of higgs.listHiggsModels()) {
    for (const [backend, caps] of Object.entries(m.backends)) {
      if (m.kind === 'checkpoint' && caps.maxChars === null) {
        assert.strictEqual(caps.maxCharsSource, null,
          `${m.id}/${backend}: an unmeasured cap names a source`);
        continue;
      }
      assert.ok(Number.isInteger(caps.maxChars) && caps.maxChars > 0,
        `${m.id}/${backend}: maxChars is ${JSON.stringify(caps.maxChars)}`);
      // narrator VALIDATES this vocabulary (protocol.MAX_CHARS_SOURCES) and the
      // value travels in the voice document, so a prose provenance string here
      // is a render refused at load_voices.
      assert.ok(KNOWN_SOURCES.includes(caps.maxCharsSource),
        `${m.id}/${backend}: maxCharsSource ${JSON.stringify(caps.maxCharsSource)} is not one of `
        + KNOWN_SOURCES.join(' | '));
    }
  }
});

check('the SAMPLING MIRROR equals the checkpoint dir\'s generation_config.json', () => {
  // THE FILE IS THE AUTHORITY on both arms — vllm-omni resolves sampling from the
  // model directory, and on the Mac narrator reads the same file itself because
  // mlx-audio reads none. The catalog block is a MIRROR, kept so a reader can see
  // what a voice samples at without opening a directory inside WSL, and a mirror
  // nobody checks is how two copies of a number diverge.
  //
  // Driven against a FIXTURE directory, because the shipped voice's directory is
  // inside the WSL guest (and on the Mac) and this process can open neither. What
  // is under test is the RULE; the shipped values are asserted separately below.
  const dir = path.join(MAC_USER_DATA, 'runtime', 'higgs-models', 'mirrored');
  fs.mkdirSync(dir, { recursive: true });
  const file = { temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.0 };
  fs.writeFileSync(path.join(dir, 'generation_config.json'), JSON.stringify(file), 'utf-8');

  const mirrorOf = (doc) => ({ temperature: doc.temperature, topP: doc.top_p, topK: doc.top_k });
  const m = probeVoice({
    id: 'mirrored', kind: 'checkpoint',
    voice: { checkpoint: { darwin: 'runtime/higgs-models/mirrored' } },
    backends: { mlx: { maxChars: 900, maxCharsSource: 'length-sweep', sampling: mirrorOf(file), _samplingNote: 'REASON: keeper mirror fixture' } },
  });
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(higgs.higgsCheckpointDirFor(m, 'darwin', MAC_USER_DATA),
                              'generation_config.json'), 'utf-8'));
  assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(m, 'darwin').sampling, mirrorOf(onDisk),
    'the catalog block does not mirror the directory it points at');

  // MUTATION: change the file and the mirror is wrong — which is what makes this
  // a check rather than a restatement.
  fs.writeFileSync(path.join(dir, 'generation_config.json'),
    JSON.stringify({ ...file, top_k: 50 }), 'utf-8');
  const drifted = JSON.parse(fs.readFileSync(path.join(dir, 'generation_config.json'), 'utf-8'));
  assert.notDeepStrictEqual(higgs.higgsVoiceCapsForModel(m, 'darwin').sampling, mirrorOf(drifted));
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
    voice: { checkpoint: { wsl: '/home/x/higgs-models/ft' } },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
  });
  const doc = higgs.higgsVoicesDocument(m, WSL_DOC);
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
  const doc = higgs.higgsVoicesDocument(defaultVoice, WSL_DOC);
  assert.strictEqual(doc.default.kind, 'default');
  assert.ok(!('clips' in doc.default), "kind 'default' must not emit a clips key");
  assert.strictEqual(doc.default.maxChars, 600);
  // narrator VALIDATES this vocabulary: 'catalog' | 'placeholder' | 'length-sweep'.
  assert.strictEqual(doc.default.maxCharsSource, 'placeholder');
});

const HIGGS3_PREFIX = '/home/t/anaconda3/envs/higgs3';
const SGLOMNI_PREFIX = '/home/t/anaconda3/envs/sglomni';

// ── EVERY STACK ROW RUNS AGAINST AN EXPLICIT FIXTURE ───────────────────────
//
// Higgs v3 is served by two stacks and `serving.stack` picks one. It shipped as
// vllm-omni and FLIPPED to sglang-omni on 2026-09-06, on the night-3
// measurements (same 50 chunks, same checkpoint, one seed: vllm-omni at 16 in
// flight gives 4 early stops / 13 damaged / 6 sustained voice switches; SGLang
// gives 0 / 5 / 0, at 2.5x the throughput).
//
// The rows below used to build ONE env from the shipped catalog and assert
// vllm-omni facts about it. That is two mistakes in one: the flip turned them
// red, and — worse — whichever stack was not shipped stopped being tested at
// exactly the moment a regression in it could go unnoticed. So each stack gets
// its own fixture model (the catalog's own serving block with `stack` replaced,
// carried as the per-model override the catalog already supports), BOTH are
// always exercised, and the SHIPPED value is asserted separately, on its own row.
const STACKS = ['vllm-omni', 'sglang-omni'];
const SHIPPED_STACK = higgs.higgsServingSpec().stack;

/** `defaultVoice`, pinned to one stack. */
function voiceOnStack(stack) {
  return Object.assign({}, defaultVoice, {
    serving: Object.assign({}, higgs.higgsServingSpec(), { stack }),
  });
}
/** The guest conda prefix each stack's launcher runs out of. */
const PREFIX_FOR_STACK = {
  'vllm-omni': HIGGS3_PREFIX,
  'sglang-omni': SGLOMNI_PREFIX,
};
/** The launcher file name each stack deploys into that prefix. */
const LAUNCHER_FOR_STACK = {
  'vllm-omni': higgs.higgsServingSpec().launchScript,
  'sglang-omni': higgs.higgsServingSpec().sglang.launchScript,
};
/** A launching spawn env for one stack. */
function envOnStack(stack) {
  const prefix = PREFIX_FOR_STACK[stack];
  return higgs.higgsSpawnEnv(voiceOnStack(stack), {
    voicesPath: '/mnt/c/tmp/voices.json',
    serveScriptPath: `${prefix}/bin/${LAUNCHER_FOR_STACK[stack]}`,
    condaEnvPrefix: prefix,
    wslDistro: 'Ubuntu',
  });
}
const envByStack = Object.fromEntries(STACKS.map((s) => [s, envOnStack(s)]));

// `env` stays the name the rows below use for the vllm-omni one — that is the
// stack the `HIGGS_*` / deploy-profile rows are ABOUT, and they say so now.
const env = envByStack['vllm-omni'];
const sglEnv = envByStack['sglang-omni'];

check('narrator is addressed by NARRATOR_*, and the LAUNCH SCRIPT by HIGGS_*', () => {
  // TWO SETS, TWO READERS, AND THE DISTINCTION IS THE WHOLE POINT.
  //
  // An early draft of higgs-models.ts INVENTED a `HIGGS_*` set as a guess at
  // narrator's variable names, because engine/higgs had not landed yet; when it
  // did, its names were `NARRATOR_*` and every invented one was deleted. This
  // row asserted that deletion by refusing any `HIGGS_` prefix at all — which
  // was right while nothing else read one, and became wrong on 2026-09-05.
  //
  // `serve_higgs_v3.sh` is an operator's script that narrator RUNS rather than
  // reimplements, and a script is configured through the environment. Its
  // variables really are `HIGGS_*`, they belong to it, and until this commit
  // NONE of them were set — so the catalog's serving block described a
  // configuration nothing applied.
  assert.strictEqual(env.NARRATOR_HIGGS_VOICES, '/mnt/c/tmp/voices.json');
  assert.strictEqual(env.NARRATOR_HIGGS3_SERVE_SCRIPT,
    `${HIGGS3_PREFIX}/bin/serve_higgs_v3.sh`);
  assert.strictEqual(env.NARRATOR_HIGGS3_WSL_DISTRO, 'Ubuntu');

  // The launch script's set, against the catalog rather than literals.
  const serving = higgs.higgsServingSpec();
  assert.strictEqual(env.HIGGS_ENV, HIGGS3_PREFIX);
  assert.strictEqual(env.HIGGS_HOST, serving.host);
  assert.strictEqual(env.HIGGS_PORT, String(serving.port));
  assert.strictEqual(env.HIGGS_GPU_MEM_UTIL, String(serving.gpuMemoryUtilization));
  assert.strictEqual(env.HIGGS_CODEC_GPU_MEM_UTIL, String(serving.codecGpuMemoryUtilization));
  assert.strictEqual(env.HIGGS_MAX_MODEL_LEN, String(serving.maxModelLen));
  assert.strictEqual(env.HIGGS_MAX_NUM_SEQS, String(serving.maxNumSeqs));

  // AND NOTHING BEYOND THE SCRIPT'S OWN CONTRACT. The old row's real value was
  // that an invented name could not creep back in; it is kept as an allowlist
  // read out of the script itself, so a variable BookForge sets that the script
  // never reads fails here.
  const script = fs.readFileSync(
    path.join(REPO, 'electron', 'scripts', 'higgs', 'serve_higgs_v3.sh'), 'utf-8');
  for (const key of Object.keys(env).filter((k) => /^HIGGS_/.test(k))) {
    assert.ok(script.includes(`${key}=`) || script.includes(`$${key}`),
      `${key} is set by BookForge and read nowhere in serve_higgs_v3.sh`);
  }
});

check('the SGLang launcher reads every HIGGS_* variable its spawn sets', () => {
  // THE SAME ALLOWLIST, FOR THE OTHER STACK. A variable BookForge sets that
  // `serve_higgs_sgl.sh` never reads is a lever that reports success — which is
  // exactly what the whole vllm-omni serving block was until 2026-09-05.
  //
  // Driven directly rather than off the shipped catalog because the shipped
  // `stack` is deliberately still `vllm-omni` (behaviour is unchanged until
  // somebody flips one word), and a keeper that could only see the shipped value
  // would prove nothing about the arm the measurements argue for.
  const sglPrefix = '/home/t/anaconda3/envs/sglomni';
  const sglModel = {
    ...defaultVoice,
    serving: { ...higgs.higgsServingSpec(), stack: 'sglang-omni' },
  };
  const sglEnv = higgs.higgsSpawnEnv(sglModel, {
    voicesPath: DOC_PATH,
    serveScriptPath: `${sglPrefix}/bin/serve_higgs_sgl.sh`,
    condaEnvPrefix: sglPrefix,
    wslDistro: 'Ubuntu',
  });
  const script = fs.readFileSync(
    path.join(REPO, 'electron', 'scripts', 'higgs', 'serve_higgs_sgl.sh'), 'utf-8');
  const set = Object.keys(sglEnv).filter((k) => /^HIGGS_/.test(k));
  assert.ok(set.length >= 6, `only ${set.length} HIGGS_* variables reached the SGLang launcher`);
  for (const key of set) {
    assert.ok(script.includes(`${key}=`) || script.includes(`$${key}`),
      `${key} is set by BookForge and read nowhere in serve_higgs_sgl.sh`);
  }
  // AND THE LAUNCHER REFUSES THE WRONG STACK. HIGGS_STACK is narrator's contract
  // variable, and both launchers assert it: a job configured for one stack that
  // reached the other's launcher would come up on a server whose requests the
  // client is not building, which is a rendered book rather than a crash.
  assert.match(script, /HIGGS_STACK.*sglang-omni/s,
    'serve_higgs_sgl.sh does not assert which stack it is');
  assert.match(
    fs.readFileSync(path.join(REPO, 'electron', 'scripts', 'higgs', 'serve_higgs_v3.sh'), 'utf-8'),
    /HIGGS_STACK.*vllm-omni/s,
    'serve_higgs_v3.sh does not assert which stack it is');
});

check('HIGGS_MODEL_DIR is narrator\'s to export, never BookForge\'s', () => {
  // The server is keyed on it — it is which merged checkpoint comes up — and
  // narrator exports it per voice from the voice document (v3_served.py
  // `_launch_exports`), unsetting it for the base speaker. A second authority on
  // this side would be a whole book in the wrong narrator.
  assert.ok(!('HIGGS_MODEL_DIR' in env));
});

check('a launch script with no HIGGS_ENV is REFUSED, not defaulted', () => {
  // The script's own fallback is a hardcoded `$HOME/anaconda3/envs/higgs3`: true
  // on the machine it was transcribed from, and a server started out of the
  // wrong env (or none) anywhere else. CUDA_HOME, PATH, LD_LIBRARY_PATH and the
  // `vllm-omni` binary itself all hang off it.
  assert.throws(() => higgs.higgsSpawnEnv(defaultVoice, {
    voicesPath: DOC_PATH,
    serveScriptPath: `${HIGGS3_PREFIX}/bin/serve_higgs_v3.sh`,
  }), /HIGGS_ENV/);
  // And the reverse: a prefix with no script is an arm that launches nothing.
  assert.throws(() => higgs.higgsSpawnEnv(defaultVoice, {
    voicesPath: DOC_PATH, condaEnvPrefix: HIGGS3_PREFIX,
  }), /no launch script/);
});

check('an arm that launches NO server gets no server-launch variable', () => {
  // The Mac samples in-process. A bind address or a memory fraction there is a
  // lever read by nothing, which is how a Mac spawn ends up looking like a
  // served one.
  const e = higgs.higgsSpawnEnv(defaultVoice, { voicesPath: DOC_PATH });
  for (const key of ['HIGGS_ENV', 'HIGGS_HOST', 'HIGGS_PORT', 'HIGGS_GPU_MEM_UTIL',
    'HIGGS_CODEC_GPU_MEM_UTIL', 'HIGGS_MAX_MODEL_LEN', 'HIGGS_DEPLOY_CONFIG']) {
    assert.ok(!(key in e), `a non-launching spawn carries ${key}`);
  }
  // EXCEPT the batch width, which narrator itself reads: `serve_concurrency()`
  // refuses BY NAME when it is unset, so a door that renders and finds it
  // missing dies after the session is already built.
  assert.strictEqual(e.HIGGS_MAX_NUM_SEQS, String(higgs.higgsServingSpec().maxNumSeqs));
});

check('a serving block with a bad number is REFUSED by field name', () => {
  // These land on a vllm-omni command line inside a guest, five minutes before
  // anything can be heard. A substituted "plausible" value is a server that
  // comes up at the wrong width and renders a whole book that way.
  //
  // PINNED TO vllm-omni, because every field it patches is that stack's. Read off
  // the SHIPPED catalog instead, these silently stopped asserting anything the
  // day the stack flipped: `higgsSpawnEnv` returns the SGLang set before it ever
  // looks at `gpuMemoryUtilization`, so `assert.throws` had nothing to catch.
  const spec = Object.assign({}, higgs.higgsServingSpec(), { stack: 'vllm-omni' });
  const withServing = (patch) => probeVoice({
    id: 'bad', kind: 'default', voice: {},
    serving: Object.assign({}, spec, patch),
  });
  const opts = {
    voicesPath: DOC_PATH,
    serveScriptPath: `${HIGGS3_PREFIX}/bin/serve_higgs_v3.sh`,
    condaEnvPrefix: HIGGS3_PREFIX,
  };
  assert.throws(() => higgs.higgsSpawnEnv(withServing({ maxNumSeqs: 0 }), opts), /maxNumSeqs/);
  assert.throws(() => higgs.higgsSpawnEnv(withServing({ gpuMemoryUtilization: 1.4 }), opts),
    /gpuMemoryUtilization/);
  assert.throws(
    () => higgs.higgsSpawnEnv(withServing({ codecGpuMemoryUtilization: undefined }), opts),
    /codecGpuMemoryUtilization/);
  assert.throws(() => higgs.higgsSpawnEnv(withServing({ maxModelLen: 8192.5 }), opts),
    /maxModelLen/);
  // A DECLARED null is the auto-discovered profile and emits nothing; an ABSENT
  // key would make "nobody has decided" and "we chose the default" the same
  // catalog, so it is refused.
  assert.throws(() => higgs.higgsSpawnEnv(withServing({ deployConfig: undefined }), opts),
    /deployConfig/);
  // A BARE PROFILE NAME IS REFUSED HERE, not carried into the guest to die. It
  // costs a 297 s cold start to learn that vllm-omni answers "Deploy config not
  // found" for one (measured 2026-09-05, 0.28.0:
  // config_factory._load_user_deploy_config joins a bare name to the deploy dir
  // without appending .yaml), and that failure arrives as a dead worker rather
  // than as a sentence about the catalog. serve_higgs_v3.sh refuses it too — in
  // the guest, one process later.
  assert.throws(
    () => higgs.higgsSpawnEnv(withServing({ deployConfig: 'higgs_multimodal_qwen3_low_latency' }),
      opts),
    /bare profile NAME/);
  // A FILE NAME is resolved against the env prefix, because the installer puts
  // our profiles in <env>/bin/ and vllm-omni would resolve a bare file name
  // against its OWN deploy/ directory inside site-packages.
  const chosen = higgs.higgsSpawnEnv(
    withServing({ deployConfig: 'higgs_multimodal_qwen3_low_latency.yaml' }), opts);
  assert.strictEqual(chosen.HIGGS_DEPLOY_CONFIG,
    `${HIGGS3_PREFIX}/bin/higgs_multimodal_qwen3_low_latency.yaml`);
  // A value that already carries a separator is the caller saying exactly where
  // the file is — including one of vllm-omni's own, which is not under our bin.
  const explicit = higgs.higgsSpawnEnv(
    withServing({ deployConfig: '/opt/vllm_omni/deploy/higgs_multimodal_qwen3.yaml' }), opts);
  assert.strictEqual(explicit.HIGGS_DEPLOY_CONFIG,
    '/opt/vllm_omni/deploy/higgs_multimodal_qwen3.yaml');
  // And `null` still means the auto-discovered profile and emits nothing.
  const none = higgs.higgsSpawnEnv(withServing({ deployConfig: null }), opts);
  assert.ok(!('HIGGS_DEPLOY_CONFIG' in none),
    'a null deployConfig exported something — vllm-omni would take the -n branch');
});

check('the catalog names the profile that raises the frame ceiling (vllm-omni)', () => {
  // The served speech endpoint IGNORES a per-request max_tokens, so stage 0's
  // default_sampling_params.max_tokens in the deploy profile is a hard ceiling on
  // every render: vllm-omni's auto profile sets 2048 frames = 81.92 s and cuts
  // anything longer mid-sentence while reporting success. Leaving deployConfig
  // null is therefore not a neutral default any more, and this row is what says
  // so — it is the one failure with no crash to notice.
  const spec = higgs.higgsServingSpec();
  assert.strictEqual(spec.deployConfig, 'higgs_default_frames7500.yaml',
    'the catalog no longer names the 7500-frame profile, so every render is capped at 81.92 s');
  assert.ok(fs.existsSync(path.join(REPO, 'electron', 'scripts', 'higgs', spec.deployConfig)),
    `the catalog names ${spec.deployConfig} but this build ships no such file — the installer `
    + 'would have nothing to copy and --deploy-config would point at a missing path');
  // ON THE vllm-omni FIXTURE, because that is the only stack `--deploy-config`
  // exists on. SGLang-Omni has no deploy profile at all — which is also why
  // sampling MUST ride on every request there — so asserting this of the shipped
  // env would fail the day the stack flipped, for a reason that has nothing to do
  // with the frame ceiling.
  assert.strictEqual(env.HIGGS_DEPLOY_CONFIG, `${HIGGS3_PREFIX}/bin/${spec.deployConfig}`,
    "the catalog's profile did not resolve to the installer's copy");
  // AND IT IS KEPT IN THE CATALOG EVEN WHILE THE OTHER STACK IS SHIPPED. The two
  // blocks sit side by side precisely so neither stack's measured configuration
  // is lost while the other is selected, and a flip back is one word.
  assert.ok(!('HIGGS_DEPLOY_CONFIG' in sglEnv),
    'the sglang arm carries a deploy profile, which that stack has no flag for');
});

check(`the SHIPPED stack (${SHIPPED_STACK}) gets the matching variable set`, () => {
  // The one row here that is about THE CATALOG rather than about a stack. It is
  // what would catch a flip breaking the app rather than only breaking the tests:
  // whichever stack `serving.stack` names, the spawn must carry that stack's
  // launcher variables and none of the other's.
  assert.ok(STACKS.includes(SHIPPED_STACK),
    `serving.stack is ${JSON.stringify(SHIPPED_STACK)}, which this suite has no fixture for`);
  // `defaultVoice` — the REAL catalog entry with no `serving` override — so this
  // reads `serving.stack` through the same path the app does. Same voicesPath as
  // `envOnStack` so the deep-equal below is about the STACK and not about a
  // fixture string.
  const shipped = higgs.higgsSpawnEnv(defaultVoice, {
    voicesPath: '/mnt/c/tmp/voices.json',
    serveScriptPath: `${PREFIX_FOR_STACK[SHIPPED_STACK]}/bin/${LAUNCHER_FOR_STACK[SHIPPED_STACK]}`,
    condaEnvPrefix: PREFIX_FOR_STACK[SHIPPED_STACK],
    wslDistro: 'Ubuntu',
  });
  assert.strictEqual(shipped.HIGGS_STACK, SHIPPED_STACK);
  // The shipped env IS the fixture env for that stack. If these ever disagreed it
  // would mean the fixtures are not exercising the path the catalog takes, which
  // would make every stack row in this file worthless.
  assert.deepStrictEqual(shipped, envByStack[SHIPPED_STACK]);
  const V = ['HIGGS_ENV', 'HIGGS_HOST', 'HIGGS_PORT', 'HIGGS_GPU_MEM_UTIL',
    'HIGGS_CODEC_GPU_MEM_UTIL', 'HIGGS_MAX_MODEL_LEN', 'NARRATOR_HIGGS3_SERVE_SCRIPT'];
  const S = ['HIGGS_SGL_ENV', 'HIGGS_SGL_HOST', 'HIGGS_SGL_PORT', 'HIGGS_SGL_MEM_FRACTION',
    'HIGGS_SGL_CUDA_GRAPH_MAX_BS', 'HIGGS_SGL_MAX_NEW_TOKENS',
    'NARRATOR_HIGGS_SGL_SERVE_SCRIPT'];
  const sgl = SHIPPED_STACK === 'sglang-omni';
  for (const key of sgl ? S : V) {
    assert.ok(key in shipped, `the shipped ${SHIPPED_STACK} spawn is missing ${key}`);
  }
  for (const key of sgl ? V : S) {
    assert.ok(!(key in shipped), `the shipped ${SHIPPED_STACK} spawn carries ${key}`);
  }
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

check('the ATTACH url is emitted only when a server is already up — and per STACK', () => {
  // ONE VARIABLE PER STACK, and that is load-bearing rather than tidy. Each
  // backend reads only its own name (`HiggsSglServedBackend` looks at
  // NARRATOR_HIGGS_SGL_URL, `HiggsV3ServedBackend` at NARRATOR_HIGGS3_URL), so a
  // stale variable from the other stack cannot point one stack's client at the
  // other stack's server — which would answer /health and /v1/models in the right
  // shapes and then drop half of every request body.
  const NAME = {
    'vllm-omni': 'NARRATOR_HIGGS3_URL',
    'sglang-omni': 'NARRATOR_HIGGS_SGL_URL',
  };
  for (const stack of STACKS) {
    const url = `http://127.0.0.1:${stack === 'sglang-omni' ? 8200 : 8095}`;
    // Not emitted when nothing was attached to: narrator would otherwise skip
    // starting a server and poll a port with nothing on it.
    assert.ok(!(NAME[stack] in envByStack[stack]),
      `${NAME[stack]} is set on a launching spawn`);
    const attached = higgs.higgsSpawnEnv(voiceOnStack(stack), {
      voicesPath: DOC_PATH, baseUrl: url,
    });
    assert.strictEqual(attached[NAME[stack]], url);
    // AND THE OTHER STACK'S NAME IS NOT SET, on either.
    const other = STACKS.find((s) => s !== stack);
    assert.ok(!(NAME[other] in attached),
      `attaching on ${stack} also set ${NAME[other]}`);
  }
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
    voice: { checkpoint: { wsl: '/home/x/ft' } },
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
// The ONE owner of the Mac's MLX tier table. The Higgs batch env is asserted
// against it rather than against a copied number, so a tier change moves both.
const memoryMod = require(path.join(DIST, 'orpheus-memory.js'));

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
const REAL_HOST = TRUE_HOST;
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
    // narrator has no default sessions root and refuses to guess; forwarding
    // NARRATOR_SESSIONS_ROOT is not an alternative because it holds a HOST path
    // while a guest render derives its session dir from the guest root.
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
    // Reads the document back off the WINDOWS side, so it can only run there. On a Mac the
    // forced win32 arm still yields a POSIX doc path, fs.readFileSync gets a path that does
    // not exist, and the case fails for EVERY voice - which made promote_voice's --mac step
    // refuse every promotion at the last gate, after the 8 GB rsync had already succeeded
    // (hit 2026-09-11 promoting sigma). Same guard the ENV-translation case above uses.
    if (REAL_HOST !== 'win32') return;
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
      voice: { checkpoint: { wsl: B+B + 'wsl$' + B + 'Ubuntu' + B + 'home' + B + 't' + B + 'higgs-models' + B + 'ds' } },
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
      voice: { checkpoint: { wsl: '/home/t/higgs-models/ds' } },
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
      const written = higgs.writeHiggsVoicesDocument(m, 'jobmac', { arm: 'darwin', userDataDir: MAC_USER_DATA });
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

  // ── The MLX batch budget: darwin, and the WORKER door only ────────────────
  //
  // narrator's Higgs MLX backend renders ONE ROW unless BookForge asks for more
  // (NARRATOR_HIGGS3_MLX_BATCH, default 1), so these two variables are the whole
  // ask. They are pinned here because every wrong place to put them is silent:
  // on the WSL arm they would be read by nothing (that Higgs is a vLLM-Omni
  // server), and on the serve/prep/assembly doors they would look configured
  // while no batch exists to spend them on.
  const BATCH_VARS = ['NARRATOR_HIGGS3_MLX_BATCH', 'NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB'];

  check('the WSL arm gets NO MLX batch variables on any door', () => {
    for (const text of [line, prepLine, asmLine]) {
      for (const name of BATCH_VARS) {
        assert.ok(!text.includes(name),
          `${name} reached the served arm, where nothing reads it`);
      }
    }
  });

  check('darwin: the WORKER carries the batch ceiling and its memory budget', () => {
    // BOTH readings are taken UNDER the forced arm: auto tier resolution reads
    // `process.platform` itself (a Mac bands on unified RAM), so a profile read
    // outside `onArm` answers for a different machine entirely.
    const { env, profile } = onArm('darwin', () => ({
      env: spawnMod.higgsMlxBatchEnv('worker'),
      profile: memoryMod.orpheusMemoryProfile(
        memoryMod.resolveConcreteOrpheusTier(null, null)),
    }));
    for (const name of BATCH_VARS) {
      assert.ok(env[name], `the darwin worker sets no ${name}`);
      assert.ok(Number(env[name]) > 0, `${name} is not a positive number: ${env[name]}`);
    }
    // The SAME numbers the Orpheus MLX arm gets: one Metal device, one unified
    // memory pool, one answer.
    assert.strictEqual(env.NARRATOR_HIGGS3_MLX_BATCH, String(profile.batchSize));
    assert.strictEqual(env.NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB, String(profile.mlxMemBudgetGB));
  });

  check('darwin: SERVE carries the ceiling the POOL passed, not the tier width', () => {
    // The Listen path batches its read-ahead (the row being listened to renders
    // solo), and the width it may use is the pool's `streamBatchCeiling()` —
    // floor-16 over the tier's width, so NOT the worker's number. Passed in
    // because higgs-spawn cannot import the pool back (require cycle).
    const { env, profile } = onArm('darwin', () => ({
      env: spawnMod.higgsMlxBatchEnv('serve', 40),
      profile: memoryMod.orpheusMemoryProfile(
        memoryMod.resolveConcreteOrpheusTier(null, null)),
    }));
    assert.strictEqual(env.NARRATOR_HIGGS3_MLX_BATCH, '40');
    // The BUDGET is still the tier's on both doors: one unified memory pool.
    assert.strictEqual(env.NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB, String(profile.mlxMemBudgetGB));
  });

  check('darwin: a serve door with NO ceiling is REFUSED BY NAME', () => {
    // Never defaulted to the worker's width: a Listen server that quietly
    // rendered its read-ahead one row at a time while every variable looked
    // configured is the inert-knob failure in its quietest form.
    for (const bad of [undefined, 0, -1, Number.NaN, '16']) {
      assert.throws(
        () => onArm('darwin', () => spawnMod.higgsMlxBatchEnv('serve', bad)),
        /streamBatchCeiling|ceiling/,
        `higgsMlxBatchEnv('serve', ${JSON.stringify(bad)}) did not refuse`);
    }
  });

  check('darwin: prep and assembly carry NO batch variables', () => {
    // They load no model. A budget there is a lever read by nothing.
    for (const door of ['prep', 'assembly']) {
      const env = onArm('darwin', () => spawnMod.higgsMlxBatchEnv(door));
      assert.deepStrictEqual(env, {}, `the ${door} door carries a batch budget`);
    }
  });

  check('no ORPHEUS_* name rides along with the batch variables', () => {
    // The Higgs spawn strips Orpheus's variables deliberately; a Higgs knob
    // SPELLED ORPHEUS_ would be stripped with them and read by nothing.
    const env = onArm('darwin', () => spawnMod.higgsMlxBatchEnv('worker'));
    assert.ok(!/ORPHEUS_/.test(JSON.stringify(env)),
      'an ORPHEUS_* variable leaked into the Higgs batch env');
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

check('the CLI runs higgs on EVERY door the app runs it on', () => {
  // The standing rule is that the CLI mirrors the app's code path (CLAUDE.md,
  // "CLI drives the app path"), so what is asserted here is an AGREEMENT between
  // two files and never a sentence in one of them.
  //
  // This check used to require that the CLI REFUSED `--mode streaming` for Higgs
  // by name, and that was right when Higgs v3 was a served endpoint with no
  // windowed decode. Per-row Higgs streaming shipped 2026-09-05 — the app's
  // `tts-api-server` has bound a Higgs voice ever since — so the refusal made the
  // CLI the one door that could not reproduce a Listen defect on it. Lifted
  // 2026-09-12, and the assertion moved to the invariant that actually matters:
  // the CLI permits exactly what the app implements.
  const cli = fs.readFileSync(path.join(REPO, 'cli', 'bookforge-tts.py'), 'utf-8');
  assert.match(cli, /args\.engine in \("orpheus", "higgs"\)/,
    'the CLI still refuses --engine higgs');
  const apiServer = fs.readFileSync(path.join(REPO, 'electron', 'tts-api-server.ts'), 'utf-8');
  const appStreamsHiggs = /higgsPreflight\(/.test(apiServer);
  const cliRefusesStreaming = /has no streaming path/.test(cli);
  assert.strictEqual(cliRefusesStreaming, !appStreamsHiggs,
    appStreamsHiggs
      ? 'the app streams Higgs but the CLI still refuses --mode streaming for it'
      : 'the CLI offers Higgs streaming that the app no longer implements');
  const adapter = fs.readFileSync(path.join(REPO, 'cli', 'orpheus-batch-render.js'), 'utf-8');
  assert.match(adapter, /ttsEngine: engine/,
    'the batch adapter still hardcodes the engine');
});

check('the dropdown offers every kind, and a clone SAYS it is one', () => {
  // Owen, 2026-09-04: production is fine-tuned voices only — a clone recovers
  // 92 % of the narrator's speaker identity and none of his phrasing, so listing
  // one beside a fine-tune invites picking it for a book. That kept `clips` out
  // of the dropdown.
  //
  // Owen, 2026-09-06: "give me a zero shot option on the higgs/narration modal"
  // — base Higgs v3 plus one reference clip, for the voices with no Higgs
  // fine-tune (thirdreich, owen-morgan) and, as a different product, beside the
  // deathstalker and mistborn fine-tunes. So `clips` IS offered, and the 09-04
  // concern is answered by the LABEL: every clone says "Zero-shot", and the
  // picker refuses a catalog whose clone does not.
  const offered = new Map(higgs.higgsNarrationVoices(PICKER_USER_DATA).map((v) => [v.value, v]));
  const byId = new Map(higgs.listHiggsModels().map((m) => [m.id, m]));
  for (const [id, row] of offered) {
    const kind = byId.get(id).kind;
    assert.ok(['checkpoint', 'default', 'clips'].includes(kind),
      `the dropdown offers "${id}", which is kind '${kind}'`);
    if (kind === 'clips') {
      assert.match(row.label, /zero-shot/i, `clone "${id}" is offered without saying so: ${row.label}`);
    }
  }
  const clones = [...byId.values()].filter((m) => m.kind === 'clips').map((m) => m.id);
  assert.ok(clones.length > 0, 'the catalog ships no zero-shot voice at all');
  for (const id of clones) assert.ok(offered.has(id), `zero-shot voice "${id}" is not offered`);
});

check('the four shipped zero-shot voices: base weights + one ~15 s clip in the MODELS AREA', () => {
  // Training's picks (2026-09-06): one clean TREATED corpus clip each, 12-16 s,
  // book-exact transcript. Owen: "ref clips can be saved permanently in the same
  // area where models are saved" — so the catalog names each by a bare file
  // name, resolved under <userData>/runtime/higgs-models/refs/, never in the repo.
  const want = ['zeroshot-thirdreich', 'zeroshot-owen-morgan', 'zeroshot-deathstalker', 'zeroshot-mistborn'];
  const byId = new Map(higgs.listHiggsModels().map((m) => [m.id, m]));
  for (const id of want) {
    const m = byId.get(id);
    assert.ok(m, `${id} is not in the catalog`);
    assert.strictEqual(m.kind, 'clips');
    assert.match(m.label, /^Zero-shot/, `${id}'s label does not lead with Zero-shot`);
    assert.ok(!m.voice.checkpoint, `${id} names a checkpoint — a zero-shot voice is the BASE weights`);
    assert.strictEqual(m.voice.clips.length, 1, `${id} must carry exactly one clip`);
    const clip = m.voice.clips[0];
    assert.strictEqual(clip.path, path.basename(clip.path), `${id}'s clip is not a bare name: ${clip.path}`);
    assert.ok(!path.isAbsolute(clip.path));
    assert.ok(clip.seconds >= 12 && clip.seconds <= 16, `${id}'s clip is ${clip.seconds} s, outside training's 12-16 s`);
    assert.ok(clip.transcript && !/[0-9"]/.test(clip.transcript), `${id}'s transcript carries digits or quotes`);
    for (const arm of ['served', 'mlx']) {
      const caps = m.backends[arm];
      assert.strictEqual(caps.maxChars, 600, `${id} ${arm}: the zero-shot wall is 600`);
      assert.strictEqual(caps.maxCharsSource, 'placeholder');
      assert.strictEqual(caps.targetChars, 600);
      assert.strictEqual(caps.referenceSecondsCap, 30);
    }
    assert.strictEqual(higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA), null,
      `${id} is offered disabled: ${higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA)}`);
  }
});

const ZS_USER_DATA = fs.mkdtempSync(path.join(HOST_TMP, 'bf-higgs-zs-userdata-'));
process.on('exit', () => { try { fs.rmSync(ZS_USER_DATA, { recursive: true, force: true }); } catch {} });
const ZS_REFS = higgs.higgsRefsDir(ZS_USER_DATA);

check('a clip NAME resolves under <userData>/runtime/higgs-models/refs, and is REFUSED when absent', () => {
  assert.strictEqual(ZS_REFS.replace(/\\/g, '/'), (ZS_USER_DATA + '/runtime/higgs-models/refs').replace(/\\/g, '/'));
  const m = higgs.listHiggsModels().find((v) => v.id === 'zeroshot-thirdreich');
  // No userData at all: refused by name, never guessed — the darwin checkpoint rule.
  assert.throws(() => higgs.higgsVoicesDocument(m, { arm: 'wsl' }), /userData/,
    'a bare clip name was resolved with no userData directory');
  // userData given, clip not staged there: refused naming the folder to copy into.
  let threw = null;
  try { higgs.higgsVoicesDocument(m, { arm: 'wsl', userDataDir: ZS_USER_DATA }); } catch (err) { threw = err; }
  assert.ok(threw, 'a missing clip was written into the document');
  assert.match(threw.message, /thirdreich\.wav/);
  assert.match(threw.message, /runtime\/higgs-models\/refs/, 'the refusal does not say where the clip goes');
  // Staged: the document carries THIS MACHINE's absolute path, translated for the arm.
  fs.mkdirSync(ZS_REFS, { recursive: true });
  for (const v of higgs.listHiggsModels().filter((x) => x.kind === 'clips')) {
    fs.writeFileSync(path.join(ZS_REFS, v.voice.clips[0].path), '');
  }
  const doc = higgs.higgsVoicesDocument(m, {
    arm: 'wsl', userDataDir: ZS_USER_DATA, translatePath: (p) => 'GUEST:' + p.replace(/\\/g, '/'),
  })['zeroshot-thirdreich'];
  assert.strictEqual(doc.kind, 'clips');
  assert.strictEqual(doc.clips.length, 1);
  assert.strictEqual(doc.clips[0].path,
    'GUEST:' + path.join(ZS_REFS, 'thirdreich.wav').replace(/\\/g, '/'),
    'the document path is not the staged clip translated for the guest');
  assert.strictEqual(doc.clips[0].seconds, 15);
  assert.strictEqual(doc.maxChars, 600);
  assert.strictEqual(doc.targetChars, 600);
  assert.strictEqual(doc.maxReferenceSeconds, 30);
  assert.ok(!('checkpointDir' in doc), 'a zero-shot document must not name a checkpoint');
  // The Mac arm resolves the SAME name under its own userData.
  const mac = higgs.higgsVoicesDocument(m, { arm: 'darwin', userDataDir: ZS_USER_DATA })['zeroshot-thirdreich'];
  assert.strictEqual(mac.clips[0].path, path.join(ZS_REFS, 'thirdreich.wav'));
});

check('a relative clip with a directory in it, or an empty path, is REFUSED as malformed', () => {
  for (const bad of ['sub/a.wav', '../a.wav', '', '  ']) {
    const m = probeVoice({
      kind: 'clips',
      voice: { clips: [{ path: bad, transcript: 'a line', seconds: 12 }] },
    });
    assert.ok(higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA),
      'clip path ' + JSON.stringify(bad) + ' was accepted by the picker');
    assert.throws(() => higgs.higgsVoicesDocument(m, { arm: 'wsl', userDataDir: ZS_USER_DATA }),
      /bare file name|no path/, 'clip path ' + JSON.stringify(bad) + ' reached the document');
  }
  // An ABSOLUTE path is host-native and needs no userData — the other spelling.
  const abs = path.join(ZS_REFS, 'thirdreich.wav');
  const m = probeVoice({
    kind: 'clips',
    voice: { clips: [{ path: abs, transcript: 'a line', seconds: 12 }] },
    backends: { served: { maxChars: 600, maxCharsSource: 'catalog', referenceSecondsCap: 30, allowedControls: [] } },
  });
  const doc = higgs.higgsVoicesDocument(m, WSL_DOC).probe;
  assert.strictEqual(doc.clips[0].path, abs);
});

check('a darwin checkpoint the catalog names but the disk lacks is offered DISABLED, naming the dir', () => {
  // bookforge-mac-1, 2026-09-06: mistborn was offered as available on the Mac
  // while its runtime/higgs-models/<dir> had not landed — the picker checked
  // that the catalog names a path and never that the directory exists.
  // The directory NAME is read from the catalog, not written here: this check
  // failed on three promotions in two days (ds_ad4lm_prod_ckpt1080 -> mb_h2lm_prod
  // -> mb_v3_prod -> mb_h2lm_prod) purely because a voice was re-pointed, which
  // is a keeper test failing on a fact it was not keeping.
  const bare = fs.mkdtempSync(path.join(HOST_TMP, 'bf-higgs-bare-userdata-'));
  try {
    const m = higgs.listHiggsModels().find((v) => v.id === 'mistborn');
    const darwinDir = path.basename(m.voice.checkpoint.darwin);
    assert.ok(darwinDir, 'the mistborn entry names no darwin checkpoint dir');
    const reason = onArm('darwin', () => higgs.higgsVoiceUnavailableReason(m, bare));
    assert.ok(reason, 'a fine-tune with no directory on this machine was reported as available');
    assert.match(reason, /has not landed/);
    assert.ok(reason.includes(path.join(bare, 'runtime', 'higgs-models', darwinDir)),
      'the refusal does not name the directory it looked at: ' + reason);
    const row = onArm('darwin', () => higgs.higgsNarrationVoices(bare)).find((v) => v.value === 'mistborn');
    assert.ok(row.unavailable, 'the dropdown row is not disabled');
    assert.match(row.label, /not on this machine/);
    // Staged on disk: available again, same catalog.
    assert.strictEqual(onArm('darwin', () => higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA)), null);
    // The WSL arm cannot stat the guest's ext4 from here: that arm's existence is
    // the doctor's question, and the picker says so by NOT refusing on it.
    assert.strictEqual(onArm('wsl', () => higgs.higgsVoiceUnavailableReason(m, bare)), null);
    // A zero-shot clip missing from the models area is the same answer.
    const zs = higgs.listHiggsModels().find((v) => v.id === 'zeroshot-mistborn');
    assert.match(higgs.higgsVoiceUnavailableReason(zs, bare), /runtime\/higgs-models\/refs/);
    // And the picker refuses to answer with no userData at all, rather than guessing.
    assert.match(higgs.higgsVoiceUnavailableReason(m, ''), /userData/);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

check('the deathstalker fine-tune names its HuggingFace source, and a malformed source is refused', () => {
  // Owen, 2026-09-06: "send the deathstalker model to huggingface ... make it
  // downloadable in the setup/settings page ... mirrored from huggingface".
  // The catalog names the repo; Settings → Higgs downloads it into THIS arm's
  // voice.checkpoint path (electron/higgs-hf-install.ts + scripts/higgs/higgs_download.py).
  const ds = higgs.listHiggsModels().find((m) => m.id === 'deathstalker');
  assert.deepStrictEqual(ds.source, { type: 'hf', ref: 'owenmorgan/deathstalker-higgs-v3' });
  assert.ok(fs.existsSync(path.join(REPO, 'electron', 'scripts', 'higgs', 'higgs_download.py')),
    'the downloader script is missing from electron/scripts/higgs');
  for (const [why, source] of [
    ['blank ref', { type: 'hf', ref: '' }],
    ['not a user/repo', { type: 'hf', ref: 'deathstalker-higgs-v3' }],
    ['unknown type', { type: 'url', ref: 'owenmorgan/x' }],
  ]) {
    const m = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
      backends: { served: { maxChars: 600, maxCharsSource: 'catalog' } }, source });
    assert.match(higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA) || '', /malformed source/,
      `a source with ${why} was accepted`);
  }
  // Only a merged checkpoint is downloaded: the base ships with the env, a clip lives in refs/.
  const clone = probeVoice({ kind: 'default', source: { type: 'hf', ref: 'owenmorgan/x' } });
  assert.match(higgs.higgsVoiceUnavailableReason(clone, PICKER_USER_DATA) || '', /names a download source/);
});

check('a voice chunkGap reaches the PREP door, and only that door', () => {
  // Higgs is pads=false: it emits bare speech, and every chunk join IS the model's own trailing
  // silence plus whatever the assembler inserts. text/prep.py stamps that inject into gaps.json
  // at PREP, from text/gaps.classify_gap, whose floor NARRATOR_SENTENCE_GAP overrides.
  //
  // Before this field existed nothing set it per voice, so classify_gap's hardcoded 0.6 s
  // default reached EVERY Higgs voice regardless of how that narrator pauses (2026-09-11).
  const gap = { injectS: 0.62, targetJoinS: 0.84, modelSelfTailS: 0.22, rule: 'match-reader',
    method: '-40 dB rel clip peak, 20 ms hop', source: 'pause_match.py', measuredOn: '2026-09-11' };
  const m = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1100, maxCharsSource: 'length-sweep' } }, chunkGap: gap,
  });
  assert.strictEqual(spawnMod.higgsChunkGapEnv(m, 'prep').NARRATOR_SENTENCE_GAP, '0.62');
  // The other doors load a model or read a file prep already wrote; setting it there would
  // imply it does something.
  for (const kind of ['worker', 'assembly', 'retake']) {
    assert.deepStrictEqual(spawnMod.higgsChunkGapEnv(m, kind), {},
      `${kind} was given a sentence gap, which only prep consumes`);
  }
  // A voice with no chunkGap sets NOTHING and keeps the historical 0.6 s default, so the field
  // is additive: an unmeasured voice behaves exactly as it did before.
  const bare = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1100, maxCharsSource: 'length-sweep' } } });
  assert.deepStrictEqual(spawnMod.higgsChunkGapEnv(bare, 'prep'), {});
});

check('a chunkGap whose inject is the TARGET, not net of the tail, is refused', () => {
  // THE ONE MISTAKE THIS FIELD INVITES. A join is (modelSelfTailS + injectS), so injectS must
  // already have the tail taken out of it. Declaring the target join as the inject lands every
  // join long by the tail — orpheus-models.json records exactly that as how thirdreich shipped
  // 0.24 s long on every join. The validator checks the three numbers add up.
  const wrong = { injectS: 0.84, targetJoinS: 0.84, modelSelfTailS: 0.22, rule: 'match-reader',
    method: 'm', source: 's', measuredOn: '2026-09-11' };
  const m = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1100, maxCharsSource: 'length-sweep' } }, chunkGap: wrong,
  });
  let threw = null;
  try { higgs.higgsVoicesDocument(m, WSL_DOC); } catch (e) { threw = e; }
  assert.ok(threw, 'an inject that ignores the model tail was accepted');
  assert.match(threw.message, /NET of the tail/);
  // And the well-formed one passes, so the check is not simply rejecting every gap.
  const right = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1100, maxCharsSource: 'length-sweep' } },
    chunkGap: { injectS: 0.62, targetJoinS: 0.84, modelSelfTailS: 0.22, rule: 'match-reader',
      method: 'm', source: 's', measuredOn: '2026-09-11' },
  });
  higgs.higgsVoicesDocument(right, WSL_DOC);
});
check('a measured pace becomes the length band in the document; a malformed pace is refused', () => {
  // Owen, 2026-09-06: the guard uses the voice's recorded chars-per-second.
  // 2026-09-08: the band is SEEDED FROM THE MEDIAN (× 1.2 short, ÷ 1.3 long)
  // and the median RIDES ALONG as `paceCharsPerSec`, because narrator keeps
  // only the ratios and re-centres them on the book's own running median
  // (`truncation.PaceTracker`) — measured on Shift, where the ladder's tails
  // (p99 × 1.15) sat 1.37× off the book's own pace.
  const pace = { median: 17.2, mean: 17.1, p05: 15.6, p95: 18.3, p99: 18.9, n: 42,
    method: 'spoken chars / chunk flac seconds', source: 'ladder night-4', measuredOn: '2026-09-06' };
  const m = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged', darwin: 'runtime/higgs-models/x' } },
    backends: { served: { maxChars: 1200, maxCharsSource: 'catalog' },
                mlx: { maxChars: 900, maxCharsSource: 'catalog' } }, pace,
  });
  const doc = higgs.higgsVoicesDocument(m, WSL_DOC).probe;
  // THE DOCUMENT'S PACE IS THE MEDIAN — the reference the two edges are ratios
  // of, and the number narrator's tracker starts centred on.
  assert.strictEqual(doc.paceCharsPerSec, 17.2);
  assert.strictEqual(higgs.PACE_GUARD_SHORT_FACTOR, 1.3);
  assert.strictEqual(higgs.PACE_GUARD_LONG_FACTOR, 1.3);
  assert.strictEqual(doc.maxCharsPerSec, Math.round(17.2 * 1.3 * 100) / 100);
  assert.strictEqual(doc.minCharsPerSec, Math.round(17.2 / 1.3 * 100) / 100);
  assert.deepStrictEqual(higgs.higgsLengthBand(pace), {
    paceCharsPerSec: doc.paceCharsPerSec,
    maxCharsPerSec: doc.maxCharsPerSec,
    minCharsPerSec: doc.minCharsPerSec,
  });
  // No pace: no band in the document (the engine default applies).
  const bare = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1200, maxCharsSource: 'catalog' } } });
  const bareDoc = higgs.higgsVoicesDocument(bare, WSL_DOC).probe;
  assert.ok(!('maxCharsPerSec' in bareDoc) && !('minCharsPerSec' in bareDoc)
    && !('paceCharsPerSec' in bareDoc));
  // SAMPLING RIDES IN THE DOCUMENT, per arm: a block's own (with its reason)
  // for that arm, the ENGINE-LEVEL one for a block that states none - so no
  // document is ever written without the number that renders.
  const sampled = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged', darwin: 'runtime/higgs-models/x' } },
    backends: { served: { maxChars: 600, maxCharsSource: 'catalog', sampling: { temperature: 1, topP: 0.95, topK: 50 }, _samplingNote: 'REASON: fixture' },
                mlx: { maxChars: 600, maxCharsSource: 'catalog', sampling: { temperature: 0.7, topP: 0.95, topK: 50 }, _samplingNote: 'REASON: fixture' } } });
  assert.deepStrictEqual(higgs.higgsVoicesDocument(sampled, MAC_DOC).probe.sampling, { temperature: 0.7, topP: 0.95, topK: 50 });
  assert.deepStrictEqual(higgs.higgsVoicesDocument(sampled, WSL_DOC).probe.sampling, { temperature: 1, topP: 0.95, topK: 50 });
  assert.deepStrictEqual(bareDoc.sampling, higgs.higgsEngineSampling(), 'a block with no sampling writes the engine-level one');
  // Malformed: out of order, or missing provenance.
  for (const [why, bad] of [
    ['out of order', { ...pace, p05: 19 }],
    ['no method', { ...pace, method: '' }],
    ['no n', { ...pace, n: 0 }],
  ]) {
    const mm = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
      backends: { served: { maxChars: 1200, maxCharsSource: 'catalog' } }, pace: bad });
    assert.match(higgs.higgsVoiceUnavailableReason(mm, PICKER_USER_DATA) || '', /pace/, `${why} was accepted`);
  }
  // ONE PER VOICE: a pace on a backend block is refused, not read.
  const perArm = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1200, maxCharsSource: 'catalog', pace } } });
  assert.match(higgs.higgsVoiceUnavailableReason(perArm, PICKER_USER_DATA) || '', /ONE PER VOICE/);
  // The Mac's document carries the same band as the WSL one.
  const mac = higgs.higgsVoicesDocument(m, MAC_DOC).probe;
  assert.strictEqual(mac.maxCharsPerSec, doc.maxCharsPerSec);
  assert.strictEqual(mac.minCharsPerSec, doc.minCharsPerSec);
});

check('the certified voice is offered SELECTABLE, with no warning attached', () => {
  // Finding 11 was the opposite state: a pending voice offered label-only and
  // fully selectable, so it queued a run that died at preflight. Now that
  // deathstalker renders, the row must carry no `unavailable` at all — a row
  // marked unavailable is rendered DISABLED by the picker, which would hide the
  // one production fine-tune behind a note that is no longer true.
  const row = higgs.higgsNarrationVoices(PICKER_USER_DATA).find((v) => v.value === 'deathstalker');
  assert.ok(row, 'the production fine-tune is not listed at all');
  assert.ok(!row.unavailable, 'the certified voice is still offered as unavailable');
  assert.ok(!/not installed/.test(row.label), 'the label still says not installed');
  const ok = higgs.higgsNarrationVoices(PICKER_USER_DATA).find((v) => v.value === 'default');
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
  const py = TRUE_HOST === 'win32' ? 'python' : 'python3';
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
      '                  "target_chars": one.target_chars,',
      '                  "safe_min_chars": getattr(one, "safe_min_chars", None),',
      '                  "safe_max_chars": getattr(one, "safe_max_chars", None),',
      '                  "sampling": getattr(one, "sampling", None),',
      '                  "source": one.max_chars_source}))',
    ].join('\n');
    const py = TRUE_HOST === 'win32' ? 'python' : 'python3';
    return spawnSync(py, ['-c', code], { encoding: 'utf-8' });
  };

  check("narrator ACCEPTS the default voice's document", () => {
    const r = runLoad(higgs.higgsVoicesDocument(higgs.resolveHiggsModel('default'), WSL_DOC));
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
    const r = runLoad(higgs.higgsVoicesDocument(m, WSL_DOC));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.clips, 1);
    assert.strictEqual(got.max_chars, 600);
    assert.strictEqual(got.source, 'catalog');
  });

  check('narrator ACCEPTS a checkpoint voice WITH a measured cap', () => {
    const m = probeVoice({
      id: 'ft', kind: 'checkpoint',
      // A GUEST path, not CROSS: the wsl entry is the directory the launch
      // script receives inside the guest, and load_voices never opens it (only
      // clips are checked for existence), so a real Windows temp dir would be
      // the wrong shape for the right reason.
      voice: { checkpoint: { wsl: '/home/telltale/higgs_v3_merged/ft' } },
      backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep', referenceSecondsCap: 30, allowedControls: [] } },
    });
    const r = runLoad(higgs.higgsVoicesDocument(m, WSL_DOC));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.checkpoint, '/home/telltale/higgs_v3_merged/ft');
    assert.strictEqual(got.max_chars, 1350);
    assert.strictEqual(got.source, 'length-sweep');
  });

  check('narrator ACCEPTS the SHIPPED deathstalker document, cap and all', () => {
    // The promotion, driven through narrator's own loader rather than described
    // from this side. load_voices does not touch the checkpoint DIRECTORY (that
    // is require_generation_config's job, inside WSL), so the real document
    // loads here and proves the two sides agree about the certified row.
    //
    // THE DOCUMENT IS WRITTEN FOR AN ARM, and this call has to say which. It
    // read `higgsVoicesDocument(model)` until 2026-09-05 and threw
    // "Cannot read properties of undefined (reading 'translatePath')" from that
    // day's per-arm rewrite: a checkpoint lives on ONE machine's disk, the
    // guest's and the Mac's cannot see each other, so there is no armless answer
    // to "which directory does deathstalker load from".
    const m = higgs.resolveHiggsModel('deathstalker');
    const r = runLoad(higgs.higgsVoicesDocument(m, WSL_DOC));
    assert.strictEqual(r.status, 0, 'narrator refused it:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.name, 'deathstalker');
    assert.strictEqual(got.cls, 'DefaultVoice', 'a fine-tune is prompted TEXT-ONLY');
    assert.strictEqual(got.checkpoint,
      '/home/telltale/higgs_v3_merged/ds_v7_930_prod');
    assert.strictEqual(got.max_chars, 800, "narrator did not get Owen's 2026-09-09 ceiling");
    // Owen, 2026-09-09: the point target is retired; a fine-tune ships a BAND, and
    // this asserts the packer's floor and cap where they LAND, not only where they
    // are written.
    assert.strictEqual(got.target_chars, null,
      'a fine-tune must no longer carry a point target');
    assert.strictEqual(got.safe_min_chars, 600,
      'narrator did not get the packer FLOOR that rides beside the cap');
    assert.strictEqual(got.safe_max_chars, 800,
      'narrator did not get the packer CAP');
    assert.strictEqual(got.source, 'catalog');

    // AND THE MAC'S DOCUMENT IS A DIFFERENT DOCUMENT — the Mac's own copy of the
    // directory, and the MLX sweep's 900 rather than the served 1200. Driven
    // through the same loader, because "the cap travels" has to be true on the
    // arm whose number is the smaller one: that is the arm where inheriting the
    // other's cap would silently lose text.
    const macDoc = higgs.higgsVoicesDocument(m, {
      arm: 'darwin', userDataDir: '/Users/fake/Library/Application Support/BookForge',
    });
    const rm = runLoad(macDoc);
    assert.strictEqual(rm.status, 0, 'narrator refused the Mac document:\n' + (rm.stderr || '').trim());
    const macGot = JSON.parse(rm.stdout.trim().split('\n').pop());
    // SEPARATORS NORMALISED, because `path.join` binds win32/posix at load and
    // this keeper runs on both hosts — the derivation is what is under test, not
    // which slash the machine running it prefers.
    assert.strictEqual(macGot.checkpoint.replace(/\\/g, '/'),
      '/Users/fake/Library/Application Support/BookForge/runtime/higgs-models/ds_v7_930_prod');
    // Both arms carry 800 by the ruling, not by inheritance; the checkpoint
    // asserted above is what proves this is the darwin document.
    assert.strictEqual(macGot.max_chars, 800,
      "the Mac document does not carry the ruling's ceiling");
  });

  check('narrator ACCEPTS the SHIPPED zero-shot documents, clip and cap', () => {
    // The four zeroshot-* entries, resolved against a userData whose models
    // area holds (empty) files by the catalog's names — load_voices checks
    // os.path.isfile on every clip and reads nothing else at load.
    for (const m of higgs.listHiggsModels().filter((v) => v.kind === 'clips')) {
      const doc = higgs.higgsVoicesDocument(m, { arm: 'wsl', userDataDir: ZS_USER_DATA });
      const r = runLoad(doc);
      assert.strictEqual(r.status, 0, `narrator refused ${m.id}:\n` + (r.stderr || '').trim());
      const got = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.strictEqual(got.name, m.id);
      assert.strictEqual(got.cls, 'ClipsVoice', `${m.id} did not load as a reference clone`);
      assert.strictEqual(got.clips, 1);
      assert.strictEqual(got.checkpoint, null, `${m.id} loaded with a checkpoint — it is the BASE weights`);
      assert.strictEqual(got.max_chars, 600);
      assert.strictEqual(got.source, 'placeholder');
    }
  });

  check('narrator ACCEPTS an OVERRIDE document — dir, merged sampling, _overrideNote', () => {
    // THE ONE ASSERTION THAT CANNOT BE MADE FROM THIS SIDE. `_overrideNote` is a
    // key narrator never heard of, and the reason it is safe to send is that
    // `load_voices` reads the entry key by key rather than validating its key set
    // — true when it was read (2026-09-11) and exactly the kind of thing that
    // changes without anyone here noticing. The sampling block is the other half:
    // `_voice_sampling` DOES refuse an unknown key, so a merged block has to
    // contain only the three levers.
    const m = higgs.higgsModelForRender('deathstalker', {
      checkpointDir: '/home/telltale/higgs_v3_merged/ds_v8_1200_test',
      sampling: { temperature: 0.8 },
      note: 'keeper: the override document must load in narrator',
    });
    const r = runLoad(higgs.higgsVoicesDocument(m, WSL_DOC));
    assert.strictEqual(r.status, 0, 'narrator refused the override document:\n' + (r.stderr || '').trim());
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.name, 'deathstalker+ds_v8_1200_test');
    assert.strictEqual(got.cls, 'DefaultVoice', 'an override checkpoint must be prompted TEXT-ONLY');
    assert.strictEqual(got.checkpoint, '/home/telltale/higgs_v3_merged/ds_v8_1200_test');
    // MERGED, not replaced: narrator's own docstring warns that a partial block
    // leaves the rest at the checkpoint's generation_config.json (1.0, which
    // nobody chose), so the override must arrive complete.
    assert.deepStrictEqual(got.sampling, { temperature: 0.8, top_p: 0.95, top_k: 50 });
    assert.strictEqual(got.max_chars, 800, "the base voice's certificate must travel unchanged");
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

// ─────────────────────────────────────────────────────────────────────────────
// 11. THE PER-RUN OVERRIDE — rendering something the catalog has not certified
// ─────────────────────────────────────────────────────────────────────────────
//
// Owen, 2026-09-11: "i just tried to use the cli on a merged checkpoint as a test
// here on the mac and it wouldnt let me." `higgsModelForRender` is the door that
// answers it, and what has to stay true of it is not "does it work" — it is that
// it CHANGES NOTHING when no override is given, that it keeps every catalog
// refusal when one is, and that what it produces is a document narrator loads
// (section 10 runs that half against the real loader).
//
// The failure these guard against is the one this whole file is about: a derived
// model that is subtly not what was asked for renders an hour of audio in a voice
// nobody chose and reports success.
console.log('per-run render override');

// A directory that really exists, for the darwin arm's existence check. The Mac
// is the arm where an override names a HOST path, so this is the one place in
// this file where the filesystem is part of the contract.
const OVERRIDE_DIR = fs.mkdtempSync(path.join(HOST_TMP, 'bf-higgs-merged-'));
process.on('exit', () => { try { fs.rmSync(OVERRIDE_DIR, { recursive: true, force: true }); } catch {} });

function overrideThrows(voiceId, override) {
  try {
    higgs.higgsModelForRender(voiceId, override);
  } catch (err) {
    return err;
  }
  return null;
}

check('NO override is the catalog, unchanged — same model, same refusals', () => {
  // The reason every render door may call this instead of resolveHiggsModel.
  // deepStrictEqual rather than strictEqual: the catalog is re-read per call, so
  // the two are equal values and never the same object.
  assert.deepStrictEqual(
    higgs.higgsModelForRender('deathstalker'),
    higgs.resolveHiggsModel('deathstalker'));
  // And the refusals are still the catalog's, by identity of message.
  const bad = overrideThrows('not-a-voice');
  assert.ok(bad, 'an unknown voice was accepted');
  assert.match(bad.message, /not in the catalog/);
});

check('an override DERIVES from the base voice: id names both, kind is checkpoint', () => {
  const m = higgs.higgsModelForRender('deathstalker', {
    checkpointDir: '/home/telltale/higgs_v3_merged/ds_v8_1200_test',
    note: 'keeper',
  });
  // The id is what `--higgs_voice` carries, what keys the document, and what
  // session_state.json and job-analytics.json record — so it names the base
  // voice AND the directory. "override" alone answers nothing six weeks later.
  assert.strictEqual(m.id, 'deathstalker+ds_v8_1200_test');
  assert.strictEqual(m.kind, 'checkpoint');
  assert.match(m._overrideNote, /keeper/);
  // ONLY THIS ARM. Claiming the other one asserts a copy on a disk nobody looked
  // at — the same mistake the retired single `checkpointDir` string made.
  assert.deepStrictEqual(m.voice.checkpoint, { wsl: '/home/telltale/higgs_v3_merged/ds_v8_1200_test' });
  // The CATALOG is untouched: a later resolve must not see the override.
  assert.deepStrictEqual(higgs.resolveHiggsModel('deathstalker').voice.checkpoint, {
    wsl: '/home/telltale/higgs_v3_merged/ds_v7_930_prod',
    darwin: 'runtime/higgs-models/ds_v7_930_prod',
  });
});

check("a base of kind 'default' takes a checkpoint — base weights are a legal starting point", () => {
  // The zero-shot 600 placeholder is what such a run is judged against, and it
  // is stated rather than inherited silently: `maxCharsSource` says 'placeholder'.
  const m = higgs.higgsModelForRender('default', {
    checkpointDir: '/home/telltale/higgs_v3_merged/fresh_merge',
    note: 'keeper: a fresh merge nobody has certified',
  });
  assert.strictEqual(m.id, 'default+fresh_merge');
  assert.strictEqual(m.kind, 'checkpoint');
  const caps = higgs.higgsVoiceCapsForModel(m);
  assert.strictEqual(caps.maxChars, 600);
  assert.strictEqual(caps.maxCharsSource, 'placeholder');
});

check("a 'clips' base + a checkpoint is REFUSED — the checkpoint IS the voice", () => {
  const err = overrideThrows('zeroshot-deathstalker', {
    checkpointDir: '/home/telltale/higgs_v3_merged/ds_v8_1200_test',
    note: 'keeper',
  });
  assert.ok(err, 'a clips voice accepted a checkpoint');
  assert.match(err.message, /THE CHECKPOINT IS THE VOICE/);
  assert.match(err.message, /zeroshot-deathstalker/, 'the refusal does not name the voice');
});

check('the WSL arm takes a GUEST path verbatim, and refuses a drive path', () => {
  const err = overrideThrows('deathstalker', { checkpointDir: 'E:\\merged\\ds_v8', note: 'keeper' });
  assert.ok(err, 'a Windows drive path was accepted as a guest checkpoint');
  assert.match(err.message, /guest-resident/);
  // 8.5 GB over the 9p mount is the measured reason, and the refusal says so.
  assert.match(err.message, /9p/);
});

onArm('darwin', () => {
  check('an ABSOLUTE Mac directory travels verbatim — resolver AND document', () => {
    const m = higgs.higgsModelForRender('deathstalker', {
      checkpointDir: OVERRIDE_DIR,
      note: 'keeper: a merged checkpoint on this Mac',
    });
    // `higgsCheckpointDirFor` must NOT join userData onto it: that would name a
    // directory inside Application Support that has never held these weights.
    assert.strictEqual(higgs.higgsCheckpointDirFor(m, 'darwin', MAC_USER_DATA), OVERRIDE_DIR);
    // And the document — the only thing narrator reads — carries the same string.
    const doc = higgs.higgsVoicesDocument(m, { arm: 'darwin', userDataDir: MAC_USER_DATA });
    assert.strictEqual(doc[m.id].checkpointDir, OVERRIDE_DIR);
    assert.match(doc[m.id]._overrideNote, /merged checkpoint on this Mac/);
    // The base voice's certificate travels unchanged — that is the point.
    assert.strictEqual(doc[m.id].maxChars, 800);
  });

  check('a relative override, and a directory that does not exist, are REFUSED', () => {
    const rel = overrideThrows('deathstalker', {
      checkpointDir: 'runtime/higgs-models/ds_v8', note: 'keeper',
    });
    assert.ok(rel, 'a relative override was accepted on the Mac');
    assert.match(rel.message, /not absolute/);
    const gone = overrideThrows('deathstalker', {
      checkpointDir: path.join(OVERRIDE_DIR, 'nope'), note: 'keeper',
    });
    assert.ok(gone, 'a missing directory was accepted');
    assert.match(gone.message, /not a directory on this Mac/);
    // The refusal says what the silent alternative would have cost.
    assert.match(gone.message, /DIFFERENT SPEAKER/);
  });

  check('the CATALOG still refuses an absolute darwin path — only an override may', () => {
    // The gate is `_overrideNote`, so a hand-edited catalog cannot borrow it: a
    // repo-tracked absolute Mac path names a directory on exactly one machine.
    const m = probeVoice({
      id: 'hand-edited', kind: 'checkpoint',
      voice: { checkpoint: { darwin: '/Users/telltale/merged/ds' } },
      backends: { mlx: { maxChars: 800, maxCharsSource: 'catalog' } },
    });
    assert.throws(() => higgs.higgsCheckpointDirFor(m, 'darwin', MAC_USER_DATA), /is absolute/);
  });

  check('the cap patch shows up in the caps — and keeps narrator\'s closed source set', () => {
    const m = higgs.higgsModelForRender('deathstalker', {
      checkpointDir: OVERRIDE_DIR,
      maxChars: 1200, safeMinChars: 700, safeMaxChars: 1100,
      note: 'keeper: sweeping the band the checkpoint was trained at',
    });
    const caps = higgs.higgsVoiceCapsForModel(m);
    assert.strictEqual(caps.maxChars, 1200);
    assert.strictEqual(caps.safeMinChars, 700);
    assert.strictEqual(caps.safeMaxChars, 1100);
    // 'catalog' is the honest source for a number a person chose: narrator's set
    // is closed, so claiming 'length-sweep' would be a lie the protocol accepts.
    assert.strictEqual(caps.maxCharsSource, 'catalog');
    assert.ok(higgs.HIGGS_MAX_CHARS_SOURCES.includes(caps.maxCharsSource));
    const doc = higgs.higgsVoicesDocument(m, { arm: 'darwin', userDataDir: MAC_USER_DATA });
    assert.strictEqual(doc[m.id].maxChars, 1200);
    assert.strictEqual(doc[m.id].safeMaxChars, 1100);
  });

  check('a band OUTSIDE the cap is refused — by the document, for override and catalog alike', () => {
    // The relational rules are NOT restated in the override path: one check, one
    // message, narrator's wording. This proves the override reaches it.
    const m = higgs.higgsModelForRender('deathstalker', {
      checkpointDir: OVERRIDE_DIR, safeMaxChars: 1200, note: 'keeper',
    });
    assert.throws(
      () => higgs.higgsVoicesDocument(m, { arm: 'darwin', userDataDir: MAC_USER_DATA }),
      /safeMaxChars 1200 above its darwin cap of 800/);
  });

  check('a non-integer cap is refused by name', () => {
    const err = overrideThrows('deathstalker', {
      checkpointDir: OVERRIDE_DIR, maxChars: 900.5, note: 'keeper',
    });
    assert.ok(err, 'a fractional cap was accepted');
    assert.match(err.message, /maxChars 900\.5 is not a positive whole number/);
  });

  check('SAMPLING merges over the engine-level block, with its reason attached', () => {
    const m = higgs.higgsModelForRender('deathstalker', {
      checkpointDir: OVERRIDE_DIR,
      sampling: { temperature: 0.8 },
      note: 'keeper: the 0.8 control Owen asked the PC to serve',
    });
    // MERGED, not replaced. narrator takes a voice's sampling block whole, so a
    // lone temperature would drop top_p/top_k to the checkpoint's own
    // generation_config.json (1.0, which nobody chose).
    const caps = higgs.higgsVoiceCapsForModel(m);
    assert.deepStrictEqual(caps.sampling, { temperature: 0.8, topP: 0.95, topK: 50 });
    // And it passes the rule `higgsVoiceCapsForModel` enforces on every block
    // that deviates — BY CONSTRUCTION, not by being exempt from it.
    assert.match(m.backends.mlx._samplingNote, /reason/i);
    assert.match(m.backends.mlx._samplingNote, /0\.8 control/);
    const doc = higgs.higgsVoicesDocument(m, { arm: 'darwin', userDataDir: MAC_USER_DATA });
    assert.deepStrictEqual(doc[m.id].sampling, { temperature: 0.8, topP: 0.95, topK: 50 });
  });

  check('a sampling value outside its range is REFUSED by name', () => {
    const hot = overrideThrows('deathstalker', {
      checkpointDir: OVERRIDE_DIR, sampling: { temperature: 2.5 }, note: 'keeper',
    });
    assert.ok(hot, 'temperature 2.5 was accepted');
    assert.match(hot.message, /temperature 2\.5 is outside \(0, 2\]/);
    // A temperature past 2 does not fail — it babbles for a whole book.
    assert.match(hot.message, /babble/);
    const p = overrideThrows('deathstalker', {
      checkpointDir: OVERRIDE_DIR, sampling: { topP: 95 }, note: 'keeper',
    });
    assert.ok(p, 'top_p 95 was accepted');
    assert.match(p.message, /topP 95 is outside \(0, 1\]/);
    const k = overrideThrows('deathstalker', {
      checkpointDir: OVERRIDE_DIR, sampling: { topK: 1.5 }, note: 'keeper',
    });
    assert.ok(k, 'a fractional top_k was accepted');
    assert.match(k.message, /topK 1\.5 is not a positive whole number of candidates/);
  });

  check('an EMPTY note is refused — an override nobody can attribute', () => {
    for (const note of ['', '   ', undefined]) {
      const err = overrideThrows('deathstalker', { checkpointDir: OVERRIDE_DIR, note });
      assert.ok(err, `note ${JSON.stringify(note)} was accepted`);
      assert.match(err.message, /carries no `note`/);
    }
  });

  check('an override with NO checkpoint is still legal — sampling and caps alone', () => {
    // Sweeping a knob on the SHIPPED weights. The id says `+override` because
    // there is no directory to name, and the voice's own checkpoint is untouched.
    const m = higgs.higgsModelForRender('deathstalker', {
      sampling: { topK: 20 }, note: 'keeper: top_k sweep on the shipped voice',
    });
    assert.strictEqual(m.id, 'deathstalker+override');
    assert.strictEqual(m.kind, 'checkpoint');
    assert.deepStrictEqual(m.voice.checkpoint, {
      wsl: '/home/telltale/higgs_v3_merged/ds_v7_930_prod',
      darwin: 'runtime/higgs-models/ds_v7_930_prod',
    });
    assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(m).sampling,
      { temperature: 0.7, topP: 0.95, topK: 20 });
  });
});

check('the render doors resolve the voice through ONE function', () => {
  // Four spawn sites read the voice: buildJobSpawn (which WRITES the document),
  // the prep argv, the retake argv and the worker argv. If one resolved the
  // catalog voice while the others resolved the override, the argv's
  // `--higgs_voice` and the document's single key would disagree — and narrator's
  // answer to a voice its document does not name is not a crash, it is a book in
  // the base model's speaker. So no Higgs render door may call the voice-only
  // door; `higgsModelForJob(settings)` is the only one that can see an override.
  assert.strictEqual(/higgsPreflight/.test(bridgeSrc), false,
    'parallel-tts-bridge still resolves a Higgs voice without its override');
  const sites = bridgeSrc.match(/higgsModelForJob\(/g) || [];
  assert.strictEqual(sites.length, 4,
    `expected 4 higgsModelForJob call sites in the bridge, saw ${sites.length}`);
  // Listen stays catalog-only — a resident engine shared by every tab is not the
  // place to load an uncertified checkpoint.
  const pool = fs.readFileSync(path.join(REPO, 'electron', 'orpheus-worker-pool.ts'), 'utf-8');
  assert.ok(/higgsPreflight\(/.test(pool), 'the streaming pool no longer uses the catalog-only door');
  assert.strictEqual(/higgsModelForJob/.test(pool), false,
    'the streaming pool reads a book render override — Listen is catalog-only');
});

check('TEST MODE is capped by ONE helper, in both render doors', () => {
  // It was four lines in startParallelConversion only, so `--test-sentences`
  // through the queue capped the run and the same setting through the CLI
  // rendered the whole book — a two-hour answer to a two-minute question, with
  // nothing in the log to say the cap had been dropped.
  const calls = bridgeSrc.match(/applyTestSentenceCap\(/g) || [];
  assert.strictEqual(calls.length, 3, // one definition, two call sites
    `expected the helper plus 2 call sites, saw ${calls.length} mentions`);
  assert.match(bridgeSrc, /applyTestSentenceCap\(prepInfo, config\.settings, 'PARALLEL-TTS'\)/);
  assert.match(bridgeSrc, /applyTestSentenceCap\(prepInfo, settings, 'renderRangeHeadless'\)/);
});

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
