#!/usr/bin/env node
/**
 * WHICH STREAMING ENGINES A MACHINE SAYS IT HAS, and whether it can back that up.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-stream-engine-availability.js
 *
 * ── Why this is a keeper ────────────────────────────────────────────────────
 *
 * `getAvailableEngines()` is read by three surfaces that all treat it as a
 * promise: the Settings streaming-engine picker, the TTS API's `hello` and
 * `config` payloads, and (through those) the browser extension. An engine listed
 * `available: true` that cannot start is not a small error — the user picks it,
 * every sentence fails against an environment that is not there, and the page that
 * would repair it is the one that offered the choice.
 *
 * This session has already produced that bug twice by accident: a probe that
 * resolved differently from the launcher, and an orphan door whose accidental
 * guard I removed. So the rule is asserted rather than trusted.
 *
 * ── What that rule became, 2026-09-15 ──────────────────────────────────────
 *
 * It used to be AVAILABILITY AND THE LOCAL SPAWN MUST AGREE, driven per platform
 * because the answer differed per platform. The local narrator spawn is DELETED
 * (docs/LEGACY-REMOVAL.md): Listen is a Crucible streaming session, so "can this
 * machine start vLLM-Omni" is not this app's question any more — the server's own
 * capability and its `409` answer it, in its own words, when a session is opened.
 * Re-asking here would be a second opinion about somebody else's card, and it
 * would refuse a perfectly good Mac render because THIS box has no WSL.
 *
 * So the rule is now the narrower, true one: **availability claims exactly one
 * thing, and it is a fact about this machine's own catalog** — whether a Higgs
 * voice is installed. The keeper pins that it makes no platform, WSL or
 * environment claim at all, because a claim about a machine that is not doing the
 * work is the same broken promise in a new costume.
 *
 * ── And Orpheus is RETIRED, not dropped ────────────────────────────────────
 *
 * `tts-engine.json` outlives the code that wrote it, so a saved `"orpheus"` must
 * still PARSE, must still have a name to show, and must migrate rather than
 * throw — while being impossible to choose. Same treatment narration gave it in
 * `shared/tts/engine-caps.ts`.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'streaming-engine.js'))) {
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
function fail(name, err) {
  failures++;
  console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
}

/**
 * A SYNCHRONOUS row. Handing this an `async` body is a mistake it now refuses
 * rather than absorbs: the rejection would arrive after the try/catch had already
 * printed `ok`, so the row would pass no matter what the code under it did. Use
 * `checkAsync` for anything that returns a promise.
 */
function check(name, fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    fail(name, err);
    return;
  }
  if (out && typeof out.then === 'function') {
    fail(name, new Error('check() is synchronous and this row returned a promise — use checkAsync'));
    return;
  }
  console.log(`  ok    ${name}`);
}

/** Rows whose body returns a promise. Awaited before the exit code is decided. */
const pending = [];
function checkAsync(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`  ok    ${name}`),
    (err) => fail(name, err),
  ));
}

const stream = require(path.join(DIST, 'streaming-engine.js'));
const higgsModels = require(path.join(DIST, 'higgs-models.js'));
const streamJs = fs.readFileSync(path.join(DIST, 'streaming-engine.js'), 'utf-8');
const streamTs = fs.readFileSync(path.join(REPO, 'electron', 'streaming-engine.ts'), 'utf-8');

function stub(mod, name, fn) {
  const d = Object.getOwnPropertyDescriptor(mod, name);
  const prev = mod[name];
  if (d && d.get) Object.defineProperty(mod, name, { value: fn, configurable: true, enumerable: true });
  else mod[name] = fn;
  return () => {
    if (d && d.get) Object.defineProperty(mod, name, d);
    else mod[name] = prev;
  };
}

/**
 * Run `fn` with the machine described by `opts`, then put everything back.
 *
 * The WSL toggles used to be stubbed here too. They are not read any more — the
 * engine runs on a Crucible server — and stubbing a function nobody calls is a
 * fixture that quietly stops testing anything, so they are gone rather than
 * carried.
 */
function onPlatform(opts, fn) {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: opts.platform, configurable: true });
  const undo = [
    stub(higgsModels, 'listRenderableHiggsModels', () => (opts.higgsVoices ?? ['default']).map((id) => ({ id }))),
  ];
  try {
    return fn();
  } finally {
    undo.reverse().forEach((u) => u());
    Object.defineProperty(process, 'platform', platformDesc);
  }
}

