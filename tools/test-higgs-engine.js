#!/usr/bin/env node
/**
 * Tests for THE HIGGS ENGINE OPTION — the engine-id model and the catalog's
 * refusals. Serving is Crucible's; what BookForge keeps of a voice is this catalog.
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
 *  - and a checkpoint named for one arm and handed to the other is a load that fails
 *    with a path nobody on that machine has ever seen.
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
 * higgs-models.js does not use it, but what this file loads beside it does. One stub for the whole file, rather than per-suite plumbing.
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
const CATALOG_FILE = path.join(DIST, 'data', 'higgs-models.json');
function withExtraVoices(extra, fn) {
  const shipped = fs.readFileSync(CATALOG_FILE, 'utf-8');
  const parsed = JSON.parse(shipped);
  parsed.models = [...parsed.models, ...extra];
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
  try { return fn(); } finally { fs.writeFileSync(CATALOG_FILE, shipped, 'utf-8'); }
}
/** A voice as the catalog would hold it, through the door every render resolves a voice by. */
function resolving(model) {
  return withExtraVoices([model], () => higgs.resolveHiggsModel(model.id));
}

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

const MAC_USER_DATA = fs.mkdtempSync(path.join(HOST_TMP, 'bf-higgs-userdata-'));

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

check('higgs is the runnable set — the whole of it', () => {
  // Was `['orpheus', 'higgs']` until 2026-09-14. Owen ruled Orpheus deprecated on
  // that date ("higgs is the frontier") and this is the line the ruling had to
  // reach: `SELECTABLE_ORDER` IS the narration picker, so for as long as it said
  // `orpheus` first, the narrate modal went on offering Orpheus ahead of Higgs
  // whatever the docs said.
  assert.deepStrictEqual([...caps.narrationEngineOrder()], ['higgs']);
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
  assert.strictEqual(caps.engineDisplayName('higgs'), 'Higgs');
});

check('orpheus displays as "Orpheus (retired)" and still LOADS', () => {
  // Retired 2026-09-14, and the one whose CODE is still here: unlike XTTS, the
  // Orpheus spawn layer, component and voice roster are all intact and run. So
  // this is the case where "loads and displays but never renders" is doing real
  // work rather than describing an absence.
  assert.strictEqual(caps.isTtsEngine('orpheus'), true);
  assert.ok(caps.engineCaps('orpheus'));
  assert.strictEqual(caps.isRunnableTtsEngine('orpheus'), false);
  assert.strictEqual(caps.engineDisplayName('orpheus'), 'Orpheus (retired)');
  // Its capability row survives whole — the fine-tune roster a legacy record's
  // voice name is displayed against is still there to display it.
  assert.ok(caps.TTS_ENGINES.orpheus.voices.presets.length > 0,
    'the Orpheus voice roster was deleted with the picker entry');
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
  assert.strictEqual(caps.assertRunnableTtsEngine('higgs'), 'higgs');
});

check('assertRunnableTtsEngine REFUSES orpheus by name — never coerces to Higgs', () => {
  // The coercion got MORE tempting on 2026-09-14, not less: with one runnable
  // engine left there is an obvious thing to substitute. It is wrong for the
  // same reason it always was — a book rendered in a voice nobody chose, and
  // reported as success.
  let threw = null;
  try { caps.assertRunnableTtsEngine('orpheus'); } catch (err) { threw = err; }
  assert.ok(threw, 'orpheus was accepted by the render door');
  assert.match(threw.message, /Orpheus/, 'the refusal does not name the engine');
  assert.match(threw.message, /2026-09-14/, 'the refusal does not carry the retirement date');
});

check('an unknown engine is refused and the message says what IS renderable', () => {
  let threw = null;
  try { caps.assertRunnableTtsEngine('nope'); } catch (err) { threw = err; }
  assert.ok(threw);
  assert.match(threw.message, /higgs/);
  assert.ok(!/orpheus/.test(threw.message),
    'the refusal still advertises orpheus as something this build renders');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The voice catalog rule
// ─────────────────────────────────────────────────────────────────────────────
const nv = require(path.join(REPO, 'dist', 'shared', 'tts', 'narration-voices.js'));

console.log('voice catalog routing');

const CATALOG = {
  higgs: [{ value: 'h', label: 'h' }],
};

check('higgs gets the HIGGS list, and no other', () => {
  // The regression this replaced: `engine === 'orpheus' ? orpheus : xtts` gave
  // the Higgs picker a list of XTTS reference clips, and nothing failed until a
  // render came back in the wrong voice.
  assert.deepStrictEqual(nv.narrationVoicesFor('higgs', CATALOG), CATALOG.higgs);
});

// "orpheus still gets the orpheus list" left in step 8: its roster did. Orpheus is a retired engine below.
check("a retired engine gets an EMPTY list — and never another engine's", () => {
  // This asserted `CATALOG.xtts` until 2026-09-05, when XTTS left the root: that
  // list was a live read of installed XTTS checkpoints, and there is nothing left
  // to read. Empty is the only true answer. What must NOT happen — and is what
  // this check is really for — is a retired id falling through to the Orpheus or
  // Higgs list, which would offer a voice the record was never rendered in.
  for (const retired of ['orpheus', 'xtts', 'f5', 'voxtral']) {
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
  // PROMOTED 2026-09-15 to ds_v8_rvcbed1_3658_prod (ckpt-3658, the run's last checkpoint), superseding
  // ds_v7_930_prod which held this slot from 2026-09-11. FIVE books through RVC with an own-source bed (Marked
  // Man dialogue excluded, 3000 Degrees, Leadership Pipeline, McKinley, Celebration of Discipline), 38.4 h,
  // holdout 3.5285 against ds_v7's 3.8395. The screen rendered every checkpoint in the 500-600 band: 19 of 31
  // clean, 3658 = 0 defects, pausing score 90.9 against ds_v7's 87.1, and Owen's rule takes the LATEST clean one.
  // BAND 500-800 IS A RULING, not the failure curve: band_chart named 400-1000 on failures alone, but the median
  // LONGEST pause climbs with chunk length (1.38 s at 500 chars, 1.54 at 800, 1.68 at 900-999), so prosody
  // degrades before defects appear. Owen ruled 500-800 on 2026-09-14. Re-pooled by ACTUAL character count it is
  // the joint best available: 3/120 = 2.50%, against the ladder's own 700-1100 at 5.49% on this checkpoint.
  // Evidence: orpheus-finetune field notes 4n.72/4n.72b/4n.72d and _campaigns/_reports/ds_v8_rvcbed1_band.html.
  const m = higgs.listHiggsModels().find((v) => v.id === 'deathstalker');
  assert.strictEqual(m.voice.checkpoint.wsl,
    '/home/telltale/higgs_v3_merged/ds_v8_rvcbed1_3658_prod');
  assert.ok(m._checkpointDirNote, 'nothing says why this is not the higgs-models convention');
});

check('deathstalker is staged on BOTH arms, each in that arm\'s own shape', () => {
  // THE GAP THIS BRANCH CLOSES. One `checkpointDir` string could only be one
  // machine's path, and it was the guest's — so a Mac render was handed
  // /home/<user>/… and the MLX backend refused a directory that machine has
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
    'runtime/higgs-models/ds_v8_rvcbed1_3658_prod');
  assert.ok(m.voice.checkpoint.wsl.startsWith('/'), 'the wsl path is not absolute');
  assert.ok(!m.voice.checkpoint.darwin.startsWith('/'),
    'the darwin path is absolute — it would name one machine only');
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
  assert.throws(() => onArm('wsl', () => resolving(wslRelative)),
    /wsl checkpoint .* is not a guest-resident path/,
    'a relative WSL path was accepted');

  const darwinAbsolute = probeVoice({
    kind: 'checkpoint',
    voice: { checkpoint: { darwin: '/Users/<user>/Library/Application Support/BookForge/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => onArm('darwin', () => resolving(darwinAbsolute)),
    /darwin checkpoint .* is absolute/,
    'an absolute darwin path was accepted — it names one machine only');

  const escapes = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { darwin: '../../elsewhere/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => onArm('darwin', () => resolving(escapes)), /climbs out of userData/);

  const unknownArm = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { linux: '/opt/x' } },
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  });
  assert.throws(() => onArm('wsl', () => resolving(unknownArm)), /linux/,
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
  try { resolving(legacy); } catch (err) { threw = err; }
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
    assert.throws(() => onArm('wsl', () => resolving(m)), /Higgs voice "probe"/,
      why + ' was accepted');
  }
});

check('NO fine-tune states its cap, band, target or pace here — the server that serves it does', () => {
  // Owen, 2026-09-28: "single source of truth. that source should be where the models are served."
  // A fine-tune's cap, band and pace are its pinned crucible-voice.toml's, stated per server by
  // GET /v1/voices (electron/crucible/voice-band.ts). The rulings and certificates these checks used
  // to pin (the 800 ruling, the ckpt-1080 certificates, each arm's evidence) are in git history and
  // in electron/data/higgs-safe-bands-evidence.md; tools/test-one-fact-one-owner.js keeps the copies out.
  const fineTunes = higgs.listHiggsModels().filter((m) => m.kind === 'checkpoint');
  assert.ok(fineTunes.length > 0, 'no fine-tune in the catalog to check');
  for (const m of fineTunes) {
    assert.strictEqual(m.pace, undefined, `${m.id}: a pace in the catalog`);
    for (const [backend, caps] of Object.entries(m.backends)) {
      for (const f of ['maxChars', 'maxCharsSource', 'safeMinChars', 'safeMaxChars', 'targetChars']) {
        assert.strictEqual(caps[f], undefined, `${m.id}/${backend}: ${f} in the catalog`);
      }
    }
  }
});

check('ONE engine-level sampling - 0.8 / 0.95 / 50 - reaches EVERY Higgs voice on BOTH arms', () => {
  // 0.8 SINCE 2026-09-12, Owen's ruling after the pause-map work ("Let's set temp
  // to 0.8 across the board for Higgs in Bookforge. Streaming and rendering
  // both."): same-chunk A/Bs put 0.8 at 4/88 guard fires against 0.7's 2/88 and
  // 0.6's 28/88, and the SHIPPED pause tail halved at 0.8 vs 0.7. The >5 s
  // interior-silence gate (truncation.py, Sep 12) covers 0.8's rare runaway.
  // The history below is kept as it was.
  //
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
  // ONE number for Listen streaming and book renders alike. Stated ONCE at the
  // catalog top with its reason; a per-block deviation must carry a reason too
  // or it is refused, so 14 copies of a number can never drift.
  const engine = higgs.higgsEngineSampling();
  assert.deepStrictEqual(engine, { temperature: 0.8, topP: 0.95, topK: 50 });
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

check('resolveHiggsModel RESOLVES the certified deathstalker — no refusal left', () => {
  // Every refusal this voice used to trip — pending, malformed, unmeasured cap,
  // oversized reference — must now pass.
  const m = higgs.resolveHiggsModel('deathstalker');
  assert.strictEqual(m.id, 'deathstalker');
  assert.strictEqual(m.kind, 'checkpoint');
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

check('a blank, whitespace or missing transcript is REFUSED, naming the file', () => {
  for (const bad of ['', '   ', undefined]) {
    const m = probeVoice({
      kind: 'clips',
      voice: { clips: [{ path: '/tmp/cd_00001100.wav', transcript: bad, seconds: 14 }] },
    });
    let threw = null;
    try { resolving(m); } catch (err) { threw = err; }
    assert.ok(threw, 'transcript ' + JSON.stringify(bad) + ' was accepted');
    assert.match(threw.message, /cd_00001100/, 'the refusal does not name the clip');
    assert.match(threw.message, /transcript/i);
  }
});

check('a clip with no declared `seconds` is REFUSED', () => {
  for (const bad of [undefined, null, 0, -1, 'x']) {
    const m = probeVoice({
      kind: 'clips',
      voice: { clips: [{ path: '/tmp/a.wav', transcript: 'hello there', seconds: bad }] },
    });
    assert.throws(() => resolving(m), /duration/i,
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
  try { resolving(m); } catch (err) { threw = err; }
  assert.ok(threw, 'a multi-clip voice was accepted');
  assert.match(threw.message, /EXACTLY ONE/);
  assert.match(threw.message, /join/i, 'the refusal does not say how to fix it');
});

check('a reference over the 30 s server cap is REFUSED before launch', () => {
  const m = probeVoice({
    kind: 'clips',
    voice: { clips: [{ path: '/tmp/a.wav', transcript: 'long one', seconds: 42 }] },
  });
  assert.throws(() => resolving(m), /cap/);
});

check('a 27 s single joined reference PASSES', () => {
  const m = probeVoice({
    kind: 'clips',
    voice: { clips: [{ path: '/tmp/joined.wav', transcript: 'a joined pair', seconds: 27.4 }] },
  });
  assert.strictEqual(resolving(m).id, 'probe');
});

check('a checkpoint WITH a measured cap and its source passes', () => {
  const m = probeVoice({
    kind: 'checkpoint',
    voice: { checkpoint: { wsl: '/home/x/higgs-models/probe' } },
    backends: { served: { maxChars: 1350, maxCharsSource: 'length-sweep' } },
  });
  assert.strictEqual(onArm('wsl', () => resolving(m)).id, 'probe');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The default voice and its caps
// ─────────────────────────────────────────────────────────────────────────────
console.log('the default voice and its caps');

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

// ─────────────────────────────────────────────────────────────────────────────
// 5a. ONE CHECKPOINT PER ARM — the gap this branch closes
// ─────────────────────────────────────────────────────────────────────────────
//
// A `checkpoint` voice is ~8.5 GB on disk and the two arms cannot see each
// other's disks. Until 2026-09-05 the catalog held ONE `checkpointDir`, and it
// was the WSL guest's — so a Mac render was handed /home/<user>/… and refused
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
  const m = stagedVoice({ wsl: '/home/<user>/higgs_v3_merged/ds' });

  assert.strictEqual(onArm('wsl', () => higgs.higgsCheckpointDirFor(m, 'wsl')), '/home/<user>/higgs_v3_merged/ds',
    'the arm that HAS the weights did not get them');
  assert.strictEqual(onArm('wsl', () => resolving(m)).id, 'ft');

  let threw = null;
  try { onArm('darwin', () => resolving(m)); } catch (err) { threw = err; }
  assert.ok(threw, "darwin resolved a voice that machine has no copy of");
  // BY NAME: the voice, the arm, and what to do — never the other arm's path and
  // never a search of the disk.
  assert.match(threw.message, /Higgs voice "ft" is not staged for the Mac/);
  assert.match(threw.message, /no darwin checkpoint in the catalog/);
  assert.ok(!/\/home\/<user>/.test(threw.message.split('it names only')[0]),
    "the refusal offered the WSL path as if it were an answer");
  assert.match(threw.message, /new certificate/,
    'the refusal does not say that staging a copy means measuring again');
});

check('a darwin-only fine-tune is REFUSED ON WSL, by name', () => {
  // The mirror. Neither arm is the fallback for the other; a missing arm is a
  // voice that does not exist there.
  const m = stagedVoice({ darwin: 'runtime/higgs-models/ds' });
  let threw = null;
  try { onArm('wsl', () => resolving(m)); } catch (err) { threw = err; }
  assert.ok(threw, 'WSL was handed the Mac\'s copy');
  assert.match(threw.message, /Higgs voice "ft" is not staged for WSL/);
  assert.match(threw.message, /no wsl checkpoint in the catalog/);
  assert.match(threw.message, /it names only: darwin/,
    'the refusal does not say where the voice IS staged');
});

check('staged on BOTH arms: each arm gets ITS path, absolute and arm-shaped', () => {
  const m = stagedVoice({
    wsl: '/home/<user>/higgs_v3_merged/ds_ad4lm_prod_ckpt1080',
    darwin: 'runtime/higgs-models/ds_ad4lm_prod_ckpt1080',
  });

  const wsl = higgs.higgsCheckpointDirFor(m, 'wsl');
  assert.strictEqual(wsl, '/home/<user>/higgs_v3_merged/ds_ad4lm_prod_ckpt1080',
    'the WSL arm did not get the GUEST path');

  // RESOLVED TO ABSOLUTE against the fixture userData: the picker asks the disk with this string.
  const mac = higgs.higgsCheckpointDirFor(m, 'darwin', MAC_USER_DATA);
  assert.strictEqual(mac, path.join(MAC_USER_DATA, 'runtime', 'higgs-models', 'ds_ad4lm_prod_ckpt1080'));
  assert.notStrictEqual(wsl, mac, 'both arms got the same directory — one of them cannot open it');
});

check('the darwin arm REFUSES to resolve without a userData directory', () => {
  // No default and no search: guessing where a Mac's Application Support lives is
  // how a render loads 8.5 GB of the wrong weights (or none).
  const m = stagedVoice({ darwin: 'runtime/higgs-models/ds' });
  let threw = null;
  try { higgs.higgsCheckpointDirFor(m, 'darwin'); } catch (err) { threw = err; }
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

check('a fine-tune certified on ONE arm is renderable there and greyed on the other', () => {
  const wslOnly = {
    id: 'wslonly', label: 'WSL-only fine-tune', kind: 'checkpoint', engineVersion: 'v3',
    voice: { checkpoint: { wsl: '/home/<user>/higgs_v3_merged/wslonly' } },
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
  const m = stagedVoice({ wsl: '/home/<user>/higgs_v3_merged/ds' });
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
});

check("EVERY backend block states its cap — measured, or null, with a KNOWN source", () => {
  // The catalog-wide rule, over every block of every fine-tune, so a voice added
  // later cannot ship one arm certified and the other silently blank.
  const KNOWN_SOURCES = ['catalog', 'placeholder', 'length-sweep'];
  // ZERO-SHOT voices only: a fine-tune's cap is the server's (see the check above).
  for (const m of higgs.listHiggsModels().filter((x) => x.kind !== 'checkpoint')) {
    for (const [backend, caps] of Object.entries(m.backends)) {
      if (m.kind === 'checkpoint' && caps.maxChars === null) {
        assert.strictEqual(caps.maxCharsSource, null,
          `${m.id}/${backend}: an unmeasured cap names a source`);
        continue;
      }
      assert.ok(Number.isInteger(caps.maxChars) && caps.maxChars > 0,
        `${m.id}/${backend}: maxChars is ${JSON.stringify(caps.maxChars)}`);
      // A closed vocabulary, so a prose provenance string here is a mistake.
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


/*
 * TWO WATCHDOG CHECKS STOOD HERE AND THEIR SUBJECT IS DELETED.
 *
 * They pinned that the bridge's worker watchdogs all outlived a Higgs cold start
 * (~55 s warm, up to ~300 s cold), and that the bridge MIRRORED narrator's own
 * READY_TIMEOUT_SECONDS rather than guessing at it. There is no worker to watch:
 * a render is a Crucible job, and the server's own progress frames are the
 * heartbeat (`crucible/render.ts`).
 *
 * The measured numbers are not lost — WORKER_PROGRESS_TIMEOUT_MS (12 minutes,
 * widened from 5 because a legitimate MLX batch under GPU contention runs
 * minutes between per-sentence lines) and the cold-start figures are in
 * docs/LEGACY-REMOVAL.md's appendix. The RULE they encoded is the part worth
 * carrying into any future watchdog: a timeout shorter than a legitimate cold
 * start does not report a hang, it CAUSES one, by killing a process that was
 * working and then doing it twice more on retry.
 */

/*
 * THREE PATCH-SCRIPT CHECKS STOOD HERE AND THIS REPO NO LONGER SHIPS THEM.
 *
 * `patch_vllm.py` and `patch_sentinel_filter.py` edited vllm-omni's
 * site-packages in the local Higgs env; they went with `electron/scripts/higgs/`
 * (docs/LEGACY-REMOVAL.md) and narrator does NOT package them — only the two
 * launchers and the deploy profile. Patching an inference env is the thing that
 * installs it, which is Crucible.
 *
 * What they pinned is recorded in docs/LEGACY-REMOVAL.md and is the checklist
 * for whoever owns that env next:
 *
 *   - both patches must be RE-APPLIED after any pip upgrade, which is why the
 *     doctor grepped for markers on every check rather than trusting an
 *     "installed once" flag. Without patch_vllm.py every voice-clone request
 *     returns HTTP 400; without the sentinel filter every chunk ends with
 *     ~240 ms of audible garbage;
 *   - sentinels are filtered BY TOKEN IDENTITY, never by position — 0 is a valid
 *     codec code, so substituting a sentinel with 0 turns it into real sound,
 *     and codebook c is delayed by c positions so they smear across the last
 *     Q-1 = 7 frames;
 *   - `patch_vllm.py` once patched from a stale `.orig` and wrote OLD content
 *     back over a freshly upgraded site-packages file, which the doctor then
 *     certified as patched;
 *   - the staleness marker must be a VARIABLE NAME (HIGGS_SENTINEL_REPORT), not
 *     a fragment of a warning's format string — re-wording the warning once made
 *     a correctly patched env report STALE.
 */

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

/*
 * THE TWO RETAKE-DOOR CHECKS STOOD HERE. `regenerateSentenceIndices` is deleted
 * (docs/LEGACY-REMOVAL.md) — a retake is a Crucible `reroll` job now
 * (`electron/crucible/reroll.ts`), which has no local spawn and therefore no
 * engine routing of its own to get wrong. The engine refusal they checked still
 * exists and is still checked, one door along, in this section's other cases.
 */

/*
 * TWO `pushVoiceArgs` CHECKS STOOD HERE AND THE FUNCTION IS DELETED.
 *
 * They pinned that an Orpheus render with NO voice was REFUSED rather than
 * defaulted, and that no Higgs door ever called the Orpheus-shaped voice
 * builder. Orpheus is retired and cannot render at all now
 * (`shared/tts/engine-caps.ts`), which is a stronger form of the first, and
 * there is exactly one voice flag left — `HIGGS_VOICE_FLAG` — which is a
 * stronger form of the second.
 *
 * The reason the first mattered is worth keeping: with no `--fine_tuned`,
 * `compat/app.py` never set `fine_tuned`, the engine took DEFAULT_VOICE,
 * validated 'leah' as a legal stock voice, and rendered THE WHOLE BOOK in it
 * with a log line and exit 0. A silent wrong-voice render, not a crash.
 */

check('the CLI runs higgs on EVERY door the app runs it on', () => {
  // The standing rule is that the CLI mirrors the app's code path (CLAUDE.md,
  // "CLI drives the app path"), so what is asserted here is an AGREEMENT between
  // two files and never a sentence in one of them.
  //
  // The STREAMING half of this check is deleted (Phase 16 step 8, 2026-09-15).
  // It compared the CLI's `--mode streaming` refusal against whether
  // `tts-api-server.handleSpeak` bound a Higgs voice, and neither side exists:
  // the speak relay is gone from BookForge and `--mode streaming` is gone from
  // the CLI with it. What is left is the RENDER door, where the agreement still
  // has two sides to compare.
  const cli = fs.readFileSync(path.join(REPO, 'cli', 'bookforge-tts.py'), 'utf-8');
  assert.match(cli, /args\.engine in \("orpheus", "higgs"\)/,
    'the CLI still refuses --engine higgs');
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
  const clip = m.voice.clips[0];
  // No userData at all: refused by name, never guessed — the darwin checkpoint rule.
  assert.throws(() => higgs.higgsReferenceClipPath(m, clip), /userData/,
    'a bare clip name was resolved with no userData directory');
  // userData given, clip not staged there: offered disabled, naming the folder to copy into.
  const missing = higgs.higgsVoiceUnavailableReason(m, ZS_USER_DATA);
  assert.ok(missing, 'a missing clip was offered as available');
  assert.match(missing, /thirdreich\.wav/);
  assert.match(missing, /runtime\/higgs-models\/refs/, 'the refusal does not say where the clip goes');
  // Staged: the clip is THIS MACHINE's absolute path.
  fs.mkdirSync(ZS_REFS, { recursive: true });
  for (const v of higgs.listHiggsModels().filter((x) => x.kind === 'clips')) {
    fs.writeFileSync(path.join(ZS_REFS, v.voice.clips[0].path), '');
  }
  assert.strictEqual(higgs.higgsVoiceUnavailableReason(m, ZS_USER_DATA), null);
  assert.strictEqual(higgs.higgsReferenceClipPath(m, clip, ZS_USER_DATA), path.join(ZS_REFS, 'thirdreich.wav'));
});

check('a relative clip with a directory in it, or an empty path, is REFUSED as malformed', () => {
  for (const bad of ['sub/a.wav', '../a.wav', '', '  ']) {
    const m = probeVoice({
      kind: 'clips',
      voice: { clips: [{ path: bad, transcript: 'a line', seconds: 12 }] },
    });
    assert.ok(higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA),
      'clip path ' + JSON.stringify(bad) + ' was accepted by the picker');
    assert.match(higgs.higgsVoiceUnavailableReason(m, PICKER_USER_DATA), /bare file name|no path/,
      'clip path ' + JSON.stringify(bad) + ' was refused for the wrong reason');
  }
  // An ABSOLUTE path is host-native and needs no userData — the other spelling.
  const abs = path.join(ZS_REFS, 'thirdreich.wav');
  const m = probeVoice({
    kind: 'clips',
    voice: { clips: [{ path: abs, transcript: 'a line', seconds: 12 }] },
    backends: { served: { maxChars: 600, maxCharsSource: 'catalog', referenceSecondsCap: 30, allowedControls: [] } },
  });
  assert.strictEqual(higgs.higgsReferenceClipPath(m, m.voice.clips[0]), abs);
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
  // voice.checkpoint path. THE DOWNLOADER IS GONE (docs/LEGACY-REMOVAL.md): it
  // pulled ~8.5 GB onto THIS machine's disk, and a voice is pulled on the server
  // that will speak it (`crucible voices pull <id>`). What the catalog must still
  // do is NAME the source, and name it well enough to be refused when malformed —
  // which is the whole of what is checked here now.
  const ds = higgs.listHiggsModels().find((m) => m.id === 'deathstalker');
  assert.deepStrictEqual(ds.source, { type: 'hf', ref: 'owenmorgan/deathstalker-higgs-v3' });
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

/*
 * A CHECK STOOD HERE THAT DROVE `higgsChunkGapEnv`, which lived in
 * `higgs-spawn.ts` and is deleted (docs/LEGACY-REMOVAL.md).
 *
 * It pinned that a voice's `chunkGap.injectS` reached the PREP door and ONLY the
 * prep door — the other doors load a model or read a file prep already wrote, so
 * setting it there would imply it did something. The fact behind it survives in
 * the catalog and is recorded in docs/LEGACY-REMOVAL.md: Higgs is `pads=false`,
 * so every chunk join IS the model's own trailing silence plus whatever the
 * assembler inserts; `text/prep.py` stamps the inject into gaps.json at prep from
 * `text.gaps.classify_gap`, whose hardcoded 0.6 s floor `NARRATOR_SENTENCE_GAP`
 * overrode. Before the field existed that 0.6 s reached EVERY Higgs voice
 * regardless of how that narrator pauses (2026-09-11).
 *
 * The catalog half — that a malformed `chunkGap` is REFUSED, and that an inject
 * stated as the TARGET rather than net of the model's tail is refused by name —
 * is still checked below, and that is the half this repo still owns.
 */

check('a chunkGap whose inject is the TARGET, not net of the tail, is refused', () => {
  // THE ONE MISTAKE THIS FIELD INVITES. A join is (modelSelfTailS + injectS), so injectS must
  // already have the tail taken out of it. Declaring the target join as the inject lands every
  // join long by the tail — thirdreich shipped 0.24 s long on every join that way. The validator checks the three numbers add up.
  const wrong = { injectS: 0.84, targetJoinS: 0.84, modelSelfTailS: 0.22, rule: 'match-reader',
    method: 'm', source: 's', measuredOn: '2026-09-11' };
  const m = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1100, maxCharsSource: 'length-sweep' } }, chunkGap: wrong,
  });
  let threw = null;
  try { onArm('wsl', () => resolving(m)); } catch (e) { threw = e; }
  assert.ok(threw, 'an inject that ignores the model tail was accepted');
  assert.match(threw.message, /NET of the tail/);
  // And the well-formed one passes, so the check is not simply rejecting every gap.
  const right = probeVoice({
    kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { maxChars: 1100, maxCharsSource: 'length-sweep' } },
    chunkGap: { injectS: 0.62, targetJoinS: 0.84, modelSelfTailS: 0.22, rule: 'match-reader',
      method: 'm', source: 's', measuredOn: '2026-09-11' },
  });
  onArm('wsl', () => resolving(right));
});
check('a block\'s own sampling is its arm\'s, and a pace on a block is refused', () => {
  const sampled = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged', darwin: 'runtime/higgs-models/x' } },
    backends: { served: { sampling: { temperature: 1, topP: 0.95, topK: 50 }, _samplingNote: 'REASON: fixture' },
                mlx: { sampling: { temperature: 0.7, topP: 0.95, topK: 50 }, _samplingNote: 'REASON: fixture' } } });
  assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(sampled, 'darwin').sampling, { temperature: 0.7, topP: 0.95, topK: 50 });
  assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(sampled, 'wsl').sampling, { temperature: 1, topP: 0.95, topK: 50 });
  // A pace on a backend block is refused by name, not read: the pace is the server's.
  const perArm = probeVoice({ kind: 'checkpoint', voice: { checkpoint: { wsl: '/home/x/merged' } },
    backends: { served: { pace: { median: 16 } } } });
  assert.match(higgs.higgsVoiceUnavailableReason(perArm, PICKER_USER_DATA) || '', /A voice's pace is the server's/);
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
  // The base model is renderable but never OFFERED (Owen, 2026-09-25: "the user will never
  // render something from the base model"): the dropdown leaves it out, and the render
  // path still resolves it.
  assert.strictEqual(higgs.higgsNarrationVoices(PICKER_USER_DATA).find((v) => v.value === 'default'), undefined,
    'the base model is still offered in the narration dropdown');
  assert.ok(higgs.SELECTABLE_VOICE_KINDS.has('default'), 'a render naming the base model would now be refused');
});

// THE CROSS-CHECK AGAINST narrator`s load_voices LEFT IN STEP 8 (2026-11-05) with `python/narrator/engine`:
// its six checks ran the deleted `engine/higgs/config.py`. Crucible owns Higgs serve and its voice loader.

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
    checkpointDir: '/home/<user>/higgs_v3_merged/ds_v8_1200_test',
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
  assert.deepStrictEqual(m.voice.checkpoint, { wsl: '/home/<user>/higgs_v3_merged/ds_v8_1200_test' });
  // The CATALOG is untouched: a later resolve must not see the override.
  assert.deepStrictEqual(higgs.resolveHiggsModel('deathstalker').voice.checkpoint, {
    wsl: '/home/telltale/higgs_v3_merged/ds_v8_rvcbed1_3658_prod',
    darwin: 'runtime/higgs-models/ds_v8_rvcbed1_3658_prod',
  });
});

check("a base of kind 'default' takes a checkpoint — base weights are a legal starting point", () => {
  // The zero-shot 600 placeholder is what such a run is judged against, and it
  // is stated rather than inherited silently: `maxCharsSource` says 'placeholder'.
  const m = higgs.higgsModelForRender('default', {
    checkpointDir: '/home/<user>/higgs_v3_merged/fresh_merge',
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
    checkpointDir: '/home/<user>/higgs_v3_merged/ds_v8_1200_test',
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
  check('an ABSOLUTE Mac directory travels verbatim', () => {
    const m = higgs.higgsModelForRender('deathstalker', {
      checkpointDir: OVERRIDE_DIR,
      note: 'keeper: a merged checkpoint on this Mac',
    });
    // `higgsCheckpointDirFor` must NOT join userData onto it: that would name a
    // directory inside Application Support that has never held these weights.
    assert.strictEqual(higgs.higgsCheckpointDirFor(m, 'darwin', MAC_USER_DATA), OVERRIDE_DIR);
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
      voice: { checkpoint: { darwin: '/Users/<user>/merged/ds' } },
      backends: { mlx: { maxChars: 800, maxCharsSource: 'catalog' } },
    });
    assert.throws(() => higgs.higgsCheckpointDirFor(m, 'darwin', MAC_USER_DATA), /is absolute/);
  });

  check('an override CAP or BAND is refused by name: the cap and band are the Crucible server\'s', () => {
    // Retired 2026-09-28 (Owen: "crucible is now the single source of truth"). A voice's cap and
    // band are its crucible-voice.toml's, on GET /v1/voices, and a render packs to them whole; an
    // override's own had not reached a render since 2026-09-15. One refusal, at the parser.
    const { parseHiggsOverride } = require(path.join(REPO, 'cli', 'higgs-override.js'));
    for (const field of ['maxChars', 'safeMinChars', 'safeMaxChars']) {
      assert.throws(() => parseHiggsOverride(JSON.stringify({ [field]: 700, note: 'keeper' })),
        new RegExp(`${field} is retired.*crucible-voice\.toml`));
    }
    // And what an override still carries parses unchanged.
    assert.deepStrictEqual(parseHiggsOverride(JSON.stringify({ checkpointDir: '/x', note: 'keeper' })),
      { checkpointDir: '/x', note: 'keeper' });
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
      wsl: '/home/telltale/higgs_v3_merged/ds_v8_rvcbed1_3658_prod',
      darwin: 'runtime/higgs-models/ds_v8_rvcbed1_3658_prod',
    });
    assert.deepStrictEqual(higgs.higgsVoiceCapsForModel(m).sampling,
      { temperature: 0.8, topP: 0.95, topK: 20 });
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
  // SIX since the prepare row learned to PARK (2026-09-19). It was five when
  // the local renderer was deleted (docs/LEGACY-REMOVAL.md) and seven before
  // that: the four LOCAL render doors are gone, and what is left is prep, the
  // two in the Crucible seam (`startCrucibleGeneration`) — the voice-id mapping
  // to the server's voice, and the refusal sentence that names the BookForge
  // voice it could not map — `venueBandForPrep`, which asks the VENUE for that
  // voice's cap and band before prep packs the book
  // (`electron/crucible/voice-band.ts`), and now `bandThisPrepPacksTo`, which
  // names the voice in the sentence a PARKED prepare row shows. That sentence
  // has to name the voice the render will actually use — a park that named the
  // catalog voice while the run carried an override would send its reader
  // looking at the wrong machine's voice list.
  //
  // The COUNT is not the point; the SHARING is. Every one of them reads the same
  // door, because narrator's reaction to a voice its document does not name is
  // not a crash — the lookup misses and a whole book renders in the base model's
  // own speaker. A band fetched for a voice the render does not use would pack
  // the book to the wrong certificate, which is the same failure one layer up.
  const sites = bridgeSrc.match(/higgsModelForJob\(/g) || [];
  // Five since the flip (step 7): buildJobSpawn's left with the Python prep spawn.
  assert.strictEqual(sites.length, 5,
    `expected 5 higgsModelForJob call sites in the bridge, saw ${sites.length}`);
  /*
   * LISTEN STAYS CATALOG-ONLY, and the check moved with the code.
   *
   * It used to read `orpheus-worker-pool.ts` and require that the resident pool
   * called the catalog-only door and NEVER `higgsModelForJob` — because a book's
   * per-run override must not reach an engine every tab shares, which would load
   * an uncertified checkpoint for a listener who asked for nothing. The pool is
   * deleted (docs/LEGACY-REMOVAL.md); Listen is a Crucible streaming session, and
   * the same property is asserted of the module that replaced it.
   */
  const reader = fs.readFileSync(path.join(REPO, 'electron', 'reader-stream-bridge.ts'), 'utf-8');
  assert.strictEqual(/higgsModelForJob/.test(reader), false,
    'the Listen path reads a book render override — Listen is catalog-only');
  const listen = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'stream.ts'), 'utf-8');
  assert.strictEqual(/higgsModelForJob/.test(listen), false,
    'the Crucible streaming door reads a book render override — Listen is catalog-only');
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