const higgsOn = (platform, extra) =>
  onPlatform({ platform, ...extra }, () => stream.getAvailableEngines().find((e) => e.id === 'higgs'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('ONE engine is listed — availability is a field, not absence');
// ─────────────────────────────────────────────────────────────────────────────
check('the list names higgs, and only higgs', () => {
  const ids = stream.getAvailableEngines().map((e) => e.id);
  assert.deepStrictEqual(ids, ['higgs'],
    'a row for an engine nothing can run is a promise the build cannot keep — a '
    + 'retired engine is nameable through streamEngineLabel instead');
});
check('every row carries a human name, and an unavailable one carries a reason', () => {
  for (const e of stream.getAvailableEngines()) {
    assert.ok(e.name, `${e.id} has no display name`);
    if (!e.available) {
      assert.ok(e.reason && e.reason.length > 20,
        `${e.id} is unavailable with no usable reason: ${JSON.stringify(e.reason)}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('Higgs availability claims ONE thing: a voice is installed');
// ─────────────────────────────────────────────────────────────────────────────
check('no voice installed → refused, whatever the platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const h = higgsOn(platform, { higgsVoices: [] });
    assert.strictEqual(h.available, false, `${platform} offered Higgs with no voice`);
    // A voice whose artifact is missing renders in the model's own speaker, which
    // measures at 12% of the narrator's ECAPA ceiling — a different person.
    assert.match(h.reason, /voice/i);
  }
});

check('a voice installed → available, on EVERY platform', () => {
  // The platform rows this replaces refused Higgs on a Mac for want of a local
  // vLLM-Omni build, and on Windows for want of the "WSL2 for Higgs" toggle. Both
  // were questions about the LOCAL spawn, which is deleted: the engine runs on a
  // Crucible server, which may be the Mac, the PC, or a box neither of them has
  // met. Refusing here on THIS machine's platform would refuse a render that was
  // never going to happen here.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const h = higgsOn(platform, {});
    assert.strictEqual(h.available, true, `${platform}: ${h.reason}`);
  }
});

check('availability makes no platform, WSL or environment claim at all', () => {
  // A source read, deliberately: the rows above prove the ANSWER is the same on
  // three platforms, but that is also what a function with a stale claim and a
  // lucky fixture looks like. This pins the absence of the question.
  const body = streamTs.match(/function higgsAvailability\(\): EngineInfo \{[\s\S]*?\n\}\n/);
  assert.ok(body, 'higgsAvailability is gone or renamed');
  for (const claim of [
    'shouldUseWsl2ForHiggs', 'shouldUseWsl2ForOrpheus',
    'narratorNativePython', 'higgsMlxBackendPresent', 'process.platform',
  ]) {
    assert.ok(!body[0].includes(claim),
      `higgsAvailability asks about ${claim} again — that is the local spawn's `
      + 'question, and the local spawn is deleted. The server answers for itself.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('Orpheus is RETIRED — nameable, never selectable');
// ─────────────────────────────────────────────────────────────────────────────
check('a retired id still has something true to show', () => {
  assert.strictEqual(stream.streamEngineLabel('orpheus'), 'Orpheus (retired)');
  assert.strictEqual(stream.streamEngineLabel('xtts'), 'XTTS (retired)');
  assert.strictEqual(stream.streamEngineLabel('higgs'), 'Higgs');
});

check('each retired id carries a DATE and a reason, not just a label', () => {
  // `RETIRED_STREAM_ENGINES` is module-private (nothing outside needs the record;
  // `streamEngineLabel` is the door), so the record itself is read from source.
  const map = streamTs.match(/const RETIRED_STREAM_ENGINES = new Map[\s\S]*?\n\]\);/);
  assert.ok(map, 'the retirement record is gone or renamed');
  for (const id of ['orpheus', 'xtts']) {
    assert.ok(map[0].includes(`['${id}', {`), `${id} is no longer nameable at all`);
  }
  assert.match(map[0], /since: '2026-09-15'/, 'Orpheus has no retirement date');
  assert.match(map[0], /docs\/LEGACY-REMOVAL\.md/,
    'the Orpheus retirement does not say where the engine went');
});

checkAsync('selecting a retired engine is refused BY NAME, never quietly honoured', () => stream
  .setSelectedEngineName('orpheus')
  .then(
    () => { throw new Error('a retired engine was accepted as a selection'); },
    (err) => {
      assert.match(err.message, /retired/i, `refused, but not as retired: ${err.message}`);
      assert.match(err.message, /This build streams: higgs/,
        'the refusal does not say what this build does stream');
    },
  ));

check('a saved "orpheus" MIGRATES to higgs rather than throwing', () => {
  /*
   * A machine that listened on Orpheus last week has `"engine": "orpheus"` on
   * disk. Throwing would leave Listen broken forever on exactly that machine —
   * including from the Settings page that would repair it — so the saved value is
   * migrated, loudly, and the file rewritten so the stale preference stops being
   * re-read. An id nobody in this build ever wrote is still refused by name.
   *
   * The shipped body is lifted with its free variables rebound, the same way
   * `setSelectedEngineName` is below: `selected` is a module-level cache, so
   * calling the real one would answer from whatever an earlier row left there.
   */
  const src = streamJs.match(/function getSelectedEngineName\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(src, 'getSelectedEngineName is not in the compiled selector — did it move?');
  const lift = (persisted) => {
    const wrote = [];
    const fn = eval(
      `(function (isEngineName, RETIRED_STREAM_ENGINES, STREAM_ENGINE_NAMES,
                  readPersisted, writePersisted) {
         let selected = null;
         ${src[0]}
         return getSelectedEngineName;
       })`,
    )(
      (v) => v === 'higgs',
      new Map([['orpheus', { label: 'Orpheus', since: '2026-09-15', reason: 'gone.' }]]),
      ['higgs'],
      () => persisted,
      (cfg) => wrote.push(cfg),
    );
    return { fn, wrote };
  };

  const orpheus = lift({ engine: 'orpheus', voices: { orpheus: 'deathstalker' } });
  assert.strictEqual(orpheus.fn(), 'higgs', 'a saved orpheus did not migrate');
  assert.deepStrictEqual(orpheus.wrote.map((c) => c.engine), ['higgs'],
    'the stale preference was left on disk to be re-read every launch');
  assert.deepStrictEqual(orpheus.wrote[0].voices, { orpheus: 'deathstalker' },
    'the migration threw away the rest of the record');

  assert.strictEqual(lift({}).fn(), 'higgs', 'a fresh install does not land on higgs');
  assert.throws(() => lift({ engine: 'wurlitzer' }).fn(), /never had/,
    'an id this build never wrote is a bug or a hand-edited file, and must not be '
    + 'quietly read as higgs');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('nothing here promises a LOCAL spawn any more');
// ─────────────────────────────────────────────────────────────────────────────
//
// THE RULE THIS FILE WAS BUILT FOR, and what became of it. Twice in one session an
// availability answer and a `buildNarratorSpawn` answer disagreed, and both times
// the symptom was a promise kept until the moment it mattered. Those rows drove
// `buildNarratorSpawn` per platform and asserted the two agreed.
//
// They are gone because the promise is gone: `getActiveEngine()` is a Crucible
// streaming session and never `buildNarratorSpawn`, so availability no longer makes
// a claim a local spawn could contradict. Asserting agreement with a launcher
// nothing calls would be a green row about a path with no users — the most
// expensive kind of keeper, because it reads like coverage.
//
// What replaces it is the pair above: availability asks ONE thing (a voice is
// installed) and is pinned to ask nothing else, and the selector is pinned never to
// offer an id the pool cannot name. The agreement that matters now is between this
// app and the SERVER, and it is pinned where the server can be faked —
// `tools/test-crucible-stream.js`.
check('the Listen facade reaches no local pool at all', () => {
  const venue = streamTs.match(/const VENUE_ROUTED[\s\S]*?\}\);/);
  assert.ok(venue, 'the venue-routed facade is gone or renamed');
  assert.ok(!/\blocal:/.test(venue[0]),
    'the facade has a local backend again — Listen is a Crucible session, and a '
    + 'second backend here is the legacy switch growing back');
  assert.ok(!/legacySwitchIsOn/.test(streamTs),
    'the legacy local-render switch is being read again');
});

check('every id the selector can choose is one the pool knows, and the rest are retired', () => {
  /*
   * THEY USED TO BE COMPARED FOR EQUALITY, and are now compared for CONTAINMENT.
   *
   * `orpheus-worker-pool.ts` declares its own `StreamEngineId` rather than
   * importing `StreamEngineName` (the import would be a cycle), and two spellings
   * of one union is a drift waiting to happen. But they are no longer the same
   * question: the pool is the HELD RECORD of the local narrator spawn — kept, not
   * deleted, until its measured tuning has been audited against Crucible's own
   * environment — so it still names `orpheus`, while the selector offers `higgs`.
   *
   * Two things would still be bugs, and both are asserted: a SELECTABLE id the
   * pool has never heard of (nothing could serve it), and an id the pool names
   * that the selector neither offers nor RETIRES (a saved value with nothing true
   * to display).
   */
  const poolSrc = fs.readFileSync(path.join(REPO, 'electron', 'orpheus-worker-pool.ts'), 'utf-8');
  const pool = poolSrc.match(/export type StreamEngineId = ([^;]+);/);
  const sel = streamTs.match(/export type StreamEngineName = ([^;]+);/);
  assert.ok(pool && sel, 'one of the two unions is gone or renamed');
  const ids = (t) => t.split('|').map((x) => x.trim().replace(/'/g, ''));
  const poolIds = ids(pool[1]);
  const selIds = ids(sel[1]);
  for (const id of selIds) {
    assert.ok(poolIds.includes(id),
      `the selector offers ${id} and the pool streams ${pool[1]} — nothing could serve it`);
  }
  for (const id of poolIds.filter((x) => !selIds.includes(x))) {
    assert.match(stream.streamEngineLabel(id), /\(retired\)$/,
      `the pool still names ${id} and the selector neither offers nor retires it — `
      + 'it would be a saved value with nothing true to display');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('selection REFUSES rather than falling back');
// ─────────────────────────────────────────────────────────────────────────────
// `setSelectedEngineName` calls `getAvailableEngines` INTERNALLY, so stubbing the
// module's export changes nothing about what it sees. It is lifted here with its
// free variables rebound, the same way the other keepers exercise module-private
// code: what runs below is the shipped body, driven against a machine whose
// availability list is missing an engine.
const selectSrc = streamJs.match(/async function setSelectedEngineName\(name\) \{[\s\S]*?\n}\n/);
/*
 * Driven with a SECOND, INVENTED id (`shimmer`) beside the real one. With a
 * single selectable engine there is nothing to omit from an availability list and
 * nothing to switch away from, so the two rows below would both be vacuous — and a
 * vacuous row is worse than no row, because it reads as coverage.
 */
function liftedSelect(availability) {
  assert.ok(selectSrc, 'setSelectedEngineName is not in the compiled selector — did it move?');
  return eval(
    `(function (isEngineName, RETIRED_STREAM_ENGINES, STREAM_ENGINE_NAMES,
                getSelectedEngineName, getAvailableEngines,
                getActiveEngine, readPersisted, writePersisted, emitStreamConfigChanged) {
       let selected = null;   // the module-level binding the real body assigns to
       ${selectSrc[0]}
       return setSelectedEngineName;
     })`,
  )(
    (v) => v === 'higgs' || v === 'shimmer',
    new Map(),
    ['higgs', 'shimmer'],
    () => 'shimmer',
    () => availability,
    () => ({ endSession: async () => {} }),
    () => ({}),
    () => {},
    () => {},
  );
}

checkAsync('an engine missing from getAvailableEngines() cannot be selected', () => {
  // `if (info && !info.available)` read "not in the availability list ⇒ allow it",
  // so the one mistake the check exists to catch — a selectable engine forgotten in
  // `getAvailableEngines()` — was the case it waved through. The two lists are
  // hand-maintained in one file; nothing but this makes them agree.
  return liftedSelect([{ id: 'shimmer', name: 'Shimmer', available: true }])('higgs').then(
    () => { throw new Error('selecting an engine with no availability row was accepted'); },
    (err) => {
      assert.match(err.message, /not in getAvailableEngines/i,
        `refused, but not for the right reason: ${err.message}`);
    },
  );
});

checkAsync('an engine that IS listed and available is still selectable', () => {
  // The refusal above must not be "refuse everything". This is also the row that
  // would have caught `isEngineName` returning `v === 'orpheus'` while every other
  // surface offered Higgs.
  return liftedSelect([
    { id: 'shimmer', name: 'Shimmer', available: true },
    { id: 'higgs', name: 'Higgs', available: true },
  ])('higgs');
});

checkAsync('every listed engine is a NAME the selector knows', () => {
  // The REAL `setSelectedEngineName`, not the lifted one — the lifted copy is given
  // its own `isEngineName` and so is blind to this.
  //
  // `isEngineName` was a hand-written second copy of the engine list, and it went
  // stale the moment Higgs was added: Higgs reached the union,
  // `getAvailableEngines()`, the Settings picker and the extension's engine menu,
  // while this one function still read `v === 'orpheus'`. Selecting it failed with
  // "Unknown streaming engine: higgs. This build streams: orpheus, higgs." — a
  // message that contradicts itself in its own second clause.
  //
  // Host-independent: on a machine where an engine is unavailable the refusal names
  // the machine, not the name. Either is fine here; "unknown" is not.
  return Promise.all(stream.getAvailableEngines().map((e) => stream
    .setSelectedEngineName(e.id)
    .then(
      () => {},
      (err) => {
        assert.doesNotMatch(err.message, /Unknown streaming engine/,
          `${e.id} is offered by getAvailableEngines() and rejected by name: ${err.message}`);
      },
    )));
});

check('the pool refuses to name an engine when no probe is registered', () => {
  // `serveEngineProbe` used to default to `() => 'orpheus'`. `streaming-engine.ts`
  // registers it at module load, so the default could only ever be reached when the
  // registration was dropped or reordered — and it answered that by rendering a Higgs
  // session in Orpheus, silently, with the app reporting Higgs throughout.
  const poolMod = require(path.join(DIST, 'orpheus-worker-pool.js'));
  const src = fs.readFileSync(path.join(REPO, 'electron', 'orpheus-worker-pool.ts'), 'utf-8');
  assert.match(src, /let serveEngineProbe: \(\(\) => StreamEngineId\) \| null = null;/,
    'the serve-engine probe has a default again — an unregistered probe must fail, not guess');
  assert.ok(typeof poolMod.setServeEngineProbe === 'function',
    'setServeEngineProbe is gone, so nothing can register the engine the pool spawns for');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('per-engine settings are applied to the engine being switched TO');
// ─────────────────────────────────────────────────────────────────────────────
check('config.set and engine.restart apply the worker count AFTER the switch', () => {
  // `applyClientWorkerCount` reads `getActiveEngine()`. Called before the switch it
  // wrote the user's count onto the pool they were leaving, which the switch then
  // discarded — a silently ignored setting, not a visible failure. Harmless only
  // while ENGINES.orpheus and ENGINES.higgs are the same object, which is exactly
  // the kind of "currently fine" that stops being fine without warning.
  //
  // Asserted on ORDER in the compiled output, because the two handlers are private
  // methods on a server class that needs a live socket to drive.
  const js = fs.readFileSync(path.join(DIST, 'tts-api-server.js'), 'utf-8');
  for (const handler of ['handleConfigSet', 'handleRestart']) {
    const body = js.match(new RegExp(`async ${handler}\\(ws, msg\\) \\{[\\s\\S]*?\\n    \\}\\n`));
    assert.ok(body, `${handler} is not in the compiled server — did it move?`);
    const apply = body[0].indexOf('applyClientWorkerCount');
    const switchAt = body[0].indexOf('setStreamConfig');
    assert.ok(apply !== -1, `${handler} no longer applies the client worker count`);
    assert.ok(switchAt !== -1, `${handler} no longer switches engine`);
    assert.ok(apply > switchAt,
      `${handler} applies the worker count to the OUTGOING engine (at ${apply}, `
      + `before the switch at ${switchAt})`);
  }
});

check('engine.restart captures residency BEFORE the switch, on purpose', () => {
  // The opposite order from the worker count, and deliberately so. "Is a client
  // holding this server resident" is a property of the session, not of whichever
  // pool is loaded. Read after the switch it would ask a pool that has not been
  // started, get false, and drop residency on every engine change.
  const js = fs.readFileSync(path.join(DIST, 'tts-api-server.js'), 'utf-8');
  const body = js.match(/async handleRestart\(ws, msg\) \{[\s\S]*?\n    \}\n/);
  assert.ok(body, 'handleRestart is not in the compiled server — did it move?');
  const was = body[0].indexOf('isServiceMode');
  const switchAt = body[0].indexOf('setStreamConfig');
  assert.ok(was !== -1 && switchAt !== -1, 'handleRestart no longer does both things');
  assert.ok(was < switchAt,
    'residency is now read from the engine being switched INTO, which has not been '
    + 'started — every engine change would silently stop the server being resident');
});

// The async rows settle here, before anything decides the exit code. `process.exit`
// below would otherwise run with them still in flight and report a clean suite.
Promise.all(pending).then(() => {
  console.log(failures === 0 ? '\nAll streaming-engine availability checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
});
